/**
 * Practice studio. Scenarios, sessions, scores and coaching are records an
 * agent can ask for. A score is the scripted arithmetic on choice indexes the
 * caller declares. It is not a played session: the hosted player is what
 * records consent, timing and xAPI, and only when a course launches it.
 *
 * The store is this process. There is no authentication. The process listens
 * on loopback unless the operator explicitly accepts that.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assess, replay, type ScenarioDoc, type TakenChoice } from './score.js';
import { canonicalXapi, closesAwaitingReview } from './statements.js';

const SEEDED = new URL('../../../docs/applications/practice-evidence/roleplay-player/scenarios/double-charged-subscription.json', import.meta.url);

export interface StudioRecord {
  id: string;
  type: string;
  modalStatus: 'Hypothetical' | 'Asserted';
  stored: 'process-memory';
  [key: string]: unknown;
}

export interface SessionRecord extends StudioRecord {
  scenarioKey: string;
  personaId: string;
  learnerId: string;
  state: 'open' | 'scored';
}

/** Nothing here is authenticated, so a non-loopback listen needs an explicit flag. */
export function refusesPublicBind(host: string, insecureFlag: string | undefined): boolean {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  return !loopback && insecureFlag !== '1';
}

const refusal = (status: number, error: string): Record<string, unknown> => ({
  kind: 'refusal',
  'iep:refusalStatus': status,
  error,
});

function isScenario(value: unknown): value is ScenarioDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as ScenarioDoc;
  return typeof doc.scenarioKey === 'string' && typeof doc.title === 'string' && !!doc.rubric && Array.isArray(doc.personas);
}

/** Say why a scenario cannot be played, or null when it can. */
export function scenarioProblems(doc: ScenarioDoc): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.scenarioKey)) problems.push('scenarioKey must be lowercase words separated by hyphens');
  if (!doc.title.trim()) problems.push('title is required');
  if (!Array.isArray(doc.rubric?.criteria) || doc.rubric.criteria.length === 0) problems.push('the rubric needs at least one criterion');
  for (const criterion of doc.rubric?.criteria ?? []) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(criterion.id)) problems.push(`criterion id ${JSON.stringify(criterion.id)} must be a lowercase key`);
    if (!Array.isArray(criterion.levels) || criterion.levels.length < 2) problems.push(`criterion ${criterion.id} needs at least two levels`);
    let previous = Number.NEGATIVE_INFINITY;
    for (const level of criterion.levels ?? []) {
      if (typeof level.value !== 'number' || !Number.isInteger(level.value)) {
        problems.push(`criterion ${criterion.id} level ${level.id} value must be a whole number`);
      } else if (level.value <= previous) {
        problems.push(`criterion ${criterion.id} levels must be listed from the lowest value to the highest`);
      } else previous = level.value;
    }
  }
  if (!Array.isArray(doc.personas) || doc.personas.length === 0) problems.push('name at least one persona');
  for (const persona of doc.personas ?? []) {
    if (!persona.id) problems.push('each persona needs an id');
    if (!Array.isArray(persona.stages) || persona.stages.length === 0) problems.push(`persona ${persona.id} needs at least one step`);
    for (const stage of persona.stages ?? []) {
      const choices = [...(stage.choices ?? []), ...(stage.variant?.choices ?? [])];
      if (choices.length === 0) problems.push(`persona ${persona.id} has a step with no replies`);
    }
  }
  return problems;
}

function prepare(doc: ScenarioDoc, seeded: boolean): ScenarioDoc {
  const next: ScenarioDoc = { ...doc, xapi: doc.xapi ?? canonicalXapi() };
  if (!next.activity) next.activity = { name: next.title, description: next.situation || next.title };
  if (!next.source) next.source = `urn:studio:scenario:${next.scenarioKey}`;
  if (next.assessmentUse === 'pass-gate' && next.resultAfterReview === undefined) next.resultAfterReview = true;
  if (next.resultAfterReview && !next.rubricRef) next.rubricRef = `${next.source}#rubric`;
  if (!next.turnLimit) next.turnLimit = next.personas[0]?.stages.length ?? 1;
  next.seeded = seeded;
  return next;
}

export interface ProgressView {
  learnerId: string;
  attempts: number;
  scored: number;
  passRate: number | null;
  averagePercent: number | null;
  criteria: Array<{ id: string; title: string; averagePercent: number }>;
  recent: Array<{ sessionId: string; scenarioKey: string; percent: number; pass: boolean; provisional: boolean; coaching: number }>;
}

export class Studio {
  private readonly scenarios = new Map<string, ScenarioDoc>();
  private readonly sessions = new Map<string, { session: SessionRecord; scenario: ScenarioDoc; choices?: TakenChoice[]; result?: Record<string, unknown> }>();

  constructor() {
    const seeded = JSON.parse(readFileSync(SEEDED, 'utf8')) as ScenarioDoc;
    this.scenarios.set(seeded.scenarioKey, prepare(seeded, true));
  }

  scenario(key: string): ScenarioDoc | undefined {
    return this.scenarios.get(key);
  }

  /** The scenario revision a session was opened against, including after the library copy changes. */
  sessionScenario(sessionId: string): ScenarioDoc | undefined {
    return this.sessions.get(sessionId)?.scenario;
  }

  listScenarios(): Record<string, unknown> {
    return {
      scenarios: [...this.scenarios.values()].map((doc) => ({
        id: `urn:studio:scenario:${doc.scenarioKey}`,
        type: 'studio:Scenario',
        scenarioKey: doc.scenarioKey,
        title: doc.title,
        learnerGoal: doc.learnerGoal ?? null,
        assessmentUse: doc.assessmentUse ?? 'feedback-only',
        resultAfterReview: doc.resultAfterReview === true,
        criteria: doc.rubric.criteria.map((c) => ({ id: c.id, title: c.title || c.id, description: c.description || '' })),
        personas: doc.personas.map((p) => ({ id: p.id, name: p.name || p.id })),
        seeded: doc['seeded'] === true,
        document: `/studio/scenarios/${encodeURIComponent(doc.scenarioKey)}/document`,
      })),
    };
  }

  createScenario(input: unknown): Record<string, unknown> {
    const raw = input && typeof input === 'object' && 'scenario' in input ? (input as { scenario: unknown }).scenario : input;
    if (!isScenario(raw)) return refusal(400, 'send a scenario document with scenarioKey, title, rubric and personas');
    const problems = scenarioProblems(raw);
    if (problems.length) return refusal(400, problems.join('; '));
    const existing = this.scenarios.get(raw.scenarioKey);
    if (existing?.['seeded'] === true) return refusal(409, `${raw.scenarioKey} is the seeded sample; choose another scenarioKey`);
    const doc = prepare(raw, false);
    this.scenarios.set(doc.scenarioKey, doc);
    const record: StudioRecord = {
      id: `urn:studio:scenario:${doc.scenarioKey}`,
      type: 'studio:Scenario',
      modalStatus: 'Hypothetical',
      stored: 'process-memory',
      scenarioKey: doc.scenarioKey,
      title: doc.title,
      rubricCriteria: doc.rubric.criteria.map((c) => c.id),
      assessmentUse: doc.assessmentUse ?? 'feedback-only',
      awaitsReview: closesAwaitingReview(doc),
    };
    return { scenario: record };
  }

  startSession(input: Record<string, unknown>): Record<string, unknown> {
    const scenarioKey = typeof input['scenarioKey'] === 'string' ? input['scenarioKey'] : '';
    const learner = typeof input['learner'] === 'string' ? input['learner'].trim() : '';
    const doc = this.scenarios.get(scenarioKey);
    if (!doc) return refusal(404, `no scenario ${scenarioKey}`);
    if (learner.length < 1 || learner.length > 80) return refusal(400, 'learner is a label you choose for this process, from 1 to 80 characters');
    const personaId = typeof input['personaId'] === 'string' && doc.personas.some((p) => p.id === input['personaId'])
      ? input['personaId']
      : doc.personas[0]!.id;
    const sessionId = randomUUID();
    const session: SessionRecord = {
      id: `urn:studio:session:${sessionId}`,
      type: 'studio:PracticeSession',
      modalStatus: 'Hypothetical',
      stored: 'process-memory',
      scenarioKey,
      personaId,
      learnerId: learner,
      state: 'open',
      sessionId,
    };
    this.sessions.set(sessionId, { session, scenario: JSON.parse(JSON.stringify(doc)) as ScenarioDoc });
    const player = `/player/index.html?scenario=${encodeURIComponent(`/studio/sessions/${sessionId}/scenario`)}&persona=${encodeURIComponent(personaId)}`;
    return { session, playerUrl: player, personaId, steps: doc.personas.find((p) => p.id === personaId)!.stages.length };
  }

  scoreAttempt(input: Record<string, unknown>): Record<string, unknown> {
    const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : '';
    const held = this.sessions.get(sessionId);
    if (!held) return refusal(404, `no session ${sessionId}`);
    if (held.session.state === 'scored') return refusal(409, 'this session is already scored');
    const doc = held.scenario;
    const played = input['personaId'];
    if (typeof played === 'string' && played !== held.session.personaId) {
      return refusal(409, `this session is ${held.session.personaId}; the player finished as ${played}`);
    }
    const actorKind = input['actorKind'] === undefined ? 'agent' : input['actorKind'];
    if (actorKind !== 'agent' && actorKind !== 'person') return refusal(400, 'actorKind is agent or person; omitted means agent');
    if (!Array.isArray(input['choices'])) return refusal(400, 'choices is the list of reply indexes the caller declares, in order');
    const choices: TakenChoice[] = [];
    for (const item of input['choices']) {
      if (!item || typeof item !== 'object' || typeof (item as TakenChoice).index !== 'number') {
        return refusal(400, 'each choice is { index, said? }');
      }
      const taken = item as TakenChoice;
      const confirmed = taken.confirmed;
      if (confirmed !== undefined && confirmed !== 'tapped' && confirmed !== 'matched' && confirmed !== 'recognised') {
        return refusal(400, 'confirmed is tapped, matched or recognised');
      }
      choices.push({
        index: taken.index,
        ...(typeof taken.said === 'string' ? { said: taken.said } : {}),
        ...(confirmed ? { confirmed } : {}),
      });
    }
    let assessment;
    try {
      assessment = assess(doc, replay(doc, held.session.personaId, choices));
    } catch (error) {
      return refusal(400, error instanceof Error ? error.message : 'the replies do not fit the scenario');
    }
    held.session.state = 'scored';
    held.choices = choices;
    const score: StudioRecord = {
      id: `urn:studio:score:${sessionId}`,
      type: 'studio:AttemptScore',
      modalStatus: 'Hypothetical',
      stored: 'process-memory',
      observed: false,
      source: 'declared-choices',
      actorKind,
      sessionId,
      scenarioKey: doc.scenarioKey,
      learnerId: held.session['learnerId'],
      points: assessment.points,
      max: assessment.max,
      percent: assessment.percent,
      pass: assessment.pass,
      provisional: assessment.provisional,
      unmet: assessment.unmet,
      criteria: assessment.criteria.map((c) => ({ id: c.id, title: c.title, raw: c.raw, max: c.max, levelId: c.levelId, levelLabel: c.levelLabel })),
    };
    const coaching: StudioRecord = {
      id: `urn:studio:coaching:${sessionId}`,
      type: 'studio:CoachingNote',
      modalStatus: 'Asserted',
      stored: 'process-memory',
      sessionId,
      notes: assessment.coaching,
    };
    const result = {
      score, coaching,
      review: 'Declared choices, not a played session. Nothing was consented to, timed, or written as xAPI. The hosted player records an attempt only when a course launches it.',
    };
    held.result = result;
    return result;
  }

  listProgress(learner: string): Record<string, unknown> {
    const name = learner.trim();
    if (!name) return refusal(400, 'learner is required');
    const rows = [...this.sessions.values()].filter((held) => held.session['learnerId'] === name && held.result);
    const scored = rows.map((held) => held.result!['score'] as StudioRecord);
    const percents = scored.map((score) => Number(score['percent']));
    const passes = scored.filter((score) => score['pass'] === true).length;
    const byCriterion = new Map<string, { title: string; sum: number; n: number; max: number }>();
    for (const score of scored) {
      for (const criterion of (score['criteria'] as Array<{ id: string; title: string; raw: number; max: number }>)) {
        const cell = byCriterion.get(criterion.id) ?? { title: criterion.title, sum: 0, n: 0, max: criterion.max };
        cell.sum += criterion.raw;
        cell.n += 1;
        cell.max = criterion.max;
        byCriterion.set(criterion.id, cell);
      }
    }
    const view: ProgressView = {
      learnerId: name,
      attempts: rows.length,
      scored: scored.length,
      passRate: scored.length ? Math.round((passes / scored.length) * 1000) / 10 : null,
      averagePercent: percents.length ? Math.round((percents.reduce((n, p) => n + p, 0) / percents.length) * 10) / 10 : null,
      criteria: [...byCriterion.entries()].map(([id, cell]) => ({
        id, title: cell.title, averagePercent: cell.max === 0 ? 0 : Math.round((cell.sum / cell.n / cell.max) * 1000) / 10,
      })),
      recent: rows.slice(-12).reverse().map((held) => {
        const score = held.result!['score'] as StudioRecord;
        const coaching = held.result!['coaching'] as StudioRecord;
        return {
          sessionId: String(score['sessionId']),
          scenarioKey: String(score['scenarioKey']),
          percent: Number(score['percent']),
          pass: score['pass'] === true,
          provisional: score['provisional'] === true,
          coaching: Array.isArray(coaching['notes']) ? coaching['notes'].length : 0,
        };
      }),
    };
    return {
      id: `urn:studio:progress:${encodeURIComponent(name)}`,
      type: 'studio:LearnerProgress',
      modalStatus: 'Asserted',
      stored: 'process-memory',
      ...view,
    };
  }
}
