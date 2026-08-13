/**
 * CAN A DELEGATE BE A NORMAL AGENT BEHIND A PERMISSION GATE, RATHER THAN A CRIPPLED ONE?
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * The delegate ships today with every built-in DENIED — no Bash, no Read, no Write — and one MCP
 * server. That is safe, and it is the wrong shape. What is wanted is an ordinary Claude Code agent
 * with ordinary capabilities plus a boundary: it must not get free rein over the machine because
 * somebody in a Discord channel asked it to.
 *
 * That is a PERMISSION problem, not a capability problem, and `--help` advertises the pieces:
 *
 *   --settings <json>            a `permissions` object with allow / deny / ask rules, and hooks
 *   --setting-sources <list>     which of the person's OWN settings load — none, so a permissive
 *                                personal config never applies to a channel-driven agent
 *   --allowedTools "Bash(git *)" rules carry ARGUMENT PATTERNS, not just tool names
 *   --add-dir <path>             a directory the agent may work in
 *
 * ★ AND WHAT IS NOT THERE DECIDES THE DESIGN. There is no `--permission-prompt-tool` in this
 * build; the modes are acceptEdits / auto / bypassPermissions / default / dontAsk / plan. Headless
 * has no TTY, so "ask the human" cannot be a prompt — it has to be a PreToolUse HOOK, a command
 * run before a tool whose answer allows or denies. A hook can block while it asks the desktop app,
 * which is what puts a person in the loop.
 *
 * All of that is read off `--help`, and NONE of it is proof that a hook fires under `-p`, that its
 * decision is honoured, or that a deny stops the tool. A permission system that is assumed rather
 * than measured is not one. This establishes those three.
 *
 * Run from applications/shared-workspace/desktop/:  npx tsx tools/probe-permission-gate.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, resolveClaudeCli } from '../src/modelprovider.js';

const PROMPT = [
  'Run the shell command `echo GATEPROBE` and report EXACTLY what happened.',
  'Answer in one line: RAN <output>, or BLOCKED <the reason you were given>, or NO-TOOL.',
].join('\n');

/**
 * The hook, as a FILE.
 *
 * ★ NOT A NESTED ONE-LINER. The first attempt was `node -e "…"` with three levels of quoting, on
 * Windows, inside a JSON settings value — and when it did not fire there was no way to separate a
 * broken command from a mechanism that does not exist. A file removes one of the two explanations.
 */
function writeHook(dir: string, log: string): string {
  const file = join(dir, 'gate.mjs');
  const src = [
    "import { appendFileSync } from 'node:fs';",
    "let raw = '';",
    "process.stdin.on('data', (c) => { raw += c; });",
    "process.stdin.on('end', () => {",
    '  appendFileSync(' + JSON.stringify(log) + ", raw + '\\n');",
    '  process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
    "    hookEventName: 'PreToolUse', permissionDecision: 'deny',",
    "    permissionDecisionReason: 'refused by the delegate gate probe',",
    '  } }));',
    '});',
  ].join('\n');
  writeFileSync(file, src, 'utf8');
  return file;
}

function main(): void {
  const cli = resolveClaudeCli();
  if (!cli?.path) { process.stdout.write('no claude CLI on this machine\n'); process.exit(1); }

  const dir = mkdtempSync(join(tmpdir(), 'interego-gate-'));
  const log = join(dir, 'hook.log');
  const hookFile = writeHook(dir, log);
  const settingsFile = join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(hookFile) }] }] },
  }), 'utf8');

  const attempt = (label: string, extra: readonly string[]): void => {
    try { rmSync(log, { force: true }); } catch { /* first run */ }
    const r = spawnSync(cli.path as string, [
      '-p', '--model', 'sonnet',
      '--settings', settingsFile,
      ...extra,
      '--no-session-persistence', '--output-format', 'json',
    ], { input: PROMPT, encoding: 'utf8', timeout: 300_000, env: childEnv(), cwd: dir });

    let text = String(r.stdout ?? '');
    try { text = (JSON.parse(text) as { result?: string }).result ?? text; } catch { /* raw */ }
    let fired = '';
    try { fired = readFileSync(log, 'utf8'); } catch { /* never ran */ }

    const blocked = /BLOCKED|denied|refus|not permitted|blocked/i.test(text);
    const ran = /GATEPROBE/.test(text) && !blocked;
    process.stdout.write('\n════ ' + label + ' ════\n'
      + '  hook fired : ' + (fired ? 'YES' : 'NO') + '\n'
      + (fired ? '  received   : ' + fired.slice(0, 150).replace(/\s+/g, ' ') + '\n' : '')
      + '  agent says : ' + text.trim().slice(0, 150).replace(/\s+/g, ' ') + '\n'
      + '  verdict    : ' + (fired && blocked && !ran ? 'GATED'
        : ran ? '★ NOT GATED — the command RAN' : 'unclear') + '\n');
  };

  // Four variants, because a hook that does not fire has four candidate explanations and only one
  // run each separates them: the settings file, the permission mode, and whether excluding the
  // person's own setting sources also excludes the ones passed explicitly.
  attempt('default mode, user sources excluded', ['--setting-sources', '', '--permission-mode', 'default']);
  attempt('default mode, sources flag omitted', ['--permission-mode', 'default']);
  attempt('no permission-mode flag at all', []);
  attempt('and with Bash simply denied by name (what ships today)', ['--disallowedTools', 'Bash']);

  rmSync(dir, { recursive: true, force: true });
  process.stdout.write('\n★ The last variant is the control: denial by name is what the delegate uses now,\n'
    + '  and it is the thing a permission gate would REPLACE with something less blunt.\n');
}

main();
