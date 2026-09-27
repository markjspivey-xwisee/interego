/**
 * A composition projected as a cmi5 course, for an LMS that knows nothing of Foxxi.
 *
 * ★ ONE AU, RESOLVED PER LEARNER. A cmi5 course lists its AUs when it is published, and a
 * composition decides its steps for each learner when it is played. So the projection is one AU,
 * the composition itself. Its page is the bridge's player (composition-au-page.ts): it resolves
 * the composition for the learner the LMS launches, plays it step by step, and grades on the
 * bridge. The LMS sees one course, one AU and an attempt; the learner gets what resolution chose.
 *
 * ★ THE LMS KEEPS THE RECORD. Every statement goes to the LRS the launch names, with the token the
 * LMS gave (cmi5 §8): `initialized` first, the play's statements as cmi5 allowed statements, then
 * `completed`, then `passed` or `failed` when there is a mastery score to judge by, and
 * `terminated` last (cmi5 §9.3). Each carries the LMS's context template (§10.2.1) and its
 * registration, and only the cmi5 defined ones carry the cmi5 category (§7.1.3).
 *
 * ★ A LEARNER THE BRIDGE CANNOT VERIFY IS NOT COUNTED. The LMS names its learner as an xAPI actor,
 * which the bridge cannot check. So a projected play resolves with no record (nothing skipped as
 * demonstrated, nothing admitted from kept admissions), and adds nothing to what has worked.
 */
import type { Composition } from './compositions.js';
import { PLAY_TYPES, type Statement } from './composition-play.js';

export const CMI5_IRIS = {
  structure: 'https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd',
  category: 'https://w3id.org/xapi/cmi5/context/categories/cmi5',
  sessionId: 'https://w3id.org/xapi/cmi5/context/extensions/sessionid',
  masteryScore: 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore',
} as const;

const ADL_VERBS = 'http://adlnet.gov/expapi/verbs';
export type DefinedVerb = 'initialized' | 'completed' | 'passed' | 'failed' | 'terminated';

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The AU a composition projects as: its IRI with a fragment, so the course and its one AU are told apart. */
export const auIdOf = (compositionIri: string): string => `${compositionIri}#au`;

/**
 * The course structure (cmi5 §13): the composition as the course, and one AU that completes when
 * the play does. The LMS may set its own moveOn and mastery score when it assigns the course.
 */
export function compositionCourseStructure(c: Composition, auUrl: string): string {
  const described = `A path of ${c.positions.length} position${c.positions.length === 1 ? '' : 's'}, resolved for each learner from their own record.`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<courseStructure xmlns="${CMI5_IRIS.structure}">
  <course id="${xml(c['@id'])}">
    <title><langstring lang="en">${xml(c.title)}</langstring></title>
    <description><langstring lang="en">${xml(described)}</langstring></description>
  </course>
  <au id="${xml(auIdOf(c['@id']))}" moveOn="Completed" launchMethod="AnyWindow">
    <title><langstring lang="en">${xml(c.title)}</langstring></title>
    <description><langstring lang="en">${xml(described)}</langstring></description>
    <url>${xml(auUrl)}</url>
  </au>
</courseStructure>
`;
}

/** What an attempt is launched with: the LMS's learner and registration, the AU as the LMS names it, and LMS.LaunchData. */
export interface Cmi5Attempt {
  actor: Record<string, unknown>;
  registration: string;
  activityId: string;
  /** LMS.LaunchData's contextTemplate (cmi5 §10.2.1): every statement's context starts from it. */
  contextTemplate?: Record<string, unknown>;
  masteryScore?: number;
  moveOn?: string;
  /** LaunchData's launchMode (cmi5 §10.2.2): a Browse or Review launch is not judged. */
  launchMode?: 'Normal' | 'Browse' | 'Review';
}

export const CMI5_MOVE_ON = ['Passed', 'Completed', 'CompletedAndPassed', 'CompletedOrPassed', 'NotApplicable'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The attempt a launch describes, checked, or a reason it cannot be one. */
export function cmi5AttemptFrom(b: Record<string, unknown>): Cmi5Attempt | string {
  const actor = b.actor as Record<string, unknown> | undefined;
  const account = actor?.account as { homePage?: unknown; name?: unknown } | undefined;
  const named = typeof actor?.mbox === 'string' ? /^mailto:\S+@\S+$/.test(actor.mbox)
    : !!account && typeof account.homePage === 'string' && typeof account.name === 'string' && !!account.name;
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || !named || JSON.stringify(actor).length > 2000) return 'actor is the Agent the LMS launched, with an account or an mbox';
  if (typeof b.registration !== 'string' || !UUID.test(b.registration)) return 'registration is the launch\'s registration UUID';
  if (typeof b.activityId !== 'string' || b.activityId.length > 500 || !/^(https?|urn):\S+$/.test(b.activityId)) return 'activityId is the AU\'s activity IRI from the launch';
  const template = b.contextTemplate;
  if (template !== undefined && (!template || typeof template !== 'object' || Array.isArray(template) || JSON.stringify(template).length > 8000)) return 'contextTemplate is LMS.LaunchData\'s context template';
  if (b.masteryScore !== undefined && (typeof b.masteryScore !== 'number' || b.masteryScore < 0 || b.masteryScore > 1)) return 'masteryScore is between 0 and 1';
  if (b.moveOn !== undefined && !CMI5_MOVE_ON.includes(String(b.moveOn))) return `moveOn is one of ${CMI5_MOVE_ON.join(', ')}`;
  if (b.launchMode !== undefined && !['Normal', 'Browse', 'Review'].includes(String(b.launchMode))) return 'launchMode is Normal, Browse or Review';
  return {
    actor, registration: b.registration, activityId: b.activityId,
    ...(template ? { contextTemplate: template as Record<string, unknown> } : {}),
    ...(typeof b.masteryScore === 'number' ? { masteryScore: b.masteryScore } : {}),
    ...(b.moveOn !== undefined ? { moveOn: String(b.moveOn) } : {}),
    ...(b.launchMode !== undefined ? { launchMode: String(b.launchMode) as Cmi5Attempt['launchMode'] } : {}),
  };
}

type Ctx = { registration?: string; contextActivities?: Record<string, unknown>; extensions?: Record<string, unknown>; [k: string]: unknown };

/**
 * A statement's context in this attempt: the LMS's template, the statement's own context added to
 * it (its parents, its extensions), the attempt's registration, and for a cmi5 defined statement
 * the cmi5 category. What the template sets, the statement does not override.
 */
export function attemptContext(attempt: Cmi5Attempt, own?: Record<string, unknown>, defined = false): Record<string, unknown> {
  const template = structuredClone((attempt.contextTemplate ?? {}) as Ctx);
  const mine = structuredClone((own ?? {}) as Ctx);
  const activities: Record<string, unknown[]> = {};
  for (const source of [mine.contextActivities, template.contextActivities]) {
    for (const [kind, list] of Object.entries(source ?? {})) {
      const items = Array.isArray(list) ? list : [list];
      const held = activities[kind] ?? [];
      for (const a of items) if (!held.some(h => (h as { id?: unknown })?.id === (a as { id?: unknown })?.id)) held.push(a);
      activities[kind] = held;
    }
  }
  if (defined) {
    const categories = activities.category ?? [];
    if (!categories.some(c => (c as { id?: unknown })?.id === CMI5_IRIS.category)) categories.push({ id: CMI5_IRIS.category, objectType: 'Activity' });
    activities.category = categories;
  } else if (activities.category) {
    // A cmi5 allowed statement does not carry the cmi5 category (§7.1.3).
    activities.category = activities.category.filter(c => (c as { id?: unknown })?.id !== CMI5_IRIS.category);
    if (!activities.category.length) delete activities.category;
  }
  const { contextActivities: _t, extensions: templateExt, registration: _r, ...templateRest } = template;
  const { contextActivities: _m, extensions: ownExt, registration: _o, ...ownRest } = mine;
  const extensions = { ...(ownExt ?? {}), ...(templateExt ?? {}) };
  return {
    ...ownRest, ...templateRest,
    registration: attempt.registration,
    ...(Object.keys(activities).length ? { contextActivities: activities } : {}),
    ...(Object.keys(extensions).length ? { extensions } : {}),
  };
}

/**
 * A play's statements as cmi5 allowed statements in this attempt: the LMS's actor and context.
 * The play's own completion of the composition is left out, since the AU's `completed` is the
 * completion the LMS judges moveOn by, and a second one could only confuse it. Their xAPI version
 * is left for the LMS's LRS to set: cmi5 rests on xAPI 1.0.3, whose LRSs refuse a statement that
 * claims any version not starting 1.0.
 */
export function attemptStatements(statements: readonly Statement[], attempt: Cmi5Attempt): Statement[] {
  return statements
    .filter(s => !((s.verb as { id?: string })?.id === `${ADL_VERBS}/completed`
      && ((s.object as { definition?: { type?: string } })?.definition?.type === PLAY_TYPES.composition)))
    .map(({ version: _version, ...s }) => ({ ...s, actor: attempt.actor, context: attemptContext(attempt, s.context as Record<string, unknown> | undefined) }));
}

/** A cmi5 defined statement about the AU in this attempt. */
export function definedStatement(verb: DefinedVerb, attempt: Cmi5Attempt, at: { now: string; newId: () => string },
  result?: Record<string, unknown>, extraContext?: Record<string, unknown>): Statement {
  return {
    id: at.newId(), actor: attempt.actor,
    verb: { id: `${ADL_VERBS}/${verb}`, display: { en: verb } },
    object: { objectType: 'Activity', id: attempt.activityId },
    context: attemptContext(attempt, extraContext, true),
    ...(result ? { result } : {}),
    timestamp: at.now,
  };
}

/** An ISO 8601 duration for milliseconds, as cmi5 §9.5.3 asks of completed, passed, failed and terminated. */
export function isoDuration(ms: number): string {
  return `PT${Math.max(0, Math.round(ms / 10) / 100)}S`;
}

/**
 * How the attempt ends, in cmi5's order. `completed` always. `passed` or `failed` when something
 * was graded and there is a mastery score to judge by: the LMS's, or, when the LMS asks for a pass
 * (moveOn names Passed) and gives none, every graded question right. `terminated` last.
 *
 * A Browse or Review launch is not judged (cmi5 §10.2.2): the learner looks, or looks back, and
 * only `terminated` closes it, so an LMS's moveOn is never satisfied by a look.
 */
export function closingStatements(attempt: Cmi5Attempt, graded: { correct: number; total: number }, at: { now: string; newId: () => string }, elapsedMs: number): Statement[] {
  const duration = isoDuration(elapsedMs);
  if (attempt.launchMode === 'Browse' || attempt.launchMode === 'Review') return [definedStatement('terminated', attempt, at, { duration })];
  const out: Statement[] = [definedStatement('completed', attempt, at, { completion: true, duration })];
  const wantsPass = attempt.masteryScore !== undefined || /Passed/.test(attempt.moveOn ?? '');
  if (graded.total > 0 && wantsPass) {
    const scaled = Number((graded.correct / graded.total).toFixed(4));
    const mastery = attempt.masteryScore ?? 1;
    const passed = scaled >= mastery;
    out.push(definedStatement(passed ? 'passed' : 'failed', attempt, at,
      { score: { scaled, raw: graded.correct, min: 0, max: graded.total }, success: passed, duration },
      attempt.masteryScore !== undefined ? { extensions: { [CMI5_IRIS.masteryScore]: attempt.masteryScore } } : undefined));
  }
  out.push(definedStatement('terminated', attempt, at, { duration }));
  return out;
}
