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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateSettings, writeGateConfig } from './gate.js';
import { readPolicy, requestsDir } from './permission.js';
import type { TurnGate } from './modelprovider.js';

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
export function writeGateLauncher(dir: string, gateScript: string, cfgPath: string, exe = process.execPath): string {
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
}): TurnGate {
  const policy = readPolicy(args.userData, args.agentId);
  const dir = join(args.userData, 'agent-gate', args.agentId.replace(/[^a-zA-Z0-9-]/g, '_'));
  mkdirSync(dir, { recursive: true });

  const cfgPath = writeGateConfig(dir, {
    policy,
    requestsDir: requestsDir(args.userData),
    auditPath: join(args.userData, 'agent-audit.jsonl'),
    context: { agentName: args.agentName, askedBy: args.askedBy, channel: args.channel },
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
