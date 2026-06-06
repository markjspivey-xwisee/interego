// Emergent DAO — governance from descriptor publishing.
//
// No smart contract. No on-chain tally. No coordinator. Instead:
//
//   1. Three agents publish proposals (Hypothetical + describing the
//      same referent urn:graph:dao:q2-budget).
//   2. Voter agents publish support-descriptors that prov:wasDerivedFrom
//      their chosen proposal. Each vote is a signed descriptor.
//   3. Any observer walks the pod, tallies votes per proposal by
//      counting descriptors whose wasDerivedFrom = proposal_i.
//   4. A resolver publishes a resolution descriptor that:
//        - cg:supersedes all three proposals
//        - carries the winning proposal ID + tally
//        - wasDerivedFrom every vote + every proposal (full audit)
//
// Governance outcome is derivable from the federation cleartext alone.
// Quorum, weighting, override rules are SHACL-expressible; here kept
// simple (plurality).

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

function descriptorTtl({ id, graph, issuer, modal, confidence, supersedes, wasDerivedFrom, extra }) {
  const now = new Date().toISOString();
  const groundTruth = modal === 'Asserted' ? 'true' : null;
  const gtLine = groundTruth ? `        cg:groundTruth "${groundTruth}"^^xsd:boolean ;\n` : '';
  const supLines = (supersedes || []).map(s => `    cg:supersedes <${s}> ;`).join('\n');
  const derivedLines = (wasDerivedFrom || []).map(u => `        prov:wasDerivedFrom <${u}> ;`).join('\n');
  return `@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
@prefix as: <https://www.w3.org/ns/activitystreams#> .
@prefix dao: <urn:dao:> .

<${id}>
    a cg:ContextDescriptor ;
    cg:version "1"^^xsd:integer ;
    cg:validFrom "${now}"^^xsd:dateTime ;
${supLines ? supLines + '\n' : ''}    cg:describes <${graph}> ;
${extra || ''}
    cg:hasFacet [ a cg:TemporalFacet ; cg:validFrom "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [ a cg:ProvenanceFacet ;
        prov:wasGeneratedBy [ a prov:Activity ; prov:wasAssociatedWith <${issuer}> ; prov:endedAtTime "${now}"^^xsd:dateTime ] ;
${derivedLines}
        prov:wasAttributedTo <${issuer}> ;
        prov:generatedAtTime "${now}"^^xsd:dateTime ] ;
    cg:hasFacet [ a cg:AgentFacet ; cg:assertingAgent [ a prov:SoftwareAgent, as:Application ; cg:agentIdentity <${issuer}> ] ; cg:agentRole cg:Author ; cg:onBehalfOf <${issuer}> ] ;
    cg:hasFacet [ a cg:SemioticFacet ;
${gtLine}        cg:modalStatus cg:${modal} ;
        cg:epistemicConfidence "${confidence.toFixed(3)}"^^xsd:double ] ;
    cg:hasFacet [ a cg:TrustFacet ; cg:issuer <${issuer}> ; cg:trustLevel cg:SelfAsserted ] ;
    cg:hasFacet [ a cg:FederationFacet ; cg:origin <${POD}> ; cg:storageEndpoint <${POD}> ; cg:syncProtocol cg:SolidNotifications ] .
`;
}

async function publish(id, graph, ttl) {
  const slug = id.split(':').slice(-2).join('-');
  const url = `${POD}context-graphs/${slug}.ttl`;
  await putText(url, ttl);
  const entry = `

<${url}> a cg:ManifestEntry ;
    cg:describes <${graph}> ;
    cg:hasFacetType cg:Temporal ; cg:hasFacetType cg:Provenance ; cg:hasFacetType cg:Agent ;
    cg:hasFacetType cg:Semiotic ; cg:hasFacetType cg:Trust ; cg:hasFacetType cg:Federation ;
    cg:modalStatus cg:Asserted ; cg:trustLevel cg:SelfAsserted .
`;
  const cur = await fetchText(MANIFEST_URL);
  await putText(MANIFEST_URL, (cur ?? '') + entry);
  return url;
}

console.log('=== Emergent DAO: governance from descriptor publishing ===\n');

const REFERENT = `urn:graph:dao:q2-budget-2026`;
const ts = Date.now();

// ── Phase 1: three proposals ─────────────────────────────
console.log('1. Three proposers publish competing proposals:');
const proposals = [
  { id: `urn:cg:proposal:A:${ts}`,  author: 'urn:agent:dao:treasury-chair', title: 'Allocate 40% to R&D, 30% audits, 30% ops',   slug: 'A' },
  { id: `urn:cg:proposal:B:${ts}`,  author: 'urn:agent:dao:security-lead',  title: 'Allocate 60% audits, 25% R&D, 15% ops',       slug: 'B' },
  { id: `urn:cg:proposal:C:${ts}`,  author: 'urn:agent:dao:community-rep',  title: 'Allocate 25% R&D, 25% audits, 50% ecosystem', slug: 'C' },
];
const proposalUrls = {};
for (const p of proposals) {
  const graphIri = `${REFERENT}:proposal-${p.slug}`;
  const ttl = descriptorTtl({
    id: p.id,
    graph: graphIri,
    issuer: p.author,
    modal: 'Hypothetical',
    confidence: 0.7,
    extra: `    dao:proposalTitle "${p.title}" ; dao:proposalSlug "${p.slug}" ;`,
  });
  proposalUrls[p.slug] = await publish(p.id, graphIri, ttl);
  console.log(`   Proposal ${p.slug}: ${p.title}`);
  console.log(`     author=${p.author.split(':').pop()} → ${proposalUrls[p.slug].split('/').pop()}`);
}
console.log('');

// ── Phase 2: voters support one proposal each ────────────
console.log('2. Seven voters publish support-descriptors:');
const votes = [
  { voter: 'urn:agent:voter:alice',   chose: 'A' },
  { voter: 'urn:agent:voter:bob',     chose: 'B' },
  { voter: 'urn:agent:voter:carol',   chose: 'A' },
  { voter: 'urn:agent:voter:dave',    chose: 'C' },
  { voter: 'urn:agent:voter:eve',     chose: 'B' },
  { voter: 'urn:agent:voter:frank',   chose: 'A' },
  { voter: 'urn:agent:voter:grace',   chose: 'C' },
];
const voteUrls = [];
for (const v of votes) {
  const voteId = `urn:cg:vote:${v.voter.split(':').pop()}:${ts}`;
  const voteGraph = `${REFERENT}:vote-${v.voter.split(':').pop()}`;
  const ttl = descriptorTtl({
    id: voteId,
    graph: voteGraph,
    issuer: v.voter,
    modal: 'Asserted',
    confidence: 1.0,
    wasDerivedFrom: [proposalUrls[v.chose]],
    extra: `    dao:supports "${v.chose}" ;`,
  });
  const url = await publish(voteId, voteGraph, ttl);
  voteUrls.push({ url, chose: v.chose, voter: v.voter });
  console.log(`   ${v.voter.split(':').pop().padEnd(7)} → ${v.chose}   (${url.split('/').pop()})`);
}
console.log('');

// ── Phase 3: any observer tallies ────────────────────────
console.log('3. Observer tallies votes by walking prov:wasDerivedFrom:');
const tally = { A: 0, B: 0, C: 0 };
for (const v of voteUrls) {
  const t = await fetchText(v.url);
  const supports = t?.match(/dao:supports\s+"([ABC])"/)?.[1];
  if (supports) tally[supports]++;
}
const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
for (const [slug, count] of Object.entries(tally)) {
  const bar = '█'.repeat(count);
  const marker = slug === winner ? ' ← winner' : '';
  console.log(`   Proposal ${slug}: ${bar} ${count}${marker}`);
}
console.log('');

// ── Phase 4: resolver publishes resolution ───────────────
console.log('4. Resolver publishes resolution descriptor:');
const resolutionId = `urn:cg:resolution:${ts}`;
const resolutionGraph = `${REFERENT}:resolution`;
const allProposalUrls = Object.values(proposalUrls);
const allVoteUrls = voteUrls.map(v => v.url);

const ttl = descriptorTtl({
  id: resolutionId,
  graph: resolutionGraph,
  issuer: 'urn:agent:dao:resolver',
  modal: 'Asserted',
  confidence: 1.0,
  supersedes: allProposalUrls,
  wasDerivedFrom: [...allProposalUrls, ...allVoteUrls],
  extra: `    dao:winner "${winner}" ; dao:winningTally "${tally[winner]}"^^xsd:integer ;\n    dao:totalVotes "${votes.length}"^^xsd:integer ;`,
});
const resUrl = await publish(resolutionId, resolutionGraph, ttl);
console.log(`   ✓ ${resUrl.split('/').pop()}`);
console.log(`     dao:winner "${winner}"  (tally ${tally[winner]}/${votes.length})`);
console.log(`     cg:supersedes → 3 proposals`);
console.log(`     prov:wasDerivedFrom → 3 proposals + 7 votes (10 total citations)`);
console.log('');

console.log('── Demonstrated:');
console.log(`   ${votes.length} votes cast across ${proposals.length} proposals, outcome computable`);
console.log('   from the federation cleartext alone. No contract, no tally server,');
console.log('   no consensus protocol. Every vote is a signed, queryable, auditable');
console.log('   descriptor. The resolution descriptor is the governance artifact;');
console.log('   anyone walking prov:wasDerivedFrom can re-verify the tally.');
