/**
 * The cmi5 LMS-side launch contract (cmi5 §7–§8; being standardized as IEEE P9274.3.1).
 *
 * Foxxi already emits every cmi5 Statement type and evaluates the
 * moveOn criterion (see cmi5.ts). What it could NOT do is be a cmi5
 * LMS *launcher* — hand an Assignable Unit (AU) a conformant launch URL
 * and mint the one-time fetch token the AU exchanges for LRS auth. That
 * is the contract that makes Foxxi-as-LMS an LMS: it can launch content.
 *
 * The cmi5 launch handshake this implements:
 *
 *   1. The LMS records a `launched` statement for the new session, then builds
 *      a launch URL for a learner + an AU:
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
import { DEFAULT_TENANT, TenantPartition, type TenantId } from './tenant-context.js';
import { callerIsOperator, trustedTenantOf, type OperatorAuthConfig } from './operator-auth.js';
import { buildCmi5Statement, evaluateMoveOn } from './cmi5.js';
import {
  parseCmi5Course, auById, precedingAu, flatAus, flatBlocks, blockAuIds, LAUNCH_PARAMETERS_MAX,
  type Cmi5Course, type Cmi5AuNode,
} from './cmi5-course.js';
import { stageStateDocument, storeStatementDurably } from './xapi-lrs.js';

const CMI5_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const V_PASSED = 'http://adlnet.gov/expapi/verbs/passed';
const V_COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
const V_FAILED = 'http://adlnet.gov/expapi/verbs/failed';
const V_TERMINATED = 'http://adlnet.gov/expapi/verbs/terminated';
const V_ABANDONED = 'https://w3id.org/xapi/adl/verbs/abandoned';
const V_WAIVED = 'https://w3id.org/xapi/adl/verbs/waived';
const V_SATISFIED = 'https://w3id.org/xapi/adl/verbs/satisfied';
/** cmi5 lifecycle verbs whose arrival should re-evaluate moveOn. */
const CMI5_LIFECYCLE = new Set([
  V_PASSED, V_COMPLETED, V_FAILED, V_TERMINATED,
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
  /** The AU's entitlement key from the course structure (§13.1.4), when it has one. */
  entitlementKey?: string;
  /** cmi5 §10.2.3. From the course structure, unless this launch replaces it. */
  launchParameters?: string;
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
  /** A signed learner's own pod: set when the learner launched for themselves, so the AU's
   *  statements and the LMS's `satisfied` can be kept on that pod as well as in the lens. */
  learnerPod?: string;
  /**
   * Continue this registration. `sessionId` resumes that open session. `newSession` keeps the
   * registration after `terminated` left moveOn unmet, and mints a new session id (cmi5 §9.3).
   */
  resume?: { registration: string; sessionId?: string; newSession?: boolean };
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
  /**
   * The LMS `launched` statement for this session (cmi5 §9.3.1). Absent when the same
   * session is resumed. A new registration, and a new session of a registration terminated
   * before moveOn, each carry a fresh one.
   */
  launched?: Record<string, unknown>;
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
/**
 * Auth-tokens the LRS accepts as Bearer → their tenant, and the one launch registration they may
 * touch. A learner's launches all share their lens tenant, so the tenant alone let one launch's
 * token read another's statements and write `passed` into it (the automated review of #478).
 */
const authTokenLaunch = new Map<string, { tenant: TenantId; registration: string }>();
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
  /** See Cmi5LaunchRequest.learnerPod. */
  learnerPod?: string;
  /** cmi5 session id (§9.6.3.1). Absent on a snapshot from before sessions were kept; those are not resumed. */
  sessionId?: string;
  /** Set once the session has ended. terminated without moveOn keeps this registration and starts a new session. */
  sessionClosed?: 'terminated' | 'abandoned' | 'waived';
  /** Browse and Review are kept and not judged (§10.2.2). Absent means Normal. */
  launchMode?: Cmi5LaunchMode;
  satisfied: boolean;
  satisfiedAt?: string;
  reason: string;
}

/** Launches keyed by registration — the LMS watches these for moveOn. */
const launches = new Map<string, LaunchRecord>();
/** The open session for one learner, course and AU, when it can be resumed. */
const openByKey = new Map<string, string>();

function openLaunchKey(l: { tenant: TenantId; learner: { id: string }; courseId?: string; auId: string }): string | undefined {
  return l.courseId ? `${l.tenant}\n${l.learner.id}\n${l.courseId}\n${l.auId}` : undefined;
}
function rememberOpenLaunch(l: LaunchRecord): void {
  const key = openLaunchKey(l);
  if (key && l.sessionId) openByKey.set(key, l.registration);
}
function reindexOpenLaunches(): void {
  openByKey.clear();
  for (const l of launches.values()) rememberOpenLaunch(l);
}
function closeSession(launch: LaunchRecord, how: 'terminated' | 'abandoned' | 'waived'): void {
  if (launch.sessionClosed) return;
  launch.sessionClosed = how;
  rememberOpenLaunch(launch);
  cmi5PodDirty();
}
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
  reindexOpenLaunches();
}
registerSnapshot({ surface: 'cmi5', typeIri: FOXXI_SNAPSHOT_TYPES.Cmi5Launches, collect: collectCmi5Snapshot });
const cmi5Hydrated = hydrateCmi5FromPod();
/** Resolves once the launch snapshot has been read, or the read has failed. Resume waits for this. */
export function whenCmi5Ready(): Promise<void> {
  return cmi5Hydrated.then(() => undefined, () => undefined);
}
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

/** Cap the per-tenant cmi5 course registry — an unauth POST /content/publish-course loop with a
 *  fresh course id each time would otherwise grow it without limit into an OOM (round-42). Evict
 *  oldest past the cap; TenantPartition itself caps the number of tenants. */
const CMI5_COURSES_MAX = 5000;

/** Register a cmi5 course structure (from a parsed cmi5.xml). */
export function registerCmi5Course(tenant: TenantId, course: Cmi5Course): void {
  const m = courseRegistry.for(tenant);
  if (m.size >= CMI5_COURSES_MAX && !m.has(course.id)) { const oldest = m.keys().next().value; if (oldest !== undefined) m.delete(oldest); }
  m.set(course.id, course);
}

/** Forget a registered course structure; whether there was one. What learners already recorded of it stays. */
export function unregisterCmi5Course(tenant: TenantId, courseId: string): boolean {
  return courseRegistry.for(tenant).delete(courseId);
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
// These maps coordinate in-flight commits only; durable evidence remains in the LRS primary.
const satisfactionCommits = new Map<string, Promise<unknown>>();
/** One in-flight piece of work per key. A later call waits for the earlier, and a failure does not block the next. */
export function serializeKeyed<T>(gate: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const prior = gate.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  gate.set(key, next);
  const cleanup = (): void => { if (gate.get(key) === next) gate.delete(key); };
  void next.then(cleanup, cleanup);
  return next;
}
function serializeSatisfaction<T>(key: string, work: () => Promise<T>): Promise<T> {
  return serializeKeyed(satisfactionCommits, key, work);
}
async function rollupCourse(
  tenant: TenantId, learner: { id: string; name?: string }, authoritativeSource: string,
  emit: (statement: Record<string, unknown>) => void | Promise<void>, auId: string,
): Promise<void> {
  const course = courseContainingAu(tenant, auId);
  if (!course) return;
  await serializeSatisfaction(JSON.stringify(['rollup', tenant, course.id, learner.id]), () =>
    rollupCourseUnlocked(tenant, learner, authoritativeSource, emit, auId));
}

async function rollupCourseUnlocked(
  tenant: TenantId,
  learner: { id: string; name?: string },
  authoritativeSource: string,
  emit: (statement: Record<string, unknown>) => void | Promise<void>,
  auId: string,
): Promise<void> {
  const course = courseContainingAu(tenant, auId);
  if (!course) return;
  const key = `${tenant}|${course.id}|${learner.id}`;
  const satisfied = new Set(learnerSatisfiedAus(tenant, learner.id));
  let emitted = rollupEmitted.get(key);
  if (!emitted) { emitted = new Set(); rollupEmitted.set(key, emitted); }
  let reg = courseEnrollmentReg.get(key);
  if (!reg) { reg = randomUUID(); courseEnrollmentReg.set(key, reg); }

  const emitSatisfied = async (activityId: string): Promise<void> => {
    await emit(buildCmi5Statement({
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
      await emitSatisfied(block.id);
      emitted.add(block.id);
    }
  }
  // The course is satisfied once every AU is.
  const allAus = flatAus(course).map(a => a.id);
  if (allAus.length > 0 && allAus.every(id => satisfied.has(id)) && !emitted.has(course.id)) {
    await emitSatisfied(course.id);
    emitted.add(course.id);
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [k, v] of fetchTokens) if (v.expiresAt < now) fetchTokens.delete(k);
}

/**
 * cmi5 §10.2.3. The course structure supplies launchParameters. A launch request may replace that
 * string; it is not parsed, because the AU is what interprets it. Absent or blank sends nothing.
 */
export function launchParametersFrom(courseValue: string | undefined, requested: unknown): { ok: true; value?: string } | { ok: false; error: string } {
  const source = requested !== undefined ? requested : courseValue;
  if (source === undefined || source === null) return { ok: true };
  if (typeof source !== 'string') return { ok: false, error: 'launch_parameters must be a string' };
  const value = source.trim();
  if (value.length > LAUNCH_PARAMETERS_MAX) return { ok: false, error: `launch_parameters is longer than ${LAUNCH_PARAMETERS_MAX} characters` };
  return value ? { ok: true, value } : { ok: true };
}

/**
 * Build a conformant cmi5 launch for a learner + an AU. Registers the
 * one-time fetch token; the caller navigates the learner to `launchUrl`
 * and stages `launchData` into the LRS State resource as `LMS.LaunchData`.
 */
/**
 * The registration a personal link should continue: the open session, or a session terminated
 * before moveOn was met. Abandoned, waived, Browse, Review, and a satisfied termination do not.
 */
export function findResumableLaunch(query: { tenant: TenantId; learnerId: string; courseId: string; auId: string }): { registration: string; sessionId?: string; newSession?: boolean } | undefined {
  const key = `${query.tenant}\n${query.learnerId}\n${query.courseId}\n${query.auId}`;
  const registration = openByKey.get(key);
  if (!registration) return undefined;
  const l = launches.get(registration);
  if (!l || !l.sessionId || l.tenant !== query.tenant || l.learner.id !== query.learnerId || l.auId !== query.auId || l.courseId !== query.courseId) {
    openByKey.delete(key);
    return undefined;
  }
  if (!l.sessionClosed) return { registration: l.registration, sessionId: l.sessionId };
  // terminated without meeting moveOn is the same registration and a new session, not a new attempt.
  // Browse and Review are not judged, so ending one does not continue that registration.
  if (l.sessionClosed === 'terminated' && !l.satisfied && l.launchMode !== 'Review' && l.launchMode !== 'Browse') {
    return { registration: l.registration, newSession: true };
  }
  return undefined;
}

export function buildCmi5Launch(req: Cmi5LaunchRequest): Cmi5Launch {
  sweepExpired();
  const tenant = req.tenant ?? DEFAULT_TENANT;
  const prior = req.resume ? launches.get(req.resume.registration) : undefined;
  const same = prior
    && prior.tenant === tenant
    && prior.learner.id === req.learner.id
    && prior.auId === req.au.id
    && (!req.courseId || prior.courseId === req.courseId)
    ? prior : undefined;
  const resumed = same && !same.sessionClosed && same.sessionId && same.sessionId === req.resume?.sessionId ? same : undefined;
  const restarted = same && req.resume?.newSession && same.sessionClosed === 'terminated' && !same.satisfied && same.launchMode !== 'Review' && same.launchMode !== 'Browse' ? same : undefined;
  const continued = resumed ?? restarted;
  const registration = continued ? continued.registration : randomUUID();
  const sessionId = resumed ? resumed.sessionId! : randomUUID();
  const actor = {
    objectType: 'Agent',
    ...(req.learner.name ? { name: req.learner.name } : {}),
    account: { homePage: req.authoritativeSource, name: req.learner.id },
  };

  // The one-time fetch token + the auth-token the AU will end up with. A resumed session gets a
  // new fetch token: the previous one was single-use, and the registration stays the same.
  const fetchToken = `ft-${randomUUID()}`;
  const authToken = `cmi5-${tenant === DEFAULT_TENANT ? 'd' : '0'}-${randomUUID()}`;
  fetchTokens.set(fetchToken, {
    authToken, tenant, registration, auId: req.au.id,
    expiresAt: Date.now() + FETCH_TOKEN_TTL_MS, redeemed: false,
  });

  // Register the launch so the LMS can watch it for moveOn satisfaction. A resume keeps the
  // record it already has, including whether moveOn has been met.
  const moveOn = continued ? continued.moveOn : (req.au.moveOn ?? 'CompletedOrPassed');
  const masteryScore = continued ? continued.masteryScore : (typeof req.au.masteryScore === 'number' ? req.au.masteryScore : 1.0);
  // A relaunch keeps the mode already stored. A missing request mode must not turn Review into Normal.
  const launchMode: Cmi5LaunchMode = req.launchMode ?? continued?.launchMode ?? 'Normal';
  if (restarted) {
    restarted.sessionId = sessionId;
    restarted.sessionClosed = undefined;
    restarted.launchMode = launchMode;
    if (req.learnerPod && !restarted.learnerPod) restarted.learnerPod = req.learnerPod;
    rememberOpenLaunch(restarted);
    cmi5PodDirty();
  } else if (resumed) {
    if (req.launchMode) resumed.launchMode = req.launchMode;
    if (req.learnerPod && !resumed.learnerPod) { resumed.learnerPod = req.learnerPod; cmi5PodDirty(); }
  } else {
    launches.set(registration, {
      registration,
      auId: req.au.id,
      ...(req.au.title ? { auTitle: req.au.title } : {}),
      moveOn,
      masteryScore,
      tenant,
      learner: { id: req.learner.id, ...(req.learner.name ? { name: req.learner.name } : {}) },
      authoritativeSource: req.authoritativeSource,
      ...(req.courseId ? { courseId: req.courseId } : {}),
      ...(req.learnerPod ? { learnerPod: req.learnerPod } : {}),
      sessionId,
      launchMode,
      satisfied: false,
      reason: 'launched — awaiting the AU\'s cmi5 statements',
    });
    rememberOpenLaunch(launches.get(registration)!);
    cmi5PodDirty();
  }

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

  // The LMS.LaunchData State document (cmi5 §10.1). Its context template carries the session ID and
  // the publisher ID activity — the AU's id from the course structure, unaltered — in its grouping
  // list (§10.2.1, §9.6.2.3). An entitlement key is passed on only when the course structure gives
  // the AU one, as its value there (§10.2.7): this had sent the registration in its place.
  const launchData: Record<string, unknown> = {
    contextTemplate: {
      registration,
      contextActivities: { category: [{ id: CMI5_CATEGORY }], grouping: [{ id: req.au.id }] },
      extensions: {
        'https://w3id.org/xapi/cmi5/context/extensions/sessionid': sessionId,
      },
    },
    launchMode,
    moveOn,
    ...(typeof req.au.masteryScore === 'number' ? { masteryScore: req.au.masteryScore } : {}),
    ...(req.returnUrl ? { returnURL: req.returnUrl } : {}),
    ...(req.au.entitlementKey ? { entitlementKey: { courseStructure: req.au.entitlementKey } } : {}),
    ...(req.au.launchParameters ? { launchParameters: req.au.launchParameters } : {}),
  };

  // A resumed session already has its launched statement. A new session, including one that
  // keeps the registration after terminated left moveOn unmet, records a fresh one.
  const launched = resumed ? undefined : buildCmi5Statement({
    verb: 'launched',
    actor: { account: { homePage: req.authoritativeSource, name: req.learner.id }, ...(req.learner.name ? { name: req.learner.name } : {}) },
    session: {
      registration,
      sessionId,
      auActivityId: req.au.id,
      ...(req.courseId ? { courseActivityId: req.courseId } : {}),
    },
    launched: {
      launchMode,
      launchUrl: req.au.url,
      moveOn,
      ...(typeof req.au.masteryScore === 'number' ? { masteryScore: req.au.masteryScore } : {}),
    },
  }) as unknown as Record<string, unknown>;

  return { registration, launchUrl, actor, launchData, fetchToken, ...(launched ? { launched } : {}) };
}

/** Store the LMS `launched` statement in the launch's tenant. The id once the LRS holds it. */
export async function recordLaunchedStatement(tenant: TenantId, statement: Record<string, unknown>): Promise<string> {
  const id = await storeStatementDurably(statement, tenant);
  if (!id) throw new Error('cmi5 launched statement was not stored');
  return id;
}

/**
 * Stage a launch's `LMS.LaunchData` into the State resource (cmi5 §10.1), where the AU reads it:
 * the AU's activity id, the launch's actor as the JSON string the launch URL carries, the
 * registration. Before this, the launch returned the document and only told the caller to stage it.
 */
export async function stageLaunchData(tenant: TenantId, launch: Cmi5Launch, auId: string): Promise<void> {
  await stageStateDocument(tenant, { activityId: auId, agent: JSON.stringify(launch.actor), stateId: 'LMS.LaunchData', registration: launch.registration }, launch.launchData);
}

/**
 * The learner a registration belongs to when they launched it for themselves, with their pod,
 * but only for a statement stored in that launch's own tenant. An auth-token writes into the
 * tenant its launch minted it for, so a statement naming somebody else's registration arrives in
 * the wrong tenant and gets nothing here: nothing is kept on a pod its writer does not own.
 */
export function signedLaunchLearner(registration: string, tenant: TenantId): { did: string; podUrl: string; homePage: string } | undefined {
  const l = launches.get(registration);
  return l?.learnerPod && l.tenant === tenant ? { did: l.learner.id, podUrl: l.learnerPod, homePage: l.authoritativeSource } : undefined;
}

export type AuChoice =
  | { readonly ok: true; readonly au: Cmi5AuNode }
  | { readonly ok: false; readonly status: 404 | 409; readonly error: string; readonly missingPrerequisites?: readonly string[] };

/**
 * Which AU a learner launches: the one they name, or the first in the course they have not yet
 * satisfied. Sequential progression (cmi5 §8.1) holds either way: an AU whose predecessor is not
 * satisfied is refused, naming what is missing. A course they have finished answers with its
 * first AU, since relaunching for review is allowed.
 */
export function chooseAu(course: Cmi5Course, satisfied: ReadonlySet<string>, requested?: string): AuChoice {
  const aus = flatAus(course);
  if (aus.length === 0) return { ok: false, status: 404, error: `course ${course.id} has no assignable units` };
  const au = requested ? auById(course, requested) : (aus.find((a) => !satisfied.has(a.id)) ?? aus[0]);
  if (!au) return { ok: false, status: 404, error: `course ${course.id} has no AU ${requested}` };
  const before = precedingAu(course, au.id);
  if (before && !satisfied.has(before.id)) {
    return { ok: false, status: 409, error: `launch gated: ${before.id} comes first and is not yet satisfied`, missingPrerequisites: [before.id] };
  }
  return { ok: true, au };
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
  authTokenLaunch.set(rec.authToken, { tenant: rec.tenant, registration: rec.registration });
  return { ok: true, body: { 'auth-token': rec.authToken } };
}

/**
 * Resolve the tenant of a cmi5-issued auth-token — wired into the LRS
 * auth gate so an AU's Statements land in the launch's tenant partition.
 * Returns null for tokens this module did not mint.
 */
export function cmi5BearerTenant(token: string): TenantId | null {
  return authTokenLaunch.get(token)?.tenant ?? null;
}

/** The launch registration a cmi5-issued auth-token is bound to: the LRS holds its reads and writes to it. */
export function cmi5BearerRegistration(token: string): string | null {
  return authTokenLaunch.get(token)?.registration ?? null;
}

/**
 * The session a cmi5-issued auth-token belongs to, as this LMS holds it now: the registration the
 * token is bound to, that registration's current session, how it was launched and whether it has
 * ended. Null for a token this LMS did not issue, or a registration with no session kept.
 */
export function cmi5BearerSession(token: string): { registration: string; sessionId: string; launchMode: Cmi5LaunchMode; closed: boolean } | null {
  const bound = authTokenLaunch.get(token);
  const launch = bound ? launches.get(bound.registration) : undefined;
  if (!bound || !launch || launch.tenant !== bound.tenant || !launch.sessionId) return null;
  return { registration: launch.registration, sessionId: launch.sessionId, launchMode: launch.launchMode ?? 'Normal', closed: launch.sessionClosed !== undefined };
}

// ── moveOn orchestration — closing the cmi5 loop ─────────────────────

/** What the LMS needs to observe a registration and emit `satisfied`. */
export interface Cmi5ObserveDeps {
  /** All stored statements carrying this registration. */
  statementsForRegistration: (registration: string) => Promise<Array<Record<string, unknown>>>;
  /** Persist a statement (the `satisfied` statement) into the tenant's LRS. */
  emit: (statement: Record<string, unknown>) => void | Promise<void>;
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
  statement: Record<string, unknown>, tenant: TenantId, deps: Cmi5ObserveDeps,
): Promise<Cmi5ObserveResult | null> {
  const registration = (statement.context as { registration?: string } | undefined)?.registration;
  if (!registration) return null;
  return serializeSatisfaction(JSON.stringify(['registration', tenant, registration]), () =>
    observeCmi5StatementUnlocked(statement, tenant, deps));
}

async function observeCmi5StatementUnlocked(
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
  if (!verbId || verbId === V_SATISFIED) return null;
  // A session ends on the AU's terminated, or on abandoned / waived recorded for it. Until then
  // the same registration is the active one a personal link resumes.
  if (verbId === V_TERMINATED) closeSession(launch, 'terminated');
  else if (verbId === V_ABANDONED) closeSession(launch, 'abandoned');
  else if (verbId === V_WAIVED) closeSession(launch, 'waived');
  if (!CMI5_LIFECYCLE.has(verbId)) return null;
  // Browse and Review keep the statements and do not move satisfaction (§10.2.2).
  if (launch.launchMode === 'Review' || launch.launchMode === 'Browse') {
    return { registration, satisfied: false, reason: 'a Browse or Review launch is kept and not judged', emittedSatisfied: false };
  }
  if (launch.satisfied) {
    await rollupCourse(tenant, launch.learner, launch.authoritativeSource, deps.emit, launch.auId);
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

  // Record satisfaction only after its evidence statement has committed.
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
  await deps.emit(satisfied as unknown as Record<string, unknown>);
  launch.satisfied = true;
  launch.satisfiedAt = new Date().toISOString();
  markAuSatisfied(tenant, launch.learner.id, launch.auId);
  cmi5PodDirty();
  // Roll satisfaction up the course structure — emit `satisfied` for any
  // block now fully satisfied, and for the course once every AU is.
  await rollupCourse(tenant, launch.learner, launch.authoritativeSource, deps.emit, launch.auId);
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
    ...(l.sessionClosed ? { sessionClosed: l.sessionClosed } : {}),
  };
}

/** Attach the cmi5 LMS launch + fetch routes. */
export function attachCmi5LmsRoutes(app: Express, config: {
  selfBaseUrl: string;
  authoritativeSource: string;
  defaultLrsEndpoint?: string;
  restorePublishedCourse?: (tenant: TenantId, courseId: string) => Promise<void>;
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
  app.get('/cmi5/launch', async (req: Request, res: Response) => {
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
    if (courseId && !getCmi5Course(tenant, courseId) && config.restorePublishedCourse) {
      try { await config.restorePublishedCourse(tenant, courseId); }
      catch { res.status(503).json({ error: 'Published course storage is unavailable.' }); return; }
    }
    const course = courseId ? getCmi5Course(tenant, courseId) : undefined;
    const auNode = course ? auById(course, auId) : undefined;
    const auUrl = (req.query.au_url as string | undefined) ?? auNode?.url;
    if (!auUrl) {
      res.status(400).json({ error: 'au_url is required (or pass course_id for a registered course that contains au_id)' });
      return;
    }

    const launchParameters = launchParametersFrom(auNode?.launchParameters, req.query.launch_parameters);
    if (!launchParameters.ok) { res.status(400).json({ error: launchParameters.error }); return; }

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
        ...(auNode?.entitlementKey ? { entitlementKey: auNode.entitlementKey } : {}),
        ...(launchParameters.value ? { launchParameters: launchParameters.value } : {}),
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
    // The LMS stages LaunchData itself (cmi5 §10); this route used to hand it back and ask the caller to.
    try { await stageLaunchData(tenant, launch, auId); }
    catch { res.status(503).json({ error: 'LRS launch data storage is unavailable' }); return; }
    if (launch.launched) {
      try { await recordLaunchedStatement(tenant, launch.launched); }
      catch { res.status(503).json({ error: 'LRS launch statement storage is unavailable' }); return; }
    }
    const { launched: _launched, ...launchBody } = launch;
    res.status(200).json({
      ...launchBody,
      launchDataStaged: true,
      ...(course ? { course: { id: course.id, prerequisiteGate: structuralPrereq ?? null } } : {}),
      note: 'Navigate the learner to launchUrl. LMS.LaunchData is already staged in the State resource. The AU POSTs the fetch URL once for its auth-token. The LMS watches the registration: when the AU\'s statements meet moveOn it auto-emits `satisfied`, and rolls satisfaction up the course structure to blocks and the course.',
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

const CMI5_SESSION = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';

/** The session id a launch put in LMS.LaunchData, when it has one. */
export function cmi5SessionId(launchData: Record<string, unknown>): string | undefined {
  const template = launchData.contextTemplate as { extensions?: Record<string, unknown> } | undefined;
  const id = template?.extensions?.[CMI5_SESSION];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export interface ForgottenCmi5Launch {
  registration: string;
  podUrl?: string;
  homePage: string;
  did: string;
}

/**
 * Drop one learner's cmi5 state in this tenant: satisfied activities, launch records, open
 * sessions, unredeemed fetch tokens, and auth tokens the AU is still holding. Other learners
 * are left as they are. Pods that held a copy of the launch are returned so the caller can
 * void those copies; this does not write to a pod.
 */
export function forgetCmi5Learner(tenant: TenantId, learnerId: string): ForgottenCmi5Launch[] {
  const removed: ForgottenCmi5Launch[] = [];
  const registrations = new Set<string>();
  for (const [registration, launch] of launches) {
    if (launch.tenant !== tenant || launch.learner.id !== learnerId) continue;
    const openKey = openLaunchKey(launch);
    if (openKey && openByKey.get(openKey) === registration) openByKey.delete(openKey);
    launches.delete(registration);
    registrations.add(registration);
    removed.push({
      registration,
      ...(launch.learnerPod ? { podUrl: launch.learnerPod } : {}),
      homePage: launch.authoritativeSource,
      did: learnerId,
    });
  }
  for (const [token, rec] of fetchTokens) if (registrations.has(rec.registration) && rec.tenant === tenant) fetchTokens.delete(token);
  for (const [token, rec] of authTokenLaunch) if (registrations.has(rec.registration) && rec.tenant === tenant) authTokenLaunch.delete(token);
  // Satisfaction alone (copied in by a link, with no launch of its own) is state too: without marking
  // the snapshot, a restart would bring it back.
  const hadSatisfaction = satisfiedAus.get(tenant)?.delete(learnerId) === true;
  const prefix = `${String(tenant)}|`;
  const suffix = `|${learnerId}`;
  for (const key of rollupEmitted.keys()) if (key.startsWith(prefix) && key.endsWith(suffix)) rollupEmitted.delete(key);
  for (const key of courseEnrollmentReg.keys()) if (key.startsWith(prefix) && key.endsWith(suffix)) courseEnrollmentReg.delete(key);
  if (removed.length || hadSatisfaction) cmi5PodDirty();
  return removed;
}

/** Copy satisfied activities from one learner's lens into another's. The source lens is unchanged. */
export function copyLearnerSatisfaction(fromTenant: TenantId, fromLearnerId: string, toTenant: TenantId, toLearnerId: string): string[] {
  const ids = learnerSatisfiedAus(fromTenant, fromLearnerId);
  for (const id of ids) markAuSatisfied(toTenant, toLearnerId, id);
  return ids;
}

/** Remove activities from one learner's satisfied set. The snapshot is marked when any are removed. */
export function dropLearnerSatisfaction(tenant: TenantId, learnerId: string, auIds: readonly string[]): string[] {
  const byLearner = satisfiedAus.get(tenant);
  const set = byLearner?.get(learnerId);
  if (!set) return [];
  const removed: string[] = [];
  for (const id of auIds) if (set.delete(id)) removed.push(id);
  if (set.size === 0) byLearner!.delete(learnerId);
  if (removed.length) cmi5PodDirty();
  return removed;
}
