/**
 * Tier 4 — REAL public Nostr relay end-to-end for agent-collective.
 *
 * Where the integration test uses a shared in-process InMemoryRelay,
 * Tier 4 runs two P2pClients each connected via WebSocketRelayMirror to
 * an actual public Nostr relay. There is NO default relay — `RUN_PUBLIC_RELAY`
 * is read raw and the suite skips when it is unset. (This comment used to say
 * "relay.damus.io by default", which is why nobody noticed the suite had never
 * run: the var was set in no workflow and no npm script.) Mark's agent publishes
 * a tool descriptor announcement; David's agent — whose mirror is configured with
 * the same relay — receives the broadcast.
 *
 * Gated by RUN_PUBLIC_RELAY env var so CI doesn't hammer public infra.
 *
 *   RUN_PUBLIC_RELAY=wss://relay.damus.io npx vitest run \
 *     applications/agent-collective/tests/tier4-public-relay.test.ts
 *
 * What this proves:
 *   1. Two agent-collective bridges using SEPARATE WebSocketRelayMirrors
 *      pointing at the SAME public relay can exchange descriptor
 *      announcements end-to-end (the relay actually broadcasts to
 *      multiple clients, not just echoes to publisher).
 *   2. Schnorr-signed events Interego produces are accepted + redistributed
 *      by a third-party relay we don't control.
 *
 * What this does NOT prove:
 *   - End-to-end encrypted-share decryption across bridges (same code path
 *     is verified by the integration test against InMemoryRelay; the
 *     wire format is identical).
 *   - Public relay liveness — if relay.damus.io is down, this skips.
 */

import { describe, it, expect } from 'vitest';
import {
  generateKeyPair,
  importWallet,
} from '@interego/core';
import {
  InMemoryRelay,
  KIND_DESCRIPTOR,
  P2pClient,
  WebSocketRelayMirror,
} from '@interego/p2p';

const RELAY_URL = process.env['RUN_PUBLIC_RELAY'];

// Mark is the only signer here. David is a READER — his P2pClient used to be
// constructed and never called, which was part of why nobody noticed his mirror had no
// inbound subscription at all.
const MARK_WALLET_KEY  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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

describeOrSkip(`agent-collective — Tier 4 public Nostr relay (${RELAY_URL ?? 'SKIPPED — set RUN_PUBLIC_RELAY'})`, () => {
  // 60s, and it is a SHAPE budget rather than a raised bound: the two bridges now
  // connect SEQUENTIALLY (see below), so the test pays two public-relay handshakes end
  // to end instead of overlapping them. Measured worst case across damus / primal /
  // nos.lol: ~7s.
  it('two bridges through a real public relay: Mark publishes; David receives', { timeout: 60000 }, async () => {
    if (!RELAY_URL) return;

    // ── Mark's bridge — the ONLY socket open during this phase. ──
    //
    // Both mirrors used to be start()ed together. Public relays cap concurrent
    // connections per source IP and refuse the second at the HTTP upgrade: measured
    // against relay.damus.io, the loser reported `state:'closed', lastError:'Unexpected
    // server response: 503', reconnectAttempts:5` and never connected inside the 10s
    // wait. Sequencing the two phases keeps one socket open at a time, and the identical
    // publish/receive then succeeds on that same relay — so the cause was concurrency,
    // not latency. It also makes this a STRONGER claim: David reads the event from the
    // relay's store with Mark already disconnected, so nothing about the result can be
    // explained by a same-socket echo.
    const markInner = new InMemoryRelay();
    const markMirror = new WebSocketRelayMirror(markInner, [RELAY_URL]);
    const markWallet = importWallet(MARK_WALLET_KEY, 'agent', 'mark-tier4');
    const markClient = new P2pClient(markMirror, markWallet, {
      signingScheme: 'schnorr',                       // public relays require Schnorr
      encryptionKeyPair: generateKeyPair(),
    });

    let pubEventId: string;
    markMirror.start();
    try {
      await waitFor(() => markMirror.status().some(s => s.state === 'connected'), 15000);

      const pub = await markClient.publishDescriptor({
        descriptorId: `urn:iep:tool:tier4-detector:${Date.now()}`,
        cid: 'bafkrei-tier4-' + Math.random().toString(36).slice(2),
        graphIri: `urn:graph:ac-tier4:${Date.now()}`,
        summary: 'agent-collective Tier 4 cross-bridge test (safe to ignore)',
      });
      expect(pub.eventId).toMatch(/^[0-9a-f]{64}$/);
      pubEventId = pub.eventId;

      // The relay's OK verdict, not our own ws.send(). `eventsOut` reaches 1 even when
      // the relay refuses the event outright — measured against a relay answering
      // ["OK", id, false, "blocked: not on whitelist"] to 100% of publishes.
      await waitFor(
        () => markMirror.status().some(s => s.eventsAccepted >= 1 || s.eventsRejected >= 1),
        15000,
      );
      const markStatus = markMirror.status()[0]!;
      expect(markStatus.state).toBe('connected');
      expect(markStatus.eventsRejected, markStatus.lastError ?? 'no reason given').toBe(0);
      expect(markStatus.eventsAccepted).toBeGreaterThanOrEqual(1);
    } finally {
      markMirror.stop();
    }

    // ── David's bridge — separate socket, opened only after Mark's is closed.
    //
    // `subscribeAuthors` is REQUIRED: the mirror emits its REQ in the `open` handler and
    // returns early when the author list is empty (the `subscribeAuthors.length === 0`
    // guard in websocket-relay-mirror.ts), and `mirror.subscribe()` only registers a
    // callback on the INNER InMemoryRelay — it never reaches the wire. Constructed
    // without it, as this test used to be, David is outbound-only and cannot receive
    // anything at all; measured `isInboundEnabled() === false`, `eventsIn` 0 forever.
    const davidInner = new InMemoryRelay();
    const davidMirror = new WebSocketRelayMirror(davidInner, [RELAY_URL], {
      subscribeKinds: [KIND_DESCRIPTOR],
      subscribeAuthors: [markClient.pubkey],
    });
    expect(davidMirror.isInboundEnabled()).toBe(true);

    const receivedByDavid: string[] = [];
    const sub = davidMirror.subscribe(
      { kinds: [KIND_DESCRIPTOR], authors: [markClient.pubkey] },
      (e) => receivedByDavid.push(e.id),
    );

    davidMirror.start();
    try {
      await waitFor(() => davidMirror.status().some(s => s.state === 'connected'), 15000);

      // NOT .catch()-swallowed. The swallow is what stopped this test from ever being
      // able to report that David's receive path did not exist.
      await waitFor(() => receivedByDavid.includes(pubEventId), 20000);

      expect(receivedByDavid).toContain(pubEventId);
      const davidStatus = davidMirror.status()[0]!;
      expect(davidStatus.state).toBe('connected');
      expect(davidStatus.eventsIn).toBeGreaterThanOrEqual(1);

      sub.close();
    } finally {
      davidMirror.stop();
    }
  });
});
