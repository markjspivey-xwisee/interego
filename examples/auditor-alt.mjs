// Alternative auditor — same checks as v4 but stricter:
//   - conflictOfInterest is FAIL (not flag/warn)
//   - missing recomputation sample is FAIL
//   - confidence weighted differently in the score
//
// Publishes its findings to the same audit-result-v1 shape so a
// consensus tool can compare v4-meta's scores against v4-alt's
// scores for identical inputs. Divergence between independent
// auditors = a signal the federation should look at more closely.

const POD = 'https://gate.interego.xwisee.com/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;
const ALT_LENS = 'urn:agent:auditor:v4-alt-strict';

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

async function auditStrict(target) {
  const checks = {};
  let score = 0, weights = 0;

  // Fetch all wasDerivedFrom evidence ONCE, in parallel, and reuse.
  // The previous code double-fetched each citation (one for phantom
  // check, one for COI) sequentially → N×2 round-trips.
  const evidenceTtls = await Promise.all(
    target.wasDerivedFrom.map(ev => fetchText(ev, 4000))
  );

  // Phantom-evidence (weight 0.4; hard-fail on any broken citation)
  const broken = evidenceTtls.filter(t => !t).length;
  checks.phantomEvidence = broken === 0 ? 'pass' : `fail: ${broken}/${target.wasDerivedFrom.length} broken`;
  score += (broken === 0 ? 1 : 0) * 0.4;
  weights += 0.4;

  // Conflict of interest (weight 0.3; FAIL if overlap, not just flag)
  const evidenceIssuers = new Set();
  for (const t of evidenceTtls) {
    if (t) { const p = parseDescriptor(t); if (p.issuer) evidenceIssuers.add(p.issuer); }
  }
  const hasCOI = evidenceIssuers.has(target.issuer);
  checks.conflictOfInterest = hasCOI
    ? `fail: auditor=audited (alt-auditor treats this as disqualifying)`
    : `pass (${evidenceIssuers.size} distinct audited issuers)`;
  score += (hasCOI ? 0 : 1) * 0.3;
  weights += 0.3;

  // Recomputation sample (weight 0.2; FAIL if no sample available)
  let recomputeResult = 'no-sample';
  if (target.wasDerivedFrom.length > 0) {
    const sample = target.wasDerivedFrom[0];
    const t = await fetchText(sample);
    if (t) {
      const d = parseDescriptor(t);
      // Ask at least one schema to agree. Stricter auditor: any schema
      // violation from the sample is a fail for the audit.
      let ok = true;
      for (const s of d.conformsTo) {
        const st = await fetchText(s, 4000);
        if (!st) continue;
        // Simple: just check that s is reachable and the descriptor
        // has a valid modal. Mini-check, not full SHACL.
        if (!d.modal) { ok = false; break; }
      }
      recomputeResult = ok ? 'pass: sample ok' : 'fail: sample inconsistent';
    }
  }
  checks.recomputation = recomputeResult;
  score += (recomputeResult.startsWith('pass') ? 1 : 0) * 0.2;
  weights += 0.2;

  // Confidence-in-range (weight 0.1)
  const confInRange = Number.isFinite(target.confidence) && target.confidence >= 0 && target.confidence <= 1;
  checks.confidenceInRange = confInRange ? 'pass' : 'fail';
  score += (confInRange ? 1 : 0) * 0.1;
  weights += 0.1;

  return { checks, score: weights > 0 ? score / weights : 0 };
}

console.log('=== Auditor-alt (strict variant) ===\n');

const manifestTtl = await fetchText(MANIFEST_URL);
const entries = parseManifestEntries(manifestTtl);
const auditEntries = entries.filter(e => e.conformsTo.includes(AUDIT_SHAPE));
console.log(`Found ${auditEntries.length} audit descriptors to re-audit (strict).\n`);

// Pre-fetch all audit target Turtles in parallel.
const targetTtls = await Promise.all(
  auditEntries.map(e => fetchText(e.descriptorUrl, 5000))
);

const reports = [];
for (let i = 0; i < auditEntries.length; i++) {
  const e = auditEntries[i];
  const ttl = targetTtls[i];
  if (!ttl) continue;
  const target = parseDescriptor(ttl);
  const { checks, score } = await auditStrict(target);
  console.log(`── ${e.descriptorUrl.split('/').pop().slice(0, 60)}`);
  console.log(`   score=${score.toFixed(3)}`);
  for (const [k, v] of Object.entries(checks)) console.log(`   ${v.startsWith('pass') ? '✓' : '✗'} ${k}: ${v}`);
  console.log('');
  reports.push({ url: e.descriptorUrl, score });
}

// Publish a meta-summary descriptor for the alt auditor's run.
const now = new Date().toISOString();
const summaryId = `urn:iep:audit:alt-summary:${Date.now()}`;
const summaryGraph = `urn:graph:audit:alt-summary:${Date.now()}`;
const summaryUrl = `${POD}context-graphs/audit-alt-summary-${Date.now()}.ttl`;
const avgScore = reports.length > 0 ? reports.reduce((s, r) => s + r.score, 0) / reports.length : 0;
const derived = reports.slice(0, 8).map(r => `        prov:wasDerivedFrom <${r.url}> ;`).join('\n');

const summaryTtl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${summaryId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:describes <${summaryGraph}> ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${ALT_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derived}
        prov:wasAttributedTo <${ALT_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${ALT_LENS}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${ALT_LENS}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "${avgScore.toFixed(3)}"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${ALT_LENS}> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;

await putText(summaryUrl, summaryTtl);
const entry = `

<${summaryUrl}> a iep:ManifestEntry ;
    iep:describes <${summaryGraph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);
console.log(`── Published alt-audit summary:  ${summaryUrl.split('/').pop()}`);
console.log(`   avgScore=${avgScore.toFixed(3)}  (strict weighting: phantom=0.4 COI=0.3 recompute=0.2 confInRange=0.1)`);
