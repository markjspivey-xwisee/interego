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
  composeIntoSharedLattice, resolvePublicNode, markLatticePublic,
  dereferenceTerm, isResident,
} from '../src/foundation-shared-lattice.js';

/** An in-memory pod: GET a lattice/key resource = 404 (absent, so instances start fresh
 *  and no owner key is added), PUT = accepted with a bumped etag, HEAD = current etag.
 *  Records every request so a test can assert WHICH resource a compose wrote to. */
function makePodFetch() {
  const requests: Array<{ method: string; url: string }> = [];
  const etags = new Map<string, number>();
  const fetchFn = (async (url: string | URL, opts: { method?: string } = {}) => {
    const u = String(url);
    const method = (opts.method ?? 'GET').toUpperCase();
    requests.push({ method, url: u });
    if (method === 'GET') return new Response(null, { status: 404 });          // absent
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { etag: `"v${etags.get(u) ?? 0}"` } });
    if (method === 'PUT') {
      if (u.endsWith('.holon.json')) { etags.set(u, (etags.get(u) ?? 0) + 1); return new Response(null, { status: 201 }); }
      return new Response(null, { status: 200 });                              // container / descriptor
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const holonPuts = () => requests.filter(r => r.method === 'PUT' && r.url.endsWith('.holon.json')).map(r => r.url);
  return { fetchFn, holonPuts };
}

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const term = (iri: string): [string, string, string][] => [[iri, RDFS + 'label', 'x']];

describe('public-memory commons — resource isolation', () => {
  it('routes a public memory to a resource DISJOINT from the private shared-lattice', async () => {
    const { fetchFn, holonPuts } = makePodFetch();
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
  });
});
