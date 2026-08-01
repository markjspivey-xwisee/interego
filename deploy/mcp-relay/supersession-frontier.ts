/**
 * Which descriptors are the CURRENT heads of a supersession chain.
 *
 * ── WHY THIS EXISTS AS ITS OWN MODULE ────────────────────────────────────────
 *
 * The relay had this logic twice, and only one copy was right.
 *
 * `get_current_head` — the READ half of compare-and-swap — computes the frontier
 * correctly: an entry is a head iff no other entry describing the same graph declares
 * `iep:supersedes` at it.
 *
 * The WRITE half did not. `publish_context`'s `if_match` precondition compared the
 * caller's assertion against `descriptor.supersedes`, which under `auto_supersede_prior`
 * holds EVERY prior version of the graph, not just the head. Membership in that list is
 * not a compare-and-swap: an ancestor stays in it forever, so the assertion "the head I
 * read is still the head" passed even when it demonstrably was not.
 *
 * Concretely, with versions v0 → v1 already published:
 *
 *     publish v2, if_match = v0   →   precondition.passed: true      (observed live)
 *
 * That is the lost-update the precondition exists to prevent. Two writers who both read
 * v1 both succeed; the second silently overwrites a state it never saw. Worse than an
 * absent guard, because the response affirms `precondition.passed` — a caller that
 * checks the field it was told to check is told the swap was atomic when it was not.
 *
 * The two halves of one CAS have to agree on what "head" means, so they now share this
 * function rather than each carrying an opinion.
 *
 * ── WHY THE MANIFEST IS ENOUGH ───────────────────────────────────────────────
 *
 * The manifest mirrors each entry's `iep:supersedes`, so the frontier is computable
 * from the single manifest GET the publish path already performs. No descriptor bodies
 * are fetched to answer this question.
 */

/** The manifest fields this computation needs. Structural, so both callers' types fit. */
export interface FrontierEntry {
  readonly descriptorUrl: string;
  readonly describes: readonly string[];
  readonly supersedes?: readonly string[];
}

export interface Frontier {
  /**
   * Entries nothing else supersedes. One is the normal case; more than one means the
   * chain forked — reported, never silently resolved, for the same reason the roster
   * fold reports divergence: picking a winner between two states is a guess, and a
   * guess about which write survived is not something a storage layer may make.
   */
  readonly heads: readonly string[];
  /** Ancestors — still dereferenceable, still cited, but no longer the head. */
  readonly superseded: readonly string[];
  /** Every entry describing this graph, heads and ancestors alike. */
  readonly all: readonly string[];
}

/**
 * Compute the supersession frontier for one graph IRI.
 *
 * @param entries    manifest entries for the pod
 * @param graphIri   the graph whose chain we want
 * @param options.exclude    descriptor URL to leave out (the publish being prepared)
 * @param options.normalize  URL canonicaliser. Manifest entries and `iep:supersedes`
 *   targets can carry either the internal-FQDN host or the legacy public one depending
 *   on when they were written. Comparing raw strings across that boundary would find no
 *   superseder and report every ancestor as a live head — which reads as a forked chain
 *   and, on the write path, would let a stale assertion through exactly as before. The
 *   caller supplies the same normaliser it uses elsewhere; identity is the default.
 */
export function supersessionFrontier(
  entries: readonly FrontierEntry[],
  graphIri: string,
  options: { readonly exclude?: string; readonly normalize?: (url: string) => string } = {},
): Frontier {
  const norm = options.normalize ?? ((u: string) => u);
  const excluded = options.exclude === undefined ? undefined : norm(options.exclude);

  const describing = entries.filter(
    e => e.describes.includes(graphIri) && (excluded === undefined || norm(e.descriptorUrl) !== excluded),
  );

  // An entry is superseded iff some OTHER describing entry points at it. Restricting the
  // superseder set to describing entries is deliberate: a descriptor for an unrelated
  // graph that happens to cite this one has not taken over this chain, and letting it
  // retire a head would make an unrelated publish silently invalidate a live CAS token.
  const superseded = new Set<string>();
  for (const e of describing) {
    for (const s of e.supersedes ?? []) superseded.add(norm(s));
  }

  const heads: string[] = [];
  const dead: string[] = [];
  for (const e of describing) {
    (superseded.has(norm(e.descriptorUrl)) ? dead : heads).push(e.descriptorUrl);
  }

  return { heads, superseded: dead, all: describing.map(e => e.descriptorUrl) };
}
