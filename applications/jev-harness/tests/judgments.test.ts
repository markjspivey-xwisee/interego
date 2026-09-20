import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { navigate } from '../src/judgments/navigate.js';
import { selectTests } from '../src/judgments/select-tests.js';
import { parseTestLog, triage } from '../src/judgments/triage.js';
import { reviewGate, truncateDiff } from '../src/judgments/review-gate.js';
import { recordOutcome } from '../src/judgments/outcome.js';
import { inventory, importGraph, testsImporting, isSensitivePath, type RepoInventory, type RepoFile } from '../src/repo.js';
import { choiceAnswer, FakeJevClient, type Answer } from '../src/jev-client.js';
import { fixtureRepo, idOf, preferringJev, scripted } from './helpers.js';
import { computeCalibration, computeAdviceBuckets, calibratedAdvice } from '../src/store.js';
import type { OutcomeRecord } from '../src/judgments/outcome.js';

describe('repository inventory (no git)', () => {
  it('lists files, detects tests and docs, builds the import graph', () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const paths = inv.files.map((f) => f.path);
    expect(paths).toContain('src/rollup.ts');
    expect(inv.files.find((f) => f.path === 'tests/rollup.test.ts')?.isTest).toBe(true);
    expect(inv.files.find((f) => f.path === 'README.md')?.isDoc).toBe(true);
    expect(inv.files.find((f) => f.path === 'src/rollup.ts')?.head).toContain('Block and course satisfaction rollup');
    const graph = importGraph(inv.root, inv.files);
    expect([...graph.get('src/course.ts') ?? []]).toEqual(['src/rollup.ts']);
    expect(testsImporting(['src/rollup.ts'], graph, 2)).toEqual(['tests/course-flow.test.ts', 'tests/rollup.test.ts']);
    expect(isSensitivePath('src/auth/gate.ts')).toBe(true);
    expect(isSensitivePath('src/rollup.ts')).toBe(false);
  });
});

describe('navigate', () => {
  it('ranks the preferred file, the covering test and the doc, and derives advice from confidence', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const jev = preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/rollup.ts') : q === 'test' ? idOf(state, 'tests/rollup.test.ts') : q === 'doc' ? idOf(state, 'CONFORMANCE.md') : undefined), { covered: 0.8 });
    const j = await navigate(jev, inv, { task: 'rollup emits satisfied twice per block' });
    expect(j.files[0]?.path).toBe('src/rollup.ts');
    expect(j.tests[0]?.path).toBe('tests/rollup.test.ts');
    expect(j.docs[0]?.path).toBe('CONFORMANCE.md');
    expect(j.covered).toBe(0.8);
    expect(j.advice).toBe('open-top-file');
    expect(j.passes).toHaveLength(1);
    expect(jev.calls[0]!.questions['change']!.type).toBe('choice');
  });

  it('narrows by directory first when the tree exceeds the option limit, and weights confidence by the directory pass', async () => {
    const files: RepoFile[] = [];
    for (let i = 0; i < 600; i += 1) {
      const dir = `pkg${i % 6}/mod${Math.floor(i / 100)}`;
      files.push({ id: `F${String(i).padStart(4, '0')}`, path: `${dir}/file${i}.ts`, isTest: false, isDoc: false });
    }
    const target = files.find((f) => f.path.startsWith('pkg3/mod2/'))!;
    const inv: RepoInventory = { root: fixtureRepo(), name: 'big', commit: null, files };
    const jev = new FakeJevClient((state, questions) => {
      const out: Partial<Record<string, Answer>> = {};
      const dirs = (state as { directories?: Array<{ id: string; path: string }> }).directories ?? [];
      for (const d of dirs) out[d.id] = { type: 'noul', noul: d.path === 'pkg3/mod2/' ? 0.8 : 0.05 };
      if (questions['change']) out['change'] = choiceAnswer(Object.keys((questions['change'] as { criteria: Record<string, unknown> }).criteria), idOf(state, target.path), 0.9);
      return out;
    });
    const j = await navigate(jev, inv, { task: 'change the thing in pkg3 mod2' });
    expect(j.passes.map((p) => p.stage)).toEqual(['directories', 'files']);
    expect(j.passes[0]!.options).toBe(36);
    expect(j.passes[1]!.options).toBeLessThanOrEqual(240);
    expect(j.files[0]?.path).toBe(target.path);
    expect(j.directoryProbability).toBe(0.8);
    expect(j.confidence).toBe(0.72);
    expect(j.advice).toBe('open-top-file');
  });
});

describe('select-tests', () => {
  it('unions the import graph with the model\'s semantic picks', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const jev = preferringJev((q, state) => (q === 'test_0' ? idOf(state, 'tests/conformance-claims-are-grounded.test.ts') : undefined), { covered_0: 0.9 });
    const j = await selectTests(jev, inv, { changedFiles: ['src/rollup.ts'] });
    expect(j.mode).toBe('subset');
    const by = Object.fromEntries(j.tests.map((t) => [t.path, t.selectedBy]));
    expect(by['tests/rollup.test.ts']).toBe('deterministic');
    expect(by['tests/course-flow.test.ts']).toBe('deterministic');
    expect(by['tests/rollup-edge-cases.test.ts']).toBe('name-affinity');
    expect(by['tests/conformance-claims-are-grounded.test.ts']).toBe('semantic');
    expect(j.covered['src/rollup.ts']).toBe(0.9);
  });

  it('falls back to the full suite for a sensitive path without calling the model', async () => {
    const inv = inventory(fixtureRepo());
    const jev = scripted({});
    const j = await selectTests(jev, inv, { changedFiles: ['src/auth/gate.ts'] });
    expect(j.mode).toBe('full');
    expect(j.reasons.join(' ')).toContain('sensitive');
    expect(jev.calls).toHaveLength(0);
    expect(j.tests.length).toBe(4);
  });
});

describe('triage', () => {
  const log = readFileSync(new URL('./fixtures/vitest-fail.txt', import.meta.url), 'utf8');

  it('parses the vitest summary into distinct failures with files and names', () => {
    const failures = parseTestLog(log);
    const files = failures.map((f) => f.file);
    expect(files).toEqual(expect.arrayContaining(['tests/lrs-adapter.test.ts', 'tests/rollup.test.ts', 'tests/course-parser.test.ts']));
    expect(failures.find((f) => f.file === 'tests/rollup.test.ts')?.excerpt).toContain('expected 4 to be 2');
    expect(failures.every((f) => f.excerpt.length <= 1400)).toBe(true);
  });

  it('classifies each failure and maps classes to actions', async () => {
    const parsed = parseTestLog(log);
    const jev = scripted(Object.fromEntries(parsed.map((f, i) => {
      const cls = f.excerpt.includes('ECONNREFUSED') ? 'environment' : f.excerpt.includes('ENOENT') ? 'missing-dependency-or-fixture' : 'code-defect';
      return [`class_${i}`, choiceAnswer(['code-defect', 'test-defect', 'environment', 'flaky', 'missing-dependency-or-fixture', 'unclear'], cls, 0.85)];
    })));
    const j = await triage(jev, null, { log, changedFiles: ['src/cmi5-lms.ts'] });
    const byFile = Object.fromEntries(j.failures.map((f) => [f.file, f]));
    expect(byFile['tests/lrs-adapter.test.ts']?.causeClass).toBe('environment');
    expect(byFile['tests/lrs-adapter.test.ts']?.action).toBe('fix-environment-then-retry');
    expect(byFile['tests/rollup.test.ts']?.causeClass).toBe('code-defect');
    expect(byFile['tests/course-parser.test.ts']?.action).toBe('install-or-build-then-retry');
    expect(j.groups.map((g) => g.causeClass).sort()).toEqual(['code-defect', 'environment', 'missing-dependency-or-fixture']);
  });
});

describe('review-gate', () => {
  const clean = 'diff --git a/src/rollup.ts b/src/rollup.ts\n--- a/src/rollup.ts\n+++ b/src/rollup.ts\n@@ -1,3 +1,3 @@\n-export function rollupCourse(): number { return 4; }\n+export function rollupCourse(): number { return 2; }\n';
  const lowHazards = () => scripted({
    'authorization-change': { type: 'noul', noul: 0.05 }, 'validation-weakened': { type: 'noul', noul: 0.05 }, 'assertions-removed': { type: 'noul', noul: 0.05 },
    'new-external-effect': { type: 'noul', noul: 0.05 }, 'behaviour-beyond-description': { type: 'noul', noul: 0.1 },
    description_match: { type: 'score', score: 1.9, legend: {}, probabilities: {}, confidence: 0.9 },
    risk: choiceAnswer(['low', 'medium', 'high'], 'low', 0.9),
  });

  it('blocks a secret without calling the model, but not a fixture token inside a test file', async () => {
    const jev = lowHazards();
    const j = await reviewGate(jev, null, { diff: `${clean}+const key = "sk-abcdefghijklmnopqrstuvwxyz123456";\n`, title: 'fix rollup' });
    expect(j.verdict).toBe('block');
    expect(jev.calls).toHaveLength(0);
    const fixture = 'diff --git a/tests/setup.test.ts b/tests/setup.test.ts\n--- a/tests/setup.test.ts\n+++ b/tests/setup.test.ts\n@@ -1 +1,2 @@\n+const token = "testtokenvalue1234567890";\n';
    const j2 = await reviewGate(lowHazards(), null, { diff: fixture, title: 'add setup test', description: 'fixture token for the client setup test' });
    expect(j2.verdict).not.toBe('block');
    const real = fixture.replace('tests/setup.test.ts', 'src/setup.ts').replace(/tests\/setup\.test\.ts/g, 'src/setup.ts');
    expect((await reviewGate(lowHazards(), null, { diff: real, title: 't' })).verdict).toBe('block');
  });

  it('asks for a human when the probability of high risk is at or above the policy mass, not when the rating is merely unsure', async () => {
    const torn = scripted({
      'authorization-change': { type: 'noul', noul: 0.05 }, 'validation-weakened': { type: 'noul', noul: 0.05 }, 'assertions-removed': { type: 'noul', noul: 0.05 },
      'new-external-effect': { type: 'noul', noul: 0.05 }, 'behaviour-beyond-description': { type: 'noul', noul: 0.1 },
      description_match: { type: 'score', score: 1.9, legend: {}, probabilities: {}, confidence: 0.9 },
      risk: { type: 'choice', choice: 'low', probabilities: { low: 0.5, medium: 0.47, high: 0.03 }, confidence: 0.3 },
    });
    expect((await reviewGate(torn, null, { diff: clean, title: 'x', description: 'y' })).verdict).toBe('auto-ok');
    const risky = scripted({
      'authorization-change': { type: 'noul', noul: 0.05 }, 'validation-weakened': { type: 'noul', noul: 0.05 }, 'assertions-removed': { type: 'noul', noul: 0.05 },
      'new-external-effect': { type: 'noul', noul: 0.05 }, 'behaviour-beyond-description': { type: 'noul', noul: 0.1 },
      description_match: { type: 'score', score: 1.9, legend: {}, probabilities: {}, confidence: 0.9 },
      risk: { type: 'choice', choice: 'medium', probabilities: { low: 0.2, medium: 0.5, high: 0.3 }, confidence: 0.4 },
    });
    const j = await reviewGate(risky, null, { diff: clean, title: 'x', description: 'y' });
    expect(j.verdict).toBe('needs-human-review');
    expect(j.reasons[0]).toContain('probability of high risk');
  });

  it('auto-ok for a clean, well-described, low-risk diff', async () => {
    const j = await reviewGate(lowHazards(), null, { diff: clean, title: 'Emit satisfied once per block', description: 'rollupCourse returned 4; it now returns 2.' });
    expect(j.verdict).toBe('auto-ok');
    expect(j.hazards.every((h) => !h.fired)).toBe(true);
  });

  it('needs a human when a sensitive path changes, whatever the model says', async () => {
    const diff = clean.replace(/src\/rollup\.ts/g, 'src/auth/gate.ts');
    const j = await reviewGate(lowHazards(), null, { diff, title: 'tidy gate', description: 'formatting' });
    expect(j.verdict).toBe('needs-human-review');
    expect(j.checks[0]).toContain('sensitive-path');
  });

  it('needs a human when a hazard fires or the description does not match', async () => {
    const jev = scripted({
      'authorization-change': { type: 'noul', noul: 0.8 }, 'validation-weakened': { type: 'noul', noul: 0.1 }, 'assertions-removed': { type: 'noul', noul: 0.1 },
      'new-external-effect': { type: 'noul', noul: 0.1 }, 'behaviour-beyond-description': { type: 'noul', noul: 0.1 },
      description_match: { type: 'score', score: 0.4, legend: {}, probabilities: {}, confidence: 0.9 },
      risk: choiceAnswer(['low', 'medium', 'high'], 'medium', 0.7),
    });
    const j = await reviewGate(jev, null, { diff: clean, title: 'x', description: 'y' });
    expect(j.verdict).toBe('needs-human-review');
    expect(j.hazards.find((h) => h.name === 'authorization-change')?.fired).toBe(true);
    expect(j.reasons.some((r) => r.includes('description matches'))).toBe(true);
  });

  it('truncates a large diff keeping sensitive hunks first', () => {
    const big = `diff --git a/src/a.ts b/src/a.ts\n${'+x\n'.repeat(5000)}diff --git a/src/auth/gate.ts b/src/auth/gate.ts\n+gate\n`;
    const out = truncateDiff(big, 2000);
    expect(out.startsWith('diff --git a/src/auth/gate.ts')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(2000 + 40);
  });
});

describe('outcomes and calibration', () => {
  it('scores a test selection by missed failures and computes the view', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const j = await selectTests(scripted({}), inv, { changedFiles: ['src/rollup.ts'] });
    const o = recordOutcome(j, { judgmentIri: j.graphIri, testsFailed: ['tests/rollup.test.ts', 'tests/other.test.ts'] });
    expect(o.hitAt1).toBe(false);
    expect(o.missed).toEqual(['tests/other.test.ts']);
    const view = computeCalibration([o, { ...o, hitAt1: true, missed: [] }], 5);
    const cell = view.cells.find((c) => c.kind === 'test-selection')!;
    expect(cell.samples).toBe(2);
    expect(cell.hitAt1).toBe(0.5);
    expect(cell.status).toBe('Hypothetical');
  });

  it('calibrated advice replaces the static band once a confidence bucket has enough outcomes', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const nav = await navigate(preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/rollup.ts') : undefined)), inv, { task: 'rollup emits satisfied twice per block' });
    expect(nav.advice).toBe('open-top-file');
    const miss = (): OutcomeRecord => ({ ...recordOutcome(nav, { judgmentIri: nav.graphIri, filesChanged: ['src/course.ts', 'src/other.ts'] }) });
    const outcomes = [miss(), miss(), miss(), miss(), miss()];
    expect(outcomes[0]!.priorConfidence).toBe(nav.confidence);
    const buckets = computeAdviceBuckets(outcomes);
    const bucket = buckets.find((b) => nav.confidence >= b.from && nav.confidence < b.from + 0.2)!;
    expect(bucket.samples).toBe(5);
    expect(bucket.hitAt1).toBe(0);
    // hit@3 is 0 too (top three were rollup, course-flow test?, ...) → widen-search
    const advice = calibratedAdvice(nav.confidence, nav.advice, buckets);
    expect(advice.basis).toBe('calibrated');
    expect(advice.advice).toBe(bucket.hitAt3 && bucket.hitAt3 >= 0.5 ? 'open-top-three' : 'widen-search');
    expect(calibratedAdvice(nav.confidence, nav.advice, computeAdviceBuckets(outcomes.slice(0, 4))).basis).toBe('default');
    // Replayed outcomes only fill a bucket when no live ones can: five backtest misses count, but
    // once five live outcomes exist they alone decide, and the bucket says which pool it used.
    const replay = outcomes.map((o) => ({ ...o, source: 'backtest' as const }));
    expect(computeAdviceBuckets(replay).find((b) => b.samples > 0)?.source).toBe('all');
    expect(computeAdviceBuckets(outcomes).find((b) => b.samples > 0)?.source).toBe('live');
    const liveHits = outcomes.map((o) => ({ ...o, hitAt1: true, hitAt3: true }));
    const mixed = computeAdviceBuckets([...replay, ...liveHits]).find((b) => b.samples > 0)!;
    expect(mixed.source).toBe('live');
    expect(mixed.hitAt1).toBe(1);
  });
});
