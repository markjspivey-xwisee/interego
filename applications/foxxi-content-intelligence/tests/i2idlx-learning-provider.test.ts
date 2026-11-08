import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEARNING_PROVIDER_LIMITS, LearningProviderError, ScormCloudLearningProvider } from '../src/i2idlx-learning-provider.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const AUTH = 'Basic private-program-credential';
const CLOUD = 'https://cloud.scorm.com/api/v2';
const row = (id = 'registration-1', learner = 'learner/A') => ({ id,
  learner: { id: learner, firstName: 'Private first name', lastName: 'Private last name', email: 'private@example.test' },
  course: { id: 'course/alpha', title: 'Incident response', version: 3 }, registrationCompletion: 'INCOMPLETE',
  registrationSuccess: 'UNKNOWN', registrationCompletionAmount: 0.4, totalSecondsTracked: 27.5, score: { scaled: 82 },
  activityDetails: { runtime: { learnerResponse: 'private response' } }, custom: { secret: 'never return this' } });
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
function fixture(responses: Response[] | ((url: string, init?: RequestInit) => Response | Promise<Response>)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    if (typeof responses === 'function') return responses(url, init);
    const response = responses.shift(); if (!response) throw new Error('Unexpected fixture request'); return response;
  });
  const provider = new ScormCloudLearningProvider({ authorization: AUTH, fetch: fetcher as typeof fetch, now: () => NOW });
  return { provider, fetcher, calls };
}
async function errorOf(promise: Promise<unknown>, code: string, status: number) {
  await expect(promise).rejects.toMatchObject({ code, status });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('per-connector SCORM Cloud learner registrations', () => {
  it('normalizes only safe registration/course/progress fields on a fixed readonly endpoint', async () => {
    const f = fixture([json(row('reg /?#&'))]);
    const result = await f.provider.getRegistration('reg /?#&');
    expect(result).toEqual({ id: 'reg /?#&', learnerId: 'learner/A', course: { id: 'course/alpha', title: 'Incident response', version: 3 },
      progress: { completion: 'INCOMPLETE', success: 'UNKNOWN', completionAmount: 0.4, totalSeconds: 27.5, score: { scaled: 82 } },
      observedAt: new Date(NOW).toISOString() });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ url: CLOUD + '/registrations/reg%20%2F%3F%23%26',
      init: { method: 'GET', redirect: 'error', headers: { Authorization: AUTH, Accept: 'application/json' } } });
    expect(JSON.stringify(result)).not.toMatch(/Private|email|learnerResponse|secret|custom|private-program/);
    expect(JSON.stringify(f.provider)).not.toContain(AUTH);
    expect(f.provider.capabilities).toEqual({ enrollments: true, progress: true, prerequisites: false, curriculum: false, access: 'read-only' });
    expect(Object.isFrozen(f.provider.capabilities)).toBe(true);
  });
  it('keeps the original learner boundary through opaque pagination without appending filters to more', async () => {
    const cursor = 'opaque +/?&=token';
    const f = fixture([json({ registrations: [row()], more: cursor }), json({ registrations: [row('registration-2')], more: null })]);
    const result = await f.provider.listOwnRegistrations('learner/A');
    expect(result.map(r => r.id)).toEqual(['registration-1', 'registration-2']);
    expect(f.calls.map(call => new URL(call.url).searchParams.toString())).toEqual([
      new URLSearchParams({ learnerId: 'learner/A' }).toString(), new URLSearchParams({ more: cursor }).toString(),
    ]);
    expect(f.calls.every(call => new URL(call.url).origin === 'https://cloud.scorm.com')).toBe(true);
  });
  it('refuses the entire result when a provider ignores the learner filter on a later page', async () => {
    const f = fixture([json({ registrations: [row()], more: 'next' }), json({ registrations: [row('other-registration', 'other-person')] })]);
    await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_invalid', 502);
  });
  it('does not infer learner identity from equal email, names, LTI claims or unknown fields', async () => {
    const other = { ...row('r', 'another-learner'), sub: 'learner/A', custom: { learnerId: 'learner/A', owner: true } };
    const f = fixture([json({ registrations: [other] })]);
    await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_invalid', 502);
  });
  it('returns no enrollments from a legitimate empty page', async () => {
    const f = fixture([json({ registrations: [], more: '' })]);
    expect(await f.provider.listOwnRegistrations('learner/A')).toEqual([]);
  });
  it('rechecks the current registration before authorizing the exact requested course version', async () => {
    const otherCourse = { ...row('other'), course: { id: 'course/beta', title: 'Other course', version: 0 } };
    const f = fixture([json({ registrations: [otherCourse, row()] }), json({ ...row(), registrationCompletion: 'COMPLETED', registrationSuccess: 'PASSED' })]);
    const result = await f.provider.authorizeCourse('learner/A', 'course/alpha', 3);
    expect(result).toHaveLength(1);
    expect(result[0]!.progress).toMatchObject({ completion: 'COMPLETED', success: 'PASSED' });
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual(['/api/v2/registrations', '/api/v2/registrations/registration-1']);
  });
  it.each([
    ['no course', { ...row(), course: { id: 'other-course', title: 'Other', version: 3 } }],
    ['no matching version', { ...row(), course: { id: 'course/alpha', title: 'Course', version: 4 } }],
  ])('denies access with %s', async (_, registration) => {
    const f = fixture([json({ registrations: [registration] })]);
    await errorOf(f.provider.authorizeCourse('learner/A', 'course/alpha', 3), 'learning_enrollment_required', 403);
    expect(f.calls).toHaveLength(1);
  });
  it.each([
    ['learner', { ...row(), learner: { id: 'other-person' } }],
    ['course', { ...row(), course: { id: 'other-course', title: 'Other', version: 3 } }],
    ['version', { ...row(), course: { id: 'course/alpha', title: 'Course', version: 4 } }],
  ])('fails closed when the %s changes between listing and the authoritative read', async (_, changed) => {
    const f = fixture([json({ registrations: [row()] }), json(changed)]);
    await errorOf(f.provider.authorizeCourse('learner/A', 'course/alpha', 3), 'learning_enrollment_required', 403);
  });
  it('treats deletion after listing as revocation, never as a successful enrollment', async () => {
    const f = fixture([json({ registrations: [row()] }), json({ error: 'private upstream details' }, 404)]);
    await errorOf(f.provider.authorizeCourse('learner/A', 'course/alpha', 3), 'learning_registration_not_found', 404);
  });
  it('requires the exact registration ID on an administrative association read', async () => {
    const f = fixture([json(row('different-registration'))]);
    await errorOf(f.provider.getRegistration('registration-1'), 'learning_provider_invalid', 502);
  });
  it('does not reuse any registration or authorization cache between questions', async () => {
    const f = fixture([json({ registrations: [row()] }), json(row()), json({ registrations: [] })]);
    await f.provider.authorizeCourse('learner/A', 'course/alpha', 3);
    await errorOf(f.provider.authorizeCourse('learner/A', 'course/alpha', 3), 'learning_enrollment_required', 403);
    expect(f.calls).toHaveLength(3);
  });
  it.each([
    ['learning_provider_authentication_failed', 401], ['learning_provider_permission_denied', 403],
    ['learning_registration_not_found', 404], ['learning_provider_rate_limited', 429], ['learning_provider_unavailable', 503],
  ])('classifies %s without exposing provider error bodies', async (code, status) => {
    const f = fixture([json({ error: AUTH + ' learner=A private course passages' }, status)]);
    try { await f.provider.getRegistration('registration-1'); throw new Error('Expected provider failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(LearningProviderError);
      expect(error).toMatchObject({ code, status: status === 503 ? 502 : status });
      expect(String(error)).not.toMatch(/private-program|passages|learner=A/);
    }
  });
  it('sanitizes thrown transport errors without guessing enrollment', async () => {
    const f = fixture(() => { throw new Error(AUTH + ' private learner details'); });
    const promise = f.provider.listOwnRegistrations('learner/A');
    await errorOf(promise, 'learning_provider_unavailable', 502);
    await expect(promise).rejects.not.toThrow(/private-program|private learner/);
  });
  it.each([
    null, [], { registrations: {} }, { registrations: [null] }, { registrations: [{ ...row(), learner: {} }] },
    { registrations: [{ ...row(), course: { ...row().course, version: '3' } }] },
    { registrations: [{ ...row(), registrationCompletion: 'completed' }] },
    { registrations: [{ ...row(), registrationSuccess: 'maybe' }] },
    { registrations: [{ ...row(), score: { scaled: 101 } }] },
    { registrations: [{ ...row(), totalSecondsTracked: -1 }] },
    { registrations: [{ ...row(), course: { ...row().course, title: 'x'.repeat(401) } }] },
  ])('refuses malformed authorization-bearing provider data %#', async payload => {
    const f = fixture([json(payload)]);
    await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_invalid', 502);
  });
  it.each(['NaN', '1e999', '-Infinity'])('rejects nonfinite progress represented as %s', async value => {
    const raw = JSON.stringify(row()).replace('"totalSecondsTracked":27.5', '"totalSecondsTracked":' + value);
    const f = fixture([new Response(raw, { headers: { 'content-type': 'application/json' } })]);
    await errorOf(f.provider.getRegistration('registration-1'), 'learning_provider_invalid', 502);
  });
  it('keeps unknown optional progress unknown and omits nullable numeric values', async () => {
    const f = fixture([json({ id: 'r', learner: { id: 'l' }, course: { id: 'c', version: 0 }, score: null, totalSecondsTracked: null })]);
    expect(await f.provider.getRegistration('r')).toMatchObject({ course: { id: 'c', title: 'c', version: 0 }, progress: { completion: 'UNKNOWN', success: 'UNKNOWN' } });
  });
  it.each(['', '..', '.', 'x\nsecret', '\ud800', 'x'.repeat(257)])('rejects invalid request identifiers without networking %#', async invalid => {
    const f = fixture([]);
    await errorOf(f.provider.getRegistration(invalid), 'learning_request_invalid', 400);
    await errorOf(f.provider.listOwnRegistrations(invalid), 'learning_request_invalid', 400);
    expect(f.calls).toHaveLength(0);
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid requested version %s', async invalid => {
    const f = fixture([]);
    await errorOf(f.provider.authorizeCourse('l', 'c', invalid), 'learning_request_invalid', 400);
    expect(f.calls).toHaveLength(0);
  });
  it('rejects invalid private credentials without reflecting their values', () => {
    expect(() => new ScormCloudLearningProvider({ authorization: 'Bearer private\r\nheader' })).toThrow('A valid private provider credential is required.');
  });
  it('refuses duplicate registration IDs within or across pages', async () => {
    for (const responses of [[json({ registrations: [row(), row()] })],
      [json({ registrations: [row()], more: 'next' }), json({ registrations: [row()] })]]) {
      const f = fixture(responses); await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_invalid', 502);
    }
  });
  it('refuses repeated cursors instead of retrying indefinitely', async () => {
    const f = fixture([json({ registrations: [], more: 'same' }), json({ registrations: [], more: 'same' })]);
    await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_invalid', 502);
    expect(f.calls).toHaveLength(2);
  });
  it('bounds registration pages even when every continuation is different', async () => {
    let page = 0;
    const f = fixture(() => json({ registrations: [], more: 'cursor-' + ++page }));
    await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_capacity_exceeded', 413);
    expect(f.calls).toHaveLength(LEARNING_PROVIDER_LIMITS.pages);
  });
  it('bounds both a single page and the complete result set', async () => {
    const large = fixture([json({ registrations: Array.from({ length: LEARNING_PROVIDER_LIMITS.pageEntries + 1 }, (_, i) => row('r' + i)) })]);
    await errorOf(large.provider.listOwnRegistrations('learner/A'), 'learning_provider_capacity_exceeded', 413);
    let page = 0;
    const many = fixture(() => { page++; return json({ registrations: Array.from({ length: 100 }, (_, i) => row('r' + page + '-' + i)), more: 'next-' + page }); });
    await errorOf(many.provider.listOwnRegistrations('learner/A'), 'learning_provider_capacity_exceeded', 413);
    expect(many.calls).toHaveLength(11);
  });
  it('bounds the streamed body when Content-Length is omitted or underreports', async () => {
    const variants: Array<Record<string, string>> = [{}, { 'content-length': '10' }];
    for (const headers of variants) {
      const f = fixture([new Response(' '.repeat(LEARNING_PROVIDER_LIMITS.pageBytes + 1), { headers: { 'content-type': 'application/json', ...headers } })]);
      await errorOf(f.provider.getRegistration('r'), 'learning_provider_capacity_exceeded', 413);
    }
  });
  it('bounds declared bodies before reading them', async () => {
    const f = fixture([json(row(), 200, { 'content-length': String(LEARNING_PROVIDER_LIMITS.pageBytes + 1) })]);
    await errorOf(f.provider.getRegistration('registration-1'), 'learning_provider_capacity_exceeded', 413);
  });
  it('bounds total bytes across otherwise small valid pages', async () => {
    let page = 0;
    const f = fixture(() => json({ registrations: [], more: 'next-' + ++page, ignored: 'x'.repeat(120_000) }));
    await errorOf(f.provider.listOwnRegistrations('learner/A'), 'learning_provider_capacity_exceeded', 413);
    expect(f.calls.length).toBeLessThan(LEARNING_PROVIDER_LIMITS.pages);
  });
  it('refuses invalid UTF-8, non-JSON media, and redirected responses', async () => {
    const badUtf8 = new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } });
    const wrongType = new Response(JSON.stringify(row()), { headers: { 'content-type': 'text/html' } });
    const redirect = json(row()); Object.defineProperty(redirect, 'redirected', { value: true });
    const wrongUrl = json(row()); Object.defineProperty(wrongUrl, 'url', { value: 'https://other.example/registrations/r' });
    for (const response of [badUtf8, wrongType, redirect, wrongUrl]) {
      const f = fixture([response]); await errorOf(f.provider.getRegistration('registration-1'), 'learning_provider_invalid', 502);
    }
  });
  it('does not send an already cancelled request', async () => {
    const f = fixture([]), controller = new AbortController(); controller.abort();
    await errorOf(f.provider.listOwnRegistrations('learner/A', controller.signal), 'learning_request_cancelled', 499);
    expect(f.calls).toHaveLength(0);
  });
  it('discards a late provider response after the caller revokes access', async () => {
    const controller = new AbortController();
    const f = fixture(() => { controller.abort(); return json(row()); });
    await errorOf(f.provider.getRegistration('registration-1', controller.signal), 'learning_request_cancelled', 499);
  });
  it('aborts a stalled response body within the operation deadline', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const stream = new ReadableStream<Uint8Array>({ start() { /* intentionally stalled */ } });
    const f = fixture([new Response(stream, { headers: { 'content-type': 'application/json' } })]);
    const promise = f.provider.getRegistration('registration-1');
    const assertion = errorOf(promise, 'learning_provider_timeout', 504);
    await Promise.resolve(); await Promise.resolve(); deadline.abort(); await assertion;
  });
  it('aborts a stalled response body when the caller revokes access', async () => {
    const controller = new AbortController();
    const secondStream = new ReadableStream<Uint8Array>({ start() { /* intentionally stalled */ } });
    const second = fixture([new Response(secondStream, { headers: { 'content-type': 'application/json' } })]);
    const secondPromise = second.provider.getRegistration('registration-1', controller.signal);
    const secondAssertion = errorOf(secondPromise, 'learning_request_cancelled', 499);
    await Promise.resolve(); await Promise.resolve(); controller.abort(); await secondAssertion;
  });
  it('keeps separate connectors and credentials independent', async () => {
    const calls: string[] = [];
    const fetcher = (async (_: unknown, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).Authorization!;
      calls.push(authorization);
      return json({ registrations: [row('r-' + calls.length, authorization === 'Bearer first' ? 'learner-1' : 'learner-2')] });
    }) as typeof fetch;
    const first = new ScormCloudLearningProvider({ authorization: 'Bearer first', fetch: fetcher });
    const second = new ScormCloudLearningProvider({ authorization: 'Bearer second', fetch: fetcher });
    expect((await first.listOwnRegistrations('learner-1'))[0]!.learnerId).toBe('learner-1');
    expect((await second.listOwnRegistrations('learner-2'))[0]!.learnerId).toBe('learner-2');
    expect(calls).toEqual(['Bearer first', 'Bearer second']);
  });
});
