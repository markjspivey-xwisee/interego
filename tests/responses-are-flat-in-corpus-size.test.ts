/**
 * A response must not grow with the data behind it.
 *
 * ── ★★ WHY THIS IS A DIFFERENTIAL AND NOT A DESCRIPTOR CHECK ────────────────────────────────
 *
 * The obvious guard for "did this surface inline a collection it should have linked" is to inspect
 * the descriptor: does it declare `dcat:accessService` / `iep:reads` and then ship the dataset
 * anyway? That guard cannot work, and the exemplar proves it — the review-record descriptor declared
 * its evidence sources HONESTLY and returned 1,228,985 characters regardless. Every fact in the
 * Turtle was true; the behaviour was the lie.
 *
 * The only property that cannot be satisfied by editing a descriptor is RESPONSE WEIGHT AS A
 * FUNCTION OF CORPUS SIZE. A surface that hands back a judgement plus addresses is flat in N. One
 * that inlines is linear. So this measures the same call against a small store and a larger one and
 * fails on growth.
 *
 * ★ AND IT MEASURES A BOUND, NOT A SIZE. A threshold on absolute bytes would pass for the wrong
 * reason on a small fixture and fail for the wrong reason on a rich one; the ratio is what
 * distinguishes "bounded" from "small today".
 *
 * ★ SCOPE, HONESTLY: this covers the substrate reads the refactor bounded — the ones every vertical
 * inherits. It does not yet drive the HTTP surfaces, which need a live fixture store; that is the
 * next extension, and until it exists this gate does not claim to cover them.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb, openStore, PgslQuery, clearancePdp, publicAtomAddress,
  type QueryPrincipal, type StoredNode,
} from '../packages/pgsl-store/src/index.js';
import { createPGSL, mintAtom, ingest, describeNode } from '@interego/pgsl';
import type { IRI } from '@interego/core';

const PRINCIPAL: QueryPrincipal = { subject: 'did:test:weigh', clearance: 0, scope: 'default' };
const PROV = { wasAttributedTo: 'did:test:weigh' as IRI, generatedAtTime: '2026-01-01T00:00:00.000Z' };

/** Serialized weight of whatever a surface returns — what actually crosses the wire. */
const weigh = (v: unknown): number => JSON.stringify(v)?.length ?? 0;

/**
 * The ratio a bounded surface must stay under when the corpus grows 10x.
 *
 * Not 1.0: a bounded response still carries a cursor and per-item identifiers whose lengths vary a
 * little with the data. 1.5 is loose enough not to be brittle and far below the ~10x a linear
 * response shows.
 */
const MAX_GROWTH = 1.5;

const atom = (v: string): StoredNode => ({ uri: publicAtomAddress(v), kind: 'atom', level: 0, value: v });
const fragUri = (seed: number): string => 'urn:pgsl:fragment:' + seed.toString(16).padStart(40, 'a').slice(0, 40);

async function storeWith(n: number, seed: number): Promise<{ q: PgslQuery; frag: string }> {
  const fdb = new InMemoryFdb();
  const store = openStore(fdb);
  const atoms = Array.from({ length: n }, (_, i) => atom(`s${seed}-${String(i).padStart(5, '0')}`));
  const frag: StoredNode = { uri: fragUri(seed), kind: 'fragment', level: 2, items: atoms.map(a => a.uri) };
  await store.compose([...atoms, frag], { pod: 'https://pod/u1/', resource: 'ctx/' + seed });
  return { q: new PgslQuery(fdb, PRINCIPAL, clearancePdp(0)), frag: frag.uri };
}

describe('★ a bounded read is FLAT in the size of the store behind it', () => {
  it('PgslQuery.fragmentItems: 10x the corpus does not grow the page', async () => {
    const small = await storeWith(20, 1);
    const large = await storeWith(200, 2);
    const a = weigh(await small.q.fragmentItems(small.frag, { pageSize: 10 }));
    const b = weigh(await large.q.fragmentItems(large.frag, { pageSize: 10 }));
    expect(b / a).toBeLessThan(MAX_GROWTH);
  });

  it('and the unbounded call it replaced IS linear — the control that makes this meaningful', async () => {
    // Without this, a bounded-looking result could be flat because the fixture is flat. Asking for
    // everything must visibly cost more, or the test above proves nothing.
    const small = await storeWith(20, 3);
    const large = await storeWith(200, 4);
    const a = weigh(await small.q.fragmentItems(small.frag, { pageSize: 1000 }));
    const b = weigh(await large.q.fragmentItems(large.frag, { pageSize: 1000 }));
    expect(b / a).toBeGreaterThan(5);
  });

  it('a page stays flat as the corpus grows again', async () => {
    const mid = await storeWith(200, 5);
    const big = await storeWith(2000, 6);
    const a = weigh(await mid.q.fragmentItems(mid.frag, { pageSize: 25 }));
    const b = weigh(await big.q.fragmentItems(big.frag, { pageSize: 25 }));
    expect(b / a).toBeLessThan(MAX_GROWTH);
  });
});

describe('★ a capped description is flat in how often its subject is reused', () => {
  function reused(n: number): { pgsl: ReturnType<typeof createPGSL>; shared: IRI } {
    const pgsl = createPGSL(PROV);
    const shared = mintAtom(pgsl, 'shared');
    for (let i = 0; i < n; i++) ingest(pgsl, [shared, mintAtom(pgsl, `n${i}`)]);
    return { pgsl, shared };
  }

  it('describeNode with a cap does not grow 10x when reuse grows 10x', () => {
    const a = reused(20);
    const b = reused(200);
    const da = weigh(describeNode(a.pgsl, a.shared, { hrefFor: String, maxNeighbors: 10 }));
    const db = weigh(describeNode(b.pgsl, b.shared, { hrefFor: String, maxNeighbors: 10 }));
    expect(db / da).toBeLessThan(MAX_GROWTH);
  });

  it('uncapped, it IS linear — again, the control', () => {
    const a = reused(20);
    const b = reused(200);
    const da = weigh(describeNode(a.pgsl, a.shared, { hrefFor: String, maxNeighbors: 0 }));
    const db = weigh(describeNode(b.pgsl, b.shared, { hrefFor: String, maxNeighbors: 0 }));
    expect(db / da).toBeGreaterThan(5);
  });

  it('and the capped description still reports the true total, so flat is not the same as lying', () => {
    // The failure this whole refactor is about is a bounded response that hides its bound. Flatness
    // is only acceptable BECAUSE the totals travel with it.
    const b = reused(200);
    const d = describeNode(b.pgsl, b.shared, { hrefFor: String, maxNeighbors: 10 })!;
    expect(d.truncated).toBe(true);
    expect(d._context.totalContainers).toBeGreaterThan(d._context.containers.length);
  });
});
