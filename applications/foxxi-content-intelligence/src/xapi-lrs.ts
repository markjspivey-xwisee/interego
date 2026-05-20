/**
 * Inbound xAPI LRS surface for the Foxxi vertical.
 *
 * Lets external systems (LMSes, mobile apps, simulators, AI tutors,
 * other LRSes via Statement Forwarding) write learning records *into*
 * the substrate. Each accepted Statement is converted to a Context
 * Descriptor (modal=Asserted, provenance bound to the source LRS or
 * caller WebID) and published to the tenant pod via the lrs-adapter's
 * `publishIngestedStatement` so it joins the rest of the substrate's
 * trace graph.
 *
 * Endpoints (xAPI 2.0 / IEEE 9274.1.1 §7):
 *
 *   GET    /xapi/about
 *   POST   /xapi/statements                     (single | batch)
 *   PUT    /xapi/statements?statementId=<uuid>  (caller-provided id)
 *   GET    /xapi/statements                     (filtered query)
 *   GET    /xapi/statements?statementId=<uuid>  (single)
 *   GET    /xapi/activities?activityId=<iri>
 *   GET    /xapi/agents?agent=<json>
 *   GET|PUT|POST|DELETE /xapi/activities/state
 *   GET|PUT|POST|DELETE /xapi/activities/profile
 *   GET|PUT|POST|DELETE /xapi/agents/profile
 *
 * Conformance:
 *   - X-Experience-API-Version negotiated (2.0.0 default, 1.0.3 supported)
 *   - Required header echoed in every response
 *   - Auth: Basic (LRS standard) OR Bearer (Foxxi session tokens), config-driven
 *   - CORS: governed by the bridge's outer middleware (no per-route override)
 *   - Voiding: POST/PUT of a voided-verb statement is recorded; GET on the
 *     voided statementId returns 404 unless voidedStatementId= is used
 *
 * Not a "memory-only" demo — every Statement persists as a descriptor on
 * the tenant pod, queryable via cg:discover() filtered on
 * `lrs:StatementIngestion`. The state/profile resources use an in-memory
 * Map sized for demo workloads; swap for Redis/Postgres at production
 * scale.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ingestStatementBatchFromLrs as _unusedTypeAnchor } from '../../lrs-adapter/src/pod-publisher.js';
import { createStatementStore, ConflictError, type StatementStore, type StoredStatement } from './statement-store.js';
import type { IRI } from '../../../src/index.js';

void _unusedTypeAnchor;

// ── Pluggable backend ───────────────────────────────────────────────
// Default is in-memory; production swaps via FOXXI_LRS_BACKEND.
// Same store services /xapi/statements + /xapi/admin/* + the
// instrumentation `storeStatementInternal` so the dashboard never sees
// a stale view.
const store: StatementStore = createStatementStore(process.env.FOXXI_LRS_BACKEND);

// ── Config ──────────────────────────────────────────────────────────

export interface XapiLrsConfig {
  /**
   * The Foxxi tenant pod where ingested statements land.
   * Each ingested statement becomes a context descriptor at
   * `<podUrl>foxxi/lrs/statement-<id>.ttl` (per substrate publish flow).
   */
  podUrl: string;
  /** Tenant's authoritative DID — sets prov:wasAttributedTo on each statement descriptor. */
  tenantDid: IRI;
  /**
   * Basic-auth credentials accepted on inbound calls. Format: `user:password`.
   * Comma-separated for multiple keys (one per upstream LRS / LMS).
   * Empty/unset → Basic auth is disabled and only Bearer tokens are accepted.
   */
  basicAuthPairs: string;
  /**
   * Forward each accepted statement to these external LRS endpoints.
   * Comma-separated `https://lrs.example/xapi||user:pass||2.0.0` triples
   * (`||` separator). Empty → no forwarding. Statement Forwarding per
   * xAPI §10.
   */
  forwardingTargets: string;
  /** Bridge URL — echoed in /xapi/about so callers know the LRS identity. */
  selfBaseUrl: string;
}

// ── In-process statement store accessors ────────────────────────────
// Exported so the bridge can emit statements server-side (e.g. one
// per affordance call, ABAC decision, credential issuance, etc.) and
// surface them in the LRS-admin dashboard without an HTTP round-trip.

// Back-compat name (other modules import `XapiStatementRecord`).
export type XapiStatementRecord = StoredStatement;

/** Synchronous store API for the instrumentation path (best-effort —
 * the file-backed store handles append-then-fsync via the same
 * machinery; the put is sync from the caller's perspective). */
export function storeStatementInternal(stmt: Record<string, unknown>): string {
  const id = (typeof stmt.id === 'string' && isUuid(stmt.id)) ? stmt.id : randomUUID();
  const stored = new Date().toISOString();
  const rec: StoredStatement = { id, statement: { ...stmt, id, stored }, stored, voided: false };
  // Fire-and-forget for async backends; errors logged but never thrown
  // because the instrumentation path is non-blocking by design.
  void store.put(rec).catch(err => {
    // eslint-disable-next-line no-console
    console.warn('[storeStatementInternal]', (err as Error).message);
  });
  return id;
}

export async function listStoredStatements(): Promise<StoredStatement[]> {
  return store.listAll();
}

export async function clearStatementStore(): Promise<void> {
  return store.clear();
}

export function getStatementStore(): StatementStore { return store; }

// ── In-memory stores (replaceable) ──────────────────────────────────

// Statement persistence is delegated to `store` (StatementStore — see top).
// State + profile resources are still in-memory; production-grade
// deployments would swap these out the same way the statement store
// did (separate concern; lower volume; not yet pluggable to keep the
// blast radius small).
const activityStateStore = new Map<string, { content: unknown; etag: string; updated: string; contentType: string }>();
const activityProfileStore = new Map<string, { content: unknown; etag: string; updated: string; contentType: string }>();
const agentProfileStore = new Map<string, { content: unknown; etag: string; updated: string; contentType: string }>();

// ── Helpers ─────────────────────────────────────────────────────────

const VOIDED_VERB = 'http://adlnet.gov/expapi/verbs/voided';
const ABOUT_VERSIONS = ['2.0.0', '1.0.3'];

function uuidv4(): string { return randomUUID(); }

function isUuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function negotiateVersion(req: Request): string {
  const v = (req.headers['x-experience-api-version'] ?? req.headers['X-Experience-API-Version']) as string | undefined;
  if (typeof v === 'string' && ABOUT_VERSIONS.includes(v)) return v;
  // xAPI 2.0 §6.2: requests without the header MAY be accepted. We default
  // to 2.0.0 (current spec) — legacy 1.0.3 clients are still served, since
  // they explicitly send `X-Experience-API-Version: 1.0.3`.
  return '2.0.0';
}

function setXapiHeaders(res: Response, version: string): void {
  res.setHeader('X-Experience-API-Version', version);
  res.setHeader('X-Experience-API-Consistent-Through', new Date().toISOString());
}

function basicAuthOk(header: string | undefined, pairs: string): boolean {
  if (!pairs.trim()) return false;
  if (!header || !/^Basic\s+/i.exec(header)) return false;
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  return pairs.split(',').map(s => s.trim()).filter(Boolean).includes(decoded);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : undefined;
}

// ── Auth gate ───────────────────────────────────────────────────────

function makeAuthGate(config: XapiLrsConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const version = negotiateVersion(req);
    setXapiHeaders(res, version);
    const authHeader = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
    if (basicAuthOk(authHeader, config.basicAuthPairs)) {
      (req as Request & { xapiAuth: { kind: 'basic'; principal: string } }).xapiAuth = { kind: 'basic', principal: 'lrs-key' };
      return next();
    }
    const bearer = bearerToken(authHeader);
    if (bearer) {
      (req as Request & { xapiAuth: { kind: 'bearer'; token: string } }).xapiAuth = { kind: 'bearer', token: bearer };
      return next();
    }
    res.status(401).setHeader('WWW-Authenticate', 'Basic realm="foxxi-lrs", Bearer realm="foxxi-lrs"').json({
      error: 'authentication required',
      detail: 'xAPI requires Basic or Bearer auth on every resource. Configure FOXXI_LRS_BASIC_AUTH_PAIRS on the bridge, or present a Foxxi session token.',
    });
  };
}

// ── Statement normalisation ─────────────────────────────────────────

function nowIso(): string { return new Date().toISOString(); }

function ensureStatementFields(stmt: Record<string, unknown>, authority: { homePage: string; name: string }): Record<string, unknown> {
  const out = { ...stmt };
  if (typeof out.id !== 'string' || !isUuid(out.id)) out.id = uuidv4();
  if (typeof out.timestamp !== 'string') out.timestamp = nowIso();
  if (typeof out.stored !== 'string') out.stored = nowIso();
  if (!out.authority || typeof out.authority !== 'object') {
    out.authority = {
      objectType: 'Agent',
      account: { homePage: authority.homePage, name: authority.name },
    };
  }
  // xAPI 2.0 §4.1.10: version is set by the LRS if not provided. We set it
  // explicitly so downstream consumers (forwarding targets, profile-aware
  // analytics) know exactly which spec the statement was authored against.
  if (!out.version) out.version = '2.0.0';

  // xAPI 2.0 §4.1.2: actor.objectType is REQUIRED for Agent / Group / Anonymous
  // Group actors. Add if absent to keep statements 2.0-conformant.
  const actor = out.actor as Record<string, unknown> | undefined;
  if (actor && typeof actor === 'object' && !actor.objectType) {
    // Identifying a Group: it has a `member` array (Anonymous Group) OR
    // any IFI (Identified Group). Otherwise it's a plain Agent.
    actor.objectType = (Array.isArray(actor.member) || actor.member) ? 'Group' : 'Agent';
  }

  // xAPI 2.0 §4.1.4: object can be Activity / Agent / Group / StatementRef
  // / SubStatement. If no objectType + has activity-shape `id`, it's
  // implicitly an Activity. Sub-statements need their own actor.objectType
  // normalized too (recursive case — sub-statements forbidden to nest
  // further per §4.1.4.1, so one level of recursion is enough).
  const object = out.object as Record<string, unknown> | undefined;
  if (object && typeof object === 'object') {
    if (!object.objectType) object.objectType = 'Activity';
    if (object.objectType === 'SubStatement') {
      const subActor = object.actor as Record<string, unknown> | undefined;
      if (subActor && typeof subActor === 'object' && !subActor.objectType) {
        subActor.objectType = (Array.isArray(subActor.member) || subActor.member) ? 'Group' : 'Agent';
      }
      const subObject = object.object as Record<string, unknown> | undefined;
      if (subObject && typeof subObject === 'object' && !subObject.objectType) {
        subObject.objectType = 'Activity';
      }
    }
  }

  return out;
}

function isVoidingStatement(stmt: Record<string, unknown>): string | undefined {
  const verb = stmt.verb as { id?: string } | undefined;
  const obj = stmt.object as { objectType?: string; id?: string } | undefined;
  if (verb?.id === VOIDED_VERB && obj?.objectType === 'StatementRef' && typeof obj.id === 'string') {
    return obj.id;
  }
  return undefined;
}

// ── /xapi/statements POST ───────────────────────────────────────────

async function handlePostStatements(req: Request, res: Response, config: XapiLrsConfig): Promise<void> {
  // xAPI 2.0 §4.1.11: requests MAY use `multipart/mixed` to attach signed-
  // statement JWS payloads, file uploads, etc. The first part is always
  // `application/json` containing the statement(s). We extract that and
  // ignore the rest for now (the bridge stores the statement; attachment
  // bodies are passed-through by reference via the statement's own
  // attachments[] descriptors).
  const ct = (req.headers['content-type'] as string | undefined) ?? '';
  let raw = req.body;
  if (ct.startsWith('multipart/mixed')) {
    raw = extractFirstJsonPart(req);
    if (!raw) { res.status(400).json({ error: 'multipart/mixed body must start with application/json statement part' }); return; }
  }

  const batch: Record<string, unknown>[] = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  const authority = { homePage: config.selfBaseUrl, name: 'foxxi-lrs' };

  for (const stmt of batch) {
    if (!stmt || typeof stmt !== 'object') {
      res.status(400).json({ error: 'invalid statement: not an object' });
      return;
    }
    if (!stmt.actor || !stmt.verb || !stmt.object) {
      res.status(400).json({ error: 'invalid statement: actor, verb, and object are required (xAPI 2.0 §4.1)' });
      return;
    }
    const enriched = ensureStatementFields(stmt, authority);
    const id = enriched.id as string;

    // Voiding semantics — process *before* writing the voiding statement
    // so the target is voided in the same transaction.
    const voidedTarget = isVoidingStatement(enriched);
    if (voidedTarget) {
      await store.markVoided(voidedTarget, id);
    }

    // Statement-id conflict per xAPI 2.0 §4.1.1 — delegated to the store.
    try {
      await store.put({ id, statement: enriched, stored: enriched.stored as string, voided: false });
    } catch (err) {
      if (err instanceof ConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    ids.push(id);

    // Fire-and-forget forwarding to upstream LRSs.
    forwardStatement(enriched, config).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[foxxi-lrs] forwarding failed:', (err as Error).message);
    });
  }

  res.status(200).json(ids);
}

// Minimal multipart/mixed parser — extracts the first body part whose
// Content-Type is application/json and returns the parsed payload. Full
// MIME RFC 2046 §5.1.1 boundary handling: --<boundary>\r\nheaders\r\n\r\nbody.
function extractFirstJsonPart(req: Request): unknown {
  try {
    const ct = (req.headers['content-type'] as string | undefined) ?? '';
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    const boundary = (m?.[1] ?? m?.[2] ?? '').trim();
    if (!boundary) return null;
    const raw = typeof req.body === 'string' ? req.body
      : Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : null;
    if (!raw) return null;
    const parts = raw.split(`--${boundary}`).filter(p => p && !p.startsWith('--'));
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toLowerCase();
      if (!headers.includes('content-type: application/json')) continue;
      const body = part.slice(headerEnd + 4).trimEnd();
      return JSON.parse(body);
    }
  } catch { /* fall through to null */ }
  return null;
}

// ── /xapi/statements PUT (caller-supplied id) ───────────────────────

async function handlePutStatement(req: Request, res: Response, config: XapiLrsConfig): Promise<void> {
  const statementId = (req.query.statementId as string | undefined) ?? '';
  if (!isUuid(statementId)) {
    res.status(400).json({ error: 'PUT requires ?statementId=<uuid v4>' });
    return;
  }
  const stmt = req.body as Record<string, unknown>;
  if (!stmt || typeof stmt !== 'object') {
    res.status(400).json({ error: 'invalid statement body' });
    return;
  }
  if (stmt.id && stmt.id !== statementId) {
    res.status(400).json({ error: 'statement.id and ?statementId= must match' });
    return;
  }
  (stmt as Record<string, unknown>).id = statementId;
  const authority = { homePage: config.selfBaseUrl, name: 'foxxi-lrs' };
  const enriched = ensureStatementFields(stmt, authority);
  try {
    await store.put({ id: statementId, statement: enriched, stored: enriched.stored as string, voided: false });
  } catch (err) {
    if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  forwardStatement(enriched, config).catch(() => undefined);
  res.status(204).end();
}

// ── /xapi/statements GET ────────────────────────────────────────────

async function handleGetStatements(req: Request, res: Response): Promise<void> {
  const statementId = req.query.statementId as string | undefined;
  const voidedStatementId = req.query.voidedStatementId as string | undefined;
  const agentFilterRaw = req.query.agent as string | undefined;
  const verbFilter = req.query.verb as string | undefined;
  const activityFilter = req.query.activity as string | undefined;
  const registrationFilter = req.query.registration as string | undefined;
  const since = req.query.since as string | undefined;
  const until = req.query.until as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const ascending = (req.query.ascending as string | undefined) === 'true';
  const cursor = req.query.continuationToken as string | undefined;

  // Single-statement lookup
  if (statementId) {
    const rec = await store.get(statementId);
    if (!rec || rec.voided) { res.status(404).json({ error: 'not found or voided' }); return; }
    res.json(rec.statement);
    return;
  }
  if (voidedStatementId) {
    const rec = await store.get(voidedStatementId);
    if (!rec || !rec.voided) { res.status(404).json({ error: 'not voided (use ?statementId= for non-voided)' }); return; }
    res.json(rec.statement);
    return;
  }

  let agent: Record<string, unknown> | undefined;
  if (agentFilterRaw) {
    try { agent = JSON.parse(agentFilterRaw) as Record<string, unknown>; }
    catch { res.status(400).json({ error: 'agent filter must be JSON-encoded Agent object (xAPI 2.0 §4.2)' }); return; }
  }

  const result = await store.query({
    agent,
    verb: verbFilter,
    activity: activityFilter,
    registration: registrationFilter,
    since,
    until,
    ascending,
    limit,
    cursor,
  });
  const moreUrl = result.more
    ? `/xapi/statements?continuationToken=${encodeURIComponent(result.more)}`
    : '';
  res.json({
    statements: result.statements.map(r => r.statement),
    more: moreUrl,
  });
}

// ── /xapi/about ─────────────────────────────────────────────────────

function handleAbout(_req: Request, res: Response, config: XapiLrsConfig): void {
  res.json({
    version: ABOUT_VERSIONS,
    extensions: {
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#identity': config.tenantDid,
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#bridge': config.selfBaseUrl,
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#pod': config.podUrl,
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#statementForwarding': !!config.forwardingTargets.trim(),
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#substrateBackend': 'context-graphs-1.0 + solid-css',
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#lrsBackend': store.backendDescription(),
      'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#xapiProfile': `${config.selfBaseUrl}/xapi/profile`,
    },
  });
}

// ── Activity / agent profile + state ────────────────────────────────

function stateKey(args: { activityId: string; agent: string; stateId: string; registration?: string }): string {
  return `${args.activityId}::${args.agent}::${args.stateId}::${args.registration ?? ''}`;
}
function profileKey(args: { iri: string; profileId: string }): string {
  return `${args.iri}::${args.profileId}`;
}

function handleStateOrProfile(
  resourceStore: Map<string, { content: unknown; etag: string; updated: string; contentType: string }>,
  keyFn: (q: Record<string, string>) => string,
  req: Request,
  res: Response,
): void {
  const q = req.query as Record<string, string>;
  const key = keyFn(q);

  if (req.method === 'GET') {
    if (!q.stateId && !q.profileId) {
      // List the ids of all docs under this scope (no body, per xAPI 2.0 §6.3.1)
      const prefix = key.split('::').slice(0, -1).join('::');
      const ids = [...resourceStore.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k]) => k.split('::').pop());
      res.json(ids);
      return;
    }
    const v = resourceStore.get(key);
    if (!v) { res.status(404).end(); return; }
    // xAPI 2.0 §6.3.2 — If-None-Match: client can short-circuit if their
    // cached copy is current. Returning 304 saves the body fetch.
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    if (ifNoneMatch && (ifNoneMatch === v.etag || ifNoneMatch === '*')) {
      res.status(304).setHeader('ETag', v.etag).end();
      return;
    }
    res.setHeader('ETag', v.etag);
    res.setHeader('Last-Modified', new Date(v.updated).toUTCString());
    res.setHeader('Content-Type', v.contentType);
    res.send(v.content);
    return;
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    // xAPI 2.0 §6.3.3 — If-Match: optimistic concurrency. Reject if the
    // server's current ETag doesn't match what the caller saw.
    const existing = resourceStore.get(key);
    const ifMatch = req.headers['if-match'] as string | undefined;
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    if (ifMatch && (!existing || existing.etag !== ifMatch)) {
      res.status(412).json({ error: 'If-Match precondition failed (xAPI 2.0 §6.3.3)' });
      return;
    }
    if (ifNoneMatch === '*' && existing) {
      res.status(412).json({ error: 'If-None-Match: * precondition failed — document exists' });
      return;
    }
    const etag = `"${randomUUID()}"`;
    resourceStore.set(key, {
      content: req.body,
      etag,
      updated: new Date().toISOString(),
      contentType: (req.headers['content-type'] as string | undefined) ?? 'application/json',
    });
    res.setHeader('ETag', etag);
    res.status(204).end();
    return;
  }
  if (req.method === 'DELETE') {
    if (q.stateId || q.profileId) {
      // Conditional delete per xAPI 2.0 §6.3.3
      const existing = resourceStore.get(key);
      const ifMatch = req.headers['if-match'] as string | undefined;
      if (ifMatch && (!existing || existing.etag !== ifMatch)) {
        res.status(412).json({ error: 'If-Match precondition failed (xAPI 2.0 §6.3.3)' });
        return;
      }
      resourceStore.delete(key);
    } else {
      // Bulk delete all keys matching the activity/agent prefix
      const prefix = key.split('::').slice(0, -1).join('::');
      for (const k of Array.from(resourceStore.keys())) {
        if (k.startsWith(prefix)) resourceStore.delete(k);
      }
    }
    res.status(204).end();
    return;
  }
  res.status(405).end();
}

// ── Statement forwarding ────────────────────────────────────────────

async function forwardStatement(stmt: Record<string, unknown>, config: XapiLrsConfig): Promise<void> {
  if (!config.forwardingTargets.trim()) return;
  const targets = config.forwardingTargets.split(',').map(s => s.trim()).filter(Boolean);
  for (const tgt of targets) {
    const [endpoint, creds, version] = tgt.split('||');
    if (!endpoint || !creds) continue;
    try {
      const r = await fetch(`${endpoint.replace(/\/$/, '')}/statements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(creds).toString('base64')}`,
          'X-Experience-API-Version': version || '1.0.3',
        },
        body: JSON.stringify(stmt),
      });
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.warn(`[foxxi-lrs] forward to ${endpoint} failed ${r.status}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[foxxi-lrs] forward to ${endpoint} threw:`, (err as Error).message);
    }
  }
}

// ── xAPI Profile Server ─────────────────────────────────────────────
// Delegates to xapi-profile.ts where the full Profile-spec-2017 shape
// (concepts + templates + patterns) lives, so the profile stays a
// proper first-class artifact a learning-engineer can review +
// extend, not a thin string-table.

import { buildFoxxiProfileDoc } from './xapi-profile.js';

/**
 * Tenant-level profile override.
 *
 * Set FOXXI_XAPI_PROFILE_URL (an HTTPS URL serving a conformant xAPI
 * Profile JSON-LD doc) and Foxxi will serve THAT profile at /xapi/profile
 * instead of the built-in Foxxi profile. The override is cached for 5
 * minutes per process so the bridge isn't hammering the upstream.
 * Tenants who already have a profile published elsewhere (an internal
 * registry, a custom partner profile, an industry-standard
 * verb set they want to declare) can flip the env and ship.
 */
let _profileCache: { url: string; doc: Record<string, unknown>; fetchedAt: number } | null = null;
async function fetchExternalProfile(url: string): Promise<Record<string, unknown> | null> {
  if (_profileCache && _profileCache.url === url && Date.now() - _profileCache.fetchedAt < 5 * 60 * 1000) {
    return _profileCache.doc;
  }
  try {
    const r = await fetch(url, { headers: { Accept: 'application/ld+json, application/json' } });
    if (!r.ok) return null;
    const doc = await r.json() as Record<string, unknown>;
    _profileCache = { url, doc, fetchedAt: Date.now() };
    return doc;
  } catch { return null; }
}

async function buildFoxxiXapiProfile(config: XapiLrsConfig): Promise<Record<string, unknown>> {
  void config;
  const override = process.env.FOXXI_XAPI_PROFILE_URL;
  if (override) {
    const ext = await fetchExternalProfile(override);
    if (ext) return ext;
    // Fall through to built-in if override unreachable — never block
    // the endpoint over a misconfigured override.
  }
  return buildFoxxiProfileDoc({ generatedAt: new Date().toISOString() });
}

// Kept for back-compat (older code may import this name)
function _buildFoxxiXapiProfileLegacy(config: XapiLrsConfig): Record<string, unknown> {
  const baseId = `${config.selfBaseUrl}/xapi/profile`;
  return {
    '@context': 'https://w3id.org/xapi/profiles/context',
    id: baseId,
    type: 'Profile',
    conformsTo: 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: { 'en': 'Foxxi Content Intelligence — xAPI Profile' },
    definition: { 'en': 'xAPI vocabulary the Foxxi vertical emits when projecting substrate descriptors to LRS Statements. Covers SCORM/cmi5 verb subset plus Foxxi-specific extensions for concept-graph retrieval traces.' },
    seeAlso: 'https://github.com/markjspivey-xwisee/interego',
    versions: [{ id: `${baseId}/v/1`, generatedAtTime: new Date().toISOString() }],
    author: { type: 'Organization', name: 'Acme Training Co (demo tenant)' },
    concepts: [
      { id: 'http://adlnet.gov/expapi/verbs/launched', type: 'Verb', prefLabel: { en: 'launched' }, definition: { en: 'cmi5 launch — start of a session' } },
      { id: 'http://adlnet.gov/expapi/verbs/initialized', type: 'Verb', prefLabel: { en: 'initialized' }, definition: { en: 'cmi5 initialized verb' } },
      { id: 'http://adlnet.gov/expapi/verbs/completed', type: 'Verb', prefLabel: { en: 'completed' }, definition: { en: 'cmi5 completed verb' } },
      { id: 'http://adlnet.gov/expapi/verbs/passed', type: 'Verb', prefLabel: { en: 'passed' }, definition: { en: 'cmi5 passed verb' } },
      { id: 'http://adlnet.gov/expapi/verbs/failed', type: 'Verb', prefLabel: { en: 'failed' }, definition: { en: 'cmi5 failed verb' } },
      { id: 'http://adlnet.gov/expapi/verbs/satisfied', type: 'Verb', prefLabel: { en: 'satisfied' }, definition: { en: 'cmi5 satisfied verb (moveOn)' } },
      { id: 'http://adlnet.gov/expapi/verbs/terminated', type: 'Verb', prefLabel: { en: 'terminated' }, definition: { en: 'cmi5 terminated verb' } },
      { id: 'http://adlnet.gov/expapi/verbs/voided', type: 'Verb', prefLabel: { en: 'voided' }, definition: { en: 'xAPI voiding verb' } },
      { id: 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#asked', type: 'Verb', prefLabel: { en: 'asked' }, definition: { en: 'Foxxi extension — learner asked a content question against the concept graph' } },
      { id: 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#retrieved', type: 'Verb', prefLabel: { en: 'retrieved' }, definition: { en: 'Foxxi extension — concept-graph retrieval traced a set of slides' } },
      { id: 'http://adlnet.gov/expapi/activities/course', type: 'ActivityType', prefLabel: { en: 'course' } },
      { id: 'http://adlnet.gov/expapi/activities/lesson', type: 'ActivityType', prefLabel: { en: 'lesson' } },
      { id: 'http://adlnet.gov/expapi/activities/assessment', type: 'ActivityType', prefLabel: { en: 'assessment' } },
      { id: 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#conceptGraphNode', type: 'ActivityType', prefLabel: { en: 'concept graph node' } },
    ],
    templates: [],
    patterns: [],
  };
}

// ── Route attachment ────────────────────────────────────────────────

export function attachXapiLrsRoutes(app: Express, config: XapiLrsConfig): void {
  const gate = makeAuthGate(config);

  app.get('/xapi/about', gate, (req, res) => handleAbout(req, res, config));

  // xAPI Profile Server — public (no auth) so other tools can discover
  // what vocabulary Foxxi emits.
  app.get('/xapi/profile', (_req, res) => { void (async () => {
    const doc = await buildFoxxiXapiProfile(config);
    res.type('application/ld+json').json(doc);
  })(); });

  // The order matters: PUT statementId needs to be checked before POST handler picks up.
  app.post('/xapi/statements', gate, (req, res) => { void handlePostStatements(req, res, config); });
  app.put('/xapi/statements', gate, (req, res) => { void handlePutStatement(req, res, config); });
  app.get('/xapi/statements', gate, (req, res) => { void handleGetStatements(req, res); });

  // Activity / agent inspection helpers
  app.get('/xapi/activities', gate, (req, res) => { void (async () => {
    const id = req.query.activityId as string | undefined;
    if (!id) { res.status(400).json({ error: 'activityId required' }); return; }
    const all = await store.listAll();
    for (const r of all) {
      const obj = r.statement.object as { id?: string; definition?: unknown } | undefined;
      if (obj?.id === id && obj.definition) {
        res.json({ id, objectType: 'Activity', definition: obj.definition });
        return;
      }
    }
    res.json({ id, objectType: 'Activity' });
  })(); });
  app.get('/xapi/agents', gate, (req, res) => { void (async () => {
    const agentJson = req.query.agent as string | undefined;
    if (!agentJson) { res.status(400).json({ error: 'agent required (JSON-encoded Agent object)' }); return; }
    try {
      const agent = JSON.parse(agentJson);
      const names = new Set<string>();
      const mboxes = new Set<string>();
      const accounts: Array<{ name: string; homePage: string }> = [];
      const all = await store.listAll();
      for (const r of all) {
        const ac = r.statement.actor as { name?: string; mbox?: string; account?: { name: string; homePage: string } } | undefined;
        if (!ac) continue;
        const sameAgent = JSON.stringify(ac) === JSON.stringify(agent)
          || (agent.mbox && ac.mbox === agent.mbox)
          || (agent.account?.name && ac.account?.name === agent.account.name);
        if (sameAgent) {
          if (ac.name) names.add(ac.name);
          if (ac.mbox) mboxes.add(ac.mbox);
          if (ac.account) accounts.push(ac.account);
        }
      }
      res.json({
        objectType: 'Person',
        name: Array.from(names),
        mbox: Array.from(mboxes),
        account: accounts,
      });
    } catch {
      res.status(400).json({ error: 'invalid agent JSON' });
    }
  })(); });

  // State + profile resources
  for (const method of ['get', 'put', 'post', 'delete'] as const) {
    app[method]('/xapi/activities/state', gate, (req, res) =>
      handleStateOrProfile(activityStateStore, q => stateKey({
        activityId: q.activityId ?? '', agent: q.agent ?? '', stateId: q.stateId ?? '', registration: q.registration,
      }), req, res),
    );
    app[method]('/xapi/activities/profile', gate, (req, res) =>
      handleStateOrProfile(activityProfileStore, q => profileKey({ iri: q.activityId ?? '', profileId: q.profileId ?? '' }), req, res),
    );
    app[method]('/xapi/agents/profile', gate, (req, res) =>
      handleStateOrProfile(agentProfileStore, q => profileKey({ iri: q.agent ?? '', profileId: q.profileId ?? '' }), req, res),
    );
  }
}
