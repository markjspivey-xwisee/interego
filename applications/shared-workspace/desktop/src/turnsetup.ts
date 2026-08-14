/**
 * HOW A TURN IS WIRED TO ITS PERMISSION GATE — THE PRODUCTION PATH, MADE TESTABLE.
 *
 * ── ★★ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 *
 * This code lived in `main.ts`, which imports `electron`, so nothing could import it and nothing
 * ever tested it. Three separate adversarial reviews then found three defects that all had the
 * same shape — the TEST built one configuration and PRODUCTION used another:
 *
 *   1. the never-list held the userData root, so the agent's real workspace was forbidden and
 *      every Read/Write in it was denied — invisible, because every test built its workspace in a
 *      temp directory
 *   2. the path scanner refused `cat src/index.ts` — invisible, because the live probe's one
 *      ordinary command was `echo INSIDE > made.txt`, with no separator in it
 *   3. the CLI was spawned in a shared temp directory while the policy's only root was the
 *      workspace, so every relative path was outside the boundary — invisible, because all three
 *      probes and all 69 tests passed the workspace AS the cwd
 *
 * Each was found by a person reading code, never by a test, and each was live in the installed app.
 * The common cause is not carelessness about any one of them: it is that the wiring which decides
 * all three was unreachable from a test, so every test had to invent its own version of it.
 *
 * So the two electron-shaped things — where userData is, and where the bundle sits — are
 * parameters now, and `tests/workspace-desktop-permission.test.ts` composes a real gate from this
 * function and asserts ordinary work is permitted under the values PRODUCTION computes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { gateSettings, writeGateConfig } from './gate.js';
import { readPolicy, requestsDir } from './permission.js';
import type { TurnGate } from './modelprovider.js';

/**
 * Which runtime the hook is started with — `node` if this machine has a working one, else this
 * app's own Electron binary.
 *
 * ★★ THE HOOK RUNS ONCE PER TOOL CALL, SO ITS STARTUP COST IS MULTIPLIED BY EVERY TOOL AN AGENT
 * USES. MEASURED with `tools/probe-gate-cost.ts` on this machine:
 *
 *     plain node                        115 ms per call   →  4.6 s across a 40-call turn
 *     this app's Electron binary        209 ms per call   →  8.4 s across a 40-call turn
 *     (that binary is 180 MB on disk)
 *
 * Nearly two seconds of every ten spent starting a browser engine to answer a yes/no question. The
 * Electron path has to stay, because a packaged desktop app genuinely cannot assume `node` is on
 * the PATH — but where one exists it is half the cost and a fraction of the image.
 *
 * ★ AND THE CANDIDATE IS RUN BEFORE IT IS TRUSTED. A `node` on the PATH might be a shim, a wrapper,
 * or a broken install; discovering that per tool call, inside a hook whose failure means the turn
 * gets no tools, would be a bad place to find out. So it is executed once here and only used if it
 * answers. That check costs one process per TURN, against saving one per tool call.
 *
 * ★ THIS IS AN OPTIMISATION, NOT A SAFETY CHANGE. Whichever runtime is chosen runs the same gate
 * with the same policy. If the choice is ever wrong the hook fails to start, and a hook that
 * cannot start already denies — see the fail-closed case in `probe-gated-agent.ts`.
 */
let cachedRuntime: string | null = null;

export function gateRuntime(): string {
  /**
   * ★★ PROBED ONCE PER PROCESS, NOT ONCE PER TURN — AND CI IS WHAT NOTICED.
   *
   * This spawns candidate runtimes to check they answer, which is the right way to avoid trusting
   * a broken `node` on the PATH. But it was called from `writeGateLauncher`, which is called from
   * `composeGate`, which runs on EVERY TURN — so the thing added to cut per-tool-call startup cost
   * was itself paying a process spawn per turn, and on a cold Linux runner enough of them to blow
   * a 5-second test timeout (5054 ms, first call only; every later one was 30 ms).
   *
   * Which runtime exists does not change while the app is running, so the answer is cached. If it
   * is ever wrong the hook fails to start, and a hook that cannot start already denies.
   */
  if (cachedRuntime !== null) return cachedRuntime;
  const probe = (exe: string): boolean => {
    try {
      const r = spawnSync(exe, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 5_000 });
      return String(r.stdout ?? '').trim() === 'ok';
    } catch { return false; }
  };
  /**
   * ★★ AN ABSOLUTE PATH, NEVER A BARE NAME — AND THE FIRST VERSION OF THIS RETURNED `node.exe`.
   *
   * That resolved fine when probed from a terminal and would have been written into the launcher
   * as a bare name, leaving `cmd.exe` to find it through PATH AT HOOK TIME. A GUI-launched app
   * does not inherit the PATH a terminal has — this repository already documents that footgun for
   * the CLI resolver, where a Finder-launched bundle gets a minimal one. The failure would have
   * appeared only on a packaged install started from the Start Menu, as a gate that cannot start,
   * which fails closed and leaves the agent with no tools. Working here and broken when installed
   * is the shape of bug this work has shipped three times already.
   */
  const win = process.platform === 'win32';
  const name = win ? 'node.exe' : 'node';
  const known = win
    ? [join(process.env['ProgramFiles'] ?? '', 'nodejs', name),
       join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'nodejs', name)]
    : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];
  const onPath = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((d) => join(d, name));
  for (const c of [...known, ...onPath]) {
    if (c && isAbsolute(c) && existsSync(c) && probe(c)) { cachedRuntime = c; return c; }
  }
  cachedRuntime = process.execPath;
  return cachedRuntime;
}

/** Forget the cached runtime. For tests that need the probe to run again. */
export function resetGateRuntime(): void { cachedRuntime = null; }

/**
 * Write the little script that runs the hook.
 *
 * ★ A SCRIPT, NOT A COMMAND STRING, FOR TWO MEASURED REASONS. The hook is run by a bare process
 * with no Electron and no bundler, and there is no guarantee somebody running a packaged desktop
 * app has `node` on their PATH — most do not. The runtime certainly present is the one already
 * executing, and Electron only behaves as plain Node when `ELECTRON_RUN_AS_NODE` is set — which is
 * the same flag `childEnv()` deliberately strips from the model child, and which the hook would
 * otherwise inherit stripped.
 *
 * ★ AND IT CANNOT BE SET INLINE. `VAR=1 prog` is shell syntax POSIX understands and `cmd.exe` does
 * not, and the hook command is run by whatever shell the CLI picks. A tiny script per platform is
 * the one form that works on both, and it can be read by somebody wondering what the app just put
 * on their disk.
 *
 * ★ IF THIS IS WRONG THE GATE DOES NOT RUN, so `probe-gated-agent.ts` includes a case where the
 * hook is deliberately broken — a permission system whose failure mode is "allow" is decoration.
 */
export function writeGateLauncher(dir: string, gateScript: string, cfgPath: string, exe = gateRuntime()): string {
  if (process.platform === 'win32') {
    const p = join(dir, 'gate.cmd');
    writeFileSync(p, [
      '@echo off',
      'set ELECTRON_RUN_AS_NODE=1',
      '"' + exe + '" "' + gateScript + '" "' + cfgPath + '"',
    ].join('\r\n'), { mode: 0o700, encoding: 'utf8' });
    return p;
  }
  const p = join(dir, 'gate.sh');
  writeFileSync(p, [
    '#!/bin/sh',
    'ELECTRON_RUN_AS_NODE=1 exec ' + JSON.stringify(exe) + ' ' + JSON.stringify(gateScript) + ' ' + JSON.stringify(cfgPath),
  ].join('\n'), { mode: 0o700, encoding: 'utf8' });
  return p;
}

/**
 * Compose the permission gate for one turn.
 *
 * ★ PER TURN, NOT PER SESSION, because the CONTEXT changes every time. A grant is answered by a
 * person looking at "Claude Desktop wants to run `npm install` — because goldenfleece asked X in
 * #house". That last clause is what makes the request answerable rather than an anonymous dialog,
 * and it is different for every ask.
 *
 * The grants and the nominated directories are read fresh here too, so an approval given a moment
 * ago is in force on the next turn without restarting anything — which is the whole point of a
 * permission that outlives the turn.
 */
export function composeGate(args: {
  readonly userData: string;
  /** Where `gate.mjs` was built to — `__dirname` in the app, `dist/` in a test. */
  readonly bundleDir: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly askedBy: string;
  readonly channel: string;
  /** Stamped onto every audit line so a turn's cost and its tool calls can be joined exactly. */
  readonly turnId?: string;
}): TurnGate {
  const policy = readPolicy(args.userData, args.agentId);
  const dir = join(args.userData, 'agent-gate', args.agentId.replace(/[^a-zA-Z0-9-]/g, '_'));
  mkdirSync(dir, { recursive: true });

  const cfgPath = writeGateConfig(dir, {
    policy,
    requestsDir: requestsDir(args.userData),
    auditPath: join(args.userData, 'agent-audit.jsonl'),
    context: {
      agentName: args.agentName, askedBy: args.askedBy, channel: args.channel,
      ...(args.turnId ? { turnId: args.turnId } : {}),
    },
  });

  /**
   * ★ THE GATE IS COPIED OUT OF THE BUNDLE BEFORE IT IS RUN.
   *
   * `__dirname` in a packaged app is inside `app.asar`. Electron patches `fs` so its own code can
   * read from there — but the launcher runs Electron with `ELECTRON_RUN_AS_NODE=1`, which is plain
   * Node, and plain Node has never heard of an asar. The hook would fail to start on a packaged
   * install while working perfectly from source, which is the worst shape a bug can have.
   *
   * Copied to `userData` — a real directory on a real filesystem — and refreshed whenever the
   * bundled one differs, so an app update cannot leave an old gate enforcing an old policy.
   */
  const bundled = join(args.bundleDir, 'gate.mjs');
  const gateScript = join(dir, 'gate.mjs');
  try {
    const want = readFileSync(bundled, 'utf8');
    const have = existsSync(gateScript) ? readFileSync(gateScript, 'utf8') : '';
    if (want !== have) writeFileSync(gateScript, want, { mode: 0o700, encoding: 'utf8' });
  } catch (e) {
    // ★ AND IF IT CANNOT BE PLACED, THE TURN GETS NO TOOLS RATHER THAN UNGATED ONES.
    throw new Error('the permission gate could not be prepared (' + ((e as Error)?.message ?? String(e))
      + '), so this delegate is not being given tools this turn');
  }
  const launcher = writeGateLauncher(dir, gateScript, cfgPath);
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, gateSettings(launcher), { mode: 0o600, encoding: 'utf8' });
  return { settingsPath, workspace: policy.workspace };
}
