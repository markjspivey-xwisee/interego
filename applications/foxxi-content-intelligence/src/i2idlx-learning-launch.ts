/** Deliberate human launches of existing enrollments. No launch capability enters
 * model context or durable storage. Location references contain metadata only. */
import { randomBytes } from 'node:crypto';
import { LearningAuthError, type LearningAccountAuth, type LearningPrincipal } from './i2idlx-learning-auth.js';
import { LearningConnectionsError, type LearningAccess, type LearningConnectionsStore } from './i2idlx-learning-connections.js';
import { LearningProviderError, ScormCloudLearningProvider, type LearningCourseActivity, type LearningCourseStructure } from './i2idlx-learning-provider.js';
import { sourceServiceUrl } from './i2idlx-course-provider.js';

type Row = Record<string, unknown>;
export interface LearningNavigationLocation {
  citation_id: string; source_file: string; precision: 'published-file';
  target_kind: 'course' | 'activity'; location_ref?: string; title?: string;
}
export interface LearningNavigation { course: { kind: 'course' }; locations: LearningNavigationLocation[]; }
export interface LearningLaunchConfig {
  baseUrl: string; auth: Pick<LearningAccountAuth, 'revalidate'>;
  connections: LearningConnectionsStore; fetch?: typeof fetch; now?: () => number;
}
export class LearningLaunchError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const LEARNING_LAUNCH_LIMITS = Object.freeze({ active: 8, perMinute: 20, rateSessions: 1024,
  requestMs: 30_000, referenceMs: 5 * 60_000, references: 2048, referencesPerSession: 128, expirySeconds: 120 });
type Location = { principal: LearningPrincipal; connectorId: string; linkId: string; revision: string;
  courseId: string; version: number; file: string; item: string; title: string; expires: number };
const object = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v && v === v.trim() && Buffer.byteLength(v) <= limit && !/[\u0000-\u001f\u007f]/.test(v);
function fail(status: number, code: string): never { throw new LearningLaunchError(status, code); }
function sameHuman(a: LearningPrincipal, b: LearningPrincipal): boolean {
  return a.subject === b.subject && a.userId === b.userId && a.webId === b.webId && a.podUrl === b.podUrl && a.sessionId === b.sessionId && a.signal === b.signal;
}
function file(value: unknown): value is string {
  return text(value, 2048) && !/[\\?#%:]/.test(value) && !value.startsWith('/') && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
/** Provider capabilities are accepted only from the documented Cloud launch path. */
export function validateLearningLaunchUrl(raw: unknown): string {
  if (!text(raw, 8192)) fail(502, 'learning_launch_invalid');
  let url: URL; try { url = new URL(raw); } catch { return fail(502, 'learning_launch_invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'cloud.scorm.com' || url.port || url.username || url.password || url.hash ||
    !url.pathname.startsWith('/api/cloud/registration/launch/') || url.pathname.length <= '/api/cloud/registration/launch/'.length) fail(502, 'learning_launch_invalid');
  return url.href;
}
function activities(course: LearningCourseStructure): LearningCourseActivity[] {
  const result: LearningCourseActivity[] = [];
  const visit = (activity: LearningCourseActivity) => { result.push(activity); activity.children.forEach(visit); };
  if (course.rootActivity) visit(course.rootActivity); return result;
}
/** A source filename does not identify an intra-SCO page or bypass sequencing. */
function target(course: LearningCourseStructure, sourceFile: string): LearningCourseActivity | undefined {
  const all = activities(course), scos = all.filter(value => value.activityType === 'SCO' && value.itemIdentifier && file(value.href));
  if (scos.length < 2) return undefined;
  const matching = scos.filter(value => value.href === sourceFile);
  const chosen = matching.length === 1 ? matching[0] : undefined;
  if (!chosen || all.filter(value => value.itemIdentifier === chosen.itemIdentifier).length !== 1) return undefined;
  return chosen;
}
function selectedRegistration(access: LearningAccess) {
  return access.registrations.find(value => value.id === access.associatedRegistrationId) ?? (access.registrations.length === 1 ? access.registrations[0] : undefined);
}
async function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail(403, 'learning_access_revoked');
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new LearningLaunchError(403, 'learning_access_revoked')); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener('abort', abort); }
}

export class LearningLaunchService {
  private readonly clock: () => number;
  private readonly returnUrl: string | null;
  private readonly locations = new Map<string, Location>();
  private readonly rates = new Map<string, { since: number; count: number }>();
  private readonly requests = new Map<AbortController, { session: string; link: string; connector?: string }>();
  private disposed = false;
  constructor(private readonly config: LearningLaunchConfig) {
    let origin: string | null = null;
    try { const base = sourceServiceUrl(config.baseUrl); if (base.pathname === '/' && !base.search && !base.hash) origin = base.origin; } catch { /* local HTTP workbench remains available without learning launches */ }
    this.returnUrl = origin ? new URL('/i2idlx/#ask', origin).href : null; this.clock = config.now ?? Date.now;
  }
  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) fail(503, 'learning_launch_unavailable'); return value; }
  private live(principal: LearningPrincipal): void {
    if (this.disposed || !principal?.signal || principal.signal.aborted || !Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= this.now()) fail(403, 'learning_access_revoked');
  }
  private async human(principal: LearningPrincipal): Promise<LearningPrincipal> {
    this.live(principal); const current = await this.config.auth.revalidate(principal);
    if (!sameHuman(current, principal)) fail(403, 'learning_access_revoked'); this.live(current); return current;
  }
  private sweep(): void {
    const now = this.now();
    for (const [id, value] of this.locations) if (value.expires <= now || value.principal.signal.aborted) this.locations.delete(id);
    for (const [id, rate] of this.rates) if (rate.since + 60_000 <= now) this.rates.delete(id);
  }
  invalidateLink(id: string): void {
    for (const [key, value] of this.locations) if (value.linkId === id) this.locations.delete(key);
    for (const [controller, scope] of this.requests) if (scope.link === id) controller.abort();
  }
  invalidateConnector(id: string): void {
    for (const [key, value] of this.locations) if (value.connectorId === id) this.locations.delete(key);
    for (const [controller, scope] of this.requests) if (scope.connector === id) controller.abort();
  }
  dispose(): void { this.disposed = true; this.locations.clear(); this.rates.clear(); for (const controller of this.requests.keys()) controller.abort(); }
  private provider(access: LearningAccess): ScormCloudLearningProvider { return new ScormCloudLearningProvider({ authorization: access.authorization, fetch: this.config.fetch, now: this.clock }); }
  private sameAccess(first: LearningAccess, next: LearningAccess): void {
    if (first.revision !== next.revision || first.connectorId !== next.connectorId || first.linkId !== next.linkId) fail(403, 'learning_access_revoked');
  }
  private normalize(error: unknown): never {
    if (error instanceof LearningLaunchError) throw error;
    if (error instanceof LearningAuthError || error instanceof LearningConnectionsError || error instanceof LearningProviderError) fail(error.status, error.code);
    return fail(503, 'learning_launch_unavailable');
  }
  /** Program-only: citations must be the sections actually returned by retrieval.
   * This stores filenames/identifiers only, never passages or provider credentials. */
  async prepareNavigation(principal: LearningPrincipal, access: LearningAccess, courseId: string, version: number,
    citations: readonly Row[], signal?: AbortSignal): Promise<LearningNavigation> {
    this.sweep(); this.live(principal);
    const locations: LearningNavigationLocation[] = citations.slice(0, 100).filter(c => text(c.id, 200) && file(c.locator)).map(c => ({
      citation_id: c.id as string, source_file: c.locator as string, precision: 'published-file', target_kind: 'course', ...(text(c.title, 400) ? { title: c.title } : {}) }));
    const navigation: LearningNavigation = { course: { kind: 'course' }, locations };
    const registration = selectedRegistration(access);
    if (!this.returnUrl || !registration || access.policy.allowTargetedLaunch !== true || !locations.length) return navigation;
    const active = AbortSignal.any([principal.signal, ...(signal ? [signal] : []), AbortSignal.timeout(LEARNING_LAUNCH_LIMITS.requestMs)]);
    const provider = this.provider(access);
    let course: LearningCourseStructure;
    try {
      if (!await interrupted(provider.permitsStableRegistrationVersion(registration.id, active), active)) return navigation;
      course = await interrupted(provider.getCourseStructure(courseId, version, active), active);
    } catch (error) {
      // Unsupported/missing provider metadata reduces navigation to a course launch.
      if (active.aborted) fail(403, 'learning_access_revoked');
      if (error instanceof LearningProviderError) return navigation;
      return this.normalize(error);
    }
    await interrupted(this.human(principal), active);
    const current = await interrupted(this.config.connections.access(principal, access.linkId, courseId, version, { content: false, progress: false }, active), active);
    this.sameAccess(access, current); this.live(principal);
    const existing = [...this.locations.values()].filter(value => value.principal.sessionId === principal.sessionId).length, refs = new Map<string, string>();
    for (const location of locations) {
      const activity = target(course, location.source_file);
      if (!activity?.itemIdentifier) continue;
      let ref = refs.get(location.source_file);
      if (!ref) {
        if (this.locations.size >= LEARNING_LAUNCH_LIMITS.references || existing + refs.size >= LEARNING_LAUNCH_LIMITS.referencesPerSession) continue;
        ref = randomBytes(32).toString('hex'); refs.set(location.source_file, ref);
        this.locations.set(ref, { principal: { ...principal }, connectorId: access.connectorId, linkId: access.linkId, revision: access.revision,
          courseId, version, file: location.source_file, item: activity.itemIdentifier, title: activity.title ?? location.title ?? course.title,
          expires: Math.min(principal.expiresAt, this.now() + LEARNING_LAUNCH_LIMITS.referenceMs) });
      }
      location.target_kind = 'activity'; location.location_ref = ref;
    }
    return navigation;
  }
  async launch(principal: LearningPrincipal, raw: unknown, signal?: AbortSignal): Promise<Row> {
    if (!this.returnUrl) fail(503, 'learning_launch_unavailable');
    if (!object(raw) || Object.keys(raw).some(key => !['link_id', 'course_id', 'version', 'location_ref'].includes(key)) ||
      !text(raw.link_id, 256) || !text(raw.course_id, 256) || !Number.isSafeInteger(raw.version) || Number(raw.version) < 0 ||
      raw.location_ref !== undefined && (typeof raw.location_ref !== 'string' || !/^[a-f0-9]{64}$/.test(raw.location_ref))) fail(400, 'learning_request_invalid');
    this.sweep(); this.live(principal);
    const rate = this.rates.get(principal.sessionId);
    if (this.requests.size >= LEARNING_LAUNCH_LIMITS.active || [...this.requests.values()].some(value => value.session === principal.sessionId) ||
      rate && rate.count >= LEARNING_LAUNCH_LIMITS.perMinute || !rate && this.rates.size >= LEARNING_LAUNCH_LIMITS.rateSessions) fail(429, 'learning_launch_busy');
    if (rate) rate.count++; else this.rates.set(principal.sessionId, { since: this.now(), count: 1 });
    const linkId = raw.link_id, courseId = raw.course_id, version = raw.version as number, reference = raw.location_ref;
    const controller = new AbortController(), scope: { session: string; link: string; connector?: string } = { session: principal.sessionId, link: linkId };
    this.requests.set(controller, scope);
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, LEARNING_LAUNCH_LIMITS.requestMs); timer.unref();
    const active = AbortSignal.any([principal.signal, controller.signal, ...(signal ? [signal] : [])]);
    try {
      await interrupted(this.human(principal), active);
      const before = await interrupted(this.config.connections.access(principal, linkId, courseId, version, { content: false, progress: false }, active), active);
      scope.connector = before.connectorId;
      const registration = selectedRegistration(before);
      if (!registration) fail(409, 'learning_launch_registration_ambiguous');
      const provider = this.provider(before);
      let destination: Row = { kind: 'course', title: registration.course.title }, startSco: string | undefined;
      if (reference !== undefined) {
        const location = this.locations.get(reference as string);
        if (!location || !sameHuman(location.principal, principal) || location.linkId !== linkId || location.courseId !== courseId || location.version !== version ||
          location.connectorId !== before.connectorId || location.revision !== before.revision || location.expires <= this.now()) fail(403, 'learning_launch_location_expired');
        if (before.policy.allowTargetedLaunch !== true) fail(403, 'learning_targeted_launch_not_allowed');
        if (!await interrupted(provider.permitsStableRegistrationVersion(registration.id, active), active)) fail(409, 'learning_launch_location_unavailable');
        const course = await interrupted(provider.getCourseStructure(courseId, version, active), active), activity = target(course, location.file);
        if (!activity?.itemIdentifier || activity.itemIdentifier !== location.item) fail(409, 'learning_launch_location_unavailable');
        startSco = activity.itemIdentifier; destination = { kind: 'activity', title: activity.title ?? location.title, source_file: location.file };
      }
      // Revalidate immediately before the only provider write: minting an existing
      // registration's short-lived launch capability, with normal tracking enabled.
      await interrupted(this.human(principal), active);
      const ready = await interrupted(this.config.connections.access(principal, linkId, courseId, version, { content: false, progress: false }, active), active);
      this.sameAccess(before, ready);
      if (!ready.registrations.some(value => value.id === registration.id)) fail(403, 'learning_enrollment_required');
      const mintedAt = this.now();
      const launchUrl = validateLearningLaunchUrl(await interrupted(provider.createLaunchLink(registration.id,
        { redirectOnExitUrl: this.returnUrl, expiry: LEARNING_LAUNCH_LIMITS.expirySeconds, ...(startSco ? { startSco } : {}) }, active), active));
      if (startSco && !await interrupted(provider.permitsStableRegistrationVersion(registration.id, active), active)) fail(409, 'learning_launch_location_unavailable');
      await interrupted(this.human(principal), active);
      const after = await interrupted(this.config.connections.access(principal, linkId, courseId, version, { content: false, progress: false }, active), active);
      this.sameAccess(before, after);
      if (!after.registrations.some(value => value.id === registration.id)) fail(403, 'learning_enrollment_required');
      this.live(principal); if (active.aborted) fail(403, 'learning_access_revoked');
      const expires = mintedAt + LEARNING_LAUNCH_LIMITS.expirySeconds * 1000;
      if (expires <= this.now()) fail(504, 'learning_launch_expired');
      return { launch_url: launchUrl, expires_at: new Date(expires).toISOString(), destination, tracking: true,
        notice: startSco ? 'The connection owner permits starting this published activity out of sequence. SCORM Cloud controls resume, course version and progress tracking; this does not jump to an internal slide.'
          : 'SCORM Cloud controls resume, course version and progress tracking. The cited source version is not a guarantee of the version opened at launch.' };
    } catch (error) {
      if (expired) fail(504, 'learning_launch_timeout');
      if (active.aborted) fail(403, 'learning_access_revoked');
      return this.normalize(error);
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
}
