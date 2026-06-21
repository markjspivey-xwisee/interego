/**
 * Kernel `reduce` verb — fold over a iep:supersedes chain.
 *
 * Verifies the substrate's 9th first-class verb:
 *
 *   1. Walks the iep:supersedes chain back-links from a head IRI to
 *      the chain's origin (cycle defence via Set-of-visited mirrors
 *      delegation.ts:783-795).
 *   2. Applies the declared reducer left-to-right (oldest → newest).
 *   3. Returns the canonical head state PLUS a ReplayProof carrying
 *      chain CIDs (in walk order), the reducer CID, periodic state
 *      checkpoints, and the final head-state CID.
 *   4. Two reducer shapes work: inline { kind: 'turtle-template' }
 *      and a `iep:reducer <iri>` link off the chain head that the
 *      kernel dereferences and classifies.
 *   5. The replay is deterministic — calling reduce twice with the
 *      same inputs yields the same ReplayProof byte-for-byte. That
 *      is the trustlessness contract: any third party with the same
 *      CIDs gets the same proof.
 */

import { describe, it, expect } from 'vitest';
import { reduce, setSolidModuleForTests } from '@interego/core';
import type { IRI } from '@interego/core';

// The reduce verb's default chain walker uses kernel.dereference, which
// loads @interego/solid via dynamic import for HTTP-targeting IRIs. For
// URN inputs the test injects its own fetcher via options.fetch, so the
// solid binding never runs. But the kernel still tries to load it as a
// fallback; injecting a stub-empty module here keeps the test self-
// contained.
setSolidModuleForTests({
  fetchGraphContent: async () => ({ content: null, mediaType: '' }),
  parseManifest: () => [],
});

const G1 = 'urn:graph:reduce-test:g1' as IRI;
const G2 = 'urn:graph:reduce-test:g2' as IRI;
const G3 = 'urn:graph:reduce-test:g3' as IRI;
const REDUCER_IRI = 'urn:iep:reducer:test:merge-template' as IRI;

// Chain: g1 (origin) ← g2 (supersedes g1) ← g3 (HEAD, supersedes g2).
// Each link contributes one triple to the eventual fold.
const G1_BODY = `
@prefix ex:  <https://example.org/test#> .
ex:item1 ex:value "alpha" .
`.trim();

const G2_BODY = `
@prefix ex:  <https://example.org/test#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<${G2}> iep:supersedes <${G1}> .
ex:item2 ex:value "beta" .
`.trim();

const G3_BODY = `
@prefix ex:  <https://example.org/test#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<${G3}> iep:supersedes <${G2}> ;
        iep:reducer <${REDUCER_IRI}> .
ex:item3 ex:value "gamma" .
`.trim();

// Reducer artifact body — a turtle template that emits a marker plus
// the prior + current bodies. The kernel substitutes `{?prior}` and
// `{?current}` placeholders.
const REDUCER_BODY = `
# {?prior}
{?current}
`.trim();

function makeFetcher(): (iri: IRI) => Promise<string | null> {
  const map: Record<string, string> = {
    [G1]: G1_BODY,
    [G2]: G2_BODY,
    [G3]: G3_BODY,
    [REDUCER_IRI]: REDUCER_BODY,
  };
  return async (iri) => map[iri] ?? null;
}

describe('kernel.reduce — fold over a iep:supersedes chain', () => {
  it('walks the chain back to its origin and folds in oldest-first order', async () => {
    const r = await reduce(G3, {
      fetch: makeFetcher(),
      // Inline reducer wins over iep:reducer on the head (so this
      // test exercises the inline path independently of the
      // dereference path).
      reducerSpec: { kind: 'turtle-template', template: REDUCER_BODY },
    });

    expect(r.chainLength).toBe(3);
    expect(r.chainHeadIri).toBe(G3);
    // The head state must contain every link's contribution — the
    // fold is a union under the template.
    expect(r.head).toContain('alpha'); // from g1
    expect(r.head).toContain('beta');  // from g2
    expect(r.head).toContain('gamma'); // from g3

    // ReplayProof shape
    expect(r.replayProof.chainCids).toHaveLength(3);
    expect(r.replayProof.reducerKind).toBe('turtle-template');
    expect(r.replayProof.chainLength).toBe(3);
    expect(r.replayProof.headStateCid).toMatch(/^urn:iep:cid:/);
    expect(r.replayProof.reducerCid).toMatch(/^urn:iep:cid:/);
    // Every chain CID is content-addressed.
    for (const cid of r.replayProof.chainCids) {
      expect(cid).toMatch(/^urn:iep:cid:[0-9a-f]+$/);
    }
    // Final checkpoint is always emitted so verifiers have a state
    // anchor at the head end.
    const last = r.replayProof.checkpoints[r.replayProof.checkpoints.length - 1];
    expect(last).toBeDefined();
    expect(last!.index).toBe(2);
    expect(last!.stateCid).toBe(r.replayProof.headStateCid);
  });

  it('resolves iep:reducer off the chain head when no inline spec is supplied', async () => {
    const r = await reduce(G3, { fetch: makeFetcher() });

    expect(r.chainLength).toBe(3);
    expect(r.replayProof.reducerKind).toBe('turtle-template');
    // The reducer was dereferenced from REDUCER_IRI; its CID anchors
    // the fold.
    expect(r.replayProof.reducerCid).toMatch(/^urn:iep:cid:/);
    expect(r.head).toContain('gamma');
  });

  it('produces deterministic ReplayProofs — same inputs, same proof byte-for-byte', async () => {
    const opts = {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'turtle-template' as const, template: REDUCER_BODY },
    };
    const r1 = await reduce(G3, opts);
    const r2 = await reduce(G3, opts);

    expect(r1.replayProof.chainCids).toEqual(r2.replayProof.chainCids);
    expect(r1.replayProof.reducerCid).toBe(r2.replayProof.reducerCid);
    expect(r1.replayProof.headStateCid).toBe(r2.replayProof.headStateCid);
    expect(r1.replayProof.checkpoints.map(c => c.stateCid))
      .toEqual(r2.replayProof.checkpoints.map(c => c.stateCid));
    expect(r1.head).toBe(r2.head);
  });

  it('emits a checkpoint every `checkpointEvery` links plus the final one', async () => {
    const r = await reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'turtle-template', template: REDUCER_BODY },
      checkpointEvery: 2,
    });

    // Chain length 3, checkpointEvery 2 → checkpoints at indices 1 and 2.
    expect(r.replayProof.checkpoints.map(c => c.index)).toEqual([1, 2]);
  });

  it('halts cleanly when a chain link is unresolvable (broken back-link)', async () => {
    const partial = makeFetcher();
    const fetcher = async (iri: IRI) => (iri === G1 ? null : partial(iri));
    const r = await reduce(G3, {
      fetch: fetcher,
      reducerSpec: { kind: 'turtle-template', template: REDUCER_BODY },
    });
    // g1 unresolvable → walk stops at g2; chain length is 2.
    expect(r.chainLength).toBe(2);
    expect(r.head).toContain('beta');
    expect(r.head).toContain('gamma');
    expect(r.head).not.toContain('alpha');
  });

  it('throws when no reducer is declared and none is supplied inline', async () => {
    // Drop the iep:reducer link from g3.
    const g3NoReducer = G3_BODY.replace(/\s*;\s*iep:reducer <[^>]+>/, '');
    const fetcher = async (iri: IRI): Promise<string | null> => {
      const map: Record<string, string> = {
        [G1]: G1_BODY,
        [G2]: G2_BODY,
        [G3]: g3NoReducer,
      };
      return map[iri] ?? null;
    };
    await expect(reduce(G3, { fetch: fetcher })).rejects.toThrow(/reducer/);
  });

  it('cycle defence — a self-supersession does not loop forever', async () => {
    // g3 supersedes g3 — pathological tampered chain.
    const cyclicG3 = `
@prefix ex:  <https://example.org/test#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
<${G3}> iep:supersedes <${G3}> .
ex:item3 ex:value "gamma" .
`.trim();
    const fetcher = async (iri: IRI): Promise<string | null> =>
      iri === G3 ? cyclicG3 : null;
    const r = await reduce(G3, {
      fetch: fetcher,
      reducerSpec: { kind: 'turtle-template', template: REDUCER_BODY },
    });
    // Walked exactly once before the visited-Set guard tripped.
    expect(r.chainLength).toBe(1);
    expect(r.replayProof.chainLength).toBe(1);
  });

  it('classifies a SHACL-shaped reducer body as shacl-transform', async () => {
    const shaclReducer = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/test#> .
ex:MergeShape a sh:NodeShape ;
    sh:rule [ a sh:TripleRule ; sh:subject sh:this ] .
`.trim();
    const r = await reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'shacl-transform', shape: shaclReducer },
    });
    expect(r.replayProof.reducerKind).toBe('shacl-transform');
    // Under the MVP shacl-transform fold (union), every link's body
    // ends up in the state.
    expect(r.head).toContain('alpha');
    expect(r.head).toContain('beta');
    expect(r.head).toContain('gamma');
  });

  it('traversal:"full" vs "shortest" — auto_supersede_prior writes ALL priors per version; full mode recovers the entire lineage, shortest mode sees only the breadth-shortest path', async () => {
    // Simulates auto_supersede_prior semantics: each version's body
    // back-links to EVERY prior version that names the same graph,
    // not just the immediate predecessor. The shortest-path walker
    // sees only one branch — usually the breadth-shortest (g3 -> g1
    // directly) — so chainLength comes back as 2. The full walker
    // walks the entire transitive supersedes closure and folds in
    // canonical (validFrom-ascending) order, recovering chainLength 3.
    const v1Iri = 'urn:graph:reduce-test:lineage:v1' as IRI;
    const v2Iri = 'urn:graph:reduce-test:lineage:v2' as IRI;
    const v3Iri = 'urn:graph:reduce-test:lineage:v3' as IRI;

    const v1Body = `
@prefix ex:  <https://example.org/test#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${v1Iri}> iep:validFrom "2026-01-01T00:00:00Z"^^xsd:dateTime .
ex:item1 ex:value "v1-alpha" .
`.trim();

    const v2Body = `
@prefix ex:  <https://example.org/test#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${v2Iri}> iep:supersedes <${v1Iri}> ;
           iep:validFrom "2026-02-01T00:00:00Z"^^xsd:dateTime .
ex:item2 ex:value "v2-beta" .
`.trim();

    // v3 supersedes BOTH v1 AND v2 — the auto_supersede_prior pattern.
    const v3Body = `
@prefix ex:  <https://example.org/test#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<${v3Iri}> iep:supersedes <${v1Iri}>, <${v2Iri}> ;
           iep:validFrom "2026-03-01T00:00:00Z"^^xsd:dateTime .
ex:item3 ex:value "v3-gamma" .
`.trim();

    const map: Record<string, string> = {
      [v1Iri]: v1Body,
      [v2Iri]: v2Body,
      [v3Iri]: v3Body,
    };
    const fetcher = async (iri: IRI): Promise<string | null> => map[iri] ?? null;

    // shortest path — auto_supersede_prior makes v3's first
    // iep:supersedes target the breadth-shortest hop, so the walker
    // collapses the lineage to v3 + one ancestor (chainLength 2).
    const shortest = await reduce(v3Iri, {
      fetch: fetcher,
      reducerSpec: { kind: 'turtle-template', template: '# {?prior}\n{?current}' },
      traversal: 'shortest',
    });
    expect(shortest.chainLength).toBe(2);
    expect(shortest.replayProof.chainCids).toHaveLength(2);

    // full traversal — every reachable supersedes target is collected,
    // sorted oldest-first by validFrom, then folded in that order.
    // All three versions land in the head state and the ReplayProof
    // chainCids are emitted in the same canonical order so independent
    // verifiers re-fetching by CID reproduce the result byte-for-byte.
    const full = await reduce(v3Iri, {
      fetch: fetcher,
      reducerSpec: { kind: 'turtle-template', template: '# {?prior}\n{?current}' },
      traversal: 'full',
    });
    expect(full.chainLength).toBe(3);
    expect(full.replayProof.chainCids).toHaveLength(3);
    expect(full.head).toContain('v1-alpha');
    expect(full.head).toContain('v2-beta');
    expect(full.head).toContain('v3-gamma');

    // Deterministic re-run — same inputs produce the same proof.
    const fullAgain = await reduce(v3Iri, {
      fetch: fetcher,
      reducerSpec: { kind: 'turtle-template', template: '# {?prior}\n{?current}' },
      traversal: 'full',
    });
    expect(fullAgain.replayProof.chainCids).toEqual(full.replayProof.chainCids);
    expect(fullAgain.replayProof.headStateCid).toBe(full.replayProof.headStateCid);
  });
});
