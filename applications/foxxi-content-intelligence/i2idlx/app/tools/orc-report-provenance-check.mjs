// Exercise actual provenance and gate functions; no server, model or publication.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Parser } from 'n3';
import { ORG, RECORDS, AGENTS, stepById } from '../src/orc/scenario.js';

const source = await readFile(new URL('../src/orc/prov.js', import.meta.url), 'utf8');
const META = { base: 'https://example.org/ns/owner', iri: { catalog: 'https://example.org/catalog' }, commit: 'fixture', release: 'v0.0.93', repo: 'https://example.org/source' };
const provTurtle = runInNewContext(source.replace(/^import .*\n/gm, '').replaceAll('export function ', 'function ') + '\nprovTurtle;', {
  META, ORG, AGENTS, stepById, TOOLS: { run_summary: {} }, worldTurtle: () => '# Fixture inventory\n',
});
const PROV = 'http://www.w3.org/ns/prov#';
const HARNESS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
for (const decision of ['approved', 'declined']) {
  const summary = { humanDecision: decision, typings: 147, staged: [{ id: 'call-1', status: decision }] };
  const log = [
    { type: 'step', step: 'close', status: 'running', execution: 'workflow' },
    { type: 'call', step: 'close', agent: 'conductor', tool: 'run_summary', input: {}, result: summary, status: 'ok', execution: 'workflow' },
    { type: 'say', step: 'close', agent: 'conductor', summary, text: 'Report from actual results.', execution: 'workflow' },
    { type: 'step', step: 'close', status: 'done', execution: 'workflow' },
  ];
  const ttl = provTurtle({ log, world: {}, mode: 'live' });
  const quads = new Parser().parse(ttl);
  const close = quads.find(q => q.subject.value.endsWith('/turn/close') && q.predicate.value === RDF + 'type');
  assert.equal(close.object.value, PROV + 'Activity');
  assert(!quads.some(q => q.subject.value.endsWith('/turn/close') && q.object.value === HARNESS + 'AgentTurn'));
  assert(quads.some(q => q.subject.value.endsWith('/turn/close') && q.predicate.value === PROV + 'wasAssociatedWith' && q.object.value === 'urn:interpretant:workflow:orchestrate'));
  assert(quads.some(q => q.subject.value.includes('/action/') && q.predicate.value === PROV + 'wasAssociatedWith' && q.object.value === 'urn:interpretant:workflow:orchestrate'));
  assert.deepEqual(JSON.parse(quads.find(q => q.subject.value.endsWith('/report') && q.predicate.value === PROV + 'value').object.value), summary);
  process.stdout.write('PASS ' + decision + ' report preserves actual result and workflow provenance\n');
}

const historical = new Parser().parse(provTurtle({ log: [{ type: 'step', step: 'close', status: 'done' }], world: {}, mode: 'recorded', recordedAt: '2026-10-01T00:00:00Z', recordedRelease: 'v0.0.80' }));
assert(historical.some(q => q.subject.value.endsWith('/turn/close') && q.predicate.value === RDF + 'type' && q.object.value === HARNESS + 'AgentTurn'));
assert(!historical.some(q => q.subject.value === 'urn:interpretant:workflow:orchestrate'));
process.stdout.write('PASS historical model-turn provenance remains distinct\n');

const worldSource = await readFile(new URL('../src/orc/world.js', import.meta.url), 'utf8');
const decideGate = runInNewContext(worldSource.replace(/^import .*\n/gm, '').replaceAll('export function ', 'function ').replaceAll('export const ', 'const ') + '\ndecideGate;', {
  META, ORG, RECORDS, COLUMNS: [], SEM: { labels: {} }, MAPPINGS: [],
});
for (const decision of ['approved', 'declined']) {
  const world = { gate: { status: 'pending', calls: ['call-1'] }, staged: [{ id: 'call-1', status: 'staged' }, { id: 'outside-gate', status: 'staged' }] };
  assert.equal(decideGate(world, 'invalid'), false);
  assert.equal(world.gate.status, 'pending');
  assert.equal(decideGate(world, decision), true);
  assert.equal(world.staged[0].status, decision);
  assert.equal(world.staged[1].status, 'staged');
  assert.equal(decideGate(world, decision === 'approved' ? 'declined' : 'approved'), false);
  assert.equal(world.gate.status, decision);
}
assert.equal(decideGate({}, 'approved'), false);
process.stdout.write('PASS invalid and duplicate decisions cannot change the accepted gate decision\n');
