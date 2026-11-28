/**
 * A sequencing session and what the cmi5 rollup has said are one record each, kept before the
 * answer.
 *
 * ★ WHY. Both were inside a snapshot of a whole surface, and publishing that takes about sixteen
 * seconds on the deployed bridge (measured 2026-11-27, after a change that waited for it made
 * every step take that long). A record of one session, or of one learner's rollup, is one native
 * commit. So a step can be kept before it is answered, and a process that stops loses nothing it
 * answered for.
 *
 * And the bound: the route that makes a session is public and unsigned, so a record a session is
 * unbounded unless something counts them.
 */
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { NativeCommitStore, NATIVE_COMMIT_MEDIA_TYPE, type NativeCommitScope } from '@interego/pgsl';
import { openStore, InMemoryFdb, CodecRegistry, LdpStore } from '../../../packages/pgsl-store/src/index.js';
import { NativeInteregoLrsDatabase } from '../src/native-lrs-store.js';
import { KeptRecords, type NativeResources } from '../src/kept-records.js';
import { KeptScormSessions, isKeptSessionIndex, type KeptSessionIndex } from '../src/kept-scorm-sessions.js';
import { SealedPodMap, type SealedFetch } from '../src/sealed-store.js';
import { attachScormSequencingRoutes, sessionFromJson, _heldFromSnapshot, _sequencingSessions, type KeptSession, type ScormSessionStore } from '../src/scorm-sequencing.js';
import { buildCmi5Launch, forgetCmi5Learner, forgetCmi5RollupKept, isCmi5RollupKept, observeCmi5Statement, registerCmi5Course, setCmi5RollupStore, type Cmi5RollupKept, type Cmi5RollupStore } from '../src/cmi5-lms.js';
import type { Cmi5Course } from '../src/cmi5-course.js';
import type { TenantId } from '../src/tenant-context.js';

const KEY = deriveEncryptionKeyPair('66'.repeat(32));
type Rec = { id: string; n: number };
const isRec = (v: unknown): v is Rec => !!v && typeof (v as Rec).id === 'string' && typeof (v as Rec).n === 'number';

function pod() {
  const bodies = new Map<string, string>();
  const fail = { del: false, put: false };
  const fetch: SealedFetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') return new Response(null, { status: 200 });
    if (method === 'GET') return bodies.has(url) ? new Response(bodies.get(url)!) : new Response('', { status: 404 });
    if (method === 'PUT') { if (fail.put) return new Response('', { status: 500 }); bodies.set(url, String(init?.body ?? '')); return new Response('', { status: 201 }); }
    if (method === 'DELETE') { if (fail.del) return new Response('', { status: 500 }); bodies.delete(url); return new Response(null, { status: 204 }); }
    return new Response('', { status: 405 });
  };
  return { bodies, fetch, fail };
}
function fakeNative() {
  const held = new Map<string, unknown>();
  const fail = { get: false, put: false, del: false, update: false };
  const store: NativeResources = {
    async getResource<T>(kind: string, id: string) { if (fail.get) throw new Error('unreadable'); return (held.get(`${kind}/${id}`) ?? null) as T | null; },
    async putResource<T>(kind: string, id: string, value: T) { if (fail.put) throw new Error('refused'); held.set(`${kind}/${id}`, structuredClone(value)); },
    async deleteResource(kind: string, id: string) { if (fail.del) throw new Error('refused'); held.delete(`${kind}/${id}`); },
    async updateResource<T, R>(kind: string, id: string, mutate: (current: T | null) => { value: T | null; result: R }) {
      if (fail.update) throw new Error('refused');
      const next = mutate((held.get(`${kind}/${id}`) ?? null) as T | null);
      if (next.value === null) held.delete(`${kind}/${id}`); else held.set(`${kind}/${id}`, structuredClone(next.value));
      return next.result;
    },
  };
  return { held, fail, store, of: (kind: string) => [...held.keys()].filter(k => k.startsWith(`${kind}/`)).map(k => k.slice(kind.length + 1)) };
}
const sealedOf = <V>(p: ReturnType<typeof pod>, surface: string, valid: (v: unknown) => v is V, on = true) =>
  new SealedPodMap<V>({ base: on ? `https://pod.example/kept/${surface}/` : '', key: KEY, fetch: p.fetch, valid });

describe('a kind that was never kept sealed', () => {
  // Each sealed lookup or removal is a request to the pod. For a kind with no earlier sealed
  // copies on a native deployment there is nothing for those requests to find, and they would be
  // paid on every step of a learner's session.
  it('does not ask the pod anything when the store is native', async () => {
    const n = fakeNative(), p = pod();
    let requests = 0;
    const counting: SealedFetch = async (url, init) => { requests++; return p.fetch(url, init); };
    const sealed = new SealedPodMap<Rec>({ base: 'https://pod.example/kept/thing/', key: KEY, fetch: counting, valid: isRec });
    const k = new KeptRecords<Rec>({ kind: 'thing', native: () => n.store, valid: isRec, sealed, sealedBefore: false });
    expect(await k.get('t', 'a')).toEqual({ state: 'absent' });
    expect(await k.put('t', 'a', { id: 'a', n: 1 })).toBe('kept');
    expect(await k.update('t', 'a', c => ({ value: { id: 'a', n: c!.n + 1 }, result: 0 }))).toEqual({ state: 'kept', result: 0 });
    expect(await k.get('t', 'a')).toEqual({ state: 'held', value: { id: 'a', n: 2 } });
    expect(await k.remove('t', 'a')).toBe('gone');
    expect(requests).toBe(0);
  });
  it('still keeps sealed where the store is not native', async () => {
    const p = pod();
    const k = new KeptRecords<Rec>({ kind: 'thing', native: () => null, valid: isRec, sealed: sealedOf(p, 'thing', isRec), sealedBefore: false });
    expect(await k.put('t', 'a', { id: 'a', n: 1 })).toBe('kept');
    expect(await k.get('t', 'a')).toEqual({ state: 'held', value: { id: 'a', n: 1 } });
  });
});

describe('changing a kept record by what it holds', () => {
  it('natively: the change is made to the record the commit finds', async () => {
    const n = fakeNative();
    const k = new KeptRecords<Rec>({ kind: 'thing', native: () => n.store, valid: isRec, sealed: sealedOf(pod(), 'thing', isRec, false) });
    expect(await k.update('t', 'a', c => ({ value: { id: 'a', n: (c?.n ?? 0) + 1 }, result: c?.n ?? 0 }))).toEqual({ state: 'kept', result: 0 });
    expect(await k.update('t', 'a', c => ({ value: { id: 'a', n: (c?.n ?? 0) + 1 }, result: c?.n ?? 0 }))).toEqual({ state: 'kept', result: 1 });
    expect(n.held.get('thing/a')).toEqual({ id: 'a', n: 2 });
    expect(await k.update('t', 'a', () => ({ value: null, result: 'removed' }))).toEqual({ state: 'kept', result: 'removed' });
    expect(n.held.has('thing/a')).toBe(false);
  });
  it('does not change a record it cannot read as though it were empty', async () => {
    const n = fakeNative();
    const k = new KeptRecords<Rec>({ kind: 'thing', native: () => n.store, valid: isRec, sealed: sealedOf(pod(), 'thing', isRec, false) });
    n.held.set('thing/odd', { not: 'one' });
    let ran = false;
    expect(await k.update('t', 'odd', () => { ran = true; return { value: { id: 'odd', n: 1 }, result: 0 }; })).toEqual({ state: 'failed' });
    expect(ran).toBe(false);
    expect(n.held.get('thing/odd')).toEqual({ not: 'one' });
    n.fail.update = true;
    expect(await k.update('t', 'b', () => ({ value: { id: 'b', n: 1 }, result: 0 }))).toEqual({ state: 'failed' });
  });
  it('sealed: one change at a time, so two at once both count', async () => {
    const p = pod();
    const k = new KeptRecords<Rec>({ kind: 'thing', native: () => null, valid: isRec, sealed: sealedOf(p, 'thing', isRec) });
    const add = () => k.update('t', 'a', c => ({ value: { id: 'a', n: (c?.n ?? 0) + 1 }, result: undefined }));
    expect((await Promise.all([add(), add(), add(), add()])).map(r => r.state)).toEqual(['kept', 'kept', 'kept', 'kept']);
    expect(await k.get('t', 'a')).toEqual({ state: 'held', value: { id: 'a', n: 4 } });
    p.fail.put = true;
    expect(await add()).toEqual({ state: 'failed' });
  });
  it('says unconfigured where nothing can be kept', async () => {
    const k = new KeptRecords<Rec>({ kind: 'thing', native: () => null, valid: isRec, sealed: sealedOf(pod(), 'thing', isRec, false) });
    expect(await k.update('t', 'a', () => ({ value: { id: 'a', n: 1 }, result: 0 }))).toEqual({ state: 'unconfigured' });
  });
});

function sessionsOver(native: () => NativeResources | null, max: number, p = pod(), sealedOn = false) {
  return new KeptScormSessions<Rec>({
    max,
    records: new KeptRecords<Rec>({ kind: 'foxxi-scorm-session', native, valid: isRec, sealed: sealedOf(p, 'sessions', isRec, sealedOn) }),
    index: new KeptRecords<KeptSessionIndex>({ kind: 'foxxi-scorm-session-index', native, valid: isKeptSessionIndex, sealed: sealedOf(p, 'session-index', isKeptSessionIndex, sealedOn) }),
  });
}
const settle = () => new Promise(r => setTimeout(r, 30));

describe('the bound on kept sessions', () => {
  it('holds no more than the bound however many are made, and the oldest go', async () => {
    const n = fakeNative(), s = sessionsOver(() => n.store, 3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(await s.keep(id, { id, n: 1 })).toBe(true);
    await settle();
    expect(n.of('foxxi-scorm-session').sort()).toEqual(['c', 'd', 'e']);
    expect(n.held.get('foxxi-scorm-session-index/index')).toEqual({ order: ['c', 'd', 'e'], evicting: [] });
    expect((await s.load('a')).state).toBe('absent');
  });
  it('holds across a restart: a new process counts the ones the last one kept', async () => {
    const n = fakeNative();
    const first = sessionsOver(() => n.store, 3);
    for (const id of ['a', 'b', 'c']) await first.keep(id, { id, n: 1 });
    const second = sessionsOver(() => n.store, 3);      // nothing in memory
    await second.keep('d', { id: 'd', n: 1 });
    await settle();
    expect(n.of('foxxi-scorm-session').sort()).toEqual(['b', 'c', 'd']);
  });
  it('writes a step of a session it already counts as one record, and does not count it twice', async () => {
    const n = fakeNative(), s = sessionsOver(() => n.store, 3);
    await s.keep('a', { id: 'a', n: 1 });
    await s.keep('a', { id: 'a', n: 2 });
    const other = sessionsOver(() => n.store, 3);       // another process stepping the same session
    expect((await other.load('a'))).toEqual({ state: 'held', value: { id: 'a', n: 2 } });
    await other.keep('a', { id: 'a', n: 3 });
    expect(n.held.get('foxxi-scorm-session-index/index')).toEqual({ order: ['a'], evicting: [] });
    expect(n.held.get('foxxi-scorm-session/a')).toEqual({ id: 'a', n: 3 });
  });
  it('writes no record the index could not be told of', async () => {
    const n = fakeNative(), s = sessionsOver(() => n.store, 3);
    n.fail.update = true;
    expect(await s.keep('a', { id: 'a', n: 1 })).toBe(false);
    expect(n.of('foxxi-scorm-session')).toEqual([]);
    n.fail.update = false;
    expect(await s.keep('a', { id: 'a', n: 1 })).toBe(true);
  });
  it('keeps an id it could not remove as still to remove, and removes it with the next session', async () => {
    const n = fakeNative(), s = sessionsOver(() => n.store, 2);
    await s.keep('a', { id: 'a', n: 1 }); await s.keep('b', { id: 'b', n: 1 });
    n.fail.del = true;
    await s.keep('c', { id: 'c', n: 1 });
    await settle();
    expect(n.held.get('foxxi-scorm-session-index/index')).toEqual({ order: ['b', 'c'], evicting: ['a'] });
    expect(n.of('foxxi-scorm-session').sort()).toEqual(['a', 'b', 'c']);     // bound + the one still going
    n.fail.del = false;
    await s.keep('d', { id: 'd', n: 1 });
    await settle();
    expect(n.held.get('foxxi-scorm-session-index/index')).toEqual({ order: ['c', 'd'], evicting: [] });
    expect(n.of('foxxi-scorm-session').sort()).toEqual(['c', 'd']);
  });
  // ★ Review of #1013. Each process remembered which sessions it had counted. After another
  // bridge let one go, the first still "knew" it was counted and wrote its record back: a record
  // the index did not hold, that nothing would ever remove.
  it('does not put back a session another bridge has let go without counting it again', async () => {
    const n = fakeNative();
    const one = sessionsOver(() => n.store, 1), two = sessionsOver(() => n.store, 1);
    await one.keep('old', { id: 'old', n: 1 });
    expect((await two.load('old')).state).toBe('held');          // the second bridge now believes it counted
    await one.keep('new', { id: 'new', n: 1 });                   // the first lets 'old' go
    await settle();
    expect(n.of('foxxi-scorm-session')).toEqual(['new']);
    expect(await two.keep('old', { id: 'old', n: 2 })).toBe(true); // stepped through the second
    await settle();
    // It was counted again, so the bound still holds: one record, and the index names it.
    const index = n.held.get('foxxi-scorm-session-index/index') as KeptSessionIndex;
    expect(index.evicting).toEqual([]);
    expect(n.of('foxxi-scorm-session')).toEqual(index.order);
    expect(index.order).toHaveLength(1);
  });

  it('is bounded the same way where records are sealed on the pod', async () => {
    const p = pod(), s = sessionsOver(() => null, 2, p, true);
    for (const id of ['a', 'b', 'c', 'd']) expect(await s.keep(id, { id, n: 1 })).toBe(true);
    await settle();
    expect(s.mechanism).toBe('sealed-pod-resource');
    expect((await s.load('a')).state).toBe('absent');
    expect((await s.load('d')).state).toBe('held');
    expect([...p.bodies.keys()].filter(u => u.includes('/kept/sessions/') && u.endsWith('.envelope.json'))).toHaveLength(2);
  });
  it('says it keeps nothing where it can keep nothing', () => {
    expect(sessionsOver(() => null, 2).configured).toBe(false);
  });
});

function nativeEngine() {
  const owner = 'did:web:sessions.test:service' as IRI;
  const ldp = new LdpStore(openStore(new InMemoryFdb()), new CodecRegistry());
  const suffix = randomUUID();
  const scope: NativeCommitScope = { pod: 'https://pod.test/service/', headUrl: `https://pod.test/service/${suffix}/head`, artifactContainer: `https://pod.test/service/${suffix}/artifacts/`, owner };
  const transport: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } });
    if (method === 'GET') {
      const result = await ldp.readResource('css', url);
      return result ? new Response(Buffer.from(result.bytes).toString('utf8'), { headers: { 'Content-Type': result.contentType, ETag: '"' + result.revision + '-json"', 'Interego-Revision': result.revision, 'Interego-Body-Digest': result.bodyDigest } }) : new Response(null, { status: 404 });
    }
    const command = JSON.parse(String(init?.body)) as { expectedRevision: string | null; bodyBase64: string; contentType: string };
    const result = await ldp.commitResource('css', url, Buffer.from(command.bodyBase64, 'base64'), command.contentType, { expectedRevision: command.expectedRevision });
    if (result.status === 'conflict') return new Response(null, { status: 412 });
    return new Response(JSON.stringify({ ...result, version: 1, resource: url, expectedRevision: command.expectedRevision }), { headers: { 'Content-Type': 'application/json', ETag: '"' + result.revision + '-json"' } });
  };
  const keys = deriveEncryptionKeyPair('11'.repeat(32), owner);
  return () => new NativeInteregoLrsDatabase({
    client: new NativeCommitStore({ scope, fetch: transport, senderKeyPair: keys, ownerPublicKey: keys.publicKey, recipientPublicKeys: [keys.publicKey] }),
    owner, scopeIdentity: JSON.stringify(scope), cursorSecret: 'synthetic-sessions-cursor-secret-000001' });
}

describe('over the real native client and a local resource engine', () => {
  it('two bridges making sessions at once both land in one index, and the bound holds for both', async () => {
    const bridge = nativeEngine();
    const one = bridge(), two = bridge();
    const a = sessionsOver(() => one.forTenant('bridge'), 3), b = sessionsOver(() => two.forTenant('bridge'), 3);
    expect(await Promise.all([a.keep('s1', { id: 's1', n: 1 }), b.keep('s2', { id: 's2', n: 1 }), a.keep('s3', { id: 's3', n: 1 }), b.keep('s4', { id: 's4', n: 1 })])).toEqual([true, true, true, true]);
    await new Promise(r => setTimeout(r, 400));
    const fresh = bridge().forTenant('bridge');
    const index = await fresh.getResource<KeptSessionIndex>('foxxi-scorm-session-index', 'index');
    expect(index!.order).toHaveLength(3);
    expect([...index!.order, ...index!.evicting].length).toBeLessThanOrEqual(4);
    let held = 0;
    for (const id of ['s1', 's2', 's3', 's4']) if (await fresh.getResource('foxxi-scorm-session', id)) held++;
    expect(held).toBe(3 + index!.evicting.length);
  }, 60_000);
});

// ── The routes ────────────────────────────────────────────────────────────────────────────

const MANIFEST = `<?xml version="1.0"?><manifest identifier="m" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"><organizations default="o"><organization identifier="o"><title>T</title><item identifier="i1" identifierref="r1"><title>One</title></item><item identifier="i2" identifierref="r1"><title>Two</title></item></organization></organizations><resources><resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="a.html"/></resources></manifest>`;

async function serve(store: ScormSessionStore | undefined) {
  const app = express();
  app.use(express.json());
  attachScormSequencingRoutes(app, { selfBaseUrl: 'http://x', ...(store ? { sessions: store } : {}) });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, xml = false) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': xml ? 'text/xml' : 'application/json' }, body: xml ? String(body) : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  return { post, get, close: () => new Promise<void>(r => server.close(() => r())) };
}
function memoryStore() {
  const held = new Map<string, KeptSession>();
  const state = { failKeep: false, unreadable: false, keeps: 0, order: [] as string[] };
  const store: ScormSessionStore = {
    configured: true,
    async load(id) { if (state.unreadable) return { state: 'unreadable' }; const v = held.get(id); return v ? { state: 'held', value: structuredClone(v) } : { state: 'absent' }; },
    async keep(id, session) { state.keeps++; if (state.failKeep) return false; held.set(id, structuredClone(session)); state.order.push(String((session as unknown as { currentId?: string }).currentId ?? '')); return true; },
  };
  return { held, state, store };
}

describe('the sequencing routes with a session store', () => {
  it('keep a session before answering for it, and say so', async () => {
    const m = memoryStore(), s = await serve(m.store);
    try {
      const made = await s.post('/scorm/sequencing/session', MANIFEST, true);
      expect(made.body).toMatchObject({ created: true, sessionKept: true });
      const id = String(made.body.sessionId);
      expect(m.held.has(id)).toBe(true);
      const step = await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'choice', target: 'i2' });
      expect(step.body).toMatchObject({ ok: true, currentActivity: 'i2', sessionKept: true });
      m.state.failKeep = true;
      const refused = await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'choice', target: 'i1' });
      // The step is not undone; the answer says the pod does not hold it.
      expect(refused.body).toMatchObject({ ok: true, currentActivity: 'i1', sessionKept: false });
    } finally { await s.close(); }
  });

  it('read a session this process does not hold from the store, where it was left', async () => {
    const m = memoryStore(), s = await serve(m.store);
    try {
      const id = String((await s.post('/scorm/sequencing/session', MANIFEST, true)).body.sessionId);
      await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'choice', target: 'i2' });
      _sequencingSessions().delete(id);                 // a restart, or eviction from memory
      const view = await s.get(`/scorm/sequencing/${id}`);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ sessionId: id, currentActivity: 'i2' });
      _sequencingSessions().delete(id);
      const next = await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'choice', target: 'i1' });
      expect(next.body).toMatchObject({ ok: true, currentActivity: 'i1', sessionKept: true });
    } finally { await s.close(); }
  });

  // ★ Review of #1013. The old snapshot is still read at start and is no longer written, so after
  // a restart it can be older than the session's own record, and it was used first.
  it('use the session\'s record, not an older copy the old snapshot gave at start', async () => {
    const m = memoryStore(), s = await serve(m.store);
    try {
      const id = String((await s.post('/scorm/sequencing/session', MANIFEST, true)).body.sessionId);
      const before = sessionFromJson(structuredClone(m.held.get(id)))!;      // as the snapshot had it: nothing chosen
      await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'choice', target: 'i2' });
      // A restart: memory holds only what the snapshot gave.
      _sequencingSessions().delete(id);
      _heldFromSnapshot(before);
      expect((await s.get(`/scorm/sequencing/${id}`)).body).toMatchObject({ currentActivity: 'i2' });
      // And one the store has no record of is used as the snapshot gave it, then kept.
      const only = sessionFromJson({ ...structuredClone(m.held.get(id)!), id: 'scorm-seq-only-in-snapshot' })!;
      _heldFromSnapshot(only);
      const step = await s.post('/scorm/sequencing/scorm-seq-only-in-snapshot/navigate', { request: 'choice', target: 'i1' });
      expect(step.body).toMatchObject({ ok: true, currentActivity: 'i1', sessionKept: true });
      expect(m.held.has('scorm-seq-only-in-snapshot')).toBe(true);
    } finally { await s.close(); }
  });

  it('do not use a snapshot copy while the record cannot be read', async () => {
    const m = memoryStore(), s = await serve(m.store);
    try {
      const id = String((await s.post('/scorm/sequencing/session', MANIFEST, true)).body.sessionId);
      const before = sessionFromJson(structuredClone(m.held.get(id)))!;
      _sequencingSessions().delete(id);
      _heldFromSnapshot(before);
      m.state.unreadable = true;
      expect((await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'choice', target: 'i1' })).status).toBe(503);
    } finally { await s.close(); }
  });

  it('answer 503, not "no session", for one that is kept and cannot be read', async () => {
    const m = memoryStore(), s = await serve(m.store);
    try {
      const id = String((await s.post('/scorm/sequencing/session', MANIFEST, true)).body.sessionId);
      _sequencingSessions().delete(id);
      m.state.unreadable = true;
      expect((await s.get(`/scorm/sequencing/${id}`)).status).toBe(503);
      expect((await s.post(`/scorm/sequencing/${id}/navigate`, { request: 'start' })).status).toBe(503);
      m.state.unreadable = false;
      expect((await s.get('/scorm/sequencing/scorm-seq-none')).status).toBe(404);
    } finally { await s.close(); }
  });

  it('are limited by address: making a session is a commit to the pod, and the route is public', async () => {
    const m = memoryStore(), s = await serve(m.store);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 122; i++) statuses.push((await s.post('/scorm/sequencing/session', MANIFEST, true)).status);
      expect(statuses.filter(x => x === 200)).toHaveLength(120);
      expect(statuses.slice(120)).toEqual([429, 429]);
      expect(m.held.size).toBe(120);
    } finally { await s.close(); }
  });

  it('without a store, answer as before and claim nothing about a write', async () => {
    const s = await serve(undefined);
    try {
      const made = await s.post('/scorm/sequencing/session', MANIFEST, true);
      expect(made.body.created).toBe(true);
      expect('sessionKept' in made.body).toBe(false);
      const step = await s.post(`/scorm/sequencing/${String(made.body.sessionId)}/navigate`, { request: 'start' });
      expect('sessionKept' in step.body).toBe(false);
    } finally { await s.close(); }
  });

  it('a store that can keep nothing is not waited on', async () => {
    const m = memoryStore();
    const s = await serve({ ...m.store, configured: false });
    try {
      const made = await s.post('/scorm/sequencing/session', MANIFEST, true);
      expect('sessionKept' in made.body).toBe(false);
      expect(m.state.keeps).toBe(0);
    } finally { await s.close(); }
  });
});

// ── The rollup ────────────────────────────────────────────────────────────────────────────

describe('what the cmi5 rollup has said', () => {
  const tenant = 'rollup-kept-tenant' as TenantId;
  const course = (): Cmi5Course => ({
    id: `https://bridge.example/course/rollup-${randomUUID()}`, title: 'Rollup', description: '',
    structure: [{ kind: 'au', id: `https://bridge.example/au/${randomUUID()}`, title: 'Only', url: 'https://bridge.example/content/au/p/0', moveOn: 'Completed' }],
  } as Cmi5Course);
  function rollupStore() {
    const held = new Map<string, Cmi5RollupKept>();
    const state = { unreadable: false, failMerge: false, merges: 0 };
    const store: Cmi5RollupStore = {
      configuredFor: () => true,
      async load(t, learner) { if (state.unreadable) return { state: 'unreadable' }; const v = held.get(`${t}|${learner}`); return v ? { state: 'held', value: structuredClone(v) } : { state: 'absent' }; },
      async merge(t, learner, courseId, entry) {
        state.merges++; if (state.failMerge) return false;
        const cur = held.get(`${t}|${learner}`) ?? { courses: {} };
        const before = cur.courses[courseId];
        cur.courses[courseId] = { reg: before?.reg ?? entry.reg, emitted: [...new Set([...(before?.emitted ?? []), ...entry.emitted])] };
        held.set(`${t}|${learner}`, cur); return true;
      },
      async forget(t, learner) { held.delete(`${t}|${learner}`); return true; },
    };
    return { held, state, store };
  }
  /** Complete the course's one activity for a learner; returns the `satisfied` statements said. */
  async function complete(c: Cmi5Course, learnerId: string): Promise<Array<Record<string, unknown>>> {
    const au = c.structure[0] as { id: string; url: string };
    const launch = buildCmi5Launch({ au: { id: au.id, url: au.url }, learner: { id: learnerId }, lrsEndpoint: 'x', fetchBaseUrl: 'y', authoritativeSource: 'https://lms.example', tenant, courseId: c.id });
    const said: Array<Record<string, unknown>> = [];
    const completed = { verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: au.id }, context: { registration: launch.registration }, result: { completion: true } };
    await observeCmi5Statement(completed, tenant, { statementsForRegistration: async () => [completed], emit: (s) => { said.push(s); } });
    // The course's own `satisfied`: the activity's is said under the launch's registration, and is not the rollup's.
    return said.filter(s => String((s.verb as { id?: string }).id).endsWith('/satisfied') && (s.object as { id?: string }).id === c.id);
  }
  const regOf = (s: Record<string, unknown>) => (s.context as { registration: string }).registration;

  it('is kept as it is said, one record a learner', async () => {
    const r = rollupStore(); setCmi5RollupStore(r.store);
    try {
      const c = course(); registerCmi5Course(tenant, c);
      const said = await complete(c, 'did:ethr:0xr1');
      expect(said).toHaveLength(1);
      const kept = r.held.get(`${tenant}|did:ethr:0xr1`)!;
      expect(isCmi5RollupKept(kept)).toBe(true);
      expect(kept.courses[c.id]).toEqual({ reg: regOf(said[0]!), emitted: [c.id] });
    } finally { setCmi5RollupStore(undefined); }
  });

  it('is not said again by a process that did not say it', async () => {
    const r = rollupStore(); setCmi5RollupStore(r.store);
    try {
      const c = course(); registerCmi5Course(tenant, c);
      const first = await complete(c, 'did:ethr:0xr2');
      expect(first).toHaveLength(1);
      // A restart: this process holds nothing of the rollup for that learner.
      forgetCmi5Learner(tenant, 'did:ethr:0xr2');
      setCmi5RollupStore(r.store);
      expect(await complete(c, 'did:ethr:0xr2')).toEqual([]);
    } finally { setCmi5RollupStore(undefined); }
  });

  it('says nothing while what was said cannot be read, and says it once it can', async () => {
    const r = rollupStore(); setCmi5RollupStore(r.store);
    try {
      const c = course(); registerCmi5Course(tenant, c);
      r.state.unreadable = true;
      expect(await complete(c, 'did:ethr:0xr3')).toEqual([]);
      expect(r.state.merges).toBe(0);
      r.state.unreadable = false;
      expect(await complete(c, 'did:ethr:0xr3')).toHaveLength(1);
    } finally { setCmi5RollupStore(undefined); }
  });

  it('still says it when the record cannot be written', async () => {
    const r = rollupStore(); setCmi5RollupStore(r.store);
    try {
      const c = course(); registerCmi5Course(tenant, c);
      r.state.failMerge = true;
      expect(await complete(c, 'did:ethr:0xr4')).toHaveLength(1);
    } finally { setCmi5RollupStore(undefined); }
  });

  it('is removed when the learner is forgotten, so it is said afresh if they return', async () => {
    const r = rollupStore(); setCmi5RollupStore(r.store);
    try {
      const c = course(); registerCmi5Course(tenant, c);
      const first = await complete(c, 'did:ethr:0xr5');
      forgetCmi5Learner(tenant, 'did:ethr:0xr5');
      expect(await forgetCmi5RollupKept(tenant, 'did:ethr:0xr5')).toBe(true);
      expect(r.held.has(`${tenant}|did:ethr:0xr5`)).toBe(false);
      const again = await complete(c, 'did:ethr:0xr5');
      expect(again).toHaveLength(1);
      expect(regOf(again[0]!)).not.toBe(regOf(first[0]!));
    } finally { setCmi5RollupStore(undefined); }
  });
});

describe('the bridge', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  it('gives the sequencing routes a bounded store under its own tenant', () => {
    expect(src).toContain('sessions: keptSequencingSessions,');
    expect(src).toMatch(/const keptSequencingSessions = new KeptScormSessions<KeptSession>\(\{\n  max: 5000,/);
    expect(src).toContain("kind: 'foxxi-scorm-session', native: nativeOfBridge, valid: isKeptSequencingSession, sealedBefore: false,");
    expect(src).toContain("kind: 'foxxi-scorm-session-index', native: nativeOfBridge, valid: isKeptSessionIndex, sealedBefore: false,");
  });
  it('merges a course into the learner\'s rollup record, keeping the registration first kept', () => {
    expect(src).toContain("kind: 'foxxi-cmi5-rollup', native: nativeOfTenant");
    expect(src).toContain('const merged = { reg: before?.reg ?? entry.reg, emitted: [...new Set([...(before?.emitted ?? []), ...entry.emitted])] };');
  });
  it('removes the rollup record when a learner is forgotten, and fails the request if it cannot', () => {
    const forget = src.slice(src.indexOf('forgetActor: async (did, tenant, where) => {'), src.indexOf('statementIds: async (did, tenant)'));
    expect(forget.indexOf('forgetCmi5RollupKept(tenant, did)')).toBeGreaterThan(forget.indexOf('forgetCmi5Learner(tenant, did)'));
    expect(forget).toContain("throw new Error('what the course rollup kept for this learner could not be removed");
  });
});
