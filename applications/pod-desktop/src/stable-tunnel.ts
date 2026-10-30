/** Provider transport for a saved address. It never provisions a public route. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BridgeTunnel, verifyBridgeBinary, type BridgeTunnelDependencies, type BridgeTunnelOptions, type BridgeTunnelState } from './bridge-tunnel.js';
import { parseTunnelToken, validateStableOrigin } from './stable-bridge.js';
import type { StoredStableBridge } from './bridge-types.js';
import manifest from '../bridge-manifest.json' with { type: 'json' };

const START_ERROR = 'The saved bridge could not connect. Check your tunnel settings and internet connection, then try again.';
const STOP_ERROR = 'The saved bridge could not finish closing. Close Interego before reconnecting.';
const MAX_LOG_LINE = 16 * 1024;

interface NamedRun {
  readonly port: number;
  readonly origin: string;
  readonly promise: Promise<string>;
  resolve(value: string): void;
  reject(error: Error): void;
  readonly files: Set<string>;
  provisioning?: Promise<void>;
  cleaning?: Promise<void>;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  canceled: boolean;
  buffer: { stdout: string; stderr: string };
}

function privateEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'SYSTEMDRIVE', 'TEMP', 'TMP']) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return result;
}

export class StableBridgeTunnel {
  private readonly quick: BridgeTunnel;
  private mode: 'temporary' | 'cloudflare' | 'external' | undefined;
  private state: BridgeTunnelState = { phase: 'off' };
  private run: NamedRun | undefined;
  private external: { port: number; origin: string } | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: BridgeTunnelOptions, private readonly dependencies: BridgeTunnelDependencies = {}) {
    if (!isAbsolute(options.resourcesDir) || !isAbsolute(options.dataDir)) throw new Error('The bridge needs its installed component and a local working folder.');
    this.quick = new BridgeTunnel(options, dependencies);
  }

  getState(): BridgeTunnelState { return this.mode === 'temporary' ? this.quick.getState() : Object.freeze({ ...this.state }); }

  start(port: number, stable?: StoredStableBridge): Promise<string> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new Error('The local bridge address is unavailable.'));
    if (this.stopping || this.run?.canceled) return Promise.reject(new Error(STOP_ERROR));
    if (!stable) {
      if (this.mode && this.mode !== 'temporary') return Promise.reject(new Error('Stop the current bridge before changing its provider.'));
      this.mode = 'temporary';
      return this.quick.start(port);
    }
    let origin: string;
    try { origin = validateStableOrigin(stable.origin); } catch { return Promise.reject(new Error(START_ERROR)); }
    if (stable.port !== port || !['cloudflare', 'external'].includes(stable.provider)) return Promise.reject(new Error('Use the saved local bridge port shown in setup.'));
    if (this.mode === 'temporary' || (this.mode && this.mode !== stable.provider)) return Promise.reject(new Error('Stop the current bridge before changing its provider.'));
    if (stable.provider === 'external') {
      if (stable.token) return Promise.reject(new Error('An externally managed gateway must keep its own credentials.'));
      if (this.external && (this.external.port !== port || this.external.origin !== origin)) return Promise.reject(new Error('Stop the current bridge before changing its address.'));
      this.external = { port, origin }; this.mode = 'external'; this.state = { phase: 'online', url: origin };
      return Promise.resolve(origin);
    }
    if (this.run) return this.run.port === port && this.run.origin === origin ? this.run.promise : Promise.reject(new Error('Stop the current bridge before changing its address.'));
    if ((this.dependencies.platform ?? process.platform) !== 'win32' || (this.dependencies.arch ?? process.arch) !== 'x64') return Promise.reject(new Error('The bundled bridge currently supports Windows on x64 computers.'));
    let token: string;
    try { token = parseTunnelToken(stable.token); } catch { return Promise.reject(new Error(START_ERROR)); }
    let resolve!: (value: string) => void; let reject!: (error: Error) => void;
    const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    const run: NamedRun = { port, origin, promise, resolve, reject, files: new Set(), settled: false, canceled: false, buffer: { stdout: '', stderr: '' } };
    this.mode = 'cloudflare'; this.run = run; this.state = { phase: 'starting' };
    run.timer = setTimeout(() => this.fail(run), this.dependencies.startupTimeoutMs ?? 60_000);
    void this.launch(run, token).catch(() => this.fail(run));
    return promise;
  }

  private async launch(run: NamedRun, token: string): Promise<void> {
    const directory = join(this.options.resourcesDir, 'bridge');
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(START_ERROR);
    const binary = join(directory, manifest.filename);
    await (this.dependencies.verifyBinary ?? verifyBridgeBinary)(binary);
    if (run.canceled || this.run !== run) return;
    run.provisioning = this.provision(run, binary, token);
    await run.provisioning;
  }

  private async writeManaged(run: NamedRun, path: string, content: string): Promise<void> {
    const file = await open(path, 'wx', 0o600);
    run.files.add(path);
    try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
  }

  private async provision(run: NamedRun, binary: string, token: string): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.options.dataDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(START_ERROR);
    if (run.canceled || this.run !== run) return;
    const config = join(this.options.dataDir, `named-config-${randomUUID()}.yml`);
    const tokenFile = join(this.options.dataDir, `named-token-${randomUUID()}.txt`);
    await this.writeManaged(run, config, '{}\n');
    if (run.canceled || this.run !== run) return;
    await this.writeManaged(run, tokenFile, `${token}\n`);
    if (run.canceled || this.run !== run) return;
    // The user's remote Cloudflare route is authoritative. Never imply --url
    // can override it; the app separately verifies its dedicated local target.
    const args = ['tunnel', '--config', config, '--no-autoupdate', '--metrics', '127.0.0.1:0',
      '--management-diagnostics=false', '--output', 'json', '--loglevel', 'info', '--grace-period', '1s', 'run', '--token-file', tokenFile];
    const child = (this.dependencies.spawn ?? spawn)(binary, args, {
      cwd: this.options.dataDir, env: privateEnvironment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;
    child.stdout?.on('data', (bytes: Buffer | string) => this.log(run, 'stdout', bytes));
    child.stderr?.on('data', (bytes: Buffer | string) => this.log(run, 'stderr', bytes));
    child.once('error', () => this.fail(run));
    child.once('close', () => {
      if (run.timer) clearTimeout(run.timer);
      if (run.canceled || this.run !== run) return;
      if (!run.settled) { run.settled = true; run.reject(new Error(START_ERROR)); }
      run.canceled = true;
      this.state = { phase: 'error', message: 'Your saved bridge stopped. Start it again to resume your web connections.' };
      void this.clean(run).catch(() => { this.state = { phase: 'error', message: STOP_ERROR }; });
      this.options.onUnexpectedExit?.();
    });
  }

  private log(run: NamedRun, stream: 'stdout' | 'stderr', bytes: Buffer | string): void {
    if (run.canceled || this.run !== run) return;
    const lines = `${run.buffer[stream]}${String(bytes)}`.split('\n'); const tail = lines.pop() ?? '';
    run.buffer[stream] = tail.length <= MAX_LOG_LINE ? tail : '';
    for (const line of lines) {
      if (line.length > MAX_LOG_LINE) continue;
      let message = line;
      try { const value = JSON.parse(line) as { message?: unknown }; if (typeof value.message === 'string') message = value.message; } catch { /* The helper can emit an unstructured startup line. */ }
      if (!message.includes('Registered tunnel connection') || run.settled) continue;
      if (run.timer) clearTimeout(run.timer);
      run.settled = true; run.buffer = { stdout: '', stderr: '' };
      this.state = { phase: 'online', url: run.origin }; run.resolve(run.origin);
    }
  }

  private fail(run: NamedRun): void {
    if (run.canceled || this.run !== run) return;
    run.canceled = true;
    if (run.timer) clearTimeout(run.timer);
    if (!run.settled) { run.settled = true; run.reject(new Error(START_ERROR)); }
    this.state = { phase: 'error', message: START_ERROR };
    void this.clean(run).catch(() => { this.state = { phase: 'error', message: STOP_ERROR }; });
    this.options.onUnexpectedExit?.();
  }

  private async stopChild(child?: ChildProcess): Promise<void> {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const wait = (): Promise<boolean> => new Promise(done => {
      const timer = setTimeout(() => { child.off('close', closed); done(false); }, this.dependencies.stopTimeoutMs ?? 2000);
      const closed = (): void => { clearTimeout(timer); done(true); };
      child.once('close', closed);
    });
    const closing = wait(); child.kill();
    if (await closing) return;
    const killed = wait(); child.kill('SIGKILL');
    if (!await killed && child.exitCode === null && child.signalCode === null) throw new Error(STOP_ERROR);
  }

  private clean(run: NamedRun): Promise<void> {
    if (run.cleaning) return run.cleaning;
    run.cleaning = (async () => {
      // A canceled checksum check may finish later, but its continuation cannot
      // provision files. Wait only for file writes which have already begun.
      await run.provisioning?.catch(() => {});
      await this.stopChild(run.child);
      const results = await Promise.allSettled([...run.files].map(async path => {
        try { await unlink(path); run.files.delete(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; run.files.delete(path); }
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error(STOP_ERROR);
      if (this.run === run) this.run = undefined;
    })().catch(() => { run.cleaning = undefined; throw new Error(STOP_ERROR); });
    return run.cleaning;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const mode = this.mode; const run = this.run;
    this.state = { phase: 'off' }; this.external = undefined;
    if (run) {
      run.canceled = true;
      if (run.timer) clearTimeout(run.timer);
      if (!run.settled) { run.settled = true; run.reject(new Error('The saved bridge was turned off.')); }
    }
    this.stopping = (async () => {
      if (mode === 'temporary') await this.quick.stop();
      if (run) await this.clean(run);
      this.mode = undefined;
    })().catch(() => { this.state = { phase: 'error', message: STOP_ERROR }; throw new Error(STOP_ERROR); })
      .finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
