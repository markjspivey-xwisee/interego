/** Opt-in remote transport over a dedicated loopback listener. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server, WebStandardStreamableHTTPServerTransport, createMcpHandler, isLegacyRequest, type McpHttpHandler } from '@modelcontextprotocol/server';
import { AgentService } from './agent-service.js';
import { agentArguments } from './agent-client.js';
import { AGENT_TOOLS, agentToolResult } from './agent-stdio.js';
import type { AgentConnection, AgentPermission } from './agent-types.js';
import type { BridgePendingApproval, BridgeStartInput, BridgeStatus } from './bridge-types.js';
import { BridgeStateStore, type BridgeStateOptions, type BridgeSavedState } from './bridge-state.js';

interface RegisteredClient { id: string; name: string; redirects: readonly string[]; expires: number }
interface Pending extends BridgePendingApproval {
  clientId: string; redirect: string; state: string; challenge: string; proof: string;
  result?: { code: string } | { denied: true };
}
interface Code { clientId: string; redirect: string; challenge: string; connectionId: string; scopes: readonly AgentPermission[]; expires: number }
interface TokenFamily { id: string; clientId: string; connectionId: string; scopes: readonly AgentPermission[]; expires: number; refreshHash: string }
interface Access { familyId: string; expires: number }
export interface BridgeStableAddress { readonly origin: string; readonly port: number }
export interface BridgeServerOptions {
  readonly agents: AgentService;
  readonly persistence?: BridgeStateOptions;
  readonly allowedBrowserOrigins?: () => Promise<readonly string[]>;
  readonly federation?: (request: Request) => Promise<Response>;
}
const MAX_BODY = 512 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const APPROVAL_TTL = 5 * 60_000;
const ACCESS_TTL = 5 * 60_000;
const CLIENT_TTL = 90 * 24 * 60 * 60_000;
const REFRESH_REPLAY_TTL = 60 * 60_000;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PERMISSIONS: readonly AgentPermission[] = ['notes:read', 'notes:create'];
const unavailable = 'This web connection is unavailable. Check Interego and connect again.';

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpFailure(400, 'invalid_request');
  return value as Record<string, unknown>;
}
function opaque(): string { return randomBytes(32).toString('base64url'); }
function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function same(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function plain(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpFailure(400, 'invalid_request');
  return value;
}
function redirectUri(value: unknown): string {
  const text = plain(value, 2048);
  const url = new URL(text);
  // This is a redirect, never a server-side fetch. Reject local/private callback destinations.
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== text
    || !url.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)
    || url.hostname.endsWith('.localhost') || url.hostname.startsWith('[')) throw new HttpFailure(400, 'invalid_redirect_uri');
  return text;
}
function startInput(raw: BridgeStartInput): BridgeStartInput {
  const value = object(raw);
  if (Object.keys(value).sort().join(',') !== 'client,expiresInDays,name,permissions'
    || !['chatgpt-web', 'grok-bot', 'other-web'].includes(raw.client)
    || ![7, 30, 90].includes(raw.expiresInDays) || !Array.isArray(raw.permissions)
    || !raw.permissions.length || raw.permissions.length > 2 || new Set(raw.permissions).size !== raw.permissions.length
    || raw.permissions.some(permission => !PERMISSIONS.includes(permission))) throw new Error('Choose a web app, permissions and expiry.');
  return { client: raw.client, name: plain(raw.name, 80).trim(), permissions: [...raw.permissions], expiresInDays: raw.expiresInDays };
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new HttpFailure(503, 'temporarily_unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

export class BridgeServer {
  private readonly agents: AgentService;
  private readonly store: BridgeStateStore | undefined;
  private saved: BridgeSavedState | null = null;
  private initialized: Promise<void> | undefined;
  private storeRevision = 0;
  private authority: Promise<unknown> = Promise.resolve();
  private activeStable: (BridgeStableAddress & { readonly podBinding: string }) | undefined;
  private stopping: Promise<void> | undefined;
  private persistenceFailed = false;
  private readinessChallenge: string | undefined;
  private server: HttpServer | undefined;
  private loopback: string | undefined;
  private publicOrigin: string | undefined;
  private configuration: BridgeStartInput | undefined;
  private lifetime = new AbortController();
  private generation = 0;
  private inFlight = 0;
  private approving: Promise<unknown> = Promise.resolve();
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, Code>();
  private readonly families = new Map<string, TokenFamily>();
  private readonly access = new Map<string, Access>();
  private readonly consumedRefresh = new Map<string, { familyId: string; expires: number }>();
  private readonly connections = new Set<string>();
  private readonly limits = new Map<string, { count: number; reset: number }>();
  private readonly handlers = new Set<McpHttpHandler>();

  constructor(private readonly options: BridgeServerOptions) { this.agents = options.agents; this.store = options.persistence ? new BridgeStateStore(options.persistence) : undefined; }

  private serializeAuthority<T>(action: () => Promise<T>): Promise<T> {
    const result = this.authority.then(action); this.authority = result.catch(() => undefined); return result;
  }

  private async initializeSaved(): Promise<void> {
    if (!this.store) return;
    const revision = this.storeRevision;
    this.initialized ??= (async () => {
      const saved = await this.store!.load();
      if (revision !== this.storeRevision) return;
      this.saved = saved;
      if (saved && saved.podBinding !== await this.store!.binding()) await this.discardSaved();
    })();
    await this.initialized;
  }

  private async discardSaved(): Promise<void> {
    const ids = this.saved?.connections ?? [];
    await this.store?.save(null); this.saved = null;
    const results = await Promise.allSettled(ids.map(id => this.agents.revoke(id)));
    if (results.some(result => result.status === 'rejected')) throw new Error('The saved authorization is removed. Some connection labels could not be updated.');
  }

  private clearAuthority(): void {
    this.clients.clear(); this.families.clear(); this.access.clear(); this.consumedRefresh.clear(); this.connections.clear();
  }

  private restoreAuthority(saved: BridgeSavedState): void {
    this.clearAuthority();
    for (const client of saved.clients) this.clients.set(client.id, client);
    for (const family of saved.families) this.families.set(family.id, family);
    for (const [key, value] of saved.access) this.access.set(key, value);
    for (const [key, value] of saved.retired) this.consumedRefresh.set(key, value);
    for (const id of saved.connections) this.connections.add(id);
    this.prune();
  }

  private async persistAuthority(): Promise<void> {
    const stable = this.activeStable; const configuration = this.configuration;
    if (!stable || !this.store || !configuration) return;
    this.prune();
    const saved: BridgeSavedState = { version: 1, ...stable, configuration, clients: [...this.clients.values()], families: [...this.families.values()],
      access: [...this.access.entries()], retired: [...this.consumedRefresh.entries()], connections: [...this.connections] };
    try { await this.store.save(saved); this.saved = saved; }
    catch { this.persistenceFailed = true; this.lifetime.abort(); throw new Error('Saved web connections could not be updated. Stop web access and try again, or forget the saved address.'); }
  }

  async start(input: BridgeStartInput, stable?: BridgeStableAddress): Promise<string> {
    if (this.server || this.stopping) throw new Error('Turn off the current web bridge before starting another.');
    const generation = ++this.generation;
    const configuration = startInput(input);
    await this.initializeSaved();
    if (generation !== this.generation) throw new Error('The web bridge was stopped.');
    if (!stable && this.saved) throw new Error('Forget the saved web address before using a temporary link.');
    this.lifetime = new AbortController(); this.persistenceFailed = false;
    this.readinessChallenge = randomUUID();
    if (stable) {
      let url: URL;
      try { url = new URL(stable.origin); } catch { throw new Error('Choose a valid secure web address.'); }
      if (!this.store || url.protocol !== 'https:' || url.origin !== stable.origin || url.username || url.password || !url.hostname.includes('.')
        || url.hostname.startsWith('[') || !Number.isInteger(stable.port) || stable.port < 1024 || stable.port > 65535) throw new Error('Choose a secure web address and its fixed local port.');
      const podBinding = await this.store.binding();
      if (!podBinding) throw new Error('Set up your local pod before enabling the saved web address.');
      if (generation !== this.generation) throw new Error('The web bridge was stopped.');
      const policy = (value: BridgeStartInput) => JSON.stringify({ ...value, permissions: [...value.permissions].sort() });
      if (this.saved && (this.saved.origin !== stable.origin || this.saved.port !== stable.port || this.saved.podBinding !== podBinding
        || policy(this.saved.configuration) !== policy(configuration))) await this.discardSaved();
      if (generation !== this.generation) throw new Error('The web bridge was stopped.');
      this.configuration = configuration;
      this.activeStable = { ...stable, podBinding };
      if (this.saved) this.restoreAuthority(this.saved); else this.clearAuthority();
      await this.serializeAuthority(() => this.persistAuthority());
      if (generation !== this.generation) throw new Error('The web bridge was stopped.');
    } else this.configuration = configuration;
    const server = createServer((request, response) => { void this.handle(request, response); });
    this.server = server;
    server.maxConnections = 48;
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 1000;
    try {
      await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(stable?.port ?? 0, '127.0.0.1', () => { server.off('error', fail); done(); });
      });
      if (this.server !== server || this.generation !== generation || this.lifetime.signal.aborted) {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(done => server.close(() => done()));
        throw new Error('The web bridge was stopped.');
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('The web bridge could not start.');
      this.loopback = `http://127.0.0.1:${address.port}`;
      return this.loopback;
    } catch (error) { if (this.server === server) await this.stop(); throw error; }
  }

  setPublicUrl(origin: string): void {
    const url = new URL(origin);
    if (!this.server?.listening || this.publicOrigin || url.protocol !== 'https:' || url.origin !== origin
      || url.username || url.password || url.hostname.startsWith('[') || !url.hostname.includes('.')
      || (this.activeStable && this.activeStable.origin !== origin)) throw new Error('The web bridge did not provide a valid secure link.');
    this.publicOrigin = origin;
  }

  readiness(): { readonly path: string; readonly expected: string } {
    if (!this.server?.listening || !this.readinessChallenge) throw new Error('The web bridge is not listening.');
    return { path: '/.well-known/interego-bridge', expected: this.readinessChallenge };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, row] of this.clients) if (row.expires <= now) this.clients.delete(key);
    for (const [key, row] of this.pending) if (Date.parse(row.expiresAt) <= now) this.pending.delete(key);
    for (const [key, row] of this.codes) if (row.expires <= now) this.codes.delete(key);
    for (const [key, row] of this.families) if (row.expires <= now || !this.clients.has(row.clientId)) this.families.delete(key);
    for (const [key, row] of this.access) if (row.expires <= now || !this.families.has(row.familyId)) this.access.delete(key);
    for (const [key, row] of this.consumedRefresh) if (!this.families.has(row.familyId) || row.expires <= now) this.consumedRefresh.delete(key);
  }

  private async pruneConnections(): Promise<boolean> {
    let changed = false;
    for (const id of this.connections) {
      const grant = await this.agents.get(id).catch(() => undefined);
      if (!grant || !['waiting', 'active'].includes(grant.state)) {
        this.connections.delete(id); changed = true;
        for (const [key, family] of this.families) if (family.connectionId === id) this.families.delete(key);
      }
    }
    this.prune(); return changed;
  }

  async status(): Promise<BridgeStatus> {
    await this.initializeSaved();
    this.prune();
    const connections: AgentConnection[] = [];
    const ids = this.server ? this.connections : this.saved?.connections ?? [];
    for (const id of ids) { try { connections.push(await this.agents.get(id)); } catch { /* Removed grants have no remaining authority. */ } }
    const configuration = this.configuration ?? this.saved?.configuration;
    const origin = this.publicOrigin ?? (!this.server ? this.saved?.origin : undefined);
    return {
      state: this.persistenceFailed ? 'error' : !this.server ? 'off' : this.publicOrigin ? 'ready' : 'starting',
      ...(this.persistenceFailed ? { message: 'Saved web connections could not be updated. Stop web access and try again, or forget the saved address.' } : {}),
      ...(this.activeStable || this.saved ? { mode: 'stable' as const, remembered: !!this.saved } : {}),
      ...(origin ? { url: `${origin}/mcp` } : {}),
      ...(configuration ? { client: configuration.client, name: configuration.name, expiresInDays: configuration.expiresInDays } : {}),
      permissions: [...configuration?.permissions ?? []], connections,
      pendingApprovals: [...this.pending.values()].filter(row => !row.result).map(row => ({ id: row.id, clientName: row.clientName,
        redirectOrigin: row.redirectOrigin, permissions: [...row.permissions], createdAt: row.createdAt, expiresAt: row.expiresAt, verificationCode: row.verificationCode })),
    };
  }

  approve(id: string): Promise<void> {
    const action = this.approving.then(async () => {
      this.prune();
      const pending = this.pending.get(id); const configuration = this.configuration; const generation = this.generation;
      if (!pending || pending.result || !configuration || !this.publicOrigin || this.lifetime.signal.aborted) throw new Error('This request has expired. Ask the app to connect again.');
      if (this.connections.size >= 16) throw new Error('Disconnect an existing web app before allowing another connection.');
      const grant = await this.agents.create({ name: configuration.name, client: 'other', permissions: [...pending.permissions], expiresInDays: configuration.expiresInDays });
      if (this.generation !== generation || this.lifetime.signal.aborted || this.pending.get(id) !== pending || pending.result || Date.parse(pending.expiresAt) <= Date.now()) {
        await this.agents.revoke(grant.id); throw new Error('This request is no longer available.');
      }
      this.connections.add(grant.id);
      try { await this.serializeAuthority(() => this.persistAuthority()); }
      catch (error) { this.connections.delete(grant.id); await this.agents.revoke(grant.id); throw error; }
      if (this.generation !== generation || this.lifetime.signal.aborted || this.pending.get(id) !== pending || pending.result) {
        this.connections.delete(grant.id); await this.agents.revoke(grant.id); await this.serializeAuthority(() => this.persistAuthority());
        throw new Error('This request is no longer available.');
      }
      const code = opaque();
      this.codes.set(hash(code), { clientId: pending.clientId, redirect: pending.redirect, challenge: pending.challenge,
        connectionId: grant.id, scopes: [...pending.permissions], expires: Date.now() + 60_000 });
      pending.result = { code };
    });
    this.approving = action.catch(() => undefined);
    return action;
  }

  deny(id: string): void {
    const pending = this.pending.get(id);
    if (pending && !pending.result) pending.result = { denied: true };
  }

  /** A stable bridge pauses transport; forgetting it separately revokes authority. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const task = this.stopInternal(); this.stopping = task;
    void task.finally(() => { if (this.stopping === task) this.stopping = undefined; }).catch(() => {});
    return task;
  }

  private async stopInternal(): Promise<void> {
    this.generation++;
    this.lifetime.abort();
    const stable = this.activeStable;
    this.publicOrigin = undefined; this.readinessChallenge = undefined;
    this.pending.clear(); this.codes.clear(); this.limits.clear();
    const server = this.server; this.server = undefined; this.loopback = undefined;
    server?.closeAllConnections();
    const handlers = [...this.handlers]; this.handlers.clear();
    await Promise.all(handlers.map(handler => handler.close()));
    if (server?.listening) await new Promise<void>(done => server.close(() => done()));
    await this.approving;
    await this.authority;
    if (stable && this.activeStable === stable) await this.serializeAuthority(() => this.persistAuthority());
    const ids = stable ? [] : [...this.connections]; this.clearAuthority();
    this.activeStable = undefined; this.configuration = undefined;
    const results = await Promise.allSettled(ids.map(id => this.agents.revoke(id)));
    if (results.some(result => result.status === 'rejected')) throw new Error('The web bridge is off. Some saved connection labels could not be updated.');
    this.persistenceFailed = false;
  }

  async forget(): Promise<void> {
    await this.stop().catch(() => {});
    ++this.storeRevision;
    const ids = new Set([...this.saved?.connections ?? [], ...this.connections]);
    await this.serializeAuthority(async () => {
      await this.store?.save(null); this.saved = null; this.clearAuthority();
      this.configuration = undefined; this.activeStable = undefined; this.persistenceFailed = false;
      const results = await Promise.allSettled([...ids].map(id => this.agents.revoke(id)));
      if (results.some(result => result.status === 'rejected')) throw new Error('The saved authorization is removed. Some connection labels could not be updated.');
    });
    this.initialized = Promise.resolve();
  }

  private rate(key: string, maximum: number): void {
    const now = Date.now(); let value = this.limits.get(key);
    if (!value || value.reset <= now) { value = { count: 0, reset: now + 60_000 }; this.limits.set(key, value); }
    if (++value.count > maximum) throw new HttpFailure(429, 'temporarily_unavailable');
  }

  private send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", connection: 'close', ...headers });
    response.end(typeof value === 'string' ? value : JSON.stringify(value));
  }

  private async body(request: IncomingMessage, maximum = MAX_BODY): Promise<Buffer> {
    if (request.headers['content-encoding'] || Number(request.headers['content-length'] ?? 0) > maximum) throw new HttpFailure(413, 'invalid_request');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.length;
      if (size > maximum) throw new HttpFailure(413, 'invalid_request');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }

  private async json(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpFailure(415, 'invalid_request');
    try { return object(JSON.parse((await this.body(request, 32 * 1024)).toString('utf8'))); }
    catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure(400, 'invalid_request'); }
  }

  private async form(request: IncomingMessage): Promise<URLSearchParams> {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') throw new HttpFailure(415, 'invalid_request');
    const form = new URLSearchParams((await this.body(request, 16 * 1024)).toString('utf8'));
    if ([...form.keys()].some(key => form.getAll(key).length !== 1)) throw new HttpFailure(400, 'invalid_request');
    return form;
  }

  private authorizePage(response: ServerResponse, pending: Pending): void {
    const nonce = opaque();
    const script = `const request=${JSON.stringify({ id: pending.id, proof: pending.proof })};async function check(){try{const r=await fetch('/approval-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const v=await r.json();if(v.redirect){location.replace(v.redirect);return;}if(v.error){document.getElementById('message').textContent='This request has expired. Return to your app and connect again.';return;}setTimeout(check,1200);}catch{document.getElementById('message').textContent='The bridge is unavailable. Keep Interego open and try connecting again.';}}check();`;
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect to Interego</title><style nonce="${nonce}">body{font:18px system-ui;max-width:34em;margin:10vh auto;padding:24px;color:#172a31;background:#f5f7f4}h1{font-size:30px}strong.code{display:block;font-size:38px;letter-spacing:.2em;margin:24px 0}small{color:#52616b}</style><h1>Approve in Interego</h1><p>Return to the Interego app on your computer. Approve only if the app shows this same code:</p><strong class="code">${escapeHtml(pending.verificationCode)}</strong><p id="message">Keep this page open. It will return to your app after you approve.</p><p><small>App label: ${escapeHtml(pending.clientName)} (provided by the app). Callback: ${escapeHtml(pending.redirectOrigin)}.</small></p><script nonce="${nonce}">${script}</script></html>`;
    this.send(response, 200, html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'` });
  }

  private async issue(family: TokenFamily): Promise<Record<string, unknown>> {
    const access = opaque(); const refresh = opaque(); const now = Date.now();
    const expires = Math.min(now + ACCESS_TTL, family.expires);
    const current = { ...family, refreshHash: hash(refresh) };
    const previous = this.families.get(family.id);
    this.families.set(family.id, current); this.access.set(hash(access), { familyId: family.id, expires });
    try { await this.persistAuthority(); }
    catch (error) { this.access.delete(hash(access)); if (previous) this.families.set(family.id, previous); else this.families.delete(family.id); throw error; }
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((expires - now) / 1000)),
      refresh_token: refresh, scope: family.scopes.join(' ') };
  }

  private async family(request: IncomingMessage, generation: number): Promise<TokenFamily> {
    const header = request.headers.authorization;
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw new HttpFailure(401, 'invalid_token');
    const digest = hash(header.slice(7));
    const token = this.access.get(digest);
    const family = token && this.families.get(token.familyId);
    if (!token || token.expires <= Date.now() || !family || family.expires <= Date.now()) throw new HttpFailure(401, 'invalid_token');
    const grant = await this.agents.get(family.connectionId).catch(() => undefined);
    if (generation !== this.generation || this.lifetime.signal.aborted || this.access.get(digest) !== token || this.families.get(family.id) !== family
      || token.expires <= Date.now() || family.expires <= Date.now() || !grant || !['waiting', 'active'].includes(grant.state)
      || family.scopes.some(scope => !grant.permissions.includes(scope))) throw new HttpFailure(401, 'invalid_token');
    return family;
  }

  private createMcpServer(family: TokenFamily, signal: AbortSignal): Server {
    const server = new Server({ name: 'interego-local-pod-bridge', version: '0.1.0' }, { capabilities: { tools: {} },
      instructions: `This is ${this.activeStable ? 'a saved web connection' : 'a temporary web bridge'} to the user’s local Interego pod. Keep the Interego app and computer running. Use only granted tools. Results read through this bridge pass through the tunnel provider and your AI provider. Saving appends notes; it never edits or deletes. Federation remains off.` });
    server.setRequestHandler('tools/list', async () => {
      await this.agents.executeGranted(family.connectionId, 'status', {}, signal);
      return { tools: AGENT_TOOLS.filter(entry => !entry.permission || family.scopes.includes(entry.permission)).map(entry => {
        const securitySchemes = [{ type: 'oauth2', scopes: entry.permission ? [entry.permission] : [...family.scopes] }];
        return { ...entry.tool, securitySchemes, _meta: { ...entry.tool._meta, securitySchemes } };
      }) };
    });
    server.setRequestHandler('tools/call', async (request, context) => {
      try {
        const active = AbortSignal.any([signal, context.mcpReq.signal]);
        const entry = AGENT_TOOLS.find(row => row.tool.name === request.params.name);
        if (!entry || (entry.permission && !family.scopes.includes(entry.permission))) throw new Error('This tool is not permitted for this connection.');
        const args = agentArguments(entry.operation, request.params.arguments);
        const result = await this.agents.executeGranted(family.connectionId, entry.operation, args, active);
        let value = agentToolResult(entry.operation, result, family.connectionId);
        if (entry.operation === 'status') { const { localOnly: _localOnly, ...status } = value; value = { ...status, storageLocal: true, remoteBridge: true }; }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch { return { isError: true, content: [{ type: 'text', text: unavailable }] }; }
    });
    return server;
  }

  private async mcp(request: IncomingMessage, response: ServerResponse, generation: number, lifetime: AbortSignal): Promise<void> {
    const family = await this.family(request, generation);
    if (request.method !== 'POST') { this.send(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' }); return; }
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpFailure(415, 'invalid_request');
    this.rate('mcp', 240);
    const body = await this.body(request);
    lifetime.throwIfAborted();
    if (response.destroyed || request.aborted || generation !== this.generation) throw new HttpFailure(503, 'temporarily_unavailable');
    const cancel = new AbortController();
    const disconnected = () => { if (!response.writableFinished) cancel.abort(); };
    response.once('close', disconnected); request.once('aborted', disconnected);
    const signal = AbortSignal.any([lifetime, cancel.signal, AbortSignal.timeout(180_000)]);
    const headers = new Headers();
    for (const name of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'mcp-name', 'mcp-cursor']) {
      const value = request.headers[name]; if (typeof value === 'string') headers.set(name, value);
    }
    const webRequest = new Request(`${this.publicOrigin}/mcp`, { method: 'POST', headers, body: new Uint8Array(body), signal });
    let legacy: Server | undefined; let modern: McpHttpHandler | undefined;
    try {
      let result: Response;
      const legacyRequest = await isLegacyRequest(webRequest);
      signal.throwIfAborted();
      if (legacyRequest) {
        legacy = this.createMcpServer(family, signal);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY });
        await legacy.connect(transport); result = await transport.handleRequest(webRequest);
      } else {
        modern = createMcpHandler(() => this.createMcpServer(family, signal), { legacy: 'reject', responseMode: 'json', maxRequestBodySize: MAX_BODY, maxSubscriptions: 0 });
        this.handlers.add(modern); result = await modern.fetch(webRequest);
      }
      if (result.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Streaming is unavailable on this bridge.');
      const reader = result.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) {
        try {
          while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > MAX_RESPONSE) throw new Error('Response too large.'); chunks.push(chunk.value); }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      signal.throwIfAborted();
      await this.family(request, generation);
      const type = result.headers.get('content-type') ?? 'application/json';
      this.send(response, result.status, Buffer.concat(chunks).toString('utf8'), { 'content-type': type });
    } finally {
      response.off('close', disconnected); request.off('aborted', disconnected);
      await legacy?.close();
      if (modern) { this.handlers.delete(modern); await modern.close(); }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let counted = false;
    const generation = this.generation;
    const lifetime = this.lifetime.signal;
    const assertCurrent = () => {
      if (generation !== this.generation || lifetime.aborted || !this.server || !this.publicOrigin) throw new HttpFailure(503, 'temporarily_unavailable');
    };
    try {
      if (!this.server || this.lifetime.signal.aborted || !this.publicOrigin || !this.loopback) throw new HttpFailure(503, 'temporarily_unavailable');
      const host = request.headers.host;
      if (host !== new URL(this.loopback).host && host !== new URL(this.publicOrigin).host) throw new HttpFailure(403, 'invalid_request');
      if (typeof request.url !== 'string' || request.url.length > 8192 || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) throw new HttpFailure(400, 'invalid_request');
      if (this.inFlight >= 16) throw new HttpFailure(429, 'temporarily_unavailable');
      this.inFlight++; counted = true; this.prune();
      const url = new URL(request.url, this.publicOrigin); const path = url.pathname;
      if (url.origin !== this.publicOrigin) throw new HttpFailure(400, 'invalid_request');
      if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new HttpFailure(400, 'invalid_request');
      const origin = request.headers.origin;
      const browserPaths = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server', '/register', '/token', '/revoke', '/mcp'];
      if (origin !== undefined && origin !== this.publicOrigin) {
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || !browserPaths.includes(path) || url.search
          || !(await this.options.allowedBrowserOrigins?.())?.includes(origin)) throw new HttpFailure(403, 'invalid_request');
        assertCurrent();
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('vary', 'Origin');
        response.setHeader('access-control-expose-headers', 'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id');
        if (request.method === 'OPTIONS') {
          const method = request.headers['access-control-request-method'];
          const headers = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
          if (!['GET', 'POST', 'DELETE'].includes(String(method)) || headers.some(value =>
            !['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'].includes(value))) throw new HttpFailure(403, 'invalid_request');
          this.send(response, 204, '', { 'access-control-allow-methods': 'GET, POST, DELETE',
            'access-control-allow-headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id', 'access-control-max-age': '0' });
          return;
        }
      }
      this.rate('all', 600);
      if ((path === '/pod-federation' || path.startsWith('/pod-federation/')) && this.options.federation && !url.search) {
        if (origin !== undefined) throw new HttpFailure(403, 'invalid_request');
        const cancel = new AbortController();
        const disconnected = () => { if (!response.writableEnded) cancel.abort(); };
        response.once('close', disconnected); request.once('aborted', disconnected);
        const timeout = setTimeout(() => cancel.abort(), 15_000);
        const signal = AbortSignal.any([lifetime, cancel.signal]);
        const stopReading = () => { if (!request.complete) request.destroy(); };
        signal.addEventListener('abort', stopReading, { once: true });
        try {
          const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : new Uint8Array(await untilAbort(this.body(request), signal));
          assertCurrent(); signal.throwIfAborted();
          const headers = new Headers();
          if (request.headers['content-type']) headers.set('content-type', request.headers['content-type']);
          const result = await untilAbort(this.options.federation(new Request(url, { method: request.method ?? 'GET', headers, body, signal })), signal);
          if (Number(result.headers.get('content-length') ?? 0) > MAX_RESPONSE) throw new HttpFailure(502, 'temporarily_unavailable');
          const reader = result.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          if (reader) {
            try {
              while (true) {
                const chunk = await untilAbort(reader.read(), signal); if (chunk.done) break;
                size += chunk.value.length; if (size > MAX_RESPONSE) throw new HttpFailure(502, 'temporarily_unavailable'); chunks.push(chunk.value);
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          }
          assertCurrent(); signal.throwIfAborted();
          this.send(response, result.status, Buffer.concat(chunks).toString('utf8'), { 'content-type': 'application/json' });
        } finally { clearTimeout(timeout); signal.removeEventListener('abort', stopReading); response.off('close', disconnected); request.off('aborted', disconnected); }
        return;
      }
      const resource = `${this.publicOrigin}/mcp`;
      if (request.method === 'GET' && path === '/.well-known/interego-bridge' && !url.search) {
        this.send(response, 200, { challenge: this.readinessChallenge }); return;
      }
      if (request.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
        this.send(response, 200, { resource, authorization_servers: [this.publicOrigin], bearer_methods_supported: ['header'], scopes_supported: this.configuration!.permissions }); return;
      }
      if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        this.send(response, 200, { issuer: this.publicOrigin, authorization_endpoint: `${this.publicOrigin}/authorize`, token_endpoint: `${this.publicOrigin}/token`,
          registration_endpoint: `${this.publicOrigin}/register`, revocation_endpoint: `${this.publicOrigin}/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: this.configuration!.permissions,
          authorization_response_iss_parameter_supported: true }); return;
      }
      if (path === '/mcp' && !url.search) { await this.mcp(request, response, generation, lifetime); return; }
      if (request.method === 'POST' && path === '/register' && !url.search) {
        this.rate('register', 12);
        if (this.clients.size >= 64) throw new HttpFailure(429, 'temporarily_unavailable');
        const body = await this.json(request);
        assertCurrent();
        if (!Array.isArray(body['redirect_uris']) || !body['redirect_uris'].length || body['redirect_uris'].length > 4
          || (body['token_endpoint_auth_method'] !== undefined && body['token_endpoint_auth_method'] !== 'none')
          || (body['grant_types'] !== undefined && (!Array.isArray(body['grant_types']) || body['grant_types'].some(value => !['authorization_code', 'refresh_token'].includes(String(value)))))
          || (body['response_types'] !== undefined && (!Array.isArray(body['response_types']) || body['response_types'].join(',') !== 'code'))) throw new HttpFailure(400, 'invalid_client_metadata');
        const redirects = body['redirect_uris'].map(redirectUri);
        const name = body['client_name'] === undefined ? 'Web app' : plain(body['client_name'], 80);
        const id = opaque();
        await this.serializeAuthority(async () => {
          assertCurrent();
          if (this.clients.size >= 64) throw new HttpFailure(429, 'temporarily_unavailable');
          this.clients.set(id, { id, name, redirects, expires: Date.now() + CLIENT_TTL });
          try { await this.persistAuthority(); } catch (error) { this.clients.delete(id); throw error; }
          assertCurrent();
        });
        this.send(response, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirects,
          token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }); return;
      }
      if (request.method === 'GET' && path === '/authorize') {
        this.rate('authorize', 30);
        const q = url.searchParams; const client = this.clients.get(q.get('client_id') ?? '');
        if (!client || !client.redirects.includes(q.get('redirect_uri') ?? '')) throw new HttpFailure(400, 'invalid_client');
        const challenge = q.get('code_challenge') ?? ''; const state = q.get('state') ?? '';
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !OPAQUE.test(challenge)
          || q.get('resource') !== resource || state.length > 1024 || /[\u0000-\u001f\u007f]/.test(state)) throw new HttpFailure(400, 'invalid_request');
        const scopes = q.get('scope') === null ? [...this.configuration!.permissions] : q.get('scope')!.split(' ');
        if (!scopes.length || scopes.some(scope => !this.configuration!.permissions.includes(scope as AgentPermission)) || new Set(scopes).size !== scopes.length) throw new HttpFailure(400, 'invalid_scope');
        await this.serializeAuthority(async () => { assertCurrent(); if (await this.pruneConnections()) await this.persistAuthority(); assertCurrent(); });
        if (this.pending.size >= 8 || this.connections.size >= 16) throw new HttpFailure(429, 'temporarily_unavailable');
        const now = Date.now(); const pending: Pending = { id: randomUUID(), clientName: client.name, clientId: client.id, redirect: q.get('redirect_uri')!,
          redirectOrigin: new URL(q.get('redirect_uri')!).origin, permissions: scopes as AgentPermission[], createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + APPROVAL_TTL).toISOString(), verificationCode: randomBytes(4).toString('hex').toUpperCase(), state, challenge, proof: opaque() };
        this.pending.set(pending.id, pending); this.authorizePage(response, pending); return;
      }
      if (request.method === 'POST' && path === '/approval-status' && !url.search) {
        const body = await this.json(request); assertCurrent(); const pending = this.pending.get(String(body['id']));
        if (!pending || typeof body['proof'] !== 'string' || !same(body['proof'], pending.proof)) throw new HttpFailure(400, 'invalid_request');
        if (!pending.result) { this.send(response, 200, { waiting: true }); return; }
        const redirect = new URL(pending.redirect);
        if ('code' in pending.result) redirect.searchParams.set('code', pending.result.code);
        else redirect.searchParams.set('error', 'access_denied');
        if (pending.state) redirect.searchParams.set('state', pending.state);
        redirect.searchParams.set('iss', this.publicOrigin);
        this.pending.delete(pending.id);
        this.send(response, 200, { redirect: redirect.href }); return;
      }
      if (request.method === 'POST' && path === '/token' && !url.search) {
        this.rate('token', 90); const form = await this.form(request); assertCurrent();
        if (form.get('resource') !== resource) throw new HttpFailure(400, 'invalid_target');
        const client = this.clients.get(form.get('client_id') ?? '');
        if (!client || request.headers.authorization) throw new HttpFailure(401, 'invalid_client');
        if (form.get('grant_type') === 'authorization_code') {
          const codeText = form.get('code') ?? ''; const code = this.codes.get(hash(codeText)); const verifier = form.get('code_verifier') ?? '';
          if (!OPAQUE.test(codeText) || !code || code.expires <= Date.now() || code.clientId !== client.id || code.redirect !== form.get('redirect_uri')
            || !VERIFIER.test(verifier) || !same(hash(verifier), code.challenge)) throw new HttpFailure(400, 'invalid_grant');
          const issued = await this.serializeAuthority(async () => {
            assertCurrent();
            if (this.codes.get(hash(codeText)) !== code || this.clients.get(client.id) !== client) throw new HttpFailure(400, 'invalid_grant');
            this.codes.delete(hash(codeText));
            const grant = await this.agents.get(code.connectionId);
            assertCurrent();
            if (!['waiting', 'active'].includes(grant.state)) throw new HttpFailure(400, 'invalid_grant');
            const family: TokenFamily = { id: randomUUID(), clientId: client.id, connectionId: grant.id, scopes: code.scopes,
              expires: Date.parse(grant.expiresAt), refreshHash: '' };
            const tokens = await this.issue(family); assertCurrent(); return tokens;
          });
          this.send(response, 200, issued); return;
        }
        if (form.get('grant_type') === 'refresh_token') {
          const refresh = form.get('refresh_token') ?? ''; const digest = hash(refresh);
          const issued = await this.serializeAuthority(async () => {
            assertCurrent();
            const replayed = this.consumedRefresh.get(digest);
            if (replayed) { this.families.delete(replayed.familyId); await this.persistAuthority(); throw new HttpFailure(400, 'invalid_grant'); }
            const family = [...this.families.values()].find(row => row.refreshHash === digest);
            if (!OPAQUE.test(refresh) || !family || family.clientId !== client.id || family.expires <= Date.now()
              || this.clients.get(client.id) !== client || (form.get('scope') !== null && form.get('scope') !== family.scopes.join(' '))) throw new HttpFailure(400, 'invalid_grant');
            const grant = await this.agents.get(family.connectionId); assertCurrent();
            if (!['waiting', 'active'].includes(grant.state)) { this.families.delete(family.id); await this.persistAuthority(); throw new HttpFailure(400, 'invalid_grant'); }
            if (this.consumedRefresh.size >= 512) throw new HttpFailure(429, 'temporarily_unavailable');
            this.consumedRefresh.set(digest, { familyId: family.id, expires: Date.now() + REFRESH_REPLAY_TTL });
            try { const tokens = await this.issue(family); assertCurrent(); return tokens; }
            catch (error) { this.consumedRefresh.delete(digest); throw error; }
          });
          this.send(response, 200, issued); return;
        }
        throw new HttpFailure(400, 'unsupported_grant_type');
      }
      if (request.method === 'POST' && path === '/revoke' && !url.search) {
        this.rate('token', 90); const form = await this.form(request); assertCurrent(); const digest = hash(form.get('token') ?? '');
        const family = [...this.families.values()].find(row => row.refreshHash === digest) ?? this.families.get(this.access.get(digest)?.familyId ?? '');
        await this.serializeAuthority(async () => {
          assertCurrent();
          if (family && form.get('client_id') === family.clientId) { this.families.delete(family.id); await this.persistAuthority(); }
          assertCurrent();
        });
        this.send(response, 200, {}); return;
      }
      throw new HttpFailure(404, 'not_found');
    } catch (error) {
      const failure = error instanceof HttpFailure ? error : new HttpFailure(400, 'invalid_request');
      const headers: Record<string, string> = {};
      if (failure.status === 401 && this.publicOrigin) headers['www-authenticate'] = `Bearer resource_metadata="${this.publicOrigin}/.well-known/oauth-protected-resource", error="invalid_token"`;
      if (!response.headersSent) this.send(response, failure.status, { error: failure.code }, headers);
    } finally { if (counted) this.inFlight--; }
  }
}
