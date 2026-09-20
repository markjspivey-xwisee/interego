/**
 * CI test selection: the deterministic import-graph set is always run; Jev adds the tests
 * that cover a changed file without importing it (conformance docs, end-to-end flows, tests
 * named after behaviours). Sensitive paths, infrastructure files and oversized changes fall
 * back to the whole suite — that rule is code, published on the judgment, and never the
 * model's call.
 */

import type { ChoiceAnswer, JevClient, NoulAnswer, Question } from '../jev-client.js';
import { JEV_LIMITS, topK } from '../jev-client.js';
import { importGraph, isSensitivePath, isTestPath, testsImporting, type RepoFile, type RepoInventory } from '../repo.js';
import { addUsage, emptyUsage, graphIriFor, mean, newId, round, type JudgmentBase } from './common.js';

export interface SelectTestsInput {
  readonly changedFiles: readonly string[];
  readonly task?: string;
}

export type SelectionSource = 'self' | 'deterministic' | 'name-affinity' | 'semantic';

export interface SelectedTest {
  readonly path: string;
  readonly selectedBy: SelectionSource;
  readonly probability?: number;
  readonly forFile?: string;
}

export interface TestSelectionJudgment extends JudgmentBase {
  readonly kind: 'test-selection';
  readonly changedFiles: readonly string[];
  readonly mode: 'subset' | 'full';
  readonly reasons: readonly string[];
  readonly tests: readonly SelectedTest[];
  /** Per changed file: probability that some test covers it at all. */
  readonly covered: Readonly<Record<string, number>>;
  readonly task?: string;
}

export const SELECTION_POLICY = {
  maxChangedFilesForSubset: 25,
  maxSemanticFilesPerRequest: 12,
  semanticMinProbability: 0.15,
  semanticTopK: 3,
} as const;

const NO_TEST = 'no-existing-test';

export async function selectTests(jev: JevClient, inv: RepoInventory, input: SelectTestsInput): Promise<TestSelectionJudgment> {
  const changed = [...new Set(input.changedFiles.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')))];
  const reasons: string[] = [];
  const allTests = inv.files.filter((f) => f.isTest);
  const base = {
    id: newId(),
    createdAt: new Date().toISOString(),
    repository: { name: inv.name, root: inv.root, commit: inv.commit },
    changedFiles: changed,
    ...(input.task ? { task: input.task } : {}),
  };

  const full = (why: string, model = jev.model): TestSelectionJudgment => ({
    kind: 'test-selection',
    ...base,
    graphIri: graphIriFor('test-selection', base.id),
    model,
    confidence: 1,
    usage: emptyUsage(),
    mode: 'full',
    reasons: [...reasons, why],
    tests: allTests.map((t) => ({ path: t.path, selectedBy: 'deterministic' as const })),
    covered: {},
  });

  if (changed.length === 0) return full('no changed files were given, so nothing narrows the suite');
  if (allTests.length === 0) return full('the repository has no test files');
  const sensitive = changed.filter(isSensitivePath);
  if (sensitive.length > 0) return full(`sensitive paths changed: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? ', …' : ''}`);
  if (changed.length > SELECTION_POLICY.maxChangedFilesForSubset) return full(`${changed.length} files changed, above the ${SELECTION_POLICY.maxChangedFilesForSubset}-file subset limit`);

  // Deterministic half.
  const graph = importGraph(inv.root, inv.files);
  const selected = new Map<string, SelectedTest>();
  for (const c of changed) if (isTestPath(c)) selected.set(c, { path: c, selectedBy: 'self' });
  for (const t of testsImporting(changed, graph, 2)) if (!selected.has(t)) selected.set(t, { path: t, selectedBy: 'deterministic' });
  // Name affinity: a test whose file name carries a changed file's stem (xapi-profile.ts ↔
  // xapi-profile-*.test.ts) concerns it even when it never imports it. On the 40-commit replay
  // the import graph alone covered the tests the author touched in 43% of cases.
  for (const c of changed) {
    const stem = fileStem(c);
    if (!stem) continue;
    for (const t of allTests) {
      if (selected.has(t.path)) continue;
      const testStem = fileStem(t.path) ?? '';
      if (testStem === stem || testStem.startsWith(`${stem}-`) || testStem.startsWith(`${stem}.`) || testStem.endsWith(`-${stem}`)) {
        selected.set(t.path, { path: t.path, selectedBy: 'name-affinity', forFile: c });
      }
    }
  }

  // Semantic half — for changed files that are not tests themselves.
  const sources = changed.filter((c) => !isTestPath(c));
  const covered: Record<string, number> = {};
  let usage = emptyUsage();
  const confidences: number[] = [];
  let model = jev.model;
  if (sources.length > 0) {
    const options = testOptionsFor(sources, allTests);
    const byId = new Map(options.map((t) => [t.id, t]));
    const criteria: Record<string, string | null> = {};
    for (const t of options) criteria[t.id] = null;
    criteria[NO_TEST] = 'No listed test covers this file\'s behaviour.';
    for (let start = 0; start < sources.length; start += SELECTION_POLICY.maxSemanticFilesPerRequest) {
      const batch = sources.slice(start, start + SELECTION_POLICY.maxSemanticFilesPerRequest);
      const questions: Record<string, Question> = {};
      batch.forEach((_path, i) => {
        questions[`test_${i}`] = {
          type: 'choice',
          instructions: `Which entry in \`tests\` most directly covers the behaviour implemented in \`changed_files[${i}]\`? Judge from paths and head lines; a test can cover a file without importing it.`,
          criteria,
        };
        questions[`covered_${i}`] = {
          type: 'noul',
          instructions: `Judging from paths and head lines, does some entry in \`tests\` cover the behaviour implemented in \`changed_files[${i}]\`?`,
          criteria: { true: 'A listed test clearly exercises this file\'s behaviour.', false: 'No listed test refers to this file\'s behaviour.' },
        };
      });
      const state = {
        ...(input.task ? { task: input.task } : {}),
        changed_files: batch.map((p) => headOf(inv, p)),
        tests: options.map((t) => (t.head ? { id: t.id, path: t.path, head: t.head } : { id: t.id, path: t.path })),
      };
      const r = await jev.systemOne(state, questions);
      usage = addUsage(usage, r);
      model = r.model;
      batch.forEach((path, i) => {
        const choice = r.answers[`test_${i}`] as ChoiceAnswer;
        const noul = r.answers[`covered_${i}`] as NoulAnswer;
        confidences.push(choice.confidence);
        covered[path] = round(noul.noul);
        for (const { key, p } of topK(choice.probabilities, SELECTION_POLICY.semanticTopK + 1)) {
          if (key === NO_TEST || p < SELECTION_POLICY.semanticMinProbability) continue;
          const t = byId.get(key);
          if (!t || selected.has(t.path)) continue;
          selected.set(t.path, { path: t.path, selectedBy: 'semantic', probability: round(p), forFile: path });
        }
      });
    }
  }

  const tests = [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (tests.length === 0) {
    reasons.push('neither the import graph nor the model found a covering test');
    return { ...full('no covering tests found, so the whole suite runs', model), usage, reasons: [...reasons] };
  }
  return {
    kind: 'test-selection',
    ...base,
    graphIri: graphIriFor('test-selection', base.id),
    model,
    confidence: confidences.length > 0 ? round(mean(confidences)) : 1,
    usage,
    mode: 'subset',
    reasons: [...reasons, `${tests.filter((t) => t.selectedBy === 'self' || t.selectedBy === 'deterministic').length} tests by import graph, ${tests.filter((t) => t.selectedBy === 'name-affinity').length} by name affinity, ${tests.filter((t) => t.selectedBy === 'semantic').length} added by the model`],
    tests,
    covered,
  };
}

/** Test options for a Choice: tests near the changed files first, then the rest, capped. */
function testOptionsFor(sources: readonly string[], allTests: readonly RepoFile[]): RepoFile[] {
  const cap = Math.min(240, JEV_LIMITS.choiceOptions - 5);
  if (allTests.length <= cap) return [...allTests];
  const prefixes = sources.map((p) => p.split('/').slice(0, 2).join('/'));
  const score = (t: RepoFile): number => {
    const tp = t.path.split('/').slice(0, 2).join('/');
    if (prefixes.includes(tp)) return 2;
    if (prefixes.some((p) => p.split('/')[0] === tp.split('/')[0])) return 1;
    return 0;
  };
  return [...allTests].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path)).slice(0, cap);
}

/** The file name without directories, test markers or extensions; null when too short to be a signal. */
export function fileStem(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  const stem = base.replace(/\.(test|spec|check)\.[cm]?[jt]sx?$/, '').replace(/\.[cm]?[jt]sx?$|\.(md|json|ttl|yml|yaml|mjs)$/, '');
  if (stem.length < 4 || /^(index|main|server|utils?|types?|common|helpers?)$/.test(stem)) return null;
  return stem.toLowerCase();
}

function headOf(inv: RepoInventory, path: string): { path: string; head?: string } {
  const f = inv.files.find((x) => x.path === path);
  return f?.head ? { path, head: f.head } : { path };
}
