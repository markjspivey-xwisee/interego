/**
 * The MCP wire contract of the mount every vertical inherits.
 *
 * ★ WHY THIS FILE EXISTS. `POST /mcp` in the shared vertical-bridge mount is
 * hand-rolled JSON-RPC — no SDK — and it is the surface seven bridges expose, two
 * of them as live public services (foxxi-bridge, bridge). Its exact response
 * envelope is depended on by code that CANNOT report a mismatch:
 *
 *   - the foxxi dashboard SPA reads `j.result.content[0].text` and JSON.parses it,
 *     and reads `j.error.message` on failure;
 *   - the interego microsite calls `tools/list` and REFUSES to invoke any capability
 *     absent from the manifest, so a shape change makes it quietly decline
 *     everything rather than fail loudly;
 *   - ten demo scenarios and the real `claude` CLI (via demos/agent-lib.ts) post
 *     against it directly.
 *
 * Every one of those is a browser or a subprocess that turns an envelope change into
 * silence, not an error. So this file pins the envelope BEFORE it is migrated, and
 * each assertion below is a decision the migration has to make deliberately.
 *
 * ★ WHAT IT IS NOT. It is not an assertion that the current contract is correct — it
 * is not. `initialize` answers a hard-coded `2024-11-05` whatever the client asked
 * for, and there is no input validation at all. Those are recorded here as
 * `MIGRATION DELTA` so that changing them is visible in a diff rather than
 * discovered in production.
 *
 * BEHAVIOURAL — it boots the real mount and speaks JSON-RPC to it.
 *
 * Run: npx tsx applications/_shared/vertical-bridge/mcp-wire-contract.test.ts
 */
import { createVerticalBridge } from './index.js';
import type { Affordance } from '../affordance-mcp/index.js';

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

const PORT = 6098;
const BASE = `http://localhost:${PORT}`;

const affordances = [
  {
    action: 'urn:iep:action:demo:ping',
    toolName: 'demo.ping',
    title: 'Ping',
    description: 'Returns pong.',
    method: 'POST',
    targetTemplate: '{base}/demo/ping',
    inputs: [{ name: 'msg', type: 'string', required: true, description: 'What to echo.' }],
    outputs: { description: 'The echo.' },
  },
  {
    action: 'urn:iep:action:demo:explode',
    toolName: 'demo.explode',
    title: 'Explode',
    description: 'Always throws.',
    method: 'POST',
    targetTemplate: '{base}/demo/explode',
    inputs: [],
  },
  // An externally-routed affordance carries bespoke auth and is deliberately listed
  // but not invocable as a named tool. tools/check-foxxi-affordances.mjs ENFORCES
  // that these appear in tools/list, so the migration may not quietly drop them.
  {
    action: 'urn:iep:action:demo:upload',
    toolName: 'demo.upload',
    title: 'Upload',
    description: 'Externally routed.',
    method: 'PUT',
    targetTemplate: '{base}/demo/upload',
    inputs: [],
    externallyRouted: true,
  },
] as unknown as Affordance[];

const app = createVerticalBridge({
  verticalName: 'wire-contract-test',
  affordances,
  handlers: {
    'demo.ping': async (a: Record<string, unknown>) => ({ pong: a.msg }),
    'demo.explode': async () => { throw new Error('deliberate handler failure'); },
  },
  deploymentUrl: BASE,
});
const server = app.listen(PORT);

/** Post exactly what our existing clients post: bare JSON-RPC, no Accept header. */
const rpc = async (method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  const text = await r.text();
  let json: Record<string, unknown> | undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* left undefined */ }
  return { status: r.status, type: r.headers.get('content-type') ?? '', text, json: json as any };
};

console.log('\nPOST /mcp: the envelope seven bridges inherit and four deployed clients parse');

try {
  // ── A bare POST with no Accept header must work ──────────────────────────
  // Every client we ship sends exactly this: Content-Type: application/json, no
  // Accept, no prior initialize. An SDK-backed Streamable HTTP transport answers
  // this shape with 406 unless the mount normalises it, so this is the single most
  // load-bearing assertion in the file.
  const list = await rpc('tools/list', {});
  check('a bare POST with no Accept header is served', list.status === 200, `HTTP ${list.status}`);
  check('…as plain JSON, not an SSE stream', /application\/json/.test(list.type), list.type);
  check('…with no prior initialize handshake', Array.isArray(list.json?.result?.tools), list.text.slice(0, 120));

  // ── tools/list ───────────────────────────────────────────────────────────
  const tools: Array<{ name: string; inputSchema?: Record<string, unknown> }> = list.json?.result?.tools ?? [];
  check('tools/list returns one tool per affordance', tools.length === affordances.length, String(tools.length));
  check('…named by toolName', tools.map(t => t.name).sort().join(',') === 'demo.explode,demo.ping,demo.upload',
    tools.map(t => t.name).join(','));
  check('…including the externally-routed one (a CI gate enforces this)',
    tools.some(t => t.name === 'demo.upload'));
  const ping = tools.find(t => t.name === 'demo.ping');
  check('…each carrying a derived inputSchema', !!ping?.inputSchema, JSON.stringify(ping));
  check('…that names required inputs',
    Array.isArray((ping?.inputSchema as any)?.required) && (ping!.inputSchema as any).required.includes('msg'),
    JSON.stringify(ping?.inputSchema));

  // ── tools/call, success ──────────────────────────────────────────────────
  // The result is JSON stringified into a single text content block. The dashboard
  // does JSON.parse(j.result.content[0].text), so both the nesting and the
  // stringification are contract, not detail.
  const ok = await rpc('tools/call', { name: 'demo.ping', arguments: { msg: 'hi' } });
  check('tools/call wraps the handler result in a text content block',
    ok.json?.result?.content?.[0]?.type === 'text', JSON.stringify(ok.json));
  check('…carrying the result as a JSON string',
    JSON.parse(ok.json?.result?.content?.[0]?.text ?? '{}').pong === 'hi',
    ok.json?.result?.content?.[0]?.text);
  // Every derived tool declares an outputSchema, which obliges the tool to return
  // conforming structuredContent. Additive: content[0].text above is unchanged.
  check('…and structuredContent alongside it (the outputSchema obligation)',
    ok.json?.result?.structuredContent?.pong === 'hi',
    JSON.stringify(ok.json?.result?.structuredContent));

  // ── tools/call, handler throws ───────────────────────────────────────────
  // MIGRATION DELTA, RESOLVED. The code changed from -32000 to -32603 when the mount
  // moved to the SDK. That is the right direction: -32603 is the JSON-RPC "Internal
  // error" code, while -32000 was a server-defined value this mount invented.
  //
  // What MATTERS is what did NOT change: it is still a JSON-RPC *error*, so
  // `j.error.message` — which is what the foxxi dashboard SPA reads on failure — still
  // resolves. The feared outcome was a successful result with `isError: true`, which
  // would have left the dashboard reading `undefined` and then JSON.parsing a bare
  // message string inside its own catch. Registering handlers through
  // McpServer.registerTool would produce exactly that, which is one of the reasons the
  // mount uses the low-level Server instead.
  const boom = await rpc('tools/call', { name: 'demo.explode', arguments: {} });
  check('a throwing handler is still reported as a JSON-RPC error, not an isError result',
    boom.json?.error !== undefined && boom.json?.result === undefined, JSON.stringify(boom.json));
  check('…with the JSON-RPC internal-error code', boom.json?.error?.code === -32603,
    String(boom.json?.error?.code));
  check('…carrying the handler message (the dashboard reads j.error.message)',
    boom.json?.error?.message === 'deliberate handler failure',
    String(boom.json?.error?.message));

  // ── tools/call, unknown tool ─────────────────────────────────────────────
  const unknown = await rpc('tools/call', { name: 'no.such.tool', arguments: {} });
  check('an unknown tool is -32601', unknown.json?.error?.code === -32601, JSON.stringify(unknown.json));

  // ── tools/call on an externally-routed affordance ────────────────────────
  // This is a hypermedia affordance, not an error: the response TELLS the caller the
  // HTTP method and resolved URL to use instead. Losing it turns a signpost into a
  // dead end, which is what a generic "tool not found" would be.
  const ext = await rpc('tools/call', { name: 'demo.upload', arguments: {} });
  check('an externally-routed tool is -32601', ext.json?.error?.code === -32601, JSON.stringify(ext.json));
  check('…and the message names the HTTP method to use instead',
    /PUT/.test(String(ext.json?.error?.message)), String(ext.json?.error?.message));
  check('…and the resolved target, not a {base} template',
    String(ext.json?.error?.message).includes(`${BASE}/demo/upload`), String(ext.json?.error?.message));

  // ── initialize ───────────────────────────────────────────────────────────
  // MIGRATION DELTA, RESOLVED — and this one was the point of the exercise.
  //
  // The mount used to answer a hard-coded `2024-11-05` and ignore what the client
  // asked for entirely (verified against both live bridges: a client requesting
  // 2026-07-28 was still told 2024-11-05). It now NEGOTIATES.
  //
  // A claim-less `initialize` is legacy-era by definition — the 2026-07-28 era is
  // selected by the per-request `_meta` envelope, not by asking for it in an
  // initialize — so requesting 2026-07-28 here is correctly answered with the SDK's
  // newest LEGACY revision rather than the modern one. A client that wants the modern
  // era sends `server/discover` with the envelope; that path is asserted below.
  const init = await rpc('initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' },
  });
  check('initialize NEGOTIATES rather than answering a hard-coded literal',
    init.json?.result?.protocolVersion === '2025-11-25', String(init.json?.result?.protocolVersion));
  const initLegacy = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' },
  });
  check('…and honours an older revision a client actually asks for',
    initLegacy.json?.result?.protocolVersion === '2024-11-05',
    String(initLegacy.json?.result?.protocolVersion));
  check('…and advertises a tools capability', !!init.json?.result?.capabilities?.tools,
    JSON.stringify(init.json?.result?.capabilities));
  check('…and identifies the server by vertical name',
    init.json?.result?.serverInfo?.name === 'interego-wire-contract-test-bridge',
    String(init.json?.result?.serverInfo?.name));
  check('…and carries instructions (the only advertisement channel on this mount)',
    typeof init.json?.result?.instructions === 'string' && init.json!.result.instructions.length > 0);

  // ── notifications and unknown methods ────────────────────────────────────
  // MIGRATION DELTA, RESOLVED: the ack is 200 rather than the hand-rolled 204. A
  // notification has no response body by definition, so no client reads it; asserted
  // only to pin that a notification is ACKNOWLEDGED and never answered with an error.
  const note = await rpc('notifications/initialized');
  check('notifications/initialized is acknowledged, not errored',
    note.status >= 200 && note.status < 300, `HTTP ${note.status}`);
  const bogus = await rpc('does/not/exist');
  check('an unknown method is -32601', bogus.json?.error?.code === -32601, JSON.stringify(bogus.json));

  // ── the 2026-07-28 era, from the same mount ──────────────────────────────
  // The whole reason for the migration: a modern client carries a per-request `_meta`
  // envelope and gets the modern era, served by the SAME affordance definitions that
  // answered the legacy initialize above — so the two eras cannot drift apart.
  const ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const discover = await rpc('server/discover', { _meta: ENVELOPE }, { 'Mcp-Method': 'server/discover' });
  check('server/discover advertises the 2026-07-28 era',
    Array.isArray(discover.json?.result?.supportedVersions)
      && discover.json.result.supportedVersions.includes('2026-07-28'),
    discover.text.slice(0, 160));
  const modernList = await rpc('tools/list', { _meta: ENVELOPE }, { 'Mcp-Method': 'tools/list' });
  check('…and the modern era serves the same tool surface',
    modernList.json?.result?.tools?.length === affordances.length,
    String(modernList.json?.result?.tools?.length));
  check('…with the CacheableResult fields the revision requires',
    typeof modernList.json?.result?.resultType === 'string'
      && modernList.json?.result?.cacheScope !== undefined,
    JSON.stringify({ resultType: modernList.json?.result?.resultType, cacheScope: modernList.json?.result?.cacheScope }));

  // ── MIGRATION DELTA: no input validation exists today ────────────────────
  // demo.ping declares msg as required, and the mount invokes the handler anyway.
  // The SDK validates against the derived schema and refuses. That is strictly
  // better, but it means calls that "worked" by passing undefined start failing —
  // which is a behaviour change for every caller across seven verticals.
  const unvalidated = await rpc('tools/call', { name: 'demo.ping', arguments: {} });
  check('a call violating the declared schema is NOT refused today',
    unvalidated.json?.result !== undefined, JSON.stringify(unvalidated.json));
} finally {
  server.close();
}

console.log(failures === 0
  ? '\nAll wire-contract checks passed.\n'
  : `\n${failures} wire-contract check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
