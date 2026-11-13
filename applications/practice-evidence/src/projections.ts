/**
 * xAPI 2.0 statements for a reviewed attempt — documents only, built by pure functions and checked
 * by a local validator before anything is returned.
 *
 * What a statement may say (A13, DECISIONS #9):
 *   · it exists only for a countersigned or overridden head (eligibility is decided by the bridge
 *     from the pod, never from a caller-supplied status);
 *   · the verb is `completed`, with `result.success` for a pass gate: practice should not read as
 *     an achievement in an LRS report;
 *   · a feedback-only scenario carries levels and NO score and NO success;
 *   · every statement carries the practice marker, the rubric hash, the transcript hash, the judge
 *     model (provider/model, as the provider returned it or as a packet judge declared it), the
 *     judge's identity and the reviewer;
 *   · the `cmi5` format is xAPI with cmi5-ALLOWED context only: it never carries a cmi5-defined
 *     category, so practice cannot satisfy an assignable unit, and its registration and session id
 *     are derived from the attempt, not issued by an LMS.
 * Nothing is posted anywhere. The exact LRS request is returned for a person to send.
 *
 * An attempt taken from an LMS launch (`attempt.lmsLaunch`) is the one exception to the cmi5 rule
 * above: practice under a launch counts toward the assignable unit. `buildLaunchedStatements`
 * builds the cmi5 defined statements for it (passed or failed for a pass gate, and completed), on
 * the LMS's own registration, actor and activity id. cmi5 gives those statements to the assignable
 * unit to send inside a session, so they are documents for the unit: this bridge still posts
 * nothing.
 */
import { createHash } from 'node:crypto';
import type { AssessmentUse } from './practice.js';
import { PEV_NS } from './ontology.js';
import { anyDemoSigner, lmsLaunchProblems, standingReview, type AttemptBody, type LmsLaunch } from './records.js';

export type ProjectionFormat = 'xapi' | 'cmi5';
export const PROJECTION_FORMATS: readonly ProjectionFormat[] = ['xapi', 'cmi5'];
export const XAPI_VERSION = '2.0.0';
export const VERB_COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
/** ADL: "an attempted task in an artificial context that mimics reality". */
export const ACTIVITY_TYPE = 'http://adlnet.gov/expapi/activities/simulation';
export const CMI5_SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
/** Used ONLY to assert absence: no statement here carries a cmi5-defined category. */
export const CMI5_CATEGORY_PREFIX = 'https://w3id.org/xapi/cmi5/context/categories/';

const ext = (local: string): string => PEV_NS + local;
export const PRACTICE_MARKER = ext('practiceEvidence');

/** A v5-shaped UUID from a seed, so the same record always projects to the same statement id. */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed, 'utf8').digest('hex');
  const variant = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ProjectionInput {
  /** A countersigned or overridden attempt. */
  readonly attempt: AttemptBody;
  readonly headDescriptorUrl: string;
  /** The bridge's deployment URL (account.homePage). */
  readonly homePage: string;
  /** The did of the reviewer who ratified the rubric version. */
  readonly ratifiedBy: string;
}

function durationOf(startedAt: string, endedAt: string): string {
  const ms = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
  const seconds = Math.round(ms / 10) / 100;
  return `PT${Number.isFinite(seconds) ? seconds : 0}S`;
}

/** Build the statement. Throws on an attempt with no standing review (a caller defect: eligibility comes first). */
export function buildStatement(format: ProjectionFormat, i: ProjectionInput): Record<string, unknown> {
  const a = i.attempt;
  const review = standingReview(a);
  if (!review || (a.state !== 'countersigned' && a.state !== 'overridden')) throw new Error('buildStatement: the attempt has no standing review');
  const primary = a.judgments[0];
  if (!primary) throw new Error('buildStatement: the attempt has no judgment');
  const spec = a.scenarioSpec;
  const criterionLevels = Object.fromEntries(review.finalLevels.map((f) => [f.criterionId, f.levelId]));
  const x = review.assessment;
  const result: Record<string, unknown> = x.use === 'pass-gate'
    ? {
      score: { scaled: x.points / x.maxPoints, raw: x.points, min: 0, max: x.maxPoints },
      success: x.meetsPassRule, completion: true, extensions: { [ext('criterionLevels')]: criterionLevels },
    }
    : { completion: true, extensions: { [ext('criterionLevels')]: criterionLevels } };
  const endedAt = a.endedAt ?? a.startedAt;
  if (format === 'cmi5') result['duration'] = durationOf(a.startedAt, endedAt);

  const contextExt: Record<string, unknown> = {
    [PRACTICE_MARKER]: true,
    [ext('rubricHash')]: a.scenario.rubricHash,
    [ext('transcriptHash')]: a.transcriptHash ?? null,
    [ext('judgeModel')]: `${primary.disclosure.provider}/${primary.disclosure.model}`,
    [ext('judgeId')]: primary.judge.id,
    [ext('judgeRoute')]: primary.route,
    [ext('judgeChosenBy')]: primary.chosenBy,
    [ext('judgmentCount')]: a.judgments.length,
    [ext('reviewer')]: review.reviewer.did,
    [ext('reviewOutcome')]: review.outcome,
    [ext('reviewCount')]: a.reviews.length,
    [ext('sawJudgeLevelsFirst')]: review.sawJudgeLevelsFirst,
    [ext('rubricRatifiedBy')]: i.ratifiedBy,
    [ext('attemptNumber')]: a.attemptNumber,
    [ext('coached')]: a.coached,
    [ext('assessmentUse')]: spec.assessmentUse,
    [ext('workRegime')]: spec.workRegime,
    [ext('counterpartControlledBy')]: a.counterpartControlledBy,
    [ext('learnerKind')]: a.learner.kind,
    [ext('sourceRecord')]: i.headDescriptorUrl,
  };
  if (primary.disclosure.declaredBy !== undefined) contextExt[ext('declaredBy')] = primary.disclosure.declaredBy;
  if (anyDemoSigner(a)) contextExt[ext('serverHeldDemoKey')] = true;
  if (format === 'cmi5') contextExt[CMI5_SESSION_EXT] = deterministicUuid(`${a.attemptIri}|session`);

  return {
    version: XAPI_VERSION,
    id: deterministicUuid(`${a.attemptIri}|${i.headDescriptorUrl}|${format}`),
    actor: { objectType: 'Agent', account: { homePage: i.homePage, name: a.learner.did } },
    verb: { id: VERB_COMPLETED, display: { 'en-US': 'completed' } },
    object: {
      objectType: 'Activity', id: a.scenario.scenarioIri,
      definition: { name: { [spec.language]: a.scenario.title }, type: ACTIVITY_TYPE },
    },
    result,
    context: { registration: deterministicUuid(a.attemptIri), language: spec.language, extensions: contextExt },
    timestamp: endedAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/;
const DURATION = /^P(T\d+(\.\d+)?S)$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHttpUrl = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  try { const u = new URL(v); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
};
const nonEmptyMap = (v: unknown): boolean => isObj(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => typeof x === 'string' && x.length > 0);

/** Each failure as one sentence; [] means the statement passes every check. */
export function statementProblems(stmt: unknown, format: ProjectionFormat, use: AssessmentUse): string[] {
  const p: string[] = [];
  if (!isObj(stmt)) return ['the statement is not an object'];
  if (stmt['version'] !== XAPI_VERSION) p.push(`version must be ${XAPI_VERSION}`);
  if (typeof stmt['id'] !== 'string' || !UUID.test(stmt['id'])) p.push('id must be an RFC 4122 UUID');

  const actor = stmt['actor'];
  if (!isObj(actor) || actor['objectType'] !== 'Agent') p.push('actor must be an Agent');
  else {
    const ifis = ['mbox', 'mbox_sha1sum', 'openid', 'account'].filter((k) => actor[k] !== undefined);
    if (ifis.length !== 1) p.push('actor must carry exactly one identifier');
    const acc = actor['account'];
    if (ifis[0] === 'account') {
      if (!isObj(acc) || !isHttpUrl(acc['homePage'])) p.push('actor.account.homePage must be an absolute http(s) URL');
      if (!isObj(acc) || typeof acc['name'] !== 'string' || acc['name'].length === 0) p.push('actor.account.name must be non-empty');
    }
  }

  const verb = stmt['verb'];
  if (!isObj(verb) || verb['id'] !== VERB_COMPLETED) p.push('verb must be completed');
  else if (!nonEmptyMap(verb['display'])) p.push('verb.display must be a non-empty language map');

  const obj = stmt['object'];
  if (!isObj(obj) || obj['objectType'] !== 'Activity') p.push('object must be an Activity');
  else {
    if (typeof obj['id'] !== 'string' || !ABSOLUTE_IRI.test(obj['id'])) p.push('object.id must be an absolute IRI');
    const def = obj['definition'];
    if (!isObj(def) || !nonEmptyMap(def['name'])) p.push('object.definition.name must be a non-empty language map');
  }

  const result = stmt['result'];
  const extKeys: string[] = [];
  if (!isObj(result)) p.push('result is required');
  else {
    if (use === 'pass-gate') {
      const score = result['score'];
      if (!isObj(score)) p.push('a pass gate statement needs result.score');
      else {
        const { scaled, raw, min, max } = score as Record<string, unknown>;
        if (typeof scaled !== 'number' || scaled < -1 || scaled > 1) p.push('result.score.scaled must be from -1 to 1');
        if (typeof min !== 'number' || typeof max !== 'number' || !(min < max)) p.push('result.score needs min below max');
        else if (typeof raw !== 'number' || raw < min || raw > max) p.push('result.score.raw must lie between min and max');
      }
      if (typeof result['success'] !== 'boolean') p.push('a pass gate statement needs result.success');
    } else {
      if (result['score'] !== undefined) p.push('a feedback-only statement must carry no score');
      if (result['success'] !== undefined) p.push('a feedback-only statement must carry no success');
    }
    if (result['completion'] !== true) p.push('result.completion must be true');
    if (isObj(result['extensions'])) extKeys.push(...Object.keys(result['extensions']));
    if (format === 'cmi5' && (typeof result['duration'] !== 'string' || !DURATION.test(result['duration']))) {
      p.push('a cmi5-context statement needs result.duration as PT<seconds>S');
    }
  }

  if (typeof stmt['timestamp'] !== 'string' || !ISO_WITH_OFFSET.test(stmt['timestamp'])) p.push('timestamp must be ISO 8601 with an offset');

  const ctx = stmt['context'];
  if (!isObj(ctx)) p.push('context is required');
  else {
    if (typeof ctx['registration'] !== 'string' || !UUID.test(ctx['registration'])) p.push('context.registration must be a UUID');
    const cext = isObj(ctx['extensions']) ? ctx['extensions'] : {};
    extKeys.push(...Object.keys(cext));
    if (cext[PRACTICE_MARKER] !== true) p.push('the practice marker must be present and true');
    const ca = ctx['contextActivities'];
    const cats = isObj(ca) && Array.isArray(ca['category']) ? ca['category'] as unknown[] : [];
    if (cats.some((c) => isObj(c) && typeof c['id'] === 'string' && c['id'].startsWith(CMI5_CATEGORY_PREFIX))) {
      p.push('practice statements carry no cmi5-defined category');
    }
    if (format === 'cmi5' && (typeof cext[CMI5_SESSION_EXT] !== 'string' || !UUID.test(cext[CMI5_SESSION_EXT] as string))) {
      p.push('a cmi5-context statement needs the session id extension');
    }
  }
  if (isObj(obj) && isObj(obj['definition']) && isObj(obj['definition']['extensions'])) extKeys.push(...Object.keys(obj['definition']['extensions']));
  const relative = extKeys.filter((k) => !ABSOLUTE_IRI.test(k));
  if (relative.length > 0) p.push(`extension keys must be absolute IRIs: ${relative.join(', ')}`);
  return p;
}

/** What each projection leaves out. Stored in every audit row and returned with every statement. */
const LOSSY_COMMON: readonly string[] = [
  'carries levels, not the quotes or their offsets',
  'carries the transcript hash, not the transcript',
  'carries the reviewer, not the reviewer\'s grounds',
  'carries the primary judge; other judgments are in the record',
  'on the packet route the judge model is as the judge declared it (declaredBy names who), not measured',
  'attemptNumber counts attempts by this signing key on this scenario, not by this person: a new key starts again at 1',
  'coached is what the learner declared when starting, not checked',
  'the full record is referenced by descriptor URL',
];

export const LOSSY: Readonly<Record<'xapi' | 'cmi5' | 'scorm', readonly string[]>> = {
  xapi: LOSSY_COMMON,
  cmi5: [
    ...LOSSY_COMMON,
    'no LMS launched this session: the registration and session ids are derived from the attempt, not issued by an LMS, so an LMS will not match this statement to an enrolment',
    'carries no cmi5-defined category: practice does not satisfy an assignable unit',
  ],
  scorm: [
    'not built: a SCORM write is made by content in the browser, so it would carry a score without its provenance',
  ],
};

/** The request a person sends, with their own LRS credentials, to store a statement. */
export const LRS_REQUEST_NOTE = {
  method: 'POST',
  path: '<your LRS endpoint>/statements',
  headers: { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0' },
  note: 'This bridge posts nothing. Send the statement with your own LRS credentials; the statement id is fixed, so sending it twice stores it once.',
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  An attempt taken from an LMS launch: the cmi5 defined statements the assignable unit sends
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const VERB_PASSED = 'http://adlnet.gov/expapi/verbs/passed';
export const VERB_FAILED = 'http://adlnet.gov/expapi/verbs/failed';
export const CMI5_CATEGORY = `${CMI5_CATEGORY_PREFIX}cmi5`;
export const CMI5_MOVEON_CATEGORY = `${CMI5_CATEGORY_PREFIX}moveon`;
export const CMI5_MASTERY_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore';

export type LaunchedVerb = 'passed' | 'failed' | 'completed';
const LAUNCHED_VERB_IRI: Readonly<Record<LaunchedVerb, string>> = { passed: VERB_PASSED, failed: VERB_FAILED, completed: VERB_COMPLETED };

/** The session the statements will be sent in. It may be a later session of the same registration than the conversation's. */
export interface SendingSession { readonly sessionId: string; readonly at: string }

const scaledOf = (points: number, maxPoints: number): number => (maxPoints > 0 ? points / maxPoints : 0);

/**
 * Why no cmi5 defined statement may be built for this attempt; [] when they may.
 * A reviewed result that passes the rubric's rule below the launch's masteryScore (or fails it at
 * or above) fits neither passed nor failed as cmi5 defines them, so it is refused, not rounded.
 */
export function launchedRefusals(a: AttemptBody): string[] {
  const l = a.lmsLaunch;
  if (!l) return ['no LMS launched this attempt: it satisfies no assignable unit'];
  const bad = lmsLaunchProblems(l);
  if (bad.length > 0) return bad.map((b) => `the stored launch is not usable: ${b}`);
  const p: string[] = [];
  if (l.launchMode !== 'Normal') p.push(`the launch mode was ${l.launchMode}: cmi5 allows passed, failed and completed only in a Normal launch`);
  const review = standingReview(a);
  if (!review || (a.state !== 'countersigned' && a.state !== 'overridden')) { p.push('the attempt has no standing review'); return p; }
  if (!a.judgments[0]) { p.push('the attempt has no judgment'); return p; }
  const x = review.assessment;
  if (x.use === 'pass-gate' && l.masteryScore !== undefined) {
    const scaled = scaledOf(x.points, x.maxPoints);
    if (x.meetsPassRule && scaled < l.masteryScore) p.push(`the reviewed result meets the rubric's pass rule at a scaled score of ${scaled}, below the launch's masteryScore ${l.masteryScore}: cmi5 allows no passed below it`);
    if (!x.meetsPassRule && scaled >= l.masteryScore) p.push(`the reviewed result does not meet the rubric's pass rule at a scaled score of ${scaled}, at or above the launch's masteryScore ${l.masteryScore}: cmi5 allows no failed at or above it`);
  }
  return p;
}

const objOf = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});

function launchedContext(l: LmsLaunch, sessionId: string, extensions: Readonly<Record<string, unknown>>, language: string): Record<string, unknown> {
  const template = objOf(l.contextTemplate);
  const templateCa = objOf(template['contextActivities']);
  const templateCats = Array.isArray(templateCa['category']) ? (templateCa['category'] as unknown[]) : [];
  const ours = [CMI5_CATEGORY, CMI5_MOVEON_CATEGORY];
  const kept = templateCats.filter((c) => !(isObj(c) && ours.includes(c['id'] as string)));
  return {
    ...template,
    registration: l.registration,
    language,
    contextActivities: { ...templateCa, category: [...kept, ...ours.map((id) => ({ objectType: 'Activity', id }))] },
    extensions: { ...objOf(template['extensions']), ...extensions, [CMI5_SESSION_EXT]: sessionId },
  };
}

/**
 * The cmi5 defined statements for a reviewed attempt taken from an LMS launch, in the order the
 * assignable unit sends them: passed or failed (a pass gate only), then completed.
 * Throws when `launchedRefusals` is not empty (a caller defect: eligibility comes first).
 */
export function buildLaunchedStatements(i: ProjectionInput, sendIn: SendingSession): Record<string, unknown>[] {
  const a = i.attempt;
  const refusals = launchedRefusals(a);
  if (refusals.length > 0) throw new Error(`buildLaunchedStatements: ${refusals[0]}`);
  const l = a.lmsLaunch as LmsLaunch;
  const review = standingReview(a)!;
  const primary = a.judgments[0]!;
  const spec = a.scenarioSpec;
  const x = review.assessment;
  const duration = durationOf(a.startedAt, a.endedAt ?? a.startedAt);
  const criterionLevels = Object.fromEntries(review.finalLevels.map((f) => [f.criterionId, f.levelId]));
  const pevExt: Record<string, unknown> = {
    [PRACTICE_MARKER]: true,
    [ext('rubricHash')]: a.scenario.rubricHash,
    [ext('transcriptHash')]: a.transcriptHash ?? null,
    [ext('judgeModel')]: `${primary.disclosure.provider}/${primary.disclosure.model}`,
    [ext('judgeId')]: primary.judge.id,
    [ext('judgeRoute')]: primary.route,
    [ext('reviewer')]: review.reviewer.did,
    [ext('reviewOutcome')]: review.outcome,
    [ext('rubricRatifiedBy')]: i.ratifiedBy,
    [ext('scenario')]: a.scenario.scenarioIri,
    [ext('assessmentUse')]: spec.assessmentUse,
    [ext('lmsSessionId')]: l.sessionId,
    [ext('sourceRecord')]: i.headDescriptorUrl,
  };
  if (l.masteryScore !== undefined) pevExt[CMI5_MASTERY_EXT] = l.masteryScore;
  const context = launchedContext(l, sendIn.sessionId, pevExt, spec.language);
  const statement = (verb: LaunchedVerb, result: Record<string, unknown>): Record<string, unknown> => ({
    version: XAPI_VERSION,
    id: deterministicUuid(`${a.attemptIri}|${i.headDescriptorUrl}|launched|${verb}|${sendIn.sessionId}`),
    actor: { objectType: 'Agent', account: { homePage: l.actor.homePage, name: l.actor.name } },
    verb: { id: LAUNCHED_VERB_IRI[verb], display: { 'en-US': verb } },
    object: { objectType: 'Activity', id: l.activityId },
    result,
    context,
    timestamp: sendIn.at,
  });
  const out: Record<string, unknown>[] = [];
  if (x.use === 'pass-gate') {
    out.push(statement(x.meetsPassRule ? 'passed' : 'failed', {
      score: { scaled: scaledOf(x.points, x.maxPoints), raw: x.points, min: 0, max: x.maxPoints },
      success: x.meetsPassRule, duration, extensions: { [ext('criterionLevels')]: criterionLevels },
    }));
  }
  out.push(statement('completed', { completion: true, duration, extensions: { [ext('criterionLevels')]: criterionLevels } }));
  return out;
}

/** Each failure as one sentence; [] means the statement is a cmi5 defined statement of this launch. */
export function launchedStatementProblems(stmt: unknown, l: LmsLaunch, sendIn: SendingSession): string[] {
  const p: string[] = [];
  if (!isObj(stmt)) return ['the statement is not an object'];
  if (stmt['version'] !== XAPI_VERSION) p.push(`version must be ${XAPI_VERSION}`);
  if (typeof stmt['id'] !== 'string' || !UUID.test(stmt['id'])) p.push('id must be an RFC 4122 UUID');
  const actor = stmt['actor'];
  const acc = isObj(actor) ? actor['account'] : undefined;
  if (!isObj(actor) || actor['objectType'] !== 'Agent' || !isObj(acc) || acc['homePage'] !== l.actor.homePage || acc['name'] !== l.actor.name) {
    p.push('actor must be the account the LMS launched');
  }
  const verbId = isObj(stmt['verb']) ? stmt['verb']['id'] : undefined;
  const verb = (Object.keys(LAUNCHED_VERB_IRI) as LaunchedVerb[]).find((v) => LAUNCHED_VERB_IRI[v] === verbId);
  if (!verb) p.push('verb must be passed, failed or completed');
  const obj = stmt['object'];
  if (!isObj(obj) || obj['objectType'] !== 'Activity' || obj['id'] !== l.activityId) p.push('object must be the launched activity');
  const result = stmt['result'];
  if (!isObj(result)) p.push('result is required');
  else {
    if (typeof result['duration'] !== 'string' || !DURATION.test(result['duration'])) p.push('a cmi5 defined statement needs result.duration as PT<seconds>S');
    const score = result['score'];
    const scaled = isObj(score) ? score['scaled'] : undefined;
    if (verb === 'completed') {
      if (result['completion'] !== true) p.push('completed needs result.completion true');
      if (result['success'] !== undefined || score !== undefined) p.push('completed carries no success and no score');
    } else if (verb) {
      if (result['success'] !== (verb === 'passed')) p.push(`${verb} needs result.success ${verb === 'passed'}`);
      if (result['completion'] !== undefined) p.push(`${verb} carries no completion`);
      if (typeof scaled !== 'number' || scaled < -1 || scaled > 1) p.push('result.score.scaled must be from -1 to 1');
      else if (l.masteryScore !== undefined) {
        if (verb === 'passed' && scaled < l.masteryScore) p.push('passed needs a scaled score at or above the masteryScore');
        if (verb === 'failed' && scaled >= l.masteryScore) p.push('failed needs a scaled score below the masteryScore');
      }
    }
  }
  if (stmt['timestamp'] !== sendIn.at || !ISO_WITH_OFFSET.test(sendIn.at)) p.push('timestamp must be the sending time, ISO 8601 with an offset');
  const ctx = stmt['context'];
  if (!isObj(ctx)) p.push('context is required');
  else {
    if (ctx['registration'] !== l.registration) p.push('context.registration must be the registration the LMS issued');
    const cext = objOf(ctx['extensions']);
    if (cext[CMI5_SESSION_EXT] !== sendIn.sessionId) p.push('the session id extension must be the session the statement is sent in');
    if (cext[PRACTICE_MARKER] !== true) p.push('the practice marker must be present and true');
    if (l.masteryScore !== undefined && verb !== 'completed' && cext[CMI5_MASTERY_EXT] !== l.masteryScore) p.push('the masteryScore extension must carry the masteryScore of the launch');
    const ca = objOf(ctx['contextActivities']);
    const cats = (Array.isArray(ca['category']) ? ca['category'] as unknown[] : []).map((c) => (isObj(c) ? c['id'] : undefined));
    for (const need of [CMI5_CATEGORY, CMI5_MOVEON_CATEGORY]) {
      if (cats.filter((c) => c === need).length !== 1) p.push(`context must carry the category ${need} once`);
    }
    // cmi5 9.6.2: every context activity the launch's contextTemplate gave is carried, under the same property.
    for (const [kind, given] of Object.entries(objOf(objOf(l.contextTemplate)['contextActivities']))) {
      const carried = new Set((Array.isArray(ca[kind]) ? ca[kind] as unknown[] : [ca[kind]]).map((x) => JSON.stringify(x)));
      const missing = (Array.isArray(given) ? given : [given]).filter((x) => !carried.has(JSON.stringify(x)));
      if (missing.length > 0) p.push(`the contextTemplate ${kind} activities must be carried unchanged`);
    }
    for (const [k, v] of Object.entries(objOf(objOf(l.contextTemplate)['extensions']))) {
      if (k !== CMI5_SESSION_EXT && JSON.stringify(cext[k]) !== JSON.stringify(v)) p.push(`the contextTemplate extension ${k} must be carried unchanged`);
    }
    const relative = Object.keys(cext).filter((k) => !ABSOLUTE_IRI.test(k));
    if (relative.length > 0) p.push(`extension keys must be absolute IRIs: ${relative.join(', ')}`);
  }
  return p;
}

/** What the launched statements leave out. Returned with them. */
export const LOSSY_LAUNCHED: readonly string[] = [
  'carries levels, not the quotes or their offsets',
  'carries the transcript hash, not the transcript',
  'carries the reviewer, not the grounds of the review',
  'carries the primary judge; other judgments are in the record',
  'the duration is that of the conversation, not the time since the launch',
  'built for the assignable unit to send inside a session of the registration: this bridge posts nothing',
  'the full record is referenced by descriptor URL',
];
