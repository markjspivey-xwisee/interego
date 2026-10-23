/**
 * "Sign in with your Interego account" in the web UI, driven for real against a stubbed relay.
 *
 * The bridge is composed the way server.ts composes it (createVerticalBridge + the handlers + the
 * host guard + attachUi with Interego sign-in), on a loopback port; the shipped /ui shell and
 * app.js run in jsdom windows whose fetch reaches that bridge. The relay is an in-process fetch
 * that behaves as deploy/mcp-relay does where this flow touches it: its authorization server
 * metadata (CIMD advertised), Client ID Metadata Documents read from the client's own URL (the
 * client_name slugified into the agent's slug, as surfaceAgentFromClient does), dynamic
 * registration, PKCE S256 at the token endpoint, /identity-token, and /tool/sign_request, which
 * signs as handleSignRequest does (the caller's fields with underscore and reserved keys dropped,
 * podUrl kept as pod_url, then the session's agent_id, the caller's own pod as subject_pod_url and
 * the relay's timestamp; EIP-191 over sha256:<hex>) with a generated relay key.
 *
 * A browser navigation is the one thing jsdom cannot do: the page's location.assign to the relay is
 * reported by jsdom as "not implemented" and read here from the link the page shows beside it, and
 * the relay's redirect back is a second window opened at the callback URL with this tab's session
 * storage, as a browser keeps it across a navigation in one tab. jsdom has no SubtleCrypto or
 * TextEncoder, so the test windows get Node's, the same APIs a browser has. No network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { importWallet, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import type { Express, NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { pevAffordances } from '../affordances.js';
import { createPevHandlers, DEMO_ROLE_NAMES, WEB_UI_AGENT_PREFIX, type DemoRoleName, type PevDeps } from '../bridge/handlers.js';
import { readHead, isTrusted } from '../bridge/pod-helpers.js';
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

interface RelayCall { readonly method: string; readonly url: string; readonly authorization: string | null; readonly body: string }

/** The identity host's agents, minted as the relay mints them at sign-in (`<surface>-<userId>`). */
const agentDocs = new Map<string, unknown>();
const fetchDidDocument = async (url: string): Promise<unknown> => {
  if (!agentDocs.has(url)) throw new Error('the identity host answered HTTP 404');
  return agentDocs.get(url);
};

function stubRelay(o: { readonly cimd: boolean }) {
  const calls: RelayCall[] = [];
  const registered = new Map<string, Out>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string; slug: string }>();
  const access = new Map<string, string>();
  const identity = new Map<string, { slug: string }>();
  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ method, url, authorization: headers.get('authorization'), body });
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
        const idToken = `cg2_${b64url(Buffer.from(JSON.stringify({ userId: USER, agentId: c.slug })))}.${b64url(randomBytes(32))}`;
        access.set(token, idToken);
        identity.set(idToken, { slug: c.slug });
        return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: randomBytes(32).toString('hex'), scope: c.scope });
      }
      case 'GET /identity-token': {
        const idToken = access.get(bearer);
        return idToken ? json(200, { identityToken: idToken, expiresAt: 0, userId: USER }) : json(401, { error: 'Invalid access token' });
      }
      case 'POST /tool/sign_request': {
        const who = identity.get(bearer);
        if (!who) return json(401, { error: 'Authentication required for write operations', detail: 'Invalid token' });
        const args = JSON.parse(body) as Out;
        const reserved = new Set(['agent_id', 'timestamp', '_signature', '_signed_payload', 'subject_pod_url', 'payload', 'pod_name', 'owner_webid', 'owner_name']);
        const p = (args['payload'] ?? {}) as Out;
        const safe: Out = Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('_') && !reserved.has(k)));
        const asked = p['pod_url'] ?? p['podUrl'];
        delete safe['pod_url'];
        delete safe['podUrl'];
        if (typeof asked === 'string') safe['pod_url'] = asked;
        const agentId = `did:web:${IDH}:agents:${who.slug}`;
        const sp = JSON.stringify({ ...safe, agent_id: agentId, subject_pod_url: `https://pods.ui.test/${USER}/`, timestamp: new Date().toISOString() });
        return json(200, {
          _signature: await signMessageRaw(RELAY_KEY, `sha256:${sha256Hex(sp)}`), _signed_payload: sp, signed_as: agentId,
          signatureAuthority: 'relay', signingNote: 'This is a relay-mediated signature.', anchor: `did:ethr:${RELAY_KEY.address}`,
        });
      }
      default:
        return json(404, { error: `no route ${method} ${u.pathname}` });
    }
  }) as typeof fetch;

  /**
   * The person signs in on the relay's own page (their passkey): the relay reads the client (its
   * CIMD from the client's own URL, which `deployed` maps to this test's listener, or a DCR
   * registration), mints the agent `<client name slug>-<userId>` on the identity host, and sends the
   * browser back to the redirect URI with a code and the state it was given.
   */
  async function signIn(authorizeUrl: string, deployed: (url: string) => string): Promise<string> {
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
    const slug = `${surface}-${USER}`;
    agentDocs.set(`https://${IDH}/agents/${slug}/did.json`, { '@context': ['https://www.w3.org/ns/did/v1'], id: `did:web:${IDH}:agents:${slug}`, controller: PRINCIPAL });
    const code = randomBytes(24).toString('hex');
    codes.set(code, { clientId: q('client_id'), redirectUri: q('redirect_uri'), challenge: q('code_challenge'), resource: q('resource'), scope: q('scope'), slug });
    const back = new URL(q('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q('state'));
    return back.href;
  }

  return { fetchFn, calls, registered, signIn };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The bridge and the page
// ═════════════════════════════════════════════════════════════════════════════════════════════

const handlers = createPevHandlers({
  platformWallet: PLATFORM, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address], adminDids: [PRINCIPAL],
  fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD], deploymentUrl: 'http://127.0.0.1:6110',
  relayDelegation: { relayAddresses: [RELAY_KEY.address.toLowerCase()], identityHost: IDH, fetchDidDocument },
  relayUrl: RELAY, model: scriptedPracticeModel(),
} satisfies PevDeps) as Handlers;

const listeners: TestListener[] = [];
async function serve(interego: InteregoUiOptions | undefined): Promise<TestListener> {
  const allowed: string[] = [];
  const app: Express = createVerticalBridge({
    verticalName: 'practice-evidence', affordances: pevAffordances, handlers, deploymentUrl: 'http://127.0.0.1:6110', defaultPodUrl: DEMO_POD,
    middleware: (a) => {
      a.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => hostAllowlistGuard(allowed)(req, res, next));
      attachUi(a, interego ? { interego } : {});
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
  for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  w.eval(await (await fetch(`${l.base}/ui/app.js`)).text());
  const d = w.document;
  return {
    w, errors, asked,
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
    for (const bad of [{}, { payload: { ...payload, action: 'urn:iep:action:foxxi:review-record' } }, { payload: { ...payload, v: 2 } }, { payload: { v: 1, action: PEV_ACTION.getAttempt } }]) {
      const r = await post(bad, 'Bearer cg2_abcdefghijklmnop.qrstuvwxyz');
      expect([r.status, r.json['iep:refusalReason']], JSON.stringify(bad)).toEqual([400, 'payload-shape']);
    }
    const big = await post({ payload: { ...payload, filler: 'x'.repeat(70 * 1024) } }, 'Bearer cg2_abcdefghijklmnop.qrstuvwxyz');
    expect([big.status, big.json['iep:refusalReason']]).toEqual([413, 'payload-too-large']);
    const malformed = await fetch(`${bridge.base}/ui/relay/sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cg2_abcdefghijklmnop.qrstuvwxyz' }, body: '{ not json' });
    expect([malformed.status, ((await malformed.json()) as Out)['iep:refusalReason']]).toEqual([400, 'body-unreadable']);
    expect(relay.calls.length).toBe(before);
    // A bearer the relay does not know: the relay is asked, and its refusal comes back as a sign-in to redo.
    const stale = await post({ payload }, 'Bearer cg2_abcdefghijklmnop.qrstuvwxyz');
    expect([stale.status, stale.json['iep:refusalReason']]).toEqual([401, 'interego-sign-in-expired']);
    expect(relay.calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([`POST ${RELAY}/tool/sign_request`]);
    expect(JSON.stringify(stale.json)).not.toContain('cg2_abcdefghijklmnop');
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
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The page, driven
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the web UI signs a person in with their Interego account and has the relay sign every act', () => {
  it('button → the relay with PKCE and a state → callback → exchange → acts the bridge reads as relay-delegated → sign-out', async () => {
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
    // The account token is in this tab's sessionStorage only; the verifier and the state are gone.
    const kept = JSON.parse(p2.session(SESSION_KEY) ?? 'null') as { bearer: string };
    const bearer = kept.bearer;
    expect(bearer).toMatch(/^cg2_/);
    expect(p2.session(PENDING_KEY)).toBeNull();
    expect(p2.w.localStorage.length).toBe(0);
    const exchange = relay.calls.filter((c) => c.url === `${RELAY}/token`).at(-1)!;
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBe(pending.verifier);
    // Every relay call carried the bearer in its Authorization header and nowhere else.
    expect(relay.calls.every((c) => !c.url.includes(bearer) && !c.body.includes(bearer) && !c.url.includes(code))).toBe(true);
    expect(relay.calls.filter((c) => c.url === `${RELAY}/tool/sign_request`).at(-1)?.authorization).toBe(`Bearer ${bearer}`);
    // The sign route answers with the relay's two fields and nothing else the relay said.
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
    p2.w.location.hash = '#/roles';
    await p2.until(() => p2.q(`button[data-action="${PEV_ACTION.registerRole}"]`), 'the roles form');
    const field = p2.q('input[aria-label="Address"]') as HTMLInputElement;
    field.value = OTHER;
    p2.q(`button[data-action="${PEV_ACTION.registerRole}"]`)!.click();
    await p2.until(() => p2.q('#view .outcome table') ?? p2.q('#view .refusal'), 'the registry');
    expect([...p2.w.document.querySelectorAll('#view .outcome tr')].some((tr) => (tr.textContent ?? '').includes(OTHER))).toBe(true);
    expect(p2.errors).toEqual([]);

    // ── Sign-out: the token leaves the tab, and the next act is not signed by the relay.
    const signs = relay.calls.filter((c) => c.url === `${RELAY}/tool/sign_request`).length;
    p2.q('#interego-sign-out')!.click();
    await p2.until(() => p2.text('#acting-as') === 'whoever signs (paste mode)', 'paste mode again');
    expect([p2.session(SESSION_KEY), p2.q('#interego-did'), p2.q('#interego-sign-in')?.textContent]).toEqual([null, null, 'Sign in with your Interego account']);
    p2.w.location.hash = '#/mine';
    await p2.until(() => p2.q('#signing textarea[readonly]'), 'the paste signing panel');
    expect(relay.calls.filter((c) => c.url === `${RELAY}/tool/sign_request`).length).toBe(signs);
    expect(p2.errors).toEqual([]);
  }, SLOW);

  it('an answer that does not carry the state this tab sent is refused: no exchange, nothing kept', async () => {
    const p1 = await openPage(bridge, '/ui');
    await p1.until(() => p1.q('article.scenario'), 'the scenarios');
    const to = await pressSignIn(p1);
    const back = new URL(await relay.signIn(to.href, deployed));
    back.searchParams.set('state', 'A'.repeat(32));
    const tokens = relay.calls.filter((c) => c.url === `${RELAY}/token`).length;
    const p2 = await openPage(bridge, back.href.slice(DEPLOY.length), sessionOf(p1));
    await p2.until(() => p2.text('#signing').includes('did not carry the state this tab sent'), 'the state refusal');
    await p2.until(() => p2.q('article.scenario'), 'the scenarios');
    expect([p2.w.location.pathname, p2.w.location.search]).toEqual(['/ui', '']);
    expect([p2.session(SESSION_KEY), p2.session(PENDING_KEY), p2.text('#acting-as')]).toEqual([null, null, 'whoever signs (paste mode)']);
    expect(p2.asked.filter((x) => x.includes('/ui/oauth/exchange'))).toEqual([]);
    expect(relay.calls.filter((c) => c.url === `${RELAY}/token`).length).toBe(tokens);
    // With no pending sign-in in the tab at all, an answer is refused the same way.
    const p3 = await openPage(bridge, back.href.slice(DEPLOY.length));
    await p3.until(() => p3.text('#signing').includes('did not start a sign-in'), 'the unexpected-answer refusal');
    expect(p3.session(SESSION_KEY)).toBeNull();
    expect([...p2.errors, ...p3.errors]).toEqual([]);
  }, SLOW);
});
