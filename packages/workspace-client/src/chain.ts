/**
 * Order within a stream comes from the chain the entries DECLARE, not from the order the
 * manifest happened to yield and not from a clock. A log whose order can be changed by a
 * timestamp is not an audit trail.
 */

/** One row of a manifest, reduced to what the walk needs. */
export interface ChainRow {
  readonly url: string;
  readonly cid: string | null;
  readonly validFrom?: string | null;
  readonly supersedes: readonly string[];
}

/** The result of walking a manifest's supersession links. */
export interface ChainWalk<T extends ChainRow> {
  readonly ordered: readonly T[];
  readonly forked: boolean;
  readonly heads: number;
  /**
   * HOW FAR the chain actually linked, and it is RETURNED rather than thrown away.
   *
   * A caller that tried to reconstruct it from `ordered` could not: on the partial path
   * `ordered` is the full manifest, so the arithmetic was always "walked N of N" — a number
   * that cannot be right in the one branch that only runs when the walk fell short.
   */
  readonly walked: number;
  readonly partial: boolean;
}

/** Turn a manifest response row into a {@link ChainRow}. */
export function toChainRow(e: Record<string, unknown>): ChainRow {
  const sup = e['supersedes'];
  return {
    url: String(e['descriptorUrl'] ?? ''),
    cid: (e['cid'] as string) ?? null,
    validFrom: (e['validFrom'] as string) ?? null,
    supersedes: Array.isArray(sup) ? (sup as string[]) : [],
  };
}

/**
 * Walk the supersession links to one head.
 *
 * Anything other than exactly one head is reported as a FORK and the rows are handed back
 * unordered. Picking one would be guessing which append survived.
 */
export function orderChain<T extends ChainRow>(rows: readonly T[]): ChainWalk<T> {
  const byUrl = new Map<string, T>(rows.map((r) => [r.url, r]));
  const superseded = new Set<string>();
  for (const r of rows) for (const s of r.supersedes) if (byUrl.has(s)) superseded.add(s);
  const heads = rows.filter((r) => !superseded.has(r.url));
  if (heads.length !== 1) {
    return { ordered: rows.slice(), forked: heads.length > 1, heads: heads.length, walked: 0, partial: true };
  }
  const out: T[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = (heads[0] as T).url;
  while (cur && byUrl.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const r = byUrl.get(cur) as T;
    out.unshift(r);
    cur = r.supersedes.find((s) => byUrl.has(s));
  }
  return {
    ordered: out.length === rows.length ? out : rows.slice(),
    forked: false,
    heads: 1,
    walked: out.length,
    partial: out.length !== rows.length,
  };
}
