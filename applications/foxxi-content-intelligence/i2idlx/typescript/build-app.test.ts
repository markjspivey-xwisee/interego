import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { shareUrlBootstrap } from './build-app.js';
import { canonicalizeNeighborhoodTargets } from './decorations.js';
import { originVocabularyDeclarations } from './build-site.js';
import { construct, parseTurtle, nn, PROV } from './rdf.js';

const archive = 'https://claude.ai/artifact/retained-archive';
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
