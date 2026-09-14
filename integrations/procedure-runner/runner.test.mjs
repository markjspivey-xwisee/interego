import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runProcedure, validateProcedure } from './runner.mjs';
import { compileProcedureGraph, verifiedProcedureGraph } from './graph.mjs';

// Internal interpreter fixture. Published Interego examples are native RDF.
const procedure = JSON.parse(readFileSync(new URL('./fixtures/status.ir.json', import.meta.url)));
const turtle = readFileSync(new URL('../../examples/procedures/performance-learning-review.ttl', import.meta.url), 'utf8');
const copy = value => structuredClone(value);
const ok = data => ({ structuredContent: data, isError: false });
const input = { podUrl: 'https://fixture.invalid/pod/', catalogGraphIri: 'urn:catalog:fixture', expectedStateCid: 'state-2' };
const control = { action: 'urn:fixture:read-current:v7', descriptorUrl: 'urn:fixture:binding:opaque-2',
  method: 'GET', fields: [], executable: true, label: 'Refresh and verify' };
const snapshot = { live: true, catalog: { current: true },
  application: { title: 'Fixture status', stateGraphIri: 'urn:fixture:state' },
  head: { cid: 'state-2', version: 2, forked: false, state: { status: 'ready' } },
  trust: { verified: true, artifactsTotal: 4, artifactsVerified: 4 },
  replay: { complete: true, chainLength: 2, verifiedLinks: 2, errors: [], links: [{ verified: true }, { verified: true }] },
  generatedAt: '2026-01-01T00:00:00Z' };

function environment(change = {}) {
  const calls = [], events = [];
  let time = 1000;
  const current = copy(snapshot), controls = [copy(control)];
  change.configure?.(current, controls);
  const host = {
    now: () => ++time,
    onEvent: async event => { events.push(copy(event)); },
    call: async (tool, args) => {
      calls.push({ tool, args: copy(args) });
      if (change.transportError) throw new Error('Disconnected after dispatch');
      if (tool === 'get_current_head') {
        const isCatalog = args.urn === input.catalogGraphIri;
        const cid = isCatalog ? (change.catalogRace && calls.length > 3 ? 'catalog-2' : 'catalog-1') : (change.stateRace ? 'state-3' : 'state-2');
        return ok({ forked: Boolean(change.forked), head: { descriptorUrl: 'https://fixture.invalid/catalog.ttl', cid } });
      }
      if (tool === 'get_descriptor') return ok({ authorship: { authorshipVerified: !change.untrusted,
        contentBinding: 'bound', descriptorBinding: { bound: true } }, view: { controls, snapshot: current } });
      if (tool === 'act') return ok({ status: change.status ?? 200, contentType: 'application/json', body: JSON.stringify({ snapshot: current }) });
      throw new Error('Unexpected capability');
    }
  };
  return { host, calls, events };
}

test('one data procedure discovers and follows an unfamiliar binding without model callbacks', async () => {
  const { host, calls, events } = environment();
  const result = await runProcedure(procedure, input, host);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.find(c => c.tool === 'act').args, { descriptor_url: control.descriptorUrl, action_iri: control.action, payload: {} });
  assert.equal(result.output.status, 'ready');
  assert.equal(result.metrics.interegoCalls, 5);
  assert.equal(result.metrics.modelInvocations, 0);
  assert.equal(result.metrics.providerInferenceCalls, null);
  assert.equal(result.metrics.monetaryCost, null);
  assert.ok(result.metrics.elapsedMs >= result.metrics.toolElapsedMs);
  for (const intent of events.filter(e => e.type === 'intent')) {
    assert.ok(events.indexOf(intent) < events.findIndex(e => e.type === 'outcome' && e.number === intent.number));
  }
});

test('changing the discovered binding requires no runner or procedure change', async () => {
  const env = environment({ configure: (_, cs) => { cs[0].action = 'urn:second-domain:inspect'; cs[0].descriptorUrl = 'urn:another:opaque-address'; } });
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'completed');
  assert.equal(env.calls.find(c => c.tool === 'act').args.action_iri, 'urn:second-domain:inspect');
});

test('a stale caller expectation yields observed state and requires a new discovery run', async () => {
  const env = environment();
  const stopped = await runProcedure(procedure, { ...input, expectedStateCid: 'state-1' }, env.host);
  assert.equal(stopped.status, 'needs-decision');
  assert.equal(stopped.observation.currentCid, 'state-2');
  assert.equal(stopped.metrics.modelHandoffs, 1);
  assert.equal(env.calls.length, 3);
  const restarted = environment();
  const finished = await runProcedure(procedure, { ...input, expectedStateCid: stopped.observation.currentCid }, restarted.host);
  assert.equal(finished.status, 'completed');
  assert.equal(restarted.calls[0].tool, 'get_current_head');
});

for (const [name, change] of [
  ['unsigned authority', { untrusted: true }],
  ['forked head', { forked: true }],
  ['incomplete replay', { configure: s => { s.replay.complete = false; } }],
  ['unverified replay link', { configure: s => { s.replay.links[1].verified = false; } }],
  ['empty replay', { configure: s => { s.replay.chainLength = 0; s.replay.verifiedLinks = 0; s.replay.links = []; } }],
  ['missing verified artifact', { configure: s => { s.trust.artifactsVerified = 3; } }]
]) test(`blocks ${name} before following a control`, async () => {
  const env = environment(change);
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'blocked');
  assert.equal(env.calls.some(c => c.tool === 'act'), false);
});

for (const [name, configure] of [
  ['ambiguous', (_, cs) => cs.push(copy(cs[0]))],
  ['write', (_, cs) => { cs[0].method = 'POST'; }],
  ['input-bearing', (_, cs) => { cs[0].fields = [{ key: 'authorization' }]; }],
  ['non-executable', (_, cs) => { cs[0].executable = false; }]
]) test(`does not dispatch ${name} controls`, async () => {
  const env = environment({ configure });
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'needs-decision');
  assert.equal(env.calls.some(c => c.tool === 'act'), false);
});

test('a control cannot be injected through input', async () => {
  const altered = copy(procedure);
  altered.steps.find(s => s.op === 'select').from = { $ref: '/input/controls' };
  const env = environment();
  const result = await runProcedure(altered, { ...input, controls: [control] }, env.host);
  assert.equal(result.status, 'needs-decision');
  assert.equal(env.calls.some(c => c.tool === 'act'), false);
});

for (const race of ['stateRace', 'catalogRace']) test(`detects ${race} before reporting completion`, async () => {
  const env = environment({ [race]: true });
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'blocked');
  assert.equal(result.output, undefined);
});

test('transport failure is retained and never automatically retried', async () => {
  const env = environment({ transportError: true });
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'needs-decision');
  assert.equal(env.calls.length, 1);
  assert.equal(result.metrics.failedCalls, 1);
  assert.equal(env.events.filter(e => e.type === 'transport-error').length, 1);
});

test('a failed durable intent write prevents dispatch', async () => {
  const env = environment();
  env.host.onEvent = async event => { if (event.type === 'intent') throw new Error('Storage unavailable'); };
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'needs-decision');
  assert.equal(env.calls.length, 0);
});

test('a non-successful read response cannot become a completed result', async () => {
  const env = environment({ status: 409 });
  const result = await runProcedure(procedure, input, env.host);
  assert.equal(result.status, 'needs-decision');
  assert.equal(result.metrics.failedCalls, 1);
  assert.equal(env.calls.length, 3);
});

test('rejects capability expansion, document code, unsafe bindings and an exhausted budget', async () => {
  const bad = copy(procedure); bad.steps[0].tool = 'publish_context';
  assert.throws(() => validateProcedure(bad), /capability/u);
  bad.steps[0].tool = 'get_current_head'; bad.steps[0].op = 'eval';
  assert.throws(() => validateProcedure(bad), /step/u);
  const unsafe = copy(procedure); unsafe.steps[0].args = { $ref: '/input/__proto__' };
  const env = environment();
  assert.equal((await runProcedure(unsafe, input, env.host)).status, 'needs-decision');
  assert.equal(env.calls.length, 0);
  const bounded = environment();
  assert.equal((await runProcedure(procedure, input, { ...bounded.host, maxCalls: 2 })).status, 'needs-decision');
  assert.equal(bounded.calls.length, 2);
});

test('loading the native graph requires bound content, bound location and a trusted signer', () => {
  const descriptorUrl = 'https://fixture.invalid/procedure.ttl', trustedSigner = 'did:example:author';
  const data = { url: descriptorUrl, authorship: { signedBy: trustedSigner, authorshipVerified: true,
    contentBinding: 'bound', descriptorBinding: { bound: true } },
    graph: { content: turtle } };
  assert.equal(verifiedProcedureGraph(ok(data), { descriptorUrl, trustedSigner }).procedure.steps.length, 28);
  for (const change of [d => { d.authorship.contentBinding = 'unbound'; }, d => { d.url += '/other'; },
    d => { d.authorship.signedBy = 'did:example:other'; }, d => { d.authorship.descriptorBinding.bound = false; }]) {
    const invalid = copy(data); change(invalid);
    assert.throws(() => verifiedProcedureGraph(ok(invalid), { descriptorUrl, trustedSigner }), /authority/u);
  }
});

test('execution order comes from directed RDF edges rather than triple order', () => {
  const before = compileProcedureGraph(turtle).procedure;
  const lines = turtle.trim().split('\n');
  const reordered = [...lines.filter(l => l.startsWith('@prefix')), ...lines.filter(l => !l.startsWith('@prefix')).reverse()].join('\n');
  assert.deepEqual(compileProcedureGraph(reordered).procedure, before);
  assert.equal(before.steps.find(s => s.op === 'follow').control, 'refresh-control');
  assert.equal(before.steps.find(s => s.id === 'course-metadata-read').args.iri.$ref, '/steps/course-link/href');
  assert.equal(/jsonBase64|procedure:json/u.test(turtle), false);
});

test('rejects cycles, ambiguous next edges and non-GET RDF operations', () => {
  const root = compileProcedureGraph(turtle).graph.root + '#';
  assert.throws(() => compileProcedureGraph(turtle + `\n<${root}catalog-head> <https://markjspivey-xwisee.github.io/interego/ns/procedure#next> <${root}catalog-head> .`), /Expected one/u);
  const cycle = turtle.replace(`<${root}status> pr:kind pr:Output .`, `<${root}status> pr:kind pr:Check .`)
    + `\n<${root}status> pr:next <${root}catalog-head> .`;
  assert.throws(() => compileProcedureGraph(cycle));
  assert.throws(() => compileProcedureGraph(turtle.replace('hydra:method "GET"', 'hydra:method "POST"')), /GET/u);
});
