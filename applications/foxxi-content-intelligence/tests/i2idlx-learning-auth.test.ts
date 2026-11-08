import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import express from 'express';
import { LearningAccountAuth, LearningAuthError, attachLearningAccountRoutes, type LearningPrincipal } from '../src/i2idlx-learning-auth.js';

const BASE = 'https://workbench.example', RELAY = 'https://relay.example', IDENTITY = 'https://identity.example', POD = 'https://pods.example';
const PATH = '/i2idlx/learning', ALICE = 'u-pk-aaaaaaaaaaaa', BOB = 'u-pk-bbbbbbbbbbbb';
interface ProbeBody { authenticated: boolean; enabled: boolean; csrf: string; subject: string; scope: string; grant_types: string[];
  account: { id: string; userId: string; webId: string } }
interface ProbeResponse extends globalThis.Response { json(): Promise<ProbeBody> }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const cookiePair = (res: globalThis.Response, name: string) => res.headers.getSetCookie().find(value => value.startsWith(name + '='))?.split(';')[0] ?? '';
async function fixture(options: { local?: boolean; maxSessions?: number; maxPending?: number } = {}) {
  let now = 1_800_000_000_000, serial = 0;
  const control = { user: ALICE, accountStatus: 200, accountPatch: {} as Record<string, unknown>, metadataPatch: {} as Record<string, unknown>,
    tokenPatch: {} as Record<string, unknown>, accountCalls: 0, tokenCalls: 0, blockOnce: false, blocked: deferred(), release: deferred() };
  const codes = new Map<string, { challenge: string; client: string; callback: string; state: string; user: string }>();
  const tokens = new Map<string, string>();
  const forms: URLSearchParams[] = [], captures: LearningPrincipal[] = [];
  const provider = express(); provider.use(express.urlencoded({ extended: false }));
  provider.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ issuer: RELAY + '/', authorization_endpoint: RELAY + '/authorize',
    token_endpoint: RELAY + '/token', interego_account_endpoint: RELAY + '/oauth/account', client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp:read'], ...control.metadataPatch }));
  provider.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: RELAY + '/', authorization_servers: [RELAY + '/'] }));
  provider.get('/authorize', (req, res) => {
    assert.equal(req.query.scope, 'mcp:read'); assert.equal(req.query.resource, RELAY + '/'); assert.equal(req.query.code_challenge_method, 'S256');
    assert.equal(req.query.redirect_uri, BASE + PATH + '/oauth/callback'); assert.equal(req.query.client_id, BASE + PATH + '/oauth/client.json');
    const code = 'fixture-code-' + (++serial);
    codes.set(code, { challenge: String(req.query.code_challenge), client: String(req.query.client_id), callback: String(req.query.redirect_uri), state: String(req.query.state), user: control.user });
    const callback = new URL(String(req.query.redirect_uri)); callback.searchParams.set('code', code); callback.searchParams.set('state', String(req.query.state));
    res.redirect(302, callback.href);
  });
  provider.post('/token', (req, res) => {
    control.tokenCalls++; const form = new URLSearchParams(req.body); forms.push(form);
    const saved = codes.get(form.get('code') ?? ''); codes.delete(form.get('code') ?? '');
    if (!saved || form.get('grant_type') !== 'authorization_code' || form.get('resource') !== RELAY + '/' || form.get('client_id') !== saved.client
      || form.get('redirect_uri') !== saved.callback || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== saved.challenge) { res.status(400).json({ error: 'invalid_grant' }); return; }
    const token = 'test-token-' + serial; tokens.set(token, saved.user);
    res.json({ access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'test-refresh', scope: 'mcp:read', ...control.tokenPatch });
  });
  provider.get('/oauth/account', async (req, res) => {
    control.accountCalls++;
    const id = tokens.get((req.get('Authorization') ?? '').slice(7));
    if (!id) { res.status(401).json({ error: 'unknown' }); return; }
    if (control.blockOnce) { control.blockOnce = false; control.blocked.resolve(); await control.release.promise; }
    if (control.accountStatus !== 200) { res.status(control.accountStatus).json({ error: 'fixture' }); return; }
    res.json({ userId: id, ownerDid: `did:web:identity.example:users:${id}`, webId: `${IDENTITY}/users/${id}/profile#me`,
      podUrl: `${POD}/${id}/`, agentId: `did:web:identity.example:agents:i2idl-x-learning-${id}`,
      clientId: BASE + PATH + '/oauth/client.json', scope: 'mcp:read', expiresAt: now / 1000 + 3600, ...control.accountPatch });
  });
  const providerServer = provider.listen(0, '127.0.0.1'); await once(providerServer, 'listening');
  const providerAddress = providerServer.address(); assert.ok(providerAddress && typeof providerAddress !== 'string');
  const physical = `http://127.0.0.1:${providerAddress.port}`;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, RELAY);
    const r = await fetch(physical + url.pathname + url.search, init);
    // Program-injected transport maps the public HTTPS authority onto a real
    // local HTTP server; production still checks the actual response URL.
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const auth = new LearningAccountAuth({ baseUrl: options.local ? 'http://localhost:6080' : BASE, relayOrigin: RELAY, identityOrigin: IDENTITY,
    podOrigin: POD, fetch: transport, now: () => now, maxSessions: options.maxSessions, maxPending: options.maxPending });
  const app = express(); app.use(express.json()); attachLearningAccountRoutes(app, auth);
  const privateRoute = async (req: express.Request, res: express.Response) => {
    try { const p = await auth.resolve(req); captures.push(p); if (req.method === 'POST') auth.assertMutation(req, p); res.json({ subject: p.subject, sessionId: p.sessionId }); }
    catch (error) { res.status(error instanceof LearningAuthError ? error.status : 500).json({ error: error instanceof LearningAuthError ? error.code : 'unexpected' }); }
  };
  app.get('/private', (req, res) => { void privateRoute(req, res); }); app.post('/private', (req, res) => { void privateRoute(req, res); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { control.release.resolve(); auth.dispose(); server.closeAllConnections(); providerServer.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => providerServer.close(() => resolve()))]); });
  const request = (path: string, cookies = '', init: RequestInit = {}) => fetch(local + path, { ...init, redirect: 'manual', headers: { ...(cookies ? { Cookie: cookies } : {}), ...init.headers } }) as Promise<ProbeResponse>;
  async function begin(cookies = '') {
    const start = await request(PATH + '/oauth/start', cookies); assert.equal(start.status, 302); const location = start.headers.get('location')!;
    const pending = cookiePair(start, '__Host-i2idlx-learning-pending');
    const authorized = await transport(location, { redirect: 'manual' }); assert.equal(authorized.status, 302);
    return { callback: new URL(authorized.headers.get('location')!), pending, location, start };
  }
  async function finish(p: Awaited<ReturnType<typeof begin>>, prior = '') {
    const response = await request(p.callback.pathname + p.callback.search, [p.pending, prior].filter(Boolean).join('; '));
    return { response, cookie: cookiePair(response, '__Host-i2idlx-learning') };
  }
  async function login(prior = '') { return finish(await begin(prior), prior); }
  return { auth, request, begin, finish, login, control, forms, tokens, captures, advance: (ms: number) => { now += ms; } };
}

describe('independent human learning-account sign-in', () => {
  it('walks real HTTP PKCE, keeps all relay credentials server-side and ignores model bearers', async () => {
    const f = await fixture();
    const before = await f.request(PATH + '/session'); assert.deepEqual(await before.json(), { authenticated: false, enabled: true, account: null, csrf: null, expires_at: null, sign_in_url: PATH + '/oauth/start' });
    const client = await f.request(PATH + '/oauth/client.json'); const document = await client.json(); assert.equal(document.scope, 'mcp:read'); assert.deepEqual(document.grant_types, ['authorization_code']);
    const p = await f.begin(); assert.ok(!p.location.includes('code_verifier')); assert.ok(!p.location.includes('test-token'));
    const logged = await f.finish(p); assert.equal(logged.response.status, 303); assert.equal(logged.response.headers.get('location'), BASE + '/i2idlx/#ask');
    const header = logged.response.headers.getSetCookie().find(value => value.startsWith('__Host-i2idlx-learning='))!;
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(header.includes(flag)); assert.ok(!header.includes('Domain='));
    const statusResponse = await f.request(PATH + '/session', logged.cookie); const text = await statusResponse.text(), status = JSON.parse(text);
    assert.equal(status.authenticated, true); assert.equal(status.account.id, `did:web:identity.example:users:${ALICE}`); assert.match(status.csrf, /^[a-f0-9]{64}$/);
    for (const secret of [...f.tokens.keys(), 'test-refresh', f.forms[0]!.get('code_verifier')!]) assert.ok(!text.includes(secret) && !header.includes(secret));
    const forged = await f.request('/private', '', { headers: { Authorization: 'Bearer test-agent' } }); assert.equal(forged.status, 401); await forged.text();
    const forgedCookie = await f.request('/private', '__Host-i2idlx-learning=' + 'a'.repeat(64), { headers: { Authorization: 'Bearer test-agent' } }); assert.equal(forgedCookie.status, 401); await forgedCookie.text();
    const self = await f.request('/private', logged.cookie, { headers: { Authorization: 'Bearer test-agent' } }); assert.equal((await self.json()).subject, status.account.id);
    assert.equal(f.forms[0]!.get('state'), null);
  });
  it('separates two human accounts and protects mutations with Origin plus session CSRF', async () => {
    const f = await fixture(), a = await f.login(); f.control.user = BOB; const b = await f.login();
    const sa = await (await f.request(PATH + '/session', a.cookie)).json(), sb = await (await f.request(PATH + '/session', b.cookie)).json();
    assert.notEqual(sa.account.id, sb.account.id);
    const invalidHeaders: Array<Record<string, string>> = [{ Origin: 'https://other.example', 'X-I2IDLX-Learning-CSRF': sa.csrf }, { Origin: BASE }, { Origin: BASE, 'X-I2IDLX-Learning-CSRF': sb.csrf }];
    for (const headers of invalidHeaders) {
      const r = await f.request('/private', a.cookie, { method: 'POST', headers }); assert.equal(r.status, 403); await r.text();
    }
    const accepted = await f.request('/private', a.cookie, { method: 'POST', headers: { Origin: BASE, 'X-I2IDLX-Learning-CSRF': sa.csrf } }); assert.equal((await accepted.json()).subject, sa.account.id);
    const out = await f.request(PATH + '/sign-out', a.cookie, { method: 'POST', headers: { Origin: BASE, 'X-I2IDLX-Learning-CSRF': sa.csrf } }); assert.equal(out.status, 200); await out.text();
    assert.equal(f.captures.find(p => p.subject === sa.account.id)!.signal.aborted, true);
    assert.equal((await (await f.request(PATH + '/session', a.cookie)).json()).authenticated, false);
    assert.equal((await (await f.request(PATH + '/session', b.cookie)).json()).authenticated, true);
  });
  it('requires browser-bound state, consumes it once and refuses expired pending sign-ins', async () => {
    const f = await fixture(), p = await f.begin();
    const missing = await f.request(p.callback.pathname + p.callback.search); assert.equal(missing.status, 400); await missing.text(); assert.equal(f.control.tokenCalls, 0);
    const other = await f.begin(), wrong = new URL(other.callback); wrong.searchParams.set('state', 'wrong');
    const refused = await f.request(wrong.pathname + wrong.search, other.pending); assert.equal(refused.status, 400); await refused.text();
    const replay = await f.finish(other); assert.equal(replay.response.status, 400); await replay.response.text();
    const expired = await f.begin(); f.advance(300_001); const late = await f.finish(expired); assert.equal(late.response.status, 400); await late.response.text(); assert.equal(f.control.tokenCalls, 0);
  });
  it.each([
    { clientId: 'https://different.example/client' }, { ownerDid: `did:web:identity.example:users:${BOB}` },
    { webId: `${IDENTITY}/users/${BOB}/profile#me` }, { podUrl: `${POD}/${BOB}/` },
    { podUrl: `https://attacker.example/${ALICE}/` }, { agentId: `did:web:identity.example:agents:other-${BOB}` },
    { scope: 'mcp' }, { scope: 'mcp:read mcp:write' }, { provisionalPlay: {} }, { expiresAt: 1 },
  ])('rejects inconsistent account metadata %j', async patch => {
    const f = await fixture(); f.control.accountPatch = patch; const result = await f.login(); assert.equal(result.response.status, 401); assert.equal(result.cookie, ''); await result.response.text();
  });
  it('refuses off-origin discovery, broader grants and unavailable local HTTP sign-in', async () => {
    const f = await fixture(); f.control.metadataPatch = { interego_account_endpoint: 'https://attacker.example/oauth/account' };
    const bad = await f.request(PATH + '/oauth/start'); assert.equal(bad.status, 503); await bad.text(); assert.equal(f.control.tokenCalls, 0);
    const local = await fixture({ local: true }); assert.equal(local.auth.enabled, false);
    assert.equal((await (await local.request(PATH + '/session')).json()).enabled, false);
    const no = await local.request(PATH + '/oauth/start'); assert.equal(no.status, 503); await no.text();
    const broad = await fixture(); broad.control.tokenPatch = { scope: 'mcp' }; const r = await broad.login(); assert.equal(r.response.status, 401); await r.response.text();
  });
  it('revalidates authority and aborts queued access on outage, rejection or expiry', async () => {
    const f = await fixture(), logged = await f.login(); const first = await f.request('/private', logged.cookie); assert.equal(first.status, 200); await first.text();
    const principal = f.captures[0]!;
    f.control.accountStatus = 503; const unavailable = await f.request('/private', logged.cookie); assert.equal(unavailable.status, 503); await unavailable.text(); assert.equal(principal.signal.aborted, true);
    f.control.accountStatus = 200; assert.equal((await (await f.request(PATH + '/session', logged.cookie)).json()).authenticated, false);
    const renewed = await f.login(logged.cookie); assert.equal(renewed.response.status, 303); await (await f.request('/private', renewed.cookie)).text(); const renewedPrincipal = f.captures.at(-1)!;
    f.control.accountStatus = 401; const revoked = await f.request('/private', renewed.cookie); assert.equal(revoked.status, 401); await revoked.text(); assert.equal(renewedPrincipal.signal.aborted, true);
    f.control.accountStatus = 200; const fresh = await f.login(); await (await f.request('/private', fresh.cookie)).text(); f.advance(3600_001);
    assert.equal((await (await f.request(PATH + '/session', fresh.cookie)).json()).authenticated, false); assert.equal(f.captures.at(-1)!.signal.aborted, true);
  });
  it('revokes an old human binding on successful account replacement', async () => {
    const f = await fixture(), a = await f.login(); await (await f.request('/private', a.cookie)).text(); const prior = f.captures[0]!;
    f.control.user = BOB; const b = await f.login(a.cookie); assert.equal(b.response.status, 303); assert.equal(prior.signal.aborted, true);
    assert.equal((await (await f.request(PATH + '/session', a.cookie)).json()).authenticated, false);
    assert.equal((await (await f.request(PATH + '/session', b.cookie)).json()).account.userId, BOB);
    await assert.rejects(() => f.auth.revalidate(prior), error => error instanceof LearningAuthError && error.status === 401);
  });
  it('revalidates queued principals without cookies and refuses forged, changed or unavailable bindings', async () => {
    const f = await fixture(), a = await f.login(); await (await f.request('/private', a.cookie)).text(); const p = f.captures[0]!;
    const fresh = await f.auth.revalidate(p); assert.equal(fresh.subject, p.subject); assert.equal(fresh.signal, p.signal);
    for (const changed of [{ ...p, subject: `did:web:identity.example:users:${BOB}` }, { ...p, sessionId: 'forged' }, { ...p, signal: new AbortController().signal }]) {
      await assert.rejects(() => f.auth.revalidate(changed), error => error instanceof LearningAuthError && error.status === 401);
    }
    f.control.accountStatus = 503; await assert.rejects(() => f.auth.revalidate(p), error => error instanceof LearningAuthError && error.status === 503); assert.equal(p.signal.aborted, true);
    await assert.rejects(() => f.auth.revalidate(p), error => error instanceof LearningAuthError && error.status === 401);
    f.control.accountStatus = 200; const b = await f.login(); await (await f.request('/private', b.cookie)).text(); const next = f.captures.at(-1)!;
    f.control.accountPatch = { userId: BOB, ownerDid: `did:web:identity.example:users:${BOB}`, webId: `${IDENTITY}/users/${BOB}/profile#me`, podUrl: `${POD}/${BOB}/`, agentId: `did:web:identity.example:agents:learning-${BOB}` };
    await assert.rejects(() => f.auth.revalidate(next), error => error instanceof LearningAuthError && error.status === 401); assert.equal(next.signal.aborted, true);
  });
  it('cancels a private identity read in flight on sign-out without leaking its result', async () => {
    const f = await fixture(), logged = await f.login(); const s = await (await f.request(PATH + '/session', logged.cookie)).json();
    f.control.blockOnce = true; const pending = f.request('/private', logged.cookie); await f.control.blocked.promise;
    const out = await f.request(PATH + '/sign-out', logged.cookie, { method: 'POST', headers: { Origin: BASE, 'X-I2IDLX-Learning-CSRF': s.csrf } }); assert.equal(out.status, 200); await out.text();
    f.control.release.resolve(); const late = await pending; assert.ok([401, 503].includes(late.status)); assert.ok(!(await late.text()).includes(ALICE));
  });
  it('does not let a callback in flight revive a signed-out account', async () => {
    const f = await fixture(), a = await f.login(); const s = await (await f.request(PATH + '/session', a.cookie)).json(); const p = await f.begin(a.cookie);
    f.control.blockOnce = true; const pending = f.finish(p, a.cookie); await f.control.blocked.promise;
    const out = await f.request(PATH + '/sign-out', a.cookie + '; ' + p.pending, { method: 'POST', headers: { Origin: BASE, 'X-I2IDLX-Learning-CSRF': s.csrf } }); assert.equal(out.status, 200); await out.text();
    f.control.release.resolve(); const result = await pending; assert.ok([401, 503].includes(result.response.status)); assert.equal(result.cookie, ''); await result.response.text();
  });
  it('bounds pending records and live sessions', async () => {
    const f = await fixture({ maxPending: 1 }); const first = await f.begin(); const full = await f.request(PATH + '/oauth/start'); assert.equal(full.status, 429); await full.text();
    const restarted = await f.begin(first.pending); assert.notEqual(restarted.pending, first.pending);
    const old = await f.finish(first); assert.equal(old.response.status, 400); await old.response.text();
    const g = await fixture({ maxSessions: 1 }); const a = await g.login(); const second = await g.login(); assert.equal(second.response.status, 429); await second.response.text();
    const replaced = await g.login(a.cookie); assert.equal(replaced.response.status, 303);
  });
});
