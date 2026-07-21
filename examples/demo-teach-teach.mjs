// Agent-teaches-agent: no code changes on the student side.
//
// Teacher publishes a descriptor with a iep:affordance declaring a
// novel capability (cap:canSolveLinearEq) + a running HTTP endpoint
// that implements it. Student walks the pod's manifest, finds the
// affordance via its iep:action, resolves it to a callable tool, and
// invokes it with real input. Student publishes the result with
// prov:wasDerivedFrom citing the teacher's descriptor — credit is
// structural, not social.

import { createServer } from 'node:http';

const POD = 'https://gate.interego.xwisee.com/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const PORT = 4030;
const TEACHER_LENS = 'urn:agent:teacher:linear-algebra';
const STUDENT_LENS = 'urn:agent:student:eager-learner';

async function fetchText(url) {
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); return r.ok ? await r.text() : null; }
  catch { return null; }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

// ── Teacher's capability: solve ax + b = c for x ─────────────
function handleSolve(req, res) {
  if (req.url.startsWith('/solve')) {
    const u = new URL(`http://127.0.0.1${req.url}`);
    const a = parseFloat(u.searchParams.get('a'));
    const b = parseFloat(u.searchParams.get('b'));
    const c = parseFloat(u.searchParams.get('c'));
    if ([a, b, c].some(n => Number.isNaN(n)) || a === 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'need numeric a,b,c with a≠0' }));
    }
    const x = (c - b) / a;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ equation: `${a}x + ${b} = ${c}`, x }));
    return;
  }
  res.writeHead(404); res.end();
}

console.log('=== Agent-teaches-agent ===\n');

const server = createServer(handleSolve);
await new Promise(r => server.listen(PORT, r));
console.log(`1. Teacher's endpoint listening on :${PORT}/solve?a=&b=&c=\n`);

// ── Teacher publishes a descriptor with the novel affordance ─
const teacherId = `urn:iep:teacher:${Date.now()}`;
const teacherGraph = `urn:graph:teacher:capability:${Date.now()}`;
const teacherUrl = `${POD}context-graphs/teacher-${Date.now()}.ttl`;
const now1 = new Date().toISOString();

const teacherTtl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/cgh#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix cap: <urn:capability:> .

<${teacherId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now1}"^^xsd:dateTime ;
    iep:describes <${teacherGraph}> ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now1}"^^xsd:dateTime ] ;
    iep:hasFacet [ a iep:ProvenanceFacet ; prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${TEACHER_LENS}> ; prov:endedAtTime "${now1}"^^xsd:dateTime ] ; prov:wasAttributedTo <${TEACHER_LENS}> ; prov:generatedAtTime "${now1}"^^xsd:dateTime ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${TEACHER_LENS}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${TEACHER_LENS}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "1.0"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${TEACHER_LENS}> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .

<${teacherId}> iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action cap:canSolveLinearEq ;
    hydra:method "GET" ;
    hydra:target <http://127.0.0.1:${PORT}/solve> ;
    hydra:returns ieh:JsonResponse ;
    dcat:mediaType "application/json" ;
    ieh:inputHint "Query params: a, b, c → solves ax + b = c for x ; returns {x}"
] .
`;

await putText(teacherUrl, teacherTtl);
const teacherEntry = `

<${teacherUrl}> a iep:ManifestEntry ;
    iep:describes <${teacherGraph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur1 = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur1 ?? '') + teacherEntry);
console.log(`2. Teacher published: ${teacherUrl.split('/').pop()}`);
console.log(`   declares cap:canSolveLinearEq with target http://127.0.0.1:${PORT}/solve\n`);

// ── Student discovers the capability by walking the manifest ─
console.log('3. Student walks the manifest, looking for capabilities...');
const manifest = await fetchText(MANIFEST_URL);

// Find every iep:affordance, filter by action
const entries = [];
for (const raw of manifest.split('\n')) {
  const line = raw.trim();
  const m = line.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/);
  if (m) entries.push({ url: m[1] });
}

// Look at the most-recent 5 entries' bodies for the novel action.
let discovered = null;
for (const e of entries.slice(-10)) {
  const t = await fetchText(e.url);
  if (!t) continue;
  const m = t.match(/iep:affordance\s+\[([\s\S]*?canSolveLinearEq[\s\S]*?)\]/);
  if (m) {
    const target = m[1].match(/hydra:target\s+<([^>]+)>/)?.[1];
    discovered = { sourceDescriptor: e.url, action: 'cap:canSolveLinearEq', target };
    break;
  }
}

if (!discovered) {
  console.log('   Student failed to discover the affordance.');
  server.close(); process.exit(1);
}

console.log(`   ✓ Discovered capability: ${discovered.action}`);
console.log(`     source: ${discovered.sourceDescriptor.split('/').pop()}`);
console.log(`     target: ${discovered.target}\n`);

// ── Student invokes the discovered tool on 2x + 3 = 11 ──────
console.log('4. Student invokes the discovered tool: 2x + 3 = 11');
const invokeUrl = `${discovered.target}?a=2&b=3&c=11`;
const response = await fetch(invokeUrl).then(r => r.json());
console.log(`   response: ${JSON.stringify(response)}`);
console.log(`   student concludes: x = ${response.x}\n`);

// ── Student publishes result descriptor citing the teacher ──
const studentId = `urn:iep:student:${Date.now()}`;
const studentGraph = `urn:graph:student:learned:${Date.now()}`;
const studentUrl = `${POD}context-graphs/student-${Date.now()}.ttl`;
const now2 = new Date().toISOString();

const studentTtl = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix learn: <urn:learning:> .

<${studentId}>
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${now2}"^^xsd:dateTime ;
    iep:describes <${studentGraph}> ;
    learn:invokedCapability "cap:canSolveLinearEq" ;
    learn:input "2x + 3 = 11" ;
    learn:output "${response.x}"^^xsd:double ;
    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom "${now2}"^^xsd:dateTime ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${STUDENT_LENS}> ; prov:endedAtTime "${now2}"^^xsd:dateTime ] ;
        prov:wasDerivedFrom <${discovered.sourceDescriptor}> ;
        prov:wasAttributedTo <${STUDENT_LENS}> ;
        prov:generatedAtTime "${now2}"^^xsd:dateTime
    ] ;
    iep:hasFacet [ a iep:AgentFacet ; iep:assertingAgent [ a prov:SoftwareAgent, as:Application ; iep:agentIdentity <${STUDENT_LENS}> ] ; iep:agentRole iep:Author ; iep:onBehalfOf <${STUDENT_LENS}> ] ;
    iep:hasFacet [ a iep:SemioticFacet ; iep:groundTruth "true"^^xsd:boolean ; iep:modalStatus iep:Asserted ; iep:epistemicConfidence "1.0"^^xsd:double ] ;
    iep:hasFacet [ a iep:TrustFacet ; iep:issuer <${STUDENT_LENS}> ; iep:trustLevel iep:SelfAsserted ] ;
    iep:hasFacet [ a iep:FederationFacet ; iep:origin <${POD}> ; iep:storageEndpoint <${POD}> ; iep:syncProtocol iep:SolidNotifications ] .
`;

await putText(studentUrl, studentTtl);
const studentEntry = `

<${studentUrl}> a iep:ManifestEntry ;
    iep:describes <${studentGraph}> ;
    iep:hasFacetType iep:Temporal ; iep:hasFacetType iep:Provenance ; iep:hasFacetType iep:Agent ;
    iep:hasFacetType iep:Semiotic ; iep:hasFacetType iep:Trust ; iep:hasFacetType iep:Federation ;
    iep:modalStatus iep:Asserted ; iep:trustLevel iep:SelfAsserted .
`;
const cur2 = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur2 ?? '') + studentEntry);
console.log(`5. Student published: ${studentUrl.split('/').pop()}`);
console.log(`   learn:invokedCapability "cap:canSolveLinearEq"`);
console.log(`   prov:wasDerivedFrom <${discovered.sourceDescriptor.split('/').pop()}>`);
console.log(`   → credit back to teacher is structural, not social.\n`);

server.close();
console.log('── Demonstrated:');
console.log('   Student had zero prior knowledge of cap:canSolveLinearEq.');
console.log('   It discovered the capability, invoked it, and published a');
console.log('   result descriptor citing the teacher. Knowledge transfer');
console.log('   without code changes, without registry, without coordination.');
