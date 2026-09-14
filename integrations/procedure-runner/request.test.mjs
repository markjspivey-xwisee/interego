import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRunRequest } from './request.mjs';
import { PR } from './graph.mjs';
import { parseTrig } from '../../packages/core/dist/rdf/turtle-parser.js';

test('a native run request requires an explicit signer and bound authority', () => {
  const graph = readFileSync(new URL('../../examples/procedures/request.example.ttl', import.meta.url), 'utf8');
  const descriptorUrl = 'https://fixture.invalid/request.ttl', trustedSigner = 'did:example:author';
  const raw = { structuredContent: { url: descriptorUrl, graph: { content: graph },
    authorship: { signedBy: trustedSigner, authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true } } } };
  const request = readRunRequest(raw, { descriptorUrl, trustedSigner });
  assert.equal(request.input.catalogGraphIri, 'urn:example:application-catalog');
  assert.equal(request.procedureGraph, 'urn:example:procedure-publication');
  for (const signer of [undefined, '', 'did:example:other']) assert.throws(() => readRunRequest(raw, { descriptorUrl, trustedSigner: signer }), /authority/u);
  assert.throws(() => readRunRequest(raw, { descriptorUrl: descriptorUrl + '/elsewhere', trustedSigner }), /authority/u);
  raw.structuredContent.authorship.descriptorBinding.bound = false;
  assert.throws(() => readRunRequest(raw, { descriptorUrl, trustedSigner }), /authority/u);
});

test('the optional vocabulary defines every procedure term used by the public RDF examples', () => {
  const vocabulary = parseTrig(readFileSync(new URL('../../docs/ns/procedure.ttl', import.meta.url), 'utf8'));
  const defined = new Set(vocabulary.subjects.map(s => s.subject));
  for (const file of ['performance-learning-review.ttl', 'request.example.ttl']) {
    const parsed = parseTrig(readFileSync(new URL('../../examples/procedures/' + file, import.meta.url), 'utf8'));
    for (const subject of parsed.subjects) for (const [predicate, objects] of subject.properties) {
      for (const iri of [predicate, ...objects.filter(o => o.kind === 'iri').map(o => o.iri)]) {
        if (iri.startsWith(PR)) assert.ok(defined.has(iri), `Undeclared procedure term: ${iri}`);
      }
    }
  }
});
