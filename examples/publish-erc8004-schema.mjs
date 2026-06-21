// Publishes an ERC-8004-compatible AgentAttestation shape.
//
// ERC-8004 defines three registries (Identity, Reputation, Validation)
// with attestations carrying (attester, subject, claim-URI, timestamp,
// optional proof). This shape constrains descriptors that claim to be
// ERC-8004 attestations so they carry the four mandatory fields.
//
// Progressive support ladder:
//   T0 — federation-native attestation descriptor (this file)
//   T1 — + cryptographic signature facet (ethers.js ES256, already
//         in src/crypto/)
//   T2 — + on-chain anchor CID via ERC-8004 Reputation Registry
//         (hash of attestation pinned via Pinata, referenced on-chain)
//   T3 — full compliance: on-chain registration drives the attestation
//         ID space; off-chain descriptor carries the metadata.
//
// T0 claims are already forward-compatible: T1-T3 just add facets,
// never remove.

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const SHAPE_URL = `${POD}schemas/erc8004-attestation-v1.ttl`;

const SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix erc: <urn:erc:8004:> .

<${SHAPE_URL}#Shape> a sh:NodeShape ;
  sh:targetClass iep:ContextDescriptor ;
  sh:property [
    sh:path iep:modalStatus ;
    sh:in ( iep:Asserted ) ;
    sh:minCount 1 ;
    sh:message "ERC-8004 attestations MUST be Asserted."
  ] ;
  sh:property [
    sh:path iep:epistemicConfidence ;
    sh:minInclusive 0.0 ;
    sh:maxInclusive 1.0 ;
    sh:minCount 1 ;
    sh:message "Attestation confidence must be a real number in [0, 1]."
  ] ;
  sh:property [
    sh:path dct:conformsTo ;
    sh:hasValue <${SHAPE_URL}> ;
    sh:minCount 1 ;
    sh:message "Attestation must self-reference this shape."
  ] ;
  sh:property [
    sh:path prov:wasDerivedFrom ;
    sh:minCount 1 ;
    sh:message "ERC-8004 attestation MUST cite at least one evidence source (the subject's claim being attested)."
  ] .
`;

const r = await fetch(SHAPE_URL, {
  method: 'PUT',
  headers: { 'Content-Type': 'text/turtle' },
  body: SHAPE_TTL,
});
console.log(`PUT ${SHAPE_URL} → ${r.status}`);
console.log(`Progressive-support tier: T0 (federation-native). T1-T3 layer cryptographic + on-chain over the same shape without breaking T0 readers.`);
