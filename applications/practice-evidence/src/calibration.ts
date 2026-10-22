/**
 * How far the judge agrees with the people who review it, per criterion, and where a reviewer
 * should look next.
 *
 * Built on the shared judgment kit (judgment → outcome → calibration → attestation → reputation →
 * autonomy). What this vertical adds:
 *   · one decision kind per (rubric hash × criterion), so calibration never mixes rubric versions
 *     (DECISIONS #5, #7), and every cell is further split by the judge's prompt template;
 *   · an ordinal measure — mean absolute level distance — next to the kit's nominal Brier, which
 *     scores two levels off the same as one;
 *   · a check of ≥ 5 DISTINCT people, because the kit counts confirmed outcomes, not people;
 *   · every figure is "agreement with the reviewer". Reviewers usually see the judge's levels
 *     first, so this is anchored agreement, never accuracy.
 *
 * Standing is computed on read and changes nothing in this version: every attempt still needs a
 * qualified reviewer before it can leave as evidence. Nothing here is published.
 */
import { sha256 } from '@interego/core';
import {
  attestation, autonomy, awaitingAPerson, calibration, judgment, outcome, reputations,
  type DecisionKind, type LoopJudgment, type LoopOutcome,
} from '../../_shared/judgment-kit/loop.js';
import type { InferenceRoute } from './model.js';
import {
  agreementOf, creditedLevels, criterionContentHash, levelIndex, PROVISIONAL_LABEL,
  type AssessmentUse, type CriterionSpec, type JudgeChosenBy, type JudgmentResult, type ScenarioSpec,
} from './practice.js';
import {
  LIFECYCLE_STATES, standingReview,
  type AttemptBody, type LifecycleState, type RecordTarget, type ReviewResult,
} from './records.js';

export const STANDING_POLICY = { floor: 0.9, minSamples: 20, minHumanConfirmers: 5, minDistinctHumanConfirmers: 5 } as const;
export const AUDIT_SAMPLE_RATE = 0.2;
export const STANDING_EFFECT = 'None in this version: standing is reported, it changes nothing. Every attempt still needs a qualified reviewer before it can leave as evidence.';
export const METRIC_NOTE = 'Agreement with the reviewer, who usually saw the judge\'s levels first; blind rows are declared by the reviewer. This is not accuracy against a known answer. Computed on read; nothing here is published.';

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const ratio = (num: number, den: number): number | null => (den === 0 ? null : round3(num / den));

/** One decision kind per (rubric version × criterion); the alternatives are that version's level ids, in order. */
export function criterionKind(rubricHash: string, c: CriterionSpec): DecisionKind {
  return { kind: `pev/${rubricHash.slice(0, 16)}/${c.id}`, alternatives: c.levels.map((l) => l.id), axis: 'accuracy' };
}

/** The judge as calibration knows it: its id plus the prompt it ran under. */
export function cellJudge(judgeId: string, promptTemplateHash: string): string {
  return `${judgeId}#prompt-${promptTemplateHash.slice(0, 12)}`;
}

/** About one attempt in five, chosen by the attempt's IRI alone, so anyone can recompute the sample. */
export function inAuditSample(attemptIri: string): boolean {
  return parseInt(sha256(`pev-audit|${attemptIri}`).slice(0, 8), 16) / 0xffffffff < AUDIT_SAMPLE_RATE;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Outcome rows (§9.1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface OutcomeRow {
  readonly kind: DecisionKind; readonly criterionId: string; readonly criterionTitle: string; readonly rubricHash: string;
  readonly criterionContentHash: string; readonly judgeId: string; readonly judgeKind: 'model' | 'agent' | 'person';
  readonly judgeRoute: InferenceRoute; readonly promptTemplateHash: string; readonly judgmentIndex: number; readonly repeat: boolean;
  /** For a repeat: the level index the repeated judgment chose for this criterion. */
  readonly repeatOfJudgedIndex: number | null;
  readonly chosenBy: JudgeChosenBy; readonly counterpartControlledBy: 'platform' | 'learner-model' | 'learner';
  readonly loopJudgment: LoopJudgment; readonly loopOutcome: LoopOutcome; readonly judgedIndex: number; readonly finalIndex: number;
  readonly levelCount: number; readonly unverified: boolean; readonly auditSample: boolean; readonly sawJudgeLevelsFirst: boolean;
  readonly reviewerDid: string; readonly reviewIndex: number; readonly demo: boolean;
}

/**
 * One row per (judgment × criterion) of an attempt with a standing review. Every row rests on a
 * level the reviewer stated in their signed review; nothing is inferred from silence.
 */
export function outcomeRows(a: {
  attemptIri: string; scenarioSpec: ScenarioSpec; rubricHash: string; judgments: readonly JudgmentResult[];
  standingReview: ReviewResult | null; counterpartControlledBy: 'platform' | 'learner-model' | 'learner';
  demo: boolean; authorTest?: boolean; criterionContentHashes?: Readonly<Record<string, string>>;
}): OutcomeRow[] {
  const review = a.standingReview;
  if (!review || review.withdrawn || a.authorTest === true) return [];
  const rows: OutcomeRow[] = [];
  const audit = inAuditSample(a.attemptIri);
  for (const j of a.judgments) {
    const original = j.repeatOf === null ? undefined : a.judgments.find((x) => x.index === j.repeatOf);
    for (const c of a.scenarioSpec.rubric.criteria) {
      const cj = j.criteria.find((x) => x.criterionId === c.id);
      const fin = review.finalLevels.find((x) => x.criterionId === c.id);
      if (!cj || !fin) continue;
      const kind = criterionKind(a.rubricHash, c);
      const loopJudgment = judgment(kind, {
        id: `${a.attemptIri}#j${j.index}#${c.id}`, subject: a.attemptIri, answer: cj.levelId,
        ...(cj.probabilities ? { probabilities: cj.probabilities } : {}),
        judge: cellJudge(j.judge.id, j.promptTemplateHash), createdAt: j.judgedAt,
      });
      const loopOutcome = outcome(loopJudgment, fin.levelId, { did: review.reviewer.did, kind: 'human' }, new Date(review.reviewedAt));
      const originalCj = original?.criteria.find((x) => x.criterionId === c.id);
      rows.push({
        kind, criterionId: c.id, criterionTitle: c.title, rubricHash: a.rubricHash,
        criterionContentHash: a.criterionContentHashes?.[c.id] ?? criterionContentHash(c),
        judgeId: j.judge.id, judgeKind: j.judge.kind, judgeRoute: j.route, promptTemplateHash: j.promptTemplateHash,
        judgmentIndex: j.index, repeat: j.repeatOf !== null,
        repeatOfJudgedIndex: originalCj ? originalCj.levelIndex : null,
        chosenBy: j.chosenBy, counterpartControlledBy: a.counterpartControlledBy,
        loopJudgment, loopOutcome, judgedIndex: cj.levelIndex, finalIndex: levelIndex(c, fin.levelId), levelCount: c.levels.length,
        unverified: cj.status === 'unverified', auditSample: audit, sawJudgeLevelsFirst: review.sawJudgeLevelsFirst,
        reviewerDid: review.reviewer.did, reviewIndex: review.index, demo: a.demo,
      });
    }
  }
  return rows;
}

/** Rows for an attempt body, using its own standing review and demo marks. */
export function outcomeRowsOf(a: AttemptBody, criterionContentHashes?: Readonly<Record<string, string>>): OutcomeRow[] {
  const review = standingReview(a);
  return outcomeRows({
    attemptIri: a.attemptIri, scenarioSpec: a.scenarioSpec, rubricHash: a.scenario.rubricHash, judgments: a.judgments,
    standingReview: review, counterpartControlledBy: a.counterpartControlledBy,
    demo: review ? review.reviewer.serverHeldDemoKey : false, authorTest: a.authorTest,
    ...(criterionContentHashes ? { criterionContentHashes } : {}),
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Ordinal measure (§9.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Mean |judged − final| in level steps, and the same divided by (levels − 1). Two levels off counts 2. */
export function meanLevelDistance(rows: readonly Pick<OutcomeRow, 'judgedIndex' | 'finalIndex' | 'levelCount'>[]): { readonly mean: number | null; readonly normalised: number | null } {
  if (rows.length === 0) return { mean: null, normalised: null };
  let sum = 0;
  let norm = 0;
  for (const r of rows) {
    const d = Math.abs(r.judgedIndex - r.finalIndex);
    sum += d;
    norm += d / Math.max(1, r.levelCount - 1);
  }
  return { mean: round3(sum / rows.length), normalised: round3(norm / rows.length) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Cells and standing (§9.3, §9.4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface StandingView { readonly evaluated: boolean; readonly clears: boolean; readonly why: string; readonly effect: string }

export interface CalibrationCellView {
  readonly judgeId: string; readonly judgeKind: 'model' | 'agent' | 'person'; readonly promptTemplateHash: string;
  readonly grouping: 'rubric-version' | 'criterion-content';
  /** null when pooled across rubric versions. */
  readonly rubricHash: string | null;
  readonly criterionId: string; readonly criterionTitle: string; readonly criterionContentHash: string; readonly kind: string;
  readonly samples: number; readonly humanSamples: number; readonly distinctHumanConfirmers: number; readonly demoOutcomes: number;
  /** The kit's hit rate: agreement with the reviewer, NOT accuracy. */
  readonly agreementRate: number | null;
  readonly meanBrier: number | null; readonly meanLevelDistance: number | null; readonly normalisedLevelDistance: number | null;
  readonly unverifiedRate: number | null;
  readonly blindSamples: number; readonly blindAgreementRate: number | null;
  readonly repeatSamples: number; readonly repeatAgreement: number | null;
  readonly auditSampleSamples: number; readonly auditSampleAgreementRate: number | null;
  readonly auditSampleCoverage: number | null; readonly auditSamplePartial: boolean;
  readonly status: 'Hypothetical' | 'Asserted'; readonly standing: StandingView;
}

const hitRate = (rows: readonly OutcomeRow[]): number | null => ratio(rows.filter((r) => r.loopOutcome.hit).length, rows.length);
const distinctPeople = (rows: readonly OutcomeRow[]): number =>
  new Set(rows.filter((r) => r.loopOutcome.confirmedByKind === 'human').map((r) => r.reviewerDid.toLowerCase())).size;

/** Standing for one (judge × prompt × rubric version × criterion). It is reported and changes nothing. */
export function standingFor(
  rows: readonly OutcomeRow[], kind: DecisionKind, judge: { cellJudge: string; kind: 'model' | 'agent' | 'person'; route: InferenceRoute },
  o: { platformDid: string; manifestUrl: string; now: Date },
): StandingView {
  const effect = STANDING_EFFECT;
  if (judge.route === 'scripted') return { evaluated: false, clears: false, why: 'a scripted fixture is not a judge; no standing is evaluated', effect };
  if (judge.kind === 'person') return { evaluated: false, clears: false, why: 'standing is earned by software agents only; this judge is not registered as an agent', effect };
  if (!(judge.kind === 'agent' || (judge.kind === 'model' && judge.route === 'bridge-model'))) {
    return { evaluated: false, clears: false, why: 'standing is evaluated only for this bridge\'s model or a registered judge agent', effect };
  }
  const counted = rows.filter((r) => !r.demo && !r.repeat);
  if (counted.length < STANDING_POLICY.minSamples) {
    return { evaluated: true, clears: false, why: `${counted.length} outcome(s) of ${kind.kind}, below ${STANDING_POLICY.minSamples}`, effect };
  }
  const cells = calibration(counted.map((r) => r.loopOutcome), [kind], STANDING_POLICY.minSamples);
  const at = o.now.toISOString();
  const a = attestation(cells, [kind], {
    attestor: o.platformDid, subject: judge.cellJudge, descriptorUrl: o.manifestUrl, fromExecution: 'pev.calibration', attestedAt: at,
  });
  const snap = reputations(a ? [a] : [], 'pev-judge-standing', at).get(judge.cellJudge) ?? null;
  const d = autonomy({ kind: kind.kind, floor: STANDING_POLICY.floor, minSamples: STANDING_POLICY.minSamples, minHumanConfirmers: STANDING_POLICY.minHumanConfirmers }, kind, snap, a);
  const distinct = distinctPeople(counted);
  if (!d.granted) return { evaluated: true, clears: false, why: d.why, effect };
  if (distinct < STANDING_POLICY.minDistinctHumanConfirmers) {
    return { evaluated: true, clears: false, why: `${distinct} distinct people confirmed these outcomes, below ${STANDING_POLICY.minDistinctHumanConfirmers}`, effect };
  }
  return { evaluated: true, clears: true, why: d.why, effect };
}

/**
 * Cells per (judge × prompt × kind). `rubric-version` is the default and the only grouping that
 * evaluates standing; `criterion-content` pools rubric versions whose criterion means the same
 * (weights and values aside), for information only.
 */
export function calibrationCells(rows: readonly OutcomeRow[], o: {
  platformDid: string; manifestUrl: string; now: Date; groupBy: 'rubric-version' | 'criterion-content';
  auditCoverage: ReadonlyMap<string, { judged: number; reviewed: number }>;
}): CalibrationCellView[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) {
    const judgeKey = cellJudge(r.judgeId, r.promptTemplateHash);
    const key = o.groupBy === 'rubric-version'
      ? `${judgeKey}|${r.kind.kind}`
      : `${judgeKey}|${r.criterionContentHash}|${r.criterionId}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  const out: CalibrationCellView[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const judgeKey = cellJudge(first.judgeId, first.promptTemplateHash);
    const pooled = o.groupBy === 'criterion-content';
    const kind: DecisionKind = pooled
      ? { kind: `pev/content-${first.criterionContentHash.slice(0, 16)}/${first.criterionId}`, alternatives: first.kind.alternatives, axis: 'accuracy' }
      : first.kind;
    const primary = g.filter((r) => !r.repeat);
    const outcomes = primary.map((r) => (pooled ? { ...r.loopOutcome, kind: kind.kind } : r.loopOutcome));
    const cell = calibration(outcomes, [kind], STANDING_POLICY.minSamples)[0]!;
    const distance = meanLevelDistance(primary);
    const blind = primary.filter((r) => !r.sawJudgeLevelsFirst);
    const repeats = g.filter((r) => r.repeat && r.repeatOfJudgedIndex !== null);
    const auditRows = primary.filter((r) => r.auditSample);
    const hashes = [...new Set(g.map((r) => r.rubricHash))];
    let judged = 0;
    let reviewed = 0;
    for (const h of hashes) {
      const cov = o.auditCoverage.get(`${judgeKey}|${h}`);
      if (cov) { judged += cov.judged; reviewed += cov.reviewed; }
    }
    const coverage = ratio(reviewed, judged);
    const standing: StandingView = pooled
      ? { evaluated: false, clears: false, why: 'pooled across rubric versions; standing is evaluated per rubric version', effect: STANDING_EFFECT }
      : standingFor(g, kind, { cellJudge: judgeKey, kind: first.judgeKind, route: first.judgeRoute }, o);
    out.push({
      judgeId: first.judgeId, judgeKind: first.judgeKind, promptTemplateHash: first.promptTemplateHash,
      grouping: o.groupBy, rubricHash: pooled ? null : first.rubricHash,
      criterionId: first.criterionId, criterionTitle: first.criterionTitle, criterionContentHash: first.criterionContentHash,
      kind: kind.kind,
      samples: cell.samples, humanSamples: cell.humanSamples, distinctHumanConfirmers: distinctPeople(primary),
      demoOutcomes: primary.filter((r) => r.demo).length,
      agreementRate: cell.hitRate, meanBrier: cell.meanBrier,
      meanLevelDistance: distance.mean, normalisedLevelDistance: distance.normalised,
      unverifiedRate: ratio(primary.filter((r) => r.unverified).length, primary.length),
      blindSamples: blind.length, blindAgreementRate: hitRate(blind),
      repeatSamples: repeats.length,
      repeatAgreement: ratio(repeats.filter((r) => r.judgedIndex === r.repeatOfJudgedIndex).length, repeats.length),
      auditSampleSamples: auditRows.length, auditSampleAgreementRate: hitRate(auditRows),
      auditSampleCoverage: coverage, auditSamplePartial: coverage !== null && coverage < 1,
      status: cell.status, standing,
    });
  }
  return out.sort((a, b) => a.judgeId.localeCompare(b.judgeId) || a.kind.localeCompare(b.kind));
}

/**
 * Audit-sample coverage per (judge × prompt × rubric hash): of the in-sample attempts this judge
 * judged (first judgments by it, not repeats; author tests excluded), how many have a standing review.
 */
export function auditCoverageOf(attempts: readonly AttemptBody[]): Map<string, { judged: number; reviewed: number }> {
  const out = new Map<string, { judged: number; reviewed: number }>();
  for (const a of attempts) {
    if (a.authorTest || !inAuditSample(a.attemptIri)) continue;
    const reviewed = standingReview(a) !== null;
    const seen = new Set<string>();
    for (const j of a.judgments) {
      if (j.repeatOf !== null) continue;
      const key = `${cellJudge(j.judge.id, j.promptTemplateHash)}|${a.scenario.rubricHash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = out.get(key) ?? { judged: 0, reviewed: 0 };
      out.set(key, { judged: cur.judged + 1, reviewed: cur.reviewed + (reviewed ? 1 : 0) });
    }
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Review queue (§9.5): where a reviewer should look next, with the arithmetic shown
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The weights add up to 1. `unverified` and `nearThreshold` look for a judge giving too much
 * credit; `notQuoted` is the one signal for too little: criteria put at the lowest level with no
 * quote, where nothing was checked at all.
 */
export const QUEUE_WEIGHTS = {
  unverified: 0.2, notQuoted: 0.05, disagreement: 0.15, nearThreshold: 0.15, uncertainty: 0.15, cellNeed: 0.1, learnerControlled: 0.1, auditSample: 0.1,
} as const;
const UNDECLARED_UNCERTAINTY = 0.2;

export interface QueueCandidate {
  readonly attemptIri: string; readonly state: 'judged' | 'contested' | 'review-retracted'; readonly judgedAt: string;
  readonly scenarioSpec: ScenarioSpec; readonly rubricHash: string; readonly judgments: readonly JudgmentResult[];
  readonly counterpartControlledBy: 'platform' | 'learner-model' | 'learner'; readonly learnerDid: string;
  /** The learner, the judge signers and earlier reviewers, as lowercase addresses. */
  readonly excludedReviewers: readonly string[];
  readonly currentTarget: RecordTarget;
  readonly authorTest?: boolean;
}

export interface QueueWhy {
  readonly unverified: number; readonly notQuoted: number; readonly disagreement: number; readonly nearThreshold: number; readonly uncertainty: number;
  readonly uncertaintyDeclared: boolean; readonly cellNeed: number; readonly learnerControlled: number; readonly auditSample: number;
}

export interface QueueEntry extends QueueCandidate {
  readonly priority: number; readonly why: QueueWhy; readonly reopened: boolean; readonly blindFirst: boolean; readonly mayCountersignAsIs: boolean;
}

function cellNeedOf(cell: CalibrationCellView | undefined): number {
  if (!cell) return 1;
  if (cell.status === 'Hypothetical') return 0.5 + 0.5 * Math.max(0, STANDING_POLICY.minSamples - cell.samples) / STANDING_POLICY.minSamples;
  return 0.25 * (1 - (cell.agreementRate ?? 0));
}

/** The factors for one candidate, each 0..1, returned so a reviewer can dispute the weights, not the arithmetic. */
export function queueFactors(c: QueueCandidate, cells: readonly CalibrationCellView[]): QueueWhy {
  const primary = c.judgments[0];
  if (!primary) {
    return { unverified: 0, notQuoted: 0, disagreement: 0, nearThreshold: 0, uncertainty: 0, uncertaintyDeclared: false, cellNeed: 1, learnerControlled: 0, auditSample: 0 };
  }
  const spreads = agreementOf(c.scenarioSpec, c.judgments).map((x) => x.normalisedSpread);
  const disagreement = c.judgments.length > 1 && spreads.length > 0 ? Math.max(...spreads) : 0;
  const p = primary.provisional;
  const nearThreshold = p.use === 'pass-gate' ? Math.max(0, 1 - Math.abs(p.percentTenths / 10 - p.minPercent) / 10) : 0;
  const confidences = primary.criteria.map((x) => x.confidence);
  const uncertainty = confidences.length === 0 ? UNDECLARED_UNCERTAINTY
    : Math.max(...confidences.map((x) => (x === null ? UNDECLARED_UNCERTAINTY : 1 - x)));
  const judgeKey = cellJudge(primary.judge.id, primary.promptTemplateHash);
  const needs = c.scenarioSpec.rubric.criteria.map((crit) => {
    const kind = criterionKind(c.rubricHash, crit).kind;
    return cellNeedOf(cells.find((x) => x.grouping === 'rubric-version' && x.kind === kind
      && cellJudge(x.judgeId, x.promptTemplateHash) === judgeKey));
  });
  const learnerControlled = c.counterpartControlledBy === 'learner' || c.judgments.some((j) => j.chosenBy === 'learner') ? 1
    : c.counterpartControlledBy === 'learner-model' ? 0.5 : 0;
  const notQuoted = primary.criteria.length === 0 ? 0 : primary.criteria.filter((x) => x.status === 'no-quote-needed').length / primary.criteria.length;
  return {
    unverified: primary.unverifiedCriteria.length > 0 ? 1 : 0,
    notQuoted: round3(notQuoted),
    disagreement: round3(disagreement),
    nearThreshold: round3(nearThreshold),
    uncertainty: round3(uncertainty),
    uncertaintyDeclared: confidences.length > 0 && confidences.every((x) => x !== null),
    cellNeed: round3(needs.length === 0 ? 1 : Math.max(...needs)),
    learnerControlled,
    auditSample: inAuditSample(c.attemptIri) ? 1 : 0,
  };
}

/** Σ weight × factor, rounded to 3 places. */
export function priorityOf(w: QueueWhy): number {
  const W = QUEUE_WEIGHTS;
  return round3(W.unverified * w.unverified + W.notQuoted * w.notQuoted + W.disagreement * w.disagreement + W.nearThreshold * w.nearThreshold
    + W.uncertainty * w.uncertainty + W.cellNeed * w.cellNeed + W.learnerControlled * w.learnerControlled + W.auditSample * w.auditSample);
}

/**
 * The queue for one reviewer: judged attempts no person has reviewed, plus contested and retracted
 * ones (a person asked for another look). Reopened first, then priority, then oldest.
 */
export function reviewQueue(
  candidates: readonly QueueCandidate[], cells: readonly CalibrationCellView[], o: { limit: number; reviewer: string },
): { readonly entries: readonly QueueEntry[]; readonly awaitingReview: number; readonly excludedAsConflicted: number; readonly weights: typeof QUEUE_WEIGHTS } {
  const reviewer = o.reviewer.toLowerCase();
  let excludedAsConflicted = 0;
  const entries: QueueEntry[] = [];
  for (const c of candidates) {
    if (c.authorTest === true) continue;
    if (c.state === 'judged') {
      const loop = c.judgments.flatMap((j) => c.scenarioSpec.rubric.criteria.flatMap((crit) => {
        const cj = j.criteria.find((x) => x.criterionId === crit.id);
        return cj ? [judgment(criterionKind(c.rubricHash, crit), {
          id: `${c.attemptIri}#j${j.index}#${crit.id}`, subject: c.attemptIri, answer: cj.levelId,
          judge: cellJudge(j.judge.id, j.promptTemplateHash), createdAt: j.judgedAt,
        })] : [];
      }));
      if (awaitingAPerson(loop, []).length === 0) continue;
    }
    if (c.excludedReviewers.some((x) => x.toLowerCase() === reviewer)) { excludedAsConflicted += 1; continue; }
    const why = queueFactors(c, cells);
    const primary = c.judgments[0];
    entries.push({
      ...c, priority: priorityOf(why), why, reopened: c.state !== 'judged', blindFirst: inAuditSample(c.attemptIri),
      mayCountersignAsIs: primary !== undefined && primary.unverifiedCriteria.length === 0,
    });
  }
  entries.sort((a, b) => Number(b.reopened) - Number(a.reopened) || b.priority - a.priority
    || a.judgedAt.localeCompare(b.judgedAt) || a.attemptIri.localeCompare(b.attemptIri));
  return { entries: entries.slice(0, Math.max(0, o.limit)), awaitingReview: entries.length, excludedAsConflicted, weights: QUEUE_WEIGHTS };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Results per scenario (§9.6): what happened in practice, with small counts suppressed
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const RESULTS_K = 5;
export const RESULTS_LABEL = 'Practice results: what happened in practice. They do not show what caused it.';
export const SUPPRESSION_RULE = 'A row of level counts is shown whole or not at all: when any count in it is from 1 to k − 1, every count in the row is hidden and only the row total stays, so no hidden count can be worked out by subtraction. A split (coached or not, first attempt or later) is withheld for a criterion when either of its rows is hidden, because the two rows add up to the shown total. Counts of what reviewers changed follow the same rule, and only reviewers and admins, who may read any attempt, see each change and its reason.';

export interface LevelCount { readonly levelId: string; readonly label: string; readonly count: number | null; readonly suppressed: boolean }
export interface CriterionDistribution {
  readonly criterionId: string; readonly title: string; readonly n: number; readonly levels: readonly LevelCount[];
  /** Set on both rows of a split that is withheld because one of its rows is hidden. */
  readonly withheld?: true;
}

export interface ReviewerChange {
  readonly criterionId: string; readonly judgeLevelId: string; readonly finalLevelId: string;
  readonly why: string | null; readonly reviewedAt: string;
}

export interface ScenarioResultsView {
  readonly scenarioIri: string; readonly versions: readonly number[]; readonly assessmentUse: AssessmentUse; readonly k: number;
  readonly label: string; readonly suppressionRule: string;
  readonly counts: { readonly attempts: number; readonly byState: Readonly<Record<LifecycleState, number>>; readonly authorTestExcluded: number; readonly redacted: number };
  readonly final: {
    readonly reviewedAttempts: number; readonly perCriterion: readonly CriterionDistribution[];
    readonly meetsPassRule: { readonly count: number | null; readonly of: number; readonly suppressed: boolean } | null;
    readonly byCoached: { readonly coached: readonly CriterionDistribution[]; readonly notCoached: readonly CriterionDistribution[] };
    readonly byAttemptNumber: { readonly first: readonly CriterionDistribution[]; readonly later: readonly CriterionDistribution[] };
  };
  readonly provisional: { readonly judgedAttempts: number; readonly perCriterion: readonly CriterionDistribution[]; readonly label: typeof PROVISIONAL_LABEL };
  /** 'each' for a reviewer or an admin; 'counts' for an author, who sees only the suppressed counts below. */
  readonly reviewerChangesShown: 'each' | 'counts';
  /** Every level a reviewer set differently from the judge, with the reason: empty unless shown is 'each'. */
  readonly reviewerChanges: readonly ReviewerChange[];
  /** Per criterion: how many reviewed attempts the reviewer raised or lowered from the judge's level. */
  readonly reviewerChangeCounts: readonly { readonly criterionId: string; readonly raised: number | null; readonly lowered: number | null; readonly suppressed: boolean }[];
  readonly changedByReviewer: readonly { readonly criterionId: string; readonly reviewedAttempts: number; readonly changed: number | null; readonly suppressed: boolean }[];
}

const isSmall = (c: number, k: number): boolean => c > 0 && c < k;

/**
 * Show a row whole or not at all. When any count is from 1 to k − 1, every count (zeros included)
 * is hidden, so the hidden counts are one of several ways to make the row's total.
 */
export function suppressRow(counts: readonly { levelId: string; label: string; count: number }[], k: number): LevelCount[] {
  const hide = counts.some((c) => isSmall(c.count, k));
  return counts.map((c) => (hide
    ? { levelId: c.levelId, label: c.label, count: null, suppressed: true }
    : { levelId: c.levelId, label: c.label, count: c.count, suppressed: false }));
}

function distributions(spec: ScenarioSpec, levelSets: readonly Readonly<Record<string, string>>[], k: number): CriterionDistribution[] {
  return spec.rubric.criteria.map((c) => {
    const counts = c.levels.map((l) => ({ levelId: l.id, label: l.label, count: 0 }));
    let n = 0;
    for (const set of levelSets) {
      const idx = levelIndex(c, set[c.id] ?? '');
      const slot = idx >= 0 ? counts[idx] : undefined;
      if (!slot) continue;
      slot.count += 1;
      n += 1;
    }
    return { criterionId: c.id, title: c.title, n, levels: suppressRow(counts, k) };
  });
}

/** Withhold both rows of a split for a criterion when either row hides a count. */
function split(a: readonly CriterionDistribution[], b: readonly CriterionDistribution[]): [CriterionDistribution[], CriterionDistribution[]] {
  const hidden = (d: CriterionDistribution | undefined): boolean => d !== undefined && d.levels.some((l) => l.suppressed);
  const withhold = (d: CriterionDistribution): CriterionDistribution => ({
    ...d, levels: d.levels.map((l) => ({ levelId: l.levelId, label: l.label, count: null, suppressed: true })), withheld: true,
  });
  const out: [CriterionDistribution[], CriterionDistribution[]] = [[], []];
  a.forEach((x, i) => {
    const y = b[i];
    const w = hidden(x) || hidden(y);
    out[0].push(w ? withhold(x) : x);
    if (y) out[1].push(w ? withhold(y) : y);
  });
  return out;
}

/** Results across the chosen versions of one scenario, from trusted attempt heads. */
export function scenarioResults(i: {
  scenarioIri: string; spec: ScenarioSpec; versions: readonly number[]; attempts: readonly AttemptBody[]; k: number;
  /** True for a reviewer or an admin: each change a reviewer made is listed with its reason. */
  detail?: boolean;
}): ScenarioResultsView {
  const inScope = i.attempts.filter((a) => a.scenario.scenarioIri === i.scenarioIri
    && (i.versions.length === 0 || i.versions.includes(a.scenario.version)));
  const counted = inScope.filter((a) => !a.authorTest);
  const byState = Object.fromEntries(LIFECYCLE_STATES.map((s) => [s, 0])) as Record<LifecycleState, number>;
  for (const a of counted) byState[a.state] += 1;
  const reviewed = counted.flatMap((a) => {
    const r = standingReview(a);
    return r ? [{ a, r, levels: Object.fromEntries(r.finalLevels.map((f) => [f.criterionId, f.levelId])) as Record<string, string> }] : [];
  });
  const judged = counted.flatMap((a) => {
    const j = a.judgments[0];
    return j ? [{ a, levels: creditedLevels(a.scenarioSpec, j) }] : [];
  });
  const finalSets = (pred: (a: AttemptBody) => boolean): Record<string, string>[] => reviewed.filter((x) => pred(x.a)).map((x) => x.levels);

  let meetsPassRule: ScenarioResultsView['final']['meetsPassRule'] = null;
  if (i.spec.assessmentUse === 'pass-gate') {
    const gated = reviewed.filter((x) => x.r.assessment.use === 'pass-gate');
    const count = gated.filter((x) => x.r.assessment.use === 'pass-gate' && x.r.assessment.meetsPassRule).length;
    const of = gated.length;
    const suppressed = isSmall(count, i.k) || isSmall(of - count, i.k);
    meetsPassRule = { count: suppressed ? null : count, of, suppressed };
  }

  const changes: ReviewerChange[] = [];
  const tally = new Map<string, { reviewedAttempts: number; changed: number; raised: number; lowered: number }>();
  for (const { a, r } of reviewed) {
    const primary = a.judgments[0];
    for (const c of i.spec.rubric.criteria) {
      const fin = r.finalLevels.find((f) => f.criterionId === c.id);
      const judgeLevel = primary?.criteria.find((x) => x.criterionId === c.id)?.levelId;
      if (!fin || judgeLevel === undefined) continue;
      const step = levelIndex(c, fin.levelId) - levelIndex(c, judgeLevel);
      const cur = tally.get(c.id) ?? { reviewedAttempts: 0, changed: 0, raised: 0, lowered: 0 };
      tally.set(c.id, {
        reviewedAttempts: cur.reviewedAttempts + 1, changed: cur.changed + (fin.levelId !== judgeLevel ? 1 : 0),
        raised: cur.raised + (step > 0 ? 1 : 0), lowered: cur.lowered + (step < 0 ? 1 : 0),
      });
      if (r.outcome === 'overridden' && fin.from === 'reviewer') {
        changes.push({ criterionId: c.id, judgeLevelId: judgeLevel, finalLevelId: fin.levelId, why: fin.why ?? null, reviewedAt: r.reviewedAt });
      }
    }
  }
  const detail = i.detail === true;
  // raised, lowered and unchanged are one row: shown whole or not at all, like a level row.
  const hideChanges = (x: { reviewedAttempts: number; changed: number; raised: number; lowered: number }): boolean =>
    !detail && [x.raised, x.lowered, x.reviewedAttempts - x.changed].some((n) => isSmall(n, i.k));
  const t = (id: string): { reviewedAttempts: number; changed: number; raised: number; lowered: number } =>
    tally.get(id) ?? { reviewedAttempts: 0, changed: 0, raised: 0, lowered: 0 };
  const [coached, notCoached] = split(distributions(i.spec, finalSets((a) => a.coached), i.k), distributions(i.spec, finalSets((a) => !a.coached), i.k));
  const [first, later] = split(distributions(i.spec, finalSets((a) => a.attemptNumber === 1), i.k), distributions(i.spec, finalSets((a) => a.attemptNumber > 1), i.k));

  return {
    scenarioIri: i.scenarioIri,
    versions: [...new Set(inScope.map((a) => a.scenario.version))].sort((x, y) => x - y),
    assessmentUse: i.spec.assessmentUse, k: i.k, label: RESULTS_LABEL, suppressionRule: SUPPRESSION_RULE,
    counts: {
      attempts: counted.length, byState, authorTestExcluded: inScope.length - counted.length,
      redacted: counted.filter((a) => a.state === 'redacted').length,
    },
    final: {
      reviewedAttempts: reviewed.length,
      perCriterion: distributions(i.spec, finalSets(() => true), i.k),
      meetsPassRule,
      byCoached: { coached, notCoached },
      byAttemptNumber: { first, later },
    },
    provisional: { judgedAttempts: judged.length, perCriterion: distributions(i.spec, judged.map((x) => x.levels), i.k), label: PROVISIONAL_LABEL },
    reviewerChangesShown: detail ? 'each' : 'counts',
    reviewerChanges: detail ? changes.sort((x, y) => x.reviewedAt.localeCompare(y.reviewedAt)) : [],
    reviewerChangeCounts: i.spec.rubric.criteria.map((c) => {
      const x = t(c.id);
      const hide = hideChanges(x);
      return { criterionId: c.id, raised: hide ? null : x.raised, lowered: hide ? null : x.lowered, suppressed: hide };
    }),
    changedByReviewer: i.spec.rubric.criteria.map((c) => {
      const x = t(c.id);
      const hide = hideChanges(x);
      return { criterionId: c.id, reviewedAttempts: x.reviewedAttempts, changed: hide ? null : x.changed, suppressed: hide };
    }),
  };
}
