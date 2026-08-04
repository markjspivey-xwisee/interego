/**
 * Engagement ids keep resolving across a restart — and never resolve to something the
 * durable store does not have.
 *
 * The relay mints `<base>/engagements/<id>` and the substrate's standing rule is that an
 * identifier resolves. It did not: the engine's records lived in a process-local Map, so
 * a Railway rolling deploy retired every id it had ever handed out, and the bound retired
 * some sooner than that. This pins the fix and, just as importantly, pins the ways the
 * fix could be FAKED — a cache that answers for records the store never took, a write
 * failure that returns 200 anyway, a store outage rendered as "no such engagement".
 *
 * Everything here runs the REAL mount and the REAL store codec. The Postgres adapter is
 * swapped for `InMemoryFdb` at the `FdbLike` seam the store is written against, so what
 * is under test is the composition — key derivation, JSON codec, owner guard, transaction
 * shape — and not a double standing in for it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { InMemoryFdb } from '../packages/pgsl-store/src/index.js';
// From the PACKAGE, not from src/: the mount imports the built package, and
// EngagementEngine has private members — so a src-built instance is not assignable to
// the mount's `engine` parameter. Importing the same build the mount uses is what keeps
// this test able to inject one.
import { EngagementEngine, PROFILES } from '@interego/agent-interop';
import type { Engagement, InteropOperation } from '@interego/agent-interop';
import { mountAgentInterop } from '../deploy/mcp-relay/agent-interop-mount.js';
import {
  engagementStoreOverFdb, DurableEngagements, StoreFault, ConcurrentModification,
  type EngagementRecordStore, type StoredEngagement,
} from '../deploy/mcp-relay/engagement-store.js';

const BASE = 'https://relay.test';
const ALICE = 'did:ethr:0xalice';
const BOB = 'did:ethr:0xbob';

// ── a minimal Express double, same shape the relay's own mount test uses ─────

// ★ THE DOUBLE IS DESCRIBED BY TYPES NOW, NOT BY `any`.
//
// Every one of the nine `any`s in this file was in the fake Express, and a double built
// out of `any` is the one place they cost the most: the double is a MODEL of the real
// surface, and nothing was checking the model against anything. A handler could read
// `req.paramz`, or `mkRes()` could stop returning itself from `.status()`, and the tests
// would keep passing over a res object that no longer chains — silently asserting on a
// `statusCode` that never got set. These interfaces are the model, written down.
interface FakeReq {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  params: Record<string, string>;
}
interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
  send(b: unknown): FakeRes;
  type(): FakeRes;
  setHeader(k: string, v: string): void;
  end(): FakeRes;
}
type Handler = (req: FakeReq, res: FakeRes) => unknown;
interface Route { method: string; path: string | RegExp; handler: Handler }

function mkRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200, body: undefined, headers: {},
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    send(b: unknown) { r.body = b; return r; },
    type() { return r; },
    setHeader(k: string, v: string) { r.headers[k.toLowerCase()] = v; },
    end() { return r; },
  };
  return r;
}

/** `res.body` is `unknown`; read a member off it without reintroducing a cast per site. */
function bodyMember(body: unknown, key: string): unknown {
  return body != null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
}

/** One mounted relay "process". A second one over the same store IS the restart. */
function boot(
  store: EngagementRecordStore | null,
  opts: {
    engine?: EngagementEngine;
    /** Supplied where a test needs the mount to actually PERFORM a capability — the path
     *  that carries the post-open error exits. */
    invokeCapability?: (args: { capability: string; caller: string; parts: readonly unknown[] }) => Promise<unknown>;
  } = {},
) {
  const routes: Route[] = [];
  const app = {
    get: (p: string | RegExp, h: Handler) => routes.push({ method: 'GET', path: p, handler: h }),
    post: (p: string | RegExp, h: Handler) => routes.push({ method: 'POST', path: p, handler: h }),
    delete: (p: string | RegExp, h: Handler) => routes.push({ method: 'DELETE', path: p, handler: h }),
  };
  const engine = opts.engine ?? new EngagementEngine(BASE);
  const logs: string[] = [];
  let caller: string | undefined = ALICE;

  // The one remaining cast, and it is narrow on purpose: `mountAgentInterop` takes an
  // `Express`, which a three-method literal cannot structurally satisfy. Everything the
  // mount actually touches — get/post/delete and the req/res shapes above — IS typed, so
  // this cast admits only the methods the double deliberately does not implement.
  mountAgentInterop(app as unknown as Parameters<typeof mountAgentInterop>[0], {
    publicBase: BASE,
    engine,
    engagementStore: store,
    agent: { id: `${BASE}/.well-known/operations`, name: 'Test Relay', description: 'test' },
    affordances: () => [],
    verifyCaller: async () => caller,
    log: (m) => logs.push(m),
    ...(opts.invokeCapability ? { invokeCapability: opts.invokeCapability as never } : {}),
  });

  const profile = Object.values(PROFILES)[0]!;
  const mountBase = `/${profile.slug}/v1`;
  const pathFor = (op: InteropOperation): string =>
    mountBase + profile.wire.find(w => w.operation === op)!.path;

  // A string route's `:param` segments are wildcards; a custom-method route compiled to
  // a RegExp exposes its capture as params[0], which is what the mount reads.
  const matches = (p: string | RegExp, url: string): boolean => {
    if (p instanceof RegExp) return p.test(url);
    const re = p.split('/').map(seg => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return new RegExp(`^${re}$`).test(url);
  };

  const dispatch = async (method: string, url: string, body?: unknown, params?: Record<string, string>) => {
    const chosen = routes.find(r => r.method === method && matches(r.path, url));
    if (!chosen) throw new Error(`no route for ${method} ${url}`);
    // Annotated so the two branches unify: express exposes a RegExp route's capture as
    // the numeric key `'0'`, and the untyped literal narrowed to `{0: string}|{}`, which
    // is not a `Record<string, string>`. The mount reads `params['0']`.
    const captured: Record<string, string> = chosen.path instanceof RegExp
      ? { 0: (chosen.path.exec(url) ?? [])[1] ?? '' }
      : {};
    const res = mkRes();
    await chosen.handler(
      { method, url, headers: {}, query: {}, body, params: { ...captured, ...(params ?? {}) } },
      res,
    );
    return res;
  };

  return { engine, logs, dispatch, pathFor, profile, setCaller: (c: string | undefined) => { caller = c; } };
}

/** Open an engagement through the real wire route and return its minted id. */
async function open(relay: ReturnType<typeof boot>, text = 'hello', capability?: string) {
  const payload: Record<string, unknown> = { parts: [{ text }] };
  // `skillId` is the member the mount reads a requested capability from; naming it here
  // is what routes the request through invokeCapability and its post-open exits.
  if (capability) payload['skillId'] = capability;
  const body = relay.profile.requestEnvelope ? { [relay.profile.requestEnvelope]: payload } : payload;
  const res = await relay.dispatch('POST', relay.pathFor('sendMessage'), body);
  return res;
}

/** The owner-scoped listing, through the real wire route, as rendered ids. */
async function listIds(relay: ReturnType<typeof boot>): Promise<string[]> {
  const res = await relay.dispatch('GET', relay.pathFor('listEngagements'));
  const member = relay.profile.responseEnvelope?.listEngagements ?? 'items';
  const items = (bodyMember(res.body, member) ?? []) as Array<{ id?: string }>;
  return items.map(x => String(x.id ?? ''));
}

/** Read an id back through the protocol-neutral resolver route — where a peer that
 *  followed the id it was handed actually arrives. */
async function resolve(relay: ReturnType<typeof boot>, id: string) {
  const tail = id.slice(`${BASE}/engagements/`.length);
  return relay.dispatch('GET', `/engagements/${tail}`, undefined, { id: tail });
}

function idOf(res: FakeRes): string {
  const body = bodyMember(res.body, 'result') ?? res.body;
  const inner = bodyMember(body, 'id')
    ?? bodyMember(bodyMember(body, 'task'), 'id')
    ?? bodyMember(bodyMember(body, 'engagement'), 'id');
  return String(inner ?? '');
}

// ── a store double whose FAILURES are the point ──────────────────────────────

class FaultyStore implements EngagementRecordStore {
  readonly rows = new Map<string, string>();
  failReads: string | null = null;
  failWrites: string | null = null;
  /** Version a row exactly the way the real store does — over the stored bytes — so a
   *  test that hands this double to the facade exercises the same compare-and-swap
   *  contract, not a laxer one. */
  private v(text: string): string { return createHash('sha256').update(text).digest('hex'); }
  async get(id: string): Promise<StoredEngagement | null> {
    if (this.failReads) throw new StoreFault(this.failReads);
    const t = this.rows.get(id);
    return t ? { record: JSON.parse(t) as Engagement, version: this.v(t) } : null;
  }
  async put(e: Engagement, expected: string | null): Promise<string> {
    if (this.failWrites) throw new Error(this.failWrites);
    const cur = this.rows.get(e.id);
    const curVersion = cur === undefined ? null : this.v(cur);
    if (curVersion !== expected) {
      throw new ConcurrentModification('the engagement changed since it was read');
    }
    const text = JSON.stringify(e);
    this.rows.set(e.id, text);
    return this.v(text);
  }
}

describe('the store, over the real key/value seam', () => {
  let fdb: InMemoryFdb;
  let store: EngagementRecordStore;
  const record = (over: Partial<Engagement> = {}): Engagement => ({
    id: `${BASE}/engagements/abc-0`,
    state: 'submitted',
    openedBy: ALICE,
    turns: [{ id: `${BASE}/engagements/abc-0/turns/0`, role: 'requester', parts: [{ kind: 'text', text: 'hi' }], at: '2026-01-01T00:00:00.000Z' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  beforeEach(() => { fdb = new InMemoryFdb(); store = engagementStoreOverFdb(fdb); });

  it('round-trips a record and answers null — not a throw — for one it does not have', async () => {
    // `null` is "there must be no row yet" — the compare-and-swap baseline a freshly
    // opened engagement carries.
    const version = await store.put(record(), null);
    const hit = await store.get(`${BASE}/engagements/abc-0`);
    expect(hit?.record.openedBy).toBe(ALICE);
    expect(hit?.version).toBe(version);
    expect(await store.get(`${BASE}/engagements/nope-0`)).toBeNull();
  });

  it('refuses to let one principal overwrite another principal\'s id', async () => {
    const version = await store.put(record(), null);
    // The id is `<millis>-<seq>` and `seq` restarts with the process, so a collision is
    // improbable and catastrophic: without the guard Bob's write lands on Alice's id and
    // her owner-scoped read returns his engagement. Bob arrives as a fresh open, so his
    // baseline is `null` and the version check refuses him — but the refusal names the
    // owner collision rather than a generic conflict, because the two call for very
    // different responses.
    await expect(store.put(record({ openedBy: BOB }), null)).rejects.toThrow(/different principal/i);
    // Even holding Alice's current version, Bob cannot land on her id.
    await expect(store.put(record({ openedBy: BOB }), version)).rejects.toThrow(/different principal/i);
    expect((await store.get(`${BASE}/engagements/abc-0`))?.record.openedBy).toBe(ALICE);
  });

  it('treats a tampered row as a FAULT, never as an absence', async () => {
    await store.put(record(), null);
    // Plant a body claiming a different id under the same key — what anything else with
    // write access to that table could do. Answering null here would let a planted row
    // read as "never existed"; answering the row would hand a stranger's engagement to
    // whoever the planted owner names.
    const planted = new TextEncoder().encode(JSON.stringify(record({ id: `${BASE}/engagements/other-9`, openedBy: BOB })));
    await fdb.transact(async (txn) => {
      const all = await txn.getRange(Uint8Array.of(0), Uint8Array.of(0xff));
      txn.set(all[0]!.key, planted);
    });
    await expect(store.get(`${BASE}/engagements/abc-0`)).rejects.toThrow(StoreFault);
  });

  it('refuses a record too large to keep rather than skipping the write', async () => {
    const huge = record({ turns: [{ id: 'x', role: 'requester', parts: [{ kind: 'text', text: 'x'.repeat(2_000_000) }], at: '2026-01-01T00:00:00.000Z' }] });
    await expect(store.put(huge, null)).rejects.toThrow(/durable record limit/i);
  });

  it('refuses an id it could never read back, rather than writing one that reads as absent', async () => {
    // The length bound used to guard `get` alone, so an over-long id would have been
    // written and then answered `null` for ever after: the write "succeeds", the resolver
    // 404s, and the next `warm` forgets the record. Unreachable with today's minted ids —
    // which is exactly why a one-sided bound survives until something changes them.
    const longId = `${BASE}/engagements/${'x'.repeat(600)}`;
    await expect(store.put(record({ id: longId }), null)).rejects.toThrow(/could not be read back/i);
    expect(await store.get(longId)).toBeNull();
  });
});

describe('the engine\'s durable-store seam', () => {
  it('admit retires the eviction tombstone, because a restored record is not gone', () => {
    // maxEngagements:1 makes the second open evict the first, which is what leaves the
    // tombstone that `get` renders as `gone`.
    const engine = new EngagementEngine(BASE, { maxEngagements: 1 });
    const first = engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }] });
    expect(first.ok).toBe(true);
    const id = (first as { value: Engagement }).value.id;
    engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'b' }] });

    const evicted = engine.get(id, ALICE);
    expect(evicted.ok).toBe(false);
    expect((evicted as { error: { kind: string } }).error.kind).toBe('gone');

    engine.admit((first as { value: Engagement }).value);
    const back = engine.get(id, ALICE);
    expect(back.ok).toBe(true);
  });

  it('forget leaves no tombstone — an unpersisted record was never real', () => {
    const engine = new EngagementEngine(BASE);
    const opened = engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }] });
    const id = (opened as { value: Engagement }).value.id;
    engine.forget(id);
    const gone = engine.get(id, ALICE);
    expect((gone as { error: { kind: string } }).error.kind).toBe('notFound');
  });

  it('forget RETIRES a tombstone already standing, so the 410 never states a false cause', () => {
    // The test above only ever passed because it never created a tombstone. `forget`
    // deleted from the engagements map alone, so a record the bound had already evicted
    // kept its marker — and the very next owner-scoped read answered `gone`, rendered by
    // the resolver as 410 "dropped … to stay within the retention bound. Raise
    // maxEngagements". Every caller of `forget` calls it because a durable write FAILED or
    // because the store says the record is absent. Neither is a retention limit, and
    // raising maxEngagements fixes neither.
    const engine = new EngagementEngine(BASE, { maxEngagements: 1 });
    const first = engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }] });
    const id = (first as { value: Engagement }).value.id;
    engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'b' }] });
    expect((engine.get(id, ALICE) as { error: { kind: string } }).error.kind).toBe('gone');

    engine.forget(id);
    const after = engine.get(id, ALICE);
    expect((after as { error: { kind: string } }).error.kind).toBe('notFound');
    expect(JSON.stringify(after)).not.toMatch(/maxEngagements|retention bound/);
  });
});

describe('a concurrent mutation cannot silently discard an acknowledged one', () => {
  it('refuses the losing write instead of dropping the winner\'s turn', async () => {
    // Two replicas over one store, which is what a rolling deploy or a scaled service is.
    const store = engagementStoreOverFdb(new InMemoryFdb());
    const one = new EngagementEngine(BASE);
    const two = new EngagementEngine(BASE);
    const d1 = new DurableEngagements(one, store);
    const d2 = new DurableEngagements(two, store);

    const opened = one.open({ caller: ALICE, parts: [{ kind: 'text', text: 'first' }] });
    const id = (opened as { value: Engagement }).value.id;
    await d1.persist((opened as { value: Engagement }).value);

    // Both read the same version — the read-modify-write window.
    await d1.warm(id);
    await d2.warm(id);
    const a = one.appendTurn({ id, caller: ALICE, role: 'requester', parts: [{ kind: 'text', text: 'A' }] });
    const b = two.appendTurn({ id, caller: ALICE, role: 'requester', parts: [{ kind: 'text', text: 'B' }] });

    await d1.persist((a as { value: Engagement }).value);
    // Unguarded, this returned normally: turn A disappeared from the store, and the caller
    // who sent it had already been answered 200 with A in the response body. The same
    // lost-update class the relay had just removed from publish_context.
    await expect(d2.persist((b as { value: Engagement }).value)).rejects.toThrow(ConcurrentModification);

    const stored = await store.get(id);
    const texts = stored!.record.turns.flatMap(t => t.parts.map(p => (p as { text?: string }).text));
    expect(texts).toEqual(['first', 'A']);
    // The refused replica is left holding nothing the store does not have.
    expect(two.size()).toBe(0);
  });

  it('refuses an open whose minted id is already in the store, whoever owns it', async () => {
    // `mintId` is `<millis>-<seq>` and `seq` restarts with the process, so two opens in one
    // millisecond either side of a restart collide. A fresh open compares against "no row
    // yet", so the collision is refused rather than overwriting the record that is there.
    const store = engagementStoreOverFdb(new InMemoryFdb());
    const engine = new EngagementEngine(BASE);
    const durable = new DurableEngagements(engine, store);
    const first = engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }], now: 1_700_000_000_000 });
    await durable.persist((first as { value: Engagement }).value);

    const restarted = new EngagementEngine(BASE);
    const d2 = new DurableEngagements(restarted, store);
    const collided = restarted.open({ caller: ALICE, parts: [{ kind: 'text', text: 'b' }], now: 1_700_000_000_000 });
    expect((collided as { value: Engagement }).value.id).toBe((first as { value: Engagement }).value.id);
    await expect(d2.persist((collided as { value: Engagement }).value)).rejects.toThrow(ConcurrentModification);

    const stored = await store.get((first as { value: Engagement }).value.id);
    expect(stored!.record.turns[0]!.parts[0]).toMatchObject({ text: 'a' });
  });

  it('serialises writes to one id inside a process, so their windows cannot overlap', async () => {
    // `warm` admits a freshly decoded object on every read, so two in-flight handlers on
    // one id hold different objects and different compare-and-swap baselines. If their
    // store round trips overlap, the Postgres adapter's READ COMMITTED isolation lets both
    // pass the check and one write still wins — the residual the module header names. The
    // gate is what keeps that from being reachable within a single process.
    const inner = engagementStoreOverFdb(new InMemoryFdb());
    let inside = 0;
    let mostAtOnce = 0;
    const slow: EngagementRecordStore = {
      get: (id) => inner.get(id),
      async put(e, expected) {
        inside++;
        mostAtOnce = Math.max(mostAtOnce, inside);
        try {
          await new Promise(r => setTimeout(r, 5));
          return await inner.put(e, expected);
        } finally { inside--; }
      },
    };
    const engine = new EngagementEngine(BASE);
    const durable = new DurableEngagements(engine, slow);
    const opened = engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }] });
    const record = (opened as { value: Engagement }).value;
    await durable.persist(record);

    const both = await Promise.allSettled([durable.persist(record), durable.persist(record)]);
    expect(mostAtOnce).toBe(1);
    // Serialised, the second write compares against what the first actually committed, so
    // it applies rather than being refused or silently discarded.
    expect(both.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});

describe('the listing is a read, and goes to the store like every other read', () => {
  it('drops an id the store no longer has, rather than handing out one the resolver denies', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay));
    expect(await listIds(relay)).toContain(id);

    // Whatever the cause — another replica, an operator, a bug — the store is the commons.
    // The listing used to answer straight from the working set, so it kept offering this id
    // while the sibling resolver 404'd it: one surface handing out what the other denies.
    store.rows.delete(id);
    // Listed BEFORE the resolver is touched, on purpose. A resolve warms the id and
    // evicts it, so checking the listing afterwards would pass on the strength of the
    // OTHER read's reconciliation and prove nothing about this one.
    expect(await listIds(relay)).not.toContain(id);
    expect((await resolve(relay, id)).statusCode).toBe(404);
  });

  it('renders the state the store holds, not one another replica has already moved past', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay));

    // A second replica completes the work.
    const elsewhere = JSON.parse(store.rows.get(id)!) as Engagement;
    elsewhere.state = 'completed';
    store.rows.set(id, JSON.stringify(elsewhere));

    const res = await relay.dispatch('GET', relay.pathFor('listEngagements'));
    const rendered = JSON.stringify(res.body);
    // Asserted through the profile's own lifecycle names so this stays spec-blind.
    expect(rendered).toContain(relay.profile.lifecycle.name('completed'));
    expect(rendered).not.toContain(relay.profile.lifecycle.name('submitted'));
    // And nothing offers to cancel a record that is already terminal — the affordance the
    // stale listing was still advertising.
    expect(rendered).not.toMatch(/cancel/i);
  });
});

describe('a request that fails after opening leaves nothing behind', () => {
  it('a capability output over the parts cap leaves the cache as empty as the store', async () => {
    // The reachable one of three post-open exits: `complete` refuses more than
    // maxPartsPerTurn parts in an output, and the handler returned without ever writing —
    // leaving a record in the working set that no store had, which the listing then served
    // and the resolver then denied.
    const store = new FaultyStore();
    const parts = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', text: `p${i}` }));
    const relay = boot(store, { invokeCapability: async () => ({ ok: true, output: { parts } }) });

    const res = await open(relay, 'go', 'some-capability');
    expect(res.statusCode).not.toBe(200);
    expect(store.rows.size).toBe(0);
    expect(relay.engine.size()).toBe(0);
    expect(await listIds(relay)).toEqual([]);
  });

  it('without a store the same failure keeps the record — the Map is the system of record', async () => {
    // `abandon` is a no-op with no store configured, so an unconfigured deployment takes
    // exactly the path it took before: nothing to reconcile against, so dropping the
    // record would be plain loss rather than a restored invariant.
    const parts = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', text: `p${i}` }));
    const relay = boot(null, { invokeCapability: async () => ({ ok: true, output: { parts } }) });
    const res = await open(relay, 'go', 'some-capability');
    expect(res.statusCode).not.toBe(200);
    expect(relay.engine.size()).toBe(1);
  });
});

describe('an engagement id survives a restart', () => {
  it('resolves from a brand new process over the same store', async () => {
    const fdb = new InMemoryFdb();
    const store = engagementStoreOverFdb(fdb);

    const before = boot(store);
    const id = idOf(await open(before, 'work please'));
    expect(id.startsWith(`${BASE}/engagements/`)).toBe(true);
    expect((await resolve(before, id)).statusCode).toBe(200);

    // A rolling deploy: same store, new process, empty engine.
    const after = boot(store);
    expect(after.engine.size()).toBe(0);
    const res = await resolve(after, id);
    expect(res.statusCode).toBe(200);
    expect((res.body as { id: string }).id).toBe(id);
    // And it is still owner-scoped after the restore — durability must not launder the
    // record into something anyone holding the id can read.
    after.setCaller(BOB);
    expect((await resolve(after, id)).statusCode).toBe(404);
  });

  it('accepts a continuation on an id minted by the previous process', async () => {
    const store = engagementStoreOverFdb(new InMemoryFdb());
    const before = boot(store);
    const id = idOf(await open(before, 'first'));

    const after = boot(store);
    const field = after.profile.continuationField!;
    const payload = { parts: [{ text: 'second' }], [field]: id };
    const body = after.profile.requestEnvelope ? { [after.profile.requestEnvelope]: payload } : payload;
    const res = await after.dispatch('POST', after.pathFor('sendMessage'), body);
    expect(res.statusCode).toBe(200);
    // Appended, not forked into a new engagement — the failure a lost record produces.
    expect(idOf(res)).toBe(id);
    const stored = await store.get(id);
    expect(stored?.record.turns.length).toBe(2);
  });

  it('without a store, the same restart loses the id — today\'s behaviour, unchanged', async () => {
    const before = boot(null);
    const id = idOf(await open(before));
    expect((await resolve(before, id)).statusCode).toBe(200);
    expect((await resolve(boot(null), id)).statusCode).toBe(404);
    expect(before.logs.some(l => /IN-MEMORY ONLY/.test(l))).toBe(true);
  });
});

describe('the cache never answers for something the store does not have', () => {
  it('drops a record the store has lost, instead of serving it from the heap', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay));
    expect((await resolve(relay, id)).statusCode).toBe(200);

    // Whatever the cause — another replica's compaction, an operator, a bug — the store
    // is the commons and the heap is not. Serving this would be one process answering for
    // a record no peer can see.
    store.rows.delete(id);
    expect((await resolve(relay, id)).statusCode).toBe(404);
    expect(relay.engine.size()).toBe(0);
  });

  it('serves the store\'s version, not a stale local copy', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay));

    // Stand in for a second replica advancing the record.
    const elsewhere = JSON.parse(store.rows.get(id)!) as Engagement;
    elsewhere.state = 'completed';
    store.rows.set(id, JSON.stringify(elsewhere));

    const res = await resolve(relay, id);
    expect(res.statusCode).toBe(200);
    // The rendered state name is the profile's, so assert through the engine's own view.
    const view = relay.engine.get(id, ALICE);
    expect(view.ok).toBe(true);
    expect(view.ok && view.value.state).toBe('completed');
  });
});

describe('a store write failure does not silently succeed', () => {
  it('answers an error and leaves nothing resolvable', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    store.failWrites = 'disk on fire';

    const res = await open(relay);
    expect(res.statusCode).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/disk on fire/);
    // Nothing was durably written, and nothing is left in the heap to pretend otherwise.
    expect(store.rows.size).toBe(0);
    expect(relay.engine.size()).toBe(0);
  });

  it('rolls a failed mutation back to the last durable version', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay, 'first'));

    store.failWrites = 'transient';
    const field = relay.profile.continuationField!;
    const payload = { parts: [{ text: 'second' }], [field]: id };
    const body = relay.profile.requestEnvelope ? { [relay.profile.requestEnvelope]: payload } : payload;
    expect((await relay.dispatch('POST', relay.pathFor('sendMessage'), body)).statusCode).not.toBe(200);

    // The engagement still resolves — the durable record is intact — and shows exactly
    // the turns that were actually persisted.
    store.failWrites = null;
    const res = await resolve(relay, id);
    expect(res.statusCode).toBe(200);
    expect((await store.get(id))!.record.turns.length).toBe(1);
  });
});

describe('an unreachable store is never rendered as a missing engagement', () => {
  it('answers 503 on the protocol-neutral resolver, not 404', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay));

    store.failReads = 'connection refused';
    const res = await resolve(relay, id);
    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toMatch(/connection refused/);
  });

  it('the facade throws a StoreFault rather than reporting an absence', async () => {
    const store = new FaultyStore();
    const engine = new EngagementEngine(BASE);
    store.failReads = 'connection refused';
    const durable = new DurableEngagements(engine, store);
    await expect(durable.warm(`${BASE}/engagements/x-0`)).rejects.toThrow(StoreFault);
  });
});

describe('a read cannot destroy an engagement that has not been written yet', () => {
  /**
   * ★ THE COST OF THE FIRST VERSION OF THE RULE ABOVE.
   *
   * "No read answers for a record the store does not have" was enforced with
   * `engine.forget(id)` on every miss. But `open` inserts before the first durable write,
   * so during a capability invocation — an `await` of arbitrary length between the open and
   * the write — the store legitimately does not have the record. Any concurrent read warmed
   * it, found nothing, and DELETED it. `engine.complete` then answered `notFound` and the
   * caller got 404 for a request that was succeeding.
   *
   * No attacker, no guessed id, no second principal: the owner polling their own task list
   * is enough. Live wherever RELAY_PGSL_PG_CONNSTR is set.
   */
  /** An open that parks inside `invokeCapability` until the test lets it finish. */
  function midCapability(store: EngagementRecordStore | null) {
    let release!: () => void;
    const parked = new Promise<void>(r => { release = r; });
    const relay = boot(store, {
      invokeCapability: async () => { await parked; return { ok: true, output: { parts: [{ kind: 'text', text: 'done' }] } }; },
    });
    const inFlight = open(relay, 'do the thing', 'some-capability');
    // One macrotask so the handler reaches the parked await before the concurrent read.
    const settled = new Promise(r => setTimeout(r, 5));
    return { relay, inFlight, release, settled };
  }

  it('the owner listing their own tasks does not 404 the one that is running', async () => {
    const { relay, inFlight, release, settled } = midCapability(engagementStoreOverFdb(new InMemoryFdb()));
    await settled;
    // The listing is the read that used to do the damage.
    const page = await listIds(relay);
    release();
    const res = await inFlight;
    expect(res.statusCode).toBe(200);
    // And it did not answer for the unwritten record either: the invariant is intact,
    // enforced by declining rather than by deleting.
    expect(page).toEqual([]);
    // Once the write landed the same listing shows it.
    expect(await listIds(relay)).toEqual([idOf(res)]);
  });

  it('the protocol-neutral resolver 404s an unwritten id without dropping it', async () => {
    const { relay, inFlight, release, settled } = midCapability(engagementStoreOverFdb(new InMemoryFdb()));
    await settled;
    const inFlightId = relay.engine.list(ALICE).ok
      ? ((relay.engine.list(ALICE) as { value: Engagement[] }).value[0]!.id)
      : '';
    expect((await resolve(relay, inFlightId)).statusCode).toBe(404);
    release();
    const res = await inFlight;
    expect(res.statusCode).toBe(200);
    // Not destroyed — the same id resolves the moment its write lands.
    expect((await resolve(relay, inFlightId)).statusCode).toBe(200);
  });

  it('a genuinely absent id is still dropped — the hold is not a blanket exemption', async () => {
    const store = new FaultyStore();
    const relay = boot(store);
    const id = idOf(await open(relay));
    store.rows.delete(id);
    // Nothing in flight, so the store's "absent" stands and the heap copy goes.
    expect((await resolve(relay, id)).statusCode).toBe(404);
    expect(relay.engine.size()).toBe(0);
  });

  it('a hold does not outlive the request that took it', async () => {
    // `hold` and `abandon` are one pair. A request that gives up on a record but leaves it
    // marked would make `warm` answer "unwritten" for an id nothing will ever write — every
    // later read declining instead of saying, correctly, that it is not there — and the
    // hold set would then be bounded by IDS rather than by in-flight requests, which is the
    // unbounded-state class this codebase keeps finding.
    const store = new FaultyStore();
    const engine = new EngagementEngine(BASE);
    const durable = new DurableEngagements(engine, store);
    const opened = (engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'x' }] }) as { value: Engagement }).value;
    durable.hold(opened.id);
    expect(await durable.warm(opened.id)).toBe('unwritten');
    durable.abandon(opened.id);
    expect(await durable.warm(opened.id)).toBe('absent');
  });

  it('a failed write leaves the request\'s record abandoned, not pending forever', async () => {
    // The wire path that reaches `abandon`: the durable write fails, the handler answers an
    // error, and the `finally` drops the record and releases its hold.
    const store = new FaultyStore();
    const relay = boot(store);
    store.failWrites = 'transient';
    const res = await open(relay);
    expect(res.statusCode).not.toBe(200);
    expect(relay.engine.size()).toBe(0);
    store.failWrites = null;
    const ok = await open(relay, 'after');
    expect(ok.statusCode).toBe(200);
    expect((await resolve(relay, idOf(ok))).statusCode).toBe(200);
  });

  it('warm reports the three outcomes as three outcomes', async () => {
    const store = new FaultyStore();
    const engine = new EngagementEngine(BASE);
    const durable = new DurableEngagements(engine, store);
    const opened = (engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'x' }] }) as { value: Engagement }).value;

    // Opened, not written, nobody holding it: the store's answer stands.
    expect(await durable.warm(opened.id)).toBe('absent');
    engine.admit(opened);
    durable.hold(opened.id);
    // Held: the store still lacks it, but that is not the store saying no.
    expect(await durable.warm(opened.id)).toBe('unwritten');
    expect(engine.get(opened.id, ALICE).ok).toBe(true);
    await durable.persist(opened);
    durable.settle(opened.id);
    expect(await durable.warm(opened.id)).toBe('reconciled');
  });

  it('a held id whose row DOES exist still reconciles against the store', async () => {
    // The hold is consulted only after the store has answered. Otherwise an in-flight
    // cancel would hide a durable record from every other reader for the length of a write.
    const store = new FaultyStore();
    const engine = new EngagementEngine(BASE);
    const durable = new DurableEngagements(engine, store);
    const opened = (engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'x' }] }) as { value: Engagement }).value;
    await durable.persist(opened);
    durable.hold(opened.id);
    expect(await durable.warm(opened.id)).toBe('reconciled');
    durable.settle(opened.id);
  });
});

describe('the listing order is a property of the records, not of the reads before it', () => {
  it('successive identical listings come back in the same order', async () => {
    // ★ They did not. `admit` re-inserts at the tail so eviction can be LRU, and every
    // listing warms its own page — so a listing reordered the map and the NEXT listing came
    // back reversed. Two calls, no writes, opposite orders.
    const relay = boot(engagementStoreOverFdb(new InMemoryFdb()));
    const ids = [idOf(await open(relay, 'a')), idOf(await open(relay, 'b')), idOf(await open(relay, 'c'))];
    const newestFirst = [...ids].reverse();
    for (let i = 0; i < 4; i++) expect(await listIds(relay)).toEqual(newestFirst);
  });

  it('and matches the no-store control, which never had the problem', async () => {
    const relay = boot(null);
    const ids = [idOf(await open(relay, 'a')), idOf(await open(relay, 'b')), idOf(await open(relay, 'c'))];
    expect(await listIds(relay)).toEqual([...ids].reverse());
    expect(await listIds(relay)).toEqual([...ids].reverse());
  });

  it('the bound takes the NEWEST n, not the most recently touched n', async () => {
    // `slice(-n)` over map order returned whichever records had last been warmed. Sorting
    // on createdAt means a limit means what the caller was promised it meant.
    const relay = boot(engagementStoreOverFdb(new InMemoryFdb()));
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c']) ids.push(idOf(await open(relay, t)));
    // Touch the OLDEST, which is what re-orders the map (`admit` moves it to the tail).
    await resolve(relay, ids[0]!);
    // Asserted on the engine because the mount reads `limit` from the query string and the
    // Express double above does not parse one; the bound is the engine's, and so is the bug.
    const page = relay.engine.list(ALICE, 2);
    expect(page.ok && (page as { value: Engagement[] }).value.map(e => e.id)).toEqual([ids[2], ids[1]]);
  });
});

/**
 * The document may not deny what this file proves.
 *
 * WHY A PROSE ASSERTION SITS IN A BEHAVIOUR SUITE. The shared-workspace README's bullet
 * "Engagements are still not durable" was written in #241; #248 shipped the store above
 * and never touched the README, so for two rounds the document told a reader the opposite
 * of what every test in this file demonstrates. Nothing failed, because no test in the
 * repo opens that file. The coupling is the point: the suite that pins the behaviour is
 * now also the suite that fails when the document denies it.
 */
describe('the shared-workspace README does not deny the durability pinned above', () => {
  const README = readFileSync(
    new URL('../applications/shared-workspace/README.md', import.meta.url), 'utf8');
  const STORE_SRC = readFileSync(
    new URL('../deploy/mcp-relay/engagement-store.ts', import.meta.url), 'utf8');

  it('carries no unqualified denial of engagement durability', () => {
    // The exact sentence #241 left behind. Pinned literally because it is the regression,
    // not a proxy for one.
    expect(README).not.toMatch(/Engagements are still not durable/);
  });

  it('names the switch that actually decides the mode, read out of the module itself', () => {
    // Derived rather than hardcoded: renaming the env var in engagement-store.ts fails
    // here until the README is updated too, which is the drift this gate exists to catch.
    // Anchored on the `CONNSTR` binding rather than on the first `process.env[…] ?? ''` in
    // the file — `RELAY_PGSL_TABLE` two declarations below has the identical shape, so the
    // looser pattern would silently retarget if anything were inserted above line 167.
    const sw = /const CONNSTR = process\.env\['([A-Z_]+)'\]/.exec(STORE_SRC)?.[1];
    expect(sw).toBe('RELAY_PGSL_PG_CONNSTR');
    expect(README).toContain(sw!);
  });
});
