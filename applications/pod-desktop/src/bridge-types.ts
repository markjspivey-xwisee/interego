import type { AgentConnection, AgentPermission } from './agent-types.js';

export type BridgeClient = 'chatgpt-web' | 'grok-bot' | 'other-web';
export interface BridgeStartInput {
  readonly client: BridgeClient;
  readonly name: string;
  readonly permissions: readonly AgentPermission[];
  readonly expiresInDays: 7 | 30 | 90;
}

export interface StableBridgeInput {
  readonly provider: 'cloudflare' | 'external';
  readonly origin: string;
  /** Native setup only. Never returned in public settings or status. */
  readonly token?: string;
  readonly policy: BridgeStartInput;
}
export interface StableBridgeView {
  readonly provider: 'cloudflare' | 'external';
  readonly origin: string;
  readonly port: number;
  readonly hasCredential: boolean;
  readonly policy: BridgeStartInput;
}
/** Main-process configuration only; the renderer receives StableBridgeView. */
export interface StoredStableBridge {
  readonly provider: 'cloudflare' | 'external';
  readonly origin: string;
  readonly port: number;
  readonly token?: string;
  readonly policy: BridgeStartInput;
}
export interface StableBridgeContext { readonly origin: string; readonly port: number; }
export interface BridgePendingApproval {
  readonly id: string;
  /** Supplied by the remote app, not a verified vendor identity. */
  readonly clientName: string;
  readonly redirectOrigin: string;
  readonly permissions: readonly AgentPermission[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly verificationCode: string;
}
export interface BridgeStatus {
  readonly state: 'off' | 'starting' | 'ready' | 'error';
  /** The public HTTPS MCP endpoint, never a credential. */
  readonly url?: string;
  readonly client?: BridgeClient;
  readonly name?: string;
  readonly expiresInDays?: 7 | 30 | 90;
  readonly message?: string;
  readonly mode?: 'temporary' | 'stable';
  readonly remembered?: boolean;
  readonly permissions: readonly AgentPermission[];
  readonly pendingApprovals: readonly BridgePendingApproval[];
  readonly connections: readonly AgentConnection[];
}
