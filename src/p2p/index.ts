/**
 * @module p2p
 * @description Nostr-style relay-mediated transport for Interego.
 *
 *   This is Tier 5 of spec/STORAGE-TIERS.md. The transport is
 *   relay-mediated (not strictly P2P-libp2p) but federated +
 *   censorship-resistant: relays are commodity, multiple per client,
 *   no single relay is authoritative. The same WebSocket-shaped
 *   transport works on mobile (claude.ai app, ChatGPT app) and
 *   desktop (Claude Code, custom MCP clients) without any special
 *   infrastructure beyond knowing the relay URL.
 *
 *   In-process: use InMemoryRelay for tests, demos, single-process
 *   simulation.
 *
 *   Cross-process / cross-surface: implement P2pRelay against a
 *   WebSocket pointed at any conformant Nostr relay, or against a
 *   custom Interego-only relay you operate.
 *
 *   See docs/p2p.md for the cross-surface deployment story.
 */

export {
  KIND_DESCRIPTOR,
  KIND_DIRECTORY,
  KIND_ATTESTATION,
  KIND_ENCRYPTED_SHARE,
  detectSignatureScheme,
} from './types.js';
export type {
  P2pEvent,
  P2pFilter,
  P2pRelay,
  P2pSubscription,
  DescriptorAnnouncement,
  DirectoryEntry,
  EncryptedShare,
  SignatureScheme,
} from './types.js';

export { P2pClient, verifyEvent } from './client.js';
export type {
  PublishDescriptorInput,
  PublishDirectoryInput,
  PublishEncryptedShareInput,
} from './client.js';

export { InMemoryRelay } from './relay.js';
export { FileBackedRelay } from './file-backed-relay.js';
export type { FileBackedRelayOptions } from './file-backed-relay.js';
export { WebSocketRelayMirror } from './websocket-relay-mirror.js';
export type {
  RelayConnectionStatus,
  MirrorOptions,
} from './websocket-relay-mirror.js';
