import { afterEach, describe, expect, it } from 'vitest';
import { LearningAuthError, type LearningPrincipal } from '../src/i2idlx-learning-auth.js';
import { emptyLearningState, LearningConnectionsStore, type LearningPolicy, type LearningRepository, type LearningSnapshot } from '../src/i2idlx-learning-connections.js';
import { LearningLaunchService, LEARNING_LAUNCH_LIMITS, validateLearningLaunchUrl } from '../src/i2idlx-learning-launch.js';

type Row = Record<string, unknown>;
const NOW = Date.parse('2026-11-09T14:00:00Z'), BASE = 'https://workbench.example';
const URL_CAPABILITY = 'https://cloud.scorm.com/api/cloud/registration/launch/synthetic-private-capability-123456';
const json = (v: unknown, status = 200) => Response.json(v, { status });
const row = (v: unknown) => v as Row;
const copy = <T>(v: T): T => structuredClone(v);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const done of cleanup.splice(0)) done(); });
function human(name: string) {
  const controller = new AbortController();
  const principal: LearningPrincipal = { subject: 'did:web:identity.example:users:' + name, userId: name,
    webId: 'https://identity.example/users/' + name + '/profile#me', podUrl: 'https://pods.example/' + name + '/',
    sessionId: 'browser-human-' + name, expiresAt: NOW + 30 * 60_000, signal: controller.signal };
  return { principal, controller };
}
const registration = (id = 'PRIVATE-REG-A', learner = 'PRIVATE-LEARNER-A', course = 'course-a', version = 2) => ({ id,
  learner: { id: learner, email: 'PRIVATE@example.test' }, course: { id: course, title: 'Incident response', version },
  registrationCompletion: 'INCOMPLETE', registrationSuccess: 'UNKNOWN' });
const activity = (item: string, href: string, type = 'SCO') => ({ itemIdentifier: item, resourceIdentifier: 'RESOURCE-' + item,
  activityType: type, href, title: 'Activity ' + item, children: [] });
async function fixture(policy: LearningPolicy = { allowAiContent: false, allowAiProgress: false }) {
  const owner = human('owner'), student = human('student'), other = human('other'), clock = { value: NOW };
  const registrations = new Map([['PRIVATE-REG-A', registration()]]);
  const controls = { url: URL_CAPABILITY, restart: 'NEVER', malformedSettings: false, auth: true, courseStatus: 200, wrongVersion: false };
  let tree: Row = { id: 'course-a', title: 'Incident response', version: 2,
    rootActivity: { activityType: 'AGGREGATION', children: [activity('ITEM-incident', 'incident.html'), activity('ITEM-resume', 'resume.html')] } };
  const calls: Array<{ path: string; init: RequestInit }> = [];
  let hook: ((path: string, init: RequestInit) => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), path = url.pathname.slice('/api/v2'.length) + url.search;
    expect(url.origin).toBe('https://cloud.scorm.com'); expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('Authorization')).toBe('Basic ' + Buffer.from('dynamic-app:PRIVATE-SECRET').toString('base64'));
    calls.push({ path, init }); if (hook) await hook(path, init);
    if (path === '/courses') return json({ courses: [{ id: 'course-a', title: 'Incident response', version: 2 }] });
    if (path.startsWith('/registrations?')) return json({ registrations: [...registrations.values()].filter(value => value.learner.id === url.searchParams.get('learnerId')) });
    if (path === '/registrations/PRIVATE-REG-A/configuration') return json({ settingItems: controls.malformedSettings ? [] : [{ id: 'WhenToRestartRegistration', effectiveValue: controls.restart }] });
    if (url.pathname.endsWith('/launchLink')) { expect(init.method).toBe('POST'); return json({ launchLink: controls.url }); }
    if (url.pathname.startsWith('/api/v2/registrations/')) {
      const value = registrations.get(decodeURIComponent(url.pathname.slice('/api/v2/registrations/'.length)));
      return json(value ?? {}, value ? 200 : 404);
    }
    if (path === '/courses/course-a/versions/2') return json(controls.wrongVersion ? { ...tree, version: 3 } : tree, controls.courseStatus);
    throw Error('Unexpected fixture route');
  };
  let snapshot: LearningSnapshot = { revision: null, state: emptyLearningState() }, count = 0;
  const repository: LearningRepository = { async read() { return copy(snapshot); }, async write(expected, state) {
    expect(expected).toBe(snapshot.revision); snapshot = { revision: String(++count), state: copy(state) };
  } };
  const connections = new LearningConnectionsStore({ repository, fetch: fetcher, now: () => clock.value });
  const connector = row((await connections.request(owner.principal, { operation: 'create-connector', label: 'Dynamic connector',
    credentials: { app_id: 'dynamic-app', secret: 'PRIVATE-SECRET' }, policy, intent: 'authorize-enrolled-learners', request_id: 'request-1' })).connector);
  const link = row((await connections.request(student.principal, { operation: 'request-link', join_code: connector.join_code })).link);
  await connections.request(owner.principal, { operation: 'approve-link', link_id: link.id, registration_id: 'PRIVATE-REG-A', confirmed: true });
  await connections.request(student.principal, { operation: 'confirm-link', link_id: link.id });
  const auth = { revalidate: async (principal: LearningPrincipal) => { if (!controls.auth) throw new LearningAuthError(401, 'learning_sign_in_required'); return principal; } };
  const service = new LearningLaunchService({ baseUrl: BASE, auth, connections, fetch: fetcher, now: () => clock.value }); cleanup.push(() => service.dispose());
  const input = (extra: Row = {}) => ({ link_id: link.id, course_id: 'course-a', version: 2, ...extra });
  const launch = (extra: Row = {}) => service.launch(student.principal, input(extra));
  const optIn = () => connections.request(owner.principal, { operation: 'set-targeted-launch-policy', connector_id: connector.id, allowTargetedLaunch: true, confirmed: true });
  const citations = [{ id: 'citation-incident', locator: 'incident.html', title: 'Incident procedure', body: 'NEVER-RETAIN-PASSAGE' },
    { id: 'citation-inner', locator: 'data/inside.html', title: 'Internal file' }, { id: 'citation-progress', title: 'Progress only' }];
  const navigate = async () => service.prepareNavigation(student.principal, await connections.access(student.principal, String(link.id), 'course-a', 2,
    { content: false, progress: false }), 'course-a', 2, citations);
  const revoke = () => connections.request(owner.principal, { operation: 'revoke-link', link_id: link.id });
  return { owner, student, other, clock, registrations, controls, calls, connections, service, connector, link, input, launch, optIn, citations, navigate, revoke,
    tree: () => tree, setTree: (value: Row) => { tree = value; }, state: () => snapshot.state, hook: (value: typeof hook) => { hook = value; } };
}
async function refuses(promise: Promise<unknown>, status: number, code?: string) { await expect(promise).rejects.toMatchObject({ status, ...(code ? { code } : {}) }); }
function gate() { let release!: () => void, enter!: () => void; const started = new Promise<void>(resolve => { enter = resolve; }), wait = new Promise<void>(resolve => { release = resolve; }); return { started, release, pause: async () => { enter(); await wait; } }; }

describe('deliberate enrolled course launch', () => {
  it('launches an existing human enrollment without requiring any AI sharing or creating a registration', async () => {
    const f = await fixture(), start = f.calls.length, result = await f.launch();
    expect(result).toMatchObject({ launch_url: URL_CAPABILITY, expires_at: new Date(NOW + 120_000).toISOString(), destination: { kind: 'course', title: 'Incident response' }, tracking: true });
    expect(result.notice).toMatch(/not a guarantee/);
    const writes = f.calls.slice(start).filter(call => call.init.method !== 'GET'); expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/registrations/PRIVATE-REG-A/launchLink');
    expect(JSON.parse(String(writes[0]?.init.body))).toEqual({ redirectOnExitUrl: BASE + '/i2idlx/#ask', expiry: 120, tracking: true });
    expect(JSON.stringify(f.state())).not.toContain(URL_CAPABILITY);
    expect(f.calls.some(call => /preview|asset|import|launchInfo/.test(call.path))).toBe(false);
  });
  it.each([{ learner_id: 'PRIVATE-LEARNER-A' }, { registration_id: 'PRIVATE-REG-A' }, { startSco: 'ITEM-incident' },
    { launch_url: 'https://attacker.test/' }, { redirectOnExitUrl: 'https://attacker.test/' }, { location_ref: 'invented' }, { version: NaN }])('refuses caller-selected identity or launch authority %#', async extra => {
    const f = await fixture(), before = f.calls.length; await refuses(f.launch(extra), 400); expect(f.calls).toHaveLength(before);
  });
  it('does not authorize another human or an unregistered version/course', async () => {
    const f = await fixture(); await refuses(f.service.launch(f.other.principal, f.input()), 404);
    await refuses(f.launch({ course_id: 'other-course' }), 403, 'learning_enrollment_required');
    await refuses(f.launch({ version: 1 }), 403, 'learning_enrollment_required');
    f.controls.auth = false; await refuses(f.launch(), 401); expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });
  it('uses the administrator-associated registration among current exact matches, never a list-order guess', async () => {
    const f = await fixture(); f.registrations.set('PRIVATE-REG-NEW', registration('PRIVATE-REG-NEW'));
    await f.launch(); expect(f.calls.find(call => call.init.method === 'POST')?.path).toBe('/registrations/PRIVATE-REG-A/launchLink');
  });
  it('refuses ambiguity when the associated registration belongs to another selected course', async () => {
    const f = await fixture(); f.registrations.delete('PRIVATE-REG-A'); f.registrations.set('PRIVATE-REG-X', registration('PRIVATE-REG-X'));
    f.registrations.set('PRIVATE-REG-Y', registration('PRIVATE-REG-Y'));
    await refuses(f.launch(), 409, 'learning_launch_registration_ambiguous'); expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });
  it('blocks enrollment revocation before minting and discards a capability when revoked during provider minting', async () => {
    const f = await fixture(); let reads = 0;
    f.hook(async path => { if (path.startsWith('/registrations?') && ++reads === 2) f.registrations.clear(); });
    await refuses(f.launch(), 403); expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
    const g = await fixture(), pending = gate(); g.hook(async path => { if (path.endsWith('/launchLink')) await pending.pause(); });
    const work = g.launch(); await pending.started; await g.revoke(); pending.release(); await refuses(work, 403);
  });
  it('blocks human logout/expiry while the mint is outstanding and bounds concurrent work', async () => {
    const f = await fixture(), pending = gate(); f.hook(async path => { if (path.endsWith('/launchLink')) await pending.pause(); });
    const work = f.launch(); await pending.started; await refuses(f.launch(), 429, 'learning_launch_busy'); f.student.controller.abort();
    pending.release(); await refuses(work, 403, 'learning_access_revoked');
    const g = await fixture(); g.clock.value = g.student.principal.expiresAt; await refuses(g.launch(), 403);
  });
  it('rechecks backing human authority and enrollment after provider minting', async () => {
    const f = await fixture(); f.hook(async path => { if (path.endsWith('/launchLink')) f.controls.auth = false; });
    await refuses(f.launch(), 401);
    const g = await fixture(); g.hook(async path => { if (path.endsWith('/launchLink')) g.registrations.clear(); }); await refuses(g.launch(), 403);
  });
  it('sanitizes provider failures and never stores the raw launch capability', async () => {
    const f = await fixture(); f.hook(async path => { if (path.endsWith('/launchLink')) throw Error('PRIVATE-SECRET PRIVATE-LEARNER-A ' + URL_CAPABILITY); });
    try { await f.launch(); throw Error('expected refusal'); } catch (error) { expect(error).toMatchObject({ code: 'learning_provider_unavailable' }); expect(String(error)).not.toMatch(/PRIVATE-|synthetic-private/); }
    const saved = JSON.stringify(f.service, (key, value: unknown) => key === 'config' ? undefined : value); expect(saved).not.toMatch(/PRIVATE-|synthetic-private|NEVER-RETAIN/);
  });
  it.each(['http://cloud.scorm.com/api/cloud/registration/launch/abcdefghijklmnop', 'https://cloud.scorm.com.evil.test/api/cloud/registration/launch/abcdefghijklmnop',
    'https://user@cloud.scorm.com/api/cloud/registration/launch/abcdefghijklmnop', 'https://cloud.scorm.com:444/api/cloud/registration/launch/abcdefghijklmnop',
    'https://cloud.scorm.com/api/cloud/registration/launch/abcdefghijklmnop#slide',
    'https://cloud.scorm.com/api/v2/courses/course-a/asset', 'https://cloud.scorm.com/api/cloud/registration/launch/'])('rejects an unsupported provider launch URL %s', async value => {
    const f = await fixture(); f.controls.url = value; await refuses(f.launch(), 502, 'learning_launch_invalid');
  });
  it('preserves opaque provider launch query parameters without assuming a token format', async () => {
    const f = await fixture(); f.controls.url = 'https://cloud.scorm.com/api/cloud/registration/launch/a.provider-format?opaque=synthetic%2Bvalue';
    expect((await f.launch()).launch_url).toBe(f.controls.url);
  });
  it('keeps local HTTP workbench startup available while refusing credentialed course launch', async () => {
    const f = await fixture(), local = new LearningLaunchService({ baseUrl: 'http://127.0.0.1:7070', auth: { revalidate: async p => p }, connections: f.connections });
    cleanup.push(() => local.dispose());
    const start = f.calls.length; await refuses(local.launch(f.student.principal, f.input()), 503, 'learning_launch_unavailable');
    expect(f.calls).toHaveLength(start);
  });
});

describe('authoritative optional activity navigation', () => {
  it('defaults historical connectors to course navigation and requires an owner-only explicit policy change', async () => {
    const f = await fixture(), calls = f.calls.length;
    expect((await f.navigate()).locations).toMatchObject([{ citation_id: 'citation-incident', target_kind: 'course' }, { citation_id: 'citation-inner', target_kind: 'course' }]);
    expect(f.calls.slice(calls).some(call => /configuration|versions/.test(call.path))).toBe(false);
    await refuses(f.connections.request(f.student.principal, { operation: 'set-targeted-launch-policy', connector_id: f.connector.id, allowTargetedLaunch: true, confirmed: true }), 404);
    await refuses(f.connections.request(f.owner.principal, { operation: 'set-targeted-launch-policy', connector_id: f.connector.id, allowTargetedLaunch: true, confirmed: false }), 400);
    const before = (await f.connections.readConnector(String(f.connector.id)))?.revision;
    const result = await f.optIn(); expect(row(result.connector).policy).toMatchObject({ allowTargetedLaunch: true });
    expect((await f.connections.readConnector(String(f.connector.id)))?.revision).not.toBe(before);
  });
  it('maps only an actually cited source file to the unique provider SCO itemIdentifier and keeps references metadata-only', async () => {
    const f = await fixture(); await f.optIn(); const navigation = await f.navigate(), location = navigation.locations[0]!;
    expect(location).toMatchObject({ source_file: 'incident.html', precision: 'published-file', target_kind: 'activity', location_ref: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(navigation.locations[1]).toMatchObject({ source_file: 'data/inside.html', target_kind: 'course' });
    expect(navigation.locations.some(value => value.source_file === 'resume.html')).toBe(false);
    const result = await f.launch({ location_ref: location.location_ref }); expect(result.destination).toEqual({ kind: 'activity', title: 'Activity ITEM-incident', source_file: 'incident.html' });
    const post = f.calls.find(call => call.init.method === 'POST')!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({ startSco: 'ITEM-incident', tracking: true, expiry: 120 });
    expect(String(post.init.body)).not.toMatch(/RESOURCE-|incident\.html|location_ref|slide/);
    const refs = [...(f.service as unknown as { locations: Map<string, unknown> }).locations.values()];
    expect(JSON.stringify(refs)).not.toMatch(/NEVER-RETAIN|PRIVATE-|authorization|body|launch_url/);
  });
  it.each(['single-sco', 'asset', 'duplicate-href', 'duplicate-item', 'unsafe-href', 'missing-root', 'unknown-type', 'missing-id'])('falls back to course navigation for unsupported authority %s', async mode => {
    const f = await fixture(); await f.optIn(); const tree = copy(f.tree()), root = row(tree.rootActivity), children = root.children as Row[];
    if (mode === 'single-sco') root.children = [children[0]];
    if (mode === 'asset') children[0]!.activityType = 'ASSET';
    if (mode === 'duplicate-href') children.push(activity('ITEM-third', 'incident.html'));
    if (mode === 'duplicate-item') children.push(activity('ITEM-incident', 'different.html', 'ASSET'));
    if (mode === 'unsafe-href') children[0]!.href = 'https://attacker.test/incident.html';
    if (mode === 'missing-root') delete tree.rootActivity;
    if (mode === 'unknown-type') children[0]!.activityType = 'UNKNOWN';
    if (mode === 'missing-id') delete children[0]!.itemIdentifier;
    f.setTree(tree); const navigation = await f.navigate(); expect(navigation.locations[0]!.target_kind).toBe('course'); expect(navigation.locations[0]).not.toHaveProperty('location_ref');
  });
  it.each(['migration', 'missing-setting', 'missing-provider-metadata', 'wrong-version', 'overcapacity'])('falls back without guessing when provider metadata cannot authorize a target %s', async mode => {
    const f = await fixture(); await f.optIn();
    if (mode === 'migration') f.controls.restart = 'WHEN_NEWER_PACKAGE_VERSION_EXISTS';
    if (mode === 'missing-setting') f.controls.malformedSettings = true;
    if (mode === 'missing-provider-metadata') f.controls.courseStatus = 404;
    if (mode === 'wrong-version') f.controls.wrongVersion = true;
    if (mode === 'overcapacity') f.setTree({ ...f.tree(), rootActivity: { activityType: 'AGGREGATION', children: Array.from({ length: 2001 }, (_, n) => activity('item-' + n, 'file-' + n + '.html')) } });
    expect((await f.navigate()).locations[0]!.target_kind).toBe('course');
  });
  it('binds references to the exact human browser, course/version and current connection authority', async () => {
    const f = await fixture(); await f.optIn(); const reference = (await f.navigate()).locations[0]!.location_ref;
    const anotherBrowser = { ...f.student.principal, sessionId: 'second-browser-same-human', signal: new AbortController().signal };
    await refuses(f.service.launch(anotherBrowser, f.input({ location_ref: reference })), 403, 'learning_launch_location_expired');
    await refuses(f.service.launch(f.other.principal, f.input({ location_ref: reference })), 404);
    f.clock.value += LEARNING_LAUNCH_LIMITS.referenceMs; await refuses(f.launch({ location_ref: reference }), 403, 'learning_launch_location_expired');
    expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
  });
  it('rejects changes to target authority or migration configuration before/after minting', async () => {
    const f = await fixture(); await f.optIn(); const reference = (await f.navigate()).locations[0]!.location_ref;
    f.controls.restart = 'WHEN_NEWER_PACKAGE_VERSION_EXISTS'; await refuses(f.launch({ location_ref: reference }), 409, 'learning_launch_location_unavailable');
    f.controls.restart = 'NEVER'; const tree = copy(f.tree()); row((row(tree.rootActivity).children as Row[])[0]).itemIdentifier = 'CHANGED'; f.setTree(tree);
    await refuses(f.launch({ location_ref: reference }), 409, 'learning_launch_location_unavailable');
    const g = await fixture(); await g.optIn(); const ref = (await g.navigate()).locations[0]!.location_ref;
    g.hook(async path => { if (path.endsWith('/launchLink')) g.controls.restart = 'WHEN_NEWER_PACKAGE_VERSION_EXISTS'; });
    await refuses(g.launch({ location_ref: ref }), 409, 'learning_launch_location_unavailable');
  });
  it('invalidates references on owner policy change and clears locally revoked references', async () => {
    const f = await fixture(); await f.optIn(); const ref = (await f.navigate()).locations[0]!.location_ref;
    await f.connections.request(f.owner.principal, { operation: 'set-targeted-launch-policy', connector_id: f.connector.id, allowTargetedLaunch: false, confirmed: true });
    await refuses(f.launch({ location_ref: ref }), 403, 'learning_launch_location_expired');
    f.service.invalidateConnector(String(f.connector.id)); expect((f.service as unknown as { locations: Map<string, unknown> }).locations.size).toBe(0);
    expect(validateLearningLaunchUrl(URL_CAPABILITY)).toBe(URL_CAPABILITY);
  });
});
