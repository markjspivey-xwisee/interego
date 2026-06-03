/**
 * Learning Engineering analytics — composes existing substrate primitives
 * (cohort intel + audit chain + competency framework + concept graph)
 * into the kinds of analyses a learning engineer actually runs.
 *
 * No new substrate primitives. Each function is a pure(-ish) composer
 * over data the bridge can already discover or compute.
 *
 * Reference: ICICLE Learning Engineering principles + IEEE P2247 series
 * (Adaptive Instructional Systems). LE is the cross of instructional
 * design + data science + engineering applied to learning systems.
 *
 * Functions:
 *   A. designAbExperiment          — content-variant A/B with stat-power calc
 *   B. estimateConceptDifficulty   — IRT-ish difficulty from prereq depth + cohort signal
 *   C. learningCurveAnalyzer       — retention over attempts; plateau detection
 *   D. calibrateMasteryThreshold   — find the cmi5 score threshold that best discriminates
 *                                    downstream performance from non-mastery
 *   E. frameworkGapAnalysis        — find competencies with no taught concepts +
 *                                    concepts not aligned to any competency
 */

import type { CohortIntelligence } from './cohort-intel.js';
import type { CourseConcept, CoursePrereqEdge } from '../dashboard-app/src/types.js';

// ── A. A/B experiment design ─────────────────────────────────

export interface AbExperimentDesign {
  experimentId: string;
  variantA: { courseId: string; courseTitle?: string };
  variantB: { courseId: string; courseTitle?: string };
  primaryMetric: 'completion-rate' | 'mastery-score' | 'time-to-mastery' | 'retention-30-day' | 'downstream-prereq-pass-rate';
  randomization: 'simple' | 'stratified-by-audience-tag';
  /** Power analysis result. */
  sampleSize: {
    perVariant: number;
    total: number;
    minimumDetectableEffect: number;
    alpha: number;
    power: number;
    rationale: string;
  };
  /** Pre-registered analysis plan — IRB-friendly and prevents p-hacking. */
  analysisPlan: {
    primaryTest: 'two-sample-t' | 'chi-squared' | 'mann-whitney-u';
    multipleComparisonCorrection?: 'bonferroni' | 'benjamini-hochberg';
    stoppingRule?: string;
  };
  /** Estimated date by which power is reached given the tenant's typical
   *  enrolment volume — caller supplies the per-week-enrolment estimate. */
  estimatedDurationDays?: number;
}

export function designAbExperiment(args: {
  variantA: { courseId: string; courseTitle?: string };
  variantB: { courseId: string; courseTitle?: string };
  primaryMetric: AbExperimentDesign['primaryMetric'];
  minimumDetectableEffect: number;   // e.g. 0.05 for a 5pp completion-rate lift
  alpha?: number;                    // default 0.05
  power?: number;                    // default 0.8
  randomization?: AbExperimentDesign['randomization'];
  perWeekEnrolment?: number;
}): AbExperimentDesign {
  const alpha = args.alpha ?? 0.05;
  const power = args.power ?? 0.8;
  // Two-proportion sample-size approximation (normal-approximation,
  // assumed baseline p=0.5 for max sample; conservative). Per-arm:
  //   n = (z_{α/2} + z_{β})^2 * 2 * p * (1-p) / Δ^2
  const z_alpha = 1.96;  // two-sided 0.05
  const z_beta = 0.84;   // power 0.80
  const p = 0.5;
  const perVariant = Math.ceil(
    Math.pow(z_alpha + z_beta, 2) * 2 * p * (1 - p) / Math.pow(args.minimumDetectableEffect, 2),
  );
  const total = perVariant * 2;
  const estimatedDurationDays = args.perWeekEnrolment && args.perWeekEnrolment > 0
    ? Math.ceil((total / args.perWeekEnrolment) * 7)
    : undefined;
  return {
    experimentId: `urn:foxxi:experiment:${Date.now()}`,
    variantA: args.variantA,
    variantB: args.variantB,
    primaryMetric: args.primaryMetric,
    randomization: args.randomization ?? 'stratified-by-audience-tag',
    sampleSize: {
      perVariant,
      total,
      minimumDetectableEffect: args.minimumDetectableEffect,
      alpha,
      power,
      rationale: `Two-proportion normal-approximation, baseline p=0.5 (worst case). Detect a ${(args.minimumDetectableEffect * 100).toFixed(1)}pp difference at α=${alpha}, power=${power}.`,
    },
    analysisPlan: {
      primaryTest: args.primaryMetric === 'time-to-mastery' ? 'mann-whitney-u'
        : args.primaryMetric === 'completion-rate' || args.primaryMetric === 'retention-30-day' || args.primaryMetric === 'downstream-prereq-pass-rate' ? 'chi-squared'
        : 'two-sample-t',
      multipleComparisonCorrection: 'benjamini-hochberg',
      stoppingRule: 'no early stopping (pre-registered fixed n)',
    },
    estimatedDurationDays,
  };
}

// ── B. Concept difficulty estimate ──────────────────────────

export interface ConceptDifficultyEstimate {
  conceptId: string;
  conceptLabel?: string;
  /** 0..1 scale; higher = harder. */
  difficultyEstimate: number;
  components: {
    prereqDepth: number;        // how deep in the prereq graph this concept sits
    cohortStruggleScore: number; // 0..1 from cohort_concept_intelligence
    isFoundational: boolean;    // many other concepts depend on it
  };
  rationale: string;
}

/**
 * Heuristic difficulty estimate composed from (a) the prereq graph
 * topology and (b) cohort question-frequency data. Pure IRT requires
 * per-learner response data we don't model yet; this is the right-
 * shape proxy.
 */
export function estimateConceptDifficulty(args: {
  concepts: readonly CourseConcept[];
  prereqEdges: readonly CoursePrereqEdge[];
  cohortIntel?: CohortIntelligence;
}): ConceptDifficultyEstimate[] {
  // Build prereq depth via BFS from concepts with no incoming edges.
  const incoming = new Map<string, number>();
  for (const e of args.prereqEdges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const outgoing = new Map<string, Set<string>>();
  for (const e of args.prereqEdges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, new Set());
    outgoing.get(e.from)!.add(e.to);
  }
  // Approximate depth as count of distinct ancestors.
  const ancestorsOf = (cid: string): number => {
    const seen = new Set<string>();
    const stack = [cid];
    while (stack.length > 0) {
      const x = stack.pop()!;
      for (const e of args.prereqEdges) {
        if (e.to === x && !seen.has(e.from)) {
          seen.add(e.from);
          stack.push(e.from);
        }
      }
      if (seen.size > 50) break; // safety cap
    }
    return seen.size;
  };
  const struggleMap = new Map<string, number>();
  for (const c of args.cohortIntel?.conceptStats ?? []) {
    struggleMap.set(c.conceptId, c.cohortCoveragePct / 100);
  }
  const maxDepth = Math.max(1, ...args.concepts.map(c => ancestorsOf(c.id)));
  return args.concepts.map(c => {
    const depth = ancestorsOf(c.id);
    const struggle = struggleMap.get(c.id) ?? 0;
    const dependents = outgoing.get(c.id)?.size ?? 0;
    const isFoundational = dependents >= 3;
    // Weighted blend: depth 60% (topology), struggle 40% (empirical).
    const difficulty = 0.6 * (depth / maxDepth) + 0.4 * struggle;
    return {
      conceptId: c.id,
      conceptLabel: c.label,
      difficultyEstimate: Math.round(difficulty * 1000) / 1000,
      components: {
        prereqDepth: depth,
        cohortStruggleScore: Math.round(struggle * 1000) / 1000,
        isFoundational,
      },
      rationale: `Depth ${depth} (of max ${maxDepth}), cohort struggle ${(struggle * 100).toFixed(1)}%${isFoundational ? `, ${dependents} dependent concepts (foundational)` : ''}.`,
    };
  }).sort((a, b) => b.difficultyEstimate - a.difficultyEstimate);
}

// ── C. Learning-curve analyzer ───────────────────────────────

export interface LearningCurvePoint {
  attemptNumber: number;
  cumulativeMasteryRate: number; // 0..1
  attempters: number;
}

export interface LearningCurveAnalysis {
  conceptId: string;
  conceptLabel?: string;
  curve: LearningCurvePoint[];
  plateauDetectedAtAttempt?: number;
  plateauRate?: number;
  diagnosis: 'rising' | 'plateau-low' | 'plateau-high' | 'insufficient-data';
  recommendation: string;
}

/**
 * Compute mastery-rate-per-attempt curve from per-learner attempt data.
 * Detects a plateau (3 consecutive attempts with <1pp improvement) and
 * recommends an action: rising curves are fine; low plateaus need
 * material rework; high plateaus indicate sufficient mastery.
 */
export function analyzeLearningCurve(args: {
  conceptId: string;
  conceptLabel?: string;
  /** Per-attempt outcomes: each entry is one learner's outcome on their Nth attempt. */
  attempts: ReadonlyArray<{ learnerId: string; attemptNumber: number; mastered: boolean }>;
}): LearningCurveAnalysis {
  const byAttempt = new Map<number, { mastered: number; total: number }>();
  for (const a of args.attempts) {
    const slot = byAttempt.get(a.attemptNumber) ?? { mastered: 0, total: 0 };
    slot.total++;
    if (a.mastered) slot.mastered++;
    byAttempt.set(a.attemptNumber, slot);
  }
  const sortedAttempts = [...byAttempt.keys()].sort((a, b) => a - b);
  const curve: LearningCurvePoint[] = sortedAttempts.map(n => {
    const s = byAttempt.get(n)!;
    return { attemptNumber: n, cumulativeMasteryRate: s.mastered / Math.max(1, s.total), attempters: s.total };
  });
  // Plateau detection.
  let plateauAtt: number | undefined;
  let plateauRate: number | undefined;
  for (let i = 2; i < curve.length; i++) {
    const dPrev = Math.abs(curve[i]!.cumulativeMasteryRate - curve[i - 1]!.cumulativeMasteryRate);
    const dPrev2 = Math.abs(curve[i - 1]!.cumulativeMasteryRate - curve[i - 2]!.cumulativeMasteryRate);
    if (dPrev < 0.01 && dPrev2 < 0.01) {
      plateauAtt = curve[i - 2]!.attemptNumber;
      plateauRate = curve[i - 2]!.cumulativeMasteryRate;
      break;
    }
  }
  let diagnosis: LearningCurveAnalysis['diagnosis'];
  let recommendation: string;
  if (curve.length < 2) {
    diagnosis = 'insufficient-data';
    recommendation = 'Collect more attempt data before drawing conclusions.';
  } else if (plateauAtt === undefined) {
    diagnosis = 'rising';
    recommendation = 'Curve still rising — current material is working; let learners continue.';
  } else if ((plateauRate ?? 0) >= 0.8) {
    diagnosis = 'plateau-high';
    recommendation = `Plateau at ${((plateauRate ?? 0) * 100).toFixed(1)}% from attempt ${plateauAtt} — most of the cohort has mastered the concept; remaining attempts unlikely to help further.`;
  } else {
    diagnosis = 'plateau-low';
    recommendation = `Plateau at ${((plateauRate ?? 0) * 100).toFixed(1)}% from attempt ${plateauAtt} — material may need rework or scaffolding; additional attempts are not converting learners.`;
  }
  return { conceptId: args.conceptId, conceptLabel: args.conceptLabel, curve, plateauDetectedAtAttempt: plateauAtt, plateauRate, diagnosis, recommendation };
}

// ── D. Mastery threshold calibration ────────────────────────

export interface MasteryCalibrationResult {
  optimalThreshold: number;
  rationale: string;
  /** ROC curve points for picker UI / inspection. */
  rocCurve: Array<{ threshold: number; truePositiveRate: number; falsePositiveRate: number; youdensJ: number }>;
}

/**
 * Calibrate the cmi5 mastery threshold by maximizing Youden's J statistic
 * (sensitivity + specificity - 1) against a downstream signal (typically:
 * did the learner subsequently pass the next prereq-dependent assessment).
 */
export function calibrateMasteryThreshold(args: {
  /** Per-learner: their cmi5 score on the assessment + whether downstream prereq-dependent work succeeded. */
  records: ReadonlyArray<{ scoreScaled: number; downstreamSuccess: boolean }>;
  /** Thresholds to evaluate (default: 0.0 → 1.0 step 0.05). */
  thresholdGrid?: readonly number[];
}): MasteryCalibrationResult {
  const grid = args.thresholdGrid ?? Array.from({ length: 21 }, (_, i) => i * 0.05);
  const totalPositives = args.records.filter(r => r.downstreamSuccess).length;
  const totalNegatives = args.records.length - totalPositives;
  const rocCurve: MasteryCalibrationResult['rocCurve'] = grid.map(t => {
    let tp = 0, fp = 0;
    for (const r of args.records) {
      if (r.scoreScaled >= t) {
        if (r.downstreamSuccess) tp++; else fp++;
      }
    }
    const tpr = totalPositives > 0 ? tp / totalPositives : 0;
    const fpr = totalNegatives > 0 ? fp / totalNegatives : 0;
    return {
      threshold: Math.round(t * 1000) / 1000,
      truePositiveRate: Math.round(tpr * 1000) / 1000,
      falsePositiveRate: Math.round(fpr * 1000) / 1000,
      youdensJ: Math.round((tpr - fpr) * 1000) / 1000,
    };
  });
  const best = rocCurve.reduce((acc, p) => (p.youdensJ > acc.youdensJ ? p : acc), rocCurve[0]!);
  return {
    optimalThreshold: best.threshold,
    rationale: `Maximizes Youden's J (TPR − FPR = ${best.youdensJ}) against downstream success on N=${args.records.length} learners (${totalPositives} succeeded). At this threshold: TPR=${best.truePositiveRate}, FPR=${best.falsePositiveRate}.`,
    rocCurve,
  };
}

// ── E. Framework gap analysis ───────────────────────────────

export interface FrameworkGapReport {
  competenciesWithoutTaughtConcepts: Array<{ competencyId: string; competencyLabel?: string; reason: string }>;
  conceptsNotAlignedToAnyCompetency: Array<{ conceptId: string; conceptLabel?: string; reason: string }>;
  alignmentCoveragePct: number;
  summary: string;
}

/**
 * Cross-reference a tenant's competency framework against the concepts
 * actually taught in published courses. Flags both directions:
 *   (a) competencies in the framework with no concepts that develop them
 *       — assessments based on these can't be grounded
 *   (b) concepts in courses with no alignment to any framework competency
 *       — credentials issued for these can't reference the framework
 */
export function frameworkGapAnalysis(args: {
  frameworkSkills: ReadonlyArray<{ id: string; label?: string }>;
  courseConcepts: ReadonlyArray<CourseConcept>;
  /** alignment edges: skill → concept developed by some slide. */
  alignments: ReadonlyArray<{ skillId: string; conceptId: string }>;
}): FrameworkGapReport {
  const alignedSkills = new Set(args.alignments.map(a => a.skillId));
  const alignedConcepts = new Set(args.alignments.map(a => a.conceptId));
  const competenciesWithout = args.frameworkSkills
    .filter(s => !alignedSkills.has(s.id))
    .map(s => ({
      competencyId: s.id,
      competencyLabel: s.label,
      reason: 'No published-course concept aligns to this competency. Assessments referencing it cannot be grounded in evidence.',
    }));
  const conceptsWithout = args.courseConcepts
    .filter(c => !alignedConcepts.has(c.id))
    .map(c => ({
      conceptId: c.id,
      conceptLabel: c.label,
      reason: 'Concept is taught in a course but no framework competency cites it. Credentials issued for this concept cannot reference the formal framework.',
    }));
  const totalSkills = args.frameworkSkills.length;
  const coveredSkills = totalSkills - competenciesWithout.length;
  const alignmentCoveragePct = totalSkills > 0 ? Math.round((coveredSkills / totalSkills) * 1000) / 10 : 0;
  return {
    competenciesWithoutTaughtConcepts: competenciesWithout,
    conceptsNotAlignedToAnyCompetency: conceptsWithout,
    alignmentCoveragePct,
    summary: `Framework has ${totalSkills} competencies, ${alignmentCoveragePct}% covered by taught concepts. ${conceptsWithout.length} taught concept${conceptsWithout.length === 1 ? '' : 's'} unaligned to any competency.`,
  };
}
