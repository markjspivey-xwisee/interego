import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  publicAtomAddress,
  type StoredNode,
} from '../packages/pgsl-store/src/index.js';

function atom(v: string): StoredNode {
  return { uri: publicAtomAddress(v), kind: 'atom', level: 0, value: v };
}

describe('pgsl-store: compose atomicity (S3 — one FDB transaction, all-or-nothing)', () => {
  it('a throw mid-slice writes NOTHING (no partial holon)', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const good = atom('good');
    // A malformed URN makes nodeAddrFromUrn throw INSIDE the transaction, after
    // `good` has already been buffered — the whole transaction must roll back.
    const bad: StoredNode = { uri: 'not-a-valid-pgsl-urn', kind: 'atom', level: 0, value: 'bad' };

    await expect(store.compose([good, bad], { pod: 'p', resource: 'r' })).rejects.toThrow();

    expect(fdb.size()).toBe(0); // good's buffered write was discarded
    expect((await store.rehydrate()).size).toBe(0);
    expect(await store.resolve(good.uri)).toBeNull();
    expect(await store.resolveResource('p', 'r')).toBeNull(); // no overlay either
  });

  it('the store is uncorrupted + usable after a failed compose', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const bad: StoredNode = { uri: 'bad-urn', kind: 'atom', level: 0, value: 'x' };
    await expect(store.compose([bad], { pod: 'p', resource: 'r' })).rejects.toThrow();

    // A subsequent valid compose commits fully.
    const a = atom('alpha');
    const frag: StoredNode = { uri: 'urn:pgsl:fragment:' + 'a'.repeat(40), kind: 'fragment', level: 1, items: [a.uri] };
    const res = await store.compose([a, frag], { pod: 'p', resource: 'r2' });
    expect(res.created).toBe(2);
    expect(await store.resolveResource('p', 'r2')).toEqual(frag);
    expect((await store.rehydrate()).size).toBe(2);
  });
});
