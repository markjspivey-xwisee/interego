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

// ── Entailment closure (georgio's findings: semantic-layer authority smuggling) ──
//
// A direct check screens rdf:type objects + predicates, but an RDFS/OWL reasoner INFERS
// authority from axioms that never place a forbidden IRI directly in type/predicate
// position: subClassOf/equivalentClass (class), subPropertyOf/equivalentProperty/inverseOf/
// sameAs (predicate), rdfs:domain/rdfs:range (a property confers a class on its subject/
// object), and owl:Restriction via owl:onProperty (a class defined over a property).
//
// KEY INVARIANT (the construct-agnostic floor): RDFS/OWL entailment is IRI-conservative —
// the entailment closure of a graph mentions no IRI absent from it. So a graph in which NO
// authority IRI appears in ANY position cannot entail authority under ANY construct (modeled
// here or not: property chains, cardinality, future OWL). Therefore quarantining every note
// that NAMES an authority IRI severs every path to authority regardless of the mechanism.
// The entailment closure below is the second layer — it also quarantines the DEPENDENT notes
// (uses of a tainted local term) so the active graph carries no dangling authority scaffolding.
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SUBCLASS_OF = `${RDFS}subClassOf`;
const EQUIVALENT_CLASS = `${OWL}equivalentClass`;
const SUB_PROPERTY_OF = `${RDFS}subPropertyOf`;
const EQUIVALENT_PROPERTY = `${OWL}equivalentProperty`;
const SAME_AS = `${OWL}sameAs`;
const INVERSE_OF = `${OWL}inverseOf`;
const DOMAIN = `${RDFS}domain`;
const RANGE = `${RDFS}range`;
const ON_PROPERTY = `${OWL}onProperty`;

/** Every authority IRI (predicates ∪ types), canonical — the construct-agnostic floor set. */
const AUTHORITY_ALL: ReadonlySet<string> = new Set<string>([...AUTHORITY_PREDICATES, ...AUTHORITY_TYPES]);

export interface TripleLike {
  readonly s: string;
  readonly p: string;
  readonly o: string;
  readonly oKind: string;
}

export interface GraphAuthorityScreen {
  /** classes that reach an authority TYPE (subClassOf/equivalentClass/sameAs, or an
   *  owl:Restriction on a tainted predicate). */
  readonly taintedClasses: ReadonlySet<string>;
  /** properties that reach an authority PREDICATE (subPropertyOf/equivalentProperty/
   *  inverseOf/sameAs, or whose rdfs:domain/rdfs:range reaches a tainted class). */
  readonly taintedPredicates: ReadonlySet<string>;
}

/**
 * Coupled least fixed point of authority-bearing classes + predicates. Class and predicate
 * taint are mutually recursive: an owl:Restriction taints a CLASS from a tainted predicate
 * (owl:onProperty), while rdfs:domain/rdfs:range taints a PREDICATE from a tainted class —
 * so both sets are closed together to a fixed point.
 */
export function computeGraphAuthority(triples: readonly TripleLike[]): GraphAuthorityScreen {
  const rel = triples
    .filter(t => t.oKind === 'iri')
    .map(t => ({ s: canonicalizeAuthorityIri(t.s), p: t.p, o: canonicalizeAuthorityIri(t.o) }));
  const classes = new Set<string>(AUTHORITY_TYPES);
  const preds = new Set<string>(AUTHORITY_PREDICATES);
  let changed = true;
  while (changed) {
    changed = false;
    const addC = (x: string) => { if (!classes.has(x)) { classes.add(x); changed = true; } };
    const addP = (x: string) => { if (!preds.has(x)) { preds.add(x); changed = true; } };
    for (const { s, p, o } of rel) {
      switch (p) {
        case SUBCLASS_OF: if (classes.has(o)) addC(s); break;
        case EQUIVALENT_CLASS: if (classes.has(o)) addC(s); if (classes.has(s)) addC(o); break;
        case ON_PROPERTY: if (preds.has(o)) addC(s); break;              // restriction on an authority property
        case SUB_PROPERTY_OF: if (preds.has(o)) addP(s); break;
        case EQUIVALENT_PROPERTY:
        case INVERSE_OF: if (preds.has(o)) addP(s); if (preds.has(s)) addP(o); break;
        case DOMAIN:
        case RANGE: if (classes.has(o)) addP(s); break;                  // using P confers class o on subject/object
        case SAME_AS:
          if (classes.has(o)) addC(s); if (classes.has(s)) addC(o);
          if (preds.has(o)) addP(s); if (preds.has(s)) addP(o);
          break;
        default: break;
      }
    }
  }
  return { taintedClasses: classes, taintedPredicates: preds };
}

export interface AuthorityViolation {
  readonly violated: boolean;
  readonly reasons: readonly string[];
}

/** Does a note carry execution authority — by NAMING an authority IRI directly (the
 *  construct-agnostic floor), by an rdf:type / axiom reaching a tainted class or predicate,
 *  or by USING a tainted predicate (the entailment closure)? */
export function noteAuthorityViolation(noteTriples: readonly TripleLike[], screen: GraphAuthorityScreen): AuthorityViolation {
  const reasons: string[] = [];
  for (const t of noteTriples) {
    const s = canonicalizeAuthorityIri(t.s);
    const p = canonicalizeAuthorityIri(t.p);
    const o = canonicalizeAuthorityIri(t.o);
    // (a) construct-agnostic floor — any direct mention of an authority IRI in any position.
    if (AUTHORITY_ALL.has(s)) reasons.push(`names authority IRI ${s}`);
    if (AUTHORITY_ALL.has(p)) reasons.push(`uses authority predicate ${p}`);
    if (t.oKind === 'iri' && AUTHORITY_ALL.has(o)) reasons.push(`names authority IRI ${o}`);
    // (b) uses a (possibly indirect) tainted term.
    if (t.p === RDF_TYPE && t.oKind === 'iri' && screen.taintedClasses.has(o)) reasons.push(`rdf:type reaches authority class ${o}`);
    if (screen.taintedPredicates.has(p)) reasons.push(`predicate reaches authority predicate ${p}`);
    // (c) defines an axiom LINKING a local term toward the (indirect) authority closure.
    if (t.oKind === 'iri') {
      if ((t.p === SUBCLASS_OF || t.p === EQUIVALENT_CLASS || t.p === DOMAIN || t.p === RANGE || t.p === SAME_AS) && screen.taintedClasses.has(o)) {
        reasons.push(`axiom links toward authority class ${o}`);
      }
      if ((t.p === SUB_PROPERTY_OF || t.p === EQUIVALENT_PROPERTY || t.p === INVERSE_OF || t.p === ON_PROPERTY || t.p === SAME_AS) && screen.taintedPredicates.has(o)) {
        reasons.push(`axiom links toward authority predicate ${o}`);
      }
    }
  }
  return { violated: reasons.length > 0, reasons };
}
