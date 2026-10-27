// Local conformance gate: build the release-42 seed lineage in-memory and
// validate EVERY per-head projection with the AMEP reference validator. Proves
// the engine's output conforms by construction, before any deploy. Run with tsx.
import { buildSeedState, mountAmep } from './amep.js';
// @ts-ignore
import * as validator from './amep-vendor/validator.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const amepContext = JSON.parse(readFileSync(fileURLToPath(new URL('./amep-vendor/context.jsonld', import.meta.url)), 'utf8'));

// Minimal stub deps — buildSeedState is I/O-free (no solidFetch calls).
const deps: any = {
  solidFetch: async () => { throw new Error('no I/O in seed build'); },
  withPodMutex: async (_k: string, fn: any) => fn(),
  introspect: () => null,
  cssUrl: 'http://css.local:3456/',
  maintainerPod: 'maintainer',
  publicBase: 'https://relay.interego.xwisee.com',
  actSecret: '',
  log: (m: string) => console.log('   ' + m),
};

// projectExchange is internal; re-derive it the way the routes do by importing
// the module's projection through a captured app. Simplest: capture via mountAmep
// is overkill — instead we validate by rebuilding each head's document exactly as
// the engine serves it. We access the projection via a tiny shim app.
const routes: Record<string, any> = {};
const fakeApp: any = { get: (p: string, h: any) => { routes[p] = h; }, post: () => {} };
mountAmep(fakeApp, { ...deps, solidFetch: async (url: string) => {
  // serve the seeded state to the GET routes
  if (url.endsWith('/amep/state/release42.json')) {
    return { ok: true, status: 200, statusText: 'OK', headers: { get: () => '"seed"' }, text: async () => JSON.stringify(seed), json: async () => seed };
  }
  return { ok: false, status: 404, statusText: 'NF', headers: { get: () => null }, text: async () => '', json: async () => ({}) };
}});

const seed = await buildSeedState(deps);
// `currentHead` was the v0 single-tip field; state now carries the OPEN-HEAD SET (see
// amep.ts, "Old v0 docs carried `currentHead`; readState migrates them"). This line printed
// `currentHead=undefined` on every run for as long as that has been true, and no compiler
// was in the program to say so.
console.log(`built seed: ${seed.order.length} acts, openHeads=[${seed.openHeads.join(', ')}]`);

// ★ The Assert's semanticCid is a content address: SHA-256 over the RDFC-1.0 canonical N-Quads of
// the memory's semantic projection. Clients and other relays hold these ids. The validator below
// recomputes the CID with the same jsonld and rdf-canonize the engine used, so a release of either
// that moved one byte of the projection would re-address every committed memory and still pass
// there. This value was computed under jsonld 8.3.3 with rdf-canonize 4.0.1.
const PINNED_SEMANTIC_CID = 'urn:cid:rdfc-1.0:sha256:455cc39fcf7ca2377cab7fcdc3dbbd4e52d9b34eb948bc63f976089ed97b6661';
const assertCid = seed.acts[seed.order[1] ?? '']?.memory?.['semanticCid'];
if (assertCid !== PINNED_SEMANTIC_CID) {
  process.stdout.write(`  FAILS     semanticCid moved: ${String(assertCid)}, pinned ${PINNED_SEMANTIC_CID}\n`);
  process.exit(1);
}
process.stdout.write(`  PINNED    semanticCid ${assertCid}\n`);

// Validate each act's projection by calling the exchange route for each head.
let pass = 0, fail = 0;
for (const actId of seed.order) {
  const act = seed.acts[actId]!;
  // Reconstruct the served document by invoking the exchange GET with a res capture.
  let captured = '';
  const res: any = {
    _status: 200, _headers: {},
    status(c: number) { this._status = c; return this; },
    type() { return this; }, setHeader(k: string, v: string) { this._headers[k] = v; },
    send(b: string) { captured = b; return this; },
  };
  // Pick this specific head via the head route.
  await routes['/amep/heads/:slug/:headId']({ params: { slug: 'release42', headId: encodeURIComponent(act.resultHead) }, query: {}, headers: { accept: 'application/affordance+yaml' } }, res);
  const yaml = (await import('js-yaml')).default;
  const doc = yaml.load(captured);
  const report = await validator.validateDocument(doc, amepContext, { validateHashes: true });
  if (report['sh:conforms']) { pass++; console.log(`  CONFORMS  ${act.actType}  head=${act.resultHead.slice(-12)}`); }
  else {
    fail++;
    console.log(`  FAILS     ${act.actType}`);
    for (const v of report['sh:result'].slice(0, 6)) console.log(`      - ${v['sh:sourceShape']}: ${v['sh:resultMessage']}`);
  }
}
console.log(`\n${pass}/${pass + fail} projections conform`);
process.exit(fail === 0 ? 0 : 1);
