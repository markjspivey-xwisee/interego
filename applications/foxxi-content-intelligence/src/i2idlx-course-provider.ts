/** Source-resident course retrieval. The service endpoint is selected by the user;
 * every network connection is HTTPS, DNS-screened at connect time and never redirected.
 * The provider, not an LTI launch or a browser assertion, authorizes the course grant. */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isPrivateHostname } from './ssrf-guard.js';

export const SOURCE_COURSE_PROTOCOL = 'i2idlx-course-source/1';
export const COURSE_SOURCE_PROTOCOL = SOURCE_COURSE_PROTOCOL;
const MAX_RESPONSE = 192_000, MAX_SECTIONS = 24, MAX_SECTION = 6000, MAX_TEXT = 72_000;
type Row = Record<string, unknown>;
export type SourceCourseVersion = string | number;
export interface SourceCourse {
  id: string; title: string; version: SourceCourseVersion; standard: string;
  source_uri: string; access_modes: ['virtual'];
}
export interface SourceLtiContext {
  issuer: string; client_id: string; deployment_id: string; context_id?: string;
  resource_link_id: string; verified_at: string;
}
export interface SourceGrant {
  id: string; owner: string; actor: string; course_id: string; version: SourceCourseVersion;
  expires_at: string; access_modes: ['virtual']; permissions: string[]; lti?: SourceLtiContext;
}
export interface SourceSection { id: string; title: string; body: string; source_uri: string; locator: string; }
export interface SourceGraph {
  nodes: Array<{ id: string; label: string; section_id?: string }>;
  edges: Array<{ from: string; to: string; relation: string }>;
}
export interface SourceDeletionReceipt {
  request_id: string; course_id: string; version: SourceCourseVersion;
  status: 'pending' | 'completed'; scope: 'derived-content'; requested_at: string; completed_at?: string;
}
export interface SourceTransportResponse { status: number; headers: Readonly<Record<string, string>>; body: Buffer; }
/** Dependency injection belongs to trusted application configuration, never request JSON. */
export type SourceTransport = (url: URL, body: Buffer, headers: Readonly<Record<string, string>>,
  signal: AbortSignal) => Promise<SourceTransportResponse>;
export interface SourceProviderOptions { actor: string; now?: () => number; transport?: SourceTransport; }
export interface SourceCourseCredentials { service_url: string; token: string; }
export interface SourceCourseResult {
  material: { id: string; title: string; kind: string; source_uri: string; version: string;
    sections: SourceSection[]; missing_context: string[] };
  source: { provider: 'source-service'; course_id: string; title: string; version: SourceCourseVersion;
    content_sha256: string; service_origin: string; lti?: SourceLtiContext };
  grant: SourceGrant; graph?: SourceGraph;
}
export class SourceProviderError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'course_provider_invalid') { super(message); }
}
function fail(message: string, status = 400, code?: string): never { throw new SourceProviderError(message, status, code); }
const object = (x: unknown): x is Row => x !== null && typeof x === 'object' && !Array.isArray(x);
const bytes = (x: string) => Buffer.byteLength(x, 'utf8');
function text(x: unknown, max: number, label: string, multiline = false): string {
  if (typeof x !== 'string' || !x.trim() || bytes(x) > max ||
    (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/ : /[\u0000-\u001f]/).test(x)) {
    fail('The source service returned an invalid ' + label + '.', 502);
  }
  return x;
}
function version(x: unknown): SourceCourseVersion {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return x;
  return text(x, 160, 'course version');
}
function identifier(x: unknown, label: string): string {
  const s = text(x, 2048, label);
  let u: URL; try { u = new URL(s); } catch { return fail('The source service returned an invalid ' + label + '.', 502); }
  if (!['https:', 'urn:', 'did:'].includes(u.protocol) || u.username || u.password) fail('The source service returned an invalid ' + label + '.', 502);
  return s;
}
function date(x: unknown, label: string): string {
  const s = text(x, 80, label);
  if (!Number.isFinite(Date.parse(s))) fail('The source service returned an invalid ' + label + '.', 502);
  return s;
}
function sameCourse(row: Row, course: Pick<SourceCourse, 'id' | 'version'>): void {
  if (row.course_id !== course.id || row.version !== course.version) fail('The source service returned a different course or version.', 502, 'course_source_mismatch');
}

/** Stricter than private-address detection: refuse non-global/special-use results too. */
export function isPublicSourceAddress(address: string): boolean {
  if (!isIP(address) || isPrivateHostname(address)) return false;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 192 && (b === 0 || b === 88 && c === 99 || b === 168) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || (a ?? 255) >= 224);
  }
  const normalized = new URL('https://[' + address + ']/').hostname.slice(1, -1).toLowerCase();
  // Accept global unicast only. Refuse mapped/NAT64, 6to4, Teredo and documentation ranges.
  if (!/^[23][0-9a-f]{3}:/.test(normalized) || normalized.startsWith('2002:') || normalized.startsWith('3fff:')) return false;
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001::')) return false;
  if (/^2001:(?:[0-9a-f]{1,2}|1[0-9a-f]{2})(?=:)/.test(normalized)) return false;
  return true;
}
export function sourceServiceUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048) fail('Enter the exact HTTPS endpoint supplied by your course source.');
  let url: URL; try { url = new URL(raw); } catch { return fail('Enter the exact HTTPS endpoint supplied by your course source.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    url.port && url.port !== '443' || !host.includes('.') && !isIP(host) ||
    /(?:^|\.)(?:localhost|internal|local|lan|home|localdomain)$/.test(host) ||
    isPrivateHostname(host) || isIP(host) && !isPublicSourceAddress(host)) {
    fail('The course source must use a public HTTPS endpoint without credentials, query parameters or fragments.');
  }
  return url;
}

/** Resolve inside the socket lookup; Node connects to the screened result without resolving again. */
export async function sourceConnectionAddresses(hostname: string,
  resolve: (hostname: string) => Promise<LookupAddress[]> = host => dnsLookup(host, { all: true })): Promise<LookupAddress[]> {
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
  if (!addresses.length || addresses.some(row => !isPublicSourceAddress(row.address))) {
    fail('The source service resolves outside the public network.', 400, 'course_provider_address_refused');
  }
  return addresses;
}

export const pinnedSourceTransport: SourceTransport = async (url, body, headers, signal) => {
  sourceServiceUrl(url.href);
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SourceProviderError('The course request was cancelled.', 499, 'cancelled')); return; }
    const req = httpsRequest(url, {
      method: 'POST', agent: false, signal, headers: { ...headers, 'Content-Length': String(body.length) },
      lookup(hostname, options, callback) {
        sourceConnectionAddresses(hostname).then(addresses => {
          // Node 20+ asks for all addresses when automatic family selection is active.
          if (options.all) callback(null, addresses);
          else { const selected = addresses[0]!; callback(null, selected.address, selected.family); }
        }, error => callback(error instanceof Error ? error : new Error('Source address lookup failed.'), []));
      },
    }, response => {
      const chunks: Buffer[] = []; let length = 0;
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') responseHeaders[key] = value;
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_RESPONSE) {
        response.destroy(); reject(new SourceProviderError('The source service response exceeded passage capacity.', 413, 'course_source_too_large')); return;
      }
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE) { response.destroy(new SourceProviderError('The source service response exceeded passage capacity.', 413, 'course_source_too_large')); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 502, headers: responseHeaders, body: Buffer.concat(chunks, length) }));
    });
    req.once('error', reject); req.setTimeout(15_000, () => req.destroy(new Error('Source request timed out.'))); req.end(body);
  });
};

export class SourceCourseProvider {
  private readonly endpoint: URL;
  private token: string;
  private readonly actor: string;
  private readonly now: () => number;
  private readonly transport: SourceTransport;
  private readonly lifetime = new AbortController();
  private discovered = false;
  constructor(credentials: SourceCourseCredentials, options: SourceProviderOptions) {
    this.endpoint = sourceServiceUrl(credentials.service_url);
    if (typeof credentials.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(credentials.token)) fail('Provide the scoped source service access token.');
    this.token = credentials.token; this.actor = text(options.actor, 2048, 'paired agent');
    this.now = options.now ?? Date.now; this.transport = options.transport ?? pinnedSourceTransport;
  }
  dispose(): void { this.token = ''; this.lifetime.abort(); }
  private async call(operation: string, input: Row, external?: AbortSignal): Promise<Row> {
    if (this.lifetime.signal.aborted || !this.token) fail('The source connection has ended.', 410, 'course_connection_expired');
    const controller = new AbortController(), stop = () => controller.abort();
    external?.addEventListener('abort', stop, { once: true });
    this.lifetime.signal.addEventListener('abort', stop, { once: true });
    if (external?.aborted) stop();
    const timeout = setTimeout(stop, 20_000); timeout.unref();
    try {
      const encoded = Buffer.from(JSON.stringify({ protocol: SOURCE_COURSE_PROTOCOL, operation, actor: this.actor, ...input }));
      const response = await this.transport(new URL(this.endpoint.href), encoded,
        { Authorization: 'Bearer ' + this.token, Accept: 'application/json', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, controller.signal);
      if (controller.signal.aborted) fail('The course request was cancelled or timed out.', 504, 'course_provider_unavailable');
      if (response.status === 401 || response.status === 403 || response.status === 410) fail('The source owner has not authorized this access, or the grant has ended.', 403, 'course_permission_required');
      if (response.status >= 300 && response.status < 400) fail('Source service redirects are refused.', 502, 'course_provider_redirect_refused');
      if (response.status !== 200) fail('The source service could not complete this operation.', 502, 'course_provider_unavailable');
      if (response.body.length > MAX_RESPONSE) fail('The source service response exceeded passage capacity.', 413, 'course_source_too_large');
      const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') fail('The source service must return bounded JSON passages.', 502);
      const value: unknown = JSON.parse(response.body.toString('utf8'));
      if (!object(value) || value.protocol !== SOURCE_COURSE_PROTOCOL) fail('The source service protocol is unsupported.', 502);
      return value;
    } catch (error) {
      if (error instanceof SourceProviderError) throw error;
      return fail('The source service could not be reached safely.', 502, 'course_provider_unavailable');
    } finally {
      clearTimeout(timeout); external?.removeEventListener('abort', stop); this.lifetime.signal.removeEventListener('abort', stop);
    }
  }
  private async discover(signal?: AbortSignal): Promise<void> {
    if (this.discovered) return;
    const value = await this.call('capabilities', {}, signal);
    const required = ['courses', 'permission', 'context', 'request-deletion', 'deletion-status'];
    const operations = value.operations;
    if (!Array.isArray(operations) || !required.every(op => operations.includes(op)) ||
      !Array.isArray(value.access_modes) || !value.access_modes.includes('virtual')) fail('This source service does not advertise virtual retrieval and owner deletion controls.', 502);
    this.discovered = true;
  }
  async courses(page?: string, signal?: AbortSignal): Promise<{ courses: SourceCourse[]; next_page?: string }> {
    await this.discover(signal);
    const raw = await this.call('courses', page === undefined ? {} : { page: text(page, 4096, 'catalog cursor') }, signal);
    if (!Array.isArray(raw.courses) || raw.courses.length > 200) fail('The source course catalog exceeds capacity.', 502);
    const seen = new Set<string>();
    const courses = raw.courses.map((row: unknown): SourceCourse => {
      if (!object(row) || !Array.isArray(row.access_modes) || !row.access_modes.includes('virtual')) fail('The source catalog has an invalid virtual course.', 502);
      const course: SourceCourse = { id: text(row.id, 256, 'course identifier'), title: text(row.title, 400, 'course title'),
        version: version(row.version), source_uri: identifier(row.source_uri, 'course source identifier'),
        standard: row.standard === undefined ? 'External' : text(row.standard, 100, 'course standard'), access_modes: ['virtual'] };
      const key = JSON.stringify([course.id, course.version]);
      if (seen.has(key)) fail('The source catalog contains duplicate course versions.', 502);
      seen.add(key); return course;
    });
    return { courses, ...(raw.next_page === undefined ? {} : { next_page: text(raw.next_page, 4096, 'catalog cursor') }) };
  }
  private grant(raw: unknown, course: Pick<SourceCourse, 'id' | 'version'>, retrieval = true): SourceGrant {
    if (!object(raw)) fail('The source owner did not supply a course permission grant.', 403, 'course_permission_required');
    sameCourse(raw, course);
    if (raw.actor !== this.actor || !Array.isArray(raw.access_modes) || !raw.access_modes.includes('virtual') ||
      !Array.isArray(raw.permissions) || !raw.permissions.every(x => typeof x === 'string' && x.length <= 100)) fail('The source owner grant does not cover this agent or access mode.', 403, 'course_permission_required');
    const expires = date(raw.expires_at, 'permission expiry');
    if (Date.parse(expires) <= this.now()) fail('The source owner permission expired.', 403, 'course_permission_required');
    const permissions = raw.permissions as string[];
    if (retrieval && !['read-passages', 'share-with-paired-agent'].every(p => permissions.includes(p))) fail('The source owner has not allowed course passages to be shared with this agent.', 403, 'course_permission_required');
    let lti: SourceLtiContext | undefined;
    if (raw.lti !== undefined) {
      if (!object(raw.lti)) fail('The source service supplied an invalid launch context.', 502);
      lti = { issuer: identifier(raw.lti.issuer, 'launch issuer'), client_id: text(raw.lti.client_id, 256, 'launch client'),
        deployment_id: text(raw.lti.deployment_id, 256, 'launch deployment'),
        ...(raw.lti.context_id === undefined ? {} : { context_id: text(raw.lti.context_id, 256, 'launch context') }),
        resource_link_id: text(raw.lti.resource_link_id, 256, 'launch resource'), verified_at: date(raw.lti.verified_at, 'launch verification time') };
    }
    return { id: text(raw.id, 256, 'permission identifier'), owner: identifier(raw.owner, 'content owner'), actor: this.actor,
      course_id: course.id, version: course.version, expires_at: expires, access_modes: ['virtual'], permissions, ...(lti ? { lti } : {}) };
  }
  async permission(course: Pick<SourceCourse, 'id' | 'version'>, signal?: AbortSignal): Promise<SourceGrant> {
    const raw = await this.call('permission', { course_id: course.id, version: course.version }, signal);
    return this.grant(raw.grant, course);
  }
  async source(course: Pick<SourceCourse, 'id' | 'title' | 'version'>, question: string, signal?: AbortSignal): Promise<SourceCourseResult> {
    const grant = await this.permission(course, signal);
    const raw = await this.call('context', { course_id: course.id, version: course.version,
      question: text(question, 4000, 'question', true), grant_id: grant.id }, signal);
    const current = this.grant(raw.grant, course);
    if (current.id !== grant.id || current.owner !== grant.owner) fail('The source owner permission changed during retrieval. Select the course again.', 403, 'course_permission_required');
    if (!object(raw.source) || !object(raw.retrieval) || raw.retrieval.scope !== 'question-passages') fail('The source service must return question-specific passages, not a course export.', 502);
    sameCourse(raw.source, course);
    if (!/^[a-f0-9]{64}$/.test(String(raw.source.content_sha256))) fail('The source service did not identify the content version.', 502);
    if (!Array.isArray(raw.sections) || !raw.sections.length || raw.sections.length > MAX_SECTIONS) fail('The source service passages exceed capacity.', 413, 'course_source_too_large');
    let total = 0; const seen = new Set<string>();
    const sections = raw.sections.map((row: unknown): SourceSection => {
      if (!object(row) || row.assessment !== false) fail('The source service must return explicitly instructional, non-assessment passages.', 502);
      const body = text(row.body, MAX_SECTION, 'passage body', true), id = text(row.id, 200, 'passage identifier');
      total += bytes(body);
      if (total > MAX_TEXT || seen.has(id)) fail('The source service passages exceed capacity.', 413, 'course_source_too_large');
      seen.add(id);
      return { id, title: text(row.title, 400, 'passage title'), body,
        source_uri: identifier(row.source_uri, 'passage source identifier'), locator: text(row.locator, 400, 'passage locator') };
    });
    if (!Array.isArray(raw.missing_context) || raw.missing_context.length > 20) fail('The source service must report retrieval limits.', 502);
    const missing = raw.missing_context.map(x => text(x, 1000, 'retrieval limitation', true));
    let graph: SourceGraph | undefined;
    if (raw.graph !== undefined) graph = this.graph(raw.graph, seen);
    const digest = raw.source.content_sha256 as string, uri = identifier(raw.source.source_uri, 'course source identifier');
    const id = createHash('sha256').update(JSON.stringify(['i2idlx:virtual-course:v1', this.endpoint.href, course.id, course.version, digest])).digest('hex');
    return { material: { id, title: text(raw.source.title, 400, 'course title'), kind: text(raw.source.kind, 160, 'course kind'),
      source_uri: uri, version: 'course-version:' + course.version + ';content-sha256:' + digest, sections, missing_context: missing },
    source: { provider: 'source-service', course_id: course.id, title: course.title, version: course.version,
      content_sha256: digest, service_origin: this.endpoint.origin, ...(current.lti ? { lti: current.lti } : {}) }, grant: current, ...(graph ? { graph } : {}) };
  }
  private graph(raw: unknown, sections: Set<string>): SourceGraph {
    if (!object(raw) || !Array.isArray(raw.nodes) || raw.nodes.length > 80 || !Array.isArray(raw.edges) || raw.edges.length > 160) fail('The source graph projection exceeds capacity.', 413, 'course_source_too_large');
    const ids = new Set<string>();
    const nodes = raw.nodes.map((row: unknown) => {
      if (!object(row)) fail('The source service returned an invalid graph node.', 502);
      const id = text(row.id, 256, 'graph node identifier'), label = text(row.label, 400, 'graph label');
      if (ids.has(id)) fail('The source graph contains duplicate nodes.', 502); ids.add(id);
      const section = row.section_id === undefined ? undefined : text(row.section_id, 200, 'graph passage reference');
      if (section !== undefined && !sections.has(section)) fail('The source graph references an absent passage.', 502);
      return { id, label, ...(section ? { section_id: section } : {}) };
    });
    const edges = raw.edges.map((row: unknown) => {
      if (!object(row)) fail('The source service returned an invalid graph relationship.', 502);
      const from = text(row.from, 256, 'graph relationship'), to = text(row.to, 256, 'graph relationship');
      if (!ids.has(from) || !ids.has(to)) fail('The source graph references an absent node.', 502);
      return { from, to, relation: text(row.relation, 160, 'graph relationship') };
    });
    return { nodes, edges };
  }
  private receipt(raw: unknown, course: Pick<SourceCourse, 'id' | 'version'>): SourceDeletionReceipt {
    if (!object(raw)) fail('The source service did not return a deletion receipt.', 502);
    sameCourse(raw, course);
    if (raw.scope !== 'derived-content' || !['pending', 'completed'].includes(String(raw.status))) fail('The source deletion result has an unsupported scope or status.', 502);
    const requested = date(raw.requested_at, 'deletion request time');
    if (raw.status === 'completed' && raw.completed_at === undefined) fail('The source service did not confirm deletion completion.', 502);
    return { request_id: text(raw.request_id, 256, 'deletion request identifier'), course_id: course.id, version: course.version,
      status: raw.status as 'pending' | 'completed', scope: 'derived-content', requested_at: requested,
      ...(raw.completed_at === undefined ? {} : { completed_at: date(raw.completed_at, 'deletion completion time') }) };
  }
  async requestDeletion(course: Pick<SourceCourse, 'id' | 'version'>, grant: SourceGrant, signal?: AbortSignal, idempotencyKey?: string): Promise<SourceDeletionReceipt> {
    sameCourse(grant as unknown as Row, course);
    if (grant.actor !== this.actor || !grant.permissions.includes('request-deletion')) fail('The source owner has not enabled deletion requests for this agent.', 403, 'course_permission_required');
    const key = idempotencyKey ?? createHash('sha256').update(JSON.stringify([this.actor, course.id, course.version, grant.id])).digest('hex');
    const raw = await this.call('request-deletion', { course_id: course.id, version: course.version, grant_id: grant.id,
      idempotency_key: text(key, 128, 'deletion retry identifier') }, signal);
    return this.receipt(raw.receipt, course);
  }
  async deletionStatus(course: Pick<SourceCourse, 'id' | 'version'>, requestId: string, signal?: AbortSignal): Promise<SourceDeletionReceipt> {
    const raw = await this.call('deletion-status', { course_id: course.id, version: course.version, request_id: text(requestId, 256, 'deletion request identifier') }, signal);
    const receipt = this.receipt(raw.receipt, course);
    if (receipt.request_id !== requestId) fail('The source service returned a different deletion request.', 502);
    return receipt;
  }
}
