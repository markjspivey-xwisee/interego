import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { attachSemanticTaskRoutes, type SemanticTaskConfig } from '../src/i2idlx-semantic-tasks.js';
import { semanticAffordances, semanticCheckOperations } from '../src/i2idlx-semantic-affordances.js';
import { parseTurtle } from '../i2idlx/typescript/rdf.js';
import { shaclValidate } from '../i2idlx/typescript/validation.js';

const BASE = 'https://bridge.example', NS = BASE + '/ns/i2idlx#';
const CONCEPT = 'https://id.i2idl.org/concepts/', EX = 'https://example.org/academy/';
const RELEASE = 'v0.0.86', COMMIT = '9f865995d879165d8fa49422915a5e53d2ecebf9';
const PREFIXES = `@prefix i2x: <${NS}> .
@prefix i2idl: <${CONCEPT}> .
@prefix ex: <${EX}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
`;
const SHAPES = PREFIXES + `ex:ClassifiedRecordShape a sh:NodeShape ;
  sh:targetSubjectsOf i2x:isClassifiedBy ;
  sh:property [ sh:path rdfs:label ; sh:minCount 1 ] .`;
const VALID = PREFIXES + 'ex:scenario rdfs:label "Scenario materials" ; i2x:isClassifiedBy i2idl:resource .';
function fixture() {
  return {
    meta: { release: RELEASE, commit: COMMIT, iri: { ontology: BASE + '/ns/i2idlx' } },
    concepts: [
      { id: 'resource', l: 'Learning resource', d: 'Reusable material for learning.', rc: 'information' },
      { id: 'activity', l: 'Learning activity', d: 'An activity in which someone learns.', rc: 'process' },
    ],
    semantic: {
      disjoint: { 'information|process': { fixture: [EX + 'Resource', EX + 'Activity'] } },
      prefixes: { peer: 'https://example.org/peer/' }, labels: { 'peer:Credential': 'Credential' },
      snapshots: [{ key: 'peer', version: '2026-01', sha256: 'a'.repeat(64) }],
    },
    mappings: [{ id: 'credential-mapping', o: 'https://example.org/registry/Record', ol: 'Registry record', od: 'A published registry description.', v: 'Fixture registry' }],
    queries: [{ id: 'q-classify', sparql: `PREFIX i2x: <${NS}>
CONSTRUCT { ?record a ?class }
WHERE { ?record i2x:isClassifiedBy ?concept . ?concept i2x:fixtureClass ?class }` }],
  };
}
async function withServer(
  run: (base: string, dist: string) => Promise<void>,
  options: { config?: Partial<SemanticTaskConfig>; shapes?: string; data?: ReturnType<typeof fixture> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'i2idlx-semantic-test-'));
  await Promise.all([
    writeFile(join(dir, 'data.json'), JSON.stringify(options.data ?? fixture())),
    writeFile(join(dir, 'i2idlx.ttl'), PREFIXES + 'ex:Resource a owl:Class ; owl:disjointWith ex:Activity . ex:Activity a owl:Class .'),
    writeFile(join(dir, 'i2idlx-alignments.ttl'), PREFIXES + 'i2idl:resource i2x:fixtureClass ex:Resource .'),
    writeFile(join(dir, 'i2idlx-referents.ttl'), PREFIXES + 'i2idl:activity i2x:fixtureClass ex:Activity .'),
    writeFile(join(dir, 'i2idlx-shapes.ttl'), options.shapes ?? SHAPES),
  ]);
  const app = express(); app.use(express.json({ limit: '1mb' }));
  attachSemanticTaskRoutes(app, { baseUrl: BASE, appDataFile: join(dir, 'data.json'), distDirectory: dir, ...options.config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run('http://127.0.0.1:' + (server.address() as AddressInfo).port, dir); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
const call = (base: string, operation: string, args: unknown) => fetch(base + '/i2idlx/api/' + operation, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
});
const scheme = (release: string) => new Response(`<https://id.i2idl.org/scheme> <https://glossarystudio.app/ns/publicationVersion> ${JSON.stringify(release)} .`, {
  status: 200, headers: { 'Content-Type': 'text/turtle' },
});
function expectReadOnly(packet: Record<string, unknown>) {
  expect(packet).toMatchObject({ execution: 'deterministic-read-only', sampling_performed: false, writes_performed: false,
    source: { mode: 'pinned', release: RELEASE, commit: COMMIT } });
  expect(packet.me).toBeUndefined(); expect(packet.identity).toBeUndefined(); expect(packet.run).toBeUndefined();
}

describe('I2IDL-X deterministic semantic task operations', () => {
  it('advertises only the four implemented bounded read-only checks and their exact inputs', () => {
    const operations = semanticCheckOperations(BASE + '/');
    expect(Object.keys(operations)).toEqual(['classifier', 'shacl', 'peerTerm', 'sourceVersion']);
    expect(semanticAffordances).toHaveLength(4);
    for (const operation of semanticAffordances) {
      expect(operation.method).toBe('POST'); expect(operation.externallyRouted).toBe(true);
      expect(operation.annotations?.readOnlyHint).toBe(true); expect(operation.annotations?.destructiveHint).toBe(false);
      expect(Object.values(operations)).toContainEqual({ action: operation.action, href: operation.targetTemplate.replace('{base}', BASE), method: 'POST' });
    }
    expect(semanticAffordances.find(a => a.toolName === 'foxxi.i2idlx_classify')?.inputs.map(i => i.name)).toEqual(['graph_content']);
    expect(semanticAffordances.find(a => a.toolName === 'foxxi.i2idlx_peer_term')?.inputs.map(i => i.name)).toEqual(['iri']);
    expect(semanticAffordances.find(a => a.toolName === 'foxxi.i2idlx_source_version')?.inputs).toEqual([]);
  });
  it('executes fixed q-classify, catches a deliberate category clash, and checks the corrected graph', async () => {
    await withServer(async base => {
      const conflicted = PREFIXES + 'ex:combined rdfs:label "Combined record" ; i2x:isClassifiedBy i2idl:resource, i2idl:activity .';
      const initial = await call(base, 'classify', { graph_content: conflicted });
      expect(initial.status).toBe(200); expect(initial.headers.get('cache-control')).toBe('no-store');
      const packet = await initial.json(); expectReadOnly(packet);
      expect(packet.result.types).toEqual(expect.arrayContaining([{ subject: EX + 'combined', type: EX + 'Resource' }, { subject: EX + 'combined', type: EX + 'Activity' }]));
      expect(packet.result.clashes).toHaveLength(1);
      expect(packet.result.clashes[0]).toMatchObject({ subject: EX + 'combined', categories: ['information', 'process'] });
      expect(packet.result.modal_status).toBe('Hypothetical'); expect(packet.result.full_owl_consistency).toBe('not_run');
      expect(packet.evidence).toMatchObject({ query: 'q-classify', input_triples: 3, output_triples: 2 });
      expect(packet.evidence.concept_existence.every((r: { exists_in_snapshot: boolean }) => r.exists_in_snapshot)).toBe(true);
      for (const hash of Object.values(packet.evidence.graph_sha256)) expect(hash).toMatch(/^[a-f0-9]{64}$/);
      const corrected = PREFIXES + 'ex:materials rdfs:label "Materials" ; i2x:isClassifiedBy i2idl:resource . ex:session rdfs:label "Session" ; i2x:isClassifiedBy i2idl:activity .';
      const rerun = await call(base, 'classify', { graph_content: corrected }); expect(rerun.status).toBe(200);
      const fixed = await rerun.json();
      expect(fixed.result.clashes).toEqual([]); expect(fixed.result.types).toHaveLength(2);
      expect(fixed.result.types).toContainEqual({ subject: EX + 'materials', type: EX + 'Resource' });
      expect(fixed.result.types).toContainEqual({ subject: EX + 'session', type: EX + 'Activity' });
    });
  });
  it('runs SHACL against the trusted shapes and rejects a negative control', async () => {
    await withServer(async base => {
      const valid = await call(base, 'validate', { graph_content: VALID }); expect(valid.status).toBe(200);
      const packet = await valid.json(); expectReadOnly(packet);
      expect(packet.result).toMatchObject({ conforms: true, shacl_conforms: true, validation_applicable: true, publication_authorized: false, publication_performed: false, full_owl_consistency: 'not_run' });
      expect(packet.evidence).toMatchObject({ engine: 'existing I2IDL-X native SHACL Core', inference: 'rdfs', targeted_nodes: [EX + 'scenario'], targeted_node_count: 1, evaluated_shape_node_pairs: 1 });
      expect(packet.evidence.shape_sha256).toMatch(/^[a-f0-9]{64}$/);
      const invalid = await call(base, 'validate', { graph_content: PREFIXES + 'ex:missing-label i2x:isClassifiedBy i2idl:resource .' });
      expect(invalid.status).toBe(200);
      const rejected = await invalid.json();
      expect(rejected.result.conforms).toBe(false); expect(rejected.result.shacl_conforms).toBe(false);
      expect(rejected.result.violations).toContainEqual(expect.objectContaining({ focus: EX + 'missing-label', component: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent' }));
    });
  });
  it('returns inferred draft subjects separately from built-in classified services', async () => {
    await withServer(async (base, dir) => {
      await writeFile(join(dir, 'i2idlx-referents.ttl'), PREFIXES + 'i2idl:activity i2x:fixtureClass ex:Activity . ex:published-service i2x:isClassifiedBy i2idl:resource .');
      const response = await call(base, 'classify', { graph_content: VALID });
      expect(response.status).toBe(200);
      const packet = await response.json();
      expect(packet.result.types).toEqual([{ subject: EX + 'scenario', type: EX + 'Resource' }]);
      expect(packet.result.graph_content).not.toContain('published-service');
      expect(packet.evidence).toMatchObject({ output_triples: 1, dataset_output_triples: 2, output_scope: 'submitted draft subjects' });
    });
  });
  it('discloses vacuous conformance when the draft targets no publication shapes', async () => {
    await withServer(async base => {
      const response = await call(base, 'validate', { graph_content: PREFIXES + 'ex:unrelated rdfs:label "Unrelated record" .' });
      expect(response.status).toBe(200);
      const packet = await response.json(); expectReadOnly(packet);
      expect(packet.result).toMatchObject({ shacl_conforms: true, validation_applicable: false, publication_authorized: false });
      expect(packet.evidence).toMatchObject({ targeted_nodes: [], targeted_node_count: 0, evaluated_shape_node_pairs: 0 });
      expect(packet.result.applicability_note).toContain('vacuous');
    });
  });
  it('does not count pinned ontology targets as validation of the submitted draft', async () => {
    const shapes = SHAPES + '\nex:OntologyTermShape a sh:NodeShape ; sh:targetClass ex:VocabularyTerm ; sh:property [ sh:path rdfs:label ; sh:minCount 1 ] .';
    await withServer(async (base, dist) => {
      await writeFile(join(dist, 'i2idlx.ttl'), PREFIXES + 'ex:pinned-term a ex:VocabularyTerm ; rdfs:label "Pinned vocabulary term" .');
      const unrelated = await call(base, 'validate', { graph_content: PREFIXES + 'ex:unrelated rdfs:label "Unrelated record" .' });
      expect(unrelated.status).toBe(200);
      const vacuous = await unrelated.json();
      expect(vacuous.result).toMatchObject({ conforms: true, shacl_conforms: true, validation_applicable: false });
      expect(vacuous.evidence).toMatchObject({ targeted_nodes: [], targeted_node_count: 0,
        evaluated_shape_node_pairs: 0, applied_targets: [], total_evaluated_shape_node_pairs: 1 });
      const classified = await call(base, 'validate', { graph_content: VALID });
      expect(classified.status).toBe(200);
      const applicable = await classified.json();
      expect(applicable.result.validation_applicable).toBe(true);
      expect(applicable.evidence).toMatchObject({ targeted_nodes: [EX + 'scenario'], targeted_node_count: 1,
        evaluated_shape_node_pairs: 1, total_evaluated_shape_node_pairs: 2,
        applied_targets: [{ focus: EX + 'scenario', shape: EX + 'ClassifiedRecordShape' }] });
    }, { shapes });
  });
  it('reports only shape-node root pairs actually evaluated, excluding deactivated roots', async () => {
    const shapes = SHAPES + '\nex:Deactivated a sh:NodeShape ; sh:targetNode ex:ignored ; sh:deactivated true ; sh:property [ sh:path rdfs:label ; sh:minCount 1 ] .';
    const report = await shaclValidate(parseTurtle(VALID), parseTurtle(shapes));
    expect(report.conforms).toBe(true); expect(report.results).toEqual([]);
    expect(report.targets.map(target => ({ focus: target.focusNode.value, shape: target.sourceShape.value }))).toEqual([{ focus: EX + 'scenario', shape: EX + 'ClassifiedRecordShape' }]);
    expect(report.text).toBe('Validation Report\nConforms: true\n');
    expect(report.report.size).toBe(2);
  });
  it('checks actual glossary membership rather than accepting a canonical-looking unknown IRI', async () => {
    await withServer(async base => {
      const unknown = PREFIXES + 'ex:unknown rdfs:label "Unknown" ; i2x:isClassifiedBy i2idl:not-in-the-glossary .';
      const classify = await call(base, 'classify', { graph_content: unknown }); expect(classify.status).toBe(400);
      const refusal = await classify.json(); expect(refusal.result).toBeUndefined(); expect(refusal.error).toContain('not present in the pinned glossary');
      const validate = await call(base, 'validate', { graph_content: unknown }); expect(validate.status).toBe(200);
      const packet = await validate.json();
      expect(packet.result).toMatchObject({ conforms: false, shacl_conforms: true });
      expect(packet.result.unknown_concepts).toContainEqual({ subject: EX + 'unknown', concept: CONCEPT + 'not-in-the-glossary', exists_in_snapshot: false });
      expect(packet.evidence.concept_existence[0].exists_in_snapshot).toBe(false);
    });
  });
  it('checks concepts inferred through trusted build graphs, not just explicit draft links', async () => {
    const data = fixture();
    data.queries[0]!.sparql = `PREFIX i2x: <${NS}>
CONSTRUCT { ?record i2x:isClassifiedBy ?concept }
WHERE { ?record a ?peer . ?peer i2x:fixtureConcept ?concept }`;
    await withServer(async (base, dist) => {
      await writeFile(join(dist, 'i2idlx-alignments.ttl'), PREFIXES + 'ex:Peer i2x:fixtureConcept i2idl:not-in-the-glossary .');
      const classify = await call(base, 'classify', { graph_content: PREFIXES + 'ex:record a ex:Peer .' });
      expect(classify.status).toBe(400);
      const refused = await classify.json();
      expect(refused.result).toBeUndefined(); expect(refused.error).toContain('inferred classified concept');
      await writeFile(join(dist, 'i2idlx.ttl'), PREFIXES + 'ex:trusted-classification rdfs:subPropertyOf i2x:isClassifiedBy .');
      const validate = await call(base, 'validate', { graph_content: PREFIXES + 'ex:record rdfs:label "Record" ; ex:trusted-classification i2idl:not-in-the-glossary .' });
      expect(validate.status).toBe(200);
      const checked = await validate.json();
      expect(checked.result).toMatchObject({ conforms: false, shacl_conforms: true, validation_applicable: true });
      expect(checked.result.unknown_concepts).toContainEqual({ subject: EX + 'record', concept: CONCEPT + 'not-in-the-glossary', exists_in_snapshot: false });
    }, { data });
  });
  it('rejects caller schema before running classification or RDFS validation', async () => {
    const attacks = [
      'ex:property rdfs:subPropertyOf i2x:isClassifiedBy . ex:record ex:property i2idl:not-in-the-glossary .',
      'ex:record a ex:Peer . ex:Peer owl:equivalentClass ex:Bridge . ex:Bridge owl:onProperty i2x:isClassifiedBy ; owl:hasValue i2idl:not-in-the-glossary . i2idl:not-in-the-glossary i2x:referentCategory ex:process .',
      'ex:a rdfs:subPropertyOf ex:b . ex:b rdfs:subPropertyOf ex:a .',
      'ex:a rdfs:subClassOf ex:b . ex:b rdfs:subClassOf ex:a .',
      'ex:property a rdf:Property .',
      'ex:class a rdfs:Class .',
      'ex:class a owl:Class .',
      'i2idl:resource i2x:referentCategory ex:forged-category . ex:forged-category i2x:referentClass ex:ForgedType . ex:record i2x:isClassifiedBy i2idl:resource .',
    ];
    await withServer(async base => {
      for (const operation of ['classify', 'validate']) for (const attack of attacks) {
        const response = await call(base, operation, { graph_content: PREFIXES + attack });
        expect(response.status).toBe(400);
        const refusal = await response.json();
        expect(refusal).toMatchObject({ status: 'unavailable', sampling_performed: false, writes_performed: false });
        expect(refusal.error).toContain('instance statements only'); expect(refusal.result).toBeUndefined();
      }
    });
  });
  it('fails closed when configured shapes use an unsupported validation feature', async () => {
    await withServer(async base => {
      const response = await call(base, 'validate', { graph_content: VALID }); expect(response.status).toBe(503);
      const packet = await response.json();
      expect(packet).toMatchObject({ status: 'unavailable', sampling_performed: false, writes_performed: false });
      expect(packet.result).toBeUndefined(); expect(packet.conforms).toBeUndefined();
    }, { shapes: PREFIXES + 'ex:Unsupported a sh:NodeShape ; sh:targetSubjectsOf i2x:isClassifiedBy ; sh:sparql [ sh:select "SELECT ?this WHERE {}" ] .' });
  });
  it('rejects remote paths, URLs, custom queries and malformed or excessive inline input', async () => {
    const fetcher = vi.fn(async () => { throw new Error('Unexpected network fetch'); });
    await withServer(async base => {
      for (const operation of ['classify', 'validate']) {
        for (const args of [{ graph_content: VALID, url: 'http://127.0.0.1/private' }, { graph_content: VALID, path: 'C:\\private.ttl' },
          { graph_content: VALID, query: 'SELECT * WHERE {}' }, { graph_content: VALID, shapes: SHAPES }, { graph_content: 'not Turtle' }, { graph_content: 'x'.repeat(64001) }]) {
          const response = await call(base, operation, args); expect(response.status).toBe(400);
          expect((await response.json()).result).toBeUndefined();
        }
      }
      expect((await call(base, 'classify', { graph_content: PREFIXES + Array.from({ length: 513 }, (_, i) => 'ex:s' + i + ' rdfs:label "x" .').join('\n') })).status).toBe(413);
      expect((await call(base, 'source-version', { url: 'https://example.org/attacker' })).status).toBe(400);
      expect((await call(base, 'peer-term', { iri: 'file:///private.ttl' })).status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    }, { config: { fetch: fetcher as typeof fetch } });
  });
  it('looks up exact pinned peer evidence and treats misses as unconfirmed without fetching', async () => {
    const fetcher = vi.fn(async () => { throw new Error('Peer lookup must not fetch'); });
    await withServer(async base => {
      const exact = await call(base, 'peer-term', { iri: 'https://example.org/peer/Credential' }); expect(exact.status).toBe(200);
      const packet = await exact.json(); expectReadOnly(packet);
      expect(packet.result).toMatchObject({ confirmed_in_snapshot: true, term: { label: 'Credential', source: 'pinned publisher-label index' } });
      expect(packet.evidence.network_fetch_performed).toBe(false);
      const mapping = await (await call(base, 'peer-term', { iri: 'https://example.org/registry/Record' })).json();
      expect(mapping.result.term).toMatchObject({ label: 'Registry record', definition: 'A published registry description.', source: 'pinned mapping target' });
      const missing = await (await call(base, 'peer-term', { iri: 'https://example.org/peer/credential' })).json();
      expect(missing.result).toMatchObject({ confirmed_in_snapshot: false, term: null, meaning_of_miss: 'unconfirmed in pinned evidence; not proof of nonexistence' });
      expect(fetcher).not.toHaveBeenCalled();
    }, { config: { fetch: fetcher as typeof fetch } });
  });
  it('compares an actual canonical response with the pin and retains a mismatch without upgrading', async () => {
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValueOnce(scheme(RELEASE)).mockResolvedValueOnce(scheme('v0.0.93'));
    await withServer(async base => {
      const matched = await call(base, 'source-version', {}); expect(matched.status).toBe(200);
      const packet = await matched.json(); expectReadOnly(packet);
      expect(packet.result).toMatchObject({ pinned_release: RELEASE, upstream_release: RELEASE, matches: true, reconciliation: 'same_release', automatically_upgraded: false });
      expect(packet.source.upstream_freshness).toBe('checked');
      expect(packet.evidence).toMatchObject({ source_url: 'https://id.i2idl.org/scheme.ttl', http_status: 200 });
      expect(packet.evidence.sha256).toMatch(/^[a-f0-9]{64}$/); expect(Number.isFinite(Date.parse(packet.evidence.checked_at))).toBe(true);
      const mismatch = await (await call(base, 'source-version', {})).json();
      expect(mismatch.result).toMatchObject({ pinned_release: RELEASE, upstream_release: 'v0.0.93', matches: false, reconciliation: 'review_required', automatically_upgraded: false });
      expect(mismatch.source.release).toBe(RELEASE);
      expect(mismatch.source.upstream_freshness).toBe('checked');
      expect(fetcher).toHaveBeenCalledTimes(2);
      for (const [url, init] of fetcher.mock.calls) { expect(url).toBe('https://id.i2idl.org/scheme.ttl'); expect(init?.redirect).toBe('error'); }
    }, { config: { fetch: fetcher } });
  });
  it('reports upstream outages as unavailable with no invented version comparison', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('unavailable', { status: 503 })).mockRejectedValueOnce(new Error('Connection failed'));
    await withServer(async base => {
      for (let i = 0; i < 2; i++) {
        const response = await call(base, 'source-version', {}); expect(response.status).toBe(503);
        const packet = await response.json(); expect(packet).toMatchObject({ status: 'unavailable', sampling_performed: false, writes_performed: false });
        expect(packet.result).toBeUndefined(); expect(packet.matches).toBeUndefined();
      }
    }, { config: { fetch: fetcher } });
  });
  it('does not turn an optional unsigned relay envelope into an identity claim', async () => {
    await withServer(async base => {
      const response = await call(base, 'validate', { _signed_payload: JSON.stringify({ graph_content: VALID, agent_id: 'forged-did', timestamp: new Date().toISOString() }), _signature: 'invalid-proof' });
      expect(response.status).toBe(200);
      const packet = await response.json(); expectReadOnly(packet);
      expect(packet.result.conforms).toBe(true); expect(JSON.stringify(packet)).not.toContain('forged-did');
    });
  });
});
