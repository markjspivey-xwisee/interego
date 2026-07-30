/**
 * Personal bridge smoke test.
 *
 * Imports the bridge's Express app + tools directly (not over HTTP)
 * and exercises every tool via the same handlers the MCP /mcp
 * endpoint dispatches to. This proves end-to-end that the bridge's
 * publish → query → share → inbox → decrypt round-trips work.
 *
 * For an actual HTTP smoke (curl + JSON-RPC), see the README's Quick
 * start section — that's a manual / CI-deployment-time check.
 */

import { describe, it, expect } from 'vitest';
import { tools, bridgeStatus, client, serveMcpOverHttp } from '../examples/personal-bridge/server.js';
import {
  generateKeyPair,
  importWallet,
} from '@interego/core';
import {
  InMemoryRelay,
  P2pClient,
} from '@interego/p2p';

describe('personal-bridge — tool surface', () => {
  it('bridge_status reports identity and local-first defaults', async () => {
    const status = await tools.bridge_status!.handler({});
    expect(status).toMatchObject({
      bridgePubkey: client.pubkey,
      signingScheme: 'ecdsa',
      externalRelayForwarding: 'disabled (truly local-first)',
    });
  });

  it('publish_p2p → query_p2p round-trips a descriptor', async () => {
    const pub = await tools.publish_p2p!.handler({
      descriptorId: 'urn:iep:bridge-test:1',
      cid: 'bafkrei-bridge-1',
      graphIri: 'urn:graph:bridge-test',
      summary: 'first',
    }) as { ok: boolean; eventId: string };
    expect(pub.ok).toBe(true);
    expect(pub.eventId).toMatch(/^[0-9a-f]{64}$/);

    const q = await tools.query_p2p!.handler({ graphIri: 'urn:graph:bridge-test' }) as Array<{ descriptorId: string }>;
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q.find(x => x.descriptorId === 'urn:iep:bridge-test:1')).toBeDefined();
  });

  it('share_encrypted → query_my_inbox → decrypt_share works for a recipient on the same bridge', async () => {
    // The bridge sends to itself (its own signing pubkey + its own
    // encryption key). This validates that the encryption + envelope
    // wrap/unwrap path works end-to-end through the bridge tools.
    const status = bridgeStatus() as { bridgePubkey: string; encryptionPubkey: string };
    const share = await tools.share_encrypted!.handler({
      plaintext: 'secret message via bridge',
      recipients: [{
        sigPubkey: status.bridgePubkey,
        encryptionPubkey: status.encryptionPubkey,
      }],
      topic: 'test',
    }) as { ok: boolean; eventId: string };
    expect(share.ok).toBe(true);

    const inbox = await tools.query_my_inbox!.handler({}) as Array<{ eventId: string }>;
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    expect(inbox.find(s => s.eventId === share.eventId)).toBeDefined();

    const decrypted = await tools.decrypt_share!.handler({ eventId: share.eventId }) as { ok: boolean; plaintext: string | null };
    expect(decrypted.ok).toBe(true);
    expect(decrypted.plaintext).toBe('secret message via bridge');
  });

  it('decrypt_share returns ok=false for an unknown event id', async () => {
    const r = await tools.decrypt_share!.handler({ eventId: '0'.repeat(64) }) as { ok: boolean; reason?: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBeDefined();
  });

  // ── The MCP protocol surface ───────────────────────────────────────────
  //
  // ★ THESE USED TO CALL AN INTERNAL DISPATCH FUNCTION DIRECTLY, so they never
  // exercised framing, negotiation or era routing — the parts the SDK now owns and the
  // parts most likely to break. They now go through serveMcpOverHttp, the same path the
  // Express route uses, so what is asserted is what a client actually receives.

  it('initialize NEGOTIATES the revision the client asks for (was hard-coded 2024-11-05)', async () => {
    for (const requested of ['2024-11-05', '2025-11-25']) {
      const { body } = await serveMcpOverHttp({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
      const result = (body as { result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string }; instructions: string } }).result;
      expect(result.protocolVersion, `asked for ${requested}`).toBe(requested);
      expect(result.capabilities.tools).toBeDefined();
      expect(result.serverInfo.name).toBe('@interego/personal-bridge');
      expect(result.instructions).toContain(client.pubkey);
    }
  });

  it('server/discover advertises the 2026-07-28 era from the same tool registry', async () => {
    const { body } = await serveMcpOverHttp({
      jsonrpc: '2.0', id: 2, method: 'server/discover',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    }, { 'mcp-method': 'server/discover' });
    const result = (body as { result: { supportedVersions: string[] } }).result;
    expect(result.supportedVersions).toContain('2026-07-28');
  });

  it('tools/list → all 6 core p2p tools present with schemas', async () => {
    // Generic personal-bridge is foundation-layer ONLY: 6 core p2p tools.
    // Vertical tooling (lpc.* / adp.* / lrs.* / ac.*) is provided by
    // separate per-vertical bridges under applications/<vertical>/bridge/
    // — those have their own MCP servers and their own tests.
    const { body } = await serveMcpOverHttp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const result = (body as { result: { tools: { name: string; description: string; inputSchema: object }[] } }).result;
    const names = result.tools.map(t => t.name).sort();
    expect(names).toEqual([
      'bridge_status', 'decrypt_share', 'publish_p2p',
      'query_my_inbox', 'query_p2p', 'share_encrypted',
    ]);
    for (const t of result.tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeDefined();
    }
  });

  it('a bare POST with no Accept header is served (the shape every simple client sends)', async () => {
    // The SDK transport answers 406 unless the client accepts BOTH application/json and
    // text/event-stream. serveMcpOverHttp normalises it; losing that breaks every
    // client that just POSTs JSON.
    const { status, body } = await serveMcpOverHttp({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    expect(status).toBe(200);
    expect((body as { result?: { tools?: unknown[] } }).result?.tools).toBeDefined();
  });

  it('tools/call publish_p2p round-trips', async () => {
    const { body } = await serveMcpOverHttp({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: {
        name: 'publish_p2p',
        arguments: { descriptorId: 'urn:iep:mcp-handler-test', cid: 'bafkrei-mcp', graphIri: 'urn:graph:mcp-handler' },
      },
    });
    const result = (body as { result: { content: { type: string; text: string }[] } }).result;
    expect(result.content[0]!.type).toBe('text');
    const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean; eventId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tools/call unknown tool → -32601', async () => {
    const { body } = await serveMcpOverHttp({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    expect((body as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it('unknown method → -32601', async () => {
    const { body } = await serveMcpOverHttp({ jsonrpc: '2.0', id: 7, method: 'foo/bar' });
    expect((body as { error?: { code: number } }).error?.code).toBe(-32601);
  });

  it('two bridges sharing a relay can exchange encrypted shares (cross-bridge round-trip)', async () => {
    // Demonstrate the multi-bridge case at the protocol layer: in
    // production, two bridges would share a relay via EXTERNAL_RELAYS
    // (which goes through WebSocketRelayMirror — see
    // tests/p2p-mirror.test.ts for the actual WebSocket transport).
    // Here we exercise the same publish→discover→decrypt path by
    // running two real P2pClients with separate wallets on a shared
    // InMemoryRelay — same code that runs in production, just
    // without the WebSocket layer (which has its own dedicated test).
    const sharedRelay = new InMemoryRelay();
    const aliceWallet = importWallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'agent', 'alice');
    const bobWallet = importWallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'agent', 'bob');
    const aliceEnc = generateKeyPair();
    const bobEnc = generateKeyPair();

    const alice = new P2pClient(sharedRelay, aliceWallet, { encryptionKeyPair: aliceEnc });
    const bob = new P2pClient(sharedRelay, bobWallet, { encryptionKeyPair: bobEnc });

    await alice.publishEncryptedShare({
      plaintext: 'cross-bridge message',
      recipients: [{ sigPubkey: bob.pubkey, encryptionPubkey: bobEnc.publicKey }],
      senderEncryptionKeyPair: aliceEnc,
    });

    const inbox = await bob.queryEncryptedShares({ recipientSigPubkey: bob.pubkey });
    expect(inbox).toHaveLength(1);
    expect(bob.decryptEncryptedShare(inbox[0]!)).toBe('cross-bridge message');
  });
});
