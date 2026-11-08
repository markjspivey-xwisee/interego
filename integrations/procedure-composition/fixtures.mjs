/** Offline test environment only. These signatures and domain outcomes are fixtures. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderHypermediaMarkdown } from '../../packages/core/dist/kernel/hypermedia-markdown.js';
import { PR, PC, renderCatalog, renderRunRequest, literal } from './profile.mjs';
import { prepareDecisionPacket, OWM } from './organizational-packet.mjs';

export const SIGNER = 'did:example:fixture-author';
export const ISSUER = 'https://fixture.invalid/owner#me';
export const POD = 'https://fixture.invalid/pod/';
export const learning = { domain: 'urn:domain:performance-learning', goal: 'urn:goal:evidence-review' };
export const organizational = { domain: 'urn:domain:organizational-memory', goal: 'urn:goal:evidence-review' };
export const ok = structuredContent => ({ structuredContent, isError: false });
export const authority = () => ({ signedBy: SIGNER, authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true } });
export function signedJson(document) {
  const text = JSON.stringify(document), sha = createHash('sha256').update(text).digest('hex');
  return { sha, turtle: `@prefix ia: <urn:interego:application:> .\n<urn:fixture:doc>\n ia:format "canonical-json/v1" ;\n ia:jsonBase64 "${Buffer.from(text).toString('base64')}" ;\n ia:sha256 "${sha}" .\n` };
}

export function fixture() {
  const resources = new Map(), heads = new Map(), representations = new Map(), calls = [], events = [];
  const put = (name, graphIri, content) => {
    const descriptorUrl = POD + name + '.ttl', cid = 'fixture-cid-' + name;
    resources.set(descriptorUrl, { url: descriptorUrl, graph: { content }, authorship: authority() });
    heads.set(graphIri, { forked: false, head: { descriptorUrl, cid } });
    return { podUrl: POD, descriptorUrl, cid, graphIri, content };
  };
  const source = put('source', 'urn:fixture:source', '<urn:fixture:source> <http://purl.org/dc/terms/title> "Fixture design evidence" .');
  const decision = put('decision', 'urn:fixture:decision', `<urn:fixture:decision> a <${OWM}Decision> ;
    <http://purl.org/dc/terms/title> "Keep composition optional" ; <${OWM}rationale> "Domain workflows own their evaluation." ;
    <${OWM}concernsProject> <urn:fixture:project> ; <http://purl.org/dc/terms/source> <urn:fixture:source> .`);
  const packet = prepareDecisionPacket({ decision, evidence: source, projectIri: 'urn:fixture:project', trustedSigner: SIGNER });
  const packetRef = put('packet', 'urn:fixture:packet', packet.turtle);
  const organizationalInput = { packetDescriptor: packetRef.descriptorUrl, expectedProjectIri: 'urn:fixture:project',
    expectedDecisionIri: decision.graphIri, expectedDecisionCid: decision.cid, trustedSigner: SIGNER };

  const portable = put('portable', 'urn:fixture:portable', signedJson({ nativeProduction: { success: true, statementId: 'fixture-statement', sharedLattice: { descriptorUrl: POD + 'fixture-event.ttl' } } }).turtle);
  const readinessJson = signedJson({ ready: true, subjectDigest: 'fixture-candidate', heldOutEvaluation: { suiteDigest: 'fixture-suite', passedCases: 3, totalCases: 3 },
    standardsEvidence: { lerDescriptorUrl: portable.descriptorUrl, xapiStatementIds: ['fixture-statement'] }, issuedAt: '2026-01-01T00:00:00Z' });
  const readiness = put('readiness', 'urn:fixture:readiness', readinessJson.turtle);
  const resultsJson = signedJson({ candidate: { documentDigest: 'fixture-candidate' },
    liveFoxxiResults: { revised: { graded: { correct: 3, total: 3 }, course: { id: 'fixture-course' } } } });
  const results = put('results', 'urn:fixture:results', resultsJson.turtle);
  const state = put('state', 'urn:fixture:state', '<urn:fixture:state> <urn:status> "ready" .');
  const app = put('app', 'urn:fixture:application-catalog', '<urn:fixture:app> <urn:fixture:type> <urn:fixture:application> .');
  const snapshot = { live: true, catalog: { current: true }, application: { title: 'Offline learning fixture', stateGraphIri: state.graphIri },
    head: { forked: false, cid: state.cid, version: 2, state: { status: 'ready', candidateDigest: 'fixture-candidate', evaluationSuiteDigest: 'fixture-suite', acceptedEvidence: [
      { role: 'performance-readiness', descriptorUrl: readiness.descriptorUrl, documentDigest: readinessJson.sha },
      { role: 'live-foxxi-results', descriptorUrl: results.descriptorUrl, documentDigest: resultsJson.sha }] } },
    trust: { verified: true, artifactsTotal: 3, artifactsVerified: 3 },
    replay: { complete: true, chainLength: 1, verifiedLinks: 1, errors: [], links: [{ verified: true }] }, generatedAt: '2026-01-01T00:00:00Z' };
  const control = { action: 'urn:fixture:inspect:v9', descriptorUrl: app.descriptorUrl, method: 'GET', executable: true, fields: [], label: 'Refresh and verify' };
  resources.get(app.descriptorUrl).view = { snapshot, controls: [control] };
  const hmdUrl = 'https://fixture.invalid/course.hmd', jsonUrl = 'https://fixture.invalid/course.json';
  representations.set(hmdUrl, { status: 'ok', contentType: 'text/markdown', representation: renderHypermediaMarkdown({ id: 'https://fixture.invalid/course',
    descriptorUrl: app.descriptorUrl, type: 'schema:Course', fields: { courseId: 'fixture-course' }, extraContext: { courseId: 'urn:fixture:courseId' }, controls: [],
    body: '# Fixture course', links: [{ href: jsonUrl, label: 'Catalog record', rel: 'alternate', type: 'application/json' }] }) });
  representations.set(jsonUrl, { status: 'ok', contentType: 'application/json', representation: JSON.stringify({ ok: true, courseId: 'fixture-course', scoCount: 1,
    scos: [{ assessmentCount: 3 }], manifest: 'https://fixture.invalid/imsmanifest.xml', scormZip: 'https://fixture.invalid/course.zip', hmd: hmdUrl }) });
  const learningInput = { podUrl: POD, catalogGraphIri: app.graphIri, expectedStateCid: state.cid, courseHmd: hmdUrl };

  const products = {};
  for (const [name, file, task, input] of [
    ['learning', 'performance-learning-review.ttl', learning, learningInput],
    ['organizational', 'organizational-evidence-review.ttl', organizational, organizationalInput]
  ]) {
    const content = readFileSync(new URL('../../examples/procedures/' + file, import.meta.url), 'utf8');
    const procedure = put(name + '-procedure', 'urn:fixture:procedure:' + name, content);
    const procedureId = name === 'learning' ? 'urn:interego:procedure:performance-learning-evidence-review:v1' : 'urn:interego:procedure:organizational-evidence-review:v1';
    const request = put(name + '-request', 'urn:fixture:request:' + name, renderRunRequest({ id: 'urn:fixture:run:' + name,
      procedureDescriptor: procedure.descriptorUrl, procedureGraph: procedure.graphIri, procedurePod: POD, procedureCid: procedure.cid, input }));
    products[name] = { id: 'urn:fixture:product:' + name, title: name + ' evidence review (fixture)', ...task, procedureId, requestUrl: request.descriptorUrl };
  }
  const catalogA = 'urn:fixture:catalog:learning', catalogB = 'urn:fixture:catalog:organizational';
  put('catalog-a', catalogA, renderCatalog({ graphIri: catalogA, issuer: ISSUER, products: [products.learning], peers: [catalogB] }));
  put('catalog-b', catalogB, renderCatalog({ graphIri: catalogB, issuer: ISSUER, products: [products.organizational], peers: [catalogA] }));
  const catalogs = [catalogA, catalogB].map(graphIri => ({ graphIri, podUrl: POD, issuer: ISSUER, trustedSigner: SIGNER }));
  const host = {
    onEvent: async e => { events.push(structuredClone(e)); },
    call: async (tool, args) => {
      calls.push({ tool, args: structuredClone(args) });
      if (tool === 'get_current_head') { if (!heads.has(args.urn)) throw new Error('Unexpected fixture graph'); return ok(structuredClone(heads.get(args.urn))); }
      if (tool === 'get_descriptor') { if (!resources.has(args.url)) throw new Error('Unexpected fixture descriptor'); return ok(structuredClone(resources.get(args.url))); }
      if (tool === 'dereference') { if (!representations.has(args.iri)) throw new Error('Unexpected fixture representation'); return ok(structuredClone(representations.get(args.iri))); }
      if (tool === 'act' && args.action_iri === control.action && args.descriptor_url === control.descriptorUrl && Object.keys(args.payload).length === 0) return ok({ status: 200, contentType: 'application/json', body: JSON.stringify({ snapshot }) });
      throw new Error('Unexpected fixture operation');
    }
  };
  return { ...host, catalogs, seeds: [catalogA], resources, heads, representations, calls, events, products, put, decision, source, packet, packetRef,
    organizationalInput, learningInput, catalogA, catalogB };
}
