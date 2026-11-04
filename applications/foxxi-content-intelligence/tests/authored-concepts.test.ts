import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import vm from 'node:vm';
import express from 'express';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AUTHORED_CATALOG, AUTHORED_NS, FRAMEWORK_IRI, projectWorkbenchData, resolveConceptIndex, authoredReferentTurtle } from '../i2idlx/typescript/authored-concepts.js';
import { executeClientTask, loadPublicTaskData } from '../src/i2idlx-client-tasks.js';
import { attachSemanticTaskRoutes, createSemanticTaskExecutor } from '../src/i2idlx-semantic-tasks.js';
import { authoredGlossaryAffordances } from '../src/i2idlx-authored-affordances.js';

const NS = AUTHORED_NS, SH = 'http://www.w3.org/ns/shacl#', RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#', OWL = 'http://www.w3.org/2002/07/owl#';
const CANONICAL = 'https://id.i2idl.org/concepts/', MODEL = NS + 'ModelReferent';
// A deliberately small source fixture: the test does not claim that these eight rows are the full release.
function fixture() {
  const rows = AUTHORED_CATALOG.concepts[0]!.related.map(id => ({ id, l: id.replaceAll('-', ' '), d: 'Unchanged source fixture definition: ' + id,
    a: [], x: '', t: 'framework', k: 'framework', f: ['standards-and-interoperability'], pf: 'standards-and-interoperability', cu: [],
    b: [], n: [], r: [], ev: [], xm: [], pv: 's', rc: 'model', rb: 't', rw: 'Source fixture category.', di: 'https://id.i2idl.org/definitions/' + id + '-1' }));
  const query = readFileSync(new URL('../i2idlx/src/queries/stored/10-classify.rq', import.meta.url), 'utf8').replaceAll('{{NS}}', NS).replace(/^#.*$/gm, '').trim();
  return { meta: { ns: NS, base: 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc', shapes: NS.slice(0, -1) + '-shapes', release: 'v0.0.93', commit: '0754254be64f0562bab7e68d69583f2cc90aa945',
    scheme: { iri: 'https://id.i2idl.org/scheme', title: 'Canonical source fixture' },
    license: { holder: 'Source fixture', name: 'CC BY 4.0' }, counts: { concepts: rows.length }, iri: { ontology: NS.slice(0, -1) } },
    concepts: rows, authoredCatalog: structuredClone(AUTHORED_CATALOG),
    sources: [], kinds: [{ id: 'framework', label: 'Framework' }], roles: [], statuses: [], methods: [], interrogatives: [],
    collections: { field: [{ id: 'standards-and-interoperability', label: 'Standards' }], type: [{ id: 'framework', label: 'Framework' }], curated: [] },
    actions: {}, enactments: [], inherited: [], roleCaps: [], mappings: [], releases: [], ports: [], queries: [{ id: 'q-classify', sparql: query }], suggestions: [], changeKinds: [], forms: [],
    semantic: { categories: [{ id: 'model', cls: 'i2x:ModelReferent', label: 'Model, framework or theory', own: ['schema:CreativeWork'], all: ['i2x:ModelReferent', 'i2x:Referent', 'schema:CreativeWork'] }],
      disjoint: {}, bridges: [], vocabs: [], columns: [], labels: {}, snapshots: [], prefixes: { i2x: NS, i2idl: CANONICAL, dct: 'http://purl.org/dc/terms/', schema: 'https://schema.org/', ler: 'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#', tla: 'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#' } },
    layout: { w: 1000, h: 1000, xy: Object.fromEntries(rows.map((c, i) => [c.id, [i * 30, 100]])), regions: [], order: [] } };
}
async function harness(run: (data: ReturnType<typeof fixture>, config: { baseUrl: string; appDataFile: string; distDirectory: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'authored-framework-'));
  const data = fixture();
  const shapes = `@prefix sh: <${SH}> . @prefix i: <${NS}> . @prefix s: <${NS.slice(0, -1)}-shapes#> .
    s:I2IDLConceptRef a sh:NodeShape; sh:nodeKind sh:IRI; sh:pattern "^https://id\\\\.i2idl\\\\.org/concepts/[a-z0-9][a-z0-9-]*$" .
    s:ClassificationShape a sh:NodeShape; sh:targetSubjectsOf i:isClassifiedBy; sh:property [ sh:path i:isClassifiedBy; sh:node s:I2IDLConceptRef ] .
    s:UsageShape a sh:NodeShape; sh:targetClass i:UsageRecord; sh:property [ sh:path i:aboutConcept; sh:node s:I2IDLConceptRef ] .`;
  try {
    await Promise.all([
      writeFile(join(dir, 'data.json'), JSON.stringify(data)), writeFile(join(dir, 'i2idlx-shapes.ttl'), shapes),
      writeFile(join(dir, 'i2idlx.ttl'), `<${NS}category-model> <${NS}referentClass> <${MODEL}> . <${MODEL}> <${RDFS}subClassOf> <${NS}Referent>, <https://schema.org/CreativeWork> .`),
      writeFile(join(dir, 'i2idlx-alignments.ttl'), ''), writeFile(join(dir, 'i2idlx-referents.ttl'), ''),
    ]);
    const app = express(); app.use(express.json());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const config = { baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port, appDataFile: join(dir, 'data.json'), distDirectory: dir };
    attachSemanticTaskRoutes(app, config);
    try { await run(data, config); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
describe('authored glossary corpus and cross-boundary framework classification', () => {
  it('keeps every canonical definition/record intact, separates counts and exact identities, and rejects shadowing', () => {
    const data = fixture(), before = structuredClone(data), combined = projectWorkbenchData(data);
    expect(data).toEqual(before);
    expect(combined.concepts.slice(0, data.concepts.length).map((c: Record<string, unknown>) => { const { iri: _iri, origin: _origin, ...original } = c; return original; })).toEqual(data.concepts);
    expect(combined.meta.counts).toMatchObject({ canonicalConcepts: 8, authoredConcepts: 1, combinedConcepts: 9 });
    expect(combined.meta.commit).toBe(data.meta.commit); expect(combined.meta.release).toBe(data.meta.release);
    expect(resolveConceptIndex(combined).get(FRAMEWORK_IRI)).toMatchObject({ id: 'competency-framework', origin: { kind: 'authored', upstreamAdopted: false } });
    expect(resolveConceptIndex(combined).has(CANONICAL + 'competency-framework')).toBe(false);
    expect(projectWorkbenchData(combined)).toBe(combined);
    const shadow = fixture(); shadow.authoredCatalog.concepts[0]!.id = 'competency';
    expect(() => projectWorkbenchData(shadow)).toThrow(/collides/);
    const malformed = fixture(); malformed.authoredCatalog.authors[0] = 'urn:author> . <urn:forged>';
    expect(() => authoredReferentTurtle(malformed)).toThrow(/Invalid authored catalog IRI/);
  });
  it('keeps canonical editorial health/counts separate and exports the exact authored proposal identity', async () => {
    const input = fixture(), data = { ...input, meta: { ...input.meta,
      repo: 'https://github.example/canonical-source', commitDate: '2026-11-04T00:00:00Z',
      counts: { ...input.meta.counts, grounded: 0 },
      origins: ['i2idl', 'derived', 'added', 'proposed', 'interego', 'foxxi', 'team'].map(id => ({ id, label: id, what: id, where: '', trust: 'fixture' })), graphs: [],
      upstream: { provenance: ['Direct source definition', 'I2IDL synthesis supported by source evidence'], roadmapName: 'Source roadmap fixture' },
      unesco: { groups: [], fetchedAt: '2026-11-04T00:00:00Z' }, changes: { baseline: 'fixture', events: 0, facts: 0 },
    }, forms: [['competency', 0, 0, 0]], releases: [{ v: 'v0.0.93', n: input.concepts.length, rel: 0, ch: {}, add: [], nch: 0, at: '2026-11-04T00:00:00Z' }], ports: [{ id: 'port-upstream-review', tpl: 'https://github.example/canonical-source/issues/new{?title,body}' }] };
    const bundle = await build({ stdin: { contents: 'export { health } from "./health.js"; export { editorialPacket } from "./packet.js"; export { upstreamIssue } from "./governance.jsx"; export { Insights } from "./views/insights.jsx"; export { runLocal } from "./queries.js"; export { annotate } from "./annotate.js"; export { LayersModal } from "./origin.jsx";', resolveDir: resolve('applications/foxxi-content-intelligence/i2idlx/app/src') }, bundle: true, format: 'cjs', platform: 'browser', write: false });
    const browser: Record<string, any> = { module: { exports: {} }, document: { getElementById: () => ({ textContent: JSON.stringify(data) }) }, window: {}, URL,
      React: { createContext: () => ({}), useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({}), useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(),
        useContext: () => ({ tallies: new Map(), policy: { quorum: 1 }, allNotes: [], usageByConcept: new Map(), ballots: new Map(), signedIn: false }),
        createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: { ...props, children } }) } };
    vm.runInNewContext(bundle.outputFiles[0]!.text, browser);
    const api = browser.module.exports, health = api.health(), packet = api.editorialPacket();
    // Eight synthetic canonical definitions; the ninth authored definition and its
    // eight intentional outward links must not become source editorial defects.
    expect(health.synth).toHaveLength(8); expect(health.asym).toHaveLength(0); expect(health.single).toHaveLength(0);
    expect(packet).toContain('| Definitions showing "I2IDL synthesis supported by source evidence" | 8 |');
    expect(packet).toContain('1 authored proposal is excluded from the canonical provenance and health counts');
    expect(packet).toContain('[Competency framework](' + FRAMEWORK_IRI + ')');
    expect(packet).not.toContain(CANONICAL + 'competency-framework');
    const issue = api.upstreamIssue({ type: 'mapping', c: 'competency-framework', iri: 'urn:fixture:proposal', rec: { p: 'relatedMatch', o: 'https://purl.org/ctdlasn/terms/CompetencyFramework', w: 'A candidate relationship for review', m: 'ai-drafted', cf: 0.5 } }, { for: [], against: [], abstain: [] });
    const body = new URL(issue).searchParams.get('body');
    expect(body).toContain('Authored I2IDL-X proposal: Competency framework — ' + FRAMEWORK_IRI);
    expect(body).not.toContain(CANONICAL + 'competency-framework');
    type RenderedElement = { props: { children: unknown[]; className?: string; title?: string; table?: { rows: unknown[] } } };
    const elements: RenderedElement[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (node && typeof node === 'object' && 'props' in node) { const element = node as RenderedElement; elements.push(element); visit(element.props.children); }
    };
    visit(api.Insights({ route: {} }));
    expect(elements.find(e => e.props.className === 'hero-fig')!.props.children).toEqual([8]);
    expect(JSON.stringify(elements)).toContain('0 / 8');
    expect(elements.find(e => e.props.title === 'Evidence records by source')!.props.table!.rows).toHaveLength(0);
    expect(elements.find(e => e.props.title === 'Concepts by agentic kind')!.props.table!.rows).toEqual([['Framework', 8]]);
    expect(api.runLocal('provenance-profile', {}).rows).toEqual([['source-grounded', 0], ['synthesized', 8]]);
    expect(api.runLocal('concept-search', { text: 'competency framework' }).rows).toHaveLength(0);
    expect(api.runLocal('concepts-by-type', { type: 'type/framework' }).rows).toHaveLength(8);
    for (const query of ['concept-neighborhood', 'definition-evidence']) {
      const preview = api.runLocal(query, { concept: 'competency-framework' });
      expect(preview.rows).toHaveLength(0); expect(preview.note).toContain('authored I2IDL-X proposal');
    }
    expect(api.annotate('competency framework', true)).toEqual([[0, 20, 8]]);
    expect(api.annotate('competency framework', true, 'i2idl')).toEqual([[0, 10, 0]]);
    expect(api.annotate('competency framework', false, 'i2idl')).toEqual([]);
    elements.length = 0; visit(api.LayersModal({}));
    const layerCounts = elements.filter(e => e.props.className === 'tiny ll-n').map(e => e.props.children.join(' ')).join('\n');
    expect(layerCounts).toContain('8 concepts'); expect(layerCounts).toContain('8 provenance lines');
    expect(layerCounts).toContain('1 authored glossary proposals'); expect(layerCounts).not.toContain('9 concepts');
  });
  it('uses the same authored definition, origin, search result and directional inference in browser and server', async () => {
    await harness(async (data, config) => {
      const bundle = await build({ stdin: { contents: 'export * from "./data.js"; export { search } from "./search.js"; export { classify, snippetFor } from "./semantic.js"; export { citeText, citeBibtex } from "./lib.js"; export { render } from "./exports.js"; export { createWorld, callTool, worldTurtle } from "./orc/world.js";', resolveDir: resolve('applications/foxxi-content-intelligence/i2idlx/app/src') }, bundle: true, format: 'cjs', platform: 'browser', write: false });
      const browser: Record<string, any> = { module: { exports: {} }, document: { getElementById: () => ({ textContent: JSON.stringify(data) }) }, TextDecoder, TextEncoder, URL, console, window: {},
        React: { createContext: () => ({}), useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({}), useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useContext: () => null } };
      vm.runInNewContext(bundle.outputFiles[0]!.text, browser);
      const api = browser.module.exports;
      const serverData = await loadPublicTaskData(config);
      expect(JSON.stringify(api.C)).toBe(JSON.stringify(serverData.concepts));
      const hit = api.search('competency framework')[0].c;
      expect(hit.iri).toBe(FRAMEWORK_IRI); expect(hit.origin.kind).toBe('authored');
      expect(api.search('competency framework', 50, 'i2idl').some((r: { c: { id: string } }) => r.c.id === hit.id)).toBe(false);
      expect(api.conceptsForLens('i2idl')).toHaveLength(8); expect(api.conceptsForLens('x')).toHaveLength(9);
      expect(api.iriOf(hit.id)).toBe(FRAMEWORK_IRI); expect(api.snippetFor(hit.id)).toContain('<' + FRAMEWORK_IRI + '>');
      expect(api.LAYOUT.xy[hit.id]).toHaveLength(2);
      expect(api.shortestPaths('competency', 'competency-framework')).toEqual([['competency', 'competency-framework']]);
      expect(api.citeText(hit)).toContain('Authored I2IDL-X proposal');
      expect(api.citeBibtex(hit)).toContain('\n  author = {{Foxxi / I2IDL-X}}');
      expect(api.citeBibtex(hit)).not.toContain('\\n');
      const exported = JSON.parse(api.render('jsonld', { id: 'test', items: [{ id: hit.id }] }));
      expect(exported['skos:member'][0]['skos:inScheme']['@id']).toBe(NS + 'AuthoredConcepts');
      const ask = await executeClientTask(config, 'ask', { question: 'What is a competency framework?', concept_ids: ['competency-framework'] });
      const context = ask.context as Record<string, any>;
      expect(context.concepts.find((c: { id: string }) => c.id === hit.id)).toMatchObject({ iri: FRAMEWORK_IRI, definition: hit.d, origin: { kind: 'authored' }, glossaryStatus: 'Authored I2IDL-X proposal; not adopted upstream' });
      const execute = createSemanticTaskExecutor(config);
      const catalogResponse = await fetch(config.baseUrl + '/i2idlx/authored-catalog');
      expect(catalogResponse.status).toBe(200);
      const catalogBody = await catalogResponse.text(), catalog = JSON.parse(catalogBody);
      expect(catalogResponse.headers.get('etag')).toBe('"' + createHash('sha256').update(catalogBody).digest('hex') + '"');
      const rdfResponse = await fetch(catalog.rdf.href), rdf = await rdfResponse.text();
      const rdfHash = createHash('sha256').update(rdf).digest('hex');
      expect(rdfHash).toBe(catalog.rdf.sha256);
      expect(rdf).toContain(AUTHORED_CATALOG.concepts[0]!.definition);
      expect(rdf).toContain('rdfs:isDefinedBy'); expect(rdf).toContain('dct:rights'); expect(rdf).toContain('skos:related');
      expect(rdf).not.toMatch(/<https:\/\/purl.org\/ctdlasn\/terms\/CompetencyFramework>[^.]*subClassOf/);
      const shapesResponse = await fetch(config.baseUrl + '/i2idlx/authored-shapes.ttl');
      expect(shapesResponse.status).toBe(200); const servedShapes = await shapesResponse.text(); expect(servedShapes).toContain(FRAMEWORK_IRI);
      const shapesHash = createHash('sha256').update(servedShapes).digest('hex');
      expect(context.catalog.authored).toHaveLength(3);
      expect(authoredGlossaryAffordances).toHaveLength(3);
      for (const peer of AUTHORED_CATALOG.peerRestrictions) {
        const input = `<urn:fixture:framework> a <${peer.iri}> .`;
        const local = api.classify(input);
        const checked = await execute('classify', { graph_content: input });
        expect(checked.status).toBe(200);
        expect(local.resources[0].by.map((c: { c: string }) => c.c)).toContain('competency-framework');
        expect((checked.body.result as Record<string, any>).types).toContainEqual({ subject: 'urn:fixture:framework', type: MODEL });
      }
      const generic = `<urn:fixture:generic> <${NS}isClassifiedBy> <${FRAMEWORK_IRI}> .`;
      const result = await execute('classify', { graph_content: generic });
      expect((result.body.evidence as Record<string, unknown>).authored_graph_sha256).toBe(rdfHash);
      const types = (result.body.result as Record<string, any>).types.map((x: { type: string }) => x.type);
      expect(types).toContain(MODEL);
      for (const peer of AUTHORED_CATALOG.peerRestrictions) expect(types).not.toContain(peer.iri);
      expect(types).not.toContain('https://purl.org/ctdlasn/terms/CompetencyFramework');
      for (const iri of ['https://purl.org/ctdlasn/terms/CompetencyFramework', 'https://w3id.org/xapi/ontology#Statement', 'https://foreign.example/CompetencyFramework']) {
        expect(api.classify(`<urn:fixture:other> a <${iri}> .`).resources).toEqual([]);
        expect(((await execute('classify', { graph_content: `<urn:fixture:other> a <${iri}> .` })).body.result as Record<string, any>).types).toEqual([]);
      }
      for (const predicate of ['isClassifiedBy', 'aboutConcept']) {
        const type = predicate === 'aboutConcept' ? `a <${NS}UsageRecord> ;` : '';
        const valid = await execute('validate', { graph_content: `<urn:fixture:valid> ${type} <${NS + predicate}> <${FRAMEWORK_IRI}> .` });
        expect(valid.status).toBe(200); expect(valid.body.result).toMatchObject({ conforms: true, validation_applicable: true });
        expect((valid.body.evidence as Record<string, unknown>).effective_shape_sha256).toBe(shapesHash);
        const unknown = await execute('validate', { graph_content: `<urn:fixture:bad> ${type} <${NS + predicate}> <${NS}concept-forged> .` });
        expect(unknown.body.result).toMatchObject({ conforms: false });
      }
      expect((await execute('classify', { graph_content: `<urn:fixture:fake> <${NS}isClassifiedBy> <${CANONICAL}competency-framework> .` })).status).toBe(400);
      // The real Orchestrate page tools can read the authored definition and stage its exact IRI/profile.
      const world = api.createWorld();
      expect(world.records.get('ed-team').status).toBe('unclassified');
      const read = api.callTool(world, 'read_concepts', { ids: [FRAMEWORK_IRI] }, 'lexicographer');
      expect(read.ok).toBe(true); expect(read.result[0]).toMatchObject({ iri: FRAMEWORK_IRI, origin: { kind: 'authored' } });
      const framework = world.records.get('competency-framework');
      world.records = new Map([['competency-framework', framework]]); world.order = ['competency-framework'];
      const classified = api.callTool(world, 'classify_records', { items: [{ record: 'competency-framework', concepts: [FRAMEWORK_IRI], rationale: 'The source record describes the authored framework definition.' }] }, 'lexicographer');
      expect(classified.ok).toBe(true); expect(classified.result.errors).toBeUndefined();
      world.discovered.add('q-classify'); world.discovered.add('port-publish-classified');
      expect(api.callTool(world, 'run_classifier', {}, 'ontologist').result.clashes).toBe(0);
      expect(api.callTool(world, 'validate_publication', {}, 'conductor').result.ready).toBe(true);
      const staged = api.callTool(world, 'stage_publication', {}, 'conductor');
      expect(staged.ok).toBe(true);
      expect(world.staged[0].call).toMatchObject({ modal_status: 'Hypothetical', conforms_to_shapes: ['https://foxxi-bridge.interego.xwisee.com/i2idlx/authored-shapes.ttl'] });
      expect(world.staged[0].call.graph_content).toContain('<' + FRAMEWORK_IRI + '>');
      expect(world.staged[0].call.graph_content).not.toContain('i2idl:competency-framework');
      expect((await execute('validate', { graph_content: world.staged[0].call.graph_content })).body.result).toMatchObject({ conforms: true });
    });
  }, 60000);
});
