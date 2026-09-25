/**
 * Your connection to the Interego relay, the same one a Claude connector opens: OAuth 2.1 with
 * dynamic client registration and PKCE, you signing in with your passkey on the relay's own page,
 * the code returned to this local server on a loopback redirect. The token stays in this process;
 * the page never sees it. Then MCP over streamable HTTP, as your session.
 */
import { createHash, randomBytes } from 'node:crypto';

export const RELAY = (process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com').replace(/\/$/, '');

const b64url = (b: Buffer): string => b.toString('base64url');

interface Pending { readonly verifier: string; readonly redirectUri: string; readonly clientId: string }

export interface RelayToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly scope?: string;
}

export class RelayAuth {
  private clientId?: string;
  private readonly pending = new Map<string, Pending>();
  token?: RelayToken;

  constructor(private readonly redirectUri: string, private readonly clientName = 'Interego Live Demo') {}

  /** Register once, then the authorize URL for a fresh PKCE pair. */
  async start(): Promise<string> {
    if (!this.clientId) {
      const res = await fetch(`${RELAY}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: this.clientName, redirect_uris: [this.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp' }),
      });
      const j = await res.json().catch(() => ({})) as { client_id?: string; error?: string; error_description?: string };
      if (!res.ok || !j.client_id) throw new Error(`the relay refused to register this demo as a client: ${j.error_description ?? j.error ?? res.status}`);
      this.clientId = j.client_id;
    }
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    this.pending.set(state, { verifier, redirectUri: this.redirectUri, clientId: this.clientId });
    const u = new URL(`${RELAY}/authorize`);
    u.search = new URLSearchParams({ response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mcp', resource: `${RELAY}/` }).toString();
    return u.toString();
  }

  /** Exchange the code the relay sent back for your session's token. */
  async finish(code: string, state: string): Promise<RelayToken> {
    const p = this.pending.get(state);
    if (!p) throw new Error('this sign-in was not started here, or was already used');
    this.pending.delete(state);
    const res = await fetch(`${RELAY}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: p.clientId, redirect_uri: p.redirectUri, resource: `${RELAY}/` }).toString(),
    });
    const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`the relay did not issue a token: ${j.error_description ?? j.error ?? res.status}`);
    this.token = { accessToken: j.access_token, ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}), expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, ...(j.scope ? { scope: j.scope } : {}) };
    return this.token;
  }

  /** A token that is good for at least another minute, refreshed when it is not. */
  async bearer(): Promise<string> {
    if (!this.token) throw new Error('not signed in');
    if (this.token.expiresAt - Date.now() > 60_000 || !this.token.refreshToken || !this.clientId) return this.token.accessToken;
    const res = await fetch(`${RELAY}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.token.refreshToken, client_id: this.clientId, resource: `${RELAY}/` }).toString(),
    });
    const j = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (res.ok && j.access_token) this.token = { accessToken: j.access_token, refreshToken: j.refresh_token ?? this.token.refreshToken, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.accessToken;
  }
}

export interface ToolResult {
  readonly text: string;
  readonly json?: Record<string, unknown>;
  readonly isError: boolean;
}

/** MCP over streamable HTTP to the relay, as your session. */
export class RelayMcp {
  private sessionId?: string;
  private id = 0;

  constructor(private readonly auth: RelayAuth) {}

  private async rpc(method: string, params: unknown, notify = false): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${await this.auth.bearer()}`, 'mcp-protocol-version': '2025-06-18' };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await fetch(`${RELAY}/mcp`, { method: 'POST', headers, body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++this.id, method, params }), signal: AbortSignal.timeout(180_000) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notify) return {};
    if (res.status === 404 && this.sessionId) { this.sessionId = undefined; await this.initialize(); return this.rpc(method, params); }
    const text = await res.text();
    const trimmed = text.trim();
    const payload = trimmed.startsWith('{') ? trimmed : trimmed.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() ?? '{}';
    const body = JSON.parse(payload) as { result?: Record<string, unknown>; error?: { message?: string } };
    if (!res.ok && !body.result) throw new Error(`relay ${method}: HTTP ${res.status} ${body.error?.message ?? trimmed.slice(0, 200)}`);
    if (body.error) throw new Error(`relay ${method}: ${body.error.message ?? JSON.stringify(body.error).slice(0, 200)}`);
    return body.result ?? {};
  }

  async initialize(): Promise<Record<string, unknown>> {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'interego-live-demo', version: '0.1.0' } });
    await this.rpc('notifications/initialized', {}, true);
    return r;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    const r = await this.rpc('tools/list', {});
    return (r['tools'] as { name: string; description?: string; inputSchema?: unknown }[] | undefined) ?? [];
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const r = await this.rpc('tools/call', { name, arguments: args });
    const text = ((r['content'] as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? '').join('');
    let json: Record<string, unknown> | undefined;
    const structured = r['structuredContent'];
    if (structured && typeof structured === 'object') json = structured as Record<string, unknown>;
    else { try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = undefined; } }
    return { text, ...(json ? { json } : {}), isError: r['isError'] === true };
  }
}
