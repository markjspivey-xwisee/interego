/**
 * Review gating: may this diff proceed without a human? Deterministic checks first (secrets,
 * sensitive paths, deleted tests, size), then Jev on the hazards code cannot see (an
 * authorization change, a loosened check, behaviour the description does not mention). The
 * verdict is derived by a published policy, and "auto-ok" means only that the gate does not
 * demand a person — merging stays the workflow's decision.
 */

import type { ChoiceAnswer, JevClient, NoulAnswer, Question, ScoreAnswer } from '../jev-client.js';
import { deletedTestsInDiff, isSensitivePath, isTestPath, pathsInDiff, type RepoInventory } from '../repo.js';
import { addUsage, emptyUsage, graphIriFor, newId, round, type JudgmentBase, type RepoRef } from './common.js';

export interface ReviewGateInput {
  readonly diff: string;
  readonly title?: string;
  readonly description?: string;
  readonly changedFiles?: readonly string[];
}

export type Verdict = 'auto-ok' | 'needs-human-review' | 'block';

export interface Hazard {
  readonly name: string;
  readonly description: string;
  readonly probability: number;
  readonly threshold: number;
  readonly fired: boolean;
}

export interface ReviewVerdictJudgment extends JudgmentBase {
  readonly kind: 'review-verdict';
  readonly verdict: Verdict;
  readonly checks: readonly string[];
  readonly hazards: readonly Hazard[];
  /** 0 mismatch, 1 partial, 2 matches; null when no title or description was given. */
  readonly descriptionMatch: number | null;
  readonly risk: { readonly choice: string; readonly probabilities: Readonly<Record<string, number>>; readonly confidence: number } | null;
  readonly changedFiles: readonly string[];
  readonly reasons: readonly string[];
  readonly policy: string;
  readonly title?: string;
}

export const REVIEW_POLICY = {
  hazardThreshold: 0.6,
  maxChangedLines: 1500,
  /**
   * Probability mass the risk rating may put on "high" before a person is required. Read from
   * the distribution, not the collapsed confidence: on a 40-commit replay the earlier rule
   * "confidence below 0.5" sent 16 low-or-medium diffs to a human because the model was torn
   * between low and medium, which is not the uncertainty that matters here.
   */
  highRiskMass: 0.25,
  maxDiffChars: 60_000,
  text:
    'block if a secret appears in the diff; otherwise needs-human-review if a deterministic check fired '
    + '(sensitive path, deleted test, oversized change), or any hazard probability is at or above 0.6, or the '
    + 'description matches the diff at less than the partial level, or the probability that the risk is high is '
    + 'at or above 0.25; otherwise auto-ok.',
} as const;

/** Credential formats that are secrets wherever they appear. */
const STRONG_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];
/** A generic assignment of a long opaque value to a secret-named field; skipped inside test files,
 *  where it blocked a fixture token on the 40-commit replay. */
const GENERIC_SECRET_PATTERN = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/i;

/** True when an added line of the diff carries a secret-like value. */
export function secretInDiff(diff: string): boolean {
  for (const block of diff.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    const path = header?.[2] ?? '';
    const added = block.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    if (STRONG_SECRET_PATTERNS.some((re) => re.test(added))) return true;
    if (!isTestPath(path) && GENERIC_SECRET_PATTERN.test(added)) return true;
  }
  return false;
}

const HAZARDS: ReadonlyArray<{ name: string; description: string; instructions: string; yes: string; no: string }> = [
  {
    name: 'authorization-change',
    description: 'changes who may do something or how identity, signatures, tokens or delegation are verified',
    instructions: 'Does the diff change who is allowed to do something, or how an identity, signature, token, key or delegation is verified?',
    yes: 'An added or removed line changes an access decision or a verification step.',
    no: 'No access decision or verification step changes.',
  },
  {
    name: 'validation-weakened',
    description: 'removes or loosens a validation, precondition or error check',
    instructions: 'Does the diff remove or loosen a validation, precondition, input check, or error handling?',
    yes: 'A check that used to reject or fail is removed, widened, or made to pass.',
    no: 'Checks are unchanged or strengthened.',
  },
  {
    name: 'assertions-removed',
    description: 'deletes or weakens test assertions, skips tests, or widens an allowlist',
    instructions: 'Does the diff delete or weaken test assertions, skip or disable tests, or widen an allowlist or exception list?',
    yes: 'An assertion, test, or restriction becomes weaker or disappears.',
    no: 'Assertions and restrictions are unchanged or stronger.',
  },
  {
    name: 'new-external-effect',
    description: 'adds a network call, file write, or persistence that the description does not mention',
    instructions: 'Does the diff add a network call, file write, process execution, or persistence of data that `title` and `description` do not mention?',
    yes: 'A new outward effect appears that the description is silent about.',
    no: 'Any outward effect is already described or none is added.',
  },
  {
    name: 'behaviour-beyond-description',
    description: 'changes behaviour the title and description do not mention',
    instructions: 'Does the diff change behaviour that `title` and `description` do not mention?',
    yes: 'Some changed behaviour is not covered by the description.',
    no: 'Everything the diff changes is covered by the description.',
  },
];

export async function reviewGate(jev: JevClient, repo: RepoInventory | RepoRef | null, input: ReviewGateInput): Promise<ReviewVerdictJudgment> {
  const changedFiles = input.changedFiles && input.changedFiles.length > 0 ? [...input.changedFiles] : pathsInDiff(input.diff);
  const repository: RepoRef = repo ? { name: repo.name, root: repo.root, commit: repo.commit } : { name: 'unknown', root: '', commit: null };
  const checks: string[] = [];
  const reasons: string[] = [];

  const secret = secretInDiff(input.diff);
  if (secret) checks.push('secret-in-diff');
  const sensitive = changedFiles.filter(isSensitivePath);
  if (sensitive.length > 0) checks.push(`sensitive-path:${sensitive.slice(0, 5).join(',')}`);
  const deleted = deletedTestsInDiff(input.diff);
  if (deleted.length > 0) checks.push(`deleted-test:${deleted.slice(0, 5).join(',')}`);
  const changedLines = input.diff.split('\n').filter((l) => /^[+-](?![+-]{2})/.test(l)).length;
  if (changedLines > REVIEW_POLICY.maxChangedLines) checks.push(`oversized:${changedLines}-lines`);

  let usage = emptyUsage();
  let model = jev.model;
  const hazards: Hazard[] = [];
  let descriptionMatch: number | null = null;
  let risk: ReviewVerdictJudgment['risk'] = null;
  let confidence = 1;

  if (!secret) {
    const hasDescription = Boolean(input.title || input.description);
    const questions: Record<string, Question> = {};
    for (const h of HAZARDS) {
      if (!hasDescription && (h.name === 'new-external-effect' || h.name === 'behaviour-beyond-description')) continue;
      questions[h.name] = { type: 'noul', instructions: h.instructions, criteria: { true: h.yes, false: h.no } };
    }
    if (hasDescription) {
      questions['description_match'] = {
        type: 'score',
        instructions: 'How well do `title` and `description` describe what the diff actually does?',
        criteria: [
          'The description does not match what the diff does.',
          'The description covers part of the change but not all of it.',
          'The description matches the change.',
        ],
      };
    }
    questions['risk'] = {
      type: 'choice',
      instructions: 'How risky is merging this diff without a human reading it, judging from what it touches and how much of it a reader could verify at a glance?',
      criteria: {
        low: 'A reader can verify correctness at a glance and it touches no security, data-integrity, money or infrastructure surface.',
        medium: 'It needs a careful read but touches no security, data-integrity, money or infrastructure surface.',
        high: 'It touches security, data integrity, money or infrastructure, or is too large or subtle for a reader to verify.',
      },
    };
    const state = {
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
      changed_files: changedFiles.slice(0, 60),
      diff: truncateDiff(input.diff, REVIEW_POLICY.maxDiffChars),
    };
    const r = await jev.systemOne(state, questions);
    usage = addUsage(usage, r);
    model = r.model;
    for (const h of HAZARDS) {
      const a = r.answers[h.name] as NoulAnswer | undefined;
      if (!a) continue;
      const p = round(a.noul);
      hazards.push({ name: h.name, description: h.description, probability: p, threshold: REVIEW_POLICY.hazardThreshold, fired: p >= REVIEW_POLICY.hazardThreshold });
    }
    const dm = r.answers['description_match'] as ScoreAnswer | undefined;
    if (dm) descriptionMatch = round(dm.score, 2);
    const rk = r.answers['risk'] as ChoiceAnswer;
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(rk.probabilities)) probabilities[k] = round(v);
    risk = { choice: rk.choice, probabilities, confidence: round(rk.confidence) };
    confidence = round(rk.confidence);
  }

  let verdict: Verdict;
  if (secret) {
    verdict = 'block';
    reasons.push('a secret-like value appears in the diff');
  } else {
    if (checks.length > 0) reasons.push(`deterministic checks fired: ${checks.join('; ')}`);
    for (const h of hazards) if (h.fired) reasons.push(`${h.name} at ${h.probability}`);
    if (descriptionMatch !== null && descriptionMatch < 1) reasons.push(`description matches the diff at ${descriptionMatch} (below partial)`);
    const highMass = risk ? (risk.probabilities['high'] ?? 0) : 0;
    if (risk && highMass >= REVIEW_POLICY.highRiskMass) reasons.push(`probability of high risk ${highMass} is at or above ${REVIEW_POLICY.highRiskMass}`);
    verdict = reasons.length > 0 ? 'needs-human-review' : 'auto-ok';
    if (verdict === 'auto-ok') reasons.push('no check fired, no hazard reached threshold, description matches, risk not high');
  }

  const id = newId();
  return {
    kind: 'review-verdict',
    id,
    graphIri: graphIriFor('review-verdict', id),
    createdAt: new Date().toISOString(),
    model,
    confidence,
    repository,
    usage,
    verdict,
    checks,
    hazards,
    descriptionMatch,
    risk,
    changedFiles,
    reasons,
    policy: REVIEW_POLICY.text,
    ...(input.title ? { title: input.title } : {}),
  };
}

/** Keep the diff under budget, sensitive files' hunks first so they are never the part cut. */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  const blocks = diff.split(/^(?=diff --git )/m);
  const ordered = [...blocks].sort((a, b) => Number(isSensitiveBlock(b)) - Number(isSensitiveBlock(a)));
  let out = '';
  for (const block of ordered) {
    if (out.length + block.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 400) out += `${block.slice(0, room - 40)}\n[... truncated ...]\n`;
      break;
    }
    out += block;
  }
  return out;
}

function isSensitiveBlock(block: string): boolean {
  const m = /^diff --git a\/(.+?) b\//.exec(block);
  return m?.[1] ? isSensitivePath(m[1]) : false;
}
