/**
 * "Sign in with your Interego account" in the web UI, driven for real against a stubbed relay.
 *
 * The bridge is composed the way server.ts composes it (createVerticalBridge + the handlers + the
 * host guard + attachUi with Interego sign-in), on a loopback port; the shipped /ui shell and
 * app.js run in jsdom windows whose fetch reaches that bridge. The relay is an in-process fetch
 * that behaves as deploy/mcp-relay does where this flow touches it: its authorization server
 * metadata (CIMD advertised), Client ID Metadata Documents read from the client's own URL (the
 * client_name slugified into the agent's slug, as surfaceAgentFromClient does), dynamic
 * registration, PKCE S256 at the token endpoint (an access token that lasts an hour), and POST /mcp,
 * which takes that access token as a plain Bearer, serves a tools/call with no initialize, answers
 * as JSON or as Server-Sent Events, and runs sign_request as handleSignRequest does (the caller's
 * fields with underscore and reserved keys dropped, podUrl kept as pod_url, then the session's
 * agent_id, the caller's own pod as subject_pod_url and the relay's timestamp; EIP-191 over
 * sha256:<hex>) with a generated relay key. It also answers /identity-token and /tool/sign_request
 * as the relay does, so that a bridge calling either would work, and the tests assert it never does.
 *
 * A browser navigation is the one thing jsdom cannot do: the page's location.assign to the relay is
 * reported by jsdom as "not implemented" and read here from the link the page shows beside it, and
 * the relay's redirect back is a second window opened at the callback URL with this tab's session
 * storage, as a browser keeps it across a navigation in one tab. jsdom has no SubtleCrypto or
 * TextEncoder, so the test windows get Node's, the same APIs a browser has. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { importWallet, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { pevAffordances } from '../affordances.js';
import { createPevHandlers, DEMO_ROLE_NAMES, WEB_UI_AGENT_PREFIX, type DemoRoleName, type PevDeps } from '../bridge/handlers.js';
import { didDocumentFetch, readHead, isTrusted } from '../bridge/pod-helpers.js';
import { attachUi, hostAllowlistGuard, relayCallFetch, PEV_UI_CLIENT_NAME, UI_CSP, type InteregoUiOptions } from '../bridge/ui.js';
import { DEMO_POD, demoScenarioInput, demoWallet, inMemoryPod, scriptedPracticeModel } from '../demo/run.js';
import { PEV_ACTION } from '../src/ontology.js';
import { signEnvelope, type PevRecordBody } from '../src/records.js';

type Out = Record<string, unknown>;
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const SLOW = 240_000;
const RELAY = 'https://relay.ui.test';
const DEPLOY = 'https://pev.ui.test';
const IDH = 'identity.ui.test';
const SESSION_KEY = 'pev.interego.session';
const PENDING_KEY = 'pev.interego.pending';
const NAVIGATION = 'jsdomError: Not implemented: navigation (except hash changes)';

const pod = inMemoryPod();
const W = Object.fromEntries(DEMO_ROLE_NAMES.map((r) => [r, demoWallet(r)])) as Record<DemoRoleName, Wallet>;
const PLATFORM = demoWallet('platform');
const TRUSTED = { addresses: new Set([PLATFORM.address.toLowerCase()]) };
const RELAY_KEY = importWallet(`0x${sha256('pev-signin-ui-test:relay')}`, 'agent', 'relay');
const USER = 'u-pk-0000000000f7';
const PRINCIPAL = `did:web:${IDH}:users:${USER}`;
const OTHER = `did:web:${IDH}:users:u-pk-0000000000f8`;
const b64url = (b: Buffer): string => b.toString('base64url');

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The relay, as an in-process fetch
// ═════════════════════════════════════════════════════════════════════════════════════════════

interface RelayCall {
  readonly method: string; readonly url: string; readonly authorization: string | null; readonly body: string;
  readonly accept: string | null; readonly contentType: string | null; readonly mcpSession: string | null;
}
/** What the stubbed relay's /mcp answers next, in place of a signed request. */
type McpFault = 'rpc-error' | 'is-error' | 'error-text' | 'scope' | 'other-id';
/** Every stubbed relay this file makes, so the last test can look at every call any bridge made. */
const allRelays: { readonly calls: readonly RelayCall[] }[] = [];

/** The identity host's agents, minted as the relay mints them at sign-in (`<surface>-<userId>`). */
const agentDocs = new Map<string, unknown>();
const fetchDidDocument = async (url: string): Promise<unknown> => {
  if (!agentDocs.has(url)) throw new Error('the identity host answered HTTP 404');
  return agentDocs.get(url);
};

function stubRelay(o: { readonly cimd: boolean; readonly expiresIn?: number; readonly grantScope?: string; readonly tokenLimit?: number }) {
  const calls: RelayCall[] = [];
  const registered = new Map<string, Out>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string; slug: string; user: string }>();
  /** Access tokens the token endpoint issued, each with its agent, its person, its identity-server token and when it expires. */
  const access = new Map<string, { slug: string; user: string; idToken: string; expiresAt: number }>();
  const identity = new Map<string, { slug: string }>();
  const issued: string[] = [];
  const refreshIssued: string[] = [];
  /** The JSON-RPC requests /mcp was sent, in order. */
  const rpcs: Out[] = [];
  const state = { answerAs: 'sse' as 'sse' | 'json', faults: [] as McpFault[] };
  /** While set, every POST /mcp waits on it before its bearer is checked, as a relay slow to answer does. */
  let gate: Promise<void> | null = null;
  let waiting = 0;
  /** POST /token calls, those refused past `tokenLimit` (the relay's 50 every 15 minutes for one address), and requests /mcp signed. */
  const counts = { token: 0, tokenRefused: 0, signed: 0 };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  /** sign_request as handleSignRequest runs it, for the session's agent, answered as the relay's tool text. */
  async function signRequest(slug: string, args: Out, user = USER): Promise<string> {
    const reserved = new Set(['agent_id', 'timestamp', '_signature', '_signed_payload', 'subject_pod_url', 'payload', 'pod_name', 'owner_webid', 'owner_name']);
    const p = (args['payload'] ?? {}) as Out;
    const safe: Out = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_') && !reserved.has(k)));
    const asked = p['pod_url'] ?? p['podUrl'];
    delete safe['pod_url'];
    delete safe['podUrl'];
    if (typeof asked === 'string') safe['pod_url'] = asked;
    const agentId = `did:web:${IDH}:agents:${slug}`;
    const sp = JSON.stringify({ ...safe, agent_id: agentId, subject_pod_url: `https://pods.ui.test/${user}/`, timestamp: new Date().toISOString() });
    return JSON.stringify({
      _signature: await signMessageRaw(RELAY_KEY, `sha256:${sha256Hex(sp)}`), _signed_payload: sp, signed_as: agentId,
      signatureAuthority: 'relay', signingNote: 'This is a relay-mediated signature.', anchor: `did:ethr:${RELAY_KEY.address}`,
      hint: 'Pass this object as the `payload` of `act` on a rev-196 signed-request affordance.',
    });
  }

  /** POST /mcp as the relay serves it: a plain Bearer access token, then a stateless tools/call. */
  async function mcp(bearer: string, headers: Headers, body: string): Promise<Response> {
    if (gate !== null) { waiting += 1; await gate; waiting -= 1; }
    const who = access.get(bearer);
    if (!who || who.expiresAt <= Date.now()) {
      return json(401, { error: 'invalid_token', error_description: 'Invalid or expired token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
    }
    const accept = headers.get('accept') ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      return json(406, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' } });
    }
    if (!(headers.get('content-type') ?? '').startsWith('application/json')) return json(415, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unsupported Media Type' } });
    const rpc = JSON.parse(body) as Out;
    rpcs.push(rpc);
    const id = rpc['id'];
    const params = (rpc['params'] ?? {}) as Out;
    let message: Out;
    if (rpc['method'] !== 'tools/call') {
      message = { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(rpc['method'])}` } };
    } else if (params['name'] !== 'sign_request') {
      message = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${String(params['name'])}` }], isError: true } };
    } else {
      const fault = state.faults.shift();
      // The relay strips reserved wire fields and injects the session's identity itself.
      const args = Object.fromEntries(Object.entries((params['arguments'] ?? {}) as Out).filter(([k]) => !k.startsWith('_')));
      if (fault === 'rpc-error') message = { jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error for the bearer ${bearer}` } };
      else if (fault === 'is-error') message = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: pod bootstrap failed for ${bearer}` }], isError: true } };
      else if (fault === 'scope') {
        message = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'insufficient_scope', code: 403, requiredScope: ['mcp', 'mcp:write'], grantedScope: ['mcp:read'] }) }], isError: true } };
      } else if (fault === 'error-text') {
        const text = JSON.stringify({ error: 'sign_request: signing failed: the delegation key is not loaded' });
        message = { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as Out } };
      } else {
        const text = await signRequest(who.slug, args, who.user);
        counts.signed += 1;
        message = { jsonrpc: '2.0', id: fault === 'other-id' ? `${String(id)}-not-this-one` : id, result: { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as Out } };
      }
    }
    if (state.answerAs === 'json') return json(200, message);
    // As the streamable HTTP transport answers: events, a notification before the answer.
    const note = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'signing' } };
    return new Response(`event: message\ndata: ${JSON.stringify(note)}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({
      method, url, authorization: headers.get('authorization'), body,
      accept: headers.get('accept'), contentType: headers.get('content-type'), mcpSession: headers.get('mcp-session-id'),
    });
    const u = new URL(url);
    if (u.origin !== RELAY) return json(404, { error: 'not this relay' });
    const bearer = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    switch (`${method} ${u.pathname}`) {
      case 'GET /.well-known/oauth-authorization-server':
        return json(200, {
          issuer: `${RELAY}/`, authorization_endpoint: `${RELAY}/authorize`, token_endpoint: `${RELAY}/token`, registration_endpoint: `${RELAY}/register`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], ...(o.cimd ? { client_id_metadata_document_supported: true } : {}),
        });
      case 'POST /register': {
        const meta = JSON.parse(body) as Out;
        const id = randomBytes(16).toString('hex');
        registered.set(id, meta);
        return json(201, { ...meta, client_id: id, client_id_issued_at: 1 });
      }
      case 'POST /token': {
        counts.token += 1;
        if (o.tokenLimit !== undefined && counts.token > o.tokenLimit) {
          counts.tokenRefused += 1;
          return json(429, { error: 'too_many_requests', error_description: 'Too many token requests' }, { 'retry-after': '900' });
        }
        const f = new URLSearchParams(body);
        const c = codes.get(f.get('code') ?? '');
        if (f.get('grant_type') !== 'authorization_code' || !c) return json(400, { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
        codes.delete(f.get('code') ?? '');
        if (f.get('client_id') !== c.clientId || f.get('redirect_uri') !== c.redirectUri || f.get('resource') !== c.resource) {
          return json(400, { error: 'invalid_grant', error_description: 'Authorization code was issued to a different client' });
        }
        if (b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== c.challenge) {
          return json(400, { error: 'invalid_grant', error_description: 'code_verifier does not match the challenge' });
        }
        const token = randomBytes(32).toString('hex');
        const expiresIn = o.expiresIn ?? 3600;
        const idToken = `cg2_${b64url(Buffer.from(JSON.stringify({ userId: c.user, agentId: c.slug })))}.${b64url(randomBytes(32))}`;
        access.set(token, { slug: c.slug, user: c.user, idToken, expiresAt: Date.now() + expiresIn * 1000 });
        identity.set(idToken, { slug: c.slug });
        issued.push(token);
        const refresh = randomBytes(32).toString('hex');
        refreshIssued.push(refresh);
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refresh, scope: o.grantScope ?? c.scope });
      }
      case 'POST /mcp':
        return mcp(bearer, headers, body);
      // The relay's other two ways in, answered as it answers them: this bridge must use neither.
      case 'GET /identity-token': {
        const a = access.get(bearer);
        return a ? json(200, { identityToken: a.idToken, expiresAt: 0, userId: USER }) : json(401, { error: 'Invalid access token' });
      }
      case 'POST /tool/sign_request': {
        const who = identity.get(bearer);
        if (!who) return json(401, { error: 'Authentication required for write operations', detail: 'Invalid token' });
        return json(200, JSON.parse(await signRequest(who.slug, JSON.parse(body) as Out)) as Out);
      }
      default:
        return json(404, { error: `no route ${method} ${u.pathname}` });
    }
  }) as typeof fetch;

  /** The relay stops taking an access token, as it does once the token's hour is over. */
  function expire(token: string): void {
    const a = access.get(token);
    if (a) a.expiresAt = 0;
  }

  /** The identity host's document for `slug`, controlled by `user`, as the relay mints it at sign-in. */
  function mintAgent(slug: string, user: string): void {
    agentDocs.set(`https://${IDH}/agents/${slug}/did.json`, { '@context': ['https://www.w3.org/ns/did/v1'], id: `did:web:${IDH}:agents:${slug}`, controller: `did:web:${IDH}:users:${user}` });
  }

  /**
   * An access token the relay issued to `user` for the client named `client` (this bridge's, unless
   * another is given) without this bridge: from the relay's own sign-in page for another client, as
   * any account holder can get one, an hour long, scope `mcp`.
   */
  function mint(user: string, client = PEV_UI_CLIENT_NAME): string {
    const slug = `${client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${user}`;
    mintAgent(slug, user);
    const token = randomBytes(32).toString('hex');
    access.set(token, { slug, user, idToken: `cg2_${b64url(randomBytes(32))}`, expiresAt: Date.now() + 3_600_000 });
    return token;
  }

  /** Hold every POST /mcp from now until the function returned is called. */
  function hold(): () => void {
    let release: () => void = () => undefined;
    gate = new Promise<void>((r) => { release = r; });
    return () => { gate = null; release(); };
  }

  /**
   * The person signs in on the relay's own page (their passkey): the relay reads the client (its
   * CIMD from the client's own URL, which `deployed` maps to this test's listener, or a DCR
   * registration), mints the agent `<client name slug>-<userId>` on the identity host, and sends the
   * browser back to the redirect URI with a code and the state it was given.
   */
  async function signIn(authorizeUrl: string, deployed: (url: string) => string, user = USER): Promise<string> {
    const a = new URL(authorizeUrl);
    const q = (k: string): string => a.searchParams.get(k) ?? '';
    expect([a.origin + a.pathname, q('response_type'), q('code_challenge_method')]).toEqual([`${RELAY}/authorize`, 'code', 'S256']);
    let clientName: string;
    let redirectUris: string[];
    if (q('client_id').startsWith('https://')) {
      const doc = (await (await fetch(deployed(q('client_id')))).json()) as Out;
      expect(doc['client_id']).toBe(q('client_id'));
      clientName = String(doc['client_name']);
      redirectUris = doc['redirect_uris'] as string[];
    } else {
      const meta = registered.get(q('client_id'));
      if (!meta) throw new Error('unknown client');
      clientName = String(meta['client_name']);
      redirectUris = meta['redirect_uris'] as string[];
    }
    expect(redirectUris).toContain(q('redirect_uri'));
    const surface = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const slug = `${surface}-${user}`;
    mintAgent(slug, user);
    const code = randomBytes(24).toString('hex');
    codes.set(code, { clientId: q('client_id'), redirectUri: q('redirect_uri'), challenge: q('code_challenge'), resource: q('resource'), scope: q('scope'), slug, user });
    const back = new URL(q('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q('state'));
    return back.href;
  }

  const stub = {
    fetchFn, calls, registered, issued, refreshIssued, rpcs, signIn, expire, mint, hold, state,
    held: (): number => waiting, signed: (): number => counts.signed, tokenRefusals: (): number => counts.tokenRefused,
  };
  allRelays.push(stub);
  return stub;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The bridge and the page
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The relay-delegation policy, as server.ts gives it to the handlers and to the web UI's sign-in alike. */
const POLICY = { relayAddresses: [RELAY_KEY.address.toLowerCase()], identityHost: IDH, fetchDidDocument };
const handlers = createPevHandlers({
  platformWallet: PLATFORM, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address], adminDids: [PRINCIPAL],
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110',
  relayDelegation: POLICY,
  relayUrl: RELAY, model: scriptedPracticeModel(),
} satisfies PevDeps) as Handlers;

const listeners: TestListener[] = [];
/** A bridge on a loopback port; its sign-in has the handlers' relay-delegation policy unless `interego` names another. */
async function serve(interego: InteregoUiOptions | undefined, o: { readonly trustProxy?: boolean } = {}): Promise<TestListener> {
  const allowed: string[] = [];
  const app: Express = createVerticalBridge({
    verticalName: 'practice-evidence', affordances: pevAffordances, handlers, deploymentUrl: 'http://127.0.0.1:6110', defaultPodUrl: DEMO_POD,
    middleware: (a) => {
      // As server.ts does on a deployment behind one proxy hop: req.ip is then the X-Forwarded-For address.
      if (o.trustProxy === true) a.set('trust proxy', 1);
      a.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => hostAllowlistGuard(allowed)(req, res, next));
      attachUi(a, interego ? { interego: { relayDelegation: POLICY, ...interego } } : {});
    },
  });
  const l = await listenLoopback(app);
  allowed.push(`127.0.0.1:${l.port}`, `localhost:${l.port}`);
  listeners.push(l);
  return l;
}

interface Page {
  readonly w: JSDOM['window'];
  readonly errors: string[];
  readonly asked: string[];
  /** Timers of a minute or more the page set (the sign-in's expiry), held here to be fired by the test. */
  readonly long: { readonly ms: number; readonly fire: () => void }[];
  until<T>(fn: () => T | null | undefined | false, what: string, ms?: number): Promise<T>;
  q(sel: string): HTMLElement | null;
  text(sel: string): string;
  session(k: string): string | null;
}

/** The page at `path`, its fetch reaching the bridge, `session` copied into its sessionStorage first. */
async function openPage(l: TestListener, path: string, session: Record<string, string> = {}): Promise<Page> {
  const errors: string[] = [];
  const asked: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a: unknown[]) => errors.push(`console.error: ${a.map(String).join(' ')}`));
  const html = await (await fetch(`${l.base}${path}`)).text();
  const dom = new JSDOM(html, { url: `${l.base}${path}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w['fetch'] = (input: unknown, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input), w.location.href);
    asked.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    return fetch(u, init);
  };
  w['TextEncoder'] = TextEncoder;
  Object.defineProperty(w.crypto, 'subtle', { value: globalThis.crypto.subtle });
  // A timer of a minute or more is held, not run: the test fires the sign-in's expiry itself.
  const long: { ms: number; fire: () => void }[] = [];
  const held = new Set<number>();
  let nextHeld = 1_000_000_000;
  const realSet = w.setTimeout.bind(w);
  const realClear = w.clearTimeout.bind(w);
  Object.assign(w, {
    setTimeout: (fn: unknown, ms?: number, ...a: unknown[]): number => {
      if (typeof fn !== 'function' || !(Number(ms) >= 60_000)) return realSet(fn as () => void, ms, ...a);
      const id = nextHeld++;
      held.add(id);
      long.push({ ms: Number(ms), fire: () => { if (held.delete(id)) (fn as (...x: unknown[]) => void)(...a); } });
      return id;
    },
    clearTimeout: (id?: number): void => { if (id !== undefined && held.delete(id)) return; realClear(id); },
  });
  for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  w.eval(await (await fetch(`${l.base}/ui/app.js`)).text());
  const d = w.document;
  return {
    w, errors, asked, long,
    async until<T>(fn: () => T | null | undefined | false, what: string, ms = 60_000): Promise<T> {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`the page never showed ${what}; it shows: ${(d.body.textContent ?? '').slice(0, 800)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    q: (sel) => d.querySelector<HTMLElement>(sel),
    text: (sel) => d.querySelector(sel)?.textContent ?? '',
    session: (k) => w.sessionStorage.getItem(k),
  };
}

const sessionOf = (p: Page): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < p.w.sessionStorage.length; i++) { const k = p.w.sessionStorage.key(i); if (k !== null) out[k] = p.w.sessionStorage.getItem(k) ?? ''; }
  return out;
};

/** Press the button and read where the page sends the person; jsdom reports the navigation it cannot make. */
async function pressSignIn(p: Page): Promise<URL> {
  const btn = await p.until(() => p.q('#interego-sign-in'), 'the Interego sign-in button');
  expect(btn.textContent).toBe('Sign in with your Interego account');
  btn.click();
  const link = await p.until(() => p.q('#interego-continue') as HTMLAnchorElement | null, 'the link to the relay');
  await p.until(() => p.errors.includes(NAVIGATION), 'the navigation to the relay');
  expect(p.errors.filter((e) => e !== NAVIGATION)).toEqual([]);
  p.errors.length = 0;
  return new URL(link.href);
}

let nonceN = 0;
const nonce = (): string => `signin-ui-nonce-${String(++nonceN).padStart(8, '0')}`;
async function direct(tool: string, w: Wallet, action: string, fields: Out = {}): Promise<Out> {
  return (await handlers[tool]!({ envelope: await signEnvelope(w, { v: 1, action, issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: DEMO_POD, ...fields }) })) as Out;
}

/**
 * A sign-in finished without a page: the person signs in at the relay (the CIMD client of an https
 * deployment), and the code goes to the bridge's exchange. The exchange's answer.
 */
async function exchangeDirect(l: TestListener, stub: ReturnType<typeof stubRelay>, headers: Record<string, string> = {}, user = USER): Promise<{ status: number; json: Out }> {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  const authorize = new URL(`${RELAY}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: `${DEPLOY}/ui/oauth/client.json`, redirect_uri: `${DEPLOY}/ui/oauth/callback`,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, scope: 'mcp', resource: `${RELAY}/`,
  })) authorize.searchParams.set(k, v);
  const code = new URL(await stub.signIn(authorize.href, (u) => u.replace(DEPLOY, l.base), user)).searchParams.get('code') ?? '';
  const r = await fetch(`${l.base}/ui/oauth/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code, code_verifier: verifier, state }),
  });
  return { status: r.status, json: (await r.json()) as Out };
}

/** One act's payload signed through the bridge's /ui/relay/sign with `token`. */
async function signThrough(l: TestListener, token: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Out }> {
  const r = await fetch(`${l.base}/ui/relay/sign`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ payload: { v: 1, action: PEV_ACTION.getAttempt, nonce: nonce(), podUrl: DEMO_POD } }),
  });
  return { status: r.status, json: (await r.json()) as Out };
}

/** The relay calls that reached a path. */
const callsTo = (stub: { readonly calls: readonly RelayCall[] }, path: string): RelayCall[] => stub.calls.filter((c) => c.url === `${RELAY}${path}`);

/** A request from `ip`, as the proxy in front of a deployment names it (the test bridge trusts one hop). */
const from = (ip: string): Record<string, string> => ({ 'x-forwarded-for': ip });
interface Signed { readonly status: number; readonly code: unknown; readonly retry: unknown; readonly header: string | null; readonly error: string }
/** What the relay limits are tested with: a sign from an address, a made-up code's exchange from one, and how many calls reached a relay path. */
function limitMoves(l: TestListener, stub: ReturnType<typeof stubRelay>): {
  relayed(path: string): number;
  sign(token: string, ip: string): Promise<Signed>;
  exchange(code: string, ip: string): Promise<readonly [number, unknown]>;
  madeUp(i: number): string;
} {
  return {
    relayed: (path) => callsTo(stub, path).length,
    async sign(token, ip) {
      const r = await fetch(`${l.base}/ui/relay/sign`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...from(ip) },
        body: JSON.stringify({ payload: { v: 1, action: PEV_ACTION.getAttempt, nonce: nonce(), podUrl: DEMO_POD } }),
      });
      const text = await r.text();
      expect(text).not.toContain(token);
      const j = JSON.parse(text) as Out;
      return { status: r.status, code: j['iep:refusalReason'] ?? null, retry: j['retryAfterSeconds'] ?? null, header: r.headers.get('retry-after'), error: String(j['error'] ?? '') };
    },
    async exchange(code, ip) {
      const r = await fetch(`${l.base}/ui/oauth/exchange`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...from(ip) },
        body: JSON.stringify({ code, code_verifier: 'a'.repeat(43), state: 'b'.repeat(16) }),
      });
      return [r.status, ((await r.json()) as Out)['iep:refusalReason']] as const;
    },
    madeUp: (i) => `madeupcode${String(i).padStart(4, '0')}xxxxxxxx`,
  };
}

const relay = stubRelay({ cimd: true });
let bridge: TestListener;
const deployed = (url: string): string => url.replace(DEPLOY, bridge.base);

beforeAll(async () => {
  bridge = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: relay.fetchFn });
  for (const [who, role] of [['author', 'author'], ['reviewer', 'reviewer']] as const) {
    expect((await direct('pev.register_role', W.admin, PEV_ACTION.registerRole, { address: W[who].address, role, change: 'add' }))['changed']).toBe(true);
  }
  const pub = await direct('pev.author_scenario', W.author, PEV_ACTION.authorScenario, { scenario: demoScenarioInput('missed-deadline', 2), status: 'published', draftAssistance: { used: false } });
  const rat = await direct('pev.ratify_scenario', W.reviewer, PEV_ACTION.ratifyScenario, { scenarioIri: pub['scenarioIri'], version: 1, scenarioHash: pub['scenarioHash'] });
  expect(rat['status']).toBe('ratified');
}, SLOW);

afterAll(async () => { for (const l of listeners) await l.close(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The routes
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the sign-in routes: the client document, the start, and their refusals', () => {
  it('serves a Client ID Metadata Document whose client_id is its own URL on the deployment URL', async () => {
    const r = await fetch(`${bridge.base}/ui/oauth/client.json`);
    expect([r.status, r.headers.get('content-type')]).toEqual([200, expect.stringMatching(/^application\/json/)]);
    expect(await r.json()).toEqual({
      client_id: `${DEPLOY}/ui/oauth/client.json`, client_name: PEV_UI_CLIENT_NAME, client_uri: `${DEPLOY}/ui`,
      redirect_uris: [`${DEPLOY}/ui/oauth/callback`], grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: 'mcp',
    });
    // The relay turns the client name into the agent's slug, which is this bridge's web UI prefix.
    expect(`${PEV_UI_CLIENT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`).toBe(WEB_UI_AGENT_PREFIX);
  });

  it('starts with the CIMD URL as the client id when the relay takes one; over http it registers by DCR, once', async () => {
    const start = (await (await fetch(`${bridge.base}/ui/oauth/start`)).json()) as Out;
    expect(start).toEqual({
      authorizationEndpoint: `${RELAY}/authorize`, clientId: `${DEPLOY}/ui/oauth/client.json`, redirectUri: `${DEPLOY}/ui/oauth/callback`,
      scope: 'mcp', resource: `${RELAY}/`, registration: 'client-id-metadata-document', relay: RELAY,
    });
    const dcrRelay = stubRelay({ cimd: true });
    const loopback = await serve({ relayUrl: RELAY, deploymentUrl: 'http://127.0.0.1:6110', relayFetch: dcrRelay.fetchFn });
    const a = (await (await fetch(`${loopback.base}/ui/oauth/start`)).json()) as Out;
    const b = (await (await fetch(`${loopback.base}/ui/oauth/start`)).json()) as Out;
    expect([a['registration'], a['clientId'], a['redirectUri']]).toEqual(['dynamic-registration', [...dcrRelay.registered.keys()][0], 'http://127.0.0.1:6110/ui/oauth/callback']);
    expect(b['clientId']).toBe(a['clientId']);
    expect(dcrRelay.calls.filter((c) => c.url === `${RELAY}/register`)).toHaveLength(1);
    expect([...dcrRelay.registered.values()]).toEqual([{
      client_name: PEV_UI_CLIENT_NAME, client_uri: 'http://127.0.0.1:6110/ui', redirect_uris: ['http://127.0.0.1:6110/ui/oauth/callback'],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
    }]);
    // A relay that advertises no CIMD gets a DCR client even from an https deployment.
    const noCimd = stubRelay({ cimd: false });
    const https = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: noCimd.fetchFn });
    expect(((await (await fetch(`${https.base}/ui/oauth/start`)).json()) as Out)['registration']).toBe('dynamic-registration');
  });

  it('/ui/relay/sign refuses without a bearer, and refuses anything but a pev act, before calling the relay', async () => {
    const before = relay.calls.length;
    const post = async (body: unknown, authorization?: string): Promise<{ status: number; json: Out }> => {
      const r = await fetch(`${bridge.base}/ui/relay/sign`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json()) as Out };
    };
    const payload = { v: 1, action: PEV_ACTION.getAttempt, nonce: nonce(), podUrl: DEMO_POD };
    for (const auth of [undefined, 'Bearer', 'Basic abc', 'Bearer two words', `Bearer ${'x'.repeat(9000)}`]) {
      const r = await post({ payload }, auth);
      expect([r.status, r.json['iep:refusalReason'], r.json['kind']], String(auth)).toEqual([401, 'interego-bearer-missing', 'refusal']);
    }
    const unknown = `Bearer ${'5e'.repeat(32)}`;
    for (const bad of [{}, { payload: { ...payload, action: 'urn:iep:action:foxxi:review-record' } }, { payload: { ...payload, v: 2 } }, { payload: { v: 1, action: PEV_ACTION.getAttempt } }]) {
      const r = await post(bad, unknown);
      expect([r.status, r.json['iep:refusalReason']], JSON.stringify(bad)).toEqual([400, 'payload-shape']);
    }
    const big = await post({ payload: { ...payload, filler: 'x'.repeat(70 * 1024) } }, unknown);
    expect([big.status, big.json['iep:refusalReason']]).toEqual([413, 'payload-too-large']);
    const malformed = await fetch(`${bridge.base}/ui/relay/sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: unknown }, body: '{ not json' });
    expect([malformed.status, ((await malformed.json()) as Out)['iep:refusalReason']]).toEqual([400, 'body-unreadable']);
    expect(relay.calls.length).toBe(before);
    // A bearer the relay does not know: the relay's /mcp is asked, and its 401 comes back as a sign-in to redo.
    const stale = await post({ payload }, unknown);
    expect([stale.status, stale.json['iep:refusalReason']]).toEqual([401, 'interego-sign-in-expired']);
    expect(relay.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${RELAY}/mcp`]);
    expect(JSON.stringify(stale.json)).not.toContain('5e5e5e5e');
  });

  it('the exchange gives the page the relay\'s access token and its expiry only; the sign route is one tools/call at /mcp, JSON or SSE', async () => {
    const before = relay.calls.length;
    const ex = await exchangeDirect(bridge, relay);
    const token = relay.issued.at(-1) ?? '';
    // Only the code exchange: no /identity-token, and the refresh token the relay sent is not passed on.
    expect([ex.status, Object.keys(ex.json).sort(), ex.json['accessToken'], ex.json['expiresIn']]).toEqual([200, ['accessToken', 'expiresIn', 'note', 'relay', 'signedIn'], token, 3600]);
    expect(JSON.stringify(ex.json)).not.toContain(relay.refreshIssued.at(-1) ?? 'none');
    expect(relay.calls.slice(before).map((c) => `${c.method} ${new URL(c.url).pathname}`).filter((x) => !x.includes('/.well-known/'))).toEqual(['POST /token']);

    const agent = `did:web:${IDH}:agents:${WEB_UI_AGENT_PREFIX}${USER}`;
    for (const answerAs of ['json', 'sse'] as const) {
      relay.state.answerAs = answerAs;
      const r = await signThrough(bridge, token);
      expect([r.status, Object.keys(r.json).sort()], answerAs).toEqual([200, ['_signature', '_signed_payload']]);
      expect(JSON.parse(String(r.json['_signed_payload']))).toMatchObject({ action: PEV_ACTION.getAttempt, pod_url: DEMO_POD, agent_id: agent });
      // The request: a plain Bearer, both answer types accepted, no session, and a tools/call of sign_request whose arguments are the payload alone.
      const call = callsTo(relay, '/mcp').at(-1)!;
      expect([call.authorization, call.accept, call.contentType, call.mcpSession]).toEqual([`Bearer ${token}`, 'application/json, text/event-stream', 'application/json', null]);
      const rpc = relay.rpcs.at(-1)!;
      expect([rpc['jsonrpc'], rpc['method'], (rpc['params'] as Out)['name'], Object.keys((rpc['params'] as Out)['arguments'] as Out)]).toEqual(['2.0', 'tools/call', 'sign_request', ['payload']]);
    }
    // No initialize, ever, and a fresh id on every request.
    expect(relay.rpcs.filter((r) => r['method'] !== 'tools/call')).toEqual([]);
    const ids = relay.rpcs.map((r) => r['id']);
    expect(new Set(ids).size).toBe(ids.length);

    // What the relay answers instead of a signed request is a clean refusal, with the token nowhere in it, over JSON and SSE alike.
    for (const answerAs of ['json', 'sse'] as const) {
      relay.state.answerAs = answerAs;
      for (const [fault, says] of [
        ['rpc-error', 'Internal error for the bearer [withheld]'], ['is-error', 'Error: pod bootstrap failed for [withheld]'],
        ['error-text', 'the delegation key is not loaded'], ['scope', 'no write scope'], ['other-id', 'no JSON-RPC answer to this request'],
      ] as const) {
        relay.state.faults.push(fault);
        const r = await signThrough(bridge, token);
        expect([r.status, r.json['iep:refusalReason']], `${answerAs} ${fault}`).toEqual([502, 'relay-refused-signing']);
        expect(String(r.json['error']), `${answerAs} ${fault}`).toContain(says);
        expect(JSON.stringify(r.json)).not.toContain(token);
      }
    }
    relay.state.answerAs = 'sse';
    // A refusal is not a sign-in that ended: the same token still signs.
    expect((await signThrough(bridge, token)).status).toBe(200);

    // Once the relay stops taking the token (its hour is over), the bridge says so as a sign-in to redo, then from memory at no relay call.
    relay.expire(token);
    const expired = await signThrough(bridge, token);
    expect([expired.status, expired.json['iep:refusalReason']]).toEqual([401, 'interego-sign-in-expired']);
    const asked = callsTo(relay, '/mcp').length;
    expect((await signThrough(bridge, token)).json['iep:refusalReason']).toBe('interego-sign-in-expired');
    expect(callsTo(relay, '/mcp').length).toBe(asked);
    expect(relay.calls.slice(before).filter((c) => /^\/(identity-token|tool\/)/.test(new URL(c.url).pathname))).toEqual([]);
  });

  it('keeps a sign-in no longer than an hour or than the relay said, and refuses one already spent or with no write scope', async () => {
    const long = stubRelay({ cimd: true, expiresIn: 86_400 });
    const l = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: long.fetchFn });
    const ex = await exchangeDirect(l, long);
    expect([ex.status, ex.json['expiresIn']]).toEqual([200, 3600]);
    // A shorter expiry is kept as given; one under a second (the token already spent) is refused,
    // not stretched to the hour.
    const short = stubRelay({ cimd: true, expiresIn: 600 });
    expect((await exchangeDirect(await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: short.fetchFn }), short)).json['expiresIn']).toBe(600);
    for (const dead of [0, -5, 0.5]) {
      const d = stubRelay({ cimd: true, expiresIn: dead });
      const out = await exchangeDirect(await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: d.fetchFn }), d);
      expect([dead, out.status, out.json['iep:refusalReason'], 'accessToken' in out.json, 'expiresIn' in out.json]).toEqual([dead, 502, 'relay-token-unusable', false, false]);
      expect(JSON.stringify(out.json)).not.toContain(d.issued.at(-1) ?? 'none');
    }
    const readOnly = stubRelay({ cimd: true, grantScope: 'mcp:read' });
    const r = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: readOnly.fetchFn });
    const refused = await exchangeDirect(r, readOnly);
    expect([refused.status, refused.json['iep:refusalReason'], 'accessToken' in refused.json]).toEqual([502, 'relay-token-unusable', false]);
    expect(JSON.stringify(refused.json)).not.toContain(readOnly.issued.at(-1) ?? 'none');
  });

  it('refuses a code exchange of the wrong shape without calling the relay; with sign-in off every route says so', async () => {
    const before = relay.calls.length;
    const ex = async (body: unknown): Promise<[number, unknown]> => {
      const r = await fetch(`${bridge.base}/ui/oauth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return [r.status, ((await r.json()) as Out)['iep:refusalReason']];
    };
    const ok = { code: 'a'.repeat(40), code_verifier: 'v'.repeat(43), state: 's'.repeat(32) };
    expect(await ex({ ...ok, code: 'has a space in it' })).toEqual([400, 'oauth-code-shape']);
    expect(await ex({ ...ok, code_verifier: 'short' })).toEqual([400, 'pkce-verifier-shape']);
    expect(await ex({ ...ok, state: 'no' })).toEqual([400, 'oauth-state-shape']);
    expect(await ex({ ...ok, padding: 'x'.repeat(9000) })).toEqual([413, 'payload-too-large']);
    expect(relay.calls.length).toBe(before);
    const off = await serve(undefined);
    for (const path of ['/ui/oauth/client.json', '/ui/oauth/start', '/ui/oauth/callback']) {
      const r = await fetch(`${off.base}${path}`);
      expect([r.status, ((await r.json()) as Out)['iep:refusalReason']], path).toEqual([404, 'interego-sign-in-off']);
    }
  });

  it('a relay that does not answer is refused within the deadline, as JSON', async () => {
    let aborted = 0;
    const silent = (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted++; reject(new Error('This operation was aborted')); });
    })) as unknown as typeof fetch;
    const l = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: silent, timeoutMs: 300 });
    const t0 = Date.now();
    const r = await fetch(`${l.base}/ui/oauth/start`);
    expect([r.status, ((await r.json()) as Out)['iep:refusalReason']]).toEqual([502, 'relay-unreachable']);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(aborted).toBe(1);
  });

  it('the relay fetch server.ts composes follows no redirect, caps what it reads, and guards the target', async () => {
    const redirecting = relayCallFetch((async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.ui.test/' } })) as unknown as typeof fetch, { privateRelay: true });
    await expect(redirecting('https://relay.ui.test/token', { method: 'GET' })).rejects.toThrow(/redirect/);
    const huge = relayCallFetch((async () => new Response('x'.repeat(300 * 1024), { status: 200 })) as unknown as typeof fetch, { privateRelay: true });
    await expect(huge('https://relay.ui.test/token')).rejects.toThrow(/limit/);
    const reached: string[] = [];
    const guarded = relayCallFetch((async (u: string) => { reached.push(String(u)); return new Response('{}'); }) as unknown as typeof fetch);
    await expect(guarded('https://127.0.0.1/token')).rejects.toThrow(/private|loopback/);
    expect(reached).toEqual([]);
  });

  it('a caller who is not signed in cannot spend the relay calls people signed in here need, a refused token is not sent again, and code exchanges stay inside a 15-minute budget', async () => {
    let clock = Date.now();
    const lim = stubRelay({ cimd: true });
    const l = await serve({
      relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: lim.fetchFn, now: () => clock,
      limits: { unproven: 8, unprovenPerClient: 4, perSignIn: 5, exchanges: 7, exchangesPerClient: 5 },
    }, { trustProxy: true });
    const { relayed, sign, exchange, madeUp } = limitMoves(l, lim);
    // A person signs in from 203.0.113.1: the relay's metadata and the code, two relay calls.
    const ex = await exchangeDirect(l, lim, from('203.0.113.1'));
    expect([ex.status, relayed('/.well-known/oauth-authorization-server') + relayed('/token')]).toEqual([200, 2]);
    const bearer = String(ex.json['accessToken']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);

    // A stranger with made-up tokens, from one address: four reach the relay (each refused), then the bridge refuses on its own, saying when to try again.
    const signs = relayed('/mcp');
    const made = Array.from({ length: 10 }, (_, i) => `madeup${i}${'A'.repeat(16)}`);
    const one: Signed[] = [];
    for (const t of made) one.push(await sign(t, '198.51.100.7'));
    expect(one.map((r) => r.code)).toEqual([...Array<string>(4).fill('interego-sign-in-expired'), ...Array<string>(6).fill('relay-calls-limited')]);
    expect([one[4]?.status, Number(one[4]?.retry) > 0, one[4]?.header]).toEqual([429, true, String(one[4]?.retry)]);
    expect(one[4]?.error).toContain('limit of 4 relay calls a minute for one address that is not signed in is reached, so it did not ask the Interego relay');
    expect(relayed('/mcp') - signs).toBe(4);
    // A token the relay refused is refused again from memory, from any address, and never sent to the relay again.
    expect([(await sign(made[0] ?? '', '198.51.100.8')).code, relayed('/mcp') - signs]).toEqual(['interego-sign-in-expired', 4]);
    expect(lim.calls.filter((c) => c.authorization === `Bearer ${made[0] ?? ''}`)).toHaveLength(1);
    // Strangers from many addresses together spend only what is left for callers not signed in (8 - 2 - 4 = 2).
    const many: Signed[] = [];
    for (let i = 0; i < 6; i++) many.push(await sign(`other${i}${'B'.repeat(16)}`, `198.51.100.${20 + i}`));
    expect(many.map((r) => r.code)).toEqual(['interego-sign-in-expired', 'interego-sign-in-expired', ...Array<string>(4).fill('relay-busy')]);
    expect([many[2]?.status, Number(many[2]?.retry) > 0]).toEqual([429, true]);
    expect(relayed('/mcp') - signs).toBe(6);
    // The person signed in still signs, up to her own limit (5 a minute): the strangers spent none of it.
    const hers: Signed[] = [];
    for (let i = 0; i < 5; i++) hers.push(await sign(bearer, '203.0.113.1'));
    expect(hers.map((r) => r.status)).toEqual([200, 200, 200, 200, 429]);
    expect([hers[4]?.code, hers[4]?.error]).toEqual(['relay-calls-limited', expect.stringContaining('limit of 5 relay calls a minute for one sign-in')]);

    // A minute on. Made-up codes from one address: four exchanges (one call each) reach the relay's token endpoint, then the bridge refuses on its own.
    clock += 61_000;
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    const tokens = relayed('/token');
    const codes: (readonly [number, unknown])[] = [];
    for (let i = 0; i < 6; i++) codes.push(await exchange(madeUp(i), '198.51.100.7'));
    expect(codes).toEqual([...Array<readonly [number, string]>(4).fill([400, 'oauth-code-refused']), [429, 'relay-calls-limited'], [429, 'relay-calls-limited']]);
    expect(relayed('/token') - tokens).toBe(4);
    // Another minute: that address has one exchange left of its five in 15 minutes, and the bridge seven in all (the person's, four, this one, and one more).
    clock += 61_000;
    const later: (readonly [number, unknown])[] = [];
    for (const [i, ip] of ['198.51.100.7', '198.51.100.7', '198.51.100.9', '198.51.100.9'].entries()) later.push(await exchange(madeUp(10 + i), ip));
    expect(later).toEqual([[400, 'oauth-code-refused'], [429, 'relay-calls-limited'], [400, 'oauth-code-refused'], [429, 'relay-busy']]);
    expect(relayed('/token') - tokens).toBe(6);
    // So strangers can delay a new sign-in: a real code is refused before the relay is asked anything, with the wait the 15-minute budget leaves.
    const asked = lim.calls.length;
    const delayed = await exchangeDirect(l, lim, from('203.0.113.2'), 'u-pk-0000000000d2');
    expect([delayed.status, delayed.json['iep:refusalReason'], Number(delayed.json['retryAfterSeconds']) > 60]).toEqual([429, 'relay-busy', true]);
    expect(String(delayed.json['error'])).toContain('(7 code exchanges every 15 minutes in all)');
    expect(lim.calls.length).toBe(asked);
    // The person already signed in goes on signing all the while.
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    // Once the 15 minutes have passed, a new sign-in goes through and signs.
    clock += 15 * 60_000;
    const done = await exchangeDirect(l, lim, from('203.0.113.2'), 'u-pk-0000000000d2');
    expect([done.status, typeof done.json['accessToken']]).toEqual([200, 'string']);
    expect((await sign(String(done.json['accessToken']), '203.0.113.2')).status).toBe(200);
    expect([relayed('/identity-token'), lim.calls.filter((c) => c.url.startsWith(`${RELAY}/tool/`)).length]).toEqual([0, 0]);
  });

  it('strangers cannot spend the relay\'s token endpoint: made-up codes from any number of addresses reach it at most 30 times in 15 minutes, under its 50, while a person signed in signs on', async () => {
    let clock = Date.now();
    const t0 = clock;
    // The relay's own limit on its token endpoint, as its OAuth router keeps it for one address: 50 every 15 minutes, then 429.
    const lim = stubRelay({ cimd: true, tokenLimit: 50 });
    const l = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: lim.fetchFn, now: () => clock }, { trustProxy: true });
    const { relayed, sign, exchange, madeUp } = limitMoves(l, lim);
    const ex = await exchangeDirect(l, lim, from('203.0.113.1'));
    expect(ex.status).toBe(200);
    const bearer = String(ex.json['accessToken']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    // Every minute for ten minutes, 20 strangers, each from an address of its own, post a made-up code; she signs once a minute all the while.
    const minutes: (readonly [number, number, number])[] = [];
    let n = 0;
    for (let minute = 0; minute < 10; minute++) {
      const got = [];
      for (let i = 0; i < 20; i++) got.push(await exchange(madeUp(n++), `198.51.${minute}.${i + 1}`));
      expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
      minutes.push([got.filter(([s]) => s === 400).length, got.filter(([s, c]) => s === 429 && c === 'relay-busy').length, got.length]);
      clock += 61_000;
    }
    // The first minute, what callers not signed in may (20, of which her sign-in took 2); the second, the rest of the 30 exchanges every 15 minutes; then none.
    expect(minutes).toEqual([[18, 2, 20], [11, 9, 20], ...Array<readonly [number, number, number]>(8).fill([0, 20, 20])]);
    expect(relayed('/token')).toBe(30);
    expect(lim.tokenRefusals()).toBe(0);
    // A new person is delayed meanwhile (what strangers can still do), told how long, and the relay is asked nothing for her.
    const asked = lim.calls.length;
    const delayed = await exchangeDirect(l, lim, from('203.0.113.2'), 'u-pk-0000000000d3');
    expect([delayed.status, delayed.json['iep:refusalReason'], Number(delayed.json['retryAfterSeconds'])]).toEqual([429, 'relay-busy', Math.ceil((t0 + 15 * 60_000 - clock) / 1000)]);
    expect(lim.calls.length).toBe(asked);
    // Once the bridge's 15 minutes are over she signs in: the relay's own token budget was never spent.
    clock = t0 + 15 * 60_000 + 1_000;
    const done = await exchangeDirect(l, lim, from('203.0.113.2'), 'u-pk-0000000000d3');
    expect([done.status, relayed('/token'), lim.tokenRefusals()]).toEqual([200, 31, 0]);
    expect((await sign(String(done.json['accessToken']), '203.0.113.2')).status).toBe(200);
  });

  it('keeps each person signed in on budgets of their own: one account\'s three tokens at their full rate, other accounts at theirs and strangers spending all they may leave another person signing on', async () => {
    const clock = Date.now();
    const lim = stubRelay({ cimd: true });
    const l = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: lim.fetchFn, now: () => clock }, { trustProxy: true });
    const { sign } = limitMoves(l, lim);
    const ok = (rs: readonly Signed[]): number => rs.filter((r) => r.status === 200).length;
    // She signs in through this bridge and signs once.
    const ex = await exchangeDirect(l, lim, from('203.0.113.1'));
    expect(ex.status).toBe(200);
    const bearer = String(ex.json['accessToken']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);

    // Anyone can make an Interego account. This one holds three tokens: one from this bridge's own sign-in, one from the relay directly, and one
    // for another client (its agent is claude-…, the same person on the identity host); the last two are taken here by one sign each.
    const ACCOUNT = 'u-pk-a77acce0a77a';
    const own = await exchangeDirect(l, lim, from('198.51.100.66'), ACCOUNT);
    const a1 = String(own.json['accessToken']);
    const a2 = lim.mint(ACCOUNT);
    const a3 = lim.mint(ACCOUNT, 'Claude');
    expect([own.status, (await sign(a2, '198.51.100.66')).status, (await sign(a3, '198.51.100.66')).status]).toEqual([200, 200, 200]);
    // Each token signs at its full rate, 20 a minute: the account has 40 a minute over all its sign-ins (a1's first sign, which named the
    // person, counted for that sign-in alone), and the rest is refused as that person's own limit.
    const theirs: Signed[] = [];
    for (const t of [a1, a2, a3]) for (let i = 0; i < 20; i++) theirs.push(await sign(t, '198.51.100.66'));
    expect([ok(theirs), theirs.slice(41).map((r) => r.code)]).toEqual([41, Array<string>(19).fill('relay-calls-limited')]);
    expect(theirs[41]?.error).toContain('limit of 40 relay calls a minute for one person, over all their sign-ins is reached');
    // Two more accounts, two tokens each, at their full rate: every call goes through, far past the 50 a minute in all the bridge once
    // counted every signed-in call against.
    const others: Signed[] = [];
    for (const [i, account] of ['u-pk-b0b0b0b0b0b0', 'u-pk-c0c0c0c0c0c0'].entries()) {
      const tokens = [lim.mint(account), lim.mint(account)];
      for (const t of tokens) expect((await sign(t, `198.51.100.${67 + i}`)).status).toBe(200);
      for (const t of tokens) for (let k = 0; k < 20; k++) others.push(await sign(t, `198.51.100.${67 + i}`));
    }
    expect(ok(others)).toBe(80);
    // Strangers from many addresses spend what callers not signed in may (20 a minute, of which 9 are spent: her sign-in's two calls,
    // a1's exchange, and the six signs that took tokens here), and are then refused by the bridge alone.
    const strangers: Signed[] = [];
    for (let i = 0; i < 14; i++) strangers.push(await sign(`stranger${i}${'D'.repeat(20)}`, `198.51.100.${100 + i}`));
    expect(strangers.map((r) => r.code)).toEqual([...Array<string>(11).fill('interego-sign-in-expired'), 'relay-busy', 'relay-busy', 'relay-busy']);
    // She signs on, at her full rate, all the while: 20 in the minute, then her own limit, as one sign-in.
    const mine: Signed[] = [];
    for (let i = 0; i < 20; i++) mine.push(await sign(bearer, '203.0.113.1'));
    expect([ok(mine), mine[19]?.code]).toEqual([19, 'relay-calls-limited']);
    expect(mine[19]?.error).toContain('limit of 20 relay calls a minute for one sign-in is reached');
    // In that one minute the relay signed 1 + 2 + 41 + 4 + 80 + 19 = 147 times through the bridge.
    expect(lim.signed()).toBe(147);
    expect(callsTo(lim, '/token')).toHaveLength(2);
  }, SLOW);

  it('runs only so many relay calls at once: at most two for one person, a pool for people signed in that callers not signed in never touch, and a smaller one for those callers, each refused 429 before the relay is asked', async () => {
    const lim = stubRelay({ cimd: true });
    const l = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: lim.fetchFn, limits: { perPersonAtOnce: 2, signedInAtOnce: 4, unprovenAtOnce: 2 } }, { trustProxy: true });
    const { sign } = limitMoves(l, lim);
    const ex = await exchangeDirect(l, lim, from('203.0.113.1'));
    const bearer = String(ex.json['accessToken']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    const a = ['u-pk-a77acce0a77a', 'u-pk-a77acce0a77a', 'u-pk-a77acce0a77a', 'u-pk-b0b0b0b0b0b0', 'u-pk-b0b0b0b0b0b0'].map((u) => lim.mint(u));
    for (const t of a) expect((await sign(t, '198.51.100.66')).status).toBe(200);
    const heldUntil = async (want: number): Promise<void> => {
      for (let i = 0; lim.held() < want; i++) {
        if (i > 400) throw new Error(`the relay holds ${lim.held()} calls, not ${want}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const release = lim.hold();
    // One person: two calls at once reach the relay, a third is refused as that person's own limit.
    const running = [sign(a[0] ?? '', '198.51.100.66'), sign(a[1] ?? '', '198.51.100.66')];
    await heldUntil(2);
    const third = await sign(a[2] ?? '', '198.51.100.66');
    expect([third.status, third.code, third.retry, third.header]).toEqual([429, 'relay-calls-limited', 1, '1']);
    expect(third.error).toContain('at most 2 relay calls at once for one person');
    // Another person and she still get theirs, up to the pool for people signed in (four here).
    running.push(sign(a[3] ?? '', '198.51.100.67'), sign(bearer, '203.0.113.1'));
    await heldUntil(4);
    const full = await sign(a[4] ?? '', '198.51.100.67');
    expect([full.status, full.code]).toEqual([429, 'relay-busy']);
    expect(full.error).toContain('at most 4 relay calls at once for people signed in');
    // Callers not signed in have places of their own (two here), which the signed-in pool being full does not take away, and are refused beyond them.
    running.push(sign(`stranger0${'E'.repeat(20)}`, '198.51.100.90'), sign(`stranger1${'E'.repeat(20)}`, '198.51.100.91'));
    await heldUntil(6);
    const stranger = await sign(`stranger2${'E'.repeat(20)}`, '198.51.100.92');
    expect([stranger.status, stranger.code]).toEqual([429, 'relay-busy']);
    expect(stranger.error).toContain('at most 2 relay calls at once for callers the relay has not accepted here');
    expect(lim.held()).toBe(6);
    release();
    expect((await Promise.all(running)).map((r) => r.code ?? r.status)).toEqual([200, 200, 200, 200, 'interego-sign-in-expired', 'interego-sign-in-expired']);
    // Each place is given back when its call ends.
    expect([(await sign(a[2] ?? '', '198.51.100.66')).status, (await sign(a[4] ?? '', '198.51.100.67')).status, (await sign(bearer, '203.0.113.1')).status]).toEqual([200, 200, 200]);
  });

  it('the DID-document read ends at its deadline, a slow DNS look-up included, and the request after the look-up is aborted', async () => {
    const dns = createRequire(import.meta.url)('node:dns/promises') as { lookup: (...a: unknown[]) => Promise<unknown> };
    const real = dns.lookup;
    let lookedUp = 0;
    dns.lookup = async (): Promise<unknown> => { await new Promise((r) => setTimeout(r, 1_000)); lookedUp++; return [{ address: '93.184.216.34', family: 4 }]; };
    syncBuiltinESMExports();
    const reached: string[] = [];
    try {
      const get = didDocumentFetch((async (_u: unknown, init?: RequestInit) => {
        reached.push(init?.signal?.aborted === true ? 'aborted' : 'live');
        return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
      }) as unknown as typeof fetch, { timeoutMs: 200 });
      const t0 = Date.now();
      await expect(get('https://identity.slow-dns.test/agents/claude-u-pk-1/did.json')).rejects.toThrow('the identity host gave no answer within 200 ms');
      expect(Date.now() - t0).toBeLessThan(900);
      expect(lookedUp).toBe(0);
      // The look-up answers later; the request it then starts carries a signal the deadline aborted.
      await new Promise((r) => setTimeout(r, 1_200));
      expect([lookedUp, reached]).toEqual([1, ['aborted']]);
    } finally {
      dns.lookup = real;
      syncBuiltinESMExports();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The page, driven
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the web UI signs a person in with their Interego account and has the relay sign every act', () => {
  it('button → the relay with PKCE and a state → callback → exchange → acts the bridge reads as relay-delegated → sign-out', async () => {
    // The relay answers /mcp as Server-Sent Events until the act below, which it answers as JSON.
    relay.state.answerAs = 'sse';
    const relayCallsBefore = relay.calls.length;
    // ── The button: the relay's authorize URL, with a PKCE S256 challenge of a verifier only this tab holds.
    const p1 = await openPage(bridge, '/ui');
    await p1.until(() => p1.q('article.scenario'), 'the scenarios');
    expect(p1.text('#acting-as')).toBe('whoever signs (paste mode)');
    const to = await pressSignIn(p1);
    const pending = JSON.parse(p1.session(PENDING_KEY) ?? 'null') as { verifier: string; state: string; back: string };
    const q = (k: string): string | null => to.searchParams.get(k);
    expect([to.origin, to.pathname, q('response_type'), q('client_id'), q('redirect_uri'), q('code_challenge_method'), q('scope'), q('resource')])
      .toEqual([RELAY, '/authorize', 'code', `${DEPLOY}/ui/oauth/client.json`, `${DEPLOY}/ui/oauth/callback`, 'S256', 'mcp', `${RELAY}/`]);
    expect(q('code_challenge')).toBe(b64url(createHash('sha256').update(pending.verifier).digest()));
    expect([pending.verifier.length >= 43, pending.state.length >= 16, q('state')]).toEqual([true, true, pending.state]);
    expect(to.href).not.toContain(pending.verifier);
    expect(p1.session(SESSION_KEY)).toBeNull();

    // ── The relay signs the person in and sends the browser back to the callback with a code.
    const back = await relay.signIn(to.href, deployed);
    const code = new URL(back).searchParams.get('code')!;
    const callbackPath = back.slice(DEPLOY.length);
    const shell = await (await fetch(`${bridge.base}${callbackPath}`)).text();
    expect(shell).not.toContain(code);
    expect(shell).toContain('<script type="module" src="../../ui/app.js"></script>');
    const callbackRes = await fetch(`${bridge.base}${callbackPath}`);
    expect(callbackRes.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(callbackRes.headers.get('referrer-policy')).toBe('no-referrer');

    const p2 = await openPage(bridge, callbackPath, sessionOf(p1));
    const agent = `did:web:${IDH}:agents:${WEB_UI_AGENT_PREFIX}${USER}`;
    await p2.until(() => p2.text('#acting-as') === `Signed in as ${PRINCIPAL} via ${agent}`, 'the signed-in principal and agent');
    // The code left the address bar first; the page is /ui again, on the view it left from.
    expect([p2.w.location.pathname, p2.w.location.search, p2.w.location.hash]).toEqual(['/ui', '', pending.back]);
    expect((p2.q('#interego-did') as HTMLInputElement).value).toBe(PRINCIPAL);
    // The relay's access token, and when it expires, are in this tab's sessionStorage only; the verifier and the state are gone.
    const kept = JSON.parse(p2.session(SESSION_KEY) ?? 'null') as { accessToken: string; at: number; expiresAt: number };
    const bearer = kept.accessToken;
    expect(Object.keys(kept).sort()).toEqual(['accessToken', 'at', 'expiresAt']);
    expect(bearer).toBe(relay.issued.at(-1));
    expect(kept.expiresAt - kept.at > 3_590_000 && kept.expiresAt - kept.at <= 3_600_000).toBe(true);
    // The tab will forget it at that expiry: one timer, set for it.
    expect(p2.long.map((t) => t.ms > 3_590_000 && t.ms <= 3_600_000)).toEqual([true]);
    expect(p2.session(PENDING_KEY)).toBeNull();
    expect(p2.w.localStorage.length).toBe(0);
    const exchange = relay.calls.filter((c) => c.url === `${RELAY}/token`).at(-1)!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBe(pending.verifier);
    // Every relay call carried the bearer in its Authorization header and nowhere else; the page's
    // who-am-I was a signed read through /mcp (the bridge's own answer names the principal).
    expect(relay.calls.every((c) => !c.url.includes(bearer) && !c.body.includes(bearer) && !c.url.includes(code))).toBe(true);
    expect(callsTo(relay, '/mcp').at(-1)?.authorization).toBe(`Bearer ${bearer}`);
    // The sign route answers with the relay's two fields and nothing else the relay said.
    relay.state.answerAs = 'json';
    const direct = await fetch(`${bridge.base}/ui/relay/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ payload: { v: 1, action: PEV_ACTION.getAttempt, nonce: nonce(), podUrl: DEMO_POD } }),
    });
    const signedBody = (await direct.json()) as Out;
    expect([direct.status, Object.keys(signedBody).sort()]).toEqual([200, ['_signature', '_signed_payload']]);
    expect(JSON.parse(String(signedBody['_signed_payload']))).toMatchObject({ action: PEV_ACTION.getAttempt, pod_url: DEMO_POD, agent_id: `did:web:${IDH}:agents:${WEB_UI_AGENT_PREFIX}${USER}` });
    expect(JSON.stringify(signedBody)).not.toContain(bearer);
    // The page's relay calls went through this bridge's own routes (its fetch reaches only the bridge).
    expect(p2.asked.filter((x) => x.includes('/ui/oauth/') || x.includes('/ui/relay/'))).toEqual(expect.arrayContaining(['POST /ui/oauth/exchange', 'POST /ui/relay/sign']));

    // ── An act: the learner starts an attempt, signed by the relay for her web UI agent.
    const card = await p2.until(() => p2.q('article.scenario'), 'the scenario card');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    await p2.until(() => p2.q('#line') ?? p2.q('#view .refusal'), 'the conversation');
    expect(p2.q('#line')).not.toBeNull();
    const attemptIri = decodeURIComponent(p2.w.location.hash.slice('#/attempt/'.length));
    const head = await readHead(DEMO_POD, attemptIri, TRUSTED, pod.fetchFn);
    expect(head.head !== null && isTrusted(head.head)).toBe(true);
    const a = head.head!.body as Extract<PevRecordBody, { kind: 'attempt' }>;
    expect(a.learner).toMatchObject({ address: PRINCIPAL, did: PRINCIPAL });
    expect(a.startEnvelope).toMatchObject({ form: 'signed-request', authority: 'relay-delegated', principal: PRINCIPAL, agentId: agent, relaySigner: RELAY_KEY.address.toLowerCase() });

    // ── A decisive act from the web UI's own agent: the admin (by DID) gives another person a role.
    relay.state.answerAs = 'sse';
    p2.w.location.hash = '#/roles';
    await p2.until(() => p2.q(`button[data-action="${PEV_ACTION.registerRole}"]`), 'the roles form');
    const field = p2.q('input[aria-label="Address"]') as HTMLInputElement;
    field.value = OTHER;
    p2.q(`button[data-action="${PEV_ACTION.registerRole}"]`)!.click();
    await p2.until(() => p2.q('#view .outcome table') ?? p2.q('#view .refusal'), 'the registry');
    expect([...p2.w.document.querySelectorAll('#view .outcome tr')].some((tr) => (tr.textContent ?? '').includes(OTHER))).toBe(true);
    expect(p2.errors).toEqual([]);

    // ── Sign-out: the token leaves the tab, the page says plainly that nothing was revoked, and the next act is not signed by the relay.
    const signs = callsTo(relay, '/mcp').length;
    p2.q('#interego-sign-out')!.click();
    await p2.until(() => p2.text('#acting-as') === 'whoever signs (paste mode)', 'paste mode again');
    expect([p2.session(SESSION_KEY), p2.q('#interego-did'), p2.q('#interego-sign-in')?.textContent]).toEqual([null, null, 'Sign in with your Interego account']);
    const out = p2.text('#interego-signed-out');
    for (const says of ['Nothing was revoked', 'offers no way to revoke', 'until it expires', 'whoever has a copy can call the relay\'s tools as you', 'keeps no copy']) expect(out).toContain(says);
    expect(p2.long.length).toBe(1);
    p2.long[0]?.fire();
    expect(p2.text('#signing')).not.toContain('has ended');
    p2.w.location.hash = '#/mine';
    await p2.until(() => p2.q('#signing textarea[readonly]'), 'the paste signing panel');
    expect(callsTo(relay, '/mcp').length).toBe(signs);
    expect(p2.errors).toEqual([]);
    // Every act was a tools/call at /mcp with the access token: no /identity-token, no /tool/.
    const used = new Set(relay.calls.slice(relayCallsBefore).map((c) => `${c.method} ${new URL(c.url).pathname}`));
    expect([used.has('POST /token'), used.has('POST /mcp')]).toEqual([true, true]);
    expect([...used].filter((x) => !['GET /.well-known/oauth-authorization-server', 'POST /token', 'POST /mcp'].includes(x))).toEqual([]);
  }, SLOW);

  it('forgets the access token at its expiry: one past it is dropped when the page loads, and the timer drops one that expires while the page is open', async () => {
    const ex = await exchangeDirect(bridge, relay);
    const token = String(ex.json['accessToken']);
    // Kept past its expiry: dropped on load, said so, and never sent.
    const stale = await openPage(bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ accessToken: token, at: Date.now() - 3_700_000, expiresAt: Date.now() - 100_000 }) });
    await stale.until(() => stale.q('article.scenario'), 'the scenarios');
    expect([stale.text('#acting-as'), stale.session(SESSION_KEY), stale.text('#signing').includes('has ended')]).toEqual(['whoever signs (paste mode)', null, true]);
    // Kept in an older shape with no expiry, or claiming to last past an hour: dropped the same way.
    for (const kept of [{ bearer: token, at: Date.now() }, { accessToken: token, at: Date.now(), expiresAt: Date.now() + 2 * 3_600_000 }]) {
      const p = await openPage(bridge, '/ui', { [SESSION_KEY]: JSON.stringify(kept) });
      await p.until(() => p.q('article.scenario'), 'the scenarios');
      expect([p.text('#acting-as'), p.session(SESSION_KEY)]).toEqual(['whoever signs (paste mode)', null]);
      expect([...stale.asked, ...p.asked].filter((x) => x === 'POST /ui/relay/sign')).toEqual([]);
    }
    // Live: signed in, until its timer fires at the expiry.
    const p = await openPage(bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ accessToken: token, at: Date.now(), expiresAt: Date.now() + 3_600_000 }) });
    const agent = `did:web:${IDH}:agents:${WEB_UI_AGENT_PREFIX}${USER}`;
    await p.until(() => p.text('#acting-as') === `Signed in as ${PRINCIPAL} via ${agent}`, 'the signed-in principal and agent');
    expect(p.text('#bar')).toContain('This tab holds the relay\'s access token for this sign-in until');
    expect(p.long.map((t) => t.ms > 3_590_000 && t.ms <= 3_600_000)).toEqual([true]);
    const signsBefore = p.asked.filter((x) => x === 'POST /ui/relay/sign').length;
    p.long[0]?.fire();
    await p.until(() => p.text('#acting-as') === 'whoever signs (paste mode)', 'paste mode at the expiry');
    expect([p.session(SESSION_KEY), p.text('#signing').includes('Your Interego sign-in has ended')]).toEqual([null, true]);
    await p.until(() => p.q('article.scenario'), 'the scenarios again');
    expect(p.asked.filter((x) => x === 'POST /ui/relay/sign').length).toBe(signsBefore);
    expect([...stale.errors, ...p.errors]).toEqual([]);
  }, SLOW);

  it('an answer that does not carry the state this tab sent is refused: no exchange, nothing kept, and the sign-in the tab started still waits', async () => {
    const p1 = await openPage(bridge, '/ui');
    await p1.until(() => p1.q('article.scenario'), 'the scenarios');
    const to = await pressSignIn(p1);
    const pending = p1.session(PENDING_KEY);
    const back = new URL(await relay.signIn(to.href, deployed));
    back.searchParams.set('state', 'A'.repeat(32));
    const tokens = relay.calls.filter((c) => c.url === `${RELAY}/token`).length;
    const p2 = await openPage(bridge, back.href.slice(DEPLOY.length), sessionOf(p1));
    await p2.until(() => p2.text('#signing').includes('did not carry the state this tab sent'), 'the state refusal');
    await p2.until(() => p2.q('article.scenario'), 'the scenarios');
    expect([p2.w.location.pathname, p2.w.location.search]).toEqual(['/ui', '']);
    expect([p2.session(SESSION_KEY), p2.session(PENDING_KEY), p2.text('#acting-as')]).toEqual([null, pending, 'whoever signs (paste mode)']);
    expect(p2.asked.filter((x) => x.includes('/ui/oauth/exchange'))).toEqual([]);
    expect(relay.calls.filter((c) => c.url === `${RELAY}/token`).length).toBe(tokens);
    // With no pending sign-in in the tab at all, an answer is refused the same way.
    const p3 = await openPage(bridge, back.href.slice(DEPLOY.length));
    await p3.until(() => p3.text('#signing').includes('did not start a sign-in'), 'the unexpected-answer refusal');
    expect(p3.session(SESSION_KEY)).toBeNull();
    expect([...p2.errors, ...p3.errors]).toEqual([]);
  }, SLOW);

  it('shows an error the relay sent only for the sign-in this tab started: a link anyone made, with no state or another, shows none of its text and drops nothing', async () => {
    const p1 = await openPage(bridge, '/ui');
    await p1.until(() => p1.q('article.scenario'), 'the scenarios');
    await pressSignIn(p1);
    const pending = p1.session(PENDING_KEY);
    const state = (JSON.parse(pending ?? 'null') as { state: string }).state;
    const planted = 'Account locked. Call support at +1 555 0100 and read them your code.';
    for (const query of [`?error=${encodeURIComponent(planted)}`, `?error=${encodeURIComponent(planted)}&state=${'B'.repeat(32)}`]) {
      const p = await openPage(bridge, `/ui/oauth/callback${query}`, sessionOf(p1));
      await p.until(() => p.text('#signing').includes('did not carry the state this tab sent'), 'the state refusal');
      expect(p.text('#signing')).not.toContain('Account locked');
      expect([p.session(PENDING_KEY), p.w.location.search]).toEqual([pending, '']);
      // Nor with no sign-in pending at all.
      const none = await openPage(bridge, `/ui/oauth/callback${query}`);
      await none.until(() => none.text('#signing').includes('did not start a sign-in'), 'the unexpected-answer refusal');
      expect(none.text('#signing')).not.toContain('Account locked');
      expect([...p.errors, ...none.errors]).toEqual([]);
    }
    // The relay's own answer to this tab's sign-in: its error is shown, and the sign-in is over.
    const answer = await openPage(bridge, `/ui/oauth/callback?error=access_denied&state=${state}`, sessionOf(p1));
    await answer.until(() => answer.text('#signing').includes('the relay answered "access_denied"'), 'the relay\'s error');
    expect([answer.session(PENDING_KEY), answer.session(SESSION_KEY), answer.errors]).toEqual([null, null, []]);
  }, SLOW);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  server.ts: the client address the limits count by
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Start bridge/server.ts, as the image runs it, with nothing in its environment but `extra` (on
 * loopback, port 0); once it says it is listening it is stopped. `started` says whether it got that far.
 */
function startServer(extra: Record<string, string>): Promise<{ status: number | null; started: boolean; out: string; err: string }> {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const server = fileURLToPath(new URL('../bridge/server.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', server], {
      cwd: repo, env: { NODE_NO_WARNINGS: '1', PORT: '0', HOST: '127.0.0.1', ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let started = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (!started && out.includes('listening on 127.0.0.1:0')) { started = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', (chunk: string) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, started, out, err }); });
  });
}

describe('server.ts: the client address the web UI\'s sign-in limits count by', () => {
  it('trusts one proxy hop off loopback and none on it unless PEV_TRUST_PROXY_HOPS names 0 to 4, keeps the host guard first, stops on any other value, and says which address it counts by', async () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(server).toContain("const proxyHopsValue = env('PEV_TRUST_PROXY_HOPS');");
    expect(server).toContain('const proxyHops = proxyHopsValue !== undefined ? Number(proxyHopsValue) : loopback ? 0 : 1;');
    expect(server).toMatch(/if \(proxyHopsValue !== undefined && !\/\^\[0-4\]\$\/\.test\(proxyHopsValue\)\) \{\n[^\n]*PEV_TRUST_PROXY_HOPS is [^\n]*Not listening\.`\);\n\s*process\.exitCode = 1;\n\s*return;/);
    // The host guard is the hook's first statement, so it stands in front of every route mounted after it; the proxy hops come next.
    expect(server).toMatch(/middleware: \(a\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(loopback\) a\.use\(hostAllowlistGuard\(allowedHosts\)\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(proxyHops > 0\) a\.set\('trust proxy', proxyHops\);\n/);
    expect(server.match(/trust proxy/g)).toHaveLength(1);
    // The web UI's sign-in names the person a token signs for with the handlers' own policy, and so through the same DID-document cache.
    expect(server).toContain('...(relayDelegation !== undefined ? { relayDelegation, adminDids } : {}),');
    expect(server).toContain('relayFetch: relayCallFetch(baseFetch, { privateRelay: relayIsLoopback }), ...(relayDelegation !== undefined ? { relayDelegation } : {})');

    const signIn = { PEV_TRUSTED_RELAY_ADDRESSES: '0x276e11d2229d3a96dc96356c15c03c7f83201ebc', PEV_IDENTITY_HOST: 'identity.interego.xwisee.com', PEV_RELAY_URL: 'https://relay.interego.xwisee.com' };
    const cases: readonly (readonly [Record<string, string>, string | null, string | null])[] = [
      [signIn, null, 'web UI sign-in limits count each caller by the address that connects to the bridge (no proxy hop trusted on loopback); behind a reverse proxy every caller is the proxy\'s address, so set PEV_TRUST_PROXY_HOPS to the hops in front'],
      [{ ...signIn, PEV_TRUST_PROXY_HOPS: '1' }, null, 'web UI sign-in limits count each caller by the address 1 proxy hop(s) in front saw (X-Forwarded-For; PEV_TRUST_PROXY_HOPS=1)'],
      [{ ...signIn, PEV_TRUST_PROXY_HOPS: 'yes' }, 'PEV_TRUST_PROXY_HOPS is "yes"; it takes how many proxies in front of the bridge set X-Forwarded-For (0 to 4), or unset for 1 off loopback and 0 on loopback. Not listening.', null],
      [{ PEV_TRUST_PROXY_HOPS: '5' }, 'PEV_TRUST_PROXY_HOPS is "5"', null],
    ];
    const runs = await Promise.all(cases.map(([extra]) => startServer(extra)));
    for (const [i, [extra, stops, says]] of cases.entries()) {
      const r = runs[i]!;
      if (stops !== null) expect([r.status, r.started, r.err], JSON.stringify(extra)).toEqual([1, false, expect.stringContaining(stops)]);
      else expect([r.started, r.out, r.err], JSON.stringify(extra)).toEqual([true, expect.stringContaining(says ?? ''), expect.not.stringContaining('Not listening')]);
    }
  }, SLOW);
});

describe('the relay\'s account-token routes', () => {
  it('no bridge in this file ever called /identity-token or /tool/ at the relay: every sign went to /mcp with the access token', () => {
    const all = allRelays.flatMap((r) => r.calls);
    expect(all.filter((c) => c.url.startsWith(`${RELAY}/mcp`)).length).toBeGreaterThan(20);
    expect(all.filter((c) => /^\/(identity-token|tool\/)/.test(new URL(c.url).pathname)).map((c) => `${c.method} ${c.url}`)).toEqual([]);
  });
});
