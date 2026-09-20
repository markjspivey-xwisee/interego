/**
 * Publishing to a pod through the Interego relay's MCP surface (Streamable HTTP JSON-RPC):
 * publish_context for a judgment's payload graph, record_trajectory_step for the harness's
 * own loop. The relay is the authority for facets, signing, encryption and supersession, so
 * only the payload triples travel; the local descriptor TriG is for offline use.
 *
 * Two ways in:
 *   - INTEREGO_AGENT_KEY_JSON: an Ed25519 OKP JWK (x and d). The bridge is then its own
 *     agent with a did:key, and it mints relay tokens itself through the relay's OAuth 2.1
 *     flow (dynamic client registration, PKCE, a did-sig challenge from the identity server,
 *     /oauth/verify with method "did", then /token). Tokens live an hour; the minter re-mints
 *     before they lapse and after a 401. INTEREGO_POD_NAME names the pod the judgments land
 *     on when it is not the agent's own, which is the delegate case: the pod owner registers
 *     the agent there with a publishing scope, and every descriptor is attributed to the agent
 *     on behalf of the owner.
 *   - INTEREGO_BEARER: a relay session token pasted in by hand; it lasts an hour.
 *
 * Without either, the bridge still writes every artifact locally and reports publish: 'skipped'.
 */

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign, type JsonWebKey, type KeyObject } from 'node:crypto';
import type { Published } from './descriptor.js';
import { modalStatus } from './descriptor.js';

export const DEFAULT_RELAY_URL = 'https://relay.interego.xwisee.com/mcp';

// ── Agent identity: an Ed25519 key and the did:key it names ─────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bitcoin-alphabet base58, as the W3C did:key method encodes multicodec public keys. */
export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let k = zeros; k < bytes.length; k += 1) {
    let carry = bytes[k]!;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return BASE58_ALPHABET[0]!.repeat(zeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]!).join('');
}

export interface AgentKey {
  /** did:key:z6Mk… — the multicodec ed25519-pub prefix (0xed 0x01) plus the raw public key, base58btc. */
  readonly did: string;
  readonly publicKeyMultibase: string;
  readonly publicKeyRaw: Uint8Array;
  readonly privateKey: KeyObject;
}

/** The agent key from an Ed25519 OKP JWK (the form INTEREGO_AGENT_KEY_JSON carries). */
export function agentKeyFromJwk(jwk: JsonWebKey | string): AgentKey {
  const parsed = typeof jwk === 'string' ? JSON.parse(jwk) as JsonWebKey : jwk;
  if (parsed.kty !== 'OKP' || parsed.crv !== 'Ed25519' || typeof parsed.x !== 'string' || typeof parsed.d !== 'string') {
    throw new Error('the agent key must be an Ed25519 OKP JWK carrying x and d');
  }
  const privateKey = createPrivateKey({ key: parsed, format: 'jwk' });
  const publicKeyRaw = Buffer.from(parsed.x, 'base64url');
  if (publicKeyRaw.length !== 32) throw new Error('the agent key public half is not 32 bytes');
  const multibase = `z${base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), publicKeyRaw]))}`;
  return { did: `did:key:${multibase}`, publicKeyMultibase: multibase, publicKeyRaw, privateKey };
}

/** A fresh Ed25519 agent key as a JWK; the caller keeps it secret. */
export function generateAgentKeyJwk(): JsonWebKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'jwk' }) as JsonWebKey;
}

/** The identity server verifies crypto.verify(null, utf8(nonce), key, sig): sign exactly that. */
export function signNonce(key: AgentKey, nonce: string): string {
  return Buffer.from(edSign(null, Buffer.from(nonce, 'utf8'), key.privateKey)).toString('base64url');
}

// ── Token minting: the relay's OAuth 2.1 flow driven by the agent key ─────────────────────

export interface TokenSource {
  token(): Promise<string>;
  /** Forget the current token, so the next call mints again (after a 401). */
  invalidate(): void;
}

export interface MinterConfig {
  /** The relay origin, e.g. https://relay.interego.xwisee.com (its MCP URL minus the path). */
  readonly relayOrigin: string;
  readonly key: AgentKey;
  /** The OAuth client name the relay maps to a surface; unknown names become `mcp-client`. */
  readonly clientName?: string;
  readonly redirectUri?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Re-mint this long before the token's stated expiry (ms). */
  readonly renewBeforeMs?: number;
}

interface MintedToken { readonly token: string; readonly expiresAt: number }

export class DidTokenMinter implements TokenSource {
  private cached: MintedToken | undefined;
  private clientId: string | undefined;
  private inflight: Promise<MintedToken> | undefined;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly redirectUri: string;
  private readonly renewBeforeMs: number;
  readonly mints: number[] = [];

  constructor(private readonly cfg: MinterConfig) {
    this.f = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? (() => Date.now());
    this.redirectUri = cfg.redirectUri ?? 'http://localhost:9999/cb';
    this.renewBeforeMs = cfg.renewBeforeMs ?? 5 * 60 * 1000;
  }

  get did(): string { return this.cfg.key.did; }

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - this.renewBeforeMs) return this.cached.token;
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => { this.inflight = undefined; });
    }
    const minted = await this.inflight;
    this.cached = minted;
    return minted.token;
  }

  invalidate(): void { this.cached = undefined; }

  private async mint(): Promise<MintedToken> {
    try {
      return await this.mintOnce(this.clientId ?? (this.clientId = await this.register()));
    } catch (err) {
      // A registration the relay no longer knows fails at /authorize; register again once.
      if (this.clientId === undefined) throw err;
      this.clientId = undefined;
      return this.mintOnce(this.clientId = await this.register());
    }
  }

  private async register(): Promise<string> {
    const res = await this.f(`${this.cfg.relayOrigin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: this.cfg.clientName ?? 'jev-harness-bridge',
        redirect_uris: [this.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const data = await json(res, 'relay /register');
    if (typeof data['client_id'] !== 'string') throw new Error('relay /register returned no client_id');
    return data['client_id'];
  }

  private async mintOnce(clientId: string): Promise<MintedToken> {
    const origin = this.cfg.relayOrigin;
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const authorize = new URL(`${origin}/authorize`);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', this.redirectUri);
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('scope', 'mcp');
    authorize.searchParams.set('state', randomBytes(8).toString('hex'));
    const page = await this.f(authorize.toString());
    const html = await page.text();
    if (!page.ok) throw new Error(`relay /authorize responded ${page.status}: ${html.slice(0, 200)}`);
    const pendingId = /const PENDING_ID = "([^"]+)"/.exec(html)?.[1];
    const identity = /const IDENTITY = "([^"]+)"/.exec(html)?.[1];
    if (!pendingId || !identity) throw new Error('relay /authorize page carries no PENDING_ID or IDENTITY');

    const challenge = await json(await this.f(`${identity}/challenges`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'did-sig' }),
    }), 'identity /challenges');
    const nonce = challenge['nonce'];
    if (typeof nonce !== 'string') throw new Error('identity /challenges returned no nonce');

    const verified = await json(await this.f(`${origin}/oauth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pending_id: pendingId, method: 'did', did: this.cfg.key.did, nonce,
        signature: signNonce(this.cfg.key, nonce), publicKeyMultibase: this.cfg.key.publicKeyMultibase,
      }),
    }), 'relay /oauth/verify');
    const redirect = verified['redirect'];
    const code = typeof redirect === 'string' ? new URL(redirect).searchParams.get('code') : null;
    if (!code) throw new Error('relay /oauth/verify returned no authorization code');

    const tokens = await json(await this.f(`${origin}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: this.redirectUri, client_id: clientId }).toString(),
    }), 'relay /token');
    const token = tokens['access_token'];
    if (typeof token !== 'string') throw new Error('relay /token returned no access_token');
    const ttlSec = typeof tokens['expires_in'] === 'number' ? tokens['expires_in'] : 3600;
    this.mints.push(this.now());
    return { token, expiresAt: this.now() + ttlSec * 1000 };
  }
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} responded ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`${what} returned no JSON: ${text.slice(0, 200)}`); }
}

// ── The MCP client ─────────────────────────────────────────────────────────────────────

export interface RelayConfig {
  readonly url: string;
  /** A session token, or a source that mints and renews one. */
  readonly bearer: string | TokenSource;
  /** The pod the judgments land on when it is not the caller's own (the delegate case). */
  readonly podName?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface ToolCallResult {
  readonly raw: unknown;
  readonly structured: Record<string, unknown> | undefined;
  readonly text: string | undefined;
  readonly isError: boolean;
}

export class RelayClient {
  private sessionId: string | undefined;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: RelayConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get podName(): string | undefined { return this.cfg.podName; }
  get agentDid(): string | undefined { return typeof this.cfg.bearer === 'object' && this.cfg.bearer instanceof DidTokenMinter ? this.cfg.bearer.did : undefined; }

  async initialize(): Promise<void> {
    const res = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'jev-harness', version: '0.1.0' },
    });
    if (res.sessionId) this.sessionId = res.sessionId;
    await this.notify('notifications/initialized');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (this.sessionId === undefined) await this.initialize();
    const res = await this.rpc('tools/call', { name, arguments: args });
    const result = (res.body as { result?: Record<string, unknown>; error?: { message?: string } });
    if (result.error) throw new Error(`relay tools/call ${name} failed: ${result.error.message ?? JSON.stringify(result.error)}`);
    const r = result.result ?? {};
    const content = (r['content'] as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = content.find((c) => c.type === 'text')?.text;
    let structured = r['structuredContent'] as Record<string, unknown> | undefined;
    if (!structured && text) {
      try { structured = JSON.parse(text) as Record<string, unknown>; } catch { /* plain text result */ }
    }
    return { raw: r, structured, text, isError: Boolean(r['isError']) };
  }

  private async notify(method: string): Promise<void> {
    await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    }).catch(() => undefined);
  }

  private async bearer(): Promise<string> {
    return typeof this.cfg.bearer === 'string' ? this.cfg.bearer : this.cfg.bearer.token();
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.bearer()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  private async rpc(method: string, params: Record<string, unknown>, retried = false): Promise<{ body: unknown; sessionId?: string }> {
    const id = this.nextId++;
    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const sessionId = res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    if (res.status === 401 && typeof this.cfg.bearer !== 'string' && !retried) {
      // The token lapsed or was revoked under us: mint again and repeat once, in a fresh session.
      this.cfg.bearer.invalidate();
      this.sessionId = undefined;
      if (method !== 'initialize') await this.initialize();
      return this.rpc(method, params, true);
    }
    if (res.status === 404 && this.sessionId !== undefined && !retried && method !== 'initialize') {
      // The relay forgot the session (it restarted, or expired it): a long-lived bridge kept
      // answering "MCP session not found" for every publish until its own restart. Open a new
      // session and repeat once; the token is still good.
      this.sessionId = undefined;
      await this.initialize();
      return this.rpc(method, params, true);
    }
    if (!res.ok) throw new Error(`relay ${method} responded ${res.status}: ${text.slice(0, 300)}`);
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('text/event-stream') ? lastJsonRpcMessage(text, id) : JSON.parse(text);
    return sessionId ? { body, sessionId } : { body };
  }
}

/** The JSON-RPC response for `id` out of an SSE stream. */
export function lastJsonRpcMessage(sse: string, id: number): unknown {
  let match: unknown;
  for (const chunk of sse.split(/\n\n+/)) {
    const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as { id?: number };
      if (msg.id === id) match = msg;
    } catch { /* keep-alive or partial */ }
  }
  if (match === undefined) throw new Error('relay returned an event stream without a matching JSON-RPC response');
  return match;
}

/**
 * The relay client the environment describes, or null when nothing is configured.
 * INTEREGO_AGENT_KEY_JSON wins over INTEREGO_BEARER: a key renews itself, a pasted token lapses.
 */
export function relayFromEnv(): RelayClient | null {
  const url = process.env['INTEREGO_RELAY_URL'] ?? DEFAULT_RELAY_URL;
  const podName = process.env['INTEREGO_POD_NAME'];
  const keyJson = process.env['INTEREGO_AGENT_KEY_JSON'];
  if (keyJson) {
    const minter = new DidTokenMinter({
      relayOrigin: new URL(url).origin,
      key: agentKeyFromJwk(keyJson),
      clientName: process.env['INTEREGO_CLIENT_NAME'] ?? 'jev-harness-bridge',
    });
    return new RelayClient({ url, bearer: minter, ...(podName ? { podName } : {}) });
  }
  const bearer = process.env['INTEREGO_BEARER'];
  if (!bearer) return null;
  return new RelayClient({ url, bearer, ...(podName ? { podName } : {}) });
}

export interface PublishOptions {
  readonly visibility?: 'public' | 'shared' | 'private';
  /** Descriptor URL or CID of the chain head this publish supersedes (CAS). */
  readonly ifMatch?: string;
  readonly signAuthorship?: boolean;
  /**
   * Publish under another graph IRI. An Outcome is published as the NEXT VERSION of the
   * judgment's own graph (Asserted, superseding the Hypothetical head) so the relay's
   * iep:supersedes chain, get_current_head and reduce_chain all see the flip; locally the
   * outcome keeps its own graph IRI and carries iep:supersedes on its descriptor.
   */
  readonly graphIri?: string;
}

export interface PublishReceipt {
  readonly descriptorUrl?: string;
  readonly graphUrl?: string;
  readonly previousHeadCid?: string;
  readonly raw: unknown;
}

/** publish_context with the judgment's payload as graph_content; the relay adds the facets. */
export async function publishJudgment(relay: RelayClient, j: Published, payloadTurtle: string, opts: PublishOptions = {}): Promise<PublishReceipt> {
  const args: Record<string, unknown> = {
    graph_iri: opts.graphIri ?? j.graphIri,
    graph_content: payloadTurtle,
    modal_status: modalStatus(j),
    confidence: j.confidence,
    visibility: opts.visibility ?? 'shared',
    auto_supersede_prior: true,
    sign_authorship: opts.signAuthorship ?? true,
  };
  if (opts.ifMatch) args['if_match'] = opts.ifMatch;
  if (relay.podName) args['pod_name'] = relay.podName;
  if (relay.agentDid) args['agent_did'] = relay.agentDid;
  const r = await relay.callTool('publish_context', args);
  if (r.isError) throw new Error(`publish_context returned an error: ${r.text ?? JSON.stringify(r.raw)}`);
  const s = r.structured ?? {};
  return {
    ...(typeof s['descriptorUrl'] === 'string' ? { descriptorUrl: s['descriptorUrl'] } : {}),
    ...(typeof s['graphUrl'] === 'string' ? { graphUrl: s['graphUrl'] } : {}),
    ...(typeof s['previousHeadCid'] === 'string' ? { previousHeadCid: s['previousHeadCid'] } : {}),
    raw: r.raw,
  };
}

export interface TrajectoryStep {
  readonly verb: string;
  readonly objectName: string;
  readonly modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  readonly resultSuccess?: boolean;
  readonly resultQuality?: number;
  readonly resultNote?: string;
  readonly wasDerivedFrom?: readonly string[];
  readonly sessionId?: string;
}

export async function recordTrajectoryStep(relay: RelayClient, step: TrajectoryStep): Promise<ToolCallResult> {
  return relay.callTool('record_trajectory_step', {
    verb: step.verb,
    object_name: step.objectName,
    granularity: 'tool-call',
    modal_status: step.modalStatus ?? 'Asserted',
    ...(step.resultSuccess !== undefined ? { result_success: step.resultSuccess } : {}),
    ...(step.resultQuality !== undefined ? { result_quality: step.resultQuality } : {}),
    ...(step.resultNote ? { result_note: step.resultNote } : {}),
    ...(step.wasDerivedFrom ? { was_derived_from: [...step.wasDerivedFrom] } : {}),
    ...(step.sessionId ? { session_id: step.sessionId } : {}),
  });
}
