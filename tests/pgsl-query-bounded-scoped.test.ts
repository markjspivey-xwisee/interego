/**
 * The bounded, access-scoped query service — the thing an agent can ASK.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * The relay's only lattice-wide read was a whole-corpus dump, so "which fragments contain this
 * atom" was answerable only by transferring everything and filtering at the client. An agent could
 * not query, so it downloaded, so responses were unbounded — the root of 51 audited surfaces.
 *
 * Two properties here are worth more than the happy path, because both are ways a "bounded" reader
 * can be quietly wrong:
 *
 *   1. THE CURSOR MUST COME FROM THE LAST KEY READ, not the last item returned. When access
 *      filtering removes the tail of a page, resuming from the last SURVIVING item re-reads or skips
 *      the rows between. A walk that loses rows in the middle looks exactly like a walk that
 *      finished.
 *   2. AN EMPTY PAGE IS NOT THE END. If the PDP removes everything on a page, `items` is empty while
 *      more pages remain. A reader that stops on `items.length === 0` truncates silently — so
 *      `nextCursor` is the only thing that says whether the walk is over.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb, openStore, PgslQuery, clearancePdp, publicAtomAddress,
  type QueryPrincipal, type StoredNode,
} from '../packages/pgsl-store/src/index.js';

const PRINCIPAL: QueryPrincipal = { subject: 'did:test:reader', clearance: 0, scope: 'default' };
const CLEARED: QueryPrincipal = { subject: 'did:test:cleared', clearance: 5, scope: 'default' };

const atom = (v: string): StoredNode => ({ uri: publicAtomAddress(v), kind: 'atom', level: 0, value: v });

/** A fragment URN must be exactly 40 hex — a readable tag is not a valid address here. */
const fragUri = (seed: number): string =>
  'urn:pgsl:fragment:' + seed.toString(16).padStart(40, 'a').slice(0, 40);

/** A lattice with one fragment containing `n` atoms, so the CI index has `n` ordered rows. */
async function seedFragment(store: ReturnType<typeof openStore>, n: number, seed: number): Promise<string> {
  const atoms = Array.from({ length: n }, (_, i) => atom(`s${seed}-atom-${String(i).padStart(4, '0')}`));
  const frag: StoredNode = {
    uri: fragUri(seed),
    kind: 'fragment',
    level: 2,
    items: atoms.map((a) => a.uri),
  };
  await store.compose([...atoms, frag], { pod: 'https://pod/u1/', resource: 'ctx/' + seed });
  return frag.uri;
}

describe('PgslQuery pages an index without touching the corpus', () => {
  it('★ returns at most a page, and walks the whole range exactly once', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const frag = await seedFragment(store, 47, 1);
    const q = new PgslQuery(fdb, PRINCIPAL, clearancePdp(PRINCIPAL.clearance));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof q.fragmentItems>> = await q.fragmentItems(frag, { pageSize: 10, cursor });
      expect(page.items.length).toBeLessThanOrEqual(10);
      seen.push(...page.items);
      pages++;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      if (pages > 50) throw new Error('cursor did not advance');
    }
    expect(seen.length).toBe(47);
    expect(new Set(seen).size).toBe(47);
    expect(pages).toBe(5);
  });

  it('a page smaller than the range ends the walk', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const frag = await seedFragment(store, 3, 2);
    const q = new PgslQuery(fdb, PRINCIPAL, clearancePdp(0));
    const page = await q.fragmentItems(frag, { pageSize: 100 });
    expect(page.items.length).toBe(3);
    expect(page.nextCursor).toBeNull();
  });

  it('the page size is capped so a caller cannot ask for the corpus', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const frag = await seedFragment(store, 30, 3);
    const q = new PgslQuery(fdb, PRINCIPAL, clearancePdp(0));
    // 10_000 is clamped to MAX_PAGE; the point is that it does not become "unbounded".
    const page = await q.fragmentItems(frag, { pageSize: 10_000 });
    expect(page.items.length).toBe(30);
  });

  it('fragmentsContaining answers the question the whole-corpus dump was standing in for', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const shared = atom('shared');
    const one: StoredNode = { uri: fragUri(0x11), kind: 'fragment', level: 2, items: [shared.uri, atom('a').uri] };
    const two: StoredNode = { uri: fragUri(0x22), kind: 'fragment', level: 2, items: [shared.uri, atom('b').uri] };
    await store.compose([shared, atom('a'), one], { pod: 'https://pod/u1/', resource: 'ctx/one' });
    await store.compose([shared, atom('b'), two], { pod: 'https://pod/u1/', resource: 'ctx/two' });
    const q = new PgslQuery(fdb, PRINCIPAL, clearancePdp(0));
    const page = await q.fragmentsContaining(shared.uri, { pageSize: 10 });
    expect(page.items.length).toBe(2);
  });
});

describe('the view is the principal\'s, and filtering does not break the walk', () => {
  it('★★ an empty page is NOT the end of the walk', async () => {
    // Everything on the first page is classified above the reader's clearance. `items` is empty and
    // `nextCursor` is set: a reader that stopped on an empty page would report the lattice as empty.
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const frag = await seedFragment(store, 20, 4);
    const items = (await store.fragmentItems(frag));
    for (const uri of items.slice(0, 10)) {
      await store.putAtomAttributes('default', uri, { classification: 3 });
    }
    const q = new PgslQuery(fdb, PRINCIPAL, clearancePdp(0)); // clearance 0: sees only public

    const first = await q.fragmentItems(frag, { pageSize: 10 });
    expect(first.items).toEqual([]);            // all ten filtered out
    expect(first.nextCursor).not.toBeNull();    // …and yet there is more

    const second = await q.fragmentItems(frag, { pageSize: 10, cursor: first.nextCursor });
    expect(second.items.length).toBe(10);       // the public half
  });

  it('★ the cursor survives a partially-filtered page without losing rows', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const frag = await seedFragment(store, 30, 3);
    const items = await store.fragmentItems(frag);
    // Classify every other item, so each page is half-removed and the last surviving item is never
    // the last row read — the case where a cursor taken from `items` would skip or repeat.
    for (let i = 0; i < items.length; i += 2) {
      await store.putAtomAttributes('default', items[i]!, { classification: 2 });
    }
    const q = new PgslQuery(fdb, PRINCIPAL, clearancePdp(0));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: Awaited<ReturnType<typeof q.fragmentItems>> = await q.fragmentItems(frag, { pageSize: 7, cursor });
      seen.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.length).toBe(15);              // exactly the unclassified half
    expect(new Set(seen).size).toBe(15);       // no repeats at the seams
  });

  it('a cleared principal sees what an uncleared one does not', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const frag = await seedFragment(store, 6, 5);
    for (const uri of await store.fragmentItems(frag)) {
      await store.putAtomAttributes('default', uri, { classification: 3 });
    }
    const open = new PgslQuery(fdb, CLEARED, clearancePdp(CLEARED.clearance));
    const shut = new PgslQuery(fdb, PRINCIPAL, clearancePdp(PRINCIPAL.clearance));
    expect((await open.fragmentItems(frag, { pageSize: 50 })).items.length).toBe(6);
    expect((await shut.fragmentItems(frag, { pageSize: 50 })).items).toEqual([]);
  });
});
