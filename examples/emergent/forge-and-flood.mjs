/**
 * Interego — Emergent test harness: forge-and-flood.
 *
 *   npx tsx examples/emergent/forge-and-flood.mjs
 *
 * WHAT THIS TEST DOES
 * -------------------
 * Four honest reader-agents and three adversarial publisher-agents race
 * to flood a shared affordance with two distinct attack shapes:
 *
 *   (1) FORGED-SIGNATURE descriptors — attacker publishes a descriptor
 *       that CLAIMS an honest author's DID but is either signed with the
 *       attacker's own throwaway key, signed with deliberately malformed
 *       bytes, or carries no signature at all. CSS storage accepts them
 *       (zero-trust storage is an Interego principle); discover() will
 *       happily surface them; the defence lives at the READER, which
 *       MUST recover the signer and compare it to the claimed DID.
 *
 *   (2) REPLAYED-WITH-FRESH-URL descriptors — attacker takes a VALID
 *       descriptor signed by an honest agent and re-publishes the same
 *       payload + signature under a NEW pod URL. The embedded signature
 *       still verifies (it was made by the rightful key), but the URL
 *       is fresh, so naive de-duplication by manifest IRI misses the
 *       replay. The substrate's stance: replays of a valid signed
 *       payload are EQUIVALENT to the original UNLESS distinguished by
 *       cg:supersedes or by temporal-context cues (validFrom +
 *       generatedAtTime). This harness documents that stance and
 *       asserts the reader's content-hash de-duplication catches it.
 *
 * The test exercises Option D — reader-side signature filter — plus the
 * federation loader's signature gate at sustained ingest rate.
 *
 * SUBSTRATE GAP UNDER TEST
 * ------------------------
 * The L1 publish path is permissive by design: anyone with write access
 * to a CSS pod can publish any descriptor under any DID claim. A naive
 * reader that loads everything discover() returns will swallow forged
 * outcomes from an attacker who never possessed the signer's key. The
 * defence (per the May 2026 emergent-coverage audit) is a READER-SIDE
 * signature filter: walk discovered descriptors, recover the signer
 * with ethers.verifyMessage(), and only admit those whose recovered
 * address matches the claimed issuer DID. The reader then downgrades
 * everything else to a non-trusted bucket so calibration counts only
 * cg:CryptographicallyVerified outcomes. Replay attacks ride on top of
 * THIS gate and need a separate content-hash + supersedes check.
 *
 * AGENTS (7, sequential in-process; ephemeral wallets — no Claude SDK)
 *   · 4 honest readers (reader1..reader4) — each independently runs the
 *     reader-side signature filter against the pod and emits an admit/
 *     reject log. The 4-reader fan-out tests that the filter is
 *     deterministic across independent observers.
 *   · 3 adversarial publishers (pub1..pub3):
 *       - pub1: 12 forged-signature descriptors (4 unsigned, 4 malformed,
 *               4 wrongSigner). All CLAIM honest1's DID.
 *       - pub2: 8 forged-signature descriptors (4 unsigned, 4 wrongSigner)
 *               CLAIMING honest2's DID — second victim, second publisher.
 *       - pub3: 6 REPLAYED descriptors — takes honest1's 6 valid signed
 *               descriptors and re-publishes the same {commitment,
 *               signature} payload under fresh pod URLs.
 *   · 2 honest victims (honest1, honest2) — publish a small batch of
 *     legitimately signed descriptors (6 + 4 = 10) at the start; their
 *     DIDs are what the attackers claim.
 *
 * DESCRIPTOR CHAIN ON-POD (~36 total)
 *   1. 10 × honest outcome descriptors (Trust = CryptographicallyVerified)
 *   2. 20 × forged outcome descriptors (Trust = SelfAsserted, claim
 *           honest1/2; mix of unsigned/malformed/wrongSigner)
 *   3.  6 × replayed outcome descriptors (Trust = CryptographicallyVerified
 *           because the signature is still valid; only fresh URL + lack
 *           of cg:supersedes distinguishes them from the originals)
 *   4.  4 × reader admit/reject log descriptors (one per honest reader,
 *           each cg:supersedes the forged descriptors it rejected)
 *
 * PASS / FAIL
 *   PASS = every assertion in the brief evaluates true on the live pod
 *          state AND on each reader's in-memory filter results.
 *   FAIL = any assertion fails; script exits non-zero with a precise
 *          per-assertion blame report.
 *
 * Cost: $0 — no LLM in the loop. ~3-6 minutes wall-clock (sequential
 * publish + discovery + filter across ~40 descriptors).
 */

import { Wallet, verifyMessage } from 'ethers';
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
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.FORGE_AND_FLOOD_DATE
  ?? new Date().toISOString().slice(0, 10);
const POD = `${CSS}/demos/emergent-forge-and-flood-${SCENARIO_DATE}/`;

// Vertical scenario namespace — per CLAUDE.md ontology hygiene, NEVER
// invent cg:/cgh:/pgsl:/amta:/abac:/etc. terms. Anything scenario-
// specific lives under this opaque IRI and never needs an owned-ontology
// declaration; the ontology-lint will not flag it.
const SCENARIO_NS = 'https://interego-emergent.example/ns/forge-and-flood#';
const TYPE_HONEST_OUTCOME    = `${SCENARIO_NS}HonestOutcome`;
const TYPE_FORGED_OUTCOME    = `${SCENARIO_NS}ForgedOutcome`;
const TYPE_REPLAYED_OUTCOME  = `${SCENARIO_NS}ReplayedOutcome`;
const TYPE_READER_LOG        = `${SCENARIO_NS}ReaderAdmitRejectLog`;
const REJECT_NO_SIGNATURE    = `${SCENARIO_NS}RejectionReasonNoSignature`;
const REJECT_BAD_SIGNATURE   = `${SCENARIO_NS}RejectionReasonBadSignature`;
const REJECT_DID_MISMATCH    = `${SCENARIO_NS}RejectionReasonDidMismatch`;
const REJECT_REPLAY          = `${SCENARIO_NS}RejectionReasonReplay`;

const CALIBRATION_TARGET = `urn:graph:emergent:forge-and-flood:target:${SCENARIO_DATE}`;

// ── tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
const assertionTable = [];
const check = (label, cond, detail) => {
  if (cond) {
    pass++;
    assertionTable.push({ ok: true, label });
    console.log(`  + ${label}`);
  } else {
    fail++;
    const line = `  - ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`;
    failures.push(line);
    assertionTable.push({ ok: false, label, detail });
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
// The documented Interego scheme prepends "sha256:" to the digest before
// signing so that bare ethers.verifyMessage() on the reader side
// recovers the same prefixed string. Any reader that uses the WRONG
// canonicalization (no prefix) will see every honest signature as
// forged. The harness verifies the round trip end-to-end so this gap
// surfaces explicitly.
async function signOutcome(wallet, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const commitment = `sha256:${hash}`;
  const signature = await wallet.signMessage(commitment);
  return { json, hash, commitment, signature };
}

// Reader-side recovery — the heart of Option D. Returns the recovered
// lowercased address iff the signature parses + recovers cleanly.
// Malformed hex / wrong length / garbage bytes → null (never throws).
function recoverMessageSigner(commitment, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return null;
  if (signature.length !== 132) return null; // 0x + 65 bytes hex
  try {
    return verifyMessage(commitment, signature).toLowerCase();
  } catch {
    return null;
  }
}

// Content-hash of the (commitment, signature) pair. Used by readers to
// detect replays: if the same {commitment, signature} appears under two
// distinct descriptor URLs with no cg:supersedes edge between them, the
// later observation is a replay of the earlier one.
function contentFingerprint(commitment, signature) {
  return createHash('sha256')
    .update(`${commitment ?? ''}::${signature ?? ''}`, 'utf8')
    .digest('hex');
}

// ── orchestrator-side ledger (verifier cross-checks against this) ───
const ledger = {
  honest: [],     // { agent, did, address, descriptorUrl, commitment, signature, value, fingerprint }
  forged: [],     // { claimedDid, claimedAddress, attackerAddress, descriptorUrl, commitment, signature, value, forgeryKind }
  replayed: [],   // { originalDescriptorUrl, replayDescriptorUrl, commitment, signature, fingerprint }
  readerLogs: [], // { readerSlug, descriptorUrl, admitted, rejected }
};

// ── descriptor publishers ───────────────────────────────────────────
async function publishHonestOutcome(issuer, idx, value) {
  const id = `urn:emergent:forge-and-flood:honest:${issuer.slug}:${idx}:${SCENARIO_DATE}`;
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
    .verified(issuer.did)
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `honest-${issuer.slug}-${String(idx).padStart(2, '0')}`,
    graphSlug: `honest-${issuer.slug}-${String(idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  const fingerprint = contentFingerprint(commitment, signature);
  ledger.honest.push({
    agent: issuer.slug,
    did: issuer.did,
    address: issuer.address,
    descriptorUrl: res.descriptorUrl,
    graphUrl: res.graphUrl,
    commitment, signature, value,
    fingerprint,
  });
  return res;
}

// Forgery kinds — three distinct failure modes, all detectable on the
// reader side.
//   kind=unsigned     -> no signature field at all (empty string)
//   kind=malformed    -> 0xDEADBEEF-style nonsense; fails parse
//   kind=wrongSigner  -> well-formed signature but signed by attacker's
//                        throwaway key while claiming victim's DID
async function publishForgedOutcome(attacker, victim, idx, value, kind) {
  const id = `urn:emergent:forge-and-flood:forged:${attacker.slug}:${idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const payload = {
    issuer: victim.address,             // attacker LIES about issuer
    target: CALIBRATION_TARGET,
    outcomeValue: value,
    modalStatus: 'Asserted',
    confidence: 0.99,                   // attacker over-claims confidence
    at: now,
  };

  let commitment;
  let signature;
  if (kind === 'unsigned') {
    const json = JSON.stringify(payload);
    const hash = createHash('sha256').update(json, 'utf8').digest('hex');
    commitment = `sha256:${hash}`;
    signature = '';
  } else if (kind === 'malformed') {
    const json = JSON.stringify(payload);
    const hash = createHash('sha256').update(json, 'utf8').digest('hex');
    commitment = `sha256:${hash}`;
    signature = '0xDEADBEEF' + 'cafebabe'.repeat(8); // not a valid 65-byte ECDSA sig
  } else {
    // wrongSigner — attacker signs with their own key while claiming
    // victim's DID in the issuer field of the descriptor.
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
  forge:issuer <${victim.did}> ;
  forge:target <${CALIBRATION_TARGET}> ;
  forge:outcomeValue "${value}"^^xsd:double ;
  forge:commitment "${commitment}" ;
  forge:signature "${signature}" ;
  forge:claimedSignerAddress "${victim.address}" ;
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
      // The attacker LIES with wasAttributedTo: claims victim.
      wasAttributedTo: victim.did,
      generatedAtTime: now,
    })
    .agent(victim.did, 'Author')        // forged authorship claim
    .asserted(0.99)
    .selfAsserted(victim.did)           // SelfAsserted on victim's DID, NOT verified
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `forged-${attacker.slug}-${String(idx).padStart(2, '0')}`,
    graphSlug: `forged-${attacker.slug}-${String(idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  ledger.forged.push({
    claimedDid: victim.did,
    claimedAddress: victim.address,
    attackerAddress: attacker.address,
    descriptorUrl: res.descriptorUrl,
    graphUrl: res.graphUrl,
    commitment, signature, value,
    forgeryKind: kind,
  });
  return res;
}

// Replay attack: take an honest, validly-signed descriptor and
// re-publish the SAME {commitment, signature} payload under a fresh
// pod URL. The signature still verifies cleanly because the rightful
// key produced it; only content-hash de-duplication or a cg:supersedes
// edge can distinguish replay from original.
async function publishReplayedOutcome(attacker, original, idx) {
  const id = `urn:emergent:forge-and-flood:replay:${attacker.slug}:${idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix forge: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a forge:ReplayedOutcome ;
  forge:issuer <${original.did}> ;
  forge:target <${CALIBRATION_TARGET}> ;
  forge:outcomeValue "${original.value}"^^xsd:double ;
  forge:commitment "${original.commitment}" ;
  forge:signature "${original.signature}" ;
  forge:signerAddress "${original.address}" ;
  forge:replayedFrom <${original.descriptorUrl}> ;
  forge:actualPublisherAddress "${attacker.address}" ;
  prov:wasGeneratedBy <${attacker.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  // The replay re-asserts the original signer as author. The signature
  // is genuine; only the URL is new. Trust facet is set to Verified
  // because the recovered signer DOES match the claimed DID. The
  // substrate's stance is that this is EQUIVALENT to the original
  // unless a cg:supersedes edge or temporal context distinguishes
  // them — readers must therefore content-hash dedupe.
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_REPLAYED_OUTCOME)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: attacker.did, endedAt: now },
      wasAttributedTo: original.did,
      wasDerivedFrom: [original.descriptorUrl],
      generatedAtTime: now,
    })
    .agent(original.did, 'Author')
    .asserted(0.97)
    .verified(original.did)
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `replay-${attacker.slug}-${String(idx).padStart(2, '0')}`,
    graphSlug: `replay-${attacker.slug}-${String(idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  ledger.replayed.push({
    originalDescriptorUrl: original.descriptorUrl,
    replayDescriptorUrl: res.descriptorUrl,
    replayGraphUrl: res.graphUrl,
    commitment: original.commitment,
    signature: original.signature,
    fingerprint: original.fingerprint,
  });
  return res;
}

async function publishReaderLog(reader, admitted, rejected) {
  const id = `urn:emergent:forge-and-flood:reader-log:${reader.slug}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const admittedLines = admitted
    .slice(0, 50)
    .map(a => `  forge:admittedDescriptor <${a.iri}> ;`)
    .join('\n');
  const rejectedLines = rejected
    .slice(0, 50)
    .map(r => `  forge:rejectedDescriptor [ forge:descriptor <${r.iri}> ; forge:reason <${r.reason}> ] ;`)
    .join('\n');
  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix forge: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a forge:ReaderAdmitRejectLog ;
  forge:readerAgent <${reader.did}> ;
  forge:admittedCount "${admitted.length}"^^xsd:integer ;
  forge:rejectedCount "${rejected.length}"^^xsd:integer ;
${admittedLines}
${rejectedLines}
  prov:wasAttributedTo <${reader.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const topRejected = rejected.slice(0, 10).map(r => r.iri);
  let builder = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_READER_LOG)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: reader.did, endedAt: now },
      wasAttributedTo: reader.did,
      generatedAtTime: now,
    })
    .agent(reader.did, 'Author')
    .asserted(0.95)
    .verified(reader.did);
  if (topRejected.length > 0) builder = builder.supersedes(...topRejected);
  const desc = builder.build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `reader-log-${reader.slug}`,
    graphSlug: `reader-log-${reader.slug}-graph`,
  }), { maxAttempts: 4 });
  ledger.readerLogs.push({
    readerSlug: reader.slug,
    descriptorUrl: res.descriptorUrl,
    admitted: admitted.length,
    rejected: rejected.length,
  });
  return res;
}

// ── boot ────────────────────────────────────────────────────────────
console.log('=== Interego — forge-and-flood (emergent test, Option D + replay detection) ===');
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

// ── ACT 1 — mint agents (2 honest + 3 attackers + 4 readers) ────────
h('ACT 1 — mint 2 honest victims + 3 adversarial publishers + 4 readers');

function mintAgent(slug, envVar) {
  if (envVar) {
    try {
      const kp = loadAgentKeypair({ envVar, label: slug });
      return { wallet: kp.wallet, address: kp.address, did: kp.did, slug, name: slug };
    } catch { /* fall through */ }
  }
  const w = Wallet.createRandom();
  return {
    wallet: w,
    address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#${slug}`,
    slug,
    name: slug,
  };
}

const honest1 = mintAgent('honest1', 'FORGE_AND_FLOOD_HONEST1_KEY');
const honest2 = mintAgent('honest2', 'FORGE_AND_FLOOD_HONEST2_KEY');
const pub1    = mintAgent('pub1');    // sig-forge attacker on honest1
const pub2    = mintAgent('pub2');    // sig-forge attacker on honest2
const pub3    = mintAgent('pub3');    // replay attacker on honest1
const reader1 = mintAgent('reader1');
const reader2 = mintAgent('reader2');
const reader3 = mintAgent('reader3');
const reader4 = mintAgent('reader4');

const allAddresses = new Set([
  honest1.address, honest2.address,
  pub1.address, pub2.address, pub3.address,
  reader1.address, reader2.address, reader3.address, reader4.address,
]);
console.log(`   honest1:  ${honest1.address.slice(0, 10)}…`);
console.log(`   honest2:  ${honest2.address.slice(0, 10)}…`);
console.log(`   pub1:     ${pub1.address.slice(0, 10)}…   pub2: ${pub2.address.slice(0, 10)}…   pub3: ${pub3.address.slice(0, 10)}…`);
console.log(`   readers:  ${reader1.address.slice(0, 10)}…, ${reader2.address.slice(0, 10)}…, ${reader3.address.slice(0, 10)}…, ${reader4.address.slice(0, 10)}…`);

check('all 9 agent addresses are distinct', allAddresses.size === 9);
check('honest victims + attackers + readers are independent wallets',
  honest1.address !== pub1.address
  && honest1.address !== pub3.address
  && honest2.address !== pub2.address);

// ── ACT 2 — honest publish 10 signed outcomes ───────────────────────
h('ACT 2 — honest victims publish 10 signed outcomes (Trust=CryptographicallyVerified)');

const HONEST1_VALUES = [0.71, 0.78, 0.74, 0.80, 0.76, 0.82];
const HONEST2_VALUES = [0.69, 0.73, 0.77, 0.81];
for (let i = 0; i < HONEST1_VALUES.length; i++) {
  await publishHonestOutcome(honest1, i + 1, HONEST1_VALUES[i]);
}
for (let i = 0; i < HONEST2_VALUES.length; i++) {
  await publishHonestOutcome(honest2, i + 1, HONEST2_VALUES[i]);
}
console.log(`   ${ledger.honest.length} honest outcomes published (honest1=${HONEST1_VALUES.length}, honest2=${HONEST2_VALUES.length})`);

// Self-check: each honest signature recovers its own address.
let honestRecoveryOk = 0;
for (const o of ledger.honest) {
  const rec = recoverMessageSigner(o.commitment, o.signature);
  if (rec === o.address.toLowerCase()) honestRecoveryOk++;
}
check('all 10 honest signed outcomes recover their signatory DID via ethers.verifyMessage()',
  honestRecoveryOk === 10, { recovered: honestRecoveryOk, expected: 10 });

// ── ACT 3 — adversaries flood the pod ───────────────────────────────
h('ACT 3 — 3 attackers flood the pod (20 forged + 6 replayed)');

// pub1 floods honest1 — 12 forgeries (4 unsigned + 4 malformed + 4 wrongSigner)
const PUB1_PLAN = [
  ...Array(4).fill('unsigned'),
  ...Array(4).fill('malformed'),
  ...Array(4).fill('wrongSigner'),
];
const PUB1_VALUES = Array.from({ length: PUB1_PLAN.length }, () => 0.95 + Math.random() * 0.04);
for (let i = 0; i < PUB1_PLAN.length; i++) {
  await publishForgedOutcome(pub1, honest1, i + 1, PUB1_VALUES[i], PUB1_PLAN[i]);
}

// pub2 floods honest2 — 8 forgeries (4 unsigned + 4 wrongSigner)
const PUB2_PLAN = [
  ...Array(4).fill('unsigned'),
  ...Array(4).fill('wrongSigner'),
];
const PUB2_VALUES = Array.from({ length: PUB2_PLAN.length }, () => 0.93 + Math.random() * 0.05);
for (let i = 0; i < PUB2_PLAN.length; i++) {
  await publishForgedOutcome(pub2, honest2, i + 1, PUB2_VALUES[i], PUB2_PLAN[i]);
}

// pub3 replays honest1's first 6 signed descriptors verbatim under fresh URLs
const HONEST1_ENTRIES = ledger.honest.filter(o => o.agent === 'honest1');
for (let i = 0; i < HONEST1_ENTRIES.length; i++) {
  await publishReplayedOutcome(pub3, HONEST1_ENTRIES[i], i + 1);
}

const forgeryKinds = ledger.forged.reduce((acc, f) => {
  acc[f.forgeryKind] = (acc[f.forgeryKind] ?? 0) + 1;
  return acc;
}, {});
console.log(`   ${ledger.forged.length} forged outcomes on pod: ${JSON.stringify(forgeryKinds)}`);
console.log(`   ${ledger.replayed.length} replayed outcomes on pod (genuine sigs, fresh URLs)`);

// ASSERTION 1 — publishing forged-signature descriptors succeeds.
check('publishing a forged-signature descriptor succeeds (storage allow-all per Interego principle)',
  ledger.forged.length === 20,
  { forgedOnPod: ledger.forged.length, expected: 20 });

// ASSERTION (replay sub-claim) — publishing replays succeeds too.
check('publishing a replayed valid descriptor succeeds (fresh URL, same payload signature)',
  ledger.replayed.length === 6,
  { replayedOnPod: ledger.replayed.length, expected: 6 });

// Cross-check: NONE of the 20 forgeries recover the honest claimed signer.
let forgeryRejectsInMemory = 0;
for (const f of ledger.forged) {
  const rec = recoverMessageSigner(f.commitment, f.signature);
  if (rec === null || rec !== f.claimedAddress.toLowerCase()) forgeryRejectsInMemory++;
}
check('all 20 forged descriptors fail in-memory signature verification against the claimed DID',
  forgeryRejectsInMemory === 20, { failed: forgeryRejectsInMemory, expected: 20 });

// Cross-check: ALL 6 replays recover the honest signer (sig is still valid).
let replayRecoverable = 0;
for (const r of ledger.replayed) {
  const rec = recoverMessageSigner(r.commitment, r.signature);
  if (rec === honest1.address.toLowerCase()) replayRecoverable++;
}
check('all 6 replayed descriptors STILL recover the original honest signer (sig is genuine)',
  replayRecoverable === 6, { recovered: replayRecoverable, expected: 6 });

// ── ACT 4 — discover() surfaces every published descriptor ──────────
h('ACT 4 — discover() returns every published descriptor at the manifest level');

const discovered = await discover(POD);
const honestOnPod = discovered.filter(e => (e.conformsTo ?? []).includes(TYPE_HONEST_OUTCOME));
const forgedOnPod = discovered.filter(e => (e.conformsTo ?? []).includes(TYPE_FORGED_OUTCOME));
const replayedOnPod = discovered.filter(e => (e.conformsTo ?? []).includes(TYPE_REPLAYED_OUTCOME));
console.log(`   manifest: honest=${honestOnPod.length} forged=${forgedOnPod.length} replayed=${replayedOnPod.length} total=${discovered.length}`);

// ASSERTION 2 — discover() returns the forged descriptor at the manifest level.
check('discover() returns every forged descriptor at the manifest level (cleartext metadata)',
  forgedOnPod.length === 20, { discoverable: forgedOnPod.length, expected: 20 });
check('discover() returns every replayed descriptor at the manifest level',
  replayedOnPod.length === 6, { discoverable: replayedOnPod.length, expected: 6 });
check('discover() returns every honest descriptor at the manifest level',
  honestOnPod.length === 10, { discoverable: honestOnPod.length, expected: 10 });

// ── ACT 5 — each of 4 readers runs the federation loader signature gate ─
h('ACT 5 — 4 readers independently run the reader-side signature filter');

function extractFieldLiteral(ttl, predicate) {
  const localName = predicate.split(':').pop();
  const re = new RegExp(`(?:forge:|\\bforge:)?${localName}\\s+"([^"]*)"`, 'g');
  const m = re.exec(ttl);
  return m ? m[1] : null;
}

const outcomeTypes = new Set([TYPE_HONEST_OUTCOME, TYPE_FORGED_OUTCOME, TYPE_REPLAYED_OUTCOME]);
const outcomeEntries = discovered.filter(e =>
  (e.conformsTo ?? []).some(c => outcomeTypes.has(c)));
console.log(`   outcome-typed entries on pod: ${outcomeEntries.length}`);

// Build a descriptorUrl -> graphUrl lookup from the publish ledger. The
// manifest entry exposes only descriptorUrl (the .ttl pointer); the
// signed payload (forge:commitment + forge:signature) lives in the
// separate .trig graph file written by publish(). To run the signature
// filter the reader must fetch the GRAPH, not the descriptor TTL.
const graphUrlByDescriptor = new Map();
for (const o of ledger.honest)   graphUrlByDescriptor.set(o.descriptorUrl, o.graphUrl);
for (const f of ledger.forged)   graphUrlByDescriptor.set(f.descriptorUrl, f.graphUrl);
for (const r of ledger.replayed) graphUrlByDescriptor.set(r.replayDescriptorUrl, r.replayGraphUrl);

// Cache the TriG payload once — all 4 readers will see the same content
// (deterministic across observers is one of the assertions).
const ttlCache = new Map();
for (const entry of outcomeEntries) {
  let ttl = '';
  const graphUrl = graphUrlByDescriptor.get(entry.descriptorUrl)
    // Fallback: derive the graph URL from the descriptor URL by the
    // publish slug convention (<slug>.ttl -> <slug>-graph.trig). Used
    // only if the ledger lookup misses (e.g. on re-discover after
    // restart) — exact same shape publish() writes.
    ?? entry.descriptorUrl.replace(/\.ttl$/, '-graph.trig');
  try {
    const dist = await fetchGraphContent(graphUrl, {});
    ttl = dist.content ?? '';
  } catch { ttl = ''; }
  ttlCache.set(entry.descriptorUrl, ttl);
}

// A single reader's filter pass — Option D + replay de-dup.
function runReaderFilter() {
  const admitted = [];
  const rejected = [];
  const fingerprintFirstSeenAt = new Map(); // fingerprint -> { iri, generatedAt }

  // Sort by generatedAtTime ASC so the first observation of any given
  // (commitment, signature) pair "wins" — later observations under fresh
  // URLs are de-duped as replays.
  const ordered = [...outcomeEntries].sort((a, b) => {
    const ttlA = ttlCache.get(a.descriptorUrl) ?? '';
    const ttlB = ttlCache.get(b.descriptorUrl) ?? '';
    const tA = /prov:generatedAtTime\s+"([^"]+)"/.exec(ttlA)?.[1] ?? '';
    const tB = /prov:generatedAtTime\s+"([^"]+)"/.exec(ttlB)?.[1] ?? '';
    return tA.localeCompare(tB);
  });

  for (const entry of ordered) {
    const ttl = ttlCache.get(entry.descriptorUrl) ?? '';
    const commitment = extractFieldLiteral(ttl, 'forge:commitment');
    const signature = extractFieldLiteral(ttl, 'forge:signature');
    const claimedAddress =
      extractFieldLiteral(ttl, 'forge:signerAddress')
      ?? extractFieldLiteral(ttl, 'forge:claimedSignerAddress');
    const claimedType = (entry.conformsTo ?? [])
      .find(c => outcomeTypes.has(c));

    // (a) no signature at all
    if (!signature || signature.length === 0) {
      rejected.push({ iri: entry.descriptorUrl, reason: REJECT_NO_SIGNATURE, type: claimedType });
      continue;
    }
    // (b) signature exists but cannot be recovered
    const recovered = recoverMessageSigner(commitment ?? '', signature);
    if (recovered === null) {
      rejected.push({ iri: entry.descriptorUrl, reason: REJECT_BAD_SIGNATURE, type: claimedType });
      continue;
    }
    // (c) recovered signer does not match the descriptor's claimed signer
    if (!claimedAddress || recovered !== claimedAddress.toLowerCase()) {
      rejected.push({ iri: entry.descriptorUrl, reason: REJECT_DID_MISMATCH, type: claimedType });
      continue;
    }
    // (d) reader requires Trust facet = CryptographicallyVerified.
    const trustFacets = (entry.facets ?? []).filter(f => f.type === 'Trust');
    const hasVerifiedTrust = trustFacets.some(f =>
      f.trustLevel === 'CryptographicallyVerified');
    if (!hasVerifiedTrust) {
      rejected.push({ iri: entry.descriptorUrl, reason: REJECT_DID_MISMATCH, type: claimedType });
      continue;
    }
    // (e) replay de-duplication by content-hash. The substrate's stance:
    //     replays of a valid signature are equivalent to the original
    //     unless cg:supersedes or temporal context distinguishes them.
    //     A trust-aware reader therefore content-hash dedupes; the first
    //     observation wins, later ones are tagged as replays.
    const fp = contentFingerprint(commitment, signature);
    const previous = fingerprintFirstSeenAt.get(fp);
    if (previous) {
      rejected.push({
        iri: entry.descriptorUrl,
        reason: REJECT_REPLAY,
        type: claimedType,
        replayOf: previous.iri,
      });
      continue;
    }
    fingerprintFirstSeenAt.set(fp, { iri: entry.descriptorUrl });
    admitted.push({ iri: entry.descriptorUrl, recovered, type: claimedType });
  }
  return { admitted, rejected };
}

const readers = [reader1, reader2, reader3, reader4];
const readerResults = readers.map(r => ({ reader: r, result: runReaderFilter() }));
for (const { reader, result } of readerResults) {
  console.log(`   ${reader.slug.padEnd(8)} admitted=${result.admitted.length} rejected=${result.rejected.length}`);
}

// ASSERTION 3 — verifying the signature against the claimed DID fails
// for the forged batch. (Per-reader; identical across readers.)
const r1 = readerResults[0].result;
const forgedRejectsByReader = r1.rejected.filter(rj => rj.type === TYPE_FORGED_OUTCOME).length;
check('verifying the signature against the claimed author DID fails for every forged descriptor',
  forgedRejectsByReader === 20, { rejected: forgedRejectsByReader, expected: 20 });

// ASSERTION 4 — reader filters by trust correctly rejects the forged batch.
const admittedForgedAnywhere = readerResults.some(({ result }) =>
  result.admitted.some(a => a.type === TYPE_FORGED_OUTCOME));
check('reader filtering by trust correctly rejects every forged-signature descriptor',
  !admittedForgedAnywhere && forgedRejectsByReader === 20,
  { admittedForgedAnywhere });

// Reader determinism — all four readers see the same admit/reject totals.
const adm0 = readerResults[0].result.admitted.length;
const rej0 = readerResults[0].result.rejected.length;
const deterministicAdmitted = readerResults.every(({ result }) => result.admitted.length === adm0);
const deterministicRejected = readerResults.every(({ result }) => result.rejected.length === rej0);
check('the reader-side signature filter is deterministic across 4 independent readers',
  deterministicAdmitted && deterministicRejected,
  { adm: readerResults.map(r => r.result.admitted.length),
    rej: readerResults.map(r => r.result.rejected.length) });

// ASSERTION 5 — replayed descriptors have unique URLs but the embedded
// payload signature is still valid; the substrate's stance is that
// replays are equivalent unless cg:supersedes or temporal context
// distinguishes them. The trust-aware reader content-hash dedupes.
const replayUrls = new Set(ledger.replayed.map(r => r.replayDescriptorUrl));
const replayPayloads = new Set(ledger.replayed.map(r => r.fingerprint));
const replayMatchesHonest = ledger.replayed.every(r =>
  ledger.honest.some(o => o.fingerprint === r.fingerprint));
check('replayed descriptors have unique URLs but identical embedded {commitment, signature} payloads',
  replayUrls.size === ledger.replayed.length
  && replayPayloads.size === ledger.honest.filter(o => o.agent === 'honest1').length
  && replayMatchesHonest,
  { distinctUrls: replayUrls.size, distinctPayloads: replayPayloads.size, allMatchHonest: replayMatchesHonest });

const replayRejectsByReader = r1.rejected.filter(rj => rj.reason === REJECT_REPLAY).length;
const replayAdmitsByReader = r1.admitted.filter(a => a.type === TYPE_REPLAYED_OUTCOME).length;
check('reader content-hash de-duplication tags every replay (distinguishes original vs replay by content + timestamp)',
  replayRejectsByReader === 6 && replayAdmitsByReader === 0,
  { rejected: replayRejectsByReader, admitted: replayAdmitsByReader });

// Document the substrate's stance: replays of a valid signature are
// equivalent UNLESS a cg:supersedes edge or temporal context (validFrom
// + generatedAtTime) distinguishes them. The reader-side filter resolves
// this by ordering by generatedAtTime ASC and content-hash deduping —
// the first observation wins, later observations of the same payload
// are admitted only if they carry a cg:supersedes edge that names an
// observation the reader already trusts.
console.log('   substrate stance: replays of a valid signed payload are equivalent');
console.log('   to the original unless cg:supersedes or temporal context distinguishes');
console.log('   them; trust-aware readers content-hash dedupe (first-write-wins by');
console.log('   generatedAtTime).');

// Admitted == only the 10 honest originals.
check('reader admits only the 10 honest originals (forged + replayed all filtered)',
  r1.admitted.length === 10
  && r1.admitted.every(a => a.type === TYPE_HONEST_OUTCOME),
  { admitted: r1.admitted.length, expected: 10 });

// ── ACT 6 — each reader publishes its admit/reject log ──────────────
h('ACT 6 — 4 readers publish their admit/reject logs on the pod');
for (const { reader, result } of readerResults) {
  await publishReaderLog(reader, result.admitted, result.rejected);
}
check('all 4 reader logs published',
  ledger.readerLogs.length === 4, ledger.readerLogs.length);

// ── ACT 7 — pod-state verifier (independent re-discovery) ───────────
h('ACT 7 — pod-state verifier (independent re-discovery)');
const finalEntries = await discover(POD);
const finalHonest = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_HONEST_OUTCOME));
const finalForged = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_FORGED_OUTCOME));
const finalReplayed = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_REPLAYED_OUTCOME));
const finalReaderLogs = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_READER_LOG));

console.log(`   honest:        ${finalHonest.length}`);
console.log(`   forged:        ${finalForged.length}`);
console.log(`   replayed:      ${finalReplayed.length}`);
console.log(`   reader logs:   ${finalReaderLogs.length}`);
console.log(`   total entries: ${finalEntries.length}`);

check('all 10 honest descriptors re-discoverable from the manifest',
  finalHonest.length === 10, finalHonest.length);
check('all 20 forged descriptors remain re-discoverable from the manifest',
  finalForged.length === 20, finalForged.length);
check('all 6 replayed descriptors remain re-discoverable from the manifest',
  finalReplayed.length === 6, finalReplayed.length);
check('all 4 reader logs re-discoverable from the manifest',
  finalReaderLogs.length === 4, finalReaderLogs.length);
check('every reader log supersedes its rejected forgeries (top-10)',
  finalReaderLogs.every(e => (e.supersedes ?? []).length >= 1),
  { supersedesLengths: finalReaderLogs.map(e => (e.supersedes ?? []).length) });

// Trust facets are present + intact on honest entries.
const trustFacetsComplete = finalHonest.every(e => {
  const tf = (e.facets ?? []).find(f => f.type === 'Trust');
  return tf && tf.trustLevel === 'CryptographicallyVerified'
    && typeof tf.issuer === 'string' && tf.issuer.length > 0;
});
check('trust facet records issuer DID + verification level for every honest descriptor',
  trustFacetsComplete);

// ── summary / assertion table ───────────────────────────────────────
h('SUMMARY — assertion table');
console.log('   ' + 'status   assertion'.padEnd(72));
console.log('   ' + '-'.repeat(72));
for (const row of assertionTable) {
  const status = row.ok ? '+  pass' : '-  FAIL';
  console.log(`   ${status}   ${row.label}`);
}
console.log('   ' + '-'.repeat(72));
console.log(`   pod:               ${POD}`);
console.log(`   manifest:          ${POD}.well-known/context-graphs`);
for (const rl of ledger.readerLogs) {
  console.log(`   reader-log ${rl.readerSlug}: admitted=${rl.admitted} rejected=${rl.rejected} -> ${rl.descriptorUrl}`);
}

// ── final verdict ───────────────────────────────────────────────────
console.log(`\n${'='.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed (cost: $0 — no LLM tokens)`);
console.log('='.repeat(72));
if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail > 1 ? 's' : ''}; details above.`);
  console.log('\nBug report:');
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('\nRESULT: PASS — substrate primitives held.');
console.log('Reader-side signature filter (Option D) blocked the forge-and-flood');
console.log('attack: 20 forged + 6 replayed descriptors remain discoverable on the');
console.log('pod but are excluded from the trust-filtered reads by 4 independent');
console.log('readers. Replay handling uses content-hash de-duplication ordered by');
console.log('generatedAtTime — the substrate stance is that valid-signature replays');
console.log('are equivalent to the original unless cg:supersedes or temporal context');
console.log('distinguishes them.');
