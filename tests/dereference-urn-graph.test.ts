/**
 * Kernel dereference for `urn:graph:*` IRIs.
 *
 * Verifies that `kernel.dereference()` resolves a `urn:graph:*` IRI by:
 *   1. Looking it up in a pod's `.well-known/context-graphs` manifest
 *   2. Following the matched descriptor's distribution (`dcat:accessURL`
 *      / `hydra:target`) to the actual graph payload
 *   3. Returning a DereferenceResult shaped identically to the HTTP path
 *      (same body, same status, affordances populated) — keyed against
 *      the URN rather than the underlying HTTP URL.
 *
 * This closes the substrate's hypermedia contract: published manifest
 * entries advertise dereference against urn:graph:* targets, and this
 * branch makes those calls land on the right payload instead of falling
 * through to an impossible HTTP fetch on the URN string itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dereference, clearUrnGraphCache, setSolidModuleForTests } from '@interego/core';
import {
  fetchGraphContent,
  parseManifest,
  parseDistributionFromDescriptorTurtle,
} from '@interego/solid';

// Mock helper — same shape as solid.test.ts so the fetch surface
// matches what kernel.dereference + @interego/solid actually consume.
function mockResponse(
  body: string,
  init: { status?: number; ok?: boolean; contentType?: string } = {},
): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const headers = new Headers();
  if (init.contentType) headers.set('Content-Type', init.contentType);
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => body,
    json: async () => JSON.parse(body),
    headers,
  } as unknown as Response;
}

const POD = 'https://alice.pod/';
const URN_GRAPH = 'urn:graph:alice:observations:2026-Q2';
const DESCRIPTOR_URL = 'https://alice.pod/context-graphs/obs.ttl';
const GRAPH_URL = 'https://alice.pod/context-graphs/obs-graph.trig';

const MANIFEST_TURTLE = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<${DESCRIPTOR_URL}> a iep:ManifestEntry ;
    iep:describes <${URN_GRAPH}> ;
    iep:hasFacetType iep:Trust ;
    iep:trustLevel iep:SelfAsserted .
`;

const DESCRIPTOR_TURTLE = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.
@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/cgh#>.
@prefix dcat: <http://www.w3.org/ns/dcat#>.
@prefix hydra: <http://www.w3.org/ns/hydra/core#>.

<${DESCRIPTOR_URL}> a iep:ContextDescriptor ;
    iep:describes <${URN_GRAPH}> .

<> iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action iep:canFetchPayload ;
    hydra:method "GET" ;
    hydra:target <${GRAPH_URL}> ;
    hydra:returns iep:GraphPayload ;
    hydra:title "Fetch graph payload" ;
    dcat:accessURL <${GRAPH_URL}> ;
    dcat:mediaType "application/trig" ;
    iep:encrypted false
] .
`;

const GRAPH_BODY = `<urn:obs:1> <urn:p:value> "42" .
<urn:obs:2> <urn:p:value> "43" .`;

describe('kernel.dereference(urn:graph:*)', () => {
  beforeEach(() => {
    clearUrnGraphCache();
    // Inject the real @interego/solid module so kernel.dereference can
    // reach it inside vitest's VM context (where the production
    // dynamic-import path is restricted).
    setSolidModuleForTests({
      fetchGraphContent: fetchGraphContent as never,
      parseManifest: parseManifest as never,
      parseDistributionFromDescriptorTurtle: parseDistributionFromDescriptorTurtle as never,
    });
  });

  it('resolves a urn:graph:* via the manifest → descriptor → distribution chain', async () => {
    const calls: string[] = [];

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);

      if (urlStr === `${POD}.well-known/context-graphs`) {
        return mockResponse(MANIFEST_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === DESCRIPTOR_URL) {
        return mockResponse(DESCRIPTOR_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === GRAPH_URL) {
        return mockResponse(GRAPH_BODY, { contentType: 'application/trig' });
      }
      return mockResponse('not-found', { status: 404, ok: false });
    }) as unknown as typeof globalThis.fetch;

    const result = await dereference(URN_GRAPH, {
      fetch: mockFetch as never,
      podHint: POD,
    });

    expect(result.status).toBe('ok');
    expect(result.iri).toBe(URN_GRAPH);
    expect(result.representation).toBe(GRAPH_BODY);
    // Walked manifest → descriptor → graph payload.
    expect(calls).toEqual([
      `${POD}.well-known/context-graphs`,
      DESCRIPTOR_URL,
      GRAPH_URL,
    ]);
  });

  it('returns the same payload as dereferencing the descriptor.ttl URL directly', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === `${POD}.well-known/context-graphs`) {
        return mockResponse(MANIFEST_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === DESCRIPTOR_URL) {
        return mockResponse(DESCRIPTOR_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === GRAPH_URL) {
        return mockResponse(GRAPH_BODY, { contentType: 'application/trig' });
      }
      return mockResponse('not-found', { status: 404, ok: false });
    }) as unknown as typeof globalThis.fetch;

    const viaUrn = await dereference(URN_GRAPH, {
      fetch: mockFetch as never,
      podHint: POD,
    });
    const viaUrl = await dereference(GRAPH_URL, {
      fetch: mockFetch as never,
    });

    expect(viaUrn.status).toBe('ok');
    expect(viaUrl.status).toBe('ok');
    expect(viaUrn.representation).toBe(viaUrl.representation);
    expect(viaUrn.representation).toBe(GRAPH_BODY);
  });

  it('caches the URN→URL mapping so a second dereference skips the manifest scan', async () => {
    const calls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);
      if (urlStr === `${POD}.well-known/context-graphs`) {
        return mockResponse(MANIFEST_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === DESCRIPTOR_URL) {
        return mockResponse(DESCRIPTOR_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === GRAPH_URL) {
        return mockResponse(GRAPH_BODY, { contentType: 'application/trig' });
      }
      return mockResponse('not-found', { status: 404, ok: false });
    }) as unknown as typeof globalThis.fetch;

    await dereference(URN_GRAPH, { fetch: mockFetch as never, podHint: POD });
    const firstCallCount = calls.length;

    await dereference(URN_GRAPH, { fetch: mockFetch as never, podHint: POD });
    // Second call uses the cache — it should only fetch the graph URL,
    // not re-walk the manifest + descriptor.
    expect(calls.length - firstCallCount).toBe(1);
    expect(calls[calls.length - 1]).toBe(GRAPH_URL);
  });

  it('falls back to scanning knownPods when no podHint is supplied', async () => {
    const OTHER_POD = 'https://bob.pod/';
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      // Bob's pod doesn't carry the URN.
      if (urlStr === `${OTHER_POD}.well-known/context-graphs`) {
        return mockResponse(
          `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.\n<https://bob.pod/some.ttl> a iep:ManifestEntry ; iep:describes <urn:graph:bob:other> .\n`,
          { contentType: 'text/turtle' },
        );
      }
      if (urlStr === `${POD}.well-known/context-graphs`) {
        return mockResponse(MANIFEST_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === DESCRIPTOR_URL) {
        return mockResponse(DESCRIPTOR_TURTLE, { contentType: 'text/turtle' });
      }
      if (urlStr === GRAPH_URL) {
        return mockResponse(GRAPH_BODY, { contentType: 'application/trig' });
      }
      return mockResponse('not-found', { status: 404, ok: false });
    }) as unknown as typeof globalThis.fetch;

    const result = await dereference(URN_GRAPH, {
      fetch: mockFetch as never,
      knownPods: [OTHER_POD, POD],
    });

    expect(result.status).toBe('ok');
    expect(result.iri).toBe(URN_GRAPH);
    expect(result.representation).toBe(GRAPH_BODY);
  });

  it('returns not-found when no podHint or knownPods supplied', async () => {
    const mockFetch = vi.fn(async () => mockResponse('', { status: 500, ok: false })) as unknown as typeof globalThis.fetch;

    const result = await dereference(URN_GRAPH, {
      fetch: mockFetch as never,
    });

    expect(result.status).toBe('not-found');
    expect(result.iri).toBe(URN_GRAPH);
    // No HTTP call ever fires — we have no pod to consult.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns not-found when the URN is not registered in any candidate pod', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === `${POD}.well-known/context-graphs`) {
        // Manifest is well-formed but doesn't carry our URN.
        return mockResponse(
          `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.\n<https://alice.pod/other.ttl> a iep:ManifestEntry ; iep:describes <urn:graph:something-else> .\n`,
          { contentType: 'text/turtle' },
        );
      }
      return mockResponse('', { status: 404, ok: false });
    }) as unknown as typeof globalThis.fetch;

    const result = await dereference(URN_GRAPH, {
      fetch: mockFetch as never,
      podHint: POD,
    });

    expect(result.status).toBe('not-found');
    expect(result.iri).toBe(URN_GRAPH);
  });
});
