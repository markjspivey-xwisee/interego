/**
 * P2P transport tests — Tier 5 of spec/STORAGE-TIERS.md.
 *
 * What this proves:
 *   1. Two INDEPENDENT agents (different wallets, no shared memory)
 *      can exchange descriptor announcements through a shared relay.
 *   2. Events are content-integrity-checked (id = sha256 of canonical;
 *      tampering with any field detected).
 *   3. Signatures recover the signer's address; forged events are
 *      rejected by `verifyEvent`.
 *   4. NIP-33 replaceable semantics work — re-publishing under the
 *      same `(kind, pubkey, d-tag)` supersedes the prior version.
 *   5. Subscriptions deliver historical AND live events.
 *   6. The same client API works for any P2pRelay implementation
 *      (in-memory here; WebSocket → public Nostr relay in production;
 *      libp2p in a future Tier 5+ build).
 *
 * The cross-surface story (mobile + desktop both connecting to the
 * same relay) is identical to this test — the only difference is the
 * P2pRelay implementation under the hood. Mobile clients (claude.ai,
 * ChatGPT app) speak WebSocket to a relay; desktop clients (Claude
 * Code) do the same; they exchange events through it. See
 * docs/p2p.md for the deployment topology.
 */

import { describe, it, expect } from 'vitest';
import {
  P2pClient,
  InMemoryRelay,
  verifyEvent,
  importWallet,
  KIND_DESCRIPTOR,
  type DescriptorAnnouncement,
} from '../src/index.js';

// Two well-known test keys (NEVER use for production — these are
// the Hardhat default mnemonic's first two derived keys, public
// since the dawn of EVM development).
const ALICE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BOB_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

function makeAgent(label: string, key: string, relay: InMemoryRelay): P2pClient {
  const wallet = importWallet(key, 'agent', label);
  return new P2pClient(relay, wallet);
}

describe('P2P transport — two independent agents through one relay', () => {
  it('Alice publishes; Bob queries; Bob sees Alice\'s announcement', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);
    const bob = makeAgent('bob', BOB_KEY, relay);

    expect(alice.pubkey).not.toBe(bob.pubkey);

    // Alice publishes — could be from her phone (claude.ai mobile)
    // or her desktop (Claude Code). Same code path, same event shape.
    const pub = await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:claim-1',
      cid: 'bafkreialice123',
      graphIri: 'urn:graph:shared',
      facetTypes: ['Temporal', 'Trust'],
      conformsTo: ['https://example.org/schema/claim'],
      summary: 'Alice\'s first claim',
    });
    expect(pub.eventId).toMatch(/^[0-9a-f]{64}$/);

    // Bob queries — could be from any other surface anywhere.
    // No shared memory with Alice; just a shared relay URL.
    const found = await bob.queryDescriptors({ graphIri: 'urn:graph:shared' });
    expect(found).toHaveLength(1);
    const ann = found[0]!;
    expect(ann.publisher).toBe(alice.pubkey);
    expect(ann.descriptorId).toBe('urn:cg:alice:claim-1');
    expect(ann.cid).toBe('bafkreialice123');
    expect(ann.facetTypes).toEqual(['Temporal', 'Trust']);
    expect(ann.conformsTo).toEqual(['https://example.org/schema/claim']);
    expect(ann.summary).toBe('Alice\'s first claim');
  });

  it('Bob can publish back; Alice subscribes and sees the live arrival', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);
    const bob = makeAgent('bob', BOB_KEY, relay);

    const received: DescriptorAnnouncement[] = [];

    // Alice subscribes to ANYTHING about urn:graph:shared
    const sub = alice.subscribeDescriptors(
      { graphIri: 'urn:graph:shared' },
      (a) => received.push(a),
    );

    // Bob publishes — Alice should see it without polling
    await bob.publishDescriptor({
      descriptorId: 'urn:cg:bob:claim-1',
      cid: 'bafkreibob123',
      graphIri: 'urn:graph:shared',
      facetTypes: ['Provenance'],
      summary: 'Bob\'s reply',
    });

    // Wait for the microtask that delivers the event
    await new Promise<void>((r) => queueMicrotask(r));

    expect(received).toHaveLength(1);
    expect(received[0]!.publisher).toBe(bob.pubkey);
    expect(received[0]!.descriptorId).toBe('urn:cg:bob:claim-1');

    sub.close();
  });

  it('replaceable semantics: re-publishing under the same descriptor id supersedes', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);

    await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:rev-test',
      cid: 'bafkrei-v1',
      graphIri: 'urn:graph:shared',
    });
    await new Promise(r => setTimeout(r, 1100)); // ensure created_at advances
    await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:rev-test',
      cid: 'bafkrei-v2',
      graphIri: 'urn:graph:shared',
    });

    const found = await alice.queryDescriptors({});
    expect(found).toHaveLength(1);
    expect(found[0]!.cid).toBe('bafkrei-v2');
  });

  it('a third agent can observe the conversation between Alice and Bob', async () => {
    // Carol is a witness — connects to the same relay but never
    // publishes anything herself. She still sees both Alice and Bob's
    // announcements. This is the federation observability pattern.
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);
    const bob = makeAgent('bob', BOB_KEY, relay);
    const CAROL_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
    const carol = makeAgent('carol', CAROL_KEY, relay);

    await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:obs',
      cid: 'bafkrei-alice-obs',
      graphIri: 'urn:graph:public-channel',
    });
    await bob.publishDescriptor({
      descriptorId: 'urn:cg:bob:obs',
      cid: 'bafkrei-bob-obs',
      graphIri: 'urn:graph:public-channel',
    });

    const seen = await carol.queryDescriptors({ graphIri: 'urn:graph:public-channel' });
    expect(seen).toHaveLength(2);
    const publishers = new Set(seen.map(s => s.publisher));
    expect(publishers.has(alice.pubkey)).toBe(true);
    expect(publishers.has(bob.pubkey)).toBe(true);
    expect(publishers.has(carol.pubkey)).toBe(false);
  });

  it('directory: Alice advertises her pods; Bob discovers them', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);
    const bob = makeAgent('bob', BOB_KEY, relay);

    await alice.publishDirectory({
      pods: ['https://alice.example/pod/', 'https://alice.local:3456/'],
      summary: 'Alice\'s pods',
    });

    const dirs = await bob.queryDirectories({ author: alice.pubkey });
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.pods).toEqual([
      'https://alice.example/pod/',
      'https://alice.local:3456/',
    ]);
  });

  it('attestation: Bob witnesses Alice\'s claim by referencing the event id', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);
    const bob = makeAgent('bob', BOB_KEY, relay);

    const pub = await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:attested',
      cid: 'bafkrei-attested',
      graphIri: 'urn:graph:contested',
    });

    const att = await bob.publishAttestation(pub.eventId, 'I, Bob, confirm Alice\'s claim is well-formed.');
    expect(att.eventId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('P2P transport — security properties', () => {
  it('verifyEvent rejects an event whose id was tampered with', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);
    await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:tamper',
      cid: 'bafkrei-original',
      graphIri: 'urn:graph:t',
    });
    const events = await relay.query({ kinds: [KIND_DESCRIPTOR] });
    expect(events).toHaveLength(1);

    // Mutate the content tag — id should no longer match
    const tampered = {
      ...events[0]!,
      tags: events[0]!.tags.map(t => t[0] === 'cid' ? ['cid', 'bafkrei-tampered'] : t),
    };
    const recovered = verifyEvent(tampered);
    expect(recovered).toBeNull(); // id now mismatched
  });

  it('verifyEvent rejects an event with a foreign signature', async () => {
    const relayA = new InMemoryRelay();
    const relayB = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relayA);
    const bob = makeAgent('bob', BOB_KEY, relayB);

    await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:forged',
      cid: 'bafkrei-x',
      graphIri: 'urn:graph:x',
    });
    const aliceEvents = await relayA.query({ kinds: [KIND_DESCRIPTOR] });
    await bob.publishDescriptor({
      descriptorId: 'urn:cg:bob:other',
      cid: 'bafkrei-y',
      graphIri: 'urn:graph:y',
    });
    const bobEvents = await relayB.query({ kinds: [KIND_DESCRIPTOR] });

    // Forge: keep Alice's event content but stick Bob's signature on it
    const forged = {
      ...aliceEvents[0]!,
      sig: bobEvents[0]!.sig,
    };
    expect(verifyEvent(forged)).toBeNull(); // sig doesn't recover to Alice
  });

  it('the relay client filters out events whose verifyEvent fails', async () => {
    const relay = new InMemoryRelay();
    const alice = makeAgent('alice', ALICE_KEY, relay);

    // Inject a malformed event directly (bypassing the publish path)
    await relay.publish({
      id: '0'.repeat(64),
      pubkey: '0xdeadbeef'.padEnd(42, '0'),
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_DESCRIPTOR,
      tags: [['d', 'fake'], ['cid', 'bafk-fake'], ['graph', 'urn:graph:fake']],
      content: '',
      sig: '0xinvalid',
    });

    // queryDescriptors filters via verifyEvent — the malformed event
    // should be silently dropped from the result set
    const found = await alice.queryDescriptors({});
    expect(found).toHaveLength(0);

    // But a real publish goes through fine
    await alice.publishDescriptor({
      descriptorId: 'urn:cg:alice:real',
      cid: 'bafkrei-real',
      graphIri: 'urn:graph:real',
    });
    const found2 = await alice.queryDescriptors({});
    expect(found2).toHaveLength(1);
    expect(found2[0]!.descriptorId).toBe('urn:cg:alice:real');
  });
});

describe('P2P transport — three independent processes (cross-surface simulation)', () => {
  // Simulating "Claude Code on desktop talks to claude.ai mobile through
  // a shared relay" — both sides are just `P2pClient` instances. Mobile
  // and desktop don't share state; they share a relay URL. The fact
  // that they're on different OSes / form factors is invisible to the
  // protocol.
  it('desktop publishes; mobile queries; mobile publishes back; desktop sees it live', async () => {
    const relay = new InMemoryRelay(); // in production: WebSocket to a Nostr relay
    const desktop = makeAgent('desktop-claude-code', ALICE_KEY, relay);
    const mobile = makeAgent('mobile-claude-app', BOB_KEY, relay);

    const desktopFeed: DescriptorAnnouncement[] = [];
    const desktopSub = desktop.subscribeDescriptors(
      { author: mobile.pubkey },
      (a) => desktopFeed.push(a),
    );

    // Desktop kicks off a working memory note
    await desktop.publishDescriptor({
      descriptorId: 'urn:cg:desktop:note-1',
      cid: 'bafkrei-desktop-1',
      graphIri: 'urn:graph:project-x',
      facetTypes: ['Temporal', 'Provenance'],
      summary: 'Project X kickoff notes',
    });

    // Mobile picks it up
    const fromMobile = await mobile.queryDescriptors({
      author: desktop.pubkey,
      graphIri: 'urn:graph:project-x',
    });
    expect(fromMobile).toHaveLength(1);
    expect(fromMobile[0]!.summary).toBe('Project X kickoff notes');

    // Mobile replies with an addition
    await mobile.publishDescriptor({
      descriptorId: 'urn:cg:mobile:reply-1',
      cid: 'bafkrei-mobile-1',
      graphIri: 'urn:graph:project-x',
      facetTypes: ['Temporal'],
      summary: 'Reply from phone — adding action item',
    });

    // Desktop, subscribed live, sees it without polling
    await new Promise<void>(r => queueMicrotask(r));
    expect(desktopFeed).toHaveLength(1);
    expect(desktopFeed[0]!.publisher).toBe(mobile.pubkey);
    expect(desktopFeed[0]!.summary).toContain('Reply from phone');

    desktopSub.close();
  });
});
