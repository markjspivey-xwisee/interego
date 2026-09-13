/**
 * Trusted private input schema (produced only AFTER independent private audit):
 * {
 *   schema: 'live-discovery-audited-source/v2', protocol: frozenProtocol1_0_4,
 *   initialSetup: separatelyAuditedSetupSourceDescribedBelow,
 *   procedure: frozenDiscoveryProcedure,
 *   audit: {status:'passed',issues:[],runCount:8,retainedCallsReconciled:true,
 *     pairingVerified:true,protocolFrozenBeforeRuns:true,procedureStructureVerified:true},
 *   runs: [{pair:'p1'..'p4', member:'a'|'b', captureComplete:boolean,
 *     controllerRestarts:integer, calls:retainedRecorderRecords,
 *     callAudit:[{call:1,failed:false}, ...],
 *     summary:{completed:boolean|null,protocolConformant:boolean|null,
 *       assistanceCount:integer,protocolDeviationCount:integer,
 *       reportedCounts:{calls,batches,failedCalls},
 *       grading:{successfulLaunches,gradedSubmissions,grades:[{attempt,correct,questions,score}]},
 *       verification:{<fields exported from VERIFICATIONS>:boolean|null},
 *       replay:{complete:boolean|null,verifiedLinks:integer|null,links:integer|null}}
 *   }]
 * }
 * Missing verification/completion/replay observations become null; missing grades
 * become an empty list, never an invented passing grade. All eight runs are retained.
 * Extra PRIVATE fields are ignored. Public output fields are constructed afresh.
 * The audit declarations are recorded assertions, not independently checked proofs.
 * retainedCallsReconciled means available retained records were reconciled against
 * available final capture/restored-store records. It never proves that the original
 * controller captured every external call. captureComplete must stay false when its
 * final capture was lost, even if a later restored recorder was fully reconciled.
 * A restarted controller is a continuation of its logical case, not a fresh member.
 * Incomplete capture OR any restart makes retained costs lower bounds, suppresses
 * paired cost differences, and requires explicit nonconformance and a deviation.
 * This is a reporting schema change only; frozen protocol 1.0.4 is not amended.
 * Signing envelopes are absent from the recorder: NO response byte-size claim is made.
 * This module neither performs the private audit nor executes source code/network calls.
 *
 * Separate INITIAL 1.0.3 setup input contract, also accepted by the CLI on its own:
 * {schema:'live-discovery-setup-audited-source/v1',protocol:frozenProtocol1_0_3,
 *  plannedRuns:8,startedRuns:4,unstartedRuns:4,
 *  disposition:'aborted-before-pair-completion',reason:'preflight-proof-not-discoverable',
 *  audit:{status:'passed',issues:[],runCount:8,retainedCallsComplete:true,
 *    assignmentsVerified:true,protocolFrozenBeforeRuns:true,preassessmentStopVerified:true,
 *    unstartedMembersVerified:true,setupReasonReviewed:true,disclosuresReviewed:true},
 *  runs:[{pair:'p1'..'p4',member:'a'|'b',started:boolean,calls:retainedRecorderRecords,
 *    callAudit:[{call:1,failed:boolean},...],summary:{completed:false,checkpointReached:false,
 *      protocolConformant:boolean|null,assistanceCount:integer,protocolDeviationCount:integer,
 *      reportedProtocolDeviationCount:integer,reportedCounts:{calls,batches,failedCalls},
 *      grading:{launchAttempts:0,successfulLaunches:0,submissionAttempts:0,gradedSubmissions:0,grades:[]}}}]}
 * All eight assignments are required. Initial a members started; b members did not.
 * Unstarted members have no calls, null conformance and zero counters. Reviewed
 * deviation counts do not erase the separate agent-reported disclosure count.
 * Missing/conflicting outcome data is refused, never changed into zero or false.
 * Setup audit declarations mean retained-record accounting and reviewed disclosures;
 * they are not technical proof of undisclosed behavior, signatures or ACL isolation.
 * Main exports require this separate setup history and write three public files.
 * Standalone setup export writes only public-setup-attempts.json; validate it with
 * `node audit.mjs --setup-only OUTPUT_DIRECTORY`. No initial paired estimate is made.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountingScope, audit, auditSetup, EDGES, MAIN_PROTOCOL_VERSION, PAIRS, REQUIRED_GRADE, ROLES,
  SETUP_DISPOSITION, SETUP_PROTOCOL_VERSION, SETUP_REASON, STEPS, VERBS, VERIFICATIONS, integer, triBoolean } from './audit.mjs';

const SOURCE_ROLES = ['workspace', 'targetCatalog', 'candidateDescriptor', 'courseDocument', 'evaluatorEntry',
  'boundIdentityAndPod', 'procedureRef', 'observationGraph', 'executionGraph'];
const optionalBoolean = value => triBoolean(value === undefined ? null : value);
const optionalCount = value => value === undefined || value === null ? null : integer(value, 1000);
const bool = value => { assert.equal(typeof value, 'boolean', 'Audited call verdict is required'); return value; };

export function projectCall(record, verdict, index, batches) {
  assert.equal(record.call, index + 1, 'Retained source call indices must be sequential');
  assert.equal(verdict.call, record.call, 'Audit verdict must identify the same call');
  assert(VERBS.includes(record.verb), 'Unknown source verb');
  const rawBatch = integer(record.metadata?.batch, 1000000);
  assert(rawBatch > 0, 'Source batch must be positive');
  if (!batches.has(rawBatch)) batches.set(rawBatch, batches.size + 1);
  // Never inspect result, exception, arguments, purpose, source lineage, timestamps,
  // or signing diagnostics here. Their meaning was checked in the PRIVATE audit.
  return { index: index + 1, batch: batches.get(rawBatch), verb: record.verb, failed: bool(verdict.failed) };
}

function validateProtocol(protocol, version) {
  assert.equal(protocol.schema, 'interego.procedure-discovery-protocol/v1');
  assert.equal(protocol.status, 'frozen-before-measurement');
  assert.equal(protocol.version, version);
  assert(Array.isArray(protocol.pairs) && protocol.pairs.length === 4);
  protocol.pairs.forEach((pair, i) => {
    assert.equal(pair.id, `p${i + 1}`); assert.equal(pair.condition, PAIRS[i].condition); assert.equal(pair.first, 'a');
    assert.equal(pair.treatment, i % 2 === 0 ? 'a' : 'b');
  });
  assert.equal(protocol.budget.maximumInteregoCalls, 80);
  assert.equal(protocol.budget.maximumSuccessfulAssessmentLaunches, 1);
  assert.equal(protocol.budget.maximumGradedSubmissionsTotal, 1);
  assert.equal(protocol.budget.newSessionAfterGrade, false);
  assert.equal(protocol.budget.replacementAfterUnknownLaunchOrSubmission, false);
}

function indexedRuns(runs) {
  assert(Array.isArray(runs) && runs.length === 8);
  const byRun = new Map();
  for (const run of runs) {
    assert(['p1', 'p2', 'p3', 'p4'].includes(run.pair) && ['a', 'b'].includes(run.member), 'Unknown run assignment');
    const key = run.pair + run.member; assert(!byRun.has(key), 'Duplicate run assignment'); byRun.set(key, run);
  }
  return byRun;
}

function projectCalls(run) {
  assert(Array.isArray(run.calls) && run.calls.length <= 1000);
  assert(Array.isArray(run.callAudit) && run.callAudit.length === run.calls.length);
  const batches = new Map();
  let lastRawBatch = 0;
  return Array.from(run.calls, (record, index) => {
    assert(record.metadata?.batch >= lastRawBatch, 'Noncontiguous source batches'); lastRawBatch = record.metadata.batch;
    return projectCall(record, run.callAudit[index], index, batches);
  });
}

function projectCounts(counts) {
  return { calls: integer(counts.calls, 1000), batches: integer(counts.batches, 1000), failedCalls: integer(counts.failedCalls, 1000) };
}

export function projectSetup(source) {
  assert.equal(source.schema, 'live-discovery-setup-audited-source/v1');
  assert.equal(source.audit?.status, 'passed', 'Separate private setup audit must pass first');
  assert.deepEqual(source.audit.issues, []); assert.equal(source.audit.runCount, 8);
  for (const field of ['retainedCallsComplete', 'assignmentsVerified', 'protocolFrozenBeforeRuns',
    'preassessmentStopVerified', 'unstartedMembersVerified', 'setupReasonReviewed', 'disclosuresReviewed']) {
    assert.equal(source.audit[field], true, 'Required private setup audit declaration is absent');
  }
  validateProtocol(source.protocol, SETUP_PROTOCOL_VERSION);
  assert.equal(source.plannedRuns, 8); assert.equal(source.startedRuns, 4); assert.equal(source.unstartedRuns, 4);
  assert.equal(source.disposition, SETUP_DISPOSITION); assert.equal(source.reason, SETUP_REASON);
  const byRun = indexedRuns(source.runs);
  const runs = Array.from({ length: 8 }, (_, i) => {
    const pairIndex = Math.floor(i / 2), member = i % 2 === 0 ? 'a' : 'b';
    const run = byRun.get(`p${pairIndex + 1}${member}`); assert(run, 'Missing initial assignment');
    assert.equal(run.started, member === 'a');
    const calls = projectCalls(run), s = run.summary;
    assert(s && typeof s === 'object');
    assert.equal(s.completed, false); assert.equal(s.checkpointReached, false);
    assert(s.grading, 'Audited preassessment totals are required');
    for (const field of ['launchAttempts', 'successfulLaunches', 'submissionAttempts', 'gradedSubmissions']) assert.equal(s.grading[field], 0);
    assert.deepEqual(s.grading.grades, []);
    return { label: `SetupRun${String(i + 1).padStart(2, '0')}`, pair: PAIRS[pairIndex].pair,
      assignedArm: member === source.protocol.pairs[pairIndex].treatment ? 'procedure-present' : 'procedure-absent',
      plannedCondition: PAIRS[pairIndex].condition, started: run.started, completed: false, checkpointReached: false,
      protocolConformant: triBoolean(s.protocolConformant), assistanceCount: integer(s.assistanceCount, 1000),
      protocolDeviationCount: integer(s.protocolDeviationCount, 1000), reportedProtocolDeviationCount: integer(s.reportedProtocolDeviationCount, 1000),
      reportedCounts: projectCounts(s.reportedCounts),
      grading: { launchAttempts: 0, successfulLaunches: 0, submissionAttempts: 0, gradedSubmissions: 0, grades: [] }, calls };
  });
  const setupAttempts = { schema: 'live-discovery-public-setup-attempts/v1', scope: 'unsigned-derived-incomplete-setup-records',
    sourceAuditPassed: true, disclosureScope: 'retained-records-and-agent-self-disclosure',
    protocol: { version: SETUP_PROTOCOL_VERSION, design: 'four-pair-procedure-exposure/v1', plannedPairs: PAIRS.map(pair => ({ ...pair })) },
    disposition: SETUP_DISPOSITION, reason: SETUP_REASON, plannedRuns: 8, startedRuns: 4, unstartedRuns: 4, runs };
  return { setupAttempts, result: auditSetup(setupAttempts) };
}

export function project(source) {
  assert.equal(source.schema, 'live-discovery-audited-source/v2');
  assert.equal(source.audit?.status, 'passed', 'Private audit must pass first');
  assert.deepEqual(source.audit.issues, []);
  assert.equal(source.audit.runCount, 8);
  for (const field of ['retainedCallsReconciled', 'pairingVerified', 'protocolFrozenBeforeRuns', 'procedureStructureVerified']) {
    assert.equal(source.audit[field], true, 'Required private audit declaration is absent');
  }
  const protocol = source.protocol;
  validateProtocol(protocol, MAIN_PROTOCOL_VERSION);
  const setupAttempts = projectSetup(source.initialSetup).setupAttempts;
  const method = source.procedure;
  assert.equal(method.schema, 'discovery-trial-procedure/v1');
  assert.equal(method.status, 'frozen-before-measurement'); assert.equal(method.version, '1.0.0');
  assert(Array.isArray(method.resourceRoles));
  assert.deepEqual(method.resourceRoles.map(role => role.id), SOURCE_ROLES);
  assert(Array.isArray(method.operationNodes));
  assert.deepEqual(method.operationNodes.map(step => step.id), STEPS);
  assert(Array.isArray(method.dependencyEdges) && method.dependencyEdges.length === EDGES.length);
  method.dependencyEdges.forEach((edge, i) => {
    assert.equal(edge.from, EDGES[i].from); assert.equal(edge.to, EDGES[i].to); assert.equal(edge.relation, 'requires-success');
  });
  const procedure = { schema: 'live-discovery-public-procedure-structure/v1', scope: 'unsigned-structural-projection',
    roles: [...ROLES], steps: [...STEPS], dependencies: EDGES.map(edge => ({ ...edge })) };
  const byRun = indexedRuns(source.runs);
  const runs = Array.from({ length: 8 }, (_, i) => {
    const pairIndex = Math.floor(i / 2), member = i % 2 === 0 ? 'a' : 'b';
    const run = byRun.get(`p${pairIndex + 1}${member}`); assert(run, 'Missing assigned run');
    const callAccountingScope = accountingScope(run.captureComplete, run.controllerRestarts);
    const calls = projectCalls(run);
    const s = run.summary; assert(s && typeof s === 'object');
    assert(s.reportedCounts && s.grading, 'Audited counts and submission totals are required');
    const grades = s.grading.grades ?? []; assert(Array.isArray(grades));
    return { label: `Run${String(i + 1).padStart(2, '0')}`, pair: PAIRS[pairIndex].pair,
      arm: member === protocol.pairs[pairIndex].treatment ? 'procedure-present' : 'procedure-absent', condition: PAIRS[pairIndex].condition,
      captureComplete: run.captureComplete, controllerRestarts: run.controllerRestarts, callAccountingScope,
      completed: optionalBoolean(s.completed), protocolConformant: optionalBoolean(s.protocolConformant),
      assistanceCount: integer(s.assistanceCount, 1000), protocolDeviationCount: integer(s.protocolDeviationCount, 1000),
      reportedCounts: projectCounts(s.reportedCounts),
      grading: { successfulLaunches: optionalCount(s.grading.successfulLaunches), gradedSubmissions: optionalCount(s.grading.gradedSubmissions),
        grades: Array.from(grades, grade => ({ attempt: integer(grade.attempt, 1000), correct: integer(grade.correct, 1000), questions: integer(grade.questions, 1000), score: grade.score })) },
      verification: Object.fromEntries(VERIFICATIONS.map(field => [field, optionalBoolean(s.verification?.[field])])),
      replay: { complete: optionalBoolean(s.replay?.complete), verifiedLinks: optionalCount(s.replay?.verifiedLinks), links: optionalCount(s.replay?.links) }, calls };
  });
  const evidence = { schema: 'live-discovery-public-projection/v2', scope: 'unsigned-derived-records', sourceAuditPassed: true,
    sourceAuditScope: 'retained-evidence-and-disclosed-gaps', retainedCallsReconciled: true,
    protocol: { version: MAIN_PROTOCOL_VERSION, design: 'four-pair-procedure-exposure/v1', pairs: PAIRS.map(pair => ({ ...pair })),
      maximumInteregoCalls: 80, maximumSuccessfulAssessmentLaunches: 1, maximumGradedSubmissionsTotal: 1, requiredGrade: { ...REQUIRED_GRADE } }, runs };
  return { evidence, procedure, setupAttempts, result: audit(evidence, procedure, setupAttempts) };
}

export function exportFiles(sourceFile, outputDirectory) {
  const sourcePath = realpathSync(sourceFile);
  const requested = resolve(outputDirectory);
  assert(!existsSync(requested), 'Output directory must not already exist');
  const output = join(realpathSync(dirname(requested)), basename(requested));
  const within = relative(dirname(sourcePath), output);
  assert(within === '..' || within.startsWith('..' + sep) || isAbsolute(within), 'Output must be outside private source directory');
  const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const exported = source.schema === 'live-discovery-setup-audited-source/v1' ? projectSetup(source) : project(source);
  mkdirSync(output);
  const files = exported.evidence ? [['public-evidence.json', exported.evidence], ['public-procedure.json', exported.procedure],
    ['public-setup-attempts.json', exported.setupAttempts]] : [['public-setup-attempts.json', exported.setupAttempts]];
  for (const [name, value] of files) {
    writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  return exported.result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [source, output] = process.argv.slice(2);
    assert(source && output && process.argv.length === 4);
    console.log(JSON.stringify(exportFiles(source, output), null, 2));
  } catch {
    console.error('Public export refused; validate the private audit inputs locally.'); process.exitCode = 1;
  }
}
