/**
 * Regression guard for the public-memory commons (PRs #74/#75 + the persist-binding fix).
 *
 * The invariant: a lattice label that is marked PUBLIC (node-addressable by content hash
 * without auth) must be backed by a resource that holds ONLY already-published content —
 * never the per-agent `shared-lattice` resource that also carries private corpus. If that
 * separation breaks, resolvePublicNode becomes a cross-tenant existence oracle (resolve a
 * PRIVATE atom by hash) — exactly what the design forbids. These tests fail if a future
 * change re-points a public label at the private default, drops the resourceName threading,
 * or lets resolvePublicNode search private labels.
 *
 * Fully in-memory: the encryption keypair is derived from a test seed and the pod is a
 * fake fetch (no CSS, no network) — safe to run alongside the pod-touching suites.
 */
process.env.FOXXI_WALLET_SEED ||= 'public-memory-commons-regression-seed';

import { describe, it, expect } from 'vitest';
import {
  composeIntoSharedLattice, resolvePublicNode,
  dereferenceTerm, isResident, persistedLatticeArtifacts, readArtifact,
} from '../src/foundation-shared-lattice.js';

/** An in-memory pod: GET a lattice/key resource = 404 (absent, so instances start fresh
 *  and no owner key is added), PUT = accepted with a bumped etag, HEAD = current etag.
 *  Records every request so a test can assert WHICH resource a compose wrote to. */
function makePodFetch(failedHolonPuts = 0) {
  const requests: Array<{ method: string; url: string }> = [];
  const etags = new Map<string, number>();
  const bodies = new Map<string, string>();
  let replacementAfterPut: string | undefined;
  const fetchFn = (async (url: string | URL, opts: { method?: string; body?: unknown } = {}) => {
    const u = String(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    requests.push({ method, url: u });
    if (method === 'GET') return bodies.has(u)
      ? new Response(bodies.get(u)!, { status: 200, headers: { etag: `"v${etags.get(u) ?? 0}"` } })
      : new Response(null, { status: 404 });
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { etag: `"v${etags.get(u) ?? 0}"` } });
    if (method === 'PUT') {
      if (u.endsWith('.holon.json')) {
        if (failedHolonPuts-- > 0) return new Response(null, { status: 503 });
        bodies.set(u, String(opts.body));
        etags.set(u, (etags.get(u) ?? 0) + 1);
        if (replacementAfterPut !== undefined) {
          bodies.set(u, replacementAfterPut); replacementAfterPut = undefined;
          etags.set(u, (etags.get(u) ?? 0) + 1);
        }
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200 });                              // container / descriptor
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const holonPuts = () => requests.filter(r => r.method === 'PUT' && r.url.endsWith('.holon.json')).map(r => r.url);
  const descriptorPuts = () => requests.filter(r => r.method === 'PUT' && r.url.endsWith('.ttl')).map(r => r.url);
  return { fetchFn, holonPuts, descriptorPuts,
    advanceEtag: (u: string) => etags.set(u, (etags.get(u) ?? 0) + 1),
    bodyAt: (u: string) => bodies.get(u),
    replaceAfterNextHolonPut: (body: string) => { replacementAfterPut = body; },
  };
}

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const term = (iri: string): [string, string, string][] => [[iri, RDFS + 'label', 'x']];

describe('public-memory commons — resource isolation', () => {
  it('persists a private activity stream without publishing a discoverable descriptor', async () => {
    const { fetchFn, holonPuts, descriptorPuts } = makePodFetch();
    const result = await composeIntoSharedLattice({
      podUrl: 'https://pod.test-private-stream.example/agent/',
      agentDid: 'did:test:private-stream', label: 'private-stream', resourceName: 'private-stream',
      terms: ['https://x.example/private-operation'], content: { source: 'private-runtime' },
      contentType: 'xapi:Statement', publishDescriptor: false, fetch: fetchFn,
    });
    expect(result?.persisted).toBe(true);
    expect(holonPuts()).toHaveLength(1);
    expect(descriptorPuts()).toEqual([]);
  }, 30000);

  it('routes a public memory to a resource DISJOINT from the private shared-lattice', async () => {
    const { fetchFn, holonPuts, descriptorPuts } = makePodFetch();
    const pod = 'https://pod.test-disjoint.example/agent/';

    // A private artifact (the agent's own corpus) → the default `shared-lattice` resource.
    await composeIntoSharedLattice({
      podUrl: pod, agentDid: 'did:test:priv', label: 'disjoint-priv',
      terms: ['https://x.example/private-course'], termGroups: [term('https://x.example/private-course')],
      content: { secret: true }, contentType: 'foxxi:Course', projections: ['rdf'], fetch: fetchFn,
    });
    // A published memory → a DEDICATED `public-memories` resource.
    await composeIntoSharedLattice({
      podUrl: pod, agentDid: 'did:test:pub', label: 'disjoint-pub', resourceName: 'public-memories',
      terms: ['https://x.example/memory/aid'], termGroups: [term('https://x.example/memory/aid')],
      content: { kind: 'job-aid' }, contentType: 'foxxi:Memory', projections: ['rdf'], publicLattice: true, fetch: fetchFn,
    });

    const puts = holonPuts();
    expect(puts.some(u => u.endsWith('/foxxi-lattice/shared-lattice.holon.json'))).toBe(true);
    expect(puts.some(u => u.endsWith('/foxxi-lattice/public-memories.holon.json'))).toBe(true);
    expect(descriptorPuts()).toHaveLength(2);
    // The public memory NEVER wrote to the private resource — disjoint, not merged.
    expect(holonPuts().filter(u => u.endsWith('/public-memories.holon.json'))
      .every(u => !u.endsWith('/shared-lattice.holon.json'))).toBe(true);
  });

  it('resolvePublicNode serves only PUBLIC labels — a private atom is not addressable', async () => {
    // Ephemeral = no network; exercises residence + the public/private split directly.
    const pod = 'https://pod.test-oracle.example/agent/';
    const memIri = 'https://x.example/memory/oracle-aid';
    const privIri = 'https://x.example/private/oracle-secret';

    await composeIntoSharedLattice({
      podUrl: pod, agentDid: 'did:test:pub', label: 'oracle-public', ephemeral: true, publicLattice: true,
      terms: [memIri], termGroups: [term(memIri)], content: { kind: 'job-aid' }, contentType: 'foxxi:Memory', projections: ['rdf'],
    });
    await composeIntoSharedLattice({
      podUrl: pod, agentDid: 'did:test:priv', label: 'oracle-private', ephemeral: true, /* NOT public */
      terms: [privIri], termGroups: [term(privIri)], content: { secret: true }, contentType: 'foxxi:Course', projections: ['rdf'],
    });

    const memHash = String(dereferenceTerm('oracle-public', memIri)?.atomUri).split('/').pop()!;
    const privHash = String(dereferenceTerm('oracle-private', privIri)?.atomUri).split('/').pop()!;
    expect(memHash).toMatch(/^[0-9a-f]{6,64}$/);
    expect(privHash).toMatch(/^[0-9a-f]{6,64}$/);

    // The published memory resolves; the private atom (same pod, non-public label) does not.
    expect(resolvePublicNode('atom', memHash)).not.toBeNull();
    expect(resolvePublicNode('atom', privHash)).toBeNull();
  });

  it('binds a public label to its resource for the process lifetime (persist cannot be re-pointed)', async () => {
    const { fetchFn, holonPuts } = makePodFetch();
    const pod = 'https://pod.test-binding.example/agent/';
    const mk = (iri: string, resourceName?: string) => composeIntoSharedLattice({
      podUrl: pod, agentDid: 'did:test:pub', label: 'binding-pub', resourceName,
      terms: [iri], termGroups: [term(iri)], content: { kind: 'job-aid' }, contentType: 'foxxi:Memory',
      projections: ['rdf'], publicLattice: true, fetch: fetchFn,
    });

    await mk('https://x.example/memory/first', 'public-memories');   // binds the label → public-memories.holon.json
    await mk('https://x.example/memory/second');                     // NO resourceName — must still persist there
    expect(isResident('binding-pub')).toBe(true);

    // Every holon write for this label went to the dedicated resource. Before the persist-
    // binding fix the second compose would have written to shared-lattice.holon.json (the
    // load stayed on public-memories, tearing load and persist apart).
    const puts = holonPuts();
    expect(puts.length).toBeGreaterThanOrEqual(2);
    expect(puts.every(u => u.endsWith('/foxxi-lattice/public-memories.holon.json'))).toBe(true);
    expect(puts.some(u => u.endsWith('/shared-lattice.holon.json'))).toBe(false);
    // ★ AN EXPLICIT BUDGET, BECAUSE THE DEFAULT 5s WAS MEASURING MACHINE LOAD, NOT THIS CODE.
    // vitest.config.ts runs the files one at a time on one worker (singleFork under vitest 3, a
    // single isolated worker since vitest 4): under the whole-suite run in CI (4,400+ tests,
    // ~300s) this test's timer can expire while it is queued behind a neighbour. It timed out in
    // CI, passed on a bare re-run of the same commit, and passes locally — the classic shape.
    // Nothing here is latency-sensitive; the assertions are about WHICH resource was written, so a
    // larger budget weakens nothing and stops a false red on a gate that is now a deploy
    // precondition.
  }, 30000);
});

describe('shared lattice duplicate encrypted snapshots', () => {
  const argsFor = (label: string, fetch: typeof globalThis.fetch) => ({
    podUrl: `https://pod.test-${label}.example/agent/`, agentDid: 'did:test:duplicate',
    label, terms: ['urn:test:event'], content: { id: 'same-event', result: 1 },
    contentType: 'xapi:Statement', publishDescriptor: false, fetch,
  });

  it('acknowledges an identical artifact with one encrypted PUT and writes changed content', async () => {
    const pod = makePodFetch(), args = argsFor('same-snapshot', pod.fetchFn);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    expect(pod.holonPuts()).toHaveLength(1);
    expect((await composeIntoSharedLattice({ ...args, content: { ...args.content, result: 2 } }))?.persisted).toBe(true);
    expect(pod.holonPuts()).toHaveLength(2);
  }, 30000);

  it('does not skip after another writer changes the resource ETag', async () => {
    const pod = makePodFetch(), args = argsFor('changed-etag', pod.fetchFn);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    pod.advanceEtag(pod.holonPuts()[0]!);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    expect(pod.holonPuts()).toHaveLength(2);
  }, 30000);

  it('reloads and preserves a foreign body when its ETag follows an unconfirmed PUT', async () => {
    const foreign = makePodFetch(), remoteContent = { id: 'foreign-only', result: 'preserve' };
    const remote = { ...argsFor('foreign-receipt-source', foreign.fetchFn),
      terms: ['urn:test:foreign-only'], content: remoteContent };
    expect((await composeIntoSharedLattice(remote))?.persisted).toBe(true);
    const foreignBody = foreign.bodyAt(foreign.holonPuts()[0]!)!;
    const pod = makePodFetch(), args = argsFor('foreign-receipt-destination', pod.fetchFn);
    // Another authorized writer wins after our PUT and before its readback.
    // That readback and the later HEAD both name the foreign body's ETag.
    pod.replaceAfterNextHolonPut(foreignBody);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    const secondContent = { id: 'local-second', result: 2 };
    expect((await composeIntoSharedLattice({ ...args,
      terms: ['urn:test:local-second'], content: secondContent }))?.persisted).toBe(true);
    const durable = await persistedLatticeArtifacts(args.podUrl, 'xapi:Statement', 'shared-lattice', pod.fetchFn);
    expect(durable?.map(artifact => artifact.content)).toEqual(expect.arrayContaining([
      remoteContent, args.content, secondContent,
    ]));
  }, 30000);

  it('retries unconfirmed writes and skips only after a later acknowledged body', async () => {
    const pod = makePodFetch(4), args = argsFor('unconfirmed-snapshot', pod.fetchFn);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(false);
    expect(pod.holonPuts()).toHaveLength(4);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    expect(pod.holonPuts()).toHaveLength(5);
    expect((await composeIntoSharedLattice(args))?.persisted).toBe(true);
    expect(pod.holonPuts()).toHaveLength(5);
  }, 30000);
});

// ── A wide artifact composes in narrow holons ────────────────────────────────────────────
// ingest builds about n^2/2 fragments over a sequence of n items. Each ontology the bridge
// composes at boot has one sub-holon per subject, and all of them went into the final ingest
// together: the bridge held 2.5 GB for eighteen ontologies. Past a small width the sub-holons
// are folded into holons of holons, so the node count grows with the artifact, not its square.
// (Here rather than in a file of its own: this suite is the one that sets the test key seed.)
const noFetch = (async () => { throw new Error('an ephemeral compose must not reach a pod'); }) as unknown as typeof fetch;

async function compose(label: string, subjects: number) {
  const groups = Array.from({ length: subjects }, (_, i) => [
    [`https://x.example/s${i}`, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#Class'],
    [`https://x.example/s${i}`, 'http://www.w3.org/2000/01/rdf-schema#label', `subject ${i}`],
  ]);
  const result = await composeIntoSharedLattice({
    podUrl: 'https://pod.narrow-holons.example/agent/', agentDid: 'did:test:narrow', label,
    terms: [`https://x.example/${label}`], termGroups: groups,
    content: { subjects }, contentType: 'spec:Ontology', projections: ['rdf'],
    ephemeral: true, fetch: noFetch as never,
  });
  if (!result) throw new Error('compose returned nothing');
  return result;
}

describe('a wide artifact composes in narrow holons', () => {
  it('grows with the number of subjects, not its square', async () => {
    const small = await compose('narrow-100', 100);
    const large = await compose('narrow-400', 400);
    // Four times the subjects. A quadratic top level would be about sixteen times the nodes.
    expect(large.stats.totalNodes / small.stats.totalNodes).toBeLessThan(6);
    expect(large.stats.totalNodes).toBeLessThan(400 * 40);
  });

  it('still reads the whole artifact back from the holon', async () => {
    const r = await compose('narrow-readback', 50);
    expect(readArtifact('narrow-readback', r.holonUri)).toEqual({ contentType: 'spec:Ontology', content: { subjects: 50 } });
  });

  it('leaves a holon of few sub-holons as it was', async () => {
    const a = await compose('narrow-same-a', 3);
    const b = await compose('narrow-same-b', 3);
    expect(a.stats.totalNodes).toBe(b.stats.totalNodes);
    expect(a.stats.totalNodes).toBeLessThan(80);
  });
});

// The xAPI Profile Server keeps each added profile version the way the bridge composes it: the
// profile and version as the spine, the record as content, in a dedicated public resource.
describe('an xAPI Profile is kept as a holon and read back whole', () => {
  it('returns the exact record, and costs about what the document does', async () => {
    const { latticeArtifacts } = await import('../src/foundation-shared-lattice.js');
    const id = 'https://example.org/profiles/orchard';
    const doc = {
      id, type: 'Profile', prefLabel: { en: 'Orchard' }, definition: { en: 'A made-up profile with many concepts.' },
      versions: [{ id: `${id}/v1`, generatedAtTime: '2026-01-01T00:00:00Z' }],
      concepts: Array.from({ length: 60 }, (_, i) => ({ id: `${id}/verbs/v${i}`, type: 'Verb', inScheme: `${id}/v1`,
        prefLabel: { en: `verb ${i}`, fr: `verbe ${i}` }, definition: { en: `It says "v${i}".` } })),
    };
    const record = { kind: 'added', doc, by: 'did:test:adder', at: '2026-11-13T00:00:00.000Z' };
    const { fetchFn, holonPuts, bodyAt } = makePodFetch();
    const r = await composeIntoSharedLattice({
      podUrl: 'https://pod.test-profiles.example/commons/', agentDid: 'did:test:adder', label: 'xapi-profiles-test', resourceName: 'xapi-profiles',
      terms: [id, `${id}/v1`],
      content: record, contentType: 'xapi:ProfileRecord', projections: ['rdf'], publicLattice: true, fetch: fetchFn,
    });
    expect(r?.persisted).toBe(true);
    expect(holonPuts().every(u => u.endsWith('/foxxi-lattice/xapi-profiles.holon.json'))).toBe(true);
    expect(latticeArtifacts('xapi-profiles-test', 'xapi:ProfileRecord').map(a => a.content)).toEqual([record]);
    // The profile and its version are nodes of the public lattice.
    expect(dereferenceTerm('xapi-profiles-test', id)?.atomUri).toBeTruthy();
    expect(dereferenceTerm('xapi-profiles-test', `${id}/v1`)?.atomUri).toBeTruthy();
    // Composing every triple instead was measured at about a thousand times the document.
    expect(bodyAt(holonPuts()[0]!)!.length).toBeLessThan(JSON.stringify(doc).length * 6);
  }, 60_000);
});
