/** An explicit, temporary transport for the narrow bridge, never the Solid pod. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import bridgeManifest from '../bridge-manifest.json' with { type: 'json' };

export interface BridgeTunnelState {
  readonly phase: 'off' | 'starting' | 'online' | 'error';
  readonly url?: string;
  readonly message?: string;
}
export interface BridgeTunnelOptions {
  /** The installed app root containing bridge/cloudflared.exe. */
  readonly resourcesDir: string;
  readonly dataDir: string;
  readonly onUnexpectedExit?: () => void;
}
/** Internal process seam for deterministic tests; never exposed through IPC. */
export interface BridgeTunnelDependencies {
  readonly spawn?: (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly verifyBinary?: (path: string) => Promise<void>;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}
interface Run {
  readonly port: number;
  readonly promise: Promise<string>;
  resolve(url: string): void;
  reject(error: Error): void;
  child?: ChildProcess;
  config?: string;
  timer?: ReturnType<typeof setTimeout>;
  url?: string;
  connected: boolean;
  settled: boolean;
  canceled: boolean;
  buffers: { stdout: string; stderr: string };
}

const START_ERROR = 'The temporary bridge could not connect. Check your internet connection and try again.';
const EXIT_ERROR = 'The temporary bridge stopped. Turn it on again to reconnect your web apps.';
const URL_PATTERN = /(?:^|[\s|"'(:])https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com)(?=$|[\s|"'),;])/;
const MAX_LOG_LINE = 16 * 1024;

/** Only the bundled, release-pinned executable may create the bridge. */
export async function verifyBridgeBinary(path: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1024 || before.size > 128 * 1024 * 1024) throw new Error('The bridge component is unavailable. Reinstall this Interego preview.');
  const hash = createHash('sha256');
  const input = createReadStream(path);
  for await (const bytes of input) hash.update(bytes as Buffer);
  const after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || hash.digest('hex') !== bridgeManifest.sha256) throw new Error('The bridge component did not pass its integrity check. Reinstall this Interego preview.');
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // Never inherit TUNNEL_*, a Cloudflare token, proxy settings, log destinations,
  // or runtime injection settings from the launching shell.
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'SYSTEMDRIVE', 'TEMP', 'TMP']) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return result;
}

export class BridgeTunnel {
  private state: BridgeTunnelState = { phase: 'off' };
  private run?: Run;
  private stopping?: Promise<void>;
  private readonly options: BridgeTunnelOptions;
  private readonly dependencies: BridgeTunnelDependencies;

  constructor(options: BridgeTunnelOptions, dependencies: BridgeTunnelDependencies = {}) {
    if (!isAbsolute(options.resourcesDir) || !isAbsolute(options.dataDir)) throw new Error('The bridge needs its installed component and a local working folder.');
    this.options = options;
    this.dependencies = dependencies;
  }

  getState(): BridgeTunnelState { return Object.freeze({ ...this.state }); }

  start(port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new Error('The local bridge address is unavailable.'));
    if (this.stopping) return Promise.reject(new Error('The bridge is still turning off. Try again in a moment.'));
    if (this.run?.canceled) return Promise.reject(new Error('The bridge is still turning off. Try again in a moment.'));
    if (this.run) return this.run.port === port ? this.run.promise : Promise.reject(new Error('Turn off the existing bridge before reconnecting.'));
    if ((this.dependencies.platform ?? process.platform) !== 'win32' || (this.dependencies.arch ?? process.arch) !== 'x64') {
      return Promise.reject(new Error('The bundled bridge currently supports Windows on x64 computers.'));
    }
    let resolve!: (url: string) => void; let reject!: (error: Error) => void;
    const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    const run: Run = { port, promise, resolve, reject, connected: false, settled: false, canceled: false, buffers: { stdout: '', stderr: '' } };
    this.run = run; this.state = { phase: 'starting' };
    run.timer = setTimeout(() => this.fail(run, START_ERROR), this.dependencies.startupTimeoutMs ?? 60_000);
    void this.launch(run).catch(() => this.fail(run, START_ERROR));
    return promise;
  }

  private async launch(run: Run): Promise<void> {
    const binaryDirectory = join(this.options.resourcesDir, 'bridge');
    const directory = await lstat(binaryDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid bridge component folder.');
    const binary = join(binaryDirectory, bridgeManifest.filename);
    await (this.dependencies.verifyBinary ?? verifyBridgeBinary)(binary);
    if (run.canceled || this.run !== run) return;
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    const workingDirectory = await lstat(this.options.dataDir);
    if (!workingDirectory.isDirectory() || workingDirectory.isSymbolicLink()) throw new Error('Invalid bridge working folder.');
    const config = join(this.options.dataDir, `cloudflared-${randomUUID()}.yml`);
    // A private, explicit empty config avoids personal .cloudflared ingress,
    // credentials or named tunnels. The --url target always wins in this file.
    await writeFile(config, '{}\n', { mode: 0o600, flag: 'wx' });
    run.config = config;
    if (run.canceled || this.run !== run) { await this.cleanup(run); return; }
    const args = ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://127.0.0.1:${run.port}`,
      '--http-host-header', `127.0.0.1:${run.port}`, '--metrics', '127.0.0.1:0', '--management-diagnostics=false',
      '--output', 'json', '--loglevel', 'info', '--grace-period', '1s', '--label', 'Interego temporary bridge'];
    const child = (this.dependencies.spawn ?? spawn)(binary, args, {
      cwd: this.options.dataDir, env: isolatedEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;
    child.stdout?.on('data', (bytes: Buffer | string) => this.logs(run, 'stdout', bytes));
    child.stderr?.on('data', (bytes: Buffer | string) => this.logs(run, 'stderr', bytes));
    child.once('error', () => this.fail(run, START_ERROR));
    child.once('close', () => {
      if (run.timer) clearTimeout(run.timer);
      void this.cleanup(run);
      if (run.canceled || this.run !== run) return;
      const online = run.settled;
      this.run = undefined;
      this.state = { phase: 'error', message: online ? EXIT_ERROR : START_ERROR };
      if (!run.settled) { run.settled = true; run.reject(new Error(START_ERROR)); }
      this.options.onUnexpectedExit?.();
    });
  }

  private logs(run: Run, channel: 'stdout' | 'stderr', bytes: Buffer | string): void {
    if (run.canceled || this.run !== run) return;
    // Logs are parsed in memory only. Never expose request headers or raw logs.
    const part = String(bytes);
    const lines = `${run.buffers[channel]}${part}`.split('\n');
    const remainder = lines.pop() ?? '';
    run.buffers[channel] = remainder.length <= MAX_LOG_LINE ? remainder : '';
    for (const line of lines) {
      if (line.length > MAX_LOG_LINE) continue;
      let message = line;
      try { const value = JSON.parse(line) as { message?: unknown }; if (typeof value.message === 'string') message = value.message; } catch { /* The release prints a small startup table outside structured logs. */ }
      const match = URL_PATTERN.exec(message);
      if (match?.[1] && !run.url) run.url = `https://${match[1]}`;
      if (message.includes('Registered tunnel connection')) run.connected = true;
    }
    if (run.url && run.connected && !run.settled) {
      if (run.timer) clearTimeout(run.timer);
      run.settled = true; run.buffers = { stdout: '', stderr: '' };
      this.state = { phase: 'online', url: run.url };
      run.resolve(run.url);
    }
  }

  private fail(run: Run, message: string): void {
    if (run.canceled || this.run !== run) return;
    const wasOnline = run.settled;
    run.canceled = true;
    if (run.timer) clearTimeout(run.timer);
    if (!run.settled) { run.settled = true; run.reject(new Error(message)); }
    this.state = { phase: 'error', message };
    this.options.onUnexpectedExit?.();
    void this.stopChild(run.child).then(async () => {
      await this.cleanup(run);
      if (this.run === run) this.run = undefined;
      if (wasOnline) this.state = { phase: 'error', message: EXIT_ERROR };
    }).catch(() => { this.state = { phase: 'error', message: 'The bridge component is still stopping. Close Interego before reconnecting.' }; });
  }

  private async cleanup(run: Run): Promise<void> {
    if (run.config) await unlink(run.config).catch(() => {});
  }

  private async stopChild(child?: ChildProcess): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const timeout = this.dependencies.stopTimeoutMs ?? 2000;
    const closed = new Promise<boolean>(done => {
      const timer = setTimeout(() => { child.removeListener('close', onClose); done(false); }, timeout);
      const onClose = (): void => { clearTimeout(timer); done(true); };
      child.once('close', onClose);
    });
    child.kill();
    if (await closed) return;
    const killed = new Promise<boolean>(done => {
      const timer = setTimeout(() => { child.removeListener('close', onClose); done(false); }, timeout);
      const onClose = (): void => { clearTimeout(timer); done(true); };
      child.once('close', onClose);
    });
    child.kill('SIGKILL');
    if (!await killed && child.exitCode === null && child.signalCode === null) throw new Error('The bridge component is still stopping. Close Interego before reconnecting.');
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const run = this.run;
    this.state = { phase: 'off' };
    if (!run) return Promise.resolve();
    run.canceled = true;
    if (run.timer) clearTimeout(run.timer);
    if (!run.settled) { run.settled = true; run.reject(new Error('The bridge was turned off.')); }
    this.stopping = this.stopChild(run.child).then(async () => { await this.cleanup(run); if (this.run === run) this.run = undefined; })
      .catch(error => { this.state = { phase: 'error', message: 'The bridge component is still stopping. Close Interego before reconnecting.' }; throw error; })
      .finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
