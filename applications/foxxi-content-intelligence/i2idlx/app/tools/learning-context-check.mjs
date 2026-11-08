// Meaningful deterministic checks: private transport, identity changes, DTO scope and model boundary.
import assert from 'node:assert/strict';
import { createLearningClient, createLearningLauncher, learningSession, learningSignInUrl, learningResponse, learningLaunch, learningLaunchUrl, learningNavigation, selectedLearningPacket, learningReadiness, learningQuizReview, learningMapSnapshot } from '../src/learning-client.js';
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

const launchNow = Date.parse('2026-11-08T12:00:00.000Z');
const launchResult = (targeted = false) => ({ launch_url: 'https://cloud.scorm.com/api/cloud/registration/launch/12345678-abcd-1234-abcd-123456789abc',
  expires_at: new Date(launchNow + 120_000).toISOString(), destination: { kind: targeted ? 'activity' : 'course', title: 'Safety course' }, tracking: true,
  notice: 'SCORM Cloud tracks this launch normally and controls course resume and version changes.' });
const launchArgs = { link_id: 'own-link', course_id: 'own-course', version: 3 };
function launchFixture(handler = () => response(launchResult())) {
  const calls = []; let who = 'alice', csrf = 0;
  const client = createLearningClient({ origin: () => ORIGIN, now: () => launchNow, fetch: async (path, init) => {
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    return path === '/i2idlx/learning/session' ? response({ ...session(who), csrf: 'fresh-' + ++csrf }) : handler(calls.at(-1));
  } });
  return { client, calls, changeAccount: id => { who = id; } };
}
function popupFixture(client, { blocked = false } = {}) {
  const events = [], opened = { closed: false, opener: 'parent', close() { events.push('close'); this.closed = true; },
    document: { createElement: name => ({ tag: name }), head: { appendChild(element) { events.push({ referrer: element.content }); assert.equal(element.tag, 'meta'); assert.equal(element.name, 'referrer'); } } },
    location: { replace(value) { events.push({ navigate: value }); } } };
  const launcher = createLearningLauncher(client, { open: (url, target) => { events.push({ open: url, target }); return blocked ? null : opened; } });
  return { launcher, events, opened };
}

await test('course launch fetches fresh human CSRF and uses a private same-origin endpoint without AI authority', async () => {
  const { client, calls } = launchFixture(); await client.refresh();
  const result = await client.launch(launchArgs);
  assert.equal(calls.filter(call => call.path === '/i2idlx/learning/session').length, 2);
  const call = calls.at(-1); assert.equal(call.path, '/i2idlx/api/learning/launch'); assert.deepEqual(call.body, launchArgs);
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.headers['X-I2IDLX-Learning-CSRF'], 'fresh-2'); assert(!call.init.headers.Authorization);
  assert.equal(result.destination.kind, 'course'); assert(!JSON.stringify(client.snapshot()).includes('launch_url'));
});

await test('launch refuses arbitrary identities, forged targets and nonnumeric versions before any request', async () => {
  const { client, calls } = launchFixture(); await client.refresh(); const before = calls.length;
  for (const args of [{ ...launchArgs, learner_id: 'victim' }, { ...launchArgs, registration_id: 'victim' }, { ...launchArgs, version: '3' },
    { ...launchArgs, location_ref: 'slide#3' }, { ...launchArgs, launch_url: launchResult().launch_url }]) await assert.rejects(client.launch(args), { code: 'learning_invalid_request' });
  assert.equal(calls.length, before);
});

await test('launch cannot carry an old human course selection across a fresh-account switch', async () => {
  const { client, calls, changeAccount } = launchFixture(); await client.refresh(); changeAccount('bob');
  await assert.rejects(client.launch(launchArgs), { code: 'learning_sign_in_required' });
  assert.equal(client.snapshot().account.id, 'did:example:bob'); assert(!calls.some(call => call.path === '/i2idlx/api/learning/launch'));
});

await test('launch accepts only a short-lived tracked Cloud registration capability and an expected destination', () => {
  assert.equal(learningLaunch(launchResult(), { now: launchNow }).tracking, true);
  assert.equal(learningLaunchUrl('https://cloud.scorm.com/api/cloud/registration/launch/opaque?provider-token=opaque%2Fvalue'), 'https://cloud.scorm.com/api/cloud/registration/launch/opaque?provider-token=opaque%2Fvalue');
  assert.equal(learningLaunch(launchResult(true), { now: launchNow, targeted: true }).destination.kind, 'activity');
  for (const change of [{ tracking: false }, { expires_at: new Date(launchNow - 1).toISOString() }, { expires_at: EXPIRES },
    { destination: { kind: 'activity', title: 'Unexpected target' } }, { launch_url: 'https://cloud.scorm.com/asset/secret' }]) assert.throws(() => learningLaunch({ ...launchResult(), ...change }, { now: launchNow }));
  for (const url of ['http://cloud.scorm.com/api/cloud/registration/launch/1234567812345678',
    'https://cloud.scorm.com.attacker.test/api/cloud/registration/launch/1234567812345678',
    'https://user:pass@cloud.scorm.com/api/cloud/registration/launch/1234567812345678',
    'https://cloud.scorm.com:8443/api/cloud/registration/launch/1234567812345678',
    'https://cloud.scorm.com/api/cloud/registration/launch/', launchResult().launch_url + '#slide',
    'https://cloud.scorm.com/api/cloud/registration/launch/%2e%2e', 'javascript:alert(1)']) assert.throws(() => learningLaunchUrl(url));
});

await test('a blocked popup never mints a launch link', async () => {
  let minted = 0; const { launcher, events } = popupFixture({ launch() { minted++; return Promise.resolve(launchResult()); } }, { blocked: true });
  await assert.rejects(launcher.open(launchArgs), { code: 'learning_popup_blocked' });
  assert.equal(minted, 0); assert.deepEqual(events, [{ open: 'about:blank', target: '_blank' }]);
});

await test('a deliberate launch opens synchronously, hands off once and returns no capability to UI state', async () => {
  const events = []; let release;
  const { launcher, opened, events: popupEvents } = popupFixture({ launch: () => { events.push('mint'); return new Promise(resolve => { release = resolve; }); } });
  const promise = launcher.open(launchArgs);
  assert.deepEqual(popupEvents, [{ open: 'about:blank', target: '_blank' }, { referrer: 'no-referrer' }]); assert.deepEqual(events, ['mint']); assert.equal(opened.opener, null);
  release(launchResult()); const safe = await promise;
  assert(!JSON.stringify(safe).includes('launch_url')); assert(!JSON.stringify(safe).includes('/registration/launch/'));
  assert.equal(popupEvents.at(-1).navigate, launchResult().launch_url);
  launcher.cancel(); assert.equal(opened.closed, false, 'Local cancellation must not close the learner’s already opened course.');
});

await test('authority or course cancellation closes only a pending blank and ignores a late launch response', async () => {
  let release; const { launcher, events, opened } = popupFixture({ launch: () => new Promise(resolve => { release = resolve; }) });
  const pending = launcher.open(launchArgs); launcher.cancel(); release(launchResult());
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(opened.closed, true); assert(!events.some(event => event.navigate));
  let releaseSignal; const next = popupFixture({ launch: () => new Promise(resolve => { releaseSignal = resolve; }) }); const controller = new AbortController();
  const second = next.launcher.open(launchArgs, { signal: controller.signal }); controller.abort(); releaseSignal(launchResult());
  await assert.rejects(second, { code: 'cancelled' }); assert.equal(next.opened.closed, true); assert(!next.events.some(event => event.navigate));
});

await test('launch request failure, closed windows and stale selection never navigate', async () => {
  const failed = popupFixture({ launch: async () => { throw Object.assign(new Error('Denied'), { code: 'learning_enrollment_required' }); } });
  await assert.rejects(failed.launcher.open(launchArgs), { code: 'learning_enrollment_required' }); assert.equal(failed.opened.closed, true);
  let release, current = true; const stale = popupFixture({ launch: () => new Promise(resolve => { release = resolve; }) });
  const pending = stale.launcher.open(launchArgs, { current: () => current }); current = false; release(launchResult());
  await assert.rejects(pending, { code: 'cancelled' }); assert.equal(stale.opened.closed, true); assert(!stale.events.some(event => event.navigate));
  const closed = popupFixture({ launch: async () => { closed.opened.closed = true; return launchResult(); } });
  await assert.rejects(closed.launcher.open(launchArgs), { code: 'learning_popup_closed' }); assert(!closed.events.some(event => event.navigate));
});

await test('navigation accepts only cited published files and opaque verified activity references', () => {
  const citations = [{ id: 'SC1' }], base = { citation_id: 'SC1', source_file: 'lessons/beacon fault.html', precision: 'published-file', target_kind: 'course' };
  const navigation = locations => ({ course: { kind: 'course' }, locations });
  assert.equal(learningNavigation(navigation([base]), citations).locations[0].target_kind, 'course');
  assert.equal(learningNavigation(navigation([{ ...base, target_kind: 'activity', location_ref: 'a'.repeat(64) }]), citations).locations[0].location_ref, 'a'.repeat(64));
  for (const changed of [{ citation_id: 'not-cited' }, { source_file: 'https://cloud.scorm.com/private' }, { source_file: 'data.js#slide' }, { source_file: '../private' },
    { precision: 'slide' }, { target_kind: 'activity', location_ref: 'resource-id' }, { location_ref: 'a'.repeat(64) }]) assert.throws(() => learningNavigation(navigation([{ ...base, ...changed }]), citations));
  assert.throws(() => learningNavigation(navigation([base, base]), citations));
});

await test('targeted launch policy is false by default and requires an explicit owner confirmation', async () => {
  const connector = { id: 'managed', label: 'Provider', status: 'active', policy: { allowAiContent: false, allowAiProgress: false } };
  assert.equal(learningResponse('owned-connectors', { connectors: [connector] }).connectors[0].policy.allowTargetedLaunch, false);
  assert.throws(() => learningResponse('owned-connectors', { connectors: [{ ...connector, policy: { ...connector.policy, allowTargetedLaunch: 'true' } }] }));
  const { client, calls } = fixture(call => response({ connector: { ...connector, policy: { ...connector.policy, allowTargetedLaunch: call.body.allowTargetedLaunch } } }));
  await client.refresh(); const before = calls.length;
  await assert.rejects(client.request('set-targeted-launch-policy', { connector_id: 'managed', allowTargetedLaunch: true, confirmed: false }), { code: 'learning_confirmation_required' });
  assert.equal(calls.length, before);
  const changed = await client.request('set-targeted-launch-policy', { connector_id: 'managed', allowTargetedLaunch: true, confirmed: true });
  assert.equal(changed.connector.policy.allowTargetedLaunch, true);
  assert.deepEqual(calls.at(-1).body, { operation: 'set-targeted-launch-policy', connector_id: 'managed', allowTargetedLaunch: true, confirmed: true });
  assert.throws(() => learningResponse('set-targeted-launch-policy', { connector: { ...connector, policy: { ...connector.policy, allowTargetedLaunch: true } } }, { connector_id: 'other', allowTargetedLaunch: true }));
});

await test('readiness binds the exact enrolled source and distinguishes unavailable content from released result evidence', () => {
  const expected = { link_id: 'own-link', course_id: 'course-a', version: 3 };
  const readiness = { course_id: 'course-a', version: 3, checked_at: EXPIRES,
    enrollment: { status: 'verified', observed_at: EXPIRES }, content: { status: 'unavailable', reason: 'Published text could not be read.' },
    quiz_review: { status: 'not-released', reason: 'No owner release.', count: 0 }, launch: { kind: 'course', reason: 'Course launch only.' },
    learning_map: { status: 'unavailable', objectives: [], prerequisites: [], provider_prerequisites: 'unavailable' },
    retention: { mode: 'virtual', cached_bytes: 0, course_text_retained: false } };
  assert.equal(learningReadiness(readiness, expected).content.status, 'unavailable');
  assert.throws(() => learningReadiness({ ...readiness, course_id: 'other-course' }, expected));
  assert.throws(() => learningReadiness({ ...readiness, quiz_review: { status: 'available', count: 0 } }, expected));
  assert.throws(() => learningReadiness({ ...readiness, retention: { ...readiness.retention, cached_bytes: 12 } }, expected));
  assert.throws(() => learningResponse('course-readiness', { ...expected, link_id: 'other-link', readiness }, expected));
});

await test('released own quiz review requires its separate matching opt-in and actual nonempty records', () => {
  const review = { status: 'available', count: 1, observed_at: EXPIRES, records: [{ citation_id: 'review-one',
    activity_id: 'quiz', interaction_id: 'question-one', question_label: 'Which code should be recorded?', learner_response: 'B',
    learner_response_label: 'GREEN-12', result: 'incorrect', observed_at: EXPIRES,
    locations: [{ id: 'incident', label: 'Incident procedure', source_file: 'incident.html' }] }] };
  assert.equal(learningQuizReview(review).records[0].learner_response, 'B');
  const raw = { source: { provider: 'scorm-cloud', course_id: 'course-a', version: 3, source_version: 'course-version:3' },
    access: { link_id: 'own-link', sharing: { content: false, progress: false, review: true } },
    interventionContext: { source_context: { sections: [] } }, citations: [], missing_context: [],
    authorization_ticket: 'e'.repeat(64), quiz_review: review };
  const expected = { link_id: 'own-link', course: { id: 'course-a', version: 3 }, share_content: false, share_progress: false, share_review: true };
  assert.equal(selectedLearningPacket(raw, expected).quiz_review.records[0].result, 'incorrect');
  assert.throws(() => selectedLearningPacket(raw, { ...expected, share_review: false }));
  assert.throws(() => selectedLearningPacket({ ...raw, quiz_review: undefined }, expected));
  assert.throws(() => learningQuizReview({ ...review, count: 2 }));
  assert.throws(() => learningQuizReview({ ...review, status: 'not-released' }));
  assert.throws(() => learningQuizReview({ ...review, records: [{ ...review.records[0], locations: [{ id: 'bad', label: 'Bad', source_file: 'https://attacker.example/file' }] }] }));
});

await test('owner map snapshots bind source and revision; mutations require an explicit current revision', async () => {
  const expected = { connector_id: 'c'.repeat(32), course_id: 'course-a', version: 3 };
  const map = { schema_version: 1, course_id: 'course-a', version: 3, release_quiz_review: false,
    instructional_locations: [], review_items: [], objectives: [], prerequisites: [] };
  const snapshot = { map, provenance: { kind: 'connector-owner-authored', owner: 'did:example:owner', connector_id: expected.connector_id,
    saved_at: EXPIRES, revision: 'b'.repeat(32), sha256: 'a'.repeat(64) } };
  assert.equal(learningMapSnapshot(snapshot, expected).provenance.kind, 'connector-owner-authored');
  assert.throws(() => learningMapSnapshot(snapshot, { ...expected, course_id: 'another-course' }));
  assert.throws(() => learningMapSnapshot(snapshot, { ...expected, connector_id: 'd'.repeat(32) }));
  assert.throws(() => learningResponse('preview-course-map', { map, valid: false, sha256: 'a'.repeat(64) }, expected));
  const { client, calls } = fixture(); await client.refresh(); const before = calls.length;
  await assert.rejects(client.request('save-course-map', { ...expected, map, confirmed: false, expected_revision: null }), { code: 'learning_confirmation_required' });
  await assert.rejects(client.request('delete-course-map', { ...expected, confirmed: true, expected_revision: 'invented' }), { code: 'learning_confirmation_required' });
  await assert.rejects(client.request('set-review-policy', { connector_id: expected.connector_id, allowAiReview: true, confirmed: false }), { code: 'learning_confirmation_required' });
  assert.equal(calls.length, before);
});

await test('progress notification DTOs expose verified availability without callback secrets and mutations require confirmation', async () => {
  const expected = { link_id: 'own-link', course_id: 'course-a', version: 3 };
  const raw = { ...expected, notifications: { available: true, enabled: true, last_received_at: EXPIRES, notice: 'An authenticated update signal was received.',
    callback_secret: 'PRIVATE-CALLBACK-SECRET', callback_url: 'https://private.example/callback' } };
  const result = learningResponse('progress-notification-status', raw, expected);
  assert.equal(result.notifications.enabled, true); assert.ok(!JSON.stringify(result).includes('PRIVATE-CALLBACK'));
  assert.throws(() => learningResponse('progress-notification-status', raw, { ...expected, course_id: 'another-course' }));
  assert.throws(() => learningResponse('progress-notification-status', { ...raw, notifications: { ...raw.notifications, available: false } }, expected));
  const { client, calls } = fixture(); await client.refresh(); const before = calls.length;
  await assert.rejects(client.request('enable-progress-notifications', { ...expected, confirmed: false }), { code: 'learning_confirmation_required' });
  await assert.rejects(client.request('set-notification-policy', { connector_id: 'c'.repeat(32), allowProgressNotifications: true, confirmed: false }), { code: 'learning_confirmation_required' });
  assert.equal(calls.length, before);
});

process.stdout.write(`PASS ${count} learning account adapter checks\n`);
