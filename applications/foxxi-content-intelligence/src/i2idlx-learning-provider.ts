/** Per-connector SCORM Cloud registration access. Learner identifiers
 * come from an independently verified server-held account link, never LTI sub
 * parsing, an email match, or a student-selected request field.
 * Protocol: https://cloud.scorm.com/docs/swagger.json */

export interface LearningRegistration {
  id: string;
  learnerId: string;
  course: { id: string; title: string; version: number };
  progress: {
    completion: 'UNKNOWN' | 'COMPLETED' | 'INCOMPLETE';
    success: 'UNKNOWN' | 'PASSED' | 'FAILED';
    completionAmount?: number;
    /** SCORM Cloud's ScoreSchema uses a percentage, 0–100. */
    score?: { scaled: number };
    totalSeconds?: number;
  };
  observedAt: string;
}
/** Published provider activity metadata, not a runtime bookmark or source URL. */
export interface LearningCourseActivity {
  itemIdentifier?: string; resourceIdentifier?: string; href?: string; title?: string;
  activityType: 'UNKNOWN' | 'AGGREGATION' | 'SCO' | 'ASSET' | 'OBJECTIVE';
  children: LearningCourseActivity[];
}
export interface LearningCourseStructure {
  id: string; title: string; version: number; rootActivity?: LearningCourseActivity;
}
export class LearningProviderError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'learning_provider_unavailable') { super(message); }
}
export interface ScormCloudLearningProviderConfig {
  /** Trusted connector configuration only; never exposed in a normalized result. */
  authorization: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
export const LEARNING_PROVIDER_LIMITS = Object.freeze({
  pageBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024,
  pageEntries: 100, registrations: 1000, pages: 100, timeoutMs: 20_000,
});
export const SCORM_CLOUD_LEARNING_CAPABILITIES = Object.freeze({
  enrollments: true, progress: true, prerequisites: false, curriculum: false,
  registrationLaunch: true, access: 'registration-read-and-explicit-launch' as const,
});
type Row = Record<string, unknown>;
const CLOUD = 'https://cloud.scorm.com/api/v2';
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message: string, status = 502, code = 'learning_provider_invalid'): never { throw new LearningProviderError(message, status, code); }
function text(value: unknown, max: number, input = false): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value) > max ||
    /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value).toString('utf8') !== value || value === '.' || value === '..') {
    fail(input ? 'The learning request contains an invalid identifier.' : 'SCORM Cloud returned an invalid registration field.',
      input ? 400 : 502, input ? 'learning_request_invalid' : 'learning_provider_invalid');
  }
  return value;
}
function version(value: unknown, input = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(input ? 'Select a valid course version.' : 'SCORM Cloud returned an invalid course version.',
    input ? 400 : 502, input ? 'learning_request_invalid' : 'learning_provider_invalid');
  return value as number;
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) fail('SCORM Cloud returned invalid registration progress.');
  return value;
}
function normalize(raw: unknown, observedAt: string): LearningRegistration {
  if (!object(raw) || !object(raw.course) || !object(raw.learner)) fail('SCORM Cloud returned an incomplete registration.');
  const completion = raw.registrationCompletion ?? 'UNKNOWN', success = raw.registrationSuccess ?? 'UNKNOWN';
  if (!['UNKNOWN', 'COMPLETED', 'INCOMPLETE'].includes(completion as string) || !['UNKNOWN', 'PASSED', 'FAILED'].includes(success as string)) {
    fail('SCORM Cloud returned unsupported registration progress.');
  }
  const progress: LearningRegistration['progress'] = {
    completion: completion as LearningRegistration['progress']['completion'], success: success as LearningRegistration['progress']['success'],
  };
  if (raw.registrationCompletionAmount !== undefined && raw.registrationCompletionAmount !== null) progress.completionAmount = number(raw.registrationCompletionAmount);
  if (raw.totalSecondsTracked !== undefined && raw.totalSecondsTracked !== null) progress.totalSeconds = number(raw.totalSecondsTracked);
  if (raw.score !== undefined && raw.score !== null) {
    if (!object(raw.score)) fail('SCORM Cloud returned invalid registration progress.');
    if (raw.score.scaled !== undefined && raw.score.scaled !== null) progress.score = { scaled: number(raw.score.scaled, 100) };
  }
  const courseId = text(raw.course.id, 256);
  return { id: text(raw.id, 256), learnerId: text(raw.learner.id, 256),
    course: { id: courseId, title: raw.course.title === undefined || raw.course.title === null ? courseId : text(raw.course.title, 400), version: version(raw.course.version) },
    progress, observedAt };
}
function course(raw: unknown, id: string, expectedVersion?: number): LearningCourseStructure {
  if (!object(raw) || raw.id !== id) fail('SCORM Cloud returned a different course.');
  const result: LearningCourseStructure = { id, title: raw.title === undefined || raw.title === null ? id : text(raw.title, 400), version: version(raw.version) };
  if (expectedVersion !== undefined && result.version !== expectedVersion) fail('SCORM Cloud returned a different course version.');
  let count = 0;
  function activity(value: unknown, depth: number): LearningCourseActivity {
    if (!object(value) || ++count > 2000 || depth > 32) fail('SCORM Cloud returned unsupported course activity metadata.');
    const type = value.activityType ?? 'UNKNOWN';
    if (!['UNKNOWN', 'AGGREGATION', 'SCO', 'ASSET', 'OBJECTIVE'].includes(type as string) || value.children !== undefined && !Array.isArray(value.children)) fail('SCORM Cloud returned unsupported course activity metadata.');
    return { activityType: type as LearningCourseActivity['activityType'],
      ...(value.itemIdentifier === undefined || value.itemIdentifier === null || value.itemIdentifier === '' ? {} : { itemIdentifier: text(value.itemIdentifier, 256) }),
      ...(value.resourceIdentifier === undefined || value.resourceIdentifier === null || value.resourceIdentifier === '' ? {} : { resourceIdentifier: text(value.resourceIdentifier, 256) }),
      ...(value.href === undefined || value.href === null || value.href === '' ? {} : { href: text(value.href, 2048) }),
      ...(value.title === undefined || value.title === null || value.title === '' ? {} : { title: text(value.title, 400) }),
      children: (value.children as unknown[] | undefined ?? []).map(child => activity(child, depth + 1)) };
  }
  if (raw.rootActivity !== undefined && raw.rootActivity !== null) result.rootActivity = activity(raw.rootActivity, 0);
  return result;
}
function checkAbort(signal: AbortSignal, caller?: AbortSignal): void {
  if (signal.aborted) fail(caller?.aborted ? 'The learning request was cancelled.' : 'SCORM Cloud did not answer before the request expired.',
    caller?.aborted ? 499 : 504, caller?.aborted ? 'learning_request_cancelled' : 'learning_provider_timeout');
}

export class ScormCloudLearningProvider {
  readonly capabilities = SCORM_CLOUD_LEARNING_CAPABILITIES;
  readonly #authorization: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly clock: () => number;
  constructor(config: ScormCloudLearningProviderConfig) {
    if (typeof config.authorization !== 'string' || config.authorization.length > 8192 ||
      !/^(?:Basic|Bearer) [\x21-\x7e]+$/.test(config.authorization)) fail('A valid private provider credential is required.', 400, 'learning_request_invalid');
    this.#authorization = config.authorization; this.fetcher = config.fetch ?? globalThis.fetch; this.clock = config.now ?? Date.now;
  }
  private async operation<T>(caller: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([AbortSignal.timeout(LEARNING_PROVIDER_LIMITS.timeoutMs), ...(caller ? [caller] : [])]);
    checkAbort(signal, caller);
    try { const result = await work(signal); checkAbort(signal, caller); return result; }
    catch (error) {
      checkAbort(signal, caller);
      if (error instanceof LearningProviderError) throw error;
      return fail('SCORM Cloud could not verify the requested learning records.', 502, 'learning_provider_unavailable');
    }
  }
  private async read(path: string, signal: AbortSignal, budget: { bytes: number }, body?: Row): Promise<unknown> {
    checkAbort(signal);
    const target = CLOUD + path;
    const response = await this.fetcher(target, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { Authorization: this.#authorization, Accept: 'application/json', 'Cache-Control': 'no-store', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (signal.aborted) await response.body?.cancel().catch(() => undefined);
    checkAbort(signal);
    if (response.redirected || response.url && response.url !== target) { await response.body?.cancel(); fail('SCORM Cloud returned an unexpected response location.'); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) fail('SCORM Cloud refused the connector credential.', 401, 'learning_provider_authentication_failed');
      if (response.status === 403) fail('SCORM Cloud did not authorize this registration read.', 403, 'learning_provider_permission_denied');
      if (response.status === 404) fail('The SCORM Cloud registration is no longer available.', 404, 'learning_registration_not_found');
      if (response.status === 429) fail('SCORM Cloud is busy. Try again shortly.', 429, 'learning_provider_rate_limited');
      fail('SCORM Cloud could not verify the requested learning records.', 502, 'learning_provider_unavailable');
    }
    if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); fail('SCORM Cloud returned an unsupported registration response.');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > LEARNING_PROVIDER_LIMITS.pageBytes)) {
      await response.body?.cancel(); fail('The registration response exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
    }
    if (!response.body) fail('SCORM Cloud returned an empty registration response.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => { abort = () => reject(new LearningProviderError('The registration read was interrupted.', 504, 'learning_provider_timeout')); });
    signal.addEventListener('abort', abort, { once: true });
    try {
      checkAbort(signal);
      while (true) {
        const result = await Promise.race([reader.read(), aborted]); checkAbort(signal);
        if (result.done) break;
        size += result.value.byteLength; budget.bytes += result.value.byteLength;
        if (size > LEARNING_PROVIDER_LIMITS.pageBytes || budget.bytes > LEARNING_PROVIDER_LIMITS.totalBytes) {
          fail('The registration response exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
        }
        chunks.push(result.value);
      }
      const bytes = Buffer.concat(chunks, size);
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return JSON.parse(decoded); }
      catch { return fail('SCORM Cloud returned invalid registration JSON.'); }
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => undefined); reader.releaseLock();
    }
  }
  private observedAt(): string {
    const now = this.clock(); if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) fail('The learning record observation time is unavailable.');
    return new Date(now).toISOString();
  }
  private async get(id: string, signal: AbortSignal, budget: { bytes: number }): Promise<LearningRegistration> {
    const result = normalize(await this.read('/registrations/' + encodeURIComponent(id), signal, budget), this.observedAt());
    if (result.id !== id) fail('SCORM Cloud returned a different registration.');
    return result;
  }
  private async own(learnerId: string, signal: AbortSignal, budget: { bytes: number }): Promise<LearningRegistration[]> {
    const all: LearningRegistration[] = [], ids = new Set<string>(), cursors = new Set<string>(); let more: string | undefined;
    for (let page = 0; page < LEARNING_PROVIDER_LIMITS.pages; page++) {
      const query = new URLSearchParams(more === undefined ? { learnerId } : { more });
      const raw = await this.read('/registrations?' + query, signal, budget);
      if (!object(raw) || !Array.isArray(raw.registrations)) fail('SCORM Cloud returned an unsupported registration list.');
      if (raw.registrations.length > LEARNING_PROVIDER_LIMITS.pageEntries || all.length + raw.registrations.length > LEARNING_PROVIDER_LIMITS.registrations) {
        fail('The registration list exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
      }
      const observedAt = this.observedAt();
      for (const value of raw.registrations) {
        const registration = normalize(value, observedAt);
        if (registration.learnerId !== learnerId) fail('SCORM Cloud did not preserve the selected learner boundary.');
        if (ids.has(registration.id)) fail('SCORM Cloud returned duplicate registrations.');
        ids.add(registration.id); all.push(registration);
      }
      if (raw.more === undefined || raw.more === null || raw.more === '') return all;
      more = text(raw.more, 4096);
      if (cursors.has(more)) fail('SCORM Cloud returned a repeated registration page.');
      cursors.add(more);
    }
    return fail('The registration list exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
  }
  /** Only the trusted connector administrator may use this to establish an association. */
  async getRegistration(id: string, signal?: AbortSignal): Promise<LearningRegistration> {
    id = text(id, 256, true);
    return this.operation(signal, active => this.get(id, active, { bytes: 0 }));
  }
  /** learnerId is read from the server-held verified link, never a student request. */
  async listOwnRegistrations(learnerId: string, signal?: AbortSignal): Promise<LearningRegistration[]> {
    learnerId = text(learnerId, 256, true);
    return this.operation(signal, active => this.own(learnerId, active, { bytes: 0 }));
  }
  async authorizeCourse(learnerId: string, courseId: string, courseVersion: number, signal?: AbortSignal): Promise<LearningRegistration[]> {
    learnerId = text(learnerId, 256, true); courseId = text(courseId, 256, true); courseVersion = version(courseVersion, true);
    return this.operation(signal, async active => {
      const budget = { bytes: 0 };
      const matching = (await this.own(learnerId, active, budget)).filter(row => row.course.id === courseId && row.course.version === courseVersion);
      if (!matching.length) fail('A current registration for this learner and course version is required.', 403, 'learning_enrollment_required');
      const current: LearningRegistration[] = [];
      for (const candidate of matching) {
        const registration = await this.get(candidate.id, active, budget);
        if (registration.learnerId !== learnerId || registration.course.id !== courseId || registration.course.version !== courseVersion) {
          fail('The registration no longer authorizes this learner and course version.', 403, 'learning_enrollment_required');
        }
        current.push(registration);
      }
      return current;
    });
  }
  async getCourseStructure(courseId: string, courseVersion: number, signal?: AbortSignal): Promise<LearningCourseStructure> {
    courseId = text(courseId, 256, true); courseVersion = version(courseVersion, true);
    return this.operation(signal, async active => course(await this.read('/courses/' + encodeURIComponent(courseId) + '/versions/' + courseVersion, active, { bytes: 0 }), courseId, courseVersion));
  }
  async permitsStableRegistrationVersion(registrationId: string, signal?: AbortSignal): Promise<boolean> {
    registrationId = text(registrationId, 256, true);
    return this.operation(signal, async active => {
      // This is the bottom-most effective configuration actually used at launch,
      // including inherited values; course-level defaults alone are insufficient.
      const raw = await this.read('/registrations/' + encodeURIComponent(registrationId) + '/configuration', active, { bytes: 0 });
      if (!object(raw) || !Array.isArray(raw.settingItems) || raw.settingItems.length > 2000) fail('SCORM Cloud returned unsupported launch configuration.');
      const values = raw.settingItems.filter(value => object(value) && value.id === 'WhenToRestartRegistration');
      return values.length === 1 && object(values[0]) && values[0].effectiveValue === 'NEVER';
    });
  }
  /** Existing registration only. The caller must independently authorize this human. */
  async createLaunchLink(registrationId: string, options: { redirectOnExitUrl: string; expiry: number; startSco?: string }, signal?: AbortSignal): Promise<string> {
    registrationId = text(registrationId, 256, true);
    if (options.expiry !== 120) fail('A short-lived launch request is required.', 400, 'learning_request_invalid');
    let redirect: URL;
    try { redirect = new URL(options.redirectOnExitUrl); } catch { return fail('A fixed secure return address is required.', 400, 'learning_request_invalid'); }
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password) fail('A fixed secure return address is required.', 400, 'learning_request_invalid');
    const body: Row = { redirectOnExitUrl: redirect.href, expiry: 120, tracking: true };
    if (options.startSco !== undefined) body.startSco = text(options.startSco, 256, true);
    return this.operation(signal, async active => {
      const raw = await this.read('/registrations/' + encodeURIComponent(registrationId) + '/launchLink', active, { bytes: 0 }, body);
      if (!object(raw)) return fail('SCORM Cloud returned an unsupported launch response.');
      return text(raw.launchLink, 8192);
    });
  }
}
