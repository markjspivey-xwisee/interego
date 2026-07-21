// Publishes a descriptor carrying FOUR distinct iep:action affordances
// so the affordance-bridge enumerator has diverse capabilities to
// discover. In production each would live on the descriptor most
// relevant to the action; here we bundle them for demo clarity.

const POD = 'https://gate.interego.xwisee.com/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

const id = `urn:iep:diverse-affordances:${Date.now()}`;
const graph = `urn:graph:diverse-affordances:${Date.now()}`;
const url = `${POD}context-graphs/diverse-affordances-${Date.now()}.ttl`;
const now = new Date().toISOString();

// Four distinct affordance blocks on one descriptor:
//   canAudit        — invoke a recursive meta-audit on a target
//   canPayX402      — pay an x402-protected resource
//   canVerifySignature — verify an ECDSA signature on a descriptor
//   canComputeMeet  — compute PGSL lattice meet between two fragments
//
// Each is a real capability our substrate already supports.
// The affordance-bridge can turn any of them into a callable tool.

const ttl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/cgh#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix cap: <urn:capability:> .

<${id}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    iep:describes <${graph}> ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <urn:agent:diverse-affordance-publisher> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
        prov:wasAttributedTo <urn:agent:diverse-affordance-publisher> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <urn:agent:diverse-affordance-publisher> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <urn:agent:diverse-affordance-publisher> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "1.0"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <urn:agent:diverse-affordance-publisher> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .

# Four distinct affordances, each independently resolvable by the bridge.

<${id}> iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action cap:canAudit ;
    hydra:method "GET" ;
    hydra:target <${POD}.well-known/context-graphs> ;
    hydra:returns ieh:AuditResult ;
    dcat:mediaType "text/turtle" ;
    ieh:inputHint "Walk the manifest; for each conforming descriptor, check shape + phantom + COI"
] .

<${id}> iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action cap:canPayX402 ;
    hydra:method "GET" ;
    hydra:target <http://127.0.0.1:4020/protected> ;
    hydra:returns ieh:X402Response ;
    dcat:mediaType "application/json" ;
    ieh:inputHint "Expect 402; sign payment with wallet; retry with X-Payment header"
] .

<${id}> iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action cap:canVerifySignature ;
    hydra:method "GET" ;
    hydra:target <${POD}context-graphs/t1-attest-1776791756255.ttl> ;
    hydra:returns ieh:VerificationResult ;
    dcat:mediaType "text/turtle" ;
    ieh:inputHint "Fetch T1 attestation; extract erc:signatureValue + erc:signerAddress; recover signer + compare"
] .

<${id}> iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action cap:canComputeMeet ;
    hydra:method "POST" ;
    hydra:target <${POD}pgsl/meet> ;
    hydra:returns ieh:PgslFragment ;
    dcat:mediaType "application/json" ;
    ieh:inputHint "Body: {uri_a, uri_b}; returns the greatest-lower-bound fragment"
] .
`;

await putText(url, ttl);

const entry = `

<${url}> a iep:ManifestEntry ;
    iep:describes <${graph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);

console.log(`PUT ${url.split('/').pop()}`);
console.log(`  4 distinct affordances: canAudit, canPayX402, canVerifySignature, canComputeMeet`);
console.log(`  Run affordance-bridge.mjs next — enumerator should now find 4+ distinct actions.`);
