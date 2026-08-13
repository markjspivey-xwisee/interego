/**
 * WHAT IS ACTUALLY IN A PreToolUse PAYLOAD?
 *
 * The gate parses `tool_name` and `tool_input` and throws the rest away. An adversarial review
 * then showed that `cd .. && cd .. && cat .credentials.json` is ALLOWED, because nothing in the
 * gate models a working directory — every relative path is judged against the gate process's own
 * cwd, which is not the agent's.
 *
 * Fixing that needs the agent's cwd, and whether the payload carries it is a FACT about this CLI
 * build, not something to assume from a doc page. This dumps one real payload.
 *
 * Run from applications/shared-workspace/desktop/:  npx tsx tools/probe-hook-payload.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, resolveClaudeCli } from '../src/modelprovider.js';

function main(): void {
  const cli = resolveClaudeCli();
  if (!cli?.path) { process.stdout.write('no claude CLI on this machine\n'); process.exit(1); }

  const root = mkdtempSync(join(tmpdir(), 'payload-'));
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const log = join(root, 'payload.jsonl');
  const hook = join(root, 'dump.mjs');
  writeFileSync(hook, [
    "import { appendFileSync } from 'node:fs';",
    "let raw = '';",
    "process.stdin.on('data', (c) => { raw += c; });",
    "process.stdin.on('end', () => {",
    '  appendFileSync(' + JSON.stringify(log) + ", raw + '\\n');",
    "  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',",
    "    permissionDecision: 'deny', permissionDecisionReason: 'payload probe' } }));",
    '});',
  ].join('\n'), 'utf8');

  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command',
      command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(hook) }] }] },
  }), 'utf8');

  spawnSync(cli.path, [
    '-p', '--model', 'sonnet', '--settings', settings, '--setting-sources', '',
    '--add-dir', work, '--no-session-persistence', '--output-format', 'json',
  ], {
    input: 'Run the shell command `echo hello` and report what happened in one line.',
    encoding: 'utf8', timeout: 300_000, env: childEnv(), cwd: work,
  });

  let raw = '';
  try { raw = readFileSync(log, 'utf8'); } catch { /* never fired */ }
  const first = raw.trim().split('\n')[0] ?? '';
  if (!first) { process.stdout.write('the hook never fired — nothing to inspect\n'); rmSync(root, { recursive: true, force: true }); process.exit(1); }

  const payload = JSON.parse(first) as Record<string, unknown>;
  process.stdout.write('\nkeys: ' + Object.keys(payload).join(', ') + '\n\n');
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'tool_input') { process.stdout.write('  tool_input : ' + JSON.stringify(v).slice(0, 160) + '\n'); continue; }
    process.stdout.write('  ' + k.padEnd(11) + ': ' + String(JSON.stringify(v)).slice(0, 160) + '\n');
  }
  const cwd = payload['cwd'];
  process.stdout.write('\n★ cwd present: ' + (typeof cwd === 'string' ? 'YES — ' + cwd : 'NO')
    + '\n  (the agent was launched with cwd = ' + work + ')\n');
  rmSync(root, { recursive: true, force: true });
}

main();
