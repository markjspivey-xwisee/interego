// Cross-auditor consensus — reads results from multiple auditors
// (v4-meta + v4-alt-strict) and publishes a consensus descriptor
// that exposes agreement/divergence per audit target.
//
// Shape: for each target descriptor audited by >1 auditor, compute
//   - scoreGap: |score_A - score_B|
//   - agreementLevel: high (gap < 0.15) | medium (< 0.3) | low (>= 0.3)
// Then publish a consensus-v1 descriptor conforming to audit-result-v1,
// citing both auditor outputs as evidence.
//
// This is the core of decentralized trust: when auditors disagree,
// the federation surfaces the disagreement as first-class data, NOT
// as a failure mode hidden in logs.

const POD = 'https://gate.interego.xwisee.com/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;
const CONSENSUS_LENS = 'urn:agent:auditor-consensus:v1';

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
    confidence: parseFloat(ttl.match(/iep:epistemicConfidence\s+"([\d.]+)"/)?.[1] ?? 'NaN'),
    wasDerivedFrom: [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)].map(m => m[1]),
    conformsTo: [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)].map(m => m[1]),
  };
}

console.log('=== Cross-auditor consensus ===\n');

const manifestTtl = await fetchText(MANIFEST_URL);
const entries = parseManifestEntries(manifestTtl);

// Fetch all audit-result descriptors, group by their issuer
// (each auditor instance has its own Trust.issuer).
const auditsByIssuer = new Map();
for (const e of entries) {
  if (!e.conformsTo.includes(AUDIT_SHAPE)) continue;
  const ttl = await fetchText(e.descriptorUrl);
  if (!ttl) continue;
  const p = parseDescriptor(ttl);
  if (!p.issuer) continue;
  if (!auditsByIssuer.has(p.issuer)) auditsByIssuer.set(p.issuer, []);
  auditsByIssuer.get(p.issuer).push({ url: e.descriptorUrl, ...p });
}

console.log(`Distinct auditors found: ${auditsByIssuer.size}`);
for (const [issuer, audits] of auditsByIssuer.entries()) {
  console.log(`   ${issuer}: ${audits.length} audit(s)`);
}
console.log('');

// Softer pairing: audits that share at least one citation target.
// Real-world consensus needs this — strict set-equality pairing
// misses most real comparisons because auditors bundle evidence
// differently. We pair each audit with every other audit whose
// wasDerivedFrom set intersects its own.
const allAudits = [];
for (const [issuer, audits] of auditsByIssuer.entries()) {
  for (const a of audits) allAudits.push({ ...a, issuer });
}

const divergences = [];
const agreements = [];
const seenPairs = new Set();
for (let i = 0; i < allAudits.length; i++) {
  for (let j = i + 1; j < allAudits.length; j++) {
    const a = allAudits[i], b = allAudits[j];
    if (a.issuer === b.issuer) continue; // skip self-pairs
    const aSet = new Set(a.wasDerivedFrom);
    const overlap = b.wasDerivedFrom.filter(x => aSet.has(x));
    if (overlap.length === 0) continue;
    const pairKey = [a.url, b.url].sort().join('|');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    const gap = Math.abs(a.confidence - b.confidence);
    const level = gap < 0.15 ? 'high' : gap < 0.3 ? 'medium' : 'low';
    const entry = { audits: [a, b], gap, level, overlapCount: overlap.length };
    if (level === 'high') agreements.push(entry);
    else divergences.push(entry);
  }
}

console.log('── Agreement pairs (high):');
for (const a of agreements) {
  console.log(`   gap=${a.gap.toFixed(3)}  issuers=${a.audits.map(x => x.issuer.split(':').pop()).join(' vs ')}`);
}
console.log('');
console.log('── Divergence pairs (medium/low):');
for (const d of divergences) {
  console.log(`   gap=${d.gap.toFixed(3)} [${d.level}]  ${d.audits.map(x => `${x.issuer.split(':').pop()}=${x.confidence.toFixed(2)}`).join(' vs ')}`);
}
console.log('');

// Publish consensus descriptor.
const now = new Date().toISOString();
const consensusId = `urn:iep:audit:consensus:${Date.now()}`;
const consensusGraph = `urn:graph:audit:consensus:${Date.now()}`;
const consensusUrl = `${POD}context-graphs/audit-consensus-${Date.now()}.ttl`;

// Confidence = fraction of comparable pairs that are in high agreement.
const totalPairs = agreements.length + divergences.length;
const consensusScore = totalPairs > 0 ? agreements.length / totalPairs : 0;

// Cite one audit from each (divergent or agreeing) pair as evidence.
const evidence = new Set();
for (const p of [...agreements, ...divergences]) for (const a of p.audits) evidence.add(a.url);
const derivedLines = [...evidence].slice(0, 10).map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');

const ttl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${consensusId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:describes <${consensusGraph}> ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${CONSENSUS_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derivedLines}
        prov:wasAttributedTo <${CONSENSUS_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${CONSENSUS_LENS}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${CONSENSUS_LENS}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "${consensusScore.toFixed(3)}"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${CONSENSUS_LENS}> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;

await putText(consensusUrl, ttl);
const entry = `

<${consensusUrl}> a iep:ManifestEntry ;
    iep:describes <${consensusGraph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);
console.log(`── Consensus descriptor: ${consensusUrl.split('/').pop()}`);
console.log(`   score=${consensusScore.toFixed(3)}  (${agreements.length}/${totalPairs} pairs in high agreement)`);
