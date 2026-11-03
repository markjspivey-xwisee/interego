import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';
import { prepareComposition, executeComposition } from './composition.mjs';
import { parseProcedureCatalog, renderCatalog, graphIndex, PC, HC } from './profile.mjs';
import { prepareDecisionPacket } from './organizational-packet.mjs';
import { fixture, learning, organizational, SIGNER, ISSUER } from './fixtures.mjs';

test('the optional profile introduces no ungrounded class or new primitive', () => {
  const graph = graphIndex(readFileSync(new URL('./profile.ttl', import.meta.url), 'utf8'));
  const classes = [...graph.nodes.keys()].filter(id => graph.typed(id, 'http://www.w3.org/2002/07/owl#Class'));
  assert.ok(classes.length > 0);
  for (const id of classes) assert.ok(graph.links(id, 'http://www.w3.org/2000/01/rdf-schema#subClassOf')
    .some(parent => parent.startsWith('http://www.w3.org/')), `${id} must specialize an existing W3C type`);
});

for (const [name, task, steps] of [['learning', learning, 28], ['organizational', organizational, 16]]) {
  test(`unchanged composition discovers, selects, reviews and executes the ${name} domain`, async () => {
    const f = fixture(), options = { ...f, task };
    const p = await prepareComposition(options);
    assert.equal(p.status, 'ready'); assert.equal(p.selected.id, f.products[name].id);
    assert.equal(p.catalogs.length, 2); assert.equal(p.differential.reaction.search.holonsExamined, 2);
    const exact = p.candidates.filter(c => c.exact); assert.equal(exact.length, 1);
    assert.equal(exact[0].metrics.editCost, 0); assert.equal(exact[0].invariants.length, 3);
    const hmd = parseHypermediaMarkdown(p.hmd); assert.equal(hmd.fields.reviewDigest, p.reviewDigest);
    assert.equal(hmd.controls.length, 0); assert.equal(parseHypermediaMarkdown(p.procedureHmd).links.filter(l => l.rel?.endsWith('#step')).length, steps);
    const r = await executeComposition({ ...options, reviewDigest: p.reviewDigest });
    assert.equal(r.status, 'completed', JSON.stringify(r.run)); assert.equal(r.run.metrics.automaticSteps, steps);
    assert.equal(r.run.metrics.modelInvocations, 0); assert.equal(r.run.metrics.providerInferenceCalls, null);
    assert.equal(parseHypermediaMarkdown(r.hmd).state, 'completed');
    if (name === 'organizational') {
      assert.equal(r.run.output.decision.projectIri, 'urn:fixture:project');
      assert.equal(r.run.output.citedSourceHead.cid, f.source.cid);
      assert.equal(f.calls.some(c => c.tool === 'act' || c.tool === 'dereference'), false);
    } else { assert.equal(r.run.output.scorm.courseId, 'fixture-course'); assert.equal(r.run.output.performance.totalCases, 3); }
    assert.ok(f.events.some(e => e.type === 'composition-prepared'));
    assert.ok(f.events.some(e => e.type === 'composition-result'));
  });
}

test('second domain also works as the only installed catalogue, without learning artifacts', async () => {
  const f = fixture();
  f.resources.delete(f.products.learning.requestUrl);
  const options = { ...f, task: organizational, catalogs: [f.catalogs[1]], seeds: [f.catalogB] };
  const p = await prepareComposition(options);
  assert.equal(p.status, 'ready'); assert.deepEqual(p.untrustedPeers, [f.catalogA]);
  assert.equal((await executeComposition({ ...options, reviewDigest: p.reviewDigest })).status, 'completed');
  assert.equal(f.calls.some(c => c.args.url === f.products.learning.requestUrl), false);
});

test('partial reuse returns the unexplained difference without executing a request', async () => {
  const f = fixture(), r = await prepareComposition({ ...f, task: { ...learning, goal: 'urn:goal:unknown' } });
  assert.equal(r.status, 'needs-decision'); assert.ok(r.candidates.every(c => !c.exact));
  assert.ok(r.candidates.every(c => c.differential.proposedAdditions.length));
  assert.equal(f.calls.some(c => c.args.url?.endsWith('-request.ttl')), false);
});

test('equal exact candidates require explicit selection, irrespective of heuristic score', async () => {
  const f = fixture(), p = { ...f.products.learning, id: 'urn:fixture:product:another', title: 'Another exact procedure' };
  f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl).graph.content = renderCatalog({ graphIri: f.catalogA, issuer: ISSUER,
    products: [f.products.learning, p], peers: [f.catalogB] });
  const ambiguous = await prepareComposition({ ...f, task: learning });
  assert.equal(ambiguous.status, 'needs-decision'); assert.equal(ambiguous.candidates.filter(c => c.exact).length, 2);
  const selected = await prepareComposition({ ...f, task: learning, selectedProductId: p.id });
  assert.equal(selected.status, 'ready'); assert.equal(selected.selected.id, p.id);
});

for (const [name, change] of [
  ['unsigned', d => { d.authorship.authorshipVerified = false; }],
  ['wrong signer', d => { d.authorship.signedBy = 'did:example:intruder'; }],
  ['unbound content', d => { d.authorship.contentBinding = 'unbound'; }],
  ['unbound location', d => { d.authorship.descriptorBinding.bound = false; }],
  ['wrong response location', d => { d.url += '?different'; }]
]) test(`rejects a catalogue with ${name}`, async () => {
  const f = fixture(); change(f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl));
  await assert.rejects(prepareComposition({ ...f, task: learning }), /authority|binding/u);
  assert.equal(f.calls.length, 2);
});

test('forks, wrong issuer and non-GET request ports fail before selection', async () => {
  const f = fixture(); f.heads.get(f.catalogA).forked = true;
  await assert.rejects(prepareComposition({ ...f, task: learning }), /unambiguous/u);
  const g = fixture(), data = g.resources.get(g.heads.get(g.catalogA).head.descriptorUrl);
  data.graph.content = data.graph.content.replaceAll(ISSUER, 'https://fixture.invalid/other#me');
  await assert.rejects(prepareComposition({ ...g, task: learning }), /issuer/u);
  const h = fixture(), d = h.resources.get(h.heads.get(h.catalogA).head.descriptorUrl);
  d.graph.content = d.graph.content.replace('"GET"', '"POST"');
  await assert.rejects(prepareComposition({ ...h, task: learning }), /read port/u);
});

test('a stale selected procedure pin fails before the routine starts', async () => {
  const f = fixture(); f.heads.get('urn:fixture:procedure:learning').head.cid += '-new';
  await assert.rejects(prepareComposition({ ...f, task: learning }), /stale/u);
  assert.equal(f.calls.some(c => c.tool === 'act'), false);
});

test('review digest includes invocation inputs and catalogue policy and versions', async () => {
  const f = fixture(), options = { ...f, task: organizational }, p = await prepareComposition(options);
  f.heads.get(f.catalogA).head.cid += '-new';
  const r = await executeComposition({ ...options, reviewDigest: p.reviewDigest });
  assert.equal(r.status, 'needs-decision'); assert.equal(r.run, undefined);
  await assert.rejects(executeComposition({ ...options, reviewDigest: 'yes' }), /digest/u);
});

test('a signed input change requires a new review even when the procedure pin is unchanged', async () => {
  const f = fixture(), options = { ...f, task: organizational }, p = await prepareComposition(options);
  f.resources.get(p.selected.requestUrl).graph.content = f.resources.get(p.selected.requestUrl).graph.content.replace('fixture-cid-decision', 'changed-expected-decision');
  const r = await executeComposition({ ...options, reviewDigest: p.reviewDigest });
  assert.equal(r.status, 'needs-decision'); assert.equal(r.run, undefined);
  assert.notEqual(r.reviewDigest, p.reviewDigest);
});

test('catalogue and signed request must name the same compiled procedure root', async () => {
  const f = fixture(), data = f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl);
  data.graph.content = data.graph.content.replace(f.products.learning.procedureId, f.products.organizational.procedureId);
  await assert.rejects(prepareComposition({ ...f, task: learning }), /different procedure/u);
});

test('an altered signed invocation cannot cross the bootstrap review fence', async () => {
  const f = fixture(), options = { ...f, task: organizational }, p = await prepareComposition(options);
  let reads = 0;
  const call = async (tool, args) => {
    const raw = await f.call(tool, args);
    if (tool === 'get_descriptor' && args.url === p.selected.requestUrl && ++reads === 2) raw.structuredContent.graph.content = raw.structuredContent.graph.content.replace('fixture-cid-decision', 'different-expected-cid');
    return raw;
  };
  await assert.rejects(executeComposition({ ...options, call, reviewDigest: p.reviewDigest }), /changed during bootstrap/u);
});

test('a catalogue change during execution suppresses completion and output', async () => {
  const f = fixture(), options = { ...f, task: organizational }, p = await prepareComposition(options);
  const call = async (tool, args) => {
    const raw = await f.call(tool, args);
    if (tool === 'get_descriptor' && args.url === f.decision.descriptorUrl) f.heads.get(f.catalogA).head.cid = 'changed-during-run';
    return raw;
  };
  const r = await executeComposition({ ...options, call, reviewDigest: p.reviewDigest });
  assert.equal(r.status, 'needs-decision'); assert.equal(r.run.output, undefined);
});

for (const [name, change] of [
  ['superseded citation', f => { f.heads.get(f.source.graphIri).head.cid = 'superseded'; }],
  ['untrusted citation', f => { f.resources.get(f.source.descriptorUrl).authorship.signedBy = 'did:example:other'; }],
  ['altered decision projection', f => { f.resources.get(f.decision.descriptorUrl).graph.content += '\n# different'; }]
]) test(`organizational procedure blocks ${name}`, async () => {
  const f = fixture(), options = { ...f, task: organizational }, p = await prepareComposition(options); change(f);
  const r = await executeComposition({ ...options, reviewDigest: p.reviewDigest });
  assert.equal(r.status, 'blocked'); assert.equal(r.run.output, undefined);
});

test('packet preparation rejects cross-project and substituted citation semantics', () => {
  const f = fixture();
  assert.throws(() => prepareDecisionPacket({ decision: f.decision, evidence: f.source, projectIri: 'urn:fixture:wrong', trustedSigner: SIGNER }), /project or citation/u);
  assert.throws(() => prepareDecisionPacket({ decision: f.decision, evidence: { ...f.source, graphIri: 'urn:fixture:other' }, projectIri: 'urn:fixture:project', trustedSigner: SIGNER }), /project or citation/u);
});

test('durable discovery intent failure prevents dispatch; unknown transport is not retried', async () => {
  const f = fixture(); await assert.rejects(prepareComposition({ ...f, task: learning, onEvent: async () => { throw new Error('Disk full'); } }), /Disk full/u);
  assert.equal(f.calls.length, 0);
  let calls = 0;
  await assert.rejects(prepareComposition({ ...fixture(), task: learning, call: async () => { calls++; throw new Error('Disconnected'); } }), /Disconnected/u);
  assert.equal(calls, 1);
});

test('an outcome journal failure stops before a second dispatch', async () => {
  const f = fixture();
  await assert.rejects(prepareComposition({ ...f, task: learning, onEvent: async e => { if (e.type === 'outcome') throw new Error('Outcome not durable'); } }), /not durable/u);
  assert.equal(f.calls.length, 1);
});

test('malformed catalogues and oversized trust sets cannot expand discovery', async () => {
  const f = fixture(), p = f.catalogs[0], turtle = f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl).graph.content;
  assert.throws(() => parseProcedureCatalog(turtle + `\n<${f.products.learning.id}> <${PC}goal> <urn:another:goal> .`, p), /ambiguous/u);
  assert.throws(() => parseProcedureCatalog(turtle.replace(`<${HC}AgentWorld>`, `<${HC}ServiceWorld>`), p), /world/u);
  await assert.rejects(prepareComposition({ ...f, task: learning, catalogs: Array(9).fill(p) }), /1–8/u);
});
