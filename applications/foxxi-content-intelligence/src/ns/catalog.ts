/**
 * ns/catalog.ts — what every Foxxi `/ns` document says about itself, said once.
 *
 * Each Foxxi ontology is a published artifact, and a reviewer reads its header before any term:
 * who made it, under what licence, which version this is and where that version lives, what it
 * models, and how to cite it. Those were missing from all fifteen documents (FOOPS! scored them
 * 0.13–0.37). They are produced here, from one record per document, so the header cannot drift
 * between families or between the Turtle, RDF/XML, N-Triples and JSON-LD of the same document.
 *
 * Two policies live here because they are policies, not data:
 *
 *  ★ PREFIXES ARE `foxxi-<path>`, NEVER A STANDARDS BODY'S NAME. `xapi` is the registered prefix
 *    of ADL's own xAPI ontology (w3id.org/xapi/ontology), and `cmi5`, `scorm`, `ler`, `tla`,
 *    `ob3`, `clr` are names their owners may claim. These are Foxxi's independent formalizations,
 *    so their preferred prefixes say so — and `xapi:` is free to mean ADL's terms, which these
 *    ontologies map to. (Not `fx*`: that family named the retired vocab.foxximediums.com host.)
 *
 *  ★ EXTERNAL TERMS ARE DECLARED, NOT IMPORTED (MIREOT). OWL 2 DL requires every entity an axiom
 *    uses to be declared. Importing whole vocabularies to get those declarations would pull in
 *    documents that are not OWL 2 DL (SKOS) or not published as RDF at their IRI (the Interego
 *    core ontology serves HTML from GitHub Pages), and a reasoner could not load the result. So
 *    each document declares exactly the external classes and properties it uses, with the kind
 *    their publisher gave them — the Minimum Information to Reference an External Ontology Term.
 */
import {
  Graph, iri, en, str, date, RDF, RDFS, OWL, XSD, SKOS, DCT, PROV, VANN, BIBO, FOAF, SCHEMA, SH, STD_PREFIXES,
  type NamedNode, type Prefixes, type Subject, type Term,
} from './rdf.js';

/** The dereferenceable namespace root the bridge serves. A compile-time constant: an ontology
 *  IRI is a promise that it resolves, so it never depends on the environment. */
export const NS_BASE = 'https://foxxi-bridge.interego.xwisee.com/ns/';

/** Every path segment the bridge serves an ontology at. */
export const FOXXI_MODULES = [
  'xapi', 'scorm-cam', 'scorm-sn', 'scorm-rte', 'cmi5', 'ai-elearning',
  'soc2', 'eu-ai-act', 'nist-rmf', 'ob3', 'clr', 'ieee-ler', 'adl-tla', 'foxxi',
] as const;

/** The preferred prefix of a Foxxi namespace. */
export function foxxiPrefix(module: string): string { return module === 'foxxi' ? 'foxxi' : `foxxi-${module}`; }

/** prefix → term namespace, for every Foxxi ontology. */
export const FOXXI_PREFIXES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(FOXXI_MODULES.map(m => [foxxiPrefix(m), `${NS_BASE}${m}#`])),
);

/** Vocabularies Foxxi documents refer to, under the prefixes their publishers use. */
export const EXTERNAL_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  xapi: 'https://w3id.org/xapi/ontology#',            // ADL's xAPI ontology
  iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
  pgsl: 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#',
  amta: 'https://markjspivey-xwisee.github.io/interego/ns/amta#',
  hela: 'https://markjspivey-xwisee.github.io/interego/ns/hela#',
  // The Interego substrate's own L3 compliance vocabularies, which the Foxxi foxxi-soc2,
  // foxxi-eu-ai-act and foxxi-nist-rmf documents map to.
  soc2: 'https://markjspivey-xwisee.github.io/interego/ns/soc2#',
  'eu-ai-act': 'https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#',
  'nist-rmf': 'https://markjspivey-xwisee.github.io/interego/ns/nist-rmf#',
  vc: 'https://www.w3.org/2018/credentials#',
  // 1EdTech's own Open Badges 3.0 and CLR 2.0 vocabularies (what their JSON-LD contexts map to).
  ob: 'https://purl.imsglobal.org/spec/vc/ob/vocab.html#',
  clr: 'https://purl.imsglobal.org/spec/vc/clr/vocab.html#',
  sec: 'https://w3id.org/security#',
  prof: 'http://www.w3.org/ns/dx/prof/',
  role: 'http://www.w3.org/ns/dx/prof/role/',
  dcat: 'http://www.w3.org/ns/dcat#',
});

/** Every prefix a Foxxi document may print. */
export const ALL_PREFIXES: Prefixes = Object.freeze({ ...STD_PREFIXES, ...EXTERNAL_PREFIXES, ...FOXXI_PREFIXES });

// ── Who, and under what terms ─────────────────────────────────────────────────────────────────
export const CREATOR = 'Mark Spivey';
export const PUBLISHER = 'Foxxi Mediums Inc.';
export const CONTRIBUTOR = 'Claude (Anthropic)';
export const LICENSE = 'https://opensource.org/licenses/MIT';
export const RIGHTS = '© 2026 Mark Spivey (Foxxi Mediums Inc.). Released under the MIT License.';
export const LANGUAGE = 'http://id.loc.gov/vocabulary/iso639-1/en';
export const STATUS_PUBLISHED = `${BIBO}status/published`;

/** A standard (or other normative source) a document formalizes. */
export interface StandardRef {
  /** How a reader cites it, e.g. "IEEE 9274.1.1-2023 (xAPI 2.0)". */
  readonly title: string;
  /** A resolvable page for it. Emitted as dct:source. */
  readonly url: string;
}

/** The self-description of one published document. */
export interface DocMeta {
  /** Ontology IRI (no trailing `#`). */
  readonly iri: string;
  /** Term namespace (with `#`). Omitted for shapes graphs, which mint no terms of their own. */
  readonly ns?: string;
  /** Preferred prefix for `ns`. */
  readonly prefix?: string;
  readonly title: string;
  readonly description: string;
  /** Semantic version of THIS artifact (not of the standard it models). */
  readonly version: string;
  /** The released version this one follows (owl:priorVersion), once the document has had one. */
  readonly priorVersion?: string;
  /** Whether data and documents written against the prior version keep their meaning under this
   *  one: owl:backwardCompatibleWith, or owl:incompatibleWith, the prior version. A document with a
   *  prior version must say which (tools/release-ns.ts refuses one that does not). */
  readonly priorCompatibility?: 'backward' | 'incompatible';
  /** ISO dates (YYYY-MM-DD). */
  readonly created: string;
  readonly modified: string;
  readonly issued: string;
  /** What it formalizes — emitted as dct:source and shown in the documentation. */
  readonly standards: readonly StandardRef[];
  /** The owners of those standards, named in the non-affiliation notice. */
  readonly bodies: readonly string[];
  /** Replaces the generated non-affiliation notice — for a document that formalizes no
   *  standard (an original vocabulary), where "where this differs, the standard governs" would
   *  be a sentence about nothing. */
  readonly notice?: string;
  readonly seeAlso?: readonly string[];
  readonly imports?: readonly string[];
  /** Additional rdfs:comment paragraphs (English). */
  readonly notes?: readonly string[];
  /** For a shapes graph: the ontology it constrains. */
  readonly constrains?: string;
  /** Repository paths of the files this document is generated from (prov:wasDerivedFrom, each at
   *  this version's release tag). */
  readonly sourceCode?: readonly string[];
}

/**
 * ★ A RELEASED VERSION CITES THE SOURCE IT WAS GENERATED FROM AS IT WAS, NOT AS IT IS. A version's
 * content never changes, so its prov:wasDerivedFrom cannot name a file on master, which does: the
 * claim would turn false at the next commit. Each version's sources are cited at its release tag,
 * `foxxi-ns-<version>`, which .github/workflows/foxxi-ns-release-tags.yml makes on the commit that
 * brings the version onto master — the commit whose tree generated it — and which is never moved.
 */
export const releaseTag = (version: string): string => `foxxi-ns-${version}`;
/** A repository file as it was at a version's release tag. */
export const sourceAt = (version: string, path: string): string =>
  `https://github.com/markjspivey-xwisee/interego/blob/${releaseTag(version)}/${path}`;

/** The IRI of a specific version of a document. */
export const versionIri = (meta: Pick<DocMeta, 'iri' | 'version'>): string => `${meta.iri}/${meta.version}`;

/**
 * ★ VERSIONS NUMBER THE DOCUMENT, BY CALENDAR. Each document's `version` is YYYY.MM.PATCH. It never
 * restates the version of the standard a document formalizes — that is in its title — because the
 * earlier `owl:versionInfo` values did exactly that (xAPI's 2.0.0, SCORM's 4.0.0 and 1.3.4), so a
 * reader could not tell which thing was being versioned. Calendar numbers are also ordered above
 * every number published before.
 *
 * ★ A VERSION IRI KEEPS ITS CONTENT, FOR GOOD. Each released version is archived in ns-releases/
 * (tools/release-ns.ts) and answered from there at its version IRI after newer versions replace it
 * at the document IRI (ns/releases.ts); a test holds the archive to SHA256SUMS and the current
 * documents to their archived graphs, so a changed document must take a new version. A new version
 * names the one before it (owl:priorVersion), and a Foxxi document imports another by its version
 * IRI, so the import closure of a released version never changes either.
 */
export const VERSIONING_NOTE = 'Versioned by calendar (YYYY.MM.PATCH) from 2026.10.0: the version numbers this document, not the standard it formalizes. Every released version stays resolvable at its version IRI, and the content there never changes. Earlier publications carried no version IRI, and their owl:versionInfo restated the version of the standard.';

/** The notice a document carries: its own, or the generated non-affiliation statement. */
export const noticeOf = (meta: Pick<DocMeta, 'bodies' | 'notice'>): string => meta.notice ?? nonAffiliation(meta.bodies);

/** The non-affiliation notice every standards formalization carries. */
export function nonAffiliation(bodies: readonly string[]): string {
  const who = bodies.length === 0 ? 'any standards body'
    : bodies.length === 1 ? bodies[0]!
      : `${bodies.slice(0, -1).join(', ')} or ${bodies[bodies.length - 1]}`;
  return `Independent formalization by ${CREATOR} (${PUBLISHER}). Not affiliated with or endorsed by ${who}. `
    + 'Where this document and the published standard differ, the standard governs.';
}

/** "Spivey, M. (2026). <title> (Version x.y.z) [Ontology]. Foxxi Mediums Inc. <versionIRI>" */
export function citation(meta: DocMeta, kind = 'Ontology'): string {
  // PUBLISHER already ends in a full stop ("Inc.").
  return `Spivey, M. (${meta.issued.slice(0, 4)}). ${meta.title} (Version ${meta.version}) [${kind}]. ${PUBLISHER} ${versionIri(meta)}`;
}

/** Write the ontology header for `meta` into `g`; returns the ontology node. */
export function addHeader(g: Graph, meta: DocMeta, kind = 'Ontology'): NamedNode {
  const O = iri(meta.iri);
  g.add(O, iri(RDF + 'type'), iri(OWL + 'Ontology'));
  g.add(O, iri(DCT + 'title'), en(meta.title));
  g.add(O, iri(DCT + 'description'), en(meta.description));
  g.add(O, iri(RDFS + 'comment'), en(noticeOf(meta)));
  for (const n of meta.notes ?? []) g.add(O, iri(RDFS + 'comment'), en(n));
  g.add(O, iri(OWL + 'versionIRI'), iri(versionIri(meta)));
  g.add(O, iri(OWL + 'versionInfo'), str(meta.version));
  if (meta.priorVersion) {
    const prior = iri(versionIri({ iri: meta.iri, version: meta.priorVersion }));
    g.add(O, iri(OWL + 'priorVersion'), prior);
    if (meta.priorCompatibility) g.add(O, iri(OWL + (meta.priorCompatibility === 'backward' ? 'backwardCompatibleWith' : 'incompatibleWith')), prior);
  }
  g.add(O, iri(SKOS + 'historyNote'), en(VERSIONING_NOTE));
  g.add(O, iri(DCT + 'creator'), str(CREATOR));
  g.add(O, iri(DCT + 'contributor'), str(CONTRIBUTOR));
  g.add(O, iri(DCT + 'publisher'), str(PUBLISHER));
  g.add(O, iri(DCT + 'license'), iri(LICENSE));
  g.add(O, iri(DCT + 'rights'), en(RIGHTS));
  g.add(O, iri(DCT + 'created'), date(meta.created));
  g.add(O, iri(DCT + 'modified'), date(meta.modified));
  g.add(O, iri(DCT + 'issued'), date(meta.issued));
  g.add(O, iri(DCT + 'language'), iri(LANGUAGE));
  g.add(O, iri(BIBO + 'status'), iri(STATUS_PUBLISHED));
  g.add(O, iri(DCT + 'bibliographicCitation'), str(citation(meta, kind)));
  if (meta.prefix && meta.ns) {
    g.add(O, iri(VANN + 'preferredNamespacePrefix'), str(meta.prefix));
    g.add(O, iri(VANN + 'preferredNamespaceUri'), str(meta.ns));
  }
  for (const s of meta.standards) g.add(O, iri(DCT + 'source'), iri(s.url));
  for (const f of meta.sourceCode ?? []) g.add(O, iri(PROV + 'wasDerivedFrom'), iri(sourceAt(meta.version, f)));
  for (const s of meta.seeAlso ?? []) g.add(O, iri(RDFS + 'seeAlso'), iri(s));
  for (const i of meta.imports ?? []) g.add(O, iri(OWL + 'imports'), iri(i));
  return O;
}

// ── MIREOT: declare the external terms a document uses ───────────────────────────────────────
/** External properties whose publisher gives them no logical role in OWL (or whose OWL use is
 *  conventionally annotation-only, like SKOS labels and mapping relations between classes). */
const ANNOTATION = new Set<string>([
  ...['title', 'description', 'creator', 'contributor', 'publisher', 'license', 'rights', 'created', 'modified',
    'issued', 'language', 'bibliographicCitation', 'source', 'conformsTo', 'subject', 'identifier', 'references']
    .map(x => DCT + x),
  VANN + 'preferredNamespacePrefix', VANN + 'preferredNamespaceUri', BIBO + 'status',
  ...['prefLabel', 'altLabel', 'hiddenLabel', 'definition', 'note', 'scopeNote', 'example', 'editorialNote',
    'historyNote', 'changeNote', 'notation', 'exactMatch', 'closeMatch', 'broadMatch', 'narrowMatch', 'relatedMatch']
    .map(x => SKOS + x),
  SCHEMA + 'keywords', 'http://www.w3.org/ns/dcat#keyword',
]);
/** External properties that relate individuals (SKOS concept structure, PROV, PROF). */
const OBJECT = new Set<string>([
  ...['inScheme', 'hasTopConcept', 'topConceptOf', 'member', 'broader', 'narrower', 'related', 'broaderTransitive',
    'narrowerTransitive', 'semanticRelation'].map(x => SKOS + x),
  ...['hadMember', 'wasDerivedFrom', 'wasAttributedTo', 'wasGeneratedBy', 'used', 'wasAssociatedWith', 'hadPrimarySource']
    .map(x => PROV + x),
  'http://www.w3.org/ns/dx/prof/isProfileOf', 'http://www.w3.org/ns/dx/prof/hasResource',
  'http://www.w3.org/ns/dx/prof/hasRole', 'http://www.w3.org/ns/dx/prof/hasArtifact',
  'https://markjspivey-xwisee.github.io/interego/ns/iep#constructedFrom',
]);
/**
 * What a reader needs to know about the external classes and object properties Foxxi documents use
 * most — MIREOT's minimum information: a label, a definition, the document that defines the term,
 * and the few axioms its owner states that a reasoner needs (SKOS's ranges and inverse, PROV's
 * domains and ranges, PROF's). Without them each document declared bare IRIs, and OOPS! reported
 * every one of them as a term without annotations or a domain and range. The definitions are the
 * owners' own, abridged; where the owner states no axiom, none is added.
 */
interface ExternalTermInfo {
  label: string; comment: string; definedBy: string;
  domain?: string; range?: string; subClassOf?: string; subPropertyOf?: string; inverseOf?: string; disjointWith?: string;
}
const SKOS_DOC = 'http://www.w3.org/2004/02/skos/core';
const PROV_DOC = 'http://www.w3.org/ns/prov-o';
const PROF = 'http://www.w3.org/ns/dx/prof/';
/** The root of the Interego substrate's namespaces (not `IE`, which ontology-lint reads as the ie: namespace). */
const SUBSTRATE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/';
const ADL_XAPI = 'https://w3id.org/xapi/ontology#';
export const EXTERNAL_TERM_INFO: Readonly<Record<string, ExternalTermInfo>> = Object.freeze({
  [SKOS + 'Concept']: { label: 'Concept', comment: 'An idea or notion; a unit of thought. (SKOS)', definedBy: SKOS_DOC },
  [SKOS + 'ConceptScheme']: { label: 'Concept Scheme', comment: 'A set of concepts, optionally including statements about semantic relationships between those concepts. (SKOS)', definedBy: SKOS_DOC, disjointWith: SKOS + 'Concept' },
  [SKOS + 'Collection']: { label: 'Collection', comment: 'A meaningful collection of concepts. (SKOS)', definedBy: SKOS_DOC },
  [SKOS + 'inScheme']: { label: 'is in scheme', comment: 'Relates a resource (for example a concept) to a concept scheme in which it is included. (SKOS)', definedBy: SKOS_DOC, range: SKOS + 'ConceptScheme' },
  [SKOS + 'hasTopConcept']: { label: 'has top concept', comment: 'Relates, by convention, a concept scheme to a concept which is topmost in the broader/narrower concept hierarchies for that scheme. (SKOS)', definedBy: SKOS_DOC, domain: SKOS + 'ConceptScheme', range: SKOS + 'Concept' },
  [SKOS + 'topConceptOf']: { label: 'is top concept in scheme', comment: 'Relates a concept to the concept scheme that it is a top level concept of. (SKOS)', definedBy: SKOS_DOC, subPropertyOf: SKOS + 'inScheme', inverseOf: SKOS + 'hasTopConcept' },
  [SKOS + 'member']: { label: 'has member', comment: 'Relates a collection to one of its members. (SKOS)', definedBy: SKOS_DOC, domain: SKOS + 'Collection' },
  [PROV + 'Entity']: { label: 'Entity', comment: 'A physical, digital, conceptual, or other kind of thing with some fixed aspects. (PROV-O)', definedBy: PROV_DOC },
  [PROV + 'Agent']: { label: 'Agent', comment: 'Something that bears some form of responsibility for an activity taking place, for the existence of an entity, or for another agent\'s activity. (PROV-O)', definedBy: PROV_DOC },
  [PROV + 'Organization']: { label: 'Organization', comment: 'A social or legal institution such as a company or a society. (PROV-O)', definedBy: PROV_DOC, subClassOf: PROV + 'Agent' },
  [PROV + 'Collection']: { label: 'Collection', comment: 'An entity that provides a structure to some constituents that must themselves be entities. (PROV-O)', definedBy: PROV_DOC, subClassOf: PROV + 'Entity' },
  [PROV + 'wasDerivedFrom']: { label: 'was derived from', comment: 'A transformation of an entity into another, an update of an entity resulting in a new one, or the construction of a new entity based on a pre-existing one. (PROV-O)', definedBy: PROV_DOC, domain: PROV + 'Entity', range: PROV + 'Entity' },
  [PROV + 'wasAttributedTo']: { label: 'was attributed to', comment: 'The ascribing of an entity to an agent. (PROV-O)', definedBy: PROV_DOC, domain: PROV + 'Entity', range: PROV + 'Agent' },
  [PROV + 'hadMember']: { label: 'had member', comment: 'Relates a collection to an entity that belongs to it. (PROV-O)', definedBy: PROV_DOC, domain: PROV + 'Collection', range: PROV + 'Entity' },
  [PROF + 'Profile']: { label: 'Profile', comment: 'A specification that constrains, extends, combines, or provides guidance or explanation about the usage of other specifications. (PROF)', definedBy: 'http://www.w3.org/ns/dx/prof', subClassOf: DCT + 'Standard' },
  [PROF + 'isProfileOf']: { label: 'is profile of', comment: 'The specification for which this profile is defined. (PROF)', definedBy: 'http://www.w3.org/ns/dx/prof', domain: PROF + 'Profile', range: DCT + 'Standard' },
  [DCT + 'Standard']: { label: 'Standard', comment: 'A reference point against which other things can be evaluated or compared. (DCMI Metadata Terms)', definedBy: 'http://purl.org/dc/terms/' },
  ['https://www.w3.org/2018/credentials#VerifiableCredential']: { label: 'Verifiable credential', comment: 'A tamper-evident credential whose authorship can be cryptographically verified. (W3C VC Data Model 2.0)', definedBy: 'https://www.w3.org/2018/credentials#' },
  [ADL_XAPI + 'Verb']: { label: 'Verb', comment: 'The class used for a Verb object in xAPI. (ADL xAPI ontology)', definedBy: 'https://w3id.org/xapi/ontology' },
  [ADL_XAPI + 'ActivityType']: { label: 'Activity type', comment: 'The class for an Activity Type in an xAPI vocabulary or profile. (ADL xAPI ontology)', definedBy: 'https://w3id.org/xapi/ontology' },
  [ADL_XAPI + 'ContextExtension']: { label: 'Context extension', comment: 'The class used to classify a ContextExtension in xAPI. (ADL xAPI ontology)', definedBy: 'https://w3id.org/xapi/ontology' },
  [`${SUBSTRATE_NS}amta#Attestation`]: { label: 'AMTA Attestation', comment: 'A multi-dimensional trust attestation by one agent (the attestor) about another agent or claim (the subject). (Interego AMTA)', definedBy: `${SUBSTRATE_NS}amta` },
  [`${SUBSTRATE_NS}iep#ContextDescriptor`]: { label: 'Context Descriptor', comment: 'A metadata envelope that annotates one or more RDF named graphs with typed context facets: provenance, temporal validity, semiotic frame, trust level and federation metadata. (Interego Protocol)', definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}iep#ComposedDescriptor`]: { label: 'Composed Descriptor', comment: 'A context descriptor produced by applying a composition operator (union, intersection, restriction, override) to two or more source descriptors. (Interego Protocol)', definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}iep#Affordance`]: { label: 'Affordance', comment: 'A capability that a pod or manifest supports, for HATEOAS-style agent discovery of what operations are available. (Interego Protocol)', definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}iep#constructedFrom`]: { label: 'constructed from', comment: 'Declares that the subject class or property is constructed at runtime from the named Interego Protocol primitives. (Interego Protocol)', definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}hela#Statement`]: { label: 'HELA Statement', comment: 'An xAPI-style (actor, verb, object) statement — the atomic unit of HELA\'s presheaf category. (Interego HELA)', definedBy: `${SUBSTRATE_NS}hela` },
  [`${SUBSTRATE_NS}pgsl#Atom`]: { label: 'Atom', comment: 'A leaf node of the PGSL lattice holding one primitive value, identified by its content. (Interego PGSL)', definedBy: `${SUBSTRATE_NS}pgsl` },
});

/** Vocabulary the OWL 2 RDF mapping reserves: never declared, never re-typed. */
const BUILT_IN = (u: string): boolean => u.startsWith(RDF) || u.startsWith(RDFS) || u.startsWith(OWL) || u.startsWith(XSD);
/** Predicates whose OBJECT is a class expression. */
const CLASS_POSITIONS = new Set([RDFS + 'subClassOf', OWL + 'equivalentClass', OWL + 'disjointWith', RDFS + 'domain',
  OWL + 'someValuesFrom', OWL + 'allValuesFrom', OWL + 'onClass', OWL + 'complementOf']);

/**
 * Declare (MIREOT) every external class and property `g` uses, so the document is self-contained
 * OWL 2 DL. `own` are the namespaces this document mints; their terms are declared by the
 * document itself and are left alone. Returns the IRIs it declared, by kind.
 */
export function declareExternalTerms(g: Graph, own: readonly string[]): { classes: string[]; annotation: string[]; object: string[]; datatype: string[] } {
  const isOwn = (u: string): boolean => own.some(n => u.startsWith(n));
  const kindOf = new Map<string, 'class' | 'annotation' | 'object' | 'datatype'>();
  const note = (u: string, k: 'class' | 'annotation' | 'object' | 'datatype'): void => {
    if (BUILT_IN(u) || isOwn(u) || u.startsWith(SH)) return;
    if (!kindOf.has(u)) kindOf.set(u, k);
  };
  const ownKind = (p: string): 'object' | 'datatype' | 'annotation' | null => {
    const types = g.objects(iri(p), RDF + 'type').map(t => t.value);
    if (types.includes(OWL + 'ObjectProperty')) return 'object';
    if (types.includes(OWL + 'DatatypeProperty')) return 'datatype';
    if (types.includes(OWL + 'AnnotationProperty')) return 'annotation';
    return null;
  };
  const listItems = (head: Subject): Subject[] => {
    const out: Subject[] = [];
    let cur: Subject | null = head;
    while (cur && cur.termType === 'BlankNode') {
      const first = g.objects(cur, RDF + 'first')[0];
      if (first && first.termType !== 'Literal') out.push(first);
      const rest: Term | undefined = g.objects(cur, RDF + 'rest')[0];
      cur = rest && rest.termType !== 'Literal' ? rest : null;
    }
    return out;
  };
  for (const t of g.triples) {
    const p = t.p.value;
    // the predicate itself
    if (!BUILT_IN(p) && !isOwn(p)) {
      if (ANNOTATION.has(p)) note(p, 'annotation');
      else if (OBJECT.has(p)) note(p, 'object');
      else note(p, t.o.termType === 'Literal' ? 'annotation' : 'annotation');
    }
    // classes in type and class-expression positions
    if (p === RDF + 'type' && t.o.termType === 'NamedNode') note(t.o.value, 'class');
    if (CLASS_POSITIONS.has(p) && t.o.termType === 'NamedNode') note(t.o.value, 'class');
    if ((p === OWL + 'unionOf' || p === OWL + 'intersectionOf') && t.o.termType === 'BlankNode') {
      for (const m of listItems(t.o)) if (m.termType === 'NamedNode') note(m.value, 'class');
    }
    // ranges: a class for an object property, a datatype for a datatype property
    if (p === RDFS + 'range' && t.o.termType === 'NamedNode' && t.s.termType === 'NamedNode') {
      const k = ownKind(t.s.value);
      note(t.o.value, k === 'datatype' ? 'datatype' : 'class');
    }
    // super-properties take the kind of the property that specializes them
    if (p === RDFS + 'subPropertyOf' && t.o.termType === 'NamedNode' && t.s.termType === 'NamedNode') {
      const k = ownKind(t.s.value);
      if (k) kindOf.set(t.o.value, k);
    }
  }
  // MIREOT's minimum information for the terms whose owners' definitions are on file: their
  // axioms bring further external terms (PROV's Entity) in, which get the same treatment.
  const queue = [...kindOf.keys()];
  const informed = new Set<string>();
  while (queue.length) {
    const u = queue.shift()!;
    const info = EXTERNAL_TERM_INFO[u];
    if (!info || informed.has(u)) continue;
    informed.add(u);
    const refer = (v: string | undefined, k: 'class' | 'object'): void => {
      if (!v || BUILT_IN(v) || isOwn(v)) return;
      if (!kindOf.has(v)) kindOf.set(v, k);
      queue.push(v);
    };
    const kind = kindOf.get(u);
    refer(info.domain, 'class'); refer(info.range, 'class'); refer(info.subClassOf, 'class'); refer(info.disjointWith, 'class');
    refer(info.subPropertyOf, kind === 'object' ? 'object' : 'class'); refer(info.inverseOf, 'object');
  }
  for (const u of informed) {
    const info = EXTERNAL_TERM_INFO[u]!;
    const U = iri(u);
    // A label the document already gives the term (MIREOT `references`) stands; one per term.
    if (!g.objects(U, RDFS + 'label').length) g.add(U, iri(RDFS + 'label'), en(info.label));
    if (!g.objects(U, RDFS + 'comment').length) g.add(U, iri(RDFS + 'comment'), en(info.comment));
    if (!g.objects(U, RDFS + 'isDefinedBy').length) g.add(U, iri(RDFS + 'isDefinedBy'), iri(info.definedBy));
    if (info.domain) g.add(U, iri(RDFS + 'domain'), iri(info.domain));
    if (info.range) g.add(U, iri(RDFS + 'range'), iri(info.range));
    if (info.subClassOf) g.add(U, iri(RDFS + 'subClassOf'), iri(info.subClassOf));
    if (info.subPropertyOf) g.add(U, iri(RDFS + 'subPropertyOf'), iri(info.subPropertyOf));
    if (info.inverseOf) g.add(U, iri(OWL + 'inverseOf'), iri(info.inverseOf));
    if (info.disjointWith) g.add(U, iri(OWL + 'disjointWith'), iri(info.disjointWith));
  }
  const out = { classes: [] as string[], annotation: [] as string[], object: [] as string[], datatype: [] as string[] };
  for (const [u, k] of kindOf) {
    if (BUILT_IN(u) || isOwn(u)) continue;
    const T = k === 'class' ? OWL + 'Class' : k === 'object' ? OWL + 'ObjectProperty'
      : k === 'datatype' ? RDFS + 'Datatype' : OWL + 'AnnotationProperty';
    g.add(iri(u), iri(RDF + 'type'), iri(T));
    (k === 'class' ? out.classes : k === 'object' ? out.object : k === 'datatype' ? out.datatype : out.annotation).push(u);
  }
  return out;
}

/** The HTML documentation's list of other representations of a document. */
export function alternates(docIri: string): Array<{ label: string; type: string; href: string }> {
  return [
    { label: 'Turtle', type: 'text/turtle', href: docIri },
    { label: 'RDF/XML', type: 'application/rdf+xml', href: docIri },
    { label: 'N-Triples', type: 'application/n-triples', href: docIri },
    { label: 'JSON-LD', type: 'application/ld+json', href: docIri },
  ];
}

export { FOAF, PROV };
