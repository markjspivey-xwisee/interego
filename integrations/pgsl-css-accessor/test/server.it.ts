/**
 * Full CSS server over PGSL — end-to-end HTTP LDP proof.
 *
 * Boots a real Community Solid Server via AppRunner using config/pgsl-server.json
 * (storage backend = PgslDataAccessorFactory), then drives the W3C LDP surface
 * over HTTP: PUT a Turtle document, GET it back byte-comparably, and confirm the
 * container listing reflects it. This proves the whole deployable path:
 *   componentsjs descriptor -> CSS config -> AppRunner DI -> PgslDataAccessor
 *   -> LdpStore -> PgslStore -> FdbLike backend.
 *
 * Backend is chosen by env (set by the CI job):
 *   PGSL_INMEM=1        -> in-memory FdbLike (proves the WIRING, no DB)
 *   PGSL_PG_CONNSTR=... -> real PostgreSQL (proves the real deploy backend)
 *
 * Plain tsx script (no vitest in this isolated dir) so it stays light.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppRunner } from '@solid/community-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..'); // isolated package root: resolves our lsd:* components + CSS
const configPath = path.join(pkgRoot, 'config', 'pgsl-server.json');
const port = 3456;
const baseUrl = `http://localhost:${port}/`;

async function main(): Promise<void> {
  const backend = process.env.PGSL_INMEM === '1' ? 'in-memory FdbLike' : 'PostgreSQL';
  console.log(`Booting CSS-over-PGSL (${backend}) on ${baseUrl} ...`);

  const app = await new AppRunner().create({
    loaderProperties: { mainModulePath: pkgRoot, typeChecking: false },
    config: configPath,
    shorthand: {
      port,
      baseUrl,
      loggingLevel: 'warn',
      rootFilePath: path.join(os.tmpdir(), `pgsl-css-${Date.now()}`),
    },
  });
  await app.start();

  try {
    const target = `${baseUrl}pgsl-doc.ttl`;
    const body = '@prefix ex: <http://ex/> .\nex:s ex:p "pgsl-over-css" .\n';

    // PUT a document -> stored through the PGSL accessor.
    const put = await fetch(target, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle' },
      body,
    });
    assert.ok(put.ok, `PUT should succeed (status ${put.status})`);

    // GET it back -> content round-trips through PGSL.
    const get = await fetch(target, { headers: { accept: 'text/turtle' } });
    assert.ok(get.ok, `GET should succeed (status ${get.status})`);
    const txt = await get.text();
    assert.ok(txt.includes('pgsl-over-css'), `GET body round-trips (got: ${txt.slice(0, 160)})`);

    // The root container listing should now reference the new document.
    const root = await fetch(baseUrl, { headers: { accept: 'text/turtle' } });
    assert.ok(root.ok, `root GET should succeed (status ${root.status})`);
    const rootTxt = await root.text();
    assert.ok(rootTxt.includes('pgsl-doc.ttl'), 'root container lists the new document');

    // DELETE -> subsequent GET is 404.
    const del = await fetch(target, { method: 'DELETE' });
    assert.ok(del.ok, `DELETE should succeed (status ${del.status})`);
    const gone = await fetch(target, { headers: { accept: 'text/turtle' } });
    assert.equal(gone.status, 404, `GET after DELETE should be 404 (got ${gone.status})`);

    console.log(`CSS-over-PGSL full-server HTTP LDP (${backend}): ALL PASS`);
  } finally {
    await app.stop();
  }
}

main().catch((e) => {
  console.error('CSS-over-PGSL server harness FAILED:', e);
  process.exit(1);
});
