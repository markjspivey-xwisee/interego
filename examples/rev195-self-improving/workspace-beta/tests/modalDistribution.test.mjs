// Five cases pinning the modalDistribution contract.
// Run with: node --test modalDistribution.test.mjs
//
// ★ FIXTURE, NOT A REPO GATE — and deliberately so. This file is the SPEC the rev195
// self-improving-agent demo codes against: `task.json` names it as `tests.file`, and
// `verifiers.mjs::runDeterministicTests` spawns `node --test` on it as the demo's inner-loop
// green-light before a tick's Hypothetical step is promoted to Asserted. It is unreachable
// from the repo suite twice over — `vitest.config.ts` includes only `*.test.ts`, and only
// under `tests/`, `applications/**/tests/`, `integrations/**/tests/` and `mcp-server/tests/`
// — and no workflow names it. Routing it in would gate master on a demo agent's scratch
// output: the implementation beside it is rewritten by an LLM on every run. A reachability
// audit that greps `**/*.test.*` lands here and has re-derived that from scratch more than
// once; this comment is the durable answer.
//
// ★ TWO OF THE THREE COPIES ARE MACHINE-WRITTEN. `workspace/tests/` holds the authored
// original. `collective.mjs` overwrites `workspace-alpha/tests/` and `workspace-beta/tests/`
// with it verbatim (`writeFileSync(testDst, testContent, 'utf8')`) at the start of every
// collective run, because every agent must be judged against the same spec. Editing one copy
// and not the others does not survive the next run — it silently reverts and resurfaces as an
// unexplained dirty tree. All three must stay byte-identical.

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
