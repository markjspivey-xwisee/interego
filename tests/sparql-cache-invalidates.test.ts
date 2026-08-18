/**
 * A cached materialization must not outlive the lattice it was built from.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * `sparqlQueryPGSL` cached its triple store in a `WeakMap` keyed by the PGSL instance and NEVER
 * invalidated it. Every atom minted or fragment ingested after the first query was invisible for the
 * life of the process.
 *
 * ★ THE REASON THIS IS MORE THAN A STALENESS BUG: an audit's most tempting one-line fix for the
 * biggest blocker — "the query capability exists, just expose it at the relay" — routes through
 * exactly this function. Doing that would have served the lattice as it stood at the first query,
 * forever, over HTTP, to every agent, while every health signal looked fine. A stale-forever cache
 * is a defect wherever it is called from; it becomes a data-integrity incident the moment the caller
 * is remote.
 */

import { describe, it, expect } from 'vitest';
import { createPGSL, mintAtom, sparqlQueryPGSL } from '@interego/pgsl';
import type { IRI } from '@interego/core';

/** Fixed provenance — nothing here depends on who minted, only on WHEN it became visible. */
const PROV = {
  wasAttributedTo: 'did:test:cache' as IRI,
  generatedAtTime: '2026-01-01T00:00:00.000Z',
};

/**
 * How many triples the materialized graph currently answers with.
 *
 * Counts BINDINGS rather than distinct subjects: the engine returns `{bindings: [...]}` at the top
 * level and does not key projected variables the way a SPARQL-JSON reader would expect. Asserting on
 * a shape this test guessed at made every case report zero — a check that fails for a reason
 * unrelated to the property is no better than one that passes for the wrong reason.
 */
function tripleCount(pgsl: ReturnType<typeof createPGSL>): number {
  const r = sparqlQueryPGSL(pgsl, 'SELECT ?s WHERE { ?s ?p ?o }') as { bindings?: unknown[] };
  return (r.bindings ?? []).length;
}

describe('the SPARQL materialization cache tracks the lattice', () => {
  it('★ an atom minted AFTER the first query is visible to the second', () => {
    const pgsl = createPGSL(PROV);
    mintAtom(pgsl, 'first');
    const before = tripleCount(pgsl);

    mintAtom(pgsl, 'second-minted-after-the-first-query');
    const after = tripleCount(pgsl);

    // Before the fix this was `after === before` — the second query replayed the first
    // materialization and the new atom did not exist as far as any caller could tell.
    expect(after).toBeGreaterThan(before);
  });

  it('repeated queries against an UNCHANGED lattice stay consistent', () => {
    // The cache still has to be a cache: the point is invalidation, not disabling it.
    const pgsl = createPGSL(PROV);
    mintAtom(pgsl, 'stable');
    expect(tripleCount(pgsl)).toBe(tripleCount(pgsl));
  });

  it('several mints in a row are each picked up', () => {
    const pgsl = createPGSL(PROV);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      mintAtom(pgsl, 'atom-' + i);
      seen.push(tripleCount(pgsl));
    }
    // Strictly increasing: a version that only advanced once would flatten after the first.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it('two instances do not share a materialization', () => {
    const a = createPGSL(PROV);
    const b = createPGSL(PROV);
    mintAtom(a, 'only-in-a');
    mintAtom(a, 'also-only-in-a');
    expect(tripleCount(a)).toBeGreaterThan(tripleCount(b));
  });
});
