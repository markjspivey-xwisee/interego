// Semantic-alignment auditor v3 — emits its findings as descriptors.
//
// v1 read structure and reported.
// v2 added SHACL enforcement + cross-issuer + reputation.
// v3 publishes the audit result back to the pod as a descriptor
//    conforming to audit-result-v1.ttl, making the monitoring itself
//    federation content. Future agents querying the pod for
//    "conformsTo audit-result-v1" find the audit trail directly.
//
// The audit descriptor cites (via prov:wasDerivedFrom) every
// descriptor it audited — so an auditor's trust chain is
// walkable. A reader evaluates "do I trust this audit?" by
// examining both (a) the shape conformance and (b) whether the
// cited evidence actually exists.

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;

async function fetchText(url, timeoutMs = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' }, signal: ac.signal });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function putText(url, body) {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body,
  });
  return r.ok;
}

// (reuse v2's parsing + SHACL logic; inline minimal copies here.)
function parseManifestEntries(ttl) {
  const entries = []; let cur = null;
  for (const raw of ttl.split('\n')) {
    const line = raw.trim();
    const s = line.match(/^<([^>]+)>\s+a\s+cg:ManifestEntry/);
    if (s) { cur = { descriptorUrl: s[1], describes: [], conformsTo: [] }; continue; }
    if (!cur) continue;
    let m;
    if ((m = line.match(/cg:describes\s+<([^>]+)>/))) cur.describes.push(m[1]);
    if ((m = line.match(/dct:conformsTo\s+<([^>]+)>/))) cur.conformsTo.push(m[1]);
    if ((m = line.match(/cg:modalStatus\s+cg:(\w+)/))) cur.modalStatus = m[1];
    if (line.endsWith('.')) { entries.push(cur); cur = null; }
  }
  return entries;
}

function parseDescriptor(ttl) {
  const issuerM = ttl.match(/cg:TrustFacet[\s\S]*?cg:issuer\s+<([^>]+)>/);
  const modalM = ttl.match(/cg:modalStatus\s+cg:(\w+)/);
  const confM = ttl.match(/cg:epistemicConfidence\s+"([\d.]+)"/);
  const conformsTo = [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)].map(m => m[1]);
  return {
    issuer: issuerM?.[1] ?? null,
    modal: modalM?.[1] ?? null,
    confidence: confM ? parseFloat(confM[1]) : null,
    conformsTo,
  };
}

function parseShape(ttl) {
  const shape = { properties: [] };
  const re = /sh:property\s+\[([\s\S]*?)\]\s*(?:[;.])/g;
  let m;
  while ((m = re.exec(ttl)) !== null) {
    const body = m[1]; const c = {}; let pm;
    if ((pm = body.match(/sh:path\s+(\S+?)\s*[;\n]/))) c.path = pm[1];
    if ((pm = body.match(/sh:in\s+\(([^)]*)\)/))) c.inValues = pm[1].trim().split(/\s+/);
    if ((pm = body.match(/sh:hasValue\s+<([^>]+)>/))) c.hasValue = pm[1];
    if ((pm = body.match(/sh:minInclusive\s+([\d.]+)/))) c.minInclusive = parseFloat(pm[1]);
    if ((pm = body.match(/sh:maxInclusive\s+([\d.]+)/))) c.maxInclusive = parseFloat(pm[1]);
    if ((pm = body.match(/sh:minCount\s+(\d+)/))) c.minCount = parseInt(pm[1], 10);
    if ((pm = body.match(/sh:message\s+"([^"]+)"/))) c.message = pm[1];
    shape.properties.push(c);
  }
  return shape;
}

function validate(d, shape) {
  const v = [];
  for (const c of shape.properties) {
    const value =
      c.path === 'cg:modalStatus' ? d.modal :
      c.path === 'cg:epistemicConfidence' ? d.confidence :
      c.path === 'dct:conformsTo' ? d.conformsTo :
      undefined;
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    if (c.minCount > 0 && values.length === 0) { v.push(c.message ?? `missing ${c.path}`); continue; }
    if (c.inValues) {
      const want = c.inValues.map(x => x.replace(/^cg:/, ''));
      for (const val of values) if (!want.includes(String(val).replace(/^cg:/, ''))) v.push(c.message ?? `bad value ${val}`);
    }
    if (c.hasValue) if (!values.includes(c.hasValue)) v.push(c.message ?? `missing ${c.hasValue}`);
    if (c.minInclusive != null) for (const val of values) { const n = +val; if (Number.isFinite(n) && n < c.minInclusive) v.push(c.message ?? `${n} < ${c.minInclusive}`); }
    if (c.maxInclusive != null) for (const val of values) { const n = +val; if (Number.isFinite(n) && n > c.maxInclusive) v.push(c.message ?? `${n} > ${c.maxInclusive}`); }
  }
  return v;
}

// ── Build an audit-result descriptor Turtle ────────────────

function buildAuditDescriptor({ id, targetGraph, findings, evidence, auditorLens, confidence }) {
  const now = new Date().toISOString();
  const derivedFromLines = evidence.map(e => `        prov:wasDerivedFrom <${e}> ;`).join('\n');
  const findingsTurtle = findings.map((f, i) => `    <${id}#finding${i}> a <urn:audit:Finding> ;
        <urn:audit:target> <${f.target}> ;
        <urn:audit:conforms> "${f.conforms}" ;
        <urn:audit:violations> "${f.violations.replace(/"/g, '\\"')}" .`).join('\n');
  return `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${id}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    cg:describes <urn:graph:audit:${encodeURIComponent(targetGraph)}> ;
    cg:hasFacet [
        a cg:TemporalFacet ;
        cg:validFrom "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [
            a prov:Activity ;
            prov:wasAssociatedWith <${auditorLens}> ;
            prov:endedAtTime "${now}"^^xsd:dateTime
        ] ;
${derivedFromLines}
        prov:wasAttributedTo <${auditorLens}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [
        a cg:AgentFacet ;
        cg:assertingAgent [
            a prov:SoftwareAgent, as:Application ;
            cg:agentIdentity <${auditorLens}>
        ] ;
        cg:agentRole cg:Author ;
        cg:onBehalfOf <${auditorLens}>
    ] ;
    cg:hasFacet [
        a cg:SemioticFacet ;
        cg:groundTruth "true"^^xsd:boolean ;
        cg:modalStatus cg:Asserted ;
        cg:epistemicConfidence "${confidence}"^^xsd:double
    ] ;
    cg:hasFacet [
        a cg:TrustFacet ;
        cg:issuer <${auditorLens}> ;
        cg:trustLevel cg:SelfAsserted
    ] ;
    cg:hasFacet [
        a cg:FederationFacet ;
        cg:origin <${POD}> ;
        cg:storageEndpoint <${POD}> ;
        cg:syncProtocol cg:SolidNotifications
    ] .

${findingsTurtle}
`;
}

// ── Main ────────────────────────────────────────────────────

const TARGET_GRAPHS = [
  'urn:graph:shared:cross-issuer-test:semantic-probe',
];

const AUDITOR_LENS = 'urn:agent:auditor:v3';

const manifestTtl = await fetchText(MANIFEST_URL);
if (!manifestTtl) { console.error('Cannot fetch manifest'); process.exit(1); }
const entries = parseManifestEntries(manifestTtl);

// Prefetch the audit-result shape to self-validate before publishing.
const auditShapeTtl = await fetchText(AUDIT_SHAPE);
const auditShape = auditShapeTtl ? parseShape(auditShapeTtl) : null;

console.log('=== Auditor v3: SHACL + emit + self-validate ===\n');

for (const graphIri of TARGET_GRAPHS) {
  const matching = entries.filter(e => e.describes.includes(graphIri));
  console.log(`── Auditing ${graphIri}`);
  console.log(`   Target descriptors: ${matching.length}`);

  const findings = [];
  const evidenceUrls = [];
  const shapeCache = new Map();

  for (const e of matching) {
    const ttl = await fetchText(e.descriptorUrl, 8000);
    if (!ttl) continue;
    const d = parseDescriptor(ttl);
    evidenceUrls.push(e.descriptorUrl);

    for (const schemaIri of d.conformsTo) {
      if (!shapeCache.has(schemaIri)) {
        const shTtl = await fetchText(schemaIri, 5000);
        shapeCache.set(schemaIri, shTtl ? parseShape(shTtl) : null);
      }
      const shape = shapeCache.get(schemaIri);
      if (!shape) {
        findings.push({ target: e.descriptorUrl, conforms: 'nominal-only', violations: 'schema unreachable' });
        continue;
      }
      const violations = validate(d, shape);
      findings.push({
        target: e.descriptorUrl,
        conforms: violations.length === 0 ? 'yes' : 'no',
        violations: violations.join(' | ') || 'none',
      });
    }
  }

  // Compose the audit-result descriptor.
  const auditId = `urn:cg:audit:${encodeURIComponent(graphIri)}:${Date.now()}`;
  const conformingCount = findings.filter(f => f.conforms === 'yes').length;
  const violatingCount = findings.filter(f => f.conforms === 'no').length;
  const confidence = findings.length > 0 ? conformingCount / findings.length : 1.0;

  const auditTtl = buildAuditDescriptor({
    id: auditId,
    targetGraph: graphIri,
    findings,
    evidence: evidenceUrls,
    auditorLens: AUDITOR_LENS,
    confidence: confidence.toFixed(3),
  });

  // Self-validate: does the audit descriptor itself conform to the
  // audit-result shape? The auditor eats its own dogfood.
  const selfParsed = parseDescriptor(auditTtl);
  const selfViolations = auditShape ? validate(selfParsed, auditShape) : [];
  if (selfViolations.length > 0) {
    console.log(`   ⚠ SELF-VALIDATION FAILED — audit descriptor violates its own shape:`);
    for (const v of selfViolations) console.log(`       - ${v}`);
    console.log(`   → skipping publish (the auditor must conform to its own rules)`);
    continue;
  } else {
    console.log(`   ✓ Self-validation passed`);
  }

  // Publish via direct PUT.
  const auditUrl = `${POD}context-graphs/audit-${encodeURIComponent(graphIri)}-${Date.now()}.ttl`;
  const ok = await putText(auditUrl, auditTtl);
  console.log(`   ${ok ? '✓' : '✗'} PUT audit → ${auditUrl}`);
  console.log(`     findings: ${conformingCount} conforming, ${violatingCount} violating, confidence=${confidence.toFixed(3)}`);

  // Append to manifest so `discover_context conformsTo=audit-result-v1`
  // actually returns this descriptor.
  const manifestEntry = `

<${auditUrl}> a cg:ManifestEntry ;
    cg:describes <urn:graph:audit:${encodeURIComponent(graphIri)}> ;
    cg:hasFacetType cg:Temporal ;
    cg:hasFacetType cg:Provenance ;
    cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ;
    cg:hasFacetType cg:Trust ;
    cg:hasFacetType cg:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    cg:modalStatus cg:Asserted ;
    cg:trustLevel cg:SelfAsserted .
`;
  const currentManifest = await fetchText(MANIFEST_URL);
  const updated = (currentManifest ?? '') + manifestEntry;
  const mOk = await putText(MANIFEST_URL, updated);
  console.log(`   ${mOk ? '✓' : '✗'} manifest appended`);
  console.log('');
}

console.log('── The audit trail is now first-class:');
console.log(`   Run: curl -s ${MANIFEST_URL} | grep audit-result-v1`);
console.log('   To find every audit this auditor has ever published.');
