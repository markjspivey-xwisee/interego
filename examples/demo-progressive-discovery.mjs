// demo-progressive-discovery.mjs
//
// Runs all seven discovery tiers (T0–T6) against the live pod so
// you can see what each yields and what's publisher-opt-in vs
// consumer-driven. See spec/architecture.md §6.5d.
//
//   T0 Raw pod URL         — direct manifest GET
//   T1 DID-Web             — resolve did:web:<domain>/.well-known/did.json
//   T2 WebFinger           — resolve acct:user@domain/.well-known/webfinger
//   T3 Agents catalog      — GET <domain>/.well-known/interego-agents
//   T4 Federation directory — discover descriptors conforming to
//                             federation-directory-v1
//   T5 Social graph walk   — BFS outward from seed pod via citations
//   T6 On-chain registry   — dereference ERC-8004 T1+ attestations
//                             (T3 broadcast deferred; this demo reads the
//                             descriptor-side representation of T2 anchors)

import { resolveIdentifier, socialWalk, agentsCatalogTurtle } from '../dist/index.js';
import { POD, fetchText, putText, MANIFEST_URL } from './_lib.mjs';

console.log('=== Progressive discovery — all 7 tiers ===\n');

const POD_B = 'https://gate.interego.xwisee.com/u-pk-0a7f04106a54/';
const IDENTITY = 'https://identity.interego.xwisee.com';

// ── T0: raw pod URL ────────────────────────────────────────
console.log('── T0 — Raw pod URL');
const resultT0 = await resolveIdentifier(POD);
console.log(`   identifier: ${resultT0.identifier}`);
console.log(`   kind:       ${resultT0.kind}`);
console.log(`   tiers hit:  ${resultT0.tiersHit.join(', ')}`);
console.log(`   pod URL:    ${resultT0.podUrl ?? '(none)'}\n`);

// ── T1: did:web ────────────────────────────────────────────
console.log('── T1 — DID-Web');
const didResult = await resolveIdentifier('did:web:identity.interego.xwisee.com');
console.log(`   kind:       ${didResult.kind}`);
console.log(`   tiers hit:  ${didResult.tiersHit.join(', ') || '(none — identity server is not a DID-Web host)'}`);
console.log(`   trace T1:   ${didResult.trace?.T1 ?? 'not tried'}\n`);

// ── T2: WebFinger ──────────────────────────────────────────
console.log('── T2 — WebFinger');
const acctResult = await resolveIdentifier('acct:demo@identity.interego.xwisee.com');
console.log(`   kind:       ${acctResult.kind}`);
console.log(`   tiers hit:  ${acctResult.tiersHit.join(', ') || '(none — demo account not in WebFinger)'}`);
console.log(`   trace T2:   ${acctResult.trace?.T2 ?? 'not tried'}\n`);

// ── T3: .well-known/interego-agents ────────────────────────
//
// Publish a catalog at the pod's well-known location, then
// demonstrate a consumer fetching it.
console.log('── T3 — Agents catalog');
const catalogUrl = `${POD}.well-known/interego-agents`;
const catalogTtl = agentsCatalogTurtle('urn:catalog:markj', [
  { agentId: 'urn:agent:anthropic:claude-code:vscode',
    label: 'Claude Code VS Code',
    podUrl: POD,
    capabilities: ['iep:canPublish', 'iep:canAudit'] },
  { agentId: 'urn:agent:reputation-aggregator:v1',
    label: 'Reputation Aggregator',
    podUrl: POD,
    capabilities: ['iep:canCompose'] },
]);
await putText(catalogUrl, catalogTtl);
console.log(`   published catalog: ${catalogUrl}`);

const t3Result = await resolveIdentifier(POD);
console.log(`   consumer-side tiers: ${t3Result.tiersHit.join(', ')}`);
console.log(`   agents found:       ${t3Result.agents?.length ?? 0}`);
for (const a of t3Result.agents ?? []) {
  console.log(`     • ${a.label ?? a.agentId} — ${(a.capabilities ?? []).join(', ')}`);
}
console.log('');

// ── T4: federation-directory descriptor ─────────────────────
console.log('── T4 — Federation directory descriptor');
const dirShapeUrl = `${POD}schemas/federation-directory-v1.ttl`;
const dirShapeTtl = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix fed: <urn:federation:> .

<${dirShapeUrl}#Shape> a sh:NodeShape ;
  sh:targetClass iep:ContextDescriptor ;
  sh:property [ sh:path iep:modalStatus ; sh:in ( iep:Asserted ) ; sh:minCount 1 ] ;
  sh:property [ sh:path dct:conformsTo ; sh:hasValue <${dirShapeUrl}> ; sh:minCount 1 ] ;
  sh:property [ sh:path fed:indexedPod ; sh:minCount 1 ;
    sh:message "Federation directory MUST enumerate at least one pod." ] .
`;
await putText(dirShapeUrl, dirShapeTtl);

const dirId = `urn:iep:federation-directory:${Date.now()}`;
const dirGraph = `urn:graph:federation-directory:${Date.now()}`;
const dirUrl = `${POD}context-graphs/federation-dir-${Date.now()}.ttl`;
const now = new Date().toISOString();
const dirTtl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix fed: <urn:federation:> .

<${dirId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${dirShapeUrl}> ;
    iep:describes <${dirGraph}> ;
    fed:indexedPod <${POD}> , <${POD_B}> ;
    fed:indexedPodCount "2"^^xsd:integer ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [ a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <urn:agent:federation-directory-publisher> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
        prov:wasAttributedTo <urn:agent:federation-directory-publisher> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <urn:agent:federation-directory-publisher> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <urn:agent:federation-directory-publisher> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "1.0"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <urn:agent:federation-directory-publisher> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;
await putText(dirUrl, dirTtl);
// Append manifest entry
const entry = `

<${dirUrl}> a iep:ManifestEntry ;
    iep:describes <${dirGraph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    dct:conformsTo <${dirShapeUrl}> ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);
console.log(`   published directory: ${dirUrl.split('/').pop()}`);
console.log(`   indexes 2 pods; discoverable via conformsTo=federation-directory-v1.ttl`);
console.log('');

// ── T5: social-graph walk ───────────────────────────────────
console.log('── T5 — Social-graph walk (BFS from seed, maxDepth=2, maxPods=5)');
const walk = await socialWalk(POD, { maxDepth: 2, maxPods: 5 });
console.log(`   seed:              ${walk.seed}`);
console.log(`   pods visited:      ${walk.stats.podsVisited}`);
console.log(`   depth reached:     ${walk.stats.depthReached}`);
console.log(`   descriptors scanned: ${walk.stats.descriptorsScanned}`);
console.log(`   cross-pod citations: ${walk.stats.crossPodCitations}`);
console.log(`   edges (from → to, weight):`);
for (const e of walk.edges.slice(0, 5)) {
  console.log(`     ${e.from.split('/').slice(-2)[0]} → ${e.to.split('/').slice(-2)[0]}  (${e.weight})`);
}
console.log('');

// ── T6: on-chain registry (read-side only — descriptor representation) ──
console.log('── T6 — On-chain registry (read-side; ERC-8004 T1/T2 attestations)');
const manifest = await fetchText(MANIFEST_URL);
const t1t2Count = [...(manifest?.matchAll(/dct:conformsTo\s+<[^>]*erc8004-attestation-t[12][^>]*>/g) ?? [])].length;
console.log(`   attestations conformant to T1/T2: ${t1t2Count}`);
console.log(`   (T2 anchors include rawTx for on-chain broadcast; see erc8004-t2-anchor.mjs)`);
console.log(`   (T3 broadcast requires funded wallet; reader-side works today via descriptor dereference)`);
console.log('');

// ── Summary ─────────────────────────────────────────────────
console.log('── Summary');
console.log('   T0 pod URL:           ✓ (always works)');
console.log(`   T1 DID-Web:           ${didResult.tiersHit.includes('T1') ? '✓' : '○ (not published)'}`);
console.log(`   T2 WebFinger:         ${acctResult.tiersHit.includes('T2') ? '✓' : '○ (not published)'}`);
console.log(`   T3 Agents catalog:    ${t3Result.tiersHit.includes('T3') ? '✓' : '○'}  (${t3Result.agents?.length ?? 0} entries)`);
console.log(`   T4 Federation dir:    ✓ (published this run)`);
console.log(`   T5 Social walk:       ✓ (${walk.stats.podsVisited} pods reached, ${walk.stats.crossPodCitations} edges)`);
console.log(`   T6 On-chain:          ✓ read-side (${t1t2Count} T1/T2 attestations present)`);
console.log('');
console.log('Each tier is independently useful; participants opt in at their comfort level.');
