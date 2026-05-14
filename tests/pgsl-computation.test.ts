/**
 * Tests for src/pgsl/computation.ts — structural computation over PGSL
 * content (date math, counting, aggregation, temporal ordering,
 * abstention). This 13-function module shipped with zero test coverage;
 * one of its functions (countUniquePGSL) was fully broken until it got
 * a test. These lock the rest down.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDate,
  daysBetween,
  dateDifference,
  orderChronologically,
  countUnique,
  sumValues,
  averageValues,
  extractNumbers,
  getLatestFact,
  findFirstAfter,
  whichCameFirst,
  shouldAbstain,
} from '../src/index.js';
import type { TemporalFact } from '../src/index.js';

describe('parseDate', () => {
  it('parses ISO dates', () => {
    expect(parseDate('2023-03-15')?.getTime()).toBe(new Date('2023-03-15').getTime());
  });
  it('parses "Month Day, Year"', () => {
    const d = parseDate('March 15, 2023');
    expect(d?.getFullYear()).toBe(2023);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(15);
  });
  it('parses "Day Month Year"', () => {
    const d = parseDate('15 March 2023');
    expect(d?.getFullYear()).toBe(2023);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(15);
  });
  it('parses M/D/YYYY', () => {
    const d = parseDate('3/15/2023');
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(15);
  });
  it('returns null for empty or unparseable input', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate('not a date at all')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts days and is order-independent', () => {
    const a = new Date('2023-01-01');
    const b = new Date('2023-01-31');
    expect(daysBetween(a, b)).toBe(30);
    expect(daysBetween(b, a)).toBe(30);
  });
  it('is zero for the same instant', () => {
    const a = new Date('2023-06-01T12:00:00Z');
    expect(daysBetween(a, new Date(a.getTime()))).toBe(0);
  });
});

describe('dateDifference', () => {
  it('reports units and direction', () => {
    const diff = dateDifference(new Date('2023-01-01'), new Date('2024-01-01'));
    expect(diff.days).toBe(365);
    expect(diff.years).toBe(1);
    expect(diff.direction).toBe('before'); // date1 is before date2
  });
  it('reports "after" when date1 is later, "same" when equal', () => {
    expect(dateDifference(new Date('2024-01-01'), new Date('2023-01-01')).direction).toBe('after');
    const d = new Date('2023-05-05');
    expect(dateDifference(d, new Date(d.getTime())).direction).toBe('same');
  });
});

describe('orderChronologically', () => {
  it('sorts ascending and drops items with null dates', () => {
    const items = [
      { id: 'c', when: '2023-03-01' },
      { id: 'a', when: '2023-01-01' },
      { id: 'x', when: 'garbage' },
      { id: 'b', when: '2023-02-01' },
    ];
    const ordered = orderChronologically(items, (i) => parseDate(i.when));
    expect(ordered.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('countUnique', () => {
  it('deduplicates by normalized string', () => {
    const r = countUnique(['Apple', 'apple', 'Banana']);
    expect(r.count).toBe(2);
    expect(r.duplicates).toContain('apple');
  });
  it('collapses items where one string contains the other', () => {
    const r = countUnique(['banana bread', 'banana bread for neighbors']);
    expect(r.count).toBe(1);
  });
});

describe('sumValues / averageValues', () => {
  it('sums values and preserves the breakdown', () => {
    const r = sumValues([
      { value: 10, source: 'a' },
      { value: 5, source: 'b' },
    ]);
    expect(r.total).toBe(15);
    expect(r.breakdown).toHaveLength(2);
  });
  it('averages with 2-decimal rounding and returns 0 for empty', () => {
    expect(averageValues([1, 2, 3, 4])).toBe(2.5);
    expect(averageValues([])).toBe(0);
  });
});

describe('extractNumbers', () => {
  it('pulls numeric values with surrounding context', () => {
    const nums = extractNumbers('I spent $1,200 on rent and 3 hours commuting');
    const values = nums.map((n) => n.value);
    expect(values).toContain(1200);
    expect(values).toContain(3);
    expect(nums.every((n) => typeof n.context === 'string' && n.context.length > 0)).toBe(true);
  });
});

describe('temporal fact queries', () => {
  const facts: TemporalFact[] = [
    { fact: 'moved to Boston', date: new Date('2021-01-01'), source: 's1', sessionIndex: 0 },
    { fact: 'moved to Seattle', date: new Date('2023-06-01'), source: 's2', sessionIndex: 2 },
    { fact: 'adopted a dog', date: new Date('2022-03-01'), source: 's3', sessionIndex: 1 },
  ];

  it('getLatestFact returns the most recent match', () => {
    const latest = getLatestFact(facts, (f) => f.includes('moved'));
    expect(latest?.fact).toBe('moved to Seattle');
  });
  it('getLatestFact returns null when nothing matches', () => {
    expect(getLatestFact(facts, (f) => f.includes('nonexistent'))).toBeNull();
  });
  it('findFirstAfter returns the earliest match strictly after a date', () => {
    const first = findFirstAfter(facts, new Date('2021-06-01'), (f) => f.includes('moved') || f.includes('dog'));
    expect(first?.fact).toBe('adopted a dog');
  });
  it('whichCameFirst orders two labelled facts', () => {
    const r = whichCameFirst(facts, 'Boston', 'Seattle');
    expect(r?.first).toBe('Boston');
    expect(r?.second).toBe('Seattle');
    expect(r?.daysBetween).toBeGreaterThan(0);
  });
  it('whichCameFirst returns null when a label is missing', () => {
    expect(whichCameFirst(facts, 'Boston', 'Atlantis')).toBeNull();
  });
});

describe('shouldAbstain', () => {
  it('abstains when too few question entities are present', () => {
    const session = new Set(['boston', 'dog']);
    const r = shouldAbstain(['quantum', 'teleportation', 'unicorn'], session);
    expect(r.abstain).toBe(true);
    expect(r.matchRatio).toBe(0);
    expect(r.missingEntities).toHaveLength(3);
  });
  it('does not abstain when enough entities match', () => {
    const session = new Set(['boston', 'seattle', 'dog']);
    const r = shouldAbstain(['boston', 'seattle'], session);
    expect(r.abstain).toBe(false);
    expect(r.matchRatio).toBe(1);
  });
  it('does not abstain on an empty question', () => {
    expect(shouldAbstain([], new Set()).abstain).toBe(false);
  });
});
