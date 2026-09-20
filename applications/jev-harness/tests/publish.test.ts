import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RelayClient, lastJsonRpcMessage, publishJudgment, recordTrajectoryStep } from '../src/publish.js';
import type { NavigationJudgment } from '../src/judgments/navigate.js';

let server: Server;
let url: string;
const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      seen.push({ headers: req.headers as Record<string, string>, body });
      if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_token' })); return; }
      if (body['method'] === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-relay' } } }));
        return;
      }
      if (body['method'] === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (body['method'] === 'tools/call') {
        const params = body['params'] as { name: string; arguments: Record<string, unknown> };
        const result = params.name === 'publish_context'
          ? { descriptorUrl: 'https://pod.example/u/context-graphs/1.ttl', graphUrl: 'https://pod.example/u/context-graphs/1-graph.trig', previousHeadCid: 'bafy1' }
          : { ok: true, stepId: 'urn:iep:trajectory-step:x:1' };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body['id'], result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })}\n\n`);
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => { server.close(); });

const judgment: NavigationJudgment = {
  kind: 'navigation', id: 'p1', graphIri: 'urn:graph:jev-harness:navigation:p1', createdAt: '2026-09-19T00:00:00.000Z', model: 'jev-1.13.0', confidence: 0.77,
  repository: { name: 'r', root: '/r', commit: null }, usage: { requests: 1, input_tokens: 1, output_tokens: 0, latencyMs: 1 },
  task: 't', files: [], tests: [], docs: [], covered: 0, noTestProbability: 1, advice: 'widen-search', passes: [], filesConsidered: 0,
};

describe('relay publishing over MCP streamable HTTP', () => {
  it('initializes, keeps the session id, and publishes the payload graph with the judgment\'s modal status and confidence', async () => {
    const relay = new RelayClient({ url, bearer: 'test-token' });
    const receipt = await publishJudgment(relay, judgment, '<urn:jev-harness:navigation:p1> <urn:p> "x" .\n');
    expect(receipt.descriptorUrl).toBe('https://pod.example/u/context-graphs/1.ttl');
    expect(receipt.previousHeadCid).toBe('bafy1');
    const call = seen.find((s) => (s.body['method'] === 'tools/call'))!;
    expect(call.headers['mcp-session-id']).toBe('sess-1');
    const args = (call.body['params'] as { arguments: Record<string, unknown> }).arguments;
    expect(args['graph_iri']).toBe(judgment.graphIri);
    expect(args['modal_status']).toBe('Hypothetical');
    expect(args['confidence']).toBe(0.77);
    expect(args['visibility']).toBe('shared');
    const step = await recordTrajectoryStep(relay, { verb: 'navigated', objectName: 't', resultQuality: 0.77 });
    expect(step.structured).toMatchObject({ ok: true });
  });

  it('publishes an outcome as the next version of the judgment\'s own graph with a CAS precondition', async () => {
    const relay = new RelayClient({ url, bearer: 'test-token' });
    const before = seen.length;
    await publishJudgment(relay, { ...judgment, kind: 'outcome', id: 'o1', graphIri: 'urn:graph:jev-harness:outcome:o1', confidence: 1 } as unknown as typeof judgment, '', {
      graphIri: judgment.graphIri, ifMatch: 'https://pod.example/u/context-graphs/1.ttl',
    });
    const call = seen.slice(before).find((s) => s.body['method'] === 'tools/call')!;
    const args = (call.body['params'] as { arguments: Record<string, unknown> }).arguments;
    expect(args['graph_iri']).toBe(judgment.graphIri);
    expect(args['modal_status']).toBe('Asserted');
    expect(args['if_match']).toBe('https://pod.example/u/context-graphs/1.ttl');
  });

  it('rejects a bad token loudly', async () => {
    const relay = new RelayClient({ url, bearer: 'wrong' });
    await expect(publishJudgment(relay, judgment, '')).rejects.toThrow(/401/);
  });

  it('extracts the matching JSON-RPC response from an SSE body', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
    expect(lastJsonRpcMessage(sse, 2)).toMatchObject({ id: 2 });
    expect(() => lastJsonRpcMessage(sse, 3)).toThrow();
  });
});
