/**
 * Offline validation of an unsigned projection; not authentication of live evidence.
 * Reconciled retained rows do not establish complete original capture. Counts in a
 * retained-lower-bound stream, including failures and batches, are minimum retained
 * observations. Controller recovery can verify an outcome without restoring the
 * frozen fresh-agent protocol or permitting an exact paired cost comparison.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERBS = ['dereference', 'get_descriptor', 'get_current_head', 'sign_request', 'act', 'publish_context'];
export const ARMS = ['procedure-present', 'procedure-absent'];
export const PAIRS = [
  { pair: 'P1', condition: 'stable', firstArm: 'procedure-present' },
  { pair: 'P2', condition: 'stable', firstArm: 'procedure-absent' },
  { pair: 'P3', condition: 'changed-binding', firstArm: 'procedure-present' },
  { pair: 'P4', condition: 'changed-binding', firstArm: 'procedure-absent' },
];
export const STEPS = Array.from({ length: 10 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
export const ROLES = Array.from({ length: 9 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`);
export const EDGES = [[1, 2], [1, 3], [2, 4], [3, 4], [4, 5], [2, 6], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10]]
  .map(([from, to], i) => ({ id: `D${String(i + 1).padStart(2, '0')}`, from: STEPS[from - 1], to: STEPS[to - 1] }));
export const VERIFICATIONS = ['freshSession', 'answerCorrespondence', 'observationVerified', 'finalStateVerified',
  'candidateDiscoveryLineageVerified', 'applicableProcedureDiscovered', 'frozenProcedureUseVerified',
  'staleRejectionObserved', 'recoveredFromStaleBinding', 'privateArtifactsVerified'];
export const REQUIRED_GRADE = { correct: 10, questions: 10, score: 1 };
export const MAIN_PROTOCOL_VERSION = '1.0.4';
export const SETUP_PROTOCOL_VERSION = '1.0.3';
export const SETUP_REASON = 'preflight-proof-not-discoverable';
export const SETUP_DISPOSITION = 'aborted-before-pair-completion';
export const keys = (value, expected) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected public fields');
};
export const integer = (value, max = 100000) => {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= max, 'Invalid public count');
  return value;
};
export const triBoolean = value => {
  assert(value === null || typeof value === 'boolean', 'Invalid public observation');
  return value;
};
export function accountingScope(captureComplete, controllerRestarts) {
  assert.equal(typeof captureComplete, 'boolean', 'Explicit original capture completeness is required');
  integer(controllerRestarts, 1000);
  return captureComplete && controllerRestarts === 0 ? 'exact-retained-stream' : 'retained-lower-bound';
}
const sum = (items, name) => items.reduce((total, item) => total + item[name], 0);
const nullableCount = value => value === null ? null : integer(value, 1000);
const both = (left, right) => left === false || right === false ? false : left === null || right === null ? null : true;

export function auditCalls(calls, reportedCounts) {
  keys(reportedCounts, ['calls', 'batches', 'failedCalls']);
  Object.values(reportedCounts).forEach(value => integer(value, 1000));
  assert(Array.isArray(calls) && calls.length <= 1000);
  const batches = new Set();
  let lastBatch = 0;
  for (const [index, call] of calls.entries()) {
    keys(call, ['index', 'batch', 'verb', 'failed']);
    assert.equal(call.index, index + 1);
    integer(call.batch, 1000); assert(call.batch > 0 && call.batch >= lastBatch, 'Batch order must be contiguous');
    if (!batches.has(call.batch)) assert.equal(call.batch, batches.size + 1, 'Batch aliases follow first occurrence');
    batches.add(call.batch); lastBatch = call.batch;
    assert(VERBS.includes(call.verb), 'Unknown generic verb');
    assert.equal(typeof call.failed, 'boolean');
  }
  const counts = { calls: calls.length, batches: batches.size, failedCalls: calls.filter(call => call.failed).length };
  assert.deepEqual(reportedCounts, counts);
  return counts;
}

/** Initial setup attempts are a separate incomplete cohort, with no paired estimates. */
export function auditSetup(setup) {
  keys(setup, ['schema', 'scope', 'sourceAuditPassed', 'disclosureScope', 'protocol', 'disposition', 'reason', 'plannedRuns', 'startedRuns', 'unstartedRuns', 'runs']);
  assert.equal(setup.schema, 'live-discovery-public-setup-attempts/v1');
  assert.equal(setup.scope, 'unsigned-derived-incomplete-setup-records');
  assert.equal(setup.sourceAuditPassed, true);
  assert.equal(setup.disclosureScope, 'retained-records-and-agent-self-disclosure');
  keys(setup.protocol, ['version', 'design', 'plannedPairs']);
  assert.equal(setup.protocol.version, SETUP_PROTOCOL_VERSION);
  assert.equal(setup.protocol.design, 'four-pair-procedure-exposure/v1');
  assert.deepEqual(setup.protocol.plannedPairs, PAIRS);
  assert.equal(setup.disposition, SETUP_DISPOSITION);
  assert.equal(setup.reason, SETUP_REASON);
  assert.equal(setup.plannedRuns, 8); assert.equal(setup.startedRuns, 4); assert.equal(setup.unstartedRuns, 4);
  assert(Array.isArray(setup.runs) && setup.runs.length === 8, 'Every planned initial assignment is required');
  const rows = Array.from(setup.runs, (run, i) => {
    keys(run, ['label', 'pair', 'assignedArm', 'plannedCondition', 'started', 'completed', 'checkpointReached',
      'protocolConformant', 'assistanceCount', 'protocolDeviationCount', 'reportedProtocolDeviationCount', 'reportedCounts', 'grading', 'calls']);
    const pair = PAIRS[Math.floor(i / 2)];
    assert.equal(run.label, `SetupRun${String(i + 1).padStart(2, '0')}`);
    assert.equal(run.pair, pair.pair);
    assert.equal(run.assignedArm, i % 2 === 0 ? pair.firstArm : ARMS.find(arm => arm !== pair.firstArm));
    assert.equal(run.plannedCondition, pair.condition);
    assert.equal(run.started, i % 2 === 0, 'Only initial first members were started');
    assert.equal(run.completed, false); assert.equal(run.checkpointReached, false);
    triBoolean(run.protocolConformant);
    integer(run.assistanceCount, 1000); integer(run.protocolDeviationCount, 1000); integer(run.reportedProtocolDeviationCount, 1000);
    const counts = auditCalls(run.calls, run.reportedCounts);
    assert(run.started ? counts.calls > 0 : counts.calls === 0, 'Unstarted assignments cannot contain calls');
    if (!run.started) {
      assert.equal(run.protocolConformant, null); assert.equal(run.assistanceCount, 0);
      assert.equal(run.protocolDeviationCount, 0); assert.equal(run.reportedProtocolDeviationCount, 0);
    }
    if (run.assistanceCount > 0 || run.protocolDeviationCount > 0 || counts.calls > 80) assert.equal(run.protocolConformant, false);
    if (run.assistanceCount > 0 || counts.calls > 80) assert(run.protocolDeviationCount > 0);
    keys(run.grading, ['launchAttempts', 'successfulLaunches', 'submissionAttempts', 'gradedSubmissions', 'grades']);
    for (const field of ['launchAttempts', 'successfulLaunches', 'submissionAttempts', 'gradedSubmissions']) assert.equal(run.grading[field], 0);
    assert.deepEqual(run.grading.grades, []);
    return { label: run.label, pair: run.pair, assignedArm: run.assignedArm, plannedCondition: run.plannedCondition,
      started: run.started, completed: false, checkpointReached: false, ...counts,
      protocolConformant: run.protocolConformant, assistanceCount: run.assistanceCount,
      protocolDeviationCount: run.protocolDeviationCount, reportedProtocolDeviationCount: run.reportedProtocolDeviationCount,
      verbCounts: Object.fromEntries(VERBS.map(verb => [verb, run.calls.filter(call => call.verb === verb).length])) };
  });
  assert.equal(rows.filter(row => row.started).length, setup.startedRuns);
  assert.equal(rows.filter(row => !row.started).length, setup.unstartedRuns);
  return { status: 'passed', scope: 'public setup-attempt accounting only', protocolVersion: SETUP_PROTOCOL_VERSION,
    disposition: SETUP_DISPOSITION, reason: SETUP_REASON, disclosureScope: setup.disclosureScope, runs: rows,
    totals: { plannedRuns: 8, startedRuns: 4, unstartedRuns: 4, completedRuns: 0, checkpointRuns: 0,
      calls: sum(rows, 'calls'), batches: sum(rows, 'batches'), failedCalls: sum(rows, 'failedCalls'),
      assistanceCount: sum(rows, 'assistanceCount'), protocolDeviationCount: sum(rows, 'protocolDeviationCount'),
      reportedProtocolDeviationCount: sum(rows, 'reportedProtocolDeviationCount'),
      launchAttempts: 0, successfulLaunches: 0, submissionAttempts: 0, gradedSubmissions: 0, gradeCount: 0 },
    liveSignaturesIndependentlyVerified: false, privateSourceCorrespondenceIndependentlyVerified: false };
}

export function audit(evidence, procedure, initialSetup) {
  const setupAttempts = auditSetup(initialSetup);
  keys(evidence, ['schema', 'scope', 'sourceAuditPassed', 'sourceAuditScope', 'retainedCallsReconciled', 'protocol', 'runs']);
  assert.equal(evidence.schema, 'live-discovery-public-projection/v2');
  assert.equal(evidence.scope, 'unsigned-derived-records');
  assert.equal(evidence.sourceAuditPassed, true);
  assert.equal(evidence.sourceAuditScope, 'retained-evidence-and-disclosed-gaps');
  assert.equal(evidence.retainedCallsReconciled, true);
  keys(evidence.protocol, ['version', 'design', 'pairs', 'maximumInteregoCalls', 'maximumSuccessfulAssessmentLaunches', 'maximumGradedSubmissionsTotal', 'requiredGrade']);
  assert.equal(evidence.protocol.version, MAIN_PROTOCOL_VERSION);
  assert.equal(evidence.protocol.design, 'four-pair-procedure-exposure/v1');
  assert.deepEqual(evidence.protocol.pairs, PAIRS);
  assert.equal(evidence.protocol.maximumInteregoCalls, 80);
  assert.equal(evidence.protocol.maximumSuccessfulAssessmentLaunches, 1);
  assert.equal(evidence.protocol.maximumGradedSubmissionsTotal, 1);
  assert.deepEqual(evidence.protocol.requiredGrade, REQUIRED_GRADE);
  assert(Array.isArray(evidence.runs) && evidence.runs.length === 8, 'All eight runs, including incomplete runs, are required');
  const rows = evidence.runs.map((run, i) => {
    keys(run, ['label', 'pair', 'arm', 'condition', 'captureComplete', 'controllerRestarts', 'callAccountingScope',
      'completed', 'protocolConformant', 'assistanceCount', 'protocolDeviationCount',
      'reportedCounts', 'grading', 'verification', 'replay', 'calls']);
    const pair = PAIRS[Math.floor(i / 2)];
    assert.equal(run.label, `Run${String(i + 1).padStart(2, '0')}`);
    assert.equal(run.pair, pair.pair);
    assert.equal(run.condition, pair.condition);
    assert.equal(run.arm, i % 2 === 0 ? pair.firstArm : ARMS.find(arm => arm !== pair.firstArm));
    assert.equal(run.callAccountingScope, accountingScope(run.captureComplete, run.controllerRestarts));
    const exactRetainedStream = run.callAccountingScope === 'exact-retained-stream';
    triBoolean(run.completed); triBoolean(run.protocolConformant);
    integer(run.assistanceCount, 1000); integer(run.protocolDeviationCount, 1000);
    const counts = auditCalls(run.calls, run.reportedCounts);
    keys(run.grading, ['successfulLaunches', 'gradedSubmissions', 'grades']);
    nullableCount(run.grading.successfulLaunches); nullableCount(run.grading.gradedSubmissions);
    if (exactRetainedStream) {
      assert.notEqual(run.grading.successfulLaunches, null, 'Exact captures require known grading totals');
      assert.notEqual(run.grading.gradedSubmissions, null, 'Exact captures require known grading totals');
    }
    // An incomplete stream may omit the act response while private current-state
    // evidence independently establishes a launch or submission. Never synthesize it.
    if (exactRetainedStream) assert((run.grading.successfulLaunches ?? 0) + (run.grading.gradedSubmissions ?? 0)
      <= run.calls.filter(call => call.verb === 'act').length, 'Observed launches and submissions exceed retained generic act calls');
    assert(Array.isArray(run.grading.grades));
    if (run.grading.gradedSubmissions > 0 || run.grading.grades.length > 0) {
      assert.notEqual(run.grading.successfulLaunches, 0, 'Graded assessments require a successful launch');
    }
    if (exactRetainedStream) assert.equal(run.grading.grades.length, run.grading.gradedSubmissions,
      'Exact captures must retain every graded submission');
    // Partial retained grades do not establish an interrupted controller's whole-stream total.
    else if (run.grading.gradedSubmissions !== null) assert(run.grading.grades.length <= run.grading.gradedSubmissions);
    let priorAttempt = 0;
    for (const grade of run.grading.grades) {
      keys(grade, ['attempt', 'correct', 'questions', 'score']);
      integer(grade.attempt, 1000); assert(grade.attempt > priorAttempt);
      if (exactRetainedStream) assert.equal(grade.attempt, priorAttempt + 1, 'Exact capture grade attempts must be contiguous');
      if (run.grading.gradedSubmissions !== null) assert(grade.attempt <= run.grading.gradedSubmissions);
      priorAttempt = grade.attempt;
      integer(grade.correct, 1000); integer(grade.questions, 1000);
      assert(grade.questions > 0 && grade.correct <= grade.questions);
      assert(Number.isFinite(grade.score) && grade.score >= 0 && grade.score <= 1);
      assert.equal(grade.score, grade.correct / grade.questions);
    }
    keys(run.verification, VERIFICATIONS);
    Object.values(run.verification).forEach(triBoolean);
    keys(run.replay, ['complete', 'verifiedLinks', 'links']);
    triBoolean(run.replay.complete);
    nullableCount(run.replay.verifiedLinks); nullableCount(run.replay.links);
    assert.equal(run.replay.verifiedLinks === null, run.replay.links === null);
    if (run.replay.links !== null) assert(run.replay.verifiedLinks <= run.replay.links);
    if (run.replay.complete === true) assert(run.replay.links > 0 && run.replay.links === run.replay.verifiedLinks);
    if (run.completed === true) {
      assert(run.grading.grades.length > 0);
      if (run.grading.successfulLaunches === null) assert(!exactRetainedStream,
        'Unknown whole-stream launch totals require incomplete capture');
      else assert(run.grading.successfulLaunches > 0);
      assert(run.grading.grades.some(grade => grade.correct === REQUIRED_GRADE.correct && grade.questions === REQUIRED_GRADE.questions
        && grade.score === REQUIRED_GRADE.score), 'Completion requires the frozen task passing grade');
      assert.equal(run.replay.complete, true);
      for (const field of ['freshSession', 'answerCorrespondence', 'observationVerified', 'finalStateVerified', 'privateArtifactsVerified']) {
        assert.equal(run.verification[field], true, 'Completed run lacks required observed checks');
      }
      if (run.protocolConformant === true && run.condition === 'changed-binding') {
        assert.equal(run.verification.staleRejectionObserved, true);
        assert.equal(run.verification.recoveredFromStaleBinding, true);
      }
    }
    if (run.verification.frozenProcedureUseVerified === true) {
      assert.equal(run.verification.applicableProcedureDiscovered, true);
      assert.equal(run.verification.candidateDiscoveryLineageVerified, true);
    }
    if (run.verification.recoveredFromStaleBinding === true) assert.equal(run.verification.staleRejectionObserved, true);
    if (run.verification.staleRejectionObserved === true) assert(run.calls.some(call => call.verb === 'act' && call.failed),
      'Observed stale rejection requires a retained failed act');
    const budgetExceeded = counts.calls > 80 || run.grading.successfulLaunches > 1 || run.grading.gradedSubmissions > 1;
    if (run.protocolConformant === true) {
      assert.notEqual(run.grading.successfulLaunches, null);
      assert.notEqual(run.grading.gradedSubmissions, null);
    }
    if (!exactRetainedStream || budgetExceeded || run.assistanceCount > 0 || run.protocolDeviationCount > 0) {
      assert.equal(run.protocolConformant, false, 'Observed deviations must not be labeled conformant');
    }
    if (!exactRetainedStream || budgetExceeded || run.assistanceCount > 0) assert(run.protocolDeviationCount > 0);
    if (run.protocolConformant === true && run.arm === 'procedure-absent') assert.notEqual(run.verification.applicableProcedureDiscovered, true);
    return { label: run.label, pair: run.pair, arm: run.arm, condition: run.condition,
      captureComplete: run.captureComplete, controllerRestarts: run.controllerRestarts, callAccountingScope: run.callAccountingScope, ...counts,
      completed: run.completed, protocolConformant: run.protocolConformant };
  });

  keys(procedure, ['schema', 'scope', 'roles', 'steps', 'dependencies']);
  assert.equal(procedure.schema, 'live-discovery-public-procedure-structure/v1');
  assert.equal(procedure.scope, 'unsigned-structural-projection');
  assert.deepEqual(procedure.roles, ROLES);
  assert.deepEqual(procedure.steps, STEPS);
  assert.deepEqual(procedure.dependencies, EDGES);
  const paired = PAIRS.map(pair => {
    const members = rows.filter(row => row.pair === pair.pair);
    const present = members.find(row => row.arm === 'procedure-present');
    const absent = members.find(row => row.arm === 'procedure-absent');
    assert(present && absent && members.length === 2);
    const costsAvailable = members.every(row => row.callAccountingScope === 'exact-retained-stream');
    return { pair: pair.pair, condition: pair.condition,
      costComparisonScope: costsAvailable ? 'descriptive-retained-streams' : 'unavailable-capture-gap-or-restart',
      callsPresentMinusAbsent: costsAvailable ? present.calls - absent.calls : null,
      batchesPresentMinusAbsent: costsAvailable ? present.batches - absent.batches : null,
      failedCallsPresentMinusAbsent: costsAvailable ? present.failedCalls - absent.failedCalls : null,
      bothCompleted: both(present.completed, absent.completed),
      bothProtocolConformant: both(present.protocolConformant, absent.protocolConformant) };
  });
  return { status: 'passed', scope: 'public projection accounting and structure only',
    sourceAuditScope: evidence.sourceAuditScope, retainedCallsReconciled: true,
    pairedDifferenceScope: 'descriptive-only-when-both-retained-streams-are-exact', runs: rows, paired,
    totals: { callAccountingScope: rows.every(row => row.callAccountingScope === 'exact-retained-stream')
      ? 'exact-retained-stream' : 'retained-lower-bound',
      captureIncompleteRuns: rows.filter(row => !row.captureComplete).length, controllerRestarts: sum(rows, 'controllerRestarts'),
      calls: sum(rows, 'calls'), batches: sum(rows, 'batches'), failedCalls: sum(rows, 'failedCalls'),
      completedRuns: rows.filter(row => row.completed === true).length, unknownCompletionRuns: rows.filter(row => row.completed === null).length },
    procedure: { roles: ROLES.length, steps: STEPS.length, dependencies: EDGES.length }, setupAttempts,
    liveSignaturesIndependentlyVerified: false, privateSourceCorrespondenceIndependentlyVerified: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const setupOnly = process.argv[2] === '--setup-only';
    const base = resolve(process.argv[setupOnly ? 3 : 2] ?? dirname(fileURLToPath(import.meta.url)));
    const read = name => JSON.parse(readFileSync(join(base, name), 'utf8'));
    console.log(JSON.stringify(setupOnly ? auditSetup(read('public-setup-attempts.json'))
      : audit(read('public-evidence.json'), read('public-procedure.json'), read('public-setup-attempts.json')), null, 2));
  } catch {
    // Do not print rejected field values or source paths into a shareable log.
    console.error('Public projection audit failed.'); process.exitCode = 1;
  }
}
