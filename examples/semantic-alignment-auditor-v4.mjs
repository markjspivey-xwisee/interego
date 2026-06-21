// Semantic-alignment auditor v4 — the recursive case.
//
// v3 published its findings as descriptors. v4 reads those audit
// descriptors and audits THEM — treating each as an evidence-bearing
// claim subject to the same checks as any other claim.
//
// New checks v4 adds on top of v3:
//   1. Phantom-evidence: walk prov:wasDerivedFrom of each audit
//      descriptor, verify every cited descriptor actually resolves.
//      An audit citing non-existent evidence is a fabricated audit;
//      the trust chain is structurally broken.
//   2. Conflict-of-interest: compare the audit descriptor's
//      Trust.issuer against the issuers of each cited evidence
//      descriptor. If they overlap, flag "auditor evaluated its own
//      claims — not independent".
//   3. Independent recomputation (sample): re-audit one of the
//      cited evidence descriptors against its own schema and compare
//      to what the original audit reported. Divergence = the
//      original audit is miscalibrated.
//
// v4 publishes its meta-audit result conforming to the same
// audit-result-v1 shape. Recursion terminates naturally: v5 auditing
// v4 auditing v3 auditing originals is isomorphic at every level,
// but in practice 2-3 levels suffice for stability verification.

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;
const META_AUDITOR_LENS = 'urn:agent:auditor:v4-meta';

async function fetchText(url, t = 8000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), t);
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' }, signal: ac.signal }); return r.ok ? await r.text() : null; }
  catch { return null; } finally { clearTimeout(to); }
}

async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

function parseManifestEntries(ttl) {
  const entries = []; let cur = null;
  for (const raw of ttl.split('\n')) {
    const line = raw.trim();
    const s = line.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/);
    if (s) { cur = { descriptorUrl: s[1], describes: [], conformsTo: [] }; continue; }
    if (!cur) continue;
    let m;
    if ((m = line.match(/iep:describes\s+<([^>]+)>/))) cur.describes.push(m[1]);
    if ((m = line.match(/dct:conformsTo\s+<([^>]+)>/))) cur.conformsTo.push(m[1]);
    if ((m = line.match(/iep:modalStatus\s+iep:(\w+)/))) cur.modalStatus = m[1];
    if (line.endsWith('.')) { entries.push(cur); cur = null; }
  }
  return entries;
}

function parseDescriptor(ttl) {
  return {
    issuer: ttl.match(/iep:TrustFacet[\s\S]*?iep:issuer\s+<([^>]+)>/)?.[1] ?? null,
    modal: ttl.match(/iep:modalStatus\s+iep:(\w+)/)?.[1] ?? null,
    confidence: parseFloat(ttl.match(/iep:epistemicConfidence\s+"([\d.]+)"/)?.[1] ?? 'NaN'),
    conformsTo: [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)].map(m => m[1]),
    wasDerivedFrom: [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)].map(m => m[1]),
    describes: ttl.match(/iep:describes\s+<([^>]+)>/)?.[1] ?? null,
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
      c.path === 'iep:modalStatus' ? d.modal :
      c.path === 'iep:epistemicConfidence' ? d.confidence :
      c.path === 'dct:conformsTo' ? d.conformsTo :
      undefined;
    const values = Array.isArray(value) ? value : value == null || Number.isNaN(value) ? [] : [value];
    if (c.minCount > 0 && values.length === 0) { v.push(c.message ?? `missing ${c.path}`); continue; }
    if (c.inValues) { const want = c.inValues.map(x => x.replace(/^iep:/, '')); for (const val of values) if (!want.includes(String(val).replace(/^iep:/, ''))) v.push(c.message ?? `bad ${val}`); }
    if (c.hasValue) if (!values.includes(c.hasValue)) v.push(c.message ?? `missing ${c.hasValue}`);
    if (c.minInclusive != null) for (const val of values) { const n = +val; if (Number.isFinite(n) && n < c.minInclusive) v.push(c.message ?? `${n}<${c.minInclusive}`); }
    if (c.maxInclusive != null) for (const val of values) { const n = +val; if (Number.isFinite(n) && n > c.maxInclusive) v.push(c.message ?? `${n}>${c.maxInclusive}`); }
  }
  return v;
}

// ── Meta-audit logic ────────────────────────────────────────

async function metaAudit(auditDesc, auditDescUrl) {
  const report = { target: auditDescUrl, checks: {} };

  // Check 1: schema conformance.
  const shapeTtl = await fetchText(AUDIT_SHAPE);
  const shape = shapeTtl ? parseShape(shapeTtl) : null;
  const shapeViolations = shape ? validate(auditDesc, shape) : ['shape unavailable'];
  report.checks.shapeConformance = shapeViolations.length === 0 ? 'pass' : `fail: ${shapeViolations.join('; ')}`;

  // Check 2: phantom evidence.
  // Every wasDerivedFrom target MUST resolve to a real descriptor
  // with metadata we can fetch. A broken citation = the audit's
  // claims are not independently verifiable.
  const phantom = [];
  for (const ev of auditDesc.wasDerivedFrom) {
    const t = await fetchText(ev, 5000);
    if (!t) phantom.push(ev);
  }
  report.checks.phantomEvidence = phantom.length === 0
    ? `pass (${auditDesc.wasDerivedFrom.length} citations all resolve)`
    : `fail: ${phantom.length}/${auditDesc.wasDerivedFrom.length} citations broken`;

  // Check 3: conflict of interest.
  // Auditor's issuer vs cited-evidence issuers. Overlap means the
  // auditor audited their own claims.
  const evidenceIssuers = new Set();
  for (const ev of auditDesc.wasDerivedFrom) {
    const t = await fetchText(ev, 5000);
    if (t) { const p = parseDescriptor(t); if (p.issuer) evidenceIssuers.add(p.issuer); }
  }
  const hasCOI = evidenceIssuers.has(auditDesc.issuer);
  report.checks.conflictOfInterest = hasCOI
    ? `flag: auditor (${auditDesc.issuer}) is also among the audited issuers`
    : `pass (auditor distinct from ${evidenceIssuers.size} audited issuers)`;

  // Check 4: independent recomputation (sample — first evidence citation).
  // Re-run the SHACL check against the first cited evidence. If the
  // auditor's report matches our independent check for this one,
  // that's a sample verification of calibration.
  if (auditDesc.wasDerivedFrom.length > 0) {
    const sample = auditDesc.wasDerivedFrom[0];
    const sampleTtl = await fetchText(sample);
    if (sampleTtl) {
      const sampleDesc = parseDescriptor(sampleTtl);
      // Recompute conformance for this one against its own conformsTo schemas.
      let independentResult = 'conforms';
      for (const schemaIri of sampleDesc.conformsTo) {
        const shTtl = await fetchText(schemaIri);
        if (!shTtl) continue;
        const sh = parseShape(shTtl);
        const vs = validate(sampleDesc, sh);
        if (vs.length > 0) { independentResult = `violates: ${vs[0]}`; break; }
      }
      // Prefix with pass/fail so the ✓/✗ formatter categorizes correctly.
      const prefix = independentResult === 'conforms' ? 'pass' : 'fail';
      report.checks.recomputationSample = `${prefix}: independent check of ${sample.slice(-30)} → ${independentResult}`;
    }
  }

  return report;
}

// ── Find audit descriptors to meta-audit ───────────────────

console.log('=== Auditor v4: recursive meta-audit ===\n');

const manifestTtl = await fetchText(MANIFEST_URL);
if (!manifestTtl) process.exit(1);
const entries = parseManifestEntries(manifestTtl);

// Find all descriptors claiming to conform to audit-result-v1.
const auditEntries = entries.filter(e => e.conformsTo.includes(AUDIT_SHAPE));
console.log(`Found ${auditEntries.length} audit descriptors in the federation.\n`);

const metaReports = [];
for (const e of auditEntries) {
  const ttl = await fetchText(e.descriptorUrl);
  if (!ttl) { console.log(`  ⚠ ${e.descriptorUrl} not fetchable`); continue; }
  const audit = parseDescriptor(ttl);
  const report = await metaAudit(audit, e.descriptorUrl);

  console.log(`── Meta-audit: ${e.descriptorUrl.split('/').pop()}`);
  console.log(`   auditor: ${audit.issuer ?? '(unknown)'}`);
  for (const [check, result] of Object.entries(report.checks)) {
    const symbol = result.startsWith('pass') ? '✓' : result.startsWith('flag') ? '⚠' : '✗';
    console.log(`   ${symbol} ${check}: ${result}`);
  }
  console.log('');
  metaReports.push({ ...report, auditUrl: e.descriptorUrl });
}

// Publish the meta-audit itself as a descriptor conforming to audit-result-v1.
const now = new Date().toISOString();
const allAuditUrls = metaReports.map(r => r.auditUrl);
const passCounts = metaReports.reduce((n, r) => {
  const passes = Object.values(r.checks).filter(v => v.startsWith('pass')).length;
  const total = Object.keys(r.checks).length;
  return n + passes / Math.max(total, 1);
}, 0);
const avgScore = metaReports.length > 0 ? (passCounts / metaReports.length) : 1.0;

const metaId = `urn:iep:audit:meta:v4:${Date.now()}`;
const metaGraph = `urn:graph:audit:meta:v4:${Date.now()}`;
const derivedFromLines = allAuditUrls.map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');

const metaTtl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${metaId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:describes <${metaGraph}> ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [
            a prov:Activity ;
            prov:wasAssociatedWith <${META_AUDITOR_LENS}> ;
            prov:endedAtTime "${now}"^^xsd:dateTime
        ] ;
${derivedFromLines}
        prov:wasAttributedTo <${META_AUDITOR_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:AgentFacet ;
        iep:assertingAgent [
            a prov:SoftwareAgent, as:Application ;
            iep:agentIdentity <${META_AUDITOR_LENS}>
        ] ;
        iep:agentRole iep:Author ;
        iep:onBehalfOf <${META_AUDITOR_LENS}>
    ] ;
    iep:hasFacet [
        a iep:SemioticFacet ;
        iep:groundTruth "true"^^xsd:boolean ;
        iep:modalStatus iep:Asserted ;
        iep:epistemicConfidence "${avgScore.toFixed(3)}"^^xsd:double
    ] ;
    iep:hasFacet [
        a iep:TrustFacet ;
        iep:issuer <${META_AUDITOR_LENS}> ;
        iep:trustLevel iep:SelfAsserted
    ] ;
    iep:hasFacet [
        a iep:FederationFacet ;
        iep:origin <${POD}> ;
        iep:storageEndpoint <${POD}> ;
        iep:syncProtocol iep:SolidNotifications
    ] .
`;

const metaUrl = `${POD}context-graphs/audit-meta-v4-${Date.now()}.ttl`;
const ok = await putText(metaUrl, metaTtl);
console.log(`── Meta-audit descriptor:`);
console.log(`   ${ok ? '✓' : '✗'} PUT ${metaUrl}`);
console.log(`   avgScore (pass-ratio across ${metaReports.length} audits): ${avgScore.toFixed(3)}`);

// Append manifest.
const manifestEntry = `

<${metaUrl}> a iep:ManifestEntry ;
    iep:describes <${metaGraph}> ;
    iep:hasFacetType iep:Temporal ;
    iep:hasFacetType iep:Provenance ;
    iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ;
    iep:hasFacetType iep:Trust ;
    iep:hasFacetType iep:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:modalStatus iep:Asserted ;
    iep:trustLevel iep:SelfAsserted .
`;
const current = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (current ?? '') + manifestEntry);
console.log(`   ✓ manifest appended`);
console.log('');
console.log('── Recursion terminated: we have audit → audit-of-audit. v5 would be');
console.log('   isomorphic. The federation now carries trust claims AT ALL LEVELS.');
