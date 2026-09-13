import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audit } from './audit.mjs';
import { projectCall } from './export-public.mjs';

const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const evidence = () => load('./public-evidence.json');
const procedures = () => load('./public-procedures.json');

test('private fields, nested JSON, encoded bodies, identities and errors are never copied', () => {
  const sensitive = 'private-canary-do-not-publish';
  const record = { tool: 'act', modelDecisionBatchId: sensitive,
    input: { authorization: sensitive, sessionId: sensitive },
    output: { body: JSON.stringify({ identity: sensitive, encoded: Buffer.from(sensitive).toString('base64') }) },
    procedureStepIds: ['S08', sensitive], extra: sensitive };
  const projected = projectCall(record, { number: 1, caseName: 'linked-rebind' }, new Map(),
    { errorText: `application authority changed before submission ${sensitive}` });
  const text = JSON.stringify(projected);
  assert(!text.includes(sensitive)); assert(!text.includes(Buffer.from(sensitive).toString('base64')));
  assert.equal(projected.batch, 1); assert.deepEqual(projected.steps, ['S08']);
  assert.equal(projected.failureCategory, 'authority-changed');
});

test('unrecognized source tool names fail closed', () => {
  assert.throws(() => projectCall({ tool: 'private-endpoint', modelDecisionBatchId: 1, output: {} },
    { number: 1, caseName: 'acquisition' }, new Map(), null), /Unknown source tool/u);
});

test('extra private fields at top level and inside calls are rejected', () => {
  const a = evidence(); a.sourceUrl = 'https://private.invalid';
  assert.throws(() => audit(a, procedures()));
  const b = evidence(); b.cases[0].calls[0].identity = 'private-canary';
  assert.throws(() => audit(b, procedures()));
});

test('accounting tampering and arbitrary batch identifiers fail', () => {
  const a = evidence(); a.cases[0].reportedCounts.calls++;
  assert.throws(() => audit(a, procedures()));
  const b = evidence(); b.cases[0].calls[0].batch = 'private-canary';
  assert.throws(() => audit(b, procedures()));
  const c = evidence(); c.cases[0].calls[0].capturedOutputBytes++;
  assert.throws(() => audit(c, procedures()));
});

test('procedure rewiring and hidden extra edge fields fail', () => {
  const a = procedures(); a.linked.edges[0].from = 'S10';
  assert.throws(() => audit(evidence(), a));
  const b = procedures(); b.linked.edges[0].url = 'https://private.invalid';
  assert.throws(() => audit(evidence(), b));
});

test('published data recomputes while explicitly declining live authentication claims', () => {
  const result = audit(evidence(), procedures());
  assert.equal(result.transferCalls, 104); assert.equal(result.transferRecordedBatches, 62);
  assert.equal(result.liveSignaturesIndependentlyVerified, false);
  assert.equal(result.privateSourceCorrespondenceIndependentlyVerified, false);
});
