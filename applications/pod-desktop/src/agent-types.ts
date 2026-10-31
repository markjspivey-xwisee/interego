/** Application-level grants; these labels do not attest a vendor's identity. */
export type AgentPermission = 'notes:read' | 'notes:create' | 'workspaces:read' | 'workspaces:chat';
export type AgentClient = 'chatgpt-desktop' | 'codex' | 'claude-code' | 'claude-desktop' | 'grok-build' | 'openclaw' | 'other';
export type AgentConnectionState = 'waiting' | 'active' | 'revoked' | 'expired' | 'pod-changed';

export interface AgentConnection {
  readonly id: string;
  readonly name: string;
  readonly client: AgentClient;
  readonly permissions: readonly AgentPermission[];
  /** An explicit selection, never a wildcard or an implied grant to future workspaces. */
  readonly workspaceIds?: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: AgentConnectionState;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
}

export interface AgentConnectionInput {
  readonly name: string;
  readonly client: AgentClient;
  readonly permissions: readonly AgentPermission[];
  readonly workspaceIds?: readonly string[];
  readonly expiresInDays: 7 | 30 | 90;
}

export interface AgentSetup {
  readonly connectionId: string;
  readonly title: string;
  readonly configLocation: string;
  readonly steps: readonly string[];
  readonly configuration: string;
  readonly command?: string;
}

export interface AgentPrincipal {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly AgentPermission[];
  readonly workspaceIds?: readonly string[];
}

export type AgentOperation = 'status' | 'notes.search' | 'notes.read' | 'notes.create' | 'workspaces.discover' | 'workspaces.act';
export interface AgentPodStatus {
  readonly running: boolean;
  readonly localOnly: boolean;
  readonly federationEnabled: boolean;
}

export interface AgentStatus extends AgentPodStatus {
  readonly connection: AgentConnection;
}

/** Only this connection's credential is decrypted by the companion, never the pod key. */
export interface AgentProtector {
  protect(value: string): string;
  unprotect(value: string): string;
}

export interface AgentTicket {
  readonly version: 1;
  readonly connectionId: string;
  readonly secret: string;
}

export interface AgentEndpoint {
  readonly version: 1;
  readonly url: string;
  readonly sessionId: string;
}
