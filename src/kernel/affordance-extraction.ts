/**
 * @module kernel/affordance-extraction
 * @description Substrate-level utility — pulls `cg:Affordance` blocks
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
 * affordance block (`cg:Affordance`, `cgh:Affordance`, `hydra:Operation`)
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
} from '../rdf/turtle-parser.js';
import { CG, HYDRA, DCAT } from '../rdf/namespaces.js';
import type { Affordance } from './types.js';

const AFFORDANCE_TYPE_IRIS: readonly IRI[] = [
  `${CG}Affordance` as IRI,
  // Harness namespace mirror — see applications/_shared/affordance-mcp/index.ts.
  'https://markjspivey-xwisee.github.io/interego/ns/cgh#Affordance' as IRI,
  `${HYDRA}Operation` as IRI,
];

const CG_ACTION = `${CG}action` as IRI;
const HYDRA_TARGET = `${HYDRA}target` as IRI;
const HYDRA_METHOD = `${HYDRA}method` as IRI;
const DCAT_MEDIA_TYPE = `${DCAT}mediaType` as IRI;

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Extract every `cg:Affordance` (and equivalent typed) block from a
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

  const out: Affordance[] = [];
  const seen = new Set<string>();
  for (const [key, subject] of candidateMap) {
    const action = readIriValue(subject, CG_ACTION);
    const target = readIriValue(subject, HYDRA_TARGET);
    if (!action || !target) continue;
    const methodRaw = (readStringValue(subject, HYDRA_METHOD) ?? 'POST').toUpperCase();
    const method = (VALID_METHODS.has(methodRaw) ? methodRaw : 'POST') as Affordance['method'];
    const mediaType = readStringValue(subject, DCAT_MEDIA_TYPE);

    const dedup = `${action}${target}${method}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    const aff: Mutable<Affordance> = {
      action,
      target,
      method,
    };
    if (mediaType) aff.mediaType = mediaType;
    if (sourceDescriptor) aff.fromDescriptor = sourceDescriptor;
    if (!key.startsWith('_:')) aff.subjectIri = key;
    out.push(aff);
  }

  return out;
}

/** Local mutable view to allow incremental fill of the readonly Affordance shape. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
