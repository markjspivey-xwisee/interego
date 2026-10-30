/** Native-held credential custody; unrelated to notes keys and pod-sharing keys. */
export interface LocalIdentityPublic {
  readonly did: string;
  readonly fingerprint: string;
  readonly createdAt: string;
}
export interface LocalIdentityApproval {
  readonly id: string;
  readonly state: 'waiting' | 'completing';
  readonly relayOrigin: string;
  readonly identityOrigin: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectOrigin: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly verificationCode: string;
  readonly expiresAt: string;
}
export interface LocalIdentityStatus {
  readonly configured: boolean;
  readonly identity?: LocalIdentityPublic;
  readonly pending: readonly LocalIdentityApproval[];
}
export interface LocalIdentityStart { readonly relayOrigin: string; readonly handoffCode: string }
export interface LocalIdentityTicket {
  readonly id: string;
  readonly receipt: string;
  readonly verificationCode: string;
  readonly expiresAt: string;
}
export type LocalIdentityResult = { readonly state: 'waiting' | 'completing' }
  | { readonly state: 'complete'; readonly redirect: string }
  | { readonly state: 'denied' | 'expired' | 'failed'; readonly message?: string };
export interface LocalIdentityStore {
  load(): Promise<unknown | null>;
  /** Resolves only after a durable private-state commit. */
  save(value: unknown | null): Promise<void>;
}
export interface LocalIdentityServiceOptions {
  readonly store: LocalIdentityStore;
  readonly binding: () => Promise<string | null>;
  /** Native-owner configuration; never accept trust pairs from a browser request. */
  readonly trustedRelays: readonly { readonly relayOrigin: string; readonly identityOrigin: string }[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly allowLoopbackForTests?: boolean;
}

/** Private relay context. It never crosses the native messaging reply or owner status. */
export interface LocalIdentityContext {
  readonly version: 1;
  readonly issuer: string;
  readonly identityOrigin: string;
  readonly pendingId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly codeChallenge: string;
  readonly stateDigest: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly message: string;
  readonly challengeExpiresAt: string;
  readonly completionCode: string;
}
