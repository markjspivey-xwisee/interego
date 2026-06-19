/**
 * Spec-ontology registry + instance validators.
 *
 * SPEC_MODELS are the standards ontologies authored as single-source models, composed
 * into the PGSL lattice and projected (OWL/SHACL/JSON-LD) on dereference. The validators
 * run an instance against the SAME shapes the ontology publishes — so when the LRS/LMS
 * validates a statement/manifest it is validating against this composed, dereferenceable
 * ontology, and every result cites a sh:NodeShape IRI under <bridge>/ns/<module>/shapes.
 */
import { type OntologyModel, validateAgainstShape, shapesIri, composeSpecOntology, type ValidationResult, type ComposedOntology } from '../spec-ontology.js';
import { XAPI_MODEL } from './xapi.model.js';
import { CMI5_MODEL } from './cmi5.model.js';
import { SCORM_CAM_MODEL } from './scorm-cam.model.js';
import { SCORM_SN_MODEL } from './scorm-sn.model.js';
import { SCORM_RTE_MODEL } from './scorm-rte.model.js';

/** The registered standards ontologies — each composed into the PGSL lattice and
 *  projected (OWL/SHACL/JSON-LD) dereferenceably at <bridge>/ns/<module>. */
export const SPEC_MODELS: Record<string, OntologyModel> = {
  [XAPI_MODEL.module]: XAPI_MODEL,
  [SCORM_CAM_MODEL.module]: SCORM_CAM_MODEL,
  [SCORM_SN_MODEL.module]: SCORM_SN_MODEL,
  [SCORM_RTE_MODEL.module]: SCORM_RTE_MODEL,
  [CMI5_MODEL.module]: CMI5_MODEL,
};

export { validateAgainstShape, shapesIri };
export type { ValidationResult };

/** Validate an xAPI Statement against the composed xAPI ontology's shapes. Drills into
 *  the verb / object / result / score / actor / attachments sub-shapes. */
export function validateXapiStatement(stmt: Record<string, unknown>): ValidationResult {
  const m = XAPI_MODEL;
  const out: ValidationResult['results'] = [];
  out.push(...validateAgainstShape(m, 'StatementShape', stmt).results);
  if (stmt.verb && typeof stmt.verb === 'object') out.push(...validateAgainstShape(m, 'VerbShape', stmt.verb as Record<string, unknown>).results);
  const obj = stmt.object as Record<string, unknown> | undefined;
  if (obj && typeof obj === 'object') {
    const ot = obj.objectType;
    if (ot === 'Activity' || (!ot && typeof obj.id === 'string')) {
      out.push(...validateAgainstShape(m, 'ActivityShape', obj).results);
      if (obj.definition && typeof obj.definition === 'object') out.push(...validateAgainstShape(m, 'InteractionDefinitionShape', obj.definition as Record<string, unknown>).results);
    }
  }
  if (stmt.result && typeof stmt.result === 'object') {
    const result = stmt.result as Record<string, unknown>;
    out.push(...validateAgainstShape(m, 'ResultShape', result).results);
    if (result.score && typeof result.score === 'object') out.push(...validateAgainstShape(m, 'ScoreShape', result.score as Record<string, unknown>).results);
  }
  if (stmt.actor && typeof stmt.actor === 'object') {
    const actor = stmt.actor as Record<string, unknown>;
    const shapeUri = `${shapesIri(m)}#GroupShape`;
    if (actor.objectType === 'Group') {
      out.push(...validateAgainstShape(m, 'GroupShape', actor).results);
      const ifis = ['mbox', 'mbox_sha1sum', 'openid', 'account'].filter(k => actor[k] != null);
      const hasMembers = Array.isArray(actor.member) && actor.member.length > 0;
      if (!hasMembers && ifis.length !== 1) out.push({ path: 'member|ifi', message: 'a Group must be anonymous (a member list) or identified by exactly one IFI (§4.1.2.2)', sourceShape: shapeUri, severity: 'Violation' });
      if (hasMembers && ifis.length > 0) out.push({ path: 'ifi', message: 'an anonymous Group (with members) must not carry an IFI (§4.1.2.2)', sourceShape: shapeUri, severity: 'Violation' });
    } else {
      out.push(...validateAgainstShape(m, 'AgentShape', actor).results); // enforces exactly-one IFI via sh:xone
    }
  }
  for (const att of (Array.isArray(stmt.attachments) ? stmt.attachments : []) as Array<Record<string, unknown>>) {
    out.push(...validateAgainstShape(m, 'AttachmentShape', att).results);
  }
  return { conforms: out.length === 0, results: out, shapesIri: shapesIri(m) };
}

/** Generic per-module validation entry (xapi drills via validateXapiStatement). */
export function validateInstance(module: string, instance: Record<string, unknown>): ValidationResult | null {
  if (module === 'xapi') return validateXapiStatement(instance);
  const m = SPEC_MODELS[module];
  if (!m) return null;
  // Route to the shape whose targetClass matches the instance's declared type
  // (@type / objectType / type) — running EVERY shape against one flat instance would
  // produce spurious cross-class violations. Fall back to the first shape if untyped.
  const declared = String((instance['@type'] ?? instance.objectType ?? instance.type ?? '')).split(/[#/]/).pop();
  const matched = declared ? m.shapes.filter(s => s.targetClass === declared) : [];
  const shapes = matched.length ? matched : (declared ? [] : m.shapes.slice(0, 1));
  const out: ValidationResult['results'] = [];
  for (const s of shapes) out.push(...validateAgainstShape(m, s.name, instance).results);
  return { conforms: out.length === 0, results: out, shapesIri: shapesIri(m) };
}

/** Compose every registered spec ontology into the shared lattice (best-effort). */
export async function composeAllSpecOntologies(opts: { podUrl: string; agentDid: string }): Promise<ComposedOntology[]> {
  const out: ComposedOntology[] = [];
  for (const m of Object.values(SPEC_MODELS)) {
    try { out.push(await composeSpecOntology(m, opts)); } catch { /* best-effort */ }
  }
  return out;
}
