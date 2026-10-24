import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Affordance } from '../../_shared/affordance-mcp/index.js';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';
import { attachCapabilityDirectoryRoutes, validateDirectoryPayload, type CapabilityDirectory, type CapabilityDirectoryConfig } from '../src/i2idlx-capability-runner.js';

const BASE = 'https://bridge.example', RELAY = 'https://relay.interego.xwisee.com';
const ROOT = RELAY + '/.well-known/operations';
const production = [...foxxiAffordances, ...foxxiAdminAffordances];
const document = JSON.parse(await readFile(new URL('../i2idlx/evidence/relay-operations.json', import.meta.url), 'utf8'));
const schemas = JSON.parse(await readFile(new URL('../i2idlx/evidence/relay-inputs.json', import.meta.url), 'utf8'));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const canonical = (name: string) => RELAY + '/ns/iep/action/foxxi/' + name;
function transport(options: { missingSchema?: string; unavailable?: boolean; foreign?: boolean; result?: unknown; status?: number } = {}) {
  let catalogReads = 0, activeSchemas = 0, maxSchemas = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url === ROOT) {
      catalogReads++;
      if (options.unavailable) return json({ error: 'fixture catalog outage' }, 503);
      const doc = structuredClone(document);
      if (options.foreign) doc['hydra:member'][0].expects = 'http://127.0.0.1:8080/private';
      return json(doc);
    }
    if (url.startsWith(ROOT + '/') && url.endsWith('/input')) {
      activeSchemas++; maxSchemas = Math.max(maxSchemas, activeSchemas);
      await Promise.resolve();
      activeSchemas--;
      const name = url.slice((ROOT + '/').length, -'/input'.length);
      return name === options.missingSchema ? json({ error: 'fixture missing schema' }, 503) : json(schemas[name]);
    }
    return json(options.result ?? { ok: true, actual_fixture_result: 'returned by target' }, options.status);
  });
  return { fetcher: fetcher as typeof fetch, calls, stats: () => ({ catalogReads, maxSchemas }) };
}
async function withServer(run: (base: string) => Promise<void>, config: Partial<CapabilityDirectoryConfig> = {}) {
  const app = express(); app.use(express.json({ limit: '1mb' }));
  attachCapabilityDirectoryRoutes(app, { baseUrl: BASE, foxxiAffordances: production, fetch: transport().fetcher, build: 'fixture-build', ...config });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await run('http://127.0.0.1:' + (server.address() as AddressInfo).port); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
async function getDirectory(base: string): Promise<CapabilityDirectory> { const response = await fetch(base + '/i2idlx/directory'); expect(response.status).toBe(200); return response.json(); }
function run(base: string, action_iri: string, payload: unknown, mode = 'example') {
  return fetch(base + '/i2idlx/directory/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action_iri, payload, mode }) });
}
describe('current workbench capability directory and bounded examples', () => {
  it('derives every deployed Foxxi operation and every live Relay schema, including all workbench additions', async () => {
    const io = transport();
    await withServer(async base => {
      const data = await getDirectory(base);
      expect(data.complete).toBe(true); expect(data.schema).toBe(1); expect(data.build).toBe('fixture-build');
      expect(data.actions.length).toBe(production.length + 51);
      expect(data.actions.filter(a => a.sys === 'foxxi').length).toBe(production.filter(a => !a.toolName.startsWith('llm_telemetry.')).length);
      expect(data.actions.filter(a => a.sys === 'telemetry').length).toBe(8);
      expect(data.actions.filter(a => a.sys === 'relay').length).toBe(51);
      expect(new Set(data.actions.map(a => a.iri)).size).toBe(data.actions.length);
      for (const a of production) {
        const row = data.actions.find(row => row.n === a.toolName)!;
        expect(row).toBeDefined(); expect(row.in.length).toBe(a.inputs.length);
        expect(row.input_schema?.required).toEqual(a.inputs.filter(i => i.required).map(i => i.name));
      }
      expect(data.actions.filter(a => a.n.startsWith('foxxi.i2idlx_')).map(a => a.n).sort()).toEqual([
        'foxxi.i2idlx_ask', 'foxxi.i2idlx_capabilities', 'foxxi.i2idlx_challenge', 'foxxi.i2idlx_classify',
        'foxxi.i2idlx_intervention_ask', 'foxxi.i2idlx_interventions', 'foxxi.i2idlx_orchestrate',
        'foxxi.i2idlx_peer_term', 'foxxi.i2idlx_read', 'foxxi.i2idlx_session', 'foxxi.i2idlx_source_version',
        'foxxi.i2idlx_validate', 'foxxi.i2idlx_write',
      ]);
      expect(data.actions.find(a => a.n === 'foxxi.i2idlx_interventions')).toMatchObject({
        m: 'GET', u: BASE + '/i2idlx/api/interventions', ro: true, xr: true,
        input_schema: { required: [] }, execution: { mode: 'prepare-only' },
      });
      expect(data.actions.find(a => a.n === 'foxxi.i2idlx_intervention_ask')).toMatchObject({
        m: 'POST', u: BASE + '/i2idlx/api/intervention-ask', ro: true, xr: true,
        input_schema: { required: ['question', 'source'] }, execution: { mode: 'prepare-only' },
      });
      expect(data.sources.map(s => s.count)).toEqual([production.length, 51]);
      expect(io.calls).toHaveLength(52); expect(io.stats().maxSchemas).toBeLessThanOrEqual(6);
      expect(io.calls.every(c => c.init?.method === 'GET' && c.init.redirect === 'manual')).toBe(true);
    }, { fetch: io.fetcher });
  });
  it('shares one inflight refresh and never runs capabilities merely by opening the directory', async () => {
    const io = transport();
    await withServer(async base => {
      await Promise.all(Array.from({ length: 5 }, () => getDirectory(base)));
      await getDirectory(base);
      expect(io.stats().catalogReads).toBe(1);
      expect(io.calls.every(c => c.url === ROOT || c.url.startsWith(ROOT + '/'))).toBe(true);
    }, { fetch: io.fetcher });
  });
  it('shows a current catalog outage as incomplete and does not substitute a frozen successful copy', async () => {
    const io = transport({ unavailable: true });
    await withServer(async base => {
      const data = await getDirectory(base);
      expect(data.complete).toBe(false); expect(data.actions.length).toBe(production.length);
      expect(data.sources[1]).toMatchObject({ status: 'unavailable', count: 0 });
    }, { fetch: io.fetcher });
  });
  it('retains all advertised actions when one current input schema fails but refuses positive validation', async () => {
    const io = transport({ missingSchema: 'compose' });
    await withServer(async base => {
      const data = await getDirectory(base), row = data.actions.find(a => a.n === 'relay.compose')!;
      expect(data.complete).toBe(false); expect(data.actions.length).toBe(production.length + 51);
      expect(row.input_schema).toBeNull();
      const response = await run(base, row.iri, row.example.payload, 'validate');
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ executed: false, status: 'invalid', validation: { valid: false } });
      expect(io.calls.every(c => !c.url.includes('/tool/'))).toBe(true);
    }, { fetch: io.fetcher });
  });
  it('refuses a redirected/foreign contract before fetching its supplied URL', async () => {
    const io = transport({ foreign: true });
    await withServer(async base => {
      const data = await getDirectory(base);
      expect(data.complete).toBe(false);
      expect(io.calls.some(c => c.url.includes('127.0.0.1'))).toBe(false);
    }, { fetch: io.fetcher });
  });
  it('returns real live output and request evidence for reviewed public profiles with no forwarded credentials', async () => {
    const io = transport();
    await withServer(async base => {
      const response = await run(base, canonical('discover-lrs'), {});
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ executed: true, status: 'executed', result: { actual_fixture_result: 'returned by target' }, primary_writes_performed: false, telemetry: { may_record: true }, evidence: { source: 'live-http', http_status: 200, target: BASE + '/xapi/about', invocation_attempted: true } });
      const call = io.calls.find(c => c.url === BASE + '/xapi/about')!;
      expect(call.init?.redirect).toBe('manual'); expect(call.init?.method).toBe('GET');
      expect(new Headers(call.init?.headers).has('Authorization')).toBe(false);
    }, { fetch: io.fetcher });
  });
  it('runs only explicit reviewed profiles, never a generic read-only or state-changing affordance', async () => {
    const io = transport();
    await withServer(async base => {
      const data = await getDirectory(base);
      const stateful = data.actions.find(a => a.n === 'relay.mint')!;
      const before = io.calls.length;
      expect((await run(base, stateful.iri, { content: 'example', kind: 'atom' })).status).toBe(403);
      const protectedRead = data.actions.find(a => a.n === 'foxxi.le_analyze_learning_curve')!;
      expect(protectedRead.ro).toBe(true); expect(protectedRead.execution.mode).toBe('prepare-only');
      expect((await run(base, protectedRead.iri, { concept_id: 'example', attempts: [] })).status).toBe(403);
      for (const name of ['foxxi.i2idlx_interventions', 'foxxi.i2idlx_intervention_ask']) {
        const intervention = data.actions.find(a => a.n === name)!;
        expect(intervention.ro).toBe(true); expect(intervention.execution.mode).toBe('prepare-only');
        const payload = name === 'foxxi.i2idlx_intervention_ask'
          ? { question: 'Explain the fixture source.', source: 'authored-course', intervention_id: 'fixture-course' }
          : {};
        expect((await run(base, intervention.iri, payload)).status).toBe(403);
      }
      expect((await run(base, 'urn:not-advertised', {})).status).toBe(404);
      expect(io.calls.length).toBe(before);
    }, { fetch: io.fetcher });
  });
  it('validates and prepares protected operations without calling their target or claiming execution', async () => {
    const io = transport();
    await withServer(async base => {
      const data = await getDirectory(base), action = data.actions.find(a => a.n === 'relay.remember')!;
      const before = io.calls.length, response = await run(base, action.iri, { body: 'Illustrative note, not sent.' }, 'validate');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'contract-valid', executed: false, validation: { valid: true }, evidence: { source: 'schema-only' } });
      expect(io.calls.length).toBe(before);
      for (const name of ['relay.setup_identity', 'relay.link_wallet']) expect(data.actions.find(a => a.n === name)?.execution.mode).toBe('client-only');
    }, { fetch: io.fetcher });
  });
  it('keeps credentials client-side and does not echo secret inputs or use an auth signature as request identity', async () => {
    const io = transport();
    await withServer(async base => {
      for (const payload of [{ private_key: 'SENSITIVE-PRIVATE-KEY' }, { nested: { llm_api_key: 'SENSITIVE-API-KEY' } }, { _signature: 'SENSITIVE-SIGNATURE' }, { token: 'SENSITIVE-TOKEN' }, { example: 'Here is the header: Bearer SENSITIVE-AUTH' }, { human_seed: 'SENSITIVE-HUMAN-SEED' }, { wallet_seed: 'SENSITIVE-WALLET-SEED' }, { lrs_auth_header: 'SENSITIVE-LRS-AUTH' }, { nested: { operator_privkey: 'SENSITIVE-PRIVKEY' } }, { passwd: 'SENSITIVE-PASSWORD' }, { mnemonic: 'SENSITIVE-MNEMONIC' }]) {
        const response = await run(base, canonical('i2idlx-ask'), payload, 'validate');
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.action_iri).toBe(canonical('i2idlx-ask'));
        expect(JSON.stringify(body)).not.toContain('SENSITIVE-');
      }
      expect(io.calls).toHaveLength(0);
    }, { fetch: io.fetcher });
  });
  it('labels connected-model examples as task-packet generation, with no model or completion fabrication', async () => {
    const io = transport({ result: { task: 'ask', execution: 'client-required', status: 'instructions-only', sampling_performed: false, writes_performed: false, instructions: 'Actual fixture instructions' } });
    await withServer(async base => {
      const response = await run(base, canonical('i2idlx-ask'), { question: 'What is a learning record store?' });
      expect(response.status).toBe(200);
      const answer = await response.json();
      expect(answer).toMatchObject({ executed: true, evidence: { scope: 'task-packet-generation-only' }, result: { status: 'instructions-only', sampling_performed: false } });
      expect(answer.answer).toBeUndefined();
      expect((await run(base, canonical('i2idlx-ask'), { question: 'Example?', target: 'http://127.0.0.1/private' })).status).toBe(403);
    }, { fetch: io.fetcher });
  });
  it('bounds Relay pure computation operands and never dereferences inline example IRIs', async () => {
    const io = transport();
    await withServer(async base => {
      const data = await getDirectory(base), action = data.actions.find(a => a.n === 'relay.compose')!;
      const response = await run(base, action.iri, action.example.payload);
      expect(response.status).toBe(200);
      expect(io.calls.filter(c => c.url.includes('/tool/')).map(c => c.url)).toEqual([RELAY + '/tool/compose']);
      const descriptor = { id: 'urn:example:one', describes: ['http://127.0.0.1/private'], facets: [] };
      expect((await run(base, action.iri, { descriptors: Array(17).fill(descriptor), operator: 'union' })).status).toBe(403);
      expect(io.calls.some(c => c.url.includes('127.0.0.1'))).toBe(false);
    }, { fetch: io.fetcher });
  });
  it('records actual HTTP and semantic refusals as refusals even when the target answers 200', async () => {
    for (const result of [{ kind: 'refusal', error: 'Not authorized' }, { error: { code: 400, message: 'Missing domain input' } }, { skipped: true }]) {
      const io = transport({ result });
      await withServer(async base => {
        const response = await run(base, canonical('discover-lrs'), {});
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ status: 'refused', executed: false, result, evidence: { source: 'live-http', http_status: 200 } });
      }, { fetch: io.fetcher });
    }
  });
  it('fails closed when a known profile target changes and when implementation is declared unavailable', async () => {
    const original = production.find(a => a.toolName === 'foxxi.discover_lrs')!;
    const changed: Affordance = { ...original, targetTemplate: '{base}/unexpected' };
    const io = transport();
    await withServer(async base => {
      const data = await getDirectory(base);
      expect(data.actions.find(a => a.n === original.toolName)?.execution.mode).toBe('prepare-only');
      expect((await run(base, canonical('discover-lrs'), {})).status).toBe(403);
      expect(io.calls.some(c => c.url.endsWith('/unexpected'))).toBe(false);
    }, { fetch: io.fetcher, foxxiAffordances: [changed] });
    await withServer(async base => {
      const data = await getDirectory(base);
      expect(data.actions.find(a => a.n === original.toolName)?.execution).toMatchObject({ mode: 'unavailable', implemented: false });
      expect((await run(base, canonical('discover-lrs'), {})).status).toBe(403);
    }, { fetch: io.fetcher, foxxiAffordances: [original], annotations: { [original.toolName]: { implementation: 'not-implemented', mode: 'read', authorization: 'public', requires: [], notes: [] } } });
  });
  it('binds example decoration templates without testing or contacting the supplied endpoint', async () => {
    const io = transport();
    await withServer(async base => {
      const data = await getDirectory(base), action = data.actions.find(a => a.n === 'foxxi.bind_decoration')!;
      expect((await run(base, action.iri, action.example.payload)).status).toBe(200);
      expect(io.calls.some(c => c.url === 'https://example.org/lrs')).toBe(false);
      expect((await run(base, action.iri, { decoration: 'lrs-x', values: { endpoint: 'https://user:password@example.org/lrs' } })).status).toBe(403);
    }, { fetch: io.fetcher });
  });
  it('allows only fixed client-owned secret placeholders in validation and redacts authored example secrets', async () => {
    const io = transport();
    const original = production.find(a => a.toolName === 'foxxi.i2idlx_session')!;
    await withServer(async base => {
      const data = await getDirectory(base), action = data.actions.find(a => a.n === original.toolName)!;
      expect(JSON.stringify(action.example.payload)).not.toContain('SENSITIVE-AUTHORED');
      expect(action.example.payload).toMatchObject({ _signed_payload: '<provided by your connected client>', _signature: '<provided by your connected client>' });
      expect((await run(base, action.iri, action.example.payload, 'validate')).status).toBe(200);
      expect((await run(base, action.iri, action.example.payload, 'example')).status).toBe(400);
      expect(io.calls.every(c => c.url.startsWith(ROOT))).toBe(true);
    }, { fetch: io.fetcher, foxxiAffordances: [original], annotations: { [original.toolName]: { implementation: 'implemented', mode: 'computation', authorization: 'owner', requires: [], notes: [], example: { arguments: { nonce: 'replace-with-a-fresh-challenge', i2idlx_operation: 'session', bridge_audience: BASE, _signed_payload: 'SENSITIVE-AUTHORED-PAYLOAD', _signature: 'SENSITIVE-AUTHORED-SIGNATURE' }, label: 'Redact unsafe example' } } } });
  });
  it('binds unavailable errors to the selected action and never follows a target redirect', async () => {
    for (const behavior of ['throw', 'redirect']) {
      const io = transport();
      const fetcher: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === BASE + '/xapi/about') {
          if (behavior === 'throw') throw new Error('Fixture transport outage');
          return new Response('Moved', { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
        }
        return io.fetcher(input, init);
      };
      await withServer(async base => {
        const response = await run(base, canonical('discover-lrs'), {});
        expect(response.status).toBe(behavior === 'throw' ? 503 : 502);
        const body = await response.json();
        expect(body.action_iri).toBe(canonical('discover-lrs')); expect(body.executed).toBe(false);
        expect(io.calls.some(c => c.url.includes('127.0.0.1'))).toBe(false);
      }, { fetch: fetcher });
    }
  });

  it('passes distinct client-only signing instructions with the actual audience and sanitized examples', async () => {
    const original = production.find(a => a.toolName === 'foxxi.i2idlx_session')!;
    await withServer(async base => {
      const data = await getDirectory(base), action = data.actions.find(a => a.n === original.toolName)!;
      expect(action.signing?.payload.bridge_audience).toBe(BASE);
      expect(action.signing?.payload.private_key).toBe('<provided by your connected client>');
      expect(JSON.stringify(action.signing)).not.toContain('SENSITIVE-SIGNING');
      expect(action.signing?.instructions).toEqual(['Complete the local payload, then sign in your own connected client.']);
      expect(action.execution.mode).toBe('prepare-only');
    }, { foxxiAffordances: [original], annotations: { [original.toolName]: {
      implementation: 'implemented', mode: 'computation', authorization: 'owner', requires: [], notes: [],
      signing: { schema: { type: 'object', properties: { private_key: { type: 'string', default: 'SENSITIVE-SIGNING-DEFAULT' } } },
        payload: { bridge_audience: 'https://old.example', private_key: 'SENSITIVE-SIGNING-PAYLOAD' },
        instructions: ['Complete the local payload, then sign in your own connected client.'] },
    } } });
  });

  it('preserves actual telemetry token counts in examples and validation while keeping credential tokens client-owned', async () => {
    const io = transport(), usage = { input_tokens: 120, output_tokens: 45, cached_input_tokens: 30 };
    const payload = { events: [{ usage }] };
    await withServer(async base => {
      const data = await getDirectory(base), action = data.actions.find(a => a.n === 'llm_telemetry.ingest')!;
      expect(action.example.payload).toEqual(payload);
      const response = await run(base, action.iri, payload, 'validate');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ executed: false, status: 'contract-valid', request: { payload }, evidence: { source: 'schema-only' } });
      const before = io.calls.length;
      for (const name of ['token', 'oauth_token', 'access_token', 'refreshToken', 'session_token_value', '__caller_token']) {
        const blocked = await run(base, action.iri, { events: [{ [name]: 'SENSITIVE-CREDENTIAL' }] }, 'validate');
        expect(blocked.status).toBe(400); expect(await blocked.text()).not.toContain('SENSITIVE-CREDENTIAL');
      }
      expect(io.calls.length).toBe(before); expect(io.calls.every(c => c.url.startsWith(ROOT))).toBe(true);
    }, { fetch: io.fetcher, annotations: { 'llm_telemetry.ingest': { implementation: 'implemented', mode: 'write', authorization: 'signed', requires: [], notes: [], example: { arguments: payload, label: 'Illustrative measured usage values; not submitted' } } } });
  });

});
describe('honest declared-input constraint checks', () => {
  it('checks nested required/types/enums/items/bounds and alternatives, not just presence of a payload', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 3 }, rows: { type: 'array', minItems: 1, items: { type: 'object', properties: { kind: { type: 'string', enum: ['example'] } }, required: ['kind'], additionalProperties: false } }, label: { type: 'string' } }, required: ['count', 'rows'], anyOf: [{ required: ['label'] }, { properties: { count: { enum: [2] } } }] };
    expect(validateDirectoryPayload(schema, { count: 2, rows: [{ kind: 'example' }] }).valid).toBe(true);
    for (const payload of [{ count: 1, rows: [{ kind: 'example' }] }, { count: 4, rows: [] }, { count: 2.5, rows: [{ kind: 'wrong' }] }, { count: 2, rows: [{ kind: 'example', secret: 1 }] }]) expect(validateDirectoryPayload(schema, payload).valid).toBe(false);
    expect(validateDirectoryPayload({ type: 'object', properties: { uri: { type: 'string', format: 'uri' } } }, { uri: 'example' }).valid).toBe(false);
    expect(validateDirectoryPayload(null, {}).valid).toBe(false);
    expect(validateDirectoryPayload({ type: 'object' }, JSON.parse('{"__proto__":{"polluted":true}}')).valid).toBe(false);
    expect(validateDirectoryPayload({ type: 'object', $ref: '#/$defs/unknown' }, {}).valid).toBe(false);
  });
});
