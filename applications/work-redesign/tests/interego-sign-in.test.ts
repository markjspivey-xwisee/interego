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
import { canonicalJson, importWallet, sha256Hex, signMessageRaw } from '@interego/core';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { chatAgentJs } from '../../_shared/chat-agent/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances } from '../affordances.js';
import { createWrdHandlers } from '../bridge/handlers.js';
import { attachUi, parseEveryQueryPair, SIGN_IN_CLIENT_NAME, UI_CSP, type RelayLimits, type UiReads, type UiSignIn } from '../bridge/ui.js';
import { memoryPod, demoClock, DEMO_POD, DEMO_RECORD_KEY } from '../demo/run.js';
import { RELAY_SIGNING } from '../src/payloads.js';
import type { RelayDelegationPolicy } from '../src/relay-delegated.js';
import { jargonIn, urnsRunningIntoPunctuation, visibleText } from './plain-words.js';

/** /ui/app.js as the bridge serves it: the shared chat-agent helpers, then the app (bridge/ui.ts). */
const APP_JS = `${chatAgentJs()}\n${readFileSync(new URL('../bridge/ui/app.js', import.meta.url), 'utf8')}`;
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
const must = <T>(v: T | null | undefined, what: string): T => { if (v === null || v === undefined) throw new Error(`missing ${what}`); return v; };
/**
 * The stylesheet as a screen `px` wide applies it, for jsdom, which lays nothing out and applies an `@media screen` rule but
 * no width query: each min-width or max-width query (every one this stylesheet has is in em, alone) is kept, as `screen`,
 * where that width meets it, and set aside, as `print`, where it does not. Real Chromium from 300 px up is the QA's check.
 */
const atWidth = (css: string, px: number): string =>
  css.replace(/@media \((min|max)-width: ([\d.]+)em\)/g, (_m, k: string, em: string) => `@media ${(k === 'min' ? px >= Number(em) * 16 : px <= Number(em) * 16) ? 'screen' : 'print'}`);
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
 * A claim about which Claude or ChatGPT plans allow a connector. The pages name no plans: whether a person can add one is
 * their plan's or workspace's setting, and that is all they say.
 */
const PLAN_CLAIM = /(Claude|ChatGPT) plans?\b|plans? that allows?|on a plan that|on your plan\?|plan must allow|plans can(?:'|’)?t/i;
/** ChatGPT's set-up, step by step, as OpenAI's guide to custom MCP servers gives it (verified 2026-11-08). */
const CHATGPT_STEPS = [
  'In ChatGPT on the web, open Plugins, select +, then Add custom MCP server.',
  'Name it Interego, paste the address above as its Server URL, and choose OAuth.',
  'Accept the warning, select Create as a plugin, then install it.',
  'When it asks, sign in with the same Interego account you use here.',
  'In a chat, type @ and choose Interego.',
];
const CHATGPT_GUIDE = 'https://developers.openai.com/api/docs/guides/custom-mcp-server';
/**
 * What a copied prompt tells a chat app whose act tool shows no sign_payload option, word for word as the shared chat
 * helper (applications/_shared/chat-agent) writes it, as the last line of How to do each step: leave sign_payload out of
 * a plain step, and sign a signed step with sign_request first. Both copied prompts here can lead to both kinds of step.
 */
const NO_OPTION = 'no sign_payload option';
const PLAIN_FALLBACK = 'leave sign_payload out of a plain step\'s call';
const SIGN_REQUEST_FALLBACK = 'call the connector\'s sign_request tool';
const FALLBACK_BOTH = `If your act tool has ${NO_OPTION}, ${PLAIN_FALLBACK} (do not sign it or wrap it), and do a signed step in two calls: ${SIGN_REQUEST_FALLBACK} `
  + 'with payload as its only argument, set to the step\'s payload, then call act with the same descriptor_url and action_iri and with payload set to exactly '
  + 'the _signature and _signed_payload it returned, unchanged.';
/** How many times `part` occurs in `text`. */
const timesIn = (text: string, part: string): number => text.split(part).length - 1;
/**
 * Each fallback is said once in a copied prompt, in the shared helper's sentence: Work Redesign's own rules say which
 * actions are signed and which plain, and leave what to do without sign_payload to that sentence, so an assistant is not
 * told the same thing twice in two wordings.
 */
function saysEachFallbackOnce(where: string, text: string): void {
  expect([where, timesIn(text, NO_OPTION), timesIn(text, PLAIN_FALLBACK), timesIn(text, SIGN_REQUEST_FALLBACK), timesIn(text, 'sign_request'), timesIn(text, FALLBACK_BOTH)])
    .toEqual([where, 1, 1, 1, 1, 1]);
  const how = text.split('\n\n').find((part) => part.startsWith('How to do each step:')) ?? '';
  expect([where, how.split('\n').at(-1)]).toEqual([where, FALLBACK_BOTH]);
}
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
  /** Register the person, by their user DID, as a process lead and a team member, with one type of task (signed by a key admin, before the page opens). */
  readonly lead?: boolean;
  /** The sign-in routes' relay limits and their clock, and whether the app trusts one proxy hop (as server.ts does off loopback), so X-Forwarded-For names the client. */
  readonly limits?: Partial<RelayLimits>; readonly now?: () => number; readonly trustProxy?: boolean;
  /** Whether the operator lets chat agents take decisive acts too (WRD_CHAT_AGENTS_DECIDE=1); off unless set. */
  readonly chatAgentsDecide?: boolean;
  /** How the bridge answers reads: signed only (the default), or open to anyone (WRD_PUBLIC_READS=1). */
  readonly reads?: UiReads;
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
  const keyAdmin = importWallet(`0x${sha256Hex('wrd-sign-in-test:key-admin')}`, 'human', 'key-admin');
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), recordKey: DEMO_RECORD_KEY,
    platform: { wallet: importWallet(`0x${sha256Hex('wrd-sign-in-test:platform')}`, 'agent', 'wrd-platform'), keyKind: 'demo' },
    adminDids: o.admin === false ? [] : [PERSON], relayDelegation: { ...policy, chatAgentsDecide: o.chatAgentsDecide === true, relayUrl: relay.base },
    ...(o.reads === 'public' ? { publicReads: true } : {}),
    ...(o.lead === true ? { adminAddresses: [keyAdmin.address] } : {}),
  });
  if (o.lead === true) {
    const registry = {
      intent: 'wrd:update-registry', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: 'sign-in-lead-registry-1',
      entries: [{ address: PERSON, roles: ['operator', 'worker'], label: 'Pat', softwareAgent: false, personRef: 'p-pat' }],
      taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order.' }],
    };
    const r = objOf(await handlers['wrd.update_registry']!({ envelope: { payload: registry, signature: await signMessageRaw(keyAdmin, canonicalJson(registry)) } }));
    expect(r['status']).toBe('registered');
  }
  const l = await listenLoopback(createVerticalBridge({
    verticalName: 'work-redesign', affordances: wrdAffordances, handlers, deploymentUrl: deployed,
    middleware: (a) => {
      if (o.trustProxy === true) a.set('trust proxy', 1);
      attachUi(a, { base: deployed, ...(signIn ? { signIn } : {}), ...(o.reads ? { reads: o.reads } : {}) });
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
/**
 * The shipped shell at `path` and app.js in a jsdom window, its sessionStorage seeded with `session` (the tab's, across the
 * relay's page); a request to `failPath` fails as a network error does; `setup` runs before the client (a wallet in the browser).
 */
async function openPage(bridge: string, path: string, session: Record<string, string> = {}, failPath?: string, setup?: (w: JSDOM['window']) => void): Promise<Page> {
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
  setup?.(w);
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
    // A signed-out visitor meets a welcome, with the way to create an account on the configured identity host.
    expect(first.text()).toContain('Welcome to Work Redesign');
    expect(first.text()).toContain('Create your account');
    const create = [...first.window.document.querySelectorAll('a')].find((a) => a.textContent === 'Create your account');
    expect(create?.getAttribute('href')).toMatch(/^https:\/\//);
    expect(create?.getAttribute('href')).toContain(IDENTITY);

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
    page.click('People & roles');
    await page.until(() => page.text().includes('Add a type of task'), 'the roles view');
    const form = [...page.window.document.querySelectorAll('details.card')].find((x) => x.querySelector('summary')?.textContent === 'Add a type of task');
    const inputs = [...(form?.querySelectorAll('input') ?? [])];
    expect(inputs).toHaveLength(3);
    page.fill(inputs[0]!, 'Invoice matching');
    page.fill(inputs[1]!, 'invoice-matching');
    page.fill(inputs[2]!, 'Match an invoice to its purchase order.');
    page.click('Add type of task');
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
    // The first button reading "Sign out" is the account menu's.
    expect([...page.window.document.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')?.closest('#account-menu') ?? null).not.toBeNull();
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
      // The relay signs its session's own OAuth client as client_id and drops a caller's.
      [{ ...payload, client_id: 'https://elsewhere.example/ui/oauth/client.json' }, /payload holds "client_id", which the relay sets itself or drops/],
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

  it('keeps the header of a workspace open to read inside a phone\'s screen: the small Sign in says "Sign in" alone where its words would not fit, its text still the whole label, and beside Connect wallet the buttons take a line of their own under the brand', async () => {
    // With reads open, a visitor not signed in sees the app, "Sign in with your Interego account" in its header: it ran 215 px
    // past a 320 px screen and 38 past 768; with a wallet in the browser, Connect wallet beside it, 351 and 173.
    const w = await world({ reads: 'public' });
    const css = await (await fetch(`${w.bridge}/ui/app.css`)).text();
    for (const wallet of [false, true]) {
      const page = await openPage(w.bridge, '/ui', {}, undefined, wallet ? (win) => { (win as unknown as { ethereum: unknown }).ethereum = { request: async () => [] }; } : undefined);
      const d = page.window.document;
      const header = await page.until(() => [...d.querySelectorAll('.app-header')].find((x) => [...x.querySelectorAll('button')].some((b) => b.textContent === SIGN_IN)), 'the header\'s Sign in');
      const signIn = must([...header.querySelectorAll('button')].find((b) => b.textContent === SIGN_IN), 'Sign in');
      const note = must([...d.querySelectorAll('.callout button')].find((b) => b.textContent === SIGN_IN), 'the note\'s Sign in');
      expect([wallet, [...header.querySelectorAll('.app-header__actions > button')].map((b) => b.textContent)]).toEqual([wallet, wallet ? ['Refresh', 'Connect wallet', SIGN_IN] : ['Refresh', SIGN_IN]]);
      expect([wallet, header.classList.contains('app-header--two-ways'), signIn.querySelector('.sign-in__more')?.textContent]).toEqual([wallet, wallet, ' with your Interego account']);
      const sheet = d.createElement('style');
      d.head.append(sheet);
      const cs = (el: Element): CSSStyleDeclaration => page.window.getComputedStyle(el);
      const inner = must(header.querySelector('.app-header__inner'), 'the header\'s line');
      const actions = must(header.querySelector('.app-header__actions'), 'its buttons');
      for (const px of [1280, 768, 300]) {
        sheet.textContent = atWidth(css, px);
        // In the header "Sign in" alone below 64em; in the note below 30em. Either way its text is SIGN_IN, which a test clicks.
        const shown = (el: Element | null): boolean => cs(must(el, 'its other words')).display !== 'none';
        expect([wallet, px, shown(signIn.querySelector('.sign-in__more')), shown(note.querySelector('.sign-in__more'))]).toEqual([wallet, px, px >= 1024, px >= 480]);
        // Two ways to sign in take a line of their own on a phone, and the navigation's place under the header moves down to match.
        const twoLines = wallet && px < 768;
        expect([wallet, px, cs(inner).flexWrap, cs(actions).flexBasis, cs(actions).minHeight, cs(d.documentElement).getPropertyValue('--header-h')])
          .toEqual([wallet, px, twoLines ? 'wrap' : '', twoLines ? '100%' : '', twoLines ? 'var(--target)' : '', twoLines ? '7rem' : '4rem']);
      }
      sheet.remove();
      expect(page.errors).toEqual([]);
    }
  });

  it('names the Interego connector in the shell only where a chat assistant\'s acts are taken: the relay\'s /mcp when it is trusted, nothing with no relay URL or no relay trusted', async () => {
    const on = await world();
    for (const path of ['/ui', '/ui/oauth/callback']) {
      const shell = await (await fetch(`${on.bridge}${path}`)).text();
      expect([path, shell.match(/<meta name="wrd-connector"[^>]*>/g)]).toEqual([path, [`<meta name="wrd-connector" content="${on.relay.base}/mcp">`]]);
      expect(shell.match(/<script/g)).toHaveLength(1);
    }
    for (const signIn of ['off', 'no-relay-trusted'] as const) {
      const w = await world({ signIn });
      for (const path of ['/ui', '/ui/oauth/callback']) expect([signIn, path, (await (await fetch(`${w.bridge}${path}`)).text()).includes('wrd-connector')]).toEqual([signIn, path, false]);
    }
  }, 60_000);

  it('a process lead signed in with Interego connects their own AI assistant: the panel shows the connector and copies the workspace details, the document route copies one message that records the map from the chat, a document too long for a chat is held back, and nothing on screen is protocol words', async () => {
    const w = await world({ lead: true });
    const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
    const copied: string[] = [];
    Object.defineProperty(page.window.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } }, configurable: true });
    const d = page.window.document;
    // The panel is named as every way into it is (the account menu, Home's step, the map's "Not connected yet?").
    const panelShown = (): boolean => d.getElementById('panel-title')?.textContent === 'Use your AI assistant';
    const byLabel = (label: string): HTMLButtonElement => {
      const b = [...d.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label);
      if (!b) throw new Error(`no button labelled "${label}"`);
      return b as HTMLButtonElement;
    };

    // Home offers it as an optional step; the account menu has it too. Either opens the same panel.
    expect([...d.querySelectorAll('.checklist__item')].some((li) => li.textContent?.includes('Connect Claude or ChatGPT'))).toBe(true);
    expect([...d.querySelectorAll('#account-menu button')].some((b) => b.textContent === 'Use your AI assistant')).toBe(true);
    page.click('Use your AI assistant');
    await page.until(panelShown, 'the panel');
    const panel = must(d.querySelector('.chat-panel'), 'the panel body');
    // The connector address and the workspace address are field values (never words on screen), each with its own Copy.
    // Changed: each is a read-only box that wraps and grows to its lines (not a one-line input that cut the address off on a
    // phone), and its unseen twin, which sizes the box, holds the same address as an attribute, not as text.
    const boxes = [...panel.querySelectorAll('textarea')] as HTMLTextAreaElement[];
    expect(boxes.map((b) => b.value)).toEqual([`${w.relay.base}/mcp`, `${w.relay.base}/mcp`, DEPLOYED]);
    expect(boxes.map((b) => [b.readOnly, b.className, b.parentElement?.className, b.parentElement?.getAttribute('data-value')]))
      .toEqual(boxes.map((b) => [true, 'input input--mono copy-address__box', 'copy-address', b.value]));
    expect(panel.querySelector('input')).toBeNull();
    for (const b of boxes) expect(d.querySelector(`label[for="${b.id}"]`)?.textContent).toMatch(/^(Connector|Workspace) address$/);
    // Two set-ups, one per app: Claude's shown, ChatGPT's hidden until its tab is chosen.
    const tabs = [...panel.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['In Claude', 'true'], ['In ChatGPT', 'false']]);
    expect((d.getElementById('chat-setup-chatgpt') as HTMLElement).hidden).toBe(true);
    (tabs[1] as HTMLButtonElement).click();
    expect((d.getElementById('chat-setup-chatgpt') as HTMLElement).hidden).toBe(false);
    expect((d.getElementById('chat-setup-claude') as HTMLElement).hidden).toBe(true);
    // ChatGPT's set-up is OpenAI's own: the connector address first ("the address above"), then its five steps, then whose
    // setting decides, what ChatGPT asks before a write, how to pick up new tools, and OpenAI's guide. No plan is named.
    const chatgpt = must(d.getElementById('chat-setup-chatgpt'), 'ChatGPT\'s set-up');
    expect([...chatgpt.querySelectorAll('ol.chat-steps > li')].map((li) => li.textContent)).toEqual(CHATGPT_STEPS);
    expect([...chatgpt.children].map((c) => c.className)).toEqual(['field', 'chat-steps', 'hint', 'hint', 'hint']);
    expect(chatgpt.querySelector('.field textarea')?.getAttribute('class')).toBe('input input--mono copy-address__box');
    expect([...chatgpt.querySelectorAll('p.hint')].map((x) => x.textContent)).toEqual([
      'Your workspace\'s settings decide whether you can add one. If you don\'t see the option, use copy and paste instead (below).',
      'ChatGPT asks before each write unless you let it remember your choice for that chat. If Interego\'s tools look out of date, refresh it from its page in your app settings.',
      'OpenAI\'s guide to custom MCP servers',
    ]);
    const guide = must(chatgpt.querySelector('a'), 'the guide link');
    expect([guide.getAttribute('href'), guide.getAttribute('target'), guide.getAttribute('rel'), guide.textContent]).toEqual([CHATGPT_GUIDE, '_blank', 'noopener', 'OpenAI\'s guide to custom MCP servers']);
    // Claude's set-up is as it was. Signing in to the connector is said in the same sentence as on the landing page and the guide.
    expect([...must(d.getElementById('chat-setup-claude'), 'Claude\'s set-up').querySelectorAll('ol.chat-steps > li')].map((li) => li.firstChild?.textContent)).toEqual([
      'In Claude, open Settings, then Connectors, then Add custom connector.', 'Name it Interego and paste this address:',
      'Connect, and when it asks, sign in with the same Interego account you use for Work Redesign.', 'In each new chat, turn on Interego from the chat\'s tools menu (+).']);
    // No claim about which plans allow a connector, anywhere in the panel: whose setting it is, and copy and paste without one.
    expect(panel.textContent?.match(PLAN_CLAIM) ?? null).toBeNull();
    expect(panel.textContent).toContain('Whether you can add a connector depends on your plan or workspace settings. Without one, you can still draft a process map with copy and paste');
    const seen = visibleText(d);
    for (const s of ['Work Redesign runs no AI of its own and never asks for an API key', 'the company behind your assistant sees it too', 'What stays in the Work Redesign app', 'Your assistant asks; you answer.', 'Add people by their Interego ID']) expect(seen, s).toContain(s);
    expect(jargonIn(seen)).toEqual([]);

    byLabel('Copy the connector address').click();
    await page.until(() => copied.length === 1, 'the connector address copied');
    expect(copied[0]).toBe(`${w.relay.base}/mcp`);
    page.click('Copy workspace details');
    await page.until(() => copied.length === 2, 'the workspace details copied');
    const details = String(copied[1]);
    for (const s of [`My Work Redesign workspace: ${DEPLOYED}`, `descriptor_url: "${DEPLOYED}/affordances"`, `This workspace's storage address (pod_url), the same for everyone in it and not my own: "${DEMO_POD}"`, `"podUrl":"${DEMO_POD}"`, 'urn:iep:action:wrd:read-records', 'urn:iep:action:wrd:read-envelope-template',
      'except one that takes plain arguments (sign_payload false): urn:iep:action:wrd:task-map-packet\n', 'nonce = the step name', 'done in the Work Redesign app, not from a chat',
      // Which actions are signed and which plain, and nothing more: what to do where the act tool has no sign_payload option
      // is the shared helper's sentence, said once (below). Changed: this rule no longer repeats the sign_request way.
      'Every other action here is signed (sign_payload true), except one that takes plain arguments (sign_payload false): urn:iep:action:wrd:task-map-packet\n',
      // The actions act can't pass arguments to, each with the signed read to use instead (changed: one per line, so no
      // action is followed straight by a comma or a colon, which would read as part of its name), and the intents that
      // are not the action's own name.
      'Leave out three actions, because act passes them no arguments, and use their signed reads instead:\n',
      '  - instead of urn:iep:action:wrd:envelope-template use urn:iep:action:wrd:read-envelope-template\n',
      '  - instead of urn:iep:action:wrd:list-records use urn:iep:action:wrd:read-records\n',
      '  - instead of urn:iep:action:wrd:calibration use urn:iep:action:wrd:read-calibration\n',
      'all take "intent": "wrd:read-records"', '"intent": "wrd:review-agent-run"']) expect(details, s).toContain(s);
    expect(details).not.toContain('Every action here is signed');
    // The pod line names the workspace's storage, never the person's own.
    expect(details).not.toContain('My storage address');
    // An act tool with no sign_payload option: a plain step leaves it out, and a signed step goes through the connector's
    // sign_request with the step's payload as its only argument (what is passed beside it is signed too), then act with
    // the pair unchanged. Each said once.
    saysEachFallbackOnce('the workspace details', details);
    // Each starter is copied whole; its text is previewed only inside a closed disclosure.
    byLabel('Copy: Go through the seven questions with me').click();
    await page.until(() => copied.length === 3, 'the starter copied');
    expect(copied[2]).toContain('never answer for me');
    expect(copied[2]).toContain('urn:iep:action:wrd:classify-task');
    byLabel('Copy: Propose and price a plan').click();
    await page.until(() => copied.length === 4, 'the second starter copied');
    expect(copied[3]).toContain('Use only numbers I give you');
    // Every action a copied text names is one this workspace declares.
    const declared = new Set(wrdAffordances.map((a) => String(a.action)));
    expect([...copied.join('\n').matchAll(/urn:iep:action:wrd:[a-z-]+/g)].map((m) => m[0]).filter((a) => !declared.has(a))).toEqual([]);
    // Every text the panel copies, the starters not copied above included: no action is followed straight by punctuation.
    const panelCopies: string[] = [...copied];
    for (const label of ['Check the tasks that name me', 'Submit a plan for approval']) {
      const before = copied.length;
      byLabel(`Copy: ${label}`).click();
      await page.until(() => copied.length === before + 1, `the starter "${label}" copied`);
      panelCopies.push(String(copied.pop()));
    }
    expect(panelCopies).toHaveLength(6);
    expect(panelCopies.flatMap(urnsRunningIntoPunctuation)).toEqual([]);
    expect([...panelCopies.join('\n').matchAll(/urn:iep:action:wrd:[a-z-]+/g)].map((m) => m[0]).filter((a) => !declared.has(a))).toEqual([]);

    // A wallet signer or the read-only page gets no chat set-up: an assistant acts as the Interego account.
    const panelFor = page.window.eval('chatPanel') as (mode: string) => HTMLElement;
    for (const mode of ['wallet', 'readonly']) {
      const other = panelFor(mode);
      expect([mode, other.textContent]).toEqual([mode, expect.stringContaining('Your AI assistant acts as your Interego account, not your wallet.')]);
      expect([mode, other.querySelector('input, textarea'), other.textContent?.includes('Set it up once')]).toEqual([mode, null, false]);
      expect([mode, other.textContent]).toEqual([mode, expect.stringContaining('Draft a map with copy and paste')]);
      // No "connect once" above "can't work here", and no plan reason that isn't the reason.
      expect([mode, other.textContent?.includes('Connect Claude or ChatGPT once'), other.textContent?.match(PLAN_CLAIM) ?? null]).toEqual([mode, false, null]);
      expect([mode, other.textContent]).toEqual([mode, expect.stringContaining('You can still draft a process map with copy and paste, in any chat app')]);
    }

    // Map a process from a document: the chat route copies ONE message that carries the steps and the document itself.
    page.click('Map a process');
    await page.until(() => d.querySelector('input[name="capture-mode"]'), 'the capture view');
    (d.querySelectorAll('input[name="capture-mode"]')[1] as HTMLInputElement).click();
    await page.until(() => page.text().includes('Have your AI draft the map'), 'the document route');
    expect(page.text()).toContain('In Claude or ChatGPT (recommended)');
    // Spacing: each step's body spaces its own parts; the two route cards inside step 2 are spaced by their own stack gap
    // alone (no step, card-body or paragraph margins inside them), checked as the page's stylesheet applies (jsdom lays nothing out).
    const css = d.createElement('style');
    css.textContent = await (await fetch(`${w.bridge}/ui/app.css`)).text();
    d.head.append(css);
    const cs = (el: Element): CSSStyleDeclaration => page.window.getComputedStyle(el);
    const stepBody = must(d.querySelector('.capture-step > .card__body'), 'a step body');
    expect([...stepBody.children].slice(1).map((el) => cs(el).marginTop)).toEqual([...stepBody.children].slice(1).map(() => 'var(--space-4)'));
    for (const card of d.querySelectorAll('.route-card > .card__body')) {
      expect(cs(card).gap).toBe('var(--space-2)');
      const none = (v: string): boolean => /^(0px|0|)$/.test(v);
      expect([...card.children].map((el) => [el.tagName, none(cs(el).marginTop), none(cs(el).marginBottom)])).toEqual([...card.children].map((el) => [el.tagName, true, true]));
    }
    // A route card's buttons stay inside the card on a phone: a button keeps its label on one line by default (.btn's
    // nowrap), so "Copy the message for my assistant" ran 22 px past its card at 360 px and off the screen at 320. In a route
    // card the label wraps and the button is never wider than its block, a child of the card's body. Real Chromium at
    // 320 to 390 px is the QA's check.
    const routeButtons = [...d.querySelectorAll('.route-card button.btn')] as HTMLButtonElement[];
    expect(routeButtons.map((b) => b.textContent)).toEqual(['Copy the message for my assistant', 'Open Processes', 'Use your AI assistant', 'Copy the message for my AI']);
    expect(cs(routeButtons[0]!).whiteSpace).toBe('normal');
    for (const b of routeButtons) {
      expect([b.textContent, cs(b).whiteSpace, cs(b).maxWidth, cs(b).textAlign]).toEqual([b.textContent, 'normal', '100%', 'left']);
      expect([b.textContent, b.closest('.route-card > .card__body')?.contains(b), cs(b.parentElement!).display]).toEqual([b.textContent, true, 'block']);
    }
    // Elsewhere a button keeps its one line: the rule is the route cards' own.
    expect(cs(must([...d.querySelectorAll('button.btn')].find((b) => b.textContent === 'Fill the tasks from the answer'), 'a step button')).whiteSpace).toBe('nowrap');
    css.remove();
    const docText = 'Supplier invoices arrive by email. The clerk matches each invoice to its purchase order and the goods receipt before approval.';
    page.fill(must(d.querySelector('[data-path="document.title"]'), 'the title field'), 'AP-SOP-014');
    page.fill(must(d.querySelector('[data-path="document.text"]'), 'the text field'), docText);
    page.click('Copy the message for my assistant');
    await page.until(() => copied.length === 5, 'the chat message copied');
    const message = String(copied[4]);
    for (const s of ['urn:iep:action:wrd:task-map-packet', 'urn:iep:action:wrd:read-records', 'urn:iep:action:wrd:record-task-map', 'sign_payload: false', 'sign_payload: true',
      '"storeText":true', 'request.documentSha256', 'Ignore their note about pasting the draft into the capture table', '"document_title":"AP-SOP-014"', `"pod_url":"${DEMO_POD}"`,
      // Its own rule names a signed step, not one way of signing it: the step text says how, sign_payload or sign_request.
      'If you are unsure of a field, ask for the template in a signed step, with urn:iep:action:wrd:read-envelope-template as the action and payload',
      `----- DOCUMENT: AP-SOP-014 -----\n${docText}\n----- END OF DOCUMENT -----`]) expect(message, s).toContain(s);
    // The pod is the workspace's, which everyone in it acts on: never called the person's own storage.
    expect(message).toContain(`This workspace's storage address (pod_url), the same for everyone in it and not my own: "${DEMO_POD}"`);
    expect(message).not.toContain('My storage address');
    // Its plain first step and its signed steps alike: what to do without sign_payload is said once, for both kinds.
    saysEachFallbackOnce('the map message', message);
    // Each level the map may name, exactly as the bridge takes it.
    for (const level of ['"person"', '"person-with-agent-assist"', '"agent-drafts-person-decides"', '"agent-acts-person-audits"']) expect(message, level).toContain(level);
    expect(message).not.toContain('agent-acts-within-grant');
    expect([...message.matchAll(/urn:iep:action:wrd:[a-z-]+/g)].map((m) => m[0]).filter((a) => !declared.has(a))).toEqual([]);
    // Copying it signed nothing and sent nothing.
    expect(page.log.filter((r) => r.path === '/wrd/record_task_map' || r.path === '/wrd/task_map_packet')).toEqual([]);
    expect(urnsRunningIntoPunctuation(message)).toEqual([]);
    expect(jargonIn(visibleText(d))).toEqual([]);

    // A document longer than a chat can record is held back as it is typed, with the reason, and copy and paste stays.
    const TOO_LONG = 'This document is too long to record from a chat. Use Copy and paste.';
    const chatButton = (): HTMLButtonElement => [...d.querySelectorAll('button')].find((b) => b.textContent === 'Copy the message for my assistant') as HTMLButtonElement;
    const textField = must(d.querySelector('[data-path="document.text"]'), 'the text field');
    const countHint = (): string => textField.closest('.field')?.querySelector('.hint')?.textContent ?? '';
    // The note's live region shares the button's block, so while it is empty it adds no gap to the card.
    expect(chatButton().parentElement?.querySelector('.route-card__gate[aria-live="polite"]')?.parentElement).toBe(chatButton().parentElement);
    expect([chatButton().disabled, visibleText(d).includes(TOO_LONG)]).toEqual([false, false]);
    expect(countHint()).toBe(`${docText.length} of the 20,000 characters a chat can record.`);
    page.fill(textField, 'x'.repeat(20_001));
    expect([chatButton().disabled, visibleText(d).includes(TOO_LONG)]).toEqual([true, true]);
    // The count follows the text as it is typed, so it never contradicts the note.
    expect(countHint()).toBe('20,001 characters, more than the 20,000 a chat can record.');
    expect(chatButton().title).toBe(TOO_LONG);
    chatButton().click();
    expect(copied).toHaveLength(5);
    expect([...d.querySelectorAll('button')].some((b) => b.textContent === 'Copy the message for my AI' && !(b as HTMLButtonElement).disabled)).toBe(true);
    // Shortened again, with nothing redrawn in between, the chat route is back and the note is gone.
    page.fill(textField, `${docText} `.repeat(20).slice(0, 2_000));
    expect([chatButton().disabled, chatButton().hasAttribute('title'), visibleText(d).includes(TOO_LONG)]).toEqual([false, false, false]);
    // Exactly the limit is still a chat's to record.
    page.fill(textField, 'y'.repeat(20_000));
    expect([chatButton().disabled, visibleText(d).includes(TOO_LONG)]).toEqual([false, false]);
    expect(countHint()).toBe('20,000 of the 20,000 characters a chat can record.');
    page.fill(textField, docText);
    page.click('Copy the message for my assistant');
    await page.until(() => copied.length === 6, 'the chat message copied after shortening');
    expect(String(copied[5])).toContain(`----- DOCUMENT: AP-SOP-014 -----\n${docText}\n----- END OF DOCUMENT -----`);
    // Copy and paste's message too: of every text this page copies, no action runs into punctuation.
    page.click('Copy the message for my AI');
    await page.until(() => copied.length === 7, 'the copy-and-paste message copied');
    expect(String(copied[6])).toContain(`----- DOCUMENT: AP-SOP-014 -----\n${docText}\n----- END OF DOCUMENT -----`);
    expect(copied.flatMap(urnsRunningIntoPunctuation)).toEqual([]);
    expect(page.errors).toEqual([]);
  }, 90_000);

  it('tells an assistant whose act tool has no sign_payload option to sign through the connector\'s sign_request, with the payload as its only argument, and pass act the pair unchanged, wherever Work Redesign\'s own words say to sign: the envelope template\'s rule, every relay-signed input and each signed affordance\'s envelope', async () => {
    const TWO_CALLS = 'where your act tool has no sign_payload option, call the connector\'s sign_request tool with payload as its only argument, set to this payload, then call act with the same descriptor_url and action_iri and with payload set to exactly the _signature and _signed_payload it returned, unchanged';
    expect(RELAY_SIGNING).toContain(TWO_CALLS);
    expect(RELAY_SIGNING).toContain('act with sign_payload: true and this payload');
    // The template the bridge hands out carries it.
    const w = await world({ lead: true });
    const t = objOf(await (await fetch(`${w.bridge}/wrd/envelope_template?intent=${encodeURIComponent('wrd:ratify-task')}`)).json());
    expect([t['status'], String(t['signing'])]).toEqual(['templated', expect.stringContaining(TWO_CALLS)]);
    // Every relay-signed input: how to make it without sign_payload, and what act then sends.
    const inputs = wrdAffordances.flatMap((a) => (a.inputs ?? []).map((i) => ({ action: String(a.action), name: i.name, description: String(i.description ?? '') })));
    const signedPayload = inputs.filter((i) => i.name === '_signed_payload');
    expect(signedPayload.length).toBeGreaterThan(0);
    // In whole sentences: how to have the payload signed either way, then what that payload holds (no fragment after a
    // semicolon), and no issuedAt, which the relay's own timestamp takes the place of.
    for (const i of signedPayload) expect([i.action, i.description]).toEqual([i.action, expect.stringContaining('. To have the payload signed, call act with sign_payload: true, or, where act has no sign_payload option, call the connector\'s sign_request tool with payload as its only argument. That payload has the same fields as the envelope payload, podUrl and a nonce included, and needs no issuedAt. ')]);
    // Where a description says what act sends (two inputs' and one affordance's own), it holds for either way of signing.
    const texts = [...inputs, ...wrdAffordances.map((a) => ({ action: String(a.action), name: '(the affordance)', description: String(a.description ?? '') }))];
    const pairOnly = texts.filter((i) => i.description.includes('sends only the signed pair'));
    expect(pairOnly.length).toBeGreaterThanOrEqual(3);
    for (const i of pairOnly) expect([i.action, i.name, i.description]).toEqual([i.action, i.name, expect.stringContaining('act sends only the signed pair, whether made with sign_payload: true or passed on as returned by sign_request with payload as its only argument')]);
    expect(texts.filter((i) => i.description.includes('act … sign_payload: true sends only'))).toEqual([]);
    // sign_request signs what it is given beside the payload too (descriptor_url or action_iri passed to it would be folded
    // into what is signed), so every Work Redesign text that names it says the payload is its only argument.
    const namingIt = [{ action: '(RELAY_SIGNING)', name: '', description: RELAY_SIGNING }, { action: '(the template)', name: 'signing', description: String(t['signing']) }, ...texts]
      .filter((i) => i.description.includes('sign_request'));
    expect(namingIt.length).toBeGreaterThanOrEqual(signedPayload.length + pairOnly.length + 2);
    for (const i of namingIt) expect([i.action, i.name, i.description]).toEqual([i.action, i.name, expect.stringContaining('with payload as its only argument')]);
  }, 60_000);

  it('the panel works from the keyboard: its two set-ups are tabs the arrow keys, Home and End move between, Escape closes it back to what opened it, and where the browser refuses the clipboard the text to copy opens over it and closes back to it', async () => {
    const w = await world({ lead: true });
    const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
    const d = page.window.document;
    const panelTitle = (): string | null => d.getElementById('panel-title')?.textContent ?? null;
    // Opened from the account menu, with focus there, as a keyboard user opens it.
    const item = must([...d.querySelectorAll('#account-menu button')].find((b) => b.textContent === 'Use your AI assistant') as HTMLButtonElement | undefined, 'the menu item');
    item.focus();
    item.click();
    await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel');
    const tab = (id: string): HTMLButtonElement => must(d.getElementById(`chat-tab-${id}`), `the ${id} tab`) as HTMLButtonElement;
    const shown = (): unknown => ({
      selected: ['claude', 'chatgpt'].filter((id) => tab(id).getAttribute('aria-selected') === 'true'),
      tabindex: ['claude', 'chatgpt'].map((id) => tab(id).getAttribute('tabindex')),
      visible: ['claude', 'chatgpt'].filter((id) => !(d.getElementById(`chat-setup-${id}`) as HTMLElement).hidden),
      focused: d.activeElement?.id,
    });
    const press = (key: string): boolean => {
      const e = new page.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      (d.activeElement ?? d.body).dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Only the chosen tab is in the Tab order (a roving tabindex), so the keys reach the other one.
    tab('claude').focus();
    expect(shown()).toEqual({ selected: ['claude'], tabindex: ['0', '-1'], visible: ['claude'], focused: 'chat-tab-claude' });
    expect(press('ArrowRight')).toBe(true);
    expect(shown()).toEqual({ selected: ['chatgpt'], tabindex: ['-1', '0'], visible: ['chatgpt'], focused: 'chat-tab-chatgpt' });
    expect(d.getElementById('chat-setup-chatgpt')?.textContent).toContain(CHATGPT_STEPS[0]);
    expect(press('ArrowRight')).toBe(true);   // wraps
    expect(shown()).toEqual({ selected: ['claude'], tabindex: ['0', '-1'], visible: ['claude'], focused: 'chat-tab-claude' });
    expect(press('ArrowLeft')).toBe(true);    // wraps the other way
    expect(shown()).toEqual({ selected: ['chatgpt'], tabindex: ['-1', '0'], visible: ['chatgpt'], focused: 'chat-tab-chatgpt' });
    expect(press('Home')).toBe(true);
    expect(shown()).toEqual({ selected: ['claude'], tabindex: ['0', '-1'], visible: ['claude'], focused: 'chat-tab-claude' });
    expect(press('End')).toBe(true);
    expect(shown()).toEqual({ selected: ['chatgpt'], tabindex: ['-1', '0'], visible: ['chatgpt'], focused: 'chat-tab-chatgpt' });
    // Any other key is the browser's (Enter and Space press the focused tab, which is already chosen).
    expect(press('Enter')).toBe(false);
    expect(press('ArrowDown')).toBe(false);
    expect(shown()).toEqual({ selected: ['chatgpt'], tabindex: ['-1', '0'], visible: ['chatgpt'], focused: 'chat-tab-chatgpt' });
    // Keys pressed elsewhere in the panel move no tab.
    must(d.querySelector('.chat-panel textarea'), 'a field').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(shown()).toMatchObject({ selected: ['chatgpt'], visible: ['chatgpt'] });

    // A browser that refuses the clipboard: the text to copy opens over the panel, says how to copy it by hand, and closes back to
    // the panel as it was (ChatGPT's set-up still chosen), with focus on the Copy button that opened it.
    Object.defineProperty(page.window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
    const copyDetails = (): HTMLButtonElement => must([...d.querySelectorAll('.chat-panel button')].find((b) => b.textContent === 'Copy workspace details'), 'Copy workspace details') as HTMLButtonElement;
    copyDetails().focus();
    page.click('Copy workspace details');
    await page.until(() => panelTitle() === 'Copy this', 'the text to copy by hand');
    expect(page.text()).toContain('Select all of the text below and copy it yourself.');
    const box = must(d.querySelector('#app textarea[readonly]'), 'the text to copy') as HTMLTextAreaElement;
    expect(box.value).toContain('My Work Redesign workspace:');
    expect(d.querySelector('.chat-panel')).toBeNull();
    must(d.querySelector('button[aria-label="Close"]'), 'Close').dispatchEvent(new page.window.MouseEvent('click', { bubbles: true }));
    await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel again');
    expect(shown()).toMatchObject({ selected: ['chatgpt'], visible: ['chatgpt'] });
    expect(d.activeElement).toBe(copyDetails());
    // Escape in the text to copy goes back the same way; from a starter's Copy, back to that one.
    page.click('Copy workspace details');
    await page.until(() => panelTitle() === 'Copy this', 'the text to copy by hand again');
    must(d.querySelector('#app textarea[readonly]'), 'the text to copy').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel after Escape');
    expect(d.activeElement).toBe(copyDetails());
    const starterCopy = must(d.querySelector('.chat-starters button[aria-label="Copy: Submit a plan for approval"]'), 'a starter\'s Copy') as HTMLButtonElement;
    starterCopy.focus();
    starterCopy.click();
    await page.until(() => panelTitle() === 'Copy this', 'the starter to copy by hand');
    must(d.getElementById('panel-title'), 'the title').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel after the starter');
    expect(d.activeElement).toBe(starterCopy);

    // Escape closes the panel, and focus goes back to the account menu's button, which opened it.
    tab('chatgpt').focus();
    expect(press('Escape')).toBe(true);
    await page.until(() => d.getElementById('panel-title') === null, 'the panel closed');
    expect(d.activeElement?.classList.contains('user-button')).toBe(true);
    // Opened from a button in the view, it goes back to that button.
    const homeStep = must([...d.querySelectorAll('#app button')].find((b) => b.textContent === 'Use your AI assistant' && !b.closest('#account-menu')) as HTMLButtonElement | undefined, 'Home\'s step');
    homeStep.focus();
    homeStep.click();
    await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel from Home');
    must(d.getElementById('panel-title'), 'the title').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await page.until(() => d.getElementById('panel-title') === null, 'the panel closed again');
    expect([d.activeElement?.textContent, d.activeElement?.closest('#account-menu')]).toEqual(['Use your AI assistant', null]);
    // Opened from Map a process's "Not connected yet?", inside a disclosure the view draws closed: the disclosure opens again,
    // with focus on the button in it.
    page.click('Map a process');
    await page.until(() => d.querySelectorAll('input[name="capture-mode"]').length === 2, 'the capture view');
    (d.querySelectorAll('input[name="capture-mode"]')[1] as HTMLInputElement).click();
    await page.until(() => page.text().includes('Have your AI draft the map'), 'the document route');
    const notConnected = must([...d.querySelectorAll('.route-card details')].find((x) => x.querySelector('summary')?.textContent === 'Not connected yet?'), 'Not connected yet?') as HTMLDetailsElement;
    notConnected.open = true;
    const cardButton = must([...notConnected.querySelectorAll('button')].find((b) => b.textContent === 'Use your AI assistant'), 'its button') as HTMLButtonElement;
    cardButton.focus();
    cardButton.click();
    await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel from Map a process');
    must(d.getElementById('panel-title'), 'the title').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await page.until(() => d.getElementById('panel-title') === null, 'the panel closed from Map a process');
    const reopened = d.activeElement?.closest('details');
    expect([d.activeElement?.textContent, reopened?.querySelector('summary')?.textContent, (reopened as HTMLDetailsElement | null | undefined)?.open]).toEqual(['Use your AI assistant', 'Not connected yet?', true]);

    // The panel's own ways to Map a process close it by switching the view, and the button pressed goes with it: focus goes
    // to the view's heading, not to the page's body (where the next Tab would start again from the top of the page).
    const goTab = page.window.eval('goTab') as (id: string) => void;
    const heading = (): unknown => [d.activeElement?.tagName, d.activeElement?.className, d.activeElement?.textContent, d.activeElement?.getAttribute('tabindex')];
    for (const [route, inDisclosure] of [['Map a process from a document', ''], ['Draft a map with copy and paste', 'No connector?']] as const) {
      goTab('tasks');
      (d.querySelectorAll('#account-menu button') as NodeListOf<HTMLButtonElement>).forEach((b) => { if (b.textContent === 'Use your AI assistant') b.click(); });
      await page.until(() => panelTitle() === 'Use your AI assistant', `the panel for "${route}"`);
      if (inDisclosure) (must([...d.querySelectorAll('.chat-panel details')].find((x) => x.querySelector('summary')?.textContent === inDisclosure), inDisclosure) as HTMLDetailsElement).open = true;
      const go = must([...d.querySelectorAll('.chat-panel button')].find((b) => b.textContent === route), route) as HTMLButtonElement;
      go.focus();
      go.click();
      await page.until(() => d.getElementById('panel-title') === null && page.text().includes('Have your AI draft the map'), `Map a process from "${route}"`);
      expect([route, heading()]).toEqual([route, ['H1', 'page-title', 'Map a process', '-1']]);
    }

    // Copy and paste's "Copy the message for my AI" redraws the view (to add "Show the message"), which builds the button
    // again: focus goes to the new one, so a keyboard user carries on from it. Where the browser refuses the clipboard (as
    // here, still), the text to copy opens with focus on its title, and closing it comes back to the button.
    const cardB = (): HTMLButtonElement => must([...d.querySelectorAll('.route-card button')].find((b) => b.textContent === 'Copy the message for my AI'), 'Card B\'s button') as HTMLButtonElement;
    expect(cardB().getAttribute('data-return')).toBe('document copy-paste-message');
    page.fill(must(d.querySelector('[data-path="document.title"]'), 'the title field'), 'AP-SOP-014');
    page.fill(must(d.querySelector('[data-path="document.text"]'), 'the text field'), 'Supplier invoices arrive by email. The clerk matches each invoice to its purchase order.');
    cardB().focus();
    cardB().click();
    await page.until(() => panelTitle() === 'Copy this', 'the message to copy by hand');
    await page.until(() => d.activeElement?.id === 'panel-title', 'focus on its title');
    must(d.getElementById('panel-title'), 'the title').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await page.until(() => d.getElementById('panel-title') === null, 'the text to copy closed');
    expect(d.activeElement).toBe(cardB());
    const copiedB: string[] = [];
    Object.defineProperty(page.window.navigator, 'clipboard', { value: { writeText: async (s: string) => { copiedB.push(s); } }, configurable: true });
    for (const press of [1, 2]) {
      const pressed = cardB();
      pressed.focus();
      pressed.click();
      await page.until(() => copiedB.length === press && cardB() !== pressed, `the message copied (${press})`);
      await page.until(() => d.activeElement !== d.body, `focus after copying (${press})`);
      expect([press, pressed.isConnected, d.activeElement === cardB(), [...d.querySelectorAll('summary')].some((x) => x.textContent === 'Show the message')]).toEqual([press, false, true, true]);
    }
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('copy and paste\'s message, copied once its packet comes, leaves a person who moved on meanwhile where they went: focus stays in a panel they opened, and the page is not pulled back to the button', async () => {
    const w = await world({ lead: true });
    const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
    const win = page.window;
    const d = win.document;
    const copied: string[] = [];
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } }, configurable: true });
    // The packet is held back until released, as a slow network holds it: the first press of a document always asks for one.
    const held: Array<() => void> = [];
    const inner = win.fetch;
    win.fetch = (async (input: unknown, init?: RequestInit) => {
      if (new URL(String(input), win.location.href).pathname === '/wrd/task_map_packet') await new Promise<void>((r) => { held.push(r); });
      return inner(input as string, init);
    }) as typeof win.fetch;
    // jsdom lays nothing out and scrolls nothing: Card B's button reports itself below the screen, and each scroll to it is noted.
    const KEY = 'document copy-paste-message';
    const box = win.HTMLElement.prototype.getBoundingClientRect;
    win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.getAttribute('data-return') === KEY ? { top: 2400, bottom: 2444, left: 16, right: 300, width: 284, height: 44, x: 16, y: 2400, toJSON: () => ({}) } as DOMRect : box.call(this);
    };
    const scrolledTo: Element[] = [];
    (win.Element.prototype as unknown as { scrollIntoView: (this: Element) => void }).scrollIntoView = function (this: Element) { scrolledTo.push(this); };
    const panelTitle = (): string | null => d.getElementById('panel-title')?.textContent ?? null;
    const cardB = (): HTMLButtonElement => must([...d.querySelectorAll('.route-card button')].find((b) => b.textContent === 'Copy the message for my AI'), 'Card B\'s button') as HTMLButtonElement;
    page.click('Map a process');
    await page.until(() => d.querySelectorAll('input[name="capture-mode"]').length === 2, 'the capture view');
    (d.querySelectorAll('input[name="capture-mode"]')[1] as HTMLInputElement).click();
    await page.until(() => page.text().includes('Have your AI draft the map'), 'the document route');
    page.fill(must(d.querySelector('[data-path="document.title"]'), 'the title field'), 'AP-SOP-014');
    /** Press Card B with a new document text (so a new packet is asked for), do `meanwhile` while it is held, then let it come. */
    const pressThen = async (text: string, meanwhile: () => Promise<void> | void): Promise<HTMLButtonElement> => {
      page.fill(must(d.querySelector('[data-path="document.text"]'), 'the text field'), text);
      const pressed = cardB();
      const before = copied.length;
      pressed.focus();
      pressed.click();
      await page.until(() => held.length === 1, 'the packet asked for');
      await meanwhile();
      must(held.pop(), 'the held packet')();
      await page.until(() => copied.length === before + 1 && cardB() !== pressed, `"${text}" copied and the view drawn again`);
      expect(copied.at(-1)).toContain(`----- DOCUMENT: AP-SOP-014 -----\n${text}\n----- END OF DOCUMENT -----`);
      return pressed;
    };

    // (1) While it is on its way, the person opens "Use your AI assistant" from the account menu and goes to the connector
    // address in it. The copy lands: focus stays on that address in the open panel, and nothing scrolls to Card B behind it.
    const inPanel: { address?: HTMLTextAreaElement } = {};
    await pressThen('Supplier invoices arrive by email. The clerk matches each invoice to its purchase order.', async () => {
      (d.querySelectorAll('#account-menu button') as NodeListOf<HTMLButtonElement>).forEach((b) => { if (b.textContent === 'Use your AI assistant') b.click(); });
      await page.until(() => panelTitle() === 'Use your AI assistant', 'the panel opened while the packet is on its way');
      inPanel.address = must(d.querySelector('.chat-panel textarea'), 'the connector address') as HTMLTextAreaElement;
      inPanel.address.focus();
    });
    const address = must(inPanel.address, 'the address focused in the panel');
    expect([panelTitle(), d.activeElement === address, address.isConnected, d.activeElement === cardB(), scrolledTo]).toEqual(['Use your AI assistant', true, true, false, []]);
    must(d.getElementById('panel-title'), 'the title').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await page.until(() => d.getElementById('panel-title') === null, 'the panel closed');

    // (2) The person scrolls on with the wheel while it is on its way, focus still on the button (a mouse click focuses it):
    // focus goes to the new button, but the page stays where they scrolled it.
    await pressThen('Supplier invoices arrive by email. The clerk matches each one, then files it.', () => {
      d.body.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 600, bubbles: true, cancelable: true }));
    });
    expect([d.activeElement === cardB(), scrolledTo]).toEqual([true, []]);

    // (3) Unchanged where the person did nothing meanwhile: focus goes to the new button, brought into view as it is off the
    // screen (Enter pressed while Tab's scroll was still under way). The watch for moving on is each press's own.
    await pressThen('Supplier invoices arrive by email. The clerk matches each one and approves it.', () => undefined);
    expect([d.activeElement === cardB(), scrolledTo.length, scrolledTo[0] === cardB()]).toEqual([true, 1, true]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  /**
   * A signed-in lead on Map a process, from a document, with its title and text filled in, the clipboard taking every copy,
   * and the packet held back until released (as a slow network holds it): the first press of a document always asks for one.
   */
  async function heldPacketCapture(text: string) {
    const w = await world({ lead: true });
    const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
    const win = page.window;
    const d = win.document;
    const copied: string[] = [];
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } }, configurable: true });
    const held: Array<() => void> = [];
    const hold = { on: true };
    const inner = win.fetch;
    win.fetch = (async (input: unknown, init?: RequestInit) => {
      if (hold.on && new URL(String(input), win.location.href).pathname === '/wrd/task_map_packet') await new Promise<void>((r) => { held.push(r); });
      return inner(input as string, init);
    }) as typeof win.fetch;
    const scrolledTo: Element[] = [];
    (win.Element.prototype as unknown as { scrollIntoView: (this: Element) => void }).scrollIntoView = function (this: Element) { scrolledTo.push(this); };
    page.click('Map a process');
    await page.until(() => d.querySelectorAll('input[name="capture-mode"]').length === 2, 'the capture view');
    (d.querySelectorAll('input[name="capture-mode"]')[1] as HTMLInputElement).click();
    await page.until(() => page.text().includes('Have your AI draft the map'), 'the document route');
    page.fill(must(d.querySelector('[data-path="document.title"]'), 'the title field'), 'AP-SOP-014');
    page.fill(must(d.querySelector('[data-path="document.text"]'), 'the text field'), text);
    const cardB = (): HTMLButtonElement => must([...d.querySelectorAll('.route-card button')].find((b) => b.textContent === 'Copy the message for my AI'), 'Card B\'s button') as HTMLButtonElement;
    const answer = (): HTMLTextAreaElement => {
      const label = must([...d.querySelectorAll('label')].find((l) => l.textContent === 'Your AI\'s answer'), 'the answer\'s label') as HTMLLabelElement;
      return must(d.getElementById(label.htmlFor), 'the answer box') as HTMLTextAreaElement;
    };
    const toasts = (): number => d.querySelectorAll('#toasts .toast').length;
    /** Let every held packet through, and every later one at once. */
    const release = (): void => { hold.on = false; while (held.length) must(held.pop(), 'a held packet')(); };
    return { page, win, d, copied, held, hold, release, scrolledTo, cardB, answer, toasts };
  }

  it('presses copy and paste\'s button twice (a double click, Enter twice) while its packet is on its way: one copy, one toast, and focus stays on the button, as on a later deliberate press; a copy stalled for 10 s no longer holds the button', async () => {
    const text = 'Supplier invoices arrive by email. The clerk matches each invoice to its purchase order.';
    const { page, d, win, copied, held, hold, release, scrolledTo, cardB, toasts } = await heldPacketCapture(text);
    const pressed = cardB();
    pressed.focus();
    pressed.click();
    await page.until(() => held.length === 1, 'the packet asked for');
    // The second press: while the copy is on its way, the button pressed is still there, and still focused.
    pressed.click();
    await new Promise((r) => setTimeout(r, 200));
    release();
    await page.until(() => copied.length >= 1 && cardB() !== pressed, 'the message copied and the view drawn again');
    await new Promise((r) => setTimeout(r, 400));
    // One copy and one toast; focus on the button the redraw built (before, a second copy's redraw left it on nothing).
    expect([copied.length, toasts(), pressed.isConnected, d.activeElement === cardB(), scrolledTo]).toEqual([1, 1, false, true, []]);
    expect(copied[0]).toContain(`----- DOCUMENT: AP-SOP-014 -----\n${text}\n----- END OF DOCUMENT -----`);

    // The second click of a double click adds nothing; Enter held down presses once (its repeats are refused); a later
    // press is a press of its own: a second copy, with focus still on the button.
    const again = cardB();
    again.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    const repeat = new win.KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    const first = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    again.dispatchEvent(repeat);
    again.dispatchEvent(first);
    await new Promise((r) => setTimeout(r, 200));
    expect([copied.length, repeat.defaultPrevented, first.defaultPrevented]).toEqual([1, true, false]);
    again.click();
    await page.until(() => copied.length === 2 && cardB() !== again, 'the message copied again');
    await new Promise((r) => setTimeout(r, 200));
    expect([copied.length, toasts(), d.activeElement === cardB(), scrolledTo]).toEqual([2, 2, true, []]);

    // A copy whose packet is still not there after 10 s no longer holds the button: a press then asks again.
    page.fill(must(d.querySelector('[data-path="document.text"]'), 'the text field'), `${text} Then it is filed.`);
    const stalled = cardB();
    const asked = page.log.filter((l) => l.path === '/wrd/task_map_packet').length;
    hold.on = true;
    stalled.focus();
    stalled.click();
    await page.until(() => held.length === 1, 'the new packet asked for');
    stalled.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(held.length).toBe(1);
    const realNow = win.Date.now.bind(win.Date);
    win.Date.now = () => realNow() + 11_000;
    stalled.click();
    await page.until(() => held.length === 2, 'the packet asked for again once 10 s have gone');
    win.Date.now = realNow;
    release();
    await page.until(() => copied.length === 4 && page.log.filter((l) => l.path === '/wrd/task_map_packet').length === asked + 2, 'both copies made');
    await new Promise((r) => setTimeout(r, 200));
    expect([d.activeElement === cardB(), copied.at(-1)]).toEqual([true, expect.stringContaining('Then it is filed.')]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('leaves a person who went on into a field while copy and paste\'s packet was on its way in that field when the copy lands, with what they typed and their caret', async () => {
    const text = 'Supplier invoices arrive by email. The clerk matches each one, then files it.';
    const { page, d, copied, held, release, scrolledTo, cardB, answer } = await heldPacketCapture(text);
    const pressed = cardB();
    pressed.focus();
    pressed.click();
    await page.until(() => held.length === 1, 'the packet asked for');
    // Tab on into step 3's box and type there, the caret left inside what was typed.
    const box = answer();
    box.focus();
    page.fill(box, 'xyz');
    box.setSelectionRange(1, 2, 'backward');
    release();
    await page.until(() => copied.length === 1 && cardB() !== pressed, 'the message copied and the view drawn again');
    await new Promise((r) => setTimeout(r, 200));
    const now = answer();
    // The box was built again (the waiting note above it went with the typing), and focus is in the new one: the text is
    // there, the caret where it was, and the page did not go back to the button.
    expect([box.isConnected, d.activeElement === now, now.value, now.selectionStart, now.selectionEnd, now.selectionDirection, scrolledTo])
      .toEqual([false, true, 'xyz', 1, 2, 'backward', []]);
    expect(page.text()).not.toContain('Waiting for your AI\'s answer');
    expect(page.errors).toEqual([]);
  }, 60_000);

  /**
   * On a capture page: a clipboard that keeps every text it is given, in order (the last is what it holds), holding back
   * its answer on demand (`clip.hold` writes); the text of every toast with a title, as it is added (a toast goes by itself
   * after 5 s); and Card A's message for the form as it is now, as the page itself makes it.
   */
  function heldClipboard(win: JSDOM['window'], d: Document) {
    const copied: string[] = [];
    const clip = { hold: 0, held: [] as Array<() => void> };
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText: async (t: string) => { copied.push(t); if (clip.hold > 0) { clip.hold -= 1; await new Promise<void>((r) => { clip.held.push(r); }); } } }, configurable: true,
    });
    const said: Array<readonly [string, string]> = [];
    new win.MutationObserver((records) => {
      for (const r of records) for (const t of r.addedNodes) if (t instanceof win.HTMLElement) said.push([t.querySelector('.toast__title')?.textContent ?? '', t.querySelector('.toast__text')?.textContent ?? '']);
    }).observe(must(d.getElementById('toasts'), 'the toast region'), { childList: true });
    const toasts = (title: string): string[] => said.filter(([t]) => t === title).map(([, text]) => text);
    const value = (s: string): string => (must(d.querySelector(s), s) as HTMLInputElement).value;
    const messageNow = (): string => String((win.eval('taskMapChatMessage') as (st: unknown) => string)({
      doc: { title: value('[data-path="document.title"]'), text: value('[data-path="document.text"]') }, workflow: { title: value('[data-path="workflow.title"]') },
    }));
    return { copied, clip, toasts, messageNow };
  }

  for (const [what, sel, to] of [
    ['a rename', '[data-path="workflow.title"]', 'Supplier payments'],
    ['a document edit', '[data-path="document.text"]', 'Supplier invoices arrive by email or by post. The clerk matches each invoice to its purchase order.'],
    ['a title edit', '[data-path="document.title"]', 'AP-SOP-015'],
  ] as const) {
    it(`copies the chat route's message again after ${what} while the clipboard is taking it: the clipboard is left holding the message for the form as it is, "Copied" is said once, and no packet is asked for`, async () => {
      const { page, win, d } = await heldPacketCapture('Supplier invoices arrive by email. The clerk matches each invoice to its purchase order.');
      const { copied, clip, toasts, messageNow } = heldClipboard(win, d);
      page.fill(must(d.querySelector('[data-path="workflow.title"]'), 'the process name'), 'Invoice intake');
      clip.hold = 1;
      page.click('Copy the message for my assistant');
      await page.until(() => clip.held.length === 1, 'the clipboard taking the message');
      const before = messageNow();
      expect(copied).toEqual([before]);
      page.fill(must(d.querySelector(sel), sel), to);
      const now = messageNow();
      expect(now).not.toBe(before);
      must(clip.held.pop(), 'the held clipboard write')();
      await page.until(() => copied.length === 2, 'the message copied again for the form as it is', 5_000);
      await new Promise((r) => setTimeout(r, 300));
      expect([copied, toasts('Copied').length]).toEqual([[before, now], 1]);
      expect(page.log.filter((l) => l.path === '/wrd/task_map_packet')).toEqual([]);
      expect(page.errors).toEqual([]);
    }, 60_000);
  }

  it('takes the chat route\'s message off the clipboard again when the document grows past what a chat can record while the clipboard is taking it, and says nothing was copied', async () => {
    const { page, win, d } = await heldPacketCapture('Supplier invoices arrive by email. The clerk matches each invoice to its purchase order.');
    const { copied, clip, toasts, messageNow } = heldClipboard(win, d);
    clip.hold = 1;
    page.click('Copy the message for my assistant');
    await page.until(() => clip.held.length === 1, 'the clipboard taking the message');
    const before = messageNow();
    const text = must(d.querySelector('[data-path="document.text"]'), 'the text field') as HTMLTextAreaElement;
    page.fill(text, `${text.value}\n${'The clerk files each invoice. '.repeat(700)}`);
    expect(text.value.length).toBeGreaterThan(20_000);
    must(clip.held.pop(), 'the held clipboard write')();
    await page.until(() => toasts('Not copied').length === 1, 'the note that nothing was copied', 5_000);
    await new Promise((r) => setTimeout(r, 300));
    // (Before, the message for the shorter document stayed on the clipboard while the page said nothing was copied.)
    expect([copied, toasts('Copied'), toasts('Not copied')]).toEqual([[before, ''], [], ['The document or the process name changed while the message was being made. Copy it again.']]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('leaves on the clipboard the message a later press of the chat route\'s button copied, when an earlier press gives up on a form that kept changing while the clipboard took its messages', async () => {
    const { page, win, d } = await heldPacketCapture('Supplier invoices arrive by email. The clerk matches each invoice to its purchase order.');
    const { copied, clip, toasts, messageNow } = heldClipboard(win, d);
    const name = must(d.querySelector('[data-path="workflow.title"]'), 'the process name');
    page.fill(name, 'Invoice intake');
    clip.hold = 3;
    page.click('Copy the message for my assistant');
    const names = ['Supplier payments', 'Supplier invoice processing', 'Supplier payments and refunds'];
    for (const [i, renamed] of names.entries()) {
      await page.until(() => clip.held.length === 1, `the clipboard taking a message, then the process renamed "${renamed}"`, 5_000);
      page.fill(name, renamed);
      // The last rename is followed by a press of its own, which copies the message for the form as it is now.
      if (i === names.length - 1) {
        page.click('Copy the message for my assistant');
        await page.until(() => toasts('Copied').length === 1, 'the later press copied');
      }
      must(clip.held.pop(), 'the held clipboard write')();
    }
    await page.until(() => toasts('Not copied').length === 1, 'the earlier press giving up', 5_000);
    await new Promise((r) => setTimeout(r, 300));
    // The earlier press takes nothing off: the later one has written since, and what is there is its message for the form
    // as it is. (Taking it off would leave the clipboard empty after "Copied".)
    expect([copied.length, copied.at(-1), toasts('Copied').length]).toEqual([4, messageNow(), 1]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  /** A signed-in lead (and admin) on Home. */
  async function signedInLead() {
    const w = await world({ lead: true });
    const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
    return { w, page, win: page.window, d: page.window.document };
  }

  it('shows the button Tab reached when a redraw builds it again while the browser is still bringing it into view, and leaves the page alone once the person scrolled, clicked or used another key', async () => {
    const { page, win, d } = await signedInLead();
    // jsdom lays nothing out and scrolls nothing: "Add a task" reports itself below the screen, and each scroll to an element is noted.
    const box = win.HTMLElement.prototype.getBoundingClientRect;
    win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.tagName === 'BUTTON' && this.textContent === 'Add a task' ? { top: 2400, bottom: 2444, left: 16, right: 200, width: 184, height: 44, x: 16, y: 2400, toJSON: () => ({}) } as DOMRect : box.call(this);
    };
    const scrolledTo: Array<readonly [Element, unknown]> = [];
    (win.Element.prototype as unknown as { scrollIntoView: (this: Element, o: unknown) => void }).scrollIntoView = function (this: Element, o: unknown) { scrolledTo.push([this, o]); };
    page.click('Map a process');
    await page.until(() => d.querySelector('[data-path="workflow.title"]'), 'Map a process, by hand');
    const addTask = (): HTMLButtonElement => must([...d.querySelectorAll('.app-main button')].find((b) => b.textContent === 'Add a task'), '"Add a task"') as HTMLButtonElement;
    const tasks = (): number => d.querySelectorAll('[data-path$=".name"]').length;
    const key = (at: EventTarget, k: string): boolean => at.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    /** Tab reaches "Add a task" (Tab's keydown goes to what focus leaves), the person does `meanwhile`, then Enter presses it: a task is added above it. */
    const tabThenEnter = (meanwhile: (b: HTMLButtonElement) => void): void => {
      const n = tasks();
      key(d.body, 'Tab');
      const b = addTask();
      b.focus();
      meanwhile(b);
      key(b, 'Shift');
      key(b, 'Enter');
      b.click();
      expect([tasks(), b.isConnected, d.activeElement === addTask()]).toEqual([n + 1, false, true]);
    };
    // Enter at once: the browser was still scrolling to the button, toward where the one the redraw replaced was. The
    // rebuilt button, pushed down by the new task, is brought to the middle of the screen, focus on it.
    tabThenEnter(() => undefined);
    expect(scrolledTo).toEqual([[addTask(), { block: 'center', behavior: 'instant' }]]);
    // The person turned the wheel, clicked, swiped or used another key after Tab: the page is theirs, and stays where it is.
    for (const meanwhile of [
      (b: HTMLButtonElement) => b.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 300, bubbles: true, cancelable: true })),
      (b: HTMLButtonElement) => b.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true })),
      (b: HTMLButtonElement) => b.dispatchEvent(new win.Event('touchmove', { bubbles: true })),
      (b: HTMLButtonElement) => key(b, 'PageDown'),
      (b: HTMLButtonElement) => key(d.body, ' '),
    ]) {
      scrolledTo.length = 0;
      tabThenEnter(meanwhile);
      expect(scrolledTo).toEqual([]);
    }
    // Long after Tab, the browser has finished its scroll: nothing more to do.
    scrolledTo.length = 0;
    tabThenEnter(() => { const t0 = Date.now(); while (Date.now() - t0 < 1100) { /* the second the browser's scroll may take goes by */ } });
    expect(scrolledTo).toEqual([]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('keeps a pressed button where it was through redraws straight after one another, not taking the page\'s own scroll for the person\'s, and keeps a button clicked just after the wheel under the pointer', async () => {
    const { page, win, d } = await signedInLead();
    // jsdom lays nothing out and scrolls nothing. Here the page has a scroll position, scrollTo moves it and, as in a browser,
    // the scroll event comes a moment later; "Add a task" is 400 px down the screen, 300 px further down for each task added
    // above it.
    let y = 0;
    Object.defineProperty(win, 'scrollY', { get: () => y, configurable: true });
    const moveTo = (to: number): void => {
      if (to === y) return;
      y = to;
      setTimeout(() => win.dispatchEvent(new win.Event('scroll')), 16);
    };
    const scrolls: unknown[] = [];
    (win as unknown as { scrollTo: (o: { top?: number }) => void }).scrollTo = (o) => { scrolls.push(o); if (typeof o?.top === 'number') moveTo(o.top); };
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    page.click('Map a process');
    await page.until(() => d.querySelector('[data-path="workflow.title"]'), 'Map a process, by hand');
    await wait(250);
    scrolls.length = 0;
    const tasks = (): number => d.querySelectorAll('[data-path$=".name"]').length;
    const n0 = tasks();
    const box = win.HTMLElement.prototype.getBoundingClientRect;
    win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!(this.tagName === 'BUTTON' && this.textContent === 'Add a task')) return box.call(this);
      const top = 400 + 300 * (tasks() - n0) - y;
      return { top, bottom: top + 44, left: 16, right: 200, width: 184, height: 44, x: 16, y: top, toJSON: () => ({}) } as DOMRect;
    };
    const addTask = (): HTMLButtonElement => must([...d.querySelectorAll('.app-main button')].find((b) => b.textContent === 'Add a task'), '"Add a task"') as HTMLButtonElement;
    const shownAt = (): number => Math.round(addTask().getBoundingClientRect().top);
    const enter = (b: HTMLButtonElement): void => { b.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); b.click(); };
    const wheel = async (b: HTMLButtonElement): Promise<void> => {
      b.dispatchEvent(new win.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
      moveTo(y + 100);
      await wait(40);
    };
    // Enter three times, 60 ms apart, on a still page: each redraw keeps the button at 400 px, though the scroll event of the
    // redraw before has only just come.
    addTask().focus();
    for (const press of [1, 2, 3]) {
      enter(addTask());
      expect([press, tasks(), d.activeElement === addTask(), shownAt()]).toEqual([press, n0 + press, true, 400]);
      await wait(60);
    }
    expect(scrolls).toEqual([300, 600, 900].map((top) => ({ top, behavior: 'instant' })));
    // The person turns the wheel, then at once clicks the button where it now is: it stays there, under the pointer.
    scrolls.length = 0;
    const clicked = addTask();
    await wheel(clicked);
    const before = shownAt();
    clicked.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    clicked.focus();
    clicked.click();
    expect([tasks(), d.activeElement === addTask(), before, shownAt(), scrolls]).toEqual([n0 + 4, true, 300, 300, [{ top: 1300, behavior: 'instant' }]]);
    // Enter straight after the wheel, or a click followed by the wheel: the page is still scrolling, and it is left to scroll.
    scrolls.length = 0;
    await wheel(addTask());
    enter(addTask());
    addTask().dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    await wheel(addTask());
    enter(addTask());
    expect([tasks(), d.activeElement === addTask(), scrolls]).toEqual([n0 + 6, true, []]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('Dismiss, pressed from the keyboard on an answer on the welcome screen or on "One more step", gives focus to that screen\'s title, so the next Tab goes on from there and not from the top of the page', async () => {
    const w = await world({ admin: false });
    const dismissed = (page: Page): unknown => {
      const d = page.window.document;
      const x = must(d.querySelector('#app .result button[aria-label="Dismiss"]'), 'Dismiss') as HTMLButtonElement;
      x.focus();
      x.click();
      const a = d.activeElement;
      return [d.querySelector('#app .result'), a?.tagName, a?.className, a?.textContent, a?.getAttribute('tabindex')];
    };
    // The welcome screen, answering a sign-in this tab did not start.
    const welcome = await openPage(w.bridge, `/ui/oauth/callback?code=${'c'.repeat(32)}&state=${'B'.repeat(32)}`);
    await welcome.until(() => welcome.text().includes(NOT_STARTED_HERE), 'the answer on the welcome screen');
    expect(dismissed(welcome)).toEqual([null, 'H1', 'auth__title', 'Welcome to Work Redesign', '-1']);
    // One more step: signed in, not yet added, with an answer shown (as a refused copy of the record leaves one).
    const step = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await step.until(() => step.text().includes('One more step'), 'one more step');
    (step.window.eval('showResult') as (tool: string, r: unknown) => void)('wrd.holder_copy', { ok: false, status: 400, body: { kind: 'refusal', error: 'The copy was not made.' } });
    await step.until(() => step.window.document.querySelector('#app .result button[aria-label="Dismiss"]'), 'the answer');
    expect(dismissed(step)).toEqual([null, 'H1', 'auth__title', 'You\'re signed in. One more step.', '-1']);
    expect([...welcome.errors, ...step.errors]).toEqual([]);
  }, 60_000);

  it('"Skip to content" moves focus into the screen, which is not drawn again or taken back to its top, and leaves the address (and so a task page) as it is; #main typed in the address draws nothing again; a task link still opens its task, and leaving it draws the view again', async () => {
    const { page, win, d } = await signedInLead();
    const tops: unknown[] = [];
    (win as unknown as { scrollTo: (o: unknown) => void }).scrollTo = (o) => { tops.push(o); };
    const changes: string[] = [];
    win.addEventListener('hashchange', () => changes.push(win.location.hash));
    const skip = must(d.querySelector('a.skip-link'), 'the skip link') as HTMLAnchorElement;
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));
    const main = must(d.getElementById('main'), 'the main element');
    // The main area takes focus only from the skip link. jsdom does not focus on a click, so the browser's rule is applied
    // here by hand: a click focuses the nearest element around what it hits that can take focus, else none. Were the main
    // area focusable all the time, a click on its plain text would focus it, and the next Tab would go back to its first
    // control instead of on from where the person clicked.
    const FOCUSABLE = 'a[href], button, input, textarea, select, summary, [tabindex]';
    const clickFocuses = (el: Element): Element | null => el.closest(FOCUSABLE);
    const text = must([...main.querySelectorAll('p')].find((x) => !x.closest(FOCUSABLE) && (x.textContent ?? '').trim() !== ''), 'plain text in the view');
    expect([main.tagName, main.hasAttribute('tabindex'), clickFocuses(text)]).toEqual(['MAIN', false, null]);
    skip.click();
    await settle();
    expect([win.location.hash, changes, d.getElementById('main') === main, d.activeElement === main, main.getAttribute('tabindex'), tops]).toEqual(['', [], true, true, '-1', []]);
    // A redraw while it has focus builds it again, focusable, with focus on it, and does not move the page.
    (page.window.eval('render') as () => void)();
    const redrawn = must(d.getElementById('main'), 'the redrawn main element');
    expect([redrawn === main, d.activeElement === redrawn, redrawn.getAttribute('tabindex'), tops]).toEqual([false, true, '-1', []]);
    // Once focus moves on (Tab to the view's first control), it takes focus no more, and a click on its text focuses nothing.
    must(redrawn.querySelector('button'), 'a control in the view').focus();
    await settle();
    expect([redrawn.hasAttribute('tabindex'), clickFocuses(must(redrawn.querySelector('p'), 'its text'))]).toEqual([false, null]);
    // Back on it from the skip link, a press on its plain text: it takes focus no more before the press lands (a browser
    // then gives focus to the page), so the press focuses nothing and the next Tab goes on from where the person pressed,
    // not back to the view's first control at its top.
    const pressed = must([...redrawn.querySelectorAll('p')].find((x) => !x.closest(FOCUSABLE) && (x.textContent ?? '').trim() !== ''), 'plain text in the view');
    skip.click();
    await settle();
    expect([d.activeElement === redrawn, redrawn.getAttribute('tabindex'), clickFocuses(pressed) === redrawn]).toEqual([true, '-1', true]);
    pressed.dispatchEvent(new page.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    expect([redrawn.hasAttribute('tabindex'), clickFocuses(pressed), tops]).toEqual([false, null, []]);
    // #main in the address (typed, or an old link) is the browser's: nothing is drawn again, and the page stays where it is.
    win.location.hash = '#main';
    await page.until(() => changes.length === 1, 'the address changed');
    await settle();
    expect([d.getElementById('main') === redrawn, tops]).toEqual([true, []]);
    // A task link opens the task from its top. The skip link there keeps the task on the screen.
    win.location.hash = `#task=${encodeURIComponent('urn:wrd:task:not-here')}`;
    await page.until(() => page.text().includes('We couldn\'t find this task'), 'the task page');
    expect([d.getElementById('main') === main, tops]).toEqual([false, [{ top: 0 }]]);
    const onTask = must(d.getElementById('main'), 'the task page\'s main element');
    skip.click();
    await settle();
    expect([win.location.hash.startsWith('#task='), page.text().includes('We couldn\'t find this task'), d.getElementById('main') === onTask, d.activeElement === onTask, tops.length])
      .toEqual([true, true, true, true, 1]);
    // Leaving it shows the view again, from its top.
    win.location.hash = '';
    await page.until(() => page.text().includes('Map and change your process'), 'Home again');
    expect(tops).toEqual([{ top: 0 }, { top: 0 }]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('"Add a type of task" keeps what was typed and stays open through a refusal, empties and closes once the type is added, and its button, pressed from the keyboard, keeps focus while signing and takes no second press; Dismiss on the answer, from the keyboard, gives focus to the view\'s heading', async () => {
    const { w, page, d } = await signedInLead();
    page.click('People & roles');
    await page.until(() => page.text().includes('Add a type of task'), 'People & roles');
    const form = (): HTMLDetailsElement => must(d.querySelector('details.kind-form'), 'the form') as HTMLDetailsElement;
    const fields = (): HTMLInputElement[] => [...form().querySelectorAll('input')] as HTMLInputElement[];
    const addButton = (): HTMLButtonElement => must([...form().querySelectorAll('button')].find((b) => b.textContent === 'Add type of task'), 'its button') as HTMLButtonElement;
    const answer = (): string => d.querySelector('#app .result .callout__title')?.textContent ?? '';
    must(form().querySelector('summary'), 'its summary').click();
    await page.until(() => form().open, 'the form open');
    const typed = ['Credit check', 'Not A Slug!', 'Check a customer\'s credit before an order ships.'];
    fields().forEach((f, i) => page.fill(f, typed[i] ?? ''));
    // While the relay is signing, the button only looks off: a redraw builds the form again, as typed, and focus stays on
    // the rebuilt button, so the next Tab goes on from it. A press then sends nothing more.
    const release = w.relay.hold();
    const pressed = addButton();
    pressed.focus();
    pressed.click();
    await page.until(() => w.relay.held() === 1, 'the signature asked for');
    const signing = addButton();
    expect([signing === pressed, signing.disabled, signing.getAttribute('aria-disabled'), d.activeElement === signing, form().open, fields().map((f) => f.value)])
      .toEqual([false, false, 'true', true, true, typed]);
    const sent = page.sent.length;
    signing.click();
    await new Promise((r) => setTimeout(r, 100));
    expect([w.relay.held(), page.sent.slice(sent)]).toEqual([1, []]);
    release();
    // The bridge refuses the ID: the form is still open, with everything as it was typed, to fix.
    await page.until(() => !page.text().includes('Signing and sending') && answer() !== '', 'the refusal');
    expect([answer(), form().open, fields().map((f) => f.value), addButton().disabled, addButton().getAttribute('aria-disabled')]).toEqual(['Something in this form isn\'t right', true, typed, false, null]);
    page.fill(must(fields()[1], 'the Short ID'), 'credit-check');
    addButton().click();
    await page.until(() => answer() === 'People and roles updated' && page.text().includes('credit-check'), 'the type added');
    await page.until(() => !form().open, 'the form closed');
    expect(fields().map((f) => f.value)).toEqual(['', '', '']);
    // Dismiss, pressed from the keyboard: the answer goes, and focus goes to the view's heading, not back to the top of the page.
    const dismiss = must(d.querySelector('#app .result button[aria-label="Dismiss"]'), 'Dismiss') as HTMLButtonElement;
    dismiss.focus();
    dismiss.click();
    const heading = d.activeElement;
    expect([d.querySelector('#app .result'), heading?.tagName, heading?.textContent, heading?.getAttribute('tabindex')]).toEqual([null, 'H1', 'People & roles', '-1']);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('where the operator lets chat agents decide too, the panel says so, and the workspace details ask the assistant to check with the person first instead of sending them to the app', async () => {
    const w = await world({ lead: true, chatAgentsDecide: true });
    const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
    await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
    const copied: string[] = [];
    Object.defineProperty(page.window.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } }, configurable: true });
    const d = page.window.document;
    page.click('Use your AI assistant');
    await page.until(() => d.getElementById('panel-title')?.textContent === 'Use your AI assistant', 'the panel');
    const seen = visibleText(d);
    expect(seen).toContain('Your assistant can take every action here');
    expect(seen).toContain('Your workspace provider lets chat assistants take every action here too, including approving or declining decisions');
    expect(seen).not.toContain('What stays in the Work Redesign app');
    expect(jargonIn(seen)).toEqual([]);
    page.click('Copy workspace details');
    await page.until(() => copied.length === 1, 'the workspace details copied');
    expect(copied[0]).toContain('Ask me before any action that approves or declines a decision, changes people and roles, records results, or grants or withdraws an AI permission.');
    expect(copied[0]).not.toContain('done in the Work Redesign app, not from a chat');
    expect(urnsRunningIntoPunctuation(String(copied[0]))).toEqual([]);
    expect(page.errors).toEqual([]);
  }, 60_000);

  it('the map message says what to do when step 2 lists no type of task that fits, and offers a step that adds the types the person names, types of task only, only where chat agents decide here and the person is an admin', async () => {
    const NO_KIND = 'Every task needs a type of task that step 2 lists. If step 2 lists none, or none fits a task, tell me, and ask me to add the types in Work Redesign (People & roles, then Types of task, where an admin adds them), then do step 2 again. Never invent a type of task or its slug.';
    const OFFER = ' Or offer to add the types I name yourself, with step 3: show me each one\'s slug, label and definition first, and add them only once I confirm.';
    const doc = { title: 'Fictional procedure', text: 'The clerk saves every new supplier invoice to the intake folder each morning.' };
    for (const [decide, admin] of [[true, true], [false, true], [true, false]] as const) {
      const w = await world({ lead: true, chatAgentsDecide: decide, admin });
      const page = await openPage(w.bridge, '/ui', { [SESSION_KEY]: JSON.stringify({ token: w.relay.mint(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }) });
      await page.until(() => page.text().includes(`Signed in as ${PERSON} via ${agentOf('work-redesign')}`) && page.text().includes('Map and change your process'), 'the signed-in lead');
      const message = String((page.window.eval('taskMapChatMessage') as (st: unknown) => string)({ doc, workflow: { title: '' } }));
      const where = `chatAgentsDecide ${decide}, admin ${admin}`;
      // Step 2 reads the registry alone: who is registered, nothing else.
      expect([where, message]).toEqual([where, expect.stringContaining('"intent":"wrd:read-records","podUrl":"' + DEMO_POD + '","kind":"registry","nonce":"read-records-<turn number, or 0>-<16 new random letters or digits>"')]);
      expect([where, message]).toEqual([where, expect.stringContaining(`- ${NO_KIND}`)]);
      const offered = decide && admin;
      expect([where, message.includes(OFFER), message.includes('urn:iep:action:wrd:update-registry')]).toEqual([where, offered, offered]);
      if (offered) {
        // Step 3 adds types of task only, with the copied messages' nonce; recording the map is step 4.
        expect(message).toContain('3. Only if I ask you to add types of task, and only once I have confirmed each one: add them. Types of task only, never people, roles or rules.\n   action_iri: "urn:iep:action:wrd:update-registry"\n   sign_payload: true');
        const line = must(message.split('\n').find((l) => l.startsWith('   payload: {"intent":"wrd:update-registry"')), 'step 3\'s payload');
        const payload = objOf(JSON.parse(line.slice('   payload: '.length)));
        expect(Object.keys(payload).sort()).toEqual(['intent', 'nonce', 'podUrl', 'taskKinds']);
        expect(payload['nonce']).toBe('update-registry-<turn number, or 0>-<16 new random letters or digits>');
        expect(message).toContain('4. Once I have confirmed the draft, record the map.');
      } else {
        expect(message).toContain('3. Once I have confirmed the draft, record the map.');
      }
      // The template rule's nonce is made as every other signed payload's: the one the shared helper the page is served with
      // writes into a signed step for that action, so a change to the helper's placeholders reaches this rule too.
      const helper = new Function(`${chatAgentJs()}\nreturn InteregoChatAgent;`)() as { actPrompt(spec: unknown): string };
      const helperNonce = String(objOf(JSON.parse(must(helper.actPrompt({
        affordancesUrl: `${DEPLOYED}/affordances`, steps: [{ say: 'A step.', actionIri: 'urn:iep:action:wrd:read-envelope-template', signed: true, payload: {} }],
      }).split('\n').find((l) => l.startsWith('   payload: ')), 'the helper\'s payload line').slice('   payload: '.length)))['nonce']);
      expect(helperNonce).toBe('read-envelope-template-<turn number, or 0>-<16 new random letters or digits>');
      expect(message).toContain(`"template":{"intent":"wrd:record-task-map"},"nonce":${JSON.stringify(helperNonce)}}`);
      expect(message).not.toContain('"nonce": a new one');
      expect(urnsRunningIntoPunctuation(message)).toEqual([]);
      expect(page.errors).toEqual([]);
    }
  }, 120_000);
});
