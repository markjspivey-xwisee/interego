/**
 * Settle one mission from the pack. A fix that does not address the cause the
 * pack drew moves nothing: delta is 0, and the measured score is the baseline.
 * The numbers (lift, ally bonus, jitter) are the pack's scoring block.
 */
import { byId, fill, holderOf, normalise, type CauseDef, type InterventionDef, type MissionDef, type Symptom, type WorldPack } from './pack.js';
import { pick } from './rng.js';
import { WorldError } from './errors.js';

export interface Settlement {
  readonly intervention: InterventionDef;
  readonly matched: boolean;
  readonly diagnosed: boolean;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly roi: number;
  readonly gain: number;
  readonly control: Record<string, number>;
  readonly flippedTo: string | undefined;
  readonly lesson: string;
}

function clamp(pack: WorldPack, value: number): number {
  return Math.max(pack.scoring.scoreFloor, Math.min(pack.scoring.scoreCeil, Math.round(value)));
}

export function drawCause(pack: WorldPack, mission: MissionDef, tier: number, rng: () => number): CauseDef {
  const available = pack.causes.filter(c => (mission.weights[c.id] ?? 0) > 0 && c.minTier <= tier);
  if (available.length === 0) throw new WorldError(409, 'no-cause', 'this mission has no cause open at this tier');
  let roll = rng() * available.reduce((sum, c) => sum + (mission.weights[c.id] ?? 0), 0);
  let chosen = available[0];
  if (!chosen) throw new WorldError(409, 'no-cause');
  for (const cause of available) {
    roll -= mission.weights[cause.id] ?? 0;
    if (roll <= 0) { chosen = cause; break; }
  }
  return chosen;
}

export function baseline(pack: WorldPack, mission: MissionDef, tier: number, remembered: boolean, rng: () => number): number {
  const lift = remembered ? pack.scoring.memoryBaselineLift : 0;
  const jitter = (rng() - 0.5) * pack.scoring.baselineJitter;
  return clamp(pack, mission.base + tier * pack.scoring.tierBaseline + lift + jitter);
}

/** Symptoms for the stream the consultant reads before choosing. The cause id is not in them. */
export function openingSymptoms(pack: WorldPack, cause: CauseDef, rng: () => number): { symptoms: Symptom[]; herring: Symptom | undefined } {
  const others = pack.causes.filter(c => c.id !== cause.id && c.symptoms.length > 0);
  const herring = others.length > 0 ? pick(pick(others, rng).symptoms, rng) : undefined;
  const count = Math.min(3, cause.symptoms.length);
  const symptoms = Array.from({ length: count }, (_, i) => cause.symptoms[i % cause.symptoms.length]).filter((s): s is Symptom => s !== undefined);
  return { symptoms, herring };
}

/**
 * The cause and the baseline were fixed when the mission opened. Applying an
 * intervention does not redraw them, so the stream the consultant already saw
 * is the stream this result explains.
 */
export function settle(input: {
  readonly pack: WorldPack;
  readonly mission: MissionDef;
  readonly tier: number;
  readonly cause: CauseDef;
  readonly before: number;
  readonly diagnosisId: string;
  readonly interventionId: string;
  readonly allies: number;
  readonly rivals: number;
  readonly factionId: string;
  readonly factionOrder: readonly string[];
  readonly control: Readonly<Record<string, number>>;
  readonly rng: () => number;
}): Settlement {
  const { pack, cause } = input;
  const intervention = byId(pack.interventions, input.interventionId);
  if (!intervention) throw new WorldError(400, 'unknown-intervention');
  if (intervention.minTier > input.tier) throw new WorldError(403, 'intervention-locked');
  const diagnosis = byId(pack.causes, input.diagnosisId);
  if (!diagnosis) throw new WorldError(400, 'unknown-cause');
  const matched = intervention.addresses === cause.id;
  const ally = input.allies * cause.allyLift;
  const delta = matched ? Math.round(pack.scoring.matchLiftBase + input.rng() * pack.scoring.matchLiftSpan + ally) : 0;
  const after = clamp(pack, input.before + delta);
  const roi = intervention.cost === 0 ? 0 : (delta * pack.scoring.roiScale) / intervention.cost;
  const gain = matched ? Math.max(0, Math.round(delta * pack.scoring.gainScale + pack.scoring.matchGainBonus)) : 0;
  const next: Record<string, number> = { ...input.control };
  const blunt = Math.max(0, pack.scoring.territoryScale - input.rivals * pack.scoring.rivalBlunt);
  next[input.factionId] = (next[input.factionId] ?? 0) + Math.max(0, delta) * blunt;
  const control = normalise(next);
  const beforeHolder = holderOf(input.control, input.factionOrder);
  const afterHolder = holderOf(control, input.factionOrder);
  const lesson = fill(matched ? pack.templates.lessonMatched : pack.templates.lessonMissed, {
    type: input.mission.type, cause: cause.label, intervention: intervention.label,
    delta: delta >= 0 ? `+${delta}` : String(delta), kpi: input.mission.kpi,
  });
  return {
    intervention, matched, diagnosed: diagnosis.id === cause.id, before: input.before, after, delta, roi, gain, control,
    flippedTo: afterHolder !== beforeHolder && afterHolder === input.factionId ? afterHolder : undefined, lesson,
  };
}
