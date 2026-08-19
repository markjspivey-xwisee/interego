#!/usr/bin/env node
/**
 * Collect a per-pod EVIDENCE TABLE for every container on the live CSS. Read-only.
 *
 * ── WHY A TABLE AND NOT A VERDICT ────────────────────────────────────────────────────────────
 *
 * The first attempt at this cleanup asked eighteen agents to judge 680 pods and produced 607
 * "disposable" verdicts, five of six of which an adversarial pass then refuted. The judgements
 * were not the problem; the INPUTS were. Three blind spots did all the damage, and each one is a
 * request this tool makes and that pass did not:
 *
 *  1. IT READ ONLY WHAT A POD PUBLISHED. `.well-known/context-graphs` is the outbox. An LDN
 *     `inbox/` holds what OTHER principals sent — workspace invitations, third-party delegations —
 *     and a pod can be empty by every publish-side measure while holding a live invitation.
 *  2. IT TREATED `eth-<hex>` AND `u-eth-<hex>` AS DIFFERENT PRINCIPALS. `own-pod.ts` derives the
 *     first from a bare `did:ethr:`; the identity service derives the second for the SAME wallet.
 *     Deleting the "unused" spelling deletes half of one identity.
 *  3. IT SAMPLED THE PUBLISHED-IRI CHECK. `/ns/:owner/:slug` resolves out of the pod itself, so a
 *     missed pod is a permanently broken IRI. Sampling cannot establish absence.
 *
 * So this emits FACTS — counts, sizes, status codes, timestamps — and no verdict at all. The rules
 * are applied downstream where they can be read, argued with, and changed without re-fetching.
 *
 * Resumable: an existing output file is loaded and its pods are skipped, so an interrupted run
 * costs only what it had not already done. CSS is single-replica, so concurrency is deliberately
 * low and every miss is recorded rather than retried into the ground.
 *
 * Usage:
 *   node tools/css-pod-evidence.mjs <out.json> [--concurrency 3] [--only <prefix>]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const GATE = process.env.CSS_GATE_URL ?? 'https://gate.interego.xwisee.com';
const NS_ROOT = process.env.RELAY_NS_ROOT ?? 'https://relay.interego.xwisee.com/ns';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

const argv = process.argv.slice(2);
const outFile = argv[0];
if (!outFile) { console.error('usage: node tools/css-pod-evidence.mjs <out.json> [--concurrency N] [--only <prefix>]'); process.exit(2); }
const CONC = Number(argv[argv.indexOf('--concurrency') + 1]) || 3;
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function req(url, init = {}) {
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'text/turtle' }, ...init });
      if (r.status >= 500 && a < 3) { await sleep(400 * a); continue; }
      return r;
    } catch (e) { if (a === 3) return { ok: false, status: 0, _err: String(e.message ?? e) }; await sleep(400 * a); }
  }
  return { ok: false, status: 0 };
}

/** Immediate children of a container, as bare names. */
function childNames(body, base) {
  const out = new Set();
  for (const m of body.matchAll(/<([^>\s]+)>/g)) {
    const raw = m[1];
    if (!raw || raw.startsWith('http://www.w3.org') || raw.startsWith('http://purl.org')) continue;
    let abs; try { abs = new URL(raw, base).href; } catch { continue; }
    if (!abs.startsWith(base) || abs === base) continue;
    const rest = abs.slice(base.length).replace(/\/$/, '');
    if (rest && !rest.includes('/')) out.add(rest + (abs.endsWith('/') ? '/' : ''));
  }
  return [...out];
}

async function countChildren(url) {
  const r = await req(url);
  if (!r.ok) return { status: r.status, count: -1 };
  const body = await r.text();
  return { status: 200, count: childNames(body, url).length, body };
}

async function evidenceFor(pod) {
  const base = `${GATE}/${pod}/`;
  const e = {
    pod,
    rootStatus: 0, children: [], rootModified: '',
    hasProfile: false, hasAuthMethods: false, hasAgents: false,
    inboxCount: -1, credentialCount: -1, descriptorCount: -1,
    manifestStatus: 0, manifestBytes: 0, manifestEntries: -1,
    newestActivity: '', nsPublished: [], nsForeign: [], agentClients: [], notes: [],
  };

  const root = await req(base);
  e.rootStatus = root.status;
  if (!root.ok) { e.notes.push(`root -> ${root.status}`); return e; }
  const rootBody = await root.text();
  e.children = childNames(rootBody, base).sort();
  // ★ THE CONTAINER'S OWN dc:modified, NOT the newest iep:validFrom in its manifest. A recency
  // gate built on validFrom reads only what the pod PUBLISHED, so a pod written to nine days ago
  // that published nothing scores as "no activity" and sails through a ten-day window. Six pods
  // did exactly that. CSS stamps the container on every write, whatever the write was.
  e.rootModified = rootBody.match(/dc(?:terms)?:modified\s+"([^"]+)"/)?.[1]
    ?? rootBody.match(/<http:\/\/purl\.org\/dc\/terms\/modified>\s+"([^"]+)"/)?.[1]
    ?? '';

  e.hasProfile = e.children.includes('profile/');
  e.hasAuthMethods = e.children.includes('auth-methods.jsonld');
  e.hasAgents = e.children.includes('agents');

  // ── inbound: what OTHERS sent. The blind spot that refuted the whole first pass.
  if (e.children.includes('inbox/')) {
    const c = await countChildren(`${base}inbox/`);
    e.inboxCount = c.count;
  } else e.inboxCount = 0;

  if (e.children.includes('credentials/')) {
    const c = await countChildren(`${base}credentials/`);
    e.credentialCount = c.count;
  } else e.credentialCount = 0;

  if (e.children.includes('context-graphs/')) {
    const c = await countChildren(`${base}context-graphs/`);
    e.descriptorCount = c.count;
  } else e.descriptorCount = 0;

  if (e.hasAgents) {
    const r = await req(`${base}agents`);
    if (r.ok) {
      const b = await r.text();
      e.agentClients = [...new Set([...b.matchAll(/"?(?:clientId|client_id)"?\s*[:=]?\s*"?([A-Za-z0-9._:-]{4,})"?/g)]
        .map(m => m[1]))].slice(0, 8);
      if (e.agentClients.length === 0) {
        e.agentClients = [...new Set([...b.matchAll(/agents:([A-Za-z0-9._-]{4,})/g)].map(m => m[1]))].slice(0, 8);
      }
    }
  }

  // ── the index, and every namespace this pod backs
  const manifestUrl = `${base}.well-known/context-graphs`;
  const head = await req(manifestUrl, { method: 'HEAD' });
  e.manifestStatus = head.status;
  if (head.ok) {
    e.manifestBytes = Number(head.headers?.get?.('content-length') ?? 0);
    if (e.manifestBytes > MAX_MANIFEST_BYTES) {
      e.notes.push(`manifest ${e.manifestBytes} bytes — not downloaded`);
    } else {
      const r = await req(manifestUrl);
      if (r.ok) {
        const b = await r.text();
        if (!e.manifestBytes) e.manifestBytes = Buffer.byteLength(b, 'utf8');
        e.manifestEntries = (b.match(/a iep:ManifestEntry/g) ?? []).length;
        const stamps = [...b.matchAll(/iep:validFrom\s+"([^"]+)"/g)].map(m => m[1]).sort();
        e.newestActivity = stamps.length ? stamps[stamps.length - 1] : '';
        const described = [...new Set([...b.matchAll(/iep:describes\s+<([^>]+)>/g)].map(m => m[1]))];
        const needle = `${NS_ROOT}/${pod}/`;
        e.nsPublished = described.filter(u => u.startsWith(needle)).slice(0, 10);
        // ★ AND THE GRAPHS IT DESCRIBES UNDER SOMEONE ELSE'S NAMESPACE. Membership in this system is
        // TWO-SIDED: a workspace lives under the convener's `/ns/<convener>/wsp-…` and the member's
        // own pod holds the other half (`roster.ts` — "The other half, from the member's own pod").
        // A rule that only asks "does this pod publish under ITS OWN segment" sees a participant in
        // somebody else's workspace as publishing nothing at all, and deleting it silently removes
        // the half that makes the other party's membership verifiable.
        e.nsForeign = described
          .filter(u => u.startsWith(`${NS_ROOT}/`) && !u.startsWith(needle))
          .slice(0, 10);
        if (/ontologies\//.test(b)) e.notes.push('references an ontologies/ container (the /ns fallback path)');
      } else e.notes.push(`manifest GET -> ${r.status}`);
    }
  }
  return e;
}

// ── run ─────────────────────────────────────────────────────────────────────────

const rootResp = await req(`${GATE}/`);
if (!rootResp.ok) { console.error(`gate root -> ${rootResp.status}`); process.exit(1); }
const rootBody = await rootResp.text();
let pods = [...new Set([...rootBody.matchAll(/<([^>]*?)\/>/g)].map(m => m[1]).filter(p => p && !p.startsWith('http')))].sort();
if (ONLY) pods = pods.filter(p => p.startsWith(ONLY));

const existing = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : [];
const done = new Set(existing.map(e => e.pod));
const todo = pods.filter(p => !done.has(p));
console.log(`${pods.length} pod(s) on the gate; ${done.size} already collected; ${todo.length} to do (concurrency ${CONC})`);

const results = [...existing];
let i = 0;
async function worker() {
  for (;;) {
    const idx = i++;
    if (idx >= todo.length) return;
    const pod = todo[idx];
    try { results.push(await evidenceFor(pod)); }
    catch (err) { results.push({ pod, rootStatus: -1, notes: [`collector error: ${String(err.message ?? err)}`], children: [], nsPublished: [], agentClients: [] }); }
    if (results.length % 25 === 0) {
      writeFileSync(outFile, JSON.stringify(results), 'utf8');
      console.log(`  ...${results.length}/${pods.length}`);
    }
    await sleep(30);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

results.sort((a, b) => a.pod.localeCompare(b.pod));
writeFileSync(outFile, JSON.stringify(results, null, 0), 'utf8');
console.log(`\nwrote ${results.length} pod evidence record(s) -> ${outFile}`);
