import { readFileSync } from 'node:fs';
import express from 'express';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { Server, type AuthInfo } from '@modelcontextprotocol/server';
import { createRelayMcpHandler } from '../deploy/mcp-relay/mcp-serving.js';
import { clientInteractionMcpResult } from '../deploy/mcp-relay/client-interaction-mcp.js';
import { listenLoopback } from '../deploy/mcp-relay/tests/listen-loopback.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

const meta = (url = true) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'signing-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': url ? { elicitation: { url: {} } } : {} });

async function harness() {
  const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.headers.authorization === 'Bearer bob' ? 'bob' : 'alice';
    (req as express.Request & { auth?: AuthInfo }).auth = { token: user, clientId: f.owners[user]!.clientId,
      scopes: ['mcp'], extra: { userId: user, agentId: f.owners[user]!.principal } };
    next();
  });
  const mcp = createRelayMcpHandler(() => {
    const server = new Server({ name: 'signing-test', version: '1' }, { capabilities: { tools: {} },
      requestState: { verify: async (state, ctx) => {
        await f.broker.status(state, f.owners[ctx.http!.authInfo!.token]!); return state;
      } },
    });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'act', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler('tools/call', async (_req, ctx) => {
      const owner = f.owners[ctx.http!.authInfo!.token]!;
      return clientInteractionMcpResult(await f.broker.status(id, owner), server, ctx, {
        status: () => f.broker.status(id, owner), cancel: () => f.broker.cancel(id, owner),
      });
    });
    return server;
  });
  app.all('/mcp', mcp.handler);
  const http = await listenLoopback(app);
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(http.base + '/mcp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer alice', ...headers }, body: JSON.stringify(body) });
  return { ...f, id, pending, post, base: http.base, close: async () => { await mcp.close(); await http.close(); } };
}

async function browserSign(f: Awaited<ReturnType<typeof harness>>) {
  const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
    .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: 'https://identity.example', relayUrl: 'https://relay.example' }));
  const dom = new JSDOM(html, { url: String(f.pending['signingUrl']), runScripts: 'dangerously', beforeParse(window) {
    window.sessionStorage.setItem('cg.token', 'holder-alice');
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto });
    Object.assign(window, { TextEncoder, TextDecoder,
      fetch: async (url: string, options: { method: string; headers: Record<string, string>; body?: string }) => {
        expect(options.headers['Authorization']).toBe('Bearer holder-alice');
        const suffix = new URL(url).pathname.split('/').at(-1);
        const body = JSON.parse(options.body ?? '{}') as { proof: unknown; reviewId: string };
        const result = suffix === 'review' ? await f.broker.review(f.id, 'alice')
          : suffix === 'submit' ? await f.broker.submit(f.id, 'alice', body.reviewId, body.proof)
            : await f.broker.status(f.id, { holderUserId: 'alice' });
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
      },
      ethereum: { request: async (args: { method: string; params?: string[] }) => {
        if (args.method === 'eth_requestAccounts') return [f.wallets.alice.address];
        if (args.method === 'personal_sign') return f.wallets.alice.signMessage(Buffer.from(args.params![0]!.slice(2), 'hex'));
        throw new Error('unexpected wallet call');
      } },
    });
  } });
  try {
    const sign = dom.window.document.getElementById('sign') as HTMLButtonElement;
    await new Promise<void>((resolve, reject) => {
      let tries = 0;
      const poll = () => !sign.disabled ? resolve() : ++tries > 100 ? reject(new Error(dom.window.document.getElementById('status')!.textContent!)) : setTimeout(poll, 10);
      poll();
    });
    expect((dom.window.document.getElementById('manual-proof') as HTMLElement).hidden).toBe(true);
    await sign.onclick!(new dom.window.MouseEvent('click') as unknown as PointerEvent);
    expect(dom.window.document.getElementById('status')!.textContent).toContain('Signed, verified and submitted');
    expect((dom.window.document.getElementById('proof') as HTMLTextAreaElement).value).toBe('');
  } finally { dom.window.close(); }
}

describe('MCP signing lifecycle on the actual SDK transport', () => {
  it('returns modern URL input_required, signs in the browser, and resumes with the verified commit', async () => {
    const f = await harness();
    try {
      const call = (extra = {}) => f.post({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'act', arguments: {}, _meta: meta(), ...extra } }, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'act' });
      const response = await (await call()).json();
      expect(response.result, JSON.stringify(response)).toMatchObject({ resultType: 'input_required', requestState: f.id });
      expect(response.result.inputRequests.sign).toMatchObject({ method: 'elicitation/create', params: { mode: 'url', url: f.pending['signingUrl'] } });
      // An 'accept' response by itself cannot manufacture an approval.
      const accepted = call({ requestState: f.id, inputResponses: { sign: { action: 'accept' } } });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(f.publish).not.toHaveBeenCalled();
      await browserSign(f);
      expect((await (await accepted).json()).result.structuredContent.status).toBe('completed');
      const completed = await (await call({ requestState: f.id, inputResponses: { sign: { action: 'accept' } } })).json();
      expect(completed.result.structuredContent).toMatchObject({ status: 'completed', result: { committed: true } });
      expect(f.publish).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it('uses a short-link fallback without sending unsupported elicitation requests', async () => {
    const f = await harness();
    try {
      const r = await f.post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'act', arguments: {}, _meta: meta(false) } }, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'act' });
      const response = await r.json();
      expect(response.result.structuredContent).toMatchObject({ status: 'pending', signingUrl: f.pending['signingUrl'] });
      expect(response.result.inputRequests).toBeUndefined();
      await browserSign(f);
      expect((await f.broker.status(f.id, f.owners['alice']!)).status).toBe('completed');
    } finally { await f.close(); }
  });
  it('cancels modern input and refuses another account’s echoed request state', async () => {
    const f = await harness();
    try {
      const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'act', arguments: {}, _meta: meta(), requestState: f.id, inputResponses: { sign: { action: 'cancel' } } } };
      const wrong = await (await f.post(body, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'act', Authorization: 'Bearer bob' })).json();
      expect(wrong.error.code).toBe(-32602);
      const cancelled = await (await f.post(body, { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'act' })).json();
      expect(cancelled.result.structuredContent.status).toBe('cancelled'); expect(f.publish).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('negotiates legacy URL elicitation, binds the session, and returns automatic completion', async () => {
    const f = await harness();
    try {
      const init = await f.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { url: {} } }, clientInfo: { name: 'legacy-test', version: '1' } } });
      const sid = init.headers.get('mcp-session-id')!; expect(sid).toBeTruthy(); await init.text();
      const headers = { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' };
      await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
      const stolen = await f.post({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { ...headers, Authorization: 'Bearer bob' });
      expect(stolen.status).toBe(404);
      const response = await f.post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'act', arguments: {} } }, headers);
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result; let elicited = false; let notified = false;
      while (!result) {
        const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const line = event.split('\n').find(value => value.startsWith('data: ')); if (!line) continue;
          const message = JSON.parse(line.slice(6));
          if (message.method === 'elicitation/create') {
            elicited = true; expect(message.params).toMatchObject({ mode: 'url', elicitationId: f.id, url: f.pending['signingUrl'] });
            await browserSign(f);
            await f.post({ jsonrpc: '2.0', id: message.id, result: { action: 'accept' } }, headers);
          } else if (message.method === 'notifications/elicitation/complete') notified = true;
          else if (message.id === 9) result = message;
        }
      }
      await reader.cancel();
      expect(elicited).toBe(true); expect(notified).toBe(true);
      expect(result.result.structuredContent).toMatchObject({ status: 'completed', result: { committed: true } });
      expect(f.publish).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  }, 15_000);
});
