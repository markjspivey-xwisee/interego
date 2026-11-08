/** Optional per-link SCORM Cloud refresh callbacks. Incoming progress facts
 * are discarded; an authenticated callback only triggers an authoritative read
 * and records its receipt time. No learner records or outbound notices are saved.
 * Provider contracts: https://cloud.scorm.com/docs/swagger.json and
 * https://cloud.scorm.com/docs/v2/guides/postback/ . */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Express } from 'express';
import type { LearningAccountAuth, LearningPrincipal } from './i2idlx-learning-auth.js';
import type { LearningAccess, LearningConnector } from './i2idlx-learning-connections.js';
import { LearningProviderError, ScormCloudLearningProvider } from './i2idlx-learning-provider.js';

export interface LearningProgressNotificationTarget {
  registrationId: string; courseId: string; version: number; lastReceiptAt?: string;
}
export interface LearningLinkNotifications { secret: string; registrations: LearningProgressNotificationTarget[]; }
export interface LearningNotificationLink {
  id: string; connectorId: string; subject: string; status: string; revision: string;
  learnerId?: string; notifications?: LearningLinkNotifications;
}
export interface LearningNotificationStore {
  readLink(id: string): Promise<LearningNotificationLink | null>;
  readConnector(id: string): Promise<LearningConnector | null>;
  readConnectorLinks(id: string): Promise<LearningNotificationLink[]>;
  access(principal: LearningPrincipal, linkId: string, courseId: string, version: number,
    requirements: { content: boolean; progress: boolean }, signal?: AbortSignal): Promise<LearningAccess>;
  updateLinkNotifications(principal: LearningPrincipal, linkId: string, expectedRevision: string,
    notifications: LearningLinkNotifications | null): Promise<LearningNotificationLink>;
  /** Must CAS current active link/connector/policy and exact target; receipt writes
   * do not change the link authority revision or save any callback body fields. */
  recordNotificationReceipt(linkId: string, expectedRevision: string, registrationId: string, receivedAt: string): Promise<boolean | void>;
}
export interface LearningProgressNotificationsConfig {
  baseUrl: string; auth: Pick<LearningAccountAuth, 'revalidate'>; connections: LearningNotificationStore;
  fetch?: typeof fetch; now?: () => number;
}
export class LearningNotificationsError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const LEARNING_NOTIFICATION_LIMITS = Object.freeze({ active: 8, targets: 16, linkRate: 12, rateLinks: 1024,
  requestMs: 30_000, payloadBytes: 64 * 1024, configBytes: 256 * 1024 });
const CALLBACK = '/i2idlx/learning/progress-notifications/';
const CLOUD = 'https://cloud.scorm.com/api/v2';
const SETTING = Object.freeze({ url: 'ApiRollupRegistrationPostBackUrl', type: 'ApiRollupRegistrationAuthType',
  user: 'ApiRollupRegistrationAuthUser', passwordSetting: 'ApiRollupRegistrationAuthPassword', format: 'ApiRollupRegistrationFormat' });
const KEYS: readonly string[] = Object.values(SETTING), IS_JSON = 'ApiRollupRegistrationIsJson';
type Row = Record<string, unknown>;
type Settings = Map<string, { value: string; explicit?: string; source?: string }>;
type Scope = { link: LearningNotificationLink; connector: LearningConnector };
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const plain = (v: unknown): v is Row => object(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && !!v && v === v.trim() &&
  Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v;
function fail(status: number, code: string): never { throw new LearningNotificationsError(status, code); }
const equal = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
function sameHuman(a: LearningPrincipal, b: LearningPrincipal): boolean {
  return a.subject === b.subject && a.userId === b.userId && a.webId === b.webId && a.podUrl === b.podUrl && a.sessionId === b.sessionId && a.signal === b.signal;
}
function boundedJson(value: unknown, depth = 0, nodes = { n: 0 }): boolean {
  if (++nodes.n > 8000 || depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return Buffer.from(value).toString('utf8') === value;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) || Object.getOwnPropertySymbols(value).length) return false;
  const keys = Object.keys(value), names = Object.getOwnPropertyNames(value);
  return names.length === keys.length + (Array.isArray(value) ? 1 : 0) && (!Array.isArray(value) || keys.length === value.length) && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !['__proto__', 'prototype', 'constructor'].includes(key) && !!descriptor && 'value' in descriptor && boundedJson(descriptor.value, depth + 1, nodes);
  });
}
function selected(access: LearningAccess) {
  return access.registrations.find(value => value.id === access.associatedRegistrationId) ?? (access.registrations.length === 1 ? access.registrations[0] : undefined);
}
function validateNotifications(raw: unknown): LearningLinkNotifications | undefined {
  if (raw === undefined) return undefined;
  if (!plain(raw) || Object.keys(raw).some(key => !['secret', 'registrations'].includes(key)) ||
    typeof raw.secret !== 'string' || !/^[a-f0-9]{48}$/.test(raw.secret) || !Array.isArray(raw.registrations) ||
    !raw.registrations.length || raw.registrations.length > LEARNING_NOTIFICATION_LIMITS.targets) fail(503, 'learning_notifications_state_invalid');
  const seen = new Set<string>();
  const registrations = raw.registrations.map(target => {
    if (!plain(target) || Object.keys(target).some(key => !['registrationId', 'courseId', 'version', 'lastReceiptAt'].includes(key)) ||
      !text(target.registrationId) || !text(target.courseId) || !Number.isSafeInteger(target.version) || Number(target.version) < 0 || seen.has(target.registrationId) ||
      target.lastReceiptAt !== undefined && (typeof target.lastReceiptAt !== 'string' || !Number.isFinite(Date.parse(target.lastReceiptAt)))) fail(503, 'learning_notifications_state_invalid');
    seen.add(target.registrationId);
    return { registrationId: target.registrationId, courseId: target.courseId, version: target.version as number,
      ...(typeof target.lastReceiptAt === 'string' ? { lastReceiptAt: target.lastReceiptAt } : {}) };
  });
  return { secret: raw.secret, registrations };
}

export class LearningProgressNotifications {
  private readonly base: string | null;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  private readonly requests = new Map<AbortController, { link: string; connector?: string }>();
  private readonly locks = new Set<string>();
  private readonly rates = new Map<string, { since: number; count: number }>();
  private disposed = false;
  constructor(private readonly config: LearningProgressNotificationsConfig) {
    let base: string | null = null;
    try { const url = new URL(config.baseUrl); if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') base = url.origin; } catch { /* fail closed for unavailable public callback origin */ }
    this.base = base; this.clock = config.now ?? Date.now; this.fetcher = config.fetch ?? globalThis.fetch;
  }
  private now(): number { const now = this.clock(); if (!Number.isSafeInteger(now) || now < 0) fail(503, 'learning_notifications_unavailable'); return now; }
  private live(signal: AbortSignal): void { if (this.disposed || signal.aborted) fail(403, 'learning_access_revoked'); }
  private async await<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    this.live(signal); let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(new LearningNotificationsError(403, 'learning_access_revoked')); });
    signal.addEventListener('abort', abort, { once: true });
    try { const value = await Promise.race([promise, stopped]); this.live(signal); return value; }
    finally { signal.removeEventListener('abort', abort); }
  }
  private async human(principal: LearningPrincipal, signal: AbortSignal): Promise<void> {
    this.live(signal);
    if (!principal?.signal || principal.signal.aborted || principal.expiresAt <= this.now()) fail(403, 'learning_access_revoked');
    const fresh = await this.await(this.config.auth.revalidate(principal), signal);
    if (!sameHuman(fresh, principal) || fresh.expiresAt <= this.now()) fail(403, 'learning_access_revoked');
  }
  private async scope(principal: LearningPrincipal, linkId: string, signal: AbortSignal, ownerCleanup = false): Promise<Scope> {
    await this.human(principal, signal);
    const link = await this.await(this.config.connections.readLink(linkId), signal);
    if (!link || link.id !== linkId) fail(403, 'learning_notifications_link_required');
    const connector = await this.await(this.config.connections.readConnector(link.connectorId), signal);
    if (!connector || connector.status !== 'active' || !connector.authorization || connector.id !== link.connectorId ||
      !(link.subject === principal.subject && link.status === 'active' || ownerCleanup && connector.owner === principal.subject) || !text(link.learnerId)) fail(403, 'learning_access_revoked');
    validateNotifications(link.notifications);
    return { link, connector };
  }
  private unchanged(before: Scope, after: Scope): void {
    if (before.link.id !== after.link.id || before.link.revision !== after.link.revision || before.link.subject !== after.link.subject ||
      before.link.learnerId !== after.link.learnerId || before.connector.id !== after.connector.id || before.connector.revision !== after.connector.revision ||
      before.connector.authorization !== after.connector.authorization || before.connector.policy.allowProgressNotifications !== after.connector.policy.allowProgressNotifications) fail(403, 'learning_access_revoked');
  }
  private async own(principal: LearningPrincipal, linkId: string, courseId: string, version: number, signal: AbortSignal): Promise<{ scope: Scope; access: LearningAccess; target: LearningProgressNotificationTarget }> {
    const scope = await this.scope(principal, linkId, signal);
    const access = await this.await(this.config.connections.access(principal, linkId, courseId, version, { content: false, progress: false }, signal), signal);
    const registration = selected(access);
    if (!registration || registration.learnerId !== scope.link.learnerId || registration.course.id !== courseId || registration.course.version !== version ||
      access.connectorId !== scope.connector.id || access.linkId !== scope.link.id || access.learnerId !== scope.link.learnerId) fail(403, 'learning_enrollment_required');
    this.unchanged(scope, await this.scope(principal, linkId, signal));
    return { scope, access, target: { registrationId: registration.id, courseId, version } };
  }
  private provider(scope: Scope): ScormCloudLearningProvider {
    return new ScormCloudLearningProvider({ authorization: scope.connector.authorization!, fetch: this.fetcher, now: this.clock });
  }
  private callback(linkId: string): string {
    if (!this.base) fail(503, 'learning_notifications_unavailable');
    return this.base + CALLBACK + linkId;
  }
  private expected(linkId: string, secret: string): Map<string, string> {
    return new Map([[SETTING.url, this.callback(linkId)], [SETTING.type, 'httpbasic'], [SETTING.user, linkId], [SETTING.passwordSetting, secret], [SETTING.format, 'course']]);
  }
  private settingEqual(id: string, a: string, b: string): boolean { return id === SETTING.type || id === SETTING.format ? a.toLowerCase() === b.toLowerCase() : equal(a, b); }
  private ours(settings: Settings, expected: Map<string, string>, emptyUrl = false): boolean {
    return KEYS.every(id => {
      const setting = settings.get(id), wanted = id === SETTING.url && emptyUrl ? '' : expected.get(id)!;
      return !!setting && setting.source === 'registration' && setting.explicit !== undefined && this.settingEqual(id, setting.value, wanted) && this.settingEqual(id, setting.explicit, wanted);
    });
  }
  private free(settings: Settings): boolean {
    return KEYS.every(id => {
      const setting = settings.get(id); if (!setting) return true;
      if (setting.explicit !== undefined || setting.source && setting.source !== 'default' && setting.value !== '') return false;
      if (([SETTING.url, SETTING.user, SETTING.passwordSetting] as string[]).includes(id)) return setting.value === '';
      return id === SETTING.type ? setting.value === '' || setting.value.toLowerCase() === 'form' : true;
    });
  }
  private path(id: string): string { if (!text(id)) fail(400, 'learning_request_invalid'); return '/registrations/' + encodeURIComponent(id) + '/configuration'; }
  private async cloud(scope: Scope, path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown | null> {
    this.live(signal); const url = CLOUD + path;
    const response = await this.await(this.fetcher(url, { method, redirect: 'error', signal,
      headers: { Authorization: scope.connector.authorization!, Accept: 'application/json', 'Cache-Control': 'no-store', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }), signal);
    if (response.redirected || response.url && response.url !== url) { await response.body?.cancel(); fail(502, 'learning_notifications_provider_invalid'); }
    if (response.status === 404 && method === 'GET') { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(response.status === 429 ? 429 : 502, 'learning_notifications_provider_unavailable'); }
    if (method !== 'GET') { await response.body?.cancel(); return true; }
    if (!/application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) { await response.body?.cancel(); fail(502, 'learning_notifications_provider_invalid'); }
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const part = await this.await(reader.read(), signal); if (part.done) break; bytes += part.value.byteLength;
        if (bytes > LEARNING_NOTIFICATION_LIMITS.configBytes) fail(413, 'learning_notifications_provider_capacity'); parts.push(part.value); }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes))); }
      catch { return fail(502, 'learning_notifications_provider_invalid'); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private async settings(scope: Scope, target: LearningProgressNotificationTarget, signal: AbortSignal): Promise<Settings | null> {
    const raw = await this.cloud(scope, this.path(target.registrationId), signal);
    if (raw === null) return null;
    if (!plain(raw) || !Array.isArray(raw.settingItems) || raw.settingItems.length > 3000) fail(502, 'learning_notifications_provider_invalid');
    const result: Settings = new Map();
    for (const item of raw.settingItems) {
      if (!plain(item) || typeof item.id !== 'string') fail(502, 'learning_notifications_provider_invalid');
      if (![...KEYS, IS_JSON].includes(item.id)) continue;
      if (result.has(item.id) || item.effectiveValue !== undefined && item.effectiveValue !== null && typeof item.effectiveValue !== 'string' ||
        item.explicitValue !== undefined && item.explicitValue !== null && typeof item.explicitValue !== 'string' ||
        item.effectiveValueSource !== undefined && !['default', 'application', 'learningStandardForApplication', 'dispatchDestination', 'course', 'dispatch', 'registration'].includes(String(item.effectiveValueSource))) fail(502, 'learning_notifications_provider_invalid');
      const value = typeof item.effectiveValue === 'string' ? item.effectiveValue : '';
      if (Buffer.byteLength(value) > 8192 || typeof item.explicitValue === 'string' && Buffer.byteLength(item.explicitValue) > 8192) fail(502, 'learning_notifications_provider_invalid');
      result.set(item.id, { value, ...(typeof item.explicitValue === 'string' ? { explicit: item.explicitValue } : {}),
        ...(typeof item.effectiveValueSource === 'string' ? { source: item.effectiveValueSource } : {}) });
    }
    if (result.get(IS_JSON)?.value.toLowerCase() === 'false') fail(409, 'learning_notifications_existing_callback');
    return result;
  }
  private dto(linkId: string, courseId: string, version: number, available: boolean, enabled: boolean, target?: LearningProgressNotificationTarget, notice?: string): Row {
    return { link_id: linkId, course_id: courseId, version, notifications: { available, enabled,
      ...(target?.lastReceiptAt ? { last_received_at: target.lastReceiptAt } : {}), notice: notice ?? (enabled
        ? 'Authenticated Cloud progress notifications are enabled for this enrollment. Notifications prompt a progress refresh; course answers still require a fresh authorized read.'
        : available ? 'Progress notifications are off for this enrollment.' : 'Your learning administrator has not enabled progress notifications for this connection.') } };
  }
  private async work<T>(linkId: string, caller: AbortSignal | undefined, run: (signal: AbortSignal, scope: { link: string; connector?: string }) => Promise<T>): Promise<T> {
    if (this.requests.size >= LEARNING_NOTIFICATION_LIMITS.active || this.locks.has(linkId)) fail(429, 'learning_notifications_busy');
    const controller = new AbortController(), scope = { link: linkId } as { link: string; connector?: string };
    const timeout = AbortSignal.timeout(LEARNING_NOTIFICATION_LIMITS.requestMs), signal = AbortSignal.any([controller.signal, timeout, ...(caller ? [caller] : [])]);
    this.requests.set(controller, scope); this.locks.add(linkId);
    try { return await run(signal, scope); }
    catch (error) { if (timeout.aborted) fail(504, 'learning_notifications_timeout'); throw error; }
    finally { this.requests.delete(controller); this.locks.delete(linkId); }
  }
  async request(principal: LearningPrincipal, raw: unknown): Promise<Row> {
    if (!boundedJson(raw) || !plain(raw) || Object.keys(raw).some(key => !['operation', 'link_id', 'course_id', 'version', 'confirmed'].includes(key)) ||
      !['enable-progress-notifications', 'disable-progress-notifications', 'progress-notification-status'].includes(String(raw.operation)) ||
      typeof raw.link_id !== 'string' || !/^[a-f0-9]{32}$/.test(raw.link_id) || !text(raw.course_id) || !Number.isSafeInteger(raw.version) || Number(raw.version) < 0 ||
      raw.operation !== 'progress-notification-status' && raw.confirmed !== true || raw.confirmed !== undefined && typeof raw.confirmed !== 'boolean') fail(400, 'learning_request_invalid');
    const operation = raw.operation, linkId = raw.link_id, courseId = raw.course_id, version = raw.version as number;
    return this.work(linkId, principal.signal, async (signal, active) => {
      let own = await this.own(principal, linkId, courseId, version, signal); active.connector = own.scope.connector.id;
      const available = own.scope.connector.policy.allowProgressNotifications === true;
      let config = validateNotifications(own.scope.link.notifications), target = config?.registrations.find(value => value.registrationId === own.target.registrationId && value.courseId === courseId && value.version === version);
      if (!available) {
        if (operation !== 'progress-notification-status') fail(403, 'learning_notifications_not_allowed');
        return this.dto(linkId, courseId, version, false, false, target);
      }
      if (operation === 'progress-notification-status') {
        if (!target || !config) return this.dto(linkId, courseId, version, true, false);
        const settings = await this.settings(own.scope, target, signal);
        this.unchanged(own.scope, await this.scope(principal, linkId, signal));
        const enabled = !!settings && this.ours(settings, this.expected(linkId, config.secret));
        return this.dto(linkId, courseId, version, true, enabled, target, enabled ? undefined : 'Cloud notification setup is not confirmed. Retry enabling it, or turn it off to remove this saved setup.');
      }
      if (operation === 'disable-progress-notifications') {
        if (!target || !config) return this.dto(linkId, courseId, version, true, false);
        await this.removeRemote(principal, own.scope, target, config.secret, signal, false);
        own = await this.own(principal, linkId, courseId, version, signal);
        if (!own.scope.link.notifications || !equal(own.scope.link.notifications.secret, config.secret)) fail(403, 'learning_access_revoked');
        const remaining = own.scope.link.notifications.registrations.filter(value => value.registrationId !== target!.registrationId);
        await this.await(this.config.connections.updateLinkNotifications(principal, linkId, own.scope.link.revision,
          remaining.length ? { secret: config.secret, registrations: remaining } : null), signal);
        await this.human(principal, signal);
        return this.dto(linkId, courseId, version, true, false);
      }
      const settings = await this.settings(own.scope, own.target, signal);
      if (!settings) fail(403, 'learning_enrollment_required');
      if (config && target && this.ours(settings, this.expected(linkId, config.secret))) {
        this.unchanged(own.scope, (await this.own(principal, linkId, courseId, version, signal)).scope);
        return this.dto(linkId, courseId, version, true, true, target);
      }
      if (!this.free(settings)) fail(409, 'learning_notifications_existing_callback');
      if (!target) {
        if (config && config.registrations.length >= LEARNING_NOTIFICATION_LIMITS.targets) fail(429, 'learning_notifications_capacity');
        const fresh = await this.own(principal, linkId, courseId, version, signal); this.unchanged(own.scope, fresh.scope);
        const latest = validateNotifications(fresh.scope.link.notifications);
        config = { secret: latest?.secret ?? randomBytes(24).toString('hex'), registrations: [...(latest?.registrations ?? []), own.target] };
        await this.await(this.config.connections.updateLinkNotifications(principal, linkId, fresh.scope.link.revision, config), signal);
        own = await this.own(principal, linkId, courseId, version, signal); target = own.target;
      }
      if (!config || !own.scope.link.notifications || !equal(config.secret, own.scope.link.notifications.secret)) fail(403, 'learning_access_revoked');
      const current = await this.settings(own.scope, own.target, signal);
      if (!current || !this.free(current)) fail(409, 'learning_notifications_existing_callback');
      const fresh = await this.own(principal, linkId, courseId, version, signal); this.unchanged(own.scope, fresh.scope);
      const expected = this.expected(linkId, config.secret);
      await this.cloud(fresh.scope, this.path(own.target.registrationId), signal, 'POST', { settings: [...expected].map(([settingId, value]) => ({ settingId, value, explicit: true })) });
      const after = await this.settings(fresh.scope, own.target, signal);
      if (!after || !this.ours(after, expected)) fail(502, 'learning_notifications_setup_incomplete');
      this.unchanged(fresh.scope, (await this.own(principal, linkId, courseId, version, signal)).scope);
      return this.dto(linkId, courseId, version, true, true, target);
    });
  }
  private async removeRemote(principal: LearningPrincipal, initial: Scope, target: LearningProgressNotificationTarget, secret: string, signal: AbortSignal, ownerCleanup: boolean): Promise<void> {
    const expected = this.expected(initial.link.id, secret);
    const revalidate = async () => { const fresh = await this.scope(principal, initial.link.id, signal, ownerCleanup); this.unchanged(initial, fresh); return fresh; };
    let settings = await this.settings(initial, target, signal);
    if (!settings || this.free(settings)) return;
    const partial = () => {
      const url = settings!.get(SETTING.url);
      return !!url && url.source === 'registration' && url.explicit === '' && url.value === '' && KEYS.filter(id => id !== SETTING.url).every(id => {
        const value = settings!.get(id); return !value?.explicit || value.source === 'registration' && this.settingEqual(id, value.explicit, expected.get(id)!) && this.settingEqual(id, value.value, expected.get(id)!);
      });
    };
    const registration = await this.await(this.provider(initial).getRegistration(target.registrationId, signal), signal);
    if (registration.learnerId !== initial.link.learnerId || registration.course.id !== target.courseId || registration.course.version !== target.version) fail(403, 'learning_enrollment_required');
    if (this.ours(settings, expected)) {
      const fresh = await revalidate();
      await this.cloud(fresh, this.path(target.registrationId), signal, 'POST', { settings: [{ settingId: SETTING.url, value: '', explicit: true }] });
      settings = await this.settings(fresh, target, signal);
    }
    if (!settings || !partial()) fail(409, 'learning_notifications_cleanup_required');
    for (const id of [SETTING.passwordSetting, SETTING.user, SETTING.type, SETTING.format]) {
      const current = settings.get(id);
      if (current?.explicit !== undefined) {
        if (current.source !== 'registration' || !this.settingEqual(id, current.explicit, expected.get(id)!)) fail(409, 'learning_notifications_cleanup_required');
        const fresh = await revalidate(); await this.cloud(fresh, this.path(target.registrationId) + '/' + id, signal, 'DELETE');
      }
      settings = await this.settings(initial, target, signal);
      if (!settings || !partial()) fail(409, 'learning_notifications_cleanup_required');
    }
    await this.cloud(await revalidate(), this.path(target.registrationId) + '/' + SETTING.url, signal, 'DELETE');
    settings = await this.settings(initial, target, signal);
    if (settings && KEYS.some(id => settings!.get(id)?.explicit !== undefined && this.settingEqual(id, settings!.get(id)!.explicit!, expected.get(id)!))) fail(409, 'learning_notifications_cleanup_required');
  }
  /** Call before revocation, while private provider credentials are still usable. */
  async cleanupLink(principal: LearningPrincipal, linkId: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(linkId)) fail(400, 'learning_request_invalid');
    await this.work(linkId, principal.signal, async (signal, active) => {
      // Pending/ended links without callbacks still need their ordinary revoke
      // operation; they need no provider enrollment or credential for cleanup.
      await this.human(principal, signal);
      const existingLink = await this.await(this.config.connections.readLink(linkId), signal);
      const existingConnector = existingLink && await this.await(this.config.connections.readConnector(existingLink.connectorId), signal);
      if (!existingLink || !existingConnector || existingLink.subject !== principal.subject && existingConnector.owner !== principal.subject) fail(403, 'learning_access_revoked');
      if (!validateNotifications(existingLink.notifications)) return;
      const scope = await this.scope(principal, linkId, signal, true); active.connector = scope.connector.id;
      const notifications = validateNotifications(scope.link.notifications); if (!notifications) return;
      for (const target of notifications.registrations) await this.removeRemote(principal, scope, target, notifications.secret, signal, true);
      const fresh = await this.scope(principal, linkId, signal, true); this.unchanged(scope, fresh);
      await this.await(this.config.connections.updateLinkNotifications(principal, linkId, fresh.link.revision, null), signal);
      await this.human(principal, signal);
    });
  }
  async cleanupConnector(principal: LearningPrincipal, connectorId: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(connectorId)) fail(400, 'learning_request_invalid');
    await this.human(principal, principal.signal);
    const connector = await this.await(this.config.connections.readConnector(connectorId), principal.signal);
    if (!connector || connector.owner !== principal.subject) fail(403, 'learning_access_revoked');
    const links = await this.await(this.config.connections.readConnectorLinks(connectorId), principal.signal);
    if (links.length > 256 || links.some(link => link.connectorId !== connectorId)) fail(503, 'learning_notifications_state_invalid');
    if (connector.status !== 'active') {
      if (links.some(link => link.notifications)) fail(409, 'learning_notifications_cleanup_required');
      return;
    }
    for (const link of links) if (link.notifications) await this.cleanupLink(principal, link.id);
  }
  /** Public callback accepts only a registration identifier as a trigger. */
  async receive(linkId: string, authorization: string | undefined, raw: unknown, caller?: AbortSignal): Promise<Row> {
    if (!/^[a-f0-9]{32}$/.test(linkId)) fail(401, 'learning_notifications_authentication_failed');
    return this.work(linkId, caller, async (signal, active) => {
      const link = await this.await(this.config.connections.readLink(linkId), signal);
      const notifications = link ? validateNotifications(link.notifications) : undefined;
      const expected = 'Basic ' + Buffer.from(linkId + ':' + (notifications?.secret ?? '0'.repeat(48))).toString('base64');
      const header = typeof authorization === 'string' && authorization.length <= 1024 ? authorization.replace(/^basic /i, 'Basic ') : '';
      if (!equal(header, expected) || !link || !notifications) fail(401, 'learning_notifications_authentication_failed');
      if (!boundedJson(raw) || !plain(raw) || Buffer.byteLength(JSON.stringify(raw)) > LEARNING_NOTIFICATION_LIMITS.payloadBytes || !text(raw.id)) fail(400, 'learning_notifications_payload_invalid');
      const target = notifications.registrations.find(value => value.registrationId === raw.id);
      if (!target) fail(403, 'learning_enrollment_required');
      const connector = await this.await(this.config.connections.readConnector(link.connectorId), signal); active.connector = link.connectorId;
      if (link.status !== 'active' || !text(link.learnerId) || !connector || connector.status !== 'active' || !connector.authorization || connector.policy.allowProgressNotifications !== true) fail(403, 'learning_access_revoked');
      const now = this.now(); for (const [id, rate] of this.rates) if (rate.since + 60_000 <= now) this.rates.delete(id);
      const rate = this.rates.get(linkId);
      if (rate && rate.count >= LEARNING_NOTIFICATION_LIMITS.linkRate || !rate && this.rates.size >= LEARNING_NOTIFICATION_LIMITS.rateLinks) fail(429, 'learning_notifications_busy');
      if (rate) rate.count++; else this.rates.set(linkId, { since: now, count: 1 });
      const registration = await this.await(this.provider({ link, connector }).getRegistration(target.registrationId, signal), signal);
      if (registration.learnerId !== link.learnerId || registration.course.id !== target.courseId || registration.course.version !== target.version) fail(403, 'learning_enrollment_required');
      const freshLink = await this.await(this.config.connections.readLink(linkId), signal);
      const freshConnector = await this.await(this.config.connections.readConnector(link.connectorId), signal);
      if (!freshLink || freshLink.status !== 'active' || !freshConnector || freshConnector.status !== 'active' || freshConnector.policy.allowProgressNotifications !== true ||
        !freshLink.notifications || !equal(freshLink.notifications.secret, notifications.secret) || !freshLink.notifications.registrations.some(value => value.registrationId === target.registrationId && value.courseId === target.courseId && value.version === target.version)) fail(403, 'learning_access_revoked');
      this.unchanged({ link, connector }, { link: freshLink, connector: freshConnector });
      const receivedAt = new Date(this.now()).toISOString();
      const saved = await this.await(this.config.connections.recordNotificationReceipt(linkId, freshLink.revision, target.registrationId, receivedAt), signal);
      if (saved === false) fail(403, 'learning_access_revoked');
      return { received: true, refresh_required: true, received_at: receivedAt };
    });
  }
  attachRoutes(app: Express): void {
    const parser = express.json({ limit: LEARNING_NOTIFICATION_LIMITS.payloadBytes, strict: true });
    app.post(CALLBACK + ':linkId', (req, res, next) => {
      res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
      if (Object.keys(req.query).length || !req.is('application/json')) { res.status(400).json({ error: 'learning_notifications_payload_invalid' }); return; }
      const length = req.get('Content-Length'); if (length && (!/^\d+$/.test(length) || Number(length) > LEARNING_NOTIFICATION_LIMITS.payloadBytes)) { res.status(413).json({ error: 'learning_notifications_payload_invalid' }); return; }
      parser(req, res, error => { if (error) res.status(400).json({ error: 'learning_notifications_payload_invalid' }); else next(); });
    }, async (req, res) => {
      const cancelled = new AbortController(), close = () => { if (!res.writableEnded) cancelled.abort(); }; res.on('close', close);
      try { const value = await this.receive(String(req.params.linkId), req.get('Authorization'), req.body, cancelled.signal); if (!cancelled.signal.aborted) res.json(value); }
      catch (error) { if (!cancelled.signal.aborted) {
        const known = error instanceof LearningNotificationsError || error instanceof LearningProviderError;
        res.status(known ? error.status : 503).json({ error: known ? error.code : 'learning_notifications_unavailable' });
      } } finally { res.off('close', close); }
    });
  }
  invalidateLink(id: string): void { for (const [controller, scope] of this.requests) if (scope.link === id) controller.abort(); }
  invalidateConnector(id: string): void { for (const [controller, scope] of this.requests) if (scope.connector === id) controller.abort(); }
  dispose(): void { this.disposed = true; for (const controller of this.requests.keys()) controller.abort(); this.rates.clear(); }
}
