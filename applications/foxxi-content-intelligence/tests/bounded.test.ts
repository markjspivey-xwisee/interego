/**
 * Reading many pod entities a few at a time: results in order, failures left out, never more than
 * the limit in flight, and a limit that exceeds the list or falls below one still works.
 */
import { describe, expect, it } from 'vitest';
import { readEach } from '../src/bounded.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe('readEach', () => {
  it('returns the defined results in the items\' order, leaving out what threw or was undefined', async () => {
    const out = await readEach([1, 2, 3, 4, 5, 6], 2, async (n) => {
      await tick();
      if (n === 2) throw new Error('unreadable');
      if (n === 4) return undefined;
      return n * 10;
    });
    expect(out).toEqual([10, 30, 50, 60]);
  });
  it('never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await readEach(items, 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      await tick();
      inFlight -= 1;
      return n;
    });
    expect(out).toEqual(items);
    expect(peak).toBe(4);
    expect(inFlight).toBe(0);
  });
  it('reads everything at once when the limit exceeds the list, one at a time when it is below one, and nothing from nothing', async () => {
    let peak = 0;
    let inFlight = 0;
    const count = async (n: number): Promise<number> => { inFlight += 1; peak = Math.max(peak, inFlight); await tick(); inFlight -= 1; return n; };
    expect(await readEach([1, 2, 3], 10, count)).toEqual([1, 2, 3]);
    expect(peak).toBe(3);
    peak = 0;
    expect(await readEach([1, 2, 3], 0, count)).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
    expect(await readEach([], 8, count)).toEqual([]);
  });
});
