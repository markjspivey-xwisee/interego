/**
 * Round-37: the "unbounded shared-state mutation" class — an any-signed-wallet
 * endpoint that grows a process-global structure without a cap is a memory-DoS.
 * round-35 capped /performance/outcome's liveOutcomes; round-37 caps the siblings the
 * audit found: the in-memory statement store (/agent/mesh-event), the SCORM-play map
 * (/agent/scorm/launch), and the per-tenant forwarding-target map (/agent/forwarding/targets).
 * These assert the two library-level caps directly.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryStatementStore } from '../src/statement-store.js';
import { addForwardingTarget } from '../src/lrs-forwarding.js';
import { DEFAULT_TENANT, type TenantId } from '../src/tenant-context.js';

describe('round-37 — unbounded shared-state stores are capped', () => {
  it('InMemoryStatementStore evicts oldest past its cap (bounded memory)', async () => {
    const store = new InMemoryStatementStore();
    const N = 50_010; // MAX is 50_000
    for (let i = 0; i < N; i++) {
      await store.put({
        id: `urn:uuid:stmt-${i}`,
        statement: { id: `urn:uuid:stmt-${i}`, actor: { objectType: 'Agent' }, verb: { id: 'http://x/v' }, object: { id: 'http://x/o' } },
        stored: new Date(0).toISOString(),
        voided: false,
      } as never);
    }
    const count = await store.count();
    expect(count).toBeLessThanOrEqual(50_000);
    // The oldest was evicted; the newest is retained.
    expect(await store.get('urn:uuid:stmt-0')).toBeNull();
    expect(await store.get(`urn:uuid:stmt-${N - 1}`)).not.toBeNull();
  });

  it('addForwardingTarget returns null once the per-tenant cap (200) is reached', () => {
    const tenant = `lens:round37-cap-test-${Math.floor(1)}` as TenantId; // fresh tenant partition
    let lastView: unknown = 'init';
    for (let i = 0; i < 205; i++) {
      lastView = addForwardingTarget(tenant, { endpoint: `https://lrs${i}.example/`, credentials: `u${i}:p${i}` });
    }
    // The 201st+ NEW target is rejected (null); earlier ones returned a view.
    expect(lastView).toBeNull();
    // Re-adding (updating) an EXISTING target still succeeds even past the cap.
    const update = addForwardingTarget(tenant, { endpoint: 'https://lrs0.example/', credentials: 'u0:p0', label: 'renamed' });
    expect(update).not.toBeNull();
    void DEFAULT_TENANT;
  });
});
