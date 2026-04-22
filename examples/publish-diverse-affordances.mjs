// Publishes a descriptor carrying FOUR distinct cg:action affordances
// so the affordance-bridge enumerator has diverse capabilities to
// discover. In production each would live on the descriptor most
// relevant to the action; here we bundle them for demo clarity.

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

const id = `urn:cg:diverse-affordances:${Date.now()}`;
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

const ttl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix cgh: <https://markjspivey-xwisee.github.io/interego/ns/cgh#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix cap: <urn:capability:> .

<${id}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    cg:describes <${graph}> ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <urn:agent:diverse-affordance-publisher> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
        prov:wasAttributedTo <urn:agent:diverse-affordance-publisher> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <urn:agent:diverse-affordance-publisher> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <urn:agent:diverse-affordance-publisher> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "1.0"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <urn:agent:diverse-affordance-publisher> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .

# Four distinct affordances, each independently resolvable by the bridge.

<${id}> cg:affordance [
    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action cap:canAudit ;
    hydra:method "GET" ;
    hydra:target <${POD}.well-known/context-graphs> ;
    hydra:returns cgh:AuditResult ;
    dcat:mediaType "text/turtle" ;
    cgh:inputHint "Walk the manifest; for each conforming descriptor, check shape + phantom + COI"
] .

<${id}> cg:affordance [
    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action cap:canPayX402 ;
    hydra:method "GET" ;
    hydra:target <http://127.0.0.1:4020/protected> ;
    hydra:returns cgh:X402Response ;
    dcat:mediaType "application/json" ;
    cgh:inputHint "Expect 402; sign payment with wallet; retry with X-Payment header"
] .

<${id}> cg:affordance [
    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action cap:canVerifySignature ;
    hydra:method "GET" ;
    hydra:target <${POD}context-graphs/t1-attest-1776791756255.ttl> ;
    hydra:returns cgh:VerificationResult ;
    dcat:mediaType "text/turtle" ;
    cgh:inputHint "Fetch T1 attestation; extract erc:signatureValue + erc:signerAddress; recover signer + compare"
] .

<${id}> cg:affordance [
    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;
    cg:action cap:canComputeMeet ;
    hydra:method "POST" ;
    hydra:target <${POD}pgsl/meet> ;
    hydra:returns cgh:PgslFragment ;
    dcat:mediaType "application/json" ;
    cgh:inputHint "Body: {uri_a, uri_b}; returns the greatest-lower-bound fragment"
] .
`;

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

console.log(`PUT ${url.split('/').pop()}`);
console.log(`  4 distinct affordances: canAudit, canPayX402, canVerifySignature, canComputeMeet`);
console.log(`  Run affordance-bridge.mjs next — enumerator should now find 4+ distinct actions.`);
