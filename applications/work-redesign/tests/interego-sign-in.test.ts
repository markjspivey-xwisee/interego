/**
 * "Sign in with your Interego account" in the web UI, against a stubbed relay. No network: the
 * relay is an express app on loopback that does what deploy/mcp-relay does for each call the
 * bridge makes (its authorization server metadata, the token exchange with PKCE, /identity-token,
 * and sign_request as handleSignRequest builds it), and the identity host is a map of DID
 * documents.
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
 * bridge's answer and the agent from the relay's signed text, and sign-out; a state that is not
 * the tab's refused with nothing exchanged; POST /ui/relay/sign refusing without a bearer (and
 * what else it refuses, never echoing a bearer or a code); and the client's metadata document as
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
import { attachUi, parseEveryQueryPair, SIGN_IN_CLIENT_NAME, UI_CSP, type UiSignIn } from '../bridge/ui.js';
import { memoryPod, demoClock, DEMO_POD, DEMO_RECORD_KEY } from '../demo/run.js';
import type { RelayDelegationPolicy } from '../src/relay-delegated.js';

const APP_JS = readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8');
const listeners: TestListener[] = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

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

/**
 * The relay's rule for an OAuth client it does not know by name (surfaceAgentFromClient in
 * deploy/mcp-relay/server.ts): lower-case, runs of anything else as one hyphen, trimmed. That
 * slug, then `-<user id>`, is the agent of the session.
 */
const surfaceSlug = (clientName: string): string => clientName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const agentOf = (surface: string): string => `did:web:${IDENTITY}:agents:${surface}-${USER_ID}`;

interface Seen { readonly method: string; readonly path: string; readonly authorization: string | null; readonly body: unknown }
interface StubRelay {
  readonly base: string;
  /** Every request the relay received, with the Authorization header it carried. */
  readonly seen: Seen[];
  /** The relay's sign-in page: the person signs in, and the relay mints a code for the authorize URL the page sent the tab to. */
  authorize(url: string): Promise<string>;
}

/** A stub of the relay's surfaces the bridge calls, signing as RELAY for the session's agent with `clock`'s time. */
async function stubRelay(bridgeBase: () => string, clock: { now(): Date }, opts: { readonly cimd?: boolean } = {}): Promise<StubRelay> {
  const app = express();
  const seen: Seen[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; surface: string; scope: string }>();
  const access = new Map<string, { surface: string }>();
  const identity = new Map<string, { surface: string }>();
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
    access.set(t, { surface: c.surface });
    res.json({ access_token: t, token_type: 'Bearer', expires_in: 3600, refresh_token: `ref-${hex(16)}`, scope: c.scope });
  });
  app.get('/identity-token', (req, res) => {
    const a = access.get(bearer(req.headers.authorization));
    if (!a) { res.status(401).json({ error: 'Invalid access token: Token not found' }); return; }
    const t = `idt-${hex(16)}`;
    identity.set(t, a);
    // The relay reports the access token's own expiry, in seconds.
    res.json({ identityToken: t, expiresAt: Math.floor(Date.now() / 1000) + 3600, userId: USER_ID });
  });
  // As handleSignRequest: the caller's fields (underscore keys and the reserved ones dropped, podUrl
  // as pod_url), then the session's agent, the caller's own pod and the relay's timestamp.
  app.post('/tool/sign_request', async (req, res) => {
    const s = identity.get(bearer(req.headers.authorization));
    if (!s) {
      res.status(401).json({ error: 'Authentication required for write operations', detail: 'Token not found' });
      return;
    }
    const reserved = new Set(['agent_id', 'timestamp', '_signature', '_signed_payload', 'subject_pod_url', 'payload', 'pod_name', 'owner_webid', 'owner_name']);
    const p = objOf(objOf(req.body)['payload']);
    const safe: Obj = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_') && !reserved.has(k)));
    const asked = p['pod_url'] ?? p['podUrl'];
    delete safe['pod_url'];
    delete safe['podUrl'];
    if (typeof asked === 'string') safe['pod_url'] = asked;
    const text = JSON.stringify({ ...safe, agent_id: agentOf(s.surface), subject_pod_url: `https://pod.example/${USER_ID}/`, timestamp: clock.now().toISOString() });
    res.json({ _signature: await signMessageRaw(RELAY, `sha256:${sha256Hex(text)}`), _signed_payload: text, signed_as: agentOf(s.surface), signatureAuthority: 'relay' });
  });
  const l = await listenLoopback(app);
  listeners.push(l);
  base = l.base;
  return {
    base, seen,
    async authorize(url) {
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
      codes.set(code, { challenge: String(p['code_challenge']), clientId, redirectUri: String(p['redirect_uri']), surface: surfaceSlug(String(client['client_name'])), scope: String(p['scope'] ?? 'mcp') });
      return code;
    },
  };
}

/** The identity host: each surface's agent of the one person, controlled by them, as the live host serves them. */
const didDocuments = (fetched: string[]): RelayDelegationPolicy['fetchDidDocument'] => async (url) => {
  fetched.push(url);
  const m = new RegExp(`^https://${IDENTITY.replace(/\./g, '\\.')}/agents/([a-z-]+-${USER_ID})/did\\.json$`).exec(url);
  if (!m) throw new Error('the identity host answered 404');
  return { id: `did:web:${IDENTITY}:agents:${m[1]}`, controller: PERSON };
};

interface World {
  readonly bridge: string;
  readonly relay: StubRelay;
  readonly fetched: string[];
}
/** A bridge on loopback whose UI signs in through a stub relay; the person is an admin by their user DID. */
async function world(o: { readonly deployed?: string; readonly cimd?: boolean; readonly signIn?: 'on' | 'no-relay-trusted' | 'off'; readonly admin?: boolean } = {}): Promise<World> {
  const clock = demoClock();
  const pod = memoryPod();
  const fetched: string[] = [];
  let bridgeBase = '';
  const relay = await stubRelay(() => bridgeBase, clock, o.cimd === undefined ? {} : { cimd: o.cimd });
  const policy: RelayDelegationPolicy = { relayAddresses: [RELAY.address.toLowerCase()], identityHost: IDENTITY, fetchDidDocument: didDocuments(fetched) };
  const deployed = o.deployed ?? DEPLOYED;
  const signIn: UiSignIn | undefined = o.signIn === 'off' ? undefined : { relayUrl: relay.base, policy: o.signIn === 'no-relay-trusted' ? null : policy };
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), recordKey: DEMO_RECORD_KEY,
    platform: { wallet: importWallet(`0x${sha256Hex('wrd-sign-in-test:platform')}`, 'agent', 'wrd-platform'), keyKind: 'demo' },
    adminDids: o.admin === false ? [] : [PERSON], relayDelegation: { ...policy, chatAgentsDecide: false, relayUrl: relay.base },
  });
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: wrdAffordances, handlers, deploymentUrl: deployed,
    middleware: (a) => { attachUi(a, { base: deployed, ...(signIn ? { signIn } : {}) }); parseEveryQueryPair(a); },
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

const post = async (url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Obj; text: string }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let j: Obj = {};
  try { j = objOf(JSON.parse(text)); } catch { j = {}; }
  return { status: r.status, body: j, text };
};

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
    const kept = objOf(JSON.parse(page.session()[SESSION_KEY] ?? '{}'));
    const token = String(kept['token']);
    expect(token).toMatch(/^idt-[0-9a-f]{32}$/);
    expect(page.session()[FLOW_KEY]).toBeUndefined();
    expect(page.window.localStorage.length).toBe(0);
    expect(page.log.filter((r) => r.query.includes(code) || r.query.includes(token) || r.path.includes(token))).toEqual([]);
    // The exchange: the code with this tab's verifier, POSTed to the bridge, which went to the relay's token endpoint and /identity-token.
    const exchange = page.log.filter((r) => r.path === '/ui/oauth/exchange');
    expect(exchange.map((r) => `${r.method} ${r.status}`)).toEqual(['POST 200']);
    expect(exchange[0]?.body).toEqual({ code, code_verifier: flow['verifier'], state: p['state'] });
    expect(exchange[0]?.authorization).toBeNull();
    expect(objOf(exchange[0]?.answer)).toMatchObject({ status: 'signed-in', token, tokenType: 'Bearer', clientRegistration: 'client-id-metadata-document' });
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
    // The token went to the relay only to sign, and the access token only to /identity-token; nothing else the relay saw carried a bearer.
    expect(w.relay.seen.filter((s) => s.authorization !== null).map((s) => `${s.method} ${s.path} ${s.authorization?.startsWith(`Bearer ${token}`) ? 'token' : s.authorization?.startsWith('Bearer acc-') ? 'access' : 'other'}`))
      .toEqual(['GET /identity-token access', 'POST /tool/sign_request token', 'POST /tool/sign_request token']);

    // Sign-out: the token is forgotten in this tab, the page offers the sign-in again, and nothing after it carries a bearer.
    const before = page.log.length;
    page.click('Sign out');
    await page.until(() => page.text().includes('Signed out: this tab no longer holds your Interego token'), 'the sign-out');
    expect(page.session()[SESSION_KEY]).toBeUndefined();
    expect(page.text()).toContain(SIGN_IN);
    expect(page.text()).not.toContain(`Signed in as ${PERSON}`);
    expect(page.log.slice(before).filter((r) => r.authorization !== null)).toEqual([]);
    expect([...first.errors, ...page.errors]).toEqual([]);
  }, 120_000);

  it('refuses a callback whose state is not the one this tab stored, or that this tab never started, exchanging nothing', async () => {
    const w = await world();
    const first = await openPage(w.bridge, '/ui');
    const url = await startSignIn(first);
    const code = await w.relay.authorize(url.href);
    const forged = 'A'.repeat(32);
    const page = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${forged}`, first.session());
    await page.until(() => page.text().includes('Sign-in was not finished, and nothing was exchanged.'), 'the refusal');
    expect(page.text()).toContain('the state the relay sent back is not the one this tab stored when it sent you to sign in');
    expect(page.log.filter((r) => r.path.startsWith('/ui/oauth/exchange') || r.path.startsWith('/ui/relay/'))).toEqual([]);
    expect(w.relay.seen.filter((s) => s.path === '/token')).toEqual([]);
    expect(page.session()).toEqual({});
    expect(page.window.location.pathname + page.window.location.search).toBe('/ui');
    expect(page.text()).toContain(SIGN_IN);
    // A tab that started no sign-in (another tab's code, say) is refused the same way.
    const fresh = await openPage(w.bridge, `/ui/oauth/callback?code=${code}&state=${String(url.searchParams.get('state'))}`);
    await fresh.until(() => fresh.text().includes('this tab holds no sign-in it started'), 'the refusal');
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
    expect([...first.errors, ...page.errors, ...fresh.errors]).toEqual([]);
  }, 60_000);

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
    expect([...first.errors, ...page.errors]).toEqual([]);
  }, 60_000);

  it('POST /ui/relay/sign refuses without a bearer, asking the relay nothing; it refuses what the relay would not sign as sent, another site\'s page and an oversized body, and repeats no bearer', async () => {
    const w = await world();
    const sign = `${w.bridge}/ui/relay/sign`;
    const payload = { intent: 'wrd:read-records', podUrl: DEMO_POD, nonce: 'sign-route-0000001' };
    const asked = (): number => w.relay.seen.filter((s) => s.path === '/tool/sign_request').length;

    const bare = await post(sign, { payload });
    expect(bare.status).toBe(401);
    expect(bare.body).toMatchObject({ kind: 'refusal', error: 'Sign in with your Interego account first.' });
    expect(String(bare.body['iep:refusalReason'])).toMatch(/Authorization: Bearer <token>\), and this request carries none$/);
    for (const h of ['Basic dXNlcjpwdw==', 'Bearer', 'Bearer two words']) {
      expect((await post(sign, { payload }, { authorization: h })).status, h).toBe(401);
    }
    expect(asked()).toBe(0);

    // A token the relay does not know: 401, and the bearer is not repeated.
    const stale = `idt-${'0'.repeat(32)}`;
    const refused = await post(sign, { payload }, { authorization: `Bearer ${stale}` });
    expect([refused.status, refused.body['error']]).toEqual([401, 'The Interego relay did not accept your sign-in. Sign in again.']);
    expect(String(refused.body['iep:refusalReason'])).toBe('the relay answered 401: Token not found');
    expect(refused.text).not.toContain(stale);
    expect(asked()).toBe(1);

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
    expect(asked()).toBe(1);
    // The same origin as the page passes the Origin check (and reaches the relay).
    expect((await post(sign, { payload }, { ...auth, origin: w.bridge })).status).toBe(401);
    expect(asked()).toBe(2);

    // whoami: only a request a trusted relay signed names anyone.
    const unsigned = await post(`${w.bridge}/ui/relay/whoami`, { _signed_payload: JSON.stringify({ agent_id: agentOf('work-redesign') }), _signature: `0x${'1b'.repeat(65)}` });
    expect(unsigned.status).toBe(401);
    expect(String(unsigned.body['iep:refusalReason'])).toMatch(/^(signature-unrecoverable|relay-not-trusted): /);
    expect(w.fetched).toEqual([]);
  }, 60_000);

  it('serves the client\'s metadata document as the relay\'s CIMD reader requires it (client_id its own URL, https redirect, no client secret), says how the client is registered, and falls back to Dynamic Client Registration where the relay cannot read it', async () => {
    const w = await world();
    const r = await fetch(`${w.bridge}/ui/oauth/client.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const doc = objOf(await r.json());
    expect(doc).toEqual({
      client_id: `${DEPLOYED}/ui/oauth/client.json`, client_name: 'Work Redesign', client_uri: `${DEPLOYED}/ui`,
      redirect_uris: [`${DEPLOYED}/ui/oauth/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
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
    expect(String(config['trust'])).toMatch(/passes? through this bridge|sent through this bridge with every signature/);
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
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp',
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
