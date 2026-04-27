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
  generateKeyPair,
  detectSignatureScheme,
  KIND_DESCRIPTOR,
  KIND_ENCRYPTED_SHARE,
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

describe('P2P transport — Schnorr signatures (BIP-340 / public-Nostr interop)', () => {
  it('the same wallet can publish ECDSA AND Schnorr events; both verify', async () => {
    const relay = new InMemoryRelay();
    const wallet = importWallet(ALICE_KEY, 'agent', 'alice');

    // Two clients backed by the SAME wallet; one ECDSA, one Schnorr.
    // Different pubkey representations, same private key, both are
    // legitimately Alice.
    const ecdsaClient = new P2pClient(relay, wallet, { signingScheme: 'ecdsa' });
    const schnorrClient = new P2pClient(relay, wallet, { signingScheme: 'schnorr' });

    expect(detectSignatureScheme(ecdsaClient.pubkey)).toBe('ecdsa');
    expect(detectSignatureScheme(schnorrClient.pubkey)).toBe('schnorr');
    expect(ecdsaClient.pubkey).not.toBe(schnorrClient.pubkey);
    // ECDSA pubkey = Ethereum address (0x + 40 hex chars)
    expect(ecdsaClient.pubkey).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Schnorr pubkey = 32-byte x-only (64 hex chars, no prefix)
    expect(schnorrClient.pubkey).toMatch(/^[0-9a-f]{64}$/);

    // Publish one of each kind through the same relay
    await ecdsaClient.publishDescriptor({
      descriptorId: 'urn:cg:dual-ecdsa',
      cid: 'bafkrei-ecdsa',
      graphIri: 'urn:graph:dual',
    });
    await schnorrClient.publishDescriptor({
      descriptorId: 'urn:cg:dual-schnorr',
      cid: 'bafkrei-schnorr',
      graphIri: 'urn:graph:dual',
    });

    // Both events present, both verify under their own scheme
    const all = await relay.query({ kinds: [KIND_DESCRIPTOR] });
    expect(all).toHaveLength(2);
    for (const event of all) {
      expect(verifyEvent(event)).not.toBeNull();
    }
  });

  it('a tampered Schnorr event is rejected (signature does not verify)', async () => {
    const relay = new InMemoryRelay();
    const wallet = importWallet(ALICE_KEY, 'agent', 'alice');
    const client = new P2pClient(relay, wallet, { signingScheme: 'schnorr' });

    await client.publishDescriptor({
      descriptorId: 'urn:cg:schnorr-tamper',
      cid: 'bafkrei-original',
      graphIri: 'urn:graph:t',
    });
    const events = await relay.query({ kinds: [KIND_DESCRIPTOR] });
    const tampered = {
      ...events[0]!,
      tags: events[0]!.tags.map(t => t[0] === 'cid' ? ['cid', 'bafkrei-tampered'] : t),
    };
    expect(verifyEvent(tampered)).toBeNull();
  });

  it('a Schnorr-signed event with someone else\'s pubkey fails verification', async () => {
    const relay = new InMemoryRelay();
    const alice = new P2pClient(relay, importWallet(ALICE_KEY, 'agent', 'alice'), { signingScheme: 'schnorr' });
    const bob = new P2pClient(relay, importWallet(BOB_KEY, 'agent', 'bob'), { signingScheme: 'schnorr' });

    expect(alice.pubkey).not.toBe(bob.pubkey);

    await alice.publishDescriptor({
      descriptorId: 'urn:cg:from-alice',
      cid: 'bafkrei-a',
      graphIri: 'urn:graph:auth-test',
    });
    const events = await relay.query({ kinds: [KIND_DESCRIPTOR] });
    // Forge: claim Alice's event was actually signed by Bob (swap pubkey).
    // The signature is over the event id which depends on the original
    // pubkey, so even without changing sig, replacing the pubkey
    // changes the canonical id and breaks verification.
    const forged = { ...events[0]!, pubkey: bob.pubkey };
    expect(verifyEvent(forged)).toBeNull();
  });
});

describe('P2P transport — 1:N encrypted share (closes Tier 4 gap)', () => {
  it('Alice encrypts to Bob + Carol; only the addressed recipients can decrypt', async () => {
    const relay = new InMemoryRelay();

    // Three identities, each with separate signing wallet AND
    // X25519 encryption keypair. Encryption keypairs are X25519
    // (NaCl) — different cryptographic primitive from the Schnorr/
    // ECDSA secp256k1 keypair used for signing.
    const aliceWallet = importWallet(ALICE_KEY, 'agent', 'alice');
    const bobWallet = importWallet(BOB_KEY, 'agent', 'bob');
    const CAROL_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
    const carolWallet = importWallet(CAROL_KEY, 'agent', 'carol');
    const EVE_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
    const eveWallet = importWallet(EVE_KEY, 'agent', 'eve');

    const aliceEnc = generateKeyPair();
    const bobEnc = generateKeyPair();
    const carolEnc = generateKeyPair();
    const eveEnc = generateKeyPair();

    const alice = new P2pClient(relay, aliceWallet, { encryptionKeyPair: aliceEnc });
    const bob = new P2pClient(relay, bobWallet, { encryptionKeyPair: bobEnc });
    const carol = new P2pClient(relay, carolWallet, { encryptionKeyPair: carolEnc });
    const eve = new P2pClient(relay, eveWallet, { encryptionKeyPair: eveEnc });

    // Alice publishes an encrypted share to Bob + Carol (NOT Eve)
    const SECRET = 'The quarterly numbers are: revenue $4.2M, runway 18mo';
    await alice.publishEncryptedShare({
      plaintext: SECRET,
      recipients: [
        { sigPubkey: bob.pubkey, encryptionPubkey: bobEnc.publicKey },
        { sigPubkey: carol.pubkey, encryptionPubkey: carolEnc.publicKey },
      ],
      senderEncryptionKeyPair: aliceEnc,
      topic: 'finance-q3',
    });

    // Bob queries for shares addressed to him
    const bobInbox = await bob.queryEncryptedShares({ recipientSigPubkey: bob.pubkey });
    expect(bobInbox).toHaveLength(1);
    const bobPlaintext = bob.decryptEncryptedShare(bobInbox[0]!);
    expect(bobPlaintext).toBe(SECRET);

    // Carol independently does the same
    const carolInbox = await carol.queryEncryptedShares({ recipientSigPubkey: carol.pubkey });
    expect(carolInbox).toHaveLength(1);
    expect(carol.decryptEncryptedShare(carolInbox[0]!)).toBe(SECRET);

    // Eve sees the event exists (no privacy from existence — it's a
    // public relay) but cannot read the content. Even if she fetches
    // the event by guessing or broad query, decryption fails.
    const eveInbox = await eve.queryEncryptedShares({ recipientSigPubkey: eve.pubkey });
    expect(eveInbox).toHaveLength(0); // Eve isn't tagged
    // What if Eve fetches the event some other way?
    const allShares = await relay.query({ kinds: [KIND_ENCRYPTED_SHARE] });
    expect(allShares).toHaveLength(1);
    // Eve takes the raw event and tries to decrypt with her keypair
    const stolenShare = {
      eventId: allShares[0]!.id,
      sender: allShares[0]!.pubkey,
      publishedAt: allShares[0]!.created_at,
      recipientPubkeys: allShares[0]!.tags.filter(t => t[0] === 'p').map(t => t[1] ?? ''),
      envelope: allShares[0]!.content,
    };
    expect(eve.decryptEncryptedShare(stolenShare, eveEnc)).toBeNull();
  });

  it('encrypted shares survive transport (live subscribe → decrypt)', async () => {
    const relay = new InMemoryRelay();
    const aliceWallet = importWallet(ALICE_KEY, 'agent', 'alice');
    const bobWallet = importWallet(BOB_KEY, 'agent', 'bob');
    const aliceEnc = generateKeyPair();
    const bobEnc = generateKeyPair();
    const alice = new P2pClient(relay, aliceWallet, { encryptionKeyPair: aliceEnc });
    const bob = new P2pClient(relay, bobWallet, { encryptionKeyPair: bobEnc });

    const received: string[] = [];
    const sub = bob.subscribeEncryptedShares(
      { recipientSigPubkey: bob.pubkey },
      async (share) => {
        const pt = bob.decryptEncryptedShare(share);
        if (pt) received.push(pt);
      },
    );

    await alice.publishEncryptedShare({
      plaintext: 'live message',
      recipients: [{ sigPubkey: bob.pubkey, encryptionPubkey: bobEnc.publicKey }],
      senderEncryptionKeyPair: aliceEnc,
    });
    await new Promise(r => queueMicrotask(r));

    expect(received).toEqual(['live message']);
    sub.close();
  });

  it('encrypted shares work with Schnorr-signed clients too', async () => {
    const relay = new InMemoryRelay();
    const aliceWallet = importWallet(ALICE_KEY, 'agent', 'alice');
    const bobWallet = importWallet(BOB_KEY, 'agent', 'bob');
    const aliceEnc = generateKeyPair();
    const bobEnc = generateKeyPair();
    const alice = new P2pClient(relay, aliceWallet, {
      signingScheme: 'schnorr',
      encryptionKeyPair: aliceEnc,
    });
    const bob = new P2pClient(relay, bobWallet, {
      signingScheme: 'schnorr',
      encryptionKeyPair: bobEnc,
    });

    await alice.publishEncryptedShare({
      plaintext: 'schnorr-signed encrypted hi',
      recipients: [{ sigPubkey: bob.pubkey, encryptionPubkey: bobEnc.publicKey }],
      senderEncryptionKeyPair: aliceEnc,
    });

    const inbox = await bob.queryEncryptedShares({ recipientSigPubkey: bob.pubkey });
    expect(inbox).toHaveLength(1);
    expect(bob.decryptEncryptedShare(inbox[0]!)).toBe('schnorr-signed encrypted hi');
  });
});

describe('P2P transport — desktop + mobile workflow (single-process verification)', () => {
  // Two independent P2pClients with separate wallets, exchanging
  // events through a shared relay. The desktop / mobile labels are
  // semantic, not architectural — the protocol doesn't know about
  // form factor; what matters is that the two clients share NO state
  // except a relay URL. For the actual cross-device manual test (real
  // phone + real desktop hitting a deployed bridge), see
  // docs/CROSS-DEVICE-TEST-PLAN.md.
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
