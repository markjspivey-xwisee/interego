/**
 * The judgment loop, domain-free: judgment → outcome → calibration → attestation → reputation
 * → best judge → autonomy, for any kind of decision a vertical asks a model or an agent to make.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The jev-harness built this loop for code (which tests to run, whether a diff needs a person)
 * and Foxxi built it again for content (how well a claim is supported, which work regime a task
 * is in), and by 2026-09-23 the two were the same machine with different nouns: a typed answer
 * with probabilities, Hypothetical until an outcome asserts it; a calibration per kind of
 * question, Asserted from a sample floor; an attestation grounded in that calibration; a
 * registry reputation per judge; the judge to believe per kind; and a policy that says when a
 * judge's earned reputation lets it act without a person. This module is that machine with no
 * nouns from either vertical, so the next decision kind — an incident's severity, an expense
 * approval, a compliance review — is a question and a scale, not a vertical.
 *
 * What stays in the vertical: the question (what state, what criteria), where entities live and
 * how they are published, and who may call. What lives here: everything that is true of a
 * calibrated decision whatever it is about. `../tests/judgment-loop.test.ts` runs the whole
 * loop in memory on a decision kind neither vertical has.
 */
import { type Attestation, reputationOf, reputationPolicy } from './attestations.js';
import { calibrationCell, choiceBrier, type CalibrationCellSummary } from './index.js';
import type { ReputationSnapshot } from '@interego/registry';

/** The registry axes a decision kind's hit rate may be reported on; honesty is always the Brier's. */
export type DecisionAxis = 'accuracy' | 'competence' | 'relevance';

/** A decision kind: its name, its alternatives, and the registry axis its hit rate is reported on. */
export interface DecisionKind {
  readonly kind: string;
  readonly alternatives: readonly string[];
  readonly axis: DecisionAxis;
}

export interface LoopJudgment {
  readonly id: string;
  readonly kind: string;
  /** What is being judged, as the vertical identifies it: a claim, a diff, an incident. */
  readonly subject: string;
  readonly answer: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly judge: string;
  readonly createdAt: string;
}

export interface LoopOutcome {
  readonly judgmentId: string;
  readonly kind: string;
  readonly judge: string;
  readonly answer: string;
  readonly confirmedAnswer: string;
  readonly hit: boolean;
  readonly brier: number;
  readonly confirmedBy: string;
  readonly confirmedByKind: 'human' | 'agent';
  /** When the confirmation is another judge's judgment of the same subject: that judgment's id. */
  readonly confirmedFrom?: string;
  readonly createdAt: string;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

export interface JudgmentInput {
  readonly id: string;
  readonly subject: string;
  readonly answer: string;
  /** Weight per alternative; normalised here. Without it the confidence goes to the answer and the rest is spread evenly. */
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
  readonly judge: string;
  readonly createdAt?: string;
}

/** A judgment an agent or a model made, with the distribution normalised over the kind's alternatives. */
export function judgment(kind: DecisionKind, input: JudgmentInput): LoopJudgment {
  if (!kind.alternatives.includes(input.answer)) throw new Error(`the answer must be one of ${kind.alternatives.join(', ')}`);
  const declared = input.confidence === undefined ? 0.8 : Math.min(1, Math.max(0, input.confidence));
  let probabilities: Record<string, number>;
  const given = input.probabilities;
  if (given && Object.keys(given).length > 0) {
    const weight = (a: string): number => Math.max(0, given[a] ?? 0);
    const total = kind.alternatives.reduce((n, a) => n + weight(a), 0);
    if (total <= 0) throw new Error('the probabilities must put weight on at least one alternative');
    probabilities = Object.fromEntries(kind.alternatives.map((a) => [a, weight(a) / total]));
  } else {
    const rest = kind.alternatives.length > 1 ? (1 - declared) / (kind.alternatives.length - 1) : 0;
    probabilities = Object.fromEntries(kind.alternatives.map((a) => [a, a === input.answer ? declared : rest]));
  }
  const confidence = input.confidence === undefined ? probabilities[input.answer] ?? declared : declared;
  return { id: input.id, kind: kind.kind, subject: input.subject, answer: input.answer, probabilities, confidence: round(confidence), judge: input.judge, createdAt: input.createdAt ?? new Date().toISOString() };
}

/** What a confirmation makes of a judgment: hit or miss, and the multiclass Brier of its distribution. */
export function outcome(j: LoopJudgment, confirmedAnswer: string, by: { readonly did: string; readonly kind?: 'human' | 'agent'; readonly from?: string }, now: Date = new Date()): LoopOutcome {
  if (!(confirmedAnswer in j.probabilities)) throw new Error(`the confirmed answer must be one of ${Object.keys(j.probabilities).join(', ')}`);
  return {
    judgmentId: j.id, kind: j.kind, judge: j.judge, answer: j.answer, confirmedAnswer, hit: j.answer === confirmedAnswer, brier: choiceBrier(j.probabilities, confirmedAnswer),
    confirmedBy: by.did, confirmedByKind: by.kind ?? 'human', ...(by.from ? { confirmedFrom: by.from } : {}), createdAt: now.toISOString(),
  };
}

export interface LoopCell extends CalibrationCellSummary {
  readonly kind: string;
  readonly humanSamples: number;
  readonly agentSamples: number;
}

/** Per kind: how often the judge had the confirmed answer, and how far off its distribution was; people and agents counted apart. */
export function calibration(outcomes: readonly LoopOutcome[], kinds: readonly DecisionKind[], minSamples: number): LoopCell[] {
  return kinds.map((k) => {
    const ofKind = outcomes.filter((o) => o.kind === k.kind);
    const agentSamples = ofKind.filter((o) => o.confirmedByKind === 'agent').length;
    return { kind: k.kind, ...calibrationCell(ofKind, minSamples), humanSamples: ofKind.length - agentSamples, agentSamples };
  });
}

export interface LoopAttestation extends Attestation {
  readonly samples: number;
  readonly kinds: readonly string[];
  readonly confirmers: { readonly human: number; readonly agent: number };
}

/**
 * The attestation a judge's calibration earns: each Asserted cell's hit rate on its kind's axis
 * (kinds sharing an axis pooled by sample), honesty from the mean Brier, Self when the attestor
 * is the judge and Peer otherwise. Undefined until some cell has reached its floor.
 */
export function attestation(cells: readonly LoopCell[], kinds: readonly DecisionKind[], who: { readonly attestor: string; readonly subject: string; readonly descriptorUrl: string; readonly fromExecution: string; readonly attestedAt?: string }): LoopAttestation | undefined {
  const asserted = cells.filter((c) => c.status === 'Asserted' && c.hitRate !== null);
  if (asserted.length === 0) return undefined;
  const pooled = new Map<string, { hits: number; samples: number }>();
  for (const c of asserted) {
    const axis = kinds.find((k) => k.kind === c.kind)?.axis ?? 'accuracy';
    const p = pooled.get(axis) ?? { hits: 0, samples: 0 };
    pooled.set(axis, { hits: p.hits + (c.hitRate ?? 0) * c.samples, samples: p.samples + c.samples });
  }
  const axes: Record<string, number> = {};
  for (const [axis, p] of pooled) axes[axis] = round(p.samples > 0 ? p.hits / p.samples : 0);
  const briers = asserted.map((c) => c.meanBrier).filter((b): b is number => b !== null);
  if (briers.length > 0) axes['honesty'] = round(1 - briers.reduce((a, b) => a + b, 0) / briers.length / 2);
  axes['recency'] = 1;
  return {
    descriptorUrl: who.descriptorUrl, attestor: who.attestor, subject: who.subject, direction: who.subject === who.attestor ? 'Self' : 'Peer', axes,
    attestedAt: who.attestedAt ?? new Date().toISOString(), fromExecution: who.fromExecution, samples: asserted.reduce((n, c) => n + c.samples, 0),
    kinds: asserted.map((c) => c.kind), confirmers: { human: asserted.reduce((n, c) => n + c.humanSamples, 0), agent: asserted.reduce((n, c) => n + c.agentSamples, 0) },
  };
}

/** The registry snapshot per judge, from every attestation about it, under one policy. */
export function reputations(attestations: readonly Attestation[], policyId: string, now?: string): Map<string, ReputationSnapshot | null> {
  const policy = reputationPolicy(policyId);
  const by = new Map<string, ReputationSnapshot | null>();
  for (const subject of new Set(attestations.map((a) => a.subject))) {
    by.set(subject, reputationOf(subject, attestations.filter((a) => a.subject === subject), policy, now));
  }
  return by;
}

export interface RankedJudge {
  readonly judge: string;
  readonly axis: DecisionAxis;
  readonly value: number | null;
  readonly contributing: number;
}

/** Judges ranked for a kind by the registry's rating on that kind's axis; unrated last; ties by contributing attestations. */
export function rankJudges(snapshots: ReadonlyMap<string, ReputationSnapshot | null>, kind: DecisionKind): RankedJudge[] {
  return [...snapshots.entries()]
    .map(([judge, s]): RankedJudge => {
      const rating = s?.axes[kind.axis];
      return { judge, axis: kind.axis, value: typeof rating === 'number' ? rating : null, contributing: s?.contributingAttestations.length ?? 0 };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.contributing - a.contributing || a.judge.localeCompare(b.judge));
}

/** The judgments no person has confirmed or refuted; an agent's confirmation counts but does not retire one. */
export function awaitingAPerson(judgments: readonly LoopJudgment[], outcomes: readonly LoopOutcome[]): LoopJudgment[] {
  const decided = new Set(outcomes.filter((o) => o.confirmedByKind === 'human').map((o) => o.judgmentId));
  return judgments.filter((j) => !decided.has(j.id));
}

/** Every (judgment, newest judgment of the same subject by another judge) pair not yet scored from that peer, once each way. */
export function crossConfirmations(judgments: readonly LoopJudgment[], outcomes: readonly LoopOutcome[]): { judgment: LoopJudgment; peer: LoopJudgment }[] {
  const newest = new Map<string, Map<string, LoopJudgment>>();
  for (const j of judgments) {
    const key = `${j.kind}|${j.subject}`;
    const per = newest.get(key) ?? new Map<string, LoopJudgment>();
    const cur = per.get(j.judge);
    if (!cur || cur.createdAt < j.createdAt) per.set(j.judge, j);
    newest.set(key, per);
  }
  const done = new Set(outcomes.filter((o) => o.confirmedFrom).map((o) => `${o.judgmentId}<${o.confirmedFrom}`));
  const pairs: { judgment: LoopJudgment; peer: LoopJudgment }[] = [];
  for (const per of newest.values()) {
    if (per.size < 2) continue;
    for (const j of per.values()) for (const peer of per.values()) {
      if (peer.judge === j.judge || done.has(`${j.id}<${peer.id}`)) continue;
      pairs.push({ judgment: j, peer });
    }
  }
  return pairs;
}

export interface AutonomyRule {
  readonly kind: string;
  readonly floor: number;
  readonly minSamples: number;
  readonly minHumanConfirmers: number;
}

export interface AutonomyDecision {
  readonly granted: boolean;
  /** `why`, not `reason`: a refusal scanner reads `reason` as a decline, and this is a decision. */
  readonly why: string;
}

/**
 * Whether a judge may act on a kind without a person: its rating on the kind's axis clears the
 * floor, the latest attestation about it rests on enough outcomes of that kind's axis, and
 * enough of those were a person's. The three checks the harness's auto-merge and Foxxi's
 * autonomy policy make, in the order they fail.
 */
export function autonomy(rule: AutonomyRule, kind: DecisionKind, snapshot: ReputationSnapshot | null, latest: LoopAttestation | undefined): AutonomyDecision {
  const rating = snapshot?.axes[kind.axis];
  if (typeof rating !== 'number') return { granted: false, why: `no attestation rates the judge on ${kind.axis}` };
  if (rating < rule.floor) return { granted: false, why: `${kind.axis} ${round(rating)} is below the floor ${rule.floor}` };
  const grounded = latest !== undefined && latest.kinds.includes(kind.kind);
  const samples = grounded ? latest.samples : 0;
  const human = grounded ? latest.confirmers.human : 0;
  if (samples < rule.minSamples) return { granted: false, why: `the latest attestation rests on ${samples} outcome(s) of ${kind.kind}, below ${rule.minSamples}` };
  if (human < rule.minHumanConfirmers) return { granted: false, why: `${human} of those were confirmed by a person, below ${rule.minHumanConfirmers}` };
  return { granted: true, why: `${kind.axis} ${round(rating)} clears ${rule.floor} over ${samples} outcome(s), ${human} confirmed by a person` };
}
