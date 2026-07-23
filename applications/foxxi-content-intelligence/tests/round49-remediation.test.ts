/**
 * Round-49: close the round-48 confirmed-open findings + the auditor's forgery note.
 *
 *  F1 [MAJOR] /agent/verify-extension disclosed any subject's graded score + xAPI evidence
 *      to any signed wallet. Fixed by inserting the same fail-closed human/agent PII gate its
 *      siblings /agent/review-record + foxxi.assemble_learner_record enforce (a human record
 *      is private unless isSelf). Handler-level (Express + signed request) — verified by the
 *      mirrored sibling code + a live check (mismatched subject_did → 403).
 *  F2 [MINOR] /agent/publish-memory slug was caller-keyed with no owner lock, allowing
 *      cross-agent attribution/note-injection under a victim's memory URL. Fixed with a
 *      first-writer-wins lock mirroring courseAuthors (409 on a different author). Live check:
 *      a second author on the same slug → 409.
 *  F3 [forgery note] The LRS session-token gate built its address map with
 *      attachDeterministicAddresses, giving directory users who lack an explicit wallet a
 *      PUBLIC-demo-seed wallet — so anyone could forge their token and reach DEFAULT_TENANT.
 *      The gate now uses buildAddressMap(users) directly: EXPLICIT wallets only. These tests
 *      prove that behavior.
 */

import { describe, it, expect } from 'vitest';
import { mintSessionToken, verifySessionToken, buildAddressMap, deriveUserWallet } from '../src/auth.js';

describe('round-49 F3 — LRS session-token gate trusts EXPLICIT wallets only', () => {
  it('a directory user WITHOUT an explicit wallet is not verifiable (public-seed forgery closed)', async () => {
    // The shape autoFetchAdmin returns (admin_payload.json): user_id + web_id, no wallet.
    const directory = [{ user_id: 'u-joshua', web_id: 'https://acme/jliu#me' }];
    // The gate now builds the map WITHOUT attachDeterministicAddresses.
    const gateMap = buildAddressMap(directory);
    expect(gateMap.size).toBe(0); // no explicit wallet → nobody enters the trusted set

    // An attacker who knows the PUBLIC demo seed forges u-joshua's token → REJECTED.
    const forged = await mintSessionToken({ userId: 'u-joshua', webId: 'https://acme/jliu#me' });
    expect(verifySessionToken(forged, gateMap).ok).toBe(false);
  });

  it('a directory user WITH an explicit (real / secret-seeded) wallet still verifies, but public-seed tokens do not', async () => {
    const SECRET = 'deployment-secret-seed';
    const directory = [{
      user_id: 'u-joshua',
      web_id: 'https://acme/jliu#me',
      wallet_address: deriveUserWallet('u-joshua', SECRET).address,
    }];
    const gateMap = buildAddressMap(directory);
    expect(gateMap.size).toBe(1);

    // A token minted under the SAME secret seed as the published wallet → verifies.
    const good = await mintSessionToken({ userId: 'u-joshua', webId: 'https://acme/jliu#me', seed: SECRET });
    expect(verifySessionToken(good, gateMap).ok).toBe(true);

    // A public-default-seed token for the same ids → still rejected (can't forge the identity).
    const forged = await mintSessionToken({ userId: 'u-joshua', webId: 'https://acme/jliu#me' });
    expect(verifySessionToken(forged, gateMap).ok).toBe(false);
  });
});
