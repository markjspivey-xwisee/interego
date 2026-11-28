/**
 * SCORM sequencing sessions, one record each, with a bound on how many are kept.
 *
 * ★ WHY. The sessions were one snapshot of every session, published whole after each step. On the
 * deployed bridge that publish takes about sixteen seconds (measured 2026-11-27), so a step could
 * not wait for it, and a process that stopped during it lost the step. One record per session
 * through `KeptRecords` is one native commit, a few hundred milliseconds, so a step is kept before
 * it is answered.
 *
 * ★ WHY THE BOUND. `POST /scorm/sequencing/session` is public and unsigned. The snapshot was
 * bounded because the map in memory was (5000, oldest out). A record per session is not bounded
 * by anything unless something counts them: each request would add a record for ever. So there is
 * an index record, the ids in the order they were first kept, changed by a conditional commit:
 *  - a session is added to the index BEFORE its record is written, and its record is not written
 *    if the index could not be changed, so no record exists that the index does not know;
 *  - past the bound, the oldest ids move to `evicting`, their records are removed, and an id
 *    leaves `evicting` only once its record has gone. A removal that fails is tried again by the
 *    next session that is added.
 * So at most `max` + the few still being removed are held, across restarts and across bridges.
 */
import type { KeptRecords } from './kept-records.js';
import type { KeptValue } from './sealed-store.js';

export interface KeptSessionIndex { order: string[]; evicting: string[] }
export const isKeptSessionIndex = (v: unknown): v is KeptSessionIndex =>
  !!v && Array.isArray((v as KeptSessionIndex).order) && Array.isArray((v as KeptSessionIndex).evicting)
  && (v as KeptSessionIndex).order.every(x => typeof x === 'string') && (v as KeptSessionIndex).evicting.every(x => typeof x === 'string');

const NS = 'scorm-sequencing-sessions';
const INDEX = 'index';

export class KeptScormSessions<S> {
  /** Ids this process knows the index holds. A session read from the old snapshot is not one until it is kept here. */
  private readonly indexed = new Set<string>();
  constructor(private readonly o: { records: KeptRecords<S>; index: KeptRecords<KeptSessionIndex>; max: number }) {}

  /** False where nothing outside this process can hold a session. */
  get configured(): boolean { return this.o.records.configuredFor(NS); }
  get mechanism(): 'native-commit' | 'sealed-pod-resource' | 'none' { return this.o.records.mechanismFor(NS); }

  async load(id: string): Promise<KeptValue<S>> {
    const held = await this.o.records.get(NS, id);
    if (held.state === 'held') this.remember(id);
    return held;
  }

  /** True once the pod holds the session as given. */
  async keep(id: string, session: S): Promise<boolean> {
    if (!this.indexed.has(id)) {
      const added = await this.o.index.update<string[]>(NS, INDEX, (current) => {
        const order = [...(current?.order ?? [])], evicting = [...(current?.evicting ?? [])];
        if (!order.includes(id)) order.push(id);
        while (order.length > this.o.max) evicting.push(order.shift()!);
        return { value: { order, evicting }, result: evicting };
      });
      if (added.state !== 'kept') return false;
      this.remember(id);
      if (added.result.length > 0) void this.evict(added.result);
    }
    return (await this.o.records.put(NS, id, session)) === 'kept';
  }

  /** Remove the records of ids the index has let go, and tell the index which have gone. */
  private async evict(ids: readonly string[]): Promise<void> {
    const gone: string[] = [];
    for (const id of ids.slice(0, 50)) {
      this.indexed.delete(id);
      if ((await this.o.records.remove(NS, id)) === 'gone') gone.push(id);
    }
    if (gone.length === 0) return;
    await this.o.index.update<void>(NS, INDEX, (current) => ({
      value: { order: [...(current?.order ?? [])], evicting: (current?.evicting ?? []).filter(id => !gone.includes(id)) },
      result: undefined,
    }));
  }

  private remember(id: string): void {
    if (this.indexed.size >= this.o.max * 2) this.indexed.clear();
    this.indexed.add(id);
  }
}
