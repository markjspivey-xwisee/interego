/** Offline checks of an unsigned public projection; no live or signature verification. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CASES = ['acquisition', 'linked-stable', 'conventional-stable', 'linked-rebind', 'conventional-rebind'];
export const TOOLS = ['dereference', 'get_descriptor', 'get_current_head', 'sign_request', 'act', 'publish_context'];
export const STEPS = Array.from({ length: 10 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
export const LABELS = ['Read seeded entry and frozen procedure', 'Resolve live target authority and controls',
  'Read frozen policy and live evaluator guidance', 'Launch one live assessment',
  'Apply policy and submit once for server grade', 'Attest and verify the live observation',
  'Accept current assessment evidence', 'Activate the isolated test release',
  'Verify final state and full replay', 'Publish procedure-linked execution evidence'];
export const keys = (value, expected) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected public fields');
};
export const integer = (value, max = 100000000) => {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= max, 'Invalid public integer');
  return value;
};
const boolean = value => assert.equal(typeof value, 'boolean');
const sum = (items, field) => items.reduce((n, item) => n + item[field], 0);

export function audit(evidence, procedures) {
  keys(evidence, ['schema', 'scope', 'sourceArchiveSha256', 'sourceArchiveFiles', 'sourceAuditPassed', 'cases']);
  assert.equal(evidence.schema, 'live-transfer-public-projection/v1');
  assert.equal(evidence.scope, 'unsigned-derived-records');
  assert.match(evidence.sourceArchiveSha256, /^[a-f0-9]{64}$/u);
  integer(evidence.sourceArchiveFiles, 1000);
  boolean(evidence.sourceAuditPassed);
  assert.equal(evidence.sourceAuditPassed, true);
  assert(Array.isArray(evidence.cases));
  assert.deepEqual(evidence.cases.map(c => c.caseName), CASES);
  const results = evidence.cases.map(c => {
    keys(c, ['caseName', 'calls', 'reportedCounts', 'reportedGrading', 'reportedReplay', 'recordedAssistanceCount']);
    integer(c.recordedAssistanceCount, 100);
    keys(c.reportedCounts, ['calls', 'batches', 'capturedOutputBytes', 'failures', 'reportTailCalls']);
    Object.values(c.reportedCounts).forEach(v => integer(v));
    keys(c.reportedGrading, ['launches', 'attempts', 'correct', 'questions', 'score', 'answerCorrespondence']);
    for (const f of ['launches', 'attempts', 'correct', 'questions']) integer(c.reportedGrading[f], 1000);
    assert(Number.isFinite(c.reportedGrading.score) && c.reportedGrading.score >= 0 && c.reportedGrading.score <= 1);
    boolean(c.reportedGrading.answerCorrespondence);
    assert(c.reportedGrading.correct <= c.reportedGrading.questions);
    assert(c.reportedGrading.questions > 0);
    assert.equal(c.reportedGrading.score, c.reportedGrading.correct / c.reportedGrading.questions);
    keys(c.reportedReplay, ['complete', 'verifiedLinks', 'chainLength']);
    boolean(c.reportedReplay.complete);
    integer(c.reportedReplay.verifiedLinks, 1000); integer(c.reportedReplay.chainLength, 1000);
    assert(c.reportedReplay.verifiedLinks <= c.reportedReplay.chainLength);
    assert(Array.isArray(c.calls) && c.calls.length > 0 && c.calls.length <= 1000);
    const batches = new Set();
    c.calls.forEach((call, i) => {
      keys(call, ['index', 'batch', 'tool', 'steps', 'capturedOutputBytes', 'recordedFailure', 'failureCategory']);
      assert.equal(call.index, i + 1);
      integer(call.batch, 1000); assert(call.batch > 0);
      if (!batches.has(call.batch)) assert.equal(call.batch, batches.size + 1, 'Batch aliases must follow first occurrence');
      batches.add(call.batch);
      assert(TOOLS.includes(call.tool), 'Unknown tool');
      assert(Array.isArray(call.steps) && call.steps.every(s => STEPS.includes(s)));
      assert.equal(new Set(call.steps).size, call.steps.length);
      integer(call.capturedOutputBytes);
      boolean(call.recordedFailure);
      assert(['none', 'discovery-or-dispatch', 'authority-changed', 'other-generic-failure'].includes(call.failureCategory));
      assert.equal(call.recordedFailure, call.failureCategory !== 'none');
    });
    const row = { caseName: c.caseName, calls: c.calls.length, batches: batches.size,
      capturedOutputBytes: sum(c.calls, 'capturedOutputBytes'), failures: c.calls.filter(x => x.recordedFailure).length,
      reportTailCalls: c.calls.slice(-3).length };
    assert.deepEqual(c.reportedCounts, Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'caseName')));
    assert.deepEqual(c.calls.slice(-3).map(x => x.tool).sort(), ['get_current_head', 'get_descriptor', 'publish_context']);
    return row;
  });

  keys(procedures, ['schema', 'scope', 'resourceRoleCount', 'workflow', 'linked']);
  assert.equal(procedures.schema, 'live-transfer-public-procedure-structure/v1');
  assert.equal(procedures.scope, 'unsigned-structural-projection');
  integer(procedures.resourceRoleCount, 100);
  assert(Array.isArray(procedures.workflow));
  assert.deepEqual(procedures.workflow.map(s => s.id), STEPS);
  const derivedEdges = [];
  procedures.workflow.forEach((step, i) => {
    keys(step, ['id', 'name', 'dependsOn']); assert.equal(step.name, LABELS[i]);
    assert(Array.isArray(step.dependsOn));
    assert.equal(new Set(step.dependsOn).size, step.dependsOn.length);
    for (const from of step.dependsOn) {
      assert(STEPS.indexOf(from) >= 0 && STEPS.indexOf(from) < i, 'Invalid dependency');
      derivedEdges.push({ from, to: step.id });
    }
  });
  keys(procedures.linked, ['nodes', 'edges']);
  assert.deepEqual(procedures.linked.nodes, procedures.workflow.map(s => ({ id: s.id, name: s.name })));
  const order = edges => [...edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
  assert.deepEqual(order(procedures.linked.edges), order(derivedEdges));
  assert.equal(derivedEdges.length, 11); assert.equal(procedures.resourceRoleCount, 8);
  return { status: 'passed', scope: 'public projection arithmetic and structure only', cases: results,
    transferCalls: sum(results.slice(1), 'calls'), transferRecordedBatches: sum(results.slice(1), 'batches'),
    steps: STEPS.length, dependencies: derivedEdges.length,
    liveSignaturesIndependentlyVerified: false, privateSourceCorrespondenceIndependentlyVerified: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = dirname(fileURLToPath(import.meta.url));
  const read = name => JSON.parse(readFileSync(join(base, name), 'utf8'));
  console.log(JSON.stringify(audit(read('public-evidence.json'), read('public-procedures.json')), null, 2));
}
