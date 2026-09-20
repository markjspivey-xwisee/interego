/**
 * Failure triage: a test-runner log is parsed in code into distinct failures, and Jev
 * classifies each one's cause. The class-to-action table is code, so the same class always
 * warrants the same next step and a reader can re-derive it.
 */

import type { ChoiceAnswer, JevClient, Question } from '../jev-client.js';
import type { RepoInventory } from '../repo.js';
import { addUsage, emptyUsage, graphIriFor, mean, newId, round, type JudgmentBase, type RepoRef } from './common.js';

export interface Failure {
  readonly id: string;
  readonly file?: string;
  readonly name?: string;
  readonly excerpt: string;
}

export type CauseClass = 'code-defect' | 'test-defect' | 'environment' | 'flaky' | 'missing-dependency-or-fixture' | 'unclear';

export const CAUSE_CLASSES: Readonly<Record<CauseClass, string>> = {
  'code-defect': 'The excerpt shows an assertion or runtime error caused by the product code\'s own logic.',
  'test-defect': 'The failure is in the test itself: a wrong expectation, fixture, setup or teardown, or a test that asserts nothing meaningful.',
  'environment': 'A service, port, network, credential, file or permission the test needs is unavailable in this run: connection refused, unreachable host, ENOENT, a missing environment variable.',
  'flaky': 'Timing, ordering, a timeout, or resource contention that would likely pass on retry.',
  'missing-dependency-or-fixture': 'A module, package, fixture file or build artifact is missing or stale: cannot find module, dist not built, fixture not found.',
  'unclear': 'The excerpt does not show enough to tell.',
};

export const CAUSE_ACTIONS: Readonly<Record<CauseClass, string>> = {
  'code-defect': 'open-remediation',
  'test-defect': 'fix-test',
  'environment': 'fix-environment-then-retry',
  'flaky': 'retry',
  'missing-dependency-or-fixture': 'install-or-build-then-retry',
  'unclear': 'human',
};

export interface TriagedFailure extends Failure {
  readonly causeClass: CauseClass;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly action: string;
}

export interface TriageGroup {
  readonly causeClass: CauseClass;
  readonly count: number;
  readonly action: string;
  readonly failures: readonly string[];
}

export interface FailureTriageJudgment extends JudgmentBase {
  readonly kind: 'failure-triage';
  readonly failures: readonly TriagedFailure[];
  readonly groups: readonly TriageGroup[];
  readonly parsedFailures: number;
  readonly changedFiles: readonly string[];
}

export interface TriageInput {
  readonly log: string;
  readonly changedFiles?: readonly string[];
}

const FAIL_HEADER = /^\s*FAIL\s+(.*)$/;
const TREE_HEADER = /^\s*(?:×|✖|✗)\s+(.*)$/;
const FILE_RE = /([\w@./+-]+\.(?:test|spec|check)\.[cm]?[jt]sx?)/;
const SEPARATOR = /^\s*[⎯─-]{5,}/;
const GENERIC_ERROR = /(AssertionError|TypeError|ReferenceError|RangeError|SyntaxError|Error:|error TS\d+|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENOENT|EACCES|timed out|Timeout|Cannot find module|Unhandled)/;
/** Terminal colour sequences (ESC [ ... m), built from the char code so no raw control byte sits in the source. */
const ANSI_ESCAPES = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const MAX_FAILURES = 60;
const EXCERPT_LINES = 40;
const EXCERPT_CHARS = 1400;
/** vitest's closing summary line, e.g. " Test Files  398 passed | 6 skipped (404)". */
const SUMMARY_FILES = /^\s*Test Files\s+(.*)$/;
/** A stack frame ("    at fn (file:line)") is never a failure header, however the runner names it. */
const STACK_FRAME = /^\s+at\s+\S/;

/** True when the runner's own summary is present and names no failed file: the run was green. */
export function summarySaysGreen(lines: readonly string[]): boolean {
  const summary = lines.filter((l) => SUMMARY_FILES.test(l)).pop();
  return summary !== undefined && !/\bfailed\b/.test(summary);
}

/** Parse vitest-style output (also tolerable for jest and generic runners) into failures. */
export function parseTestLog(log: string): Failure[] {
  const lines = log.replace(/\r\n/g, '\n').replace(ANSI_ESCAPES, '').split('\n');
  // The runner's verdict outranks every heuristic below: a green run has nothing to triage, however
  // much "Error:" noise its tests wrote to stderr on the way. Without this, a passing CI run was
  // triaged into four failures that never happened.
  if (summarySaysGreen(lines)) return [];
  // The "Failed Tests" section (FAIL headers) carries file, name and the error; the tree's
  // × lines only repeat the names. Use the tree only when no FAIL section exists.
  let headers: number[] = [];
  lines.forEach((line, i) => { if (FAIL_HEADER.test(line)) headers.push(i); });
  if (headers.length === 0) lines.forEach((line, i) => { if (TREE_HEADER.test(line)) headers.push(i); });
  const failures: Failure[] = [];
  const seen = new Set<string>();
  const push = (header: string, body: string[]): void => {
    const file = FILE_RE.exec(header)?.[1];
    const afterFile = file ? header.slice(header.indexOf(file) + file.length) : header;
    const name = afterFile.split('>').map((s) => s.trim()).filter(Boolean).pop()?.replace(/\s+\d+ms$/, '');
    const key = `${file ?? ''}|${name ?? header.trim()}`;
    if (!header.trim() || seen.has(key)) return;
    seen.add(key);
    const excerpt = [header, ...body].join('\n').slice(0, EXCERPT_CHARS);
    failures.push({
      id: `X${String(failures.length).padStart(2, '0')}`,
      ...(file ? { file } : {}),
      ...(name && name !== file ? { name } : {}),
      excerpt,
    });
  };
  for (let h = 0; h < headers.length && failures.length < MAX_FAILURES; h += 1) {
    const start = headers[h]!;
    const end = headers[h + 1] ?? lines.length;
    const body: string[] = [];
    for (let i = start + 1; i < end && body.length < EXCERPT_LINES; i += 1) {
      const line = lines[i] ?? '';
      if (SEPARATOR.test(line) && body.length > 0) break;
      if (line.trim()) body.push(line);
    }
    push(lines[start] ?? '', body);
  }
  if (failures.length === 0) {
    lines.forEach((line, i) => {
      if (failures.length >= 30 || STACK_FRAME.test(line) || !GENERIC_ERROR.test(line)) return;
      push(line, lines.slice(i + 1, i + 4).filter((l) => l.trim()));
    });
  }
  return failures;
}

export async function triage(jev: JevClient, repo: RepoInventory | RepoRef | null, input: TriageInput): Promise<FailureTriageJudgment> {
  const parsed = parseTestLog(input.log);
  const changedFiles = [...(input.changedFiles ?? [])];
  const repository: RepoRef = repo ? { name: repo.name, root: repo.root, commit: repo.commit } : { name: 'unknown', root: '', commit: null };
  let usage = emptyUsage();
  let model = jev.model;
  const triaged: TriagedFailure[] = [];
  const classes = Object.keys(CAUSE_CLASSES) as CauseClass[];
  for (let start = 0; start < parsed.length; start += 20) {
    const batch = parsed.slice(start, start + 20);
    const questions: Record<string, Question> = {};
    batch.forEach((f, i) => {
      questions[`class_${i}`] = {
        type: 'choice',
        instructions: `What is the cause of the failure in \`failures[${i}]\`, judging from its excerpt${changedFiles.length > 0 ? ' and the files that changed' : ''}?`,
        criteria: { ...CAUSE_CLASSES },
      };
    });
    const state = {
      ...(changedFiles.length > 0 ? { changed_files: changedFiles.slice(0, 40) } : {}),
      failures: batch.map((f) => ({ id: f.id, ...(f.file ? { file: f.file } : {}), ...(f.name ? { name: f.name } : {}), excerpt: f.excerpt })),
    };
    const r = await jev.systemOne(state, questions);
    usage = addUsage(usage, r);
    model = r.model;
    batch.forEach((f, i) => {
      const a = r.answers[`class_${i}`] as ChoiceAnswer;
      const causeClass = (classes.includes(a.choice as CauseClass) ? a.choice : 'unclear') as CauseClass;
      const probabilities: Record<string, number> = {};
      for (const [k, v] of Object.entries(a.probabilities)) probabilities[k] = round(v);
      triaged.push({ ...f, causeClass, probabilities, confidence: round(a.confidence), action: CAUSE_ACTIONS[causeClass] });
    });
  }
  const groups: TriageGroup[] = classes
    .map((c) => ({ causeClass: c, action: CAUSE_ACTIONS[c], failures: triaged.filter((f) => f.causeClass === c).map((f) => f.id) }))
    .filter((g) => g.failures.length > 0)
    .map((g) => ({ ...g, count: g.failures.length }));
  const id = newId();
  return {
    kind: 'failure-triage',
    id,
    graphIri: graphIriFor('failure-triage', id),
    createdAt: new Date().toISOString(),
    model,
    confidence: triaged.length > 0 ? round(mean(triaged.map((f) => f.confidence))) : 1,
    repository,
    usage,
    failures: triaged,
    groups,
    parsedFailures: parsed.length,
    changedFiles,
  };
}
