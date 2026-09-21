import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  publicAtomAddress,
  type StoredNode,
} from '../packages/pgsl-store/src/index.js';

function atom(value: string): StoredNode {
  return { uri: publicAtomAddress(value), kind: 'atom', level: 0, value };
}

describe('pgsl-store: compose-on-write + structural indexes (in-memory fake)', () => {
  const a = atom('alpha');
  const b = atom('beta');
  const c = atom('gamma');
  const frag: StoredNode = {
    uri: 'urn:pgsl:fragment:' + 'a'.repeat(40),
    kind: 'fragment',
    level: 2,
    items: [a.uri, b.uri, c.uri],
    left: a.uri,
    right: c.uri,
  };
  const slice = [a, b, c, frag];

  it('composes a slice in one transaction: nodes + overlay + structural queries', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);

    const res = await store.compose(slice, { pod: 'https://pod/u1/', resource: 'ctx/frag' });
    expect(res).toEqual({ created: 4, dedup: 0, topUri: frag.uri });

    // overlay: LDP resource -> holon
    expect(await store.resolveResource('https://pod/u1/', 'ctx/frag')).toEqual(frag);

    // CI: fragment -> ordered items (position order preserved)
    expect(await store.fragmentItems(frag.uri)).toEqual([a.uri, b.uri, c.uri]);

    // CB: item -> containing fragments
    expect(await store.fragmentsContaining(b.uri)).toEqual([frag.uri]);

    // LV: level slices
    expect(new Set(await store.levelSlice(0))).toEqual(new Set([a.uri, b.uri, c.uri]));
    expect(await store.levelSlice(2)).toEqual([frag.uri]);
  });

  it('a replay of existing nodes writes only the two overlay rows, never their projection rows again', async () => {
    // Re-setting V, P, I, B, L and R for a node that already exists changed nothing and cost a
    // dead tuple per row; on the production store that was thousands of row updates per manifest
    // publish. Count the writes through a wrapper around the in-memory transaction.
    const fdb = new InMemoryFdb();
    let sets = 0;
    const counting = {
      transact: <T>(fn: (txn: import('../packages/pgsl-store/src/fdb-like.js').FdbTxn) => Promise<T>): Promise<T> =>
        fdb.transact((txn) => fn({
          get: (k) => txn.get(k),
          set: (k, v) => { sets += 1; txn.set(k, v); },
          clear: (k) => txn.clear(k),
          clearRange: (b, e) => txn.clearRange(b, e),
          getRange: (b, e, o) => txn.getRange(b, e, o),
          compareAndSet: (k, exp, v) => txn.compareAndSet(k, exp, v),
        })),
      close: () => fdb.close(),
    };
    const store = openStore(counting);
    await store.compose(slice, { pod: 'https://pod/u1/', resource: 'ctx/frag' });
    const firstWrite = sets;
    // 4 nodes: N + V + P each = 12; the fragment adds 3 I + 3 B + L + R = 8; the overlay adds O + W = 2.
    expect(firstWrite).toBe(22);
    sets = 0;
    await store.compose(slice, { pod: 'https://pod/u1/', resource: 'ctx/frag' });
    expect(sets).toBe(2);
    expect(await store.fragmentItems(frag.uri)).toEqual([a.uri, b.uri, c.uri]);
  });

  it('compose is idempotent: replay writes 0 new nodes and leaves indexes intact', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    await store.compose(slice, { pod: 'https://pod/u1/', resource: 'ctx/frag' });

    const replay = await store.compose(slice, { pod: 'https://pod/u1/', resource: 'ctx/frag' });
    expect(replay).toEqual({ created: 0, dedup: 4, topUri: frag.uri });

    expect(await store.fragmentItems(frag.uri)).toEqual([a.uri, b.uri, c.uri]);
    expect(new Set(await store.levelSlice(0))).toEqual(new Set([a.uri, b.uri, c.uri]));
    expect((await store.rehydrate()).size).toBe(4);
  });

  it('survives restart: a fresh store over the same backing resolves the holon + indexes', async () => {
    const fdb = new InMemoryFdb();
    await openStore(fdb).compose(slice, { pod: 'https://pod/u1/', resource: 'ctx/frag' });

    const restarted = openStore(fdb);
    expect(await restarted.resolveResource('https://pod/u1/', 'ctx/frag')).toEqual(frag);
    expect(await restarted.fragmentItems(frag.uri)).toEqual([a.uri, b.uri, c.uri]);
    expect((await restarted.rehydrate()).size).toBe(4);
  });
});
