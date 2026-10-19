import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { shareUrlBootstrap, orderedMappingIds, upstreamDefinitionText, upstreamEvidenceSourceNodes, upstreamRoadmapApi } from './build-app.js';
import { canonicalizeNeighborhoodTargets } from './decorations.js';
import { originVocabularyDeclarations, catalogActionTargets } from './build-site.js';
import { construct, parseTurtle, nn, PROV } from './rdf.js';
import { shaclRules, shaclValidate } from './validation.js';

const archive = 'https://claude.ai/artifact/retained-archive';
test('roadmap API reader preserves route examples and recognizes the actual v0.0.93 maintenance declaration', () => {
  assert.deepEqual(upstreamRoadmapApi('### 2. Add an API\n/api/concepts\n/api/concepts/{id}\n/api/sources\n'),
    { routes: ['/api/concepts', '/api/concepts/{id}', '/api/sources'], maintained: false });
  // Verbatim heading, declaration and URLs from docs/ROADMAP.md at 0754254be64f0562bab7e68d69583f2cc90aa945.
  const maintenance = '### 2. Maintain REST API v1 and MCP integration\n\n'+
    '**Implemented since v0.0.88; ongoing maintenance.** The public read-only REST API v1 provides concept search, lookup, relationships, version history, sources, collections, and AI-oriented context bundles. '+
    'The interactive documentation is at `https://id.i2idl.org/api/docs`. The stateless read-only MCP service at `https://id.i2idl.org/mcp` exposes four bounded semantic tools for compatible AI clients. '+
    'Both are projections of the canonical graph, not independent sources of truth.\n\n### 3. Continue improving human-readable provenance\n';
  assert.deepEqual(upstreamRoadmapApi(maintenance), { routes: [], maintained: true });
  assert.throws(() => upstreamRoadmapApi('### 2. Add an API\n'), /must supply three API route examples/);
  for (const required of ['**Implemented since v0.0.88; ongoing maintenance.**', '`https://id.i2idl.org/api/docs`', '`https://id.i2idl.org/mcp`'])
    assert.throws(() => upstreamRoadmapApi(maintenance.replace(required, '')), /must supply three API route examples/);
  assert.throws(() => upstreamRoadmapApi(maintenance.replace('### 2. Maintain REST API v1 and MCP integration', '### 1. Something else')),
    /must supply three API route examples/);
});
test('catalog-only action links target rendered controls without replacing ontology or bridge links', () => {
  const ns='https://example.org/ontology#', catalogIri='https://example.org/catalog';
  const catalog=parseTurtle('@prefix i: <'+ns+'> . @prefix c: <'+catalogIri+'#> . '+
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> . '+
    '<'+catalogIri+'> iep:affordance c:rest, c:core, c:bridge, c:untyped, c:rest-alias . '+
    'c:rest iep:action i:act-rest . c:rest-alias iep:action i:act-rest . i:act-rest a i:ActionIdentity . '+
    'c:core iep:action i:act-core . i:act-core a i:ActionIdentity . '+
    'c:bridge iep:action <https://relay.interego.xwisee.com/ns/iep/action/foxxi/discover-lrs> . '+
    'c:untyped iep:action i:undeclared .');
  const ontology=parseTurtle('<'+ns+'act-core> a <'+ns+'ActionIdentity> .');
  assert.deepEqual([...catalogActionTargets(catalog,ontology,catalogIri,ns)],[ [ns+'act-rest','rest'] ]);
});
test('share URLs use the current hosted origin and canonical workbench route', () => {
  const window = { location: { href: 'https://preview.example.org/i2idlx/reference?draft=1#record' } } as { location: { href: string }; __APP_URL__?: string; __ARCHIVED_APP_URL__?: string };
  vm.runInNewContext(shareUrlBootstrap(archive), { window, URL });
  assert.equal(window.__APP_URL__, 'https://preview.example.org/i2idlx/');
  assert.equal(window.__ARCHIVED_APP_URL__, archive);
});
test('a legacy Claude artifact retains its original share URL', () => {
  const window = { claude: {}, location: { href: 'https://legacy.example.org/embedded-frame' } } as { claude: object; location: { href: string }; __APP_URL__?: string; __ARCHIVED_APP_URL__?: string };
  vm.runInNewContext(shareUrlBootstrap(archive), { window, URL });
  assert.equal(window.__APP_URL__, archive);
  assert.equal(window.__ARCHIVED_APP_URL__, archive);
});
test('archived metadata cannot terminate its inline script', () => {
  const script = shareUrlBootstrap('https://example.org/</script><!--retained');
  assert.ok(!script.includes('</script>'));
  assert.ok(!script.includes('<!--'));
  const window = { location: { href: 'https://preview.example.org/current' } } as { location: { href: string }; __APP_URL__?: string; __ARCHIVED_APP_URL__?: string };
  vm.runInNewContext(script, { window, URL });
  assert.equal(window.__APP_URL__, 'https://preview.example.org/i2idlx/');
  assert.equal(window.__ARCHIVED_APP_URL__, 'https://example.org/</script><!--retained');
});

test('native neighborhood projection percent-encodes reserved separators without changing query bytes', async () => {
  const queryNode='https://example.org/catalog#q-concept-neighborhood';
  const query="PREFIX skos: <http://www.w3.org/2004/02/skos/core#>\nSELECT ?x WHERE { ?x ?p ?o; ?q '%2F & !()* é' }";
  const source=parseTurtle('<'+queryNode+'> <urn:test:query> '+JSON.stringify(query)+' .');
  const projection=await construct(
    'CONSTRUCT { <urn:test:neighborhood> <http://www.w3.org/ns/prov#wasDerivedFrom> <'+queryNode+'>; '+
    '<http://www.w3.org/ns/hydra/core#target> ?target } WHERE { <'+queryNode+'> <urn:test:query> ?query . '+
    'BIND(IRI(CONCAT("https://id.i2idl.org/sparql?query=",ENCODE_FOR_URI(STR(?query)))) AS ?target) }',source);
  canonicalizeNeighborhoodTargets(projection,queryNode);
  const target=projection.getQuads(nn('urn:test:neighborhood'),nn('http://www.w3.org/ns/hydra/core#target'),null,null)[0]!.object.value;
  const parameter=target.slice('https://id.i2idl.org/sparql?query='.length);
  assert.equal(decodeURIComponent(parameter),query);
  assert.ok(parameter.includes('http%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23'));
  assert.ok(parameter.includes('%252F%20%26%20%21%28%29%2A%20%C3%A9'));
  assert.ok(!/[!'"()*#&/?:]/u.test(parameter));
});
test('neighborhood normalization is idempotent and leaves unrelated controls unchanged', () => {
  const hydra='http://www.w3.org/ns/hydra/core#',queryNode='https://example.org/catalog#q-concept-neighborhood';
  const graph=parseTurtle('<urn:test:neighborhood> <'+PROV+'wasDerivedFrom> <'+queryNode+'>; '+
    '<'+hydra+'target> <https://id.i2idl.org/sparql?query=SELECT%20%3Fx%20WHERE%20%7B%7D> . '+
    '<urn:test:card> <'+hydra+'target> <https://www.i2idl.org/glossary#card> .');
  const original=[...graph].map(q=>JSON.stringify([q.subject.termType,q.subject.value,q.predicate.value,q.object.termType,q.object.value,q.graph.value])).sort();
  canonicalizeNeighborhoodTargets(graph,queryNode);
  canonicalizeNeighborhoodTargets(graph,queryNode);
  assert.deepEqual([...graph].map(q=>JSON.stringify([q.subject.termType,q.subject.value,q.predicate.value,q.object.termType,q.object.value,q.graph.value])).sort(),original);
});
test('malformed declared neighborhood targets are refused', () => {
  const hydra='http://www.w3.org/ns/hydra/core#',queryNode='https://example.org/catalog#q-concept-neighborhood';
  const graph=parseTurtle('<urn:test:neighborhood> <'+PROV+'wasDerivedFrom> <'+queryNode+'>; '+
    '<'+hydra+'target> <https://example.org/wrong?query=SELECT> .');
  assert.throws(()=>canonicalizeNeighborhoodTargets(graph,queryNode),/Unexpected neighborhood target/);
});

test('reference vocabulary declarations include origin groups before their linked leaves', () => {
  const source=originVocabularyDeclarations({
    groups:[{id:'x'},{id:'another-group'}],
    origins:[{id:'i2idl'},{id:'derived'},{id:'added'}],
  });
  const ns='https://example.org/i2idlx#';
  const graph=parseTurtle('@prefix i2x: <'+ns+'> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . '+source);
  for(const id of ['x','another-group','i2idl','derived','added']) {
    assert.equal(graph.getQuads(nn(ns+'origin-'+id),nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),nn('http://www.w3.org/2004/02/skos/core#Concept'),null).length,1);
  }
  assert.ok(source.indexOf('origin-x ')<source.indexOf('origin-derived '));
});

test('mapping review order follows declarations and retains replacement metadata on its own subject', () => {
  const ns='https://example.org/mappings#',type='https://example.org/MappingProposal';
  const graph=parseTurtle('<'+ns+'m-a-replacement> a <'+type+'>; '+
    '<http://purl.org/dc/terms/replaces> <'+ns+'m-z-base> . '+
    '<'+ns+'m-z-base> a <'+type+'> .');
  const actual=graph.getQuads(null,nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),nn(type),null).map(q=>q.subject.value.slice(ns.length));
  const declared=['m-z-base','m-a-replacement'];
  const ordered=orderedMappingIds(actual,declared);
  assert.deepEqual(ordered,declared);
  assert.equal(graph.getQuads(nn(ns+ordered[0]),nn('http://purl.org/dc/terms/replaces'),null,null).length,0);
  assert.equal(graph.getQuads(nn(ns+ordered[1]),nn('http://purl.org/dc/terms/replaces'),null,null)[0]!.object.value,ns+'m-z-base');
  assert.throws(()=>orderedMappingIds(actual.slice(1),declared),/subjects differ/);
  assert.throws(()=>orderedMappingIds([...actual,'m-unexpected'],declared),/subjects differ/);
});

const upstreamConcept = 'https://id.i2idl.org/concepts/learning-management-systems';
const upstreamDefinition = 'https://id.i2idl.org/definitions/learning-management-systems';
const ericSource = 'https://id.i2idl.org/sources/eric-thesaurus-2025';
const glossaryStudio = 'https://glossarystudio.app/ns/';
const dcterms = 'http://purl.org/dc/terms/';
const testNS = 'https://example.org/i2idlx#';
function upstreamJsonFixture() {
  return [
    { '@id': upstreamConcept, '@type': ['skos:Concept', 'schema:DefinedTerm'],
      'skos:prefLabel': 'Learning Management Systems', 'gs:activeDefinition': { '@id': upstreamDefinition } },
    { '@id': upstreamDefinition, '@type': ['gs:Definition'], 'rdf:value': 'A learning platform.',
      'gs:evidence': [{ 'dcterms:source': { '@id': ericSource }, 'gs:evidenceRelation': 'supporting' }] },
    { '@id': ericSource, '@type': ['schema:CreativeWork'], 'dcterms:title': 'ERIC Thesaurus (2025)', 'dcterms:rights': 'Public domain' },
  ];
}
test('projects active-only definitions and reference-grounded CreativeWork evidence without inventing upstream metadata', () => {
  const nodes = upstreamJsonFixture(), original = JSON.stringify(nodes);
  assert.equal(upstreamDefinitionText(nodes[0]!, nodes[1]!), 'A learning platform.');
  assert.deepEqual(upstreamEvidenceSourceNodes(nodes), [nodes[2]]);
  assert.equal(JSON.stringify(nodes), original);
  for (const key of ['skos:definition', 'schema:inDefinedTermSet', 'gs:editorialStatus']) assert.equal(key in nodes[0]!, false);
  for (const key of ['dcterms:language', 'gs:editorialStatus', 'gs:definitionSequence']) assert.equal(key in nodes[1]!, false);
  assert.deepEqual(nodes[1]!['@type'], ['gs:Definition']);
  const unreferenced = { '@id': 'https://id.i2idl.org/sources/unrelated', '@type': ['schema:CreativeWork'],
    'dcterms:title': 'Unrelated work', 'dcterms:rights': 'Public domain' };
  assert.deepEqual(upstreamEvidenceSourceNodes([...nodes, unreferenced]), [nodes[2]]);
});
test('keeps mirrored legacy definitions unchanged and rejects missing or contradictory definition text', () => {
  const nodes = upstreamJsonFixture();
  const concept = { ...nodes[0], 'skos:definition': 'A learning platform.', 'gs:editorialStatus': 'approved' };
  assert.equal(upstreamDefinitionText(concept, nodes[1]!), 'A learning platform.');
  assert.throws(() => upstreamDefinitionText({ ...concept, 'skos:definition': 'Different text.' }, nodes[1]!), /differs from its active definition/);
  assert.throws(() => upstreamDefinitionText(nodes[0]!, { '@id': upstreamDefinition }), /Missing active definition text/);
  assert.throws(() => upstreamDefinitionText(nodes[0]!, { '@id': upstreamDefinition, 'rdf:value': '  ' }), /Missing active definition text/);
});
test('refuses dangling or undeclared evidence sources rather than silently dropping their evidence', () => {
  const nodes = upstreamJsonFixture();
  assert.throws(() => upstreamEvidenceSourceNodes(nodes.slice(0, 2)), /Unresolved evidence source/);
  assert.throws(() => upstreamEvidenceSourceNodes([...nodes.slice(0, 2), { ...nodes[2], '@type': ['schema:Person'] }]), /declared type, title or rights/);
  assert.throws(() => upstreamEvidenceSourceNodes([...nodes.slice(0, 2), { ...nodes[2], 'dcterms:rights': '' }]), /declared type, title or rights/);
});
function upstreamTemplate(file: string, marker: string) {
  const text = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8').split(marker)[0]!;
  const replacements: Record<string, string> = { NS: testNS, SHAPES: 'https://example.org/shapes',
    RULES: 'https://example.org/rules', ONTO: 'https://example.org/i2idlx', VERSION: 'test' };
  return parseTurtle(text.replace(/\{\{([A-Z_]+)\}\}/gu, (_, key: string) => {
    assert.ok(key in replacements, 'Unknown upstream fixture template token ' + key);
    return replacements[key]!;
  }));
}
function upstreamRdfFixture(legacy = false) {
  return parseTurtle('@prefix skos: <http://www.w3.org/2004/02/skos/core#> . '+
    '@prefix schema: <https://schema.org/> . @prefix gs: <'+glossaryStudio+'> . '+
    '@prefix dct: <'+dcterms+'> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . '+
    '<'+upstreamConcept+'> a skos:Concept, schema:DefinedTerm; skos:prefLabel "Learning Management Systems"; '+
    'dct:identifier "learning-management-systems"; skos:inScheme <https://id.i2idl.org/scheme>; '+
    'gs:activeDefinition <'+upstreamDefinition+'>; gs:typeCollection <https://id.i2idl.org/collections/type/concept>; '+
    'gs:fieldCollection <https://id.i2idl.org/collections/field/standards-and-interoperability> . '+
    '<'+upstreamDefinition+'> a gs:Definition; rdf:value "A learning platform."; '+
    'gs:evidence [gs:evidenceRelation "supporting"; dct:source <'+ericSource+'>] . '+
    '<'+ericSource+'> a '+(legacy?'dct:BibliographicResource':'schema:CreativeWork')+'; '+
    'dct:title "ERIC Thesaurus (2025)"; dct:rights "Public domain" . '+
    (legacy?'<'+upstreamConcept+'> schema:inDefinedTermSet <https://id.i2idl.org/scheme>; '+
      'gs:editorialStatus "approved"; skos:definition "A learning platform." . '+
      '<'+upstreamDefinition+'> a <'+PROV+'Entity>; dct:language "en"; gs:definitionSequence 1; gs:editorialStatus "approved" . ':''));
}
test('upstream contract accepts the legacy and v0.0.93 profiles while preserving required semantic guards', async () => {
  const shapes = upstreamTemplate('i2idlx-shapes.ttl.tmpl', 'i2xsh:I2IDLConceptRef a sh:NodeShape');
  assert.equal((await shaclValidate(upstreamRdfFixture(), shapes)).conforms, true);
  assert.equal((await shaclValidate(upstreamRdfFixture(true), shapes)).conforms, true);
  for (const [subject, predicate] of [
    [upstreamConcept, 'http://www.w3.org/2004/02/skos/core#prefLabel'],
    [upstreamConcept, glossaryStudio+'activeDefinition'],
    [upstreamConcept, glossaryStudio+'typeCollection'],
    [upstreamConcept, glossaryStudio+'fieldCollection'],
    [upstreamDefinition, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#value'],
    [upstreamDefinition, glossaryStudio+'evidence'],
    [ericSource, dcterms+'rights'],
  ]) {
    const graph = upstreamRdfFixture();
    graph.removeQuads(graph.getQuads(nn(subject!), nn(predicate!), null, null));
    assert.equal((await shaclValidate(graph, shapes)).conforms, false, 'Missing '+predicate+' must fail');
  }
  const dangling = upstreamRdfFixture();
  dangling.removeQuads(dangling.getQuads(nn(ericSource), null, null, null));
  assert.equal((await shaclValidate(dangling, shapes)).conforms, false, 'A dangling source must fail');
});
test('shared glossary rules partition gs:Definition without prov:Entity and keep absent status Hypothetical', () => {
  const rules = upstreamTemplate('i2idlx-rules.ttl.tmpl', 'i2xr:MappingRules a sh:NodeShape');
  const inferred = shaclRules(upstreamRdfFixture(), rules);
  assert.equal(inferred.getQuads(nn(upstreamConcept), nn(testNS+'editorialModality'), nn('https://markjspivey-xwisee.github.io/interego/ns/iep#Hypothetical'), null).length, 1);
  assert.equal(inferred.getQuads(nn(upstreamDefinition), nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), nn(testNS+'SynthesizedDefinition'), null).length, 1);
  assert.equal(inferred.getQuads(nn(upstreamDefinition), nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), nn(PROV+'Entity'), null).length, 0);
  assert.equal(inferred.getQuads(null, nn(glossaryStudio+'editorialStatus'), null, null).length, 0);
  assert.equal(inferred.getQuads(nn(upstreamDefinition), nn(dcterms+'language'), null, null).length, 0);
  const legacy = shaclRules(upstreamRdfFixture(true), rules);
  assert.equal(legacy.getQuads(nn(upstreamConcept), nn(testNS+'editorialModality'), nn('https://markjspivey-xwisee.github.io/interego/ns/iep#Asserted'), null).length, 1);
});
