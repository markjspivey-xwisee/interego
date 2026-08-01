#!/usr/bin/env node
/**
 * One command an editor can point at, instead of a hand-assembled three-process chain.
 *
 *   editor  <->  witness (measures)  <->  probe (offers reject_always)  <->  agent
 *
 * The chain is fiddly to write by hand in an editor's JSON settings — three nested `--`
 * separators, and on Windows `npx` cannot be spawned at all (ENOENT for `npx`, EINVAL for
 * `npx.cmd`, because Node 22 will not spawn a `.cmd` without a shell). Getting one
 * separator wrong fails in a way that looks like the agent is broken. So this resolves
 * everything itself and takes no arguments.
 *
 * Tallies are written next to the repo as witness-tally.json and probe-tally.json.
 * Both are LOCAL. Nothing is published, and nothing about prompts, paths, diffs or
 * terminal output leaves the machine.
 *
 * Override the agent with ACP_AGENT=/path/to/agent.js if you want a different one.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');

const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WITNESS = join(REPO, 'applications', 'agent-development-practice', 'adapters', 'editor-witness', 'src', 'cli.ts');
const PROBE = join(HERE, 'src', 'inject.ts');
const AGENT = process.env['ACP_AGENT']
  ?? join(REPO, 'node_modules', '@zed-industries', 'claude-code-acp', 'dist', 'index.js');

const note = (s) => process.stderr.write(s + '\n');

// Fail with the fix, not with a stack trace. stdout is the protocol channel, so every
// diagnostic goes to stderr — a stray byte on stdout corrupts the session.
const missing = [
  [TSX, 'npm install            (run once, in the repo root)'],
  [WITNESS, 'the editor-witness adapter is missing from this checkout'],
  [PROBE, 'the reject-always-probe adapter is missing from this checkout'],
  [AGENT, 'npm install @zed-industries/claude-code-acp    (or set ACP_AGENT=/path/to/agent.js)'],
].filter(([p]) => !existsSync(p));

if (missing.length > 0) {
  note('\nreject-always probe: cannot start.\n');
  for (const [p, fix] of missing) note(`  missing: ${p}\n     fix: ${fix}\n`);
  process.exit(2);
}

const args = [
  TSX, WITNESS, '--json', join(REPO, 'witness-tally.json'), '--',
  process.execPath, TSX, PROBE, '--json', join(REPO, 'probe-tally.json'), '--',
  process.execPath, AGENT,
];

note('[launch] editor <-> witness <-> reject-always probe <-> agent');
note(`[launch] agent: ${AGENT}`);
note('[launch] tallies -> witness-tally.json / probe-tally.json (local; nothing is published)');

const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('error', (e) => { note(`[launch] failed to start: ${e.message}`); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 0));
