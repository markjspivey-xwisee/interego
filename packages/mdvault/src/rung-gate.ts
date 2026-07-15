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
