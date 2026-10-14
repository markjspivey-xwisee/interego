import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTiming } from './check-parity.js';

test('measured HermiT durations ignore punctuation in ontology group names', () => {
  const report = (seconds: number) => ({
    owlrl: { input: 7, closed: 12, seconds, errors: [] },
    disjointCheck: { pairs: 3, seconds, agree: true },
    hermit: { 'PROV-O · schema.org · peers': {
      sample: { seconds, consistent: true, triples: 7 },
      clash: { seconds, consistent: false, triples: 8 },
    } },
  });
  assert.deepEqual(normalizeTiming(report(1.6)), normalizeTiming(report(1.9)));
  assert.notDeepEqual(normalizeTiming(report(1.6)), normalizeTiming({
    ...report(1.9), owlrl: { input: 7, closed: 14, seconds: 1.9, errors: [] },
  }));
  assert.notDeepEqual(normalizeTiming(report(1.6)), normalizeTiming({
    ...report(1.9), hermit: { 'PROV-O · schema.org · peers': {
      sample: { seconds: 1.9, consistent: false, triples: 7 },
      clash: { seconds: 1.9, consistent: false, triples: 8 },
    } },
  }));
});

test('duration normalization retains unrelated seconds and rejects nonnumeric evidence', () => {
  assert.deepEqual(normalizeTiming({ other: { seconds: 1 }, hermit: {
    group: { sample: { detail: { seconds: 2 } }, seconds: 3 },
  } }), { hermit: { group: { sample: { detail: { seconds: 2 } }, seconds: 3 } }, other: { seconds: 1 } });
  assert.throws(() => normalizeTiming({ hermit: { 'schema.org': { sample: { seconds: 'missing' } } } }),
    /only a measured numeric duration/);
});
