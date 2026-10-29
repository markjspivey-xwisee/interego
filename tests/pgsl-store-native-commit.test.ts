import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  openStore, InMemoryFdb, CodecRegistry, rdfCodec, LdpStore, openPgStore,
  atomAddress, nodeAddrFromUrn, representationDigest, resourceCollection,
  NativeResourceManagedError, type FdbLike, type FdbTxn, type NativeResourceReceipt,
} from '../packages/pgsl-store/src/index.js';
import { cpKey, nodeKey } from '../packages/pgsl-store/src/keyspace.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const POD = 'https://native.example/alice/';
const CT = 'application/octet-stream';
const bytes = (value: string): Uint8Array => enc.encode(value);
const fixture = (fdb: FdbLike = new InMemoryFdb()) => {
  const store = openStore(fdb);
  return { fdb, store, ldp: new LdpStore(store, new CodecRegistry().register(rdfCodec)) };
};
const opaqueUri = (value: string): string => atomAddress(Buffer.from(value).toString('base64'), {});
async function put(ldp: LdpStore, value: string, expectedRevision: string | null, path = 'head'): Promise<NativeResourceReceipt> {
  const result = await ldp.commitResource(POD, path, bytes(value), CT, { expectedRevision });
  expect(result.status).toBe('committed');
  if (result.status !== 'committed') throw new Error('unexpected native conflict');
  return result;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** Fault after the head CAS and some canonical/index writes, inside the real transaction. */
function faulting(backing: FdbLike): FdbLike {
  return {
    close: async () => {},
    transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
      return backing.transact(txn => {
        let writes = 0;
        return fn({ ...txn, set(key, value) {
          txn.set(key, value);
          if (++writes === 2) throw new Error('injected native transaction failure');
        } });
      });
    },
  };
}
/** Both real transactions capture the same CP row before either attempts CAS. */
function overlapping(backing: FdbLike, key: Uint8Array, arrived: { count: number; gate: ReturnType<typeof deferred> }): FdbLike {
  return {
    close: async () => {},
    transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
      return backing.transact(txn => fn({ ...txn, async get(requested) {
        const result = await txn.get(requested);
        if (Buffer.from(requested).equals(Buffer.from(key)) && ++arrived.count <= 2) {
          if (arrived.count === 2) arrived.gate.resolve();
          await arrived.gate.promise;
        }
        return result;
      } }));
    },
  };
}

describe('native PGSL resource commits', () => {
  it('returns its own commit-bound receipt and canonical source addresses', async () => {
    const { ldp, store } = fixture();
    const receipt = await put(ldp, 'exact bytes', null);
    expect(receipt).toMatchObject({ pod: POD, path: 'head', bodyDigest: representationDigest(bytes('exact bytes')), size: 11, contentType: CT });
    expect(receipt.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    const head = await store.resourceHead(POD, 'head');
    expect(head?.record.nativeManaged).toBe(true);
    expect(head?.revision).toBe(receipt.revision);
    expect((await store.resolveResource(POD, 'head'))?.uri).toBe(receipt.topUri);
    expect((await store.resolve(receipt.opaqueUri))?.value).toBe(Buffer.from('exact bytes').toString('base64'));
    expect(await ldp.readResource(POD, 'head')).toMatchObject({ revision: receipt.revision, bodyDigest: receipt.bodyDigest });
    expect(dec.decode((await ldp.readResource(POD, 'head'))!.bytes)).toBe('exact bytes');
  });

  it('rejects omitted, weak and malformed preconditions before any transaction', async () => {
    const { ldp, fdb } = fixture();
    const transact = vi.spyOn(fdb, 'transact');
    for (const bad of [undefined, '', '*', 'W/"x"', 'sha256:bad', 1]) {
      await expect(ldp.commitResource(POD, 'head', bytes('x'), CT, { expectedRevision: bad as string })).rejects.toThrow(/precondition/);
    }
    expect(transact).not.toHaveBeenCalled();
  });

  it('rejects stale writes without persisting loser canonical nodes', async () => {
    const { ldp, store } = fixture();
    const initial = await put(ldp, 'initial', null);
    const second = await put(ldp, 'second', initial.revision);
    expect(await ldp.commitResource(POD, 'head', bytes('loser'), CT, { expectedRevision: initial.revision }))
      .toEqual({ status: 'conflict', revision: second.revision });
    expect(await store.resolve(opaqueUri('loser'))).toBeNull();
    expect((await ldp.readResource(POD, 'head'))!.revision).toBe(second.revision);
  });

  it('allows exactly one concurrent creator across independent store objects', async () => {
    const base = new InMemoryFdb();
    const first = fixture(base), second = fixture(base);
    const results = await Promise.all(['one', 'two'].map((value, index) =>
      [first, second][index]!.ldp.commitResource(POD, 'head', bytes(value), CT, { expectedRevision: null })));
    expect(results.filter(result => result.status === 'committed')).toHaveLength(1);
    const loser = results[0]!.status === 'committed' ? 'two' : 'one';
    expect(await first.store.resolve(opaqueUri(loser))).toBeNull();
  });

  it('allows exactly one concurrent replacement for an exact captured revision', async () => {
    const base = new InMemoryFdb(), first = fixture(base), second = fixture(base);
    const initial = await put(first.ldp, 'initial', null);
    const results = await Promise.all(['one', 'two'].map((value, index) =>
      [first, second][index]!.ldp.commitResource(POD, 'head', bytes(value), CT, { expectedRevision: initial.revision })));
    expect(results.filter(result => result.status === 'committed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'conflict')).toHaveLength(1);
  });

  it('never reuses a revision for equal bytes at an equal timestamp (ABA)', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(7);
    try {
      const { ldp } = fixture();
      const a = await put(ldp, 'A', null), b = await put(ldp, 'B', a.revision), again = await put(ldp, 'A', b.revision);
      expect(again.opaqueUri).toBe(a.opaqueUri);
      expect(again.updatedAt).toBe(a.updatedAt);
      expect(new Set([a.revision, b.revision, again.revision]).size).toBe(3);
      expect((await ldp.commitResource(POD, 'head', bytes('stale'), CT, { expectedRevision: a.revision })).status).toBe('conflict');
    } finally { clock.mockRestore(); }
  });

  it('binds revisions to both pod and resource path', async () => {
    const { ldp, store } = fixture();
    const a = await put(ldp, 'A', null);
    const record = (await store.resourceHead(POD, 'head'))!.record;
    await store.cpSet(resourceCollection(POD), 'copy', record);
    await store.cpSet(resourceCollection('https://native.example/bob/'), 'head', record);
    expect((await store.resourceHead(POD, 'copy'))!.revision).not.toBe(a.revision);
    expect((await store.resourceHead('https://native.example/bob/', 'head'))!.revision).not.toBe(a.revision);
  });

  it('rolls back the head, canonical nodes, indexes and overlay on failure', async () => {
    const base = new InMemoryFdb(), original = fixture(base);
    const old = await put(original.ldp, 'old', null);
    const keys = base.size();
    await expect(fixture(faulting(base)).ldp.commitResource(POD, 'head', bytes('new'), CT, { expectedRevision: old.revision }))
      .rejects.toThrow(/injected/);
    expect(base.size()).toBe(keys);
    expect((await original.store.resourceHead(POD, 'head'))!.revision).toBe(old.revision);
    expect((await original.store.resolveResource(POD, 'head'))!.uri).toBe(old.topUri);
    expect(await original.store.resolve(opaqueUri('new'))).toBeNull();
    expect(dec.decode((await original.ldp.readResource(POD, 'head'))!.bytes)).toBe('old');
  });

  it('does not acknowledge before the transaction really commits', async () => {
    const base = new InMemoryFdb(), { ldp, store } = fixture(base), reached = deferred(), release = deferred();
    let held = false, acknowledged = false;
    base.onBeforeCommit = async () => {
      if (!held) { held = true; reached.resolve(); await release.promise; }
    };
    const pending = put(ldp, 'pending', null).then(result => { acknowledged = true; return result; });
    try {
      await reached.promise;
      expect(acknowledged).toBe(false);
      expect(await store.resourceHead(POD, 'head')).toBeNull();
      expect(await store.resolve(opaqueUri('pending'))).toBeNull();
    } finally { release.resolve(); }
    expect((await pending).status).toBe('committed');
  });

  it('reconstructs complete bytes and receipts from a fresh store object', async () => {
    const base = new InMemoryFdb(), original = fixture(base);
    const receipt = await put(original.ldp, 'restart', null);
    const fresh = fixture(base);
    expect(await fresh.ldp.readResource(POD, 'head')).toMatchObject({ revision: receipt.revision, bodyDigest: receipt.bodyDigest });
    expect(dec.decode((await fresh.ldp.readResource(POD, 'head'))!.bytes)).toBe('restart');
    // This checks reconstruction, not physical process-crash durability.
  });

  it('keeps a read on one captured immutable head while a writer advances it', async () => {
    const { ldp, store } = fixture();
    const initial = await put(ldp, 'old', null);
    const resolve = store.resolve.bind(store);
    vi.spyOn(store, 'resolve').mockImplementationOnce(async uri => {
      await put(ldp, 'new', initial.revision);
      return resolve(uri);
    });
    const read = await ldp.readResource(POD, 'head');
    expect(read!.revision).toBe(initial.revision);
    expect(dec.decode(read!.bytes)).toBe('old');
    expect(dec.decode((await ldp.readResource(POD, 'head'))!.bytes)).toBe('new');
  });

  it('refuses an oversized captured head before resolving any payload atom', async () => {
    const { ldp, store } = fixture();
    await put(ldp, '123456', null);
    const resolve = vi.spyOn(store, 'resolve');
    await expect(ldp.readResource(POD, 'head', 5)).rejects.toThrow(/read limit/);
    expect(resolve).not.toHaveBeenCalled();
    expect(dec.decode((await ldp.readResource(POD, 'head', 6))!.bytes)).toBe('123456');
    for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(ldp.readResource(POD, 'head', invalid)).rejects.toThrow(/safe nonnegative/);
    }
  });

  it('refuses corrupt or missing payload rather than returning absence or partial bytes', async () => {
    const { ldp, fdb } = fixture();
    const receipt = await put(ldp, 'payload', null);
    await fdb.transact(async txn => { txn.clear(nodeKey(nodeAddrFromUrn(receipt.opaqueUri))); });
    await expect(ldp.readResource(POD, 'head')).rejects.toThrow(/unavailable/);
    expect(await ldp.stat(POD, 'head')).not.toBeNull();
  });

  it('rolls back malformed digest or size instead of publishing a false receipt', async () => {
    const { ldp, store } = fixture();
    await put(ldp, 'payload', null);
    const record = (await store.resourceHead(POD, 'head'))!.record;
    await expect(store.commitResource([], { pod: POD, resource: 'bad', record: { ...record, size: 1 }, expectedRevision: null }))
      .rejects.toThrow(/do not match/);
    expect(await store.resourceHead(POD, 'bad')).toBeNull();
    expect(await store.resolveResource(POD, 'bad')).toBeNull();
  });

  it('refuses preexisting conflicting canonical bytes without a false receipt', async () => {
    const { ldp, store } = fixture();
    const uri = opaqueUri('expected payload');
    await store.put({ uri, kind: 'atom', level: 0, value: Buffer.from('corrupt').toString('base64') });
    await expect(ldp.commitResource(POD, 'head', bytes('expected payload'), CT, { expectedRevision: null }))
      .rejects.toThrow(/conflicting canonical/);
    expect(await store.resourceHead(POD, 'head')).toBeNull();
    expect(await store.resolveResource(POD, 'head')).toBeNull();
  });

  it('blocks every ordinary legacy mutation from resetting a managed head', async () => {
    const { ldp } = fixture();
    const receipt = await put(ldp, 'protected', null);
    async function* chunks() { yield bytes('stream overwrite'); }
    for (const mutate of [
      () => ldp.writeResource(POD, 'head', bytes('overwrite'), CT),
      () => ldp.writeStream(POD, 'head', chunks(), CT),
      () => ldp.setMeta(POD, 'head', 'new metadata'),
      () => ldp.deleteResource(POD, 'head'),
    ]) await expect(mutate()).rejects.toBeInstanceOf(NativeResourceManagedError);
    expect((await ldp.readResource(POD, 'head'))!.revision).toBe(receipt.revision);
  });

  it('retries legacy metadata CAS without restoring a concurrent newer payload', async () => {
    const base = new InMemoryFdb(), first = fixture(base), other = fixture(base);
    await first.ldp.writeResource(POD, 'legacy', bytes('old'), CT);
    const head = first.store.resourceHead.bind(first.store);
    vi.spyOn(first.store, 'resourceHead').mockImplementationOnce(async (pod, path) => {
      const captured = await head(pod, path);
      await other.ldp.writeResource(POD, 'legacy', bytes('new'), CT);
      return captured;
    });
    await first.ldp.setMeta(POD, 'legacy', 'retained metadata');
    expect(dec.decode((await first.ldp.readResource(POD, 'legacy'))!.bytes)).toBe('new');
    expect((await first.ldp.stat(POD, 'legacy'))!.meta).toBe('retained metadata');
  });

  it('refuses a legacy overwrite racing conversion to a managed native head', async () => {
    const base = new InMemoryFdb(), first = fixture(base), other = fixture(base);
    await first.ldp.writeResource(POD, 'head', bytes('legacy'), CT);
    const head = first.store.resourceHead.bind(first.store);
    vi.spyOn(first.store, 'resourceHead').mockImplementationOnce(async (pod, path) => {
      const captured = await head(pod, path);
      await put(other.ldp, 'native', captured!.revision);
      return captured;
    });
    await expect(first.ldp.writeResource(POD, 'head', bytes('legacy overwrite'), CT)).rejects.toBeInstanceOf(NativeResourceManagedError);
    expect(dec.decode((await first.ldp.readResource(POD, 'head'))!.bytes)).toBe('native');
  });

  it('cannot delete a native head committed while legacy deletion was in flight', async () => {
    const base = new InMemoryFdb(), first = fixture(base), other = fixture(base);
    await first.ldp.writeResource(POD, 'head', bytes('legacy'), CT);
    const old = (await first.store.resourceHead(POD, 'head'))!;
    let injected = false;
    base.onBeforeCommit = async () => {
      if (!injected) { injected = true; await put(other.ldp, 'native', old.revision); }
    };
    await expect(first.ldp.deleteResource(POD, 'head')).rejects.toBeInstanceOf(NativeResourceManagedError);
    expect(dec.decode((await first.ldp.readResource(POD, 'head'))!.bytes)).toBe('native');
  });

  it('atomically deletes legacy metadata and both overlay directions', async () => {
    const { ldp, store } = fixture();
    await ldp.writeResource(POD, 'legacy', bytes('legacy'), CT);
    expect(await ldp.deleteResource(POD, 'legacy')).toBe(true);
    expect(await store.resourceHead(POD, 'legacy')).toBeNull();
    expect(await store.resolveResource(POD, 'legacy')).toBeNull();
    expect(await ldp.deleteResource(POD, 'legacy')).toBe(false);
  });

  it('atomically compare-deletes a native head and overlays while retaining canonical content', async () => {
    const { ldp, store } = fixture();
    const receipt = await put(ldp, 'native delete payload', null, 'native-delete');
    const canonical = await store.resolve(receipt.opaqueUri);
    expect((await ldp.deleteResourceConditionally(POD, 'native-delete', receipt.revision))).toEqual({
      status: 'deleted', revision: receipt.revision,
    });
    expect(await store.resourceHead(POD, 'native-delete')).toBeNull();
    expect(await store.resolveResource(POD, 'native-delete')).toBeNull();
    expect(await store.resolve(receipt.opaqueUri)).toEqual(canonical);
    expect(await ldp.deleteResourceConditionally(POD, 'native-delete', receipt.revision)).toEqual({ status: 'conflict', revision: null });
  });

  it('preserves a changed native head when conditional deletion is stale', async () => {
    const { ldp, store } = fixture();
    const old = await put(ldp, 'old', null, 'native-delete-race');
    const current = await put(ldp, 'current', old.revision, 'native-delete-race');
    expect(await ldp.deleteResourceConditionally(POD, 'native-delete-race', old.revision)).toEqual({
      status: 'conflict', revision: current.revision,
    });
    expect((await store.resourceHead(POD, 'native-delete-race'))!.revision).toBe(current.revision);
    expect(dec.decode((await ldp.readResource(POD, 'native-delete-race'))!.bytes)).toBe('current');
  });

  it('refuses native conditional deletion of legacy and container heads', async () => {
    const { ldp, store } = fixture();
    await ldp.writeResource(POD, 'legacy-delete', bytes('legacy'), CT);
    const legacy = (await store.resourceHead(POD, 'legacy-delete'))!;
    await expect(ldp.deleteResourceConditionally(POD, 'legacy-delete', legacy.revision)).rejects.toBeInstanceOf(NativeResourceManagedError);
    await store.commitResource([], {
      pod: POD, resource: 'container/', expectedRevision: null,
      record: { topUri: legacy.record.topUri, opaqueUri: legacy.record.opaqueUri, contentType: 'internal/container',
        updatedAt: Date.now(), size: legacy.record.size, bodyDigest: legacy.record.bodyDigest },
    });
    const container = (await store.resourceHead(POD, 'container/'))!;
    await expect(ldp.deleteResourceConditionally(POD, 'container/', container.revision)).rejects.toBeInstanceOf(NativeResourceManagedError);
  });

  it('preserves chunk bytes and ordered structural indexes in the atomic path', async () => {
    const { ldp, store } = fixture();
    const data = new Uint8Array(600_000);
    data.fill(251);
    async function* chunks() { yield data.slice(0, 300_000); yield data.slice(300_000); }
    await ldp.writeStream(POD, 'large', chunks(), CT);
    const head = (await store.resourceHead(POD, 'large'))!;
    expect(head.record.chunkUris).toHaveLength(2);
    expect(await store.fragmentItems(head.record.topUri)).toEqual(head.record.chunkUris);
    expect(Buffer.from((await ldp.readResource(POD, 'large', data.length))!.bytes).equals(Buffer.from(data))).toBe(true);
  });
});

/** Same core APIs over the existing native engine, never an application SQL store. */
const PG_URL = process.env.TEST_NATIVE_PG_URL;
if (process.env.REQUIRE_LRS_NATIVE_TESTS === '1' && !PG_URL) throw new Error('TEST_NATIVE_PG_URL is required for native engine commit tests');
describe.skipIf(!PG_URL)('native atomic resource commits over the real PGSL engine', () => {
  it('serializes native commit against compare-delete under PostgreSQL READ COMMITTED', async () => {
    const left = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
    const right = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
    const path = 'delete-race-' + randomUUID();
    try {
      const original = fixture(left);
      const initial = await put(original.ldp, 'initial ' + path, null, path);
      const arrived = { count: 0, gate: deferred() }, key = cpKey(resourceCollection(POD), path);
      const writer = fixture(overlapping(left, key, arrived));
      const deleter = fixture(overlapping(right, key, arrived));
      const [write, deletion] = await Promise.all([
        writer.ldp.commitResource(POD, path, bytes('new ' + path), CT, { expectedRevision: initial.revision }),
        deleter.ldp.deleteResourceConditionally(POD, path, initial.revision),
      ]);
      expect(arrived.count).toBeGreaterThanOrEqual(2);
      expect([write.status, deletion.status].filter(status => status !== 'conflict')).toHaveLength(1);
      const head = await original.store.resourceHead(POD, path);
      if (write.status === 'committed') expect(head?.revision).toBe(write.revision);
      else expect(head).toBeNull();
    } finally {
      await right.close();
      await left.close();
    }
  }, 30_000);

  it('serializes overlapping exact-head CAS and reconstructs after pool closure', async () => {
    const left = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
    const right = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
    const path = 'native-' + randomUUID();
    let rightClosed = false;
    try {
      const original = fixture(left);
      const initial = await put(original.ldp, 'initial ' + path, null, path);
      const arrived = { count: 0, gate: deferred() }, key = cpKey(resourceCollection(POD), path);
      const a = fixture(overlapping(left, key, arrived)), b = fixture(overlapping(right, key, arrived));
      const results = await Promise.all([
        a.ldp.commitResource(POD, path, bytes('A ' + path), CT, { expectedRevision: initial.revision }),
        b.ldp.commitResource(POD, path, bytes('B ' + path), CT, { expectedRevision: initial.revision }),
      ]);
      expect(arrived.count).toBeGreaterThanOrEqual(2);
      expect(results.filter(result => result.status === 'committed')).toHaveLength(1);
      const winner = results.find(result => result.status === 'committed') as NativeResourceReceipt;
      const loser = results[0]!.status === 'committed' ? 'B ' + path : 'A ' + path;
      expect(await original.store.resolve(opaqueUri(loser))).toBeNull();
      await right.close();
      rightClosed = true;
      const reopened = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
      try {
        const read = await fixture(reopened).ldp.readResource(POD, path);
        expect(read!.revision).toBe(winner.revision);
        expect(read!.bodyDigest).toBe(winner.bodyDigest);
      } finally { await reopened.close(); }
    } finally {
      if (!rightClosed) await right.close();
      await left.close();
    }
  }, 30_000);

  it('rolls back a staged head and canonical writes on an actual engine failure', async () => {
    const backing = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
    const path = 'rollback-' + randomUUID(), original = fixture(backing);
    try {
      const prior = await put(original.ldp, 'old ' + path, null, path);
      await expect(fixture(faulting(backing)).ldp.commitResource(POD, path, bytes('new ' + path), CT, { expectedRevision: prior.revision }))
        .rejects.toThrow(/injected/);
      expect((await original.store.resourceHead(POD, path))!.revision).toBe(prior.revision);
      expect((await original.store.resolveResource(POD, path))!.uri).toBe(prior.topUri);
      expect(await original.store.resolve(opaqueUri('new ' + path))).toBeNull();
    } finally { await backing.close(); }
  }, 30_000);

  it('rejects equal-body ABA and all legacy mutations against the native engine', async () => {
    const backing = await openPgStore({ connectionString: PG_URL!, table: 'pgsl_kv' });
    const path = 'aba-' + randomUUID(), { ldp } = fixture(backing);
    try {
      const a = await put(ldp, 'A ' + path, null, path), b = await put(ldp, 'B ' + path, a.revision, path);
      const again = await put(ldp, 'A ' + path, b.revision, path);
      expect(again.revision).not.toBe(a.revision);
      expect((await ldp.commitResource(POD, path, bytes('stale'), CT, { expectedRevision: a.revision })).status).toBe('conflict');
      for (const mutate of [
        () => ldp.writeResource(POD, path, bytes('overwrite'), CT),
        () => ldp.setMeta(POD, path, 'overwrite'),
        () => ldp.deleteResource(POD, path),
      ]) await expect(mutate()).rejects.toBeInstanceOf(NativeResourceManagedError);
      expect((await ldp.readResource(POD, path))!.revision).toBe(again.revision);
    } finally { await backing.close(); }
  }, 30_000);
});
