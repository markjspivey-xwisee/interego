import { describe, expect, it, vi } from 'vitest';
import { IdentityBrowserPolicy } from '../src/identity-browser-policy.js';

const a = 'a'.repeat(32); const b = 'b'.repeat(32);
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
async function flush(): Promise<void> { for (let i = 0; i < 3; i++) await Promise.resolve(); }
function fixture() {
  let allowed: readonly string[] = [a]; let closing = false; let admission = true;
  const saveAllowed = vi.fn(async (ids: readonly string[]) => { allowed = [...ids]; return allowed; });
  const configureHost = vi.fn(async (ids: readonly string[]) => ids); const revoke = vi.fn(() => { admission = false; }); const allowAdmission = vi.fn(() => { admission = true; });
  const policy = new IdentityBrowserPolicy({ saveAllowed, configureHost, revoke, allowAdmission, closing: () => closing });
  return { policy, saveAllowed, configureHost, revoke, allowAdmission, admission: () => admission, allowed: () => allowed, close: () => { closing = true; } };
}

describe('native browser policy transaction', () => {
  it('serializes both denial and final authority so a newer failed change cannot resurrect an older allowlist', async () => {
    const f = fixture(); const firstHost = deferred<readonly string[]>();
    f.configureHost.mockImplementationOnce(() => firstHost.promise).mockImplementationOnce(async () => { throw new Error('Second registry update failed'); });
    const first = f.policy.save([a]); const second = f.policy.save([b]); const rejected = expect(second).rejects.toThrow('Second registry update failed');
    await flush(); expect(f.allowed()).toEqual([]); expect(f.configureHost).toHaveBeenCalledTimes(1);
    firstHost.resolve([a]); await expect(first).resolves.toEqual([a]); await rejected;
    expect(f.allowed()).toEqual([]);
    expect(f.admission()).toBe(false);
    expect(f.saveAllowed.mock.calls.map(args => args[0])).toEqual([[], [a], [], []]);
    expect(f.configureHost.mock.calls.map(args => args[0])).toEqual([[a], [b]]);
  });
  it('shutdown while configuring the host keeps authority denied and never performs the final grant', async () => {
    const f = fixture(); const host = deferred<readonly string[]>(); f.configureHost.mockImplementationOnce(() => host.promise);
    const save = f.policy.save([b]); const rejected = expect(save).rejects.toThrow('interrupted'); await flush(); f.close(); host.resolve([b]); await rejected;
    expect(f.allowed()).toEqual([]); expect(f.admission()).toBe(false); expect(f.allowAdmission).not.toHaveBeenCalled(); expect(f.saveAllowed.mock.calls.every(args => args[0].length === 0)).toBe(true); expect(f.revoke).toHaveBeenCalledTimes(2);
  });
  it('shutdown while committing authority clears the late grant before the operation returns', async () => {
    const f = fixture(); const commit = deferred<readonly string[]>();
    f.saveAllowed.mockImplementationOnce(async () => []).mockImplementationOnce(() => commit.promise);
    const save = f.policy.save([b]); const rejected = expect(save).rejects.toThrow('interrupted');
    for (let i = 0; i < 5; i++) await flush(); expect(f.saveAllowed).toHaveBeenCalledTimes(2);
    f.close(); commit.resolve([b]); await rejected; expect(f.allowed()).toEqual([]); expect(f.admission()).toBe(false); expect(f.allowAdmission).not.toHaveBeenCalled(); expect(f.saveAllowed).toHaveBeenLastCalledWith([]);
  });
  it('a failed grant is followed by denial and the queue remains usable for a later owner action', async () => {
    const f = fixture(); f.saveAllowed.mockImplementationOnce(async () => []).mockImplementationOnce(async () => { throw new Error('Storage failed'); });
    await expect(f.policy.save([b])).rejects.toThrow('Storage failed'); expect(f.allowed()).toEqual([]);
    await expect(f.policy.save([b])).resolves.toEqual([b]); expect(f.allowed()).toEqual([b]); expect(f.admission()).toBe(true); expect(f.allowAdmission).toHaveBeenCalledOnce();
  });
  it('rejects invalid input before revocation or registry work and checks actual saved policy', async () => {
    const f = fixture(); expect(() => f.policy.save(['*'])).toThrow(); expect(f.revoke).not.toHaveBeenCalled(); expect(f.configureHost).not.toHaveBeenCalled();
    f.configureHost.mockImplementationOnce(async () => [a]); await expect(f.policy.save([b])).rejects.toThrow('did not match'); expect(f.allowed()).toEqual([]);
  });
  it('reports failed denial cleanup instead of claiming that the old persisted authority was removed', async () => {
    const f = fixture(); f.saveAllowed.mockImplementation(async () => { throw new Error('Disk is full'); });
    await expect(f.policy.save([b])).rejects.toThrow('could not be cleared'); expect(f.revoke).toHaveBeenCalledTimes(2); expect(f.admission()).toBe(false); expect(f.configureHost).not.toHaveBeenCalled();
  });
});
