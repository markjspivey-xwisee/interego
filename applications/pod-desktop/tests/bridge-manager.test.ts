import { describe, expect, it, vi } from 'vitest';
import { BridgeManager, type BridgeServerPort, type BridgeTunnelPort } from '../src/bridge-manager.js';
import type { BridgeStartInput, BridgeStatus } from '../src/bridge-types.js';

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
