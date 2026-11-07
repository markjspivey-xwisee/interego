import type { EncryptedEnvelope, EncryptionKeyPair } from '@interego/core';

/** L3 opt-in snapshot sharing. This is separate from pod storage and MCP grants. */
export interface FederationProfile {
  readonly id: string;
  readonly name: string;
  readonly endpoint: string;
  readonly kind: 'local' | 'hosted';
  readonly signingKey: string;
  readonly encryptionKey: string;
  readonly fingerprint: string;
}
export interface FederationConfiguration {
  readonly name: string;
  readonly endpoint: string;
  readonly kind: 'local' | 'hosted';
}
export interface FederationResource {
  readonly iri: string;
  readonly mediaType: string;
  /** The exact original representation; identities and signed bytes are not rewritten. */
  readonly content: string;
}
export interface FederationInvite { readonly id: string; readonly code: string; readonly expiresAt: string }
export interface FederationPeer extends FederationProfile { readonly connectedAt: string; readonly revokedAt?: string }
export interface FederationPending { readonly id: string; readonly peer: FederationProfile; readonly verificationCode: string; readonly expiresAt: string }
export interface FederationReceived { readonly id: string; readonly from: string; readonly resourceIri: string; readonly receivedAt: string }
export interface FederationSent { readonly id: string; readonly to: string; readonly resourceIri: string; readonly createdAt: string }
export interface FederationStatus {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly profile?: FederationProfile;
  readonly invites: readonly { readonly id: string; readonly expiresAt: string }[];
  readonly pending: readonly FederationPending[];
  readonly peers: readonly FederationPeer[];
  readonly joining: readonly FederationPending[];
  readonly received: readonly FederationReceived[];
  readonly sent: readonly FederationSent[];
}
export interface FederationStore {
  load(): Promise<unknown | null>;
  /** Must durably commit before resolving; this snapshot contains private keys. */
  save(state: unknown | null): Promise<void>;
}
export interface FederationServiceOptions {
  readonly store: FederationStore;
  readonly binding: () => Promise<string | null>;
  readonly now?: () => number;
  /** Injection is for a trusted host/test transport, never supplied by a peer. */
  readonly fetch?: typeof fetch;
  readonly allowLoopbackForTests?: boolean;
  /** Hosted conditional stores refresh authority before each operation. */
  readonly refreshState?: boolean;
}
export interface FederationPacket {
  readonly version: 1;
  readonly issuer: string;
  readonly audience: string;
  readonly action: string;
  readonly nonce: string;
  readonly createdAt: number;
  readonly payload: unknown;
  readonly signature: string;
}
export interface FederationIdentity { readonly signingPrivateKey: string; readonly signingPublicKey: string; readonly encryption: EncryptionKeyPair }
export interface FederationSavedState {
  readonly version: 1;
  readonly binding: string;
  readonly identity: FederationIdentity;
  readonly profile: FederationProfile;
  readonly invites: readonly { readonly id: string; readonly secretHash: string; readonly expiresAt: string }[];
  readonly pending: readonly FederationPending[];
  readonly joining: readonly FederationPending[];
  readonly peers: readonly FederationPeer[];
  readonly received: readonly (FederationReceived & { readonly envelope: EncryptedEnvelope })[];
  readonly sent: readonly FederationSent[];
  readonly replay: readonly { readonly key: string; readonly expiresAt: number }[];
}
