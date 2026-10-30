import { describe, expect, it, vi } from 'vitest';
import { BridgeManager, type BridgeServerPort, type BridgeTunnelPort } from '../src/bridge-manager.js';
import type { BridgeStartInput, BridgeStatus, StoredStableBridge } from '../src/bridge-types.js';
import { BridgeRouteError, type BridgeReadiness } from '../src/bridge-probe.js';

const input: BridgeStartInput = { client: 'chatgpt-web', name: 'ChatGPT web', permissions: ['notes:read'], expiresInDays: 7 };
const off = (): BridgeStatus => ({ state: 'off', permissions: [], pendingApprovals: [], connections: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let state = off();
  const server: BridgeServerPort = {
    start: vi.fn(async () => { state = { ...off(), state: 'starting' }; return 'http://127.0.0.1:43123'; }),
    status: vi.fn(async () => state),
    setPublicUrl: vi.fn(url => { state = { ...off(), state: 'ready', url: `${url}/mcp` }; }),
    stop: vi.fn(async () => { state = off(); }),
    approve: vi.fn(async () => {}), deny: vi.fn(),
  };
  const tunnel: BridgeTunnelPort = { start: vi.fn(async () => 'https://consumer-preview.trycloudflare.com'), stop: vi.fn(async () => {}) };
  return { server, tunnel, manager: new BridgeManager(server, tunnel) };
}

describe('desktop web bridge lifecycle', () => {
  it('does nothing until explicitly started and stops the gateway and tunnel', async () => {
    const f = fixture();
    expect(await f.manager.status()).toEqual(off());
    expect(f.server.start).not.toHaveBeenCalled(); expect(f.tunnel.start).not.toHaveBeenCalled();
    expect(await f.manager.start(input)).toMatchObject({ state: 'ready', url: 'https://consumer-preview.trycloudflare.com/mcp' });
    expect(f.tunnel.start).toHaveBeenCalledWith(43123);
    expect(await f.manager.stop()).toEqual(off());
    expect(f.server.stop).toHaveBeenCalled(); expect(f.tunnel.stop).toHaveBeenCalled();
  });

  it('does not resurrect a tunnel when stopped during startup', async () => {
    const f = fixture(); const opening = deferred<string>(); const entered = deferred<void>();
    vi.mocked(f.tunnel.start).mockImplementation(async () => { entered.resolve(); return opening.promise; });
    const starting = f.manager.start(input); await entered.promise;
    const stopping = f.manager.stop(); opening.resolve('https://late-result.trycloudflare.com');
    await Promise.all([starting, stopping]);
    expect(f.server.setPublicUrl).not.toHaveBeenCalled();
    expect(await f.manager.status()).toEqual(off());
  });

  it('closes a listener whose asynchronous startup finishes after Stop', async () => {
    const f = fixture(); const opening = deferred<string>();
    vi.mocked(f.server.start).mockImplementation(() => opening.promise);
    const starting = f.manager.start(input); await Promise.resolve(); await Promise.resolve();
    const stopping = f.manager.stop(); opening.resolve('http://127.0.0.1:43123');
    await Promise.all([starting, stopping]);
    expect(f.tunnel.start).not.toHaveBeenCalled(); expect(f.server.stop).toHaveBeenCalledTimes(2);
  });

  it('clears authority and reports failure when the tunnel cannot connect', async () => {
    const f = fixture(); vi.mocked(f.tunnel.start).mockRejectedValue(new Error('provider internal detail'));
    const result = await f.manager.start(input);
    expect(result.state).toBe('error'); expect(JSON.stringify(result)).not.toContain('provider internal detail');
    expect(result.url).toBeUndefined(); expect(f.server.stop).toHaveBeenCalled();
    vi.mocked(f.tunnel.start).mockResolvedValue('https://retry.trycloudflare.com');
    expect((await f.manager.start(input)).state).toBe('ready');
  });

  it('stops authorization after an unexpected provider exit and allows a new session', async () => {
    const f = fixture(); await f.manager.start(input);
    await f.manager.connectionLost();
    expect(await f.manager.status()).toMatchObject({ state: 'error', pendingApprovals: [], connections: [] });
    await expect(f.manager.approve('pending')).rejects.toThrow('not ready');
    expect((await f.manager.start(input)).state).toBe('ready');
  });

  it('stops the tunnel even when gateway cleanup fails, without claiming success', async () => {
    const f = fixture(); vi.mocked(f.server.stop).mockRejectedValue(new Error('write denied'));
    expect((await f.manager.stop()).state).toBe('error'); expect(f.tunnel.stop).toHaveBeenCalled();
  });
});

describe('saved bridge lifecycle', () => {
  function savedFixture() {
    const f = fixture();
    let record: StoredStableBridge | null = { provider: 'cloudflare', origin: 'https://memory.example.com', port: 43123,
      token: 'never-return-this-native-token', policy: input };
    const settings = {
      get: vi.fn(async () => record),
      view: vi.fn(async () => record ? { provider: record.provider, origin: record.origin, port: record.port, hasCredential: !!record.token, policy: record.policy } : null),
      save: vi.fn(), clear: vi.fn(async () => { record = null; }),
    };
    f.server.forget = vi.fn(async () => {});
    f.server.readiness = vi.fn(() => ({ path: '/.well-known/interego-bridge', expected: 'fresh-per-listener-proof' }));
    vi.mocked(f.tunnel.start).mockResolvedValue('https://memory.example.com');
    const verifyPublic = vi.fn(async (_origin: string, _proof: BridgeReadiness, _signal: AbortSignal) => {});
    const manager = new BridgeManager(f.server, f.tunnel, { settings, verifyPublic });
    return { ...f, settings, verifyPublic, manager };
  }

  it('shows the remembered address while staying off until explicit resume', async () => {
    const f = savedFixture();
    expect(await f.manager.status()).toMatchObject({ state: 'off', remembered: true, mode: 'stable', url: 'https://memory.example.com/mcp' });
    expect(f.server.start).not.toHaveBeenCalled(); expect(f.tunnel.start).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.manager.status())).not.toContain('never-return-this-native-token');
    expect((await f.manager.resume()).state).toBe('ready');
    expect(f.server.start).toHaveBeenCalledWith(input, { origin: 'https://memory.example.com', port: 43123 });
    expect(f.verifyPublic).toHaveBeenCalledOnce();
    expect(await f.manager.stop()).toMatchObject({ state: 'off', remembered: true, url: 'https://memory.example.com/mcp' });
    expect(f.server.forget).not.toHaveBeenCalled(); expect(f.settings.clear).not.toHaveBeenCalled();
    expect((await f.manager.resume()).state).toBe('ready');
  });

  it('forgets authorization before removing the saved provider settings', async () => {
    const f = savedFixture(); await f.manager.resume();
    vi.mocked(f.server.forget!).mockImplementation(async () => { expect(f.settings.clear).not.toHaveBeenCalled(); });
    expect(await f.manager.forget()).toEqual(off());
    expect(f.server.forget).toHaveBeenCalledOnce(); expect(f.settings.clear).toHaveBeenCalledOnce();
  });

  it('keeps a saved address and pairings when the public route fails verification', async () => {
    const f = savedFixture(); f.verifyPublic.mockRejectedValue(new BridgeRouteError());
    expect(await f.manager.resume()).toMatchObject({ state: 'error', remembered: true, url: 'https://memory.example.com/mcp' });
    expect(f.server.stop).toHaveBeenCalled(); expect(f.server.forget).not.toHaveBeenCalled();
    expect(f.settings.clear).not.toHaveBeenCalled();
  });

  it('cancels public verification when paused without enabling access later', async () => {
    const f = savedFixture(); const entered = deferred<void>();
    f.verifyPublic.mockImplementation(async (_origin, _proof, signal) => {
      entered.resolve(); await new Promise<void>((_done, fail) => signal.addEventListener('abort', () => fail(new Error('canceled')), { once: true }));
    });
    const starting = f.manager.resume(); await entered.promise;
    await f.manager.stop(); await starting;
    expect(await f.manager.status()).toMatchObject({ state: 'off', remembered: true });
  });

  it('does not replace saved authority with a temporary connection', async () => {
    const f = savedFixture();
    expect(await f.manager.start(input)).toMatchObject({ state: 'error', remembered: true });
    expect(f.tunnel.start).not.toHaveBeenCalled(); expect(f.settings.clear).not.toHaveBeenCalled();
  });

  for (const operation of ['stop', 'forget'] as const) it(`cannot resume from a saved-settings read that finishes after ${operation}`, async () => {
    const f = savedFixture(); const previous = await f.settings.get();
    const reading = deferred<StoredStableBridge | null>(); f.settings.get.mockReturnValue(reading.promise);
    const resuming = f.manager.resume(); await Promise.resolve();
    await f.manager[operation](); reading.resolve(previous); await resuming;
    expect(f.server.start).not.toHaveBeenCalled(); expect(f.tunnel.start).not.toHaveBeenCalled();
    expect((await f.manager.status()).state).toBe('off');
  });

  it('lets the owner forget unreadable authorization while retaining a truthful error state', async () => {
    const f = savedFixture(); vi.mocked(f.server.status).mockRejectedValueOnce(new Error('corrupt private snapshot'));
    const state = await f.manager.status();
    expect(state).toMatchObject({ state: 'error', remembered: true, url: 'https://memory.example.com/mcp' });
    expect(JSON.stringify(state)).not.toContain('corrupt private snapshot');
    vi.mocked(f.server.status).mockRejectedValueOnce(new Error('corrupt private snapshot'));
    expect(await f.manager.resume()).toMatchObject({ state: 'error', message: expect.stringContaining('Forget the saved address') });
    expect(f.tunnel.start).not.toHaveBeenCalled();
    expect(await f.manager.forget()).toEqual(off());
  });
});
