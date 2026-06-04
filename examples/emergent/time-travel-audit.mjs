/**
 * Interego emergent test — time-travel-audit.
 *
 *   npx tsx examples/emergent/time-travel-audit.mjs
 *
 * What this scenario is
 *   A single auditor publishes a 12-descriptor cg:supersedes chain of
 *   "rate-limit policy" revisions whose effective-at intervals (the
 *   descriptor's validFrom / validUntil) and asserted-at instants (the
 *   provenance generatedAtTime + wall-clock publish order) deliberately
 *   diverge. Some revisions are BACKDATED (asserted late, effective
 *   early — a retroactive correction to an earlier era), some are
 *   FORWARD-DATED (asserted now, effective in the future — a scheduled
 *   policy change). After all 12 are on the pod, an Auditor block
 *   reconstructs the descriptor state as of 8 distinct (query-time,
 *   assertion-horizon) pairs and verifies the bitemporally-correct
 *   version wins each time. The substrate's own discover() effectiveAt
 *   filter is cross-checked against the verifier's reconstruction for
 *   the one case where assertion-horizon = "now" (every descriptor is
 *   already asserted, so the two semantics must agree).
 *
 * Substrate gap surfaced (per the substrate audit)
 *   The existing 9 emergent tests record heartbeats and snapshots over
 *   time, but none of them ever QUERY the past. matchesFilter()'s
 *   effective-at predicate interacting with supersedes-chain walking is
 *   completely unexercised, and bitemporal (effective-at vs asserted-at)
 *   is the most common silent-bug surface in CRDT-style stores. A wrong
 *   answer here looks correct on the wire — every descriptor is a real
 *   signed publish — but the auditor reads the wrong version of history.
 *   This harness drives both axes simultaneously and fails fast if any
 *   query returns the wrong descriptor.
 *
 * Primitives exercised (from the build spec)
 *   - matchesFilter effective-at predicate
 *   - supersedes chain walk at-time
 *   - bitemporal asserted-at vs effective-at
 *   - discover_context with time filter
 *   - out-of-order publish with backdated effective-at
 *
 * Descriptor chain (12 nodes, strict linear supersedes)
 *   policy-v1  ──cg:supersedes──┐
 *   policy-v2  ─────────────────┤── chain root at v1
 *   …
 *   policy-v12 ─────────────────┘
 *
 *   v6  is a BACKDATE — effective ~45..35 days ago, asserted at step 5
 *   v8  is a BACKDATE — effective ~20..15 days ago, asserted at step 7
 *   v10 is a DEEP BACKDATE — effective ~90..85 days ago, asserted at step 9
 *   v7  is FORWARD-DATED — effective +10..+30 days, asserted at step 6
 *   v9  is FORWARD-DATED — effective +30..+60 days, asserted at step 8
 *   v11 is FORWARD-DATED — effective +60..+90 days, asserted at step 10
 *   v12 SPANS NOW — effective -5..+5 days, asserted last
 *
 * Pass / fail
 *   8 query assertions + chain-integrity + substrate-filter cross-check.
 *   Exits 0 iff all pass; non-zero on any failure with a per-assertion
 *   gap report. $0 cost — no LLM calls anywhere in this file.
 */

import { Wallet, verifyMessage } from 'ethers';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  withTransientRetry,
} from '../../packages/core/dist/index.js';
import {
  loadAgentKeypair,
} from '../../packages/passport/dist/index.js';
import {
  discover,
  fetchGraphContent,
  publish,
} from '../../packages/solid/dist/index.js';

// ── configuration ────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.TTA_DATE ?? new Date().toISOString().slice(0, 10);
const POD = `${CSS}/demos/emergent-time-travel-audit-${SCENARIO_DATE}/`;
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

// Vertical namespace for scenario-specific predicates. Never reuse
// cg:/passport:/registry:/amta: for scenario-only terms — that would
// trip ontology-lint. Vertical prefixes don't require ns declarations.
const SCENARIO_NS = 'https://interego-emergent.example/ns/time-travel-audit#';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── tiny test harness ────────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else {
    fail++;
    const line = detail !== undefined ? `${label} — ${JSON.stringify(detail)}` : label;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}
function h(s) { console.log(`\n${'-'.repeat(72)}\n${s}\n${'-'.repeat(72)}`); }

// ── cleanup: best-effort wipe of prior run's containers ──────────────
// Per the three-runtime-pilgrimage hard-won lesson: 405 (Method Not
// Allowed) is NOT a successful deletion. Treat ONLY 2xx and 404/410 as
// success; verify HEAD shows 404/410 before accepting any other status.
async function deleteIfExists(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (r.status >= 200 && r.status < 205) return true;
    if (r.status === 404 || r.status === 410) return true;
    // 405 or any non-success: confirm the resource is actually gone via HEAD.
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.status === 404 || head.status === 410) return true;
    } catch { /* fall through */ }
    return false;
  } catch {
    return false;
  }
}

async function wipePod(podUrl) {
  // Enumerate via discover() and delete each entry's descriptor + graph,
  // then knock down the manifest and the container itself.
  let entries;
  try { entries = await discover(podUrl); }
  catch { entries = []; }
  for (const e of entries) {
    const graphUrl = e.descriptorUrl?.endsWith('.ttl')
      ? e.descriptorUrl.replace(/\.ttl$/, '-graph.trig')
      : null;
    if (graphUrl) await deleteIfExists(graphUrl);
    if (e.descriptorUrl) await deleteIfExists(e.descriptorUrl);
  }
  await deleteIfExists(`${podUrl}.well-known/context-graphs`);
  await deleteIfExists(`${podUrl}context-graphs/`);
}

// ── identity helpers ─────────────────────────────────────────────────
function didFor(wallet, label) {
  return `did:key:${wallet.address.toLowerCase()}#${label}`;
}

async function signClaim(wallet, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { json, hash, signature };
}

function recoverAddress(payload, signature) {
  const hash = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  return verifyMessage(`sha256:${hash}`, signature).toLowerCase();
}

// ── descriptor authoring ─────────────────────────────────────────────
function policyIri(version) {
  return `${POD}context-graphs/policy-v${version}.ttl#policy-v${version}`;
}

function escapeTurtle(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Publish one policy revision. The interplay this exercises:
 *   - effectiveFrom / effectiveUntil go on the descriptor as
 *     validFrom / validUntil — the manifest mirrors these so the
 *     substrate's matchesFilter.effectiveAt can read them.
 *   - assertedAt goes on the descriptor as provenance.generatedAtTime
 *     AND is embedded in the graph payload as scen:assertedAt — the
 *     auditor reads it from the graph because the manifest does not
 *     mirror it (assertion-horizon filtering is the verifier's job,
 *     not the substrate's discover() filter).
 */
async function publishPolicyVersion({
  wallet, did, version,
  effectiveFrom, effectiveUntil,
  assertedAt, previousDescriptorUrl,
  rateLimit, regime, note,
}) {
  const iri = policyIri(version);

  const versionPayload = {
    iri, did, version,
    effectiveFrom, effectiveUntil, assertedAt,
    rateLimit, regime,
    previousDescriptorUrl: previousDescriptorUrl ?? null,
  };
  const { hash, signature } = await signClaim(wallet, versionPayload);

  const graph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix scen: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a cg:ContextDescriptor, scen:RateLimitPolicy ;
  dcterms:title "Rate-limit policy v${version} (${regime})" ;
  scen:policyVersion ${version} ;
  scen:effectiveFrom "${effectiveFrom}"^^xsd:dateTime ;
  scen:effectiveUntil "${effectiveUntil}"^^xsd:dateTime ;
  scen:assertedAt "${assertedAt}"^^xsd:dateTime ;
  scen:regime "${regime}" ;
  scen:requestsPerMinute ${rateLimit} ;
  scen:note "${escapeTurtle(note)}" ;
  scen:signatureSha256 "${hash}" ;
  scen:walletSignature "${signature}" ;
  prov:wasAttributedTo <${did}> ;
  prov:generatedAtTime "${assertedAt}"^^xsd:dateTime .
`;

  let builder = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    // Effective-at window — also mirrored into the manifest as
    // cg:validFrom / cg:validUntil so the substrate's discover() filter
    // can read it. This is the descriptor's "true in the world" window.
    .temporal({ validFrom: effectiveFrom, validUntil: effectiveUntil })
    .validFrom(effectiveFrom)
    .validUntil(effectiveUntil)
    // Asserted-at — provenance generatedAtTime. Deliberately decoupled
    // from validFrom; the spec's §5.2.2 builder note exists precisely
    // because writers MUST NOT conflate these two.
    .provenance({
      wasAttributedTo: did,
      generatedAtTime: assertedAt,
      wasGeneratedBy: { agent: did, endedAt: assertedAt },
    })
    .agent(did, 'Author')
    .asserted(1.0)
    .selfAsserted(did);
  if (previousDescriptorUrl) builder = builder.supersedes(previousDescriptorUrl);
  const desc = builder.build();

  const result = await withTransientRetry(() =>
    publish(desc, graph.trim(), POD, {
      descriptorSlug: `policy-v${version}`,
      graphSlug: `policy-v${version}-graph`,
    })
  );
  return { ...result, iri, version, effectiveFrom, effectiveUntil, assertedAt, signature, hash };
}

// ── pretty banner ────────────────────────────────────────────────────
console.log('=== Interego emergent test — time-travel-audit ===');
console.log(`   CSS:        ${CSS}`);
console.log(`   pod:        ${POD}`);
console.log(`   manifest:   ${MANIFEST_URL}`);
console.log(`   date:       ${SCENARIO_DATE}`);
console.log(`   $cost:      $0 (no LLM)`);

// ── ACT 0 — substrate liveness + cleanup ─────────────────────────────
h('ACT 0 — verify the CSS pod is reachable + wipe prior run');
let live = false;
try {
  const r = await withTransientRetry(() => fetch(`${CSS}/`, { method: 'HEAD' }));
  live = r.status === 200 || r.status === 204 || r.status === 401 || r.status === 403;
} catch { /* fall through */ }
check(`CSS pod at ${CSS} answers`, live);
if (!live) { console.log('Aborting — substrate is not reachable.'); process.exit(1); }

await wipePod(POD);
console.log('   prior pod state wiped (or absent).');

// ── ACT 1 — mint the auditor identity ────────────────────────────────
h('ACT 1 — mint a single wallet-rooted auditor identity');
const kp = loadAgentKeypair({ envVar: 'TTA_AUDITOR_KEY', label: 'auditor' });
const wallet = kp.source === 'env' ? kp.wallet : Wallet.createRandom();
const DID = didFor(wallet, 'auditor');
console.log(`   wallet:  ${wallet.address}`);
console.log(`   DID:     ${DID}`);
console.log(`   source:  ${kp.source}`);
check('auditor has a real ECDSA wallet + did:key', !!wallet.address && DID.startsWith('did:key:0x'));

// ── ACT 2 — build the 12-revision bitemporal timeline ────────────────
h('ACT 2 — build the 12-revision policy timeline (mixed back/forward dates)');

// Anchor T0 = wall-clock now. All effective windows are expressed in
// days from T0; assertedAt for each row is wall_now + a few seconds so
// the timeline of WHEN each revision became known to the pod is strictly
// monotonic (and we can ask the auditor to filter on "asserted-as-of").
const T0 = Date.now();
const wallStart = T0;
function daysFromT0(d) { return new Date(T0 + d * DAY_MS).toISOString(); }
function secsFromStart(s) { return new Date(wallStart + s * 1000).toISOString(); }

// Plan:
//   effectiveFrom / effectiveUntil are days from T0;
//   assertedAt is the per-row publish instant (seconds from wall start).
//
// Bitemporal trickery:
//   v6 backdates a correction into v2's era (asserted at step 5).
//   v8 backdates a sliver inside v3's era (asserted at step 7).
//   v10 deep-backdates inside v1's era (asserted at step 9).
//   v7, v9, v11 are forward-dated scheduled policies.
//   v12 spans T0 and is the latest assertion overall.
const PLAN = [
  { v: 1,  effDaysFrom: -90, effDaysUntil: -60, assertStepSec: 0,  rate: 60,  regime: 'historical-baseline',  note: 'initial historical baseline policy' },
  { v: 2,  effDaysFrom: -60, effDaysUntil: -30, assertStepSec: 1,  rate: 90,  regime: 'historical-tighten',   note: 'middle historical chunk; tighter limits' },
  { v: 3,  effDaysFrom: -30, effDaysUntil: -10, assertStepSec: 2,  rate: 120, regime: 'recent-past',          note: 'recent past — limit raised after capacity growth' },
  { v: 4,  effDaysFrom: -10, effDaysUntil:   0, assertStepSec: 3,  rate: 150, regime: 'leadin-current',       note: 'lead-in window before current' },
  { v: 5,  effDaysFrom:   0, effDaysUntil:  10, assertStepSec: 4,  rate: 180, regime: 'current-baseline',     note: 'current baseline — straight-through-now policy' },
  { v: 6,  effDaysFrom: -45, effDaysUntil: -35, assertStepSec: 5,  rate: 75,  regime: 'BACKDATE-into-v2-era', note: 'retroactive correction overlapping v2 effective window' },
  { v: 7,  effDaysFrom:  10, effDaysUntil:  30, assertStepSec: 6,  rate: 200, regime: 'forward-near',         note: 'scheduled near-future bump after current expires' },
  { v: 8,  effDaysFrom: -20, effDaysUntil: -15, assertStepSec: 7,  rate: 130, regime: 'BACKDATE-into-v3-era', note: 'narrow retroactive correction inside v3 window' },
  { v: 9,  effDaysFrom:  30, effDaysUntil:  60, assertStepSec: 8,  rate: 220, regime: 'forward-mid',          note: 'scheduled mid-future bump' },
  { v: 10, effDaysFrom: -90, effDaysUntil: -85, assertStepSec: 9,  rate: 50,  regime: 'DEEP-BACKDATE-v1-era', note: 'deep retroactive correction at start of v1 window' },
  { v: 11, effDaysFrom:  60, effDaysUntil:  90, assertStepSec: 10, rate: 240, regime: 'forward-far',          note: 'scheduled far-future bump' },
  { v: 12, effDaysFrom:  -5, effDaysUntil:   5, assertStepSec: 11, rate: 175, regime: 'now-spanning',         note: 'latest assertion; effective window straddles T0' },
];

const ROWS = PLAN.map(p => ({
  ...p,
  effectiveFrom: daysFromT0(p.effDaysFrom),
  effectiveUntil: daysFromT0(p.effDaysUntil),
  assertedAt: secsFromStart(p.assertStepSec),
}));
for (const r of ROWS) {
  console.log(`   v${String(r.v).padStart(2)}  eff[${r.effDaysFrom.toString().padStart(4)}d, ${r.effDaysUntil.toString().padStart(4)}d]  asserted@+${r.assertStepSec}s  rate=${r.rate}  ${r.regime}`);
}

// ── ACT 3 — publish all 12 in wall-clock order ───────────────────────
h('ACT 3 — publish 12 policy revisions in wall-clock order (supersedes-linked)');
const published = [];
let previousUrl = null;
for (const r of ROWS) {
  const out = await publishPolicyVersion({
    wallet, did: DID,
    version: r.v,
    effectiveFrom: r.effectiveFrom,
    effectiveUntil: r.effectiveUntil,
    assertedAt: r.assertedAt,
    previousDescriptorUrl: previousUrl,
    rateLimit: r.rate,
    regime: r.regime,
    note: r.note,
  });
  published.push({ ...out, row: r });
  previousUrl = out.descriptorUrl;
  console.log(`   v${String(r.v).padStart(2)} -> ${out.descriptorUrl}`);
}
check('all 12 policy revisions published successfully',
  published.length === 12 && published.every(p => !!p.descriptorUrl));

// ── ACT 4 — re-discover the manifest and verify chain integrity ──────
h('ACT 4 — re-discover manifest and verify supersedes chain integrity');
const manifestEntries = await discover(POD);
const ourUrls = new Set(published.map(p => p.descriptorUrl));
const ourEntries = manifestEntries.filter(e => ourUrls.has(e.descriptorUrl));
check('manifest carries all 12 ManifestEntry rows after publishing',
  ourEntries.length === 12,
  { found: ourEntries.length, total: manifestEntries.length });

// Verify the manifest mirrors validFrom / validUntil exactly — this is
// what matchesFilter.effectiveAt will read.
const entryByVersion = new Map();
for (const e of ourEntries) {
  const m = e.descriptorUrl.match(/policy-v(\d+)\.ttl/);
  if (m) entryByVersion.set(Number(m[1]), e);
}
let mirroredOk = true;
for (const r of ROWS) {
  const e = entryByVersion.get(r.v);
  if (!e || e.validFrom !== r.effectiveFrom || e.validUntil !== r.effectiveUntil) {
    mirroredOk = false;
    break;
  }
}
check('manifest mirrors validFrom / validUntil verbatim for every revision (substrate effective-at filter has correct input)',
  mirroredOk);

// supersedes chain in the manifest — every v(n) for n>1 must declare
// supersedes pointing at v(n-1)'s descriptor URL.
let chainOk = true;
for (let i = 1; i < ROWS.length; i++) {
  const e = entryByVersion.get(ROWS[i].v);
  const prevUrl = published[i - 1].descriptorUrl;
  if (!e?.supersedes || !e.supersedes.includes(prevUrl)) {
    chainOk = false;
    break;
  }
}
check('manifest mirrors cg:supersedes pointing at the immediate predecessor for v2..v12',
  chainOk);

// ── ACT 5 — auditor builds the bitemporal index from graph payloads ──
h('ACT 5 — auditor reads every graph + extracts (effectiveFrom, effectiveUntil, assertedAt)');

// The manifest mirrors effective-at but NOT assertion-horizon. The
// auditor's job is to pull assertedAt out of each graph payload and
// build the bitemporal index. We do NOT use the in-memory PLAN object
// here — the index is reconstructed end-to-end from the pod's wire form,
// so the assertions below would fail if any field failed to round-trip.
async function fetchGraphAndExtract(descriptorUrl) {
  const graphUrl = descriptorUrl.replace(/\.ttl$/, '-graph.trig');
  const res = await fetchGraphContent(graphUrl);
  if (!res.content) return null;
  const body = res.content;
  const grab = (re) => {
    const m = body.match(re);
    return m ? m[1] : null;
  };
  return {
    descriptorUrl,
    graphUrl,
    effectiveFrom: grab(/scen:effectiveFrom\s+"([^"]+)"/),
    effectiveUntil: grab(/scen:effectiveUntil\s+"([^"]+)"/),
    assertedAt: grab(/scen:assertedAt\s+"([^"]+)"/),
    version: Number(grab(/scen:policyVersion\s+(\d+)/)),
    rate: Number(grab(/scen:requestsPerMinute\s+(\d+)/)),
    regime: grab(/scen:regime\s+"([^"]+)"/),
    signatureSha256: grab(/scen:signatureSha256\s+"([^"]+)"/),
    walletSignature: grab(/scen:walletSignature\s+"([^"]+)"/),
  };
}

const indexed = [];
for (const p of published) {
  const idx = await fetchGraphAndExtract(p.descriptorUrl);
  if (idx) indexed.push(idx);
}
check('auditor fetches all 12 graph payloads and extracts the bitemporal fields end-to-end',
  indexed.length === 12
    && indexed.every(i => i.effectiveFrom && i.effectiveUntil && i.assertedAt
                       && Number.isFinite(i.version) && Number.isFinite(i.rate)));

// Cross-check ONE signed payload to prove the wallet signature
// round-trips through Turtle (catches any quoting/escape regression in
// the audit trail — a real auditor must be able to recompute this).
{
  const sample = indexed.find(i => i.version === 6); // pick a backdate row
  const planRow = ROWS.find(r => r.v === 6);
  const recoveredPayload = {
    iri: policyIri(6),
    did: DID,
    version: 6,
    effectiveFrom: planRow.effectiveFrom,
    effectiveUntil: planRow.effectiveUntil,
    assertedAt: planRow.assertedAt,
    rateLimit: planRow.rate,
    regime: planRow.regime,
    previousDescriptorUrl: published[4].descriptorUrl, // v5
  };
  const recoveredAddr = recoverAddress(recoveredPayload, sample.walletSignature);
  check('signed payload on a BACKDATED revision (v6) recovers to the auditor\'s wallet address',
    recoveredAddr === wallet.address.toLowerCase(),
    { recoveredAddr, expected: wallet.address.toLowerCase() });
}

// ── ACT 6 — define bitemporal verifier ───────────────────────────────
// Given a query time T and an assertion horizon H (an instant), return
// the policy whose effective-at window contains T AND was asserted on
// or before H, choosing the latest assertedAt among the candidates.
// This is the textbook bitemporal "as of (effective T, asserted H)"
// query — supersedes-chain order is IRRELEVANT here; assertion order is
// what tie-breaks overlapping effective windows.
function bitemporalAnswer(index, T, H) {
  const candidates = index.filter(i =>
    i.effectiveFrom <= T && T <= i.effectiveUntil && i.assertedAt <= H);
  if (candidates.length === 0) return null;
  // Latest asserted wins. Stable sort by assertedAt desc, then version desc.
  candidates.sort((a, b) => {
    if (a.assertedAt !== b.assertedAt) return a.assertedAt < b.assertedAt ? 1 : -1;
    return b.version - a.version;
  });
  return candidates[0];
}

// ── ACT 7 — the 8 bitemporal queries ─────────────────────────────────
h('ACT 7 — 8 bitemporal queries (effective-at × asserted-at)');

const ALL_ASSERTED = secsFromStart(60); // a horizon well past every assertedAt
const QUERIES = [
  // Q1: query in v1's window, assertion horizon = all known.
  {
    label: 'Q1: T=-75d, H=all-known  ->  v1 (pure historical, no overlap)',
    T: daysFromT0(-75), H: ALL_ASSERTED, expectedVersion: 1,
  },
  // Q2: same effective T, but assertion horizon BEFORE v10 was asserted.
  // v10's window is [-90, -85] — does not contain -75 — so the horizon
  // doesn't actually change the answer here. This pins the no-leak property.
  {
    label: 'Q2: T=-75d, H=before-v10  ->  v1 (no future-asserted leak)',
    T: daysFromT0(-75), H: secsFromStart(2.5), expectedVersion: 1,
  },
  // Q3: -40d falls inside v2 [-60,-30] AND v6 [-45,-35] (backdate).
  // With horizon = all known, v6 (asserted later) must win.
  {
    label: 'Q3: T=-40d, H=all-known  ->  v6 (backdate wins over v2 by later assertion)',
    T: daysFromT0(-40), H: ALL_ASSERTED, expectedVersion: 6,
  },
  // Q4: same effective T, but assertion horizon BEFORE v6 was asserted.
  // Backdate must not leak — v2 is the correct answer.
  {
    label: 'Q4: T=-40d, H=before-v6   ->  v2 (backdate v6 not yet asserted)',
    T: daysFromT0(-40), H: secsFromStart(4.5), expectedVersion: 2,
  },
  // Q5: -17d falls inside v3 [-30,-10] AND v8 [-20,-15] (backdate).
  // v8 asserted later -> v8 wins.
  {
    label: 'Q5: T=-17d, H=all-known  ->  v8 (later-asserted backdate wins inside v3)',
    T: daysFromT0(-17), H: ALL_ASSERTED, expectedVersion: 8,
  },
  // Q6: T0 (today) falls inside v5 [0,10] AND v12 [-5,5]. v12 asserted last.
  {
    label: 'Q6: T=now,   H=all-known  ->  v12 (now-spanning, latest assertion)',
    T: daysFromT0(0), H: ALL_ASSERTED, expectedVersion: 12,
  },
  // Q7: +20d falls inside v7 [10,30] only.
  {
    label: 'Q7: T=+20d, H=all-known  ->  v7 (forward-dated, unique cover)',
    T: daysFromT0(20), H: ALL_ASSERTED, expectedVersion: 7,
  },
  // Q8: +75d falls inside v11 [60,90] only.
  {
    label: 'Q8: T=+75d, H=all-known  ->  v11 (far-forward, unique cover)',
    T: daysFromT0(75), H: ALL_ASSERTED, expectedVersion: 11,
  },
];

console.log('\n   ┌──────┬──────────────────────────────┬──────────┬──────────┬──────────┐');
console.log('   │ #    │ query                        │ expected │ got      │ verdict  │');
console.log('   ├──────┼──────────────────────────────┼──────────┼──────────┼──────────┤');
const queryOutcomes = [];
for (const [i, q] of QUERIES.entries()) {
  const ans = bitemporalAnswer(indexed, q.T, q.H);
  const gotV = ans?.version ?? null;
  const okQ = gotV === q.expectedVersion;
  queryOutcomes.push({ q, gotV, okQ });
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`   │ Q${i+1}   │ ${pad(q.label.slice(4, 32), 28)} │ v${pad(q.expectedVersion, 7)} │ v${pad(gotV ?? '-', 7)} │ ${okQ ? 'PASS    ' : 'FAIL    '} │`);
  check(q.label, okQ, { got: gotV, expected: q.expectedVersion });
}
console.log('   └──────┴──────────────────────────────┴──────────┴──────────┴──────────┘');

// ── ACT 8 — cross-check against the substrate's discover() filter ───
h('ACT 8 — cross-check verifier vs. discover({ effectiveAt }) at T=now');
// When assertion horizon = "all asserted", the bitemporal answer
// reduces to "the effective-at-T candidate with the latest assertedAt."
// discover()'s effectiveAt filter returns ALL candidates effective at T;
// taking the latest-asserted among them must agree with the verifier.
const filtered = await discover(POD, { effectiveAt: daysFromT0(0) });
const filteredOurs = filtered.filter(e => ourUrls.has(e.descriptorUrl));
// Reduce to (version, descriptorUrl) tuples for stable comparison.
const filteredVersions = filteredOurs.map(e => {
  const m = e.descriptorUrl.match(/policy-v(\d+)\.ttl/);
  return m ? Number(m[1]) : null;
}).filter(v => v !== null).sort((a, b) => a - b);
// At T0, the effective-at window [validFrom <= 0 <= validUntil] covers:
//   v5 [0,10], v12 [-5,5]  (v4 ends at 0, included if endpoint-inclusive)
// matchesFilter is endpoint-inclusive on both ends, so v4 also qualifies.
const expectedAtT0 = filteredVersions; // tautology guard so we display
const substrateLatestAssertedV = (() => {
  // Find which of filtered* is latest-asserted by joining with `indexed`.
  const versSet = new Set(filteredVersions);
  const cands = indexed.filter(i => versSet.has(i.version));
  cands.sort((a, b) => a.assertedAt < b.assertedAt ? 1 : -1);
  return cands[0]?.version ?? null;
})();
console.log(`   discover({ effectiveAt: T0 }) returned versions: [${filteredVersions.join(', ')}]`);
console.log(`   latest-asserted among them: v${substrateLatestAssertedV}`);
const verifierAtT0 = bitemporalAnswer(indexed, daysFromT0(0), ALL_ASSERTED)?.version ?? null;
check('discover()\'s effectiveAt filter + latest-asserted tiebreaker agrees with verifier at T=now',
  substrateLatestAssertedV === verifierAtT0 && verifierAtT0 === 12,
  { substrate: substrateLatestAssertedV, verifier: verifierAtT0 });

// Also: superseded versions stay reachable via explicit as-of URL.
// Pull v3 directly even though v4..v12 supersede it.
{
  const v3Url = published[2].descriptorUrl;
  const r = await fetch(v3Url, { headers: { Accept: 'text/turtle' } });
  const ok = r.ok && (await r.text()).includes('policy-v3');
  check('superseded revision v3 remains directly fetchable by URL (explicit as-of reachability)',
    ok, { status: r.status });
}

// ── ACT 9 — emit a verdict descriptor back to the pod ────────────────
h('ACT 9 — Auditor publishes a scen:Verdict descriptor summarizing findings');
const verdictIri = `${POD}context-graphs/verdict.ttl#verdict-${SCENARIO_DATE}`;
const verdictGraph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix scen: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${verdictIri}> a cg:ContextDescriptor, scen:Verdict ;
  dcterms:title "Time-travel audit verdict (${SCENARIO_DATE})" ;
  scen:passCount ${pass} ;
  scen:failCount ${fail} ;
  scen:queryCount ${QUERIES.length} ;
  scen:revisionCount 12 ;
  scen:summaryJson "${escapeTurtle(JSON.stringify({
    pass, fail,
    queries: queryOutcomes.map(o => ({
      label: o.q.label, expected: o.q.expectedVersion, got: o.gotV, ok: o.okQ,
    })),
  }))}" .
`;
try {
  const verdictDesc = ContextDescriptor.create(verdictIri)
    .describes(`${verdictIri}-graph`)
    .temporal({ validFrom: new Date().toISOString() })
    .validFrom(new Date().toISOString())
    .provenance({ wasAttributedTo: DID, generatedAtTime: new Date().toISOString() })
    .agent(DID, 'Author')
    .asserted(0.99)
    .selfAsserted(DID)
    .build();
  const verdictPub = await publish(verdictDesc, verdictGraph.trim(), POD, {
    descriptorSlug: 'verdict',
    graphSlug: 'verdict-graph',
  });
  console.log(`   verdict descriptor: ${verdictPub.descriptorUrl}`);
} catch (err) {
  console.log(`   verdict publish FAILED: ${err.message}`);
}

// ── manifest fingerprint for human cold-read auditing ───────────────
h('manifest fingerprint (human cold-read audit hook)');
try {
  const r = await fetch(MANIFEST_URL, { headers: { Accept: 'text/turtle' } });
  if (r.ok) {
    const body = await r.text();
    const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    console.log(`   manifest size:   ${body.length} bytes`);
    console.log(`   manifest sha256: ${digest}...`);
    console.log(`   manifest URL:    ${MANIFEST_URL}`);
    const allReferenced = published.every(p => body.includes(p.descriptorUrl));
    check('every published descriptor URL appears in the manifest body', allReferenced);
  } else {
    check('manifest fetchable for fingerprinting', false, `${r.status} ${r.statusText}`);
  }
} catch (err) {
  check('manifest fetchable for fingerprinting', false, err.message);
}

// ── summary + exit ───────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(`pod for human inspection: ${POD}`);
console.log(`manifest:                 ${MANIFEST_URL}`);

if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail === 1 ? '' : 's'}; details above`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nRESULT: PASS — bitemporal substrate primitives held');
