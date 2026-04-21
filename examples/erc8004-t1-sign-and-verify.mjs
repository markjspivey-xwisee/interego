// ERC-8004 T1: sign a T0 attestation with ECDSA and publish the
// signed version. T0 claims + a signature = the transition to
// on-chain-compatible attestations.
//
// Signature uses the library's existing signDescriptor
// (ethers.js secp256k1 ECDSA, same primitive ERC-8004 expects
// for on-chain recovery). The signed attestation carries:
//   - content hash (sha256 of the Turtle)
//   - signer address (derived from the key)
//   - signature bytes
//
// A T1 verifier reads the signed attestation, recomputes the
// content hash, recovers the signer address, confirms match.
// This is the "cryptographic" step in the progressive trust
// ladder — T2 anchors the content hash on-chain, T3 reifies
// the attestation ID space on-chain.

import { createWallet, signDescriptor, verifyDescriptorSignature } from '../dist/index.js';

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const T1_SHAPE = `${POD}schemas/erc8004-attestation-t1-v1.ttl`;

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

// ── Step 1: publish the T1 shape if absent ─────────────────

const T1_SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${T1_SHAPE}#Shape> a sh:NodeShape ;
  sh:targetClass cg:ContextDescriptor ;
  sh:property [ sh:path cg:modalStatus ; sh:in ( cg:Asserted ) ; sh:minCount 1 ; sh:message "T1 attestation MUST be Asserted." ] ;
  sh:property [ sh:path cg:epistemicConfidence ; sh:minInclusive 0.0 ; sh:maxInclusive 1.0 ; sh:minCount 1 ; sh:message "Confidence in [0,1]." ] ;
  sh:property [ sh:path dct:conformsTo ; sh:hasValue <${T1_SHAPE}> ; sh:message "Must self-reference the T1 shape." ] ;
  sh:property [ sh:path prov:wasDerivedFrom ; sh:minCount 1 ; sh:message "T1 MUST cite evidence." ] ;
  sh:property [ sh:path <urn:erc:8004:signatureAlgorithm> ; sh:minCount 1 ; sh:message "T1 MUST declare a signature algorithm (e.g. ECDSA-secp256k1)." ] ;
  sh:property [ sh:path <urn:erc:8004:signatureValue> ; sh:minCount 1 ; sh:message "T1 MUST carry a signatureValue." ] ;
  sh:property [ sh:path <urn:erc:8004:signerAddress> ; sh:minCount 1 ; sh:message "T1 MUST declare the signer's public address." ] ;
  sh:property [ sh:path <urn:erc:8004:contentHash> ; sh:minCount 1 ; sh:message "T1 MUST carry the sha256 content hash of the signed Turtle." ] .
`;

await putText(T1_SHAPE, T1_SHAPE_TTL);
console.log(`1. Published T1 shape: ${T1_SHAPE}`);

// ── Step 2: create a fresh wallet (the attester's key) ─────

const wallet = await createWallet('agent', { label: 't1-signer' });
console.log(`\n2. Created ECDSA wallet:`);
console.log(`   address: ${wallet.address}`);
console.log(`   (secp256k1; same curve + primitive ERC-8004 uses on-chain)`);

// ── Step 3: find an existing T0 attestation to upgrade ─────

const manifest = await fetchText(`${POD}.well-known/context-graphs`);
const T0_SHAPE = `${POD}schemas/erc8004-attestation-v1.ttl`;
const t0Match = [...(manifest?.matchAll(/<([^>]+)>\s+a\s+cg:ManifestEntry\s*;[\s\S]*?dct:conformsTo\s+<[^>]*erc8004-attestation-v1[^>]*>/g) ?? [])];
if (t0Match.length === 0) { console.log('No T0 attestations to upgrade'); process.exit(1); }
const t0Url = t0Match[0][1];
console.log(`\n3. Upgrading T0 attestation → T1:`);
console.log(`   source: ${t0Url.split('/').pop()}`);

const t0Ttl = await fetchText(t0Url);
const t0Id = t0Ttl.match(/^<([^>]+)>\s+a\s+cg:ContextDescriptor/m)?.[1];
if (!t0Id) { console.log('Could not find descriptor ID in T0 body'); process.exit(1); }

// ── Step 4: sign the T0 Turtle ─────────────────────────────

const signed = await signDescriptor(t0Id, t0Ttl, wallet);
console.log(`\n4. Signed with ECDSA:`);
console.log(`   signerAddress: ${signed.signerAddress}`);
console.log(`   contentHash:   ${signed.contentHash.slice(0, 16)}...`);
console.log(`   signature:     ${signed.signature.slice(0, 16)}...`);
console.log(`   signedAt:      ${signed.signedAt}`);

// ── Step 5: compose the T1 Turtle + republish ──────────────

const t1Id = `urn:cg:t1:${Date.now()}`;
const t1Graph = `urn:graph:t1-attest:${encodeURIComponent(signed.signerAddress)}:${Date.now()}`;
const t1Url = `${POD}context-graphs/t1-attest-${Date.now()}.ttl`;
const now = new Date().toISOString();

const t1Ttl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix erc: <urn:erc:8004:> .

<${t1Id}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${T1_SHAPE}> ;
    cg:describes <${t1Graph}> ;
    erc:attester <${signed.signerAddress}> ;
    erc:progressiveTier "T1" ;
    erc:signatureAlgorithm "ECDSA-secp256k1" ;
    erc:signatureValue "${signed.signature}" ;
    erc:signerAddress "${signed.signerAddress}" ;
    erc:contentHash "${signed.contentHash}" ;
    erc:signedSource <${t0Url}> ;
    erc:signedAt "${signed.signedAt}"^^xsd:dateTime ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${signed.signerAddress}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
        prov:wasDerivedFrom <${t0Url}> ;
        prov:wasAttributedTo <${signed.signerAddress}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${signed.signerAddress}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${signed.signerAddress}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "0.95"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${signed.signerAddress}> ; cg:trustLevel cg:CryptoAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;

await putText(t1Url, t1Ttl);
console.log(`\n5. Published T1 attestation: ${t1Url.split('/').pop()}`);

const manifestEntry = `

<${t1Url}> a cg:ManifestEntry ;
    cg:describes <${t1Graph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${T1_SHAPE}> ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:CryptoAsserted .
`;
const curManifest = await fetchText(`${POD}.well-known/context-graphs`);
await putText(`${POD}.well-known/context-graphs`, (curManifest ?? '') + manifestEntry);

// ── Step 6: verify (independent recomputation) ─────────────

console.log(`\n6. Verifying signature (independent recomputation):`);
const verifyResult = await verifyDescriptorSignature(signed, t0Ttl);
console.log(`   valid: ${verifyResult.valid}`);
if (verifyResult.recoveredAddress) console.log(`   recovered: ${verifyResult.recoveredAddress}`);
if (verifyResult.reason) console.log(`   reason: ${verifyResult.reason}`);

// Adversarial: modify the source and re-verify; should fail.
const tampered = t0Ttl + '\n# tampered after signing\n';
const tamperResult = await verifyDescriptorSignature(signed, tampered);
console.log(`\n   Tamper test (append a comment after signing):`);
console.log(`   valid: ${tamperResult.valid}`);
console.log(`   reason: ${tamperResult.reason}`);

console.log(`\n── T1 complete. Summary of the progressive ladder:`);
console.log(`   T0 ✓ federation-native attestation (descriptor + conformsTo)`);
console.log(`   T1 ✓ ECDSA-signed attestation (this run)`);
console.log(`   T2 → pin t1Ttl to IPFS, register CID via ERC-8004 Reputation Registry contract`);
console.log(`   T3 → on-chain attestation ID → off-chain URL in descriptor`);
