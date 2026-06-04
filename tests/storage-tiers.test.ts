/**
 * Storage tier smoke tests — verify each documented tier in
 * spec/STORAGE-TIERS.md actually works end-to-end.
 *
 * Tier 0 — library only: pure in-process; no fetch needed.
 * Tier 1 — local single-machine pod: simulated via an in-memory
 *          fetch handler that behaves like Solid pod (PUT/GET).
 *          Faithful to Tier 1 because the publish() / discover()
 *          code paths are exactly what the auto-spawned CSS sees;
 *          we just substitute the transport.
 * Tier 4 — federated cross-pod: two in-memory pods on different
 *          URLs; publish to A, discover from B via the same
 *          discover() API a federation reader would use.
 *
 * Tiers 2 (LAN) and 3 (self-hosted public) are deployment patterns
 * over Tier 1 — the protocol surface is identical, only DNS / TLS
 * differs. They are documented but not separately tested.
 *
 * Tier 5 (peer-to-peer) is not built — placeholder it.skip below.
 */

import { describe, it, expect } from 'vitest';
import {
  ContextDescriptor,
  cryptoComputeCid,
  importWallet,
  intersection,
  signDescriptor,
  toTurtle,
  union,
  validate,
  verifyDescriptorSignature,
} from '@interego/core';
import {
  discover,
  publish,
} from '@interego/solid';
import type {
  IRI,
} from '@interego/core';

// ── In-memory pod backed by a real-ish fetch handler ─────────
//
// Maintains a Map<URL, { body, contentType }> and answers PUT /
// GET / DELETE per Solid semantics. Faithful enough to round-trip
// the publish + discover code paths without touching a network.

interface InMemoryPodEntry {
  readonly body: string;
  readonly contentType: string;
}

class InMemoryPod {
  readonly url: string;
  private readonly store = new Map<string, InMemoryPodEntry>();
  readonly requestLog: { method: string; url: string }[] = [];

  constructor(url: string) {
    this.url = url.endsWith('/') ? url : url + '/';
  }

  /** A fetch fn callers can pass to publish() / discover() / etc. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requestLog.push({ method, url });

    if (!url.startsWith(this.url)) {
      // Foreign URL — return 404 to simulate "not on this pod"
      return new Response('Not on this pod', { status: 404 });
    }

    if (method === 'PUT') {
      const body = typeof init?.body === 'string' ? init.body : '';
      const contentType = (init?.headers as Record<string, string> | undefined)?.['Content-Type']
        ?? 'application/octet-stream';
      this.store.set(url, { body, contentType });
      return new Response('', { status: 201 });
    }

    if (method === 'GET' || method === 'HEAD') {
      const entry = this.store.get(url);
      if (!entry) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(method === 'HEAD' ? '' : entry.body, {
        status: 200,
        headers: { 'Content-Type': entry.contentType },
      });
    }

    if (method === 'DELETE') {
      const existed = this.store.delete(url);
      return new Response('', { status: existed ? 204 : 404 });
    }

    return new Response('Method not allowed', { status: 405 });
  };

  /** Inspect what's stored — useful for asserting in tests. */
  has(url: string): boolean { return this.store.has(url); }
  get(url: string): InMemoryPodEntry | undefined { return this.store.get(url); }
  keys(): string[] { return [...this.store.keys()]; }
  size(): number { return this.store.size; }
}

// ═══════════════════════════════════════════════════════════════
// TIER 0 — Library-only
// ═══════════════════════════════════════════════════════════════

describe('Tier 0 — library-only (no daemon, no pod, no network)', () => {
  it('builds, validates, signs, verifies, and CIDs a descriptor entirely in-process', async () => {


    // 1. Build
    const desc = ContextDescriptor.create('urn:cg:tier0-test' as IRI)
      .describes('urn:graph:tier0-data' as IRI)
      .temporal({ validFrom: '2026-04-26T00:00:00Z' })
      .selfAsserted('did:key:z6Mkfoo' as IRI)
      .build();
    expect(desc.id).toBe('urn:cg:tier0-test');

    // 2. Validate (in-process SHACL-equivalent)
    const result = validate(desc);
    expect(result.conforms).toBe(true);

    // 3. Serialize to Turtle
    const turtle = toTurtle(desc);
    expect(turtle).toContain('cg:ContextDescriptor');
    expect(turtle).toContain('did:key:z6Mkfoo');

    // 4. Compute IPFS CID (no network — pure SHA-256 + multihash)
    const cid = cryptoComputeCid(turtle);
    expect(cid).toMatch(/^bafkr/);
    expect(cid.length).toBeGreaterThan(40);

    // 5. Sign with an ECDSA wallet (no chain interaction)
    const wallet = importWallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      'agent',
      'tier0-signer',
    );
    const signed = await signDescriptor(desc.id, turtle, wallet);
    expect(signed.signerAddress).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');

    // 6. Verify the signature round-trips
    const verify = await verifyDescriptorSignature(signed, turtle);
    expect(verify.valid).toBe(true);
  });

  it('composes two descriptors with union — composition is in-process', () => {

    const a = ContextDescriptor.create('urn:cg:a' as IRI)
      .describes('urn:graph:shared' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .selfAsserted('did:key:alice' as IRI)
      .build();
    const b = ContextDescriptor.create('urn:cg:b' as IRI)
      .describes('urn:graph:shared' as IRI)
      .temporal({ validFrom: '2026-02-01T00:00:00Z' })
      .selfAsserted('did:key:bob' as IRI)
      .build();
    const u = union(a, b);
    expect(u.facets.length).toBeGreaterThan(0);
    const i = intersection(a, b);
    expect(i.facets.length).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// TIER 1 — Local single-machine pod
// ═══════════════════════════════════════════════════════════════

describe('Tier 1 — local single-machine pod (in-memory pod proxy)', () => {
  it('publish + discover round-trips against an in-memory pod', async () => {

    const pod = new InMemoryPod('http://localhost:3456/alice/');

    const desc = ContextDescriptor.create('urn:cg:tier1-test' as IRI)
      .describes('urn:graph:tier1-data' as IRI)
      .temporal({ validFrom: '2026-04-26T00:00:00Z' })
      .selfAsserted('did:key:z6Mkalice' as IRI)
      .build();

    // Publish — uses the same code path the auto-spawned CSS sees,
    // just with our in-memory transport.
    const pubResult = await publish(desc, '@prefix ex: <http://example.org/> .\nex:hello ex:says "world" .', pod.url, {
      fetch: pod.fetch,
    });
    expect(pubResult.descriptorUrl).toContain(pod.url);
    expect(pubResult.graphUrl).toContain(pod.url);

    // The pod now contains the manifest + the descriptor + the graph
    expect(pod.size()).toBeGreaterThanOrEqual(3);
    expect(pod.has(pubResult.descriptorUrl)).toBe(true);
    expect(pod.has(pubResult.graphUrl)).toBe(true);

    // Discover — reads the manifest, parses entries
    const entries = await discover(pod.url, undefined, { fetch: pod.fetch });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const ours = entries.find((e) => e.descriptorUrl === pubResult.descriptorUrl);
    expect(ours).toBeDefined();
    expect(ours?.describes).toContain('urn:graph:tier1-data');
  });

  it('multiple publishes accumulate in the manifest', async () => {

    const pod = new InMemoryPod('http://localhost:3456/alice/');

    for (let i = 0; i < 3; i++) {
      const desc = ContextDescriptor.create(`urn:cg:tier1-multi-${i}` as IRI)
        .describes(`urn:graph:tier1-multi-${i}` as IRI)
        .temporal({ validFrom: '2026-04-26T00:00:00Z' })
        .selfAsserted('did:key:z6Mkalice' as IRI)
        .build();
      await publish(desc, `# graph ${i}\n`, pod.url, { fetch: pod.fetch });
    }

    const entries = await discover(pod.url, undefined, { fetch: pod.fetch });
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// TIER 4 — Federated across pods
// ═══════════════════════════════════════════════════════════════

describe('Tier 4 — federated across pods (two in-memory pods)', () => {
  it('content published to pod A is discoverable from a reader pointed at pod A', async () => {
    // Two pods — Alice's and Bob's. Alice publishes; Bob discovers
    // by pointing the discover() function at Alice's pod URL.
    // This is the federation primitive: any pod with a URL can be
    // queried by any reader who knows the URL. No central registry.

    const aliceUrl = 'http://alice.local:3456/alice/';
    const bobUrl = 'http://bob.local:3456/bob/';
    const podAlice = new InMemoryPod(aliceUrl);
    const podBob = new InMemoryPod(bobUrl);

    // Combined fetch: when a request lands on alice's URL, route to
    // alice's pod; same for bob's. This is exactly how federation
    // works — the only difference between in-memory and real is the
    // transport layer.
    const federatedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(aliceUrl)) return podAlice.fetch(input, init);
      if (url.startsWith(bobUrl)) return podBob.fetch(input, init);
      return new Response('Not in federation', { status: 404 });
    };

    // Alice publishes a claim
    const aliceDesc = ContextDescriptor.create('urn:cg:tier4-alice' as IRI)
      .describes('urn:graph:tier4-shared-claim' as IRI)
      .temporal({ validFrom: '2026-04-26T00:00:00Z' })
      .selfAsserted('did:key:z6Mkalice' as IRI)
      .build();
    const alicePub = await publish(aliceDesc, '# alice\'s claim\n', aliceUrl, {
      fetch: federatedFetch,
    });
    expect(podAlice.has(alicePub.descriptorUrl)).toBe(true);

    // Bob's reader (or any third party with the URL) discovers it
    // by talking to Alice's pod directly. Federation is pull-based
    // by URL — no shared access list, no central registry.
    const bobReadsAlice = await discover(aliceUrl, undefined, { fetch: federatedFetch });
    expect(bobReadsAlice.length).toBeGreaterThanOrEqual(1);
    expect(bobReadsAlice.some((e) => e.describes.includes('urn:graph:tier4-shared-claim'))).toBe(true);
    // And Bob's own pod has nothing — federation didn't accidentally
    // copy data
    expect(podBob.size()).toBe(0);
  });

  it('two pods can each publish; a reader can aggregate across both', async () => {

    const aliceUrl = 'http://alice.local:3456/alice/';
    const bobUrl = 'http://bob.local:3456/bob/';
    const podAlice = new InMemoryPod(aliceUrl);
    const podBob = new InMemoryPod(bobUrl);

    const federatedFetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith(aliceUrl)) return podAlice.fetch(input, init);
      if (url.startsWith(bobUrl)) return podBob.fetch(input, init);
      return new Response('Not in federation', { status: 404 });
    };

    // Alice + Bob each publish a different claim
    await publish(
      ContextDescriptor.create('urn:cg:tier4-alice-claim' as IRI)
        .describes('urn:graph:alice-claim' as IRI)
        .temporal({ validFrom: '2026-04-26T00:00:00Z' })
        .selfAsserted('did:key:z6Mkalice' as IRI).build(),
      '# alice\n',
      aliceUrl,
      { fetch: federatedFetch },
    );
    await publish(
      ContextDescriptor.create('urn:cg:tier4-bob-claim' as IRI)
        .describes('urn:graph:bob-claim' as IRI)
        .temporal({ validFrom: '2026-04-26T00:00:00Z' })
        .selfAsserted('did:key:z6Mkbob' as IRI).build(),
      '# bob\n',
      bobUrl,
      { fetch: federatedFetch },
    );

    // A federation reader fans out to both
    const aliceEntries = await discover(aliceUrl, undefined, { fetch: federatedFetch });
    const bobEntries = await discover(bobUrl, undefined, { fetch: federatedFetch });
    const allGraphs = [...aliceEntries, ...bobEntries].flatMap((e) => e.describes);
    expect(allGraphs).toContain('urn:graph:alice-claim');
    expect(allGraphs).toContain('urn:graph:bob-claim');
    // Each pod is independent — Alice's pod has only her data, Bob's only his
    expect(podAlice.keys().every((k) => k.startsWith(aliceUrl))).toBe(true);
    expect(podBob.keys().every((k) => k.startsWith(bobUrl))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// TIER 5 — Fully peer-to-peer (not built)
// ═══════════════════════════════════════════════════════════════

describe('Tier 5 — fully peer-to-peer (not yet built)', () => {
  it.skip('libp2p-backed publish + discover with no servers', () => {
    // This tier requires a transport layer that doesn't exist yet:
    //   - libp2p streams instead of HTTP
    //   - DHT-based pod discovery instead of WebFinger
    //   - Gossiped manifests instead of pod-hosted
    //   - NAT traversal (STUN/TURN/ICE)
    //
    // The protocol surface (descriptors, signing, federation
    // semantics) is unchanged; only the transport is. Until a
    // libp2p adapter exists, this is documentation-only.
    //
    // See spec/STORAGE-TIERS.md §"Tier 5".
  });
});
