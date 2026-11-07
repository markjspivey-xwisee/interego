/** Private course retrieval through a browser's verified, temporary Interego session. */
import type { Express, Response as ExpressResponse } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import type { AgentBrowserIdentity, AgentSessionStore } from './i2idlx-agent-sessions.js';
import { AgentSessionError } from './i2idlx-agent-sessions.js';
import type { ClientTaskConfig } from './i2idlx-client-tasks.js';
import { executeInterventionTask, interventionTaskFailure } from './i2idlx-intervention-tasks.js';
import { readAnyPackage } from './tool-exports.js';
import { isPackagePath } from './scorm-hosting.js';
import { buildCourseGraph, graphCourseSections, courseCacheBytes, clearCourseCache, type CachedCourse, type CourseMaterial } from './i2idlx-course-cache.js';
import { SourceCourseProvider, SourceProviderError, type SourceCourse, type SourceGrant, type SourceTransport } from './i2idlx-course-provider.js';

type Row = Record<string, unknown>;
type Course = { id: string; title: string; version: number | string; standard: string; access_modes: AccessMode[] };
type AccessMode = 'transient' | 'cached' | 'virtual';
type Grant = { id: string; course: string; mode: AccessMode; authority: string; verification: string; expires: number;
  abort: AbortController; timer?: ReturnType<typeof setTimeout>; remote?: SourceGrant; cache?: CachedCourse };
type RevokedGrant = { course: string; idempotencyKey: string; remote?: SourceGrant; result?: Row; requestId?: string;
  inFlight?: Promise<Row>; deletedAt?: number; deletionOrder?: number };
type Connection = {
  id: string; session: string; actor: string; authorization: string; expires: number;
  abort: AbortController; release: () => void; timer: ReturnType<typeof setTimeout>;
  courses: Map<string, Course>; pages: Map<string, string>; busy: boolean;
  provider: 'scorm-cloud' | 'source-service'; remote?: SourceCourseProvider;
  grants: Map<string, Grant>; revoked: Map<string, RevokedGrant>;
};
export interface UserCourseConfig {
  baseUrl: string;
  sessions: Pick<AgentSessionStore, 'authorizeBrowser'>;
  taskConfig: ClientTaskConfig;
  fetch?: typeof fetch;
  now?: () => number;
  connectionTtlMs?: number;
  /** Program-only fixture injection; never accepted through request JSON. */
  sourceTransport?: SourceTransport;
}
export const USER_COURSE_PATH = '/i2idlx/api/user-courses';
const CLOUD = 'https://cloud.scorm.com/api/v2';
const MAX_ZIP = 16 * 1024 * 1024, MAX_INFLATED = 32 * 1024 * 1024, MAX_FILE = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000, MAX_BODY = 16 * 1024;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const opaque = () => randomBytes(24).toString('hex');
const courseKey = (id: string, version: number | string) => JSON.stringify([id, version]);
const MAX_CACHE_BYTES = 8 * 1024 * 1024, MAX_TOTAL_CACHE_BYTES = 64 * 1024 * 1024;
export class UserCourseError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'course_request_invalid') { super(message); }
}
function refuse(message: string, status = 400, code?: string): never { throw new UserCourseError(message, status, code); }
function exact(value: Row, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) refuse('Unsupported course connection input.');
}
function text(value: unknown, max: number, label: string, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max || controls.test(value)) refuse(label + ' is absent or too large.');
  return value;
}
function argsOf(raw: unknown): Row {
  if (!object(raw)) refuse('A JSON object is required.');
  let encoded: string;
  try { encoded = JSON.stringify(raw); } catch { refuse('Course input must be bounded JSON.'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY) refuse('Course input exceeds capacity.', 413);
  const args = { ...raw };
  delete args.__client_ip;
  delete args.__caller_token;
  return args;
}
function credentialsOf(raw: unknown): string {
  if (!object(raw)) refuse('Provide SCORM Cloud credentials for this temporary connection.');
  if (raw.type === 'basic') {
    exact(raw, ['type', 'app_id', 'secret']);
    const app = text(raw.app_id, 256, 'Application ID'), secret = text(raw.secret, 4096, 'Shared secret');
    if (!/^[A-Za-z0-9._-]+$/.test(app)) refuse('The application ID has unsupported characters.');
    return 'Basic ' + Buffer.from(app + ':' + secret, 'utf8').toString('base64');
  }
  if (raw.type === 'bearer') {
    exact(raw, ['type', 'token']);
    const token = text(raw.token, 4096, 'SCORM Cloud access token');
    if (!/^[\x21-\x7e]+$/.test(token)) refuse('The SCORM Cloud access token has unsupported characters.');
    return 'Bearer ' + token;
  }
  refuse('Use an application ID and secret or a SCORM Cloud access token.');
}
function utf8Prefix(value: string, max: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= max) return value;
  let end = max;
  while (end && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const length = response.headers.get('Content-Length');
  if (length && Number(length) > limit) {
    await response.body?.cancel();
    refuse('The course response exceeds retrieval capacity.', 413, 'course_source_too_large');
  }
  if (!response.body) refuse('SCORM Cloud returned an empty response.', 502, 'course_provider_unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) refuse('The course response exceeds retrieval capacity.', 413, 'course_source_too_large');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, total);
}
/** Header budgets precede ZIP parsing; native inflation also enforces an actual output cap. */
function packageFiles(bytes: Buffer) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = bytes.lastIndexOf(signature);
  if (end < Math.max(0, bytes.length - 65_557) || end + 22 > bytes.length ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length || bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10) ||
    bytes.readUInt16LE(end + 10) > MAX_ENTRIES) refuse('The course ZIP has an unsupported structure.', 413, 'course_source_unsupported');
  const zip = new AdmZip(bytes), entries = zip.getEntries().filter(entry => !entry.isDirectory);
  const names = new Set<string>();
  let declared = 0;
  for (const entry of entries) {
    declared += entry.header.size;
    if (!isPackagePath(entry.entryName) || entry.entryName.length > 1024 || names.has(entry.entryName) ||
      entry.header.size > MAX_FILE || declared > MAX_INFLATED || entry.header.encrypted ||
      ![0, 8].includes(entry.header.method)) refuse('The course ZIP exceeds safe reader capacity.', 413, 'course_source_too_large');
    names.add(entry.entryName);
  }
  const files = new Map<string, Buffer>();
  let total = 0, reads = 0;
  const load = (name: string): Buffer | null => {
    const entry = zip.getEntry(name);
    if (!entry || entry.isDirectory) return null;
    let content = files.get(name);
    if (!content) {
      const compressed = entry.getCompressedData();
      content = entry.header.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_FILE });
      total += content.length;
      if (content.length !== entry.header.size || total > MAX_INFLATED) refuse('The course ZIP exceeds safe reader capacity.', 413, 'course_source_too_large');
      files.set(name, content);
    }
    return content;
  };
  // Every exact file participates, including non-instructional assets. ZIP timestamps,
  // compression and entry ordering do not change the instructional source identity.
  const digest = createHash('sha256').update('i2idlx:package-content:v1\0');
  const count = Buffer.alloc(4); count.writeUInt32BE(names.size); digest.update(count);
  const paths = [...names].map(name => ({ name, bytes: Buffer.from(name, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  for (const path of paths) {
    const content = load(path.name)!;
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(path.bytes.length); lengths.writeUInt32BE(content.length, 4);
    digest.update(lengths).update(path.bytes).update(createHash('sha256').update(content).digest());
  }
  const contentSha256 = digest.digest('hex');
  return {
    names: [...names],
    contentSha256,
    read(name: string): Buffer | null {
      const content = load(name);
      if (!content) return null;
      reads += content.length;
      if (reads > 64 * 1024 * 1024) refuse('Course text exceeds reader capacity.', 413, 'course_source_too_large');
      return content;
    },
  };
}

export class UserCourseStore {
  private readonly connections = new Map<string, Connection>();
  private readonly requests = new Map<string, { count: number; reset: number }>();
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  private readonly ttl: number;
  private active = 0;
  private cacheBytes = 0;
  private deletionSequence = 0;
  constructor(private readonly config: UserCourseConfig) {
    this.clock = config.now ?? Date.now;
    this.fetcher = config.fetch ?? globalThis.fetch;
    this.ttl = Math.min(config.connectionTtlMs ?? 30 * 60_000, 30 * 60_000);
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) throw new Error('Invalid private course connection bounds.');
  }
  dispose(): void { for (const connection of this.connections.values()) this.drop(connection); this.requests.clear(); }
  private drop(connection: Connection): void {
    if (this.connections.get(connection.session) === connection) this.connections.delete(connection.session);
    connection.authorization = '';
    connection.remote?.dispose();
    for (const grant of connection.grants.values()) this.revoke(connection, grant, false);
    connection.grants.clear(); connection.revoked.clear();
    connection.courses.clear(); connection.pages.clear();
    clearTimeout(connection.timer); connection.release(); connection.abort.abort();
  }
  private requireCurrent(connection: Connection): void {
    if (connection.expires <= this.clock()) {
      this.drop(connection);
      refuse('This temporary course connection expired. Connect again.', 410, 'course_connection_expired');
    }
    if (connection.abort.signal.aborted || this.connections.get(connection.session) !== connection) {
      refuse('The temporary course connection is no longer active.', 404, 'course_connection_not_found');
    }
  }
  private status(connection: Connection): Row {
    return { connected: true, provider: connection.provider, connection_id: connection.id, expires_at: new Date(connection.expires).toISOString(), ephemeral: true, persisted: false,
      access_modes: connection.provider === 'scorm-cloud' ? ['transient', 'cached'] : ['virtual'] };
  }
  private clearCache(grant: Grant): void {
    if (!grant.cache) return;
    this.cacheBytes -= grant.cache.bytes;
    clearCourseCache(grant.cache); grant.cache = undefined;
  }
  private revoke(connection: Connection, grant: Grant, receipt = true): RevokedGrant {
    this.clearCache(grant); clearTimeout(grant.timer); grant.abort.abort();
    if (connection.grants.get(grant.course) === grant) connection.grants.delete(grant.course);
    const previous = connection.revoked.get(grant.id);
    if (previous) return previous;
    const revoked: RevokedGrant = { course: grant.course, idempotencyKey: opaque(), ...(grant.remote ? { remote: grant.remote } : {}) };
    if (receipt) {
      if (connection.revoked.size >= 48) {
        const removable = [...connection.revoked].find(([, entry]) => !entry.inFlight && !['pending', 'failed'].includes(String(entry.result?.status)));
        if (removable) connection.revoked.delete(removable[0]);
      }
      connection.revoked.set(grant.id, revoked);
    }
    return revoked;
  }
  private grantView(grant: Grant): Row {
    return { id: grant.id, mode: grant.mode, expires_at: new Date(grant.expires).toISOString(), authority: grant.authority,
      verification: grant.verification, ...(grant.remote ? { owner: grant.remote.owner, provider_grant_id: grant.remote.id } : {}) };
  }
  private cacheView(grant?: Grant, hit = false): Row {
    const cache = grant?.cache;
    return { present: !!cache, hit, bytes: cache?.bytes ?? 0, ...(cache ? { stored_at: new Date(cache.storedAt).toISOString(), expires_at: new Date(cache.expires).toISOString() } : {}) };
  }
  private deletionView(connection: Connection, course: Course): Row | undefined {
    const key = courseKey(course.id, course.version);
    const latest = [...connection.revoked].filter(([, entry]) => entry.course === key && entry.deletedAt !== undefined)
      .sort((a, b) => (b[1].deletionOrder ?? 0) - (a[1].deletionOrder ?? 0))[0];
    if (!latest) return undefined;
    const [id, entry] = latest;
    return { grant_id: id, deleted: true, scope: 'this-session', permission_revoked: true,
      remote_deletion: entry.result ?? { status: entry.inFlight ? 'submitting' : 'not_requested' },
      note: 'This record concerns the earlier permission shown by grant_id; a newly granted permission is separate.' };
  }
  private accessState(connection: Connection, course: Course, grant?: Grant): Row {
    const deletion = this.deletionView(connection, course);
    return { connection_id: connection.id, course_id: course.id, version: course.version,
      grant: grant ? this.grantView(grant) : null, cache: this.cacheView(grant), ...(deletion ? { deletion } : {}) };
  }
  private course(connection: Connection, args: Row): Course {
    const id = text(args.course_id, 256, 'Course identifier');
    if (!(typeof args.version === 'string' && !!args.version.trim() && Buffer.byteLength(args.version) <= 200) &&
      !(Number.isSafeInteger(args.version) && Number(args.version) >= 0)) refuse('Choose a listed course version.');
    const course = connection.courses.get(courseKey(id, args.version as string | number));
    if (!course) refuse('Choose a course version from this connection\'s catalog.', 404, 'course_source_unavailable');
    return course;
  }
  private requireGrant(connection: Connection, course: Course, id: unknown): Grant {
    const key = courseKey(course.id, course.version), grant = connection.grants.get(key);
    if (!grant || grant.id !== id || grant.abort.signal.aborted) refuse('Grant course permission and choose an access mode before asking.', 403, 'course_permission_required');
    if (grant.expires <= this.clock()) { this.revoke(connection, grant); refuse('Course permission expired. Grant permission again.', 410, 'course_permission_expired'); }
    return grant;
  }
  private retrievalFailure(connection: Connection, grant: Grant, signal: AbortSignal, error: unknown): never {
    // Stop/timeout is not an owner revocation. Withhold this result and recheck
    // on the next question; preserve a still-valid grant/cache on cancellation.
    if (signal.aborted || connection.abort.signal.aborted || this.connections.get(connection.session) !== connection) throw error;
    this.revoke(connection, grant);
    const known = error instanceof UserCourseError || error instanceof SourceProviderError;
    const message = known ? error.message : 'The course source could not be checked.';
    throw new UserCourseError(message + ' Confirm course permission again before retrying.', known ? error.status : 502, 'course_permission_revoked');
  }
  private async grant(connection: Connection, args: Row, signal: AbortSignal): Promise<Row> {
    const course = this.course(connection, args), key = courseKey(course.id, course.version);
    // Preserve unresolved deletion receipts and stable retry keys. At most 16 older
    // active grants may subsequently revoke, so the 48-entry receipt budget remains bounded.
    if ([...connection.revoked.values()].filter(entry => entry.inFlight || ['pending', 'failed'].includes(String(entry.result?.status))).length >= 32) {
      refuse('This session has too many unresolved deletion requests. Check their status before granting more course access.', 429, 'course_rate_limited');
    }
    if (!course.access_modes.includes(args.mode as AccessMode)) refuse('This source does not support the selected access mode.', 400, 'course_mode_unsupported');
    if (!object(args.permission)) refuse('Explicit course-owner permission is required.', 403, 'course_permission_required');
    exact(args.permission, ['authorized', 'authority', 'retention_minutes']);
    if (args.permission.authorized !== true || !['owner', 'authorized-by-owner'].includes(String(args.permission.authority))) refuse('Confirm that you own the course or have its owner\'s permission.', 403, 'course_permission_required');
    const minutes = args.permission.retention_minutes;
    if (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > 30) refuse('Choose permission lasting 1 to 30 minutes.');
    const remote = connection.remote ? await connection.remote.permission(course as SourceCourse, signal) : undefined;
    this.requireCurrent(connection);
    if (signal.aborted) refuse('Course permission was cancelled.', 409, 'course_permission_required');
    if (remote && !remote.access_modes.includes(args.mode as 'virtual')) refuse('The source owner has not authorized this mode.', 403, 'course_permission_required');
    const prior = connection.grants.get(key); if (prior) this.revoke(connection, prior);
    if (connection.grants.size >= 16) refuse('This connection reached its active course permission capacity.', 413);
    const expires = Math.min(connection.expires, this.clock() + Number(minutes) * 60_000, remote ? Date.parse(remote.expires_at) : Infinity);
    if (!Number.isFinite(expires) || expires <= this.clock()) refuse('The course owner\'s permission expired.', 410, 'course_permission_expired');
    const grant: Grant = { id: opaque(), course: key, mode: args.mode as AccessMode, authority: String(args.permission.authority),
      verification: remote ? 'source-service-attested' : 'user-attested', expires, abort: new AbortController(), ...(remote ? { remote } : {}) };
    connection.grants.set(key, grant);
    grant.timer = setTimeout(() => { if (connection.grants.get(key) === grant) this.revoke(connection, grant); }, Math.max(1, expires - this.clock()));
    grant.timer.unref();
    return { grant: this.grantView(grant), cache: this.cacheView(grant) };
  }
  private limit(identity: AgentBrowserIdentity): void {
    const now = this.clock();
    for (const [id, row] of this.requests) if (row.reset <= now) this.requests.delete(id);
    const row = this.requests.get(identity.session_id) ?? { count: 0, reset: now + 60_000 };
    if (row.count >= 30 || this.requests.size >= 128 && !this.requests.has(identity.session_id)) refuse('Course retrieval is busy. Try again shortly.', 429, 'course_rate_limited');
    row.count++; this.requests.set(identity.session_id, row);
  }
  private async work<T>(connection: Connection, fn: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    this.requireCurrent(connection);
    if (connection.busy || this.active >= 2) refuse('Course retrieval is busy. Try again shortly.', 429, 'course_rate_limited');
    connection.busy = true; this.active++;
    const abort = new AbortController(), stop = () => abort.abort();
    connection.abort.signal.addEventListener('abort', stop, { once: true });
    external?.addEventListener('abort', stop, { once: true });
    if (external?.aborted) stop();
    const timeout = setTimeout(stop, 20_000); timeout.unref();
    try {
      const result = await fn(abort.signal);
      this.requireCurrent(connection);
      if (abort.signal.aborted) refuse('Course retrieval timed out or was cancelled. Try again.', 504, 'course_provider_unavailable');
      return result;
    } catch (error) {
      if (error instanceof UserCourseError) throw error;
      if (error instanceof SourceProviderError) throw new UserCourseError(error.message, error.status, error.code);
      this.requireCurrent(connection);
      return refuse(connection.provider === 'scorm-cloud' ? 'The course could not be read from SCORM Cloud. Try again.' : 'The course source service is unavailable. Try again.', 502, 'course_provider_unavailable');
    } finally {
      clearTimeout(timeout); connection.abort.signal.removeEventListener('abort', stop);
      external?.removeEventListener('abort', stop); connection.busy = false; this.active--;
    }
  }
  private async read(connection: Connection, path: string, signal: AbortSignal, limit: number): Promise<Buffer> {
    this.requireCurrent(connection);
    const response = await this.fetcher(CLOUD + path, { method: 'GET', redirect: 'error', signal,
      headers: { Authorization: connection.authorization, Accept: path.endsWith('/zip') ? '*/*' : 'application/json' } });
    if (signal.aborted) {
      await response.body?.cancel();
      this.requireCurrent(connection);
      refuse('Course retrieval timed out or was cancelled. Try again.', 504, 'course_provider_unavailable');
    }
    if (!response.ok || response.redirected || response.url && response.url !== CLOUD + path) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        this.drop(connection);
        refuse('SCORM Cloud refused these credentials. Connect again.', 401, 'course_provider_authentication_failed');
      }
      if (response.status === 429) refuse('SCORM Cloud is busy. Try again shortly.', 429, 'course_rate_limited');
      if (response.status === 404) refuse('This course version is unavailable from SCORM Cloud.', 404, 'course_source_unavailable');
      refuse('SCORM Cloud returned an unusable response.', 502, 'course_provider_unavailable');
    }
    const bytes = await boundedBody(response, limit);
    this.requireCurrent(connection);
    return bytes;
  }
  private async list(connection: Connection, page: unknown, signal: AbortSignal): Promise<Row> {
    if (connection.remote) {
      const listing = await connection.remote.courses(page === undefined ? undefined : text(page, 4096, 'Course page'), signal);
      for (const item of listing.courses) {
        if (connection.courses.size >= 1000 && !connection.courses.has(courseKey(item.id, item.version))) refuse('This connection reached its course browsing capacity.', 413);
        connection.courses.set(courseKey(item.id, item.version), item as Course);
      }
      return { connection_id: connection.id, ...listing, truncated: false };
    }
    let query = '';
    if (page !== undefined) {
      const key = text(page, 64, 'Course page'), cursor = connection.pages.get(key);
      if (!cursor) refuse('This course page is no longer available.', 404, 'course_source_unavailable');
      query = '?' + new URLSearchParams({ more: cursor });
    }
    const raw: unknown = JSON.parse((await this.read(connection, '/courses' + query, signal, 1024 * 1024)).toString('utf8'));
    if (!object(raw) || !Array.isArray(raw.courses) || raw.courses.length > 500) refuse('SCORM Cloud returned an unsupported course list.', 502, 'course_provider_unavailable');
    const courses: Course[] = [];
    for (const value of raw.courses) {
      if (!object(value)) continue;
      const id = text(value.id, 256, 'Course identifier'), title = text(value.title, 400, 'Course title');
      if (!Number.isSafeInteger(value.version) || Number(value.version) < 0) continue;
      const course: Course = { id, title, version: Number(value.version), standard: typeof value.learningStandard === 'string' ? value.learningStandard.slice(0, 100) : typeof value.courseLearningStandard === 'string' ? value.courseLearningStandard.slice(0, 100) : 'Unreported', access_modes: ['transient', 'cached'] };
      courses.push(course);
      if (connection.courses.size >= 1000 && !connection.courses.has(courseKey(id, course.version))) refuse('This connection reached its course browsing capacity. Reconnect to browse again.', 413, 'course_source_too_large');
      connection.courses.set(courseKey(id, course.version), course);
    }
    let next: string | undefined;
    if (typeof raw.more === 'string' && raw.more && raw.more.length <= 4096) {
      if (connection.pages.size >= 20) refuse('This connection reached its course browsing capacity. Reconnect to browse again.', 413, 'course_source_too_large');
      next = opaque(); connection.pages.set(next, raw.more);
    }
    return { connection_id: connection.id, courses, ...(next ? { next_page: next } : {}), truncated: false };
  }
  private async cloudMaterial(connection: Connection, course: Course, signal: AbortSignal): Promise<{ material: CourseMaterial; archiveDigest: string; contentDigest: string }> {
    const bytes = await this.read(connection, '/courses/' + encodeURIComponent(course.id) + '/versions/' + course.version + '/zip', signal, MAX_ZIP);
    const archiveDigest = createHash('sha256').update(bytes).digest('hex');
    const urn = 'urn:scorm-cloud:course:' + encodeURIComponent(course.id) + ':version:' + course.version;
    let imported, contentDigest: string;
    try {
      const files = packageFiles(bytes);
      contentDigest = files.contentSha256;
      imported = readAnyPackage(files, { title: course.title, fileUrl: path => urn + ':file:' + encodeURIComponent(path) });
    }
    catch (error) {
      if (error instanceof UserCourseError) throw error;
      refuse('This course package could not be projected into instructional text.', 422, 'course_source_unsupported');
    }
    const pages = imported.topics.flatMap(topic => topic.pages).filter(page => page.body.trim());
    const sections = pages.slice(0, 5000).map(page => ({
      id: utf8Prefix(page.path, 200), title: utf8Prefix(page.title || course.title, 400), body: utf8Prefix(page.body, 96_000),
      source_uri: urn + ':file:' + encodeURIComponent(page.path), locator: utf8Prefix(page.path, 400),
    }));
    const identity = createHash('sha256').update(JSON.stringify(['i2idlx:scorm-cloud:source:v1', course.id, course.version, contentDigest])).digest('hex');
    const material: CourseMaterial = { id: identity, title: course.title, kind: 'SCORM Cloud course', source_uri: urn,
      version: 'course-version:' + course.version + ';content-sha256:' + contentDigest, sections,
      missing_context: [...(imported.unread.length ? ['Some package resources could not be converted into instructional text.'] : []),
        ...(pages.length > sections.length ? ['Only the first 5000 instructional sections were available to this retrieval.'] : []),
        'Package retrieval does not establish course delivery, assessment results or learning completion.'],
    };
    return { material, archiveDigest, contentDigest };
  }
  private async source(connection: Connection, args: Row, signal: AbortSignal): Promise<Row> {
    const course = this.course(connection, args), grant = this.requireGrant(connection, course, args.grant_id);
    const question = text(args.question, 4000, 'Question', true);
    if (args.refresh !== undefined && (typeof args.refresh !== 'boolean' || grant.mode !== 'cached')) refuse('Refresh applies only to a local course cache.');
    const combined = AbortSignal.any([signal, grant.abort.signal]);
    let material: CourseMaterial, source: Row, graph: Row = { representation: 'none', nodes: 0, edges: 0 }, hit = false;
    if (connection.remote) {
      if (grant.mode !== 'virtual') refuse('This source permits virtual retrieval only.', 403, 'course_mode_unsupported');
      let result;
      try { result = await connection.remote.source(course as SourceCourse, question, combined); }
      catch (error) { this.retrievalFailure(connection, grant, combined, error); }
      if (!grant.remote || result.grant.id !== grant.remote.id || result.grant.owner !== grant.remote.owner) {
        this.revoke(connection, grant); refuse('The source owner\'s permission changed. Grant access again.', 403, 'course_permission_required');
      }
      grant.expires = Math.min(grant.expires, Date.parse(result.grant.expires_at));
      material = result.material as CourseMaterial; source = result.source;
      graph = { representation: result.graph ? 'source-service' : 'none', local_content_graph: false,
        ...(result.graph ? { evidence: result.graph } : {}) };
    } else {
      if (grant.mode === 'virtual') refuse('SCORM Cloud export cannot be used in virtual mode.', 400, 'course_mode_unsupported');
      if (args.refresh === true) this.clearCache(grant);
      if (grant.cache) {
        // Recheck provider access before returning retained instructional content.
        try { await this.read(connection, '/courses/' + encodeURIComponent(course.id), combined, 1024 * 1024); }
        catch (error) { this.retrievalFailure(connection, grant, combined, error); }
        this.requireGrant(connection, course, grant.id); hit = true;
      }
      if (!grant.cache) {
        let loaded;
        try { loaded = await this.cloudMaterial(connection, course, combined); }
        catch (error) { this.requireCurrent(connection); this.requireGrant(connection, course, grant.id); throw error; }
        this.requireGrant(connection, course, grant.id);
        if (grant.mode === 'cached') {
          const localGraph = buildCourseGraph(loaded.material), size = courseCacheBytes(loaded.material, localGraph);
          if (size > MAX_CACHE_BYTES || this.cacheBytes + size > MAX_TOTAL_CACHE_BYTES) refuse('The instructional text and graph exceed local cache capacity. Choose Read on demand instead.', 413, 'course_cache_too_large');
          grant.cache = { ...loaded, graph: localGraph, storedAt: this.clock(), expires: grant.expires, bytes: size };
          this.cacheBytes += size;
        }
        material = loaded.material;
        source = { provider: 'scorm-cloud', course_id: course.id, title: course.title, version: course.version,
          package_sha256: loaded.archiveDigest, content_sha256: loaded.contentDigest };
      } else {
        material = grant.cache.material;
        source = { provider: 'scorm-cloud', course_id: course.id, title: course.title, version: course.version,
          package_sha256: grant.cache.archiveDigest, content_sha256: grant.cache.contentDigest };
      }
      if (grant.cache) {
        const selection = graphCourseSections(grant.cache, question);
        material = { ...grant.cache.material, sections: selection.sections,
          missing_context: [...grant.cache.material.missing_context, 'A local published-structure graph selected sections around lexical matches. It does not establish semantic prerequisites; omitted sections may contain further information.'] };
        graph = { representation: 'published-structure', nodes: grant.cache.graph.nodes.length, edges: grant.cache.graph.edges.length,
          semantic_prerequisites_inferred: false, retrieval: 'lexical-seeds-with-source-neighborhood',
          seed_section_ids: selection.seeds, expanded_section_ids: selection.expanded };
      }
    }
    this.requireGrant(connection, course, grant.id);
    if (combined.aborted) refuse('Course retrieval was cancelled.', 409, 'course_permission_required');
    let packet: Row;
    try { packet = await executeInterventionTask({ ...this.config.taskConfig, readIntervention: async () => material }, {
      source: 'package', intervention_id: material.id, question, lens: 'analyze',
    }); } catch (error) {
      const failure = interventionTaskFailure(error);
      refuse(typeof failure.body.error === 'string' ? failure.body.error : 'Instructional source context is unavailable.', failure.status, 'course_source_unavailable');
    }
    this.requireGrant(connection, course, grant.id);
    if (combined.aborted) refuse('Course retrieval was cancelled.', 409, 'course_permission_required');
    const context = packet.source_context as Row;
    const citations = (context.sections as Row[]).map(section => ({ id: section.citation_id, title: section.title,
      body: section.body, locator: section.locator, source_uri: section.source_uri }));
    const access = { mode: grant.mode, permission: this.grantView(grant), cache: this.cacheView(grant, hit), graph,
      scope: 'this-session', copied_content: grant.mode === 'virtual' ? 'question-selected passages only' : 'package retrieved in memory; cached mode retains instructional text and graph only',
      client_retention: 'Passages already shared with your AI client are subject to that client\'s retention and are not erased by deleting this cache.' };
    packet.course_access = access;
    return { connection_id: connection.id, source, access,
      citations, missing_context: context.missing_context, retrieved_at: new Date(this.clock()).toISOString(),
      truncated: (context.retrieval as Row).excerpt_truncated, interventionContext: packet };
  }
  private async accessStatus(connection: Connection, args: Row, signal: AbortSignal): Promise<Row> {
    const course = this.course(connection, args), grant = connection.grants.get(courseKey(course.id, course.version));
    if (!grant) return this.accessState(connection, course);
    if (grant.expires <= this.clock()) { this.revoke(connection, grant); return this.accessState(connection, course); }
    if (connection.remote) {
      try {
        const remote = await connection.remote.permission(course as SourceCourse, signal);
        if (!grant.remote || remote.id !== grant.remote.id || remote.owner !== grant.remote.owner) { this.revoke(connection, grant); return this.accessState(connection, course); }
        grant.expires = Math.min(grant.expires, Date.parse(remote.expires_at));
      } catch (error) { this.retrievalFailure(connection, grant, signal, error); }
    }
    this.requireGrant(connection, course, grant.id);
    return this.accessState(connection, course, grant);
  }
  private async deleteContent(connection: Connection, args: Row, signal?: AbortSignal): Promise<Row> {
    const course = this.course(connection, args), key = courseKey(course.id, course.version), id = text(args.grant_id, 64, 'Course permission');
    const active = connection.grants.get(key);
    let revoked = connection.revoked.get(id);
    if (active?.id === id) revoked = this.revoke(connection, active);
    if (!revoked || revoked.course !== key) refuse('Course permission not found for deletion.', 404, 'course_permission_required');
    if (revoked.deletedAt === undefined) { revoked.deletedAt = this.clock(); revoked.deletionOrder = ++this.deletionSequence; }
    const result: Row = { deleted: true, scope: 'this-session', permission_revoked: true,
      remote_deletion: { status: 'not_requested' }, note: 'Local retained instructional text and graph were removed. This does not delete the original course or erase passages already shared with your AI client.' };
    if (args.operation === 'delete') {
      result.remote_deletion = revoked.result ?? { status: revoked.inFlight ? 'submitting' : 'not_requested' };
      return result;
    }
    if (!connection.remote || !revoked.remote || !revoked.remote.permissions.includes('request-deletion')) {
      result.remote_deletion = { status: 'unsupported', scope: 'derived-content', note: 'This source has not advertised a remote deletion request. No remote deletion was claimed.' };
      revoked.result = result.remote_deletion as Row;
      return result;
    }
    if (args.operation === 'deletion-status' && (typeof args.request_id !== 'string' || args.request_id !== revoked.requestId)) refuse('Choose the deletion receipt from this connection.', 404);
    if (args.operation === 'request-deletion' && revoked.result && ['pending', 'completed'].includes(String(revoked.result.status))) {
      result.remote_deletion = revoked.result; return result;
    }
    if (!revoked.inFlight) {
      const record = revoked, remote = connection.remote, remoteGrant = revoked.remote;
      const abort = AbortSignal.any([connection.abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
      record.inFlight = (async (): Promise<Row> => {
        try {
          const receipt = args.operation === 'deletion-status'
            ? await remote.deletionStatus(course as SourceCourse, record.requestId!, abort)
            : await remote.requestDeletion(course as SourceCourse, remoteGrant, abort, record.idempotencyKey);
          this.requireCurrent(connection);
          record.result = receipt as unknown as Row; record.requestId = receipt.request_id;
          return record.result;
        } catch (error) {
          this.requireCurrent(connection);
          if (error instanceof UserCourseError) throw error;
          record.result = { status: 'failed', retryable: true, scope: 'derived-content', ...(record.requestId ? { request_id: record.requestId } : {}),
            note: 'Local content was removed, but the source service did not confirm the deletion request. Retry or contact the course owner.' };
          return record.result;
        } finally { record.inFlight = undefined; }
      })();
    }
    result.remote_deletion = await revoked.inFlight;
    return result;
  }
  async request(raw: unknown, browserToken: unknown, signal?: AbortSignal): Promise<Row> {
    const args = argsOf(raw);
    const identity = this.config.sessions.authorizeBrowser(args.session_id, browserToken);
    const operation = args.operation;
    if (operation === 'disconnect') {
      exact(args, ['session_id', 'operation']);
      const connection = this.connections.get(identity.session_id);
      if (connection) this.drop(connection);
      return { connected: false };
    }
    // Removing local private content must remain available even after read throttling.
    if (operation !== 'delete') this.limit(identity);
    if (operation === 'connect') {
      exact(args, ['session_id', 'operation', 'credentials', 'provider']);
      const provider = args.provider === undefined ? 'scorm-cloud' : args.provider;
      if (provider !== 'scorm-cloud' && provider !== 'source-service') refuse('Choose SCORM Cloud or a compatible source service.');
      let remote: SourceCourseProvider | undefined;
      if (provider === 'source-service') {
        if (!object(args.credentials)) refuse('Provide the source service address and scoped token.');
        exact(args.credentials, ['service_url', 'token']);
        remote = new SourceCourseProvider({ service_url: text(args.credentials.service_url, 2048, 'Source service URL'), token: text(args.credentials.token, 4096, 'Source service token') },
          { actor: identity.actor, now: this.clock, ...(this.config.sourceTransport ? { transport: this.config.sourceTransport } : {}) });
      }
      const authorization = provider === 'scorm-cloud' ? credentialsOf(args.credentials) : '', previous = this.connections.get(identity.session_id);
      if (previous) this.drop(previous);
      if (this.connections.size >= 64) refuse('Too many temporary course connections.', 429, 'course_rate_limited');
      const connection = { id: opaque(), session: identity.session_id, actor: identity.actor, authorization,
        expires: Math.min(identity.expires_at, this.clock() + this.ttl), abort: new AbortController(),
        courses: new Map(), pages: new Map(), grants: new Map(), revoked: new Map(), busy: false, provider, ...(remote ? { remote } : {}) } as Connection;
      const close = () => this.drop(connection);
      identity.signal.addEventListener('abort', close, { once: true });
      connection.release = () => identity.signal.removeEventListener('abort', close);
      connection.timer = setTimeout(close, Math.max(1, connection.expires - this.clock())); connection.timer.unref();
      this.connections.set(identity.session_id, connection);
      if (identity.signal.aborted) { this.drop(connection); refuse('This agent session expired.', 410, 'session_expired'); }
      try { await this.work(connection, fetchSignal => this.list(connection, undefined, fetchSignal), signal); }
      catch (error) { this.drop(connection); throw error; }
      return this.status(connection);
    }
    const connection = this.connections.get(identity.session_id);
    if (operation === 'status') {
      exact(args, ['session_id', 'operation']);
      if (!connection) return { connected: false };
      if (connection.actor !== identity.actor || connection.expires <= this.clock()) { this.drop(connection); return { connected: false }; }
      return this.status(connection);
    }
    if (operation === 'courses') exact(args, ['session_id', 'operation', 'connection_id', 'page']);
    else if (operation === 'source') exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version', 'question', 'grant_id', 'refresh']);
    else if (operation === 'grant') exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version', 'mode', 'permission']);
    else if (operation === 'access-status') exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version']);
    else if (operation === 'delete' || operation === 'request-deletion' || operation === 'deletion-status') exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version', 'grant_id', ...(operation === 'deletion-status' ? ['request_id'] : [])]);
    else refuse('Unknown course connection operation.');
    if (!connection || connection.actor !== identity.actor || connection.id !== args.connection_id) refuse('Course connection not found.', 404, 'course_connection_not_found');
    this.requireCurrent(connection);
    if (operation === 'delete' || operation === 'request-deletion' || operation === 'deletion-status') return this.deleteContent(connection, args, signal);
    return this.work(connection, fetchSignal => operation === 'courses' ? this.list(connection, args.page, fetchSignal)
      : operation === 'grant' ? this.grant(connection, args, fetchSignal)
      : operation === 'access-status' ? this.accessStatus(connection, args, fetchSignal) : this.source(connection, args, fetchSignal), signal);
  }
}

export function attachUserCourseRoutes(app: Express, config: UserCourseConfig): UserCourseStore {
  const store = new UserCourseStore(config), origin = new URL(config.baseUrl).origin;
  app.post(USER_COURSE_PATH, async (req, res) => {
    const abort = new AbortController();
    const closed = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', closed);
    try {
      if (Object.keys(req.query).length) refuse('Private course inputs belong in JSON and headers.');
      if (req.get('Origin') && req.get('Origin') !== origin) refuse('Cross-origin course request refused.', 403);
      const authorization = req.get('Authorization');
      const result = await store.request(req.body, authorization?.startsWith('Bearer ') ? authorization.slice(7) : null, abort.signal);
      respond(res, 200, result);
    } catch (error) {
      if (error instanceof AgentSessionError) respond(res, error.status, { error: error.message, code: error.status === 410 ? 'session_expired' : 'session_unauthorized' });
      else if (error instanceof UserCourseError) respond(res, error.status, { error: error.message, code: error.code });
      else if (error instanceof SourceProviderError) respond(res, error.status, { error: error.message, code: error.code });
      else respond(res, 500, { error: 'The temporary course operation could not be completed.', code: 'course_provider_unavailable' });
    } finally { res.removeListener('close', closed); }
  });
  return store;
}
function respond(res: ExpressResponse, status: number, body: Row): void {
  if (status === 429) res.set('Retry-After', '60');
  res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').status(status).json(body);
}
