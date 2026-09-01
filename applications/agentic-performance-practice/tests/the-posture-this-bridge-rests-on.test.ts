/**
 * agp authenticates nobody — this pins the three properties that make that SAFE.
 *
 * ── THE DECISION, AND WHY IT IS NOT "ADD AUTH" ───────────────────────────────
 *
 * This bridge is public and verifies no caller. Twice on 2026-08-31 that produced a real
 * defect: caller-aimed fetches reached 169.254.169.254 and 10.0.0.5 (SSRF), and a
 * caller-supplied `operator_did` became the published `prov:wasAttributedTo` with
 * `trustLevel: SelfAsserted` (the #168 shape). Both are fixed.
 *
 * The remaining question was whether agp must verify signed requests the way Foxxi does. It
 * must not, yet, and the reason is the substrate's own model rather than convenience:
 *
 *   1. THE BRIDGE HOLDS NO CREDENTIAL. It cannot lend authority it does not have. A caller can
 *      only ask it to write AS NOBODY.
 *   2. ATTRIBUTION IS NOT THE CALLER'S TO CHOOSE. Whatever gets written says the bridge said
 *      it — so a write that lands cannot impersonate anyone.
 *   3. THE POD'S ACL IS THE AUTHORITY. A write succeeds only where the pod's owner chose to
 *      allow it. That is what self-sovereign means here: the resource decides, not the bridge.
 *
 * Under those three, "no auth" costs a spam vector, not an integrity one. Remove ANY of them
 * and the argument collapses — property 1 turns the bridge into a confused deputy, property 2
 * restores #168, property 3 is not ours to hold. So they are asserted here rather than left as
 * a paragraph someone can invalidate without noticing.
 *
 * This is a POSTURE test. It does not claim agp is secure; it claims the specific reasoning
 * that made "no auth" acceptable is still true. If it fails, revisit the decision.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agpAttributionFacets } from '../bridge/pod-helpers.js';

const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge');

function bridgeSource(): string {
  return readdirSync(BRIDGE_DIR)
    .filter(f => f.endsWith('.ts'))
    .map(f => readFileSync(join(BRIDGE_DIR, f), 'utf8'))
    // Strip line comments so the long rationale above a guard cannot satisfy a check — the
    // exact way one of today's gates matched its own documentation and could never fail.
    .map(t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'))
    .join('\n');
}

describe('the posture that makes an unauthenticated agp acceptable', () => {
  it('reads real bridge source — an empty read would pass every assertion below', () => {
    const src = bridgeSource();
    expect(src.length).toBeGreaterThan(2000);
    expect(src, 'not reading the handlers').toContain('createAgpHandlers');
  });

  it('★ 1. the bridge holds NO credential — it has no authority to lend', () => {
    const src = bridgeSource();
    // A credential here would make an unauthenticated caller a confused deputy: it could
    // direct the bridge to act with power the caller does not have.
    for (const marker of ['Authorization', 'Bearer ', '_signed_payload', 'WALLET_SEED',
                          'PRIVATE_KEY', 'ISSUER_KEY']) {
      expect(
        src.includes(marker),
        `agp's bridge now references ${marker}. If it carries a credential, "authenticates `
          + `nobody" stops being safe — an anonymous caller would be directing an authorised `
          + `writer. Add caller verification before adding a credential.`,
      ).toBe(false);
    }
  });

  it('★ 2. attribution is fixed to the bridge, not chosen by the caller', () => {
    // Same property the #168 test pins, asserted here as a POSTURE dependency: it is one of
    // the three legs holding up the no-auth decision, not just a bug that was fixed once.
    const facets = agpAttributionFacets('2026-08-31T00:00:00.000Z');
    const json = JSON.stringify(facets);
    expect(json).toContain('urn:agp:bridge:agent');
    // The builder takes only a timestamp — there is no parameter a caller could reach.
    expect(
      agpAttributionFacets.length,
      'agpAttributionFacets gained a parameter; if a caller value can reach it, #168 is back',
    ).toBe(1);
  });

  it('★ 3. every caller-supplied target is screened before it is fetched', () => {
    const src = bridgeSource();
    // Comments are stripped above, so these must be real code.
    expect(src, 'the pre-connect screen is gone').toContain('assertSafeFetchTarget');
    expect(src, 'the redirect-following guard is gone').toContain('guardedFetchFn');
  });
});
