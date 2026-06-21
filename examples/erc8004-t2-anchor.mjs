// ERC-8004 T2: IPFS-anchor a T1 attestation and construct (but do
// not broadcast) the on-chain submitFeedback transaction to the
// Reputation Registry.
//
// Progressive ladder position:
//   T0 — federation-native descriptor                     [shipped]
//   T1 — ECDSA-signed attestation                         [shipped]
//   T2 — IPFS-pin + signed on-chain tx (dry-run)          [this file]
//   T3 — on-chain attestation ID drives the namespace     [future]
//
// Why dry-run? The actual tx needs (a) a deployed Reputation
// Registry contract on the target chain, and (b) a funded wallet
// on that chain for gas. Neither is universal yet — ERC-8004 is
// draft, and each user needs their own funded address. So we
// demonstrate the FULL construction + signing path, output the
// raw tx blob, and document how to broadcast it from a funded
// environment.
//
// Everything up to and including the signing is real
// cryptographic work. Only the eth_sendRawTransaction step is
// deferred. The T2 attestation descriptor PUBLISHED back to the
// pod carries the CID, the expected tx hash, and a status of
// "prepared" — a future T3 run that actually broadcasts can
// supersede this with a "confirmed" descriptor.

import { ethers } from 'ethers';
import { pinToIpfs, computeCid } from '../dist/crypto/ipfs.js';

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const T1_SHAPE = `${POD}schemas/erc8004-attestation-t1-v1.ttl`;
const T2_SHAPE = `${POD}schemas/erc8004-attestation-t2-v1.ttl`;

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

// ── Step 0: publish the T2 shape (additive over T1 — adds
//            CID + txHash + chainId requirements)                 ─

const T2_SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix erc: <urn:erc:8004:> .

<${T2_SHAPE}#Shape> a sh:NodeShape ;
  sh:targetClass iep:ContextDescriptor ;
  sh:property [ sh:path iep:modalStatus ; sh:in ( iep:Asserted ) ; sh:minCount 1 ; sh:message "T2 attestation MUST be Asserted." ] ;
  sh:property [ sh:path dct:conformsTo ; sh:hasValue <${T2_SHAPE}> ; sh:message "Must self-reference the T2 shape." ] ;
  sh:property [ sh:path prov:wasDerivedFrom ; sh:minCount 1 ; sh:message "T2 MUST cite the T1 attestation being anchored." ] ;
  sh:property [ sh:path erc:ipfsCid ; sh:minCount 1 ; sh:message "T2 MUST carry the IPFS CID of the anchored T1 body." ] ;
  sh:property [ sh:path erc:contractAddress ; sh:minCount 1 ; sh:message "T2 MUST name the Reputation Registry contract address." ] ;
  sh:property [ sh:path erc:chainId ; sh:minCount 1 ; sh:message "T2 MUST identify the chain (ERC-8004 supports multiple)." ] ;
  sh:property [ sh:path erc:anchorStatus ; sh:minCount 1 ; sh:message "T2 anchorStatus: prepared | broadcast | confirmed." ] .
`;
await putText(T2_SHAPE, T2_SHAPE_TTL);
console.log(`0. PUT T2 shape → ${T2_SHAPE}\n`);

// ── Step 1: find an existing T1 attestation on the pod ────
//
// Try manifest first; fall back to direct GET of the known T1
// path. (Concurrent manifest PUTs in this session sometimes drop
// earlier entries — a real deployment needs atomic manifest
// append; for now a direct-URL fallback keeps the demo robust.)

const manifestTtl = await fetchText(MANIFEST_URL);
let t1Url = manifestTtl?.match(/<([^>]+t1-attest[^>]+)>/)?.[1];
if (!t1Url) {
  // Fallback: probe known URL(s) from the T1 demo.
  const candidate = `${POD}context-graphs/t1-attest-1776791756255.ttl`;
  const probe = await fetchText(candidate);
  if (probe) t1Url = candidate;
}
if (!t1Url) {
  console.log('No T1 attestation found. Run erc8004-t1-sign-and-verify.mjs first.');
  process.exit(1);
}
console.log(`1. Found T1 attestation: ${t1Url.split('/').pop()}`);
const t1Ttl = await fetchText(t1Url);
console.log(`   (${t1Ttl.length} bytes of signed Turtle)\n`);

// ── Step 2: compute IPFS CID (local-unpinned → deterministic CID, NOT uploaded) ─

const pin = await pinToIpfs(t1Ttl, 'erc8004-t1-attestation', { provider: 'local-unpinned' });
console.log(`2. Computed IPFS CID:`);
console.log(`   provider: ${pin.provider}`);
console.log(`   CID:      ${pin.cid}`);
console.log(`   size:     ${pin.size} bytes`);
if (pin.warning) console.log(`   warning:  ${pin.warning}`);
console.log(`   gateway:  (local-unpinned — content-address only; swap to pinata for actual pinning)\n`);

// ── Step 3: construct the ERC-8004 Reputation Registry tx ──
//
// Draft ABI inferred from ERC-8004 public discussion — subject to
// change as the spec is finalized. Production code would import
// the verified ABI from the canonical contract repo.
//
//   function submitFeedback(
//     bytes32 cidHash,
//     address subject,
//     uint256 score,    // scaled 0-10000
//     bytes32 metadataHash
//   ) external;

const REP_REGISTRY = ethers.getAddress('0x000000000000000000000000000000000000f8a4'); // placeholder
const BASE_SEPOLIA_CHAIN_ID = 84532;

// Extract subject + score from T1 Turtle.
const subjectMatch = t1Ttl.match(/erc:attester\s+<([^>]+)>/);
const subject = subjectMatch?.[1]
  ? ethers.getAddress(subjectMatch[1])
  : ethers.getAddress('0x0000000000000000000000000000000000000000');
const scoreMatch = t1Ttl.match(/iep:epistemicConfidence\s+"([\d.]+)"/);
const scoreScaled = Math.round((parseFloat(scoreMatch?.[1] ?? '0')) * 10000);

const cidHash = ethers.keccak256(ethers.toUtf8Bytes(pin.cid));
const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(t1Ttl));

const iface = new ethers.Interface([
  'function submitFeedback(bytes32 cidHash, address subject, uint256 score, bytes32 metadataHash)',
]);
const callData = iface.encodeFunctionData('submitFeedback', [
  cidHash, subject, scoreScaled, metadataHash,
]);

console.log(`3. Constructed Reputation Registry call:`);
console.log(`   contract:     ${REP_REGISTRY} (placeholder)`);
console.log(`   chainId:      ${BASE_SEPOLIA_CHAIN_ID} (Base Sepolia)`);
console.log(`   function:     submitFeedback`);
console.log(`   cidHash:      ${cidHash}`);
console.log(`   subject:      ${subject}`);
console.log(`   score:        ${scoreScaled} (= ${(scoreScaled/10000).toFixed(4)} unscaled)`);
console.log(`   metadataHash: ${metadataHash}\n`);

// ── Step 4: sign the transaction (EIP-1559) ────────────────

const anchorerWallet = ethers.Wallet.createRandom();
const tx = {
  to: REP_REGISTRY,
  data: callData,
  chainId: BASE_SEPOLIA_CHAIN_ID,
  nonce: 0,           // first tx from this fresh wallet
  maxFeePerGas: ethers.parseUnits('2', 'gwei'),
  maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
  gasLimit: 200_000n,
  type: 2,            // EIP-1559
};

const rawTx = await anchorerWallet.signTransaction(tx);
const parsed = ethers.Transaction.from(rawTx);
const txHash = parsed.hash;

console.log(`4. Signed EIP-1559 transaction (not broadcast):`);
console.log(`   from:    ${anchorerWallet.address}  (fresh wallet — needs ETH for gas)`);
console.log(`   txHash:  ${txHash}`);
console.log(`   rawTx:   ${rawTx.slice(0, 80)}...`);
console.log(`   To broadcast: pass rawTx to eth_sendRawTransaction on a Base Sepolia RPC.\n`);

// ── Step 5: publish a T2 attestation descriptor ────────────

const t2Id = `urn:iep:t2:${Date.now()}`;
const t2Graph = `urn:graph:t2-attest:${Date.now()}`;
const t2Url = `${POD}context-graphs/t2-attest-${Date.now()}.ttl`;
const now = new Date().toISOString();

const t2Ttl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix erc: <urn:erc:8004:> .

<${t2Id}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${T2_SHAPE}> ;
    iep:describes <${t2Graph}> ;
    erc:progressiveTier "T2" ;
    erc:ipfsCid "${pin.cid}" ;
    erc:contractAddress "${REP_REGISTRY}" ;
    erc:chainId "${BASE_SEPOLIA_CHAIN_ID}"^^xsd:integer ;
    erc:expectedTxHash "${txHash}" ;
    erc:rawTx "${rawTx}" ;
    erc:anchorStatus "prepared" ;
    erc:anchoredBy "${anchorerWallet.address}" ;
    erc:cidHash "${cidHash}" ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${anchorerWallet.address}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
        prov:wasDerivedFrom <${t1Url}> ;
        prov:wasAttributedTo <${anchorerWallet.address}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${anchorerWallet.address}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${anchorerWallet.address}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "0.85"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${anchorerWallet.address}> ; iep:trustLevel iep:CryptoAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;

await putText(t2Url, t2Ttl);
const entry = `

<${t2Url}> a iep:ManifestEntry ;
    iep:describes <${t2Graph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    dct:conformsTo <${T2_SHAPE}> ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:CryptoAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);

console.log(`5. Published T2 descriptor: ${t2Url.split('/').pop()}`);
console.log(`   anchorStatus: prepared (rawTx included, not broadcast)\n`);

console.log(`── To complete T2 on-chain:`);
console.log(`   1. Fund ${anchorerWallet.address} on Base Sepolia with test ETH`);
console.log(`   2. eth_sendRawTransaction(${rawTx.slice(0, 20)}...)`);
console.log(`   3. Wait for receipt; publish a new T2 descriptor with anchorStatus="confirmed"`);
console.log(`      and iep:supersedes pointing at ${t2Id}`);
console.log(`   The supersession pattern lets readers follow the prepared→confirmed transition`);
console.log(`   without losing the audit trail.`);
