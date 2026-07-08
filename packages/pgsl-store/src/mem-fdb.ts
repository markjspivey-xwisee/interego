/**
 * In-memory transactional FoundationDB fake — enough of FDB's semantics to
 * unit-test the PGSL store logic locally with no native client and no Docker:
 *   - ordered byte keys (bytewise), range reads/clears;
 *   - buffered reads/writes that see the transaction's own pending writes;
 *   - atomic commit (all-or-nothing) with optimistic conflict detection on the
 *     transaction's read set, so `read-then-set-if-absent` convergence and
 *     retry-on-conflict can be exercised.
 *
 * The backing map is instance state, so constructing a fresh store over the SAME
 * InMemoryFdb models a process restart (data persists; the store must rehydrate
 * bodies from it). Real durability across a machine restart is FoundationDB's
 * guarantee, verified separately by the CI integration suite on the real binding.
 */

import type { FdbLike, FdbTxn, Key, KeyValue, Value } from './fdb-like.js';

function toHex(k: Key): string {
  let s = '';
  for (let i = 0; i < k.length; i++) s += k[i]!.toString(16).padStart(2, '0');
  return s;
}

export class MemFdbConflict extends Error {
  constructor() {
    super('mem-fdb: transaction conflict (read key changed before commit)');
    this.name = 'MemFdbConflict';
  }
}

export class InMemoryFdb implements FdbLike {
  /** hex(key) -> value. */
  private readonly data = new Map<string, Value>();
  /** hex(key) -> monotonically-increasing write version, for conflict detection. */
  private readonly versions = new Map<string, number>();
  private clock = 0;
  private closed = false;
  /** Injectable barrier that runs after `fn` but before commit — lets a test
   *  deterministically interleave a second writer to exercise conflict retry. */
  onBeforeCommit?: () => Promise<void>;

  async transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('InMemoryFdb is closed');
    const maxAttempts = 32;
    for (let attempt = 1; ; attempt++) {
      const writes = new Map<string, Value | null>(); // null = clear
      const readVersions = new Map<string, number>(); // conflict range

      const committedRange = (begin: Key, end: Key): KeyValue[] => {
        const b = toHex(begin);
        const e = toHex(end);
        const out: KeyValue[] = [];
        for (const [h, v] of this.data) {
          if (h >= b && h < e) out.push({ key: hexToBytes(h), value: v });
        }
        return out;
      };

      const txn: FdbTxn = {
        get: async (key) => {
          const h = toHex(key);
          if (writes.has(h)) {
            const w = writes.get(h)!;
            return w === null ? undefined : w;
          }
          readVersions.set(h, this.versions.get(h) ?? 0);
          return this.data.get(h);
        },
        set: (key, value) => {
          writes.set(toHex(key), value);
        },
        clear: (key) => {
          writes.set(toHex(key), null);
        },
        clearRange: (begin, end) => {
          const b = toHex(begin);
          const e = toHex(end);
          for (const h of this.data.keys()) if (h >= b && h < e) writes.set(h, null);
          for (const h of writes.keys()) if (h >= b && h < e) writes.set(h, null);
        },
        getRange: async (begin, end) => {
          const b = toHex(begin);
          const e = toHex(end);
          const merged = new Map<string, Value | null>();
          for (const { key, value } of committedRange(begin, end)) merged.set(toHex(key), value);
          for (const [h, v] of writes) if (h >= b && h < e) merged.set(h, v);
          const rows: KeyValue[] = [];
          for (const [h, v] of merged) if (v !== null) rows.push({ key: hexToBytes(h), value: v });
          rows.sort((x, y) => (toHex(x.key) < toHex(y.key) ? -1 : toHex(x.key) > toHex(y.key) ? 1 : 0));
          return rows;
        },
      };

      const result = await fn(txn);
      if (this.onBeforeCommit) await this.onBeforeCommit();

      // Optimistic conflict check: any read key whose version advanced conflicts.
      let conflict = false;
      for (const [h, seen] of readVersions) {
        if ((this.versions.get(h) ?? 0) !== seen) {
          conflict = true;
          break;
        }
      }
      if (conflict) {
        if (attempt >= maxAttempts) throw new MemFdbConflict();
        continue; // retry fn from scratch
      }

      const commitVersion = ++this.clock;
      for (const [h, v] of writes) {
        if (v === null) this.data.delete(h);
        else this.data.set(h, v);
        this.versions.set(h, commitVersion);
      }
      return result;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Test helper: total live keys. */
  size(): number {
    return this.data.size;
  }
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
