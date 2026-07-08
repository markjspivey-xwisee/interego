import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  CodecRegistry,
  rdfCodec,
  LdpStore,
  migratePod,
  verifyMigration,
  type SourceResource,
} from '../packages/pgsl-store/src/index.js';

const enc = new TextEncoder();

function ldpStore() {
  const codecs = new CodecRegistry().register(rdfCodec);
  return new LdpStore(openStore(new InMemoryFdb()), codecs);
}

// A synthetic "file-backed pod" (NOT a real pod).
const POD = 'https://pod/synthetic/';
const source: SourceResource[] = [
  { path: 'ctx/a.ttl', bytes: enc.encode('@prefix ex: <http://ex/> .\nex:a ex:p "one" .\n'), contentType: 'text/turtle' },
  { path: 'ctx/b.ttl', bytes: enc.encode('@prefix ex: <http://ex/> .\nex:b ex:p "two" .\n'), contentType: 'text/turtle' },
  { path: 'ctx/sub/c.ttl', bytes: enc.encode('ex:c ex:p ex:o .\n'), contentType: 'text/turtle' },
  { path: 'blobs/logo.png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 42]), contentType: 'image/png' },
];

describe('pgsl-store: per-pod migration tooling (S4, synthetic pods — no real pods, no prod)', () => {
  it('migrates a pod non-destructively with 100% byte-parity verification', async () => {
    const ldp = ldpStore();
    const report = await migratePod(ldp, POD, source);
    expect(report.migrated).toBe(source.length);
    expect(report.verified).toBe(source.length);
    expect(report.mismatches).toEqual([]);

    // Every resource reads back byte-identical (incl. the binary PNG bytes).
    for (const r of source) {
      const back = await ldp.readResource(POD, r.path);
      expect(back).not.toBeNull();
      expect([...back!.bytes]).toEqual([...r.bytes]);
      expect(back!.contentType).toBe(r.contentType);
    }

    // Containment is queryable post-migration.
    expect(await ldp.listContainer(POD, 'ctx/')).toEqual(['ctx/a.ttl', 'ctx/b.ttl', 'ctx/sub/']);
  });

  it('is idempotent: re-running migration re-verifies with no change', async () => {
    const ldp = ldpStore();
    await migratePod(ldp, POD, source);
    const second = await migratePod(ldp, POD, source);
    expect(second.verified).toBe(source.length);
    expect(second.mismatches).toEqual([]);
  });

  it('verifyMigration is a clean per-pod cutover gate (ok=true only on full parity)', async () => {
    const ldp = ldpStore();
    await migratePod(ldp, POD, source);
    const gate = await verifyMigration(ldp, POD, source);
    expect(gate.ok).toBe(true);
    expect(gate.mismatches).toEqual([]);

    // A source resource that was never migrated is flagged (fail-closed gate).
    const withExtra = [...source, { path: 'ctx/missing.ttl', bytes: enc.encode('ex:x ex:p ex:o .\n'), contentType: 'text/turtle' }];
    const gate2 = await verifyMigration(ldp, POD, withExtra);
    expect(gate2.ok).toBe(false);
    expect(gate2.mismatches).toEqual(['ctx/missing.ttl']);
  });
});
