#!/usr/bin/env node
/**
 * Can CSS mint PUBLIC identifiers on Railway, or is the internal host still forced?
 *
 * ── THE QUESTION, AND WHY IT IS NOT OBVIOUS ──────────────────────────────────────────────────
 *
 * `CSS_BASE_URL` is `http://css.railway.internal:3456/`, which does not resolve outside the
 * deployment — and CSS stamps it into every identifier it mints. Measured on one live pod: 1,402 of
 * 3,073 URLs in its manifest carry that host. Nearly half of what this system publishes is an
 * address only this system can follow, which is a worse failure than an opaque `urn:` because it
 * LOOKS dereferenceable and fails in somebody else's code. It has caused three incidents so far: the
 * SSRF guard on the CLR wallet read, a self-read 403 (isSelf comparing two spellings of one pod),
 * and an agent capability document advertising an `iep:askVia` no peer can reach.
 *
 * ★ THE REASON IT IS LOCKED IS AN AZURE REASON, AND WE LEFT AZURE. Container Apps' internal envoy
 * routed by Host header, so the gate's outbound Host had to be the internal FQDN or envoy reset the
 * connection; CSS then had to agree, because it rejects a Host it does not consider its own
 * identifier space. On Railway the private network routes by DNS name and port on the TCP
 * connection, so the HTTP Host header should be free — the gate already targets
 * `css.railway.internal:3456` for the socket and sets `CSS_HOST_HEADER` separately. Should be. That
 * is exactly the kind of inherited constraint worth measuring rather than believing.
 *
 * ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────────────
 *
 * It sends requests to the live CSS through the gate's own upstream target, varying ONLY the Host
 * header, and reports what CSS does with each. That answers "would CSS accept the public Host" —
 * the single fact that decides whether this is a config change or a data migration.
 *
 * It changes NO environment variable, deploys nothing, and writes nothing. Flipping
 * `CSS_BASE_URL` on a live single-replica store is not a probe, and 625 pods of existing
 * identifiers minted under the old base are the actual work regardless of what this finds.
 *
 * Run from a machine that can reach the gate. The internal host is not resolvable here, so the
 * probe goes through the gate and varies the Host it forwards where it can.
 *
 * Usage: node tools/probe-css-public-base-url.mjs
 */

const GATE = process.env.CSS_GATE_URL ?? 'https://gate.interego.xwisee.com';
const PUBLIC_HOST = new URL(GATE).host;

const log = (...a) => process.stdout.write(a.map(String).join(' ') + '\n');
const head = (s) => log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 64 - s.length)));

async function probe(label, url, headers) {
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle', ...headers } });
    const body = await r.text();
    const internal = (body.match(/css\.railway\.internal/g) ?? []).length;
    const publicHits = (body.match(new RegExp(PUBLIC_HOST.replace(/\./g, '\\.'), 'g')) ?? []).length;
    log(`  ${label.padEnd(34)} ${r.status}  internal-host IRIs=${internal}  public-host IRIs=${publicHits}`);
    return { status: r.status, internal, publicHits, body };
  } catch (e) {
    log(`  ${label.padEnd(34)} ERR ${String(e.message ?? e).slice(0, 80)}`);
    return null;
  }
}

head('what CSS mints today, read through the gate');
// ★ BOTH OF THESE COME BACK WITH ZERO INTERNAL-HOST IRIs, WHICH IS THE FINDING. CSS serialises
// containment RELATIVELY, so its own emitted triples are not the problem at all. The internal host
// enters through what WE mint: the relay composes `${CSS_URL}${podName}/` and stamps that into
// descriptor URLs, supersedes references and distributions. That makes this a change to our own
// minting rather than to CSS's configuration — a much smaller thing than flipping CSS_BASE_URL.
await probe('GET / (pod listing)', `${GATE}/`);
await probe('GET a pod container', `${GATE}/u-eth-42c2ffd7e4c0/`);

head('does CSS answer at all when the Host is the PUBLIC name?');
// The gate overrides Host on its own upstream hop, so this cannot reach past it from out here —
// what it CAN establish is whether the gate's public surface is what CSS already sees, and whether
// anything in the served bytes is rooted publicly. Reported honestly rather than overclaimed.
await probe('GET / with explicit public Host', `${GATE}/`, { Host: PUBLIC_HOST });

head('what fraction of a real pod index is unreachable from outside');
const m = await probe('a pod manifest', `${GATE}/u-eth-03f52e15b9df/.well-known/context-graphs`);
if (m && m.status === 200) {
  const total = (m.body.match(/https?:\/\//g) ?? []).length;
  const pct = total ? Math.round((m.internal / total) * 100) : 0;
  log(`\n  ${m.internal} of ${total} URLs (${pct}%) name a host that does not resolve outside Railway.`);
}

head('verdict this probe can and cannot give');
log('  CAN establish : what CSS currently mints, and how much of it is internal-rooted.');
log('  CANNOT establish: whether flipping CSS_BASE_URL would work — that needs the gate to send a');
log('                    different upstream Host, which only the gate can do. The next step is a');
log('                    scratch CSS instance or a gate build with the Host configurable per-request,');
log('                    NOT an env flip on the live single-replica store.');
log('');
log('  And regardless of the answer: every identifier already minted carries the old host. A base');
log('  change makes new writes public and leaves old ones stale, which is a mixed corpus — worse');
log('  than a consistent bad one. The migration is the work; the config is the easy part.');
