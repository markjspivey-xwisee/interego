/**
 * A profile write is in doubt when the pod neither acknowledged it nor let its own copy be read
 * back, and its profile is then reserved until the pod can be read. Started against a pod address
 * it does not fetch, or with no key to write with, the bridge sent nothing and still answered
 * "could not be read back": every write was in doubt and every profile it touched was refused to
 * everyone until a restart.
 *
 * The profile is made up: a bell buoy and the tender that inspects it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileServer, WriteInDoubt, AdditionNotKept, type ProfileRecord } from '../src/xapi-profile-server/service.js';
import { profilePodStore, type ProfilePodStoreParts } from '../src/xapi-profile-server/pod-store.js';

const P = 'https://buoys.example/profiles/bell-buoy';
const V1 = `${P}/v/1`;
const TENDER = 'did:example:tender';
const PASSER_BY = 'did:example:passer-by';
const POD = 'https://pod.example/buoys/';

const bellBuoy = (version: string) => ({
  '@context': 'https://w3id.org/xapi/profiles/context', id: P, type: 'Profile',
  prefLabel: { en: 'Bell buoy' }, definition: { en: 'A made-up profile about inspecting a buoy.' },
  versions: [{ id: version }],
  concepts: [{ id: `${P}/verbs/inspected`, type: 'Verb', inScheme: version, prefLabel: { en: 'inspected' }, definition: { en: 'A tender inspected the buoy.' } }],
});

/** The made-up pod and the process around it. */
let onPod: ProfileRecord[];
let sent: number;
let key: boolean;
let fetched: boolean;      // whether the pod's address is one the process fetches
let acknowledges: boolean;
let readable: boolean;

const parts = (pod = POD): ProfilePodStoreParts => ({
  pod,
  hasKey: () => key,
  guard: async () => { if (!fetched) throw new Error('target host is private/loopback/link-local'); },
  write: async record => {
    if (!key) return { persisted: false };   // as the bridge's lattice: no key, nothing sent
    sent++;
    onPod.push(JSON.parse(JSON.stringify(record)) as ProfileRecord);
    return { persisted: acknowledges };
  },
  readBack: async () => (key && fetched && readable ? onPod : null),
});

const serverOver = (store = profilePodStore(parts())) => new ProfileServer({ builtIn: () => [], ...store });

beforeEach(() => { onPod = []; sent = 0; key = true; fetched = true; acknowledges = true; readable = true; });

describe('a profile write this process never sent', () => {
  it('with no key: not kept, and the profile is anyone\'s to add straight away', async () => {
    key = false;
    const server = serverOver();
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    expect(server.unsettled).toBe(0);
    expect(sent).toBe(0);
    // Not reserved: somebody else's request reaches the store too, and is answered the same way.
    await expect(server.add(bellBuoy(V1), PASSER_BY)).rejects.toBeInstanceOf(AdditionNotKept);
  });

  it('to an address the process does not fetch: not kept, nothing sent, nothing reserved', async () => {
    fetched = false;
    const server = serverOver();
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(AdditionNotKept);
    expect(server.unsettled).toBe(0);
    expect(sent).toBe(0);
    await expect(server.add(bellBuoy(V1), PASSER_BY)).rejects.toBeInstanceOf(AdditionNotKept);
    // Once the address is fetched, the same request is kept.
    fetched = true;
    await expect(server.add(bellBuoy(V1), TENDER)).resolves.toMatchObject({ persisted: true });
  });

  it('with no pod at all: not kept', async () => {
    const store = profilePodStore(parts(''));
    await expect(store.persist({ kind: 'removed', iri: P, by: TENDER, at: '2026-11-17T00:00:00Z', id: 'r1' } as ProfileRecord)).resolves.toEqual({ persisted: false });
    await expect(store.confirm({ kind: 'removed', iri: P, by: TENDER, at: '2026-11-17T00:00:00Z', id: 'r1' } as ProfileRecord)).resolves.toBe(false);
  });
});

describe('a profile write that was sent', () => {
  it('and whose address stops being fetched before it can be read back: in doubt, not "not kept"', async () => {
    // The write lands and its answer is lost; by the time the pod is read, its address is refused.
    acknowledges = false;
    const store = profilePodStore(parts());
    const guarded: typeof store = { ...store, persist: async (r, h) => { const a = await store.persist(r, h); fetched = false; return a; } };
    const server = serverOver(guarded);
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
    expect(sent).toBe(1);
    expect(server.unsettled).toBe(1);
    // The pod has the record. Once it can be read, the version is held, as a restart would hold it.
    fetched = true;
    await server.settle();
    expect(server.unsettled).toBe(0);
    expect(server.dataset.all().map(h => h.version)).toEqual([V1]);
  });

  it('and was not acknowledged while the pod could not be read: in doubt', async () => {
    acknowledges = false; readable = false;
    const server = serverOver();
    await expect(server.add(bellBuoy(V1), TENDER)).rejects.toBeInstanceOf(WriteInDoubt);
    readable = true;
    await server.settle();
    expect(server.dataset.all().map(h => h.version)).toEqual([V1]);
  });

  it('and was not acknowledged while the pod could be read: kept, because the pod has it', async () => {
    acknowledges = false;
    const server = serverOver();
    await expect(server.add(bellBuoy(V1), TENDER)).resolves.toMatchObject({ persisted: true });
  });

  it('a record refused before sending is remembered for that record only', async () => {
    const store = profilePodStore(parts());
    const record = (id: string): ProfileRecord => ({ kind: 'removed', iri: P, by: TENDER, at: '2026-11-17T00:00:00Z', id } as ProfileRecord);
    fetched = false;
    await store.persist(record('refused'));
    fetched = true; readable = false;
    await expect(store.confirm(record('another'))).resolves.toBeUndefined();
    await expect(store.confirm(record('refused'))).resolves.toBe(false);
    // Asked once: the same id sent again later is judged by the pod.
    await expect(store.confirm(record('refused'))).resolves.toBeUndefined();
  });
});
