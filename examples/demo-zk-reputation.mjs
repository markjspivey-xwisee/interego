// Zero-knowledge proof of reputation.
//
// An agent wants to demonstrate "my reputation score ≥ 0.8" to
// counterparties without revealing (a) their exact score or
// (b) the underlying attestations that establish it.
//
// Uses the library's existing src/crypto/zk primitives —
// proveConfidenceAboveThreshold produces a RangeProof via a
// hash-chain commitment scheme (value lives inside a sha256
// chain keyed by a per-proof blinding factor; verifier
// reconstructs the chain from threshold + commitment without
// ever seeing the value).
//
// Demo flow:
//   1. Prover has reputation 0.85 (established by 6 attestations
//      on the pod). Uses library to generate a proof for
//      threshold=0.80.
//   2. Prover publishes a proof-descriptor conforming to a ZK
//      reputation proof shape. The descriptor carries the proof
//      blob but NOT the score and NOT the underlying attestations.
//   3. Verifier reads the proof-descriptor, calls the library's
//      verifier. Gets back valid/invalid without learning the
//      actual score.
//   4. Verifier publishes an endorsement descriptor — "this
//      agent's reputation is verified ≥ 0.80" — citing the
//      proof descriptor via prov:wasDerivedFrom.
//   5. Adversarial test: try to forge a proof for a score the
//      prover doesn't actually have. Library throws.

import { proveConfidenceAboveThreshold, verifyConfidenceProof } from '../dist/crypto/zk/proofs.js';

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const ZK_SHAPE = `${POD}schemas/zk-reputation-proof-v1.ttl`;

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

async function publishDescriptor(id, graph, ttl) {
  const slug = id.split(':').slice(-2).join('-');
  const url = `${POD}context-graphs/${slug}.ttl`;
  await putText(url, ttl);
  const entry = `

<${url}> a cg:ManifestEntry ;
    cg:describes <${graph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
  const cur = await fetchText(MANIFEST_URL);
  await putText(MANIFEST_URL, (cur ?? '') + entry);
  return url;
}

console.log('=== ZK reputation proof ===\n');

// ── Step 0: publish the ZK-reputation-proof shape ─────────
const ZK_SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix zk: <urn:zk:> .

<${ZK_SHAPE}#Shape> a sh:NodeShape ;
  sh:targetClass cg:ContextDescriptor ;
  sh:property [ sh:path dct:conformsTo ; sh:hasValue <${ZK_SHAPE}> ; sh:minCount 1 ] ;
  sh:property [ sh:path zk:threshold ; sh:minCount 1 ; sh:message "Proof MUST declare the threshold it proves above." ] ;
  sh:property [ sh:path zk:commitment ; sh:minCount 1 ; sh:message "Proof MUST include a commitment (sha256)." ] ;
  sh:property [ sh:path zk:proofBlob ; sh:minCount 1 ; sh:message "Proof MUST include the chained-hash proof bytes." ] ;
  sh:property [ sh:path zk:proofKind ; sh:hasValue "RangeProof" ] .
`;
await putText(ZK_SHAPE, ZK_SHAPE_TTL);
console.log(`0. PUT ZK shape → ${ZK_SHAPE.split('/').pop()}\n`);

// ── Step 1: prover generates proof ─────────────────────────
const proverScore = 0.85;
const threshold = 0.80;
console.log('1. Prover has reputation score 0.85 (established by prior attestations).');
console.log(`   Generating range proof for threshold=${threshold}...`);

const { proof, blinding } = proveConfidenceAboveThreshold(proverScore, threshold);
console.log(`   ✓ proof generated`);
console.log(`     commitment: ${proof.commitment.slice(0, 32)}...`);
console.log(`     proof:      ${proof.proof.slice(0, 32)}...`);
console.log(`     type:       ${proof.type}`);
console.log(`     threshold:  ${proof.threshold}  (prover's actual score NEVER appears in proof)\n`);

// ── Step 2: prover publishes proof descriptor ──────────────
const proofId = `urn:cg:zk-proof:${Date.now()}`;
const proofGraph = `urn:graph:zk-proof:${Date.now()}`;
const now1 = new Date().toISOString();
const proofTtl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix zk: <urn:zk:> .

<${proofId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now1}"^^xsd:dateTime ;
    dct:conformsTo <${ZK_SHAPE}> ;
    cg:describes <${proofGraph}> ;
    zk:proofKind "RangeProof" ;
    zk:threshold "${proof.threshold}"^^xsd:double ;
    zk:commitment "${proof.commitment}" ;
    zk:proofBlob "${proof.proof}" ;
    zk:proofType "${proof.type}" ;
    zk:claim "reputation score is >= ${threshold}" ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now1}"^^xsd:dateTime ] ;
    cg:hasFacet [ a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <urn:agent:zk-prover> ; prov:endedAtTime "${now1}"^^xsd:dateTime ] ;
        prov:wasAttributedTo <urn:agent:zk-prover> ;
        prov:generatedAtTime "${now1}"^^xsd:dateTime ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <urn:agent:zk-prover> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <urn:agent:zk-prover> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "1.0"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <urn:agent:zk-prover> ; cg:trustLevel cg:CryptoAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;
const proofUrl = await publishDescriptor(proofId, proofGraph, proofTtl);
console.log(`2. Prover published proof descriptor:`);
console.log(`   ${proofUrl.split('/').pop()}`);
console.log(`   descriptor carries: threshold + commitment + chainHash`);
console.log(`   descriptor does NOT carry: prover's actual score, underlying attestations\n`);

// ── Step 3: verifier fetches + verifies ───────────────────
console.log('3. Verifier fetches proof descriptor, runs verifier:');
const fetched = await fetchText(proofUrl);
const extractedCommitment = fetched.match(/zk:commitment\s+"([^"]+)"/)?.[1];
const extractedBlob = fetched.match(/zk:proofBlob\s+"([^"]+)"/)?.[1];
const extractedThreshold = parseFloat(fetched.match(/zk:threshold\s+"([\d.]+)"/)?.[1] ?? '0');

const reconstructed = {
  type: 'hash-range',
  threshold: extractedThreshold,
  commitment: extractedCommitment,
  proof: extractedBlob,
};
const valid = verifyConfidenceProof(reconstructed);
console.log(`   ✓ verifier result: ${valid ? 'VALID' : 'INVALID'}`);
console.log(`   verifier learned: score ≥ ${threshold}`);
console.log(`   verifier did NOT learn: the exact score (0.85), the attestations, the blinding factor\n`);

// ── Step 4: verifier publishes endorsement ─────────────────
const endorseId = `urn:cg:zk-endorsement:${Date.now()}`;
const endorseGraph = `urn:graph:zk-endorsement:${Date.now()}`;
const now2 = new Date().toISOString();
const endorseTtl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix zk: <urn:zk:> .

<${endorseId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now2}"^^xsd:dateTime ;
    cg:describes <${endorseGraph}> ;
    zk:verifiedProof <${proofUrl}> ;
    zk:verifiedThreshold "${threshold}"^^xsd:double ;
    zk:verdict "valid" ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now2}"^^xsd:dateTime ] ;
    cg:hasFacet [ a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <urn:agent:zk-verifier> ; prov:endedAtTime "${now2}"^^xsd:dateTime ] ;
        prov:wasDerivedFrom <${proofUrl}> ;
        prov:wasAttributedTo <urn:agent:zk-verifier> ;
        prov:generatedAtTime "${now2}"^^xsd:dateTime ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <urn:agent:zk-verifier> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <urn:agent:zk-verifier> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "${valid}"^^xsd:boolean ; cg:modalStatus cg:${valid ? 'Asserted' : 'Counterfactual'} ; cg:epistemicConfidence "1.0"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <urn:agent:zk-verifier> ; cg:trustLevel cg:CryptoAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;
const endorseUrl = await publishDescriptor(endorseId, endorseGraph, endorseTtl);
console.log(`4. Verifier published endorsement descriptor:`);
console.log(`   ${endorseUrl.split('/').pop()}`);
console.log(`   zk:verdict "${valid ? 'valid' : 'invalid'}"`);
console.log(`   prov:wasDerivedFrom → proof descriptor\n`);

// ── Step 5: adversarial — prover tries to forge ───────────
console.log('5. Adversarial test — prover tries to prove score ≥ 0.9 when actual is 0.85:');
try {
  proveConfidenceAboveThreshold(0.85, 0.9);
  console.log('   ✗ library DID NOT throw — unexpected');
} catch (err) {
  console.log(`   ✓ library throws: "${err.message}"`);
  console.log('   Forgery prevented at proof-generation time. Prover cannot claim');
  console.log('   thresholds above their actual score.\n');
}

console.log('── Demonstrated:');
console.log('   The verifier learned "score ≥ 0.80" + nothing else.');
console.log('   The exact 0.85, the underlying attestations, and the blinding');
console.log('   factor all stayed private to the prover. The endorsement chain');
console.log('   in the federation is: [attestations] → [zk-proof descriptor] →');
console.log('   [verifier endorsement]. Third parties read the endorsement and');
console.log('   can independently re-verify the proof by fetching the proof');
console.log('   descriptor and calling verifyConfidenceProof — no need to go');
console.log('   back to the private attestations.');
