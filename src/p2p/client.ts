/**
 * @module p2p/client
 * @description Sign + publish + query + subscribe over a Nostr-style
 * relay. Adapts the protocol's existing publish/discover/subscribe
 * verbs onto signed events that flow through any conformant relay
 * (in-memory, WebSocket-to-public-Nostr, libp2p-backed peer).
 */

import { sha256 } from '../crypto/ipfs.js';
import { signMessageRaw, recoverMessageSigner } from '../crypto/wallet.js';
import type { Wallet } from '../crypto/types.js';
import {
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ATTESTATION,
  type P2pEvent,
  type P2pFilter,
  type P2pRelay,
  type P2pSubscription,
  type DescriptorAnnouncement,
  type DirectoryEntry,
} from './types.js';

// ── Canonical event ID (per NIP-01 §3) ──────────────────────
//
// id = sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content]))
// where the array is encoded with no whitespace and minimal escapes.

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

// ── Signing + verification ──────────────────────────────────

/**
 * Sign + finalize an event. Requires a Wallet whose private key is
 * loaded in this process (via importWallet / createWallet).
 *
 * NIP-01 §3 says the signature is over the event id (raw bytes). We
 * sign the hex string of the id with `signMessage` (ethers EIP-191
 * personal-sign), so verification is via `recoverMessageSigner`.
 * This deviates from BIP-340 Schnorr — the recovery property gives
 * us the signer address directly, which is what we want for the
 * wallet-as-identity model. A Schnorr adapter for public-Nostr
 * interop is a future drop-in.
 */
async function signEvent(
  wallet: Wallet,
  partial: { kind: number; tags: readonly (readonly string[])[]; content: string },
): Promise<P2pEvent> {
  const created_at = Math.floor(Date.now() / 1000);
  const unsigned = {
    pubkey: wallet.address,
    created_at,
    kind: partial.kind,
    tags: partial.tags,
    content: partial.content,
  };
  const id = computeEventId(unsigned);
  const sig = await signMessageRaw(wallet, id);
  return { ...unsigned, id, sig };
}

/**
 * Verify an event's id matches its content + the signature recovers
 * to the claimed pubkey. Returns the recovered address on success
 * (it should equal pubkey) or null if anything fails.
 */
export function verifyEvent(event: P2pEvent): string | null {
  // Recompute id from the canonical encoding — guards against
  // tampering with any field other than id+sig.
  const expectedId = computeEventId({
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
  });
  if (expectedId !== event.id) return null;
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

// ── The client ──────────────────────────────────────────────

export interface PublishDescriptorInput {
  /** The descriptor's IRI (becomes the `d` tag for replaceable semantics). */
  readonly descriptorId: string;
  /** IPFS CID of the descriptor turtle (where peers fetch the bytes). */
  readonly cid: string;
  /** The graph IRI this descriptor describes. */
  readonly graphIri: string;
  /** Facet types present (e.g., 'Temporal', 'Trust', 'Provenance'). */
  readonly facetTypes?: readonly string[];
  /** dct:conformsTo IRIs (e.g., schema URIs, regulatory frameworks). */
  readonly conformsTo?: readonly string[];
  /** Free-text or compact-JSON manifest summary. May be inlined when small. */
  readonly summary?: string;
}

export interface PublishDirectoryInput {
  /** Pod URLs this entity controls / advertises. */
  readonly pods: readonly string[];
  /** Free-text summary. */
  readonly summary?: string;
}

export class P2pClient {
  constructor(
    private readonly relay: P2pRelay,
    private readonly wallet: Wallet,
  ) {}

  /** The wallet's secp256k1 address — also this client's identity on the relay. */
  get pubkey(): string {
    return this.wallet.address;
  }

  /** Announce a descriptor to the relay. Returns the event ID. */
  async publishDescriptor(input: PublishDescriptorInput): Promise<{ eventId: string }> {
    const tags: string[][] = [
      ['d', input.descriptorId],
      ['cid', input.cid],
      ['graph', input.graphIri],
    ];
    for (const f of input.facetTypes ?? []) tags.push(['facet', f]);
    for (const c of input.conformsTo ?? []) tags.push(['conformsTo', c]);
    const event = await signEvent(this.wallet, {
      kind: KIND_DESCRIPTOR,
      tags,
      content: input.summary ?? '',
    });
    const result = await this.relay.publish(event);
    if (!result.ok) throw new Error(`Relay rejected event: ${result.reason ?? 'unknown'}`);
    return { eventId: event.id };
  }

  /** Announce a pod directory (which pods this identity controls). */
  async publishDirectory(input: PublishDirectoryInput): Promise<{ eventId: string }> {
    const tags: string[][] = [['d', 'directory']];
    for (const p of input.pods) tags.push(['pod', p]);
    const event = await signEvent(this.wallet, {
      kind: KIND_DIRECTORY,
      tags,
      content: input.summary ?? '',
    });
    const result = await this.relay.publish(event);
    if (!result.ok) throw new Error(`Relay rejected event: ${result.reason ?? 'unknown'}`);
    return { eventId: event.id };
  }

  /** Attest to another event (witness pattern). */
  async publishAttestation(refEventId: string, content: string): Promise<{ eventId: string }> {
    const event = await signEvent(this.wallet, {
      kind: KIND_ATTESTATION,
      tags: [['e', refEventId]],
      content,
    });
    const result = await this.relay.publish(event);
    if (!result.ok) throw new Error(`Relay rejected event: ${result.reason ?? 'unknown'}`);
    return { eventId: event.id };
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
