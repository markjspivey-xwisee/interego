#!/usr/bin/env node
/**
 * Delete disposable pods, or selected resources inside a pod, from the live CSS — carefully.
 *
 * ── WHY EVERY GUARD BELOW IS HERE ────────────────────────────────────────────────────────────
 *
 * This is the only tool in the repo that destroys user-visible data on a live single-replica
 * service. Every guard exists because the failure it prevents is unrecoverable:
 *
 *  - DRY RUN IS THE DEFAULT. `--apply` is required to delete anything. A tool whose default is
 *    destructive gets run destructively by accident exactly once.
 *  - THE TARGET LIST MUST COME FROM A FILE. No globs, no prefixes, no "delete everything matching".
 *    Someone (or something) has to have written each name down, which means each name was decided.
 *  - PROTECTED NAMES CANNOT BE OVERRIDDEN, by any flag. These back published, dereferenceable
 *    namespaces and live identities; losing one breaks IRIs the outside world resolves.
 *  - SEQUENTIAL, WITH A PAUSE. CSS is single-replica and serving production traffic. A parallel
 *    delete storm is indistinguishable, from the outside, from an outage.
 *  - IT RE-READS BEFORE IT DELETES. A container is enumerated at delete time, not from a stale
 *    list, so a pod that gained a resource since classification is reported rather than silently
 *    half-deleted.
 *  - IT IS RESUMABLE AND IDEMPOTENT. A 404 counts as success: interrupted halfway, re-running
 *    finishes the job instead of erroring out.
 *
 * Auth: the css-gate operator bearer, read from `.interego/css-gate-write-secret.txt` (gitignored).
 * This is the gate's intended infrastructure path — NOT the relay's `RELAY_ALLOW_CROSS_POD_WRITES`
 * publish-scope bypass, which stays off and is not used here.
 *
 * Usage:
 *   node tools/css-purge.mjs --pods <file.json>              # dry run, one name per array entry
 *   node tools/css-purge.mjs --pods <file.json> --apply
 *   node tools/css-purge.mjs --resources <file.json>         # absolute URLs to delete
 *   node tools/css-purge.mjs --resources <file.json> --apply
 *
 * A pod purge deletes the pod's CONTENTS depth-first and then the container itself.
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = process.env.CSS_GATE_URL ?? 'https://gate.interego.xwisee.com';

/**
 * ★ NEVER DELETABLE, WHATEVER THE INPUT FILE SAYS.
 *
 * `maintainer` backs the published /ns vocabulary; `agent`, `foxxi`, `markj`, `default` and
 * `course-root` are live identities or roots other data hangs off. A classifier that proposes one
 * of these has made a mistake, and the right response is to refuse and say so, not to comply.
 */
const PROTECTED = new Set([
  'maintainer', 'agent', 'foxxi', 'markj', 'default', 'course-root',
  '.well-known', '.acl', '', 'svc-relay-dcr',
]);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const podsIdx = args.indexOf('--pods');
const resIdx = args.indexOf('--resources');
const PAUSE_MS = Number(process.env.CSS_PURGE_PAUSE_MS ?? 60);

if (podsIdx === -1 && resIdx === -1) {
  console.error('usage: node tools/css-purge.mjs (--pods <file.json> | --resources <file.json>) [--apply]');
  process.exit(2);
}

const secretPath = join(REPO, '.interego/css-gate-write-secret.txt');
if (!existsSync(secretPath)) {
  console.error(`missing ${secretPath} — run: node tools/railway-read-var.mjs css-gate WRITE_SECRET`);
  process.exit(2);
}
const BEARER = `Bearer ${readFileSync(secretPath, 'utf8').trim()}`;
const LOG = join(REPO, '.interego', 'css-purge.log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const audit = (line) => {
  const stamped = `${new Date().toISOString()} ${line}\n`;
  try { appendFileSync(LOG, stamped); } catch { /* the console record is enough */ }
};

async function req(url, method, headers = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, {
        method,
        headers: { ...(method === 'GET' ? { Accept: 'text/turtle' } : {}), Authorization: BEARER, ...headers },
      });
      // 5xx is transient here far more often than it is real; CSS answers 500 when a write lock
      // expires, and the bytes may well have landed. Retrying a DELETE is safe (404 = done).
      if (r.status >= 500 && attempt < 4) { await sleep(400 * attempt); continue; }
      return r;
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(400 * attempt);
    }
  }
  throw new Error('unreachable');
}

/** Children of an LDP container, as absolute URLs. */
async function children(containerUrl) {
  const r = await req(containerUrl, 'GET');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${containerUrl} -> ${r.status}`);
  const body = await r.text();
  const out = new Set();
  for (const m of body.matchAll(/<([^>\s]+)>/g)) {
    const raw = m[1];
    if (!raw || raw.startsWith('http://www.w3.org') || raw.startsWith('http://purl.org')) continue;
    let abs;
    try { abs = new URL(raw, containerUrl).href; } catch { continue; }
    // Only descendants — a listing also names itself, its parent and vocabulary terms.
    if (!abs.startsWith(containerUrl) || abs === containerUrl) continue;
    out.add(abs);
  }
  return [...out];
}

/** Depth-first delete of everything under (and including) a container. Returns a count. */
async function purgeContainer(url, stats, depth = 0) {
  if (depth > 12) throw new Error(`refusing to recurse past depth 12 at ${url}`);
  const kids = url.endsWith('/') ? await children(url) : null;
  if (kids === null && url.endsWith('/')) return 0; // already gone
  let n = 0;
  for (const kid of kids ?? []) {
    n += await purgeContainer(kid, stats, depth + 1);
  }
  if (!APPLY) { stats.wouldDelete++; return n + 1; }
  const r = await req(url, 'DELETE');
  if (r.ok || r.status === 404 || r.status === 205) {
    stats.deleted++;
    audit(`DELETE ${url} -> ${r.status}`);
  } else {
    stats.failed.push(`${url} -> ${r.status}`);
    audit(`FAILED ${url} -> ${r.status}`);
  }
  await sleep(PAUSE_MS);
  return n + 1;
}

const stats = { wouldDelete: 0, deleted: 0, failed: [], skipped: [] };

if (podsIdx !== -1) {
  const file = args[podsIdx + 1];
  const names = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(names)) { console.error(`${file} must contain a JSON array of pod names`); process.exit(2); }

  const targets = [];
  for (const raw of names) {
    const name = String(raw).replace(/^\/+|\/+$/g, '');
    if (PROTECTED.has(name)) { stats.skipped.push(`${name} (PROTECTED — refused)`); continue; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { stats.skipped.push(`${name} (not a plain pod segment — refused)`); continue; }
    targets.push(name);
  }

  console.log(`${APPLY ? 'PURGING' : 'DRY RUN —'} ${targets.length} pod(s) at ${GATE}`);
  if (stats.skipped.length) console.log(`refused: ${stats.skipped.join(', ')}`);

  let i = 0;
  for (const name of targets) {
    i++;
    const url = `${GATE}/${name}/`;
    try {
      const n = await purgeContainer(url, stats);
      console.log(`[${i}/${targets.length}] ${name}: ${APPLY ? 'deleted' : 'would delete'} ${n} resource(s)`);
    } catch (e) {
      stats.failed.push(`${name}: ${e.message}`);
      console.log(`[${i}/${targets.length}] ${name}: FAILED ${e.message}`);
    }
  }
}

if (resIdx !== -1) {
  const file = args[resIdx + 1];
  const urls = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(urls)) { console.error(`${file} must contain a JSON array of absolute URLs`); process.exit(2); }

  console.log(`${APPLY ? 'PURGING' : 'DRY RUN —'} ${urls.length} resource(s)`);
  let i = 0;
  for (const raw of urls) {
    i++;
    let u;
    try { u = new URL(String(raw)); } catch { stats.skipped.push(`${raw} (not a URL)`); continue; }
    if (u.origin !== new URL(GATE).origin) { stats.skipped.push(`${raw} (foreign origin — refused)`); continue; }
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    if (PROTECTED.has(seg)) { stats.skipped.push(`${raw} (pod ${seg} is PROTECTED — refused)`); continue; }
    if (!APPLY) { stats.wouldDelete++; if (i <= 5 || i % 500 === 0) console.log(`  would delete ${u.href}`); continue; }
    const r = await req(u.href, 'DELETE');
    if (r.ok || r.status === 404 || r.status === 205) { stats.deleted++; audit(`DELETE ${u.href} -> ${r.status}`); }
    else { stats.failed.push(`${u.href} -> ${r.status}`); audit(`FAILED ${u.href} -> ${r.status}`); }
    if (i % 250 === 0) console.log(`  ...${i}/${urls.length} (deleted ${stats.deleted}, failed ${stats.failed.length})`);
    await sleep(PAUSE_MS);
  }
}

console.log('');
console.log(APPLY ? `deleted ${stats.deleted} resource(s)` : `would delete ${stats.wouldDelete} resource(s) — re-run with --apply`);
if (stats.skipped.length) console.log(`skipped ${stats.skipped.length}: ${stats.skipped.slice(0, 20).join(', ')}`);
if (stats.failed.length) {
  console.log(`FAILED ${stats.failed.length}:`);
  for (const f of stats.failed.slice(0, 30)) console.log(`  ${f}`);
  process.exit(1);
}
