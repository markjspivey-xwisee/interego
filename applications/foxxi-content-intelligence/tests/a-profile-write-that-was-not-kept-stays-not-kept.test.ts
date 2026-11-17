/**
 * What the profile server says about a write is what a restart finds, and a write that added
 * nothing costs its signer nothing.
 *
 * Three things were left open when additions, removals and publications were made to wait for
 * their durable write:
 *
 *   1. A write that landed on the pod, with its answer lost on the way back, was reported as not
 *      kept, and the next restart replayed it. When the pod can be read back the server asks it;
 *      when it cannot, the write is in doubt, and is settled from the pod once it can. So was a write that did fail: the bridge composes a
 *      record into its lattice before it writes, and the whole lattice goes to the pod with the
 *      next write that lands.
 *   2. An addition that was refused, or not kept, still counted against the signer's hourly allowance.
 *   3. POST /agent/xapi-profiles/add and /remove were written inside the bridge, where no test
 *      reached them over HTTP.
 *
 * Everything here is made up: a profile about inspecting bell buoys, kept by a fictional buoy
 * tender, and a pod that fails on command.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProfileServer, ProfileServerError, AdditionNotKept, RemovalNotKept, mountProfileServerWrites, WriteInDoubt, MAX_WITHDRAWN_BY_ONE_RECORD, type ProfileRecord } from '../src/xapi-profile-server/service.js';
import { ProfileAuthoring } from '../src/xapi-profile-server/authoring.js';
import { mountProfileAuthoring, mountProfileHosting } from '../src/xapi-profile-server/authoring-http.js';
import { SignerHourlyLimit } from '../src/open-hosting.js';
import type { Json } from '../src/xapi-profile-server/rdf.js';

type Obj = { [key: string]: Json };
const json = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;

const BRIDGE = 'https://bridge.example';
const BASE = `${BRIDGE}/xapi/profiles`;
const P = 'https://buoys.example/profiles/bell-buoy';
const V1 = `${P}/v/1`, V2 = `${P}/v/2`;
const OTHER = 'https://buoys.example/profiles/fog-signal';
const TENDER = 'did:example:buoy-tender', PASSER_BY = 'did:example:passer-by', OPERATOR = 'did:example:operator';
const ADDS_PER_HOUR = 2;
/** How many calls one address makes to the add and remove routes, together, in the test's window. */
const ADDRESS_LIMIT = 40;

const bellBuoy = (version: string, label = 'Bell buoy', id = P): Obj => ({
  '@context': 'https://w3id.org/xapi/profiles/context', id, type: 'Profile',
  prefLabel: { en: label }, definition: { en: 'A made-up profile about inspecting a buoy.' },
  versions: [{ id: version }],
  concepts: [{ id: `${id}/verbs/inspected`, type: 'Verb', inScheme: version, prefLabel: { en: 'inspected' }, definition: { en: 'A tender inspected the buoy.' } }],
});

/**
 * A pod that does as it is told, and keeps what the bridge's lattice keeps: a record is composed
 * the moment it is sent, and everything composed goes to the pod with the next write that lands.
 */
type Weather = 'lands' | 'lands-and-the-answer-is-lost' | 'fails';
let weather: Weather;
/** Whether the pod's own copy can be read back. */
let readable: boolean;
let onPod: ProfileRecord[];
let composed: ProfileRecord[];

const persist = async (record: ProfileRecord) => {
  composed.push(json<ProfileRecord>(record));
  if (weather === 'fails') throw new Error('the made-up pod is unreachable');
  onPod.push(...composed); composed = [];
  if (weather === 'lands-and-the-answer-is-lost') throw new Error('the made-up answer was lost on the way back');
  return { persisted: true, holonUri: `urn:test:holon:${onPod.length}` };
};
const confirm = async (record: ProfileRecord) => readable ? onPod.some(r => r.id === record.id) : undefined;
const makeServer = () => new ProfileServer({ builtIn: () => [], isOperator: did => did === OPERATOR, persist, confirm, hydrate: async () => onPod });

let server: ProfileServer, allowance: SignerHourlyLimit, http: Server, origin: string;
let fetched: string[];

const held = (s: ProfileServer) => s.dataset.all().map(h => ({ version: h.version, label: (h.doc as Obj).prefLabel })).sort((a, b) => a.version.localeCompare(b.version));
/** A process that starts now: it has what is on the pod and nothing this one only composed. */
async function restarted(): Promise<ProfileServer> {
  const cold = new ProfileServer({ builtIn: () => [], isOperator: did => did === OPERATOR, hydrate: async () => json<ProfileRecord[]>(onPod) });
  await cold.ready();
  return cold;
}
const expectARestartToAgree = async () => { expect(held(await restarted())).toEqual(held(server)); };

const act = async (path: string, payload: object, as: string | undefined = TENDER) => {
  const r = await fetch(`${origin}/agent/xapi-profiles/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(as ? { as } : {}), payload }) });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), body: await r.json() as Record<string, unknown> };
};
const resource = (iri: string) => fetch(`${origin}/xapi/profiles/resource?iri=${encodeURIComponent(iri)}`);

beforeEach(async () => {
  weather = 'lands'; readable = true; onPod = []; composed = []; fetched = [];
  server = makeServer();
  allowance = new SignerHourlyLimit(ADDS_PER_HOUR);
  const verify = async (body: unknown) => {
    const b = body as { as?: string; payload?: Record<string, unknown> };
    return b.as ? { ok: true as const, callerDid: b.as, payload: b.payload ?? {} } : { ok: false as const, status: 401, error: 'not signed' };
  };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountProfileServerWrites(app, server, {
    base: BASE, addTarget: `${BRIDGE}/agent/xapi-profiles/add`, removeTarget: `${BRIDGE}/agent/xapi-profiles/remove`,
    limit: { windowMs: 60_000, limit: ADDRESS_LIMIT }, verify, allowance,
    fetchByUri: async uri => {
      fetched.push(uri);
      if (uri.endsWith('/missing')) throw new ProfileServerError(502, 'The profile could not be fetched: its host answered 404.');
      return bellBuoy(`${OTHER}/v/1`, 'Fog signal', OTHER);
    },
  });
  mountProfileAuthoring(app, new ProfileAuthoring(server, { now: () => new Date('2026-04-01T06:00:00.000Z'), hostedUnder: `${BASE}/p/` }), {
    base: BASE, limit: { windowMs: 60_000, limit: 100_000 }, verify,
    beforePublish: did => { const a = allowance.admit(did); if (!a.ok) throw new ProfileServerError(429, 'as many as one signer may in an hour'); return a.at; },
    publishRefused: (did, at) => { allowance.giveBack(did, at as number); },
  });
  mountProfileHosting(app, server, { base: BASE });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => http.close(() => resolve())); });

describe('a write that landed, with its answer lost', () => {
  it('is an addition: the version is held, and a restart holds it too', async () => {
    weather = 'lands-and-the-answer-is-lost';
    const r = await server.add(bellBuoy(V1), TENDER);
    expect(r.persisted).toBe(true);
    expect(held(server)).toEqual([{ version: V1, label: { en: 'Bell buoy' } }]);
    await expectARestartToAgree();
  });

  it('is a removal: the profile is down, and a restart leaves it down', async () => {
    await server.add(bellBuoy(V1), TENDER);
    weather = 'lands-and-the-answer-is-lost';
    expect(await server.remove(P, TENDER)).toEqual({ removed: [V1], persisted: true });
    expect(held(server)).toEqual([]);
    await expectARestartToAgree();
  });

  it('is a publication: the version is published, and a restart serves it too', async () => {
    const hosted = `${BASE}/p/bell-buoy`;
    const verb = { id: `${hosted}/verbs/inspected`, type: 'Verb', prefLabel: { en: 'inspected' }, definition: { en: 'A tender inspected the buoy.' } };
    const template = { id: `${hosted}/templates/inspection`, prefLabel: { en: 'inspection' }, definition: { en: 'One inspection.' }, verb: verb.id };
    const drafted = await act('draft', { profile: hosted,
      set: { prefLabel: { en: 'Bell buoy' }, definition: { en: 'A made-up profile about inspecting a buoy.' }, author: { type: 'Organization', name: 'Fictional Buoy Tenders' } },
      put: { concepts: [verb], templates: [template] },
      examples: { statements: [{ id: 'an-inspection', follows: [template.id], statement: { actor: { mbox: 'mailto:fictional-tender@example.org' }, verb: { id: verb.id }, object: { id: `${hosted}/buoys/north` } } }] } });
    expect(drafted.body).toMatchObject({ ok: true, publishable: true });
    weather = 'lands-and-the-answer-is-lost';
    const r = await act('publish', { profile: hosted });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, persisted: true, immutable: true });
    expect(server.published(r.body.version as string)).toBeDefined();
    expect((await restarted()).published(r.body.version as string)).toBeDefined();
  });

});

describe('a write the pod neither acknowledged nor let be read back', () => {
  const FOG = `${OTHER}/v/1`;
  const fogSignal = () => bellBuoy(FOG, 'Fog signal', OTHER);

  it('is an addition that landed: in doubt, then held once the pod is read, as a restart held it all along', async () => {
    weather = 'lands-and-the-answer-is-lost'; readable = false;
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
    // Not said to be kept, and not said to be not kept. Here it is not held yet; the pod has it.
    expect(held(server)).toEqual([]);
    expect(server.unsettled).toBe(1);
    expect(held(await restarted())).toEqual([{ version: V1, label: { en: 'Bell buoy' } }]);
    // Nobody changes the profile meanwhile, its own writer included.
    weather = 'lands';
    await expect(server.add(bellBuoy(V2), TENDER)).rejects.toMatchObject({ status: 409 });
    await expect(server.add(bellBuoy(V1, 'somebody else\'s'), PASSER_BY)).rejects.toMatchObject({ status: 409 });
    // Another profile is written as usual, and its record does not withdraw the one in doubt.
    await server.add(fogSignal(), PASSER_BY);
    expect(onPod.at(-1)!.withdraws).toBeUndefined();
    expect(server.unsettled).toBe(1);

    readable = true;
    await server.settle();
    expect(server.unsettled).toBe(0);
    expect(held(server)).toEqual([{ version: V1, label: { en: 'Bell buoy' } }, { version: FOG, label: { en: 'Fog signal' } }]);
    await expectARestartToAgree();
    // And the profile is its writer's again to change.
    await expect(server.add(bellBuoy(V2), PASSER_BY)).rejects.toMatchObject({ status: 409 });
    await expect(server.add(bellBuoy(V2), TENDER)).resolves.toMatchObject({ persisted: true });
    await expectARestartToAgree();
  });

  it('is an addition that did not land: in doubt, then not held and withdrawn once the pod is read', async () => {
    weather = 'fails'; readable = false;
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
    expect(server.unsettled).toBe(1);
    await expectARestartToAgree();

    weather = 'lands'; readable = true;
    // The next write settles what is in doubt before it does anything else.
    await server.add(fogSignal(), PASSER_BY);
    expect(server.unsettled).toBe(0);
    // The record that failed went to the pod with this one, withdrawn by it.
    expect(onPod.map(r => r.kind)).toEqual(['added', 'added']);
    expect(onPod[1]!.withdraws).toEqual([onPod[0]!.id]);
    expect(held(server)).toEqual([{ version: FOG, label: { en: 'Fog signal' } }]);
    await expectARestartToAgree();
    // The profile is nobody's.
    await expect(server.add(bellBuoy(V1), PASSER_BY)).resolves.toMatchObject({ persisted: true });
  });

  it('is a removal that landed: still answering while in doubt, then down, as a restart had it', async () => {
    await server.add(bellBuoy(V1), TENDER);
    weather = 'lands-and-the-answer-is-lost'; readable = false;
    await expect(server.remove(P, TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
    expect(held(server).map(h => h.version)).toEqual([V1]);
    expect((await resource(V1)).status).toBe(200);
    weather = 'lands';
    await expect(server.add(bellBuoy(V2), TENDER)).rejects.toMatchObject({ status: 409 });
    await expect(server.remove(P, OPERATOR)).rejects.toMatchObject({ status: 409 });

    readable = true;
    await server.settle();
    expect(held(server)).toEqual([]);
    expect((await resource(V1)).status).toBe(404);
    await expectARestartToAgree();
  });

  it('is a removal that did not land: in doubt, then still held', async () => {
    await server.add(bellBuoy(V1), TENDER);
    weather = 'fails'; readable = false;
    await expect(server.remove(P, TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
    weather = 'lands'; readable = true;
    await server.add(fogSignal(), PASSER_BY);
    expect(held(server).map(h => h.version)).toEqual([V1, FOG]);
    await expectARestartToAgree();
    await expect(server.remove(P, TENDER)).resolves.toEqual({ removed: [V1], persisted: true });
    await expectARestartToAgree();
  });

  it('is settled without anyone writing, once the pod can be read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      weather = 'lands-and-the-answer-is-lost'; readable = false;
      await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
      // The pod is still unreadable the first time it is read again.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(server.unsettled).toBe(1);
      readable = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(server.unsettled).toBe(0);
      expect(held(server)).toEqual([{ version: V1, label: { en: 'Bell buoy' } }]);
    } finally { vi.useRealTimers(); }
    await expectARestartToAgree();
  });

  it('is answered over HTTP as in doubt, not as kept and not as not kept, and keeps its count', async () => {
    weather = 'lands-and-the-answer-is-lost'; readable = false;
    const r = await act('add', { profile: bellBuoy(V1) });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, inDoubt: true, change: 'added', iri: V1, profile: P });
    expect(r.body).not.toHaveProperty('persisted');
    expect(r.body).not.toHaveProperty('retry');
    expect((await resource(V1)).status).toBe(404);
    // The same request again is refused while it is in doubt, and that refusal costs nothing.
    weather = 'lands';
    expect((await act('add', { profile: bellBuoy(V1) })).status).toBe(409);
    // The addition in doubt is counted: one more, and the allowance is used up.
    expect((await act('add', { profile: bellBuoy(`${P}/x/1`, 'Another', `${P}/x`) })).status).toBe(200);
    expect((await act('add', { profile: bellBuoy(`${P}/y/1`, 'A third', `${P}/y`) })).status).toBe(429);

    readable = true;
    await server.settle();
    expect((await resource(V1)).status).toBe(200);
    await expectARestartToAgree();

    // A removal in doubt, the same.
    weather = 'lands-and-the-answer-is-lost'; readable = false;
    const gone = await act('remove', { iri: P });
    expect(gone.status).toBe(503);
    expect(gone.body).toMatchObject({ ok: false, inDoubt: true, change: 'removed', iri: P, profile: P });
    expect((await resource(V1)).status).toBe(200);
  });

  it('is a publication: in doubt with the draft kept, then published once the pod is read', async () => {
    const hosted = `${BASE}/p/bell-buoy`;
    const verb = { id: `${hosted}/verbs/inspected`, type: 'Verb', prefLabel: { en: 'inspected' }, definition: { en: 'A tender inspected the buoy.' } };
    await act('draft', { profile: hosted, set: { prefLabel: { en: 'Bell buoy' }, definition: { en: 'A made-up profile about inspecting a buoy.' }, author: { type: 'Organization', name: 'Fictional Buoy Tenders' } }, put: { concepts: [verb] } });
    weather = 'lands-and-the-answer-is-lost'; readable = false;
    const r = await act('publish', { profile: hosted });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, inDoubt: true, change: 'published', profile: hosted, draftKept: true });
    const version = r.body.iri as string;
    expect(server.published(version)).toBeUndefined();
    readable = true;
    await server.settle();
    expect(server.published(version)).toBeDefined();
    expect((await restarted()).published(version)).toBeDefined();
  });
});

describe('a write that failed, and goes to the pod with the next one that lands', () => {
  it('is an addition: a restart does not hold the version this server said it did not add', async () => {
    weather = 'fails';
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    weather = 'lands';
    await server.add(bellBuoy(`${OTHER}/v/1`, 'Fog signal', OTHER), PASSER_BY);
    // Both records are on the pod now: the failed one went with the one that landed.
    expect(onPod.map(r => r.kind)).toEqual(['added', 'added']);
    expect(held(server)).toEqual([{ version: `${OTHER}/v/1`, label: { en: 'Fog signal' } }]);
    await expectARestartToAgree();
    // And the profile is nobody's: the agent refused then may still add it.
    await expect(server.add(bellBuoy(V1), PASSER_BY)).resolves.toMatchObject({ persisted: true });
    await expectARestartToAgree();
  });

  it('is a replacement: a restart holds the document that was kept, not the one that was not', async () => {
    await server.add(bellBuoy(V1, 'Bell buoy'), TENDER);
    weather = 'fails';
    await expect(server.add(bellBuoy(V1, 'Bell buoy, reworded'), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    weather = 'lands';
    await server.add(bellBuoy(V2, 'Bell buoy, second'), TENDER);
    expect(held(server)).toEqual([{ version: V1, label: { en: 'Bell buoy' } }, { version: V2, label: { en: 'Bell buoy, second' } }]);
    await expectARestartToAgree();
  });

  it('is a removal: a restart still holds the profile this server said it did not take down', async () => {
    await server.add(bellBuoy(V1), TENDER);
    weather = 'fails';
    await expect(server.remove(P, TENDER)).rejects.toBeInstanceOf(RemovalNotKept);
    weather = 'lands';
    await server.add(bellBuoy(`${OTHER}/v/1`, 'Fog signal', OTHER), PASSER_BY);
    expect(onPod.map(r => r.kind)).toEqual(['added', 'removed', 'added']);
    expect(held(server).map(h => h.version)).toEqual([V1, `${OTHER}/v/1`]);
    await expectARestartToAgree();
  });

  it('is withdrawn by the first write that is kept, however many fail before it', async () => {
    weather = 'fails';
    await expect(server.add(bellBuoy(V1, 'first try'), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    await expect(server.add(bellBuoy(V1, 'second try'), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    weather = 'lands';
    await server.add(bellBuoy(V1, 'third try'), TENDER);
    expect(onPod).toHaveLength(3);
    expect(onPod[2]!.withdraws).toEqual([onPod[0]!.id, onPod[1]!.id]);
    expect(held(server)).toEqual([{ version: V1, label: { en: 'third try' } }]);
    await expectARestartToAgree();
    // What was withdrawn is not named again.
    await server.add(bellBuoy(V2, 'next'), TENDER);
    expect(onPod[3]!.withdraws).toBeUndefined();
  });

  it('names a bounded number of records in any one record, however long the pod is down', async () => {
    await server.add(bellBuoy(`${OTHER}/v/1`, 'Fog signal', OTHER), PASSER_BY);
    weather = 'fails';
    const attempts = MAX_WITHDRAWN_BY_ONE_RECORD * 4;
    for (let i = 0; i < attempts; i++) await expect(server.add(bellBuoy(V1, `try ${i}`), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    // Removals wait in the same way.
    await expect(server.remove(OTHER, PASSER_BY)).rejects.toBeInstanceOf(RemovalNotKept);
    // What the bridge's lattice has in hand: one of each distinct record it was sent.
    const inHand = [...new Map(composed.map(r => [r.id, r])).values()];
    for (const r of inHand) expect(r.withdraws?.length ?? 0).toBeLessThanOrEqual(MAX_WITHDRAWN_BY_ONE_RECORD);
    // Past the bound, the change is not sent: only the one record that withdraws, the same each time.
    expect(inHand.filter(r => r.kind === 'added')).toHaveLength(MAX_WITHDRAWN_BY_ONE_RECORD);
    expect(inHand.filter(r => r.kind === 'withdrawn')).toHaveLength(1);
    expect(inHand.filter(r => r.kind === 'removed')).toHaveLength(0);
    expect(JSON.stringify(inHand).length).toBeLessThan(attempts * 600);

    weather = 'lands';
    await server.add(bellBuoy(V1, 'kept at last'), TENDER);
    expect(held(server)).toEqual([{ version: V1, label: { en: 'kept at last' } }, { version: `${OTHER}/v/1`, label: { en: 'Fog signal' } }]);
    await expectARestartToAgree();
    // Nothing is left waiting to be withdrawn.
    await server.add(bellBuoy(V2, 'next'), TENDER);
    expect(onPod.at(-1)!.withdraws).toBeUndefined();
  });

  it('leaves records kept before records had ids replaying as they did', async () => {
    onPod = [{ kind: 'added', doc: bellBuoy(V1), by: TENDER, at: '2026-01-01T00:00:00.000Z' }];
    expect(held(await restarted())).toEqual([{ version: V1, label: { en: 'Bell buoy' } }]);
  });
});

describe('POST /agent/xapi-profiles/add', () => {
  it('adds a profile sent by its contents, and the version answers', async () => {
    const r = await act('add', { profile: bellBuoy(V1) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true, profile: P, version: V1, replaced: false, current: true, addedBy: TENDER, graph: V1, persisted: true,
      document: `${BASE}/profile?iri=${encodeURIComponent(V1)}`, sparql: `${BASE}/sparql`, server: BASE, holonUri: 'urn:test:holon:1',
    });
    expect((await resource(V1)).status).toBe(200);
    await expectARestartToAgree();
  });

  it('adds a profile named by where it is published, and keeps where that was', async () => {
    const r = await act('add', { uri: 'https://buoys.example/fog-signal.jsonld' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, profile: OTHER, version: `${OTHER}/v/1` });
    expect(fetched).toEqual(['https://buoys.example/fog-signal.jsonld']);
    expect(onPod[0]).toMatchObject({ kind: 'added', by: TENDER, source: 'https://buoys.example/fog-signal.jsonld' });
  });

  it('refuses a request nobody signed, and one that sends both a profile and a uri, or neither', async () => {
    expect(await act('add', { profile: bellBuoy(V1) }, '')).toMatchObject({ status: 401, body: { error: 'not signed' } });
    expect((await act('add', { profile: bellBuoy(V1), uri: 'https://buoys.example/x' })).status).toBe(400);
    expect((await act('add', {})).status).toBe(400);
    expect(held(server)).toEqual([]);
  });

  it('answers 503, not ok, with nothing changed and where to send it again, when the pod did not keep it', async () => {
    weather = 'fails';
    const r = await act('add', { profile: bellBuoy(V1) });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, added: false, persisted: false, profile: P, version: V1, retry: `${BRIDGE}/agent/xapi-profiles/add` });
    expect((await resource(V1)).status).toBe(404);
    weather = 'lands';
    expect((await act('add', { profile: bellBuoy(V1) })).status).toBe(200);
    await expectARestartToAgree();
  });

  it('answers 200 when the write landed and only its answer was lost', async () => {
    weather = 'lands-and-the-answer-is-lost';
    const r = await act('add', { profile: bellBuoy(V1) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, persisted: true, holonUri: null });
    expect((await resource(V1)).status).toBe(200);
  });
});

describe('the hourly allowance of a signer', () => {
  it('is spent by the versions a signer adds, and by nothing else', async () => {
    await server.add(bellBuoy(`${OTHER}/v/1`, 'Fog signal', OTHER), PASSER_BY);
    // More refusals than the allowance holds, of every kind: none of them is counted.
    weather = 'fails';
    for (let i = 0; i < ADDS_PER_HOUR + 1; i++) expect((await act('add', { profile: bellBuoy(V1) })).status).toBe(503);
    weather = 'lands';
    for (let i = 0; i < ADDS_PER_HOUR + 1; i++) {
      expect((await act('add', { profile: { id: 'not a profile' } })).status).toBe(400);
      expect((await act('add', {})).status).toBe(400);
      expect((await act('add', { uri: 'https://buoys.example/missing' })).status).toBe(502);
      // Another agent's profile.
      expect((await act('add', { profile: bellBuoy(`${OTHER}/v/2`, 'Fog signal', OTHER) })).status).toBe(409);
    }
    // The whole allowance is still there, and then it is not.
    expect((await act('add', { profile: bellBuoy(V1) })).status).toBe(200);
    expect((await act('add', { profile: bellBuoy(V2) })).status).toBe(200);
    const over = await act('add', { profile: bellBuoy(`${P}/v/3`) });
    expect(over.status).toBe(429);
    expect(Number(over.retryAfter)).toBeGreaterThan(0);
    expect(over.body.retryAfterSeconds).toBeGreaterThan(0);
    // One signer's count is not another's.
    expect((await act('add', { profile: bellBuoy(`${OTHER}/v/2`, 'Fog signal', OTHER) }, PASSER_BY)).status).toBe(200);
  });

  it('is given back for a publication that was not kept', async () => {
    const hosted = `${BASE}/p/bell-buoy`;
    const verb = { id: `${hosted}/verbs/inspected`, type: 'Verb', prefLabel: { en: 'inspected' }, definition: { en: 'A tender inspected the buoy.' } };
    await act('draft', { profile: hosted, set: { prefLabel: { en: 'Bell buoy' }, definition: { en: 'A made-up profile about inspecting a buoy.' }, author: { type: 'Organization', name: 'Fictional Buoy Tenders' } }, put: { concepts: [verb] } });
    weather = 'fails';
    for (let i = 0; i < ADDS_PER_HOUR + 1; i++) expect((await act('publish', { profile: hosted })).status).toBe(503);
    weather = 'lands';
    expect((await act('publish', { profile: hosted })).status).toBe(200);
  });

  it('gives back only what it took', () => {
    const limit = new SignerHourlyLimit(1);
    limit.giveBack(TENDER, 0);
    const first = limit.admit(TENDER, 1_000);
    expect(first).toEqual({ ok: true, at: 1_000 });
    expect(limit.admit(TENDER, 2_000).ok).toBe(false);
    limit.giveBack(TENDER, 1_000);
    limit.giveBack(TENDER, 1_000);
    expect(limit.admit(TENDER, 3_000).ok).toBe(true);
    expect(limit.admit(TENDER, 4_000).ok).toBe(false);
  });

  it('gives back the count of the request that failed, not of a later one that did not', () => {
    const HOUR = 3_600_000;
    const limit = new SignerHourlyLimit(2);
    const failing = limit.admit(TENDER, 0), kept = limit.admit(TENDER, 10_000);
    expect(failing.ok && kept.ok).toBe(true);
    // The earlier request fails after the later one succeeded.
    limit.giveBack(TENDER, 0);
    // An hour after the failed one, the kept one is still inside its hour: one more, not two.
    expect(limit.admit(TENDER, HOUR + 1).ok).toBe(true);
    expect(limit.admit(TENDER, HOUR + 2).ok).toBe(false);
  });
});

describe('POST /agent/xapi-profiles/remove', () => {
  beforeEach(async () => { await server.add(bellBuoy(V1), TENDER); });

  it('is limited by address, with the add route, before a signature is looked at', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < ADDRESS_LIMIT + 2; i++) statuses.push((await act(i % 2 ? 'add' : 'remove', {}, '')).status);
    expect(statuses.slice(0, ADDRESS_LIMIT).every(s => s === 401)).toBe(true);
    expect(statuses.slice(ADDRESS_LIMIT)).toEqual([429, 429]);
  });

  it('takes a profile down for the agent that added it, and it stops answering', async () => {
    const r = await act('remove', { iri: P });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, removed: [V1], persisted: true, server: BASE });
    expect((await resource(V1)).status).toBe(404);
    await expectARestartToAgree();
  });

  it('takes it down for the operator, and for nobody else', async () => {
    expect((await act('remove', { iri: P }, PASSER_BY)).status).toBe(403);
    expect((await resource(V1)).status).toBe(200);
    expect((await act('remove', { iri: P }, OPERATOR)).status).toBe(200);
  });

  it('refuses a request nobody signed, one that names nothing, and one that names what is not held', async () => {
    expect((await act('remove', { iri: P }, '')).status).toBe(401);
    expect((await act('remove', {})).status).toBe(400);
    expect((await act('remove', { iri: `${OTHER}/v/9` })).status).toBe(404);
    expect((await resource(V1)).status).toBe(200);
  });

  it('answers 503, not ok, with the profile still held and where to send it again, when the pod did not keep it', async () => {
    weather = 'fails';
    const r = await act('remove', { iri: P });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, removed: [], persisted: false, iri: P, stillHeld: true, retry: `${BRIDGE}/agent/xapi-profiles/remove` });
    expect((await resource(V1)).status).toBe(200);
    weather = 'lands';
    expect((await act('remove', { iri: P })).status).toBe(200);
    await expectARestartToAgree();
  });
});
