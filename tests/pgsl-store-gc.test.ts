import { describe, expect, it } from 'vitest';
import {
  CodecRegistry,
  InMemoryFdb,
  LdpStore,
  openStore,
  rdfCodec,
} from '../packages/pgsl-store/src/index.js';
import { collectLive, hex, keysBySubspace, readerFromFdb } from '../packages/pgsl-store/src/gc.js';
import { subspaceRange } from '../packages/pgsl-store/src/keyspace.js';
import type { FdbLike } from '../packages/pgsl-store/src/fdb-like.js';

const enc = new TextEncoder();
const POD = 'https://pod/u1/';

function setup() {
  const fdb = new InMemoryFdb();
  const store = openStore(fdb);
  const codecs = new CodecRegistry().register(rdfCodec);
  return { fdb, store, ldp: new LdpStore(store, codecs) };
}

/** Every key in the store, hex-encoded. */
async function allKeys(fdb: FdbLike): Promise<Set<string>> {
  const out = new Set<string>();
  const begin = enc.encode('pgsl\x00');
  const end = enc.encode('pgsl\x01');
  let from: Uint8Array = begin;
  for (;;) {
    const rows = await fdb.transact((txn) => txn.getRange(from, end, { limit: 500 }));
    for (const r of rows) out.add(hex(r.key));
    if (rows.length < 500) break;
    const last = rows[rows.length - 1]!.key;
    from = new Uint8Array([...last, 0]);
  }
  return out;
}

const manifest = (n: number): string => `@prefix ex: <http://ex/> .\n${Array.from({ length: n }, (_, i) => `ex:s${i} ex:p "entry ${i}" .`).join('\n')}\n`;

describe('pgsl-store: collecting the unreferenced history of a grow-only store', () => {
  it('keeps exactly the keys a fresh store would hold for the current content, and drops every older version', async () => {
    // A churned store: the manifest rewritten five times, an opaque blob overwritten, a chunked blob, a deleted resource.
    const churned = setup();
    for (let i = 1; i <= 5; i += 1) await churned.ldp.writeResource(POD, '.well-known/context-graphs', enc.encode(manifest(20 + i * 7)), 'text/turtle');
    await churned.ldp.writeResource(POD, 'ctx/doc.ttl', enc.encode(manifest(3)), 'text/turtle');
    await churned.ldp.writeResource(POD, 'blob.bin', enc.encode('version one of an opaque blob'), 'application/octet-stream');
    await churned.ldp.writeResource(POD, 'blob.bin', enc.encode('version two of an opaque blob'), 'application/octet-stream');
    await churned.ldp.writeResource(POD, 'gone.ttl', enc.encode(manifest(2)), 'text/turtle');
    await churned.ldp.deleteResource(POD, 'gone.ttl');
    const big = new Uint8Array(3 * 512 * 1024 + 17).map((_, i) => i % 251);
    await churned.ldp.writeStream(POD, 'big.bin', (async function* () { yield big; })(), 'application/octet-stream');

    // The oracle: the same current content written once into a fresh store.
    const fresh = setup();
    await fresh.ldp.writeResource(POD, '.well-known/context-graphs', enc.encode(manifest(20 + 5 * 7)), 'text/turtle');
    await fresh.ldp.writeResource(POD, 'ctx/doc.ttl', enc.encode(manifest(3)), 'text/turtle');
    await fresh.ldp.writeResource(POD, 'blob.bin', enc.encode('version two of an opaque blob'), 'application/octet-stream');
    await fresh.ldp.writeStream(POD, 'big.bin', (async function* () { yield big; })(), 'application/octet-stream');

    const before = await allKeys(churned.fdb);
    const oracle = await allKeys(fresh.fdb);
    const live = await collectLive(readerFromFdb(churned.fdb));

    expect(before.size).toBeGreaterThan(oracle.size);
    // Everything the fresh store holds, the churned store's live set holds; nothing else survives
    // except what only the churned history can explain: none, by construction of this fixture.
    const missing = [...oracle].filter((k) => !live.keys.has(k));
    const extra = [...live.keys].filter((k) => !oracle.has(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(live.stats.danglingRoots).toEqual([]);
    expect(live.stats.unreadableNodes).toBe(0);
    expect(live.stats.liveFragments).toBeGreaterThan(0);
    expect(keysBySubspace(live.keys)['C']).toBe(4);
  });

  it('reads what it kept back through the LDP surface after the garbage is gone', async () => {
    const { fdb, ldp } = setup();
    for (let i = 1; i <= 3; i += 1) await ldp.writeResource(POD, 'a.ttl', enc.encode(manifest(4 + i)), 'text/turtle');
    await ldp.writeResource(POD, 'b.bin', enc.encode('bytes'), 'application/octet-stream');
    const live = await collectLive(readerFromFdb(fdb));
    // Delete everything not live, the way the rebuild leaves it behind.
    const all = await allKeys(fdb);
    const garbage = [...all].filter((k) => !live.keys.has(k)).map((k) => new Uint8Array(Buffer.from(k, 'hex')));
    expect(garbage.length).toBeGreaterThan(0);
    await fdb.transact(async (txn) => { for (const k of garbage) txn.clear(k); });
    const a = await ldp.readResource(POD, 'a.ttl');
    expect(a && new TextDecoder().decode(a.bytes)).toBe(manifest(7));
    const b = await ldp.readResource(POD, 'b.bin');
    expect(b && new TextDecoder().decode(b.bytes)).toBe('bytes');
  });

  it('drops the overlay row a legacy delete left behind, and the nodes only it pointed at', async () => {
    const { fdb, store, ldp } = setup();
    await ldp.writeResource(POD, 'kept.bin', enc.encode('kept'), 'application/octet-stream');
    await ldp.writeResource(POD, 'legacy.bin', enc.encode('deleted the old way'), 'application/octet-stream');
    // The old deleteResource removed the record only; the overlay row stayed.
    await store.cpDelete(`ldp ${POD}`, 'legacy.bin');
    const live = await collectLive(readerFromFdb(fdb));
    expect(live.stats.staleOverlays).toBe(1);
    expect(live.stats.liveNodes).toBe(1);
    const oPrefix = hex(subspaceRange('O').begin);
    expect([...live.keys].filter((k) => k.startsWith(oPrefix))).toHaveLength(1);
    // The current deleteResource clears the overlay itself.
    await ldp.deleteResource(POD, 'kept.bin');
    const after = await collectLive(readerFromFdb(fdb));
    expect(after.stats.staleOverlays).toBe(1);
    expect(after.stats.liveNodes).toBe(0);
  });

  it('treats an attribute on an atom as a root, and reports a record that points at nothing', async () => {
    const { fdb, store, ldp } = setup();
    await ldp.writeResource(POD, 'x.bin', enc.encode('x'), 'application/octet-stream');
    // An atom only an attribute knows about.
    const orphanUri = 'urn:pgsl:atom:' + 'ab'.repeat(20);
    await store.put({ uri: orphanUri, kind: 'atom', level: 0, value: 'lonely' });
    await store.putAtomAttributes('scope', orphanUri, { classification: 0, owner: 'o' });
    const live = await collectLive(readerFromFdb(fdb));
    expect(live.stats.liveNodes).toBeGreaterThanOrEqual(2);
    expect([...live.keys].some((k) => k.startsWith(hex(subspaceRange('A').begin)))).toBe(true);
    // A control-plane record naming a node that was never stored.
    await store.cpSet('ldp https://pod/u2/', 'phantom.bin', { topUri: 'urn:pgsl:atom:' + 'cd'.repeat(20), opaqueUri: 'urn:pgsl:atom:' + 'cd'.repeat(20), contentType: 'x', updatedAt: 1, size: 1 });
    const again = await collectLive(readerFromFdb(fdb));
    expect(again.stats.danglingRoots).toEqual(['urn:pgsl:atom:' + 'cd'.repeat(20)]);
  });
});
