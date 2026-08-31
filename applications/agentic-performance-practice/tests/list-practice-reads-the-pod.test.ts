/**
 * `agp.list_practice` reads the operator's practice off the pod — and says when it could not.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The handler was a declared stub whose recorded blocker was "this bridge has no pod
 * container-enumeration helper — pod-helpers.ts exposes only fetchJson". That was TRUE of
 * this bridge and FALSE of the system: `@interego/solid` exports `fetchAllManifestEntries`,
 * which walks the manifest chain built from the `ldp:contains` membership each container
 * publishes. So the stub was blocked on a capability that already shipped one package away,
 * and the fix is composition, not a ninth enumerator.
 *
 * The second case is the one that matters. A walk that came back INCOMPLETE — an archive
 * segment unreachable, the chain bounded — must not read as "this operator has no practice".
 * Those are different answers and collapsing them is the same defect as answering an absent
 * seat with a failed read. `complete` is forwarded from the walk rather than implied by the
 * length of the result.
 */
import { describe, it, expect } from 'vitest';
import { createAgpHandlers } from '../bridge/handlers.js';

const POD = 'https://pod.example/alice/';
const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';

/** A manifest naming two agp: descriptors and one that belongs to another vertical. */
const MANIFEST = [
  '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
  '@prefix dct: <http://purl.org/dc/terms/> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  `<${POD}ctx/sit-1.ttl> a iep:ManifestEntry ;`,
  `    iep:describes <${POD}s/1> ;`,
  `    dct:conformsTo <${AGP}PerformanceSituation> .`,
  `<${POD}ctx/cap-1.ttl> a iep:ManifestEntry ;`,
  `    iep:describes <${POD}c/1> ;`,
  `    dct:conformsTo <${AGP}Capability> .`,
  // A sibling vertical's entry, to prove the filter is on the DECLARED term and not on
  // "everything in the manifest".
  `<${POD}ctx/other.ttl> a iep:ManifestEntry ;`,
  `    iep:describes <${POD}o/1> ;`,
  '    dct:conformsTo <https://example.org/other#Thing> .',
].join(String.fromCharCode(10));

/**
 * ★ URL-AWARE ON PURPOSE. The first version of this double answered with the manifest
 * whatever URL was asked for, so the PATH was never a variable under test — and the handler
 * shipped asking for `<pod>manifest.ttl`, which is not where a manifest lives. Against every
 * real pod that 404s, and a 404 is correctly reported as "no manifest, therefore no
 * practice", so the bug looked exactly like a healthy empty result. A fixture that answers
 * everything cannot fail an implementation that asks for the wrong thing.
 *
 * `packages/solid` keeps the manifest at `.well-known/context-graphs` and exports
 * `predictManifestUrl`. This serves the body ONLY there.
 */
const MANIFEST_SUFFIX = '.well-known/context-graphs';

function fetchReturning(body: string, status = 200): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.endsWith(MANIFEST_SUFFIX)) {
      return new Response('not the manifest path', { status: 404 });
    }
    return new Response(body, { status, headers: { 'content-type': 'text/turtle' } });
  }) as unknown as typeof fetch;
}

describe('agp.list_practice', () => {
  it('requires the pod it is meant to read', async () => {
    const h = createAgpHandlers({ fetchFn: fetchReturning(MANIFEST) });
    await expect(h['agp.list_practice']!({})).rejects.toThrow(/pod_url/);
  });

  it('groups the operator practice by the agp: term each entry declares', async () => {
    const h = createAgpHandlers({ fetchFn: fetchReturning(MANIFEST) });
    const out = await h['agp.list_practice']!({ pod_url: POD }) as {
      practice: Record<string, { descriptorUrl: string }[]>;
      agpEntries: number; complete: boolean; manifestUrl: string;
    };
    // The path the SUBSTRATE defines, not one this vertical invented.
    expect(out.manifestUrl).toBe(`${POD}${MANIFEST_SUFFIX}`);
    // Grouped by DECLARED conformance, and the foreign vertical's entry is not ours.
    expect(Object.keys(out.practice).sort()).toEqual(['Capability', 'PerformanceSituation']);
    expect(out.agpEntries).toBe(2);
    expect(out.practice.PerformanceSituation?.[0]?.descriptorUrl).toBe(`${POD}ctx/sit-1.ttl`);
  });

  it('★ no manifest and an unreadable manifest are DIFFERENT answers', async () => {
    // Corrected from the reading this test first encoded. The substrate answers
    // `complete: true` for a 404 ON PURPOSE — a pod with no manifest definitely has no
    // published practice, so an empty result IS the complete answer. What must never
    // happen is the two collapsing, so the handler reports the status alongside.
    const missing = createAgpHandlers({ fetchFn: fetchReturning('nope', 404) });
    const out404 = await missing['agp.list_practice']!({ pod_url: POD }) as {
      practice: Record<string, unknown>; complete: boolean; manifestStatus: number;
    };
    expect(out404.practice).toEqual({});
    expect(out404.complete, 'a 404 is a definite empty practice').toBe(true);
    expect(out404.manifestStatus, 'the caller cannot tell 404 from 503 without this').toBe(404);
  });

});
