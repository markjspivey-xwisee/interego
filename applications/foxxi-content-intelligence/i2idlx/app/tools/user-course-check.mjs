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
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }
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

console.log('PASS ' + count + ' user course adapter checks');
