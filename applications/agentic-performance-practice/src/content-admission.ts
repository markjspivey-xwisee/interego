/**
 * Which content a performance plan admits.
 *
 * Foxxi resolves a composition for each learner (foxxi-content-intelligence/src/compositions.ts)
 * and admits only the forms it is told suit a competency. Saying which forms suit it is this
 * practice's job, because it is a theory of performance: the regime routes the method, the
 * method's plan selects interventions, and each intervention's published method names the forms
 * of content that deliver it (`agp:contentFormToken` in ontology/agp-methods.ttl). This module
 * reads a plan through that data. It holds no table of its own.
 *
 * So a plan for Emergent work (probe, coaching) admits probes and reflection, never a lesson. A
 * plan for Turbulent work (an environmental fix) admits no content, and the resolution says so. A
 * plan for Evident work admits reference, and a Knowable one nobody has measured admits assessment
 * before any teaching. The same holds for a person and for an agent: a plan is about the work.
 *
 * The dependency runs from this practice to Foxxi, never back.
 */
import type { Admission } from '../../foxxi-content-intelligence/src/compositions.js';
import type { FragmentKind } from '../../foxxi-content-intelligence/src/content-fragments.js';
import { interventionMethods } from './intervention-methods.js';
import type { Diagnosis, InterventionPlan, InterventionType } from './performance-architecture.js';

/** The fragment kinds an intervention is delivered as, from its published method; none when it is not content. */
export function contentFormsFor(intervention: InterventionType): FragmentKind[] {
  const method = interventionMethods().find(m => m.intervention === intervention);
  if (!method) throw new Error(`No published method for the intervention "${intervention}"`);
  return (method.contentForms ?? []) as FragmentKind[];
}

/** What a plan admits: every form of every intervention it selected, and why, for the trace. */
export function admissionFromPlan(plan: Pick<InterventionPlan, 'selected'>, diagnosis?: Pick<Diagnosis, 'domain'>): Admission {
  const selected = plan.selected.map(o => o.type);
  const kinds = [...new Set(selected.flatMap(contentFormsFor))];
  const work = diagnosis?.domain ? ` for this ${diagnosis.domain} work` : '';
  const because = selected.length
    ? `the plan${work} selected ${selected.join(', ')}${kinds.length ? '' : ', which no content delivers'}`
    : `the plan${work} selected nothing yet; classify the work first`;
  return { kinds, because };
}
