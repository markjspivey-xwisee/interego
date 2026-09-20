/**
 * Task navigation: where does this task's change belong, which test covers it, what should
 * be read first. One Choice per role over file ids (the semantic_find recipe), a Noul for
 * "is this behaviour covered at all", and a directory pass first when the repository
 * exceeds a Choice's option limit.
 *
 * Confidence gating is code: a confident answer hands the agent one file, a middling one
 * hands it three, a weak one says so and the agent falls back to search. The measured miss
 * on this repo (a rollup task answered with the neighbouring file at 0.39) is exactly the
 * case the middle band exists for.
 */

import { join } from 'node:path';
import type { JevClient, Question, ChoiceAnswer, NoulAnswer } from '../jev-client.js';
import { JEV_LIMITS, topK } from '../jev-client.js';
import { groupByPrefix, readHead, type RepoFile, type RepoInventory } from '../repo.js';
import { addUsage, emptyUsage, graphIriFor, newId, round, type JudgmentBase } from './common.js';

export interface NavigateInput {
  readonly task: string;
  readonly scope?: string;
  readonly topK?: number;
}

export interface Candidate {
  readonly path: string;
  readonly probability: number;
}

export type NavigationAdvice = 'open-top-file' | 'open-top-three' | 'widen-search';

export interface NavigationPass {
  readonly stage: 'directories' | 'files';
  readonly options: number;
  readonly confidence: number;
}

export interface NavigationJudgment extends JudgmentBase {
  readonly kind: 'navigation';
  readonly task: string;
  readonly scope?: string;
  readonly files: readonly Candidate[];
  readonly tests: readonly Candidate[];
  readonly docs: readonly Candidate[];
  /** Probability that an existing test already covers the behaviour. */
  readonly covered: number;
  readonly noTestProbability: number;
  readonly advice: NavigationAdvice;
  readonly passes: readonly NavigationPass[];
  readonly filesConsidered: number;
  /** Probability the directory pass gave the top candidate's directory (absent without a directory pass). */
  readonly directoryProbability?: number;
  /** Whether the advice came from the static bands or from measured calibration (set by the service). */
  readonly adviceBasis?: 'default' | 'calibrated';
  /** The calibration bucket the advice was read from, when calibrated. */
  readonly adviceBucket?: { readonly from: number; readonly samples: number; readonly hitAt1: number | null; readonly hitAt3: number | null };
}

const MAX_OPTIONS = Math.min(240, JEV_LIMITS.choiceOptions - 5);
const NO_TEST = 'no-existing-test';
const NO_DOC = 'no-document';
/** Sample file names shown per directory in the first pass. */
const DIRECTORY_SAMPLE = 8;
/** Directories below this probability are dropped from the second pass, after the top few. */
const DIRECTORY_MIN_PROBABILITY = 0.25;
/** The top-ranked directories are always kept, whatever their probability. */
const DIRECTORY_MIN_KEEP = 3;

export const NAVIGATION_THRESHOLDS = { openTopFile: 0.6, openTopThree: 0.3 } as const;

export async function navigate(jev: JevClient, inv: RepoInventory, input: NavigateInput): Promise<NavigationJudgment> {
  const k = Math.min(10, Math.max(1, input.topK ?? 3));
  let usage = emptyUsage();
  const passes: NavigationPass[] = [];
  let candidates: readonly RepoFile[] = inv.files;
  if (candidates.length === 0) throw new Error('navigate: the repository inventory is empty');

  // Pass 1 — narrow by directory when the tree exceeds one Choice's option limit.
  //
  // One Noul per directory rather than one Choice over all of them: a Choice must crown a
  // single winner, and on a 40-commit replay it crowned the wrong top-level directory more
  // than half the time, after which no file-pass answer could be right. Independent Nouls
  // let several plausible directories through and record a probability per directory that
  // the final confidence is weighted by.
  const directoryProbability = new Map<string, number>();
  if (candidates.length > MAX_OPTIONS) {
    let groups = groupByPrefix(candidates, 2);
    if (groups.size > MAX_OPTIONS) groups = groupByPrefix(candidates, 1);
    const dirs = [...groups.entries()].map(([key, members], i) => ({
      id: `D${String(i).padStart(3, '0')}`,
      key,
      members,
      sample: members.slice(0, DIRECTORY_SAMPLE).map((f) => f.path.slice(key.length)),
    }));
    const questions: Record<string, Question> = {};
    dirs.forEach((d, i) => {
      questions[d.id] = {
        type: 'noul',
        instructions: `Could the change described in \`task\` belong in \`directories[${i}]\` (path ${d.key}), judging from its path and sample file names?`,
        criteria: { true: 'The directory or its files concern what the task changes.', false: 'Nothing in this directory concerns the task.' },
      };
    });
    const state = {
      task: input.task,
      repository: { name: inv.name, commit: inv.commit },
      directories: dirs.map((d) => ({ id: d.id, path: d.key, files: d.members.length, sample: d.sample })),
    };
    const r = await jev.systemOne(state, questions);
    usage = addUsage(usage, r);
    const ranked = dirs
      .map((d) => ({ d, p: (r.answers[d.id] as NoulAnswer | undefined)?.noul ?? 0 }))
      .sort((a, b) => b.p - a.p);
    passes.push({ stage: 'directories', options: dirs.length, confidence: round(ranked[0]?.p ?? 0) });
    const picked: RepoFile[] = [];
    for (const [rank, { d, p }] of ranked.entries()) {
      directoryProbability.set(d.key, round(p));
      if (rank >= DIRECTORY_MIN_KEEP && p < DIRECTORY_MIN_PROBABILITY) break;
      if (picked.length > 0 && picked.length + d.members.length > MAX_OPTIONS) continue;
      picked.push(...d.members);
      if (picked.length >= MAX_OPTIONS) break;
    }
    candidates = picked.slice(0, MAX_OPTIONS);
  }

  // Pass 2 — files. Heads are read here, for the candidate subset only.
  const files = candidates.map((f) => (f.head ? f : withHead(inv.root, f)));
  const byId = new Map(files.map((f) => [f.id, f]));
  const tests = files.filter((f) => f.isTest);
  const docs = files.filter((f) => f.isDoc);

  const fileCriteria: Record<string, string | null> = {};
  for (const f of files) fileCriteria[f.id] = null;
  const questions: Record<string, Question> = {
    change: {
      type: 'choice',
      instructions: 'Which entry in `files` most likely contains the code or text that must change to accomplish `task`? Judge from each entry\'s path and head line.',
      criteria: fileCriteria,
    },
  };
  if (tests.length > 0) {
    const testCriteria: Record<string, string | null> = {};
    for (const t of tests) testCriteria[t.id] = null;
    testCriteria[NO_TEST] = 'No entry in `files` is a test that covers this behaviour.';
    questions['test'] = {
      type: 'choice',
      instructions: 'Which test or check entry in `files` most directly covers the behaviour described in `task`? Judge from the paths and head lines.',
      criteria: testCriteria,
    };
    questions['covered'] = {
      type: 'noul',
      instructions: 'Judging from the paths and head lines in `files`, does an existing test or check already cover the behaviour described in `task`?',
      criteria: { true: 'A test or check entry clearly names this behaviour.', false: 'No test or check entry refers to this behaviour.' },
    };
  }
  if (docs.length > 0) {
    const docCriteria: Record<string, string | null> = {};
    for (const d of docs) docCriteria[d.id] = null;
    docCriteria[NO_DOC] = 'No document in `files` is worth reading first for this task.';
    questions['doc'] = {
      type: 'choice',
      instructions: 'Which document entry in `files` should be read first before working on `task`?',
      criteria: docCriteria,
    };
  }

  const state = {
    task: input.task,
    repository: { name: inv.name, commit: inv.commit },
    files: files.map((f) => (f.head ? { id: f.id, path: f.path, head: f.head } : { id: f.id, path: f.path })),
  };
  const r = await jev.systemOne(state, questions);
  usage = addUsage(usage, r);
  const change = r.answers['change'] as ChoiceAnswer;
  passes.push({ stage: 'files', options: files.length, confidence: round(change.confidence) });

  const toCandidates = (probabilities: Record<string, number>, exclude: string): Candidate[] =>
    topK(probabilities, k + 1)
      .filter(({ key }) => key !== exclude && byId.has(key))
      .slice(0, k)
      .map(({ key, p }) => ({ path: byId.get(key)!.path, probability: round(p) }));

  const testAnswer = r.answers['test'] as ChoiceAnswer | undefined;
  const docAnswer = r.answers['doc'] as ChoiceAnswer | undefined;
  const coveredAnswer = r.answers['covered'] as NoulAnswer | undefined;
  // The judgment's confidence is the file pass weighted by how plausible the directory pass
  // found the top candidate's directory; without a directory pass it is the file pass alone.
  const topPath = byId.get(topK(change.probabilities, 1)[0]?.key ?? '')?.path ?? '';
  const topDirectoryProbability = directoryProbability.size > 0 ? directoryProbabilityFor(topPath, directoryProbability) : 1;
  const confidence = round(change.confidence * topDirectoryProbability);
  const advice: NavigationAdvice =
    confidence >= NAVIGATION_THRESHOLDS.openTopFile ? 'open-top-file'
      : confidence >= NAVIGATION_THRESHOLDS.openTopThree ? 'open-top-three'
        : 'widen-search';

  const id = newId();
  const judgment: NavigationJudgment = {
    kind: 'navigation',
    id,
    graphIri: graphIriFor('navigation', id),
    createdAt: new Date().toISOString(),
    model: r.model,
    confidence,
    repository: { name: inv.name, root: inv.root, commit: inv.commit },
    usage,
    task: input.task,
    ...(input.scope ? { scope: input.scope } : {}),
    files: toCandidates(change.probabilities, ''),
    tests: testAnswer ? toCandidates(testAnswer.probabilities, NO_TEST) : [],
    docs: docAnswer ? toCandidates(docAnswer.probabilities, NO_DOC) : [],
    covered: coveredAnswer ? round(coveredAnswer.noul) : 0,
    noTestProbability: testAnswer ? round(testAnswer.probabilities[NO_TEST] ?? 0) : 1,
    advice,
    passes,
    filesConsidered: files.length,
    ...(directoryProbability.size > 0 ? { directoryProbability: round(topDirectoryProbability) } : {}),
  };
  return judgment;
}

function directoryProbabilityFor(path: string, probabilities: Map<string, number>): number {
  // The longest registered prefix wins (depth-2 groups are registered as "a/b/", depth-1 as "a/").
  let best: number | undefined;
  let bestLength = -1;
  for (const [key, p] of probabilities) {
    if (path.startsWith(key) && key.length > bestLength) { best = p; bestLength = key.length; }
  }
  return best ?? 0;
}

function withHead(root: string, f: RepoFile): RepoFile {
  const head = readHead(join(root, f.path));
  return head ? { ...f, head } : f;
}
