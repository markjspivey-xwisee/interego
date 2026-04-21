// Runs the full audit + reputation + consensus pipeline and
// publishes a heartbeat descriptor. Intended to be invoked on a
// schedule (session-level CronCreate, or durable remote trigger
// via the `schedule` skill).
//
// Heartbeat carries:
//   - auditCount at this tick
//   - attestationCount (ERC-8004 T0)
//   - lastConsensusScore (if a consensus descriptor exists)
//   - runDurationMs (for self-observability)
//
// Federation readers filter `dct:conformsTo = monitoring-heartbeat-v1`
// to see the monitor's health over time. Gaps in heartbeats = the
// monitor stopped; drift in consensus score = semantics drifting.

import { spawnSync } from 'node:child_process';

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const AUDIT_SHAPE = `${POD}schemas/audit-result-v1.ttl`;
const ERC_SHAPE = `${POD}schemas/erc8004-attestation-v1.ttl`;
const HEARTBEAT_LENS = 'urn:agent:monitor:heartbeat-v1';

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

function runScript(path) {
  const start = Date.now();
  const result = spawnSync('node', [path], { encoding: 'utf8', timeout: 60000 });
  return { durationMs: Date.now() - start, ok: result.status === 0, stderr: result.stderr };
}

const tickStart = Date.now();

console.log('=== Monitoring heartbeat ===');
console.log('Run pipeline: aggregator → alt-auditor → consensus\n');

const aggregator = runScript('examples/reputation-aggregator.mjs');
console.log(`  aggregator       ${aggregator.ok ? '✓' : '✗'}  ${aggregator.durationMs}ms`);

const altAuditor = runScript('examples/auditor-alt.mjs');
console.log(`  alt auditor      ${altAuditor.ok ? '✓' : '✗'}  ${altAuditor.durationMs}ms`);

const consensus = runScript('examples/auditor-consensus.mjs');
console.log(`  consensus        ${consensus.ok ? '✓' : '✗'}  ${consensus.durationMs}ms`);

// Scrape latest consensus score from manifest.
const manifest = await fetchText(MANIFEST_URL) ?? '';
const consensusScoreM = manifest.matchAll(/audit-consensus-(\d+)\.ttl/g);
let latestConsensusUrl = null, latestTs = 0;
for (const m of consensusScoreM) {
  const ts = parseInt(m[1], 10);
  if (ts > latestTs) { latestTs = ts; latestConsensusUrl = `${POD}context-graphs/audit-consensus-${ts}.ttl`; }
}
let lastConsensusScore = null;
if (latestConsensusUrl) {
  const ct = await fetchText(latestConsensusUrl);
  const m = ct?.match(/cg:epistemicConfidence\s+"([\d.]+)"/);
  if (m) lastConsensusScore = parseFloat(m[1]);
}

// Count audits and attestations currently in federation.
const auditCount = [...(manifest.matchAll(/dct:conformsTo\s+<[^>]*audit-result-v1[^>]*>/g))].length;
const attestationCount = [...(manifest.matchAll(/dct:conformsTo\s+<[^>]*erc8004-attestation-v1[^>]*>/g))].length;

const runDurationMs = Date.now() - tickStart;
const now = new Date().toISOString();

console.log('');
console.log(`  audits in federation: ${auditCount}`);
console.log(`  ERC-8004 attestations: ${attestationCount}`);
console.log(`  last consensus score: ${lastConsensusScore ?? 'n/a'}`);
console.log(`  total run duration: ${runDurationMs}ms`);

// Publish the heartbeat descriptor.
const hbId = `urn:cg:heartbeat:${Date.now()}`;
const hbGraph = `urn:graph:monitor:heartbeat:${Date.now()}`;
const hbUrl = `${POD}context-graphs/heartbeat-${Date.now()}.ttl`;

const ttl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix mon: <urn:monitoring:> .

<${hbId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    cg:describes <${hbGraph}> ;
    mon:auditCount "${auditCount}"^^xsd:integer ;
    mon:attestationCount "${attestationCount}"^^xsd:integer ;
    mon:lastConsensusScore "${lastConsensusScore ?? 0}"^^xsd:double ;
    mon:runDurationMs "${runDurationMs}"^^xsd:integer ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${HEARTBEAT_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${latestConsensusUrl ? `        prov:wasDerivedFrom <${latestConsensusUrl}> ;\n` : ''}        prov:wasAttributedTo <${HEARTBEAT_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${HEARTBEAT_LENS}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${HEARTBEAT_LENS}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "1.0"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${HEARTBEAT_LENS}> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;

await putText(hbUrl, ttl);
const entry = `

<${hbUrl}> a cg:ManifestEntry ;
    cg:describes <${hbGraph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);
console.log(`\n✓ Heartbeat published: ${hbUrl.split('/').pop()}`);
