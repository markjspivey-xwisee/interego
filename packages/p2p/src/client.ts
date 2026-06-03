/**
 * @module p2p/client
 * @description Sign + publish + query + subscribe over a Nostr-style
 * relay. Adapts the protocol's existing publish/discover/subscribe
 * verbs onto signed events that flow through any conformant relay
 * (in-memory, WebSocket-to-public-Nostr, libp2p-backed peer).
 *
 * Two signing schemes supported:
 *
 *   - ECDSA (default) — uses the operator's Ethereum-style wallet
 *     directly. The event's `pubkey` is the wallet's 0x-prefixed
 *     20-byte address. Signature recovers to the address.
 *
 *   - Schnorr (BIP-340 / NIP-01) — uses the same private key as
 *     ECDSA but the `pubkey` is the 32-byte x-only form (64 hex,
 *     no prefix). Required for interop with public Nostr relays.
 *
 * Both schemes coexist on the wire — the `detectSignatureScheme`
 * helper picks the right verifier from the pubkey format.
 */

import {
  sha256,
  signMessageRaw,
  recoverMessageSigner,
  exportPrivateKey,
  schnorrSign,
  schnorrVerify,
  getNostrPubkey,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  type EncryptedEnvelope,
  type EncryptionKeyPair,
  type Wallet,
} from '@interego/core';
import {
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ATTESTATION,
  KIND_ENCRYPTED_SHARE,
  detectSignatureScheme,
  type SignatureScheme,
  type P2pEvent,
  type P2pFilter,
  type P2pRelay,
  type P2pSubscription,
  type DescriptorAnnouncement,
  type DirectoryEntry,
  type EncryptedShare,
} from './types.js';

// ── Canonical event ID (per NIP-01 §3) ──────────────────────

function canonicalize(unsigned: Omit<P2pEvent, 'id' | 'sig'>): string {
  return JSON.stringify([
    0,
    unsigned.pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);
}

function computeEventId(unsigned: Omit<P2pEvent, 'id' | 'sig'>): string {
  return sha256(canonicalize(unsigned));
}

// ── Signing + verification (scheme-dispatched) ──────────────

interface ClientOptions {
  /**
   * Signing scheme this client uses for outbound events. Default 'ecdsa'.
   * Switch to 'schnorr' for public-Nostr-relay interop. Verification
   * always supports both schemes regardless of this setting.
   */
  readonly signingScheme?: SignatureScheme;
  /**
   * Optional X25519 keypair for receiving encrypted shares. If
   * omitted, the client can publish + query but cannot decrypt.
   * Generate with `generateKeyPair()` from crypto/encryption.
   */
  readonly encryptionKeyPair?: EncryptionKeyPair;
}

async function signEvent(
  wallet: Wallet,
  scheme: SignatureScheme,
  privateKeyHex: string | null,
  partial: { kind: number; tags: readonly (readonly string[])[]; content: string },
): Promise<P2pEvent> {
  const created_at = Math.floor(Date.now() / 1000);
  const pubkey = scheme === 'schnorr'
    ? getNostrPubkey(privateKeyHex!)
    : wallet.address;
  const unsigned = {
    pubkey,
    created_at,
    kind: partial.kind,
    tags: partial.tags,
    content: partial.content,
  };
  const id = computeEventId(unsigned);
  const sig = scheme === 'schnorr'
    ? schnorrSign(id, privateKeyHex!)
    : await signMessageRaw(wallet, id);
  return { ...unsigned, id, sig };
}

/**
 * Verify an event's id matches its content + the signature is valid
 * under whichever scheme is implied by the pubkey format.
 *
 * Returns the verified pubkey (canonicalized) on success, null otherwise.
 */
export function verifyEvent(event: P2pEvent): string | null {
  // 1. id integrity — guards against tampering with any field other
  //    than id+sig
  const expectedId = computeEventId({
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  });
  if (expectedId !== event.id) return null;

  // 2. signature verification, dispatched on pubkey format
  const scheme = detectSignatureScheme(event.pubkey);
  if (scheme === null) return null;

  if (scheme === 'schnorr') {
    return schnorrVerify(event.sig, event.id, event.pubkey)
      ? event.pubkey.toLowerCase()
      : null;
  }
  // ECDSA path
  try {
    const recovered = recoverMessageSigner(event.id, event.sig);
    if (recovered.toLowerCase() !== event.pubkey.toLowerCase()) return null;
    return recovered;
  } catch {
    return null;
  }
}

// ── Tag extraction helpers ───────────────────────────────────

function tagValue(tags: readonly (readonly string[])[], name: string): string | undefined {
  return tags.find(t => t[0] === name)?.[1];
}

function tagValues(tags: readonly (readonly string[])[], name: string): string[] {
  return tags.filter(t => t[0] === name).map(t => t[1] ?? '').filter(Boolean);
}

// ── Public input shapes ──────────────────────────────────────

export interface PublishDescriptorInput {
  readonly descriptorId: string;
  readonly cid: string;
  readonly graphIri: string;
  readonly facetTypes?: readonly string[];
  readonly conformsTo?: readonly string[];
  readonly summary?: string;
}

export interface PublishDirectoryInput {
  readonly pods: readonly string[];
  readonly summary?: string;
}

export interface PublishEncryptedShareInput {
  /** Plaintext payload to encrypt + share. */
  readonly plaintext: string;
  /** Recipients — each needs both their signing and encryption pubkeys. */
  readonly recipients: readonly { sigPubkey: string; encryptionPubkey: string }[];
  /** Sender's X25519 keypair (used for envelope wrapping). */
  readonly senderEncryptionKeyPair: EncryptionKeyPair;
  /** Optional tag exposing the topic; aids filtering. */
  readonly topic?: string;
}

// ── The client ──────────────────────────────────────────────

export class P2pClient {
  private readonly scheme: SignatureScheme;
  private readonly privateKeyHex: string | null;
  private readonly encryptionKeyPair: EncryptionKeyPair | null;
  /** Cached signing pubkey — Ethereum address for ECDSA, x-only hex for Schnorr. */
  readonly pubkey: string;

  constructor(
    private readonly relay: P2pRelay,
    private readonly wallet: Wallet,
    options: ClientOptions = {},
  ) {
    this.scheme = options.signingScheme ?? 'ecdsa';
    this.encryptionKeyPair = options.encryptionKeyPair ?? null;

    // Schnorr needs the raw private key. We accept the wallet
    // (preserving the established API surface) and pull the key
    // through exportPrivateKey when necessary. ECDSA goes through
    // signMessageRaw which uses the in-process key store.
    if (this.scheme === 'schnorr') {
      this.privateKeyHex = exportPrivateKey(wallet.address);
      this.pubkey = getNostrPubkey(this.privateKeyHex);
    } else {
      this.privateKeyHex = null;
      this.pubkey = wallet.address;
    }
  }

  /** Announce a descriptor. Returns the event ID. */
  async publishDescriptor(input: PublishDescriptorInput): Promise<{ eventId: string }> {
    const tags: string[][] = [
      ['d', input.descriptorId],
      ['cid', input.cid],
      ['graph', input.graphIri],
    ];
    for (const f of input.facetTypes ?? []) tags.push(['facet', f]);
    for (const c of input.conformsTo ?? []) tags.push(['conformsTo', c]);
    return this.publishEvent(KIND_DESCRIPTOR, tags, input.summary ?? '');
  }

  /** Announce a pod directory. */
  async publishDirectory(input: PublishDirectoryInput): Promise<{ eventId: string }> {
    const tags: string[][] = [['d', 'directory']];
    for (const p of input.pods) tags.push(['pod', p]);
    return this.publishEvent(KIND_DIRECTORY, tags, input.summary ?? '');
  }

  /** Attest to another event. */
  async publishAttestation(refEventId: string, content: string): Promise<{ eventId: string }> {
    return this.publishEvent(KIND_ATTESTATION, [['e', refEventId]], content);
  }

  /**
   * Publish a 1:N encrypted share. The plaintext is wrapped in a NaCl
   * envelope, with one wrapped key per recipient X25519 pubkey. The
   * event itself is signed under the sender's wallet (ECDSA or Schnorr,
   * whichever the client is configured for).
   *
   * Recipients tag (`p`) carries each recipient's *signing* pubkey so
   * they can filter for events addressed to them. The *encryption*
   * pubkeys live inside the envelope — invisible to the relay.
   */
  async publishEncryptedShare(input: PublishEncryptedShareInput): Promise<{ eventId: string }> {
    const envelope = createEncryptedEnvelope(
      input.plaintext,
      input.recipients.map(r => r.encryptionPubkey),
      input.senderEncryptionKeyPair,
    );
    const tags: string[][] = [];
    for (const r of input.recipients) tags.push(['p', r.sigPubkey]);
    if (input.topic) tags.push(['topic', input.topic]);
    return this.publishEvent(
      KIND_ENCRYPTED_SHARE,
      tags,
      JSON.stringify(envelope),
    );
  }

  /** Find descriptor announcements matching the filter. */
  async queryDescriptors(filter: {
    author?: string;
    graphIri?: string;
    facet?: string;
    since?: number;
    limit?: number;
  } = {}): Promise<DescriptorAnnouncement[]> {
    const f: P2pFilter = {
      kinds: [KIND_DESCRIPTOR],
      ...(filter.author && { authors: [filter.author] }),
      ...(filter.graphIri && { ['#graph' as const]: [filter.graphIri] }),
      ...(filter.facet && { ['#facet' as const]: [filter.facet] }),
      ...(filter.since !== undefined && { since: filter.since }),
      ...(filter.limit !== undefined && { limit: filter.limit }),
    };
    const events = await this.relay.query(f);
    return events
      .filter(e => verifyEvent(e) !== null)
      .map(e => decodeDescriptorAnnouncement(e))
      .filter((a): a is DescriptorAnnouncement => a !== null);
  }

  /** Subscribe to descriptor events as they arrive. */
  subscribeDescriptors(
    filter: { author?: string; graphIri?: string },
    onAnnouncement: (a: DescriptorAnnouncement) => void,
  ): P2pSubscription {
    const f: P2pFilter = {
      kinds: [KIND_DESCRIPTOR],
      ...(filter.author && { authors: [filter.author] }),
      ...(filter.graphIri && { ['#graph' as const]: [filter.graphIri] }),
    };
    return this.relay.subscribe(f, e => {
      if (verifyEvent(e) === null) return;
      const decoded = decodeDescriptorAnnouncement(e);
      if (decoded) onAnnouncement(decoded);
    });
  }

  /** Find directories. */
  async queryDirectories(filter: { author?: string } = {}): Promise<DirectoryEntry[]> {
    const f: P2pFilter = {
      kinds: [KIND_DIRECTORY],
      ['#d' as const]: ['directory'],
      ...(filter.author && { authors: [filter.author] }),
    };
    const events = await this.relay.query(f);
    return events
      .filter(e => verifyEvent(e) !== null)
      .map(e => ({
        eventId: e.id,
        publisher: e.pubkey,
        publishedAt: e.created_at,
        pods: tagValues(e.tags, 'pod'),
        summary: e.content,
      }));
  }

  /**
   * Find encrypted shares addressed to a particular recipient (by
   * their signing pubkey). The events come back with the envelope
   * field opaque — call `decryptEncryptedShare` to actually open one.
   */
  async queryEncryptedShares(filter: {
    recipientSigPubkey: string;
    fromSender?: string;
  }): Promise<EncryptedShare[]> {
    const f: P2pFilter = {
      kinds: [KIND_ENCRYPTED_SHARE],
      ['#p' as const]: [filter.recipientSigPubkey],
      ...(filter.fromSender && { authors: [filter.fromSender] }),
    };
    const events = await this.relay.query(f);
    return events
      .filter(e => verifyEvent(e) !== null)
      .map(e => decodeEncryptedShare(e));
  }

  /**
   * Decrypt an encrypted share. Requires the recipient's X25519
   * encryption keypair — pass it in the constructor (encryptionKeyPair)
   * or supply it explicitly here. Returns plaintext or null if the
   * client isn't an authorized recipient.
   */
  decryptEncryptedShare(share: EncryptedShare, keyPair?: EncryptionKeyPair): string | null {
    const kp = keyPair ?? this.encryptionKeyPair;
    if (!kp) {
      throw new Error(
        'No encryption keypair available. Pass one to the P2pClient constructor or to decryptEncryptedShare.',
      );
    }
    let envelope: EncryptedEnvelope;
    try {
      envelope = JSON.parse(share.envelope) as EncryptedEnvelope;
    } catch {
      return null;
    }
    return openEncryptedEnvelope(envelope, kp);
  }

  /** Subscribe to encrypted shares addressed to a particular recipient. */
  subscribeEncryptedShares(
    filter: { recipientSigPubkey: string; fromSender?: string },
    onShare: (share: EncryptedShare) => void,
  ): P2pSubscription {
    const f: P2pFilter = {
      kinds: [KIND_ENCRYPTED_SHARE],
      ['#p' as const]: [filter.recipientSigPubkey],
      ...(filter.fromSender && { authors: [filter.fromSender] }),
    };
    return this.relay.subscribe(f, e => {
      if (verifyEvent(e) === null) return;
      onShare(decodeEncryptedShare(e));
    });
  }

  // ── Internal helper ────────────────────────────────────────

  private async publishEvent(
    kind: number,
    tags: readonly (readonly string[])[],
    content: string,
  ): Promise<{ eventId: string }> {
    const event = await signEvent(
      this.wallet,
      this.scheme,
      this.privateKeyHex,
      { kind, tags, content },
    );
    const result = await this.relay.publish(event);
    if (!result.ok) throw new Error(`Relay rejected event: ${result.reason ?? 'unknown'}`);
    return { eventId: event.id };
  }
}

// ── Decoders ─────────────────────────────────────────────────

function decodeDescriptorAnnouncement(event: P2pEvent): DescriptorAnnouncement | null {
  const descriptorId = tagValue(event.tags, 'd');
  const cid = tagValue(event.tags, 'cid');
  const graphIri = tagValue(event.tags, 'graph');
  if (!descriptorId || !cid || !graphIri) return null;
  return {
    eventId: event.id,
    publisher: event.pubkey,
    publishedAt: event.created_at,
    descriptorId,
    cid,
    graphIri,
    facetTypes: tagValues(event.tags, 'facet'),
    conformsTo: tagValues(event.tags, 'conformsTo'),
    summary: event.content,
  };
}

function decodeEncryptedShare(event: P2pEvent): EncryptedShare {
  return {
    eventId: event.id,
    sender: event.pubkey,
    publishedAt: event.created_at,
    recipientPubkeys: tagValues(event.tags, 'p'),
    topic: tagValue(event.tags, 'topic'),
    envelope: event.content,
  };
}
