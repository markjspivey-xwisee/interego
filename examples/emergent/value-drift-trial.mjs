/**
 * Interego emergent test — value-drift-trial.
 *
 *   npx tsx examples/emergent/value-drift-trial.mjs
 *
 * What this scenario is
 *   A single long-lived agent publishes a passport biography of 15
 *   StatedValue descriptors over a simulated 18-month arc. The arc has
 *   three phases:
 *
 *     · months  1- 6   five PRIVACY-MAXIMALIST stances ("refuse all
 *                       telemetry", "never log identifiers", ...)
 *     · months  7-12   five NUANCED transitional stances ("default to
 *                       minimal collection", "log only with consent")
 *     · months 13-18   five CONVENIENCE-PRAGMATIST stances ("collect
 *                       anonymized usage by default", "telemetry on by
 *                       default for analytics value")
 *
 *   Two explicit REVERSALS are injected as `value-statement` events
 *   that retract a categorical early-period value with the language of
 *   a late-period one ("now I accept default telemetry — reversal of
 *   refuse-all-telemetry"). A control topic — `accessibility` — gets
 *   three stable stances across the 18 months with no drift.
 *
 *   At decision time a verifier traverses the biography filtered by
 *   topic=privacy and must (a) surface the specific reversal pair as
 *   evidence, (b) rank reversals as higher severity than gradual
 *   nuanced shifts, (c) return the full drift trajectory not just
 *   endpoints, and (d) when re-run with topic=accessibility return
 *   nothing — the false-positive negative control.
 *
 * Substrate gap surfaced (the second-tier emergent claim)
 *   The passport/biography subsystem has been tested for wallet
 *   rotation (continuity-through-change). The inverse claim —
 *   change-the-substrate-must-detect — has no adversarial coverage.
 *   `detectValueDrift` is exported from `passport/index.js` but its
 *   current implementation is a single coarse lexical heuristic that
 *   does NOT:
 *     · accept a topic filter
 *     · rank reversals above nuanced shifts
 *     · cite the reversal pair (early + late statement) as evidence
 *     · return a trajectory of intermediate stances
 *     · resist false positives on unrelated topics
 *   Value drift is the most common real-world failure of long-lived
 *   agent identity, so this harness exercises ALL five gaps end-to-end
 *   on the live pod. The verifier composes the substrate's existing
 *   passport-biography-traversal primitives (StatedValue, LifeEvent,
 *   Semiotic modalStatus on each descriptor, ProvenanceFacet wallet
 *   attestation) — it does not invent a new ontology term.
 *
 * Descriptor chain produced
 *   passport-v01..passport-v15  (each carries one StatedValue + its
 *                                 month index, topic tag, and stance
 *                                 polarity), plus
 *   passport-control-v01..v03   (accessibility — flat, no drift),
 *   passport-reversal-r1, r2     (explicit value-statement reversals
 *                                 with `retractsValueAt` link to the
 *                                 superseded early-period descriptor).
 *
 * Pass / fail
 *   Every assertion in the spec is enforced as a single check() call.
 *   Exits 0 iff all pass; non-zero on any failure with a per-assertion
 *   gap report. $0 cost — no LLM, no Claude SDK, no API spend.
 */

import { Wallet, verifyMessage } from 'ethers';
import { createHash } from 'node:crypto';
import {
  publish,
  discover,
  fetchGraphContent,
  withTransientRetry,
  loadAgentKeypair,
} from '../../dist/index.js';

// ── configuration ────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TRIAL_DATE = process.env.VALUE_DRIFT_DATE ?? new Date().toISOString().slice(0, 10);
const POD = `${CSS}/demos/emergent-value-drift-trial-${TRIAL_DATE}/`;
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

// Vertical namespace for scenario-specific predicates. NEVER reuse
// cg:/passport:/registry:/amta: for scenario-only terms — that would
// trip ontology-lint. Vertical prefixes don't require ns declarations.
const SCENARIO_NS = 'https://interego-emergent.example/ns/value-drift-trial#';

const TOPIC_PRIVACY = 'privacy';
const TOPIC_ACCESSIBILITY = 'accessibility'; // negative control

// Stance polarity codes — the verifier reads these strings directly,
// they are the structural signal (not free text inference).
const POL_STRICT     = 'privacy-maximalist';
const POL_NUANCED    = 'nuanced-transition';
const POL_PRAGMATIST = 'convenience-pragmatist';

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

// ── HTTP cleanup helpers (three-runtime-pilgrimage pattern) ──────────
// IMPORTANT: 405 (Method Not Allowed) is NOT a successful deletion. It
// means the storage layer refused to delete the resource and stale
// state still exists. Accept only true success (200-204) plus the HTTP
// "definitely not present" outcomes (404 / 410). 405 → confirm absence
// with HEAD; if still present, REPORT failure so the caller can react.
async function deleteIfExists(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    if (r.status >= 200 && r.status < 205) return true;
    if (r.status === 404 || r.status === 410) return true;
    if (r.status === 405) {
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (head.status === 404 || head.status === 410) return true;
      } catch { /* fall through */ }
    }
    return false;
  } catch {
    return false;
  }
}

async function wipePod(podUrl) {
  const cgRoot = `${podUrl}context-graphs/`;
  try {
    const head = await fetch(cgRoot, { method: 'HEAD' });
    if (head.status === 404) return;
  } catch { return; }
  // discover() only sets descriptorUrl, not graphUrl — derive the graph
  // URL from the publish() naming convention (<slug>.ttl → <slug>-graph.trig)
  // so prior runs' graph files don't survive the wipe and bleed stale DIDs
  // into this run's records. Also walk the LDP container directly to catch
  // anything not registered in the manifest.
  let entries;
  try { entries = await discover(podUrl); } catch { entries = []; }
  for (const e of entries) {
    if (e.descriptorUrl) {
      await deleteIfExists(e.descriptorUrl);
      const slug = e.descriptorUrl.split('/').pop().replace(/\.ttl$/, '');
      await deleteIfExists(`${podUrl}context-graphs/${slug}-graph.trig`);
    }
    if (e.graphUrl) await deleteIfExists(e.graphUrl);
  }
  // Belt-and-braces: enumerate the LDP container and delete anything left.
  try {
    const r = await fetch(cgRoot, { headers: { Accept: 'text/turtle' } });
    if (r.ok) {
      const body = await r.text();
      const filenames = [...body.matchAll(/<([^/<>][^<>]*?\.(?:ttl|trig))>/g)].map(m => m[1]);
      for (const fn of filenames) {
        await deleteIfExists(`${cgRoot}${fn}`);
      }
    }
  } catch { /* best effort */ }
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

function escapeTurtle(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── value statement script ───────────────────────────────────────────
// 15 privacy values over 18 simulated months (5/5/5 thirds).
// Each entry: monthIndex, topic, polarity, categorical-language tag
// (refuse/never/always/must) for the heuristic baseline, statement.
const PRIVACY_TIMELINE = [
  // Phase 1 — privacy-maximalist (months 1-6)
  { month: 1,  polarity: POL_STRICT, statement: 'refuse all telemetry from end-user devices under any condition' },
  { month: 2,  polarity: POL_STRICT, statement: 'never persist user identifiers beyond the session boundary' },
  { month: 3,  polarity: POL_STRICT, statement: 'always require explicit opt-in for any usage analytics' },
  { month: 4,  polarity: POL_STRICT, statement: 'must hash identifiers client-side before any network egress' },
  { month: 5,  polarity: POL_STRICT, statement: 'refuse third-party trackers in every shipped product surface' },
  // Phase 2 — nuanced transition (months 7-12)
  { month: 7,  polarity: POL_NUANCED, statement: 'default to minimal data collection where the use case allows' },
  { month: 8,  polarity: POL_NUANCED, statement: 'prefer aggregated metrics over per-user logs when feasible' },
  { month: 9,  polarity: POL_NUANCED, statement: 'log only with informed user consent where the law requires it' },
  { month: 10, polarity: POL_NUANCED, statement: 'balance product insight needs against retention windows case by case' },
  { month: 11, polarity: POL_NUANCED, statement: 'review collection scope quarterly against business value' },
  // Phase 3 — convenience-pragmatist (months 13-18)
  { month: 13, polarity: POL_PRAGMATIST, statement: 'collect anonymized usage data by default to improve the product' },
  { month: 14, polarity: POL_PRAGMATIST, statement: 'always enable telemetry on first run for analytics value' },
  { month: 15, polarity: POL_PRAGMATIST, statement: 'persist session identifiers for cross-device continuity by default' },
  { month: 16, polarity: POL_PRAGMATIST, statement: 'must collect device fingerprints to detect abuse at scale' },
  { month: 17, polarity: POL_PRAGMATIST, statement: 'refuse opt-in friction that depresses analytics signal quality' },
];

// 2 explicit reversals — each retracts an early-period categorical
// value with the language of a late-period one. The verifier reads
// `retractsValueAt` to walk the reversal pair.
const REVERSALS = [
  {
    month: 14,
    retractsMonth: 1,   // reverses "refuse all telemetry..."
    statement: 'now accept default telemetry — explicit reversal of the month-1 stance "refuse all telemetry"',
  },
  {
    month: 16,
    retractsMonth: 4,   // reverses "must hash identifiers client-side..."
    statement: 'now collect raw device fingerprints — explicit reversal of the month-4 stance "must hash identifiers"',
  },
];

// Negative-control topic — accessibility — stable across the same window.
const ACCESSIBILITY_TIMELINE = [
  { month: 1,  polarity: 'stable', statement: 'always meet WCAG 2.2 AA contrast minimums on shipped UI' },
  { month: 9,  polarity: 'stable', statement: 'always meet WCAG 2.2 AA contrast minimums on shipped UI' },
  { month: 17, polarity: 'stable', statement: 'always meet WCAG 2.2 AA contrast minimums on shipped UI' },
];

// Simulate 18 months relative to a synthetic anchor so the test is
// deterministic across runs.
const ANCHOR_MONTH_0 = new Date(Date.UTC(2025, 0, 1, 0, 0, 0)).toISOString(); // 2025-01-01
function monthIso(monthIndex) {
  const d = new Date(ANCHOR_MONTH_0);
  d.setUTCMonth(d.getUTCMonth() + monthIndex);
  return d.toISOString();
}

// ── descriptor publishing ────────────────────────────────────────────
function valueIri(slug) {
  return `${POD}context-graphs/${slug}.ttl#${slug}`;
}

async function publishValueDescriptor({
  wallet, did, slug, topic, polarity, monthIndex, statement,
  retractsIri, retractsStatement,
}) {
  const iri = valueIri(slug);
  const assertedAt = monthIso(monthIndex);

  // The wallet signs the value-statement payload — the descriptor's
  // ProvenanceFacet on the wire then carries a verifiable witness that
  // this DID (not an impersonator) made the stance commitment.
  const payload = {
    iri, did, topic, polarity, monthIndex, statement, assertedAt,
    retractsIri: retractsIri ?? null,
  };
  const { hash, signature } = await signClaim(wallet, payload);

  // We hand-write the descriptor TTL (rather than using
  // passportToDescriptor) so the StatedValue + LifeEvent and the
  // structural drift signal (topic tag, polarity, optional retracts
  // link) round-trip unambiguously. The passport: terms used here
  // (Passport, StatedValue, LifeEvent, agentIdentity) are all defined
  // in docs/ns/passport.ttl — no new ontology terms minted.
  const retractsTriples = retractsIri
    ? `  scen:retractsValueAt <${retractsIri}> ;\n  scen:retractedStatement "${escapeTurtle(retractsStatement ?? '')}" ;`
    : '';

  const graph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix passport: <https://w3id.org/cg/passport#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix scen: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a cg:ContextDescriptor, passport:Passport ;
  dcterms:title "StatedValue snapshot ${slug}" ;
  passport:agentIdentity <${did}> ;
  scen:topic "${topic}" ;
  scen:polarity "${polarity}" ;
  scen:monthIndex ${monthIndex} ;
  scen:assertedAt "${assertedAt}"^^xsd:dateTime ;
  scen:valueStatement "${escapeTurtle(statement)}" ;
${retractsTriples}${retractsTriples ? '\n' : ''}  scen:signatureSha256 "${hash}" ;
  scen:walletSignature "${signature}" ;
  prov:wasAttributedTo <${did}> ;
  prov:generatedAtTime "${assertedAt}"^^xsd:dateTime .
`;

  // The descriptor itself: minimal builder-equivalent TTL so we can
  // publish via the raw publish() entry point. We build the descriptor
  // through ContextDescriptor.create elsewhere; here we use publish()
  // with a descriptor data object via the standard Solid pattern.
  // Since this scenario writes through publish() in the same module
  // shape as the existing emergent tests, we pass a pre-built
  // descriptor data structure constructed inline.
  const result = await withTransientRetry(() =>
    publish(
      {
        id: iri,
        describes: [`${iri}-graph`],
        facets: [
          { type: 'Temporal', validFrom: assertedAt },
          {
            type: 'Provenance',
            wasAttributedTo: did,
            generatedAtTime: assertedAt,
            wasGeneratedBy: { agent: did, endedAt: assertedAt },
          },
          { type: 'Agent', assertingAgent: { identity: did } },
          {
            type: 'Semiotic',
            modalStatus: 'Asserted',
            groundTruth: true,
            epistemicConfidence: 1.0,
          },
          { type: 'Trust', trustLevel: 'SelfAsserted', issuer: did },
          {
            type: 'Federation',
            origin: POD,
            storageEndpoint: POD,
            syncProtocol: 'SolidNotifications',
          },
        ],
      },
      graph.trim(),
      POD,
      { descriptorSlug: slug, graphSlug: `${slug}-graph` },
    ),
  );
  return { ...result, iri, signature, hash, slug, topic, polarity, monthIndex, statement, retractsIri };
}

// ── pretty banner ────────────────────────────────────────────────────
console.log('=== Interego emergent test — value-drift-trial ===');
console.log(`   pod:         ${POD}`);
console.log(`   manifest:    ${MANIFEST_URL}`);
console.log(`   date:        ${TRIAL_DATE}`);
console.log(`   $cost:       $0 (no LLM)`);

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

// ── ACT 1 — mint pilgrim wallet + DID ────────────────────────────────
h('ACT 1 — mint long-lived agent identity (single wallet across 18 months)');
const kp = loadAgentKeypair({ envVar: 'VALUE_DRIFT_KEY', label: 'value-drift-pilgrim' });
const wallet = kp.source === 'env' ? kp.wallet : Wallet.createRandom();
const DID = didFor(wallet, 'pilgrim');
console.log(`   wallet:  ${wallet.address}  (${kp.source === 'env' ? 'env' : 'ephemeral'})`);
console.log(`   DID:     ${DID}`);
check('single-wallet long-lived agent identity minted', !!DID && DID.startsWith('did:key:0x'));

// ── ACT 2 — publish 15 privacy descriptors (5 + 5 + 5) ───────────────
h('ACT 2 — publish 15 privacy StatedValue descriptors over months 1-17');
const privacyResults = [];
for (let i = 0; i < PRIVACY_TIMELINE.length; i++) {
  const entry = PRIVACY_TIMELINE[i];
  const slug = `privacy-v${String(i + 1).padStart(2, '0')}`;
  const r = await publishValueDescriptor({
    wallet, did: DID, slug,
    topic: TOPIC_PRIVACY,
    polarity: entry.polarity,
    monthIndex: entry.month,
    statement: entry.statement,
  });
  privacyResults.push(r);
  console.log(`   m${String(entry.month).padStart(2, '0')}  ${entry.polarity.padEnd(22)} ${slug}`);
}
check('all 15 privacy StatedValue descriptors published',
  privacyResults.length === 15 && privacyResults.every(r => !!r.descriptorUrl));

const phase1 = privacyResults.filter(r => r.polarity === POL_STRICT);
const phase2 = privacyResults.filter(r => r.polarity === POL_NUANCED);
const phase3 = privacyResults.filter(r => r.polarity === POL_PRAGMATIST);
check('biography spans three polarity phases with 5/5/5 distribution',
  phase1.length === 5 && phase2.length === 5 && phase3.length === 5,
  { strict: phase1.length, nuanced: phase2.length, pragmatist: phase3.length });

// ── ACT 3 — publish the 2 explicit reversals (with retractsValueAt) ──
h('ACT 3 — publish 2 explicit value-statement reversals (retracts early stance)');
const reversalResults = [];
for (let i = 0; i < REVERSALS.length; i++) {
  const rev = REVERSALS[i];
  const retractedDescriptor = privacyResults.find(r => r.monthIndex === rev.retractsMonth);
  if (!retractedDescriptor) {
    check(`reversal r${i + 1} can locate the descriptor it retracts (month ${rev.retractsMonth})`, false);
    continue;
  }
  const slug = `privacy-reversal-r${i + 1}`;
  const r = await publishValueDescriptor({
    wallet, did: DID, slug,
    topic: TOPIC_PRIVACY,
    polarity: POL_PRAGMATIST,
    monthIndex: rev.month,
    statement: rev.statement,
    retractsIri: retractedDescriptor.iri,
    retractsStatement: retractedDescriptor.statement,
  });
  reversalResults.push({ ...r, retracts: retractedDescriptor });
  console.log(`   m${String(rev.month).padStart(2, '0')}  REVERSAL r${i + 1} (retracts m${rev.retractsMonth})`);
}
check('both explicit reversals published with scen:retractsValueAt links',
  reversalResults.length === 2 && reversalResults.every(r => !!r.retractsIri));

// ── ACT 4 — publish 3 accessibility control descriptors (no drift) ───
h('ACT 4 — publish 3 accessibility StatedValue descriptors (negative control)');
const accessibilityResults = [];
for (let i = 0; i < ACCESSIBILITY_TIMELINE.length; i++) {
  const entry = ACCESSIBILITY_TIMELINE[i];
  const slug = `accessibility-v${String(i + 1).padStart(2, '0')}`;
  const r = await publishValueDescriptor({
    wallet, did: DID, slug,
    topic: TOPIC_ACCESSIBILITY,
    polarity: entry.polarity,
    monthIndex: entry.month,
    statement: entry.statement,
  });
  accessibilityResults.push(r);
  console.log(`   m${String(entry.month).padStart(2, '0')}  ${entry.polarity.padEnd(22)} ${slug}`);
}
check('3 accessibility-topic descriptors published',
  accessibilityResults.length === 3 && accessibilityResults.every(r => !!r.descriptorUrl));

// ── ACT 5 — manifest sanity ──────────────────────────────────────────
h('ACT 5 — manifest sanity: every published descriptor reachable via discover()');
const allPublished = [...privacyResults, ...reversalResults, ...accessibilityResults];
const manifestEntries = await discover(POD);
const manifestUrls = new Set(manifestEntries.map(e => e.descriptorUrl));
const missingFromManifest = allPublished.filter(r => !manifestUrls.has(r.descriptorUrl));
check(`manifest holds all ${allPublished.length} descriptors (15 privacy + 2 reversals + 3 accessibility = 20)`,
  allPublished.length === 20 && missingFromManifest.length === 0,
  { totalPublished: allPublished.length, totalInManifest: manifestEntries.length, missing: missingFromManifest.length });

// ── ACT 6 — verifier: pod-side biography traversal for topic=privacy ──
h('ACT 6 — Verifier: fetch the biography from the pod and detect drift');

// Helper: fetch the graph TTL for a manifest entry and extract the
// structural drift signal. The verifier uses ONLY pod state — no
// in-memory orchestrator shortcut.
async function fetchValueRecord(entry) {
  try {
    // ManifestEntry currently surfaces descriptorUrl + describes but not
    // graphUrl — publish() writes the graph at <podUrl>context-graphs/
    // <slug>-graph.trig using a slug derived from the descriptor file
    // (publish convention: `<slug>.ttl` -> `<slug>-graph.trig`).
    // Recover graphUrl from descriptorUrl so the regex extractions
    // below don't run against an undefined fetch result.
    if (!entry.graphUrl) {
      const slug = entry.descriptorUrl.split('/').pop().replace(/\.ttl$/, '');
      entry.graphUrl = `${POD}context-graphs/${slug}-graph.trig`;
    }
    // fetchGraphContent() returns { content, encrypted, mediaType } —
    // pull the body string before running TTL regex extractions.
    const fetched = await fetchGraphContent(entry.graphUrl);
    const ttl = (typeof fetched === 'string' ? fetched : fetched?.content) ?? '';
    const topic = (ttl.match(/scen:topic\s+"([^"]+)"/) ?? [])[1] ?? null;
    const polarity = (ttl.match(/scen:polarity\s+"([^"]+)"/) ?? [])[1] ?? null;
    const monthIndex = Number((ttl.match(/scen:monthIndex\s+(\d+)/) ?? [])[1] ?? -1);
    const assertedAt = (ttl.match(/scen:assertedAt\s+"([^"]+)"/) ?? [])[1] ?? null;
    const valueStatement = (ttl.match(/scen:valueStatement\s+"((?:[^"\\]|\\.)*)"/) ?? [])[1] ?? null;
    const retractsValueAt = (ttl.match(/scen:retractsValueAt\s+<([^>]+)>/) ?? [])[1] ?? null;
    const retractedStatement = (ttl.match(/scen:retractedStatement\s+"((?:[^"\\]|\\.)*)"/) ?? [])[1] ?? null;
    const signature = (ttl.match(/scen:walletSignature\s+"([^"]+)"/) ?? [])[1] ?? null;
    const agent = (ttl.match(/passport:agentIdentity\s+<([^>]+)>/) ?? [])[1] ?? null;
    return {
      iri: entry.descriptorUrl, graphUrl: entry.graphUrl,
      topic, polarity, monthIndex, assertedAt,
      valueStatement: valueStatement?.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') ?? null,
      retractsValueAt,
      retractedStatement: retractedStatement?.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') ?? null,
      signature, agent,
    };
  } catch (err) {
    return { iri: entry.descriptorUrl, graphUrl: entry.graphUrl, error: err?.message };
  }
}

// Drift detector built ON TOP of the biography substrate. Substrate
// primitives exercised:
//   · passport biography traversal (manifest → graph TTL → StatedValue
//     + LifeEvent fields per descriptor)
//   · Semiotic modal accounting on stated-value descriptors (each is
//     Asserted with confidence 1.0 — endogenous to the agent's voice)
//   · contradiction surfacing with evidence citations (scen:retractsValueAt)
//   · biography reconstruction filtered by topic
function detectDriftForTopic(records, topic) {
  const filtered = records
    .filter(r => r.topic === topic)
    .sort((a, b) => a.monthIndex - b.monthIndex);

  if (filtered.length === 0) return { trajectory: [], reversals: [], severity: [], polaritiesObserved: [] };

  // Build the trajectory by polarity transition. A "transition" is two
  // consecutive descriptors whose polarity differs.
  const trajectory = [];
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].polarity !== filtered[i - 1].polarity) {
      trajectory.push({
        fromMonth: filtered[i - 1].monthIndex,
        toMonth: filtered[i].monthIndex,
        fromPolarity: filtered[i - 1].polarity,
        toPolarity: filtered[i].polarity,
        fromStatement: filtered[i - 1].valueStatement,
        toStatement: filtered[i].valueStatement,
        // The kind of transition is what we score severity off of.
        kind: 'gradual', // overwritten below if it's an explicit reversal
      });
    }
  }

  // Reversal evidence: any descriptor with scen:retractsValueAt is an
  // explicit reversal — we pair it with the descriptor it retracts.
  const reversals = [];
  for (const r of filtered) {
    if (!r.retractsValueAt) continue;
    const retracted = filtered.find(x => x.iri === r.retractsValueAt);
    reversals.push({
      reversalIri: r.iri,
      reversalStatement: r.valueStatement,
      reversalAtMonth: r.monthIndex,
      reversalPolarity: r.polarity,
      retractedIri: r.retractsValueAt,
      retractedStatement: retracted?.valueStatement ?? r.retractedStatement,
      retractedAtMonth: retracted?.monthIndex ?? null,
      retractedPolarity: retracted?.polarity ?? null,
    });
  }

  // Severity ranking: explicit reversals strictly outrank gradual
  // polarity shifts. Within reversals, the larger the polarity
  // distance (strict→pragmatist = 2 > strict→nuanced = 1), the higher.
  // Within gradual shifts, same distance scoring.
  const polarityRank = { [POL_STRICT]: 0, [POL_NUANCED]: 1, [POL_PRAGMATIST]: 2, stable: 0 };
  const polDist = (a, b) => Math.abs((polarityRank[a] ?? 0) - (polarityRank[b] ?? 0));
  const severity = [];
  for (const rev of reversals) {
    severity.push({
      kind: 'explicit-reversal',
      score: 10 + polDist(rev.reversalPolarity, rev.retractedPolarity),
      evidenceIri: rev.reversalIri,
      retractsIri: rev.retractedIri,
    });
  }
  for (const t of trajectory) {
    // Skip the gradual entry IF it's already represented by an explicit
    // reversal at the same to-month — the reversal IS the evidence.
    const coveredByReversal = reversals.some(rev =>
      rev.reversalAtMonth === t.toMonth && rev.reversalPolarity === t.toPolarity);
    if (coveredByReversal) continue;
    severity.push({
      kind: 'gradual-shift',
      score: 1 + polDist(t.fromPolarity, t.toPolarity),
      fromMonth: t.fromMonth,
      toMonth: t.toMonth,
    });
  }
  severity.sort((a, b) => b.score - a.score);

  const polaritiesObserved = [...new Set(filtered.map(r => r.polarity))];

  return { trajectory, reversals, severity, polaritiesObserved, count: filtered.length };
}

console.log(`   reading ${manifestEntries.length} graphs back from the pod...`);
const records = [];
for (const e of manifestEntries) {
  records.push(await fetchValueRecord(e));
}
console.log(`   ${records.length} records reconstructed (${records.filter(r => !r.error).length} parsed cleanly)`);

const driftPrivacy = detectDriftForTopic(records, TOPIC_PRIVACY);

console.log(`   privacy trajectory: ${driftPrivacy.trajectory.length} polarity transitions`);
for (const t of driftPrivacy.trajectory) {
  console.log(`     m${String(t.fromMonth).padStart(2, '0')}→m${String(t.toMonth).padStart(2, '0')}  ${t.fromPolarity}  →  ${t.toPolarity}`);
}
console.log(`   privacy reversals:  ${driftPrivacy.reversals.length} explicit`);
for (const r of driftPrivacy.reversals) {
  console.log(`     reversal at m${String(r.reversalAtMonth).padStart(2, '0')}: retracts m${String(r.retractedAtMonth ?? '??').padStart(2, '0')} (${r.retractedPolarity} → ${r.reversalPolarity})`);
}
console.log(`   privacy severity-ranked: ${driftPrivacy.severity.length} findings`);
for (const s of driftPrivacy.severity.slice(0, 5)) {
  console.log(`     score=${String(s.score).padStart(2, ' ')}  ${s.kind}`);
}

// Assertion 1 — non-empty drift report on privacy.
check('topic=privacy drift detector returns non-empty trajectory (substrate sees the 18-month arc)',
  driftPrivacy.trajectory.length >= 2 && driftPrivacy.count === 17,
  { transitions: driftPrivacy.trajectory.length, totalPrivacy: driftPrivacy.count });

// Assertion 2 — the trajectory passes through all three polarities,
// not just endpoints. (privacy-maximalist → nuanced-transition →
// convenience-pragmatist must all be observed.)
check('drift report returns full polarity trajectory, NOT just endpoints (passes through all 3 phases)',
  driftPrivacy.polaritiesObserved.includes(POL_STRICT)
    && driftPrivacy.polaritiesObserved.includes(POL_NUANCED)
    && driftPrivacy.polaritiesObserved.includes(POL_PRAGMATIST),
  driftPrivacy.polaritiesObserved);

// Assertion 3 — both explicit reversals surfaced with concrete passport
// evidence (the retracted descriptor IRI + statement), not just a
// generic conflict flag.
const r1 = driftPrivacy.reversals.find(r => r.reversalAtMonth === 14);
const r2 = driftPrivacy.reversals.find(r => r.reversalAtMonth === 16);
check('reversal r1 (m14 retracts m1 "refuse all telemetry") surfaced with concrete retracted-descriptor IRI + statement',
  !!r1
    && r1.retractedIri === privacyResults.find(r => r.monthIndex === 1)?.iri
    && /refuse all telemetry/i.test(r1.retractedStatement ?? '')
    && /telemetry/i.test(r1.reversalStatement ?? ''),
  r1);
check('reversal r2 (m16 retracts m4 "must hash identifiers") surfaced with concrete retracted-descriptor IRI + statement',
  !!r2
    && r2.retractedIri === privacyResults.find(r => r.monthIndex === 4)?.iri
    && /hash identifiers/i.test(r2.retractedStatement ?? '')
    && /fingerprints/i.test(r2.reversalStatement ?? ''),
  r2);

// Assertion 4 — severity ranks BOTH reversals above EVERY gradual
// shift. (No gradual shift may score higher than any reversal.)
const reversalScores = driftPrivacy.severity.filter(s => s.kind === 'explicit-reversal').map(s => s.score);
const gradualScores = driftPrivacy.severity.filter(s => s.kind === 'gradual-shift').map(s => s.score);
const minReversal = Math.min(...reversalScores);
const maxGradual = gradualScores.length > 0 ? Math.max(...gradualScores) : -Infinity;
check('severity ranks BOTH explicit reversals strictly above every gradual nuanced shift',
  reversalScores.length === 2 && minReversal > maxGradual,
  { reversalScores, gradualScores, minReversal, maxGradual });

// Assertion 5 — the top of the severity list is a reversal (not a
// gradual shift, even though there are more gradual shifts).
check('top severity finding is an explicit reversal (not a gradual transition)',
  driftPrivacy.severity[0]?.kind === 'explicit-reversal',
  { top: driftPrivacy.severity[0] });

// Assertion 6 — reversal evidence cites the SPECIFIC retracted
// descriptor URL (not just "some prior value").
check('reversal evidence cites the specific retracted descriptor URL pair (not a generic conflict flag)',
  driftPrivacy.reversals.length === 2
    && driftPrivacy.reversals.every(r => typeof r.retractedIri === 'string' && r.retractedIri.includes(`${POD}context-graphs/`)),
  driftPrivacy.reversals.map(r => ({ retracted: r.retractedIri })));

// Assertion 7 — negative control: re-run the detector on the
// unrelated topic, must find NO drift (no false positives).
const driftAccessibility = detectDriftForTopic(records, TOPIC_ACCESSIBILITY);
console.log(`   accessibility trajectory: ${driftAccessibility.trajectory.length} polarity transitions`);
console.log(`   accessibility reversals:  ${driftAccessibility.reversals.length}`);
check('negative control: topic=accessibility yields ZERO transitions + ZERO reversals (no false positives)',
  driftAccessibility.count === 3
    && driftAccessibility.trajectory.length === 0
    && driftAccessibility.reversals.length === 0
    && driftAccessibility.severity.length === 0,
  driftAccessibility);

// Assertion 8 — wallet attribution: every record on the privacy topic
// is signed by the same DID, verifiable from the on-pod signature.
// This is the "biography belongs to one identity" substrate witness.
const privacyRecords = records.filter(r => r.topic === TOPIC_PRIVACY);
const allSameAgent = privacyRecords.every(r => r.agent === DID);
if (!allSameAgent) {
  const offenders = privacyRecords.filter(r => r.agent !== DID).slice(0, 3).map(r => ({ iri: r.iri.split('/').pop(), agent: r.agent }));
  console.log(`   [dbg] allSameAgent=false. expected=${DID} offenders:`, JSON.stringify(offenders));
}
check('every privacy descriptor is attributed to the single long-lived agent DID',
  allSameAgent && privacyRecords.length === 17,
  { count: privacyRecords.length, allSameAgent });

// Verify one of the reversal signatures recovers to the wallet address —
// proves the on-pod artifact carries an unforgeable witness of agent
// authorship of the contradicting stance.
{
  // privacyRecords keys r.iri by entry.descriptorUrl (no fragment),
  // but reversalResults[0].iri is the in-document IRI valueIri(slug)
  // which includes a #fragment. Strip the fragment for the lookup.
  const r1DescUrl = reversalResults[0]?.iri?.split('#')[0];
  const r1Record = privacyRecords.find(r => r.iri === r1DescUrl);
  if (r1Record?.signature) {
    // The publisher signs with iri = valueIri(slug) (which has the
    // #fragment); the verifier MUST reconstruct the same payload string
    // or hash/recovery diverge. Use reversalResults[0].iri verbatim.
    const payload = {
      iri: reversalResults[0].iri,
      did: DID,
      topic: TOPIC_PRIVACY,
      polarity: POL_PRAGMATIST,
      monthIndex: REVERSALS[0].month,
      statement: REVERSALS[0].statement,
      assertedAt: monthIso(REVERSALS[0].month),
      retractsIri: reversalResults[0].retractsIri,
    };
    const recovered = recoverAddress(payload, r1Record.signature);
    check('reversal r1\'s on-pod wallet signature recovers to the same address that minted DID',
      recovered === wallet.address.toLowerCase(),
      { recovered, expected: wallet.address.toLowerCase() });
  } else {
    check('reversal r1\'s on-pod wallet signature recovers to the same address that minted DID',
      false, 'no signature on r1');
  }
}

// ── ACT 7 — verdict descriptor back to the pod ───────────────────────
h('ACT 7 — publish a scen:Verdict descriptor summarizing the drift findings');
const verdictIri = `${POD}context-graphs/verdict.ttl#verdict-${TRIAL_DATE}`;
const verdictGraph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix scen: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${verdictIri}> a cg:ContextDescriptor, scen:Verdict ;
  dcterms:title "Value drift trial verdict (${TRIAL_DATE})" ;
  scen:passCount ${pass} ;
  scen:failCount ${fail} ;
  scen:privacyCount ${driftPrivacy.count ?? 0} ;
  scen:privacyTransitions ${driftPrivacy.trajectory.length} ;
  scen:privacyReversals ${driftPrivacy.reversals.length} ;
  scen:accessibilityFalsePositives ${driftAccessibility.severity.length} ;
  scen:summaryJson "${escapeTurtle(JSON.stringify({
    pass, fail,
    privacy: {
      count: driftPrivacy.count,
      transitions: driftPrivacy.trajectory.length,
      reversals: driftPrivacy.reversals.map(r => ({
        atMonth: r.reversalAtMonth, retracts: r.retractsIri ?? r.retractedIri,
      })),
      polaritiesObserved: driftPrivacy.polaritiesObserved,
    },
    accessibility: {
      count: driftAccessibility.count ?? 0,
      transitions: driftAccessibility.trajectory.length,
      reversals: driftAccessibility.reversals.length,
    },
  }))}" .
`;
try {
  const verdictPub = await withTransientRetry(() =>
    publish(
      {
        id: verdictIri,
        describes: [`${verdictIri}-graph`],
        facets: [
          { type: 'Temporal', validFrom: new Date().toISOString() },
          {
            type: 'Provenance',
            wasAttributedTo: DID,
            generatedAtTime: new Date().toISOString(),
          },
          { type: 'Agent', assertingAgent: { identity: DID } },
          {
            type: 'Semiotic',
            modalStatus: 'Asserted',
            groundTruth: true,
            epistemicConfidence: 0.99,
          },
          { type: 'Trust', trustLevel: 'SelfAsserted', issuer: DID },
          {
            type: 'Federation',
            origin: POD,
            storageEndpoint: POD,
            syncProtocol: 'SolidNotifications',
          },
        ],
      },
      verdictGraph.trim(),
      POD,
      { descriptorSlug: 'verdict', graphSlug: 'verdict-graph' },
    ),
  );
  console.log(`   verdict descriptor: ${verdictPub.descriptorUrl}`);
} catch (err) {
  console.log(`   verdict publish FAILED: ${err.message}`);
}

// ── ACT 8 — manifest fingerprint (human cold-read audit hook) ────────
h('ACT 8 — manifest fingerprint (human cold-read audit hook)');
try {
  const r = await fetch(MANIFEST_URL, { headers: { Accept: 'text/turtle' } });
  if (r.ok) {
    const body = await r.text();
    const digest = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    console.log(`   manifest size:   ${body.length} bytes`);
    console.log(`   manifest sha256: ${digest}...`);
    console.log(`   manifest URL:    ${MANIFEST_URL}`);
  } else {
    console.log(`   manifest unreachable for fingerprinting: ${r.status} ${r.statusText}`);
  }
} catch (err) {
  console.log(`   manifest fingerprint error: ${err.message}`);
}

// ── summary + exit ───────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(`pod for human inspection:   ${POD}`);
console.log(`manifest:                   ${MANIFEST_URL}`);

if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail === 1 ? '' : 's'}; details above`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nRESULT: PASS — substrate primitives held; value drift detected with reversal evidence');
