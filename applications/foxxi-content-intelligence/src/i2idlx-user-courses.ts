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

type Row = Record<string, unknown>;
type Course = { id: string; title: string; version: number; standard: string };
type Connection = {
  id: string; session: string; actor: string; authorization: string; expires: number;
  abort: AbortController; release: () => void; timer: ReturnType<typeof setTimeout>;
  courses: Map<string, Course>; pages: Map<string, string>; busy: boolean;
};
export interface UserCourseConfig {
  baseUrl: string;
  sessions: Pick<AgentSessionStore, 'authorizeBrowser'>;
  taskConfig: ClientTaskConfig;
  fetch?: typeof fetch;
  now?: () => number;
  connectionTtlMs?: number;
}
export const USER_COURSE_PATH = '/i2idlx/api/user-courses';
const CLOUD = 'https://cloud.scorm.com/api/v2';
const MAX_ZIP = 16 * 1024 * 1024, MAX_INFLATED = 32 * 1024 * 1024, MAX_FILE = 4 * 1024 * 1024;
const MAX_ENTRIES = 2000, MAX_BODY = 16 * 1024;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const opaque = () => randomBytes(24).toString('hex');
const courseKey = (id: string, version: number) => JSON.stringify([id, version]);
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
  return {
    names: [...names],
    read(name: string): Buffer | null {
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
    return { connected: true, provider: 'scorm-cloud', connection_id: connection.id, expires_at: new Date(connection.expires).toISOString(), ephemeral: true, persisted: false };
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
      this.requireCurrent(connection);
      return refuse('The course could not be read from SCORM Cloud. Try again.', 502, 'course_provider_unavailable');
    } finally {
      clearTimeout(timeout); connection.abort.signal.removeEventListener('abort', stop);
      external?.removeEventListener('abort', stop); connection.busy = false; this.active--;
    }
  }
  private async read(connection: Connection, path: string, signal: AbortSignal, limit: number): Promise<Buffer> {
    this.requireCurrent(connection);
    const response = await this.fetcher(CLOUD + path, { method: 'GET', redirect: 'error', signal,
      headers: { Authorization: connection.authorization, Accept: path.endsWith('/zip') ? 'application/zip' : 'application/json' } });
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
      const course = { id, title, version: Number(value.version), standard: typeof value.learningStandard === 'string' ? value.learningStandard.slice(0, 100) : typeof value.courseLearningStandard === 'string' ? value.courseLearningStandard.slice(0, 100) : 'Unreported' };
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
  private async source(connection: Connection, args: Row, signal: AbortSignal): Promise<Row> {
    const courseId = text(args.course_id, 256, 'Course identifier');
    if (!Number.isSafeInteger(args.version) || Number(args.version) < 0) refuse('Choose a listed course version.');
    const course = connection.courses.get(courseKey(courseId, Number(args.version)));
    if (!course) refuse('Choose a course version from this connection\'s catalog.', 404, 'course_source_unavailable');
    const question = text(args.question, 4000, 'Question', true);
    const bytes = await this.read(connection, '/courses/' + encodeURIComponent(course.id) + '/versions/' + course.version + '/zip', signal, MAX_ZIP);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const urn = 'urn:scorm-cloud:course:' + encodeURIComponent(course.id) + ':version:' + course.version;
    let imported;
    try { imported = readAnyPackage(packageFiles(bytes), { title: course.title, fileUrl: path => urn + ':file:' + encodeURIComponent(path) }); }
    catch (error) {
      if (error instanceof UserCourseError) throw error;
      refuse('This course package could not be projected into instructional text.', 422, 'course_source_unsupported');
    }
    const pages = imported.topics.flatMap(topic => topic.pages).filter(page => page.body.trim());
    const sections = pages.slice(0, 5000).map(page => ({
      id: utf8Prefix(page.path, 200), title: utf8Prefix(page.title || course.title, 400), body: utf8Prefix(page.body, 96_000),
      source_uri: urn + ':file:' + encodeURIComponent(page.path), locator: utf8Prefix(page.path, 400),
    }));
    const material = { id: digest, title: course.title, kind: 'SCORM Cloud course', source_uri: urn,
      version: 'course-version:' + course.version + ';sha256:' + digest, sections,
      missing_context: [...(imported.unread.length ? ['Some package resources could not be converted into instructional text.'] : []),
        ...(pages.length > sections.length ? ['Only the first 5000 instructional sections were available to this retrieval.'] : []),
        'Package retrieval does not establish course delivery, assessment results or learning completion.'],
    };
    let packet: Row;
    try { packet = await executeInterventionTask({ ...this.config.taskConfig, readIntervention: async () => material }, {
      source: 'package', intervention_id: digest, question, lens: 'analyze',
    }); } catch (error) {
      const failure = interventionTaskFailure(error);
      refuse(typeof failure.body.error === 'string' ? failure.body.error : 'Instructional source context is unavailable.', failure.status, 'course_source_unavailable');
    }
    const context = packet.source_context as Row;
    const citations = (context.sections as Row[]).map(section => ({ id: section.citation_id, title: section.title,
      body: section.body, locator: section.locator, source_uri: section.source_uri }));
    return { connection_id: connection.id, source: { provider: 'scorm-cloud', course_id: course.id, title: course.title, version: course.version, package_sha256: digest },
      citations, missing_context: context.missing_context, retrieved_at: new Date(this.clock()).toISOString(),
      truncated: (context.retrieval as Row).excerpt_truncated, interventionContext: packet };
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
    this.limit(identity);
    if (operation === 'connect') {
      exact(args, ['session_id', 'operation', 'credentials']);
      const authorization = credentialsOf(args.credentials), previous = this.connections.get(identity.session_id);
      if (previous) this.drop(previous);
      if (this.connections.size >= 64) refuse('Too many temporary course connections.', 429, 'course_rate_limited');
      const connection = { id: opaque(), session: identity.session_id, actor: identity.actor, authorization,
        expires: Math.min(identity.expires_at, this.clock() + this.ttl), abort: new AbortController(),
        courses: new Map(), pages: new Map(), busy: false } as Connection;
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
    else if (operation === 'source') exact(args, ['session_id', 'operation', 'connection_id', 'course_id', 'version', 'question']);
    else refuse('Unknown course connection operation.');
    if (!connection || connection.actor !== identity.actor || connection.id !== args.connection_id) refuse('Course connection not found.', 404, 'course_connection_not_found');
    return this.work(connection, fetchSignal => operation === 'courses'
      ? this.list(connection, args.page, fetchSignal) : this.source(connection, args, fetchSignal), signal);
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
      else respond(res, 500, { error: 'The temporary course operation could not be completed.', code: 'course_provider_unavailable' });
    } finally { res.removeListener('close', closed); }
  });
  return store;
}
function respond(res: ExpressResponse, status: number, body: Row): void {
  if (status === 429) res.set('Retry-After', '60');
  res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').status(status).json(body);
}
