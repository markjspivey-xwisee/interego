/**
 * Round-51: close the round-50 finding + the publisher demo-seed hazard.
 *
 *  F1 [MINOR · PII] unauth /content/ask leaked an arbitrary caller-NAMED learner's LRS
 *      activity + enrollment counts for non-progress/assignments intents (an existence +
 *      engagement-volume oracle). Fixed by resetting `learner = 'anonymous'` for any
 *      non-verified path before assembly. Handler-level (Express) — verified live: an
 *      unauth catalog question with learner=<victim> returns anonymous/zero counts.
 *  C [hazard] the LRS gate could trust a directory user's EXPLICIT wallet even when that
 *      wallet was the PUBLIC-demo-seed derivation (baked in by a publisher when
 *      FOXXI_WALLET_SEED is unset) — forgeable by anyone. The gate now drops any such
 *      wallet via isPublicDemoWallet. These tests prove it.
 */

import { describe, it, expect } from 'vitest';
import { deriveUserWallet, isPublicDemoWallet, buildAddressMap, verifySessionToken, mintSessionToken } from '../src/auth.js';

describe('round-51 C — the LRS gate never trusts a public-demo-seed wallet', () => {
  it('isPublicDemoWallet detects a demo-seed wallet but not a secret-seed one', () => {
    const demoWallet = deriveUserWallet('u-x').address;           // default seed = DEFAULT_DEMO_SEED
    expect(isPublicDemoWallet('u-x', demoWallet)).toBe(true);
    const secretWallet = deriveUserWallet('u-x', 'a-secret-seed').address;
    expect(isPublicDemoWallet('u-x', secretWallet)).toBe(false);
    // Bound to the user_id: a demo wallet for a DIFFERENT user is not this user's demo wallet.
    expect(isPublicDemoWallet('u-other', demoWallet)).toBe(false);
  });

  it('the gate filter drops a demo-seed directory user but keeps a secret-seed identity', async () => {
    const demoUser = { user_id: 'u-x', web_id: 'https://acme/x#me', wallet_address: deriveUserWallet('u-x').address };
    const secretUser = { user_id: 'u-y', web_id: 'https://acme/y#me', wallet_address: deriveUserWallet('u-y', 'secret').address };
    // Mirror the gate's filter exactly.
    const trusted = [demoUser, secretUser]
      .filter(u => !!u.wallet_address && !isPublicDemoWallet(u.user_id, u.wallet_address));
    expect(trusted.map(u => u.user_id)).toEqual(['u-y']);

    const map = buildAddressMap(trusted);
    // A forged demo-seed token for the dropped user → rejected.
    const forged = await mintSessionToken({ userId: 'u-x', webId: 'https://acme/x#me' });
    expect(verifySessionToken(forged, map).ok).toBe(false);
    // The secret-seed identity still verifies.
    const good = await mintSessionToken({ userId: 'u-y', webId: 'https://acme/y#me', seed: 'secret' });
    expect(verifySessionToken(good, map).ok).toBe(true);
  });
});
