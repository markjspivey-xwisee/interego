/**
 * The cmi5 LMS-side launch contract (cmi5 / IEEE 9274.2.1 §7–§8).
 *
 * Foxxi already emits every cmi5 Statement type and evaluates the
 * moveOn criterion (see cmi5.ts). What it could NOT do is be a cmi5
 * LMS *launcher* — hand an Assignable Unit (AU) a conformant launch URL
 * and mint the one-time fetch token the AU exchanges for LRS auth. That
 * is the contract that makes Foxxi-as-LMS an LMS: it can launch content.
 *
 * The cmi5 launch handshake this implements:
 *
 *   1. The LMS builds a launch URL for a learner + an AU:
 *        <auUrl>?endpoint=<lrs>&fetch=<fetchUrl>&actor=<agentJSON>
 *               &activityId=<auId>&registration=<uuid>
 *   2. The LMS stages the `LMS.LaunchData` State document (launchMode,
 *      moveOn, masteryScore, contextTemplate, returnURL) so the AU can
 *      GET it from the LRS State resource (§10).
 *   3. The AU loads, and POSTs once to the `fetch` URL. The LMS returns
 *      `{ "auth-token": "<token>" }` (§8) — single-use.
 *   4. The AU sends its cmi5 Statements to `<lrs>` authenticated with
 *      that token. Foxxi-as-LRS accepts it as a Bearer credential, and
 *      the token carries the launch's tenant, so the statements land in
 *      the right tenant partition.
 *
 * Multi-tenant: fetch tokens are minted per tenant and resolve their
 * tenant for the LRS auth gate. Single-tenant deployments use
 * DEFAULT_TENANT throughout.
 *
 * Layer: L3 vertical. No new ontology term — cmi5 is an external IEEE
 * standard; this is a conformant implementation of its LMS surface.
 */

import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { DEFAULT_TENANT, TenantPartition, tenantIdOf, type TenantId } from './tenant-context.js';
import { callerIsOperator, trustedTenantOf, type OperatorAuthConfig } from './operator-auth.js';
import { buildCmi5Statement, evaluateMoveOn } from './cmi5.js';
import {
  parseCmi5Course, auById, precedingAu, flatAus, flatBlocks, blockAuIds,
  type Cmi5Course,
} from './cmi5-course.js';

const CMI5_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const V_PASSED = 'http://adlnet.gov/expapi/verbs/passed';
const V_COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
const V_FAILED = 'http://adlnet.gov/expapi/verbs/failed';
const V_SATISFIED = 'https://w3id.org/xapi/adl/verbs/satisfied';
/** cmi5 lifecycle verbs whose arrival should re-evaluate moveOn. */
const CMI5_LIFECYCLE = new Set([
  V_PASSED, V_COMPLETED, V_FAILED,
  'http://adlnet.gov/expapi/verbs/terminated',
  'http://adlnet.gov/expapi/verbs/initialized',
]);

export type Cmi5LaunchMode = 'Normal' | 'Browse' | 'Review';
export type Cmi5MoveOn = 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';

/** An Assignable Unit — the launchable content unit of a cmi5 course. */
export interface Cmi5Au {
  /** The AU's activity id (an IRI). */
  id: string;
  /** The AU's launchable URL (the content endpoint). */
  url: string;
  /** moveOn criterion the LMS will gate satisfaction on. */
  moveOn?: Cmi5MoveOn;
  /** Mastery score 0..1 — the AU passes at or above this. */
  masteryScore?: number;
  /** cmi5 launch method. */
  launchMethod?: 'OwnWindow' | 'AnyWindow';
  title?: string;
}

export interface Cmi5LaunchRequest {
  au: Cmi5Au;
  /** The learner — DID becomes the xAPI Agent account name. */
  learner: { id: string; name?: string };
  /** The LRS endpoint the AU sends its Statements to. */
  lrsEndpoint: string;
  /** The bridge's cmi5 fetch base — `<bridge>/cmi5/fetch`. */
  fetchBaseUrl: string;
  /** The authoritative source — the xAPI Agent account homePage. */
  authoritativeSource: string;
  tenant?: TenantId;
  launchMode?: Cmi5LaunchMode;
  /** Where the AU returns the learner after termination. */
  returnUrl?: string;
  /** The parent course activity id, for course-level rollup. */
  courseId?: string;
}

export interface Cmi5Launch {
  registration: string;
  /** The conformant cmi5 launch URL to navigate the learner to. */
  launchUrl: string;
  /** The xAPI Agent for the learner. */
  actor: Record<string, unknown>;
  /** The `LMS.LaunchData` State document the AU reads from the LRS (§10). */
  launchData: Record<string, unknown>;
  /** The one-time fetch token (already registered; for staging/inspection). */
  fetchToken: string;
}

interface FetchTokenRecord {
  /** The auth-token the AU receives and uses against the LRS. */
  authToken: string;
  tenant: TenantId;
  registration: string;
  auId: string;
  expiresAt: number;
  redeemed: boolean;
}

/** Fetch tokens minted by launches, keyed by the token the AU presents. */
const fetchTokens = new Map<string, FetchTokenRecord>();
/** Auth-tokens the LRS accepts as Bearer → their tenant. */
const authTokenTenants = new Map<string, TenantId>();
const FETCH_TOKEN_TTL_MS = 30 * 60_000; // a launch must be fetched within 30 min

// ── moveOn orchestration state ──────────────────────────────────────

/** A live launch the LMS is tracking for moveOn satisfaction. */
interface LaunchRecord {
  registration: string;
  auId: string;
  auTitle?: string;
  moveOn: Cmi5MoveOn;
  masteryScore: number;
  tenant: TenantId;
  learner: { id: string; name?: string };
  authoritativeSource: string;
  courseId?: string;
  satisfied: boolean;
  satisfiedAt?: string;
  reason: string;
}

/** Launches keyed by registration — the LMS watches these for moveOn. */
const launches = new Map<string, LaunchRecord>();
/** Per tenant, per learner — the set of AU ids the learner has satisfied
 *  (drives prerequisite gating). */
const satisfiedAus = new Map<TenantId, Map<string, Set<string>>>();

// ── Pod projection (foxxi:Cmi5TenantSnapshot) ────────────────────────
// Snapshot publisher: every launch + satisfaction state change is
// debounced and published as a versioned snapshot to the tenant pod.
// Hydration on startup restores both maps so cmi5 launches survive
// container restarts.
import {
  registerSnapshot, dirty as markCmi5Dirty, loadLatestSnapshot, FOXXI_SNAPSHOT_TYPES,
} from './pod-snapshot-publisher.js';
interface Cmi5Snapshot {
  launches: Array<[string, LaunchRecord]>;
  satisfied: Array<[string, Array<[string, string[]]>]>; // [tenant, [[learner, [auIds]]]]
}
function collectCmi5Snapshot(): Cmi5Snapshot {
  const sat: Array<[string, Array<[string, string[]]>]> = [];
  for (const [tenant, byLearner] of satisfiedAus) {
    const learners: Array<[string, string[]]> = [];
    for (const [learnerId, set] of byLearner) learners.push([learnerId, [...set]]);
    sat.push([String(tenant), learners]);
  }
  return { launches: [...launches.entries()], satisfied: sat };
}
async function hydrateCmi5FromPod(): Promise<void> {
  const snap = await loadLatestSnapshot<Cmi5Snapshot>('cmi5');
  if (!snap) return;
  if (snap.launches) for (const [reg, rec] of snap.launches) launches.set(reg, rec);
  if (snap.satisfied) {
    for (const [tenant, learners] of snap.satisfied) {
      const byLearner = new Map<string, Set<string>>();
      for (const [learnerId, ids] of learners) byLearner.set(learnerId, new Set(ids));
      satisfiedAus.set(tenant as TenantId, byLearner);
    }
  }
}
registerSnapshot({ surface: 'cmi5', typeIri: FOXXI_SNAPSHOT_TYPES.Cmi5Launches, collect: collectCmi5Snapshot });
void hydrateCmi5FromPod();
const cmi5PodDirty = (): void => markCmi5Dirty('cmi5');

function markAuSatisfied(tenant: TenantId, learnerId: string, auId: string): void {
  let byLearner = satisfiedAus.get(tenant);
  if (!byLearner) { byLearner = new Map(); satisfiedAus.set(tenant, byLearner); }
  let set = byLearner.get(learnerId);
  if (!set) { set = new Set(); byLearner.set(learnerId, set); }
  set.add(auId);
  cmi5PodDirty();
}

/** The AU ids a learner has satisfied within a tenant. */
export function learnerSatisfiedAus(tenant: TenantId, learnerId: string): string[] {
  return [...(satisfiedAus.get(tenant)?.get(learnerId) ?? [])];
}

// ── Course-structure registry + satisfaction rollup ─────────────────

/** Registered cmi5 course structures, per tenant, keyed by course id. */
const courseRegistry = new TenantPartition<Map<string, Cmi5Course>>(() => new Map());
/** Per tenant|course|learner — the block/course ids already emitted `satisfied`. */
const rollupEmitted = new Map<string, Set<string>>();
/** Per tenant|course|learner — the (stable) registration for course-level statements. */
const courseEnrollmentReg = new Map<string, string>();

/** Register a cmi5 course structure (from a parsed cmi5.xml). */
export function registerCmi5Course(tenant: TenantId, course: Cmi5Course): void {
  courseRegistry.for(tenant).set(course.id, course);
}

export function getCmi5Course(tenant: TenantId, courseId: string): Cmi5Course | undefined {
  return courseRegistry.for(tenant).get(courseId);
}

/** Every cmi5 course structure registered in a tenant — drives content
 *  pickers (LTI Deep Linking) and catalog listings. */
export function listCmi5Courses(tenant: TenantId): Cmi5Course[] {
  return [...courseRegistry.for(tenant).values()];
}

/** Find a registered course (in a tenant) that contains the given AU. */
function courseContainingAu(tenant: TenantId, auId: string): Cmi5Course | undefined {
  for (const course of courseRegistry.for(tenant).values()) {
    if (flatAus(course).some(a => a.id === auId)) return course;
  }
  return undefined;
}

/**
 * Roll satisfaction up the course tree. Called when an AU is satisfied:
 * for any registered course containing it, emit a cmi5 `satisfied`
 * statement (cmi5 §9.6) for every block all of whose AUs are now
 * satisfied, and for the course itself once every AU is — each emitted
 * at most once per learner.
 */
function rollupCourse(
  tenant: TenantId,
  learner: { id: string; name?: string },
  authoritativeSource: string,
  emit: (statement: Record<string, unknown>) => void,
  auId: string,
): void {
  const course = courseContainingAu(tenant, auId);
  if (!course) return;
  const key = `${tenant}|${course.id}|${learner.id}`;
  const satisfied = new Set(learnerSatisfiedAus(tenant, learner.id));
  let emitted = rollupEmitted.get(key);
  if (!emitted) { emitted = new Set(); rollupEmitted.set(key, emitted); }
  let reg = courseEnrollmentReg.get(key);
  if (!reg) { reg = randomUUID(); courseEnrollmentReg.set(key, reg); }

  const emitSatisfied = (activityId: string): void => {
    emit(buildCmi5Statement({
      verb: 'satisfied',
      actor: {
        account: { homePage: authoritativeSource, name: learner.id },
        ...(learner.name ? { name: learner.name } : {}),
      },
      session: { registration: reg!, auActivityId: activityId, courseActivityId: course.id },
    }) as unknown as Record<string, unknown>);
  };

  // Blocks first (a block can be satisfied before the whole course is).
  for (const block of flatBlocks(course)) {
    const ids = blockAuIds(block);
    if (ids.length > 0 && ids.every(id => satisfied.has(id)) && !emitted.has(block.id)) {
      emitted.add(block.id);
      emitSatisfied(block.id);
    }
  }
  // The course is satisfied once every AU is.
  const allAus = flatAus(course).map(a => a.id);
  if (allAus.length > 0 && allAus.every(id => satisfied.has(id)) && !emitted.has(course.id)) {
    emitted.add(course.id);
    emitSatisfied(course.id);
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [k, v] of fetchTokens) if (v.expiresAt < now) fetchTokens.delete(k);
}

/**
 * Build a conformant cmi5 launch for a learner + an AU. Registers the
 * one-time fetch token; the caller navigates the learner to `launchUrl`
 * and stages `launchData` into the LRS State resource as `LMS.LaunchData`.
 */
export function buildCmi5Launch(req: Cmi5LaunchRequest): Cmi5Launch {
  sweepExpired();
  const tenant = req.tenant ?? DEFAULT_TENANT;
  const registration = randomUUID();
  const actor = {
    objectType: 'Agent',
    ...(req.learner.name ? { name: req.learner.name } : {}),
    account: { homePage: req.authoritativeSource, name: req.learner.id },
  };

  // The one-time fetch token + the auth-token the AU will end up with.
  const fetchToken = `ft-${randomUUID()}`;
  const authToken = `cmi5-${tenant === DEFAULT_TENANT ? 'd' : '0'}-${randomUUID()}`;
  fetchTokens.set(fetchToken, {
    authToken, tenant, registration, auId: req.au.id,
    expiresAt: Date.now() + FETCH_TOKEN_TTL_MS, redeemed: false,
  });

  // Register the launch so the LMS can watch it for moveOn satisfaction.
  const moveOn = req.au.moveOn ?? 'CompletedOrPassed';
  launches.set(registration, {
    registration,
    auId: req.au.id,
    ...(req.au.title ? { auTitle: req.au.title } : {}),
    moveOn,
    masteryScore: typeof req.au.masteryScore === 'number' ? req.au.masteryScore : 1.0,
    tenant,
    learner: { id: req.learner.id, ...(req.learner.name ? { name: req.learner.name } : {}) },
    authoritativeSource: req.authoritativeSource,
    ...(req.courseId ? { courseId: req.courseId } : {}),
    satisfied: false,
    reason: 'launched — awaiting the AU\'s cmi5 statements',
  });
  cmi5PodDirty();

  const fetchUrl = `${req.fetchBaseUrl.replace(/\/+$/, '')}/${fetchToken}`;
  const params = new URLSearchParams({
    endpoint: req.lrsEndpoint,
    fetch: fetchUrl,
    actor: JSON.stringify(actor),
    activityId: req.au.id,
    registration,
  });
  const sep = req.au.url.includes('?') ? '&' : '?';
  const launchUrl = `${req.au.url}${sep}${params.toString()}`;

  // The LMS.LaunchData State document (cmi5 §10.1).
  const launchData: Record<string, unknown> = {
    contextTemplate: {
      registration,
      contextActivities: { category: [{ id: CMI5_CATEGORY }] },
      extensions: {
        'https://w3id.org/xapi/cmi5/context/extensions/sessionid': randomUUID(),
      },
    },
    launchMode: req.launchMode ?? 'Normal',
    moveOn: req.au.moveOn ?? 'CompletedOrPassed',
    ...(typeof req.au.masteryScore === 'number' ? { masteryScore: req.au.masteryScore } : {}),
    ...(req.returnUrl ? { returnURL: req.returnUrl } : {}),
    entitlementKey: { courseStructure: registration },
  };

  return { registration, launchUrl, actor, launchData, fetchToken };
}

/**
 * Redeem a fetch token (cmi5 §8). One-time: a second redemption fails.
 * Returns the cmi5 fetch response body, or an error.
 */
export function redeemFetchToken(token: string):
  | { ok: true; body: { 'auth-token': string } }
  | { ok: false; status: number; body: { 'error-code': string; 'error-text': string } } {
  sweepExpired();
  const rec = fetchTokens.get(token);
  if (!rec) {
    return { ok: false, status: 404, body: { 'error-code': '1', 'error-text': 'fetch token not found or expired' } };
  }
  if (rec.redeemed) {
    return { ok: false, status: 401, body: { 'error-code': '4', 'error-text': 'fetch token already used (single-use, cmi5 §8)' } };
  }
  rec.redeemed = true;
  authTokenTenants.set(rec.authToken, rec.tenant);
  return { ok: true, body: { 'auth-token': rec.authToken } };
}

/**
 * Resolve the tenant of a cmi5-issued auth-token — wired into the LRS
 * auth gate so an AU's Statements land in the launch's tenant partition.
 * Returns null for tokens this module did not mint.
 */
export function cmi5BearerTenant(token: string): TenantId | null {
  return authTokenTenants.get(token) ?? null;
}

// ── moveOn orchestration — closing the cmi5 loop ─────────────────────

/** What the LMS needs to observe a registration and emit `satisfied`. */
export interface Cmi5ObserveDeps {
  /** All stored statements carrying this registration. */
  statementsForRegistration: (registration: string) => Promise<Array<Record<string, unknown>>>;
  /** Persist a statement (the `satisfied` statement) into the tenant's LRS. */
  emit: (statement: Record<string, unknown>) => void;
}

/** The result of observing one statement against a tracked launch. */
export interface Cmi5ObserveResult {
  registration: string;
  satisfied: boolean;
  reason: string;
  /** True only on the transition into satisfied (the `satisfied` emit). */
  emittedSatisfied: boolean;
}

/**
 * The orchestration loop. Called after a statement is stored in the LRS:
 * if the statement is a cmi5 lifecycle statement for a launch the LMS is
 * tracking, re-evaluate that AU's moveOn criterion (cmi5 §11) against the
 * registration's accumulated statements. The first time moveOn is met,
 * the LMS emits the `satisfied` statement (cmi5 §9.6) and records the AU
 * as satisfied for the learner (which gates later launches).
 *
 * Idempotent: once a launch is satisfied it is not re-evaluated, and the
 * emitted `satisfied` statement is itself ignored — no loop.
 */
export async function observeCmi5Statement(
  statement: Record<string, unknown>,
  tenant: TenantId,
  deps: Cmi5ObserveDeps,
): Promise<Cmi5ObserveResult | null> {
  const ctx = statement.context as { registration?: string } | undefined;
  const registration = ctx?.registration;
  if (!registration) return null;
  const launch = launches.get(registration);
  if (!launch || launch.tenant !== tenant) return null;
  const verbId = (statement.verb as { id?: string } | undefined)?.id;
  if (!verbId || verbId === V_SATISFIED || !CMI5_LIFECYCLE.has(verbId)) return null;
  if (launch.satisfied) {
    return { registration, satisfied: true, reason: launch.reason, emittedSatisfied: false };
  }

  // Re-read the registration's statements and apply cmi5 §11 moveOn.
  const all = await deps.statementsForRegistration(registration);
  let passed = false;
  let completed = false;
  let scoreScaled: number | undefined;
  for (const s of all) {
    const v = (s.verb as { id?: string } | undefined)?.id;
    if (v === V_PASSED) {
      passed = true;
      const sc = (s.result as { score?: { scaled?: number } } | undefined)?.score?.scaled;
      if (typeof sc === 'number') scoreScaled = sc;
    } else if (v === V_COMPLETED) {
      completed = true;
    }
  }
  const decision = evaluateMoveOn({
    moveOnRule: launch.moveOn,
    masteryScore: launch.masteryScore,
    passed,
    completed,
    ...(scoreScaled !== undefined ? { scoreScaled } : {}),
  });
  launch.reason = decision.reason;
  cmi5PodDirty();
  if (!decision.satisfied) {
    return { registration, satisfied: false, reason: decision.reason, emittedSatisfied: false };
  }

  // moveOn met — record it and emit the AU's cmi5 `satisfied` statement.
  launch.satisfied = true;
  launch.satisfiedAt = new Date().toISOString();
  markAuSatisfied(tenant, launch.learner.id, launch.auId);
  cmi5PodDirty();
  const satisfied = buildCmi5Statement({
    verb: 'satisfied',
    actor: {
      account: { homePage: launch.authoritativeSource, name: launch.learner.id },
      ...(launch.learner.name ? { name: launch.learner.name } : {}),
    },
    session: {
      registration,
      auActivityId: launch.auId,
      ...(launch.courseId ? { courseActivityId: launch.courseId } : {}),
    },
  });
  deps.emit(satisfied as unknown as Record<string, unknown>);
  // Roll satisfaction up the course structure — emit `satisfied` for any
  // block now fully satisfied, and for the course once every AU is.
  rollupCourse(tenant, launch.learner, launch.authoritativeSource, deps.emit, launch.auId);
  return { registration, satisfied: true, reason: decision.reason, emittedSatisfied: true };
}

/** Inspect a tracked registration's moveOn state — for GET /cmi5/registration/:reg. */
export function inspectRegistration(registration: string): Record<string, unknown> | null {
  const l = launches.get(registration);
  if (!l) return null;
  return {
    registration: l.registration,
    auId: l.auId,
    auTitle: l.auTitle,
    moveOn: l.moveOn,
    masteryScore: l.masteryScore,
    satisfied: l.satisfied,
    satisfiedAt: l.satisfiedAt,
    reason: l.reason,
    learner: l.learner.id,
  };
}

/** Attach the cmi5 LMS launch + fetch routes. */
export function attachCmi5LmsRoutes(app: Express, config: {
  selfBaseUrl: string;
  authoritativeSource: string;
  defaultLrsEndpoint?: string;
} & OperatorAuthConfig): void {
  // ── The fetch endpoint (cmi5 §8) — the AU exchanges its one-time
  //    fetch token for an LRS auth-token. ─────────────────────────────
  app.post('/cmi5/fetch/:token', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const result = redeemFetchToken(String(req.params.token ?? ''));
    if (result.ok) { res.status(200).json(result.body); return; }
    res.status(result.status).json(result.body);
  });

  // ── Register a cmi5 course structure (POST the cmi5.xml). ─────────
  // A text-body parser for the XML — the global JSON parser handles the
  // `{ cmi5_xml }` form; this captures a raw text/xml body.
  const xmlBody = express.text({
    type: (req) => !(((req.headers['content-type'] as string | undefined) ?? '').toLowerCase().includes('application/json')),
    limit: '5mb',
  });
  app.post('/cmi5/course', xmlBody, (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!callerIsOperator(req, config)) {
      res.status(401).json({ error: 'cmi5 course registration requires an authenticated operator session token' });
      return;
    }
    const tenant = trustedTenantOf(req, config);
    const xml = typeof req.body === 'string' ? req.body
      : Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : (req.body && typeof req.body === 'object' && typeof (req.body as { cmi5_xml?: string }).cmi5_xml === 'string')
        ? (req.body as { cmi5_xml: string }).cmi5_xml : '';
    if (!xml.trim()) { res.status(400).json({ error: 'POST the cmi5.xml document as the body (text/xml) or { "cmi5_xml": "..." }' }); return; }
    let course: Cmi5Course;
    try { course = parseCmi5Course(xml); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    registerCmi5Course(tenant, course);
    res.status(200).json({
      registered: true,
      courseId: course.id,
      title: course.title,
      auCount: flatAus(course).length,
      blockCount: flatBlocks(course).length,
      aus: flatAus(course).map(a => ({ id: a.id, title: a.title, moveOn: a.moveOn })),
    });
  });

  // ── Inspect a registered course structure. ───────────────────────
  app.get('/cmi5/course/:id', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const tenant = trustedTenantOf(req, config);
    const course = getCmi5Course(tenant, String(req.params.id ?? ''));
    if (!course) { res.status(404).json({ error: 'no registered course with that id' }); return; }
    res.status(200).json(course);
  });

  // ── The launch endpoint — given an AU + a learner, return a
  //    conformant cmi5 launch (URL + LaunchData + actor). ─────────────
  app.get('/cmi5/launch', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // This mints an LRS-honored Bearer for the named learner — require a
    // verified operator. Previously anonymous: any caller could mint a
    // token for an arbitrary ?learner into an arbitrary ?tenant_pod_url and
    // write statements as that learner into that tenant.
    if (!callerIsOperator(req, config)) {
      res.status(401).json({ error: 'cmi5 launch requires an authenticated operator (admin or learning-engineer) session token' });
      return;
    }
    const auId = req.query.au_id as string | undefined;
    const learnerId = req.query.learner as string | undefined;
    const tenant = trustedTenantOf(req, config);
    const courseId = req.query.course_id as string | undefined;
    if (!auId || !learnerId) {
      res.status(400).json({ error: 'au_id and learner are required query parameters' });
      return;
    }

    // If the AU belongs to a registered course, take its url / moveOn /
    // masteryScore / title from the course structure (the caller need
    // not repeat them), and derive the sequential prerequisite.
    const course = courseId ? getCmi5Course(tenant, courseId) : undefined;
    const auNode = course ? auById(course, auId) : undefined;
    const auUrl = (req.query.au_url as string | undefined) ?? auNode?.url;
    if (!auUrl) {
      res.status(400).json({ error: 'au_url is required (or pass course_id for a registered course that contains au_id)' });
      return;
    }

    const lrsEndpoint = (req.query.endpoint as string | undefined)
      ?? config.defaultLrsEndpoint
      ?? `${config.selfBaseUrl}/xapi`;

    // Course gating (cmi5 §8.1): an explicit `prereq` list, OR — for an
    // AU in a registered course — the AU that precedes it in the
    // structure (sequential progression).
    const explicitPrereq = (req.query.prereq as string | undefined)?.split(',').map(s => s.trim()).filter(Boolean);
    const structuralPrereq = course && auNode ? precedingAu(course, auId)?.id : undefined;
    const prereq = explicitPrereq ?? (structuralPrereq ? [structuralPrereq] : []);
    if (prereq.length > 0) {
      const done = new Set(learnerSatisfiedAus(tenant, learnerId));
      const missing = prereq.filter(p => !done.has(p));
      if (missing.length > 0) {
        res.status(409).json({
          error: 'launch gated — prerequisite AU(s) not yet satisfied by this learner',
          missingPrerequisites: missing,
          satisfied: [...done],
          gate: structuralPrereq && !explicitPrereq ? 'sequential course-structure progression' : 'explicit prerequisite',
        });
        return;
      }
    }

    const launch = buildCmi5Launch({
      au: {
        id: auId,
        url: auUrl,
        moveOn: (req.query.move_on as Cmi5MoveOn | undefined) ?? auNode?.moveOn,
        masteryScore: req.query.mastery_score !== undefined ? Number(req.query.mastery_score) : auNode?.masteryScore,
        title: (req.query.title as string | undefined) ?? auNode?.title,
      },
      learner: { id: learnerId, name: req.query.learner_name as string | undefined },
      lrsEndpoint,
      fetchBaseUrl: `${config.selfBaseUrl}/cmi5/fetch`,
      authoritativeSource: config.authoritativeSource,
      tenant,
      launchMode: req.query.launch_mode as Cmi5LaunchMode | undefined,
      returnUrl: req.query.return_url as string | undefined,
      courseId: courseId ?? course?.id,
    });
    res.status(200).json({
      ...launch,
      ...(course ? { course: { id: course.id, prerequisiteGate: structuralPrereq ?? null } } : {}),
      note: 'Navigate the learner to launchUrl. Stage launchData into the LRS State resource as stateId=LMS.LaunchData. The AU POSTs the fetch URL once for its auth-token. The LMS watches the registration: when the AU\'s statements meet moveOn it auto-emits `satisfied`, and rolls satisfaction up the course structure to blocks and the course.',
    });
  });

  // ── Registration inspection — the moveOn state of a live launch. ──
  app.get('/cmi5/registration/:reg', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const state = inspectRegistration(String(req.params.reg ?? ''));
    if (!state) { res.status(404).json({ error: 'no tracked launch for that registration' }); return; }
    res.status(200).json(state);
  });
}
