import { describe, expect, it } from 'vitest';
import { COVERAGE_QUERY_LIMITS, validateCoverageQueryInput } from '../src/coverage-query-input.js';

const row = (concept = 'actual-concept', taughtIn: string[] = ['course-one']) => ({
  concept, taughtIn, mentionedIn: [],
});
const histogram = () => ({
  coverage: [row()], privacy_mode: 'zk-distribution', epsilon: 0.5,
  distribution_edges: ['0', '1', '2'], distribution_max_value: '10',
});

describe('coverage aggregate input validation', () => {
  it('refuses missing records and incomplete records instead of inventing an undefined participation', () => {
    for (const input of [undefined, null, [], {}, { coverage: null }, { coverage: [{}] },
      { coverage: [{ concept: 'x' }] }, { coverage: [{ concept: 'x', taughtIn: [], mentionedIn: null }] }]) {
      expect(validateCoverageQueryInput(input)).not.toBeNull();
    }
  });

  it('accepts an explicitly empty ordinary aggregate and valid supplied records without mutation', () => {
    expect(validateCoverageQueryInput({ coverage: [] })).toBeNull();
    const input = { coverage: [row()], privacy_mode: 'abac' };
    const before = JSON.stringify(input);
    expect(validateCoverageQueryInput(input)).toBeNull();
    expect(JSON.stringify(input)).toBe(before);
    expect(validateCoverageQueryInput({ coverage: [row()], privacy_mode: 'merkle-attested-opt-in' })).toBeNull();
  });

  it('refuses empty or oversized concept/reference text and repeated concepts', () => {
    for (const coverage of [
      [row('  ')], [row('x'.repeat(COVERAGE_QUERY_LIMITS.textLength + 1))],
      [row('x', [''])], [{ ...row(), mentionedIn: [42] }],
      [row('x'), row('x')],
    ]) expect(validateCoverageQueryInput({ coverage })).not.toBeNull();
  });

  it('bounds record count, each reference list and total references', () => {
    expect(validateCoverageQueryInput({
      coverage: Array.from({ length: COVERAGE_QUERY_LIMITS.records + 1 }, (_, i) => row('c-' + i, [])),
    })).not.toBeNull();
    expect(validateCoverageQueryInput({
      coverage: [row('x', Array.from({ length: COVERAGE_QUERY_LIMITS.referencesPerList + 1 }, () => 'course'))],
    })).not.toBeNull();
    expect(validateCoverageQueryInput({
      coverage: Array.from({ length: 11 }, (_, i) => row('c-' + i, Array.from({ length: 1000 }, () => 'course'))),
    })).not.toBeNull();
  });

  it('accepts only declared privacy modes and finite positive epsilon', () => {
    for (const mode of [null, '', 'other', 42]) {
      expect(validateCoverageQueryInput({ coverage: [row()], privacy_mode: mode })).not.toBeNull();
    }
    for (const epsilon of [null, 0, -1, NaN, Infinity, -Infinity, '0.5']) {
      expect(validateCoverageQueryInput({ ...histogram(), epsilon })).not.toBeNull();
    }
    expect(validateCoverageQueryInput({ ...histogram(), epsilon: Number.MIN_VALUE })).not.toBeNull();
  });

  it('requires a nonempty histogram, epsilon and both decimal-string range parameters', () => {
    const input = histogram();
    expect(validateCoverageQueryInput(input)).toBeNull();
    expect(validateCoverageQueryInput({ ...input, coverage: [] })).not.toBeNull();
    expect(validateCoverageQueryInput({ ...input, epsilon: undefined })).not.toBeNull();
    expect(validateCoverageQueryInput({ ...input, distribution_edges: undefined })).not.toBeNull();
    expect(validateCoverageQueryInput({ ...input, distribution_max_value: undefined })).not.toBeNull();
  });

  it('rejects malformed, unordered and unbounded histogram range parameters before BigInt construction', () => {
    for (const distribution_edges of [[], ['0'], ['0', '0'], ['2', '1'], ['-1', '2'],
      ['0', '1.5'], ['0', '1e3'], [0, 1], ['0', '9'.repeat(21)],
      Array.from({ length: 66 }, (_, i) => String(i))]) {
      expect(validateCoverageQueryInput({ ...histogram(), distribution_edges })).not.toBeNull();
    }
    for (const distribution_max_value of [null, 10, '-1', '1.5', '9'.repeat(21), '1']) {
      expect(validateCoverageQueryInput({ ...histogram(), distribution_max_value })).not.toBeNull();
    }
    expect(validateCoverageQueryInput({ coverage: [row()], distribution_edges: ['0', 'not-a-number'] })).not.toBeNull();
  });

  it('rejects actual supplied counts outside the supported histogram range', () => {
    expect(validateCoverageQueryInput({
      ...histogram(), coverage: [row('x', [])], distribution_edges: ['1', '2'],
    })).not.toBeNull();
    expect(validateCoverageQueryInput({
      ...histogram(), coverage: [row('x', ['one', 'two', 'three'])],
      distribution_edges: ['0', '1'], distribution_max_value: '2',
    })).not.toBeNull();
  });
});
