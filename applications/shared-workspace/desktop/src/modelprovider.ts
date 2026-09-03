/**
 * THE USER'S OWN MODEL SUBSCRIPTION, DRIVEN BY THIS APP — OR HONESTLY REPORTED AS ABSENT.
 *
 * ★ THE QUESTION THIS FILE ANSWERS, AND THE MEASUREMENT THAT ANSWERS IT. Can a desktop app run a
 * person's agent on the Claude subscription they have ALREADY signed into on this machine, without
 * asking them for an API key and without anybody else paying? Measured on Windows 10, Claude Code
 * 2.1.162, 2026-08-07, with NO `ANTHROPIC_API_KEY` anywhere in the environment:
 *
 *   claude auth status --json      -> {"loggedIn":true,"authMethod":"claude.ai",
 *                                      "apiProvider":"firstParty","subscriptionType":"max"}
 *                                     exit 0, 844 ms
 *   claude -p … --output-format json
 *                                  -> {"is_error":false,"result":"SPAWN_OK"}, exit 0, 5.5 s
 *   the same, with the prompt on STDIN instead of argv
 *                                  -> {"is_error":false,"result":"STDIN_OK"}, exit 0
 *   the same, from a HOME with no credentials
 *                                  -> {"is_error":true,"result":"Not logged in · Please run /login"}
 *                                     exit 1, 1.2 s — it FAILS FAST, it does not hang or prompt
 *
 * So: yes. The CLI reads the credential itself (`~/.claude/.credentials.json` on Windows and
 * Linux, the Keychain on macOS) and refreshes it itself. **This app never reads that file, never
 * copies the token, and never holds it.** It spawns a child and reads stdout. That is the whole
 * integration, and it is why the answer here is a subscription rather than a key: there is no key.
 *
 * ★ THREE MEASURED FOOTGUNS, EACH OF WHICH SILENTLY BREAKS THE SUBSCRIPTION PATH.
 *
 *   1. `--bare` MUST NEVER BE PASSED. Its own documentation says "Anthropic auth is strictly
 *      ANTHROPIC_API_KEY or apiKeyHelper — OAuth and keychain are never read." Measured: with a
 *      valid subscription logged in, `-p --bare` returns "Not logged in" in 78 ms. It looks like a
 *      lean-startup flag and it is an auth-disabling flag.
 *   2. ON WINDOWS THE `.exe` MUST WIN OVER THE `.cmd`. npm installs both a `claude.cmd` shim and a
 *      real `claude.exe`. Node 22 refuses to spawn a `.cmd` without `shell: true` — it throws
 *      `EINVAL`, measured — and `shell: true` would pass a channel full of other people's words
 *      through `cmd.exe`. So the resolver looks for the executable first and treats a shim as a
 *      last resort it reports rather than uses.
 *   3. THE PARENT'S `CLAUDE_CODE_*` ENVIRONMENT MUST BE STRIPPED. A developer running this app
 *      from inside a Claude Code session would otherwise hand the child `CLAUDECODE=1`,
 *      `CLAUDE_CODE_SESSION_ID` and friends, and `ELECTRON_RUN_AS_NODE=1` on top. That is not a
 *      configuration a real user's machine ever has, so leaving it in means testing a path nobody
 *      ships.
 *
 * ★ WHAT IS NOT SUPPORTED, SAID PLAINLY RATHER THAN STUBBED. There is no Codex provider here. Not
 * because it could not work — its CLI is understood to have a comparable non-interactive mode —
 * but because nothing in this repository has ever run one, and a provider entry that had never
 * been executed would be a claim in a picker rather than a capability. `codex` is not on this
 * machine's PATH, so it could not be measured. When it is measured it gets an entry; until then
 * the UI says it is not supported here, which is true, instead of offering it and failing.
 *
 * ★ AND THERE IS NO BUILT-IN FALLBACK MODEL. If no provider is available the agent does not run,
 * and the shell says what is missing. An agent whose replies came from anywhere other than the
 * user's own credential would be a puppet wearing their name on a permanent public record.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Which provider a run used. One value today; the type is the seam for a second. */
export type ProviderId = 'claude-code';

/**
 * Environment variables removed from every child.
 *
 * See footgun 3. `ELECTRON_RUN_AS_NODE` is in the list because Electron sets it on helper
 * processes and a CLI that inherited it would start as a bare Node instead of itself.
 */
const STRIPPED = [
  'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID',
  'CLAUDE_EFFORT', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
] as const;

export function childEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...from };
  for (const k of STRIPPED) delete e[k];
  return e;
}

/** Where the CLI was found, and whether it is directly runnable. */
export interface Resolved {
  readonly path: string;
  /**
   * True when this is a `.cmd`/`.bat` shim rather than an executable.
   *
   * Reported instead of used: see footgun 2. A shim is evidence the CLI is installed, which is
   * worth telling the user, but it is not something this process will spawn.
   */
  readonly shimOnly: boolean;
}

/**
 * Find the `claude` CLI without a shell and without trusting `PATH` alone.
 *
 * A GUI-launched app does not inherit the PATH a terminal has — on macOS especially, a bundle
 * launched from Finder gets a minimal one — so the well-known install locations are searched
 * explicitly and first. Exported for the test that pins the `.exe`-before-`.cmd` ordering.
 */
export function resolveClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  // ★★ PLATFORM IS INJECTED FOR THE SAME REASON `env` AND `exists` ARE.
  //
  // It was read straight from `process.platform` here, so the two ★ tests pinning the
  // .exe-before-.cmd ordering opened with `if (!WIN) { expect(true).toBe(true); return; }` -
  // and CI runs the root suite on ubuntu-latest. Both therefore asserted a literal tautology
  // on the only machine that runs them, while the file's header claimed they were "written to
  // be injectable for exactly this". The regression they exist for - spawning a .cmd shim,
  // which fails as `spawn EINVAL` and is reported to the user as if their subscription were
  // the problem - could be reintroduced and merged with two green ticks.
  platform: NodeJS.Platform = process.platform,
): Resolved | null {
  const win = platform === 'win32';
  const known = win
    ? [
        join(env['APPDATA'] ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'),
        join(env['LOCALAPPDATA'] ?? '', 'Programs', 'claude'),
        join(env['APPDATA'] ?? '', 'npm'),
      ]
    : [
        join(env['HOME'] ?? '', '.local', 'bin'),
        join(env['HOME'] ?? '', '.claude', 'local'),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
      ];
  const dirs = [...known, ...(env['PATH'] ?? '').split(delimiter).filter(Boolean)];
  // Pass one: anything directly executable.
  for (const ext of win ? ['.exe', ''] : ['']) {
    for (const d of dirs) { const p = join(d, 'claude' + ext); if (exists(p)) return { path: p, shimOnly: false }; }
  }
  // Pass two: a shim, reported and not used.
  if (win) {
    for (const d of dirs) { const p = join(d, 'claude.cmd'); if (exists(p)) return { path: p, shimOnly: true }; }
  }
  return null;
}

/** The result of one child process. */
interface Ran { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly spawnError: string | null; readonly timedOut: boolean }

/**
 * A directory with nothing in it, for the child to run in.
 *
 * ★ THE CHILD INHERITED WHATEVER DIRECTORY THE APP WAS LAUNCHED FROM, AND THE CLI READS THE
 * DIRECTORY IT IS IN. `CLAUDE.md`, `.claude/`, a project `.mcp.json` — all of it applies to a
 * plain `spawn` with no `cwd`.
 *
 * MEASURED 2026-08-12: a delegate turn driven from inside this repository answered "Monitor
 * completed cleanly. No action needed." — a sentence out of the maintainer's own tooling context,
 * with nothing to do with the workspace it was asked about. Shipped, the directory would be
 * wherever the person happened to start the app: their home, their desktop, a project of theirs.
 *
 * A delegate answers from the CHANNEL it was given and the substrate it can reach. Anything the
 * filesystem contributes is contamination, and on somebody else's machine it is contamination
 * nobody can see in the record afterwards.
 *
 * ★★ AND WHEN THERE IS A GATE, THE AGENT'S OWN WORKSPACE IS THE NEUTRAL DIRECTORY — see
 * {@link turnCwd}. A shared temp directory is neutral in the sense this comment meant, and wrong
 * in a way that was not discovered until a third adversarial review.
 */
export function neutralCwd(): string {
  const dir = join(tmpdir(), 'interego-turn');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where a turn actually runs.
 *
 * ★★ THE GATE'S POLICY IS ANCHORED ON THE WORKSPACE, SO THE AGENT HAS TO BE STANDING IN IT.
 *
 * MEASURED against the shipped app: the CLI was spawned in {@link neutralCwd} — a shared temp
 * directory — while the gate's only permitted root was `<userData>/agent-workspaces/<id>`. Every
 * relative path in every tool call therefore resolved into the temp directory, which is inside no
 * root, so in the INSTALLED app:
 *
 *     echo INSIDE > made.txt      → ask        (the module header's own example of ordinary work)
 *     cat package.json            → ask
 *     Write { file_path: 'notes.txt' } → ask
 *
 * The delegate could barely do anything without queuing a request. Three probes and 69 tests
 * missed it because every one of them passed the workspace AS the cwd — the configuration
 * production does not use. That is the third time a convenient test fixture hid a production
 * truth in this work.
 *
 * The workspace is neutral in the sense the comment above cares about: it is a directory this app
 * created, holding nothing of the person's, with no `CLAUDE.md` and no `.claude/` to leak in. It
 * is simply also the right one.
 */
export function turnCwd(gate?: TurnGate): string {
  return gate?.workspace ?? neutralCwd();
}

function run(bin: string, args: readonly string[], opts: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly stdin?: string; readonly onChild?: (kill: () => void) => void; readonly cwd?: string }): Promise<Ran> {
  return new Promise((resolve) => {
    let cp;
    try {
      // shell:false, always. A shell would re-expand arguments, and the text flowing through here
      // is written by other members of a workspace.
      cp = spawn(bin, [...args], { env: opts.env, cwd: opts.cwd ?? neutralCwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: (e as Error).message, timedOut: false });
      return;
    }
    let stdout = '', stderr = '', done = false;
    const finish = (r: Ran): void => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { cp.kill(); finish({ code: null, stdout, stderr, spawnError: null, timedOut: true }); }, opts.timeoutMs);
    opts.onChild?.(() => { cp.kill(); });
    cp.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    cp.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    // ★ ALL THREE STREAMS, NOT JUST STDIN. The first version guarded `stdin` alone; a review
    // pointed out that `stdout` and `stderr` are torn down on exactly the same two paths — the
    // timeout above and the cancel kill — and an `error` on a Readable with no listener throws
    // into a main process that has no `uncaughtException` handler, taking the window with it.
    cp.stdout.on('error', () => { /* the child is gone; `close` reports it */ });
    cp.stderr.on('error', () => { /* likewise */ });
    cp.on('error', (e) => finish({ code: null, stdout, stderr, spawnError: e.message, timedOut: false }));
    cp.on('close', (code) => finish({ code, stdout, stderr, spawnError: null, timedOut: false }));
    // ★ A WRITE TO A CHILD THAT ALREADY EXITED MUST NOT TAKE DOWN THE APP. Without this listener
    // an EPIPE on the child's stdin is an unhandled stream error, and Electron's main process has
    // no `uncaughtException` handler — so a child that rejects a flag and exits before the prompt
    // drains, or one killed by `agent:cancel` mid-write, would crash the whole window rather than
    // failing one turn. The close/error handlers above already report the real outcome.
    cp.stdin.on('error', () => { /* the child is gone; `close` below is what reports it */ });
    // The prompt goes in on stdin rather than argv: it is other people's text, it can be long, and
    // Windows has a command-line length limit that a busy channel would eventually cross.
    cp.stdin.end(opts.stdin ?? '');
  });
}

/**
 * What this machine can actually do, with every unknown left as an unknown.
 *
 * ★ `loggedIn` IS `null` WHEN NOT ESTABLISHED, NOT `false`. If the CLI is not installed, whether
 * the user has a subscription is not a thing this app has any evidence about. Rendering that as
 * "not logged in" would be a statement about their account made from a filesystem check.
 */
export interface ProviderStatus {
  readonly id: ProviderId;
  readonly label: string;
  readonly installed: boolean;
  readonly path: string | null;
  readonly shimOnly: boolean;
  readonly loggedIn: boolean | null;
  /** From the CLI's own answer. `claude.ai` is a subscription; `console` would be API billing. */
  readonly authMethod: string | null;
  readonly account: string | null;
  readonly subscription: string | null;
  /** Always populated: what is established, and what to do about it if it is not enough. */
  readonly why: string;
  readonly usable: boolean;
}

const CLAUDE_LABEL = 'Claude Code (your own Claude subscription)';

/**
 * @param onChild handed the probe's own kill function.
 *
 * ★ THE PROBE HAS A CHILD TOO, AND NOT PLUMBING IT MADE "OFF" A LIE FOR TWENTY SECONDS. A turn
 * begins inside this call, whose own `claude auth status` runs under a 20-second timeout. The main
 * process's comment claimed there was "no child of its own to kill yet"; there was one, it was
 * simply unreachable, so a cancel in that window was recorded and not effected.
 */
export async function probeClaude(
  env: NodeJS.ProcessEnv = childEnv(),
  onChild?: (kill: () => void) => void,
): Promise<ProviderStatus> {
  const base = { id: 'claude-code' as const, label: CLAUDE_LABEL, shimOnly: false, loggedIn: null, authMethod: null, account: null, subscription: null };
  const found = resolveClaudeCli(env);
  if (!found) {
    return {
      ...base, installed: false, path: null, usable: false,
      why: 'The Claude Code CLI was not found on this machine. Install it with `npm install -g @anthropic-ai/claude-code`, '
        + 'then run `claude` once and sign in with your Claude account. Whether you have a subscription is not something this app can see until then.',
    };
  }
  if (found.shimOnly) {
    return {
      ...base, installed: true, path: found.path, shimOnly: true, usable: false,
      why: 'Claude Code is installed at ' + found.path + ', but only as a .cmd shim, which this app will not run: '
        + 'Node refuses to launch one without a shell, and passing a workspace channel through a shell is not something this app will do. '
        + 'Reinstalling with `npm install -g @anthropic-ai/claude-code` normally puts a claude.exe alongside it.',
    };
  }
  const r = await run(found.path, ['auth', 'status', '--json'], { env, timeoutMs: 20_000, ...(onChild ? { onChild } : {}) });
  if (r.spawnError || r.timedOut) {
    return {
      ...base, installed: true, path: found.path, usable: false,
      why: 'Claude Code is at ' + found.path + ' but did not answer when asked whether it is signed in ('
        + (r.timedOut ? 'it did not finish within 20 seconds' : r.spawnError) + '). Nothing is assumed about your account either way.',
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(r.stdout) as Record<string, unknown>; } catch { parsed = null; }
  if (!parsed || typeof parsed['loggedIn'] !== 'boolean') {
    return {
      ...base, installed: true, path: found.path, usable: false,
      why: 'Claude Code answered, but not with a sign-in status this app could read (' + (r.stdout || r.stderr).trim().slice(0, 160)
        + '). Whether you are signed in is therefore not established.',
    };
  }
  const loggedIn = parsed['loggedIn'] === true;
  const authMethod = typeof parsed['authMethod'] === 'string' ? parsed['authMethod'] : null;
  const account = typeof parsed['email'] === 'string' ? parsed['email'] : null;
  const subscription = typeof parsed['subscriptionType'] === 'string' ? parsed['subscriptionType'] : null;
  if (!loggedIn) {
    return {
      ...base, installed: true, path: found.path, loggedIn: false, authMethod, usable: false,
      why: 'Claude Code is installed but not signed in. Open a terminal and run `claude auth login` — that signs in with your own '
        + 'Claude account in a browser. This app never sees the credential; the CLI keeps it and refreshes it itself.',
    };
  }
  return {
    id: 'claude-code', label: CLAUDE_LABEL, installed: true, path: found.path, shimOnly: false,
    loggedIn: true, authMethod, account, subscription, usable: true,
    why: 'Signed in as ' + (account ?? 'an account this CLI did not name')
      + (subscription ? ' on a ' + subscription + ' subscription' : '')
      + (authMethod ? ' (' + authMethod + ')' : '')
      + '. Your agent runs on this credential — your own — and nothing is billed to anybody else.',
  };
}

/**
 * The Codex entry, present so the UI can say something true about it.
 *
 * ★ DELIBERATELY NOT A PROBE, AND THE REASON IS NOT "WE DID NOT GET TO IT". Codex was researched
 * against its own source at `openai/codex` before this was written, and the shape is genuinely
 * there: `codex exec --json` is a documented non-interactive mode, `$CODEX_HOME/auth.json` holds a
 * real Sign-in-with-ChatGPT OAuth bundle rather than an API key, the official SDK's `apiKey` is
 * optional and a child that omits it rides the user's own login, and `codex app-server` is a
 * JSON-RPC surface OpenAI explicitly offers for embedding in third-party apps.
 *
 * Three things stopped it becoming a provider here:
 *
 *   · IT IS NOT ON THIS MACHINE, so not one line of it could be measured. Every claim above is
 *     read from source and issue trackers, not observed. Shipping a picker entry on that footing
 *     is the difference between a capability and a claim.
 *   · IT DOES NOT FAIL FAST WHEN LOGGED OUT. `codex exec` has no auth preflight — missing
 *     credentials become an unauthenticated provider, and the 401 is retried for about twenty
 *     seconds before exit 1 with no machine-readable code (openai/codex#30514, open). The Claude
 *     path answers "not logged in" in 1.2 s with a parseable body; matching that for Codex needs a
 *     separate `codex doctor --json` preflight, which is exactly the kind of thing that must be
 *     measured rather than written from a doc.
 *   · WHETHER OPENAI PERMITS IT IS UNRESOLVED. Their terms ban programmatically extracting output
 *     without defining it, their auth doc recommends API keys for programmatic CLI use, and every
 *     request for a definitive answer on their own tracker has gone unanswered. That is not a
 *     refusal, but it is not a yes, and it is not this app's to assume.
 *
 * When someone installs it and drives it end to end, it gets an entry. Until then the UI says it
 * is not supported here, which is true.
 */
export const CODEX_UNSUPPORTED = {
  id: 'codex' as const,
  label: 'OpenAI Codex',
  why: 'Not supported by this app. Codex does have a non-interactive mode that reads your own ChatGPT sign-in, so this is not a '
    + 'statement that it cannot work — but nothing here has ever run it, and a path nobody has driven is not one to offer you. '
    + 'Only Claude Code has been measured end to end.',
} as const;

/** One model turn. */
export interface ModelRun {
  readonly ok: boolean;
  readonly text: string | null;
  readonly why: string;
  readonly ms: number;
  /**
   * The CLI's own reply, verbatim, for whatever wants to read more of it than `text`.
   *
   * ★ MEASURED (`tools/probe-turn-usage.ts`): the reply already carries usage.input_tokens,
   * output_tokens, cache_read_input_tokens, cache_creation_input_tokens, num_turns,
   * total_cost_usd, duration_ms, ttft_ms, session_id and a per-model breakdown. All of it was
   * being parsed and thrown away because only `result` was read — so "we have no telemetry" was a
   * reporting gap rather than a measurement problem. Kept whole rather than picked apart here, so
   * that `telemetry.ts` owns the interpretation and this file stays about running the child.
   */
  readonly reply?: Record<string, unknown>;
}

/**
 * Ask the user's own signed-in Claude for one answer.
 *
 * `--tools ""` gives the child NO tools: it cannot read a file, run a command or reach the
 * network. It is being asked to write a sentence, and a process that could do more than that
 * running unattended on somebody's machine is a different product.
 *
 * `--no-session-persistence` keeps an unattended loop from writing a session transcript per turn
 * into the user's `~/.claude` — measured working with subscription auth, unlike `--bare`.
 */
/**
 * The arguments one turn is run with.
 *
 * ★ A SEPARATE, EXPORTED, PURE FUNCTION SO THE ABSENCE OF ONE FLAG IS TESTABLE. The property that
 * matters most here is a NEGATIVE — that `--bare` is never present — and a negative about an argv
 * cannot be checked by spawning: on a machine where the CLI is signed in, adding `--bare` breaks
 * every user's agent while leaving a live driver green, because its effect is an auth failure the
 * driver's own box would never see. So the argv is a value, and `tests/workspace-desktop-
 * modelprovider.test.ts` asserts on the array rather than grepping this file.
 */
/**
 * The built-in tools a delegate must never have, named one by one.
 *
 * ★ NAMED AND DENIED, BECAUSE AN ALLOWLIST DOES NOT EXCLUDE THEM. `--allowedTools` is an
 * AUTO-APPROVE list, not a restriction — measured 2026-08-12 with `--allowedTools mcp__interego`
 * as the only entry, the child was asked to attempt three things and answered `BASH: hello`. Read
 * and Write were refused and Bash was not; a shell reads any file the refused Read would have.
 *
 * `--tools ""`, which is what kept them out before, cannot be used any more: the same measurement
 * showed it also removes MCP servers ("SERVERS: NONE"), which is precisely why a delegate has had
 * no tools at all.
 */
export const DENIED_BUILTINS = [
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'SlashCommand', 'ExitPlanMode',
] as const;

/**
 * One MCP server the turn may use, and nothing else.
 *
 * The path is a file this process wrote; `server` is the key inside it. Both are supplied by the
 * caller so this module never learns what a relay or a delegate is.
 */
export interface TurnTools {
  readonly mcpConfigPath: string;
  readonly server: string;
}

/**
 * Where the composed permission gate lives for this turn.
 *
 * ★ PATHS, NOT POLICY. The rules are in `permission.ts` and the decision is made by a hook in its
 * own process; this file only has to know which two files to point the CLI at. Keeping the policy
 * out of the argv builder is what stops a second, drifting copy of "what an agent may do" from
 * growing here — the same reason the MCP grant names a SERVER rather than a list of tools.
 */
export interface TurnGate {
  /** The settings JSON installing the PreToolUse hook. See `gateSettings`. */
  readonly settingsPath: string;
  /** The directory the agent owns, passed to `--add-dir`. */
  readonly workspace: string;
}

/**
 * What a delegate's turn runs on.
 *
 * ── ★ NAMED IN FULL, NOT AS AN ALIAS ────────────────────────────────────────
 *
 * `--model` accepts `opus`, which resolves to whatever the CLI currently calls the latest Opus.
 * That is the right default for a person at a terminal and the wrong one here: a delegate writes
 * PERMANENT, PUBLIC, SIGNED entries under somebody's name, and the model that wrote each one is
 * recorded in its `ieh:AgentTurn` graph. An alias would silently re-point that record at a
 * different model on a CLI upgrade, and nothing in the log would show the day it changed.
 *
 * ★ VERIFIED LIVE, not assumed: `claude -p --model claude-opus-5 --effort high` returned
 * `is_error: false` and reported `claude-opus-5` in its own `modelUsage`. A wrong string here
 * fails every turn, so it is checked against the CLI rather than against memory.
 */
export const TURN_MODEL = 'claude-opus-5';

/**
 * How hard it thinks.
 *
 * ★ `high` IS THE REGULAR SETTING — the API's own default, equivalent to omitting the parameter.
 * It is stated explicitly rather than left off so the turn does not silently inherit whatever this
 * machine's CLI defaults to (Claude Code's own default is `xhigh`, which is not what a delegate
 * answering a chat message needs). `low`/`medium` below it, `xhigh`/`max` above.
 *
 * Thinking itself needs no flag: it is adaptive on this model and on by default in the CLI, so
 * there is nothing here to turn on and nothing to budget.
 */
export const TURN_EFFORT = 'high';

export function turnArgv(args: {
  readonly model?: string;
  /** One of low | medium | high | xhigh | max. Defaults to {@link TURN_EFFORT}. */
  readonly effort?: string;
  readonly systemPrompt?: string;
  /** Omitted: the turn writes a sentence and can reach nothing, which is the old behaviour. */
  readonly tools?: TurnTools;
  /** Omitted: the built-ins are denied outright, which is what shipped before the gate existed. */
  readonly gate?: TurnGate;
}): string[] {
  return [
    '-p',
    '--model', args.model ?? TURN_MODEL,
    '--effort', args.effort ?? TURN_EFFORT,
    // NEVER add the flag that makes the CLI read only an API key — see footgun 1 in the header.
    // It disables OAuth, which is the entire credential this feature runs on.
    ...(args.tools
      ? [
        '--mcp-config', args.tools.mcpConfigPath,
        /**
         * ★ THE SECURITY FLAG, AND THE CONTROL THAT PROVES IT. Without `--strict-mcp-config` the
         * child inherits every MCP server its human is signed into: the same measurement run
         * without it reported "claude.ai Gmail, claude.ai Google Drive, claude.ai robinhood,
         * claude.ai Intuit TurboTax…" and answered YES to "can you see a gmail tool". A delegate
         * is authorised to act on its human's POD; it is not authorised to read their mail.
         *
         * This is the ONE thing the permission gate below does not replace. A gate decides whether
         * a call may proceed; it cannot decide whether a whole connector should have been in the
         * agent's reach at all, and a delegate driven by a channel should never see its human's
         * accounts. Two different questions, two different mechanisms, both kept.
         */
        '--strict-mcp-config',
        '--allowedTools', 'mcp__' + args.tools.server,
        ...(args.gate
          ? [
            /**
             * ★ A NORMAL AGENT BEHIND A GATE, WHICH REPLACES DENYING ITS HANDS.
             *
             * This used to be `--disallowedTools <every built-in>`: no Bash, no Read, no Write. It
             * was safe and it was useless — the delegate could not convert a drawing, look at a
             * file it was pointed at, or do anything an ordinary session does, and every real task
             * ended in a refusal or a timeout.
             *
             * `--settings` installs a PreToolUse hook in front of EVERY tool. Measured
             * (`probe-permission-gate.ts`): it fires under `-p`, receives the full call, and its
             * `deny` genuinely stops the tool. The policy is in `permission.ts` and the four
             * answers are allow / granted / deny / ask, with "ask" as the fallback so a tool
             * nobody anticipated reaches the human rather than the machine.
             */
            '--settings', args.gate.settingsPath,
            /**
             * ★ THE PERSON'S OWN SETTINGS MUST NOT APPLY TO A CHANNEL-DRIVEN AGENT. A developer's
             * `~/.claude/settings.json` is written for work they are watching, and may permit
             * anything. Loading none of it means the only policy in force is the one this app
             * composed for this delegate, for this turn.
             */
            '--setting-sources', '',
            /** The one directory it owns. Created by `readPolicy`, and the gate's `allow` case. */
            '--add-dir', args.gate.workspace,
            /**
             * ★ `default`, NOT `dontAsk`. `dontAsk` is what an agent with no tools needed; with a
             * gate it would be asking the CLI to skip the very check that makes this safe. The
             * hook is what answers, and there is no prompt for a human to miss.
             */
            '--permission-mode', 'default',
          ]
          : [
            // No gate composed: fall back to the old posture rather than to an ungated agent.
            // ★ THE DIRECTION MATTERS. A missing policy must narrow what is possible, never widen
            // it — a caller that forgot to build one gets an agent that can write a sentence.
            '--disallowedTools', ...DENIED_BUILTINS,
            '--permission-mode', 'dontAsk',
          ]),
      ]
      : ['--tools', '']),           // no tools at all: it writes a sentence
    '--no-session-persistence',     // an unattended loop must not litter the user's ~/.claude
    '--output-format', 'json',
    ...(args.systemPrompt ? ['--append-system-prompt', args.systemPrompt] : []),
  ];
}

export async function runClaude(args: {
  readonly binary: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The delegate's own MCP config for this turn, from {@link withAgentTools}.
   *
   * Forwarded to `turnArgv` with the rest of `args`. It was reaching the argv before it was
   * declared here — the whole object is passed through — so a caller supplying it got the right
   * behaviour and no type to check it against. Declared because the difference between a turn
   * with tools and one without is the difference between an agent that can read the substrate and
   * one that guesses.
   */
  readonly tools?: TurnTools;
  /** The composed permission gate for this turn. Forwarded to `turnArgv` with the rest of args. */
  readonly gate?: TurnGate;
  /** Handed a kill function so a user who turns the agent off mid-thought actually stops it. */
  readonly onChild?: (kill: () => void) => void;
}): Promise<ModelRun> {
  const t0 = Date.now();
  const argv = turnArgv(args);
  const r = await run(args.binary, argv, {
    env: args.env ?? childEnv(),
    // ★ The agent stands in its OWN workspace when it has a gate — see `turnCwd`. Spawning it in
    // a shared temp directory made every relative path in every tool call land outside the only
    // permitted root, so ordinary work was refused in the installed app.
    cwd: turnCwd(args.gate),
    /**
     * ★ 120 s WAS SET BEFORE A DELEGATE HAD TOOLS, and it started killing real turns.
     *
     * MEASURED in a live channel: asked to produce a picture, the agent was stopped at 120 seconds
     * with nothing written. A turn is no longer one model call — it can be several MCP round trips
     * against the relay, each a network hop, before a word is drafted. `drive-agent-tools-live.ts`
     * has used 240 s since tools landed and has never timed out.
     *
     * A ceiling still has to exist: this is a child process on somebody's laptop, spawned by a
     * poll loop, and one that never returns would hold the turn open forever.
     */
    timeoutMs: args.timeoutMs ?? 240_000,
    stdin: args.prompt,
    ...(args.onChild ? { onChild: args.onChild } : {}),
  });
  const ms = Date.now() - t0;
  if (r.timedOut) return { ok: false, text: null, ms, why: 'Your agent did not answer within ' + Math.round((args.timeoutMs ?? 240_000) / 1000) + ' seconds and was stopped. Nothing was written.' };
  if (r.spawnError) return { ok: false, text: null, ms, why: 'Claude Code could not be started: ' + r.spawnError + '. Nothing was written.' };
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(r.stdout) as Record<string, unknown>; } catch { j = null; }
  if (!j) {
    return { ok: false, text: null, ms, why: 'Claude Code answered with something this app could not read as a result: ' + (r.stdout || r.stderr).trim().slice(0, 200) };
  }
  // The CLI reports a failed turn INSIDE a successful process — "Not logged in" comes back as
  // is_error with exit 1 and a parseable body. Reading only the exit code would turn a sign-in
  // problem into "malformed output", which sends the user looking in the wrong place.
  if (j['is_error'] === true) {
    return { ok: false, text: null, ms, why: 'Claude Code refused this turn: ' + String(j['result'] ?? 'no reason given') + '. Nothing was written.' };
  }
  const text = typeof j['result'] === 'string' ? j['result'] : null;
  if (text === null) {
    return { ok: false, text: null, ms, why: 'Claude Code reported success but returned no text, so there is nothing to post.' };
  }
  return { ok: true, text, ms, reply: j, why: 'Answered in ' + (ms / 1000).toFixed(1) + 's on your own credential.' };
}
