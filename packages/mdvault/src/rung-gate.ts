/**
 * The rung ceiling — the general, profile-driven authority gate (the security core).
 *
 * HyperMarkdown is a progressive-enhancement spectrum: rung 1 inert prose, rung 2 YAML-LD
 * structure, rung 3 grounded semantics + typed links, rung 4 authority-closed executable
 * controls. A profile declares its ceiling. A rung-<=3 profile (Vault-LD is one) is
 * DESCRIPTIVE DATA ONLY: it must never carry execution authority into the active/signed
 * graph. This module is that one general rule — NOT a Vault-LD keyword list.
 *
 * The check runs on the EXPANDED predicate + rdf:type IRIs, never the surface YAML keys,
 * because authority reaches the graph many ways that a key-name blocklist misses:
 *   - the substrate's own KERNEL_JSONLD_CONTEXT already aliases `target`->hydra:target and
 *     `action`->iep:action, so a plain `target:`/`action:` key expands to an authority
 *     predicate with no hostile context at all;
 *   - a hostile external `context.jsonld` remaps an innocent key onto hydra:target / etc.
 *     (D7), or aliases a term onto `@type` = hydra:Operation;
 *   - a CURIE / full-IRI key (`hydra:target:`), or a literal `@type: hydra:Operation`.
 * So we canonicalize every expanded IRI (folding the deprecated cg:/cgh: read-aliases) and
 * REFUSE the note (hard quarantine — georgio A8/E6/D7) if any predicate or type is in the
 * authority set. Source bytes still recover from their atom; only the active graph is gated.
 *
 * `maxRung >= 4` (full HMD) short-circuits to allow — authority is legitimate there.
 */

// Stable, published authority namespaces. Pinned EXPLICITLY (not imported) so this
// security denylist is auditable in one place; a drift-guard test asserts they equal
// @interego/core's exported CG (=IEP) and HYDRA.
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const IEH = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const CG_LEGACY = 'https://markjspivey-xwisee.github.io/interego/ns/cg#';
const CGH_LEGACY = 'https://markjspivey-xwisee.github.io/interego/ns/cgh#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const HMD = 'https://relay.interego.xwisee.com/ns/maintainer/hmd#';

/** Fold the deprecated `cg:`/`cgh:` read-alias namespaces onto their canonical
 *  `iep:`/`ieh:` form before matching, so `cg#action` matches `iep#action` etc. */
export function canonicalizeAuthorityIri(iri: string): string {
  if (iri.startsWith(CG_LEGACY)) return IEP + iri.slice(CG_LEGACY.length);
  if (iri.startsWith(CGH_LEGACY)) return IEH + iri.slice(CGH_LEGACY.length);
  return iri;
}

/** Predicates that assert EXECUTION AUTHORITY — a callable operation, its target/method,
 *  or an affordance's action. Rung 4 only. */
export const AUTHORITY_PREDICATES: ReadonlySet<string> = new Set([
  HYDRA + 'target',
  HYDRA + 'method',
  HYDRA + 'operation',
  HYDRA + 'supportedOperation',
  IEP + 'action',
  HMD + 'target',
  HMD + 'rel',
  HMD + 'control',
]);

/** rdf:type objects that make a node an executable affordance / operation / control.
 *  Rung 4 only. (A deprecated cgh#Affordance is canonicalized onto its ieh# form first.) */
export const AUTHORITY_TYPES: ReadonlySet<string> = new Set([
  HYDRA + 'Operation',
  IEP + 'Affordance',
  IEH + 'Affordance',
  HMD + 'Control',
]);

export type RungViolationKind = 'authority-predicate' | 'authority-type';

export interface RungViolation {
  readonly kind: RungViolationKind;
  /** the offending expanded IRI (pre-canonicalization, as it appeared). */
  readonly iri: string;
}

export interface RungGateResult {
  readonly ok: boolean;
  readonly violations: readonly RungViolation[];
}

/**
 * Screen a note's expanded predicates + rdf:type objects against the authority ceiling.
 * @param predicates expanded (absolute-IRI) predicates the note's frontmatter produced.
 * @param types      expanded (absolute-IRI) rdf:type objects the note declares.
 * @param maxRung    the active profile's ceiling; authority is screened only when < 4.
 */
export function screenAuthorityCeiling(
  predicates: readonly string[],
  types: readonly string[],
  maxRung: number,
): RungGateResult {
  if (maxRung >= 4) return { ok: true, violations: [] };
  const violations: RungViolation[] = [];
  for (const p of predicates) {
    if (AUTHORITY_PREDICATES.has(canonicalizeAuthorityIri(p))) {
      violations.push({ kind: 'authority-predicate', iri: p });
    }
  }
  for (const t of types) {
    if (AUTHORITY_TYPES.has(canonicalizeAuthorityIri(t))) {
      violations.push({ kind: 'authority-type', iri: t });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ── Entailment closure (georgio's finding: semantic-layer authority smuggling) ──
//
// A direct check screens rdf:type objects + predicates against the authority set, but an
// RDFS/OWL-aware consumer can INFER authority from axioms that never place a forbidden IRI
// directly: `MyClass rdfs:subClassOf hydra:Operation` + `x rdf:type MyClass` entails
// `x rdf:type hydra:Operation`; likewise owl:equivalentClass, and rdfs:subPropertyOf /
// owl:equivalentProperty / owl:sameAs for predicates. So the rung-<=3 closure must be closed
// under entailment: a class/property that REACHES the authority set through those axioms is
// itself authority-bearing, and any note that defines such an axiom OR uses a tainted term
// is quarantined.
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SUBCLASS_OF = `${RDFS}subClassOf`;
const EQUIVALENT_CLASS = `${OWL}equivalentClass`;
const SUB_PROPERTY_OF = `${RDFS}subPropertyOf`;
const EQUIVALENT_PROPERTY = `${OWL}equivalentProperty`;
const SAME_AS = `${OWL}sameAs`;

export interface TripleLike {
  readonly s: string;
  readonly p: string;
  readonly o: string;
  readonly oKind: string;
}

export interface GraphAuthorityScreen {
  /** classes that reach an authority TYPE via subClassOf/equivalentClass/sameAs. */
  readonly taintedClasses: ReadonlySet<string>;
  /** properties that reach an authority PREDICATE via subPropertyOf/equivalentProperty/sameAs. */
  readonly taintedPredicates: ReadonlySet<string>;
}

/** Least fixed point: a source is tainted if its target is. */
function closure(seed: Iterable<string>, edges: ReadonlyArray<readonly [string, string]>): Set<string> {
  const tainted = new Set<string>(seed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [s, t] of edges) {
      if (tainted.has(t) && !tainted.has(s)) { tainted.add(s); changed = true; }
    }
  }
  return tainted;
}

/** Compute the entailment-closed authority class + predicate sets over a whole graph. */
export function computeGraphAuthority(triples: readonly TripleLike[]): GraphAuthorityScreen {
  const classEdges: Array<readonly [string, string]> = [];
  const predEdges: Array<readonly [string, string]> = [];
  for (const t of triples) {
    if (t.oKind !== 'iri') continue;
    const s = canonicalizeAuthorityIri(t.s);
    const o = canonicalizeAuthorityIri(t.o);
    switch (t.p) {
      case SUBCLASS_OF: classEdges.push([s, o]); break;                // s ⊑ o → s tainted if o
      case EQUIVALENT_CLASS: classEdges.push([s, o], [o, s]); break;   // symmetric
      case SUB_PROPERTY_OF: predEdges.push([s, o]); break;             // s ⊑ o → s tainted if o
      case EQUIVALENT_PROPERTY: predEdges.push([s, o], [o, s]); break; // symmetric
      case SAME_AS: classEdges.push([s, o], [o, s]); predEdges.push([s, o], [o, s]); break;
      default: break;
    }
  }
  return {
    taintedClasses: closure([...AUTHORITY_TYPES], classEdges),
    taintedPredicates: closure([...AUTHORITY_PREDICATES], predEdges),
  };
}

export interface AuthorityViolation {
  readonly violated: boolean;
  readonly reasons: readonly string[];
}

/** Does a note's triples carry execution authority — directly, via an authority-linking
 *  axiom, or via an entailment chain reaching the authority set? */
export function noteAuthorityViolation(noteTriples: readonly TripleLike[], screen: GraphAuthorityScreen): AuthorityViolation {
  const reasons: string[] = [];
  for (const t of noteTriples) {
    const p = canonicalizeAuthorityIri(t.p);
    const o = canonicalizeAuthorityIri(t.o);
    if (p === RDF_TYPE && t.oKind === 'iri' && screen.taintedClasses.has(o)) {
      reasons.push(`rdf:type reaches authority class ${o}`);
    }
    if (screen.taintedPredicates.has(p)) {
      reasons.push(`predicate reaches authority predicate ${p}`);
    }
    if (t.oKind === 'iri') {
      if ((t.p === SUBCLASS_OF || t.p === EQUIVALENT_CLASS || t.p === SAME_AS) && screen.taintedClasses.has(o)) {
        reasons.push(`axiom links a class to authority ${o}`);
      }
      if ((t.p === SUB_PROPERTY_OF || t.p === EQUIVALENT_PROPERTY || t.p === SAME_AS) && screen.taintedPredicates.has(o)) {
        reasons.push(`axiom links a property to authority ${o}`);
      }
    }
  }
  return { violated: reasons.length > 0, reasons };
}
