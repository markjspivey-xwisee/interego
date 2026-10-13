/**
 * spec-ontology.ts — standards ontologies that EMERGE from the substrate.
 *
 * A spec ontology (xAPI 2.0, SCORM CAM/SN/RTE, cmi5) is authored ONCE as a
 * structured OntologyModel (the single source, derived from the normative
 * spec/XSDs). It is then:
 *
 *   1. COMPOSED into the shared PGSL lattice (composeSpecOntology →
 *      composeIntoSharedLattice): every class/property/vocab IRI becomes a
 *      reusable lattice atom, and the whole model is the holon's content atom.
 *      The ontology is now a first-class Interego holon (iep:ContextDescriptor,
 *      provenance, affordances) — emergent of PGSL, not a hosted file.
 *
 *   2. PROJECTED on dereference: OWL Turtle, SHACL, and JSON-LD are renders of
 *      that same holon's content (readArtifact → render*). RDF is one projection
 *      of many — exactly how a course KG or a performance holon projects.
 *
 *   3. The SINGLE SOURCE for conformance: validateAgainstShape applies the SAME
 *      constraints the SHACL projection publishes, and every result cites the
 *      dereferenceable sh:NodeShape IRI. So when the LRS/LMS validates a
 *      statement/manifest, it is validating against this ontology — not a
 *      detached code rule.
 *
 * Because instances (statements, manifests) are composed into the SAME lattice,
 * their verb/type IRIs reuse the spec atoms — conformance is coherence over the
 * shared graph.
 */
import { composeIntoSharedLattice, readArtifact } from './foundation-shared-lattice.js';
import {
  Graph, iri, en, str, dec, int, bool, typed, RDF, RDFS, OWL, XSD, SH, SKOS, DCT,
  toTurtle, toJsonLd, toNTriples, toRdfXml,
  type Subject, type NamedNode, type Term, type Literal,
} from './ns/rdf.js';
import {
  ALL_PREFIXES, addHeader, declareExternalTerms, foxxiPrefix, alternates, versionIri,
  type DocMeta, type StandardRef,
} from './ns/catalog.js';
import { renderOntologyHtml } from './ns/html.js';
import { mappingSetIri } from './ns/sssom.js';
import { naturalLabel } from './ns/labels.js';
export { naturalLabel };

/** The dereferenceable namespace root the bridge serves (conneg + HATEOAS). Kept
 *  identical to foxxi-vocab's host so every Foxxi ns IRI resolves the same way. */
// LIVE host, compile-time constant. See FOXXI_NS: an ontology iri is a promise that
// it resolves to the ontology. This named the paused Azure host, so /ns/xapi and every
// term under it identified something unfetchable. Never env-derived — dev and prod
// would then mint different iris for the same ontology and split the corpus.
export const NS_ROOT = 'https://foxxi-bridge.interego.xwisee.com/ns/';
/** The retired Azure root. Instances signed while it was live carry types under it, and signed
 *  content cannot be rewritten, so the validator reads a type under this root as the same term
 *  under NS_ROOT (spec/index.ts). That is the only use: nothing is published under it, and no
 *  document asserts owl:sameAs or any other equivalence between the two. */
export const NS_ROOT_LEGACY = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/';

/** The SKOS mapping relations, in the order SKOS lists them. */
const MAPPING_RELATIONS = ['exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch'] as const;

/** SKOS mapping relations a term may carry to another vocabulary's term. Kept as annotations
 *  (never owl:equivalentClass): they record an alignment, not a logical identity. */
export interface OntMappings {
  exactMatch?: readonly string[]; closeMatch?: readonly string[];
  broadMatch?: readonly string[]; narrowMatch?: readonly string[]; relatedMatch?: readonly string[];
  /** Why a mapping is what it is, where a reader would otherwise have to ask (a closeMatch where the
   *  names agree, a target whose publisher labels it oddly) — keyed by the target exactly as the
   *  mapping lists it. Published as an annotation on the mapping axiom itself (an owl:Axiom naming
   *  its source, property and target, with an rdfs:comment: OWL's way to annotate an annotation),
   *  and carried into the SSSOM mapping set as that mapping's comment. */
  mappingNotes?: Readonly<Record<string, string>>;
}
export interface OntClass extends OntMappings {
  name: string; label: string; comment: string;
  subClassOf?: string[]; equivalentClass?: string[]; disjointWith?: string[];
  /** A DEFINED class: equivalent to the union of these (owl:equivalentClass [owl:unionOf (…)]). */
  unionOf?: string[];
  /** Covered by these, which are pairwise disjoint (owl:disjointUnionOf) — e.g. an xAPI Actor is
   *  exactly an Agent or a Group, never both. */
  disjointUnionOf?: string[];
  /** owl:hasKey axioms: each list of properties identifies an instance (an xAPI Inverse
   *  Functional Identifier is a key on Actor). */
  hasKey?: string[][];
  /** Where the standard defines it, e.g. "IEEE 9274.1.1-2023 §5.2.2". */
  source?: string;
  /** The token the standard's serialization uses, when it differs from the label. */
  notation?: string;
  /** No longer part of the model, but kept so data that used it still resolves: published with
   *  owl:deprecated true — and dct:isReplacedBy, when something replaces it. A published term is
   *  deprecated, never deleted. */
  deprecated?: boolean;
  replacedBy?: string;
}
export interface OntProperty extends OntMappings {
  name: string; label: string; comment: string;
  kind: 'object' | 'datatype';
  /** One class, or several (read as their UNION — never as an intersection). */
  domain?: string | readonly string[];
  range?: string | readonly string[];
  functional?: boolean; inverseFunctional?: boolean;
  subPropertyOf?: string[]; inverseOf?: string;
  /** A datatype property whose values are a closed list of tokens: its range is the data
   *  enumeration [ a rdfs:Datatype ; owl:oneOf ( … ) ] (overrides `range`). */
  oneOf?: string[];
  source?: string; notation?: string;
  /** As for a class: kept, marked owl:deprecated, and pointed at its replacement if it has one. */
  deprecated?: boolean;
  replacedBy?: string;
}
export interface OntVocabMember extends OntMappings {
  name: string; label: string; comment?: string;
  /** The literal token the standard uses (skos:notation). Defaults to `name`. */
  notation?: string;
  /** A value the standard has deprecated but still defines (owl:deprecated on the concept). */
  deprecated?: boolean;
}
export interface OntVocab { name: string; label?: string; comment?: string; members: OntVocabMember[] }
/** A datatype defined by restricting a built-in one (OWL 2 DL DatatypeDefinition). */
export interface OntDatatype {
  name: string; label: string; comment: string;
  /** `pattern` is written anchored, ^…$, in the regular-expression subset every reader shares
   *  (see xsdRegex); the OWL facet drops the anchors, which XML Schema does not have. */
  base: string; pattern?: string; minInclusive?: number; maxInclusive?: number; maxLength?: number;
  /** Further base datatypes the same facets restrict: the datatype is then the UNION of each
   *  restricted base. A JSON number becomes xsd:integer or xsd:double in RDF (JSON-LD 1.1 §8.6),
   *  and OWL 2 keeps the double value space apart from the decimal one, so a numeric range that
   *  is to admit real data needs both. */
  alsoBases?: string[];
  source?: string;
}
export interface ShapeConstraint {
  path: string; comment?: string;
  // The JSON key the validator traverses (dotted, array-flattening), when it differs
  // from the RDF `path`. Defaults to `path`. Lets a constraint's published RDF predicate
  // stay decoupled from the JSON shape it checks — e.g. a JSON-LD-keyword path (@context)
  // or a nested path (credentialSubject.id) that has no single dereferenceable predicate.
  jsonPath?: string;
  /** The RDF property path the published SHACL uses, when the JSON key is not the predicate's
   *  local name: one predicate token, or a sequence. Defaults to the predicate(s) `path` names.
   *  `null`: the requirement has no path in the document's RDF graph (a VC's proof lives in a
   *  graph of its own), so only the validator checks it and the node shape's comment says so. */
  rdfPath?: string | readonly string[] | null;
  /** This JSON key carries the node's OWN identifier (`id`): published as `sh:nodeKind sh:IRI`
   *  on the node shape — in RDF the node IS its IRI; there is no `id` property to constrain. */
  identifies?: boolean;
  /** The sh:message a violation reports. Generated from the constraint when absent. */
  message?: string;
  /** e.g. xsd:dateTime. Several = any of them (sh:or) — a JSON number is xsd:integer or xsd:double. */
  datatype?: string | readonly string[];
  class?: string;         // sh:class IRI (curie or #name within this module)
  nodeKind?: 'IRI' | 'Literal' | 'IRIOrLiteral' | 'BlankNodeOrIRI';
  minCount?: number; maxCount?: number;
  pattern?: string;       // regex (string form)
  in?: string[];          // sh:in enumeration (literal values)
  inIris?: string[];      // sh:in enumeration of IRIs (curie or absolute)
  minInclusive?: number; maxInclusive?: number;
  hasValue?: string | number | boolean;  // sh:hasValue — at least one value must equal this
  /** sh:hasValue as an IRI (curie or absolute), when the RDF value is a resource. */
  hasIri?: string;
  /** The list's first values match these patterns, in order (sh:hasValue is order-blind): an
   *  ordered @context, whose first entry VC 2.0 §4.1 fixes and whose next ones a profile fixes. */
  leading?: readonly string[];
  /** Each value is less than (sh:lessThan), or at most (sh:lessThanOrEquals), every value the node
   *  has for this other property (a path name in this model): a Score's min below its max. */
  lessThan?: string;
  lessThanOrEquals?: string;
  /** No value is this (sh:not [ sh:hasValue … ]): a literal, or with notHasIri an IRI. */
  notHasValue?: string | number | boolean;
  notHasIri?: string;
  /** How serious a breach is (sh:severity): a Violation unless the standard makes the requirement a
   *  recommendation — a value beyond a SCORM SPM is allowed, only not portable, so a Warning. */
  severity?: 'Warning' | 'Info';
}
/** One way a node can satisfy a shape's `atLeastOneOf`: a value on a path (or, with `identifies`,
 *  being identified by an IRI), being an instance of a class, or conforming to another named shape. */
export type ShapeAlternative =
  | { path: string; rdfPath?: string; identifies?: boolean }
  | { class: string }
  | { shape: string };
export interface OntShape {
  name: string; label?: string; comment?: string;
  /** The nodes the shape checks (SHACL §2.1.3): instances of a class, the values of a property, the
   *  nodes that have one. A shape with none is checked only where another refers to it (sh:node). */
  targetClass?: string;
  targetObjectsOf?: readonly string[];
  targetSubjectsOf?: readonly string[];
  /** The JSON `type` terms a document's context maps to targetClass, besides its local name — OB
   *  3.0's context maps AchievementCredential to ob:OpenBadgeCredential — so the validator routes a
   *  document as a SHACL processor targets its reading. */
  jsonTypes?: readonly string[];
  /** The JSON keys whose values are the nodes `targetObjectsOf` selects in the RDF reading (the
   *  document's context maps each key to that predicate), so the validator, which reads the JSON,
   *  checks the same nodes. */
  jsonKeys?: readonly string[];
  closed?: boolean; ignoredProperties?: string[];
  constraints: ShapeConstraint[];
  /** Exactly one of these paths must be present (rendered as sh:xone, enforced by the
   *  validator) — e.g. an xAPI Agent's single Inverse Functional Identifier. */
  exactlyOneOf?: { paths: string[]; comment?: string };
  /** At least one of these must hold (rendered as sh:or, enforced by the validator) — e.g. an Open
   *  Badges subject is identified by its id or by at least one identifier. An alternative that
   *  `identifies` holds when the node is identified by an IRI; any other, when its path has a value. */
  atLeastOneOf?: { alternatives: readonly ShapeAlternative[]; comment?: string };
}
/** Another vocabulary's term this document's shapes or axioms constrain, declared here with its
 *  kind, its label and the document that defines it — MIREOT's minimum information, so the document
 *  is OWL 2 DL and a reader sees what the term is without fetching its home. */
export interface OntReference {
  term: string;
  kind: 'class' | 'object' | 'datatype' | 'annotation';
  label: string;
  definedBy: string;
}
export interface OntologyModel {
  module: string;         // 'xapi' | 'scorm-cam' | …  (→ <NS_ROOT><module>)
  title: string; description: string;
  /** Semantic version of this ontology artifact (not of the standard it models). */
  version: string;
  /** The released version this one follows (owl:priorVersion of the ontology and of its shapes
   *  graph, which share its version), once the module has had one. */
  priorVersion?: string;
  /** For a shapes-only model whose vocabulary is another document at its ontology IRI (ieee-ler):
   *  that document's version, which its shapes graph imports. Otherwise the shapes graph imports
   *  this model's own ontology at this model's version. */
  ontologyVersion?: string;
  spec: string;           // official normative spec URL
  derivedFrom?: string;   // e.g. the in-repo XSD path the model transcribes
  prefixes?: Record<string, string>;
  /** Other Foxxi documents this one imports, each as `<module>/<version>` — by version IRI, so the
   *  import closure of a released version never changes — or as an absolute IRI. */
  imports?: string[];
  classes: OntClass[];
  properties: OntProperty[];
  vocabularies?: OntVocab[];
  datatypes?: OntDatatype[];
  /** Groups of pairwise-disjoint classes (owl:AllDisjointClasses). */
  disjoint?: string[][];
  shapes: OntShape[];
  /** Publication dates (ISO). */
  created?: string; modified?: string; issued?: string;
  /** The standards it formalizes; defaults to the one at `spec`. */
  standards?: StandardRef[];
  /** Owners of those standards, for the non-affiliation notice. */
  bodies?: string[];
  /** Replaces the generated notice, for a document that formalizes no standard (see DocMeta). */
  notice?: string;
  notes?: string[];
  seeAlso?: string[];
  /** For an application profile: the specification(s) it profiles (prof:isProfileOf). */
  profileOf?: string[];
  /** External terms the document constrains (see OntReference). */
  references?: OntReference[];
  /** The ontology this document is aligned to term by term: its IRI, and the namespace of its
   *  terms. The SSSOM mapping set then accounts for every term: a term with no mapping into that
   *  ontology is listed as mapped to sssom:NoTermFound there, so a gap reads as a gap, not as an
   *  oversight. */
  counterpart?: { readonly iri: string; readonly namespace: string };
}

// ── IRI helpers ───────────────────────────────────────────────────────────────
export const ontologyIri = (m: OntologyModel): string => `${NS_ROOT}${m.module}`;
export const ns = (m: OntologyModel): string => `${ontologyIri(m)}#`;
export const shapesIri = (m: OntologyModel): string => `${ontologyIri(m)}/shapes`;

/** A Turtle-safe PN_LOCAL for a term's IRI local part. Vocabulary MEMBER names can be raw
 *  spec enum values (e.g. the SCORM `exit,message` / `not attempted` / `-1` timeLimitAction
 *  + cmi values), which contain commas, spaces, or a leading '-' — all illegal in a Turtle
 *  prefixed name, so `${module}:${name}` produced UNPARSEABLE documents. Replace every illegal
 *  run with '-' and repair a leading '-' (PN_LOCAL may not start with one). The real value is
 *  preserved verbatim in the term's skos:notation; only the IRI is sanitized.
 *  Idempotent on already-safe names. */
export function slugLocal(name: string): string {
  let s = String(name).replace(/[^A-Za-z0-9_.-]+/g, '-');
  if (/^[-.]/.test(s)) s = '_' + s;               // PN_LOCAL must not start with '-' or '.'
  return s.replace(/-+$/, '') || 'term';
}
/** A vocabulary member's IRI local part, SCOPED by its scheme so two members with the same enum
 *  value in DIFFERENT schemes (cmi5 moveon category vs moveon extension; two empty-string cmi
 *  values) do not collapse onto one IRI carrying contradictory definitions. */
const memberLocal = (schemeName: string, memberName: string): string => `${slugLocal(schemeName)}-${slugLocal(memberName)}`;

const STD_TOKEN_PREFIXES: Record<string, string> = {
  rdf: RDF, rdfs: RDFS, owl: OWL, xsd: XSD, sh: SH, skos: SKOS, dct: DCT,
  prov: 'http://www.w3.org/ns/prov#',
};

/** Expand a model token to an ABSOLUTE url (the module's own ns, a declared or standard prefix,
 *  or an already-absolute url). A bare name is a term of this module. */
export function expandAbs(m: OntologyModel, token: string): string {
  if (!token) return token;
  if (/^https?:\/\//.test(token) || /^urn:/.test(token)) return token;
  const curie = /^([a-z][\w-]*):(.+)$/i.exec(token);
  if (curie) {
    const base = ({ ...ALL_PREFIXES, ...STD_TOKEN_PREFIXES, ...(m.prefixes ?? {}), [m.module]: ns(m) })[curie[1]!];
    if (base) return base + curie[2];
    throw new Error(`${m.module}: unknown prefix in token ${JSON.stringify(token)}`);
  }
  return `${ns(m)}${token}`;
}

// ── Patterns ───────────────────────────────────────────────────────────────────
/**
 * One pattern, four readers: an OWL 2 pattern facet is an XML Schema regular expression (OWL 2
 * Structural Specification §4.3), sh:pattern is SPARQL REGEX (XPath), and the Foxxi validator and
 * the review tooling run JavaScript and Python. A model writes each pattern once, in the subset all
 * four read the same way — plain groups, explicit character classes, quantifiers, alternation — and
 * anchored ^…$ because SPARQL REGEX matches anywhere. Outside that subset they disagree: `(?:…)`
 * and lookarounds are not XML Schema at all, and `\d`/`\w` are Unicode classes in XML Schema and
 * ASCII ones in JavaScript. Anything outside it is refused here, at build time.
 */
export function portablePattern(pattern: string): string {
  const fail = (why: string): never => { throw new Error(`pattern ${JSON.stringify(pattern)}: ${why}`); };
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const e = pattern[i + 1] ?? '';
      if ('bBdDwW'.includes(e)) fail(`\\${e} does not mean the same in XML Schema and JavaScript; write the character class`);
      i++;
      continue;
    }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(' && pattern[i + 1] === '?') fail('(?…) groups and lookarounds are not XML Schema; use a plain group');
    if ((ch === '^' && i !== 0) || (ch === '$' && i !== pattern.length - 1)) fail('an anchor inside the pattern');
  }
  return pattern;
}
/**
 * The same pattern as an XML Schema regular expression, for an OWL 2 pattern facet. XML Schema
 * anchors every expression at both ends and has no anchor characters: there `^` and `$` are
 * ordinary characters, so a facet written `^[0-9]+$` would admit only strings that begin with a
 * caret and end with a dollar sign — a datatype no real value belongs to.
 */
export function xsdRegex(pattern: string): string {
  portablePattern(pattern);
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) throw new Error(`pattern ${JSON.stringify(pattern)}: a datatype's pattern must match the whole value; write it ^…$`);
  return pattern.slice(1, -1);
}

// ── Labels ─────────────────────────────────────────────────────────────────────
/**
 * The label + notation a term is published with: the words of its label, and — where those differ
 * from the identifier the standard uses for it (its JSON key or element name, `name` here) — that
 * identifier as its skos:notation. The notation was the label as written, so `openid` was published
 * as "OpenID", and a property whose label was already words ("interaction type") had none at all.
 */
function labelOf(raw: string, kind: 'class' | 'property' | 'concept', name: string, notation?: string): { label: string; notation?: string } {
  const label = naturalLabel(raw, kind);
  const n = notation ?? (label !== name ? name : undefined);
  return n !== undefined ? { label, notation: n } : { label };
}

// ── Publication metadata ─────────────────────────────────────────────────────────
const DEFAULT_DATES = { created: '2026-06-19', modified: '2026-10-12', issued: '2026-10-12' };

/** The model file each module is written in — the document's generator provenance. */
const MODEL_FILE: Readonly<Record<string, string>> = {
  xapi: 'xapi', 'scorm-cam': 'scorm-cam', 'scorm-sn': 'scorm-sn', 'scorm-rte': 'scorm-rte', cmi5: 'cmi5',
  'ai-elearning': 'ai-elearning', soc2: 'compliance', 'eu-ai-act': 'compliance', 'nist-rmf': 'compliance',
  ob3: 'ler', clr: 'ler', 'ieee-ler': 'ler',
};
const APP_SRC = 'applications/foxxi-content-intelligence/src/';

/** Whether any term of `m` maps to another vocabulary's term (and so `m` publishes a mapping set). */
export function modelHasMappings(m: OntologyModel): boolean {
  const any = (x: OntMappings): boolean => MAPPING_RELATIONS.some(k => (x[k]?.length ?? 0) > 0);
  return m.classes.some(any) || m.properties.some(any) || (m.vocabularies ?? []).some(v => v.members.some(any));
}

/** The ontology document's self-description. */
export function docMeta(m: OntologyModel): DocMeta {
  return {
    sourceCode: [`${APP_SRC}spec/${MODEL_FILE[m.module] ?? m.module}.model.ts`, `${APP_SRC}spec-ontology.ts`],
    iri: ontologyIri(m), ns: ns(m), prefix: foxxiPrefix(m.module),
    title: m.title, description: m.description, version: m.version, ...(m.priorVersion ? { priorVersion: m.priorVersion } : {}),
    created: m.created ?? DEFAULT_DATES.created, modified: m.modified ?? DEFAULT_DATES.modified, issued: m.issued ?? DEFAULT_DATES.issued,
    standards: m.standards ?? [{ title: m.title, url: m.spec }],
    bodies: m.bodies ?? [], ...(m.notice ? { notice: m.notice } : {}),
    seeAlso: [shapesIri(m), ...(modelHasMappings(m) ? [mappingSetIri(ontologyIri(m))] : []), ...(m.seeAlso ?? [])],
    imports: (m.imports ?? []).map(i => /^https?:\/\//.test(i) ? i : `${NS_ROOT}${i}`),
    notes: [...(m.derivedFrom ? [`Transcribed from the normative schema: ${m.derivedFrom}.`] : []), ...(m.notes ?? [])],
  };
}
/** The shapes graph's self-description. */
export function shapesDocMeta(m: OntologyModel): DocMeta {
  const o = docMeta(m);
  return {
    ...o, iri: shapesIri(m), ns: undefined, prefix: undefined,
    title: `${m.title} — SHACL shapes`,
    description: `SHACL shapes for ${m.title}: the constraints an instance must satisfy, published so any SHACL processor can check what the Foxxi validator checks (POST ${ontologyIri(m)}/validate). Each validation result cites the shape it came from.`,
    // The ontology at the version these shapes were written for: a released shapes graph keeps
    // constraining the vocabulary it was released with after the ontology takes a new version.
    seeAlso: [ontologyIri(m)], imports: [versionIri({ iri: ontologyIri(m), version: m.ontologyVersion ?? m.version })], notes: [], constrains: ontologyIri(m),
  };
}

// ── The ontology as a graph ────────────────────────────────────────────────────
const A = iri(RDF + 'type');
const P = (u: string): NamedNode => iri(u);

/** A class expression for one or several class tokens (several = their union). */
function classRef(g: Graph, m: OntologyModel, tokens: string | readonly string[]): Subject {
  const list = typeof tokens === 'string' ? [tokens] : [...tokens];
  if (list.length === 1) return iri(expandAbs(m, list[0]!));
  const u = g.bnode();
  g.add(u, A, P(OWL + 'Class'));
  g.add(u, P(OWL + 'unionOf'), g.list(list.map(t => iri(expandAbs(m, t)))));
  return u;
}
/** A data range for one or several datatype tokens (several = their union). */
function dataRef(g: Graph, m: OntologyModel, tokens: string | readonly string[]): Subject {
  const list = typeof tokens === 'string' ? [tokens] : [...tokens];
  if (list.length === 1) return iri(expandAbs(m, list[0]!));
  const u = g.bnode();
  g.add(u, A, P(RDFS + 'Datatype'));
  g.add(u, P(OWL + 'unionOf'), g.list(list.map(t => iri(expandAbs(m, t)))));
  return u;
}
function addMappings(g: Graph, m: OntologyModel, s: Subject, x: OntMappings): void {
  for (const k of MAPPING_RELATIONS) {
    for (const t of x[k] ?? []) g.add(s, P(SKOS + k), iri(expandAbs(m, t)));
  }
  for (const [target, note] of Object.entries(x.mappingNotes ?? {})) {
    const k = MAPPING_RELATIONS.find(r => (x[r] ?? []).includes(target));
    // A note on a mapping that is not made would annotate an axiom that does not exist.
    if (!k) throw new Error(`${m.module}: a mapping note names ${target}, which is not a mapping target of ${s.value}`);
    const ax = g.bnode();
    g.add(ax, A, P(OWL + 'Axiom'))
      .add(ax, P(OWL + 'annotatedSource'), s)
      .add(ax, P(OWL + 'annotatedProperty'), P(SKOS + k))
      .add(ax, P(OWL + 'annotatedTarget'), iri(expandAbs(m, target)))
      .add(ax, P(RDFS + 'comment'), en(note));
  }
}
function numLit(n: number): Literal { return Number.isInteger(n) ? int(n) : dec(n); }
/**
 * A double in the canonical lexical form of XML Schema 1.1 (one digit, a point, at least one digit,
 * `E`, the exponent: 1 is "1.0E0"). An RDF literal is its lexical form, so "1E0" and "1.0E0" are two
 * terms with one value; a JSON-LD processor writes the canonical one (JSON-LD 1.1 §8.6), and the
 * Turtle and JSON-LD of a document must be the same graph, so the documents write it too.
 */
export function canonicalDouble(n: number): string {
  return n.toExponential(15).replace(/(\d)0*e\+?/, '$1E');
}

/** The complete OWL 2 DL ontology for `m`: header, datatypes, classes, properties, code lists,
 *  and MIREOT declarations of every external term it uses. */
export function ontologyGraph(m: OntologyModel): Graph {
  const g = new Graph();
  const O = addHeader(g, docMeta(m));
  if (m.profileOf?.length) {
    g.add(O, A, P('http://www.w3.org/ns/dx/prof/Profile'));
    for (const x of m.profileOf) g.add(O, P('http://www.w3.org/ns/dx/prof/isProfileOf'), iri(x));
  }
  const def = (s: Subject): void => { g.add(s, P(RDFS + 'isDefinedBy'), O); };
  for (const d of m.datatypes ?? []) {
    const D = iri(ns(m) + d.name);
    g.add(D, A, P(RDFS + 'Datatype'));
    g.add(D, P(RDFS + 'label'), en(naturalLabel(d.label, 'class'))).add(D, P(RDFS + 'comment'), en(d.comment));
    if (d.source) g.add(D, P(DCT + 'source'), str(d.source));
    // One restriction per base; several bases are united. Facet values are literals of the
    // base's own value space (OWL 2 §4.7): a double's bound is a double, not a decimal.
    const restricted = (base: string): Subject => {
      const b = expandAbs(m, base);
      const hasFacets = d.pattern !== undefined || d.minInclusive !== undefined || d.maxInclusive !== undefined || d.maxLength !== undefined;
      if (!hasFacets) return iri(b);
      const r = g.bnode();
      g.add(r, A, P(RDFS + 'Datatype')).add(r, P(OWL + 'onDatatype'), iri(b));
      const facets: Subject[] = [];
      const facet = (f: string, v: Literal): void => { const x = g.bnode(); g.add(x, P(XSD + f), v); facets.push(x); };
      const bound = (n: number): Literal => b === XSD + 'double' || b === XSD + 'float' ? typed(canonicalDouble(n), b) : numLit(n);
      if (d.pattern !== undefined) facet('pattern', str(xsdRegex(d.pattern)));
      if (d.minInclusive !== undefined) facet('minInclusive', bound(d.minInclusive));
      if (d.maxInclusive !== undefined) facet('maxInclusive', bound(d.maxInclusive));
      if (d.maxLength !== undefined) facet('maxLength', int(d.maxLength));
      g.add(r, P(OWL + 'withRestrictions'), g.list(facets));
      return r;
    };
    const bases = [d.base, ...(d.alsoBases ?? [])];
    if (bases.length === 1) g.add(D, P(OWL + 'equivalentClass'), restricted(d.base));
    else {
      const u = g.bnode();
      g.add(u, A, P(RDFS + 'Datatype')).add(u, P(OWL + 'unionOf'), g.list(bases.map(restricted)));
      g.add(D, P(OWL + 'equivalentClass'), u);
    }
    def(D);
  }
  /**
   * owl:deprecated + dct:isReplacedBy, and an rdfs:label that begins "obsolete " — the OBO Foundry
   * convention ROBOT's report checks (missing_obsolete_label), in place of the "(deprecated)" these
   * labels ended with. It also keeps rdfs:label unique (ROBOT's duplicate_label): a deprecated term's
   * replacement often has its name. A concept's skos:prefLabel stays its name in its list.
   */
  const obsolete = (label: string, x: { deprecated?: boolean }): string => x.deprecated ? `obsolete ${label}` : label;
  const deprecate = (s: Subject, x: { deprecated?: boolean; replacedBy?: string }): void => {
    if (!x.deprecated) return;
    g.add(s, P(OWL + 'deprecated'), bool(true));
    if (x.replacedBy) g.add(s, P(DCT + 'isReplacedBy'), iri(expandAbs(m, x.replacedBy)));
  };
  for (const c of m.classes) {
    const C = iri(ns(m) + c.name);
    // A class's IRI name is this ontology's own; the identifier a standard uses for it (an xAPI
    // objectType, an XML element) is what its label is written as, where that is not words.
    const l = labelOf(c.label, 'class', c.label, c.notation);
    g.add(C, A, P(OWL + 'Class')).add(C, P(RDFS + 'label'), en(obsolete(l.label, c)));
    if (l.notation) g.add(C, P(SKOS + 'notation'), str(l.notation));
    g.add(C, P(RDFS + 'comment'), en(c.comment));
    deprecate(C, c);
    for (const sup of c.subClassOf ?? []) g.add(C, P(RDFS + 'subClassOf'), iri(expandAbs(m, sup)));
    for (const eq of c.equivalentClass ?? []) g.add(C, P(OWL + 'equivalentClass'), iri(expandAbs(m, eq)));
    if (c.unionOf?.length) g.add(C, P(OWL + 'equivalentClass'), classRef(g, m, c.unionOf));
    if (c.disjointUnionOf?.length) g.add(C, P(OWL + 'disjointUnionOf'), g.list(c.disjointUnionOf.map(t => iri(expandAbs(m, t)))));
    for (const key of c.hasKey ?? []) g.add(C, P(OWL + 'hasKey'), g.list(key.map(t => iri(expandAbs(m, t)))));
    for (const dj of c.disjointWith ?? []) g.add(C, P(OWL + 'disjointWith'), iri(expandAbs(m, dj)));
    if (c.source) g.add(C, P(DCT + 'source'), str(c.source));
    addMappings(g, m, C, c);
    def(C);
  }
  for (const p of m.properties) {
    const S = iri(ns(m) + p.name);
    g.add(S, A, P(OWL + (p.kind === 'object' ? 'ObjectProperty' : 'DatatypeProperty')));
    if (p.functional) g.add(S, A, P(OWL + 'FunctionalProperty'));
    // OWL 2 DL: inverse-functionality is defined for object properties only.
    if (p.inverseFunctional && p.kind === 'object') g.add(S, A, P(OWL + 'InverseFunctionalProperty'));
    const l = labelOf(p.label, 'property', p.name, p.notation);
    g.add(S, P(RDFS + 'label'), en(obsolete(l.label, p)));
    if (l.notation) g.add(S, P(SKOS + 'notation'), str(l.notation));
    g.add(S, P(RDFS + 'comment'), en(p.comment));
    deprecate(S, p);
    if (p.domain) g.add(S, P(RDFS + 'domain'), classRef(g, m, p.domain));
    if (p.oneOf?.length) {
      if (p.kind === 'object') throw new Error(`${m.module}:${p.name}: oneOf is a data enumeration; an object property cannot have one`);
      const e = g.bnode();
      g.add(e, A, P(RDFS + 'Datatype')).add(e, P(OWL + 'oneOf'), g.list(p.oneOf.map(v => str(v))));
      g.add(S, P(RDFS + 'range'), e);
    } else if (p.range) g.add(S, P(RDFS + 'range'), p.kind === 'object' ? classRef(g, m, p.range) : dataRef(g, m, p.range));
    for (const sp of p.subPropertyOf ?? []) g.add(S, P(RDFS + 'subPropertyOf'), iri(expandAbs(m, sp)));
    if (p.inverseOf) g.add(S, P(OWL + 'inverseOf'), iri(expandAbs(m, p.inverseOf)));
    if (p.source) g.add(S, P(DCT + 'source'), str(p.source));
    addMappings(g, m, S, p);
    def(S);
  }
  for (const v of m.vocabularies ?? []) {
    const V = iri(ns(m) + slugLocal(v.name));
    const vl = v.label ?? v.name;
    g.add(V, A, P(SKOS + 'ConceptScheme')).add(V, P(RDFS + 'label'), en(vl)).add(V, P(SKOS + 'prefLabel'), en(vl));
    if (v.comment) g.add(V, P(RDFS + 'comment'), en(v.comment));
    def(V);
    for (const mem of v.members) {
      const M = iri(ns(m) + memberLocal(v.name, mem.name));
      g.add(V, P(SKOS + 'hasTopConcept'), M);
      // Two labels, for two readers. skos:prefLabel is the word the list uses ("satisfied"), unique
      // within its scheme as SKOS asks. rdfs:label names the value unambiguously in the whole
      // document ("satisfied (Rollup actions)"), because the standards' code lists share words —
      // "satisfied" is a SCORM rule condition, a rollup condition and a rollup action — and OWL
      // tooling reads rdfs:label as an entity's one name (ROBOT's duplicate_label, missing_label).
      const word = naturalLabel(mem.label, 'concept');
      g.add(M, A, P(SKOS + 'Concept'))
        .add(M, P(SKOS + 'inScheme'), V).add(M, P(SKOS + 'topConceptOf'), V)
        .add(M, P(SKOS + 'prefLabel'), en(word)).add(M, P(RDFS + 'label'), en(obsolete(`${word} (${vl})`, mem)))
        .add(M, P(SKOS + 'notation'), str(mem.notation ?? mem.name));
      if (mem.comment) g.add(M, P(SKOS + 'definition'), en(mem.comment));
      deprecate(M, mem);
      addMappings(g, m, M, mem);
      def(M);
    }
  }
  for (const group of m.disjoint ?? []) {
    const d = g.bnode();
    g.add(d, A, P(OWL + 'AllDisjointClasses')).add(d, P(OWL + 'members'), g.list(group.map(t => iri(expandAbs(m, t)))));
  }
  const REF_KIND = { class: OWL + 'Class', object: OWL + 'ObjectProperty', datatype: OWL + 'DatatypeProperty', annotation: OWL + 'AnnotationProperty' } as const;
  for (const r of m.references ?? []) {
    const R = iri(expandAbs(m, r.term));
    g.add(R, A, P(REF_KIND[r.kind])).add(R, P(RDFS + 'label'), en(r.label)).add(R, P(RDFS + 'isDefinedBy'), iri(r.definedBy));
  }
  declareExternalTerms(g, [ns(m)]);
  return g;
}

// ── The shapes as a graph ─────────────────────────────────────────────────────
/** The predicate tokens of a constraint's RDF path, or null when it has none (a JSON-LD
 *  keyword such as @context is consumed before any RDF graph exists). A trailing `.id` is
 *  dropped: "the node reached here is IRI-identified" is a nodeKind on the parent path. A `type`
 *  segment is a plain module predicate, NOT rdf:type, unless the model maps it to rdf:type
 *  explicitly with `rdfPath` — the JSON validator checks `type` by string membership. */
function rdfPathTokens(c: ShapeConstraint): string[] | null {
  if (c.rdfPath === null) return null;
  if (c.rdfPath !== undefined) return typeof c.rdfPath === 'string' ? [c.rdfPath] : [...c.rdfPath];
  if (c.path.startsWith('@')) return null;
  const segs = c.path.split('.');
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const isLeaf = i === segs.length - 1;
    if (seg === 'id') {
      if (isLeaf && segs.length > 1) continue;
      if (isLeaf) { out.push(seg); continue; }
      return null;
    }
    if (seg.startsWith('@')) return null;
    out.push(seg);
  }
  return out.length ? out : null;
}

/**
 * The IRI of each property shape a node shape publishes. Named, not blank: a validation report's
 * sh:sourceShape then says which constraint a result is about — the same IRI the Foxxi validator
 * cites for it — and a consumer can cite one, reuse it, or turn it off with sh:deactivated.
 * `<NodeShape>-<path>`, numbered from the second when a path repeats in one shape.
 */
export function propertyShapeIris(m: OntologyModel, s: OntShape): Map<ShapeConstraint, string> {
  const out = new Map<ShapeConstraint, string>();
  const seen = new Map<string, number>();
  for (const c of s.constraints) {
    if (c.identifies || rdfPathTokens(c) === null) continue;
    const base = `${s.name}-${c.path.replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-+|-+$/g, '')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(c, `${shapesIri(m)}#${n === 1 ? base : `${base}-${n}`}`);
  }
  return out;
}

const xsdName = (t: string): string => t.replace(/^xsd:/, '');
/** A readable sentence for what a constraint requires — the default sh:message. */
function describe(c: ShapeConstraint, tokens: readonly string[]): string {
  const name = c.path;
  const parts: string[] = [];
  if (c.minCount != null && c.maxCount != null && c.minCount === c.maxCount) parts.push(`exactly ${c.minCount} value${c.minCount === 1 ? '' : 's'}`);
  else {
    if (c.minCount != null && c.minCount > 0) parts.push(`at least ${c.minCount} value${c.minCount === 1 ? '' : 's'}`);
    if (c.maxCount != null) parts.push(`at most ${c.maxCount} value${c.maxCount === 1 ? '' : 's'}`);
  }
  if (c.datatype) parts.push(`of type ${typeof c.datatype === 'string' ? c.datatype : c.datatype.join(' or ')}`);
  if (c.nodeKind === 'IRI') parts.push('an IRI');
  if (c.class) parts.push(`an instance of ${c.class}`);
  // The RDF form the shape publishes: the IRIs when the model names them, else the literal tokens.
  if (c.inIris) parts.push(`one of ${c.inIris.join(', ')}`);
  else if (c.in) parts.push(`one of ${c.in.map(x => JSON.stringify(x)).join(', ')}`);
  if (c.minInclusive != null && c.maxInclusive != null) parts.push(`between ${c.minInclusive} and ${c.maxInclusive}`);
  else if (c.minInclusive != null) parts.push(`at least ${c.minInclusive}`);
  else if (c.maxInclusive != null) parts.push(`at most ${c.maxInclusive}`);
  if (c.pattern) parts.push(`matching ${c.pattern}`);
  if (c.hasIri) parts.push(`including ${c.hasIri}`);
  else if (c.hasValue !== undefined) parts.push(`including ${JSON.stringify(c.hasValue)}`);
  if (c.notHasIri) parts.push(`never ${c.notHasIri}`);
  else if (c.notHasValue !== undefined) parts.push(`never ${JSON.stringify(c.notHasValue)}`);
  if (c.lessThan) parts.push(`less than its ${c.lessThan}`);
  if (c.lessThanOrEquals) parts.push(`at most its ${c.lessThanOrEquals}`);
  void tokens;
  return `${name}: ${parts.length ? parts.join(', ') : 'see the constraint'}${c.comment ? ` — ${c.comment}` : ''}`;
}

/** The SHACL shapes graph for `m`. */
export function shapesGraph(m: OntologyModel): Graph {
  const g = new Graph();
  const SG = addHeader(g, shapesDocMeta(m), 'SHACL shapes graph');
  const shapeNs = `${shapesIri(m)}#`;
  for (const s of m.shapes) {
    const N = iri(shapeNs + s.name);
    g.add(N, A, P(SH + 'NodeShape'));
    if (s.targetClass) g.add(N, P(SH + 'targetClass'), iri(expandAbs(m, s.targetClass)));
    for (const p of s.targetObjectsOf ?? []) g.add(N, P(SH + 'targetObjectsOf'), iri(expandAbs(m, p)));
    for (const p of s.targetSubjectsOf ?? []) g.add(N, P(SH + 'targetSubjectsOf'), iri(expandAbs(m, p)));
    if (s.label) g.add(N, P(RDFS + 'label'), en(s.label));
    if (s.comment) g.add(N, P(RDFS + 'comment'), en(s.comment));
    if (s.constraints.some(c => c.identifies)) {
      g.add(N, P(SH + 'nodeKind'), P(SH + 'IRI'));
      const idc = s.constraints.find(c => c.identifies)!;
      // A pattern on the identifier constrains the node's own IRI (SHACL §4.4.1 applies sh:pattern
      // to the focus node when the shape is a node shape).
      if (idc.pattern) g.add(N, P(SH + 'pattern'), str(portablePattern(idc.pattern)));
      g.add(N, P(SH + 'message'), en(`${s.label ?? s.name}: the node must be identified by an IRI${idc.pattern ? ` matching ${idc.pattern}` : ''}${idc.comment ? ` — ${idc.comment}` : ''}`));
    }
    if (s.closed) g.add(N, P(SH + 'closed'), bool(true));
    if (s.ignoredProperties?.length) g.add(N, P(SH + 'ignoredProperties'), g.list(s.ignoredProperties.map(x => iri(expandAbs(m, x)))));
    const jsonOnly: string[] = [];
    const named = propertyShapeIris(m, s);
    for (const c of s.constraints) {
      if (c.identifies) continue;
      const tokens = rdfPathTokens(c);
      if (tokens === null) {
        const bits: string[] = [];
        if (c.datatype) bits.push(`datatype ${typeof c.datatype === 'string' ? c.datatype : c.datatype.join(' | ')}`);
        if (c.nodeKind) bits.push(`nodeKind ${c.nodeKind}`);
        if (c.minCount != null) bits.push(`minCount ${c.minCount}`);
        if (c.maxCount != null) bits.push(`maxCount ${c.maxCount}`);
        if (c.pattern) bits.push(`pattern ${c.pattern}`);
        if (c.in) bits.push(`in {${c.in.join(', ')}}`);
        if (c.minInclusive != null) bits.push(`minInclusive ${c.minInclusive}`);
        if (c.maxInclusive != null) bits.push(`maxInclusive ${c.maxInclusive}`);
        if (c.hasValue !== undefined) bits.push(`hasValue ${JSON.stringify(c.hasValue)}`);
        if (c.leading) bits.push(`beginning ${c.leading.map(x => JSON.stringify(x)).join(', ')}`);
        jsonOnly.push(`${c.path}${bits.length ? ` (${bits.join(', ')})` : ''}${c.comment ? ` — ${c.comment}` : ''}`);
        continue;
      }
      const ps = iri(named.get(c)!);
      g.add(N, P(SH + 'property'), ps);
      g.add(ps, A, P(SH + 'PropertyShape'));
      const preds = tokens.map(t => iri(expandAbs(m, t)));
      g.add(ps, P(SH + 'path'), preds.length === 1 ? preds[0]! : g.list(preds));
      g.add(ps, P(SH + 'name'), str(c.path));
      if (c.comment) g.add(ps, P(SH + 'description'), en(c.comment));
      g.add(ps, P(SH + 'message'), en(c.message ?? `${s.label ?? s.name} — ${describe(c, tokens)}`));
      if (c.severity) g.add(ps, P(SH + 'severity'), P(SH + c.severity));
      if (c.datatype) {
        const dts = typeof c.datatype === 'string' ? [c.datatype] : [...c.datatype];
        if (dts.length === 1) g.add(ps, P(SH + 'datatype'), iri(expandAbs(m, dts[0]!)));
        else g.add(ps, P(SH + 'or'), g.list(dts.map(dt => { const b = g.bnode(); g.add(b, P(SH + 'datatype'), iri(expandAbs(m, dt))); return b; })));
      }
      if (c.class) g.add(ps, P(SH + 'class'), iri(expandAbs(m, c.class)));
      if (c.nodeKind) g.add(ps, P(SH + 'nodeKind'), P(SH + c.nodeKind));
      if (c.minCount != null) g.add(ps, P(SH + 'minCount'), int(c.minCount));
      if (c.maxCount != null) g.add(ps, P(SH + 'maxCount'), int(c.maxCount));
      if (c.pattern) g.add(ps, P(SH + 'pattern'), str(portablePattern(c.pattern)));
      // The RDF form of an enumeration: IRIs when the model names them, else the literal tokens.
      if (c.inIris) g.add(ps, P(SH + 'in'), g.list(c.inIris.map(x => iri(expandAbs(m, x)))));
      else if (c.in) g.add(ps, P(SH + 'in'), g.list(c.in.map(x => str(x))));
      if (c.minInclusive != null) g.add(ps, P(SH + 'minInclusive'), numLit(c.minInclusive));
      if (c.maxInclusive != null) g.add(ps, P(SH + 'maxInclusive'), numLit(c.maxInclusive));
      if (c.hasIri) g.add(ps, P(SH + 'hasValue'), iri(expandAbs(m, c.hasIri)));
      else if (c.hasValue !== undefined) g.add(ps, P(SH + 'hasValue'), typeof c.hasValue === 'string' ? str(c.hasValue) : typeof c.hasValue === 'boolean' ? bool(c.hasValue) : numLit(c.hasValue));
      if (c.lessThan) g.add(ps, P(SH + 'lessThan'), iri(expandAbs(m, c.lessThan)));
      if (c.lessThanOrEquals) g.add(ps, P(SH + 'lessThanOrEquals'), iri(expandAbs(m, c.lessThanOrEquals)));
      if (c.notHasIri !== undefined || c.notHasValue !== undefined) {
        const not = g.bnode();
        const v = c.notHasValue;
        g.add(not, P(SH + 'hasValue'), c.notHasIri !== undefined ? iri(expandAbs(m, c.notHasIri)) : typeof v === 'string' ? str(v) : typeof v === 'boolean' ? bool(v) : numLit(v as number));
        g.add(ps, P(SH + 'not'), not);
      }
    }
    if (jsonOnly.length) g.add(N, P(RDFS + 'comment'), en('Requirements on the JSON document that have no property path in this RDF graph, checked by the Foxxi validator (JSON-LD-keyword requirements such as @context are consumed before the graph exists; a Verifiable Credential\'s proof is a graph of its own): ' + jsonOnly.join('; ')));
    if (s.exactlyOneOf) {
      const branches = s.exactlyOneOf.paths.map(p => {
        const b = g.bnode();
        g.add(b, P(SH + 'path'), iri(expandAbs(m, p))).add(b, P(SH + 'minCount'), int(1));
        return b;
      });
      g.add(N, P(SH + 'xone'), g.list(branches));
      if (s.exactlyOneOf.comment) g.add(N, P(SH + 'message'), en(`${s.label ?? s.name}: ${s.exactlyOneOf.comment}`));
    }
    if (s.atLeastOneOf) {
      const branches = s.atLeastOneOf.alternatives.map(a => {
        const b = g.bnode();
        if ('class' in a) g.add(b, P(SH + 'class'), iri(expandAbs(m, a.class)));
        else if ('shape' in a) g.add(b, P(SH + 'node'), iri(`${shapeNs}${a.shape}`));
        else if (a.identifies) g.add(b, P(SH + 'nodeKind'), P(SH + 'IRI'));
        else g.add(b, P(SH + 'path'), iri(expandAbs(m, a.rdfPath ?? a.path))).add(b, P(SH + 'minCount'), int(1));
        return b;
      });
      g.add(N, P(SH + 'or'), g.list(branches));
      if (s.atLeastOneOf.comment) g.add(N, P(SH + 'message'), en(`${s.label ?? s.name}: ${s.atLeastOneOf.comment}`));
    }
    g.add(N, P(RDFS + 'isDefinedBy'), SG);
  }
  return g;
}

// ── Serializations ─────────────────────────────────────────────────────────────
/** The prefixes a module's documents print: every Foxxi + standard + external prefix, plus
 *  `shapes:` for its own shapes namespace. */
export function documentPrefixes(m: OntologyModel): Record<string, string> {
  return { ...ALL_PREFIXES, shapes: `${shapesIri(m)}#` };
}
const turtleHeader = (meta: DocMeta, forms = 'Turtle, RDF/XML, N-Triples, JSON-LD and HTML'): string[] => [
  `${meta.title} — version ${meta.version}`,
  `${meta.iri}  (this version: ${meta.iri}/${meta.version})`,
  `Generated from the Foxxi single-source model; served with content negotiation as ${forms}.`,
];

/**
 * The ontology as TRIPLES — the same graph every serialization prints, but as data for the
 * lattice: three ABSOLUTE identifiers, or a literal's lexical form in object position.
 *
 * Composed HOLONICALLY by the caller: each triple is a holon of its three atoms, and the
 * ontology is a holon of its triples (see composeSpecOntology). Blank nodes (union domains,
 * datatype restrictions) carry graph-local labels and are composed as the atoms they are.
 */
export type Triple = readonly [string, string, string];
export function ontologyTriples(m: OntologyModel): Triple[] {
  // Blank nodes are skolemized (RDF 1.1 §3.5) under the ontology's own IRI: a graph-local `_:b0`
  // would otherwise become ONE shared lattice atom across every ontology that has a `_:b0`.
  const genid = `${ontologyIri(m)}/.well-known/genid/`;
  const term = (t: Term): string => t.termType === 'BlankNode' ? genid + t.value : t.value;
  return ontologyGraph(m).triples.map(t => [term(t.s), t.p.value, term(t.o)] as const);
}

// ── OWL projection ──────────────────────────────────────────────────────────
export function renderOwl(m: OntologyModel): string {
  return toTurtle(ontologyGraph(m), documentPrefixes(m), { header: turtleHeader(docMeta(m)) });
}
export function renderOwlNTriples(m: OntologyModel): string { return toNTriples(ontologyGraph(m)); }
export function renderOwlRdfXml(m: OntologyModel): string { return toRdfXml(ontologyGraph(m), documentPrefixes(m)); }

// ── SHACL projection ──────────────────────────────────────────────────────────
export function renderShacl(m: OntologyModel): string {
  // A shapes graph has no HTML page of its own: its shapes are documented on the ontology's.
  return toTurtle(shapesGraph(m), documentPrefixes(m), { header: turtleHeader(shapesDocMeta(m), 'Turtle, RDF/XML, N-Triples and JSON-LD') });
}
export function renderShaclNTriples(m: OntologyModel): string { return toNTriples(shapesGraph(m)); }
export function renderShaclRdfXml(m: OntologyModel): string { return toRdfXml(shapesGraph(m), documentPrefixes(m)); }
export function renderShaclJsonLd(m: OntologyModel): Record<string, unknown> {
  return toJsonLd(shapesGraph(m), documentPrefixes(m), { first: [shapesIri(m)] });
}

// ── JSON-LD projection (HATEOAS) ───────────────────────────────────────────────
export function renderJsonLd(m: OntologyModel): Record<string, unknown> {
  // A FLAT @graph of every node of the SAME graph the Turtle prints — so a content-negotiated
  // application/ld+json expands to exactly the Turtle's triples.
  // ★ NO `_links`. The document carried HAL links beside its @graph, which JSON-LD processing drops —
  // so a processor in safe mode, the bar this vertical sets for its own records, refused every
  // ontology. The same links are the response's Link header (alternates, latest-version,
  // describedby) and the header triples (owl:versionIRI, rdfs:seeAlso the shapes).
  return toJsonLd(ontologyGraph(m), documentPrefixes(m), { first: [ontologyIri(m)] });
}

// ── Model-driven validation (the SAME constraints the SHACL publishes) ──────────
export interface ValidationResult {
  conforms: boolean;
  /** A result of any severity means the instance does not conform, as in SHACL (§3.6.1): a Warning
   *  reports what the standard only recommends, and a caller decides what to do with it. */
  results: Array<{ path: string; message: string; value?: unknown; sourceShape: string; severity: 'Violation' | 'Warning' | 'Info' }>;
  shapesIri: string;
}
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
const XSD_NUM = new Set(['xsd:decimal', 'xsd:double', 'xsd:float', 'xsd:integer', 'xsd:nonNegativeInteger', 'xsd:positiveInteger', 'xsd:int']);
const XSD_STR = new Set(['xsd:string', 'xsd:anyURI', 'xsd:language', 'xsd:token', 'xsd:normalizedString']);
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const DURATION_RE = /^P(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/;

/** Why a raw JSON value does not fit a datatype token, or null when it does. Tokens this
 *  validator has no JSON reading for impose nothing here (the RDF shape still states them). */
function jsonDatatypeFailure(token: string, item: unknown): string | null {
  // XML Schema's namespace is http://www.w3.org/2001/XMLSchema#; some published contexts (1EdTech's
  // OB 3.0) write its datatypes with https, and a value typed so is still read as that datatype here.
  const dt = token.replace(/^https?:\/\/www\.w3\.org\/2001\/XMLSchema#/, 'xsd:');
  if (XSD_STR.has(dt)) return typeof item === 'string' ? null : `expected a string (${dt})`;
  if (dt === 'xsd:boolean') return typeof item === 'boolean' ? null : 'expected a boolean';
  if (XSD_NUM.has(dt)) return typeof item === 'number' ? null : `expected a number (${dt})`;
  if (dt === 'xsd:dateTime') return typeof item === 'string' && DATETIME_RE.test(item) ? null : 'expected an RFC 3339 dateTime';
  if (dt === 'xsd:duration') return typeof item === 'string' && DURATION_RE.test(item) ? null : 'expected an ISO 8601 duration';
  if (dt === 'rdf:langString') return typeof item === 'string' || (typeof item === 'object' && item !== null) ? null : 'expected a language-tagged string or language map';
  return null;
}

function pick(instance: Record<string, unknown>, path: string): unknown {
  // A path is a dotted property chain; the FIRST segment may carry a module curie
  // prefix (xapi:actor → actor). Descend the chain, flattening across arrays so a
  // nested path (credentialSubject.id) or a path through a list resolves — not just
  // a single flat key. General to every model; no per-format branch.
  const segs = path.split('.');
  segs[0] = segs[0]!.includes(':') ? segs[0]!.split(':')[1]! : segs[0]!;
  let cur: unknown = instance;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const next: unknown[] = [];
      for (const el of cur) {
        if (el && typeof el === 'object') { const v = (el as Record<string, unknown>)[seg]; if (v !== undefined) next.push(v); }
      }
      cur = next;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Validate a JS instance against ONE shape's constraints (citing the shape IRI). */
export function validateAgainstShape(m: OntologyModel, shapeName: string, instance: Record<string, unknown>): ValidationResult {
  const shape = m.shapes.find(s => s.name === shapeName);
  const nodeShape = `${shapesIri(m)}#${shapeName}`;
  const results: ValidationResult['results'] = [];
  if (!shape) return { conforms: true, results, shapesIri: shapesIri(m) };
  const named = propertyShapeIris(m, shape);
  for (const c of shape.constraints) {
    // A result cites the property shape its constraint is published as; a requirement on the node
    // itself (its identifier) or on the JSON document alone cites the node shape.
    const sourceShape = named.get(c) ?? nodeShape;
    const severity = c.severity ?? 'Violation';
    const v = pick(instance, c.jsonPath ?? c.path);
    const present = v !== undefined && v !== null;
    const arr = Array.isArray(v) ? v : present ? [v] : [];
    if (c.minCount != null && arr.length < c.minCount) results.push({ path: c.path, message: `expected at least ${c.minCount} value(s)`, sourceShape, severity });
    if (c.maxCount != null && arr.length > c.maxCount) results.push({ path: c.path, message: `expected at most ${c.maxCount} value(s)`, value: v, sourceShape, severity });
    if (c.hasValue !== undefined && !arr.some(item => item === c.hasValue)) results.push({ path: c.path, message: `must include the value ${String(c.hasValue)}`, sourceShape, severity });
    // An ordered list's first values (sh:hasValue is order-blind) — VC 2.0 §4.1 requires the
    // credentials-v2 @context to be the first entry, not merely present, and a profile fixes the next.
    c.leading?.forEach((want, i) => {
      const got = arr[i];
      if (typeof got !== 'string' || !new RegExp(want).test(got)) results.push({ path: c.path, message: `value ${i + 1} must match ${want}`, value: got, sourceShape, severity });
    });
    const others = (path: string): unknown[] => { const o = pick(instance, path); return Array.isArray(o) ? o : o === undefined || o === null ? [] : [o]; };
    for (const item of arr) {
      const viol = (message: string): void => { results.push({ path: c.path, message, value: item, sourceShape, severity }); };
      if (c.notHasValue !== undefined && item === c.notHasValue) viol(`must not be ${String(c.notHasValue)}`);
      if (c.lessThan && typeof item === 'number' && others(c.lessThan).some(o => typeof o === 'number' && !(item < o))) viol(`must be less than ${c.lessThan}`);
      if (c.lessThanOrEquals && typeof item === 'number' && others(c.lessThanOrEquals).some(o => typeof o === 'number' && !(item <= o))) viol(`must be at most ${c.lessThanOrEquals}`);
      // Several datatypes are alternatives (sh:or): the value passes if it fits any of them.
      if (c.datatype) {
        const dts = typeof c.datatype === 'string' ? [c.datatype] : [...c.datatype];
        const fails = dts.map(dt => jsonDatatypeFailure(dt, item));
        if (fails.every(f => f !== null)) viol(fails.length === 1 ? fails[0]! : `expected one of ${dts.join(', ')}`);
      }
      // A node object identified by an IRI (`id` / `@id`) is that IRI in the document's RDF reading.
      const idOf = (x: unknown): unknown => x && typeof x === 'object' ? (x as Record<string, unknown>)['@id'] ?? (x as Record<string, unknown>).id : x;
      if (c.nodeKind === 'IRI' && !(typeof idOf(item) === 'string' && IRI_RE.test(idOf(item) as string))) viol('expected an IRI, or a node identified by one');
      if (c.nodeKind === 'Literal' && (item === null || typeof item === 'object')) viol('expected a literal, not an IRI/blank node');
      // sh:class — the published shapes assert it, so the engine must enforce it or the
      // dereferenceable shape and this validator disagree (a bare literal `course` passed).
      // On raw (un-expanded) JSON we can soundly check only NODE-NESS: a class instance is a
      // node (an object, or an IRI reference), never a plain literal. We deliberately do NOT
      // compare a local @type name against the class name — that would be both case-sensitive
      // and authority-blind (over-rejecting a course typed with the canonical xAPI activity
      // IRI whose last segment is lowercase `course`, and false-accepting a foreign-namespace
      // type sharing the local name). Node-ness is the safe, sound subset that closes the bug.
      if (c.class) {
        const isNode = (typeof item === 'object' && item !== null) || (typeof item === 'string' && IRI_RE.test(item));
        if (!isNode) viol(`expected a node (an object or IRI reference) that is an instance of ${c.class}, not a bare literal`);
      }
      if (c.pattern && typeof item === 'string' && !new RegExp(c.pattern).test(item)) viol(`does not match pattern ${c.pattern}`);
      if (c.in && !c.in.includes(String(item))) viol(`not in the allowed vocabulary {${c.in.join(', ')}}`);
      if (c.minInclusive != null && typeof item === 'number' && item < c.minInclusive) viol(`must be ≥ ${c.minInclusive}`);
      if (c.maxInclusive != null && typeof item === 'number' && item > c.maxInclusive) viol(`must be ≤ ${c.maxInclusive}`);
    }
  }
  if (shape.exactlyOneOf) {
    const present = shape.exactlyOneOf.paths.filter(p => { const x = pick(instance, p); return x !== undefined && x !== null; });
    if (present.length !== 1) results.push({ path: shape.exactlyOneOf.paths.join(' | '), message: `exactly one of {${shape.exactlyOneOf.paths.join(', ')}} is required — found ${present.length}`, sourceShape: nodeShape, severity: 'Violation' });
  }
  if (shape.atLeastOneOf) {
    const declared = (['@type', 'objectType', 'type'] as const).flatMap(k => { const t = instance[k]; return Array.isArray(t) ? t : t === undefined ? [] : [t]; }).map(String);
    const holds = shape.atLeastOneOf.alternatives.some(a => {
      // An instance of a class declares it (by its local name, as a document's context reads it).
      if ('class' in a) { const local = a.class.split(/[#/:]/).pop()!; return declared.some(t => t.split(/[#/:]/).pop() === local); }
      if ('shape' in a) return validateAgainstShape(m, a.shape, instance).conforms;
      const x = pick(instance, a.path);
      if (a.identifies) return typeof x === 'string' && IRI_RE.test(x);
      return x !== undefined && x !== null && !(Array.isArray(x) && x.length === 0);
    });
    const paths = shape.atLeastOneOf.alternatives.map(a => 'class' in a ? `a ${a.class}` : 'shape' in a ? a.shape : a.path);
    if (!holds) results.push({ path: paths.join(' | '), message: `at least one of {${paths.join(', ')}} is required${shape.atLeastOneOf.comment ? ` — ${shape.atLeastOneOf.comment}` : ''}`, sourceShape: nodeShape, severity: 'Violation' });
  }
  return { conforms: results.length === 0, results, shapesIri: shapesIri(m) };
}

// ── Composition into the PGSL lattice (the ontology becomes a holon) ────────────
export interface ComposedOntology { module: string; label: string; holonUri?: string; descriptorUrl?: string }

/** Compose a spec ontology MODEL into the shared lattice: its term IRIs become
 *  reusable atoms, the model is the holon's content atom. Best-effort (needs a pod);
 *  returns the holon refs when persisted. */
export async function composeSpecOntology(model: OntologyModel, opts: { podUrl: string; agentDid: string }): Promise<ComposedOntology> {
  const label = `ns-${model.module}`;
  // The ontology is a graph, so compose it AS a graph — mirroring RDF's own
  // hierarchy: graph -> subject -> triple -> (subject, predicate, object).
  //
  // The previous flat list of subject urls gave every atom exactly one occurrence
  // (1.05x reuse over all six specs), so PGSL built ~n^2/2 fragments over a
  // sequence with nothing in common. Grouping by subject restores the real overlap
  // (82% of triple slots hit an existing atom) AND keeps every ingest narrow:
  // ~6 triples per subject, 3 terms per triple. Composing the ontology out of all
  // ~450 triples in ONE ingest is not "more holonic" — it is quadratic, and OOMs.
  const bySubject = new Map<string, Triple[]>();
  for (const t of ontologyTriples(model)) {
    const cur = bySubject.get(t[0]);
    if (cur) cur.push(t); else bySubject.set(t[0], [t]);
  }
  const groups = [...bySubject.values()].map(ts => ts.map(t => [t[0], t[1], t[2]] as const));
  // Keep the ontology url itself on the flat spine: it is the term other artifacts
  // (and other ontologies' owl:imports) join on.
  const terms = [ontologyIri(model)];
  if (!opts.podUrl) return { module: model.module, label };
  const sl = await composeIntoSharedLattice({
    podUrl: opts.podUrl, agentDid: opts.agentDid, label,
    terms, termGroups: groups, content: { ontology: model }, contentType: 'spec:Ontology', projections: ['rdf'],
    // The ontology IS this code's OntologyModel — recomposed identically every
    // boot and served from the resident lattice (specModelFromHolon, with the
    // model itself as fallback). Nothing dereferences its pod copy, and every
    // ontology label composes to the SAME tenant pod, so persisting made them
    // accumulate each other's nodes until the PUT 500'd at 43 MB.
    ephemeral: true,
    // Public: this ontology is already served in full at /ns/<module>. Marking it
    // lets its nodes be dereferenced by hash without a label — see resolvePublicNode.
    // Nothing here is private; every atom is a term of a published vocabulary.
    publicLattice: true,
  });
  return { module: model.module, label, holonUri: sl?.holonUri, descriptorUrl: sl?.descriptorUrl };
}

/** One term's triples (and the blank nodes they reach), or null for a name the ontology does
 *  not declare — so the route can 404 rather than fabricate a 200 for an IRI that resolves to
 *  nothing (owning a namespace is not a licence to invent members on demand). */
export function termGraph(m: OntologyModel, name: string): Graph | null {
  const full = ns(m) + name;
  const g = ontologyGraph(m);
  if (!g.triples.some(t => t.s.termType === 'NamedNode' && t.s.value === full)) return null;
  const out = new Graph();
  const visit = (s: Subject, seen: Set<string>): void => {
    for (const t of g.triples) {
      if (t.s.termType !== s.termType || t.s.value !== s.value) continue;
      out.add(t.s, t.p, t.o);
      if (t.o.termType === 'BlankNode' && !seen.has(t.o.value)) { seen.add(t.o.value); visit(t.o, seen); }
    }
  };
  visit(iri(full), new Set());
  return out;
}

/** A single term as a JSON-LD resource with HATEOAS links (null for an unknown name). */
export function renderTermJsonLd(m: OntologyModel, name: string): Record<string, unknown> | null {
  const tg = termGraph(m, name);
  if (!tg) return null;
  const doc = toJsonLd(tg, documentPrefixes(m), { first: [ns(m) + name] });
  const [node, ...rest] = doc['@graph'] as Array<Record<string, unknown>>;
  // The route links the term to its document and the shapes in the Link header (a body `_links` is
  // dropped by JSON-LD processing, and refused in safe mode).
  return { '@context': doc['@context'], ...node!, '@id': ns(m) + name, ...(rest.length ? { '@included': rest } : {}) };
}

/** Human-readable documentation (content negotiation: Accept: text/html). */
export function renderHtml(m: OntologyModel): string {
  const o = ontologyIri(m);
  return renderOntologyHtml({
    graph: ontologyGraph(m), meta: docMeta(m), prefixes: documentPrefixes(m),
    shapes: shapesGraph(m), shapesIri: shapesIri(m),
    links: [...alternates(o), { label: 'SHACL shapes', href: shapesIri(m), type: 'text/turtle' }, { label: `this version (${m.version})`, href: `${o}/${m.version}` }],
  });
}

/** Read the model back from the composed holon (PGSL is canonical), if resident. */
export function modelFromHolon(label: string, holonUri: string): OntologyModel | null {
  const art = readArtifact(label, holonUri);
  if (!art || art.contentType !== 'spec:Ontology') return null;
  return (art.content as { ontology: OntologyModel }).ontology;
}
