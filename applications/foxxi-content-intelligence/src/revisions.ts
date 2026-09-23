/**
 * Content that grades and revises itself.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The content-judgment loop measures a course claim by claim: how well each is supported by
 * its own passage and by evidence outside it. Until 2026-09-23 the measurement went nowhere but
 * the calibration. This is the other direction: the weakest claims on the pod, ranked, each with
 * the judges' answers and the confirmations behind them; and a revision — new text, evidence from
 * outside the passage — recorded as a `foxxi:ContentRevision` and judged again at once, so the
 * record says what the grade was, what it is now, and who wrote the words. A course that grades
 * itself, and keeps the receipts when it is revised.
 *
 * ── WHAT A GRADE IS ────────────────────────────────────────────────────────────────────────
 *
 * The evidence scale is ordered (content-judgment.ts, EVIDENCE_LEVELS), so a claim's grade is a
 * position on it: what a person confirmed if one did, else what an agent confirmed, else what
 * the judges answered — the newest judgment per judge, the lowest of them when they disagree,
 * because a claim two judges grade apart is not yet known to be well supported.
 */
import { EVIDENCE_LEVELS, type ContentJudgment, type ContentJudgmentOutcome, type EvidenceItem } from './content-judgment.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import { claimKey, judgeOf, latestJudgmentsByClaim, type ListedJudgment } from './judges.js';

export const CONTENT_REVISION_TYPE = `${FOXXI_NS}ContentRevision`;

/** The position of an evidence level on the scale, or -1 for an answer off it. */
export function evidenceRank(level: string): number {
  return (EVIDENCE_LEVELS as readonly string[]).indexOf(level);
}

export interface WeakClaim {
  readonly claimText: string;
  readonly slideId?: string;
  readonly courseIri?: string;
  /** The grade: the level and its rank on the scale. */
  readonly level: string;
  readonly rank: number;
  /** Where the grade came from: a person's confirmation, an agent's, or the judges' answers. */
  readonly gradedBy: 'human' | 'agent' | 'judges';
  readonly judgments: readonly { readonly judge: string; readonly judgmentIri: string; readonly answer: string; readonly confidence: number }[];
  readonly confirmations: readonly { readonly by: string; readonly kind: 'human' | 'agent'; readonly answer: string }[];
  /** The newest judgment of the claim, which a revision names as what it revises. */
  readonly judgmentIri: string;
}

/**
 * The evidence-level claims on the pod, weakest first: every claim's grade from the newest
 * judgments and the confirmations that scored them, ties broken by the judges' confidence
 * (least confident first) and then by claim text.
 */
export function weakestClaims(judgments: readonly ListedJudgment[], outcomes: readonly ContentJudgmentOutcome[], foxxiJudge: string, limit = 12): WeakClaim[] {
  const byClaim = latestJudgmentsByClaim(judgments.filter((l) => l.judgment.judgmentKind === 'evidence-level'), foxxiJudge);
  const outcomesByJudgment = new Map<string, ContentJudgmentOutcome[]>();
  for (const o of outcomes) {
    const list = outcomesByJudgment.get(o.judgmentIri) ?? [];
    list.push(o);
    outcomesByJudgment.set(o.judgmentIri, list);
  }
  const claims: WeakClaim[] = [];
  for (const perJudge of byClaim.values()) {
    const listed = [...perJudge.values()].sort((a, b) => b.judgment.createdAt.localeCompare(a.judgment.createdAt));
    const newest = listed[0]!;
    const judgmentsOut = listed.map((l) => ({ judge: judgeOf(l.judgment, foxxiJudge), judgmentIri: l.judgmentIri, answer: l.judgment.answer, confidence: l.judgment.confidence }));
    const confirmations = listed.flatMap((l) => (outcomesByJudgment.get(l.judgmentIri) ?? []).map((o) => ({ by: o.confirmedBy, kind: (o.confirmedByKind ?? 'human') as 'human' | 'agent', answer: o.confirmedAnswer })));
    const human = confirmations.filter((c) => c.kind === 'human').sort((a, b) => evidenceRank(a.answer) - evidenceRank(b.answer))[0];
    const agent = confirmations.filter((c) => c.kind === 'agent').sort((a, b) => evidenceRank(a.answer) - evidenceRank(b.answer))[0];
    const lowestJudged = judgmentsOut.slice().sort((a, b) => evidenceRank(a.answer) - evidenceRank(b.answer))[0]!;
    const graded = human ? { level: human.answer, gradedBy: 'human' as const } : agent ? { level: agent.answer, gradedBy: 'agent' as const } : { level: lowestJudged.answer, gradedBy: 'judges' as const };
    // The slide and the course are the claim's, whichever judgment of it named them.
    const slideId = listed.find((l) => l.judgment.slideId)?.judgment.slideId;
    const courseIri = listed.find((l) => l.judgment.courseIri)?.judgment.courseIri;
    claims.push({
      claimText: newest.judgment.claimText,
      ...(slideId ? { slideId } : {}),
      ...(courseIri ? { courseIri } : {}),
      level: graded.level,
      rank: evidenceRank(graded.level),
      gradedBy: graded.gradedBy,
      judgments: judgmentsOut,
      confirmations,
      judgmentIri: newest.judgmentIri,
    });
  }
  return claims
    .sort((a, b) => a.rank - b.rank || Math.min(...a.judgments.map((j) => j.confidence)) - Math.min(...b.judgments.map((j) => j.confidence)) || a.claimText.localeCompare(b.claimText))
    .slice(0, Math.max(1, limit));
}

export interface ContentRevision {
  readonly kind: 'content-revision';
  readonly type: string;
  readonly id: string;
  readonly createdAt: string;
  /** What is revised: the claim as it stood, the judgment that graded it, and that grade. */
  readonly original: { readonly claimText: string; readonly judgmentIri?: string; readonly level?: string };
  /** The words now, and the evidence from outside the passage that supports them. */
  readonly revised: { readonly claimText: string; readonly context?: string; readonly evidence: readonly EvidenceItem[] };
  readonly revisedBy: string;
  readonly revisedByKind: 'human' | 'agent';
  readonly slideId?: string;
  readonly courseIri?: string;
  readonly note?: string;
  /** Filled once the revised claim has been judged: the new judgment, and the grade before and after. */
  readonly judged?: { readonly judgmentIri: string; readonly level: string; readonly from: string | null; readonly improved: boolean | null };
}

export interface RevisionInput {
  readonly originalClaimText: string;
  readonly originalJudgmentIri?: string;
  readonly originalLevel?: string;
  readonly revisedClaimText: string;
  readonly context?: string;
  readonly evidence?: readonly EvidenceItem[];
  readonly revisedBy: string;
  readonly revisedByKind?: 'human' | 'agent';
  readonly slideId?: string;
  readonly courseIri?: string;
  readonly note?: string;
}

const newId = (): string => Math.random().toString(36).slice(2, 10);

/** The revision record, before the revised claim is judged. */
export function contentRevision(input: RevisionInput, now: Date = new Date()): ContentRevision {
  if (input.originalClaimText.trim().length < 8 || input.revisedClaimText.trim().length < 8) throw new Error('the original and the revised claim must each be at least 8 characters');
  if (claimKey({ judgmentKind: 'evidence-level', claimText: input.originalClaimText }) === claimKey({ judgmentKind: 'evidence-level', claimText: input.revisedClaimText }) && (input.evidence ?? []).length === 0) {
    throw new Error('a revision changes the words or adds evidence from outside the passage; this does neither');
  }
  return {
    kind: 'content-revision',
    type: CONTENT_REVISION_TYPE,
    id: newId(),
    createdAt: now.toISOString(),
    original: { claimText: input.originalClaimText.trim(), ...(input.originalJudgmentIri ? { judgmentIri: input.originalJudgmentIri } : {}), ...(input.originalLevel ? { level: input.originalLevel } : {}) },
    revised: { claimText: input.revisedClaimText.trim(), ...(input.context ? { context: input.context } : {}), evidence: [...(input.evidence ?? [])] },
    revisedBy: input.revisedBy,
    revisedByKind: input.revisedByKind ?? 'human',
    ...(input.slideId ? { slideId: input.slideId } : {}),
    ...(input.courseIri ? { courseIri: input.courseIri } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

/** The revision with its new grade filled in. */
export function revisionJudged(revision: ContentRevision, judgment: Pick<ContentJudgment, 'answer'>, judgmentIri: string): ContentRevision {
  const from = revision.original.level ?? null;
  const improved = from === null ? null : evidenceRank(judgment.answer) > evidenceRank(from);
  return { ...revision, judged: { judgmentIri, level: judgment.answer, from, improved } };
}

export function isContentRevision(v: unknown): v is ContentRevision {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o['kind'] === 'content-revision' && o['type'] === CONTENT_REVISION_TYPE && typeof o['revisedBy'] === 'string' && !!o['original'] && !!o['revised'];
}
