import { describe, expect, it, vi } from 'vitest';
import type { LearningPrincipal } from '../src/i2idlx-learning-auth.js';
import { emptyLearningState, LearningConnectionsError, LearningConnectionsStore, validateLearningState,
  type LearningPolicy, type LearningRepository, type LearningSnapshot, type LearningState } from '../src/i2idlx-learning-connections.js';

type Row = Record<string, unknown>;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const record = (v: unknown) => v as Row;
function principal(name: string, expiresAt = NOW + 30 * 60_000) {
  const controller = new AbortController();
  const value: LearningPrincipal = { subject: 'did:web:identity.example:users:' + name, userId: name,
    webId: 'https://identity.example/users/' + name + '/profile#me', podUrl: 'https://pods.example/' + name + '/',
    sessionId: 'signed-in-session-' + name, expiresAt, signal: controller.signal };
  return { value, controller };
}
class Repository implements LearningRepository {
  value: LearningSnapshot = { revision: null, state: emptyLearningState() };
  reads = 0; writes = 0; failRead = false; failWrite = ''; staleReadback = false;
  async read(): Promise<LearningSnapshot> {
    this.reads++; if (this.failRead) throw new Error('private persistence credentials');
    if (this.staleReadback && this.writes > 0) return { revision: 'stale', state: emptyLearningState() };
    return copy(this.value);
  }
  async write(expected: string | null, state: LearningState): Promise<void> {
    this.writes++;
    if (this.failWrite === 'conflict' || expected !== this.value.revision) throw Object.assign(new Error('private CAS metadata'), { status: 409 });
    if (this.failWrite === 'failure') throw new Error('private storage endpoint');
    this.value = { revision: 'persisted-' + this.writes, state: copy(state) };
    if (this.failWrite === 'uncertain') throw new Error('private write acknowledgement lost');
  }
}
const registration = (id = 'registration-private-1', learner = 'learner-private-1', course = 'course-a', version = 2) => ({
  id, learner: { id: learner, firstName: 'Private name', email: 'private@example.test' },
  course: { id: course, title: 'Incident response', version }, registrationCompletion: 'COMPLETED', registrationSuccess: 'PASSED',
  score: { scaled: 87 }, totalSecondsTracked: 145, activityDetails: { private: 'private runtime' },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture() {
  const repository = new Repository(), clock = { value: NOW }, owner = principal('owner-a'), student = principal('student-a'), other = principal('student-b');
  const registrations = new Map<string, ReturnType<typeof registration>>([['registration-private-1', registration()],
    ['registration-private-2', registration('registration-private-2', 'learner-private-2', 'course-b')]]);
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let hook: ((path: string) => Promise<void>) | undefined;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname + url.search, init });
    if (hook) await hook(url.pathname + url.search);
    if (url.pathname === '/api/v2/courses') return json({ courses: [{ id: 'course-a', title: 'Incident response', version: 2 }] });
    if (url.pathname === '/api/v2/courses/course-a/versions/2') return json({ id: 'course-a', title: 'Incident response', version: 2 });
    if (url.pathname === '/api/v2/registrations') return json({ registrations: [...registrations.values()].filter(r => r.learner.id === url.searchParams.get('learnerId')) });
    const id = decodeURIComponent(url.pathname.slice('/api/v2/registrations/'.length));
    return registrations.has(id) ? json(registrations.get(id)) : json({ error: 'private missing registration' }, 404);
  }) as typeof fetch;
  const store = new LearningConnectionsStore({ repository, fetch: fetcher, now: () => clock.value });
  const createArgs = (policy: LearningPolicy = { allowAiContent: true, allowAiProgress: true }, requestId = 'test-create-1') => ({
    operation: 'create-connector', label: 'Dynamic Cloud connection', credentials: { app_id: 'dynamic-app', secret: 'private-secret-value' },
    policy, intent: 'authorize-enrolled-learners', request_id: requestId,
  });
  const create = async (policy?: LearningPolicy) => record((await store.request(owner.value, createArgs(policy))).connector);
  const requestLink = async (connector: Row, target = student.value) => record((await store.request(target, { operation: 'request-link', join_code: connector.join_code })).link);
  const setup = async (policy?: LearningPolicy) => {
    const connector = await create(policy), link = await requestLink(connector);
    await store.request(owner.value, { operation: 'approve-link', link_id: link.id, registration_id: 'registration-private-1', confirmed: true });
    await store.request(student.value, { operation: 'confirm-link', link_id: link.id });
    return { connector, link };
  };
  return { repository, clock, owner, student, other, calls, registrations, store, create, createArgs, requestLink, setup,
    hook: (value: typeof hook) => { hook = value; } };
}
async function refuses(work: Promise<unknown>, status: number, code?: string) {
  await expect(work).rejects.toMatchObject({ status, ...(code ? { code } : {}) });
}
function gate() {
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  return { release, started, pause: async () => { entered(); await wait; } };
}

describe('human-owned learning connector and learner-link authority', () => {
  const mapInput = () => ({ schema_version: 1, course_id: 'course-a', version: 2, release_quiz_review: true,
    instructional_locations: [{ id: 'incident', label: 'Incident procedure', source_file: 'incident.html' }],
    review_items: [{ activity_id: 'quiz', interaction_id: 'incident-code', question_label: 'Which code did you record?', location_ids: ['incident'] }],
    prerequisites: [{ course_id: 'intro', relation: 'required' }, { course_id: 'practice', relation: 'recommended' }] });
  it('saves owner maps with compare-and-swap, exact course-version authority and revocable release', async () => {
    const f = fixture(), { connector, link } = await f.setup({ allowAiContent: true, allowAiProgress: true, allowAiReview: true });
    const binding = { connector_id: connector.id, course_id: 'course-a', version: 2 };
    const writes = f.repository.writes;
    const preview = await f.store.request(f.owner.value, { operation: 'preview-course-map', ...binding, map: mapInput() });
    expect(preview).toMatchObject({ valid: true, map: { release_quiz_review: true } }); expect(f.repository.writes).toBe(writes);
    await refuses(f.store.request(f.student.value, { operation: 'get-course-map', ...binding }), 404);
    await refuses(f.store.request(f.other.value, { operation: 'save-course-map', ...binding, map: mapInput(), confirmed: true, expected_revision: null }), 404);
    const saved = record((await f.store.request(f.owner.value, { operation: 'save-course-map', ...binding, map: mapInput(), confirmed: true, expected_revision: null })).course_map);
    expect(saved.provenance).toMatchObject({ kind: 'connector-owner-authored', owner: f.owner.value.subject, connector_id: connector.id, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const access = await f.store.access(f.student.value, String(link.id), 'course-a', 2, { content: false, progress: false, review: true });
    expect(access.learningMap?.map.prerequisites.map(value => value.relation)).toEqual(['required', 'recommended']);
    await refuses(f.store.request(f.owner.value, { operation: 'save-course-map', ...binding, map: mapInput(), confirmed: true, expected_revision: null }), 409, 'learning_map_revision_conflict');
    const previous = access.revision;
    await f.store.request(f.owner.value, { operation: 'delete-course-map', ...binding, confirmed: true, expected_revision: record(saved.provenance).revision });
    const ended = await f.store.access(f.student.value, String(link.id), 'course-a', 2, { content: false, progress: false });
    expect(ended.learningMap).toBeNull(); expect(ended.revision).not.toBe(previous);
    expect(JSON.stringify(await f.store.request(f.student.value, { operation: 'courses', link_id: link.id }))).not.toMatch(/private-secret|authorization|Which code/);
  });
  it('defaults review off, restricts policy changes to the owner, and erases maps on connector revocation', async () => {
    const f = fixture(), { connector, link } = await f.setup();
    await refuses(f.store.access(f.student.value, String(link.id), 'course-a', 2, { content: false, progress: false, review: true }), 403, 'learning_review_not_allowed');
    await refuses(f.store.request(f.student.value, { operation: 'set-review-policy', connector_id: connector.id, allowAiReview: true, confirmed: true }), 404);
    await f.store.request(f.owner.value, { operation: 'set-review-policy', connector_id: connector.id, allowAiReview: true, confirmed: true });
    await f.store.request(f.owner.value, { operation: 'save-course-map', connector_id: connector.id, course_id: 'course-a', version: 2, map: mapInput(), confirmed: true, expected_revision: null });
    await f.store.request(f.owner.value, { operation: 'revoke-connector', connector_id: connector.id });
    const stored = f.repository.value.state.connectors[0]!;
    expect(stored.authorization).toBeNull(); expect(stored.learningMaps).toBeUndefined();
  });
  it('stores callback secrets privately, binds targets to active own links and rejects stale receipt writes', async () => {
    const f = fixture(), { connector, link } = await f.setup({ allowAiContent: true, allowAiProgress: true, allowProgressNotifications: true });
    const before = (await f.store.readLink(String(link.id)))!;
    const config = { secret: 'a'.repeat(48), registrations: [{ registrationId: 'registration-private-1', courseId: 'course-a', version: 2 }] };
    const changed = await f.store.updateLinkNotifications(f.student.value, before.id, before.revision, config);
    await refuses(f.store.updateLinkNotifications(f.other.value, before.id, changed.revision, config), 404);
    expect(JSON.stringify(await f.store.request(f.student.value, { operation: 'my-links' }))).not.toContain(config.secret);
    expect(await f.store.recordNotificationReceipt(changed.id, before.revision, 'registration-private-1', new Date(NOW).toISOString())).toBe(false);
    expect(await f.store.recordNotificationReceipt(changed.id, changed.revision, 'registration-private-1', new Date(NOW).toISOString())).toBe(true);
    const receipt = await f.store.readLink(changed.id); expect(receipt?.revision).toBe(changed.revision);
    await f.store.request(f.owner.value, { operation: 'revoke-link', link_id: changed.id });
    expect((await f.store.readLink(changed.id))?.notifications).toBeUndefined();
    expect(await f.store.recordNotificationReceipt(changed.id, changed.revision, 'registration-private-1', new Date(NOW).toISOString())).toBe(false);
    expect(connector.id).toBe(changed.connectorId);
  });
  it('retains optional JSON-override ownership intent privately and refuses unknown or false ownership flags', async () => {
    const f = fixture(), { link } = await f.setup({ allowAiContent: true, allowAiProgress: true, allowProgressNotifications: true });
    const before = (await f.store.readLink(String(link.id)))!;
    const config = { secret: 'a'.repeat(48), registrations: [{ registrationId: 'registration-private-1', courseId: 'course-a', version: 2, jsonOverride: true as const }] };
    const saved = await f.store.updateLinkNotifications(f.student.value, before.id, before.revision, config);
    expect(saved.notifications?.registrations[0]?.jsonOverride).toBe(true);
    expect((await f.store.readLink(saved.id))?.notifications?.registrations[0]?.jsonOverride).toBe(true);
    const publicState = JSON.stringify(await f.store.request(f.student.value, { operation: 'my-links' }));
    expect(publicState).not.toMatch(/jsonOverride|secret|registrations/);
    const bad = copy(f.repository.value.state); Object.defineProperty(bad.links[0]!.notifications!.registrations[0]!, 'jsonOverride', { value: false });
    expect(() => validateLearningState(bad)).toThrowError(expect.objectContaining({ code: 'learning_state_invalid' }));
    delete bad.links[0]!.notifications!.registrations[0]!.jsonOverride;
    expect(validateLearningState(bad).links[0]!.notifications?.registrations[0]?.jsonOverride).toBeUndefined();
  });
  it('requires administrator approval and separate target-human confirmation before reading enrolled courses', async () => {
    const f = fixture(), connector = await f.create(), link = await f.requestLink(connector);
    expect(link.status).toBe('pending-admin');
    await refuses(f.store.request(f.student.value, { operation: 'courses', link_id: link.id }), 403, 'learning_link_inactive');
    await refuses(f.store.request(f.student.value, { operation: 'confirm-link', link_id: link.id }), 409, 'learning_link_not_approved');
    const pending = await f.store.request(f.owner.value, { operation: 'pending-links', connector_id: connector.id });
    expect(pending.links).toEqual([{ id: link.id, account: { id: f.student.value.subject, webId: f.student.value.webId }, status: 'pending-admin', requested_at: new Date(NOW).toISOString() }]);
    await f.store.request(f.owner.value, { operation: 'approve-link', link_id: link.id, registration_id: 'registration-private-1', confirmed: true });
    await refuses(f.store.request(f.student.value, { operation: 'courses', link_id: link.id }), 403, 'learning_link_inactive');
    await f.store.request(f.student.value, { operation: 'confirm-link', link_id: link.id });
    const courses = await f.store.request(f.student.value, { operation: 'courses', link_id: link.id });
    expect(courses).toMatchObject({ link_id: link.id, courses: [{ id: 'course-a', title: 'Incident response', version: 2 }],
      prerequisites: { status: 'unavailable' }, curriculum: { status: 'unavailable' } });
    expect(f.calls.every(call => call.init?.method === 'GET')).toBe(true);
    expect(f.repository.writes).toBe(4);
  });
  it('keeps credentials private and verifies them through a bounded read without listing the full catalog to students', async () => {
    const f = fixture(), connector = await f.create();
    expect(f.calls[0]).toMatchObject({ path: '/api/v2/courses', init: { method: 'GET', redirect: 'error' } });
    const header = (f.calls[0]!.init!.headers as Record<string, string>).Authorization;
    expect(header).toBe('Basic ' + Buffer.from('dynamic-app:private-secret-value').toString('base64'));
    const discovery = await f.store.request(f.student.value, { operation: 'discover', join_code: connector.join_code });
    expect(discovery).toEqual({ connection: { id: connector.id, label: connector.label, policy: { allowAiContent: true, allowAiProgress: true } } });
    expect(JSON.stringify([connector, discovery])).not.toMatch(/authorization|private-secret|registration-private|learner-private|lti|webId/);
    expect((await f.store.request(f.student.value, { operation: 'owned-connectors' })).connectors).toEqual([]);
  });
  it('binds links to independent humans even when the same AI might drive both sessions', async () => {
    const f = fixture(), { connector, link } = await f.setup();
    expect((await f.store.request(f.other.value, { operation: 'my-links' })).links).toEqual([]);
    await refuses(f.store.request(f.other.value, { operation: 'courses', link_id: link.id }), 404);
    await refuses(f.store.access(f.other.value, link.id as string, 'course-a', 2, { content: true, progress: false }), 404);
    await refuses(f.store.request(f.other.value, { operation: 'pending-links', connector_id: connector.id }), 404);
    await refuses(f.store.request(f.other.value, { operation: 'revoke-connector', connector_id: connector.id }), 404);
    await refuses(f.store.request(f.other.value, { operation: 'approve-link', link_id: link.id, registration_id: 'registration-private-1', confirmed: true }), 404);
    await refuses(f.store.request(f.owner.value, { operation: 'confirm-link', link_id: link.id }), 404);
  });
  it('forbids self-approval and client-supplied owner, learner, role, agent, or LTI identity fields', async () => {
    const f = fixture(), connector = await f.create();
    await refuses(f.store.request(f.owner.value, { operation: 'request-link', join_code: connector.join_code }), 403, 'learning_self_approval_forbidden');
    for (const extra of [{ learnerId: 'learner-private-1' }, { learner_id: 'learner-private-1' }, { owner: true }, { actor: 'did:agent:same' },
      { subject: f.owner.value.subject }, { role: 'owner' }, { verifiedLti: { sub: 'forged' } }]) {
      await refuses(f.store.request(f.student.value, { operation: 'request-link', join_code: connector.join_code, ...extra }), 400);
    }
    await refuses(f.store.request(f.owner.value, { ...f.createArgs(), policy: { allowAiContent: true, allowAiProgress: true, admin: true } }), 400);
  });
  it('takes the canonical learner exclusively from the selected real registration and omits it from every standard DTO', async () => {
    const f = fixture(), { connector, link } = await f.setup();
    const access = await f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: true, progress: true });
    expect(access).toMatchObject({ learnerId: 'learner-private-1', connectorId: connector.id, linkId: link.id, policy: { allowAiContent: true, allowAiProgress: true } });
    expect(access.authorization).toMatch(/^Basic /); expect(access.registrations[0]!.id).toBe('registration-private-1');
    const replies = await Promise.all([
      f.store.request(f.owner.value, { operation: 'owned-connectors' }), f.store.request(f.student.value, { operation: 'my-links' }),
      f.store.request(f.owner.value, { operation: 'pending-links', connector_id: connector.id }),
      f.store.request(f.student.value, { operation: 'courses', link_id: link.id }),
      f.store.request(f.student.value, { operation: 'progress', link_id: link.id }),
    ]);
    expect(JSON.stringify(replies)).not.toMatch(/learner-private|registration-private|private-secret|Private name|private@example|private runtime|authorization/);
    expect(replies[4]).toEqual({ link_id: link.id, records: [{ course_id: 'course-a', title: 'Incident response', version: 2,
      completion: 'COMPLETED', success: 'PASSED', score: 87, total_seconds: 145, observed_at: new Date(NOW).toISOString(), source: 'SCORM Cloud' }], as_of: new Date(NOW).toISOString() });
  });
  it('does not reveal administrator registration lookup to students or accept guessed registration identity', async () => {
    const f = fixture(), connector = await f.create(), link = await f.requestLink(connector);
    await refuses(f.store.request(f.student.value, { operation: 'approve-link', link_id: link.id, registration_id: 'registration-private-1', confirmed: true }), 404);
    await refuses(f.store.request(f.owner.value, { operation: 'approve-link', link_id: link.id, registration_id: 'missing', confirmed: true }), 404);
    await refuses(f.store.request(f.owner.value, { operation: 'approve-link', link_id: link.id, registration_id: 'registration-private-1', confirmed: false }), 400);
    expect((await f.store.request(f.student.value, { operation: 'my-links' })).links).toMatchObject([{ status: 'pending-admin' }]);
  });
  it('returns progress only for the linked learner and requires exact enrollment for a selected version', async () => {
    const f = fixture(), { link } = await f.setup();
    await refuses(f.store.request(f.student.value, { operation: 'progress', link_id: link.id, course_id: 'course-b', version: 2 }), 403);
    await refuses(f.store.access(f.student.value, link.id as string, 'course-a', 99, { content: true, progress: false }), 403);
    await refuses(f.store.request(f.student.value, { operation: 'progress', link_id: link.id, version: 2 }), 400);
    f.registrations.delete('registration-private-1');
    expect((await f.store.request(f.student.value, { operation: 'courses', link_id: link.id })).courses).toEqual([]);
    await refuses(f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: true, progress: false }), 403);
  });
  it.each([{ allowAiContent: false, allowAiProgress: true }, { allowAiContent: true, allowAiProgress: false }])('enforces administrator sharing policy %j', async sharing => {
    const f = fixture(), { link } = await f.setup(sharing);
    expect((await f.store.request(f.student.value, { operation: 'courses', link_id: link.id })).courses).toHaveLength(1);
    const before = f.calls.length;
    await refuses(f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: !sharing.allowAiContent, progress: !sharing.allowAiProgress }), 403);
    expect(f.calls).toHaveLength(before);
    if (!sharing.allowAiProgress) await refuses(f.store.request(f.student.value, { operation: 'progress', link_id: link.id }), 403, 'learning_progress_not_allowed');
  });
  it.each(['student', 'owner'])('lets the %s revoke a link and erases canonical mapping and discovery evidence', async actor => {
    const f = fixture(), { link } = await f.setup();
    await f.store.request(actor === 'student' ? f.student.value : f.owner.value, { operation: 'revoke-link', link_id: link.id });
    const stored = f.repository.value.state.links[0]!;
    expect(stored.status).toBe('revoked'); expect(stored).not.toHaveProperty('learnerId'); expect(stored).not.toHaveProperty('registrationId');
    expect(stored).not.toHaveProperty('approvedAt'); expect(stored).not.toHaveProperty('confirmedAt'); expect(stored).not.toHaveProperty('lti');
    await refuses(f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: true, progress: true }), 403);
  });
  it('revokes a connector locally without changing original courses or registration records', async () => {
    const f = fixture(), { connector, link } = await f.setup(), original = copy([...f.registrations.values()]);
    const before = f.calls.length;
    await f.store.request(f.owner.value, { operation: 'revoke-connector', connector_id: connector.id });
    const stored = await f.store.readConnector(connector.id as string);
    expect(stored).toMatchObject({ status: 'revoked', authorization: null, joinCode: null });
    expect(f.repository.value.state.links[0]!.status).toBe('revoked'); expect(f.calls).toHaveLength(before);
    expect([...f.registrations.values()]).toEqual(original);
    await refuses(f.store.request(f.student.value, { operation: 'discover', join_code: connector.join_code }), 404);
    await refuses(f.store.request(f.student.value, { operation: 'courses', link_id: link.id }), 403);
  });
  it('rechecks authority after a provider wait so concurrent link revocation cannot deliver courses', async () => {
    const f = fixture(), { link } = await f.setup(), wait = gate();
    f.hook(async path => { if (path.startsWith('/api/v2/registrations?')) await wait.pause(); });
    const pending = f.store.request(f.student.value, { operation: 'courses', link_id: link.id });
    const denied = refuses(pending, 403); await wait.started;
    await f.store.request(f.owner.value, { operation: 'revoke-link', link_id: link.id }); wait.release(); await denied;
  });
  it('rechecks connector revocation after an in-flight exact course authorization', async () => {
    const f = fixture(), { connector, link } = await f.setup(), wait = gate();
    f.hook(async path => { if (path === '/api/v2/registrations/registration-private-1') await wait.pause(); });
    const pending = f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: true, progress: false });
    const denied = refuses(pending, 403); await wait.started;
    await f.store.request(f.owner.value, { operation: 'revoke-connector', connector_id: connector.id }); wait.release(); await denied;
  });
  it('does not approve a registration when the pending link changes during the provider read', async () => {
    const f = fixture(), connector = await f.create(), link = await f.requestLink(connector), wait = gate();
    f.hook(async path => { if (path === '/api/v2/registrations/registration-private-1') await wait.pause(); });
    const pending = f.store.request(f.owner.value, { operation: 'approve-link', link_id: link.id, registration_id: 'registration-private-1', confirmed: true });
    const denied = refuses(pending, 409, 'learning_authority_changed'); await wait.started;
    await f.store.request(f.student.value, { operation: 'revoke-link', link_id: link.id }); wait.release(); await denied;
    expect(f.repository.value.state.links[0]!.status).toBe('revoked');
  });
  it('fails after human identity expiry while awaiting provider data', async () => {
    const f = fixture(), { link } = await f.setup(), wait = gate();
    f.hook(async path => { if (path.startsWith('/api/v2/registrations?')) await wait.pause(); });
    const pending = f.store.request(f.student.value, { operation: 'courses', link_id: link.id });
    const denied = refuses(pending, 401, 'learning_session_expired'); await wait.started;
    f.clock.value = f.student.value.expiresAt + 1; wait.release(); await denied;
  });
  it('binds answer revisions to the connector/link and preserves them across unrelated human changes', async () => {
    const f = fixture(), { connector, link } = await f.setup();
    const first = await f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: true, progress: false });
    await f.requestLink(connector, f.other.value);
    const second = await f.store.access(f.student.value, link.id as string, 'course-a', 2, { content: true, progress: false });
    expect(second.revision).toBe(first.revision);
  });
  it('makes creation idempotent per owner/request and never restores a revoked connector on retry', async () => {
    const f = fixture(), connector = await f.create(), calls = f.calls.length, writes = f.repository.writes;
    const repeated = record((await f.store.request(f.owner.value, f.createArgs())).connector);
    expect(repeated).toEqual(connector); expect(f.calls).toHaveLength(calls); expect(f.repository.writes).toBe(writes);
    await refuses(f.store.request(f.owner.value, { ...f.createArgs(), label: 'Changed request' }), 409, 'learning_idempotency_conflict');
    await f.store.request(f.owner.value, { operation: 'revoke-connector', connector_id: connector.id });
    expect(record((await f.store.request(f.owner.value, f.createArgs())).connector)).toMatchObject({ id: connector.id, status: 'revoked', join_code: null });
    expect(f.repository.value.state.connectors).toHaveLength(1);
  });
  it('recovers a committed creation after an acknowledgement failure through its idempotency record', async () => {
    const f = fixture(); f.repository.failWrite = 'uncertain';
    await refuses(f.create(), 503, 'learning_storage_unavailable');
    f.repository.failWrite = '';
    const recovered = await f.create(); expect(recovered.id).toBe(f.repository.value.state.connectors[0]!.id);
    expect(f.repository.value.state.connectors).toHaveLength(1); expect(f.calls).toHaveLength(1);
  });
  it('does not duplicate repeated link requests and treats LTI evidence as discovery only', async () => {
    const f = fixture(), connector = await f.create();
    const discovered = await f.store.requestLink(f.student.value, connector.join_code as string, { issuer: 'https://cloud.scorm.com', subject: 'opaque-subject', canonicalLearnerId: 'untrusted-not-used' });
    const repeated = await f.requestLink(connector);
    expect(record(discovered.link)).toMatchObject({ id: repeated.id, status: 'pending-admin', lti_discovered: true });
    expect(f.repository.value.state.links).toHaveLength(1); expect(f.repository.value.state.links[0]).not.toHaveProperty('learnerId');
    expect(JSON.stringify(discovered)).not.toMatch(/opaque-subject|canonicalLearnerId|untrusted-not-used/);
    await refuses(f.store.access(f.student.value, repeated.id as string, 'course-a', 2, { content: true, progress: false }), 403);
  });
  it('supports only owner-authorized program-only LTI configuration updates and clones private reads', async () => {
    const f = fixture(), connector = await f.create(), id = connector.id as string;
    await f.store.updateConnector(f.owner.value, id, draft => { draft.lti = { privateKey: 'private-lti-key', clientId: 'runtime-client' }; });
    const read = await f.store.readConnector(id); expect(read!.lti).toHaveProperty('privateKey', 'private-lti-key');
    read!.lti!.privateKey = 'changed-client-copy'; expect((await f.store.readConnector(id))!.lti!.privateKey).toBe('private-lti-key');
    await refuses(f.store.updateConnector(f.other.value, id, draft => { draft.lti = {}; }), 404);
    await refuses(f.store.updateConnector(f.owner.value, id, draft => { draft.policy.allowAiContent = false; }), 400, 'learning_connector_mutation_forbidden');
    expect((await f.store.readConnector(id))!.policy.allowAiContent).toBe(true);
    await refuses(f.store.request(f.owner.value, { operation: 'update-connector', connector_id: id, lti: {} }), 400);
    expect(JSON.stringify(await f.store.request(f.owner.value, { operation: 'owned-connectors' }))).not.toMatch(/private-lti-key|runtime-client|lti/);
  });
  it('never treats a persistence read failure or corrupt state as a new empty account', async () => {
    const f = fixture(); f.repository.failRead = true;
    await refuses(f.create(), 503, 'learning_storage_unavailable'); expect(f.calls).toHaveLength(0); expect(f.repository.writes).toBe(0);
    f.repository.failRead = false; f.repository.value.state = { version: 2 } as unknown as LearningState;
    await refuses(f.store.request(f.owner.value, { operation: 'owned-connectors' }), 503, 'learning_state_invalid');
    expect(f.repository.writes).toBe(0);
  });
  it.each(['conflict', 'failure'])('fails closed on a %s during a mutation', async failure => {
    const f = fixture(); f.repository.failWrite = failure;
    await refuses(f.create(), failure === 'conflict' ? 409 : 503, failure === 'conflict' ? 'learning_update_conflict' : 'learning_storage_unavailable');
    expect(f.repository.value.state.connectors).toEqual([]);
  });
  it('lets one concurrent CAS win and requires the other request to retry against fresh state', async () => {
    const f = fixture(), connector = await f.create();
    const results = await Promise.allSettled([f.requestLink(connector), f.requestLink(connector, f.other.value)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ status: 409, code: 'learning_update_conflict' });
    expect(f.repository.value.state.links).toHaveLength(1);
    await f.requestLink(connector); await f.requestLink(connector, f.other.value);
    expect(f.repository.value.state.links).toHaveLength(2);
  });
  it('requires readback confirmation after a successful CAS', async () => {
    const f = fixture(); f.repository.staleReadback = true;
    await refuses(f.create(), 503, 'learning_update_unconfirmed');
  });
  it('rejects invalid or already expired human principals before touching storage', async () => {
    const f = fixture();
    for (const p of [{ ...f.owner.value, subject: 'did:web:identity.example:agents:ai-driver' }, { ...f.owner.value, userId: 'other-person' },
      { ...f.owner.value, expiresAt: NOW }, { ...f.owner.value, webId: 'http://insecure.example/me' }]) {
      await refuses(f.store.request(p, { operation: 'owned-connectors' }), 401);
    }
    f.owner.controller.abort(); await refuses(f.store.request(f.owner.value, { operation: 'owned-connectors' }), 401);
    expect(f.repository.reads).toBe(0);
  });
  it('rejects arbitrary operations, IDs and extra fields without leaking state or error context', async () => {
    const f = fixture(), { link } = await f.setup();
    for (const args of [{ operation: 'delete-registration', registration_id: 'registration-private-1' },
      { operation: 'courses', link_id: 'guess-private-secret' }, { operation: 'owned-connectors', owner: f.other.value.subject },
      { operation: 'progress', link_id: link.id, learner_id: 'learner-private-2' }]) {
      try { await f.store.request(f.student.value, args); throw new Error('Expected refusal'); }
      catch (error) { expect(error).toBeInstanceOf(LearningConnectionsError); expect(String(error)).not.toMatch(/private-secret|learner-private|registration-private|owner-a/); }
    }
  });
  it('does not store credentials when provider validation fails', async () => {
    const repository = new Repository();
    const store = new LearningConnectionsStore({ repository, now: () => NOW, fetch: (async () => json({ private: 'private-secret-value' }, 401)) as typeof fetch });
    const f = fixture(); await refuses(store.request(f.owner.value, f.createArgs()), 401, 'learning_provider_authentication_failed');
    expect(repository.value.state).toEqual(emptyLearningState()); expect(repository.writes).toBe(0);
  });
  it('bounds streamed credential validation before persisting authority', async () => {
    const repository = new Repository();
    const store = new LearningConnectionsStore({ repository, now: () => NOW,
      fetch: (async () => new Response(' '.repeat(512 * 1024 + 1))) as typeof fetch });
    const f = fixture(); await refuses(store.request(f.owner.value, f.createArgs()), 413, 'learning_provider_capacity_exceeded');
    expect(repository.writes).toBe(0);
  });
  it('stops stalled credential validation at its deadline without persisting a connector', async () => {
    const repository = new Repository(), deadline = new AbortController();
    const mock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const store = new LearningConnectionsStore({ repository, now: () => NOW,
        fetch: (async () => new Response(new ReadableStream<Uint8Array>({ start() { /* stalled */ } }))) as typeof fetch });
      const f = fixture(), work = store.request(f.owner.value, f.createArgs());
      const denied = refuses(work, 504, 'learning_provider_timeout');
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); deadline.abort(); await denied;
      expect(repository.writes).toBe(0);
    } finally { mock.mockRestore(); }
  });
  it('does not expose provider errors, private learner IDs or credentials on unavailable reads', async () => {
    const f = fixture(), { link } = await f.setup(); f.hook(async () => { throw new Error('private-secret-value learner-private-1 registration-private-1'); });
    try { await f.store.request(f.student.value, { operation: 'progress', link_id: link.id }); throw new Error('Expected provider failure'); }
    catch (error) { expect(error).toMatchObject({ status: 502 }); expect(String(error)).not.toMatch(/private-secret|learner-private|registration-private/); }
  });
});

describe('learning authority persisted-state validation', () => {
  it('returns an independent clone and recognizes only the bounded schema', async () => {
    const f = fixture(); await f.setup(); const checked = validateLearningState(f.repository.value.state);
    checked.connectors[0]!.label = 'changed'; expect(f.repository.value.state.connectors[0]!.label).not.toBe('changed');
    expect(validateLearningState(emptyLearningState())).toEqual(emptyLearningState());
  });
  it('rejects duplicate, inconsistent, self-approved and credential-bearing revoked authority', async () => {
    const f = fixture(); await f.setup(); const original = f.repository.value.state;
    const variants: LearningState[] = [];
    let value = copy(original); value.connectors.push(copy(value.connectors[0]!)); variants.push(value);
    value = copy(original); value.links.push(copy(value.links[0]!)); variants.push(value);
    value = copy(original); value.links[0]!.subject = value.connectors[0]!.owner; variants.push(value);
    value = copy(original); value.links[0]!.connectorId = 'a'.repeat(32); variants.push(value);
    value = copy(original); value.connectors[0]!.status = 'revoked'; variants.push(value);
    value = copy(original); delete value.links[0]!.learnerId; variants.push(value);
    value = copy(original); value.requests[0]!.owner = f.other.value.subject; variants.push(value);
    for (const bad of variants) expect(() => validateLearningState(bad)).toThrow('learning_state_invalid');
  });
  it('does not invoke getters, toJSON hooks, cycles or nonfinite private configuration', () => {
    let invoked = false; const getter = Object.defineProperty({}, 'version', { enumerable: true, get() { invoked = true; return 1; } });
    const hook = Object.defineProperty(emptyLearningState(), 'toJSON', { value() { invoked = true; return emptyLearningState(); } });
    const cycle: Row = {}; cycle.self = cycle;
    for (const value of [getter, hook, cycle, { ...emptyLearningState(), private: Number.NaN }]) expect(() => validateLearningState(value)).toThrow('learning_state_invalid');
    expect(invoked).toBe(false);
  });
});
