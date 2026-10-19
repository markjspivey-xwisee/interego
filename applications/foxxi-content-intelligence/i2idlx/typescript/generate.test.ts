import assert from 'node:assert/strict';
import test from 'node:test';
import { feedSnapshot } from './generate.js';

test('release feed detects an active-only definition revision and preserves legacy mirror and missing-text fallbacks', () => {
  const legacy = 'https://id.i2idl.org/concepts/feedback';
  const added = 'https://id.i2idl.org/concepts/learning-management-systems';
  const definition = 'https://id.i2idl.org/definitions/learning-management-systems';
  const doc = { '@graph': [
    { '@id': 'https://id.i2idl.org/scheme', '@type': 'skos:ConceptScheme', 'gs:publicationVersion': 'v0.0.93' },
    { '@id': legacy, '@type': 'skos:Concept', 'skos:definition': 'Legacy definition.' },
    { '@id': added, '@type': ['skos:Concept', 'schema:DefinedTerm'], 'gs:activeDefinition': { '@id': definition } },
    { '@id': definition, '@type': ['gs:Definition'], 'rdf:value': 'A learning platform.' },
    { '@id': 'https://example.org/historical-missing', '@type': 'skos:Concept' },
  ] };
  const original = JSON.stringify(doc), before = feedSnapshot(doc);
  assert.deepEqual(before.defs, {
    [legacy]: 'Legacy definition.', [added]: 'A learning platform.',
    'https://example.org/historical-missing': '',
  });
  const revised = structuredClone(doc);
  revised['@graph'].find(node => node['@id'] === definition)!['rdf:value'] = 'An updated learning platform.';
  const after = feedSnapshot(revised);
  assert.deepEqual(Object.keys(after.defs).filter(id => id in before.defs && after.defs[id] !== before.defs[id]), [added]);
  assert.equal(after.version, 'v0.0.93');
  assert.equal(JSON.stringify(doc), original);
});
