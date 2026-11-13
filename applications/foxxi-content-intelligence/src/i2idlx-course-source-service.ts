/** Source-side adapter: mount beside the course, not on a replica of its content.
 * The host supplies its own authenticated course readers and live owner policy.
 * This adapter stores no course text, graph, package, questions or answer history.
 */
import type { Express } from 'express';
import { routeJson } from './route-json.js';
import { randomBytes } from 'node:crypto';
import type { VerifiedResourceLaunch } from './lti13.js';

const PROTOCOL = 'i2idlx-course-source/1';
type Row = Record<string, unknown>;
export type SourceVersion = string | number;
export interface SourceCourseReference {
  id: string; title: string; version: SourceVersion; source_uri: string; standard?: string;
}
export interface SourcePrincipal {
  actor: string; course: SourceCourseReference; expires_at: string;
  lti?: { issuer: string; client_id: string; deployment_id: string; context_id?: string; resource_link_id: string; verified_at: string };
}
export interface SourceOwnerPermission {
  id: string; owner: string; expires_at: string;
  permissions: readonly ('read-passages' | 'share-with-paired-agent' | 'request-deletion')[];
}
export interface SourceSection {
  id: string; title: string; body: string; source_uri: string; locator: string;
  /** Assessment material must not be supplied to this instructional reader. */
  assessment: boolean;
}
export interface SourceQuestionContext {
  source: { course_id: string; title: string; version: SourceVersion; source_uri: string; content_sha256: string; kind: string };
  sections: SourceSection[];
  missing_context?: string[];
  graph?: { nodes: { id: string; label: string; section_id?: string }[]; edges: { from: string; to: string; relation: string }[] };
}
export interface SourceDeletionReceipt {
  request_id: string; course_id: string; version: SourceVersion; status: 'pending' | 'completed';
  scope: 'derived-content'; requested_at: string; completed_at?: string;
}
export interface CourseSourceServiceConfig {
  /** Resolve an opaque, source-issued token. Never trust the body's actor alone. */
  authenticate: (token: string) => Promise<SourcePrincipal | null> | SourcePrincipal | null;
  /** Must consult CURRENT owner permission on every call, including cached clients. */
  permission: (principal: SourcePrincipal, signal?: AbortSignal) => Promise<SourceOwnerPermission | null>;
  /** Execute question-specific retrieval against the source's own content/index. */
  context: (principal: SourcePrincipal, question: string, signal?: AbortSignal) => Promise<SourceQuestionContext>;
  /** External writes must honor this stable key across uncertain retries/restarts. */
  requestDeletion: (principal: SourcePrincipal, signal: AbortSignal | undefined, idempotencyKey: string) => Promise<SourceDeletionReceipt>;
  deletionStatus: (principal: SourcePrincipal, requestId: string, signal?: AbortSignal) => Promise<SourceDeletionReceipt>;
  providerName: string;
  now?: () => number;
}
export class CourseSourceServiceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
function fail(message: string, status = 400): never { throw new CourseSourceServiceError(message, status); }
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown, bytes: number): v is string => typeof v === 'string' && !!v.trim() && Buffer.byteLength(v) <= bytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const sameVersion = (a: unknown, b: unknown) => typeof a === typeof b && a === b;
function date(value: string): number { const n = Date.parse(value); return Number.isFinite(n) ? n : 0; }
function exact(row: Row, keys: string[]): void { if (Object.keys(row).some(k => !keys.includes(k))) fail('Unsupported source input.'); }
function receipt(value: SourceDeletionReceipt, principal: SourcePrincipal): SourceDeletionReceipt {
  if (!nonempty(value.request_id, 200) || value.course_id !== principal.course.id || !sameVersion(value.version, principal.course.version) ||
      value.scope !== 'derived-content' || !['pending', 'completed'].includes(value.status) || !date(value.requested_at) ||
      value.status === 'completed' && (!value.completed_at || !date(value.completed_at))) fail('The source did not confirm deletion status.', 502);
  return { request_id: value.request_id, course_id: value.course_id, version: value.version, status: value.status,
    scope: value.scope, requested_at: value.requested_at, ...(value.completed_at ? { completed_at: value.completed_at } : {}) };
}

export class CourseSourceService {
  private readonly clock: () => number;
  private readonly deletions = new Map<string, { promise: Promise<SourceDeletionReceipt>; expires: number }>();
  constructor(private readonly config: CourseSourceServiceConfig) { this.clock = config.now ?? Date.now; }
  async request(raw: unknown, token: unknown, signal?: AbortSignal): Promise<Row> {
    const result = await this.execute(raw, token, signal);
    if (Buffer.byteLength(JSON.stringify(result)) > 192_000) fail('Source response exceeds passage capacity.', 413);
    return result;
  }
  private async execute(raw: unknown, token: unknown, signal?: AbortSignal): Promise<Row> {
    if (!object(raw) || Buffer.byteLength(JSON.stringify(raw)) > 16_384 || raw.protocol !== PROTOCOL || !nonempty(raw.actor, 500)) fail('A bounded source request is required.');
    if (typeof token !== 'string' || !token || token.length > 4096) fail('A source-issued credential is required.', 401);
    const principal = await this.config.authenticate(token);
    if (!principal || principal.actor !== raw.actor || date(principal.expires_at) <= this.clock()) fail('Source access ended or belongs to another user.', 403);
    const operation = raw.operation;
    exact(raw, ['protocol', 'operation', 'actor', ...(operation === 'courses' ? ['page'] : operation === 'capabilities' ? [] :
      ['course_id', 'version', ...(operation === 'context' ? ['question', 'grant_id'] : operation === 'request-deletion' ? ['grant_id', 'idempotency_key'] : operation === 'deletion-status' ? ['request_id'] : [])])]);
    if (operation !== 'capabilities' && operation !== 'courses' && (raw.course_id !== principal.course.id || !sameVersion(raw.version, principal.course.version))) fail('This source credential does not cover that course version.', 403);
    const current = await this.config.permission(principal, signal);
    const deletionOperation = operation === 'request-deletion' || operation === 'deletion-status';
    if (!current || !nonempty(current.id, 200) || !nonempty(current.owner, 500) || date(current.expires_at) <= this.clock() ||
      (deletionOperation ? !current.permissions.includes('request-deletion') :
        !current.permissions.includes('read-passages') || !current.permissions.includes('share-with-paired-agent'))) fail('The course owner has not permitted this use.', 403);
    if (signal?.aborted) fail('Source request cancelled.', 409);
    const grant = { id: current.id, owner: current.owner, actor: principal.actor, course_id: principal.course.id, version: principal.course.version,
      expires_at: new Date(Math.min(date(current.expires_at), date(principal.expires_at))).toISOString(), access_modes: ['virtual'],
      permissions: [...current.permissions], ...(principal.lti ? { lti: principal.lti } : {}) };
    if (operation === 'capabilities') return { protocol: PROTOCOL, provider_name: this.config.providerName, access_modes: ['virtual'],
      operations: ['courses', 'permission', 'context', 'request-deletion', 'deletion-status'] };
    if (operation === 'courses') {
      if (raw.page !== undefined) fail('This course-bound source credential has no additional catalog pages.');
      return { protocol: PROTOCOL, courses: [{ ...principal.course, access_modes: ['virtual'] }] };
    }
    if (operation === 'permission') return { protocol: PROTOCOL, grant };
    if (operation === 'context' || operation === 'request-deletion') {
      if (raw.grant_id !== current.id) fail('Owner permission changed. Obtain current permission again.', 409);
    }
    if (operation === 'context') {
      if (!nonempty(raw.question, 4000)) fail('A bounded question is required.');
      const result = await this.config.context(principal, raw.question, signal);
      const afterPrincipal = await this.config.authenticate(token);
      const after = await this.config.permission(principal, signal);
      if (signal?.aborted || !afterPrincipal || afterPrincipal.actor !== principal.actor || afterPrincipal.course.id !== principal.course.id ||
          !sameVersion(afterPrincipal.course.version, principal.course.version) || date(afterPrincipal.expires_at) <= this.clock() ||
          !after || after.id !== current.id || after.owner !== current.owner || date(after.expires_at) <= this.clock() ||
          date(principal.expires_at) <= this.clock() || !after.permissions.includes('read-passages') || !after.permissions.includes('share-with-paired-agent')) fail('Owner permission ended during retrieval.', 403);
      if (result.source.course_id !== principal.course.id || !sameVersion(result.source.version, principal.course.version) ||
          !/^[a-f0-9]{64}$/.test(result.source.content_sha256) || !nonempty(result.source.title, 400) ||
          !nonempty(result.source.kind, 160) || !nonempty(result.source.source_uri, 2048) || !Array.isArray(result.sections) || !result.sections.length || result.sections.length > 24) fail('Invalid source context.', 502);
      let total = 0; const ids = new Set<string>();
      const sections = result.sections.map(s => {
        if (s.assessment !== false || !nonempty(s.id, 200) || !nonempty(s.title, 400) || !nonempty(s.body, 6000) ||
            !nonempty(s.source_uri, 2048) || !nonempty(s.locator, 400) || ids.has(s.id)) fail('Only bounded instructional passages may leave this source.', 502);
        ids.add(s.id); total += Buffer.byteLength(s.body);
        return { id: s.id, title: s.title, body: s.body, source_uri: s.source_uri, locator: s.locator, assessment: false };
      });
      if (total > 72_000) fail('Source passages exceed the retrieval budget.', 502);
      let graph: SourceQuestionContext['graph'];
      if (result.graph) {
        if (result.graph.nodes.length > 80 || result.graph.edges.length > 160 || Buffer.byteLength(JSON.stringify(result.graph)) > 32_000) fail('Source graph evidence exceeds the retrieval budget.', 502);
        const nodeIds = new Set<string>();
        const nodes = result.graph.nodes.map(n => {
          if (!nonempty(n.id, 200) || !nonempty(n.label, 400) || nodeIds.has(n.id) || n.section_id !== undefined && !ids.has(n.section_id)) fail('Invalid source graph evidence.', 502);
          nodeIds.add(n.id);
          return { id: n.id, label: n.label, ...(n.section_id ? { section_id: n.section_id } : {}) };
        });
        const edges = result.graph.edges.map(e => {
          if (!nodeIds.has(e.from) || !nodeIds.has(e.to) || !nonempty(e.relation, 100)) fail('Invalid source graph evidence.', 502);
          return { from: e.from, to: e.to, relation: e.relation };
        });
        graph = { nodes, edges };
      }
      const missing = result.missing_context ?? [];
      if (missing.length > 20 || missing.some(s => !nonempty(s, 1000))) fail('Invalid source context notes.', 502);
      return { protocol: PROTOCOL, grant: { ...grant, expires_at: new Date(Math.min(date(after.expires_at), date(principal.expires_at), date(afterPrincipal.expires_at))).toISOString() },
        source: { course_id: result.source.course_id, title: result.source.title, version: result.source.version,
          source_uri: result.source.source_uri, content_sha256: result.source.content_sha256, kind: result.source.kind },
        sections, retrieval: { scope: 'question-passages' }, missing_context: missing, ...(graph ? { graph } : {}) };
    }
    if (operation === 'request-deletion' || operation === 'deletion-status') {
      if (!current.permissions.includes('request-deletion')) fail('This owner grant does not permit deletion requests.', 403);
      if (operation === 'deletion-status' && !nonempty(raw.request_id, 200)) fail('A deletion receipt is required.');
      let value: SourceDeletionReceipt;
      if (operation === 'request-deletion') {
        if (!nonempty(raw.idempotency_key, 128)) fail('A stable deletion retry identifier is required.');
        for (const [key, entry] of this.deletions) if (entry.expires <= this.clock()) this.deletions.delete(key);
        const key = JSON.stringify([principal.actor, principal.course.id, principal.course.version, current.owner, current.id, raw.idempotency_key]);
        let pending = this.deletions.get(key);
        if (!pending) {
          if (this.deletions.size >= 1000) fail('Source deletion request capacity reached.', 429);
          const promise = this.config.requestDeletion(principal, signal, raw.idempotency_key).then(v => receipt(v, principal));
          pending = { promise, expires: date(principal.expires_at) };
          this.deletions.set(key, pending);
          // A provider's durable key, not this process cache, is responsible for
          // idempotency when an external action succeeds but its response is lost.
          void promise.catch(() => { if (this.deletions.get(key) === pending) this.deletions.delete(key); });
        }
        value = await pending.promise;
      } else value = await this.config.deletionStatus(principal, raw.request_id as string, signal);
      if (operation === 'deletion-status' && value.request_id !== raw.request_id) fail('Deletion receipt does not match this request.', 502);
      return { protocol: PROTOCOL, receipt: receipt(value, principal) };
    }
    return fail('Unknown source operation.');
  }
}

/** Attach only at a fixed operator-chosen endpoint. No caller-supplied fetch URL exists. */
export function attachCourseSourceService(app: Express, path: string, config: CourseSourceServiceConfig): CourseSourceService {
  const service = new CourseSourceService(config);
  app.post(path, routeJson({ limit: '16kb' }), async (req, res) => {
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', closed);
    res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff');
    try {
      if (Object.keys(req.query).length) fail('Source credentials and arguments must not appear in URLs.');
      const auth = req.get('Authorization');
      const result = await service.request(req.body, auth?.startsWith('Bearer ') ? auth.slice(7) : null, controller.signal);
      res.json(result);
    } catch (error) {
      res.status(error instanceof CourseSourceServiceError ? error.status : 502).json({ error: error instanceof CourseSourceServiceError ? error.message : 'The source operation could not be completed.' });
    } finally { res.removeListener('close', closed); }
  });
  return service;
}

/** Optional LTI handoff helper. Call ONLY from the verified onResourceLaunch callback.
 * LTI roles/custom claims do not grant content rights: the owner's policy is separate.
 * The host delivers the returned credential through its authenticated UI, never a URL.
 */
export class LtiCourseSourceTokens {
  private readonly tokens = new Map<string, SourcePrincipal>();
  constructor(private readonly config: {
    actorForLaunch: (launch: VerifiedResourceLaunch) => Promise<string | null>;
    courseForLaunch: (launch: VerifiedResourceLaunch) => Promise<SourceCourseReference | null>;
    ownerPermitsLaunch: (launch: VerifiedResourceLaunch, principal: SourcePrincipal) => Promise<boolean>;
    now?: () => number;
  }) {}
  private now(): number { return (this.config.now ?? Date.now)(); }
  async issueForVerifiedLaunch(launch: VerifiedResourceLaunch): Promise<{ token: string; principal: SourcePrincipal } | null> {
    const now = this.now();
    for (const [token, p] of this.tokens) if (date(p.expires_at) <= now) this.tokens.delete(token);
    if (this.tokens.size >= 1000) return null;
    const [actor, course] = await Promise.all([this.config.actorForLaunch(launch), this.config.courseForLaunch(launch)]);
    if (!actor || !course || !launch.sub || !launch.issuer || !launch.clientId || !launch.deploymentId || !nonempty(launch.resourceLink?.id, 255)) return null;
    const principal: SourcePrincipal = { actor, course: structuredClone(course), expires_at: new Date(now + 30 * 60_000).toISOString(), lti: {
      issuer: launch.issuer, client_id: launch.clientId, deployment_id: launch.deploymentId,
      ...(typeof launch.context?.id === 'string' && launch.context.id ? { context_id: launch.context.id } : {}), resource_link_id: launch.resourceLink.id,
      verified_at: new Date(now).toISOString(),
    } };
    if (!await this.config.ownerPermitsLaunch(launch, principal)) return null;
    const token = randomBytes(32).toString('base64url'); this.tokens.set(token, principal);
    return { token, principal: structuredClone(principal) };
  }
  authenticate(token: string): SourcePrincipal | null {
    const p = this.tokens.get(token);
    if (!p || date(p.expires_at) <= this.now()) { this.tokens.delete(token); return null; }
    return structuredClone(p);
  }
  revoke(token: string): void { this.tokens.delete(token); }
  dispose(): void { this.tokens.clear(); }
}
