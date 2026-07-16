/**
 * LRS-admin endpoints — feed the LRS dashboard tab without forcing the
 * frontend through the canonical xAPI query interface (which is
 * scoped to learning records, not LRS-operator concerns like
 * aggregates, top verbs, or storage stats).
 *
 *   GET /xapi/admin/statements       Paginated, filterable browser feed
 *   GET /xapi/admin/aggregates       Top-N verbs / activities / agents
 *                                    + hourly statement rate histogram
 *   GET /xapi/admin/conformance      Foxxi profile id, version, statement
 *                                    counts, schema validity rates
 *   GET /xapi/admin/config           Current LRS config (basic-auth keys,
 *                                    forwarding targets, retention)
 *
 * All routes are gated by the bridge's existing session-token auth; the
 * handlers themselves additionally check for admin / learning-engineer
 * role so a regular learner can't read other learners' statements.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { listStoredStatements, statementStoreTenants } from './xapi-lrs.js';
import { DEFAULT_TENANT, type TenantId } from './tenant-context.js';
import { FOXXI_PROFILE_ID } from './xapi-profile.js';
import { verifySessionToken, buildAddressMap } from './auth.js';
import { PERF_EXT } from './learner-record.js';
import {
  listForwardingTargets, addForwardingTarget, updateForwardingTarget,
  deleteForwardingTarget, retryDeadLetter, deadLetterFor,
  inboundCredentials, listInboundReceipts,
} from './lrs-forwarding.js';

interface AdminConfig {
  adminWebId: string;
  learningEngineerWebIds: ReadonlySet<string>;
  selfBaseUrl: string;
  basicAuthPairs: string;
  forwardingTargets: string;
  /** Published directory users (with wallet_address) for session-token signature verification. */
  loadUsers?: () => ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }>;
}

function bearerOf(req: Request): string | null {
  const header = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

function makeAdminGate(config: AdminConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = bearerOf(req);
    if (!token) {
      res.status(401).json({ error: 'session token required' });
      return;
    }
    // Full ECDSA verification against the published directory's
    // wallet_address map — not a forgeable sub-claim decode.
    const verified = verifySessionToken(token, buildAddressMap(config.loadUsers?.() ?? []));
    if (!verified.ok) {
      res.status(401).json({ error: `session token rejected: ${verified.reason}` });
      return;
    }
    const sub = verified.callerDid;
    const isAdmin = sub === config.adminWebId;
    const isLe = config.learningEngineerWebIds.has(sub);
    if (!isAdmin && !isLe) {
      res.status(403).json({ error: 'LRS-admin endpoints require admin or learning-engineer role' });
      return;
    }
    (req as Request & { adminSub: string; adminRole: 'admin' | 'learning-engineer' }).adminSub = sub;
    (req as Request & { adminSub: string; adminRole: 'admin' | 'learning-engineer' }).adminRole = isAdmin ? 'admin' : 'learning-engineer';
    next();
  };
}

// ── Handlers ────────────────────────────────────────────────────────

/**
 * Which tenant's statement store an admin request reads. ADMINS may browse
 * any tenant via `?tenant=` (e.g. `agent-mesh`, the isolated tenant the
 * agent-activity projector lands in); learning-engineers stay scoped to
 * DEFAULT_TENANT so they cannot read across tenants. Absent the param, the
 * default tenant — byte-identical to the prior single-tenant behavior.
 */
function resolveAdminTenant(req: Request): TenantId {
  const role = (req as Request & { adminRole?: string }).adminRole;
  const requested = (req.query.tenant as string | undefined)?.trim();
  if (role === 'admin' && requested) return requested as TenantId;
  return DEFAULT_TENANT;
}

async function handleStatementsAdmin(req: Request, res: Response): Promise<void> {
  const tenant = resolveAdminTenant(req);
  const all = await listStoredStatements(tenant);
  const verbFilter = req.query.verb as string | undefined;
  const actorFilter = req.query.actor as string | undefined;
  const sinceParam = req.query.since as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Number(req.query.offset) || 0;

  let filtered = all;
  if (verbFilter) {
    filtered = filtered.filter(r => (r.statement.verb as { id?: string } | undefined)?.id === verbFilter);
  }
  if (actorFilter) {
    filtered = filtered.filter(r => {
      const a = r.statement.actor as { account?: { name?: string }; mbox?: string } | undefined;
      return a?.account?.name === actorFilter || a?.mbox === actorFilter || a?.account?.name?.includes(actorFilter);
    });
  }
  if (sinceParam) {
    const t = Date.parse(sinceParam);
    filtered = filtered.filter(r => Date.parse(r.stored) > t);
  }
  filtered.sort((a, b) => b.stored.localeCompare(a.stored));
  const page = filtered.slice(offset, offset + limit);
  res.json({
    tenant: String(tenant),
    total: filtered.length,
    page: page.map(r => ({
      id: r.id,
      stored: r.stored,
      // real performed-at time (mesh projector now resolves it from the
      // descriptor's own millis); falls back to stored when the envelope has none.
      timestamp: (r.statement as { timestamp?: string }).timestamp ?? null,
      voided: r.voided,
      actor: r.statement.actor,
      verb: r.statement.verb,
      object: r.statement.object,
      result: r.statement.result,
      context: r.statement.context,
    })),
    limit, offset,
  });
}

async function handleAggregates(req: Request, res: Response): Promise<void> {
  const tenant = resolveAdminTenant(req);
  const all = await listStoredStatements(tenant);

  const verbCounts = new Map<string, { display: string; count: number }>();
  const activityCounts = new Map<string, { name?: string; count: number }>();
  const actorCounts = new Map<string, { name?: string; count: number }>();
  const errorCount = { total: 0 };
  const hourBuckets = new Map<string, number>();
  // GAP 4 — direction (actorKind: human|agent) + context (contextKind:
  // production|training|support) are now varied at emission, so they are
  // first-class queryable splits rather than constant dimensions.
  const actorKindCounts = new Map<string, number>();
  const contextKindCounts = new Map<string, number>();

  for (const r of all) {
    const verb = r.statement.verb as { id?: string; display?: Record<string, string> } | undefined;
    if (verb?.id) {
      const display = verb.display?.en ?? verb.id.split('/').pop() ?? verb.id;
      const cur = verbCounts.get(verb.id) ?? { display, count: 0 };
      cur.count++;
      verbCounts.set(verb.id, cur);
    }
    const obj = r.statement.object as { id?: string; definition?: { name?: Record<string, string> } } | undefined;
    if (obj?.id) {
      const name = obj.definition?.name?.en;
      const cur = activityCounts.get(obj.id) ?? { name, count: 0 };
      cur.count++;
      activityCounts.set(obj.id, cur);
    }
    const actor = r.statement.actor as { name?: string; account?: { name?: string } } | undefined;
    const actorKey = actor?.account?.name ?? actor?.name ?? 'unknown';
    const cur = actorCounts.get(actorKey) ?? { name: actor?.name, count: 0 };
    cur.count++;
    actorCounts.set(actorKey, cur);

    const result = r.statement.result as { success?: boolean } | undefined;
    if (result && result.success === false) errorCount.total++;

    // Direction + context-kind splits (GAP 4) — read from the context extensions.
    const ext = (r.statement.context as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    const ak = ext?.[PERF_EXT.actorKind];
    if (typeof ak === 'string') actorKindCounts.set(ak, (actorKindCounts.get(ak) ?? 0) + 1);
    const ck = ext?.[PERF_EXT.contextKind];
    if (typeof ck === 'string') contextKindCounts.set(ck, (contextKindCounts.get(ck) ?? 0) + 1);

    // Bucket by the REAL event time when present (GAP 2), not the projection
    // write-instant — so the hourly histogram reflects when work happened.
    const when = (r.statement.timestamp as string | undefined) ?? r.stored;
    const hour = when.slice(0, 13) + ':00:00Z';
    hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
  }

  const topN = <T>(m: Map<string, T & { count: number }>, n: number): Array<T & { id: string }> => {
    return [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([id, v]) => ({ id, ...v }));
  };

  res.json({
    tenant: String(tenant),
    total: all.length,
    errors: errorCount.total,
    successRate: all.length > 0 ? 1 - (errorCount.total / all.length) : 1,
    topVerbs: topN(verbCounts, 10),
    topActivities: topN(activityCounts, 10),
    topActors: topN(actorCounts, 10),
    byActorKind: [...actorKindCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    byContextKind: [...contextKindCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    hourlyVolume: [...hourBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  });
}

/** xAPI 2.0 / cmi5 core verbs — external, dereference to adlnet.gov. */
const ADL_CORE_VERBS = [
  'launched', 'initialized', 'experienced', 'completed', 'passed', 'failed',
  'satisfied', 'terminated', 'abandoned', 'waived', 'voided',
].map(v => `http://adlnet.gov/expapi/verbs/${v}`);

/**
 * The Foxxi verb set, obtained by ACTUALLY DEREFERENCING the vocabulary
 * — a runtime GET of `<bridge>/ns/foxxi`, not a hardcoded list. This is
 * the production code path that proves the namespace is live linked
 * data: every Conformance read re-grounds itself against the served
 * vocabulary. Cached briefly so the tab is not a fetch storm.
 */
let _foxxiVerbCache: { verbs: string[]; at: number } | null = null;
const FOXXI_VERB_TTL_MS = 5 * 60_000;

async function dereferenceFoxxiVerbs(vocabUrl: string): Promise<{ verbs: string[]; dereferenced: boolean }> {
  if (_foxxiVerbCache && Date.now() - _foxxiVerbCache.at < FOXXI_VERB_TTL_MS) {
    return { verbs: _foxxiVerbCache.verbs, dereferenced: true };
  }
  try {
    const r = await fetch(vocabUrl, { headers: { Accept: 'application/ld+json' } });
    if (!r.ok) throw new Error(`vocab HTTP ${r.status}`);
    const doc = await r.json() as { terms?: Array<{ '@id'?: string; '@type'?: string }> };
    const verbs = (doc.terms ?? [])
      .filter(t => typeof t['@type'] === 'string' && t['@type']!.endsWith('Verb') && typeof t['@id'] === 'string')
      .map(t => t['@id'] as string);
    _foxxiVerbCache = { verbs, at: Date.now() };
    return { verbs, dereferenced: true };
  } catch {
    // The vocabulary did not dereference — report that honestly rather
    // than silently substituting a guess. A 0% in-profile rate with
    // vocabularyDereferenced=false is a true signal something is wrong.
    return { verbs: [], dereferenced: false };
  }
}

/**
 * Dereference the IEEE-LER + ADL-TLA semantic layer — a runtime GET of
 * the two ontologies the bridge serves. This is the production code path
 * that proves the layer is live, dereferenceable linked data: the
 * conformance surface re-grounds itself against the served ontologies on
 * every read. Cached briefly.
 */
let _semLayerCache: { result: SemLayerStatus; at: number } | null = null;
interface SemLayerStatus {
  dereferenced: boolean;
  ontologies: Array<{ id: string; url: string; termCount: number }>;
  composedTermCount: number;
}

async function dereferenceSemLayer(selfBaseUrl: string): Promise<SemLayerStatus> {
  if (_semLayerCache && Date.now() - _semLayerCache.at < FOXXI_VERB_TTL_MS) {
    return _semLayerCache.result;
  }
  const ontologies: SemLayerStatus['ontologies'] = [];
  let composed = 0;
  try {
    for (const slug of ['ieee-ler', 'adl-tla']) {
      const url = `${selfBaseUrl}/ns/${slug}`;
      const r = await fetch(url, { headers: { Accept: 'application/ld+json' } });
      if (!r.ok) throw new Error(`${slug} HTTP ${r.status}`);
      const doc = await r.json() as {
        '@id'?: string;
        terms?: Array<{ construction?: string }>;
      };
      const terms = doc.terms ?? [];
      composed += terms.filter(t => t.construction && t.construction !== 'minted' && t.construction !== 'concept').length;
      ontologies.push({ id: doc['@id'] ?? url, url, termCount: terms.length });
    }
    const result: SemLayerStatus = { dereferenced: true, ontologies, composedTermCount: composed };
    _semLayerCache = { result, at: Date.now() };
    return result;
  } catch {
    return { dereferenced: false, ontologies, composedTermCount: composed };
  }
}

async function handleConformance(req: Request, res: Response, config: AdminConfig): Promise<void> {
  const tenant = resolveAdminTenant(req);
  const all = await listStoredStatements(tenant);
  const vocabularyUrl = `${config.selfBaseUrl}/ns/foxxi`;
  const { verbs: foxxiVerbs, dereferenced } = await dereferenceFoxxiVerbs(vocabularyUrl);
  const semanticLayer = await dereferenceSemLayer(config.selfBaseUrl);
  const knownVerbs = new Set([...ADL_CORE_VERBS, ...foxxiVerbs]);
  let inProfile = 0;
  let outOfProfile = 0;
  const outOfProfileSet = new Set<string>();
  for (const r of all) {
    const id = (r.statement.verb as { id?: string } | undefined)?.id;
    if (!id) continue;
    if (knownVerbs.has(id)) inProfile++;
    else { outOfProfile++; outOfProfileSet.add(id); }
  }
  res.json({
    profileId: FOXXI_PROFILE_ID,
    profileUrl: `${config.selfBaseUrl}/xapi/profile`,
    // The conformance check dereferenced the live vocabulary to obtain
    // the foxxi verb set — it is not assumed.
    vocabularyUrl,
    vocabularyDereferenced: dereferenced,
    totalStatements: all.length,
    inProfile,
    outOfProfile,
    outOfProfileVerbs: [...outOfProfileSet],
    tenant: String(tenant),
    profileConformanceRate: all.length > 0 ? inProfile / all.length : 1,
    declaredVerbs: knownVerbs.size,
    // The IEEE-LER + ADL-TLA semantic layer, dereferenced live — proof
    // the two ontologies are served, composable linked data, not static
    // files. composedTermCount is how many LER/TLA concepts are modelled
    // as compositions / views / roles over substrate primitives.
    semanticLayer,
  });
}

function handleConfig(_req: Request, res: Response, config: AdminConfig): void {
  res.json({
    selfBaseUrl: config.selfBaseUrl,
    profileId: FOXXI_PROFILE_ID,
    profileUrl: `${config.selfBaseUrl}/xapi/profile`,
    aboutUrl: `${config.selfBaseUrl}/xapi/about`,
    statementsUrl: `${config.selfBaseUrl}/xapi/statements`,
    basicAuthKeys: config.basicAuthPairs.split(',').map(s => s.trim()).filter(Boolean).map(p => ({
      principal: p.split(':')[0]!,
      // never echo the password
      hint: `(secret length ${p.split(':')[1]?.length ?? 0})`,
    })),
    forwardingTargets: config.forwardingTargets.split(',').map(s => s.trim()).filter(Boolean).map(t => {
      const [endpoint, _creds, version] = t.split('||');
      return { endpoint, version: version || '1.0.3' };
    }),
    retention: 'in-memory (replace with Redis / Postgres at production scale)',
    versionsSupported: ['2.0.0', '1.0.3'],
  });
}

/**
 * Tenant directory for the dashboard's tenant picker. ADMINS see every tenant
 * that currently holds statements (incl. the isolated `agent-mesh` tenant);
 * learning-engineers see only their default scope. Each entry carries a count
 * so the picker can show e.g. "agent-mesh (88)".
 */
async function handleTenants(req: Request, res: Response): Promise<void> {
  const role = (req as Request & { adminRole?: string }).adminRole;
  const tenants = role === 'admin' ? statementStoreTenants() : [DEFAULT_TENANT];
  // Ensure the default tenant is always offered even if it holds nothing yet.
  if (!tenants.map(String).includes(String(DEFAULT_TENANT))) tenants.unshift(DEFAULT_TENANT);
  const withCounts = await Promise.all(
    tenants.map(async t => ({ tenant: String(t), count: (await listStoredStatements(t)).length })),
  );
  withCounts.sort((a, b) => b.count - a.count);
  res.json({ tenants: withCounts, default: String(DEFAULT_TENANT) });
}

// ── Statement forwarding administration ─────────────────────────────
// Outbound targets (downstream LRSes), per-target delivery metrics +
// dead-letter retry, inbound forwarding credentials, and the inbound
// receipt feed. ADMIN-only on mutations (learning-engineers are read-only
// on forwarding, since it is an operator concern, not a per-cohort one).

/**
 * Express 5 types `req.params[k]` as `string | string[]`: a wildcard
 * segment (`*splat`) decodes to an array. Every route in this file binds
 * a single `:id` segment, which path-to-regexp always yields as a string,
 * so narrow explicitly rather than assert.
 */
function routeParam(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function requireAdmin(req: Request, res: Response): boolean {
  if ((req as Request & { adminRole?: string }).adminRole !== 'admin') {
    res.status(403).json({ error: 'forwarding administration requires the admin role' });
    return false;
  }
  return true;
}

function handleListForwarding(req: Request, res: Response): void {
  res.json({ tenant: String(resolveAdminTenant(req)), targets: listForwardingTargets(resolveAdminTenant(req)) });
}

function handleAddForwarding(req: Request, res: Response): void {
  if (!requireAdmin(req, res)) return;
  const b = (req.body ?? {}) as { label?: string; endpoint?: string; credentials?: string; version?: string; enabled?: boolean };
  if (!b.endpoint || typeof b.endpoint !== 'string') { res.status(400).json({ error: 'endpoint is required' }); return; }
  if (!b.credentials || !b.credentials.includes(':')) { res.status(400).json({ error: 'credentials "user:pass" are required' }); return; }
  const view = addForwardingTarget(resolveAdminTenant(req), {
    label: b.label, endpoint: b.endpoint, credentials: b.credentials, version: b.version, enabled: b.enabled,
  });
  res.status(201).json(view);
}

function handleUpdateForwarding(req: Request, res: Response): void {
  if (!requireAdmin(req, res)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const view = updateForwardingTarget(resolveAdminTenant(req), routeParam(req, 'id'), {
    label: b.label as string | undefined,
    endpoint: b.endpoint as string | undefined,
    credentials: b.credentials as string | undefined,
    version: b.version as string | undefined,
    enabled: b.enabled as boolean | undefined,
  });
  if (!view) { res.status(404).json({ error: 'no such forwarding target' }); return; }
  res.json(view);
}

function handleDeleteForwarding(req: Request, res: Response): void {
  if (!requireAdmin(req, res)) return;
  const ok = deleteForwardingTarget(resolveAdminTenant(req), routeParam(req, 'id'));
  if (!ok) { res.status(404).json({ error: 'no such forwarding target' }); return; }
  res.status(204).end();
}

async function handleRetryForwarding(req: Request, res: Response): Promise<void> {
  if (!requireAdmin(req, res)) return;
  const id = (req.body as { id?: string } | undefined)?.id;
  const summary = await retryDeadLetter(resolveAdminTenant(req), id);
  res.json({ tenant: String(resolveAdminTenant(req)), retried: summary });
}

function handleDeadLetter(req: Request, res: Response): void {
  // Narrow once and reuse, so the echoed id cannot diverge from the lookup key.
  const id = routeParam(req, 'id');
  const dl = deadLetterFor(resolveAdminTenant(req), id);
  res.json({ id, depth: dl.length, items: dl.slice(-50) });
}

function handleInboundReceipts(req: Request, res: Response): void {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ tenant: String(resolveAdminTenant(req)), ...listInboundReceipts(resolveAdminTenant(req), limit) });
}

function handleListCredentials(_req: Request, res: Response): void {
  res.json({ credentials: inboundCredentials.list() });
}

function handleAddCredential(req: Request, res: Response): void {
  if (!requireAdmin(req, res)) return;
  const b = (req.body ?? {}) as { principal?: string; secret?: string; tenant?: string; label?: string };
  if (!b.principal || !b.secret) { res.status(400).json({ error: 'principal and secret are required' }); return; }
  res.status(201).json(inboundCredentials.add({ principal: b.principal, secret: b.secret, tenant: b.tenant, label: b.label }));
}

function handleDeleteCredential(req: Request, res: Response): void {
  if (!requireAdmin(req, res)) return;
  const ok = inboundCredentials.remove(routeParam(req, 'id'));
  if (!ok) { res.status(404).json({ error: 'no such credential' }); return; }
  res.status(204).end();
}

// ── Route attachment ────────────────────────────────────────────────

export function attachXapiAdminRoutes(app: Express, config: AdminConfig): void {
  const gate = makeAdminGate(config);
  const json = express.json({ limit: '256kb' });
  app.get('/xapi/admin/statements', gate, (req, res) => { void handleStatementsAdmin(req, res); });
  app.get('/xapi/admin/aggregates', gate, (req, res) => { void handleAggregates(req, res); });
  app.get('/xapi/admin/conformance', gate, (req, res) => { void handleConformance(req, res, config); });
  app.get('/xapi/admin/config', gate, (req, res) => handleConfig(req, res, config));
  app.get('/xapi/admin/tenants', gate, (req, res) => { void handleTenants(req, res); });

  // Outbound forwarding targets + metrics + dead-letter retry.
  app.get('/xapi/admin/forwarding/targets', gate, (req, res) => handleListForwarding(req, res));
  app.post('/xapi/admin/forwarding/targets', gate, json, (req, res) => handleAddForwarding(req, res));
  app.put('/xapi/admin/forwarding/targets/:id', gate, json, (req, res) => handleUpdateForwarding(req, res));
  app.delete('/xapi/admin/forwarding/targets/:id', gate, (req, res) => handleDeleteForwarding(req, res));
  app.get('/xapi/admin/forwarding/targets/:id/dead-letter', gate, (req, res) => handleDeadLetter(req, res));
  app.post('/xapi/admin/forwarding/retry', gate, json, (req, res) => { void handleRetryForwarding(req, res); });

  // Inbound forwarding: receipts feed + credential management.
  app.get('/xapi/admin/forwarding/inbound', gate, (req, res) => handleInboundReceipts(req, res));
  app.get('/xapi/admin/credentials', gate, (req, res) => handleListCredentials(req, res));
  app.post('/xapi/admin/credentials', gate, json, (req, res) => handleAddCredential(req, res));
  app.delete('/xapi/admin/credentials/:id', gate, (req, res) => handleDeleteCredential(req, res));
}
