import { turtleIriRef } from '@interego/core';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Layer, TBOX_FILES, tbox } from './layer.js';
import { parseTurtle } from './rdf.js';

const NS = 'https://example.test/i2idlx#', I2IDL = 'https://id.i2idl.org/concepts/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#', OWL = 'http://www.w3.org/2002/07/owl#';
function fixture(mappings: ConstructorParameters<typeof Layer>[4] = []): Layer {
  return new Layer('.', NS, {
    ontology: 'https://example.test/ontology', alignments: 'https://example.test/alignments',
    shapes: 'https://example.test/shapes', referents: 'https://example.test/referents',
  }, {
    endpoint: { iri: I2IDL + 'endpoint', type: 'system' },
    competency: { iri: I2IDL + 'competency', type: 'practice' },
    'new-practice': { iri: I2IDL + 'new-practice', type: 'practice' },
  }, mappings, 'v0.0.86', '9f86599');
}

test('category classes connect instance classification to the category hierarchy', () => {
  const layer = fixture(), g = parseTurtle(layer._prefixes() + '\n' + layer.ontology_section());
  assert.equal(g.getQuads(null, RDF + 'type', OWL + 'Class', null).length, 35);
  assert.equal(g.getQuads(NS + 'TeachingActivityReferent', RDFS + 'subClassOf', NS + 'LearningActivityReferent', null).length, 1);
  assert.equal(g.getQuads(NS + 'LearningActivityReferent', RDFS + 'subClassOf', NS + 'ActivityReferent', null).length, 1);
  const outer = g.getQuads(null, RDFS + 'subClassOf', NS + 'TeachingActivityReferent', null).find(q => q.subject.termType === 'BlankNode')!.subject;
  assert.equal(g.getQuads(outer, OWL + 'onProperty', NS + 'isClassifiedBy', null).length, 1);
  const inner = g.getQuads(outer, OWL + 'someValuesFrom', null, null)[0]!.object;
  assert.equal(g.getQuads(inner, OWL + 'onProperty', NS + 'referentCategory', null).length, 1);
  assert.equal(g.getQuads(inner, OWL + 'hasValue', NS + 'category-teaching', null).length, 1);
});

test('definition overrides win over collection defaults without retyping the canonical concept', () => {
  const layer = fixture(), assignments = layer.assignments();
  assert.equal(assignments.endpoint![0], 'webapi');
  assert.equal(assignments.endpoint![2], 'definition');
  assert.equal(assignments.competency![0], 'competence');
  assert.equal(assignments['new-practice']![0], 'activity');
  assert.equal(assignments['new-practice']![2], 'type');
  const g = parseTurtle(layer.referents_ttl('2026-10-14T00:00:00Z'));
  assert.equal(g.getQuads(I2IDL + 'competency', NS + 'referentCategory', NS + 'category-competence', null).length, 1);
  assert.equal(g.getQuads(I2IDL + 'competency', RDF + 'type', NS + 'CompetenceReferent', null).length, 0);
});

test('only executable class mappings generate OWL bridges with the intended direction', () => {
  const target = 'schema:SoftwareApplication', targetIri = 'https://schema.org/SoftwareApplication';
  const layer = fixture([
    ['exact', 'exactMatch', target], ['broad', 'broadMatch', target], ['narrow', 'narrowMatch', target],
    ['close', 'closeMatch', target], ['related', 'relatedMatch', target], ['nonclass', 'exactMatch', 'schema:Other'],
  ]);
  const g = parseTurtle(layer.alignments_ttl('2026-10-14T00:00:00Z', new Set([target]), 'https://example.test/mappings'));
  function restriction(cid: string) {
    const rows = g.getQuads(null, OWL + 'hasValue', I2IDL + cid, null);
    assert.equal(rows.length, 1);
    return rows[0]!.subject;
  }
  assert.equal(g.getQuads(targetIri, OWL + 'equivalentClass', restriction('exact'), null).length, 1);
  assert.equal(g.getQuads(restriction('broad'), RDFS + 'subClassOf', targetIri, null).length, 1);
  assert.equal(g.getQuads(targetIri, RDFS + 'subClassOf', restriction('narrow'), null).length, 1);
  for (const cid of ['close', 'related', 'nonclass']) assert.equal(g.getQuads(null, OWL + 'hasValue', I2IDL + cid, null).length, 0);
  const role = g.getQuads(NS + 'PersonReferent', RDFS + 'subClassOf', null, null).find(q =>
    q.object.termType === 'BlankNode' && g.getQuads(q.object, OWL + 'onProperty', 'http://purl.obolibrary.org/obo/BFO_0000196', null).length)!;
  assert.equal(g.getQuads(role.object, OWL + 'someValuesFrom', 'http://purl.obolibrary.org/obo/BFO_0000023', null).length, 1);
});

test('the pinned Foxxi archive fails closed when release bytes change', () => {
  const root = mkdtempSync(join(tmpdir(), 'i2idlx-semantic-'));
  try {
    mkdirSync(join(root, 'evidence', 'upper'), { recursive: true });
    for (const file of TBOX_FILES) writeFileSync(join(root, 'evidence', file), '');
    mkdirSync(join(root, 'archive', 'xapi'), { recursive: true });
    const path = join(root, 'archive', 'xapi', '2026.10.1.ttl');
    const raw = '<https://example.test/pinned> a ' + turtleIriRef(OWL + 'Class') + ' .\n';
    writeFileSync(path, raw);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ foxxiNs: {
      version: '2026.10.1', base: 'https://example.test/ns', archive: './archive',
      modules: ['xapi'], sha256: { xapi: createHash('sha256').update(raw).digest('hex') },
    } }));
    const previous = process.env.FOXXI_NS_ARCHIVE;
    delete process.env.FOXXI_NS_ARCHIVE;
    try {
      assert.equal(tbox(root).size, 1);
      writeFileSync(path, raw + '# changed\n');
      assert.throws(() => tbox(root), /not the pinned/);
    } finally {
      if (previous === undefined) delete process.env.FOXXI_NS_ARCHIVE;
      else process.env.FOXXI_NS_ARCHIVE = previous;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
