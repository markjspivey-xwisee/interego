/** Local optional Workspace application: encrypted pod state, no hosted relay impersonation. */
import { createHash, randomUUID } from 'node:crypto';
import { entryTurtle, workspaceTurtle, rolesTurtle, shapesTurtle, grantTurtle, acceptanceTurtle } from '@interego/workspace-client';
import {
  WORKSPACE_ACTIONS as A, type WorkspaceActRequest, type WorkspaceAffordance, type WorkspaceAuthor,
  type WorkspaceEntry, type WorkspaceMember, type WorkspacePrincipal, type WorkspaceRepresentation,
  type WorkspaceServiceOptions, type WorkspaceSummary, type LocalWorkspace,
} from './workspace-types.js';

export { WORKSPACE_ACTIONS } from './workspace-types.js';
export type { WorkspaceActRequest, WorkspacePrincipal, WorkspaceRepresentation, WorkspaceServiceOptions } from './workspace-types.js';

const WSP = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CTX = Object.freeze({
  wsp: WSP, hydra: 'http://www.w3.org/ns/hydra/core#', prov: 'http://www.w3.org/ns/prov#',
  iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#', schema: 'https://schema.org/',
  id: 'schema:identifier',
  dct: 'http://purl.org/dc/terms/', affordances: { '@id': 'iep:affordance', '@container': '@set' },
  action: { '@id': 'iep:action', '@type': '@id' }, method: 'hydra:method',
  inputSchema: { '@id': 'hydra:expects', '@type': '@json' },
  target: { '@id': 'hydra:target', '@type': '@id' }, title: 'dct:title', body: 'dct:description',
  createdAt: 'dct:created', name: 'schema:name',
  author: { '@id': 'prov:wasAttributedTo', '@context': { id: 'schema:identifier', kind: 'schema:additionalType' } },
  members: { '@id': 'hydra:member', '@context': { id: 'schema:identifier', kind: 'schema:additionalType', role: 'schema:roleName' } },
  entries: 'hydra:member', workspaces: 'hydra:member', workspace: 'wsp:workspace', entry: 'hydra:member', seq: 'wsp:seq',
  prior: { '@id': 'https://markjspivey-xwisee.github.io/interego/ns/iep#supersedes', '@type': '@id' },
});
type Room = { -readonly [K in keyof Omit<LocalWorkspace, 'entryCount' | 'memberCount'>]: Omit<LocalWorkspace, 'entryCount' | 'memberCount'>[K] };
interface Saved {
  format: 'interego-local-workspaces'; version: 1; binding: string; enabled: boolean; revision: number; rooms: Room[];
}
const MAX_ROOMS = 30;
const MAX_ENTRIES = 2000;
const MAX_MEMBERS = 64;
export const MAX_WORKSPACE_REPRESENTATION_BYTES = 350 * 1024;
const MAX_AUDIT_BYTES = 24 * 1024;
interface ReadWindow { readonly afterSeq?: number; readonly beforeSeq?: number; readonly limit?: number }
const DENIED = 'This connection cannot access that workspace. Review its permissions and membership in Interego.';
const OFF = 'Workspaces are off. Enable them in Interego before using this action.';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The workspace request has an unfamiliar format.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('The workspace request contains unsupported fields.');
}
function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`Enter ${label} of up to ${limit.toLocaleString('en-US')} characters.`);
  }
  return value;
}
function actorId(value: unknown, kind: string): string {
  if (typeof value !== 'string' || !(kind === 'agent' && UUID.test(value)
    || kind === 'discord' && /^discord:[0-9]{1,24}$/.test(value)
    || kind === 'human' && /^human:[0-9a-f-]{36}$/i.test(value))) throw new Error('Choose an existing local member or approved connection.');
  return value;
}
function iso(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function summary(room: Room): WorkspaceSummary {
  return { '@id': room.id, '@type': 'wsp:Workspace', id: room.id, title: room.title, createdAt: room.createdAt, updatedAt: room.updatedAt,
    entryCount: room.entries.length, memberCount: room.members.filter(m => m.state === 'active').length };
}
function schema(properties: Record<string, unknown> = {}, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
const str = (maxLength: number): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
const READ_SCHEMA = schema({ afterSeq: { type: 'integer', minimum: -1 }, beforeSeq: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 50 } });
function readWindow(input: Record<string, unknown>): ReadWindow {
  keys(input, ['afterSeq', 'beforeSeq', 'limit']);
  if (input['afterSeq'] !== undefined && (!Number.isSafeInteger(input['afterSeq']) || Number(input['afterSeq']) < -1)
    || input['beforeSeq'] !== undefined && (!Number.isSafeInteger(input['beforeSeq']) || Number(input['beforeSeq']) < 0)
    || input['limit'] !== undefined && (!Number.isSafeInteger(input['limit']) || Number(input['limit']) < 1 || Number(input['limit']) > 50)) {
    throw new Error('Use a valid conversation cursor and a page size between 1 and 50.');
  }
  if (input['afterSeq'] !== undefined && input['beforeSeq'] !== undefined && Number(input['afterSeq']) >= Number(input['beforeSeq'])) {
    throw new Error('Choose a conversation window with the earlier cursor before the later cursor.');
  }
  return input as ReadWindow;
}
function op(action: string, target: string, title: string, inputSchema: Record<string, unknown> = schema()): WorkspaceAffordance {
  return { action, target, title, method: 'POST', inputSchema };
}

export class WorkspaceService {
  private readonly options: WorkspaceServiceOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(options: WorkspaceServiceOptions) { this.options = options; }
  private now(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }
  private uuid(): string {
    const id = this.options.uuid?.() ?? randomUUID();
    if (!UUID.test(id)) throw new Error('A local workspace identifier could not be created.');
    return id;
  }
  private root(binding: string): string { return `urn:interego:local-workspaces:${hash(binding).slice(0, 32)}`; }
  private owner(binding: string): WorkspaceAuthor { return { id: `${this.root(binding)}:owner`, name: 'You', kind: 'human' }; }
  private iri(binding: string, author: WorkspaceAuthor): string {
    return author.id === this.owner(binding).id ? author.id : `${this.root(binding)}:member:${encodeURIComponent(author.id)}`;
  }
  private async load(binding: string): Promise<Saved> {
    const raw = await this.options.store.load();
    if (raw === null) return { format: 'interego-local-workspaces', version: 1, binding, enabled: false, revision: 0, rooms: [] };
    const value = record(raw);
    keys(value, ['format', 'version', 'binding', 'enabled', 'revision', 'rooms']);
    if (value['format'] !== 'interego-local-workspaces' || value['version'] !== 1 || value['binding'] !== binding
      || typeof value['enabled'] !== 'boolean' || !Number.isSafeInteger(value['revision']) || Number(value['revision']) < 0
      || !Array.isArray(value['rooms']) || value['rooms'].length > MAX_ROOMS) throw new Error('Saved workspace data could not be verified. Your stored data was kept unchanged.');
    const saved = structuredClone(value) as unknown as Saved;
    const seen = new Set<string>();
    for (const room of saved.rooms) {
      if (!room || typeof room.id !== 'string' || !room.id.startsWith(`${this.root(binding)}:workspace:`)
        || !UUID.test(room.id.slice(room.id.lastIndexOf(':') + 1)) || seen.has(room.id)
        || room.owner !== this.owner(binding).id || !iso(room.createdAt) || !iso(room.updatedAt)
        || !Array.isArray(room.members) || !room.members.length || room.members.length > MAX_MEMBERS
        || !Array.isArray(room.entries) || room.entries.length > MAX_ENTRIES) throw new Error('Saved workspace data could not be verified.');
      text(room.title, 120, 'a workspace name'); seen.add(room.id);
      const members = new Set<string>();
      for (const member of room.members) {
        if (!member || !['human', 'agent', 'discord'].includes(member.kind) || members.has(member.id)
          || !['owner', 'contributor', 'reader'].includes(member.role) || !['invited', 'active', 'left', 'revoked'].includes(member.state)
          || !iso(member.invitedAt) || member.acceptedAt !== undefined && !iso(member.acceptedAt)) throw new Error('Saved workspace membership could not be verified.');
        text(member.name, 80, 'a member name');
        if (member.role === 'owner') {
          if (member.id !== room.owner || member.state !== 'active' || member.kind !== 'human') throw new Error('Saved workspace ownership could not be verified.');
        } else actorId(member.id, member.kind);
        members.add(member.id);
      }
      if (room.members.filter(m => m.role === 'owner').length !== 1) throw new Error('Saved workspace ownership could not be verified.');
      if (!room.records || typeof room.records.workspace !== 'string' || typeof room.records.roles !== 'string'
        || typeof room.records.shapes !== 'string' || !Array.isArray(room.records.membership)
        || room.records.membership.some(t => typeof t !== 'string')) throw new Error('Saved workspace records could not be verified.');
      let prior: WorkspaceEntry | undefined;
      const external = new Set<string>();
      for (let i = 0; i < room.entries.length; i++) {
        const entry = room.entries[i]!;
        if (!entry || entry.seq !== i || entry.id !== `${room.id}:stream/e/${i}` || !iso(entry.createdAt)
          || entry.prior !== (prior?.id ?? null) || !entry.author || !members.has(entry.author.id)
          || !['human', 'agent', 'discord'].includes(entry.author.kind) || typeof entry.turtle !== 'string') throw new Error('The saved conversation chain could not be verified.');
        text(entry.body, 16_000, 'a message'); text(entry.author.name, 80, 'a member name');
        const { hash: expected, ...content } = entry;
        if (typeof expected !== 'string' || expected !== hash(content)) throw new Error('The saved conversation chain was changed.');
        if (entry.sourceId !== undefined) {
          if (entry.author.kind !== 'discord') throw new Error('A saved external message has an unfamiliar author.');
          text(entry.sourceId, 160, 'a source message identifier');
          const key = `${entry.author.id}/${entry.sourceId}`;
          if (external.has(key)) throw new Error('The saved conversation contains a repeated external message.');
          external.add(key);
        }
        prior = entry;
      }
    }
    return saved;
  }
  private member(room: Room, principal: WorkspacePrincipal): WorkspaceMember | undefined {
    return room.members.find(m => m.id === principal.id && m.kind === principal.kind);
  }
  private scoped(room: Room, principal: WorkspacePrincipal): boolean { return principal.workspaceIds.includes(room.id); }
  private canRead(room: Room, principal?: WorkspacePrincipal): boolean {
    return !principal || this.scoped(room, principal) && principal.permissions.includes('workspaces:read') && this.member(room, principal)?.state === 'active';
  }
  private canPost(room: Room, principal?: WorkspacePrincipal): boolean {
    const member = principal ? this.member(room, principal) : undefined;
    return !principal || this.scoped(room, principal) && principal.permissions.includes('workspaces:chat')
      && member?.state === 'active' && member.role === 'contributor';
  }
  private async authorize(principal: WorkspacePrincipal | undefined, generation: number): Promise<void> {
    if (!principal) return;
    actorId(principal.id, principal.kind); text(principal.name, 80, 'a connection name');
    if (!Array.isArray(principal.workspaceIds) || principal.workspaceIds.length > MAX_ROOMS
      || !Array.isArray(principal.permissions) || principal.permissions.some(p => !['workspaces:read', 'workspaces:chat'].includes(p))
      || typeof principal.authorize !== 'function') throw new Error(DENIED);
    await principal.authorize();
    if (generation !== this.generation) throw new Error('Workspace permissions changed. Discover the available actions again.');
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(fn); this.queue = pending.catch(() => undefined); return pending;
  }
  private represent(saved: Saved | null, binding: string | null, principal?: WorkspacePrincipal,
    room?: Room, entry?: WorkspaceEntry, window: ReadWindow = {}): WorkspaceRepresentation {
    const id = room?.id ?? this.root(binding ?? 'unconfigured');
    const enabled = saved?.enabled ?? false;
    const root = this.root(binding ?? 'unconfigured');
    const affordances: WorkspaceAffordance[] = [];
    if (binding && !principal) affordances.push(op(enabled ? A.DISABLE : A.ENABLE, root, enabled ? 'Turn workspaces off' : 'Enable workspaces on this computer'));
    if (enabled) {
      affordances.push(op(A.LIST, root, 'List available workspaces'));
      if (!principal) affordances.push(op(A.CREATE, root, 'Create a workspace', schema({ title: str(120) }, ['title'])));
      if (room) {
        if (this.canRead(room, principal)) affordances.push(op(A.READ, room.id, 'Read this workspace', READ_SCHEMA));
        if (this.canPost(room, principal)) affordances.push(op(A.POST, room.id, 'Post a message', schema({ body: str(16_000),
          ...(principal?.kind === 'discord' ? { sourceId: str(160) } : {}) }, ['body'])));
        if (!principal) {
          affordances.push(op(A.INVITE, room.id, 'Invite a selected local person, agent or Discord participant', schema({
            memberId: str(80), name: str(80), kind: { enum: ['human', 'agent', 'discord'] }, role: { enum: ['contributor', 'reader'] },
          }, ['memberId', 'name', 'kind'])));
          for (const m of room.members.filter(m => m.role !== 'owner' && !['left', 'revoked'].includes(m.state))) {
            affordances.push(op(A.REVOKE, `${room.id}:member:${encodeURIComponent(m.id)}`, `Remove ${m.name}`));
          }
        } else {
          const member = this.member(room, principal);
          if (this.scoped(room, principal) && member?.state === 'invited') affordances.push(op(A.ACCEPT,
            `${room.id}:member:${encodeURIComponent(member.id)}`, 'Accept this workspace invitation'));
          if (this.scoped(room, principal) && member?.state === 'active') affordances.push(op(A.LEAVE,
            `${room.id}:member:${encodeURIComponent(member.id)}`, 'Leave this workspace'));
        }
      }
    }
    const visible = enabled && saved ? saved.rooms.filter(r => !principal || this.canRead(r, principal) || this.canPost(r, principal)
      || this.scoped(r, principal) && this.member(r, principal)?.state === 'invited') : [];
    if (enabled && !room) {
      for (const visibleRoom of visible) {
        if (this.canRead(visibleRoom, principal)) affordances.push(op(A.READ, visibleRoom.id, `Open ${visibleRoom.title}`, READ_SCHEMA));
        if (this.canPost(visibleRoom, principal)) affordances.push(op(A.POST, visibleRoom.id, `Post to ${visibleRoom.title}`, schema({
          body: str(16_000), ...(principal?.kind === 'discord' ? { sourceId: str(160) } : {}),
        }, ['body'])));
        if (!this.canRead(visibleRoom, principal)) {
          const invited = principal ? this.member(visibleRoom, principal) : undefined;
          if (invited?.state === 'invited') affordances.push(op(A.ACCEPT,
            `${visibleRoom.id}:member:${encodeURIComponent(invited.id)}`, `Join ${visibleRoom.title}`));
        }
      }
    }
    const projectEntry = (value: WorkspaceEntry): WorkspaceEntry => ({ ...value, '@id': value.id, '@type': 'wsp:Entry',
      author: { ...value.author, '@id': this.iri(binding!, value.author) } });
    const matching = room?.entries.filter(e => (window.afterSeq === undefined || e.seq > window.afterSeq)
      && (window.beforeSeq === undefined || e.seq < window.beforeSeq)) ?? [];
    const fromStart = window.afterSeq !== undefined;
    const limit = window.limit ?? 20;
    let selected = fromStart ? matching.slice(0, limit) : matching.slice(-limit);
    const omitAudit = Boolean(principal) || Boolean(room && Buffer.byteLength(JSON.stringify(room.records)) > MAX_AUDIT_BYTES);
    const records = room && omitAudit ? { workspace: room.records.workspace, roles: room.records.roles,
      shapes: room.records.shapes, membership: [] } : room?.records;
    const allowedRoom = enabled && room && this.canRead(room, principal) ? { ...summary(room), owner: room.owner,
      members: room.members.map(m => ({ ...m, '@id': this.iri(binding!, m) })), entries: selected.map(projectEntry), records: records!,
      ...(omitAudit ? { auditRecordsOmitted: true } : {}) } : undefined;
    // Invitations expose only their selected workspace's name and acceptance operation, never its conversation.
    const result: WorkspaceRepresentation = { '@context': CTX, '@id': id, '@type': room ? 'wsp:Workspace' : 'hydra:Collection', id,
      enabled, configured: binding !== null, localOnly: true, federationEnabled: false,
      transport: { kind: 'local-capability', discovery: 'interego_discover', action: 'interego_act' },
      attribution: 'authenticated-local-connection',
      ...(enabled ? { workspaces: visible.map(r => this.canRead(r, principal) ? summary(r)
        : { ...summary(r), entryCount: 0, memberCount: 0 }) } : {}),
      ...(allowedRoom ? { workspace: allowedRoom } : {}), ...(entry ? { entry: projectEntry(entry) } : {}), affordances,
      notice: 'Conversation records stay encrypted in this local pod. Authorship identifies the local connection; it is not a wallet signature. Remote sharing, Discord and federation require separate choices.',
    };
    const updatePage = (): void => {
      if (!allowedRoom || !room) return;
      allowedRoom.entries = selected.map(projectEntry);
      const startSeq = selected[0]?.seq ?? null; const endSeq = selected.at(-1)?.seq ?? null;
      Object.assign(result, { page: { startSeq, endSeq, total: room.entries.length,
        hasEarlier: startSeq !== null ? startSeq > 0 : window.afterSeq !== undefined && room.entries.some(e => e.seq <= window.afterSeq!),
        hasLater: endSeq !== null ? endSeq < room.entries.length - 1 : window.beforeSeq !== undefined && room.entries.some(e => e.seq >= window.beforeSeq!),
      } });
    };
    updatePage();
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_WORKSPACE_REPRESENTATION_BYTES && selected.length > 1) {
      selected = fromStart ? selected.slice(0, -1) : selected.slice(1); updatePage();
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_WORKSPACE_REPRESENTATION_BYTES) {
      throw new Error('This conversation page is too large. Use a smaller message or a narrower page.');
    }
    return structuredClone(result);
  }
  status(principal?: WorkspacePrincipal): Promise<WorkspaceRepresentation> {
    const generation = this.generation;
    return this.serialize(async () => {
      await this.authorize(principal, generation);
      const binding = await this.options.binding();
      const saved = binding ? await this.load(binding) : null;
      const result = this.represent(saved, binding, principal);
      await this.authorize(principal, generation);
      if (await this.options.binding() !== binding) throw new Error('The local pod changed. Discover its available actions again.');
      return result;
    });
  }
  act(request: WorkspaceActRequest, principal?: WorkspacePrincipal, ownerAuthorize?: () => Promise<void>): Promise<WorkspaceRepresentation> {
    // An owner disabling or revoking access invalidates queued agent work immediately, before I/O completes.
    if (!principal && request && (request.action === A.DISABLE || request.action === A.REVOKE)) ++this.generation;
    const generation = this.generation;
    const authorize = async (): Promise<void> => {
      await this.authorize(principal, generation);
      await ownerAuthorize?.();
    };
    return this.serialize(async () => {
      const req = record(request); keys(req, ['action', 'target', 'input']);
      if (typeof request.action !== 'string' || !Object.values(A).includes(request.action as typeof A[keyof typeof A])) throw new Error('Discover an available workspace action before invoking it.');
      await authorize();
      const binding = await this.options.binding();
      if (!binding) throw new Error('Set up your local pod before enabling workspaces.');
      const saved = await this.load(binding);
      const input = request.input === undefined ? {} : record(request.input);
      const root = this.root(binding);
      const target = request.target ?? root;
      if (typeof target !== 'string') throw new Error('Choose an advertised workspace resource.');
      let room = saved.rooms.find(r => target === r.id || target.startsWith(`${r.id}:member:`) || target.startsWith(`${r.id}:stream/e/`));
      let changed = false; let entry: WorkspaceEntry | undefined;
      let window: ReadWindow = {};
      if (request.action === A.ENABLE || request.action === A.DISABLE) {
        keys(input, []);
        if (principal || target !== root) throw new Error(DENIED);
        saved.enabled = request.action === A.ENABLE; changed = true;
      } else {
        if (!saved.enabled) throw new Error(OFF);
        if (request.action === A.LIST) {
          keys(input, []); if (target !== root) throw new Error('Choose the advertised workspace collection.');
        } else if (request.action === A.CREATE) {
          keys(input, ['title']); if (principal || target !== root) throw new Error(DENIED);
          if (saved.rooms.length >= MAX_ROOMS) throw new Error('This preview supports up to 30 local workspaces.');
          const title = text(input['title'], 120, 'a workspace name').trim(); const now = this.now();
          const id = `${root}:workspace:${this.uuid()}`; const owner = this.owner(binding);
          const ownerGrant = `${id}:grant:owner`;
          room = { id, title, owner: owner.id, createdAt: now, updatedAt: now,
            members: [{ ...owner, role: 'owner', state: 'active', invitedAt: now, acceptedAt: now }], entries: [],
            records: { workspace: workspaceTurtle({ workspace: id, title, convenerWebId: owner.id,
              rolesIri: `${id}:roles`, shapeIri: `${id}:shapes`, createdIso: now, visibility: 'private' }),
            roles: rolesTurtle(`${id}:roles`), shapes: shapesTurtle(`${id}:shapes`), membership: [
              grantTurtle({ grant: ownerGrant, workspace: id, granteeWebId: owner.id, role: `${id}:roles#Convener`, createdIso: now }),
              acceptanceTurtle({ acceptance: `${id}:acceptance:owner`, workspace: id, memberWebId: owner.id,
                grant: ownerGrant, grantCid: null, stream: `${id}:stream`, createdIso: now }),
            ] } };
          saved.rooms.push(room); changed = true;
        } else {
          if (!room) throw new Error(DENIED);
          if (principal && !this.scoped(room, principal)) throw new Error(DENIED);
          if (request.action === A.READ) {
            window = readWindow(input);
            if (!this.canRead(room, principal)) throw new Error(DENIED);
            if (target !== room.id) {
              entry = room.entries.find(e => e.id === target);
              if (!entry) throw new Error('Choose an advertised conversation resource.');
            }
          } else if (request.action === A.POST) {
            keys(input, principal?.kind === 'discord' ? ['body', 'sourceId'] : ['body']);
            if (target !== room.id || !this.canPost(room, principal)) throw new Error(DENIED);
            const body = text(input['body'], 16_000, 'a message');
            const author: WorkspaceAuthor = principal ? { id: principal.id, name: principal.name, kind: principal.kind } : this.owner(binding);
            const sourceId = input['sourceId'] === undefined ? undefined : text(input['sourceId'], 160, 'a source message identifier');
            const existing = sourceId === undefined ? undefined : room.entries.find(e => e.author.id === author.id && e.sourceId === sourceId);
            if (existing) {
              if (existing.body !== body) throw new Error('That external message was already recorded with different text.');
              entry = existing;
            } else {
              if (room.entries.length >= MAX_ENTRIES) throw new Error('This preview supports up to 2,000 entries per workspace.');
              const seq = room.entries.length; const now = this.now(); const prior = room.entries.at(-1)?.id ?? null;
              const content = { id: `${room.id}:stream/e/${seq}`, seq, body, createdAt: now, author, prior,
                turtle: entryTurtle({ streamIri: `${room.id}:stream`, workspace: room.id, seq, body, prior,
                  author: author.kind === 'agent' ? { kind: 'delegate', agentId: this.iri(binding, author), footing: { kind: 'own-account' } }
                    : { kind: 'principal', webId: this.iri(binding, author) }, createdIso: now }), ...(sourceId ? { sourceId } : {}) };
              entry = { ...content, hash: hash(content) };
              if (Buffer.byteLength(JSON.stringify(entry)) > 150 * 1024) throw new Error('This message is too large after formatting. Use a shorter message.');
              room.entries = [...room.entries, entry]; room.updatedAt = now; changed = true;
            }
          } else if (request.action === A.INVITE) {
            keys(input, ['memberId', 'name', 'kind', 'role']); if (principal || target !== room.id) throw new Error(DENIED);
            const kind = input['kind']; if (!['agent', 'human', 'discord'].includes(String(kind))) throw new Error('Choose the participant type.');
            const memberId = actorId(input['memberId'], String(kind)); const name = text(input['name'], 80, 'a member name').trim();
            const role = input['role'] ?? 'contributor'; if (!['contributor', 'reader'].includes(String(role))) throw new Error('Choose a contributor or reader role.');
            if (room.members.some(m => m.id === memberId && !['left', 'revoked'].includes(m.state))) throw new Error('This participant already has an invitation or active membership.');
            if (room.members.length >= MAX_MEMBERS) throw new Error('This preview supports up to 64 participants per workspace.');
            const now = this.now(); const grantId = `${room.id}:grant:${encodeURIComponent(memberId)}:${saved.revision + 1}`;
            const member: WorkspaceMember = { id: memberId, name, kind: kind as WorkspaceAuthor['kind'], role: role as 'contributor' | 'reader', state: 'invited', invitedAt: now, grantId };
            room.members = [...room.members.filter(m => m.id !== memberId), member]; room.updatedAt = now;
            room.records = { ...room.records, membership: [...room.records.membership, grantTurtle({
              grant: grantId, workspace: room.id,
              granteeWebId: this.iri(binding, member), role: `${room.id}:roles#${role === 'reader' ? 'Reader' : 'Contributor'}`, createdIso: now,
            })] }; changed = true;
          } else if (request.action === A.ACCEPT || request.action === A.LEAVE || request.action === A.REVOKE) {
            keys(input, []);
            const memberId = target.startsWith(`${room.id}:member:`) ? decodeURIComponent(target.slice(`${room.id}:member:`.length)) : null;
            const member = room.members.find(m => m.id === memberId);
            if (!member || member.role === 'owner') throw new Error(DENIED);
            if (request.action === A.REVOKE) { if (principal) throw new Error(DENIED); }
            else if (!principal || principal.id !== member.id || principal.kind !== member.kind) throw new Error(DENIED);
            if (request.action === A.ACCEPT && member.state !== 'invited' || request.action === A.LEAVE && member.state !== 'active') throw new Error('This invitation or membership is no longer active.');
            const now = this.now();
            room.members = room.members.map(m => m.id === member.id ? { ...m,
              state: request.action === A.ACCEPT ? 'active' : request.action === A.LEAVE ? 'left' : 'revoked',
              ...(request.action === A.ACCEPT ? { acceptedAt: now } : {}) } : m);
            room.updatedAt = now;
            if (request.action === A.ACCEPT) room.records = { ...room.records, membership: [...room.records.membership,
              acceptanceTurtle({ acceptance: target + ':acceptance', workspace: room.id, memberWebId: this.iri(binding, member),
                grant: member.grantId ?? '', grantCid: null,
                stream: `${room.id}:stream`, createdIso: now })] };
            if (request.action === A.REVOKE) room.records = { ...room.records, membership: [...room.records.membership,
              grantTurtle({ grant: member.grantId ?? '', workspace: room.id, granteeWebId: this.iri(binding, member),
                role: `${room.id}:roles#${member.role === 'reader' ? 'Reader' : 'Contributor'}`, revoked: true, createdIso: now })] };
            changed = true;
          } else throw new Error('This workspace action is unavailable.');
        }
      }
      await authorize();
      if (await this.options.binding() !== binding) throw new Error('The local pod changed. Discover its available actions again.');
      // Check the transport response budget before committing a mutation, not after persisting an unreadable result.
      const result = this.represent(saved, binding, principal, room, entry, window);
      if (changed) {
        saved.revision++;
        await this.options.store.save(saved, binding, async () => {
          await authorize();
          if (await this.options.binding() !== binding) throw new Error('The local pod changed. Discover its available actions again.');
        });
      }
      // A revocation/expiry during storage must not release conversation bytes to that caller.
      await authorize();
      if (await this.options.binding() !== binding) throw new Error('The local pod changed. Discover its available actions again.');
      return result;
    });
  }
}
