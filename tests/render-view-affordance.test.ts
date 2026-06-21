/**
 * iep:renderView affordance pattern integration test.
 *
 * Pins the substrate-typed "server-side plaintext projection" pattern:
 *   1. Publisher's distribution block emits a SECOND affordance
 *      (alongside iep:canDecrypt) whose iep:action is iep:renderView and
 *      whose hydra:target is `<relayBase>/render/<descriptorIri>`.
 *      Emission is gated on relayBaseUrl + encryption — without either
 *      the renderView affordance is omitted (back-compat).
 *   2. parseDistributionFromDescriptorTurtle still finds the canDecrypt
 *      distribution (it parses the FIRST affordance block, which is the
 *      canDecrypt one) — backwards-compatible with existing consumers.
 *   3. A thin client without a recipientKeyPair can invoke the renderView
 *      affordance via kernel.act and get back plaintext Turtle, because
 *      the relay server-side unwraps using its own key. We model the
 *      relay as a fetch-mock that emulates the /render/:descriptorIri
 *      handler implemented in deploy/mcp-relay/server.ts: verify-bearer,
 *      check recipient set, unwrap, return text/turtle.
 */

import { describe, it, expect } from 'vitest';
import {
  act,
  createEncryptedEnvelope,
  generateKeyPair,
  openEncryptedEnvelope,
} from '@interego/core';
import type { EncryptedEnvelope, FetchFn } from '@interego/core';
import { publish, parseDistributionFromDescriptorTurtle } from '@interego/solid';
import { ContextDescriptor } from '@interego/core';

const CG_RENDER_VIEW = 'iep:renderView';

// In-memory pod the publish writes against. We capture every PUT so we
// can inspect what publish() emitted (descriptor, envelope, manifest),
// and we serve subsequent GETs out of the same map. This is enough to
// drive both publish() and the mock /render handler.
function buildMemoryPod(): {
  fetch: FetchFn;
  get: (url: string) => string | undefined;
  all: () => Map<string, string>;
} {
  const store = new Map<string, string>();
  const fetchFn = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT') {
      store.set(url, init?.body ?? '');
      return {
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: { get: (_n: string) => null },
        text: async () => '',
      } as unknown as Response;
    }
    if (method === 'GET') {
      const body = store.get(url);
      if (body === undefined) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: (_n: string) => null },
          text: async () => '',
        } as unknown as Response;
      }
      const ct = url.endsWith('.envelope.jose.json')
        ? 'application/jose+json'
        : url.endsWith('.trig')
          ? 'application/trig'
          : 'text/turtle';
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (h: string) => (h.toLowerCase() === 'content-type' ? ct : (h.toLowerCase() === 'etag' ? '"v1"' : null)),
        },
        text: async () => body,
      } as unknown as Response;
    }
    throw new Error(`unexpected method ${method} on ${url}`);
  }) as unknown as FetchFn;
  return {
    fetch: fetchFn,
    get: (u: string) => store.get(u),
    all: () => store,
  };
}

describe('iep:renderView affordance pattern', () => {
  const podUrl = 'https://pod.test/alice/';
  const relayBase = 'https://relay.test';
  const descId = 'urn:graph:alice:demo:v1';
  const graphIri = 'urn:graph:alice:demo:v1';
  const plaintextBody = '<urn:s> <urn:p> "secret" .';

  function makeDescriptor() {
    return ContextDescriptor.create(descId)
      .describes(graphIri as Parameters<ReturnType<typeof ContextDescriptor.create>['describes']>[0])
      .temporal({ validFrom: new Date().toISOString() })
      .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 1.0 })
      .version(1)
      .build();
  }

  it('emits iep:renderView affordance when relayBaseUrl + encryption are present', async () => {
    const relayKey = generateKeyPair();
    const pod = buildMemoryPod();
    const descriptor = makeDescriptor();

    const result = await publish(descriptor, plaintextBody, podUrl, {
      fetch: pod.fetch,
      encrypt: { recipients: [relayKey.publicKey], senderKeyPair: relayKey },
      relayBaseUrl: relayBase,
    });

    const descTurtle = pod.get(result.descriptorUrl);
    expect(descTurtle).toBeDefined();
    // Both affordances must be present.
    expect(descTurtle).toContain('iep:action iep:canDecrypt');
    expect(descTurtle).toContain('iep:action iep:renderView');
    // The renderView affordance points at the relay endpoint.
    const expectedTarget = `${relayBase}/render/${encodeURIComponent(descId)}`;
    expect(descTurtle).toContain(`<${expectedTarget}>`);
    // The legacy parser still finds the canDecrypt distribution.
    const dist = parseDistributionFromDescriptorTurtle(descTurtle!);
    expect(dist).not.toBeNull();
    expect(dist!.encrypted).toBe(true);
    expect(dist!.accessURL).toBe(result.graphUrl);
  });

  it('omits iep:renderView when relayBaseUrl is not supplied (back-compat)', async () => {
    const relayKey = generateKeyPair();
    const pod = buildMemoryPod();
    const descriptor = makeDescriptor();

    const result = await publish(descriptor, plaintextBody, podUrl, {
      fetch: pod.fetch,
      encrypt: { recipients: [relayKey.publicKey], senderKeyPair: relayKey },
      // intentionally no relayBaseUrl
    });

    const descTurtle = pod.get(result.descriptorUrl);
    expect(descTurtle).toContain('iep:action iep:canDecrypt');
    expect(descTurtle).not.toContain('iep:action iep:renderView');
  });

  it('omits iep:renderView for plaintext (non-encrypted) publishes', async () => {
    const pod = buildMemoryPod();
    const descriptor = makeDescriptor();

    const result = await publish(descriptor, plaintextBody, podUrl, {
      fetch: pod.fetch,
      relayBaseUrl: relayBase, // supplied, but no encrypt → still omitted
    });

    const descTurtle = pod.get(result.descriptorUrl);
    expect(descTurtle).toContain('iep:action iep:canFetchPayload');
    expect(descTurtle).not.toContain('iep:action iep:renderView');
  });

  it('thin client (no recipient key) invokes iep:renderView → relay returns plaintext', async () => {
    // Set up the actual encrypted publish on a memory pod, with the
    // relay's keypair as the sole recipient — modelling the production
    // flow where every publish through the relay is encrypted to the
    // relay's per-agent X25519 key.
    const relayKey = generateKeyPair();
    const pod = buildMemoryPod();
    const descriptor = makeDescriptor();
    const publishResult = await publish(descriptor, plaintextBody, podUrl, {
      fetch: pod.fetch,
      encrypt: { recipients: [relayKey.publicKey], senderKeyPair: relayKey },
      relayBaseUrl: relayBase,
    });

    const renderUrl = `${relayBase}/render/${encodeURIComponent(descId)}`;

    // Build a composite fetch that:
    //   - serves the pod URLs out of the memory pod
    //   - serves the relay's /render/:descriptorIri by emulating the
    //     production handler (verify bearer, fetch descriptor, parse
    //     distribution, fetch envelope, unwrap with relayKey, return
    //     plaintext as text/turtle)
    const fetchWithRelay: FetchFn = (async (url: string, init?: { headers?: Record<string, string>; method?: string }) => {
      if (url.startsWith(relayBase + '/render/')) {
        const authz = init?.headers?.['Authorization'] ?? init?.headers?.['authorization'];
        if (!authz?.startsWith('Bearer ')) {
          return {
            ok: false, status: 401, statusText: 'Unauthorized',
            headers: { get: (_n: string) => 'application/ld+json' },
            text: async () => JSON.stringify({ error: 'Bearer token required' }),
          } as unknown as Response;
        }
        // Resolve descriptorIri (path-tail) → descriptor URL we just published.
        // For this test we already know the URL; in production the relay does a
        // kernel.dereference + manifest scan, but parseDistribution then drives
        // the rest identically.
        const descTurtle = pod.get(publishResult.descriptorUrl)!;
        const dist = parseDistributionFromDescriptorTurtle(descTurtle);
        if (!dist || !dist.encrypted) {
          return {
            ok: false, status: 409, statusText: 'Conflict',
            headers: { get: (_n: string) => 'application/ld+json' },
            text: async () => JSON.stringify({ error: 'Not encrypted' }),
          } as unknown as Response;
        }
        const envBody = pod.get(dist.accessURL)!;
        const envelope = JSON.parse(envBody) as EncryptedEnvelope;
        const inSet = envelope.wrappedKeys.some(wk => wk.recipientPublicKey === relayKey.publicKey);
        if (!inSet) {
          return {
            ok: false, status: 403, statusText: 'Forbidden',
            headers: { get: (_n: string) => 'application/ld+json' },
            text: async () => JSON.stringify({ error: 'Not a recipient' }),
          } as unknown as Response;
        }
        const plaintext = openEncryptedEnvelope(envelope, relayKey);
        if (plaintext === null) {
          return {
            ok: false, status: 500, statusText: 'Internal',
            headers: { get: (_n: string) => 'application/ld+json' },
            text: async () => JSON.stringify({ error: 'unwrap failed' }),
          } as unknown as Response;
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/turtle' : null) },
          text: async () => plaintext,
        } as unknown as Response;
      }
      return pod.fetch(url, init as Parameters<typeof pod.fetch>[1]);
    }) as unknown as FetchFn;

    // The thin client invokes the renderView affordance directly — it has
    // NO recipientKeyPair (this is the asymmetric counterpart of canDecrypt).
    // The bearer token is forwarded; the relay does the unwrap server-side.
    const result = await act(
      {
        action: CG_RENDER_VIEW,
        target: renderUrl,
        method: 'GET',
        mediaType: 'text/turtle',
      },
      undefined,
      { fetch: fetchWithRelay, authorization: 'Bearer thin-client-bearer' },
    );

    expect(result.status).toBe(200);
    // publish() wraps `<descriptor> + <named graph>` as a TriG document
    // before encryption — that's what the envelope holds, and that's
    // what the relay surfaces verbatim. The thin client sees the full
    // TriG; we assert the original triple is present inside it.
    expect(result.body).toContain(plaintextBody);
    expect(result.body).toContain(graphIri);
    expect(result.contentType ?? '').toContain('text/turtle');
  });

  it('thin client without bearer → renderView returns 401', async () => {
    const relayKey = generateKeyPair();
    const pod = buildMemoryPod();
    const descriptor = makeDescriptor();
    await publish(descriptor, plaintextBody, podUrl, {
      fetch: pod.fetch,
      encrypt: { recipients: [relayKey.publicKey], senderKeyPair: relayKey },
      relayBaseUrl: relayBase,
    });
    const renderUrl = `${relayBase}/render/${encodeURIComponent(descId)}`;

    const fetchWithRelay: FetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.startsWith(relayBase + '/render/')) {
        const authz = init?.headers?.['Authorization'] ?? init?.headers?.['authorization'];
        if (!authz?.startsWith('Bearer ')) {
          return {
            ok: false, status: 401, statusText: 'Unauthorized',
            headers: { get: () => null },
            text: async () => '{"error":"Bearer token required"}',
          } as unknown as Response;
        }
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: { get: () => null },
          text: async () => 'ok',
        } as unknown as Response;
      }
      return pod.fetch(url, init as Parameters<typeof pod.fetch>[1]);
    }) as unknown as FetchFn;

    const result = await act(
      { action: CG_RENDER_VIEW, target: renderUrl, method: 'GET', mediaType: 'text/turtle' },
      undefined,
      { fetch: fetchWithRelay /* no authorization */ },
    );
    expect(result.status).toBe(401);
  });
});

describe('parseDistributionFromDescriptorTurtle legacy fallback', () => {
  // Regression pin for the `iep:hasDistribution [ ... ]` fallback branch
  // in client.ts:913-915. Descriptors written before the ontology
  // realignment use this predicate; dropping the fallback would make
  // every such descriptor silently undereferenceable.
  it('parses the legacy iep:hasDistribution form identically to iep:affordance', () => {
    const accessUrl = 'https://pod.test/alice/demo-graph.envelope.jose.json';
    const mediaType = 'application/jose+json';
    const canonical = `
      @prefix iep: <https://w3id.org/context-graphs#> .
      @prefix dcat: <http://www.w3.org/ns/dcat#> .
      @prefix hydra: <http://www.w3.org/ns/hydra/core#> .
      <urn:graph:alice:demo:v1> iep:affordance [
        a iep:Affordance, dcat:Distribution ;
        iep:action iep:canDecrypt ;
        hydra:target <${accessUrl}> ;
        dcat:mediaType "${mediaType}" ;
        iep:encrypted true
      ] .`;
    const legacy = `
      @prefix iep: <https://w3id.org/context-graphs#> .
      @prefix dcat: <http://www.w3.org/ns/dcat#> .
      @prefix hydra: <http://www.w3.org/ns/hydra/core#> .
      <urn:graph:alice:demo:v1> iep:hasDistribution [
        a dcat:Distribution ;
        hydra:target <${accessUrl}> ;
        dcat:mediaType "${mediaType}" ;
        iep:encrypted true
      ] .`;

    const canonicalDist = parseDistributionFromDescriptorTurtle(canonical);
    const legacyDist = parseDistributionFromDescriptorTurtle(legacy);

    expect(canonicalDist).not.toBeNull();
    expect(legacyDist).not.toBeNull();
    expect(legacyDist).toEqual(canonicalDist);
    expect(legacyDist!.accessURL).toBe(accessUrl);
    expect(legacyDist!.mediaType).toBe(mediaType);
    expect(legacyDist!.encrypted).toBe(true);
  });
});
