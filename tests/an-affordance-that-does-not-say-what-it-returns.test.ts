/**
 * An affordance that does not declare what it RETURNS cannot be chained from.
 *
 * ── WHY THIS IS A REAL GAP AND NOT A DOCUMENTATION PREFERENCE ────────────────
 *
 * The substrate's claim is that a generic agent DISCOVERS a manifest and acts from it. Acting
 * once needs `hydra:expects`. Acting TWICE — using what came back to decide the next call —
 * needs `hydra:returns`, and that half is largely missing.
 *
 * Measured against the live foxxi bridge on 2026-08-30: 91 published affordances, 91
 * `hydra:expects` triples, and 35 `hydra:returns`. So the contract says what to SEND to
 * essentially everything and what COMES BACK from about a third. The silent ones are exactly
 * the chainable ones — `issue_completion_credential`, `record_performance`,
 * `record_agent_trajectory`/`get_agent_trajectory`, `assess_agent_disposition`, `export_clr`.
 *
 * They are not silent because they return nothing. Driven live, `foxxi.coverage_query` answers
 * `{mode, bundle}` — structured data an agent would need, that nothing in the published
 * contract mentions.
 *
 * ── WHAT THIS COST, CONCRETELY ───────────────────────────────────────────────
 *
 * `agp.diagnose` and `agp.plan_intervention` were published as a pair and did not compose:
 * diagnose's result omitted `situationId` and `factors`, which plan REQUIRES and DEREFERENCES.
 * Both had passing unit tests, because each test built its own handler's input by hand.
 * Nothing asked whether one tool's output is the next tool's input, and nothing could, because
 * the output side was not written down. That is this gap, at one seam.
 *
 * ── WHY A RATCHET, AND WHY agp IS ASSERTED AT ZERO ───────────────────────────
 *
 * Writing 58 accurate output schemas is per-affordance judgement, not a sweep — an inaccurate
 * schema is worse than none, because a chaining agent would trust it. So this pins the number
 * and refuses growth, while asserting that agp — 9 of 9, after the diagnose/plan fix — holds
 * the line at zero. A ratchet with no demonstrated bar is just a record of the debt; one with
 * a vertical at zero says the standard is reachable.
 */
import { describe, it, expect } from 'vitest';
import { foxxiAffordances, foxxiAdminAffordances } from '../applications/foxxi-content-intelligence/affordances.js';
import { agpAffordances } from '../applications/agentic-performance-practice/affordances.js';

type Aff = Record<string, unknown>;
const declaresOutputs = (a: Aff): boolean => {
  const o = a.outputs as { properties?: Record<string, unknown> } | undefined;
  return !!(o?.properties && Object.keys(o.properties).length > 0);
};
const silent = (list: readonly unknown[]): string[] =>
  (list as Aff[]).filter(a => !declaresOutputs(a)).map(a => String(a.toolName));

/**
 * Measured 2026-08-30 across foxxi + foxxi-admin. LOWER IT as schemas are written; never
 * raise it. A new affordance must declare its outputs, which is what "never raise" means.
 */
const FOXXI_SILENT_CEILING = 58;

describe('a published affordance says what it returns', () => {
  it('foxxi does not grow the number that stay silent', () => {
    const s = silent([...foxxiAffordances, ...foxxiAdminAffordances]);
    expect(
      s.length,
      `${s.length} foxxi affordances declare no outputs (ceiling ${FOXXI_SILENT_CEILING}). A new `
        + `affordance must say what it returns, or nothing can chain from it: ${s.slice(0, 6).join(', ')}…`,
    ).toBeLessThanOrEqual(FOXXI_SILENT_CEILING);
  });

  it('★ is measuring a non-empty set — a ceiling over nothing passes forever', () => {
    expect([...foxxiAffordances, ...foxxiAdminAffordances].length).toBeGreaterThan(50);
    expect(silent([...foxxiAffordances, ...foxxiAdminAffordances]).length).toBeGreaterThan(0);
  });

  it('★ agp holds the line at zero — the standard is reachable, not aspirational', () => {
    const s = silent(agpAffordances);
    expect(agpAffordances.length).toBeGreaterThan(0);
    expect(
      s,
      `agp regressed: these stopped declaring outputs, and agp is the vertical that proves the `
        + `bar can be met: ${s.join(', ')}`,
    ).toEqual([]);
  });
});
