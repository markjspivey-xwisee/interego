/**
 * WHAT DOES A TURN ALREADY TELL US ABOUT ITSELF?
 *
 * Asked for: "telemetry — input/output LLM tokens, turns taken, tool calls, user id".
 *
 * ★ THE FIRST QUESTION IS NOT HOW TO BUILD IT, IT IS WHAT IS ALREADY THERE. The app runs
 * `claude -p --output-format json` and reads exactly one field out of the reply — `result`. If the
 * CLI already reports usage, then "we have no telemetry" is a reporting gap rather than a
 * measurement problem, and the honest fix is to stop discarding what arrives.
 *
 * This spawns one real turn and dumps every key the CLI returns, so the design is built on the
 * shape the tool actually emits rather than on a remembered API.
 *
 * Run from applications/shared-workspace/desktop/:  npx tsx tools/probe-turn-usage.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, resolveClaudeCli } from '../src/modelprovider.js';

function main(): void {
  const cli = resolveClaudeCli();
  if (!cli?.path) { process.stdout.write('no claude CLI on this machine\n'); process.exit(1); }
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));

  const r = spawnSync(cli.path, [
    '-p', '--model', 'sonnet', '--setting-sources', '',
    '--no-session-persistence', '--output-format', 'json',
  ], { input: 'Reply with exactly the word: PONG', encoding: 'utf8', timeout: 300_000, env: childEnv(), cwd: dir });

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(String(r.stdout ?? '')) as Record<string, unknown>; }
  catch { process.stdout.write('could not parse the reply:\n' + String(r.stdout ?? '').slice(0, 600) + '\n'); process.exit(1); }

  process.stdout.write('\nTOP-LEVEL KEYS THE CLI RETURNS\n\n');
  for (const [k, v] of Object.entries(parsed)) {
    const shown = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    process.stdout.write('  ' + k.padEnd(24) + shown.slice(0, 150) + '\n');
  }

  const usage = parsed['usage'];
  process.stdout.write('\n★ usage present: ' + (usage ? 'YES' : 'NO') + '\n');
  if (usage && typeof usage === 'object') {
    for (const [k, v] of Object.entries(usage as Record<string, unknown>)) {
      process.stdout.write('    ' + k.padEnd(30) + JSON.stringify(v).slice(0, 90) + '\n');
    }
  }
  const wanted = ['num_turns', 'total_cost_usd', 'duration_ms', 'session_id', 'modelUsage'];
  process.stdout.write('\n★ the other things asked for:\n');
  for (const w of wanted) {
    process.stdout.write('    ' + w.padEnd(20) + (w in parsed ? 'present — ' + JSON.stringify(parsed[w]).slice(0, 90) : 'ABSENT') + '\n');
  }
  rmSync(dir, { recursive: true, force: true });
}

main();
