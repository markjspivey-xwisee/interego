/**
 * "Sign in with your Interego account" in the web UI, against a stubbed relay. No network: the
 * relay is an express app on loopback that does what deploy/mcp-relay does for each call the
 * bridge makes (its authorization server metadata, the token exchange with PKCE, and a stateless
 * tools/call of sign_request at /mcp with the OAuth access token, answered as handleSignRequest
 * builds it, in server-sent events and in JSON by turns), and the identity host is a map of DID
 * documents. The relay's /identity-token and REST /tool/ routes are there too, so that a bridge
 * calling them would be seen doing so; every test checks that it never does.
 *
 * The page is the shipped shell and app.js in jsdom. A browser keeps a tab's sessionStorage across
 * the visit to the relay's sign-in page; here the second window (the callback) is given the first
 * window's sessionStorage, which is that round trip, and the relay's sign-in page is the stub
 * minting a code for the URL the page sent the tab to.
 *
 * Checked: the button, the authorize URL (PKCE S256 over the verifier the tab keeps, a random
 * state, the client's metadata document as client_id), the callback (the code and state out of the
 * address bar, and the flow out of sessionStorage, before the page sends any request, so a failed
 * manifest read leaves neither behind; the state checked, the exchange server-side), a decisive act signed
 * through the relay and taken as relay-delegated from this UI's agent, the person named from the
 * bridge's answer and the agent from the relay's signed text, and sign-out; a token the relay has
 * ended (401 interego-sign-in-expired, the page forgetting it) and one that ends while the page is
 * open (forgotten when it ends); a state that is not the tab's refused with nothing exchanged and
 * the tab's own sign-in kept, and an `error` in the callback shown only on the answer to that
 * sign-in; POST /ui/relay/sign refusing without a bearer (and what else it refuses, never echoing
 * a bearer or a code); the relay limits, with a clock the test moves and X-Forwarded-For naming
 * each caller (a stranger refused by the bridge alone, a refused token not sent again, the person
 * signed in signing on, code exchanges inside a 15-minute budget; each person signed in on budgets
 * of their own, so one account's three tokens at their full rate and other accounts at theirs leave
 * another person signing; and the calls at once, two for one person, a pool for people signed in
 * and a smaller one for callers not signed in, against a relay that holds its answers); and the
 * client's metadata document as
 * the relay's CIMD reader requires it (deploy/mcp-relay/oauth-provider.ts), with Dynamic Client
 * Registration where the relay cannot read it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { importWallet, sha256Hex, signMessageRaw } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, parseEveryQueryPair, SIGN_IN_CLIENT_NAME, UI_CSP, type RelayLimits, type UiSignIn } from '../bridge/ui.js';
import { memoryPod, demoClock, DEMO_POD, DEMO_RECORD_KEY } from '../demo/run.js';
import type { RelayDelegationPolicy } from '../src/relay-delegated.js';

const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const listeners: TestListener[] = [];
const windows: Array<{ close(): void }> = [];
afterAll(async () => {
  // A signed-in page holds a timer until its token ends; closing the window clears it.
  for (const w of windows) w.close();
  for (const l of listeners) await l.close();
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Obj => (isObj(v) ? v : {});
const hex = (n: number): string => randomBytes(n).toString('hex');
const b64urlSha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64url');

/** The deployment URL the bridge is configured with: the CIMD client_id and the redirect URI are on it. The page itself talks to the loopback bridge. */
const DEPLOYED = 'https://wrd.example';
const IDENTITY = 'identity.interego.xwisee.com';
const USER_ID = 'u-pk-0a0b0c0d0e0f';
const PERSON = `did:web:${IDENTITY}:users:${USER_ID}`;
const RELAY = importWallet(`0x${sha256Hex('wrd-sign-in-test:relay')}`, 'agent', 'relay');
const SIGN_IN = 'Sign in with your Interego account';
const SESSION_KEY = 'wrd.interego.session';
const FLOW_KEY = 'wrd.interego.flow';
/** What the callback page says to an answer that does not carry the state this tab stored. */
const NOT_STARTED_HERE = 'This tab did not start this sign-in, so nothing in the answer was shown or exchanged.';

/**
 * The relay's rule for an OAuth client it does not know by name (surfaceAgentFromClient in
 * deploy/mcp-relay/server.ts): lower-case, runs of anything else as one hyphen, trimmed. That
 * slug, then `-<user id>`, is the agent of the session.
 */
const surfaceSlug = (clientName: string): string => clientName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const agentOf = (surface: string, user = USER_ID): string => `did:web:${IDENTITY}:agents:${surface}-${user}`;

interface Seen { readonly method: string; readonly path: string; readonly authorization: string | null; readonly body: unknown }
/** One POST /mcp as the relay received it, and how the stub answered it. */
interface McpCall {
  readonly id: unknown; readonly method: unknown; readonly tool: unknown; readonly session: string | null; readonly accept: string;
  readonly answeredAs: 'sse' | 'json' | 'refused';
}
interface StubRelay {
  readonly base: string;
  /** Every request the relay received, with the Authorization header it carried. */
  readonly seen: Seen[];
  /** Every POST /mcp, in order. */
  readonly mcp: McpCall[];
  /** Every access token and refresh token the token endpoint issued. */
  readonly issued: Array<{ readonly access: string; readonly refresh: string }>;
  /** The relay's sign-in page: the person (USER_ID unless given) signs in, and the relay mints a code for the authorize URL the page sent the tab to. */
  authorize(url: string, user?: string): Promise<string>;
  /** An access token the relay issued for this UI's surface, as its token endpoint would (scope `mcp` unless given), for USER_ID unless another user is given. */
  mint(scopes?: readonly string[], user?: string): string;
  /** The access token ends now: the relay answers 401 for it, as it does after its hour. */
  expire(token: string): void;
  /** Hold every POST /mcp from now until the function returned is called, as a relay slow to answer does. */
  hold(): () => void;
  /** How many POST /mcp are held now. */
  held(): number;
}

/** A stub of the relay's surfaces the bridge calls, signing as RELAY for the session's agent with `clock`'s time. */
async function stubRelay(bridgeBase: () => string, clock: { now(): Date }, opts: { readonly cimd?: boolean } = {}): Promise<StubRelay> {
  const app = express();
  const seen: Seen[] = [];
  const mcp: McpCall[] = [];
  const issued: Array<{ access: string; refresh: string }> = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; surface: string; scope: string; user: string }>();
  const access = new Map<string, { surface: string; scopes: readonly string[]; expiresAt: number; user: string }>();
  let gate: Promise<void> | null = null;
  let waiting = 0;
  const registered = new Map<string, Obj>();
  let base = '';
  app.use(express.json(), express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { seen.push({ method: req.method, path: req.path, authorization: req.headers.authorization ?? null, body: req.body }); next(); });
  const bearer = (h: string | undefined): string => /^Bearer (.+)$/.exec(h ?? '')?.[1] ?? '';
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: `${base}/`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'], scopes_supported: ['mcp', 'mcp:read', 'mcp:write'],
      ...(opts.cimd === false ? {} : { client_id_metadata_document_supported: true }),
    });
  });
  app.post('/register', (req, res) => {
    const id = hex(16);
    registered.set(id, objOf(req.body));
    res.status(201).json({ ...objOf(req.body), client_id: id });
  });
  app.post('/token', (req, res) => {
    const b = objOf(req.body);
    const c = codes.get(String(b['code']));
    if (!c || b['grant_type'] !== 'authorization_code' || b['client_id'] !== c.clientId || b['redirect_uri'] !== c.redirectUri
      || b64urlSha256(String(b['code_verifier'])) !== c.challenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: `Invalid or expired authorization code ${String(b['code'])}` });
      return;
    }
    codes.delete(String(b['code']));
    const t = `acc-${hex(16)}`;
    const refresh = `ref-${hex(16)}`;
    access.set(t, { surface: c.surface, scopes: c.scope.split(' '), expiresAt: Date.now() + 3600_000, user: c.user });
    issued.push({ access: t, refresh });
    // As the relay's: an hour's access token, and a refresh token the bridge must drop.
    res.json({ access_token: t, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: c.scope });
  });
  // The identity-server token and the REST tools: a bridge that called these would be holding (or
  // forwarding) the account's own bearer. They answer nothing useful; `seen` records any call.
  app.all(['/identity-token', '/tool/:name'], (_req, res) => { res.status(500).json({ error: 'the bridge must never call this route' }); });
  // POST /mcp as the relay serves a call with no mcp-session-id that is not initialize: the
  // stateless handler, behind the OAuth gate (a plain Bearer; 401 invalid_token for a token it does
  // not hold or that has ended, 403 insufficient_scope without an mcp scope). sign_request as
  // handleSignRequest: the caller's fields (underscore keys and the reserved ones dropped, podUrl
  // as pod_url), then the session's agent, the caller's own pod and the relay's timestamp. The
  // answer comes as server-sent events (a log notification first) and as JSON by turns; a nonce
  // starting stub- makes it a JSON-RPC error, a tool error or the tool's own {error}.
  app.post('/mcp', async (req, res) => {
    // A relay slow to answer: every call waits here, before its bearer is checked.
    if (gate !== null) { waiting += 1; await gate; waiting -= 1; }
    const token = bearer(req.headers.authorization);
    const a = access.get(token);
    const call = objOf(req.body);
    const params = objOf(call['params']);
    const record = (answeredAs: McpCall['answeredAs']): void => {
      mcp.push({ id: call['id'], method: call['method'], tool: params['name'], session: (req.headers['mcp-session-id'] as string | undefined) ?? null, accept: req.headers.accept ?? '', answeredAs });
    };
    if (!a || a.expiresAt <= Date.now()) {
      record('refused');
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.status(401).json({ error: 'invalid_token', error_description: a ? 'Token has expired' : 'Invalid access token: Token not found' });
      return;
    }
    if (!a.scopes.some((x) => ['mcp', 'mcp:read', 'mcp:write'].includes(x))) {
      record('refused');
      res.status(403).json({ error: 'insufficient_scope', error_description: 'Required scope: mcp (or mcp:read / mcp:write)' });
      return;
    }
    const accept = req.headers.accept ?? '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      record('refused');
      res.status(406).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' }, id: null });
      return;
    }
    const answeredAs = mcp.filter((m) => m.answeredAs !== 'refused').length % 2 === 0 ? 'sse' : 'json';
    record(answeredAs);
    const send = (message: Obj): void => {
      if (answeredAs === 'json') { res.json(message); return; }
      res.status(200).type('text/event-stream');
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'signing' } })}\n\n`);
      res.end(`event: message\nid: ${hex(4)}\ndata: ${JSON.stringify(message)}\n\n`);
    };
    const id = call['id'];
    if (call['jsonrpc'] !== '2.0' || call['method'] !== 'tools/call') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(call['method'])}` } }); return; }
    if (params['name'] !== 'sign_request') { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${String(params['name'])}` }], isError: true } }); return; }
    const reserved = new Set(['agent_id', 'timestamp', '_signature', '_signed_payload', 'subject_pod_url', 'payload', 'pod_name', 'owner_webid', 'owner_name']);
    const p = objOf(objOf(params['arguments'])['payload']);
    if (p['nonce'] === 'stub-rpc-error-0001') { send({ jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error for ${token}` } }); return; }
    if (p['nonce'] === 'stub-tool-error-001') { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: the delegation signer is unavailable for ${token}` }], isError: true } }); return; }
    if (p['nonce'] === 'stub-error-text-001') {
      const text = JSON.stringify({ error: 'sign_request: no authenticated session identity — sign_request signs only for the bound caller (authenticate first).' });
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as Obj } });
      return;
    }
    const safe: Obj = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_') && !reserved.has(k)));
    const asked = p['pod_url'] ?? p['podUrl'];
    delete safe['pod_url'];
    delete safe['podUrl'];
    if (typeof asked === 'string') safe['pod_url'] = asked;
    const text = JSON.stringify({ ...safe, agent_id: agentOf(a.surface, a.user), subject_pod_url: `https://pod.example/${a.user}/`, timestamp: clock.now().toISOString() });
    const answer = JSON.stringify({ _signature: await signMessageRaw(RELAY, `sha256:${sha256Hex(text)}`), _signed_payload: text, signed_as: agentOf(a.surface, a.user), signatureAuthority: 'relay' });
    // The relay attaches structuredContent; the JSON answers here carry the text alone, the form a lenient server sends.
    send({ jsonrpc: '2.0', id, result: answeredAs === 'sse' ? { content: [{ type: 'text', text: answer }], structuredContent: JSON.parse(answer) as Obj } : { content: [{ type: 'text', text: answer }] } });
  });
  const l = await listenLoopback(app);
  listeners.push(l);
  base = l.base;
  return {
    base, seen, mcp, issued,
    mint(scopes = ['mcp'], user = USER_ID) {
      const t = `acc-${hex(16)}`;
      access.set(t, { surface: surfaceSlug(SIGN_IN_CLIENT_NAME), scopes, expiresAt: Date.now() + 3600_000, user });
      return t;
    },
    hold() {
      let release: () => void = () => undefined;
      gate = new Promise<void>((r) => { release = r; });
      return () => { gate = null; release(); };
    },
    held: () => waiting,
    expire(token) {
      const a = access.get(token);
      if (a) access.set(token, { ...a, expiresAt: Date.now() - 1 });
    },
    async authorize(url, user = USER_ID) {
      const u = new URL(url);
      const p = Object.fromEntries(u.searchParams);
      if (`${u.origin}${u.pathname}` !== `${base}/authorize`) throw new Error(`the page went to ${u.origin}${u.pathname}, not the relay's authorize endpoint`);
      if (p['response_type'] !== 'code' || p['code_challenge_method'] !== 'S256' || !p['code_challenge'] || !p['state']) throw new Error(`not an authorization-code request with PKCE S256 and a state: ${url}`);
      const clientId = String(p['client_id']);
      let client: Obj;
      if (registered.has(clientId)) client = { ...registered.get(clientId), client_id: clientId };
      else {
        // The relay reads the client's metadata document from its client_id URL; here through the loopback bridge.
        client = objOf(await (await fetch(clientId.replace(DEPLOYED, bridgeBase()))).json());
        if (client['client_id'] !== clientId) throw new Error('the metadata document does not name itself');
      }
      if (!(client['redirect_uris'] as unknown[]).includes(p['redirect_uri'])) throw new Error('unregistered redirect_uri');
      const code = hex(32);
      codes.set(code, { challenge: String(p['code_challenge']), clientId, redirectUri: String(p['redirect_uri']), surface: surfaceSlug(String(client['client_name'])), scope: String(p['scope'] ?? 'mcp'), user });
      return code;
    },
  };
}

/** The identity host: each surface's agent of a person, controlled by them, as the live host serves them. */
const didDocuments = (fetched: string[]): RelayDelegationPolicy['fetchDidDocument'] => async (url) => {
  fetched.push(url);
  const m = new RegExp(`^https://${IDENTITY.replace(/\./g, '\\.')}/agents/([a-z-]+-(u-pk-[0-9a-f]{12}))/did\\.json$`).exec(url);
  if (!m) throw new Error('the identity host answered 404');
  return { id: `did:web:${IDENTITY}:agents:${m[1]}`, controller: `did:web:${IDENTITY}:users:${m[2]}` };
};

interface World {
  readonly bridge: string;
  readonly relay: StubRelay;
  readonly fetched: string[];
}
/** A bridge on loopback whose UI signs in through a stub relay; the person is an admin by their user DID. */
async function world(o: {
  readonly deployed?: string; readonly cimd?: boolean; readonly signIn?: 'on' | 'no-relay-trusted' | 'off'; readonly admin?: boolean;
  /** The sign-in routes' relay limits and their clock, and whether the app trusts one proxy hop (as server.ts does off loopback), so X-Forwarded-For names the client. */
  readonly limits?: Partial<RelayLimits>; readonly now?: () => number; readonly trustProxy?: boolean;
} = {}): Promise<World> {
  const clock = demoClock();
  const pod = memoryPod();
  const fetched: string[] = [];
  let bridgeBase = '';
  const relay = await stubRelay(() => bridgeBase, clock, o.cimd === undefined ? {} : { cimd: o.cimd });
  const policy: RelayDelegationPolicy = { relayAddresses: [RELAY.address.toLowerCase()], identityHost: IDENTITY, fetchDidDocument: didDocuments(fetched) };
  const deployed = o.deployed ?? DEPLOYED;
  const signIn: UiSignIn | undefined = o.signIn === 'off' ? undefined : {
    relayUrl: relay.base, policy: o.signIn === 'no-relay-trusted' ? null : policy, ...(o.limits ? { limits: o.limits } : {}), ...(o.now ? { now: o.now } : {}),
  };
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), recordKey: DEMO_RECORD_KEY,
    platform: { wallet: importWallet(`0x${sha256Hex('wrd-sign-in-test:platform')}`, 'agent', 'wrd-platform'), keyKind: 'demo' },
    adminDids: o.admin === false ? [] : [PERSON], relayDelegation: { ...policy, chatAgentsDecide: false, relayUrl: relay.base },
  });
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: wrdAffordances, handlers, deploymentUrl: deployed,
    middleware: (a) => {
      if (o.trustProxy === true) a.set('trust proxy', 1);
      attachUi(a, { base: deployed, ...(signIn ? { signIn } : {}) });
      parseEveryQueryPair(a);
    },
  }));
  listeners.push(l);
  bridgeBase = l.base;
  return { bridge: l.base, relay, fetched };
}

interface Logged { readonly origin: string; readonly method: string; readonly path: string; readonly query: string; readonly status: number; readonly body: Obj; readonly answer: unknown; readonly authorization: string | null }
interface Page {
  readonly window: JSDOM['window'];
  readonly log: Logged[];
  readonly errors: string[];
  /** The URLs the page sent this tab to (window.open with '_self'). */
  readonly opened: string[];
  /** Every request the page sent, failed ones included, with the address bar as it left. */
  readonly sent: Array<{ readonly path: string; readonly addressBar: string }>;
  text(): string;
  click(text: string): void;
  fill(input: Element, value: string): void;
  session(): Record<string, string>;
  until<T>(fn: () => T | null | undefined | false, what: string, ms?: number): Promise<T>;
}
/** The shipped shell at `path` and app.js in a jsdom window, its sessionStorage seeded with `session` (the tab's, across the relay's page); a request to `failPath` fails as a network error does. */
async function openPage(bridge: string, path: string, session: Record<string, string> = {}, failPath?: string): Promise<Page> {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => errors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...a: unknown[]) => errors.push(`console.error: ${a.map(String).join(' ')}`));
  const dom = new JSDOM(await (await fetch(`${bridge}${path}`)).text(), { url: `${bridge}${path}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  windows.push(w);
  for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  // jsdom has no SubtleCrypto and no TextEncoder; the page's PKCE challenge is computed with Node's, which are the same algorithms.
  Object.defineProperty(w.crypto, 'subtle', { value: globalThis.crypto.subtle, configurable: true });
  (w as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
  const opened: string[] = [];
  (w as unknown as { open: (u: string, t: string) => null }).open = (u, t) => { opened.push(`${t} ${u}`); return null; };
  (w as unknown as { scrollTo: () => void }).scrollTo = () => undefined;
  const log: Logged[] = [];
  const sent: Array<{ path: string; addressBar: string }> = [];
  w['fetch'] = async (input: unknown, init?: RequestInit): Promise<globalThis.Response> => {
    const url = new URL(String(input), w.location.href);
    sent.push({ path: url.pathname, addressBar: w.location.pathname + w.location.search });
    if (url.pathname === failPath) throw new TypeError('Failed to fetch');
    const r = await fetch(url, init);
    let body: Obj = {};
    try { body = typeof init?.body === 'string' ? objOf(JSON.parse(init.body)) : {}; } catch { body = {}; }
    let answer: unknown = null;
    try { answer = await r.clone().json(); } catch { answer = null; }
    log.push({ origin: url.origin, method: init?.method ?? 'GET', path: url.pathname, query: url.search, status: r.status, body, answer, authorization: new Headers(init?.headers).get('authorization') });
    return r;
  };
  w.eval(APP_JS);
  const d = w.document;
  return {
    window: w, log, errors, opened, sent,
    text: () => d.getElementById('app')?.textContent ?? '',
    click: (text) => {
      const b = [...d.querySelectorAll('button')].find((x) => x.textContent === text);
      if (!b) throw new Error(`no button "${text}"; the page shows: ${(d.getElementById('app')?.textContent ?? '').slice(0, 400)}`);
      b.click();
    },
    fill: (input, value) => {
      (input as HTMLInputElement).value = value;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    session: () => Object.fromEntries(Array.from({ length: w.sessionStorage.length }, (_, i) => w.sessionStorage.key(i) ?? '').map((k) => [k, w.sessionStorage.getItem(k) ?? ''])),
    async until<T>(fn: () => T | null | undefined | false, what: string, ms = 30_000): Promise<T> {
      const t0 = Date.now();
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`the page never showed ${what}; it shows: ${(d.getElementById('app')?.textContent ?? '').slice(0, 600)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

/** Press the button and take the authorize URL the page sends the tab to. */
async function startSignIn(page: Page): Promise<URL> {
  await page.until(() => page.text().includes(SIGN_IN), 'the sign-in button');
  page.click(SIGN_IN);
  const sent = await page.until(() => page.opened[0], 'the relay\'s sign-in page');
  expect(sent.startsWith('_self ')).toBe(true);
  return new URL(sent.slice('_self '.length));
}

const post = async (url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Obj; text: string; retryAfter: string | null }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let j: Obj = {};
  try { j = objOf(JSON.parse(text)); } catch { j = {}; }
  return { status: r.status, body: j, text, retryAfter: r.headers.get('retry-after') };
};

interface Signed { readonly status: number; readonly code: unknown; readonly retry: unknown; readonly header: string | null; readonly why: string }
/** What the relay limits are tested with, against a world whose app trusts one proxy hop, so X-Forwarded-For names each caller. */
function limitMoves(w: World): {
  relayed(path: string): number;
  sign(token: string, ip: string): Promise<Signed>;
  codeFor(user?: string): Promise<{ code: string; verifier: string }>;
  exchange(code: string, verifier: string, ip: string): ReturnType<typeof post>;
} {
  const from = (ip: string): Record<string, string> => ({ 'x-forwarded-for': ip });
  let nonce = 0;
  return {
    relayed: (path) => w.relay.seen.filter((s) => s.path === path).length,
    async sign(token, ip) {
      const r = await post(`${w.bridge}/ui/relay/sign`, { payload: { intent: 'wrd:read-records', podUrl: DEMO_POD, nonce: `limits-${String(nonce++).padStart(12, '0')}` } }, { authorization: `Bearer ${token}`, ...from(ip) });
      expect(r.text).not.toContain(token);
      return { status: r.status, code: r.body['code'] ?? null, retry: r.body['retryAfterSeconds'] ?? null, header: r.retryAfter, why: String(r.body['iep:refusalReason'] ?? '') };
    },
    /** A code the relay mints for this UI's client, as its sign-in page would for `user`, and the verifier it is bound to. */
    async codeFor(user = USER_ID) {
      const verifier = hex(24);
      const u = new URL(`${w.relay.base}/authorize`);
      for (const [k, v] of Object.entries({
        response_type: 'code', client_id: `${DEPLOYED}/ui/oauth/client.json`, redirect_uri: `${DEPLOYED}/ui/oauth/callback`, scope: 'mcp',
        state: hex(16), code_challenge: b64urlSha256(verifier), code_challenge_method: 'S256',
      })) u.searchParams.set(k, v);
      return { code: await w.relay.authorize(u.href, user), verifier };
    },
    exchange: (code, verifier, ip) => post(`${w.bridge}/ui/oauth/exchange`, { code, code_verifier: verifier, state: hex(16) }, from(ip)),
  };
}

describe('work-redesign web UI: sign in with your Interego account', () => {
  it('signs a person in through the relay and signs every act there: the button, an authorize URL with PKCE S256 and a state, the callback exchanged server-side, a decisive act taken as relay-delegated, the person and agent named from the bridge and the signed text, and sign-out', async () => {
    const w = await world();
    const first = await openPage(w.bridge, '/ui');
    const url = await startSignIn(first);
    expect(first.text()).toContain('No wallet, and not signed in');

    // The authorize URL: the client is its metadata document, the redirect its callback, both on the deployment URL.
    const p = Object.fromEntries(url.searchParams);
    expect(`${url.origin}${url.pathname}`).toBe(`${w.relay.base}/authorize`);
    expect(p).toMatchObject({
      response_type: 'code', client_id: `${DEPLOYED}/ui/oauth/client.json`, redirect_uri: `${DEPLOYED}/ui/oauth/callback`,
      scope: 'mcp', code_challenge_method: 'S256',
    });
    // The verifier and state stay in this tab's sessionStorage (never localStorage); the challenge is S256 of that verifier.
    const flow = objOf(JSON.parse(first.session()[FLOW_KEY] ?? '{}'));
    expect(String(flow['verifier'])).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p['code_challenge']).toBe(b64urlSha256(String(flow['verifier'])));
    expect(String(p['state'])).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(p['state']).toBe(flow['state']);
    expect(first.window.localStorage.length).toBe(0);
    expect(first.session()[SESSION_KEY]).toBeUndefined();
    // The page itself called only this bridge (connect-src 'self'); the relay saw nothing from it.
    expect(first.log.map((r) => r.origin).filter((o) => o !== new URL(w.bridge).origin)).toEqual([]);
    expect(w.relay.seen.filter((s) => s.path !== '/.well-known/oauth-authorization-server')).toEqual([]);

    // The relay's page signs the person in and sends the tab back with a code and the state.
    const code = await w.relay.authorize(url.href);
    const page = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${String(p['state'])}`, first.session());
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`), 'who is signed in');
    // The code left the address bar before anything else: every request, the manifest's read first, left from /ui; nothing the page asked for carried it, or the token, in a URL.
    expect(page.window.location.pathname + page.window.location.search).toBe('/ui');
    expect(page.sent[0]?.path).toBe('/affordances');
    expect(page.sent.filter((r) => r.addressBar !== '/ui')).toEqual([]);
    // The tab holds the relay's own OAuth access token, the one its token endpoint issued, and when it ends (about an hour from now); nothing else.
    const kept = objOf(JSON.parse(page.session()[SESSION_KEY] ?? '{}'));
    const token = String(kept['token']);
    expect(token).toMatch(/^acc-[0-9a-f]{32}$/);
    expect(w.relay.issued.map((t) => t.access)).toEqual([token]);
    expect(Object.keys(kept).sort()).toEqual(['expiresAt', 'token']);
    const left = Date.parse(String(kept['expiresAt'])) - Date.now();
    expect(left).toBeGreaterThan(3500_000);
    expect(left).toBeLessThanOrEqual(3600_000);
    expect(page.session()[FLOW_KEY]).toBeUndefined();
    expect(page.window.localStorage.length).toBe(0);
    expect(page.log.filter((r) => r.query.includes(code) || r.query.includes(token) || r.path.includes(token))).toEqual([]);
    // The exchange: the code with this tab's verifier, POSTed to the bridge, which went to the relay's token endpoint and nowhere else.
    const exchange = page.log.filter((r) => r.path === '/ui/oauth/exchange');
    expect(exchange.map((r) => `${r.method} ${r.status}`)).toEqual(['POST 200']);
    expect(exchange[0]?.body).toEqual({ code, code_verifier: flow['verifier'], state: p['state'] });
    expect(exchange[0]?.authorization).toBeNull();
    expect(objOf(exchange[0]?.answer)).toMatchObject({ status: 'signed-in', token, tokenType: 'Bearer', clientRegistration: 'client-id-metadata-document' });
    // The refresh token the relay's answer carried never reached the page: not in the exchange's answer, not in the tab.
    const refresh = String(w.relay.issued[0]?.refresh);
    expect(JSON.stringify(exchange[0]?.answer)).not.toContain(refresh);
    expect(JSON.stringify(exchange[0]?.answer)).not.toMatch(/refresh/i);
    expect(JSON.stringify(page.session())).not.toContain(refresh);
    const tokenCall = w.relay.seen.find((s) => s.path === '/token');
    expect(objOf(tokenCall?.body)).toEqual({ grant_type: 'authorization_code', code, code_verifier: flow['verifier'], redirect_uri: `${DEPLOYED}/ui/oauth/callback`, client_id: `${DEPLOYED}/ui/oauth/client.json` });
    // The first read was signed by the relay through the bridge, with the token; the bridge named the person.
    const signs = page.log.filter((r) => r.path === '/ui/relay/sign');
    expect(signs.map((r) => `${r.status} ${String(objOf(r.body['payload'])['intent'])}`)).toEqual(['200 wrd:read-records']);
    expect(signs[0]?.authorization).toBe(`Bearer ${token}`);
    expect(Object.keys(objOf(signs[0]?.answer)).sort()).toEqual(['_signature', '_signed_payload']);
    expect(objOf(signs[0]?.body['payload'])).toMatchObject({ intent: 'wrd:read-records', podUrl: DEMO_POD });
    expect(String(objOf(signs[0]?.body['payload'])['nonce'])).toMatch(/^[0-9a-f]{32}$/);
    expect(objOf(signs[0]?.body['payload'])['issuedAt']).toBeUndefined();
    const whoami = page.log.filter((r) => r.path === '/ui/relay/whoami');
    expect(whoami.map((r) => r.status)).toEqual([200]);
    expect(objOf(whoami[0]?.answer)).toMatchObject({ authority: 'relay-delegated', principal: PERSON, agentId: agentOf('work-redesign'), relaySigner: RELAY.address.toLowerCase() });
    const firstRead = page.log.filter((r) => r.path === '/wrd/read_records');
    expect(firstRead.map((r) => r.status)).toEqual([200]);
    expect(firstRead[0]?.body['envelope']).toEqual(signs[0]?.answer);
    // The person's user DID is shown where the page shows an acting address.
    expect(page.text()).toContain(`Your Interego user DID ${PERSON}`);
    expect(page.text()).toContain('relay-attested, not a key you hold');

    // A decisive act from this UI's agent: an admin (by user DID) declares a kind of task. The relay signs; the signed form is the act's body.
    page.click('Roles');
    await page.until(() => page.text().includes('Declare a kind of task (admin)'), 'the roles view');
    const form = [...page.window.document.querySelectorAll('details.card')].find((x) => x.querySelector('summary')?.textContent === 'Declare a kind of task (admin)');
    const inputs = [...(form?.querySelectorAll('input') ?? [])];
    expect(inputs).toHaveLength(3);
    page.fill(inputs[0]!, 'invoice-matching');
    page.fill(inputs[1]!, 'Invoice matching');
    page.fill(inputs[2]!, 'Match an invoice to its purchase order.');
    page.click('Sign');
    await page.until(() => page.log.some((r) => r.path === '/wrd/update_registry'), 'the registry change');
    await page.until(() => page.text().includes('invoice-matching') && !page.text().includes('Signing and sending'), 'the kind of task');
    const change = page.log.filter((r) => r.path === '/wrd/update_registry');
    expect(change.map((r) => r.status)).toEqual([200]);
    expect(Object.keys(change[0]?.body ?? {}).sort()).toEqual(['_signature', '_signed_payload']);
    const signedText = objOf(JSON.parse(String(change[0]?.body['_signed_payload'])));
    expect(signedText).toMatchObject({ intent: 'wrd:update-registry', pod_url: DEMO_POD, agent_id: agentOf('work-redesign'), taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order.' }] });
    expect(signedText['podUrl']).toBeUndefined();
    expect(objOf(change[0]?.answer)['status']).toBe('registered');
    // The person was named once: the agent did not change, so no second whoami; the read model's registry head says relay-delegated.
    expect(page.log.filter((r) => r.path === '/ui/relay/whoami')).toHaveLength(1);
    const lastRead = [...page.log].reverse().find((r) => r.path === '/wrd/read_records' && r.status === 200);
    expect(objOf(objOf(objOf(lastRead?.answer)['registry'])['head'])).toMatchObject({
      authority: 'relay-delegated', authorisedBy: PERSON, agentId: agentOf('work-redesign'), relaySigner: RELAY.address.toLowerCase(), signedBy: [PERSON],
    });
    // The agent's document was read from the identity host (and kept): the slug came from the client's name.
    expect(surfaceSlug(SIGN_IN_CLIENT_NAME)).toBe('work-redesign');
    expect([...new Set(w.fetched)]).toEqual([`https://${IDENTITY}/agents/work-redesign-${USER_ID}/did.json`]);
    // The access token went to the relay only at /mcp, to sign; nothing else the relay saw carried a bearer, and /identity-token and /tool/ were never called.
    expect(w.relay.seen.filter((s) => s.authorization !== null).map((s) => `${s.method} ${s.path} ${s.authorization === `Bearer ${token}` ? 'token' : 'other'}`))
      .toEqual(['POST /mcp token', 'POST /mcp token']);
    expect(w.relay.seen.filter((s) => s.path === '/identity-token' || s.path.startsWith('/tool/'))).toEqual([]);
    // Each was a stateless tools/call of sign_request: no initialize, no session, a fresh id, both media types accepted; answered in SSE, then JSON.
    expect(w.relay.mcp.map((m) => [m.method, m.tool, m.session, m.answeredAs])).toEqual([['tools/call', 'sign_request', null, 'sse'], ['tools/call', 'sign_request', null, 'json']]);
    expect(w.relay.mcp.every((m) => m.accept.includes('application/json') && m.accept.includes('text/event-stream'))).toBe(true);
    const ids = w.relay.mcp.map((m) => m.id);
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(objOf(w.relay.seen.filter((s) => s.path === '/mcp')[0]?.body)).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'sign_request', arguments: { payload: objOf(signs[0]?.body['payload']) } } });

    // Sign-out: the token is forgotten in this tab, the page says plainly that nothing was revoked, offers the sign-in again, and nothing after it carries a bearer.
    expect(page.text()).toContain('This page holds the relay\'s OAuth access token for your sign-in, good for about an hour');
    expect(page.text()).toContain('the relay will also trade it, at its /identity-token, for the identity-server token behind your sign-in: that one is good for up to a day and works on your account itself');
    expect(page.text()).not.toContain('never reaches');
    const before = page.log.length;
    page.click('Sign out');
    await page.until(() => page.text().includes('Signed out: this tab no longer holds the relay\'s access token for your sign-in.'), 'the sign-out');
    expect(page.text()).toContain('Nothing was revoked: the relay offers no way to revoke it, so the token stays good at the relay until it ends, about an hour after you signed in');
    expect(page.text()).toContain('trade it at the relay for the identity-server token behind your sign-in, which works on your account itself (linking a wallet, removing sign-in methods, deleting the account) for up to a day, and one already traded stays good that long');
    expect(page.text()).not.toContain('untouched');
    expect(page.session()[SESSION_KEY]).toBeUndefined();
    expect(page.text()).toContain(SIGN_IN);
    expect(page.text()).not.toContain(`Signed in as ${PERSON}`);
    expect(page.log.slice(before).filter((r) => r.authorization !== null)).toEqual([]);
    expect([...first.errors, ...page.errors]).toEqual([]);
  }, 120_000);

  it('refuses a callback whose state is not the one this tab stored, or that this tab never started, exchanging nothing and keeping the sign-in this tab started, which its own answer still finishes', async () => {
    const w = await world();
    const first = await openPage(w.bridge, '/ui');
    const url = await startSignIn(first);
    const code = await w.relay.authorize(url.href);
    const flow = first.session()[FLOW_KEY];
    expect(flow).toBeDefined();
    const forged = 'A'.repeat(32);
    const page = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${forged}`, first.session());
    await page.until(() => page.text().includes(NOT_STARTED_HERE), 'the refusal');
    expect(page.text()).toContain('the answer does not carry the state this tab stored when it sent you to sign in, so it is not the sign-in you started; that sign-in is still waiting for its own answer');
    expect(page.log.filter((r) => r.path.startsWith('/ui/oauth/exchange') || r.path.startsWith('/ui/relay/'))).toEqual([]);
    expect(w.relay.seen.filter((s) => s.path === '/token')).toEqual([]);
    // The code and state left the address bar before any request; the flow this tab stored is kept as it was, and nothing else is.
    expect(page.window.location.pathname + page.window.location.search).toBe('/ui');
    expect(page.sent.filter((r) => r.addressBar !== '/ui')).toEqual([]);
    expect(page.session()).toEqual({ [FLOW_KEY]: flow });
    expect(page.text()).toContain(SIGN_IN);
    // The relay's own answer, arriving after that one, still finishes the sign-in this tab started.
    const real = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${String(url.searchParams.get('state'))}`, page.session());
    await real.until(() => real.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`), 'who is signed in');
    expect(real.log.filter((r) => r.path === '/ui/oauth/exchange').map((r) => r.status)).toEqual([200]);
    expect(real.session()[FLOW_KEY]).toBeUndefined();
    expect(w.relay.issued).toHaveLength(1);
    // A tab that started no sign-in (another tab's code, say) is refused the same way.
    const fresh = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${String(url.searchParams.get('state'))}`);
    await fresh.until(() => fresh.text().includes('this tab holds no sign-in it started'), 'the refusal');
    expect(fresh.text()).toContain(NOT_STARTED_HERE);
    expect(fresh.log.filter((r) => r.path === '/ui/oauth/exchange')).toEqual([]);
    // And the code itself, sent to the bridge with another verifier, is refused by the relay; the answer does not repeat it.
    const wrong = await post(`${w.bridge}/ui/oauth/exchange`, { code, code_verifier: 'v'.repeat(43), state: forged });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ kind: 'refusal', error: 'The Interego relay did not take this sign-in. Sign in again.' });
    expect(String(wrong.body['iep:refusalReason'])).toMatch(/^the relay's token endpoint answered 400: invalid_grant \(Invalid or expired authorization code \[withheld\]\)$/);
    expect(wrong.text).not.toContain(code);
    for (const [body, why] of [
      [{ code, code_verifier: 'short', state: forged }, /code_verifier must be the PKCE verifier/],
      [{ code, code_verifier: 'v'.repeat(43), state: 'x' }, /state must be the state this page made/],
      [{ code_verifier: 'v'.repeat(43), state: forged }, /code must be the authorization code/],
    ] as const) {
      const r = await post(`${w.bridge}/ui/oauth/exchange`, body);
      expect([r.status, String(r.body['iep:refusalReason'])]).toEqual([400, expect.stringMatching(why)]);
    }
    expect([...first.errors, ...page.errors, ...real.errors, ...fresh.errors]).toEqual([]);
  }, 60_000);

  it('shows an error the relay sent only on the answer to the sign-in this tab started: a link anyone made, with no state or another, shows none of its text and drops nothing, and an expired sign-in goes', async () => {
    const w = await world();
    const first = await openPage(w.bridge, '/ui');
    const url = await startSignIn(first);
    const flow = first.session()[FLOW_KEY];
    expect(flow).toBeDefined();
    const state = String(url.searchParams.get('state'));
    const planted = 'Account locked. Call support at +1 555 0100 and read them your code.';
    for (const query of [
      `?error=${encodeURIComponent(planted)}`,
      `?error=access_denied&error_description=${encodeURIComponent(planted)}&state=${'B'.repeat(32)}`,
      `?code=${'c'.repeat(32)}`,
    ]) {
      const p = await openPage(w.bridge, `/ui/oauth/callback${query}`, first.session());
      await p.until(() => p.text().includes(NOT_STARTED_HERE), 'the refusal');
      expect(p.text()).toContain('that sign-in is still waiting for its own answer');
      expect(p.text()).not.toContain('Account locked');
      expect(p.text()).not.toContain('access_denied');
      expect(p.text()).not.toContain('The Interego relay did not sign you in.');
      // Out of the address bar first, the sign-in this tab started kept, and nothing exchanged.
      expect(p.window.location.pathname + p.window.location.search).toBe('/ui');
      expect(p.sent.filter((r) => r.addressBar !== '/ui')).toEqual([]);
      expect(p.session()).toEqual({ [FLOW_KEY]: flow });
      expect(p.log.filter((r) => r.path === '/ui/oauth/exchange')).toEqual([]);
      // Nor with no sign-in pending in the tab at all.
      const none = await openPage(w.bridge, `/ui/oauth/callback${query}`);
      await none.until(() => none.text().includes('this tab holds no sign-in it started'), 'the refusal');
      expect(none.text()).not.toContain('Account locked');
      expect(none.session()).toEqual({});
      expect([...p.errors, ...none.errors]).toEqual([]);
    }
    // The relay's own answer to this tab's sign-in: its error is shown (as text), and the sign-in is over.
    const answer = await openPage(w.bridge, `/ui/oauth/callback?error=access_denied&error_description=${encodeURIComponent('The person declined.')}&state=${state}`, first.session());
    await answer.until(() => answer.text().includes('The Interego relay did not sign you in.'), 'the relay\'s error');
    expect(answer.text()).toContain('access_denied: The person declined.');
    expect(answer.text()).not.toContain(NOT_STARTED_HERE);
    expect(answer.session()).toEqual({});
    expect(answer.window.location.pathname + answer.window.location.search).toBe('/ui');
    // A sign-in started over ten minutes ago goes, whatever the answer: with another state, nothing of it is shown either.
    const old = JSON.stringify({ ...objOf(JSON.parse(flow ?? '{}')), at: Date.now() - 11 * 60_000 });
    const stale = await openPage(w.bridge, `/ui/oauth/callback?error=${encodeURIComponent(planted)}&state=${'B'.repeat(32)}`, { [FLOW_KEY]: old });
    await stale.until(() => stale.text().includes('the sign-in this tab started is over ten minutes old, so it was dropped'), 'the expired refusal');
    expect(stale.text()).not.toContain('Account locked');
    expect(stale.session()).toEqual({});
    const late = await openPage(w.bridge, `/ui/oauth/callback?code=${'c'.repeat(32)}&state=${state}`, { [FLOW_KEY]: old });
    await late.until(() => late.text().includes('the sign-in was started more than ten minutes ago'), 'the late answer refused');
    expect(late.session()).toEqual({});
    expect(late.log.filter((r) => r.path === '/ui/oauth/exchange')).toEqual([]);
    expect(w.relay.seen.filter((s) => s.path === '/token')).toEqual([]);
    expect([...first.errors, ...answer.errors, ...stale.errors, ...late.errors]).toEqual([]);
  }, 90_000);

  it('takes the code and state out of the address bar, and the flow out of sessionStorage, before the callback page sends any request, so a manifest read that fails leaves neither behind and exchanges nothing', async () => {
    const w = await world();
    const first = await openPage(w.bridge, '/ui');
    const url = await startSignIn(first);
    const code = await w.relay.authorize(url.href);
    const page = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${String(url.searchParams.get('state'))}`, first.session(), '/affordances');
    await page.until(() => page.text().includes('The affordance manifest could not be read'), 'the failed manifest read');
    expect(page.sent).toEqual([{ path: '/affordances', addressBar: '/ui' }]);
    expect(page.window.location.pathname + page.window.location.search).toBe('/ui');
    expect(page.session()).toEqual({});
    expect(w.relay.seen.filter((s) => s.path === '/token')).toEqual([]);
    expect([...first.errors, ...page.errors]).toEqual([]);
  }, 60_000);

  it('shows a person no one has registered their user DID, from the bridge\'s answer, to send to an admin, while their read is refused', async () => {
    const w = await world({ admin: false });
    const first = await openPage(w.bridge, '/ui');
    const url = await startSignIn(first);
    const code = await w.relay.authorize(url.href);
    const page = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${String(url.searchParams.get('state'))}`, first.session());
    await page.until(() => page.text().includes('Only an admin or a key in this pod'), 'the refused read');
    expect(page.log.filter((r) => r.path === '/wrd/read_records').map((r) => r.status)).toEqual([403]);
    expect(page.text()).toContain(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`);
    expect(page.text()).toContain(`This is who you are to this bridge: send it to an admin of this pod to be registered. ${PERSON}`);
    // Their copy is still offered, signed through the relay like everything else.
    expect(page.text()).toContain('Download my record');
    expect(w.relay.seen.filter((s) => s.path === '/identity-token' || s.path.startsWith('/tool/'))).toEqual([]);
    expect([...first.errors, ...page.errors]).toEqual([]);
  }, 60_000);

  it('forgets the access token: one the relay has ended at its first signature (401 interego-sign-in-expired), one that ends while the page is open when it ends, and one already past its end before anything is sent, offering the sign-in again each time', async () => {
    const w = await world();
    const session = (token: string, inMs: number): Record<string, string> => ({ [SESSION_KEY]: JSON.stringify({ token, expiresAt: new Date(Date.now() + inMs).toISOString() }) });

    // The relay ended it (its hour is up there, say): the bridge answers 401 interego-sign-in-expired and the page forgets it.
    const ended = w.relay.mint();
    w.relay.expire(ended);
    const page = await openPage(w.bridge, '/ui', session(ended, 3600_000));
    await page.until(() => page.log.some((r) => r.path === '/ui/relay/sign') && page.text().includes(SIGN_IN), 'the sign-in offered again');
    expect(page.log.filter((r) => r.path === '/ui/relay/sign').map((r) => [r.status, objOf(r.answer)['code']])).toEqual([[401, 'interego-sign-in-expired']]);
    expect(page.text()).toContain('Your Interego sign-in has ended: sign in again.');
    expect(page.text()).not.toContain(`Signed in as ${PERSON}`);
    expect(page.session()[SESSION_KEY]).toBeUndefined();
    expect(page.log.filter((r) => r.path === '/wrd/read_records')).toEqual([]);
    expect(page.text()).not.toContain(ended);

    // It ends while the page is open: the page signs with it until then, and forgets it when it ends, sending it nowhere after.
    const live = w.relay.mint();
    const soon = await openPage(w.bridge, '/ui', session(live, 8_000));
    await soon.until(() => soon.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`), 'who is signed in');
    expect(soon.log.filter((r) => r.path === '/ui/relay/sign').map((r) => r.status)).toEqual([200]);
    const before = soon.log.length;
    await soon.until(() => soon.session()[SESSION_KEY] === undefined && soon.text().includes('Your Interego sign-in has ended: sign in again.') && soon.text().includes(SIGN_IN), 'the sign-in ended at its end', 20_000);
    expect(soon.text()).not.toContain(`Signed in as ${PERSON}`);
    expect(soon.log.slice(before).filter((r) => r.authorization !== null)).toEqual([]);
    expect(w.relay.seen.filter((s) => s.authorization === `Bearer ${live}`).map((s) => s.path)).toEqual(['/mcp']);

    // Already past its end when the page opens: forgotten before anything is sent.
    const gone = await openPage(w.bridge, '/ui', session(w.relay.mint(), -1_000));
    await gone.until(() => gone.text().includes(SIGN_IN), 'the sign-in button');
    expect(gone.session()[SESSION_KEY]).toBeUndefined();
    expect(gone.log.filter((r) => r.path === '/ui/relay/sign' || r.authorization !== null)).toEqual([]);
    expect(gone.text()).toContain('Your Interego sign-in has ended: sign in again.');

    expect(w.relay.seen.filter((s) => s.path === '/identity-token' || s.path.startsWith('/tool/'))).toEqual([]);
    expect([...page.errors, ...soon.errors, ...gone.errors]).toEqual([]);
  }, 90_000);

  it('POST /ui/relay/sign refuses without a bearer, asking the relay nothing; a token the relay does not take or has ended is 401 interego-sign-in-expired; a JSON-RPC error, a tool error and the tool\'s own {error} are refused; it refuses what the relay would not sign as sent, another site\'s page and an oversized body, and repeats no bearer', async () => {
    const w = await world();
    const sign = `${w.bridge}/ui/relay/sign`;
    const payload = { intent: 'wrd:read-records', podUrl: DEMO_POD, nonce: 'sign-route-0000001' };
    const asked = (): number => w.relay.seen.filter((s) => s.path === '/mcp').length;

    const bare = await post(sign, { payload });
    expect(bare.status).toBe(401);
    expect(bare.body).toMatchObject({ kind: 'refusal', error: 'Sign in with your Interego account first.' });
    expect(String(bare.body['iep:refusalReason'])).toMatch(/Authorization: Bearer <token>\), and this request carries none$/);
    for (const h of ['Basic dXNlcjpwdw==', 'Bearer', 'Bearer two words']) {
      expect((await post(sign, { payload }, { authorization: h })).status, h).toBe(401);
    }
    expect(asked()).toBe(0);

    // A token the relay does not know: 401 interego-sign-in-expired, and the bearer is not repeated.
    const stale = `acc-${'0'.repeat(32)}`;
    const refused = await post(sign, { payload }, { authorization: `Bearer ${stale}` });
    expect([refused.status, refused.body['error'], refused.body['code']]).toEqual([401, 'Your Interego sign-in has ended: sign in again.', 'interego-sign-in-expired']);
    expect(String(refused.body['iep:refusalReason'])).toBe('the relay\'s /mcp answered 401: invalid_token (Invalid access token: Token not found): it no longer takes the access token this tab holds (it has ended, or is not the relay\'s)');
    expect(refused.text).not.toContain(stale);
    expect(asked()).toBe(1);
    // Refused again from memory for a while, the relay asked nothing more.
    const again = await post(sign, { payload: { ...payload, nonce: 'sign-route-0000003' } }, { authorization: `Bearer ${stale}` });
    expect([again.status, again.body['error'], again.body['code']]).toEqual([401, 'Your Interego sign-in has ended: sign in again.', 'interego-sign-in-expired']);
    expect(String(again.body['iep:refusalReason'])).toMatch(/refused again here without asking the relay$/);
    expect(again.text).not.toContain(stale);
    expect(asked()).toBe(1);

    // A token the relay issued, which signs until it ends; then 401 interego-sign-in-expired, without repeating it.
    const live = w.relay.mint();
    const signed = await post(sign, { payload }, { authorization: `Bearer ${live}` });
    expect(signed.status).toBe(200);
    expect(Object.keys(signed.body).sort()).toEqual(['_signature', '_signed_payload']);
    expect(objOf(JSON.parse(String(signed.body['_signed_payload'])))).toMatchObject({ intent: 'wrd:read-records', nonce: payload.nonce, pod_url: DEMO_POD, agent_id: agentOf('work-redesign') });
    w.relay.expire(live);
    const ended = await post(sign, { payload: { ...payload, nonce: 'sign-route-0000002' } }, { authorization: `Bearer ${live}` });
    expect([ended.status, ended.body['code']]).toEqual([401, 'interego-sign-in-expired']);
    expect(String(ended.body['iep:refusalReason'])).toMatch(/^the relay's \/mcp answered 401: invalid_token \(Token has expired\)/);
    expect(ended.text).not.toContain(live);
    // A token without an mcp scope cannot sign: 401 too, so the page signs in again.
    const narrow = w.relay.mint(['openid']);
    const scoped = await post(sign, { payload }, { authorization: `Bearer ${narrow}` });
    expect([scoped.status, scoped.body['code'], scoped.body['error']]).toEqual([401, 'interego-sign-in-refused', 'The Interego relay did not accept your sign-in. Sign in again.']);
    expect(scoped.text).not.toContain(narrow);
    const narrowAsked = asked();
    const scopedAgain = await post(sign, { payload }, { authorization: `Bearer ${narrow}` });
    expect([scopedAgain.status, scopedAgain.body['code'], asked()]).toEqual([401, 'interego-sign-in-refused', narrowAsked]);

    // The relay's JSON-RPC error, a tool error (isError) and the tool's own {error}: refused, the token withheld from the relay's words.
    const other = w.relay.mint();
    for (const [nonce, why] of [
      ['stub-rpc-error-0001', /^the relay answered JSON-RPC error -32603: Internal error for \[withheld\]$/],
      ['stub-tool-error-001', /^the relay's sign_request failed: Error: the delegation signer is unavailable for \[withheld\]$/],
      ['stub-error-text-001', /^the relay's sign_request answered: sign_request: no authenticated session identity/],
    ] as const) {
      const r = await post(sign, { payload: { ...payload, nonce } }, { authorization: `Bearer ${other}` });
      expect([r.status, r.body['error'], String(r.body['iep:refusalReason'])], nonce).toEqual([502, 'The Interego relay did not sign this payload.', expect.stringMatching(why)]);
      expect(r.text).not.toContain(other);
    }
    // Every one of these was a stateless tools/call of sign_request, and none went to /identity-token or /tool/.
    expect(w.relay.mcp.map((m) => `${String(m.method)} ${String(m.tool)} ${m.session ?? 'no-session'}`)).toEqual(Array(w.relay.mcp.length).fill('tools/call sign_request no-session'));
    expect(w.relay.seen.filter((s) => s.path === '/identity-token' || s.path.startsWith('/tool/'))).toEqual([]);
    const beforeShape = asked();

    // What the relay would not sign as sent, an agent's run, and anything that is not this bridge's intent: refused here.
    const auth = { authorization: `Bearer ${stale}` };
    for (const [p, why] of [
      [{ ...payload, intent: 'wrd:agent-run' }, /wrd:agent-run is never relay-signed/],
      [{ ...payload, intent: 'foxxi:review-record' }, /payload\.intent must be one of this bridge's intents/],
      [{ ...payload, agent_id: 'did:web:elsewhere' }, /payload holds "agent_id", which the relay sets itself or drops/],
      [{ ...payload, _session_agent_did: 'x' }, /payload holds "_session_agent_did"/],
      ['not an object', /send \{payload\}/],
    ] as const) {
      const r = await post(sign, { payload: p }, auth);
      expect([r.status, String(r.body['iep:refusalReason'])]).toEqual([400, expect.stringMatching(why)]);
    }
    // Another site's page, a body that is not JSON, one over the limit.
    expect((await post(sign, { payload }, { ...auth, origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(sign, { method: 'POST', headers: { 'content-type': 'text/plain', ...auth }, body: JSON.stringify({ payload }) })).status).toBe(415);
    expect((await post(sign, { payload: { ...payload, note: 'x'.repeat(70 * 1024) } }, auth)).status).toBe(413);
    expect(asked()).toBe(beforeShape);
    // The same origin as the page passes the Origin check (and, with a token the relay has not refused yet, reaches the relay).
    expect((await post(sign, { payload }, { authorization: `Bearer acc-${'1'.repeat(32)}`, origin: w.bridge })).status).toBe(401);
    expect(asked()).toBe(beforeShape + 1);

    // The one sign that went through named its person, from the agent's document (the same one whoami reads); none that failed read any.
    expect([...new Set(w.fetched)]).toEqual([`https://${IDENTITY}/agents/work-redesign-${USER_ID}/did.json`]);
    // whoami: only a request a trusted relay signed names anyone.
    const fetchedBefore = w.fetched.length;
    const unsigned = await post(`${w.bridge}/ui/relay/whoami`, { _signed_payload: JSON.stringify({ agent_id: agentOf('work-redesign') }), _signature: `0x${'1b'.repeat(65)}` });
    expect(unsigned.status).toBe(401);
    expect(String(unsigned.body['iep:refusalReason'])).toMatch(/^(signature-unrecoverable|relay-not-trusted): /);
    expect(w.fetched).toHaveLength(fetchedBefore);
  }, 60_000);

  it('keeps its relay calls under limits a stranger cannot spend: made-up tokens and codes from one address reach the relay a few times and are then refused by the bridge alone, a refused token is not sent again, strangers from many addresses reach only what is left for callers not signed in while the person signed in goes on signing, and code exchanges stay inside a 15-minute budget', async () => {
    let clock = Date.now();
    const w = await world({ trustProxy: true, now: () => clock, limits: { unproven: 8, unprovenPerClient: 4, perSignIn: 5, exchanges: 7, exchangesPerClient: 5 } });
    const { relayed, sign, codeFor, exchange } = limitMoves(w);

    // A person signs in from 203.0.113.1: the relay's metadata and the code, two relay calls; then she signs.
    const mine = await codeFor();
    const ex = await exchange(mine.code, mine.verifier, '203.0.113.1');
    expect([ex.status, relayed('/.well-known/oauth-authorization-server') + relayed('/token')]).toEqual([200, 2]);
    const bearer = String(ex.body['token']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);

    // A stranger with made-up tokens, from one address: four reach the relay (each refused), then the bridge refuses on its own, saying when to try again.
    const signs = relayed('/mcp');
    const made = Array.from({ length: 10 }, (_, i) => `acc-madeup${i}${'a'.repeat(20)}`);
    const one: Signed[] = [];
    for (const t of made) one.push(await sign(t, '198.51.100.7'));
    expect(one.map((r) => r.code)).toEqual([...Array<string>(4).fill('interego-sign-in-expired'), ...Array<string>(6).fill('relay-calls-limited')]);
    expect([one[4]?.status, Number(one[4]?.retry) > 0, one[4]?.header]).toEqual([429, true, String(one[4]?.retry)]);
    expect(relayed('/mcp') - signs).toBe(4);
    // A token the relay refused is refused again from memory, from any address, and not sent to the relay again.
    expect([(await sign(made[0] ?? '', '198.51.100.8')).code, relayed('/mcp') - signs]).toEqual(['interego-sign-in-expired', 4]);
    expect(w.relay.seen.filter((s) => s.authorization === `Bearer ${made[0] ?? ''}`)).toHaveLength(1);
    // Strangers from many addresses together reach only what is left for callers not signed in (8 - 2 - 4 = 2).
    const many: Signed[] = [];
    for (let i = 0; i < 6; i++) many.push(await sign(`acc-other${i}${'b'.repeat(20)}`, `198.51.100.${20 + i}`));
    expect(many.map((r) => r.code)).toEqual(['interego-sign-in-expired', 'interego-sign-in-expired', ...Array<string>(4).fill('relay-busy')]);
    expect([many[2]?.status, Number(many[2]?.retry) > 0]).toEqual([429, true]);
    expect(relayed('/mcp') - signs).toBe(6);
    // The person signed in still signs, up to her own limit (5 a minute): the strangers spent none of it.
    const hers: Signed[] = [];
    for (let i = 0; i < 5; i++) hers.push(await sign(bearer, '203.0.113.1'));
    expect(hers.map((r) => r.status)).toEqual([200, 200, 200, 200, 429]);
    expect(hers[4]?.code).toBe('relay-calls-limited');

    // A minute on. Made-up codes from one address: four exchanges reach the relay's token endpoint, then the bridge refuses on its own.
    clock += 61_000;
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    const tokens = relayed('/token');
    const madeCodes: Array<readonly [number, unknown]> = [];
    for (let i = 0; i < 6; i++) {
      const r = await exchange(`madeupcode${i}${'x'.repeat(12)}`, 'a'.repeat(43), '198.51.100.7');
      madeCodes.push([r.status, r.body['code'] ?? null]);
    }
    expect(madeCodes).toEqual([[400, null], [400, null], [400, null], [400, null], [429, 'relay-calls-limited'], [429, 'relay-calls-limited']]);
    expect(relayed('/token') - tokens).toBe(4);
    // Another minute: that address has one exchange left of its five in 15 minutes, and the bridge seven in all (the person's, four, this one, and one more).
    clock += 61_000;
    const later: Array<readonly [number, unknown]> = [];
    for (const ip of ['198.51.100.7', '198.51.100.7', '198.51.100.9', '198.51.100.9']) {
      const r = await exchange(`madeupcode-later-${later.length}${'x'.repeat(8)}`, 'a'.repeat(43), ip);
      later.push([r.status, r.body['code'] ?? null]);
    }
    expect(later).toEqual([[400, null], [429, 'relay-calls-limited'], [400, null], [429, 'relay-busy']]);
    expect(relayed('/token') - tokens).toBe(6);
    // So strangers can delay a new sign-in: a real code is refused before the relay is asked, with the wait the 15-minute budget leaves.
    const next = await codeFor();
    const delayed = await exchange(next.code, next.verifier, '203.0.113.2');
    expect([delayed.status, delayed.body['code'], Number(delayed.body['retryAfterSeconds']) > 60]).toEqual([429, 'relay-busy', true]);
    expect(relayed('/token') - tokens).toBe(6);
    // The person already signed in goes on signing all the while.
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    // Once the 15 minutes have passed, the new sign-in goes through.
    clock += 15 * 60_000;
    const done = await exchange(next.code, next.verifier, '203.0.113.2');
    expect([done.status, typeof done.body['token']]).toEqual([200, 'string']);
    expect((await sign(String(done.body['token']), '203.0.113.2')).status).toBe(200);
    expect(w.relay.seen.filter((s) => s.path === '/identity-token' || s.path.startsWith('/tool/'))).toEqual([]);

    // With no relay call left, how to sign in is a 429 the relay never saw, and the page says why instead of offering nothing.
    const spent = await world({ limits: { unproven: 0 } });
    const cfg = await fetch(`${spent.bridge}/ui/oauth/config`);
    const cj = objOf(await cfg.json());
    expect([cfg.status, cj['kind'], cj['code'], cj['retryAfterSeconds'], cfg.headers.get('retry-after')]).toEqual([429, 'refusal', 'relay-busy', 60, '60']);
    expect(spent.relay.seen).toEqual([]);
    const page = await openPage(spent.bridge, '/ui');
    await page.until(() => page.text().includes('Signing in with your Interego account is not available at this moment'), 'the busy note');
    expect(page.text()).toContain('try again in 60 s');
    expect(page.text()).not.toContain(SIGN_IN);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('keeps each person signed in on budgets of their own: three tokens of one account at their full rate, other accounts at theirs and strangers spending all they may leave another person signed in signing on, since no budget a signed-in call is counted in is anyone else\'s', async () => {
    const clock = Date.now();
    const w = await world({ trustProxy: true, now: () => clock });
    const { relayed, sign, codeFor, exchange } = limitMoves(w);
    const ok = (rs: readonly Signed[]): number => rs.filter((r) => r.status === 200).length;
    // She signs in through this bridge and signs once.
    const hers = await codeFor();
    const ex = await exchange(hers.code, hers.verifier, '203.0.113.1');
    expect(ex.status).toBe(200);
    const bearer = String(ex.body['token']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);

    // Anyone can make an Interego account. This one holds three tokens: one from this bridge's own sign-in, two from the relay directly, each taken here by one sign.
    const ACCOUNT = 'u-pk-a77acce0a77a';
    const own = await codeFor(ACCOUNT);
    const a1 = String((await exchange(own.code, own.verifier, '198.51.100.66')).body['token']);
    const a2 = w.relay.mint(['mcp'], ACCOUNT);
    const a3 = w.relay.mint(['mcp'], ACCOUNT);
    expect([(await sign(a2, '198.51.100.66')).status, (await sign(a3, '198.51.100.66')).status]).toEqual([200, 200]);
    // Each token signs at its full rate, 20 a minute: the account has 40 a minute over all its sign-ins (a1's first sign, which named the person, counted for that sign-in alone), and the rest is refused as that person's own limit.
    const theirs: Signed[] = [];
    for (const t of [a1, a2, a3]) for (let i = 0; i < 20; i++) theirs.push(await sign(t, '198.51.100.66'));
    expect([ok(theirs), theirs.slice(41).map((r) => r.code)]).toEqual([41, Array<string>(19).fill('relay-calls-limited')]);
    expect(theirs[41]?.why).toBe('this bridge\'s limit of 40 relay calls a minute for one person, over all their sign-ins is reached; the relay was not asked');
    // Two more accounts, two tokens each, at their full rate: every call goes through, far past the 50 a minute a bridge-wide count of signed-in calls would have stopped at.
    const others: Signed[] = [];
    for (const [i, account] of ['u-pk-b0b0b0b0b0b0', 'u-pk-c0c0c0c0c0c0'].entries()) {
      const tokens = [w.relay.mint(['mcp'], account), w.relay.mint(['mcp'], account)];
      for (const t of tokens) expect((await sign(t, `198.51.100.${67 + i}`)).status).toBe(200);
      for (const t of tokens) for (let n = 0; n < 20; n++) others.push(await sign(t, `198.51.100.${67 + i}`));
    }
    expect(ok(others)).toBe(80);
    // Strangers from many addresses spend what callers not signed in may (20 a minute, of which 9 are spent: her sign-in's two calls, a1's exchange, and the six signs that took tokens here), and are then refused by the bridge alone.
    const strangers: Signed[] = [];
    for (let i = 0; i < 14; i++) strangers.push(await sign(`acc-stranger${i}${'d'.repeat(20)}`, `198.51.100.${100 + i}`));
    expect(strangers.map((r) => r.code)).toEqual([...Array<string>(11).fill('interego-sign-in-expired'), 'relay-busy', 'relay-busy', 'relay-busy']);
    // She signs on, at her full rate, all the while: 20 in the minute, then her own limit, as one sign-in.
    const mine: Signed[] = [];
    for (let i = 0; i < 20; i++) mine.push(await sign(bearer, '203.0.113.1'));
    expect([ok(mine), mine[19]?.code, mine[19]?.why]).toEqual([19, 'relay-calls-limited', 'this bridge\'s limit of 20 relay calls a minute for one sign-in is reached; the relay was not asked']);
    // In that one minute the relay signed 1 + 2 + 41 + 4 + 80 + 19 = 147 times through the bridge.
    expect(w.relay.mcp.filter((m) => m.answeredAs !== 'refused')).toHaveLength(147);
    expect(relayed('/token')).toBe(2);
    expect(w.relay.seen.filter((s) => s.path === '/identity-token' || s.path.startsWith('/tool/'))).toEqual([]);
  }, 60_000);

  it('runs only so many relay calls at once: at most two for one person, a pool for people signed in that callers not signed in never touch, and a smaller one for those callers, each refused 429 before the relay is asked', async () => {
    const w = await world({ trustProxy: true, limits: { perPersonAtOnce: 2, signedInAtOnce: 4, unprovenAtOnce: 2 } });
    const { sign, codeFor, exchange } = limitMoves(w);
    const hers = await codeFor();
    const bearer = String((await exchange(hers.code, hers.verifier, '203.0.113.1')).body['token']);
    expect((await sign(bearer, '203.0.113.1')).status).toBe(200);
    const a = ['u-pk-a77acce0a77a', 'u-pk-a77acce0a77a', 'u-pk-a77acce0a77a', 'u-pk-b0b0b0b0b0b0', 'u-pk-b0b0b0b0b0b0'].map((u) => w.relay.mint(['mcp'], u));
    for (const t of a) expect((await sign(t, '198.51.100.66')).status).toBe(200);
    const heldUntil = async (n: number): Promise<void> => {
      for (let i = 0; w.relay.held() < n; i++) {
        if (i > 400) throw new Error(`the relay holds ${w.relay.held()} calls, not ${n}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const release = w.relay.hold();
    // One person: two calls at once reach the relay, a third is refused as that person's own limit.
    const running = [sign(a[0] ?? '', '198.51.100.66'), sign(a[1] ?? '', '198.51.100.66')];
    await heldUntil(2);
    const third = await sign(a[2] ?? '', '198.51.100.66');
    expect([third.status, third.code, third.retry, third.why]).toEqual([429, 'relay-calls-limited', 1, 'at most 2 relay calls run at once for one person; the relay was not asked']);
    // Another person and she still get theirs, up to the pool for people signed in (four here).
    running.push(sign(a[3] ?? '', '198.51.100.67'), sign(bearer, '203.0.113.1'));
    await heldUntil(4);
    const full = await sign(a[4] ?? '', '198.51.100.67');
    expect([full.status, full.code, full.why]).toEqual([429, 'relay-busy', 'at most 4 relay calls run at once for people signed in; the relay was not asked']);
    // Callers not signed in have places of their own (two here), which the signed-in pool being full does not take away, and are refused beyond them.
    running.push(sign(`acc-stranger0${'e'.repeat(20)}`, '198.51.100.90'), sign(`acc-stranger1${'e'.repeat(20)}`, '198.51.100.91'));
    await heldUntil(6);
    const stranger = await sign(`acc-stranger2${'e'.repeat(20)}`, '198.51.100.92');
    expect([stranger.status, stranger.code, stranger.why]).toEqual([429, 'relay-busy', 'at most 2 relay calls run at once for callers the relay has not accepted here; the relay was not asked']);
    expect(w.relay.held()).toBe(6);
    release();
    expect((await Promise.all(running)).map((r) => r.code ?? r.status)).toEqual([200, 200, 200, 200, 'interego-sign-in-expired', 'interego-sign-in-expired']);
    // Each place is given back when its call ends.
    expect([(await sign(a[2] ?? '', '198.51.100.66')).status, (await sign(a[4] ?? '', '198.51.100.67')).status, (await sign(bearer, '203.0.113.1')).status]).toEqual([200, 200, 200]);
  }, 60_000);

  it('serves the client\'s metadata document as the relay\'s CIMD reader requires it (client_id its own URL, https redirect, no client secret), says how the client is registered, and falls back to Dynamic Client Registration where the relay cannot read it', async () => {
    const w = await world();
    const r = await fetch(`${w.bridge}/ui/oauth/client.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const doc = objOf(await r.json());
    expect(doc).toEqual({
      client_id: `${DEPLOYED}/ui/oauth/client.json`, client_name: 'Work Redesign', client_uri: `${DEPLOYED}/ui`,
      redirect_uris: [`${DEPLOYED}/ui/oauth/callback`], grant_types: ['authorization_code'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: 'mcp',
    });
    // What oauth-provider.ts resolveClientIdMetadata requires: an https client_id with no fragment, naming itself, and https redirect URIs.
    const id = new URL(String(doc['client_id']));
    expect([id.protocol, id.hash]).toEqual(['https:', '']);
    expect((doc['redirect_uris'] as string[]).every((u) => new URL(u).protocol === 'https:')).toBe(true);
    // Its name is not one of the relay's known surfaces, so the agent's slug is work-redesign: the one the bridge takes decisive acts from.
    expect(/claude|chatgpt|codex|openai|cursor|windsurf|cline|zed|continue|hermes|openclaw/i.test(SIGN_IN_CLIENT_NAME)).toBe(false);
    expect(surfaceSlug(SIGN_IN_CLIENT_NAME)).toBe('work-redesign');

    const config = objOf(await (await fetch(`${w.bridge}/ui/oauth/config`)).json());
    expect(config).toMatchObject({
      enabled: true, relayUrl: w.relay.base, authorizationEndpoint: `${w.relay.base}/authorize`, clientId: `${DEPLOYED}/ui/oauth/client.json`,
      clientRegistration: 'client-id-metadata-document', redirectUri: `${DEPLOYED}/ui/oauth/callback`, scope: 'mcp', identityHost: IDENTITY,
    });
    // The trust note names the token the page holds, what it lets its holder do (the relay's tools, and a trade at /identity-token for the account's own bearer), and what signing out does not do.
    expect(String(config['trust'])).toMatch(/the relay's OAuth access token for your sign-in, good for about an hour, and sends it through this bridge with every signature/);
    expect(String(config['trust'])).toMatch(/call the relay's tools as you/);
    expect(String(config['trust'])).toMatch(/trade it, at its \/identity-token, for the identity-server token behind your sign-in/);
    expect(String(config['trust'])).toMatch(/linking a wallet, removing your sign-in methods, deleting the account/);
    expect(String(config['trust'])).toMatch(/trusted with your account for up to a day, past the hour and past signing out/);
    expect(String(config['trust'])).not.toMatch(/never reaches/);
    expect(String(config['trust'])).toMatch(/revokes nothing/);
    // The callback page is the shell, under the same CSP: one external script, nothing inline.
    const cb = await fetch(`${w.bridge}/ui/oauth/callback?code=c&state=s`);
    expect(cb.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    expect(cb.headers.get('cache-control')).toBe('no-store');
    const shell = await cb.text();
    expect(shell.match(/<script/g)).toHaveLength(1);
    expect(shell).toContain('<script type="module" src="/ui/app.js"></script>');
    expect(shell).not.toContain('code=c');
    expect(UI_CSP).toContain("connect-src 'self'");

    // A local run (an http deployment URL): the relay will not read the document, so the bridge registers it once.
    const local = await world({ deployed: 'http://127.0.0.1:6100' });
    const c1 = objOf(await (await fetch(`${local.bridge}/ui/oauth/config`)).json());
    const c2 = objOf(await (await fetch(`${local.bridge}/ui/oauth/config`)).json());
    expect(c1).toMatchObject({ enabled: true, clientRegistration: 'dynamic-registration', redirectUri: 'http://127.0.0.1:6100/ui/oauth/callback' });
    expect(c2['clientId']).toBe(c1['clientId']);
    const registrations = local.relay.seen.filter((s) => s.path === '/register');
    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.body).toEqual({
      client_name: 'Work Redesign', client_uri: 'http://127.0.0.1:6100/ui', redirect_uris: ['http://127.0.0.1:6100/ui/oauth/callback'],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
    });
    // A relay that does not say it reads metadata documents: the same fallback, over https too.
    const noCimd = await world({ cimd: false });
    expect(objOf(await (await fetch(`${noCimd.bridge}/ui/oauth/config`)).json())['clientRegistration']).toBe('dynamic-registration');

    // Not set up: no relay URL, or no relay this bridge trusts. The page is told why and offers no sign-in.
    const off = await world({ signIn: 'off' });
    expect(objOf(await (await fetch(`${off.bridge}/ui/oauth/config`)).json())).toEqual({ enabled: false, why: 'This bridge is not set up for signing in with an Interego account. WRD_RELAY_URL is not set.' });
    expect((await fetch(`${off.bridge}/ui/oauth/client.json`)).status).toBe(404);
    expect((await post(`${off.bridge}/ui/relay/sign`, { payload: {} }, { authorization: 'Bearer x' })).status).toBe(404);
    const untrusted = await world({ signIn: 'no-relay-trusted' });
    expect(String(objOf(await (await fetch(`${untrusted.bridge}/ui/oauth/config`)).json())['why'])).toMatch(/trusts no Interego relay \(WRD_TRUSTED_RELAY_ADDRESSES is empty\)/);
    expect((await post(`${untrusted.bridge}/ui/oauth/exchange`, { code: 'c', code_verifier: 'v'.repeat(43), state: 'A'.repeat(32) })).status).toBe(404);
    const page = await openPage(off.bridge, '/ui');
    await page.until(() => page.text().includes('No wallet: this browser has no EIP-191 wallet'), 'the read-only note');
    expect(page.text()).not.toContain(SIGN_IN);
    expect(page.errors).toEqual([]);
  }, 60_000);
});
