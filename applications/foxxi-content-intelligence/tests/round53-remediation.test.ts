/**
 * Round-53: close the round-52 findings.
 *
 *  F1 [BLOCKER] the round-51 public-demo-seed filter was applied at only ONE of six
 *      session-token trust boundaries (the LRS gate). The other five — resolveCaller
 *      (MCP/tool auth), callerIsOperator, the LRS-admin gate, the context-chat verifier,
 *      and affordance attribution — still built an UNFILTERED buildAddressMap, so a
 *      demo-seed-forged token granted operator/admin escalation or learner impersonation.
 *      Fixed by extracting ONE shared trustedAddressMap (buildAddressMap minus demo-seed
 *      wallets) and routing every gate through it. This test proves the shared filter.
 *  F2 [MAJOR] the tenant-fetcher cache Map was uncapped and grown pre-auth by a
 *      caller-supplied podUrl → OOM. Capped with sweep-expired-then-evict-oldest (the
 *      cache/setCached are module-internal; the cap mirrors the proven store-cap pattern).
 */

import { describe, it, expect } from 'vitest';
import { deriveUserWallet, trustedAddressMap, verifySessionToken, mintSessionToken } from '../src/auth.js';

describe('round-53 F1 — trustedAddressMap is the one shared filter every session-token gate uses', () => {
  it('drops public-demo-seed wallets (no operator/admin escalation) but keeps real/secret-seed wallets', async () => {
    const users = [
      // A directory admin whose wallet was injected from the PUBLIC demo seed (FOXXI_WALLET_SEED unset).
      { user_id: 'admin', web_id: 'https://acme/admin#me', wallet_address: deriveUserWallet('admin').address },
      // A user with a REAL (secret-seeded) wallet.
      { user_id: 'real', web_id: 'https://acme/real#me', wallet_address: deriveUserWallet('real', 'a-secret').address },
    ];
    const map = trustedAddressMap(users);
    expect(map.size).toBe(1); // only the real user is trusted

    // A demo-seed-forged token for the admin is REJECTED → no whole-surface escalation.
    const forgedAdmin = await mintSessionToken({ userId: 'admin', webId: 'https://acme/admin#me' });
    expect(verifySessionToken(forgedAdmin, map).ok).toBe(false);

    // The real user's secret-seeded token still verifies.
    const realTok = await mintSessionToken({ userId: 'real', webId: 'https://acme/real#me', seed: 'a-secret' });
    expect(verifySessionToken(realTok, map).ok).toBe(true);
  });

  it('is a no-op-safe empty map when the directory has no non-demo wallets', () => {
    const users = [{ user_id: 'x', web_id: 'https://acme/x#me', wallet_address: deriveUserWallet('x').address }];
    expect(trustedAddressMap(users).size).toBe(0);
  });
});
