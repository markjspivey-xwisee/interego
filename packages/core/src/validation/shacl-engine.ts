/**
 * @module validation/shacl-engine
 * @description Minimal in-process SHACL validation engine.
 *
 * A deliberately narrow SHACL implementation used by the publish-path
 * conformance gate (deploy/mcp-relay/server.ts handlePublishContext)
 * and any caller that needs to validate an inbound data graph against
 * a shape graph WITHOUT pulling in a heavy SHACL engine dependency
 * (rdf-validate-shacl etc. — none of which are currently in the repo).
 *
 * Supported constraints (Core SHACL subset):
 *   - sh:targetClass            — bind the shape to every subject of that class
 *   - sh:targetNode             — bind the shape to specific nodes
 *   - sh:property → sh:path     — property-path single predicate
 *   - sh:minCount / sh:maxCount — cardinality
 *   - sh:datatype               — literal datatype check
 *   - sh:nodeKind sh:IRI / sh:Literal / sh:BlankNode / sh:BlankNodeOrIRI
 *   - sh:class                  — value must be a subject with that rdf:type
 *   - sh:in (...)               — value enumeration (parsed as comma list)
 *   - sh:hasValue               — must include the listed value
 *   - sh:pattern                — regex on literal lexical form
 *   - sh:message                — surfaced verbatim on violation
 *
 * NOT supported (intentional — out-of-scope for the kernel gate):
 *   - sh:and / sh:or / sh:not / sh:xone
 *   - Property paths beyond single predicate (inverse, sequence, alternative)
 *   - sh:qualifiedValueShape
 *   - SHACL-SPARQL (sh:sparql)
 *
 * The motivating use case: container-declared `iep:conformsTo <shapeIri>`
 * triples on a Solid pod's manifest. The relay fetches the shape graph,
 * runs validateAgainstShape() against the inbound graph_content, and
 * rejects the publish 422 on non-conformance before the CSS write.
 */
import {
  parseTrig,
  findSubjectsOfType,
  type ParsedDocument,
  type ParsedSubject,
  type ParsedTerm,
} from '../rdf/turtle-parser.js';
import type { IRI } from '../model/types.js';

const SHACL = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' as IRI;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const SH_NODE_SHAPE = `${SHACL}NodeShape` as IRI;
const SH_PROPERTY_SHAPE = `${SHACL}PropertyShape` as IRI;
const SH_TARGET_CLASS = `${SHACL}targetClass` as IRI;
const SH_TARGET_NODE = `${SHACL}targetNode` as IRI;
const SH_PROPERTY = `${SHACL}property` as IRI;
const SH_PATH = `${SHACL}path` as IRI;
const SH_MIN_COUNT = `${SHACL}minCount` as IRI;
const SH_MAX_COUNT = `${SHACL}maxCount` as IRI;
const SH_DATATYPE = `${SHACL}datatype` as IRI;
const SH_NODE_KIND = `${SHACL}nodeKind` as IRI;
const SH_CLASS = `${SHACL}class` as IRI;
const SH_PATTERN = `${SHACL}pattern` as IRI;
const SH_HAS_VALUE = `${SHACL}hasValue` as IRI;
const SH_MESSAGE = `${SHACL}message` as IRI;
const SH_IN = `${SHACL}in` as IRI;
const SH_CLOSED = `${SHACL}closed` as IRI;
const SH_NODE = `${SHACL}node` as IRI;
const SH_QUALIFIED_VALUE_SHAPE = `${SHACL}qualifiedValueShape` as IRI;
const SH_QUALIFIED_MIN_COUNT = `${SHACL}qualifiedMinCount` as IRI;
const SH_QUALIFIED_MAX_COUNT = `${SHACL}qualifiedMaxCount` as IRI;
const SH_TARGET_SUBJECTS_OF = `${SHACL}targetSubjectsOf` as IRI;
const SH_TARGET_OBJECTS_OF = `${SHACL}targetObjectsOf` as IRI;
const SH_DEACTIVATED = `${SHACL}deactivated` as IRI;
const SH_SEVERITY = `${SHACL}severity` as IRI;
const SH_MIN_INCLUSIVE = `${SHACL}minInclusive` as IRI;
const SH_MAX_INCLUSIVE = `${SHACL}maxInclusive` as IRI;
const SH_MIN_EXCLUSIVE = `${SHACL}minExclusive` as IRI;
const SH_MAX_EXCLUSIVE = `${SHACL}maxExclusive` as IRI;
const SH_MIN_LENGTH = `${SHACL}minLength` as IRI;
const SH_MAX_LENGTH = `${SHACL}maxLength` as IRI;
const SH_LANGUAGE_IN = `${SHACL}languageIn` as IRI;
const SH_UNIQUE_LANG = `${SHACL}uniqueLang` as IRI;
const SH_EQUALS = `${SHACL}equals` as IRI;
const SH_DISJOINT = `${SHACL}disjoint` as IRI;
const SH_LESS_THAN = `${SHACL}lessThan` as IRI;
const SH_LESS_THAN_OR_EQUALS = `${SHACL}lessThanOrEquals` as IRI;
const SH_IGNORED_PROPERTIES = `${SHACL}ignoredProperties` as IRI;

const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first' as IRI;
const RDF_REST  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest'  as IRI;
const RDF_NIL   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil'   as IRI;

/**
 * Walk an rdf:List starting at `head` and return its members in
 * order. Tolerates the three common shapes any of which sh:in can
 * arrive in:
 *
 *   1. Turtle Collection: `sh:in ( "X" "O" )` — the parser desugars
 *      this into a head bnode whose rdf:first/rdf:rest chain we walk.
 *   2. Turtle comma-list:  `sh:in "X", "O"` — predicate has multiple
 *      objects directly; no list to walk, each object IS a value.
 *   3. Single value:       `sh:in "X"` — one object, treated as a
 *      one-element list.
 *
 * The SHACL spec MANDATES form (1) — `sh:in` takes an rdf:List. Form
 * (2) was accepted by an earlier comment in this file ("parsed as
 * comma list") because the parser didn't support Collections; we now
 * accept both so existing comma-form shapes don't regress.
 *
 * Returns the empty array on rdf:nil OR on a malformed list (e.g.
 * a bnode head with no rdf:first). Cycle-safe: bounded to 1024 hops.
 */
function walkRdfList(
  doc: ParsedDocument,
  head: ParsedTerm,
): readonly ParsedTerm[] {
  if (head.kind === 'iri' && head.iri === RDF_NIL) return [];
  // Form (1) — Collection: head is a bnode pointing at an rdf:first/rdf:rest chain.
  if (head.kind === 'bnode') {
    const out: ParsedTerm[] = [];
    let cursor: ParsedTerm = head;
    const seen = new Set<string>();
    for (let i = 0; i < 1024; i++) {
      if (cursor.kind === 'iri' && cursor.iri === RDF_NIL) return out;
      if (cursor.kind !== 'bnode') return out;
      if (seen.has(cursor.id)) return out;
      seen.add(cursor.id);
      const cell = doc.subjects.find(s =>
        typeof s.subject === 'object' && 'bnode' in s.subject && s.subject.bnode === (cursor as { kind: 'bnode'; id: string }).id,
      );
      if (!cell) return out;
      const first = cell.properties.get(RDF_FIRST)?.[0];
      const rest = cell.properties.get(RDF_REST)?.[0];
      if (!first) return out; // malformed cell — abort cleanly
      out.push(first);
      if (!rest) return out;
      cursor = rest;
    }
    return out;
  }
  // Form (2) / (3) — head is itself a value (literal or IRI), not a list head.
  return [head];
}

const SH_IRI = `${SHACL}IRI` as IRI;
const SH_LITERAL = `${SHACL}Literal` as IRI;
const SH_BLANK_NODE = `${SHACL}BlankNode` as IRI;
const SH_BLANK_NODE_OR_IRI = `${SHACL}BlankNodeOrIRI` as IRI;

export type ShaclSeverity = 'Violation' | 'Warning' | 'Info';

export interface ShaclResult {
  readonly focusNode: string;
  readonly path?: string;
  readonly value?: string;
  readonly sourceShape?: string;
  readonly constraintComponent: string;
  readonly severity: ShaclSeverity;
  readonly message: string;
}

export interface ShaclReport {
  readonly conforms: boolean;
  readonly results: readonly ShaclResult[];
}

export interface ValidateAgainstShapeOptions {
  /**
   * RDFS entailment knob — when 'rdfs', the validator treats values
   * whose declared rdf:type is a subclass of the constraint's sh:class
   * as conformant. We don't load external class hierarchies, so the
   * check stays direct-type. Provided for API parity with rdf-validate-
   * shacl.
   */
  readonly entailment?: 'none' | 'rdfs';
}

interface PropertyShape {
  readonly id: string;
  readonly path: IRI;
  readonly minCount?: number;
  readonly maxCount?: number;
  readonly datatype?: IRI;
  readonly nodeKind?: IRI;
  readonly clazz?: IRI;
  readonly pattern?: string;
  readonly hasValue?: ParsedTerm;
  readonly inValues?: readonly ParsedTerm[];
  readonly message?: string;
  // ── value range. Numeric comparison on the lexical form's numeric value. ──
  readonly minInclusive?: number;
  readonly maxInclusive?: number;
  readonly minExclusive?: number;
  readonly maxExclusive?: number;
  // ── string ──
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly languageIn?: readonly string[];
  readonly uniqueLang?: boolean;
  // ── property pairs: compare this path's values against another path's on the SAME
  //    focus node. Needed because a constraint like "validFrom lessThan validUntil"
  //    cannot be expressed on either property alone. ──
  readonly equals?: IRI;
  readonly disjoint?: IRI;
  readonly lessThan?: IRI;
  readonly lessThanOrEquals?: IRI;
  /** sh:deactivated on a property shape. */
  readonly deactivated?: boolean;
  /** sh:severity on a property shape, overriding the node shape's. */
  readonly severity?: ShaclSeverity;
  /**
   * sh:node — every value must itself conform to the referenced node shape.
   *
   * ★ THIS IS THE COMPOSITION PRIMITIVE. Without it a shape can only describe values
   * shallowly (a datatype, a class, a count) and every structural contract has to be
   * restated inline. With it, an L1 shape can be REFERENCED by an L3 vertical rather
   * than duplicated — which is what makes shapes composable across layers at all.
   */
  readonly node?: string;
  /** sh:qualifiedValueShape + counts: how many values conform to a nested shape. */
  readonly qualifiedValueShape?: string;
  readonly qualifiedMinCount?: number;
  readonly qualifiedMaxCount?: number;
}

interface NodeShape {
  readonly id: string;
  readonly targetClasses: readonly IRI[];
  readonly targetNodes: readonly IRI[];
  readonly propertyShapes: readonly PropertyShape[];
  /**
   * sh:closed — the focus node may carry NO predicate other than those its property
   * shapes declare (plus sh:ignoredProperties).
   *
   * ★ WHY THIS IS DIFFERENT IN KIND FROM EVERY OTHER CONSTRAINT HERE. The rest of this
   * engine answers "is what IS here acceptable?". Closed-world is the only one that can
   * answer "is anything here that should NOT be?" — and that is the only question that
   * can enforce a guarantee about content a shape's author never anticipated. An
   * enumerated denylist can refuse the predicates you thought of; sh:closed refuses the
   * ones you did not, which is the whole point when a shape exists to keep sensitive
   * fields off a published graph.
   */
  readonly closed: boolean;
  /** sh:targetSubjectsOf — every subject that has this predicate. */
  readonly targetSubjectsOf: readonly IRI[];
  /** sh:targetObjectsOf — every node appearing as the OBJECT of this predicate. */
  readonly targetObjectsOf: readonly IRI[];
  /**
   * sh:deactivated — the shape is switched off and MUST NOT produce results.
   * Previously unread, so a shape its author had explicitly disabled still fired: not a
   * missing feature but a wrong answer, and the only entry in this file that was
   * fail-CLOSED in the harmful direction.
   */
  readonly deactivated: boolean;
  /**
   * ★ NODE-LEVEL value constraints, applied to the FOCUS NODE itself rather than to the
   * values of a path. Needed because SHACL's usual way to write "exactly one facet of
   * type X" is an INLINE shape in a shape-expecting position:
   *
   *     sh:qualifiedValueShape [ sh:class iep:TemporalFacet ] ; sh:qualifiedMinCount 1
   *
   * The bracket is a node shape with no sh:path and no rdf:type. Without node-level
   * constraints it compiles to a shape with zero requirements, every value trivially
   * conforms, and the count is always satisfied — so L1's core "MUST have exactly one
   * TemporalFacet / ProvenanceFacet / AgentFacet" rules enforced nothing at all.
   */
  readonly nodeClass?: IRI;
  readonly nodeDatatype?: IRI;
  readonly nodeKindConstraint?: IRI;
  readonly nodeIn?: readonly ParsedTerm[];
  /** sh:severity — defaults to Violation. Unread before, so a shape declaring
   *  sh:Warning had its findings counted as conformance failures. */
  readonly severity: ShaclSeverity;
  /** Predicates permitted despite sh:closed. rdf:type is NOT implicit — SHACL requires
   *  it to be listed explicitly, and shape authors reliably forget, so violations name it. */
  readonly ignoredProperties: readonly IRI[];
}

// ── Shape graph compilation ──────────────────────────────────

function asIri(term: ParsedTerm | undefined): IRI | undefined {
  return term?.kind === 'iri' ? term.iri : undefined;
}

function asLiteral(term: ParsedTerm | undefined): string | undefined {
  return term?.kind === 'literal' ? term.value : undefined;
}

function getOne(subj: ParsedSubject, pred: IRI): ParsedTerm | undefined {
  return subj.properties.get(pred)?.[0];
}

function getAll(subj: ParsedSubject, pred: IRI): readonly ParsedTerm[] {
  return subj.properties.get(pred) ?? [];
}

function subjectKey(subj: ParsedSubject): string {
  return typeof subj.subject === 'string' ? subj.subject : `_:${subj.subject.bnode}`;
}

function isShape(subj: ParsedSubject): boolean {
  const types = subj.properties.get(RDF_TYPE) ?? [];
  return types.some(t => t.kind === 'iri' && (t.iri === SH_NODE_SHAPE || t.iri === SH_PROPERTY_SHAPE));
}

function compilePropertyShape(doc: ParsedDocument, subj: ParsedSubject): PropertyShape | null {
  const path = asIri(getOne(subj, SH_PATH));
  if (!path) return null;
  const minCountLit = asLiteral(getOne(subj, SH_MIN_COUNT));
  const maxCountLit = asLiteral(getOne(subj, SH_MAX_COUNT));
  // sh:in resolution: every object under sh:in is either
  //   - the head of an rdf:List (Turtle Collection form), or
  //   - a direct value (comma form / single value).
  // walkRdfList handles all three; flatten so the engine's downstream
  // termsEqual sweep sees a flat allowed-value set regardless of how
  // the shape author wrote it.
  const rawIn = getAll(subj, SH_IN);
  const inValues: ParsedTerm[] = [];
  for (const head of rawIn) {
    for (const v of walkRdfList(doc, head)) inValues.push(v);
  }
  return {
    id: subjectKey(subj),
    path,
    minCount: minCountLit !== undefined ? parseInt(minCountLit, 10) : undefined,
    maxCount: maxCountLit !== undefined ? parseInt(maxCountLit, 10) : undefined,
    datatype: asIri(getOne(subj, SH_DATATYPE)),
    nodeKind: asIri(getOne(subj, SH_NODE_KIND)),
    clazz: asIri(getOne(subj, SH_CLASS)),
    pattern: asLiteral(getOne(subj, SH_PATTERN)),
    hasValue: getOne(subj, SH_HAS_VALUE),
    inValues,
    message: asLiteral(getOne(subj, SH_MESSAGE)),
    minInclusive: num(getOne(subj, SH_MIN_INCLUSIVE)),
    maxInclusive: num(getOne(subj, SH_MAX_INCLUSIVE)),
    minExclusive: num(getOne(subj, SH_MIN_EXCLUSIVE)),
    maxExclusive: num(getOne(subj, SH_MAX_EXCLUSIVE)),
    minLength: num(getOne(subj, SH_MIN_LENGTH)),
    maxLength: num(getOne(subj, SH_MAX_LENGTH)),
    languageIn: (() => {
      const tags: string[] = [];
      for (const head of getAll(subj, SH_LANGUAGE_IN)) {
        for (const v of walkRdfList(doc, head)) {
          if (v.kind === 'literal') tags.push(v.value);
        }
      }
      return tags.length > 0 ? tags : undefined;
    })(),
    uniqueLang: (() => {
      const t = getOne(subj, SH_UNIQUE_LANG);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
    node: refKey(getOne(subj, SH_NODE)),
    qualifiedValueShape: refKey(getOne(subj, SH_QUALIFIED_VALUE_SHAPE)),
    qualifiedMinCount: num(getOne(subj, SH_QUALIFIED_MIN_COUNT)),
    qualifiedMaxCount: num(getOne(subj, SH_QUALIFIED_MAX_COUNT)),
    equals: asIri(getOne(subj, SH_EQUALS)),
    disjoint: asIri(getOne(subj, SH_DISJOINT)),
    lessThan: asIri(getOne(subj, SH_LESS_THAN)),
    lessThanOrEquals: asIri(getOne(subj, SH_LESS_THAN_OR_EQUALS)),
    deactivated: (() => {
      const t = getOne(subj, SH_DEACTIVATED);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
    severity: (() => {
      const iri = asIri(getOne(subj, SH_SEVERITY));
      return iri === `${SHACL}Warning` ? 'Warning'
        : iri === `${SHACL}Info` ? 'Info'
        : iri === `${SHACL}Violation` ? 'Violation' : undefined;
    })(),
  };
}

/** Key a shape reference the same way subjectKey does, so IRIs and bnodes both resolve. */
function refKey(t: ParsedTerm | undefined): string | undefined {
  if (!t) return undefined;
  if (t.kind === 'iri') return t.iri;
  if (t.kind === 'bnode') return `_:${t.id}`;
  return undefined;
}

/** Numeric value of a literal, or undefined. Non-numeric lexical forms are not an
 *  error here — they simply do not participate in a numeric range check. */
function num(t: ParsedTerm | undefined): number | undefined {
  if (t?.kind !== 'literal') return undefined;
  const n = Number(t.value);
  return Number.isFinite(n) ? n : undefined;
}

function compileShapes(doc: ParsedDocument): readonly NodeShape[] {
  const nodeShapes: NodeShape[] = [];
  const propertyShapesByKey = new Map<string, ParsedSubject>();
  for (const subj of doc.subjects) {
    propertyShapesByKey.set(subjectKey(subj), subj);
  }

  // ★ SHACL treats a node in a shape-EXPECTING position as a shape even without an
  // explicit rdf:type. `sh:qualifiedValueShape [ sh:class X ]` is the idiomatic spelling,
  // and it is exactly how L1's own iep-shapes.ttl writes its facet-cardinality rules — so
  // requiring rdf:type silently discarded them.
  const inlineShapeKeys = new Set<string>();
  for (const subj of doc.subjects) {
    for (const pred of [SH_NODE, SH_QUALIFIED_VALUE_SHAPE]) {
      for (const t of subj.properties.get(pred) ?? []) {
        const k = refKey(t);
        if (k !== undefined) inlineShapeKeys.add(k);
      }
    }
  }

  for (const subj of doc.subjects) {
    if (!isShape(subj) && !inlineShapeKeys.has(subjectKey(subj))) continue;
    const types = (subj.properties.get(RDF_TYPE) ?? []).filter(t => t.kind === 'iri') as { kind: 'iri'; iri: IRI }[];
    const isProperty = types.some(t => t.iri === SH_PROPERTY_SHAPE);
    // A property-shape declared standalone is not a node shape itself.
    if (isProperty && !types.some(t => t.iri === SH_NODE_SHAPE)) continue;

    const targetClasses = getAll(subj, SH_TARGET_CLASS)
      .map(t => asIri(t))
      .filter((x): x is IRI => x !== undefined);
    const targetNodes = getAll(subj, SH_TARGET_NODE)
      .map(t => asIri(t))
      .filter((x): x is IRI => x !== undefined);
    const propertyShapeRefs = getAll(subj, SH_PROPERTY);

    const propertyShapes: PropertyShape[] = [];
    for (const ref of propertyShapeRefs) {
      if (ref.kind === 'iri') {
        const target = propertyShapesByKey.get(ref.iri);
        if (target) {
          const ps = compilePropertyShape(doc, target);
          if (ps) propertyShapes.push(ps);
        }
      } else if (ref.kind === 'bnode') {
        const target = propertyShapesByKey.get(`_:${ref.id}`);
        if (target) {
          const ps = compilePropertyShape(doc, target);
          if (ps) propertyShapes.push(ps);
        }
      }
    }

    // sh:closed is `true` only when literally "true" — anything else (absent, "false",
    // a stray IRI) leaves the shape OPEN. Fail-open is correct here and only here:
    // silently closing a shape its author did not close would reject valid data across
    // the whole federation.
    const closedTerm = getOne(subj, SH_CLOSED);
    const closed = closedTerm?.kind === 'literal' && closedTerm.value === 'true';
    const ignoredProperties: IRI[] = [];
    for (const head of getAll(subj, SH_IGNORED_PROPERTIES)) {
      for (const v of walkRdfList(doc, head)) {
        const iri = asIri(v);
        if (iri) ignoredProperties.push(iri);
      }
    }

    const targetSubjectsOf = getAll(subj, SH_TARGET_SUBJECTS_OF)
      .map(t => asIri(t)).filter((x): x is IRI => x !== undefined);
    const targetObjectsOf = getAll(subj, SH_TARGET_OBJECTS_OF)
      .map(t => asIri(t)).filter((x): x is IRI => x !== undefined);
    const deactivatedTerm = getOne(subj, SH_DEACTIVATED);
    const deactivated = deactivatedTerm?.kind === 'literal' && deactivatedTerm.value === 'true';
    const nodeIn: ParsedTerm[] = [];
    for (const head of getAll(subj, SH_IN)) for (const v of walkRdfList(doc, head)) nodeIn.push(v);
    const sevIri = asIri(getOne(subj, SH_SEVERITY));
    const severity: ShaclSeverity = sevIri === `${SHACL}Warning` ? 'Warning'
      : sevIri === `${SHACL}Info` ? 'Info' : 'Violation';

    nodeShapes.push({
      id: subjectKey(subj),
      targetClasses,
      targetNodes,
      propertyShapes,
      closed,
      ignoredProperties,
      targetSubjectsOf,
      targetObjectsOf,
      deactivated,
      severity,
      nodeClass: asIri(getOne(subj, SH_CLASS)),
      nodeDatatype: asIri(getOne(subj, SH_DATATYPE)),
      nodeKindConstraint: asIri(getOne(subj, SH_NODE_KIND)),
      ...(nodeIn.length > 0 ? { nodeIn } : {}),
    });
  }
  return nodeShapes;
}

// ── Data graph indexing ──────────────────────────────────────

function findFocusNodes(data: ParsedDocument, shape: NodeShape): readonly ParsedSubject[] {
  const matched: ParsedSubject[] = [];
  const seen = new Set<string>();
  for (const cls of shape.targetClasses) {
    for (const s of findSubjectsOfType(data, cls)) {
      const key = subjectKey(s);
      if (!seen.has(key)) {
        seen.add(key);
        matched.push(s);
      }
    }
  }
  for (const node of shape.targetNodes) {
    for (const s of data.subjects) {
      if (typeof s.subject === 'string' && s.subject === node) {
        const key = subjectKey(s);
        if (!seen.has(key)) {
          seen.add(key);
          matched.push(s);
        }
      }
    }
  }
  // sh:targetSubjectsOf — every subject carrying the named predicate.
  // ★ Three of this repo's own published shapes target this way. Unimplemented, they
  // selected NO focus nodes and therefore passed vacuously: a published contract that
  // enforced nothing while reading as though it did.
  for (const pred of shape.targetSubjectsOf) {
    for (const s of data.subjects) {
      if (!s.properties.has(pred)) continue;
      const key = subjectKey(s);
      if (!seen.has(key)) { seen.add(key); matched.push(s); }
    }
  }
  // sh:targetObjectsOf — every node appearing as the OBJECT of the named predicate.
  // Only nodes that are themselves described in the graph can be focus nodes; an object
  // with no outgoing statements has nothing to validate.
  if (shape.targetObjectsOf.length > 0) {
    const wanted = new Set<string>();
    for (const pred of shape.targetObjectsOf) {
      for (const s of data.subjects) {
        for (const t of s.properties.get(pred) ?? []) {
          if (t.kind === 'iri') wanted.add(t.iri);
          else if (t.kind === 'bnode') wanted.add(`_:${t.id}`);
        }
      }
    }
    for (const s of data.subjects) {
      const key = subjectKey(s);
      if (wanted.has(key) && !seen.has(key)) { seen.add(key); matched.push(s); }
    }
  }
  return matched;
}

function termValue(t: ParsedTerm): string {
  if (t.kind === 'iri') return t.iri;
  if (t.kind === 'literal') return t.value;
  return `_:${t.id}`;
}

function termsEqual(a: ParsedTerm, b: ParsedTerm): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'iri' && b.kind === 'iri') return a.iri === b.iri;
  if (a.kind === 'literal' && b.kind === 'literal') {
    return a.value === b.value && a.datatype === b.datatype && a.language === b.language;
  }
  if (a.kind === 'bnode' && b.kind === 'bnode') return a.id === b.id;
  return false;
}

function matchesNodeKind(t: ParsedTerm, kind: IRI): boolean {
  switch (kind) {
    case SH_IRI: return t.kind === 'iri';
    case SH_LITERAL: return t.kind === 'literal';
    case SH_BLANK_NODE: return t.kind === 'bnode';
    case SH_BLANK_NODE_OR_IRI: return t.kind === 'iri' || t.kind === 'bnode';
    default: return true;
  }
}

function matchesDatatype(t: ParsedTerm, datatype: IRI): boolean {
  if (t.kind !== 'literal') return false;
  if (t.datatype) return t.datatype === datatype;
  // Untyped literals are xsd:string by RDF semantics.
  return datatype === (`${XSD}string` as IRI);
}

function valueHasClass(data: ParsedDocument, valueTerm: ParsedTerm, expectedClass: IRI): boolean {
  // Locate the subject in the data graph whose key matches the value.
  const key = valueTerm.kind === 'iri'
    ? valueTerm.iri
    : valueTerm.kind === 'bnode'
      ? `_:${valueTerm.id}`
      : null;
  if (!key) return false;
  for (const s of data.subjects) {
    if (subjectKey(s) !== key) continue;
    const types = s.properties.get(RDF_TYPE) ?? [];
    for (const t of types) {
      if (t.kind === 'iri' && t.iri === expectedClass) return true;
    }
  }
  return false;
}

// ── Validation ───────────────────────────────────────────────

/**
 * Does `subj` conform to `target`? The recursion behind sh:node and
 * sh:qualifiedValueShape — and therefore behind shape COMPOSITION.
 *
 * Depth-bounded rather than cycle-detected: a self-referencing shape graph is legal
 * SHACL (a linked list, a tree), and the honest failure for an unbounded one is to stop
 * rather than hang. Only Violations count — a Warning is not non-conformance.
 */
function conformsToShape(
  data: ParsedDocument,
  subj: ParsedSubject,
  target: NodeShape,
  byId: ReadonlyMap<string, NodeShape>,
  depth: number,
): boolean {
  if (depth > 12) return true;
  if (target.deactivated) return true;
  // Node-level value constraints apply to the focus node itself.
  if (target.nodeClass !== undefined) {
    const types = subj.properties.get(RDF_TYPE) ?? [];
    if (!types.some(t => t.kind === 'iri' && t.iri === target.nodeClass)) return false;
  }
  if (target.nodeKindConstraint !== undefined) {
    const asTerm: ParsedTerm = typeof subj.subject === 'string'
      ? { kind: 'iri', iri: subj.subject }
      : { kind: 'bnode', id: subj.subject.bnode };
    if (!matchesNodeKind(asTerm, target.nodeKindConstraint)) return false;
  }
  for (const ps of target.propertyShapes) {
    if (evaluatePropertyShape(data, subj, target, ps, byId, depth + 1)
      .some(r => r.severity === 'Violation')) return false;
  }
  if (target.closed) {
    const declared = new Set<string>(target.propertyShapes.map(x => x.path));
    for (const ign of target.ignoredProperties) declared.add(ign);
    for (const predicate of subj.properties.keys()) {
      if (!declared.has(predicate)) return false;
    }
  }
  return true;
}

/**
 * Resolve a term to the subject describing it, so a shape can be applied to it.
 *
 * ★ INDEXED, NOT SCANNED. The obvious implementation is
 * `data.subjects.find(x => subjectKey(x) === key)`, and it is accidentally quadratic:
 * sh:node and sh:qualifiedValueShape call this for EVERY value, of EVERY property shape,
 * at EVERY recursion depth. Written that way it pushed two existing suites past their
 * 5s timeout the moment those constraints started actually running. The index is built
 * once per document and memoised on it.
 */
const SUBJECT_INDEX = new WeakMap<ParsedDocument, Map<string, ParsedSubject>>();
function subjectFor(data: ParsedDocument, t: ParsedTerm): ParsedSubject | undefined {
  const key = t.kind === 'iri' ? t.iri : t.kind === 'bnode' ? `_:${t.id}` : undefined;
  if (key === undefined) return undefined;
  let idx = SUBJECT_INDEX.get(data);
  if (!idx) {
    idx = new Map<string, ParsedSubject>();
    for (const x of data.subjects) idx.set(subjectKey(x), x);
    SUBJECT_INDEX.set(data, idx);
  }
  return idx.get(key);
}

function evaluatePropertyShape(
  data: ParsedDocument,
  focus: ParsedSubject,
  shape: NodeShape,
  ps: PropertyShape,
  /** Shape index for resolving sh:node / sh:qualifiedValueShape references. */
  byId?: ReadonlyMap<string, NodeShape>,
  depth = 0,
): ShaclResult[] {
  const results: ShaclResult[] = [];
  // A property shape its author deactivated must produce nothing, exactly as for a
  // deactivated node shape.
  if (ps.deactivated) return results;
  const values = focus.properties.get(ps.path) ?? [];
  const focusNode = subjectKey(focus);
  /** Severity for THIS shape: the property shape's own, else the node shape's. */
  const sev: ShaclSeverity = ps.severity ?? shape.severity;
  const fail = (path: IRI, component: string, message: string, value?: ParsedTerm): void => {
    results.push({
      focusNode, path, sourceShape: shape.id,
      constraintComponent: `${SHACL}${component}`,
      severity: sev, message,
      ...(value !== undefined ? { value: termValue(value) } : {}),
    });
  };

  // ── value range ────────────────────────────────────────────────────
  for (const v of values) {
    if (v.kind !== 'literal') continue;
    const n = Number(v.value);
    if (!Number.isFinite(n)) continue;   // non-numeric literals do not participate
    if (ps.minInclusive !== undefined && n < ps.minInclusive) {
      fail(ps.path, 'MinInclusiveConstraintComponent', `Value ${n} is less than sh:minInclusive ${ps.minInclusive}`, v);
    }
    if (ps.maxInclusive !== undefined && n > ps.maxInclusive) {
      fail(ps.path, 'MaxInclusiveConstraintComponent', `Value ${n} is greater than sh:maxInclusive ${ps.maxInclusive}`, v);
    }
    if (ps.minExclusive !== undefined && n <= ps.minExclusive) {
      fail(ps.path, 'MinExclusiveConstraintComponent', `Value ${n} is not greater than sh:minExclusive ${ps.minExclusive}`, v);
    }
    if (ps.maxExclusive !== undefined && n >= ps.maxExclusive) {
      fail(ps.path, 'MaxExclusiveConstraintComponent', `Value ${n} is not less than sh:maxExclusive ${ps.maxExclusive}`, v);
    }
  }

  // ── string ─────────────────────────────────────────────────────────
  for (const v of values) {
    // SHACL: length applies to the lexical form; an IRI has one too.
    const lex = v.kind === 'literal' ? v.value : v.kind === 'iri' ? v.iri : undefined;
    if (lex !== undefined) {
      if (ps.minLength !== undefined && lex.length < ps.minLength) {
        fail(ps.path, 'MinLengthConstraintComponent', `Value is shorter than sh:minLength ${ps.minLength}`, v);
      }
      if (ps.maxLength !== undefined && lex.length > ps.maxLength) {
        fail(ps.path, 'MaxLengthConstraintComponent', `Value is longer than sh:maxLength ${ps.maxLength}`, v);
      }
    }
    if (ps.languageIn && v.kind === 'literal') {
      const tag = (v.language ?? '').toLowerCase();
      // BCP-47 basic filtering: "en" permits "en-GB".
      const ok = ps.languageIn.some(w => {
        const want = w.toLowerCase();
        return tag === want || tag.startsWith(want + '-');
      });
      if (!ok) {
        fail(ps.path, 'LanguageInConstraintComponent', `Language tag "${v.language ?? ''}" is not in sh:languageIn`, v);
      }
    }
  }
  if (ps.uniqueLang) {
    const seenLang = new Set<string>();
    for (const v of values) {
      if (v.kind !== 'literal' || !v.language) continue;
      const tag = v.language.toLowerCase();
      if (seenLang.has(tag)) {
        fail(ps.path, 'UniqueLangConstraintComponent', `Language "${v.language}" appears more than once`, v);
      }
      seenLang.add(tag);
    }
  }

  // ── property pairs — compare against another path on the SAME focus node ──
  // These cannot be expressed on either property alone, which is why a constraint like
  // "validFrom must precede validUntil" had no way to be stated before.
  {
    const other = (pred: IRI): readonly ParsedTerm[] => focus.properties.get(pred) ?? [];
    if (ps.equals) {
      const o = other(ps.equals);
      const missing = values.filter(v => !o.some(x => termsEqual(v, x)))
        .concat(o.filter(x => !values.some(v => termsEqual(v, x))));
      for (const v of missing) {
        fail(ps.path, 'EqualsConstraintComponent', `Values must equal those of ${ps.equals}`, v);
      }
    }
    if (ps.disjoint) {
      for (const v of values) {
        if (other(ps.disjoint).some(x => termsEqual(v, x))) {
          fail(ps.path, 'DisjointConstraintComponent', `Value must not also appear under ${ps.disjoint}`, v);
        }
      }
    }
    const cmp = (a: ParsedTerm, b: ParsedTerm): number | undefined => {
      if (a.kind !== 'literal' || b.kind !== 'literal') return undefined;
      const na = Number(a.value); const nb = Number(b.value);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb ? 0 : na < nb ? -1 : 1;
      return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;   // lexicographic fallback
    };
    if (ps.lessThan) {
      for (const v of values) for (const x of other(ps.lessThan)) {
        const c = cmp(v, x);
        if (c !== undefined && c >= 0) {
          fail(ps.path, 'LessThanConstraintComponent', `Value must be less than every value of ${ps.lessThan}`, v);
        }
      }
    }
    if (ps.lessThanOrEquals) {
      for (const v of values) for (const x of other(ps.lessThanOrEquals)) {
        const c = cmp(v, x);
        if (c !== undefined && c > 0) {
          fail(ps.path, 'LessThanOrEqualsConstraintComponent', `Value must be <= every value of ${ps.lessThanOrEquals}`, v);
        }
      }
    }
  }

  // ── shape-based: sh:node and sh:qualifiedValueShape (composition) ──
  if (byId) {
    if (ps.node) {
      const target = byId.get(ps.node);
      if (target) {
        for (const v of values) {
          const sub = subjectFor(data, v);
          // A value with no description cannot satisfy a shape that requires anything.
          const ok = sub ? conformsToShape(data, sub, target, byId, depth) : target.propertyShapes.length === 0;
          if (!ok) {
            fail(ps.path, 'NodeConstraintComponent', `Value does not conform to sh:node ${ps.node}`, v);
          }
        }
      }
    }
    if (ps.qualifiedValueShape && (ps.qualifiedMinCount !== undefined || ps.qualifiedMaxCount !== undefined)) {
      const target = byId.get(ps.qualifiedValueShape);
      if (target) {
        let n = 0;
        for (const v of values) {
          const sub = subjectFor(data, v);
          if (sub ? conformsToShape(data, sub, target, byId, depth) : target.propertyShapes.length === 0) n++;
        }
        if (ps.qualifiedMinCount !== undefined && n < ps.qualifiedMinCount) {
          fail(ps.path, 'QualifiedMinCountConstraintComponent',
            `Only ${n} value(s) conform to sh:qualifiedValueShape; sh:qualifiedMinCount is ${ps.qualifiedMinCount}`);
        }
        if (ps.qualifiedMaxCount !== undefined && n > ps.qualifiedMaxCount) {
          fail(ps.path, 'QualifiedMaxCountConstraintComponent',
            `${n} value(s) conform to sh:qualifiedValueShape; sh:qualifiedMaxCount is ${ps.qualifiedMaxCount}`);
        }
      }
    }
  }

  if (ps.minCount !== undefined && values.length < ps.minCount) {
    results.push({
      focusNode,
      path: ps.path,
      sourceShape: shape.id,
      constraintComponent: `${SHACL}MinCountConstraintComponent`,
      severity: 'Violation',
      message: ps.message ?? `Value count ${values.length} is below sh:minCount ${ps.minCount} for ${ps.path}`,
    });
  }
  if (ps.maxCount !== undefined && values.length > ps.maxCount) {
    results.push({
      focusNode,
      path: ps.path,
      sourceShape: shape.id,
      constraintComponent: `${SHACL}MaxCountConstraintComponent`,
      severity: 'Violation',
      message: ps.message ?? `Value count ${values.length} exceeds sh:maxCount ${ps.maxCount} for ${ps.path}`,
    });
  }

  for (const v of values) {
    if (ps.nodeKind && !matchesNodeKind(v, ps.nodeKind)) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: shape.id,
        constraintComponent: `${SHACL}NodeKindConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Value does not match sh:nodeKind ${ps.nodeKind}`,
      });
    }
    if (ps.datatype && !matchesDatatype(v, ps.datatype)) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: shape.id,
        constraintComponent: `${SHACL}DatatypeConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Value does not match sh:datatype ${ps.datatype}`,
      });
    }
    if (ps.clazz && !valueHasClass(data, v, ps.clazz)) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: shape.id,
        constraintComponent: `${SHACL}ClassConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Value is not an instance of sh:class ${ps.clazz}`,
      });
    }
    if (ps.pattern && v.kind === 'literal') {
      try {
        const re = new RegExp(ps.pattern);
        if (!re.test(v.value)) {
          results.push({
            focusNode,
            path: ps.path,
            value: termValue(v),
            sourceShape: shape.id,
            constraintComponent: `${SHACL}PatternConstraintComponent`,
            severity: 'Violation',
            message: ps.message ?? `Value does not match sh:pattern /${ps.pattern}/`,
          });
        }
      } catch {
        // Malformed regex in shape — skip rather than crash the gate.
      }
    }
    if (ps.inValues && ps.inValues.length > 0) {
      if (!ps.inValues.some(allowed => termsEqual(allowed, v))) {
        results.push({
          focusNode,
          path: ps.path,
          value: termValue(v),
          sourceShape: shape.id,
          constraintComponent: `${SHACL}InConstraintComponent`,
          severity: 'Violation',
          message: ps.message ?? `Value is not in the sh:in enumeration`,
        });
      }
    }
  }

  if (ps.hasValue) {
    const present = values.some(v => termsEqual(v, ps.hasValue!));
    if (!present) {
      results.push({
        focusNode,
        path: ps.path,
        sourceShape: shape.id,
        constraintComponent: `${SHACL}HasValueConstraintComponent`,
        severity: 'Violation',
        message: ps.message ?? `Required sh:hasValue ${termValue(ps.hasValue)} is missing`,
      });
    }
  }

  return results;
}

/**
 * Validate a data graph (Turtle/TriG string) against a SHACL shape graph
 * (Turtle string).
 *
 * Returns a SHACL-style ValidationReport with conforms + results. Bad
 * input (unparseable shape graph) is treated as "no constraints to
 * check" → conforms: true, no results. Bad data is treated as
 * "conforms" only when there are zero matching focus nodes for any
 * shape — that is the correct SHACL semantics (a shape with no targets
 * trivially conforms).
 */
export function validateAgainstShape(
  dataTurtle: string,
  shapeTurtle: string,
  options: ValidateAgainstShapeOptions = {},
): ShaclReport {
  let shapeDoc: ParsedDocument;
  try {
    shapeDoc = parseTrig(shapeTurtle);
  } catch (err) {
    // Silent vacuous-pass on shape parse failure was the actual cause
    // of the f-shin-collection finding: a shape containing
    // `sh:in ( "X" "O" )` (RDF Collection form) tripped the parser,
    // got caught here, and turned the shape into a no-op — every
    // value passed. Now we surface the failure as a Violation so the
    // gate REJECTS the publish and the operator sees why. (Existing
    // callers that fetched an unparseable shape and expected "no
    // constraints, no problem" now get a structured rejection, which
    // is the substrate-honest behavior — a shape the engine can't
    // read can't be relied on as a gate.)
    return {
      conforms: false,
      results: [{
        focusNode: '',
        constraintComponent: `${SHACL}ShapeGraphParseFailure`,
        severity: 'Violation',
        message: `Shape graph is not parseable as Turtle/TriG: ${(err as Error).message}`,
      }],
    };
  }
  let dataDoc: ParsedDocument;
  try {
    dataDoc = parseTrig(dataTurtle);
  } catch {
    return {
      conforms: false,
      results: [{
        focusNode: '',
        constraintComponent: `${SHACL}DataGraphParseFailure`,
        severity: 'Violation',
        message: 'Data graph is not parseable as Turtle/TriG',
      }],
    };
  }

  // entailment is reserved for parity with rdf-validate-shacl; the
  // direct-type check is what the kernel ships. Mark it used to keep
  // strict-null TS happy.
  void options.entailment;

  const shapes = compileShapes(shapeDoc);
  // Shape references (sh:node, sh:qualifiedValueShape) resolve through this index.
  // Built from ALL compiled shapes, so a referenced shape need not have its own target.
  const byId = new Map<string, NodeShape>();
  for (const sh of shapes) byId.set(sh.id, sh);

  const results: ShaclResult[] = [];
  for (const shape of shapes) {
    // sh:deactivated — a shape switched off by its author MUST produce no results.
    if (shape.deactivated) continue;
    const focusNodes = findFocusNodes(dataDoc, shape);
    for (const focus of focusNodes) {
      for (const ps of shape.propertyShapes) {
        results.push(...evaluatePropertyShape(dataDoc, focus, shape, ps, byId, 0));
      }
      // ★ sh:closed — the only constraint that can refuse a predicate nobody anticipated.
      // Every other check above asks "is what IS here acceptable?"; this asks "is anything
      // here that should not be?", which is what makes it the one usable enforcement for
      // "this graph may carry ONLY these fields".
      if (shape.closed) {
        const declared = new Set<string>(shape.propertyShapes.map(ps => ps.path));
        for (const ign of shape.ignoredProperties) declared.add(ign);
        for (const predicate of focus.properties.keys()) {
          if (declared.has(predicate)) continue;
          results.push({
            focusNode: subjectKey(focus),
            path: predicate,
            sourceShape: shape.id,
            constraintComponent: `${SHACL}ClosedConstraintComponent`,
            severity: 'Violation',
            // Name rdf:type explicitly: SHACL does not exempt it implicitly, and a shape
            // author who closed a shape without listing it hits this first and is
            // otherwise left guessing.
            message: predicate === RDF_TYPE
              ? `Closed shape ${shape.id} does not permit rdf:type — add it to sh:ignoredProperties`
              : `Closed shape ${shape.id} does not permit predicate ${predicate}`,
          });
        }
      }
    }
  }

  return {
    conforms: results.filter(r => r.severity === 'Violation').length === 0,
    results,
  };
}
