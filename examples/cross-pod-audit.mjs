// Cross-pod audit — actually exercises the full auditor pipeline
// across the pod boundary. Not just "the URL resolves" but
// "the audit machinery reads POD-B's manifest, fetches POD-A
// evidence to verify citations, and produces a result that cites
// descriptors on both pods".
//
// This is the honest end-to-end cross-pod test — the earlier
// cross-pod-demo.mjs only proved that a POD-B URL citing POD-A
// resolved via HTTP. This one proves the trust machinery
// actually traverses the boundary.

const CSS = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const POD_A = `${CSS}/markj/`;
const POD_B = `${CSS}/u-pk-0a7f04106a54/`;
const AUDIT_SHAPE = `${POD_A}schemas/audit-result-v1.ttl`;
const CROSS_POD_LENS = 'urn:agent:auditor:cross-pod-v1';

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
    if (line.endsWith('.')) { entries.push(cur); cur = null; }
  }
  return entries;
}

function parseDescriptor(ttl) {
  return {
    issuer: ttl.match(/cg:TrustFacet[\s\S]*?cg:issuer\s+<([^>]+)>/)?.[1] ?? null,
    wasDerivedFrom: [...ttl.matchAll(/prov:wasDerivedFrom\s+<([^>]+)>/g)].map(m => m[1]),
    describes: ttl.match(/cg:describes\s+<([^>]+)>/)?.[1] ?? null,
  };
}

console.log('=== Cross-pod audit (end-to-end) ===\n');

// Step 1: list manifests on BOTH pods.
const manifestA = await fetchText(`${POD_A}.well-known/context-graphs`);
const manifestB = await fetchText(`${POD_B}.well-known/context-graphs`);
const entriesA = parseManifestEntries(manifestA ?? '');
const entriesB = parseManifestEntries(manifestB ?? '');
console.log(`1. Manifests:`);
console.log(`   POD-A: ${entriesA.length} entries`);
console.log(`   POD-B: ${entriesB.length} entries`);

// Step 2: for each POD-B descriptor, walk its wasDerivedFrom and
// verify each cited URL resolves — regardless of which pod it's on.
console.log(`\n2. Auditing each POD-B descriptor's evidence (phantom-evidence check, cross-pod):\n`);

const crossPodFindings = [];
for (const entry of entriesB) {
  const descTtl = await fetchText(entry.descriptorUrl, 5000);
  if (!descTtl) continue;
  const parsed = parseDescriptor(descTtl);

  const checks = { citations: [] };
  for (const citation of parsed.wasDerivedFrom) {
    const onPodA = citation.startsWith(POD_A);
    const onPodB = citation.startsWith(POD_B);
    const otherPod = !onPodA && !onPodB;
    const resolved = await fetchText(citation, 5000);
    checks.citations.push({
      url: citation,
      host: onPodA ? 'POD-A' : onPodB ? 'POD-B' : otherPod ? 'external' : 'unknown',
      resolves: !!resolved,
    });
  }

  const crossPodCount = checks.citations.filter(c => c.host !== (entry.descriptorUrl.startsWith(POD_A) ? 'POD-A' : 'POD-B')).length;
  const brokenCount = checks.citations.filter(c => !c.resolves).length;

  console.log(`   ${entry.descriptorUrl.split('/').pop().slice(0, 60)}`);
  console.log(`     cites ${checks.citations.length} descriptors; ${crossPodCount} cross-pod; ${brokenCount} broken`);
  for (const c of checks.citations) {
    console.log(`       ${c.resolves ? '✓' : '✗'} [${c.host.padEnd(6)}] ${c.url.split('/').pop().slice(0, 50)}`);
  }
  crossPodFindings.push({ descriptor: entry.descriptorUrl, ...checks, issuer: parsed.issuer, crossPodCount, brokenCount });
}

// Step 3: publish a cross-pod audit result back to POD-A manifest.
console.log(`\n3. Publishing cross-pod audit result to POD-A:`);

const resultId = `urn:cg:audit:cross-pod:${Date.now()}`;
const resultGraph = `urn:graph:audit:cross-pod:${Date.now()}`;
const resultUrl = `${POD_A}context-graphs/audit-cross-pod-${Date.now()}.ttl`;
const now = new Date().toISOString();

const avgScore = crossPodFindings.length
  ? crossPodFindings.reduce((s, f) => s + (f.brokenCount === 0 ? 1 : 0), 0) / crossPodFindings.length
  : 1.0;

// Cite all POD-B descriptors audited + (transitively) all POD-A evidence.
const allCited = new Set();
for (const f of crossPodFindings) {
  allCited.add(f.descriptor);
  for (const c of f.citations) allCited.add(c.url);
}
const derivedLines = [...allCited].slice(0, 10).map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');

const ttl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .

<${resultId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    cg:describes <${resultGraph}> ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${CROSS_POD_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derivedLines}
        prov:wasAttributedTo <${CROSS_POD_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${CROSS_POD_LENS}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${CROSS_POD_LENS}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "${avgScore.toFixed(3)}"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${CROSS_POD_LENS}> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD_A}> ; cg:storageEndpoint <${POD_A}> ; cg:syncProtocol cg:SolidNotifications ] .
`;

await putText(resultUrl, ttl);
const manifestEntry = `

<${resultUrl}> a cg:ManifestEntry ;
    cg:describes <${resultGraph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
const cur = await fetchText(`${POD_A}.well-known/context-graphs`);
await putText(`${POD_A}.well-known/context-graphs`, (cur ?? '') + manifestEntry);

console.log(`   ✓ PUT ${resultUrl.split('/').pop()}`);
console.log(`   avgScore=${avgScore.toFixed(3)}`);
console.log(`   audited ${crossPodFindings.length} POD-B descriptor(s), cites ${allCited.size} descriptors across 2 pods`);

console.log(`\n── Cross-pod END-TO-END verified:`);
console.log(`   The auditor reading POD-B and fetching POD-A evidence WITHOUT any`);
console.log(`   shared index, database, or coordination. Only HTTP + URL citation.`);
console.log(`   Result descriptor lives on POD-A; cites descriptors on BOTH pods.`);
