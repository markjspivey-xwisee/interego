import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { requestFreshCollectorHeadroom, attachCollectorHeadroomProvider } from '../tools/pgsl-store-gc-headroom-ipc.mjs';

const REQUEST = 'pgsl-collector-headroom-request', RESPONSE = 'pgsl-collector-headroom-response';
const requestId = '13d4792a-f893-4af9-a099-1b2cec9421c0';
const fixedError = 'refusing rebuild: fresh verified volume headroom is unavailable';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const sample = (sampledAt = Date.now()) => ({ capacityBytes: 10_000_000, usedBytes: 1_000_000, sampledAt });

class Channel extends EventEmitter {
  connected = true;
  sent: unknown[] = [];
  unrefs = 0;
  channel = { unref: () => { this.unrefs++; } };
  send = (message: unknown, callback?: (error: Error | null) => void) => {
    this.sent.push(message); callback?.(null); return true;
  };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  vi.doUnmock('node:child_process'); vi.doUnmock('../tools/railway-pins.mjs');
});

describe('fresh collector headroom IPC', () => {
  it('does not measure during a long scan and obtains a new sample when rebuilding starts', async () => {
    let now = 1_800_000_000_000, measured = 0;
    const child = new Channel(), parent = new Channel();
    child.send = (message, callback) => { child.sent.push(message); queueMicrotask(() => parent.emit('message', message)); callback?.(null); return true; };
    parent.send = (message, callback) => { parent.sent.push(message); queueMicrotask(() => child.emit('message', message)); callback?.(null); return true; };
    const close = attachCollectorHeadroomProvider(parent, () => { measured++; return sample(now); }, { now: () => now });
    now += 16 * 60_000;
    expect(measured).toBe(0);
    const result = await requestFreshCollectorHeadroom({ channel: child, now: () => now });
    expect(result).toEqual(sample(now)); expect(measured).toBe(1);
    expect(Object.keys(child.sent[0] as object).sort()).toEqual(['kind', 'requestId']);
    expect(child.listenerCount('message')).toBe(0); expect(child.unrefs).toBe(1);
    expect(parent.listenerCount('message')).toBe(0); close();
  });

  it('ignores selectors, unknown kinds and invalid IDs, and never measures duplicate requests', async () => {
    const child = new Channel(), measure = vi.fn(() => sample());
    const close = attachCollectorHeadroomProvider(child, measure);
    for (const message of [
      { kind: REQUEST, requestId, projectId: 'foreign' },
      { kind: REQUEST, requestId, serviceId: 'foreign' },
      { kind: REQUEST, requestId, query: 'mutation { secret }' },
      { kind: 'other', requestId }, { kind: REQUEST, requestId: 'anything' },
    ]) child.emit('message', message);
    await turn(); expect(measure).not.toHaveBeenCalled();
    child.emit('message', { kind: REQUEST, requestId });
    child.emit('message', { kind: REQUEST, requestId });
    await turn(); expect(measure).toHaveBeenCalledTimes(1);
    expect(child.sent).toHaveLength(1); expect(child.listenerCount('message')).toBe(0); close();
  });

  it('accepts only the exact response ID and ignores late responses after settlement', async () => {
    const channel = new Channel();
    const result = requestFreshCollectorHeadroom({ channel });
    const id = (channel.sent[0] as { requestId: string }).requestId;
    channel.emit('message', { kind: RESPONSE, requestId, ok: true, headroom: sample() });
    expect(channel.listenerCount('message')).toBe(1);
    channel.emit('message', { kind: RESPONSE, requestId: id, ok: true, headroom: sample() });
    await expect(result).resolves.toMatchObject({ capacityBytes: 10_000_000 });
    channel.emit('message', { kind: RESPONSE, requestId: id, ok: false });
    expect(channel.listenerCount('message')).toBe(0);
  });

  it.each([
    { capacityBytes: 0 }, { capacityBytes: Number.MAX_SAFE_INTEGER + 1 }, { capacityBytes: Infinity },
    { usedBytes: -1 }, { usedBytes: 10_000_001 }, { usedBytes: 1.5 },
    { sampledAt: 1 }, { sampledAt: Number.MAX_SAFE_INTEGER }, { sampledAt: NaN },
    { token: 'never-return-this' },
  ])('refuses malformed, stale or unsafe measurement %j', async override => {
    const channel = new Channel(), now = Date.now();
    const result = requestFreshCollectorHeadroom({ channel, now: () => now });
    const id = (channel.sent[0] as { requestId: string }).requestId;
    channel.emit('message', { kind: RESPONSE, requestId: id, ok: true, headroom: { ...sample(now), ...override } });
    await expect(result).rejects.toThrow(fixedError);
    expect(channel.listenerCount('message')).toBe(0); expect(channel.listenerCount('error')).toBe(0);
  });

  it.each(['throw', 'callback', 'disconnect', 'error', 'timeout', 'unavailable'])('fails closed on %s without leaking raw errors or stale environment data', async mode => {
    vi.stubEnv('PGSL_GC_VOLUME_CAPACITY_BYTES', '1000000000');
    const channel = new Channel();
    if (mode === 'throw') channel.send = () => { throw new Error('private token and connection string'); };
    if (mode === 'callback') channel.send = (_message, callback) => { callback?.(new Error('private token')); return false; };
    if (mode === 'unavailable') channel.connected = false;
    const result = requestFreshCollectorHeadroom({ channel, timeoutMs: 20 });
    if (mode === 'disconnect' || mode === 'error') channel.emit(mode, new Error('private token'));
    await expect(result).rejects.toThrow(fixedError);
    expect(channel.listenerCount('message')).toBe(0); expect(channel.listenerCount('disconnect')).toBe(0);
    expect(channel.listenerCount('error')).toBe(0);
  });

  it('sends a fixed failure for platform errors and suppresses late measurement completion', async () => {
    const failed = new Channel();
    attachCollectorHeadroomProvider(failed, () => { throw new Error('secret platform response'); });
    failed.emit('message', { kind: REQUEST, requestId }); await turn();
    expect(failed.sent).toEqual([{ kind: RESPONSE, requestId, ok: false }]);
    const late = new Channel();
    let finish!: (value: ReturnType<typeof sample>) => void;
    attachCollectorHeadroomProvider(late, () => new Promise(resolve => { finish = resolve; }), { timeoutMs: 20 });
    late.emit('message', { kind: REQUEST, requestId });
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(late.sent).toEqual([{ kind: RESPONSE, requestId, ok: false }]);
    finish(sample()); await turn(); expect(late.sent).toHaveLength(1);
    expect(late.listenerCount('message')).toBe(0); expect(late.listenerCount('exit')).toBe(0);
  });

  it.each(['exit', 'close', 'disconnect', 'error'])('closes the provider on child %s and cannot send a late reply', async event => {
    const child = new Channel(); let finish!: (value: ReturnType<typeof sample>) => void;
    attachCollectorHeadroomProvider(child, () => new Promise(resolve => { finish = resolve; }));
    child.emit('message', { kind: REQUEST, requestId }); await turn();
    child.emit(event); finish(sample()); await turn();
    expect(child.sent).toHaveLength(0); expect(child.eventNames()).toEqual([]);
  });

  it('does not dispatch a measurement when the child exits before the queued request starts', async () => {
    const child = new Channel(), measure = vi.fn(() => sample());
    attachCollectorHeadroomProvider(child, measure);
    child.emit('message', { kind: REQUEST, requestId }); child.emit('exit', 0);
    await turn(); expect(measure).not.toHaveBeenCalled(); expect(child.sent).toEqual([]);
  });

  it('lets a directly spawned Node collector exit naturally after the IPC exchange', async () => {
    const url = new URL('../tools/pgsl-store-gc-headroom-ipc.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `import {requestFreshCollectorHeadroom} from ${JSON.stringify(url)}; const value=await requestFreshCollectorHeadroom(); console.log(JSON.stringify(value));`],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
    let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
    const close = attachCollectorHeadroomProvider(child, () => sample());
    const result = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('collector did not exit')); }, 3000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    close(); expect(result, stderr).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ usedBytes: 1_000_000 });
  }, 5000);
});

describe('remote collector scope and direct child', () => {
  it.each([false, true])('queries headroom only upon a rebuild request (request=%s), strips credentials, and uses the exact token environment', async request => {
    vi.resetModules();
    const child = new Channel(); let volumes = 0, spawnArgs: unknown[] = [];
    const gql = vi.fn(async (query: string, variables?: object) => {
      if (query.includes('projectToken')) return { projectToken: { projectId: 'pinned-project', environmentId: 'pinned-environment' } };
      if (query.includes('services{')) return { project: { services: { edges: [{ node: { id: 'pinned-postgres', name: 'postgres' } }] } } };
      if (query.includes('variables(')) return { variables: { POSTGRES_USER: 'db-user', POSTGRES_PASSWORD: 'private-db-password', POSTGRES_DB: 'pgsl' } };
      if (query.includes('tcpProxies(')) return { tcpProxies: [{ id: 'existing', domain: 'localhost', proxyPort: 5432, applicationPort: 5432 }] };
      if (query.includes('volumes{')) {
        volumes++; expect(variables).toEqual({ p: 'pinned-project', e: 'pinned-environment' });
        return { project: { volumes: { edges: [{ node: { id: 'volume', volumeInstances: { edges: [{ node: { serviceId: 'pinned-postgres', mountPath: '/db', sizeMB: 1000, currentSizeMB: 10 } }] } } }] } },
          environment: { config: { services: { 'pinned-postgres': { volumeMounts: { volume: { mountPath: '/db' } } } } } } };
      }
      throw new Error('unexpected platform request');
    });
    vi.doMock('../tools/railway-pins.mjs', () => ({ railwayGql: () => gql }));
    vi.doMock('node:child_process', () => ({ spawn: (...args: unknown[]) => {
      spawnArgs = args; expect(volumes).toBe(0);
      queueMicrotask(() => {
        if (request) child.emit('message', { kind: REQUEST, requestId });
        else child.emit('exit', 0);
      });
      return child;
    } }));
    child.send = (message, callback) => { child.sent.push(message); callback?.(null); queueMicrotask(() => child.emit('exit', 0)); return true; };
    vi.stubEnv('RAILWAY_PROJECT_TOKEN', 'private-project-token');
    vi.stubEnv('PGSL_GC_VOLUME_CAPACITY_BYTES', 'stale-capacity');
    vi.stubEnv('PGSL_GC_VOLUME_USED_BYTES', 'stale-usage'); vi.stubEnv('PGSL_GC_VOLUME_SAMPLED_AT', 'stale-time');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(code => { throw new Error(`test-exit:${code}`); });
    const remoteModule = new URL('../tools/pgsl-store-gc-remote.mjs', import.meta.url).href;
    await expect(import(remoteModule)).rejects.toThrow('test-exit:0');
    expect(spawnArgs[0]).toBe(process.execPath);
    expect((spawnArgs[1] as string[]).slice(0, 3)).toEqual(['--import', 'tsx', 'tools/pgsl-store-gc.ts']);
    const options = spawnArgs[2] as { env: Record<string, string>; stdio: string[]; shell?: boolean };
    expect(options.stdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']); expect(options.shell).toBeUndefined();
    expect(options.env.PGSL_PG_CONNSTR).toContain('private-db-password');
    for (const key of ['RAILWAY_PROJECT_TOKEN', 'PGSL_GC_VOLUME_CAPACITY_BYTES', 'PGSL_GC_VOLUME_USED_BYTES', 'PGSL_GC_VOLUME_SAMPLED_AT']) expect(options.env).not.toHaveProperty(key);
    expect(volumes).toBe(request ? 1 : 0);
    expect(JSON.stringify(child.sent)).not.toMatch(/private|pinned-project|pinned-environment|pinned-postgres/);
    expect(JSON.stringify([...out.mock.calls, ...err.mock.calls])).not.toMatch(/private|postgres:\/\//);
    expect(child.listenerCount('message')).toBe(0);
  });

  it('keeps IPC measurement invocation inside the CLI rebuild headroom guard', () => {
    const cli = readFileSync(new URL('../tools/pgsl-store-gc.ts', import.meta.url), 'utf8');
    expect(cli).toContain('requestFreshCollectorHeadroom');
    const headroom = cli.slice(cli.indexOf('const headroom = async'), cli.indexOf('const attemptRebuild = async'));
    expect(headroom).toContain('requestFreshCollectorHeadroom');
    expect(cli.match(/await requestFreshCollectorHeadroom\(/g)).toHaveLength(1);
  });
});
