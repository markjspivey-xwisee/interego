/**
 * @interego/personal-bridge — your local-first P2P hub.
 *
 * One URL, all your devices. Data stays local by default; sharing is
 * per-thing (share_with) or per-bridge (add public relays as
 * broadcast destinations).
 *
 * What this binary is:
 *   - An MCP server (Streamable HTTP at POST /mcp) that any MCP
 *     client can connect to: claude.ai mobile (custom connector),
 *     ChatGPT app, Claude Code, Cursor, etc.
 *   - A REST + SSE surface for non-MCP clients.
 *   - A tiny admin UI at GET / for status + sharing config.
 *   - An embedded InMemoryRelay so no external Nostr relay is
 *     required for purely local-first operation. Optional WebSocket
 *     forwarders to public Nostr relays can be added per the README.
 *
 * Run:
 *   PORT=5050 BRIDGE_KEY=0x... node dist/server.js
 *   (Or use the included `npx` invocation once published.)
 *
 * No data leaves the bridge unless you explicitly opt in by:
 *   - Calling publish_p2p with `share_with: [...]` (per-publish)
 *   - Configuring `EXTERNAL_RELAYS` env var (per-bridge broadcast)
 */

import express, { type Request, type Response } from 'express';
import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError as McpProtocolError,
  Server as McpSdkServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Tool as McpTool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { protocolMembersOnly, acceptForSdkTransport } from '@interego/core';
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveEncryptionKeyPair,
  importWallet,
} from '@interego/core';
import {
  type DescriptorAnnouncement,
  type EncryptedShare,
  FileBackedRelay,
  InMemoryRelay,
  isInteregoEvent,
  P2pClient,
  type P2pRelay,
  type RelayConnectionStatus,
  WebSocketRelayMirror,
} from '@interego/p2p';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '5050', 10);

// Bind interface — defaults to all interfaces so Tailscale + LAN
// devices can reach it. Override to 127.0.0.1 if you want to
// firewall the bridge to the local machine only.
const BIND = process.env['BIND'] ?? '0.0.0.0';

// Transport: 'http' (default — Express server with /mcp + REST + admin
// UI) or 'stdio' (JSON-RPC over stdin/stdout, single-client, perfect
// for spawning from a Claude Code .mcp.json entry). Stdio mode skips
// the HTTP server entirely; logging goes to stderr only.
const TRANSPORT = (process.env['MCP_TRANSPORT'] ?? 'http') as 'http' | 'stdio';

// Logging — stderr only, never stdout. Stdout is reserved for the MCP
// protocol channel in stdio mode; using console.log there would
// corrupt the protocol stream.
function log(msg: string): void {
  process.stderr.write(`[bridge] ${msg}\n`);
}

// Bridge identity — your wallet's private key. If unset we mint a
// fresh one for the session (development only). Persist this for
// stable identity across restarts.
//
// Why this site keeps `importWallet(BRIDGE_KEY, …)` instead of
// composing `loadAgentKeypair` from `@interego/core`:
//   1. The bridge's published pubkey is `client.pubkey`, which P2pClient
//      sets to the wallet's CHECKSUMMED ethers address (`0xAbC…`).
//      `loadAgentKeypair` lowercases the address before exposing it,
//      which would silently rotate the bridge's on-relay identity for
//      every operator who upgrades. Identity preservation wins over
//      tidiness here.
//   2. `P2pClient` with `signingScheme: 'schnorr'` calls
//      `exportPrivateKey(wallet.address)`, which reads from the
//      in-process `walletKeys` map populated by `importWallet`.
//      `loadAgentKeypair` does not register the key there, so Schnorr
//      signing would break.
//   3. We need the RAW BRIDGE_KEY hex anyway for `deriveEncryptionKeyPair`
//      and `deriveStorageKey`, so the env-or-mint decision is still
//      meaningfully tied to a hex string the rest of this file consumes.
// The bridge-originated identity wrapper used by Foxxi
// (applications/foxxi-content-intelligence/src/bridge-signer.ts) does
// use `loadAgentKeypair` because it signs as a did:key author and
// never goes through P2pClient.
function loadOrMintKey(): string {
  const fromEnv = process.env['BRIDGE_KEY'];
  if (fromEnv) return fromEnv;
  // Hardhat default mnemonic key — DEV ONLY. Production deployments
  // MUST set BRIDGE_KEY to a real wallet private key.
  process.stderr.write('[bridge] BRIDGE_KEY not set; using a public test key. Set BRIDGE_KEY in production.\n');
  return '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
}

const BRIDGE_KEY = loadOrMintKey();
const SIGNING_SCHEME = (process.env['SIGNING_SCHEME'] ?? 'ecdsa') as 'ecdsa' | 'schnorr';

// Optional: public Nostr relays to mirror events to. Comma-separated
// wss:// URLs. EMPTY by default (truly local-first).
const EXTERNAL_RELAYS_RAW = process.env['EXTERNAL_RELAYS'] ?? '';
const externalRelayUrls = EXTERNAL_RELAYS_RAW
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Authors to subscribe to inbound from external relays. Empty by
// default = OUTBOUND-ONLY mode: your events go to the world, but
// you don't pull random kind-30040 events back. Set to
// comma-separated Nostr pubkeys (Schnorr x-only hex OR ECDSA 0x-
// address) of identities you explicitly want to follow. Apply
// after explicit consent — kind 30000-39999 is a shared range,
// auto-subscribe will pull in unrelated app traffic.
const INBOUND_AUTHORS_RAW = process.env['INBOUND_AUTHORS'] ?? '';
const inboundAuthors = INBOUND_AUTHORS_RAW
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Bridge state ─────────────────────────────────────────────

const wallet = importWallet(BRIDGE_KEY, 'agent', 'personal-bridge');

// X25519 encryption keypair, deterministically derived from
// BRIDGE_KEY. The same wallet always produces the same Curve25519
// keypair, so encrypted shares addressed to your bridge stay
// decryptable across restarts. Fresh-each-restart was the prior
// behavior; that broke the "wallet IS your identity" invariant
// because the encryption pubkey rotated even though the signing
// key didn't.
const encryptionKeyPair = deriveEncryptionKeyPair(BRIDGE_KEY);

// Persistent storage by default (events survive restarts). Override
// to a fresh path with BRIDGE_DATA_DIR, or set BRIDGE_PERSIST=0 to
// fall back to the volatile InMemoryRelay (useful for tests).
const BRIDGE_PERSIST = process.env['BRIDGE_PERSIST'] !== '0';
const BRIDGE_DATA_DIR = process.env['BRIDGE_DATA_DIR']
  ?? pathJoin(homedir(), '.interego-bridge');
const eventsFile = pathJoin(BRIDGE_DATA_DIR, 'events.jsonl');

// At-rest encryption ON by default. Storage key is derived
// deterministically from BRIDGE_KEY so the same wallet that signs
// events also opens the file — no separate key to manage. Anyone
// with read access to the file (curious sysadmin, accidental
// backup, malware) sees only opaque base64. Set BRIDGE_ENCRYPT=0
// only if you want plaintext on disk for inspection.
const BRIDGE_ENCRYPT = process.env['BRIDGE_ENCRYPT'] !== '0';
function deriveStorageKey(privateKeyHex: string): string {
  const seed = privateKeyHex.toLowerCase().replace(/^0x/, '') + ':interego-bridge-storage-v1';
  return createHash('sha256').update(seed, 'utf8').digest('base64');
}
const storageKey = BRIDGE_ENCRYPT ? deriveStorageKey(BRIDGE_KEY) : undefined;

const innerRelay: InMemoryRelay = BRIDGE_PERSIST
  ? new FileBackedRelay(eventsFile, {
      log,
      ...(storageKey ? { encryptionKey: storageKey } : {}),
    })
  : new InMemoryRelay();

// If external relays are configured, wrap the in-memory relay with
// a WebSocketRelayMirror so events flow bidirectionally:
//   - locally published events → broadcast to all external relays
//   - events arriving from external relays → injected into the
//     in-memory relay so local subscribers see them
// With EXTERNAL_RELAYS empty, the bridge stays purely local —
// nothing ever touches the network.
let mirror: WebSocketRelayMirror | null = null;
const relay: P2pRelay = externalRelayUrls.length === 0
  ? innerRelay
  : (mirror = new WebSocketRelayMirror(innerRelay, externalRelayUrls, {
      // Inbound: explicit allow-list only. With INBOUND_AUTHORS empty,
      // the mirror sends NO subscription request — outbound publishing
      // works fine, but no random kind-30040 traffic from unrelated
      // Nostr apps lands in your encrypted store.
      subscribeAuthors: inboundAuthors,
      // Defense in depth: even when subscribed to specific authors,
      // require events to have the Interego tag shape. Drops
      // kind-30040 events from those authors that aren't actually
      // Interego descriptors.
      inboundFilter: isInteregoEvent,
      onStatusChange: (s: RelayConnectionStatus) => {
        broadcastSseEvent('mirror-status', s as unknown as Record<string, unknown>);
        log(`[mirror] ${s.url} → ${s.state}${s.lastError ? ` (${s.lastError})` : ''}`);
      },
    }));

const client = new P2pClient(relay, wallet, {
  signingScheme: SIGNING_SCHEME,
  encryptionKeyPair,
});

// Live SSE connections (admin UI subscribes to bridge events)
type SseClient = { id: number; res: Response };
const sseClients: SseClient[] = [];
let nextSseId = 1;

function broadcastSseEvent(name: string, data: Record<string, unknown>): void {
  const payload = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.res.write(payload); } catch { /* swallow */ }
  }
}

// Subscribe to all descriptor + encrypted-share events on the local
// relay so the admin UI can show live activity.
client.subscribeDescriptors({}, (a) => {
  broadcastSseEvent('descriptor', a as unknown as Record<string, unknown>);
});

// ── MCP tool definitions ─────────────────────────────────────

interface ToolHandler {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const tools: Record<string, ToolHandler> = {
  publish_p2p: {
    description: 'Publish a descriptor announcement via the bridge. Local-only by default; pass `share_with` for per-publish encrypted sharing.',
    inputSchema: {
      type: 'object',
      properties: {
        descriptorId: { type: 'string' },
        cid: { type: 'string' },
        graphIri: { type: 'string' },
        facetTypes: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['descriptorId', 'cid', 'graphIri'],
    },
    handler: async (args) => {
      const result = await client.publishDescriptor({
        descriptorId: String(args['descriptorId']),
        cid: String(args['cid']),
        graphIri: String(args['graphIri']),
        facetTypes: (args['facetTypes'] as string[] | undefined) ?? [],
        summary: args['summary'] as string | undefined,
      });
      return { ok: true, ...result };
    },
  },
  query_p2p: {
    description: 'Query descriptor announcements on the bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        author: { type: 'string' },
        graphIri: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    handler: async (args) => {
      const filter: { author?: string; graphIri?: string; limit?: number } = {};
      if (args['author']) filter.author = String(args['author']);
      if (args['graphIri']) filter.graphIri = String(args['graphIri']);
      if (args['limit']) filter.limit = Number(args['limit']);
      return await client.queryDescriptors(filter);
    },
  },
  share_encrypted: {
    description: 'Encrypt a payload to one or more recipients. Each recipient needs both their signing pubkey (for filtering) and X25519 encryption pubkey (for the envelope).',
    inputSchema: {
      type: 'object',
      properties: {
        plaintext: { type: 'string' },
        recipients: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sigPubkey: { type: 'string' },
              encryptionPubkey: { type: 'string' },
            },
            required: ['sigPubkey', 'encryptionPubkey'],
          },
        },
        topic: { type: 'string' },
      },
      required: ['plaintext', 'recipients'],
    },
    handler: async (args) => {
      const result = await client.publishEncryptedShare({
        plaintext: String(args['plaintext']),
        recipients: args['recipients'] as { sigPubkey: string; encryptionPubkey: string }[],
        senderEncryptionKeyPair: encryptionKeyPair,
        topic: args['topic'] as string | undefined,
      });
      return { ok: true, ...result };
    },
  },
  query_my_inbox: {
    description: 'Query encrypted shares addressed to this bridge\'s identity. Returns events with the envelope opaque; call decrypt_share to open one.',
    inputSchema: {
      type: 'object',
      properties: {
        fromSender: { type: 'string' },
      },
    },
    handler: async (args) => {
      const filter: { recipientSigPubkey: string; fromSender?: string } = {
        recipientSigPubkey: client.pubkey,
      };
      if (args['fromSender']) filter.fromSender = String(args['fromSender']);
      const inbox = await client.queryEncryptedShares(filter);
      return inbox.map((s) => ({
        eventId: s.eventId,
        sender: s.sender,
        publishedAt: s.publishedAt,
        topic: s.topic,
        // Don't include the raw envelope in the listing; require an
        // explicit decrypt_share call to read it.
      }));
    },
  },
  decrypt_share: {
    description: 'Decrypt an encrypted share by event id. Returns plaintext or null if this bridge isn\'t a recipient.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
    handler: async (args) => {
      const inbox = await client.queryEncryptedShares({ recipientSigPubkey: client.pubkey });
      const target = inbox.find((s) => s.eventId === args['eventId']);
      if (!target) return { ok: false, reason: 'No share with that event id addressed to this bridge' };
      const plaintext = client.decryptEncryptedShare(target);
      return { ok: plaintext !== null, plaintext };
    },
  },
  bridge_status: {
    description: 'Report bridge identity, signing scheme, encryption pubkey, external relay forwarding, and event count.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => bridgeStatus(),
  },
};

function bridgeStatus(): Record<string, unknown> {
  return {
    bridgePubkey: client.pubkey,
    signingScheme: SIGNING_SCHEME,
    encryptionPubkey: encryptionKeyPair.publicKey,
    relayEventCount: innerRelay.size(),
    persistence: BRIDGE_PERSIST
      ? {
          mode: 'file-backed',
          path: eventsFile,
          atRestEncryption: BRIDGE_ENCRYPT
            ? 'NaCl XSalsa20-Poly1305, key derived from BRIDGE_KEY'
            : 'disabled (plaintext on disk — set BRIDGE_ENCRYPT=1 to enable)',
        }
      : { mode: 'in-memory', path: null, atRestEncryption: 'n/a' },
    externalRelays: externalRelayUrls,
    externalRelayForwarding: externalRelayUrls.length === 0
      ? 'disabled (truly local-first)'
      : 'enabled (bidirectional WebSocket mirror, v1.1)',
    inbound: {
      mode: inboundAuthors.length === 0 ? 'outbound-only' : 'allow-list',
      followingAuthors: inboundAuthors,
      structuralFilter: 'isInteregoEvent (drops events without Interego tag shape)',
    },
    mirrorStatus: mirror ? mirror.status() : null,
    bind: `${BIND}:${PORT}`,
    note: 'Persistence: events survive restarts. Set BRIDGE_PERSIST=0 to use volatile in-memory storage. Add wss://... to EXTERNAL_RELAYS to broadcast events beyond this bridge.',
  };
}

// ── Express server ───────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '4mb' }));

// CORS — allow MCP clients from any origin, since this is your
// own bridge on your own network. Tighten if you expose it
// beyond your trust boundary.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Mcp-Method / Mcp-Name are required on protocol revision 2026-07-28, which this
  // bridge now serves; a browser cannot send a header the preflight did not allow.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version, Mcp-Method, Mcp-Name');
  // ★ Answer the preflight HERE rather than with `app.options('*', …)`.
  //
  // That route form is Express 4 only: under Express 5's path-to-regexp a bare `*` is
  // not a valid path and throws `Missing parameter name at index 1: *` AT MODULE LOAD —
  // the whole server fails to start. This example pins express ^4 locally, but the
  // workspace root is on ^5, so which one resolves depends on whether this directory's
  // own node_modules is installed. It worked on a dev machine and threw in CI.
  //
  // A middleware is correct under both majors and needs no version-specific wildcard
  // syntax, so this cannot break again when the pin moves.
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── Admin UI ─────────────────────────────────────────────────

app.get('/', (_req, res) => {
  const path = resolve(__dirname, 'index.html');
  if (existsSync(path)) {
    res.setHeader('Content-Type', 'text/html');
    res.send(readFileSync(path, 'utf8'));
  } else {
    res.send('<h1>@interego/personal-bridge</h1><p>index.html not found at ' + path + '</p>');
  }
});

// ── Status + REST ────────────────────────────────────────────

app.get('/status', (_req, res) => {
  res.json(bridgeStatus());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`event: hello\ndata: ${JSON.stringify(bridgeStatus())}\n\n`);
  const id = nextSseId++;
  sseClients.push({ id, res });
  req.on('close', () => {
    const idx = sseClients.findIndex((c) => c.id === id);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// ── MCP request handler — transport-agnostic ─────────────────
//
// JSON-RPC 2.0 per MCP spec. Used by both the HTTP /mcp endpoint
// and the stdio mode below. Returns the response object (or null
// for notifications), never throws — protocol errors are encoded
// as JSON-RPC `error` objects.

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Build a fresh MCP server.
 *
 * ★ WAS A HAND-ROLLED `handleMcpRequest` ADVERTISING A HARD-CODED `2024-11-05`, driven
 * by two transports (an Express route and a stdin line-reader) that each re-implemented
 * framing. It ignored the protocol version the client asked for entirely.
 *
 * Now on MCP SDK v2, one factory serves BOTH eras and BOTH transports: the 2025
 * `initialize` handshake and the 2026-07-28 revision, which has no handshake and
 * answers `server/discover`. The SDK owns framing, negotiation and error shape; this
 * file owns tools.
 *
 * A FACTORY, not one shared instance: `serveStdio` calls it once per connection AND
 * once for an optimistic `server/discover` probe, closing the probe instance when a
 * client falls back to the older handshake.
 */
function buildMcpServer(): McpSdkServer {
  const server = new McpSdkServer(
    { name: '@interego/personal-bridge', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: `Personal bridge for Interego — your local-first P2P hub. Bridge identity: ${client.pubkey}. Use publish_p2p / query_p2p for descriptor announcements; share_encrypted for 1:N encrypted shares; query_my_inbox + decrypt_share to read what's addressed to you. Sharing is per-publish (share_with) or per-bridge (EXTERNAL_RELAYS env var); local by default.`,
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  } as unknown as { tools: McpTool[] }));

  server.setRequestHandler('tools/call', async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = tools[name];
    // -32601 preserved: it is what this bridge answered for an unknown tool before.
    if (!tool) throw new McpProtocolError(-32601, `Unknown tool: ${name}`);
    try {
      const result = await tool.handler(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      throw new McpProtocolError(-32000, `Tool error: ${(err as Error).message}`);
    }
  });

  return server;
}

const mcpModernHandler = createMcpHandler(buildMcpServer, {
  legacy: 'reject',
  responseMode: 'json',
  onerror: () => { /* per-request failures surface in the JSON-RPC response */ },
});

/** The 2025-era leg, answering plain JSON rather than SSE frames. */
async function serveMcpLegacy(request: globalThis.Request): Promise<globalThis.Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Honoured by the v2 runtime but absent from the published types. Without it the
    // transport SSE-frames every reply, and this bridge's admin UI calls res.json().
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]);
  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * Serve one MCP request over HTTP. Exported so the test suite can drive the REAL
 * protocol path — the previous test called an internal dispatch function directly and
 * therefore never exercised framing, negotiation or era routing at all.
 */
export async function serveMcpOverHttp(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const h = new Headers({ 'content-type': 'application/json', ...headers });
  h.set('accept', acceptForSdkTransport(h.get('accept') ?? undefined));
  const request = new globalThis.Request('http://localhost/mcp', {
    method: 'POST',
    headers: h,
    body: JSON.stringify(protocolMembersOnly(body)),
  });
  const out = await (await isLegacyRequest(request.clone())
    ? serveMcpLegacy(request)
    : mcpModernHandler.fetch(request));
  const text = await out.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: out.status, body: parsed };
}

app.post('/mcp', async (req, res) => {
  const { status, body } = await serveMcpOverHttp(req.body, {
    ...(typeof req.headers['mcp-method'] === 'string' ? { 'mcp-method': req.headers['mcp-method'] } : {}),
    ...(typeof req.headers['mcp-name'] === 'string' ? { 'mcp-name': req.headers['mcp-name'] } : {}),
  });
  if (body === undefined) { res.status(status).end(); return; }
  res.status(status).json(body);
});

// REST mirrors of the MCP tools — for non-MCP clients (curl,
// custom apps, the admin UI's own JS).

app.post('/api/publish', async (req, res) => {
  try { res.json(await tools['publish_p2p']!.handler(req.body)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post('/api/query', async (req, res) => {
  try { res.json(await tools['query_p2p']!.handler(req.body)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post('/api/share', async (req, res) => {
  try { res.json(await tools['share_encrypted']!.handler(req.body)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post('/api/inbox', async (req, res) => {
  try { res.json(await tools['query_my_inbox']!.handler(req.body)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// ── Start ────────────────────────────────────────────────────
// Skip auto-start when imported under vitest (NODE_ENV=test) so the
// test suite can import + exercise the handler directly without
// spawning a listener or stealing stdin.

async function startStdioTransport(): Promise<void> {
  // ★ WAS A HAND-ROLLED LINE READER over stdin that re-implemented JSON-RPC framing and
  // answered a hard-coded protocol version. `serveStdio` owns framing, the era decision
  // and the `server/discover` probe — from the SAME factory the HTTP transport uses, so
  // the two can never advertise different tools or different revisions.
  log(`stdio transport active (bridge pubkey: ${client.pubkey})`);
  log(`external relays: ${externalRelayUrls.length === 0 ? '(none — fully local)' : externalRelayUrls.join(', ')}`);
  serveStdio(buildMcpServer);
}

if (process.env['NODE_ENV'] !== 'test') {
  if (mirror) mirror.start();

  if (TRANSPORT === 'stdio') {
    void startStdioTransport();
  } else {
    app.listen(PORT, BIND, () => {
      log('');
      log(`@interego/personal-bridge running`);
      log(`  Bind:            http://${BIND}:${PORT}`);
      log(`  Bridge pubkey:   ${client.pubkey}`);
      log(`  Signing:         ${SIGNING_SCHEME}`);
      log(`  Encryption pk:   ${encryptionKeyPair.publicKey}`);
      log(`  External relays: ${externalRelayUrls.length === 0 ? '(none — fully local)' : externalRelayUrls.join(', ')}`);
      log(``);
      log(`Point your MCP clients at:`);
      log(`  http://<your-host>:${PORT}/mcp`);
      log(``);
      log(`Admin UI:  http://<your-host>:${PORT}/`);
      log(`Status:    http://<your-host>:${PORT}/status`);
    });
  }
}

export { app, tools, bridgeStatus, client };
