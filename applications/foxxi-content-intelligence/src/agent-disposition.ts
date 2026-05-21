/**
 * Agent Performance Technology — reading a team of agents as a complex,
 * adaptive system rather than a fixable machine.
 *
 * A single agent on a knowable task can be gap-analysed: measure actual
 * against exemplary, close the difference. A *team* of agents adapting
 * to open-ended work cannot. It has no single exemplary state to close
 * toward — it has dispositions and propensities, and a direction of
 * drift. So this module refuses the gap / ideal-state frame and instead:
 *   · reads DISPOSITION — what the team is propense to do — not a score;
 *   · classifies the WORK REGIME — how knowable the cause→effect
 *     relationship is — because that decides which method is even valid;
 *   · manages CONSTRAINTS through safe-to-fail probes, not outcomes;
 *   · steers by VECTOR — a direction from the present — not toward a
 *     fixed destination.
 *
 * It needs no separate causal apparatus: the substrate's own modal
 * statuses already carry it. An Asserted step is something observed; a
 * Hypothetical step is an intention or a probe — a deliberate change
 * whose effect is read after the fact; a Counterfactual step is a road
 * the team considered and did not take. Observation, intervention, and
 * the road-not-taken — nothing more is needed.
 *
 * This synthesis is the project's own. It is informed by established
 * work in complexity science, sense-making and performance improvement,
 * but introduces its own vocabulary and model (see
 * SOURCES-AND-ATTRIBUTION.md).
 *
 * Emergent from Interego: composes the agent-trajectory layer; a team's
 * disposition is read off its descriptor trajectories. No new ontology
 * term; no gap; no ideal future state.
 */

import type { AgentTrajectory, TrajectoryStep } from './agent-trajectory.js';

// ── Dispositional reading ───────────────────────────────────────────

/**
 * The work regime — how knowable the relationship between act and
 * outcome is. The regime, not the team, decides which method is valid:
 * you can gap-analyse Evident/Knowable work; you can only probe Emergent
 * work; Turbulent work must first be stabilised.
 */
export type WorkRegime = 'Evident' | 'Knowable' | 'Emergent' | 'Turbulent';

/** A compact disposition snapshot — the baseline a probe is read against. */
export interface DispositionSnapshot {
  asserted: number;
  hypothetical: number;
  counterfactual: number;
  deliberationRatio: number;
  explorationRatio: number;
  toolCallSuccessRate: number;
  regime: WorkRegime;
  takenAt: string;
}

export interface TeamDisposition {
  team: { agentDids: string[]; trajectoryCount: number; stepCount: number };
  /** Modal balance — propensities, descriptive, NOT scored against an ideal. */
  modalBalance: {
    asserted: number;
    hypothetical: number;
    counterfactual: number;
    /** hypothetical / asserted — how much the team plans relative to acting. */
    deliberationRatio: number;
    /** counterfactual / total — how much the team explores roads-not-taken. */
    explorationRatio: number;
    /** supersedes-carrying steps / asserted — how much the team revises plans. */
    planRevisionRatio: number;
  };
  granularityBalance: { task: number; subtask: number; toolCall: number };
  /** tool-call Asserted steps that succeeded / all tool-call Asserted steps. */
  toolCallSuccessRate: number;
  /** Named propensities read off the signals — descriptive, not good/bad. */
  dispositions: Array<{ name: string; reading: string; signal: string }>;
  /** Work-regime placement of the team's behaviour + the stance it calls for. */
  regime: { name: WorkRegime; rationale: string; stance: string };
  /** Vector of change — direction from the present. NOT a target/gap. */
  vector: { direction: string; basis: string };
  /** Stated plainly so no consumer mistakes this for a gap analysis. */
  method: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Read a team's disposition from its agents' trajectories. */
export function assessDisposition(trajectories: readonly AgentTrajectory[]): TeamDisposition {
  const steps: TrajectoryStep[] = trajectories.flatMap(t => t.steps);
  const agentDids = trajectories.map(t => t.agentDid);

  const asserted = steps.filter(s => s.modalStatus === 'Asserted').length;
  const hypothetical = steps.filter(s => s.modalStatus === 'Hypothetical').length;
  const counterfactual = steps.filter(s => s.modalStatus === 'Counterfactual').length;
  const total = steps.length || 1;
  const supersedingSteps = steps.filter(s => s.supersedesId).length;

  const deliberationRatio = round2(hypothetical / (asserted || 1));
  const explorationRatio = round2(counterfactual / total);
  const planRevisionRatio = round2(supersedingSteps / (asserted || 1));

  const task = steps.filter(s => s.granularity === 'task').length;
  const subtask = steps.filter(s => s.granularity === 'subtask').length;
  const toolCall = steps.filter(s => s.granularity === 'tool-call').length;

  const assertedToolCalls = steps.filter(s => s.modalStatus === 'Asserted' && s.granularity === 'tool-call');
  const toolCallSuccessRate = assertedToolCalls.length > 0
    ? round2(assertedToolCalls.filter(s => s.result?.success !== false).length / assertedToolCalls.length)
    : 0;

  // Named propensities — descriptive readings, no value judgement.
  const dispositions: TeamDisposition['dispositions'] = [];
  if (deliberationRatio >= 0.5) {
    dispositions.push({ name: 'deliberative', signal: `deliberation ratio ${deliberationRatio}`, reading: 'the team forms many intentions relative to actions — it plans heavily.' });
  } else {
    dispositions.push({ name: 'execution-biased', signal: `deliberation ratio ${deliberationRatio}`, reading: 'the team acts more than it plans — low intention-to-action gap.' });
  }
  if (explorationRatio >= 0.12) {
    dispositions.push({ name: 'exploratory', signal: `exploration ratio ${explorationRatio}`, reading: 'the team records many counterfactual branches — it considers and rejects alternatives.' });
  } else {
    dispositions.push({ name: 'committed', signal: `exploration ratio ${explorationRatio}`, reading: 'the team rarely records rejected alternatives — it commits to its first line.' });
  }
  if (planRevisionRatio >= 0.25) {
    dispositions.push({ name: 'plan-revising', signal: `plan-revision ratio ${planRevisionRatio}`, reading: 'executed steps frequently supersede earlier intentions — the team adapts its plan in flight.' });
  } else {
    dispositions.push({ name: 'plan-adhering', signal: `plan-revision ratio ${planRevisionRatio}`, reading: 'executed steps rarely revise intentions — the team holds to its initial plan.' });
  }

  return {
    team: { agentDids, trajectoryCount: trajectories.length, stepCount: steps.length },
    modalBalance: { asserted, hypothetical, counterfactual, deliberationRatio, explorationRatio, planRevisionRatio },
    granularityBalance: { task, subtask, toolCall },
    toolCallSuccessRate,
    dispositions,
    regime: placeRegime({ explorationRatio, planRevisionRatio, task, subtask, toolCall, total, toolCallSuccessRate }),
    vector: readVector(trajectories),
    method: 'Dispositional read. This is NOT a gap analysis — there is no ideal future state and no score-vs-exemplary. It describes what the team is propense to do and which way it is drifting.',
  };
}

/** Heuristic work-regime placement of the team's behaviour. */
function placeRegime(s: {
  explorationRatio: number; planRevisionRatio: number;
  task: number; subtask: number; toolCall: number; total: number; toolCallSuccessRate: number;
}): TeamDisposition['regime'] {
  const structured = (s.task + s.subtask) / (s.total || 1) >= 0.25;
  if (s.toolCallSuccessRate < 0.34 && !structured) {
    return { name: 'Turbulent', rationale: 'low success, no structure — behaviour is not yet patterned.', stance: 'act, then read — stabilise first with a decisive intervention, then re-read.' };
  }
  if (s.explorationRatio >= 0.12 || s.planRevisionRatio >= 0.25) {
    return { name: 'Emergent', rationale: 'the team explores counterfactual branches and revises plans in flight — cause and effect are only coherent in retrospect.', stance: 'probe, observe, and steer — run safe-to-fail constraint probes; amplify what coheres, dampen what does not. Do NOT gap-analyse.' };
  }
  if (structured && s.toolCallSuccessRate >= 0.6) {
    return { name: 'Knowable', rationale: 'structured, hierarchically planned work with reliable outcomes — expert analysis applies.', stance: 'analyse, then apply — good practice exists; analysis can find a sound intervention.' };
  }
  return { name: 'Evident', rationale: 'repetitive, reliable, low-variance behaviour — the relationship between act and outcome is self-evident.', stance: 'categorise, then apply — apply the established practice; watch only for drift.' };
}

/** Direction of drift from the present — NOT a destination. */
function readVector(trajectories: readonly AgentTrajectory[]): TeamDisposition['vector'] {
  const tc = trajectories
    .flatMap(t => t.steps)
    .filter(s => s.modalStatus === 'Asserted' && s.granularity === 'tool-call')
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  if (tc.length < 4) {
    return { direction: 'indeterminate', basis: 'too little trajectory history to read a vector — run probes and re-read.' };
  }
  const mid = Math.floor(tc.length / 2);
  const rate = (arr: TrajectoryStep[]): number =>
    arr.length ? arr.filter(s => s.result?.success !== false).length / arr.length : 0;
  const before = rate(tc.slice(0, mid));
  const after = rate(tc.slice(mid));
  const delta = round2(after - before);
  if (Math.abs(delta) < 0.05) {
    return { direction: 'holding', basis: `tool-call success steady (${round2(before)} → ${round2(after)}) — no strong drift.` };
  }
  return {
    direction: delta > 0 ? 'drifting toward higher tool-call success' : 'drifting toward lower tool-call success',
    basis: `tool-call success ${round2(before)} → ${round2(after)} across the trajectory timeline (Δ ${delta}).`,
  };
}

export function snapshot(d: TeamDisposition): DispositionSnapshot {
  return {
    asserted: d.modalBalance.asserted,
    hypothetical: d.modalBalance.hypothetical,
    counterfactual: d.modalBalance.counterfactual,
    deliberationRatio: d.modalBalance.deliberationRatio,
    explorationRatio: d.modalBalance.explorationRatio,
    toolCallSuccessRate: d.toolCallSuccessRate,
    regime: d.regime.name,
    takenAt: new Date().toISOString(),
  };
}

// ── Safe-to-fail probes (a deliberate, reversible change to a constraint) ─

/** A portfolio of probes run in parallel — some coherent with the current
 *  disposition, some oblique, some deliberately contradictory. */
export type ProbeCoherence = 'coherent' | 'oblique' | 'contradictory';

export interface PerformanceProbeInput {
  team: string[];
  /** The CONSTRAINT being nudged — never an outcome. (Manage constraints
   *  and constructors, not targets.) */
  constraintTarget: string;
  /** Human description of the nudge — a deliberate, reversible change. */
  change: string;
  coherence: ProbeCoherence;
  hypothesizedEffect: string;
  /** Weak signals declared up-front — what tells you to amplify vs dampen. */
  amplifySignal: string;
  dampenSignal: string;
  recordedBy: string;
}

export interface PerformanceProbe extends PerformanceProbeInput {
  id: string;
  recordedAt: string;
  /** The disposition at the moment the change was made — the causal baseline. */
  preDisposition: DispositionSnapshot;
}

let _probeCounter = 0;
export function buildProbe(input: PerformanceProbeInput, preDisposition: DispositionSnapshot): PerformanceProbe {
  return {
    ...input,
    id: `urn:foxxi:performance-probe:${Date.now()}-${_probeCounter++}`,
    recordedAt: new Date().toISOString(),
    preDisposition,
  };
}

// ── Causal read (interventional + counterfactual) ───────────────────

export interface CausalRead {
  probeId: string;
  constraintTarget: string;
  /** Interventional — did the disposition shift after the deliberate change? */
  interventional: {
    before: DispositionSnapshot;
    after: DispositionSnapshot;
    shift: string;
    movedAsHypothesised: boolean;
  };
  /** Counterfactual — what the team would otherwise have done, read from
   *  the Counterfactual branches its agents recorded. */
  counterfactual: { reading: string; basis: string };
  /** Honest epistemics — this is retrospective coherence, not prediction. */
  caveat: string;
  /** Amplify what coheres, dampen what does not, else let it run. */
  recommendation: 'amplify' | 'dampen' | 'let-run';
  recommendationRationale: string;
}

/** Compute the causal read for a probe given the team's current trajectories. */
export function computeCausalRead(
  probe: PerformanceProbe,
  currentTrajectories: readonly AgentTrajectory[],
): CausalRead {
  const after = snapshot(assessDisposition(currentTrajectories));
  const before = probe.preDisposition;

  const dSuccess = round2(after.toolCallSuccessRate - before.toolCallSuccessRate);
  const dExploration = round2(after.explorationRatio - before.explorationRatio);
  const dDeliberation = round2(after.deliberationRatio - before.deliberationRatio);
  const regimeChanged = before.regime !== after.regime;

  const shiftParts: string[] = [];
  if (dSuccess !== 0) shiftParts.push(`tool-call success ${dSuccess > 0 ? '+' : ''}${dSuccess}`);
  if (dExploration !== 0) shiftParts.push(`exploration ${dExploration > 0 ? '+' : ''}${dExploration}`);
  if (dDeliberation !== 0) shiftParts.push(`deliberation ${dDeliberation > 0 ? '+' : ''}${dDeliberation}`);
  if (regimeChanged) shiftParts.push(`work regime ${before.regime} → ${after.regime}`);
  const shift = shiftParts.length > 0 ? shiftParts.join(', ') : 'no measurable shift in the disposition snapshot';

  // The probe hypothesised an effect; did the disposition move at all in a
  // direction consistent with a real intervention effect?
  const movedAsHypothesised = dSuccess > 0 || regimeChanged || Math.abs(dExploration) > 0.05;

  // Counterfactual reading from the recorded Counterfactual steps.
  const cfSteps = currentTrajectories.flatMap(t => t.steps).filter(s => s.modalStatus === 'Counterfactual');
  const counterfactual = cfSteps.length > 0
    ? {
        reading: `Absent the probe, the team's recorded counterfactual branches indicate it would otherwise have pursued: ${[...new Set(cfSteps.map(s => s.objectName))].slice(0, 4).join('; ')}.`,
        basis: `${cfSteps.length} Counterfactual trajectory step(s) — the roads the agents considered and rejected.`,
      }
    : {
        reading: 'No counterfactual branches were recorded, so the counterfactual reading is unavailable — the team did not surface the roads it did not take.',
        basis: '0 Counterfactual trajectory steps.',
      };

  let recommendation: CausalRead['recommendation'];
  let recommendationRationale: string;
  if (movedAsHypothesised && dSuccess >= 0) {
    recommendation = 'amplify';
    recommendationRationale = `the disposition moved in a coherent direction after the change to ${probe.constraintTarget}; amplify — run more probes of this kind.`;
  } else if (dSuccess < -0.05 || (regimeChanged && after.regime === 'Turbulent')) {
    recommendation = 'dampen';
    recommendationRationale = `the disposition degraded after the change to ${probe.constraintTarget}; dampen — withdraw this probe (it was safe-to-fail; this is the cheap failure working as intended).`;
  } else {
    recommendation = 'let-run';
    recommendationRationale = 'no clear coherence yet; let the probe run longer before judging — complex systems show their shape only over time.';
  }

  return {
    probeId: probe.id,
    constraintTarget: probe.constraintTarget,
    interventional: { before, after, shift, movedAsHypothesised },
    counterfactual,
    caveat: 'This is RETROSPECTIVE COHERENCE, not a predictive causal claim. In a complex system the disposition shifted after the intervention; that the probe *caused* it can only ever be read in hindsight, never forecast.',
    recommendation,
    recommendationRationale,
  };
}
