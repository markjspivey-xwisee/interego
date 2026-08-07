#!/usr/bin/env tsx
/**
 * CAN AN MCP CLIENT COMPLETE A HANDSHAKE AGAINST `GET /sse`? Asked of the live relay, with a
 * disposable identity's real OAuth bearer, using the protocol's OWN client implementation.
 *
 * ★ WHY THIS EXISTS. Five documents (README, docs/FIRST-HOUR.md, docs/MOBILE-PARITY.md,
 * docs/AGENT-INTEGRATION-GUIDE.md, deploy/mcp-relay/OAUTH-SETUP.md) told a reader that `/sse`
 * is the legacy MCP HTTP+SSE transport and that a client whose only transport is SSE should
 * point at it instead of `/mcp`. Anybody who followed that instruction got a client that hangs
 * and then times out, with nothing on either side saying why. Reading `server.ts` is enough to
 * SUSPECT that — the handler writes two bespoke `data:` frames and never an `event:` line — but
 * suspicion is not measurement, and the docs had survived several readings already.
 *
 * ── WHAT THE TRANSPORT REQUIRES, AND WHAT IS CHECKED ────────────────────────
 *
 * MCP's HTTP+SSE transport (protocol revision 2024-11-05, deprecated by 2025-03-26 in favour
 * of Streamable HTTP) is a two-channel arrangement. The server MUST open the stream by sending
 * an SSE frame whose `event:` field is `endpoint` and whose `data:` field is the URI the client
 * is to POST its JSON-RPC messages to. Everything downstream depends on that one frame: the
 * client has no other way to learn the message URI, so without it there is no `initialize`,
 * no `initialized`, no `tools/list`, and no session.
 *
 * Three legs, each independently falsifiable:
 *
 *   1. RAW — read the first frames off `GET /sse` and report whether ANY carries `event:`.
 *      This is the leg that says WHAT the endpoint emits instead, verbatim, so a reader does
 *      not have to take leg 2's word for it.
 *   2. SDK — drive `SSEClientTransport` from `@modelcontextprotocol/sdk` (the reference
 *      implementation every MCP client is built on) at the endpoint and see whether
 *      `Client.connect()` resolves. This is the leg that answers the actual question, because
 *      "no MCP client can handshake here" is a claim about clients, not about frames.
 *   3. CONTROL — drive `StreamableHTTPClientTransport` at `/mcp` with the SAME bearer in the
 *      same run. ★ WITHOUT THIS THE PROBE IS WORTHLESS: a leg-2 failure has two explanations
 *      — the endpoint is not an MCP transport, or the bearer/relay/network is broken — and
 *      they are indistinguishable from leg 2 alone. A probe that cannot tell them apart would
 *      report "SSE is not MCP" about an expired token.
 *
 * ── EXIT CODE ───────────────────────────────────────────────────────────────
 *
 *   0 — the control connected AND `/sse` sent no `endpoint` frame AND the SDK client failed.
 *       The documented claim is false and the docs are what must change.
 *   1 — the SDK client CONNECTED over `/sse`. The endpoint is a real MCP SSE transport, the
 *       docs are right, and whatever prompted this probe was wrong.
 *   2 — inconclusive: the control failed, so nothing about `/sse` was established.
 *
 *   npx tsx tools/probe-sse-mcp-handshake-live.ts
 */

import { Wallet } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mintBearer } from '../applications/shared-workspace/tools/live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
/** Long enough that a slow first frame is not mistaken for a missing one; short enough to run. */
const HANDSHAKE_MS = 20_000;

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 68 - s.length))); };

/**
 * Read whole SSE frames off a response for a bounded window.
 *
 * Frames are returned RAW — `event:`, `id:` and `data:` lines intact — because the entire
 * question this probe asks is about a field that a `data:`-only reader would discard.
 */
async function readFrames(res: Response, ms: number): Promise<readonly string[]> {
  const out: string[] = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const stop = Date.now() + ms;
  let buf = '';
  while (Date.now() < stop) {
    const t = setTimeout(() => { void reader.cancel().catch(() => undefined); }, Math.max(1, stop - Date.now()));
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { clearTimeout(t); break; }
    clearTimeout(t);
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let nl = buf.indexOf('\n\n');
    while (nl >= 0) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (frame.trim() !== '') out.push(frame);
      nl = buf.indexOf('\n\n');
    }
  }
  void reader.cancel().catch(() => undefined);
  return out;
}

/** Race a connect against a deadline, because a transport that never handshakes never rejects. */
async function connectWithin(client: Client, transport: SSEClientTransport | StreamableHTTPClientTransport, ms: number): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('timed out after ' + (ms / 1000) + 's with no completed handshake'), ms);
  });
  try {
    const outcome = await Promise.race([
      client.connect(transport).then(() => null, (e: unknown) => 'rejected: ' + ((e as Error)?.message ?? String(e))),
      deadline,
    ]);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

async function run(): Promise<number> {
  head('a disposable identity, and a real bearer');
  const wallet = Wallet.createRandom();
  log('wallet   :', wallet.address, '(fresh — provisions its own pod)');
  const bearer = await mintBearer(RELAY, IDENTITY, wallet);
  log('bearer   : minted, method', bearer.method);
  const authHeader = { Authorization: 'Bearer ' + bearer.accessToken };

  // ── leg 3 first: establish that the bearer and the relay work AT ALL ───────
  // Run before the two /sse legs, so a broken precondition is reported as a broken
  // precondition rather than discovered after two failures that look like findings.
  head('CONTROL — Streamable HTTP at /mcp, same bearer');
  const control = new Client({ name: 'sse-handshake-probe-control', version: '1.0.0' }, { capabilities: {} });
  const controlTransport = new StreamableHTTPClientTransport(new URL(RELAY + '/mcp'), {
    requestInit: { headers: authHeader },
  });
  const controlFailure = await connectWithin(control, controlTransport, HANDSHAKE_MS);
  if (controlFailure !== null) {
    log('  RESULT : /mcp did NOT connect —', controlFailure);
    log('\nINCONCLUSIVE. The control failed, so nothing was established about /sse.');
    return 2;
  }
  log('  RESULT : /mcp connected. The bearer, the relay and this machine are all fine.');

  // ── leg 1: what does /sse actually put on the wire? ────────────────────────
  head('RAW — GET /sse, first frames, verbatim');
  const res = await fetch(RELAY + '/sse', { headers: { ...authHeader, Accept: 'text/event-stream' } });
  log('status   :', res.status, res.headers.get('content-type'));
  if (!res.ok) {
    log('body     :', (await res.text()).slice(0, 300));
    log('\nINCONCLUSIVE. /sse refused this bearer, so the frame question was never reached.');
    return 2;
  }
  // 6 s spans three ticks of the handler's 2 s interval — enough that a late `endpoint`
  // frame would have arrived, and short enough that the run stays interactive.
  const frames = await readFrames(res, 6_000);
  log('frames   :', frames.length);
  for (const f of frames) {
    for (const line of f.split('\n')) log('           | ' + line.slice(0, 200));
  }
  const anyEventField = frames.some((f) => /^event:/m.test(f));
  const endpointFrame = frames.some((f) => /^event:\s*endpoint\s*$/m.test(f));
  log('any `event:` field at all :', anyEventField ? 'YES' : 'no');
  log('an `event: endpoint` frame:', endpointFrame ? 'YES' : 'no');

  // ── leg 2: the reference client, at the endpoint the docs name ─────────────
  head('SDK — @modelcontextprotocol/sdk SSEClientTransport against /sse');
  const sse = new Client({ name: 'sse-handshake-probe', version: '1.0.0' }, { capabilities: {} });
  const sseTransport = new SSEClientTransport(new URL(RELAY + '/sse'), {
    // Both hooks carry the bearer: `eventSourceInit` is the GET that opens the stream,
    // `requestInit` is the POST the client would make once it learned a message endpoint.
    eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...authHeader } }) },
    requestInit: { headers: authHeader },
  });
  const sseFailure = await connectWithin(sse, sseTransport, HANDSHAKE_MS);
  if (sseFailure === null) {
    log('  RESULT : the SDK client CONNECTED over /sse.');
    log('\n/sse IS a working MCP SSE transport. The documentation is correct.');
    return 1;
  }
  log('  RESULT : the SDK client did not connect —', sseFailure);

  head('verdict');
  log('control (/mcp)              : connected');
  log('/sse `event: endpoint` frame: ' + (endpointFrame ? 'present' : 'ABSENT'));
  log('/sse MCP SDK handshake      : FAILED');
  log('');
  log('No MCP client can complete a handshake against /sse. The endpoint serves a bespoke');
  log('notification feed, not the MCP HTTP+SSE transport, and every document that points an');
  log('SSE-only client at it is telling that reader to do something that cannot work.');
  return 0;
}

void run().then((c) => process.exit(c), (e: unknown) => {
  log('THREW:', (e as Error)?.stack ?? String(e));
  process.exit(2);
});
