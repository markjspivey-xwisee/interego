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

const POD = 'https://gate.interego.xwisee.com/markj/';
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
  const m = ct?.match(/iep:epistemicConfidence\s+"([\d.]+)"/);
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
const hbId = `urn:iep:heartbeat:${Date.now()}`;
const hbGraph = `urn:graph:monitor:heartbeat:${Date.now()}`;
const hbUrl = `${POD}context-graphs/heartbeat-${Date.now()}.ttl`;

const ttl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix mon: <urn:monitoring:> .

<${hbId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:describes <${hbGraph}> ;
    mon:auditCount "${auditCount}"^^xsd:integer ;
    mon:attestationCount "${attestationCount}"^^xsd:integer ;
    mon:lastConsensusScore "${lastConsensusScore ?? 0}"^^xsd:double ;
    mon:runDurationMs "${runDurationMs}"^^xsd:integer ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${HEARTBEAT_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${latestConsensusUrl ? `        prov:wasDerivedFrom <${latestConsensusUrl}> ;\n` : ''}        prov:wasAttributedTo <${HEARTBEAT_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${HEARTBEAT_LENS}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${HEARTBEAT_LENS}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "1.0"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${HEARTBEAT_LENS}> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;

await putText(hbUrl, ttl);
const entry = `

<${hbUrl}> a iep:ManifestEntry ;
    iep:describes <${hbGraph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    dct:conformsTo <${AUDIT_SHAPE}> ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);
console.log(`\n✓ Heartbeat published: ${hbUrl.split('/').pop()}`);
