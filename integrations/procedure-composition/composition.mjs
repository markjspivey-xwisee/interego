/** Installed optional client composition. Discovery and execution have no model callback. */
import { DifferentialKernel } from '../affordance-surface/differential-kernel.ts';
import { unpackMcp } from '../procedure-runner/runner.mjs';
import { verifiedProcedureGraph } from '../procedure-runner/graph.mjs';
import { readRunRequest } from '../procedure-runner/request.mjs';
import { executeLinkedRequest } from '../procedure-runner/stdio.mjs';
import { renderProcedure } from '../procedure-runner/render.mjs';
import { renderHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';
import { PC, PR, digest, iri, httpUrl, verifiedDocument, parseProcedureCatalog } from './profile.mjs';

function policyMap(catalogs) {
  if (!Array.isArray(catalogs) || !catalogs.length || catalogs.length > 8) throw new Error('Expected 1–8 explicit catalogue trust bindings');
  const map = new Map();
  for (const p of catalogs) {
    iri(p.graphIri); iri(p.issuer); iri(p.trustedSigner); httpUrl(p.podUrl);
    if (map.has(p.graphIri)) throw new Error('Ambiguous catalogue trust binding');
    map.set(p.graphIri, { graphIri: p.graphIri, issuer: p.issuer, trustedSigner: p.trustedSigner, podUrl: p.podUrl });
  }
  return map;
}
function taskGraph(task) {
  iri(task.domain); iri(task.goal);
  return [[PC + 'task', PC + 'domain', task.domain], [PC + 'task', PC + 'goal', task.goal], [PC + 'task', PC + 'profile', PR + 'ReadProcedureProfile']];
}
/** Exported for its focused budget test: bounded discovery and the runner's own
 *  16-call limit keep honest flows far below this phase budget. */
export function transport(call, onEvent, phase) {
  if (typeof call !== 'function' || typeof onEvent !== 'function') throw new Error('An authenticated host and durable event recorder are required');
  let n = 0;
  return async (tool, args) => {
    if (!['get_descriptor', 'get_current_head', 'dereference', 'act'].includes(tool) || ++n > 64) throw new Error('Composition capability or call budget exceeded');
    await onEvent({ type: 'intent', phase, number: n, tool, args });
    let raw;
    try { raw = await call(tool, args); }
    catch (error) { await onEvent({ type: 'transport-error', phase, number: n, tool, message: String(error.message) }); throw error; }
    await onEvent({ type: 'outcome', phase, number: n, raw });
    return raw;
  };
}
function current(raw) {
  const data = unpackMcp(raw);
  if (data.forked !== false || !data.head?.cid || !data.head?.descriptorUrl) throw new Error('No unambiguous committed head');
  httpUrl(data.head.descriptorUrl);
  return { cid: data.head.cid, descriptorUrl: data.head.descriptorUrl };
}
const sameHead = (a, b) => a.cid === b.cid && a.descriptorUrl === b.descriptorUrl;
/** Untrusted text as one inert GFM table cell or paragraph: line breaks become
 *  spaces, a backslash and every character that could open a cell boundary,
 *  link, image, HTML tag, entity or emphasis is backslash-escaped, and a
 *  backtick becomes a character reference (HMD's table lift reads any backtick
 *  as a code-span toggle). The rendered text is the value, character for character. */
const cell = x => String(x).replace(/[\\|*_~[\]<>&]/gu, c => '\\' + c).replaceAll('`', '&#96;').replace(/\r\n?|\n/gu, ' ');
const table = (head, rows) => `| ${head.join(' | ')} |\n|${head.map(() => ' --- |').join('')}\n`
  + rows.map(row => `| ${row.map(cell).join(' | ')} |`).join('\n') + '\n';

function view({ status, reason, task, candidates, selected, reviewDigest, catalogs, untrustedPeers }) {
  const links = catalogs.map(c => ({ label: 'Catalogue authority', href: c.head.descriptorUrl, rel: 'describedby', type: 'text/turtle' }));
  if (selected) links.push({ label: 'Signed invocation request', href: selected.requestUrl, rel: PC + 'request', type: 'text/turtle' },
    { label: 'Authoritative procedure', href: selected.request.procedureDescriptor, rel: PC + 'procedure', type: 'text/turtle' });
  const request = selected?.request;
  return renderHypermediaMarkdown({ id: 'urn:interego:procedure-composition:review:' + (reviewDigest ?? digest(candidates)),
    type: 'pc:Review', descriptorUrl: catalogs[0].head.descriptorUrl, title: 'Evidence-review composition', controls: [], links,
    extraContext: { pc: PC, reviewDigest: PC + 'reviewDigest' }, fields: { state: status, ...(reviewDigest ? { reviewDigest } : {}) },
    body: '# Evidence-review composition\n\n' + cell(reason) + '\n\n'
      + (request ? 'The installed client loads the signed request and directed RDF steps. Review covers the exact inputs and observed catalogue and procedure pins shown below; the separate procedure HMD shows the compiled steps. Re-run preparation after a change.\n\n'
        : 'No invocation is selected, so nothing here is ready to approve. Re-run preparation after a change.\n\n')
      + '| Candidate | Exact reuse | Additions | Unexplained task triples |\n| --- | --- | --- | --- |\n'
      + candidates.map(c => `| ${cell(c.title)} | ${c.exact} | ${c.differential.proposedAdditions.length} | ${c.differential.unexplainedCurrent.length} |`).join('\n') + '\n'
      + '\n## Task\n\n' + table(['Term', 'IRI'], [['Domain', task.domain], ['Goal', task.goal]])
      + '\n## Observed catalogue pins\n\n' + table(['Catalogue', 'Issuer', 'Trusted signer', 'Pod', 'Head descriptor', 'Head CID'],
        catalogs.map(c => [c.policy.graphIri, c.policy.issuer, c.policy.trustedSigner, c.policy.podUrl, c.head.descriptorUrl, c.head.cid]))
      + '\n## Untrusted peers\n\n' + (untrustedPeers.length
        ? 'Advertised by an observed catalogue without a trust binding; never read and granted no trust.\n\n' + table(['Peer catalogue'], untrustedPeers.map(peer => [peer]))
        : 'No observed catalogue advertises a peer outside the trust bindings.\n')
      + (request ? '\n## Procedure pin\n\n' + table(['Pin', 'Value'], [['Product', selected.id], ['Signed request', selected.requestUrl],
          ['Procedure root', selected.procedureId], ['Procedure descriptor', request.procedureDescriptor], ['Procedure graph', request.procedureGraph],
          ['Procedure pod', request.procedurePod], ['Procedure CID', request.procedureCid]])
        + '\n## Invocation inputs\n\n' + table(['Input', 'Value'], Object.keys(request.input).sort().map(key => [key, request.input[key]])) : '')
      + '\nCatalogue signatures establish attribution and publication binding. A successful review establishes the procedure’s declared checks, within its evidence limits.\n'
  });
}

/** Discover only explicitly trusted catalogues; federation never supplies new trust. */
export async function prepareComposition({ task, catalogs, seeds, selectedProductId, call, onEvent }) {
  const policies = policyMap(catalogs), graph = taskGraph(task);
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 8 || seeds.some(id => !policies.has(id))) throw new Error('Seeds require explicit trust bindings');
  const read = transport(call, onEvent, 'composition-discovery');
  const queue = [...seeds], seen = new Set(), observed = [], products = [], untrustedPeers = [];
  while (queue.length) {
    const id = queue.shift(); if (seen.has(id)) continue;
    seen.add(id); const policy = policies.get(id);
    const head = current(await read('get_current_head', { pod_url: policy.podUrl, urn: id }));
    const turtle = verifiedDocument(await read('get_descriptor', { url: head.descriptorUrl }), head.descriptorUrl, policy.trustedSigner);
    const catalog = parseProcedureCatalog(turtle, policy);
    observed.push({ policy, head });
    for (const product of catalog.products) {
      if (products.some(p => p.id === product.id)) throw new Error('A product identity is advertised by multiple catalogues');
      products.push({ ...product, policy, catalogHead: head });
    }
    for (const peer of catalog.peers) { if (policies.has(peer)) queue.push(peer); else untrustedPeers.push(peer); }
  }
  if (products.length > 128) throw new Error('Federated product budget exceeded');
  const holons = products.map(p => ({ id: p.id, label: p.title, registryDescriptor: p.catalogHead.descriptorUrl,
    views: [{ id: p.id + '#whole-procedure', lenses: ['procedure'], granularities: ['whole-procedure'],
      graph: [['?work', PC + 'domain', p.domain], ['?work', PC + 'goal', p.goal], ['?work', PC + 'profile', PR + 'ReadProcedureProfile']],
      affordance: { procedure: p.procedureId, request: p.requestUrl } }] }));
  const kernel = new DifferentialKernel(holons), reaction = kernel.react({ graph, limit: 128 });
  const resolution = kernel.resolve({ reactionId: reaction.id, policy: 'verified-minimal-edit' });
  const candidates = reaction.options.map(c => ({ ...c, productId: c.sourceHolons[0], title: c.label,
    exact: c.kind === 'reuse' && c.metrics.editCost === 0 && c.metrics.coverage === 1 && c.metrics.alignment === 1 && c.preconditions.every(p => p.satisfied) }));
  const eligible = candidates.filter(c => c.exact);
  let chosen;
  if (selectedProductId) chosen = eligible.find(c => c.productId === selectedProductId);
  else if (eligible.length === 1) chosen = eligible[0];
  const base = { task: { domain: task.domain, goal: task.goal }, catalogs: observed, candidates, untrustedPeers,
    differential: { reaction, resolution } };
  if (!chosen) {
    const reason = selectedProductId ? 'The requested product is not an exact reuse candidate.'
      : eligible.length ? 'Several procedures match exactly; select a product explicitly.' : 'No whole procedure exactly covers the task.';
    const result = { ...base, status: 'needs-decision', reason };
    return { ...result, hmd: view(result) };
  }
  const product = products.find(p => p.id === chosen.productId), trustedSigner = product.policy.trustedSigner;
  const requestRaw = await read('get_descriptor', { url: product.requestUrl });
  verifiedDocument(requestRaw, product.requestUrl, trustedSigner);
  const request = readRunRequest(requestRaw, { descriptorUrl: product.requestUrl, trustedSigner });
  const procedureHead = current(await read('get_current_head', { pod_url: request.procedurePod, urn: request.procedureGraph }));
  if (!sameHead(procedureHead, { descriptorUrl: request.procedureDescriptor, cid: request.procedureCid })) throw new Error('Selected procedure pin is stale');
  const procedureRaw = await read('get_descriptor', { url: request.procedureDescriptor });
  const procedureTurtle = verifiedDocument(procedureRaw, request.procedureDescriptor, trustedSigner);
  const compiled = verifiedProcedureGraph(procedureRaw, { descriptorUrl: request.procedureDescriptor, trustedSigner });
  if (compiled.graph.root !== product.procedureId) throw new Error('The request names a different procedure from the catalogue product');
  const review = { version: 1, task: base.task, catalogs: observed, product: { id: product.id, requestUrl: product.requestUrl, trustedSigner },
    request, procedure: compiled.procedure };
  const reviewDigest = digest(review), selected = { ...product, request, procedureDigest: digest(compiled.procedure) };
  const result = { ...base, status: 'ready', reason: 'One exact whole-procedure reuse is ready for host review.', reviewDigest, review, selected,
    procedureHmd: renderProcedure(procedureTurtle, { descriptorUrl: request.procedureDescriptor }) };
  await onEvent({ type: 'composition-prepared', phase: 'composition', reviewDigest, review, differential: base.differential });
  return { ...result, hmd: view(result) };
}

/** The host approves a digest, then discovery and all signed bindings run again. */
export async function executeComposition({ reviewDigest, ...options }) {
  if (!/^[a-f0-9]{64}$/u.test(reviewDigest ?? '')) throw new Error('An explicit reviewed digest is required');
  const prepared = await prepareComposition(options);
  if (prepared.status !== 'ready' || prepared.reviewDigest !== reviewDigest) return { ...prepared, status: 'needs-decision', reason: 'The reviewed composition changed; review the fresh preparation.' };
  const { selected, review } = prepared;
  const read = transport(options.call, options.onEvent, 'composition-execution');
  const call = async (tool, args) => {
    const raw = await read(tool, args);
    if (tool === 'get_descriptor' && args.url === selected.requestUrl) {
      verifiedDocument(raw, args.url, selected.policy.trustedSigner);
      if (digest(readRunRequest(raw, { descriptorUrl: args.url, trustedSigner: selected.policy.trustedSigner })) !== digest(review.request)) throw new Error('Reviewed invocation changed during bootstrap');
    }
    if (tool === 'get_descriptor' && args.url === review.request.procedureDescriptor) {
      verifiedDocument(raw, args.url, selected.policy.trustedSigner);
      if (digest(verifiedProcedureGraph(raw, { descriptorUrl: args.url, trustedSigner: selected.policy.trustedSigner }).procedure) !== selected.procedureDigest) throw new Error('Reviewed procedure changed during bootstrap');
    }
    return raw;
  };
  const run = await executeLinkedRequest({ requestUrl: selected.requestUrl, trustedSigner: selected.policy.trustedSigner, call, onEvent: options.onEvent });
  if (run.status === 'completed') for (const c of prepared.catalogs) {
    const head = current(await read('get_current_head', { pod_url: c.policy.podUrl, urn: c.policy.graphIri }));
    if (!sameHead(head, c.head)) {
      const stopped = { status: 'needs-decision', reason: 'A discovery catalogue changed during execution.', reviewDigest,
        run: { ...run, status: 'needs-decision', output: undefined }, observation: { catalog: c.policy.graphIri, head } };
      await options.onEvent({ type: 'composition-result', phase: 'composition', result: stopped });
      return stopped;
    }
  }
  const result = { status: run.status, reviewDigest, productId: selected.id, run,
    hmd: renderHypermediaMarkdown({ id: 'urn:interego:procedure-composition:result:' + reviewDigest, type: 'pc:Result',
      descriptorUrl: selected.requestUrl, title: 'Evidence review result', extraContext: { pc: PC }, fields: { state: run.status }, controls: [],
      links: [{ label: 'Signed invocation', href: selected.requestUrl, rel: PC + 'request', type: 'text/turtle' }],
      body: '# Evidence review result\n\nStatus: ' + cell(run.status) + '\n\n```json\n' + JSON.stringify(run.output ?? { reason: run.reason, observation: run.observation }, null, 2).replaceAll('```', '\\u0060\\u0060\\u0060') + '\n```\n' }) };
  await options.onEvent({ type: 'composition-result', phase: 'composition', result });
  return result;
}
