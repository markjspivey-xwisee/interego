/**
 * Records the bridge keeps: committed natively where the tenant's record store is native, and
 * sealed on the pod otherwise.
 *
 * ★ WHY. docs/operations/native-learning-storage.md is the binding decision: canonical records
 * are encrypted native Interego artifacts published by one conditional head commit, with a commit
 * receipt. The stores of 2026-11-26 (trajectories, probes, evaluations, SCORM attempts in
 * progress) did not do that. They wrote one sealed resource per record with a plain PUT
 * (src/sealed-store.ts): it survives a restart of one bridge, and it is one writer, last write
 * wins, no revision check, no receipt. Two bridge processes could each believe they kept a record
 * the other then replaced.
 *
 * The native record store already has what is needed and xAPI documents already use it:
 * `getResource` / `putResource` / `deleteResource` on `NativeInteregoLrsStore`, each an encrypted
 * artifact under the tenant, published by the same atomic head commit a statement is. So this
 * adds no storage mechanism. It routes these records to that one when it is there.
 *
 * WHAT IS READ FROM WHERE.
 *  - Native tenant: the native record. When there is none, the sealed copy an earlier bridge kept
 *    is looked for once; if it is there it is committed natively and then removed, and it is the
 *    answer. A record that cannot be read in either place is `unreadable`, never `absent`.
 *  - Any other tenant: the sealed pod record, as before.
 *
 * WHAT A WRITE AND A REMOVAL TOUCH. A native write also removes the sealed copy. A removal removes
 * the sealed copy first and the native record only once that is gone: a sealed copy left behind
 * would be read back as the record after the native one was removed. A removal is `gone` only
 * when neither place holds it.
 */
import type { KeptValue, SealedPodMap } from './sealed-store.js';

/** The part of the native record store this uses. `NativeInteregoLrsStore` is one. */
export interface NativeResources {
  getResource<T>(kind: string, id: string): Promise<T | null>;
  putResource<T>(kind: string, id: string, value: T): Promise<void>;
  deleteResource(kind: string, id: string): Promise<void>;
  /** One conditional commit: `mutate` sees the record as the commit's own head has it, and is run again on a head conflict. */
  updateResource<T, R>(kind: string, id: string, mutate: (current: T | null) => { value: T | null; result: R }): Promise<R>;
}

export class KeptRecords<V> {
  constructor(private readonly o: {
    /** The native record kind these are committed under: at most 64 characters, and not one the statement store reserves. */
    kind: string;
    sealed: SealedPodMap<V>;
    /** The native store of the tenant a namespace belongs to, or null when that tenant's store is not native. */
    native: (ns: string) => NativeResources | null;
    valid: (v: unknown) => v is V;
  }) {}

  /** Whether anything outside this process can hold a record of this namespace. */
  configuredFor(ns: string): boolean { return !!this.o.native(ns) || this.o.sealed.configured; }
  /** How records of this namespace are kept, for an answer or a log line. */
  mechanismFor(ns: string): 'native-commit' | 'sealed-pod-resource' | 'none' {
    return this.o.native(ns) ? 'native-commit' : this.o.sealed.configured ? 'sealed-pod-resource' : 'none';
  }
  /** A stable name for one record, for a caller's own bookkeeping. Not an address. */
  markOf(ns: string, key: string): string { return `${this.o.kind}\n${ns}\n${key}`; }

  async get(ns: string, key: string): Promise<KeptValue<V>> {
    const native = this.o.native(ns);
    if (!native) return this.o.sealed.get(ns, key);
    let held: unknown;
    try { held = await native.getResource<unknown>(this.o.kind, key); }
    catch { return { state: 'unreadable' }; }
    if (held !== null && held !== undefined) return this.o.valid(held) ? { state: 'held', value: held } : { state: 'unreadable' };
    // No native record. One an earlier bridge kept sealed is brought across, once.
    const before = await this.o.sealed.get(ns, key);
    if (before.state !== 'held') return before.state === 'unreadable' ? before : { state: 'absent' };
    // Committed only if there is still no native record when the commit lands. Another bridge
    // may have written one since the read above; an unconditional write here would put the older
    // sealed value back over it (review of #1011). Whatever the commit finds is the answer.
    let won: unknown;
    try { won = await native.updateResource<unknown, unknown>(this.o.kind, key, (current) => (current === null || current === undefined ? { value: before.value, result: before.value } : { value: current, result: current })); }
    catch { return before; }             // still only sealed; the next read tries again
    await this.o.sealed.remove(ns, key); // if this fails, a removal takes it first (below)
    return this.o.valid(won) ? { state: 'held', value: won } : { state: 'unreadable' };
  }

  async put(ns: string, key: string, value: V): Promise<'kept' | 'failed' | 'unconfigured'> {
    const native = this.o.native(ns);
    if (!native) return this.o.sealed.put(ns, key, value);
    try { await native.putResource<V>(this.o.kind, key, value); }
    catch { return 'failed'; }
    // The native record is the record now. A sealed copy must not outlive it.
    if (this.o.sealed.configured) await this.o.sealed.remove(ns, key);
    return 'kept';
  }

  async remove(ns: string, key: string): Promise<'gone' | 'failed' | 'unconfigured'> {
    const native = this.o.native(ns);
    if (!native) return this.o.sealed.remove(ns, key);
    // The sealed copy goes first, and the native record stays until it has. Removing the native
    // one while a sealed copy an earlier cleanup left is still there would have the next read
    // bring that older copy back as the record (review of #1011).
    if (this.o.sealed.configured && (await this.o.sealed.remove(ns, key)) === 'failed') return 'failed';
    try { await native.deleteResource(this.o.kind, key); } catch { return 'failed'; }
    return 'gone';
  }
}
