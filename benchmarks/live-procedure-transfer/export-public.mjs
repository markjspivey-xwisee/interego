/** Run only on trusted original captures. No network; raw inputs are never copied. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { audit, CASES, TOOLS, STEPS, LABELS, integer } from './audit.mjs';

const TRACE_PATHS = ['acquisition-trace.json', 'linked-stable/trace.json', 'conventional-stable/trace.json',
  'linked-rebind/trace-final.json', 'conventional-rebind/trace.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const requiredBoolean = value => { assert.equal(typeof value, 'boolean'); return value; };

export function projectCall(record, index, batches, failed) {
  const tool = record.tool.replace(/^.*interego_railway_/u, '');
  assert(TOOLS.includes(tool), 'Unknown source tool');
  const batch = record.modelDecisionBatchId ?? record.batchId;
  assert(typeof batch === 'string' || Number.isSafeInteger(batch), 'Missing source batch');
  if (!batches.has(batch)) batches.set(batch, batches.size + 1);
  const declared = record.procedureStepIds ?? [record.procedureStepId ?? record.stepId].filter(Boolean);
  const steps = [...new Set(declared.filter(s => STEPS.includes(s)))];
  const output = record.output ?? record.response ?? record.result;
  const serialized = JSON.stringify(output); assert.equal(typeof serialized, 'string');
  const failureCategory = !failed ? 'none'
    : /application authority changed before submission/u.test(failed.errorText ?? '') ? 'authority-changed'
      : index.caseName === 'acquisition' ? 'discovery-or-dispatch' : 'other-generic-failure';
  return { index: integer(index.number, 1000), batch: batches.get(batch), tool, steps,
    capturedOutputBytes: Buffer.byteLength(serialized, 'utf8'), recordedFailure: Boolean(failed), failureCategory };
}

export function project(source, sourceAudit) {
  const read = name => JSON.parse(readFileSync(join(source, name), 'utf8'));
  assert.equal(sourceAudit.status, 'passed', 'Private source audit must pass');
  assert.equal(sourceAudit.procedures.status, 'passed'); assert.deepEqual(sourceAudit.issues, []);
  assert.deepEqual(sourceAudit.signedRequestEnvelopeFindings, []);
  const bytes = readFileSync(join(source, 'evidence.json.gz'));
  const index = read('evidence-index.json');
  assert.equal(sha(bytes), index.archiveSha256); assert.equal(bytes.length, index.archiveBytes);
  const archived = JSON.parse(gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }));
  assert.deepEqual(Object.keys(archived).sort(), index.files.map(f => f.path).sort());
  for (const f of index.files) {
    assert.equal(typeof archived[f.path], 'string');
    assert.equal(sha(archived[f.path]), f.sha256);
    assert.equal(Buffer.byteLength(archived[f.path], 'utf8'), f.bytes);
  }
  const summary = read('summary.json');
  const sessions = new Set();
  const cases = CASES.map((caseName, i) => {
    const a = sourceAudit.cases.find(c => c.caseName === caseName); assert(a);
    const s = summary.cases.find(c => c.caseName === caseName); assert(s);
    assert.equal(a.status, 'passed');
    const trace = JSON.parse(archived[TRACE_PATHS[i]]);
    const records = Array.isArray(trace) ? trace : trace.calls;
    const batches = new Map();
    const calls = records.map((record, j) => {
      const id = record.sequence ?? record.call ?? record.id;
      assert.equal(Number(id), j + 1, 'Non-sequential source call');
      return projectCall(record, { number: j + 1, caseName }, batches, a.failures.find(f => f.callId === String(id)));
    });
    assert.equal(a.observations.length, 1); const observation = a.observations[0];
    assert.equal(s.sessionId, observation.sessionId); sessions.add(s.sessionId);
    const replay = i === 0 ? trace.finalReplay : s.replay;
    return { caseName, calls,
      reportedCounts: { calls: integer(a.actualCallRecords, 1000), batches: integer(a.actualDistinctBatchIds, 1000),
        capturedOutputBytes: integer(a.serializedSafeOutputBytes), failures: integer(a.failures.length, 1000),
        reportTailCalls: integer(a.finalReport.publicationAndReadbackTailCalls, 1000) },
      reportedGrading: { launches: integer(a.successfulLaunches, 1000), attempts: integer(a.gradingAttempts, 1000),
        correct: integer(s.correct, 1000), questions: integer(observation.questions, 1000), score: observation.score,
        answerCorrespondence: requiredBoolean(observation.questionAnswerCorrespondence) },
      reportedReplay: { complete: requiredBoolean(replay.complete), verifiedLinks: integer(replay.verifiedLinks, 1000),
        chainLength: integer(replay.chainLength, 1000) },
      recordedAssistanceCount: integer(a.recordedAssistance.length, 100) };
  });
  assert.equal(sessions.size, 5, 'Source sessions must be distinct');
  const evidence = { schema: 'live-transfer-public-projection/v1', scope: 'unsigned-derived-records',
    sourceArchiveSha256: sha(bytes), sourceArchiveFiles: integer(index.files.length, 1000), sourceAuditPassed: true, cases };
  const workflowSource = read('procedure-workflow.json');
  const linkedSource = read('procedure-linked.json');
  const workflow = workflowSource.steps.map((s, i) => {
    assert.equal(s.id, STEPS[i]); assert.equal(s.name, LABELS[i]);
    assert(s.dependsOn.every(id => STEPS.includes(id)));
    return { id: STEPS[i], name: LABELS[i], dependsOn: [...s.dependsOn] };
  });
  const nodes = linkedSource.operationNodes.map((s, i) => {
    assert.equal(s.id, STEPS[i]); assert.equal(s.label, LABELS[i]); return { id: STEPS[i], name: LABELS[i] };
  });
  const edges = linkedSource.dependencyEdges.map(e => {
    assert(STEPS.includes(e.from) && STEPS.includes(e.to)); return { from: e.from, to: e.to };
  });
  const procedures = { schema: 'live-transfer-public-procedure-structure/v1', scope: 'unsigned-structural-projection',
    resourceRoleCount: integer(workflowSource.artifacts.length, 100), workflow, linked: { nodes, edges } };
  const result = audit(evidence, procedures);
  assert.equal(result.transferCalls, 104); assert.equal(result.transferRecordedBatches, 62);
  return { evidence, procedures, result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sourceArg, outputArg] = process.argv.slice(2);
  assert(sourceArg && outputArg, 'Usage: node export-public.mjs TRUSTED_PRIVATE_CAPTURE_DIRECTORY NEW_OUTPUT_DIRECTORY');
  const source = realpathSync(sourceArg), output = resolve(outputArg);
  assert(!existsSync(output), 'Output directory must not already exist');
  const inside = relative(source, output);
  assert(inside.startsWith('..') || isAbsolute(inside), 'Output must be outside private source');
  const rawAudit = execFileSync(process.execPath, [join(source, 'audit.mjs')],
    { cwd: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const exported = project(source, JSON.parse(rawAudit));
  mkdirSync(output, { recursive: true });
  for (const [name, value] of [['public-evidence.json', exported.evidence], ['public-procedures.json', exported.procedures]]) {
    writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
  }
  console.log(JSON.stringify(exported.result, null, 2));
}
