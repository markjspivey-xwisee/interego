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

/**
 * Process-wide pod-publish mutex. publish() in @interego/core does
 * GET-then-PUT on the tenant manifest for every descriptor write, and
 * CSS serializes manifest writes on a file lock. When multiple bridge
 * publishes race (e.g. several agent outcomes within the same second,
 * or a snapshot-flip burst), they each contend for the lock; in
 * practice we've seen CSS's manifest endpoint stall and Azure ingress
 * return 504 mid-flight. A single bridge-local async queue removes
 * intra-process contention entirely: at most ONE publish() is in
 * flight at any moment per bridge instance. Cross-bridge contention
 * (other publishers writing to the same pod) still falls back to the
 * If-Match/412 retry path in @interego/core's manifest update.
 *
 * The queue does not bound or drop work — every caller eventually
 * completes (or surfaces an error). Callers that need a deadline
 * should wrap with tryPublishBounded() in performance-routes.ts.
 */
let _publishChain: Promise<unknown> = Promise.resolve();

export function withPublishLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _publishChain.then(() => fn(), () => fn());
  // Don't propagate the result into the chain — just keep the chain
  // alive so the next caller waits for THIS one to settle.
  _publishChain = next.catch(() => undefined);
  return next;
}
