/**
 * `agp.diagnose`'s output is accepted by `agp.plan_intervention`.
 *
 * ── WHY THIS IS THE TEST THAT WAS MISSING ────────────────────────────────────
 *
 * Both handlers had tests and both passed. Each test built a diagnosis BY HAND in the shape
 * its own handler wanted, so nothing ever asked whether one tool's output is the other's
 * input. Driven against the live bridge, it was not:
 *
 *   · `diagnose` projected its result down to `{diagnosisIri, regime, regimeSource, method,
 *     factor, skillDeficiency, exemplary, reasoning, caveat}` — dropping `situationId`, which
 *     `coerceDiagnosis` REQUIRES, and `factors`, which `recommendInterventions` DEREFERENCES.
 *   · so feeding diagnose's own answer straight into plan returned
 *     `pending: inputs-not-resolvable`, and
 *   · a hand-built diagnosis carrying the natural-looking `factors: ['no shared model']` — an
 *     array of strings — crashed the engine and returned
 *     `Cannot read properties of undefined (reading 'adequate')` over HTTP.
 *
 * A vertical whose thesis is that agents CHAIN published affordances cannot publish two that
 * do not compose. This asserts the seam directly, in the direction an agent would travel it.
 */
import { describe, it, expect } from 'vitest';
import { createAgpHandlers } from '../bridge/handlers.js';

const SITUATION = {
  id: 'urn:agp:situation:compose-test',
  workContext: 'production incident response',
  competency: 'diagnosis under time pressure',
  observed: 'median 34 minutes to first hypothesis',
  desired: 'under 15 minutes',
  domain: 'Knowable',
  regimeSource: 'asserted',
  criticality: 'high',
};

/** No pod: these handlers publish best-effort and must run without one. */
const handlers = () => createAgpHandlers({
  fetchFn: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
});

describe('diagnose -> plan_intervention composes', () => {
  it('diagnose returns the two fields the next affordance needs', async () => {
    const h = handlers();
    const d = await h['agp.diagnose']!({
      situation: SITUATION,
      factor_evidence: {
        knowledgeSkill: { adequate: false, evidence: 'nobody can name the topology unaided' },
        instrumentation: { adequate: false, evidence: 'the console needs an unfamiliar query language' },
      },
    }) as Record<string, unknown>;

    // `coerceDiagnosis` refuses without it; dropping it silently breaks the chain.
    expect(d.situationId, 'diagnose dropped situationId — plan_intervention will refuse this')
      .toBe(SITUATION.id);
    // `recommendInterventions` reads factors.<key>.adequate on the Knowable branch.
    expect(d.factors, 'diagnose dropped the six-factor reading the planner branches on').toBeDefined();
    const factors = d.factors as Record<string, { adequate?: unknown }>;
    expect(Object.keys(factors).length).toBeGreaterThan(1);
    for (const [k, v] of Object.entries(factors)) {
      expect(typeof v.adequate, `factor ${k} has no boolean 'adequate'`).toBe('boolean');
    }
  });

  it('★ plan_intervention accepts that output verbatim, and plans something', async () => {
    const h = handlers();
    const d = await h['agp.diagnose']!({
      situation: SITUATION,
      factor_evidence: {
        knowledgeSkill: { adequate: false, evidence: 'nobody can name the topology unaided' },
      },
    }) as Record<string, unknown>;

    // Verbatim — no reshaping. That is the whole point: an agent chaining two published
    // affordances has only what the first one returned.
    const p = await h['agp.plan_intervention']!({ diagnosis: d, situation: SITUATION }) as Record<string, unknown>;

    expect(
      p.pending,
      `plan_intervention refused diagnose's own output: ${String(p.note ?? '')}`,
    ).toBeFalsy();
    expect(p.error, `plan_intervention threw on diagnose's own output: ${String(p.error ?? '')}`)
      .toBeUndefined();
  });

  it('a malformed factors is DECLINED, not crashed on', async () => {
    // The natural wrong guess — factors as a list of prose strings. It used to reach
    // `factors.instrumentation.adequate` and surface a TypeError as the API response.
    const h = handlers();
    const p = await h['agp.plan_intervention']!({
      diagnosis: {
        situationId: SITUATION.id, method: 'gap-analysis', regimeSource: 'asserted',
        domain: 'Knowable', factors: ['no shared model of the topology'],
      },
      situation: SITUATION,
    }) as Record<string, unknown>;
    expect(p.error, 'an internal TypeError was returned as the API response').toBeUndefined();
    expect(p.pending, 'a malformed diagnosis should be declined honestly').toBeTruthy();
  });
});
