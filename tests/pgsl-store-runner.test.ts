import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  CodecRegistry,
  rdfCodec,
  LdpStore,
  runMigration,
  type PodPlan,
} from '../packages/pgsl-store/src/index.js';

const enc = new TextEncoder();

function ldpStore() {
  return new LdpStore(openStore(new InMemoryFdb()), new CodecRegistry().register(rdfCodec));
}

// A synthetic multi-pod fleet (NOT real pods).
const fleet: PodPlan[] = [
  {
    pod: 'https://pod/alice/',
    resources: [
      { path: 'ctx/a.ttl', bytes: enc.encode('ex:a ex:p "1" .\n'), contentType: 'text/turtle' },
      { path: 'ctx/b.ttl', bytes: enc.encode('ex:b ex:p "2" .\n'), contentType: 'text/turtle' },
    ],
  },
  {
    pod: 'https://pod/bob/',
    resources: [
      { path: 'x.png', bytes: new Uint8Array([137, 80, 78, 71, 0, 255]), contentType: 'image/png' },
    ],
  },
];

describe('pgsl-store: fleet migration runner (S5 tooling — synthetic fleet, safe by default)', () => {
  it('DRY RUN by default writes NOTHING', async () => {
    const fdb = new InMemoryFdb();
    const ldp = new LdpStore(openStore(fdb), new CodecRegistry().register(rdfCodec));
    const report = await runMigration(ldp, fleet); // no execute flag

    expect(report.executed).toBe(false);
    expect(report.pods).toBe(2);
    expect(report.totalResources).toBe(3);
    expect(report.migratedPods).toBe(0);
    expect(fdb.size()).toBe(0); // nothing written
    expect(await ldp.readResource('https://pod/alice/', 'ctx/a.ttl')).toBeNull();
  });

  it('execute:true migrates every pod with the verify gate green', async () => {
    const ldp = ldpStore();
    const report = await runMigration(ldp, fleet, { execute: true });

    expect(report.executed).toBe(true);
    expect(report.migratedPods).toBe(2);
    expect(report.failedPods).toEqual([]);

    // Byte-parity across the fleet (incl. the binary PNG).
    const a = await ldp.readResource('https://pod/alice/', 'ctx/a.ttl');
    expect(enc.encode('ex:a ex:p "1" .\n')).toEqual(a!.bytes);
    const png = await ldp.readResource('https://pod/bob/', 'x.png');
    expect([...png!.bytes]).toEqual([137, 80, 78, 71, 0, 255]);
  });

  it('reports per-progress + is idempotent on re-run', async () => {
    const ldp = ldpStore();
    const seen: string[] = [];
    await runMigration(ldp, fleet, { execute: true, onProgress: (pod) => seen.push(pod) });
    expect(seen).toEqual(['https://pod/alice/', 'https://pod/bob/']);

    const again = await runMigration(ldp, fleet, { execute: true });
    expect(again.migratedPods).toBe(2); // re-run still verifies (idempotent)
    expect(again.failedPods).toEqual([]);
  });
});
