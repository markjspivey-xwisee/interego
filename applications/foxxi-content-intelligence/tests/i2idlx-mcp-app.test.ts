import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenLoopback } from '../../_shared/vertical-bridge/listen-loopback.js';
import { attachClientTaskRoutes } from '../src/i2idlx-client-tasks.js';
import { attachSemanticTaskRoutes } from '../src/i2idlx-semantic-tasks.js';
import { semanticCheckOperations } from '../src/i2idlx-semantic-affordances.js';
import { attachI2idlxMcpApp, I2IDLX_APP_RESOURCE, I2IDLX_APP_MIME, type I2idlxMcpAppConfig } from '../src/i2idlx-mcp-app.js';

const BASE = 'https://bridge.example', NS = BASE + '/ns/i2idlx#', EX = 'https://example.org/academy/';
const COMMIT = '0754254be64f0562bab7e68d69583f2cc90aa945';
const P = `@prefix i2x: <${NS}> . @prefix i2idl: <https://id.i2idl.org/concepts/> .
@prefix ex: <${EX}> . @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .\n`;
const VALID = P + 'ex:materials rdfs:label "Materials" ; i2x:isClassifiedBy i2idl:resource .';
const CONFLICT = P + 'ex:mixed rdfs:label "Mixed" ; i2x:isClassifiedBy i2idl:resource, i2idl:activity .';
function fixture() {
  return {
    meta: { release: 'v0.0.93', commit: COMMIT, built: '2026-10-19T00:00:00Z', iri: { ontology: BASE + '/ns/i2idlx' },
      scheme: { title: 'Fixture glossary', rights: 'CC BY 4.0' }, license: { holder: 'Publisher fixture', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' } },
    concepts: [
      { id: 'resource', l: 'Learning resource', d: 'Exact reusable learning materials definition.', rc: 'information', a: [], f: [], b: [], n: [], r: [], ev: [] },
      { id: 'activity', l: 'Learning activity', d: 'Exact live learning activity definition.', rc: 'process', a: [], f: [], b: [], n: [], r: [], ev: [] },
    ],
    semantic: { disjoint: { 'information|process': { fixture: [EX + 'Resource', EX + 'Activity'] } },
      prefixes: { peer: 'https://example.org/peer/' }, labels: { 'peer:Credential': 'Credential' }, categories: [], snapshots: [] },
    queries: [{ id: 'q-classify', sparql: `PREFIX i2x: <${NS}>\nCONSTRUCT { ?record a ?class } WHERE { ?record i2x:isClassifiedBy ?concept . ?concept i2x:fixtureClass ?class }` }],
    sources: [], roles: [], actions: {}, mappings: [], enactments: [], ports: [],
  };
}
const page = (data: ReturnType<typeof fixture>) => '<!doctype html><html><head></head><body><div id="root"></div><script id="i2-data" type="application/json">' + JSON.stringify(data) + '</script><script>window.__APP_URL__="old-origin";</script><script>window.testAppBundle=true;</script></body></html>';
const scheme = () => new Response('<https://id.i2idl.org/scheme> <https://glossarystudio.app/ns/publicationVersion> "v0.0.93" .', { headers: { 'Content-Type': 'text/turtle' } });
async function withServer(run: (base: string, directory: string) => Promise<void>, overrides: Partial<I2idlxMcpAppConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'i2idlx-mcp-app-')), data = fixture();
  await Promise.all([
    writeFile(join(directory, 'data.json'), JSON.stringify(data)), writeFile(join(directory, 'app.html'), page(data)),
    writeFile(join(directory, 'i2idlx.ttl'), P + 'ex:Resource a owl:Class . ex:Activity a owl:Class .'),
    writeFile(join(directory, 'i2idlx-alignments.ttl'), P + 'i2idl:resource i2x:fixtureClass ex:Resource .'),
    writeFile(join(directory, 'i2idlx-referents.ttl'), P + 'i2idl:activity i2x:fixtureClass ex:Activity .'),
    writeFile(join(directory, 'i2idlx-shapes.ttl'), P + 'ex:RecordShape a sh:NodeShape ; sh:targetSubjectsOf i2x:isClassifiedBy ; sh:property [ sh:path rdfs:label ; sh:minCount 1 ] .'),
  ]);
  const app = express(); app.use(express.json({ limit: '1mb' }));
  // Compose the real Foxxi auth middleware shape: injected fields must not break MCP or confer identity.
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
      if (req.body.method === 'tools/call' && req.body.params) req.body.params.arguments = { ...req.body.params.arguments, __client_ip: '127.0.0.1', __caller_token: 'not-an-app-identity' };
      req.body.__client_ip = '127.0.0.1'; req.body.__caller_token = 'not-an-app-identity';
    }
    next();
  });
  app.post('/mcp', (_req, res) => { res.json({ original: true }); });
  const config = { baseUrl: BASE, siteDirectory: directory, distDirectory: directory, appDataFile: join(directory, 'data.json'), fetch: vi.fn(async () => scheme()) as typeof fetch, ...overrides };
  attachClientTaskRoutes(app, { ...config, checkOperations: semanticCheckOperations(BASE) });
  attachSemanticTaskRoutes(app, config); attachI2idlxMcpApp(app, config);
  const listener = await listenLoopback(app);
  try { await run(listener.base, directory); }
  finally { await listener.close(); await rm(directory, { recursive: true, force: true }); }
}
// Wire assertions intentionally inspect the actual protocol response rather than an in-process handler double.
async function rpc(base: string, method: string, params: Record<string, unknown> = {}, modern = false) {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const response = await fetch(base + '/i2idlx/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(modern ? { 'Mcp-Method': method } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, ...(modern ? { _meta: meta } : {}) } }) });
  return { status: response.status, type: response.headers.get('content-type'), body: await response.json() };
}
const call = (base: string, name: string, args: Record<string, unknown> = {}) => rpc(base, 'tools/call', { name, arguments: args });

describe('Interpretant dedicated ChatGPT MCP App', () => {
  it('serves legacy initialization and modern discovery without changing the original MCP endpoint', async () => {
    await withServer(async base => {
      const initialize = await rpc(base, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      expect(initialize.status).toBe(200); expect(initialize.body.result.capabilities).toMatchObject({ tools: {}, resources: {} });
      const discovery = await rpc(base, 'server/discover', {}, true);
      expect(discovery.status).toBe(200); expect(discovery.body.result.supportedVersions).toContain('2026-07-28');
      const original = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(await original.json()).toEqual({ original: true });
    });
  });
  it('advertises eight bounded read-only tools with actual widget, visibility and entrypoint metadata in both eras', async () => {
    await withServer(async base => {
      const legacy = await rpc(base, 'tools/list'), modern = await rpc(base, 'tools/list', {}, true);
      expect(legacy.status).toBe(200); expect(legacy.type).toContain('application/json');
      expect(legacy.body.result.tools).toHaveLength(8); expect(modern.body.result.tools).toEqual(legacy.body.result.tools);
      for (const tool of legacy.body.result.tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool._meta.ui.visibility).toEqual(['model', 'app']);
        expect(tool._meta.securitySchemes).toEqual([{ type: 'noauth' }]);
        if (tool.name === 'i2idlx_workbench') {
          expect(tool._meta.ui.resourceUri).toBe(I2IDLX_APP_RESOURCE);
          expect(tool._meta['openai/outputTemplate']).toBe(I2IDLX_APP_RESOURCE);
          expect(tool._meta['openai/ui'].entrypoints).toEqual([{ type: 'global' }, { type: 'thread' }]);
        } else {
          expect(tool._meta.ui.resourceUri).toBeUndefined(); expect(tool._meta['openai/outputTemplate']).toBeUndefined();
          expect(tool._meta['openai/widgetAccessible']).toBeUndefined(); expect(tool._meta['openai/ui']).toBeUndefined();
        }
      }
      expect((await call(base, 'i2idlx_workbench')).body.result.structuredContent).toMatchObject({ task: 'workbench', source: { release: 'v0.0.93', commit: COMMIT }, sampling_performed: false, writes_performed: false });
    });
  });
  it('serves the original GUI bytes with host flags before the app bundle and explicit CSP/display modes', async () => {
    await withServer(async base => {
      const listed = await rpc(base, 'resources/list'); expect(listed.body.result.resources[0]).toMatchObject({ uri: I2IDLX_APP_RESOURCE, mimeType: I2IDLX_APP_MIME });
      const read = await rpc(base, 'resources/read', { uri: I2IDLX_APP_RESOURCE }), resource = read.body.result.contents[0];
      expect(resource.mimeType).toBe(I2IDLX_APP_MIME); expect(resource.text).toContain('Exact reusable learning materials definition.');
      expect(resource.text.indexOf('window.__I2IDLX_CHATGPT_APP__=true')).toBeGreaterThan(resource.text.indexOf('window.__APP_URL__="old-origin"'));
      expect(resource.text.indexOf('window.__I2IDLX_CHATGPT_APP__=true')).toBeLessThan(resource.text.indexOf('window.testAppBundle=true'));
      expect(resource._meta.ui.csp.connectDomains).toEqual([BASE]);
      expect(resource._meta['openai/ui']).toMatchObject({ availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' });
      expect((await rpc(base, 'resources/read', { uri: 'file:///etc/passwd' })).body.error.code).toBe(-32602);
    });
  });
  it('refuses unavailable and mismatched source builds instead of rendering a placeholder', async () => {
    await withServer(async (base, directory) => {
      const old = fixture(); old.meta.release = 'v0.0.86'; await writeFile(join(directory, 'app.html'), page(old));
      expect((await rpc(base, 'resources/read', { uri: I2IDLX_APP_RESOURCE })).body.error.code).toBe(-32603);
      const changed = fixture(); changed.concepts[0]!.d = 'A substituted definition under the same source pin.';
      await writeFile(join(directory, 'app.html'), page(changed));
      expect((await rpc(base, 'resources/read', { uri: I2IDLX_APP_RESOURCE })).body.error.code).toBe(-32603);
      await writeFile(join(directory, 'data.json'), '{}');
      expect((await call(base, 'i2idlx_workbench')).body.result.isError).toBe(true);
    });
  });
  it('returns real Ask context and pending Orchestrate recipe with no server model, private data or completed run', async () => {
    await withServer(async base => {
      const ask = await call(base, 'i2idlx_ask', { question: 'Explain learning resources.', concept_ids: ['resource'] });
      expect(ask.body.result.structuredContent).toMatchObject({ task: 'ask', execution: 'client-required', status: 'instructions-only', sampling_performed: false, writes_performed: false });
      expect(ask.body.result.structuredContent.context.concepts[0].definition).toBe('Exact reusable learning materials definition.');
      expect(ask.body.result.structuredContent.instructions).toContain('[[concept-id]]');
      const orchestration = await call(base, 'i2idlx_orchestrate', { example: true }), recipe = orchestration.body.result.structuredContent;
      expect(recipe.execution).toBe('client-required'); expect(recipe.workflow.roles).toHaveLength(8); expect(recipe.workflow.steps).toHaveLength(12);
      expect(recipe.workflow.ledger.checks.every((check: { status: string }) => check.status === 'pending')).toBe(true);
      expect(recipe.answer).toBeUndefined(); expect(recipe.run).toBeUndefined(); expect(recipe.identity).toBeUndefined();
    });
  });
  it('preserves the exact REST and MCP Ask payload and bounds searches', async () => {
    await withServer(async base => {
      const args = { question: 'Explain resources.', concept_ids: ['resource'] };
      const rest = await fetch(base + '/i2idlx/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
      expect((await call(base, 'i2idlx_ask', args)).body.result.structuredContent).toEqual(await rest.json());
      const search = await call(base, 'i2idlx_search', { query: 'learning', limit: 1 });
      expect(search.body.result.structuredContent.concepts).toHaveLength(1);
      expect(search.body.result.structuredContent.bounded_search).toBe(true);
    });
  });
  it('prioritizes attached terms and bounds additional question context', async () => {
    await withServer(async (base, directory) => {
      const data = fixture();
      for (let index = 0; index < 20; index++) data.concepts.push({ ...data.concepts[0]!, id: 'resource-' + index, l: 'Learning resource ' + index });
      await writeFile(join(directory, 'data.json'), JSON.stringify(data));
      const response = (await call(base, 'i2idlx_ask', { question: 'Explain learning resources.', concept_ids: ['activity', 'resource'] })).body.result;
      expect(response.isError).not.toBe(true);
      const concepts = response.structuredContent.context.concepts;
      expect(concepts).toHaveLength(14);
      expect(concepts.slice(0, 2).map((concept: { id: string }) => concept.id)).toEqual(['activity', 'resource']);
      expect(concepts.every((concept: { definition: string }) => typeof concept.definition === 'string' && concept.definition.length > 0)).toBe(true);
    });
  });
  it('executes actual classifier and SHACL controls through MCP, including contradiction and vacuous controls', async () => {
    await withServer(async base => {
      const classificationResponse = (await call(base, 'i2idlx_classify', { graph_content: CONFLICT })).body.result;
      expect(classificationResponse._meta['openai/outputTemplate']).toBeUndefined(); expect(classificationResponse._meta.ui).toBeUndefined();
      const classify = classificationResponse.structuredContent;
      expect(classify.execution).toBe('deterministic-read-only'); expect(classify.result.clashes).toHaveLength(1);
      expect(classify.result.types).toContainEqual({ subject: EX + 'mixed', type: EX + 'Resource' });
      expect(classify.evidence.input_sha256).toMatch(/^[a-f0-9]{64}$/); expect(classify.result.full_owl_consistency).toBe('not_run');
      const validation = (await call(base, 'i2idlx_validate', { graph_content: VALID })).body.result.structuredContent;
      expect(validation.result).toMatchObject({ conforms: true, validation_applicable: true, publication_performed: false });
      const negative = (await call(base, 'i2idlx_validate', { graph_content: P + 'ex:bad i2x:isClassifiedBy i2idl:resource .' })).body.result.structuredContent;
      expect(negative.result.conforms).toBe(false);
      const vacuous = (await call(base, 'i2idlx_validate', { graph_content: P + 'ex:unrelated rdfs:label "Other" .' })).body.result.structuredContent;
      expect(vacuous.result).toMatchObject({ conforms: true, validation_applicable: false });
    });
  });
  it('never fetches a caller-selected peer IRI and only fetches the fixed canonical scheme for source checks', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => scheme());
    await withServer(async base => {
      const peer = await call(base, 'i2idlx_peer_term', { iri: 'https://example.org/peer/Credential' });
      expect(peer.body.result.structuredContent.result.confirmed_in_snapshot).toBe(true); expect(fetcher).not.toHaveBeenCalled();
      const source = await call(base, 'i2idlx_source_version'); expect(source.body.result.structuredContent.result.matches).toBe(true);
      expect(fetcher.mock.calls[0]?.[0]).toBe('https://id.i2idl.org/scheme.ttl');
    }, { fetch: fetcher as typeof fetch });
  });
  it('rejects unknown inputs, fake identity/model inputs, unknown concepts and schema-changing drafts', async () => {
    await withServer(async base => {
      for (const [name, args] of [
        ['i2idlx_workbench', { view: 'not-a-view' }], ['i2idlx_workbench', { concept_ids: ['missing'] }],
        ['i2idlx_ask', { question: 'Hello', api_key: 'secret' }], ['i2idlx_ask', { question: 'Hello', workspace: {} }],
        ['i2idlx_search', { query: 'learning', limit: 100 }], ['i2idlx_source_version', { url: 'https://attacker.example/' }],
        ['i2idlx_orchestrate', { example: true, brief: 'Contradictory custom brief' }],
        ['i2idlx_classify', { graph_content: P + 'ex:Resource rdfs:subClassOf ex:Activity .' }],
      ] as const) {
        const response = await call(base, name, args); expect(response.body.result.isError, name).toBe(true);
      }
      expect((await call(base, 'delete_everything')).body.error.code).toBe(-32601);
    });
  });
  it('shares the semantic concurrency bound across REST and MCP', async () => {
    let started!: () => void, finish!: (response: globalThis.Response) => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const fetcher = vi.fn(() => { started(); return new Promise<globalThis.Response>(resolve => { finish = resolve; }); });
    await withServer(async base => {
      const pending = fetch(base + '/i2idlx/api/source-version', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await startedPromise;
      const busy = await call(base, 'i2idlx_peer_term', { iri: 'https://example.org/peer/Credential' });
      expect(busy.body.result.isError).toBe(true); expect(busy.body.result._meta['i2idlx/httpStatus']).toBe(429);
      finish(scheme()); expect((await pending).status).toBe(200);
      expect((await call(base, 'i2idlx_peer_term', { iri: 'https://example.org/peer/Credential' })).body.result.isError).toBeUndefined();
    }, { fetch: fetcher as typeof fetch });
  });
});
