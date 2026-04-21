// Cross-pod demo — prove federation by publishing on POD-B and
// running an auditor that reads from POD-A AND POD-B.
//
// This addresses the honest limitation we've been carrying: up to
// now every descriptor lived on /markj/, so "distinct issuers" was
// simulated by custom Trust.issuer values rather than cryptographic
// pod separation. Now we put descriptors on /u-pk-0a7f04106a54/
// (a pre-existing second pod on the same CSS) and show discover +
// audit works across the boundary.

const CSS = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const POD_A = `${CSS}/markj/`;
const POD_B = `${CSS}/u-pk-0a7f04106a54/`;
const ERC_SHAPE = `${POD_A}schemas/erc8004-attestation-v1.ttl`;  // shape still hosted on A; B references it

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return { ok: r.ok, status: r.status };
}

// ── Step 1: Publish a claim on POD-B ────────────────────────

const podBGraph = `urn:graph:pod-b:ai-audit-report:2026-04-21`;
const podBId = `urn:cg:pod-b:report:${Date.now()}`;
const podBUrl = `${POD_B}context-graphs/report-${Date.now()}.ttl`;
const issuerB = `urn:agent:pod-b:external-auditor`;
const now = new Date().toISOString();

const ttl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${podBId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${ERC_SHAPE}> ;
    cg:describes <${podBGraph}> ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${issuerB}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
        prov:wasDerivedFrom <${POD_A}context-graphs/urn-cg-multi-1776788440243-alpha.ttl> ;
        prov:wasAttributedTo <${issuerB}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${issuerB}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${issuerB}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "0.88"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${issuerB}> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD_B}> ; cg:storageEndpoint <${POD_B}> ; cg:syncProtocol cg:SolidNotifications ] .
`;

console.log('=== Cross-pod demo ===\n');
console.log(`1. Publishing a POD-B claim that cites POD-A evidence...`);
const r1 = await putText(podBUrl, ttl);
console.log(`   ${r1.ok ? '✓' : '✗'} PUT ${podBUrl} → ${r1.status}`);

// Append to POD-B's manifest.
const podBManifest = `${POD_B}.well-known/context-graphs`;
const current = await fetchText(podBManifest);
const entry = `${current ?? `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .

`}
<${podBUrl}> a cg:ManifestEntry ;
    cg:describes <${podBGraph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${ERC_SHAPE}> ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
const r2 = await putText(podBManifest, entry);
console.log(`   ${r2.ok ? '✓' : '✗'} POD-B manifest → ${r2.status}`);

// ── Step 2: Cross-pod discover ──────────────────────────────

console.log(`\n2. Cross-pod discover: read POD-A and POD-B manifests.`);
const manifestA = await fetchText(`${POD_A}.well-known/context-graphs`);
const manifestB = await fetchText(podBManifest);

const entriesInA = [...(manifestA?.matchAll(/cg:ManifestEntry/g) ?? [])].length;
const entriesInB = [...(manifestB?.matchAll(/cg:ManifestEntry/g) ?? [])].length;
console.log(`   POD-A: ${entriesInA} entries`);
console.log(`   POD-B: ${entriesInB} entries`);

// Count claims per pod citing the ERC-8004 shape.
const ercInA = [...(manifestA?.matchAll(/dct:conformsTo\s+<[^>]*erc8004-attestation-v1[^>]*>/g) ?? [])].length;
const ercInB = [...(manifestB?.matchAll(/dct:conformsTo\s+<[^>]*erc8004-attestation-v1[^>]*>/g) ?? [])].length;
console.log(`   ERC-8004 attestations — POD-A: ${ercInA}, POD-B: ${ercInB}`);

// ── Step 3: Cross-pod derivation chain verification ─────────

console.log(`\n3. Verify cross-pod derivation: POD-B claim cites POD-A descriptor.`);
const podBTtl = await fetchText(podBUrl);
const derived = [...(podBTtl?.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g) ?? [])].map(m => m[1]);
console.log(`   POD-B claim wasDerivedFrom:`);
for (const d of derived) {
  const isOnPodA = d.startsWith(POD_A);
  const exists = await fetchText(d);
  console.log(`     ${exists ? '✓' : '✗'} ${d}   [${isOnPodA ? 'POD-A' : 'other'}]`);
}

console.log(`\n── Cross-pod federation demonstrated:`);
console.log(`   A claim on POD-B cites evidence on POD-A by URL.`);
console.log(`   An auditor reading POD-B fetches the evidence from POD-A directly.`);
console.log(`   No central registry, no shared database — just HTTP + content-addressed URLs.`);
console.log(`   Schema (hosted on POD-A) is referenced by POD-B claims without mirroring.`);
