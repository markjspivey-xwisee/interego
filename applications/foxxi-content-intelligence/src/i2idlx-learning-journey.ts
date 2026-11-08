/** Read-only course readiness and released own-attempt review. Nothing here is
 * enrollment authority, an answer key, or a retained course/progress replica. */
import { createHash } from 'node:crypto';
import { LearningAuthError, type LearningAccountAuth, type LearningPrincipal } from './i2idlx-learning-auth.js';
import { LearningConnectionsError, type LearningAccess, type LearningConnectionsStore } from './i2idlx-learning-connections.js';
import { ScormCloudLearningProvider } from './i2idlx-learning-provider.js';
import { readScormSource, type ScormSourceResult } from './i2idlx-scorm-source.js';
import { LearningLaunchError, type LearningLaunchService } from './i2idlx-learning-launch.js';

type Row = Record<string, unknown>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const CLOUD = 'https://cloud.scorm.com/api/v2';
async function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new LearningConnectionsError(403, 'learning_access_revoked');
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new LearningConnectionsError(403, 'learning_access_revoked')); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener('abort', abort); }
}
export interface ReleasedReviewRecord {
  citation_id: string; activity_id: string; interaction_id: string; question_label: string;
  result: string | number; learner_response?: string; learner_response_label?: string; observed_at: string;
  timestamp?: string; submission: string;
  locations: Array<{ id: string; label: string; source_file: string; fragment?: string }>;
}
export interface ReleasedQuizReview {
  status: 'available' | 'not-released' | 'no-completed-results' | 'not-authorized' | 'unavailable';
  reason: string; count: number; observed_at: string; records: ReleasedReviewRecord[];
}
export interface LearningReviewBinding { registrationId: string; instance?: number; }
export function assertLearningReviewBinding(access: LearningAccess, binding?: LearningReviewBinding): void {
  if (!binding) return;
  const current = access.registrations.find(value => value.id === binding.registrationId);
  if (!current || current.instance !== binding.instance) throw new LearningConnectionsError(403, 'learning_access_revoked');
}
export function learningMapProjection(access: LearningAccess): Row {
  const saved = access.learningMap;
  if (!saved) return { status: 'unavailable', objectives: [], prerequisites: [], provider_prerequisites: 'unavailable', provider_curriculum: 'unavailable' };
  return { status: 'owner-supplied', citation_id: 'learning-map:' + hash(saved.provenance.sha256).slice(0, 40), revision: saved.provenance.revision, sha256: saved.provenance.sha256,
    saved_at: saved.provenance.saved_at, provenance: 'connector-owner-authored; not a provider assertion or verified learner achievement',
    course_id: saved.map.course_id, version: saved.map.version, objectives: saved.map.objectives,
    prerequisites: saved.map.prerequisites, ...(saved.map.curriculum ? { curriculum: saved.map.curriculum } : {}),
    provider_prerequisites: 'unavailable', provider_curriculum: 'unavailable',
    notice: 'Required and recommended relationships are owner-supplied statements. Course order alone is not prerequisite evidence. This map does not grant enrollment or prove completion of another course.' };
}
export async function readReleasedQuizReview(access: LearningAccess, courseId: string, version: number, scope: string,
  config: { fetch?: typeof fetch; now?: () => number; onBinding?: (binding: LearningReviewBinding) => void }, signal: AbortSignal): Promise<ReleasedQuizReview> {
  const stamp = () => new Date((config.now ?? Date.now)()).toISOString();
  const empty = (status: ReleasedQuizReview['status'], reason: string): ReleasedQuizReview => ({ status, reason, count: 0, records: [], observed_at: stamp() });
  if (access.policy.allowAiReview !== true) return empty('not-authorized', 'The connection owner has not authorized released quiz review.');
  const map = access.learningMap?.map;
  if (!map || map.course_id !== courseId || map.version !== version || !map.release_quiz_review) return empty('not-released', 'No completed quiz review has been released for this exact course version.');
  if (!map.review_items.length) return empty('not-released', 'The owner has not mapped any released question results for this course version.');
  const registration = access.registrations.find(item => item.id === access.associatedRegistrationId) ?? (access.registrations.length === 1 ? access.registrations[0] : undefined);
  if (!registration) return empty('unavailable', 'More than one registration matches this course. Ask the learning administrator to resolve the enrollment.');
  const provider = new ScormCloudLearningProvider({ authorization: access.authorization, ...config });
  const review = await provider.readOwnReview(access.learnerId, courseId, version, registration.id, signal);
  config.onBinding?.({ registrationId: review.registrationId, ...(review.instance !== undefined ? { instance: review.instance } : {}) });
  const records: ReleasedReviewRecord[] = [];
  for (const activity of review.activities) for (const [index, interaction] of activity.interactions.entries()) {
    const item = map.review_items.find(value => value.activity_id === activity.id && value.interaction_id === interaction.id);
    if (!item) continue;
    const locations = item.location_ids.flatMap(id => {
      const location = map.instructional_locations.find(value => value.id === id); return location ? [{ ...location }] : [];
    });
    const response = interaction.learnerResponse;
    const label = response === undefined ? undefined : item.response_labels?.find(value => value.response === response)?.label;
    records.push({ citation_id: 'learning-review:' + hash(JSON.stringify([scope, registration.id, activity.id, index, interaction.id, access.learningMap!.provenance.sha256])).slice(0, 40),
      activity_id: activity.id, interaction_id: interaction.id, question_label: item.question_label, result: interaction.result,
      ...(response !== undefined ? { learner_response: response } : {}), ...(label ? { learner_response_label: label } : {}),
      ...(interaction.timestamp ? { timestamp: interaction.timestamp } : {}), observed_at: review.observedAt,
      submission: activity.submission, locations });
  }
  return { status: records.length ? 'available' : 'no-completed-results', count: records.length, records, observed_at: review.observedAt,
    reason: records.length ? 'Provider results for your own submitted activities, limited to the owner-released course map. Repeated records remain in provider order; this is not a reconstructed attempt history.'
      : 'No mapped completed or terminal submitted activity results were returned. In-progress activities and unreleased questions are excluded.' };
}

/** Fixed Cloud asset transport shared by readiness and question retrieval. */
export async function readLearningAsset(path: string, limit: number, authorization: string, signal: AbortSignal, fetcher: typeof fetch): Promise<Buffer> {
  if (!/^\/courses\/[^/]+\/versions\/\d+\/asset(?:\/list|\?relativePath=)/.test(path)) throw new LearningConnectionsError(400, 'learning_request_invalid');
  const target = CLOUD + path;
  const pending = fetcher(target, { method: 'GET', redirect: 'error', signal, headers: { Authorization: authorization, Accept: '*/*' } });
  void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
  const response = await interrupted(pending, signal);
  if (!response.ok || response.redirected || response.url && response.url !== target) { await response.body?.cancel(); throw new LearningConnectionsError(502, 'learning_content_unavailable'); }
  const length = response.headers.get('content-length');
  if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); throw new LearningConnectionsError(413, 'learning_content_too_large'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); }; signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new LearningConnectionsError(403, 'learning_access_revoked');
      const next = await interrupted(reader.read(), signal); if (next.done) break;
      size += next.value.byteLength; if (size > limit) throw new LearningConnectionsError(413, 'learning_content_too_large'); chunks.push(next.value);
    }
    if (signal.aborted) throw new LearningConnectionsError(403, 'learning_access_revoked');
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class LearningJourneyService {
  private active = new Set<string>();
  constructor(private config: { auth: Pick<LearningAccountAuth, 'revalidate'>; connections: LearningConnectionsStore;
    navigation: Pick<LearningLaunchService, 'prepareNavigation'>; fetch?: typeof fetch; now?: () => number }) {}
  async request(principal: LearningPrincipal, raw: Row): Promise<Row> {
    if (Object.keys(raw).some(key => !['operation', 'link_id', 'course_id', 'version'].includes(key)) ||
      !['course-readiness', 'quiz-review'].includes(String(raw.operation)) || typeof raw.link_id !== 'string' || typeof raw.course_id !== 'string' ||
      !raw.course_id || Buffer.byteLength(raw.course_id) > 256 || !Number.isSafeInteger(raw.version) || Number(raw.version) < 0) throw new LearningConnectionsError(400, 'learning_request_invalid');
    if (this.active.size >= 4 || this.active.has(principal.sessionId)) throw new LearningConnectionsError(429, 'learning_busy');
    this.active.add(principal.sessionId);
    const signal = AbortSignal.any([principal.signal, AbortSignal.timeout(45_000)]);
    const human = async () => {
      const value = await this.config.auth.revalidate(principal);
      if (value.subject !== principal.subject || value.userId !== principal.userId || value.sessionId !== principal.sessionId || value.webId !== principal.webId || value.podUrl !== principal.podUrl || value.signal !== principal.signal || signal.aborted) throw new LearningAuthError(403, 'learning_access_revoked');
    };
    try {
      await human();
      const linkId = raw.link_id, courseId = raw.course_id, version = raw.version as number;
      const before = await this.config.connections.access(principal, linkId, courseId, version, { content: false, progress: false }, signal);
      const scope = hash(principal.sessionId + '\n' + linkId);
      let reviewBinding: LearningReviewBinding | undefined;
      const quiz = await readReleasedQuizReview(before, courseId, version, scope, { ...this.config, onBinding: value => { reviewBinding = value; } }, signal);
      const binding = { link_id: linkId, course_id: courseId, version };
      let content: ScormSourceResult | undefined;
      let contentStatus: Row = { status: 'not-authorized', reason: 'The connection owner has not authorized course reading.' };
      let launch: Row = { kind: 'course', reason: 'Course launch uses the existing registration; Cloud controls resume. Lesson links require a verified published activity and owner permission.' };
      if (raw.operation === 'course-readiness' && before.policy.allowAiContent) {
        try {
          content = await readScormSource({ sourceScope: scope, courseId, version, title: before.registrations[0]!.course.title,
            question: 'Course instructional overview', signal,
            request: (path, limit, abort) => readLearningAsset(path, limit, before.authorization, abort, this.config.fetch ?? fetch) });
          contentStatus = { status: 'readable', reason: 'A bounded sample of instructional files was readable. Other questions may select other files; this is not a full-course scan.' };
          const citations = content.material.sections.map(section => ({ id: 'readiness:' + hash(section.id).slice(0, 32), locator: section.locator, title: section.title }));
          const navigation = await this.config.navigation.prepareNavigation(principal, before, courseId, version, citations, signal);
          if (navigation.locations.some(value => value.target_kind === 'activity')) launch = { kind: 'lesson', reason: 'Verified published lessons can be opened directly. Internal slides or paragraphs are not guaranteed launch targets.' };
        } catch (error) {
          if (signal.aborted) throw new LearningConnectionsError(403, 'learning_access_revoked');
          if (error instanceof LearningAuthError || error instanceof LearningConnectionsError && [401, 403, 409].includes(error.status) || error instanceof LearningLaunchError && [401, 403, 409].includes(error.status)) throw error;
          contentStatus = { status: 'unavailable', reason: 'The selected instructional files could not be read within supported limits. Course launch remains separate from text-reading support.' };
        }
      }
      await human();
      const after = await this.config.connections.access(principal, linkId, courseId, version, { content: false, progress: false }, signal);
      if (after.revision !== before.revision || after.connectorId !== before.connectorId) throw new LearningConnectionsError(403, 'learning_access_revoked');
      assertLearningReviewBinding(after, reviewBinding);
      await human();
      if (raw.operation === 'quiz-review') return { ...binding, quiz_review: quiz };
      return { ...binding, readiness: { course_id: courseId, version, checked_at: new Date((this.config.now ?? Date.now)()).toISOString(),
        enrollment: { status: 'verified', observed_at: after.registrations[0]!.observedAt }, content: contentStatus,
        quiz_review: { status: quiz.status, reason: quiz.reason, count: quiz.count, observed_at: quiz.observed_at }, launch,
        learning_map: learningMapProjection(after), retention: { mode: 'virtual', cached_bytes: 0, course_text_retained: false,
          authority_expires_at: new Date(principal.expiresAt).toISOString(), credentials: 'encrypted until the owner revokes the connection',
          owner_map_retention: 'Owner-authored map labels and relationships remain encrypted until their owner deletes the map or revokes the connection; retrieved source bodies and progress are not retained.',
          client_retention: 'Passages and observations shared with an AI client follow its retention. Ending a link stops future access; it does not erase earlier client copies.' } } };
    } finally { this.active.delete(principal.sessionId); }
  }
}
