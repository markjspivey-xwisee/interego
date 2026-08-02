/**
 * @module engagement
 * @description The engine: a bounded, owner-scoped engagement store plus the
 *              transition rules. Spec-blind — no wire protocol is named here.
 *
 * Security posture, learned from the relay audit rather than assumed:
 *   - Every read and mutation is OWNER-SCOPED. An engagement id is guessable in
 *     principle, so possession of an id is never authority (the audit's
 *     broken-object-level-authorization class).
 *   - Attribution is taken from the VERIFIED caller passed in by the mount, never
 *     from anything in the request body (the forgeable-attribution class).
 *   - The store is CAPPED with eviction. Any caller-reachable map that grows
 *     without a bound is an OOM primitive (the unbounded-state class).
 */

import type { Engagement, EngagementState, Part, Turn, TurnRole } from './types.js';
import { TERMINAL_STATES } from './types.js';

export interface EngagementStoreOptions {
  /** Hard cap on retained engagements. Oldest-first eviction past it. */
  maxEngagements?: number;
  /** Hard cap on turns per engagement. Oldest-first eviction past it. */
  maxTurnsPerEngagement?: number;
  /** Hard cap on parts per turn — rejected, not evicted (a turn is atomic). */
  maxPartsPerTurn?: number;
  /** Hard cap on outputs per engagement — rejected, not evicted. */
  maxOutputsPerEngagement?: number;
  /**
   * Hard cap on retained eviction markers. Bounded for the same reason the engagements
   * are: an unbounded record of what was dropped for space defeats the bound it explains.
   */
  maxTombstones?: number;
}

const DEFAULTS = {
  maxEngagements: 50_000,
  maxTurnsPerEngagement: 1_000,
  maxPartsPerTurn: 128,
  maxOutputsPerEngagement: 32,
  maxTombstones: 10_000,
} as const;

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: EngineError };

export interface EngineError {
  kind:
    | 'unauthenticated' | 'forbidden' | 'notFound' | 'badRequest'
    | 'unsupportedOperation' | 'internal'
    /**
     * The engagement existed and was dropped to stay within the retention bound.
     *
     * ★ Distinct from `notFound` on purpose. `notFound` asserts the id never existed,
     * which after an eviction is false — and a peer holding the id, or a workspace entry
     * citing it, cannot act on a claim that is false. This says "real, and no longer
     * kept", which is a retention limit somebody can raise rather than an error in the
     * caller. Only ever returned to the engagement's OWNER; to anyone else it stays
     * indistinguishable from a genuine miss.
     */
    | 'gone';
  detail: string;
}

const fail = (kind: EngineError['kind'], detail: string): EngineResult<never> =>
  ({ ok: false, error: { kind, detail } });

/**
 * Type guard for the error arm.
 *
 * Consumers compiled WITHOUT strictNullChecks (the relay is one) do not get
 * discriminated-union narrowing from `if (!r.ok)`, so a plain property access on
 * `r.error` fails to compile there. A user-defined guard narrows regardless of that
 * setting — which keeps the engine usable from every consumer in the monorepo
 * without either weakening this package's types or casting at each call site.
 */
export function isEngineError<T>(r: EngineResult<T>): r is { ok: false; error: EngineError } {
  return r.ok === false;
}

/**
 * Legal transitions. The engine — not a profile — owns this, so a profile cannot
 * declare its way into an illegal state change (e.g. reviving a terminal record).
 */
const LEGAL: Readonly<Record<EngagementState, ReadonlySet<EngagementState>>> = {
  submitted: new Set<EngagementState>(['working', 'input-required', 'completed', 'failed', 'cancelled', 'rejected']),
  working: new Set<EngagementState>(['working', 'input-required', 'completed', 'failed', 'cancelled']),
  'input-required': new Set<EngagementState>(['working', 'completed', 'failed', 'cancelled']),
  completed: new Set<EngagementState>(),
  failed: new Set<EngagementState>(),
  cancelled: new Set<EngagementState>(),
  rejected: new Set<EngagementState>(),
};

/**
 * What a caller may do with an engagement AS IT NOW STANDS.
 *
 * This is the hypermedia primitive: a representation should carry its own
 * followable next steps rather than making the client reconstruct URLs from
 * out-of-band knowledge of the protocol. The answer is DERIVED from the state
 * machine above — not a hand-maintained second list that can drift from it — so a
 * terminal engagement advertises nothing and can never advertise a step the engine
 * would refuse.
 *
 * The engine returns engine-level operation names; each profile renders them into
 * its own hypermedia vocabulary (link relations, typed controls, whatever it uses).
 */
export function availableOperations(state: EngagementState): ReadonlyArray<'appendTurn' | 'cancel' | 'read'> {
  const ops: Array<'appendTurn' | 'cancel' | 'read'> = ['read'];
  if (TERMINAL_STATES.has(state)) return ops;
  ops.push('appendTurn');
  if (LEGAL[state].has('cancelled')) ops.push('cancel');
  return ops;
}

export class EngagementEngine {
  private readonly engagements = new Map<string, Engagement>();
  /** Evicted ids, with who owned them — owner-scoped so this is not an existence oracle. */
  private readonly tombstones = new Map<string, { owner: string; evictedAt: string }>();
  private readonly opts: Required<EngagementStoreOptions>;
  private seq = 0;

  constructor(
    /** Absolute base URL used to mint dereferenceable ids. */
    private readonly serviceUrl: string,
    opts: EngagementStoreOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Mint a dereferenceable engagement id — a URL that resolves to the record,
   *  never a urn:. `now` is injected so ids stay deterministic under test. */
  private mintId(now: number): string {
    const base = this.serviceUrl.replace(/\/$/, '');
    return `${base}/engagements/${now.toString(36)}-${(this.seq++).toString(36)}`;
  }

  /**
   * Drop the oldest engagement when the store is full — and leave a marker saying so.
   *
   * ★ Eviction used to be silent, and silence here breaks a promise the id itself makes.
   * `mintId` returns a dereferenceable URL, and the substrate's rule is that an identifier
   * resolves. After eviction it did not: the id came back `notFound`, which asserts that
   * it NEVER EXISTED. A peer holding that id — or a workspace entry citing it — could not
   * tell "this engagement was real and we no longer keep it" from "you made this up".
   *
   * Those are different facts and they need different answers. The first is a retention
   * limit somebody can raise; the second is an error in the caller. Conflating them makes
   * a capacity problem look like a correctness problem, which is how retention limits go
   * unnoticed until an audit needs the record that is gone.
   *
   * ★ The tombstone is OWNER-SCOPED, exactly like `get`. Telling a stranger that some id
   * once existed would turn eviction into the existence oracle the owner-scoping exists to
   * prevent — the same rule the `/engagements/:id` route follows, and for the same reason.
   * The tombstone set is bounded too: an unbounded record of evictions would defeat the
   * bound it exists to explain.
   */
  private evictIfNeeded(): void {
    if (this.engagements.size < this.opts.maxEngagements) return;
    const oldest = this.engagements.keys().next().value;
    if (oldest === undefined) return;
    const victim = this.engagements.get(oldest);
    this.engagements.delete(oldest);
    if (victim) {
      if (this.tombstones.size >= this.opts.maxTombstones) {
        const stale = this.tombstones.keys().next().value;
        if (stale !== undefined) this.tombstones.delete(stale);
      }
      this.tombstones.set(oldest, { owner: victim.openedBy, evictedAt: new Date().toISOString() });
    }
  }

  /** Open an engagement attributed to the VERIFIED caller. */
  open(args: {
    caller: string | undefined;
    capability?: string;
    parts: Part[];
    now?: number;
  }): EngineResult<Engagement> {
    if (!args.caller) return fail('unauthenticated', 'a verified caller is required to open an engagement');
    if (!Array.isArray(args.parts) || args.parts.length === 0) {
      return fail('badRequest', 'at least one content part is required');
    }
    if (args.parts.length > this.opts.maxPartsPerTurn) {
      return fail('badRequest', `too many parts (max ${this.opts.maxPartsPerTurn})`);
    }
    const now = args.now ?? Date.now();
    const iso = new Date(now).toISOString();
    const id = this.mintId(now);
    const turn: Turn = {
      id: `${id}/turns/0`,
      role: 'requester',
      parts: args.parts,
      at: iso,
      attributedTo: args.caller,
    };
    const engagement: Engagement = {
      id,
      state: 'submitted',
      openedBy: args.caller,
      ...(args.capability ? { capability: args.capability } : {}),
      turns: [turn],
      createdAt: iso,
      updatedAt: iso,
    };
    this.evictIfNeeded();
    this.engagements.set(id, engagement);
    return { ok: true, value: engagement };
  }

  /**
   * Admit a record that came FROM durable storage.
   *
   * ★ THE ORDERING RULE THIS EXISTS TO SERVE. The engagements map is a working set, not a
   * system of record: it empties on restart and evicts under its own bound. A deployment
   * that wants its minted ids to keep resolving pairs this engine with a durable store and
   * keeps the map a strict SUBSET of it — nothing enters here except immediately after a
   * successful durable write, or as the result of a read FROM the durable store. This is
   * that second door, and it is the only one. Admitting a record from anywhere else would
   * let one process answer for something no other replica can see, which is the failure
   * durability was added to remove rather than relocate.
   *
   * ★ IT CLEARS THE TOMBSTONE. Eviction leaves an owner-scoped marker so `get` can say
   * `gone` instead of the false `notFound`. But `gone` is also false once the record is
   * back from durable storage — it says "real, and no longer kept" about something that
   * IS kept. Re-admitting therefore retires the marker.
   *
   * The record is re-inserted at the tail, so eviction order tracks last use rather than
   * first write. That is a deliberate consequence, not an oversight: under a durable store
   * evicting the least recently touched record is what a bounded cache should do.
   *
   * ★ IT IS NOT, HOWEVER, A LISTING ORDER, and for a while it silently was one. `list` read
   * the map in insertion order, so re-admitting a page reversed the order of the NEXT
   * listing and successive identical calls alternated. Map order is now a cache-eviction
   * concern only; `list` sorts on `createdAt`.
   *
   * Deliberately NOT owner-scoped, and safe not to be: it takes no caller and returns
   * nothing, so it discloses nothing. Every READ of what it admits still goes through the
   * owner check in `get`.
   */
  admit(e: Engagement): void {
    this.tombstones.delete(e.id);
    this.engagements.delete(e.id);
    this.evictIfNeeded();
    this.engagements.set(e.id, e);
  }

  /**
   * Drop a record from the working set WITHOUT a tombstone.
   *
   * Two callers, one rule: this map must never answer for something durable storage does
   * not have. A read that finds the store has no such record calls this; so does a write
   * whose durable put failed, because the alternative is a record that resolves here and
   * nowhere else, until the next restart denies it.
   *
   * No tombstone, unlike eviction, because the facts differ. Eviction says "this was real
   * and we dropped it for space" — a retention limit somebody can raise. This says nothing
   * at all, because the record was never durably real, and claiming otherwise to its own
   * would-be owner is just a different false answer.
   *
   * ★ IT ALSO RETIRES ANY TOMBSTONE ALREADY STANDING, and leaving that line out made the
   * paragraph above a lie. `forget` only deleted from `engagements`, so a record the bound
   * had already evicted kept its marker, and the very next owner-scoped read answered
   * `gone` — rendered by the resolver route as 410 "dropped at <t> to stay within the
   * retention bound … Raise maxEngagements". That reason is false for every caller of this
   * method: they call it because a durable write FAILED or because the store says the
   * record is not there, neither of which is a retention limit and neither of which
   * raising `maxEngagements` would fix. Saying the wrong cause with a confident status
   * code is worse than saying nothing, so the marker goes when the record does.
   */
  forget(id: string): void {
    this.engagements.delete(id);
    this.tombstones.delete(id);
  }

  /** Owner-scoped read. Possession of an id is never authority. */
  get(id: string, caller: string | undefined): EngineResult<Engagement> {
    if (!caller) return fail('unauthenticated', 'a verified caller is required');
    const e = this.engagements.get(id);
    if (!e || e.openedBy !== caller) {
      // ★ The OWNER of an evicted engagement is told it was evicted. Everyone else gets
      // the same answer they would get for an id that never existed — a distinct response
      // would be an existence oracle over other principals' engagement ids, which is the
      // rule `/engagements/:id` follows for exactly this reason.
      const t = this.tombstones.get(id);
      if (t && t.owner === caller) {
        return fail(
          'gone',
          `this engagement existed and was dropped at ${t.evictedAt} to stay within the `
          + 'retention bound. It is not recoverable from this relay. Raise maxEngagements, '
          + 'or persist engagements you need to keep.',
        );
      }
      // Deliberately indistinguishable from a genuine miss.
      return fail('notFound', 'no such engagement');
    }
    return { ok: true, value: e };
  }

  /**
   * Owner-scoped list — only the caller's own engagements, newest first.
   *
   * ★ "NEWEST FIRST" IS DECIDED BY `createdAt`, NOT BY MAP ORDER, AND IT HAD TO BE.
   *
   * This used to be `mine.slice(-bounded).reverse()` — the last N in insertion order. That
   * is only "newest first" while insertion order tracks creation order, and `admit` breaks
   * exactly that: it re-inserts at the tail so eviction can be least-recently-used. Pair
   * the engine with a durable store and every listing warms its own page, which re-admits
   * every record it listed, which reverses their map order — so two identical successive
   * listings came back newest-first, then oldest-first, then newest-first again. A caller
   * paging or diffing a list saw the order flip under it with no write anywhere.
   *
   * Sorting on the record's own creation time makes the answer a property of the records
   * rather than of the reads that happened to precede it, so warming, eviction and restart
   * order cannot move it. Ties (records minted in the same millisecond) break on the id, so
   * the order is at least deterministic; the id's mint counter is base36 and compared as
   * text, so within one millisecond that tiebreak is stable but not necessarily mint order.
   *
   * The bound now takes the newest N rather than the most recently TOUCHED N, which is what
   * a caller asking for "newest first, limit N" was already being promised.
   */
  list(caller: string | undefined, limit = 50): EngineResult<Engagement[]> {
    if (!caller) return fail('unauthenticated', 'a verified caller is required');
    const bounded = Math.max(1, Math.min(limit, 200));
    const mine = [...this.engagements.values()].filter(e => e.openedBy === caller);
    mine.sort((a, b) => (a.createdAt === b.createdAt
      ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      : (a.createdAt < b.createdAt ? 1 : -1)));
    return { ok: true, value: mine.slice(0, bounded) };
  }

  /** Append a turn. Owner-scoped; refuses once terminal. */
  appendTurn(args: {
    id: string;
    caller: string | undefined;
    role: TurnRole;
    parts: Part[];
    now?: number;
  }): EngineResult<Engagement> {
    const found = this.get(args.id, args.caller);
    if (!found.ok) return found;
    const e = found.value;
    if (TERMINAL_STATES.has(e.state)) {
      return fail('badRequest', `engagement is ${e.state} and accepts no further turns`);
    }
    if (args.parts.length > this.opts.maxPartsPerTurn) {
      return fail('badRequest', `too many parts (max ${this.opts.maxPartsPerTurn})`);
    }
    const now = args.now ?? Date.now();
    if (e.turns.length >= this.opts.maxTurnsPerEngagement) e.turns.shift();
    e.turns.push({
      id: `${e.id}/turns/${e.turns.length}`,
      role: args.role,
      parts: args.parts,
      at: new Date(now).toISOString(),
      ...(args.role === 'requester' && args.caller ? { attributedTo: args.caller } : {}),
    });
    e.updatedAt = new Date(now).toISOString();
    return { ok: true, value: e };
  }

  /** Transition. The engine owns legality so a profile cannot declare around it. */
  transition(args: {
    id: string;
    caller: string | undefined;
    to: EngagementState;
    now?: number;
  }): EngineResult<Engagement> {
    const found = this.get(args.id, args.caller);
    if (!found.ok) return found;
    const e = found.value;
    if (!LEGAL[e.state].has(args.to)) {
      return fail('badRequest', `illegal transition ${e.state} -> ${args.to}`);
    }
    e.state = args.to;
    e.updatedAt = new Date(args.now ?? Date.now()).toISOString();
    return { ok: true, value: e };
  }

  /**
   * Record work having STARTED. Owner-scoped like every other mutation.
   *
   * Separate from `complete` because a peer polling the record should be able to
   * tell "accepted but not begun" from "running" — a distinction the lifecycle
   * already models and nothing was using.
   */
  begin(id: string, caller: string | undefined, now?: number): EngineResult<Engagement> {
    return this.transition({ id, caller, to: 'working', ...(now !== undefined ? { now } : {}) });
  }

  /**
   * Record a produced result and finish. Owner-scoped.
   *
   * Outputs are CAPPED and each output's parts are capped, for the same reason
   * turns are: any caller-reachable list that grows without a bound is an OOM
   * primitive, and a capability that returns a large result is the obvious way to
   * reach this one.
   */
  complete(args: {
    id: string;
    caller: string | undefined;
    outputs?: Array<{ name?: string; description?: string; parts: Part[] }>;
    now?: number;
  }): EngineResult<Engagement> {
    const found = this.get(args.id, args.caller);
    if (!found.ok) return found;
    const e = found.value;
    const given = args.outputs ?? [];
    if (given.length > this.opts.maxOutputsPerEngagement) {
      return fail('badRequest', `too many outputs (max ${this.opts.maxOutputsPerEngagement})`);
    }
    for (const o of given) {
      if (o.parts.length > this.opts.maxPartsPerTurn) {
        return fail('badRequest', `too many parts in an output (max ${this.opts.maxPartsPerTurn})`);
      }
    }
    const moved = this.transition({ id: args.id, caller: args.caller, to: 'completed', ...(args.now !== undefined ? { now: args.now } : {}) });
    if (!moved.ok) return moved;
    // Ids are dereferenceable URLs under the engagement — an output is addressable.
    e.outputs = given.map((o, i) => ({
      id: `${e.id}/outputs/${i}`,
      ...(o.name ? { name: o.name } : {}),
      ...(o.description ? { description: o.description } : {}),
      parts: o.parts,
    }));
    return { ok: true, value: e };
  }

  /** Record that the work failed. Owner-scoped. The reason rides as a turn so it is
   *  visible to a peer reading the record, not swallowed. */
  fail(args: { id: string; caller: string | undefined; reason: string; now?: number }): EngineResult<Engagement> {
    const found = this.get(args.id, args.caller);
    if (!found.ok) return found;
    const e = found.value;
    const now = args.now ?? Date.now();
    if (!TERMINAL_STATES.has(e.state)) {
      e.turns.push({
        id: `${e.id}/turns/${e.turns.length}`,
        role: 'responder',
        parts: [{ kind: 'text', text: args.reason }],
        at: new Date(now).toISOString(),
      });
    }
    return this.transition({ id: args.id, caller: args.caller, to: 'failed', now });
  }

  /** Cancel — the common terminal transition, owner-scoped. */
  cancel(id: string, caller: string | undefined, now?: number): EngineResult<Engagement> {
    return this.transition({ id, caller, to: 'cancelled', ...(now !== undefined ? { now } : {}) });
  }

  /** Test/inspection helper. */
  size(): number { return this.engagements.size; }
}
