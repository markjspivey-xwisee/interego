/**
 * `dereference()` on a pod manifest can be bounded — and by default still is not.
 *
 * ── ★★ WHY BOTH HALVES MATTER ──────────────────────────────────────────────────────────────
 *
 * This is the most-inherited unbounded read in the system. Dereferencing a manifest expands every
 * archive segment — deliberately un-bounding an index the substrate went to trouble to bound — and
 * then, with decoration on by default, does a SEQUENTIAL descriptor fetch per entry and inlines the
 * result. Most of the 51 unbounded response surfaces an audit found are standing on this one.
 *
 * ★ AND THE DEFAULT MUST NOT MOVE. The relay, the desktop shell and every agent that has learned
 * what a dereference returns are calibrated to the current shape; changing it silently would be a
 * breaking change wearing a fix's clothing. So there are two properties here, and the second is as
 * important as the first: bounded when asked, unchanged when not.
 */

import { describe, it, expect, vi } from 'vitest';
import { dereference } from '@interego/core';

const MANIFEST = 'https://pod.example/.well-known/context-graphs';

/** A manifest listing `n` descriptors, each of which the walker may then fetch. */
function manifestTurtle(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => `
<${MANIFEST}#e${i}> a iep:ManifestEntry ;
    iep:descriptorUrl <https://pod.example/d/${i}.ttl> ;
    iep:describes <urn:graph:thing:${i}> .`).join('\n');
  return `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n${rows}\n`;
}

/** A descriptor carrying one affordance, so decoration has something to attach. */
const DESCRIPTOR = `
@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<https://relay.example/ns/iep/action/x> a iep:Affordance ;
    iep:action <https://relay.example/ns/iep/action/x> ;
    hydra:target <https://pod.example/act> ; hydra:method "POST" .
`;

/**
 * Counts PER-ENTRY fetches so "the bound reduced the WORK" is observable, not assumed.
 *
 * ★ A per-entry request is any fetch that is not the bare manifest document. The walker resolves an
 * entry's descriptor from the entry SUBJECT (`…/context-graphs#e3`), not from a `descriptorUrl`
 * literal — measured, after a first version of this fixture counted a URL prefix the walker never
 * requests and reported zero work for a call that was plainly doing some.
 */
function podFetch(entries: number): { fetch: typeof globalThis.fetch; entryFetches: () => number } {
  let entryFetches = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === MANIFEST) {
      return new Response(manifestTurtle(entries), { status: 200, headers: { 'content-type': 'text/turtle' } });
    }
    if (url.startsWith(MANIFEST) || url.startsWith('https://pod.example/d/')) {
      entryFetches++;
      return new Response(DESCRIPTOR, { status: 200, headers: { 'content-type': 'text/turtle' } });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, entryFetches: () => entryFetches };
}

describe('a manifest dereference can be bounded', () => {
  it('★ returns at most `limit` entries and marks the result partial', async () => {
    const { fetch } = podFetch(30);
    const r = await dereference(MANIFEST, { fetch, decorateManifest: false, limit: 5 });
    expect(r.manifestEntries?.length).toBe(5);
    expect(r.manifestPartial).toBe(true);
    expect(r.manifestTotalEntries).toBe(30);
  });

  it('★★ the bound cuts the WORK, not just the response', async () => {
    // Capping after decoration would still do 30 sequential descriptor fetches. The whole cost of
    // this call is those fetches, so a bound that does not reach them is decorative.
    const { fetch, entryFetches } = podFetch(30);
    await dereference(MANIFEST, { fetch, limit: 4 });
    expect(entryFetches()).toBe(4);
  });

  it('a limit larger than the manifest is not truncation', async () => {
    const { fetch } = podFetch(3);
    const r = await dereference(MANIFEST, { fetch, decorateManifest: false, limit: 50 });
    expect(r.manifestEntries?.length).toBe(3);
    expect(r.manifestPartial).toBeUndefined();
    expect(r.manifestTotalEntries).toBeUndefined();
  });

  it('a limit exactly equal to the count is not truncation', async () => {
    const { fetch } = podFetch(6);
    const r = await dereference(MANIFEST, { fetch, decorateManifest: false, limit: 6 });
    expect(r.manifestPartial).toBeUndefined();
  });
});

describe('★ and the default is unchanged', () => {
  it('no limit means every entry, exactly as before', async () => {
    const { fetch } = podFetch(30);
    const r = await dereference(MANIFEST, { fetch, decorateManifest: false });
    expect(r.manifestEntries?.length).toBe(30);
    expect(r.manifestPartial).toBeUndefined();
  });

  it('a zero or negative limit means no bound, not an empty result', async () => {
    // A caller threading a config value through must not silently get nothing when it is unset.
    const { fetch } = podFetch(8);
    for (const limit of [0, -1, Number.NaN]) {
      const r = await dereference(MANIFEST, { fetch, decorateManifest: false, limit });
      expect(r.manifestEntries?.length, `limit=${limit}`).toBe(8);
    }
  });

  it('decoration still happens for the entries that survive the bound', async () => {
    const { fetch } = podFetch(10);
    const r = await dereference(MANIFEST, { fetch, limit: 2 });
    expect(r.manifestEntries?.length).toBe(2);
    // The point of decoration is the affordance; a bounded call must not return crippled entries.
    expect(r.manifestEntries?.[0]?.affordances?.length).toBe(1);
  });
});
