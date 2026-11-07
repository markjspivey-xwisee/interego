import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fixture, organizational } from './fixtures.mjs';
import { runCli } from './demo.mjs';
import { createJournal } from './stdio.mjs';

test('CLI result binds an exclusive durable journal and canonical HMD to the host preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'interego-composition-cli-')), f = fixture(), config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ task: organizational, catalogs: f.catalogs, seeds: f.seeds }));
  const output = join(root, 'prepared'), p = await runCli(['prepare', config, output], f.call);
  assert.equal(p.status, 'ready');
  const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
  assert.equal(result.reviewDigest, p.reviewDigest);
  const events = readFileSync(join(output, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let previousHash = null;
  for (const row of events) {
    assert.equal(row.previousHash, previousHash);
    assert.equal(row.sha256, createHash('sha256').update(JSON.stringify({ previousHash, event: row.event })).digest('hex'));
    previousHash = row.sha256;
  }
  assert.equal(result.journalTail, previousHash);
  assert.equal(events.filter(e => e.event.type === 'intent').length, p.interegoCalls);
  assert.equal(events.filter(e => e.event.type === 'outcome').length, p.interegoCalls);
  await assert.rejects(runCli(['prepare', config, output], f.call), /EEXIST/u);
});

test('a configuration key outside the allowlist is refused before the journal or any host call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'interego-composition-config-')), f = fixture(), config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ task: organizational, catalogs: f.catalogs, seeds: f.seeds, unexpected: true }));
  const output = join(root, 'out');
  await assert.rejects(runCli(['prepare', config, output], f.call), /Invalid composition configuration/u);
  assert.equal(existsSync(output), false); assert.equal(f.calls.length, 0);
});

test('a pre-existing events.jsonl alone in the output directory is refused, not appended to', async () => {
  const root = mkdtempSync(join(tmpdir(), 'interego-composition-journal-exists-')), f = fixture(), config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ task: organizational, catalogs: f.catalogs, seeds: f.seeds }));
  const output = join(root, 'out'), prior = '{"prior":true}\n';
  mkdirSync(output); writeFileSync(join(output, 'events.jsonl'), prior);
  // No result.json exists, so only the journal's own exclusive creation can refuse this run.
  await assert.rejects(runCli(['prepare', config, output], f.call), /EEXIST[^\n]*events\.jsonl/u);
  assert.deepEqual(readdirSync(output), ['events.jsonl']);
  assert.equal(readFileSync(join(output, 'events.jsonl'), 'utf8'), prior); assert.equal(f.calls.length, 0);
});

test('closing the host stream rejects an outstanding request without hanging or retrying', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'interego-composition-eof-')), f = fixture(), config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ task: organizational, catalogs: f.catalogs, seeds: f.seeds }));
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./stdio.mjs', import.meta.url)), 'prepare', config, join(root, 'out')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let calls = 0, stderr = '';
  createInterface({ input: child.stdout }).on('line', () => { calls++; child.stdin.end(); });
  child.stderr.on('data', b => { stderr += b; });
  const code = await new Promise((yes, no) => { child.on('close', yes); child.on('error', no); });
  assert.equal(code, 1); assert.equal(calls, 1); assert.match(stderr, /closed its response stream/u);
  const events = readFileSync(join(root, 'out', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.event.type === 'transport-error'));
  assert.ok(events.some(e => e.event.type === 'cli-error'));
});

test('a closed durable recorder cannot silently accept an event', async () => {
  const journal = createJournal(mkdtempSync(join(tmpdir(), 'interego-composition-journal-')));
  journal.close();
  await assert.rejects(journal.onEvent({ type: 'intent' }), /closed/u);
});
