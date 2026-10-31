/** Local grants authorize a narrow app surface; storage credentials never leave the app. */
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_ID_PATTERN, AGENT_REQUEST_WINDOW_MS, MAX_AGENT_REQUEST_BYTES,
  openAgentMessage, sealAgentMessage, type AgentEnvelope,
} from './agent-protocol.js';
import type {
  AgentClient, AgentConnection, AgentConnectionInput, AgentEndpoint, AgentOperation,
  AgentPermission, AgentPrincipal, AgentProtector, AgentTicket,
} from './agent-types.js';
import { WORKSPACE_ID_PATTERN } from './workspace-types.js';

export interface AgentServiceOptions {
  readonly dataDir: string;
  readonly protector: AgentProtector;
  readonly getPodBinding: () => Promise<string | null>;
  /** The controller must call authorize again INSIDE its serialized action. */
  readonly execute: (operation: AgentOperation, args: unknown, authorize: () => Promise<AgentPrincipal>) => Promise<unknown>;
}
interface ConnectionRecord extends Omit<AgentConnection, 'state'> {
  readonly secret: string;
  readonly podBinding: string;
}
const CLIENTS: readonly AgentClient[] = ['chatgpt-desktop', 'codex', 'claude-code', 'claude-desktop', 'grok-build', 'openclaw', 'other'];
const PERMISSIONS: readonly AgentPermission[] = ['notes:read', 'notes:create', 'workspaces:read', 'workspaces:chat'];
const MAX_CONNECTIONS = 64;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_CONCURRENT = 8;
const MAX_REPLAYS = 4096;
const AUTH_ERROR = 'This agent connection is unavailable. Check its permissions in Interego.';
const OPERATION_ERROR = 'The local pod could not complete this request. Check Interego and try again.';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid agent access data.');
  return value as Record<string, unknown>;
}
function validateInput(value: AgentConnectionInput): AgentConnectionInput {
  const input = object(value);
  if (Object.keys(input).some(key => !['client', 'expiresInDays', 'name', 'permissions', 'workspaceIds'].includes(key))
    || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !CLIENTS.includes(value.client) || ![7, 30, 90].includes(value.expiresInDays)
    || !Array.isArray(value.permissions) || !value.permissions.length || value.permissions.length > PERMISSIONS.length
    || new Set(value.permissions).size !== value.permissions.length || value.permissions.some(p => !PERMISSIONS.includes(p))) {
    throw new Error('Choose an agent name, permissions and expiry.');
  }
  const workspaces = value.permissions.some(permission => permission.startsWith('workspaces:'));
  if (workspaces ? !Array.isArray(value.workspaceIds) || !value.workspaceIds.length || value.workspaceIds.length > 32
    || new Set(value.workspaceIds).size !== value.workspaceIds.length || value.workspaceIds.some(id => typeof id !== 'string' || !WORKSPACE_ID_PATTERN.test(id))
    : value.workspaceIds !== undefined) throw new Error('Select the workspaces this connection may use.');
  return { name: value.name.trim(), client: value.client, permissions: [...value.permissions], expiresInDays: value.expiresInDays,
    ...(workspaces ? { workspaceIds: [...value.workspaceIds!] } : {}) };
}
function validateRecord(raw: unknown): ConnectionRecord {
  const value = object(raw);
  const allowed = ['id', 'name', 'client', 'permissions', 'workspaceIds', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt', 'secret', 'podBinding'];
  if (Object.keys(value).some(k => !allowed.includes(k)) || typeof value['id'] !== 'string' || !AGENT_ID_PATTERN.test(value['id'])
    || typeof value['createdAt'] !== 'string' || !Number.isFinite(Date.parse(value['createdAt']))
    || typeof value['expiresAt'] !== 'string' || !Number.isFinite(Date.parse(value['expiresAt']))
    || Date.parse(value['expiresAt']) <= Date.parse(value['createdAt'])
    || typeof value['podBinding'] !== 'string' || !value['podBinding'] || value['podBinding'].length > 256
    || typeof value['secret'] !== 'string' || Buffer.from(value['secret'], 'base64').length !== 32
    || Buffer.from(value['secret'], 'base64').toString('base64') !== value['secret']
    || ['lastUsedAt', 'revokedAt'].some(k => value[k] !== undefined && (typeof value[k] !== 'string' || !Number.isFinite(Date.parse(value[k]))))) {
    throw new Error('Agent access data is damaged.');
  }
  validateInput({ name: value['name'], client: value['client'], permissions: value['permissions'], expiresInDays: 7,
    ...(value['workspaceIds'] !== undefined ? { workspaceIds: value['workspaceIds'] } : {}) } as AgentConnectionInput);
  return value as unknown as ConnectionRecord;
}

async function regularFile(path: string, limit: number): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limit) throw new Error('Agent access file is invalid.');
    const file = await open(path, 'r');
    try {
      const current = await file.stat();
      if (!current.isFile() || current.dev !== metadata.dev || current.ino !== metadata.ino || current.size > limit) throw new Error('Agent access file changed.');
      const bytes = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > limit) throw new Error('Agent access file is too large.');
      return bytes.subarray(0, total).toString('utf8');
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export class AgentService {
  private readonly options: AgentServiceOptions;
  private readonly directory: string;
  private readonly registryPath: string;
  private records: readonly ConnectionRecord[] = [];
  private ready: Promise<void> | undefined;
  private mutation: Promise<unknown> = Promise.resolve();
  private server: Server | undefined;
  private endpoint: AgentEndpoint | undefined;
  private starting: Promise<AgentEndpoint> | undefined;
  private closed = false;
  private inFlight = 0;
  private readonly replay = new Map<string, number>();

  constructor(options: AgentServiceOptions) {
    if (!isAbsolute(options.dataDir)) throw new Error('Agent access needs a dedicated local folder.');
    this.options = options;
    this.directory = resolve(options.dataDir);
    this.registryPath = join(this.directory, 'connections.json');
  }

  private async initialize(): Promise<void> {
    if (this.closed) throw new Error('Agent access is closed.');
    this.ready ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Agent access needs a regular local folder.');
      await mkdir(join(this.directory, 'tickets'), { recursive: true, mode: 0o700 });
      const tickets = await lstat(join(this.directory, 'tickets'));
      if (!tickets.isDirectory() || tickets.isSymbolicLink()) throw new Error('Agent tickets need a regular local folder.');
      const saved = await regularFile(this.registryPath, MAX_REGISTRY_BYTES);
      if (saved === null) return;
      const wrapper = object(JSON.parse(saved));
      if (Object.keys(wrapper).sort().join(',') !== 'ciphertext,version' || wrapper['version'] !== 1 || typeof wrapper['ciphertext'] !== 'string') throw new Error('Agent access data is damaged.');
      const raw = JSON.parse(this.options.protector.unprotect(wrapper['ciphertext'])) as unknown;
      if (!Array.isArray(raw) || raw.length > MAX_CONNECTIONS) throw new Error('Agent access data is damaged.');
      const records = raw.map(validateRecord);
      if (new Set(records.map(r => r.id)).size !== records.length) throw new Error('Agent access data is damaged.');
      this.records = records;
    })();
    await this.ready;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutation.then(action);
    this.mutation = pending.catch(() => undefined);
    return pending;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const temporary = join(this.directory, `.agent-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, path);
    } catch (error) { try { await unlink(temporary); } catch { /* No persistent record was committed. */ } throw error; }
  }

  private async persist(records: readonly ConnectionRecord[]): Promise<void> {
    const ciphertext = this.options.protector.protect(JSON.stringify(records));
    const wrapper = { version: 1, ciphertext };
    if (Buffer.byteLength(JSON.stringify(wrapper)) > MAX_REGISTRY_BYTES) throw new Error('Agent access data is full.');
    await this.writeJson(this.registryPath, wrapper);
    this.records = records;
  }

  private connection(record: ConnectionRecord, binding: string | null): AgentConnection {
    const state = record.revokedAt ? 'revoked' : Date.parse(record.expiresAt) <= Date.now() ? 'expired'
      : record.podBinding !== binding ? 'pod-changed' : record.lastUsedAt ? 'active' : 'waiting';
    return Object.freeze({ id: record.id, name: record.name, client: record.client, permissions: Object.freeze([...record.permissions]),
      createdAt: record.createdAt, expiresAt: record.expiresAt, state,
      ...(record.workspaceIds ? { workspaceIds: Object.freeze([...record.workspaceIds]) } : {}),
      ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}), ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}) });
  }

  async list(): Promise<readonly AgentConnection[]> {
    await this.initialize();
    const binding = await this.options.getPodBinding();
    return Object.freeze(this.records.map(record => this.connection(record, binding)));
  }

  async get(id: string): Promise<AgentConnection> {
    await this.initialize();
    const binding = await this.options.getPodBinding();
    const record = this.records.find(r => r.id === id);
    if (!record) throw new Error('This agent connection was not found.');
    return this.connection(record, binding);
  }

  async create(input: AgentConnectionInput): Promise<AgentConnection> {
    const value = validateInput(input);
    await this.initialize();
    return this.serialize(async () => {
      if (this.closed) throw new Error('Agent access is closed.');
      const binding = await this.options.getPodBinding();
      if (!binding || binding.length > 256) throw new Error('Create your local pod before connecting an agent.');
      const now = Date.now();
      let retained = this.records;
      if (retained.length >= MAX_CONNECTIONS) {
        const inactive = [...retained].filter(r => r.revokedAt || Date.parse(r.expiresAt) <= now || r.podBinding !== binding)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!inactive) throw new Error('You can have up to 64 active agent connections. Revoke one before adding another.');
        retained = retained.filter(r => r.id !== inactive.id);
      }
      const record: ConnectionRecord = { id: randomUUID(), name: value.name, client: value.client, permissions: value.permissions,
        ...(value.workspaceIds ? { workspaceIds: [...value.workspaceIds] } : {}),
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + value.expiresInDays * 86_400_000).toISOString(),
        secret: randomBytes(32).toString('base64'), podBinding: binding };
      const ticket: AgentTicket = { version: 1, connectionId: record.id, secret: record.secret };
      // An orphaned ticket has no registered authority. Never commit the grant first.
      await this.writeJson(join(this.directory, 'tickets', `${record.id}.json`), {
        version: 1, ciphertext: this.options.protector.protect(JSON.stringify(ticket)),
      });
      await this.persist([...retained, record]);
      return this.connection(record, binding);
    });
  }

  async revoke(id: string): Promise<AgentConnection> {
    await this.initialize();
    return this.serialize(async () => {
      const record = this.records.find(r => r.id === id);
      if (!record) throw new Error('This agent connection was not found.');
      const revoked = record.revokedAt ? record : { ...record, revokedAt: new Date().toISOString() };
      await this.persist(this.records.map(r => r.id === id ? revoked : r));
      return this.connection(revoked, await this.options.getPodBinding());
    });
  }

  private async authorize(id: string, operation: AgentOperation): Promise<AgentPrincipal> {
    if (this.closed) throw new Error(AUTH_ERROR);
    const binding = await this.options.getPodBinding();
    // Read after asynchronous binding lookup: a revoke may have committed meanwhile.
    const record = this.records.find(r => r.id === id);
    if (!record || record.revokedAt || Date.parse(record.expiresAt) <= Date.now()
      || !binding || record.podBinding !== binding
      || (operation.startsWith('notes.') && !record.permissions.includes(operation === 'notes.create' ? 'notes:create' : 'notes:read'))
      || (operation.startsWith('workspaces.') && !record.permissions.some(permission => permission.startsWith('workspaces:')))) throw new Error(AUTH_ERROR);
    return Object.freeze({ id: record.id, name: record.name, permissions: Object.freeze([...record.permissions]),
      ...(record.workspaceIds ? { workspaceIds: Object.freeze([...record.workspaceIds]) } : {}) });
  }

  private reply(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
    response.end(JSON.stringify(value));
  }

  /** In-process transport adapter; the caller never receives a ticket or pod key. */
  async executeGranted(id: string, operation: AgentOperation, args: unknown, signal: AbortSignal): Promise<unknown> {
    await this.initialize();
    const authorize = async () => {
      signal.throwIfAborted();
      const principal = await this.authorize(id, operation);
      signal.throwIfAborted();
      return principal;
    };
    await authorize();
    const value = await this.options.execute(operation, args, authorize);
    await authorize();
    await this.serialize(async () => {
      await authorize();
      const current = this.records.find(record => record.id === id)!;
      await this.persist(this.records.map(record => record.id === id ? { ...current, lastUsedAt: new Date().toISOString() } : record));
    });
    const result = operation === 'status' ? { ...object(value), connection: await this.get(id) } : value;
    await authorize();
    return result;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint || this.closed) { this.reply(response, 503, { error: 'Agent access is unavailable.' }); return; }
    // Native companions send no Origin. A browser cannot enroll or use this endpoint.
    if (request.headers.host !== new URL(endpoint.url).host || request.headers.origin !== undefined) { this.reply(response, 403, { error: 'Local origin refused.' }); return; }
    if (request.url !== '/agent') { this.reply(response, 404, { error: 'Not found.' }); return; }
    if (request.method !== 'POST') { this.reply(response, 405, { error: 'POST is required.' }); return; }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' || request.headers['content-encoding']) { this.reply(response, 415, { error: 'JSON is required.' }); return; }
    if (this.inFlight >= MAX_CONCURRENT) { this.reply(response, 429, { error: 'Agent access is busy.' }); return; }
    this.inFlight++;
    try {
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += bytes.length;
        if (total > MAX_AGENT_REQUEST_BYTES) { this.reply(response, 413, { error: 'Agent request is too large.' }); return; }
        chunks.push(bytes);
      }
      let envelope: AgentEnvelope; let message: Record<string, unknown>; let record: ConnectionRecord;
      try {
        envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) as unknown as AgentEnvelope;
        const found = this.records.find(r => r.id === envelope.connectionId);
        if (!found) throw new Error(AUTH_ERROR);
        record = found;
        const ticket: AgentTicket = { version: 1, connectionId: record.id, secret: record.secret };
        message = object(openAgentMessage(ticket, endpoint, envelope, 'request'));
        if (Object.keys(message).some(k => !['issuedAt', 'operation', 'arguments'].includes(k))
          || typeof message['issuedAt'] !== 'number' || !Number.isSafeInteger(message['issuedAt'])
          || Math.abs(Date.now() - message['issuedAt']) > AGENT_REQUEST_WINDOW_MS
          || !['status', 'notes.search', 'notes.read', 'notes.create', 'workspaces.discover', 'workspaces.act'].includes(String(message['operation']))) throw new Error(AUTH_ERROR);
        for (const [key, expiry] of this.replay) if (expiry <= Date.now()) this.replay.delete(key);
        const key = `${record.id}:${envelope.requestId}`;
        if (this.replay.has(key) || this.replay.size >= MAX_REPLAYS) throw new Error(AUTH_ERROR);
        // Retain through the inclusive last valid millisecond of a future-dated request.
        this.replay.set(key, Date.now() + 2 * AGENT_REQUEST_WINDOW_MS + 1);
      } catch { this.reply(response, 401, { error: 'Agent request refused.' }); return; }
      const operation = message['operation'] as AgentOperation;
      const authorize = () => {
        if (request.aborted || response.destroyed || this.closed) return Promise.reject(new Error(AUTH_ERROR));
        return this.authorize(record.id, operation);
      };
      const ticket: AgentTicket = { version: 1, connectionId: record.id, secret: record.secret };
      let result: unknown;
      try {
        await authorize();
        const value = await this.options.execute(operation, message['arguments'], authorize);
        await authorize();
        await this.serialize(async () => {
          await authorize();
          const current = this.records.find(r => r.id === record.id)!;
          await this.persist(this.records.map(r => r.id === record.id ? { ...current, lastUsedAt: new Date().toISOString() } : r));
        });
        result = { ok: true, value: operation === 'status' ? { ...object(value), connection: await this.get(record.id) } : value };
        await authorize();
      } catch { result = { ok: false, error: OPERATION_ERROR }; }
      const sealed = sealAgentMessage(ticket, endpoint, envelope.requestId, 'response', result);
      this.reply(response, 200, sealed);
    } catch {
      if (!response.headersSent) this.reply(response, 400, { error: 'Agent request refused.' });
    } finally { this.inFlight--; }
  }

  async start(): Promise<AgentEndpoint> {
    await this.initialize();
    if (this.endpoint) return this.endpoint;
    this.starting ??= (async () => {
      const server = createServer((request, response) => { void this.handle(request, response); });
      this.server = server;
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.keepAliveTimeout = 1000;
      server.maxConnections = 32;
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Agent access could not start.');
      const endpoint: AgentEndpoint = Object.freeze({ version: 1, url: `http://127.0.0.1:${address.port}/agent`, sessionId: randomUUID() });
      try {
        await this.writeJson(join(this.directory, 'endpoint.json'), endpoint);
        if (this.closed) throw new Error('Agent access is closed.');
        this.endpoint = endpoint;
        return endpoint;
      } catch (error) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); throw error; }
    })();
    return this.starting;
  }

  async close(): Promise<void> {
    this.closed = true;
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    if (this.starting) { try { await this.starting; } catch { /* Startup already reported its failure. */ } }
    if (this.server?.listening) {
      this.server.closeAllConnections();
      await new Promise<void>(done => this.server!.close(() => done()));
    }
    await this.mutation;
    if (endpoint) {
      try {
        const saved = await regularFile(join(this.directory, 'endpoint.json'), 4096);
        if (saved && object(JSON.parse(saved))['sessionId'] === endpoint.sessionId) await unlink(join(this.directory, 'endpoint.json'));
      } catch { /* A stale endpoint cannot authenticate a new broker session. */ }
    }
    this.replay.clear();
  }
}
