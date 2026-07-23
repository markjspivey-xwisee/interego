/**
 * Round-21: the solid client's HAND-BUILT graph/manifest lines (the TriG named-graph
 * wrapper, the affordance/distribution block, and the manifest-entry
 * describes/conformsTo/supersedes/issuer) must escape their interpolated IRIs. The
 * round-19 core-serializer fix covered the descriptor FACET values, but the round-20
 * audit found these client.ts wrapper lines emit graph IRIs raw — so a caller-influenced
 * `describes`/`issuer`/graph IRI broke out of `<...>` and injected triples into (or
 * corrupted) the published pod document. This publishes through the real publish() path
 * with a capturing fetch and asserts no breakout survives.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextDescriptor, type IRI } from '@interego/core';
import { publish } from '@interego/solid';

const POD = 'https://gate.example.test/acme/';
const INJ_GRAPH = 'urn:graph:x> <urn:evil-s> <urn:evil-p> <urn:evil-o> . <urn:sink';

function capturingFetch() {
  const puts: Array<{ url: string; body: string }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') puts.push({ url: u, body: String(init?.body ?? '') });
    // Precondition/head GETs → 404 (fresh publish), everything else → 200/201.
    if (method === 'GET') return new Response('', { status: 404 });
    return new Response('', { status: 201, headers: { ETag: '"e1"' } });
  });
  return { fetch, puts };
}

describe('round-21 — solid publish escapes injected graph/manifest IRIs', () => {
  it('an injected describes-graph IRI cannot break out of <...> in any PUT body', async () => {
    const descriptor = ContextDescriptor.create('urn:iep:round21:v1' as IRI)
      .describes(INJ_GRAPH as IRI)
      .asserted(0.9)
      .build();
    const { fetch, puts } = capturingFetch();
    await publish(descriptor, '', POD, { fetch: fetch as unknown as typeof globalThis.fetch }).catch(() => undefined);
    expect(puts.length).toBeGreaterThan(0);
    for (const { url, body } of puts) {
      // The injected predicate/object IRIs must never appear as bare <...> terms.
      expect(/<urn:evil-p>/.test(body), url).toBe(false);
      expect(/<urn:evil-o>/.test(body), url).toBe(false);
      // The breakout '>' from the injected graph IRI must be percent-encoded.
      expect(body.includes('urn:graph:x> <urn:evil-s>'), url).toBe(false);
    }
    // At least one body carried the (escaped) value — proving the value was emitted, just safely.
    expect(puts.some(p => p.body.includes('%3E'))).toBe(true);
  });
});
