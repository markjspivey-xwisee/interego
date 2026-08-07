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
import { existsSync } from 'node:fs';
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
export function resolveClaudeCli(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): Resolved | null {
  const win = process.platform === 'win32';
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

function run(bin: string, args: readonly string[], opts: { readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly stdin?: string; readonly onChild?: (kill: () => void) => void }): Promise<Ran> {
  return new Promise((resolve) => {
    let cp;
    try {
      // shell:false, always. A shell would re-expand arguments, and the text flowing through here
      // is written by other members of a workspace.
      cp = spawn(bin, [...args], { env: opts.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    cp.on('error', (e) => finish({ code: null, stdout, stderr, spawnError: e.message, timedOut: false }));
    cp.on('close', (code) => finish({ code, stdout, stderr, spawnError: null, timedOut: false }));
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

export async function probeClaude(env: NodeJS.ProcessEnv = childEnv()): Promise<ProviderStatus> {
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
  const r = await run(found.path, ['auth', 'status', '--json'], { env, timeoutMs: 20_000 });
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
export async function runClaude(args: {
  readonly binary: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Handed a kill function so a user who turns the agent off mid-thought actually stops it. */
  readonly onChild?: (kill: () => void) => void;
}): Promise<ModelRun> {
  const t0 = Date.now();
  const argv = [
    '-p',
    '--model', args.model ?? 'sonnet',
    // See footgun 1: NEVER add --bare here.
    '--tools', '',
    '--no-session-persistence',
    '--output-format', 'json',
    ...(args.systemPrompt ? ['--append-system-prompt', args.systemPrompt] : []),
  ];
  const r = await run(args.binary, argv, {
    env: args.env ?? childEnv(),
    timeoutMs: args.timeoutMs ?? 120_000,
    stdin: args.prompt,
    ...(args.onChild ? { onChild: args.onChild } : {}),
  });
  const ms = Date.now() - t0;
  if (r.timedOut) return { ok: false, text: null, ms, why: 'Your agent did not answer within ' + Math.round((args.timeoutMs ?? 120_000) / 1000) + ' seconds and was stopped. Nothing was written.' };
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
  return { ok: true, text, ms, why: 'Answered in ' + (ms / 1000).toFixed(1) + 's on your own credential.' };
}
