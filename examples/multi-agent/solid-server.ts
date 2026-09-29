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
  // Windows runs npx through its .cmd shim, which needs a shell; elsewhere npx runs directly.
  const proc: ChildProcess = process.platform === 'win32'
    ? spawn([launch.command, ...launch.args].map(shellArg).join(' '), { cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    : spawn(launch.command, [...launch.args], { cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

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

/**
 * Stop the server and what it started. npx runs the server as a child of its own, behind a shell on
 * Windows, so a plain kill() of the process we spawned can leave the server itself running there.
 */
export function stopSolidServer(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM'); // npm exec forwards SIGTERM to the server it started
  }
}
