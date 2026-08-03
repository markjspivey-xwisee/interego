#!/usr/bin/env tsx
/**
 * A minted PGSL id resolves at its authority — but only once PUBLISHED.
 *
 * ★ WHY THIS EXISTS. The relay mints `https://relay…/ns/pgsl/atom/<hash>` as a node's
 * `@id`, and every existing test asserted only that the id is SPELLED like a URL —
 * `tests/pgsl-describe.test.ts` is literally named "…resolves at its authority" and
 * proves it with `expect(id).toMatch(/^https:\/\//)`. Measured against production, a
 * plain GET of that id 302'd to a foreign lattice and returned:
 *
 *     {"error":"no such node"}
 *
 * The invariant that matters is not how the id is spelled. It is: GET the id, get the
 * description — and still get it after a restart.
 *
 * ★ EVERY TEST HERE MOUNTS THE REAL HANDLER (`nodeRouteHandler`, the same function
 * server.ts registers). A test that re-implemented the route would assert a composition
 * we do not ship, which is the exact way this defect stayed invisible.
 *
 * Runs over InMemoryFdb — no Docker, no network, no Postgres.
 */
process.env['RELAY_PGSL_IN_MEMORY'] = '1';

import express from 'express';
import { openStore, InMemoryFdb } from '@interego/pgsl-store';
import { createPGSL, mintAtom, ingest } from '@interego/pgsl';
import type { IRI } from '@interego/core';
import * as store from '../pgsl-node-store.js';
import { listenLoopback } from './listen-loopback.js';

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

const BASE = 'https://relay.interego.xwisee.com';
const RESOLVER = 'https://foxxi-bridge.interego.xwisee.com/agent/lattice';

// One Express app mounting the REAL handler, exactly as server.ts does.
const app = express();
app.get('/ns/pgsl/:kind/:hash', store.nodeRouteHandler({
  resolverBase: RESOLVER, publicBase: BASE,
}));
// Loopback-bound, and the handle is unref'd so a run that never reaches the close()
// below cannot go on holding the port — `app.listen(0)` bound `::` (every interface) and
// a listening handle alone keeps the event loop alive forever. See tests/listen-loopback.ts.
const server = await listenLoopback(app);
const GET = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${path}`, { redirect: 'manual', headers });
const pathOf = (iri: string) => new URL(iri).pathname;

console.log('\nA PGSL node id resolves at its authority — after publication');

// ── a real lattice with a real atom and a real fragment ──────────────────
const fdb = new InMemoryFdb();
const durable = openStore(fdb);
store._resetForTests(durable);

const src = createPGSL({
  wasAttributedTo: 'https://example.org/test' as IRI,
  generatedAtTime: '2026-07-31T00:00:00.000Z',
});
const atomUri = mintAtom(src, 'interego pgsl authority test');
const otherUri = mintAtom(src, 'a second atom');
const fragUri = ingest(src, [atomUri, otherUri]);

// ★ EVERY ASSERTION RUNS INSIDE THIS `try`, AND THE CLOSE IS IN ITS `finally`.
//
// The close used to be the last statement of a linear block — the second defect
// tests/listen-loopback.ts names, and this was the last converted suite still in that
// shape. It is skipped by every path that does not reach the last statement: a `fetch`
// that rejects, a `.json()` on a body that is not JSON, an interrupted run. `unref()`
// means such a run no longer STRANDS the process, which is why this was low and not
// urgent — but "harmless because of a backstop" is not the same as "torn down", and every
// other converted suite in this directory closes from a `finally`. The odd one out is how
// the next reader learns the wrong pattern.
try {
  // ── 1. THE ANTI-CANDIDATE ASSERTION ──────────────────────────────────────
  // Minted but not published must NOT resolve. This fails the moment someone
  // "fixes" the 404 by serving the process-local kernel lattice — which would be a
  // cross-tenant guess-and-check disclosure oracle over every caller's content.
  {
    const r = await GET(pathOf(atomUri));
    ok(r.status !== 200, 'a MINTED but unpublished id does not resolve', `got ${r.status}`);
  }

  // ── 2. published ⇒ resolves, with the right body ─────────────────────────
  await store.publishSlice(src, atomUri as IRI, { iri: 'urn:agent:test', at: '2026-07-31T00:00:00.000Z' });
  {
    const r = await GET(pathOf(atomUri));
    const b = r.status === 200 ? await r.json() as Record<string, unknown> : {};
    ok(r.status === 200, 'a PUBLISHED id resolves', `got ${r.status}`);
    ok(b['@id'] === atomUri, '…and echoes the requested id as @id', String(b['@id']));
    ok(b['iep:value'] === 'interego pgsl authority test', '…and carries the atom value', String(b['iep:value']));
    ok(String(b['iep:provenance'] ? JSON.stringify(b['iep:provenance']) : '').includes('urn:agent:test'),
      '…and records who published it, not the first minter in the process');
  }

  // ── 3. THE RESTART ASSERTION ─────────────────────────────────────────────
  // Drop the in-memory commons, keep the durable store. This is what a Railway
  // rolling deploy or an OOM restart does, and it is the assertion that a
  // serve-from-heap architecture cannot pass.
  store._resetForTests(durable);
  {
    const r = await GET(pathOf(atomUri));
    ok(r.status === 200, 'still resolves after the in-memory commons is dropped (restart)', `got ${r.status}`);
  }

  // ── 4. THE REPLICA ASSERTION ─────────────────────────────────────────────
  // A second store handle over the same backing data = another replica of the relay.
  store._resetForTests(openStore(fdb));
  {
    const r = await GET(pathOf(atomUri));
    ok(r.status === 200, 'resolves from a second, independent store handle (replica)', `got ${r.status}`);
  }

  // ── 5. a fragment publishes its whole closure ────────────────────────────
  store._resetForTests(openStore(fdb));
  await store.publishSlice(src, fragUri as IRI, { iri: 'urn:agent:test', at: '2026-07-31T00:00:00.000Z' });
  store._resetForTests(openStore(fdb));   // force reads to come from durable storage
  {
    const r = await GET(pathOf(fragUri));
    ok(r.status === 200, 'a published FRAGMENT resolves', `got ${r.status}`);
    const r2 = await GET(pathOf(otherUri));
    ok(r2.status === 200,
      '…and so does a constituent atom it pulled in — the closure was published, not just the apex',
      `got ${r2.status}`);
  }

  // ── 6. absence is uniform and unrevealing ────────────────────────────────
  {
    const never = `/ns/pgsl/atom/${'a'.repeat(40)}`;
    const r = await GET(never);
    // Tier 2 redirects unknown-but-well-formed ids to the fail-closed public resolver;
    // what must never happen is a 200 or a distinguishable "exists here but hidden".
    ok(r.status === 302 || r.status === 404,
      'a never-published id yields a uniform non-answer (302 to tier 2, or 404)', `got ${r.status}`);
    ok(r.headers.get('cache-control') === 'no-store',
      '…and is never cached, so publishing it later is not shadowed by a cached negative',
      String(r.headers.get('cache-control')));
  }

  // ── 7. the grammar is exact ──────────────────────────────────────────────
  for (const [path, why] of [
    [`/ns/pgsl/metagraph/${'b'.repeat(24)}`, 'metagraph (24 hex) — no codec, no route'],
    [`/ns/pgsl/atom/${'c'.repeat(39)}`, '39 hex'],
    [`/ns/pgsl/atom/${'d'.repeat(41)}`, '41 hex'],
    ['/ns/pgsl/wrongkind/' + 'e'.repeat(40), 'unknown kind'],
  ] as const) {
    const r = await GET(path);
    const b = await r.json().catch(() => ({}));
    ok(r.status === 404 && (b as Record<string, unknown>)['error'] === 'no such pgsl node',
      `uniform JSON 404 for ${why}`, `got ${r.status}`);
  }

  // ── 8. an encrypted atom is refused ──────────────────────────────────────
  // Its uri is content-addressed from the PLAINTEXT while the stored value is a
  // placeholder, so publishing one turns the resolver into a plaintext-guess oracle.
  {
    const enc = createPGSL({ wasAttributedTo: 'https://example.org/t' as IRI, generatedAtTime: '2026-07-31T00:00:00.000Z' });
    const encUri = mintAtom(enc, '__ENCRYPTED__');
    let refused = false;
    try { await store.publishSlice(enc, encUri as IRI, { iri: 'urn:agent:test', at: 'now' }); }
    catch { refused = true; }
    ok(refused, 'publishing an encrypted atom is refused');
    const r = await GET(pathOf(encUri));
    ok(r.status !== 200, '…and its id still does not resolve', `got ${r.status}`);
  }

  // ── 9. an unreachable store fails LOUD, and does not crash the process ───
  {
    const broken = { resolve: () => { throw new Error('store down'); },
                     rehydrate: () => { throw new Error('store down'); },
                     putMany: () => { throw new Error('store down'); } };
    store._resetForTests(broken as unknown as ReturnType<typeof openStore>);
    const r = await GET(pathOf(atomUri));
    ok(r.status === 503, 'an unreachable store answers 503, never a misleading 404', `got ${r.status}`);
    const still = await GET(`/ns/pgsl/atom/${'f'.repeat(40)}`);
    ok(still.status >= 200, 'the process survived the throw (Node 22 exits on unhandled rejection)');
  }

  // ── 10. the commons never diverges from the durable store ────────────────
  {
    store._resetForTests(openStore(fdb));
    const c = store.commons();
    ok(c.nodes.size === 0,
      'a fresh commons starts EMPTY — nothing is admitted except from a durable read',
      `had ${c.nodes.size}`);
  }
} finally {
  await server.close();
}
console.log(failures === 0
  ? `\n${'-'.repeat(64)}\nPublication, not minting, is what makes an id resolve.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
