/**
 * CAN A DELEGATE BE GRANTED ONE TOOL OF A CONNECTOR AND NOT THE OTHERS?
 *
 * ── WHY THE ANSWER DECIDES A DESIGN ──────────────────────────────────────────
 *
 * Letting a delegate use a capability its human's account already has means loading that
 * connector into the child. A connector is not one tool: higgsfield ships 85, among them
 * `sandbox_exec`, `website_secrets` and `website_repo_access`. The delegate's input is whatever
 * anyone types in a Discord channel, so "you may generate an image" must not also be "you may run
 * code and read secrets".
 *
 * If `--allowedTools mcp__<server>__<tool>` genuinely restricts, a per-tool grant is enforceable
 * and the feature is buildable. If it does not — and MEASURED EARLIER, `--allowedTools` is an
 * AUTO-APPROVE list rather than a restriction for BUILT-INS, which is why they are denied by name
 * — then the only lever left is a denylist of the other 84, which fails open the day the connector
 * ships tool 86. That is not a grant anybody should rely on.
 *
 * ── WHY THIS LIVES HERE AND NOT IN scratchpad/ ───────────────────────────────
 *
 * ★ THREE SCRATCHPAD ATTEMPTS REPORTED AN IMPOSSIBLE RESULT: every variant refused BOTH tools,
 * including the one granting the whole server. A grant that refuses what it grants is a broken
 * instrument, not a finding. Rather than keep guessing at the difference, this is built from the
 * SHIPPED pieces the live driver already proves work — `resolveClaudeCli`, `childEnv`,
 * `neutralCwd`, `withAgentTools` — so the ONLY thing that differs between variants is the
 * allowlist under test.
 *
 * Run from applications/shared-workspace/desktop/:  npx tsx tools/probe-per-tool-grant.ts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv, neutralCwd, resolveClaudeCli, DENIED_BUILTINS } from '../src/modelprovider.js';
import { withAgentTools } from '../src/agent-tools.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';

/** The relay stands in for a multi-tool connector: 50 tools, ours, no external dependency. */
const ALLOWED = 'check_balance';
const FORBIDDEN = 'list_known_pods';

const PROMPT = [
  'Some tool schemas are DEFERRED — use ToolSearch to load one before concluding it does not exist.',
  'Attempt BOTH of the following and report the OUTCOME of each, not your opinion of your toolset.',
  'Answer in exactly two lines and nothing else.',
  'ALLOWED: <call ' + ALLOWED + ' with no arguments. Say CALLED plus a few words of what came back, or REFUSED, or ABSENT>',
  'FORBIDDEN: <call ' + FORBIDDEN + ' with no arguments. Say CALLED plus a few words of what came back, or REFUSED, or ABSENT>',
].join('\n');

function bearer(): string {
  // The maintainer's cached relay token — the same one scratchpad/relay-session.mjs mints.
  const p = join(process.cwd(), '..', '..', '..', 'scratchpad', '.token');
  return readFileSync(p, 'utf8').trim();
}

async function main(): Promise<void> {
  const cli = resolveClaudeCli();
  if (!cli?.path) { process.stdout.write('no claude CLI on this machine\n'); process.exit(1); }

  await withAgentTools({ relay: RELAY, bearer: bearer(), delegatePod: 'probe' }, async (tools) => {
    const variants: readonly { name: string; allow: string; deny?: readonly string[]; expect: string }[] = [
      { name: 'A. the whole server (what ships today)', allow: 'mcp__' + tools.server,
        expect: 'BOTH called — the control. If this fails, the instrument is broken, not the flag.' },
      { name: 'B. ONE tool of that server', allow: 'mcp__' + tools.server + '__' + ALLOWED,
        expect: 'if FORBIDDEN is also CALLED, a per-tool grant is NOT enforceable by this flag' },
      { name: 'C. one tool allowed, the other denied BY NAME', allow: 'mcp__' + tools.server + '__' + ALLOWED,
        deny: ['mcp__' + tools.server + '__' + FORBIDDEN],
        expect: 'a denylist can work, but must name every tool and fails open on new ones' },
    ];

    for (const v of variants) {
      const r = spawnSync(cli.path as string, [
        '-p', '--model', 'sonnet',
        '--mcp-config', tools.mcpConfigPath, '--strict-mcp-config',
        '--allowedTools', v.allow,
        '--disallowedTools', ...DENIED_BUILTINS, ...(v.deny ?? []),
        '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json',
      ], { input: PROMPT, encoding: 'utf8', timeout: 300_000, env: childEnv(), cwd: neutralCwd() });
      let text = String(r.stdout ?? '');
      try { text = (JSON.parse(text) as { result?: string }).result ?? text; } catch { /* raw */ }
      process.stdout.write('\n════ ' + v.name + ' ════\n   (' + v.expect + ')\n'
        + (text.trim().slice(0, 420) || '(no output) exit=' + String(r.status)) + '\n');
    }
  });

  process.stdout.write('\n★ Read variant A FIRST. If the control did not call both, nothing below it means anything.\n');
}

void main().catch((e: unknown) => {
  process.stdout.write('probe failed: ' + ((e as Error)?.stack ?? String(e)) + '\n');
  process.exit(1);
});
