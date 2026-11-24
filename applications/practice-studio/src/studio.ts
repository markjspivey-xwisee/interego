/**
 * Practice studio. A library and an authoring box for scenarios, and a
 * progress view over a cmi5 launch of the hosted player. The player writes
 * the statements. Practice Evidence reads them. This process does not.
 *
 * Creating, launching and reading require a signed caller. The store is this
 * process. It listens on loopback unless the operator explicitly accepts that.
 */
import { readFileSync } from 'node:fs';
import { LaunchBook } from './launch.js';
import { type ScenarioDoc } from './score.js';
import { canonicalXapi, closesAwaitingReview } from './statements.js';

const SEEDED = new URL('../../../docs/applications/practice-evidence/roleplay-player/scenarios/double-charged-subscription.json', import.meta.url);

export interface StudioRecord {
  id: string;
  type: string;
  modalStatus: 'Hypothetical' | 'Asserted';
  stored: 'process-memory';
  [key: string]: unknown;
}

/** Nothing here is authenticated on its own: a non-loopback listen needs an explicit flag. Callers still sign. */
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

export class Studio {
  private readonly scenarios = new Map<string, ScenarioDoc>();
  private readonly authors = new Map<string, string>();
  readonly launches = new LaunchBook();

  constructor() {
    const seeded = JSON.parse(readFileSync(SEEDED, 'utf8')) as ScenarioDoc;
    this.scenarios.set(seeded.scenarioKey, prepare(seeded, true));
  }

  scenario(key: string): ScenarioDoc | undefined {
    return this.scenarios.get(key);
  }

  /** The scenario revision a launch was opened against, including after the library copy changes. */
  snapshot(id: string): ScenarioDoc | undefined {
    return this.launches.snapshot(id);
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

  createScenario(input: unknown, authorDid: string): Record<string, unknown> {
    const raw = input && typeof input === 'object' && 'scenario' in input ? (input as { scenario: unknown }).scenario : input;
    if (!isScenario(raw)) return refusal(400, 'send a scenario document with scenarioKey, title, rubric and personas');
    const problems = scenarioProblems(raw);
    if (problems.length) return refusal(400, problems.join('; '));
    const existing = this.scenarios.get(raw.scenarioKey);
    if (existing?.['seeded'] === true) return refusal(409, `${raw.scenarioKey} is the seeded sample; choose another scenarioKey`);
    const author = this.authors.get(raw.scenarioKey);
    if (author && author.toLowerCase() !== authorDid.toLowerCase()) return refusal(403, 'another learner authored this scenario');
    const doc = prepare(raw, false);
    this.authors.set(doc.scenarioKey, authorDid);
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

  startSession(input: Record<string, unknown>, learnerDid: string, origin: string): Record<string, unknown> {
    const scenarioKey = typeof input['scenarioKey'] === 'string' ? input['scenarioKey'] : '';
    const doc = this.scenarios.get(scenarioKey);
    if (!doc) return refusal(404, `no scenario ${scenarioKey}`);
    const place = input['learnerPlace'] === undefined ? 'person' : input['learnerPlace'];
    if (place !== 'person' && place !== 'agent') return refusal(400, 'learnerPlace is person or agent');
    const personaId = typeof input['personaId'] === 'string' && doc.personas.some((p) => p.id === input['personaId'])
      ? input['personaId']
      : doc.personas[0]!.id;
    return this.launches.open(learnerDid, doc, personaId, origin, place);
  }

  readProgress(learnerDid: string, registration: string): Record<string, unknown> {
    if (!registration) return refusal(400, 'registration is required');
    return this.launches.read(learnerDid, registration);
  }
}
