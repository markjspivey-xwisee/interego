/**
 * A performance plan decides which content a learner can be shown, through published data.
 *
 * The regime routes the method, the method's plan selects interventions, and each intervention's
 * published method names the forms of content that deliver it (`agp:contentFormToken`). Foxxi
 * resolves a composition for a learner and admits only those forms. So nobody hands a lesson to
 * emergent work or a course to a broken tool, and the rule is data a reader can fetch, not a table
 * in code. The same holds for a person and for an agent, because a plan is about the work.
 */
import { describe, expect, it } from 'vitest';
import { admissionFromPlan, contentFormsFor } from '../applications/agentic-performance-practice/src/content-admission.js';
import { interventionMethods, loadInterventionMethods } from '../applications/agentic-performance-practice/src/intervention-methods.js';
import { readMethodsTurtle } from '../applications/agentic-performance-practice/src/ontology.js';
import type { WorkRegime } from '../applications/agentic-performance-practice/src/agent-disposition.js';
import {
  diagnose, recommendInterventions, type PerformanceSituation,
} from '../applications/agentic-performance-practice/src/performance-architecture.js';
import { compositionFrom, resolveComposition, type Composition } from '../applications/foxxi-content-intelligence/src/compositions.js';
import { FRAGMENT_KINDS, fragmentFrom, type Fragment } from '../applications/foxxi-content-intelligence/src/content-fragments.js';

const situationIn = (domain?: WorkRegime): PerformanceSituation => ({
  id: 'urn:test:situation', performer: { id: 'urn:test:performer', kind: 'human' },
  workContext: 'Handle refund requests', competency: 'refund-authority', observed: 'Uneven results', frequency: 'frequent',
  criticality: 'moderate', modalStatus: 'Hypothetical', provenance: 'synthetic test observation', ...(domain ? { domain } : {}),
});
const planIn = (domain?: WorkRegime) => {
  const situation = situationIn(domain);
  const diagnosis = diagnose({ situation });
  return { plan: recommendInterventions({ situation, diagnosis }), diagnosis };
};

describe('each intervention publishes the forms of content that deliver it', () => {
  it('names only forms Foxxi can store, gives every form an intervention, and gives an environmental fix none', () => {
    const kinds = new Set(FRAGMENT_KINDS.map(k => k.kind));
    const delivered = new Set(interventionMethods().flatMap(m => m.contentForms ?? []));
    for (const form of delivered) expect(kinds.has(form as never), form).toBe(true);
    for (const kind of kinds) expect(delivered.has(kind), kind).toBe(true);
    expect(contentFormsFor('instruction')).toEqual(expect.arrayContaining(['concept', 'worked-example']));
    expect(contentFormsFor('probe')).toEqual(['probe']);
    expect(contentFormsFor('coaching')).toEqual(['reflection']);
    expect(contentFormsFor('environmental-fix')).toEqual([]);
    expect(contentFormsFor('no-intervention')).toEqual([]);
  });

  it('refuses method data naming a form that is not a fragment kind', () => {
    const bad = readMethodsTurtle().replace('agp:contentFormToken "probe" ;', 'agp:contentFormToken "slideshow" ;');
    expect(bad).not.toBe(readMethodsTurtle());
    expect(() => loadInterventionMethods(bad)).toThrow(/"slideshow", which is not a Foxxi fragment kind/);
  });
});

describe('resolution admits what the plan for the work selected, for a person and an agent alike', () => {
  const frag = (raw: Record<string, unknown>): Fragment => fragmentFrom({ competencies: ['refund-authority'], ...raw });
  const lesson = frag({ kind: 'concept', body: 'Agents refund up to $250; a team lead approves more.' });
  const procedure = frag({ kind: 'reference', body: '1. Verify\n2. Refund up to $250\n3. Escalate the rest' });
  const check = frag({ kind: 'assessment-item', body: 'Check.', questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B' }] });
  const probe = frag({ kind: 'probe', body: 'Let agents approve up to $400 in one queue for a week; stop if disputes rise.', questions: [{ question: 'What changed?', type: 'long-fill-in' }] });
  const store = new Map<string, Fragment | Composition>([lesson, procedure, check, probe].map(x => [x['@id'], x]));
  const refunds = compositionFrom({ title: 'Refund authority', competency: 'refund-authority', positions: [
    { competency: 'refund-authority', paradigm: [lesson['@id'], procedure['@id'], check['@id'], probe['@id']] },
  ] });
  const resolveIn = (domain: WorkRegime | undefined, kind: 'human' | 'agent') => {
    const { plan, diagnosis } = planIn(domain);
    const admission = admissionFromPlan(plan, diagnosis);
    return { admission, resolution: resolveComposition({ composition: refunds, learner: { id: `did:web:${kind}.example`, kind }, lookup: i => store.get(i), admission: () => admission }) };
  };

  it.each([['a person', 'human'], ['an agent', 'agent']] as const)('for %s', (_learner, kind) => {
    // Emergent work is learned by acting: a probe, never the lesson that comes first in the list.
    const emergent = resolveIn('Emergent', kind);
    expect(emergent.admission.kinds).toEqual(expect.arrayContaining(['probe', 'reflection']));
    expect(emergent.admission.kinds).not.toContain('concept');
    expect(emergent.resolution.steps.map(s => s.fragment.kind)).toEqual(['probe']);
    expect(emergent.resolution.steps[0]!.chosenBecause).toMatch(/a concept is not admitted: the plan for this Emergent work selected/);

    // Turbulent work needs the environment fixed first: no content, and the resolution says so.
    const turbulent = resolveIn('Turbulent', kind);
    expect(turbulent.resolution.steps).toEqual([]);
    expect(turbulent.resolution.unmet[0]!.because).toBe('no content is admitted here: the plan for this Turbulent work selected environmental-fix, which no content delivers');

    // Evident work is looked up, not taught.
    expect(resolveIn('Evident', kind).resolution.steps.map(s => s.fragment.kind)).toEqual(['reference']);

    // Knowable work nobody has measured is measured before it is taught.
    expect(resolveIn('Knowable', kind).resolution.steps.map(s => s.fragment.kind)).toEqual(['assessment-item']);

    // Unclassified work has no plan to deliver: classify first.
    const unclassified = resolveIn(undefined, kind);
    expect(unclassified.resolution.unmet[0]!.because).toBe('no content is admitted here: the plan selected nothing yet; classify the work first');
  });
});
