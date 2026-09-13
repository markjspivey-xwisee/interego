/** Synthetic test inputs only. No live result fixture or private capture is committed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit, auditSetup, EDGES, PAIRS, STEPS, VERIFICATIONS } from './audit.mjs';
import { exportFiles, project, projectCall, projectSetup } from './export-public.mjs';

const CANARY = 'SYNTHETIC_PRIVATE_CANARY_DO_NOT_EXPORT';
const encoded = Buffer.from(CANARY).toString('base64');
const roles = ['workspace', 'targetCatalog', 'candidateDescriptor', 'courseDocument', 'evaluatorEntry',
  'boundIdentityAndPod', 'procedureRef', 'observationGraph', 'executionGraph'];

// Generated in memory, written only under the OS temporary directory when needed.
// The default fixture deliberately contains NO successful/completed runs.
function fixture(includeSetup = true) {
  const source = { schema: 'live-discovery-audited-source/v2', privateSourcePath: CANARY,
    audit: { status: 'passed', issues: [], runCount: 8, retainedCallsReconciled: true, pairingVerified: true,
      protocolFrozenBeforeRuns: true, procedureStructureVerified: true, privateReviewer: CANARY },
    protocol: { schema: 'interego.procedure-discovery-protocol/v1', status: 'frozen-before-measurement', version: '1.0.4',
      pairs: PAIRS.map((pair, i) => ({ id: `p${i + 1}`, condition: pair.condition, first: 'a', treatment: i % 2 === 0 ? 'a' : 'b', project: CANARY })),
      budget: { maximumInteregoCalls: 80, maximumSuccessfulAssessmentLaunches: 1, maximumGradedSubmissionsTotal: 1,
        newSessionAfterGrade: false, replacementAfterUnknownLaunchOrSubmission: false }, privateEndpoint: CANARY },
    procedure: { schema: 'discovery-trial-procedure/v1', status: 'frozen-before-measurement', version: '1.0.0', title: CANARY,
      resourceRoles: roles.map(id => ({ id, selector: CANARY })),
      operationNodes: STEPS.map(id => ({ id, label: CANARY, consumes: [CANARY], produces: [CANARY], operation: encoded })),
      dependencyEdges: EDGES.map(edge => ({ from: edge.from, to: edge.to, relation: 'requires-success', privateProof: CANARY })) },
    runs: Array.from({ length: 8 }, (_, i) => ({ pair: `p${Math.floor(i / 2) + 1}`, member: i % 2 === 0 ? 'a' : 'b',
      captureComplete: true, controllerRestarts: 0,
      identity: CANARY, sessionId: CANARY, sourcePaths: [CANARY],
      calls: [
        { call: 1, verb: 'get_descriptor', metadata: { batch: 31, purpose: CANARY, sources: [CANARY] },
          args: { url: CANARY, authorization: CANARY }, result: { body: JSON.stringify({ secret: CANARY, encoded }) } },
        { call: 2, verb: 'sign_request', metadata: { batch: 31, purpose: CANARY },
          result: { omitted: 'ephemeral signing envelope', diagnostics: { error: CANARY } } },
        { call: 3, verb: 'act', metadata: { batch: 58, purpose: CANARY }, exception: CANARY },
      ],
      callAudit: [{ call: 1, failed: false }, { call: 2, failed: false }, { call: 3, failed: true }],
      summary: { completed: false, protocolConformant: true, assistanceCount: 0, protocolDeviationCount: 0,
        reportedCounts: { calls: 3, batches: 2, failedCalls: 1, privatePath: CANARY },
        grading: { successfulLaunches: 0, gradedSubmissions: 0, grades: [], sessionId: CANARY },
        blocker: CANARY, rawGrade: CANARY },
    })) };
  if (includeSetup) source.initialSetup = setupFixture();
  return source;
}

// Deliberately synthetic sizes, unrelated to any actual retained setup trace.
function setupFixture() {
  const main = fixture(false);
  return { schema: 'live-discovery-setup-audited-source/v1', privateWorkspace: CANARY,
    protocol: { ...main.protocol, version: '1.0.3' }, plannedRuns: 8, startedRuns: 4, unstartedRuns: 4,
    disposition: 'aborted-before-pair-completion', reason: 'preflight-proof-not-discoverable',
    audit: { status: 'passed', issues: [], runCount: 8, retainedCallsComplete: true,
      assignmentsVerified: true, protocolFrozenBeforeRuns: true, preassessmentStopVerified: true,
      unstartedMembersVerified: true, setupReasonReviewed: true, disclosuresReviewed: true, privateReviewer: CANARY },
    runs: main.runs.map((run, i) => {
      const started = i % 2 === 0, pairIndex = Math.floor(i / 2);
      const calls = started ? Array.from({ length: pairIndex + 1 }, (_, index) => ({ call: index + 1,
        verb: ['get_descriptor', 'dereference', 'get_current_head'][index % 3],
        metadata: { batch: 41 + Math.floor(index / 2) * 23, purpose: CANARY, sources: [CANARY] },
        args: { url: CANARY }, result: { content: encoded, proof: CANARY } })) : [];
      const callAudit = calls.map((call, index) => ({ call: call.call, failed: pairIndex > 0 && index === calls.length - 1 }));
      return { pair: run.pair, member: run.member, started, calls, callAudit, actualIdentity: CANARY,
        summary: { completed: false, checkpointReached: false, protocolConformant: null,
          assistanceCount: 0, protocolDeviationCount: 0, reportedProtocolDeviationCount: started && pairIndex === 2 ? 1 : 0,
          reportedCounts: { calls: calls.length, batches: new Set(calls.map(call => call.metadata.batch)).size,
            failedCalls: callAudit.filter(verdict => verdict.failed).length, privatePath: CANARY },
          grading: { launchAttempts: 0, successfulLaunches: 0, submissionAttempts: 0, gradedSubmissions: 0, grades: [], session: CANARY },
          protocolDeviations: [CANARY], blocker: CANARY } };
    }) };
}
function withFiles(fn) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-publication-test-'));
  const sourceDirectory = join(root, 'private'); mkdirSync(sourceDirectory);
  const sourceFile = join(sourceDirectory, 'audited-input.json');
  const outputDirectory = join(root, 'public');
  try { return fn({ root, sourceDirectory, sourceFile, outputDirectory }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function ensureActCalls(run, count) {
  while (run.calls.filter(call => call.verb === 'act').length < count) {
    const call = run.calls.length + 1;
    run.calls.push({ call, verb: 'act', metadata: { batch: run.calls.at(-1).metadata.batch + 1 } });
    run.callAudit.push({ call, failed: false });
  }
  run.summary.reportedCounts = { calls: run.calls.length, batches: new Set(run.calls.map(call => call.metadata.batch)).size,
    failedCalls: run.callAudit.filter(call => call.failed).length };
}

test('strict projection drops raw text, encoded content, identifiers and private metadata at every depth', () => {
  const source = fixture();
  const exported = project(source);
  const text = JSON.stringify(exported);
  assert(!text.includes(CANARY)); assert(!text.includes(encoded));
  assert.deepEqual(Object.keys(exported.evidence.runs[0].calls[0]).sort(), ['batch', 'failed', 'index', 'verb']);
  assert.deepEqual(exported.evidence.runs[0].calls.map(call => call.batch), [1, 1, 2]);
  assert.equal(exported.result.totals.calls, 24);
  assert.equal(exported.result.totals.batches, 16);
  assert.equal(exported.result.totals.failedCalls, 8);
  assert.equal(exported.result.totals.completedRuns, 0);
  assert.equal(exported.result.liveSignaturesIndependentlyVerified, false);
  assert.equal(exported.result.privateSourceCorrespondenceIndependentlyVerified, false);
  assert.equal(exported.result.procedure.roles, 9);
});

test('projection never accesses raw response/signing credentials, purpose, or source-reference fields', () => {
  const record = { call: 1, verb: 'sign_request', metadata: { batch: 19 } };
  for (const key of ['result', 'args', 'exception', 'startedAt', 'finishedAt']) {
    Object.defineProperty(record, key, { get() { throw new Error('Private field was accessed'); } });
  }
  for (const key of ['purpose', 'sources']) Object.defineProperty(record.metadata, key, { get() { throw new Error('Private metadata was accessed'); } });
  assert.deepEqual(projectCall(record, { call: 1, failed: true }, 0, new Map()), { index: 1, batch: 1, verb: 'sign_request', failed: true });
});

test('unknown verbs, arbitrary batch strings and mismatched audited call verdicts fail closed', () => {
  const record = fixture().runs[0].calls[0];
  assert.throws(() => projectCall({ ...record, verb: CANARY }, { call: 1, failed: false }, 0, new Map()));
  assert.throws(() => projectCall({ ...record, metadata: { batch: CANARY } }, { call: 1, failed: false }, 0, new Map()));
  assert.throws(() => projectCall(record, { call: 2, failed: false }, 0, new Map()));
  assert.throws(() => projectCall(record, { call: 1, failed: CANARY }, 0, new Map()));
});

test('incomplete runs preserve absent observations as null and absent grades as an empty list', () => {
  const source = fixture();
  const run = source.runs[0];
  delete run.summary.completed; delete run.summary.protocolConformant;
  delete run.summary.grading.grades;
  run.calls = []; run.callAudit = []; run.summary.reportedCounts = { calls: 0, batches: 0, failedCalls: 0 };
  const exported = project(source);
  const observed = exported.evidence.runs[0];
  assert.equal(observed.completed, null); assert.equal(observed.protocolConformant, null);
  assert.deepEqual(observed.grading.grades, []);
  assert(Object.values(observed.verification).every(value => value === null));
  assert.deepEqual(observed.replay, { complete: null, verifiedLinks: null, links: null });
  assert.equal(exported.result.totals.unknownCompletionRuns, 1);
});

test('unsuccessful grades and protocol violations are retained instead of discarded', () => {
  const source = fixture();
  const run = source.runs[0];
  run.summary.grading = { successfulLaunches: 2, gradedSubmissions: 2, grades: [
    { attempt: 1, correct: 3, questions: 10, score: 0.3, answerRows: CANARY },
    { attempt: 2, correct: 7, questions: 10, score: 0.7 },
  ] };
  run.summary.protocolConformant = false; run.summary.protocolDeviationCount = 1;
  ensureActCalls(run, 4);
  const exported = project(source);
  assert.deepEqual(exported.evidence.runs[0].grading.grades.map(grade => grade.score), [0.3, 0.7]);
  assert.equal(exported.evidence.runs[0].completed, false);
  assert.equal(exported.evidence.runs[0].protocolConformant, false);
  assert(!JSON.stringify(exported).includes(CANARY));
  run.summary.protocolConformant = true;
  assert.throws(() => project(source));
});

test('a budget overrun remains visible with a recorded deviation', () => {
  const source = fixture(); const run = source.runs[0];
  run.calls = Array.from({ length: 81 }, (_, i) => ({ call: i + 1, verb: 'get_descriptor', metadata: { batch: i + 1 } }));
  run.callAudit = run.calls.map(call => ({ call: call.call, failed: false }));
  run.summary.reportedCounts = { calls: 81, batches: 81, failedCalls: 0 };
  run.summary.protocolConformant = false; run.summary.protocolDeviationCount = 1;
  assert.equal(project(source).evidence.runs[0].reportedCounts.calls, 81);
});

test('missing or duplicate run members, changed exposure assignments and altered frozen topology are rejected', () => {
  const missing = fixture(); missing.runs.pop(); assert.throws(() => project(missing));
  const duplicate = fixture(); duplicate.runs[7] = duplicate.runs[6]; assert.throws(() => project(duplicate));
  const exposure = fixture(); exposure.protocol.pairs[0].treatment = 'b'; assert.throws(() => project(exposure));
  const topology = fixture(); topology.procedure.dependencyEdges[0].to = 'S10'; assert.throws(() => project(topology));
  const role = fixture(); role.procedure.resourceRoles[0].id = CANARY; assert.throws(() => project(role));
});

test('private audit refusal, missing declarations and unreconciled retained counts stop export', () => {
  for (const field of ['retainedCallsReconciled', 'pairingVerified', 'protocolFrozenBeforeRuns', 'procedureStructureVerified']) {
    const source = fixture(); source.audit[field] = false; assert.throws(() => project(source));
  }
  const source = fixture(); source.audit.status = 'failed'; assert.throws(() => project(source));
  const call = fixture(); call.runs[0].calls[1].call = 3; assert.throws(() => project(call));
  const verdict = fixture(); verdict.runs[0].callAudit.pop(); assert.throws(() => project(verdict));
});

test('paired differences use the procedure exposure arm even when first-arm order reverses', () => {
  const source = fixture();
  const run = source.runs[2]; // P2 first run is the absent arm.
  run.calls.push({ call: 4, verb: 'get_current_head', metadata: { batch: 75 } });
  run.callAudit.push({ call: 4, failed: false });
  run.summary.reportedCounts = { calls: 4, batches: 3, failedCalls: 1 };
  const paired = project(source).result.paired;
  assert.deepEqual(paired[1], { pair: 'P2', condition: 'stable', costComparisonScope: 'descriptive-retained-streams', callsPresentMinusAbsent: -1,
    batchesPresentMinusAbsent: -1, failedCallsPresentMinusAbsent: 0, bothCompleted: false, bothProtocolConformant: true });
});

function markRecovery(run, captureComplete = false, controllerRestarts = 1) {
  run.captureComplete = captureComplete; run.controllerRestarts = controllerRestarts;
  run.summary.protocolConformant = false; run.summary.protocolDeviationCount = 1;
}

test('capture gaps and restarts independently require lower bounds and explicit nonconformance', () => {
  for (const [captureComplete, controllerRestarts] of [[true, 0], [false, 0], [true, 1], [false, 1]]) {
    const source = fixture(), run = source.runs[0], exact = captureComplete && controllerRestarts === 0;
    run.captureComplete = captureComplete; run.controllerRestarts = controllerRestarts;
    if (!exact) {
      assert.throws(() => project(source), /conformant/u);
      run.summary.protocolConformant = false;
      assert.throws(() => project(source));
      run.summary.protocolDeviationCount = 1;
    }
    const output = project(source), scope = exact ? 'exact-retained-stream' : 'retained-lower-bound';
    assert.equal(output.evidence.runs[0].callAccountingScope, scope);
    assert.equal(output.result.runs[0].callAccountingScope, scope);
    assert.equal(output.result.runs[0].captureComplete, captureComplete);
    assert.equal(output.result.runs[0].controllerRestarts, controllerRestarts);
    assert.equal(output.result.totals.callAccountingScope, scope);
    assert.equal(output.result.totals.calls, 24);
    assert.equal(output.result.totals.captureIncompleteRuns, captureComplete ? 0 : 1);
    assert.equal(output.result.totals.controllerRestarts, controllerRestarts);
    assert.equal(output.evidence.retainedCallsReconciled, true);
    assert.equal(output.evidence.sourceAuditScope, 'retained-evidence-and-disclosed-gaps');
    assert.equal(output.evidence.protocol.version, '1.0.4');
  }
});

test('either paired arm having a capture gap or restart suppresses every cost difference', () => {
  for (const affected of [0, 1, 2, 3]) {
    for (const restartOnly of [false, true]) {
      const source = fixture(); markRecovery(source.runs[affected], restartOnly, restartOnly ? 1 : 0);
      ensureActCalls(source.runs[affected], 2);
      const output = project(source), pair = output.result.paired[Math.floor(affected / 2)];
      assert.equal(pair.costComparisonScope, 'unavailable-capture-gap-or-restart');
      for (const field of ['callsPresentMinusAbsent', 'batchesPresentMinusAbsent', 'failedCallsPresentMinusAbsent']) {
        assert.equal(pair[field], null);
        assert.equal(output.result.paired[3][field], 0);
      }
      assert.equal(pair.bothProtocolConformant, false);
    }
  }
});

test('reconciled recovery retains unknown outcomes without inventing grades or exact totals', () => {
  const source = fixture(), run = source.runs[0]; markRecovery(run);
  delete run.summary.completed; delete run.summary.grading.successfulLaunches;
  delete run.summary.grading.gradedSubmissions; delete run.summary.grading.grades;
  source.runs[1].summary.completed = null;
  const output = project(source), observed = output.evidence.runs[0];
  assert.equal(observed.completed, null);
  assert.deepEqual(observed.grading, { successfulLaunches: null, gradedSubmissions: null, grades: [] });
  assert.equal(output.result.paired[0].bothCompleted, null);
  assert.equal(output.result.totals.unknownCompletionRuns, 2);
  assert.equal(output.result.totals.callAccountingScope, 'retained-lower-bound');
  const oldDeclaration = fixture(); delete oldDeclaration.audit.retainedCallsReconciled;
  oldDeclaration.audit.retainedCallsComplete = true;
  assert.throws(() => project(oldDeclaration));
  source.audit.retainedCallsReconciled = false; assert.throws(() => project(source));
});

test('recovered completed outcomes require the actual passing grade, private state and full replay', () => {
  const source = fixture(), run = source.runs[0]; markRecovery(run);
  run.summary.completed = true;
  // Synthetic private outcome facts can survive even when the act capture does not.
  run.calls = []; run.callAudit = []; run.summary.reportedCounts = { calls: 0, batches: 0, failedCalls: 0 };
  run.summary.grading = { successfulLaunches: 1, gradedSubmissions: 1,
    grades: [{ attempt: 1, correct: 10, questions: 10, score: 1, privateAnswers: CANARY }] };
  run.summary.verification = Object.fromEntries(['freshSession', 'answerCorrespondence', 'observationVerified',
    'finalStateVerified', 'privateArtifactsVerified'].map(field => [field, true]));
  run.summary.replay = { complete: true, verifiedLinks: 3, links: 3 };
  const output = project(source);
  assert.equal(output.evidence.runs[0].completed, true);
  assert.equal(output.evidence.runs[0].protocolConformant, false);
  assert.equal(output.result.paired[0].callsPresentMinusAbsent, null);
  assert(!JSON.stringify(output).includes(CANARY));
  const changes = [
    s => { s.grading.grades = []; },
    s => { s.grading.grades[0] = { attempt: 1, correct: 9, questions: 10, score: 0.9 }; },
    s => { s.grading.successfulLaunches = 0; },
    ...['freshSession', 'answerCorrespondence', 'observationVerified', 'finalStateVerified', 'privateArtifactsVerified']
      .map(field => s => { s.verification[field] = null; }),
    s => { s.replay.complete = null; },
    s => { s.replay.verifiedLinks = 2; },
  ];
  for (const change of changes) {
    const altered = structuredClone(source); change(altered.runs[0].summary);
    assert.throws(() => project(altered));
  }
});

test('actual recovered grades survive unknown whole-stream totals without converting null to zero', () => {
  const source = fixture(), run = source.runs[0]; markRecovery(run);
  run.summary.completed = true;
  run.summary.grading = { successfulLaunches: null, gradedSubmissions: null,
    grades: [{ attempt: 1, correct: 10, questions: 10, score: 1 }] };
  run.summary.verification = Object.fromEntries(['freshSession', 'answerCorrespondence', 'observationVerified',
    'finalStateVerified', 'privateArtifactsVerified'].map(field => [field, true]));
  run.summary.replay = { complete: true, verifiedLinks: 3, links: 3 };
  const output = project(source);
  assert.deepEqual(output.evidence.runs[0].grading, run.summary.grading);
  assert.equal(output.result.paired[0].callsPresentMinusAbsent, null);
  for (const field of ['successfulLaunches', 'gradedSubmissions']) {
    const contradictory = structuredClone(source); contradictory.runs[0].summary.grading[field] = 0;
    assert.throws(() => project(contradictory));
  }
  const exact = structuredClone(source); exact.runs[0].captureComplete = true; exact.runs[0].controllerRestarts = 0;
  assert.throws(() => project(exact));
  const conformant = structuredClone(source); conformant.runs[0].summary.protocolConformant = true;
  assert.throws(() => project(conformant));
});

test('recovery metadata fails closed and lower bounds do not relax retained-row reconciliation', () => {
  for (const [field, values] of [['captureComplete', [undefined, null, 0, CANARY]],
    ['controllerRestarts', [undefined, null, -1, 0.5, CANARY]]]) {
    for (const value of values) {
      const source = fixture(); source.runs[0][field] = value;
      assert.throws(() => project(source));
    }
  }
  const changes = [
    run => { run.callAccountingScope = 'exact-retained-stream'; },
    run => { run.callAccountingScope = CANARY; },
    run => { run.captureComplete = CANARY; },
    run => { run.controllerRestarts = CANARY; },
    run => { run.protocolConformant = true; },
    run => { run.protocolConformant = null; },
    run => { run.protocolDeviationCount = 0; },
    run => { run.reportedCounts.calls++; },
    run => { run.reportedCounts.batches++; },
    run => { run.reportedCounts.failedCalls++; },
    run => { run.calls[1].index = 4; },
    run => { run.totalInteregoCalls = 100; },
    run => { run.completeFreshAgentProtocol = true; },
  ];
  for (const change of changes) {
    const source = fixture(); markRecovery(source.runs[0]);
    const output = project(source); change(output.evidence.runs[0]);
    assert.throws(() => audit(output.evidence, output.procedure, output.setupAttempts));
  }
  const source = fixture(); markRecovery(source.runs[0]); source.runs[0].callAudit.pop();
  assert.throws(() => project(source));
});

test('completed outcomes require the frozen passing grade and conformant changed cases require recovery evidence', () => {
  const source = fixture(); const run = source.runs[4];
  run.summary.completed = true;
  run.summary.grading = { successfulLaunches: 1, gradedSubmissions: 1, grades: [{ attempt: 1, correct: 0, questions: 10, score: 0 }] };
  run.summary.verification = Object.fromEntries(VERIFICATIONS.map(field => [field, true]));
  run.summary.replay = { complete: true, verifiedLinks: 3, links: 3 };
  ensureActCalls(run, 2);
  assert.throws(() => project(source), /passing grade/u);
  run.summary.grading.grades[0] = { attempt: 1, correct: 10, questions: 10, score: 1 };
  assert.equal(project(source).evidence.runs[4].completed, true);
  run.summary.verification.staleRejectionObserved = null;
  run.summary.verification.recoveredFromStaleBinding = null;
  assert.throws(() => project(source));
  run.summary.protocolConformant = false; run.summary.protocolDeviationCount = 1;
  const exported = project(source);
  assert.equal(exported.evidence.runs[4].completed, true); // Actual task outcome remains visible despite a protocol deviation.
  assert.equal(exported.result.paired[2].bothProtocolConformant, false);
  exported.evidence.runs[4].grading.grades[0].privateAnswerRows = CANARY;
  assert.throws(() => audit(exported.evidence, exported.procedure, exported.setupAttempts));
});

test('public audit rejects hidden fields throughout the projection', () => {
  const paths = [
    output => output.evidence,
    output => output.evidence.protocol,
    output => output.evidence.protocol.pairs[0],
    output => output.evidence.runs[0],
    output => output.evidence.runs[0].reportedCounts,
    output => output.evidence.runs[0].grading,
    output => output.evidence.runs[0].verification,
    output => output.evidence.runs[0].replay,
    output => output.evidence.runs[0].calls[0],
    output => output.procedure,
    output => output.procedure.dependencies[0],
  ];
  for (const locate of paths) {
    const output = project(fixture()); locate(output).privateField = CANARY;
    assert.throws(() => audit(output.evidence, output.procedure, output.setupAttempts));
  }
});

test('public audit rejects count, batch, grade, label and verification tampering', () => {
  const changes = [
    run => { run.reportedCounts.calls++; },
    run => { run.reportedCounts.batches++; },
    run => { run.reportedCounts.failedCalls++; },
    run => { run.calls[0].index++; },
    run => { run.calls[0].batch = CANARY; },
    run => { run.calls[0].batch = 4; },
    run => { run.calls[2].batch = 1; },
    run => { run.calls[0].failed = CANARY; },
    run => { run.label = CANARY; },
    run => { run.arm = 'conventional-workflow'; },
    run => { run.completed = true; },
    run => { run.replay.complete = true; },
    run => { run.verification[VERIFICATIONS[0]] = CANARY; },
    run => { run.verification.recoveredFromStaleBinding = true; },
    run => { run.grading.grades = [{ attempt: 1, correct: 8, questions: 10, score: CANARY }]; },
  ];
  for (const change of changes) {
    const output = project(fixture()); change(output.evidence.runs[0]);
    assert.throws(() => audit(output.evidence, output.procedure, output.setupAttempts));
  }
});

test('noncontiguous raw batch reuse is rejected rather than relabeled into clean accounting', () => {
  const source = fixture(); source.runs[0].calls[2].metadata.batch = 1;
  assert.throws(() => project(source));
});

test('observed launches and submissions cannot exceed retained generic act calls', () => {
  const source = fixture(); const run = source.runs[0];
  run.summary.grading = { successfulLaunches: 1, gradedSubmissions: 1,
    grades: [{ attempt: 1, correct: 9, questions: 10, score: 0.9 }] };
  assert.throws(() => project(source), /exceed retained/u);
  ensureActCalls(run, 2);
  assert.equal(project(source).evidence.runs[0].grading.gradedSubmissions, 1);
});

test('every exact capture requires grading totals regardless of conformance or outcome', () => {
  for (const conformance of [false, null, true]) for (const completed of [false, null]) {
    for (const field of ['successfulLaunches', 'gradedSubmissions']) for (const omitted of [false, true]) {
      const source = fixture(), run = source.runs[0];
      run.summary.protocolConformant = conformance; run.summary.completed = completed;
      if (omitted) delete run.summary.grading[field];
      else run.summary.grading[field] = null;
      assert.throws(() => project(source), /Exact captures require known grading totals/u);
    }
  }
});

test('exact captures retain every grade even when repeated assessments violate the protocol', () => {
  const source = fixture(), run = source.runs[0];
  run.summary.protocolConformant = false; run.summary.protocolDeviationCount = 1;
  run.summary.grading = { successfulLaunches: 2, gradedSubmissions: 2, grades: [
    { attempt: 1, correct: 3, questions: 10, score: 0.3 },
    { attempt: 2, correct: 9, questions: 10, score: 0.9 },
  ] };
  ensureActCalls(run, 4);
  const output = project(source);
  assert.deepEqual(output.evidence.runs[0].grading.grades.map(grade => grade.attempt), [1, 2]);
  for (const missingAttempt of [0, 1]) {
    const incomplete = structuredClone(output);
    incomplete.evidence.runs[0].grading.grades.splice(missingAttempt, 1);
    assert.throws(() => audit(incomplete.evidence, incomplete.procedure, incomplete.setupAttempts), /retain every graded submission/u);
  }
  const gap = structuredClone(output);
  gap.evidence.runs[0].grading.grades[0].attempt = 2;
  assert.throws(() => audit(gap.evidence, gap.procedure, gap.setupAttempts));
});

test('any retained grade or graded submission contradicts a known zero successful launches', () => {
  for (const recovered of [false, true]) for (const conformance of [false, null]) {
    const source = fixture(), run = source.runs[0];
    if (recovered) markRecovery(run);
    else run.summary.protocolConformant = conformance;
    run.summary.grading = { successfulLaunches: 0, gradedSubmissions: 1,
      grades: [{ attempt: 1, correct: 9, questions: 10, score: 0.9 }] };
    assert.throws(() => project(source), /Graded assessments require a successful launch/u);
    if (recovered) {
      run.summary.grading.gradedSubmissions = null;
      assert.throws(() => project(source), /Graded assessments require a successful launch/u);
      run.summary.grading.successfulLaunches = null;
      assert.equal(project(source).evidence.runs[0].grading.grades[0].correct, 9);
    }
  }
});

test('lower-bound capture preserves a partial grade list without claiming exact completeness', () => {
  const source = fixture(), run = source.runs[0]; markRecovery(run);
  run.summary.grading = { successfulLaunches: 2, gradedSubmissions: 2,
    grades: [{ attempt: 2, correct: 9, questions: 10, score: 0.9 }] };
  const output = project(source);
  assert.equal(output.evidence.runs[0].callAccountingScope, 'retained-lower-bound');
  assert.deepEqual(output.evidence.runs[0].grading.grades.map(grade => grade.attempt), [2]);
  assert.equal(output.result.paired[0].callsPresentMinusAbsent, null);
});

test('stale rejection cannot be reported without a retained failed act', () => {
  const source = fixture(); const run = source.runs[4];
  run.summary.verification = { staleRejectionObserved: true };
  assert.equal(project(source).evidence.runs[4].verification.staleRejectionObserved, true);
  run.callAudit[2].failed = false; run.summary.reportedCounts.failedCalls = 0;
  assert.throws(() => project(source), /failed act/u);
});

test('filesystem export writes only allowlisted public files outside the private source directory', () => withFiles(paths => {
  writeFileSync(paths.sourceFile, JSON.stringify(fixture()));
  const result = exportFiles(paths.sourceFile, paths.outputDirectory);
  assert.equal(result.status, 'passed');
  assert.deepEqual(readdirSync(paths.outputDirectory).sort(), ['public-evidence.json', 'public-procedure.json', 'public-setup-attempts.json']);
  for (const name of readdirSync(paths.outputDirectory)) {
    const text = readFileSync(join(paths.outputDirectory, name), 'utf8');
    assert(!text.includes(CANARY)); assert(!text.includes(encoded));
  }
  assert.throws(() => exportFiles(paths.sourceFile, paths.outputDirectory));
  assert.throws(() => exportFiles(paths.sourceFile, join(paths.sourceDirectory, 'forbidden')));
  const alias = join(paths.root, 'private-alias'); symlinkSync(paths.sourceDirectory, alias, 'junction');
  assert.throws(() => exportFiles(paths.sourceFile, join(alias, 'forbidden')));
}));

test('CLI refusal does not print private fields, source paths, or stack traces', () => withFiles(paths => {
  writeFileSync(paths.sourceFile, JSON.stringify({ schema: CANARY, nested: { credential: CANARY } }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./export-public.mjs', import.meta.url)), paths.sourceFile, paths.outputDirectory], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert(!result.stderr.includes(CANARY)); assert(!result.stderr.includes(paths.sourceFile));
  assert.equal(result.stderr.trim(), 'Public export refused; validate the private audit inputs locally.');
}));

test('initial setup preserves all planned assignments, exact recorded costs and zero-failure stops', () => {
  const source = setupFixture(); source.runs.reverse();
  const output = projectSetup(source), publicRows = output.setupAttempts.runs;
  assert.equal(publicRows.length, 8);
  assert.deepEqual(publicRows.map(run => run.started), [true, false, true, false, true, false, true, false]);
  assert.deepEqual(publicRows.map(run => run.reportedCounts.calls), [1, 0, 2, 0, 3, 0, 4, 0]);
  assert.deepEqual(publicRows.map(run => run.reportedCounts.batches), [1, 0, 1, 0, 2, 0, 2, 0]);
  assert.deepEqual(publicRows.map(run => run.reportedCounts.failedCalls), [0, 0, 1, 0, 1, 0, 1, 0]);
  assert(publicRows.every(run => run.completed === false && run.checkpointReached === false && run.grading.grades.length === 0));
  assert.equal(output.result.totals.calls, 10); assert.equal(output.result.totals.batches, 6);
  assert.equal(output.result.totals.failedCalls, 3); assert.equal(output.result.totals.unstartedRuns, 4);
  assert.equal(output.result.totals.completedRuns, 0); assert.equal(output.result.totals.gradeCount, 0);
  for (const row of output.result.runs) assert.equal(Object.values(row.verbCounts).reduce((a, b) => a + b, 0), row.calls);
  assert(!('paired' in output.result));
  assert.equal(output.result.liveSignaturesIndependentlyVerified, false);
  assert.equal(output.result.privateSourceCorrespondenceIndependentlyVerified, false);
  assert(!JSON.stringify(output).includes(CANARY)); assert(!JSON.stringify(output).includes(encoded));
});

test('setup refuses missing or conflicting zero-only observations instead of overwriting them', () => {
  const changes = [
    source => { source.runs[0].summary.completed = true; },
    source => { delete source.runs[0].summary.completed; },
    source => { source.runs[0].summary.checkpointReached = true; },
    source => { delete source.runs[0].summary.checkpointReached; },
    source => { source.runs[0].summary.grading.grades = [{ score: 0.3 }]; },
    source => { delete source.runs[0].summary.grading.grades; },
    ...['launchAttempts', 'successfulLaunches', 'submissionAttempts', 'gradedSubmissions'].flatMap(field => [
      source => { source.runs[0].summary.grading[field] = 1; },
      source => { delete source.runs[0].summary.grading[field]; },
    ]),
  ];
  for (const change of changes) {
    const source = setupFixture(); change(source);
    assert.throws(() => projectSetup(source));
  }
});

test('initial setup requires its separate private audit, fixed cohort and retained call accounting', () => {
  const changes = [
    source => { source.audit.status = 'draft'; },
    ...['retainedCallsComplete', 'assignmentsVerified', 'protocolFrozenBeforeRuns', 'preassessmentStopVerified',
      'unstartedMembersVerified', 'setupReasonReviewed', 'disclosuresReviewed'].map(field => source => { delete source.audit[field]; }),
    source => { source.protocol.version = '1.0.4'; },
    source => { source.reason = CANARY; },
    source => { source.disposition = 'complete'; },
    source => { source.startedRuns = 8; },
    source => { source.runs.pop(); },
    source => { source.runs[7] = source.runs[6]; },
    source => { source.runs[0].started = false; },
    source => { source.runs[1].started = true; },
    source => { source.runs[1].calls = source.runs[0].calls; source.runs[1].callAudit = source.runs[0].callAudit; },
    source => { source.runs[0].calls = []; source.runs[0].callAudit = []; },
    source => { source.runs[0].summary.reportedCounts.calls = 0; },
    source => { source.runs[2].summary.reportedCounts.failedCalls = 0; },
    source => { source.runs[4].calls[2].metadata.batch = 1; },
    source => { source.runs[0].callAudit[0].failed = null; },
    source => { source.runs[0].callAudit[0].call = 2; },
  ];
  for (const change of changes) {
    const source = setupFixture(); change(source);
    assert.throws(() => projectSetup(source));
  }
});

test('setup preserves agent disclosure counters separately from reviewed protocol classification', () => {
  const source = setupFixture(), run = source.runs[4];
  run.summary.protocolConformant = true;
  let output = projectSetup(source);
  assert.equal(output.setupAttempts.runs[4].reportedProtocolDeviationCount, 1);
  assert.equal(output.setupAttempts.runs[4].protocolDeviationCount, 0);
  assert.equal(output.result.disclosureScope, 'retained-records-and-agent-self-disclosure');
  run.summary.protocolDeviationCount = 1;
  assert.throws(() => projectSetup(source));
  run.summary.protocolConformant = false; run.summary.assistanceCount = 1;
  output = projectSetup(source);
  assert.equal(output.result.totals.reportedProtocolDeviationCount, 1);
  assert.equal(output.result.totals.protocolDeviationCount, 1); assert.equal(output.result.totals.assistanceCount, 1);
  source.runs[1].summary.protocolConformant = true;
  assert.throws(() => projectSetup(source));
});

test('main protocol 1.0.4 requires initial 1.0.3 history without pooling its costs', () => {
  const source = fixture(), output = project(source);
  assert.equal(output.evidence.protocol.version, '1.0.4');
  assert.equal(output.setupAttempts.protocol.version, '1.0.3');
  assert.equal(output.result.totals.calls, 24); assert.equal(output.result.setupAttempts.totals.calls, 10);
  assert.throws(() => audit(output.evidence, output.procedure));
  delete source.initialSetup;
  assert.throws(() => project(source));
  const oldVersion = fixture(); oldVersion.protocol.version = '1.0.3';
  assert.throws(() => project(oldVersion));
});

test('every setup public leaf rejects private string substitution and every object rejects extra fields', () => {
  const original = projectSetup(setupFixture()).setupAttempts;
  const leaves = [], objects = [];
  function visit(value, path = []) {
    if (value && typeof value === 'object') {
      if (!Array.isArray(value)) objects.push(path);
      for (const key of Object.keys(value)) visit(value[key], [...path, key]);
    } else leaves.push(path);
  }
  visit(original);
  for (const path of leaves) {
    const output = structuredClone(original);
    let parent = output; for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = CANARY;
    assert.throws(() => auditSetup(output));
  }
  for (const path of objects) {
    const output = structuredClone(original);
    let parent = output; for (const key of path) parent = parent[key];
    parent.privateProof = encoded;
    assert.throws(() => auditSetup(output));
  }
});

test('sparse recorded calls or grades cannot conceal missing retained evidence', () => {
  const setup = setupFixture(); delete setup.runs[0].calls[0]; assert.throws(() => projectSetup(setup));
  const publicSetup = projectSetup(setupFixture()).setupAttempts;
  delete publicSetup.runs[0].calls[0]; assert.throws(() => auditSetup(publicSetup));
  const main = fixture(); delete main.runs[0].calls[0]; assert.throws(() => project(main));
  const output = project(fixture()), run = output.evidence.runs[0];
  run.grading.gradedSubmissions = 1; run.grading.grades = new Array(1);
  assert.throws(() => audit(output.evidence, output.procedure, output.setupAttempts));
});

test('standalone setup export writes one safe file and cannot be mistaken for main results', () => withFiles(paths => {
  writeFileSync(paths.sourceFile, JSON.stringify(setupFixture()));
  const result = exportFiles(paths.sourceFile, paths.outputDirectory);
  assert.equal(result.totals.startedRuns, 4);
  assert.deepEqual(readdirSync(paths.outputDirectory), ['public-setup-attempts.json']);
  const text = readFileSync(join(paths.outputDirectory, 'public-setup-attempts.json'), 'utf8');
  assert(!text.includes(CANARY)); assert(!text.includes(encoded));
  const command = fileURLToPath(new URL('./audit.mjs', import.meta.url));
  const setupAudit = spawnSync(process.execPath, [command, '--setup-only', paths.outputDirectory], { encoding: 'utf8' });
  assert.equal(setupAudit.status, 0); assert.equal(JSON.parse(setupAudit.stdout).totals.unstartedRuns, 4);
  const mainAudit = spawnSync(process.execPath, [command, paths.outputDirectory], { encoding: 'utf8' });
  assert.equal(mainAudit.status, 1); assert.equal(mainAudit.stdout, '');
  assert.equal(mainAudit.stderr.trim(), 'Public projection audit failed.');
}));
