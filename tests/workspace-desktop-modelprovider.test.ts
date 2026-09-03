/**
 * THE TWO DECISIONS THAT DECIDE WHETHER A PERSON'S OWN SUBSCRIPTION IS REACHED AT ALL.
 *
 * `modelprovider.ts` is the only part of the desktop shell that leaves the process. Almost all of
 * it is a child process and a live CLI, which is verified where it belongs —
 * `applications/shared-workspace/tools/drive-local-agent-live.ts` spawns the real `claude` on the
 * operator's own subscription and is the only thing that can prove the integration works.
 *
 * What that live driver CANNOT prove is a negative. It runs on a machine where everything is
 * installed and signed in, so it would stay green through both of the regressions below — and
 * both of them are silent, both turn "your own subscription" into "not logged in", and both are a
 * one-word edit away at all times. So they are pinned here, from the pure functions written to be
 * injectable for exactly this.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DENIED_BUILTINS, TURN_EFFORT, TURN_MODEL, childEnv, neutralCwd, resolveClaudeCli, turnArgv,
} from '../applications/shared-workspace/desktop/src/modelprovider.js';

/**
 * ★★ THE PLATFORM IS SUPPLIED, NOT DETECTED.
 *
 * This file had `const WIN = process.platform === 'win32'` and both ★ tests below opened with
 * `if (!WIN) { expect(true).toBe(true); return; }`. CI runs the root suite on ubuntu-latest
 * (.github/workflows/bridge-typecheck.yml), so on every machine that gates a merge those two
 * asserted a literal tautology and never called the resolver at all — while this file's header
 * claimed they were pinned "from the pure functions written to be injectable for exactly this".
 * The only place they executed was the maintainer's own Windows checkout, which is precisely
 * the coverage the header says it is not relying on.
 *
 * `resolveClaudeCli` now takes the platform as its third injectable, beside `env` and `exists`,
 * so the Windows behaviour is exercised everywhere.
 */
const WIN32: NodeJS.Platform = 'win32';

describe('finding the CLI without a shell', () => {
  it('★ prefers claude.exe over claude.cmd when both exist', () => {
    // MEASURED: Node 22 throws EINVAL spawning a .cmd without `shell: true`, and `shell: true`
    // would put a workspace channel — text other people wrote — through cmd.exe. npm installs BOTH
    // a shim and an executable, and the shim sorts first in APPDATA/npm, so a naive PATH walk finds
    // the unusable one. If this ever flips, every Windows user gets "Claude Code could not be
    // started: spawn EINVAL" and no indication that their subscription is fine.
    // ★ The candidate paths are built with `join`, exactly as the resolver builds them, because
    // `join` uses the HOST separator. Hard-coding `C:\A\npm\claude.cmd` matches on Windows and
    // nothing on Linux — which is where CI runs, so the first version of this un-guarded test
    // failed there. The platform under test is injected; the path syntax still is not.
    const env = { APPDATA: 'C:\\A', PATH: join('C:\\A', 'npm') };
    const cmd = join('C:\\A', 'npm', 'claude.cmd');
    const exe = join('C:\\A', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    const both = (p: string): boolean => p === cmd || p === exe;
    const got = resolveClaudeCli(env, both, WIN32);
    expect(got?.path).toContain('claude.exe');
    expect(got?.shimOnly).toBe(false);
  });

  it('★ reports a lone .cmd as a shim rather than returning it as runnable', () => {
    // Absence is not evidence, in its executable form: a shim IS evidence Claude Code is
    // installed, which is worth telling the user — but it is not something this app will run, and
    // reporting it as usable would produce an EINVAL the user cannot act on.
    const env = { APPDATA: 'C:\\A', PATH: join('C:\\A', 'npm') };
    const cmd = join('C:\\A', 'npm', 'claude.cmd');
    const got = resolveClaudeCli(env, (p) => p === cmd, WIN32);
    expect(got?.shimOnly).toBe(true);
    expect(got?.path).toContain('claude.cmd');
  });

  it('returns null when nothing is installed, rather than a guessed path', () => {
    expect(resolveClaudeCli({ APPDATA: 'C:\\A', HOME: '/h', PATH: '' }, () => false)).toBeNull();
  });

  it('★ searches known install locations even when PATH is empty', () => {
    // A GUI-launched app does not inherit a terminal's PATH — on macOS a bundle opened from Finder
    // gets a minimal one. A resolver that trusted PATH alone would report "not installed" to every
    // user who did not launch from a terminal, which is nearly all of them.
    // ★ BOTH PLATFORMS, NOT WHICHEVER ONE IS RUNNING. This branched on the host, so each run
    // asserted half of it and CI only ever saw the POSIX half — the same coverage gap as the
    // two tautologies above, one step less obvious because both branches did assert something.
    // ★ The expected paths are built with `join`, not written out. `resolveClaudeCli` composes
    // its known locations with `join`, which uses the HOST separator — so a hard-coded
    // '/usr/local/bin/claude' never matches when the suite runs on Windows, and that is exactly
    // why the original branched on the host and only ever checked half of itself.
    const cases: ReadonlyArray<readonly [NodeJS.Platform, NodeJS.ProcessEnv, string]> = [
      ['win32', { APPDATA: 'C:\\A', PATH: '' },
        join('C:\\A', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')],
      ['linux', { HOME: '/home/x', PATH: '' }, join('/usr/local/bin', 'claude')],
      ['darwin', { HOME: '/home/x', PATH: '' }, join('/opt/homebrew/bin', 'claude')],
    ];
    for (const [platform, env, target] of cases) {
      expect(
        resolveClaudeCli(env, (p) => p === target, platform)?.path,
        `${platform}: a known install location was not searched with an empty PATH`,
      ).toBe(target);
    }
  });
});

describe('the child environment', () => {
  it('★ strips the parent CLAUDE_CODE_* session so the child is not a nested one', () => {
    const e = childEnv({
      PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc',
      ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', KEEP: 'yes',
    });
    expect(e['CLAUDECODE']).toBeUndefined();
    expect(e['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
    expect(e['CLAUDE_CODE_ENTRYPOINT']).toBeUndefined();
    // Electron sets this on helper processes; a CLI inheriting it starts as bare Node, not itself.
    expect(e['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(e['PATH']).toBe('/usr/bin');
    expect(e['KEEP']).toBe('yes');
  });

  it('★ does not invent or strip an API key — the credential is the CLI\'s business', () => {
    // The whole claim of this integration is that the app never holds the model credential. If it
    // ever started setting one it would also start being able to bill somebody else's account.
    const e = childEnv({ PATH: '/usr/bin' });
    expect(e['ANTHROPIC_API_KEY']).toBeUndefined();
    // And one the user genuinely set for themselves is left alone rather than quietly removed.
    expect(childEnv({ ANTHROPIC_API_KEY: 'theirs' })['ANTHROPIC_API_KEY']).toBe('theirs');
  });
});

describe('the arguments a turn is run with', () => {
  it('★ never passes --bare, which silently disables subscription auth', () => {
    // MEASURED: with a valid Max subscription signed in, `claude -p --bare` returns
    // "Not logged in · Please run /login" in 78 ms. Its own help says OAuth and the keychain are
    // never read under it. It reads like a lean-startup flag and it is an auth-disabling flag.
    //
    // This is asserted on the ARRAY rather than on the file's text, because the first version of
    // this test grepped the source and failed on the comment WARNING against the flag — which is
    // a test that cannot tell a use from a prohibition, and would have had to be weakened until
    // it stopped catching the real thing.
    expect(turnArgv({})).not.toContain('--bare');
    expect(turnArgv({ model: 'opus', systemPrompt: 'x' })).not.toContain('--bare');
  });

  it('gives the child no tools and no session file', () => {
    // A process that could read a file, run a command or reach the network — unattended, on
    // somebody's laptop — is a different product from one asked to write a sentence.
    const argv = turnArgv({});
    expect(argv).toContain('--tools');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).toContain('--no-session-persistence');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    expect(argv).toContain('-p');
  });

  it('defaults the model rather than leaving the CLI to choose, and honours an override', () => {
    /**
     * ★ THE FULL NAME, NOT THE `opus` ALIAS. A delegate writes permanent, public, signed entries,
     * and the model that wrote each one is recorded in its `ieh:AgentTurn` graph. An alias would
     * re-point that record at a different model on a CLI upgrade with nothing in the log showing
     * the day it changed.
     */
    expect(turnArgv({})[turnArgv({}).indexOf('--model') + 1]).toBe(TURN_MODEL);
    expect(TURN_MODEL).toBe('claude-opus-5');
    const o = turnArgv({ model: 'opus' });
    expect(o[o.indexOf('--model') + 1]).toBe('opus');
  });

  it('★ states the effort rather than inheriting whatever this machine defaults to', () => {
    /**
     * `high` is the API's own default — the regular setting, equivalent to omitting the parameter.
     * Stated explicitly because the CLI's default is `xhigh`, so leaving the flag off would make a
     * delegate's turns depend on the machine it happens to run on. Thinking needs no flag: it is
     * adaptive on this model and on by default.
     */
    expect(turnArgv({})[turnArgv({}).indexOf('--effort') + 1]).toBe(TURN_EFFORT);
    expect(TURN_EFFORT).toBe('high');
    const e = turnArgv({ effort: 'low' });
    expect(e[e.indexOf('--effort') + 1]).toBe('low');
    // Every level the CLI documents survives the builder unchanged.
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const a = turnArgv({ effort: level });
      expect(a[a.indexOf('--effort') + 1]).toBe(level);
    }
  });

  it('★ passes a system prompt as its own argument, never concatenated into the user prompt', () => {
    // Concatenation would make the instruction indistinguishable from channel text, which is the
    // one thing the brief must not be: the entries are written by other people.
    expect(turnArgv({})).not.toContain('--append-system-prompt');
    const s = turnArgv({ systemPrompt: 'be terse' });
    expect(s[s.indexOf('--append-system-prompt') + 1]).toBe('be terse');
  });
});

/**
 * A DELEGATE'S TOOLS, AND THE THREE THINGS THAT MUST STAY TRUE WHEN IT HAS THEM.
 *
 * ★ EVERY ONE OF THESE WAS MEASURED AGAINST A REAL CHILD BEFORE IT WAS WRITTEN, because every
 * assumption in this area turned out to be wrong in a way that mattered:
 *
 *   · `--tools ""` — the flag that kept a delegate safe — ALSO removes MCP servers. A child run
 *     with it and a valid `--mcp-config` reported "SERVERS: NONE". That is why a delegate has had
 *     no tools at all, and why the flag cannot simply be kept alongside the config.
 *   · `--allowedTools` is an AUTO-APPROVE list, NOT a restriction. With `mcp__interego` as its
 *     only entry, a child asked to ATTEMPT three things answered `BASH: hello`. Read and Write
 *     were refused; the shell was not. So the built-ins are denied by name.
 *   · `--strict-mcp-config` is the security property. The control run without it saw
 *     "claude.ai Gmail, claude.ai Google Drive, claude.ai robinhood, claude.ai Intuit TurboTax…"
 *     and answered YES to "can you see a gmail tool". A delegate is authorised over its human's
 *     POD; it is not authorised to read their mail.
 *
 * The argv is a value so these can be asserted without spawning — the same reason `--bare`'s
 * absence is asserted here rather than driven.
 */
describe('turnArgv with tools: what a delegate may reach', () => {
  const TOOLS = { mcpConfigPath: '/tmp/x/mcp.json', server: 'interego' };

  it('★ never inherits the human\'s own MCP servers', () => {
    // The one flag standing between a delegate and its human's Gmail.
    expect(turnArgv({ tools: TOOLS })).toContain('--strict-mcp-config');
  });

  it('★ denies every built-in by name, because an allowlist does not exclude them', () => {
    const argv = turnArgv({ tools: TOOLS });
    expect(argv).toContain('--disallowedTools');
    for (const t of DENIED_BUILTINS) expect(argv).toContain(t);
    // Bash above all: it was the one that actually ran when only the allowlist was in place.
    expect(argv).toContain('Bash');
  });

  it('★ allows the SERVER, never a list of tool names', () => {
    // A list here would be a second copy of an authorization record. What a delegate may do is
    // its delegation scope, enforced by the relay on every call — see agent-tools.ts.
    const argv = turnArgv({ tools: TOOLS });
    const allow = argv[argv.indexOf('--allowedTools') + 1];
    expect(allow).toBe('mcp__interego');
    expect(argv.join(' ')).not.toMatch(/mcp__interego__/);
  });

  it('does not pass --tools "" alongside a config, which would remove the MCP server', () => {
    expect(turnArgv({ tools: TOOLS })).not.toContain('--tools');
  });

  it('and with NO tools it is exactly what it always was', () => {
    const argv = turnArgv({});
    expect(argv).toContain('--tools');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    expect(argv).not.toContain('--mcp-config');
    expect(argv).not.toContain('--disallowedTools');
  });

  it('runs unattended — there is nobody to answer a permission prompt', () => {
    const argv = turnArgv({ tools: TOOLS });
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  });

  it('★ still never adds the flag that would disable OAuth', () => {
    expect(turnArgv({ tools: TOOLS })).not.toContain('--bare');
  });
});

/**
 * ★ THE DIRECTORY THE CHILD RUNS IN IS PART OF ITS PROMPT.
 *
 * The CLI reads the directory it is started in — `CLAUDE.md`, `.claude/`, a project `.mcp.json`.
 * A plain `spawn` with no `cwd` inherits whatever directory the app was launched from, and
 * MEASURED 2026-08-12: a delegate turn driven from inside this repository answered "Monitor
 * completed cleanly. No action needed." — a sentence out of the maintainer's tooling context with
 * nothing to do with the workspace it was asked about. Shipped, that directory is wherever the
 * person happened to start the app.
 *
 * A delegate answers from the channel it was given and the substrate it can reach. Anything the
 * filesystem contributes is contamination, and on somebody else's machine it is contamination
 * that leaves no trace in the record.
 */
describe('neutralCwd: the child answers from the channel, not from a directory', () => {
  it('is a real directory, and not the one this process happens to be in', () => {
    const dir = neutralCwd();
    expect(existsSync(dir)).toBe(true);
    expect(resolve(dir)).not.toBe(resolve(process.cwd()));
  });

  it('★ holds none of the files the CLI would read as project context', () => {
    const dir = neutralCwd();
    for (const f of ['CLAUDE.md', '.claude', '.mcp.json', 'package.json']) {
      expect(existsSync(join(dir, f))).toBe(false);
    }
  });

  it('is under the OS temp directory, so it is not inside anybody\'s project', () => {
    expect(resolve(neutralCwd()).startsWith(resolve(tmpdir()))).toBe(true);
  });
});
