import { afterEach, describe, expect, it } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import express from 'express';
import { LearningLtiManager, type LearningLtiDto } from '../src/i2idlx-learning-lti.js';
import { LearningConnectionsStore, emptyLearningState, type LearningSnapshot, type LearningState } from '../src/i2idlx-learning-connections.js';
import type { LearningPrincipal } from '../src/i2idlx-learning-auth.js';
import { LearningAuthError } from '../src/i2idlx-learning-auth.js';
import { LTI_CLAIMS } from '../src/lti13.js';

type Row = Record<string, unknown>;
const BASE = 'https://workbench.example', ROOT = '/i2idlx/learning/lti', NOW = Date.parse('2026-11-08T12:00:00Z');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const work of cleanups.splice(0).reverse()) await work(); });
const record = (v: unknown) => v as Row;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const cookiePair = (r: Response, name: string) => r.headers.getSetCookie().find(v => v.startsWith(name + '='))?.split(';')[0] ?? '';
function principal(name: string): LearningPrincipal {
  return { subject: 'did:web:identity.example:users:' + name, userId: name, webId: `https://identity.example/users/${name}/profile#me`,
    podUrl: `https://pods.example/${name}/`, sessionId: 'session-' + name, expiresAt: NOW + 3_600_000, signal: new AbortController().signal };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture(options: { publicRequestsPerMinute?: number } = {}) {
  let now = NOW, writes = 0, reads = 0, value: LearningSnapshot = { revision: null, state: emptyLearningState() };
  const owner = principal('owner'), student = principal('student'), other = principal('other');
  const controls = { loseCreate: false, loseImport: false, importRunning: false, deleteFails: false, failJwt: false, revoked: false, badPlatform: false,
    loseSettings: false, ignoreSettings: false, settingsReady: false,
    holdSettingsWrite: null as null | ReturnType<typeof deferred>, settingsWriteStarted: null as null | ReturnType<typeof deferred> };
  const settings = new Map<string, Row>();
  const calls: Array<{ method: string; path: string; body?: Row }> = [], connectors = new Map<string, Row>(), helpers = new Map<string, Row>(), jobs = new Map<string, string>();
  const repository = { async read() { reads++; return copy(value); }, async write(expected: string | null, state: LearningState) {
    if (expected !== value.revision) throw Object.assign(Error('conflict'), { status: 409 }); value = { revision: 'revision-' + (++writes), state: copy(state) };
  } };
  const platform = { issuer: 'https://cloud.scorm.com', toolClientId: 'fixture-client', deploymentId: 'fixture-deployment',
    jwksEndpoint: 'https://cloud.scorm.com/api/v2/plugin/lti13/fixture-connector/jwks?externalConfig=opaque-routing',
    oidcAuthorizationUrl: 'https://cloud.scorm.com/ScormEngineInterface/defaultui/player/authorizations.html?externalConfig=opaque-routing&STATE=stale',
    accessTokenUrl: 'https://cloud.scorm.com/api/v2/plugin/lti13/fixture-connector/token?externalConfig=opaque-routing' };
  const cloud: typeof fetch = async (input, init = {}) => {
    const u = new URL(String(input)); expect(u.origin).toBe('https://cloud.scorm.com'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('Authorization')).toBe('Basic ' + Buffer.from('test-app:test-secret').toString('base64'));
    const path = u.pathname.slice('/api/v2'.length), method = init.method ?? 'GET', body = typeof init.body === 'string' ? record(JSON.parse(init.body)) : undefined;
    calls.push({ method, path: path + u.search, ...(body ? { body } : {}) });
    if (path === '/courses' && method === 'GET') return json({ courses: [] });
    if (path === '/contentConnectors' && method === 'POST') {
      connectors.set('fixture-connector', { connectorId: 'fixture-connector', enabled: true, contentConnectorType: 'ContentConnector.Lti13', configuration: body!.configuration,
        additionalInstanceInformation: controls.badPlatform ? { ...platform, jwksEndpoint: 'https://attacker.example/keys' } : platform });
      if (controls.loseCreate) { controls.loseCreate = false; throw Error('lost response'); } return json({ result: 'fixture-connector' });
    }
    if (path === '/contentConnectors' && method === 'GET') return json({ connectorEntries: [...connectors.values(), { connectorId: 'unrelated', contentConnectorType: 'ContentConnector.Lti13', configuration: {} }] });
    if (path === '/courses/importJobs/noUpload' && method === 'POST') {
      const id = u.searchParams.get('courseId')!; expect(id).toMatch(/^i2idlx-learning-[a-f0-9]{32}$/); expect(u.searchParams.get('mayCreateNewVersion')).toBe('false');
      const metadata = record(record(body!.connectorReferenceRequest).metadataForConnector);
      helpers.set(id, { id, title: metadata.title, learningStandard: 'EXTERNAL' }); jobs.set('fixture-job', id);
      if (controls.loseImport) { controls.loseImport = false; throw Error('lost response'); } return json({ result: 'fixture-job' });
    }
    if (path.startsWith('/courses/importJobs/') && method === 'GET') {
      const job = path.slice('/courses/importJobs/'.length), id = jobs.get(job);
      return id ? json({ jobId: job, status: controls.importRunning ? 'RUNNING' : 'COMPLETE', importResult: { course: { id } } }) : json({}, 404);
    }
    if (path.startsWith('/courses/')) {
      if (path.endsWith('/configuration')) {
        const id = decodeURIComponent(path.slice('/courses/'.length, -'/configuration'.length));
        expect(id).toMatch(/^i2idlx-learning-[a-f0-9]{32}$/); if (!helpers.has(id)) return json({}, 404);
        if (method === 'GET') return json(settings.get(id) ?? { settingItems: [
          { id: 'PlayerLaunchType', effectiveValue: 'FRAMESET' }, { id: 'PlayerScoLaunchType', effectiveValue: controls.settingsReady ? 'FRAMESET' : 'NEW_WINDOW' },
          { id: 'Lti13PrivacySettings', effectiveValue: controls.settingsReady ? 'NO_LEARNER_INFO' : 'LEARNER_NAME_ONLY' },
        ] });
        if (method === 'POST') {
          expect(body).toEqual({ settings: [{ settingId: 'PlayerLaunchType', value: 'FRAMESET' }, { settingId: 'PlayerScoLaunchType', value: 'FRAMESET' }, { settingId: 'Lti13PrivacySettings', value: 'NO_LEARNER_INFO' }] });
          if (!controls.ignoreSettings) settings.set(id, { settingItems: (body!.settings as Row[]).map(item => ({ id: item.settingId, effectiveValue: item.value })) });
          if (controls.holdSettingsWrite) { const held = controls.holdSettingsWrite; controls.holdSettingsWrite = null; controls.settingsWriteStarted?.resolve(); await held.promise; }
          if (controls.loseSettings) { controls.loseSettings = false; throw Error('Lost settings reply'); }
          return new Response(null, { status: 204 });
        }
      }
      const id = decodeURIComponent(path.slice('/courses/'.length));
      if (method === 'GET') return helpers.has(id) ? json(helpers.get(id)) : json({}, 404);
      if (method === 'DELETE') { expect(id).toMatch(/^i2idlx-learning-/); if (controls.deleteFails) return json({}, 503); helpers.delete(id); return new Response(null, { status: 204 }); }
    }
    if (path.startsWith('/contentConnectors/') && method === 'DELETE') { expect(path).toBe('/contentConnectors/fixture-connector'); if (controls.deleteFails) return json({}, 503); connectors.delete('fixture-connector'); return new Response(null, { status: 204 }); }
    throw Error('Unexpected Cloud operation: ' + method + ' ' + path);
  };
  const store = new LearningConnectionsStore({ repository, fetch: cloud, now: () => now });
  const created = await store.request(owner, { operation: 'create-connector', label: 'Institution Cloud', credentials: { app_id: 'test-app', secret: 'test-secret' },
    policy: { allowAiContent: true, allowAiProgress: true }, intent: 'authorize-enrolled-learners', request_id: 'fixture-create' });
  const connector = record(created.connector), id = String(connector.id);
  const sessions = new Map([['owner', owner], ['student', student], ['other', other]]);
  const auth = {
    async resolve(req: express.Request) {
      const name = /(?:^|;\s*)human=([^;]+)/.exec(req.get('Cookie') ?? '')?.[1], p = name ? sessions.get(name) : undefined;
      if (!p || controls.revoked) throw new LearningAuthError(401, 'learning_sign_in_required'); return p;
    },
    async revalidate(p: LearningPrincipal) { if (controls.revoked || p.signal.aborted || p.expiresAt <= now || ![...sessions.values()].includes(p)) throw new LearningAuthError(401, 'learning_session_expired'); return p; },
    assertMutation(req: express.Request, _p: LearningPrincipal) { if (req.get('Origin') !== BASE || req.get('X-I2IDLX-Learning-CSRF') !== 'test-csrf') throw new LearningAuthError(403, 'learning_csrf_refused'); },
  };
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifyJwt = async (jwt: string, jwks: string) => {
    expect(jwks).toBe(platform.jwksEndpoint); const parts = jwt.split('.');
    if (controls.failJwt || parts.length !== 3) return { ok: false };
    const ok = verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), keys.publicKey, Buffer.from(parts[2]!, 'base64url'));
    return { ok, header: record(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())), payload: record(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())) };
  };
  const config = { baseUrl: BASE, store, auth, fetch: cloud, now: () => now, verifyJwt,
    ...(options.publicRequestsPerMinute === undefined ? {} : { publicRequestsPerMinute: options.publicRequestsPerMinute }) };
  const manager = new LearningLtiManager(config), app = express(); app.use(express.json()); manager.attachRoutes(app);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const local = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => { manager.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = (path: string, cookies = '', init: RequestInit = {}) => fetch(local + path, { ...init, redirect: 'manual', headers: { ...(cookies ? { Cookie: cookies } : {}), ...init.headers } });
  const signJwt = (payload: Row) => { const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'), p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return h + '.' + p + '.' + sign('RSA-SHA256', Buffer.from(h + '.' + p), keys.privateKey).toString('base64url'); };
  async function installed() { await manager.prepare(owner, id); const result = await manager.install(owner, id); expect(result.state).toBe('ready'); return result; }
  async function begin(dto: LearningLtiDto) {
    const settings = dto.settings!; const url = new URL(settings.login_url);
    url.search = new URLSearchParams({ iss: platform.issuer, client_id: platform.toolClientId, target_link_uri: settings.launch_url, login_hint: 'opaque-provider-hint' }).toString();
    const r = await request(url.pathname + url.search); expect(r.status).toBe(302); const redirect = new URL(r.headers.get('location')!);
    expect(redirect.searchParams.get('externalConfig')).toBe('opaque-routing'); expect(redirect.searchParams.has('STATE')).toBe(false);
    return { redirect, browser: cookiePair(r, '__Host-i2idlx-learning-lti'), launch: new URL(settings.launch_url).pathname };
  }
  function payload(p: Awaited<ReturnType<typeof begin>>, patch: Row = {}) {
    const setup = p.launch.split('/').at(-2)!;
    return { iss: platform.issuer, aud: platform.toolClientId, sub: 'unmapped-private-platform-subject', nonce: p.redirect.searchParams.get('nonce'), iat: now / 1000, exp: now / 1000 + 300,
      [LTI_CLAIMS.deploymentId]: platform.deploymentId, [LTI_CLAIMS.version]: '1.3.0', [LTI_CLAIMS.messageType]: 'LtiResourceLinkRequest',
      [LTI_CLAIMS.targetLinkUri]: BASE + p.launch, [LTI_CLAIMS.context]: { id: setup }, [LTI_CLAIMS.resourceLink]: { id: 'isolated-helper-resource' },
      [LTI_CLAIMS.roles]: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'], ...patch };
  }
  const launch = (p: Awaited<ReturnType<typeof begin>>, patch: Row = {}) => request(p.launch, '', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: p.redirect.searchParams.get('state')!, id_token: signJwt(payload(p, patch)) }).toString() });
  const claim = (cookies: string, human = 'student', csrf = 'test-csrf') => request(ROOT + '/receipt/claim', cookies + (human ? '; human=' + human : ''), { method: 'POST',
    headers: { Origin: BASE, 'Content-Type': 'application/json', 'X-I2IDLX-Learning-CSRF': csrf }, body: '{}' });
  return { manager, store, owner, student, other, connector, id, config, controls, calls, connectors, helpers, settings, request, installed, begin, launch, claim,
    state: () => copy(value.state), reads: () => reads, advance: (ms: number) => { now += ms; } };
}

describe('institution-owned SCORM Cloud LTI discovery', () => {
  it.each(['status', 'install'] as const)('blocks historical ready public routes until owner %s confirms current helper settings', async operation => {
    const f = await fixture(), ready = await f.installed(), oldLaunch = await f.begin(ready);
    expect(f.state().connectors[0]!.lti).toMatchObject({ state: 'ready', helperSettingsVersion: 1 });
    await f.store.updateConnector(f.owner, f.id, connector => { delete connector.lti!.helperSettingsVersion; });
    f.settings.clear(); // A historical helper still inherits popup/name defaults.
    const before = f.calls.length;
    expect((await f.manager.prepare(f.owner, f.id)).state).toBe('installing');
    expect(f.calls).toHaveLength(before);
    const settings = ready.settings!, login = new URL(settings.login_url);
    login.search = new URLSearchParams({ iss: 'https://cloud.scorm.com', client_id: 'fixture-client', target_link_uri: settings.launch_url, login_hint: 'opaque-hint' }).toString();
    expect((await f.request(login.pathname + login.search)).status).toBe(404);
    expect((await f.request(new URL(settings.jwks_url).pathname)).status).toBe(404);
    expect((await f.launch(oldLaunch)).status).toBe(404); // A previously issued state cannot bypass migration.
    const upgraded = await f.manager[operation](f.owner, f.id); expect(upgraded.state).toBe('ready');
    expect(f.state().connectors[0]!.lti).toMatchObject({ state: 'ready', helperSettingsVersion: 1 });
    expect(f.calls.slice(before).filter(call => call.method === 'POST' && call.path.endsWith('/configuration'))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.path.startsWith('/courses/importJobs/noUpload'))).toHaveLength(1);
    const p = await f.begin(upgraded); expect((await f.launch(p)).status).toBe(303);
  });
  it('keeps a failed legacy confirmation pending and reconciles its lost settings acknowledgement', async () => {
    const f = await fixture(), ready = await f.installed();
    await f.store.updateConnector(f.owner, f.id, connector => { delete connector.lti!.helperSettingsVersion; }); f.settings.clear(); f.controls.loseSettings = true;
    expect((await f.manager.status(f.owner, f.id)).state).toBe('installing');
    expect(f.state().connectors[0]!.lti).not.toHaveProperty('helperSettingsVersion');
    expect((await f.request(new URL(ready.settings!.jwks_url).pathname)).status).toBe(404);
    const writes = f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/configuration')).length;
    expect((await f.manager.status(f.owner, f.id)).state).toBe('ready');
    expect(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/configuration'))).toHaveLength(writes);
  });
  it('cannot persist helper confirmation or allow public launch after revocation during a settings write', async () => {
    const f = await fixture(), ready = await f.installed(), oldLaunch = await f.begin(ready);
    await f.store.updateConnector(f.owner, f.id, connector => { delete connector.lti!.helperSettingsVersion; }); f.settings.clear();
    const held = deferred(), started = deferred(); f.controls.holdSettingsWrite = held; f.controls.settingsWriteStarted = started;
    const pending = f.manager.status(f.owner, f.id), outcome = pending.then(() => null, error => error as unknown);
    await started.promise;
    expect(f.state().connectors[0]!.lti).toMatchObject({ state: 'installing' });
    expect((await f.request(new URL(ready.settings!.jwks_url).pathname)).status).toBe(404);
    await f.store.request(f.owner, { operation: 'revoke-connector', connector_id: f.id });
    held.resolve(); expect(await outcome).toMatchObject({ status: 403, code: 'learning_connection_revoked' });
    expect(f.state().connectors[0]!).toMatchObject({ status: 'revoked', authorization: null });
    expect(f.state().connectors[0]!).not.toHaveProperty('lti');
    expect((await f.launch(oldLaunch)).status).toBe(404); expect(f.state().links).toHaveLength(0);
  });
  it('configures only the generated helper in-frame without learner PII and reconciles a lost settings acknowledgement', async () => {
    const f = await fixture(); await f.manager.prepare(f.owner, f.id); f.controls.loseSettings = true;
    const pending = await f.manager.install(f.owner, f.id); expect(pending).toMatchObject({ state: 'installing', note: expect.stringContaining('privacy settings are unconfirmed') });
    expect((await f.manager.status(f.owner, f.id)).state).toBe('ready');
    expect(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/configuration'))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.path.startsWith('/courses/importJobs/noUpload'))).toHaveLength(1);
    expect(f.calls.some(call => /appManagement|registrations|learners|roles/.test(call.path))).toBe(false);
    expect((await f.manager.remove(f.owner, f.id)).state).toBe('removed'); expect(f.helpers.size).toBe(0);
  });
  it('requires effective settings readback and does not write when helper defaults are already safe', async () => {
    const f = await fixture(); await f.manager.prepare(f.owner, f.id); f.controls.ignoreSettings = true;
    expect((await f.manager.install(f.owner, f.id)).state).toBe('installing');
    f.controls.ignoreSettings = false; expect((await f.manager.status(f.owner, f.id)).state).toBe('ready');
    const g = await fixture(); g.controls.settingsReady = true; await g.installed();
    expect(g.calls.some(call => call.method === 'POST' && call.path.endsWith('/configuration'))).toBe(false);
  });
  it('persists isolated install settings, exact Cloud routing and public-only tool keys across restart', async () => {
    const f = await fixture(), prepared = await f.manager.prepare(f.owner, f.id); expect(prepared.state).toBe('prepared');
    expect(f.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    const ready = await f.manager.install(f.owner, f.id); expect(ready.state).toBe('ready');
    const exported = JSON.stringify(ready); expect(exported).not.toContain('test-secret'); expect(exported).not.toContain('opaque-routing'); expect(exported).not.toContain('PRIVATE KEY');
    const restarted = new LearningLtiManager(f.config); expect(await restarted.status(f.owner, f.id)).toEqual(ready); restarted.dispose();
    const jwks = await f.request(new URL(ready.settings!.jwks_url).pathname); expect(jwks.status).toBe(200); const body = record(await jwks.json());
    expect(body.keys).toEqual([expect.objectContaining({ alg: 'RS256', use: 'sig', kty: 'RSA' })]); expect(JSON.stringify(body)).not.toContain('"d":');
    await expect(f.manager.status(f.other, f.id)).rejects.toMatchObject({ status: 404 });
    expect(f.helpers.size).toBe(1); expect(f.connectors.size).toBe(1);
    expect(f.calls.some(c => /registrations|learners|ags|nrps|grade/.test(c.path))).toBe(false);
  });
  it('validates signed launch then requires browser binding, human sign-in and deliberate CSRF claim; mapping stays unapproved', async () => {
    const f = await fixture(), ready = await f.installed(), p = await f.begin(ready), launched = await f.launch(p);
    expect(launched.status).toBe(303); expect(launched.headers.get('location')).toBe(BASE + ROOT + '/receipt');
    const receipt = cookiePair(launched, '__Host-i2idlx-learning-lti-receipt'), cookies = p.browser + '; ' + receipt;
    expect(f.state().links).toHaveLength(0);
    const stolen = await f.claim(receipt); expect(stolen.status).toBe(410); await stolen.text();
    const unsigned = await f.claim(cookies, ''); expect(unsigned.status).toBe(401); await unsigned.text();
    const page = await f.request(ROOT + '/receipt', cookies); expect(page.status).toBe(200); expect(await page.text()).not.toContain('unmapped-private-platform-subject');
    const csrf = await f.claim(cookies, 'student', 'wrong'); expect(csrf.status).toBe(403); await csrf.text();
    const claimed = await f.claim(cookies); expect(claimed.status).toBe(200); const result = await claimed.text(); expect(result).not.toContain('unmapped-private-platform-subject');
    const link = f.state().links[0]!; expect(link.status).toBe('pending-admin'); expect(link.subject).toBe(f.student.subject); expect(link.learnerId).toBeUndefined(); expect(link.registrationId).toBeUndefined();
    expect(link.lti).toMatchObject({ subject: 'unmapped-private-platform-subject', helper_is_enrollment: false }); expect(link.lti).not.toHaveProperty('browser_hash');
    await expect(f.store.request(f.student, { operation: 'courses', link_id: link.id })).rejects.toMatchObject({ status: 403, code: 'learning_link_inactive' });
    const replay = await f.launch(p); expect(replay.status).toBe(401); await replay.text(); const used = await f.claim(cookies); expect(used.status).toBe(410); await used.text();
  });
  it('moves an embedded launch into a first-party tab with no initial cookie and a one-use opaque handoff', async () => {
    const f = await fixture(), ready = await f.installed(), settings = ready.settings!;
    const embedded = async () => {
      const url = new URL(settings.login_url);
      url.search = new URLSearchParams({ iss: 'https://cloud.scorm.com', client_id: 'fixture-client', target_link_uri: settings.launch_url,
        login_hint: 'private-platform-login-hint', lti_message_hint: 'private-platform-message-hint' }).toString();
      const response = await f.request(url.pathname + url.search, '', { headers: { 'Sec-Fetch-Dest': 'iframe' } });
      expect(response.status).toBe(200); expect(response.headers.getSetCookie()).toEqual([]);
      const body = await response.text(); expect(body).toContain('Continue in a new tab'); expect(body).not.toContain('private-platform');
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors https://workbench.example https://cloud.scorm.com');
      expect(response.headers.get('content-security-policy')).toContain('https://app.cloud.scorm.com');
      expect(response.headers.get('content-security-policy')).not.toContain('*');
      expect(body).not.toContain('<script');
      const link = new URL(/href="([^"]+)"/.exec(body)![1]!);
      expect(link.origin).toBe(BASE); expect(link.pathname).toBe(ROOT + '/open'); expect([...link.searchParams.keys()]).toEqual(['handoff']);
      expect(link.searchParams.get('handoff')).toMatch(/^[a-f0-9]{64}$/); return link.pathname + link.search;
    };
    const handoff = await embedded();
    const framedAgain = await f.request(handoff, '', { headers: { 'Sec-Fetch-Dest': 'frame' } }); expect(framedAgain.status).toBe(200);
    expect(framedAgain.headers.getSetCookie()).toEqual([]); expect(await framedAgain.text()).toContain('Continue in a new tab');
    const opened = await f.request(handoff, '', { headers: { 'Sec-Fetch-Dest': 'document' } }); expect(opened.status).toBe(302);
    const nonceHeader = opened.headers.getSetCookie().find(value => value.startsWith('__Host-i2idlx-learning-lti='))!;
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=900']) expect(nonceHeader).toContain(flag);
    expect(nonceHeader).not.toContain('Domain=');
    const browser = cookiePair(opened, '__Host-i2idlx-learning-lti'); expect(browser).toMatch(/^__Host-i2idlx-learning-lti=[a-f0-9]{64}$/);
    const redirect = new URL(opened.headers.get('location')!); expect(redirect.searchParams.get('login_hint')).toBe('private-platform-login-hint');
    expect(redirect.searchParams.get('lti_message_hint')).toBe('private-platform-message-hint'); expect(redirect.searchParams.get('nonce')).toMatch(/^[a-f0-9]{64}$/);
    const launched = await f.launch({ redirect, browser, launch: new URL(settings.launch_url).pathname }); expect(launched.status).toBe(303);
    const receiptHeader = launched.headers.getSetCookie().find(value => value.startsWith('__Host-i2idlx-learning-lti-receipt='))!;
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) expect(receiptHeader).toContain(flag);
    expect(receiptHeader).not.toContain('Domain=');
    const receipt = cookiePair(launched, '__Host-i2idlx-learning-lti-receipt'); const claimed = await f.claim(browser + '; ' + receipt); expect(claimed.status).toBe(200); await claimed.text();
    expect(f.state().links[0]!.status).toBe('pending-admin'); expect(f.state().links[0]!.learnerId).toBeUndefined();
    const replay = await f.request(handoff, '', { headers: { 'Sec-Fetch-Dest': 'document' } }); expect(replay.status).toBe(410); await replay.text();
    const expiring = await embedded(); f.advance(300_001);
    const expired = await f.request(expiring, '', { headers: { 'Sec-Fetch-Dest': 'document' } }); expect(expired.status).toBe(410); await expired.text();
  });
  it('rejects wrong signed tuples, missing state, invalid signatures and expired launches without inferring a learner', async () => {
    const f = await fixture(), ready = await f.installed();
    for (const patch of [{ iss: 'https://attacker.example' }, { aud: 'other-client' }, { nonce: 'wrong' }, { [LTI_CLAIMS.deploymentId]: 'other-deployment' },
      { [LTI_CLAIMS.context]: { id: 'other-helper' } }, { [LTI_CLAIMS.targetLinkUri]: 'https://attacker.example/launch' }, { exp: NOW / 1000 - 1 }]) {
      const p = await f.begin(ready), r = await f.launch(p, patch); expect(r.status).toBe(401); await r.text();
    }
    const bad = await f.begin(ready); f.controls.failJwt = true; const signature = await f.launch(bad); expect(signature.status).toBe(401); await signature.text(); f.controls.failJwt = false;
    const expired = await f.begin(ready); f.advance(300_001); const late = await f.launch(expired); expect(late.status).toBe(401); await late.text(); expect(f.state().links).toHaveLength(0);
  });
  it('recovers a lost connector response and reports an uncertain helper import without duplicating writes', async () => {
    const f = await fixture(); await f.manager.prepare(f.owner, f.id); f.controls.loseCreate = true;
    await expect(f.manager.install(f.owner, f.id)).rejects.toMatchObject({ code: 'learning_lti_provider_unavailable' });
    f.controls.loseImport = true; await expect(f.manager.install(f.owner, f.id)).rejects.toMatchObject({ code: 'learning_lti_provider_unavailable' });
    expect((await f.manager.install(f.owner, f.id)).state).toBe('installing');
    expect(f.calls.filter(c => c.method === 'POST' && c.path === '/contentConnectors')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'POST' && c.path.startsWith('/courses/importJobs/noUpload'))).toHaveLength(1);
    expect((await f.manager.remove(f.owner, f.id)).state).toBe('cleanup-failed');
    expect(f.state().connectors[0]!.authorization).toBeTruthy();
  });
  it('revokes launch/receipt access immediately and confirms removal of only its generated resources', async () => {
    const f = await fixture(), ready = await f.installed(), p = await f.begin(ready), launch = await f.launch(p), cookies = p.browser + '; ' + cookiePair(launch, '__Host-i2idlx-learning-lti-receipt');
    f.controls.deleteFails = true; const failure = await f.manager.remove(f.owner, f.id); expect(failure.state).toBe('cleanup-failed'); expect(f.state().connectors[0]!.authorization).toBeTruthy();
    expect((await f.claim(cookies)).status).toBe(410);
    f.controls.deleteFails = false; expect((await f.manager.remove(f.owner, f.id)).state).toBe('removed'); expect(f.helpers.size).toBe(0); expect(f.connectors.size).toBe(0);
    expect(f.state().connectors[0]!.status).toBe('active'); // credential erasure is a separate root-owned action.
    expect((await f.request(new URL(ready.settings!.jwks_url).pathname)).status).toBe(404);
  });
  it('rejects provider-selected foreign endpoints, helper collisions and revoked human setup', async () => {
    const f = await fixture(); await f.manager.prepare(f.owner, f.id); f.controls.badPlatform = true;
    await expect(f.manager.install(f.owner, f.id)).rejects.toMatchObject({ code: 'learning_lti_platform_invalid' }); expect(f.helpers.size).toBe(0);
    f.controls.revoked = true; await expect(f.manager.remove(f.owner, f.id)).rejects.toMatchObject({ status: 401 });
    expect(f.calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    const g = await fixture(); await g.manager.prepare(g.owner, g.id); const setup = g.state().connectors[0]!.lti!;
    g.helpers.set('i2idlx-learning-' + setup.id, { id: 'i2idlx-learning-' + setup.id, title: 'Existing unrelated course' });
    await expect(g.manager.install(g.owner, g.id)).rejects.toMatchObject({ code: 'learning_lti_helper_collision' });
    expect((await g.manager.remove(g.owner, g.id)).state).toBe('removed');
    expect(g.helpers.size).toBe(1); expect(g.calls.some(c => c.method === 'DELETE' && c.path.startsWith('/courses/'))).toBe(false);
  });
  it('admits every public route before encrypted-state reads or key work with a fixed bounded process bucket', async () => {
    const f = await fixture({ publicRequestsPerMinute: 2 }), ready = await f.installed(), jwks = new URL(ready.settings!.jwks_url).pathname;
    const accepted = await f.request(jwks); expect(accepted.status).toBe(200); await accepted.text(); await f.begin(ready);
    const before = f.reads(), login = new URL(ready.settings!.login_url).pathname, launch = new URL(ready.settings!.launch_url).pathname;
    for (const [path, method] of [[jwks, 'GET'], [login, 'GET'], [ROOT + '/open?handoff=' + 'a'.repeat(64), 'GET'], [ROOT + '/receipt', 'GET'],
      [ROOT + '/receipt.js', 'GET'], [ROOT + '/receipt/claim', 'POST'], [launch, 'POST']]) {
      const r = await f.request(path!, '', { method }); expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('60');
      expect(await r.json()).toEqual({ error: 'learning_lti_rate_limited' }); expect(f.reads()).toBe(before);
    }
    expect(() => new LearningLtiManager({ ...f.config, publicRequestsPerMinute: 301 })).toThrow('Invalid LTI public request limit');
  });
});
