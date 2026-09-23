/**
 * Which content judgment should a person confirm next?
 *
 * A learning engineer's confirmations are the scarce input: each becomes an outcome the
 * calibration is computed over and, from there, the attestation the registry weighs. Spent at
 * random they teach little — a fifth confirmation of a claim the model was sure of and right
 * about moves nothing. This ranks the pending Hypothetical judgments on the tenant pod by what
 * a person's answer would teach, from signals the judgments already carry and the calibration
 * already states. No new model call: the ranking is deterministic, and every factor is returned
 * beside the priority it produced, so the person can disagree with the weights and not with
 * the arithmetic.
 *
 *   uncertainty       1 − the model's confidence in its answer. A judgment the model was unsure
 *                     of is the one whose confirmation says the most about where it is wrong.
 *   cellNeed          how far the question kind's calibration cell is from earning anything: no
 *                     cell yet, 1; a Hypothetical cell, 0.5 plus half the distance to its floor;
 *                     an Asserted cell, a quarter of its miss rate — calibrated kinds still learn
 *                     from their misses, but slowly.
 *   evidenceWeakness  1 / (1 + evidence items). A claim judged on context alone is the one a
 *                     person's reading corrects most.
 *
 *   priority = 0.5 · uncertainty + 0.3 · cellNeed + 0.2 · evidenceWeakness
 *
 * The weights are policy, stated once in CONFIRM_NEXT_WEIGHTS and returned with the queue; the
 * factors are the reusable judgments. Ties break oldest first, so no judgment starves. Pure; the
 * bridge reads the pod and serves the queue.
 */
import type { ContentJudgment, ContentJudgmentCalibration, ContentJudgmentOutcome } from './content-judgment.js';

export const CONFIRM_NEXT_WEIGHTS = { uncertainty: 0.4, cellNeed: 0.2, evidenceWeakness: 0.1, disagreement: 0.3 } as const;
export const CONFIRM_NEXT_DEFAULT_LIMIT = 12;
/** How much of a claim is shown in the queue; the judgment on the pod carries the rest. */
export const CLAIM_EXCERPT = 200;

/** A judgment as the pod lists it: the entity IRI the outcome will name, and the payload. */
export interface PendingJudgment {
  readonly judgmentIri: string;
  readonly judgment: ContentJudgment;
  /** Other judges whose newest judgment of the same claim answers differently: where a person's word teaches the most. */
  readonly disagreesWith?: readonly { readonly judge: string; readonly answer: string; readonly judgmentIri: string }[];
  /** Agent confirmations already recorded for this judgment, so a runner does not repeat its own. */
  readonly agentConfirmations?: readonly { readonly by: string; readonly answer: string }[];
}

export interface ConfirmNextWhy {
  readonly uncertainty: number;
  readonly cellNeed: number;
  readonly evidenceWeakness: number;
  /** 1 when another judge's newest judgment of the claim answers differently, else 0. */
  readonly disagreement: number;
  readonly disagreesWith: readonly { readonly judge: string; readonly answer: string; readonly judgmentIri: string }[];
  readonly cellStatus: 'none' | 'Hypothetical' | 'Asserted';
  readonly cellSamples: number;
}

export interface ConfirmNextEntry {
  readonly judgmentIri: string;
  readonly judgmentKind: string;
  readonly claim: string;
  readonly answer: string;
  readonly confidence: number;
  readonly evidenceCount: number;
  readonly createdAt: string;
  /** 0..1, higher first. */
  readonly priority: number;
  readonly why: ConfirmNextWhy;
  readonly agentConfirmations: readonly { readonly by: string; readonly answer: string }[];
  /** The call that records the person's answer; confirmed_answer starts as the model's, to keep or change. */
  readonly confirm: { readonly tool: 'foxxi.confirm_content_judgment'; readonly arguments: { readonly judgment_iri: string; readonly confirmed_answer: string } };
}

export interface ConfirmNextQueue {
  readonly kind: 'confirm-next';
  readonly queue: readonly ConfirmNextEntry[];
  /** How many judgments await a person, whether or not they made the queue's limit. */
  readonly pending: number;
  readonly confirmed: number;
  readonly weights: typeof CONFIRM_NEXT_WEIGHTS;
  readonly computedAt: string;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** The judgments no PERSON has confirmed or refuted yet: an agent's confirmation, a peer judge's included, is counted but does not retire a judgment from the queue. */
export function pendingJudgments(judgments: readonly PendingJudgment[], outcomes: readonly ContentJudgmentOutcome[]): PendingJudgment[] {
  const decided = new Set(outcomes.filter((o) => (o.confirmedByKind ?? 'human') === 'human').map((o) => o.judgmentIri));
  return judgments.filter((p) => !decided.has(p.judgmentIri));
}

export function uncertaintyOf(j: Pick<ContentJudgment, 'confidence'>): number {
  return clamp01(1 - j.confidence);
}

/** How far the kind's calibration cell is from earning anything, and what the cell is. */
export function cellNeedOf(cal: Pick<ContentJudgmentCalibration, 'cells' | 'minSamples'>, kind: string): { need: number; status: ConfirmNextWhy['cellStatus']; samples: number } {
  const cell = cal.cells.find((c) => c.judgmentKind === kind);
  if (!cell || cell.samples === 0) return { need: 1, status: 'none', samples: 0 };
  if (cell.status !== 'Asserted') {
    const floor = Math.max(1, cal.minSamples);
    return { need: clamp01(0.5 + 0.5 * (floor - cell.samples) / floor), status: 'Hypothetical', samples: cell.samples };
  }
  return { need: clamp01(0.25 * (1 - (cell.hitRate ?? 1))), status: 'Asserted', samples: cell.samples };
}

export function evidenceWeaknessOf(j: Pick<ContentJudgment, 'evidenceCount'>): number {
  return 1 / (1 + Math.max(0, j.evidenceCount));
}

export function priorityOf(j: ContentJudgment, cal: Pick<ContentJudgmentCalibration, 'cells' | 'minSamples'>, disagreesWith: PendingJudgment['disagreesWith'] = []): { priority: number; why: ConfirmNextWhy } {
  const uncertainty = uncertaintyOf(j);
  const cell = cellNeedOf(cal, j.judgmentKind);
  const evidenceWeakness = evidenceWeaknessOf(j);
  const disagreement = disagreesWith.length > 0 ? 1 : 0;
  const w = CONFIRM_NEXT_WEIGHTS;
  return {
    priority: round3(w.uncertainty * uncertainty + w.cellNeed * cell.need + w.evidenceWeakness * evidenceWeakness + w.disagreement * disagreement),
    why: { uncertainty: round3(uncertainty), cellNeed: round3(cell.need), evidenceWeakness: round3(evidenceWeakness), disagreement, disagreesWith: [...disagreesWith], cellStatus: cell.status, cellSamples: cell.samples },
  };
}

/** The queue: pending judgments, highest priority first, oldest first among equals, cut at `limit`. */
export function confirmNext(pending: readonly PendingJudgment[], cal: Pick<ContentJudgmentCalibration, 'cells' | 'minSamples'>, opts: { readonly limit?: number; readonly confirmed?: number; readonly now?: Date } = {}): ConfirmNextQueue {
  const limit = Math.max(1, Math.floor(opts.limit ?? CONFIRM_NEXT_DEFAULT_LIMIT));
  const ranked = pending
    .map((p) => ({ p, ...priorityOf(p.judgment, cal, p.disagreesWith ?? []) }))
    .sort((a, b) => b.priority - a.priority || a.p.judgment.createdAt.localeCompare(b.p.judgment.createdAt) || a.p.judgmentIri.localeCompare(b.p.judgmentIri));
  const queue: ConfirmNextEntry[] = ranked.slice(0, limit).map(({ p, priority, why }) => ({
    judgmentIri: p.judgmentIri,
    judgmentKind: p.judgment.judgmentKind,
    claim: p.judgment.claimText.length > CLAIM_EXCERPT ? `${p.judgment.claimText.slice(0, CLAIM_EXCERPT - 1)}…` : p.judgment.claimText,
    answer: p.judgment.answer,
    confidence: p.judgment.confidence,
    evidenceCount: p.judgment.evidenceCount,
    createdAt: p.judgment.createdAt,
    priority,
    why,
    agentConfirmations: [...(p.agentConfirmations ?? [])],
    confirm: { tool: 'foxxi.confirm_content_judgment', arguments: { judgment_iri: p.judgmentIri, confirmed_answer: p.judgment.answer } },
  }));
  return { kind: 'confirm-next', queue, pending: pending.length, confirmed: opts.confirmed ?? 0, weights: CONFIRM_NEXT_WEIGHTS, computedAt: (opts.now ?? new Date()).toISOString() };
}
