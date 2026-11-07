import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHypermediaMarkdown, liftHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';
import { prepareComposition, executeComposition, transport } from './composition.mjs';
import { parseProcedureCatalog, renderCatalog, renderRunRequest, graphIndex, PC, HC, PR, DCT, HYDRA } from './profile.mjs';
import { prepareDecisionPacket } from './organizational-packet.mjs';
import { fixture, learning, organizational, SIGNER, ISSUER } from './fixtures.mjs';

test('optional profile classes specialize W3C types; local properties stay in the urn: profile namespace', () => {
  const graph = graphIndex(readFileSync(new URL('./profile.ttl', import.meta.url), 'utf8'));
  const OWL = 'http://www.w3.org/2002/07/owl#';
  const classes = [...graph.nodes.keys()].filter(id => graph.typed(id, OWL + 'Class'));
  assert.ok(classes.length > 0);
  for (const id of classes) assert.ok(graph.links(id, 'http://www.w3.org/2000/01/rdf-schema#subClassOf')
    .some(parent => parent.startsWith('http://www.w3.org/')), `${id} must specialize an existing W3C type`);
  const properties = [...graph.nodes.keys()].filter(id => graph.typed(id, OWL + 'ObjectProperty') || graph.typed(id, OWL + 'DatatypeProperty'));
  assert.ok(properties.length > 0);
  assert.ok(PC.startsWith('urn:'));
  // Every term the profile declares, property or class, is in its own urn: namespace, not a core one.
  for (const id of graph.nodes.keys()) assert.ok(id.startsWith(PC), `${id} must stay in the ${PC} profile namespace`);
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

test('each product must carry the catalogue issuer, agent world and read-procedure profile', () => {
  const f = fixture(), policy = f.catalogs[0], product = f.products.learning;
  const turtle = f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl).graph.content;
  assert.equal(parseProcedureCatalog(turtle, policy).products.length, 1);
  // Each edit changes only the product's statement; the catalogue's own issuer and world stay valid.
  for (const [name, from, to] of [
    ['issuer', `"${product.title}" ; <${HC}issuedBy> <${ISSUER}>`, `"${product.title}" ; <${HC}issuedBy> <https://fixture.invalid/other#me>`],
    ['world', `<${HC}world> <${HC}AgentWorld> ; <${DCT}conformsTo>`, `<${HC}world> <${HC}ServiceWorld> ; <${DCT}conformsTo>`],
    ['profile', `<${DCT}conformsTo> <${PR}ReadProcedureProfile>`, `<${DCT}conformsTo> <${PR}OtherProfile>`]
  ]) {
    assert.ok(turtle.includes(from), name);
    assert.throws(() => parseProcedureCatalog(turtle.replace(from, to), policy), /product authority or profile/u, name);
  }
});

test('a request port whose target differs from its access URL is refused', () => {
  const f = fixture(), product = f.products.learning;
  const turtle = f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl).graph.content;
  const from = `<${HYDRA}target> <${product.requestUrl}>`;
  assert.ok(turtle.includes(from));
  assert.throws(() => parseProcedureCatalog(turtle.replace(from, `<${HYDRA}target> <https://fixture.invalid/pod/other-request.ttl>`), f.catalogs[0]), /target differs/u);
});

test('catalogue product and peer budgets admit 32 products and 8 peers, not more', () => {
  const f = fixture(), policy = f.catalogs[0], base = { graphIri: f.catalogA, issuer: ISSUER };
  const products = Array.from({ length: 33 }, (_, i) => ({ ...f.products.learning, id: `urn:fixture:product:bulk-${i}`, requestUrl: `https://fixture.invalid/pod/bulk-${i}.ttl` }));
  const peers = Array.from({ length: 9 }, (_, i) => `urn:fixture:catalog:peer-${i}`);
  assert.throws(() => renderCatalog({ ...base, products }), /budget/u);
  assert.throws(() => renderCatalog({ ...base, products: [], peers }), /budget/u);
  const full = renderCatalog({ ...base, products: products.slice(0, 32), peers: peers.slice(0, 8) });
  const parsed = parseProcedureCatalog(full, policy);
  assert.equal(parsed.products.length, 32); assert.equal(parsed.peers.length, 8);
  // The renderer refuses an oversized catalogue, so the extra member is a second rendering of the same catalogue.
  assert.throws(() => parseProcedureCatalog(full + renderCatalog({ ...base, products: products.slice(32) }), policy), /product budget/u);
  assert.throws(() => parseProcedureCatalog(full + renderCatalog({ ...base, products: [], peers: peers.slice(8) }), policy), /peer budget/u);
});

test('two trust bindings for one catalogue graph are refused before any host call', async () => {
  const f = fixture(), catalogs = [f.catalogs[0], { ...f.catalogs[0], trustedSigner: 'did:example:other-signer' }];
  await assert.rejects(prepareComposition({ ...f, task: learning, catalogs }), /Ambiguous catalogue trust binding/u);
  assert.equal(f.calls.length, 0);
});

test('one product identity advertised by two catalogues is refused before any request read', async () => {
  const f = fixture();
  f.resources.get(f.heads.get(f.catalogB).head.descriptorUrl).graph.content = renderCatalog({ graphIri: f.catalogB, issuer: ISSUER,
    products: [f.products.organizational, { ...f.products.learning, requestUrl: f.products.organizational.requestUrl }], peers: [f.catalogA] });
  await assert.rejects(prepareComposition({ ...f, task: learning }), /advertised by multiple catalogues/u);
  assert.equal(f.calls.some(c => c.args.url?.endsWith('-request.ttl')), false);
});

test('one composition phase dispatches at most 64 read-capability host calls', async () => {
  const dispatched = [], events = [];
  const read = transport(async tool => { dispatched.push(tool); return { structuredContent: {}, isError: false }; }, async e => { events.push(e); }, 'budget-test');
  for (let i = 0; i < 64; i++) await read('get_current_head', { urn: `urn:fixture:${i}` });
  await assert.rejects(read('get_current_head', { urn: 'urn:fixture:65' }), /call budget exceeded/u);
  assert.equal(dispatched.length, 64); assert.equal(events.filter(e => e.type === 'intent').length, 64);
  await assert.rejects(transport(async () => { dispatched.push('publish_context'); }, async () => {}, 'budget-test')('publish_context', {}), /capability/u);
  assert.equal(dispatched.length, 64);
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

test('the review HMD shows, escaped, the inputs, catalogue pins and untrusted peers it covers', async () => {
  const f = fixture(), note = 'a|b\r\nc <img src=x> [l](https://e.invalid) \\ `t` *e* &amp;';
  const procedure = f.heads.get('urn:fixture:procedure:organizational').head;
  f.resources.get(f.products.organizational.requestUrl).graph.content = renderRunRequest({ id: 'urn:fixture:run:organizational',
    procedureDescriptor: procedure.descriptorUrl, procedureGraph: 'urn:fixture:procedure:organizational', procedurePod: f.catalogs[0].podUrl,
    procedureCid: procedure.cid, input: { ...f.organizationalInput, note } });
  f.heads.get(f.catalogB).head.cid = 'cid|`b`<i>';
  f.resources.get(f.heads.get(f.catalogB).head.descriptorUrl).graph.content = renderCatalog({ graphIri: f.catalogB, issuer: ISSUER,
    products: [f.products.organizational], peers: [f.catalogA, 'urn:fixture:catalog:untrusted'] });
  const p = await prepareComposition({ ...f, task: organizational });
  assert.equal(p.status, 'ready'); assert.equal(p.review.request.input.note, note);
  const body = parseHypermediaMarkdown(p.hmd).body;
  const shows = row => assert.ok(body.includes(row), `review HMD lacks ${row}`);
  for (const [key, value] of Object.entries(f.organizationalInput)) shows(`| ${key} | ${value} |`);
  shows('| note | a\\|b c \\<img src=x\\> \\[l\\](https://e.invalid) \\\\ &#96;t&#96; \\*e\\* \\&amp; |');
  shows(`| ${f.catalogA} | ${ISSUER} | ${SIGNER} | ${f.catalogs[0].podUrl} | ${f.heads.get(f.catalogA).head.descriptorUrl} | fixture-cid-catalog-a |`);
  shows(`| ${f.catalogB} | ${ISSUER} | ${SIGNER} | ${f.catalogs[1].podUrl} | ${f.heads.get(f.catalogB).head.descriptorUrl} | cid\\|&#96;b&#96;\\<i\\> |`);
  shows('| urn:fixture:catalog:untrusted |'); assert.deepEqual(p.untrustedPeers, ['urn:fixture:catalog:untrusted']);
  shows(`| Procedure descriptor | ${procedure.descriptorUrl} |`); shows(`| Procedure CID | ${procedure.cid} |`);
  shows(`| Domain | ${organizational.domain} |`); shows(`| Goal | ${organizational.goal} |`);
  assert.doesNotMatch(p.hmd, /(?<!\\)<(img|i)\b|(?<!\\)\[l\]/u);
  // Each hostile value stays one table cell under HMD's own table lift (which unescapes only \|).
  const cells = liftHypermediaMarkdown(p.hmd).filter(t => t.p.endsWith('cellText')).map(t => t.o);
  assert.ok(cells.includes('a|b c \\<img src=x\\> \\[l\\](https://e.invalid) \\\\ &#96;t&#96; \\*e\\* \\&amp;'));
  assert.ok(cells.includes('cid|&#96;b&#96;\\<i\\>'));
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

test('an altered procedure cannot cross the bootstrap review fence', async () => {
  const f = fixture(), options = { ...f, task: organizational }, p = await prepareComposition(options);
  const from = 'Packet profile, signer, decision or project binding failed.';
  assert.ok(f.resources.get(p.selected.request.procedureDescriptor).graph.content.includes(from));
  let reads = 0;
  // Same signer, bindings and head pin; only the procedure's own content differs on the bootstrap read.
  const call = async (tool, args) => {
    const raw = await f.call(tool, args);
    if (tool === 'get_descriptor' && args.url === p.selected.request.procedureDescriptor && ++reads === 2) raw.structuredContent.graph.content = raw.structuredContent.graph.content.replace(from, 'Changed after review.');
    return raw;
  };
  await assert.rejects(executeComposition({ ...options, call, reviewDigest: p.reviewDigest }), /Reviewed procedure changed during bootstrap/u);
  assert.equal(reads, 2);
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

// parseTrig keeps a relative IRI such as <?d> as the bare string '?d', which
// DifferentialKernel reads as a variable that would match any task term.
for (const property of ['domain', 'goal', 'procedure']) test(`a relative product ${property} IRI cannot become a kernel variable`, async () => {
  const f = fixture(), data = f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl);
  const value = { domain: learning.domain, goal: learning.goal, procedure: f.products.learning.procedureId }[property];
  const from = `<${PC}${property}> <${value}>`;
  assert.ok(data.graph.content.includes(from));
  data.graph.content = data.graph.content.replace(from, `<${PC}${property}> <?d>`);
  assert.throws(() => parseProcedureCatalog(data.graph.content, f.catalogs[0]), /absolute IRI/u);
  // A task the product does not name: before the check, '?d' matched it exactly.
  const task = property === 'procedure' ? learning : { ...learning, [property]: `urn:${property}:unrelated` };
  await assert.rejects(prepareComposition({ ...f, task }), /absolute IRI/u);
  assert.equal(f.calls.some(c => c.args.url === f.products.learning.requestUrl), false);
});

test('malformed catalogues and oversized trust sets cannot expand discovery', async () => {
  const f = fixture(), p = f.catalogs[0], turtle = f.resources.get(f.heads.get(f.catalogA).head.descriptorUrl).graph.content;
  assert.throws(() => parseProcedureCatalog(turtle + `\n<${f.products.learning.id}> <${PC}goal> <urn:another:goal> .`, p), /ambiguous/u);
  assert.throws(() => parseProcedureCatalog(turtle.replace(`<${HC}AgentWorld>`, `<${HC}ServiceWorld>`), p), /world/u);
  await assert.rejects(prepareComposition({ ...f, task: learning, catalogs: Array(9).fill(p) }), /1–8/u);
});
