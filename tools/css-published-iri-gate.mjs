#!/usr/bin/env node
/**
 * Refuse to delete any pod that BACKS A LIVE, DEREFERENCEABLE `/ns/<owner>/<slug>` IRI.
 *
 * ★ WHY THIS IS A MECHANICAL GATE AND NOT A JUDGEMENT CALL. `resolveNsGraph` in the relay
 * (deploy/mcp-relay/server.ts) answers `/ns/:owner/:slug` by calling `discover()` on
 * `<CSS>/<owner>/` and serving the head descriptor's graph — so the pod IS the backing store for
 * every namespace published under its own segment. Delete the pod and the IRI 404s, permanently,
 * for every outside consumer that resolved it. "Everything is a URL" cuts both ways: a published
 * IRI is a promise, and deleting its pod breaks the promise silently.
 *
 * Sampling cannot establish this. A classifier that checked ten pods and found no namespaces says
 * nothing about the eleventh, and the cost of being wrong is an unrecoverable broken IRI. So every
 * candidate is checked, individually, before anything is deleted.
 *
 * Method per pod: read its manifest and look for any entry whose `iep:describes` is rooted at
 * `<NS_ROOT>/<thatPod>/`. That is exactly the shape `/ns/:owner/:slug` resolves, so a hit means a
 * live IRI depends on this pod. A manifest too large to read safely is treated as a RESCUE, not a
 * pass — an unread manifest is not evidence of absence.
 *
 * Read-only. Emits a filtered list; deletes nothing.
 *
 * Usage:
 *   node tools/css-published-iri-gate.mjs <candidates.json> <safe-out.json> [<rescued-out.json>]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const GATE = process.env.CSS_GATE_URL ?? 'https://gate.interego.xwisee.com';
const NS_ROOT = process.env.RELAY_NS_ROOT ?? 'https://relay.interego.xwisee.com/ns';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const PAUSE_MS = Number(process.env.GATE_PAUSE_MS ?? 40);

const [inFile, outFile, rescueFile] = process.argv.slice(2);
if (!inFile || !outFile) {
  console.error('usage: node tools/css-published-iri-gate.mjs <candidates.json> <safe-out.json> [<rescued-out.json>]');
  process.exit(2);
}

const candidates = JSON.parse(readFileSync(inFile, 'utf8'));
if (!Array.isArray(candidates)) { console.error(`${inFile} must be a JSON array of pod names`); process.exit(2); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryFetch(url, init) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url, init);
      if (r.status >= 500 && a < 3) { await sleep(300 * a); continue; }
      return r;
    } catch (e) { if (a === 3) return { ok: false, status: 0, _err: e.message }; await sleep(300 * a); }
  }
  return { ok: false, status: 0 };
}

const safe = [];
const rescued = [];
let i = 0;

for (const pod of candidates) {
  i++;
  const manifest = `${GATE}/${pod}/.well-known/context-graphs`;
  const head = await tryFetch(manifest, { method: 'HEAD' });

  if (head.status === 404 || head.status === 410) {
    // Never published anything at all — it cannot be backing a namespace.
    safe.push(pod);
  } else if (!head.ok) {
    rescued.push({ pod, why: `manifest HEAD -> ${head.status}${head._err ? ` (${head._err})` : ''}; cannot prove it publishes nothing` });
  } else {
    const len = Number(head.headers?.get?.('content-length') ?? 0);
    if (len > MAX_MANIFEST_BYTES) {
      rescued.push({ pod, why: `manifest is ${len} bytes — too large to read safely; an unread manifest is not evidence of absence` });
    } else {
      const r = await tryFetch(manifest, { headers: { Accept: 'text/turtle' } });
      if (!r.ok) {
        rescued.push({ pod, why: `manifest GET -> ${r.status}; cannot prove it publishes nothing` });
      } else {
        const body = await r.text();
        // Any graph published under THIS pod's own /ns segment.
        const needle = `${NS_ROOT}/${pod}/`;
        const hits = [...body.matchAll(/iep:describes\s+<([^>]+)>/g)].map(m => m[1]).filter(u => u.startsWith(needle));
        // Also catch the ontologies/ convention container, which the resolver falls back to.
        const hasOntologies = /ontologies\//.test(body);
        if (hits.length > 0) {
          rescued.push({ pod, why: `backs ${new Set(hits).size} live /ns IRI(s), e.g. ${[...new Set(hits)][0]}` });
        } else if (hasOntologies) {
          rescued.push({ pod, why: 'manifest references an ontologies/ container — the /ns fallback path' });
        } else {
          safe.push(pod);
        }
      }
    }
  }

  if (i % 50 === 0) console.log(`  ...${i}/${candidates.length} (safe ${safe.length}, rescued ${rescued.length})`);
  await sleep(PAUSE_MS);
}

writeFileSync(outFile, JSON.stringify(safe, null, 0), 'utf8');
if (rescueFile) writeFileSync(rescueFile, JSON.stringify(rescued, null, 2), 'utf8');

console.log('');
console.log(`checked ${candidates.length} pod(s)`);
console.log(`  safe to delete : ${safe.length}  -> ${outFile}`);
console.log(`  RESCUED        : ${rescued.length}${rescueFile ? `  -> ${rescueFile}` : ''}`);
for (const r of rescued.slice(0, 25)) console.log(`      ${r.pod}: ${r.why}`);
if (rescued.length > 25) console.log(`      ...and ${rescued.length - 25} more`);
