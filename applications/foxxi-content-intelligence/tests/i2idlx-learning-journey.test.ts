import { afterEach, describe, expect, it, vi } from 'vitest';
import { LearningAuthError, type LearningPrincipal } from '../src/i2idlx-learning-auth.js';
import { emptyLearningState, LearningConnectionsStore, type LearningPolicy, type LearningSnapshot, type LearningRepository } from '../src/i2idlx-learning-connections.js';
import { LearningLaunchService } from '../src/i2idlx-learning-launch.js';
import { LearningJourneyService, learningMapProjection, readReleasedQuizReview } from '../src/i2idlx-learning-journey.js';
import type { LearningCourseMapInput, LearningCourseMapSnapshot } from '../src/i2idlx-learning-map.js';

type Row = Record<string, unknown>;
const NOW = Date.parse('2026-11-09T16:00:00Z'), BASE = 'https://workbench.example';
const AUTH = 'Basic ' + Buffer.from('dynamic-app:PRIVATE-SECRET').toString('base64');
const row = (value: unknown) => value as Row;
const copy = <T>(value: T): T => structuredClone(value);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const cleanup: Array<() => void> = [];
afterEach(() => { for (const done of cleanup.splice(0)) done(); vi.restoreAllMocks(); });
function human(id: string) {
  const controller = new AbortController();
  const principal: LearningPrincipal = { subject: 'did:web:identity.example:users:' + id, userId: id,
    webId: 'https://identity.example/users/' + id + '/profile#me', podUrl: 'https://pods.example/' + id + '/',
    sessionId: 'human-' + id, expiresAt: NOW + 30 * 60_000, signal: controller.signal };
  return { principal, controller };
}
function gate() {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, pause: async () => { started(); await pending; } };
}
const courseMap = (): LearningCourseMapInput => ({ schema_version: 1, course_id: 'course-a', version: 2, title: 'Owner course map', release_quiz_review: true,
  instructional_locations: [{ id: 'incident-ref', label: 'Incident logging', source_file: 'incident.html', fragment: 'incident-code' },
    { id: 'resume-ref', label: 'Safe resumption', source_file: 'resume.html' }],
  review_items: [
    { activity_id: 'quiz-item', interaction_id: 'beacon-state', question_label: 'Beacon readiness question', response_labels: [{ response: 'A', label: 'STANDBY' }], location_ids: ['resume-ref'] },
    { activity_id: 'quiz-item', interaction_id: 'incident-code', question_label: 'Incident logging question', response_labels: [{ response: 'B', label: 'GREEN-12' }], location_ids: ['incident-ref'] },
    { activity_id: 'quiz-item', interaction_id: 'not-attempted', question_label: 'UNATTEMPTED-QUESTION-LABEL', response_labels: [], location_ids: ['incident-ref'] },
    { activity_id: 'active-quiz', interaction_id: 'active-question', question_label: 'IN-PROGRESS-QUESTION-LABEL', response_labels: [], location_ids: ['incident-ref'] },
  ],
  objectives: [{ id: 'incident-objective', label: 'Log an incident', competency_iris: ['https://competency.example/incident-logging'], location_ids: ['incident-ref'] }],
  prerequisites: [{ course_id: 'orientation-course', label: 'Orientation', relation: 'required' }, { course_id: 'optional-course', label: 'Extra practice', relation: 'recommended' }],
  curriculum: { label: 'Owner proposed pathway', sequence: [{ course_id: 'orientation-course' }, { course_id: 'course-a', version: 2 }] },
});
function reviewTree(): Row {
  const question = (id: string, result: string, response: string) => ({ id, result, learnerResponse: response,
    timestampUtc: '2026-11-09T15:59:00Z', description: 'HIDDEN-DESCRIPTION', correctResponses: ['HIDDEN-KEY'] });
  return { id: 'course-root', activityCompletion: 'COMPLETED', activitySuccess: 'UNKNOWN', runtime: {}, children: [
    { id: 'quiz-item', title: 'Practice quiz', attempts: 1, activityCompletion: 'UNKNOWN', activitySuccess: 'UNKNOWN',
      runtime: { completionStatus: 'failed', suspendData: 'PRIVATE-SUSPEND', lmsComments: ['PRIVATE-COMMENT'], runtimeInteractions: [
        question('incident-code', 'incorrect', 'B'), question('beacon-state', 'correct', 'A'), question('unreleased-question', 'correct', 'A'),
      ] } },
    { id: 'active-quiz', title: 'Active quiz', activityCompletion: 'INCOMPLETE', activitySuccess: 'FAILED', runtime: {
      completionStatus: 'incomplete', runtimeInteractions: [question('active-question', 'incorrect', 'private-active-response')] } },
  ] };
}
async function fixture(options: { policy?: Partial<LearningPolicy>; map?: LearningCourseMapInput | null } = {}) {
  const owner = human('administrator'), student = human('student-a'), other = human('student-b');
  const clock = { value: NOW }, controls = { authMismatch: false, fileError: false, courseStatus: 200, singleSco: false, restart: 'NEVER' };
  const auth = { revalidate: vi.fn(async (principal: LearningPrincipal) => {
    if (principal.signal.aborted || principal.expiresAt <= clock.value) throw new LearningAuthError(401, 'learning_session_expired');
    return controls.authMismatch ? { ...other.principal } : { ...principal };
  }) };
  const original = { id: 'course-a', title: 'Incident response', version: 2 };
  const registrations = new Map<string, Row>([['PRIVATE-REG-A', { id: 'PRIVATE-REG-A', instance: 1,
    learner: { id: 'PRIVATE-LEARNER-A', email: 'private@example.test', firstName: 'PRIVATE-NAME' }, course: original,
    registrationCompletion: 'INCOMPLETE', registrationSuccess: 'UNKNOWN', score: { scaled: 50 } }]]);
  const details = { tree: reviewTree() };
  const manifest = '<manifest identifier="source"><organizations default="org"><organization identifier="org"><title>Incident response</title>' +
    '<item identifier="incident" identifierref="incident-resource"><title>Incident procedure</title></item>' +
    '<item identifier="resume" identifierref="resume-resource"><title>Resume exercise</title></item>' +
    '<item identifier="quiz-item" identifierref="quiz-resource"><title>Practice quiz</title></item>' +
    '</organization></organizations><resources><resource identifier="incident-resource" type="webcontent" href="incident.html"><file href="incident.html"/></resource>' +
    '<resource identifier="resume-resource" type="webcontent" href="resume.html"><file href="resume.html"/></resource>' +
    '<resource identifier="quiz-resource" type="webcontent" href="quiz/answers.html"><file href="quiz/answers.html"/></resource></resources></manifest>';
  const files = new Map<string, Buffer>([['imsmanifest.xml', Buffer.from(manifest)],
    ['incident.html', Buffer.from('<html><head><title>Incident procedure</title></head><body><h1>Incident procedure</h1><p>Record BLUE-27 and notify the Orion desk.</p></body></html>')],
    ['resume.html', Buffer.from('<html><head><title>Resume exercise</title></head><body><h1>Resume exercise</h1><p>Resume only when READY-9 is shown.</p></body></html>')],
    ['quiz/answers.html', Buffer.from('<p>HIDDEN-ASSESSMENT-KEY</p>')]]);
  const calls: Array<{ path: string; method: string }> = [];
  let hook: ((path: string) => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), path = url.pathname.slice('/api/v2'.length) + url.search;
    expect(url.origin).toBe('https://cloud.scorm.com'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('Authorization')).toBe(AUTH); calls.push({ path, method: init.method ?? 'GET' });
    if (hook) await hook(path);
    if (path === '/courses') return json({ courses: [original] });
    if (url.pathname === '/api/v2/registrations') return json({ registrations: [...registrations.values()].filter(r => row(r.learner).id === url.searchParams.get('learnerId')) });
    if (path === '/registrations/PRIVATE-REG-A/configuration') return json({ settingItems: [{ id: 'WhenToRestartRegistration', effectiveValue: controls.restart }] });
    if (url.pathname.startsWith('/api/v2/registrations/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/v2/registrations/'.length)), record = registrations.get(id);
      return record ? json(url.searchParams.get('includeRuntime') === 'true' ? { ...record, activityDetails: details.tree } : record) : json({}, 404);
    }
    if (path === '/courses/course-a/versions/2/asset/list') return json({ files: [...files].map(([path, bytes]) => ({ path, size: bytes.length })) });
    if (path === '/courses/course-a/versions/2') return json({ ...original, rootActivity: { activityType: 'AGGREGATION', children: [
      { activityType: 'SCO', itemIdentifier: 'incident', resourceIdentifier: 'incident-resource', href: 'incident.html', title: 'Incident procedure' },
      ...(!controls.singleSco ? [{ activityType: 'SCO', itemIdentifier: 'resume', resourceIdentifier: 'resume-resource', href: 'resume.html', title: 'Resume exercise' }] : []),
    ] } }, controls.courseStatus);
    if (url.pathname === '/api/v2/courses/course-a/versions/2/asset') {
      if (controls.fileError) throw Error('PRIVATE-SECRET PRIVATE-LEARNER-A private@example.test');
      const bytes = files.get(url.searchParams.get('relativePath')!); return bytes ? new Response(new Uint8Array(bytes)) : json({}, 404);
    }
    throw Error('Unexpected fixture provider operation');
  };
  let snapshot: LearningSnapshot = { revision: null, state: emptyLearningState() }, writes = 0;
  const repository: LearningRepository = { read: async () => copy(snapshot), write: async (expected, state) => {
    if (snapshot.revision !== expected) throw Error('CAS conflict'); snapshot = { revision: 'revision-' + ++writes, state: copy(state) };
  } };
  const connections = new LearningConnectionsStore({ repository, fetch: fetcher, now: () => clock.value });
  const connector = row((await connections.request(owner.principal, { operation: 'create-connector', label: 'Course provider',
    credentials: { app_id: 'dynamic-app', secret: 'PRIVATE-SECRET' }, policy: { allowAiContent: true, allowAiProgress: true,
      allowAiReview: true, allowTargetedLaunch: true, ...options.policy }, intent: 'authorize-enrolled-learners', request_id: 'fixture-create' })).connector);
  const link = row((await connections.request(student.principal, { operation: 'request-link', join_code: connector.join_code })).link);
  await connections.request(owner.principal, { operation: 'approve-link', link_id: link.id, registration_id: 'PRIVATE-REG-A', confirmed: true });
  await connections.request(student.principal, { operation: 'confirm-link', link_id: link.id });
  async function saveMap(map: LearningCourseMapInput) {
    const value = await connections.request(owner.principal, { operation: 'get-course-map', connector_id: connector.id, course_id: original.id, version: original.version });
    const prior = value.course_map as LearningCourseMapSnapshot | null;
    return connections.request(owner.principal, { operation: 'save-course-map', connector_id: connector.id, course_id: original.id,
      version: original.version, map, confirmed: true, expected_revision: prior?.provenance.revision ?? null });
  }
  if (options.map !== null) await saveMap(options.map ?? courseMap());
  const navigation = new LearningLaunchService({ baseUrl: BASE, auth, connections, fetch: fetcher, now: () => clock.value }); cleanup.push(() => navigation.dispose());
  const service = new LearningJourneyService({ auth, connections, navigation, fetch: fetcher, now: () => clock.value });
  const input = (operation = 'course-readiness', extra: Row = {}) => ({ operation, link_id: link.id, course_id: original.id, version: original.version, ...extra });
  const request = (operation = 'course-readiness', extra: Row = {}) => service.request(student.principal, input(operation, extra));
  const access = () => connections.access(student.principal, String(link.id), original.id, original.version, { content: false, progress: false });
  return { owner, student, other, auth, controls, clock, original, registrations, details, files, calls, fetcher, connections, connector, link,
    navigation, service, input, request, access, saveMap, hook(value: typeof hook) { hook = value; },
    revoke: () => connections.request(owner.principal, { operation: 'revoke-link', link_id: link.id }) };
}
async function refuses(work: Promise<unknown>, status: number, code?: string) {
  await expect(work).rejects.toMatchObject({ status, ...(code ? { code } : {}) });
}

describe('learner readiness from actual bounded provider operations', () => {
  it('checks native instructional files and authoritative SCO targets without an AI model or retained course text', async () => {
    const f = await fixture(), start = f.calls.length, result = await f.request(), ready = row(result.readiness);
    expect(result).toMatchObject({ link_id: f.link.id, course_id: f.original.id, version: 2 });
    expect(ready).toMatchObject({ enrollment: { status: 'verified' }, content: { status: 'readable' }, launch: { kind: 'lesson' },
      quiz_review: { status: 'available', count: 2 }, retention: { mode: 'virtual', cached_bytes: 0, course_text_retained: false } });
    const paths = f.calls.slice(start).map(c => c.path);
    expect(paths).toContain('/courses/course-a/versions/2/asset/list');
    expect(paths.some(p => p.includes('relativePath=imsmanifest.xml'))).toBe(true);
    expect(paths.some(p => p.includes('relativePath=incident.html'))).toBe(true);
    expect(paths.some(p => p.includes('quiz%2Fanswers.html'))).toBe(false);
    expect(paths.some(p => /zip|export|agent-sessions|launchLink/.test(p))).toBe(false);
    expect(f.calls.slice(start).every(c => c.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain(AUTH);
    expect(JSON.stringify(result)).not.toMatch(/BLUE-27|Orion|READY-9|HIDDEN|PRIVATE|private@example|did:web|learnerId|registrationId|suspendData|runtimeInteractions/);
  });
  it.each(['single-sco', 'migration', 'metadata-unavailable'])('does not declare lesson launch from capability flags alone: %s', async mode => {
    const f = await fixture();
    if (mode === 'single-sco') f.controls.singleSco = true;
    if (mode === 'migration') f.controls.restart = 'WHEN_NEWER_PACKAGE_VERSION_EXISTS';
    if (mode === 'metadata-unavailable') f.controls.courseStatus = 404;
    const ready = row((await f.request()).readiness);
    expect(ready.content).toMatchObject({ status: 'readable' }); expect(ready.launch).toMatchObject({ kind: 'course' });
  });
  it('keeps source and lesson reading unauthorized when course passage policy is off', async () => {
    const f = await fixture({ policy: { allowAiContent: false } }), start = f.calls.length;
    const ready = row((await f.request()).readiness);
    expect(ready.content).toMatchObject({ status: 'not-authorized' }); expect(ready.launch).toMatchObject({ kind: 'course' });
    expect(f.calls.slice(start).some(c => c.path.includes('/asset'))).toBe(false);
  });
  it('reports benign native-reader failure as unavailable without exposing transport errors or losing enrollment', async () => {
    const f = await fixture(); f.controls.fileError = true;
    const ready = row((await f.request()).readiness);
    expect(ready.content).toMatchObject({ status: 'unavailable' }); expect(ready.enrollment).toMatchObject({ status: 'verified' });
    expect(JSON.stringify(ready)).not.toMatch(/PRIVATE|private@example/);
  });
  it('does not invent source readability when only excluded assessment files are available', async () => {
    const f = await fixture(); f.files.delete('incident.html'); f.files.delete('resume.html');
    expect(row((await f.request()).readiness).content).toMatchObject({ status: 'unavailable' });
  });
  it('keeps owner-authored requirements and curriculum separate from provider or achievement authority', async () => {
    const f = await fixture(), ready = row((await f.request()).readiness), map = row(ready.learning_map);
    expect(map).toMatchObject({ status: 'owner-supplied', provider_prerequisites: 'unavailable', provider_curriculum: 'unavailable',
      prerequisites: [{ relation: 'required', course_id: 'orientation-course' }, { relation: 'recommended', course_id: 'optional-course' }],
      curriculum: { label: 'Owner proposed pathway' }, objectives: [{ competency_iris: ['https://competency.example/incident-logging'] }] });
    expect(map.provenance).toContain('not a provider assertion'); expect(map.notice).toContain('does not grant enrollment');
    expect(JSON.stringify(map)).not.toContain(f.owner.principal.subject);
  });
  it('does not infer prerequisites from manifest ordering when no owner map exists', async () => {
    const f = await fixture({ map: null }), ready = row((await f.request()).readiness);
    expect(ready.learning_map).toEqual({ status: 'unavailable', objectives: [], prerequisites: [], provider_prerequisites: 'unavailable', provider_curriculum: 'unavailable' });
    const access = await f.access(); expect(learningMapProjection(access)).toEqual(ready.learning_map);
  });
});

describe('released own-attempt quiz review', () => {
  it('releases only actually attempted mapped terminal results, exact owner labels and authored source references', async () => {
    const f = await fixture(), value = row((await f.request('quiz-review')).quiz_review);
    expect(value).toMatchObject({ status: 'available', count: 2 });
    const records = value.records as Row[];
    expect(records.map(r => r.interaction_id)).toEqual(['incident-code', 'beacon-state']);
    expect(records[0]).toMatchObject({ question_label: 'Incident logging question', result: 'incorrect', learner_response: 'B',
      learner_response_label: 'GREEN-12', submission: 'terminal-lesson-status', timestamp: '2026-11-09T15:59:00Z',
      locations: [{ id: 'incident-ref', label: 'Incident logging', source_file: 'incident.html', fragment: 'incident-code' }] });
    expect(records.every(r => /^learning-review:[a-f0-9]{40}$/.test(String(r.citation_id)))).toBe(true);
    expect(JSON.stringify(value)).not.toContain(AUTH);
    expect(JSON.stringify(value)).not.toMatch(/HIDDEN|PRIVATE|private@example|did:web|unreleased-question|UNATTEMPTED|IN-PROGRESS|private-active-response|description|correctResponses|suspendData|authorization|registrationId|learnerId/);
  });
  it.each(['policy-off', 'missing-map', 'release-off', 'no-released-items'])('never requests detailed results when %s', async mode => {
    const map = courseMap(); if (mode === 'release-off') map.release_quiz_review = false; if (mode === 'no-released-items') map.review_items = [];
    const f = await fixture({ policy: mode === 'policy-off' ? { allowAiReview: false } : {}, map: mode === 'missing-map' ? null : map });
    const start = f.calls.length, value = row((await f.request('quiz-review')).quiz_review);
    expect(value.status).toBe(mode === 'policy-off' ? 'not-authorized' : 'not-released'); expect(value.records).toEqual([]);
    expect(f.calls.slice(start).some(c => c.path.includes('includeInteractionsAndObjectives'))).toBe(false);
    expect(f.calls.slice(start).some(c => c.path.includes('/asset'))).toBe(false);
  });
  it('requires the exact owner map version even in the internal result helper', async () => {
    const f = await fixture(), access = await f.access(); access.learningMap!.map.version = 3;
    const start = f.calls.length;
    const value = await readReleasedQuizReview(access, 'course-a', 2, 'scope', { fetch: f.fetcher, now: () => NOW }, f.student.principal.signal);
    expect(value.status).toBe('not-released'); expect(f.calls).toHaveLength(start);
  });
  it('passes registration binding only through the private callback, outside the released review DTO', async () => {
    const f = await fixture(), access = await f.access(), seen: Array<{ registrationId: string; instance?: number }> = [];
    const value = await readReleasedQuizReview(access, 'course-a', 2, 'scope', {
      fetch: f.fetcher, now: () => NOW, onBinding: binding => { seen.push(binding); },
    }, f.student.principal.signal);
    expect(seen).toEqual([{ registrationId: 'PRIVATE-REG-A', instance: 1 }]);
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE-REG|registrationId|instance/);
  });
  it('returns no completed results for a mapped in-progress quiz despite completed registration rollup', async () => {
    const f = await fixture(); const raw = f.registrations.get('PRIVATE-REG-A')!; raw.registrationCompletion = 'COMPLETED';
    f.details.tree = { id: 'root', children: [{ id: 'quiz-item', activityCompletion: 'INCOMPLETE', activitySuccess: 'FAILED', runtime: {
      completionStatus: 'incomplete', runtimeInteractions: [{ id: 'incident-code', result: 'incorrect', learnerResponse: 'B' }] } }] };
    expect(row((await f.request('quiz-review')).quiz_review)).toMatchObject({ status: 'no-completed-results', count: 0, records: [] });
  });
  it('preserves numeric provider judgments and repeated observation order without regrading', async () => {
    const f = await fixture(); const quiz = row((f.details.tree.children as Row[])[0]);
    row(quiz.runtime).runtimeInteractions = [{ id: 'incident-code', result: '0.25', learnerResponse: 'B' },
      { id: 'incident-code', result: 'correct', learnerResponse: 'B' }];
    const records = row((await f.request('quiz-review')).quiz_review).records as Row[];
    expect(records.map(r => r.result)).toEqual(['0.25', 'correct']);
    expect(records[0]!.citation_id).not.toBe(records[1]!.citation_id);
    expect(records[0]).not.toHaveProperty('correct'); expect(records[0]).not.toHaveProperty('score');
  });
  it('uses the approved registration among multiple matching registrations rather than list order', async () => {
    const f = await fixture(), original = f.registrations.get('PRIVATE-REG-A')!;
    f.registrations.clear(); f.registrations.set('PRIVATE-REG-NEW', { ...copy(original), id: 'PRIVATE-REG-NEW' }); f.registrations.set('PRIVATE-REG-A', original);
    const start = f.calls.length; expect(row((await f.request('quiz-review')).quiz_review).count).toBe(2);
    const detailed = f.calls.slice(start).filter(c => c.path.includes('includeRuntime'));
    expect(detailed).toHaveLength(1); expect(detailed[0]!.path).toContain('/PRIVATE-REG-A?');
  });
  it('refuses ambiguous current registrations when none matches the approved association', async () => {
    const f = await fixture(), access = await f.access();
    access.associatedRegistrationId = 'another-course-registration'; access.registrations.push({ ...access.registrations[0]!, id: 'another-matching-registration' });
    const start = f.calls.length, value = await readReleasedQuizReview(access, 'course-a', 2, 'scope', { fetch: f.fetcher }, f.student.principal.signal);
    expect(value.status).toBe('unavailable'); expect(f.calls).toHaveLength(start);
  });
});

describe('journey authorization and race boundaries', () => {
  it('requires the linked human, exact course/version and unchanged backing human authority', async () => {
    const f = await fixture(), start = f.calls.length;
    await refuses(f.service.request(f.other.principal, f.input()), 404); expect(f.calls).toHaveLength(start);
    await refuses(f.request('course-readiness', { course_id: 'not-enrolled-course' }), 403);
    await refuses(f.request('course-readiness', { version: 3 }), 403);
    f.controls.authMismatch = true; const before = f.calls.length; await refuses(f.request(), 403, 'learning_access_revoked'); expect(f.calls).toHaveLength(before);
  });
  it('rejects raw caller-selected registration, learner and map release inputs before provider traffic', async () => {
    const f = await fixture(), start = f.calls.length;
    for (const extra of [{ registration_id: 'PRIVATE-REG-A' }, { learner_id: 'PRIVATE-LEARNER-A' }, { release_quiz_review: true }, { map: courseMap() }]) {
      await refuses(f.request('quiz-review', extra), 400);
    }
    expect(f.calls).toHaveLength(start);
  });
  it('fails when link enrollment is revoked while native files are being read', async () => {
    const f = await fixture(); let fired = false;
    f.hook(async path => { if (!fired && path.includes('/asset/list')) { fired = true; await f.revoke(); } });
    await refuses(f.request(), 403);
  });
  it('fails when the owner changes quiz release while readiness is being read', async () => {
    const f = await fixture(); let fired = false;
    f.hook(async path => { if (!fired && path.includes('/asset/list')) { fired = true;
      await f.connections.request(f.owner.principal, { operation: 'set-review-policy', connector_id: f.connector.id, allowAiReview: false, confirmed: true }); } });
    await refuses(f.request(), 403, 'learning_access_revoked');
  });
  it('does not downgrade an explicit navigation authority denial into a benign content-unavailable card', async () => {
    const f = await fixture(); vi.spyOn(f.navigation, 'prepareNavigation').mockRejectedValueOnce(new LearningAuthError(403, 'learning_access_revoked'));
    await refuses(f.request(), 403, 'learning_access_revoked');
  });
  it('does not return reviewed records after the registration is replaced by another enrollment for the same course', async () => {
    const f = await fixture(); let fired = false;
    f.hook(async path => { if (!fired && path.includes('/asset/list')) { fired = true;
      const original = f.registrations.get('PRIVATE-REG-A')!; f.registrations.clear(); f.registrations.set('PRIVATE-REG-NEW', { ...original, id: 'PRIVATE-REG-NEW' }); } });
    await refuses(f.request(), 403, 'learning_access_revoked');
  });
  it('does not return an old submitted review after a new registration instance starts during readiness', async () => {
    const f = await fixture(); let fired = false;
    f.hook(async path => { if (!fired && path.includes('/asset/list')) { fired = true; f.registrations.get('PRIVATE-REG-A')!.instance = 2; } });
    await refuses(f.request(), 403, 'learning_access_revoked');
  });
  it('fails closed if an unavailable instance counter becomes present after review retrieval', async () => {
    const f = await fixture(); delete f.registrations.get('PRIVATE-REG-A')!.instance;
    let fired = false;
    f.hook(async path => { if (!fired && path.includes('/asset/list')) { fired = true; f.registrations.get('PRIVATE-REG-A')!.instance = 1; } });
    await refuses(f.request(), 403, 'learning_access_revoked');
  });
  it('refuses a human-session change that occurs during native retrieval', async () => {
    const f = await fixture(); f.hook(async path => { if (path.includes('/asset/list')) f.controls.authMismatch = true; });
    await refuses(f.request(), 403, 'learning_access_revoked');
  });
  it('does not return private data after sign-out while detail results are outstanding', async () => {
    const f = await fixture(), pending = gate();
    f.hook(async path => { if (path.includes('includeRuntime')) await pending.pause(); });
    const promise = f.request('quiz-review'), assertion = refuses(promise, 499, 'learning_request_cancelled');
    await pending.ready; f.student.controller.abort(); pending.release(); await assertion;
  });
  it('bounds concurrent work per human and releases capacity after a failed operation', async () => {
    const f = await fixture(), pending = gate(); let fired = false;
    vi.spyOn(f.navigation, 'prepareNavigation').mockRejectedValueOnce(new LearningAuthError(403, 'learning_access_revoked'));
    f.hook(async path => { if (!fired && path.includes('/asset/list')) { fired = true; await pending.pause(); } });
    const first = refuses(f.request(), 403, 'learning_access_revoked');
    await pending.ready; await refuses(f.request(), 429, 'learning_busy'); pending.release(); await first;
    f.hook(undefined); expect(row((await f.request()).readiness).enrollment).toMatchObject({ status: 'verified' });
  });
});
