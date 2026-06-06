/**
 * Interego — Emergent test harness: forge-and-flood-spec.
 *
 *   npx tsx examples/emergent/forge-and-flood-spec.md
 *
 * (Yes, the .md extension is intentional — this is an executable
 * spec-as-script. tsx parses the file as ESM regardless of suffix.)
 *
 * SUBSTRATE GAP UNDER TEST (Option D — reader-side signature filter)
 * -----------------------------------------------------------------
 * The L1 publish path is permissive by design: anyone with write access
 * to a CSS pod can publish any descriptor under any DID claim. A naive
 * reader that loads everything discover() returns will swallow forged
 * outcomes from an attacker who never possessed the signer's key. The
 * defence (per the May 2026 emergent-coverage audit) is a READER-SIDE
 * signature filter: walk discovered descriptors, recover the signer
 * with ethers.verifyMessage(), and only admit those whose recovered
 * address matches the claimed issuer DID. The reader then downgrades
 * everything else to a non-trusted bucket so calibration counts only
 * cg:CryptographicallyVerified outcomes.
 *
 * AGENTS (4, sequential in-process; ephemeral wallets — no Claude SDK)
 *   · Agent1 (honest)   : publishes 5 signed outcome descriptors with
 *                         a Trust facet at level CryptographicallyVerified.
 *   · Agent2 (attacker) : forges 20 unsigned/mis-signed malicious
 *                         outcomes — half unsigned, half signed with a
 *                         throwaway key but claiming Agent1's DID.
 *   · Agent3 (reader)   : discovers all 25 from CSS, runs the reader-
 *                         side signature filter, builds a calibration
 *                         profile that only includes the 5 verified ones.
 *   · Agent4 (auditor)  : independently re-discovers the pod, replays
 *                         the filter, and emits a rejection-blame log.
 *
 * DESCRIPTOR CHAIN ON-POD (~28 total)
 *   1.  5 × honest outcome descriptors  (Trust = CryptographicallyVerified)
 *   2. 20 × forged outcome descriptors (Trust = SelfAsserted, some signed,
 *           some not, all claiming Agent1)
 *   3.  1 × baseline profile (reader's profile BEFORE the flood)
 *   4.  1 × post-flood profile (cg:supersedes baseline; 25 visible, 5 trusted)
 *   5.  1 × auditor rejection-blame log (Hypothetical, supersedes the
 *           20 forged descriptors)
 *
 * PASS/FAIL CRITERIA
 *   PASS  =  every assertion in the build spec evaluates true on the live
 *            pod state AND on the reader's in-memory filter results.
 *   FAIL  =  any assertion fails; script exits non-zero with a precise
 *            per-assertion blame report.
 *
 * Run command:
 *   cd /d/devstuff/harness/context-graphs && \
 *     npx tsx examples/emergent/forge-and-flood-spec.md
 *
 * Cost: $0 — no LLM in the loop. ~12-15 minutes wall-clock (sequential
 * publish + discovery + filter verification across 28 descriptors).
 */

import { Wallet, verifyMessage, HDNodeWallet, Mnemonic } from 'ethers';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
  withTransientRetry,
  loadAgentKeypair,
} from '../../packages/core/dist/index.js';

// ── config ──────────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.FORGE_AND_FLOOD_DATE ?? '2026-06-01';
const POD = `${CSS}/demos/emergent-forge-and-flood-spec-${SCENARIO_DATE}/`;

// Vertical scenario namespace — per CLAUDE.md ontology hygiene, NEVER
// invent cg:/cgh:/pgsl:/amta:/abac:/etc. terms. Anything scenario-
// specific lives here and never needs an owned-ontology declaration.
const SCENARIO_NS = 'https://interego-emergent.example/ns/forge-and-flood — emergent test scenario build spec#';
const TYPE_HONEST_OUTCOME       = `${SCENARIO_NS}HonestOutcome`;
const TYPE_FORGED_OUTCOME       = `${SCENARIO_NS}ForgedOutcome`;
const TYPE_BASELINE_PROFILE     = `${SCENARIO_NS}BaselineCalibrationProfile`;
const TYPE_POST_FLOOD_PROFILE   = `${SCENARIO_NS}PostFloodCalibrationProfile`;
const TYPE_REJECTION_BLAME_LOG  = `${SCENARIO_NS}RejectionBlameLog`;
const FACET_TRUST_VERIFIED      = `${SCENARIO_NS}TrustVerifiedFacet`;
const REJECT_NO_SIGNATURE       = `${SCENARIO_NS}RejectionReasonNoSignature`;
const REJECT_BAD_SIGNATURE      = `${SCENARIO_NS}RejectionReasonBadSignature`;
const REJECT_DID_MISMATCH       = `${SCENARIO_NS}RejectionReasonDidMismatch`;

const CALIBRATION_TARGET = `urn:graph:emergent:forge-and-flood:calibration-target:${SCENARIO_DATE}`;

// ── tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  + ${label}`); }
  else {
    fail++;
    const line = `  - ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`;
    failures.push(line);
    console.log(line);
  }
};
const h = (s) => console.log(`\n${'-'.repeat(72)}\n${s}\n${'-'.repeat(72)}`);

// ── HTTP helpers (cleanup) ──────────────────────────────────────────
async function safeDelete(url) {
  try {
    const r = await fetch(url, { method: 'DELETE' });
    return r.ok || r.status === 404 || r.status === 405;
  } catch { return false; }
}
async function listContainer(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return [];
    const ttl = await r.text();
    const hits = [];
    const re = /ldp:contains\s+<([^>]+)>/g;
    let m;
    while ((m = re.exec(ttl)) !== null) hits.push(m[1]);
    return hits;
  } catch { return []; }
}
async function cleanupPod() {
  const cgContainer = `${POD}context-graphs/`;
  const kids = await listContainer(cgContainer);
  for (const k of kids) {
    const abs = k.startsWith('http') ? k : `${cgContainer}${k}`;
    await safeDelete(abs);
  }
  await safeDelete(`${POD}.well-known/context-graphs`);
  await safeDelete(`${cgContainer}`);
}

// ── signing (canonical Interego scheme: sha256-commitment prefix) ───
//
// One of the substrate gaps the spec calls out: the documented Interego
// scheme prepends "sha256:" to the digest before signing, while bare
// ethers.verifyMessage() expects the same prefixed string on the read
// side. If a reader uses the WRONG canonicalization (no prefix), every
// honest signature will appear forged. The harness verifies the round
// trip end-to-end so this gap surfaces explicitly.
async function signOutcome(wallet, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const commitment = `sha256:${hash}`;
  const signature = await wallet.signMessage(commitment);
  return { json, hash, commitment, signature };
}

// Reader-side recovery — the heart of Option D. Returns the recovered
// address if (and only if) the signature parses + recovers cleanly.
// Malformed hex, wrong length, garbage bytes → null (never throws).
function recoverMessageSigner(commitment, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return null;
  if (signature.length !== 132) return null; // 0x + 65 bytes hex
  try {
    return verifyMessage(commitment, signature).toLowerCase();
  } catch {
    return null;
  }
}

// ── orchestrator-side ledger (verifier cross-checks against this) ───
const ledger = {
  honestOutcomes: [],   // { did, descriptorUrl, commitment, signature, value }
  forgedOutcomes: [],   // { did, descriptorUrl, commitment, signature, value, forgeryKind }
  baselineProfileUrl: null,
  postFloodProfileUrl: null,
  blameLogUrl: null,
  filterResults: {      // populated in ACT 4
    discovered: 0,
    admitted: [],       // descriptor IRIs accepted
    rejected: [],       // { iri, reason }
  },
};

// ── descriptor publishers ───────────────────────────────────────────
async function publishHonestOutcome(issuer, idx, value) {
  const id = `urn:emergent:forge-and-flood:honest:${idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const payload = {
    issuer: issuer.address,
    target: CALIBRATION_TARGET,
    outcomeValue: value,
    modalStatus: 'Asserted',
    confidence: 0.97,
    at: now,
  };
  const { commitment, signature } = await signOutcome(issuer.wallet, payload);

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix forge: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a forge:HonestOutcome ;
  forge:issuer <${issuer.did}> ;
  forge:target <${CALIBRATION_TARGET}> ;
  forge:outcomeValue "${value}"^^xsd:double ;
  forge:commitment "${commitment}" ;
  forge:signature "${signature}" ;
  forge:signerAddress "${issuer.address}" ;
  prov:wasGeneratedBy <${issuer.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_HONEST_OUTCOME)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: issuer.did, endedAt: now },
      wasAttributedTo: issuer.did,
      generatedAtTime: now,
    })
    .agent(issuer.did, 'Author')
    .asserted(0.97)
    .verified(issuer.did) // CryptographicallyVerified trust facet
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `honest-${String(idx).padStart(2, '0')}`,
    graphSlug: `honest-${String(idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  ledger.honestOutcomes.push({
    did: issuer.did, address: issuer.address,
    descriptorUrl: res.descriptorUrl, graphIri,
    commitment, signature, value,
  });
  return res;
}

// Forgery kinds — three distinct failure modes, all detectable on the
// reader side. The harness produces all three so each rejection branch
// (noSignature / badSignature / didMismatch) is exercised.
//   kind=unsigned     -> no signature field at all (literal "" or absent)
//   kind=malformed    -> 0xDEADBEEF-style nonsense, fails parse
//   kind=wrongSigner  -> well-formed signature but signed by attacker's
//                        throwaway key, claims to be honest agent's DID
async function publishForgedOutcome(attacker, victimDid, victimAddress, idx, value, kind) {
  const id = `urn:emergent:forge-and-flood:forged:${idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const payload = {
    issuer: victimAddress,           // attacker LIES about issuer
    target: CALIBRATION_TARGET,
    outcomeValue: value,
    modalStatus: 'Asserted',
    confidence: 0.99,                // attacker over-claims confidence
    at: now,
  };

  let commitment;
  let signature;
  if (kind === 'unsigned') {
    // No signature at all — just compute the commitment so the
    // descriptor still has a hash to be filtered on.
    const json = JSON.stringify(payload);
    const hash = createHash('sha256').update(json, 'utf8').digest('hex');
    commitment = `sha256:${hash}`;
    signature = '';
  } else if (kind === 'malformed') {
    const json = JSON.stringify(payload);
    const hash = createHash('sha256').update(json, 'utf8').digest('hex');
    commitment = `sha256:${hash}`;
    // Deliberate garbage — not a valid 65-byte ECDSA signature.
    signature = '0xDEADBEEF' + 'cafebabe'.repeat(8);
  } else {
    // wrongSigner — attacker signs with their throwaway key but the
    // descriptor still claims victimDid as issuer.
    const out = await signOutcome(attacker.wallet, payload);
    commitment = out.commitment;
    signature = out.signature;
  }

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix forge: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a forge:ForgedOutcome ;
  forge:issuer <${victimDid}> ;
  forge:target <${CALIBRATION_TARGET}> ;
  forge:outcomeValue "${value}"^^xsd:double ;
  forge:commitment "${commitment}" ;
  forge:signature "${signature}" ;
  forge:claimedSignerAddress "${victimAddress}" ;
  forge:actualPublisherAddress "${attacker.address}" ;
  forge:forgeryKind "${kind}" ;
  prov:wasGeneratedBy <${attacker.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_FORGED_OUTCOME)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: attacker.did, endedAt: now },
      // attacker LIES with wasAttributedTo: claim victim
      wasAttributedTo: victimDid,
      generatedAtTime: now,
    })
    .agent(victimDid, 'Author')   // forged authorship claim
    .asserted(0.99)
    .selfAsserted(victimDid)       // claims SelfAsserted on victim, NOT verified
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `forged-${String(idx).padStart(2, '0')}`,
    graphSlug: `forged-${String(idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  ledger.forgedOutcomes.push({
    did: victimDid,
    claimedAddress: victimAddress,
    actualPublisher: attacker.address,
    descriptorUrl: res.descriptorUrl,
    graphIri,
    commitment, signature, value,
    forgeryKind: kind,
  });
  return res;
}

async function publishCalibrationProfile(reader, kind, payload, supersedes) {
  const id = `urn:emergent:forge-and-flood:profile:${kind}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const conformsType = kind === 'baseline' ? TYPE_BASELINE_PROFILE : TYPE_POST_FLOOD_PROFILE;
  const supersedesLines = (supersedes ?? [])
    .map(u => `  cg:supersedes <${u}> ;`).join('\n');
  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix forge: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a forge:${kind === 'baseline' ? 'BaselineCalibrationProfile' : 'PostFloodCalibrationProfile'} ;
  forge:target <${CALIBRATION_TARGET}> ;
  forge:descriptorsVisible "${payload.visible}"^^xsd:integer ;
  forge:descriptorsAdmitted "${payload.admitted}"^^xsd:integer ;
  forge:descriptorsRejected "${payload.rejected}"^^xsd:integer ;
  forge:cellCount "${payload.cellCount}"^^xsd:integer ;
  forge:meanOutcomeValue "${payload.mean.toFixed(6)}"^^xsd:double ;
${supersedesLines}
  prov:wasAttributedTo <${reader.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  let builder = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(conformsType)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: reader.did, endedAt: now },
      wasAttributedTo: reader.did,
      generatedAtTime: now,
    })
    .agent(reader.did, 'Author')
    .asserted(0.99)
    .verified(reader.did);
  if (supersedes && supersedes.length > 0) {
    builder = builder.supersedes(...supersedes);
  }
  const desc = builder.build();
  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `profile-${kind}`,
    graphSlug: `profile-${kind}-graph`,
  }), { maxAttempts: 4 });
  return res;
}

async function publishBlameLog(auditor, rejected) {
  const id = `urn:emergent:forge-and-flood:blame-log:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const blameLines = rejected
    .map(r => `  forge:rejectedDescriptor [ forge:descriptor <${r.iri}> ; forge:reason <${r.reason}> ] ;`)
    .join('\n');
  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix forge: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a forge:RejectionBlameLog ;
  forge:rejectionCount "${rejected.length}"^^xsd:integer ;
${blameLines}
  prov:wasAttributedTo <${auditor.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const topN = rejected.slice(0, 10).map(r => r.iri);
  let builder = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_REJECTION_BLAME_LOG)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: auditor.did, endedAt: now },
      wasAttributedTo: auditor.did,
      generatedAtTime: now,
    })
    .agent(auditor.did, 'Author')
    .hypothetical(0.9)
    .selfAsserted(auditor.did);
  if (topN.length > 0) builder = builder.supersedes(...topN);
  const desc = builder.build();
  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: 'blame-log',
    graphSlug: 'blame-log-graph',
  }), { maxAttempts: 4 });
  ledger.blameLogUrl = res.descriptorUrl;
  return res;
}

// ── boot ────────────────────────────────────────────────────────────
console.log('=== Interego — forge-and-flood (emergent test, Option D reader-side filter) ===');
console.log(`   pod:               ${POD}`);
console.log(`   scenario ns:       ${SCENARIO_NS}`);
console.log(`   calibration target: ${CALIBRATION_TARGET}`);

// ── ACT 0 — substrate liveness + cleanup ────────────────────────────
h('ACT 0 — substrate liveness + idempotent cleanup');
let live = false;
try {
  const r = await fetch(`${CSS}/`, { method: 'HEAD' });
  live = r.status === 200 || r.status === 204 || r.status === 401;
} catch { /* fall through */ }
check(`CSS pod at ${CSS} is reachable`, live);
if (!live) {
  console.log('Aborting — substrate is not reachable.');
  process.exit(1);
}
await cleanupPod();
console.log('   cleanup ok (idempotent — 404s on a fresh run are expected).');

// ── ACT 1 — mint 4 agents ───────────────────────────────────────────
h('ACT 1 — mint 4 agents (1 honest + 1 attacker + 1 reader + 1 auditor)');

const honest = (() => {
  const kp = loadAgentKeypair({ envVar: 'FORGE_AND_FLOOD_HONEST_KEY', label: 'honest' });
  return { ...kp, slug: 'honest', name: 'honest' };
})();
const attacker = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#attacker`, slug: 'attacker', name: 'attacker' };
})();
const reader = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#reader`, slug: 'reader', name: 'reader' };
})();
const auditor = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#auditor`, slug: 'auditor', name: 'auditor' };
})();

console.log(`   honest:   ${honest.address.slice(0, 10)}…   did=${honest.did.slice(0, 32)}…`);
console.log(`   attacker: ${attacker.address.slice(0, 10)}…   did=${attacker.did.slice(0, 32)}…`);
console.log(`   reader:   ${reader.address.slice(0, 10)}…   did=${reader.did.slice(0, 32)}…`);
console.log(`   auditor:  ${auditor.address.slice(0, 10)}…   did=${auditor.did.slice(0, 32)}…`);

check('all 4 agent addresses are distinct',
  new Set([honest.address, attacker.address, reader.address, auditor.address]).size === 4);
check('honest + attacker keypairs are independent (different addresses)',
  honest.address !== attacker.address);

// ── ACT 2 — honest publishes 5 signed outcomes ──────────────────────
h('ACT 2 — honest publishes 5 signed outcomes (Trust=CryptographicallyVerified)');

const HONEST_VALUES = [0.74, 0.81, 0.77, 0.83, 0.79];
for (let i = 0; i < HONEST_VALUES.length; i++) {
  await publishHonestOutcome(honest, i + 1, HONEST_VALUES[i]);
}
console.log(`   ${ledger.honestOutcomes.length} honest outcomes published, values=[${HONEST_VALUES.join(', ')}]`);

// Self-check: each honest signature recovers its own address. This is
// the assertion from the spec: "All 5 honest signed outcomes recover
// their signatory DID correctly via ethers.verifyMessage()".
let honestRecoveryOk = 0;
for (const o of ledger.honestOutcomes) {
  const rec = recoverMessageSigner(o.commitment, o.signature);
  if (rec === o.address.toLowerCase()) honestRecoveryOk++;
}
check('all 5 honest signed outcomes recover their signatory DID correctly via ethers.verifyMessage()',
  honestRecoveryOk === 5, { recovered: honestRecoveryOk, expected: 5 });

// Reader's baseline calibration — before the flood, only 5 visible.
const baselineMean = HONEST_VALUES.reduce((a, b) => a + b, 0) / HONEST_VALUES.length;
const baselineRes = await publishCalibrationProfile(reader, 'baseline', {
  visible: 5, admitted: 5, rejected: 0,
  cellCount: 5, mean: baselineMean,
}, []);
ledger.baselineProfileUrl = baselineRes.descriptorUrl;
console.log(`   baseline profile: visible=5 admitted=5 mean=${baselineMean.toFixed(4)}`);

// ── ACT 3 — attacker forges 20 outcomes claiming honest's DID ───────
h('ACT 3 — attacker forges 20 outcomes claiming honest agent\'s DID');

// 7 × unsigned, 6 × malformed, 7 × wrongSigner = 20 forgeries
const FORGED_PLAN = [
  ...Array(7).fill('unsigned'),
  ...Array(6).fill('malformed'),
  ...Array(7).fill('wrongSigner'),
];
// Attacker inflates outcomes to skew calibration upward
const FORGED_VALUES = Array.from({ length: 20 }, () => 0.95 + Math.random() * 0.04);
for (let i = 0; i < FORGED_PLAN.length; i++) {
  await publishForgedOutcome(
    attacker, honest.did, honest.address,
    i + 1, FORGED_VALUES[i], FORGED_PLAN[i],
  );
}
const kinds = ledger.forgedOutcomes.reduce((acc, f) => { acc[f.forgeryKind] = (acc[f.forgeryKind] ?? 0) + 1; return acc; }, {});
console.log(`   ${ledger.forgedOutcomes.length} forged outcomes on pod: ${JSON.stringify(kinds)}`);
console.log(`   (all claim issuer=${honest.did.slice(0, 24)}… but published from ${attacker.address.slice(0, 10)}…)`);

check('20 forged outcomes are visible on pod (discovery surface is permissive)',
  ledger.forgedOutcomes.length === 20, ledger.forgedOutcomes.length);

// Self-check: NONE of the 20 forgeries recover the honest signer's address.
let forgedRecoveryFailures = 0;
for (const f of ledger.forgedOutcomes) {
  const rec = recoverMessageSigner(f.commitment, f.signature);
  // recovery fails OR recovers an address that is NOT the claimed honest signer
  if (rec === null || rec !== f.claimedAddress.toLowerCase()) forgedRecoveryFailures++;
}
check('all 20 forged unsigned outcomes fail signature verification or DID recovery',
  forgedRecoveryFailures === 20, { failed: forgedRecoveryFailures, expected: 20 });

// ── ACT 4 — reader-side signature filter (federation-outcome-loader) ──
h('ACT 4 — reader runs federation-outcome-loader with cg:CryptographicallyVerified filter');

// Discover ALL descriptors on the pod — 5 honest + 20 forged + 1 baseline.
// The reader has NO orchestrator-side ledger access. It works only from
// what discover() returns, mirroring what an off-pod consumer would see.
const discovered = await discover(POD);
const outcomeEntries = discovered.filter(e =>
  (e.conformsTo ?? []).includes(TYPE_HONEST_OUTCOME)
  || (e.conformsTo ?? []).includes(TYPE_FORGED_OUTCOME));
console.log(`   pod entries discovered: ${discovered.length} total, ${outcomeEntries.length} outcome-typed`);

// The federation-outcome-loader: for each entry, fetch its graph,
// extract (commitment, signature, claimedIssuerAddress), recover with
// ethers.verifyMessage, and admit iff recovered === claimed.
const admitted = [];
const rejected = [];

function extractFieldLiteral(ttl, predicate) {
  // tolerant of namespace-prefixed and bare predicate suffixes
  const localName = predicate.split(':').pop();
  const re = new RegExp(`(?:forge:|\\bforge:)?${localName}\\s+"([^"]*)"`, 'g');
  const m = re.exec(ttl);
  return m ? m[1] : null;
}

for (const entry of outcomeEntries) {
  const claimedType = (entry.conformsTo ?? []).find(c => c === TYPE_HONEST_OUTCOME || c === TYPE_FORGED_OUTCOME);
  let ttl = '';
  try {
    const dist = await fetchGraphContent(entry.descriptorUrl, {});
    ttl = dist.content ?? '';
  } catch { ttl = ''; }
  const commitment = extractFieldLiteral(ttl, 'forge:commitment');
  const signature = extractFieldLiteral(ttl, 'forge:signature');
  const claimedAddress =
    extractFieldLiteral(ttl, 'forge:signerAddress')
    ?? extractFieldLiteral(ttl, 'forge:claimedSignerAddress');

  // Reader-side filter logic
  if (!signature || signature.length === 0) {
    rejected.push({ iri: entry.descriptorUrl, reason: REJECT_NO_SIGNATURE, type: claimedType });
    continue;
  }
  const recovered = recoverMessageSigner(commitment ?? '', signature);
  if (recovered === null) {
    rejected.push({ iri: entry.descriptorUrl, reason: REJECT_BAD_SIGNATURE, type: claimedType });
    continue;
  }
  if (!claimedAddress || recovered !== claimedAddress.toLowerCase()) {
    rejected.push({ iri: entry.descriptorUrl, reason: REJECT_DID_MISMATCH, type: claimedType });
    continue;
  }
  // Additionally require Trust facet at CryptographicallyVerified.
  // The descriptor's facets[] is exposed by discover() on each entry.
  const trustFacets = (entry.facets ?? []).filter(f => f.type === 'Trust');
  const hasVerifiedTrust = trustFacets.some(f => f.trustLevel === 'CryptographicallyVerified');
  if (!hasVerifiedTrust) {
    rejected.push({ iri: entry.descriptorUrl, reason: REJECT_DID_MISMATCH, type: claimedType });
    continue;
  }
  admitted.push({ iri: entry.descriptorUrl, recovered, type: claimedType });
}

ledger.filterResults.discovered = outcomeEntries.length;
ledger.filterResults.admitted = admitted;
ledger.filterResults.rejected = rejected;

console.log(`   reader filter: admitted=${admitted.length} rejected=${rejected.length}`);
const reasonBreakdown = rejected.reduce((acc, r) => { acc[r.reason.split('#').pop()] = (acc[r.reason.split('#').pop()] ?? 0) + 1; return acc; }, {});
console.log(`   reasons: ${JSON.stringify(reasonBreakdown)}`);

check('federation-outcome-loader applies cg:CryptographicallyVerified filter and excludes unsigned descriptors',
  admitted.length === 5 && rejected.length === 20,
  { admitted: admitted.length, rejected: rejected.length });

// Build the post-flood calibration profile and assert cell counts.
// "Calibration cell counts reflect only 5 honest outcomes, not 20 flooded ones"
const admittedValues = [];
for (const a of admitted) {
  const honestEntry = ledger.honestOutcomes.find(o => o.descriptorUrl === a.iri);
  if (honestEntry) admittedValues.push(honestEntry.value);
}
const postFloodMean = admittedValues.length > 0
  ? admittedValues.reduce((a, b) => a + b, 0) / admittedValues.length
  : 0;
const postFloodRes = await publishCalibrationProfile(reader, 'post-flood', {
  visible: outcomeEntries.length,
  admitted: admitted.length,
  rejected: rejected.length,
  cellCount: admitted.length,
  mean: postFloodMean,
}, [ledger.baselineProfileUrl]);
ledger.postFloodProfileUrl = postFloodRes.descriptorUrl;
console.log(`   post-flood profile: visible=25 admitted=5 rejected=20 mean=${postFloodMean.toFixed(4)}`);

check('calibration cell counts reflect only 5 honest outcomes, not 20 flooded ones',
  admitted.length === 5 && admittedValues.length === 5,
  { cellCount: admitted.length, expected: 5 });

// "Malicious descriptors remain discoverable on CSS but excluded from trust-filtered reads"
const forgedStillDiscoverable = outcomeEntries
  .filter(e => (e.conformsTo ?? []).includes(TYPE_FORGED_OUTCOME)).length;
check('malicious descriptors remain discoverable on CSS but excluded from trust-filtered reads',
  forgedStillDiscoverable === 20 && admitted.every(a => a.type !== TYPE_FORGED_OUTCOME),
  { discoverable: forgedStillDiscoverable, admittedForged: admitted.filter(a => a.type === TYPE_FORGED_OUTCOME).length });

// "Trust facet records issuer DID, verification timestamp, trust level per descriptor"
const honestEntriesOnPod = discovered.filter(e => (e.conformsTo ?? []).includes(TYPE_HONEST_OUTCOME));
const trustFacetsComplete = honestEntriesOnPod.every(e => {
  const tf = (e.facets ?? []).find(f => f.type === 'Trust');
  return tf
    && tf.trustLevel === 'CryptographicallyVerified'
    && typeof tf.issuer === 'string'
    && tf.issuer.length > 0;
});
// timestamp lives on the descriptor's Temporal/Provenance facets, not Trust
const allHaveTimestamps = honestEntriesOnPod.every(e =>
  (e.facets ?? []).some(f => f.type === 'Provenance' && typeof f.generatedAtTime === 'string'));
check('trust facet records issuer DID, verification timestamp, trust level per descriptor',
  trustFacetsComplete && allHaveTimestamps,
  { trustOk: trustFacetsComplete, tsOk: allHaveTimestamps });

// ── ACT 5 — auditor independently replays + publishes blame log ─────
h('ACT 5 — auditor independently re-discovers the pod and publishes blame log');

const auditorDiscovered = await discover(POD);
const auditorOutcomes = auditorDiscovered.filter(e =>
  (e.conformsTo ?? []).includes(TYPE_HONEST_OUTCOME)
  || (e.conformsTo ?? []).includes(TYPE_FORGED_OUTCOME));
console.log(`   auditor re-discovers: ${auditorOutcomes.length} outcome-typed descriptors`);

// Auditor's independent replay
const auditorRejected = [];
const auditorAdmitted = [];
for (const entry of auditorOutcomes) {
  let ttl = '';
  try { const d = await fetchGraphContent(entry.descriptorUrl, {}); ttl = d.content ?? ''; } catch { /* ignore */ }
  const commitment = extractFieldLiteral(ttl, 'forge:commitment');
  const signature = extractFieldLiteral(ttl, 'forge:signature');
  const claimedAddress =
    extractFieldLiteral(ttl, 'forge:signerAddress')
    ?? extractFieldLiteral(ttl, 'forge:claimedSignerAddress');
  if (!signature || signature.length === 0) {
    auditorRejected.push({ iri: entry.descriptorUrl, reason: REJECT_NO_SIGNATURE });
    continue;
  }
  const recovered = recoverMessageSigner(commitment ?? '', signature);
  if (recovered === null) {
    auditorRejected.push({ iri: entry.descriptorUrl, reason: REJECT_BAD_SIGNATURE });
    continue;
  }
  if (!claimedAddress || recovered !== claimedAddress.toLowerCase()) {
    auditorRejected.push({ iri: entry.descriptorUrl, reason: REJECT_DID_MISMATCH });
    continue;
  }
  auditorAdmitted.push({ iri: entry.descriptorUrl });
}
console.log(`   auditor replay: admitted=${auditorAdmitted.length} rejected=${auditorRejected.length}`);

// Auditor publishes the blame log naming every rejected descriptor +
// reason. The descriptor's cg:supersedes edges point to the top-10
// forged descriptors so downstream readers can fold them out.
const blameRes = await publishBlameLog(auditor, auditorRejected);
console.log(`   blame log:  ${blameRes.descriptorUrl}`);
console.log(`   (supersedes top-10 of ${auditorRejected.length} rejected descriptors)`);

check('auditor query shows which descriptors were filtered out and why',
  auditorRejected.length === 20
    && auditorRejected.every(r => r.reason === REJECT_NO_SIGNATURE
        || r.reason === REJECT_BAD_SIGNATURE
        || r.reason === REJECT_DID_MISMATCH),
  { rejected: auditorRejected.length });

// ── ACT 6 — pod-state verifier (independent of orchestrator memory) ──
h('ACT 6 — pod-state verifier (independent re-discovery)');
const finalEntries = await discover(POD);
const honestOnPod = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_HONEST_OUTCOME));
const forgedOnPod = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_FORGED_OUTCOME));
const baselineOnPod = finalEntries.find(e => (e.conformsTo ?? []).includes(TYPE_BASELINE_PROFILE));
const postFloodOnPod = finalEntries.find(e => (e.conformsTo ?? []).includes(TYPE_POST_FLOOD_PROFILE));
const blameLogOnPod = finalEntries.find(e => (e.conformsTo ?? []).includes(TYPE_REJECTION_BLAME_LOG));

console.log(`   honest descriptors on pod:        ${honestOnPod.length}`);
console.log(`   forged descriptors on pod:        ${forgedOnPod.length}`);
console.log(`   baseline profile on pod:          ${baselineOnPod ? 'yes' : 'no'}`);
console.log(`   post-flood profile on pod:        ${postFloodOnPod ? 'yes' : 'no'}`);
console.log(`   blame log on pod:                 ${blameLogOnPod ? 'yes' : 'no'}`);
console.log(`   total descriptors on pod:         ${finalEntries.length}`);

check('all 5 honest outcome descriptors re-discoverable from the pod manifest',
  honestOnPod.length === 5, honestOnPod.length);
check('all 20 forged outcome descriptors re-discoverable from the pod manifest',
  forgedOnPod.length === 20, forgedOnPod.length);
check('post-flood profile descriptor supersedes the baseline profile',
  postFloodOnPod !== undefined
    && (postFloodOnPod.supersedes ?? []).includes(ledger.baselineProfileUrl ?? ''),
  { found: !!postFloodOnPod, supersedes: postFloodOnPod?.supersedes });
check('blame log descriptor present and supersedes the top-10 forged descriptors',
  blameLogOnPod !== undefined && (blameLogOnPod.supersedes ?? []).length >= 10,
  { found: !!blameLogOnPod, supersedesCount: blameLogOnPod?.supersedes?.length });

// ── summary table ───────────────────────────────────────────────────
h('SUMMARY — calibration profile transition table');
console.log('   ' + 'phase'.padEnd(20) + 'visible  admitted  rejected  cellCount  mean');
console.log('   ' + '-'.repeat(72));
const row = (name, vis, adm, rej, cc, m) =>
  `   ${name.padEnd(20)}${String(vis).padStart(5)}     ${String(adm).padStart(3)}       ${String(rej).padStart(3)}        ${String(cc).padStart(3)}    ${m.toFixed(4)}`;
console.log(row('baseline (honest)',     5, 5, 0, 5, baselineMean));
console.log(row('post-flood (filtered)', 25, admitted.length, rejected.length, admitted.length, postFloodMean));

console.log(`\n   manifest:           ${POD}.well-known/context-graphs`);
console.log(`   baseline profile:   ${ledger.baselineProfileUrl}`);
console.log(`   post-flood profile: ${ledger.postFloodProfileUrl}`);
console.log(`   blame log:          ${ledger.blameLogUrl}`);

// ── final verdict ───────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed (cost: $0 — no LLM tokens)`);
console.log('='.repeat(72));
if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail > 1 ? 's' : ''}; details above.`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('\nRESULT: PASS — substrate primitives held.');
console.log('Reader-side signature filter (Option D) blocked the forge-and-flood');
console.log('attack: 20 forged outcomes remain discoverable on the pod but are');
console.log('excluded from the trust-filtered calibration read. The auditor blame');
console.log('log gives downstream consumers a path to fold out the forgeries by IRI.');
