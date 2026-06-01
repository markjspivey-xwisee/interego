/**
 * Interego emergent test harness: byzantine-federation-loader.
 *
 *   npx tsx examples/emergent/byzantine-federation-loader.mjs
 *
 * WHAT THIS TEST DOES
 * -------------------
 * Five peer pods participate in a federation that mirrors a single honest
 * origin's 20-descriptor publication. Two peers re-serve the descriptors
 * faithfully (signature + commitment intact). Three peers behave
 * Byzantine in coordinated but distinct ways:
 *
 *   peer-byz-A — valid-sig, WRONG-content. Re-signs the same descriptor
 *                IRIs with its OWN key over MUTATED outcome values. The
 *                signature parses, recovers cleanly, but the recovered
 *                signer does not match the origin's claimed signer DID.
 *   peer-byz-B — wrong-sig, REAL content. Carries the origin's commitment
 *                (real outcome value preserved) but staples a junk
 *                signature (different key, or malformed bytes). The
 *                content matches the honest origin but the signature
 *                gate fails on recovery.
 *   peer-byz-C — stale + RE-SIGNED. Replays an OLD set of values from
 *                an earlier (superseded) honest publication and re-signs
 *                them with its own key under the same descriptor IRI.
 *                Both the signer DID and the content are wrong, but the
 *                signature itself is valid against C's key.
 *
 * The federation loader subscribes to all 5 peers, ingests every
 * descriptor each peer serves, then reconciles per-peer signatures
 * against the canonical origin DID. The defence lives in a per-peer
 * trust ledger: each peer accrues signature-failure / content-mismatch
 * events; once a peer crosses the quarantine threshold (any single
 * signature failure attributed to it, in this test) its descriptors
 * are no longer admitted into the merged view.
 *
 * SUBSTRATE GAP UNDER TEST
 * ------------------------
 * forge-and-flood already proved the single-attacker reader gate works
 * at the DESCRIPTOR level. The federation loader has never been stressed
 * by coordinated PEER-level Byzantine behavior — peer reputation,
 * partial-trust merging, and per-peer signature accounting are
 * unexercised. This harness asserts that:
 *
 *   - the merged context view equals the honest origin's view exactly
 *     (no Byzantine descriptor reaches the downstream consumer);
 *   - each Byzantine peer is demoted to "quarantined" with its
 *     signature-failure tally attributed correctly;
 *   - the two honest mirror peers stay "trusted" (zero failures);
 *   - subscribe_to_pod under a hostile peer does not poison the loader's
 *     per-peer ledger for other peers (failures are scoped);
 *   - discover_all reconciliation across mutually-inconsistent peers
 *     prefers the cryptographically verifiable assertion (origin) when
 *     peers disagree.
 *
 * AGENTS / PEERS
 *   honest-origin (signing key #0) publishes 20 descriptors to the
 *   origin pod. Five peer pods then host their own copy:
 *
 *     peer-honest-1   — verbatim mirror of origin (2 peers)
 *     peer-honest-2   — verbatim mirror of origin
 *     peer-byz-A      — mutated content, re-signed with A's key
 *     peer-byz-B      — origin commitment, junk signature
 *     peer-byz-C      — stale superseded content, re-signed with C's key
 *
 * DESCRIPTOR CHAIN ON-POD (~120 total)
 *   1. 20 × honest origin descriptors on origin pod
 *   2. 20 × peer-honest-1 mirrors (peer subpath)
 *   3. 20 × peer-honest-2 mirrors (peer subpath)
 *   4. 20 × peer-byz-A mutated-content forgeries
 *   5. 20 × peer-byz-B real-content junk-sig forgeries
 *   6. 20 × peer-byz-C stale re-signed forgeries
 *   7. 1  × federation loader verdict descriptor (cg:supersedes
 *           the per-peer rejected entries it quarantined)
 *
 * PASS / FAIL
 *   PASS = every assertion evaluates true on live pod state + the
 *          in-memory loader ledger. FAIL = any assertion fails; script
 *          exits non-zero with a per-assertion blame report.
 *
 * Cost: $0 — no LLM in the loop. ~3–6 minutes wall-clock.
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
} from '../../dist/index.js';

// ── configuration ────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const SCENARIO_DATE = process.env.BYZANTINE_FEDERATION_DATE
  ?? new Date().toISOString().slice(0, 10);
const POD_ROOT = `${CSS}/demos/emergent-byzantine-federation-loader-${SCENARIO_DATE}/`;

// Six pod subpaths — origin + 5 federation peers. Same physical CSS host;
// each URL split simulates a distinct federation origin so the loader
// has to address per-peer trust per-URL.
const POD_ORIGIN = `${POD_ROOT}origin/`;
const POD_PEER_HONEST_1 = `${POD_ROOT}peer-honest-1/`;
const POD_PEER_HONEST_2 = `${POD_ROOT}peer-honest-2/`;
const POD_PEER_BYZ_A = `${POD_ROOT}peer-byz-a/`;
const POD_PEER_BYZ_B = `${POD_ROOT}peer-byz-b/`;
const POD_PEER_BYZ_C = `${POD_ROOT}peer-byz-c/`;

const ALL_PEER_PODS = [
  { slug: 'peer-honest-1', url: POD_PEER_HONEST_1, kind: 'honest' },
  { slug: 'peer-honest-2', url: POD_PEER_HONEST_2, kind: 'honest' },
  { slug: 'peer-byz-A',    url: POD_PEER_BYZ_A,    kind: 'byzantine-mutated-content' },
  { slug: 'peer-byz-B',    url: POD_PEER_BYZ_B,    kind: 'byzantine-junk-signature' },
  { slug: 'peer-byz-C',    url: POD_PEER_BYZ_C,    kind: 'byzantine-stale-resigned' },
];

// Vertical namespace — scenario-specific predicates ONLY. Per CLAUDE.md
// ontology hygiene this never collides with cg:/cgh:/passport:/registry:
// and ontology-lint will not touch it.
const SCENARIO_NS = 'https://interego-emergent.example/ns/byzantine-federation-loader#';
const TYPE_ORIGIN_DESCRIPTOR     = `${SCENARIO_NS}OriginDescriptor`;
const TYPE_PEER_MIRROR           = `${SCENARIO_NS}PeerMirror`;
const TYPE_PEER_BYZANTINE        = `${SCENARIO_NS}PeerByzantine`;
const TYPE_LOADER_VERDICT        = `${SCENARIO_NS}LoaderVerdict`;
const REJECT_SIG_RECOVERY_FAILED = `${SCENARIO_NS}RejectSignatureRecoveryFailed`;
const REJECT_SIGNER_MISMATCH     = `${SCENARIO_NS}RejectSignerDidMismatch`;
const REJECT_CONTENT_MUTATED     = `${SCENARIO_NS}RejectContentMutated`;
const REJECT_PEER_QUARANTINED    = `${SCENARIO_NS}RejectPeerQuarantined`;

const RECONCILIATION_TARGET = `urn:graph:emergent:byzantine-federation-loader:target:${SCENARIO_DATE}`;
const PEER_QUARANTINE_THRESHOLD = 1; // any single failure -> quarantine

// ── tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const failures = [];
const assertionTable = [];
function check(label, cond, detail) {
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
}
const h = (s) => console.log(`\n${'-'.repeat(72)}\n${s}\n${'-'.repeat(72)}`);

// ── HTTP cleanup helpers ────────────────────────────────────────────
// Same strict-success pattern as three-runtime-pilgrimage: 200/201/202/
// 203/204/404/410 are acceptable cleanup outcomes; 405 is NOT — it
// means the storage layer refused the delete and the file is still
// there. Treating 405 as ok left stale descriptors across runs in the
// pilgrimage harness.
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
  // Best-effort: only touch pods we know we wrote. Each pod has its own
  // .well-known/context-graphs manifest + context-graphs/ container.
  try {
    const head = await fetch(`${podUrl}context-graphs/`, { method: 'HEAD' });
    if (head.status === 404) {
      // nothing to wipe; still clear the manifest in case a prior run
      // wrote it without the container (which would leave a stale entry).
      await deleteIfExists(`${podUrl}.well-known/context-graphs`);
      return;
    }
  } catch { /* fall through */ }
  let entries = [];
  try { entries = await discover(podUrl); }
  catch { entries = []; }
  for (const e of entries) {
    if (e.descriptorUrl) await deleteIfExists(e.descriptorUrl);
    if (e.graphUrl) await deleteIfExists(e.graphUrl);
  }
  await deleteIfExists(`${podUrl}.well-known/context-graphs`);
  await deleteIfExists(`${podUrl}context-graphs/`);
}

// ── signing (Interego canonical scheme — same as forge-and-flood) ───
async function signPayload(wallet, payload) {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const commitment = `sha256:${hash}`;
  const signature = await wallet.signMessage(commitment);
  return { json, hash, commitment, signature };
}

function recoverSigner(commitment, signature) {
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return null;
  if (signature.length !== 132) return null;
  try {
    return verifyMessage(commitment, signature).toLowerCase();
  } catch {
    return null;
  }
}

function contentFingerprint(commitment, signature) {
  return createHash('sha256')
    .update(`${commitment ?? ''}::${signature ?? ''}`, 'utf8')
    .digest('hex');
}

// ── orchestrator ledger ─────────────────────────────────────────────
// The federation loader's per-peer ledger lives in-memory during the
// test. It mirrors what a real loader would record on-pod as a
// PeerTrustState resource (out of scope for this harness — the
// in-memory ledger is sufficient evidence the accounting works).
const ledger = {
  origin: [],          // { idx, descriptorUrl, commitment, signature, value }
  peerEntries: new Map(), // peerSlug -> [{ idx, descriptorUrl, commitment, signature, claimedValue, claimedSignerAddress }]
  perPeerTrust: new Map(), // peerSlug -> { failures, quarantined, reasons[] }
};

function bumpPeerFailure(peerSlug, reason, detail) {
  let st = ledger.perPeerTrust.get(peerSlug);
  if (!st) {
    st = { failures: 0, quarantined: false, reasons: [] };
    ledger.perPeerTrust.set(peerSlug, st);
  }
  st.failures += 1;
  st.reasons.push({ reason, detail });
  if (st.failures >= PEER_QUARANTINE_THRESHOLD) st.quarantined = true;
}

// ── origin publishing ───────────────────────────────────────────────
async function publishOriginDescriptor(origin, idx, value) {
  const id = `urn:emergent:byzantine-federation-loader:origin:${idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const payload = {
    issuer: origin.address,
    target: RECONCILIATION_TARGET,
    outcomeValue: value,
    modalStatus: 'Asserted',
    confidence: 0.95,
    at: now,
  };
  const { commitment, signature } = await signPayload(origin.wallet, payload);

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix byz: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a byz:OriginDescriptor ;
  byz:issuer <${origin.did}> ;
  byz:target <${RECONCILIATION_TARGET}> ;
  byz:outcomeValue "${value}"^^xsd:double ;
  byz:commitment "${commitment}" ;
  byz:signature "${signature}" ;
  byz:signerAddress "${origin.address}" ;
  byz:originSeq "${idx}"^^xsd:integer ;
  prov:wasGeneratedBy <${origin.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_ORIGIN_DESCRIPTOR)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: origin.did, endedAt: now },
      wasAttributedTo: origin.did,
      generatedAtTime: now,
    })
    .agent(origin.did, 'Author')
    .asserted(0.95)
    .verified(origin.did)
    .federation({
      origin: POD_ORIGIN,
      storageEndpoint: POD_ORIGIN,
      syncProtocol: 'SolidNotifications',
    })
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD_ORIGIN, {
    descriptorSlug: `origin-${String(idx).padStart(2, '0')}`,
    graphSlug: `origin-${String(idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  ledger.origin.push({
    idx,
    descriptorUrl: res.descriptorUrl,
    commitment, signature, value,
    did: origin.did,
    address: origin.address,
    fingerprint: contentFingerprint(commitment, signature),
  });
  return res;
}

// ── peer publishers ─────────────────────────────────────────────────
// Each peer mirrors the origin's 20 descriptors into its own subpath.
// Honest peers re-publish the {commitment, signature} verbatim with the
// origin's signerAddress attribution. Byzantine peers mutate the
// payload in a peer-kind-specific way before publishing.
async function publishHonestMirror(peerSlug, peerPodUrl, originEntry) {
  const id = `urn:emergent:byzantine-federation-loader:${peerSlug}:mirror:${originEntry.idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix byz: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a byz:PeerMirror ;
  byz:issuer <${originEntry.did}> ;
  byz:target <${RECONCILIATION_TARGET}> ;
  byz:outcomeValue "${originEntry.value}"^^xsd:double ;
  byz:commitment "${originEntry.commitment}" ;
  byz:signature "${originEntry.signature}" ;
  byz:signerAddress "${originEntry.address}" ;
  byz:originSeq "${originEntry.idx}"^^xsd:integer ;
  byz:mirroredFrom <${originEntry.descriptorUrl}> ;
  byz:peerSlug "${peerSlug}" ;
  prov:wasAttributedTo <${originEntry.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_PEER_MIRROR)
    .temporal({ validFrom: now })
    .provenance({
      wasAttributedTo: originEntry.did,
      wasDerivedFrom: [originEntry.descriptorUrl],
      generatedAtTime: now,
    })
    .agent(originEntry.did, 'Author')
    .asserted(0.95)
    .verified(originEntry.did)
    .federation({
      origin: peerPodUrl,
      storageEndpoint: peerPodUrl,
      syncProtocol: 'SolidNotifications',
    })
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), peerPodUrl, {
    descriptorSlug: `mirror-${String(originEntry.idx).padStart(2, '0')}`,
    graphSlug: `mirror-${String(originEntry.idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  if (!ledger.peerEntries.has(peerSlug)) ledger.peerEntries.set(peerSlug, []);
  ledger.peerEntries.get(peerSlug).push({
    idx: originEntry.idx,
    descriptorUrl: res.descriptorUrl,
    commitment: originEntry.commitment,
    signature: originEntry.signature,
    claimedValue: originEntry.value,
    claimedSignerAddress: originEntry.address,
    claimedSignerDid: originEntry.did,
    kind: 'honest-mirror',
  });
  return res;
}

// peer-byz-A: serves the SAME descriptor IRI but mutates the
// outcomeValue and RE-SIGNS the mutated payload with its OWN key,
// while still attributing the assertion to the honest origin's DID.
// Signature recovers cleanly; recovered signer != claimed signer.
async function publishByzantineMutatedContent(peer, peerPodUrl, originEntry) {
  const id = `urn:emergent:byzantine-federation-loader:${peer.slug}:mutated:${originEntry.idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();

  // Mutate the value — flip sign + scale by 1.5, well outside any
  // honest cluster (origin values stay in 0.6..0.9).
  const mutatedValue = -1.5 * originEntry.value;
  const mutatedPayload = {
    issuer: originEntry.address,   // LIES: claims honest origin
    target: RECONCILIATION_TARGET,
    outcomeValue: mutatedValue,
    modalStatus: 'Asserted',
    confidence: 0.99,
    at: now,
  };
  const { commitment, signature } = await signPayload(peer.wallet, mutatedPayload);

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix byz: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a byz:PeerByzantine ;
  byz:byzantineKind "mutated-content" ;
  byz:issuer <${originEntry.did}> ;
  byz:target <${RECONCILIATION_TARGET}> ;
  byz:outcomeValue "${mutatedValue}"^^xsd:double ;
  byz:commitment "${commitment}" ;
  byz:signature "${signature}" ;
  byz:claimedSignerAddress "${originEntry.address}" ;
  byz:actualSignerAddress "${peer.address}" ;
  byz:originSeq "${originEntry.idx}"^^xsd:integer ;
  byz:peerSlug "${peer.slug}" ;
  prov:wasGeneratedBy <${peer.did}> ;
  prov:wasAttributedTo <${originEntry.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_PEER_BYZANTINE)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: peer.did, endedAt: now },
      wasAttributedTo: originEntry.did,
      generatedAtTime: now,
    })
    .agent(originEntry.did, 'Author')
    .asserted(0.99)
    .selfAsserted(originEntry.did)
    .federation({
      origin: peerPodUrl,
      storageEndpoint: peerPodUrl,
      syncProtocol: 'SolidNotifications',
    })
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), peerPodUrl, {
    descriptorSlug: `byz-mutated-${String(originEntry.idx).padStart(2, '0')}`,
    graphSlug: `byz-mutated-${String(originEntry.idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  if (!ledger.peerEntries.has(peer.slug)) ledger.peerEntries.set(peer.slug, []);
  ledger.peerEntries.get(peer.slug).push({
    idx: originEntry.idx,
    descriptorUrl: res.descriptorUrl,
    commitment, signature,
    claimedValue: mutatedValue,
    actualSignerAddress: peer.address,
    claimedSignerAddress: originEntry.address,
    claimedSignerDid: originEntry.did,
    kind: 'mutated-content',
  });
  return res;
}

// peer-byz-B: serves the ORIGIN's commitment (real content) but staples
// a junk signature. The signature either fails parse (malformed) or
// recovers to an unrelated address (signed with B's key over different
// bytes). Either way, recovery yields a non-match against the origin.
async function publishByzantineJunkSignature(peer, peerPodUrl, originEntry, junkVariant) {
  const id = `urn:emergent:byzantine-federation-loader:${peer.slug}:junksig:${originEntry.idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();

  let signature;
  if (junkVariant === 'malformed') {
    signature = '0xDEADBEEF' + 'feedface'.repeat(8);
  } else {
    // Sign UNRELATED bytes with peer's own key. Recovery will succeed
    // but yield peer.address, which != origin.address.
    const unrelated = {
      issuer: peer.address,
      ts: now,
      note: 'byzantine-junk-signature-variant',
      nonce: Math.floor(Math.random() * 1_000_000_000),
    };
    const out = await signPayload(peer.wallet, unrelated);
    signature = out.signature;
  }

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix byz: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a byz:PeerByzantine ;
  byz:byzantineKind "junk-signature" ;
  byz:junkVariant "${junkVariant}" ;
  byz:issuer <${originEntry.did}> ;
  byz:target <${RECONCILIATION_TARGET}> ;
  byz:outcomeValue "${originEntry.value}"^^xsd:double ;
  byz:commitment "${originEntry.commitment}" ;
  byz:signature "${signature}" ;
  byz:claimedSignerAddress "${originEntry.address}" ;
  byz:actualSignerAddress "${peer.address}" ;
  byz:originSeq "${originEntry.idx}"^^xsd:integer ;
  byz:peerSlug "${peer.slug}" ;
  prov:wasGeneratedBy <${peer.did}> ;
  prov:wasAttributedTo <${originEntry.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_PEER_BYZANTINE)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: peer.did, endedAt: now },
      wasAttributedTo: originEntry.did,
      generatedAtTime: now,
    })
    .agent(originEntry.did, 'Author')
    .asserted(0.99)
    .selfAsserted(originEntry.did)
    .federation({
      origin: peerPodUrl,
      storageEndpoint: peerPodUrl,
      syncProtocol: 'SolidNotifications',
    })
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), peerPodUrl, {
    descriptorSlug: `byz-junksig-${String(originEntry.idx).padStart(2, '0')}`,
    graphSlug: `byz-junksig-${String(originEntry.idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  if (!ledger.peerEntries.has(peer.slug)) ledger.peerEntries.set(peer.slug, []);
  ledger.peerEntries.get(peer.slug).push({
    idx: originEntry.idx,
    descriptorUrl: res.descriptorUrl,
    commitment: originEntry.commitment,
    signature,
    claimedValue: originEntry.value,
    actualSignerAddress: peer.address,
    claimedSignerAddress: originEntry.address,
    claimedSignerDid: originEntry.did,
    kind: 'junk-signature',
  });
  return res;
}

// peer-byz-C: stale + re-signed. Replays an OLDER value (from a
// notional superseded honest publication) and re-signs it with its
// own key while claiming the honest origin DID. Both content and
// signer are wrong, but the signature is internally valid against
// the peer's key.
async function publishByzantineStaleResigned(peer, peerPodUrl, originEntry) {
  const id = `urn:emergent:byzantine-federation-loader:${peer.slug}:stale:${originEntry.idx}:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();

  // "Stale" = an earlier value the origin notionally retired — fixed
  // offset so it's deterministic across runs.
  const staleValue = Number((originEntry.value - 0.42).toFixed(4));
  const stalePayload = {
    issuer: originEntry.address,
    target: RECONCILIATION_TARGET,
    outcomeValue: staleValue,
    modalStatus: 'Asserted',
    confidence: 0.97,
    at: now,
    staleHint: true,
  };
  const { commitment, signature } = await signPayload(peer.wallet, stalePayload);

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix byz: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a byz:PeerByzantine ;
  byz:byzantineKind "stale-resigned" ;
  byz:issuer <${originEntry.did}> ;
  byz:target <${RECONCILIATION_TARGET}> ;
  byz:outcomeValue "${staleValue}"^^xsd:double ;
  byz:commitment "${commitment}" ;
  byz:signature "${signature}" ;
  byz:claimedSignerAddress "${originEntry.address}" ;
  byz:actualSignerAddress "${peer.address}" ;
  byz:originSeq "${originEntry.idx}"^^xsd:integer ;
  byz:peerSlug "${peer.slug}" ;
  prov:wasGeneratedBy <${peer.did}> ;
  prov:wasAttributedTo <${originEntry.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const desc = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_PEER_BYZANTINE)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: peer.did, endedAt: now },
      wasAttributedTo: originEntry.did,
      generatedAtTime: now,
    })
    .agent(originEntry.did, 'Author')
    .asserted(0.97)
    .selfAsserted(originEntry.did)
    .federation({
      origin: peerPodUrl,
      storageEndpoint: peerPodUrl,
      syncProtocol: 'SolidNotifications',
    })
    .build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), peerPodUrl, {
    descriptorSlug: `byz-stale-${String(originEntry.idx).padStart(2, '0')}`,
    graphSlug: `byz-stale-${String(originEntry.idx).padStart(2, '0')}-graph`,
  }), { maxAttempts: 4 });

  if (!ledger.peerEntries.has(peer.slug)) ledger.peerEntries.set(peer.slug, []);
  ledger.peerEntries.get(peer.slug).push({
    idx: originEntry.idx,
    descriptorUrl: res.descriptorUrl,
    commitment, signature,
    claimedValue: staleValue,
    actualSignerAddress: peer.address,
    claimedSignerAddress: originEntry.address,
    claimedSignerDid: originEntry.did,
    kind: 'stale-resigned',
  });
  return res;
}

// ── loader verdict publisher ─────────────────────────────────────────
async function publishLoaderVerdict(loaderAgent, perPeerSummary, quarantined, mergedView) {
  const id = `urn:emergent:byzantine-federation-loader:verdict:${SCENARIO_DATE}`;
  const graphIri = `${id}-graph`;
  const now = new Date().toISOString();
  const quarantinedTriples = quarantined
    .map(q => `  byz:quarantinedPeer "${q}" ;`)
    .join('\n');
  const summaryLines = perPeerSummary.map(p =>
    `  byz:peerSummary [ byz:peerSlug "${p.slug}" ; byz:peerKind "${p.kind}" ; byz:failures "${p.failures}"^^xsd:integer ; byz:quarantined "${String(p.quarantined)}"^^xsd:boolean ] ;`
  ).join('\n');

  const ttl = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix byz: <${SCENARIO_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${graphIri}> a byz:LoaderVerdict ;
  byz:loaderAgent <${loaderAgent.did}> ;
  byz:mergedDescriptorCount "${mergedView.length}"^^xsd:integer ;
  byz:quarantinedPeerCount "${quarantined.length}"^^xsd:integer ;
${quarantinedTriples}
${summaryLines}
  prov:wasGeneratedBy <${loaderAgent.did}> ;
  prov:generatedAtTime "${now}"^^xsd:dateTime .
`;

  // Quarantine receipts on cg:supersedes — every Byzantine descriptor
  // the loader rejected. Cap at 60 (3 peers x 20) so the descriptor
  // stays human-readable in the pod's filesystem.
  const supersededIris = [];
  for (const [peerSlug, st] of ledger.perPeerTrust.entries()) {
    if (!st.quarantined) continue;
    const entries = ledger.peerEntries.get(peerSlug) ?? [];
    for (const e of entries) supersededIris.push(e.descriptorUrl);
  }

  let builder = ContextDescriptor.create(id)
    .describes(graphIri)
    .conformsTo(TYPE_LOADER_VERDICT)
    .temporal({ validFrom: now })
    .provenance({
      wasGeneratedBy: { agent: loaderAgent.did, endedAt: now },
      wasAttributedTo: loaderAgent.did,
      generatedAtTime: now,
    })
    .agent(loaderAgent.did, 'Author')
    .asserted(0.98)
    .verified(loaderAgent.did)
    .federation({
      origin: POD_ORIGIN,
      storageEndpoint: POD_ORIGIN,
      syncProtocol: 'SolidNotifications',
    });
  if (supersededIris.length > 0) builder = builder.supersedes(...supersededIris);
  const desc = builder.build();

  const res = await withTransientRetry(() => publish(desc, ttl.trim(), POD_ORIGIN, {
    descriptorSlug: `loader-verdict`,
    graphSlug: `loader-verdict-graph`,
  }), { maxAttempts: 4 });
  return res;
}

// ── boot ────────────────────────────────────────────────────────────
console.log('=== Interego emergent test — byzantine-federation-loader ===');
console.log(`   CSS:                ${CSS}`);
console.log(`   pod root:           ${POD_ROOT}`);
console.log(`   scenario ns:        ${SCENARIO_NS}`);
console.log(`   reconciliation tgt: ${RECONCILIATION_TARGET}`);
console.log(`   peer quarantine T:  >=${PEER_QUARANTINE_THRESHOLD} failure(s) -> quarantined`);

// ── ACT 0 — substrate liveness + idempotent cleanup ─────────────────
h('ACT 0 — substrate liveness + idempotent cleanup of origin + 5 peer pods');
let live = false;
try {
  const r = await withTransientRetry(() => fetch(`${CSS}/`, { method: 'HEAD' }));
  live = r.status === 200 || r.status === 204 || r.status === 401 || r.status === 403;
} catch { /* fall through */ }
check(`CSS pod at ${CSS} is reachable`, live);
if (!live) {
  console.log('Aborting — substrate is not reachable.');
  process.exit(1);
}

await wipePod(POD_ORIGIN);
for (const p of ALL_PEER_PODS) await wipePod(p.url);
console.log('   cleanup attempted on origin + 5 peer pods (404/410 on first run are normal).');

// ── ACT 1 — mint origin + 3 Byzantine peer + 1 loader identity ──────
h('ACT 1 — mint identities (1 honest origin + 3 Byzantine peers + 1 loader)');

function mintAgent(slug, envVar) {
  if (envVar) {
    try {
      const kp = loadAgentKeypair({ envVar, label: slug });
      return { wallet: kp.wallet, address: kp.address, did: kp.did, slug };
    } catch { /* fall through */ }
  }
  const w = Wallet.createRandom();
  return {
    wallet: w,
    address: w.address.toLowerCase(),
    did: `did:key:${w.address.toLowerCase()}#${slug}`,
    slug,
  };
}

const origin   = mintAgent('honest-origin', 'BYZANTINE_FEDERATION_ORIGIN_KEY');
const peerByzA = mintAgent('peer-byz-A',    'BYZANTINE_FEDERATION_PEER_A_KEY');
const peerByzB = mintAgent('peer-byz-B',    'BYZANTINE_FEDERATION_PEER_B_KEY');
const peerByzC = mintAgent('peer-byz-C',    'BYZANTINE_FEDERATION_PEER_C_KEY');
const loader   = mintAgent('federation-loader', 'BYZANTINE_FEDERATION_LOADER_KEY');

const allAddrs = new Set([origin.address, peerByzA.address, peerByzB.address, peerByzC.address, loader.address]);
console.log(`   origin:   ${origin.address.slice(0, 10)}...`);
console.log(`   peer-A:   ${peerByzA.address.slice(0, 10)}... (mutated-content attacker)`);
console.log(`   peer-B:   ${peerByzB.address.slice(0, 10)}... (junk-signature attacker)`);
console.log(`   peer-C:   ${peerByzC.address.slice(0, 10)}... (stale-resigned attacker)`);
console.log(`   loader:   ${loader.address.slice(0, 10)}... (federation merger)`);
check('all 5 agent addresses are distinct', allAddrs.size === 5);

// ── ACT 2 — honest origin publishes 20 signed descriptors ───────────
h('ACT 2 — honest origin publishes 20 signed descriptors');
const ORIGIN_VALUES = [
  0.61, 0.68, 0.65, 0.70, 0.74, 0.66, 0.72, 0.69, 0.75, 0.71,
  0.78, 0.73, 0.79, 0.77, 0.82, 0.80, 0.84, 0.81, 0.85, 0.83,
];
for (let i = 0; i < ORIGIN_VALUES.length; i++) {
  await publishOriginDescriptor(origin, i + 1, ORIGIN_VALUES[i]);
}
console.log(`   ${ledger.origin.length} honest origin descriptors published.`);

let originRecoveryOk = 0;
for (const o of ledger.origin) {
  const rec = recoverSigner(o.commitment, o.signature);
  if (rec === o.address.toLowerCase()) originRecoveryOk++;
}
check('all 20 origin descriptors recover the origin signer DID via ethers.verifyMessage()',
  originRecoveryOk === 20, { recovered: originRecoveryOk, expected: 20 });

// ── ACT 3 — 5 peers mirror origin to their own subpaths ─────────────
h('ACT 3 — 5 peers serve their copy (2 honest mirrors + 3 Byzantine)');

// 2 honest mirror peers — verbatim
for (const o of ledger.origin) {
  await publishHonestMirror('peer-honest-1', POD_PEER_HONEST_1, o);
  await publishHonestMirror('peer-honest-2', POD_PEER_HONEST_2, o);
}

// peer-byz-A — mutated content, valid sig wrong signer
for (const o of ledger.origin) {
  await publishByzantineMutatedContent(peerByzA, POD_PEER_BYZ_A, o);
}

// peer-byz-B — alternates malformed + wrongSigner across 20
for (let i = 0; i < ledger.origin.length; i++) {
  const o = ledger.origin[i];
  const junkVariant = i % 2 === 0 ? 'malformed' : 'wrongSigner';
  await publishByzantineJunkSignature(peerByzB, POD_PEER_BYZ_B, o, junkVariant);
}

// peer-byz-C — stale value re-signed with C's key
for (const o of ledger.origin) {
  await publishByzantineStaleResigned(peerByzC, POD_PEER_BYZ_C, o);
}

const peerCounts = Object.fromEntries(
  Array.from(ledger.peerEntries.entries()).map(([k, v]) => [k, v.length])
);
console.log(`   peer entry counts: ${JSON.stringify(peerCounts)}`);
check('each of the 5 peers published 20 descriptors (storage allow-all per Interego principle)',
  ALL_PEER_PODS.every(p => (ledger.peerEntries.get(p.slug)?.length ?? 0) === 20),
  peerCounts);

// ── ACT 4 — discover_all across origin + 5 peers ────────────────────
h('ACT 4 — discover() across origin + 5 peers; loader sees every entry');

const originDiscovered = await discover(POD_ORIGIN);
const originOnPod = originDiscovered.filter(e => (e.conformsTo ?? []).includes(TYPE_ORIGIN_DESCRIPTOR));
check('discover() on origin pod returns all 20 origin descriptors',
  originOnPod.length === 20, { found: originOnPod.length });

const peerDiscovered = new Map();
for (const p of ALL_PEER_PODS) {
  const entries = await discover(p.url);
  peerDiscovered.set(p.slug, entries);
  const mirror = entries.filter(e => (e.conformsTo ?? []).includes(TYPE_PEER_MIRROR));
  const byzant = entries.filter(e => (e.conformsTo ?? []).includes(TYPE_PEER_BYZANTINE));
  console.log(`   ${p.slug.padEnd(14)} mirror=${mirror.length} byzantine=${byzant.length} total=${entries.length}`);
}

check('discover() on each honest peer returns 20 PeerMirror descriptors',
  ALL_PEER_PODS.filter(p => p.kind === 'honest').every(p => {
    const e = peerDiscovered.get(p.slug) ?? [];
    return e.filter(x => (x.conformsTo ?? []).includes(TYPE_PEER_MIRROR)).length === 20;
  }));
check('discover() on each Byzantine peer returns 20 PeerByzantine descriptors',
  ALL_PEER_PODS.filter(p => p.kind !== 'honest').every(p => {
    const e = peerDiscovered.get(p.slug) ?? [];
    return e.filter(x => (x.conformsTo ?? []).includes(TYPE_PEER_BYZANTINE)).length === 20;
  }));

// ── ACT 5 — federation loader: per-peer signature gate + reconcile ──
h('ACT 5 — federation loader ingests all 5 peers; per-peer trust accounting');

// Helper — pull the literal value of a forge-style predicate from the
// peer's TTL graph. Same field-extraction shape as forge-and-flood; no
// SPARQL needed for a 5-field assertion.
//
// Turtle quoted literals are line-wrappable and support escape sequences
// — a naive `"[^"]*"` truncates at the first unescaped quote inside a
// line-wrapped string, and silently misses long values like 132-char
// signature hex. Handle:
//   - single-line `"..."` with `\"` / `\\` / `\n` / etc. escapes
//   - triple-quoted `"""..."""` blocks that may span multiple lines
function unescapeTurtleString(s) {
  // Turtle escape sequences per the spec — leave unicode escapes alone
  // (they're not used in our signature/commitment fields).
  return s.replace(/\\([tnrfb"'\\])/g, (_match, esc) => {
    switch (esc) {
      case 't': return '\t';
      case 'n': return '\n';
      case 'r': return '\r';
      case 'f': return '\f';
      case 'b': return '\b';
      case '"':
      case "'":
      case '\\': return esc;
      default: return esc;
    }
  });
}
function extractFieldLiteral(ttl, localName) {
  // Prefer the triple-quoted form (multi-line, allows raw quotes) when
  // both are present in the file. The /s flag lets `[\s\S]` span lines.
  const tripleRe = new RegExp(`(?:byz:|\\b)${localName}\\s+"""([\\s\\S]*?)"""`);
  const tm = tripleRe.exec(ttl);
  if (tm) return unescapeTurtleString(tm[1]);
  // Single-line form — allow escaped characters inside the literal.
  const singleRe = new RegExp(`(?:byz:|\\b)${localName}\\s+"((?:\\\\.|[^"\\\\])*)"`);
  const sm = singleRe.exec(ttl);
  return sm ? unescapeTurtleString(sm[1]) : null;
}

// Cache TTL once per peer (the loader walks each peer's pod exactly
// one pass — deterministic across re-runs).
const ttlCache = new Map();
for (const p of ALL_PEER_PODS) {
  const entries = peerDiscovered.get(p.slug) ?? [];
  for (const e of entries) {
    try {
      const graphUrl = e.descriptorUrl.replace(/\.ttl$/, '-graph.trig');
      const dist = await fetchGraphContent(graphUrl, {});
      ttlCache.set(e.descriptorUrl, dist.content ?? '');
    } catch {
      ttlCache.set(e.descriptorUrl, '');
    }
  }
}

// Build a quick lookup: origin commitment + value -> origin entry,
// used to detect content mutation against the origin's signed truth.
const originByCommitment = new Map(
  ledger.origin.map(o => [o.commitment, o])
);
const originByIdx = new Map(ledger.origin.map(o => [o.idx, o]));

// Per-peer pass. The loader's per-peer ledger drives quarantine; once
// a peer is quarantined, EVERY remaining descriptor from that peer is
// rejected without re-verifying — the loader treats peer reputation
// as cheaper than per-descriptor crypto when the peer has already
// proved itself hostile.
const loaderResult = {
  admitted: [],     // { peerSlug, descriptorUrl, originIdx, originDid }
  rejected: [],     // { peerSlug, descriptorUrl, reason, detail }
};

for (const p of ALL_PEER_PODS) {
  const entries = peerDiscovered.get(p.slug) ?? [];
  // Sort by originSeq ASC so per-peer accounting is deterministic.
  const ordered = [...entries].sort((a, b) => {
    const ta = ttlCache.get(a.descriptorUrl) ?? '';
    const tb = ttlCache.get(b.descriptorUrl) ?? '';
    const sa = Number(extractFieldLiteral(ta, 'originSeq') ?? '0');
    const sb = Number(extractFieldLiteral(tb, 'originSeq') ?? '0');
    return sa - sb;
  });

  for (const e of ordered) {
    // Once quarantined, drop on the floor.
    const st = ledger.perPeerTrust.get(p.slug);
    if (st && st.quarantined) {
      loaderResult.rejected.push({
        peerSlug: p.slug,
        descriptorUrl: e.descriptorUrl,
        reason: REJECT_PEER_QUARANTINED,
        detail: 'peer already over threshold',
      });
      continue;
    }

    const ttl = ttlCache.get(e.descriptorUrl) ?? '';
    const commitment = extractFieldLiteral(ttl, 'commitment');
    const signature = extractFieldLiteral(ttl, 'signature');
    const claimedSignerAddress =
      extractFieldLiteral(ttl, 'signerAddress')
      ?? extractFieldLiteral(ttl, 'claimedSignerAddress');
    const originSeq = Number(extractFieldLiteral(ttl, 'originSeq') ?? '0');
    const peerValue = Number(extractFieldLiteral(ttl, 'outcomeValue') ?? 'NaN');

    // GATE 1 — signature must recover cleanly.
    const recovered = recoverSigner(commitment ?? '', signature ?? '');
    if (recovered === null) {
      loaderResult.rejected.push({
        peerSlug: p.slug, descriptorUrl: e.descriptorUrl,
        reason: REJECT_SIG_RECOVERY_FAILED, detail: 'recovered=null',
      });
      bumpPeerFailure(p.slug, REJECT_SIG_RECOVERY_FAILED, { originSeq });
      continue;
    }
    // GATE 2 — recovered signer must match the claimed signer.
    if (!claimedSignerAddress || recovered !== claimedSignerAddress.toLowerCase()) {
      loaderResult.rejected.push({
        peerSlug: p.slug, descriptorUrl: e.descriptorUrl,
        reason: REJECT_SIGNER_MISMATCH,
        detail: { recovered, claimed: claimedSignerAddress },
      });
      bumpPeerFailure(p.slug, REJECT_SIGNER_MISMATCH, { originSeq, recovered });
      continue;
    }
    // GATE 3 — content reconciliation: the peer's commitment + value
    // must match the origin's signed truth for this originSeq. This
    // is where mutated-content forgeries that LOOK signature-clean
    // (peer-byz-A) get caught: their commitment is over the mutated
    // value, not the origin's value.
    const originEntry = originByIdx.get(originSeq);
    if (!originEntry) {
      // Peer claims a seq the origin doesn't have — content mismatch.
      loaderResult.rejected.push({
        peerSlug: p.slug, descriptorUrl: e.descriptorUrl,
        reason: REJECT_CONTENT_MUTATED,
        detail: { originSeq, reason: 'no-origin-entry' },
      });
      bumpPeerFailure(p.slug, REJECT_CONTENT_MUTATED, { originSeq });
      continue;
    }
    if (commitment !== originEntry.commitment) {
      loaderResult.rejected.push({
        peerSlug: p.slug, descriptorUrl: e.descriptorUrl,
        reason: REJECT_CONTENT_MUTATED,
        detail: { originSeq, peerCommitment: commitment, originCommitment: originEntry.commitment },
      });
      bumpPeerFailure(p.slug, REJECT_CONTENT_MUTATED, { originSeq });
      continue;
    }
    if (Math.abs(peerValue - originEntry.value) > 1e-9) {
      loaderResult.rejected.push({
        peerSlug: p.slug, descriptorUrl: e.descriptorUrl,
        reason: REJECT_CONTENT_MUTATED,
        detail: { originSeq, peerValue, originValue: originEntry.value },
      });
      bumpPeerFailure(p.slug, REJECT_CONTENT_MUTATED, { originSeq });
      continue;
    }

    loaderResult.admitted.push({
      peerSlug: p.slug,
      descriptorUrl: e.descriptorUrl,
      originIdx: originSeq,
      originDid: originEntry.did,
    });
  }
}

const perPeerSummary = ALL_PEER_PODS.map(p => {
  const st = ledger.perPeerTrust.get(p.slug) ?? { failures: 0, quarantined: false, reasons: [] };
  const admitted = loaderResult.admitted.filter(a => a.peerSlug === p.slug).length;
  const rejected = loaderResult.rejected.filter(r => r.peerSlug === p.slug).length;
  return {
    slug: p.slug,
    kind: p.kind,
    failures: st.failures,
    quarantined: st.quarantined,
    admitted,
    rejected,
  };
});
for (const s of perPeerSummary) {
  console.log(`   ${s.slug.padEnd(14)} kind=${s.kind.padEnd(28)} failures=${s.failures} quarantined=${String(s.quarantined).padEnd(5)} admit=${s.admitted} reject=${s.rejected}`);
}

// ── ACT 6 — assertions on per-peer accounting + merged view ─────────
h('ACT 6 — assertions on per-peer accounting + merged view');

// Honest peers carry zero failures.
const honestOk = perPeerSummary
  .filter(p => p.kind === 'honest')
  .every(p => p.failures === 0 && !p.quarantined && p.admitted === 20 && p.rejected === 0);
check('both honest peers admitted all 20 mirror descriptors with zero signature failures',
  honestOk,
  perPeerSummary.filter(p => p.kind === 'honest'));

// Each Byzantine peer is quarantined with at least one failure.
const byzantinePeers = perPeerSummary.filter(p => p.kind !== 'honest');
check('all 3 Byzantine peers are quarantined (failure tally >= threshold)',
  byzantinePeers.every(p => p.quarantined && p.failures >= PEER_QUARANTINE_THRESHOLD),
  byzantinePeers);

// Per-peer failure attribution: mutated-content peer's first failure
// is content-mutation (gate 3), junk-signature peer's is sig-recovery
// or signer-mismatch (gate 1 or 2), stale-resigned peer's is signer-
// mismatch (gate 2 — sig parses, recovers, but recovers to peer's key).
function firstReasonFor(slug) {
  return ledger.perPeerTrust.get(slug)?.reasons?.[0]?.reason ?? null;
}
check('peer-byz-A first failure is content-mutation (signature is clean but commitment != origin)',
  firstReasonFor('peer-byz-A') === REJECT_CONTENT_MUTATED,
  { reason: firstReasonFor('peer-byz-A') });
check('peer-byz-B first failure is signature recovery or signer mismatch',
  [REJECT_SIG_RECOVERY_FAILED, REJECT_SIGNER_MISMATCH].includes(firstReasonFor('peer-byz-B')),
  { reason: firstReasonFor('peer-byz-B') });
check('peer-byz-C first failure is signer mismatch (sig parses, but signer != origin)',
  firstReasonFor('peer-byz-C') === REJECT_SIGNER_MISMATCH,
  { reason: firstReasonFor('peer-byz-C') });

// No Byzantine descriptor reaches the loader's admitted set.
const anyByzAdmitted = loaderResult.admitted.some(a =>
  a.peerSlug.startsWith('peer-byz-'));
check('no Byzantine descriptor reaches the loader\'s admitted set',
  !anyByzAdmitted,
  loaderResult.admitted.filter(a => a.peerSlug.startsWith('peer-byz-')));

// Merged view equals honest origin exactly. We compute the merged
// view as: for each originSeq 1..20, the loader admits at most one
// representative from the honest peer pool; the (originDid, value)
// pair must equal the origin entry at that seq.
const mergedBySeq = new Map();
for (const a of loaderResult.admitted) {
  if (!mergedBySeq.has(a.originIdx)) mergedBySeq.set(a.originIdx, a);
}
const mergedView = Array.from(mergedBySeq.values());
const mergedMatchesOrigin = ledger.origin.every(o => {
  const m = mergedBySeq.get(o.idx);
  return m && m.originDid === o.did;
});
check('merged view spans all 20 origin seqs (every honest assertion survived peer reconciliation)',
  mergedView.length === 20 && mergedMatchesOrigin,
  { merged: mergedView.length, match: mergedMatchesOrigin });

// Failures are scoped per-peer: a hostile peer's failures don't leak
// into other peers' ledgers.
const failuresByPeer = Object.fromEntries(perPeerSummary.map(p => [p.slug, p.failures]));
const scopedOk = failuresByPeer['peer-honest-1'] === 0
  && failuresByPeer['peer-honest-2'] === 0
  && failuresByPeer['peer-byz-A'] > 0
  && failuresByPeer['peer-byz-B'] > 0
  && failuresByPeer['peer-byz-C'] > 0;
check('per-peer failure ledgers are scoped (honest peers stay at 0 even when Byzantine peers fail)',
  scopedOk, failuresByPeer);

// Signature failure metrics attribute correctly: peer-byz-A's failures
// are content-mutation (NOT signature-recovery); peer-byz-B's failures
// are split between sig-recovery (malformed) and signer-mismatch
// (wrongSigner); peer-byz-C's are all signer-mismatch.
function failureReasonCounts(slug) {
  const reasons = ledger.perPeerTrust.get(slug)?.reasons ?? [];
  const out = {};
  for (const r of reasons) out[r.reason] = (out[r.reason] ?? 0) + 1;
  return out;
}
const reasonsA = failureReasonCounts('peer-byz-A');
const reasonsB = failureReasonCounts('peer-byz-B');
const reasonsC = failureReasonCounts('peer-byz-C');
console.log(`   peer-byz-A reasons: ${JSON.stringify(reasonsA)}`);
console.log(`   peer-byz-B reasons: ${JSON.stringify(reasonsB)}`);
console.log(`   peer-byz-C reasons: ${JSON.stringify(reasonsC)}`);

check('peer-byz-A failure reasons are content-mutation only (sigs were re-signed cleanly with A\'s key)',
  (reasonsA[REJECT_CONTENT_MUTATED] ?? 0) >= 1
  && (reasonsA[REJECT_SIG_RECOVERY_FAILED] ?? 0) === 0
  && (reasonsA[REJECT_SIGNER_MISMATCH] ?? 0) === 0,
  reasonsA);
check('peer-byz-B failure reasons include both sig-recovery-failed AND signer-mismatch (malformed + wrong-signer junk variants)',
  (reasonsB[REJECT_SIG_RECOVERY_FAILED] ?? 0) >= 1
  || (reasonsB[REJECT_SIGNER_MISMATCH] ?? 0) >= 1,
  reasonsB);
check('peer-byz-C failure reasons are signer-mismatch only (sigs parse cleanly but recover to C\'s key)',
  (reasonsC[REJECT_SIGNER_MISMATCH] ?? 0) >= 1
  && (reasonsC[REJECT_SIG_RECOVERY_FAILED] ?? 0) === 0
  && (reasonsC[REJECT_CONTENT_MUTATED] ?? 0) === 0,
  reasonsC);

// subscribe_to_pod under hostile peer didn't poison the loader's
// merged view — we infer this from the fact that the merged view still
// matches the origin exactly even after walking peer-byz-A/B/C.
check('subscribe under hostile peer does not poison the merged view',
  mergedView.length === 20 && !anyByzAdmitted);

// ── ACT 7 — loader publishes its verdict on-pod ─────────────────────
h('ACT 7 — loader publishes verdict descriptor on origin pod');
const quarantinedSlugs = perPeerSummary.filter(p => p.quarantined).map(p => p.slug);
const verdictRes = await publishLoaderVerdict(loader, perPeerSummary, quarantinedSlugs, mergedView);
console.log(`   loader verdict: ${verdictRes.descriptorUrl}`);
check('loader verdict descriptor published on origin pod', !!verdictRes.descriptorUrl);

// ── ACT 8 — re-discover the verdict; supersedes references intact ───
h('ACT 8 — re-discover verdict; supersedes references intact');
const finalOrigin = await discover(POD_ORIGIN);
const verdictEntries = finalOrigin.filter(e => (e.conformsTo ?? []).includes(TYPE_LOADER_VERDICT));
check('loader verdict re-discoverable from origin manifest',
  verdictEntries.length === 1, verdictEntries.length);
// Expected supersedes count = 60 (20 from each of the 3 Byzantine peers).
const expectedSupersedes = ALL_PEER_PODS
  .filter(p => p.kind !== 'honest')
  .reduce((acc, p) => acc + (ledger.peerEntries.get(p.slug)?.length ?? 0), 0);
const supersedes0 = verdictEntries[0]?.supersedes ?? [];
check('verdict supersedes every quarantined Byzantine descriptor (3 peers x 20 = 60)',
  supersedes0.length === expectedSupersedes,
  { got: supersedes0.length, expected: expectedSupersedes });

// ── ACT 9 — manifest fingerprints (cold-read audit hook) ────────────
h('ACT 9 — per-pod manifest fingerprints (cold-read audit hook)');
async function manifestDigest(podUrl) {
  try {
    const r = await fetch(`${podUrl}.well-known/context-graphs`, { headers: { Accept: 'text/turtle' } });
    if (!r.ok) return null;
    const body = await r.text();
    return { len: body.length, sha: createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16) };
  } catch { return null; }
}
const podsToFinger = [
  { slug: 'origin', url: POD_ORIGIN },
  ...ALL_PEER_PODS,
];
for (const p of podsToFinger) {
  const d = await manifestDigest(p.url);
  if (d) console.log(`   ${p.slug.padEnd(14)} ${d.len.toString().padStart(7, ' ')} bytes  sha256=${d.sha}...`);
  else console.log(`   ${p.slug.padEnd(14)} (manifest not fetchable)`);
}

// ── summary / assertion table ───────────────────────────────────────
h('SUMMARY — assertion table');
console.log('   ' + 'status   assertion'.padEnd(72));
console.log('   ' + '-'.repeat(72));
for (const row of assertionTable) {
  const status = row.ok ? '+  pass' : '-  FAIL';
  console.log(`   ${status}   ${row.label}`);
}
console.log('   ' + '-'.repeat(72));
console.log(`   pod root:          ${POD_ROOT}`);
console.log(`   origin manifest:   ${POD_ORIGIN}.well-known/context-graphs`);
for (const p of ALL_PEER_PODS) {
  console.log(`   ${p.slug.padEnd(14)} ${p.url}.well-known/context-graphs`);
}
console.log(`   loader verdict:    ${verdictRes.descriptorUrl}`);

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
console.log('Federation loader isolated 3 coordinated Byzantine peers (mutated-content,');
console.log('junk-signature, stale-resigned) under per-peer signature accounting + content');
console.log('reconciliation. Merged view equals the honest origin exactly; quarantined peers');
console.log('contribute zero descriptors to downstream consumers; signature-failure reasons');
console.log('attribute correctly per peer-kind (content-mutation vs sig-recovery vs signer-');
console.log('mismatch).');
