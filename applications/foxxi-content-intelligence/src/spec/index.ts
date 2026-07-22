/**
 * Spec-ontology registry + instance validators.
 *
 * SPEC_MODELS are the standards ontologies authored as single-source models, composed
 * into the PGSL lattice and projected (OWL/SHACL/JSON-LD) on dereference. The validators
 * run an instance against the SAME shapes the ontology publishes — so when the LRS/LMS
 * validates a statement/manifest it is validating against this composed, dereferenceable
 * ontology, and every result cites a sh:NodeShape IRI under <bridge>/ns/<module>/shapes.
 */
import { type OntologyModel, validateAgainstShape, shapesIri, composeSpecOntology, ns, NS_ROOT, NS_ROOT_LEGACY, type ValidationResult, type ComposedOntology } from '../spec-ontology.js';
import { validateStatement } from '../xapi-validate.js';
import { XAPI_MODEL } from './xapi.model.js';
import { CMI5_MODEL } from './cmi5.model.js';
import { SCORM_CAM_MODEL } from './scorm-cam.model.js';
import { SCORM_SN_MODEL } from './scorm-sn.model.js';
import { SCORM_RTE_MODEL } from './scorm-rte.model.js';
import { AI_ELEARNING_MODEL } from './ai-elearning.model.js';

/** The registered standards ontologies — each composed into the PGSL lattice and
 *  projected (OWL/SHACL/JSON-LD) dereferenceably at <bridge>/ns/<module>. */
export const SPEC_MODELS: Record<string, OntologyModel> = {
  [XAPI_MODEL.module]: XAPI_MODEL,
  [SCORM_CAM_MODEL.module]: SCORM_CAM_MODEL,
  [SCORM_SN_MODEL.module]: SCORM_SN_MODEL,
  [SCORM_RTE_MODEL.module]: SCORM_RTE_MODEL,
  [CMI5_MODEL.module]: CMI5_MODEL,
  [AI_ELEARNING_MODEL.module]: AI_ELEARNING_MODEL,
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
  // Close the gap between this public SHACL oracle and the internal ingest gate:
  // also run the structural validator the POST /xapi/statements path uses, so extra
  // top-level properties, empty-IFI accounts, etc. (which the drill-based shapes do
  // not catch) cannot pass here while being 400-rejected on ingest.
  for (const e of validateStatement(stmt)) {
    if (!out.some(r => r.message === e)) out.push({ path: 'statement', message: e, sourceShape: `${shapesIri(m)}#StatementShape`, severity: 'Violation' });
  }
  return { conforms: out.length === 0, results: out, shapesIri: shapesIri(m) };
}

/** Generic per-module validation entry (xapi drills via validateXapiStatement). */
export function validateInstance(module: string, instance: Record<string, unknown>): ValidationResult | null {
  if (module === 'xapi') return validateXapiStatement(instance);
  const m = SPEC_MODELS[module];
  if (!m) return null;
  return validateInstanceWith(m, instance);
}

/** Validate an instance against ANY ontology model by type-routing to its shapes —
 *  used for compliance models (soc2 / eu-ai-act / nist-rmf) served via the same
 *  /ns/<module> projection but registered outside the LMS/LRS SPEC_MODELS path. */
export function validateInstanceWith(m: OntologyModel, instance: Record<string, unknown>): ValidationResult {
  // Route to the shape whose targetClass matches the instance's declared type
  // (@type / objectType / type) — running EVERY shape against one flat instance would
  // produce spurious cross-class violations. Fall back to the first shape if untyped.
  // The declared type may be a single value OR an array (a W3C VC carries a `type`
  // array like ['VerifiableCredential','OpenBadgeCredential']). Map each to its local
  // name so credential validation routes to the right shape instead of stringifying
  // the array to one unmatchable token.
  const rawType = instance['@type'] ?? instance.assertionType ?? instance.objectType ?? instance.type ?? '';
  const rawTypes = (Array.isArray(rawType) ? rawType : [rawType]).map(String).filter(Boolean);
  const isAbs = (t: string): boolean => /^https?:\/\//.test(t);
  // Colon-aware local name so a CURIE (tla:Assertion) yields 'Assertion'; an absolute IRI's
  // fragment still wins because the delimiters after the scheme colon are `/` and `#`.
  const localName = (t: string): string => t.split(/[#/:]/).pop()!;
  // Absolute IRI form of a class token within this module (bare name → module ns; CURIE →
  // its declared prefix; absolute → itself) — lets routing compare by AUTHORITY, not just
  // the trailing segment.
  const prefixes: Record<string, string> = { ...(m.prefixes ?? {}), [m.module]: ns(m) };
  const absOf = (token: string): string => {
    if (isAbs(token)) return token;
    const cur = /^([a-z][\w-]*):(.+)$/i.exec(token);
    if (cur) { const base = prefixes[cur[1]!]; return base ? base + cur[2] : token; }
    return ns(m) + token;
  };
  // Subclass- AND equivalence-aware local routing: a shape applies to a declared LOCAL name
  // if its targetClass is an ANCESTOR (subClassOf) OR an owl:equivalentClass of it. Equivalence
  // is symmetric (both a class's own targets AND any class naming it). Used for bare/CURIE
  // @types where the authority is unavailable.
  const equivalentsOf = (name: string): string[] => {
    const out: string[] = [];
    for (const e of (m.classes.find(c => c.name === name)?.equivalentClass ?? [])) out.push(localName(e));
    for (const c of m.classes) if ((c.equivalentClass ?? []).some(e => localName(e) === name)) out.push(c.name);
    return out;
  };
  const ancestorsOf = (cls: string): Set<string> => {
    const seen = new Set<string>([cls]); const stack = [cls];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of (m.classes.find(c => c.name === cur)?.subClassOf ?? [])) {
        const base = localName(p);
        if (!seen.has(base)) { seen.add(base); stack.push(base); }
      }
      for (const eq of equivalentsOf(cur)) {
        if (!seen.has(eq)) { seen.add(eq); stack.push(eq); }
      }
    }
    return seen;
  };
  // The absolute IRIs a shape answers to: its targetClass IRI + each owl:equivalentClass IRI
  // (both directions). An absolute @type routes to a shape ONLY on an exact IRI match, so a
  // foreign-namespace type sharing a local name (https://evil.example/x#Assertion) never
  // collides onto a Foxxi/TLA shape — everything-is-a-URL: the authority is load-bearing.
  const shapeAbsIdentities = (targetClass: string): Set<string> => {
    const ids = new Set<string>([absOf(targetClass)]);
    for (const e of (m.classes.find(c => c.name === targetClass)?.equivalentClass ?? [])) ids.add(absOf(e));
    for (const c of m.classes) if ((c.equivalentClass ?? []).some(e => localName(e) === targetClass)) ids.add(absOf(c.name));
    return ids;
  };
  const declaredLocal = rawTypes.filter(t => !isAbs(t)).map(localName);
  // Canonicalize a legacy-Azure-host IRI to the live host: NS_ROOT_LEGACY is declared
  // owl:sameAs NS_ROOT and ids minted under it live in signed content we must not rewrite,
  // so a @type carrying the legacy host is the SAME term and must route identically.
  const canonHost = (iri: string): string => iri.startsWith(NS_ROOT_LEGACY) ? NS_ROOT + iri.slice(NS_ROOT_LEGACY.length) : iri;
  const declaredAbs = rawTypes.filter(isAbs).map(canonHost);
  const declaredNames = rawTypes.map(localName); // for the no-vacuous-pass decision below
  const applicableLocal = new Set<string>();
  for (const d of declaredLocal) for (const a of ancestorsOf(d)) applicableLocal.add(a);
  const matched = rawTypes.length ? m.shapes.filter(s =>
    applicableLocal.has(s.targetClass) || declaredAbs.some(rt => shapeAbsIdentities(s.targetClass).has(rt)),
  ) : [];
  // No vacuous pass: an instance that declares a type matching no shape is checked
  // against ALL the model's shapes (so a bogus/absent type cannot skip validation);
  // an untyped instance falls back to the model's primary shape.
  const shapes = matched.length ? matched : (declaredNames.length ? m.shapes : m.shapes.slice(0, 1));
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
