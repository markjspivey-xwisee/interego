/**
 * Records the bridge keeps on its pod, sealed.
 *
 * ★ WHY. Two things were wrong with what the bridge held between requests.
 *
 * Some of it was held nowhere but the process. docs/operations/primary-state-rollout-hold.md
 * lists ten such stores: a trajectory an agent recorded, a probe's baseline, an evaluation's
 * decisions were each acknowledged to the caller and then lived in a Map until the next restart
 * erased them. Memory is a cache of what is kept; it is not where a record is kept.
 *
 * And some of what was written to the pod was written in the clear. The pod's resources are
 * readable by anyone who has the address, and two registries added on 2026-11-25 and 26 (which
 * person assigned which course to which agent; which signer brought which package) were plain
 * JSON there, as the personal launch links before them are. Found on 2026-11-26 by fetching them
 * with no credentials.
 *
 * So a record is written to the pod before it is acknowledged, and it is written sealed: an
 * encrypted envelope only the bridge's key opens, the mechanism the forwarding config and the
 * efficacy tally already use (src/forwarding-persist.ts, src/fragment-efficacy.ts).
 *
 * ★ WHAT THIS IS NOT. It is not the native commit path of docs/operations/native-learning-storage.md
 * (content-addressed PGSL holons, a conditional head commit, a receipt bound to the write). It is
 * the pod's ordinary resource store with the body sealed: one writer, last write wins, no revision
 * check. That is enough to survive a restart and not enough for two bridge processes; the header
 * of each class says what it does about that.
 *
 * ★ UNREADABLE IS NOT ABSENT. A resource that is there and cannot be opened (another key, a
 * damaged body, a pod that answered 500) is reported as that, and is never followed by a write:
 * writing over what could not be read would drop whatever it held.
 */
import {
  createEncryptedEnvelope, openEncryptedEnvelope, envelopeToJson, envelopeFromJson,
  type EncryptionKeyPair,
} from '@interego/core';
import { createHash } from 'node:crypto';

/** As much of fetch as these stores use. */
export type SealedFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** JSON sealed for keeping on a pod: readable only with `key`, which seals it to itself. */
export function sealJson(value: unknown, key: EncryptionKeyPair): string {
  return envelopeToJson(createEncryptedEnvelope(JSON.stringify(value), [key.publicKey], key));
}

/** What a sealed body holds, or `unreadable` when `key` did not seal it or it is not one. */
export function openSealed(sealed: string, key: EncryptionKeyPair): { ok: true; value: unknown } | { ok: false } {
  try {
    const envelope = envelopeFromJson(sealed);
    // Only a key this bridge wrapped to itself: an envelope someone else addressed to the bridge's
    // public key is not the bridge's own record.
    const own = envelope.wrappedKeys.filter(w => w.recipientPublicKey === key.publicKey && w.senderPublicKey === key.publicKey);
    if (own.length === 0) return { ok: false };
    const plain = openEncryptedEnvelope({ ...envelope, wrappedKeys: own }, key);
    return plain === null ? { ok: false } : { ok: true, value: JSON.parse(plain) };
  } catch { return { ok: false }; }
}

const makeContainer = (fetchFn: SealedFetch, container: string): Promise<unknown> =>
  fetchFn(container, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '' }).catch(() => undefined);

// ── A whole small registry in one sealed resource ───────────────────────────────────────────────

/** What a registry kept this way offers: the merge of a copy, its body, and whether it changed. */
export interface KeptRegistry {
  dirty: boolean;
  load(json: unknown): unknown;
  toJSON(): unknown;
}

export type SealedRead = 'loaded' | 'absent' | 'failed' | 'unconfigured';

/**
 * A registry small enough to rewrite whole, kept as one sealed resource.
 *
 * Each write reads the pod's copy first and merges it (`registry.load`), so what another start of
 * the bridge wrote is not dropped; a read that failed is not followed by a write. Writes run one at
 * a time.
 *
 * `legacyResource` is the same registry as it was first kept, in the clear. Until the pod has said
 * it is not there, every read looks for it, whether or not a sealed copy exists: what it holds is
 * merged in, the registry is marked changed so it is written sealed, and the clear copy is removed
 * after that write. Looking only when no sealed copy existed left a clear copy in place for good
 * if the process stopped between the sealed write and the removal, or the removal failed once
 * (Codex, in review of #1007). `settle()` does all of this without waiting for a change: a
 * registry nobody touches would otherwise stay in the clear until somebody did.
 */
export class SealedRegistryFile {
  private readAt = 0;
  private chain: Promise<boolean> = Promise.resolve(true);
  /** A clear copy was read and is still to be removed. */
  private legacySeen = false;
  /** The pod has answered that there is no clear copy. Only then is it no longer looked for. */
  private legacyGone = false;

  constructor(private readonly o: {
    resource: string; legacyResource?: string; key: EncryptionKeyPair | null; fetch: SealedFetch; registry: KeptRegistry;
    /** Removals not yet on the pod, and the call that says a written body covered them (see OwnAgentAssignments). */
    pending?: () => string[]; committed?: (covered: string[]) => void;
    staleMs?: number; now?: () => number;
  }) {}

  get configured(): boolean { return !!this.o.resource && !!this.o.key; }
  private now(): number { return (this.o.now ?? Date.now)(); }

  private async readOnce(): Promise<SealedRead> {
    if (!this.configured) return 'unconfigured';
    try {
      const r = await this.o.fetch(this.o.resource, { headers: { Accept: 'application/json' } });
      if (r.status === 404 || r.status === 410) return await this.readLegacy();
      if (!r.ok) return 'failed';
      const opened = openSealed(await r.text(), this.o.key!);
      if (!opened.ok) return 'failed';
      this.o.registry.load(opened.value);
      // A clear copy can outlive the sealed one's first write. The sealed copy is what counts, so a
      // clear one that cannot be read now does not fail this read; it is looked for again next time.
      await this.readLegacy();
      return 'loaded';
    } catch { return 'failed'; }
  }

  private async readLegacy(): Promise<SealedRead> {
    if (!this.o.legacyResource || this.legacyGone) return 'absent';
    try {
      const r = await this.o.fetch(this.o.legacyResource, { headers: { Accept: 'application/json' } });
      if (r.status === 404 || r.status === 410) { this.legacyGone = true; this.legacySeen = false; return 'absent'; }
      if (!r.ok) return 'failed';
      this.o.registry.load(JSON.parse(await r.text()));
      // It has to be written sealed, and the clear copy removed, even if nothing else changes.
      this.legacySeen = true;
      this.o.registry.dirty = true;
      return 'loaded';
    } catch { return 'failed'; }
  }

  /**
   * Read what the pod holds and, if a clear copy was found, write it sealed and remove it. True
   * when no clear copy is left (or there is nothing configured to settle). Called at start and
   * again until true, so a registry nobody changes is still moved out of the clear.
   */
  async settle(): Promise<boolean> {
    if (!this.configured || !this.o.legacyResource) return true;
    if ((await this.reload(true)) === 'failed') return false;
    if (this.o.registry.dirty && !(await this.write())) return false;
    return this.legacyGone || !this.legacySeen;
  }

  /** Bring this process up to what the pod holds. A read within `staleMs` is not repeated unless `fresh`. */
  async reload(fresh = false): Promise<SealedRead> {
    if (!this.configured) return 'unconfigured';
    if (!fresh && this.readAt && this.now() - this.readAt <= (this.o.staleMs ?? 30_000)) return 'loaded';
    const read = await this.readOnce();
    if (read !== 'failed') this.readAt = this.now();
    return read;
  }

  private async writeOnce(): Promise<boolean> {
    if (!this.configured) return false;
    if (!this.o.registry.dirty) return true;
    this.o.registry.dirty = false;
    try {
      const read = await this.readOnce();
      if (read === 'failed') { this.o.registry.dirty = true; return false; }
      await makeContainer(this.o.fetch, this.o.resource.replace(/[^/]+$/, ''));
      const covered = this.o.pending?.() ?? [];
      const written = await this.o.fetch(this.o.resource, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: sealJson(this.o.registry.toJSON(), this.o.key!) });
      if (written.ok) {
        this.o.committed?.(covered);
        this.readAt = this.now();
        if (this.legacySeen && this.o.legacyResource) {
          // The clear copy goes once the sealed one is there. If the pod does not remove it now, the
          // next write tries again: it stays marked.
          const gone = await this.o.fetch(this.o.legacyResource, { method: 'DELETE' }).then(d => d.ok || d.status === 404 || d.status === 410, () => false);
          if (gone) { this.legacySeen = false; this.legacyGone = true; }
        }
        return true;
      }
    } catch { /* fall through: still dirty */ }
    this.o.registry.dirty = true;
    return false;
  }

  /** True when the pod holds, sealed, what this process holds. One write at a time. */
  write(): Promise<boolean> {
    this.chain = this.chain.then(() => this.writeOnce(), () => this.writeOnce());
    return this.chain;
  }
}

// ── Many records, each its own sealed resource ──────────────────────────────────────────────────

export type KeptValue<V> = { state: 'held'; value: V } | { state: 'absent' } | { state: 'unreadable' } | { state: 'unconfigured' };

const part = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 40);

/**
 * Records kept one to a sealed resource, by a namespace (a tenant) and a key.
 *
 * The pod is where a record is; this object keeps nothing but which key a write is in flight for.
 * A caller that holds a copy in memory holds a cache, fills it from `get`, and drops its entry when
 * a `put` fails so the next read sees what the pod actually has.
 *
 * - A resource's address is made from hashes of the namespace and the key, so neither a tenant's
 *   address nor a DID appears in a pod path. The sealed body carries both, and a body found under
 *   an address its own namespace and key do not make is unreadable, not someone else's record.
 * - Writes to one key run one at a time, in the order they were asked for. There is no revision
 *   check: this is one bridge process. Two would overwrite each other here.
 * - Nothing lists the records. What is kept is reached by its key, which every caller here has.
 */
export class SealedPodMap<V> {
  private readonly writing = new Map<string, Promise<unknown>>();

  constructor(private readonly o: {
    /** The container the records go under, ending in "/". Empty when the bridge has no pod. */
    base: string; key: EncryptionKeyPair | null; fetch: SealedFetch;
    /** Whether what a body held is a record of this kind. One that is not is unreadable. */
    valid: (v: unknown) => v is V;
  }) {}

  get configured(): boolean { return !!this.o.base && !!this.o.key; }
  urlOf(ns: string, key: string): string { return `${this.o.base}${part(ns)}/${part(key)}.envelope.json`; }

  async get(ns: string, key: string): Promise<KeptValue<V>> {
    if (!this.configured) return { state: 'unconfigured' };
    try {
      const r = await this.o.fetch(this.urlOf(ns, key), { headers: { Accept: 'application/json' } });
      if (r.status === 404 || r.status === 410) return { state: 'absent' };
      if (!r.ok) return { state: 'unreadable' };
      const opened = openSealed(await r.text(), this.o.key!);
      if (!opened.ok) return { state: 'unreadable' };
      const body = opened.value as { ns?: unknown; key?: unknown; value?: unknown } | null;
      if (!body || body.ns !== ns || body.key !== key || !this.o.valid(body.value)) return { state: 'unreadable' };
      return { state: 'held', value: body.value };
    } catch { return { state: 'unreadable' }; }
  }

  private queued<T>(ns: string, key: string, fn: () => Promise<T>): Promise<T> {
    const k = this.urlOf(ns, key);
    const next = (this.writing.get(k) ?? Promise.resolve()).then(fn, fn);
    const settled = next.then(() => undefined, () => undefined);
    this.writing.set(k, settled);
    void settled.then(() => { if (this.writing.get(k) === settled) this.writing.delete(k); });
    return next;
  }

  /** `kept` when the pod took the record, `failed` when it did not, `unconfigured` when there is no pod or key to keep it with. */
  put(ns: string, key: string, value: V, now: number = Date.now()): Promise<'kept' | 'failed' | 'unconfigured'> {
    if (!this.configured) return Promise.resolve('unconfigured');
    return this.queued(ns, key, async () => {
      try {
        await makeContainer(this.o.fetch, this.o.base);
        await makeContainer(this.o.fetch, `${this.o.base}${part(ns)}/`);
        const r = await this.o.fetch(this.urlOf(ns, key), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: sealJson({ ns, key, value, keptAt: new Date(now).toISOString() }, this.o.key!) });
        return r.ok ? 'kept' as const : 'failed' as const;
      } catch { return 'failed' as const; }
    });
  }

  /** `gone` when the pod no longer holds it (or never did). */
  remove(ns: string, key: string): Promise<'gone' | 'failed' | 'unconfigured'> {
    if (!this.configured) return Promise.resolve('unconfigured');
    return this.queued(ns, key, async () => {
      try {
        const r = await this.o.fetch(this.urlOf(ns, key), { method: 'DELETE' });
        return r.ok || r.status === 404 || r.status === 410 ? 'gone' as const : 'failed' as const;
      } catch { return 'failed' as const; }
    });
  }
}
