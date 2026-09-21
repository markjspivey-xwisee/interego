/**
 * Navigation with memory: the precedents a navigation consults and what they do to it — the
 * similarity rule, the mixing rule, the injection past the directory pass, and the round trip
 * of an outcome's (task, observed files) through the payload, the pod parser and the store.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { navigate } from '../src/judgments/navigate.js';
import { recordOutcome } from '../src/judgments/outcome.js';
import { matchPrecedents, mixWithPrecedents, precedentWeights, taskSimilarity, taskTokens, type Precedent } from '../src/judgments/precedents.js';
import { contextFromEnv, descriptorTrig, hmdMarkdown, payloadTurtle } from '../src/descriptor.js';
import { choiceAnswer, FakeJevClient, type Answer } from '../src/jev-client.js';
import { outcomeFromContent } from '../src/pod-calibration.js';
import { inventory, type RepoFile, type RepoInventory } from '../src/repo.js';
import { HarnessStore, computeCalibration, precedentsOf } from '../src/store.js';
import { fixtureRepo, idOf, preferringJev } from './helpers.js';

const at = '2026-09-21T02:00:00.000Z';
const precedent = (task: string, files: string[], n = 1): Precedent => ({ task, files, source: 'live', at, outcomeIri: `urn:graph:jev-harness:outcome:o${n}` });

describe('task similarity', () => {
  it('keeps content words, splits identifiers and camelCase, drops stop words and short tokens', () => {
    expect([...taskTokens('Fix the rollupCourse block-satisfaction in cmi5, again')].sort()).toEqual(['block', 'cmi5', 'course', 'rollup', 'satisfaction']);
  });
  it('is Jaccard over those words, 0 without any', () => {
    expect(taskSimilarity('rollup emits satisfied once per block', 'rollup emits satisfied per block')).toBe(0.8);
    expect(taskSimilarity('rollup emits satisfied once per block', 'bearer auth gate rejects an expired token')).toBe(0);
    expect(taskSimilarity('the and', 'rollup')).toBe(0);
  });
});

describe('matching precedents', () => {
  const pool = [
    precedent('rollup emits satisfied once per block', ['src/rollup.ts'], 1),
    precedent('bearer auth gate rejects an expired token', ['src/auth/gate.ts'], 2),
    precedent('course structure parser reads the rollup', ['src/course.ts'], 3),
    precedent('rollup docs', [], 4),
  ];
  it('keeps the similar ones, strongest first, and never one without files', () => {
    const m = matchPrecedents('rollup emits satisfied per block', pool);
    expect(m.map((p) => [p.outcomeIri.slice(-2), p.similarity])).toEqual([['o1', 0.8], ['o3', 0.143]].filter(([, s]) => (s as number) >= 0.15));
    expect(m).toHaveLength(1);
    expect(matchPrecedents('rollup emits satisfied per block', pool, { minSimilarity: 0.1 }).map((p) => p.outcomeIri.slice(-2))).toEqual(['o1', 'o3']);
  });
  it('caps how many apply', () => {
    const many = Array.from({ length: 9 }, (_, i) => precedent('rollup emits satisfied once per block', [`src/f${i}.ts`], i));
    expect(matchPrecedents('rollup emits satisfied per block', many)).toHaveLength(5);
  });
});

describe('mixing precedents into the candidates', () => {
  it('spreads each precedent over its files and normalises', () => {
    const w = precedentWeights(matchPrecedents('rollup emits satisfied per block', [precedent('rollup emits satisfied once per block', ['src/a.ts', 'src/b.ts'])]));
    expect([...w.entries()]).toEqual([['src/a.ts', 0.5], ['src/b.ts', 0.5]]);
  });
  it('mixes in proportion to the strongest similarity, dropping precedent mass on non-candidates', () => {
    const matched = matchPrecedents('rollup emits satisfied per block', [precedent('rollup emits satisfied once per block', ['src/rollup.ts', 'docs/absent.md'])]);
    const mix = mixWithPrecedents({ F1: 0.7, F2: 0.3 }, (id) => ({ F1: 'src/course.ts', F2: 'src/rollup.ts' })[id], matched);
    expect(mix.weight).toBe(0.4);
    expect(mix.probabilities).toEqual({ F1: 0.42, F2: 0.58 });
    expect(mix.contributed).toEqual(['src/rollup.ts']);
  });
  it('leaves the distribution alone when no precedent file is a candidate, or nothing matched', () => {
    const matched = matchPrecedents('rollup emits satisfied per block', [precedent('rollup emits satisfied once per block', ['docs/absent.md'])]);
    expect(mixWithPrecedents({ F1: 0.7, F2: 0.3 }, () => 'src/x.ts', matched)).toEqual({ probabilities: { F1: 0.7, F2: 0.3 }, weight: 0, contributed: [] });
    expect(mixWithPrecedents({ F1: 0.7, F2: 0.3 }, () => 'src/x.ts', []).weight).toBe(0);
  });
});

describe('navigate with memory', () => {
  const task = 'rollup emits satisfied per block';
  const memory = [precedent('rollup emits satisfied once per block', ['src/rollup.ts'])];

  it('lets a precedent decide when the model is unsure, and records what it consulted', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    // The model leans to the neighbouring file at 0.45 — the measured shape of a miss.
    const jev = new FakeJevClient((state, questions) => {
      const out: Partial<Record<string, Answer>> = {};
      if (questions['change']) out['change'] = choiceAnswer(Object.keys((questions['change'] as { criteria: Record<string, unknown> }).criteria), idOf(state, 'src/course.ts'), 0.45);
      return out;
    });
    const j = await navigate(jev, inv, { task, precedents: memory });
    expect(j.files[0]?.path).toBe('src/rollup.ts');
    expect(j.files[1]?.path).toBe('src/course.ts');
    expect(j.precedents).toEqual({ consulted: 1, weight: 0.4, applied: [{ task: memory[0]!.task, similarity: 0.8, files: ['src/rollup.ts'], outcomeIri: memory[0]!.outcomeIri }] });
    expect(j.confidence).toBeCloseTo(0.6 * 0.45 + 0.4 * 0.44125, 2);
    expect(j.advice).toBe('open-top-three');
  });

  it('a sure model keeps its answer; an empty memory is recorded as consulted and changes nothing', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const sure = preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/course.ts') : undefined));
    const withMemory = await navigate(sure, inv, { task, precedents: memory });
    expect(withMemory.files[0]?.path).toBe('src/course.ts');
    expect(withMemory.precedents?.weight).toBe(0.4);
    const empty = await navigate(sure, inv, { task, precedents: [] });
    const none = await navigate(sure, inv, { task });
    expect(empty.precedents).toEqual({ consulted: 0, weight: 0, applied: [] });
    expect(none.precedents).toBeUndefined();
    expect(empty.files).toEqual(none.files);
    expect(empty.confidence).toBe(none.confidence);
  });

  it('brings a precedent file back into the candidates when the directory pass dropped its directory', async () => {
    const files: RepoFile[] = [];
    for (let i = 0; i < 600; i += 1) {
      const dir = `pkg${i % 6}/mod${Math.floor(i / 100)}`;
      files.push({ id: `F${String(i).padStart(4, '0')}`, path: `${dir}/file${i}.ts`, isTest: false, isDoc: false });
    }
    const remembered = 'pkg5/mod5/file599.ts';
    const inv: RepoInventory = { root: fixtureRepo(), name: 'big', commit: null, files };
    const jev = () => new FakeJevClient((state, questions) => {
      const out: Partial<Record<string, Answer>> = {};
      const dirs = (state as { directories?: Array<{ id: string; path: string }> }).directories ?? [];
      for (const d of dirs) out[d.id] = { type: 'noul', noul: d.path === 'pkg3/mod2/' ? 0.8 : 0.05 };
      if (questions['change']) {
        const options = Object.keys((questions['change'] as { criteria: Record<string, unknown> }).criteria);
        const present = (state as { files: Array<{ id: string; path: string }> }).files.find((f) => f.path === remembered);
        out['change'] = choiceAnswer(options, present ? present.id : options[0]!, 0.4);
      }
      return out;
    });
    const without = jev();
    const before = await navigate(without, inv, { task: 'change the thing in pkg3 mod2' });
    expect((without.calls[1]!.state as { files: Array<{ path: string }> }).files.some((f) => f.path === remembered)).toBe(false);
    expect(before.files[0]?.path).not.toBe(remembered);

    const withMemory = jev();
    const after = await navigate(withMemory, inv, { task: 'change the thing in pkg3 mod2', precedents: [precedent('change the thing in pkg3 mod2 again', [remembered])] });
    expect((withMemory.calls[1]!.state as { files: Array<{ path: string }> }).files.some((f) => f.path === remembered)).toBe(true);
    expect(after.files[0]?.path).toBe(remembered);
    expect(after.precedents?.applied[0]?.files).toEqual([remembered]);
  });
});

describe('an outcome is a precedent wherever it is read from', () => {
  const ctx = contextFromEnv('http://localhost:6090');

  it('carries the task and the observed files in its payload, and comes back from the pod with them', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const jev = preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/course.ts') : undefined));
    const j = await navigate(jev, inv, { task: 'rollup emits satisfied once per block' });
    const o = recordOutcome(j, { judgmentIri: j.graphIri, filesChanged: ['src/rollup.ts', 'tests/rollup.test.ts'] });
    expect(o.task).toBe('rollup emits satisfied once per block');
    const turtle = payloadTurtle(o, ctx);
    expect(turtle).toContain('jvh:observedFile "src/rollup.ts"');
    expect(turtle).toContain('jvh:observedFile "tests/rollup.test.ts"');
    expect(turtle).toContain('jvh:task "rollup emits satisfied once per block"');

    const back = outcomeFromContent(descriptorTrig(o, ctx), { descriptorUrl: 'http://css.railway.internal:3456/u-pk-x/context-graphs/9.ttl' });
    expect(back?.task).toBe(o.task);
    expect(back?.observed.filesChanged).toEqual(['src/rollup.ts', 'tests/rollup.test.ts']);
    expect(precedentsOf([back!])).toEqual([{ task: o.task, files: ['src/rollup.ts', 'tests/rollup.test.ts'], source: 'live', at: back!.createdAt, outcomeIri: back!.graphIri }]);
  });

  it('the store lists precedents from what it saved, and a navigation payload records the ones it applied', async () => {
    const root = fixtureRepo();
    const store = new HarnessStore(mkdtempSync(join(tmpdir(), 'jev-precedents-')));
    const inv = inventory(root, { includeHeads: true });
    const jev = preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/course.ts') : undefined));
    const j = await navigate(jev, inv, { task: 'rollup emits satisfied once per block' });
    const o = recordOutcome(j, { judgmentIri: j.graphIri, filesChanged: ['src/rollup.ts'] });
    const save = (p: typeof j | typeof o): void => store.save(p, { payloadTurtle: payloadTurtle(p, ctx), descriptorTrig: descriptorTrig(p, ctx), markdown: hmdMarkdown(p, ctx) });
    save(j); save(o);
    expect(store.precedents()).toEqual([{ task: j.task, files: ['src/rollup.ts'], source: 'live', at: o.createdAt, outcomeIri: o.graphIri }]);

    const next = await navigate(jev, inv, { task: 'rollup emits satisfied per block', precedents: store.precedents() });
    const turtle = payloadTurtle(next, ctx);
    expect(turtle).toContain('jvh:precedentsConsulted "1"^^xsd:integer');
    expect(turtle).toContain('jvh:precedentWeight "0.4"^^xsd:double');
    expect(turtle).toContain(`jvh:precedent [ jvh:task "rollup emits satisfied once per block" ; jvh:similarity "0.8"^^xsd:double ; jvh:path "src/rollup.ts" ; prov:wasDerivedFrom <${o.graphIri}> ]`);
    expect(hmdMarkdown(next, ctx)).toContain('Memory: 1 precedent(s) consulted, 1 applied, share 0.4.');
  });
});

describe('calibration tells memory from model', () => {
  it('an outcome carries the memory share of the navigation it scores, round trip, and the view splits on it', async () => {
    const ctx = contextFromEnv('http://localhost:6090');
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const jev = preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/course.ts') : undefined));
    const memory = [precedent('rollup emits satisfied once per block', ['src/rollup.ts'])];
    const withMemory = await navigate(jev, inv, { task: 'rollup emits satisfied per block', precedents: memory });
    const without = await navigate(jev, inv, { task: 'rollup emits satisfied per block' });
    const o1 = recordOutcome(withMemory, { judgmentIri: withMemory.graphIri, filesChanged: ['src/course.ts'] });
    const o2 = recordOutcome(without, { judgmentIri: without.graphIri, filesChanged: ['src/rollup.ts'] });
    expect(o1.priorPrecedentWeight).toBe(0.4);
    expect(o2.priorPrecedentWeight).toBeUndefined();
    expect(payloadTurtle(o1, ctx)).toContain('jvh:priorPrecedentWeight "0.4"^^xsd:double');
    const back = outcomeFromContent(descriptorTrig(o1, ctx), { descriptorUrl: 'http://css.railway.internal:3456/u-pk-x/context-graphs/10.ttl' });
    expect(back?.priorPrecedentWeight).toBe(0.4);
    const view = computeCalibration([o1, o2, back!]);
    expect(view.memory.applied).toEqual({ samples: 2, hitAt1: 1, hitAt3: 1, brier: o1.brier });
    expect(view.memory.none).toEqual({ samples: 1, hitAt1: 0, hitAt3: o2.hitAt3 ? 1 : 0, brier: o2.brier });
  });
});
