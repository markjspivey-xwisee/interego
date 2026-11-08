// Meaningful deterministic checks: private transport, identity changes, DTO scope and model boundary.
import assert from 'node:assert/strict';
import { createLearningClient, learningSession, learningSignInUrl, learningResponse, selectedLearningPacket } from '../src/learning-client.js';
import { createAgentSessionClient } from '../src/agent-session.js';

const ORIGIN = 'https://workbench.example', EXPIRES = '2099-01-01T00:00:00.000Z';
const account = id => ({ id: 'did:example:' + id, userId: id, webId: 'https://identity.example/' + id });
const session = (id = 'alice') => ({ enabled: true, authenticated: true, account: account(id), csrf: 'csrf-private-' + id, expires_at: EXPIRES, sign_in_url: '/i2idlx/learning/oauth/start' });
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
function fixture(handler = () => response({ links: [] })) {
  const calls = []; let who = 'alice';
  const client = createLearningClient({ origin: () => ORIGIN, fetch: async (path, init) => {
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    if (path === '/i2idlx/learning/session') return response(session(who));
    if (path === '/i2idlx/learning/sign-out') return response({ signed_out: true });
    return handler(calls.at(-1));
  } });
  return { client, calls, changeAccount: id => { who = id; } };
}
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write('PASS ' + name + '\n'); }

await test('learning sign-in accepts only the ordinary same-origin fixed OAuth route', () => {
  assert.equal(learningSignInUrl('/i2idlx/learning/oauth/start', ORIGIN), ORIGIN + '/i2idlx/learning/oauth/start');
  for (const bad of ['https://attacker.example/i2idlx/learning/oauth/start', '/wallet', 'javascript:alert(1)', '/i2idlx/learning/oauth/start#token', 'https://x:y@workbench.example/i2idlx/learning/oauth/start']) assert.throws(() => learningSignInUrl(bad, ORIGIN));
  assert.throws(() => learningSession({ ...session(), account: { id: 'forged' } }, ORIGIN));
});

await test('learning controls use same-origin cookies and CSRF without exposing a bearer or CSRF in public session state', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.request('my-links'), { code: 'learning_sign_in_required' });
  assert.equal(calls.length, 0);
  await client.refresh(); await client.request('my-links');
  assert(!JSON.stringify(client.snapshot()).includes('csrf-private'));
  for (const call of calls) { assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.redirect, 'error'); assert(!call.init.headers.Authorization); assert(!call.path.includes('csrf-private')); }
  assert.equal(calls.at(-1).init.headers['X-I2IDLX-Learning-CSRF'], 'csrf-private-alice');
  assert.deepEqual(calls.at(-1).body, { operation: 'my-links' });
});

await test('a control cannot select an arbitrary learner, smuggle credentials or omit explicit administrative confirmation', async () => {
  const { client, calls } = fixture(); await client.refresh();
  const before = calls.length;
  await assert.rejects(client.request('courses', { link_id: 'own-link', learner_id: 'victim' }), { code: 'learning_invalid_request' });
  await assert.rejects(client.request('approve-link', { link_id: 'pending', registration_id: 'actual-registration', confirmed: false }), { code: 'learning_confirmation_required' });
  await assert.rejects(client.request('progress', { link_id: 'own-link', course_id: 'course' }), { code: 'learning_invalid_request' });
  await assert.rejects(client.request('create-connector', { label: 'Admin', credentials: { app_id: 'app', secret: 'secret' }, policy: { allowAiContent: true }, intent: 'authorize-enrolled-learners', request_id: 'unique' }), { code: 'learning_invalid_request' });
  assert.equal(calls.length, before);
});

await test('signing out invalidates a response already in flight and clears the account before server sign-out', async () => {
  let release; const { client, calls } = fixture(() => new Promise(resolve => { release = resolve; }));
  await client.refresh(); const pending = client.request('my-links');
  await client.signOut(); release(response({ links: [] }));
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(client.snapshot(), null);
  const call = calls.at(-1); assert.equal(call.path, '/i2idlx/learning/sign-out'); assert.equal(call.init.headers['X-I2IDLX-Learning-CSRF'], 'csrf-private-alice');
});

await test('refreshing as another account cannot apply an old account response', async () => {
  let release; const { client, changeAccount } = fixture(() => new Promise(resolve => { release = resolve; }));
  await client.refresh(); const pending = client.request('my-links'); changeAccount('bob'); await client.refresh();
  release(response({ links: [] })); await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(client.snapshot().account.id, 'did:example:bob');
});

await test('caller cancellation and authentication loss cannot return private DTOs', async () => {
  const { client } = fixture(() => response({ error: 'provider-secret-must-not-be-reflected' }, 401));
  await client.refresh(); const controller = new AbortController(); controller.abort();
  await assert.rejects(client.request('my-links', {}, controller.signal), { code: 'cancelled' });
  await assert.rejects(client.request('my-links'), error => error.code === 'learning_sign_in_required' && !error.message.includes('provider-secret'));
  assert.equal(client.snapshot(), null);
});

await test('Cloud credential refusal does not masquerade as human sign-out, while refused CSRF clears the account', async () => {
  let code = 'learning_provider_authentication_failed';
  const { client } = fixture(() => response({ error: code }, code === 'learning_csrf_refused' ? 403 : 401));
  await client.refresh();
  await assert.rejects(client.request('my-links'), { code: 'learning_provider_authentication_failed', status: 401 });
  assert.equal(client.snapshot().account.id, 'did:example:alice');
  code = 'learning_csrf_refused';
  await assert.rejects(client.request('my-links'), { code: 'learning_sign_in_required' });
  assert.equal(client.snapshot(), null);
});

await test('an expired human sign-in is refused locally without sending another private request', async () => {
  let now = Date.parse('2098-01-01'); const calls = [];
  const client = createLearningClient({ origin: () => ORIGIN, now: () => now, fetch: async (path, init) => { calls.push(path); return response(session()); } });
  await client.refresh(); now = Date.parse(EXPIRES);
  await assert.rejects(client.request('my-links'), { code: 'learning_sign_in_required' });
  assert.equal(calls.length, 1); assert.equal(client.snapshot(), null);
});

await test('public connector and pending-link DTOs discard provider secrets and never accept a roster as account proof', () => {
  const value = learningResponse('owned-connectors', { connectors: [{ id: 'owned', label: 'Provider', status: 'active', policy: { allowAiContent: false, allowAiProgress: false }, credentials: { secret: 'PRIVATE' }, roster: ['victim'] }] });
  assert(!JSON.stringify(value).includes('PRIVATE')); assert(!JSON.stringify(value).includes('victim'));
  assert.throws(() => learningResponse('pending-links', { links: [{ id: 'pending', email: 'guessed@example.test', status: 'pending-admin' }] }));
  assert.throws(() => learningResponse('confirm-link', { link: { id: 'other', connector_id: 'c', provider_label: 'Provider', status: 'active' } }, { link_id: 'own' }));
});

await test('courses and progress require the exact link, course and version; scores use the Cloud 0–100 scale', () => {
  const record = { course_id: 'course', version: 2, source: 'SCORM Cloud', completion: 'COMPLETED', success: 'PASSED', score: 73, total_seconds: 90, observed_at: EXPIRES };
  const expected = { link_id: 'own', course_id: 'course', version: 2 };
  const value = learningResponse('progress', { link_id: 'own', records: [record], as_of: EXPIRES }, expected);
  assert.equal(value.records[0].score, 73); assert(!Object.hasOwn(value.records[0], 'updated_at'));
  for (const change of [{ score: 101 }, { score: -1 }, { version: 3 }, { course_id: 'other' }, { observed_at: 'unknown' }]) assert.throws(() => learningResponse('progress', { link_id: 'own', records: [{ ...record, ...change }], as_of: EXPIRES }, expected));
  assert.throws(() => learningResponse('courses', { link_id: 'other', courses: [] }, { link_id: 'own' }));
  assert.deepEqual(learningResponse('courses', { link_id: 'own', courses: [{ id: 'course', title: 'Enrolled', version: 2 }], prerequisites: { status: 'unavailable' }, curriculum: { status: 'unavailable' } }, { link_id: 'own' }).courses, [{ id: 'course', title: 'Enrolled', version: 2 }]);
});

await test('learning context requires explicit matching sharing and sends its authorization ticket outside model context', () => {
  const expected = { link_id: 'own', course: { id: 'course', version: 2 }, share_content: true, share_progress: false };
  const raw = { source: { provider: 'scorm-cloud', course_id: 'course', version: 2, source_version: 'course-version:2' }, access: { link_id: 'own', sharing: { content: true, progress: false } }, interventionContext: { source_context: { sections: [{ id: 'SC1', body: 'Public instructional evidence' }] } }, citations: [{ id: 'SC1', title: 'Evidence' }], missing_context: [], authorization_ticket: 'e'.repeat(64) };
  const value = selectedLearningPacket(raw, expected);
  assert.equal(value.authorization_ticket, 'e'.repeat(64)); assert(!JSON.stringify(value.interventionContext).includes('e'.repeat(64)));
  assert.throws(() => selectedLearningPacket({ ...raw, source: { ...raw.source, course_id: 'other' } }, expected));
  assert.throws(() => selectedLearningPacket({ ...raw, access: { ...raw.access, sharing: { content: true, progress: true } } }, expected));
  assert.throws(() => selectedLearningPacket({ ...raw, interventionContext: { leaked: 'e'.repeat(64) } }, expected));
  assert.throws(() => selectedLearningPacket(raw, { ...expected, share_content: false }));
  for (const authorization_ticket of [undefined, '', 'forged', 'e'.repeat(63)]) assert.throws(() => selectedLearningPacket({ ...raw, authorization_ticket }, expected));
});

await test('paired learning source uses the human cookie and CSRF while model tickets remain transport-only', async () => {
  const calls = [], browserToken = 'b'.repeat(64), sessionId = 'a'.repeat(32), ticket = 'c'.repeat(64);
  let polls = 0, signedIn = true;
  const client = createAgentSessionClient({ origin: () => ORIGIN, pollMs: 0, wait: async () => {}, fetch: async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, init, body });
    if (url.endsWith('/create')) return response({ session_id: sessionId, browser_token: browserToken, invite_token: 'd'.repeat(64), expires_at: EXPIRES, invite_expires_at: EXPIRES,
      audience: ORIGIN, action_iri: 'urn:foxxi:i2idlx:agent-session', protocol: { driver: { signed_fields: { session_id: sessionId, bridge_audience: ORIGIN, i2idlx_operation: 'agent-session' } } } });
    if (url === '/i2idlx/learning/session') return response(signedIn ? session() : { enabled: true, authenticated: false });
    if (url === '/i2idlx/api/learning/context') return response({ authorization_ticket: ticket });
    if (body?.operation === 'status') return response({ state: 'connected', expires_at: EXPIRES, driver: { actor: 'did:example:paired' } });
    if (body?.operation === 'request') return response({ turn_id: 'private-turn', revision: 0, state: 'running', text: 'A private partial.' });
    if (body?.operation === 'poll') { polls++; return response({ turn_id: 'private-turn', revision: 1, state: 'failed', text: '', error_code: 'learning_access_revoked' }); }
    if (body?.operation === 'cancel' || body?.operation === 'disconnect') return response({});
    throw Error('Unexpected fixture route');
  } });
  await client.connect(); await client.refresh();
  await client.requestLearningContext({ link_id: 'link', session_id: 'forged' });
  const source = calls.find(call => call.url === '/i2idlx/api/learning/context');
  assert.equal(source.init.credentials, 'same-origin'); assert.equal(source.init.headers['X-I2IDLX-Learning-CSRF'], 'csrf-private-alice');
  assert.equal(source.init.headers.Authorization, 'Bearer ' + browserToken); assert.equal(source.body.session_id, sessionId);
  assert(!source.url.includes(browserToken)); assert(!JSON.stringify(source.body).includes('csrf-private-alice'));
  const streamed = [], messages = [{ role: 'user', content: 'Authorized learning context.' }];
  await assert.rejects(client.getUserCourseSample()(messages, { learningAuthorization: ticket, onText: value => streamed.push(value.text) }), { code: 'learning_access_revoked' });
  const task = calls.find(call => call.body?.operation === 'request');
  assert.equal(task.body.learning_authorization, ticket); assert(!JSON.stringify(task.body.messages).includes(ticket));
  assert.equal(streamed.at(-1), ''); assert.equal(polls, 1); assert.equal(client.status().state, 'connected');
  signedIn = false; const before = calls.filter(call => call.url === '/i2idlx/api/learning/context').length;
  await assert.rejects(client.requestLearningContext({ link_id: 'link' }), { code: 'learning_sign_in_required' });
  assert.equal(calls.filter(call => call.url === '/i2idlx/api/learning/context').length, before);
  await client.disconnect();
});

process.stdout.write(`PASS ${count} learning account adapter checks\n`);
