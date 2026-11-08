import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import express from 'express';
import type { LearningPrincipal } from '../src/i2idlx-learning-auth.js';
import type { LearningAccess, LearningConnector } from '../src/i2idlx-learning-connections.js';
import { LEARNING_NOTIFICATION_LIMITS, LearningProgressNotifications, type LearningNotificationLink,
  type LearningNotificationStore } from '../src/i2idlx-learning-notifications.js';

const BASE = 'https://workbench.example.test', LINK = 'a'.repeat(32), CONNECTOR = 'b'.repeat(32);
const SUBJECT = 'did:web:identity.example.test:users:student', OWNER = 'did:web:identity.example.test:users:admin';
const NOW = Date.parse('2026-11-08T20:00:00.000Z'), AUTH = 'Basic synthetic-private-credential';
const URL_SETTING = 'ApiRollupRegistrationPostBackUrl', TYPE = 'ApiRollupRegistrationAuthType', USER = 'ApiRollupRegistrationAuthUser';
const PASSWORD = 'ApiRollupRegistrationAuthPassword', FORMAT = 'ApiRollupRegistrationFormat';
const SETTING_IDS = [URL_SETTING, TYPE, USER, PASSWORD, FORMAT];
type Row = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  let serial = 1, authorized = true;
  const lifetime = new AbortController();
  const principal: LearningPrincipal = { subject: SUBJECT, userId: 'student', webId: 'https://identity.example.test/users/student/profile#me',
    podUrl: 'https://pods.example.test/student/', sessionId: 'private-session', expiresAt: NOW + 3600_000, signal: lifetime.signal };
  const admin: LearningPrincipal = { ...principal, subject: OWNER, userId: 'admin', sessionId: 'admin-session' };
  let link: LearningNotificationLink = { id: LINK, connectorId: CONNECTOR, subject: SUBJECT, status: 'active', revision: '1'.repeat(32), learnerId: 'private-learner' };
  let connector: LearningConnector = { id: CONNECTOR, owner: OWNER, label: 'Private learning connection', provider: 'scorm-cloud', authorization: AUTH,
    joinCode: null, policy: { allowAiContent: false, allowAiProgress: false, allowProgressNotifications: true }, revision: '2'.repeat(32), status: 'active', createdAt: new Date(NOW).toISOString() };
  const registration = { id: 'registration-one', learner: { id: 'private-learner', firstName: 'Not exposed', email: 'private@example.test' },
    course: { id: 'course-one', title: 'Fictional course', version: 0 }, registrationCompletion: 'INCOMPLETE', registrationSuccess: 'UNKNOWN', totalSecondsTracked: 20 };
  const explicit = new Map<string, Map<string, string>>([['registration-one', new Map()]]);
  const inherited = new Map<string, string>([[URL_SETTING, ''], [TYPE, 'form'], [USER, ''], [PASSWORD, ''], [FORMAT, 'activity'], ['ApiRollupRegistrationIsJson', 'true']]);
  const calls: Array<{ url: string; method: string; body?: unknown }> = [], receipts: Array<{ link: string; revision: string; registration: string; at: string }> = [];
  let failNextPost = false, failNextDelete = false, configurationRace: (() => void) | undefined, readRace: (() => void) | undefined;
  let providerWait: Promise<void> | undefined, onProviderWait: (() => void) | undefined;
  const store: LearningNotificationStore = {
    async readLink(id) { return id === link.id ? clone(link) : null; },
    async readConnector(id) { return id === connector.id ? clone(connector) : null; },
    async readConnectorLinks(id) { return id === connector.id ? [clone(link)] : []; },
    async access(who, id, courseId, version) {
      if (!authorized || who.subject !== link.subject || id !== link.id || link.status !== 'active' || connector.status !== 'active' ||
        registration.learner.id !== link.learnerId || courseId !== registration.course.id || version !== registration.course.version) throw Error('Access refused');
      return { authorization: AUTH, learnerId: link.learnerId!, registrations: [{ id: registration.id, learnerId: registration.learner.id,
        course: clone(registration.course), progress: { completion: 'INCOMPLETE', success: 'UNKNOWN' }, observedAt: new Date(NOW).toISOString() }],
      connectorId: connector.id, linkId: link.id, revision: connector.revision + link.revision, policy: clone(connector.policy), associatedRegistrationId: registration.id, learningMap: null } satisfies LearningAccess;
    },
    async updateLinkNotifications(who, id, revision, config) {
      if (!authorized || id !== link.id || revision !== link.revision || !(who.subject === link.subject || who.subject === connector.owner && config === null)) throw Error('Notification mutation refused');
      if (config !== null && connector.policy.allowProgressNotifications !== true) throw Error('Policy refused');
      link = { ...link, revision: String(++serial).padStart(32, '0') }; if (config) link.notifications = clone(config); else delete link.notifications;
      return clone(link);
    },
    async recordNotificationReceipt(id, revision, regId, at) {
      const target = link.notifications?.registrations.find(value => value.registrationId === regId);
      if (id !== link.id || revision !== link.revision || link.status !== 'active' || connector.status !== 'active' || connector.policy.allowProgressNotifications !== true || !target) return false;
      target.lastReceiptAt = at; receipts.push({ link: id, revision, registration: regId, at }); return true;
    },
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method ?? 'GET';
    expect(url.origin).toBe('https://cloud.scorm.com'); expect(new Headers(init.headers).get('Authorization')).toBe(AUTH);
    calls.push({ url: url.href, method, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (url.pathname === '/api/v2/registrations/registration-one' && method === 'GET') {
      if (onProviderWait) onProviderWait(); if (providerWait) await providerWait;
      const value = clone(registration); readRace?.(); readRace = undefined; return json(value);
    }
    const match = url.pathname.match(/^\/api\/v2\/registrations\/([^/]+)\/configuration(?:\/([^/]+))?$/);
    if (!match) throw Error('Unexpected provider operation');
    const settings = explicit.get(decodeURIComponent(match[1]!)); if (!settings) return json({}, 404);
    if (method === 'GET') {
      const value = { settingItems: [...inherited].map(([id, fallback]) => settings.has(id)
        ? { id, effectiveValue: settings.get(id), explicitValue: settings.get(id), effectiveValueSource: 'registration' }
        : { id, effectiveValue: fallback, effectiveValueSource: 'default' }) };
      configurationRace?.(); configurationRace = undefined; return json(value);
    }
    if (method === 'POST') {
      if (failNextPost) { failNextPost = false; return json({}, 500); }
      const body = JSON.parse(String(init.body)) as { settings: Array<{ settingId: string; value: string; explicit: boolean }> };
      for (const item of body.settings) { expect(SETTING_IDS).toContain(item.settingId); expect(item.explicit).toBe(true); settings.set(item.settingId, item.value); }
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      if (failNextDelete) { failNextDelete = false; return json({}, 500); }
      expect(SETTING_IDS).toContain(match[2]); settings.delete(match[2]!); return new Response(null, { status: 204 });
    }
    throw Error('Unexpected method');
  };
  const service = new LearningProgressNotifications({ baseUrl: BASE, auth: { async revalidate(who) { if (!authorized) throw Error('Session no longer verified'); return who; } },
    connections: store, fetch: fetcher, now: () => NOW });
  cleanups.push(() => service.dispose());
  const request = (operation: string, extra: Row = {}) => service.request(principal, { operation, link_id: LINK, course_id: 'course-one', version: 0,
    ...(operation === 'progress-notification-status' ? {} : { confirmed: true }), ...extra });
  const header = () => 'Basic ' + Buffer.from(LINK + ':' + link.notifications!.secret).toString('base64');
  return { service, store, principal, admin, lifetime, request, header, calls, receipts, explicit, inherited, registration,
    getLink: () => clone(link), getConnector: () => clone(connector), mutateLink: (change: Partial<LearningNotificationLink>) => { link = { ...link, ...change }; },
    mutateConnector: (change: Partial<LearningConnector>) => { connector = { ...connector, ...change }; },
    revokeSession: () => { authorized = false; }, failPost: () => { failNextPost = true; }, failDelete: () => { failNextDelete = true; },
    raceConfiguration: (run: () => void) => { configurationRace = run; }, raceProviderRead: (run: () => void) => { readRace = run; },
    waitProvider: (promise: Promise<void>, observed?: () => void) => { providerWait = promise; onProviderWait = observed; } };
}

describe('optional authenticated per-link Cloud progress refresh notifications', () => {
  it('is off by default and status never exposes a secret or provider credential', async () => {
    const f = fixture(), status = await f.request('progress-notification-status');
    expect(status).toMatchObject({ link_id: LINK, course_id: 'course-one', version: 0, notifications: { available: true, enabled: false } });
    expect(f.calls).toHaveLength(0); expect(f.getLink().notifications).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/secret|private-credential|registration-one|private-learner|password/i);
  });
  it('uses only the selected existing registration and exact registration-scoped settings', async () => {
    const f = fixture(), enabled = await f.request('enable-progress-notifications');
    expect(enabled).toMatchObject({ notifications: { available: true, enabled: true } });
    const stored = f.getLink().notifications!;
    expect(stored.secret).toMatch(/^[a-f0-9]{48}$/);
    expect(stored.registrations).toEqual([{ registrationId: 'registration-one', courseId: 'course-one', version: 0 }]);
    const writes = f.calls.filter(call => call.method !== 'GET'); expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ url: 'https://cloud.scorm.com/api/v2/registrations/registration-one/configuration', method: 'POST', body: { settings: [
      { settingId: URL_SETTING, value: BASE + '/i2idlx/learning/progress-notifications/' + LINK, explicit: true },
      { settingId: TYPE, value: 'httpbasic', explicit: true }, { settingId: USER, value: LINK, explicit: true },
      { settingId: PASSWORD, value: stored.secret, explicit: true }, { settingId: FORMAT, value: 'course', explicit: true },
    ] } });
    expect(JSON.stringify(enabled)).not.toContain(stored.secret);
    expect(f.calls.every(call => !/applications|courses|launch|registration.*\/progress/.test(call.url))).toBe(true);
    const again = await f.request('enable-progress-notifications'); expect(again).toMatchObject({ notifications: { enabled: true } });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it('denies configuration without explicit confirmation, exact human enrollment, or owner notification policy', async () => {
    const f = fixture();
    await expect(f.request('enable-progress-notifications', { confirmed: false })).rejects.toMatchObject({ status: 400 });
    await expect(f.request('enable-progress-notifications', { learner_id: 'another-person' })).rejects.toMatchObject({ status: 400 });
    await expect(f.request('enable-progress-notifications', { course_id: 'other-course' })).rejects.toThrow();
    f.mutateConnector({ policy: { allowAiContent: false, allowAiProgress: false, allowProgressNotifications: false } });
    expect(await f.request('progress-notification-status')).toMatchObject({ notifications: { available: false, enabled: false } });
    await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ status: 403, code: 'learning_notifications_not_allowed' });
    await expect(f.request('disable-progress-notifications')).rejects.toMatchObject({ status: 403 });
    expect(f.calls).toHaveLength(0);
  });
  it.each([URL_SETTING, USER, PASSWORD, FORMAT])('never overrides existing explicit or inherited callback settings: %s', async setting => {
    const f = fixture(); f.explicit.get('registration-one')!.set(setting, setting === URL_SETTING ? 'https://other.example.test/receive' : 'Existing administrator setting');
    await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ status: 409, code: 'learning_notifications_existing_callback' });
    expect(f.calls.some(call => call.method !== 'GET')).toBe(false); expect(f.getLink().notifications).toBeUndefined();
  });
  it('refuses an inherited application callback and XML postback mode', async () => {
    let f = fixture(); f.inherited.set(URL_SETTING, 'https://existing.example.test/progress');
    await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ code: 'learning_notifications_existing_callback' });
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
    f = fixture(); f.inherited.set('ApiRollupRegistrationIsJson', 'false');
    await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ code: 'learning_notifications_existing_callback' });
  });
  it('retains private setup state for retry after provider write failure, while reporting no enabled subscription', async () => {
    const f = fixture(); f.failPost();
    await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ status: 502 });
    expect(f.getLink().notifications?.registrations).toHaveLength(1);
    expect(await f.request('progress-notification-status')).toMatchObject({ notifications: { enabled: false } });
    expect(await f.request('enable-progress-notifications')).toMatchObject({ notifications: { enabled: true } });
  });
  it('disables only its saved matching registration settings and removes the callback secret', async () => {
    const f = fixture(); await f.request('enable-progress-notifications');
    expect(await f.request('disable-progress-notifications')).toMatchObject({ notifications: { enabled: false } });
    expect(f.getLink().notifications).toBeUndefined(); expect(f.explicit.get('registration-one')!.size).toBe(0);
    const changes = f.calls.filter(call => call.method !== 'GET');
    expect(changes[1]).toMatchObject({ method: 'POST', body: { settings: [{ settingId: URL_SETTING, value: '', explicit: true }] } });
    expect(changes.slice(2).map(call => call.url.split('/').at(-1))).toEqual([PASSWORD, USER, TYPE, FORMAT, URL_SETTING]);
  });
  it('resumes safe partial cleanup and keeps the callback URL disabled until its Basic credentials are removed', async () => {
    const f = fixture(); await f.request('enable-progress-notifications'); f.failDelete();
    await expect(f.request('disable-progress-notifications')).rejects.toMatchObject({ status: 502 });
    expect(f.explicit.get('registration-one')!.get(URL_SETTING)).toBe(''); expect(f.getLink().notifications).toBeDefined();
    await f.request('disable-progress-notifications');
    expect(f.getLink().notifications).toBeUndefined(); expect(f.explicit.get('registration-one')!.size).toBe(0);
  });
  it('refuses to remove an administrator replacement callback and preserves private credentials for explicit retry', async () => {
    const f = fixture(); await f.request('enable-progress-notifications'); const count = f.calls.length;
    f.explicit.get('registration-one')!.set(URL_SETTING, 'https://other.example.test/administrator-callback');
    await expect(f.request('disable-progress-notifications')).rejects.toMatchObject({ code: 'learning_notifications_cleanup_required' });
    expect(f.calls.slice(count).some(call => call.method !== 'GET')).toBe(false);
    expect(f.getLink().notifications).toBeDefined(); expect(f.explicit.get('registration-one')!.get(URL_SETTING)).toContain('other.example');
  });
  it('lets the connector owner clean saved callbacks before revocation without enabling learner notifications for that owner', async () => {
    const f = fixture(); await f.request('enable-progress-notifications');
    await expect(f.service.request(f.admin, { operation: 'enable-progress-notifications', link_id: LINK, course_id: 'course-one', version: 0, confirmed: true })).rejects.toMatchObject({ status: 403 });
    await f.service.cleanupConnector(f.admin, CONNECTOR);
    expect(f.getLink().notifications).toBeUndefined(); expect(f.explicit.get('registration-one')!.size).toBe(0);
  });
  it('does not block ordinary revocation of pending or ended links that have no notification setup', async () => {
    const f = fixture(); f.mutateLink({ status: 'pending-admin', learnerId: undefined });
    await f.service.cleanupLink(f.principal, LINK); await f.service.cleanupLink(f.admin, LINK);
    f.mutateLink({ status: 'revoked' }); f.mutateConnector({ status: 'revoked', authorization: null });
    await f.service.cleanupLink(f.principal, LINK); await f.service.cleanupConnector(f.admin, CONNECTOR);
    expect(f.calls).toHaveLength(0);
  });
  it('authenticates the callback, discards spoofed body facts, and records only an authoritative re-read receipt', async () => {
    const f = fixture(); await f.request('enable-progress-notifications'); const revision = f.getLink().revision;
    const result = await f.service.receive(LINK, f.header(), { id: 'registration-one', registrationCompletion: 'COMPLETED', registrationSuccess: 'PASSED',
      score: { scaled: 100 }, learner: { id: 'a-different-person' }, course: { id: 'forged-course', version: 999 }, activityDetails: { answer_key: 'NEVER-STORE' } });
    expect(result).toEqual({ received: true, refresh_required: true, received_at: new Date(NOW).toISOString() });
    expect(f.receipts).toEqual([{ link: LINK, revision, registration: 'registration-one', at: new Date(NOW).toISOString() }]);
    expect(f.getLink().revision).toBe(revision); expect(f.getLink().notifications!.registrations[0]!.lastReceiptAt).toBe(new Date(NOW).toISOString());
    expect(JSON.stringify(f.getLink())).not.toMatch(/COMPLETED|PASSED|NEVER-STORE|forged-course|a-different-person/);
    expect(f.registration.registrationCompletion).toBe('INCOMPLETE');
    expect(await f.request('progress-notification-status')).toMatchObject({ notifications: { last_received_at: new Date(NOW).toISOString() } });
  });
  it.each([undefined, 'Bearer not-basic', 'Basic invalid', 'Basic ' + Buffer.from('another-link:wrong').toString('base64')])('refuses mismatched callback authentication %s', async header => {
    const f = fixture(); await f.request('enable-progress-notifications'); const count = f.calls.length;
    await expect(f.service.receive(LINK, header, { id: 'registration-one' })).rejects.toMatchObject({ status: 401 });
    expect(f.calls).toHaveLength(count); expect(f.receipts).toHaveLength(0);
  });
  it('refuses unselected registrations, provider learner mismatches, course/version changes and revoked access', async () => {
    const f = fixture(); await f.request('enable-progress-notifications');
    await expect(f.service.receive(LINK, f.header(), { id: 'other-registration' })).rejects.toMatchObject({ status: 403 });
    f.registration.learner.id = 'another-learner';
    await expect(f.service.receive(LINK, f.header(), { id: 'registration-one' })).rejects.toMatchObject({ code: 'learning_enrollment_required' });
    f.registration.learner.id = 'private-learner'; f.registration.course.version = 2;
    await expect(f.service.receive(LINK, f.header(), { id: 'registration-one' })).rejects.toMatchObject({ code: 'learning_enrollment_required' });
    f.registration.course.version = 0; f.mutateLink({ status: 'revoked' });
    await expect(f.service.receive(LINK, f.header(), { id: 'registration-one' })).rejects.toMatchObject({ code: 'learning_access_revoked' });
    expect(f.receipts).toHaveLength(0);
  });
  it('refuses a link or owner-policy revocation during the authoritative read and saves no receipt', async () => {
    const f = fixture(); await f.request('enable-progress-notifications');
    f.raceProviderRead(() => f.mutateConnector({ policy: { allowAiContent: false, allowAiProgress: false, allowProgressNotifications: false } }));
    await expect(f.service.receive(LINK, f.header(), { id: 'registration-one' })).rejects.toMatchObject({ status: 403 });
    expect(f.receipts).toHaveLength(0);
  });
  it('rechecks access after provider configuration reads before making an external write', async () => {
    const f = fixture(); f.raceConfiguration(() => f.mutateLink({ status: 'revoked' }));
    await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ status: 403 });
    expect(f.calls.some(call => call.method !== 'GET')).toBe(false); expect(f.getLink().notifications).toBeUndefined();
  });
  it('aborts an in-flight callback read on revocation without retaining incoming records or timestamps', async () => {
    const f = fixture(); await f.request('enable-progress-notifications');
    let release!: () => void, observed!: () => void; const started = new Promise<void>(resolve => { observed = resolve; });
    f.waitProvider(new Promise<void>(resolve => { release = resolve; }), observed);
    const receiving = f.service.receive(LINK, f.header(), { id: 'registration-one', secret_record: 'DISCARD' });
    await started; f.service.invalidateLink(LINK);
    await expect(receiving).rejects.toMatchObject({ status: 403 }); release(); expect(f.receipts).toHaveLength(0);
  });
  it('rejects expired/cancelled human sessions and malformed or oversized callback bodies', async () => {
    const f = fixture(); f.lifetime.abort(); await expect(f.request('enable-progress-notifications')).rejects.toMatchObject({ status: 403 });
    const next = fixture(); await next.request('enable-progress-notifications');
    await expect(next.service.receive(LINK, next.header(), { id: 'registration-one', raw: 'x'.repeat(LEARNING_NOTIFICATION_LIMITS.payloadBytes) })).rejects.toMatchObject({ status: 400 });
    await expect(next.service.receive(LINK, next.header(), { registrationId: 'registration-one' })).rejects.toMatchObject({ status: 400 });
    await expect(next.service.receive(LINK, next.header(), JSON.parse('{"id":"registration-one","__proto__":{"polluted":true}}'))).rejects.toMatchObject({ status: 400 });
    expect(next.receipts).toHaveLength(0);
  });
  it('bounds callback admission per link and never returns private source or progress records', async () => {
    const f = fixture(); await f.request('enable-progress-notifications');
    for (let n = 0; n < LEARNING_NOTIFICATION_LIMITS.linkRate; n++) expect(await f.service.receive(LINK, f.header(), { id: 'registration-one' })).toMatchObject({ refresh_required: true });
    await expect(f.service.receive(LINK, f.header(), { id: 'registration-one' })).rejects.toMatchObject({ status: 429 });
  });
  it('exposes a bounded HTTP callback with secure headers and no browser-account fallback', async () => {
    const f = fixture(); await f.request('enable-progress-notifications'); const app = express(); f.service.attachRoutes(app);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    cleanups.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local test server');
    const endpoint = 'http://127.0.0.1:' + address.port + '/i2idlx/learning/progress-notifications/' + LINK;
    const denied = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'registration-one' }) });
    expect(denied.status).toBe(401);
    const result = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: f.header() }, body: JSON.stringify({ id: 'registration-one', registrationCompletion: 'forged' }) });
    expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ received: true, refresh_required: true, received_at: new Date(NOW).toISOString() });
    const invalid = await fetch(endpoint + '?extra=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: f.header() }, body: '{}' }); expect(invalid.status).toBe(400);
    const oversized = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: f.header() }, body: JSON.stringify({ id: 'registration-one', blob: 'x'.repeat(LEARNING_NOTIFICATION_LIMITS.payloadBytes) }) }); expect(oversized.status).toBe(413);
  });
});
