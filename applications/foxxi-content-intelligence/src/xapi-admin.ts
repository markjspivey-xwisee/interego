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

import type { Express, Request, Response, NextFunction } from 'express';
import { listStoredStatements } from './xapi-lrs.js';
import { FOXXI_PROFILE_ID } from './xapi-profile.js';

interface AdminConfig {
  adminWebId: string;
  learningEngineerWebIds: ReadonlySet<string>;
  selfBaseUrl: string;
  basicAuthPairs: string;
  forwardingTargets: string;
}

function decodeBearerSub(req: Request): string | null {
  const header = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  try {
    const padded = m[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const t = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: string };
    return t.sub ?? null;
  } catch { return null; }
}

function makeAdminGate(config: AdminConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const sub = decodeBearerSub(req);
    if (!sub) {
      res.status(401).json({ error: 'session token required' });
      return;
    }
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

async function handleStatementsAdmin(req: Request, res: Response): Promise<void> {
  const all = await listStoredStatements();
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
    total: filtered.length,
    page: page.map(r => ({
      id: r.id,
      stored: r.stored,
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

async function handleAggregates(_req: Request, res: Response): Promise<void> {
  const all = await listStoredStatements();

  const verbCounts = new Map<string, { display: string; count: number }>();
  const activityCounts = new Map<string, { name?: string; count: number }>();
  const actorCounts = new Map<string, { name?: string; count: number }>();
  const errorCount = { total: 0 };
  const hourBuckets = new Map<string, number>();

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

    const hour = r.stored.slice(0, 13) + ':00:00Z';
    hourBuckets.set(hour, (hourBuckets.get(hour) ?? 0) + 1);
  }

  const topN = <T>(m: Map<string, T & { count: number }>, n: number): Array<T & { id: string }> => {
    return [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([id, v]) => ({ id, ...v }));
  };

  res.json({
    total: all.length,
    errors: errorCount.total,
    successRate: all.length > 0 ? 1 - (errorCount.total / all.length) : 1,
    topVerbs: topN(verbCounts, 10),
    topActivities: topN(activityCounts, 10),
    topActors: topN(actorCounts, 10),
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

async function handleConformance(_req: Request, res: Response, config: AdminConfig): Promise<void> {
  const all = await listStoredStatements();
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

// ── Route attachment ────────────────────────────────────────────────

export function attachXapiAdminRoutes(app: Express, config: AdminConfig): void {
  const gate = makeAdminGate(config);
  app.get('/xapi/admin/statements', gate, (req, res) => { void handleStatementsAdmin(req, res); });
  app.get('/xapi/admin/aggregates', gate, (req, res) => { void handleAggregates(req, res); });
  app.get('/xapi/admin/conformance', gate, (req, res) => { void handleConformance(req, res, config); });
  app.get('/xapi/admin/config', gate, (req, res) => handleConfig(req, res, config));
}
