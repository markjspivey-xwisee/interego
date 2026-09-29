/**
 * The Community Solid Server the multi-agent demos talk to, started from its own install OUTSIDE
 * this repository.
 *
 * ★ WHY NOT THE EXAMPLE'S OWN node_modules/.bin. Components.js, the server's configuration loader,
 * walks from the server's package directory up to the filesystem root and loads the modules in
 * every node_modules it passes (componentsjs ModuleStateBuilder.buildNodeModuleImportPaths).
 * Installed under this repository, the server also found the root's @comunica 5 beside its own
 * @comunica 2 and could not build its configuration ("… ActorDereference … is not a valid
 * component"), so run.ts, tla-demo.ts and team-demo.ts all stopped at a startup timeout
 * (2026-09-28). `--mainModulePath` cannot help: it moves where the walk starts, not where it ends.
 * `npx`, run from a directory outside the repository, installs the server into npm's cache, whose
 * ancestors hold nothing of ours. The first run downloads it; later runs reuse the cache.
 *
 * ★ AND IT IS STOPPED AS A TREE. npx does not run the server itself. On Windows it sits behind a
 * shell; on Unix npm 11 runs `npm → sh -c → node`, and SIGTERM to npm ends the shell but leaves the
 * server running (Codex, on #568), holding the port and making the next run refuse to start. So on
 * Unix the server gets its own process group and the whole group is signalled; on Windows the tree
 * is ended with taskkill /T. It is also stopped when the demo exits or is interrupted, because a
 * server in its own group no longer receives the terminal's Ctrl+C.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The server css-config.json was written for. */
export const SOLID_SERVER_PACKAGE = '@solid/community-server@7';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the server runs and keeps its pods: a fixed folder under the OS temp directory. */
export const SOLID_SERVER_WORKDIR = join(tmpdir(), 'interego-solid-server');

/** True when `dir` is `root` itself or lies beneath it. */
export function isInside(dir: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export interface SolidServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly podsDir: string;
}

/** How the server is launched: npx, from a directory outside the repository, with its pods beneath it. */
export function solidServerLaunch(opts: {
  config: string;
  port: number;
  baseUrl: string;
  workDir?: string;
  repoRoot?: string;
}): SolidServerLaunch {
  const workDir = opts.workDir ?? SOLID_SERVER_WORKDIR;
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  if (isInside(workDir, repoRoot)) {
    throw new Error(`the Solid server must run outside the repository: ${workDir} is inside ${repoRoot}`);
  }
  const podsDir = join(workDir, `pods-${opts.port}`);
  return {
    command: 'npx',
    args: ['--yes', SOLID_SERVER_PACKAGE, '-c', opts.config, '-p', String(opts.port), '-l', 'warn', '--baseUrl', opts.baseUrl, '-f', podsDir],
    cwd: workDir,
    podsDir,
  };
}

/** cmd.exe splits on whitespace, and Node joins a shell command's arguments unquoted. */
const shellArg = (arg: string): string => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

/**
 * How the server is spawned. Windows runs npx through its .cmd shim, which needs a shell. Elsewhere
 * npx runs directly, as the leader of its own process group, so the whole tree can be signalled.
 */
export function solidServerSpawnOptions(platform: NodeJS.Platform = process.platform): { shell: boolean; detached: boolean } {
  return platform === 'win32' ? { shell: true, detached: false } : { shell: false, detached: true };
}

/** Stop the server when the demo exits, or is interrupted, before stopping it itself. */
function stopWithTheDemo(proc: ChildProcess): void {
  process.once('exit', () => stopSolidServer(proc));
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      stopSolidServer(proc);
      process.exit(code);
    });
  }
}

/**
 * Start the server with fresh pods and resolve once it answers HTTP. Refuses when something already
 * answers at `baseUrl` (a demo left running with --keep-alive) rather than wiping that server's pods.
 */
export async function startSolidServer(opts: {
  config: string;
  port: number;
  baseUrl: string;
  log: (message: string) => void;
  timeoutMs?: number;
}): Promise<ChildProcess> {
  const answering = await fetch(opts.baseUrl).then(() => true, () => false);
  if (answering) {
    throw new Error(`something already answers at ${opts.baseUrl} (a demo left running with --keep-alive?); stop it first`);
  }
  const launch = solidServerLaunch(opts);
  mkdirSync(launch.cwd, { recursive: true });
  rmSync(launch.podsDir, { recursive: true, force: true });
  const timeoutMs = opts.timeoutMs ?? 300_000;
  opts.log(`Starting Community Solid Server on port ${opts.port} (${SOLID_SERVER_PACKAGE} via npx, outside the repository; the first run downloads it)...`);
  const { shell, detached } = solidServerSpawnOptions();
  const proc: ChildProcess = shell
    ? spawn([launch.command, ...launch.args].map(shellArg).join(' '), { cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    : spawn(launch.command, [...launch.args], { cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached });
  stopWithTheDemo(proc);

  return new Promise((resolveStarted, rejectStarted) => {
    let settled = false;
    let output = '';
    const tail = (): string => output.trim().split('\n').slice(-12).join('\n');
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (error) {
        stopSolidServer(proc);
        rejectStarted(error);
        return;
      }
      opts.log(`CSS running at ${opts.baseUrl} (pods in ${launch.podsDir})`);
      resolveStarted(proc);
    };
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-8000);
      if (output.includes('Listening')) finish();
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);
    proc.on('error', error => finish(error));
    proc.on('exit', code => finish(new Error(`the Solid server exited with code ${code}:\n${tail()}`)));
    const poll = setInterval(() => {
      fetch(opts.baseUrl).then(response => { if (response.status < 500) finish(); }, () => undefined);
    }, 500);
    const timer = setTimeout(() => finish(new Error(`the Solid server did not start within ${timeoutMs / 1000}s:\n${tail()}`)), timeoutMs);
  });
}

const stopped = new WeakSet<object>();

/**
 * Stop the server and everything npx started for it: the process tree on Windows, the process
 * group on Unix. Safe to call more than once. The platform and the two ways of stopping are
 * parameters so the test can check each branch on any machine.
 */
export function stopSolidServer(
  proc: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  signal: (pid: number, sig: NodeJS.Signals) => void = (pid, sig) => { process.kill(pid, sig); },
  run: (command: string, args: string[]) => void = (command, args) => { spawnSync(command, args, { stdio: 'ignore' }); },
): void {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null || stopped.has(proc)) return;
  // Once only: a second call at exit must not signal a process ID the system has since reused.
  stopped.add(proc);
  if (platform === 'win32') {
    run('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    return;
  }
  try {
    signal(-proc.pid, 'SIGTERM'); // the whole group: npm, its shell and the server
  } catch {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
}
