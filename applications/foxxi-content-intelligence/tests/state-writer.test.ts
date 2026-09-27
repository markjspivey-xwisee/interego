/**
 * Keeping one piece of state written: the latest of it, one write at a time, with a failed write
 * tried again on its own after a pause that grows while the store keeps failing. And reading it in:
 * once it has been read, with a read that failed tried again rather than taken for an empty one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stateReader, stateWriter } from '../src/state-writer.js';

const policy = { minRetryMs: 1_000, maxRetryMs: 4_000 };

describe('a state writer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes each change once, one write at a time, and a change during a write after it', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const w = stateWriter(() => { calls++; return new Promise<void>(r => { release = r; }); }, policy);
    w.request();
    w.request();
    w.request();
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);   // the changes asked for during the first write, written together
    release();
    await w.settled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(2);
  });

  it('tries a failed write again after a pause, with no further change asking', async () => {
    let calls = 0;
    const w = stateWriter(async () => { if (++calls === 1) throw new Error('pod unavailable'); }, policy);
    w.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(policy.minRetryMs - 1);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);   // written: nothing more to do
  });

  it('retries a change asked for during a write that then fails', async () => {
    let calls = 0;
    let fail: (e: Error) => void = () => undefined;
    const w = stateWriter(() => { calls++; return calls === 1 ? new Promise<void>((_, reject) => { fail = reject; }) : Promise.resolve(); }, policy);
    w.request();
    w.request();   // a change while the first write is under way
    fail(new Error('pod unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(policy.minRetryMs);
    expect(calls).toBe(2);
  });

  it('pauses longer while writes keep failing, lets changes wait for the pause, and starts afresh after a write lands', async () => {
    const at: number[] = [];
    let failing = true;
    const w = stateWriter(async () => { at.push(Date.now()); if (failing) throw new Error('pod unavailable'); }, policy);
    const t0 = Date.now();
    w.request();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) { w.request(); await vi.advanceTimersByTimeAsync(0); }
    expect(at).toHaveLength(1);   // changes during the pause wait for it
    await vi.advanceTimersByTimeAsync(20_000);
    expect(at.map(t => t - t0)).toEqual([0, 1_000, 3_000, 7_000, 11_000, 15_000, 19_000]);   // 1s, 2s, 4s, then capped at 4s
    failing = false;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(at).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(2_500);
    failing = true;
    w.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(at).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(policy.minRetryMs);
    expect(at).toHaveLength(10);   // the shortest pause again, not the longest reached before
    expect(at[9]! - at[8]!).toBe(policy.minRetryMs);
  });
});

describe('a state reader', () => {
  it('reads once, merges what it read, and does not read again', async () => {
    const taken: unknown[] = [];
    let reads = 0;
    const r = stateReader(async () => { reads++; return { held: reads }; }, state => { taken.push(state); });
    expect(r.loaded).toBe(false);
    expect(await r.load()).toBe(true);
    expect(await r.load()).toBe(true);
    expect(r.loaded).toBe(true);
    expect(reads).toBe(1);
    expect(taken).toEqual([{ held: 1 }]);
  });

  it('counts a store that holds nothing as read, with nothing to merge', async () => {
    const take = vi.fn();
    const r = stateReader(async () => null, take);
    expect(await r.load()).toBe(true);
    expect(r.loaded).toBe(true);
    expect(take).not.toHaveBeenCalled();
  });

  it('tries a failed read again on the next call, and merges nothing from it', async () => {
    const taken: unknown[] = [];
    let reads = 0;
    const r = stateReader(async () => { if (++reads === 1) throw new Error('pod unavailable'); return { held: reads }; }, state => { taken.push(state); });
    expect(await r.load()).toBe(false);
    expect(r.loaded).toBe(false);
    expect(taken).toEqual([]);
    expect(await r.load()).toBe(true);
    expect(reads).toBe(2);
    expect(taken).toEqual([{ held: 2 }]);
  });

  it('tries again after a read that fails at once, before anything is awaited', async () => {
    let reads = 0;
    const r = stateReader(() => { if (++reads === 1) throw new Error('no store configured yet'); return Promise.resolve(null); }, () => undefined);
    expect(await r.load()).toBe(false);
    expect(await r.load()).toBe(true);
    expect(reads).toBe(2);
  });

  it('shares one read among the calls made while it is under way', async () => {
    let release: (state: unknown) => void = () => undefined;
    let reads = 0;
    const r = stateReader(() => { reads++; return new Promise(resolve => { release = resolve; }); }, () => undefined);
    const first = r.load();
    const second = r.load();
    expect(reads).toBe(1);
    release({ held: true });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(reads).toBe(1);
  });
});
