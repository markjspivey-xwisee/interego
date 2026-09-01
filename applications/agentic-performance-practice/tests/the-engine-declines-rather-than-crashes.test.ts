/**
 * A caller-supplied diagnosis never returns an internal TypeError as the API response.
 *
 * ── HOW THIS KEPT ESCAPING ───────────────────────────────────────────────────
 *
 * `recommendInterventions` reads fields off a `Diagnosis` that arrives as untyped JSON on a
 * public, unauthenticated bridge. The type says `rootCauses: string[]` is required; nothing
 * enforces that at the boundary, so the engine indexed into undefined.
 *
 * It was found and "fixed" twice before this file existed, each time by looking at ONE input:
 *
 *   round 1  `factors: ['a string']` — an array where an object was expected. Guarded in
 *            `coerceDiagnosis`, with a comment asserting that ABSENT factors were safe.
 *   round 2  an audit showed absent and partial factors both still threw
 *            (`reading 'information'`). Six dereferences were routed through an
 *            absence-tolerant helper, and the fix was verified against the deployed bridge.
 *   round 3  that live probe returned `reading '0'` — a DIFFERENT crash on the same request.
 *            The fix had moved it to `diagnosis.rootCauses[0]`, one branch further down.
 *
 * A one-field-at-a-time census does not find these: deleting a single field from a COMPLETE
 * diagnosis leaves the others to satisfy the guards. The crash needs several fields absent at
 * once, which is precisely what a real caller sends. So this drives the payloads a caller
 * actually writes, not perturbations of a payload the engine built for itself.
 */
import { describe, it, expect } from 'vitest';
import { recommendInterventions, diagnose } from '../src/performance-architecture.js';

const situation = {
  id: 'urn:agp:situation:probe',
  performer: { id: 'did:web:x#p', kind: 'human', role: 'r' },
  workContext: 'w', competency: 'c', observed: 'o',
  frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
} as unknown as Parameters<typeof recommendInterventions>[0]['situation'];

const plan = (diagnosis: unknown, s: unknown = situation): unknown =>
  recommendInterventions({ diagnosis, situation: s } as never);

describe('the planner declines rather than crashing on a caller-supplied diagnosis', () => {
  it('★ the payload a first-time caller sends does not throw', () => {
    // No factors, no rootCauses, no skillDeficiency — every one of them omitted together.
    // This exact body returned `Cannot read properties of undefined (reading '0')` from the
    // deployed bridge AFTER the round-2 fix was verified live.
    const minimal = {
      situationId: 'urn:agp:situation:probe', method: 'gap-analysis',
      regimeSource: 'asserted', domain: 'Knowable',
    };
    expect(() => plan(minimal)).not.toThrow();
    expect(() => plan({ ...minimal, factors: { knowledgeSkill: { adequate: false } } })).not.toThrow();
    expect(() => plan({ ...minimal, factors: {} })).not.toThrow();
    expect(() => plan({ ...minimal, rootCauses: [] })).not.toThrow();
  });

  it('★ every method routes without a complete diagnosis', () => {
    for (const [method, regimeSource, domain] of [
      ['classify-first', 'unclassified', undefined],
      ['dispositional-read', 'derived', 'Emergent'],
      ['stabilise-first', 'derived', 'Turbulent'],
      ['apply-practice', 'derived', 'Evident'],
      ['gap-analysis', 'asserted', 'Knowable'],
    ] as const) {
      expect(
        () => plan({ situationId: 'x', method, regimeSource, ...(domain ? { domain } : {}) }),
        `method ${method} threw on a bare diagnosis`,
      ).not.toThrow();
    }
  });

  it('a situation missing its performer is declined, not dereferenced', () => {
    const { performer: _drop, ...noPerformer } = situation as unknown as Record<string, unknown>;
    const d = diagnose({ situation, exemplary: 'e', couldPerformUnderIdealConditions: false } as never);
    expect(() => plan(d, noPerformer)).not.toThrow();
  });

  it('removing any single field from a COMPLETE diagnosis still routes', () => {
    // Kept because it is cheap — but note it passed throughout all three rounds above while
    // the bridge was crashing. It is the weaker half of this file, deliberately not the only half.
    const full = diagnose({
      situation, exemplary: 'e', couldPerformUnderIdealConditions: false,
      factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'x' } },
    } as never) as unknown as Record<string, unknown>;
    for (const k of Object.keys(full)) {
      const d = { ...full }; delete d[k];
      expect(() => plan(d), `diagnosis without .${k} threw`).not.toThrow();
    }
  });
});

describe('the summary states only what the analysis actually found', () => {
  /**
   * ★ The non-warranted branch ended in a hard-coded "the analysis isolated an environmental /
   * motivational / capacity cause". For a diagnosis with no factors, no root causes and no
   * skill finding, nothing was isolated — so the field a human reads asserted a conclusion the
   * engine had not computed. Found by reading the LIVE response after the crash was fixed:
   * HTTP 200 with an empty plan is not a silent nothing, but it was a false something.
   */
  it('★ an empty diagnosis is not reported as an isolated environmental cause', () => {
    const out = plan({
      situationId: 'urn:agp:situation:probe', method: 'gap-analysis',
      regimeSource: 'asserted', domain: 'Knowable',
    }) as { summary: string; selected: unknown[] };
    expect(out.selected).toEqual([]);
    expect(
      out.summary,
      'the summary claims a cause was isolated when the diagnosis carried no finding at all',
    ).not.toContain('isolated an environmental');
    expect(out.summary).toContain('No cause was isolated');
  });

  it('a diagnosis that DID find a cause still says so', () => {
    const out = plan({
      situationId: 'urn:agp:situation:probe', method: 'gap-analysis',
      regimeSource: 'asserted', domain: 'Knowable',
      factors: { incentives: { adequate: false } }, rootCauses: ['Incentives'],
    }) as { summary: string };
    // A real environmental finding must keep the sentence that describes it — a gate that
    // removed the claim everywhere would "fix" the symptom by making the API say less.
    expect(out.summary).toContain('isolated an environmental');
  });
});
