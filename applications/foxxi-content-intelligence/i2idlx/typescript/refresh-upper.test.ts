import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTurtle, RDF, RDFS, OWL } from './rdf.js';
import { parseSnapshot, referenced_terms, upwardModule } from './refresh-upper.js';
import { upperSnapshotsPresent, type UpperSnapshotSource } from './verification.js';

test('upward modules follow intersection parents and property ranges but keep filler axioms without importing filler ontologies', () => {
  const graph = parseTurtle(String.raw`
@prefix ex: <https://example.test/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:ontology a owl:Ontology ; owl:imports ex:remote ; rdfs:label "Fixture" .
ex:Seed a owl:Class ;
  rdfs:subClassOf [ owl:intersectionOf ( ex:Super [ a owl:Restriction ; owl:onProperty ex:p ; owl:someValuesFrom ex:Filler ] ) ] ,
    ex:BlockedParent .
ex:Super a owl:Class ; rdfs:label "Superclass" .
ex:p a owl:ObjectProperty ; rdfs:range ex:Range .
ex:Range a owl:Class ; rdfs:label "Range" .
ex:Filler a owl:Class ; rdfs:label "Do not pull this class in through the restriction" .
ex:BlockedParent a owl:Class ; rdfs:label "Excluded namespace" .
ex:Unrelated a owl:Class ; rdfs:label "Unrelated" .
[] a owl:AllDisjointClasses ; owl:members ( ex:Seed ex:Super ex:Unrelated ) .
`);
  const keep = upwardModule(graph, new Set(['https://example.test/Seed', 'https://example.test/p']), ['https://example.test/Blocked']);
  assert.equal(keep.getQuads('https://example.test/Super', RDFS + 'label', null, null).length, 1);
  assert.equal(keep.getQuads('https://example.test/Range', RDF + 'type', OWL + 'Class', null).length, 1);
  assert.equal(keep.getQuads(null, OWL + 'someValuesFrom', 'https://example.test/Filler', null).length, 1);
  assert.equal(keep.getQuads('https://example.test/Filler', null, null, null).length, 0);
  assert.equal(keep.getQuads('https://example.test/BlockedParent', null, null, null).length, 0);
  assert.equal(keep.getQuads('https://example.test/Unrelated', RDFS + 'label', null, null).length, 0);
  assert.equal(keep.getQuads(null, RDF + 'type', OWL + 'AllDisjointClasses', null).length, 1);
  assert.equal(keep.getQuads('https://example.test/ontology', RDF + 'type', OWL + 'Ontology', null).length, 1);
  assert.equal(keep.getQuads(null, OWL + 'imports', null, null).length, 0);
});

test('RDF/XML snapshots preserve URI, language and typed literal semantics', async () => {
  const raw = Buffer.from(String.raw`<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:ex="https://example.test/">
 <rdf:Description rdf:about="https://example.test/Seed">
  <rdf:type rdf:resource="http://www.w3.org/2002/07/owl#Class"/>
  <rdfs:label xml:lang="en">Seed class</rdfs:label>
  <ex:count rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">2</ex:count>
 </rdf:Description>
</rdf:RDF>`);
  const graph = await parseSnapshot(raw, 'xml', 'https://example.test/source.owl');
  assert.equal(graph.size, 3);
  assert.equal(graph.getQuads('https://example.test/Seed', RDF + 'type', OWL + 'Class', null).length, 1);
  const label = graph.getQuads('https://example.test/Seed', RDFS + 'label', null, null)[0]!.object;
  assert.equal(label.value, 'Seed class');
  assert.equal(label.termType, 'Literal');
  if (label.termType !== 'Literal') throw new Error('expected a literal label');
  assert.equal(label.language, 'en');
  const count = graph.getQuads('https://example.test/Seed', 'https://example.test/count', null, null)[0]!.object;
  assert.equal(count.termType, 'Literal');
  if (count.termType !== 'Literal') throw new Error('expected a typed count literal');
  assert.equal(count.datatype.value, 'http://www.w3.org/2001/XMLSchema#integer');
});

test('semantic-data migration retains the published set of 196 referenced terms', () => {
  const terms = referenced_terms();
  assert.equal(terms.size, 196);
  assert.ok(terms.has('obo:BFO_0000015'));
  assert.ok(terms.has('ler:CompetencyDefinition'));
  assert.ok(!terms.has('i2x:isClassifiedBy'));
});

test('verification accepts empty missing-seed arrays and still rejects actual missing terms', () => {
  const present = [{ key: 'bfo', missing: [] }, { key: 'interego-interego' }];
  assert.equal(upperSnapshotsPresent(present), true);
  assert.equal(upperSnapshotsPresent([...present, {
    key: 'iao', missing: ['http://purl.obolibrary.org/obo/IAO_0000010'],
  }]), false);
});

test('verification refuses malformed missing-seed metadata instead of treating it as an empty list', () => {
  for (const missing of [true, false, null, 'missing', '', 0, {}, { length: 0 }]) {
    assert.equal(upperSnapshotsPresent([{ key: 'invalid', missing }] as unknown as UpperSnapshotSource[]), false);
  }
});
