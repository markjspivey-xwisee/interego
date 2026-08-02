/**
 * Durable engagement records — the storage behind every `<base>/engagements/<id>` URL
 * this relay mints.
 *
 * ★ THE INVARIANT:  resolvable(id) ⟺ the record is in the durable store.
 *
 * Everything below describes the configured-store path. A deployment with no store keeps
 * exactly the behaviour it had before this module existed — the Map is the system of
 * record, ids die with the process, and the mount says so at boot. There is no invariant
 * to hold there and none is claimed.
 *
 * The engagement engine keeps its records in a process-local Map. That Map is a fine
 * working set and a terrible system of record: a Railway rolling deploy or an OOM
 * restart empties it, and the engine's own bound evicts from it sooner than that. Every
 * id it had handed out then stopped resolving. `mintId`'s comment says "a URL that
 * resolves to the record, never a urn:", and a urn: would at least have been honestly
 * undereferenceable — this was a URL that promised and refused. An intermittently
 * resolving identifier is worse than a consistently absent one, because it poisons
 * caches and agent memory with a fact the origin will later deny.
 *
 * ★ THE CACHE ORDERING RULE, stated over READS rather than over the Map's contents.
 *
 * The first version of this paragraph said "nothing enters the Map except immediately
 * after a successful durable write, or as the result of a read FROM the durable store".
 * That was FALSE the day it was written: `engine.open` inserts the record before any
 * durable write exists, and three error exits in the mount used to return between there
 * and the write without dropping it — leaving a record that lived in one heap and nowhere
 * else, which `list` then reported. A rule the code does not obey is worse than no rule,
 * because it stops anyone looking.
 *
 * The rule that IS enforced, and is what actually matters: **no read on the interop
 * surface can answer for a record the durable store does not have.** Every read path
 * reconciles
 * against the store first — `warm()` for a single id, `reconcile()` for a listing page —
 * and reconciliation REFUSES TO ANSWER for whatever the store does not have. A record does
 * still enter the Map at `open`, before its first write; what closed the hole is that (a)
 * every exit between the open and the write either persists the record or drops it (the
 * mount's `finally`, see `abandon`), and (b) no reader can observe it in that window
 * anyway, because readers go to the store.
 *
 * ★ REFUSING TO ANSWER IS NOT THE SAME AS DELETING, AND CONFLATING THEM LOST LIVE DATA.
 *
 * The first implementation of that rule enforced it with `engine.forget(id)` on every miss.
 * But `open` inserts before the first write, so between the open and the write the store
 * legitimately does not have the record — and a read arriving in that window DELETED an
 * engagement that was mid-flight. No attacker and no guessed id were needed: the owner's
 * own `GET …/tasks` warms every id on its own page, and while a capability invocation ran
 * (an arbitrary-length `await` between the open and the write) that listing dropped the
 * record the request was about to complete. `engine.complete` then answered `notFound` and
 * the caller received 404 for an operation that was succeeding. Live wherever
 * `RELAY_PGSL_PG_CONNSTR` is set, i.e. production.
 *
 * The two facts are different and the code now says so. A record the store has never been
 * TOLD about is not a record the store says is ABSENT. This class holds the ids this
 * process has opened and not yet written (`hold`/`settle`/`abandon`, driven by the mount's
 * one mutating exit) and `warm` reports them as `unwritten`: the record stays in the
 * working set for the handler that owns it, and every READER treats it as not there. So
 * the invariant survives — no read answers for a non-durable record — without a reader
 * being able to destroy one.
 *
 * The hold set is bounded by in-flight requests, not by ids: the mount releases in a
 * `finally`, exactly like `writeGate` below.
 *
 * The immutable case (pgsl-node-store) could get away with a cache hit short-circuiting
 * the read; a mutable record cannot, because a hit would serve one replica's stale copy of
 * a record another replica has since moved on. So every read goes to the store. That is
 * the latency price, and it is stated rather than optimised away.
 *
 * ★ CONCURRENT MUTATION: COMPARE-AND-SWAP, AND EXACTLY WHERE IT STOPS HOLDING.
 *
 * An engagement is read-modify-written: warm it, append a turn, put it back. Shipped
 * unguarded, that is the lost-update class this relay had just spent two rounds removing
 * from `publish_context` — two writers warm v1, both mutate, both write, one turn is gone
 * and BOTH callers were answered 200 with their turn in the response body.
 *
 * So `put` takes the version the writer read and refuses to land on anything else.
 * `get` returns an opaque `version` (a digest of the exact stored bytes); `persist` passes
 * back whatever `warm` last saw for that record, or `null` for a freshly opened one —
 * which also means an `open` whose minted id already exists durably is refused rather than
 * overwriting a stranger. The conflicting write FAILS; nobody is told 200 over a mutation
 * that got overwritten.
 *
 * Where that is a guarantee, and where it is only a detector:
 *   - Within this process it is a guarantee: `persist` serialises writes per engagement id
 *     (`writeGate`), so two in-flight handlers on one id cannot have their read-compare-
 *     write windows overlap. This matters because `warm` re-admits a FRESHLY DECODED
 *     object, so two handlers legitimately hold different object identities for one id —
 *     a hazard that did not exist when the Map was the system of record.
 *   - Across processes it is a guarantee only where the `FdbLike` seam honours its own
 *     documented contract — "on a serializable conflict the implementation retries `fn`
 *     from scratch". `InMemoryFdb` implements that, which is what the tests run against.
 *     The Postgres adapter — which is what production runs — deliberately does NOT:
 *     `pg-store.ts` runs READ COMMITTED and says so, on the grounds that every write it
 *     was built for is content-addressed or "intentional last-writer-wins". An engagement
 *     is neither, and it is the first writer at that seam that is neither. So under
 *     Postgres two REPLICAS whose put transactions overlap can both SELECT the same row,
 *     both pass the check, and the second's `INSERT … ON CONFLICT DO UPDATE` still wins.
 *     Conflicts separated by a commit — every cross-replica case that is not a true
 *     interleave inside one transaction window — are caught. That residual is REAL and
 *     untested here, because a harness that stands in for Postgres cannot demonstrate a
 *     Postgres isolation level either way.
 *   - Closing the residual needs a conditional write at the store seam (`UPDATE … WHERE
 *     k = $1 AND v = $expected`, whose `WHERE` Postgres re-evaluates after the row lock).
 *     `FdbTxn` exposes only unconditional `set`, and pgsl-store is not this module's to
 *     change. It is named here rather than papered over, and it is the one place this
 *     module is last-writer-wins.
 *
 * A refused write reaches the wire routes as the profile's `internal` error, for the same
 * reason `wireKind` collapses `gone`: these protocols' error vocabularies are fixed by
 * their own specifications and inventing a conflict code inside one would be
 * non-conformant. The caller learns the operation did not land, which is the property that
 * had to be preserved.
 *
 * ★ WHY THE ENGINE STAYS SYNCHRONOUS AND THIS OWNS THE I/O. Making
 * `EngagementEngine.get/open/appendTurn/...` async would be a signature change across
 * every call site, every profile, and the external conformance suite that runs against
 * the mounted surface. It would also put a network round trip inside the transition
 * legality rules, where a partial failure has no defined meaning. The mount's handlers
 * are ALREADY async, so the I/O goes where the async already is: warm before a
 * synchronous read, persist after a synchronous mutation, and the engine keeps owning
 * exactly the rules it can decide without leaving the process.
 *
 * ★ WHY WRITES ARE AWAITED, AND WHAT THAT COSTS. A fire-and-forget flush is one round
 * trip cheaper and re-creates the exact lie being removed here, only narrower: the relay
 * responds with an id, the process dies before the flush, and the id it just handed out
 * does not resolve. So the write is awaited BEFORE the response, and if it fails the
 * caller is told so — the record is dropped from the cache and the handler answers an
 * error rather than a 200 over a record only this heap knows about. The cost is one
 * round trip per mutating request (plus one for the read on an existing id), on the same
 * private network as the database.
 *
 * ★ WHAT `list` CAN AND CANNOT DO, which is not what this paragraph used to claim.
 *
 * It claimed `list` was simply cache-scoped, and disclosed only that it UNDER-reports
 * after a restart. It also over-reported: it answered from the Map with no store read at
 * all, so it handed out ids the sibling resolver 404'd, and rendered one replica's stale
 * copy — including an offer to CANCEL a record another replica had already completed.
 * That is precisely the mutable-record failure this module argues a cache hit cannot get
 * away with, exempted by nothing but the fact that nobody had wired the read.
 *
 * `reconcile()` fixes the half that is reachable: the engine's bounded page (≤200 by its
 * own clamp) is checked against the store before it is rendered, so every listed record is
 * one the store confirmed, at the version the store holds. The cost is one point read per
 * listed record — stated, not hidden.
 *
 * What remains, and is a real gap: a listing cannot DISCOVER an id this process has never
 * read, so after a restart it under-reports until reads warm the working set. Every id it
 * omits still resolves individually. Fixing that needs a per-owner index, and both cheap
 * shapes are worse than the gap: one key per engagement makes the listing scan unbounded
 * (the `FdbLike` seam's `getRange` takes no limit, so an owner with 50,000 records is one
 * query returning 50,000 rows), and a single bounded ring row per owner is a second
 * read-modify-write under the same adapter, carrying the same residual — an index built
 * to stop silent loss, with silent loss in it. Guarding the ring row with the same
 * compare-and-swap as the record does not rescue it either: it converts the loss into a
 * refusal that fails the WHOLE mutating request, so every owner's opens would start
 * contending on one hot row. Neither shape is worth it for a listing whose gap is
 * "incomplete until read", when every omitted id still resolves.
 */

import { createHash } from 'node:crypto';
import { openPgStore, type FdbLike } from '@interego/pgsl-store';
import {
  isEngineError,
  type Engagement, type EngagementState, type EngagementEngine,
} from '@interego/agent-interop';

const CONNSTR = process.env['RELAY_PGSL_PG_CONNSTR'] ?? '';

/**
 * ★ THE SAME TABLE AS THE PUBLISHED-NODE COMMONS, ON PURPOSE.
 *
 * The runtime database role deliberately has NO DDL rights and holds
 * SELECT/INSERT/UPDATE/DELETE on exactly one table (see `bootstrapDurableStore` in
 * pgsl-node-store.ts). A second table would need a second grant, so a relay deployed
 * before that grant existed would fail `permission denied` on every interop request —
 * turning a durability improvement into an outage. The whole point of the store being a
 * single `kv(k bytea PRIMARY KEY, v bytea)` under an order-preserving keyspace is that
 * another subspace is free. `ROOT` below shares no prefix with the PGSL keyspace's
 * `pgsl\x00`, and every scan on that side is prefix-bounded, so neither can see the
 * other's rows.
 */
const TABLE = process.env['RELAY_PGSL_TABLE'] ?? 'relay_pgsl_published';

const ROOT = new TextEncoder().encode('iep\x00engagement\x00');

/**
 * Refuse to write a record larger than this.
 *
 * The engine's own bounds permit 1,000 turns of 128 parts, and a part carries
 * caller-supplied text — so one engagement can serialize to something no row should hold.
 * Refusing is the honest failure: the write fails, the mutation is rolled back, and the
 * caller is told. Silently skipping the write for oversized records would leave exactly
 * the class of id that resolves until the next restart, which is what this module exists
 * to eliminate.
 */
const MAX_RECORD_BYTES = Number.parseInt(process.env['RELAY_ENGAGEMENT_MAX_BYTES'] ?? '', 10) || 1_048_576;

/**
 * Ids longer than this were not minted here and cannot be in the store, so they are
 * answered without a query. Caller-supplied path segments reach `warm()`, and an
 * unbounded key handed to Postgres on every request is free work for anyone who wants it.
 *
 * ★ ENFORCED ON BOTH SIDES. It used to bound `get` only, so an over-long id would have
 * been written and then read back as `null` forever after — the write "succeeds", the
 * resolver 404s, and `warm` forgets the record on the next read. Unreachable with today's
 * `<base>/engagements/<t36>-<seq36>` ids, but a one-sided bound is the asymmetry that
 * turns a future long id into silent, permanent loss.
 */
const MAX_ID_BYTES = 512;

/** A store that could not answer. NEVER convertible to "no such engagement". */
export class StoreFault extends Error {
  constructor(message: string) { super(message); this.name = 'StoreFault'; }
}

/**
 * The stored row moved on from the version this write was based on, so the write was
 * refused rather than allowed to overwrite it.
 *
 * Distinct from `StoreFault` because the facts differ and only one of them is the store's
 * problem: a fault means the store could not answer, this means it answered and the
 * answer was "somebody else got there first". Callers that retry should retry only this
 * one, and only after re-reading.
 */
export class ConcurrentModification extends Error {
  constructor(message: string) { super(message); this.name = 'ConcurrentModification'; }
}

/**
 * What reconciling one id against the store established.
 *
 * ★ THREE OUTCOMES, BECAUSE TWO WAS A DATA-LOSS BUG. Collapsing `unwritten` into `absent`
 * is what let a concurrent reader delete an engagement whose durable write had not been
 * reached yet (module header). A reader must be able to decline to answer for a record
 * without destroying it.
 */
export type WarmVerdict =
  /** The engine's view now matches the store's — or no store is configured, where the
   *  working set IS the system of record and there is nothing to disagree with. */
  | 'reconciled'
  /** The store definitively does not have it. The local copy, if any, has been dropped. */
  | 'absent'
  /** This process opened it and has not written it yet. It is KEPT for the handler that
   *  owns it, and no read may answer for it. */
  | 'unwritten';

/** A stored record together with the opaque version it was read at. */
export interface StoredEngagement {
  record: Engagement;
  /** Opaque. Feed it back to `put` as `expected`; never parse it. */
  version: string;
}

export interface EngagementRecordStore {
  /** The record and its version, or null if the store definitively does not have it.
   *  Throws StoreFault when it could not tell — the one answer that must never be
   *  flattened into null. */
  get(id: string): Promise<StoredEngagement | null>;
  /**
   * Durably record the engagement as it now stands, ONLY IF the stored row is still at
   * `expected` — the version this mutation was based on, or `null` to require that no row
   * exists yet. Returns the new version. Throws `ConcurrentModification` if the row moved,
   * and throws on any other failure.
   */
  put(engagement: Engagement, expected: string | null): Promise<string>;
}

// ── codec ────────────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function recordKey(id: string): Uint8Array {
  const idBytes = utf8.encode(id);
  const key = new Uint8Array(ROOT.length + idBytes.length);
  key.set(ROOT, 0);
  key.set(idBytes, ROOT.length);
  return key;
}

/**
 * The compare-and-swap token: a digest of the EXACT stored bytes.
 *
 * Derived from bytes rather than from a re-serialisation of the decoded record, because
 * `JSON.stringify(JSON.parse(b))` is not guaranteed to reproduce `b` — a caller-supplied
 * `data` part may carry integer-like keys, which V8 re-orders. A version that sometimes
 * fails to match itself would refuse legitimate writes, which is a different way to lose
 * the caller's turn.
 */
function versionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const STATES: ReadonlySet<string> = new Set<EngagementState>([
  'submitted', 'working', 'input-required', 'completed', 'failed', 'cancelled', 'rejected',
]);

/**
 * Parse a stored row back into a record, or throw.
 *
 * ★ A ROW THAT DOES NOT PARSE IS A FAULT, NOT AN ABSENCE. Returning null for a corrupt
 * row would make it indistinguishable from "never existed", which is the single outcome
 * this design must never produce.
 *
 * ★ THE `id` IS CHECKED AGAINST THE KEY IT WAS FOUND UNDER. The key is derived from the
 * id and the value repeats it, so a mismatch means the row did not come from this writer.
 * Without the check, anything able to write that table could plant a record at id A whose
 * body names a different owner, and the owner-scoped read would then hand engagement
 * contents to whoever the planted `openedBy` names. The state is validated for the same
 * reason: the engine's transition table is defined over exactly this set, and a value
 * outside it would index `LEGAL` to `undefined` and throw somewhere far from here.
 */
function decodeRecord(bytes: Uint8Array, expectedId: string): Engagement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8.decode(bytes));
  } catch (e) {
    throw new StoreFault(`engagement row is not valid JSON: ${(e as Error).message}`);
  }
  const r = parsed as Partial<Engagement>;
  if (!r || typeof r !== 'object') throw new StoreFault('engagement row is not an object');
  if (r.id !== expectedId) throw new StoreFault('engagement row id does not match its key');
  if (typeof r.openedBy !== 'string' || !r.openedBy) throw new StoreFault('engagement row has no owner');
  if (typeof r.state !== 'string' || !STATES.has(r.state)) throw new StoreFault('engagement row has an unknown state');
  if (!Array.isArray(r.turns)) throw new StoreFault('engagement row has no turns');
  return r as Engagement;
}

function encodeRecord(e: Engagement): Uint8Array {
  const bytes = utf8.encode(JSON.stringify(e));
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new Error(
      `engagement is ${bytes.length} bytes, over the ${MAX_RECORD_BYTES}-byte durable record limit; `
      + 'it cannot be kept and will not be pretended kept',
    );
  }
  return bytes;
}

// ── the store, over any FdbLike ──────────────────────────────────────────────

/**
 * Build the store over a transactional key/value seam.
 *
 * Exported separately from the Postgres wiring so the tests exercise THIS code — the real
 * codec, the real key derivation, the real owner guard, the real compare-and-swap — over
 * `InMemoryFdb`, rather than a hand-written double that would only prove the double works.
 */
export function engagementStoreOverFdb(fdb: FdbLike): EngagementRecordStore {
  return {
    async get(id: string): Promise<StoredEngagement | null> {
      if (utf8.encode(id).length > MAX_ID_BYTES) return null;
      const key = recordKey(id);
      const bytes = await fdb.transact(async txn => txn.get(key));
      if (bytes === undefined) return null;
      return { record: decodeRecord(bytes, id), version: versionOf(bytes) };
    },

    async put(engagement: Engagement, expected: string | null): Promise<string> {
      // Refused here rather than at the key, so an id we could never read back is never
      // written — see MAX_ID_BYTES.
      if (utf8.encode(engagement.id).length > MAX_ID_BYTES) {
        throw new Error(
          `engagement id is over the ${MAX_ID_BYTES}-byte limit; it could not be read back and will not be written`,
        );
      }
      const bytes = encodeRecord(engagement);
      const next = versionOf(bytes);
      const key = recordKey(engagement.id);
      await fdb.transact(async txn => {
        const prev = await txn.get(key);
        // ★ ONE PRINCIPAL'S WRITE MUST NOT LAND ON ANOTHER PRINCIPAL'S ID.
        //
        // `mintId` is `<millis in base36>-<seq in base36>` and `seq` restarts at 0 with
        // the process. In memory a repeat was a curiosity; against a durable store it
        // would OVERWRITE a stranger's record, so their id would resolve to our engagement
        // and their owner-scoped read would return someone else's contents.
        //
        // Checked BEFORE and INDEPENDENTLY OF the version comparison, not folded into its
        // failure branch. Folded in, the guard would only run when the compare-and-swap
        // ALREADY refused the write — so a caller presenting the correct current version
        // would sail past it, and the store's own invariant would hold only for callers
        // who were wrong about something else. It is also the more informative refusal:
        // "somebody else got there first" and "that id belongs to another principal" call
        // for very different responses from an operator.
        if (prev !== undefined) {
          const existing = decodeRecord(prev, engagement.id);
          if (existing.openedBy !== engagement.openedBy) {
            throw new Error('refusing to overwrite an engagement owned by a different principal');
          }
        }
        const prevVersion = prev === undefined ? null : versionOf(prev);
        if (prevVersion !== expected) {
          throw new ConcurrentModification(
            prev === undefined
              ? 'the engagement this mutation was based on is no longer in the store'
              : 'the engagement changed since it was read; this mutation was not applied',
          );
        }
        txn.set(key, bytes);
      });
      return next;
    },
  };
}

// ── the env-configured default ───────────────────────────────────────────────

let _store: EngagementRecordStore | null = null;
let _fdb: Promise<FdbLike> | null = null;

/**
 * Is durable storage configured?
 *
 * ★ `RELAY_PGSL_IN_MEMORY=1` is deliberately NOT honoured here, unlike in
 * pgsl-node-store. There it selects a fake backend for a store whose absence is reported
 * as 503; here it would produce a store that is exactly as volatile as having no store at
 * all while every log line, and this module's whole contract, claimed durability. The
 * brief was explicit: a deployment without Postgres must keep working, but it must not
 * silently believe it is durable. An in-memory "durable" store is that belief.
 *
 * CONFIGURED IS NOT CONNECTED. This answers only that a connection string is set; the
 * connection is opened lazily on first use (below), so a wrong or unreachable one is
 * discovered per request, not here. Callers that log a mode must say "configured", not
 * "working" — a claim of durability over a database that never answers is the same lie in
 * a different place.
 */
export function isConfigured(): boolean {
  return CONNSTR.length > 0;
}

/**
 * The env-configured store, or null when none is configured.
 *
 * Returns synchronously and connects lazily on first use, so an unreachable database
 * delays and fails REQUESTS rather than boot — the relay serves everything else while
 * the interop surface reports a fault, instead of the whole process refusing to start
 * because one dependency is slow to come up.
 */
export function defaultEngagementStore(): EngagementRecordStore | null {
  if (!isConfigured()) return null;
  const open = async (): Promise<FdbLike> => {
    if (!_fdb) {
      // ensureSchema:false — the runtime role has no DDL rights by design; the table is
      // created once by `bootstrapDurableStore` as the admin. Leaving the default (true)
      // makes every boot attempt CREATE TABLE and fail "permission denied for schema
      // public" — the tight grant working correctly.
      _fdb = openPgStore({ connectionString: CONNSTR, table: TABLE, ensureSchema: false })
        .catch((e: unknown) => {
          // Forget the rejected promise so the NEXT request tries again. A remembered
          // failure would make one unlucky moment during a database restart permanent for
          // the life of the process — the relay would keep answering faults long after
          // the database came back, and only a redeploy would clear it.
          _fdb = null;
          throw new StoreFault(`engagement store unavailable: ${(e as Error).message}`);
        });
    }
    return _fdb;
  };
  if (!_store) {
    _store = {
      get: async (id) => engagementStoreOverFdb(await open()).get(id),
      put: async (e, expected) => engagementStoreOverFdb(await open()).put(e, expected),
    };
  }
  return _store;
}

// ── the facade the mount uses ────────────────────────────────────────────────

/**
 * Binds a synchronous engine to a durable store: warm before a read, persist after a
 * mutation.
 *
 * Every operation is a no-op when no store is configured, so an unconfigured deployment
 * takes exactly today's code path — same engine, same bounds, same eviction tombstones,
 * no added latency and no added failure mode. That includes `abandon`: with no store the
 * Map IS the system of record, so there is no subset rule to restore and dropping a
 * record would be plain data loss.
 */
export class DurableEngagements {
  /**
   * The version each in-heap record was read at, keyed by the record OBJECT.
   *
   * A WeakMap rather than a `Map<id, version>` on purpose. A keyed map of caller-reachable
   * ids is the unbounded-state class this codebase keeps finding, and bounding it would be
   * worse than not having it: a bound that evicted a version would make the next legitimate
   * write look like a fresh `open`, and it would be REFUSED. Keying on the object ties the
   * entry's lifetime to the record's — outside an in-flight request the engine's working
   * set holds the only strong reference, so entries become collectable when the record
   * leaves it, with no eviction policy to get wrong.
   *
   * It works because the engine mutates records IN PLACE: the object `warm` admitted is
   * the object `appendTurn` grows and `persist` is handed.
   */
  private readonly readAt = new WeakMap<Engagement, string>();

  /**
   * One write at a time per engagement id, within this process.
   *
   * `warm` admits a freshly decoded object on every read, so two concurrent handlers on
   * one id can hold different object identities and therefore different compare-and-swap
   * baselines — a hazard that did not exist when the Map was the system of record and both
   * handlers mutated one shared object. Without this gate their read-compare-write windows
   * can overlap inside the store, and under the Postgres adapter's READ COMMITTED
   * isolation an overlap defeats the check (see the module header). Serialising them makes
   * the second write see the first's committed version, so it either applies on top or is
   * refused — never silently discarded.
   *
   * Entries are removed as each write drains, so this holds one entry per IN-FLIGHT write,
   * not one per engagement.
   */
  private readonly writeGate = new Map<string, Promise<unknown>>();

  /**
   * Ids this process has opened (or mutated) and not yet written, with how many in-flight
   * requests are holding each.
   *
   * ★ THIS IS THE DIFFERENCE BETWEEN "THE STORE SAYS NO" AND "THE STORE HAS NOT BEEN TOLD".
   * Without it `warm` had one answer for both, and the answer was `engine.forget` — so any
   * concurrent read (including the owner's own listing) deleted an engagement whose durable
   * write was still an `await` away, and the request that was succeeding answered 404. The
   * module header has the full account.
   *
   * A COUNT rather than a Set because the same id can legitimately be held twice: two
   * concurrent cancels of one already-durable record both mark it before writing. Releasing
   * on the first `finally` would unhold a record the second request is still mid-write on.
   * (A fresh `open` cannot collide — its id is newly minted — but the shape must not depend
   * on that.)
   *
   * Bounded by IN-FLIGHT REQUESTS, not by ids: every hold is released in the mount's
   * `finally`, the same discipline `writeGate` above relies on. Nothing accumulates.
   */
  private readonly unwritten = new Map<string, number>();

  constructor(
    private readonly engine: EngagementEngine,
    private readonly store: EngagementRecordStore | null,
  ) {}

  get enabled(): boolean { return this.store !== null; }

  private async gated<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.writeGate.get(id);
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => { release = r; });
    this.writeGate.set(id, mine);
    // `catch` so one failed write does not wedge the id forever — the next writer runs
    // regardless of how the previous one ended.
    if (prior) await prior.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.writeGate.get(id) === mine) this.writeGate.delete(id);
    }
  }

  /**
   * Declare that this request has a mutation of `id` that the store does not have yet.
   *
   * Held from the moment the record exists in the working set until the write lands
   * (`settle`) or the request gives up on it (`abandon`). While held, `warm` reports the
   * id as `unwritten` instead of forgetting it — see the `unwritten` field.
   *
   * No-op without a store: there the working set IS the system of record, `warm` never
   * forgets anything, and there is nothing to protect the record from.
   */
  hold(id: string): void {
    if (!this.store || !id) return;
    this.unwritten.set(id, (this.unwritten.get(id) ?? 0) + 1);
  }

  /** Release a hold taken by `hold`. The store now answers for this record. */
  settle(id: string): void {
    if (!this.store || !id) return;
    const n = (this.unwritten.get(id) ?? 0) - 1;
    if (n > 0) this.unwritten.set(id, n);
    else this.unwritten.delete(id);
  }

  /**
   * Make the engine's view of `id` agree with the durable store, before any synchronous
   * engine call that reads it.
   *
   * Four outcomes, and the last two are what keep the invariant honest:
   *   - the store HAS it   → admit it, overwriting whatever this heap believed, and report
   *     `reconciled`. The durable copy is the truth, including after a restart emptied the
   *     cache and after the engine's bound evicted the record (a durable record is not
   *     `gone`, and admitting it clears the tombstone that would otherwise say so).
   *   - the store LACKS it, and NO in-flight request is writing it → forget it locally and
   *     report `absent`. Without this, a record that reached the cache without reaching the
   *     store — or one this replica holds and no other can see — would keep answering,
   *     which is the cache lying about the commons.
   *   - the store LACKS it because this process has NOT WRITTEN IT YET → report
   *     `unwritten`, and change nothing. The caller must decline to answer for it; it must
   *     not delete it. Deleting it is precisely the live data loss described in the module
   *     header, reached by the owner's own listing.
   *   - the store FAULTS   → throw. Never null. An unreachable store rendered as
   *     "no such engagement" is indistinguishable to a caller from a definitive answer,
   *     and it is the failure this whole module is arguing against.
   *
   * ★ THE HOLD IS CONSULTED ONLY AFTER THE STORE HAS ANSWERED, never instead of it. A held
   * id whose row DOES exist (a cancel being written over a durable record) still reconciles
   * against the store, so an in-flight mutation cannot hide a record that is really there.
   */
  async warm(id: string): Promise<WarmVerdict> {
    const store = this.store;
    if (!store || !id) return 'reconciled';
    let hit: StoredEngagement | null;
    try {
      hit = await store.get(id);
    } catch (e) {
      if (e instanceof StoreFault) throw e;
      throw new StoreFault(`engagement store read failed: ${(e as Error).message}`);
    }
    if (hit) {
      // Remembered BEFORE the record is reachable from the engine, so no mutation can be
      // persisted without the baseline it must compare against.
      this.readAt.set(hit.record, hit.version);
      this.engine.admit(hit.record);
      return 'reconciled';
    }
    if (this.unwritten.has(id)) return 'unwritten';
    this.engine.forget(id);
    return 'absent';
  }

  /**
   * Reconcile a page of listed records against the store, and return what survives.
   *
   * ★ THIS IS THE READ `list` DID NOT DO. The listing answered straight from the Map: it
   * returned ids the sibling resolver 404'd, and rendered a state — with its cancel
   * affordance — that another replica had already moved past. The module claims a mutable
   * record cannot be served from a cache hit; the listing was the one read exempt from it,
   * for no reason but that nobody had wired it.
   *
   * The page is the engine's own bounded result (≤200 by its clamp), so this is at most
   * one point read per listed record, and the caller is a verified owner reading their own
   * records.
   *
   * ★ THIS RE-READS IN PAGE ORDER, AND THAT IS NO LONGER WHAT PRESERVES THE ORDER. The
   * paragraph here used to say it was: `admit` re-inserts at the tail, so warming a page
   * reorders the map, so re-listing would come back in warming order. True as far as it
   * went — and useless, because it only protected the CURRENT response. The map had still
   * been reordered, so the NEXT `engine.list` came back reversed, and successive identical
   * listings alternated newest-first / oldest-first. The ordering now comes from `list`
   * itself, which sorts by creation time rather than trusting map order; re-reading in page
   * order just means this function does not have to re-derive the page.
   *
   * A short page is a real outcome — records the store no longer has are dropped, not
   * back-filled. Back-filling would need the per-owner index the header explains is not
   * worth its failure modes. A record this process has opened and not yet written is
   * dropped from the page TOO, and for a different reason: nothing outside this request may
   * answer for it, but it is still going to be written, so it must survive being listed.
   */
  async reconcile(page: ReadonlyArray<Engagement>, caller: string): Promise<Engagement[]> {
    if (!this.store) return [...page];
    const answerable: string[] = [];
    for (const e of page) {
      if (await this.warm(e.id) === 'reconciled') answerable.push(e.id);
    }
    const fresh: Engagement[] = [];
    for (const id of answerable) {
      const r = this.engine.get(id, caller);
      if (!isEngineError(r)) fresh.push(r.value);
    }
    return fresh;
  }

  /**
   * Durably record a mutation, BEFORE its result is sent.
   *
   * The write is a compare-and-swap against the version `warm` last saw for this record,
   * or against "no row yet" for one this process just opened. On failure — a fault, or a
   * conflict — the record is removed from the cache and the error propagates, so the
   * handler answers an error instead of a 200 describing a record only this process has.
   * Dropping the cache entry is not data loss: the store still holds the previous durable
   * version, and the next `warm` restores it. What is lost is the unpersisted mutation —
   * which is the correct thing to lose, because nobody was told it happened.
   *
   * ★ A MISSING BASELINE MEANS "expect no row", and that is fail-closed on purpose. The
   * only records reaching here without one are freshly minted opens; every other mutating
   * path in the mount warms first. If a future path forgets to, its write is REFUSED as a
   * collision rather than silently overwriting whatever is there.
   */
  async persist(engagement: Engagement): Promise<void> {
    const store = this.store;
    if (!store) return;
    await this.gated(engagement.id, async () => {
      const expected = this.readAt.get(engagement) ?? null;
      let version: string;
      try {
        version = await store.put(engagement, expected);
      } catch (e) {
        this.engine.forget(engagement.id);
        if (e instanceof ConcurrentModification) throw e;
        throw new StoreFault(`engagement store write failed: ${(e as Error).message}`);
      }
      // The record is now at the version we just wrote, so a second mutation of the SAME
      // object in this process compares against what is actually stored. Without this a
      // handler that persists twice would offer a stale baseline and be refused its own
      // second write.
      this.readAt.set(engagement, version);
    });
  }

  /**
   * Drop a record whose mutation is NOT going to be persisted.
   *
   * ★ THE EXIT THAT WAS MISSING. `open` inserts before any durable write, and the mount
   * had three error exits between there and the write that simply returned — a capability
   * whose output blows the parts cap is the reachable one. The response was a 400 and the
   * record stayed in the working set with nothing behind it, so `list` reported an id the
   * resolver denied. The mount now routes every non-persisting exit through here.
   *
   * ★ IT ALSO RELEASES THE HOLD. `hold` and `abandon`/`settle` are one pair: a request that
   * gave up on a record but left it marked unwritten would make `warm` keep answering
   * `unwritten` for an id nothing is ever going to write, so every later read of it would
   * decline instead of saying `absent`. Releasing here is what keeps the hold set bounded by
   * in-flight requests rather than by ids.
   *
   * No-op without a store, where the Map is the system of record and dropping the record
   * would lose it rather than restore an invariant.
   */
  abandon(id: string): void {
    if (!this.store) return;
    this.settle(id);
    this.engine.forget(id);
  }
}
