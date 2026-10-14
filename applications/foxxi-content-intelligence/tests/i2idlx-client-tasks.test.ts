import { describe, it, expect } from 'vitest';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { attachClientTaskRoutes } from '../src/i2idlx-client-tasks.js';
import { foxxiAffordances } from '../affordances.js';

const commit = '9f865995d879165d8fa49422915a5e53d2ecebf9';
function publicFixture() {
  return {
    meta: { release: 'v0.0.86', commit, built: '2026-10-13T20:30:00+00:00', repo: 'https://github.com/i2idl/glossary',
      scheme: { title: 'I2IDL Digital Learning Glossary', iri: 'https://example.org/scheme', rights: 'CC BY 4.0' },
      license: { holder: 'Publisher fixture', name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
      iri: { catalog: 'https://pod.example/public/catalog' }, privateKey: 'SECRET-META-KEY' },
    sources: [{ label: 'Public evidence', rights: 'CC BY 4.0', secret: 'SECRET-SOURCE' }],
    roles: [{ id: 'operates', by: 'operates' }],
    concepts: Array.from({ length: 20 }, (_, i) => ({ id: 'fixture-' + i, l: 'Fixture learning record ' + i,
      a: ['Record ' + i], d: 'Exact published definition for fixture ' + i, x: 'Public editorial explanation.',
      t: 'system', k: 'system', f: ['learning-engineering'], b: [], n: [], r: i ? ['fixture-0'] : [],
      ev: [{ s: 0, r: 'd', c: 'Public citation' }], rc: 'information', rb: 'd', rw: 'Public category rationale',
      teamNotes: ['SECRET-TEAM-NOTE'] })),
    actions: { 'urn:test:read': { t: 'Read public terms' } },
    enactments: [{ c: 'fixture-0', a: 'urn:test:read', r: 'operates', cf: 0.8, w: 'Public hypothesis' }],
    mappings: [{ id: 'map-one', c: 'fixture-0', p: 'closeMatch', o: 'https://example.org/peer', ol: 'Peer term',
      od: 'Peer definition', v: 'Peer vocabulary', cf: 0.7, s: 'proposed', w: 'Hypothetical mapping' }],
    semantic: { categories: [{ id: 'information', label: 'Information', def: 'Public category', cls: 'bfo:information',
      mode: 'https://example.org/classification-mode', all: ['bfo:information'] }],
      disjoint: { 'information|process': { bfo: ['bfo:information', 'bfo:process'] } },
      prefixes: { bfo: 'http://purl.obolibrary.org/obo/' },
      bridges: [{ c: 'fixture-0', t: 'schema:Thing', k: 'broad', m: 'map-one' }],
      snapshots: [{ key: 'bfo', version: '2020', license: 'Public license', sha256: 'fixture-public-hash' }] },
    ports: [{ id: 'port-read', label: 'Read public context', action: 'urn:test:read', m: 'GET', u: 'https://pod.example/public/terms', ro: true,
      expects: { id: 'query-shape', label: 'Query', props: [{ n: 'query', req: true, c: 'Actual declared input', max: 512 }] } }],
    queries: [{ id: 'q-read', label: 'Read query', form: 'SELECT', sparql: 'SELECT ?s WHERE { ?s ?p ?o }', params: [], over: ['public'] }],
    orchestra: { transcript: 'SECRET-RECORDED-TRANSCRIPT' }, ballots: 'SECRET-BALLOTS', notes: 'SECRET-POD-NOTES', workspace: 'SECRET-WORKSPACE',
  };
}
async function withServer(run: (base: string, dataFile: string) => Promise<void>, data = publicFixture()) {
  const dir = await mkdtemp(join(tmpdir(), 'i2idlx-task-test-')), dataFile = join(dir, 'public.json');
  await writeFile(dataFile, JSON.stringify(data));
  const app = express(); app.use(express.json({ limit: '1mb' }));
  attachClientTaskRoutes(app, { baseUrl: 'https://bridge.example', appDataFile: dataFile });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run('http://127.0.0.1:' + (server.address() as AddressInfo).port, dataFile); }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
const call = (base: string, operation: string, args: unknown) =>
  fetch(base + '/i2idlx/api/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });

describe('I2IDL-X connected-client task operations', () => {
  it('advertises two accurately described read-only externally routed operations', () => {
    for (const name of ['ask', 'orchestrate']) {
      const spec = foxxiAffordances.find(a => a.action === 'urn:iep:action:foxxi:i2idlx-' + name)!;
      expect(spec).toBeDefined(); expect(spec.method).toBe('POST'); expect(spec.externallyRouted).toBe(true);
      expect(spec.annotations?.readOnlyHint).toBe(true); expect(Object.keys(spec.outputs?.properties ?? {}).length).toBeGreaterThan(0);
      expect(spec.targetTemplate).toBe('{base}/i2idlx/api/' + name);
    }
  });
  it('returns real public entries and the shared Ask rules, never an answer or private state', async () => {
    await withServer(async base => {
      const response = await call(base, 'ask', { question: 'Explain the record terms.', concept_ids: ['fixture-0'] });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const packet = await response.json();
      expect(packet).toMatchObject({ task: 'ask', execution: 'client-required', status: 'instructions-only', sampling_performed: false, writes_performed: false });
      expect(packet.context.publication).toMatchObject({ release: 'v0.0.86', commit });
      expect(packet.context.concepts[0].definition).toBe('Exact published definition for fixture 0');
      expect(packet.context.concepts[0].evidence[0].rights).toBe('CC BY 4.0');
      expect(packet.context.concepts[0].crosswalks_hypothetical[0].recordedStatus).toBe('proposed');
      expect(packet.context.semantic.bridges[0].m).toBe('map-one');
      expect(packet.context.catalog.controls[0].expects.properties[0]).toMatchObject({ n: 'query', req: true });
      expect(packet.context.catalog.queries[0].sparql).toBe('SELECT ?s WHERE { ?s ?p ?o }');
      expect(packet.context.semantic.disjoint['information|process'].bfo).toEqual(['bfo:information', 'bfo:process']);
      expect(packet.instructions).toContain('[[concept-id]]'); expect(packet.instructions).toContain('Hypothetical');
      expect(packet.instructions).toContain('Selected entries from 20 glossary terms');
      expect(packet.answer).toBeUndefined(); expect(packet.run).toBeUndefined();
      expect(packet.context.concepts.length).toBeLessThanOrEqual(14);
      expect(JSON.stringify(packet)).not.toContain('SECRET-');
      expect(packet._affordances).toContainEqual({ action: 'urn:iep:action:foxxi:i2idlx-orchestrate', href: 'https://bridge.example/i2idlx/api/orchestrate', method: 'POST' });
    });
  });
  it('accepts generic-relay envelope arguments without treating an unsigned identity as verified', async () => {
    await withServer(async base => {
      const response = await call(base, 'ask', { _signed_payload: JSON.stringify({ question: 'fixture', agent_id: 'forged-owner', timestamp: new Date().toISOString() }), _signature: 'not-an-identity-proof' });
      expect(response.status).toBe(200);
      const packet = await response.json();
      expect(packet.me).toBeUndefined(); expect(JSON.stringify(packet)).not.toContain('forged-owner');
      expect(packet.sampling_performed).toBe(false);
    });
  });
  it('returns actual eight role charters and twelve dependency steps as an unexecuted recipe', async () => {
    await withServer(async base => {
      const response = await call(base, 'orchestrate', { example: true });
      expect(response.status).toBe(200);
      const packet = await response.json();
      expect(packet.request.example).toBe(true); expect(packet.request.scenario.note).toContain('fictional');
      expect(packet.workflow.roles.map((a: { id: string }) => a.id)).toEqual(['conductor', 'scout', 'lexicographer', 'ontologist', 'crosswalker', 'standards', 'practice', 'curator']);
      expect(packet.workflow.steps).toHaveLength(12);
      expect(packet.workflow.steps.find((s: { id: string }) => s.id === 'pack').after).toEqual(['recheck', 'review-standards', 'review-practice']);
      expect(packet.workflow.steps.find((s: { id: string }) => s.id === 'fix').conditional).toBe(true);
      expect(packet.workflow.steps.find((s: { id: string }) => s.id === 'stage').browser_tool_names).toContain('request_approval');
      expect(packet.workflow.maxParallelRoles).toBe(2); expect(packet.workflow.maxToolRoundsPerStep).toBe(6);
      expect(packet.status).toBe('instructions-only'); expect(packet.writes_performed).toBe(false);
      expect(packet.instructions).toContain('not callable MCP tools');
      expect(packet.workflow.gate).toContain('human authorization');
      expect(packet.completed).toBeUndefined(); expect(packet.result).toBeUndefined();
    });
  });
  it('validates custom briefs/inventories and bounds question, ids and side-effect inputs', async () => {
    await withServer(async base => {
      const custom = await call(base, 'orchestrate', { brief: 'Classify our record store.', records: [{ id: 'store', title: 'Record store', description: 'An xAPI store.' }], concept_ids: ['fixture-0'] });
      expect(custom.status).toBe(200); expect((await custom.json()).request.example).toBe(false);
      for (const args of [{ question: '' }, { question: '😀'.repeat(1001) }, { question: 'fixture', concept_ids: ['unknown-id'] },
        { question: 'fixture', concept_ids: Array(15).fill('fixture-0') }, { question: 'fixture', url: 'http://localhost/private' },
        { question: 'fixture', api_key: 'forbidden' }]) expect((await call(base, 'ask', args)).status).toBe(400);
      expect((await call(base, 'orchestrate', { example: true, records: [] })).status).toBe(400);
      expect((await call(base, 'orchestrate', { brief: 'Our task', records: [] })).status).toBe(400);
      expect((await call(base, 'orchestrate', { brief: 'Our task', records: [{ id: 'one', title: 'One', description: 'x' }, { id: 'one', title: 'Two', description: 'y' }] })).status).toBe(400);
    });
  });
  it('refuses missing/invalid public build data and oversized context instead of fabricating success', async () => {
    await withServer(async (base, dataFile) => {
      await writeFile(dataFile, 'not JSON');
      const invalid = await call(base, 'ask', { question: 'fixture' }); expect(invalid.status).toBe(503);
      expect((await invalid.json()).error).toContain('unavailable');
      await rm(dataFile);
      expect((await call(base, 'orchestrate', { example: true })).status).toBe(503);
      const large = publicFixture();
      for (const c of large.concepts) {
        c.d = 'Definition '.repeat(1100);
        c.ev = Array.from({ length: 12 }, () => ({ s: 0, r: 'd', c: 'Citation '.repeat(187) }));
      }
      await writeFile(dataFile, JSON.stringify(large));
      expect((await call(base, 'ask', { question: 'fixture' })).status).toBe(413);
    });
  });
});
