/**
 * A version is published only once its durable write is acknowledged.
 *
 * Before this, `ProfileServer.publish` put the version in the in-memory index first and wrote it
 * to the pod second. When the write failed the answer still said `ok: true, immutable: true`
 * beside `persisted: false`, the version answered until the next restart and then vanished, a
 * retry of the same version was refused as already held, and the writer's draft had been deleted.
 *
 * Everything here is made up: a lighthouse log kept by a fictional harbour trust, and a store that
 * fails on command.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProfileServer, PublicationNotKept, type ProfileRecord } from '../src/xapi-profile-server/service.js';
import { ProfileAuthoring, type Draft, type DraftStore } from '../src/xapi-profile-server/authoring.js';
import { mountProfileAuthoring, mountProfileHosting } from '../src/xapi-profile-server/authoring-http.js';
import type { Json } from '../src/xapi-profile-server/rdf.js';

type Obj = { [key: string]: Json };
const json = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;

const BASE = 'https://bridge.example/xapi/profiles';
const P = `${BASE}/p/lighthouse-log`;
const V1 = `${P}/v/1`, V2 = `${P}/v/2`;
const KEEPER = 'did:example:keeper';
const lang = (en: string) => ({ en });

const metadata = { prefLabel: lang('Lighthouse log'), definition: lang('A made-up profile about tending a lamp.'), author: { type: 'Organization', name: 'Fictional Harbour Trust' } };
const lit = { id: `${P}/verbs/lit`, type: 'Verb', prefLabel: lang('lit'), definition: lang('A keeper lit the lamp.') };
const trimmed = { id: `${P}/verbs/trimmed`, type: 'Verb', prefLabel: lang('trimmed'), definition: lang('A keeper trimmed the wick.') };
const lighting = { id: `${P}/templates/lighting`, prefLabel: lang('lighting'), definition: lang('The lamp being lit.'), verb: lit.id };
const trimming = { id: `${P}/templates/trimming`, prefLabel: lang('trimming'), definition: lang('The wick being trimmed.'), verb: trimmed.id };
const did = (verb: string): Obj => ({ actor: { mbox: 'mailto:fictional-keeper@example.org' }, verb: { id: verb }, object: { id: `${P}/lamps/north` } });

/** A pod that does as it is told. */
type Weather = 'lands' | 'throws' | 'says-nothing' | 'says-no';
let weather: Weather;
let kept: ProfileRecord[];
/** When set, a write waits here until the test lets it go. */
let hold: { reached: () => void; release: Promise<void> } | undefined;

/** A draft store that remembers what it was asked, and can refuse to drop. */
class RememberingStore implements DraftStore {
  readonly drafts = new Map<string, Draft>();
  readonly dropped: string[] = [];
  refuseDrop = false;
  async load(): Promise<Draft[]> { return [...this.drafts.values()]; }
  async save(draft: Draft): Promise<void> { this.drafts.set(draft.profile, json<Draft>(draft)); }
  async drop(profile: string): Promise<void> {
    if (this.refuseDrop) throw new Error('the made-up draft shelf is jammed');
    this.drafts.delete(profile); this.dropped.push(profile);
  }
}

let server: ProfileServer, authoring: ProfileAuthoring, store: RememberingStore, http: Server, origin: string;

const persist = async (record: ProfileRecord) => {
  if (hold) { hold.reached(); await hold.release; }
  if (weather === 'throws') throw new Error('the made-up pod is unreachable');
  if (weather === 'says-nothing') return {};
  if (weather === 'says-no') return { persisted: false, holonUri: 'urn:test:not-really' };
  kept.push(json<ProfileRecord>(record));
  return { persisted: true, holonUri: `urn:test:holon:${kept.length}` };
};
const makeServer = (withPod = true) => new ProfileServer({ builtIn: () => [], ...(withPod ? { persist, hydrate: async () => kept } : {}) });

const act = async (path: string, payload: object, as = KEEPER) => {
  const r = await fetch(`${origin}/agent/xapi-profiles/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as, payload }) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};
const get = (path: string) => fetch(`${origin}${path}`);
const resource = (iri: string) => get(`/xapi/profiles/resource?iri=${encodeURIComponent(iri)}`);
const examplesOf = (iri: string) => get(`/xapi/profiles/examples?iri=${encodeURIComponent(iri)}`);

async function serve(withPod = true): Promise<void> {
  server = makeServer(withPod);
  store = new RememberingStore();
  authoring = new ProfileAuthoring(server, { now: () => new Date('2026-04-01T06:00:00.000Z'), hostedUnder: `${BASE}/p/`, store });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  mountProfileAuthoring(app, authoring, {
    base: BASE, limit: { windowMs: 60_000, limit: 100_000 },
    verify: async body => { const b = body as { as: string; payload: Record<string, unknown> }; return { ok: true as const, callerDid: b.as, payload: b.payload }; },
  });
  mountProfileHosting(app, server, { base: BASE });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

/** The first version, drafted and ready: one verb, one template, one example of it. */
async function draftTheFirstVersion(): Promise<Record<string, unknown>> {
  const r = await act('draft', { profile: P, set: metadata, put: { concepts: [lit], templates: [lighting] },
    examples: { statements: [{ id: 'a-lighting', follows: [lighting.id], statement: did(lit.id) }] } });
  expect(r.body).toMatchObject({ ok: true, version: V1, publishable: true, findings: [] });
  return r.body;
}

/** Nothing anywhere answers for a version, or says a profile has it. */
async function expectNotPublished(version: string): Promise<void> {
  expect((await resource(version)).status).toBe(404);
  expect((await examplesOf(version)).status).toBe(404);
  expect(server.dataset.all().map(h => h.version)).not.toContain(version);
  expect(server.published(version)).toBeUndefined();
  expect(server.dataset.query(`SELECT ?s WHERE { GRAPH <${version}> { ?s ?p ?o } } LIMIT 1`).results?.bindings).toEqual([]);
  expect(kept.flatMap(r => r.kind === 'published' ? [json<{ versions: Obj[] }>(r.doc).versions[0]!.id] : [])).not.toContain(version);
}

beforeEach(async () => { weather = 'lands'; kept = []; hold = undefined; await serve(); });
afterEach(async () => { await new Promise(resolve => http.close(resolve)); });

describe('a publication whose durable write does not land', () => {
  for (const failing of ['throws', 'says-nothing', 'says-no'] as const) {
    it(`publishes nothing and keeps the draft when the pod ${failing}`, async () => {
      const before = await draftTheFirstVersion();
      const shelved = json<Draft>(store.drafts.get(P));
      weather = failing;

      const refused = await act('publish', { profile: P });

      // The answer says so plainly: not ok, not published, not kept, and nothing about immutability.
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ ok: false, published: false, persisted: false, draftKept: true, profile: P, version: V1,
        retry: 'https://bridge.example/agent/xapi-profiles/publish' });
      expect(refused.body.error).toMatch(/was not published/);
      expect(refused.body).not.toHaveProperty('immutable');
      expect(refused.body).not.toHaveProperty('document');
      expect(refused.body).not.toHaveProperty('holonUri');

      // The version is not visible, by any road.
      await expectNotPublished(V1);
      expect((await resource(P)).status).toBe(404);
      expect((await resource(lit.id)).status).toBe(404);
      expect(server.owner(P)).toBeUndefined();

      // The draft is exactly as it was: in the answer, in the list, and on the shelf.
      const after = await act('draft', { profile: P });
      expect(after.body).toMatchObject({ version: V1, publishable: true, document: before.document, examples: before.examples, updatedAt: before.updatedAt });
      expect((await act('draft', {})).body.drafts).toEqual([{ profile: P, version: V1, updatedAt: before.updatedAt }]);
      expect(store.dropped).toEqual([]);
      expect(store.drafts.get(P)).toEqual(shelved);
    });
  }

  it('is retried as the same version once the pod is back, and only then closes the draft', async () => {
    await draftTheFirstVersion();
    weather = 'throws';
    expect((await act('publish', { profile: P })).status).toBe(503);
    expect((await act('publish', { profile: P })).status).toBe(503);

    weather = 'lands';
    const published = await act('publish', { profile: P });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ ok: true, profile: P, version: V1, immutable: true, persisted: true, holonUri: 'urn:test:holon:1',
      examples: `${BASE}/examples?iri=${encodeURIComponent(V1)}` });

    expect((await resource(V1)).status).toBe(200);
    expect(server.published(V1)?.examples.statements.map(e => e.id)).toEqual(['a-lighting']);
    expect(kept.map(r => r.kind)).toEqual(['published']);
    expect((await act('draft', {})).body.drafts).toEqual([]);
    expect(store.dropped).toEqual([P]);
    // And it is there after a restart, which is what "published" was promising.
    const again = makeServer();
    await again.ready();
    expect(again.dataset.get(P)?.version).toBe(V1);
  });

  it('leaves the version before it current when a revision is not kept', async () => {
    await draftTheFirstVersion();
    expect((await act('publish', { profile: P })).status).toBe(200);
    const revision = await act('draft', { profile: P, put: { concepts: [trimmed], templates: [trimming] },
      examples: { statements: [{ id: 'a-trimming', follows: [trimming.id], statement: did(trimmed.id) }] } });
    expect(revision.body).toMatchObject({ version: V2, revises: V1, publishable: true });

    weather = 'says-no';
    expect((await act('publish', { profile: P })).body).toMatchObject({ ok: false, published: false, version: V2, draftKept: true });
    await expectNotPublished(V2);
    expect(server.dataset.get(P)?.version).toBe(V1);
    expect((await resource(trimmed.id)).status).toBe(404);
    expect((await act('draft', { profile: P })).body).toMatchObject({ version: V2, revises: V1, publishable: true });

    weather = 'lands';
    expect((await act('publish', { profile: P })).body).toMatchObject({ ok: true, version: V2, wasRevisionOf: V1, immutable: true, persisted: true });
    expect(server.dataset.get(P)?.version).toBe(V2);
    expect((await resource(trimmed.id)).status).toBe(200);
  });

  it('is what a server with no durable store answers every time', async () => {
    await new Promise(resolve => http.close(resolve));
    await serve(false);
    await draftTheFirstVersion();
    const refused = await act('publish', { profile: P });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ ok: false, published: false, persisted: false, draftKept: true });
    expect(refused.body.error).toMatch(/no durable store/);
    await expectNotPublished(V1);
    await expect(authoring.publish(P, KEEPER)).rejects.toBeInstanceOf(PublicationNotKept);
    expect((await act('draft', {})).body.drafts).toHaveLength(1);
  });
});

describe('while the durable write is still on its way', () => {
  it('the version answers nowhere, and is nobody else\'s to take', async () => {
    await draftTheFirstVersion();
    let reached!: () => void, release!: () => void;
    const atThePod = new Promise<void>(resolve => { reached = resolve; });
    hold = { reached, release: new Promise<void>(resolve => { release = resolve; }) };

    const publishing = act('publish', { profile: P });
    await atThePod;
    await expectNotPublished(V1);
    expect((await resource(P)).status).toBe(404);
    // The same version is not added or published beside it, and the profile is not another agent's meanwhile.
    const doc = { '@context': 'https://w3id.org/xapi/profiles/context', id: P, type: 'Profile', versions: [{ id: V1 }] };
    await expect(server.add(doc, KEEPER)).rejects.toMatchObject({ status: 409 });
    await expect(server.add({ ...doc, versions: [{ id: `${P}/v/other` }] }, 'did:example:passer-by')).rejects.toMatchObject({ status: 409 });
    await expect(authoring.publish(P, KEEPER)).rejects.toMatchObject({ status: 409 });
    // An IRI is a profile or a version, not both: nobody adds a profile named as the version on
    // its way, or a version named as the profile on its way.
    const other = { '@context': 'https://w3id.org/xapi/profiles/context', type: 'Profile' };
    await expect(server.add({ ...other, id: V1, versions: [{ id: `${V1}/v/1` }] }, 'did:example:passer-by')).rejects.toMatchObject({ status: 409 });
    await expect(server.add({ ...other, id: `${BASE}/p/elsewhere`, versions: [{ id: P }] }, 'did:example:passer-by')).rejects.toMatchObject({ status: 409 });

    hold = undefined;
    release();
    expect((await publishing).body).toMatchObject({ ok: true, version: V1, persisted: true });
    expect((await resource(V1)).status).toBe(200);
    expect(kept).toHaveLength(1);
  });
});

describe('the room a server has', () => {
  // Two made-up versions that each fit in what is left, and do not fit together.
  const padding = 'x'.repeat(200_000);
  const big = (name: string): Obj => ({ '@context': 'https://w3id.org/xapi/profiles/context', id: `${BASE}/p/${name}`, type: 'Profile',
    versions: [{ id: `${BASE}/p/${name}/v/1` }], definition: lang(padding) });
  const none = { statements: [], sequences: [] };
  const fill = async () => {
    // 49 documents of about 250 KB: a little over 300 KB short of the 12 MB the server keeps.
    for (let i = 0; i < 49; i++) await server.add({ ...big(`ballast-${i}`), definition: lang('y'.repeat(250_000)) }, KEEPER);
  };

  it('counts a publication on its way, so two that do not fit together are not both written', async () => {
    await fill();
    let reached!: () => void, release!: () => void;
    const atThePod = new Promise<void>(resolve => { reached = resolve; });
    hold = { reached, release: new Promise<void>(resolve => { release = resolve; }) };
    const before = kept.length;

    const first = server.publish(big('first'), none, [], KEEPER, '2026-04-01T06:00:00.000Z');
    await atThePod;
    await expect(server.publish(big('second'), none, [], KEEPER, '2026-04-01T06:00:01.000Z')).rejects.toMatchObject({ status: 507 });
    await expect(server.add(big('third'), KEEPER)).rejects.toMatchObject({ status: 507 });
    hold = undefined;
    release();
    await expect(first).resolves.toMatchObject({ persisted: true });
    expect(kept.length).toBe(before + 1);
  });

  it('is given back when a publication is not kept', async () => {
    await fill();
    weather = 'throws';
    await expect(server.publish(big('first'), none, [], KEEPER, '2026-04-01T06:00:00.000Z')).rejects.toBeInstanceOf(PublicationNotKept);
    weather = 'lands';
    await expect(server.publish(big('second'), none, [], KEEPER, '2026-04-01T06:00:01.000Z')).resolves.toMatchObject({ persisted: true });
  });
});

describe('a publication that was kept', () => {
  it('is reported as published even when the stored draft cannot be dropped', async () => {
    await draftTheFirstVersion();
    store.refuseDrop = true;
    const published = await act('publish', { profile: P });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ ok: true, version: V1, immutable: true, persisted: true });
    expect((await act('draft', {})).body.drafts).toEqual([]);
  });
});

describe('a writer is told the examples will be public', () => {
  it('in every draft answer, before anything is published', async () => {
    const draft = await draftTheFirstVersion();
    expect(draft.examplesWhenPublished).toMatch(/^Public\./);
    expect(draft.examplesWhenPublished).toContain(`${BASE}/examples?iri=`);
    expect((await examplesOf(V1)).status).toBe(404);
    await act('publish', { profile: P });
    const open = await (await examplesOf(V1)).json() as { examples: { statements: Array<{ id: string }> } };
    expect(open.examples.statements.map(e => e.id)).toEqual(['a-lighting']);
  });
});
