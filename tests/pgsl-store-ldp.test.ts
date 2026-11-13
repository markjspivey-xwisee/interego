import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  CodecRegistry,
  rdfCodec,
  LdpStore,
} from '../packages/pgsl-store/src/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function setup() {
  const store = openStore(new InMemoryFdb());
  const codecs = new CodecRegistry().register(rdfCodec);
  return { store, ldp: new LdpStore(store, codecs) };
}

const POD = 'https://pod/u1/';

describe('pgsl-store: LDP resource CRUD over the PGSL store (S2 core, no CSS)', () => {
  it('writes + reads an RDF resource byte-faithfully with its content-type', async () => {
    const { ldp } = setup();
    const turtle = '@prefix ex: <http://ex/> .\nex:s ex:p "exact  bytes" .\n';
    await ldp.writeResource(POD, 'ctx/doc.ttl', enc.encode(turtle), 'text/turtle');

    const got = await ldp.readResource(POD, 'ctx/doc.ttl');
    expect(got).not.toBeNull();
    expect(dec.decode(got!.bytes)).toBe(turtle); // byte-identical (opaque path)
    expect(got!.contentType).toBe('text/turtle');
  });

  it('stores a non-RDF (binary) resource as an opaque atom, byte-faithfully', async () => {
    const { ldp } = setup();
    const bin = new Uint8Array([0, 1, 2, 250, 255, 42]);
    await ldp.writeResource(POD, 'blobs/x.bin', bin, 'application/octet-stream');
    const got = await ldp.readResource(POD, 'blobs/x.bin');
    expect(got!.contentType).toBe('application/octet-stream');
    expect([...got!.bytes]).toEqual([...bin]);
  });

  it('PUT overwrite returns the new bytes (mutable record over grow-only nodes)', async () => {
    const { ldp } = setup();
    await ldp.writeResource(POD, 'ctx/a.ttl', enc.encode('ex:s ex:p ex:v1 .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'ctx/a.ttl', enc.encode('ex:s ex:p ex:v2 .\n'), 'text/turtle');
    const got = await ldp.readResource(POD, 'ctx/a.ttl');
    expect(dec.decode(got!.bytes)).toBe('ex:s ex:p ex:v2 .\n');
  });

  it('DELETE removes the resource', async () => {
    const { ldp } = setup();
    await ldp.writeResource(POD, 'ctx/gone.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    expect(await ldp.deleteResource(POD, 'ctx/gone.ttl')).toBe(true);
    expect(await ldp.readResource(POD, 'ctx/gone.ttl')).toBeNull();
    expect(await ldp.deleteResource(POD, 'ctx/gone.ttl')).toBe(false); // idempotent
  });

  it('lists a container’s direct children (resources + sub-containers)', async () => {
    const { ldp } = setup();
    await ldp.writeResource(POD, 'ctx/a.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'ctx/b.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'ctx/sub/c.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');
    await ldp.writeResource(POD, 'other/d.ttl', enc.encode('ex:s ex:p ex:o .\n'), 'text/turtle');

    const children = await ldp.listContainer(POD, 'ctx/');
    expect(children).toEqual(['ctx/a.ttl', 'ctx/b.ttl', 'ctx/sub/']); // one level deep only
  });

  it('lets many writers replace one resource at once: a lost compare-and-set is retried, not refused', async () => {
    // What an LDP server does to a container when documents are created in it together: every
    // request rewrites the container's marker and its metadata, with no lock on the container.
    // One of N such writers can lose N - 1 times in a row; eight used to exhaust the retries.
    const { ldp } = setup();
    const writers = Array.from({ length: 24 }, (_, i) => i);
    await Promise.all(writers.flatMap(i => [
      ldp.writeResource(POD, 'shared/', new Uint8Array(0), 'internal/container', {}, `<urn:writer> <urn:n> "${i}" .`),
      ldp.setMeta(POD, 'shared/', `<urn:meta> <urn:n> "${i}" .`, 'internal/container'),
    ]));
    const marker = await ldp.stat(POD, 'shared/');
    expect(marker?.contentType).toBe('internal/container');
    expect(marker?.meta).toMatch(/^<urn:(writer|meta)> <urn:n> "\d+" \.$/);
  });

  it('stages a batch of immutable resources in one transaction, with a receipt bound to each', async () => {
    const fdb = new InMemoryFdb();
    let transactions = 0;
    const counted = Object.create(fdb) as InMemoryFdb;
    counted.transact = (body => { transactions++; return fdb.transact(body); }) as InMemoryFdb['transact'];
    const ldp = new LdpStore(openStore(counted), new CodecRegistry().register(rdfCodec));
    const items = Array.from({ length: 10 }, (_, i) => ({ path: `a/item-${i}`, bytes: enc.encode(`payload ${i}`), contentType: 'application/json' }));
    const staged = await ldp.stageResources(POD, items);
    expect(transactions).toBe(1);
    if (staged.status !== 'staged') throw new Error('expected a staged batch');
    expect(staged.receipts.map(receipt => receipt.created)).toEqual(items.map(() => true));
    for (const [index, item] of items.entries()) {
      const got = await ldp.readResource(POD, item.path);
      expect(dec.decode(got!.bytes)).toBe(`payload ${index}`);
      expect(staged.receipts[index]).toMatchObject({ path: item.path, revision: got!.revision, bodyDigest: got!.bodyDigest, size: item.bytes.length });
    }
    // A staged name is a native head: an ordinary overwrite cannot move it.
    await expect(ldp.writeResource(POD, items[0]!.path, enc.encode('other'), 'application/json')).rejects.toThrow();

    // Staging again confirms what is there (same revisions) and creates only what is new.
    const again = await ldp.stageResources(POD, [items[3]!, { path: 'a/new', bytes: enc.encode('new'), contentType: 'text/plain' }]);
    if (again.status !== 'staged') throw new Error('expected a staged batch');
    expect(again.receipts.map(receipt => receipt.created)).toEqual([false, true]);
    expect(again.receipts[0]!.revision).toBe(staged.receipts[3]!.revision);
  });

  it('moves the container marker forward in the staging transaction, only when something was created', async () => {
    const fdb = new InMemoryFdb();
    let transactions = 0;
    const counted = Object.create(fdb) as InMemoryFdb;
    counted.transact = (body => { transactions++; return fdb.transact(body); }) as InMemoryFdb['transact'];
    const ldp = new LdpStore(openStore(counted), new CodecRegistry().register(rdfCodec));
    const item = { path: 'box/one', bytes: enc.encode('one'), contentType: 'application/json' };
    // No marker yet: nothing to move, and the caller is told so.
    expect(await ldp.stageResources(POD, [item], { touch: 'box/' })).toMatchObject({ status: 'staged', touched: false });
    await ldp.writeResource(POD, 'box/', new Uint8Array(0), 'internal/container', {}, '<urn:kept> <urn:p> "meta" .');
    const before = (await ldp.stat(POD, 'box/'))!;
    await new Promise(resolve => setTimeout(resolve, 5));
    transactions = 0;
    const next = { path: 'box/two', bytes: enc.encode('two'), contentType: 'application/json' };
    expect(await ldp.stageResources(POD, [item, next], { touch: 'box/' })).toMatchObject({ status: 'staged', touched: true });
    expect(transactions).toBe(1);
    const after = (await ldp.stat(POD, 'box/'))!;
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(after).toMatchObject({ meta: before.meta, contentType: 'internal/container', size: 0 });
    expect(after.revision).not.toBe(before.revision);
    // Confirming only: the container did not change, so neither does its marker.
    expect(await ldp.stageResources(POD, [item, next], { touch: 'box/' })).toMatchObject({ touched: false });
    expect((await ldp.stat(POD, 'box/'))!.revision).toBe(after.revision);
    // A native-managed head is never moved this way.
    await expect(ldp.stageResources(POD, [{ ...item, path: 'box/three' }], { touch: 'box/one' })).rejects.toThrow();
    expect(await ldp.readResource(POD, 'box/three')).toBeNull();
  });

  it('refuses a whole staging batch when one name holds something else, and stages none of it', async () => {
    const { ldp } = setup();
    const taken = { path: 'a/taken', bytes: enc.encode('first'), contentType: 'application/json' };
    await ldp.stageResources(POD, [taken]);
    for (const other of [{ ...taken, bytes: enc.encode('second') }, { ...taken, contentType: 'text/plain' },
      { ...taken, contentType: 'application/json; charset=utf-8' }]) {
      const fresh = { path: `a/fresh-${other.contentType.length}-${other.bytes.length}`, bytes: enc.encode('fresh'), contentType: 'text/plain' };
      expect(await ldp.stageResources(POD, [fresh, other])).toEqual({ status: 'conflict', path: 'a/taken' });
      expect(await ldp.readResource(POD, fresh.path)).toBeNull();
    }
    expect(dec.decode((await ldp.readResource(POD, 'a/taken'))!.bytes)).toBe('first');
    await expect(ldp.stageResources(POD, [taken, taken])).rejects.toThrow(/twice/);
    // A name is a document or a container, never both: a marker at `name/`, or anything beneath it.
    await ldp.writeResource(POD, 'a/marked/', new Uint8Array(0), 'internal/container');
    await ldp.writeResource(POD, 'a/implicit/child', enc.encode('x'), 'text/plain');
    for (const path of ['a/marked', 'a/implicit']) {
      const fresh = { path: `${path}-sibling`, bytes: enc.encode('fresh'), contentType: 'text/plain' };
      expect(await ldp.stageResources(POD, [fresh, { path, bytes: enc.encode('doc'), contentType: 'text/plain' }])).toEqual({ status: 'conflict', path });
      expect(await ldp.readResource(POD, path)).toBeNull();
      expect(await ldp.readResource(POD, fresh.path)).toBeNull();
    }
    // A sibling whose name merely starts the same way is not beneath it.
    expect(await ldp.stageResources(POD, [{ path: 'a/implic', bytes: enc.encode('doc'), contentType: 'text/plain' }])).toMatchObject({ status: 'staged' });
  });

  it('lets concurrent batches stage the same names: each is created once and confirmed by the rest', async () => {
    const { ldp } = setup();
    const items = Array.from({ length: 6 }, (_, i) => ({ path: `race/item-${i}`, bytes: enc.encode(`shared ${i}`), contentType: 'application/json' }));
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => ldp.stageResources(POD, items)));
    for (const [index] of items.entries()) {
      const receipts = outcomes.map(outcome => { if (outcome.status !== 'staged') throw new Error('refused'); return outcome.receipts[index]!; });
      expect(receipts.filter(receipt => receipt.created)).toHaveLength(1);
      expect(new Set(receipts.map(receipt => receipt.revision)).size).toBe(1);
    }
  });

  it('survives restart: a fresh LdpStore over the same backing still reads', async () => {
    const fdb = new InMemoryFdb();
    const codecs = new CodecRegistry().register(rdfCodec);
    const turtle = 'ex:s ex:p ex:o .\n';
    await new LdpStore(openStore(fdb), codecs).writeResource(POD, 'ctx/keep.ttl', enc.encode(turtle), 'text/turtle');

    const restarted = new LdpStore(openStore(fdb), codecs);
    const got = await restarted.readResource(POD, 'ctx/keep.ttl');
    expect(dec.decode(got!.bytes)).toBe(turtle);
  });
});
