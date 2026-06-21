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

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
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
  return `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
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
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${issuer}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derived}
        prov:wasAttributedTo <${issuer}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:AgentFacet ;
        iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${issuer}> ] ;
        iep:agentRole iep:Author ;
        iep:onBehalfOf <${issuer}>
    ] ;
    iep:hasFacet [
        a iep:SemioticFacet ;
        iep:groundTruth "true"^^xsd:boolean ;
        iep:modalStatus iep:${modal} ;
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

async function appendManifest(descUrl, graphIri, modal, conformsTo) {
  const entry = `

<${descUrl}> a iep:ManifestEntry ;
    iep:describes <${graphIri}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    dct:conformsTo <${conformsTo}> ;
    iep:modalStatus iep:${modal} ;
    iep:trustLevel iep:SelfAsserted .
`;
  const cur = await fetchText(MANIFEST_URL);
  return await putText(MANIFEST_URL, (cur ?? '') + entry);
}

console.log('=== Publishing three adversarial audits ===\n');

const ts = Date.now();

// ── 1. Phantom-evidence audit ─────────────────────────────
const phantomId = `urn:iep:adversarial:phantom:${ts}`;
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
  const coiId = `urn:iep:adversarial:coi:${ts}`;
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
const shapeId = `urn:iep:adversarial:shape-violator:${ts}`;
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
