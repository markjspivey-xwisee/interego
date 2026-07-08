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
