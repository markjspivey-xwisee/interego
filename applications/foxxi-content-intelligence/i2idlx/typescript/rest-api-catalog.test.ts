import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Parser, Store, DataFactory } from 'n3';
import { restApiCatalog } from './rest-api-catalog.js';

const root = new URL('../', import.meta.url), base = 'https://example.org/catalog', ns = 'https://example.org/i2x#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', DCAT = 'http://www.w3.org/ns/dcat#';
const DPROD = 'https://www.omg.org/spec/DPROD/dprod/', HYDRA = 'http://www.w3.org/ns/hydra/core#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#', PROV = 'http://www.w3.org/ns/prov#', SH = 'http://www.w3.org/ns/shacl#';
const text = restApiCatalog(), rendered = text.replaceAll('{{CATALOG}}', base).replaceAll('{{NS}}', ns);
const graph = new Store(new Parser().parse(rendered));
const n = DataFactory.namedNode;
const value = (s: string, p: string) => graph.getObjects(n(s), n(p), null)[0]?.value;
const port = (id: string) => base + '#port-rest-' + id;
test('committed decoration reproduces the pinned contract, independently of the canonical glossary pin', () => {
  assert.equal(text, readFileSync(new URL('src/i2idlx-rest-api.ttl.tmpl', root), 'utf8'));
  const canonical = JSON.parse(readFileSync(new URL('typescript/upstream-pin.json', root), 'utf8'));
  assert.equal(canonical.commit, '9f865995d879165d8fa49422915a5e53d2ecebf9');
  assert.equal(canonical.release, 'v0.0.86');
  assert.equal(value(base + '#rest-service', DCAT + 'version'), '1.0.0');
  assert.equal(value(base + '#rest-projection', DCAT + 'version'), 'v0.0.89');
});
test('all eight OpenAPI reads plus the separately evidenced context read are discoverable without fabricated writes', () => {
  const spec = JSON.parse(readFileSync(new URL('evidence/rest-api/openapi.json', root), 'utf8'));
  const ids: string[] = Object.values(spec.paths).map((p: unknown) => (p as { get: { operationId: string } }).get.operationId);
  assert.equal(ids.length, 8);
  const controls = graph.getSubjects(n(RDF + 'type'), n(IEP + 'Affordance'), null);
  assert.equal(controls.length, 9);
  for (const id of [...ids, 'conceptContext']) {
    assert.equal(value(port(id), HYDRA + 'method'), 'GET');
    assert.equal(value(port(id), IEP + 'readOnlyHint'), 'true');
    assert.equal(value(port(id), IEP + 'destructiveHint'), 'false');
    assert.equal(value(port(id), DCAT + 'accessService'), base + '#rest-service');
    assert.equal(graph.countQuads(n(base), n(IEP + 'affordance'), n(port(id)), null), 1);
    assert.equal(value(base + '#rest-head-' + id, HYDRA + 'method'), 'HEAD');
    assert.equal(value(base + '#rest-options-' + id, HYDRA + 'method'), 'OPTIONS');
  }
  assert.match(value(port('conceptContext'), PROV + 'wasDerivedFrom')!, /api\/v1-context\.mjs$/);
  assert.equal(graph.getObjects(n(base + '#rest-response-conceptContext'), n('http://purl.org/dc/terms/conformsTo'), null).length, 0);
});
test('DPROD ports are services; DCAT distributions resolve back to the same service and distinct projection dataset', () => {
  const product = base + '#glossary-data-product', service = base + '#rest-service', dataset = base + '#rest-projection';
  assert.ok(graph.countQuads(n(product), n(RDF + 'type'), n(DPROD + 'DataProduct'), null));
  assert.ok(graph.countQuads(n(product), n(DPROD + 'outputPort'), n(service), null));
  assert.equal(value(service, DCAT + 'servesDataset'), dataset);
  assert.equal(value(base + '#rest-json', DCAT + 'accessService'), service);
  assert.ok(graph.countQuads(n(dataset), n(DCAT + 'distribution'), n(base + '#rest-json'), null));
  assert.equal(graph.getSubjects(null, null, null).some(s => s.value.startsWith('https://id.i2idl.org/concepts/')), false);
});
test('argument contracts include real pagination, identifier and traversal bounds, with no invented REST quota', () => {
  const binding = (op: string, p: string) => base + '#rest-binding-' + op + '-' + p;
  assert.equal(value(binding('listConcepts', 'limit'), SH + 'minInclusive'), '1');
  assert.equal(value(binding('listConcepts', 'limit'), SH + 'maxInclusive'), '100');
  assert.equal(value(binding('listConcepts', 'offset'), SH + 'maxInclusive'), '100000');
  assert.equal(value(binding('listConcepts', 'q'), SH + 'maxLength'), '160');
  assert.equal(value(binding('conceptContext', 'depth'), SH + 'maxInclusive'), '1');
  assert.equal(value(binding('conceptContext', 'maxRelated'), SH + 'maxInclusive'), '20');
  assert.equal(value(binding('conceptContext', 'id'), SH + 'minCount'), '1');
  assert.equal(value(binding('conceptContext', 'id'), SH + 'maxLength'), '160');
  assert.equal(value(base + '#rest-input-conceptContext', SH + 'closed'), 'true');
  assert.equal(graph.getQuads(null, n(ns + 'rateLimitPerMinute'), null, null).length, 0);
  assert.equal(graph.getQuads(null, n('http://www.w3.org/ns/odrl/2/count'), null, null).length, 0);
});
