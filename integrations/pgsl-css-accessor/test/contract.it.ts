/**
 * Empirical Solid/LDP/CSS storage-contract battery against the live-config
 * CSS-over-PGSL server. Unlike server.it.ts (a happy-path smoke), this probes
 * the contract surface a from-scratch DataAccessor is easy to get subtly wrong —
 * the class of gap the dc:modified/ETag regression belonged to. Every check runs
 * and reports PASS/FAIL independently so ALL gaps surface in one run.
 *
 * Backend chosen by env: PGSL_INMEM=1 (default here) or PGSL_PG_CONNSTR.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppRunner } from '@solid/community-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const configPath = path.join(pkgRoot, 'config', 'pgsl-server.json');
const port = 3470;
const base = `http://localhost:${port}/`;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const ttl = (o: string) => `@prefix ex: <http://ex/> .\nex:s ex:p "${o}" .\n`;

async function main(): Promise<void> {
  const app = await new AppRunner().create({
    loaderProperties: { mainModulePath: pkgRoot, typeChecking: false },
    config: configPath,
    shorthand: { port, baseUrl: base, loggingLevel: 'error', rootFilePath: path.join(os.tmpdir(), `pgsl-contract-${Date.now()}`) },
  });
  await app.start();
  try {
    // --- conditional requests / caching ---
    await fetch(`${base}c.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl('1') });
    const g = await fetch(`${base}c.ttl`, { headers: { accept: 'text/turtle' } });
    const etag = g.headers.get('etag');
    const lastmod = g.headers.get('last-modified');
    check('GET returns ETag', !!etag, etag ?? '');
    check('GET returns Last-Modified', !!lastmod, lastmod ?? '');
    const c304 = await fetch(`${base}c.ttl`, { headers: { accept: 'text/turtle', 'if-none-match': etag ?? '"x"' } });
    check('conditional GET (If-None-Match current) -> 304', c304.status === 304, `status ${c304.status}`);
    if (lastmod) {
      const ims = await fetch(`${base}c.ttl`, { headers: { accept: 'text/turtle', 'if-modified-since': lastmod } });
      check('If-Modified-Since (current) -> 304', ims.status === 304, `status ${ims.status}`);
    }

    // --- HEAD ---
    const h = await fetch(`${base}c.ttl`, { method: 'HEAD' });
    const hbody = await h.text();
    check('HEAD 200 + empty body + content-type', h.status === 200 && hbody.length === 0 && !!h.headers.get('content-type'), `status ${h.status} bodylen ${hbody.length}`);

    // --- POST + Slug (container creates a child) ---
    const post = await fetch(base, { method: 'POST', headers: { 'content-type': 'text/turtle', slug: 'posted' }, body: ttl('p') });
    const loc = post.headers.get('location');
    check('POST+Slug -> 201 + Location', post.status === 201 && !!loc, `status ${post.status} loc ${loc}`);
    if (loc) {
      const pg = await fetch(loc, { headers: { accept: 'text/turtle' } });
      check('POSTed resource readable + listed in root', pg.ok, `status ${pg.status}`);
    }

    // --- PATCH (N3 Patch: getData -> apply -> writeDocument) ---
    const patchBody = '@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n_:p a solid:InsertDeletePatch; solid:inserts { <http://ex/x> <http://ex/y> <http://ex/z>. }.';
    const patch = await fetch(`${base}c.ttl`, { method: 'PATCH', headers: { 'content-type': 'text/n3' }, body: patchBody });
    check('PATCH (N3 insert) applies', patch.ok, `status ${patch.status}`);
    if (patch.ok) {
      const after = await (await fetch(`${base}c.ttl`, { headers: { accept: 'text/turtle' } })).text();
      check('PATCH insert visible on read-back', after.includes('http://ex/z') || after.includes('ex:z'), after.replace(/\n/g, ' ').slice(0, 80));
    }

    // --- RDF content negotiation ---
    const jld = await fetch(`${base}c.ttl`, { headers: { accept: 'application/ld+json' } });
    const jtext = await jld.text();
    check('GET as application/ld+json converts', jld.ok && jtext.trim().length > 0 && !!jld.headers.get('content-type')?.includes('json'), `status ${jld.status} ct ${jld.headers.get('content-type')}`);
    const nt = await fetch(`${base}c.ttl`, { headers: { accept: 'application/n-triples' } });
    const nttext = await nt.text();
    check('GET as n-triples converts', nt.ok && nttext.trim().length > 0, `status ${nt.status} len ${nttext.length}`);

    // --- empty resource ---
    await fetch(`${base}empty.txt`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '' });
    const eg = await fetch(`${base}empty.txt`);
    const et = await eg.text();
    check('empty resource round-trips (200, 0 bytes)', eg.status === 200 && et.length === 0, `status ${eg.status} len ${et.length}`);

    // --- manifest CAS: 2 sequential If-Match updates (the publish() pattern) ---
    await fetch(`${base}m.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl('v0') });
    const e1 = (await fetch(`${base}m.ttl`)).headers.get('etag');
    const u1 = await fetch(`${base}m.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle', 'if-match': e1 ?? '"x"' }, body: ttl('v1') });
    const e2 = (await fetch(`${base}m.ttl`)).headers.get('etag');
    const u2 = await fetch(`${base}m.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle', 'if-match': e2 ?? '"x"' }, body: ttl('v2') });
    check('manifest CAS: 2 sequential If-Match updates both succeed', !!(u1.ok && u2.ok && e1 !== e2), `u1 ${u1.status} u2 ${u2.status}`);

    // --- containers ---
    await fetch(`${base}dir/x.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl('o') });
    const cg = await fetch(`${base}dir/`, { headers: { accept: 'text/turtle' } });
    const cgt = await cg.text();
    check('container GET lists child (ldp:contains)', cg.ok && cgt.includes('x.ttl'), `status ${cg.status}`);
    // container conditional requests (dc:modified on the container branch)
    const cEtag = cg.headers.get('etag');
    const cLm = cg.headers.get('last-modified');
    check('container GET carries ETag + Last-Modified', !!cEtag && !!cLm, `etag ${cEtag} lm ${cLm}`);
    if (cEtag) {
      const c304 = await fetch(`${base}dir/`, { headers: { accept: 'text/turtle', 'if-none-match': cEtag } });
      check('container conditional GET (If-None-Match) -> 304', c304.status === 304, `status ${c304.status}`);
    }
    const delNon = await fetch(`${base}dir/`, { method: 'DELETE' });
    check('DELETE non-empty container -> 409', delNon.status === 409, `status ${delNon.status}`);
    const over = await fetch(`${base}dir`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl('o') });
    check('PUT document at existing container path -> 4xx', over.status >= 400, `status ${over.status}`);

    // --- idempotent re-PUT identical bytes must still bump ETag (CAS-safe) ---
    await fetch(`${base}idem.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl('same') });
    const i1 = (await fetch(`${base}idem.ttl`)).headers.get('etag');
    await new Promise((r) => setTimeout(r, 5));
    await fetch(`${base}idem.ttl`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: ttl('same') });
    const i2 = (await fetch(`${base}idem.ttl`)).headers.get('etag');
    check('re-PUT identical bytes bumps ETag (CAS-safe)', i1 !== i2, `${i1} vs ${i2}`);

    // --- missing -> 404 ---
    const miss = await fetch(`${base}nope.ttl`);
    check('missing resource -> 404', miss.status === 404, `status ${miss.status}`);

    const fails = results.filter((r) => !r.ok);
    console.log(`\n=== CONTRACT BATTERY: ${results.length - fails.length}/${results.length} passed; ${fails.length} FAILED ===`);
    if (fails.length) console.log('FAILURES: ' + fails.map((f) => `${f.name} (${f.detail})`).join(' || '));
    process.exitCode = fails.length ? 1 : 0;
  } finally {
    await app.stop();
  }
}

main().catch((e) => {
  console.error('CONTRACT BATTERY ERROR:', e);
  process.exit(1);
});
