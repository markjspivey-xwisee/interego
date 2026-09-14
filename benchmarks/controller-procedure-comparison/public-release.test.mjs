/** Synthetic regressions; no private task resources or live calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASSIGNMENTS, audit, differences } from './audit.mjs';

function fixture() {
  const runs = ASSIGNMENTS.map(([controller, procedure, binding], index) => ({
    run: index + 1, controller, procedure, binding, status: 'completed',
    captureComplete: true, captureScope: 'closed-run', protocolConformant: true,
    interventionApplied: false, protocolDeviationCount: 0,
    planRevisionEntries: controller === 'react-style' ? null : 0,
    successfulLaunches: 1, gradedSubmissions: 1, grades: [{ correct: 10, questions: 10, score: 1 }],
    applicableProcedureDiscovered: false, procedureUseVerified: false, checkpointReached: true,
    staleRejectionObserved: false, staleRecoveryVerified: false, finalStateVerified: true,
    replayComplete: true, replayLinks: 3, retainedCalls: 2, retainedGroups: 1,
    retainedFailedCalls: 0, retainedTransportExceptions: 0,
    calls: [1, 2].map(i => ({ index: i, group: 1, verb: 'act', failed: false, transportException: false })),
  }));
  return { schema: 'interego.controller-comparison-public/v1', protocolVersion: '2.0.0',
    scope: 'unsigned-derived-measurements', recordingScope: 'mandatory-recorder-and-retained-controller-records',
    design: 'two-controller-policies-two-procedure-conditions-two-binding-conditions',
    modelScope: 'common-inherited-configuration-provider-details-unavailable',
    assessmentScope: 'reused-assessment-fresh-instances', runs, ...differences(runs) };
}

test('the published projection passes its independent audit', () => {
  audit(JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8')));
});
test('unknown private fields are rejected at every public depth', () => {
  for (const select of [v => v, v => v.runs[0], v => v.runs[0].calls[0], v => v.runs[0].grades[0], v => v.paired[0]]) {
    const value = fixture();
    select(value).privatePayload = 'SYNTHETIC_PRIVATE_CANARY';
    assert.throws(() => audit(value));
  }
});
test('exact captures cannot hide a submission or grade', () => {
  const value = fixture();
  value.runs[0].gradedSubmissions = 2;
  assert.throws(() => audit(value));
});
test('an interrupted checkpoint cannot become a closed controller', () => {
  const value = fixture();
  Object.assign(value.runs[4], { status: 'interrupted', captureScope: 'checkpoint-prefix' });
  assert.throws(() => audit(value));
});
test('an exact checkpoint prefix retains its grade and excludes paired contrasts', () => {
  const value = fixture();
  Object.assign(value.runs[4], { status: 'interrupted', captureScope: 'checkpoint-prefix',
    captureComplete: false, protocolConformant: null, finalStateVerified: false });
  Object.assign(value, differences(value.runs));
  audit(value);
  assert.equal(value.paired[3].callsPresentMinusAbsent, null);
  assert.equal(value.runs[4].grades[0].correct, 10);
  value.paired[3].callsPresentMinusAbsent = 0;
  assert.throws(() => audit(value));
});
test('a planned changed binding cannot count as observed recovery', () => {
  const value = fixture();
  value.runs[4].staleRecoveryVerified = true;
  assert.throws(() => audit(value));
});
test('a nine-of-ten grade cannot claim a completed release', () => {
  const value = fixture();
  value.runs[0].grades = [{ correct: 9, questions: 10, score: 0.9 }];
  assert.throws(() => audit(value));
});
test('unknown costs and unsuccessful outcomes cannot be presented as completed pairs', () => {
  const value = fixture();
  Object.assign(value.runs[3], { status: 'blocked', grades: [{ correct: 9, questions: 10, score: 0.9 }] });
  Object.assign(value, differences(value.runs));
  audit(value);
  assert.equal(value.paired[1].comparisonAvailable, true);
  assert.equal(value.paired[1].bothTasksCompleted, false);
});
test('unstarted assignments cannot carry calls or fabricated grades', () => {
  const value = fixture();
  Object.assign(value.runs[7], { status: 'not-started', captureScope: 'not-started',
    captureComplete: null, protocolConformant: null });
  assert.throws(() => audit(value));
});
test('plan-revision counts cannot be assigned to ReAct notes', () => {
  const value = fixture();
  value.runs[0].planRevisionEntries = 1;
  assert.throws(() => audit(value));
});
