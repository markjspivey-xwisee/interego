/**
 * Round-41: the round-39 inbound-credential cap was INCOMPLETE — it bounded `meta`
 * (keyed by id = base64(principal:tenant), secret-independent) but the parallel `liveMap`
 * that holds the PLAINTEXT secrets is keyed by `${principal}:${secret}`, so rotating the
 * secret for a FIXED principal overwrote the same meta id (cap never tripped) while adding
 * a fresh liveMap key each time, never reclaiming the old one → unbounded plaintext-secret
 * heap (round-40 blocker reopened). The fix drops the prior secret's liveMap key on update,
 * so liveMap size == meta size (bounded). Also asserts the old secret stops resolving.
 */

import { describe, it, expect } from 'vitest';
import { inboundCredentials } from '../src/lrs-forwarding.js';

describe('round-41 — inbound-credential secret rotation does not orphan (liveMap bounded)', () => {
  it('rotating a fixed principal keeps exactly ONE live secret (old secret stops resolving)', () => {
    const T = 'lens:r41-rotate';
    inboundCredentials.add({ principal: 'r41-P', secret: 'S1', tenant: T });
    expect(inboundCredentials.resolve('r41-P:S1')).not.toBeNull();

    // Rotate the secret for the SAME principal → the old key must be reclaimed.
    inboundCredentials.add({ principal: 'r41-P', secret: 'S2', tenant: T });
    expect(inboundCredentials.resolve('r41-P:S1')).toBeNull();      // orphan removed
    expect(inboundCredentials.resolve('r41-P:S2')).not.toBeNull();  // new secret live

    // Rotate many more times: only the CURRENT secret ever resolves — no unbounded growth.
    for (let i = 0; i < 500; i++) inboundCredentials.add({ principal: 'r41-P', secret: `Sn${i}`, tenant: T });
    expect(inboundCredentials.resolve('r41-P:S2')).toBeNull();
    expect(inboundCredentials.resolve('r41-P:Sn499')).not.toBeNull();

    // This principal contributes exactly ONE row to the store, not 503.
    const mine = inboundCredentials.list().filter(c => c.principal === 'r41-P');
    expect(mine.length).toBe(1);
  });
});
