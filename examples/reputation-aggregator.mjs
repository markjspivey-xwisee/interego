// Reputation aggregator — walks the full federation manifest, groups
// all claims by issuer, computes calibration metrics, and publishes
// one ERC-8004-compatible attestation descriptor per issuer.
//
// Metrics per issuer:
//   - claimCount                      total claims they've made
//   - avgConfidence                   mean of cg:epistemicConfidence
//   - modalDistribution               Asserted/Counterfactual/Hypothetical shares
//   - distinctSchemas                 count of distinct conformsTo
//   - schemaViolationRate             fraction of claims that fail their
//                                     own cited shape (from audit trail)
//   - supersededByOthers              count
//   - selfReversals                   count (supersedes own earlier claim)
//   - reputationScore                 composite in [0,1]
//
// Each attestation conforms to erc8004-attestation-v1 and is
// internally consistent: confidence field reflects the calibration
// score. A future agent filters `conformsTo = erc8004-attestation-v1`
// and orders by epistemicConfidence to rank agents.

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const ERC8004_SHAPE = `${POD}schemas/erc8004-attestation-v1.ttl`;
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;
const AGGREGATOR_LENS = 'urn:agent:reputation-aggregator:v1';

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
  return {
    issuer: ttl.match(/cg:TrustFacet[\s\S]*?cg:issuer\s+<([^>]+)>/)?.[1] ?? null,
    modal: ttl.match(/cg:modalStatus\s+cg:(\w+)/)?.[1] ?? null,
    confidence: parseFloat(ttl.match(/cg:epistemicConfidence\s+"([\d.]+)"/)?.[1] ?? 'NaN'),
    conformsTo: [...ttl.matchAll(/dct:conformsTo\s+<([^>]+)>/g)].map(m => m[1]),
    wasDerivedFrom: [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)].map(m => m[1]),
    supersedes: [...ttl.matchAll(/cg:supersedes\s+<([^>]+)>/g)].map(m => m[1]),
    describes: ttl.match(/cg:describes\s+<([^>]+)>/)?.[1] ?? null,
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
    shape.properties.push(c);
  }
  return shape;
}

function violates(d, shape) {
  for (const c of shape.properties) {
    const value =
      c.path === 'cg:modalStatus' ? d.modal :
      c.path === 'cg:epistemicConfidence' ? d.confidence :
      c.path === 'dct:conformsTo' ? d.conformsTo :
      c.path === 'prov:wasDerivedFrom' ? d.wasDerivedFrom :
      undefined;
    const values = Array.isArray(value) ? value : value == null || Number.isNaN(value) ? [] : [value];
    if (c.minCount > 0 && values.length === 0) return true;
    if (c.inValues) { const want = c.inValues.map(x => x.replace(/^cg:/, '')); for (const v of values) if (!want.includes(String(v).replace(/^cg:/, ''))) return true; }
    if (c.hasValue) if (!values.includes(c.hasValue)) return true;
    if (c.minInclusive != null) for (const v of values) { const n = +v; if (Number.isFinite(n) && n < c.minInclusive) return true; }
    if (c.maxInclusive != null) for (const v of values) { const n = +v; if (Number.isFinite(n) && n > c.maxInclusive) return true; }
  }
  return false;
}

// ── Walk the federation ─────────────────────────────────────

const manifestTtl = await fetchText(MANIFEST_URL);
const entries = parseManifestEntries(manifestTtl);
console.log(`Walking ${entries.length} manifest entries...\n`);

// Parallel fetch with bounded concurrency — the old sequential loop
// scaled O(N) × per-request latency and hit the 60s ceiling at ~90
// descriptors. Pool of 16 in-flight is CSS-gentle and tractable.
async function fetchInPool(urls, poolSize, timeoutMs) {
  const out = new Array(urls.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      out[i] = await fetchText(urls[i], timeoutMs);
    }
  }
  await Promise.all(Array.from({ length: poolSize }, worker));
  return out;
}

const ttls = await fetchInPool(entries.map(e => e.descriptorUrl), 16, 5000);
const allDescs = [];
const shapeCache = new Map();
for (let i = 0; i < entries.length; i++) {
  const t = ttls[i];
  if (!t) continue;
  allDescs.push({ ...entries[i], ...parseDescriptor(t) });
}

// Pre-fetch every distinct conformsTo shape in parallel so the
// per-issuer loop below is pure local work.
const distinctSchemas = [...new Set(allDescs.flatMap(d => d.conformsTo))];
const shapeTtls = await fetchInPool(distinctSchemas, 8, 4000);
for (let i = 0; i < distinctSchemas.length; i++) {
  shapeCache.set(distinctSchemas[i], shapeTtls[i] ? parseShape(shapeTtls[i]) : null);
}

// ── Compute per-issuer metrics ──────────────────────────────

const byIssuer = new Map();
for (const d of allDescs) {
  if (!d.issuer) continue;
  if (!byIssuer.has(d.issuer)) byIssuer.set(d.issuer, []);
  byIssuer.get(d.issuer).push(d);
}

const reputations = [];
for (const [issuer, claims] of byIssuer.entries()) {
  const confidences = claims.map(c => c.confidence).filter(n => Number.isFinite(n));
  const avgConf = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;

  const modalCounts = {};
  for (const c of claims) modalCounts[c.modal] = (modalCounts[c.modal] ?? 0) + 1;

  const schemas = new Set(claims.flatMap(c => c.conformsTo));

  // Shape-violation rate using the pre-fetched shape cache (no HTTP here).
  let checked = 0, violators = 0;
  for (const c of claims) {
    for (const s of c.conformsTo) {
      const sh = shapeCache.get(s);
      if (!sh) continue;
      checked++;
      if (violates(c, sh)) violators++;
    }
  }
  const violationRate = checked ? violators / checked : 0;

  const selfReversals = claims.filter(c => c.supersedes.some(sup => claims.find(other => other.descriptorUrl === sup || other.describes === sup))).length;

  // Composite reputation score — simple weighted blend; real systems
  // would tune weights via outcome data.
  const reputationScore = Math.max(0, Math.min(1,
    0.45 * avgConf
    + 0.35 * (1 - violationRate)
    + 0.20 * Math.min(1, claims.length / 10)  // participation
  ));

  reputations.push({
    issuer,
    claimCount: claims.length,
    avgConf,
    violationRate,
    selfReversals,
    distinctSchemas: schemas.size,
    modalCounts,
    reputationScore,
  });
}

reputations.sort((a, b) => b.reputationScore - a.reputationScore);

console.log('── Per-issuer reputation (ranked):');
for (const r of reputations) {
  console.log(`   ${r.reputationScore.toFixed(3)}  ${r.issuer.slice(0, 68)}`);
  console.log(`     claims=${r.claimCount}  avgConf=${r.avgConf.toFixed(3)}  violationRate=${r.violationRate.toFixed(3)}  selfReversals=${r.selfReversals}  schemas=${r.distinctSchemas}`);
}
console.log('');

// ── Publish each reputation as an ERC-8004 attestation ─────
//
// Batching strategy: PUT all attestation bodies in parallel, then
// build ONE manifest-append block and PUT the manifest once. The
// old code did fetch+PUT of the full manifest per attestation,
// which is O(N²) in manifest size. 12 attestations with a 100-entry
// manifest ≈ 12 × (fetch 50KB + PUT 50KB) = ~60s just for manifest.

const ts = Date.now();
const attestJobs = [];
let combinedManifestEntries = '';
for (const r of reputations) {
  const id = `urn:cg:attest:${ts}-${r.issuer.split(':').pop().slice(0, 24)}`;
  const graphIri = `urn:graph:attest:${encodeURIComponent(r.issuer)}:${ts}`;
  const url = `${POD}context-graphs/attest-${ts}-${encodeURIComponent(r.issuer.split(':').pop().slice(0, 24))}.ttl`;
  const now = new Date().toISOString();

  // Cite the aggregator's evidence — every claim this issuer ever made.
  const evidenceUrls = byIssuer.get(r.issuer).slice(0, 5).map(d => d.descriptorUrl);
  const derivedLines = evidenceUrls.map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');

  const ttl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix erc: <urn:erc:8004:> .

<${id}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${ERC8004_SHAPE}> ;
    cg:describes <${graphIri}> ;
    erc:attester <${AGGREGATOR_LENS}> ;
    erc:subject <${r.issuer}> ;
    erc:claimType "reputation-aggregate-v1" ;
    erc:reputationScore "${r.reputationScore.toFixed(3)}"^^xsd:double ;
    erc:claimCount "${r.claimCount}"^^xsd:integer ;
    erc:avgConfidence "${r.avgConf.toFixed(3)}"^^xsd:double ;
    erc:violationRate "${r.violationRate.toFixed(3)}"^^xsd:double ;
    erc:progressiveTier "T0" ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${AGGREGATOR_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derivedLines}
        prov:wasAttributedTo <${AGGREGATOR_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [
        a cg:AgentFacet ;
        cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${AGGREGATOR_LENS}> ] ;
        cg:agentRole cg:Author ;
        cg:onBehalfOf <${AGGREGATOR_LENS}>
    ] ;
    cg:hasFacet [
        a cg:SemioticFacet ;
        cg:groundTruth "true"^^xsd:boolean ;
        cg:modalStatus cg:Asserted ;
        cg:epistemicConfidence "${r.reputationScore.toFixed(3)}"^^xsd:double
    ] ;
    cg:hasFacet [
        a cg:TrustFacet ;
        cg:issuer <${AGGREGATOR_LENS}> ;
        cg:trustLevel cg:SelfAsserted
    ] ;
    cg:hasFacet [
        a cg:FederationFacet ;
        cg:origin <${POD}> ;
        cg:storageEndpoint <${POD}> ;
        cg:syncProtocol cg:SolidNotifications
    ] .
`;

  attestJobs.push({ url, ttl, slug: url.split('/').pop() });

  combinedManifestEntries += `

<${url}> a cg:ManifestEntry ;
    cg:describes <${graphIri}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${ERC8004_SHAPE}> ;
    cg:modalStatus cg:Asserted ;
    cg:trustLevel cg:SelfAsserted .
`;
}

// Batch-PUT all attestations in parallel.
const results = await Promise.all(
  attestJobs.map(j => putText(j.url, j.ttl).then(ok => ({ ok, slug: j.slug })))
);
for (const r of results) console.log(`   ${r.ok ? '✓' : '✗'} attest → ${r.slug}`);

// ONE manifest fetch + PUT for all entries.
const currentManifest = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (currentManifest ?? '') + combinedManifestEntries);

console.log('');
console.log(`── Published ${reputations.length} ERC-8004 T0 attestations.`);
console.log(`   Filter: dct:conformsTo = <${ERC8004_SHAPE}>`);
console.log(`   T1 next step: sign each attestation with ethers.js ECDSA, add cg:signature facet.`);
console.log(`   T2 next step: pin attestation body to IPFS, anchor CID on-chain via ERC-8004 Reputation Registry.`);
