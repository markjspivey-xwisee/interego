/** Owner-authored, version-bound learning metadata. This module neither reads a
 * provider nor fetches IRIs. A map is a stated owner policy/interpretation, never
 * LMS prerequisite evidence, learner achievement, or source-content certification.
 */
import { createHash } from 'node:crypto';

export interface LearningMapLocation {
  id: string; label: string; source_file: string;
  /** Advisory authored reference only; this does not authorize slide navigation. */
  fragment?: string;
}
export interface LearningMapReviewItem {
  activity_id: string; interaction_id: string;
  /** Owner-released label, only for a matching terminal, actually attempted item. */
  question_label: string;
  response_labels: Array<{ response: string; label: string }>;
  location_ids: string[];
}
export interface LearningMapObjective {
  id: string; label: string; competency_iris: string[]; location_ids: string[];
}
export interface LearningMapCourseReference { course_id: string; version?: number; label?: string; }
export interface LearningMapPrerequisite extends LearningMapCourseReference {
  /** A recommendation must not be treated as a required prerequisite. */
  relation: 'required' | 'recommended';
}
/** Normalized map. Optional input collections become empty arrays. */
export interface LearningCourseMapInput {
  schema_version: 1; course_id: string; version: number; title?: string;
  /** Defaults to false; map presence alone releases no learner results. */
  release_quiz_review: boolean;
  instructional_locations: LearningMapLocation[]; review_items: LearningMapReviewItem[];
  objectives: LearningMapObjective[]; prerequisites: LearningMapPrerequisite[];
  curriculum?: { label: string; sequence: LearningMapCourseReference[] };
}
export interface LearningMapSaveMetadata {
  owner: string; connector_id: string; saved_at: string; revision: string;
}
export interface LearningCourseMapSnapshot {
  map: LearningCourseMapInput;
  provenance: LearningMapSaveMetadata & { kind: 'connector-owner-authored'; sha256: string };
}
export class LearningMapError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const LEARNING_MAP_LIMITS = Object.freeze({ bytes: 32 * 1024, snapshotBytes: 34 * 1024,
  locations: 128, reviewItems: 128, objectives: 64, prerequisites: 64,
  curriculumItems: 64, references: 16, responseLabels: 20, jsonNodes: 12_000, jsonDepth: 12 });
type Row = Record<string, unknown>;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const HUMAN = /^did:web:[^\s:]+:users:[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const plain = (value: unknown): value is Row => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function invalid(): never { throw new LearningMapError(400, 'learning_map_invalid'); }
function stateInvalid(): never { throw new LearningMapError(503, 'learning_map_state_invalid'); }
function exact(value: Row, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
/** Reject accessors/non-JSON objects before reading any application fields. */
function finiteJson(value: unknown, depth = 0, seen = new Set<object>(), count = { n: 0 }): boolean {
  if (++count.n > LEARNING_MAP_LIMITS.jsonNodes || depth > LEARNING_MAP_LIMITS.jsonDepth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return Buffer.from(value).toString('utf8') === value;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value) || (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) || Object.getOwnPropertySymbols(value).length) return false;
  seen.add(value);
  const keys = Object.keys(value), names = Object.getOwnPropertyNames(value);
  const valid = names.length === keys.length + (Array.isArray(value) ? 1 : 0) &&
    (!Array.isArray(value) || keys.length === value.length) && keys.every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return !DANGEROUS.has(key) && !!property && 'value' in property && finiteJson(property.value, depth + 1, seen, count);
    });
  seen.delete(value); return valid;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || Buffer.byteLength(value) > max ||
    /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value).toString('utf8') !== value) return invalid();
  return value;
}
function localId(value: unknown): string {
  const result = text(value, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result) || DANGEROUS.has(result)) return invalid();
  return result;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return invalid();
  return value as number;
}
function rows(value: unknown, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
function unique(values: string[]): string[] {
  if (new Set(values).size !== values.length) return invalid();
  return values;
}
function references(value: unknown, allowed: Set<string>, required = false): string[] {
  const result = unique(rows(value, LEARNING_MAP_LIMITS.references).map(localId));
  if (required && !result.length || result.some(id => !allowed.has(id))) return invalid();
  return result;
}
function sourceFile(value: unknown): string {
  const path = text(value, 400);
  if (/[\\%?#:]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part !== part.trim()) ||
    !/\.(?:html?|xhtml|md|txt)$/i.test(path) ||
    /(?:^|[/._ -])(?:assessments?|quizzes|quiz|tests?|exams?|question[-_ ]?banks?|answer[-_ ]?keys?|qti)(?:$|[/._ -])/i.test(path)) return invalid();
  return path;
}
function competencyIri(value: unknown): string {
  const iri = text(value, 1500);
  if (/\s|[<>"{}|\\^`]/.test(iri)) return invalid();
  try {
    const url = new URL(iri);
    if (!['http:', 'https:', 'urn:', 'did:'].includes(url.protocol) || url.username || url.password ||
      ['http:', 'https:'].includes(url.protocol) && !url.hostname || url.protocol === 'urn:' && !/^urn:[A-Za-z0-9][A-Za-z0-9-]{0,31}:[^\s]+$/.test(iri) ||
      url.protocol === 'did:' && !/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[/?#][^\s]*)?$/.test(iri)) return invalid();
  } catch { return invalid(); }
  return iri;
}
function courseReference(value: unknown, prerequisite: boolean): LearningMapCourseReference | LearningMapPrerequisite {
  if (!plain(value) || !exact(value, prerequisite ? ['course_id', 'version', 'label', 'relation'] : ['course_id', 'version', 'label'])) return invalid();
  const result: LearningMapCourseReference = { course_id: text(value.course_id) };
  if (value.version !== undefined) result.version = version(value.version);
  if (value.label !== undefined) result.label = text(value.label, 400);
  if (!prerequisite) return result;
  if (value.relation !== 'required' && value.relation !== 'recommended') return invalid();
  return { ...result, relation: value.relation };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Accept only declarative metadata; no content retrieval or prerequisite inference. */
export function validateLearningCourseMap(value: unknown, expected?: { course_id: string; version: number }): LearningCourseMapInput {
  if (!finiteJson(value) || !plain(value) || !exact(value, ['schema_version', 'course_id', 'version', 'title', 'release_quiz_review',
    'instructional_locations', 'review_items', 'objectives', 'prerequisites', 'curriculum']) || value.schema_version !== 1 ||
    Buffer.byteLength(JSON.stringify(value)) > LEARNING_MAP_LIMITS.bytes) return invalid();
  const courseId = text(value.course_id), courseVersion = version(value.version);
  if (expected && (courseId !== expected.course_id || courseVersion !== expected.version)) return invalid();
  if (value.release_quiz_review !== undefined && typeof value.release_quiz_review !== 'boolean') return invalid();
  const locations = rows(value.instructional_locations, LEARNING_MAP_LIMITS.locations).map(raw => {
    if (!plain(raw) || !exact(raw, ['id', 'label', 'source_file', 'fragment'])) return invalid();
    const location: LearningMapLocation = { id: localId(raw.id), label: text(raw.label, 400), source_file: sourceFile(raw.source_file) };
    if (raw.fragment !== undefined) {
      const fragment = text(raw.fragment, 200);
      if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(fragment)) return invalid();
      location.fragment = fragment;
    }
    return location;
  });
  const locationIds = new Set(unique(locations.map(location => location.id)));
  const reviewItems = rows(value.review_items, LEARNING_MAP_LIMITS.reviewItems).map(raw => {
    if (!plain(raw) || !exact(raw, ['activity_id', 'interaction_id', 'question_label', 'response_labels', 'location_ids'])) return invalid();
    const labels = rows(raw.response_labels, LEARNING_MAP_LIMITS.responseLabels).map(label => {
      if (!plain(label) || !exact(label, ['response', 'label'])) return invalid();
      return { response: text(label.response, 512), label: text(label.label, 400) };
    });
    unique(labels.map(label => label.response));
    return { activity_id: text(raw.activity_id), interaction_id: text(raw.interaction_id), question_label: text(raw.question_label, 400),
      response_labels: labels, location_ids: references(raw.location_ids, locationIds, true) };
  });
  unique(reviewItems.map(item => JSON.stringify([item.activity_id, item.interaction_id])));
  const objectives = rows(value.objectives, LEARNING_MAP_LIMITS.objectives).map(raw => {
    if (!plain(raw) || !exact(raw, ['id', 'label', 'competency_iris', 'location_ids'])) return invalid();
    return { id: localId(raw.id), label: text(raw.label, 400), competency_iris: unique(rows(raw.competency_iris, LEARNING_MAP_LIMITS.references).map(competencyIri)),
      location_ids: references(raw.location_ids, locationIds) };
  });
  unique(objectives.map(objective => objective.id));
  const prerequisites = rows(value.prerequisites, LEARNING_MAP_LIMITS.prerequisites).map(raw => courseReference(raw, true) as LearningMapPrerequisite);
  unique(prerequisites.map(reference => reference.course_id));
  if (prerequisites.some(reference => reference.course_id === courseId)) return invalid();
  const result: LearningCourseMapInput = { schema_version: 1, course_id: courseId, version: courseVersion,
    release_quiz_review: value.release_quiz_review === true, instructional_locations: locations, review_items: reviewItems, objectives, prerequisites };
  if (value.title !== undefined) result.title = text(value.title, 400);
  if (value.curriculum !== undefined) {
    if (!plain(value.curriculum) || !exact(value.curriculum, ['label', 'sequence'])) return invalid();
    const sequence = rows(value.curriculum.sequence, LEARNING_MAP_LIMITS.curriculumItems).map(raw => courseReference(raw, false) as LearningMapCourseReference);
    if (!sequence.length) return invalid();
    unique(sequence.map(reference => reference.course_id));
    result.curriculum = { label: text(value.curriculum.label, 400), sequence };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > LEARNING_MAP_LIMITS.bytes) return invalid();
  return result;
}
function metadata(value: unknown): LearningMapSaveMetadata {
  if (!plain(value) || !exact(value, ['owner', 'connector_id', 'saved_at', 'revision']) || !finiteJson(value)) return invalid();
  const owner = text(value.owner, 512), connectorId = text(value.connector_id, 32), savedAt = text(value.saved_at, 30), revision = text(value.revision, 32);
  if (!HUMAN.test(owner) || !HEX32.test(connectorId) || !HEX32.test(revision) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(savedAt) ||
    !Number.isFinite(Date.parse(savedAt)) || new Date(savedAt).toISOString() !== savedAt) return invalid();
  return { owner, connector_id: connectorId, saved_at: savedAt, revision };
}
/** Integrity digest binds the exact owner, connector, save event and normalized
 * map. It is not an ownership signature; authenticated save/persistence supplies
 * that boundary. The store must allocate a fresh revision for each saved event. */
export function learningCourseMapHash(map: LearningCourseMapInput, save: LearningMapSaveMetadata): string {
  return createHash('sha256').update(canonical({ map, provenance: { ...save, kind: 'connector-owner-authored' } })).digest('hex');
}
/** Caller supplies authenticated server metadata, never fields copied from client JSON. */
export function createLearningCourseMapSnapshot(value: unknown, save: LearningMapSaveMetadata): LearningCourseMapSnapshot {
  const map = validateLearningCourseMap(value), provenance = metadata(save);
  return freeze({ map, provenance: { ...provenance, kind: 'connector-owner-authored' as const, sha256: learningCourseMapHash(map, provenance) } });
}
/** Corrupt persisted metadata is refused, not silently discarded or trusted anew. */
export function validateLearningCourseMapSnapshot(value: unknown, expected?: { owner?: string; connector_id?: string; course_id?: string; version?: number }): LearningCourseMapSnapshot {
  try {
    if (!finiteJson(value) || !plain(value) || !exact(value, ['map', 'provenance']) || Buffer.byteLength(JSON.stringify(value)) > LEARNING_MAP_LIMITS.snapshotBytes ||
      !plain(value.provenance) || !exact(value.provenance, ['owner', 'connector_id', 'saved_at', 'revision', 'kind', 'sha256']) ||
      value.provenance.kind !== 'connector-owner-authored' || typeof value.provenance.sha256 !== 'string' || !HEX64.test(value.provenance.sha256)) return stateInvalid();
    const map = validateLearningCourseMap(value.map);
    // Persisted representation must already be normalized; defaults cannot repair it.
    if (canonical(map) !== canonical(value.map)) return stateInvalid();
    const save = metadata({ owner: value.provenance.owner, connector_id: value.provenance.connector_id,
      saved_at: value.provenance.saved_at, revision: value.provenance.revision });
    if (expected?.owner !== undefined && save.owner !== expected.owner || expected?.connector_id !== undefined && save.connector_id !== expected.connector_id ||
      expected?.course_id !== undefined && map.course_id !== expected.course_id || expected?.version !== undefined && map.version !== expected.version ||
      learningCourseMapHash(map, save) !== value.provenance.sha256) return stateInvalid();
    return freeze({ map, provenance: { ...save, kind: 'connector-owner-authored' as const, sha256: value.provenance.sha256 } });
  } catch { return stateInvalid(); }
}
