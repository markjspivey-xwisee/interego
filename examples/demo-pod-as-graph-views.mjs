// Cool demo: Pod-as-graph, three Web API views over the same triples.
//
// Verborgh's current research push (cf. "Let's talk about pods", 2022,
// and the SolidLab "What's in a Pod?" project): a Solid pod should be
// a knowledge graph with multiple Web APIs as VIEWS into it — not a
// hierarchy of files where each app invents its own folder layout.
//
// In this demo, ONE in-memory triple store holds the pod's data.
// Three Web API surfaces serve different views over the same triples:
//
//   1. REST / LDP — the document-centric view: containers + resources,
//      GET /context-graphs/, GET /context-graphs/desc-1.ttl, etc.
//   2. SPARQL — the graph-centric view: SELECT/ASK queries over the
//      whole triple store at once.
//   3. Hydra — the hypermedia view: each resource is a JSON-LD object
//      with operations + affordance links.
//
// Crucially: a write through one surface is immediately visible through
// the others, because they all sit on the same underlying graph.

console.log('=== Pod-as-graph: three Web API views ===\n');
console.log('One triple store. Three Web APIs. Same data, three perspectives.\n');

// ── The shared triple store ─────────────────────────────────
//
// Triples are { subject, predicate, object } records. In a real
// deployment this would be RDF stored in Solid (Turtle on disk or
// in a quadstore); here we keep it in memory so the demo is
// self-contained.

const triples = [];

function addTriple(s, p, o) {
  triples.push({ s, p, o });
}

// Seed the pod with a few descriptors. Notice we describe them as
// triples directly — there's no "file" to read; the descriptors are
// just nodes in the graph.
const seed = (id, describes, modal, agent, validFrom, payload) => {
  addTriple(id, 'rdf:type', 'iep:ContextDescriptor');
  addTriple(id, 'iep:describes', describes);
  addTriple(id, 'iep:modalStatus', `iep:${modal}`);
  addTriple(id, 'prov:wasAttributedTo', agent);
  addTriple(id, 'iep:validFrom', validFrom);
  addTriple(id, 'iep:payload', payload);
};

seed(
  'urn:iep:1', 'urn:graph:notes/emergence', 'Asserted', 'urn:agent:mark',
  '2026-04-22T14:00:00Z', 'Vocabulary alignment converges in ~45 rounds.',
);
seed(
  'urn:iep:2', 'urn:graph:meeting-notes', 'Asserted', 'urn:agent:mark',
  '2026-04-23T16:00:00Z', 'Discussed Q3 priorities.',
);
seed(
  'urn:iep:3', 'urn:claim:hypothesis', 'Hypothetical', 'urn:agent:carol',
  '2026-04-23T18:00:00Z', 'Emergent policy threshold ≈ median of inputs.',
);

console.log(`Initial triple store: ${triples.length} triples across ${countUniqueSubjects()} subjects.\n`);

function countUniqueSubjects() {
  return new Set(triples.map(t => t.s)).size;
}

function getSubject(s) {
  return triples.filter(t => t.s === s);
}

// ── View 1: REST / LDP (document-centric) ──────────────────

console.log('═'.repeat(60));
console.log(' View 1 — REST / LDP (document-centric)');
console.log('═'.repeat(60));

function ldpGetContainer() {
  const subjects = [...new Set(triples.filter(t => t.p === 'rdf:type' && t.o === 'iep:ContextDescriptor').map(t => t.s))];
  const lines = [
    '@prefix ldp: <http://www.w3.org/ns/ldp#> .',
    '<> a ldp:Container ;',
    '   ldp:contains',
  ];
  lines.push(subjects.map(s => `     <${s}>`).join(' ,\n') + ' .');
  return lines.join('\n');
}

console.log('GET /context-graphs/');
console.log('Content-Type: text/turtle');
console.log();
console.log(ldpGetContainer());
console.log();

function ldpGetResource(subjectIri) {
  const ts = getSubject(subjectIri);
  const lines = [`<${subjectIri}>`];
  for (const t of ts) {
    const obj = t.o.startsWith('urn:') || t.o.startsWith('iep:') || t.o.startsWith('http')
      ? `<${t.o}>` : `"${t.o}"`;
    lines.push(`   ${t.p}  ${obj} ;`);
  }
  lines[lines.length - 1] = lines[lines.length - 1].replace(/;$/, '.');
  return lines.join('\n');
}

console.log('─'.repeat(40));
console.log(`GET /context-graphs/${'urn:iep:1'.split(':').at(-1)}`);
console.log('Content-Type: text/turtle');
console.log();
console.log(ldpGetResource('urn:iep:1'));
console.log();

// ── View 2: SPARQL (graph-centric) ──────────────────────────

console.log('═'.repeat(60));
console.log(' View 2 — SPARQL (graph-centric)');
console.log('═'.repeat(60));

function sparqlSelect(queryDescription, predicate, modal = null) {
  console.log('\nQuery:');
  console.log(`  ${queryDescription}`);
  console.log('SPARQL:');
  console.log(`  SELECT ?desc ?subject WHERE {`);
  console.log(`    ?desc iep:describes ?subject .`);
  if (modal) console.log(`    ?desc iep:modalStatus iep:${modal} .`);
  console.log(`  }`);
  console.log('Results:');

  const matches = triples.filter(t => t.p === 'iep:describes')
    .map(t => ({ desc: t.s, subject: t.o }))
    .filter(({ desc }) => {
      if (!modal) return true;
      return triples.some(t => t.s === desc && t.p === 'iep:modalStatus' && t.o === `iep:${modal}`);
    });

  if (matches.length === 0) {
    console.log('  (no rows)');
  } else {
    console.log(`  ┌──────────────────────────────────────────────┬──────────────────────────────────────────────┐`);
    console.log(`  │ ${'?desc'.padEnd(44)} │ ${'?subject'.padEnd(44)} │`);
    console.log(`  ├──────────────────────────────────────────────┼──────────────────────────────────────────────┤`);
    for (const m of matches) {
      console.log(`  │ ${m.desc.padEnd(44)} │ ${m.subject.padEnd(44)} │`);
    }
    console.log(`  └──────────────────────────────────────────────┴──────────────────────────────────────────────┘`);
  }
}

sparqlSelect('"What does this pod describe?"', 'iep:describes');
sparqlSelect('"What hypothetical claims are on this pod?"', 'iep:describes', 'Hypothetical');

// ── View 3: Hydra (hypermedia) ──────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(' View 3 — Hydra (hypermedia + affordances)');
console.log('═'.repeat(60));

function hydraView(subjectIri) {
  const ts = getSubject(subjectIri);
  if (ts.length === 0) return null;
  const props = {};
  for (const t of ts) props[t.p] = t.o;

  // Build hypermedia operations + affordances as the surface.
  return {
    '@context': 'https://markjspivey-xwisee.github.io/interego/contexts/cg.jsonld',
    '@id': subjectIri,
    '@type': 'iep:ContextDescriptor',
    'iep:describes': props['iep:describes'],
    'iep:modalStatus': props['iep:modalStatus'],
    'prov:wasAttributedTo': props['prov:wasAttributedTo'],
    'iep:validFrom': props['iep:validFrom'],
    'hydra:operation': [
      {
        '@type': 'hydra:Operation',
        'hydra:method': 'GET',
        'hydra:title': 'Fetch this descriptor',
        'iep:action': 'iep:canRead',
      },
      {
        '@type': 'hydra:Operation',
        'hydra:method': 'PUT',
        'hydra:title': 'Update this descriptor (creates new version via iep:supersedes)',
        'iep:action': 'iep:canSupersede',
      },
    ],
    'iep:affordance': [
      {
        '@type': ['iep:Affordance', 'hydra:Operation', 'dcat:Distribution'],
        'iep:action': 'iep:canCite',
        'hydra:title': 'Reference this descriptor in another descriptor (prov:wasDerivedFrom)',
      },
    ],
  };
}

console.log('\nGET /context-graphs/urn:iep:1');
console.log('Accept: application/ld+json');
console.log();
console.log(JSON.stringify(hydraView('urn:iep:1'), null, 2));
console.log();

// ── Cross-view consistency: write via one surface, read via others ──

console.log('═'.repeat(60));
console.log(' Cross-view: write via REST, read via SPARQL + Hydra');
console.log('═'.repeat(60));

console.log('\nA fourth descriptor is added via a REST PUT (e.g. another agent');
console.log('writes a Counterfactual claim disputing the hypothesis):\n');

console.log('  PUT /context-graphs/urn:iep:4');
console.log('  Content-Type: text/turtle');
console.log('  Body:');
console.log('    <urn:iep:4> a iep:ContextDescriptor ;');
console.log('       iep:describes <urn:claim:hypothesis> ;');
console.log('       iep:modalStatus iep:Counterfactual ;');
console.log('       prov:wasAttributedTo <urn:agent:dan> ;');
console.log('       iep:validFrom "2026-04-24T09:00:00Z" ;');
console.log('       iep:payload "Replication failed at threshold ≥ 4 with N=4 vocabularies." .');

seed(
  'urn:iep:4', 'urn:claim:hypothesis', 'Counterfactual', 'urn:agent:dan',
  '2026-04-24T09:00:00Z', 'Replication failed at threshold ≥ 4 with N=4 vocabularies.',
);

console.log('\nNow re-running the SPARQL "what claims about the hypothesis"');
console.log('IMMEDIATELY reflects the new write:\n');

console.log('  SELECT ?desc ?modal WHERE {');
console.log('    ?desc iep:describes <urn:claim:hypothesis> .');
console.log('    ?desc iep:modalStatus ?modal .');
console.log('  }');
console.log('Results:');
const claimDescs = triples.filter(t => t.p === 'iep:describes' && t.o === 'urn:claim:hypothesis').map(t => t.s);
console.log('  ┌──────────────┬─────────────────────┐');
console.log('  │ ?desc        │ ?modal              │');
console.log('  ├──────────────┼─────────────────────┤');
for (const d of claimDescs) {
  const m = triples.find(t => t.s === d && t.p === 'iep:modalStatus')?.o ?? '?';
  console.log(`  │ ${d.padEnd(12)} │ ${m.padEnd(19)} │`);
}
console.log('  └──────────────┴─────────────────────┘');

console.log('\nAnd the Hydra view of urn:iep:4 is also live:\n');
console.log(JSON.stringify({
  '@id': 'urn:iep:4',
  '@type': 'iep:ContextDescriptor',
  'iep:modalStatus': 'iep:Counterfactual',
  'iep:describes': 'urn:claim:hypothesis',
}, null, 2));

console.log('\n── What this demonstrates ──');
console.log('   One triple store. Three Web APIs serve three different views:');
console.log('     - REST/LDP gives apps that want documents');
console.log('     - SPARQL gives apps that want graph queries');
console.log('     - Hydra gives apps that want self-describing affordances');
console.log('');
console.log('   A write through any view is visible through all the others');
console.log('   because they all share the same underlying graph. The pod');
console.log('   isn\'t "a folder of files" — it\'s a knowledge graph with');
console.log('   multiple Web APIs as views.');
console.log('');
console.log('   This is the architecture Verborgh argues Solid should evolve');
console.log('   toward. Interego makes it the protocol\'s default rather');
console.log('   than something each implementation has to reinvent.');
