/**
 * Foxxi cmi5 statement emitter — full IEEE 9274.2.1 / cmi5 Profile
 * Specification statement suite.
 *
 * The cmi5 profile defines 9 specific xAPI statement types an
 * Assignable Unit (AU) MUST emit at the right points in its lifecycle.
 * This module produces canonical cmi5-shaped xAPI Statement JSON for
 * each of the 9; the substrate's lrs-adapter then projects them to a
 * connected LRS using the existing pod-publisher path.
 *
 * Reference: cmi5 v1.0 — https://aicc.github.io/CMI-5_Spec_Current/
 *
 * The 9 statements (one per cmi5 §9):
 *   1. launched     — issuer (LMS) launches AU; precedes any AU-emitted statement
 *   2. initialized  — AU acknowledges launch + has loaded
 *   3. completed    — AU reports learner met completion criteria
 *   4. passed       — AU reports learner met mastery criteria (with score)
 *   5. failed       — AU reports learner did not meet mastery criteria
 *   6. abandoned    — AU reports learner exited without completing (timeout, navigation)
 *   7. waived       — LMS records that completion was administratively granted
 *   8. terminated   — AU acknowledges session end; required after completed/passed/failed
 *   9. satisfied    — LMS records that all moveOn criteria for the AU were met
 *
 * Each statement carries:
 *   - actor   — learner's mbox (`mailto:` IRI per cmi5) or account (IRI + homePage)
 *   - verb    — the cmi5-defined verb IRI
 *   - object  — the AU's activity IRI
 *   - context — sessionId, contextActivities.category = cmi5 profile IRI,
 *               registration UUID (cmi5 session-id), publisherId
 *   - result  — score (passed/failed), success/completion flags, duration ISO 8601
 *   - timestamp
 */

const CMI5_CONTEXT_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const CMI5_MOVEON_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/moveon';

const VERBS = {
  launched:    'http://adlnet.gov/expapi/verbs/launched',
  initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed:   'http://adlnet.gov/expapi/verbs/completed',
  passed:      'http://adlnet.gov/expapi/verbs/passed',
  failed:      'http://adlnet.gov/expapi/verbs/failed',
  abandoned:   'https://w3id.org/xapi/adl/verbs/abandoned',
  waived:      'https://w3id.org/xapi/adl/verbs/waived',
  terminated:  'http://adlnet.gov/expapi/verbs/terminated',
  satisfied:   'https://w3id.org/xapi/adl/verbs/satisfied',
} as const;

const VERB_DISPLAYS: Record<keyof typeof VERBS, string> = {
  launched: 'launched',
  initialized: 'initialized',
  completed: 'completed',
  passed: 'passed',
  failed: 'failed',
  abandoned: 'abandoned',
  waived: 'waived',
  terminated: 'terminated',
  satisfied: 'satisfied',
};

export type Cmi5Verb = keyof typeof VERBS;

export interface Cmi5Actor {
  /** Either mbox (mailto:) OR account (homePage + name) per cmi5 §6.1.1. */
  mbox?: string;
  account?: { homePage: string; name: string };
  name?: string;
}

export interface Cmi5Session {
  /** UUID per cmi5 §10.1 — unique per AU launch. Becomes context.registration. */
  registration: string;
  /** Cmi5-defined Session ID extension (also registration-aligned in our shape). */
  sessionId?: string;
  /** Publisher identifier (institution / tenant) IRI. */
  publisherId?: string;
  /** AU activity IRI. */
  auActivityId: string;
  /** Optional parent (course) activity IRI for contextActivities.parent. */
  courseActivityId?: string;
  /** Optional ISO 8601 launch time. */
  launchedAt?: string;
}

export interface Cmi5Result {
  /** Score (0..1 normalized scaled). cmi5 §9.5 requires for passed/failed. */
  scoreScaled?: number;
  scoreRaw?: number;
  scoreMin?: number;
  scoreMax?: number;
  /** ISO 8601 duration string (e.g. PT5M30S). cmi5 §9.4 strongly recommends. */
  duration?: string;
  success?: boolean;
  completion?: boolean;
  response?: string;
}

export interface Cmi5StatementInput {
  verb: Cmi5Verb;
  actor: Cmi5Actor;
  session: Cmi5Session;
  result?: Cmi5Result;
  timestamp?: string;
}

export interface Cmi5Statement {
  actor: Cmi5Actor & { objectType: 'Agent' };
  verb: { id: string; display: { 'en-US': string } };
  object: {
    id: string;
    objectType: 'Activity';
    definition?: { type?: string; name?: { 'en-US': string }; description?: { 'en-US': string } };
  };
  context: {
    registration: string;
    contextActivities: {
      category: Array<{ id: string; objectType: 'Activity' }>;
      parent?: Array<{ id: string; objectType: 'Activity' }>;
    };
    extensions?: Record<string, unknown>;
  };
  result?: {
    score?: { scaled?: number; raw?: number; min?: number; max?: number };
    duration?: string;
    success?: boolean;
    completion?: boolean;
    response?: string;
  };
  timestamp: string;
}

/**
 * Build a single cmi5-conformant xAPI Statement. Pure function — no I/O.
 * Caller hands the statement to the lrs-adapter for projection to a
 * real LRS, or to publish_context for substrate-side persistence.
 */
export function buildCmi5Statement(input: Cmi5StatementInput): Cmi5Statement {
  const verbId = VERBS[input.verb];
  const display = VERB_DISPLAYS[input.verb];
  const now = input.timestamp ?? new Date().toISOString();

  // Validate cmi5 invariants per spec (fail-loud).
  if ((input.verb === 'passed' || input.verb === 'failed') && (input.result?.scoreScaled === undefined)) {
    throw new Error(`cmi5 ${input.verb} statement requires result.score.scaled (§9.5)`);
  }
  if (input.verb === 'completed' && input.result?.completion === false) {
    throw new Error('cmi5 completed statement must not set result.completion=false (§9.3)');
  }

  const stmt: Cmi5Statement = {
    actor: { ...input.actor, objectType: 'Agent' },
    verb: { id: verbId, display: { 'en-US': display } },
    object: {
      id: input.session.auActivityId,
      objectType: 'Activity',
      definition: { type: 'http://adlnet.gov/expapi/activities/lesson' },
    },
    context: {
      registration: input.session.registration,
      contextActivities: {
        category: [{ id: CMI5_CONTEXT_CATEGORY, objectType: 'Activity' }],
      },
    },
    timestamp: now,
  };

  if (input.session.courseActivityId) {
    stmt.context.contextActivities.parent = [
      { id: input.session.courseActivityId, objectType: 'Activity' },
    ];
  }

  // cmi5 §10 — moveOn / satisfied / waived statements MUST also reference
  // the moveOn category in addition to the cmi5 base category.
  if (input.verb === 'satisfied' || input.verb === 'waived') {
    stmt.context.contextActivities.category.push({ id: CMI5_MOVEON_CATEGORY, objectType: 'Activity' });
  }

  if (input.session.sessionId || input.session.publisherId) {
    stmt.context.extensions = {};
    if (input.session.sessionId) {
      stmt.context.extensions['https://w3id.org/xapi/cmi5/context/extensions/sessionid'] = input.session.sessionId;
    }
    if (input.session.publisherId) {
      // publisherId is NOT a cmi5-defined context extension — carry it under the
      // dereferenceable Foxxi namespace, not the cmi5 IRI prefix, so emitted
      // statements don't claim a cmi5 extension the cmi5 ontology doesn't define.
      stmt.context.extensions['https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#publisherId'] = input.session.publisherId;
    }
  }

  if (input.result) {
    stmt.result = {};
    if (input.result.scoreScaled !== undefined || input.result.scoreRaw !== undefined) {
      stmt.result.score = {};
      if (input.result.scoreScaled !== undefined) stmt.result.score.scaled = input.result.scoreScaled;
      if (input.result.scoreRaw !== undefined) stmt.result.score.raw = input.result.scoreRaw;
      if (input.result.scoreMin !== undefined) stmt.result.score.min = input.result.scoreMin;
      if (input.result.scoreMax !== undefined) stmt.result.score.max = input.result.scoreMax;
    }
    if (input.result.duration) stmt.result.duration = input.result.duration;
    if (input.result.success !== undefined) stmt.result.success = input.result.success;
    if (input.result.completion !== undefined) stmt.result.completion = input.result.completion;
    if (input.result.response !== undefined) stmt.result.response = input.result.response;
  }

  return stmt;
}

// ── Mastery / moveOn decision logic (cmi5 §11) ───────────────

export interface MoveOnDecisionInput {
  /** Most recent scoreScaled the learner achieved on this AU (0..1). */
  scoreScaled?: number;
  /** Mastery threshold from the AU's moveOn criterion (0..1). cmi5 defines NO default —
   *  masteryScore is optional; when the AU omits it, the AU itself determines mastery. */
  masteryScore: number;
  /** AU-defined moveOn rule (cmi5 §13.1.5). */
  moveOnRule: 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';
  passed?: boolean;
  completed?: boolean;
}

export interface MoveOnDecision {
  satisfied: boolean;
  reason: string;
}

/**
 * Apply cmi5 §11 moveOn evaluation. Returns whether the learner has
 * satisfied the AU sufficiently to move on to the next AU in the
 * course block. The result drives whether a `satisfied` statement is
 * subsequently emitted by the LMS.
 */
export function evaluateMoveOn(input: MoveOnDecisionInput): MoveOnDecision {
  const passed = input.passed ?? (input.scoreScaled !== undefined && input.scoreScaled >= input.masteryScore);
  const completed = input.completed ?? false;

  switch (input.moveOnRule) {
    case 'NotApplicable':
      return { satisfied: true, reason: 'moveOn=NotApplicable; AU does not gate progress' };
    case 'Passed':
      return { satisfied: passed, reason: passed
        ? `passed (scaled ${input.scoreScaled} >= ${input.masteryScore})`
        : `not passed (scaled ${input.scoreScaled ?? 'n/a'} < ${input.masteryScore})` };
    case 'Completed':
      return { satisfied: completed, reason: completed ? 'completed' : 'not completed' };
    case 'CompletedAndPassed':
      return { satisfied: completed && passed, reason: `completed=${completed} AND passed=${passed}` };
    case 'CompletedOrPassed':
      return { satisfied: completed || passed, reason: `completed=${completed} OR passed=${passed}` };
  }
}

// ── Convenience: build a launch→initialize→completed→passed→terminated session ──

/**
 * Build a canonical cmi5 session trace for a learner who passed an AU.
 * Used by the bridge's `foxxi.emit_cmi5_session` affordance to record
 * an entire session in one tool call (rather than emitting each
 * statement individually). All 5 cmi5 lifecycle statements emitted in
 * spec-required order with shared session/registration.
 */
export function buildPassedSessionTrace(args: {
  actor: Cmi5Actor;
  session: Cmi5Session;
  scoreScaled: number;
  masteryScore: number;
  durationIso: string;
  moveOnRule?: 'Passed' | 'Completed' | 'CompletedAndPassed' | 'CompletedOrPassed' | 'NotApplicable';
}): Cmi5Statement[] {
  const launchedAt = args.session.launchedAt ?? new Date().toISOString();
  const init = new Date(Date.parse(launchedAt) + 100).toISOString();
  const completed = new Date(Date.parse(launchedAt) + 60_000).toISOString();
  const passed = new Date(Date.parse(completed) + 100).toISOString();
  const terminated = new Date(Date.parse(passed) + 200).toISOString();

  const trace: Cmi5Statement[] = [
    buildCmi5Statement({ verb: 'launched', actor: args.actor, session: args.session, timestamp: launchedAt }),
    buildCmi5Statement({ verb: 'initialized', actor: args.actor, session: args.session, timestamp: init }),
    buildCmi5Statement({ verb: 'completed', actor: args.actor, session: args.session, timestamp: completed, result: { completion: true, duration: args.durationIso } }),
    buildCmi5Statement({ verb: 'passed', actor: args.actor, session: args.session, timestamp: passed, result: { scoreScaled: args.scoreScaled, success: true, duration: args.durationIso } }),
    buildCmi5Statement({ verb: 'terminated', actor: args.actor, session: args.session, timestamp: terminated, result: { duration: args.durationIso } }),
  ];

  // If moveOn satisfied, emit a satisfied statement.
  if (args.moveOnRule && args.moveOnRule !== 'NotApplicable') {
    const decision = evaluateMoveOn({
      scoreScaled: args.scoreScaled,
      masteryScore: args.masteryScore,
      moveOnRule: args.moveOnRule,
      passed: args.scoreScaled >= args.masteryScore,
      completed: true,
    });
    if (decision.satisfied) {
      const satisfiedAt = new Date(Date.parse(terminated) + 100).toISOString();
      trace.push(buildCmi5Statement({ verb: 'satisfied', actor: args.actor, session: args.session, timestamp: satisfiedAt }));
    }
  }

  return trace;
}
