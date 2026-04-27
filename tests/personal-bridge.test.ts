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
import { tools, bridgeStatus, client } from '../examples/personal-bridge/server.js';
import { generateKeyPair, importWallet, P2pClient, InMemoryRelay } from '../src/index.js';

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
      descriptorId: 'urn:cg:bridge-test:1',
      cid: 'bafkrei-bridge-1',
      graphIri: 'urn:graph:bridge-test',
      summary: 'first',
    }) as { ok: boolean; eventId: string };
    expect(pub.ok).toBe(true);
    expect(pub.eventId).toMatch(/^[0-9a-f]{64}$/);

    const q = await tools.query_p2p!.handler({ graphIri: 'urn:graph:bridge-test' }) as Array<{ descriptorId: string }>;
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(q.find(x => x.descriptorId === 'urn:cg:bridge-test:1')).toBeDefined();
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
