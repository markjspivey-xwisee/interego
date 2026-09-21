/**
 * Outcomes: what actually happened after a judgment, scored in code. An Outcome is Asserted
 * and supersedes the Hypothetical judgment it scores; the calibration view is computed over
 * these pairs. No model call — the ground truth is observed, not judged.
 */

import { graphIriFor, newId, round, type JudgmentBase, type JudgmentKind, type RepoRef } from './common.js';
import type { NavigationJudgment } from './navigate.js';
import type { TestSelectionJudgment } from './select-tests.js';
import type { FailureTriageJudgment } from './triage.js';
import type { ReviewVerdictJudgment } from './review-gate.js';

export type AnyJudgment = NavigationJudgment | TestSelectionJudgment | FailureTriageJudgment | ReviewVerdictJudgment;

export type OutcomeSource = 'live' | 'backtest';

export interface OutcomeInput {
  readonly judgmentIri: string;
  /** Where the ground truth came from: a real task (live) or a history replay (backtest). Default live. */
  readonly source?: OutcomeSource;
  readonly filesChanged?: readonly string[];
  readonly testsRun?: readonly string[];
  readonly testsFailed?: readonly string[];
  readonly humanDecision?: 'approved' | 'changes-requested' | 'blocked';
  readonly confirmedClasses?: Readonly<Record<string, string>>;
}

export interface OutcomeRecord extends JudgmentBase {
  readonly kind: 'outcome';
  readonly judgmentIri: string;
  readonly judgmentKind: JudgmentKind;
  /** The scored judgment's own confidence, kept here so calibration can bucket by it without a lookup. */
  readonly priorConfidence: number;
  /** live or backtest; calibration prefers live outcomes and falls back to all of them. */
  readonly source: OutcomeSource;
  readonly hitAt1: boolean | null;
  readonly hitAt3: boolean | null;
  readonly brier: number | null;
  readonly missed: readonly string[];
  readonly agreement: string | null;
  readonly observed: OutcomeInput;
  readonly summary: string;
  /**
   * The task the scored judgment was made for (navigation and test selection). With the
   * observed files it makes the outcome a precedent on its own, wherever it is read from.
   */
  readonly task?: string;
}

export function recordOutcome(judgment: AnyJudgment, input: OutcomeInput, repository?: RepoRef): OutcomeRecord {
  const base = {
    kind: 'outcome' as const,
    id: newId(),
    createdAt: new Date().toISOString(),
    model: judgment.model,
    confidence: 1,
    repository: repository ?? judgment.repository,
    usage: { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 },
    judgmentIri: input.judgmentIri,
    judgmentKind: judgment.kind,
    priorConfidence: judgment.confidence,
    source: input.source ?? 'live',
    observed: input,
    ...(taskOf(judgment) ? { task: taskOf(judgment) } : {}),
  };
  const graphIri = graphIriFor('outcome', base.id);

  if (judgment.kind === 'navigation') {
    const changed = new Set((input.filesChanged ?? []).map(norm));
    const ranked = judgment.files.map((c) => c.path);
    const hitAt1 = changed.size > 0 ? changed.has(norm(ranked[0] ?? '')) : null;
    const hitAt3 = changed.size > 0 ? ranked.slice(0, 3).some((p) => changed.has(norm(p))) : null;
    const brier = changed.size > 0 && judgment.files.length > 0
      ? round(judgment.files.reduce((s, c) => s + (c.probability - (changed.has(norm(c.path)) ? 1 : 0)) ** 2, 0) / judgment.files.length, 4)
      : null;
    const missed = [...changed].filter((p) => !ranked.map(norm).includes(p));
    return { ...base, graphIri, hitAt1, hitAt3, brier, missed, agreement: null,
      summary: changed.size === 0 ? 'no files changed were reported' : `top candidate ${hitAt1 ? 'was' : 'was not'} among the changed files; ${missed.length} changed file(s) were not in the candidate list` };
  }
  if (judgment.kind === 'test-selection') {
    const selected = new Set(judgment.tests.map((t) => norm(t.path)));
    const failed = (input.testsFailed ?? []).map(norm);
    const missed = failed.filter((t) => !selected.has(t));
    const hitAt1 = failed.length > 0 ? missed.length === 0 : null;
    return { ...base, graphIri, hitAt1, hitAt3: hitAt1, brier: null, missed, agreement: null,
      summary: failed.length === 0 ? 'no failing tests were reported' : `${failed.length - missed.length} of ${failed.length} failing tests were in the selection` };
  }
  if (judgment.kind === 'review-verdict') {
    const decision = input.humanDecision ?? null;
    const expected = decision === 'approved' ? 'auto-ok' : decision === 'blocked' ? 'block' : decision ? 'needs-human-review' : null;
    const agreement = expected === null ? null : expected === judgment.verdict ? 'agree' : judgment.verdict === 'needs-human-review' ? 'conservative' : 'disagree';
    return { ...base, graphIri, hitAt1: agreement === null ? null : agreement === 'agree', hitAt3: null, brier: null, missed: [], agreement,
      summary: decision ? `verdict ${judgment.verdict} versus human decision ${decision}: ${agreement}` : 'no human decision was reported' };
  }
  const confirmed = input.confirmedClasses ?? {};
  const pairs = judgment.failures.filter((f) => confirmed[f.id] !== undefined);
  const agree = pairs.filter((f) => confirmed[f.id] === f.causeClass).length;
  const brier = pairs.length > 0
    ? round(pairs.reduce((s, f) => s + Object.entries(f.probabilities).reduce((ss, [cls, p]) => ss + (p - (cls === confirmed[f.id] ? 1 : 0)) ** 2, 0), 0) / pairs.length, 4)
    : null;
  return { ...base, graphIri, hitAt1: pairs.length > 0 ? agree === pairs.length : null, hitAt3: null, brier,
    missed: pairs.filter((f) => confirmed[f.id] !== f.causeClass).map((f) => f.id), agreement: pairs.length > 0 ? `${agree}/${pairs.length}` : null,
    summary: pairs.length === 0 ? 'no confirmed classes were reported' : `${agree} of ${pairs.length} classifications confirmed` };
}

function taskOf(j: AnyJudgment): string | undefined {
  return j.kind === 'navigation' ? j.task : j.kind === 'test-selection' ? j.task : undefined;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
