/** Validate unsigned public measurements. This does not authenticate private evidence. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERBS = ['dereference', 'get_descriptor', 'get_current_head', 'sign_request', 'act', 'publish_context'];
export const ASSIGNMENTS = [
  ['react-style', 'procedure-present', 'stable'],
  ['react-style', 'procedure-absent', 'stable'],
  ['plan-act-style', 'procedure-absent', 'stable'],
  ['plan-act-style', 'procedure-present', 'stable'],
  ['plan-act-style', 'procedure-present', 'changed-binding'],
  ['plan-act-style', 'procedure-absent', 'changed-binding'],
  ['react-style', 'procedure-absent', 'changed-binding'],
  ['react-style', 'procedure-present', 'changed-binding'],
];
const TOP = ['schema', 'protocolVersion', 'scope', 'recordingScope', 'design', 'modelScope',
  'assessmentScope', 'runs', 'paired', 'controllerContrasts'];
const ROW = ['run', 'controller', 'procedure', 'binding', 'status', 'captureComplete', 'captureScope',
  'protocolConformant', 'interventionApplied', 'protocolDeviationCount', 'planRevisionEntries',
  'successfulLaunches', 'gradedSubmissions', 'grades', 'applicableProcedureDiscovered',
  'procedureUseVerified', 'checkpointReached', 'staleRejectionObserved', 'staleRecoveryVerified',
  'finalStateVerified', 'replayComplete', 'replayLinks', 'retainedCalls', 'retainedGroups',
  'retainedFailedCalls', 'retainedTransportExceptions', 'calls'];
const keys = (value, allowed) => {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...allowed].sort(), 'Public field allowlist mismatch');
};
const count = value => assert(Number.isSafeInteger(value) && value >= 0 && value <= 10000);
const nullableCount = value => { if (value !== null) count(value); };
const tri = value => assert(value === null || typeof value === 'boolean');
const bothClosed = rows => rows.every(row => row.captureComplete === true && row.protocolConformant === true);

export function differences(rows) {
  const paired = [];
  for (const controller of ['react-style', 'plan-act-style']) {
    for (const binding of ['stable', 'changed-binding']) {
      const group = rows.filter(row => row.controller === controller && row.binding === binding);
      const present = group.find(row => row.procedure === 'procedure-present');
      const absent = group.find(row => row.procedure === 'procedure-absent');
      const available = bothClosed(group);
      paired.push({ controller, binding, comparisonAvailable: available,
        bothTasksCompleted: group.every(row => row.status === 'completed'),
        callsPresentMinusAbsent: available ? present.retainedCalls - absent.retainedCalls : null,
        groupsPresentMinusAbsent: available ? present.retainedGroups - absent.retainedGroups : null });
    }
  }
  // Match the prospectively reported order: stable controller blocks, then changed blocks.
  [paired[1], paired[2]] = [paired[2], paired[1]];
  const controllerContrasts = [];
  for (const procedure of ['procedure-present', 'procedure-absent']) {
    for (const binding of ['stable', 'changed-binding']) {
      const group = rows.filter(row => row.procedure === procedure && row.binding === binding);
      const react = group.find(row => row.controller === 'react-style');
      const plan = group.find(row => row.controller === 'plan-act-style');
      const available = bothClosed(group);
      controllerContrasts.push({ procedure, binding, comparisonAvailable: available,
        bothTasksCompleted: group.every(row => row.status === 'completed'),
        callsReactMinusPlanAct: available ? react.retainedCalls - plan.retainedCalls : null,
        groupsReactMinusPlanAct: available ? react.retainedGroups - plan.retainedGroups : null });
    }
  }
  return { paired, controllerContrasts };
}

export function audit(value) {
  keys(value, TOP);
  assert.equal(value.schema, 'interego.controller-comparison-public/v1');
  assert.equal(value.protocolVersion, '2.0.0');
  assert.equal(value.scope, 'unsigned-derived-measurements');
  assert.equal(value.recordingScope, 'mandatory-recorder-and-retained-controller-records');
  assert.equal(value.design, 'two-controller-policies-two-procedure-conditions-two-binding-conditions');
  assert.equal(value.modelScope, 'common-inherited-configuration-provider-details-unavailable');
  assert.equal(value.assessmentScope, 'reused-assessment-fresh-instances');
  assert(Array.isArray(value.runs) && value.runs.length === ASSIGNMENTS.length);
  value.runs.forEach((row, index) => {
    keys(row, ROW);
    assert.equal(row.run, index + 1);
    assert.deepEqual([row.controller, row.procedure, row.binding], ASSIGNMENTS[index]);
    assert(['completed', 'blocked', 'interrupted', 'not-started'].includes(row.status));
    assert(['closed-run', 'checkpoint-prefix', 'incomplete', 'not-started'].includes(row.captureScope));
    for (const name of ['captureComplete', 'protocolConformant', 'applicableProcedureDiscovered',
      'procedureUseVerified', 'checkpointReached', 'staleRejectionObserved', 'staleRecoveryVerified',
      'finalStateVerified', 'replayComplete']) tri(row[name]);
    for (const name of ['protocolDeviationCount', 'retainedCalls', 'retainedGroups',
      'retainedFailedCalls', 'retainedTransportExceptions']) count(row[name]);
    for (const name of ['planRevisionEntries', 'successfulLaunches', 'gradedSubmissions', 'replayLinks']) nullableCount(row[name]);
    assert.equal(typeof row.interventionApplied, 'boolean');
    if (row.binding === 'stable') assert.equal(row.interventionApplied, false);
    if (row.staleRejectionObserved === true || row.staleRecoveryVerified === true) assert.equal(row.interventionApplied, true);
    if (row.staleRecoveryVerified === true) assert.equal(row.staleRejectionObserved, true);
    if (row.controller === 'react-style') assert.equal(row.planRevisionEntries, null);
    else if (row.captureComplete === true) assert.notEqual(row.planRevisionEntries, null);
    assert(Array.isArray(row.calls) && Array.isArray(row.grades));
    let lastGroup = 0;
    row.calls.forEach((call, ordinal) => {
      keys(call, ['index', 'group', 'verb', 'failed', 'transportException']);
      assert.equal(call.index, ordinal + 1);
      count(call.group);
      assert(call.group > 0 && call.group >= lastGroup && call.group <= lastGroup + 1);
      lastGroup = call.group;
      assert(VERBS.includes(call.verb));
      assert.equal(typeof call.failed, 'boolean');
      assert.equal(typeof call.transportException, 'boolean');
      if (call.transportException) assert(call.failed);
    });
    assert.equal(row.retainedCalls, row.calls.length);
    assert.equal(row.retainedGroups, lastGroup);
    assert.equal(row.retainedFailedCalls, row.calls.filter(call => call.failed).length);
    assert.equal(row.retainedTransportExceptions, row.calls.filter(call => call.transportException).length);
    for (const grade of row.grades) {
      keys(grade, ['correct', 'questions', 'score']);
      count(grade.correct);
      assert.equal(grade.questions, 10);
      assert(grade.correct <= grade.questions);
      assert.equal(grade.score, grade.correct / grade.questions);
      assert.notEqual(row.successfulLaunches, 0);
    }
    if (row.captureComplete === true) {
      assert.equal(row.captureScope, 'closed-run');
      assert(['completed', 'blocked'].includes(row.status));
      assert.notEqual(row.successfulLaunches, null);
      assert.notEqual(row.gradedSubmissions, null);
      assert.equal(row.grades.length, row.gradedSubmissions);
      assert(row.successfulLaunches + row.gradedSubmissions <= row.calls.filter(call => call.verb === 'act').length);
    }
    if (row.protocolConformant === true) {
      assert.equal(row.captureComplete, true);
      assert.equal(row.protocolDeviationCount, 0);
      assert(row.retainedCalls <= 80 && row.successfulLaunches <= 1 && row.gradedSubmissions <= 1);
    }
    if (row.status === 'completed') {
      assert.equal(row.grades.at(-1)?.correct, 10);
      assert.equal(row.finalStateVerified, true);
      assert.equal(row.replayComplete, true);
    }
    if (row.status === 'interrupted') {
      assert.notEqual(row.captureComplete, true);
      assert.notEqual(row.protocolConformant, true);
    }
    if (row.captureScope === 'checkpoint-prefix') {
      assert.equal(row.status, 'interrupted');
      assert.equal(row.captureComplete, false);
      assert.equal(row.checkpointReached, true);
    }
    if (row.status === 'not-started') {
      assert.equal(row.captureScope, 'not-started');
      assert.equal(row.captureComplete, null);
      assert.equal(row.protocolConformant, null);
      for (const name of ['retainedCalls', 'successfulLaunches', 'gradedSubmissions']) assert.equal(row[name], 0);
      assert.equal(row.grades.length, 0);
      assert.equal(row.interventionApplied, false);
    }
  });
  const computed = differences(value.runs);
  assert.deepEqual(value.paired, computed.paired);
  assert.deepEqual(value.controllerContrasts, computed.controllerContrasts);
  return { assignments: value.runs.length,
    started: value.runs.filter(row => row.status !== 'not-started').length,
    completed: value.runs.filter(row => row.status === 'completed').length,
    retainedCalls: value.runs.reduce((n, row) => n + row.retainedCalls, 0),
    retainedGroups: value.runs.reduce((n, row) => n + row.retainedGroups, 0),
    retainedTransportExceptions: value.runs.reduce((n, row) => n + row.retainedTransportExceptions, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? fileURLToPath(new URL('./results.json', import.meta.url));
  process.stdout.write(JSON.stringify(audit(JSON.parse(readFileSync(path, 'utf8'))), null, 2) + '\n');
}
