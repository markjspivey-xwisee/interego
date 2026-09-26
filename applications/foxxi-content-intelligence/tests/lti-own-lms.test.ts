/**
 * Foxxi as its own LMS. The Platform launches the bridge's own Tool over HTTP: the OIDC login,
 * an authorization that spends a one-use grant, and an id_token the Tool verifies against the
 * Platform's published keys. The Tool gets a token by signing a client assertion the Platform
 * verifies against the Tool's keys, and posts scores over AGS: only for a learner the LMS
 * launched, and never older than the score on record.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { LtiPlatform, attachLtiPlatformRoutes, autoPostForm, type ToolRegistration } from '../src/lti-platform.js';
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

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = express();
  app.use(express.json());
  platform = new LtiPlatform({ selfBaseUrl: base });
  tool = attachLti13Routes(app, {
    selfBaseUrl: base, tenantDid: 'did:web:test', keySeed: 'lti-own-lms-test', dashboardUrl: `${base}/dash`, platformsConfig: '',
    extraPlatforms: [platform.registration()],
    onResourceLaunch: async (l) => { launches.push(l); return { ok: true, redirect: `${base}/played` }; },
  });
  attachLtiPlatformRoutes(app, platform);
  const testTool: ToolRegistration = {
    clientId: 'test-tool', deploymentId: 'd-1', loginUrl: `${base}/test-tool/login`,
    redirectUris: [`${base}/test-tool/launch`], targetLinkUri: `${base}/test-tool/launch`, jwksUrl: `${base}/test-tool/jwks.json`,
  };
  second = new LtiPlatform({ selfBaseUrl: `${base}/second`, tool: testTool });
  app.get('/test-tool/jwks.json', (_req, res) => { res.json({ keys: [toolKeys.jwk] }); });
  attachLtiPlatformRoutes(app, second);
  server.on('request', app);
});
afterAll(() => new Promise<void>((r) => { server.close(() => r()); }));

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
    const at = new Date(Date.now() - 60_000).toISOString();
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
    const results = await fetch(`${String(start.lineItem.id)}/results`, { headers: { Authorization: `Bearer ${await tokenFor(AGS_SCOPE.result)}` } });
    expect(results.headers.get('content-type')).toMatch(/application\/vnd\.ims\.lis\.v2\.resultcontainer\+json/);
    expect(await results.json()).toEqual([expect.objectContaining({ userId: 'learner-1', resultScore: 80, resultMaximum: 100, scoreOf: start.lineItem.id })]);
    expect(second.gradebookFor('learner-1')).toEqual([expect.objectContaining({ courseId: course.id, result: expect.objectContaining({ resultScore: 80, gradingProgress: 'FullyGraded' }) })]);
    expect(second.gradebookFor('someone-else')).toEqual([expect.objectContaining({ result: null })]);
    const lineItems = await fetch(second.lineItemsUrl, { headers: { Authorization: `Bearer ${await tokenFor(AGS_SCOPE.result)}` } });
    expect(lineItems.status).toBe(403);
  });

  it('keeps the gradebook across a restart', () => {
    const snap = JSON.parse(JSON.stringify(second.snapshot())) as ReturnType<LtiPlatform['snapshot']>;
    const restarted = new LtiPlatform({ selfBaseUrl: `${base}/second`, tool: second.tool });
    restarted.restore(snap);
    expect(restarted.gradebookFor('learner-1')).toEqual(second.gradebookFor('learner-1'));
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
