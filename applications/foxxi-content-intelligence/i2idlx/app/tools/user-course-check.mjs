// Deterministic checks of the browser capability adapter; no live credentials or provider calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createAgentSessionClient } from '../src/agent-session.js';

const SESSION = '1'.repeat(32), BROWSER = '2'.repeat(64), INVITE = '3'.repeat(64);
const expires = '2099-01-01T00:00:00.000Z';
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const creation = () => ({ session_id: SESSION, browser_token: BROWSER, invite_token: INVITE, expires_at: expires, invite_expires_at: expires, audience: 'https://workbench.example', action_iri: 'urn:foxxi:i2idlx:agent-session', protocol: { driver: { action: 'urn:foxxi:i2idlx:agent-session', signed_fields: { i2idlx_operation: 'agent-session', bridge_audience: 'https://workbench.example', session_id: SESSION } } } });
function fixture(course) {
  const calls = [];
  const client = createAgentSessionClient({ origin: () => 'https://workbench.example/i2idlx/', fetch: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, init, body });
    if (url.endsWith('/create')) return response(creation());
    if (url.endsWith('/user-courses')) return course(body);
    if (body.operation === 'status') return response({ session_id: SESSION, state: 'connected', driver: { actor: 'did:example:verified-agent' }, expires_at: expires });
    if (body.operation === 'disconnect') return response({ disconnected: true });
    if (body.operation === 'invite') return response({ invite_token: '4'.repeat(64), invite_expires_at: expires });
    if (body.operation === 'request') return response({ turn_id: 'course-turn', state: 'completed', revision: 1, text: 'Paired source answer.' });
    throw new Error('Unexpected fixture request');
  } });
  return { client, calls };
}
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write('PASS ' + name + '\n'); }
async function ready(client) { await client.connect(); await client.refresh(); }

await test('course connection requires an already paired agent and exposes no bearer', async () => {
  const { client, calls } = fixture(() => response({ connected: false }));
  await assert.rejects(client.requestUserCourses({ operation: 'status' }), { code: 'not_granted' });
  assert.equal(calls.length, 0);
  await client.connect();
  await assert.rejects(client.requestUserCourses({ operation: 'status' }), { code: 'not_granted' });
  await client.refresh();
  assert.equal(client.status().connectionId, SESSION);
  assert(!JSON.stringify(client.status()).includes(BROWSER));
  assert.deepEqual(await client.requestUserCourses({ operation: 'status', session_id: 'attacker' }), { connected: false });
  const call = calls.at(-1);
  assert.equal(call.url, '/i2idlx/api/user-courses');
  assert.equal(call.init.headers.Authorization, 'Bearer ' + BROWSER);
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.cache, 'no-store');
  assert.equal(call.body.session_id, SESSION);
  assert(!call.url.includes(BROWSER));
});

await test('course expiry leaves the paired AI available while session expiry closes it', async () => {
  let code = 'course_connection_expired';
  const { client } = fixture(() => response({ code, error: 'Reconnect your course source.' }, 410));
  await ready(client);
  await assert.rejects(client.requestUserCourses({ operation: 'source' }), { code });
  assert.equal(client.status().state, 'connected');
  assert.equal(typeof client.getSample(), 'function');
  code = 'session_expired';
  await assert.rejects(client.requestUserCourses({ operation: 'status' }), { code });
  assert.equal(client.status().state, 'expired');
  assert.equal(client.getSample(), null);
});

await test('disconnect invalidates an in-flight course response and prevents reuse', async () => {
  let resolve;
  const { client } = fixture(() => new Promise(done => { resolve = done; }));
  await ready(client);
  const pending = client.requestUserCourses({ operation: 'courses' });
  await client.disconnect();
  resolve(response({ courses: [{ id: 'old-account-course' }] }));
  await assert.rejects(pending, { code: 'cancelled' });
  await assert.rejects(client.requestUserCourses({ operation: 'courses' }), { code: 'not_granted' });
  assert.equal(client.status().connectionId, null);
});

await test('an aborted source request cannot supply context to the next question', async () => {
  const { client } = fixture(() => response({ source: 'stale' }));
  await ready(client);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.requestUserCourses({ operation: 'source' }, controller.signal), { code: 'cancelled' });
});

await test('private source sampler is pinned to the original invitation and refuses renewed recipients', async () => {
  const { client, calls } = fixture(() => response({}));
  assert.equal(client.getUserCourseSample(), null);
  await ready(client);
  const original = client.getUserCourseSample();
  const samePair = client.getUserCourseSample();
  assert.notEqual(original, samePair);
  assert.equal(original.contextKey, samePair.contextKey);
  assert.equal(original.allowTeamNotes, false);
  assert.equal(original.modelTiers, false);
  assert.equal((await original('Private instructional reference.')).text, 'Paired source answer.');
  const before = calls.length;
  await client.renewInvitation();
  assert.equal(client.getUserCourseSample(), null);
  await client.refresh();
  await assert.rejects(original.limits(), { code: 'cancelled' });
  await assert.rejects(original('Passages approved for the prior pairing.'), { code: 'cancelled' });
  assert.equal(calls.slice(before).filter(call => call.body.operation === 'request').length, 0);
  const renewed = client.getUserCourseSample();
  assert.notEqual(original.contextKey, renewed.contextKey);
  await client.disconnect();
  await ready(client);
  await assert.rejects(renewed('Passages approved before replacement.'), { code: 'cancelled' });
});

await test('selected course packets require exact source identity and both digest strings', async () => {
  const source = await readFile(new URL('../src/course-context.jsx', import.meta.url), 'utf8');
  const validation = source.slice(source.indexOf('const object ='), source.indexOf('export function useCourseContext'))
    .replace('export function selectedCoursePacket', 'function selectedCoursePacket');
  const validate = runInNewContext(validation + '\nselectedCoursePacket;', {});
  const course = { id: 'course-a', version: 3 };
  const packet = { connection_id: 'my-connection', source: { provider: 'scorm-cloud', course_id: course.id, version: course.version,
    package_sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64) }, citations: [], interventionContext: {} };
  assert.equal(validate(packet, 'my-connection', course), packet);
  for (const field of ['content_sha256', 'package_sha256']) {
    for (const invalid of [undefined, null, '', 'bad', ['a'.repeat(64)], 123]) {
      assert.throws(() => validate({ ...packet, source: { ...packet.source, [field]: invalid } }, 'my-connection', course), /does not match/);
    }
  }
  for (const change of [{ course_id: 'another-course' }, { version: 4 }, { provider: 'another-provider' }]) {
    assert.throws(() => validate({ ...packet, source: { ...packet.source, ...change } }, 'my-connection', course), /does not match/);
  }
  assert.throws(() => validate(packet, 'another-connection', course), /does not match/);
});

await test('virtual source packets bind the advertised provider, string version and exact permission without a package export', async () => {
  const source = await readFile(new URL('../src/course-context.jsx', import.meta.url), 'utf8');
  const validation = source.slice(source.indexOf('const object ='), source.indexOf('export function useCourseContext'))
    .replace('export function selectedCoursePacket', 'function selectedCoursePacket');
  const validate = runInNewContext(validation + '\nselectedCoursePacket;', {});
  const course = { id: 'external-course', version: 'revision-23' };
  const grant = { id: 'owner-approved-virtual', mode: 'virtual', expires_at: expires };
  const packet = { connection_id: 'source-connection', source: { provider: 'source-service', course_id: course.id,
    version: course.version, content_sha256: 'c'.repeat(64) }, access: { mode: 'virtual', permission: grant },
    citations: [], interventionContext: {} };
  assert.equal(validate(packet, 'source-connection', course, grant, 'source-service'), packet);
  assert.throws(() => validate(packet, 'source-connection', course, grant), /does not match/);
  assert.throws(() => validate(packet, 'source-connection', course, { ...grant, id: 'different-permission' }, 'source-service'), /does not match/);
  for (const access of [undefined, {}, { mode: 'cached', permission: grant }, { mode: 'virtual', permission: { ...grant, mode: 'cached' } }]) {
    assert.throws(() => validate({ ...packet, access }, 'source-connection', course, grant, 'source-service'), /does not match/);
  }
  assert.throws(() => validate({ ...packet, source: { ...packet.source, package_sha256: 'f'.repeat(64) } }, 'source-connection', course, grant, 'source-service'), /does not match/);
  assert.throws(() => validate({ ...packet, source: { ...packet.source, version: 23 } }, 'source-connection', course, grant, 'source-service'), /does not match/);
  assert.throws(() => validate({ ...packet, source: { ...packet.source, content_sha256: null } }, 'source-connection', course, grant, 'source-service'), /does not match/);
});

await test('Cloud virtual packets identify selected projections separately from stable course versions', async () => {
  const source = await readFile(new URL('../src/course-context.jsx', import.meta.url), 'utf8');
  const validation = source.slice(source.indexOf('const object ='), source.indexOf('export function useCourseContext'))
    .replace('export function selectedCoursePacket', 'function selectedCoursePacket');
  const { validate, identity, details } = runInNewContext(validation + '\n({validate:selectedCoursePacket,identity:sourceIdentity,details:modeDetails});', {});
  const course = { id: 'native-cloud-course', version: 3 }, grant = { id: 'native-owner-grant', mode: 'virtual', expires_at: expires };
  const packet = { connection_id: 'cloud-connection', source: { provider: 'scorm-cloud', course_id: course.id, version: course.version,
    source_version: 'course-version:3', projection_sha256: 'd'.repeat(64), fingerprint_scope: 'selected-instructional-projection' },
    access: { mode: 'virtual', permission: grant }, citations: [], interventionContext: {} };
  assert.equal(validate(packet, 'cloud-connection', course, grant), packet);
  for (const change of [{ source_version: undefined }, { projection_sha256: undefined }, { projection_sha256: 'bad' },
    { fingerprint_scope: 'whole-course' }, { package_sha256: 'e'.repeat(64) }, { content_sha256: 'f'.repeat(64) }]) {
    assert.throws(() => validate({ ...packet, source: { ...packet.source, ...change } }, 'cloud-connection', course, grant), /does not match/);
  }
  assert.equal(identity(packet.source), identity({ ...packet.source, projection_sha256: 'e'.repeat(64) }));
  assert.notEqual(identity(packet.source), identity({ ...packet.source, source_version: 'course-version:4' }));
  assert.equal(details('virtual', 'scorm-cloud').label, 'Read selected source files (virtual)');
  assert.match(details('virtual', 'scorm-cloud').description, /SCORM Cloud does not perform the question search/);
  assert.equal(details('virtual', 'source-service').label, 'Query at source (virtual)');
});

await test('LTI controls retain only safe setup metadata and accept a Cloud launch only for navigation', async () => {
  const source = await readFile(new URL('../src/course-context.jsx', import.meta.url), 'utf8');
  const validation = source.slice(source.indexOf('const object ='), source.indexOf('export function useCourseContext'))
    .replace('export function selectedCoursePacket', 'function selectedCoursePacket');
  const { view, launch } = runInNewContext(validation + '\n({view:ltiView,launch:cloudLaunchUrl});', { URL });
  const raw = { id: 'lti-setup-one', state: 'verified', expires_at: expires, connector_id: 'connector-one', helper_course_id: 'helper-one',
    launch_url: 'PRIVATE-CLOUD-LAUNCH-CAPABILITY', secret: 'PRIVATE-SECRET',
    tool: { login_url: 'https://workbench.example/lti/login', launch_url: 'https://workbench.example/lti/launch', jwks_url: 'https://workbench.example/lti/jwks', public_key_pem: 'PUBLIC-KEY' },
    launch: { issuer: 'https://cloud.scorm.com/platform', client_id: 'client-one', deployment_id: 'deployment-one', subject: 'platform-account-one',
      context_id: 'placement-context', resource_link_id: 'resource-one', verified_at: expires, course_id: 'native-cloud-course', version: 3,
      id_token: 'PRIVATE-LTI-TOKEN', browser_token: BROWSER } };
  const safe = view(raw, 'lti-setup-one');
  assert.equal(safe.launch.subject, 'platform-account-one');
  assert(!JSON.stringify(safe).includes('PRIVATE-'));
  assert(!JSON.stringify(safe).includes(BROWSER));
  assert.throws(() => view(raw, 'another-setup'), /did not match/);
  assert.throws(() => view({ ...raw, state: 'asserted-by-browser' }), /did not match/);
  assert.throws(() => view(raw, 'lti-setup-one', { id: 'another-course', version: 3 }), /selected course/);
  assert.throws(() => view(raw, 'lti-setup-one', { id: 'native-cloud-course', version: 4 }), /selected course/);
  assert.throws(() => view({ ...raw, tool: { ...raw.tool, launch_url: 'https://workbench.example/lti/launch?private_capability=secret' } }), /invalid endpoint/);
  assert.equal(view({ id: 'cleanup-one', state: 'cleanup-failed', connector_id: 'created-one', note: 'Retry removal.' }).state, 'cleanup-failed');
  assert.equal(launch('https://app.cloud.scorm.com/preview?short_lived=synthetic'), 'https://app.cloud.scorm.com/preview?short_lived=synthetic');
  for (const url of ['http://cloud.scorm.com/preview', 'https://cloud.scorm.com.evil.example/preview', 'https://evilcloud.scorm.com/preview',
    'https://user:password@app.cloud.scorm.com/preview', 'https://app.cloud.scorm.com:8443/preview', 'javascript:alert(1)']) assert.throws(() => launch(url), /launch link/);
});

await test('deletion messages distinguish local removal from pending, failed and provider-reported remote completion', async () => {
  const source = await readFile(new URL('../src/course-context.jsx', import.meta.url), 'utf8');
  const validation = source.slice(source.indexOf('const object ='), source.indexOf('export function useCourseContext'))
    .replace('export function selectedCoursePacket', 'function selectedCoursePacket');
  const message = runInNewContext(validation + '\ndeletionMessage;', {});
  const deleted = { deleted: true, permission_revoked: true };
  assert.match(message({ ...deleted, remote_deletion: { status: 'submitting' } }), /no receipt has been confirmed/);
  assert.match(message({ ...deleted, remote_deletion: { status: 'pending' } }), /completion is pending/);
  assert.match(message({ ...deleted, remote_deletion: { status: 'completed' } }), /source service reports/);
  assert.match(message({ ...deleted, remote_deletion: { status: 'failed' } }), /did not confirm/);
  assert.match(message({ ...deleted, remote_deletion: { status: 'unsupported' } }), /only this session/);
  assert.match(message({ deleted: false, remote_deletion: { status: 'completed' } }), /not confirmed/);
  assert.match(message(deleted), /outside this deletion/);
  const recover = runInNewContext(validation + '\nrecoveredDeletion;', {});
  const course = { id: 'course-a', version: 'revision-23' };
  const status = { connection_id: 'own-connection', course_id: course.id, version: course.version,
    deletion: { ...deleted, grant_id: 'a'.repeat(48), remote_deletion: { status: 'pending', request_id: 'actual-source-receipt' } } };
  const recovered = recover(status, 'own-connection', course);
  assert.equal(recovered.target.grant_id, 'a'.repeat(48));
  assert.equal(recovered.result.remote_deletion.request_id, 'actual-source-receipt');
  assert.equal(recover(status, 'another-connection', course), null);
  assert.equal(recover(status, 'own-connection', { ...course, id: 'another-course' }), null);
  assert.equal(recover(status, 'own-connection', { ...course, version: 23 }), null);
  assert.equal(recover({ ...status, deletion: { ...status.deletion, grant_id: 'not-an-issued-handle' } }, 'own-connection', course), null);
});

process.stdout.write('PASS ' + count + ' user course adapter checks\n');
