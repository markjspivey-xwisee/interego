import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEARNING_PROVIDER_LIMITS, LEARNING_REVIEW_LIMITS, ScormCloudLearningProvider } from '../src/i2idlx-learning-provider.js';

type Row = Record<string, unknown>;
const NOW = Date.parse('2026-11-09T15:00:00Z'), AUTH = 'Basic PRIVATE-CREDENTIAL';
const registration = () => ({ id: 'reg /?#&', instance: 2, learner: { id: 'learner-A', email: 'PRIVATE@example.test' },
  course: { id: 'course-A', title: 'Course A', version: 3 }, registrationCompletion: 'COMPLETED', registrationSuccess: 'FAILED', score: { scaled: 50 } });
const interaction = (id = 'question-one', extra: Row = {}) => ({ id, result: 'incorrect', learnerResponse: 'My submitted response',
  timestampUtc: '2026-11-09T14:59:00Z', description: 'PRIVATE unreleased question prompt', correctResponses: ['PRIVATE-ANSWER-KEY'],
  extension: { private: 'PRIVATE-NESTED-SECRET' }, ...extra });
const activity = (id = 'quiz-item', extra: Row = {}) => ({ id, title: 'Completed quiz', attempts: 2,
  activityCompletion: 'COMPLETED', activitySuccess: 'FAILED', runtime: { completionStatus: 'completed',
    runtimeInteractions: [interaction()], suspendData: 'PRIVATE-SUSPEND-DATA', lmsComments: ['PRIVATE-COMMENT'] }, children: [], ...extra });
const detail = (activityDetails: Row = activity()) => ({ ...registration(), activityDetails, custom: 'PRIVATE-CUSTOM' });
const json = (value: unknown, status = 200) => Response.json(value, { status });
function fixture(responses: Response[] | ((path: string, init: RequestInit) => Response | Promise<Response>)) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://cloud.scorm.com'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('Authorization')).toBe(AUTH);
    const path = url.pathname.slice('/api/v2'.length) + url.search; calls.push({ path, init });
    if (typeof responses === 'function') return responses(path, init);
    const value = responses.shift(); if (!value) throw Error('Unexpected provider fixture read'); return value;
  };
  const provider = new ScormCloudLearningProvider({ authorization: AUTH, fetch: fetcher, now: () => NOW });
  return { provider, calls, read: (signal?: AbortSignal) => provider.readOwnReview('learner-A', 'course-A', 3, 'reg /?#&', signal) };
}
async function refuses(work: Promise<unknown>, status = 502, code = 'learning_provider_invalid') {
  await expect(work).rejects.toMatchObject({ status, code });
}
afterEach(() => { vi.restoreAllMocks(); });

describe('explicit completed Cloud activity review', () => {
  it('reads the exact registration summary before bounded detail and projects no keys, prompts or raw runtime', async () => {
    const f = fixture([json(registration()), json(detail())]), value = await f.read();
    expect(f.calls.map(c => c.path)).toEqual(['/registrations/reg%20%2F%3F%23%26',
      '/registrations/reg%20%2F%3F%23%26?includeChildResults=true&includeInteractionsAndObjectives=true&includeRuntime=true']);
    expect(f.calls.every(c => c.init.method === 'GET')).toBe(true);
    expect(value).toEqual({ registrationId: 'reg /?#&', learnerId: 'learner-A', course: { id: 'course-A', title: 'Course A', version: 3 },
      instance: 2, observedAt: new Date(NOW).toISOString(), omittedInProgressActivities: 0,
      activities: [{ id: 'quiz-item', title: 'Completed quiz', attempts: 2, completion: 'COMPLETED', success: 'FAILED', submission: 'completed',
        interactions: [{ id: 'question-one', result: 'incorrect', learnerResponse: 'My submitted response', timestamp: '2026-11-09T14:59:00Z' }] }] });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|correctResponses|description|runtime|suspendData|lmsComments|custom/);
  });
  it('keeps summary projection restricted while retaining the private current instance for revalidation', async () => {
    const f = fixture([json(detail())]), value = await f.provider.getRegistration('reg /?#&');
    expect(value.progress).toEqual({ completion: 'COMPLETED', success: 'FAILED', score: { scaled: 50 } });
    expect(value).not.toHaveProperty('activities'); expect(value.instance).toBe(2);
    expect(JSON.stringify(value)).not.toMatch(/My submitted|PRIVATE|question-one|runtime|correctResponses/);
    expect(f.calls[0]!.path).not.toContain('?');
    expect(f.provider.capabilities).toEqual({ enrollments: true, progress: true, prerequisites: false, curriculum: false,
      registrationLaunch: true, access: 'registration-read-and-explicit-launch' });
  });
  it.each(['id', 'learner', 'course', 'version'])('rejects a different summary %s before requesting any detailed interactions', async field => {
    const summary: Row = registration();
    if (field === 'id') summary.id = 'another-registration';
    if (field === 'learner') summary.learner = { id: 'another-person' };
    if (field === 'course') summary.course = { id: 'another-course', title: 'Other', version: 3 };
    if (field === 'version') summary.course = { id: 'course-A', title: 'Course A', version: 4 };
    const f = fixture([json(summary)]); await refuses(f.read(), 403, 'learning_enrollment_required'); expect(f.calls).toHaveLength(1);
  });
  it.each(['id', 'learner', 'course', 'version'])('rejects changed detail %s without returning partial review', async field => {
    const changed: Row = detail();
    if (field === 'id') changed.id = 'another-registration';
    if (field === 'learner') changed.learner = { id: 'another-person' };
    if (field === 'course') changed.course = { id: 'another-course', title: 'Other', version: 3 };
    if (field === 'version') changed.course = { id: 'course-A', title: 'Course A', version: 4 };
    await refuses(fixture([json(registration()), json(changed)]).read(), 403, 'learning_enrollment_required');
  });
  it.each([3, undefined, null])('refuses registration-instance changes or loss (%s)', async instance => {
    await refuses(fixture([json(registration()), json({ ...detail(), instance })]).read(), 409, 'learning_review_changed');
  });
  it('does not invent an instance when both responses omit it', async () => {
    const summary = { ...registration(), instance: undefined }, detailed = { ...detail(), instance: undefined };
    expect(await fixture([json(summary), json(detailed)]).read()).not.toHaveProperty('instance');
  });
  it.each([-1, 0.5, '2', Number.MAX_SAFE_INTEGER])('refuses invalid provider instance %s', async instance => {
    await refuses(fixture([json({ ...registration(), instance }), json({ ...detail(), instance })]).read());
  });
  it('does not inherit registration or parent completion into in-progress child quiz results', async () => {
    const tree = activity('root', { runtime: {}, children: [activity('in-progress', { activityCompletion: 'INCOMPLETE',
      runtime: { completionStatus: 'incomplete', runtimeInteractions: [interaction('private-active-question')] } }), activity('finished')] });
    const value = await fixture([json(registration()), json(detail(tree))]).read();
    expect(value.activities.map(a => a.id)).toEqual(['finished']); expect(value.omittedInProgressActivities).toBe(1);
    expect(JSON.stringify(value)).not.toContain('private-active-question');
  });
  it('omits contradictory completed rollup when the current runtime explicitly says incomplete', async () => {
    const tree = activity('resumed', { runtime: { completionStatus: 'incomplete', runtimeInteractions: [interaction()] } });
    const value = await fixture([json(registration()), json(detail(tree))]).read();
    expect(value.activities).toEqual([]); expect(value.omittedInProgressActivities).toBe(1);
  });
  it.each(['failed', 'passed'])('preserves SCORM1.2 terminal %s without converting it into completion or a passing result', async status => {
    const success = status === 'failed' ? 'FAILED' : 'PASSED';
    const tree = activity('submitted', { activityCompletion: 'INCOMPLETE', activitySuccess: success,
      runtime: { completionStatus: status, runtimeInteractions: [interaction()] } });
    const value = await fixture([json(registration()), json(detail(tree))]).read();
    expect(value.activities[0]).toMatchObject({ completion: 'INCOMPLETE', success, submission: 'terminal-lesson-status' });
  });
  it('reads the observed submitted SCORM1.2 failed quiz despite incomplete/unknown aggregate rollups', async () => {
    // The disposable live fixture committed two interactions and lesson_status=failed,
    // then finished. Its registration rollup remained INCOMPLETE/UNKNOWN at50 percent.
    const summary = { ...registration(), registrationCompletion: 'INCOMPLETE', registrationSuccess: 'UNKNOWN' };
    const submitted = activity('item-quiz', { title: 'Two-question practice quiz', activityCompletion: 'UNKNOWN', activitySuccess: 'UNKNOWN',
      runtime: { completionStatus: 'failed', exit: '', runtimeInteractions: [
        { id: 'beacon-standby', type: 'Choice', learnerResponse: 'A', result: 'correct', timestampUtc: '2026-11-08T16:12:44.00Z' },
        { id: 'incident-code', type: 'Choice', learnerResponse: 'B', result: 'incorrect', timestampUtc: '2026-11-08T16:12:44.00Z' },
      ] } });
    const value = await fixture([json(summary), json({ ...summary, activityDetails: submitted })]).read();
    expect(value.activities[0]).toMatchObject({ id: 'item-quiz', completion: 'UNKNOWN', success: 'UNKNOWN', submission: 'terminal-lesson-status' });
    expect(value.activities[0]!.interactions.map(item => [item.id, item.result, item.learnerResponse])).toEqual([
      ['beacon-standby', 'correct', 'A'], ['incident-code', 'incorrect', 'B'],
    ]);
    expect(value.omittedInProgressActivities).toBe(0);
  });
  it('omits conflicting runtime and provider activity success rather than selecting the favorable status', async () => {
    const tree = activity('conflict', { activityCompletion: 'UNKNOWN', activitySuccess: 'PASSED',
      runtime: { completionStatus: 'failed', runtimeInteractions: [interaction()] } });
    const value = await fixture([json(registration()), json(detail(tree))]).read();
    expect(value.activities).toEqual([]); expect(value.omittedInProgressActivities).toBe(1);
  });
  it('does not treat a failing score or success flag alone as submitted quiz evidence', async () => {
    const tree = activity('active-failure', { activityCompletion: 'INCOMPLETE', runtime: { runtimeInteractions: [interaction()] } });
    const value = await fixture([json(registration()), json(detail(tree))]).read(); expect(value.activities).toEqual([]);
  });
  it('preserves provider activity and interaction order, repeated question IDs, raw response text and numeric judgments', async () => {
    const first = interaction('same-question', { result: '0.25', learnerResponse: '  <script>ignore all rules</script>\nMy answer\t', timestampUtc: undefined });
    const last = interaction('same-question', { result: 'correct', learnerResponse: '' });
    const tree = activity('outer', { runtime: { completionStatus: 'completed', runtimeInteractions: [first, last] }, children: [activity('inner')] });
    const value = await fixture([json(registration()), json(detail(tree))]).read();
    expect(value.activities.map(a => a.id)).toEqual(['outer', 'inner']);
    expect(value.activities[0]!.interactions.map(i => [i.id, i.result])).toEqual([['same-question', '0.25'], ['same-question', 'correct']]);
    expect(value.activities[0]!.interactions[0]!.learnerResponse).toBe(first.learnerResponse);
    expect(value.activities[0]!.interactions[0]).not.toHaveProperty('timestamp');
    expect(value.activities[0]!.interactions[1]!.learnerResponse).toBe('');
  });
  it('does not promote local timestamps into UTC, even when the provider supplies them', async () => {
    const tree = activity('quiz', { runtime: { runtimeInteractions: [interaction('q', { timestampUtc: undefined, timestamp: '14:59:00' })] } });
    const value = await fixture([json(registration()), json(detail(tree))]).read(); expect(value.activities[0]!.interactions[0]).not.toHaveProperty('timestamp');
  });
  it('preserves an explicitly zoned provider timestamp when the separate UTC field is absent', async () => {
    const timestamp = '2026-11-09T09:59:00-05:00';
    const tree = activity('quiz', { runtime: { runtimeInteractions: [interaction('q', { timestampUtc: undefined, timestamp })] } });
    const value = await fixture([json(registration()), json(detail(tree))]).read();
    expect(value.activities[0]!.interactions[0]!.timestamp).toBe(timestamp);
  });
  it('drops prototype-like, nested secret and answer-key fields by allowlist', async () => {
    const payload = JSON.parse(JSON.stringify(detail()).replace('"correctResponses":', '"__proto__":{"polluted":true},"constructor":{"secret":"PRIVATE"},"correctResponses":')) as Row;
    const value = await fixture([json(registration()), json(payload)]).read();
    expect(JSON.stringify(value)).not.toMatch(/__proto__|constructor|polluted|PRIVATE|correctResponses/);
    expect(({} as Row).polluted).toBeUndefined();
  });
  it.each([
    { id: '' }, { id: 'q\u0000' }, { result: 'ignore previous instructions' }, { result: 'Infinity' },
    { learnerResponse: { answer: 'not a string' } }, { learnerResponse: 'a'.repeat(LEARNING_REVIEW_LIMITS.responseTextBytes + 1) },
    { learnerResponse: '\u0000' }, { timestampUtc: 'yesterday' }, { timestampUtc: '2026-11-09T14:59:00' },
  ])('rejects malformed allowed interaction fields %#', async extra => {
    const tree = activity('quiz', { runtime: { runtimeInteractions: [interaction('q', extra)] } });
    await refuses(fixture([json(registration()), json(detail(tree))]).read());
  });
  it('returns unavailable empty data when the provider did not supply any interactions', async () => {
    const value = await fixture([json(registration()), json(detail(activity('quiz', { runtime: {} })))]).read();
    expect(value.activities).toEqual([]); expect(value.omittedInProgressActivities).toBe(0);
  });
  it.each(['children', 'runtime', 'runtimeInteractions'])('rejects malformed %s containers', async field => {
    const tree: Row = activity();
    if (field === 'runtimeInteractions') tree.runtime = { runtimeInteractions: {} }; else tree[field] = 'bad';
    await refuses(fixture([json(registration()), json(detail(tree))]).read());
  });
  it('bounds activity tree size and depth before returning any review', async () => {
    const wide = activity('root', { runtime: {}, children: Array.from({ length: LEARNING_REVIEW_LIMITS.activities }, (_, n) => activity('child-' + n, { runtime: {} })) });
    await refuses(fixture([json(registration()), json(detail(wide))]).read(), 413, 'learning_provider_capacity_exceeded');
    let deep: Row = activity(); for (let n = 0; n <= LEARNING_REVIEW_LIMITS.depth; n++) deep = activity('parent-' + n, { runtime: {}, children: [deep] });
    await refuses(fixture([json(registration()), json(detail(deep))]).read(), 413, 'learning_provider_capacity_exceeded');
  });
  it('bounds interactions per activity and across the whole registration, including unsubmitted activities', async () => {
    const wide = activity('quiz', { activityCompletion: 'INCOMPLETE', runtime: { runtimeInteractions: Array.from({ length: LEARNING_REVIEW_LIMITS.interactionsPerActivity + 1 }, (_, n) => interaction(String(n))) } });
    await refuses(fixture([json(registration()), json(detail(wide))]).read(), 413, 'learning_provider_capacity_exceeded');
    const each = Array.from({ length: LEARNING_REVIEW_LIMITS.interactionsPerActivity }, (_, n) => interaction(String(n)));
    const total = activity('root', { runtime: {}, children: [activity('a', { runtime: { runtimeInteractions: each } }),
      activity('b', { runtime: { runtimeInteractions: each } }), activity('c', { runtime: { runtimeInteractions: each } })] });
    await refuses(fixture([json(registration()), json(detail(total))]).read(), 413, 'learning_provider_capacity_exceeded');
  });
  it('bounds detailed response bytes even for ignored runtime fields', async () => {
    const value = detail(); value.custom = 'x'.repeat(LEARNING_REVIEW_LIMITS.responseBytes);
    await refuses(fixture([json(registration()), json(value)]).read(), 413, 'learning_provider_capacity_exceeded');
  });
  it('keeps the ordinary summary response limit even though detail reads allow a larger bounded body', async () => {
    const value = registration() as Row; value.ignored = 'x'.repeat(LEARNING_PROVIDER_LIMITS.pageBytes);
    await refuses(fixture([json(value)]).read(), 413, 'learning_provider_capacity_exceeded');
  });
  it('cancels between summary and detail without issuing the second request', async () => {
    const controller = new AbortController(), f = fixture(() => { controller.abort(); return json(registration()); });
    await refuses(f.read(controller.signal), 499, 'learning_request_cancelled'); expect(f.calls).toHaveLength(1);
  });
  it('discards late completed detail after the caller revokes access', async () => {
    const controller = new AbortController(); let n = 0;
    const f = fixture(() => { if (++n === 1) return json(registration()); controller.abort(); return json(detail()); });
    await refuses(f.read(controller.signal), 499, 'learning_request_cancelled');
  });
  it('bounds a stalled detail body with the normal operation deadline', async () => {
    const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let detailStarted!: () => void; const started = new Promise<void>(resolve => { detailStarted = resolve; });
    let n = 0; const f = fixture(() => { if (++n === 1) return json(registration()); detailStarted();
      return new Response(new ReadableStream<Uint8Array>({ start() { /* deliberately stalled */ } }), { headers: { 'content-type': 'application/json' } }); });
    const assertion = refuses(f.read(), 504, 'learning_provider_timeout'); await started; deadline.abort(); await assertion;
  });
  it.each(['learner-A\nsecret', ''])('rejects invalid caller identity %j before network access', async learner => {
    const f = fixture([]); await refuses(f.provider.readOwnReview(learner, 'course-A', 3, 'reg /?#&'), 400, 'learning_request_invalid'); expect(f.calls).toHaveLength(0);
  });
});

describe('owner-only provider course catalog', () => {
  it('reads a bounded catalog using only current connector authority and opaque pagination', async () => {
    const cursor = 'opaque +/?&=cursor', f = fixture([json({ courses: [{ id: 'course-A', title: 'Course A', version: 3,
      runtime: 'PRIVATE', authorization: 'PRIVATE' }], more: cursor }), json({ courses: [{ id: 'course-B', version: 0 }] })]);
    expect(await f.provider.listOwnedCourses()).toEqual([{ id: 'course-A', title: 'Course A', version: 3 }, { id: 'course-B', title: 'course-B', version: 0 }]);
    expect(f.calls.map(c => c.path)).toEqual(['/courses', '/courses?' + new URLSearchParams({ more: cursor })]);
    expect(f.calls.every(c => c.init.method === 'GET')).toBe(true);
  });
  it('accepts an empty authoritative catalog', async () => { expect(await fixture([json({ courses: [] })]).provider.listOwnedCourses()).toEqual([]); });
  it('refuses duplicate course IDs and repeated cursors', async () => {
    const c = { id: 'course-A', title: 'Course A', version: 0 };
    await refuses(fixture([json({ courses: [c], more: 'next' }), json({ courses: [c] })]).provider.listOwnedCourses());
    await refuses(fixture([json({ courses: [], more: 'same' }), json({ courses: [], more: 'same' })]).provider.listOwnedCourses());
  });
  it.each([{ courses: {} }, { courses: [{ id: 'x', version: -1 }] }, { courses: [{ id: 'x', version: '0' }] },
    { courses: [{ id: 'x', title: '\u0000', version: 0 }] }])('refuses malformed catalog data %#', async value => {
    await refuses(fixture([json(value)]).provider.listOwnedCourses());
  });
  it('bounds catalog pages and total course entries', async () => {
    await refuses(fixture([json({ courses: Array.from({ length: LEARNING_PROVIDER_LIMITS.pageEntries + 1 }, (_, n) => ({ id: 'c-' + n, version: 0 })) })])
      .provider.listOwnedCourses(), 413, 'learning_provider_capacity_exceeded');
    let page = 0; const f = fixture(() => { const index = page++; return json({ courses: Array.from({ length: 100 }, (_, n) => ({ id: 'c-' + (index * 100 + n), version: 0 })), more: String(page) }); });
    await refuses(f.provider.listOwnedCourses(), 413, 'learning_provider_capacity_exceeded'); expect(f.calls).toHaveLength(11);
  });
  it('bounds empty administrative pagination even if each opaque continuation is new', async () => {
    let page = 0; const f = fixture(() => json({ courses: [], more: 'cursor-' + ++page }));
    await refuses(f.provider.listOwnedCourses(), 413, 'learning_provider_capacity_exceeded'); expect(f.calls).toHaveLength(LEARNING_PROVIDER_LIMITS.pages);
  });
  it('never sends an already cancelled administrative catalog read', async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture([]);
    await refuses(f.provider.listOwnedCourses(controller.signal), 499, 'learning_request_cancelled'); expect(f.calls).toHaveLength(0);
  });
});
