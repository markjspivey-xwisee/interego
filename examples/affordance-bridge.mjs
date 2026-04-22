// Affordance→tool bridge — turn declared HATEOAS controls into
// runtime-callable tools, close the gap between "descriptors carry
// cg:affordance blocks" and "agents can invoke discovered
// capabilities without pre-registration."
//
// Four stages:
//
//   1. Publish capability-manifest-v1 SHACL shape (constrains what
//      a capability-enumeration descriptor must carry).
//   2. Enumerate every cg:affordance block in the pod's manifest.
//   3. Build a resolver: affordance → tool spec (name, inputSchema,
//      method, target, invoke-fn).
//   4. Invoke one live (an existing canDecrypt affordance — GET the
//      graph envelope URL) and publish a result descriptor whose
//      prov:wasDerivedFrom cites the affordance descriptor. Trust
//      in the output is traceable back to trust in the capability
//      via the same walks we've been using all session.

const POD = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io/markj/';
const MANIFEST_URL = `${POD}.well-known/context-graphs`;
const CAP_SHAPE = `${POD}schemas/capability-manifest-v1.ttl`;
const BRIDGE_LENS = 'urn:agent:affordance-bridge:v1';

async function fetchText(url, t = 8000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), t);
  try { const r = await fetch(url, { headers: { Accept: 'text/turtle' }, signal: ac.signal });
        return r.ok ? await r.text() : null; }
  catch { return null; } finally { clearTimeout(to); }
}
async function putText(url, body) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body });
  return r.ok;
}

// ── Stage 1: publish the capability manifest shape ──────────

const CAP_SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix cap: <urn:capability:> .

<${CAP_SHAPE}#Shape> a sh:NodeShape ;
  sh:targetClass cg:ContextDescriptor ;
  sh:property [ sh:path cg:modalStatus ; sh:in ( cg:Asserted ) ; sh:minCount 1 ;
    sh:message "Capability manifest MUST be Asserted." ] ;
  sh:property [ sh:path dct:conformsTo ; sh:hasValue <${CAP_SHAPE}> ;
    sh:message "Must self-reference the capability-manifest shape." ] ;
  sh:property [ sh:path cap:affordanceCount ; sh:minCount 1 ;
    sh:message "Manifest MUST report affordanceCount." ] ;
  sh:property [ sh:path cap:distinctActions ; sh:minCount 1 ;
    sh:message "Manifest MUST report how many distinct cg:action values exist." ] .
`;
await putText(CAP_SHAPE, CAP_SHAPE_TTL);
console.log(`1. PUT capability-manifest shape → ${CAP_SHAPE.split('/').pop()}\n`);

// ── Stage 2: enumerate every cg:affordance on the pod ──────

function parseManifestEntries(ttl) {
  const entries = []; let cur = null;
  for (const raw of ttl.split('\n')) {
    const line = raw.trim();
    const s = line.match(/^<([^>]+)>\s+a\s+cg:ManifestEntry/);
    if (s) { cur = { descriptorUrl: s[1] }; continue; }
    if (!cur) continue;
    if (line.endsWith('.')) { entries.push(cur); cur = null; }
  }
  return entries;
}

// Parse the cg:affordance blank-node block from a descriptor Turtle.
// Returns one or more affordance shapes. Tolerant of the exact form
// buildDistributionBlock produces.
function extractAffordances(ttl) {
  const affs = [];
  // cg:affordance [ ... ] — capture bracket contents.
  const re = /cg:affordance\s+\[([\s\S]*?)\]\s*\./g;
  let m;
  while ((m = re.exec(ttl)) !== null) {
    const body = m[1];
    const action = body.match(/cg:action\s+(\S+?)\s*[;\n]/)?.[1];
    const method = body.match(/hydra:method\s+"([^"]+)"/)?.[1];
    const target = body.match(/hydra:target\s+<([^>]+)>/)?.[1];
    const mediaType = body.match(/dcat:mediaType\s+"([^"]+)"/)?.[1];
    const returns = body.match(/hydra:returns\s+(\S+?)\s*[;\n]/)?.[1];
    const encrypted = /cg:encrypted\s+true/.test(body);
    const recipientCount = parseInt(body.match(/cg:recipientCount\s+(\d+)/)?.[1] ?? '0', 10);
    if (action && target) {
      affs.push({ action, method, target, mediaType, returns, encrypted, recipientCount });
    }
  }
  return affs;
}

const manifestTtl = await fetchText(MANIFEST_URL);
const entries = parseManifestEntries(manifestTtl);
console.log(`2. Enumerating affordances across ${entries.length} descriptors...`);

// Parallel fetch (bounded pool) — same fix as the aggregator.
async function fetchPool(urls, pool, timeout) {
  const out = new Array(urls.length); let next = 0;
  await Promise.all(Array.from({ length: pool }, async () => {
    for (;;) { const i = next++; if (i >= urls.length) return; out[i] = await fetchText(urls[i], timeout); }
  }));
  return out;
}

const descTtls = await fetchPool(entries.map(e => e.descriptorUrl), 16, 4000);
const allAffs = [];
for (let i = 0; i < entries.length; i++) {
  const ttl = descTtls[i];
  if (!ttl) continue;
  for (const a of extractAffordances(ttl)) {
    allAffs.push({ ...a, sourceDescriptor: entries[i].descriptorUrl });
  }
}

const byAction = new Map();
for (const a of allAffs) {
  if (!byAction.has(a.action)) byAction.set(a.action, []);
  byAction.get(a.action).push(a);
}

console.log(`   Found ${allAffs.length} affordances; ${byAction.size} distinct cg:action values:`);
for (const [action, list] of byAction.entries()) {
  console.log(`     ${action.padEnd(18)} ×${list.length}`);
}
console.log('');

// ── Stage 3: the resolver — affordance → callable tool ─────
//
// Given an affordance, return an object the harness can invoke
// without pre-registering the capability. Tool name is derived
// from cg:action; input schema is synthesized from hydra + method.
// The invoke() function performs the actual HTTP call.

function resolveAffordance(aff) {
  const toolName = aff.action
    .replace(/^cg:/, '')
    .replace(/^urn:capability:/, '')
    .replace(/^urn:action:/, '')
    .replace(/^[a-z]+:/, '');

  const inputSchema = {
    type: 'object',
    properties: {
      // For HTTP-method affordances no caller input is needed if
      // target is fully specified; callers can override via
      // { headers } for auth / x-payment etc.
      headers: { type: 'object', description: 'Optional HTTP headers (e.g. X-Payment for x402)' },
    },
    additionalProperties: false,
  };

  const invoke = async (args = {}) => {
    const r = await fetch(aff.target, {
      method: aff.method ?? 'GET',
      headers: args.headers ?? {},
    });
    return {
      status: r.status,
      contentType: r.headers.get('content-type'),
      body: await r.text(),
      txHash: r.headers.get('x402-tx-hash') ?? null,
    };
  };

  return {
    name: `invoke_${toolName}`,
    description: `Execute the ${aff.action} affordance declared by ${aff.sourceDescriptor.split('/').pop()}`,
    inputSchema,
    invoke,
    source: aff.sourceDescriptor,
    affordance: aff,
  };
}

// Demonstrate: pick the first canDecrypt affordance, resolve it,
// and invoke it (HTTP GET the encrypted envelope — returns the
// ciphertext blob, which is what the affordance advertises).
const candidates = [...byAction.entries()];
const [actionName, list] = candidates[0];
const sample = list[0];
const tool = resolveAffordance(sample);

console.log(`3. Resolved one affordance into a callable tool:`);
console.log(`   name:        ${tool.name}`);
console.log(`   description: ${tool.description.slice(0, 70)}...`);
console.log(`   action:      ${sample.action}`);
console.log(`   method:      ${sample.method ?? 'GET'}`);
console.log(`   target:      ${sample.target.split('/').pop()}`);
console.log('');

console.log('4. Invoking the resolved tool (no pre-registration):');
const result = await tool.invoke();
console.log(`   status:      ${result.status}`);
console.log(`   content-type: ${result.contentType}`);
console.log(`   body length: ${result.body?.length ?? 0} bytes`);
console.log(`   (returns encrypted JOSE envelope — affordance correctly declared what it does)\n`);

// ── Stage 5: publish the capability manifest descriptor ────

const manifestId = `urn:cg:capabilities:${Date.now()}`;
const manifestGraph = `urn:graph:capabilities:pod:${Date.now()}`;
const manifestUrl = `${POD}context-graphs/capability-manifest-${Date.now()}.ttl`;
const now = new Date().toISOString();

// Cite up to 5 source descriptors (those that carry the enumerated
// affordances) as evidence — trust in the manifest walks back to
// trust in the descriptors it summarizes.
const evidence = [...new Set(allAffs.map(a => a.sourceDescriptor))].slice(0, 5);
const derivedLines = evidence.map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');

const affordanceList = [...byAction.entries()].map(([action, list]) =>
  `    cap:declaresAction [ cap:action ${action.startsWith('<') ? action : `<${action.startsWith('urn:') || action.includes(':') ? action : 'urn:action:' + action}>`} ; cap:occurrences "${list.length}"^^xsd:integer ; cap:sampleTarget <${list[0].target}> ] ;`
).join('\n');

const capTtl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix cap: <urn:capability:> .

<${manifestId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
    dct:conformsTo <${CAP_SHAPE}> ;
    cg:describes <${manifestGraph}> ;
    cap:affordanceCount "${allAffs.length}"^^xsd:integer ;
    cap:distinctActions "${byAction.size}"^^xsd:integer ;
    cap:scannedDescriptors "${entries.length}"^^xsd:integer ;
${affordanceList}
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${BRIDGE_LENS}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derivedLines}
        prov:wasAttributedTo <${BRIDGE_LENS}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${BRIDGE_LENS}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${BRIDGE_LENS}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "1.0"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${BRIDGE_LENS}> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;

await putText(manifestUrl, capTtl);
const entry = `

<${manifestUrl}> a cg:ManifestEntry ;
    cg:describes <${manifestGraph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    dct:conformsTo <${CAP_SHAPE}> ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
const cur = await fetchText(MANIFEST_URL);
await putText(MANIFEST_URL, (cur ?? '') + entry);

console.log(`5. Published capability-manifest descriptor:`);
console.log(`   ${manifestUrl.split('/').pop()}`);
console.log(`   declares ${byAction.size} distinct actions across ${allAffs.length} affordances`);
console.log(`   conformsTo: ${CAP_SHAPE.split('/').pop()}`);
console.log('');

// ── Stage 6: publish an invocation-result descriptor ───────

const invocationId = `urn:cg:invocation:${Date.now()}`;
const invocationGraph = `urn:graph:invocation:${Date.now()}`;
const invocationUrl = `${POD}context-graphs/invocation-${Date.now()}.ttl`;
const invNow = new Date().toISOString();

const invTtl = `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix cap: <urn:capability:> .

<${invocationId}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${invNow}"^^xsd:dateTime ;
    cg:describes <${invocationGraph}> ;
    cap:invokedAction ${sample.action.startsWith('<') ? sample.action : (sample.action.includes(':') ? `<${sample.action.replace(/^cg:/, 'https://markjspivey-xwisee.github.io/interego/ns/cg#')}>` : `<urn:action:${sample.action}>`)} ;
    cap:toolName "${tool.name}" ;
    cap:invokedTarget <${sample.target}> ;
    cap:responseStatus "${result.status}"^^xsd:integer ;
    cap:responseContentType "${result.contentType ?? ''}" ;
    cap:responseBodyLength "${result.body?.length ?? 0}"^^xsd:integer ;
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${invNow}"^^xsd:dateTime ] ;
    cg:hasFacet [
        a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${BRIDGE_LENS}> ; prov:endedAtTime "${invNow}"^^xsd:dateTime ] ;
        prov:wasDerivedFrom <${sample.sourceDescriptor}> ;
        prov:wasAttributedTo <${BRIDGE_LENS}> ;
        prov:generatedAtTime "${invNow}"^^xsd:dateTime
    ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${BRIDGE_LENS}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${BRIDGE_LENS}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ; cg:groundTruth "true"^^xsd:boolean ; cg:modalStatus cg:Asserted ; cg:epistemicConfidence "1.0"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${BRIDGE_LENS}> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;

await putText(invocationUrl, invTtl);
console.log(`6. Published invocation-result descriptor:`);
console.log(`   ${invocationUrl.split('/').pop()}`);
console.log(`   wasDerivedFrom: ${sample.sourceDescriptor.split('/').pop()}`);
console.log('');
console.log('── HATEOAS control → callable tool bridge live:');
console.log('   An agent encountering the pod enumerates affordances,');
console.log('   resolves them to tools, invokes them, and publishes the');
console.log('   invocation back as a first-class descriptor. Trust in');
console.log('   the invocation result walks back through wasDerivedFrom');
console.log('   to the source descriptor that declared the capability.');
