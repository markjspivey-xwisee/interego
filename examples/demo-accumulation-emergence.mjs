// Accumulation-threshold emergence: a claim starts Hypothetical at
// low confidence; as independent supporting claims accumulate (each
// with prov:wasDerivedFrom pointing back at the hypothesis), the
// federation's aggregate confidence grows. When a threshold is
// crossed, a meta-agent publishes an Asserted supersession — the
// claim has "become true" through evidence accumulation.
//
// Peircean habit-stabilization expressed as publishing discipline.
// No centralized truth authority; no mid-process overwriting of
// the original claim. Each supporter is a distinct signed record,
// the supersession is a separate descriptor, and the full trail
// from low-conf Hypothetical to high-conf Asserted is queryable.

const POD = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

function descriptorTtl({ id, graph, issuer, modal, confidence, supersedes, wasDerivedFrom, extra = '' }) {
  const now = new Date().toISOString();
  const groundTruth = modal === 'Asserted' ? 'true' : modal === 'Counterfactual' ? 'false' : null;
  const gtLine = groundTruth ? `        iep:groundTruth "${groundTruth}"^^xsd:boolean ;\n` : '';
  const supLine = supersedes ? `    iep:supersedes <${supersedes}> ;\n` : '';
  const derivedLines = (wasDerivedFrom || []).map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');
  return `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix acc: <urn:accumulation:> .

<${id}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
${supLine}    iep:describes <${graph}> ;
${extra}
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${issuer}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derivedLines}
        prov:wasAttributedTo <${issuer}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${issuer}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${issuer}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ;
${gtLine}        iep:modalStatus iep:${modal} ;
        iep:epistemicConfidence "${confidence.toFixed(3)}"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${issuer}> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;
}

async function publishDescriptor(id, graph, ttl) {
  const url = `${POD}context-graphs/${id.split(':').pop()}.ttl`;
  await putText(url, ttl);
  const entry = `

<${url}> a iep:ManifestEntry ;
    iep:describes <${graph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
  const cur = await fetchText(MANIFEST_URL);
  await putText(MANIFEST_URL, (cur ?? '') + entry);
  return url;
}

console.log('=== Accumulation-threshold emergence ===\n');

const ts = Date.now();
const hypothesisId = `urn:iep:hypothesis:${ts}`;
const hypothesisGraph = `urn:graph:hypothesis:${ts}`;

// ── Publish the hypothesis (Hypothetical, low confidence) ──
console.log('1. Hypothesis published (Hypothetical, conf=0.2):');
console.log('   "The cleartext-mirror extractor handles all Turtle shapes"');
const hypUrl = await publishDescriptor(
  hypothesisId,
  hypothesisGraph,
  descriptorTtl({
    id: hypothesisId,
    graph: hypothesisGraph,
    issuer: 'urn:agent:hypothesizer',
    modal: 'Hypothetical',
    confidence: 0.2,
    extra: `    acc:claim "Cleartext-mirror extractor handles all Turtle shapes" ;`,
  }),
);
console.log(`   → ${hypUrl.split('/').pop()}\n`);

// ── Independent supporters publish evidence over time ──────
console.log('2. Supporters accumulate evidence over time:');
const supporters = [
  { issuer: 'urn:agent:supporter:tokenizer-fix',        evidence: 'Turtle-aware tokenizer fix caught string-literal bug',    delta: 0.15 },
  { issuer: 'urn:agent:supporter:object-list-fix',      evidence: 'Object-list shorthand extractor shipped + tested',        delta: 0.15 },
  { issuer: 'urn:agent:supporter:test-suite',           evidence: '670/670 tests passing after refactor',                    delta: 0.15 },
  { issuer: 'urn:agent:supporter:adversarial-survey',   evidence: 'Adversarial descriptors all caught by v4 auditor',        delta: 0.10 },
  { issuer: 'urn:agent:supporter:cross-pod-verified',   evidence: 'Cross-pod citation chains traverse cleanly',              delta: 0.05 },
];

let aggConf = 0.2;  // starting confidence
const supporterUrls = [];
for (const s of supporters) {
  const supId = `urn:iep:supporter:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const supGraph = `urn:graph:supporter:${Date.now()}`;
  aggConf = Math.min(1.0, aggConf + s.delta);
  const supUrl = await publishDescriptor(
    supId,
    supGraph,
    descriptorTtl({
      id: supId,
      graph: supGraph,
      issuer: s.issuer,
      modal: 'Asserted',
      confidence: 0.9,
      wasDerivedFrom: [hypUrl],
      extra: `    acc:evidence "${s.evidence}" ;\n    acc:confidenceDelta "${s.delta.toFixed(2)}"^^xsd:double ;`,
    }),
  );
  supporterUrls.push(supUrl);
  console.log(`   + ${s.evidence.slice(0, 55).padEnd(57)} +${s.delta.toFixed(2)} → agg ${aggConf.toFixed(3)}`);
}
console.log('');

// ── Aggregation: walk the pod, compute support count ───────
console.log('3. Independent re-verification — meta-agent walks the pod:');
const manifest = await fetchText(MANIFEST_URL);
// Find all descriptors whose wasDerivedFrom includes the hypothesis
const supporterCount = (manifest.match(new RegExp(hypothesisId, 'g')) ?? []).length;
console.log(`   Manifest mentions of hypothesis: ${supporterCount}`);

// The supporters derive from hypUrl (the descriptor URL), not hypothesisId (the opaque IRI).
// Fetch the supporter descriptors and count.
const supporterTtls = await Promise.all(supporterUrls.map(u => fetchText(u)));
const genuineSupporters = supporterTtls.filter(t => t && t.includes(hypUrl)).length;
console.log(`   Descriptors deriving from hypothesis: ${genuineSupporters}`);
console.log(`   Aggregate confidence: ${aggConf.toFixed(3)}`);
console.log(`   Threshold for emergence: 0.8\n`);

// ── Threshold crossed → publish Asserted supersession ──────
const THRESHOLD = 0.8;
if (aggConf >= THRESHOLD) {
  console.log(`4. Threshold crossed (${aggConf.toFixed(3)} ≥ ${THRESHOLD}) — emerging:`);
  const emergedId = `urn:iep:emerged:${Date.now()}`;
  const emergedGraph = `urn:graph:emerged:${Date.now()}`;
  const emergedUrl = await publishDescriptor(
    emergedId,
    emergedGraph,
    descriptorTtl({
      id: emergedId,
      graph: emergedGraph,
      issuer: 'urn:agent:emergence-resolver',
      modal: 'Asserted',
      confidence: aggConf,
      supersedes: hypUrl,
      wasDerivedFrom: supporterUrls,
      extra: `    acc:thresholdCrossed "${THRESHOLD.toFixed(2)}"^^xsd:double ;\n    acc:supporterCount "${genuineSupporters}"^^xsd:integer ;`,
    }),
  );
  console.log(`   ✓ Asserted supersession published: ${emergedUrl.split('/').pop()}`);
  console.log(`     iep:supersedes → the original Hypothetical`);
  console.log(`     prov:wasDerivedFrom → all 5 supporters`);
  console.log(`     confidence: ${aggConf.toFixed(3)} (above 0.8 threshold)\n`);
} else {
  console.log(`4. Threshold not crossed. The hypothesis remains Hypothetical.\n`);
}

console.log('── Demonstrated:');
console.log('   The claim evolved from Hypothetical(0.2) → Asserted(' + aggConf.toFixed(3) + ')');
console.log('   through evidence accumulation, not executive decision.');
console.log('   The original Hypothetical descriptor is still there — retrievable');
console.log('   at its validFrom timestamp. The supersession chain documents');
console.log('   HOW the federation came to believe, step by step, signed by');
console.log('   independent supporters, auditable by any future reader.');
