/** Per-connector SCORM Cloud registration access. Learner identifiers
 * come from an independently verified server-held account link, never LTI sub
 * parsing, an email match, or a student-selected request field.
 * Protocol: https://cloud.scorm.com/docs/swagger.json */

export interface LearningRegistration {
  id: string;
  learnerId: string;
  /** Private provider instance counter for current-attempt revalidation. */
  instance?: number;
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
export interface LearningOwnedCourse { id: string; title: string; version: number; }
export interface LearningReviewInteraction {
  id: string;
  /** Provider observation, not a grade recomputed by this reader. */
  result: string;
  learnerResponse?: string;
  /** An explicitly zoned provider timestamp; local/time-only values are not inferred. */
  timestamp?: string;
}
export interface LearningReviewActivity {
  id: string; title?: string;
  completion: 'UNKNOWN' | 'COMPLETED' | 'INCOMPLETE';
  success: 'UNKNOWN' | 'PASSED' | 'FAILED';
  /** Provider activity-attempt count, not a reconstructed response history. */
  attempts?: number;
  submission: 'completed' | 'terminal-lesson-status';
  interactions: LearningReviewInteraction[];
}
/** Internal identity envelope. The caller must project private identifiers out of model/browser DTOs. */
export interface LearningCompletedReview {
  registrationId: string; learnerId: string;
  course: { id: string; title: string; version: number };
  instance?: number; observedAt: string;
  activities: LearningReviewActivity[];
  omittedInProgressActivities: number;
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
  pageEntries: 100, registrations: 1000, courses: 1000, pages: 100, timeoutMs: 20_000,
});
export const LEARNING_REVIEW_LIMITS = Object.freeze({
  responseBytes: 1024 * 1024, activities: 256, depth: 24,
  interactions: 500, interactionsPerActivity: 200, responseTextBytes: 4096,
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
  const instance = reviewInstance(raw);
  return { id: text(raw.id, 256), learnerId: text(raw.learner.id, 256),
    ...(instance === undefined ? {} : { instance }),
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
function reviewInstance(raw: unknown): number | undefined {
  if (!object(raw) || raw.instance === undefined || raw.instance === null) return undefined;
  if (!Number.isSafeInteger(raw.instance) || Number(raw.instance) < 0 || Number(raw.instance) > 2_147_483_647) fail('SCORM Cloud returned an invalid registration instance.');
  return raw.instance as number;
}
function reviewActivities(raw: unknown): Pick<LearningCompletedReview, 'activities' | 'omittedInProgressActivities'> {
  const activities: LearningReviewActivity[] = [];
  let visited = 0, interactions = 0, omittedInProgressActivities = 0;
  const state = (value: unknown, values: readonly string[]): string => {
    if (value === undefined || value === null) return 'UNKNOWN';
    if (typeof value !== 'string' || !values.includes(value)) fail('SCORM Cloud returned unsupported activity review status.');
    return value;
  };
  const response = (value: unknown): string => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > LEARNING_REVIEW_LIMITS.responseTextBytes ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || Buffer.from(value).toString('utf8') !== value) {
      fail('SCORM Cloud returned an unsupported learner response.');
    }
    return value;
  };
  function visit(value: unknown, depth: number): void {
    if (!object(value) || ++visited > LEARNING_REVIEW_LIMITS.activities || depth > LEARNING_REVIEW_LIMITS.depth) {
      fail('The activity review exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
    }
    if (value.children !== undefined && value.children !== null && !Array.isArray(value.children) ||
      value.runtime !== undefined && value.runtime !== null && !object(value.runtime)) fail('SCORM Cloud returned an unsupported activity review.');
    const runtime = object(value.runtime) ? value.runtime : undefined, items = runtime?.runtimeInteractions;
    if (items !== undefined && items !== null && !Array.isArray(items)) fail('SCORM Cloud returned unsupported interaction results.');
    if (Array.isArray(items)) {
      interactions += items.length;
      if (items.length > LEARNING_REVIEW_LIMITS.interactionsPerActivity || interactions > LEARNING_REVIEW_LIMITS.interactions) {
        fail('The interaction review exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
      }
      if (items.length) {
        const completion = state(value.activityCompletion, ['UNKNOWN', 'COMPLETED', 'INCOMPLETE']) as LearningReviewActivity['completion'];
        const success = state(value.activitySuccess, ['UNKNOWN', 'PASSED', 'FAILED']) as LearningReviewActivity['success'];
        const lessonStatus = typeof runtime?.completionStatus === 'string' ? runtime.completionStatus.toLowerCase() : '';
        // SCORM 1.2 has a combined lesson status: failed/passed can be a submitted
        // terminal result even when Cloud's separate completion remains incomplete.
        const terminalLesson = lessonStatus === 'failed' && success !== 'PASSED' || lessonStatus === 'passed' && success !== 'FAILED';
        const inProgress = ['incomplete', 'not attempted', 'not_attempted', 'not-attempted'].includes(lessonStatus);
        if (inProgress || completion !== 'COMPLETED' && !terminalLesson) omittedInProgressActivities++;
        else {
          const projected: LearningReviewActivity = { id: text(value.id, 256),
            ...(value.title === undefined || value.title === null || value.title === '' ? {} : { title: text(value.title, 400) }),
            completion, success, submission: completion === 'COMPLETED' ? 'completed' : 'terminal-lesson-status', interactions: [] };
          if (value.attempts !== undefined && value.attempts !== null) {
            if (!Number.isSafeInteger(value.attempts) || Number(value.attempts) < 0) fail('SCORM Cloud returned an invalid activity attempt count.');
            projected.attempts = value.attempts as number;
          }
          // Keep source order, including repeated identifiers. Do not invent a
          // latest attempt by sorting timestamps or collapsing the provider journal.
          for (const item of items) {
            if (!object(item)) fail('SCORM Cloud returned an unsupported interaction result.');
            const result = text(item.result, 64), numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(result) && Number.isFinite(Number(result));
            if (!['correct', 'incorrect', 'wrong', 'unanticipated', 'neutral'].includes(result.toLowerCase()) && !numeric) {
              fail('SCORM Cloud returned an unsupported interaction judgment.');
            }
            const interaction: LearningReviewInteraction = { id: text(item.id, 256), result,
              ...(item.learnerResponse === undefined || item.learnerResponse === null ? {} : { learnerResponse: response(item.learnerResponse) }) };
            const zonedTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
            const stamp = item.timestampUtc !== undefined && item.timestampUtc !== null && item.timestampUtc !== '' ? item.timestampUtc
              : typeof item.timestamp === 'string' && zonedTimestamp.test(item.timestamp) ? item.timestamp : undefined;
            if (stamp !== undefined) {
              const timestamp = text(stamp, 128);
              if (!zonedTimestamp.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
                fail('SCORM Cloud returned an invalid interaction timestamp.');
              }
              interaction.timestamp = timestamp;
            }
            projected.interactions.push(interaction);
          }
          activities.push(projected);
        }
      }
    }
    for (const child of value.children as unknown[] | undefined ?? []) visit(child, depth + 1);
  }
  if (!object(raw)) fail('SCORM Cloud returned an unsupported registration review.');
  if (raw.activityDetails !== undefined && raw.activityDetails !== null) visit(raw.activityDetails, 0);
  return { activities, omittedInProgressActivities };
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
  private async read(path: string, signal: AbortSignal, budget: { bytes: number }, body?: Row,
    responseLimit = LEARNING_PROVIDER_LIMITS.pageBytes): Promise<unknown> {
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
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) {
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
        if (size > responseLimit || budget.bytes > LEARNING_PROVIDER_LIMITS.totalBytes) {
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
  /** Administrative catalog only. The server must independently establish connector ownership. */
  async listOwnedCourses(signal?: AbortSignal): Promise<LearningOwnedCourse[]> {
    return this.operation(signal, async active => {
      const budget = { bytes: 0 }, courses: LearningOwnedCourse[] = [], ids = new Set<string>(), cursors = new Set<string>();
      let more: string | undefined;
      for (let page = 0; page < LEARNING_PROVIDER_LIMITS.pages; page++) {
        const raw = await this.read('/courses' + (more === undefined ? '' : '?' + new URLSearchParams({ more })), active, budget);
        if (!object(raw) || !Array.isArray(raw.courses)) fail('SCORM Cloud returned an unsupported course catalog.');
        if (raw.courses.length > LEARNING_PROVIDER_LIMITS.pageEntries || courses.length + raw.courses.length > LEARNING_PROVIDER_LIMITS.courses) {
          fail('The course catalog exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
        }
        for (const entry of raw.courses) {
          if (!object(entry)) fail('SCORM Cloud returned an unsupported course entry.');
          const id = text(entry.id, 256);
          if (ids.has(id)) fail('SCORM Cloud returned duplicate course identifiers.');
          ids.add(id); courses.push({ id, title: entry.title === undefined || entry.title === null ? id : text(entry.title, 400), version: version(entry.version) });
        }
        if (raw.more === undefined || raw.more === null || raw.more === '') return courses;
        more = text(raw.more, 4096);
        if (cursors.has(more)) fail('SCORM Cloud returned a repeated course page.');
        cursors.add(more);
      }
      return fail('The course catalog exceeds reader capacity.', 413, 'learning_provider_capacity_exceeded');
    });
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
  /** Explicit read only after owner review release and learner opt-in. No registration creation or grading. */
  async readOwnReview(learnerId: string, courseId: string, courseVersion: number, registrationId: string,
    signal?: AbortSignal): Promise<LearningCompletedReview> {
    learnerId = text(learnerId, 256, true); courseId = text(courseId, 256, true);
    courseVersion = version(courseVersion, true); registrationId = text(registrationId, 256, true);
    return this.operation(signal, async active => {
      const budget = { bytes: 0 }, path = '/registrations/' + encodeURIComponent(registrationId);
      const summaryRaw = await this.read(path, active, budget), summary = normalize(summaryRaw, this.observedAt());
      if (summary.id !== registrationId || summary.learnerId !== learnerId || summary.course.id !== courseId || summary.course.version !== courseVersion) {
        fail('A current registration for this learner and exact course version is required.', 403, 'learning_enrollment_required');
      }
      const instance = reviewInstance(summaryRaw);
      const detailRaw = await this.read(path + '?includeChildResults=true&includeInteractionsAndObjectives=true&includeRuntime=true', active, budget,
        undefined, LEARNING_REVIEW_LIMITS.responseBytes);
      const detail = normalize(detailRaw, this.observedAt());
      if (detail.id !== summary.id || detail.learnerId !== summary.learnerId || detail.course.id !== summary.course.id || detail.course.version !== summary.course.version) {
        fail('The registration changed while its review was being read.', 403, 'learning_enrollment_required');
      }
      if (reviewInstance(detailRaw) !== instance) fail('The registration instance changed while its review was being read.', 409, 'learning_review_changed');
      return { registrationId: detail.id, learnerId: detail.learnerId, course: detail.course,
        ...(instance === undefined ? {} : { instance }), observedAt: detail.observedAt, ...reviewActivities(detailRaw) };
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
