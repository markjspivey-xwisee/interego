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

  it('★★ the WHOLE chain composes: diagnose -> plan -> evaluate, each fed forward verbatim', async () => {
    /**
     * The test above pinned diagnose -> plan. That pair was fixed and this one was not, because
     * a two-link test proves nothing about the third node: `plan_intervention` renamed
     * `selected` to `interventions`, projected it down to `{type, rationale}` and dropped
     * `diagnosis` — the two fields `coercePlan` requires — so evaluate refused plan's own
     * answer with `pending: inputs-not-resolvable`.
     *
     * An agent chaining published affordances has only what the previous one returned. So each
     * step here passes the WHOLE prior answer, with no reshaping, and the assertion is simply
     * that the next tool accepts it.
     */
    const h = handlers();
    const d = await h['agp.diagnose']!({
      situation: SITUATION,
      factor_evidence: {
        knowledgeSkill: { adequate: false, evidence: 'nobody can name the topology unaided' },
        instrumentation: { adequate: false, evidence: 'the console needs an unfamiliar query language' },
      },
    }) as Record<string, unknown>;

    const p = await h['agp.plan_intervention']!({ diagnosis: d, situation: SITUATION }) as Record<string, unknown>;
    expect(p.pending, `plan refused diagnose's output: ${String(p.note ?? '')}`).toBeFalsy();

    // The link that was broken: plan's own answer must satisfy coercePlan.
    expect(p.diagnosis, 'plan dropped `diagnosis` — coercePlan requires it').toBeDefined();
    expect(Array.isArray(p.selected), 'plan dropped `selected` — coercePlan requires an array').toBe(true);

    const e = await h['agp.evaluate_intervention']!({
      intervention_iri: 'urn:agp:intervention:chain-test',
      plan: p,                 // verbatim, exactly as a chaining agent would
      situation: SITUATION,
      new_observed: 'median 12 minutes to first hypothesis over the following 5 incidents',
      outcome_success: true,
    }) as Record<string, unknown>;

    expect(
      e.pending,
      `evaluate refused plan's own output — the chain is still broken one link on: ${String(e.note ?? '')}`,
    ).toBeFalsy();
    expect(e.error, `evaluate threw on plan's output: ${String(e.error ?? '')}`).toBeUndefined();
    expect(e.evaluationIri, 'evaluate produced no verdict from a well-formed chain').toBeDefined();
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
    // ★ THIS ASSERTED `p.error` WAS ABSENT, WHICH WAS A PROXY, NOT THE PROPERTY.
    //
    // The property is that no INTERNAL TypeError is returned as the API response. Absence of an
    // `error` field stood in for that only while a decline carried no error field at all — and
    // once declines became typed refusals, an honest decline carries one by design. Kept as
    // written, this test would have failed the fix that made the decline answer HTTP 400.
    //
    // So it now asserts the thing itself: whatever is returned, it is not a crash.
    expect(
      String(p.error ?? ''),
      'an internal TypeError was returned as the API response',
    ).not.toMatch(/Cannot read propert|undefined is not|is not a function|TypeError/i);
    expect(p.pending, 'a malformed diagnosis should be declined honestly').toBeTruthy();
    expect(p.kind, 'the decline is untyped, so the dispatcher answers HTTP 200').toBe('refusal');
  });
});
