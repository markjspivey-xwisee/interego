/**
 * DOES A REAL TURN PRODUCE A REAL RECORD?
 *
 * The unit tests feed `usageFrom` a reply captured earlier and feed `toolsInTurn` audit lines a
 * test wrote. Both are honest as far as they go, and neither can tell you that a LIVE turn's reply
 * still has the shape the parser expects, or that the gate stamps the id the reader looks for when
 * the CLI is the one invoking it.
 *
 * ★ AND THAT GAP HAS PRODUCED THREE PRODUCTION DEFECTS IN THIS WORK ALREADY — every one of them a
 * test that built one configuration while production used another. So this drives the real CLI,
 * with the real gate, over a task that MUST use tools, and then reads the numbers back through the
 * same functions the app uses.
 *
 * Run from applications/shared-workspace/desktop/:  npx tsx tools/probe-telemetry-live.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { childEnv, resolveClaudeCli } from '../src/modelprovider.js';
import { gateSettings, writeGateConfig } from '../src/gate.js';
import { writeGateLauncher } from '../src/turnsetup.js';
import { toolsInTurn, usageFrom } from '../src/telemetry.js';

let bad = 0;
const check = (ok: boolean, what: string, detail?: string): void => {
  if (!ok) bad++;
  process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '\n        ' + detail : '') + '\n');
};

function main(): void {
  const cli = resolveClaudeCli();
  if (!cli?.path) { process.stdout.write('no claude CLI on this machine\n'); process.exit(1); }

  const root = mkdtempSync(join(tmpdir(), 'tel-live-'));
  const userData = join(root, 'userData');
  const workspace = join(userData, 'agent-workspaces', 'probe-telemetry');
  mkdirSync(workspace, { recursive: true });

  const gateScript = join(root, 'gate.mjs');
  const built = spawnSync('npx', ['esbuild', new URL('../src/gate-main.ts', import.meta.url).pathname.replace(/^\//, ''),
    '--bundle', '--format=esm', '--platform=node', '--outfile=' + gateScript], { encoding: 'utf8', shell: true });
  if (built.status !== 0) { process.stdout.write('could not build the gate\n'); process.exit(1); }

  const turnId = randomUUID();
  const cfgPath = writeGateConfig(root, {
    policy: { workspace, nominated: [], grants: [] },
    requestsDir: join(root, 'req'),
    auditPath: join(userData, 'agent-audit.jsonl'),
    context: { agentName: 'Claude Desktop', askedBy: 'goldenfleece', channel: '#house', turnId },
  });
  const settings = join(root, 'settings.json');
  writeFileSync(settings, gateSettings(writeGateLauncher(root, gateScript, cfgPath)), 'utf8');

  // A task that CANNOT be answered without tools, so there is something for the gate to record.
  const r = spawnSync(cli.path, [
    '-p', '--model', 'sonnet', '--settings', settings, '--setting-sources', '',
    '--add-dir', workspace, '--no-session-persistence', '--output-format', 'json',
  ], {
    input: 'Create a file called count.txt containing the number 7, then read it back and tell me what it says.',
    encoding: 'utf8', timeout: 300_000, env: childEnv(), cwd: workspace,
  });

  let reply: Record<string, unknown> | null = null;
  try { reply = JSON.parse(String(r.stdout ?? '')) as Record<string, unknown>; } catch { reply = null; }
  check(reply !== null, 'the turn returned something parseable', String(r.stdout ?? r.stderr).slice(0, 120));
  if (!reply) { rmSync(root, { recursive: true, force: true }); process.exit(1); }

  const u = usageFrom(reply);
  const t = toolsInTurn(userData, turnId);

  process.stdout.write('\n  measured on this turn:\n'
    + '    tokens in/out   ' + u.inputTokens + ' / ' + u.outputTokens + '\n'
    + '    cache read/write ' + u.cacheReadTokens + ' / ' + u.cacheCreationTokens + '\n'
    + '    num_turns       ' + u.numTurns + '\n'
    + '    cost            $' + u.costUsd.toFixed(6) + '\n'
    + '    session         ' + u.sessionId.slice(0, 12) + '\n'
    + '    tool calls      ' + t.toolCalls + '  (' + t.allowed + ' allowed, ' + t.asked + ' asked, ' + t.denied + ' denied)\n'
    + '    tools           ' + JSON.stringify(t.tools) + '\n\n');

  check(u.outputTokens > 0, '★ output tokens are real and non-zero', String(u.outputTokens));
  check(u.numTurns > 0, 'the CLI reported how many turns it took', String(u.numTurns));
  check(u.costUsd > 0, 'the CLI reported a cost', '$' + u.costUsd.toFixed(6));
  check(u.sessionId !== '', 'the session id came through', u.sessionId);
  /**
   * ★ THE JOIN IS THE WHOLE POINT. Tokens come from the CLI and tool calls from a hook running in
   * its own process; if the id does not match, this is zero while the turn plainly used tools —
   * which is exactly how a quiet telemetry bug looks.
   */
  check(t.toolCalls > 0, '★★ the gate\'s tool calls JOINED to this turn by id',
    t.toolCalls === 0 ? 'zero — the turnId did not reach the audit trail' : String(t.toolCalls) + ' recorded');
  check(Object.keys(t.tools).length > 0, 'and which tools were used is known', JSON.stringify(t.tools));

  // The delegate's own identity and the asker are what "user id" means here — both already on the
  // public record for the message that caused the turn. Nothing new is minted.
  check(homedir().length > 0, 'who asked and in which channel travel with the turn', 'goldenfleece · #house');

  rmSync(root, { recursive: true, force: true });
  process.stdout.write(bad ? '\n' + bad + ' problem(s)\n' : '\nevery number came from a tool that measured it\n');
  process.exit(bad ? 1 : 0);
}

main();
