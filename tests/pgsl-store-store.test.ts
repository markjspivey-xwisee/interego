import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  publicAtomAddress,
  type PutResult,
  type StoredNode,
} from '../packages/pgsl-store/src/index.js';

function atomNode(value: string): StoredNode {
  return { uri: publicAtomAddress(value), kind: 'atom', level: 0, value };
}
function fragmentNode(hex40: string, items: string[], level: number): StoredNode {
  return { uri: `urn:pgsl:fragment:${hex40}`, kind: 'fragment', level, items };
}

describe('pgsl-store: durable node store over the FdbLike seam (in-memory fake)', () => {
  it('SURVIVES RESTART WITH BODIES: a fresh store over the same backing rehydrates full node bodies', async () => {
    const fdb = new InMemoryFdb();
    const a = atomNode('altitude:2000');
    const frag = fragmentNode('c'.repeat(40), [a.uri], 1);
    frag.provenance = { wasAttributedTo: 'did:ethr:0xabc', generatedAtTime: '2026-07-08T00:00:00Z' };

    const store1 = openStore(fdb);
    expect((await store1.put(a)).created).toBe(true);
    expect((await store1.put(frag)).created).toBe(true);

    // "restart": brand-new store instance over the SAME durable backing.
    const store2 = openStore(fdb);
    const registry = await store2.rehydrate();
    expect(registry.size).toBe(2);

    const gotAtom = await store2.resolve(a.uri);
    expect(gotAtom).toEqual(a); // full value survived, not just the URI
    const gotFrag = await store2.resolve(frag.uri);
    expect(gotFrag).toEqual(frag); // items + level + provenance survived
  });

  it('IDEMPOTENT re-ingest = 0 new: content-addressed set-if-absent no-ops on replay', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);
    const a = atomNode('x');

    expect((await store.put(a)).created).toBe(true);
    expect((await store.put(a)).created).toBe(false); // dedup

    const slice = [atomNode('p'), atomNode('q'), fragmentNode('d'.repeat(40), [], 2)];
    const first = await store.putMany(slice);
    expect(first).toEqual({ created: 3, dedup: 0 });
    const second = await store.putMany(slice); // replay
    expect(second).toEqual({ created: 0, dedup: 3 });

    expect((await store.rehydrate()).size).toBe(1 + 3); // a + slice, no duplicates
  });

  it('CONTROL-PLANE UPDATE/DELETE: mutable KV coexists with the grow-only lattice', async () => {
    const fdb = new InMemoryFdb();
    const store = openStore(fdb);

    await store.cpSet('accounts', 'u1', { webId: 'https://pod/u1#me', v: 1 });
    expect(await store.cpGet('accounts', 'u1')).toEqual({ webId: 'https://pod/u1#me', v: 1 });

    // UPDATE (grow-only CAS could not do this)
    await store.cpSet('accounts', 'u1', { webId: 'https://pod/u1#me', v: 2 });
    expect(await store.cpGet<{ v: number }>('accounts', 'u1')).toEqual({ webId: 'https://pod/u1#me', v: 2 });

    // DELETE (revocation)
    await store.cpDelete('accounts', 'u1');
    expect(await store.cpGet('accounts', 'u1')).toBeNull();

    // clear a whole collection (revoke all of a user's creds), scoped to that collection
    await store.cpSet('auth', 'cred-a', { k: 1 });
    await store.cpSet('auth', 'cred-b', { k: 2 });
    await store.cpSet('accounts', 'keep', { k: 3 });
    await store.cpClearCollection('auth');
    expect(await store.cpGet('auth', 'cred-a')).toBeNull();
    expect(await store.cpGet('auth', 'cred-b')).toBeNull();
    expect(await store.cpGet('accounts', 'keep')).toEqual({ k: 3 }); // other collections untouched
  });

  it('TWO-WRITER CONVERGENCE: concurrent writers of the same node converge (conflict-retry, stored once)', async () => {
    const fdb = new InMemoryFdb();
    const A = openStore(fdb);
    const B = openStore(fdb);
    const node = atomNode('shared-atom');

    let bResult: PutResult | undefined;
    // Deterministically interleave B into the middle of A's first attempt.
    fdb.onBeforeCommit = async () => {
      fdb.onBeforeCommit = undefined; // once
      bResult = await B.put(node);
    };

    const aResult = await A.put(node);
    expect(bResult?.created).toBe(true); // B committed first
    expect(aResult.created).toBe(false); // A conflicted, retried, saw it present
    expect(fdb.size()).toBe(1); // stored exactly once
    expect(await A.resolve(node.uri)).toEqual(node);
  });
});
