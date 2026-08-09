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

/**
 * The line `tools/railway-services.mjs` declares as css's `bootProof`.
 *
 * ★ WHY THIS STRING IS ASSERTED HERE AND NOT ONLY THERE. css binds no port Railway can
 * probe and has no public domain, so the ONLY evidence its deploy tool has that a rollout
 * landed is this line appearing once in the new deployment's logs. It is emitted by
 * @solid/community-server's ServerInitializer — code this repository does not own — so
 * nothing but a real boot can confirm it is still the string being printed. Get it wrong
 * and no test fails: every css deploy simply times out four minutes after a container that
 * booted perfectly, and the reflex then is to run the deploy again, which SIGTERMs the
 * healthy container holding every pod's data.
 *
 * The two assertions below are the two halves of the claim the deploy tool makes:
 * the line is printed exactly ONCE per boot (so a second copy really does mean a restart),
 * and reads SUCCEED after it (so it means "ready", not "starting").
 */
const BOOT_PROOF = 'Listening to server at';

async function main(): Promise<void> {
  const backend = process.env.PGSL_INMEM === '1' ? 'in-memory FdbLike' : 'PostgreSQL';
  console.log(`Booting CSS-over-PGSL (${backend}) on ${baseUrl} ...`);

  // Tee both streams rather than replace either: the harness's own output still has to
  // reach the CI log, and which stream winston's bare `new transports.Console()` picks is
  // a default of a transitive dependency, not something this repository states. Capturing
  // one of the two would make the assertion below silently depend on that default.
  // `loggingLevel: 'info'` (was 'warn') because the boot line is info-level — at 'warn' the
  // server prints it nowhere and this test would be asserting over an empty buffer.
  const written: string[] = [];
  const real = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const tee = (to: (c: string | Uint8Array, ...r: unknown[]) => boolean) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return to(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = tee(real.out);
  process.stderr.write = tee(real.err);
  const untee = (): void => { process.stdout.write = real.out; process.stderr.write = real.err; };

  async function boot() {
    try {
      const a = await new AppRunner().create({
        loaderProperties: { mainModulePath: pkgRoot, typeChecking: false },
        config: configPath,
        shorthand: {
          port,
          baseUrl,
          loggingLevel: 'info',
          rootFilePath: path.join(os.tmpdir(), `pgsl-css-${Date.now()}`),
        },
      });
      await a.start();
      return a;
    } finally {
      // Restored even when the boot throws, or the failure this harness exists to report
      // would land in a buffer nobody reads instead of on the CI log.
      untee();
    }
  }
  const app = await boot();

  const bootHits = written.join('').split(BOOT_PROOF).length - 1;
  assert.equal(
    bootHits, 1,
    `the deploy tool's boot proof ${JSON.stringify(BOOT_PROOF)} must appear EXACTLY once per boot `
    + `(got ${bootHits}). tools/railway-services.mjs counts occurrences to tell a boot from a `
    + 'crash loop, and railway-redeploy.mjs fails the deploy on any count but one.');

  try {
    // A read, immediately, with nothing waited for in between: this is what makes the line
    // above a READINESS proof rather than a banner. If CSS logged it before the store were
    // usable, this GET would fail here instead of in production.
    const ready = await fetch(baseUrl, { headers: { accept: 'text/turtle' } });
    assert.ok(ready.ok, `a read must succeed straight after the boot proof (status ${ready.status})`);

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

    // ETag / optimistic concurrency (the manifest-CAS regression fix): a document
    // GET must carry an ETag, If-Match CAS must round-trip, and a stale If-Match
    // must 412. Without dc:modified this ETag is absent and @interego/solid's
    // manifest read-modify-write silently caps a pod at one indexed descriptor.
    const etagTarget = `${baseUrl}etag-doc.ttl`;
    await fetch(etagTarget, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: 'ex:s ex:p "v1" .\n' });
    const g1 = await fetch(etagTarget, { headers: { accept: 'text/turtle' } });
    const etag1 = g1.headers.get('etag');
    assert.ok(etag1 && etag1.length > 0, `GET returns a non-empty ETag (got ${etag1})`);
    const upd = await fetch(etagTarget, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle', 'if-match': etag1! },
      body: 'ex:s ex:p "v2" .\n',
    });
    assert.ok(upd.ok, `If-Match CAS update should succeed (status ${upd.status})`);
    const g2 = await fetch(etagTarget, { headers: { accept: 'text/turtle' } });
    const etag2 = g2.headers.get('etag');
    assert.ok(etag2 && etag2 !== etag1, `ETag should change after write (${etag1} -> ${etag2})`);
    const stale = await fetch(etagTarget, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle', 'if-match': etag1! },
      body: 'ex:s ex:p "v3" .\n',
    });
    assert.equal(stale.status, 412, `stale If-Match should 412 (got ${stale.status})`);
    await fetch(etagTarget, { method: 'DELETE' });

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
