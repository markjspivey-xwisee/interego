/**
 * PgslDataAccessor integration test — exercises CSS's DataAccessor contract over
 * the PGSL store against a REAL FoundationDB. Run in CI (needs FDB + the heavy
 * CSS dep); plain tsx script (no vitest in this isolated dir) so it stays light.
 */
import assert from 'node:assert/strict';
import type { Readable } from 'node:stream';
import { RepresentationMetadata, guardedStreamFrom } from '@solid/community-server';
import { PgslDataAccessor } from '../src/PgslDataAccessor.js';
import { LdpStore } from '../../../packages/pgsl-store/dist/ldp.js';
import { openStore } from '../../../packages/pgsl-store/dist/store.js';
import { openRealFdb } from '../../../packages/pgsl-store/dist/fdb-real.js';
import { CodecRegistry } from '../../../packages/pgsl-store/dist/codec.js';
import { rdfCodec } from '../../../packages/pgsl-store/dist/codec-rdf.js';

const ns = `${Date.now()}`;

async function drain(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const fdb = await openRealFdb();
  try {
    const codecs = new CodecRegistry().register(rdfCodec);
    const acc = new PgslDataAccessor(new LdpStore(openStore(fdb), codecs), `css-${ns}`);

    const base = `http://localhost/${ns}/`;
    const docId = { path: `${base}doc.ttl` };
    const turtle = '@prefix ex: <http://ex/> .\nex:s ex:p "exact bytes" .\n';

    // writeDocument -> getData is byte-faithful.
    const md = new RepresentationMetadata(docId);
    md.contentType = 'text/turtle';
    await acc.writeDocument(docId, guardedStreamFrom(Buffer.from(turtle)), md);
    const got = await drain(await acc.getData(docId));
    assert.equal(got.toString('utf8'), turtle, 'getData byte-faithful');

    // getMetadata carries the content-type.
    const gm = await acc.getMetadata(docId);
    assert.equal(gm.contentType, 'text/turtle', 'getMetadata content-type');

    // container + getChildren.
    const ctrId = { path: `${base}ctx/` };
    await acc.writeContainer(ctrId, new RepresentationMetadata(ctrId));
    const childId = { path: `${base}ctx/a.ttl` };
    const cmd = new RepresentationMetadata(childId);
    cmd.contentType = 'text/turtle';
    await acc.writeDocument(childId, guardedStreamFrom(Buffer.from('ex:s ex:p ex:o .\n')), cmd);
    const kids: string[] = [];
    for await (const k of acc.getChildren(ctrId)) kids.push(k.identifier.value);
    assert.ok(kids.includes(`${base}ctx/a.ttl`), `getChildren lists a.ttl (got ${JSON.stringify(kids)})`);

    // delete -> getData throws NotFound.
    await acc.deleteResource(docId);
    let threw = false;
    try { await acc.getData(docId); } catch { threw = true; }
    assert.ok(threw, 'getData throws after delete');

    // missing -> NotFound.
    let threw2 = false;
    try { await acc.getData({ path: `${base}nope.ttl` }); } catch { threw2 = true; }
    assert.ok(threw2, 'getData throws for a missing resource');

    console.log('PgslDataAccessor integration: ALL PASS');
  } finally {
    await fdb.close();
  }
}

main().catch((e) => {
  console.error('PgslDataAccessor integration FAILED:', e);
  process.exit(1);
});
