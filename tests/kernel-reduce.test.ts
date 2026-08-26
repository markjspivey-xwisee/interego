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
  // Reports an EMPTY-but-COMPLETE index. `complete: false` would be the wrong stub: this
  // test's IRIs never reach the manifest path at all, and claiming an unreadable archive
  // would make the kernel answer `error` where it should answer `not-found`.
  fetchAllManifestEntries: async () => ({
    entries: [], complete: true, archivesFollowed: 0, archivesUnreachable: [], hotStatus: 404,
  }),
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

  it('classifies a SHACL-shaped reducer body as shacl-transform and RUNS its rule', async () => {
    // ★ THIS FIXTURE USED TO BE `sh:rule [ a sh:TripleRule ; sh:subject sh:this ]` — a rule
    // with no sh:predicate and no sh:object, i.e. not a rule at all. It passed, and it
    // asserted that alpha/beta/gamma all survived the fold. Both facts had the same cause:
    // the MVP fold returned `prior ∪ current` without ever looking at the shape, so an
    // ill-formed rule and a working one were indistinguishable. The assertion was
    // measuring the absence of the feature.
    const shaclReducer = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/test#> .
ex:MergeShape a sh:NodeShape ;
    sh:targetSubjectsOf ex:value ;
    sh:rule [ a sh:TripleRule ;
              sh:subject sh:this ;
              sh:predicate ex:value ;
              sh:object [ sh:path ex:value ] ] .
`.trim();
    const r = await reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'shacl-transform', shape: shaclReducer },
    });
    expect(r.replayProof.reducerKind).toBe('shacl-transform');
    // Every link contributes exactly its ex:value triple, so all three still land — but
    // now because the rule CONSTRUCTED them, not because the fold copied the whole body.
    expect(r.head).toContain('alpha');
    expect(r.head).toContain('beta');
    expect(r.head).toContain('gamma');
    // What the union fold could never do: the iep:supersedes back-links are structural
    // chain plumbing the projection does not select, and they are now absent from the
    // reduced state.
    expect(r.head).not.toContain('supersedes');
  });

  it('refuses an ill-formed sh:TripleRule instead of falling back to the union', async () => {
    const broken = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/test#> .
ex:MergeShape a sh:NodeShape ;
    sh:targetSubjectsOf ex:value ;
    sh:rule [ a sh:TripleRule ; sh:subject sh:this ] .
`.trim();
    await expect(reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'shacl-transform', shape: broken },
    })).rejects.toThrow(/could not be executed/);
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

// ═══════════════════════════════════════════════════════════════
//  The ReplayProof's two hashes
//
//  ★ THE DEFECT THESE EXIST FOR. `reduceCid` hashes the fold's output as a
//  CHARACTER STREAM — no parse, no prefix expansion, no statement sort — and
//  `headStateCid` was the only anchor at the head end of the proof. So two chains
//  stating the IDENTICAL triples, differing only in which prefix alias they bind,
//  what order their statements appear in, and how they are indented, folded to
//  DIFFERENT proofs. A "proof of chain state" was a proof about one serialization
//  of that state, and a verifier who re-serialized the same graph would have been
//  told it had been tampered with.
//
//  The substrate already rewrites payloads exactly that way: `publish()` sends
//  bodies through `wrapAsTriG`, which hoists caller @prefix lines to document
//  scope and re-indents body lines. rdf/graph-digest.ts exists because the
//  AUTHORSHIP path hit this first and hashing the triples is what made both sides
//  agree; the fold simply was not calling it.
//
//  ★ BE PRECISE ABOUT THE SEVERITY. This was latent, not breaking: one
//  deterministic serializer is in play today, so a replay on this build reproduces
//  the CIDs exactly. These tests hold the fix ahead of the day that stops being
//  true — a link republished through a second writer, a mirror, or an independent
//  implementation of the same fold.
// ═══════════════════════════════════════════════════════════════

// The same three links as the chain above — same IRIs, same triples — written by a
// different hand. `q:` instead of `ex:` and `sup:` instead of `iep:`; the payload
// statement moved ahead of the supersedes statement; the two head statements split
// out of a `;` list; indentation and blank lines changed throughout. Every one of
// those is a serialization difference and none of them changes a single triple.
const G1_BODY_RESERIALIZED = `
@prefix q: <https://example.org/test#> .

     q:item1
         q:value   "alpha" .
`.trim();

const G2_BODY_RESERIALIZED = `
@prefix sup: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix q:   <https://example.org/test#> .

q:item2    q:value    "beta" .

  <${G2}>
      sup:supersedes  <${G1}> .
`.trim();

const G3_BODY_RESERIALIZED = `
@prefix sup: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix q:   <https://example.org/test#> .

q:item3   q:value   "gamma" .

<${G3}>  sup:reducer     <${REDUCER_IRI}> .
<${G3}>  sup:supersedes  <${G2}> .
`.trim();

function makeReserializedFetcher(): (iri: IRI) => Promise<string | null> {
  const map: Record<string, string> = {
    [G1]: G1_BODY_RESERIALIZED,
    [G2]: G2_BODY_RESERIALIZED,
    [G3]: G3_BODY_RESERIALIZED,
    [REDUCER_IRI]: REDUCER_BODY,
  };
  return async (iri) => map[iri] ?? null;
}

describe('kernel.reduce — the ReplayProof carries a graph digest beside every byte CID', () => {
  it('two chains stating identical triples in different serializations: the CIDs differ, the graph digests agree', async () => {
    const spec = { kind: 'turtle-template', template: REDUCER_BODY } as const;
    const a = await reduce(G3, { fetch: makeFetcher(), reducerSpec: spec });
    const b = await reduce(G3, { fetch: makeReserializedFetcher(), reducerSpec: spec });

    // Both walkers reached the origin. Asserted because the re-serialized chain binds
    // the iep: namespace to a different alias, and a walker that only regex-scanned for
    // the literal string `iep:supersedes` would silently truncate the chain — which
    // would make every comparison below a comparison of the wrong things.
    expect(a.chainLength).toBe(3);
    expect(b.chainLength).toBe(3);

    // ★ THE MEASUREMENT. Same triples, different bytes → different byte address.
    expect(b.replayProof.headStateCid).not.toBe(a.replayProof.headStateCid);
    expect(b.replayProof.chainCids).not.toEqual(a.replayProof.chainCids);

    // ★ AND THE FIX. The graph digests are equal, and equal to a REAL digest — asserted
    // against the algorithm's own shape first, because "both are null" would otherwise
    // satisfy `toEqual` and report a green test for a fold that digested nothing.
    const digestShape = /^graph-nquads-sha256:[0-9a-f]{64}$/;
    expect(a.replayProof.headStateGraphDigest.digest).toMatch(digestShape);
    expect(b.replayProof.headStateGraphDigest.digest).toBe(
      a.replayProof.headStateGraphDigest.digest,
    );

    // Per link too — `headStateGraphDigest` alone would leave the other half of the
    // proof byte-fragile, so a verifier who re-serialized could tell that something
    // diverged but not which link.
    for (const d of a.replayProof.chainGraphDigests) {
      expect(d.digest).toMatch(digestShape);
    }
    expect(b.replayProof.chainGraphDigests.map((d) => d.digest)).toEqual(
      a.replayProof.chainGraphDigests.map((d) => d.digest),
    );

    // ...and per checkpoint, which is what lets a verifier localize a divergence to a
    // position in the chain rather than only to the head.
    expect(b.replayProof.checkpoints.map((c) => c.stateGraphDigest.digest)).toEqual(
      a.replayProof.checkpoints.map((c) => c.stateGraphDigest.digest),
    );
    // The byte CIDs at those same checkpoints do NOT agree — the pair of assertions is
    // the whole point: one anchor per checkpoint moved, the other did not.
    expect(b.replayProof.checkpoints.map((c) => c.stateCid)).not.toEqual(
      a.replayProof.checkpoints.map((c) => c.stateCid),
    );
  });

  it('an indentation-only change to one link moves the CIDs and leaves the graph digests fixed', async () => {
    // Narrower than the test above and closer to what actually happens in production:
    // `wrapAsTriG` re-indents body lines on the way through `publish()`, so a link that
    // is republished comes back with the same triples and different leading whitespace.
    const spec = { kind: 'turtle-template', template: REDUCER_BODY } as const;
    const reindented = G2_BODY.split('\n').map((l) => `    ${l}`).join('\n');
    const map: Record<string, string> = {
      [G1]: G1_BODY, [G2]: reindented, [G3]: G3_BODY, [REDUCER_IRI]: REDUCER_BODY,
    };

    const before = await reduce(G3, { fetch: makeFetcher(), reducerSpec: spec });
    const after = await reduce(G3, { fetch: async (iri) => map[iri] ?? null, reducerSpec: spec });

    expect(after.chainLength).toBe(3);
    expect(after.replayProof.headStateCid).not.toBe(before.replayProof.headStateCid);
    expect(before.replayProof.headStateGraphDigest.digest).toMatch(/^graph-nquads-sha256:/);
    expect(after.replayProof.headStateGraphDigest.digest).toBe(
      before.replayProof.headStateGraphDigest.digest,
    );
  });

  it('the digests are index-parallel with the CIDs, and the last checkpoint anchors the head', async () => {
    const r = await reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'turtle-template', template: REDUCER_BODY },
      checkpointEvery: 1,
    });

    // A parallel array is only usable if it is the same length as the array it
    // parallels; nothing in the type system enforces that.
    expect(r.replayProof.chainGraphDigests).toHaveLength(r.replayProof.chainCids.length);
    expect(r.replayProof.checkpoints).toHaveLength(3);
    for (const c of r.replayProof.checkpoints) {
      expect(c.stateGraphDigest.digest).toMatch(/^graph-nquads-sha256:[0-9a-f]{64}$/);
    }
    // The final link is always checkpointed, so the head's digest is that checkpoint's.
    const last = r.replayProof.checkpoints[r.replayProof.checkpoints.length - 1]!;
    expect(last.stateGraphDigest.digest).toBe(r.replayProof.headStateGraphDigest.digest);
    // The two hashes stay distinguishable: a CID is never mistaken for a digest.
    expect(r.replayProof.headStateCid).toMatch(/^urn:iep:cid:[0-9a-f]{40}$/);
  });

  it('★ GOLDEN VALUES — the CIDs and the digest are pinned, not just shape-matched', async () => {
    /**
     * ★★ EVERY OTHER ASSERTION IN THIS FILE COMPARES A CID TO ANOTHER CID OR TO A REGEX, SO AN
     * EDIT THAT MOVED EVERY ALREADY-ISSUED `urn:iep:cid:` WAS INVISIBLE. Proved: changing
     * `reduceCid` to hash `s + '\n'` — which reissues every CID the substrate has ever minted,
     * while keeping the byte-sensitivity the relative tests check — left the whole file green.
     * `headStateCid` is the published verification contract (docs/ns/iep.ttl `iep:ReplayProof`);
     * a proof issued against a fold nobody changed has to keep verifying, and a relative
     * assertion cannot say so.
     *
     * These values are not guesses. They are what `reduce` returns today AND what the
     * pre-digest formula at HEAD returns for the same fixture — sha256 of `link.body`, of
     * `state:` + head, and of `reducer:<kind>:<source>`, each sliced to 40 hex characters —
     * recomputed independently and compared field for field. So this test also pins the claim
     * the graph-digest change was landed under: the digests were ADDED and no CID moved.
     *
     * ★ IF YOU ARE HERE BECAUSE THIS TEST FAILED: the fix is almost never to update the
     * constants. A changed value means every ReplayProof already issued now reports tampering
     * on a fold that did not change. Updating them is a migration with a version discriminator
     * on the proof, not a test edit.
     *
     * The graph digest is pinned for the same reason in the other direction: it is a
     * cross-implementation contract (`graph-nquads-sha256` over sorted, prefix-expanded
     * N-Triples), so an independent verifier must compute this exact string or the algorithm
     * label is a lie. Rewriting the canonicaliser silently is what this catches.
     */
    const r = await reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'turtle-template', template: REDUCER_BODY },
    });

    expect(r.replayProof.chainCids).toEqual([
      'urn:iep:cid:0b228b22221a3dde409c777ae6413dd23b393a37', // G1_BODY
      'urn:iep:cid:1315ca1350cf6a479cfd9414306ff23749b0d757', // G2_BODY
      'urn:iep:cid:41e7aa490ed52da5bf332e2615f8f04c8a922463', // G3_BODY
    ]);
    expect(r.replayProof.reducerCid).toBe('urn:iep:cid:c821dd2c175171a379588489d28be94ad0d20eba');
    expect(r.replayProof.headStateCid).toBe('urn:iep:cid:c6ff3947cb45572f2f7566b415602eda6caa1fe0');
    expect(r.replayProof.headStateGraphDigest.digest).toBe(
      'graph-nquads-sha256:9870e76c96cf0c55ab4a92c7790f7db9837d0954b052df4fb0466fae91848837',
    );
    // The single checkpoint (default cadence 8, chain of 3, so only the mandatory final one)
    // anchors the same two values — pinned here because a checkpoint that drifted away from the
    // head would break replay at the position a verifier reports, not at the head.
    expect(r.replayProof.checkpoints).toHaveLength(1);
    expect(r.replayProof.checkpoints[0]!.stateCid).toBe(r.replayProof.headStateCid);
    expect(r.replayProof.checkpoints[0]!.afterLinkCid).toBe(r.replayProof.chainCids[2]);

    // ★ AND THE DISCOVERED-REDUCER PATH MINTS THE SAME PROOF. `iep:reducer` on the chain head
    // resolves to the same body, so passing no `reducerSpec` must not change a single value —
    // otherwise which lookup path a verifier used would decide whether the proof verifies.
    const discovered = await reduce(G3, { fetch: makeFetcher() });
    expect(discovered.replayProof).toEqual(r.replayProof);
  });

  it('a state that does not parse yields a NAMED refusal, not a null and not a byte-hash fallback', async () => {
    // `{?prior}` in object position is the idiom an author writes when they believe the
    // placeholder binds an IRI. It does not — it binds the whole accumulator document —
    // so the materialized state pastes @prefix directives where a term belongs and the
    // result is not parseable Turtle. The fold still completes and still issues a CID.
    const termPositionTemplate = `
@prefix ex: <https://example.org/test#> .
<urn:iep:test:fold-head> ex:derivedFrom {?prior} .
{?current}
`.trim();

    const r = await reduce(G3, {
      fetch: makeFetcher(),
      reducerSpec: { kind: 'turtle-template', template: termPositionTemplate },
    });

    // The byte CID is still minted — it addresses bytes and the bytes exist.
    expect(r.replayProof.headStateCid).toMatch(/^urn:iep:cid:[0-9a-f]{40}$/);
    // ★ The digest refuses, and the refusal carries its cause. A silent fall-back to the
    // byte hash here would put a real-looking `graph-nquads-sha256:` value in the proof
    // that no independent implementation could ever reproduce — the same "three shapes,
    // one CID" ambiguity the shacl-transform branch refuses by rethrowing.
    expect(r.replayProof.headStateGraphDigest.digest).toBeNull();
    const reason = r.replayProof.headStateGraphDigest.reason ?? '';
    expect(reason).toMatch(/did not parse/);
    // It names WHICH piece of the fold failed and it does NOT narrate the authorship
    // path's consequences, which are false of a fold: nothing here signs anything.
    expect(reason).toMatch(/folded head state/);
    expect(reason).not.toMatch(/contentBinding|authorship proof/);
    // The link bodies themselves parse fine — only the materialized state is broken —
    // so a reader can localize the failure to the fold rather than to the chain.
    for (const d of r.replayProof.chainGraphDigests) {
      expect(d.digest).toMatch(/^graph-nquads-sha256:[0-9a-f]{64}$/);
    }
  });
});
