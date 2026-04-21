// Adversarial tests for the recursive meta-audit.
//
// Publishes three MALFORMED audit descriptors to test whether v4
// actually catches each failure mode it claims to check:
//
//   1. Phantom-evidence audit: cites prov:wasDerivedFrom targets
//      that don't exist. v4 should flag phantomEvidence.
//   2. Conflict-of-interest audit: auditor issuer = issuer of cited
//      evidence. v4 should flag conflictOfInterest.
//   3. Shape-violating audit: modalStatus != Asserted or confidence
//      out of [0,1]. v4 should flag shapeConformance.
//
// If v4 misses any of these after publishing, the trust guarantees
// are cosmetic. If v4 catches all three, the guarantees are real.

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

async function fetchText(url) {
  const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
  return r.ok ? await r.text() : null;
}

async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

function buildAuditDescriptor({ id, graphIri, issuer, modal, confidence, wasDerivedFrom, conformsTo }) {
  const now = new Date().toISOString();
  const derived = wasDerivedFrom.map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');
  return `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
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
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${issuer}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derived}
        prov:wasAttributedTo <${issuer}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [
        a cg:AgentFacet ;
        cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${issuer}> ] ;
        cg:agentRole cg:Author ;
        cg:onBehalfOf <${issuer}>
    ] ;
    cg:hasFacet [
        a cg:SemioticFacet ;
        cg:groundTruth "true"^^xsd:boolean ;
        cg:modalStatus cg:${modal} ;
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

async function appendManifest(descUrl, graphIri, modal, conformsTo) {
  const entry = `

<${descUrl}> a cg:ManifestEntry ;
    cg:describes <${graphIri}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${conformsTo}> ;
    cg:modalStatus cg:${modal} ;
    cg:trustLevel cg:SelfAsserted .
`;
  const cur = await fetchText(MANIFEST_URL);
  return await putText(MANIFEST_URL, (cur ?? '') + entry);
}

console.log('=== Publishing three adversarial audits ===\n');

const ts = Date.now();

// ── 1. Phantom-evidence audit ─────────────────────────────
const phantomId = `urn:cg:adversarial:phantom:${ts}`;
const phantomGraph = `urn:graph:adversarial:phantom:${ts}`;
const phantomUrl = `${POD}context-graphs/adversarial-phantom-${ts}.ttl`;
const phantomTtl = buildAuditDescriptor({
  id: phantomId,
  graphIri: phantomGraph,
  issuer: 'urn:agent:adversarial:phantom-publisher',
  modal: 'Asserted',
  confidence: 0.99,
  wasDerivedFrom: [
    `${POD}context-graphs/does-not-exist-1.ttl`,
    `${POD}context-graphs/does-not-exist-2.ttl`,
  ],
  conformsTo: AUDIT_SHAPE,
});
const p1 = await putText(phantomUrl, phantomTtl);
await appendManifest(phantomUrl, phantomGraph, 'Asserted', AUDIT_SHAPE);
console.log(`1. Phantom-evidence audit:`);
console.log(`   ${p1 ? '✓' : '✗'} PUT ${phantomUrl.split('/').pop()}`);
console.log(`   cites 2 does-not-exist.ttl targets — v4 should flag phantomEvidence\n`);

// ── 2. Conflict-of-interest audit ─────────────────────────
// Auditor issuer = issuer of the cited evidence. We cite the alpha
// descriptor from the cross-issuer-test and set the audit's issuer
// to urn:agent:independent:alpha — self-audit.
const alphaCitation = await fetchText(MANIFEST_URL);
const alphaMatch = alphaCitation?.match(/(https:\/\/[^\s>]+urn-cg-multi-\d+-alpha\.ttl)/);
const alphaUrl = alphaMatch?.[1];
if (!alphaUrl) { console.log('Alpha citation not found — cannot run COI test'); }
else {
  const coiId = `urn:cg:adversarial:coi:${ts}`;
  const coiGraph = `urn:graph:adversarial:coi:${ts}`;
  const coiUrl = `${POD}context-graphs/adversarial-coi-${ts}.ttl`;
  const coiTtl = buildAuditDescriptor({
    id: coiId,
    graphIri: coiGraph,
    issuer: 'urn:agent:independent:alpha', // SAME as the issuer of the evidence
    modal: 'Asserted',
    confidence: 0.95,
    wasDerivedFrom: [alphaUrl],
    conformsTo: AUDIT_SHAPE,
  });
  const p2 = await putText(coiUrl, coiTtl);
  await appendManifest(coiUrl, coiGraph, 'Asserted', AUDIT_SHAPE);
  console.log(`2. Conflict-of-interest audit:`);
  console.log(`   ${p2 ? '✓' : '✗'} PUT ${coiUrl.split('/').pop()}`);
  console.log(`   issuer=alpha, cites alpha's own claim — v4 should flag conflictOfInterest\n`);
}

// ── 3. Shape-violating audit (confidence > 1.0) ──────────
const shapeId = `urn:cg:adversarial:shape-violator:${ts}`;
const shapeGraph = `urn:graph:adversarial:shape-violator:${ts}`;
const shapeUrl = `${POD}context-graphs/adversarial-shape-violator-${ts}.ttl`;
// audit-result-v1 shape requires confidence ∈ [0,1]. We set it to 1.5.
// BUT: we can't embed 1.5 as xsd:double directly in a valid way — but
// the SHACL shape check should catch it regardless.
// Instead we violate by using modal=Hypothetical (shape requires Asserted).
const shapeTtl = buildAuditDescriptor({
  id: shapeId,
  graphIri: shapeGraph,
  issuer: 'urn:agent:adversarial:shape-violator',
  modal: 'Hypothetical', // shape requires Asserted
  confidence: 0.9,
  wasDerivedFrom: [alphaUrl ?? `${POD}context-graphs/urn-cg-multi-${ts}-alpha.ttl`],
  conformsTo: AUDIT_SHAPE,
});
const p3 = await putText(shapeUrl, shapeTtl);
await appendManifest(shapeUrl, shapeGraph, 'Hypothetical', AUDIT_SHAPE);
console.log(`3. Shape-violating audit (modal=Hypothetical, shape requires Asserted):`);
console.log(`   ${p3 ? '✓' : '✗'} PUT ${shapeUrl.split('/').pop()}`);
console.log(`   v4 should flag shapeConformance\n`);

console.log('=== Now run examples/semantic-alignment-auditor-v4.mjs ===');
console.log('    It should find 3 new adversarial audits + flag all three failure modes.');
