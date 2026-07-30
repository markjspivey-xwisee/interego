/**
 * A mounted affordance set may not declare the same toolName twice.
 *
 * ★ WHY. `foxxi.prove_competency` and `foxxi.record_performance` were each declared
 * TWICE — once in the learner list as the agent-drivable `-signed` variant, once in the
 * admin list as the session-token variant. Under the default `FOXXI_AUDIENCE=both` the
 * live bridge mounted 91 affordances carrying only 89 distinct tool names.
 *
 * It survived because nothing noticed:
 *
 *   - the hand-rolled /mcp mount resolves `tools/call` through `handlers[toolName]`, a
 *     plain object with ONE entry per name. So the duplicate simply made the signed
 *     twin unreachable as a named tool — which reads as intended behaviour, since
 *     externallyRouted affordances are deliberately not dispatchable.
 *   - `tools/list` emitted both, so a client saw two entries with one name and resolved
 *     it arbitrarily. That is a spec violation on its own, independent of any SDK.
 *   - foxxi.test.ts asserts the action-IRI and toolName *conventions*, and that the
 *     learner and admin action IRIs are disjoint — but never that toolNames are unique.
 *     The action IRIs genuinely differ (`…-signed` vs plain), so every existing
 *     assertion passed.
 *
 * It becomes fatal under MCP SDK v2: `McpServer.registerTool` THROWS on a duplicate
 * name, so the live foxxi bridge would fail to BOOT rather than misbehave. That is the
 * good outcome — but only if the collision is fixed first, which is why this file
 * exists before the mount migrates.
 *
 * The fix renamed the SIGNED variants (`…_signed`), not the session-token ones. That
 * side is safe by construction: the signed entries have no handler, so nothing could
 * ever have invoked them by name, whereas the session-token names are called by the
 * dashboard SPA and the microsite.
 *
 * This asserts the invariant for every audience the bridge can actually mount, not just
 * the default — `FOXXI_AUDIENCE` selects between three sets and a collision confined to
 * one of them would otherwise ship.
 */
import { describe, it, expect } from 'vitest';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';

const AUDIENCES = {
  learner: foxxiAffordances,
  admin: foxxiAdminAffordances,
  'both (the default FOXXI_AUDIENCE)': [...foxxiAffordances, ...foxxiAdminAffordances],
} as const;

describe('toolNames are unique within every mountable affordance set', () => {
  for (const [audience, list] of Object.entries(AUDIENCES)) {
    it(`${audience}: no toolName is declared twice`, () => {
      const byName = new Map<string, string[]>();
      for (const a of list) {
        const actions = byName.get(a.toolName) ?? [];
        actions.push(String(a.action));
        byName.set(a.toolName, actions);
      }
      const collisions = [...byName.entries()].filter(([, actions]) => actions.length > 1);
      expect(
        collisions.map(([name, actions]) => `${name} <- ${actions.join(' , ')}`),
        'registerTool throws on a duplicate name, so a collision here is a boot failure, not a warning',
      ).toEqual([]);
      // Sanity: the invariant is only meaningful if the set is non-trivial.
      expect(byName.size).toBe(list.length);
    });
  }

  it('the signed variants are distinguishable from their session-token twins', () => {
    const names = new Set([...foxxiAffordances, ...foxxiAdminAffordances].map(a => a.toolName));
    // Both pairs must be present and distinct — a "fix" that deleted one of the four
    // affordances would satisfy uniqueness while silently removing a capability.
    for (const pair of [
      ['foxxi.prove_competency', 'foxxi.prove_competency_signed'],
      ['foxxi.record_performance', 'foxxi.record_performance_signed'],
    ]) {
      for (const n of pair) expect(names.has(n), `${n} is missing`).toBe(true);
    }
  });

  it('every affordance whose action ends in -signed is externally routed', () => {
    // The two names collided precisely because the signed twin is the non-dispatchable
    // one. Pinning that relationship keeps the rename's rationale true: if a signed
    // affordance ever gains a handler, the naming decision needs revisiting.
    const all = [...foxxiAffordances, ...foxxiAdminAffordances];
    const signed = all.filter(a => String(a.action).endsWith('-signed'));
    expect(signed.length, 'expected the signed affordance family to exist').toBeGreaterThan(0);
    for (const a of signed) {
      expect((a as { externallyRouted?: boolean }).externallyRouted,
        `${a.toolName} (${a.action}) is signed but not externallyRouted`).toBe(true);
    }
  });
});
