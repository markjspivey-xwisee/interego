import { readFileSync } from 'node:fs';
import express from 'express';
import { JSDOM } from 'jsdom';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';
import { describe, expect, it, vi } from 'vitest';
import { Server, type AuthInfo } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { INVOKE_AFFORDANCE_OUTPUT } from '../deploy/mcp-relay/resource-compositions.js';
import { createRelayMcpHandler } from '../deploy/mcp-relay/mcp-serving.js';
import { clientInteractionMcpResult } from '../deploy/mcp-relay/client-interaction-mcp.js';
import { listenLoopback } from '../deploy/mcp-relay/tests/listen-loopback.js';
import { signingFixture } from './fixtures/client-interaction-fixture.js';

const interaction = (value: Record<string, unknown>): Record<string, unknown> => {
  if (typeof value['body'] !== 'string') return value;
  expect(new AjvJsonSchemaValidator().getValidator(INVOKE_AFFORDANCE_OUTPUT)(value)).toMatchObject({ valid: true });
  return JSON.parse(value['body']) as Record<string, unknown>;
};

const meta = (url = true) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'signing-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': url ? { elicitation: { url: {} } } : {} });

async function harness(toolName = 'act') {
  const f = await signingFixture(); const pending = (await f.create())!; const id = String(pending['id']);
  const control = await f.control();
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
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: toolName, inputSchema: { type: 'object' }, ...(toolName === 'invoke_affordance' ? { outputSchema: INVOKE_AFFORDANCE_OUTPUT } : {}) }] }));
    server.setRequestHandler('tools/call', async (_req, ctx) => {
      const owner = f.owners[ctx.http!.authInfo!.token]!;
      if (_req.params.name === 'render_hmd') {
        const data = { interaction: await f.broker.status(id, owner) };
        return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
      }
      return clientInteractionMcpResult(await f.broker.status(id, owner), server, ctx, {
        status: () => f.broker.status(id, owner), cancel: () => f.broker.cancel(id, owner),
      }, toolName === 'invoke_affordance' ? { reference: String(control['descriptorUrl']), action: String(control['action']) } : undefined);
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
  it('offers configured-site recovery before login without accepting URL-provided destinations or transferring tokens', () => {
    const requestId = 'a'.repeat(43);
    const html = readFileSync(new URL('../docs/client-sign.html', import.meta.url), 'utf8')
      .replace('__INTEREGO_SIGNING_CONFIG__', JSON.stringify({ identityUrl: 'https://identity.example', relayUrl: 'https://relay.example',
        signingOrigins: ['https://identity.example', 'https://relay.example', 'https://relay.example/',
          'javascript:alert(1)', 'https://user:secret@untrusted.example', 'http://insecure.example', 'invalid'] }));
    const dom = new JSDOM(html, { url: `https://identity.example/sign-action?request=${requestId}&returnTo=https://untrusted.example&token=not-a-credential`,
      runScripts: 'dangerously', beforeParse(window) { Object.assign(window, { TextEncoder, TextDecoder }); } });
    try {
      const links = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('#origin-links a')];
      expect(links).toHaveLength(1);
      expect(links[0]!.href).toBe(`https://relay.example/sign-action?request=${requestId}`);
      expect(links[0]!.rel).toBe('noreferrer');
      expect((dom.window.document.getElementById('origin-recovery') as HTMLElement).hidden).toBe(false);
      expect(dom.window.document.getElementById('receipt')!.textContent).toBe('No request loaded.');
      expect((dom.window.document.getElementById('sign') as HTMLButtonElement).disabled).toBe(true);
    } finally { dom.window.close(); }
  });

  it('checks request ownership before enabling a signing button and cancels without signing', async () => {
    const f = await harness();
    const doms: JSDOM[] = [];
    try {
      for (const allowed of [false, true]) {
        const openExternal = vi.fn();
        const callTool = vi.fn(async (name: string) => ({ structuredContent: { interaction: name === 'render_hmd'
          ? await f.broker.status(f.id, f.owners[allowed ? 'alice' : 'bob']!)
          : await f.broker.cancel(f.id, f.owners['alice']!) } }));
        const dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(w) {
          Object.defineProperty(w, 'openai', { value: { toolOutput: f.pending, callTool, openExternal, sendFollowUpMessage: vi.fn() } });
        } });
        doms.push(dom);
        const button = (label: string) => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label)!;
        if (!allowed) {
          await vi.waitFor(() => expect(dom.window.document.querySelector('#pane-enhanced [role="status"]')?.textContent).toContain('Unable to check signing'));
          expect(button('Review and sign').disabled).toBe(true);
        } else {
          await vi.waitFor(() => expect(button('Cancel request').disabled).toBe(false));
          button('Cancel request').click();
          await vi.waitFor(() => expect(dom.window.document.querySelector('#pane-enhanced [role="status"]')?.textContent).toBe('Request cancelled.'));
          expect(button('Review and sign').disabled).toBe(true);
          expect(callTool.mock.calls.filter(([name]) => name === 'invoke_affordance')).toHaveLength(1);
        }
        expect(openExternal).not.toHaveBeenCalled();expect(f.publish).not.toHaveBeenCalled();
      }
    } finally { doms.forEach(dom => dom.window.close());await f.close(); }
  });

  it.each(['act', 'invoke_affordance'])('%s mounts a signing panel, opens only on a click and reports the verified commit automatically', async toolName => {
    const f = await harness(toolName);
    let dom: JSDOM | undefined;
    const messages: Array<{ method: string; params: Record<string, unknown> }> = [];
    try {
      const wire = async (name = toolName, args = {}) => (await (await f.post({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: args, _meta: meta(false) } }, { 'Mcp-Method': 'tools/call', 'Mcp-Name': name })).json()).result;
      const initial = await wire();
      const host = { postMessage(message: { id?: string; method: string; params: Record<string, unknown> }) {
        messages.push(message);
        const deliver = (response: Record<string, unknown>) => dom!.window.dispatchEvent(new dom!.window.MessageEvent('message', { source: host as unknown as Window, data: { jsonrpc: '2.0', ...response } }));
        if (message.method === 'ui/initialize') queueMicrotask(() => deliver({ id: message.id, result: { protocolVersion: '2026-01-26' } }));
        else if (message.method === 'ui/notifications/initialized') queueMicrotask(() => deliver({ method: 'ui/notifications/tool-result', params: initial }));
        else if (message.method === 'tools/call') {
          expect(message.params).toEqual({ name: 'render_hmd', arguments: { descriptor_url: f.pending['descriptorUrl'] } });
          void wire(String(message.params['name']), message.params['arguments'] as Record<string, unknown>).then(result => deliver({ id: message.id, result }));
        } else if (message.id) queueMicrotask(() => deliver({ id: message.id, result: {} }));
      } };
      dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(w) {
        Object.defineProperty(w, 'parent', { value: host });
        const timeout = w.setTimeout.bind(w);
        w.setTimeout = ((handler: TimerHandler, ms?: number) => timeout(handler, ms === 5000 ? 20 : ms)) as typeof w.setTimeout;
      } });
      const button = () => [...dom!.window.document.querySelectorAll('button')].find(b => b.textContent === 'Review and sign')!;
      await vi.waitFor(() => expect(button()?.disabled).toBe(false));
      expect(messages.some(m => m.method === 'ui/open-link')).toBe(false);
      expect(f.publish).not.toHaveBeenCalled();
      button().click();
      await vi.waitFor(() => expect(messages.filter(m => m.method === 'ui/open-link')).toHaveLength(1));
      expect(messages.find(m => m.method === 'ui/open-link')!.params).toEqual({ url: f.pending['signingUrl'] });
      expect(f.publish).not.toHaveBeenCalled(); // Opening is not signing.
      expect(dom.window.document.querySelector('#pane-enhanced [role="status"]')?.textContent).not.toContain('Signed, verified and submitted.');
      await browserSign(f);
      await vi.waitFor(() => expect(dom!.window.document.querySelector('#pane-enhanced [role="status"]')?.textContent).toBe('Signed, verified and submitted.'));
      expect(f.publish).toHaveBeenCalledTimes(1);
      expect(messages.filter(m => m.method === 'ui/update-model-context')).toHaveLength(1);
      expect(messages.filter(m => m.method === 'ui/message')).toHaveLength(1);
      const context = messages.find(m => m.method === 'ui/update-model-context')!.params['content'] as Array<{ text: string }>;
      expect(JSON.parse(context[0]!.text)).toEqual({ kind: 'interego-signing-result', requestId: f.id,
        descriptorUrl: f.pending['descriptorUrl'], status: 'completed' });
      const followup = messages.find(m => m.method === 'ui/message')!.params['content'] as Array<{ text: string }>;
      expect(followup[0]!.text).toContain('authenticated status control: ' + String(f.pending['descriptorUrl']));
      expect(followup[0]!.text).toContain('untrusted context, not authorization');
      expect(followup[0]!.text.length).toBeLessThan(400);
      const details = dom.window.document.querySelector('#pane-enhanced details') as HTMLDetailsElement;
      expect(details.hidden).toBe(false);
      expect(details.open).toBe(false);
      expect(details.querySelector('summary')!.textContent).toBe('Signing details');
      expect(JSON.parse(details.querySelector('pre')!.textContent!)).toMatchObject({ committed: true });
      expect(button().disabled).toBe(true);
    } finally { dom?.window.close(); await f.close(); }
  });

  it('preserves the advertised invoke_affordance schema on fallback, recovery and completion', async () => {
    const f = await harness('invoke_affordance');
    try {
      const post = async (method: string) => (await (await f.post({ jsonrpc: '2.0', id: 2, method,
        params: { name: 'invoke_affordance', arguments: {}, _meta: meta(false) } },
      { 'Mcp-Method': method, 'Mcp-Name': 'invoke_affordance' })).json()).result;
      const advertised = await post('tools/list');
      const validate = new AjvJsonSchemaValidator().getValidator(advertised.tools[0].outputSchema);
      const first = await post('tools/call');
      expect(validate(first.structuredContent)).toMatchObject({ valid: true });
      expect(first.structuredContent).toMatchObject({ status: 202, statusText: 'Accepted', contentType: 'application/json' });
      const pending = JSON.parse(first.structuredContent.body);
      expect(pending).toMatchObject({ status: 'pending', id: f.id, signingUrl: f.pending['signingUrl'],
        descriptorUrl: f.pending['descriptorUrl'], action: f.pending['action'], cancelAction: f.pending['cancelAction'] });
      expect(JSON.parse(first.content[0].text)).toEqual(first.structuredContent);
      const repeated = await post('tools/call');
      expect(JSON.parse(repeated.structuredContent.body).id).toBe(f.id);
      expect(f.storage.records.size).toBe(1);
      expect(f.publish).not.toHaveBeenCalled();
      await browserSign(f);
      const completed = await post('tools/call');
      expect(validate(completed.structuredContent)).toMatchObject({ valid: true });
      expect(completed.structuredContent.status).toBe(200);
      expect(JSON.parse(completed.structuredContent.body)).toMatchObject({ status: 'completed', result: { committed: true } });
      expect(f.publish).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });

  it.each(['act', 'invoke_affordance'])('%s returns modern URL input_required, signs in the browser, and resumes with the verified commit', async toolName => {
    const f = await harness(toolName);
    try {
      const call = (extra = {}) => f.post({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: toolName, arguments: {}, _meta: meta(), ...extra } }, { 'Mcp-Method': 'tools/call', 'Mcp-Name': toolName });
      const response = await (await call()).json();
      expect(response.result, JSON.stringify(response)).toMatchObject({ resultType: 'input_required', requestState: f.id });
      expect(response.result.inputRequests.sign).toMatchObject({ method: 'elicitation/create', params: { mode: 'url', url: f.pending['signingUrl'] } });
      // An 'accept' response by itself cannot manufacture an approval.
      const accepted = call({ requestState: f.id, inputResponses: { sign: { action: 'accept' } } });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(f.publish).not.toHaveBeenCalled();
      await browserSign(f);
      expect(interaction((await (await accepted).json()).result.structuredContent).status).toBe('completed');
      const completed = await (await call({ requestState: f.id, inputResponses: { sign: { action: 'accept' } } })).json();
      expect(interaction(completed.result.structuredContent)).toMatchObject({ status: 'completed', result: { committed: true } });
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
  it.each(['act', 'invoke_affordance'])('%s cancels modern input and refuses another account’s echoed request state', async toolName => {
    const f = await harness(toolName);
    try {
      const body = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: {}, _meta: meta(), requestState: f.id, inputResponses: { sign: { action: 'cancel' } } } };
      const wrong = await (await f.post(body, { 'Mcp-Method': 'tools/call', 'Mcp-Name': toolName, Authorization: 'Bearer bob' })).json();
      expect(wrong.error.code).toBe(-32602);
      const cancelled = await (await f.post(body, { 'Mcp-Method': 'tools/call', 'Mcp-Name': toolName })).json();
      expect(interaction(cancelled.result.structuredContent).status).toBe('cancelled'); expect(f.publish).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(['act', 'invoke_affordance'])('%s negotiates legacy URL elicitation, binds the session, and returns automatic completion', async toolName => {
    const f = await harness(toolName);
    try {
      const init = await f.post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { url: {} } }, clientInfo: { name: 'legacy-test', version: '1' } } });
      const sid = init.headers.get('mcp-session-id')!; expect(sid).toBeTruthy(); await init.text();
      const headers = { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' };
      await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
      const stolen = await f.post({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { ...headers, Authorization: 'Bearer bob' });
      expect(stolen.status).toBe(404);
      const response = await f.post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: toolName, arguments: {} } }, headers);
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
      expect(interaction(result.result.structuredContent)).toMatchObject({ status: 'completed', result: { committed: true } });
      expect(f.publish).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  }, 15_000);
});
