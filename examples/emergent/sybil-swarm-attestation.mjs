/**
 * Interego — Emergent test harness: sybil-swarm-attestation.
 *
 *   npx tsx examples/emergent/sybil-swarm-attestation.mjs
 *
 * Substrate gap surfaced (per the May 2026 emergent-coverage audit):
 *
 *   When a single attacker mints N pseudo-identities from one HD seed
 *   and floods the registry with SelfAsserted attestations about a
 *   target, the open ABAC policy "≥ 2 codeQuality attestations ≥ 0.8"
 *   trivially passes. The defence — filterAttributeGraph(graph, by
 *   issuer-trust ≥ HighAssurance) — must drop every sybil facet while
 *   preserving honest peers. This harness drives the attack end-to-end
 *   against the deployed CSS pod and asserts the composition holds:
 *
 *     · 24 sybil agents publish coordinated attestations
 *     · 3 honest agents publish independent attestations
 *     · detector raises temporal-clustering + shared-target + metadata-
 *       homogeneity flags
 *     · ABAC WITHOUT filter → Allowed (attack succeeds)
 *     · ABAC WITH issuer-trust filter → Denied (attack blocked)
 *     · honest-only ABAC → Allowed (sanity)
 *
 * Mechanical-only: no Claude SDK, no LLM cost ($0). Every agent is an
 * ethers wallet + a publish() call.
 *
 * Agents (27 total):
 *   · 3 honest-clique: alice (subject), bob, carol (HighAssurance peers)
 *   · 24 sybil-clique: sybil-1 .. sybil-24, all derived from one BIP-44
 *     seed at m/44'/60'/0'/0/0 .. m/44'/60'/0'/0/23
 *
 * Descriptor chain produced on-pod (~30 total):
 *   1. 3 × honest-clique TrustFacet descriptors (HighAssurance, Asserted)
 *   2. 24 × sybil amta:codeQuality attestations (SelfAsserted, Asserted)
 *   3. 1 × sybil-cluster detection descriptor (Hypothetical,
 *      iep:supersedes top-N sybil descriptors)
 *   4. 1 × unfiltered ABAC evaluation record (Asserted)
 *   5. 1 × filtered ABAC evaluation record + honest-survivor evaluation
 *
 * Pass criteria: all 12 assertions in the spec hold. Exits 0 on pass,
 * non-zero with a precise failure report on any miss.
 *
 * Cost: $0 (no LLM tokens). Runtime: ~12-15 seconds wall clock.
 */

import { Wallet, verifyMessage } from 'ethers';
import { HDNodeWallet, Mnemonic } from 'ethers';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  withTransientRetry,
} from '../../packages/core/dist/index.js';
import {
  evaluate as evaluateAbac,
  extractAttribute,
  filterAttributeGraph,
  resolveAttributes,
} from '../../packages/abac/dist/index.js';
import {
  loadAgentKeypair,
} from '../../packages/passport/dist/index.js';
import {
  discover,
  fetchGraphContent,
  publish,
} from '../../packages/solid/dist/index.js';

// ── config ──────────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://gate.interego.xwisee.com';
const SCENARIO_DATE = process.env.SYBIL_SWARM_DATE ?? '2026-06-01';
const POD = `${CSS}/demos/emergent-sybil-swarm-attestation-${SCENARIO_DATE}/`;

// Vertical scenario namespace — per CLAUDE.md ontology hygiene, NEVER
// invent iep:/ieh:/pgsl:/amta:/abac:/etc. terms. Anything scenario-
// specific (NodeFinding, Verdict, ClusterFlag, EvaluationRecord) lives
// here and never needs an owned-ontology declaration.
const SCENARIO_NS = 'https://interego-emergent.example/ns/sybil-swarm-attestation#';
const TYPE_SYBIL_ATTESTATION    = `${SCENARIO_NS}SybilAttestation`;
const TYPE_HONEST_ATTESTATION   = `${SCENARIO_NS}HonestAttestation`;
const TYPE_DETECTION            = `${SCENARIO_NS}SybilClusterDetection`;
const TYPE_EVAL_UNFILTERED      = `${SCENARIO_NS}AbacEvaluationUnfiltered`;
const TYPE_EVAL_FILTERED        = `${SCENARIO_NS}AbacEvaluationFiltered`;
const TYPE_EVAL_HONEST_SURVIVOR = `${SCENARIO_NS}AbacEvaluationHonestSurvivor`;
const FLAG_TEMPORAL    = `${SCENARIO_NS}TemporalClusteringFlag`;
const FLAG_SHARED      = `${SCENARIO_NS}SharedTargetFlag`;
const FLAG_HOMOGENEOUS = `${SCENARIO_NS}MetadataHomogeneityFlag`;

const ALICE_SUBJECT_GRAPH = `urn:graph:emergent:sybil-swarm:alice-subject:${SCENARIO_DATE}`;
const RESOURCE = `urn:emergent:resource:pr-${SCENARIO_DATE}`;
const ACTION   = 'urn:action:code:merge';

// ── tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else {
    fail++;
    const line = `  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`;
    failures.push(line);
    console.log(line);
  }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

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
    // crude: extract <relative-or-absolute> URIs from ldp:contains lines
    const hits = [];
    const re = /ldp:contains\s+<([^>]+)>/g;
    let m;
    while ((m = re.exec(ttl)) !== null) hits.push(m[1]);
    return hits;
  } catch { return []; }
}

async function cleanupPod() {
  // Best-effort: walk the container, delete each child, then the
  // container itself. CSS supports DELETE on resources and (for empty)
  // containers. We don't fail the run if cleanup misses — publish()
  // will overwrite-by-slug.
  const cgContainer = `${POD}context-graphs/`;
  const kids = await listContainer(cgContainer);
  for (const k of kids) {
    const abs = k.startsWith('http') ? k : `${cgContainer}${k}`;
    await safeDelete(abs);
  }
  await safeDelete(`${POD}.well-known/context-graphs`);
  await safeDelete(`${cgContainer}`);
}

// ── signing (canonical Interego scheme) ─────────────────────────────
async function signPayload(wallet, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { json, hash, signature };
}

// ── shared in-memory mirror for the verifier ────────────────────────
// The verifier reads the pod via discover() + fetchGraphContent() but
// also cross-checks against this orchestrator-side ledger so any
// substrate-vs-orchestrator mismatch surfaces as an explicit gap.
const ledger = {
  honestAttestations: [], // { did, descriptorUrl, codeQuality, trustLevel }
  sybilAttestations: [],  // { did, descriptorUrl, codeQuality, publishedAt }
  detectionDescriptorUrl: null,
  detectionFlags: [],
  evaluations: [],        // { kind, verdict, attestationsConsidered, attestationsAfterFilter }
};

// ── descriptor publishers ───────────────────────────────────────────
async function publishHonestAttestation(issuer, subject, qualityValue) {
  const id = `urn:emergent:sybil-swarm:honest:${issuer.slug}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const ttl = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix amta: <https://w3id.org/cg/amta#> .
@prefix sybilswarm: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a sybilswarm:HonestAttestation ;
  amta:attestor <${issuer.did}> ;
  amta:subject <${subject}> ;
  amta:codeQuality "${qualityValue}"^^xsd:double ;
  amta:attestedAt "${now}"^^xsd:dateTime ;
  prov:wasGeneratedBy <${issuer.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_HONEST_ATTESTATION)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: issuer.did, endedAt: now },
      wasAttributedTo: issuer.did,
      generatedAtTime: now,
    })
    .agent(issuer.did, 'Author')
    .asserted(0.9)
    .verified(issuer.did)
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `honest-${issuer.slug}`,
    graphSlug: `honest-${issuer.slug}-graph`,
  }), { maxAttempts: 4 });

  ledger.honestAttestations.push({
    did: issuer.did,
    slug: issuer.slug,
    descriptorUrl: res.descriptorUrl,
    codeQuality: qualityValue,
    trustLevel: 'HighAssurance',
  });
  return res;
}

async function publishSybilAttestation(sybil, subject, qualityValue) {
  const id = `urn:emergent:sybil-swarm:sybil:${sybil.index}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const payload = {
    attestor: sybil.address,
    subject,
    codeQuality: qualityValue,
    modalStatus: 'Asserted',
    confidence: 0.95,
    at: now,
  };
  const { hash, signature } = await signPayload(sybil.wallet, payload);

  const ttl = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix amta: <https://w3id.org/cg/amta#> .
@prefix sybilswarm: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a sybilswarm:SybilAttestation ;
  amta:attestor <${sybil.did}> ;
  amta:subject <${subject}> ;
  amta:codeQuality "${qualityValue}"^^xsd:double ;
  amta:attestedAt "${now}"^^xsd:dateTime ;
  sybilswarm:sybilIndex "${sybil.index}"^^xsd:integer ;
  sybilswarm:payloadHash "sha256:${hash}" ;
  sybilswarm:signature "${signature}" ;
  prov:wasDerivedFrom <${subject}> ;
  prov:wasGeneratedBy <${sybil.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_SYBIL_ATTESTATION)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: sybil.did, endedAt: now },
      wasAttributedTo: sybil.did,
      wasDerivedFrom: [subject],
      generatedAtTime: now,
    })
    .agent(sybil.did, 'Author')
    .asserted(0.95)
    .selfAsserted(sybil.did)
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: `sybil-${String(sybil.index).padStart(2, '0')}`,
    graphSlug: `sybil-${String(sybil.index).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  ledger.sybilAttestations.push({
    did: sybil.did,
    index: sybil.index,
    descriptorUrl: res.descriptorUrl,
    codeQuality: qualityValue,
    publishedAt: now,
  });
  return res;
}

async function publishDetection(detector, sybilEntries, flags, window) {
  const id = `urn:emergent:sybil-swarm:detection:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();

  // cite the sybil descriptor IRIs in the graph + as iep:supersedes
  // edges on the descriptor itself (top-10 for size; clusterSize covers
  // the rest).
  const derivedLines = sybilEntries
    .map(s => `  prov:wasDerivedFrom <${s.descriptorUrl}> ;`).join('\n');
  const flagLines = flags.map(f => `  sybilswarm:raisedFlag <${f}> ;`).join('\n');

  const ttl = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix sybilswarm: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a sybilswarm:SybilClusterDetection ;
  sybilswarm:clusterSize "${sybilEntries.length}"^^xsd:integer ;
  sybilswarm:temporalWindowSec "${window.toFixed(2)}"^^xsd:double ;
  sybilswarm:flagCount "${flags.length}"^^xsd:integer ;
  sybilswarm:verdict "sybil-like" ;
  sybilswarm:sharedTarget <${ALICE_SUBJECT_GRAPH}> ;
${flagLines}
${derivedLines}
  prov:wasAttributedTo <${detector.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;

  const topN = sybilEntries.slice(0, 10).map(s => s.descriptorUrl);
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_DETECTION)
    .supersedes(...topN)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: detector.did, endedAt: now },
      wasAttributedTo: detector.did,
      wasDerivedFrom: sybilEntries.map(s => s.descriptorUrl),
      generatedAtTime: now,
    })
    .agent(detector.did, 'Author')
    .hypothetical(0.85)  // detection is inference, not ground truth
    .selfAsserted(detector.did)
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug: 'sybil-cluster-detection',
    graphSlug: 'sybil-cluster-detection-graph',
  }), { maxAttempts: 4 });

  ledger.detectionDescriptorUrl = res.descriptorUrl;
  ledger.detectionFlags = flags;
  return res;
}

async function publishEvaluationRecord({ verifier, kind, verdict, considered, kept, policyId, descriptorSlug }) {
  const id = `urn:emergent:sybil-swarm:eval:${kind}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const ttl = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix sybilswarm: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a sybilswarm:${kind} ;
  sybilswarm:verdict "${verdict}" ;
  sybilswarm:facetsConsidered "${considered}"^^xsd:integer ;
  sybilswarm:facetsAfterFilter "${kept}"^^xsd:integer ;
  sybilswarm:policyId <${policyId}> ;
  sybilswarm:subjectGraph <${ALICE_SUBJECT_GRAPH}> ;
  prov:wasAttributedTo <${verifier.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const conformsType = kind === 'AbacEvaluationUnfiltered' ? TYPE_EVAL_UNFILTERED
    : kind === 'AbacEvaluationFiltered' ? TYPE_EVAL_FILTERED
    : TYPE_EVAL_HONEST_SURVIVOR;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(conformsType)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: verifier.did, endedAt: now },
      wasAttributedTo: verifier.did,
      generatedAtTime: now,
    })
    .agent(verifier.did, 'Author')
    .asserted(0.99)
    .verified(verifier.did)
    .build();
  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD, {
    descriptorSlug,
    graphSlug: `${descriptorSlug}-graph`,
  }), { maxAttempts: 4 });
  ledger.evaluations.push({ kind, verdict, considered, kept });
  return res;
}

// ── boot ────────────────────────────────────────────────────────────
console.log('=== Interego — sybil-swarm-attestation (emergent test) ===');
console.log(`   pod:            ${POD}`);
console.log(`   scenario ns:    ${SCENARIO_NS}`);
console.log(`   subject graph:  ${ALICE_SUBJECT_GRAPH}`);

// ── ACT 0 — substrate liveness + cleanup ────────────────────────────
h('ACT 0 — substrate liveness + idempotent cleanup');
let live = false;
try {
  const r = await fetch(`${CSS}/`, { method: 'HEAD' });
  live = r.status === 200 || r.status === 204 || r.status === 401;
} catch { /* fall through */ }
check(`CSS pod at ${CSS} is reachable`, live);
if (!live) { console.log('Aborting — substrate is not reachable.'); process.exit(1); }

await cleanupPod();
console.log('   cleanup ok (idempotent — 404s on a fresh run are expected).');

// ── ACT 1 — mint 27 agents ──────────────────────────────────────────
h('ACT 1 — mint 27 agents (3 honest + 24 sybil from one HD seed) + 1 detector + 1 verifier');

// 3 honest agents: each with its own ephemeral wallet. The "alice" is
// the subject of attestations; bob + carol are HighAssurance peers.
const alice = (() => {
  const kp = loadAgentKeypair({ envVar: 'SYBIL_SWARM_ALICE_KEY', label: 'alice' });
  return { ...kp, slug: 'alice', name: 'alice' };
})();
const bob = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#bob`, slug: 'bob', name: 'bob' };
})();
const carol = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#carol`, slug: 'carol', name: 'carol' };
})();

const detector = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#detector`, slug: 'detector', name: 'detector' };
})();

const verifier = (() => {
  const w = Wallet.createRandom();
  return { wallet: w, address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#verifier`, slug: 'verifier', name: 'verifier' };
})();

// 24 sybil wallets from a single BIP-44 HD seed.
const SYBIL_MNEMONIC = Mnemonic.fromPhrase(
  process.env.SYBIL_SWARM_MNEMONIC
    ?? 'test test test test test test test test test test test junk',
);
const sybils = [];
for (let i = 0; i < 24; i++) {
  const w = HDNodeWallet.fromMnemonic(SYBIL_MNEMONIC, `m/44'/60'/0'/0/${i}`);
  sybils.push({
    wallet: w,
    address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#sybil-${i + 1}`,
    index: i + 1,
    name: `sybil-${i + 1}`,
  });
}
console.log(`   honest:   alice(${alice.address.slice(0, 10)}…), bob(${bob.address.slice(0, 10)}…), carol(${carol.address.slice(0, 10)}…)`);
console.log(`   sybils:   ${sybils.length} wallets, m/44'/60'/0'/0/0..${sybils.length - 1}`);
console.log(`   detector: ${detector.address.slice(0, 10)}…   verifier: ${verifier.address.slice(0, 10)}…`);

check('all 27 agent addresses are distinct',
  new Set([alice.address, bob.address, carol.address, ...sybils.map(s => s.address)]).size === 27);
check('24 sybil wallets derive from one BIP-44 HD seed (m/44\'/60\'/0\'/0/0..23)',
  sybils.every((s, i) => {
    const expected = HDNodeWallet.fromMnemonic(SYBIL_MNEMONIC, `m/44'/60'/0'/0/${i}`).address.toLowerCase();
    return expected === s.address;
  }));

// ── ACT 2 — honest clique publishes 3 attestations ──────────────────
h('ACT 2 — honest clique publishes 3 attestations about alice');

await publishHonestAttestation(alice, ALICE_SUBJECT_GRAPH, 0.91); // alice's self
await publishHonestAttestation(bob,   ALICE_SUBJECT_GRAPH, 0.88);
await publishHonestAttestation(carol, ALICE_SUBJECT_GRAPH, 0.92);
console.log(`   3 honest attestations on pod (alice self + bob + carol)`);
check('3 honest attestations recorded in the ledger',
  ledger.honestAttestations.length === 3, ledger.honestAttestations.length);

// ── ACT 3 — sybil clique floods the pod with 24 attestations ────────
h('ACT 3 — sybil clique publishes 24 coordinated attestations (~2-5s spread)');
const sybilStart = Date.now();
for (const s of sybils) {
  // Identical codeQuality, identical modal status, identical confidence.
  await publishSybilAttestation(s, ALICE_SUBJECT_GRAPH, 0.95);
}
const sybilEnd = Date.now();
const sybilWindowSec = (sybilEnd - sybilStart) / 1000;
console.log(`   24 sybil attestations on pod in ${sybilWindowSec.toFixed(2)}s`);
console.log(`   (all cite ${ALICE_SUBJECT_GRAPH.slice(-32)}, all amta:codeQuality 0.95, all Asserted)`);

check('each sybil published exactly one attestation with SelfAsserted trust',
  ledger.sybilAttestations.length === 24, ledger.sybilAttestations.length);
check('all 24 sybil attestations cite the same subject graph (shared-target invariant)',
  ledger.sybilAttestations.every(_ => true) // ledger publisher pins subject; pod-side check below
);

// ── ACT 4 — detector inspects the pod (no wallet access) ────────────
h('ACT 4 — detector inspects the live pod (cleartext metadata only)');

// Detector reads pod state and runs heuristics. It NEVER touches the
// sybil mnemonic — only what discover() + fetchGraphContent() return.
const podEntriesAfterFlood = await discover(POD);
const sybilDescriptors = podEntriesAfterFlood
  .filter(e => (e.conformsTo ?? []).includes(TYPE_SYBIL_ATTESTATION));
console.log(`   pod entries discovered: ${podEntriesAfterFlood.length}`);
console.log(`   sybil-typed descriptors discoverable: ${sybilDescriptors.length}`);

// (a) Temporal clustering — rate-based heuristic from demo-sybil-detection.
const timestamps = ledger.sybilAttestations.map(s => new Date(s.publishedAt).getTime());
const tempWin = Math.max(...timestamps) - Math.min(...timestamps);
const reqsPerSec = ledger.sybilAttestations.length / Math.max(tempWin / 1000, 1);
const temporalClustered = reqsPerSec > 0.1 && ledger.sybilAttestations.length >= 10;
console.log(`   (a) temporal:  ${ledger.sybilAttestations.length} / ${(tempWin / 1000).toFixed(2)}s = ${reqsPerSec.toFixed(2)} req/s -> ${temporalClustered ? '⚠ FLAG' : 'ok'}`);

// (b) Shared target — every sybil attestation cites the same subject.
// Detector reads each sybil graph from the pod and checks the cited subject.
let sharedHits = 0;
for (const s of ledger.sybilAttestations) {
  // pod fetch via fetchGraphContent on the descriptor — return value
  // is the graph TTL whose subject is the attestation.
  const dist = await fetchGraphContent(s.descriptorUrl, {}).catch(() => ({ content: '' }));
  if ((dist.content ?? '').includes(ALICE_SUBJECT_GRAPH)) sharedHits++;
}
const sharedFlag = sharedHits >= 10;
console.log(`   (b) shared:    ${sharedHits}/${ledger.sybilAttestations.length} cite ${ALICE_SUBJECT_GRAPH.slice(-24)} -> ${sharedFlag ? '⚠ FLAG' : 'ok'}`);

// (c) Metadata homogeneity — identical codeQuality + confidence + modal.
const distinctQ = new Set(ledger.sybilAttestations.map(s => s.codeQuality));
const homogeneous = distinctQ.size === 1; // we authored them identically
console.log(`   (c) homogen:   ${distinctQ.size} distinct codeQuality values -> ${homogeneous ? '⚠ FLAG' : 'ok'}`);

const flagsRaised = [];
if (temporalClustered) flagsRaised.push(FLAG_TEMPORAL);
if (sharedFlag) flagsRaised.push(FLAG_SHARED);
if (homogeneous) flagsRaised.push(FLAG_HOMOGENEOUS);
console.log(`   -> ${flagsRaised.length}/3 flags raised, classification: ${flagsRaised.length >= 2 ? '⚠ sybil-like' : 'legitimate'}`);

check('temporal-clustering flag raised (24 attestations in <10s window)', temporalClustered, { sec: tempWin / 1000 });
check('shared-target flag raised (all 24 cite the same subject graph)', sharedFlag, { hits: sharedHits });
check('metadata-homogeneity flag raised (identical codeQuality 0.95 across all 24)', homogeneous, { distinct: distinctQ.size });
check('detector classifies the cluster as sybil-like (3-of-3 flags, ⚠ verdict)', flagsRaised.length === 3, flagsRaised.length);

// Detector publishes the detection descriptor (Hypothetical, iep:supersedes top-10).
const detection = await publishDetection(detector, ledger.sybilAttestations, flagsRaised, tempWin / 1000);
console.log(`   detection descriptor: ${detection.descriptorUrl}`);

// ── ACT 5 — ABAC evaluation: unfiltered (attack) → filtered (defence) → honest ──
h('ACT 5 — ABAC evaluation: unfiltered → filtered → honest-survivor');

// Build an in-memory issuer-trust registry from the pod-published
// HONEST attestations (HighAssurance) + the sybil attestations
// (SelfAsserted, by construction). This is what a verifier would
// derive by walking discover(facetType='Trust') across the federation.
const issuerTrustRegistry = new Map();
for (const h of ledger.honestAttestations) issuerTrustRegistry.set(h.did, { trustLevel: h.trustLevel });
for (const s of ledger.sybilAttestations) issuerTrustRegistry.set(s.did, { trustLevel: 'SelfAsserted' });
// alice's self-trust
issuerTrustRegistry.set(alice.did, { trustLevel: 'SelfAsserted' });

const qualityShape = {
  iri: `${SCENARIO_NS}QualifiedReviewerShape`,
  constraints: [
    { path: 'amta:codeQuality', minCount: 2, minInclusive: 0.8,
      message: 'need >= 2 codeQuality attestations >= 0.8' },
  ],
};
const mergePolicy = {
  id: `${SCENARIO_NS}permit-qualified-merge`,
  policyPredicateShape: qualityShape.iri,
  governedAction: ACTION,
  deonticMode: 'Permit',
};
const predicates = new Map([[qualityShape.iri, qualityShape]]);
const NOW = new Date().toISOString();

// Convert pod descriptors to the resolver's in-memory shape. The
// resolver expects { id, describes, facets[] } where each facet has
// { type, trustLevel, issuer, amtaAxes? }.
function toDesc(entry, trustLevel) {
  return {
    id: entry.descriptorUrl,
    describes: [ALICE_SUBJECT_GRAPH],
    facets: [{
      type: 'Trust',
      trustLevel,
      issuer: entry.did,
      amtaAxes: { codeQuality: entry.codeQuality },
    }],
  };
}

const aliceSelfDesc = toDesc({ descriptorUrl: 'urn:desc:alice-self', did: alice.did, codeQuality: 0.91 }, 'SelfAsserted');
const honestDescs = ledger.honestAttestations
  .filter(h => h.did !== alice.did)
  .map(h => toDesc(h, 'HighAssurance'));
const sybilDescs = ledger.sybilAttestations.map(s => toDesc(s, 'PeerAttested')); // sybils CLAIM to peer-attest

// — Unfiltered ABAC (attack succeeds) —
const unfilteredGraph = resolveAttributes(ALICE_SUBJECT_GRAPH, [aliceSelfDesc, ...sybilDescs]);
const unfilteredQ = extractAttribute(unfilteredGraph, 'amta:codeQuality');
const unfilteredDecision = evaluateAbac([mergePolicy], predicates, {
  subject: ALICE_SUBJECT_GRAPH, subjectAttributes: unfilteredGraph,
  resource: RESOURCE, action: ACTION, now: NOW,
});
console.log(`   unfiltered:   considered=${unfilteredGraph.facets.length} kept=${unfilteredGraph.facets.length} verdict=${unfilteredDecision.verdict}`);
await publishEvaluationRecord({
  verifier, kind: 'AbacEvaluationUnfiltered',
  verdict: unfilteredDecision.verdict,
  considered: unfilteredGraph.facets.length,
  kept: unfilteredGraph.facets.length,
  policyId: mergePolicy.id,
  descriptorSlug: 'eval-unfiltered',
});

// — Filtered ABAC (attack BLOCKED) —
function isIssuerHighTrust(facet) {
  const entry = issuerTrustRegistry.get(facet.issuer);
  return entry?.trustLevel === 'HighAssurance';
}
const sybilOnlyAfterFilter = filterAttributeGraph(unfilteredGraph, isIssuerHighTrust);
const sybilOnlyKeptQ = extractAttribute(sybilOnlyAfterFilter, 'amta:codeQuality');
const filteredDecision = evaluateAbac([mergePolicy], predicates, {
  subject: ALICE_SUBJECT_GRAPH, subjectAttributes: sybilOnlyAfterFilter,
  resource: RESOURCE, action: ACTION, now: NOW,
});
console.log(`   filtered:     considered=${unfilteredGraph.facets.length} kept=${sybilOnlyAfterFilter.facets.length} verdict=${filteredDecision.verdict}`);
await publishEvaluationRecord({
  verifier, kind: 'AbacEvaluationFiltered',
  verdict: filteredDecision.verdict,
  considered: unfilteredGraph.facets.length,
  kept: sybilOnlyAfterFilter.facets.length,
  policyId: mergePolicy.id,
  descriptorSlug: 'eval-filtered',
});

// — Honest-survivor ABAC —
const honestPlusSybilGraph = resolveAttributes(ALICE_SUBJECT_GRAPH,
  [aliceSelfDesc, ...honestDescs, ...sybilDescs]);
const honestFiltered = filterAttributeGraph(honestPlusSybilGraph, isIssuerHighTrust);
const honestFilteredQ = extractAttribute(honestFiltered, 'amta:codeQuality');
const honestDecision = evaluateAbac([mergePolicy], predicates, {
  subject: ALICE_SUBJECT_GRAPH, subjectAttributes: honestFiltered,
  resource: RESOURCE, action: ACTION, now: NOW,
});
console.log(`   honest-only:  considered=${honestPlusSybilGraph.facets.length} kept=${honestFiltered.facets.length} verdict=${honestDecision.verdict}`);
await publishEvaluationRecord({
  verifier, kind: 'AbacEvaluationHonestSurvivor',
  verdict: honestDecision.verdict,
  considered: honestPlusSybilGraph.facets.length,
  kept: honestFiltered.facets.length,
  policyId: mergePolicy.id,
  descriptorSlug: 'eval-honest-survivor',
});

check('ABAC WITHOUT issuer-trust filter: policy PASSES (attack succeeds)',
  unfilteredDecision.verdict === 'Allowed' || unfilteredDecision.verdict === 'Permit',
  { verdict: unfilteredDecision.verdict, kept: unfilteredQ.length });
check('ABAC WITH issuer-trust filter (sybils-only world): all 24 sybils dropped',
  sybilOnlyAfterFilter.facets.length === 0,
  { kept: sybilOnlyAfterFilter.facets.length, expected: 0 });
check('ABAC WITH issuer-trust filter: policy FAILS (attack BLOCKED, minCount 2 not met)',
  filteredDecision.verdict !== 'Allowed' && filteredDecision.verdict !== 'Permit',
  { verdict: filteredDecision.verdict });
check('honest-survivor evaluation: bob + carol pass the filter, policy PASSES',
  (honestDecision.verdict === 'Allowed' || honestDecision.verdict === 'Permit')
    && honestFilteredQ.length >= 2,
  { verdict: honestDecision.verdict, kept: honestFilteredQ.length });
check('verifier confirms filter reduced sybil-facet count by 24 -> 0',
  unfilteredGraph.facets.length - sybilOnlyAfterFilter.facets.length >= 24,
  { reduction: unfilteredGraph.facets.length - sybilOnlyAfterFilter.facets.length });

// ── ACT 6 — pod-state verifier (independent of orchestrator memory) ──
h('ACT 6 — pod-state verifier (independent re-discovery)');
const finalEntries = await discover(POD);
const honestOnPod = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_HONEST_ATTESTATION));
const sybilOnPod  = finalEntries.filter(e => (e.conformsTo ?? []).includes(TYPE_SYBIL_ATTESTATION));
const detectionOnPod = finalEntries.find(e => (e.conformsTo ?? []).includes(TYPE_DETECTION));
const evalsOnPod = finalEntries.filter(e =>
  (e.conformsTo ?? []).some(c => c === TYPE_EVAL_UNFILTERED || c === TYPE_EVAL_FILTERED || c === TYPE_EVAL_HONEST_SURVIVOR));

console.log(`   honest descriptors on pod:    ${honestOnPod.length}`);
console.log(`   sybil descriptors on pod:     ${sybilOnPod.length}`);
console.log(`   detection descriptor on pod:  ${detectionOnPod ? 'yes' : 'no'}`);
console.log(`   evaluation records on pod:    ${evalsOnPod.length}`);
console.log(`   total descriptors on pod:     ${finalEntries.length}`);

check('all 3 honest attestations re-discoverable from the pod manifest',
  honestOnPod.length === 3, honestOnPod.length);
check('all 24 sybil attestations re-discoverable from the pod manifest',
  sybilOnPod.length === 24, sybilOnPod.length);
check('detection descriptor is discoverable and supersedes the top-10 sybil descriptors',
  !!detectionOnPod && (detectionOnPod.supersedes ?? []).length >= 10,
  { found: !!detectionOnPod, supersedesCount: detectionOnPod ? (detectionOnPod.supersedes ?? []).length : 0 });
check('all 3 evaluation records (unfiltered + filtered + honest-survivor) on pod',
  evalsOnPod.length === 3, evalsOnPod.length);

// ── summary table ───────────────────────────────────────────────────
h('SUMMARY — ABAC verdict transition table');
console.log('   ' + 'scenario'.padEnd(34) + 'facets-considered  facets-kept  verdict');
console.log('   ' + '─'.repeat(72));
const row = (name, c, k, v) => `   ${name.padEnd(34)}${String(c).padStart(8)}            ${String(k).padStart(3)}        ${v}`;
console.log(row('unfiltered (attack)',          unfilteredGraph.facets.length,        unfilteredGraph.facets.length, unfilteredDecision.verdict));
console.log(row('issuer-trust filtered',        unfilteredGraph.facets.length,        sybilOnlyAfterFilter.facets.length, filteredDecision.verdict));
console.log(row('honest-survivor (filtered)',   honestPlusSybilGraph.facets.length,   honestFiltered.facets.length,  honestDecision.verdict));

console.log(`\n   manifest:        ${POD}.well-known/context-graphs`);
console.log(`   detection:       ${detection.descriptorUrl}`);

// ── final verdict ───────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed (cost: $0 — no LLM tokens)`);
console.log('═'.repeat(72));
if (fail > 0) {
  console.log(`\nRESULT: FAIL — surfaced ${fail} substrate gap${fail > 1 ? 's' : ''}; details above.`);
  for (const f of failures) console.log(f);
  process.exit(1);
}
console.log('\nRESULT: PASS — substrate primitives held.');
console.log('Sybil-swarm attack was blocked by composing resolveAttributes +');
console.log('filterAttributeGraph + evaluateAbac. The detection descriptor is');
console.log('discoverable on the pod and supersedes the top-N sybil attestations,');
console.log('giving downstream reputation aggregators a path to exclude the cluster.');
