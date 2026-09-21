/**
 * The weekly collector's two decisions, pure: when a measurement becomes a rebuild, and which
 * tables an earlier rebuild left behind may go. The rebuild holds an ACCESS EXCLUSIVE lock, so
 * the line it needs to cross is the part worth pinning.
 */
import { describe, expect, it } from 'vitest';
import { previousTablesToDrop, rebuildDecision } from '../tools/pgsl-store-gc.js';

describe('the rebuild line', () => {
  it('★ rebuilds the shape the 2026-09-20 outage had: most of a big table is history', () => {
    const d = rebuildDecision({ liveKeys: 1_192_421, tableRows: 78_700_000, line: 0.5, minRows: 2_000_000 });
    expect(d.rebuild).toBe(true);
    expect(d.reclaimableShare).toBeCloseTo(0.985, 3);
    expect(d.reason).toContain('98% of 78700000 rows are unreferenced history (1192421 live), at or above the line of 50%');
  });
  it('leaves a table alone below the line, and says how far below', () => {
    const d = rebuildDecision({ liveKeys: 1_500_000, tableRows: 2_400_000, line: 0.5, minRows: 2_000_000 });
    expect(d.rebuild).toBe(false);
    expect(d.reason).toContain('38% of 2400000 rows are unreferenced history (1500000 live), below the line of 50%');
  });
  it('★ never holds the lock for a small table, however stale it is', () => {
    const d = rebuildDecision({ liveKeys: 10, tableRows: 1_000_000, line: 0.5, minRows: 2_000_000 });
    expect(d.rebuild, 'a small table was rebuilt for almost nothing').toBe(false);
    expect(d.reason).toContain('below the floor of 2000000');
  });
  it('decides nothing on an unknown row estimate, and refuses a line outside 0..1', () => {
    expect(rebuildDecision({ liveKeys: 5, tableRows: -1, line: 0.5, minRows: 1 }).rebuild).toBe(false);
    expect(rebuildDecision({ liveKeys: 5, tableRows: -1, line: 0.5, minRows: 1 }).reason).toContain('unknown');
    expect(() => rebuildDecision({ liveKeys: 5, tableRows: 10, line: 0, minRows: 1 })).toThrow(/between 0 and 1/);
    expect(() => rebuildDecision({ liveKeys: 5, tableRows: 10, line: 1.5, minRows: 1 })).toThrow(/between 0 and 1/);
  });
  it('clamps a live count above the estimate to nothing reclaimable', () => {
    expect(rebuildDecision({ liveKeys: 3_000_000, tableRows: 2_500_000, line: 0.5, minRows: 2_000_000 }).reclaimableShare).toBe(0);
  });
});

describe('the bloat line', () => {
  it('★ rebuilds a table whose disk holds four times its live values, even with few rows unreferenced (2026-09-21)', () => {
    const d = rebuildDecision({ liveKeys: 1_231_930, tableRows: 1_329_857, line: 0.5, minRows: 2_000_000, totalBytes: 2_086_027_264, liveBytes: 521_500_000 });
    expect(d.rebuild, 'a bloated table was left alone because its rows were live').toBe(true);
    expect(d.reason).toContain('1989 MB on disk holds 497 MB of live values (4.0x, at or above 4x with at least 1024 MB)');
  });
  it('leaves a small or lightly bloated table alone, and says how far from the line', () => {
    const small = rebuildDecision({ liveKeys: 100, tableRows: 1_000, line: 0.5, minRows: 2_000_000, totalBytes: 600_000_000, liveBytes: 10_000_000 });
    expect(small.rebuild).toBe(false);
    expect(small.reason).toContain('under the 1024 MB floor');
    const light = rebuildDecision({ liveKeys: 1_231_930, tableRows: 1_329_857, line: 0.5, minRows: 2_000_000, totalBytes: 2_086_027_264, liveBytes: 900_000_000 });
    expect(light.rebuild).toBe(false);
    expect(light.reason).toContain('(2.3x, below 4x)');
  });
  it('decides on rows alone when no sizes are given', () => {
    expect(rebuildDecision({ liveKeys: 1_192_421, tableRows: 78_700_000, line: 0.5, minRows: 2_000_000 }).rebuild).toBe(true);
    expect(rebuildDecision({ liveKeys: 1_231_930, tableRows: 1_329_857, line: 0.5, minRows: 2_000_000 }).reason).not.toContain('on disk');
  });
});
describe('the previous tables', () => {
  const now = new Date('2026-09-28T06:30:00Z');
  it('drops only the copies older than the given days, oldest first, and never the live table', () => {
    const names = ['pgsl_kv', 'pgsl_kv_old_20260920', 'pgsl_kv_old_20260927', 'pgsl_kv_old_20260901', 'pgsl_kv_live', 'other_old_20260101'];
    expect(previousTablesToDrop(names, 'pgsl_kv', now, 7)).toEqual(['pgsl_kv_old_20260901', 'pgsl_kv_old_20260920']);
  });
  it('keeps a copy exactly under the threshold, drops one exactly at it', () => {
    expect(previousTablesToDrop(['pgsl_kv_old_20260922'], 'pgsl_kv', now, 7)).toEqual([]);
    expect(previousTablesToDrop(['pgsl_kv_old_20260921'], 'pgsl_kv', now, 7)).toEqual(['pgsl_kv_old_20260921']);
  });
});
