#!/usr/bin/env tsx
/**
 * The Express <-> MCP SDK v2 seam on /mcp.
 *
 * ★ WHY THIS FILE EXISTS. Moving /mcp from the v1 `StreamableHTTPServerTransport` to
 * v2's `createMcpHandler` + `toNodeHandler` has one mechanical detail that fails
 * SILENTLY and that nothing else in this repo can catch:
 *
 *   `express.json()` is mounted GLOBALLY and has already drained the Node request
 *   stream by the time /mcp is reached. `toNodeHandler(handler)` returns
 *   `(req, res, parsedBody?)`, and it deliberately IGNORES a function third argument
 *   — which is exactly what Express passes (`next`). So mounting it directly as
 *   middleware leaves the SDK with no body: it falls back to reading an
 *   already-consumed stream, collects nothing, and answers every POST with a parse
 *   error. It type-checks. It starts. Every MCP client silently stops working.
 *
 * The relay had, and has, NO test that POSTs to /mcp — so the whole transport could be
 * swapped, `npm test` could stay green (569 assertions), and the breakage would appear
 * only when a connector tried to use it.
 *
 * ★ WHAT THIS TEST IS, AND IS NOT. It cannot boot the relay: server.ts has top-level
 * `await`s on `ensureRelayComplianceWallet()` and `loadOAuthClients()` that need a
 * reachable pod, and `app.listen` sits after them. So this mounts the SAME seam the
 * relay mounts — real Express, real `express.json()`, real `createMcpHandler`, real
 * `toNodeHandler` — with a stand-in for `buildMcpServer`, which this change does not
 * touch.
 *
 * That is deliberate and worth being precise about: the thing under test IS live here.
 * The seam is the SDK-to-Express boundary, and both sides of it are the real
 * implementations. What is substituted is our own unchanged tool surface. The full
 * relay path is verified separately by probing the deployed service after release.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AuthInfo, Tool } from '@modelcontextprotocol/server';
import { Server } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

/** Records what the factory saw, so the auth-threading assertions can inspect it. */
const seen: Array<{ era: string; hasAuthInfo: boolean; authHeader: string | null; agentId?: string }> = [];

const TOOL: Tool = {
  name: 'wiring.echo',
  description: 'Echoes its argument.',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
};

/**
 * Stands in for buildMcpServer(authContext). Mirrors its shape: a fresh low-level
 * Server per call, with handlers registered by method string.
 */
function buildServerFor(ctx: { era: string; authInfo?: AuthInfo; requestInfo?: Request }): Server {
  const authHeader = ctx.requestInfo?.headers.get('authorization') ?? null;
  const extra = (ctx.authInfo as (AuthInfo & { extra?: { agentId?: string } }) | undefined)?.extra;
  seen.push({
    era: ctx.era,
    hasAuthInfo: ctx.authInfo !== undefined,
    authHeader,
    ...(extra?.agentId ? { agentId: extra.agentId } : {}),
  });

  const server = new Server(
    { name: 'wiring-test', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({ tools: [TOOL] }));
  server.setRequestHandler('tools/call', async (req) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ echoed: req.params.arguments?.['msg'] ?? null }) }],
  }));
  return server;
}

const mcpHandler = createMcpHandler((ctx) => buildServerFor(ctx), { onerror: () => {} });
const nodeHandler = toNodeHandler(mcpHandler, { onerror: () => {} });

const app = express();
app.use(express.json({ limit: '4mb' }));

// Middleware that populates req.auth the way requireBearerAuth does, so the
// authInfo-threading path is exercised without standing up an OAuth server.
app.use((req, _res, next) => {
  const h = req.headers.authorization;
  if (h === 'Bearer good-token') {
    (req as express.Request & { auth?: AuthInfo }).auth = {
      token: 'good-token',
      clientId: 'test-client',
      scopes: ['mcp'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { agentId: 'did:example:agent' },
    } as AuthInfo;
  }
  next();
});

// ★ THE WIRING UNDER TEST. The third argument is what makes this work.
app.post('/mcp-correct', (req, res) => {
  void nodeHandler(req, res, (req as express.Request & { body?: unknown }).body);
});
app.get('/mcp-correct', (req, res) => {
  void nodeHandler(req, res, (req as express.Request & { body?: unknown }).body);
});
app.delete('/mcp-correct', (req, res) => {
  void nodeHandler(req, res, (req as express.Request & { body?: unknown }).body);
});

// The mistake, mounted alongside so the test can prove it IS a mistake rather than
// asserting a claim about it. Express passes `next` as the third argument.
app.post('/mcp-mounted-bare', nodeHandler as unknown as express.RequestHandler);

const server = app.listen(0);
await new Promise<void>((r) => server.once('listening', () => r()));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

type Res = { status: number; ct: string; text: string; json?: Record<string, unknown> };
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> | undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* SSE or non-JSON */ }
  return { status: r.status, ct: r.headers.get('content-type') ?? '', text, json };
}

const ACCEPT_BOTH = { Accept: 'application/json, text/event-stream' };
/** Pull the JSON-RPC payload out of either a plain JSON body or an SSE frame. */
function payload(res: Res): Record<string, any> | undefined {
  if (res.json) return res.json;
  const m = /^data: (.*)$/m.exec(res.text);
  if (!m?.[1]) return undefined;
  try { return JSON.parse(m[1]); } catch { return undefined; }
}

console.log('\n/mcp: the Express <-> SDK v2 seam');

try {
  // ── The body must actually arrive ────────────────────────────────────────
  const list = await post('/mcp-correct', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, ACCEPT_BOTH);
  const listBody = payload(list);
  ok(list.status === 200, 'tools/list is served', `HTTP ${list.status}`);
  ok(Array.isArray(listBody?.result?.tools), 'the parsed body reached the SDK', list.text.slice(0, 160));
  ok(listBody?.result?.tools?.[0]?.name === 'wiring.echo', 'the tool surface came back', JSON.stringify(listBody?.result?.tools));

  const call = await post('/mcp-correct', {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'wiring.echo', arguments: { msg: 'hello' } },
  }, ACCEPT_BOTH);
  const callBody = payload(call);
  const echoed = callBody?.result?.content?.[0]?.text;
  ok(typeof echoed === 'string' && JSON.parse(echoed).echoed === 'hello',
    'tools/call arguments survive the seam', String(echoed));

  // ── …and mounting it bare must NOT work ──────────────────────────────────
  // This is the assertion that gives the wrapper its reason to exist. If a future
  // edit "simplifies" the route to `app.post('/mcp', mcpGate, nodeHandler)`, this
  // flips and says so.
  const bare = await post('/mcp-mounted-bare', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, ACCEPT_BOTH);
  const bareBody = payload(bare);
  const bareServedTools = Array.isArray(bareBody?.result?.tools);
  ok(!bareServedTools,
    'mounting toNodeHandler bare does NOT serve the request (express passes `next` as the 3rd arg, so the body is lost)',
    `HTTP ${bare.status} ${bare.text.slice(0, 140)}`);

  // ── 2025 session operations still answer 405 ─────────────────────────────
  // The old transport was constructed with `sessionIdGenerator: undefined`; the v2
  // stateless legacy leg does the same internally, so GET/DELETE keep answering 405
  // rather than becoming a route that appears to work.
  for (const method of ['GET', 'DELETE'] as const) {
    const r = await fetch(`${base}/mcp-correct`, { method, headers: ACCEPT_BOTH });
    ok(r.status === 405, `${method} /mcp answers 405 (no session operations)`, `HTTP ${r.status}`);
  }

  // ── authInfo threading ───────────────────────────────────────────────────
  seen.length = 0;
  await post('/mcp-correct', { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
    { ...ACCEPT_BOTH, Authorization: 'Bearer good-token' });
  ok(seen.length > 0, 'the factory ran');
  ok(seen[0]?.hasAuthInfo === true, 'req.auth is forwarded to the factory as ctx.authInfo');
  ok(seen[0]?.agentId === 'did:example:agent', 'the identity in extra survives', String(seen[0]?.agentId));

  // ── requestInfo carries the raw Authorization header ─────────────────────
  // The legacy RELAY_MCP_API_KEY path reads the header directly, and it reads it from
  // ctx.requestInfo. If that were ever absent, resolveAuthContext would return null —
  // which is OPEN MODE, not a refusal. So the header has to be genuinely reachable.
  seen.length = 0;
  await post('/mcp-correct', { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
    { ...ACCEPT_BOTH, Authorization: 'Bearer some-api-key' });
  ok(seen[0]?.authHeader === 'Bearer some-api-key',
    'ctx.requestInfo exposes the Authorization header (the API-key path depends on it)',
    String(seen[0]?.authHeader));

  // ── one fresh instance per request ───────────────────────────────────────
  seen.length = 0;
  await post('/mcp-correct', { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, ACCEPT_BOTH);
  await post('/mcp-correct', { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }, ACCEPT_BOTH);
  ok(seen.length === 2, 'the factory is called once per HTTP request', `called ${seen.length} time(s)`);

  // ── a 2025-era client is still served ────────────────────────────────────
  const init = await post('/mcp-correct', {
    jsonrpc: '2.0', id: 8, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' } },
  }, ACCEPT_BOTH);
  const initBody = payload(init);
  ok(initBody?.result?.protocolVersion === '2025-11-25',
    'a 2025-era initialize is negotiated, not rejected (claude.ai / ChatGPT connectors today)',
    String(initBody?.result?.protocolVersion));

  // ── and a 2026-07-28 client is served from the SAME factory ──────────────
  const modern = await post('/mcp-correct', {
    jsonrpc: '2.0', id: 9, method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }, { ...ACCEPT_BOTH, 'Mcp-Method': 'server/discover' });
  const modernBody = payload(modern);
  ok(Array.isArray(modernBody?.result?.supportedVersions)
    && modernBody.result.supportedVersions.includes('2026-07-28'),
    'server/discover advertises 2026-07-28 from the same factory',
    modern.text.slice(0, 200));
} finally {
  server.close();
}

console.log(failures === 0
  ? `\n${'-'.repeat(60)}\nAll /mcp transport-wiring checks passed.\n`
  : `\n${failures} /mcp transport-wiring check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
