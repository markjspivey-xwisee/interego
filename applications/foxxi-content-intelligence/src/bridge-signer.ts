/**
 * Bridge service identity — the bridge's own cryptographic voice.
 *
 * Option D ("signature-verified writes, allow-all storage"): the
 * substrate intentionally keeps CSS open to anonymous writes so
 * Interego's zero-trust-storage principle is preserved. The substitute
 * for storage-layer ACLs is signature verification at the consumer
 * layer — every write that wants to count must carry an ECDSA proof
 * the verifier can check against the author's DID. Anonymous junk
 * still lands in the pod; readers (federation loader, calibration
 * recompose) ignore it.
 *
 * Most writes the bridge makes are on behalf of a calling agent and
 * carry that agent's signature. A handful are bridge-originated
 * (calibration-flip snapshots, surface snapshots, participation
 * attestations) — for those, the bridge needs its own identity.
 * That's this module.
 *
 * Key sourcing:
 *   FOXXI_BRIDGE_PRIVATE_KEY (env, 0x-prefixed 32-byte hex)
 *     → deterministic identity across restarts. Set this in production.
 *   not set
 *     → ephemeral key generated at process start. Fine for demos; the
 *       DID changes every container restart so readers verifying older
 *       bridge-signed descriptors will see them downgrade to SelfAsserted.
 */

import { Wallet, HDNodeWallet } from 'ethers';
import { createHash } from 'node:crypto';

// Ethers's Wallet.createRandom() returns HDNodeWallet; new Wallet(key)
// returns Wallet. Both expose .address + .signMessage — type the cache
// against the common surface.
type SigningWallet = Wallet | HDNodeWallet;
let _wallet: SigningWallet | null = null;

export function bridgeWallet(): SigningWallet {
  if (_wallet) return _wallet;
  const raw = process.env.FOXXI_BRIDGE_PRIVATE_KEY?.trim();
  let next: SigningWallet;
  if (raw && /^0x[0-9a-fA-F]{64}$/.test(raw)) {
    next = new Wallet(raw);
    _wallet = next;
    console.log(`[foxxi-bridge] using FOXXI_BRIDGE_PRIVATE_KEY identity ${bridgeDid()}`);
  } else {
    next = Wallet.createRandom();
    _wallet = next;
    console.warn(
      '[foxxi-bridge] FOXXI_BRIDGE_PRIVATE_KEY not set — generated ephemeral',
      `identity ${bridgeDid()}. Bridge-signed descriptors will not survive restart.`,
    );
  }
  return next;
}

export function bridgeDid(): string {
  return `did:key:${bridgeWallet().address.toLowerCase()}#bridge`;
}

export function bridgeAuthor(): { id: string; kind: 'agent'; role: string } {
  return { id: bridgeDid(), kind: 'agent', role: 'bridge service' };
}

/**
 * Sign the canonical JSON of `payload` the same way agents do — wallet
 * signMessage over `sha256:<hex of utf8 JSON>`. This is the exact shape
 * verifySignature() in outcome-descriptor-publisher.ts validates, so a
 * bridge-signed descriptor passes the same check that gates agent-signed
 * descriptors.
 */
export async function signAsBridge(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  return bridgeWallet().signMessage(`sha256:${hash}`);
}
