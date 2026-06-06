/**
 * Deterministic userId derivation from a user's first credential.
 *
 * The shapes — `u-pk-<sha256(credId)[:12]>`, `u-eth-<addr[:12]>`,
 * `u-did-<sha256(did)[:12]>` — are a federation invariant: the same
 * credential MUST produce the same userId on every identity-server
 * instance so a user's pod path stays stable across deployments and
 * the same DID resolves to the same identity across federation peers.
 *
 * Lives in its own file (not server.ts) so it can be imported without
 * triggering server.ts's top-level `app.listen()` side effect, and
 * therefore unit-tested with frozen vectors.
 */

import * as crypto from 'node:crypto';

export function deriveUserIdFromCredentialId(credentialId: string): string {
  const h = crypto.createHash('sha256').update(credentialId).digest('hex');
  return `u-pk-${h.slice(0, 12)}`;
}

export function deriveUserIdFromWallet(addressLower: string): string {
  // Ethereum addresses are already 160-bit; slice directly.
  //
  // NOTE — do NOT migrate this to loadAgentKeypair({ envVar, label }):
  // the input here is a CLIENT-SUPPLIED Ethereum address from the
  // registration payload, not an operator-held private key. The userId
  // shape `u-eth-<addr-slice>` is also intentionally distinct from the
  // did:key format that loadAgentKeypair produces; changing it would
  // break the federation invariant (same wallet → same userId across
  // identity-server instances).
  return `u-eth-${addressLower.replace(/^0x/, '').slice(0, 12)}`;
}

export function deriveUserIdFromDid(did: string): string {
  const h = crypto.createHash('sha256').update(did).digest('hex');
  return `u-did-${h.slice(0, 12)}`;
}
