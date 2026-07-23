/**
 * Inbound xAPI 2.0 LRS surface for the Foxxi vertical.
 *
 * Lets external systems (LMSes, mobile apps, simulators, AI tutors,
 * other LRSes via Statement Forwarding) write learning records *into*
 * the substrate. Each accepted Statement is converted to a Context
 * Descriptor (modal=Asserted, provenance bound to the source LRS or
 * caller WebID) and published to the tenant pod via the lrs-adapter's
 * `publishIngestedStatement` so it joins the rest of the substrate's
 * trace graph.
 *
 * This is a FULL, conformance-targeted LRS — not a demo surface. It is
 * exercised against the ADL `lrs-conformance-test-suite` (xAPI 2.0
 * battery). The conformance-critical behaviours implemented here:
 *
 *   - Every inbound Statement is schema-validated (see xapi-validate.ts);
 *     a malformed Statement is rejected 400 Bad Request.
 *   - Every request MUST carry a valid `X-Experience-API-Version`
 *     header; a missing/invalid header is rejected 400 before auth.
 *   - Every resource validates its query parameters against an exact-
 *     case allow-list; unknown or mis-cased parameters are rejected 400.
 *   - The State / Activity-Profile / Agent-Profile document resources
 *     enforce their required parameters, optimistic concurrency
 *     (ETag / If-Match / If-None-Match), JSON-document merge on POST,
 *     and HEAD.
 *   - `multipart/mixed` Statement requests (attachments + signed
 *     Statements) are parsed; an attachment with no `fileUrl` MUST have
 *     its raw data present in the multipart body; JWS signatures MUST
 *     use an RSA-SHA2 algorithm.
 *
 * Endpoints (xAPI 2.0 / IEEE 9274.1.1 §7):
 *
 *   GET    /xapi/about
 *   POST   /xapi/statements                     (single | batch | multipart)
 *   PUT    /xapi/statements?statementId=<uuid>  (caller-provided id)
 *   GET    /xapi/statements                     (filtered query | single)
 *   GET    /xapi/activities?activityId=<iri>
 *   GET    /xapi/agents?agent=<json>
 *   GET|PUT|POST|DELETE|HEAD /xapi/activities/state
 *   GET|PUT|POST|DELETE|HEAD /xapi/activities/profile
 *   GET|PUT|POST|DELETE|HEAD /xapi/agents/profile
 *
 * Not a "memory-only" demo — every Statement persists as a descriptor on
 * the tenant pod, queryable via iep:discover() filtered on
 * `lrs:StatementIngestion`. The state/profile resources use an in-memory
 * Map sized for demo workloads; swap for Redis/Postgres at production
 * scale (the statement store is already pluggable — see statement-store.ts).
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { ingestStatementBatchFromLrs as _unusedTypeAnchor } from '../../lrs-adapter/src/pod-publisher.js';
import { createStatementStore, ConflictError, matchesFilter, type StatementStore, type StoredStatement } from './statement-store.js';
import { validateStatement, validateAgentObject } from './xapi-validate.js';
import { TenantPartition, DEFAULT_TENANT, type TenantId } from './tenant-context.js';
import {
  forwardStatement as forwardToTargets,
  recordInbound,
  inboundCredentials,
  seedForwardingTargets,
} from './lrs-forwarding.js';
import {
  withTransientRetry,
} from '@interego/solid';
import type {
  IRI,
} from '@interego/core';
import { verifySessionToken, buildAddressMap } from './auth.js';
import { verifyOauthBearer } from './xapi-oauth.js';
import type { KeyObject } from 'node:crypto';

void _unusedTypeAnchor;

// ── Pluggable, tenant-partitioned backend ───────────────────────────
// One Foxxi bridge can serve many tenants. Every store below is
// partitioned by tenant through TenantPartition; a single-tenant
// deployment resolves every request to DEFAULT_TENANT and behaves
// byte-identically to a single-tenant build.
// Tenants forced to an in-memory statement store regardless of the global
// FOXXI_LRS_BACKEND. These are DERIVED, re-projectable VIEWS — never the system
// of record. The agent pod is the source of truth; Foxxi virtualizes the LRS
// over it (on-read projection), and the per-source-pod LENS tenants (`lens:<agent>`)
// hold the rebuildable index of that virtualization. Pod durability is wrong for
// them: a write would contend on a pod manifest CAS, and the data is re-derived
// from the agent's own pod every cycle. Memory is correct (lost on restart,
// re-projected next cycle). Configured by an explicit allowlist
// (FOXXI_LRS_MEMORY_TENANTS, csv) OR a prefix (FOXXI_LRS_MEMORY_TENANT_PREFIXES,
// csv — defaults to `lens:` so every per-agent virtualization view is in-memory).
const memoryBackedTenants = new Set(
  (process.env.FOXXI_LRS_MEMORY_TENANTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
);
const memoryTenantPrefixes = (process.env.FOXXI_LRS_MEMORY_TENANT_PREFIXES ?? 'lens:')
  .split(',').map(s => s.trim()).filter(Boolean);
function isDerivedViewTenant(tenant: string): boolean {
  return memoryBackedTenants.has(tenant) || memoryTenantPrefixes.some(p => tenant.startsWith(p));
}
const statementStores = new TenantPartition<StatementStore>(
  (tenant) => createStatementStore(
    isDerivedViewTenant(String(tenant)) ? 'memory' : process.env.FOXXI_LRS_BACKEND,
  ),
);

// ── Config ──────────────────────────────────────────────────────────

export interface XapiLrsConfig {
  podUrl: string;
  tenantDid: IRI;
  basicAuthPairs: string;
  forwardingTargets: string;
  selfBaseUrl: string;
  /** Optional: resolve a Bearer token to its tenant (e.g. a cmi5
   *  auth-token minted by a launch). Returns null for unknown tokens. */
  bearerTenantResolver?: (token: string) => TenantId | null;
  /** Optional: the published tenant directory (user_id + web_id), used to VERIFY
   *  wallet-signed Foxxi session tokens presented as Bearer auth. Directory users get a
   *  deterministic wallet (the same derivation mintSessionToken uses), so a token minted
   *  for a known user_id verifies. Without this, session-token Bearers cannot authenticate
   *  and (with no cmi5/OAuth match) are rejected — closing the "any Bearer" hole. */
  sessionUsers?: () => ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }>;
  /** Optional: ES256 public key (derived from FOXXI_LTI_PRIVATE_KEY_PEM) used to verify
   *  OAuth client-credentials bearers. Null → OAuth bearers are rejected (fail-closed). */
  oauthPublicKey?: KeyObject | null;
  /** Optional: invoked after each Statement is stored, with its tenant.
   *  The cmi5 LMS uses this to watch for moveOn satisfaction. */
  onStatementStored?: (statement: Record<string, unknown>, tenant: TenantId) => void;
  /** Optional: resolve the OWNER tenant for outbound forwarding from the
   *  statement's actor (self-sovereign per-user forwarding). Returns null
   *  when the actor has no resolvable owner — forwarding then falls back to
   *  the caller's tenant (preserves behavior for non-self-sovereign upstreams). */
  ownerTenantOfStatement?: (statement: Record<string, unknown>) => TenantId | null;
}

// ── In-process statement store accessors ────────────────────────────

export type XapiStatementRecord = StoredStatement;

/** The LRS's own identity as statement authority (xAPI 2.0 §4.1.9) for
 *  internally-emitted statements. homePage is an https IRL in prod. */
const INTERNAL_LRS_AUTHORITY = { homePage: process.env.BRIDGE_DEPLOYMENT_URL ?? 'http://localhost:6080', name: 'foxxi-lrs' };
export function storeStatementInternal(stmt: Record<string, unknown>, tenant: TenantId = DEFAULT_TENANT): string {
  // Author + structurally validate on the internal emission path too, exactly as
  // the inbound POST /xapi/statements path does — so an internally-stored statement
  // carries an LRS authority (§4.1.9) and is checked against the xAPI shape. A
  // non-conformant internal emission is logged (not dropped) so no system flow breaks
  // while the non-conformance is surfaced.
  const enriched = ensureStatementFields(stmt, INTERNAL_LRS_AUTHORITY);
  const id = enriched.id as string;
  const errs = validateStatement(enriched);
  if (errs.length > 0) {
    // ENFORCE (don't merely warn): a non-conformant statement is NOT stored, mirroring
    // the inbound POST /xapi/statements 400 — so the LRS never holds a spec-violating
    // statement. A loud error surfaces the offending emit path.
    // eslint-disable-next-line no-console
    console.error(`[storeStatementInternal] REJECTED non-conformant statement ${id} (not stored):`, errs.slice(0, 5).join('; '));
    return id;
  }
  const rec: StoredStatement = { id, statement: enriched, stored: enriched.stored as string, voided: false };
  void statementStores.for(tenant).put(rec).catch(err => {
    // eslint-disable-next-line no-console
    console.warn('[storeStatementInternal]', (err as Error).message);
  });
  return id;
}

export async function listStoredStatements(tenant: TenantId = DEFAULT_TENANT): Promise<StoredStatement[]> {
  return statementStores.for(tenant).listAll();
}
export async function clearStatementStore(tenant: TenantId = DEFAULT_TENANT): Promise<void> {
  return statementStores.for(tenant).clear();
}
export function getStatementStore(tenant: TenantId = DEFAULT_TENANT): StatementStore {
  return statementStores.for(tenant);
}
/** Every tenant that currently holds statements — for cross-tenant ops. */
export function statementStoreTenants(): TenantId[] { return statementStores.tenants(); }

// ── In-memory document stores (state + profile), tenant-partitioned ──

interface StoredDoc { content: unknown; etag: string; updated: string; contentType: string; }
const stateStores = new TenantPartition<Map<string, StoredDoc>>(() => new Map());
const activityProfileStores = new TenantPartition<Map<string, StoredDoc>>(() => new Map());
const agentProfileStores = new TenantPartition<Map<string, StoredDoc>>(() => new Map());

// Raw attachment bytes, keyed by SHA-2 hash, captured from
// multipart/mixed Statement requests — tenant-partitioned.
const attachmentStores = new TenantPartition<Map<string, { data: Buffer; contentType: string }>>(() => new Map());

// Per-tenant document/attachment stores are keyed by *caller-supplied* ids
// (State stateId, Activity/Agent Profile profileId, attachment SHA-2). The auth
// gate accepts any non-empty Bearer, so a junk bearer can PUT unlimited distinct
// keys into a single tenant Map and exhaust memory (round-45: the doc/attachment
// siblings the round-43 statement-store cap missed). Bound every such Map with an
// evict-oldest set. Insertion order in a JS Map is stable, so keys().next() is the
// oldest live entry — the same discipline the statement store and cmi5 registry use.
const XAPI_DOC_STORE_MAX = 50_000;
function cappedMapSet<V>(m: Map<string, V>, key: string, value: V, max = XAPI_DOC_STORE_MAX): void {
  if (m.size >= max && !m.has(key)) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  m.set(key, value);
}

// ── Pod projection (foxxi:XapiTenantSnapshot) ────────────────────────
// xAPI Activity State, Activity Profile, and Agent Profile documents
// are snapshotted as one composite descriptor per tenant. Statements
// themselves are projected per-record via PodStatementStore — these
// docs use the coarser snapshot because they're read/written together
// and the snapshot shape matches operator inspection patterns.
import {
  registerSnapshot as registerXapiDocsSnapshot,
  dirty as markXapiDocsDirty,
  loadLatestSnapshot as loadXapiDocsSnapshot,
  FOXXI_SNAPSHOT_TYPES as XAPI_SNAP_TYPES,
} from './pod-snapshot-publisher.js';
interface XapiDocsSnapshot {
  state: Record<string, Array<[string, StoredDoc]>>;
  activityProfile: Record<string, Array<[string, StoredDoc]>>;
  agentProfile: Record<string, Array<[string, StoredDoc]>>;
}
function collectXapiDocsSnapshot(): XapiDocsSnapshot {
  const dumpByTenant = (p: TenantPartition<Map<string, StoredDoc>>) => {
    const out: Record<string, Array<[string, StoredDoc]>> = {};
    for (const t of p.tenants()) out[String(t)] = [...p.for(t).entries()];
    return out;
  };
  return {
    state: dumpByTenant(stateStores),
    activityProfile: dumpByTenant(activityProfileStores),
    agentProfile: dumpByTenant(agentProfileStores),
  };
}
async function hydrateXapiDocsFromPod(): Promise<void> {
  const snap = await loadXapiDocsSnapshot<XapiDocsSnapshot>('xapi-docs');
  if (!snap) return;
  const restore = (p: TenantPartition<Map<string, StoredDoc>>, dump: Record<string, Array<[string, StoredDoc]>>) => {
    for (const [tenant, entries] of Object.entries(dump)) {
      const m = p.for(tenant as TenantId);
      for (const [k, v] of entries) m.set(k, v);
    }
  };
  if (snap.state) restore(stateStores, snap.state);
  if (snap.activityProfile) restore(activityProfileStores, snap.activityProfile);
  if (snap.agentProfile) restore(agentProfileStores, snap.agentProfile);
}
registerXapiDocsSnapshot({ surface: 'xapi-docs', typeIri: XAPI_SNAP_TYPES.XapiDocs, collect: collectXapiDocsSnapshot });
void hydrateXapiDocsFromPod();
const xapiDocsPodDirty = (): void => markXapiDocsDirty('xapi-docs');

// ── Constants ───────────────────────────────────────────────────────

const VOIDED_VERB = 'http://adlnet.gov/expapi/verbs/voided';
const SIGNATURE_USAGE_TYPE = 'http://adlnet.gov/expapi/attachments/signature';
/** Versions advertised by /xapi/about. */
const ABOUT_VERSIONS = ['2.0.0', '1.0.3', '1.0.2', '1.0.1', '1.0.0'];
/** `X-Experience-API-Version` request-header values this LRS accepts. */
const ACCEPTED_VERSION_RE = /^(2\.0(\.\d+)?|1\.0(\.\d+)?)$/;
/** JWS algorithms permitted for signed Statements (xAPI §4.1.11). */
const ALLOWED_JWS_ALGS = new Set(['RS256', 'RS384', 'RS512']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: unknown): s is string { return typeof s === 'string' && UUID_RE.test(s); }
function nowIso(): string { return new Date().toISOString(); }

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
function isIsoTimestamp(s: unknown): boolean {
  return typeof s === 'string' && ISO_TIMESTAMP_RE.test(s) && !Number.isNaN(Date.parse(s));
}

// ── Version + auth gate ─────────────────────────────────────────────

function setXapiHeaders(res: Response, version: string): void {
  res.setHeader('X-Experience-API-Version', version);
  res.setHeader('X-Experience-API-Consistent-Through', nowIso());
}

function negotiateVersion(req: Request): string {
  const v = req.headers['x-experience-api-version'];
  return typeof v === 'string' && v ? v : '2.0.0';
}

/** Resolve a Basic-auth header to its tenant, or null if no pair matches. */
function basicAuthTenant(header: string | undefined, credTenants: Map<string, TenantId>): TenantId | null {
  if (credTenants.size === 0) return null;
  if (!header || !/^Basic\s+/i.exec(header)) return null;
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  return credTenants.get(decoded) ?? null;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : undefined;
}

/** The tenant a gated request resolved to (set by the auth gate). */
function tenantOf(req: Request): TenantId {
  return (req as Request & { xapiTenant?: TenantId }).xapiTenant ?? DEFAULT_TENANT;
}

/**
 * The single gate on every LRS resource. Order matters and is
 * conformance-driven:
 *   1. `X-Experience-API-Version` MUST be present and a value the LRS
 *      accepts — otherwise 400, *before* auth is even considered.
 *   2. Authentication (Basic key OR Foxxi Bearer token) — otherwise 401.
 */
function makeAuthGate(config: XapiLrsConfig) {
  // Each Basic-auth credential carries its tenant (`user:pass` → default,
  // `user:pass:tenantId` → a named tenant) — the standard multi-tenant
  // LRS pattern: one credential per upstream LMS/LRS integration. The
  // env value seeds a LIVE registry; operators can mint/revoke inbound
  // forwarding credentials at runtime and the gate honours them at once.
  inboundCredentials.seedFromEnv(config.basicAuthPairs);
  const credTenants = inboundCredentials.liveMap;
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawVersion = req.headers['x-experience-api-version'];
    const version = typeof rawVersion === 'string' ? rawVersion : '';
    if (!version) {
      setXapiHeaders(res, '2.0.0');
      res.status(400).json({ error: 'every xAPI request MUST include an X-Experience-API-Version header (§6.2)' });
      return;
    }
    if (!ACCEPTED_VERSION_RE.test(version)) {
      setXapiHeaders(res, '2.0.0');
      res.status(400).json({ error: `unsupported X-Experience-API-Version "${version}" — this LRS accepts 1.0.x and 2.0.x` });
      return;
    }
    setXapiHeaders(res, version.startsWith('2.') ? version : version);

    const authHeader = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
    const r = req as Request & { xapiAuth?: unknown; xapiTenant?: TenantId };
    const basicTenant = basicAuthTenant(authHeader, credTenants);
    if (basicTenant !== null) {
      const decoded = Buffer.from((authHeader ?? '').replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      r.xapiAuth = { kind: 'basic', principal: decoded.split(':')[0] || 'lrs-key' };
      r.xapiTenant = basicTenant;
      return next();
    }
    const bearer = bearerToken(authHeader);
    if (bearer) {
      // A Bearer must resolve to a VERIFIED identity (round-47). Previously ANY non-empty
      // Bearer fell through to DEFAULT_TENANT, so a junk token could read every learner's
      // PII and POST forged statements — the LRS gate is the sole authenticator (mounted
      // above all other middleware). Try each real credential type; reject if none verify.

      // 1. cmi5 launch auth-token → its launch tenant (recognized, minted by a launch).
      const cmi5Tenant = config.bearerTenantResolver?.(bearer);
      if (cmi5Tenant) {
        r.xapiAuth = { kind: 'bearer', token: bearer };
        r.xapiTenant = cmi5Tenant;
        return next();
      }

      // 2. Wallet-signed Foxxi session token → verify signature + directory binding.
      const users = config.sessionUsers?.();
      if (users && users.length) {
        // Build the address map from EXPLICIT wallet_address only (round-49). Deriving a
        // deterministic wallet for directory users who lack one uses the PUBLIC demo seed, so
        // anyone could forge those users' session tokens and reach DEFAULT_TENANT — the very
        // forgery this gate exists to stop. A caller must present a token whose signer is a
        // directory user's REAL published wallet (or the secret-seeded conformance self-test
        // identity, which carries an explicit wallet_address). buildAddressMap already skips
        // entries without wallet_address, so no public-seed identity enters the trusted set.
        const addressMap = buildAddressMap(
          users as ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }>,
        );
        const verified = verifySessionToken(bearer, addressMap);
        if (verified.ok) {
          r.xapiAuth = { kind: 'bearer', principal: verified.callerDid, token: bearer };
          r.xapiTenant = DEFAULT_TENANT;
          return next();
        }
      }

      // 3. OAuth client-credentials bearer → real ES256 signature verification.
      if (config.oauthPublicKey) {
        const claims = verifyOauthBearer(bearer, config.oauthPublicKey);
        if (claims) {
          r.xapiAuth = { kind: 'bearer', principal: typeof claims.sub === 'string' ? claims.sub : 'oauth-client', token: bearer };
          r.xapiTenant = DEFAULT_TENANT;
          return next();
        }
      }

      // 4. Unverifiable bearer → 401.
      res.status(401).setHeader('WWW-Authenticate', 'Bearer realm="foxxi-lrs"').json({
        error: 'invalid_token',
        detail: 'Bearer token could not be verified — present a cmi5 launch token, a wallet-signed Foxxi session token, or an OAuth client-credentials token.',
      });
      return;
    }
    res.status(401).setHeader('WWW-Authenticate', 'Basic realm="foxxi-lrs", Bearer realm="foxxi-lrs"').json({
      error: 'authentication required',
      detail: 'xAPI requires Basic or Bearer auth on every resource. Configure FOXXI_LRS_BASIC_AUTH_PAIRS on the bridge, or present a Foxxi session token.',
    });
  };
}

// ── Query-parameter allow-lists (exact case) ────────────────────────

const STATEMENTS_GET_PARAMS = [
  'statementId', 'voidedStatementId', 'agent', 'verb', 'activity', 'registration',
  'related_activities', 'related_agents', 'since', 'until', 'limit', 'format',
  'attachments', 'ascending', 'cursor', 'continuationToken',
];
const STATE_PARAMS = ['activityId', 'agent', 'registration', 'stateId', 'since'];
const ACTIVITY_PROFILE_PARAMS = ['activityId', 'profileId', 'since'];
const AGENT_PROFILE_PARAMS = ['agent', 'profileId', 'since'];

/**
 * Reject (400) any request carrying a query parameter not in the exact-
 * case allow-list. xAPI requires that an unrecognised *or mis-cased*
 * parameter be a hard error — `?StatementId=` is as wrong as `?foo=`.
 * Returns true when a response was sent.
 */
function rejectUnknownParams(req: Request, res: Response, allowed: string[]): boolean {
  const bad = Object.keys(req.query).filter(k => !allowed.includes(k));
  if (bad.length > 0) {
    res.status(400).json({ error: `unrecognised or mis-cased query parameter(s): ${bad.join(', ')}` });
    return true;
  }
  return false;
}

// ── Statement normalisation ─────────────────────────────────────────

/**
 * xAPI §4.1.6.2: an LRS returns each contextActivities value as an
 * ARRAY even when the caller supplied a single Activity. Normalise on
 * ingest so every stored + returned Statement is array-shaped.
 */
function normalizeContextActivities(ctx: unknown): void {
  if (!ctx || typeof ctx !== 'object') return;
  const ca = (ctx as Record<string, unknown>).contextActivities;
  if (!ca || typeof ca !== 'object') return;
  for (const key of ['parent', 'grouping', 'category', 'other']) {
    const v = (ca as Record<string, unknown>)[key];
    if (v !== undefined && !Array.isArray(v)) {
      (ca as Record<string, unknown>)[key] = [v];
    }
  }
}

function ensureStatementFields(stmt: Record<string, unknown>, authority: { homePage: string; name: string }): Record<string, unknown> {
  const out = { ...stmt };
  if (typeof out.id !== 'string' || !isUuid(out.id)) out.id = randomUUID();
  if (typeof out.timestamp !== 'string') out.timestamp = nowIso();
  // `stored` is always LRS-assigned (§4.1.8) — overwrite any caller value.
  out.stored = nowIso();
  if (!out.authority || typeof out.authority !== 'object') {
    out.authority = { objectType: 'Agent', account: { homePage: authority.homePage, name: authority.name } };
  }
  if (!out.version) out.version = '2.0.0';

  const actor = out.actor as Record<string, unknown> | undefined;
  if (actor && typeof actor === 'object' && !actor.objectType) {
    actor.objectType = (Array.isArray(actor.member) || actor.member) ? 'Group' : 'Agent';
  }
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
      normalizeContextActivities(object.context);
    }
  }
  normalizeContextActivities(out.context);
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

// ── multipart/mixed parsing ─────────────────────────────────────────

interface MultipartPart { headers: Record<string, string>; body: Buffer; }

/**
 * Parse a `multipart/mixed` body (RFC 2046 §5.1) from a raw Buffer.
 * Returns each part with its decoded headers and raw body bytes. The
 * first part is expected to be the `application/json` Statement payload.
 */
function parseMultipart(buf: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const segments: Buffer[] = [];
  let idx = buf.indexOf(delimiter);
  while (idx !== -1) {
    const next = buf.indexOf(delimiter, idx + delimiter.length);
    if (next === -1) break;
    // Slice between this delimiter and the next, dropping the leading CRLF.
    let start = idx + delimiter.length;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    segments.push(buf.subarray(start, next));
    idx = next;
  }
  for (const seg of segments) {
    const headerEnd = seg.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = seg.subarray(0, headerEnd).toString('utf8');
    const headers: Record<string, string> = {};
    for (const line of headerText.split('\r\n')) {
      const c = line.indexOf(':');
      if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
    }
    let body = seg.subarray(headerEnd + 4);
    // Trim a single trailing CRLF that precedes the next boundary.
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }
    parts.push({ headers, body });
  }
  return parts;
}

/** Decode a base64url string. */
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Validate a JWS compact serialisation used as a Statement signature
 * (xAPI §4.1.11 / Data 2.6). Returns an error string, or null when the
 * signature is well-formed. Checks:
 *   - exactly three base64url segments;
 *   - the JOSE protected header is JSON with an RSA-SHA2 `alg`
 *     (`none` and symmetric algorithms are forbidden);
 *   - the payload is a valid JSON serialisation of a Statement.
 */
function checkJwsSignature(jws: Buffer): string | null {
  const compact = jws.toString('utf8').trim();
  const segs = compact.split('.');
  if (segs.length !== 3 || segs.some(s => s.length === 0)) {
    return 'signature attachment is not a valid JWS compact serialisation';
  }
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(segs[0]!).toString('utf8')) as Record<string, unknown>;
  } catch {
    return 'signature JWS protected header is not valid JSON';
  }
  const alg = header.alg;
  if (typeof alg !== 'string' || !ALLOWED_JWS_ALGS.has(alg)) {
    return `signed Statements MUST use a JWS algorithm of RS256, RS384 or RS512 (got ${JSON.stringify(alg)})`;
  }
  // §4.1.11 / XAPI-00116: the JWS payload MUST be a valid JSON
  // serialisation of the complete Statement.
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(segs[1]!).toString('utf8'));
  } catch {
    return 'the JWS signature payload is not a valid JSON serialisation of the Statement';
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'the JWS signature payload must be a JSON Statement object';
  }
  return null;
}

// ── /xapi/statements POST ───────────────────────────────────────────

async function handlePostStatements(req: Request, res: Response, config: XapiLrsConfig): Promise<void> {
  if (rejectUnknownParams(req, res, [])) return;
  const ct = ((req.headers['content-type'] as string | undefined) ?? '').toLowerCase();

  let batch: Record<string, unknown>[];
  let multipartParts: Map<string, MultipartPart> | null = null;

  if (ct.startsWith('multipart/mixed')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    const boundary = (m?.[1] ?? m?.[2] ?? '').trim();
    if (!boundary) { res.status(400).json({ error: 'multipart/mixed request requires a boundary parameter' }); return; }
    if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'multipart/mixed body could not be read' }); return; }
    const parts = parseMultipart(req.body, boundary);
    if (parts.length === 0) { res.status(400).json({ error: 'multipart/mixed body contained no parts' }); return; }
    const first = parts[0]!;
    if (!(first.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      res.status(400).json({ error: 'the first part of a multipart/mixed request MUST be application/json' });
      return;
    }
    const partErr = validateMultipartPartHeaders(parts);
    if (partErr) { res.status(400).json({ error: partErr }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(first.body.toString('utf8')); }
    catch { res.status(400).json({ error: 'the application/json part is not valid JSON' }); return; }
    batch = Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [parsed as Record<string, unknown>];
    multipartParts = indexAttachmentParts(parts);
  } else if (ct.startsWith('application/json') || ct === '') {
    const raw = req.body;
    if (raw === undefined || raw === null || (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0 && ct === '')) {
      res.status(400).json({ error: 'request body is empty or missing' });
      return;
    }
    batch = Array.isArray(raw) ? raw as Record<string, unknown>[] : [raw as Record<string, unknown>];
  } else {
    res.status(400).json({ error: `unsupported Content-Type "${ct}" — statements require application/json or multipart/mixed` });
    return;
  }

  // §7.2: a batch MUST NOT reuse a Statement id within itself.
  const seenIds = new Set<string>();
  for (const stmt of batch) {
    const sid = stmt && typeof stmt === 'object' ? (stmt as Record<string, unknown>).id : undefined;
    if (typeof sid === 'string') {
      if (seenIds.has(sid)) {
        res.status(400).json({ error: `statement id ${sid} appears more than once in the batch` });
        return;
      }
      seenIds.add(sid);
    }
  }

  // Validate every Statement BEFORE persisting any of them — a batch is
  // all-or-nothing (§7.2: "if any Statement ... is rejected ... reject all").
  for (let i = 0; i < batch.length; i++) {
    const stmt = batch[i]!;
    const errs = validateStatement(stmt);
    if (errs.length > 0) {
      res.status(400).json({ error: `statement[${i}] is not a conformant xAPI Statement`, violations: errs });
      return;
    }
    const attachErr = checkStatementAttachments(stmt, multipartParts);
    if (attachErr) { res.status(400).json({ error: `statement[${i}]: ${attachErr}` }); return; }
  }

  // §4.1.11: every multipart attachment part MUST be referenced by an
  // attachment in the Statements — excess parts are rejected.
  if (multipartParts) {
    const referenced = collectAttachmentHashes(batch);
    for (const hash of multipartParts.keys()) {
      if (!referenced.has(hash)) {
        res.status(400).json({ error: 'multipart request contains an attachment part not referenced by any Statement' });
        return;
      }
    }
  }

  const store = statementStores.for(tenantOf(req));
  const attachStore = attachmentStores.for(tenantOf(req));
  const ids: string[] = [];
  const authority = { homePage: config.selfBaseUrl, name: 'foxxi-lrs' };
  for (const stmt of batch) {
    const enriched = ensureStatementFields(stmt, authority);
    const id = enriched.id as string;
    await applyVoiding(enriched, id, store);
    try {
      await store.put({ id, statement: enriched, stored: enriched.stored as string, voided: false });
    } catch (err) {
      if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); return; }
      throw err;
    }
    ids.push(id);
    persistAttachmentData(enriched, multipartParts, attachStore);
    notifyStatementStored(enriched, tenantOf(req), config);
    recordInboundIfForwarded(req, enriched);
    // Forward to the OWNER's targets (per-user self-sovereign forwarding) when
    // the actor resolves to an owner; else the caller's tenant. So user A's
    // statements only ever reach A's downstream targets, never B's.
    forwardToTargets(config.ownerTenantOfStatement?.(enriched) ?? tenantOf(req), enriched).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[foxxi-lrs] forwarding failed:', (err as Error).message);
    });
  }
  res.status(200).json(ids);
}

/**
 * Apply xAPI §4.1.7 voiding semantics for an inbound voiding Statement:
 * void the target — UNLESS the target is itself a voiding Statement
 * (a Voiding Statement cannot be voided).
 */
async function applyVoiding(stmt: Record<string, unknown>, voidingId: string, store: StatementStore): Promise<void> {
  const target = isVoidingStatement(stmt);
  if (!target) return;
  const existing = await store.get(target);
  if (existing && isVoidingStatement(existing.statement)) return; // can't void a voiding Statement
  await store.markVoided(target, voidingId);
}

/** Validate the structural headers of every non-first multipart part. */
function validateMultipartPartHeaders(parts: MultipartPart[]): string | null {
  for (let i = 1; i < parts.length; i++) {
    const h = parts[i]!.headers;
    if ((h['content-transfer-encoding'] ?? '').toLowerCase() !== 'binary') {
      return 'every multipart attachment part MUST carry a "Content-Transfer-Encoding: binary" header';
    }
    if (!h['x-experience-api-hash']) {
      return 'every multipart attachment part MUST carry an "X-Experience-API-Hash" header';
    }
  }
  return null;
}

/** Index the attachment parts of a multipart body by SHA-2 hash. */
function indexAttachmentParts(parts: MultipartPart[]): Map<string, MultipartPart> {
  const byHash = new Map<string, MultipartPart>();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i]!;
    byHash.set(p.headers['x-experience-api-hash'] ?? createHash('sha256').update(p.body).digest('hex'), p);
  }
  return byHash;
}

/** Collect every attachment `sha2` declared across a batch of Statements. */
function collectAttachmentHashes(batch: Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const stmt of batch) {
    const attachments = (stmt as Record<string, unknown>).attachments;
    if (!Array.isArray(attachments)) continue;
    for (const att of attachments) {
      if (att && typeof att === 'object' && typeof (att as Record<string, unknown>).sha2 === 'string') {
        out.add((att as Record<string, unknown>).sha2 as string);
      }
    }
  }
  return out;
}

/** Persist a Statement's attachment bytes so `?attachments=true` can serve them. */
function persistAttachmentData(
  stmt: Record<string, unknown>,
  parts: Map<string, MultipartPart> | null,
  attachStore: Map<string, { data: Buffer; contentType: string }>,
): void {
  if (!parts) return;
  const attachments = stmt.attachments;
  if (!Array.isArray(attachments)) return;
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const a = att as Record<string, unknown>;
    const sha2 = typeof a.sha2 === 'string' ? a.sha2 : '';
    const part = parts.get(sha2);
    if (part) {
      cappedMapSet(attachStore, sha2, {
        data: part.body,
        contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
      });
    }
  }
}

/**
 * Cross-check a Statement's `attachments` against the multipart body.
 * An attachment with no `fileUrl` MUST have its raw data present in the
 * request as a multipart part; a signature attachment MUST be
 * `application/octet-stream` and carry a valid RSA-SHA2 JWS. Returns an
 * error string or null.
 */
function checkStatementAttachments(stmt: Record<string, unknown>, parts: Map<string, MultipartPart> | null): string | null {
  const attachments = stmt.attachments;
  if (!Array.isArray(attachments)) return null;
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const a = att as Record<string, unknown>;
    const sha2 = typeof a.sha2 === 'string' ? a.sha2 : '';
    const hasFileUrl = typeof a.fileUrl === 'string' && a.fileUrl.length > 0;
    const part = parts?.get(sha2);
    if (!hasFileUrl && !part) {
      return 'an attachment without a "fileUrl" MUST have its raw data included in a multipart/mixed part';
    }
    if (a.usageType === SIGNATURE_USAGE_TYPE) {
      // §4.1.11: a signature attachment MUST be application/octet-stream
      // and its raw data MUST be a valid RSA-SHA2 JWS.
      if (a.contentType !== 'application/octet-stream') {
        return 'a signature attachment MUST have a contentType of "application/octet-stream"';
      }
      if (part) {
        const sigErr = checkJwsSignature(part.body);
        if (sigErr) return sigErr;
      }
    }
  }
  return null;
}

// ── /xapi/statements PUT (caller-supplied id) ───────────────────────

async function handlePutStatement(req: Request, res: Response, config: XapiLrsConfig): Promise<void> {
  if (rejectUnknownParams(req, res, ['statementId'])) return;
  const statementId = (req.query.statementId as string | undefined) ?? '';
  if (!isUuid(statementId)) { res.status(400).json({ error: 'PUT requires ?statementId=<uuid>' }); return; }

  const ct = ((req.headers['content-type'] as string | undefined) ?? '').toLowerCase();
  let stmt: Record<string, unknown>;
  let multipartParts: Map<string, MultipartPart> | null = null;
  if (ct.startsWith('multipart/mixed')) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    const boundary = (m?.[1] ?? m?.[2] ?? '').trim();
    if (!boundary || !Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'malformed multipart/mixed request' }); return; }
    const parts = parseMultipart(req.body, boundary);
    if (parts.length === 0 || !(parts[0]!.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      res.status(400).json({ error: 'the first part of a multipart/mixed request MUST be application/json' });
      return;
    }
    const partErr = validateMultipartPartHeaders(parts);
    if (partErr) { res.status(400).json({ error: partErr }); return; }
    try { stmt = JSON.parse(parts[0]!.body.toString('utf8')) as Record<string, unknown>; }
    catch { res.status(400).json({ error: 'the application/json part is not valid JSON' }); return; }
    multipartParts = indexAttachmentParts(parts);
  } else if (ct.startsWith('application/json') || ct === '') {
    stmt = req.body as Record<string, unknown>;
  } else {
    res.status(400).json({ error: `unsupported Content-Type "${ct}" — statements require application/json or multipart/mixed` });
    return;
  }

  if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) {
    res.status(400).json({ error: 'PUT body must be a single Statement object' });
    return;
  }
  if (stmt.id !== undefined && stmt.id !== statementId) {
    res.status(400).json({ error: 'statement.id and ?statementId= must match' });
    return;
  }
  const errs = validateStatement({ ...stmt, id: statementId });
  if (errs.length > 0) {
    res.status(400).json({ error: 'not a conformant xAPI Statement', violations: errs });
    return;
  }
  const attachErr = checkStatementAttachments(stmt, multipartParts);
  if (attachErr) { res.status(400).json({ error: attachErr }); return; }
  if (multipartParts) {
    const referenced = collectAttachmentHashes([stmt]);
    for (const hash of multipartParts.keys()) {
      if (!referenced.has(hash)) {
        res.status(400).json({ error: 'multipart request contains an attachment part not referenced by the Statement' });
        return;
      }
    }
  }

  (stmt as Record<string, unknown>).id = statementId;
  const store = statementStores.for(tenantOf(req));
  const enriched = ensureStatementFields(stmt, { homePage: config.selfBaseUrl, name: 'foxxi-lrs' });
  await applyVoiding(enriched, statementId, store);
  try {
    await store.put({ id: statementId, statement: enriched, stored: enriched.stored as string, voided: false });
  } catch (err) {
    if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
  persistAttachmentData(enriched, multipartParts, attachmentStores.for(tenantOf(req)));
  notifyStatementStored(enriched, tenantOf(req), config);
  recordInboundIfForwarded(req, enriched);
  forwardToTargets(config.ownerTenantOfStatement?.(enriched) ?? tenantOf(req), enriched).catch(() => undefined);
  res.status(204).end();
}

/**
 * Record an inbound forwarding receipt when the write authenticated via a
 * Basic credential (an upstream system forwarding INTO this LRS), not a
 * launched-learner Bearer session. Pure side-channel: the Statement is
 * never mutated (xAPI immutability + conformance).
 */
function recordInboundIfForwarded(req: Request, stmt: Record<string, unknown>): void {
  const auth = (req as Request & { xapiAuth?: { kind?: string; principal?: string } }).xapiAuth;
  if (auth?.kind !== 'basic') return;
  recordInbound(tenantOf(req), auth.principal ?? 'lrs-key', stmt);
}

/** Fire the post-store hook (the cmi5 LMS watches moveOn through it). */
function notifyStatementStored(stmt: Record<string, unknown>, tenant: TenantId, config: XapiLrsConfig): void {
  if (!config.onStatementStored) return;
  try {
    config.onStatementStored(stmt, tenant);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[foxxi-lrs] onStatementStored hook threw:', (err as Error).message);
  }
}

// ── Statement format projection (§4.2.3) ────────────────────────────

function reduceAgentIds(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.objectType) out.objectType = a.objectType;
  for (const k of ['mbox', 'mbox_sha1sum', 'openid', 'account']) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  if (Array.isArray(a.member)) out.member = a.member.map(m => reduceAgentIds(m as Record<string, unknown>));
  return out;
}

/** Project a Statement (or sub-object) to `format=ids` — identity only. */
function toIdsFormat(stmt: Record<string, unknown>): Record<string, unknown> {
  const reduceObject = (o: unknown): unknown => {
    if (!o || typeof o !== 'object') return o;
    const obj = o as Record<string, unknown>;
    const ot = obj.objectType ?? 'Activity';
    if (ot === 'Agent' || ot === 'Group') return reduceAgentIds(obj);
    // §4.2.3: an Activity in `ids` form carries only its `id`.
    if (ot === 'Activity') return { id: obj.id };
    if (ot === 'StatementRef') return { objectType: 'StatementRef', id: obj.id };
    if (ot === 'SubStatement') return toIdsFormat(obj);
    return obj;
  };
  const out: Record<string, unknown> = { ...stmt };
  if (stmt.actor) out.actor = reduceAgentIds(stmt.actor as Record<string, unknown>);
  if (stmt.object) out.object = reduceObject(stmt.object);
  if (stmt.verb && typeof stmt.verb === 'object') out.verb = { id: (stmt.verb as Record<string, unknown>).id };
  if (stmt.context && typeof stmt.context === 'object') {
    const ctx = { ...(stmt.context as Record<string, unknown>) };
    if (ctx.instructor) ctx.instructor = reduceAgentIds(ctx.instructor as Record<string, unknown>);
    if (ctx.team) ctx.team = reduceAgentIds(ctx.team as Record<string, unknown>);
    if (ctx.contextActivities && typeof ctx.contextActivities === 'object') {
      const ca = { ...(ctx.contextActivities as Record<string, unknown>) };
      for (const k of ['parent', 'grouping', 'category', 'other']) {
        if (Array.isArray(ca[k])) ca[k] = (ca[k] as unknown[]).map(reduceObject);
      }
      ctx.contextActivities = ca;
    }
    out.context = ctx;
  }
  return out;
}

/** Project a language map to a single entry, preferring `langs`. */
function pickLanguage(map: Record<string, unknown>, langs: string[]): Record<string, unknown> {
  for (const l of langs) {
    if (map[l] !== undefined) return { [l]: map[l] };
  }
  const first = Object.keys(map)[0];
  return first ? { [first]: map[first] } : map;
}

/**
 * Project a Statement to `format=canonical` — every language map (verb
 * display, Activity definition name/description) is reduced to a single
 * entry chosen by the request's Accept-Language. Recurses into a
 * SubStatement object.
 */
function toCanonicalFormat(stmt: Record<string, unknown>, langs: string[]): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(stmt)) as Record<string, unknown>;
  const reduceActivityDef = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    const def = (o as Record<string, unknown>).definition as Record<string, unknown> | undefined;
    if (!def) return;
    if (def.name && typeof def.name === 'object') def.name = pickLanguage(def.name as Record<string, unknown>, langs);
    if (def.description && typeof def.description === 'object') def.description = pickLanguage(def.description as Record<string, unknown>, langs);
  };
  const canonicalizeNode = (node: Record<string, unknown>): void => {
    const verb = node.verb as Record<string, unknown> | undefined;
    if (verb?.display && typeof verb.display === 'object') {
      verb.display = pickLanguage(verb.display as Record<string, unknown>, langs);
    }
    const obj = node.object as Record<string, unknown> | undefined;
    if (obj && typeof obj === 'object') {
      const ot = obj.objectType ?? 'Activity';
      if (ot === 'Activity') reduceActivityDef(obj);
      else if (ot === 'SubStatement') canonicalizeNode(obj);
    }
    const ctx = node.context as Record<string, unknown> | undefined;
    if (ctx?.contextActivities && typeof ctx.contextActivities === 'object') {
      for (const k of ['parent', 'grouping', 'category', 'other']) {
        const arr = (ctx.contextActivities as Record<string, unknown>)[k];
        if (Array.isArray(arr)) arr.forEach(reduceActivityDef);
      }
    }
  };
  canonicalizeNode(out);
  return out;
}

function applyFormat(stmt: Record<string, unknown>, format: string, langs: string[]): Record<string, unknown> {
  if (format === 'ids') return toIdsFormat(stmt);
  if (format === 'canonical') return toCanonicalFormat(stmt, langs);
  return stmt;
}

function acceptLanguages(req: Request): string[] {
  const h = req.headers['accept-language'];
  if (typeof h !== 'string' || !h) return ['en-US', 'en'];
  return h.split(',').map(s => s.split(';')[0]!.trim()).filter(Boolean);
}

// ── /xapi/statements GET ────────────────────────────────────────────

async function handleGetStatements(req: Request, res: Response): Promise<void> {
  if (rejectUnknownParams(req, res, STATEMENTS_GET_PARAMS)) return;

  const statementId = req.query.statementId as string | undefined;
  const voidedStatementId = req.query.voidedStatementId as string | undefined;
  const format = (req.query.format as string | undefined) ?? 'exact';
  if (!['ids', 'exact', 'canonical'].includes(format)) {
    res.status(400).json({ error: 'format must be one of: ids, exact, canonical' });
    return;
  }

  // §4.2.3: statementId / voidedStatementId are mutually exclusive and
  // cannot be combined with any filtering parameter.
  if (statementId !== undefined && voidedStatementId !== undefined) {
    res.status(400).json({ error: 'statementId and voidedStatementId must not be used together' });
    return;
  }
  if (statementId !== undefined || voidedStatementId !== undefined) {
    const forbidden = ['agent', 'verb', 'activity', 'registration', 'related_activities',
      'related_agents', 'since', 'until', 'limit', 'ascending', 'cursor', 'continuationToken'];
    const conflict = forbidden.filter(p => req.query[p] !== undefined);
    if (conflict.length > 0) {
      res.status(400).json({ error: `statementId/voidedStatementId cannot be combined with: ${conflict.join(', ')}` });
      return;
    }
  }

  const langs = acceptLanguages(req);
  const wantAttachments = (req.query.attachments as string | undefined) === 'true';
  const tenant = tenantOf(req);
  const store = statementStores.for(tenant);
  const attachStore = attachmentStores.for(tenant);

  if (statementId !== undefined) {
    if (!isUuid(statementId)) { res.status(400).json({ error: 'statementId must be a UUID' }); return; }
    const rec = await store.get(statementId);
    if (!rec || rec.voided) { res.status(404).json({ error: 'statement not found or voided' }); return; }
    res.setHeader('Last-Modified', new Date(rec.stored).toUTCString());
    sendStatementsResponse(res, applyFormat(rec.statement, format, langs), [rec.statement], wantAttachments, attachStore);
    return;
  }
  if (voidedStatementId !== undefined) {
    if (!isUuid(voidedStatementId)) { res.status(400).json({ error: 'voidedStatementId must be a UUID' }); return; }
    const rec = await store.get(voidedStatementId);
    if (!rec || !rec.voided) { res.status(404).json({ error: 'statement not voided (use ?statementId= for non-voided)' }); return; }
    res.setHeader('Last-Modified', new Date(rec.stored).toUTCString());
    sendStatementsResponse(res, applyFormat(rec.statement, format, langs), [rec.statement], wantAttachments, attachStore);
    return;
  }

  const limitRaw = req.query.limit;
  if (limitRaw !== undefined && (Number.isNaN(Number(limitRaw)) || Number(limitRaw) < 0)) {
    res.status(400).json({ error: 'limit must be a non-negative integer' });
    return;
  }
  let agent: Record<string, unknown> | undefined;
  const agentFilterRaw = req.query.agent as string | undefined;
  if (agentFilterRaw) {
    try { agent = JSON.parse(agentFilterRaw) as Record<string, unknown>; }
    catch { res.status(400).json({ error: 'agent filter must be a JSON-encoded Agent object (§4.2)' }); return; }
  }

  const filter = {
    agent,
    verb: req.query.verb as string | undefined,
    activity: req.query.activity as string | undefined,
    registration: req.query.registration as string | undefined,
    since: req.query.since as string | undefined,
    until: req.query.until as string | undefined,
    ascending: (req.query.ascending as string | undefined) === 'true',
    limit: limitRaw !== undefined ? Number(limitRaw) : 100,
    cursor: (req.query.continuationToken as string | undefined) ?? (req.query.cursor as string | undefined),
  };
  const result = await store.query(filter);

  // §2.1.4: a query that would match a voided Statement still surfaces
  // the Voiding Statement that voided it, so the requester sees the void.
  let recs = [...result.statements];
  const includedIds = new Set(recs.map(r => r.id));
  const all = await store.listAll();
  for (const r of all) {
    if (!r.voided || !r.voidingStatementId || !matchesFilter(r, filter)) continue;
    if (includedIds.has(r.voidingStatementId)) continue;
    const voiding = await store.get(r.voidingStatementId);
    if (voiding) { recs.push(voiding); includedIds.add(voiding.id); }
  }

  // Consistent-Through honesty for DERIVED-VIEW (lens) tenants: these are
  // in-memory, re-projectable caches of the agent's own pod — not a durable
  // system of record. Advertise the horizon actually materialized (the newest
  // stored statement), never the gate's "now", so a consumer can't mistake a
  // freshly-restarted / partly-rebuilt view for a durable LRS. Durable backends
  // (the certified DEFAULT/customer LRS) keep now().
  if (isDerivedViewTenant(String(tenant))) {
    const horizon = all.reduce((m, r) => (r.stored > m ? r.stored : m), '1970-01-01T00:00:00.000Z');
    res.setHeader('X-Experience-API-Consistent-Through', horizon);
  }
  // The `limit` parameter caps the *whole* result, including any Voiding
  // Statements surfaced above.
  if (filter.limit && filter.limit > 0 && recs.length > filter.limit) {
    recs = recs.slice(0, filter.limit);
  }

  const moreUrl = result.more
    ? `/xapi/statements?continuationToken=${encodeURIComponent(result.more)}`
    : '';
  sendStatementsResponse(
    res,
    { statements: recs.map(r => applyFormat(r.statement, format, langs)), more: moreUrl },
    recs.map(r => r.statement),
    wantAttachments,
    attachStore,
  );
}

/**
 * Send a Statement / StatementResult response. With `?attachments=true`
 * (§4.2.3) the response is `multipart/mixed`: the first part is the JSON,
 * followed by one binary part per attachment whose raw data the LRS
 * holds. Otherwise it is plain `application/json`.
 */
function sendStatementsResponse(
  res: Response,
  payload: Record<string, unknown>,
  statements: Record<string, unknown>[],
  wantAttachments: boolean,
  attachStore: Map<string, { data: Buffer; contentType: string }>,
): void {
  if (!wantAttachments) { res.status(200).json(payload); return; }
  const boundary = `foxxi-${randomUUID()}`;
  const chunks: Buffer[] = [];
  const text = (s: string): void => { chunks.push(Buffer.from(s, 'utf8')); };
  text(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`);
  text(JSON.stringify(payload));
  text('\r\n');
  const emitted = new Set<string>();
  for (const sha2 of collectAttachmentHashes(statements)) {
    const data = attachStore.get(sha2);
    if (!data || emitted.has(sha2)) continue;
    emitted.add(sha2);
    text(`--${boundary}\r\nContent-Type: ${data.contentType}\r\n`
      + `Content-Transfer-Encoding: binary\r\nX-Experience-API-Hash: ${sha2}\r\n\r\n`);
    chunks.push(data.data);
    text('\r\n');
  }
  text(`--${boundary}--\r\n`);
  res.status(200)
    .setHeader('Content-Type', `multipart/mixed; boundary=${boundary}`);
  res.send(Buffer.concat(chunks));
}

// ── /xapi/about ─────────────────────────────────────────────────────

function handleAbout(req: Request, res: Response, config: XapiLrsConfig): void {
  const ns = FOXXI_NS;
  res.json({
    version: ABOUT_VERSIONS,
    extensions: {
      [`${ns}identity`]: config.tenantDid,
      [`${ns}bridge`]: config.selfBaseUrl,
      [`${ns}pod`]: config.podUrl,
      [`${ns}statementForwarding`]: !!config.forwardingTargets.trim(),
      [`${ns}substrateBackend`]: 'context-graphs-1.0 + solid-css',
      [`${ns}lrsBackend`]: statementStores.for(tenantOf(req)).backendDescription(),
      [`${ns}multiTenant`]: true,
      [`${ns}xapiProfile`]: `${config.selfBaseUrl}/xapi/profile`,
      // The IEEE-LER + ADL-TLA emergent composable semantic layer —
      // dereferenceable ontologies the substrate serves.
      [`${ns}ieeeLerOntology`]: `${config.selfBaseUrl}/ns/ieee-ler`,
      [`${ns}adlTlaOntology`]: `${config.selfBaseUrl}/ns/adl-tla`,
    },
  });
}

// ── State / profile document resources ──────────────────────────────

type DocKind = 'state' | 'activityProfile' | 'agentProfile';

function stateKey(activityId: string, agent: string, stateId: string, registration?: string): string {
  return `${activityId}::${agent}::${stateId}::${registration ?? ''}`;
}
function profileKey(iri: string, profileId: string): string {
  return `${iri}::${profileId}`;
}

/** Coerce the stored request body to a Buffer-or-object document value. */
function readDocBody(req: Request): { value: unknown; contentType: string } {
  const contentType = (req.headers['content-type'] as string | undefined) ?? 'application/octet-stream';
  return { value: req.body, contentType };
}

/**
 * Generic handler for the three document resources. Enforces the
 * required-parameter rules (missing → 400), `agent` JSON validity,
 * optimistic concurrency, JSON-document merge on POST, and HEAD.
 */
function handleDocResource(
  kind: DocKind,
  resourceStore: Map<string, StoredDoc>,
  req: Request,
  res: Response,
): void {
  const q = req.query as Record<string, string>;
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  // ── Required-parameter validation (xAPI §4.2.4 / §4.2.5 / §4.2.6) ──
  const needsActivityId = kind === 'state' || kind === 'activityProfile';
  const needsAgent = kind === 'state' || kind === 'agentProfile';
  if (needsActivityId && !q.activityId) {
    res.status(400).json({ error: '"activityId" is a required parameter' });
    return;
  }
  let agentObj: Record<string, unknown> | undefined;
  if (needsAgent) {
    if (q.agent === undefined) {
      res.status(400).json({ error: '"agent" is a required parameter' });
      return;
    }
    try {
      agentObj = JSON.parse(q.agent) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: '"agent" must be a JSON-encoded Agent object' });
      return;
    }
    if (!agentObj || typeof agentObj !== 'object' || Array.isArray(agentObj)) {
      res.status(400).json({ error: '"agent" must be a JSON-encoded Agent object' });
      return;
    }
  }
  if (q.registration !== undefined && !isUuid(q.registration)) {
    res.status(400).json({ error: '"registration" must be a UUID' });
    return;
  }
  // §4.2.x: `since` (multi-document GET) MUST be an ISO 8601 timestamp.
  if (q.since !== undefined && !isIsoTimestamp(q.since)) {
    res.status(400).json({ error: '"since" must be an ISO 8601 timestamp' });
    return;
  }

  const docIdParam = kind === 'state' ? 'stateId' : 'profileId';
  const docId = kind === 'state' ? q.stateId : q.profileId;

  // PUT / POST require the document id.
  if ((method === 'PUT' || method === 'POST') && !docId) {
    res.status(400).json({ error: `"${docIdParam}" is a required parameter for ${method}` });
    return;
  }
  // Only the State Resource supports a scoped (no docId) bulk DELETE;
  // the Profile resources require an explicit profileId on DELETE.
  if (method === 'DELETE' && !docId && kind !== 'state') {
    res.status(400).json({ error: `"${docIdParam}" is a required parameter for DELETE` });
    return;
  }

  const key = kind === 'state'
    ? stateKey(q.activityId ?? '', q.agent ?? '', q.stateId ?? '', q.registration)
    : profileKey((kind === 'activityProfile' ? q.activityId : q.agent) ?? '', q.profileId ?? '');
  // The scope a multi-document GET / bulk DELETE applies to — every key
  // under it shares this prefix followed by "::<docId>...".
  const scopePrefix = kind === 'state'
    ? `${q.activityId ?? ''}::${q.agent ?? ''}`
    : `${(kind === 'activityProfile' ? q.activityId : q.agent) ?? ''}`;

  // ── GET / HEAD ──────────────────────────────────────────────────
  if (method === 'GET') {
    if (!docId) {
      // Multiple-document GET — return the array of document ids in scope.
      const since = q.since ? Date.parse(q.since) : NaN;
      const ids = [...resourceStore.entries()]
        .filter(([k]) => k.startsWith(`${scopePrefix}::`))
        .filter(([, v]) => Number.isNaN(since) || Date.parse(v.updated) > since)
        .map(([k]) => k.slice(scopePrefix.length + 2).split('::')[0]);
      res.status(200).json(ids);
      return;
    }
    const v = resourceStore.get(key);
    if (!v) { res.status(404).end(); return; }
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    if (ifNoneMatch && (ifNoneMatch === v.etag || ifNoneMatch === '*')) {
      res.status(304).setHeader('ETag', v.etag).end();
      return;
    }
    res.setHeader('ETag', v.etag);
    res.setHeader('Last-Modified', new Date(v.updated).toUTCString());
    res.setHeader('Content-Type', v.contentType);
    if (req.method === 'HEAD') { res.status(200).end(); return; }
    res.status(200).send(v.content);
    return;
  }

  // ── PUT / POST ──────────────────────────────────────────────────
  if (method === 'PUT' || method === 'POST') {
    const existing = resourceStore.get(key);
    const ifMatch = req.headers['if-match'] as string | undefined;
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    // §4.1.4 concurrency: a PUT that would overwrite an existing document
    // without a precondition is rejected 409 (lost-update guard). A POST
    // is a document *merge* and is exempt — it never needs a precondition.
    if (method === 'PUT' && existing && !ifMatch && !ifNoneMatch) {
      // Plain-text body: the xAPI conformance suite asserts the 409 response has a
      // non-empty `text` (raw string) explaining the situation — superagent only
      // populates res.text for non-JSON responses, so this MUST NOT be JSON.
      res.status(409).type('text/plain').send('Conflict: a document already exists at this resource. Supply If-Match (to replace) or If-None-Match (to guard) on the PUT, per xAPI §6.3 concurrency.');
      return;
    }
    if (ifMatch && (!existing || existing.etag !== ifMatch)) {
      res.status(412).json({ error: 'If-Match precondition failed' });
      return;
    }
    if (ifNoneMatch === '*' && existing) {
      res.status(412).json({ error: 'If-None-Match: * precondition failed — document exists' });
      return;
    }

    const { value, contentType } = readDocBody(req);
    let stored: unknown = value;
    let storedCt = contentType;

    if (method === 'POST' && existing) {
      // §4.2.x: POST merges JSON documents; if either side is non-JSON
      // the merge is impossible and the LRS MUST respond 400.
      const newIsJson = contentType.toLowerCase().includes('application/json');
      const oldIsJson = existing.contentType.toLowerCase().includes('application/json');
      if (!newIsJson || !oldIsJson) {
        res.status(400).json({ error: 'POST can only update a document when both the stored and the new document are application/json' });
        return;
      }
      if (!isPlainObject(existing.content) || !isPlainObject(value)) {
        res.status(400).json({ error: 'POST merge requires both documents to be JSON objects' });
        return;
      }
      stored = { ...(existing.content as Record<string, unknown>), ...(value as Record<string, unknown>) };
      storedCt = 'application/json';
    }

    // Strong, content-addressed ETag: a 40-hex SHA-1 of the stored body enclosed
    // in double quotes. The xAPI conformance suite asserts the quoted form
    // (etag[0] === '"' and etag[41] === '"'), which requires exactly 40 chars
    // between the quotes — a UUID (36) is too short. SHA-1 also makes the ETag
    // change iff the content changes (correct concurrency semantics).
    const etagBody = typeof stored === 'string' ? stored : JSON.stringify(stored);
    const etag = `"${createHash('sha1').update(etagBody).digest('hex')}"`;
    cappedMapSet(resourceStore, key, { content: stored, etag, updated: nowIso(), contentType: storedCt });
    xapiDocsPodDirty();
    res.setHeader('ETag', etag);
    res.status(204).end();
    return;
  }

  // ── DELETE ──────────────────────────────────────────────────────
  if (method === 'DELETE') {
    if (docId) {
      const existing = resourceStore.get(key);
      const ifMatch = req.headers['if-match'] as string | undefined;
      if (ifMatch && (!existing || existing.etag !== ifMatch)) {
        res.status(412).json({ error: 'If-Match precondition failed' });
        return;
      }
      resourceStore.delete(key);
    } else {
      for (const k of Array.from(resourceStore.keys())) {
        if (k.startsWith(`${scopePrefix}::`)) resourceStore.delete(k);
      }
    }
    xapiDocsPodDirty();
    res.status(204).end();
    return;
  }

  res.status(405).end();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
}

// ── Statement forwarding ────────────────────────────────────────────
// Outbound forwarding moved to the runtime-managed registry in
// ./lrs-forwarding.ts (per-target delivery metrics + dead-letter + retry,
// surfaced through the LRS-admin API). The POST/PUT handlers call
// forwardToTargets(tenant, stmt); the env value FOXXI_LRS_FORWARDING_TARGETS
// seeds the default tenant's registry in attachXapiLrsRoutes().

// ── xAPI Profile Server ─────────────────────────────────────────────

import { buildFoxxiProfileDoc } from './xapi-profile.js';
import { FOXXI_NS } from './foxxi-vocab.js';
/** xAPI Profile Version objects MUST be immutable — a fixed authoring timestamp for
 *  /v/1, NOT the live clock (which made generatedAtTime change on every fetch). A real
 *  revision appends /v/2 with wasRevisionOf rather than mutating this. */
const PROFILE_GENERATED_AT = '2026-07-22T00:00:00.000Z';

let _profileCache: { url: string; doc: Record<string, unknown>; fetchedAt: number } | null = null;
async function fetchExternalProfile(url: string): Promise<Record<string, unknown> | null> {
  if (_profileCache && _profileCache.url === url && Date.now() - _profileCache.fetchedAt < 5 * 60 * 1000) {
    return _profileCache.doc;
  }
  try {
    // Transient-network retry: external xAPI Profile registries (e.g.,
    // profiles.adlnet.gov mirrors) occasionally return 5xx or drop the
    // connection. withTransientRetry only retries those classes; 404 /
    // non-OK responses surface immediately so the caller can fall back
    // to the bundled local profile doc.
    const r = await withTransientRetry(async () => {
      const resp = await fetch(url, { headers: { Accept: 'application/ld+json, application/json' } });
      if (resp.status >= 500) {
        throw new Error(`profile fetch failed: ${resp.status} ${resp.statusText}`);
      }
      return resp;
    });
    if (!r.ok) return null;
    const doc = await r.json() as Record<string, unknown>;
    _profileCache = { url, doc, fetchedAt: Date.now() };
    return doc;
  } catch { return null; }
}

async function buildFoxxiXapiProfile(_config: XapiLrsConfig): Promise<Record<string, unknown>> {
  const override = process.env.FOXXI_XAPI_PROFILE_URL;
  if (override) {
    const ext = await fetchExternalProfile(override);
    if (ext) return ext;
  }
  return buildFoxxiProfileDoc({ generatedAt: PROFILE_GENERATED_AT });
}

// ── Route attachment ────────────────────────────────────────────────

export function attachXapiLrsRoutes(app: Express, config: XapiLrsConfig): void {
  // Seed the default tenant's outbound forwarding registry from env so
  // existing FOXXI_LRS_FORWARDING_TARGETS deployments keep their targets;
  // operators then manage them at runtime through /xapi/admin/forwarding/*.
  seedForwardingTargets(DEFAULT_TENANT, config.forwardingTargets);
  const gate = makeAuthGate(config);

  // Raw-body parser for multipart/mixed Statement requests — the global
  // express.json() middleware skips non-JSON content types, so the
  // stream is intact for this parser to read.
  const rawMultipart = express.raw({
    type: (req) => ((req.headers['content-type'] as string | undefined) ?? '').toLowerCase().startsWith('multipart/'),
    limit: '50mb',
  });
  // Raw-body parser for non-JSON State/Profile documents. JSON documents
  // are left to the already-parsed req.body object.
  const rawDoc = express.raw({
    type: (req) => !(((req.headers['content-type'] as string | undefined) ?? '').toLowerCase().includes('application/json')),
    limit: '50mb',
  });

  // The About Resource is unauthenticated and exempt from the
  // X-Experience-API-Version requirement (§3.3) — a client hits it
  // *first* to discover which versions the LRS supports.
  app.get('/xapi/about', (req, res) => {
    setXapiHeaders(res, '2.0.0');
    handleAbout(req, res, config);
  });

  // xAPI Profile Server — public (no auth) so other tools can discover
  // what vocabulary Foxxi emits. The profile's `id` IS this URL.
  app.get('/xapi/profile', (_req, res) => { void (async () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const doc = await buildFoxxiXapiProfile(config);
    res.type('application/ld+json').json(doc);
  })(); });

  for (const kind of ['templates', 'patterns', 'v'] as const) {
    app.get(`/xapi/profile/${kind}/:name`, (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const doc = buildFoxxiProfileDoc({ generatedAt: PROFILE_GENERATED_AT });
      const list = (kind === 'v' ? doc.versions : doc[kind]) as Array<Record<string, unknown>> | undefined;
      const suffix = `/${kind}/${req.params.name}`;
      const found = (list ?? []).find(x => typeof x.id === 'string' && (x.id as string).endsWith(suffix));
      if (!found) {
        res.status(404).type('application/ld+json')
          .json({ error: `no ${kind} resource "${req.params.name}" in the Foxxi xAPI Profile` });
        return;
      }
      res.type('application/ld+json').json({
        '@context': 'https://w3id.org/xapi/profiles/context',
        ...found,
        _links: { self: { href: found.id }, profile: { href: `${config.selfBaseUrl}/xapi/profile` } },
      });
    });
  }

  // Statements resource.
  app.post('/xapi/statements', gate, rawMultipart, (req, res) => { void handlePostStatements(req, res, config); });
  app.put('/xapi/statements', gate, rawMultipart, (req, res) => { void handlePutStatement(req, res, config); });
  app.get('/xapi/statements', gate, (req, res) => { void handleGetStatements(req, res); });

  // Activities + Agents inspection helpers.
  app.get('/xapi/activities', gate, (req, res) => { void (async () => {
    if (rejectUnknownParams(req, res, ['activityId'])) return;
    const id = req.query.activityId as string | undefined;
    if (!id) { res.status(400).json({ error: '"activityId" is a required parameter' }); return; }
    // §7.5: return the merged Activity Object — every definition seen in
    // any Statement about this Activity, combined.
    const all = await statementStores.for(tenantOf(req)).listAll();
    const merged: Record<string, unknown> = { objectType: 'Activity', id };
    const mergedDef: Record<string, unknown> = {};
    const collect = (o: unknown): void => {
      if (!o || typeof o !== 'object') return;
      const obj = o as Record<string, unknown>;
      if (obj.id === id && obj.definition && typeof obj.definition === 'object') {
        // §7.5: deep-merge so multi-language `name` / `description` maps
        // from different Statements are combined, not overwritten.
        for (const [k, v] of Object.entries(obj.definition as Record<string, unknown>)) {
          const prior = mergedDef[k];
          if ((k === 'name' || k === 'description' || k === 'extensions')
            && prior && typeof prior === 'object' && !Array.isArray(prior)
            && v && typeof v === 'object' && !Array.isArray(v)) {
            mergedDef[k] = { ...(prior as Record<string, unknown>), ...(v as Record<string, unknown>) };
          } else {
            mergedDef[k] = v;
          }
        }
      }
    };
    for (const r of all) {
      collect(r.statement.object);
      const ctx = r.statement.context as { contextActivities?: Record<string, unknown[]> } | undefined;
      if (ctx?.contextActivities) {
        for (const arr of Object.values(ctx.contextActivities)) {
          if (Array.isArray(arr)) arr.forEach(collect);
        }
      }
    }
    if (Object.keys(mergedDef).length > 0) merged.definition = mergedDef;
    res.status(200).json(merged);
  })(); });

  app.get('/xapi/agents', gate, (req, res) => { void (async () => {
    if (rejectUnknownParams(req, res, ['agent'])) return;
    const agentJson = req.query.agent as string | undefined;
    if (!agentJson) { res.status(400).json({ error: '"agent" is a required parameter' }); return; }
    let agent: Record<string, unknown>;
    try { agent = JSON.parse(agentJson) as Record<string, unknown>; }
    catch { res.status(400).json({ error: '"agent" must be a JSON-encoded Agent object' }); return; }
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
      res.status(400).json({ error: '"agent" must be a JSON-encoded Agent object' });
      return;
    }
    // §7.6: the `agent` parameter MUST be a structurally valid Agent/Group.
    const agentErrs = validateAgentObject(agent);
    if (agentErrs.length > 0) {
      res.status(400).json({ error: '"agent" is not a structurally valid Agent', violations: agentErrs });
      return;
    }
    const names = new Set<string>();
    const mboxes = new Set<string>();
    const mboxSha = new Set<string>();
    const openids = new Set<string>();
    const accounts: Array<{ name: string; homePage: string }> = [];
    const all = await statementStores.for(tenantOf(req)).listAll();
    const matches = (ac: Record<string, unknown> | undefined): boolean => {
      if (!ac) return false;
      if (agent.mbox && ac.mbox === agent.mbox) return true;
      if (agent.mbox_sha1sum && ac.mbox_sha1sum === agent.mbox_sha1sum) return true;
      if (agent.openid && ac.openid === agent.openid) return true;
      const aAcc = agent.account as { name?: string; homePage?: string } | undefined;
      const cAcc = ac.account as { name?: string; homePage?: string } | undefined;
      if (aAcc && cAcc && aAcc.name === cAcc.name && aAcc.homePage === cAcc.homePage) return true;
      return false;
    };
    for (const r of all) {
      const ac = r.statement.actor as Record<string, unknown> | undefined;
      if (!matches(ac)) continue;
      if (typeof ac!.name === 'string') names.add(ac!.name);
      if (typeof ac!.mbox === 'string') mboxes.add(ac!.mbox);
      if (typeof ac!.mbox_sha1sum === 'string') mboxSha.add(ac!.mbox_sha1sum);
      if (typeof ac!.openid === 'string') openids.add(ac!.openid);
      if (ac!.account) accounts.push(ac!.account as { name: string; homePage: string });
    }
    // §7.6: a Person Object — every identifying property is an ARRAY.
    const person: Record<string, unknown> = { objectType: 'Person' };
    if (names.size) person.name = [...names];
    if (mboxes.size) person.mbox = [...mboxes];
    if (mboxSha.size) person.mbox_sha1sum = [...mboxSha];
    if (openids.size) person.openid = [...openids];
    if (accounts.length) person.account = accounts;
    res.status(200).json(person);
  })(); });

  // State + profile document resources — GET/PUT/POST/DELETE/HEAD.
  // Each resource's store is tenant-partitioned; the per-request store
  // is resolved from the gated request's tenant.
  const docResources: Array<[string, DocKind, TenantPartition<Map<string, StoredDoc>>]> = [
    ['/xapi/activities/state', 'state', stateStores],
    ['/xapi/activities/profile', 'activityProfile', activityProfileStores],
    ['/xapi/agents/profile', 'agentProfile', agentProfileStores],
  ];
  for (const [path, kind, docStores] of docResources) {
    const allowed = kind === 'state' ? STATE_PARAMS
      : kind === 'activityProfile' ? ACTIVITY_PROFILE_PARAMS : AGENT_PROFILE_PARAMS;
    const paramGate = (req: Request, res: Response, next: NextFunction): void => {
      if (rejectUnknownParams(req, res, allowed)) return;
      next();
    };
    const handle = (req: Request, res: Response): void =>
      handleDocResource(kind, docStores.for(tenantOf(req)), req, res);
    app.get(path, gate, paramGate, handle);
    app.head(path, gate, paramGate, handle);
    app.put(path, gate, paramGate, rawDoc, handle);
    app.post(path, gate, paramGate, rawDoc, handle);
    app.delete(path, gate, paramGate, handle);
  }

  // Error handler — a malformed JSON body reaches here from the global
  // express.json() parser. For xAPI resources, answer with a conformant
  // 400 (and the version header); everything else passes through.
  app.use((err: Error & { status?: number; type?: string }, req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/xapi/')) { next(err); return; }
    if (res.headersSent) { next(err); return; }
    setXapiHeaders(res, negotiateVersion(req));
    const isParse = err.type === 'entity.parse.failed' || err instanceof SyntaxError;
    res.status(isParse ? 400 : (err.status ?? 500)).json({
      error: isParse ? 'request body is not valid JSON' : (err.message || 'internal error'),
    });
  });
}
