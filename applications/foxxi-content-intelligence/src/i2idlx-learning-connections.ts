/** Private connector authority and explicit administrator/student account links.
 * Credentials and canonical provider learner IDs never enter standard DTOs.
 * A verified LTI launch may discover a link; it never asserts a Cloud learner ID. */
import { createHash, randomBytes } from 'node:crypto';
import type { LearningPrincipal } from './i2idlx-learning-auth.js';
import { ScormCloudLearningProvider, type LearningRegistration } from './i2idlx-learning-provider.js';

type Row = Record<string, unknown>;
export interface LearningPolicy {
  allowAiContent: boolean; allowAiProgress: boolean;
  /** Absent on existing connectors means false; startSco can override sequencing. */
  allowTargetedLaunch?: boolean;
}
export interface LearningConnector {
  id: string; owner: string; label: string; provider: 'scorm-cloud';
  authorization: string | null; joinCode: string | null; policy: LearningPolicy;
  revision: string; status: 'active' | 'revoked'; createdAt: string;
  /** Trusted program-only private configuration, including LTI key material. */
  lti?: Row;
}
export interface LearningLink {
  id: string; connectorId: string; subject: string; webId: string;
  status: 'pending-admin' | 'approved' | 'active' | 'revoked'; revision: string; createdAt: string;
  learnerId?: string; registrationId?: string; approvedAt?: string; confirmedAt?: string;
  /** Evidence is already verified by the caller's LTI receiver, never client JSON. */
  lti?: Row;
}
export interface LearningCreateRequest { owner: string; requestId: string; connectorId: string; digest: string; }
export interface LearningState { version: 1; connectors: LearningConnector[]; links: LearningLink[]; requests: LearningCreateRequest[]; }
export interface LearningSnapshot { revision: string | null; state: LearningState; }
export interface LearningRepository {
  read(): Promise<LearningSnapshot>;
  /** Must compare and swap atomically; a failed/uncertain write must throw. */
  write(expectedRevision: string | null, state: LearningState): Promise<void>;
}
export interface LearningConnectionsConfig { repository: LearningRepository; fetch?: typeof fetch; now?: () => number; }
export interface LearningAccess {
  authorization: string; learnerId: string; registrations: LearningRegistration[];
  connectorId: string; linkId: string; revision: string; policy: LearningPolicy;
  /** Private administrator-confirmed association; never a public learner DTO. */
  associatedRegistrationId: string;
}
export class LearningConnectionsError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const LEARNING_STATE_LIMITS = Object.freeze({ connectors: 128, ownerConnectors: 16, links: 2048,
  connectorLinks: 256, subjectLinks: 256, requests: 1024, bytes: 1024 * 1024, ltiBytes: 64 * 1024 });
const HEX = /^[a-f0-9]{32}$/, JOIN = /^[a-f0-9]{48}$/, DIGEST = /^[a-f0-9]{64}$/;
const HUMAN = /^did:web:[^\s:]+:users:([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/;
const plain = (v: unknown): v is Row => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const opaque = () => randomBytes(16).toString('hex');
function fail(status: number, code: string): never { throw new LearningConnectionsError(status, code); }
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function finiteJson(v: unknown, depth = 0, seen = new Set<object>(), count = { n: 0 }): boolean {
  if (++count.n > 100_000 || depth > 20) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'string') return Buffer.from(v).toString('utf8') === v;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || seen.has(v) || !Array.isArray(v) && !plain(v) || Object.getOwnPropertySymbols(v).length) return false;
  seen.add(v);
  const keys = Object.keys(v), properties = Object.getOwnPropertyNames(v);
  const valid = properties.length === keys.length + (Array.isArray(v) ? 1 : 0) && (!Array.isArray(v) || keys.length === v.length) && keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(v, k);
    return !!d && 'value' in d && finiteJson(d.value, depth + 1, seen, count);
  });
  seen.delete(v); return valid;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (plain(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const exact = (row: Row, keys: readonly string[]) => Object.keys(row).every(key => keys.includes(key));
function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && !!v && v === v.trim() && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v;
}
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const policy = (v: unknown): v is LearningPolicy => plain(v) && exact(v, ['allowAiContent', 'allowAiProgress', 'allowTargetedLaunch']) && typeof v.allowAiContent === 'boolean' && typeof v.allowAiProgress === 'boolean' && (v.allowTargetedLaunch === undefined || typeof v.allowTargetedLaunch === 'boolean');
const jsonRecord = (v: unknown) => plain(v) && finiteJson(v) && Buffer.byteLength(JSON.stringify(v)) <= LEARNING_STATE_LIMITS.ltiBytes;
async function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) fail(504, 'learning_provider_timeout');
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new LearningConnectionsError(504, 'learning_provider_timeout')); });
  signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
function https(v: unknown): boolean {
  if (!text(v, 1500)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
export function emptyLearningState(): LearningState { return { version: 1, connectors: [], links: [], requests: [] }; }
/** Reject corrupt/unreadable persisted authority; never replace it with an empty store. */
export function validateLearningState(value: unknown): LearningState {
  const invalid = () => fail(503, 'learning_state_invalid');
  if (!finiteJson(value) || !plain(value) || !exact(value, ['version', 'connectors', 'links', 'requests']) || value.version !== 1 ||
    !Array.isArray(value.connectors) || !Array.isArray(value.links) || !Array.isArray(value.requests) ||
    value.connectors.length > LEARNING_STATE_LIMITS.connectors || value.links.length > LEARNING_STATE_LIMITS.links ||
    value.requests.length > LEARNING_STATE_LIMITS.requests || Buffer.byteLength(JSON.stringify(value)) > LEARNING_STATE_LIMITS.bytes) return invalid();
  const ids = new Set<string>(), joins = new Set<string>(), linkIds = new Set<string>(), requestIds = new Set<string>();
  const connectors = new Map<string, LearningConnector>();
  for (const raw of value.connectors) {
    if (!plain(raw) || !exact(raw, ['id', 'owner', 'label', 'provider', 'authorization', 'joinCode', 'policy', 'revision', 'status', 'createdAt', 'lti']) ||
      !text(raw.id, 32) || !HEX.test(raw.id) || ids.has(raw.id) || !text(raw.owner, 500) || !HUMAN.test(raw.owner) ||
      !text(raw.label, 200) || raw.provider !== 'scorm-cloud' || !policy(raw.policy) || !text(raw.revision, 32) || !HEX.test(raw.revision) ||
      !['active', 'revoked'].includes(raw.status as string) || !date(raw.createdAt) || raw.lti !== undefined && !jsonRecord(raw.lti)) return invalid();
    if (raw.status === 'active') {
      if (!text(raw.authorization, 8192) || !/^(?:Basic|Bearer) [\x21-\x7e]+$/.test(raw.authorization) || !text(raw.joinCode, 48) || !JOIN.test(raw.joinCode) || joins.has(raw.joinCode)) return invalid();
      joins.add(raw.joinCode);
    } else if (raw.authorization !== null || raw.joinCode !== null || raw.lti !== undefined) return invalid();
    ids.add(raw.id); connectors.set(raw.id, raw as unknown as LearningConnector);
  }
  const associations = new Set<string>();
  for (const raw of value.links) {
    if (!plain(raw) || !exact(raw, ['id', 'connectorId', 'subject', 'webId', 'status', 'revision', 'createdAt', 'learnerId', 'registrationId', 'approvedAt', 'confirmedAt', 'lti']) ||
      !text(raw.id, 32) || !HEX.test(raw.id) || linkIds.has(raw.id) || !text(raw.connectorId, 32) || !connectors.has(raw.connectorId) ||
      !text(raw.subject, 500) || !HUMAN.test(raw.subject) || !https(raw.webId) || !['pending-admin', 'approved', 'active', 'revoked'].includes(raw.status as string) ||
      !text(raw.revision, 32) || !HEX.test(raw.revision) || !date(raw.createdAt) || raw.lti !== undefined && !jsonRecord(raw.lti)) return invalid();
    const connector = connectors.get(raw.connectorId)!;
    if (connector.owner === raw.subject || connector.status === 'revoked' && raw.status !== 'revoked') return invalid();
    if (raw.status === 'approved' || raw.status === 'active') {
      if (!text(raw.learnerId, 256) || !text(raw.registrationId, 256) || !date(raw.approvedAt) || raw.status === 'active' && !date(raw.confirmedAt)) return invalid();
    } else if (raw.learnerId !== undefined || raw.registrationId !== undefined || raw.approvedAt !== undefined || raw.confirmedAt !== undefined || raw.status === 'revoked' && raw.lti !== undefined) return invalid();
    if (raw.status === 'approved' && raw.confirmedAt !== undefined) return invalid();
    const association = raw.connectorId + '\n' + raw.subject;
    if (raw.status !== 'revoked') { if (associations.has(association)) return invalid(); associations.add(association); }
    linkIds.add(raw.id);
  }
  for (const raw of value.requests) {
    if (!plain(raw) || !exact(raw, ['owner', 'requestId', 'connectorId', 'digest']) || !text(raw.owner, 500) || !HUMAN.test(raw.owner) ||
      !text(raw.requestId, 128) || !text(raw.connectorId, 32) || !connectors.has(raw.connectorId) || connectors.get(raw.connectorId)!.owner !== raw.owner ||
      !text(raw.digest, 64) || !DIGEST.test(raw.digest)) return invalid();
    const key = raw.owner + '\n' + raw.requestId; if (requestIds.has(key)) return invalid(); requestIds.add(key);
  }
  return copy(value as unknown as LearningState);
}

export class LearningConnectionsStore {
  private readonly repository: LearningRepository;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  constructor(config: LearningConnectionsConfig) { this.repository = config.repository; this.fetcher = config.fetch ?? globalThis.fetch; this.clock = config.now ?? Date.now; }
  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) fail(503, 'learning_clock_unavailable'); return value; }
  private active(principal: LearningPrincipal, signal?: AbortSignal): void {
    if (!principal || !text(principal.subject, 500) || HUMAN.exec(principal.subject)?.[1] !== principal.userId ||
      !https(principal.webId) || !https(principal.podUrl) || !text(principal.sessionId, 256) ||
      !Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= this.now() || !principal.signal || principal.signal.aborted) fail(401, 'learning_session_expired');
    if (signal?.aborted) fail(409, 'learning_request_cancelled');
  }
  private async snapshot(): Promise<LearningSnapshot> {
    let raw: LearningSnapshot;
    try { raw = await this.repository.read(); } catch { return fail(503, 'learning_storage_unavailable'); }
    if (!plain(raw) || !exact(raw, ['revision', 'state']) || raw.revision !== null && !text(raw.revision, 256)) fail(503, 'learning_state_invalid');
    return { revision: raw.revision, state: validateLearningState(raw.state) };
  }
  private async state(principal: LearningPrincipal, signal?: AbortSignal): Promise<LearningState> {
    this.active(principal, signal); const result = await this.snapshot(); this.active(principal, signal); return result.state;
  }
  private async mutate<T>(principal: LearningPrincipal, change: (state: LearningState) => T): Promise<T> {
    this.active(principal); const before = await this.snapshot(); this.active(principal);
    const state = before.state, result = change(state), checked = validateLearningState(state);
    this.active(principal);
    try { await this.repository.write(before.revision, checked); }
    catch (error) {
      if (error && typeof error === 'object' && ('status' in error && error.status === 409 || 'name' in error && error.name === 'NativeCommitConflictError')) fail(409, 'learning_update_conflict');
      return fail(503, 'learning_storage_unavailable');
    }
    this.active(principal); const after = await this.snapshot(); this.active(principal);
    if (after.revision === null || after.revision === before.revision || digest(after.state) !== digest(checked)) fail(503, 'learning_update_unconfirmed');
    return copy(result);
  }
  private connector(state: LearningState, id: unknown): LearningConnector {
    if (!text(id, 32) || !HEX.test(id)) fail(404, 'learning_connection_not_found');
    const connector = state.connectors.find(c => c.id === id); if (!connector) fail(404, 'learning_connection_not_found'); return connector;
  }
  private owner(state: LearningState, principal: LearningPrincipal, id: unknown): LearningConnector {
    const connector = this.connector(state, id); if (connector.owner !== principal.subject) fail(404, 'learning_connection_not_found'); return connector;
  }
  private link(state: LearningState, id: unknown): LearningLink {
    if (!text(id, 32) || !HEX.test(id)) fail(404, 'learning_link_not_found');
    const link = state.links.find(l => l.id === id); if (!link) fail(404, 'learning_link_not_found'); return link;
  }
  private joined(state: LearningState, joinCode: unknown): LearningConnector {
    if (!text(joinCode, 48) || !JOIN.test(joinCode)) fail(404, 'learning_connection_not_found');
    const connector = state.connectors.find(c => c.joinCode === joinCode && c.status === 'active'); if (!connector) fail(404, 'learning_connection_not_found'); return connector;
  }
  private provider(connector: LearningConnector): ScormCloudLearningProvider {
    if (connector.status !== 'active' || !connector.authorization) fail(403, 'learning_connection_revoked');
    return new ScormCloudLearningProvider({ authorization: connector.authorization, fetch: this.fetcher, now: this.clock });
  }
  private connectorDto(connector: LearningConnector, owned = false): Row {
    return { id: connector.id, label: connector.label, status: connector.status, created_at: connector.createdAt,
      ...(owned ? { join_code: connector.joinCode } : {}), policy: copy(connector.policy) };
  }
  private connectionDto(connector: LearningConnector): Row { return { id: connector.id, label: connector.label, policy: copy(connector.policy) }; }
  private linkDto(link: LearningLink, connector: LearningConnector): Row {
    return { id: link.id, connector_id: link.connectorId, provider_label: connector.label, status: link.status, ...(link.lti ? { lti_discovered: true } : {}) };
  }
  private usable(state: LearningState, principal: LearningPrincipal, linkId: unknown, requirements: { content: boolean; progress: boolean }) {
    const link = this.link(state, linkId);
    if (link.subject !== principal.subject) fail(404, 'learning_link_not_found');
    const connector = this.connector(state, link.connectorId);
    if (link.status !== 'active' || !link.learnerId || connector.status !== 'active' || !connector.authorization) fail(403, 'learning_link_inactive');
    if (requirements.content && !connector.policy.allowAiContent) fail(403, 'learning_content_not_allowed');
    if (requirements.progress && !connector.policy.allowAiProgress) fail(403, 'learning_progress_not_allowed');
    return { link, connector, revision: connector.revision + ':' + link.revision };
  }
  private async revalidate(principal: LearningPrincipal, prior: ReturnType<LearningConnectionsStore['usable']>, requirements: { content: boolean; progress: boolean }, signal?: AbortSignal) {
    const current = this.usable(await this.state(principal, signal), principal, prior.link.id, requirements);
    if (current.revision !== prior.revision) fail(409, 'learning_authority_changed'); return current;
  }
  async access(principal: LearningPrincipal, linkId: string, courseId: string, courseVersion: number,
    requirements: { content: boolean; progress: boolean }, signal?: AbortSignal): Promise<LearningAccess> {
    if (!plain(requirements) || !exact(requirements, ['content', 'progress']) || typeof requirements.content !== 'boolean' || typeof requirements.progress !== 'boolean') fail(400, 'learning_request_invalid');
    const initial = this.usable(await this.state(principal, signal), principal, linkId, requirements);
    const active = signal ? AbortSignal.any([principal.signal, signal]) : principal.signal;
    const registrations = await this.provider(initial.connector).authorizeCourse(initial.link.learnerId!, courseId, courseVersion, active);
    const current = await this.revalidate(principal, initial, requirements, signal);
    return { authorization: current.connector.authorization!, learnerId: current.link.learnerId!, registrations,
      connectorId: current.connector.id, linkId: current.link.id, revision: current.revision, policy: copy(current.connector.policy), associatedRegistrationId: current.link.registrationId! };
  }
  /** Trusted receiver use only. Standard request JSON cannot supply verified evidence. */
  async requestLink(principal: LearningPrincipal, joinCode: string, verifiedLti?: Row): Promise<Row> {
    if (verifiedLti !== undefined && !jsonRecord(verifiedLti)) fail(400, 'learning_request_invalid');
    return this.mutate(principal, state => {
      const connector = this.joined(state, joinCode);
      if (connector.owner === principal.subject) fail(403, 'learning_self_approval_forbidden');
      let link = state.links.find(l => l.connectorId === connector.id && l.subject === principal.subject && l.status !== 'revoked');
      if (!link) {
        if (state.links.length >= LEARNING_STATE_LIMITS.links || state.links.filter(l => l.connectorId === connector.id).length >= LEARNING_STATE_LIMITS.connectorLinks ||
          state.links.filter(l => l.subject === principal.subject).length >= LEARNING_STATE_LIMITS.subjectLinks) fail(413, 'learning_capacity_exceeded');
        link = { id: opaque(), connectorId: connector.id, subject: principal.subject, webId: principal.webId, status: 'pending-admin', revision: opaque(), createdAt: new Date(this.now()).toISOString(),
          ...(verifiedLti ? { lti: copy(verifiedLti) } : {}) };
        state.links.push(link);
      }
      return { connection: this.connectionDto(connector), link: this.linkDto(link, connector) };
    });
  }
  /** Private program adapter for LTI setup; not an HTTP operation. */
  async readConnector(id: string): Promise<LearningConnector | null> {
    const state = (await this.snapshot()).state; return copy(state.connectors.find(c => c.id === id) ?? null);
  }
  /** Only private LTI configuration may change through this narrow program hook. */
  async updateConnector(principal: LearningPrincipal, id: string, mutator: (connector: LearningConnector) => void): Promise<LearningConnector> {
    return this.mutate(principal, state => {
      const connector = this.owner(state, principal, id);
      if (connector.status !== 'active') fail(403, 'learning_connection_revoked');
      const before = copy(connector); delete before.lti;
      const result: unknown = mutator(connector);
      if (result !== undefined) fail(400, 'learning_connector_mutation_forbidden');
      const after = { ...connector }; delete after.lti;
      if (digest(before) !== digest(after)) fail(400, 'learning_connector_mutation_forbidden');
      connector.revision = opaque(); return connector;
    });
  }
  private async validateCredential(authorization: string, principal: LearningPrincipal): Promise<void> {
    const signal = AbortSignal.any([principal.signal, AbortSignal.timeout(15_000)]), target = 'https://cloud.scorm.com/api/v2/courses';
    try {
      const fetching = this.fetcher(target, { method: 'GET', redirect: 'error', signal, headers: { Authorization: authorization, Accept: 'application/json' } });
      void fetching.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
      const response = await interrupted(fetching, signal);
      this.active(principal);
      if (signal.aborted) fail(504, 'learning_provider_timeout');
      if (response.redirected || response.url && response.url !== target) { await response.body?.cancel(); fail(502, 'learning_provider_invalid'); }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) fail(response.status, 'learning_provider_authentication_failed');
        fail(502, 'learning_provider_unavailable');
      }
      const length = response.headers.get('content-length');
      if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > 512 * 1024)) { await response.body?.cancel(); fail(413, 'learning_provider_capacity_exceeded'); }
      const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const next = await interrupted(reader.read(), signal); this.active(principal); if (signal.aborted) fail(504, 'learning_provider_timeout');
          if (next.done) break; size += next.value.byteLength;
          if (size > 512 * 1024) fail(413, 'learning_provider_capacity_exceeded'); chunks.push(next.value);
        }
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
      if (!plain(body) || !Array.isArray(body.courses) || body.courses.length > 500) fail(502, 'learning_provider_invalid');
      this.active(principal);
    } catch (error) {
      this.active(principal); if (error instanceof LearningConnectionsError) throw error;
      fail(signal.aborted ? 504 : 502, signal.aborted ? 'learning_provider_timeout' : 'learning_provider_unavailable');
    }
  }
  private async create(principal: LearningPrincipal, args: Row): Promise<Row> {
    if (!text(args.label, 200) || !plain(args.credentials) || !exact(args.credentials, ['app_id', 'secret']) ||
      !text(args.credentials.app_id, 256) || !text(args.credentials.secret, 4096) || args.credentials.app_id.includes(':') ||
      !policy(args.policy) || args.intent !== 'authorize-enrolled-learners' || !text(args.request_id, 128)) fail(400, 'learning_request_invalid');
    const requestDigest = digest({ label: args.label, credentials: args.credentials, policy: args.policy, intent: args.intent });
    const before = await this.state(principal);
    const prior = before.requests.find(r => r.owner === principal.subject && r.requestId === args.request_id);
    if (prior) {
      if (prior.digest !== requestDigest) fail(409, 'learning_idempotency_conflict');
      return { connector: this.connectorDto(this.owner(before, principal, prior.connectorId), true) };
    }
    const authorization = 'Basic ' + Buffer.from(args.credentials.app_id + ':' + args.credentials.secret).toString('base64');
    await this.validateCredential(authorization, principal);
    return this.mutate(principal, state => {
      const existing = state.requests.find(r => r.owner === principal.subject && r.requestId === args.request_id);
      if (existing) {
        if (existing.digest !== requestDigest) fail(409, 'learning_idempotency_conflict');
        return { connector: this.connectorDto(this.owner(state, principal, existing.connectorId), true) };
      }
      if (state.connectors.length >= LEARNING_STATE_LIMITS.connectors || state.connectors.filter(c => c.owner === principal.subject).length >= LEARNING_STATE_LIMITS.ownerConnectors || state.requests.length >= LEARNING_STATE_LIMITS.requests) fail(413, 'learning_capacity_exceeded');
      const connector: LearningConnector = { id: opaque(), owner: principal.subject, label: args.label as string, provider: 'scorm-cloud', authorization,
        joinCode: randomBytes(24).toString('hex'), policy: copy(args.policy as unknown as LearningPolicy), revision: opaque(), status: 'active', createdAt: new Date(this.now()).toISOString() };
      state.connectors.push(connector); state.requests.push({ owner: principal.subject, requestId: args.request_id as string, connectorId: connector.id, digest: requestDigest });
      return { connector: this.connectorDto(connector, true) };
    });
  }
  private revoked(link: LearningLink): void {
    link.status = 'revoked'; link.revision = opaque(); delete link.learnerId; delete link.registrationId;
    delete link.approvedAt; delete link.confirmedAt; delete link.lti;
  }
  async request(principal: LearningPrincipal, raw: unknown): Promise<Row> {
    this.active(principal);
    if (!finiteJson(raw) || !plain(raw) || Buffer.byteLength(JSON.stringify(raw)) > 16_384 || typeof raw.operation !== 'string') fail(400, 'learning_request_invalid');
    const args = copy(raw), operation = args.operation;
    const fields: Record<string, string[]> = {
      'create-connector': ['label', 'credentials', 'policy', 'intent', 'request_id'], 'owned-connectors': [], 'my-links': [],
      discover: ['join_code'], 'request-link': ['join_code'], 'pending-links': ['connector_id'],
      'approve-link': ['link_id', 'registration_id', 'confirmed'], 'confirm-link': ['link_id'], 'revoke-link': ['link_id'],
      'revoke-connector': ['connector_id'], courses: ['link_id'], progress: ['link_id', 'course_id', 'version'],
      'set-targeted-launch-policy': ['connector_id', 'allowTargetedLaunch', 'confirmed'],
    };
    if (!Object.hasOwn(fields, operation as string) || !exact(args, ['operation', ...fields[operation as string]!])) fail(400, 'learning_request_invalid');
    if (operation === 'create-connector') return this.create(principal, args);
    if (operation === 'request-link') return this.requestLink(principal, args.join_code as string);
    const state = await this.state(principal);
    if (operation === 'owned-connectors') return { connectors: state.connectors.filter(c => c.owner === principal.subject).map(c => this.connectorDto(c, true)) };
    if (operation === 'my-links') return { links: state.links.filter(l => l.subject === principal.subject).map(l => this.linkDto(l, this.connector(state, l.connectorId))) };
    if (operation === 'discover') return { connection: this.connectionDto(this.joined(state, args.join_code)) };
    if (operation === 'set-targeted-launch-policy') {
      if (typeof args.allowTargetedLaunch !== 'boolean' || args.confirmed !== true) fail(400, 'learning_request_invalid');
      return this.mutate(principal, current => {
        const connector = this.owner(current, principal, args.connector_id);
        if (connector.status !== 'active') fail(403, 'learning_link_inactive');
        connector.policy.allowTargetedLaunch = args.allowTargetedLaunch as boolean; connector.revision = opaque();
        return { connector: this.connectorDto(connector, true) };
      });
    }
    if (operation === 'pending-links') {
      const connector = this.owner(state, principal, args.connector_id);
      return { links: state.links.filter(l => l.connectorId === connector.id && ['pending-admin', 'approved'].includes(l.status)).map(l => ({ id: l.id,
        account: { id: l.subject, webId: l.webId }, status: l.status, requested_at: l.createdAt })) };
    }
    if (operation === 'approve-link') {
      if (args.confirmed !== true || !text(args.registration_id, 256)) fail(400, 'learning_request_invalid');
      const link = this.link(state, args.link_id), connector = this.owner(state, principal, link.connectorId);
      if (link.subject === principal.subject) fail(403, 'learning_self_approval_forbidden');
      if (link.status !== 'pending-admin') fail(409, 'learning_link_not_pending');
      const registration = await this.provider(connector).getRegistration(args.registration_id, principal.signal);
      return this.mutate(principal, current => {
        const freshLink = this.link(current, link.id), freshConnector = this.owner(current, principal, connector.id);
        if (freshLink.revision !== link.revision || freshLink.status !== 'pending-admin' || freshConnector.revision !== connector.revision || freshConnector.status !== 'active') fail(409, 'learning_authority_changed');
        freshLink.learnerId = registration.learnerId; freshLink.registrationId = registration.id; freshLink.approvedAt = new Date(this.now()).toISOString();
        freshLink.status = 'approved'; freshLink.revision = opaque(); return { link: this.linkDto(freshLink, freshConnector) };
      });
    }
    if (operation === 'confirm-link' || operation === 'revoke-link') return this.mutate(principal, current => {
      const link = this.link(current, args.link_id), connector = this.connector(current, link.connectorId);
      if (operation === 'confirm-link') {
        if (link.subject !== principal.subject) fail(404, 'learning_link_not_found');
        if (link.status !== 'approved' || connector.status !== 'active') fail(409, 'learning_link_not_approved');
        link.status = 'active'; link.confirmedAt = new Date(this.now()).toISOString(); link.revision = opaque();
      } else {
        if (link.subject !== principal.subject && connector.owner !== principal.subject) fail(404, 'learning_link_not_found');
        this.revoked(link);
      }
      return { link: this.linkDto(link, connector) };
    });
    if (operation === 'revoke-connector') return this.mutate(principal, current => {
      const connector = this.owner(current, principal, args.connector_id);
      // The HTTP adapter completes/reports remote LTI cleanup BEFORE invoking this.
      connector.status = 'revoked'; connector.authorization = null; connector.joinCode = null; delete connector.lti; connector.revision = opaque();
      for (const link of current.links) if (link.connectorId === connector.id) this.revoked(link);
      return { connector: this.connectorDto(connector, true) };
    });
    const initial = this.usable(state, principal, args.link_id, { content: false, progress: operation === 'progress' });
    if (operation === 'progress' && (args.course_id !== undefined && !text(args.course_id, 256) || args.version !== undefined && (args.course_id === undefined || !Number.isSafeInteger(args.version) || Number(args.version) < 0))) fail(400, 'learning_request_invalid');
    const provider = this.provider(initial.connector);
    const registrations = operation === 'progress' && args.course_id !== undefined && args.version !== undefined
      ? await provider.authorizeCourse(initial.link.learnerId!, args.course_id as string, args.version as number, principal.signal)
      : await provider.listOwnRegistrations(initial.link.learnerId!, principal.signal);
    await this.revalidate(principal, initial, { content: false, progress: operation === 'progress' });
    if (operation === 'courses') {
      const courses = new Map<string, Row>(); for (const registration of registrations) courses.set(JSON.stringify([registration.course.id, registration.course.version]), { ...registration.course });
      const unsupported = { status: 'unavailable', reason: 'SCORM Cloud does not supply cross-course prerequisites or curriculum through this connector.' };
      return { link_id: initial.link.id, courses: [...courses.values()], prerequisites: { ...unsupported }, curriculum: { ...unsupported } };
    }
    return { link_id: initial.link.id, records: registrations.filter(r => args.course_id === undefined || r.course.id === args.course_id).map(r => ({
      course_id: r.course.id, title: r.course.title, version: r.course.version, completion: r.progress.completion, success: r.progress.success,
      ...(r.progress.score ? { score: r.progress.score.scaled } : {}), ...(r.progress.totalSeconds !== undefined ? { total_seconds: r.progress.totalSeconds } : {}),
      // This is observation time, not a provider modification timestamp.
      observed_at: r.observedAt, source: 'SCORM Cloud',
    })), as_of: new Date(this.now()).toISOString() };
  }
}
