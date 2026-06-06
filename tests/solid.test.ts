/**
 * Test suite for @interego/core/solid
 *
 * Covers: publish, discover, subscribe — all with mocked HTTP/WebSocket.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ContextDescriptor,
  generateKeyPair,
} from '@interego/core';
import {
  discover,
  parseManifest,
  publish,
  subscribe,
} from '@interego/solid';

import type {
  IRI,
  ManifestEntry,
} from '@interego/core';
import type {
  ContextChangeEvent,
} from '@interego/solid';

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

const SAMPLE_MANIFEST = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#>.
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
    expect(parseManifest('@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#>.')).toEqual([]);
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

    // Should have made 5 fetch calls: PUT graph, PUT descriptor, GET manifest,
    // PUT manifest, GET manifest (post-write verification — guards against
    // N-way concurrent silent-clobber where the storage backend accepts
    // multiple If-Match PUTs against the same etag).
    expect(calls).toHaveLength(5);

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

    // 5. GET manifest (post-write verification)
    expect(calls[4]!.method).toBe('GET');
    expect(calls[4]!.url).toContain('.well-known/context-graphs');

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

  it('refuses graph payloads exceeding the size cap before any HTTP write', async () => {
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const desc = testDescriptor();
    // 1 KiB cap, 2 KiB payload — should fail synchronously before fetch.
    await expect(
      publish(desc, 'x'.repeat(2048), 'https://alice.pod/', { fetch: mockFetch, maxGraphBytes: 1024 }),
    ).rejects.toThrow(/graph payload is \d+ bytes; max permitted is 1024 bytes/);
    expect(calls).toBe(0);
  });

  it('uses the default 4 MiB cap when maxGraphBytes is unset', async () => {
    let calls = 0;
    const mockFetch = vi.fn(async () => {
      calls++;
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const desc = testDescriptor();
    // 5 MiB payload, no override → blocked by default cap.
    await expect(
      publish(desc, 'x'.repeat(5 * 1024 * 1024), 'https://alice.pod/', { fetch: mockFetch }),
    ).rejects.toThrow(/max permitted is 4194304 bytes/);
    expect(calls).toBe(0);
  });

  it('counts byte length (not char length) so multibyte UTF-8 counts correctly', async () => {
    const mockFetch = vi.fn(async () => mockResponse('', { status: 201 })) as unknown as typeof globalThis.fetch;
    const desc = testDescriptor();
    // 600 emoji chars × 4 bytes each = 2400 bytes — over a 2 KiB cap
    // even though it's only 600 chars.
    const payload = '🎉'.repeat(600);
    await expect(
      publish(desc, payload, 'https://alice.pod/', { fetch: mockFetch, maxGraphBytes: 2048 }),
    ).rejects.toThrow(/graph payload is 2400 bytes/);
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

  // ── visibility: 'public' | 'shared' | 'private' ────────────────
  //
  // Audience-class signal in the descriptor's affordance block.
  // 'public' MUST NOT encrypt and MUST emit cg:visibility "public" +
  // cg:encrypted false, even when no encrypt option is passed. 'private'
  // looks the same on the wire as a 1-recipient envelope but advertises
  // its narrower intent via cg:visibility "private". 'shared' (and an
  // omitted value) preserve historical descriptor output — no
  // cg:visibility predicate is emitted, so legacy parsers stay happy.
  it('emits cg:visibility "public" + cg:encrypted false when visibility="public"', async () => {
    const writes: { url: string; body?: string }[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      if (method === 'PUT') writes.push({ url: urlStr, body: init?.body as string });
      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
        return mockResponse('', { status: 404, ok: false });
      }
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await publish(testDescriptor(), '<urn:s> <urn:p> <urn:o>.', 'https://alice.pod/', {
      fetch: mockFetch,
      visibility: 'public',
    });

    const graphPut = writes.find(w => w.url.endsWith('-graph.trig'))!;
    expect(graphPut).toBeDefined();           // plaintext TriG, NOT .envelope.jose.json
    const descPut = writes.find(w => w.url.endsWith('.ttl') && !w.url.includes('manifest'))!;
    expect(descPut.body).toContain('cg:encrypted false');
    expect(descPut.body).toContain('cg:visibility "public"');
  });

  it('encrypts and emits cg:visibility "private" when visibility="private"', async () => {
    const writes: { url: string; body?: string }[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      if (method === 'PUT') writes.push({ url: urlStr, body: init?.body as string });
      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
        return mockResponse('', { status: 404, ok: false });
      }
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    const author = generateKeyPair();
    await publish(testDescriptor(), '<urn:s> <urn:p> <urn:o>.', 'https://alice.pod/', {
      fetch: mockFetch,
      visibility: 'private',
      encrypt: { recipients: [author.publicKey], senderKeyPair: author },
    });

    const graphPut = writes.find(w => w.url.endsWith('.envelope.jose.json'))!;
    expect(graphPut).toBeDefined();           // envelope written (ciphertext on the pod)
    const descPut = writes.find(w => w.url.endsWith('.ttl') && !w.url.includes('manifest'))!;
    expect(descPut.body).toContain('cg:encrypted true');
    expect(descPut.body).toContain('cg:visibility "private"');
  });

  it('omits cg:visibility for shared (default) to preserve historical descriptor format', async () => {
    const writes: { url: string; body?: string }[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      if (method === 'PUT') writes.push({ url: urlStr, body: init?.body as string });
      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
        return mockResponse('', { status: 404, ok: false });
      }
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    await publish(testDescriptor(), '<urn:s> <urn:p> <urn:o>.', 'https://alice.pod/', {
      fetch: mockFetch,
      // visibility omitted → default 'shared'; no per-graph envelope without
      // encrypt option, so cg:encrypted is false but visibility predicate
      // is intentionally NOT emitted for back-compat with pre-fix parsers.
    });

    const descPut = writes.find(w => w.url.endsWith('.ttl') && !w.url.includes('manifest'))!;
    expect(descPut.body).not.toContain('cg:visibility');
  });
});

// ═════════════════════════════════════════════════════════════
//  publish() — in-process concurrency
// ═════════════════════════════════════════════════════════════
//
// Regression test for the same-process race in manifest update.
//
// publish() does a GET-then-PUT against the manifest with HTTP
// optimistic concurrency (If-Match / If-None-Match). That dance is
// the correct shape for cross-process / cross-host writers, but for
// N parallel same-process publishes (e.g. the relay fanning out a
// Promise.all over voters from one pod) every writer races against
// itself: they all GET the same etag, each builds a body that adds
// only its own entry, the server commits one and 412s the rest, the
// rest re-GET, retry, and only converge after burning through the
// retry budget — or, under a CSS TOCTOU window, two If-Match=etag
// PUTs both pass the precondition check and the later write silently
// clobbers the earlier.
//
// Fix (Fix B): per-pod in-process mutex inside publish() collapses
// same-process writers into a serial queue keyed on the manifest URL.
// Cross-process writers still get the existing HTTP CAS protection
// unchanged. The 8x backoff/retry loop stays as defense in depth.

describe('publish — in-process concurrency (per-pod mutex)', () => {
  it('5 concurrent same-pod publishes all land in the manifest (no race-driven drops)', async () => {
    // Mock pod that models a real read-modify-write race window:
    //   - the manifest body lives in a shared closure variable
    //   - each GET response carries an etag derived from the current
    //     body, plus a snapshot of the body itself
    //   - each PUT checks If-Match against the *current* etag and
    //     rejects 412 if a concurrent writer mutated the body between
    //     our GET and our PUT
    //
    // Without the per-pod mutex, 5 parallel publishes would all GET
    // the same starting etag, all build bodies adding only their own
    // entry, the server would commit one and 412 the rest, and the
    // retry storm + jitter would (best-case) eventually converge OR
    // (worst-case) blow the 8-attempt budget. With the mutex, the
    // five publishes are serialized — each one sees the freshest body
    // when its turn comes — so all five entries land cleanly with no
    // 412s.
    let manifestBody = '';
    let manifestExists = false;
    let etagCounter = 0;
    const currentEtag = () => `"v${etagCounter}"`;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;

      // Non-manifest URLs (descriptor + graph PUT) — always succeed.
      if (!urlStr.includes('.well-known/context-graphs')) {
        return mockResponse('', { status: 201 });
      }

      // Manifest GET
      if (method === 'GET') {
        if (!manifestExists) return mockResponse('', { status: 404, ok: false });
        const etagSnapshot = currentEtag();
        const resp = mockResponse(manifestBody);
        (resp as Record<string, unknown>).headers = {
          get: (name: string) => name.toLowerCase() === 'etag' ? etagSnapshot : null,
        };
        return resp;
      }

      // Manifest PUT — enforce CAS like a real ETag-aware backend.
      if (method === 'PUT') {
        const ifMatch = headers['If-Match'];
        const ifNoneMatch = headers['If-None-Match'];
        if (!manifestExists) {
          if (ifNoneMatch !== '*') {
            // Someone is trying to PUT with If-Match against a manifest
            // that doesn't exist yet — treat as 412.
            return mockResponse('', { status: 412, ok: false });
          }
          manifestBody = init?.body as string;
          manifestExists = true;
          etagCounter++;
          return mockResponse('', { status: 201 });
        }
        // Manifest exists — If-Match MUST match the current etag.
        if (ifMatch !== currentEtag()) {
          return mockResponse('', { status: 412, ok: false });
        }
        manifestBody = init?.body as string;
        etagCounter++;
        return mockResponse('', { status: 200 });
      }

      return mockResponse('', { status: 405, ok: false });
    }) as unknown as typeof globalThis.fetch;

    // Fire 5 publishes against the same pod concurrently. Each
    // publishes a distinct descriptor so all 5 entries are independent
    // additions to the manifest (no idempotent collapsing).
    const N = 5;
    const ids = Array.from({ length: N }, (_, i) => `urn:cg:race:${i}`);
    await Promise.all(ids.map(id =>
      publish(
        ContextDescriptor.create(id as IRI)
          .describes(`urn:graph:race:${id}` as IRI)
          .temporal({ validFrom: '2026-01-01T00:00:00Z' })
          .selfAsserted('did:web:alice.example' as IRI)
          .build(),
        '<urn:s> <urn:p> <urn:o>.',
        'https://alice.pod/',
        { fetch: mockFetch },
      ),
    ));

    // All 5 entries must be in the final manifest. Pre-fix, under the
    // same-process race, the retry storm could either drop entries
    // (TOCTOU silent clobber) or throw `Failed to update manifest ...
    // after 8 attempts` on the loser.
    const entries = parseManifest(manifestBody);
    expect(entries).toHaveLength(N);
    for (const id of ids) {
      const expectedUrl = `https://alice.pod/context-graphs/${id.split(':').pop()}.ttl`;
      expect(entries.some(e => e.descriptorUrl === expectedUrl)).toBe(true);
    }
  });

  it('concurrent publishes to DIFFERENT pods do not block each other (mutex is per-pod)', async () => {
    // The mutex keys on manifest URL, so two pods' publishes proceed
    // in parallel. If we accidentally globalized the lock, this test
    // would still pass (serial is correct, just slower), but the
    // assertion below pins the per-pod scoping explicitly: both
    // publishes complete, both manifests get exactly one entry.
    const manifests = new Map<string, { body: string; exists: boolean; etagN: number }>();
    function pod(url: string) {
      if (!manifests.has(url)) manifests.set(url, { body: '', exists: false, etagN: 0 });
      return manifests.get(url)!;
    }

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!urlStr.includes('.well-known/context-graphs')) return mockResponse('', { status: 201 });
      const m = pod(urlStr);
      if (method === 'GET') {
        if (!m.exists) return mockResponse('', { status: 404, ok: false });
        const tag = `"v${m.etagN}"`;
        const resp = mockResponse(m.body);
        (resp as Record<string, unknown>).headers = { get: (n: string) => n.toLowerCase() === 'etag' ? tag : null };
        return resp;
      }
      if (method === 'PUT') {
        if (!m.exists) {
          if (headers['If-None-Match'] !== '*') return mockResponse('', { status: 412, ok: false });
          m.body = init?.body as string;
          m.exists = true;
          m.etagN++;
          return mockResponse('', { status: 201 });
        }
        if (headers['If-Match'] !== `"v${m.etagN}"`) return mockResponse('', { status: 412, ok: false });
        m.body = init?.body as string;
        m.etagN++;
        return mockResponse('', { status: 200 });
      }
      return mockResponse('', { status: 405, ok: false });
    }) as unknown as typeof globalThis.fetch;

    await Promise.all([
      publish(
        ContextDescriptor.create('urn:cg:multi-a' as IRI)
          .describes('urn:graph:multi-a' as IRI)
          .temporal({ validFrom: '2026-01-01T00:00:00Z' })
          .selfAsserted('did:web:alice.example' as IRI)
          .build(),
        '<urn:s> <urn:p> <urn:o>.',
        'https://alice.pod/',
        { fetch: mockFetch },
      ),
      publish(
        ContextDescriptor.create('urn:cg:multi-b' as IRI)
          .describes('urn:graph:multi-b' as IRI)
          .temporal({ validFrom: '2026-01-01T00:00:00Z' })
          .selfAsserted('did:web:bob.example' as IRI)
          .build(),
        '<urn:s> <urn:p> <urn:o>.',
        'https://bob.pod/',
        { fetch: mockFetch },
      ),
    ]);

    const a = parseManifest(pod('https://alice.pod/.well-known/context-graphs').body);
    const b = parseManifest(pod('https://bob.pod/.well-known/context-graphs').body);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.descriptorUrl).toContain('multi-a');
    expect(b[0]!.descriptorUrl).toContain('multi-b');
  });
});

// ═════════════════════════════════════════════════════════════
//  publish() — CAS supersession precondition
// ═════════════════════════════════════════════════════════════
//
// FIX 2: when two concurrent publishers republish the same urn:graph,
// each reads the same prior chain head from the manifest, each emits a
// cg:supersedes back-link to it, and (before this fix) both succeeded —
// forking the chain into two competing HEADs. publish() now takes
// ifMatchSupersedes / ifMatchCid CAS preconditions: the substrate-level
// gate re-reads the current head and rejects with
// PublishPreconditionFailedError (HTTP 412 semantics) on mismatch — zero
// CSS writes happen on a failed precondition.

describe('publish — CAS supersession precondition', () => {
  const podUrl = 'https://alice.pod/';
  const priorHeadUrl = 'https://alice.pod/context-graphs/prior.ttl';
  const priorHeadTurtle = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#>.
<urn:cg:prior> a cg:ContextDescriptor ;
    cg:describes <urn:graph:g1>.`;

  function makeMockFetch(opts: { manifestStatus?: number } = {}) {
    const writes: { url: string; method: string }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      if (method !== 'GET') writes.push({ url: urlStr, method });

      // GET prior head turtle (for CAS check) — returns canonical turtle
      if (method === 'GET' && urlStr === priorHeadUrl) {
        return mockResponse(priorHeadTurtle);
      }
      // GET manifest
      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) {
        return mockResponse('', { status: opts.manifestStatus ?? 404, ok: (opts.manifestStatus ?? 404) < 400 });
      }
      // PUTs succeed
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, writes: writes };
  }

  function descWithSupersedes(id: string) {
    return ContextDescriptor.create(id as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.selfAsserted('did:web:alice.example' as IRI)
.supersedes(priorHeadUrl as IRI)
.build();
  }

  it('succeeds + returns previousHeadCid when ifMatchSupersedes matches', async () => {
    const { fetch } = makeMockFetch();
    const result = await publish(
      descWithSupersedes('urn:cg:new-head'),
      '',
      podUrl,
      { fetch, ifMatchSupersedes: priorHeadUrl },
    );
    expect(result.previousHeadUrl).toBe(priorHeadUrl);
    expect(result.previousHeadCid).toBeDefined();
    expect(result.previousHeadCid).toMatch(/^bafkrei/);
  });

  it('rejects with PublishPreconditionFailedError when ifMatchSupersedes does NOT match', async () => {
    const { fetch, writes } = makeMockFetch();
    const stale = 'https://alice.pod/context-graphs/some-OTHER-head.ttl';
    let captured: unknown = null;
    try {
      await publish(
        descWithSupersedes('urn:cg:new-head'),
        '',
        podUrl,
        { fetch, ifMatchSupersedes: stale },
      );
    } catch (err) {
      captured = err;
    }
    expect(captured).not.toBeNull();
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
    expect((captured as { code: number }).code).toBe(412);
    // The substrate gate runs BEFORE any PUT, so no writes occurred.
    expect(writes.length).toBe(0);
  });

  it('rejects with 412 when ifMatchCid does not match the head\'s CID', async () => {
    const { fetch, writes } = makeMockFetch();
    let captured: unknown = null;
    try {
      await publish(
        descWithSupersedes('urn:cg:new-head'),
        '',
        podUrl,
        { fetch, ifMatchCid: 'bafkreiSTALECIDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
      );
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
    expect(writes.length).toBe(0);
  });

  it('returns previousHeadCid observationally when no precondition is supplied', async () => {
    const { fetch } = makeMockFetch();
    const result = await publish(descWithSupersedes('urn:cg:new-head'), '', podUrl, { fetch });
    // Best-effort observational CID for downstream chaining.
    expect(result.previousHeadUrl).toBe(priorHeadUrl);
    expect(result.previousHeadCid).toBeDefined();
  });

  it('throws when precondition is supplied but descriptor.supersedes is empty', async () => {
    const { fetch } = makeMockFetch();
    const noSupersedes = ContextDescriptor.create('urn:cg:noprior' as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.selfAsserted('did:web:alice.example' as IRI)
.build();
    let captured: unknown = null;
    try {
      await publish(noSupersedes, '', podUrl, { fetch, ifMatchSupersedes: priorHeadUrl });
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
  });

  it('end-to-end CAS chain: publish, then a stale ifMatch on a second publish is rejected', async () => {
    // First publish — establishes the chain. Use the prior head as the
    // supersession target, get back a previousHeadCid.
    const { fetch: fetch1 } = makeMockFetch();
    const first = await publish(
      descWithSupersedes('urn:cg:v2'),
      '',
      podUrl,
      { fetch: fetch1, ifMatchSupersedes: priorHeadUrl },
    );
    expect(first.previousHeadCid).toBeDefined();

    // Simulate a concurrent writer: between first.publish and the second
    // publish, the chain head changed to a NEW descriptor at urn:cg:v3.
    // The original caller still holds the stale previousHeadCid for v2's
    // ancestor (priorHeadUrl) — but they're trying to supersede v3.
    // The stale ifMatchSupersedes still points at priorHeadUrl, which is
    // no longer the current head of the v3 we want to supersede.
    const newHeadUrl = 'https://alice.pod/context-graphs/v3.ttl';
    const newHeadTurtle = `<urn:cg:v3> a <https://markjspivey-xwisee.github.io/interego/ns/cg#ContextDescriptor> .`;
    const fetch2 = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const method = init?.method ?? 'GET';
      if (method === 'GET' && urlStr === newHeadUrl) return mockResponse(newHeadTurtle);
      if (method === 'GET' && urlStr.includes('.well-known/context-graphs')) return mockResponse('', { status: 404, ok: false });
      return mockResponse('', { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    const v4 = ContextDescriptor.create('urn:cg:v4' as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.selfAsserted('did:web:alice.example' as IRI)
.supersedes(newHeadUrl as IRI)
.build();

    let captured: unknown = null;
    try {
      await publish(v4, '', podUrl, { fetch: fetch2, ifMatchSupersedes: priorHeadUrl /* stale */ });
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).name).toBe('PublishPreconditionFailedError');
    // The error carries the actual observed head set so the caller can re-read.
    expect((captured as { actual: { supersedesList: string[] } }).actual.supersedesList).toEqual([newHeadUrl]);
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
