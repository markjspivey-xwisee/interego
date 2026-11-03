import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareFictionalLocalHealthCheck, verifyFictionalLocalHealthResponse } from '../fictional-local-check.mjs';

const connectionId = '23456789-1234-4567-8901-123456789abc';
const noteId = '12345678-1234-4567-8901-123456789abc';
const options = { expectedConnectionId: connectionId };
const cli = fileURLToPath(new URL('../tools/fictional-local-check.mjs', import.meta.url));
function response() {
  return { note: { id: noteId, ...prepareFictionalLocalHealthCheck(),
    createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:05.000Z',
    author: { connectionId, name: 'Fictional test connection' } } };
}

test('prepares only fixed fictional evidence and compares a native create response without claiming persistence', () => {
  const prepared = prepareFictionalLocalHealthCheck();
  const body = JSON.parse(prepared.body);
  assert.equal(body.case.scope, 'synthetic');
  assert.deepEqual(body.entries.map(row => [row.type, row.status]), [['MedicationOrder', 'completed'], ['AdministrationRecord', 'not-done']]);
  assert.equal(body.sourcePacketTruncation.omitted, 1);
  assert.equal(Object.hasOwn(body, 'query'), false);
  const result = verifyFictionalLocalHealthResponse(response(), options);
  assert.equal(result.result, 'fictional-content-match');
  assert.equal(result.expectedNoteIdMatched, null);
  assert.equal(result.noteId, noteId);
  for (const claim of ['response-origin-and-authenticity', 'encrypted-storage', 'persistence-after-restart', 'grant-expiry', 'grant-revocation']) assert.ok(result.unverified.includes(claim));
  assert.ok(!JSON.stringify(result).includes(prepared.body));
});

test('rejects altered evidence, sources, identifiers, dates, authors and failed/wrapped native responses', () => {
  const mutations = [
    value => { value.note.body += '\n'; },
    value => { const body = JSON.parse(value.note.body); body.entries[1].status = 'completed'; value.note.body = JSON.stringify(body, null, 2); },
    value => { const body = JSON.parse(value.note.body); body.citations[0].title = 'Different source'; value.note.body = JSON.stringify(body, null, 2); },
    value => { value.note.title = 'Changed title'; },
    value => { value.note.id = 'source-record-id'; },
    value => { value.note.createdAt = '2026-02-30T00:00:00.000Z'; },
    value => { value.note.updatedAt = '2025-01-02T03:04:05.000Z'; },
    value => { value.note.author.connectionId = noteId; },
    value => { delete value.note.author; },
    value => { value.isError = true; },
  ];
  for (const mutate of mutations) {
    const value = response(); mutate(value);
    assert.throws(() => verifyFictionalLocalHealthResponse(value, options), TypeError);
  }
  for (const value of [null, [], { structuredContent: response() }, { isError: true }]) assert.throws(() => verifyFictionalLocalHealthResponse(value, options), TypeError);
  assert.throws(() => verifyFictionalLocalHealthResponse(response(), {}), /connection identifier/);
});

test('binds a later supplied response to the original native id while keeping restart pending', () => {
  const result = verifyFictionalLocalHealthResponse(response(), { ...options, expectedNoteId: noteId });
  assert.equal(result.expectedNoteIdMatched, true);
  assert.ok(result.unverified.includes('persistence-after-restart'));
  assert.throws(() => verifyFictionalLocalHealthResponse(response(), { ...options, expectedNoteId: connectionId }), /different native note/);
});

test('CLI prepares exact arguments, accepts bounded response files and emits no supplied content on failure', () => {
  const prepared = spawnSync(process.execPath, [cli, 'prepare'], { encoding: 'utf8' });
  assert.equal(prepared.status, 0);
  assert.deepEqual(JSON.parse(prepared.stdout), prepareFictionalLocalHealthCheck());
  const directory = mkdtempSync(join(tmpdir(), 'health-fictional-check-'));
  try {
    const path = join(directory, 'response.json');
    writeFileSync(path, `\uFEFF${JSON.stringify(response())}`, 'utf8');
    const run = (...args) => spawnSync(process.execPath, [cli, 'check', path, '--connection-id', connectionId, ...args], { encoding: 'utf8' });
    const matched = run('--note-id', noteId);
    assert.equal(matched.status, 0);
    assert.equal(JSON.parse(matched.stdout).expectedNoteIdMatched, true);
    for (const text of ['PRIVATE RESPONSE MUST NOT APPEAR', 'x'.repeat(128 * 1024 + 1), '{"secret":"PRIVATE RESPONSE MUST NOT APPEAR"', Buffer.from([0xff])]) {
      writeFileSync(path, text, 'utf8');
      const failed = run();
      assert.equal(failed.status, 1);
      assert.equal(failed.stdout, '');
      assert.ok(!failed.stderr.includes('PRIVATE RESPONSE MUST NOT APPEAR'));
      assert.ok(!failed.stderr.includes(path));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI rejects special files and symlinks promptly', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'health-fictional-special-'));
  try {
    const ordinary = join(directory, 'response.json');
    writeFileSync(ordinary, JSON.stringify(response()), 'utf8');
    const link = join(directory, 'linked.json');
    symlinkSync(ordinary, link);
    const fifo = join(directory, 'response-pipe');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 2000 });
    assert.equal(made.status, 0);
    for (const path of [directory, link, fifo]) {
      const result = spawnSync(process.execPath, [cli, 'check', path, '--connection-id', connectionId], { encoding: 'utf8', timeout: 2000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes(path));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
