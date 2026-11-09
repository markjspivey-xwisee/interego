/**
 * Foxxi as its own LMS. The Platform launches the bridge's own Tool over HTTP: the OIDC login,
 * an authorization that spends a one-use grant, and an id_token the Tool verifies against the
 * Platform's published keys. The Tool gets a token by signing a client assertion the Platform
 * verifies against the Tool's keys, and posts scores over AGS: only for a learner the LMS
 * launched, and never older than the score on record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type JsonWebKey } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { LtiPlatform, attachLtiPlatformRoutes, autoPostForm, type ToolRegistration } from '../src/lti-platform.js';
import { isPlatformSnapshot } from '../src/lti-platform-readiness.js';
import { ScopedLtiConnection } from '../src/lti-scoped-connection.js';
import { AGS_SCOPE, LTI_CLAIMS, attachLti13Routes, es256Keys, jwsSignEs256, type Lti13Tool, type VerifiedResourceLaunch } from '../src/lti13.js';

const decode = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

let server: Server;
let base = '';
/** The bridge's own LMS, launching the bridge's own Tool. */
let platform: LtiPlatform;
let tool: Lti13Tool;
const launches: VerifiedResourceLaunch[] = [];
/** A second LMS whose Tool is this test, so the test holds the key its client assertions are signed with. */
let second: LtiPlatform;
const toolKeys = es256Keys('test-tool', 'lti-own-lms');
const learner = { sub: 'did:ethr:0x00000000000000000000000000000000000abc01', podUrl: 'https://pod.example/eth-000000000000/' };
const course = { id: 'https://bridge.example/course/one', title: 'Course one' };
const scopedToolKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const scopedKid = randomUUID();
const scopedTool = {
  clientId: randomUUID(), deploymentId: randomUUID(),
  loginUrl: 'https://lti-tool.example/login', redirectUri: 'https://lti-tool.example/launch',
  targetLinkUri: 'https://lti-tool.example/course/launch', jwksUrl: 'https://lti-tool.example/jwks',
};
let scoped: ScopedLtiConnection;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  platform = new LtiPlatform({ selfBaseUrl: base });
  const testTool: ToolRegistration = {
    clientId: 'test-tool', deploymentId: 'd-1', loginUrl: `${base}/test-tool/login`,
    redirectUris: [`${base}/test-tool/launch`], targetLinkUri: `${base}/test-tool/launch`, jwksUrl: `${base}/test-tool/jwks.json`,
  };
  second = new LtiPlatform({ selfBaseUrl: `${base}/second`, tool: testTool });
  const temporary = ScopedLtiConnection.fromSetting(JSON.stringify({
    id: randomUUID().replaceAll('-', ''), owner: learner.sub, title: 'Scoped course',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    tool: scopedTool, keys: [{ ...scopedToolKeys.publicKey.export({ format: 'jwk' }), kid: scopedKid }],
  }), base);
  if (!temporary) throw new Error('The test tool lease did not load');
  scoped = temporary;
  const app = createVerticalBridge({
    verticalName: 'lti-own-lms-test', affordances: [], handlers: {},
    routeOwnedJsonPostPaths: [platform.scoreRoutePath, second.scoreRoutePath, scoped.scoreRoutePath],
  });
  tool = attachLti13Routes(app, {
    selfBaseUrl: base, tenantDid: 'did:web:test', keySeed: 'lti-own-lms-test', dashboardUrl: `${base}/dash`, platformsConfig: '',
    extraPlatforms: [platform.registration()],
    onResourceLaunch: async (l) => { launches.push(l); return { ok: true, redirect: `${base}/played` }; },
  });
  attachLtiPlatformRoutes(app, platform);
  app.get('/test-tool/jwks.json', (_req, res) => { res.json({ keys: [toolKeys.jwk] }); });
  attachLtiPlatformRoutes(app, second);
  scoped.attach(app);
  server.on('request', app);
});
afterAll(() => new Promise<void>((r) => { server.close(() => r()); }));

it('binds a temporary external tool to one learner and one line item and revokes all access', async () => {
  const other = 'did:ethr:0x00000000000000000000000000000000000abc02';
  expect(scoped.launch(other, scoped.course.id)).toBeUndefined();
  expect(scoped.launch(learner.sub, course.id)).toBeUndefined();
  const connected = scoped.launch(learner.sub, scoped.course.id);
  if (!connected?.start.ok) throw new Error('The scoped launch did not start');
  const { platform: issuer, start } = connected;
  const init = new URL(start.initiationUrl).searchParams;
  const query = new URLSearchParams({
    scope: 'openid', response_type: 'id_token', response_mode: 'form_post',
    client_id: scopedTool.clientId, redirect_uri: scopedTool.redirectUri, nonce: randomUUID(),
    login_hint: init.get('login_hint')!, lti_message_hint: init.get('lti_message_hint')!,
  });
  const auth = await fetch(`${issuer}/auth?${query}`, { headers: { Accept: 'application/json' } });
  expect(auth.status).toBe(200);
  const { form_post: handoff } = await auth.json() as { form_post: { action: string; fields: { id_token: string } } };
  const claims = decode(handoff.fields.id_token);
  expect(handoff.action).toBe(scopedTool.redirectUri);
  expect(claims.sub).toEqual(expect.any(String));
  expect(claims.sub).not.toBe(learner.sub);
  expect(claims[LTI_CLAIMS.custom]).toBeUndefined();
  expect(claims[LTI_CLAIMS.ags]).toEqual({ scope: [AGS_SCOPE.score], lineitem: start.lineItem.id });
  const jwks = await fetch(`${issuer}/jwks.json`).then((response) => response.json()) as { keys: JsonWebKey[] };
  const [header, payload, signature] = handoff.fields.id_token.split('.');
  expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwks.keys[0]!, format: 'jwk' }), Buffer.from(signature!, 'base64url'))).toBe(true);

  const tokenEndpoint = `${issuer}/token`;
  const iat = Math.floor(Date.now() / 1000);
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', kid: scopedKid })}.${encode({
    iss: scopedTool.clientId, sub: scopedTool.clientId, aud: tokenEndpoint, iat, exp: iat + 120, jti: randomUUID(),
  })}`;
  const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), scopedToolKeys.privateKey).toString('base64url')}`;
  const tokenResponse = await fetch(tokenEndpoint, form({
    grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion, scope: `${AGS_SCOPE.score} ${AGS_SCOPE.result}`,
  }));
  expect(tokenResponse.status).toBe(200);
  const token = await tokenResponse.json() as { access_token: string; scope: string };
  expect(token.scope).toBe(AGS_SCOPE.score);

  const item = String(start.lineItem.id);
  const finalized = { userId: claims.sub, scoreGiven: 100, scoreMaximum: 100,
    activityProgress: 'Submitted', gradingProgress: 'FullyGraded', timestamp: new Date(Date.now() - 1000).toISOString() };
  const postScore = (url: string, userId: unknown, media = 'application/vnd.ims.lis.v1.score+json', score = finalized) => fetch(`${url}/scores`, {
    method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': media },
    body: JSON.stringify({ ...score, userId }),
  });
  expect((await postScore(item, other)).status).toBe(400);
  expect((await postScore(`${issuer}/contexts/foxxi-open/lineitems/missing`, claims.sub)).status).toBe(404);
  expect((await postScore(platform.lineItemUrl('an-open-item'), claims.sub)).status).toBe(401);
  expect((await postScore(item, claims.sub)).status).toBe(204);
  const retake = { ...finalized, scoreGiven: 0, activityProgress: 'Initialized',
    gradingProgress: 'NotReady', timestamp: new Date().toISOString() };
  expect((await postScore(item, claims.sub, 'application/json', retake)).status).toBe(204);
  expect((await fetch(`${item}/results`, { headers: { Authorization: `Bearer ${token.access_token}` } })).status).toBe(403);
  expect(scoped.gradesFor(learner.sub)).toEqual([expect.objectContaining({
    courseId: scoped.course.id,
    result: expect.objectContaining({ resultScore: 100, gradingProgress: 'FullyGraded', timestamp: finalized.timestamp }),
    retake: expect.objectContaining({ resultScore: 0, gradingProgress: 'NotReady', timestamp: retake.timestamp }),
  })]);
  expect(scoped.gradesFor(other)).toEqual([]);
  expect(platform.gradebookFor(learner.sub).some((row) => row.courseId === scoped.course.id)).toBe(false);
  expect(scoped.revoke(other, scoped.course.id)).toBe(false);
  expect(scoped.revoke(learner.sub, scoped.course.id)).toBe(true);
  expect(scoped.gradesFor(learner.sub)).toEqual([]);
  expect((await postScore(item, claims.sub)).status).toBe(404);
});

/** Follow a launch the way a client without a browser does: the Tool's login, then the Platform's authorization as JSON. */
async function authorizeThroughTool(initiationUrl: string): Promise<{ authUrl: URL; action: string; fields: Record<string, string> }> {
  const login = await fetch(initiationUrl, { redirect: 'manual' });
  expect(login.status).toBe(302);
  const authUrl = new URL(login.headers.get('location') ?? '');
  const auth = await fetch(authUrl, { headers: { Accept: 'application/json' } });
  expect(auth.status).toBe(200);
  const { form_post } = await auth.json() as { form_post: { action: string; fields: Record<string, string> } };
  return { authUrl, action: form_post.action, fields: form_post.fields };
}

describe('a launch from Foxxi\'s own LMS reaches its Tool over HTTP', () => {
  it('runs the login, the authorization and an id_token the Tool verifies, and hands the Tool the learner and the course', async () => {
    const start = platform.beginLaunch(learner, course);
    if (!start.ok) throw new Error(start.error);
    const init = new URL(start.initiationUrl);
    expect(`${init.origin}${init.pathname}`).toBe(`${base}/lti/login`);
    expect(init.searchParams.get('iss')).toBe(platform.issuer);
    expect(init.searchParams.get('login_hint')).not.toContain('abc01');
    const { authUrl, action, fields } = await authorizeThroughTool(start.initiationUrl);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(platform.authorizationUrl);
    expect(action).toBe(`${base}/lti/launch`);
    const claims = decode(fields.id_token ?? '');
    expect(claims).toMatchObject({
      iss: platform.issuer, aud: 'foxxi-tool', sub: learner.sub,
      [LTI_CLAIMS.messageType]: 'LtiResourceLinkRequest', [LTI_CLAIMS.version]: '1.3.0',
      [LTI_CLAIMS.custom]: { foxxi_course_id: course.id, foxxi_learner_pod: learner.podUrl },
      [LTI_CLAIMS.ags]: { lineitem: start.lineItem.id },
    });
    const launched = await fetch(action, form(fields));
    expect(launched.status).toBe(302);
    expect(launched.headers.get('location')).toBe(`${base}/played`);
    expect(launches.at(-1)).toMatchObject({ issuer: platform.issuer, clientId: 'foxxi-tool', sub: learner.sub, custom: { foxxi_course_id: course.id }, ags: { lineitem: start.lineItem.id } });
    expect(launches.at(-1)?.ags?.scope).toContain(AGS_SCOPE.score);
  });

  it('spends the grant on first use, so a replayed authorization is refused', async () => {
    const start = platform.beginLaunch(learner, course);
    if (!start.ok) throw new Error(start.error);
    const { authUrl } = await authorizeThroughTool(start.initiationUrl);
    const again = await fetch(authUrl, { headers: { Accept: 'application/json' } });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: 'login_required' });
  });

  it('advertises and signs an RS256 launch when configured with an RSA key', () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const rsa = new LtiPlatform({ selfBaseUrl: `${base}/rsa`, tool: second.tool, privateKeyPem: pem });
    const launch = rsa.beginLaunch(learner, course);
    if (!launch.ok) throw new Error(launch.error);
    const hint = new URL(launch.initiationUrl).searchParams;
    const reply = rsa.authorize({ scope: 'openid', response_type: 'id_token', client_id: second.tool.clientId,
      redirect_uri: second.tool.redirectUris[0], nonce: 'rsa-launch', login_hint: hint.get('login_hint'), lti_message_hint: hint.get('lti_message_hint') });
    if (!reply.ok) throw new Error(reply.error);
    const token = reply.fields.id_token!;
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const jwk = rsa.jwks().keys[0]!;
    expect(rsa.configuration().id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(jwk).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS256' });
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toMatchObject({ alg: 'RS256', kid: jwk.kid });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))).toBe(true);
    expect(decode(token)).toMatchObject({ iss: rsa.issuer, sub: learner.sub, aud: second.tool.clientId });
  });

  it('refuses an id_token altered on the way to the Tool', async () => {
    const start = platform.beginLaunch(learner, course);
    if (!start.ok) throw new Error(start.error);
    const { action, fields } = await authorizeThroughTool(start.initiationUrl);
    const [h, , sig] = (fields.id_token ?? '').split('.');
    const forged = Buffer.from(JSON.stringify({ ...decode(fields.id_token ?? ''), sub: 'did:ethr:0x0000000000000000000000000000000000000bad' })).toString('base64url');
    const launched = await fetch(action, form({ ...fields, id_token: `${h}.${forged}.${sig}` }));
    expect(launched.status).toBe(401);
  });

  it('never answers for a redirect_uri the Tool did not register, a login_hint that is not the learner\'s, or a lapsed grant', () => {
    const start = platform.beginLaunch(learner, course);
    if (!start.ok) throw new Error(start.error);
    const q = Object.fromEntries(new URL(start.initiationUrl).searchParams);
    const ask = { scope: 'openid', response_type: 'id_token', response_mode: 'form_post', client_id: 'foxxi-tool', redirect_uri: `${base}/lti/launch`, nonce: 'n-1', state: 's-1', login_hint: q.login_hint, lti_message_hint: q.lti_message_hint };
    expect(platform.authorize({ ...ask, redirect_uri: 'https://elsewhere.example/launch' })).toMatchObject({ ok: false, status: 400 });
    expect(platform.authorize({ ...ask, client_id: 'someone-else' })).toMatchObject({ ok: false, status: 401 });
    expect(platform.authorize({ ...ask, nonce: '' })).toMatchObject({ ok: false, status: 400 });
    expect(platform.authorize({ ...ask, login_hint: 'not-the-learner' })).toMatchObject({ ok: false, status: 401 });
    // That attempt spent the grant; a fresh one lapses after five minutes.
    const late = platform.beginLaunch(learner, course);
    if (!late.ok) throw new Error(late.error);
    const lq = Object.fromEntries(new URL(late.initiationUrl).searchParams);
    expect(platform.authorize({ ...ask, login_hint: lq.login_hint, lti_message_hint: lq.lti_message_hint }, Date.now() + 6 * 60_000)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a learner identifier LTI cannot carry', () => {
    expect(platform.beginLaunch({ sub: 'x'.repeat(256), podUrl: learner.podUrl }, course)).toMatchObject({ ok: false, status: 400 });
    expect(platform.beginLaunch({ sub: 'has space', podUrl: learner.podUrl }, course)).toMatchObject({ ok: false, status: 400 });
  });

  it('sends a grade only over https, and only to a platform it knows', async () => {
    const score = { userId: learner.sub, scoreGiven: 80, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() };
    expect(await tool.postScore({ issuer: 'https://unknown.example', clientId: 'foxxi-tool', lineItemUrl: 'https://unknown.example/li', score })).toMatchObject({ ok: false, status: 400 });
    const r = await tool.postScore({ issuer: platform.issuer, clientId: 'foxxi-tool', lineItemUrl: platform.lineItemUrl('li-x'), score });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/https/);
  });
});

describe('the Tool\'s token and the gradebook it posts to', () => {
  const assertion = (over: Record<string, unknown> = {}, keys = toolKeys): string => {
    const now = Math.floor(Date.now() / 1000);
    return jwsSignEs256({}, { iss: 'test-tool', sub: 'test-tool', aud: second.tokenUrl, iat: now, exp: now + 300, jti: randomUUID(), ...over }, keys);
  };
  const tokenRequest = (clientAssertion: string, scope: string): Promise<Response> => fetch(second.tokenUrl, form({
    grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: clientAssertion, scope,
  }));
  const tokenFor = async (scope: string): Promise<string> => {
    const r = await tokenRequest(assertion(), scope);
    expect(r.status).toBe(200);
    return (await r.json() as { access_token: string }).access_token;
  };

  it('issues a token for an assertion signed with the Tool\'s key, for the scopes it grants', async () => {
    const r = await tokenRequest(assertion(), `${AGS_SCOPE.score} https://example.com/not-a-scope`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ token_type: 'Bearer', scope: AGS_SCOPE.score, expires_in: 3600 });
  });

  it('refuses an assertion signed with another key, meant for another endpoint, expired, used twice, or asking for nothing it grants', async () => {
    expect((await tokenRequest(assertion({}, es256Keys('intruder', 'x')), AGS_SCOPE.score)).status).toBe(401);
    expect((await tokenRequest(assertion({ aud: `${base}/elsewhere/token` }), AGS_SCOPE.score)).status).toBe(401);
    expect((await tokenRequest(assertion({ iss: 'someone-else' }), AGS_SCOPE.score)).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    expect((await tokenRequest(assertion({ iat: now - 900, exp: now - 600 }), AGS_SCOPE.score)).status).toBe(401);
    const once = assertion();
    expect((await tokenRequest(once, AGS_SCOPE.score)).status).toBe(200);
    expect((await tokenRequest(once, AGS_SCOPE.score)).status).toBe(401);
    const none = await tokenRequest(assertion(), 'https://example.com/not-a-scope');
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('refuses an assertion that lives longer than ten minutes, and never evicts a live one to take another', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await tokenRequest(assertion({ exp: now + 3600 }), AGS_SCOPE.score)).status).toBe(401);
    // A small cache, and a verifier that trusts any payload, so the cache is what is under test.
    const small = new LtiPlatform({ selfBaseUrl: `${base}/small`, tool: second.tool, maxLiveAssertions: 2,
      verifyJwt: async (jwt) => ({ ok: true, payload: JSON.parse(Buffer.from(jwt, 'base64url').toString('utf8')) as Record<string, unknown> }) });
    const form = (jti: string, exp: number) => ({
      grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', scope: AGS_SCOPE.score,
      client_assertion: Buffer.from(JSON.stringify({ iss: 'test-tool', sub: 'test-tool', aud: small.tokenUrl, iat: now, exp, jti })).toString('base64url'),
    });
    const t0 = now * 1000;
    expect(await small.token(form('j1', now + 300), t0)).toMatchObject({ ok: true });
    expect(await small.token(form('j2', now + 600), t0)).toMatchObject({ ok: true });
    expect(await small.token(form('j3', now + 300), t0)).toMatchObject({ ok: false, status: 503 });
    // The first two are still live, and still refused a second time: nothing was evicted.
    expect(await small.token(form('j1', now + 300), t0)).toMatchObject({ ok: false, status: 401 });
    // Once j1 has expired its slot frees, and a new assertion is taken.
    expect(await small.token(form('j4', now + 900), t0 + 301_000)).toMatchObject({ ok: true });
  });

  it('takes a score only with the score scope, only for a learner it launched, and never an older one', async () => {
    const start = second.beginLaunch({ sub: 'learner-1', podUrl: 'https://pod.example/learner-1/' }, course);
    if (!start.ok) throw new Error(start.error);
    const scoresUrl = `${String(start.lineItem.id)}/scores`;
    const post = (token: string | null, body: Record<string, unknown>): Promise<Response> => fetch(scoresUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.ims.lis.v1.score+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const startTime = Date.now() - 60_000;
    const at = new Date(startTime).toISOString();
    const score = { userId: 'learner-1', scoreGiven: 8, scoreMaximum: 10, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: at, comment: 'Passed' };
    const unsigned = await post(null, score);
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get('www-authenticate')).toBe('Bearer');
    expect((await post(await tokenFor(AGS_SCOPE.result), score)).status).toBe(403);
    const scoring = await tokenFor(AGS_SCOPE.score);
    expect((await post(scoring, { ...score, userId: 'never-launched' })).status).toBe(400);
    expect((await post(scoring, { ...score, activityProgress: 'Finished' })).status).toBe(400);
    expect((await post(scoring, score)).status).toBe(204);
    expect((await post(scoring, { ...score, scoreGiven: 2, timestamp: new Date(Date.now() - 120_000).toISOString() })).status).toBe(409);
    const retake = { ...score, scoreGiven: 0, gradingProgress: 'NotReady', activityProgress: 'Initialized',
      timestamp: new Date(startTime + 2000).toISOString(), comment: 'Retake' };
    expect((await post(scoring, retake)).status).toBe(204);
    expect((await post(scoring, { ...score, timestamp: new Date(startTime + 1000).toISOString() })).status).toBe(409);
    const results = await fetch(`${String(start.lineItem.id)}/results`, { headers: { Authorization: `Bearer ${await tokenFor(AGS_SCOPE.result)}` } });
    expect(results.headers.get('content-type')).toMatch(/application\/vnd\.ims\.lis\.v2\.resultcontainer\+json/);
    expect(await results.json()).toEqual([{ id: expect.any(String), userId: 'learner-1', resultScore: 80,
      resultMaximum: 100, scoreOf: start.lineItem.id, comment: 'Passed' }]);
    expect(second.gradebookFor('learner-1')).toEqual([expect.objectContaining({ courseId: course.id,
      result: expect.objectContaining({ resultScore: 80, gradingProgress: 'FullyGraded', timestamp: at }),
      retake: expect.objectContaining({ resultScore: 0, gradingProgress: 'NotReady', timestamp: retake.timestamp }),
    })]);
    expect(second.gradebookFor('someone-else')).toEqual([expect.objectContaining({ result: null })]);
    const lineItems = await fetch(second.lineItemsUrl, { headers: { Authorization: `Bearer ${await tokenFor(AGS_SCOPE.result)}` } });
    expect(lineItems.status).toBe(403);
  });

  it('keeps the final and retake across a restart and validates the stored learner binding', () => {
    const snap: unknown = JSON.parse(JSON.stringify(second.snapshot()));
    if (!isPlatformSnapshot(snap)) throw new Error('The gradebook snapshot is invalid');
    const restarted = new LtiPlatform({ selfBaseUrl: `${base}/second`, tool: second.tool });
    restarted.restore(snap);
    expect(restarted.gradebookFor('learner-1')).toEqual(second.gradebookFor('learner-1'));
    const [id, [row]] = snap.results[0]!;
    if (!row?.lastFinalized) throw new Error('The snapshot lost the final grade');
    const wrongLearner = { ...row, lastFinalized: { ...row.lastFinalized, userId: 'another-learner' } };
    expect(isPlatformSnapshot({ ...snap, results: [[id, [wrongLearner]]] })).toBe(false);
  });

  it('accepts plain JSON through the shared bridge and preserves the score parser limit', async () => {
    const start = second.beginLaunch({ sub: 'learner-json', podUrl: 'https://pod.example/learner-json/' }, course);
    if (!start.ok) throw new Error(start.error);
    const url = `${String(start.lineItem.id)}/SCORES/?source=test`;
    const score = { userId: 'learner-json', scoreGiven: 7, scoreMaximum: 10, activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: new Date().toISOString() };
    const body = JSON.stringify(score);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(401);

    const scoring = await tokenFor(AGS_SCOPE.score);
    const authorized = { ...headers, Authorization: `Bearer ${scoring}` };
    expect((await fetch(url, { method: 'POST', headers: authorized, body })).status).toBe(204);
    const malformed = await fetch(url, { method: 'POST', headers: authorized, body: '{' });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');

    // An otherwise valid, newer score must be refused even when the HTTP wire length is small or absent.
    const largeBody = JSON.stringify({ ...score, scoreGiven: 2, timestamp: new Date(Date.now() + 1000).toISOString() }) + ' '.repeat(64 * 1024);
    const compressed = new Uint8Array(gzipSync(largeBody));
    expect((await fetch(url, { method: 'POST', headers: { ...authorized, 'Content-Encoding': 'gzip' }, body: compressed })).status).toBe(413);
    const chunkedBody = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(largeBody));
      controller.close();
    } });
    const chunkedRequest = { method: 'POST', headers: authorized, body: chunkedBody, duplex: 'half' as const };
    expect((await fetch(url, chunkedRequest)).status).toBe(413);

    const results = await fetch(`${String(start.lineItem.id)}/results?user_id=learner-json`, {
      headers: { Authorization: `Bearer ${await tokenFor(AGS_SCOPE.result)}` },
    });
    expect(results.status).toBe(200);
    expect(await results.json()).toEqual([expect.objectContaining({ userId: 'learner-json', resultScore: 70, resultMaximum: 100 })]);
  });

  it('publishes its configuration and keys, and posts the id_token with nothing unescaped', async () => {
    const config = await (await fetch(`${platform.issuer}/.well-known/openid-configuration`)).json() as Record<string, unknown>;
    expect(config).toMatchObject({ issuer: platform.issuer, authorization_endpoint: platform.authorizationUrl, token_endpoint: platform.tokenUrl, jwks_uri: platform.jwksUrl });
    const jwks = await (await fetch(platform.jwksUrl)).json() as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const page = autoPostForm('https://tool.example/launch?a=1&b="2"', { id_token: '"><script>alert(1)</script>', state: 's' });
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('action="https://tool.example/launch?a=1&amp;b=&quot;2&quot;"');
  });
});

it('updates the separate retake until a new final and still honors omitted and null scores', () => {
  const gradebook = new LtiPlatform({ selfBaseUrl: 'https://bridge.example' });
  const start = gradebook.beginLaunch(learner, course);
  if (!start.ok) throw new Error(start.error);
  const item = String(start.lineItem.id).split('/').at(-1)!;
  const now = Date.now();
  const score = (scoreGiven: number | null | undefined, gradingProgress: string, sequence: number) =>
    expect(gradebook.acceptScore(gradebook.context.id, item, {
      userId: learner.sub, scoreGiven, scoreMaximum: 100, activityProgress: 'Submitted',
      gradingProgress, timestamp: new Date(now + sequence).toISOString(),
    }, now)).toEqual({ ok: true });
  const row = () => gradebook.gradebookFor(learner.sub)[0]!;

  score(100, 'FullyGraded', 0);
  const final = row().result;
  score(25, 'Pending', 1);
  expect(row().result?.resultScore).toBe(25);
  score(0, 'NotReady', 2);
  expect(row()).toMatchObject({ result: final, retake: { resultScore: 0 } });
  score(100, 'NotReady', 3);
  expect(row()).toMatchObject({ result: final, retake: { resultScore: 100, gradingProgress: 'NotReady' } });
  score(75, 'FullyGraded', 4);
  expect(row().result).toMatchObject({ resultScore: 75, gradingProgress: 'FullyGraded' });
  expect(row()).not.toHaveProperty('retake');
  for (const [index, cleared] of [undefined, null].entries()) {
    score(75, 'FullyGraded', 5 + 3 * index);
    score(cleared, 'NotReady', 6 + 3 * index);
    expect(row().result).not.toHaveProperty('resultScore');
    expect(row()).not.toHaveProperty('retake');
    score(0, 'NotReady', 7 + 3 * index);
    expect(row().result).toMatchObject({ resultScore: 0, gradingProgress: 'NotReady' });
    expect(row()).not.toHaveProperty('retake');
  }
});
