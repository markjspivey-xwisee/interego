/**
 * The scripted player's own scoring, replayed on the server.
 *
 * Choice effects are summed per criterion and clamped to that criterion's level
 * values. The pass rule is the scenario's: a percent of the weighted maximum,
 * plus any required level. A reply that is not the step's best reply becomes a
 * coaching note. The studio does not ask a model to invent the score.
 */

export interface Level { id: string; label?: string; value: number; descriptor?: string }
export interface Criterion {
  id: string;
  title?: string;
  description?: string;
  weight?: number;
  concepts?: string[];
  activityId?: string;
  levels: Level[];
}
export interface Choice {
  id?: string;
  text: string;
  effects?: Record<string, number>;
  mood?: number;
  best?: boolean;
  note?: string;
}
export interface Stage {
  id?: string;
  goal?: string;
  hint?: string;
  line?: string;
  lines?: string[];
  evidenceFor?: string[];
  choices: Choice[];
  variant?: Stage & { when?: { moodAbove?: number } };
}
export interface Persona {
  id: string;
  name?: string;
  firstLine?: string;
  startMood?: number;
  variantOf?: string;
  endings?: string[];
  stages: Stage[];
}
export interface PassRule { minPercent?: number; requiredLevels?: Record<string, string> }
export interface ScenarioDoc {
  scenarioKey: string;
  title: string;
  learnerGoal?: string;
  situation?: string;
  source?: string;
  language?: string;
  assessmentUse?: string;
  resultAfterReview?: boolean;
  turnLimit?: number;
  rubricRef?: string;
  activity?: { name?: string; description?: string; concepts?: string[] };
  rubric: { criteria: Criterion[]; passRule?: PassRule };
  personas: Persona[];
  ui?: { moodBands?: number[]; brand?: string };
  xapi?: XapiBlock;
  [key: string]: unknown;
}
export interface XapiBlock {
  profile: string;
  profileVersion: string;
  verbs: Record<string, string>;
  activityTypes: Record<string, string>;
  extensions: Record<string, string>;
}

export interface TakenChoice { index: number; said?: string; confirmed?: 'tapped' | 'matched' | 'recognised' }

export interface ReplayTurn {
  n: number;
  stepId: string;
  customerLine: string;
  response: string;
  choiceText: string;
  confirmed: 'tapped' | 'matched' | 'recognised';
  recognised?: string;
  choiceId?: string;
  goal?: string;
  said: string;
  best: boolean;
  bestText: string;
  note: string;
  evidenceFor: string[];
  effects: Record<string, number>;
}

export interface CriterionScore {
  id: string;
  title: string;
  description: string;
  raw: number;
  min: number;
  max: number;
  levelId: string;
  levelLabel: string;
  weight: number;
  evidence: string;
  activityId: string;
  concepts: string[];
}

export interface CoachingNote { step: number; goal: string; instead: string; was: string; note: string }

export interface Assessment {
  points: number;
  max: number;
  percent: number;
  pass: boolean;
  unmet: string[];
  minPercent: number;
  provisional: boolean;
  criteria: CriterionScore[];
  coaching: CoachingNote[];
  turns: ReplayTurn[];
}

const low = (c: Criterion): number => Math.min(...c.levels.map((l) => l.value));
const top = (c: Criterion): number => Math.max(...c.levels.map((l) => l.value));
const levelOf = (c: Criterion, value: number): Level => {
  let best = c.levels[0]!;
  for (const level of c.levels) if (level.value <= value && level.value >= best.value) best = level;
  return best;
};

function stageView(stage: Stage, persona: Persona, index: number, mood: number, bands: number[], variant: boolean): Stage {
  if (variant && stage.variant) {
    return {
      id: stage.variant.id,
      goal: stage.variant.goal,
      line: stage.variant.line,
      choices: stage.variant.choices,
      evidenceFor: stage.variant.evidenceFor || stage.evidenceFor,
    };
  }
  const line = index === 0
    ? (persona.firstLine ?? stage.line ?? '')
    : (stage.lines ?? [])[mood < bands[0]! ? 0 : mood <= bands[1]! ? 1 : 2] ?? stage.line ?? '';
  return { id: stage.id, goal: stage.goal, line, choices: stage.choices, evidenceFor: stage.evidenceFor };
}

/** Walk the script the way the player does and refuse a choice the step does not have. */
export function replay(scenario: ScenarioDoc, personaId: string, choices: readonly TakenChoice[]): ReplayTurn[] {
  const persona = scenario.personas.find((p) => p.id === personaId);
  if (!persona) throw new Error(`no persona ${personaId}`);
  const bands = scenario.ui?.moodBands ?? [40, 70];
  let mood = persona.startMood ?? 50;
  let variantAt = -1;
  if (choices.length !== persona.stages.length) {
    throw new Error(`a finished attempt has one reply per step (${persona.stages.length}); this one has ${choices.length}`);
  }
  const turns: ReplayTurn[] = [];
  choices.forEach((taken, stageIndex) => {
    const stage = persona.stages[stageIndex]!;
    const view = stageView(stage, persona, stageIndex, mood, bands, variantAt === stageIndex);
    const choice = view.choices[taken.index];
    if (!choice) throw new Error(`step ${stageIndex + 1} has no reply ${taken.index}`);
    const said = (taken.said ?? '').trim();
    const confirmed = taken.confirmed ?? (said ? 'matched' : 'tapped');
    const bestChoice = view.choices.find((c) => c.best) ?? choice;
    turns.push({
      n: stageIndex + 1,
      stepId: view.id || `step-${stageIndex + 1}`,
      customerLine: view.line || '',
      response: confirmed === 'recognised' ? said : (said || choice.text),
      choiceText: choice.text,
      confirmed,
      ...(said ? { recognised: said } : {}),
      ...(choice.id ? { choiceId: choice.id } : {}),
      ...(view.goal ? { goal: view.goal } : {}),
      said,
      best: !!choice.best,
      bestText: bestChoice.text,
      note: choice.note || '',
      evidenceFor: view.evidenceFor ?? [],
      effects: choice.effects ?? {},
    });
    mood = Math.max(0, Math.min(100, mood + (choice.mood || 0)));
    const next = persona.stages[stageIndex + 1];
    const above = next?.variant?.when?.moodAbove;
    if (next && typeof above === 'number' && mood > above) variantAt = stageIndex + 1;
  });
  return turns;
}

/** The replies marked best, in order, for the steps the mood actually shows. */
export function bestChoices(scenario: ScenarioDoc, personaId: string): TakenChoice[] {
  const persona = scenario.personas.find((p) => p.id === personaId);
  if (!persona) throw new Error(`no persona ${personaId}`);
  const bands = scenario.ui?.moodBands ?? [40, 70];
  let mood = persona.startMood ?? 50;
  let variantAt = -1;
  const taken: TakenChoice[] = [];
  persona.stages.forEach((stage, index) => {
    const view = stageView(stage, persona, index, mood, bands, variantAt === index);
    const best = view.choices.findIndex((c) => c.best);
    const choiceIndex = best < 0 ? 0 : best;
    taken.push({ index: choiceIndex });
    const choice = view.choices[choiceIndex]!;
    mood = Math.max(0, Math.min(100, mood + (choice.mood || 0)));
    const next = persona.stages[index + 1];
    const above = next?.variant?.when?.moodAbove;
    if (next && typeof above === 'number' && mood > above) variantAt = index + 1;
  });
  return taken;
}

export function assess(scenario: ScenarioDoc, turns: readonly ReplayTurn[]): Assessment {
  const criteria = scenario.rubric.criteria;
  const sums = criteria.map(() => 0);
  for (const turn of turns) {
    criteria.forEach((criterion, i) => { sums[i] = (sums[i] ?? 0) + (turn.effects[criterion.id] || 0); });
  }
  const raw = sums.map((n, i) => Math.max(low(criteria[i]!), Math.min(top(criteria[i]!), n)));
  const rule = scenario.rubric.passRule ?? {};
  const minPercent = rule.minPercent ?? 70;
  const scored: CriterionScore[] = criteria.map((criterion, i) => {
    const value = raw[i] ?? 0;
    const level = levelOf(criterion, value);
    const evidence = turns
      .filter((turn) => (turn.effects[criterion.id] || 0) !== 0 || turn.evidenceFor.includes(criterion.id))
      .map((turn) => `Step ${turn.n} (${turn.goal ?? 'step'}): ${turn.said ? `said "${turn.said}", matched ` : 'chose '}"${turn.choiceText}"`)
      .join(' | ')
      .slice(0, 1500);
    return {
      id: criterion.id,
      title: criterion.title || criterion.id,
      description: criterion.description || '',
      raw: value,
      min: low(criterion),
      max: top(criterion),
      levelId: level.id,
      levelLabel: level.label || level.descriptor || level.id,
      weight: criterion.weight || 1,
      evidence,
      activityId: criterion.activityId || `${scenario.source || scenario.scenarioKey}#rubric-${criterion.id}`,
      concepts: criterion.concepts ?? [],
    };
  });
  const points = scored.reduce((n, c) => n + c.weight * c.raw, 0);
  const max = scored.reduce((n, c) => n + c.weight * c.max, 0);
  const unmet = Object.entries(rule.requiredLevels ?? {}).filter(([id, need]) => {
    const criterion = criteria.find((c) => c.id === id);
    const score = scored.find((c) => c.id === id);
    if (!criterion || !score) return true;
    const index = (levelId: string) => criterion.levels.findIndex((l) => l.id === levelId);
    return index(score.levelId) < index(need);
  }).map(([id]) => id);
  const percent = max === 0 ? 0 : Math.round((points / max) * 1000) / 10;
  return {
    points, max, percent,
    pass: points * 100 >= minPercent * max && unmet.length === 0,
    unmet, minPercent,
    provisional: scenario.resultAfterReview === true || scenario.assessmentUse === 'pass-gate',
    criteria: scored,
    coaching: turns.filter((turn) => !turn.best).map((turn) => ({
      step: turn.n, goal: turn.goal ?? '', instead: turn.bestText, was: turn.said || turn.choiceText, note: turn.note,
    })),
    turns: [...turns],
  };
}
