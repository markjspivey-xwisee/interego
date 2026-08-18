/**
 * A capped description must say it was capped.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * `describeNode` caps its context and paradigm arrays — it has to, because a heavily-reused atom
 * appears in thousands of fragments and an uncapped description would be enormous. What it did not
 * do was SAY SO, and it returned no totals, so the consumer had nothing to judge completeness by.
 *
 * The relay's published-node resolver therefore stamped `iep:contextComplete: true` on every capped
 * result: a node reused 20,000 times advertised its first 200 containers as the whole neighbourhood.
 * That is the same defect as an unbounded response wearing the opposite mask — one ships everything
 * and says nothing, the other ships a slice and claims it is everything.
 *
 * ★ The flag is DERIVED from counts here, not asserted. A boolean somebody has to remember to set is
 * a boolean that goes stale the first time a new cap is added.
 */

import { describe, it, expect } from 'vitest';
import { createPGSL, mintAtom, ingest, describeNode } from '@interego/pgsl';
import type { IRI } from '@interego/core';

const PROV = { wasAttributedTo: 'did:test:describe' as IRI, generatedAtTime: '2026-01-01T00:00:00.000Z' };
const href = (u: IRI): string => String(u);

/** One atom reused across `n` fragments, so it has `n` containers. */
function latticeWithReuse(n: number): { pgsl: ReturnType<typeof createPGSL>; shared: IRI } {
  const pgsl = createPGSL(PROV);
  const shared = mintAtom(pgsl, 'shared-atom');
  for (let i = 0; i < n; i++) {
    const other = mintAtom(pgsl, `neighbour-${i}`);
    ingest(pgsl, [shared, other]);
  }
  return { pgsl, shared };
}

/**
 * The true container count, measured rather than assumed.
 *
 * ★ `ingest` composes a HIERARCHY — four pair-fragments produced five containers and nine fragments
 * — so a test that hard-codes "n ingests means n containers" is asserting the author's model of the
 * lattice, not the property under test. It fails for a reason that has nothing to do with truncation.
 */
function uncappedTotal(pgsl: ReturnType<typeof createPGSL>, uri: IRI): number {
  return describeNode(pgsl, uri, { hrefFor: href, maxNeighbors: 0 })!._context.totalContainers;
}

describe('describeNode reports what the cap hid', () => {
  it('★ a capped description is marked truncated', () => {
    const { pgsl, shared } = latticeWithReuse(25);
    const total = uncappedTotal(pgsl, shared);
    const cap = total - 2;
    const d = describeNode(pgsl, shared, { hrefFor: href, maxNeighbors: cap })!;
    expect(d._context.containers.length).toBe(cap);
    expect(d.truncated).toBe(true);
  });

  it('★ and carries the TRUE total, not the page length', () => {
    const { pgsl, shared } = latticeWithReuse(25);
    const total = uncappedTotal(pgsl, shared);
    const d = describeNode(pgsl, shared, { hrefFor: href, maxNeighbors: 5 })!;
    expect(d._context.totalContainers).toBe(total);
    // The number a consumer needs to decide whether to go looking for the rest.
    expect(d._context.totalContainers).toBeGreaterThan(d._context.containers.length);
  });

  it('an UNcapped description is not marked truncated', () => {
    // The flag must not be permanently on, or it says nothing.
    const { pgsl, shared } = latticeWithReuse(4);
    const d = describeNode(pgsl, shared, { hrefFor: href, maxNeighbors: 500 })!;
    expect(d._context.containers.length).toBe(d._context.totalContainers);
    expect(d.truncated).toBe(false);
  });

  it('a cap exactly equal to the count is NOT truncation', () => {
    // The boundary is where an off-by-one hides: n of n is complete, n-1 of n is not.
    const { pgsl, shared } = latticeWithReuse(4);
    const total = uncappedTotal(pgsl, shared);
    expect(describeNode(pgsl, shared, { hrefFor: href, maxNeighbors: total })!.truncated).toBe(false);
    expect(describeNode(pgsl, shared, { hrefFor: href, maxNeighbors: total - 1 })!.truncated).toBe(true);
  });

  it('paradigm totals count DISTINCT neighbours even past the cap', () => {
    // Deduplication used to stop once the cap was reached, so the totals would have under-counted
    // exactly when they mattered. Each fragment here contributes a distinct left neighbour.
    const { pgsl, shared } = latticeWithReuse(12);
    const d = describeNode(pgsl, shared, { hrefFor: href, maxNeighbors: 3 })!;
    const listed = d._paradigm.sourceOptions.length + d._paradigm.targetOptions.length;
    const total = d._paradigm.totalSourceOptions + d._paradigm.totalTargetOptions;
    expect(total).toBeGreaterThan(listed);
  });

  it('an atom in no fragment is complete and empty', () => {
    const pgsl = createPGSL(PROV);
    const lonely = mintAtom(pgsl, 'unused');
    const d = describeNode(pgsl, lonely, { hrefFor: href, maxNeighbors: 200 })!;
    expect(d._context.totalContainers).toBe(0);
    expect(d.truncated).toBe(false);
  });
});
