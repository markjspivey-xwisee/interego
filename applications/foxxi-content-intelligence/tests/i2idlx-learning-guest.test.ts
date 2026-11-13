import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, createPublicKey, randomBytes, verify as verifySignature, webcrypto } from 'node:crypto';
import express from 'express';
import { attachLearningRoutes, GUEST_LEARNING_OPERATIONS } from '../src/i2idlx-learning-routes.js';
import { emptyLearningState, type LearningRepository, type LearningSnapshot } from '../src/i2idlx-learning-connections.js';
import type { GuestGrantRequest, GuestGrantSigner } from '../src/i2idlx-learning-auth.js';
import { PlayGrantService, learnerGuestGrantConfig, type PlayFetch } from '../src/play-grant.js';
// The browser module, run here with Node's WebCrypto and an in-memory key store.
type GuestModule = {
  guestLearningSignIn(config: unknown, options?: Record<string, unknown>): Promise<{ guest: boolean; resumed: boolean }>;
  guestFreshCredential(config: unknown, options?: Record<string, unknown>): Promise<{ token: string }>;
  guestKeyThumbprint(jwk: { kty: string; crv: string; x: string; y: string }, subtle?: unknown): Promise<string>;
  learningGuestSignIn(value: unknown, origin: string): unknown;
};
const guestModuleUrl = new URL('../i2idlx/app/src/learning-guest.js', import.meta.url).href;
const { guestFreshCredential, guestLearningSignIn, guestKeyThumbprint, learningGuestSignIn } = await import(/* @vite-ignore */ guestModuleUrl) as GuestModule;

type Row = Record<string, unknown>;
const BASE = 'https://workbench.example', RELAY = 'https://relay.example', IDENTITY = 'https://identity.example', POD = 'https://pods.example';
const PREFIX = '/i2idlx/learning', API = '/i2idlx/api/learning';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const json = (value: unknown, status = 200) => Response.json(value, { status });
type Jwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };
const proves = (key: Jwk, text: string, proof: unknown) => typeof proof === 'string' && /^[A-Za-z0-9_-]{86}$/.test(proof)
  && verifySignature('sha256', Buffer.from(text, 'utf8'), { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(proof, 'base64url'));
const thumb = (key: Jwk) => createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('base64url');

/** A stand-in identity service that checks real P-256 proofs the way the provisional provider does. */
async function fixture(options: { guests?: boolean; termsVersion?: string; signer?: GuestGrantSigner; foreignParser?: boolean } = {}) {
  let now = 1_800_000_000_000;
  const control = { grantPatch: {} as Row, live: true, verifyCalls: 0, bootstrapCalls: 0, grants: [] as GuestGrantRequest[], claimPatch: {} as Row, audience: BASE, guestTtlMs: 86_400_000 };
  const attestations = new Map<string, Row & { publicKeyJwk: Jwk }>();
  let snapshot: LearningSnapshot = { revision: null, state: emptyLearningState() }, serial = 0;
  const repository: LearningRepository = {
    async read() { return structuredClone(snapshot); },
    async write(expected, state) { assert.equal(expected, snapshot.revision); snapshot = { revision: String(++serial), state: structuredClone(state) }; },
  };
  const identity = async (path: string, body: Row): Promise<Response> => {
    if (path === '/play/provisional') {
      control.bootstrapCalls++;
      const grant = body.playGrant as { _signed_payload: string; _signature: string }, key = body.publicKeyJwk as Jwk;
      const payload = JSON.parse(grant._signed_payload) as GuestGrantRequest & { purpose: string; expiresAt: number };
      if (payload.audience !== control.audience || payload.publicKeyThumbprint !== thumb(key)) return json({ valid: false, error: 'invalid_play_grant' }, 401);
      if (options.termsVersion && body.termsVersion !== options.termsVersion) return json({ valid: false, error: 'hosted_terms_required',
        terms: { version: options.termsVersion, url: IDENTITY + '/terms', privacyUrl: IDENTITY + '/privacy' } }, 428);
      const text = `interego-play-provisional-v1\n${grant._signed_payload}\n${grant._signature}` + (options.termsVersion ? `\nHosted-Interego-Terms: ${options.termsVersion}` : '');
      if (!proves(key, text, body.proof)) return json({ valid: false, error: 'invalid_browser_proof' }, 401);
      const userId = 'u-try-play-' + createHash('sha256').update(`${payload.audience}\n${thumb(key)}`).digest('hex').slice(0, 32);
      const claims = { version: 1, issuer: IDENTITY, audience: payload.audience, userId, ownerDid: `did:web:identity.example:users:${userId}`,
        webId: `${IDENTITY}/users/${userId}/profile#me`, podUrl: `${POD}/${userId}/`, authenticatedAgentId: `play-${userId}`,
        authenticatedAgentDid: `did:web:identity.example:agents:play-${userId}`, publicKeyJwk: key, proofKeyThumbprint: thumb(key),
        capabilities: ['human-play', 'own-pod-checkpoint'], provisional: true, expiresAt: new Date(now + control.guestTtlMs).toISOString() };
      const attestation = `ipa1_${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
      attestations.set(attestation, claims);
      return json({ token: 'cg2_NEVER-KEPT-identity-token', attestation, provisional: true, guestExpiresAt: claims.expiresAt, userId });
    }
    assert.equal(path, '/play/provisional/verify'); control.verifyCalls++;
    const claims = attestations.get(String(body.attestation));
    if (!claims || body.audience !== claims.audience
      || !proves(claims.publicKeyJwk, `interego-play-proof-v1\n${String(body.attestation)}\n${String(body.audience)}\n${String(body.challenge)}`, body.proof)) return json({ valid: false, error: 'invalid_browser_proof' }, 401);
    if (!control.live || Date.parse(String(claims.expiresAt)) <= now) return json({ valid: false, error: 'provisional_owner_unavailable' }, 401);
    return json({ ...claims, valid: true, ...control.claimPatch });
  };
  const transport: typeof fetch = async (input, init = {}) => {
    const u = new URL(String(input)); assert.equal(u.origin, IDENTITY, 'a guest session never calls the relay or a provider');
    return identity(u.pathname, JSON.parse(String(init.body)) as Row);
  };
  const app = express(); app.set('trust proxy', false);
  // `foreignParser`: what the live bridge puts in front of these routes. A global JSON parser that consumes the
  // request and sets req.body WITHOUT body-parser 1's `_body` mark (it is another Express major's), and the
  // bridge's decoration of every JSON body with `__client_ip` and, given a bearer, `__caller_token`.
  if (options.foreignParser) app.use((req, _res, next) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); req.body = text ? JSON.parse(text) as unknown : {};
      (req.body as Row).__client_ip = '203.0.113.7'; if (req.get('Authorization')) (req.body as Row).__caller_token = 'some-agent-bearer'; next(); });
  });
  else app.use(express.json());
  attachLearningRoutes(app, { baseUrl: BASE, relayOrigin: RELAY, identityOrigin: IDENTITY, podOrigin: POD, repository, fetch: transport, now: () => now,
    sessions: {} as never, taskConfig: { baseUrl: BASE, appDataFile: '', checkOperations: {} } as never,
    ...(options.guests === false ? {} : { guestGrant: options.signer ?? (async (request: GuestGrantRequest) => {
      control.grants.push(request);
      return { _signed_payload: JSON.stringify({ purpose: 'interego-play-provisional-v1', expiresAt: Math.floor(now / 1000) + 90, ...request, ...control.grantPatch, agent_id: 'did:web:identity.example:agents:foxxi-service', subject_pod_url: POD + '/foxxi/', timestamp: new Date(now).toISOString() }),
        _signature: '0x' + 'ab'.repeat(65) };
    }) }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  /** One browser: a cookie jar, the workbench's Origin, and a key store that survives "reloads". */
  function browser() {
    let cookie = '', record: unknown = null;
    const store = { get: async () => record, put: async (value: unknown) => { record = value; }, clear: async () => { record = null; } };
    const browserFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const u = new URL(String(input));
      if (u.origin === IDENTITY) return identity(u.pathname, JSON.parse(String(init.body)) as Row);
      assert.equal(u.origin, BASE);
      const response = await fetch(local + u.pathname + u.search, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string>), Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) } });
      const set = response.headers.getSetCookie().find(c => c.startsWith('__Host-i2idlx-learning='))?.split(';')[0];
      if (set !== undefined) cookie = set === '__Host-i2idlx-learning=' ? '' : set;
      return response;
    };
    const status = async () => (await (await browserFetch(BASE + PREFIX + '/session')).json()) as Row;
    const signIn = async (extra: Row = {}) => guestLearningSignIn(learningGuestSignIn((await status()).guest_sign_in, BASE), { fetch: browserFetch, subtle: webcrypto.subtle, store, ...extra });
    const call = async (path: string, body: Row) => {
      const csrf = String((await status()).csrf);
      const response = await browserFetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': csrf }, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as Row };
    };
    return { fetch: browserFetch, status, signIn, call, store, stored: () => record as Row | null, cookie: () => cookie, forget: () => { cookie = ''; } };
  }
  return { control, browser, local, advance: (ms: number) => { now += ms; }, state: () => snapshot.state };
}

describe('provisional guest learner sign-in', () => {
  it('offers nothing and refuses every guest route where no grant signer is configured', async () => {
    const f = await fixture({ guests: false }), b = f.browser();
    assert.equal((await b.status()).guest_sign_in, undefined);
    for (const path of ['/guest/grant', '/guest/challenge', '/guest/session']) {
      const response = await b.fetch(BASE + PREFIX + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 503); assert.equal(((await response.json()) as Row).error, 'learning_guest_unavailable');
    }
  });

  it('creates a guest from a browser-held key, keeps no bearer, and resumes it without a new grant', async () => {
    const f = await fixture(), b = f.browser();
    let provision: Row | undefined;
    const first = await b.signIn({ onProvisioned: (value: Row) => { provision = value; } });
    assert.deepEqual({ guest: first.guest, resumed: first.resumed }, { guest: true, resumed: false });
    assert.equal(typeof provision?.token, 'string');
    const stored = b.stored()!; assert.deepEqual(Object.keys(stored).sort(), ['attestation', 'privateKey', 'publicKeyJwk']);
    assert.ok(!JSON.stringify({ ...stored, privateKey: null }).includes(String(provision?.token)));
    assert.equal((stored.privateKey as CryptoKey).extractable, false);
    assert.ok(!JSON.stringify({ ...stored, privateKey: null }).includes('cg2_'), 'the identity token is never stored');
    assert.equal(f.control.grants.length, 1); assert.equal(f.control.grants[0]!.audience, BASE);
    assert.equal(f.control.grants[0]!.publicKeyThumbprint, await guestKeyThumbprint(stored.publicKeyJwk as Jwk, webcrypto.subtle));
    const status = await b.status(); assert.equal(status.authenticated, true); assert.equal(status.guest, true);
    const account = status.account as Row; assert.match(String(account.userId), /^u-try-play-[0-9a-f]{32}$/);
    assert.equal(account.id, `did:web:identity.example:users:${String(account.userId)}`);
    // A reload: same key store, no cookie. The stored attestation and a fresh proof are enough.
    b.forget(); const again = await b.signIn(); assert.equal(again.resumed, true);
    assert.equal(f.control.grants.length, 1); assert.equal(f.control.bootstrapCalls, 1);
    assert.equal(((await b.status()).account as Row).userId, account.userId);
    // The page that held the token is gone. Asking again returns one for the same owner and still does not store it.
    const credential = await guestFreshCredential(learningGuestSignIn((await b.status()).guest_sign_in, BASE), { fetch: b.fetch, subtle: webcrypto.subtle, store: b.store });
    assert.equal(typeof credential.token, 'string');
    assert.equal(f.control.grants.length, 2);
    assert.ok(!JSON.stringify({ ...b.stored()!, privateKey: null }).includes(credential.token));
    assert.equal(((await b.status()).account as Row).userId, account.userId);
  });

  it('asks for the hosted terms and creates no guest without agreement', async () => {
    const f = await fixture({ termsVersion: '2026-11' }), b = f.browser();
    await assert.rejects(b.signIn(), (error: Error & { code?: string }) => error.code === 'learning_guest_terms_required');
    assert.equal((await b.status()).authenticated, false);
    let asked: Row | undefined;
    await b.signIn({ confirmTerms: async (terms: Row) => { asked = terms; return true; } });
    assert.equal(asked?.version, '2026-11'); assert.equal((await b.status()).guest, true);
  });

  it('lets a guest use learner operations and launch, and nothing an owner, a notification or an AI context has', async () => {
    const f = await fixture(), b = f.browser(); await b.signIn();
    const links = await b.call(API, { operation: 'my-links' }); assert.equal(links.status, 200); assert.deepEqual(links.body.links, []);
    for (const operation of GUEST_LEARNING_OPERATIONS) {
      const result = await b.call(API, { operation }); assert.notEqual(result.body.error, 'learning_guest_refused', operation);
    }
    const before = JSON.stringify(f.state());
    for (const operation of ['create-connector', 'owned-connectors', 'owned-courses', 'pending-links', 'approve-link', 'revoke-connector', 'set-review-policy', 'set-notification-policy',
      'set-targeted-launch-policy', 'save-course-map', 'get-course-map', 'delete-course-map', 'preview-course-map', 'prepare-lti', 'install-lti', 'remove-lti',
      'enable-progress-notifications', 'disable-progress-notifications', 'progress-notification-status', 'not-an-operation']) {
      const result = await b.call(API, { operation, connector_id: 'c', link_id: 'l', label: 'x' });
      assert.equal(result.status, 403, operation); assert.equal(result.body.error, 'learning_guest_refused', operation);
    }
    const noOperation = await b.call(API, {}); assert.equal(noOperation.status, 403);
    assert.equal(JSON.stringify(f.state()), before, 'a refused operation writes nothing');
    const launch = await b.call(API + '/launch', { link_id: 'missing', course_id: 'course-a', version: 0 });
    assert.notEqual(launch.body.error, 'learning_guest_refused'); assert.notEqual(launch.status, 401);
    const context = await b.call(API + '/context', { link_id: 'missing' });
    assert.equal(context.status, 403); assert.equal(context.body.error, 'learning_guest_refused');
  });

  it('refuses a forged, replayed, foreign-audience or non-canonical guest', async () => {
    const f = await fixture(), b = f.browser(); await b.signIn();
    const attestation = String(b.stored()!.attestation), key = b.stored()!.privateKey as CryptoKey;
    const post = (path: string, body: Row, headers: Record<string, string> = {}) => fetch(f.local + PREFIX + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers }, body: JSON.stringify(body) });
    const challenge = async () => String(((await (await post('/guest/challenge', {})).json()) as Row).challenge);
    const sign = async (text: string, signer = key) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, Buffer.from(text))).toString('base64url');
    const proofFor = async (c: string, signer = key) => sign(`interego-play-proof-v1\n${attestation}\n${BASE}\n${c}`, signer);
    const code = async (response: Response) => [response.status, ((await response.json()) as Row).error];

    // Cross-site: no Origin, or another one.
    assert.equal((await fetch(f.local + PREFIX + '/guest/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    assert.equal((await post('/guest/challenge', {}, { Origin: 'https://evil.example' })).status, 400);
    // A challenge this server never issued.
    const invented = randomBytes(32).toString('base64url');
    assert.deepEqual(await code(await post('/guest/session', { attestation, challenge: invented, proof: await proofFor(invented) })), [400, 'learning_sign_in_state_invalid']);
    // Another key's signature over a real challenge.
    const other = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const c1 = await challenge();
    assert.deepEqual(await code(await post('/guest/session', { attestation, challenge: c1, proof: await proofFor(c1, other.privateKey) })), [401, 'learning_account_invalid']);
    // The failed attempt consumed c1: the right proof over it is now refused too.
    assert.deepEqual(await code(await post('/guest/session', { attestation, challenge: c1, proof: await proofFor(c1) })), [400, 'learning_sign_in_state_invalid']);
    // A used challenge cannot be replayed with the proof that succeeded.
    const c2 = await challenge(), good = { attestation, challenge: c2, proof: await proofFor(c2) };
    assert.equal((await post('/guest/session', good)).status, 200);
    assert.deepEqual(await code(await post('/guest/session', good)), [400, 'learning_sign_in_state_invalid']);
    // An expired challenge.
    const c3 = await challenge(); f.advance(121_000);
    assert.deepEqual(await code(await post('/guest/session', { attestation, challenge: c3, proof: await proofFor(c3) })), [400, 'learning_sign_in_state_invalid']);
    // Extra fields, and identity answers that are valid for someone or somewhere else.
    const c4 = await challenge();
    assert.equal((await post('/guest/session', { attestation, challenge: c4, proof: await proofFor(c4), userId: 'u-pk-aaaaaaaaaaaa' })).status, 400);
    for (const patch of [{ audience: 'https://play.example' }, { issuer: 'https://other.example' }, { provisional: false }, { userId: 'u-pk-aaaaaaaaaaaa' },
      { podUrl: POD + '/someone-else/' }, { ownerDid: 'did:web:identity.example:users:u-pk-aaaaaaaaaaaa' }, { webId: IDENTITY + '/users/u-pk-aaaaaaaaaaaa/profile#me' },
      { expiresAt: new Date(0).toISOString() }, { valid: 'true' }, { authenticatedAgentDid: 'did:web:evil.example:agents:x' }] as Row[]) {
      f.control.claimPatch = patch; f.advance(61_000); const c = await challenge();
      assert.deepEqual(await code(await post('/guest/session', { attestation, challenge: c, proof: await proofFor(c) })), [401, 'learning_account_invalid'], JSON.stringify(patch));
    }
  });

  it('ends the session when identity no longer vouches for the guest, and at the guest deadline', async () => {
    const f = await fixture(), b = f.browser(); await b.signIn();
    const calls = f.control.verifyCalls;
    assert.equal((await b.status()).authenticated, true); assert.equal(f.control.verifyCalls, calls, 'a check stands for 30 seconds');
    f.control.live = false; f.advance(31_000);
    assert.equal((await b.status()).authenticated, false); assert.ok(f.control.verifyCalls > calls);
    f.control.live = true;
    assert.equal((await b.status()).authenticated, false, 'a dropped session does not come back');

    const short = await fixture(); short.control.guestTtlMs = 600_000; const c = short.browser(); await c.signIn();
    assert.equal(Date.parse(String((await c.status()).expires_at)) - 1_800_000_000_000, 600_000, 'never longer than the guest deadline');
    short.advance(600_001); assert.equal((await c.status()).authenticated, false);
  });

  it('refuses a grant for a malformed key thumbprint and one its signer changed', async () => {
    const f = await fixture(), post = (body: Row) => fetch(f.local + PREFIX + '/guest/grant', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body) });
    assert.equal((await post({ publicKeyThumbprint: 'short' })).status, 400);
    assert.equal((await post({ publicKeyThumbprint: 'A'.repeat(43), audience: 'https://play.example' })).status, 400);
    assert.equal(f.control.grants.length, 0);
    const ok = await post({ publicKeyThumbprint: 'A'.repeat(43) }); assert.equal(ok.status, 200);
    const grant = ((await ok.json()) as { playGrant: { _signed_payload: string } }).playGrant;
    const signed = JSON.parse(grant._signed_payload) as GuestGrantRequest & { purpose: string };
    assert.equal(signed.audience, BASE); assert.equal(signed.purpose, 'interego-play-provisional-v1');
    // What the signer hands back is checked: another purpose, audience or key, or an expiry that is past or long, is not passed on.
    let seconds = 1_800_000_000;
    for (const patch of [() => ({ purpose: 'something-else' }), () => ({ audience: 'https://play.example' }), () => ({ publicKeyThumbprint: 'B'.repeat(43) }), () => ({ challenge: 'C'.repeat(43) }),
      () => ({ expiresAt: seconds - 1 }), () => ({ expiresAt: seconds + 121 }), () => ({ expiresAt: String(seconds + 60) })] as Array<() => Row>) {
      f.advance(61_000); seconds += 61; f.control.grantPatch = patch();
      const refused = await post({ publicKeyThumbprint: 'A'.repeat(43) });
      assert.equal(refused.status, 503, JSON.stringify(f.control.grantPatch)); assert.equal(((await refused.json()) as Row).error, 'learning_guest_unavailable');
    }
    f.control.grantPatch = {}; f.advance(61_000);
    assert.equal((await post({ publicKeyThumbprint: 'A'.repeat(43) })).status, 200);
  });

  it('signs a guest in behind a global body parser that is not this module\'s own', async () => {
    const f = await fixture({ foreignParser: true }), b = f.browser(); await b.signIn();
    assert.equal((await b.status()).guest, true);
    assert.equal((await b.call(API, { operation: 'my-links' })).status, 200);
    // The decorations are the only extra fields let through, and a bearer changes nothing.
    const post = (body: Row, headers: Record<string, string> = {}) => fetch(f.local + PREFIX + '/guest/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({}, { Authorization: 'Bearer anything' })).status, 200);
    assert.equal((await post({ extra: 'x' })).status, 400);
  });

  it('is its own application: its own service key and origin, never the dashboard\'s', () => {
    const KEY = '0x' + '11'.repeat(32), OTHER = '0x' + '22'.repeat(32);
    assert.equal(learnerGuestGrantConfig({}, BASE), null);
    assert.equal(learnerGuestGrantConfig({ FOXXI_PLAY_SERVICE_PRIVATE_KEY: OTHER, FOXXI_PLAY_AUDIENCE: 'https://dashboard.example' }, BASE), null, 'the dashboard\'s settings alone turn nothing on here');
    const config = learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY, FOXXI_PLAY_SERVICE_PRIVATE_KEY: OTHER, FOXXI_PLAY_AUDIENCE: 'https://dashboard.example',
      INTEREGO_IDENTITY_URL: IDENTITY, INTEREGO_RELAY_URL: RELAY }, BASE + '/');
    assert.deepEqual(config, { audience: BASE, identityUrl: IDENTITY, relayUrl: RELAY, servicePrivateKey: KEY });
    assert.throws(() => learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: 'nope' }, BASE), /32-byte hex/);
    assert.throws(() => learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY, FOXXI_PLAY_SERVICE_PRIVATE_KEY: KEY.toUpperCase().replace('0X', '0x') }, BASE), /its own application/);
    assert.throws(() => learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY, FOXXI_PLAY_AUDIENCE: BASE + '/' }, BASE), /one application per origin/);
    assert.throws(() => learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY }, 'http://localhost:6080'), /public HTTPS origin/);
    assert.throws(() => learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY }, BASE + '/i2idlx'), /HTTPS origin/);
  });

  it('signs a guest in through the bridge\'s grant service, for the workbench\'s origin only', async () => {
    const KEY = '0x' + '11'.repeat(32), signedPayloads: Row[] = [];
    // The relay and identity as the grant service sees them: a sign-in, then one signature per grant.
    const serviceFetch: PlayFetch = async (url, init) => {
      const u = new URL(url), body = JSON.parse(init?.body ?? '{}') as Row, answer = (value: Row, status = 200) => ({ ok: status < 300, status, json: async () => value });
      if (u.origin === IDENTITY && u.pathname === '/challenges') return answer({ nonce: 'fixture-nonce-0001' });
      if (u.origin === IDENTITY && u.pathname === '/auth/siwe') { assert.equal(body.existingOnly, true); return answer({ token: 'service-token', userId: 'u-eth-service',
        agentDid: 'did:web:identity.example:agents:learn-service', podUrl: POD + '/u-eth-service/', expiresAt: new Date(1_800_000_000_000 + 3_600_000).toISOString() }); }
      assert.equal(u.origin + u.pathname, RELAY + '/tool/sign_request'); assert.equal(init?.headers?.Authorization, 'Bearer service-token');
      signedPayloads.push(body);
      return answer({ _signed_payload: JSON.stringify({ ...body, agent_id: 'did:web:identity.example:agents:learn-service', subject_pod_url: POD + '/u-eth-service/', timestamp: new Date(1_800_000_000_000).toISOString() }),
        _signature: '0x' + 'cd'.repeat(65) });
    };
    const service = new PlayGrantService(learnerGuestGrantConfig({ FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY: KEY, INTEREGO_IDENTITY_URL: IDENTITY, INTEREGO_RELAY_URL: RELAY }, BASE)!,
      { fetch: serviceFetch, now: () => 1_800_000_000_000 });
    // Exactly the adapter the bridge wires (bridge/server.ts).
    const f = await fixture({ signer: async request => (await service.grant({ publicKeyThumbprint: request.publicKeyThumbprint, challenge: request.challenge })).playGrant });
    const b = f.browser(); await b.signIn();
    assert.equal((await b.status()).guest, true);
    assert.equal(signedPayloads.length, 1); assert.equal(signedPayloads[0]!.audience, BASE); assert.equal(signedPayloads[0]!.purpose, 'interego-play-provisional-v1');
  });
});
