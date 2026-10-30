/** Owner-controlled web access. A saved address never implies an active listener. */
import type { BridgeStartInput, BridgeStatus, StableBridgeContext, StableBridgeInput, StableBridgeView, StoredStableBridge } from './bridge-types.js';
import { BridgeRouteError, verifyBridgeRoute, type BridgeReadiness } from './bridge-probe.js';

export interface BridgeServerPort {
  start(input: BridgeStartInput, stable?: StableBridgeContext): Promise<string>;
  setPublicUrl(url: string): void;
  status(): Promise<BridgeStatus>;
  approve(id: string): Promise<void>;
  deny(id: string): void;
  stop(): Promise<void>;
  forget?(): Promise<void>;
  readiness?(): BridgeReadiness;
}
export interface BridgeTunnelPort {
  start(port: number, stable?: StoredStableBridge): Promise<string>;
  stop(): Promise<void>;
}
export interface BridgeSettingsPort {
  get(): Promise<StoredStableBridge | null>;
  view(): Promise<StableBridgeView | null>;
  save(input: StableBridgeInput): Promise<StableBridgeView>;
  clear(): Promise<void>;
}
export interface BridgeManagerOptions {
  readonly settings?: BridgeSettingsPort;
  readonly verifyPublic?: typeof verifyBridgeRoute;
}

export class BridgeManager {
  private generation = 0;
  private starting = false;
  private failure: string | undefined;
  private pendingStart: Promise<BridgeStatus> | undefined;
  private pendingStop: Promise<BridgeStatus> | undefined;
  private startAbort: AbortController | undefined;
  private saving = false;

  constructor(private readonly server: BridgeServerPort, private readonly tunnel: BridgeTunnelPort, private readonly options: BridgeManagerOptions = {}) {}

  settings(): Promise<StableBridgeView | null> { return this.options.settings?.view() ?? Promise.resolve(null); }

  async status(): Promise<BridgeStatus> {
    const [value, saved] = await Promise.all([this.server.status().catch((): BridgeStatus => ({ state: 'error',
      message: 'Saved web pairings could not be opened. Forget the saved address to set it up again. Your notes are safe.',
      permissions: [], pendingApprovals: [], connections: [] })), this.settings()]);
    const result: BridgeStatus = saved ? { ...value, mode: 'stable', remembered: true, url: `${saved.origin}/mcp`,
      client: saved.policy.client, name: saved.policy.name, permissions: [...saved.policy.permissions], expiresInDays: saved.policy.expiresInDays } : value;
    if (this.failure) return { ...result, state: 'error', message: this.failure, pendingApprovals: [] };
    return this.starting ? { ...result, state: 'starting' } : result;
  }

  start(input: BridgeStartInput): Promise<BridgeStatus> { return this.begin(input); }

  async resume(): Promise<BridgeStatus> {
    if (this.saving || this.pendingStop || this.pendingStart) throw new Error('Your web connection is changing. Please wait a moment.');
    const generation = this.generation;
    const saved = await this.options.settings?.get();
    // A read begun before Pause or Forget must never restart their closed bridge.
    if (generation !== this.generation || this.saving || this.pendingStop || this.pendingStart) return this.status();
    if (!saved) throw new Error('Save your own permanent address before enabling it.');
    return this.begin(saved.policy, saved);
  }

  private begin(input: BridgeStartInput, stable?: StoredStableBridge): Promise<BridgeStatus> {
    if (this.pendingStart || this.pendingStop || this.saving) return Promise.reject(new Error('Your web connection is changing. Please wait a moment.'));
    const generation = ++this.generation;
    const cancel = new AbortController(); this.startAbort = cancel;
    this.failure = undefined; this.starting = true;
    const task = (async () => {
      try {
        if (!stable && await this.settings()) throw new Error('saved-address');
        const before = await this.server.status().catch(() => { throw new Error('saved-pairings-unavailable'); });
        if (before.state !== 'off') return before;
        const context = stable ? { origin: stable.origin, port: stable.port } : undefined;
        const origin = new URL(await (context ? this.server.start(input, context) : this.server.start(input)));
        if (generation !== this.generation) return this.status();
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/') throw new Error('Invalid local bridge address.');
        const publicUrl = await (stable ? this.tunnel.start(Number(origin.port), stable) : this.tunnel.start(Number(origin.port)));
        if (generation !== this.generation) return this.status();
        if (stable && publicUrl !== stable.origin) throw new Error('The saved address does not match this connection.');
        this.server.setPublicUrl(publicUrl);
        if (stable) {
          const proof = this.server.readiness?.();
          if (!proof) throw new Error('The bridge cannot verify its public address.');
          await (this.options.verifyPublic ?? verifyBridgeRoute)(publicUrl, proof, cancel.signal);
        }
      } catch (error) {
        if (generation === this.generation) {
          await this.server.stop().catch(() => {});
          await this.tunnel.stop().catch(() => {});
          this.failure = error instanceof Error && error.message === 'saved-pairings-unavailable'
            ? 'Saved web pairings could not be opened. Forget the saved address to set it up again. Your notes are safe.'
            : error instanceof BridgeRouteError ? error.message
            : error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'Another app is using the saved local connection. Close it and try again. Your address and pairings were kept.'
              : error instanceof Error && error.message === 'saved-address' ? 'Forget the saved permanent address before using a temporary link.'
                : stable ? 'Your saved web connection could not open. Check your internet connection and tunnel settings, then try again. Your address and pairings were kept.'
                  : 'Your temporary web link could not open. Check your internet connection, then try again. Your local notes are still available.';
        }
      } finally { if (generation === this.generation) this.starting = false; }
      return this.status();
    })();
    this.pendingStart = task;
    void task.finally(() => { if (this.pendingStart === task) this.pendingStart = undefined; }).catch(() => {});
    return task;
  }

  stop(): Promise<BridgeStatus> {
    if (this.pendingStop) return this.pendingStop;
    ++this.generation; this.startAbort?.abort();
    this.starting = false; this.failure = undefined;
    const starting = this.pendingStart;
    const task = (async () => {
      const results = await Promise.allSettled([this.server.stop(), this.tunnel.stop()]);
      await starting?.catch(() => {});
      results.push(...await Promise.allSettled([this.server.stop(), this.tunnel.stop()]));
      if (results.some(result => result.status === 'rejected')) this.failure = 'Your web connection could not finish closing. Close Interego before trying again.';
      return this.status();
    })();
    this.pendingStop = task;
    void task.finally(() => { if (this.pendingStop === task) this.pendingStop = undefined; }).catch(() => {});
    return task;
  }

  async save(input: StableBridgeInput): Promise<StableBridgeView> {
    if (!this.options.settings) throw new Error('Permanent addresses are unavailable.');
    if (this.saving || this.pendingStart || this.pendingStop) throw new Error('Your web connection is changing. Please wait a moment.');
    this.saving = true;
    try {
      if (await this.settings()) throw new Error('Forget the existing permanent address before changing its setup.');
      await this.stop();
      await this.server.forget?.();
      return await this.options.settings.save(input);
    } finally { this.saving = false; }
  }

  async forget(): Promise<BridgeStatus> {
    if (this.saving) throw new Error('Your permanent address is being saved. Please wait a moment.');
    this.saving = true;
    try {
      await this.stop().catch(() => {});
      if (!this.server.forget) throw new Error('Saved web pairings could not be removed. Reopen Interego and try again.');
      await this.server.forget();
      await this.options.settings?.clear();
      this.failure = undefined;
      return await this.status();
    } finally { this.saving = false; }
  }

  async connectionLost(): Promise<void> {
    await this.stop();
    this.failure = await this.settings() ? 'Your web link closed. Turn web access on again to resume the same address and saved pairings.'
      : 'Your web link closed. Access through it has stopped. Start a new link and reconnect your web app to continue.';
  }

  async approve(id: string): Promise<BridgeStatus> {
    if (this.starting || this.pendingStop || this.failure) throw new Error('Your web connection is not ready.');
    await this.server.approve(id); return this.status();
  }

  async deny(id: string): Promise<BridgeStatus> { this.server.deny(id); return this.status(); }
}
