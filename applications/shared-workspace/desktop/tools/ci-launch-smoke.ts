/**
 * CI LAUNCH SMOKE — start the PACKAGED desktop app headlessly, wait for its own launch marker,
 * then kill it. This is the thing `desktop-package.yml` could not do before: prove the artifact
 * LAUNCHES, not merely that it BUILDS. Two of the three platforms had never been started by
 * anyone; a binary nobody has run must not be handed to anyone.
 *
 * ★ WHY A NODE LAUNCHER AND NOT INLINE SHELL. Electron's own exit is unreliable to depend on
 * across platforms: a GPU/utility helper can outlive `app.exit()` and hold the launcher's stdout
 * open, so a bash `binary > log` waits forever and the job burns its 40-minute timeout. So pass
 * and fail are decided by the app's PRINTED marker (`SMOKE OK:` / `SMOKE FAILED:`, emitted by
 * `runLaunchSmoke` in `src/main.ts`), never by the process's exit code, and this launcher kills
 * the whole tree the moment it has its answer. One implementation covers win/mac/linux; the
 * per-OS binary path and the xvfb wrapper are supplied by the workflow.
 *
 * ★ `ELECTRON_RUN_AS_NODE` IS STRIPPED. If it is set — and every terminal an Electron-based
 * editor spawns inherits it — Electron runs as plain Node, `app` is undefined, and the window
 * never opens. GitHub runners do not set it, but stripping it makes the launcher correct wherever
 * it runs rather than only where the environment happens to be clean.
 *
 * Usage:  tsx ci-launch-smoke.ts <path-to-binary> [passthrough args...]
 */

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 120_000;
const OK = /SMOKE OK:/;
const FAILED = /SMOKE FAILED:/;

const [binary, ...passthrough] = process.argv.slice(2);
if (!binary) {
  process.stderr.write('ci-launch-smoke: usage: ci-launch-smoke.ts <binary> [args...]\n');
  process.exit(2);
}

const env: NodeJS.ProcessEnv = { ...process.env, INTEREGO_DESKTOP_SMOKE: '1' };
delete env['ELECTRON_RUN_AS_NODE'];

// `detached` on POSIX makes the child a process-group leader, so one `kill(-pid)` reaps the whole
// Electron tree (GPU + renderer + utility). On Windows the group is torn down with `taskkill /T`.
const child = spawn(binary, passthrough, {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});

let settled = false;
let seen = '';

function killTree(): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone is the ordinary case once the app self-exited on its marker.
  }
}

function finish(code: number, why: string): void {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  killTree();
  process.stdout.write(`ci-launch-smoke: ${code === 0 ? 'PASS' : 'FAIL'} — ${why}\n`);
  // ★ SET THE CODE, DO NOT ONLY SCHEDULE AN EXIT. Once the child is killed the event loop can
  // drain on its own — and a bare `process.exit(code)` on an unref'd timer loses that race and
  // exits 0, which turned a detected FAIL green. `exitCode` makes the natural drain carry the
  // right code; the timer below is the backstop for the OTHER case, where a lingering helper
  // keeps the loop alive and the process would otherwise hang.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1500).unref();
}

const timer = setTimeout(
  () => finish(1, `no SMOKE marker within ${TIMEOUT_MS / 1000}s — a launch that never reached a window is a failure, not a pass`),
  TIMEOUT_MS,
);

const onData = (d: Buffer): void => {
  const s = d.toString();
  process.stdout.write(s); // surface the app's own log lines in the CI transcript
  seen += s;
  if (OK.test(seen)) finish(0, 'the app reported SMOKE OK (window reached did-finish-load)');
  else if (FAILED.test(seen)) finish(1, 'the app reported SMOKE FAILED');
};

child.stdout?.on('data', onData);
child.stderr?.on('data', onData);

child.on('error', (e: Error) => finish(1, 'could not spawn the app: ' + e.message));

// Exit BEFORE any marker is a crash on launch — not a pass, whatever the code. The marker is the
// only signal that a window was actually reached.
child.on('exit', (code, signal) => {
  finish(1, `the app exited (code ${code ?? 'null'}, signal ${signal ?? 'null'}) before printing a launch marker`);
});
