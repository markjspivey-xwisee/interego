// Publishes (a) a SHACL shape Turtle at a resolvable pod URL, and
// (b) three descriptors on a shared graph with DIFFERENT issuer
// values in their Trust facets — demonstrating cross-issuer
// independence without needing multiple pods.
//
// Why not the MCP publish path? Because the MCP server is bound to
// one agent identity. To get multi-issuer data we write descriptors
// directly via HTTP PUT with custom Trust.issuer values. The pod
// accepts anonymous PUT (verified during earlier debugging).

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';

const SHAPE_URL = `${POD}schemas/high-confidence-asserted-v1.ttl`;
const SHAPE_IRI = SHAPE_URL; // use the URL as the schema IRI

// The SHACL shape — three narrow constraints against the descriptor
// layer. The shape is enforceable against the CLEARTEXT descriptor
// Turtle without decrypting any payload. This is the right semantic
// boundary: schemas constrain descriptors, payloads remain opaque.
const SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .

<${SHAPE_IRI}#Shape> a sh:NodeShape ;
  sh:targetClass cg:ContextDescriptor ;
  sh:property [
    sh:path cg:modalStatus ;
    sh:in ( cg:Asserted ) ;
    sh:minCount 1 ;
    sh:message "Claims conforming to high-confidence-asserted-v1 MUST be Asserted."
  ] ;
  sh:property [
    sh:path cg:epistemicConfidence ;
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
  return `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${id}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${conformsTo}> ;
    cg:describes <${graphIri}> ;
    cg:hasFacet [
        a cg:TemporalFacet ;
        cg:validFrom "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [
            a prov:Activity ;
            prov:wasAssociatedWith <${agentLens}> ;
            prov:endedAtTime "${now}"^^xsd:dateTime
        ] ;
${wasDerivedFrom ? `        prov:wasDerivedFrom <${wasDerivedFrom}> ;\n` : ''}        prov:wasAttributedTo <${issuer}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [
        a cg:AgentFacet ;
        cg:assertingAgent [
            a prov:SoftwareAgent, as:Application ;
            cg:agentIdentity <${agentLens}>
        ] ;
        cg:agentRole cg:Author ;
        cg:onBehalfOf <${issuer}>
    ] ;
    cg:hasFacet [
        a cg:SemioticFacet ;
${groundTruth ? `        cg:groundTruth ${groundTruth} ;\n` : ''}        cg:modalStatus cg:${modal} ;
        cg:epistemicConfidence "${confidence}"^^xsd:double
    ] ;
    cg:hasFacet [
        a cg:TrustFacet ;
        cg:issuer <${issuer}> ;
        cg:trustLevel cg:SelfAsserted
    ] ;
    cg:hasFacet [
        a cg:FederationFacet ;
        cg:origin <${POD}> ;
        cg:storageEndpoint <${POD}> ;
        cg:syncProtocol cg:SolidNotifications
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
    id: `urn:cg:multi:${ts}-alpha`,
    graphIri: SHARED_GRAPH,
    issuer: 'urn:agent:independent:alpha',
    modal: 'Asserted',
    confidence: 0.9,
    conformsTo: SHAPE_IRI,
    agentLens: 'urn:agent:independent:alpha',
  },
  {
    id: `urn:cg:multi:${ts}-beta`,
    graphIri: SHARED_GRAPH,
    issuer: 'urn:agent:independent:beta',
    modal: 'Asserted',
    confidence: 0.85,
    conformsTo: SHAPE_IRI,
    wasDerivedFrom: `urn:cg:multi:${ts}-alpha`,
    agentLens: 'urn:agent:independent:beta',
  },
  {
    // Gamma — violates the shape intentionally: confidence < 0.8.
    // The auditor should flag this as a schema violation.
    id: `urn:cg:multi:${ts}-gamma-shape-violator`,
    graphIri: SHARED_GRAPH,
    issuer: 'urn:agent:independent:gamma',
    modal: 'Asserted',
    confidence: 0.4,
    conformsTo: SHAPE_IRI,
    wasDerivedFrom: `urn:cg:multi:${ts}-alpha`,
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

<${url}> a cg:ManifestEntry ;
    cg:describes <${d.graphIri}> ;
    cg:hasFacetType cg:Temporal ;
    cg:hasFacetType cg:Provenance ;
    cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ;
    cg:hasFacetType cg:Trust ;
    cg:hasFacetType cg:Federation ;
    dct:conformsTo <${d.conformsTo}> ;
    cg:modalStatus cg:${d.modal} ;
    cg:trustLevel cg:SelfAsserted .
`;
}

const updated = manifest + appended;
const manifestRes = await putResource(manifestUrl, updated);
console.log(`   manifest update → ${manifestRes.status} (${manifestRes.ok ? 'updated' : 'failed'})`);

console.log('\n=== Done. Now run examples/semantic-alignment-auditor-v2.mjs ===');
console.log(`   target graph: ${SHARED_GRAPH}`);
