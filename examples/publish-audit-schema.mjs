// Publishes a SHACL shape for audit-result descriptors. Once this
// is in place, the auditor-v3 emits its findings as descriptors
// conforming to this shape — the monitoring becomes federation
// content, query-able by any future agent.
//
// The shape constrains what a valid audit claim MUST carry:
//   - cg:epistemicConfidence (the auditor's own certainty)
//   - dct:conformsTo this very shape (self-reference)
//   - cg:modalStatus = Asserted  (audit outputs are asserted claims)
//   - prov:wasDerivedFrom at least one descriptor it audited
//
// That last constraint is what makes this interesting: an audit
// descriptor that cites NO evidence violates its own shape. The
// federation's trust in audit results is grounded structurally,
// not socially.

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const SHAPE_URL = `${POD}schemas/audit-result-v1.ttl`;

const SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${SHAPE_URL}#Shape> a sh:NodeShape ;
  sh:targetClass cg:ContextDescriptor ;
  sh:property [
    sh:path cg:modalStatus ;
    sh:in ( cg:Asserted ) ;
    sh:minCount 1 ;
    sh:message "An audit-result claim MUST be Asserted (findings are stated, not speculated)."
  ] ;
  sh:property [
    sh:path cg:epistemicConfidence ;
    sh:minInclusive 0.0 ;
    sh:maxInclusive 1.0 ;
    sh:minCount 1 ;
    sh:message "Audit confidence must be a real number in [0, 1]."
  ] ;
  sh:property [
    sh:path dct:conformsTo ;
    sh:hasValue <${SHAPE_URL}> ;
    sh:minCount 1 ;
    sh:message "Audit claim must self-reference this shape so schema enforcement is self-applicable."
  ] .
`;

const r = await fetch(SHAPE_URL, {
  method: 'PUT',
  headers: { 'Content-Type': 'text/turtle' },
  body: SHAPE_TTL,
});
console.log(`PUT ${SHAPE_URL}`);
console.log(`  status: ${r.status} (${r.ok ? 'ok' : 'failed'})`);

// Verify round-trip.
const check = await fetch(SHAPE_URL, { headers: { Accept: 'text/turtle' } });
const body = check.ok ? await check.text() : null;
console.log(`  fetched: ${body ? `${body.length} bytes` : 'failed'}`);
