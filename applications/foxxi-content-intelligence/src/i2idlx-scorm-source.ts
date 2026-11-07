/** Bounded native SCORM Cloud asset reads; no ZIP export or retained course index.
 * Cloud exposes versioned files, not a natural-language query service. Selection here
 * uses file paths and manifest titles, then the existing instructional reader. */
import { createHash } from 'node:crypto';
import { readAnyPackage } from './tool-exports.js';
import { parseManifest } from './scorm-sequencing.js';
import { buildCourseGraph, type CourseGraph, type CourseMaterial } from './i2idlx-course-cache.js';

export const SCORM_SOURCE_LIMITS = {
  listFiles: 2000, listBytes: 256 * 1024, files: 8, fileBytes: 64 * 1024,
  totalBytes: 192 * 1024, pathBytes: 1024, questionBytes: 4000,
} as const;

export class ScormSourceError extends Error {
  constructor(message: string, readonly status = 422, readonly code = 'course_source_unsupported') { super(message); }
}
export interface ScormSourceInput {
  /** Opaque non-authentication namespace for this authorized source connection. */
  sourceScope: string;
  courseId: string; version: number; title: string; question: string;
  /** Trusted application callback supplies Cloud authorization, fixed host, streaming cap and timeout. */
  request: (path: string, limit: number, signal: AbortSignal) => Promise<Buffer>;
  signal: AbortSignal;
}
export interface ScormSourceRetrieval {
  strategy: 'versioned-filelist-lexical-paths';
  listed_files: number; list_bytes: number;
  candidate_files: number; unselected_candidate_files: number; excluded_assessment_files: number;
  fetched_files: Array<{ path: string; bytes: number; sha256: string }>;
  total_bytes: number; max_files: number; max_file_bytes: number; max_total_bytes: number;
  max_list_files: number; max_list_bytes: number;
  package_downloaded: false; retained_content: false; full_course_fingerprint: false;
}
export interface ScormSourceResult {
  material: CourseMaterial;
  /** Fingerprint of this returned instructional projection, not the full source course. */
  projectionSha256: string;
  retrieval: ScormSourceRetrieval;
  /** Request-local containment/headings only; partial reads cannot prove source adjacency. */
  graph: CourseGraph;
}
type FileRow = { path: string; size: number };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fail(message: string, status = 422, code = 'course_source_unsupported'): never { throw new ScormSourceError(message, status, code); }
function boundedText(value: unknown, limit: number, label: string, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit ||
    (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value) || Buffer.from(value).toString('utf8') !== value) {
    fail('The source ' + label + ' is absent or outside reader capacity.', 400, 'course_request_invalid');
  }
  return value;
}
function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > SCORM_SOURCE_LIMITS.pathBytes ||
    /[\u0000-\u001f\u007f\\%?#:]/.test(value) || value !== value.trim() ||
    value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..') ||
    Buffer.from(value).toString('utf8') !== value) fail('The source file list contains an unsafe relative path.', 502, 'course_source_invalid');
  return value;
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) fail('The course source read was cancelled.', 499, 'cancelled');
}
function utf8(bytes: Buffer): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('The selected source file contains unsupported control characters.');
    return value;
  }
  catch { return fail('The selected source file is not supported UTF-8 text.'); }
}
const assessmentPath = (path: string): boolean => /(?:^|[/._ -])(?:assessments?|quizzes|quiz|tests?|exam(?:s)?|question[-_ ]?banks?|answer[-_ ]?keys?|qti)(?:$|[/._ -])/i.test(path);
// A course named "External Course Test" is not thereby an assessment.
const assessmentTitle = (title: string): boolean => /\b(?:assessments?|quizzes|quiz|exams?|question[-_ ]?banks?|answer[-_ ]?keys?|(?:graded|final)[-_ ]+tests?|pre[-_ ]?tests?|post[-_ ]?tests?)\b/i.test(title);
const instructionalPath = (path: string): boolean => /\.(?:html?|xhtml|md|txt)$/i.test(path) ||
  /(?:^|\/)(?:h5p|course|contentobjects|articles|blocks|components|content)\.json$/i.test(path) ||
  /(?:^|\/)(?:data|project|slides|captivate)\.js$/i.test(path);
function termsOf(question: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'what', 'which', 'when', 'where', 'how', 'does', 'this', 'that', 'with', 'your', 'from', 'about', 'please', 'course']);
  return [...new Set(question.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(term => term.length > 2 && !stop.has(term)))].slice(0, 64);
}

/** Native versioned APIs are the only generated request paths. The caller must never
 * reinterpret these as URLs or fall back to a package export after a reader refusal. */
export async function readScormSource(input: ScormSourceInput): Promise<ScormSourceResult> {
  const scope = boundedText(input.sourceScope, 256, 'connection scope');
  const courseId = boundedText(input.courseId, 256, 'course identifier');
  const title = boundedText(input.title, 400, 'course title');
  const question = boundedText(input.question, SCORM_SOURCE_LIMITS.questionBytes, 'question', true);
  if (!Number.isSafeInteger(input.version) || input.version < 0) fail('The source course version is invalid.', 400, 'course_request_invalid');
  cancelled(input.signal);
  const base = '/courses/' + encodeURIComponent(courseId) + '/versions/' + input.version;
  const listing = await input.request(base + '/asset/list', SCORM_SOURCE_LIMITS.listBytes, input.signal);
  cancelled(input.signal);
  if (!Buffer.isBuffer(listing) || listing.length > SCORM_SOURCE_LIMITS.listBytes) fail('The course file list exceeds reader capacity.', 413, 'course_source_too_large');
  let raw: unknown;
  try { raw = JSON.parse(utf8(listing)); } catch (error) {
    if (error instanceof ScormSourceError) throw error;
    return fail('The course file list is not supported JSON.', 502, 'course_source_invalid');
  }
  if (!object(raw) || !Array.isArray(raw.files)) fail('The source returned an unsupported file list.', 502, 'course_source_invalid');
  if (raw.files.length > SCORM_SOURCE_LIMITS.listFiles) fail('The course file list exceeds reader capacity.', 413, 'course_source_too_large');
  const names = new Set<string>();
  const files: FileRow[] = raw.files.map(value => {
    if (!object(value)) return fail('The source returned an invalid file entry.', 502, 'course_source_invalid');
    const path = relativePath(value.path), key = path.normalize('NFC').toLowerCase();
    if (names.has(key)) fail('The source file list contains ambiguous duplicate paths.', 502, 'course_source_invalid');
    names.add(key);
    if (!Number.isSafeInteger(value.size) || Number(value.size) < 0 ||
      value.modified !== undefined && (typeof value.modified !== 'string' || !Number.isFinite(Date.parse(value.modified)))) {
      fail('The source file list contains invalid file metadata.', 502, 'course_source_invalid');
    }
    return { path, size: Number(value.size) };
  });
  const manifest = files.find(file => file.path.toLowerCase() === 'imsmanifest.xml');
  if (!manifest) fail('This native source reader requires a root SCORM manifest. Package export is not used as a fallback.');
  const loaded = new Map<string, Buffer>();
  const fetched: ScormSourceRetrieval['fetched_files'] = [];
  let total = 0;
  async function load(file: FileRow): Promise<Buffer> {
    cancelled(input.signal);
    const old = loaded.get(file.path);
    if (old) return old;
    if (fetched.length >= SCORM_SOURCE_LIMITS.files || file.size > SCORM_SOURCE_LIMITS.fileBytes ||
      total + file.size > SCORM_SOURCE_LIMITS.totalBytes) fail('The selected course files exceed native reader capacity.', 413, 'course_source_too_large');
    const limit = Math.min(SCORM_SOURCE_LIMITS.fileBytes, SCORM_SOURCE_LIMITS.totalBytes - total);
    const bytes = await input.request(base + '/asset?' + new URLSearchParams({ relativePath: file.path }), limit, input.signal);
    cancelled(input.signal);
    if (!Buffer.isBuffer(bytes) || bytes.length > limit) fail('The selected course file exceeds native reader capacity.', 413, 'course_source_too_large');
    if (bytes.length !== file.size) fail('The source file changed during retrieval. Refresh its metadata and try again.', 409, 'course_source_changed');
    utf8(bytes);
    loaded.set(file.path, bytes); total += bytes.length;
    fetched.push({ path: file.path, bytes: bytes.length, sha256: digest(bytes) });
    return bytes;
  }
  const manifestText = utf8(await load(manifest));
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(manifestText)) fail('The source manifest contains an unsupported document declaration.');
  let tree: ReturnType<typeof parseManifest>;
  try { tree = parseManifest(manifestText); } catch { return fail('The source SCORM manifest could not be read safely.'); }
  const titles = new Map<string, string>(), order = new Map<string, number>(), assessmentReferences = new Set<string>();
  for (const activity of tree.preorder) {
    if (!activity.href) continue;
    // Only exact listed paths can be read. Remote links, queries and dot segments are never followed.
    const file = files.find(row => row.path === activity.href);
    if (!file) continue;
    if (!titles.has(file.path)) titles.set(file.path, activity.title);
    if (!order.has(file.path)) order.set(file.path, order.size);
    if (assessmentTitle(activity.title)) assessmentReferences.add(file.path);
  }
  const excluded = files.filter(file => assessmentPath(file.path) || assessmentReferences.has(file.path)).length;
  const candidates = files.filter(file => file !== manifest && instructionalPath(file.path) && !assessmentPath(file.path) && !assessmentReferences.has(file.path));
  const terms = termsOf(question);
  const ranked = candidates.map(file => ({ file, score: terms.reduce((sum, term) => sum +
    (file.path.toLowerCase().includes(term) ? 4 : 0) + ((titles.get(file.path) ?? '').toLowerCase().includes(term) ? 8 : 0), 0) }))
    .sort((a, b) => b.score - a.score || (order.get(a.file.path) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.file.path) ?? Number.MAX_SAFE_INTEGER) || a.file.path.localeCompare(b.file.path, 'en'));
  const matched = ranked.filter(row => row.score > 0);
  const selected = (matched.length ? matched : ranked).slice(0, SCORM_SOURCE_LIMITS.files - fetched.length);
  if (!selected.length) fail('No supported instructional assets were available for this source read.');
  for (const { file } of selected) await load(file);
  cancelled(input.signal);
  const urn = 'urn:scorm-cloud:connection:' + encodeURIComponent(scope) + ':course:' + encodeURIComponent(courseId) + ':version:' + input.version;
  let imported: ReturnType<typeof readAnyPackage>;
  try { imported = readAnyPackage({ names: [...loaded.keys()], read: path => loaded.get(path) ?? null },
    { title, fileUrl: path => urn + ':file:' + encodeURIComponent(path) }); }
  catch { return fail('The selected native assets could not be projected into instructional text.'); }
  const sections = imported.topics.flatMap(topic => topic.pages).filter(page => page.body.trim() && !assessmentPath(page.path) && !assessmentTitle(page.title))
    .map(page => ({ id: page.path, title: page.title || title, body: page.body,
      source_uri: urn + ':file:' + encodeURIComponent(page.path), locator: page.path }));
  if (!sections.length) fail('The selected native assets contained no supported instructional text.');
  const material: CourseMaterial = {
    id: digest(JSON.stringify(['i2idlx:scorm-cloud:native-source:v1', scope, courseId, input.version])),
    title, kind: 'SCORM Cloud native asset projection', source_uri: urn, version: 'course-version:' + input.version,
    sections,
    missing_context: [
      'Only bounded question-selected native source files were read. Unselected files may contain further information.',
      'File paths and manifest titles guide selection; this is not a source-native natural-language search or a scan of all course text.',
      'Assessment paths and reader-separated questions are excluded; this is not certification that all instructional text is assessment-free.',
      'This selected instructional projection does not establish course delivery, assessment results or learning completion.',
      ...(imported.unread.length ? ['Some selected resources could not be converted into instructional text.'] : []),
    ],
  };
  const graph = buildCourseGraph(material);
  graph.edges = graph.edges.filter(edge => edge.relation !== 'next-in-source');
  return { material, projectionSha256: digest(JSON.stringify(sections.map(({ id, title: heading, body }) => ({ id, title: heading, body })))), graph,
    retrieval: { strategy: 'versioned-filelist-lexical-paths', listed_files: files.length, list_bytes: listing.length,
      candidate_files: candidates.length, unselected_candidate_files: candidates.length - selected.length, excluded_assessment_files: excluded,
      fetched_files: fetched, total_bytes: total, max_files: SCORM_SOURCE_LIMITS.files, max_file_bytes: SCORM_SOURCE_LIMITS.fileBytes,
      max_total_bytes: SCORM_SOURCE_LIMITS.totalBytes, max_list_files: SCORM_SOURCE_LIMITS.listFiles, max_list_bytes: SCORM_SOURCE_LIMITS.listBytes,
      package_downloaded: false, retained_content: false, full_course_fingerprint: false } };
}
