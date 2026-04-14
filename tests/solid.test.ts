/**
 * Test suite for @interego/core/solid
 *
 * Covers: publish, discover, subscribe — all with mocked HTTP/WebSocket.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ContextDescriptor,
  publish,
  discover,
  subscribe,
  parseManifest,
} from '../src/index.js';

import type { IRI, ManifestEntry, ContextChangeEvent } from '../src/index.js';

// ── Mock helpers ────────────────────────────────────────────

/** Create a mock Response. */
function mockResponse(
  body: string | object,
  init: { status?: number; statusText?: string; ok?: boolean } = {},
): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok,
    status,
    statusText: init.statusText ?? (ok ? 'OK' : 'Error'),
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: new Headers(),
  } as unknown as Response;
}

/** Build a simple descriptor for testing. */
function testDescriptor(id = 'urn:cg:test-solid') {
  return ContextDescriptor.create(id as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-06-30T23:59:59Z',
    })
.selfAsserted('did:web:alice.example' as IRI)
.build();
}

// ── Sample manifest ─────────────────────────────────────────

const SAMPLE_MANIFEST = `@prefix cg: <https://interego.dev/ns/cg#>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<https://alice.pod/context-graphs/desc-1.ttl> a cg:ManifestEntry ;
    cg:describes <urn:graph:g1> ;
    cg:hasFacetType cg:Temporal ;
    cg:hasFacetType cg:Trust ;
    cg:trustLevel cg:SelfAsserted ;
    cg:validFrom "2026-01-01T00:00:00Z"^^xsd:dateTime ;
    cg:validUntil "2026-06-30T23:59:59Z"^^xsd:dateTime.

<https://alice.pod/context-graphs/desc-2.ttl> a cg:ManifestEntry ;
    cg:describes <urn:graph:g2> ;
    cg:hasFacetType cg:Semiotic ;
    cg:modalStatus cg:Asserted ;
    cg:validFrom "2026-07-01T00:00:00Z"^^xsd:dateTime ;
    cg:validUntil "2026-12-31T23:59:59Z"^^xsd:dateTime.
`;

// ═════════════════════════════════════════════════════════════
//  parseManifest()
// ═════════════════════════════════════════════════════════════

describe('parseManifest', () => {
  it('parses a manifest with multiple entries', () => {
    const entries = parseManifest(SAMPLE_MANIFEST);
    expect(entries).toHaveLength(2);

    expect(entries[0]!.descriptorUrl).toBe('https://alice.pod/context-graphs/desc-1.ttl');
    expect(entries[0]!.describes).toEqual(['urn:graph:g1']);
    expect(entries[0]!.facetTypes).toEqual(['Temporal', 'Trust']);
    expect(entries[0]!.validFrom).toBe('2026-01-01T00:00:00Z');
    expect(entries[0]!.validUntil).toBe('2026-06-30T23:59:59Z');

    expect(entries[1]!.descriptorUrl).toBe('https://alice.pod/context-graphs/desc-2.ttl');
    expect(entries[1]!.describes).toEqual(['urn:graph:g2']);
    expect(entries[1]!.facetTypes).toEqual(['Semiotic']);
  });

  it('returns empty array for empty manifest', () => {
    expect(parseManifest('')).toEqual([]);
    expect(parseManifest('@prefix cg: <https://interego.dev/ns/cg#>.')).toEqual([]);
  });

  it('handles entries without temporal bounds', () => {
    const turtle = `<https://pod/d.ttl> a cg:ManifestEntry ;
    cg:describes <urn:graph:x> ;
    cg:hasFacetType cg:Agent.`;

    const entries = parseManifest(turtle);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.validFrom).toBeUndefined();
    expect(entries[0]!.validUntil).toBeUndefined();
    expect(entries[0]!.facetTypes).toEqual(['Agent']);
  });
});

// ═════════════════════════════════════════════════════════════
//  publish()
// ═════════════════════════════════════════════════════════════

describe('publish', () => {
  it('writes graph, descriptor, and manifest to pod', async () => {
    const calls: { url: string; method: string; body?: string; contentType?: string }[] = [];

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      calls.push({
        url: urlStr,
        method,
        body: init?.body as string | undefined,
        contentType: (init?.headers as Record<string, string>)?.['Content-Type'],
      });

      // GET manifest → 404 (first time)
      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
        return mockResponse('', { status: 404, ok: false });
      }

      // All PUTs succeed
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    const desc = testDescriptor();
    const graphContent = '<urn:s> <urn:p> <urn:o>.';

    const result = await publish(desc, graphContent, 'https://alice.pod/', {
      fetch: mockFetch,
    });

    // Should have made 4 fetch calls: PUT graph, PUT descriptor, GET manifest, PUT manifest
    expect(calls).toHaveLength(4);

    // 1. PUT TriG graph
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('test-solid-graph.trig');
    expect(calls[0]!.contentType).toBe('application/trig');
    expect(calls[0]!.body).toContain('<urn:graph:g1> {');
    expect(calls[0]!.body).toContain('<urn:s> <urn:p> <urn:o>');

    // 2. PUT descriptor Turtle
    expect(calls[1]!.method).toBe('PUT');
    expect(calls[1]!.url).toContain('test-solid.ttl');
    expect(calls[1]!.contentType).toBe('text/turtle');
    expect(calls[1]!.body).toContain('cg:ContextDescriptor');

    // 3. GET existing manifest
    expect(calls[2]!.method).toBe('GET');
    expect(calls[2]!.url).toContain('.well-known/context-graphs');

    // 4. PUT new manifest
    expect(calls[3]!.method).toBe('PUT');
    expect(calls[3]!.url).toContain('.well-known/context-graphs');
    expect(calls[3]!.body).toContain('cg:ManifestEntry');
    expect(calls[3]!.body).toContain('cg:describes');

    // Check result URLs
    expect(result.descriptorUrl).toContain('test-solid.ttl');
    expect(result.graphUrl).toContain('test-solid-graph.trig');
    expect(result.manifestUrl).toContain('.well-known/context-graphs');
  });

  it('appends to existing manifest without duplicating', async () => {
    let manifestContent = SAMPLE_MANIFEST;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';

      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
        return mockResponse(manifestContent);
      }

      if (method === 'PUT' && urlStr.includes('.well-known/context-graphs')) {
        manifestContent = init?.body as string;
        return mockResponse('', { status: 200 });
      }

      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    const desc = testDescriptor('urn:cg:new-desc');
    await publish(desc, '', 'https://alice.pod/', { fetch: mockFetch });

    // Manifest should contain all three entries now
    const entries = parseManifest(manifestContent);
    expect(entries).toHaveLength(3);
  });

  it('throws on HTTP failure when writing graph', async () => {
    const mockFetch = vi.fn(async () => {
      return mockResponse('Forbidden', { status: 403, ok: false });
    }) as unknown as typeof globalThis.fetch;

    const desc = testDescriptor();
    await expect(
      publish(desc, '', 'https://alice.pod/', { fetch: mockFetch }),
    ).rejects.toThrow('Failed to write graph');
  });

  it('uses custom container path', async () => {
    const urls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      urls.push(urlStr);
      if (init?.method === 'GET') return mockResponse('', { status: 404, ok: false });
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await publish(testDescriptor(), '', 'https://alice.pod/', {
      fetch: mockFetch,
      containerPath: 'my-graphs/',
    });

    expect(urls[0]).toContain('my-graphs/');
  });
});

// ═════════════════════════════════════════════════════════════
//  discover()
// ═════════════════════════════════════════════════════════════

describe('discover', () => {
  const podUrl = 'https://alice.pod/';

  function makeFetch(manifest: string = SAMPLE_MANIFEST) {
    return vi.fn(async () => mockResponse(manifest)) as unknown as typeof globalThis.fetch;
  }

  it('returns all entries when no filter is provided', async () => {
    const entries = await discover(podUrl, undefined, { fetch: makeFetch() });
    expect(entries).toHaveLength(2);
  });

  it('filters by facet type', async () => {
    const entries = await discover(podUrl, { facetType: 'Trust' }, { fetch: makeFetch() });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.descriptorUrl).toContain('desc-1');
  });

  it('filters by temporal range (validFrom)', async () => {
    const entries = await discover(
      podUrl,
      { validFrom: '2026-07-01T00:00:00Z' },
      { fetch: makeFetch() },
    );
    // Only desc-2 starts at or after July (desc-1 ends in June, before July)
    expect(entries).toHaveLength(1);
    expect(entries[0]!.descriptorUrl).toContain('desc-2');
  });

  it('filters by temporal range (validUntil)', async () => {
    const entries = await discover(
      podUrl,
      { validUntil: '2026-03-01T00:00:00Z' },
      { fetch: makeFetch() },
    );
    // Only desc-1 starts before March
    expect(entries).toHaveLength(1);
    expect(entries[0]!.descriptorUrl).toContain('desc-1');
  });

  it('filters requiring Trust facet for trustLevel filter', async () => {
    const entries = await discover(
      podUrl,
      { trustLevel: 'SelfAsserted' },
      { fetch: makeFetch() },
    );
    // Only desc-1 has Trust facet type
    expect(entries).toHaveLength(1);
  });

  it('filters requiring Semiotic facet for modalStatus filter', async () => {
    const entries = await discover(
      podUrl,
      { modalStatus: 'Asserted' },
      { fetch: makeFetch() },
    );
    // Only desc-2 has Semiotic facet type
    expect(entries).toHaveLength(1);
    expect(entries[0]!.descriptorUrl).toContain('desc-2');
  });

  it('returns empty array when pod has no manifest (404)', async () => {
    const fetch404 = vi.fn(async () =>
      mockResponse('', { status: 404, ok: false }),
    ) as unknown as typeof globalThis.fetch;

    const entries = await discover(podUrl, undefined, { fetch: fetch404 });
    expect(entries).toEqual([]);
  });

  it('throws on non-404 HTTP error', async () => {
    const fetch500 = vi.fn(async () =>
      mockResponse('', { status: 500, ok: false }),
    ) as unknown as typeof globalThis.fetch;

    await expect(discover(podUrl, undefined, { fetch: fetch500 })).rejects.toThrow('Failed to fetch manifest');
  });

  it('combines multiple filters', async () => {
    const entries = await discover(
      podUrl,
      { facetType: 'Temporal', validUntil: '2026-03-01T00:00:00Z' },
      { fetch: makeFetch() },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.descriptorUrl).toContain('desc-1');
  });
});

// ═════════════════════════════════════════════════════════════
//  subscribe()
// ═════════════════════════════════════════════════════════════

describe('subscribe', () => {
  /** Build a mock fetch that follows the 3-step Solid Notifications discovery. */
  function makeSubscribeFetch(opts?: { headFail?: boolean; descFail?: boolean; subFail?: boolean }) {
    let callIndex = 0;
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      callIndex++;
      const method = (init?.method ?? 'GET').toUpperCase();

      // 1st call: HEAD pod URL → Link header with storageDescription
      if (callIndex === 1 && method === 'HEAD') {
        if (opts?.headFail) return mockResponse('', { status: 401, ok: false });
        const resp = mockResponse('');
        // Add Link header via a custom headers object
        (resp as Record<string, unknown>).headers = {
          get: (name: string) => {
            if (name.toLowerCase() === 'link') {
              return '<https://alice.pod/.well-known/solid>; rel="http://www.w3.org/ns/solid/terms#storageDescription"';
            }
            return null;
          },
        };
        return resp;
      }

      // 2nd call: GET storage description (Turtle)
      if (callIndex === 2) {
        if (opts?.descFail) return mockResponse('', { status: 501, ok: false });
        return mockResponse(
          '<https://alice.pod/.notifications/WebSocketChannel2023/> a <http://www.w3.org/ns/solid/notifications#WebSocketChannel2023>.',
        );
      }

      // 3rd call: POST subscription request
      if (callIndex === 3) {
        if (opts?.subFail) return mockResponse('', { status: 403, ok: false });
        return mockResponse({
          type: 'WebSocketChannel2023',
          receiveFrom: 'wss://alice.pod/.notifications/ws/abc123',
        });
      }

      return mockResponse('', { status: 404, ok: false });
    }) as unknown as typeof globalThis.fetch;
  }

  function makeMockWebSocket() {
    let onMsg: ((event: { data: unknown }) => void) | null = null;
    let closed = false;
    const Ctor = vi.fn(function (this: Record<string, unknown>, _url: string) {
      Object.defineProperty(this, 'onmessage', {
        set(fn: (event: { data: unknown }) => void) { onMsg = fn; },
        configurable: true,
      });
      this.close = () => { closed = true; };
    }) as unknown as typeof WebSocket;
    return { Ctor, getOnMessage: () => onMsg, isClosed: () => closed };
  }

  it('negotiates a WebSocket subscription and receives events', async () => {
    const events: ContextChangeEvent[] = [];
    const { Ctor, getOnMessage, isClosed } = makeMockWebSocket();

    const sub = await subscribe('https://alice.pod/', (event) => events.push(event), {
      fetch: makeSubscribeFetch(),
      WebSocket: Ctor,
    });

    // Verify WebSocket was opened to the right URL
    expect(Ctor).toHaveBeenCalledWith('wss://alice.pod/.notifications/ws/abc123');

    const wsOnMessage = getOnMessage();
    expect(wsOnMessage).not.toBeNull();

    wsOnMessage!({ data: JSON.stringify({
      type: 'Add',
      object: 'https://alice.pod/context-graphs/new-desc.ttl',
      published: '2026-03-19T12:00:00Z',
    }) });

    wsOnMessage!({ data: JSON.stringify({
      type: 'Update',
      object: 'https://alice.pod/.well-known/context-graphs',
      published: '2026-03-19T12:01:00Z',
    }) });

    wsOnMessage!({ data: JSON.stringify({
      type: 'Delete',
      object: 'https://alice.pod/context-graphs/old-desc.ttl',
      published: '2026-03-19T12:02:00Z',
    }) });

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      resource: 'https://alice.pod/context-graphs/new-desc.ttl',
      type: 'Add',
      timestamp: '2026-03-19T12:00:00Z',
    });
    expect(events[1]!.type).toBe('Update');
    expect(events[2]!.type).toBe('Remove');

    sub.unsubscribe();
    expect(isClosed()).toBe(true);
  });

  it('throws when storage description is not accessible', async () => {
    const { Ctor } = makeMockWebSocket();
    // HEAD succeeds but GET description fails
    await expect(
      subscribe('https://alice.pod/', () => {}, {
        fetch: makeSubscribeFetch({ descFail: true }),
        WebSocket: Ctor,
      }),
    ).rejects.toThrow('Failed to fetch storage description');
  });

  it('throws when subscription endpoint rejects', async () => {
    const { Ctor } = makeMockWebSocket();
    await expect(
      subscribe('https://alice.pod/', () => {}, {
        fetch: makeSubscribeFetch({ subFail: true }),
        WebSocket: Ctor,
      }),
    ).rejects.toThrow('Failed to subscribe');
  });

  it('ignores unparseable WebSocket messages', async () => {
    const events: ContextChangeEvent[] = [];
    const { Ctor, getOnMessage } = makeMockWebSocket();

    await subscribe('https://alice.pod/', (e) => events.push(e), {
      fetch: makeSubscribeFetch(),
      WebSocket: Ctor,
    });

    getOnMessage()!({ data: 'not json at all' });
    expect(events).toHaveLength(0);
  });
});
