/**
 * Reading one cmi5 registration's statements as a practice conversation — pure functions.
 *
 * A conversation can happen outside this bridge: an assignable unit an LMS launched (a voice
 * role-play player, say) plays the other person from a script, writes each exchange and its own
 * score per criterion to the LRS, and ends its session. `readLaunchedCall` turns the statements of
 * that registration into what an attempt record needs: the launch, the turns, and the unit's score
 * per rubric criterion. It refuses, with every reason, a registration that is not one whole call
 * against the scenario's rubric.
 *
 * Which verb says "an exchange" and which extensions carry the lines and the criterion are not
 * known here: they belong to whatever xAPI Profile the unit follows, and arrive as a
 * `LaunchVocabulary`. Nothing in this file names a profile, a course or a player.
 *
 * What is taken on trust, and recorded as such by the caller: the statements are what the LRS
 * returned for the registration; the other person's lines and the scores are the unit's own.
 */
import type { LmsLaunch } from './records.js';
import { TURN_TEXT_MAX, type ScenarioSpec } from './practice.js';

export const VERB_INITIALIZED = 'http://adlnet.gov/expapi/verbs/initialized';
export const VERB_TERMINATED = 'http://adlnet.gov/expapi/verbs/terminated';
export const VERB_SCORED = 'http://adlnet.gov/expapi/verbs/scored';
export const VERB_LAUNCHED = 'http://adlnet.gov/expapi/verbs/launched';
const VERB_PASSED = 'http://adlnet.gov/expapi/verbs/passed';
const VERB_FAILED = 'http://adlnet.gov/expapi/verbs/failed';
const VERB_COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
const CMI5_CATEGORY_PREFIX = 'https://w3id.org/xapi/cmi5/context/categories/';
const CMI5_SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
const CMI5_LAUNCH_MODE_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/launchmode';
const CMI5_MASTERY_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/masteryscore';

/** The profile terms a unit's statements use, as absolute IRIs. */
export interface LaunchVocabulary {
  /** The verb of one exchange: the other person's line and the learner's answer. */
  readonly turnVerb: string;
  /** On a turn's object definition: the other person's line as spoken. */
  readonly counterpartLineExt: string;
  /** On a scored statement's object definition: the rubric criterion's id. */
  readonly criterionKeyExt: string;
  /** In a scored statement's context: the rubric's hash or IRI. */
  readonly rubricExt: string;
}

const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VOCABULARY_KEYS = ['turnVerb', 'counterpartLineExt', 'criterionKeyExt', 'rubricExt'] as const;

/** Each failure as one sentence; [] means the value is a usable vocabulary. */
export function launchVocabularyProblems(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['the launch vocabulary is not an object'];
  const o = v as Record<string, unknown>;
  const p = VOCABULARY_KEYS.filter((k) => typeof o[k] !== 'string' || !IRI.test(o[k] as string)).map((k) => `${k} must be an absolute IRI`);
  const extra = Object.keys(o).filter((k) => !(VOCABULARY_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) p.push(`unknown keys: ${extra.join(', ')}`);
  return p;
}

export type UnitVerb = 'passed' | 'failed' | 'completed';

export interface ImportedTurn {
  readonly speaker: 'counterpart' | 'learner'; readonly text: string; readonly at: string;
  /** The statement the line was read from. */
  readonly statementId: string;
}

export interface ImportedScore {
  readonly criterionId: string; readonly levelId: string; readonly raw: number; readonly statementId: string;
  /** The unit's own note on the criterion, when it gave one. */
  readonly note?: string;
}

export interface ImportedCall {
  readonly launch: LmsLaunch;
  readonly turns: readonly ImportedTurn[];
  /** One per rubric criterion, in the rubric's order. */
  readonly scores: readonly ImportedScore[];
  readonly startedAt: string; readonly endedAt: string;
  /** Every statement read for the registration, in time order. */
  readonly statementIds: readonly string[];
  /** The cmi5 defined verbs the unit has already sent in this registration. */
  readonly unitSent: readonly UnitVerb[];
  /** How the launch mode was known: from the LMS's launched statement, or not at all (then Normal is assumed). */
  readonly launchModeFrom: 'launched-statement' | 'assumed';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const objOf = (v: unknown): Record<string, unknown> => (isObj(v) ? v : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

interface Read {
  readonly id: string; readonly verb: string; readonly at: string; readonly ms: number; readonly order: number;
  readonly s: Record<string, unknown>; readonly ctx: Record<string, unknown>; readonly ext: Record<string, unknown>;
  readonly objectId: string | undefined; readonly objectExt: Record<string, unknown>; readonly result: Record<string, unknown>;
}

export interface ReadLaunchedInput {
  readonly registration: string;
  readonly spec: ScenarioSpec;
  /** The scenario version's rubric, as a scored statement may name it: its hash, or its IRI. */
  readonly rubricHash: string; readonly rubricIri?: string;
  readonly vocabulary: LaunchVocabulary;
  /** The LRS endpoint the statements were read from. */
  readonly endpoint: string;
}

/**
 * The call a registration's statements describe, or every reason they do not describe one.
 * `statements` is what the LRS returned for the registration, in any order.
 */
export function readLaunchedCall(statements: readonly unknown[], i: ReadLaunchedInput): { readonly call: ImportedCall } | { readonly problems: readonly string[] } {
  const p: string[] = [];
  const v = i.vocabulary;
  if (statements.length === 0) return { problems: ['the LRS returned no statement for this registration'] };

  const read: Read[] = [];
  statements.forEach((raw, order) => {
    if (!isObj(raw)) { p.push(`statement ${order} is not an object`); return; }
    const id = str(raw['id']);
    const verb = str(objOf(raw['verb'])['id']);
    const at = str(raw['timestamp']);
    const ms = at !== undefined ? Date.parse(at) : NaN;
    if (id === undefined || !UUID.test(id) || verb === undefined || at === undefined || Number.isNaN(ms)) { p.push(`statement ${order} lacks an id, a verb or a timestamp`); return; }
    const ctx = objOf(raw['context']);
    if (ctx['registration'] !== i.registration) { p.push(`statement ${id} belongs to another registration`); return; }
    const obj = objOf(raw['object']);
    read.push({
      id, verb, at, ms, order, s: raw, ctx, ext: objOf(ctx['extensions']),
      objectId: str(obj['id']), objectExt: objOf(objOf(obj['definition'])['extensions']), result: objOf(raw['result']),
    });
  });
  if (new Set(read.map((r) => r.id)).size !== read.length) p.push('a statement id appears twice');
  if (p.length > 0) return { problems: p };
  read.sort((a, b) => a.ms - b.ms || a.order - b.order);

  // The LMS's own launched statement names the actor too, but is the LMS's, not the unit's.
  const launched = read.find((r) => r.verb === VERB_LAUNCHED);
  const unit = read.filter((r) => r.verb !== VERB_LAUNCHED);
  const accounts = new Set(read.map((r) => {
    const a = objOf(objOf(r.s['actor'])['account']);
    return `${String(a['homePage'])}\n${String(a['name'])}`;
  }));
  if (accounts.size !== 1) p.push('the statements name more than one actor');
  const account = objOf(objOf(read[0]!.s['actor'])['account']);
  const homePage = str(account['homePage']);
  const name = str(account['name']);
  if (homePage === undefined || name === undefined) p.push('the actor is not an account with a homePage and a name');

  const first = unit.find((r) => r.verb === VERB_INITIALIZED);
  if (!first) return { problems: [...p, 'the registration has no initialized statement: no session was started'] };
  const sessionId = str(first.ext[CMI5_SESSION_EXT]);
  if (sessionId === undefined) p.push('the initialized statement carries no cmi5 session id');
  if (first.objectId === undefined || !IRI.test(first.objectId)) p.push('the initialized statement names no activity');
  const inSession = unit.filter((r) => r.ext[CMI5_SESSION_EXT] === sessionId);
  const ended = inSession.find((r) => r.verb === VERB_TERMINATED);
  if (!ended) p.push('the session of the conversation has no terminated statement: it is still open');

  const turnsRead = inSession.filter((r) => r.verb === v.turnVerb);
  if (turnsRead.length === 0) p.push('the session has no exchange: there is nothing to review');
  if (turnsRead.length > i.spec.turnLimit) p.push(`the session has ${turnsRead.length} exchanges, over the scenario's limit of ${i.spec.turnLimit}`);
  const turns: ImportedTurn[] = [];
  for (const t of turnsRead) {
    const line = str(t.objectExt[v.counterpartLineExt]);
    const answer = str(t.result['response']);
    if (line === undefined || line.length > TURN_TEXT_MAX) { p.push(`exchange ${t.id} carries no line for the other person (or one over ${TURN_TEXT_MAX} characters)`); continue; }
    if (answer === undefined || answer.length > TURN_TEXT_MAX) { p.push(`exchange ${t.id} carries no answer from the learner in result.response (or one over ${TURN_TEXT_MAX} characters)`); continue; }
    turns.push({ speaker: 'counterpart', text: line, at: t.at, statementId: t.id }, { speaker: 'learner', text: answer, at: t.at, statementId: t.id });
  }

  const scoredRead = inSession.filter((r) => r.verb === VERB_SCORED);
  const scores: ImportedScore[] = [];
  const named = [i.rubricHash, ...(i.rubricIri !== undefined ? [i.rubricIri] : [])];
  const wrongRubric = scoredRead.filter((r) => !named.includes(r.ext[v.rubricExt] as string));
  if (wrongRubric.length > 0) p.push(`${wrongRubric.length} scored statement(s) do not name this scenario version's rubric (${i.rubricHash})`);
  const byKey = new Map<string, Read[]>();
  for (const r of scoredRead) {
    const key = str(r.objectExt[v.criterionKeyExt]);
    if (key === undefined) { p.push(`scored statement ${r.id} names no criterion`); continue; }
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const ids = i.spec.rubric.criteria.map((c) => c.id);
  const unknown = [...byKey.keys()].filter((k) => !ids.includes(k));
  if (unknown.length > 0) p.push(`criteria scored that the rubric does not have: ${unknown.join(', ')}`);
  for (const c of i.spec.rubric.criteria) {
    const given = byKey.get(c.id) ?? [];
    if (given.length !== 1) { p.push(given.length === 0 ? `criterion ${c.id} was not scored` : `criterion ${c.id} was scored ${given.length} times`); continue; }
    const r = given[0]!;
    const raw = objOf(r.result['score'])['raw'];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) { p.push(`the score for ${c.id} has no result.score.raw`); continue; }
    // A level is named by its value where every level has one; a rubric with no values is read by position, lowest 0.
    const valued = c.levels.every((l) => l.value !== null);
    const matches = valued ? c.levels.filter((l) => l.value === raw) : c.levels.filter((_, j) => j === raw);
    if (matches.length !== 1) { p.push(`the score ${raw} for ${c.id} is not ${valued ? 'the value' : 'the position'} of exactly one level`); continue; }
    const note = str(r.result['response']);
    scores.push({ criterionId: c.id, levelId: matches[0]!.id, raw, statementId: r.id, ...(note !== undefined ? { note: note.slice(0, 1500) } : {}) });
  }

  const sent = (verb: string): boolean => unit.some((r) => r.verb === verb);
  const unitSent: UnitVerb[] = [];
  if (sent(VERB_PASSED)) unitSent.push('passed');
  if (sent(VERB_FAILED)) unitSent.push('failed');
  if (sent(VERB_COMPLETED)) unitSent.push('completed');
  if (i.spec.assessmentUse === 'pass-gate' && unitSent.length > 0) {
    p.push(`the unit already sent ${unitSent.join(' and ')} for this registration: a pass gate is passed, failed or completed only after its review`);
  }

  const mode = launched ? launched.ext[CMI5_LAUNCH_MODE_EXT] : undefined;
  if (launched && mode !== 'Normal' && mode !== 'Browse' && mode !== 'Review') p.push('the launched statement carries no launch mode');
  const mastery = [launched, first].map((r) => r?.ext[CMI5_MASTERY_EXT]).find((m) => typeof m === 'number');
  if (p.length > 0 || !ended || sessionId === undefined || homePage === undefined || name === undefined || first.objectId === undefined) return { problems: p };

  // What the unit put on its own first statement stands in for the launch data's contextTemplate,
  // which statements do not carry: its context activities but the cmi5 categories, and its
  // extensions but the session id.
  const ca = objOf(first.ctx['contextActivities']);
  const keptCa: Record<string, unknown> = {};
  for (const [kind, list] of Object.entries(ca)) {
    const kept = (Array.isArray(list) ? list : [list]).filter((a) => !(kind === 'category' && isObj(a) && typeof a['id'] === 'string' && a['id'].startsWith(CMI5_CATEGORY_PREFIX)));
    if (kept.length > 0) keptCa[kind] = kept;
  }
  const keptExt = Object.fromEntries(Object.entries(first.ext).filter(([k]) => k !== CMI5_SESSION_EXT && k !== CMI5_MASTERY_EXT && k !== CMI5_LAUNCH_MODE_EXT));
  const template: Record<string, unknown> = {
    ...(Object.keys(keptCa).length > 0 ? { contextActivities: keptCa } : {}),
    ...(Object.keys(keptExt).length > 0 ? { extensions: keptExt } : {}),
  };
  const launch: LmsLaunch = {
    registration: i.registration, sessionId, activityId: first.objectId, actor: { homePage, name }, endpoint: i.endpoint,
    launchMode: launched ? (mode as LmsLaunch['launchMode']) : 'Normal',
    ...(typeof mastery === 'number' ? { masteryScore: mastery } : {}),
    ...(Object.keys(template).length > 0 ? { contextTemplate: template } : {}),
    ...(isObj(objOf(first.s['object'])['definition']) ? { activityDefinition: objOf(first.s['object'])['definition'] as Record<string, unknown> } : {}),
  };
  return {
    call: {
      launch, turns, scores, startedAt: first.at, endedAt: ended.at, statementIds: read.map((r) => r.id), unitSent,
      launchModeFrom: launched ? 'launched-statement' : 'assumed',
    },
  };
}
