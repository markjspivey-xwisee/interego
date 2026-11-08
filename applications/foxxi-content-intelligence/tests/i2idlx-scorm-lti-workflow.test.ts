import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSessionStore } from '../src/i2idlx-agent-sessions.js';
import { CourseLtiManager } from '../src/i2idlx-course-lti.js';
import { UserCourseStore } from '../src/i2idlx-user-courses.js';
import { LTI_CLAIMS } from '../src/lti13.js';

type Row = Record<string, unknown>;
type Call = { method: string; path: string; body?: Row };
const BASE = 'https://workbench.example', CLOUD = 'https://cloud.scorm.com/api/v2';
const ACTOR = 'did:web:identity.example:agents:course-owner';
const NOW = Date.parse('2026-11-07T22:00:00Z');
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'i2idlx-scorm-lti-workflow-'));
  cleanups.push(async () => {
    const target = await realpath(directory);
    expect(dirname(target)).toBe(await realpath(tmpdir()));
    await rm(target, { recursive: true, force: true });
  });
  const glossary = join(directory, 'glossary.json');
  await writeFile(glossary, JSON.stringify({ meta: { release: 'v0.0.93', commit: 'b'.repeat(40), scheme: { title: 'Fixture glossary', rights: 'CC BY 4.0' } },
    concepts: [{ id: 'learning-record', l: 'Learning record', d: 'An informational record.', a: [], b: [], n: [], r: [], ev: [] }],
    sources: [], roles: [], mappings: [], enactments: [], semantic: {}, ports: [], queries: [] }));
  let now = NOW;
  const sessions = new AgentSessionStore({ baseUrl: BASE, now: () => now });
  cleanups.push(() => sessions.dispose());
  const makeSession = (label: string) => {
    const made = sessions.create(label);
    sessions.driver({ i2idlx_operation: 'agent-session', bridge_audience: BASE, session_id: made.session_id,
      operation: 'claim', invite_token: made.invite_token }, ACTOR);
    return made;
  };
  const owner = makeSession('owner-browser'), sameDidOtherBrowser = makeSession('same-did-other-browser');
  const suffix = randomBytes(5).toString('hex');
  const original = { id: 'owner-course-' + suffix, title: 'Two lesson owner course', version: 2, learningStandard: 'SCORM12' };
  const alternate = { ...original, id: 'alternate-course-' + suffix };
  const manifest = '<manifest identifier="source"><organizations default="org"><organization identifier="org"><title>Owner source</title>' +
    '<item identifier="incident" identifierref="incident-resource"><title>Incident procedure</title></item>' +
    '<item identifier="resume" identifierref="resume-resource"><title>Resume exercise</title></item>' +
    '</organization></organizations><resources>' +
    '<resource identifier="incident-resource" type="webcontent" href="incident.html"><file href="incident.html"/></resource>' +
    '<resource identifier="resume-resource" type="webcontent" href="resume.html"><file href="resume.html"/></resource>' +
    '</resources></manifest>';
  const files = new Map<string, Buffer>([
    ['imsmanifest.xml', Buffer.from(manifest)],
    ['incident.html', Buffer.from('<html><head><title>Incident procedure</title></head><body><h1>Incident procedure</h1><p>Record BLUE-27 and notify the Orion desk.</p></body></html>')],
    ['resume.html', Buffer.from('<html><head><title>Resume exercise</title></head><body><h1>Resume exercise</h1><p>Resume only when READY-9 is shown.</p></body></html>')],
    ['quiz/answers.html', Buffer.from('<p>HIDDEN-ANSWER-KEY</p>')],
  ]);
  const connectors = new Map<string, Row>(), helpers = new Map<string, Row>(), jobs = new Map<string, string>(), settings = new Map<string, Row>();
  const calls: Call[] = [];
  const controls = { loseCreateResponse: false, hideConnectors: false, connectorDeleteFailures: 0, importRunning: false,
    loseSettingsResponse: false, ignoreSettingsWrite: false, settingsInitiallyReady: false,
    holdSettingsRead: null as null | ReturnType<typeof deferred<void>>, settingsReadStarted: null as null | ReturnType<typeof deferred<void>>,
    holdConnectorList: null as null | ReturnType<typeof deferred<void>>, connectorListStarted: null as null | ReturnType<typeof deferred<void>> };
  const platform = { issuer: 'https://cloud.scorm.com', toolClientId: 'client-' + suffix,
    jwksEndpoint: 'https://cloud.scorm.com/api/v2/plugin/lti13/connector-' + suffix + '/jwks?externalConfig=fixture-' + suffix,
    oidcAuthorizationUrl: 'https://cloud.scorm.com/ScormEngineInterface/defaultui/player/authorizations.html', deploymentId: 'deployment-' + suffix,
    accessTokenUrl: 'https://cloud.scorm.com/api/v2/plugin/lti13/connector-' + suffix + '/token?externalConfig=fixture-' + suffix };
  const cloud = vi.fn((async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = String(input), url = new URL(raw), method = init?.method ?? 'GET';
    expect(raw.startsWith(CLOUD + '/')).toBe(true);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Basic ' + Buffer.from('app-' + suffix + ':FIXTURE-ONLY-SECRET').toString('base64'));
    const path = url.pathname.slice('/api/v2'.length), body = typeof init?.body === 'string' ? JSON.parse(init.body) as Row : undefined;
    calls.push({ method, path: path + url.search, ...(body ? { body } : {}) });
    if (method === 'GET' && path === '/courses') return Response.json({ courses: [original, alternate, ...helpers.values()] });
    if (method === 'POST' && path === '/contentConnectors') {
      const id = 'connector-' + suffix;
      connectors.set(id, { connectorId: id, contentConnectorType: body!.contentConnectorType, configuration: body!.configuration,
        enabled: body!.enabled, additionalInstanceInformation: platform });
      if (controls.loseCreateResponse) { controls.loseCreateResponse = false; throw new Error('Connection dropped after provider write'); }
      return Response.json({ result: id });
    }
    if (method === 'GET' && path === '/contentConnectors') {
      expect(url.searchParams.get('includeAdditionalInstanceInformation')).toBe('true');
      if (controls.holdConnectorList) {
        const held = controls.holdConnectorList; controls.holdConnectorList = null;
        controls.connectorListStarted?.resolve(); await held.promise;
      }
      const unrelated = { connectorId: 'unrelated-connector', contentConnectorType: 'ContentConnector.Lti13', enabled: true,
        configuration: { toolPublicKey: 'OTHER-PUBLIC-KEY', toolOidcLoginInitiationsEndpoint: 'https://other.example/login', toolOidcLaunchRedirectUris: ['https://other.example/launch'] } };
      return Response.json({ connectorEntries: [unrelated, ...(controls.hideConnectors ? [] : connectors.values())] });
    }
    if (method === 'POST' && path === '/courses/importJobs/noUpload') {
      const helper = url.searchParams.get('courseId')!;
      expect(helper).toMatch(/^i2idlx-lti-qa-[a-f0-9]{48}$/);
      expect(helper).not.toBe(original.id); expect(url.searchParams.get('mayCreateNewVersion')).toBe('false');
      const connector = body!.connectorReferenceRequest as Row, metadata = connector.metadataForConnector as Row;
      expect(connector.connectorId).toBe('connector-' + suffix);
      expect(metadata.ltiMetadata).toMatchObject({ context: { contextId: helper.slice('i2idlx-lti-qa-'.length) } });
      const job = 'import-' + suffix; jobs.set(job, helper);
      if (!controls.importRunning) helpers.set(helper, { id: helper, title: 'Temporary LTI course Q&A', version: 0, learningStandard: 'EXTERNAL' });
      return Response.json({ result: job });
    }
    if (method === 'GET' && path.startsWith('/courses/importJobs/')) {
      const id = decodeURIComponent(path.slice('/courses/importJobs/'.length)), helper = jobs.get(id);
      if (!helper) return Response.json({ error: 'unknown job' }, { status: 404 });
      if (!controls.importRunning) helpers.set(helper, { id: helper, title: 'Temporary LTI course Q&A', version: 0, learningStandard: 'EXTERNAL' });
      return Response.json({ jobId: id, status: controls.importRunning ? 'RUNNING' : 'COMPLETE',
        ...(!controls.importRunning ? { importResult: { course: { id: helper } } } : {}) });
    }
    if (method === 'GET' && path === '/courses/' + encodeURIComponent(original.id) + '/versions/2/asset/list') {
      return Response.json({ files: [...files].map(([name, bytes]) => ({ path: name, size: bytes.length, modified: '2026-11-07T00:00:00Z' })) });
    }
    if (method === 'GET' && path === '/courses/' + encodeURIComponent(original.id) + '/versions/2/asset') {
      const bytes = files.get(url.searchParams.get('relativePath') ?? '');
      if (!bytes) throw new Error('Unlisted asset was requested');
      return new Response(Uint8Array.from(bytes), { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (path.startsWith('/courses/')) {
      const encoded = path.slice('/courses/'.length);
      if (encoded.endsWith('/configuration')) {
        const id = decodeURIComponent(encoded.slice(0, -'/configuration'.length));
        expect(id).toMatch(/^i2idlx-lti-qa-[a-f0-9]{48}$/); expect(id).not.toBe(original.id); expect(id).not.toBe(alternate.id);
        if (!helpers.has(id)) return Response.json({}, { status: 404 });
        if (method === 'GET') {
          if (controls.holdSettingsRead) { const held = controls.holdSettingsRead; controls.holdSettingsRead = null; controls.settingsReadStarted?.resolve(); await held.promise; }
          return Response.json(settings.get(id) ?? { settingItems: [
            { id: 'PlayerLaunchType', effectiveValue: 'FRAMESET' },
            { id: 'PlayerScoLaunchType', effectiveValue: controls.settingsInitiallyReady ? 'FRAMESET' : 'NEW_WINDOW' },
            { id: 'Lti13PrivacySettings', effectiveValue: controls.settingsInitiallyReady ? 'NO_LEARNER_INFO' : 'LEARNER_NAME_ONLY' },
          ] });
        }
        if (method === 'POST') {
          expect(body).toEqual({ settings: [{ settingId: 'PlayerLaunchType', value: 'FRAMESET' }, { settingId: 'PlayerScoLaunchType', value: 'FRAMESET' }, { settingId: 'Lti13PrivacySettings', value: 'NO_LEARNER_INFO' }] });
          if (!controls.ignoreSettingsWrite) settings.set(id, { settingItems: (body!.settings as Row[]).map(item => ({ id: item.settingId, effectiveValue: item.value })) });
          if (controls.loseSettingsResponse) { controls.loseSettingsResponse = false; throw Error('Lost helper settings acknowledgement'); }
          return new Response(null, { status: 204 });
        }
      }
      const id = decodeURIComponent(encoded);
      if (method === 'GET' && id === original.id) return Response.json(original);
      if (method === 'GET') return helpers.has(id) ? Response.json(helpers.get(id)) : Response.json({ error: 'not found' }, { status: 404 });
      if (method === 'DELETE') {
        expect(id).not.toBe(original.id); expect(id).not.toBe(alternate.id); expect(id).toMatch(/^i2idlx-lti-qa-/);
        const existed = helpers.delete(id); return new Response(null, { status: existed ? 204 : 404 });
      }
    }
    if (path.startsWith('/contentConnectors/')) {
      const id = decodeURIComponent(path.slice('/contentConnectors/'.length));
      expect(id).not.toBe('unrelated-connector');
      if (method === 'DELETE') {
        if (controls.connectorDeleteFailures > 0) { controls.connectorDeleteFailures--; return Response.json({ error: 'provider unavailable' }, { status: 503 }); }
        const existed = connectors.delete(id); return new Response(null, { status: existed ? 204 : 404 });
      }
      if (method === 'PUT') {
        expect(body).toEqual({ enabled: false }); const connector = connectors.get(id); if (connector) connector.enabled = false;
        return new Response(null, { status: connector ? 204 : 404 });
      }
    }
    throw new Error('Unexpected Cloud workflow request: ' + method + ' ' + path);
  }) as typeof fetch);
  const lti = new CourseLtiManager({ baseUrl: BASE, now: () => now,
    // Program-only claim fixture. The manager's own suite independently tests
    // actual RSA/ES signatures and bounded native public-key transport.
    verifyJwt: async token => ({ ok: true, header: { alg: 'RS256' }, payload: JSON.parse(token) as Row }) });
  const store = new UserCourseStore({ baseUrl: BASE, sessions, now: () => now, fetch: cloud, ltiManager: lti,
    taskConfig: { baseUrl: BASE, appDataFile: glossary } });
  cleanups.push(() => store.dispose());
  const request = (operation: string, extra: Row = {}, session = owner) => store.request({ session_id: session.session_id, operation, ...extra }, session.browser_token);
  const connect = (session = owner) => request('connect', { provider: 'scorm-cloud', credentials: { type: 'basic', app_id: 'app-' + suffix, secret: 'FIXTURE-ONLY-SECRET' } }, session);
  const permit = async (connection: Row, authority = 'owner', session = owner) => {
    const common = { connection_id: connection.connection_id, course_id: original.id, version: original.version };
    const granted = await request('grant', { ...common, mode: 'virtual', permission: { authorized: true, authority, retention_minutes: 10 } }, session);
    return { ...common, grant_id: (granted.grant as Row).id };
  };
  const prepare = async (common: Row) => {
    const value = await request('lti-prepare', common); return value.lti as Row;
  };
  const verifiedLaunch = async (prepared: Row) => {
    const tool = prepared.tool as Row, id = String(prepared.id);
    const redirect = new URL(lti.login(id, { iss: platform.issuer, client_id: platform.toolClientId, lti_deployment_id: platform.deploymentId,
      target_link_uri: tool.launch_url, login_hint: 'provider-opaque-hint' }));
    await lti.launch(id, { state: redirect.searchParams.get('state'), id_token: JSON.stringify({
      iss: platform.issuer, aud: platform.toolClientId, azp: platform.toolClientId, sub: 'platform-subject-' + suffix,
      iat: now / 1000, exp: now / 1000 + 300, nonce: redirect.searchParams.get('nonce'),
      [LTI_CLAIMS.deploymentId]: platform.deploymentId, [LTI_CLAIMS.version]: '1.3.0', [LTI_CLAIMS.messageType]: 'LtiResourceLinkRequest',
      [LTI_CLAIMS.targetLinkUri]: tool.launch_url, [LTI_CLAIMS.context]: { id }, [LTI_CLAIMS.resourceLink]: { id: 'helper-resource-' + suffix },
      [LTI_CLAIMS.roles]: ['http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'],
    }) });
  };
  const caches = () => {
    const connections = (store as unknown as { connections: Map<string, { grants: Map<string, { cache?: unknown }> }>; cacheBytes: number });
    return { caches: [...connections.connections.values()].flatMap(connection => [...connection.grants.values()].map(grant => grant.cache)), bytes: connections.cacheBytes };
  };
  return { store, sessions, lti, owner, sameDidOtherBrowser, original, alternate, controls, calls, connectors, helpers, request, connect, permit, prepare,
    verifiedLaunch, caches, applicationId: 'app-' + suffix, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe('per-user SCORM Cloud LTI to native source workflow', () => {
  it('confirms in-frame helper launch and no learner PII before ready, reconciling a lost settings write without duplicate creates', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common), scoped = { ...common, lti_id: prepared.id };
    f.controls.loseSettingsResponse = true;
    expect((await f.request('lti-setup', scoped)).lti).toMatchObject({ state: 'setting-up', note: expect.stringContaining('privacy settings are unconfirmed') });
    await expect(f.request('lti-launch', scoped)).rejects.toMatchObject({ status: 409 });
    expect((await f.request('lti-status', scoped)).lti).toMatchObject({ state: 'ready' });
    const writes = f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/configuration'));
    expect(writes).toHaveLength(1); expect(writes[0]!.path).toBe('/courses/i2idlx-lti-qa-' + prepared.id + '/configuration');
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.path.startsWith('/courses/importJobs/noUpload'))).toHaveLength(1);
  });
  it('does not mark a helper ready without effective launch/privacy confirmation, and skips writes when already configured', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common), scoped = { ...common, lti_id: prepared.id };
    f.controls.ignoreSettingsWrite = true;
    expect((await f.request('lti-setup', scoped)).lti).toMatchObject({ state: 'setting-up' });
    await expect(f.request('lti-launch', scoped)).rejects.toMatchObject({ status: 409 });
    f.controls.ignoreSettingsWrite = false; expect((await f.request('lti-status', scoped)).lti).toMatchObject({ state: 'ready' });
    const g = await fixture(), connected = await g.connect(), args = await g.permit(connected), setup = await g.prepare(args); g.controls.settingsInitiallyReady = true;
    expect((await g.request('lti-setup', { ...args, lti_id: setup.id })).lti).toMatchObject({ state: 'ready' });
    expect(g.calls.some(call => call.method === 'POST' && call.path.endsWith('/configuration'))).toBe(false);
  });
  it('cannot configure a helper or restore ready state after permission deletion while settings are delayed', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common), scoped = { ...common, lti_id: prepared.id };
    const held = deferred<void>(), started = deferred<void>(); f.controls.holdSettingsRead = held; f.controls.settingsReadStarted = started;
    const pending = f.request('lti-setup', scoped), result = pending.then(() => true, () => false); await started.promise;
    expect(await f.request('delete', common)).toMatchObject({ deleted: true, permission_revoked: true });
    held.resolve(); expect(await result).toBe(false);
    expect(f.calls.some(call => call.method === 'POST' && call.path.endsWith('/configuration'))).toBe(false);
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: true, original_course_unchanged: true });
    expect(f.helpers.size).toBe(0); expect(f.connectors.size).toBe(0);
  });
  it('binds a verified launch explicitly, reads cited versioned assets without an export/cache, then revokes and removes only its temporary setup', async () => {
    const f = await fixture(), connected = await f.connect(), common = await f.permit(connected);
    const before = await f.request('source', { ...common, question: 'What incident code should I record?' });
    expect((before.interventionContext as Row).course_access).not.toHaveProperty('lti');
    const prepared = await f.prepare(common), scoped = { ...common, lti_id: prepared.id };
    expect((await f.prepare(common)).id).toBe(prepared.id);
    const setup = await f.request('lti-setup', scoped);
    expect(setup.lti).toMatchObject({ state: 'ready', helper_course_id: 'i2idlx-lti-qa-' + prepared.id });
    await f.request('lti-setup', scoped);
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'POST' && call.path.startsWith('/courses/importJobs/noUpload'))).toHaveLength(1);
    const providerCalls = f.calls.length;
    const handoff = await f.request('lti-launch', scoped);
    const ownerPage = new URL(String(handoff.owner_course_url));
    expect(ownerPage.origin + ownerPage.pathname).toBe('https://app.cloud.scorm.com/sc/user/Course');
    expect([...ownerPage.searchParams]).toEqual([['courseId', 'i2idlx-lti-qa-' + prepared.id], ['appId', f.applicationId]]);
    expect(handoff).not.toHaveProperty('launch_url');
    expect(f.calls).toHaveLength(providerCalls);
    expect(f.calls.some(call => call.path.endsWith('/preview') || call.path.startsWith('/registrations'))).toBe(false);
    await f.verifiedLaunch(prepared);
    expect((await f.request('lti-status', scoped)).lti).toMatchObject({ state: 'verified', launch: {
      course_id: f.original.id, version: 2, subject: expect.stringMatching(/^platform-subject-/) } });
    const verifiedOnly = await f.request('source', { ...common, question: 'What incident code should I record?' });
    expect((verifiedOnly.interventionContext as Row).course_access).not.toHaveProperty('lti');
    expect((await f.request('lti-attach', scoped)).lti).toMatchObject({ state: 'attached' });
    const first = await f.request('source', { ...common, question: 'What incident code should I record?' });
    const second = await f.request('source', { ...common, question: 'When may I resume the exercise?' });
    expect(first.citations).toEqual([expect.objectContaining({ body: expect.stringContaining('BLUE-27'), locator: 'incident.html' })]);
    expect(second.citations).toEqual([expect.objectContaining({ body: expect.stringContaining('READY-9'), locator: 'resume.html' })]);
    const firstPacket = first.interventionContext as Row, secondPacket = second.interventionContext as Row;
    expect(firstPacket.course_access).toMatchObject({ mode: 'virtual', cache: { present: false, bytes: 0 }, permission: { verification: 'user-attested' },
      lti: { verification: 'signed-lti13-platform-launch', course_id: f.original.id, version: 2, subject_shared: false } });
    expect((firstPacket.course_access as Row).lti).not.toHaveProperty('subject');
    expect((first.source as Row).lti).not.toHaveProperty('subject');
    expect((firstPacket.source_context as Row).id).toBe((secondPacket.source_context as Row).id);
    expect((firstPacket.source_context as Row).version).toBe('course-version:2');
    expect((secondPacket.source_context as Row).version).toBe('course-version:2');
    expect(first.source).toMatchObject({ fingerprint_scope: 'selected-instructional-projection', retrieval: { package_downloaded: false, retained_content: false, full_course_fingerprint: false } });
    expect((first.source as Row).projection_sha256).not.toBe((second.source as Row).projection_sha256);
    expect(first.source).not.toHaveProperty('package_sha256'); expect(first.source).not.toHaveProperty('content_sha256');
    expect(f.caches()).toEqual({ caches: [undefined], bytes: 0 });
    expect(JSON.stringify([first, second])).not.toMatch(/FIXTURE-ONLY-SECRET|HIDDEN-ANSWER-KEY|platform-subject-|membership#Learner/);
    expect(f.calls.some(call => /\/zip(?:\?|$)|\/export/.test(call.path))).toBe(false);
    expect(await f.request('delete', common)).toMatchObject({ deleted: true, permission_revoked: true });
    expect(() => f.lti.jwks(String(prepared.id))).toThrow(/connection ended/);
    await expect(f.request('source', { ...common, question: 'Reuse?' })).rejects.toMatchObject({ status: 403 });
    await expect(f.request('lti-status', scoped)).rejects.toMatchObject({ status: 403 });
    expect(await f.request('access-status', { connection_id: common.connection_id, course_id: f.original.id, version: 2 })).toMatchObject({ grant: null, cache: { present: false, bytes: 0 } });
    const { grant_id: _grant, ...withoutGrant } = scoped;
    expect(await f.request('lti-disconnect', withoutGrant)).toMatchObject({ removed: true, original_course_unchanged: true });
    expect(f.helpers.size).toBe(0); expect(f.connectors.size).toBe(0);
    expect((await f.request('courses', { connection_id: common.connection_id })).courses).toContainEqual(expect.objectContaining({ id: f.original.id, version: 2 }));
    expect(await f.request('disconnect')).toMatchObject({ connected: false, lti_cleanup: { removed: true } });
    expect(await f.request('status')).toEqual({ connected: false });
    expect(f.caches()).toEqual({ caches: [], bytes: 0 });
    expect(f.calls.filter(call => call.method === 'DELETE').every(call => !call.path.includes(f.original.id) && !call.path.includes(f.alternate.id))).toBe(true);
  });

  it('refuses a different browser even with the same DID, and refuses wrong course/connection/grant bindings before writes', async () => {
    const f = await fixture(), first = await f.connect(), common = await f.permit(first), prepared = await f.prepare(common);
    const scoped = { ...common, lti_id: prepared.id };
    const other = await f.connect(f.sameDidOtherBrowser), otherCommon = await f.permit(other, 'owner', f.sameDidOtherBrowser);
    await expect(f.request('lti-status', scoped, f.sameDidOtherBrowser)).rejects.toMatchObject({ code: 'course_connection_not_found' });
    await expect(f.request('lti-attach', { ...otherCommon, lti_id: prepared.id }, f.sameDidOtherBrowser)).rejects.toMatchObject({ code: 'course_lti_binding_mismatch' });
    await expect(f.request('lti-setup', { ...scoped, course_id: f.alternate.id })).rejects.toMatchObject({ code: 'course_lti_binding_mismatch' });
    await expect(f.request('lti-setup', { ...scoped, grant_id: 'another-grant' })).rejects.toMatchObject({ code: 'course_lti_binding_mismatch' });
    await expect(f.request('lti-setup', { ...scoped, connection_id: other.connection_id })).rejects.toMatchObject({ code: 'course_connection_not_found' });
    await expect(f.request('lti-attach', scoped)).rejects.toMatchObject({ code: 'course_lti_launch_required' });
    expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('requires owner authority for creating a new trusted provider connection', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection, 'authorized-by-owner'), prepared = await f.prepare(common);
    await expect(f.request('lti-setup', { ...common, lti_id: prepared.id })).rejects.toMatchObject({ status: 403, code: 'course_lti_permission_denied' });
    expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('reconciles an uncertain connector creation by exact public configuration and never repeats the provider write', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common);
    const scoped = { ...common, lti_id: prepared.id }; f.controls.loseCreateResponse = true;
    expect((await f.request('lti-setup', scoped)).lti).toMatchObject({ state: 'setting-up' });
    await f.request('lti-setup', scoped);
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    const reconciled = (await f.request('lti-status', scoped)).lti as Row;
    expect(reconciled.connector_id).toMatch(/^connector-/); expect(reconciled).not.toHaveProperty('helper_course_id');
    expect(f.calls.some(call => call.path.startsWith('/courses/importJobs'))).toBe(false);
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: true });
    expect(f.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
    expect(f.calls.some(call => call.path.includes('unrelated-connector'))).toBe(false);
  });

  it('does not claim cleanup when a possibly-created connector cannot yet be identified, then reconciles a safe retry', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common);
    const scoped = { ...common, lti_id: prepared.id }; f.controls.loseCreateResponse = true; f.controls.hideConnectors = true;
    await f.request('lti-setup', scoped);
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: false });
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
    f.controls.hideConnectors = false;
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: true });
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    expect(f.connectors.size).toBe(0);
  });

  it('reports partial cleanup as unconfirmed and retries known resources without recreating them', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common);
    const scoped = { ...common, lti_id: prepared.id }; await f.request('lti-setup', scoped);
    f.controls.connectorDeleteFailures = 1;
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: false, lti: { state: 'cleanup-failed' }, original_course_unchanged: true });
    expect(() => f.lti.jwks(String(prepared.id))).toThrow(/connection ended/);
    expect(f.calls.some(call => call.method === 'PUT' && call.body?.enabled === false)).toBe(true);
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: true });
    expect(f.calls.filter(call => call.method === 'POST' && call.path === '/contentConnectors')).toHaveLength(1);
    expect(f.connectors.size).toBe(0); expect(f.helpers.size).toBe(0);
  });

  it('withholds complete cleanup while a helper import is still running, then removes the exact completed helper', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common);
    const scoped = { ...common, lti_id: prepared.id }; f.controls.importRunning = true;
    await f.request('lti-setup', scoped);
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: false });
    f.controls.importRunning = false;
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: true });
    expect(f.helpers.size).toBe(0); expect(f.connectors.size).toBe(0);
    expect(f.calls.filter(call => call.method === 'DELETE').every(call => !call.path.includes(f.original.id))).toBe(true);
  });

  it('cannot continue setup or restore launch proof after deletion while a Cloud status response is delayed', async () => {
    const f = await fixture(), connection = await f.connect(), common = await f.permit(connection), prepared = await f.prepare(common);
    const scoped = { ...common, lti_id: prepared.id }, held = deferred<void>(), started = deferred<void>();
    f.controls.holdConnectorList = held; f.controls.connectorListStarted = started;
    const pending = f.request('lti-setup', scoped);
    const settled = pending.then(value => ({ fulfilled: true, value }), error => ({ fulfilled: false, error }));
    await started.promise;
    expect(await f.request('delete', common)).toMatchObject({ deleted: true, permission_revoked: true });
    held.resolve(); const outcome = await settled;
    expect(outcome.fulfilled).toBe(false);
    expect(f.calls.some(call => call.method === 'POST' && call.path.startsWith('/courses/importJobs'))).toBe(false);
    expect(() => f.lti.jwks(String(prepared.id))).toThrow(/connection ended/);
    await expect(f.request('source', { ...common, question: 'Reuse?' })).rejects.toMatchObject({ status: 403 });
    expect(await f.request('lti-disconnect', { ...scoped, grant_id: undefined })).toMatchObject({ removed: true });
    expect(f.connectors.size).toBe(0); expect(f.helpers.size).toBe(0); expect(f.caches().bytes).toBe(0);
  });
});
