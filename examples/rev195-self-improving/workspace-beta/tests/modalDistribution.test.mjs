// Five cases pinning the modalDistribution contract.
// Run with: node --test modalDistribution.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modalDistribution } from '../modalDistribution.mjs';

test('empty input returns all zeros', () => {
  const r = modalDistribution('');
  assert.deepEqual(r, { Asserted: 0, Hypothetical: 0, Counterfactual: 0, other: 0, total: 0 });
});

test('single Asserted descriptor', () => {
  const r = modalDistribution('{"modalStatus":"Asserted"}');
  assert.deepEqual(r, { Asserted: 1, Hypothetical: 0, Counterfactual: 0, other: 0, total: 1 });
});

test('mixed three categories', () => {
  const input = [
    '{"modalStatus":"Asserted"}',
    '{"modalStatus":"Hypothetical"}',
    '{"modalStatus":"Counterfactual"}',
    '{"modalStatus":"Asserted"}',
    '{"modalStatus":"Hypothetical"}',
  ].join('\n');
  const r = modalDistribution(input);
  assert.deepEqual(r, { Asserted: 2, Hypothetical: 2, Counterfactual: 1, other: 0, total: 5 });
});

test('malformed JSON lines are skipped without crashing', () => {
  const input = [
    '{"modalStatus":"Asserted"}',
    'not valid json',
    '{"modalStatus":"Hypothetical"}',
    '{ broken',
    '{"modalStatus":"Counterfactual"}',
  ].join('\n');
  const r = modalDistribution(input);
  assert.deepEqual(r, { Asserted: 1, Hypothetical: 1, Counterfactual: 1, other: 0, total: 3 });
});

test('unknown / missing modal status counted as other', () => {
  const input = [
    '{"modalStatus":"Asserted"}',
    '{"modalStatus":"Unknown"}',
    '{"id":"no-modal-here"}',
    '{"modalStatus":"Retracted"}',
  ].join('\n');
  const r = modalDistribution(input);
  assert.deepEqual(r, { Asserted: 1, Hypothetical: 0, Counterfactual: 0, other: 3, total: 4 });
});
