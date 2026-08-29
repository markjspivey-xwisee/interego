#!/usr/bin/env node
/**
 * Rebuild one pod's manifest from the descriptors that ACTUALLY remain on it.
 *
 * ★ WHY THIS IS THE STEP AFTER A PURGE, NOT AN OPTIONAL TIDY. Deleting descriptors leaves the
 * index asserting rows for resources that are gone: `discover()` still returns them, and every
 * consumer that dereferences one gets a 404 from a pod that told it the row was there. An index
 * that lies about its own pod is worse than a big index. `rebuildManifestFromPod` re-derives the
 * whole thing from the container scan and retires the archive segments the new index no longer
 * references, so the answer matches the pod again.
 *
 * It also re-splits under the CURRENT bound — which is now bytes as well as rows — so a pod whose
 * index predates that fix comes back byte-bounded rather than merely row-bounded.
 *
 * Auth is the css-gate operator bearer (`.interego/css-gate-write-secret.txt`, gitignored): the
 * gate's intended infrastructure path — an operator credential the gate issues, not a bypass
 * around the relay's ownership checks. (It used to be contrasted here with the relay's
 * `RELAY_ALLOW_CROSS_POD_WRITES` hatch, which has since been censused dead and removed.)
 *
 * Usage:
 *   node tools/css-rebuild-manifest.mjs <podSegment>            # dry run: report only
 *   node tools/css-rebuild-manifest.mjs <podSegment> --apply
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = process.env.CSS_GATE_URL ?? 'https://gate.interego.xwisee.com';

const PROTECTED_FROM_REBUILD = new Set(['', '.well-known']);

const [seg, ...rest] = process.argv.slice(2);
const APPLY = rest.includes('--apply');
if (!seg || PROTECTED_FROM_REBUILD.has(seg)) {
  console.error('usage: node tools/css-rebuild-manifest.mjs <podSegment> [--apply]');
  process.exit(2);
}

const secretPath = join(REPO, '.interego/css-gate-write-secret.txt');
if (!existsSync(secretPath)) {
  console.error(`missing ${secretPath} — run: node tools/railway-read-var.mjs css-gate WRITE_SECRET`);
  process.exit(2);
}
const BEARER = `Bearer ${readFileSync(secretPath, 'utf8').trim()}`;
const POD = `${GATE}/${seg.replace(/^\/+|\/+$/g, '')}/`;

let reads = 0; let writes = 0; let deletes = 0;

/**
 * The operator fetch handed to the rebuild. In dry-run it REFUSES every mutating method rather
 * than quietly succeeding — a "dry run" that a library can write through is not a dry run.
 */
const operatorFetch = async (url, init = {}) => {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') reads++;
  else if (method === 'DELETE') { deletes++; }
  else { writes++; }

  if (!APPLY && method !== 'GET' && method !== 'HEAD') {
    console.log(`  [dry-run] would ${method} ${url}`
      + (typeof init.body === 'string' ? ` (${Buffer.byteLength(init.body, 'utf8')} bytes)` : ''));
    // Shape-compatible with what the client expects from a successful write.
    return {
      ok: true, status: 205, statusText: 'Reset Content (dry run)',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    };
  }
  return fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: BEARER } });
};

const { rebuildManifestFromPod } = await import('@interego/solid');

console.log(`${APPLY ? 'REBUILDING' : 'DRY RUN —'} manifest for ${POD}`);
try {
  const r = await rebuildManifestFromPod(POD, {
    fetch: operatorFetch,
    log: (m) => console.log(`  ${m}`),
  });
  console.log('');
  console.log(`scanned ${r.scanned} descriptor(s), wrote ${r.written} row(s)`);
  console.log(`archive segments now referenced: ${r.archives.length}`);
  console.log(`stale segments retired: ${r.archivesDeleted.length}`);
  console.log(`requests — read ${reads}, write ${writes}, delete ${deletes}`);
  if (!APPLY) console.log('\nnothing was changed — re-run with --apply');
} catch (e) {
  console.error(`rebuild failed: ${e.message}`);
  process.exit(1);
}
