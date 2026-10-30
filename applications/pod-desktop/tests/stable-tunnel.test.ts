import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { StableBridgeTunnel } from '../src/stable-tunnel.js';
import type { BridgeTunnelDependencies } from '../src/bridge-tunnel.js';
import type { StoredStableBridge } from '../src/bridge-types.js';

const TOKEN = 'eyJ' + 'a'.repeat(80);
const saved: StoredStableBridge = { provider: 'cloudflare', origin: 'https://pod.example.com', port: 45321, token: TOKEN,
  policy: { client: 'chatgpt-web', name: 'ChatGPT web', permissions: ['notes:read'], expiresInDays: 30 } };
const directories: string[] = [];
const tunnels: StableBridgeTunnel[] = [];
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); readonly pid = 987654;
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => { queueMicrotask(() => this.exit(signal)); return true; });
  exit(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal; this.emit('exit', null, signal); this.emit('close', null, signal);
  }
  online(): void { this.stderr.write(`${JSON.stringify({ message: 'Registered tunnel connection', connIndex: 0 })}\n`); }
}
async function fixture(dependencies: BridgeTunnelDependencies = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'interego-stable-tunnel-')); directories.push(directory);
  const resourcesDir = join(directory, 'installed'); const dataDir = join(directory, 'runtime');
  await mkdir(join(resourcesDir, 'bridge'), { recursive: true });
  const child = new FakeChild(); const onUnexpectedExit = vi.fn();
  let resolveSpawned!: () => void; const spawned = new Promise<void>(done => { resolveSpawned = done; });
  const spawn = vi.fn((_binary: string, _args: readonly string[], _options: SpawnOptions) => { resolveSpawned(); return child as unknown as ChildProcess; });
  const verifyBinary = vi.fn(async (_path: string) => {});
  const tunnel = new StableBridgeTunnel({ resourcesDir, dataDir, onUnexpectedExit }, {
    platform: 'win32', arch: 'x64', verifyBinary, spawn, startupTimeoutMs: 10_000, stopTimeoutMs: 20, ...dependencies,
  });
  tunnels.push(tunnel);
  const ready = (starting: Promise<string>) => Promise.race([spawned, starting.then(() => { throw new Error('No process was launched.'); })]);
  return { tunnel, child, spawn, ready, resourcesDir, dataDir, onUnexpectedExit, verifyBinary };
}
afterEach(async () => {
  for (const tunnel of tunnels.splice(0)) await tunnel.stop().catch(() => {});
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-stable-tunnel-')) await rm(directory, { recursive: true, force: true });
  }
});

describe('saved-address bridge transport', () => {
  it('does nothing by default and externally managed mode starts no bundled helper', async () => {
    const f = await fixture({ platform: 'linux' }); expect(f.tunnel.getState()).toEqual({ phase: 'off' });
    const external: StoredStableBridge = { provider: 'external', origin: saved.origin, port: saved.port, policy: saved.policy };
    await expect(f.tunnel.start(saved.port, external)).resolves.toBe(saved.origin);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.verifyBinary).not.toHaveBeenCalled();
    expect(f.tunnel.getState()).toEqual({ phase: 'online', url: saved.origin });
    await f.tunnel.stop(); expect(f.tunnel.getState()).toEqual({ phase: 'off' });
  });

  it('uses only a pinned helper and temporary token file, never a token argument or ambient credential', async () => {
    const f = await fixture(); vi.stubEnv('TUNNEL_TOKEN', 'ambient-secret'); vi.stubEnv('HTTPS_PROXY', 'http://example.invalid');
    const starting = f.tunnel.start(saved.port, saved); await f.ready(starting);
    const [binary, args, options] = f.spawn.mock.calls[0]!;
    expect(binary).toBe(join(f.resourcesDir, 'bridge', 'cloudflared.exe'));
    expect(f.verifyBinary).toHaveBeenCalledExactlyOnceWith(binary);
    expect(args).toContain('run'); expect(args).toContain('--token-file'); expect(args).not.toContain('--token'); expect(args).not.toContain('--url');
    expect(JSON.stringify(args)).not.toContain(TOKEN); expect(JSON.stringify(options.env)).not.toContain(TOKEN);
    expect(options).toMatchObject({ windowsHide: true, shell: false, cwd: f.dataDir });
    expect(options.env).not.toHaveProperty('TUNNEL_TOKEN'); expect(options.env).not.toHaveProperty('HTTPS_PROXY');
    const path = args[args.indexOf('--token-file') + 1]!; expect(await readFile(path, 'utf8')).toBe(`${TOKEN}\n`);
    const config = args[args.indexOf('--config') + 1]!; expect(await readFile(config, 'utf8')).toBe('{}\n');
    f.child.online(); await expect(starting).resolves.toBe(saved.origin);
    expect(f.tunnel.getState()).toEqual({ phase: 'online', url: saved.origin });
    await f.tunnel.stop(); await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(config)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it('keeps the configured address across a fresh tunnel instance instead of trusting startup log URLs', async () => {
    for (let iteration = 0; iteration < 2; iteration++) {
      const f = await fixture(); const starting = f.tunnel.start(saved.port, saved); await f.ready(starting);
      f.child.stderr.write('https://different.trycloudflare.com\n'); expect(f.tunnel.getState().phase).toBe('starting');
      f.child.online(); expect(await starting).toBe(saved.origin); await f.tunnel.stop();
    }
  });

  it('fails before spawning if the configured local port, public origin or credentials do not match', async () => {
    const f = await fixture();
    await expect(f.tunnel.start(saved.port + 1, saved)).rejects.toThrow('saved local bridge port');
    await expect(f.tunnel.start(saved.port, { ...saved, origin: 'http://127.0.0.1' })).rejects.toThrow('could not connect');
    await expect(f.tunnel.start(saved.port, { ...saved, token: 'short' })).rejects.toThrow('could not connect');
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('can cancel while verification is pending, with no later process or token file', async () => {
    let finish!: () => void; const verification = new Promise<void>(done => { finish = done; });
    const f = await fixture({ verifyBinary: async () => verification });
    const starting = f.tunnel.start(saved.port, saved); const rejected = expect(starting).rejects.toThrow('turned off');
    await f.tunnel.stop(); await rejected; finish();
    await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.tunnel.getState()).toEqual({ phase: 'off' });
    await expect(readdir(f.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans a process and plaintext files when stopping before the first edge connection', async () => {
    const f = await fixture(); const starting = f.tunnel.start(saved.port, saved); const rejected = expect(starting).rejects.toThrow('turned off');
    await f.ready(starting); const stopping = f.tunnel.stop(); expect(f.tunnel.stop()).toBe(stopping); await stopping; await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(await readdir(f.dataDir)).toEqual([]);
    f.child.online(); expect(f.tunnel.getState()).toEqual({ phase: 'off' }); expect(f.onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('notifies on unexpected exit and keeps raw diagnostics and secrets out of status', async () => {
    const f = await fixture(); const starting = f.tunnel.start(saved.port, saved); await f.ready(starting); f.child.online(); await starting;
    f.child.stderr.write(`Authorization: Bearer ${TOKEN}\n`); f.child.exit();
    expect(f.onUnexpectedExit).toHaveBeenCalledOnce(); expect(f.tunnel.getState().phase).toBe('error');
    expect(JSON.stringify(f.tunnel.getState())).not.toContain(TOKEN); await f.tunnel.stop(); expect(await readdir(f.dataDir)).toEqual([]);
  });

  it('retains the temporary provider as an explicit fallback', async () => {
    const f = await fixture(); const starting = f.tunnel.start(saved.port); await f.ready(starting);
    f.child.stderr.write('https://temporary-fallback.trycloudflare.com\n'); f.child.online();
    await expect(starting).resolves.toBe('https://temporary-fallback.trycloudflare.com');
    await expect(f.tunnel.start(saved.port, saved)).rejects.toThrow('current bridge');
    await f.tunnel.stop(); expect(f.tunnel.getState()).toEqual({ phase: 'off' });
  });
});
