import type { AgentConnection, AgentPermission } from './agent-types.js';

export type BridgeClient = 'chatgpt-web' | 'grok-bot' | 'other-web';
export interface BridgeStartInput {
  readonly client: BridgeClient;
  readonly name: string;
  readonly permissions: readonly AgentPermission[];
  readonly expiresInDays: 7 | 30 | 90;
}
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
  readonly permissions: readonly AgentPermission[];
  readonly pendingApprovals: readonly BridgePendingApproval[];
  readonly connections: readonly AgentConnection[];
}
