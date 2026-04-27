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
import { resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  InMemoryRelay,
  P2pClient,
  WebSocketRelayMirror,
  importWallet,
  generateKeyPair,
  type EncryptedShare,
  type DescriptorAnnouncement,
  type RelayConnectionStatus,
  type P2pRelay,
} from '@interego/core';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '5050', 10);

// Bind interface — defaults to all interfaces so Tailscale + LAN
// devices can reach it. Override to 127.0.0.1 if you want to
// firewall the bridge to the local machine only.
const BIND = process.env['BIND'] ?? '0.0.0.0';

// Bridge identity — your wallet's private key. If unset we mint a
// fresh one for the session (development only). Persist this for
// stable identity across restarts.
function loadOrMintKey(): string {
  const fromEnv = process.env['BRIDGE_KEY'];
  if (fromEnv) return fromEnv;
  // Hardhat default mnemonic key — DEV ONLY. Production deployments
  // MUST set BRIDGE_KEY to a real wallet private key.
  console.warn('[bridge] BRIDGE_KEY not set; using a public test key. Set BRIDGE_KEY in production.');
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

// ── Bridge state ─────────────────────────────────────────────

const wallet = importWallet(BRIDGE_KEY, 'agent', 'personal-bridge');
const encryptionKeyPair = generateKeyPair();
const innerRelay = new InMemoryRelay();

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
      onStatusChange: (s: RelayConnectionStatus) => {
        broadcastSseEvent('mirror-status', s as unknown as Record<string, unknown>);
        console.log(`[mirror] ${s.url} → ${s.state}${s.lastError ? ` (${s.lastError})` : ''}`);
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
    externalRelays: externalRelayUrls,
    externalRelayForwarding: externalRelayUrls.length === 0
      ? 'disabled (truly local-first)'
      : 'enabled (bidirectional WebSocket mirror, v1.1)',
    mirrorStatus: mirror ? mirror.status() : null,
    bind: `${BIND}:${PORT}`,
    note: 'Add wss://... URLs to EXTERNAL_RELAYS env var to broadcast events beyond this bridge.',
  };
}

// ── Express server ───────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '4mb' }));

// CORS — allow MCP clients from any origin, since this is your
// own bridge on your own network. Tighten if you expose it
// beyond your trust boundary.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

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

// ── MCP — minimal Streamable HTTP at /mcp ────────────────────
//
// JSON-RPC 2.0 per MCP spec. Three handlers:
//   initialize, tools/list, tools/call
//
// Any MCP client (Claude Code custom connector, claude.ai mobile,
// Cursor, etc.) configured with this URL will see + invoke the
// tools defined above.

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

app.post('/mcp', async (req, res) => {
  const reqBody = req.body as JsonRpcRequest;
  const { method, params, id } = reqBody;

  const respond = (result?: unknown, error?: { code: number; message: string }): void => {
    res.json(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  };

  if (method === 'initialize') {
    return respond({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: '@interego/personal-bridge', version: '0.1.0' },
      instructions: `Personal bridge for Interego — your local-first P2P hub. Bridge identity: ${client.pubkey}. Use publish_p2p / query_p2p for descriptor announcements; share_encrypted for 1:N encrypted shares; query_my_inbox + decrypt_share to read what's addressed to you. Sharing is per-publish (share_with) or per-bridge (EXTERNAL_RELAYS env var); local by default.`,
    });
  }

  if (method === 'tools/list') {
    return respond({
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === 'tools/call') {
    const name = String(params?.['name'] ?? '');
    const args = (params?.['arguments'] as Record<string, unknown> | undefined) ?? {};
    const tool = tools[name];
    if (!tool) {
      return respond(undefined, { code: -32601, message: `Unknown tool: ${name}` });
    }
    try {
      const result = await tool.handler(args);
      return respond({
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      });
    } catch (err) {
      return respond(undefined, {
        code: -32000,
        message: `Tool error: ${(err as Error).message}`,
      });
    }
  }

  // Notifications (no id) and unknown methods
  if (id === null || id === undefined) {
    return res.status(202).end();
  }
  return respond(undefined, { code: -32601, message: `Unknown method: ${method}` });
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
// Skip auto-listen when imported under vitest (NODE_ENV=test) so the
// test suite can import + exercise the tools directly without
// spawning a real HTTP listener.

if (process.env['NODE_ENV'] !== 'test') {
  // Start the mirror (open WebSocket connections to external relays)
  if (mirror) mirror.start();

  app.listen(PORT, BIND, () => {
    console.log(`\n@interego/personal-bridge running`);
    console.log(`  Bind:           http://${BIND}:${PORT}`);
    console.log(`  Bridge pubkey:  ${client.pubkey}`);
    console.log(`  Signing:        ${SIGNING_SCHEME}`);
    console.log(`  Encryption pk:  ${encryptionKeyPair.publicKey}`);
    console.log(`  External relays: ${externalRelayUrls.length === 0 ? '(none — fully local)' : externalRelayUrls.join(', ')}`);
    console.log(`\nPoint your MCP clients at:`);
    console.log(`  http://<your-host>:${PORT}/mcp`);
    console.log(`\nAdmin UI:  http://<your-host>:${PORT}/`);
    console.log(`Status:    http://<your-host>:${PORT}/status\n`);
  });
}

export { app, tools, bridgeStatus, client };
