import { describe, it, expect, vi } from 'vitest';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryEngine } from '@comunica/query-sparql';
import { createClassifierConstruct } from '../src/i2idlx-classifier-construct.js';
import { createSemanticTaskExecutor } from '../src/i2idlx-semantic-tasks.js';
import { DataFactory, Store, parseTurtle, union, RDF } from '../i2idlx/typescript/rdf.js';
import { canonical } from './support/ns-graph.js';

const BASE = 'https://bridge.example', NS = BASE + '/ns/i2idlx#';
const C = 'https://id.i2idl.org/concepts/', EX = 'https://example.org/fixture/';
const XAPI = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const SOURCE_ID = 'i2idlx-classifier';
const named = DataFactory.namedNode, blank = DataFactory.blankNode;
const canonicalStore = (graph: Store) => canonical([...graph].map(q => DataFactory.quad(q.subject, q.predicate, q.object, q.graph)));
const simpleQuery = `CONSTRUCT { ?thing a ?class; <${EX}classified> ?concept; <${EX}link> ?link }
WHERE { ?thing <${EX}classified> ?concept . ?concept <${EX}class> ?class . OPTIONAL { ?thing <${EX}link> ?link } }`;

interface Packet {
  result: { graph_content: string; types: { subject: string; type: string }[]; clashes: unknown[] };
  evidence: { input_triples: number; closure: { converged: boolean; passes: number; max_passes: number }; concept_existence: { subject: string; concept: string }[] };
}
// This small taxonomy isolates the identity regression. Full unchanged producer
// graphs and the actual pinned query run here; full release-data proof is separate.
async function withFixture(run: (execute: ReturnType<typeof createSemanticTaskExecutor>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'i2idlx-blank-identity-'));
  const stored = await readFile(new URL('../i2idlx/src/queries/stored/10-classify.rq', import.meta.url), 'utf8');
  // The builder puts the executable query, rather than its metadata header, in app data.
  const query = stored.slice(stored.indexOf('PREFIX ')).replaceAll('{{NS}}', NS);
  const data = { meta: { release: 'fixture', commit: '0'.repeat(40), iri: { ontology: BASE + '/ns/i2idlx' } },
    concepts: ['resource', 'xapi-statement', 'learning-record'].map(id => ({ id, l: id, d: 'Bounded identity fixture concept.', rc: 'information' })),
    semantic: { disjoint: {} }, queries: [{ id: 'q-classify', sparql: query }] };
  const prefix = `@prefix i2x:<${NS}>. @prefix c:<${C}>. @prefix ex:<${EX}>. @prefix owl:<http://www.w3.org/2002/07/owl#>. @prefix rdfs:<http://www.w3.org/2000/01/rdf-schema#>.`;
  const bridge = (peer: string, concept: string) => `<${XAPI + peer}> rdfs:subClassOf [ a owl:Restriction; owl:onProperty i2x:isClassifiedBy; owl:hasValue c:${concept} ].`;
  const taxonomy = [prefix,
    ...['resource', 'xapi-statement', 'learning-record'].map(id => `c:${id} i2x:referentCategory ex:category.`),
    'ex:category i2x:referentClass ex:Information. ex:Information rdfs:subClassOf ex:Base.',
    bridge('Statement', 'xapi-statement'), bridge('Statement', 'learning-record'),
    ...['Agent', 'Verb', 'Activity', 'Context', 'Result', 'Score'].map(peer => bridge(peer, 'resource')),
  ].join('\n');
  // Fail at fixture creation if its trusted data is malformed, rather than hiding
  // that setup error behind the executor's deliberately opaque public refusal.
  parseTurtle(taxonomy);
  try {
    await Promise.all([
      writeFile(join(dir, 'data.json'), JSON.stringify(data)), writeFile(join(dir, 'i2idlx.ttl'), taxonomy),
      ...['i2idlx-alignments.ttl', 'i2idlx-referents.ttl', 'i2idlx-shapes.ttl'].map(file => writeFile(join(dir, file), prefix)),
    ]);
    await run(createSemanticTaskExecutor({ baseUrl: BASE, appDataFile: join(dir, 'data.json'), distDirectory: dir,
      fetch: async () => { throw new Error('No network permitted'); } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('classifier source blank identity', () => {
  it('preserves distinct original labels and links while leaving reserved-prefix named IRIs unchanged', async () => {
    const reserved = `urn:comunica_skolem:source_${SOURCE_ID}:original`;
    const graph = parseTurtle(`@prefix ex:<${EX}>.
_:original ex:classified ex:Concept; ex:link <${reserved}>.
_:bc_i2idlx-classifier_original ex:classified ex:Concept; ex:link _:original.
<${reserved}> ex:classified ex:Concept. ex:Concept ex:class ex:Class.`);
    const originalBlanks = [...new Set([...graph].filter(q => q.subject.termType === 'BlankNode').map(q => q.subject.value))].sort();
    const pass = createClassifierConstruct(graph), first = await pass(simpleQuery);
    expect([...new Set([...first].filter(q => q.subject.termType === 'BlankNode').map(q => q.subject.value))].sort()).toEqual(originalBlanks);
    expect(first.getQuads(named(reserved), named(RDF + 'type'), named(EX + 'Class'), null)).toHaveLength(1);
    expect(first.getQuads(null, named(EX + 'link'), named(reserved), null)).toHaveLength(1);
    const blankLink = first.getQuads(null, named(EX + 'link'), null, null).find(q => q.object.termType === 'BlankNode');
    expect(blankLink).toBeDefined(); expect(blankLink!.subject.equals(blankLink!.object)).toBe(false);
    graph.addQuads([...first]); const size = graph.size;
    graph.addQuads([...await pass(simpleQuery)]);
    expect(graph.size).toBe(size);
  });

  it('refuses wrong or unknown source-scoped identities instead of collapsing them', async () => {
    const graph = parseTurtle(`<${EX}record> <${EX}classified> <${EX}Concept>.`);
    for (const skolemized of [`urn:comunica_skolem:source_${SOURCE_ID}:unknown`, 'urn:comunica_skolem:source_other:unknown']) {
      const scoped = Object.assign(blank('scoped'), { skolemized: named(skolemized) });
      const mock = vi.spyOn(QueryEngine.prototype, 'queryQuads').mockResolvedValue({
        toArray: async () => [DataFactory.quad(scoped, named(RDF + 'type'), named(EX + 'Class'))],
      } as unknown as Awaited<ReturnType<QueryEngine['queryQuads']>>);
      try { await expect(createClassifierConstruct(graph)(simpleQuery)).rejects.toThrow('outside its source scope'); }
      finally { mock.mockRestore(); }
    }
  });

  it('retains genuinely fresh BNODE outputs, so the existing nonconvergence guard can reject them', async () => {
    const graph = parseTurtle(`<${EX}record> <${EX}classified> <${EX}Concept>.`), pass = createClassifierConstruct(graph);
    const query = `CONSTRUCT { ?thing <${EX}fresh> ?fresh } WHERE { ?thing <${EX}classified> ?concept. BIND(BNODE() AS ?fresh) }`;
    const sizes = [graph.size];
    for (let i = 0; i < 3; i++) { graph.addQuads([...await pass(query)]); sizes.push(graph.size); }
    expect(sizes).toEqual([1, 2, 3, 4]);
  });

  for (const fixture of [
    { file: 'pgsl-browser.ttl', triples: 23, records: 1, hash: '9a4fe3c84f66ae33db4f1c46d7d5a12a994a0d6a189aaad882b29cbc813aa7bc' },
    { file: 'tla-multi-agent.ttl', triples: 127, records: 5, hash: '5672ebc637e8ec4f9adcecc8a7aaa022a652135efb915ce51e6631c4c837b1bd' },
  ]) it(`closes the complete ${fixture.triples}-triple ${fixture.file} graph and preserves blank topology across requests`, async () => {
    const carrier = fixture.file === 'pgsl-browser.ttl' ? 'pgsl-browser.json' : fixture.file;
    const raw = await readFile(new URL('./fixtures/classifier-producers/' + carrier, import.meta.url), 'utf8');
    // The packet retains the producer's exact whitespace without adding trailing
    // whitespace to a tracked source fixture. The original byte digest still binds it.
    const content: string = carrier.endsWith('.json') ? (JSON.parse(raw) as { turtle: string }).turtle : raw;
    expect(createHash('sha256').update(content).digest('hex')).toBe(fixture.hash);
    const input = parseTurtle(content); expect(input.size).toBe(fixture.triples);
    const inputBlankSubjects = new Set([...input].filter(q => q.subject.termType === 'BlankNode').map(q => q.subject.value));
    await withFixture(async execute => {
      const first = await execute('classify', { graph_content: content }); expect(first.status, JSON.stringify(first.body)).toBe(200);
      const packet = first.body as unknown as Packet;
      expect(packet.evidence.input_triples).toBe(fixture.triples);
      expect(packet.evidence.closure).toMatchObject({ converged: true, passes: 2, max_passes: 32 });
      expect(packet.result.clashes).toEqual([]);
      const output = parseTurtle(packet.result.graph_content);
      expect(new Set([...output].filter(q => q.subject.termType === 'BlankNode').map(q => q.subject.value)).size).toBe(inputBlankSubjects.size);
      const records = input.getQuads(null, named(RDF + 'type'), named(XAPI + 'Statement'), null).map(q => q.subject.value);
      expect(records).toHaveLength(fixture.records);
      for (const record of records) expect(packet.evidence.concept_existence.filter(r => r.subject === record).map(r => r.concept).sort()).toEqual([C + 'learning-record', C + 'xapi-statement']);
      const repeat = await execute('classify', { graph_content: content }); expect(repeat.status).toBe(200);
      expect(await canonicalStore(parseTurtle((repeat.body as unknown as Packet).result.graph_content))).toBe(await canonicalStore(output));
      // A separate parse changes the source blank labels without changing its RDF meaning.
      const renamed = union(input), rename = new Map([...inputBlankSubjects].map((label, i) => [label, blank('alpha' + i)]));
      const alpha = new Store([...renamed].map(q => DataFactory.quad(
        q.subject.termType === 'BlankNode' ? rename.get(q.subject.value)! : q.subject, q.predicate,
        q.object.termType === 'BlankNode' ? rename.get(q.object.value)! : q.object, q.graph,
      )));
      const { Writer } = await import('n3');
      const alphaContent = new Writer({ format: 'Turtle' }).quadsToString([...alpha]);
      expect(await canonicalStore(alpha)).toBe(await canonicalStore(input));
      const alphaResult = await execute('classify', { graph_content: alphaContent }); expect(alphaResult.status).toBe(200);
      expect(await canonicalStore(parseTurtle((alphaResult.body as unknown as Packet).result.graph_content))).toBe(await canonicalStore(output));
    });
  });
});
