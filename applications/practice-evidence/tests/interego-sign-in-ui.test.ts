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
/**
 * The stylesheet as a screen `px` wide applies it, for jsdom, which lays nothing out and applies an `@media screen` rule but
 * no width query: each min-width or max-width query (every one this stylesheet has is in em, alone) is kept, as `screen`,
 * where that width meets it, and set aside, as `print`, where it does not. Real Chromium from 300 px up is the QA's check.
 */
const atWidth = (css: string, px: number): string =>
  css.replace(/@media \((min|max)-width: ([\d.]+)em\)/g, (_m, k: string, em: string) => `@media ${(k === 'min' ? px >= Number(em) * 16 : px <= Number(em) * 16) ? 'screen' : 'print'}`);

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
async function serve(interego: InteregoUiOptions | undefined, o: { readonly trustProxy?: boolean; readonly handlers?: Handlers } = {}): Promise<TestListener> {
  const allowed: string[] = [];
  const app: Express = createVerticalBridge({
    verticalName: 'practice-evidence', affordances: pevAffordances, handlers: o.handlers ?? handlers, deploymentUrl: 'http://127.0.0.1:6110', defaultPodUrl: DEMO_POD,
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
  all(sel: string): HTMLElement[];
  text(sel: string): string;
  session(k: string): string | null;
}

/** The page at `path`, its fetch reaching the bridge, `session` copied into its sessionStorage first, `setup` run before the client. */
async function openPage(l: TestListener, path: string, session: Record<string, string> = {}, setup?: (w: JSDOM['window']) => void): Promise<Page> {
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
  setup?.(w);
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
    all: (sel) => [...d.querySelectorAll<HTMLElement>(sel)],
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
  expect(btn.textContent).toBe('Sign in with Interego');
  btn.click();
  const link = await p.until(() => p.q('#interego-continue') as HTMLAnchorElement | null, 'the link to the relay');
  await p.until(() => p.errors.includes(NAVIGATION), 'the navigation to the relay');
  expect(p.errors.filter((e) => e !== NAVIGATION)).toEqual([]);
  p.errors.length = 0;
  return new URL(link.href);
}

let nonceN = 0;
const nonce = (): string => `signin-ui-nonce-${String(++nonceN).padStart(8, '0')}`;
async function direct(tool: string, w: Wallet, action: string, fields: Out = {}, h: Handlers = handlers): Promise<Out> {
  return (await h[tool]!({ envelope: await signEnvelope(w, { v: 1, action, issuedAt: new Date().toISOString(), nonce: nonce(), podUrl: DEMO_POD, ...fields }) })) as Out;
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
  it('the callback page, like every page the bridge serves, has no inline script or style and loads nothing from another origin', async () => {
    const r = await fetch(`${bridge.base}/ui/oauth/callback?code=abc&state=def`);
    expect([r.status, r.headers.get('content-security-policy')]).toEqual([200, UI_CSP]);
    const html = await r.text();
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(html).not.toMatch(/\sstyle=|<style/i);
    expect(html).not.toMatch(/(?:src|<link[^>]+href)="(?:https?:)?\/\//i);
  });

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
  it('a signed-out visitor sees a welcome and the scenarios, not a refusal, and pressing Start asks them to sign in and sends nothing', async () => {
    const p = await openPage(bridge, '/ui');
    await p.until(() => p.q('#view .welcome') && p.q('article.scenario'), 'the welcome and the scenarios');
    expect(p.text('#view .welcome')).toContain('Welcome to Practice Evidence');
    expect(p.q('#view .welcome [data-sign-in="interego"]')).not.toBeNull();
    expect([p.q('#view .refusal'), p.text('#signing'), p.text('#acting-as')]).toEqual([null, '', 'Not signed in']);
    const posted = (): string[] => p.asked.filter((x) => x.startsWith('POST /pev/') && x !== 'POST /pev/sign_as_demo_role');
    expect([p.asked.filter((x) => x.includes('/ui/relay/sign')), posted()]).toEqual([[], []]);
    const card = p.q('article.scenario')!;
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    await p.until(() => p.q('#view .signin-needed'), 'the sign-in callout');
    expect([p.q('#signing textarea[readonly]'), posted(), p.asked.filter((x) => x.includes('/ui/relay/sign'))]).toEqual([null, [], []]);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('the sign-in screen sends the person to Interego from its own button', async () => {
    const p = await openPage(bridge, '/ui');
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    p.w.location.hash = '#/signin';
    const gate = await p.until(() => p.q('#view .auth'), 'the sign-in screen');
    expect(gate.textContent).toContain('Sign in to Practice Evidence');
    gate.querySelector<HTMLElement>('[data-sign-in="interego"]')!.click();
    await p.until(() => p.q('#interego-continue'), 'the link to the relay');
    await p.until(() => p.errors.includes(NAVIGATION), 'the navigation to the relay');
    expect(p.errors.filter((e) => e !== NAVIGATION)).toEqual([]);
  }, SLOW);

  it('button → the relay with PKCE and a state → callback → exchange → acts the bridge reads as relay-delegated → sign-out', async () => {
    // The relay answers /mcp as Server-Sent Events until the act below, which it answers as JSON.
    relay.state.answerAs = 'sse';
    const relayCallsBefore = relay.calls.length;
    // ── The button: the relay's authorize URL, with a PKCE S256 challenge of a verifier only this tab holds.
    const p1 = await openPage(bridge, '/ui');
    await p1.until(() => p1.q('article.scenario'), 'the scenarios');
    expect(p1.text('#acting-as')).toBe('Not signed in');
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
    await p2.until(() => p2.text('#acting-as') === `Signed in as ${USER} via the Practice Evidence web app`, 'the signed-in principal and agent');
    // The exact agent the relay signed for is kept, beside the plain words.
    expect(p2.text('#interego-agent')).toBe(agent);
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
    // This workspace signs people in with Interego, so Team asks for a Member ID (or a wallet address).
    expect(p2.text('#view .page-header')).toContain('Add people by their Member ID and choose their role.');
    expect(p2.text('label[for="member-id"]')).toBe('Member ID or wallet address');
    const field = p2.q('#member-id') as HTMLInputElement;
    expect(field.placeholder).toContain('did:web:');
    expect(p2.text('#member-id-hint')).toBe('Ask the person to copy it from their account menu.');
    const save = (): void => p2.q(`button[data-action="${PEV_ACTION.registerRole}"]`)!.click();
    const retype = (v: string): void => { field.value = v; field.dispatchEvent(new p2.w.Event('input')); };
    retype('   ');
    save();
    await p2.until(() => p2.q('#member-id-error'), 'the empty-field message');
    expect(p2.text('#member-id-error')).toBe('Enter their Member ID or wallet address.');
    retype('bob@example');
    expect(p2.q('#member-id-error')).toBeNull();
    save();
    await p2.until(() => p2.q('#member-id-error') ?? p2.q('#view .refusal'), 'the format message');
    expect(p2.text('#member-id-error')).toMatch(/^That isn't a Member ID or a wallet address\. Ask the person to copy their Member ID from their account menu/);
    retype(OTHER);
    p2.q(`button[data-action="${PEV_ACTION.registerRole}"]`)!.click();
    await p2.until(() => p2.q('#view .outcome table') ?? p2.q('#view .refusal'), 'the registry');
    expect([...p2.w.document.querySelectorAll('#view .outcome tr')].some((tr) => (tr.textContent ?? '').includes(OTHER))).toBe(true);
    expect(p2.errors).toEqual([]);

    // ── Sign-out: the token leaves the tab, the page says plainly that nothing was revoked, and the next act is not signed by the relay.
    const signs = callsTo(relay, '/mcp').length;
    p2.q('#interego-sign-out')!.click();
    await p2.until(() => p2.text('#acting-as') === 'Not signed in', 'paste mode again');
    expect([p2.session(SESSION_KEY), p2.q('#interego-did'), p2.q('#interego-sign-in')?.textContent]).toEqual([null, null, 'Sign in with Interego']);
    const out = p2.text('#interego-signed-out');
    for (const says of ['Nothing was revoked', 'offers no way to revoke', 'until it expires', 'whoever has a copy can call the relay\'s tools as you', 'keeps no copy']) expect(out).toContain(says);
    expect(p2.long.length).toBe(1);
    p2.long[0]?.fire();
    expect(p2.text('#signing')).not.toContain('has ended');
    // Signed out, a view that needs a signature shows the sign-in screen and sends nothing; signing
    // manually is one click from it, and only then does the page show the exact text to sign.
    p2.w.location.hash = '#/mine';
    await p2.until(() => p2.q('#view .auth'), 'the sign-in gate');
    expect(p2.q('#signing textarea[readonly]')).toBeNull();
    p2.q('#view [data-sign-in="manual"]')!.click();
    await p2.until(() => p2.q('#signing textarea[readonly]'), 'the manual signing panel');
    expect((JSON.parse(p2.text('#signing pre.json')) as Out)['action']).toBe(PEV_ACTION.getAttempt);
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
    expect([stale.text('#acting-as'), stale.session(SESSION_KEY), stale.text('#signing').includes('has ended')]).toEqual(['Not signed in', null, true]);
    // Kept in an older shape with no expiry, or claiming to last past an hour: dropped the same way.
    for (const kept of [{ bearer: token, at: Date.now() }, { accessToken: token, at: Date.now(), expiresAt: Date.now() + 2 * 3_600_000 }]) {
      const p = await openPage(bridge, '/ui', { [SESSION_KEY]: JSON.stringify(kept) });
      await p.until(() => p.q('article.scenario'), 'the scenarios');
      expect([p.text('#acting-as'), p.session(SESSION_KEY)]).toEqual(['Not signed in', null]);
      expect([...stale.asked, ...p.asked].filter((x) => x === 'POST /ui/relay/sign')).toEqual([]);
    }
    // Live: signed in, until its timer fires at the expiry.
    const p = await openPage(bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ accessToken: token, at: Date.now(), expiresAt: Date.now() + 3_600_000 }) });
    const agent = `did:web:${IDH}:agents:${WEB_UI_AGENT_PREFIX}${USER}`;
    await p.until(() => p.text('#acting-as') === `Signed in as ${USER} via the Practice Evidence web app`, 'the signed-in principal and agent');
    expect(p.text('#interego-agent')).toBe(agent);
    expect(p.text('#bar')).toContain('This tab holds the relay\'s access token for this sign-in until');
    expect(p.long.map((t) => t.ms > 3_590_000 && t.ms <= 3_600_000)).toEqual([true]);
    const signsBefore = p.asked.filter((x) => x === 'POST /ui/relay/sign').length;
    p.long[0]?.fire();
    await p.until(() => p.text('#acting-as') === 'Not signed in', 'paste mode at the expiry');
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
    expect([p2.session(SESSION_KEY), p2.session(PENDING_KEY), p2.text('#acting-as')]).toEqual([null, pending, 'Not signed in']);
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Your own AI assistant: the Connect dialog, the chat hand-off and the messages a person copies
// ═════════════════════════════════════════════════════════════════════════════════════════════

function ok(r: Out): Out {
  expect(r['kind'], `expected success, got ${JSON.stringify(r).slice(0, 600)}`).toBeUndefined();
  return r;
}

/** The same pod, platform key and relay policy as `handlers`, with no model: the live service's shape. */
const noModelHandlers = createPevHandlers({
  platformWallet: PLATFORM, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address], adminDids: [PRINCIPAL],
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110',
  relayDelegation: POLICY, relayUrl: RELAY,
} satisfies PevDeps) as Handlers;

/** The text a person sees: closed disclosures, dialogs that are not open, menus, hidden text and what people or an AI wrote, left out. */
function shownText(root: Element | null): string {
  if (!root) return '';
  const c = root.cloneNode(true) as Element;
  for (const sel of ['details:not([open]) > :not(summary)', 'dialog:not([open])', '[popover]', '.visually-hidden', '[hidden]', 'option', '.chat__bubble', '.kv dd', 'q', '.card__title']) {
    for (const el of [...c.querySelectorAll(sel)]) el.remove();
  }
  return c.textContent ?? '';
}
const JARGON = /\b(pod|bridge|affordance|envelope|nonce|hypothetical|ratif\w*|countersign\w*|relay|payload|sign_payload)\b/i;
const CODES = /\b(EIP-191|IRI|DID)\b|HTTP \d{3}|urn:|https?:\/\//;
/**
 * What a copied prompt says for a chat app whose act tool shows no sign_payload, for the kinds of step it can lead to:
 * a prompt whose steps are all signed says how to sign one with sign_request, and one that can also lead to a plain
 * step (drafting a scenario, the workspace details) says, in the same sentence, to leave sign_payload out of it.
 */
const NO_OPTION = 'If your act tool has no sign_payload option, ';
const PLAIN_RULE = 'leave sign_payload out of a plain step\'s call (do not sign it or wrap it)';
const SIGNED_RULE = 'do a signed step in two calls: call the connector\'s sign_request tool '
  + 'with payload as its only argument, set to the step\'s payload, then call act with the same descriptor_url and action_iri and with payload set to exactly '
  + 'the _signature and _signed_payload it returned, unchanged';
const FALLBACK = { signed: `${NO_OPTION}${SIGNED_RULE}.`, both: `${NO_OPTION}${PLAIN_RULE}, and ${SIGNED_RULE}.` } as const;
const plain = (where: string, text: string): void => {
  expect([text.match(JARGON)?.[0] ?? null, text.match(CODES)?.[0] ?? null], where).toEqual([null, null]);
};

/** A signed-in page (the web UI's own agent) on `l`, its clipboard and its timers recorded. */
async function signedInPage(l: TestListener, extra?: (w: JSDOM['window']) => void): Promise<Page & { copied: string[]; intervals: number[] }> {
  const copied: string[] = [];
  const intervals: number[] = [];
  const p = await openPage(l, '/ui', { [SESSION_KEY]: JSON.stringify({ accessToken: relay.mint(USER), at: Date.now(), expiresAt: Date.now() + 3_600_000 }) }, (w) => {
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string): Promise<void> => { copied.push(t); } } });
    const realInterval = w.setInterval.bind(w);
    Object.assign(w, { setInterval: (fn: () => void, ms?: number): number => { intervals.push(Number(ms)); return realInterval(fn, ms); } });
    extra?.(w);
  });
  await p.until(() => p.text('#acting-as') === `Signed in as ${USER} via the Practice Evidence web app`, 'the signed-in person');
  return Object.assign(p, { copied, intervals });
}

/** Every learner step of Getting started, as the page words them for this person on this workspace. */
async function learnerSteps(p: Page): Promise<string> {
  await p.until(() => p.q('.checklist'), 'Getting started');
  p.all('.checklist button').find((b) => b.textContent === 'Show steps')?.click();
  p.all('.checklist button').find((b) => (b.textContent ?? '').startsWith('Show all'))?.click();
  await p.until(() => p.all('.checklist__item').length === 8, 'every learner step');
  return p.all('.checklist__text').map((x) => x.textContent).join('\n');
}

/**
 * One act a chat agent of a person's (Claude by default, through the relay) takes on its own, as the connector's act
 * would post it: by default the signed-in person's. `surface` names the chat app, whose agent the relay names after it.
 */
async function fromChat(h: Handlers, tool: string, action: string, fields: Out, user = USER, surface = 'claude'): Promise<Out> {
  const slug = `${surface}-${user}`;
  agentDocs.set(`https://${IDH}/agents/${slug}/did.json`, { '@context': ['https://www.w3.org/ns/did/v1'], id: `did:web:${IDH}:agents:${slug}`, controller: `did:web:${IDH}:users:${user}` });
  const sp = JSON.stringify({ v: 1, action, nonce: `chat-${nonce()}`, pod_url: DEMO_POD, ...fields, agent_id: `did:web:${IDH}:agents:${slug}`, subject_pod_url: `https://pods.ui.test/${user}/`, timestamp: new Date().toISOString() });
  return (await h[tool]!({ _signed_payload: sp, _signature: await signMessageRaw(RELAY_KEY, `sha256:${sha256Hex(sp)}`) })) as Out;
}

/** The numbered steps of a copied prompt, as actPrompt writes them: each step's action and payload template. */
function promptSteps(text: string): { readonly n: number; readonly say: string; readonly actionIri: string; readonly signed: boolean; readonly payload: Out }[] {
  const lines = text.split('\n');
  const out: { n: number; say: string; actionIri: string; signed: boolean; payload: Out }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^(\d+)\. (.*)$/.exec(lines[i]!);
    if (!head || !/^ {3}action_iri: "/.test(lines[i + 1] ?? '')) continue;
    out.push({
      n: Number(head[1]), say: head[2]!,
      actionIri: /^ {3}action_iri: "([^"]+)"$/.exec(lines[i + 1]!)![1]!,
      signed: (lines[i + 2] ?? '').startsWith('   sign_payload: true'),
      payload: JSON.parse((lines[i + 3] ?? '').replace(/^ {3}payload: /, '')) as Out,
    });
  }
  return out;
}

/** A refusal's code and status, from a handler's answer. */
const refusalOf = (r: Out): readonly [unknown, unknown] => [r['iep:refusalStatus'] ?? null, r['iep:refusalReason'] ?? null];

describe('your own AI assistant: connect Claude or ChatGPT, or copy and paste; never a key of ours', () => {
  let nm: TestListener;
  beforeAll(async () => { nm = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: relay.fetchFn }, { handlers: noModelHandlers }); }, SLOW);

  it('Connect your AI: each chat app\'s setup steps, the connector address and the workspace details to copy, in plain words; only for a person signed in with Interego', async () => {
    // The guide and the landing page show the connector address this workspace signs in through, as its Connect dialog does.
    const help = await (await fetch(`${nm.base}/ui/help`)).text();
    const landing = await (await fetch(`${nm.base}/`, { headers: { accept: 'text/html' } })).text();
    for (const page of [help, landing]) {
      // Written to break only between its parts on a phone (`/mcp` whole), the address itself unchanged.
      expect(page).toContain('<code>https://<wbr>relay<wbr>.ui<wbr>.test<wbr>/mcp</code>');
      expect(page).not.toContain('relay.interego.xwisee.com');
      expect(page).not.toContain('doesn\'t offer Interego sign-in');
    }
    const p = await signedInPage(nm);
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    expect(p.text('#view .own-ai')).toContain('Claude or ChatGPT can play the other person and save each exchange to your session.');
    // Getting started names the chat route this person has here, and the judge message.
    const steps = await learnerSteps(p);
    expect(steps).toContain('On the session page, copy the start-up message into Claude or ChatGPT and talk it through there');
    expect(steps).toContain('Under Send to your judge, choose Copy message for my judge and send it to your appointed judge.');
    p.q('#connect-ai-button')!.click();
    const d = await p.until(() => p.q('#connect-ai[open]'), 'the Connect dialog');
    expect(d.querySelector('#connect-title')?.textContent).toBe('Use your own AI assistant');
    expect(d.querySelector('#connect-desc')?.textContent).toContain('never asks for an API key');
    expect((d.querySelector('#connector-address') as HTMLTextAreaElement).value).toBe(`${RELAY}/mcp`);
    // A text area that wraps, so a long address shows whole on a phone; it is still no page text.
    expect([d.querySelector('#connector-address')?.tagName, d.querySelector('#connector-address')?.hasAttribute('readonly')]).toEqual(['TEXTAREA', true]);
    // Two apps, two sets of steps; the one not chosen is hidden.
    const tabs = [...d.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['In Claude', 'true'], ['In ChatGPT', 'false']]);
    expect(shownText(d)).toContain('In Claude, open Settings, then Connectors, then Add custom connector.');
    expect(shownText(d)).toContain("In each new chat, turn on Interego from the chat's tools menu (+).");
    expect(shownText(d)).toContain("Whether you can add a connector depends on your plan or workspace settings. If you don't see the option, use Copy for my AI on each step instead.");
    expect(shownText(d)).not.toContain('In ChatGPT on the web');
    (tabs[1] as HTMLElement).click();
    // ChatGPT's own steps, as OpenAI's guide to custom MCP servers gives them, in order, and the guide itself one link away.
    expect([...d.querySelectorAll('#connect-panel-chatgpt .connect-steps li')].map((li) => li.textContent)).toEqual([
      'In ChatGPT on the web, open Plugins, select +, then Add custom MCP server.',
      'Name it Interego, paste the address above as its Server URL, and choose OAuth.',
      'Accept the warning, select Create as a plugin, then install it.',
      'When it asks, sign in with the same Interego account you use here.',
      'In a chat, type @ and choose Interego.',
    ]);
    // What decides whether a connector can be added, in the same words as the Claude tab: a personal account has no workspace to check.
    expect([...d.querySelectorAll('#connect-panel-chatgpt .hint')].map((x) => x.textContent)).toContain("Whether you can add a connector depends on your plan or workspace settings. If you don't see the option, use Copy for my AI on each step instead.");
    expect(shownText(d)).not.toContain("Your workspace's settings decide");
    // A remembered approval covers one tool in one chat, as OpenAI's guide says, not the whole chat.
    expect(shownText(d)).toContain("ChatGPT asks before each write unless you let it remember your choice for that tool in that chat. If Interego's tools look out of date, refresh it from its page in your app settings.");
    const guide = [...d.querySelectorAll('#connect-panel-chatgpt a')];
    expect(guide.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('rel'), a.getAttribute('target')]))
      .toEqual([["OpenAI's guide to custom MCP servers", 'https://developers.openai.com/api/docs/guides/custom-mcp-server', 'noopener', null]]);
    expect(shownText(d)).not.toContain("turn on Interego from the chat's tools menu");
    // No claim about which plans offer custom connectors, in either tab.
    for (const tab of ['claude', 'chatgpt']) {
      expect(d.querySelector(`#connect-panel-${tab}`)?.textContent, tab).not.toMatch(/\bplans? (that|which) allows?\b|needs a plan|plan must|plans don't|Some \w+ plans|Plus|Pro\b|Business|Enterprise|Team plan/);
    }
    // Who judges, in plain words: a different person, with their own account, appointed by Member ID; never your assistant on a
    // session your Interego account started, in any chat or role. The bridge refuses by account, so the sentence names the account:
    // a session started with a wallet belongs to the wallet.
    expect(d.querySelector('#connect-judge')?.textContent).toBe("It can't assess a session you started with your Interego account, even in a new chat or told to act as a judge: it still acts as you. A judge is a different person, with their own Interego account, whom your admin appoints by Member ID.");
    // What it can and can't do: this workspace keeps the decisions in the web app, and says who sees what.
    (d.querySelector('#connect-limits') as HTMLDetailsElement).open = true;
    expect(d.querySelector('#connect-decisions')?.textContent).toBe('Approving rubrics, signing off reviews and changing roles happen here in the web app, not from a chat assistant.');
    expect(shownText(d)).toContain('The Interego connector passes everything your assistant reads and writes here, including conversation text, and the company behind your assistant sees it too');
    const byok = d.querySelector('#byok-section') as HTMLDetailsElement;
    expect([byok.open, byok.querySelector('summary')?.textContent]).toEqual([false, 'Advanced: use your own Anthropic API key (drafts only)']);
    expect(byok.textContent).toContain('Claude or ChatGPT needs no key here, connected or by copy and paste.');
    (d.querySelector('#connect-paste') as HTMLDetailsElement).open = true;
    plain('the Connect dialog', shownText(d));
    // A judge pastes a learner's message into a new chat, as the message itself asks.
    expect(d.querySelector('.connect-roles')?.textContent).toContain('Appointed judges: paste the message a learner sends you into a new chat.');
    (d.querySelector('#copy-workspace-details') as HTMLElement).click();
    await p.until(() => p.copied.length === 1, 'the copied workspace details');
    const details = p.copied[0]!;
    for (const says of [`My Practice Evidence workspace: ${nm.base}/`, `descriptor_url: "${nm.base}/affordances"`, `"${DEMO_POD}"`, 'sign_payload',
      `except ${PEV_ACTION.listScenarios} and ${PEV_ACTION.draftScenarioPacket}`, 'nonce = the step name',
      // A chat app whose act tool shows no sign_payload signs a signed step in two calls and leaves sign_payload out of a plain one.
      FALLBACK.both]) expect(details).toContain(says);
    expect(details.split(FALLBACK.both)).toHaveLength(2);
    // The signing rule says that sign_payload true or false names the kind of step, here and in any example, and points to
    // where the prompt says what to do with each kind when the act tool has no such option: the last line of How to do
    // each step, which is that fallback. The condition is said there and nowhere else.
    expect(details.split('\n').filter((line) => line.startsWith('- Sign every step'))).toEqual([
      `- Sign every step except ${PEV_ACTION.listScenarios} and ${PEV_ACTION.draftScenarioPacket}, which are plain: their arguments go at the top level of payload. `
        + 'Here and in any example, sign_payload true or false says whether a step is signed or plain; '
        + 'the last line of How to do each step says what to do with each kind when your act tool has no sign_payload option.',
    ]);
    const howBlock = details.split('\n\n').find((part) => part.startsWith('How to do each step:')) ?? '';
    expect(howBlock.split('\n').at(-1)).toBe(FALLBACK.both);
    expect(details.match(/if your act tool has no sign_payload option/gi)).toHaveLength(1);
    expect(details).not.toContain('or the two calls above');
    // With no step of its own, its nonce example names no step at all: never one this workspace does not have.
    expect(details).not.toMatch(/For example [A-Za-z0-9-]+-4-|read-items/);
    // The confirmation is in the open dialog, where the person pressed Copy: the button says so and the
    // dialog's own status line is announced. Nothing goes to the page's toasts, under the dialog's backdrop.
    const said = await p.until(() => d.querySelector(':scope > .dialog-said')?.textContent, 'the confirmation in the dialog');
    expect(said).toBe('Workspace details copied. Paste them into your chat.');
    expect([d.querySelector(':scope > .dialog-said')?.getAttribute('role'), p.text('#copy-workspace-details'), p.q('#toasts')?.children.length]).toEqual(['status', 'Copied', 0]);
    (d.querySelector('.copy-field-group button') as HTMLElement).click();
    await p.until(() => p.copied.length === 2 && d.querySelector(':scope > .dialog-said')?.textContent === 'Connector address copied.', 'the copied connector address');
    expect([p.copied[1], d.querySelector('.copy-field-group button')?.textContent]).toEqual([`${RELAY}/mcp`, 'Copied']);
    // The button says what it did for a moment, then what it does again.
    await p.until(() => p.text('#copy-workspace-details') === 'Copy workspace details', 'the button back as it was', 10_000);
    expect(p.q('#toasts')?.children.length).toBe(0);
    // The account menu offers it too, where the key used to be.
    expect([...p.w.document.querySelectorAll('#user-menu .menu__item')].map((x) => x.textContent)).toContain('Connect your AI assistant');
    expect(p.text('#user-menu')).not.toContain('provider key');
    expect(p.intervals).toEqual([]);
    expect(p.errors).toEqual([]);

    // A workspace that lets chat assistants decide says so instead.
    const decide = await serve({ relayUrl: RELAY, deploymentUrl: DEPLOY, relayFetch: relay.fetchFn }, {
      handlers: createPevHandlers({
        platformWallet: PLATFORM, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address], adminDids: [PRINCIPAL], chatAgentsDecide: true,
        fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110', relayDelegation: POLICY, relayUrl: RELAY,
      } satisfies PevDeps) as Handlers,
    });
    const q = await signedInPage(decide);
    expect(q.text('#connect-decisions')).toBe('This workspace also lets assistants approve rubrics, sign off reviews and change roles, so check what you ask for.');

    // Signed out, or signed in with a wallet: no connector steps, and the reason in plain words.
    const out = await openPage(nm, '/ui', {}, (w) => {
      w['ethereum'] = { request: async ({ method }: { method: string }): Promise<unknown> => (method === 'eth_requestAccounts' ? [W.learner.address] : null) };
    });
    await out.until(() => out.q('#view .own-ai [data-connect]'), 'the practice callout');
    expect(out.q('#connect-ai-button')).toBeNull();
    out.q('#view .own-ai [data-connect]')!.click();
    expect([out.q('#connect-ai #connector-address'), out.text('#connect-ai').includes('Sign in with Interego first.')]).toEqual([null, true]);
    out.q('#connect-ai .modal__footer .btn--primary')!.click();
    out.q('#connect-wallet')!.click();
    await out.until(() => out.text('#acting-as').startsWith('Signed in with wallet'), 'the wallet');
    // Getting started and the practice callout promise a wallet learner no start-up message: that takes Interego sign-in.
    const walletSteps = await learnerSteps(out);
    expect(walletSteps).toContain('On the session page, copy each line into your own AI assistant and paste its reply back.');
    expect(walletSteps).not.toContain('start-up message');
    // The practice view paints Getting started at once and adds this callout only after the scenario
    // list answers, so wait for it rather than read it the moment the steps appear.
    await out.until(() => out.text('#view .own-ai').includes('Signed in with Interego'), 'the wallet practice callout');
    expect(out.text('#view .own-ai')).toContain('Signed in with Interego, Claude or ChatGPT can play the other person and save each exchange to your session. Otherwise, copy each line');
    out.q('#connect-ai-button')!.click();
    await out.until(() => out.q('#connect-ai[open]'), 'the Connect dialog');
    expect([out.q('#connect-ai #connector-address'), out.q('#connect-ai #copy-workspace-details')]).toEqual([null, null]);
    expect(out.text('#connect-ai')).toContain('Your AI assistant acts as your Interego account, not your wallet.');
    // The way there is right beside it: Interego sign-in, which leaves the wallet behind in this tab.
    expect(out.text('#connect-ai .callout')).toContain('To use Claude or ChatGPT, sign in with Interego: this tab then stops using your wallet.');
    const toInterego = out.q('#connect-ai .callout [data-sign-in="interego"]');
    expect(toInterego?.textContent).toBe('Sign in with Interego');
    // The account menu offers it too.
    expect([out.q('#user-menu #wallet-to-interego')?.getAttribute('data-sign-in'), out.text('#user-menu #wallet-to-interego')]).toEqual(['interego', 'Sign in with Interego instead']);
    // Getting started does not mark Interego sign-in done for a wallet: it says what the wallet is, and what Interego adds.
    const first = out.q('.checklist__item');
    expect([first?.querySelector('.checklist__title-item')?.textContent, first?.querySelector('.checklist__text')?.textContent])
      .toEqual(['Done: Sign in', 'You\'re signed in with your wallet. To use Claude or ChatGPT here, sign in with Interego instead.']);
    // Pressing it closes the dialog and starts the same sign-in as the header's button: the page leaves for the relay.
    toInterego!.click();
    await out.until(() => out.q('#interego-continue') ?? out.q('#signing .refusal'), 'the way to Interego');
    expect([out.q('#connect-ai[open]'), out.q('#interego-continue')?.getAttribute('href')?.startsWith(`${RELAY}/authorize?`)]).toEqual([null, true]);
    await out.until(() => out.errors.includes(NAVIGATION), 'the navigation to the relay');
    expect([...q.errors, ...out.errors.filter((e) => e !== NAVIGATION)]).toEqual([]);
  }, SLOW);

  it('the chat hand-off: a start-up message for Claude or ChatGPT, lines saved from the chat appear when the person comes back (no timer, nothing typed lost), and the judge gets a message without the conversation', async () => {
    const p = await signedInPage(nm);
    const card = await p.until(() => p.q('article.scenario'), 'the scenarios');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    const handoff = await p.until(() => p.q('#view .chat-handoff'), 'the chat hand-off');
    const attemptIri = decodeURIComponent(p.w.location.hash.slice('#/attempt/'.length));
    expect(p.q('#send')).toBeNull();
    // One saved version so far, and it reads as one.
    expect(p.all('#view .versions summary').map((x) => x.textContent)).toContain('History (1 saved version)');
    // Copy and paste is still there, closed, for a plan without connectors.
    const packet = p.q('#view details.packet') as HTMLDetailsElement;
    expect([packet.open, packet.querySelector('summary')?.textContent, packet.contains(p.q('#line'))]).toEqual([false, 'No connector? Copy and paste one line at a time', true]);
    expect(shownText(handoff)).toContain('Have this conversation in Claude or ChatGPT');
    plain('the session page', `${shownText(p.q('#bar'))} ${shownText(p.q('#view'))}`);
    p.q('#copy-startup')!.click();
    await p.until(() => p.copied.length === 1, 'the start-up message');
    const startup = p.copied[0]!;
    for (const says of [attemptIri, PEV_ACTION.counterpartPacket, PEV_ACTION.recordTurns, PEV_ACTION.endConversation, 'sign_payload: true', `descriptor_url: "${nm.base}/affordances"`,
      `"pod_url":"${DEMO_POD}"`, 'T starts at 1.', 'nextTurnIndex', 'turn-out-of-order', '"ended": true', 'payload.action is exactly this urn', 'Never change my words.',
      "Sam Okafor's last line was: \"You wanted to see me?", 'For example counterpart-packet-4-q8Xr2mVp7LkA9dTz,', FALLBACK.signed]) expect(startup, says).toContain(says);
    // Every step of it is signed: nothing about leaving sign_payload out.
    expect(startup).not.toContain(PLAIN_RULE);
    expect(startup).not.toContain('read-items');
    // A refused or lost step is reconciled from what is saved, with the read step, before any reply is written or saved again.
    expect(startup).toContain('again only if we carry on in a new chat or a rule below says so');
    expect(startup).toContain('- If a step is refused with turn-out-of-order, envelope-already-used, envelope-expired or chain-moved (the session moved on, perhaps in another app), or you lose track of the conversation: '
      + 'do step 1 again, with the nextTurnIndex the refusal gives if it gives one, and read what is saved before you write or save anything. '
      + 'If my line is already saved with a reply, show me that reply. Otherwise write a new reply to the conversation as saved. Never re-send a reply under another turn number.');
    // The old rule retried the same reply at the next turn number: a duplicate when the first save had gone through.
    expect(startup).not.toContain('try once more');
    // Every refusal code it names is one the bridge really sends.
    const handlerSource = readFileSync(fileURLToPath(new URL('../bridge/handlers.ts', import.meta.url)), 'utf8') + readFileSync(fileURLToPath(new URL('../src/records.ts', import.meta.url)), 'utf8');
    for (const code of ['turn-out-of-order', 'envelope-already-used', 'envelope-expired', 'chain-moved', 'binding-mismatch']) expect(handlerSource, code).toContain(`'${code}'`);
    expect(startup).not.toMatch(/llm_api_key|api key/i);

    // Claude, connected as this person, saves an exchange: the page shows it when the person comes back to the tab.
    const signsBefore = p.asked.filter((x) => x === 'POST /ui/relay/sign').length;
    const readsBefore = p.asked.filter((x) => x === 'POST /pev/get_attempt').length;
    ok(await fromChat(noModelHandlers, 'pev.record_turns', PEV_ACTION.recordTurns, { attemptIri, turnIndex: 1, learnerText: 'Thanks for coming in. The report was due Thursday.', counterpartText: 'Yes. The feed was late again.', counterpartDisclosure: { provider: 'Anthropic', model: 'not shown' } }));
    expect(p.all('.bubble').length).toBe(1);
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    await p.until(() => p.all('.bubble').length === 3, 'the lines saved from the chat');
    expect(p.all('.bubble.them').at(-1)?.textContent).toContain('Written by your own AI (Anthropic, model not shown), as declared');
    // The first line made Finish possible, so the panel was drawn again (nothing was typed in it).
    await p.until(() => p.q('#view .conversation__finish'), 'Finish conversation');
    // One read, with the signed read the page already held: nobody was asked to sign anything.
    expect([p.asked.filter((x) => x === 'POST /pev/get_attempt').length - readsBefore, p.asked.filter((x) => x === 'POST /ui/relay/sign').length - signsBefore]).toEqual([1, 0]);
    // The next exchange from the chat is appended to what the page shows, and said so.
    ok(await fromChat(noModelHandlers, 'pev.record_turns', PEV_ACTION.recordTurns, { attemptIri, turnIndex: 3, learnerText: 'What got in the way?', counterpartText: 'The finance feed, twice.', counterpartDisclosure: { provider: 'Anthropic', model: 'not shown' } }));
    const chatBox = p.q('#view .chat.bubbles');
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    await p.until(() => p.all('.bubble').length === 5, 'the next lines saved from the chat');
    expect([p.q('#view .chat.bubbles') === chatBox, p.text('#view .watch').includes('2 new lines.')]).toEqual([true, true]);
    expect(p.text('#view .conversation .card__subtitle')).toBe('2 of 12 lines used');
    expect(p.asked.filter((x) => x === 'POST /ui/relay/sign').length - signsBefore).toBe(0);
    // The next start-up message carries on from where the chat left off.
    p.q('#copy-startup')!.click();
    await p.until(() => p.copied.length === 2, 'the next start-up message');
    expect(p.copied[1]).toContain('T starts at 5.');
    expect(p.copied[1]).toContain("Sam Okafor's last line was: \"The finance feed, twice.\"");

    // A reply typed into the copy-and-paste form is never drawn over: the session ended in the chat, and the page waits.
    const typed = 'Half a reply I have not saved yet';
    const theirs = p.q('#their-line') as HTMLTextAreaElement;
    theirs.value = typed;
    ok(await fromChat(noModelHandlers, 'pev.end_conversation', PEV_ACTION.endConversation, { attemptIri, turnIndex: 5 }));
    p.w.dispatchEvent(new p.w.Event('focus'));
    await p.until(() => p.text('#view .watch').includes('This session has changed.'), 'the changed-session note');
    expect([(p.q('#their-line') as HTMLTextAreaElement | null)?.value, p.text('#state')]).toEqual([typed, 'In conversation']);
    (p.q('#their-line') as HTMLTextAreaElement).value = '';
    p.q('#check-lines')!.click();
    await p.until(() => p.text('#state') === 'Finished: not assessed yet', 'the finished session');
    expect(p.text('#view .judgments')).toContain('Waiting for a judge.');
    expect(p.text('#view .judgments')).toContain('If you don\'t have one yet, ask your admin.');
    // Nothing assessed yet, and the Feedback card says so: no Provisional pill over an empty card.
    expect(p.text('#view .judgments .card__header .status')).toBe('Not assessed yet');

    // Send to your judge: the session's ID and what to paste, never the conversation.
    const send = await p.until(() => p.q('#copy-judge-message'), 'Send to your judge');
    expect(p.text('#view .card.actions')).toContain('Not sure who your judge is? Ask your admin.');
    send.click();
    await p.until(() => p.copied.length === 3, 'the message for the judge');
    const judge = p.copied[2]!;
    // The judge pastes the prompt into a new chat, never one that listed scenarios or read the review queue: those answers
    // carry the rubric's weights, level values and pass rule (and the queue's, every judgment's levels), which neither
    // step of the prompt shows the assistant.
    expect(judge.split('\n').slice(0, 3)).toEqual([
      `Hi, could you assess my practice session in Practice Evidence? Session: ${attemptIri}. Workspace: ${nm.base}/`,
      "Don't reuse a chat where you reviewed sessions or listed scenarios: it has already seen the scoring. "
        + 'Paste everything between the lines into a new chat in Claude or ChatGPT, with the Interego connector on:',
      '---',
    ]);
    // Its nonce example is its own first signed step, at turn 0: judging has no turn, and the rule says "or 0".
    for (const says of [attemptIri, PEV_ACTION.judgePacket, PEV_ACTION.recordJudgment, 'usedPacketPrompt', 'wait for my go-ahead', `Workspace: ${nm.base}/`,
      'For example judge-packet-0-q8Xr2mVp7LkA9dTz,', FALLBACK.signed,
      "If this is my own practice session, stop: I can't assess it, in any chat or role."]) expect(judge, says).toContain(says);
    expect(judge).not.toContain(PLAIN_RULE);
    // Whether a save was kept is asked of the workspace, never judged from what the chat saw: assessing again after a save
    // that was kept saves a second one, and a save the chat app answered with an error, or not at all, may have been kept.
    // The first step asks it: the judge packet ends with yourAssessment, which says whether the caller has a saved
    // assessment that still counts, and nothing more. There is no step that reads the session: that answer carries the
    // rubric's weights, level values and pass rule, which the packet leaves out so the judging assistant never sees them.
    const judgeRules = judge.split('\n').filter((line) => line.startsWith('- '));
    const steps = promptSteps(judge);
    expect(steps.map((x) => [x.n, x.actionIri, x.signed])).toEqual([[1, PEV_ACTION.judgePacket, true], [2, PEV_ACTION.recordJudgment, true]]);
    for (const gone of [PEV_ACTION.getAttempt, 'get-attempt', 'signedAs', 'third step', 'read the session']) expect(judge, gone).not.toContain(gone);
    expect(steps[0]!.say).toBe('Get the session, the rubric and the request to assess it with. Its yourAssessment is null if nothing of mine is saved; otherwise my assessment is saved. '
      + 'An answer without yourAssessment counts as no answer.');
    expect(steps[0]!.payload).toMatchObject({ v: 1, attemptIri, action: PEV_ACTION.judgePacket });
    // The first rule stops the chat whenever the first step finds an assessment saved, at the start too: a new chat, or
    // this message sent again, knows nothing of what an earlier chat saved.
    expect(judge.split('\nRules:\n')[1]!.split('\n')[0]).toBe('- Whenever the first step shows my assessment is saved, tell me so, and stop: I have already assessed this session, in this chat or another.');
    // Every way a save may have been kept does the first step again before anything else; when nothing is saved, one resend
    // of the same assessment, bound to the head that save was bound to.
    expect(judgeRules.filter((r) => r.includes('envelope-already-used'))).toEqual([
      "- If a save is refused with envelope-already-used, comes back with an error that names no refusal code, or gets no answer, or you lose track after sending a save (or can't tell whether you sent one): "
        + "don't assess or save again before you do the first step again. If nothing of mine is saved, send the same assessment once more, with a new nonce and the same binding as that save; "
        + 'if you already sent it again, or no longer have it, tell me it is not saved, and stop.',
    ]);
    // A save refused because the session changed assesses again only when the first step, done again, shows nothing of the judge's saved.
    expect(judgeRules.filter((r) => r.includes('binding-mismatch'))).toEqual([
      '- If a save is refused with binding-mismatch or chain-moved (the session changed after the first step): do the first step again, and if nothing of mine is saved, '
        + 'assess what it returns, never an earlier assessment, and show me before you save.',
    ]);
    for (const r of judgeRules) expect(r).not.toMatch(/accepted in this chat|has been accepted/);
    // Only a first step that cannot answer leaves the judge with "may already be saved", and only once a save of this
    // session was sent in that chat: the first step is also the first call of every chat, and a judge it refuses before
    // any save (not registered yet, the session not ended) has nothing saved to ask the learner about. Nor does a chat
    // that saved another learner's session and is then refused this one (attempt-already-reviewed, say). A wrong field in
    // it, which the first call of every chat can have, is fixed once, as the closing rule says for any call.
    expect(judgeRules.filter((r) => r.includes('may already be saved'))).toEqual([
      "- If the first step is refused, other than for a wrong field or its format, or gets no answer: don't assess or save. "
        + "Tell me what it said and, if you sent a save of this session in this chat or can't tell whether you did, that my assessment may already be saved; then stop.",
    ]);
    expect(judgeRules.at(-1)).toContain('if a call is refused because a field or its format is wrong, fix it once from the refusal message and try again.');

    // The message's own steps, run as the judge's assistant would run them, against this workspace.
    // A judge, appointed by Member ID, whose chat app answers the first save with an error although it was kept.
    const judgeUser = 'u-pk-0000000000f9';
    const judgeDid = `did:web:${IDH}:users:${judgeUser}`;
    expect((await direct('pev.register_role', W.admin, PEV_ACTION.registerRole, { address: judgeDid, role: 'judge', change: 'add' }))['changed']).toBe(true);
    const toolOf = (actionIri: string): string => pevAffordances.find((x) => x.action === actionIri)!.toolName!;
    const asJudge = async (step: (typeof steps)[number], fields: Out = {}, surface = 'claude'): Promise<Out> => {
      const filled: Out = { ...step.payload, ...fields };
      filled['nonce'] = `${String(step.payload['nonce']).split('-<')[0]}-0-${randomBytes(8).toString('hex')}`;
      return fromChat(noModelHandlers, toolOf(step.actionIri), step.actionIri, filled, judgeUser, surface);
    };
    // Neither step's answer carries the stakes the packet's rubric leaves out, or another judgment's levels.
    const STAKES = /weight|"value"|passRule|minPercent|requiredLevels|meetsPassRule|percent|"points"|unmet|provisional|agreement|nextSteps/i;
    // The first step as the message reads it: null goes on with the packet, anything else is saved, and a refusal or an
    // answer without the field ends the chat. Whatever it says, it never carries the stakes.
    const firstStep = async (surface = 'claude'): Promise<Out | 'saved' | 'cannot tell'> => {
      const r = await asJudge(steps[0]!, {}, surface);
      if (r['kind'] !== undefined || !Object.prototype.hasOwnProperty.call(r, 'yourAssessment')) return 'cannot tell';
      expect(JSON.stringify(r)).not.toMatch(/weight|"value"|passRule|minPercent|requiredLevels|meetsPassRule|percent/i);
      expect(Object.keys(r).at(-1)).toBe('yourAssessment');
      if (r['yourAssessment'] === null) return r;
      expect(Object.keys(r['yourAssessment'] as Out).sort()).toEqual(['judgedAt', 'saved']);
      return 'saved';
    };
    const judgmentsOf = async (): Promise<readonly { readonly judge: { readonly signer?: string }; readonly repeatOf: number | null }[]> =>
      ((await readHead(DEMO_POD, attemptIri, TRUSTED, pod.fetchFn)).head!.body as Extract<PevRecordBody, { kind: 'attempt' }>).judgments.filter((j) => j.judge.signer === judgeDid);
    const head = await readHead(DEMO_POD, attemptIri, TRUSTED, pod.fetchFn);
    const rubric = (head.head!.body as Extract<PevRecordBody, { kind: 'attempt' }>).scenarioSpec.rubric;
    // Two chats of the same judge overlap: the judge pasted the message into a second chat app (chat B, ChatGPT) while the
    // first (chat A, Claude) was still going, and B's first step comes first. Nothing is saved, so B goes on with the packet.
    // One answer carries both the binding B will save with and yourAssessment, read together: the binding names the
    // version of the session yourAssessment was read from, so no save can land between the two.
    const chatB = await firstStep('chatgpt');
    if (typeof chatB === 'string') throw new Error(`chat B stopped at the first step: ${chatB}`);
    expect([(chatB['binding'] as Out)['attemptHeadUrl'], chatB['yourAssessment']]).toEqual([head.head!.descriptorUrl, null]);
    // Chat A: before any save, the first step says nothing of the judge's is saved, and the chat goes on with the packet it returned.
    const judgePacket = await firstStep();
    if (typeof judgePacket === 'string') throw new Error(`the first chat stopped at the first step: ${judgePacket}`);
    const assessment: Out = {
      ...(judgePacket['binding'] as Out),
      judgment: { criteria: rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[0]!.id, quotes: [{ text: 'The report was due Thursday.', turnIndex: 1 }], rationale: 'States the missed deadline.' })) },
      judgeDisclosure: { provider: 'Anthropic', model: 'not shown', usedPacketPrompt: true },
    };
    // The first step is a read: the same nonce, sent twice, is answered twice, so doing it again never spends anything.
    const sameNonce = { ...steps[0]!.payload, nonce: `judge-packet-0-${randomBytes(8).toString('hex')}` };
    for (let i = 0; i < 2; i += 1) expect(ok(await fromChat(noModelHandlers, toolOf(PEV_ACTION.judgePacket), PEV_ACTION.judgePacket, sameNonce, judgeUser))['yourAssessment']).toBeNull();
    // The second step: the save, whose answer says it was kept and how the judge's own quotes were checked, and nothing more.
    const save = async (fields: Out): Promise<Out> => {
      const r = ok(await asJudge(steps[1]!, fields));
      expect(JSON.stringify(r)).not.toMatch(STAKES);
      expect(Object.keys(r)).toEqual(['attemptIri', 'descriptorUrl', 'state', 'judgmentCount', 'judgment', 'currentTarget', 'recorded']);
      return r;
    };
    // The README says what that answer carries, every field of it: the count of judgments too, which tells the assistant
    // whether others assessed the session, though never their levels. It also says why the message asks for a new chat,
    // and when the message says the assessment may already be saved.
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    for (const says of [
      "`record-judgment` tells the judge that the save was kept, the attempt's state and how many judgments it now has, and how their own levels and quotes were checked, but never",
      'So the message asks for a new chat, not one used to review sessions or list scenarios, and the guide says the same.',
      "says the assessment may already be saved only if it sent a save of this attempt in that chat or can't tell whether it did",
    ]) expect(readme).toContain(says);
    expect(readme).not.toContain('tells the judge only that the save was kept');
    const saved = await save(assessment);
    // Chat B saves its own assessment with the binding its first step returned. Chat A's save changed the session since,
    // so it is refused as binding-mismatch rather than kept as a second assessment by the same judge.
    const chatBAssessment: Out = {
      ...(chatB['binding'] as Out),
      judgment: { criteria: rubric.criteria.map((c) => ({ criterionId: c.id, level: c.levels[c.levels.length - 1]!.id, quotes: [{ text: 'Thanks for coming in.', turnIndex: 1 }], rationale: 'Opens politely.' })) },
      judgeDisclosure: { provider: 'OpenAI', model: 'not shown', usedPacketPrompt: true },
    };
    expect(refusalOf(await asJudge(steps[1]!, chatBAssessment, 'chatgpt'))).toEqual([409, 'binding-mismatch']);
    // The rule for that refusal does the first step again. Its one answer names the version chat A's save wrote and says
    // the judge's assessment is saved, made then: chat B tells the judge so and stops, saving nothing more.
    const chatBAgain = ok(await asJudge(steps[0]!, {}, 'chatgpt'));
    expect([(chatBAgain['binding'] as Out)['attemptHeadUrl'], chatBAgain['yourAssessment']])
      .toEqual([saved['descriptorUrl'], { saved: true, judgedAt: (saved['judgment'] as Out)['judgedAt'] }]);
    expect(await firstStep('chatgpt')).toBe('saved');
    expect((await judgmentsOf()).length).toBe(1);
    // Chat A's app said its save failed. The rule: the first step again before anything else, and it finds the assessment saved.
    expect(await firstStep()).toBe('saved');
    expect(ok(await asJudge(steps[0]!))['yourAssessment']).toEqual({ saved: true, judgedAt: (saved['judgment'] as Out)['judgedAt'] });
    // Had the first step been read before that save was written, the one resend, the same assessment with the same binding,
    // is refused rather than saved twice, and the rule for that refusal does the first step again, which finds it saved.
    expect(refusalOf(await asJudge(steps[1]!, assessment))).toEqual([409, 'binding-mismatch']);
    expect(await firstStep()).toBe('saved');
    // The learner sends the message again (Send to your judge stays after a judgment), or the judge pastes it into a new
    // chat after the chat app failed: the first step finds the assessment, and the chat stops there.
    expect(await firstStep()).toBe('saved');
    // One assessment by this judge, however the chats went.
    expect((await judgmentsOf()).length).toBe(1);
    // Once a reviewer has signed off, judging is closed and the first step says so: the chat stops, saving nothing.
    const target = ok(await direct('pev.get_attempt', W.reviewer, PEV_ACTION.getAttempt, { attemptIri }, noModelHandlers))['currentTarget'];
    const reviewed = ok(await direct('pev.countersign_attempt', W.reviewer, PEV_ACTION.countersignAttempt,
      { attemptIri, target, levels: rubric.criteria.map((c) => ({ criterionId: c.id, levelId: c.levels[0]!.id })), sawJudgeLevelsFirst: true }, noModelHandlers));
    expect(refusalOf(await asJudge(steps[0]!))).toEqual([409, 'attempt-already-reviewed']);
    expect(await firstStep()).toBe('cannot tell');
    // A contest reopens judging and keeps the judgment made before it: that one no longer counts, so the first step says
    // nothing of the judge's is saved, the judge assesses the reopened session once, and the first step then finds that one.
    ok(await fromChat(noModelHandlers, 'pev.contest_review', PEV_ACTION.contestReview, { attemptIri, target: reviewed['currentTarget'], why: 'The deadline I named was the one we agreed on.' }));
    const reopened = await firstStep();
    if (typeof reopened === 'string') throw new Error(`the chat after the contest stopped at the first step: ${reopened}`);
    const resaved = await save({ ...assessment, ...(reopened['binding'] as Out) });
    expect(ok(await asJudge(steps[0]!))['yourAssessment']).toEqual({ saved: true, judgedAt: (resaved['judgment'] as Out)['judgedAt'] });
    expect(await firstStep()).toBe('saved');
    expect((await judgmentsOf()).map((j) => j.repeatOf)).toEqual([null, 0]);
    expect(judge).not.toMatch(/For example [A-Za-z0-9-]+-4-/);
    expect(judge).not.toContain('The report was due Thursday');
    expect(judge).not.toContain('The feed was late again');
    plain('the finished session', `${shownText(p.q('#bar'))} ${shownText(p.q('#view'))}`);
    // Nothing ran on a timer: every read above came from the person coming back, or asking.
    expect(p.intervals).toEqual([]);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('coming back to the tab after the page\'s signed read is old still shows lines saved from the chat: the relay signs a new read, and no person is asked', async () => {
    const p = await signedInPage(nm);
    const card = await p.until(() => p.q('article.scenario'), 'the scenarios');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    await p.until(() => p.q('#view .chat-handoff'), 'the chat hand-off');
    const attemptIri = decodeURIComponent(p.w.location.hash.slice('#/attempt/'.length));
    expect(p.text('#view .watch')).toContain('This page checks again when you come back to it.');
    // A chat lasts longer than a signed read is kept: ten minutes on, on the page's clock, the read it drew the session with is too old to send again.
    const realNow = p.w.Date.now.bind(p.w.Date);
    p.w.Date.now = (): number => realNow() + 10 * 60_000;
    const signs = (): number => p.asked.filter((x) => x === 'POST /ui/relay/sign').length;
    const reads = (): number => p.asked.filter((x) => x === 'POST /pev/get_attempt').length;
    const [signs0, reads0] = [signs(), reads()];
    ok(await fromChat(noModelHandlers, 'pev.record_turns', PEV_ACTION.recordTurns, { attemptIri, turnIndex: 1, learnerText: 'Thanks for coming in. The report was due Thursday.', counterpartText: 'Yes. The feed was late again.', counterpartDisclosure: { provider: 'Anthropic', model: 'not shown' } }));
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    await p.until(() => p.all('.bubble').length === 3, 'the lines saved from the chat');
    // One read, which the relay signed for this sign-in through the bridge: the person was asked nothing.
    expect([reads() - reads0, signs() - signs0]).toEqual([1, 1]);
    // That read is kept: coming back again at once reads with it and signs nothing more.
    p.w.dispatchEvent(new p.w.Event('focus'));
    await p.until(() => reads() - reads0 === 2, 'the second check');
    expect(signs() - signs0).toBe(1);
    // A sign-in past its expiry does not re-read on its own.
    p.w.Date.now = (): number => realNow() + 2 * 3_600_000;
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 200));
    expect([reads() - reads0, signs() - signs0]).toEqual([2, 1]);
    expect(p.intervals).toEqual([]);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('an author drafts in Claude or ChatGPT: the assistant asks only the two decisions and saves a feedback-only draft, never a score', async () => {
    const p = await signedInPage(nm);
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    p.w.location.hash = '#/author';
    const chat = await p.until(() => p.q('#view .draft-chat'), 'Draft it in Claude or ChatGPT');
    expect(p.q(`button[data-action="${PEV_ACTION.draftScenario}"]`)).toBeNull();
    expect((p.q('#view .draft-paste') as HTMLDetailsElement).open).toBe(false);
    plain('the draft card', shownText(chat));
    const brief = 'A nurse lead asks a colleague to cover a weekend shift at short notice.';
    (p.q('#draft-brief') as HTMLTextAreaElement).value = brief;
    p.q('#copy-draft-message')!.click();
    await p.until(() => p.copied.length === 1, 'the drafting message');
    const msg = p.copied[0]!;
    for (const says of [PEV_ACTION.draftScenarioPacket, PEV_ACTION.authorScenario, 'sign_payload: false', '"status":"draft"', '"by":"own-agent"', '"assessmentUse": "feedback-only"', 'workRegime', brief, 'Include drafts',
      // Getting the drafting request is plain and saving the draft is signed, so both ways are there, once each.
      FALLBACK.both]) {
      expect(msg, says).toContain(says);
    }
    expect([msg.split(PLAIN_RULE).length, msg.split(SIGNED_RULE).length]).toEqual([2, 2]);
    // The AI never sees a weight or a pass mark: the message names neither.
    expect(msg).not.toMatch(/weight|passRule|minPercent/i);
    // The draft's placeholder holds no quote marks, so its JSON line carries no escaped quotes; the nonce
    // example is this message's own signed step, at turn 0 as its payload template says (a draft has no turn).
    expect(msg).toContain('"scenario":"<the draft object, with assessmentUse feedback-only and workRegime as I chose>"');
    expect(msg).not.toContain('\\"');
    expect(msg).toContain('For example author-scenario-0-q8Xr2mVp7LkA9dTz,');
    expect(msg).toContain('"nonce":"author-scenario-<turn number, or 0>-<16 new random letters or digits>"');
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('keeps the header and the session page inside a 300 px screen: the brand gives way first, signing manually puts the buttons on a line of their own, and a long status or the start-up button wraps', async () => {
    // At 320 px the header ran 15 px past the screen signed in, 47 signed out and 175 signing manually (88 at 768); the
    // session page's "Signature verified: unchanged since it was signed" 37 px, and at 300 "Copy the start-up message" too.
    const css = await (await fetch(`${nm.base}/ui/app.css`)).text();
    const styled = (p: Page): { at(px: number): void; cs(sel: string): CSSStyleDeclaration } => {
      const sheet = p.w.document.createElement('style');
      p.w.document.head.append(sheet);
      return {
        at: (px) => { sheet.textContent = atWidth(css, px); },
        cs: (sel) => { const el = p.q(sel) ?? p.w.document.querySelector(sel); if (!el) throw new Error(`nothing at ${sel}`); return p.w.getComputedStyle(el); },
      };
    };
    const out = await openPage(nm, '/ui');
    await out.until(() => out.q('#interego-sign-in') && out.q('article.scenario'), 'the signed-out header');
    const o = styled(out);
    for (const px of [1280, 360, 300]) {
      o.at(px);
      // The brand gives way first, then a button's label; Other ways to sign in, a round button, never does.
      expect([px, o.cs('.app-header .brand').flexShrink, o.cs('.app-header .brand__name').whiteSpace, o.cs('#interego-sign-in').whiteSpace, o.cs('#signin-other').flexShrink])
        .toEqual([px, '10000', 'normal', 'normal', '0']);
      // "Sign in" without its icon below 360 px; the header one line high, as it always was.
      expect([px, o.cs('#interego-sign-in > .icon').display === 'none', o.cs('.app-header__inner').flexWrap, o.cs('html').getPropertyValue('--header-h')]).toEqual([px, px < 360, '', '4rem']);
    }
    // Signing manually, chosen from Other ways to sign in: a badge, Connect your AI and Sign in, with the menu's button.
    out.q('#sign-manually')!.click();
    await out.until(() => out.q('.app-header #acting-as.badge'), 'the badge');
    expect(out.all('.app-header__actions > :not(.menu)').map((el) => el.id || el.className)).toEqual(['product-switch', 'connect-ai-button', 'acting-as', 'interego-sign-in', 'signin-other']);
    for (const px of [1280, 1000, 800, 600, 300]) {
      o.at(px);
      const below = (em: number): boolean => px < em * 16;
      // Below 64em each says less (its whole name kept for a screen reader); below 48em they take a line of their own under
      // the brand, and the navigation's place under the header (--header-h) moves down to match.
      expect([px, o.cs('#connect-ai-button > .hide-below-sm').display === 'none', o.cs('#interego-sign-in .hide-below-md').display === 'none', out.q('#connect-ai-button')?.getAttribute('aria-label')])
        .toEqual([px, below(64), below(64), 'Connect your AI']);
      expect([px, o.cs('.app-header__inner').flexWrap, o.cs('.app-header__actions').flexBasis, o.cs('.app-header__actions').minHeight, o.cs('html').getPropertyValue('--header-h'), o.cs('#acting-as').flexShrink])
        .toEqual([px, below(48) ? 'wrap' : '', below(48) ? '100%' : '', below(48) ? 'var(--target)' : '', below(48) ? '7rem' : '4rem', '10000']);
    }
    expect(out.errors).toEqual([]);

    // Signed in: Connect your AI says so from 30em, as it did; the account button keeps its size.
    const p = await signedInPage(nm);
    const card = await p.until(() => p.q('article.scenario'), 'the scenarios');
    const s = styled(p);
    s.at(600);
    expect([s.cs('#connect-ai-button > .hide-below-sm').display === 'none', s.cs('.app-header .user-button').flexShrink]).toEqual([false, '0']);
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    await p.until(() => p.q('#view .chat-handoff #copy-startup') && p.q('#view .versions .status'), 'the session page');
    s.at(300);
    // "Copy the start-up message" wraps in its step, which may shrink; a status too long for its line wraps inside itself.
    expect([s.cs('#copy-startup').whiteSpace, s.cs('#copy-startup').maxWidth, p.w.getComputedStyle(p.q('#copy-startup')!.closest('li')!).minWidth]).toEqual(['normal', '100%', '0']);
    for (const sel of ['#state', '#view .versions .status']) expect([sel, s.cs(sel).whiteSpace, s.cs(sel).maxWidth]).toEqual([sel, 'normal', '100%']);
    expect(p.text('#view .versions .status')).toBe('Signature verified: unchanged since it was signed');
    // Write a scenario: a callout's button wraps its label where the line is too short for it.
    p.w.location.hash = '#/author';
    await p.until(() => p.q('#copy-draft-message'), 'Draft it in Claude or ChatGPT');
    expect([p.q('#copy-draft-message')?.parentElement?.className, s.cs('#copy-draft-message').whiteSpace, s.cs('#copy-draft-message').maxWidth]).toEqual(['callout__actions', 'normal', '100%']);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('a session started with a wallet is finished here by copy and paste: no chat hand-off, and coming back to the tab asks the wallet for nothing', async () => {
    const calls: string[] = [];
    const p = await openPage(nm, '/ui', {}, (w) => {
      w['ethereum'] = {
        request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
          calls.push(method);
          if (method === 'eth_requestAccounts') return [W.learner.address];
          if (method === 'personal_sign') return signMessageRaw(W.learner, Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8'));
          throw new Error(`unsupported ${method}`);
        },
      };
    });
    await p.until(() => p.q('article.scenario'), 'the scenarios');
    p.q('#connect-wallet')!.click();
    await p.until(() => p.text('#acting-as').startsWith('Signed in with wallet'), 'the wallet');
    const card = await p.until(() => p.q('article.scenario'), 'the scenarios, again');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    await p.until(() => p.q('#line') ?? p.q('#view .refusal'), 'the conversation');
    expect([p.q('#view .chat-handoff'), p.q('#check-lines'), (p.q('#view details.packet') as HTMLDetailsElement).open]).toEqual([null, null, true]);
    expect(p.text('#view .conversation')).toContain('Your AI assistant acts as your Interego account, not your wallet.');
    const signs = calls.filter((c) => c === 'personal_sign').length;
    const reads = p.asked.filter((x) => x === 'POST /pev/get_attempt').length;
    p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));
    p.w.dispatchEvent(new p.w.Event('focus'));
    await new Promise((r) => setTimeout(r, 200));
    expect([calls.filter((c) => c === 'personal_sign').length, p.asked.filter((x) => x === 'POST /pev/get_attempt').length]).toEqual([signs, reads]);
    // Writing a scenario with the wallet: the sentence is about drafting, not about a session to start or finish.
    p.w.location.hash = '#/author';
    await p.until(() => p.q('#draft-brief'), 'the author form');
    const draftCard = p.text('#view .draft-card');
    expect(draftCard).toContain('Your AI assistant acts as your Interego account, not your wallet. To draft in Claude or ChatGPT, sign in with Interego. Until then, copy and paste a draft below.');
    expect(draftCard).not.toMatch(/start the session|finish a session/);
    expect(p.errors).toEqual([]);
  }, SLOW);

  it('Getting started tells a judge to send a Member ID, and someone signed in with a wallet to sign in with Interego first: a wallet address can\'t assess from Claude or ChatGPT', async () => {
    /** Getting started, showing the Judge steps; resolves to the first of them. */
    const judgeSteps = async (q: Page): Promise<Element> => {
      await q.until(() => q.q('.checklist'), 'Getting started');
      q.all('.checklist button').find((b) => b.textContent === 'Show steps')?.click();
      q.all('.checklist [aria-pressed]').find((b) => b.textContent === 'Judge')!.click();
      return q.until(() => (q.all('.checklist__title-item').some((x) => (x.textContent ?? '').includes('Connect Claude or ChatGPT')) ? q.q('.checklist__item') : null), 'the judge steps');
    };
    const said = (item: Element): (string | null | undefined)[] => [item.querySelector('.checklist__title-item')?.textContent, item.querySelector('.checklist__text')?.textContent];

    // Signed in with Interego: the Member ID is what the admin adds, and copying it ticks the step.
    const p = await signedInPage(nm);
    const first = await judgeSteps(p);
    // The step that assesses pastes the learner's message into a new chat, as the message itself asks.
    expect(p.all('.checklist__item .checklist__text').map((x) => x.textContent)).toContain('Paste the message a learner sends you into a new chat with the Interego connector on. '
      + 'Your assistant proposes levels and waits for your go-ahead. You can\'t assess your own practice, and a reviewer has the final say.');
    expect([...said(first), first.querySelector('.checklist__action button')?.textContent]).toEqual(['Next step: Send your Member ID to your admin', 'Done when your admin has added you as a Judge.', 'Copy my Member ID']);
    (first.querySelector('.checklist__action button') as HTMLElement).click();
    await p.until(() => p.q('.checklist__item')?.getAttribute('data-state') === 'done', 'the judge\'s first step done');
    expect([p.copied, p.text('.checklist__item .checklist__title-item')]).toEqual([[PRINCIPAL], 'Done: Send your Member ID to your admin']);

    // Signed in with a wallet: the way is Interego sign-in first, and a copied wallet address ticks
    // the learner's step (a wallet will do there) but never the judge's.
    const copied: string[] = [];
    const who = W['second-learner'];
    const w = await openPage(nm, '/ui', {}, (win) => {
      Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string): Promise<void> => { copied.push(t); } } });
      win['ethereum'] = {
        request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
          if (method === 'eth_requestAccounts') return [who.address];
          if (method === 'personal_sign') return signMessageRaw(who, Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8'));
          throw new Error(`unsupported ${method}`);
        },
      };
    });
    await w.until(() => w.q('article.scenario'), 'the scenarios');
    w.q('#connect-wallet')!.click();
    await w.until(() => w.text('#acting-as').startsWith('Signed in with wallet'), 'the wallet');
    // Refused a step, the person is told to send the wallet address they signed in with, and offered it to copy.
    w.w.location.hash = '#/review';
    const refusal = await w.until(() => w.q('#view .refusal'), 'the access message');
    expect(refusal.textContent).toContain('Reviewing is for reviewers. Ask your admin to add you, and share your wallet address with them.');
    expect([...refusal.querySelectorAll('button')].map((b) => b.textContent)).toContain('Copy my wallet address');
    w.w.location.hash = '#/practice';
    await w.until(() => w.q('article.scenario'), 'the scenarios again');
    await w.until(() => w.q('.checklist'), 'Getting started');
    w.all('.checklist button').find((b) => b.textContent === 'Show steps')?.click();
    const copyWallet = await w.until(() => w.all('.checklist__action button').find((b) => b.textContent === 'Copy my wallet address'), 'the learner\'s wallet address to copy');
    copyWallet.click();
    await w.until(() => copied.length === 1 && w.all('.checklist__item')[1]?.getAttribute('data-state') === 'done', 'the learner\'s step done');
    expect(copied).toEqual([who.address]);
    const judge = await judgeSteps(w);
    expect(said(judge)).toEqual(['Next step: Sign in with Interego, then send your Member ID to your admin',
      'Claude or ChatGPT act as your Interego account, so a judge is added by Member ID. A judge added by wallet address can\'t assess from them.']);
    const signIn = judge.querySelector('.checklist__action [data-sign-in]');
    expect([signIn?.getAttribute('data-sign-in'), signIn?.textContent]).toEqual(['interego', 'Sign in with Interego']);
    expect(w.text('.checklist')).not.toContain('Copy my wallet address');
    // A sign-in that cannot start says why at the top of the page and takes focus there, since this
    // button sits far down Getting started; the button is ready to press again.
    const reach = w.w['fetch'] as (input: unknown, init?: RequestInit) => Promise<Response>;
    w.w['fetch'] = (input: unknown, init?: RequestInit): Promise<Response> =>
      String(input).includes('ui/oauth/start') ? Promise.resolve(new Response('unavailable', { status: 503 })) : reach(input, init);
    (signIn as HTMLElement).click();
    const problem = await w.until(() => w.q('#signing .callout'), 'why the sign-in could not start');
    expect([w.w.document.activeElement === problem, problem.getAttribute('role'), (signIn as HTMLButtonElement).disabled, signIn?.hasAttribute('aria-busy')]).toEqual([true, 'alert', false, false]);
    w.w['fetch'] = reach;
    // It starts the same sign-in as the header's button: the page leaves for the relay.
    (signIn as HTMLElement).click();
    await w.until(() => w.q('#interego-continue'), 'the way to Interego');
    expect(w.q('#interego-continue')?.getAttribute('href')?.startsWith(`${RELAY}/authorize?`)).toBe(true);
    await w.until(() => w.errors.includes(NAVIGATION), 'the navigation to the relay');
    expect([...p.errors, ...w.errors.filter((e) => e !== NAVIGATION)]).toEqual([]);
  }, SLOW);

  it('one rule for the pages and the web app: the guide, the landing page and the Connect dialog offer the connector on a workspace that signs people in with Interego, and none of them does on one that trusts a relay but names none (no PEV_RELAY_URL)', async () => {
    // As server.ts composes a workspace whose route trusts a relay while PEV_RELAY_URL is unset: the
    // handlers take the relay's signatures, and uiSignIn is off, so attachUi gets no interego.
    const noUrl = createPevHandlers({
      platformWallet: PLATFORM, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address], adminDids: [PRINCIPAL],
      fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110',
      relayDelegation: POLICY,
    } satisfies PevDeps) as Handlers;
    const signIn = ((ok((await noUrl['pev.list_scenarios']!({})) as Out))['bridge'] as Out)['interegoSignIn'] as Out;
    expect([signIn['relayUrl'], signIn['relayAddresses']]).toEqual([null, POLICY.relayAddresses]);
    const nu = await serve(undefined, { handlers: noUrl });

    const sectionOf = (page: string, id: string): string => { const at = page.indexOf(`<section id="${id}"`); return page.slice(at, page.indexOf('</section>', at)); };
    // A break point (<wbr>) is no space: the address reads whole.
    const words = (html: string): string => html.replace(/<wbr>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    /** What a workspace's guide, landing page and Connect dialog (for a person signed in with a wallet) offer a chat assistant. */
    async function offered(l: TestListener): Promise<{ guide: boolean; landing: boolean; dialog: boolean; guideChat: string; dialogText: string; p: Page }> {
      const help = await (await fetch(`${l.base}/ui/help`)).text();
      const landing = await (await fetch(`${l.base}/`, { headers: { accept: 'text/html' } })).text();
      const p = await openPage(l, '/ui', {}, (w) => {
        w['ethereum'] = {
          request: async ({ method, params }: { method: string; params?: string[] }): Promise<unknown> => {
            if (method === 'eth_requestAccounts') return [W.learner.address];
            if (method === 'personal_sign') return signMessageRaw(W.learner, Buffer.from(String(params?.[0]).slice(2), 'hex').toString('utf8'));
            throw new Error(`unsupported ${method}`);
          },
        };
      });
      await p.until(() => p.q('article.scenario'), 'the scenarios');
      p.q('#connect-wallet')!.click();
      await p.until(() => p.text('#acting-as').startsWith('Signed in with wallet'), 'the wallet');
      await p.until(() => p.q('#view .own-ai'), 'the practice callout');
      p.q('#connect-ai-button')!.click();
      const d = await p.until(() => p.q('#connect-ai[open]'), 'the Connect dialog');
      const guideChat = sectionOf(help, 'claude-chatgpt');
      return {
        guide: guideChat.includes('Add custom connector') && guideChat.includes('/mcp</code>'),
        landing: landing.includes('Set it up in four steps') && landing.includes('/mcp</code>'),
        // Signed in with a wallet, the dialog offers the connector by way of Interego sign-in, right beside it.
        dialog: d.querySelector('[data-sign-in="interego"]') !== null,
        guideChat: words(guideChat), dialogText: shownText(d).replace(/\s+/g, ' '), p,
      };
    }

    // Signs people in with Interego: all three offer the connector, at the address of that relay.
    const on = await offered(nm);
    expect([on.guide, on.landing, on.dialog]).toEqual([true, true, true]);
    expect(on.guideChat).toContain(`${RELAY}/mcp`);

    // Trusts a relay but names none: all three say copy and paste, in the same words, and none
    // offers a connector address, a passkey, Interego sign-in or the workspace details to copy.
    const off = await offered(nu);
    expect([off.guide, off.landing, off.dialog]).toEqual([false, false, false]);
    expect(off.guideChat).toContain('This workspace doesn\'t offer Interego sign-in, so Claude or ChatGPT can\'t connect to it.');
    expect(off.dialogText).toContain('This workspace doesn\'t offer Interego sign-in, so a chat assistant can\'t connect to it.');
    const help = await (await fetch(`${nu.base}/ui/help`)).text();
    const landing = await (await fetch(`${nu.base}/`, { headers: { accept: 'text/html' } })).text();
    expect(landing).toContain('This workspace doesn\'t offer Interego sign-in, so a chat assistant can\'t connect to it.');
    for (const page of [landing, sectionOf(help, 'claude-chatgpt')]) {
      for (const no of ['/mcp', 'relay.interego', 'Connect your AI', 'copy your workspace\'s details']) expect(page, no).not.toContain(no);
    }
    for (const page of [landing, help]) {
      for (const no of ['passkey', 'Copy your Member ID', 'Sign in with Interego', 'What the Interego sign-in service sees']) expect(page, no).not.toContain(no);
    }
    const p = off.p;
    expect([p.q('#connect-ai #connector-address'), p.q('#connect-ai #copy-workspace-details'), p.q('#connect-ai .connect-tabs')]).toEqual([null, null, null]);
    expect(p.q('#connect-ai #byok-section')?.textContent).toContain('Claude or ChatGPT needs no key here: copy and paste works with any plan.');
    p.q('#connect-ai .modal__footer .btn--primary')!.click();
    // Getting started, as the guide says it here: the wallet address to send, and judging with a tool of the judge's own.
    const all = await p.until(() => p.all('.checklist button').find((b) => (b.textContent ?? '').startsWith('Show all')), 'Getting started');
    all.click();
    await p.until(() => p.all('.checklist__item').length === 8, 'every learner step');
    expect(p.all('.checklist__title-item')[1]?.textContent).toBe('Next step: Copy your wallet address and send it to your admin');
    p.all('.checklist [aria-pressed]').find((b) => b.textContent === 'Admin')!.click();
    await p.until(() => p.all('.checklist__title-item').some((x) => (x.textContent ?? '').includes('Appoint at least one judge')), 'the admin steps');
    const adminSteps = p.all('.checklist__text').map((x) => x.textContent).join('\n');
    expect(adminSteps).toContain("Add them by their wallet address. A judge assesses with any chat app, and saves each assessment with a tool of their own that signs with their key: this web app can't save one yet.");
    expect(adminSteps).toContain('Team: paste their wallet address, choose Author, then Save change.');
    expect(adminSteps).not.toContain('Member ID');
    expect(sectionOf(help, 'admins')).toContain('This web app can\'t save an assessment yet, so each judge needs a tool of their own that signs it with their key.');
    p.all('.checklist [aria-pressed]').find((b) => b.textContent === 'Judge')!.click();
    await p.until(() => p.all('.checklist__title-item').some((x) => (x.textContent ?? '').includes('Save the assessment')), 'the judge steps');
    expect(p.all('.checklist__title-item').map((x) => x.textContent).join('|')).not.toContain('Connect Claude or ChatGPT');
    expect(p.text('.checklist')).toContain("This web app can't save an assessment yet. A tool of your own signs the details at the end of the learner's message with your key.");
    expect(sectionOf(help, 'judges')).toContain('This web app can\'t save an assessment yet: saving one takes a tool of your own (your own agent or script) that signs it with your key.');
    // The guide's learner steps name the buttons this workspace's session page shows.
    const card = await p.until(() => p.q('article.scenario'), 'the scenarios, again');
    card.querySelector<HTMLInputElement>('input[type=radio][value=no]')!.checked = true;
    card.querySelector<HTMLElement>(`button[data-action="${PEV_ACTION.startAttempt}"]`)!.click();
    await p.until(() => p.q('#line') ?? p.q('#view .refusal'), 'the conversation');
    expect([p.q('#copy-startup'), p.q(`#view button[data-action="${PEV_ACTION.counterpartPacket}"]`)?.textContent]).toEqual([null, 'Get the message for my AI']);
    expect(sectionOf(help, 'learners')).toContain('<strong>Get the message for my AI</strong>');
    expect(sectionOf(help, 'learners')).not.toContain('Copy the start-up message');
    expect([...on.p.errors, ...p.errors]).toEqual([]);
    // server.ts, started this way, tells the operator what the pages and the web app offer, and how to offer the connector.
    const run = await startServer({ PEV_TRUSTED_RELAY_ADDRESSES: RELAY_KEY.address, PEV_IDENTITY_HOST: IDH });
    expect([run.started, run.out]).toEqual([true, expect.stringContaining('web UI sign-in: off (PEV_RELAY_URL is not set): an act the relay signs is accepted, but the web app, the landing page and the guide offer no Interego sign-in and no connector, only copy and paste. Set PEV_RELAY_URL to the relay\'s URL to offer them')]);
  }, SLOW);
});

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

describe('server.ts: the Contact links', () => {
  it('takes PEV_CONTACT_URL through contactUrlOf: an https page or one mailto: address is used, anything else is ignored with a warning, and no line prints an address', async () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(server).toContain("const contactRaw = env('PEV_CONTACT_URL');");
    expect(server).toContain('const contactUrl = contactRaw !== undefined ? contactUrlOf(contactRaw) ?? undefined : undefined;');
    const ADDRESS = 'operator@example.org';
    const WARNS = /PEV_CONTACT_URL is (.*); it takes an https page or a mailto: link with one address and nothing after it\. Ignored: the Contact links go to the guide's contact section\./;
    const GUIDE = "Contact links: the guide's contact section (";
    const cases: readonly (readonly [string, string, string | null])[] = [
      ['https://example.org/book', 'Contact links: https://example.org/book (PEV_CONTACT_URL)', null],
      [`MAILTO:${ADDRESS}`, 'Contact links: a mailto: link to one address at example.org (the address itself is not printed) (PEV_CONTACT_URL)', null],
      ['javascript:alert(1)', GUIDE, '"javascript:alert(1)"'],
      ['http://example.org/book', GUIDE, '"http://example.org/book"'],
      [`mailto:${ADDRESS}?subject=x`, GUIDE, 'a value with an @ in it (not printed)'],
      [`mailto:${ADDRESS}%0Abcc:other@example.org`, GUIDE, 'a value with an @ in it (not printed)'],
    ];
    const runs = await Promise.all(cases.map(([contact]) => startServer({ PEV_CONTACT_URL: contact })));
    for (const [i, [contact, says, shown]] of cases.entries()) {
      const r = runs[i]!;
      expect([contact, r.started, r.out.includes(says), r.err.includes('Not listening')]).toEqual([contact, true, true, false]);
      expect([contact, WARNS.exec(r.err)?.[1] ?? null]).toEqual([contact, shown]);
      expect([contact, `${r.out}${r.err}`.includes(ADDRESS)]).toEqual([contact, false]);
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
