#!/usr/bin/env tsx
/**
 * Engagement ids survive a restart — the relay-side regression.
 *
 * The deep behaviour (codec, owner guard, tamper detection, cache subset rule) is pinned
 * in the root suite, tests/engagement-durability.test.ts. THIS file exists because the
 * relay's own suite is what gates the relay's image, and the property it guards is a
 * property of the MOUNT: that a durable store is actually wired in, that reads warm from
 * it before the synchronous engine answers, and that a failed write is not reported as a
 * success. A durability regression must break the suite that ships the thing.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/engagement-durability.test.ts
 */

import { createHash } from 'node:crypto';
import { EngagementEngine, PROFILES, type Engagement } from '@interego/agent-interop';
import { mountAgentInterop } from '../agent-interop-mount.js';
import {
  engagementStoreOverFdb, DurableEngagements, ConcurrentModification,
  type EngagementRecordStore,
} from '../engagement-store.js';
import { InMemoryFdb } from '@interego/pgsl-store';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const BASE = 'https://relay.test';
const ALICE = 'did:ethr:0xalice';

type Handler = (req: any, res: any) => unknown;

function mkRes() {
  const r: any = {
    statusCode: 200, body: undefined as any, headers: {} as Record<string, string>,
    status(c: number) { r.statusCode = c; return r; },
    json(b: unknown) { r.body = b; return r; },
    send(b: unknown) { r.body = b; return r; },
    type() { return r; },
    setHeader(k: string, v: string) { r.headers[k.toLowerCase()] = v; },
    end() { return r; },
  };
  return r;
}

const profile = Object.values(PROFILES)[0]!;

/** One mounted relay "process". A second one over the same store IS the restart. */
function boot(store: EngagementRecordStore | null, invokeCapability?: (args: any) => Promise<any>) {
  const routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = [];
  const app: any = {
    get: (p: string | RegExp, h: Handler) => routes.push({ method: 'GET', path: p, handler: h }),
    post: (p: string | RegExp, h: Handler) => routes.push({ method: 'POST', path: p, handler: h }),
    delete: (p: string | RegExp, h: Handler) => routes.push({ method: 'DELETE', path: p, handler: h }),
  };
  const engine = new EngagementEngine(BASE);
  const logs: string[] = [];
  mountAgentInterop(app, {
    publicBase: BASE,
    engine,
    engagementStore: store,
    agent: { id: `${BASE}/.well-known/operations`, name: 'Test Relay', description: 'test' },
    affordances: () => [],
    verifyCaller: async () => ALICE,
    log: (m) => logs.push(m),
    ...(invokeCapability ? { invokeCapability } : {}),
  });

  const matches = (p: string | RegExp, url: string): boolean => {
    if (p instanceof RegExp) return p.test(url);
    const re = p.split('/').map(s => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
    return new RegExp(`^${re}$`).test(url);
  };
  const dispatch = async (method: string, url: string, body?: unknown, params?: Record<string, string>) => {
    const chosen = routes.find(r => r.method === method && matches(r.path, url));
    if (!chosen) throw new Error(`no route for ${method} ${url}`);
    const captured = chosen.path instanceof RegExp ? { 0: (chosen.path.exec(url) ?? [])[1] ?? '' } : {};
    const res = mkRes();
    await chosen.handler({ method, url, headers: {}, query: {}, body, params: { ...captured, ...(params ?? {}) } }, res);
    return res;
  };

  return { engine, logs, dispatch };
}

const sendPath = `/${profile.slug}/v1${profile.wire.find(w => w.operation === 'sendMessage')!.path}`;
const listPath = `/${profile.slug}/v1${profile.wire.find(w => w.operation === 'listEngagements')!.path}`;

async function open(relay: ReturnType<typeof boot>, capability?: string) {
  const payload: Record<string, unknown> = { parts: [{ text: 'hello' }] };
  // Naming a capability is what routes the request through invokeCapability, where the
  // post-open error exits live.
  if (capability) payload['skillId'] = capability;
  return relay.dispatch('POST', sendPath, profile.requestEnvelope ? { [profile.requestEnvelope]: payload } : payload);
}

/** The owner-scoped listing, as rendered ids. */
async function listIds(relay: ReturnType<typeof boot>): Promise<string[]> {
  const res = await relay.dispatch('GET', listPath);
  const member = profile.responseEnvelope?.listEngagements ?? 'items';
  return ((res.body?.[member] ?? []) as Array<{ id?: string }>).map(x => String(x.id ?? ''));
}
const idOf = (res: any): string => String((res.body?.[profile.responseEnvelope?.sendMessage ?? ''] ?? res.body)?.id ?? '');
const resolve = (relay: ReturnType<typeof boot>, id: string) => {
  const tail = id.slice(`${BASE}/engagements/`.length);
  return relay.dispatch('GET', `/engagements/${tail}`, undefined, { id: tail });
};

// ── 1. the id outlives the process that minted it ────────────────────────────
console.log('\n1. an engagement id resolves from a new process over the same store');
{
  const store = engagementStoreOverFdb(new InMemoryFdb());
  const before = boot(store);
  const id = idOf(await open(before));
  // "CONFIGURED", not "DURABLE": the Postgres connection is opened lazily on the first
  // request, so a boot banner that announced durability was announcing something it could
  // not know — a wrong or unreachable connection string logged the same line while every
  // request faulted.
  check('the mount reports a CONFIGURED durable store when one is supplied',
    before.logs.some(l => /durable engagement store CONFIGURED/.test(l)));
  check('and does not claim connectivity it has not proven',
    !before.logs.some(l => /records are DURABLE/.test(l)));
  check('the id resolves in the minting process', (await resolve(before, id)).statusCode === 200);

  const after = boot(store);
  check('the new process starts with an empty working set', after.engine.size() === 0);
  const res = await resolve(after, id);
  check('the id still resolves after the restart', res.statusCode === 200, `got ${res.statusCode}`);
  check('and resolves to the same record', (res.body as { id?: string })?.id === id);
}

// ── 2. no store ⇒ exactly today's behaviour, said out loud ───────────────────
console.log('\n2. without a store the relay behaves as before, and says so');
{
  const before = boot(null);
  const id = idOf(await open(before));
  check('the id resolves in the minting process', (await resolve(before, id)).statusCode === 200);
  check('and is lost at the restart, as today', (await resolve(boot(null), id)).statusCode === 404);
  check('the mount does NOT claim durability it does not have',
    before.logs.some(l => /IN-MEMORY ONLY/.test(l))
    && !before.logs.some(l => /durable engagement store CONFIGURED/.test(l)));
}

// ── 3. a write that did not land is not reported as one that did ─────────────
console.log('\n3. a failed durable write is not answered with a 200');
{
  const store: EngagementRecordStore = {
    async get() { return null; },
    async put(_e: Engagement) { throw new Error('disk on fire'); },
  };
  const relay = boot(store);
  const res = await open(relay);
  check('the response is an error, not a success', res.statusCode !== 200, `got ${res.statusCode}`);
  check('the internal reason does not reach the caller', !/disk on fire/.test(JSON.stringify(res.body)));
  check('nothing is left in the working set to answer for it', relay.engine.size() === 0);
}

// ── a store double that VERSIONS rows the way the real one does ──────────────
//
// Row bytes are hashed, so a test handing this to the mount exercises the same
// compare-and-swap contract the Postgres-backed store enforces, not a laxer one.
class VersionedStore implements EngagementRecordStore {
  readonly rows = new Map<string, string>();
  private v(text: string): string { return createHash('sha256').update(text).digest('hex'); }
  async get(id: string) {
    const t = this.rows.get(id);
    return t ? { record: JSON.parse(t) as Engagement, version: this.v(t) } : null;
  }
  async put(e: Engagement, expected: string | null): Promise<string> {
    const cur = this.rows.get(e.id);
    if ((cur === undefined ? null : this.v(cur)) !== expected) {
      throw new ConcurrentModification('the engagement changed since it was read');
    }
    const text = JSON.stringify(e);
    this.rows.set(e.id, text);
    return this.v(text);
  }
}

// ── 4. the listing is a read, and reads go to the store ──────────────────────
//
// It answered straight from the working set, so it handed back ids the sibling resolver
// 404'd and rendered one replica's copy of a record another had already completed —
// cancel affordance included. This is the mount's own wire route for it.
console.log('\n4. the listing does not answer for records the store does not have');
{
  const store = new VersionedStore();
  const relay = boot(store);
  const id = idOf(await open(relay));
  check('a live engagement is listed', (await listIds(relay)).includes(id));

  store.rows.delete(id);
  // Listed BEFORE the resolver is touched: a resolve would warm and evict the id, so a
  // later listing would pass on the strength of the other read's reconciliation.
  check('an id the store lost is dropped from the listing', !(await listIds(relay)).includes(id));
  check('and the resolver denies it, as the listing now agrees', (await resolve(relay, id)).statusCode === 404);
}

console.log('\n4b. the listing renders the state the store holds');
{
  const store = new VersionedStore();
  const relay = boot(store);
  const id = idOf(await open(relay));
  const elsewhere = JSON.parse(store.rows.get(id)!) as Engagement;
  elsewhere.state = 'completed';           // a second replica finished the work
  store.rows.set(id, JSON.stringify(elsewhere));

  const res = await relay.dispatch('GET', listPath);
  const rendered = JSON.stringify(res.body);
  check('the listing shows the completed state', rendered.includes(profile.lifecycle.name('completed')));
  check('and not the state this process last saw', !rendered.includes(profile.lifecycle.name('submitted')));
  check('and offers no cancel affordance over a terminal record', !/cancel/i.test(rendered));
}

// ── 5. a request that fails AFTER opening leaves nothing behind ──────────────
console.log('\n5. a post-open failure does not leave an unpersisted record in the working set');
{
  const store = new VersionedStore();
  // `complete` refuses an output over maxPartsPerTurn, which is reachable from ordinary
  // capability output. The handler used to return without ever writing, leaving a record
  // only this heap had — which the listing then served and the resolver then denied.
  const parts = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', text: `p${i}` }));
  const relay = boot(store, async () => ({ ok: true, output: { parts } }));
  const res = await open(relay, 'some-capability');
  check('the response is an error', res.statusCode !== 200, `got ${res.statusCode}`);
  check('nothing was durably written', store.rows.size === 0, `${store.rows.size} rows`);
  check('and nothing is left in the working set', relay.engine.size() === 0, `${relay.engine.size()} records`);
  check('so the listing has nothing to over-report', (await listIds(relay)).length === 0);
}

// ── 6. a concurrent mutation is refused, not silently discarded ──────────────
console.log('\n6. two replicas mutating one engagement cannot lose an acknowledged turn');
{
  const store = engagementStoreOverFdb(new InMemoryFdb());
  const one = new EngagementEngine(BASE);
  const two = new EngagementEngine(BASE);
  const d1 = new DurableEngagements(one, store);
  const d2 = new DurableEngagements(two, store);

  const opened = one.open({ caller: ALICE, parts: [{ kind: 'text', text: 'first' }] });
  const id = (opened as { value: Engagement }).value.id;
  await d1.persist((opened as { value: Engagement }).value);
  await d1.warm(id);
  await d2.warm(id);                                   // both read the same version
  const a = one.appendTurn({ id, caller: ALICE, role: 'requester', parts: [{ kind: 'text', text: 'A' }] });
  const b = two.appendTurn({ id, caller: ALICE, role: 'requester', parts: [{ kind: 'text', text: 'B' }] });
  await d1.persist((a as { value: Engagement }).value);

  let refused = false;
  try { await d2.persist((b as { value: Engagement }).value); }
  catch (e) { refused = e instanceof ConcurrentModification; }
  check('the losing write is refused rather than applied', refused);

  const stored = await store.get(id);
  const texts = stored!.record.turns.flatMap(t => t.parts.map(p => (p as { text?: string }).text));
  check('the acknowledged turn is still there', texts.join(',') === 'first,A', texts.join(','));
  check('and the refused replica keeps nothing the store lacks', two.size() === 0);
}

// ── 7. forget never leaves a tombstone stating a false cause ─────────────────
console.log('\n7. a forgotten record does not carry the eviction claim');
{
  const engine = new EngagementEngine(BASE, { maxEngagements: 1 });
  const first = engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'a' }] });
  const id = (first as { value: Engagement }).value.id;
  engine.open({ caller: ALICE, parts: [{ kind: 'text', text: 'b' }] });   // evicts + tombstones
  check('an evicted record reports `gone` to its owner',
    (engine.get(id, ALICE) as { error?: { kind: string } }).error?.kind === 'gone');

  // The failed-write / store-says-absent path. Neither is a retention limit, so the
  // marker saying "raise maxEngagements" must not survive it.
  engine.forget(id);
  const after = engine.get(id, ALICE) as { error?: { kind: string; detail: string } };
  check('after forget it is a plain miss, not a retention claim', after.error?.kind === 'notFound',
    `got ${after.error?.kind}`);
  check('and states no cause it cannot support', !/maxEngagements|retention bound/.test(after.error?.detail ?? ''));
}

// ── 8. a concurrent read does not DESTROY an in-flight engagement ────────────
//
// ★ THE COST OF ENFORCING "no read answers for a record the store lacks" WITH A DELETE.
// `open` inserts before the first durable write, so during a capability invocation the
// store legitimately does not have the record — and any warm in that window forgot it.
// The owner's own task listing was enough: `engine.complete` then answered notFound and
// the request that was succeeding returned 404 TASK_NOT_FOUND. This is the mount route
// that carried it, so a regression breaks the suite that ships the relay.
console.log('\n8. a read during an in-flight capability cannot 404 the request that is succeeding');
{
  const store = engagementStoreOverFdb(new InMemoryFdb());
  let release!: () => void;
  const parked = new Promise<void>(r => { release = r; });
  const relay = boot(store, async () => { await parked; return { ok: true, output: { parts: [{ kind: 'text', text: 'done' }] } }; });

  const inFlight = open(relay, 'some-capability');
  await new Promise(r => setTimeout(r, 5));          // let the handler reach the parked await
  const duringPage = await listIds(relay);
  release();
  const res = await inFlight;
  check('the in-flight request still succeeds', res.statusCode === 200, `got ${res.statusCode}`);
  check('the concurrent listing declined to answer for the unwritten record', duringPage.length === 0,
    `listed ${duringPage.length}`);
  check('and the record is listed once its write has landed', (await listIds(relay)).includes(idOf(res)));
  check('and resolves', (await resolve(relay, idOf(res))).statusCode === 200);
}

// ── 9. the listing order does not flip between identical calls ───────────────
//
// `admit` re-inserts at the tail (LRU eviction), every listing warms its own page, and
// `list` read the map in insertion order — so a listing reversed the NEXT listing. Two
// reads, no writes, opposite orders. The order now comes from the records' createdAt.
console.log('\n9. successive identical listings come back in the same order');
{
  const relay = boot(engagementStoreOverFdb(new InMemoryFdb()));
  const ids = [idOf(await open(relay)), idOf(await open(relay)), idOf(await open(relay))];
  const newestFirst = [...ids].reverse().join(',');
  const seen = [
    (await listIds(relay)).join(','), (await listIds(relay)).join(','),
    (await listIds(relay)).join(','), (await listIds(relay)).join(','),
  ];
  check('every call is newest-first', seen.every(s => s === newestFirst), seen.join(' | '));
}

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
