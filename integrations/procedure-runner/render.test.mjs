import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderProcedure } from './render.mjs';
import { compileProcedureGraph, PR } from './graph.mjs';
import { parseHypermediaMarkdown, liftHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';

const turtle = readFileSync(new URL('../../examples/procedures/performance-learning-review.ttl', import.meta.url), 'utf8');
test('HMD preserves typed procedure entry and membership, with authority-closed discovered controls', () => {
  const descriptorUrl = 'https://fixture.invalid/procedure.ttl';
  const controls = [{ id: 'inspect', action: 'urn:fixture:inspect', method: 'GET', source: descriptorUrl }];
  const hmd = renderProcedure(turtle, { descriptorUrl, controls });
  const doc = parseHypermediaMarkdown(hmd), triples = liftHypermediaMarkdown(hmd);
  const { graph } = compileProcedureGraph(turtle);
  assert.equal(doc.extraContext.pr, PR);
  assert.equal(doc.fields.entry, graph.stepIris[0]);
  assert.deepEqual(doc.fields.steps, graph.stepIris);
  assert.ok(triples.some(t => t.s === graph.root && t.p === PR + 'entry' && t.o === graph.stepIris[0] && t.oKind === 'iri'));
  for (const step of graph.stepIris) assert.ok(triples.some(t => t.s === graph.root && t.p === PR + 'step' && t.o === step && t.oKind === 'iri'));
  assert.equal(doc.controls.length, 1);
  assert.equal(doc.controls[0].action, controls[0].action);
  assert.equal(doc.controls[0].source, descriptorUrl);
  assert.ok(hmd.includes(graph.root + '#control-inspect'));
  assert.equal(triples.some(t => t.p === 'http://www.w3.org/ns/hydra/core#target'), false);
  assert.equal(parseHypermediaMarkdown(renderProcedure(turtle, { descriptorUrl })).controls.length, 0);
});
