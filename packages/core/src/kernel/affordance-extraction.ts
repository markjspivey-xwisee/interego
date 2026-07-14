/**
 * @module kernel/affordance-extraction
 * @description Substrate-level utility — pulls `iep:Affordance` blocks
 * from any Turtle/TriG/RDF representation and returns them as
 * structured `Affordance` objects.
 *
 * This is the shared logic between two kernel verbs:
 *   - `dereference` — when fetching a descriptor / graph, surface the
 *     carried affordances so callers can drive next steps via
 *     hypermedia (HATEOAS — the constraint that makes Interego
 *     composable across vocabularies; see ARCHITECTURAL-FOUNDATIONS §6).
 *   - manifest-walk inside `dereference` — when fetching a pod's
 *     `.well-known/context-graphs`, decorate each entry with the
 *     affordances of its referenced descriptor.
 *
 * The extractor accepts every `rdf:type` the substrate uses for an
 * affordance block (`iep:Affordance`, `ieh:Affordance`, `hydra:Operation`)
 * and returns deduplicated results keyed on `(action, target, method)`.
 *
 * No new ontology terms are introduced — this is code-level surface
 * over the existing protocol vocabulary.
 */

import type { IRI } from '../model/types.js';
import {
  parseTrig,
  findSubjectsOfType,
  readIriValue,
  readStringValue,
  type ParsedSubject,
} from '../rdf/turtle-parser.js';
import { CG, IEH, CGH_LEGACY, HYDRA, DCAT } from '../rdf/namespaces.js';
import type { Affordance, ShapeField } from './types.js';

const SHACL = 'http://www.w3.org/ns/shacl#';
const SH_PROPERTY = `${SHACL}property` as IRI;
const SH_PATH = `${SHACL}path` as IRI;
const SH_DATATYPE = `${SHACL}datatype` as IRI;
const SH_MIN_COUNT = `${SHACL}minCount` as IRI;
const SH_MAX_COUNT = `${SHACL}maxCount` as IRI;
const SH_NAME = `${SHACL}name` as IRI;
const SH_DESCRIPTION = `${SHACL}description` as IRI;

const AFFORDANCE_TYPE_IRIS: readonly IRI[] = [
  `${CG}Affordance` as IRI,
  // Harness namespace mirror — see applications/_shared/affordance-mcp/index.ts.
  `${IEH}Affordance` as IRI,
  // Deprecated read-alias: data persisted while the kernel emitted the
  // never-published ns/cgh# IRI still carries this type in its (signed) bytes.
  `${CGH_LEGACY}Affordance` as IRI,
  `${HYDRA}Operation` as IRI,
];

const CG_ACTION = `${CG}action` as IRI;
const HYDRA_TARGET = `${HYDRA}target` as IRI;
const HYDRA_METHOD = `${HYDRA}method` as IRI;
const DCAT_MEDIA_TYPE = `${DCAT}mediaType` as IRI;
const HYDRA_EXPECTS = `${HYDRA}expects` as IRI;
const HYDRA_RETURNS = `${HYDRA}returns` as IRI;
const CG_INPUT_SHAPE = `${CG}inputShape` as IRI;

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Extract every `iep:Affordance` (and equivalent typed) block from a
 * Turtle/TriG/RDF document body.
 *
 * Robust to partially-malformed documents: if a full-document parse
 * fails, returns an empty array rather than throwing — affordance
 * surfacing is best-effort hypermedia, not a critical-path operation.
 *
 * @param turtle  Raw Turtle/TriG document.
 * @param sourceDescriptor Optional URL of the descriptor this body was
 *   fetched from; echoed on each returned `Affordance.fromDescriptor`.
 */
export function extractAffordancesFromTurtle(
  turtle: string,
  sourceDescriptor?: string,
  opts?: { readonly requireTarget?: boolean },
): readonly Affordance[] {
  if (!turtle || turtle.trim().length === 0) return [];

  let doc;
  try {
    doc = parseTrig(turtle);
  } catch {
    // Best-effort: a malformed block in a manifest's neighbor shouldn't
    // wipe out the whole affordance surface. Bail to empty.
    return [];
  }

  const candidateMap = new Map<string, ReturnType<typeof findSubjectsOfType>[number]>();
  for (const typeIri of AFFORDANCE_TYPE_IRIS) {
    for (const s of findSubjectsOfType(doc, typeIri)) {
      const key = typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`;
      if (!candidateMap.has(key)) candidateMap.set(key, s);
    }
  }

  const requireTarget = opts?.requireTarget ?? true;
  // Index every subject (IRI and blank node) so a control's `expects` SHACL shape
  // — and its sh:property blank nodes — can be resolved within THIS parse, where
  // the reference IRI and the subject IRI are guaranteed to match.
  const byKey = new Map<string, ParsedSubject>();
  for (const s of doc.subjects) {
    byKey.set(typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`, s);
  }
  const out: Affordance[] = [];
  const seen = new Set<string>();
  for (const [key, subject] of candidateMap) {
    const action = readIriValue(subject, CG_ACTION);
    if (!action) continue;
    let target = readIriValue(subject, HYDRA_TARGET);
    if (!target) {
      // Authority-closed control (e.g. an HMD :::control declared in a signed
      // payload graph) carries NO hydra:target by design — its target IS its own
      // fragment identity, which the projection re-computes as <@id>#control-*.
      // Strict callers (dereference / the act follower) still require a real
      // transport target; projection callers pass requireTarget:false to surface
      // these controls rather than silently dropping them (the defect georgio hit).
      if (requireTarget) continue;
      target = key.startsWith('_:') ? action : key;
    }
    const methodRaw = (readStringValue(subject, HYDRA_METHOD) ?? 'POST').toUpperCase();
    const method = (VALID_METHODS.has(methodRaw) ? methodRaw : 'POST') as Affordance['method'];
    const mediaType = readStringValue(subject, DCAT_MEDIA_TYPE);
    // Input/output contract — the SHACL input shape a caller validates against
    // (hydra:expects or iep:inputShape) + hydra:returns, as dereferenceable IRIs.
    // Bare-fragment refs (`#Shape`) are resolved against the source document base
    // so the emitted reference is absolute, not relative to the render URL.
    const rawExpects = readIriValue(subject, HYDRA_EXPECTS) ?? readIriValue(subject, CG_INPUT_SHAPE);
    const expects = resolveFragment(rawExpects, sourceDescriptor);
    const returns = resolveFragment(readIriValue(subject, HYDRA_RETURNS), sourceDescriptor);
    // Inline the expects shape's field constraints (sh:property) when the shape is
    // defined in THIS graph — a form client then renders the form with no second
    // dereference. Matched on the RAW expects (same parse → same subject key).
    const fields = rawExpects ? shapeFieldsFor(byKey, rawExpects, sourceDescriptor) : undefined;

    const dedup = `${action}${target}${method}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    const aff: Mutable<Affordance> = {
      action,
      target,
      method,
    };
    if (mediaType) aff.mediaType = mediaType;
    if (expects) aff.expects = expects;
    if (returns) aff.returns = returns;
    if (fields) aff.fields = fields;
    if (sourceDescriptor) aff.fromDescriptor = sourceDescriptor;
    if (!key.startsWith('_:')) aff.subjectIri = key;
    out.push(aff);
  }

  return out;
}

/** Resolve a bare-fragment IRI (`#Shape`) against a document base so an emitted
 *  reference is absolute + dereferenceable; absolute / non-fragment values pass
 *  through unchanged. Handles `urn:` / `did:` bases (the URL constructor can't). */
function resolveFragment(iri: string | undefined, base?: string): string | undefined {
  if (!iri) return undefined;
  if (iri.startsWith('#') && base) return `${base.split('#')[0]}${iri}`;
  return iri;
}

/** Read the `sh:property` field constraints of the SHACL NodeShape `shapeIri`
 *  from the pre-indexed subjects — path/name/description/datatype/min/maxCount.
 *  Returns undefined when the shape isn't defined here (then the `expects` IRI is
 *  the caller's only handle, exactly as before). Best-effort: a malformed field
 *  is skipped, never thrown. */
function shapeFieldsFor(
  byKey: Map<string, ParsedSubject>,
  shapeIri: string,
  base?: string,
): ShapeField[] | undefined {
  const shape = byKey.get(shapeIri);
  const props = shape?.properties.get(SH_PROPERTY);
  if (!props || props.length === 0) return undefined;
  const fields: ShapeField[] = [];
  for (const term of props) {
    const key = term.kind === 'iri' ? term.iri : term.kind === 'bnode' ? `_:${term.id}` : undefined;
    if (!key) continue;
    const ps = byKey.get(key);
    if (!ps) continue;
    const path = readIriValue(ps, SH_PATH);
    if (!path) continue;
    const f: { -readonly [K in keyof ShapeField]: ShapeField[K] } = { path: resolveFragment(path, base) ?? path };
    const dt = readIriValue(ps, SH_DATATYPE); if (dt) f.datatype = resolveFragment(dt, base) ?? dt;
    const nm = readStringValue(ps, SH_NAME); if (nm) f.name = nm;
    const de = readStringValue(ps, SH_DESCRIPTION); if (de) f.description = de;
    const mn = Number(readStringValue(ps, SH_MIN_COUNT)); if (Number.isInteger(mn)) f.minCount = mn;
    const mx = Number(readStringValue(ps, SH_MAX_COUNT)); if (Number.isInteger(mx)) f.maxCount = mx;
    fields.push(f);
  }
  return fields.length ? fields : undefined;
}

/** Local mutable view to allow incremental fill of the readonly Affordance shape. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
