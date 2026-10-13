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
    } else if (ot === 'StatementRef') {
      out.push(...validateAgainstShape(m, 'StatementRefShape', obj).results);
    } else if (ot === 'SubStatement') {
      out.push(...validateAgainstShape(m, 'SubStatementShape', obj).results);
    }
  }
  // Context (§5.2.2.5) and the xAPI 2.0 context agents / groups each have a published shape.
  const asObj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x)) ? x as Record<string, unknown> : null;
  const ctx = asObj(stmt.context);
  if (ctx) {
    out.push(...validateAgainstShape(m, 'ContextShape', ctx).results);
    for (const ca of (Array.isArray(ctx.contextAgents) ? ctx.contextAgents : [])) { const o = asObj(ca); if (o) out.push(...validateAgainstShape(m, 'ContextAgentShape', o).results); }
    for (const cg of (Array.isArray(ctx.contextGroups) ? ctx.contextGroups : [])) { const o = asObj(cg); if (o) out.push(...validateAgainstShape(m, 'ContextGroupShape', o).results); }
  }
  if (stmt.result && typeof stmt.result === 'object') {
    const result = stmt.result as Record<string, unknown>;
    out.push(...validateAgainstShape(m, 'ResultShape', result).results);
    if (result.score && typeof result.score === 'object') out.push(...validateAgainstShape(m, 'ScoreShape', result.score as Record<string, unknown>).results);
  }
  if (stmt.actor && typeof stmt.actor === 'object') {
    const actor = stmt.actor as Record<string, unknown>;
    if (actor.objectType === 'Group') {
      // Identified (exactly one IFI; members optional) or anonymous (members, no IFI) — the shape
      // says it (IdentifiedGroupShape | AnonymousGroupShape). It used to be coded here, and refused
      // an Identified Group that lists its members, which xAPI 2.0 allows (§5.2.2.1).
      out.push(...validateAgainstShape(m, 'GroupShape', actor).results);
    } else {
      out.push(...validateAgainstShape(m, 'AgentShape', actor).results); // enforces exactly-one IFI via sh:xone
    }
    const account = asObj(actor.account);
    if (account) out.push(...validateAgainstShape(m, 'AccountShape', account).results);
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
  const typesOf = (node: Record<string, unknown>): string[] => {
    const raw = node['@type'] ?? node.assertionType ?? node.objectType ?? node.type ?? '';
    return (Array.isArray(raw) ? raw : [raw]).filter(t => typeof t === 'string' && t !== '') as string[];
  };
  const rawTypes = typesOf(instance);
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
  // Subclass- AND alignment-aware local routing: a shape applies to a declared LOCAL name if its
  // targetClass is an ANCESTOR (subClassOf) of it, or a class the model ALIGNS with it —
  // owl:equivalentClass, or a skos:exactMatch / skos:closeMatch mapping. The mappings are
  // editorial alignments, not logical identity, and they are used here for exactly what they
  // claim: that instances typed with the aligned class are what this shape is written for (a
  // tla:Assertion is checked as an IEEE-LER competency assertion). Symmetric (a class's own
  // alignments AND any class naming it). Used for bare/CURIE @types where the authority is
  // unavailable.
  const aliasesOf = (c: { equivalentClass?: readonly string[]; exactMatch?: readonly string[]; closeMatch?: readonly string[] } | undefined): readonly string[] =>
    c ? [...(c.equivalentClass ?? []), ...(c.exactMatch ?? []), ...(c.closeMatch ?? [])] : [];
  const equivalentsOf = (name: string): string[] => {
    const out: string[] = [];
    for (const e of aliasesOf(m.classes.find(c => c.name === name))) out.push(localName(e));
    for (const c of m.classes) if (aliasesOf(c).some(e => localName(e) === name)) out.push(c.name);
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
  // The absolute IRIs a shape answers to: its targetClass IRI + each class aligned with it
  // (both directions). An absolute @type routes to a shape ONLY on an exact IRI match, so a
  // foreign-namespace type sharing a local name (https://evil.example/x#Assertion) never
  // collides onto a Foxxi/TLA shape — everything-is-a-URL: the authority is load-bearing.
  const shapeAbsIdentities = (targetClass: string): Set<string> => {
    const ids = new Set<string>([absOf(targetClass)]);
    for (const e of aliasesOf(m.classes.find(c => c.name === targetClass))) ids.add(absOf(e));
    for (const c of m.classes) if (aliasesOf(c).some(e => localName(e) === targetClass)) ids.add(absOf(c.name));
    return ids;
  };
  // The shapes written for a node's declared types: by local name (with subclasses and
  // alignments) for a bare type, by exact IRI for an absolute one.
  const canonHost = (iri: string): string => iri.startsWith(NS_ROOT_LEGACY) ? NS_ROOT + iri.slice(NS_ROOT_LEGACY.length) : iri;
  const shapesFor = (types: readonly string[]): OntologyModel['shapes'] => {
    // Canonicalize a legacy-Azure-host IRI to the live host: ids minted under it live in signed
    // content we must not rewrite, so a @type carrying the legacy host is the SAME term and must
    // route identically.
    const declaredAbs = types.filter(isAbs).map(canonHost);
    const applicableLocal = new Set<string>();
    for (const d of types.filter(t => !isAbs(t)).map(localName)) for (const a of ancestorsOf(d)) applicableLocal.add(a);
    // A shape's targetClass may be another vocabulary's class (ob:OpenBadgeCredential): its local
    // name routes a bare type, its absolute IRI an absolute one.
    const bare = new Set(types.filter(t => !isAbs(t)));
    return types.length ? m.shapes.filter(s => (s.targetClass !== undefined
      && (applicableLocal.has(localName(s.targetClass)) || declaredAbs.some(rt => shapeAbsIdentities(s.targetClass!).has(rt))))
      || (s.jsonTypes ?? []).some(t => bare.has(t)),
    ) : [];
  };
  const matched = shapesFor(rawTypes);
  // No vacuous pass: an instance that declares a type matching no shape is checked
  // against ALL the model's shapes (so a bogus/absent type cannot skip validation);
  // an untyped instance falls back to the model's primary shape.
  const targeted = m.shapes.filter(s => s.targetClass !== undefined);
  const shapes = matched.length ? matched : (rawTypes.length ? targeted : targeted.slice(0, 1));
  const out: ValidationResult['results'] = [];
  for (const s of shapes) out.push(...validateAgainstShape(m, s.name, instance).results);
  // A SHACL processor checks every node of a shape's class, not only the document's root: a
  // nested object that declares a type a shape is written for is checked against that shape too,
  // as it is in the document's RDF reading — and so is a nested object reached by a key whose
  // values a shape selects (sh:targetObjectsOf; the shape names the key, jsonKeys). A nested object
  // no shape is written for is left alone — the no-vacuous-pass rule is about the document, not
  // every node in it — and so are the @context and a credential's proof, which its RDF reading
  // puts in a graph of its own.
  const visit = (value: unknown, at: string, key?: string): void => {
    if (Array.isArray(value)) { for (const v of value) visit(v, at, key); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (at) {
      const byKey = key === undefined ? [] : m.shapes.filter(s => s.jsonKeys?.includes(key));
      for (const s of new Set([...shapesFor(typesOf(node)), ...byKey])) {
        out.push(...validateAgainstShape(m, s.name, node).results.map(r => ({ ...r, path: `${at}.${r.path}` })));
      }
    }
    for (const [k, v] of Object.entries(node)) if (k !== '@context' && k !== 'proof') visit(v, at ? `${at}.${k}` : k, k);
  };
  visit(instance, '');
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
