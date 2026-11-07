import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { BridgeTunnel, verifyBridgeBinary, type BridgeTunnelDependencies } from '../src/bridge-tunnel.js';

const directories: string[] = [];
const tunnels: BridgeTunnel[] = [];
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 987654;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    queueMicrotask(() => this.exit(signal)); return true;
  });
  exit(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal; this.emit('exit', null, signal); this.emit('close', null, signal);
  }
  online(): void {
    this.stderr.write(`${JSON.stringify({ message: 'https://kind-river.trycloudflare.com' })}\n`);
    this.stderr.write(`${JSON.stringify({ message: 'Registered tunnel connection', connIndex: 0 })}\n`);
  }
}
async function fixture(dependencies: BridgeTunnelDependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'interego-bridge-tunnel-')); directories.push(directory);
  const resourcesDir = join(directory, 'installed'); const dataDir = join(directory, 'runtime');
  await mkdir(join(resourcesDir, 'bridge'), { recursive: true });
  const child = new FakeChild(); const onUnexpectedExit = vi.fn();
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>(done => { resolveSpawned = done; });
  const ready = (start: Promise<string>): Promise<void> => Promise.race([
    spawned,
    start.then(() => { throw new Error('The bridge reported readiness before its process was launched.'); }),
  ]);
  const spawn = vi.fn((_executable: string, _args: readonly string[], _options: SpawnOptions) => {
    resolveSpawned(); return child as unknown as ChildProcess;
  });
  const verifyBinary = vi.fn(async (_path: string) => {});
  const tunnel = new BridgeTunnel({ resourcesDir, dataDir, onUnexpectedExit }, {
    platform: 'win32', arch: 'x64', spawn, verifyBinary, startupTimeoutMs: 2000, stopTimeoutMs: 20, ...dependencies,
  });
  tunnels.push(tunnel);
  return { tunnel, child, spawn, ready, verifyBinary, onUnexpectedExit, directory, resourcesDir, dataDir };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const tunnel of tunnels.splice(0)) await tunnel.stop().catch(() => {});
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-bridge-tunnel-')) await rm(directory, { recursive: true, force: true });
  }
});

describe('explicit temporary bridge transport', () => {
  it('starts no process by default and refuses alternate addresses or unsupported builds', async () => {
    const f = await fixture();
    expect(f.tunnel.getState()).toEqual({ phase: 'off' });
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.verifyBinary).not.toHaveBeenCalled();
    for (const port of [0, 80, 1023, 65536, NaN, 2000.5, 'http://evil.example' as unknown as number]) await expect(f.tunnel.start(port)).rejects.toThrow('address');
    expect(f.spawn).not.toHaveBeenCalled();
    const linux = await fixture({ platform: 'linux' });
    await expect(linux.tunnel.start(54321)).rejects.toThrow('Windows');
  });

  it('uses only the verified installed component, private config and exact narrow loopback target', async () => {
    const f = await fixture();
    vi.stubEnv('TUNNEL_TOKEN', 'never-inherit-this'); vi.stubEnv('HTTP_PROXY', 'http://example.invalid');
    vi.stubEnv('TUNNEL_LOGFILE', 'sensitive.log'); vi.stubEnv('NODE_OPTIONS', '--inspect');
    const start = f.tunnel.start(54321); await f.ready(start);
    expect(f.verifyBinary).toHaveBeenCalledExactlyOnceWith(join(f.resourcesDir, 'bridge', 'cloudflared.exe'));
    const [executable, args, options] = f.spawn.mock.calls[0]!;
    expect(executable).toBe(join(f.resourcesDir, 'bridge', 'cloudflared.exe'));
    expect(args).toContain('--no-autoupdate'); expect(args).toContain('--management-diagnostics=false');
    expect(args.slice(args.indexOf('--url'), args.indexOf('--url') + 2)).toEqual(['--url', 'http://127.0.0.1:54321']);
    expect(args.slice(args.indexOf('--http-host-header'), args.indexOf('--http-host-header') + 2)).toEqual(['--http-host-header', '127.0.0.1:54321']);
    const config = args[args.indexOf('--config') + 1]!;
    expect(dirname(config)).toBe(f.dataDir); expect(await readFile(config, 'utf8')).toBe('{}\n');
    expect(options).toMatchObject({ cwd: f.dataDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(options.env).not.toHaveProperty('TUNNEL_TOKEN'); expect(options.env).not.toHaveProperty('HTTP_PROXY');
    expect(options.env).not.toHaveProperty('TUNNEL_LOGFILE'); expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    f.child.online(); await expect(start).resolves.toBe('https://kind-river.trycloudflare.com');
    await f.tunnel.stop(); await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' });
    vi.unstubAllEnvs();
  });

  it('waits for a strict generated hostname and a registered edge connection, handling split log chunks', async () => {
    const f = await fixture(); const start = f.tunnel.start(54321); await f.ready(start);
    for (const url of ['https://nice.trycloudflare.com.evil.test', 'https://nice.trycloudflare.com/path',
      'http://nice.trycloudflare.com', 'https://user@nice.trycloudflare.com', 'https://nice.trycloudflare.com:443']) f.child.stderr.write(`${url}\n`);
    f.child.stderr.write('Registered tunnel connection\n');
    expect(f.tunnel.getState().phase).toBe('starting');
    f.child.stderr.write('https://small-'); f.child.stderr.write('forest.trycloudflare.com\n');
    await expect(start).resolves.toBe('https://small-forest.trycloudflare.com');
    expect(f.tunnel.getState()).toEqual({ phase: 'online', url: 'https://small-forest.trycloudflare.com' });
    expect(f.tunnel.start(54321)).toBe(start); expect(f.spawn).toHaveBeenCalledTimes(1);
    await expect(f.tunnel.start(54322)).rejects.toThrow('existing bridge');
  });

  it('cancels before verification finishes without spawning later', async () => {
    let finish!: () => void;
    const verified = new Promise<void>(done => { finish = done; });
    const f = await fixture({ verifyBinary: async () => verified });
    const start = f.tunnel.start(54321); const rejected = expect(start).rejects.toThrow('turned off');
    await f.tunnel.stop(); await rejected; finish();
    await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.tunnel.getState()).toEqual({ phase: 'off' });
  });

  it('kills its starting process when canceled and rejects its pending setup', async () => {
    const f = await fixture(); const start = f.tunnel.start(54321); const rejected = expect(start).rejects.toThrow('turned off');
    await f.ready(start); const stop = f.tunnel.stop(); expect(f.tunnel.stop()).toBe(stop); await stop; await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.onUnexpectedExit).not.toHaveBeenCalled();
    f.child.online(); expect(f.tunnel.getState()).toEqual({ phase: 'off' });
  });

  it('invalidates an established bridge immediately on unexpected process exit without logging sensitive diagnostics', async () => {
    const f = await fixture(); const start = f.tunnel.start(54321); await f.ready(start); f.child.online(); await start;
    f.child.stderr.write(`${JSON.stringify({ message: 'Authorization: Bearer PRIVATE-TOKEN' })}\n`);
    f.child.exit();
    expect(f.onUnexpectedExit).toHaveBeenCalledOnce(); expect(f.tunnel.getState().phase).toBe('error');
    expect(JSON.stringify(f.tunnel.getState())).not.toContain('PRIVATE-TOKEN'); expect(f.tunnel.getState()).not.toHaveProperty('url');
  });

  it('bounds startup time and terminates a tunnel that never becomes reachable', async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let expire!: () => void;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
      if (timeout === 2345) {
        if (typeof handler !== 'function') throw new Error('The startup timer must use a callback.');
        expire = () => handler();
        return nativeSetTimeout(() => {}, 60_000);
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout);
    const f = await fixture({ startupTimeoutMs: 2345 }); const start = f.tunnel.start(54321);
    const rejected = expect(start).rejects.toThrow('could not connect'); await f.ready(start);
    expire(); await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.onUnexpectedExit).toHaveBeenCalledOnce();
    expect(f.tunnel.getState().phase).toBe('error');
  });

  it('refuses an altered executable before opening an external connection', async () => {
    const f = await fixture({ verifyBinary: verifyBridgeBinary });
    const binary = join(f.resourcesDir, 'bridge', 'cloudflared.exe'); await writeFile(binary, Buffer.alloc(4096, 1));
    await expect(verifyBridgeBinary(binary)).rejects.toThrow('integrity');
    await expect(f.tunnel.start(54321)).rejects.toThrow('could not connect'); expect(f.spawn).not.toHaveBeenCalled();
  });
});
