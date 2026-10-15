/**
 * Validate the public coverage aggregate's actual caller-supplied records before
 * configuration, BigInt conversion or aggregate construction. This establishes
 * shape and work bounds only, never that coverage was observed in a catalogue.
 */
export const COVERAGE_QUERY_LIMITS = {
  records: 1000,
  referencesPerList: 1000,
  totalReferences: 10000,
  textLength: 2048,
  histogramEdges: 65,
  decimalDigits: 20,
} as const;

const MODES = new Set(['abac', 'merkle-attested-opt-in', 'zk-distribution']);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
  && value.length <= COVERAGE_QUERY_LIMITS.textLength;
const decimal = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= COVERAGE_QUERY_LIMITS.decimalDigits
  && /^[0-9]+$/.test(value);

/** Return an actionable invalid-argument reason, or null for supported input. */
export function validateCoverageQueryInput(args: unknown): string | null {
  if (!object(args)) return 'Coverage query arguments must be an object';
  if (!Array.isArray(args.coverage)) return 'coverage must be an explicit array of supplied records';
  if (args.coverage.length > COVERAGE_QUERY_LIMITS.records) return 'coverage exceeds the 1000-record limit';
  const concepts = new Set<string>();
  const taughtCounts: number[] = [];
  let references = 0;
  for (let index = 0; index < args.coverage.length; index++) {
    const row: unknown = args.coverage[index];
    if (!object(row) || !boundedText(row.concept)) return 'coverage[' + index + '].concept must be a nonempty string of at most 2048 characters';
    if (concepts.has(row.concept)) return 'coverage contains a repeated concept: ' + row.concept;
    concepts.add(row.concept);
    for (const field of ['taughtIn', 'mentionedIn'] as const) {
      const values = row[field];
      if (!Array.isArray(values) || values.length > COVERAGE_QUERY_LIMITS.referencesPerList
        || values.some((value: unknown) => !boundedText(value))) {
        return 'coverage[' + index + '].' + field + ' must be an array of at most 1000 nonempty strings of at most 2048 characters';
      }
      references += values.length;
      if (references > COVERAGE_QUERY_LIMITS.totalReferences) return 'coverage exceeds the 10000-reference total limit';
      if (field === 'taughtIn') taughtCounts.push(values.length);
    }
  }
  const mode = args.privacy_mode ?? 'merkle-attested-opt-in';
  if (typeof mode !== 'string' || !MODES.has(mode)) return 'privacy_mode must be abac, merkle-attested-opt-in or zk-distribution';
  if (args.privacy_mode === null) return 'privacy_mode cannot be null';
  if (args.epsilon !== undefined && (typeof args.epsilon !== 'number'
    || !Number.isFinite(args.epsilon) || args.epsilon <= 0)) return 'epsilon must be a finite positive number';
  let edges: bigint[] | undefined;
  if (args.distribution_edges !== undefined) {
    if (!Array.isArray(args.distribution_edges) || args.distribution_edges.length < 2
      || args.distribution_edges.length > COVERAGE_QUERY_LIMITS.histogramEdges
      || args.distribution_edges.some((value: unknown) => !decimal(value))) {
      return 'distribution_edges must contain 2 to 65 nonnegative decimal strings of at most 20 digits';
    }
    edges = (args.distribution_edges as string[]).map(value => BigInt(value));
    for (let index = 1; index < edges.length; index++) {
      if (edges[index]! <= edges[index - 1]!) return 'distribution_edges must be strictly increasing';
    }
  }
  let maximum: bigint | undefined;
  if (args.distribution_max_value !== undefined) {
    if (!decimal(args.distribution_max_value)) return 'distribution_max_value must be a nonnegative decimal string of at most 20 digits';
    maximum = BigInt(args.distribution_max_value);
  }
  if (edges && maximum !== undefined && maximum < edges[edges.length - 1]!) {
    return 'distribution_max_value must be at least the final edge';
  }
  if (mode === 'zk-distribution') {
    if (args.coverage.length === 0) return 'zk-distribution requires at least one supplied coverage record';
    if (args.epsilon === undefined) return 'zk-distribution requires epsilon';
    // The existing sampler has a finite 48-bit uniform source. Reject scales that
    // can overflow its finite-number noise calculation before BigInt conversion.
    if (!Number.isFinite(64 / (args.epsilon as number))) return 'epsilon is too small for finite histogram noise';
    if (!edges || maximum === undefined) return 'zk-distribution requires distribution_edges and distribution_max_value';
    const minimum = edges[0]!;
    const upperBound = maximum;
    if (taughtCounts.some(count => BigInt(count) < minimum || BigInt(count) > upperBound)) {
      return 'Every supplied taughtIn count must lie between the first edge and distribution_max_value';
    }
  }
  return null;
}
