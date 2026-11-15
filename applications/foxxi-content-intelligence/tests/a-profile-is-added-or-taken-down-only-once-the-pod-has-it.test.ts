/**
 * A profile version is added, and a profile is taken down, only once the durable write is acknowledged.
 *
 * Before this, `ProfileServer.add` held the version first and wrote it to the pod second, and
 * `remove` dropped the profile first and recorded the removal second. When the write failed both
 * still answered `ok: true` beside `persisted: false`. An added version answered until the next
 * restart and then vanished; a replaced version came back as the document it had been; a profile
 * that had been taken down answered again with nobody having added it.
 *
 * Everything here is made up: a tide table kept by a fictional harbour office, and a pod that
 * fails on command.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProfileServer, AdditionNotKept, RemovalNotKept, WriteNotKept, notKeptAnswer, type ProfileRecord } from '../src/xapi-profile-server/service.js';
import { mountProfileHosting } from '../src/xapi-profile-server/authoring-http.js';
import type { Json } from '../src/xapi-profile-server/rdf.js';

type Obj = { [key: string]: Json };
const json = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;

const BASE = 'https://bridge.example/xapi/profiles';
const P = 'https://harbour.example/profiles/tide-table';
const V1 = `${P}/v/1`, V2 = `${P}/v/2`;
const CLERK = 'did:example:harbour-clerk', PASSER_BY = 'did:example:passer-by', OPERATOR = 'did:example:operator';

const tideTable = (version: string, label = 'Tide table'): Obj => ({
  '@context': 'https://w3id.org/xapi/profiles/context', id: P, type: 'Profile',
  prefLabel: { en: label }, definition: { en: 'A made-up profile about reading the tide.' },
  versions: [{ id: version }],
  concepts: [{ id: `${P}/verbs/read`, type: 'Verb', inScheme: version, prefLabel: { en: 'read' }, definition: { en: 'A clerk read the gauge.' } }],
});

/** A pod that does as it is told. */
type Weather = 'lands' | 'throws' | 'says-nothing' | 'says-no';
let weather: Weather;
let kept: ProfileRecord[];
/** When set, a write waits here until the test lets it go. */
let hold: { reached: () => void; release: Promise<void> } | undefined;

const persist = async (record: ProfileRecord) => {
  if (hold) { hold.reached(); await hold.release; }
  if (weather === 'throws') throw new Error('the made-up pod is unreachable');
  if (weather === 'says-nothing') return {};
  if (weather === 'says-no') return { persisted: false, holonUri: 'urn:test:not-really' };
  kept.push(json<ProfileRecord>(record));
  return { persisted: true, holonUri: `urn:test:holon:${kept.length}` };
};
const makeServer = (withPod = true) => new ProfileServer({
  builtIn: () => [], isOperator: did => did === OPERATOR, ...(withPod ? { persist, hydrate: async () => kept } : {}),
});
/** A write stopped at the pod: `atThePod` resolves when it gets there, `release` lets it finish. */
const stopAtThePod = () => {
  let reached!: () => void, release!: () => void;
  const atThePod = new Promise<void>(resolve => { reached = resolve; });
  hold = { reached, release: new Promise<void>(resolve => { release = resolve; }) };
  return { atThePod, release: () => { hold = undefined; release(); } };
};

let server: ProfileServer, http: Server, origin: string;
const resource = (iri: string) => fetch(`${origin}/xapi/profiles/resource?iri=${encodeURIComponent(iri)}`);
const labelOf = (version: string): unknown => (server.dataset.all().find(h => h.version === version)?.doc as Obj | undefined)?.prefLabel;
const versionsHeld = () => server.dataset.all().map(h => h.version);

beforeEach(async () => {
  weather = 'lands'; kept = []; hold = undefined;
  server = makeServer();
  const app = express();
  mountProfileHosting(app, server, { base: BASE });
  http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', () => resolve()));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise(resolve => http.close(resolve)); });

describe('an addition whose durable write does not land', () => {
  for (const failing of ['throws', 'says-nothing', 'says-no'] as const) {
    it(`adds nothing when the pod ${failing}, and the same version is added once it works`, async () => {
      weather = failing;
      const refused = await server.add(tideTable(V1), CLERK).catch(e => e as unknown);

      expect(refused).toBeInstanceOf(AdditionNotKept);
      expect(refused).toMatchObject({ status: 503, profile: P, version: V1 });
      // The version answers nowhere, and the profile is nobody's.
      expect((await resource(V1)).status).toBe(404);
      expect((await resource(P)).status).toBe(404);
      expect(versionsHeld()).toEqual([]);
      expect(server.dataset.query(`SELECT ?s WHERE { GRAPH <${V1}> { ?s ?p ?o } } LIMIT 1`).results?.bindings).toEqual([]);
      expect(kept).toEqual([]);

      // Nobody owns the profile yet, so the retry is anyone's; here the same clerk sends it again.
      weather = 'lands';
      await expect(server.add(tideTable(V1), CLERK)).resolves.toMatchObject({ replaced: false, persisted: true, holonUri: 'urn:test:holon:1' });
      expect((await resource(V1)).status).toBe(200);
      // And it is there after a restart, which is what `persisted` promised.
      const again = makeServer();
      await again.ready();
      expect(again.dataset.all().map(h => h.version)).toEqual([V1]);
    });
  }

  it('leaves a version it would have replaced as the document it was', async () => {
    await server.add(tideTable(V1, 'Tide table'), CLERK);
    weather = 'throws';
    await expect(server.add(tideTable(V1, 'Tide table, corrected'), CLERK)).rejects.toBeInstanceOf(AdditionNotKept);
    expect(labelOf(V1)).toEqual({ en: 'Tide table' });

    weather = 'lands';
    await expect(server.add(tideTable(V1, 'Tide table, corrected'), CLERK)).resolves.toMatchObject({ replaced: true, persisted: true });
    expect(labelOf(V1)).toEqual({ en: 'Tide table, corrected' });
  });

  it('does not make the profile the agent\'s whose write failed', async () => {
    weather = 'throws';
    await expect(server.add(tideTable(V1), PASSER_BY)).rejects.toBeInstanceOf(AdditionNotKept);
    weather = 'lands';
    await expect(server.add(tideTable(V1), CLERK)).resolves.toMatchObject({ persisted: true });
    await expect(server.add(tideTable(V2), PASSER_BY)).rejects.toMatchObject({ status: 409 });
  });

  it('gives back the room it was counted against', async () => {
    const big = (i: number): Obj => ({ '@context': 'https://w3id.org/xapi/profiles/context', id: `https://harbour.example/profiles/ballast-${i}`, type: 'Profile',
      versions: [{ id: `https://harbour.example/profiles/ballast-${i}/v/1` }], definition: { en: 'y'.repeat(250_000) } });
    // Each failed addition is about 250 KB; 60 of them would pass the 12 MB the server keeps if they were counted.
    weather = 'throws';
    for (let i = 0; i < 60; i++) await expect(server.add(big(i), CLERK)).rejects.toBeInstanceOf(AdditionNotKept);
    weather = 'lands';
    await expect(server.add(big(0), CLERK)).resolves.toMatchObject({ persisted: true });
  });
});

describe('a removal whose durable write does not land', () => {
  for (const failing of ['throws', 'says-nothing', 'says-no'] as const) {
    it(`takes nothing down when the pod ${failing}, and the same removal works once it does`, async () => {
      await server.add(tideTable(V1), CLERK);
      await server.add(tideTable(V2), CLERK);
      weather = failing;
      const refused = await server.remove(P, CLERK).catch(e => e as unknown);

      expect(refused).toBeInstanceOf(RemovalNotKept);
      expect(refused).toMatchObject({ status: 503, iri: P });
      // Both versions still answer, and the profile is still the clerk's.
      expect((await resource(V1)).status).toBe(200);
      expect((await resource(V2)).status).toBe(200);
      expect(versionsHeld().sort()).toEqual([V1, V2]);
      await expect(server.add(tideTable(`${P}/v/3`), PASSER_BY)).rejects.toMatchObject({ status: 409 });
      expect(kept.filter(r => r.kind === 'removed')).toEqual([]);

      weather = 'lands';
      const removed = await server.remove(P, CLERK);
      expect(removed.persisted).toBe(true);
      expect([...removed.removed].sort()).toEqual([V1, V2]);
      expect((await resource(V1)).status).toBe(404);
      // And it stays down after a restart.
      const again = makeServer();
      await again.ready();
      expect(again.dataset.all()).toEqual([]);
    });
  }

  it('does not come back at the next start, which a removal only this process knew of would', async () => {
    await server.add(tideTable(V1), CLERK);
    weather = 'says-no';
    await expect(server.remove(V1, OPERATOR)).rejects.toBeInstanceOf(RemovalNotKept);
    // What is held now and what a restart would hold are the same thing.
    const again = makeServer();
    await again.ready();
    expect(again.dataset.all().map(h => h.version)).toEqual(versionsHeld());
  });
});

describe('a server with no durable store', () => {
  it('adds nothing and removes nothing, and says why', async () => {
    const bare = makeServer(false);
    const refused = await bare.add(tideTable(V1), CLERK).catch(e => e as unknown);
    expect(refused).toBeInstanceOf(AdditionNotKept);
    expect((refused as Error).message).toMatch(/no durable store/);
    expect(bare.dataset.all()).toEqual([]);
  });

  it('still says what is wrong with a document before saying it has no store', async () => {
    await expect(makeServer(false).add({ id: P } as never, CLERK)).rejects.toMatchObject({ status: 400 });
  });
});

describe('while a write is on its way to the pod', () => {
  it('an added version answers nowhere, and neither it nor its profile is taken by another', async () => {
    const { atThePod, release } = stopAtThePod();
    const adding = server.add(tideTable(V1), CLERK);
    await atThePod;
    expect((await resource(V1)).status).toBe(404);
    expect(versionsHeld()).toEqual([]);
    await expect(server.add(tideTable(V1), CLERK)).rejects.toMatchObject({ status: 409 });
    await expect(server.add(tideTable(V2), PASSER_BY)).rejects.toMatchObject({ status: 409 });
    release();
    await expect(adding).resolves.toMatchObject({ persisted: true });
    expect((await resource(V1)).status).toBe(200);
  });

  it('a profile being taken down still answers, and is not added to or taken down twice', async () => {
    await server.add(tideTable(V1), CLERK);
    const { atThePod, release } = stopAtThePod();
    const removing = server.remove(P, CLERK);
    await atThePod;
    expect((await resource(V1)).status).toBe(200);
    await expect(server.add(tideTable(V2), CLERK)).rejects.toMatchObject({ status: 409 });
    await expect(server.remove(V1, CLERK)).rejects.toMatchObject({ status: 409 });
    release();
    await expect(removing).resolves.toMatchObject({ removed: [V1], persisted: true });
    // What a restart replays is what is held: nothing.
    const again = makeServer();
    await again.ready();
    expect(again.dataset.all().map(h => h.version)).toEqual(versionsHeld());
    expect(versionsHeld()).toEqual([]);
  });

  it('a profile with a version on its way is not taken down under it', async () => {
    await server.add(tideTable(V1), CLERK);
    const { atThePod, release } = stopAtThePod();
    const adding = server.add(tideTable(V2), CLERK);
    await atThePod;
    await expect(server.remove(P, CLERK)).rejects.toMatchObject({ status: 409 });
    release();
    await adding;
    const again = makeServer();
    await again.ready();
    expect(again.dataset.all().map(h => h.version).sort()).toEqual(versionsHeld().sort());
    expect(versionsHeld().sort()).toEqual([V1, V2]);
  });
});

describe('what a route answers for a write that was not kept', () => {
  it('is not ok, names what was asked, and says where to send it again', async () => {
    weather = 'throws';
    const notAdded = await server.add(tideTable(V1), CLERK).catch(e => e as AdditionNotKept);
    expect(notAdded).toBeInstanceOf(WriteNotKept);
    expect(notKeptAnswer(notAdded as AdditionNotKept, 'https://bridge.example/agent/xapi-profiles/add')).toEqual({
      ok: false, added: false, persisted: false, error: (notAdded as Error).message, profile: P, version: V1,
      retry: 'https://bridge.example/agent/xapi-profiles/add' });

    weather = 'lands';
    await server.add(tideTable(V1), CLERK);
    weather = 'throws';
    const notRemoved = await server.remove(P, CLERK).catch(e => e as RemovalNotKept);
    expect(notKeptAnswer(notRemoved as RemovalNotKept, 'https://bridge.example/agent/xapi-profiles/remove')).toEqual({
      ok: false, removed: [], persisted: false, error: (notRemoved as Error).message, iri: P, stillHeld: true,
      retry: 'https://bridge.example/agent/xapi-profiles/remove' });
    expect((notRemoved as Error).message).toMatch(/was not taken down/);
  });
});
