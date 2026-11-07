/** Optional Shared Workspace vertical. These local capabilities are not the hosted relay API. */
export const WORKSPACE_ACTIONS = Object.freeze({
  ENABLE: 'urn:interego:local-workspace:enable',
  DISABLE: 'urn:interego:local-workspace:disable',
  LIST: 'urn:interego:local-workspace:list',
  CREATE: 'urn:interego:local-workspace:create',
  READ: 'urn:interego:local-workspace:read',
  POST: 'urn:interego:local-workspace:post',
  INVITE: 'urn:interego:local-workspace:invite',
  ACCEPT: 'urn:interego:local-workspace:accept',
  LEAVE: 'urn:interego:local-workspace:leave',
  REVOKE: 'urn:interego:local-workspace:revoke',
});
export const WORKSPACE_ID_PATTERN = /^urn:interego:local-workspaces:[a-f0-9]{32}:workspace:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspacePermission = 'workspaces:read' | 'workspaces:chat';
export type WorkspaceActorKind = 'human' | 'agent' | 'discord';
export interface WorkspacePrincipal {
  readonly kind: WorkspaceActorKind;
  /** Obtained from an authenticated connection or an owner-approved Discord mapping, never a tool argument. */
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly WorkspacePermission[];
  readonly workspaceIds: readonly string[];
  /** Revalidates the host's grant, expiry, revocation and current external-channel consent. */
  readonly authorize: () => Promise<void>;
}
export interface WorkspaceActRequest {
  readonly action: string;
  readonly target?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}
export interface WorkspaceAuthor {
  readonly '@id'?: string;
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceActorKind;
}
export interface WorkspaceEntry {
  readonly '@id'?: string;
  readonly '@type'?: 'wsp:Entry';
  readonly id: string;
  readonly seq: number;
  readonly body: string;
  readonly createdAt: string;
  readonly author: WorkspaceAuthor;
  readonly prior: string | null;
  readonly hash: string;
  /** Existing wsp:Entry serializer; provenance is local authenticated-connection attribution, not a wallet signature. */
  readonly turtle: string;
  readonly sourceId?: string;
}
export interface WorkspaceMember extends WorkspaceAuthor {
  readonly role: 'owner' | 'contributor' | 'reader';
  readonly state: 'invited' | 'active' | 'left' | 'revoked';
  readonly invitedAt: string;
  readonly acceptedAt?: string;
  readonly grantId?: string;
}
export interface WorkspaceSummary {
  readonly '@id'?: string;
  readonly '@type'?: 'wsp:Workspace';
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entryCount: number;
  readonly memberCount: number;
}
export interface LocalWorkspace extends WorkspaceSummary {
  readonly owner: string;
  readonly members: readonly WorkspaceMember[];
  readonly entries: readonly WorkspaceEntry[];
  readonly records: {
    readonly workspace: string;
    readonly roles: string;
    readonly shapes: string;
    readonly membership: readonly string[];
  };
  /** The bounded projection omits historical membership audit text; the encrypted store retains it. */
  readonly auditRecordsOmitted?: boolean;
}
export interface WorkspacePage {
  readonly startSeq: number | null;
  readonly endSeq: number | null;
  readonly total: number;
  readonly hasEarlier: boolean;
  readonly hasLater: boolean;
}
export interface WorkspaceAffordance {
  readonly action: string;
  readonly target: string;
  readonly method: 'POST';
  readonly title: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
export interface WorkspaceRepresentation {
  readonly '@context': Readonly<Record<string, unknown>>;
  readonly '@id': string;
  readonly '@type': string;
  readonly id: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly localOnly: true;
  readonly federationEnabled: false;
  readonly transport: { readonly kind: 'local-capability'; readonly discovery: 'interego_discover'; readonly action: 'interego_act' };
  readonly attribution: 'authenticated-local-connection';
  readonly workspaces?: readonly WorkspaceSummary[];
  readonly workspace?: LocalWorkspace;
  readonly entry?: WorkspaceEntry;
  readonly page?: WorkspacePage;
  readonly affordances: readonly WorkspaceAffordance[];
  readonly notice: string;
}
export interface WorkspaceStore {
  load(): Promise<unknown | null>;
  save(value: unknown, binding: string, authorize: () => Promise<void>): Promise<void>;
}
export interface WorkspaceServiceOptions {
  readonly store: WorkspaceStore;
  readonly binding: () => Promise<string | null>;
  readonly now?: () => number;
  readonly uuid?: () => string;
}
