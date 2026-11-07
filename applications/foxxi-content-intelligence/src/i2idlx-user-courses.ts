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
import { readScormSource, ScormSourceError } from './i2idlx-scorm-source.js';
import { CourseLtiManager, CourseLtiError, type CourseLtiBinding, type CourseLtiDescriptor, type CourseLtiLaunchEvidence } from './i2idlx-course-lti.js';

type Row = Record<string, unknown>;
type Course = { id: string; title: string; version: number | string; standard: string; access_modes: AccessMode[] };
type AccessMode = 'transient' | 'cached' | 'virtual';
type Grant = { id: string; course: string; mode: AccessMode; authority: string; verification: string; expires: number;
  abort: AbortController; timer?: ReturnType<typeof setTimeout>; remote?: SourceGrant; cache?: CachedCourse; ltiId?: string; lti?: CourseLtiLaunchEvidence };
type LtiSetup = { id: string; course: string; grantId: string; binding: CourseLtiBinding; tool: CourseLtiDescriptor;
  state: 'prepared' | 'setting-up' | 'ready' | 'verified' | 'attached' | 'revoked' | 'cleanup-failed';
  connectorId?: string; helperCourseId?: string; importJobId?: string; configured?: boolean; helperRequested?: boolean;
  cleanup?: Promise<boolean>; pending?: Promise<void>; note?: string; setupStarted?: boolean; connectorRequested?: boolean;
  helperSettled?: boolean; removed?: boolean };
type RevokedGrant = { course: string; idempotencyKey: string; remote?: SourceGrant; result?: Row; requestId?: string;
  inFlight?: Promise<Row>; deletedAt?: number; deletionOrder?: number };
type Connection = {
  id: string; session: string; actor: string; authorization: string; expires: number;
  abort: AbortController; release: () => void; timer: ReturnType<typeof setTimeout>;
  courses: Map<string, Course>; pages: Map<string, string>; busy: boolean;
  provider: 'scorm-cloud' | 'source-service'; remote?: SourceCourseProvider;
  grants: Map<string, Grant>; revoked: Map<string, RevokedGrant>;
  ltiSetups: Map<string, LtiSetup>;
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
  /** Program-only injection for signed launch fixtures; never accepted from request JSON. */
  ltiManager?: CourseLtiManager;
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
  private readonly lti: CourseLtiManager;
  constructor(private readonly config: UserCourseConfig) {
    this.clock = config.now ?? Date.now;
    this.fetcher = config.fetch ?? globalThis.fetch;
    this.ttl = Math.min(config.connectionTtlMs ?? 30 * 60_000, 30 * 60_000);
    this.lti = config.ltiManager ?? new CourseLtiManager({ baseUrl: config.baseUrl, now: this.clock });
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) throw new Error('Invalid private course connection bounds.');
  }
  dispose(): void { for (const connection of this.connections.values()) this.drop(connection); this.requests.clear(); this.lti.dispose(); }
  attachLtiRoutes(app: Express): void { this.lti.attachRoutes(app); }
  private drop(connection: Connection): void {
    if (this.connections.get(connection.session) !== connection) return;
    if (this.connections.get(connection.session) === connection) this.connections.delete(connection.session);
    this.lti.revokeConnection(connection.id);
    // Expiry revokes the local receiver immediately. Remote cleanup is bounded
    // and best-effort; an explicit disconnect awaits and reports its outcome.
    const authorization = connection.authorization;
    for (const setup of connection.ltiSetups.values()) void this.cleanupLti(connection, setup, authorization).catch(() => false);
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
      access_modes: connection.provider === 'scorm-cloud' ? ['transient', 'cached', 'virtual'] : ['virtual'] };
  }
  private clearCache(grant: Grant): void {
    if (!grant.cache) return;
    this.cacheBytes -= grant.cache.bytes;
    clearCourseCache(grant.cache); grant.cache = undefined;
  }
  private revoke(connection: Connection, grant: Grant, receipt = true): RevokedGrant {
    this.clearCache(grant); clearTimeout(grant.timer); grant.abort.abort();
    if (grant.ltiId) { const setup = connection.ltiSetups.get(grant.ltiId); if (setup) setup.state = 'revoked'; }
    grant.lti = undefined;
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
    const setup = [...connection.ltiSetups.values()].reverse().find(value => value.course === courseKey(course.id, course.version) && !value.removed);
    return { connection_id: connection.id, course_id: course.id, version: course.version,
      grant: grant ? this.grantView(grant) : null, cache: this.cacheView(grant), ...(deletion ? { deletion } : {}),
      ...(setup ? { lti: this.ltiView(setup) } : {}) };
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
      if (error instanceof CourseLtiError || error instanceof ScormSourceError) throw new UserCourseError(error.message, error.status, error.code);
      this.requireCurrent(connection);
      return refuse(connection.provider === 'scorm-cloud' ? 'The course could not be read from SCORM Cloud. Try again.' : 'The course source service is unavailable. Try again.', 502, 'course_provider_unavailable');
    } finally {
      clearTimeout(timeout); connection.abort.signal.removeEventListener('abort', stop);
      external?.removeEventListener('abort', stop); connection.busy = false; this.active--;
    }
  }
  private async read(connection: Connection, path: string, signal: AbortSignal, limit: number): Promise<Buffer> {
    return this.cloudRequest(connection, path, signal, limit);
  }
  private async cloudRequest(connection: Connection, path: string, signal: AbortSignal, limit: number, method = 'GET', body?: Row): Promise<Buffer> {
    this.requireCurrent(connection);
    const asset = path.includes('/asset?');
    const response = await this.fetcher(CLOUD + path, { method, redirect: 'error', signal,
      headers: { Authorization: connection.authorization, Accept: asset ? 'application/octet-stream' : path.endsWith('/zip') ? '*/*' : 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (signal.aborted) {
      await response.body?.cancel();
      this.requireCurrent(connection);
      refuse('Course retrieval timed out or was cancelled. Try again.', 504, 'course_provider_unavailable');
    }
    if (!response.ok || response.redirected || response.url && response.url !== CLOUD + path) {
      await response.body?.cancel();
      if (response.status === 403 && (method !== 'GET' || path.startsWith('/contentConnectors') || path.startsWith('/courses/importJobs'))) {
        refuse('SCORM Cloud did not authorize this LTI setup operation. A credential with the required account permissions is needed.', 403, 'course_lti_permission_denied');
      }
      if (response.status === 401 || response.status === 403) {
        this.drop(connection);
        refuse('SCORM Cloud refused these credentials. Connect again.', 401, 'course_provider_authentication_failed');
      }
      if (response.status === 429) refuse('SCORM Cloud is busy. Try again shortly.', 429, 'course_rate_limited');
      if (response.status === 404) refuse('This course version is unavailable from SCORM Cloud.', 404, 'course_source_unavailable');
      refuse('SCORM Cloud returned an unusable response.', 502, 'course_provider_unavailable');
    }
    const bytes = response.status === 204 ? Buffer.alloc(0) : await boundedBody(response, limit);
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
      const standard = typeof value.learningStandard === 'string' ? value.learningStandard.slice(0, 100) : typeof value.courseLearningStandard === 'string' ? value.courseLearningStandard.slice(0, 100) : 'Unreported';
      const course: Course = { id, title, version: Number(value.version), standard,
        access_modes: /^SCORM/i.test(standard) ? ['transient', 'cached', 'virtual'] : ['transient', 'cached'] };
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
    } else if (grant.mode === 'virtual') {
      let loaded;
      try {
        loaded = await readScormSource({ sourceScope: connection.id, courseId: course.id, version: Number(course.version),
          title: course.title, question, signal: combined, request: (path, limit, abort) => this.read(connection, path, abort, limit) });
      } catch (error) {
        if (error instanceof ScormSourceError) throw new UserCourseError(error.message, error.status, error.code);
        this.retrievalFailure(connection, grant, combined, error);
      }
      material = loaded.material;
      source = { provider: 'scorm-cloud', course_id: course.id, title: course.title, version: course.version,
        source_version: material.version, projection_sha256: loaded.projectionSha256, fingerprint_scope: 'selected-instructional-projection',
        retrieval: loaded.retrieval };
      graph = { representation: 'request-local-source-structure', nodes: loaded.graph.nodes.length, edges: loaded.graph.edges.length,
        local_content_graph: false, retained: false, semantic_prerequisites_inferred: false,
        retrieval: loaded.retrieval.strategy, scope: 'selected-source-files-only' };
    } else {
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
      ...(grant.lti ? { lti: this.ltiContext(grant.lti) } : {}),
      scope: 'this-session', copied_content: grant.mode === 'virtual' ? connection.provider === 'scorm-cloud'
        ? 'bounded selected source files read in request memory; no ZIP export or retained course text/graph; question planning runs in Foxxi'
        : 'question-selected passages only' : 'package retrieved in memory; cached mode retains instructional text and graph only',
      client_retention: 'Passages already shared with your AI client are subject to that client\'s retention and are not erased by deleting this cache.' };
    packet.course_access = access;
    if (grant.lti) source.lti = this.ltiContext(grant.lti);
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
  private ltiView(setup: LtiSetup): Row {
    let launch: CourseLtiLaunchEvidence | undefined;
    if (!['revoked', 'cleanup-failed'].includes(setup.state)) {
      try {
        const status = this.lti.status(setup.id, setup.binding); launch = status.launch;
        if (status.state === 'verified') setup.state = 'verified';
        else if (status.state === 'consumed') setup.state = 'attached';
      } catch { setup.state = 'revoked'; }
    }
    return { id: setup.id, state: setup.state, tool: setup.tool, expires_at: setup.tool.expires_at,
      ...(setup.connectorId ? { connector_id: setup.connectorId } : {}), ...(setup.helperCourseId ? { helper_course_id: setup.helperCourseId } : {}),
      ...(launch ? { launch } : {}), ...(setup.note ? { note: setup.note } : {}) };
  }
  private ltiContext(launch: CourseLtiLaunchEvidence): Row {
    const { subject: _privatePlatformSubject, ...reference } = launch;
    return { verification: 'signed-lti13-platform-launch', ...reference, subject_shared: false,
      identity_binding: 'The verified platform subject was explicitly associated with this authenticated browser session.' };
  }
  private async cloudJson(connection: Connection, path: string, signal: AbortSignal, method = 'GET', body?: Row): Promise<Row> {
    const bytes = await this.cloudRequest(connection, path, signal, 1024 * 1024, method, body);
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { refuse('SCORM Cloud returned an unsupported setup response.', 502, 'course_lti_provider_unavailable'); }
    if (!object(value)) refuse('SCORM Cloud returned an unsupported setup response.', 502, 'course_lti_provider_unavailable');
    return value;
  }
  private cloudEndpoint(value: unknown, label: string): string {
    const raw = text(value, 2048, label), url = new URL(raw);
    if (url.protocol !== 'https:' || !['cloud.scorm.com', 'app.cloud.scorm.com'].includes(url.hostname) || url.username || url.password ||
        url.hash || url.port && url.port !== '443') refuse('The Cloud LTI endpoint is outside the supported provider.', 502, 'course_lti_provider_unavailable');
    return raw;
  }
  private async cloudConnector(connection: Connection, setup: LtiSetup, signal: AbortSignal): Promise<Row | null> {
    const listing = await this.cloudJson(connection, '/contentConnectors?includeAdditionalInstanceInformation=true', signal);
    if (!Array.isArray(listing.connectorEntries) || listing.connectorEntries.length > 500) refuse('The Cloud LTI connection list exceeds capacity.', 502, 'course_lti_provider_unavailable');
    const matches = listing.connectorEntries.filter((item): item is Row => {
      if (!object(item) || item.contentConnectorType !== 'ContentConnector.Lti13' || !object(item.configuration)) return false;
      const config = item.configuration;
      return config.toolPublicKey === setup.tool.public_key_pem && config.toolOidcLoginInitiationsEndpoint === setup.tool.login_url &&
        Array.isArray(config.toolOidcLaunchRedirectUris) && config.toolOidcLaunchRedirectUris.length === 1 && config.toolOidcLaunchRedirectUris[0] === setup.tool.launch_url;
    });
    if (matches.length > 1) refuse('Cloud returned ambiguous connections for this setup. Check Cloud before removing either connection.', 409, 'course_lti_setup_uncertain');
    const found = matches[0];
    if (!found) return null;
    const id = text(found.connectorId, 256, 'Cloud LTI connection identifier');
    if (setup.connectorId && setup.connectorId !== id) refuse('The Cloud LTI connection identity changed.', 409, 'course_lti_setup_uncertain');
    setup.connectorId = id;
    return found;
  }
  private async reconcileLti(connection: Connection, setup: LtiSetup, signal: AbortSignal): Promise<void> {
    if (setup.removed || setup.state === 'revoked' || setup.state === 'cleanup-failed') return;
    const connector = await this.cloudConnector(connection, setup, signal);
    this.requireLtiActive(connection, setup, signal);
    if (!connector) { setup.note = 'Cloud has not confirmed creation of this exact connection. Check again; do not create a duplicate.'; return; }
    if (connector.enabled !== true || !object(connector.additionalInstanceInformation)) refuse('The Cloud LTI connection is disabled or incomplete.', 409, 'course_lti_setup_uncertain');
    if (!setup.configured) {
      const info = connector.additionalInstanceInformation;
      this.lti.configure(setup.id, { issuer: this.cloudEndpoint(info.issuer, 'Cloud issuer'),
        clientId: text(info.toolClientId, 512, 'Cloud client identifier'), deploymentId: text(info.deploymentId, 512, 'Cloud deployment identifier'),
        jwksUrl: this.cloudEndpoint(info.jwksEndpoint, 'Cloud keys endpoint'), authorizationEndpoint: this.cloudEndpoint(info.oidcAuthorizationUrl, 'Cloud authorization endpoint'),
        ...(info.accessTokenUrl ? { tokenEndpoint: this.cloudEndpoint(info.accessTokenUrl, 'Cloud token endpoint') } : {}) }, setup.id);
      setup.configured = true;
    }
    if (!setup.helperRequested) {
      setup.note = 'The Cloud connection was confirmed, but the helper course has not been requested. If setup was interrupted, remove this temporary connection before preparing another.';
      return;
    }
    if (setup.importJobId) {
      const job = await this.cloudJson(connection, '/courses/importJobs/' + encodeURIComponent(setup.importJobId), signal);
      this.requireLtiActive(connection, setup, signal);
      if (job.jobId !== setup.importJobId || !['RUNNING', 'COMPLETE', 'ERROR'].includes(String(job.status))) refuse('Cloud returned an unsupported helper-course status.', 502, 'course_lti_provider_unavailable');
      if (job.status === 'RUNNING') { setup.note = 'Cloud is still preparing the separate LTI helper course. Check its status again.'; return; }
      if (job.status === 'ERROR') { setup.helperSettled = true; setup.note = 'Cloud could not prepare the LTI helper course. Remove this temporary setup before trying again.'; return; }
      if (!object(job.importResult) || !object(job.importResult.course) || job.importResult.course.id !== setup.helperCourseId) refuse('The imported helper does not match this setup.', 409, 'course_lti_setup_uncertain');
      setup.helperSettled = true;
    }
    let helper: Row;
    try { helper = await this.cloudJson(connection, '/courses/' + encodeURIComponent(setup.helperCourseId!), signal); }
    catch (error) { if (error instanceof UserCourseError && error.status === 404) { setup.note = 'Cloud has not confirmed the helper course yet. Check its status again.'; return; } throw error; }
    this.requireLtiActive(connection, setup, signal);
    if (helper.id !== setup.helperCourseId) refuse('The Cloud helper course identity changed.', 409, 'course_lti_setup_uncertain');
    setup.state = 'ready'; setup.note = undefined;
    // Preserve a launch which finished while a provider status read was in flight.
    this.ltiView(setup);
  }
  private requireLtiActive(connection: Connection, setup: LtiSetup, signal: AbortSignal): void {
    this.requireCurrent(connection);
    const grant = connection.grants.get(setup.course);
    if (!grant || grant.id !== setup.grantId || grant.expires <= this.clock() || grant.abort.signal.aborted || signal.aborted ||
        setup.removed || ['revoked', 'cleanup-failed'].includes(setup.state)) {
      refuse('This LTI course permission ended. No further setup operation was authorized.', 410, 'course_lti_expired');
    }
  }
  private async cleanupLti(connection: Connection, setup: LtiSetup, authorization: string): Promise<boolean> {
    if (setup.removed) return true;
    if (setup.cleanup) return setup.cleanup;
    try { this.lti.revoke(setup.id, setup.binding); } catch (error) { if (!(error instanceof CourseLtiError && error.status === 410)) return false; }
    const grant = connection.grants.get(setup.course);
    if (grant?.ltiId === setup.id) { grant.lti = undefined; grant.ltiId = undefined; }
    setup.state = 'revoked';
    setup.cleanup = (async () => {
      const signal = AbortSignal.timeout(15_000);
      // Do not race deletion against a provider create which is still settling.
      if (setup.pending) {
        let settled = false;
        await Promise.race([setup.pending.catch(() => undefined).then(() => { settled = true; }), new Promise<void>(resolve => {
          if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
        })]);
        if (!settled) { setup.state = 'cleanup-failed'; setup.note = 'Cloud setup is still settling. Local access ended; check cleanup again.'; return false; }
      }
      // Recover a lost connector-create response through its exact public key
      // and unique callback URLs, using only the original connection credential.
      if (setup.connectorRequested && !setup.connectorId && authorization) {
        try {
          const response = await this.fetcher(CLOUD + '/contentConnectors?includeAdditionalInstanceInformation=true', {
            method: 'GET', redirect: 'error', signal, headers: { Authorization: authorization, Accept: 'application/json' } });
          if (response.ok && !response.redirected && (!response.url || response.url === CLOUD + '/contentConnectors?includeAdditionalInstanceInformation=true')) {
            const listing: unknown = JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8'));
            if (object(listing) && Array.isArray(listing.connectorEntries) && listing.connectorEntries.length <= 500) {
              const matches = listing.connectorEntries.filter((row): row is Row => object(row) && object(row.configuration) &&
                row.contentConnectorType === 'ContentConnector.Lti13' && row.configuration.toolPublicKey === setup.tool.public_key_pem &&
                row.configuration.toolOidcLoginInitiationsEndpoint === setup.tool.login_url && Array.isArray(row.configuration.toolOidcLaunchRedirectUris) &&
                row.configuration.toolOidcLaunchRedirectUris.length === 1 && row.configuration.toolOidcLaunchRedirectUris[0] === setup.tool.launch_url);
              if (matches.length === 1 && typeof matches[0]!.connectorId === 'string') setup.connectorId = text(matches[0]!.connectorId, 256, 'Created Cloud connection identifier');
            }
          } else await response.body?.cancel();
        } catch { /* Unknown creation never becomes a confirmed deletion. */ }
      }
      const remove = async (path: string): Promise<boolean> => {
        if (!authorization) return false;
        try {
          const response = await this.fetcher(CLOUD + path, { method: 'DELETE', redirect: 'error', signal,
            headers: { Authorization: authorization, Accept: 'application/json' } });
          await response.body?.cancel();
          return !response.redirected && (!response.url || response.url === CLOUD + path) && (response.status === 204 || response.status === 404);
        } catch { return false; }
      };
      let helper = !setup.helperRequested, connector = !setup.connectorRequested;
      if (setup.helperRequested && !setup.helperSettled && setup.importJobId && authorization) {
        try {
          const response = await this.fetcher(CLOUD + '/courses/importJobs/' + encodeURIComponent(setup.importJobId), {
            method: 'GET', redirect: 'error', signal, headers: { Authorization: authorization, Accept: 'application/json' } });
          if (response.ok && !response.redirected && (!response.url || response.url === CLOUD + '/courses/importJobs/' + encodeURIComponent(setup.importJobId))) {
            const job: unknown = JSON.parse((await boundedBody(response, 64 * 1024)).toString('utf8'));
            if (object(job) && job.jobId === setup.importJobId && (job.status === 'ERROR' || job.status === 'COMPLETE' && object(job.importResult) && object(job.importResult.course) && job.importResult.course.id === setup.helperCourseId)) setup.helperSettled = true;
          } else await response.body?.cancel();
        } catch { /* A pending or unreadable import is not confirmed removed. */ }
      }
      if (setup.helperCourseId && setup.helperRequested) {
        // The only deletion target is the independently generated helper ID.
        if (setup.helperCourseId !== 'i2idlx-lti-qa-' + setup.id || setup.binding.courseId === setup.helperCourseId) return false;
        helper = await remove('/courses/' + encodeURIComponent(setup.helperCourseId)) && setup.helperSettled === true;
      }
      if (setup.connectorId) connector = await remove('/contentConnectors/' + encodeURIComponent(setup.connectorId));
      if (!connector && setup.connectorId && authorization) {
        try {
          const response = await this.fetcher(CLOUD + '/contentConnectors/' + encodeURIComponent(setup.connectorId), {
            method: 'PUT', redirect: 'error', signal, headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
          await response.body?.cancel();
        } catch { /* The outcome remains unconfirmed; never claim removal here. */ }
      }
      setup.removed = helper && connector;
      setup.state = setup.removed ? 'revoked' : 'cleanup-failed';
      setup.note = setup.removed ? undefined : 'Foxxi access was revoked, but Cloud helper or connection removal is unconfirmed. Retry removal or check Cloud settings.';
      return setup.removed;
    })().finally(() => { setup.cleanup = undefined; });
    return setup.cleanup;
  }
  private async ltiOperation(connection: Connection, args: Row, signal: AbortSignal): Promise<Row> {
    if (connection.provider !== 'scorm-cloud') refuse('This LTI setup is available for SCORM Cloud connections only.', 400, 'course_mode_unsupported');
    const course = this.course(connection, args), key = courseKey(course.id, course.version), operation = String(args.operation);
    if (operation === 'lti-prepare') {
      const grant = this.requireGrant(connection, course, args.grant_id);
      const prior = [...connection.ltiSetups.values()].find(value => value.grantId === grant.id && !value.removed);
      if (prior) return { lti: this.ltiView(prior) };
      for (const [id, entry] of connection.ltiSetups) if (entry.removed) connection.ltiSetups.delete(id);
      if (connection.ltiSetups.size >= 4) refuse('Remove an older LTI setup before preparing another.', 429, 'course_rate_limited');
      const binding: CourseLtiBinding = { sessionId: connection.session, actor: connection.actor, connectionId: connection.id,
        courseId: course.id, version: course.version, expiresAt: grant.expires, signal: AbortSignal.any([connection.abort.signal, grant.abort.signal]) };
      const tool = this.lti.prepare(binding), setup: LtiSetup = { id: tool.id, course: key, grantId: grant.id, binding, tool, state: 'prepared' };
      connection.ltiSetups.set(tool.id, setup); grant.ltiId = tool.id;
      return { lti: this.ltiView(setup) };
    }
    const id = text(args.lti_id, 64, 'LTI setup identifier'), setup = connection.ltiSetups.get(id);
    if (!setup || setup.course !== key || args.grant_id !== undefined && args.grant_id !== setup.grantId) refuse('This LTI setup does not belong to the selected course connection.', 404, 'course_lti_binding_mismatch');
    if (operation === 'lti-disconnect') {
      // Recover the exact created connector after an uncertain create, never a guessed ID.
      if (setup.connectorRequested && !setup.connectorId && !setup.removed) await this.cloudConnector(connection, setup, signal);
      const removed = await this.cleanupLti(connection, setup, connection.authorization);
      return { removed, lti: removed ? null : this.ltiView(setup), original_course_unchanged: true };
    }
    const grant = this.requireGrant(connection, course, args.grant_id);
    if (grant.id !== setup.grantId) refuse('This LTI setup belongs to an earlier course permission.', 403, 'course_lti_binding_mismatch');
    signal = AbortSignal.any([signal, grant.abort.signal]);
    this.requireLtiActive(connection, setup, signal);
    if (operation === 'lti-setup') {
      if (grant.authority !== 'owner') refuse('Only the source owner may create a trusted Cloud LTI connection.', 403, 'course_lti_permission_denied');
      if (setup.setupStarted) return { lti: this.ltiView(setup) };
      setup.setupStarted = true; setup.state = 'setting-up';
      const pending = (async () => {
      try {
        this.requireLtiActive(connection, setup, signal);
        setup.connectorRequested = true;
        const created = await this.cloudJson(connection, '/contentConnectors', signal, 'POST', { contentConnectorType: 'ContentConnector.Lti13',
          configuration: { toolPublicKey: setup.tool.public_key_pem, toolOidcLoginInitiationsEndpoint: setup.tool.login_url,
            toolOidcLaunchRedirectUris: [setup.tool.launch_url] }, enabled: true });
        setup.connectorId = text(created.result, 256, 'Created Cloud connection identifier');
        this.requireLtiActive(connection, setup, signal);
        await this.reconcileLti(connection, setup, signal);
        if (!setup.configured) return;
        this.requireLtiActive(connection, setup, signal);
        setup.helperCourseId = 'i2idlx-lti-qa-' + setup.id; setup.helperRequested = true;
        const imported = await this.cloudJson(connection, '/courses/importJobs/noUpload?' + new URLSearchParams({ courseId: setup.helperCourseId, mayCreateNewVersion: 'false' }), signal, 'POST', {
          connectorReferenceRequest: { connectorId: setup.connectorId, metadataForConnector: { url: setup.tool.launch_url,
            title: utf8Prefix('Course Q&A: ' + course.title, 200), ltiMetadata: { description: 'Temporary owner-authorized course Q&A launch', context: { contextId: setup.id } } } } });
        setup.importJobId = text(imported.result, 256, 'Cloud helper import job');
        this.requireLtiActive(connection, setup, signal);
        await this.reconcileLti(connection, setup, signal);
      } catch (error) {
        if (!['revoked', 'cleanup-failed'].includes(setup.state)) setup.note = 'Cloud setup is unconfirmed. Check the connection before retrying or removing it.';
        if (connection.abort.signal.aborted || signal.aborted || error instanceof UserCourseError && error.code === 'course_provider_authentication_failed') throw error;
      }
      })();
      setup.pending = pending;
      try { await pending; } finally { setup.pending = undefined; }
      return { lti: this.ltiView(setup) };
    }
    if (operation === 'lti-status') { if (setup.setupStarted) await this.reconcileLti(connection, setup, signal); return { lti: this.ltiView(setup) }; }
    if (operation === 'lti-attach') {
      if (!grant.lti) grant.lti = this.lti.consume(setup.id, setup.binding);
      setup.state = 'attached'; return { ...this.accessState(connection, course, grant), lti: this.ltiView(setup) };
    }
    if (operation === 'lti-launch') {
      if (!['ready', 'verified'].includes(setup.state)) refuse('Check the LTI setup before opening a launch.', 409, 'course_lti_launch_required');
      const preview = await this.cloudJson(connection, '/courses/' + encodeURIComponent(setup.helperCourseId!) + '/preview', signal, 'POST', { expiry: 120 });
      return { lti: this.ltiView(setup), launch_url: this.cloudEndpoint(preview.launchLink, 'Cloud preview link') };
    }
    refuse('Unknown LTI connection operation.');
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
      let removed = true, hadLti = false;
      if (connection) {
        hadLti = connection.ltiSetups.size > 0;
        const results = await Promise.all([...connection.ltiSetups.values()].map(setup => this.cleanupLti(connection, setup, connection.authorization)));
        removed = results.every(Boolean); this.drop(connection);
      }
      return { connected: false, ...(hadLti ? { lti_cleanup: { removed, ...(!removed ? { note: 'Foxxi access ended, but some temporary Cloud LTI setup could not be confirmed removed. Check the connection in your SCORM Cloud settings.' } : {}) } } : {}) };
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
        courses: new Map(), pages: new Map(), grants: new Map(), revoked: new Map(), ltiSetups: new Map(), busy: false, provider, ...(remote ? { remote } : {}) } as Connection;
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
    else if (typeof operation === 'string' && ['lti-prepare', 'lti-setup', 'lti-status', 'lti-launch', 'lti-attach', 'lti-disconnect'].includes(operation)) {
      exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version', 'grant_id', ...(operation === 'lti-prepare' ? [] : ['lti_id'])]);
    }
    else if (operation === 'delete' || operation === 'request-deletion' || operation === 'deletion-status') exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version', 'grant_id', ...(operation === 'deletion-status' ? ['request_id'] : [])]);
    else refuse('Unknown course connection operation.');
    if (!connection || connection.actor !== identity.actor || connection.id !== args.connection_id) refuse('Course connection not found.', 404, 'course_connection_not_found');
    this.requireCurrent(connection);
    if (operation === 'delete' || operation === 'request-deletion' || operation === 'deletion-status') return this.deleteContent(connection, args, signal);
    if (typeof operation === 'string' && operation.startsWith('lti-')) return this.work(connection, fetchSignal => this.ltiOperation(connection, args, fetchSignal), signal);
    return this.work(connection, fetchSignal => operation === 'courses' ? this.list(connection, args.page, fetchSignal)
      : operation === 'grant' ? this.grant(connection, args, fetchSignal)
      : operation === 'access-status' ? this.accessStatus(connection, args, fetchSignal) : this.source(connection, args, fetchSignal), signal);
  }
}

export function attachUserCourseRoutes(app: Express, config: UserCourseConfig): UserCourseStore {
  const store = new UserCourseStore(config), origin = new URL(config.baseUrl).origin;
  store.attachLtiRoutes(app);
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
