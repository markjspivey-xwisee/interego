/** One shard of the mutation table: `index` of `count`, 1-based. */
export interface Shard {
  readonly index: number;
  readonly count: number;
}

/** `"2/5"` → `{ index: 2, count: 5 }`; throws on anything that is not `<index>/<count>` with 1 ≤ index ≤ count. */
export declare function parseShard(text: string): Shard;

/** The mutants a shard applies: every `count`-th of the table, starting at `index`. */
export declare function shardOf<T>(mutants: readonly T[], shard: Shard): T[];
