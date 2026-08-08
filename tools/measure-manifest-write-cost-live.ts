/**
 * WHAT A MANIFEST WRITE ACTUALLY COSTS, MEASURED AGAINST THE LIVE FLEET.
 *
 * The reported failure is that publishing onto the maintainer's pod drives CSS past its
 * 6000 ms write-lock TTL (`WrappedExpiringReadWriteLocker … Lock expired after 6000ms`), and
 * that lock expiry is a watchdog rather than a rollback — so the bytes land and CSS still
 * answers 5xx. Before designing anything, this driver establishes three numbers that any
 * design has to be answerable to:
 *
 *   1. the maintainer manifest's real size — bytes, entries, and (the number that matters)
 *      TURTLE STATEMENTS, because the live storage backend is statement-granular;
 *   2. PUT latency as a function of statement count, on a disposable pod, measured;
 *   3. whether the cost tracks STATEMENTS or BYTES — by writing the identical bytes twice,
 *      once as `text/turtle` (the RDF codec path: one content-addressed atom per statement)
 *      and once as `application/octet-stream` (the opaque path: exactly one atom, whatever
 *      the size). If the two are close the cost is bytes and bounding the entry count buys
 *      nothing; if turtle is far slower the cost is statements and the entry count IS the
 *      lever.
 *
 * ★ (3) IS THE ONE THAT DECIDES WHETHER THE ARCHIVE DESIGN IS EVEN THE RIGHT SHAPE, so it is
 * measured rather than argued from reading `PgslDataAccessor` → `LdpStore.writeResource` →
 * `rdfCodec.ingest` → `PgslStore.compose`.
 *
 *   npx tsx tools/measure-manifest-write-cost-live.ts
 */

import { Wallet } from 'ethers';
import { mintBearer, type Signer } from '../applications/shared-workspace/tools/live-identity.js';

const GATE = process.env['INTEREGO_GATE'] ?? 'https://gate.interego.xwisee.com';
const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const MAINTAINER_POD = 'u-eth-8f3b8e939600';

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 66 - s.length))); };

/**
 * Count Turtle statements the way the live storage backend does.
 *
 * Deliberately a local copy of `splitTurtleStatements`'s terminator rule rather than an import
 * of `@interego/pgsl-store`: the point is to count what CSS's accessor will count, and a driver
 * that imported the very function under measurement could not notice if the deployed image's
 * copy differed. A '.' followed by whitespace-or-EOF ends a statement; directives don't count.
 */
function countStatements(text: string): number {
  let n = 0;
  let inStr: false | '"' | "'" = false;
  let inIri = false;
  let inComment = false;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inComment) { if (c === '\n') inComment = false; buf += c; continue; }
    if (inStr) { buf += c; if (c === '\\') { i++; continue; } if (c === inStr) inStr = false; continue; }
    if (inIri) { buf += c; if (c === '>') inIri = false; continue; }
    if (c === '#') { inComment = true; continue; }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === '<') { inIri = true; buf += c; continue; }
    if (c === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]!))) {
      const s = buf.replace(/#[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
      if (s && !/^@?(prefix|base)\b/i.test(s)) n++;
      buf = '';
      continue;
    }
    buf += c;
  }
  return n;
}

/** One synthetic manifest entry shaped like the real ones (13 predicates, ~700 bytes). */
function syntheticEntry(pod: string, i: number): string {
  const base = `${GATE}/${pod}/context-graphs/probe-${i}.ttl`;
  return [
    `<${base}> a iep:ManifestEntry ;`,
    `    iep:contentCid "bafkreig6aduecsi7xu35mvlonnlgh5cua5njb2s4ofcmicdxvmvhldojm${i % 10}" ;`,
    `    iep:describes <urn:graph:probe:${i}> ;`,
    `    iep:hasFacetType iep:Temporal ;`,
    `    iep:hasFacetType iep:Provenance ;`,
    `    iep:hasFacetType iep:Agent ;`,
    `    iep:hasFacetType iep:Semiotic ;`,
    `    iep:hasFacetType iep:Trust ;`,
    `    iep:hasFacetType iep:Federation ;`,
    `    iep:validFrom "2026-08-08T0${i % 10}:00:00.000Z"^^xsd:dateTime ;`,
    `    iep:modalStatus iep:Asserted ;`,
    `    iep:trustLevel iep:SelfAsserted ;`,
    `    iep:issuer <${IDENTITY}/users/${pod}/profile#me> .`,
  ].join('\n');
}

function syntheticManifest(pod: string, n: number): string {
  const prefixes = [
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix dct: <http://purl.org/dc/terms/> .',
  ].join('\n');
  const entries: string[] = [];
  for (let i = 0; i < n; i++) entries.push(syntheticEntry(pod, i));
  return `${prefixes}\n\n${entries.join('\n\n')}\n`;
}

interface Timing { ms: number; status: number }

/**
 * ★ A NON-2xx PUT IS NOT A MEASUREMENT, IT IS A REJECTION, AND IT LOOKS FAST.
 *
 * The first run of this driver reported a flat ~110 ms across every size and would have
 * "proved" the write cost was constant. Every one of those responses was a 401 from the gate:
 * the bearer had been read off the wrong field, so nothing ever reached CSS. Throwing here is
 * the difference between measuring the system and measuring the doorway.
 */
async function timedPut(url: string, body: string, contentType: string, bearer: string): Promise<Timing> {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Authorization': `Bearer ${bearer}` },
    body,
  });
  const text = await r.text();
  const ms = Date.now() - t0;
  if (r.status >= 300) throw new Error(`PUT <${url}> -> ${r.status} ${r.statusText} :: ${text.slice(0, 200)}`);
  return { ms, status: r.status };
}

async function timedGet(url: string): Promise<Timing & { bytes: number; body: string }> {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
  const body = await r.text();
  return { ms: Date.now() - t0, status: r.status, bytes: body.length, body };
}

async function main(): Promise<void> {
  head('1. the maintainer manifest as it stands');
  const live = await timedGet(`${GATE}/${MAINTAINER_POD}/.well-known/context-graphs`);
  const liveEntries = (live.body.match(/a iep:ManifestEntry/g) ?? []).length;
  const liveStatements = countStatements(live.body);
  log(`GET  status=${live.status} bytes=${live.bytes} entries=${liveEntries} statements=${liveStatements} ms=${live.ms}`);
  log(`bytes/entry = ${(live.bytes / Math.max(1, liveEntries)).toFixed(0)}`);

  head('2. a disposable pod');
  const wallet = Wallet.createRandom();
  const bearer = await mintBearer(RELAY, IDENTITY, wallet as unknown as Signer, 'manifest-cost-probe');
  const token = bearer.accessToken;
  // The gate binds a user bearer to `/<userId>/`; derive it the way the relay does.
  const pod = `u-eth-${wallet.address.slice(2, 14).toLowerCase()}`;
  log(`wallet ${wallet.address} → pod ${pod}`);

  head('3. PUT latency vs statement count (turtle, the codec path)');
  const sizes = [1, 10, 50, 100, 200, 300, 400, 450, 500, 550, 653, 900];
  const results: Array<{ n: number; bytes: number; overwrite: number | null }> = [];
  for (const n of sizes) {
    const body = syntheticManifest(pod, n);
    const url = `${GATE}/${pod}/probe/manifest-${n}`;
    // Two writes: the first CREATEs, the second OVERWRITEs. publish() always overwrites, so
    // the second number is the one the design has to answer to.
    let create: number | null = null;
    let overwrite: number | null = null;
    let note = '';
    try { create = (await timedPut(url, body, 'text/turtle', token)).ms; }
    catch (e) { note = ' create:' + String(e).replace(/\s+/g, ' ').slice(0, 90); }
    try { overwrite = (await timedPut(url, body, 'text/turtle', token)).ms; }
    catch (e) { note += ' overwrite:' + String(e).replace(/\s+/g, ' ').slice(0, 90); }
    results.push({ n, bytes: body.length, overwrite });
    log(`n=${String(n).padStart(4)} bytes=${String(body.length).padStart(7)} create=${String(create ?? 'FAIL').padStart(6)} overwrite=${String(overwrite ?? 'FAIL').padStart(6)}${note}`);
  }

  head('4. same bytes, opaque (non-RDF) — is the cost statements or bytes?');
  for (const n of [100, 653, 900]) {
    const body = syntheticManifest(pod, n);
    const url = `${GATE}/${pod}/probe/opaque-${n}.bin`;
    try {
      const t = await timedPut(url, body, 'application/octet-stream', token);
      log(`n=${String(n).padStart(4)} bytes=${String(body.length).padStart(7)} opaque-PUT=${String(t.ms).padStart(6)}ms`);
    } catch (e) { log(`n=${String(n).padStart(4)} opaque-PUT FAILED ${String(e).slice(0, 140)}`); }
  }

  head('5. derived: the linear fit, and what fits the 6000ms lock');
  const ok = results.filter((r): r is { n: number; bytes: number; overwrite: number } => r.overwrite !== null);
  // Least-squares over the successful overwrites: cost(n) = intercept + slope*n.
  const nMean = ok.reduce((a, r) => a + r.n, 0) / ok.length;
  const yMean = ok.reduce((a, r) => a + r.overwrite, 0) / ok.length;
  const slope = ok.reduce((a, r) => a + (r.n - nMean) * (r.overwrite - yMean), 0)
    / ok.reduce((a, r) => a + (r.n - nMean) ** 2, 0);
  const intercept = yMean - slope * nMean;
  log(`cost(n) ≈ ${intercept.toFixed(0)}ms + ${slope.toFixed(2)}ms × entries   (n=${ok.length} points)`);
  log(`predicted cliff (6000ms lock): ${Math.floor((6000 - intercept) / slope)} entries`);
  for (const budget of [1000, 1500, 2000, 2500, 3000]) {
    log(`entries whose write fits in ${budget}ms: ${Math.floor((budget - intercept) / slope)}`);
  }
}

main().catch((e: unknown) => { log('FATAL ' + String(e)); process.exit(1); });
