/** Serializes the complete native-owner browser policy transaction, including failure cleanup. */
import { extensionIds } from './browser-extensions.js';

export interface IdentityBrowserPolicyOptions {
  readonly loadAllowed: () => Promise<readonly string[]>;
  readonly saveAllowed: (ids: readonly string[]) => Promise<readonly string[]>;
  readonly revoke: () => void;
  readonly allowAdmission: () => void;
  readonly configureHost: (ids: readonly string[]) => Promise<readonly string[]>;
  readonly closing: () => boolean;
}
const interrupted = 'Browser sign-in setup was interrupted. Reopen Interego and save the allowed extension IDs again.';
function same(actual: readonly string[], expected: readonly string[]): void {
  if (extensionIds(actual).join(',') !== expected.join(',')) throw new Error('Browser sign-in access did not match the selected extensions. Review and save it again.');
}

export class IdentityBrowserPolicy {
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(private readonly options: IdentityBrowserPolicyOptions) {}
  /** Repair an upgrade's removed host registration using retained owner consent only. */
  reconcile(): Promise<readonly string[]> {
    const generation = this.generation;
    const current = () => !this.options.closing() && generation === this.generation;
    const task = this.queue.then(async () => {
      this.options.revoke();
      try {
        if (!current()) return [];
        const ids = extensionIds(await this.options.loadAllowed());
        // An empty or unreadable policy is never a request to register or disconnect.
        if (!ids.length || !current()) return [];
        same(await this.options.configureHost(ids), ids);
        if (!current()) return [];
        same(await this.options.loadAllowed(), ids);
        if (!current()) return [];
        this.options.allowAdmission();
        return ids;
      } catch (error) {
        this.options.revoke();
        throw error;
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
  save(value: unknown): Promise<readonly string[]> {
    const ids = extensionIds(value);
    // Supersede any pending startup repair as soon as the owner makes a choice.
    ++this.generation;
    const task = this.queue.then(async () => {
      try {
        this.options.revoke();
        same(await this.options.saveAllowed([]), []);
        if (this.options.closing()) throw new Error(interrupted);
        same(await this.options.configureHost(ids), ids);
        if (this.options.closing()) throw new Error(interrupted);
        same(await this.options.saveAllowed(ids), ids);
        if (this.options.closing()) throw new Error(interrupted);
        if (ids.length) this.options.allowAdmission();
        return ids;
      } catch (error) {
        // Revoke again after the asynchronous work. Failed/closing transactions never
        // leave authority written by themselves or an earlier queued transaction.
        let cleanupFailed = false;
        try { this.options.revoke(); } catch { cleanupFailed = true; }
        try { same(await this.options.saveAllowed([]), []); } catch { cleanupFailed = true; }
        if (cleanupFailed) throw new Error('Browser sign-in settings could not be cleared. Close Interego and check its storage before trying again.', { cause: error });
        throw error;
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
}
