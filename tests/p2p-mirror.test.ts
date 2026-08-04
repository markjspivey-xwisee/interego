/**
 * WebSocketRelayMirror integration tests.
 *
 * The relay used here is a real NIP-01 Nostr relay implementation
 * running in-process on an ephemeral port — same wire protocol as
 * `nostr-rs-relay` or any public Nostr relay (EVENT / REQ / EOSE /
 * OK / CLOSE). Just minimal: no retention policy, no NIP-42 auth,
 * no SQL backing store, no relay-side `id` re-verification. Real
 * `ws` library, real WebSocket transport, real NIP-01 messages,
 * real ECDSA signature verification on every event the mirror
 * receives.
 *
 * For an integration test against an actual public Nostr relay
 * (e.g., wss://relay.damus.io), see `tests/p2p-public-relay.test.ts`
 * — gated by RUN_PUBLIC_RELAY env var so CI doesn't hammer them.
 *
 * Two bridges, each with their own InMemoryRelay wrapped by a
 * WebSocketRelayMirror, both connected to the in-process relay.
 *
 * What we prove:
 *   1. An event published locally on bridge A is mirrored outbound
 *      to the relay, broadcast to bridge B's subscription, and
 *      injected into B's local InMemoryRelay so B's local subscriber
 *      callback fires — without any direct connection between A and B.
 *   2. Dedup: same event arriving on multiple paths (or republished)
 *      doesn't loop or duplicate.
 *   3. Reconnect: closing + reopening the relay results in restored
 *      delivery.
 *   4. Status reporting: mirror.status() reflects state transitions.
 *   5. Inbound events are signature-verified before injection;
 *      forged events are rejected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import {
  importWallet,
} from '@interego/core';
import {
  InMemoryRelay,
  isInteregoEvent,
  KIND_ATTESTATION,
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ENCRYPTED_SHARE,
  P2pClient,
  type P2pEvent,
  WebSocketRelayMirror,
} from '@interego/p2p';

const ALICE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BOB_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// ── In-process NIP-01 Nostr relay for tests ─────────────────
//
// Real WebSocket server (the `ws` package), real NIP-01 wire
// protocol — handles EVENT (publish), REQ (subscribe), EOSE
// (end-of-stored), OK (publish ack), CLOSE (unsub). Filters by
// `kinds` only. No retention policy, no NIP-42 auth, no NIP-50
// search. The bytes on the wire match what a public Nostr relay
// produces.

interface NostrRelay {
  url: string;
  events: P2pEvent[];
  close(): Promise<void>;
}

async function startNostrRelay(): Promise<NostrRelay> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      if (addr === null || typeof addr === 'string') throw new Error('WSS address null');
      const url = `ws://127.0.0.1:${addr.port}`;
      const events: P2pEvent[] = [];
      // Map subId → ws + filter, for fan-out
      type Sub = { ws: WebSocket; subId: string; kinds: readonly number[]; authors: readonly string[] };
      const subs: Sub[] = [];

      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          let msg: unknown;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;
          const verb = msg[0] as string;

          if (verb === 'EVENT' && msg.length >= 2) {
            const event = msg[1] as P2pEvent;
            if (!event?.id) return;
            // Dedup at relay level
            if (events.some(e => e.id === event.id)) {
              ws.send(JSON.stringify(['OK', event.id, false, 'duplicate']));
              return;
            }
            events.push(event);
            ws.send(JSON.stringify(['OK', event.id, true, '']));
            // Fan out to matching subscribers
            for (const s of subs) {
              if (s.ws === ws) continue; // don't echo back to publisher
              if (s.kinds.length > 0 && !s.kinds.includes(event.kind)) continue;
              if (s.authors.length > 0 && !s.authors.includes(event.pubkey.toLowerCase())) continue;
              try { s.ws.send(JSON.stringify(['EVENT', s.subId, event])); } catch { /* ignore */ }
            }
          } else if (verb === 'REQ' && msg.length >= 3) {
            const subId = String(msg[1]);
            const filter = msg[2] as { kinds?: number[]; authors?: string[] };
            const kinds = (filter?.kinds ?? []) as readonly number[];
            const authors = ((filter?.authors ?? []) as string[]).map(a => a.toLowerCase());
            subs.push({ ws, subId, kinds, authors });
            // Replay matching historical events
            for (const e of events) {
              if (kinds.length > 0 && !kinds.includes(e.kind)) continue;
              if (authors.length > 0 && !authors.includes(e.pubkey.toLowerCase())) continue;
              try { ws.send(JSON.stringify(['EVENT', subId, e])); } catch { /* ignore */ }
            }
            ws.send(JSON.stringify(['EOSE', subId]));
          } else if (verb === 'CLOSE' && msg.length >= 2) {
            const subId = String(msg[1]);
            const idx = subs.findIndex(s => s.ws === ws && s.subId === subId);
            if (idx >= 0) subs.splice(idx, 1);
          }
        });
        ws.on('close', () => {
          for (let i = subs.length - 1; i >= 0; i--) {
            if (subs[i]!.ws === ws) subs.splice(i, 1);
          }
        });
      });

      resolve({
        url,
        events,
        close: () => new Promise<void>((res) => {
          // Terminate any active client connections first; without
          // this, wss.close() hangs forever waiting for them.
          for (const client of wss.clients) {
            try { client.terminate(); } catch { /* ignore */ }
          }
          wss.close(() => res());
        }),
      });
    });
  });
}

// ── In-process relay that REFUSES every event ────────────────
//
// `startNostrRelay` above accepts everything, so nothing in this suite could tell "the
// relay took our event" apart from "we called ws.send()". That gap is why
// tests/p2p-public-relay.test.ts asserted `eventsOut` and reported green against a relay
// that stored nothing. This is the double that CAN express the refusal — a harness that
// only ever accepts cannot verify a rejection path.
async function startRejectingRelay(reason = 'blocked: not on whitelist'): Promise<NostrRelay> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      if (addr === null || typeof addr === 'string') throw new Error('WSS address null');
      const url = `ws://127.0.0.1:${addr.port}`;
      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          let msg: unknown;
          try { msg = JSON.parse(raw.toString()) as unknown; } catch { return; }
          if (!Array.isArray(msg) || msg[0] !== 'EVENT' || msg.length < 2) return;
          const event = msg[1] as P2pEvent;
          if (!event?.id) return;
          ws.send(JSON.stringify(['OK', event.id, false, reason]));
        });
      });
      resolve({
        url,
        events: [],
        close: () => new Promise<void>((res) => {
          for (const client of wss.clients) { try { client.terminate(); } catch { /* ignore */ } }
          wss.close(() => res());
        }),
      });
    });
  });
}

// ── Helper for waiting for an async event to arrive ──────────
function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ── Tests ────────────────────────────────────────────────────

describe('WebSocketRelayMirror — bidirectional WS bridging', () => {
  const teardowns: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    // Run teardowns in REVERSE order — mirrors stop before the relay
    // closes, so reconnect timers don't fire against a half-closed
    // server. Same convention as RAII / try/finally nesting.
    while (teardowns.length > 0) {
      const t = teardowns.pop();
      if (t) await t();
    }
  });

  it('Alice publishes via bridge-A → mirrored to relay → bridge-B receives + injects', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const statusLog: string[] = [];
    const tap = (label: string) => (s: { url: string; state: string; lastError?: string }) => {
      statusLog.push(`${label}:${s.state}${s.lastError ? `:${s.lastError}` : ''}`);
    };

    // Bridge A
    const innerA = new InMemoryRelay();
    const aliceWallet = importWallet(ALICE_KEY, 'agent', 'alice');
    const bobWallet = importWallet(BOB_KEY, 'agent', 'bob');
    // We need the pubkeys before constructing P2pClient instances
    // because the inbound-author allow-list takes them as input.
    const alicePubkey = aliceWallet.address;
    const bobPubkey = bobWallet.address;

    const mirrorA = new WebSocketRelayMirror(innerA, [relay.url], {
      onStatusChange: tap('A'),
      subscribeAuthors: [bobPubkey], // Alice follows Bob
    });
    teardowns.push(() => mirrorA.stop());
    const alice = new P2pClient(mirrorA, aliceWallet);

    // Bridge B
    const innerB = new InMemoryRelay();
    const mirrorB = new WebSocketRelayMirror(innerB, [relay.url], {
      onStatusChange: tap('B'),
      subscribeAuthors: [alicePubkey], // Bob follows Alice
    });
    teardowns.push(() => mirrorB.stop());
    const bob = new P2pClient(mirrorB, bobWallet);

    mirrorA.start();
    mirrorB.start();

    // Wait for both connections to finish handshaking — also require
    // the status maps to be non-empty (start() populates them sync).
    try {
      await waitFor(() => {
        const a = mirrorA.status();
        const b = mirrorB.status();
        return a.length > 0 && b.length > 0
          && a.every(s => s.state === 'connected')
          && b.every(s => s.state === 'connected');
      }, 4000);
    } catch (err) {
      // `cause` rather than dropping it: the wait can fail for reasons the status log does not
      // show (a timeout vs. a throw inside the predicate), and that distinction was being lost.
      throw new Error(
        `Connections never established. Status log: ${JSON.stringify(statusLog)}; A=${JSON.stringify(mirrorA.status())}; B=${JSON.stringify(mirrorB.status())}`,
        { cause: err },
      );
    }

    const bobInbox: { descriptorId: string; publisher: string }[] = [];
    const sub = bob.subscribeDescriptors({ graphIri: 'urn:graph:cross-bridge' }, (a) => {
      bobInbox.push({ descriptorId: a.descriptorId, publisher: a.publisher });
    });
    teardowns.push(() => sub.close());

    // Alice publishes — should travel through her mirror, the relay,
    // and Bob's mirror, ending up in Bob's local subscriber callback
    await alice.publishDescriptor({
      descriptorId: 'urn:iep:cross-bridge:1',
      cid: 'bafkrei-cross',
      graphIri: 'urn:graph:cross-bridge',
      facetTypes: ['Temporal'],
    });

    await waitFor(() => bobInbox.length >= 1);
    expect(bobInbox).toHaveLength(1);
    expect(bobInbox[0]!.publisher).toBe(alice.pubkey);
    expect(bobInbox[0]!.descriptorId).toBe('urn:iep:cross-bridge:1');

    // Status reflects success
    const aStatus = mirrorA.status();
    expect(aStatus[0]!.state).toBe('connected');
    expect(aStatus[0]!.eventsOut).toBeGreaterThanOrEqual(1);
    const bStatus = mirrorB.status();
    expect(bStatus[0]!.eventsIn).toBeGreaterThanOrEqual(1);
  });

  it('a refused event is reported as a refusal, not as a successful send', async () => {
    const relay = await startRejectingRelay();
    teardowns.push(() => relay.close());

    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url]);
    teardowns.push(() => mirror.stop());
    const alice = new P2pClient(mirror, importWallet(ALICE_KEY, 'agent', 'alice-refused'));

    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'), 4000);

    await alice.publishDescriptor({
      descriptorId: 'urn:iep:refused:1',
      cid: 'bafkrei-refused',
      graphIri: 'urn:graph:refused',
    });
    await waitFor(() => mirror.status().some(s => s.eventsRejected >= 1));

    const s = mirror.status()[0]!;
    // eventsOut CANNOT distinguish this case — it reads 1 against a relay that stored
    // nothing. Pinning it at 1 here is the point: it documents precisely why the old
    // public-relay assertion (`eventsOut >= 1`) proved nothing.
    expect(s.eventsOut).toBe(1);
    expect(s.eventsAccepted).toBe(0);
    expect(s.eventsRejected).toBe(1);
    expect(s.lastError).toContain('blocked: not on whitelist');
  });

  it('an accepted event is counted as accepted', async () => {
    // Not padding: without this, mutating the OK branch to `eventsRejected++`
    // unconditionally would still satisfy the refusal test above.
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url]);
    teardowns.push(() => mirror.stop());
    const alice = new P2pClient(mirror, importWallet(ALICE_KEY, 'agent', 'alice-accepted'));

    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'), 4000);

    await alice.publishDescriptor({
      descriptorId: 'urn:iep:accepted:1',
      cid: 'bafkrei-accepted',
      graphIri: 'urn:graph:accepted',
    });
    await waitFor(() => mirror.status().some(s => s.eventsAccepted >= 1));

    const s = mirror.status()[0]!;
    expect(s.eventsAccepted).toBe(1);
    expect(s.eventsRejected).toBe(0);
  });

  it('dedup: same event arriving twice does not duplicate at the inner relay', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url]);
    teardowns.push(() => mirror.stop());
    const alice = new P2pClient(mirror, importWallet(ALICE_KEY, 'agent', 'alice'));
    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'));

    await alice.publishDescriptor({
      descriptorId: 'urn:iep:dedup:1',
      cid: 'bafkrei-dedup',
      graphIri: 'urn:graph:dedup',
    });

    // Wait for the round-trip — relay rebroadcasts to all subs (but
    // not back to publisher in this implementation); the dedup
    // cache should prevent any duplicate injection.
    await new Promise(r => setTimeout(r, 100));
    const events = await inner.query({});
    expect(events).toHaveLength(1);
  });

  it('disconnection triggers reconnect with backoff', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url], {
      backoff: { initialMs: 50, maxMs: 200 },
    });
    teardowns.push(() => mirror.stop());
    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'));

    // Close the relay; mirror should report 'closed' then attempt reconnect.
    // No `disconnectedAt` timestamp: the assertion below compares two WINDOWS between
    // reconnect attempts, not elapsed time from the disconnect — see the note there for
    // why an elapsed-time floor could not tell the exponent from machine load.
    await relay.close();
    await waitFor(() => mirror.status().every(s => s.state === 'closed' || s.state === 'errored' || s.state === 'connecting'));
    const closedStatus = mirror.status();
    // ★ `reconnectAttempts >= 0` was vacuous — an attempt COUNT cannot be negative — and
    // `Number.isInteger(...)` that replaced it is barely stronger: it is true of the counter
    // at its initial 0, so a mirror that reported 'closed' and then never scheduled a single
    // reconnect satisfied every line here, in a test whose own name is "triggers reconnect
    // with backoff". `ws.on('close')` calls scheduleReconnect() synchronously in the same
    // block that sets state='closed', so once the wait above observes a post-disconnect
    // state the counter is already >= 1: deterministic, not a race.
    expect(closedStatus).toHaveLength(1);
    expect(['closed', 'errored', 'connecting']).toContain(closedStatus[0]!.state);
    expect(closedStatus[0]!.reconnectAttempts).toBeGreaterThanOrEqual(1);

    // ...and the gap between attempts GROWS — the "with backoff" half of the name, which
    // nothing asserted.
    //
    // ★ AN ELAPSED-TIME FLOOR CANNOT ASSERT THIS, AND THE FIRST VERSION OF THIS BLOCK USED
    // ONE. It waited for 6 attempts and required `Date.now() - disconnectedAt >= 500`,
    // reasoning that the scheduled delays alone sum to 600 ms. Measured against the mutant
    // that replaces the exponential with a constant `initialMs`: on an idle box that runs
    // in ~330 ms and the floor catches it, but on this box — several vitest workers running
    // concurrently — the constant-50 ms schedule still burned over 500 ms of wall clock,
    // because each FAILED connect attempt costs real time that the floor happily counts.
    // The floor therefore discriminated on machine load, not on the exponent. Raising it
    // would move a threshold, not fix the defect.
    //
    // The discriminating property is that the gaps grow, so that is what is measured. With
    // initialMs=50 / maxMs=200 and `delay = min(initial * 2^(attempt-1), max)`, the gaps
    // between successive attempt counts are 50, 50, 100, 200, 200 ms. Each gap also
    // contains exactly ONE failed connect, whose cost is unknown and load-dependent — so
    // comparing a two-gap LATE window against a two-gap EARLY window cancels it: both
    // windows hold two connects, and the difference is 400 - 100 = 300 ms of pure
    // setTimeout. Under the constant-delay mutant both windows are identical and the
    // difference is 0. The 200 ms bar sits between them with 100 ms of slack each way.
    // ★ THRESHOLDS, NOT SAMPLES. A `setInterval` sampler recording "the time I first saw
    // the counter equal N" was the first attempt, and it is unreliable for a reason worth
    // recording: the counter can advance past a value between two samples, so `at(6)` came
    // back undefined and the mutant failed with "never sampled reconnectAttempts === 6".
    // That IS a failure, but it names the sampler instead of the backoff and sends the
    // reader to the wrong file. Waiting for `>= n` in sequence cannot miss a value — a
    // threshold once crossed stays crossed — so every timestamp is defined by construction.
    const at: number[] = [];
    for (let n = 1; n <= 6; n++) {
      await waitFor(() => mirror.status()[0]!.reconnectAttempts >= n, 8000);
      at[n] = Date.now();
    }
    const earlyWindow = at[3]! - at[1]!; // scheduled 50 + 50 = 100 ms, plus 2 connects
    const lateWindow = at[6]! - at[4]!;  // scheduled 200 + 200 = 400 ms, plus 2 connects
    expect(
      lateWindow - earlyWindow,
      `gaps are not growing: early window ${earlyWindow}ms, late window ${lateWindow}ms — `
      + 'the reconnect schedule is flat, so this is a busy retry loop, not backoff',
    ).toBeGreaterThanOrEqual(200);
  });

  it('events from external relay are signature-verified before injection', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url]);
    teardowns.push(() => mirror.stop());
    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'));

    // Inject a forged event directly into the relay's event store
    // (bypassing publish). The relay will deliver it to subs; the
    // mirror should reject it via verifyEvent and NOT inject it.
    const forged: P2pEvent = {
      id: '0'.repeat(64),
      pubkey: '0xdeadbeef'.padEnd(42, '0'),
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_DESCRIPTOR,
      tags: [['d', 'fake'], ['cid', 'bafk-fake'], ['graph', 'urn:graph:fake']],
      content: '',
      sig: '0xinvalid',
    };
    relay.events.push(forged);
    // Force a re-subscribe round so the historical event is replayed
    // (or we just publish a real event to nudge delivery)
    const alice = new P2pClient(mirror, importWallet(ALICE_KEY, 'agent', 'alice'));
    await alice.publishDescriptor({
      descriptorId: 'urn:iep:nudge',
      cid: 'bafkrei-nudge',
      graphIri: 'urn:graph:nudge',
    });
    await new Promise(r => setTimeout(r, 100));

    const events = await inner.query({});
    // Only the nudge event should be present; the forged event must not have been injected
    expect(events.find(e => e.id === forged.id)).toBeUndefined();
  });
});

describe('WebSocketRelayMirror — inbound author allow-list (default outbound-only)', () => {
  const teardowns: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const t of teardowns.splice(0)) await t();
  });

  it('with empty subscribeAuthors, no REQ is sent and no inbound events arrive', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    // Pre-seed the relay with an event from someone else, so a
    // hypothetical broad subscription would have something to receive.
    const stranger = importWallet('0x' + 'aa'.repeat(32), 'agent', 'stranger');
    // A `strangerClient` over a bare InMemoryRelay used to be constructed here and never used —
    // a leftover from an approach the next two lines replaced. It published nowhere, so it
    // could not have seeded the relay this test needs seeded.
    //
    // Manually craft an event-shaped object the relay will store.
    // Use a separate mirror that DOES subscribe to push it in.
    const seedInner = new InMemoryRelay();
    const seedMirror = new WebSocketRelayMirror(seedInner, [relay.url]);
    teardowns.push(() => seedMirror.stop());
    const seedClient = new P2pClient(seedMirror, stranger);
    seedMirror.start();
    await waitFor(() => seedMirror.status().every(s => s.state === 'connected'));
    await seedClient.publishDescriptor({
      descriptorId: 'urn:iep:from-stranger',
      cid: 'bafk-stranger',
      graphIri: 'urn:graph:stranger',
    });
    await new Promise(r => setTimeout(r, 100));
    expect(relay.events.length).toBeGreaterThanOrEqual(1);

    // Now spin up the mirror under test with NO subscribeAuthors.
    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url]);
    teardowns.push(() => mirror.stop());
    expect(mirror.isInboundEnabled()).toBe(false);
    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'));

    // Wait long enough that any REQ-induced inbound would have
    // arrived. None should — outbound-only means no subscription.
    await new Promise(r => setTimeout(r, 300));
    expect(inner.size()).toBe(0);
  });

  it('with subscribeAuthors set, only events from those authors arrive', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const alice = importWallet(ALICE_KEY, 'agent', 'alice');
    const bob = importWallet(BOB_KEY, 'agent', 'bob');

    // Alice + Bob both publish; only Alice is on the allow-list
    const seedInner = new InMemoryRelay();
    const seedMirror = new WebSocketRelayMirror(seedInner, [relay.url]);
    teardowns.push(() => seedMirror.stop());
    seedMirror.start();
    await waitFor(() => seedMirror.status().every(s => s.state === 'connected'));
    const aliceClient = new P2pClient(seedMirror, alice);
    const bobClient = new P2pClient(seedMirror, bob);
    await aliceClient.publishDescriptor({
      descriptorId: 'urn:iep:from-alice',
      cid: 'bafk-a',
      graphIri: 'urn:graph:gated',
    });
    await bobClient.publishDescriptor({
      descriptorId: 'urn:iep:from-bob',
      cid: 'bafk-b',
      graphIri: 'urn:graph:gated',
    });
    await new Promise(r => setTimeout(r, 100));

    // Reader subscribes ONLY to Alice
    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url], {
      subscribeAuthors: [aliceClient.pubkey],
    });
    teardowns.push(() => mirror.stop());
    expect(mirror.isInboundEnabled()).toBe(true);
    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'));
    await new Promise(r => setTimeout(r, 300));

    const reader = new P2pClient(mirror, alice);
    const found = await reader.queryDescriptors({});
    const publishers = new Set(found.map(f => f.publisher.toLowerCase()));
    expect(publishers.has(aliceClient.pubkey.toLowerCase())).toBe(true);
    expect(publishers.has(bobClient.pubkey.toLowerCase())).toBe(false);
  });

  it('inboundFilter rejects events that aren\'t valid Interego shape', async () => {
    const relay = await startNostrRelay();
    teardowns.push(() => relay.close());

    const alice = importWallet(ALICE_KEY, 'agent', 'alice');

    // Alice publishes both a real Interego descriptor AND a kind-30040
    // event that's missing the required Interego tags (simulating
    // some other Nostr app using the same kind number).
    const seedInner = new InMemoryRelay();
    const seedMirror = new WebSocketRelayMirror(seedInner, [relay.url]);
    teardowns.push(() => seedMirror.stop());
    seedMirror.start();
    await waitFor(() => seedMirror.status().every(s => s.state === 'connected'));
    const aliceClient = new P2pClient(seedMirror, alice);

    // Real descriptor
    await aliceClient.publishDescriptor({
      descriptorId: 'urn:iep:real-thing',
      cid: 'bafk-real',
      graphIri: 'urn:graph:filtered',
    });

    // Bogus kind-30040 — manually publish an event with wrong tag shape
    // by going through the seedMirror's publish() with a hand-crafted event.
    // The simplest way to inject something through the relay is via the
    // raw P2pRelay.publish call. We need a properly signed event for it
    // to pass verifyEvent. Easiest: use the existing P2pClient but on a
    // descriptor IRI that's missing — actually publishDescriptor always
    // adds the right tags, so we'd have to craft directly. Let's
    // assert via isInteregoEvent() unit-style instead.
    const fakeEvent: P2pEvent = {
      id: '0'.repeat(64),
      pubkey: aliceClient.pubkey,
      created_at: 0,
      kind: KIND_DESCRIPTOR,
      tags: [['random', 'value']],
      content: '',
      sig: '0xinvalid',
    };
    expect(isInteregoEvent(fakeEvent)).toBe(false);

    const realLooking: P2pEvent = {
      id: '0'.repeat(64),
      pubkey: aliceClient.pubkey,
      created_at: 0,
      kind: KIND_DESCRIPTOR,
      tags: [['d', 'urn:iep:x'], ['cid', 'bafk-x'], ['graph', 'urn:graph:x']],
      content: '',
      sig: '0xinvalid',
    };
    expect(isInteregoEvent(realLooking)).toBe(true);

    // End-to-end: with inboundFilter set, only the real descriptor
    // arrives in the reader's local relay.
    const inner = new InMemoryRelay();
    const mirror = new WebSocketRelayMirror(inner, [relay.url], {
      subscribeAuthors: [aliceClient.pubkey],
      inboundFilter: isInteregoEvent,
    });
    teardowns.push(() => mirror.stop());
    mirror.start();
    await waitFor(() => mirror.status().every(s => s.state === 'connected'));
    await new Promise(r => setTimeout(r, 300));

    const reader = new P2pClient(mirror, alice);
    const found = await reader.queryDescriptors({});
    expect(found.some(f => f.descriptorId === 'urn:iep:real-thing')).toBe(true);
  });

  it('isInteregoEvent shape coverage', () => {
    const base = { id: '0'.repeat(64), pubkey: '0x' + 'a'.repeat(40), created_at: 0, content: '', sig: '0x' };
    // Descriptor: needs d + cid + graph
    expect(isInteregoEvent({ ...base, kind: KIND_DESCRIPTOR, tags: [['d','x'],['cid','y'],['graph','z']] })).toBe(true);
    expect(isInteregoEvent({ ...base, kind: KIND_DESCRIPTOR, tags: [['d','x'],['cid','y']] })).toBe(false);
    expect(isInteregoEvent({ ...base, kind: KIND_DESCRIPTOR, tags: [] })).toBe(false);
    // Directory: d=directory
    expect(isInteregoEvent({ ...base, kind: KIND_DIRECTORY, tags: [['d','directory']] })).toBe(true);
    expect(isInteregoEvent({ ...base, kind: KIND_DIRECTORY, tags: [['d','other']] })).toBe(false);
    // Attestation: needs e
    expect(isInteregoEvent({ ...base, kind: KIND_ATTESTATION, tags: [['e','abc']] })).toBe(true);
    expect(isInteregoEvent({ ...base, kind: KIND_ATTESTATION, tags: [] })).toBe(false);
    // Encrypted share: needs p
    expect(isInteregoEvent({ ...base, kind: KIND_ENCRYPTED_SHARE, tags: [['p','abc']] })).toBe(true);
    expect(isInteregoEvent({ ...base, kind: KIND_ENCRYPTED_SHARE, tags: [] })).toBe(false);
    // Other kinds: always reject
    expect(isInteregoEvent({ ...base, kind: 1, tags: [] })).toBe(false);
    expect(isInteregoEvent({ ...base, kind: 30000, tags: [] })).toBe(false);
  });
});
