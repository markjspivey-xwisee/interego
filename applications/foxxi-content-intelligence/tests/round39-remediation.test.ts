/**
 * Round-39: the unbounded-shared-state class had 3 more instances (round-38) — the
 * BLOCKER being the inbound-credential store (PLAINTEXT secrets) grown without limit
 * by /agent/credentials, plus the per-tenant TenantPartition and the SCORM course cache.
 * These assert the two library-level caps: the credential registry rejects a NEW
 * principal past its cap (returns null), and TenantPartition evicts oldest past its cap.
 */

import { describe, it, expect } from 'vitest';
import { inboundCredentials } from '../src/lrs-forwarding.js';
import { TenantPartition, type TenantId } from '../src/tenant-context.js';

describe('round-39 — inbound-credential + tenant-partition stores are capped', () => {
  it('inboundCredentials.add returns null once the registry cap (10k) is reached', () => {
    let last: unknown = 'init';
    // Distinct principals → distinct ids → growth; add past the cap.
    for (let i = 0; i < 10_050; i++) {
      last = inboundCredentials.add({ principal: `r39-p${i}`, secret: `s${i}`, tenant: `lens:r39-${i}` });
    }
    expect(last).toBeNull(); // cap reached → new principal rejected
  });

  it('TenantPartition evicts the oldest partition once its cap is reached (bounded)', () => {
    // A fresh partition instance — cap is 20_000; add past it and confirm size never exceeds.
    let created = 0;
    const part = new TenantPartition<{ n: number }>(() => ({ n: created++ }));
    for (let i = 0; i < 20_050; i++) part.for(`lens:tp-${i}` as TenantId);
    // The oldest were evicted: the first tenant's store is gone (recreated on access = new n).
    const firstAgain = part.for('lens:tp-0' as TenantId);
    // 'lens:tp-0' was evicted long ago, so accessing it now runs the factory afresh
    // (n is a large value, not 0) — proving it was not retained.
    expect(firstAgain.n).toBeGreaterThan(0);
  });
});
