/**
 * A network of judges: every content judgment names the agent that made it, any enrolled agent
 * can record its own, judges confirm each other's judgments of the same claim, the calibration
 * and the attestation are per judge, and the registry says who has earned what on which kind
 * of question. Pure; the bridge reads the pod, calls these, and publishes.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Until 2026-09-23 one judge (the bridge's System One model) earned one reputation, confirmed
 * by whoever ran the loop. Trust in Interego is meant to be measured, not assumed, and measured
 * per kind of question: a judge that is right about evidence and wrong about work regimes should
 * be believed about the one and not the other, and the vertical that needs a judgment should be
 * able to ask the registry who to believe. So a judgment carries `judge`, an outcome carries the
 * judge it scores and the peer judgment it was confirmed from, and the pieces below turn a pod's
 * judgments into per-judge calibrations, Self or Peer attestations, a ranking per kind, and the
 * disagreements between judges that a person should look at first.
 *
 * ── WHAT A PEER CONFIRMATION IS ────────────────────────────────────────────────────────────
 *
 * When two judges judged the same claim, each one's answer is recorded as an agent confirmation
 * of the other's judgment, naming the peer judgment it came from. That is agreement between
 * independent readings, counted apart from a person's word (confirmedByKind: 'agent'), and a
 * person's confirmation is still what retires a judgment from the queue. Where two judges
 * disagree, the queue says so, because that is where a person's answer teaches the most.
 */
import { type ContentJudgment, type ContentJudgmentCalibration, type ContentJudgmentOutcome, contentJudgmentCalibration } from './content-judgment.js';
import { type ContentJudgmentAttestation, contentJudgmentAttestation } from './content-reputation.js';
import type { ReputationSnapshot } from '@interego/registry';

/** A judgment as the pod lists it: the entity IRI outcomes name, and the payload. */
export interface ListedJudgment {
  readonly judgmentIri: string;
  readonly judgment: ContentJudgment;
}

/** The judge a judgment names, or the bridge's own judge for judgments from before the field. */
export function judgeOf(j: Pick<ContentJudgment, 'judge'>, foxxiJudge: string): string {
  return j.judge ?? foxxiJudge;
}

/** Outcomes grouped by the judge they score, in first-seen order. */
export function outcomesByJudge(outcomes: readonly ContentJudgmentOutcome[], foxxiJudge: string): Map<string, ContentJudgmentOutcome[]> {
  const by = new Map<string, ContentJudgmentOutcome[]>();
  for (const o of outcomes) {
    const judge = o.judge ?? foxxiJudge;
    const list = by.get(judge) ?? [];
    list.push(o);
    by.set(judge, list);
  }
  return by;
}

/** Per judge: the calibration over that judge's outcomes, and the attestation it earns — Self when the judge is the attestor, Peer otherwise. */
export function judgeAttestations(outcomes: readonly ContentJudgmentOutcome[], attestor: string, opts: { readonly fromExecution: string; readonly attestedAt?: string; readonly minSamples?: number; readonly now?: Date }): { judge: string; calibration: ContentJudgmentCalibration; attestation: ContentJudgmentAttestation | undefined }[] {
  const out: { judge: string; calibration: ContentJudgmentCalibration; attestation: ContentJudgmentAttestation | undefined }[] = [];
  for (const [judge, list] of outcomesByJudge(outcomes, attestor)) {
    const calibration = contentJudgmentCalibration(list, opts.minSamples, opts.now);
    const attestation = contentJudgmentAttestation(calibration, attestor, { fromExecution: opts.fromExecution, ...(opts.attestedAt ? { attestedAt: opts.attestedAt } : {}), subject: judge });
    out.push({ judge, calibration, attestation });
  }
  return out;
}

/** The registry axis a question kind is scored on: accuracy for evidence, competence for regimes. */
export function axisForKind(kind: string): 'accuracy' | 'competence' {
  return kind === 'work-regime' ? 'competence' : 'accuracy';
}

export interface RankedJudge {
  readonly subject: string;
  readonly axis: 'accuracy' | 'competence';
  /** The axis rating, or null when no attestation about this judge rates it. */
  readonly value: number | null;
  readonly contributing: number;
  readonly overall: number | null;
}

/** Judges ranked for a kind of question by the registry's rating on that kind's axis; unrated judges last, ties by how many attestations contributed. */
export function bestJudges(snapshots: readonly { subject: string; snapshot: ReputationSnapshot | null }[], kind: string): RankedJudge[] {
  const axis = axisForKind(kind);
  const ranked: RankedJudge[] = snapshots.map(({ subject, snapshot }) => {
    const value = snapshot?.axes?.[axis];
    return {
      subject,
      axis,
      value: typeof value === 'number' ? value : null,
      contributing: snapshot?.contributingAttestations?.length ?? 0,
      overall: typeof snapshot?.score === 'number' ? snapshot.score : null,
    };
  });
  return ranked.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.contributing - a.contributing || a.subject.localeCompare(b.subject));
}

/** The key two judgments must share to be about the same claim. */
export function claimKey(j: Pick<ContentJudgment, 'judgmentKind' | 'claimText'>): string {
  return `${j.judgmentKind}|${j.claimText.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/** The newest judgment of each claim by each judge. */
export function latestJudgmentsByClaim(judgments: readonly ListedJudgment[], foxxiJudge: string): Map<string, Map<string, ListedJudgment>> {
  const by = new Map<string, Map<string, ListedJudgment>>();
  for (const l of judgments) {
    const key = claimKey(l.judgment);
    const judge = judgeOf(l.judgment, foxxiJudge);
    const perJudge = by.get(key) ?? new Map<string, ListedJudgment>();
    const current = perJudge.get(judge);
    if (!current || current.judgment.createdAt < l.judgment.createdAt) perJudge.set(judge, l);
    by.set(key, perJudge);
  }
  return by;
}

export interface Disagreement {
  readonly judge: string;
  readonly answer: string;
  readonly judgmentIri: string;
}

/** The other judges whose newest judgment of the same claim answers differently. */
export function disagreementsFor(l: ListedJudgment, byClaim: ReadonlyMap<string, ReadonlyMap<string, ListedJudgment>>, foxxiJudge: string): Disagreement[] {
  const mine = judgeOf(l.judgment, foxxiJudge);
  const peers = byClaim.get(claimKey(l.judgment));
  if (!peers) return [];
  const out: Disagreement[] = [];
  for (const [judge, peer] of peers) {
    if (judge === mine) continue;
    if (peer.judgment.answer !== l.judgment.answer) out.push({ judge, answer: peer.judgment.answer, judgmentIri: peer.judgmentIri });
  }
  return out;
}

export interface CrossConfirmPair {
  /** The judgment to score. */
  readonly judgmentIri: string;
  readonly judgment: ContentJudgment;
  readonly judge: string;
  /** The peer judgment whose answer scores it. */
  readonly peerJudgmentIri: string;
  readonly peerJudge: string;
  readonly peerAnswer: string;
}

/**
 * Every (judgment, newest peer judgment of the same claim by another judge) pair that has no
 * outcome yet naming that peer judgment as its source. Symmetric: each pair of judges yields two
 * outcomes, one per judgment. A judge never confirms itself, and a claim with one judge yields none.
 */
export function crossConfirmPairs(judgments: readonly ListedJudgment[], outcomes: readonly ContentJudgmentOutcome[], foxxiJudge: string): CrossConfirmPair[] {
  const byClaim = latestJudgmentsByClaim(judgments, foxxiJudge);
  const done = new Set(outcomes.filter((o) => o.confirmedFrom).map((o) => `${o.judgmentIri}<${o.confirmedFrom}`));
  const pairs: CrossConfirmPair[] = [];
  for (const perJudge of byClaim.values()) {
    if (perJudge.size < 2) continue;
    for (const [judge, l] of perJudge) {
      for (const [peerJudge, peer] of perJudge) {
        if (peerJudge === judge) continue;
        if (done.has(`${l.judgmentIri}<${peer.judgmentIri}`)) continue;
        pairs.push({ judgmentIri: l.judgmentIri, judgment: l.judgment, judge, peerJudgmentIri: peer.judgmentIri, peerJudge, peerAnswer: peer.judgment.answer });
      }
    }
  }
  return pairs;
}
