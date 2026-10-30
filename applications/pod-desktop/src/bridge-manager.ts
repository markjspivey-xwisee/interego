/** One explicitly enabled, temporary remote connection for the desktop app. */
import type { BridgeStartInput, BridgeStatus } from './bridge-types.js';

export interface BridgeServerPort {
  start(input: BridgeStartInput): Promise<string>;
  setPublicUrl(url: string): void;
  status(): Promise<BridgeStatus>;
  approve(id: string): Promise<void>;
  deny(id: string): void;
  stop(): Promise<void>;
}
export interface BridgeTunnelPort {
  start(port: number): Promise<string>;
  stop(): Promise<void>;
}

export class BridgeManager {
  private generation = 0;
  private starting = false;
  private failure: string | undefined;
  private pendingStart: Promise<BridgeStatus> | undefined;
  private pendingStop: Promise<BridgeStatus> | undefined;

  constructor(private readonly server: BridgeServerPort, private readonly tunnel: BridgeTunnelPort) {}

  async status(): Promise<BridgeStatus> {
    const value = await this.server.status();
    if (this.failure) return { ...value, state: 'error', message: this.failure, pendingApprovals: [], connections: [], url: undefined };
    return this.starting ? { ...value, state: 'starting' } : value;
  }

  start(input: BridgeStartInput): Promise<BridgeStatus> {
    if (this.pendingStart || this.pendingStop) return Promise.reject(new Error('Your web connection is changing. Please wait a moment.'));
    const generation = ++this.generation;
    this.failure = undefined;
    this.starting = true;
    const task = (async () => {
      try {
        const before = await this.server.status();
        if (before.state !== 'off') return before;
        const origin = new URL(await this.server.start(input));
        if (generation !== this.generation) return this.status();
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/') throw new Error('The private bridge could not open.');
        const publicUrl = await this.tunnel.start(Number(origin.port));
        if (generation !== this.generation) return this.status();
        this.server.setPublicUrl(publicUrl);
      } catch {
        if (generation === this.generation) {
          // Erase tokens and stop admitting work before stopping the outbound tunnel.
          await this.server.stop().catch(() => {});
          await this.tunnel.stop().catch(() => {});
          this.failure = 'Your temporary web link could not open. Check your internet connection, then try again. Your local notes are still available.';
        }
      } finally {
        if (generation === this.generation) this.starting = false;
      }
      return this.status();
    })();
    this.pendingStart = task;
    void task.finally(() => { if (this.pendingStart === task) this.pendingStart = undefined; }).catch(() => {});
    return task;
  }

  stop(): Promise<BridgeStatus> {
    if (this.pendingStop) return this.pendingStop;
    ++this.generation;
    this.starting = false;
    this.failure = undefined;
    const starting = this.pendingStart;
    const task = (async () => {
      const results = await Promise.allSettled([this.server.stop(), this.tunnel.stop()]);
      // A listener being opened when Stop was clicked must never survive the stop.
      await starting?.catch(() => {});
      results.push(...await Promise.allSettled([this.server.stop(), this.tunnel.stop()]));
      if (results.some(result => result.status === 'rejected')) this.failure = 'Your web connection could not finish closing. Close Interego before trying again.';
      return this.status();
    })();
    this.pendingStop = task;
    void task.finally(() => { if (this.pendingStop === task) this.pendingStop = undefined; }).catch(() => {});
    return task;
  }

  async connectionLost(): Promise<void> {
    await this.stop();
    this.failure = 'Your web link closed. Access through it has stopped. Start a new link and reconnect your web app to continue.';
  }

  async approve(id: string): Promise<BridgeStatus> {
    if (this.starting || this.pendingStop || this.failure) throw new Error('Your web connection is not ready.');
    await this.server.approve(id);
    return this.status();
  }

  async deny(id: string): Promise<BridgeStatus> {
    this.server.deny(id);
    return this.status();
  }
}
