/**
 * Bounded microbenchmark of the OWL/SHACL-AF triple-limit insertion guard.
 * Uses the installed N3 Store, not a model of its implementation.
 *
 * Run from the repository root:
 * npx tsx applications/foxxi-content-intelligence/i2idlx/typescript/reasoning-counter-benchmark.ts
 *
 * Timings are observations only: no speed ratio is a correctness gate.
 * Full native/oracle parity remains the acceptance test for the reasoner.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Store, DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';

const { namedNode: nn, quad } = DataFactory;
const n3Version = (createRequire(import.meta.url)('n3/package.json') as { version: string }).version;
const sizeGetter = Object.getOwnPropertyDescriptor(Store.prototype, 'size')?.get;
if (!sizeGetter) throw new Error('Installed N3 Store has no size getter');
const deadline = performance.now() + 45000;
const checkBudget = () => {
  if (performance.now() > deadline) throw new Error('N3 counter benchmark exceeded its 45-second budget');
};
const p = nn('urn:counter-benchmark:p'), o = nn('urn:counter-benchmark:o');
const makeQuads = (kind: string, count: number): Quad[] =>
  Array.from({ length: count }, (_, i) => quad(nn('urn:counter-benchmark:' + kind + ':' + i), p, o));
const key = (q: Quad) => JSON.stringify([q.subject.value, q.predicate.value, q.object.value, q.graph.value]);

type Strategy = 'legacy-size-getter' | 'local-counter';
function run(strategy: Strategy, seed: Quad[], inferred: Quad[], maxTriples: number) {
  checkBudget();
  const g = new Store(seed);
  let sizeReads = 0;
  Object.defineProperty(g, 'size', {
    configurable: true,
    get() { sizeReads++; return sizeGetter!.call(g) as number; },
  });
  let tripleCount = g.size, added = 0, attempts = 0, exceeded = false;
  const started = performance.now();
  // Propose each inferred quad twice, including duplicates after the cap is reached.
  for (const q of inferred.flatMap(q => [q, q])) {
    if (++attempts % 128 === 0) checkBudget();
    if (g.countQuads(q.subject, q.predicate, q.object, null) > 0) continue;
    g.addQuad(q);
    added++;
    if (strategy === 'local-counter') tripleCount++;
    const count = strategy === 'legacy-size-getter' ? g.size : tripleCount;
    if (count > maxTriples) { exceeded = true; break; }
  }
  const milliseconds = performance.now() - started;
  const finalTriples = g.size;
  if (strategy === 'local-counter') assert.equal(tripleCount, finalTriples, 'Counter must match the actual N3 store');
  assert.equal(sizeReads, strategy === 'legacy-size-getter' ? added + 2 : 2,
    'The local counter must avoid a size getter read on each successful insertion');
  return {
    strategy, milliseconds, sizeReads, added, attempts, finalTriples, exceeded,
    quads: [...g].map(key).sort(),
  };
}

function compare(seedCount: number, novelCount: number, counterFirst = false) {
  const seed = makeQuads('seed', seedCount), inferred = makeQuads('inferred', novelCount);
  const maxTriples = seedCount + novelCount;
  const order: Strategy[] = counterFirst
    ? ['local-counter', 'legacy-size-getter']
    : ['legacy-size-getter', 'local-counter'];
  const records = order.map(strategy => run(strategy, seed, inferred, maxTriples));
  const legacy = records.find(r => r.strategy === 'legacy-size-getter')!;
  const counter = records.find(r => r.strategy === 'local-counter')!;
  assert.deepEqual(counter.quads, legacy.quads, 'Both guards must retain the identical RDF quad set');
  assert.equal(counter.exceeded, false, 'Exact threshold must be accepted');
  assert.equal(legacy.exceeded, false, 'Exact threshold must be accepted');
  assert.equal(counter.added, novelCount, 'Duplicate candidates must not increment the counter');
  assert.equal(legacy.added, novelCount, 'Duplicate candidates must not add RDF quads');
  assert.equal(counter.attempts, 2 * novelCount);
  assert.equal(legacy.attempts, 2 * novelCount);
  const omitQuads = ({ quads: _quads, ...record }: ReturnType<typeof run>) => record;
  return {
    seedTriples: seedCount, novelTriples: novelCount, candidates: 2 * novelCount,
    legacy: omitQuads(legacy), counter: omitQuads(counter),
    observedLegacyToCounterRatio: legacy.milliseconds / counter.milliseconds,
  };
}

// Check the failure boundary independently of timings and then warm up both paths.
const boundarySeed = makeQuads('boundary-seed', 3), boundaryInferred = makeQuads('boundary-new', 3);
const boundaryOld = run('legacy-size-getter', boundarySeed, boundaryInferred, 5);
const boundaryNew = run('local-counter', boundarySeed, boundaryInferred, 5);
assert.equal(boundaryOld.exceeded, true);
assert.equal(boundaryNew.exceeded, true);
assert.equal(boundaryOld.finalTriples, 6);
assert.equal(boundaryNew.finalTriples, 6);
assert.deepEqual(boundaryNew.quads, boundaryOld.quads);
compare(100, 50);
const samples = [compare(4000, 2000), compare(45000, 300, true)];
checkBudget();
console.log(JSON.stringify({
  benchmark: 'bounded-actual-n3-triple-limit-guard',
  n3Version,
  budgetSeconds: 45,
  boundary: { maxTriples: 5, firstRejectedTriples: boundaryNew.finalTriples, identicalQuads: true },
  note: 'Getter counts and quad equality are assertions; timing ratios are observations, not speedup guarantees or full reasoner parity.',
  samples,
}, null, 2));
