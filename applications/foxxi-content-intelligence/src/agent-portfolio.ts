/**
 * Comparative agent / harness portfolio evaluation.
 *
 * The enterprise problem: several teams have each built an agent or a
 * harness; the teams argue over whose is better; executives must decide
 * whether to converge on one, fund several, or change course. The
 * reflex is a benchmark leaderboard — "harness A: 87, harness B: 84,
 * ship A." That reflex is wrong, and this module refuses it.
 *
 * It refuses it for the same reason agent-disposition.ts refuses gap
 * analysis. A leaderboard assumes the choice is Knowable — a knowable
 * best, found by measurement. But whether to standardise on one agentic
 * harness is usually a COMPLEX-domain decision: the work the harnesses
 * do is itself complex, the "best" depends on the task mix, and
 * premature convergence is the ideal-future-state trap — it spends the
 * portfolio's optionality before the domain has shown its shape.
 *
 * So this module produces a PORTFOLIO READ, not a ranking:
 *   1. it reads the work regime of the WORK itself (pooled across
 *      every candidate's runs) — what KIND of problem are these
 *      harnesses being asked to solve;
 *   2. it reads each candidate's DISPOSITION (via agent-disposition.ts)
 *      and how well that disposition COHERES with the work domain —
 *      not a score, a fit;
 *   3. it diagnoses what kind of DECISION the executives face, and
 *      answers "should we develop only one?" accordingly:
 *        · Evident / Knowable work  → converging is sound; analysis
 *          can name a direction without losing optionality;
 *        · Emergent work              → do NOT converge yet; the
 *          competing teams ARE the safe-to-fail probe portfolio —
 *          keeping them is the correct strategy, not waste;
 *        · complementary dispositions → recombine: compose the
 *          harnesses (the substrate's `union` operator does exactly
 *          this) rather than pick one;
 *        · thin evidence             → gather more before deciding.
 *
 * Pure: no I/O. Composes agent-disposition.ts; no new ontology term.
 *
 * Layer: L3 vertical.
 */

import { assessDisposition, type WorkRegime, type TeamDisposition } from './agent-disposition.js';
import type { AgentTrajectory } from './agent-trajectory.js';
import type { AgentEvaluation, CandidateRun, HarnessMeta } from './agent-evaluation.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The evidence one candidate brings to the comparison. */
export interface CandidateEvidence {
  candidateId: string;
  agentName: string;
  team: string;
  harness?: HarnessMeta;
  runs: CandidateRun[];
}

export type CoherenceRating = 'coheres' | 'oblique' | 'mismatched';
export type PortfolioStance = 'converge' | 'parallel' | 'recombine' | 'gather-evidence';

export interface CandidatePortfolioProfile {
  candidateId: string;
  agentName: string;
  team: string;
  harness?: HarnessMeta;
  runCount: number;
  /** Run facts — NOT a score. */
  runProfile: {
    successRate: number;
    avgQuality?: number;
    totalCostUsd?: number;
    avgCostUsd?: number;
  };
  /** The candidate's dispositional read. */
  disposition: {
    regime: WorkRegime;
    named: Array<{ name: string; reading: string }>;
    toolCallSuccessRate: number;
    vector: string;
  };
  /** How the candidate's disposition fits the work domain. */
  coherence: { rating: CoherenceRating; reading: string };
}

export interface PortfolioRead {
  evaluation: { id: string; name: string; decisionQuestion: string };
  /** The work regime of the WORK, pooled across every candidate's runs. */
  workDomain: { domain: WorkRegime; rationale: string };
  candidates: CandidatePortfolioProfile[];
  /** Candidates enrolled but with no runs yet — noted, not compared. */
  awaitingEvidence: string[];
  /** What KIND of decision this is — and the direct answer to
   *  "should we develop only one harness?". */
  decision: {
    type: WorkRegime;
    reading: string;
    convergenceGuidance: string;
  };
  portfolioStance: PortfolioStance;
  stanceRationale: string;
  /** When the stance is `converge`, the direction analysis points to. */
  convergeOn?: { candidateId: string; agentName: string; team: string; rationale: string };
  /** When the stance is `recombine`, the complementary candidates. */
  recombination?: { candidates: string[]; reading: string };
  /** Honest epistemics. */
  caveat: string;
  method: string;
}

const MIN_RUNS_PER_CANDIDATE = 3;

/**
 * Compare a cohort of competing agents / harnesses and produce the
 * complexity-aware portfolio read.
 */
export function comparePortfolio(
  evaluation: Pick<AgentEvaluation, 'id' | 'name' | 'decisionQuestion'>,
  evidence: CandidateEvidence[],
): PortfolioRead {
  const withRuns = evidence.filter(e => e.runs.length > 0);
  const awaitingEvidence = evidence.filter(e => e.runs.length === 0).map(e => e.agentName);

  const method = 'Portfolio read (work-regime / safe-to-fail portfolio). This is NOT a benchmark leaderboard and emits no overall score. It reads the complexity of the work, each candidate\'s disposition + fit, and what kind of decision the cohort faces.';
  const caveat = 'Retrospective coherence, not prediction. This frames the decision and reports fit; it does not forecast which harness will win. In a Emergent domain "the best harness" is not a knowable fact ahead of time.';

  // ── Thin-evidence guard ──────────────────────────────────────────
  if (withRuns.length < 2) {
    return {
      evaluation,
      workDomain: { domain: 'Turbulent', rationale: 'fewer than two candidates have recorded runs — there is nothing to compare yet.' },
      candidates: withRuns.map(e => candidateProfile(e, 'Turbulent')),
      awaitingEvidence,
      decision: {
        type: 'Turbulent',
        reading: 'No decision is supportable yet — a comparison needs at least two candidates with runs.',
        convergenceGuidance: 'Do not converge or rule anything out. Get every candidate executing real runs first.',
      },
      portfolioStance: 'gather-evidence',
      stanceRationale: `Only ${withRuns.length} candidate(s) have runs. Record runs for the rest before reading the portfolio.`,
      caveat,
      method,
    };
  }

  const allTrajectories: AgentTrajectory[] = withRuns.flatMap(e => e.runs.map(r => r.trajectory));
  const pooled = assessDisposition(allTrajectories);
  const workDomain = { domain: pooled.regime.name, rationale: pooled.regime.rationale };

  const candidates = withRuns.map(e => candidateProfile(e, workDomain.domain));

  const thin = withRuns.some(e => e.runs.length < MIN_RUNS_PER_CANDIDATE);
  if (thin) {
    return {
      evaluation,
      workDomain,
      candidates,
      awaitingEvidence,
      decision: {
        type: workDomain.domain,
        reading: 'The work looks ' + workDomain.domain + ', but at least one candidate has too few runs to read its disposition reliably.',
        convergenceGuidance: 'Hold the decision. Each candidate needs a handful of real runs before the portfolio read is trustworthy.',
      },
      portfolioStance: 'gather-evidence',
      stanceRationale: `A candidate has fewer than ${MIN_RUNS_PER_CANDIDATE} runs. Even a complexity-aware read needs a minimum of trajectory history per candidate.`,
      caveat,
      method,
    };
  }

  // ── Complementarity — do the dispositions span the axes? ─────────
  const namedSets = candidates.map(c => new Set(c.disposition.named.map(n => n.name)));
  const anyHas = (name: string): boolean => namedSets.some(s => s.has(name));
  const complementary =
    (anyHas('exploratory') && anyHas('committed'))
    || (anyHas('deliberative') && anyHas('execution-biased'))
    || (anyHas('plan-revising') && anyHas('plan-adhering'));

  // ── Stance + the answer to "develop only one?" ───────────────────
  let portfolioStance: PortfolioStance;
  let stanceRationale: string;
  let convergeOn: PortfolioRead['convergeOn'];
  let recombination: PortfolioRead['recombination'];
  let convergenceGuidance: string;
  let decisionReading: string;

  if (workDomain.domain === 'Turbulent') {
    portfolioStance = 'parallel';
    decisionReading = 'The work is Turbulent — the harnesses\' behaviour is not yet patterned, so a comparison cannot yet separate them.';
    stanceRationale = 'Turbulent work: keep every candidate running to let a pattern emerge. Ranking now would lock in noise.';
    convergenceGuidance = 'Do NOT converge. There is no stable signal to converge toward. Keep all candidates; re-read once behaviour patterns.';
  } else if (workDomain.domain === 'Emergent') {
    decisionReading = 'The work is Emergent — cause and effect cohere only in retrospect, so "the best harness" is not a fact knowable ahead of time. The competing teams are, whether the org named it or not, a portfolio of safe-to-fail probes.';
    if (complementary) {
      portfolioStance = 'recombine';
      recombination = {
        candidates: candidates.map(c => c.agentName),
        reading: 'The candidates\' dispositions are complementary — they span the deliberation / exploration / plan-revision axes rather than clustering. The highest-leverage move is not to pick one but to COMPOSE them: route tasks to the harness whose disposition fits, or build one harness that takes each team\'s cohering trait. The substrate\'s `union` operator composes their trajectories directly — composition is a first-class move, not a workaround.',
      };
      stanceRationale = 'Emergent work + complementary dispositions: the candidates are not really rivals, they are parts. Recombining beats choosing.';
      convergenceGuidance = 'Do NOT converge on one — and do not merely keep them parallel either. The candidates are complementary; commission a composition (task-routing or a merged harness). Picking one would discard a capability another already has.';
    } else {
      portfolioStance = 'parallel';
      stanceRationale = 'Emergent work: keep ≥2 candidates as a deliberate safe-to-fail probe portfolio. Amplify the ones cohering with the work, dampen the oblique, let the rest run. The internal competition is the correct exploration strategy.';
      convergenceGuidance = 'Do NOT converge on one harness yet. Multiple teams independently building is not duplicated effort in a Emergent domain — it IS the right move: a portfolio of safe-to-fail probes. Premature standardisation is the ideal-future-state trap. Fund the cohering candidates to continue; treat the oblique ones as cheap, informative failures.';
    }
  } else {
    // Evident or Knowable — analysable. Naming a direction is appropriate.
    const best = pickCoherer(candidates);
    decisionReading = workDomain.domain === 'Evident'
      ? 'The work is Evident — the relationship between a harness\'s behaviour and its outcomes is self-evident. This is a genuinely analysable choice.'
      : 'The work is Knowable — structured, analysable work with reliable outcomes. Expert analysis CAN name a sound direction here; this is not a Emergent domain where convergence is premature.';
    if (best && complementary && workDomain.domain === 'Knowable') {
      portfolioStance = 'recombine';
      recombination = {
        candidates: candidates.map(c => c.agentName),
        reading: 'Even though the work is analysable, the candidates\' dispositions are complementary — composing them (task-routing, or merging each team\'s cohering trait via the substrate\'s `union` operator) yields more than picking the single best.',
      };
      stanceRationale = 'Knowable work but complementary candidates: a merged harness dominates any single one.';
      convergenceGuidance = 'Converging on one is defensible — but the candidates are complementary, so composing them is strictly better. Prefer a merged harness; fall back to the single coherer below if a merge is not feasible.';
    } else if (best) {
      portfolioStance = 'converge';
      convergeOn = {
        candidateId: best.candidateId,
        agentName: best.agentName,
        team: best.team,
        rationale: `In ${workDomain.domain} work, ${best.agentName} (${best.team}) is the candidate whose disposition coheres with the domain and whose run evidence is strongest (success rate ${best.runProfile.successRate}${best.runProfile.avgCostUsd !== undefined ? `, avg cost $${best.runProfile.avgCostUsd}` : ''}). Because the domain is analysable, naming this direction does not sacrifice optionality the org would actually use.`,
      };
      stanceRationale = `${workDomain.domain} work is analysable; one harness can be chosen on evidence. ${best.agentName} coheres best. Retain the runner-up as a documented fallback — not a parallel programme.`;
      convergenceGuidance = `Converging is sound. The work is ${workDomain.domain} (analysable); standardising on ${best.agentName} cuts cost without losing optionality the org would exercise. Keep the runner-up as a documented fallback, not a funded parallel track.`;
    } else {
      portfolioStance = 'converge';
      const cheapest = [...candidates].sort((a, b) => (a.runProfile.avgCostUsd ?? Infinity) - (b.runProfile.avgCostUsd ?? Infinity))[0]!;
      convergeOn = {
        candidateId: cheapest.candidateId,
        agentName: cheapest.agentName,
        team: cheapest.team,
        rationale: `No candidate coheres distinctly better with this ${workDomain.domain} domain — the candidates are close. In an analysable domain a close field resolves on cost: ${cheapest.agentName} (${cheapest.team}) is the lower-cost harness.`,
      };
      stanceRationale = `${workDomain.domain} work, candidates close: analysis resolves a tie on cost. Keeping parallel programmes here buys optionality an analysable domain will not use.`;
      convergenceGuidance = `Converge. The work is ${workDomain.domain} and the candidates are close — the analysable tie-breaker is cost. Parallel development past this point is pure spend.`;
    }
  }

  return {
    evaluation,
    workDomain,
    candidates,
    awaitingEvidence,
    decision: { type: workDomain.domain, reading: decisionReading, convergenceGuidance },
    portfolioStance,
    stanceRationale,
    ...(convergeOn ? { convergeOn } : {}),
    ...(recombination ? { recombination } : {}),
    caveat,
    method,
  };
}

// ── Per-candidate profile ────────────────────────────────────────────

function candidateProfile(e: CandidateEvidence, workDomain: WorkRegime): CandidatePortfolioProfile {
  const disposition = assessDisposition(e.runs.map(r => r.trajectory));
  const runProfile = computeRunProfile(e.runs);
  return {
    candidateId: e.candidateId,
    agentName: e.agentName,
    team: e.team,
    ...(e.harness ? { harness: e.harness } : {}),
    runCount: e.runs.length,
    runProfile,
    disposition: {
      regime: disposition.regime.name,
      named: disposition.dispositions.map(d => ({ name: d.name, reading: d.reading })),
      toolCallSuccessRate: disposition.toolCallSuccessRate,
      vector: disposition.vector.direction,
    },
    coherence: readCoherence(workDomain, disposition),
  };
}

function computeRunProfile(runs: CandidateRun[]): CandidatePortfolioProfile['runProfile'] {
  const successRate = round2(runs.filter(r => r.success).length / runs.length);
  const qualities = runs.map(r => r.quality).filter((q): q is number => typeof q === 'number');
  const costs = runs.map(r => r.costUsd).filter((c): c is number => typeof c === 'number');
  return {
    successRate,
    ...(qualities.length ? { avgQuality: round2(qualities.reduce((a, b) => a + b, 0) / qualities.length) } : {}),
    ...(costs.length ? {
      totalCostUsd: round2(costs.reduce((a, b) => a + b, 0)),
      avgCostUsd: round2(costs.reduce((a, b) => a + b, 0) / costs.length),
    } : {}),
  };
}

/** How a candidate's disposition fits the work domain — a fit, not a score. */
function readCoherence(workDomain: WorkRegime, d: TeamDisposition): { rating: CoherenceRating; reading: string } {
  const has = (name: string): boolean => d.dispositions.some(x => x.name === name);
  const tcs = d.toolCallSuccessRate;
  if (workDomain === 'Emergent') {
    if (has('exploratory') || has('plan-revising')) {
      return { rating: 'coheres', reading: 'explores branches and revises plans in flight — the disposition a Emergent domain rewards.' };
    }
    if (has('execution-biased') && has('committed') && has('plan-adhering')) {
      return { rating: 'mismatched', reading: 'commits to its first line and rarely revises — brittle in a Emergent domain where the plan must adapt.' };
    }
    return { rating: 'oblique', reading: 'a mixed disposition — neither strongly adaptive nor strongly rigid for Emergent work.' };
  }
  if (workDomain === 'Knowable') {
    if (has('plan-adhering') && tcs >= 0.6) {
      return { rating: 'coheres', reading: 'executes a planned line reliably — the disposition Knowable, analysable work rewards.' };
    }
    if (has('exploratory') || tcs < 0.4) {
      return { rating: 'mismatched', reading: 'explores heavily or executes unreliably — wasted motion in an analysable domain with a knowable good practice.' };
    }
    return { rating: 'oblique', reading: 'an adequate but not distinctive fit for analysable work.' };
  }
  if (workDomain === 'Evident') {
    if (has('committed') && has('plan-adhering') && tcs >= 0.7) {
      return { rating: 'coheres', reading: 'commits and executes reliably — exactly what Evident, best-practice work needs.' };
    }
    if (tcs < 0.5) {
      return { rating: 'mismatched', reading: 'unreliable execution on work where the act-outcome link is self-evident.' };
    }
    return { rating: 'oblique', reading: 'a workable fit for Evident work.' };
  }
  return { rating: 'oblique', reading: 'the work is Turbulent — no stable domain to cohere with yet.' };
}

/** The candidate that coheres best, with the strongest run evidence;
 *  undefined when no candidate stands out. */
function pickCoherer(candidates: CandidatePortfolioProfile[]): CandidatePortfolioProfile | undefined {
  const cohering = candidates.filter(c => c.coherence.rating === 'coheres');
  const pool = cohering.length > 0 ? cohering : candidates.filter(c => c.coherence.rating === 'oblique');
  if (pool.length === 0) return undefined;
  // A clear coherer only if exactly one candidate `coheres`, or one
  // leads on run evidence among the cohering set.
  const ranked = [...pool].sort((a, b) => {
    if (b.runProfile.successRate !== a.runProfile.successRate) {
      return b.runProfile.successRate - a.runProfile.successRate;
    }
    return (a.runProfile.avgCostUsd ?? Infinity) - (b.runProfile.avgCostUsd ?? Infinity);
  });
  const lead = ranked[0]!;
  const second = ranked[1];
  // Distinct only if it actually cohered, and it is not in a dead heat.
  if (lead.coherence.rating !== 'coheres') return undefined;
  if (second && second.coherence.rating === 'coheres'
    && second.runProfile.successRate === lead.runProfile.successRate
    && (second.runProfile.avgCostUsd ?? 0) === (lead.runProfile.avgCostUsd ?? 0)) {
    return undefined; // genuine tie — let the caller resolve on cost
  }
  return lead;
}
