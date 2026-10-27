#!/usr/bin/env node
// Seeds .cache/upper/<key>.source with pinned upper-ontology sources. refresh-upper.ts trusts a
// cached source only after the same SHA-256 check as a fresh fetch, so the manifest's pin, not this
// script, still decides: bytes that are not the pinned bytes are refused here and never written, and
// a wrong cached file would be refused there.
//
// Default mode: only the sources whose manifest URL is a persistent URL its publisher can re-point,
// from an immutable, commit-addressed copy. https://purl.org/nemo/gufo serves whatever nemo-ufes/gufo
// last committed. Its commit fa89632 (2026-10-26) changed the bytes again, so every fresh fetch
// refused the pin; the Foxxi image build has no cache, so it failed and held back every deploy. The
// pinned bytes are docs/gufo.ttl at the publisher's commit fc7b2a6. When the manifest re-pins gUFO,
// update the commit below with it. Any failure in this mode is an error.
//
// --all <dir>: every source the manifest pins, through its mirror where it has one, into <dir>, best
// effort. On 2026-10-27 the image build died fetching https://data.europa.eu/esco/model
// (ConnectTimeoutError, four attempts in under a minute) and held back every service's deploy; a
// re-run of the same jobs succeeded. build-ghcr.yml runs this mode on the runner, keeps <dir> in the
// Actions cache and hands it to the Dockerfile as the `upper-seed` build context, so a source that
// verified once is not fetched from its publisher by every build. A source that cannot be fetched, or
// whose bytes are not the pin, is reported and left out, and the image build fetches it live as it
// always has. A file already in <dir> is kept only if it matches its pin; a .source file that does
// not, or that no pin names, and an interrupted .download are removed. The last line says whether the
// set is complete, and so does `complete=` in $GITHUB_OUTPUT when that is set: the workflow saves the
// cache only when it is.
//
// Usage: node tools/seed-pinned-upper.mjs <i2idlx root>
//        node tools/seed-pinned-upper.mjs <i2idlx root> --all <dir>
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIRRORS = {
  gufo: {
    url: 'https://purl.org/nemo/gufo',
    mirror: 'https://raw.githubusercontent.com/nemo-ufes/gufo/fc7b2a6531cd7339ced42dde48b6354b72bb1fd4/docs/gufo.ttl',
  },
};

// The User-Agent refresh-upper.ts sends. With its Accept header (readAccepts), a publisher that
// negotiates on the request answers this script as it answers the build.
export const USER_AGENT = 'i2idlx-refresh-upper-typescript/0.5';

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PIN = /^[a-f0-9]{64}$/;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The manifest's pinned sources, checked enough that each key can name a file of its own. */
export function readPins(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'evidence', 'upper', 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest?.sources) || manifest.sources.length === 0) throw new Error('evidence/upper/manifest.json pins no sources');
  const seen = new Set();
  for (const pin of manifest.sources) {
    if (typeof pin?.key !== 'string' || !SAFE_KEY.test(pin.key)) throw new Error('manifest key ' + JSON.stringify(pin?.key) + ' cannot name a cache file');
    if (seen.has(pin.key)) throw new Error('the manifest pins ' + pin.key + ' twice');
    seen.add(pin.key);
  }
  return manifest.sources;
}

/** The Accept header refresh-upper.ts sends for each key: refresh-upper-data.json, SOURCES[].accept. */
export function readAccepts(root) {
  const data = JSON.parse(readFileSync(join(root, 'typescript', 'refresh-upper-data.json'), 'utf8'));
  return new Map((data.SOURCES ?? []).filter((source) => source.accept).map((source) => [source.key, source.accept]));
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** GET with retries. A request that fails is retried; bytes that arrive are returned to be judged. */
export async function download(url, { fetchImpl = fetch, accept, attempts = 4, timeoutMs = 30000, backoffMs = 2000 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(url + ' returned HTTP ' + response.status);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      last = error;
      if (attempt < attempts - 1) await pause(backoffMs * (attempt + 1));
    }
  }
  throw last ?? new Error(url + ': no attempt was made');
}

/**
 * The only writer. It hashes the bytes itself and refuses any that are not the pin, so no caller can
 * put unpinned bytes in a cache. The rename means a reader sees the whole file or no file.
 */
export function writeVerified(target, bytes, pin) {
  const actual = sha256(bytes);
  if (!PIN.test(pin.sha256 ?? '') || actual !== pin.sha256) {
    throw new Error(pin.key + ': refusing to write bytes with SHA-256 ' + actual + '; the manifest pins ' + pin.sha256);
  }
  const partial = target + '.' + process.pid + '.download';
  try {
    writeFileSync(partial, bytes);
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
}

const describe = (error) => String(error?.message ?? error) + (error?.cause?.code ? ' (' + error.cause.code + ')' : '');

/** Default mode: the mirrored sources only, into <root>/.cache/upper. Any failure throws. */
export async function seedMirrors(root, { fetchImpl = fetch, log = console.log, backoffMs = 2000 } = {}) {
  const pins = readPins(root);
  const cache = join(root, '.cache', 'upper');
  for (const [key, { url, mirror }] of Object.entries(MIRRORS)) {
    const pin = pins.find((source) => source.key === key);
    if (!pin) throw new Error(key + ': the manifest no longer pins this source; remove its mirror');
    if (pin.url !== url) throw new Error(key + ': the manifest pins ' + pin.url + ', not ' + url + '; update the mirror with it');
    const target = join(cache, key + '.source');
    if (existsSync(target) && sha256(readFileSync(target)) === pin.sha256) {
      log(key + ': cached source already matches the pin');
      continue;
    }
    const bytes = await download(mirror, { fetchImpl, backoffMs });
    const actual = sha256(bytes);
    if (actual !== pin.sha256) throw new Error(key + ': ' + mirror + ' has SHA-256 ' + actual + ', the manifest pins ' + pin.sha256 + '; update the mirror commit with the pin');
    mkdirSync(cache, { recursive: true });
    writeVerified(target, bytes, pin);
    log(key + ': seeded ' + bytes.length + ' bytes from ' + mirror);
  }
}

/** Where to ask for one source: its commit-addressed mirror first when it has one, then its own URL. */
function candidates(pin, notes) {
  const entry = MIRRORS[pin.key];
  if (!entry) return [pin.url];
  if (entry.url === pin.url) return [entry.mirror, pin.url];
  notes.push('its mirror is for ' + entry.url + ', not the pinned ' + pin.url + ', so it was not used');
  return [pin.url];
}

/**
 * --all mode: every pinned source into `out`, best effort. Every pinned key ends in exactly one of
 * `cached` (already there and matching), `seeded` (fetched, verified, written) or `skipped` (with
 * the reason), and each skip is logged as a warning.
 */
export async function seedAll(root, out, { fetchImpl = fetch, log = console.log, backoffMs = 2000, timeoutMs = 30000, attempts = 4 } = {}) {
  const pins = readPins(root);
  const accepts = readAccepts(root);
  mkdirSync(out, { recursive: true });
  const report = { cached: [], seeded: [], skipped: [], removed: [], complete: false, missing: [] };
  const warn = (line) => log('::warning::upper seed: ' + line);

  const named = new Set(pins.map((pin) => pin.key + '.source'));
  for (const name of readdirSync(out)) {
    if (name.endsWith('.download') || (name.endsWith('.source') && !named.has(name))) {
      rmSync(join(out, name), { force: true });
      report.removed.push(name);
      log(name + ': removed; no pinned source is written there');
    }
  }

  const pending = [];
  for (const pin of pins) {
    const target = join(out, pin.key + '.source');
    if (!PIN.test(pin.sha256 ?? '')) {
      rmSync(target, { force: true });
      report.skipped.push({ key: pin.key, reason: 'the manifest has no SHA-256 pin to verify it against' });
      continue;
    }
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) === pin.sha256) {
        report.cached.push(pin.key);
        continue;
      }
      rmSync(target, { force: true });
      report.removed.push(pin.key + '.source');
      warn(pin.key + ': removed a cached file whose bytes are not the pin');
    }
    pending.push(pin);
  }
  log('upper seed: ' + report.cached.length + ' of ' + pins.length + ' pinned sources already verified in ' + out + '; fetching ' + pending.length);

  await Promise.all(pending.map(async (pin) => {
    const target = join(out, pin.key + '.source');
    const notes = [];
    for (const url of candidates(pin, notes)) {
      let bytes;
      try {
        bytes = await download(url, { fetchImpl, accept: accepts.get(pin.key), attempts, timeoutMs, backoffMs });
      } catch (error) {
        notes.push(url + ': ' + describe(error));
        continue;
      }
      const actual = sha256(bytes);
      if (actual !== pin.sha256) {
        notes.push(url + ' served SHA-256 ' + actual + ', the manifest pins ' + pin.sha256);
        continue;
      }
      try {
        writeVerified(target, bytes, pin);
      } catch (error) {
        notes.push('writing ' + target + ': ' + describe(error));
        break;
      }
      report.seeded.push({ key: pin.key, url, bytes: bytes.length });
      return;
    }
    report.skipped.push({ key: pin.key, reason: notes.join('; ') });
  }));

  report.cached.sort();
  report.seeded.sort((a, b) => a.key.localeCompare(b.key));
  report.skipped.sort((a, b) => a.key.localeCompare(b.key));
  for (const key of report.cached) log(key + ': cached source already matches the pin');
  for (const { key, url, bytes } of report.seeded) log(key + ': seeded ' + bytes + ' bytes from ' + url);
  for (const { key, reason } of report.skipped) warn(key + ': not seeded, so the image build fetches it live. ' + reason);

  const verified = report.cached.length + report.seeded.length;
  report.missing = report.skipped.map((skip) => skip.key);
  report.complete = report.missing.length === 0 && verified === pins.length;
  log(report.complete
    ? 'upper seed complete: all ' + pins.length + ' pinned sources verified in ' + out
    : 'upper seed INCOMPLETE: ' + verified + ' of ' + pins.length + ' pinned sources verified in ' + out + '; not seeded: ' + report.missing.join(', '));
  return report;
}

async function main(argv) {
  const [rootArg, flag, outArg, ...rest] = argv;
  if (!rootArg || rootArg.startsWith('--') || (flag !== undefined && (flag !== '--all' || !outArg || rest.length))) {
    throw new Error('Usage: seed-pinned-upper.mjs <i2idlx root> [--all <dir>]');
  }
  const root = resolve(rootArg);
  if (flag === undefined) return seedMirrors(root);
  const report = await seedAll(root, resolve(outArg));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, 'complete=' + report.complete + '\nmissing=' + report.missing.join(',') + '\n');
  }
}

/**
 * Is this file the program node was started with, rather than a module a test imported? Node runs
 * the main module from its real path, while process.argv[1] is the path as typed, so the two are
 * compared as real paths. Compared as URLs they differ whenever the typed path goes through a
 * symlink, and the script then did nothing at all and exited 0: no seed, no warning, no complete=.
 */
function startedAsProgram() {
  if (!process.argv[1]) return false;
  let typed;
  try {
    typed = realpathSync(process.argv[1]);
  } catch {
    return false; // not a file (node -e, node -), so not this one
  }
  return typed === realpathSync(fileURLToPath(import.meta.url));
}

if (startedAsProgram()) {
  await main(process.argv.slice(2));
}
