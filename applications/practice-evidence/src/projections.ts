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
 */
import { createHash } from 'node:crypto';
import type { AssessmentUse } from './practice.js';
import { PEV_NS } from './ontology.js';
import { anyDemoSigner, standingReview, type AttemptBody } from './records.js';

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
