// Publishes (a) a SHACL shape Turtle at a resolvable pod URL, and
// (b) three descriptors on a shared graph with DIFFERENT issuer
// values in their Trust facets — demonstrating cross-issuer
// independence without needing multiple pods.
//
// Why not the MCP publish path? Because the MCP server is bound to
// one agent identity. To get multi-issuer data we write descriptors
// directly via HTTP PUT with custom Trust.issuer values. The pod
// accepts anonymous PUT (verified during earlier debugging).

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';

const SHAPE_URL = `${POD}schemas/high-confidence-asserted-v1.ttl`;
const SHAPE_IRI = SHAPE_URL; // use the URL as the schema IRI

// The SHACL shape — three narrow constraints against the descriptor
// layer. The shape is enforceable against the CLEARTEXT descriptor
// Turtle without decrypting any payload. This is the right semantic
// boundary: schemas constrain descriptors, payloads remain opaque.
const SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .

<${SHAPE_IRI}#Shape> a sh:NodeShape ;
  sh:targetClass iep:ContextDescriptor ;
  sh:property [
    sh:path iep:modalStatus ;
    sh:in ( iep:Asserted ) ;
    sh:minCount 1 ;
    sh:message "Claims conforming to high-confidence-asserted-v1 MUST be Asserted."
  ] ;
  sh:property [
    sh:path iep:epistemicConfidence ;
    sh:minInclusive 0.8 ;
    sh:minCount 1 ;
    sh:message "Confidence must be >= 0.8 to claim conformance to this shape."
  ] ;
  sh:property [
    sh:path dct:conformsTo ;
    sh:hasValue <${SHAPE_IRI}> ;
    sh:message "Self-reference: descriptor must cite this shape as one of its conformsTo values."
  ] .
`;

async function putResource(url, body, contentType = 'text/turtle') {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body,
  });
  return { status: r.status, ok: r.ok };
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
  return r.ok ? await r.text() : null;
}

// Build a descriptor Turtle with a custom Trust.issuer — directly,
// without the MCP server's single-identity binding. validFrom /
// generatedAtTime set to the moment of construction so the chain
// is legibly ordered.
function buildDescriptor({ id, graphIri, issuer, modal, confidence, conformsTo, wasDerivedFrom, agentLens }) {
  const now = new Date().toISOString();
  const groundTruth =
    modal === 'Asserted' ? '"true"^^xsd:boolean' :
    modal === 'Counterfactual' ? '"false"^^xsd:boolean' :
    null;
  return `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${id}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${conformsTo}> ;
    iep:describes <${graphIri}> ;
    iep:hasFacet [
        a iep:TemporalFacet ;
        iep:validFrom "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [
            a prov:Activity ;
            prov:wasAssociatedWith <${agentLens}> ;
            prov:endedAtTime "${now}"^^xsd:dateTime
        ] ;
${wasDerivedFrom ? `        prov:wasDerivedFrom <${wasDerivedFrom}> ;\n` : ''}        prov:wasAttributedTo <${issuer}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:AgentFacet ;
        iep:assertingAgent [
            a prov:SoftwareAgent, as:Application ;
            iep:agentIdentity <${agentLens}>
        ] ;
        iep:agentRole iep:Author ;
        iep:onBehalfOf <${issuer}>
    ] ;
    iep:hasFacet [
        a iep:SemioticFacet ;
${groundTruth ? `        iep:groundTruth ${groundTruth} ;\n` : ''}        iep:modalStatus iep:${modal} ;
        iep:epistemicConfidence "${confidence}"^^xsd:double
    ] ;
    iep:hasFacet [
        a iep:TrustFacet ;
        iep:issuer <${issuer}> ;
        iep:trustLevel iep:SelfAsserted
    ] ;
    iep:hasFacet [
        a iep:FederationFacet ;
        iep:origin <${POD}> ;
        iep:storageEndpoint <${POD}> ;
        iep:syncProtocol iep:SolidNotifications
    ] .
`;
}

// ── Publish workflow ────────────────────────────────────────

console.log('=== Publishing SHACL shape + cross-issuer descriptors ===\n');

// 1. Publish the SHACL shape at the resolvable URL.
const shapeRes = await putResource(SHAPE_URL, SHAPE_TTL);
console.log(`1. PUT shape → ${SHAPE_URL}`);
console.log(`   status: ${shapeRes.status} (${shapeRes.ok ? 'created' : 'failed'})\n`);

// 2. Verify the shape is actually fetchable + looks right.
const fetched = await fetchText(SHAPE_URL);
console.log(`2. Fetch-back check: ${fetched ? `${fetched.length} bytes` : 'FAILED'}`);
if (fetched) console.log(`   first line: ${fetched.split('\n')[0]}\n`);

// 3. Publish three descriptors of the same graph with THREE DIFFERENT
//    issuers. They all cite the shape via dct:conformsTo.
const SHARED_GRAPH = 'urn:graph:shared:cross-issuer-test:semantic-probe';
const ts = Date.now();
const descs = [
  {
    id: `urn:iep:multi:${ts}-alpha`,
    graphIri: SHARED_GRAPH,
    issuer: 'urn:agent:independent:alpha',
    modal: 'Asserted',
    confidence: 0.9,
    conformsTo: SHAPE_IRI,
    agentLens: 'urn:agent:independent:alpha',
  },
  {
    id: `urn:iep:multi:${ts}-beta`,
    graphIri: SHARED_GRAPH,
    issuer: 'urn:agent:independent:beta',
    modal: 'Asserted',
    confidence: 0.85,
    conformsTo: SHAPE_IRI,
    wasDerivedFrom: `urn:iep:multi:${ts}-alpha`,
    agentLens: 'urn:agent:independent:beta',
  },
  {
    // Gamma — violates the shape intentionally: confidence < 0.8.
    // The auditor should flag this as a schema violation.
    id: `urn:iep:multi:${ts}-gamma-shape-violator`,
    graphIri: SHARED_GRAPH,
    issuer: 'urn:agent:independent:gamma',
    modal: 'Asserted',
    confidence: 0.4,
    conformsTo: SHAPE_IRI,
    wasDerivedFrom: `urn:iep:multi:${ts}-alpha`,
    agentLens: 'urn:agent:independent:gamma',
  },
];

console.log('3. Publishing three cross-issuer descriptors (via direct PUT, not MCP):\n');
const descriptorUrls = [];
for (const d of descs) {
  const slug = d.id.replace(/[:]/g, '-');
  const url = `${POD}context-graphs/${slug}.ttl`;
  const ttl = buildDescriptor(d);
  const r = await putResource(url, ttl);
  console.log(`   ${r.ok ? '✓' : '✗'} PUT ${slug.slice(0, 70)}… → ${r.status}`);
  console.log(`     issuer=${d.issuer} modal=${d.modal} conf=${d.confidence}`);
  descriptorUrls.push(url);
}

// 4. Append entries to the manifest so the auditor finds them.
console.log('\n4. Appending manifest entries...');
const manifestUrl = `${POD}.well-known/context-graphs`;
let manifest = await fetchText(manifestUrl) ?? '';

let appended = '';
for (let i = 0; i < descs.length; i++) {
  const d = descs[i];
  const url = descriptorUrls[i];
  appended += `

<${url}> a iep:ManifestEntry ;
    iep:describes <${d.graphIri}> ;
    iep:hasFacetType iep:Temporal ;
    iep:hasFacetType iep:Provenance ;
    iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ;
    iep:hasFacetType iep:Trust ;
    iep:hasFacetType iep:Federation ;
    dct:conformsTo <${d.conformsTo}> ;
    iep:modalStatus iep:${d.modal} ;
    iep:trustLevel iep:SelfAsserted .
`;
}

const updated = manifest + appended;
const manifestRes = await putResource(manifestUrl, updated);
console.log(`   manifest update → ${manifestRes.status} (${manifestRes.ok ? 'updated' : 'failed'})`);

console.log('\n=== Done. Now run examples/semantic-alignment-auditor-v2.mjs ===');
console.log(`   target graph: ${SHARED_GRAPH}`);
