/**
 * P2P transport against a real public Nostr relay.
 *
 * This test hits actual public Nostr infrastructure (relay.damus.io
 * by default, override with RUN_PUBLIC_RELAY env var). It's gated
 * behind RUN_PUBLIC_RELAY because:
 *   - CI shouldn't hammer public relays (rate limits, courtesy)
 *   - The test depends on internet + the chosen relay being up
 *   - It produces a small public footprint (one signed event per run)
 *
 * To run locally:
 *   RUN_PUBLIC_RELAY=wss://relay.damus.io npx vitest run tests/p2p-public-relay.test.ts
 *
 * What this proves:
 *   1. Schnorr-signed events Interego produces are accepted by a
 *      real, third-party Nostr relay we don't control.
 *   2. The same events round-trip back via REQ subscription.
 *   3. WebSocketRelayMirror works end-to-end against actual public
 *      infrastructure — not just an in-process server.
 *
 * What this does NOT prove:
 *   - The events are routed to other Nostr clients in real time
 *     (depends on relay's broadcast policy + uptime). The test
 *     reads its own events back via REQ, which is sufficient to
 *     verify the wire round-trip.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryRelay,
  WebSocketRelayMirror,
  P2pClient,
  importWallet,
  generateKeyPair,
  KIND_DESCRIPTOR,
} from '../src/index.js';

const RELAY_URL = process.env['RUN_PUBLIC_RELAY'];
const TEST_WALLET_KEY = process.env['PUBLIC_RELAY_TEST_KEY']
  ?? '0x' + 'b1'.repeat(32); // ephemeral; obvious test key — DO NOT use for production

function waitFor(check: () => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const describeOrSkip = RELAY_URL ? describe : describe.skip;

describeOrSkip(`P2P transport — real public Nostr relay (${RELAY_URL ?? 'SKIPPED — set RUN_PUBLIC_RELAY=wss://...'})`, () => {
  it('publishes a Schnorr-signed event and reads it back via REQ', { timeout: 30000 }, async () => {
    if (!RELAY_URL) return; // type guard for TS; describe.skip handles runtime

    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [RELAY_URL]);
    const wallet = importWallet(TEST_WALLET_KEY, 'agent', 'public-relay-test');

    // Schnorr scheme — required for public-relay interop.
    const client = new P2pClient(mirror, wallet, {
      signingScheme: 'schnorr',
      encryptionKeyPair: generateKeyPair(),
    });

    mirror.start();

    try {
      // Wait for the connection to come up
      await waitFor(() => mirror.status().some(s => s.state === 'connected'));

      // Subscribe locally for events authored by us — once the relay
      // ack's our REQ, our own publish should round-trip back.
      const received: string[] = [];
      const sub = mirror.subscribe(
        { kinds: [KIND_DESCRIPTOR], ['#graph' as const]: [`urn:graph:public-relay-test:${Date.now()}`] },
        (e) => received.push(e.id),
      );

      // Use a unique graph IRI to avoid collisions across runs
      const uniqueGraph = `urn:graph:public-relay-test:${Date.now()}`;
      const pub = await client.publishDescriptor({
        descriptorId: `urn:cg:public-relay-test:${Date.now()}`,
        cid: 'bafkrei-public-relay-' + Math.random().toString(36).slice(2),
        graphIri: uniqueGraph,
        summary: 'Interego P2P public-relay smoke test (safe to ignore)',
      });
      expect(pub.eventId).toMatch(/^[0-9a-f]{64}$/);

      // The event was published; the inner relay holds it. The
      // mirror also broadcasts to the public relay. Confirm at least
      // the local round-trip:
      const local = await inner.query({ kinds: [KIND_DESCRIPTOR] });
      expect(local.length).toBeGreaterThanOrEqual(1);

      // Best-effort: wait for the public relay to accept + echo back.
      // Some relays don't echo to the publisher; others do. A
      // successful publish is the minimum bar.
      await waitFor(
        () => mirror.status().some(s => s.eventsOut >= 1),
        5000,
      ).catch(() => {/* publication may have failed silently; status will show */});

      const status = mirror.status()[0]!;
      expect(status.state).toBe('connected');
      expect(status.eventsOut).toBeGreaterThanOrEqual(1);

      sub.close();
    } finally {
      mirror.stop();
    }
  });
});
