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
 *   - sh:pattern                — regex on the lexical form of a literal OR an IRI (SHACL 4.6.3)
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
  type ParsedTripleTerm,
  type ParsedLiteral,
} from '../rdf/turtle-parser.js';
import { escapeTurtleLiteral } from '../rdf/escape.js';
import type { IRI } from '../model/types.js';

const SHACL = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' as IRI;
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const SH_NODE_SHAPE = `${SHACL}NodeShape` as IRI;
const SH_PROPERTY_SHAPE = `${SHACL}PropertyShape` as IRI;
const SH_TARGET_CLASS = `${SHACL}targetClass` as IRI;
const SH_TARGET_NODE = `${SHACL}targetNode` as IRI;
const SH_PROPERTY = `${SHACL}property` as IRI;
// SHACL 1.2 additions.
// SHACL 1.2 target mechanisms (3.1.3.3 / 3.1.3.6 / 3.1.3.7).
const SH_BY_TYPES = `${SHACL}ByTypes` as IRI;
const SH_TARGET_WHERE = `${SHACL}targetWhere` as IRI;
const SH_SHAPE = `${SHACL}shape` as IRI;
const SH_SHAPE_CLASS = `${SHACL}ShapeClass` as IRI;
const SH_SOME_VALUE = `${SHACL}someValue` as IRI;
const SH_MEMBER_SHAPE = `${SHACL}memberShape` as IRI;
const SH_MIN_LIST_LENGTH = `${SHACL}minListLength` as IRI;
const SH_MAX_LIST_LENGTH = `${SHACL}maxListLength` as IRI;
const SH_UNIQUE_MEMBERS = `${SHACL}uniqueMembers` as IRI;
const SH_SUBSET_OF = `${SHACL}subsetOf` as IRI;
const SH_ROOT_CLASS = `${SHACL}rootClass` as IRI;
const SH_SINGLE_LINE = `${SHACL}singleLine` as IRI;
const SH_NOT = `${SHACL}not` as IRI;
const SH_AND = `${SHACL}and` as IRI;
const SH_OR = `${SHACL}or` as IRI;
const SH_XONE = `${SHACL}xone` as IRI;
const SH_PATH = `${SHACL}path` as IRI;
// SHACL property paths (§2.3). Carried into 1.2 unchanged, and unimplemented here until now:
// compilePropertyShape returned null for any non-IRI sh:path, so the WHOLE property shape
// vanished — every constraint on it silently enforcing nothing.
const SH_INVERSE_PATH = `${SHACL}inversePath` as IRI;
const SH_ALTERNATIVE_PATH = `${SHACL}alternativePath` as IRI;
const SH_ZERO_OR_MORE_PATH = `${SHACL}zeroOrMorePath` as IRI;
const SH_ONE_OR_MORE_PATH = `${SHACL}oneOrMorePath` as IRI;
const SH_ZERO_OR_ONE_PATH = `${SHACL}zeroOrOnePath` as IRI;
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
const SH_SPARQL = `${SHACL}sparql` as IRI;
// SHACL 1.2 §7.8.5. Both are parameters of ONE component, sh:ReifierShapeConstraintComponent
// — sh:reificationRequired is not a component of its own, despite Appendix C of the WD
// appearing to name one (that heading is a ReSpec artifact, absent from the ED source and
// from both approved test cases).
const SH_REIFIER_SHAPE = `${SHACL}reifierShape` as IRI;
const SH_REIFICATION_REQUIRED = `${SHACL}reificationRequired` as IRI;
const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies' as IRI;
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

/**
 * ★ EVERY sh: PREDICATE THIS ENGINE ACTUALLY HONOURS — an ALLOWLIST, deliberately, because
 * the denylist it replaced failed OPEN.
 *
 * `fullyChecked` was lowered by exactly three hard-coded probes (sh:sparql, sh:reifierShape,
 * a blank-node sh:path) — the three someone had happened to notice. The SHACL **Core**
 * logical constraint components `sh:not` / `sh:or` / `sh:and` / `sh:xone` are not
 * implemented by this engine at all and had no constant in this file, so they were parsed,
 * ignored, and never reported. Measured: a graph that VIOLATES a `sh:not` returned
 * `conforms: true, fullyChecked: true` — the documented fail-closed predicate
 * `conforms && fullyChecked` accepting the one graph the shape exists to reject — while
 * `sh:datatype` on the identical data and target fired a Violation, proving the shape did
 * select the focus node. `unsupportedConstructs: 'violation'`, the strictest mode offered,
 * did not help: it only escalated the same three notes.
 *
 * A denylist has to be edited every time the spec grows and is silent when it is not. This
 * list is the inverse: anything sh:-namespaced and absent from it is REPORTED. The same
 * discipline `TRIPLE_RULE_KNOWN` uses for rule nodes, applied to constraints.
 */
const IMPLEMENTED_SHACL_PREDICATES: ReadonlySet<string> = new Set<string>([
  // targets
  SH_TARGET_CLASS, SH_TARGET_NODE, SH_TARGET_SUBJECTS_OF, SH_TARGET_OBJECTS_OF,
  // property paths (SHACL 2.3) — these are path SYNTAX, not constraints, and reporting
  // them as unimplemented after implementing them would be its own false claim.
  SH_INVERSE_PATH, SH_ALTERNATIVE_PATH, SH_ZERO_OR_MORE_PATH, SH_ONE_OR_MORE_PATH,
  SH_ZERO_OR_ONE_PATH,
  // structure
  SH_PROPERTY, SH_PATH, SH_NODE, SH_QUALIFIED_VALUE_SHAPE,
  SH_NOT, SH_AND, SH_OR, SH_XONE,
  // SHACL 1.2 constraint components
  SH_SOME_VALUE, SH_MEMBER_SHAPE, SH_MIN_LIST_LENGTH, SH_MAX_LIST_LENGTH,
  SH_UNIQUE_MEMBERS, SH_SUBSET_OF, SH_ROOT_CLASS, SH_SINGLE_LINE,
  SH_TARGET_WHERE, SH_SHAPE,
  SH_REIFIER_SHAPE, SH_REIFICATION_REQUIRED,
  SH_QUALIFIED_MIN_COUNT, SH_QUALIFIED_MAX_COUNT,
  SH_CLOSED, SH_IGNORED_PROPERTIES, SH_DEACTIVATED, SH_SEVERITY, SH_MESSAGE,
  // cardinality + value type
  SH_MIN_COUNT, SH_MAX_COUNT, SH_DATATYPE, SH_NODE_KIND, SH_CLASS,
  // value range
  SH_MIN_INCLUSIVE, SH_MAX_INCLUSIVE, SH_MIN_EXCLUSIVE, SH_MAX_EXCLUSIVE,
  // string
  SH_MIN_LENGTH, SH_MAX_LENGTH, SH_PATTERN, SH_LANGUAGE_IN, SH_UNIQUE_LANG,
  // value enumeration
  SH_IN, SH_HAS_VALUE,
  // property pairs
  SH_EQUALS, SH_DISJOINT, SH_LESS_THAN, SH_LESS_THAN_OR_EQUALS,
  // SHACL-AF rules — executed by runShaclRules, which refuses every form it cannot run
  `${SHACL}rule`, `${SHACL}subject`, `${SHACL}predicate`, `${SHACL}object`,
]);

/**
 * sh: predicates that constrain NOTHING, so ignoring one skips no check and must not lower
 * `fullyChecked`. Two groups:
 *
 *   1. SHACL's own non-validating characteristics (§ "Non-Validating Property Shape
 *      Characteristics") — documentation and UI ordering.
 *   2. The interior of a `sh:sparql` constraint node (sh:select / sh:ask / sh:prefixes and
 *      the prefix-declaration vocabulary). The ENCLOSING `sh:sparql` is already reported as
 *      unsupported; reporting its parts again would be the same gap counted five times,
 *      and `docs/ns/iep-shapes.ttl` carries enough of them to bury the real findings.
 */
const NON_VALIDATING_SHACL_PREDICATES: ReadonlySet<string> = new Set<string>([
  `${SHACL}name`, `${SHACL}description`, `${SHACL}order`, `${SHACL}group`,
  `${SHACL}defaultValue`, `${SHACL}labelTemplate`,
  `${SHACL}select`, `${SHACL}ask`, `${SHACL}prefixes`,
  `${SHACL}declare`, `${SHACL}prefix`, `${SHACL}namespace`,
  // Value-sensitive: reported explicitly below rather than by absence, because
  // `sh:reificationRequired false` requires nothing and two thirds of the shapes in
  // docs/ns/iep-shapes-1.2.ttl are exactly that.
]);

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
/**
 * A compiled SHACL property path (§2.3).
 *
 * ★ ONLY PREDICATE PATHS EXISTED BEFORE THIS. `compilePropertyShape` did `asIri(sh:path)`
 * and returned null for anything else, so a shape with a sequence, inverse, alternative or
 * transitive path was DROPPED ENTIRELY — not just its path, the whole property shape and
 * every constraint hanging off it. Measured: four such shapes, all inert, all silent to
 * `conforms`. That is SHACL 1.0, not 1.2; it has been missing since the beginning.
 */
export type CompiledPath =
  | { readonly kind: 'predicate'; readonly iri: IRI }
  | { readonly kind: 'sequence'; readonly steps: readonly CompiledPath[] }
  | { readonly kind: 'inverse'; readonly of: CompiledPath }
  | { readonly kind: 'alternative'; readonly options: readonly CompiledPath[] }
  | { readonly kind: 'zeroOrMore'; readonly of: CompiledPath }
  | { readonly kind: 'oneOrMore'; readonly of: CompiledPath }
  | { readonly kind: 'zeroOrOne'; readonly of: CompiledPath };

/** Depth bound on path nesting, mirroring the parser's own guard against hostile input. */
const MAX_PATH_DEPTH = 12;

/**
 * Compile a `sh:path` value. Returns undefined for a path this engine cannot express, so the
 * caller can REPORT it rather than silently dropping the shape.
 */
function compilePath(doc: ParsedDocument, term: ParsedTerm | undefined, depth = 0): CompiledPath | undefined {
  if (!term || depth > MAX_PATH_DEPTH) return undefined;
  if (term.kind === 'iri') return { kind: 'predicate', iri: term.iri };
  if (term.kind !== 'bnode') return undefined;
  const subj = subjectFor(doc, term);
  if (!subj) return undefined;

  const one = (pred: IRI): CompiledPath | undefined => {
    const t = subj.properties.get(pred)?.[0];
    return t ? compilePath(doc, t, depth + 1) : undefined;
  };

  const inv = one(SH_INVERSE_PATH);
  if (inv) return { kind: 'inverse', of: inv };
  const zom = one(SH_ZERO_OR_MORE_PATH);
  if (zom) return { kind: 'zeroOrMore', of: zom };
  const oom = one(SH_ONE_OR_MORE_PATH);
  if (oom) return { kind: 'oneOrMore', of: oom };
  const zoo = one(SH_ZERO_OR_ONE_PATH);
  if (zoo) return { kind: 'zeroOrOne', of: zoo };

  const altHead = subj.properties.get(SH_ALTERNATIVE_PATH)?.[0];
  if (altHead) {
    const members = walkRdfList(doc, altHead)
      .map(m => compilePath(doc, m, depth + 1))
      .filter((x): x is CompiledPath => x !== undefined);
    // An alternative of one member is legal but degenerate; of none, unusable.
    return members.length > 0 ? { kind: 'alternative', options: members } : undefined;
  }

  // A bare blank node carrying rdf:first is a SEQUENCE path — the list form, `( ex:a ex:b )`.
  if (subj.properties.has(RDF_FIRST)) {
    const steps = walkRdfList(doc, term)
      .map(m => compilePath(doc, m, depth + 1))
      .filter((x): x is CompiledPath => x !== undefined);
    return steps.length > 0 ? { kind: 'sequence', steps } : undefined;
  }
  return undefined;
}

/** A stable, readable rendering for `sh:resultPath` and for messages. */
function renderPath(p: CompiledPath): string {
  switch (p.kind) {
    case 'predicate': return p.iri;
    case 'sequence': return `(${p.steps.map(renderPath).join(' / ')})`;
    case 'inverse': return `^${renderPath(p.of)}`;
    case 'alternative': return `(${p.options.map(renderPath).join(' | ')})`;
    case 'zeroOrMore': return `${renderPath(p.of)}*`;
    case 'oneOrMore': return `${renderPath(p.of)}+`;
    case 'zeroOrOne': return `${renderPath(p.of)}?`;
  }
}

/**
 * Reverse index: object term key -> subjects that point at it, per predicate.
 *
 * ★ Memoised per document for the reason `subjectFor` and `reifiersOf` already are. An
 * inverse path evaluated by scanning every subject is a scan per focus node per path step,
 * and this engine has shipped that accidental quadratic twice.
 */
const INVERSE_INDEX = new WeakMap<ParsedDocument, Map<string, ParsedSubject[]>>();
function inverseSubjects(data: ParsedDocument, pred: IRI, object: ParsedTerm): readonly ParsedSubject[] {
  let idx = INVERSE_INDEX.get(data);
  if (idx === undefined) {
    idx = new Map<string, ParsedSubject[]>();
    for (const s of data.subjects) {
      for (const [p, terms] of s.properties) {
        for (const t of terms) {
          const k = JSON.stringify([p, termValue(t), t.kind]);
          const bucket = idx.get(k);
          if (bucket) bucket.push(s); else idx.set(k, [s]);
        }
      }
    }
    INVERSE_INDEX.set(data, idx);
  }
  return idx.get(JSON.stringify([pred, termValue(object), object.kind])) ?? [];
}

/** The term a subject denotes, so a path step can move from a subject back to a node. */
/**
 * A focus node that may be a LITERAL.
 *
 * ★ ParsedSubject cannot express one — its `subject` is `IRI | { bnode }` — so
 * `sh:targetObjectsOf` over a literal-valued predicate selected NOTHING, and every
 * node-level constraint on such a shape (sh:datatype above all, which is the whole point of
 * targeting objects) was skipped in silence. Carrying the term alongside keeps the change
 * contained: everything downstream still sees a ParsedSubject with an empty property map,
 * and only `subjectAsTerm`/`subjectKey` need to know.
 */
interface FocusNode extends ParsedSubject {
  readonly literalTerm?: ParsedLiteral;
}

function subjectAsTerm(s: ParsedSubject): ParsedTerm {
  const lit = (s as FocusNode).literalTerm;
  if (lit) return lit;
  return typeof s.subject === 'string'
    ? { kind: 'iri', iri: s.subject }
    : { kind: 'bnode', id: s.subject.bnode };
}

/**
 * The value nodes a path yields from one focus node (§2.3). Set-valued and duplicate-free:
 * SHACL speaks of the SET of value nodes, and a transitive path over a cycle would otherwise
 * not terminate.
 */
function evaluatePath(data: ParsedDocument, focus: ParsedTerm, path: CompiledPath): ParsedTerm[] {
  // JSON, not a delimiter: a literal value can contain any separator character.
  const key = (t: ParsedTerm): string => JSON.stringify([t.kind, termValue(t)]);
  const step = (from: ParsedTerm, p: CompiledPath): ParsedTerm[] => {
    switch (p.kind) {
      case 'predicate': {
        const subj = subjectFor(data, from);
        return [...(subj?.properties.get(p.iri) ?? [])];
      }
      case 'inverse': {
        // Only a predicate under an inverse can use the index; a nested complex path is
        // evaluated by asking every node whether it reaches `from`.
        if (p.of.kind === 'predicate') {
          return inverseSubjects(data, p.of.iri, from).map(subjectAsTerm);
        }
        const out: ParsedTerm[] = [];
        for (const s of data.subjects) {
          const t = subjectAsTerm(s);
          if (evaluatePath(data, t, p.of).some(v => key(v) === key(from))) out.push(t);
        }
        return out;
      }
      case 'sequence': {
        let current: ParsedTerm[] = [from];
        for (const s of p.steps) {
          const next: ParsedTerm[] = [];
          const seen = new Set<string>();
          for (const c of current) {
            for (const v of step(c, s)) {
              if (seen.has(key(v))) continue;
              seen.add(key(v));
              next.push(v);
            }
          }
          current = next;
        }
        return current;
      }
      case 'alternative': {
        const out: ParsedTerm[] = [];
        const seen = new Set<string>();
        for (const opt of p.options) {
          for (const v of step(from, opt)) {
            if (seen.has(key(v))) continue;
            seen.add(key(v));
            out.push(v);
          }
        }
        return out;
      }
      case 'zeroOrOne': {
        const out: ParsedTerm[] = [from];
        const seen = new Set<string>([key(from)]);
        for (const v of step(from, p.of)) {
          if (!seen.has(key(v))) { seen.add(key(v)); out.push(v); }
        }
        return out;
      }
      case 'zeroOrMore':
      case 'oneOrMore': {
        // Breadth-first closure with a visited set: cycles terminate rather than hang.
        const seen = new Set<string>();
        const out: ParsedTerm[] = [];
        const queue: ParsedTerm[] = [from];
        const includeSelf = p.kind === 'zeroOrMore';
        if (includeSelf) { seen.add(key(from)); out.push(from); }
        let guard = 0;
        while (queue.length > 0 && guard++ < 10000) {
          const cur = queue.shift()!;
          for (const v of step(cur, p.of)) {
            if (seen.has(key(v))) continue;
            seen.add(key(v));
            out.push(v);
            queue.push(v);
          }
        }
        return out;
      }
    }
  };
  return step(focus, path);
}

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
// ★ The other three of SHACL's seven node kinds, two of which are 1.0 and were MISSING.
// `sh:IRIOrLiteral` and `sh:BlankNodeOrLiteral` fell through to `default: return true`, so
// both accepted every term — measured: a shape demanding sh:IRIOrLiteral passed a blank
// node. sh:TripleTerm is the 1.2 addition (§7.1.3).
const SH_BLANK_NODE_OR_LITERAL = `${SHACL}BlankNodeOrLiteral` as IRI;
const SH_IRI_OR_LITERAL = `${SHACL}IRIOrLiteral` as IRI;
const SH_TRIPLE_TERM = `${SHACL}TripleTerm` as IRI;

/**
 * SHACL 1.2 §3.1.4 widens the ladder to five. sh:Trace and sh:Debug sit BELOW sh:Info and,
 * like it, are outside the default conformance-disallow set — they produce results without
 * making `conforms` false. sh:Violation remains the default when sh:severity is unstated.
 */
export type ShaclSeverity = 'Violation' | 'Warning' | 'Info' | 'Debug' | 'Trace';

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
  /**
   * False when at least one shape that SELECTED A FOCUS NODE in this data graph carried a
   * construct this validator does not implement — so a constraint that would have run did
   * not, and `conforms` is an answer about the checks that ran rather than about all the
   * checks the shape declares.
   *
   * ★ WHY THIS IS A SEPARATE FIELD AND NOT A VIOLATION. Reporting a Violation would be a
   * false statement about the DATA: the graph did not break a rule, the validator could
   * not evaluate one. Measured, and this is why it is not a stylistic preference —
   * promoting these to Violation refuses FOUR OF THE FIVE fixtures in
   * `spec/conformance/fixtures/revocation/`, including the three whose headers say they
   * MUST be accepted, because `docs/ns/iep-shapes.ttl` attaches sh:sparql to shapes
   * targeting `iep:SemioticFacet` and `iep:RevocationCondition` — classes essentially
   * every descriptor carries. Fail-closed on `conforms` would therefore not be strictness,
   * it would be refusing the substrate's own vocabulary.
   *
   * `conforms && fullyChecked` is the fail-closed predicate. It is deliberately the
   * caller's to write: a write gate should refuse; an inventory tool should not.
   */
  readonly fullyChecked: boolean;
}

export interface ValidateAgainstShapeOptions {
  /**
   * What to do BEYOND the subclass closure, which is no longer optional.
   *
   * ★ This knob used to gate `rdfs:subClassOf*` itself, with `'none'` as the default and
   * the claim that direct-type matching was "exactly as SHACL and every other processor
   * default". That claim was false, and it is now measured rather than argued:
   * tools/shacl-agreement/fixtures/subclass-value-is-subclass.data.ttl puts a value typed
   * with a subclass against `sh:class` on the superclass, and pySHACL conforms where we
   * violated. sh:class and sh:targetClass are specified over "SHACL instance" —
   * rdf:type plus rdfs:subClassOf* — so that closure is part of the constraints' meaning,
   * not an entailment regime layered on top. It now always applies.
   *
   * - `'none'` (default) and `'rdfs'` — conformant SHACL. Identical today: the closure is
   *   unconditional, and no inference beyond it (subPropertyOf, domain/range) is
   *   implemented. `'rdfs'` is kept because callers pass it meaning "be correct", which is
   *   now simply the default, and because it is where that further inference would land.
   * - `'rdfs-observe'` — MIGRATION ONLY, and deliberately non-conformant: computes the
   *   closure, then downgrades every violation that exists only because of it to Info, so
   *   `conforms` is unchanged.
   *
   * ★ The observe mode exists because correcting this is not a code change, it is a FLEET
   * change: shapes begin firing on nodes they never fired on before, so publishes that
   * pass today start failing — all at once, across every publisher, at deploy time.
   * Observe first, read what would have been rejected, then let the default enforce. There
   * is no safe way to discover that list except by running it.
   */
  readonly entailment?: 'none' | 'rdfs' | 'rdfs-observe';
  /**
   * What to do about a shape using a construct this validator does not implement —
   * sh:sparql, sh:reifierShape / sh:reificationRequired, or a blank-node sh:path.
   *
   * - `'observe'` (default) — report every such construct as Info and leave `conforms`
   *   untouched. `fullyChecked` carries the signal instead, so a caller can still fail
   *   closed without this function deciding on its behalf.
   * - `'violation'` — additionally make the note a Violation, but only where it matters:
   *   where the shape carrying the construct actually SELECTED A FOCUS NODE, capped at
   *   that shape's own declared sh:severity. Opt-in, not the default, for the measured
   *   reason recorded on {@link ShaclReport.fullyChecked}: as the default it refuses four
   *   of the five revocation conformance fixtures.
   */
  readonly unsupportedConstructs?: 'violation' | 'observe';
}

interface PropertyShape {
  readonly id: string;
  /** Rendering for sh:resultPath and messages; the predicate IRI for a simple path. */
  readonly path: IRI;
  /** The compiled path actually evaluated. A predicate path is the common case. */
  readonly pathExpr: CompiledPath;
  readonly minCount?: number;
  readonly maxCount?: number;
  /** SHACL 1.2: an IRI OR a list, meaning a union of choices. */
  readonly datatypes?: readonly IRI[];
  readonly nodeKinds?: readonly IRI[];
  readonly classes?: readonly IRI[];
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
  readonly equals?: CompiledPath;
  readonly disjoint?: CompiledPath;
  readonly lessThan?: CompiledPath;
  readonly lessThanOrEquals?: CompiledPath;
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
  /**
   * SHACL §7.2 logical constraints, on a PROPERTY shape.
   *
   * ★ These were implemented on node shapes only, so `sh:property [ sh:path ex:p ;
   * sh:not [ … ] ]` was inert — measured. In a property shape they apply to each VALUE
   * NODE, not to the focus node, which is the form every real prohibition uses.
   */
  readonly notShapes?: readonly string[];
  readonly andShapes?: readonly string[];
  readonly orShapes?: readonly string[];
  readonly xoneShapes?: readonly string[];
  /** SHACL 1.2 §7.8.3 — at least one value node must conform to this shape. */
  readonly someValue?: string;
  /** SHACL 1.2 §7.5 list constraints. Each value node must BE a SHACL list. */
  readonly memberShape?: string;
  readonly minListLength?: number;
  readonly maxListLength?: number;
  readonly uniqueMembers?: boolean;
  /** SHACL 1.2 §7.9 — every value node must also be reachable by this path. */
  readonly subsetOf?: CompiledPath;
  /** SHACL 1.2 §7.1 — the value node must be a class rooted at one of these. */
  readonly rootClasses?: readonly IRI[];
  /** SHACL 1.2 §7.4.4 (AT RISK) — the value's lexical form carries no line break. */
  readonly singleLine?: boolean;
  /** SHACL 1.2 §7.8.5 — the node shape every reifier of this triple must conform to. */
  readonly reifierShape?: string;
  /** SHACL 1.2 §7.8.5 — when true, the triple must carry at least one reifier. */
  readonly reificationRequired?: boolean;
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
  readonly closed: boolean | 'byTypes';
  /** sh:targetSubjectsOf — every subject that has this predicate. */
  readonly targetSubjectsOf: readonly IRI[];
  /**
   * SHACL 1.2 §3.1.3.6 — every node CONFORMING to this shape is a focus node. Unlike every
   * other target, it is evaluated rather than looked up.
   */
  readonly targetWhere?: string;
  /**
   * SHACL 1.2 §3.1.3.7 — `?n sh:shape <thisShape>` in the DATA graph. The only target
   * mechanism read from the data rather than the shapes graph: the data nominates which
   * shapes apply to it.
   */
  readonly isShapeTargetable?: boolean;
  /**
   * SHACL 1.2 §3.1.3.3 — a shape that is ALSO an rdfs:Class (or an sh:ShapeClass) targets
   * its own SHACL instances, without any sh:targetClass triple.
   */
  readonly implicitClassTarget?: boolean;
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
  /**
   * sh:message on the NODE shape. PropertyShape has carried one all along; NodeShape did
   * not, so an author's message on a node-level constraint — sh:closed above all, where the
   * message is the only place to explain WHY a predicate is refused — was silently dropped
   * and replaced by the engine's generic text.
   */
  readonly message?: string;
  /**
   * SHACL 1.0 logical constraints (7.2). All four were PARSED AND DROPPED — the engine
   * compiled the shape, ignored these, and reported `conforms: true` for a graph violating
   * an sh:not prohibition. Shape references, resolved through the same byId index as sh:node.
   */
  readonly notShapes?: readonly string[];
  readonly andShapes?: readonly string[];
  readonly orShapes?: readonly string[];
  readonly xoneShapes?: readonly string[];
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
  const lit = (subj as FocusNode).literalTerm;
  if (lit) return JSON.stringify(['literal', lit.value, lit.datatype ?? '', lit.language ?? '']);
  return typeof subj.subject === 'string' ? subj.subject : `_:${subj.subject.bnode}`;
}

function isShape(subj: ParsedSubject): boolean {
  const types = subj.properties.get(RDF_TYPE) ?? [];
  return types.some(t => t.kind === 'iri' && (t.iri === SH_NODE_SHAPE || t.iri === SH_PROPERTY_SHAPE));
}

function compilePropertyShape(doc: ParsedDocument, subj: ParsedSubject): PropertyShape | null {
  // ★ A non-IRI sh:path used to return null here, dropping the entire property shape and
  // every constraint on it. Complex paths now compile; only a path this engine genuinely
  // cannot express still returns null, and the sweep reports that case.
  const pathTerm = getOne(subj, SH_PATH);
  const pathExpr = compilePath(doc, pathTerm);
  if (!pathExpr) return null;
  const path = renderPath(pathExpr) as IRI;
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
    pathExpr,
    minCount: minCountLit !== undefined ? parseInt(minCountLit, 10) : undefined,
    maxCount: maxCountLit !== undefined ? parseInt(maxCountLit, 10) : undefined,
    datatypes: iriOrList(doc, getOne(subj, SH_DATATYPE)),
    nodeKinds: iriOrList(doc, getOne(subj, SH_NODE_KIND)),
    classes: iriOrList(doc, getOne(subj, SH_CLASS)),
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
    notShapes: getAll(subj, SH_NOT).map(refKey).filter((k): k is string => k !== undefined),
    andShapes: listShapeRefs(doc, subj, SH_AND),
    orShapes: listShapeRefs(doc, subj, SH_OR),
    xoneShapes: listShapeRefs(doc, subj, SH_XONE),
    someValue: refKey(getOne(subj, SH_SOME_VALUE)),
    memberShape: refKey(getOne(subj, SH_MEMBER_SHAPE)),
    minListLength: num(getOne(subj, SH_MIN_LIST_LENGTH)),
    maxListLength: num(getOne(subj, SH_MAX_LIST_LENGTH)),
    uniqueMembers: (() => {
      const t = getOne(subj, SH_UNIQUE_MEMBERS);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
    // sh:subsetOf takes a PATH, not merely a predicate IRI (§7.9).
    subsetOf: compilePath(doc, getOne(subj, SH_SUBSET_OF)),
    rootClasses: iriOrList(doc, getOne(subj, SH_ROOT_CLASS)),
    singleLine: (() => {
      const t = getOne(subj, SH_SINGLE_LINE);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
    reifierShape: refKey(getOne(subj, SH_REIFIER_SHAPE)),
    reificationRequired: (() => {
      // Only `true` carries meaning. SHACL 1.2 §7.8.5 defines behaviour for true and says
      // nothing whatsoever about false — false is the absence of the requirement, not a
      // suppression of one, so it compiles to undefined exactly like an omitted value.
      const t = getOne(subj, SH_REIFICATION_REQUIRED);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
    qualifiedValueShape: refKey(getOne(subj, SH_QUALIFIED_VALUE_SHAPE)),
    qualifiedMinCount: num(getOne(subj, SH_QUALIFIED_MIN_COUNT)),
    qualifiedMaxCount: num(getOne(subj, SH_QUALIFIED_MAX_COUNT)),
    equals: compilePath(doc, getOne(subj, SH_EQUALS)),
    disjoint: compilePath(doc, getOne(subj, SH_DISJOINT)),
    lessThan: compilePath(doc, getOne(subj, SH_LESS_THAN)),
    lessThanOrEquals: compilePath(doc, getOne(subj, SH_LESS_THAN_OR_EQUALS)),
    deactivated: (() => {
      const t = getOne(subj, SH_DEACTIVATED);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
    severity: (() => {
      const iri = asIri(getOne(subj, SH_SEVERITY));
      return iri === `${SHACL}Warning` ? 'Warning'
        : iri === `${SHACL}Info` ? 'Info'
        : iri === `${SHACL}Debug` ? 'Debug'
        : iri === `${SHACL}Trace` ? 'Trace'
        : iri === `${SHACL}Violation` ? 'Violation' : undefined;
    })(),
  };
}

/**
 * SHACL 1.2: sh:class, sh:datatype, sh:nodeKind and sh:rootClass may take EITHER an IRI or a
 * SHACL list, "indicating a union of choices".
 *
 * ★ The three pre-existing ones read the value with `asIri`, which yields undefined for a
 * list — so `sh:datatype ( xsd:integer xsd:string )` compiled to NO datatype constraint and
 * accepted every term. Silently: a list is a legal value, so nothing was unsupported to
 * report. That is the worst variety of the gap this engine keeps finding, and the only one
 * of the three that was not merely missing but actively misread.
 *
 * Distinguishing "a list" from "a class that happens to be an rdf:List" is unambiguous in
 * practice and in the spec's own wording: the list form is a BLANK NODE list.
 */
function iriOrList(doc: ParsedDocument, term: ParsedTerm | undefined): readonly IRI[] | undefined {
  if (!term) return undefined;
  if (term.kind === 'iri') return [term.iri];
  if (term.kind !== 'bnode') return undefined;
  const members = walkRdfList(doc, term)
    .map(t => (t.kind === 'iri' ? t.iri : undefined))
    .filter((x): x is IRI => x !== undefined);
  return members.length > 0 ? members : undefined;
}

/** The members of a SHACL list value node, or undefined when it is not a well-formed list. */
function listMembers(doc: ParsedDocument, v: ParsedTerm): readonly ParsedTerm[] | undefined {
  if (v.kind === 'iri' && v.iri === RDF_NIL) return [];
  if (v.kind !== 'bnode') return undefined;
  const subj = subjectFor(doc, v);
  // A bnode with no rdf:first is not a list; §7.5 makes that a violation, not a pass.
  if (!subj?.properties.has(RDF_FIRST)) return undefined;
  return walkRdfList(doc, v);
}

/** The shape refs in an rdf:List value of `pred` (sh:and / sh:or / sh:xone). */
function listShapeRefs(doc: ParsedDocument, subj: ParsedSubject, pred: IRI): readonly string[] {
  const head = subj.properties.get(pred)?.[0];
  if (!head) return [];
  return walkRdfList(doc, head)
    .map(refKey)
    .filter((k): k is string => k !== undefined);
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
    for (const pred of [SH_NODE, SH_QUALIFIED_VALUE_SHAPE, SH_REIFIER_SHAPE, SH_NOT,
      SH_SOME_VALUE, SH_MEMBER_SHAPE, SH_TARGET_WHERE]) {
      for (const t of subj.properties.get(pred) ?? []) {
        const k = refKey(t);
        if (k !== undefined) inlineShapeKeys.add(k);
      }
    }
    // sh:and / sh:or / sh:xone hold their shapes inside an rdf:List, so the members are not
    // direct objects of the predicate and the loop above cannot see them. An inline
    // `sh:or ( [ … ] [ … ] )` — the idiomatic spelling — would otherwise never compile.
    for (const pred of [SH_AND, SH_OR, SH_XONE]) {
      for (const k of listShapeRefs(doc, subj, pred)) inlineShapeKeys.add(k);
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
    // SHACL 1.2 §7.6.3 widens sh:closed from a boolean to boolean-or-sh:ByTypes. ByTypes
    // closes the node against the properties declared for ITS OWN rdf:types, rather than
    // against the properties of the shape that happens to carry sh:closed.
    const closed: boolean | 'byTypes' = closedTerm?.kind === 'iri' && closedTerm.iri === SH_BY_TYPES
      ? 'byTypes'
      : closedTerm?.kind === 'literal' && closedTerm.value === 'true';
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
      : sevIri === `${SHACL}Info` ? 'Info'
        : sevIri === `${SHACL}Debug` ? 'Debug'
          : sevIri === `${SHACL}Trace` ? 'Trace' : 'Violation';

    nodeShapes.push({
      id: subjectKey(subj),
      targetClasses,
      targetNodes,
      propertyShapes,
      closed,
      ignoredProperties,
      targetSubjectsOf,
      targetObjectsOf,
      targetWhere: refKey(getOne(subj, SH_TARGET_WHERE)),
      isShapeTargetable: typeof subjectKey(subj) === 'string',
      // Implicit class target: the shape is itself declared a class.
      implicitClassTarget: (subj.properties.get(RDF_TYPE) ?? []).some(t =>
        t.kind === 'iri' && (t.iri === 'http://www.w3.org/2000/01/rdf-schema#Class' || t.iri === SH_SHAPE_CLASS)),
      deactivated,
      severity,
      message: (() => {
        const t = getOne(subj, SH_MESSAGE);
        return t?.kind === 'literal' ? t.value : undefined;
      })(),
      nodeClass: asIri(getOne(subj, SH_CLASS)),
      nodeDatatype: asIri(getOne(subj, SH_DATATYPE)),
      nodeKindConstraint: asIri(getOne(subj, SH_NODE_KIND)),
      // sh:not takes shapes directly (repeatable); the other three take ONE rdf:List each.
      notShapes: getAll(subj, SH_NOT).map(refKey).filter((k): k is string => k !== undefined),
      andShapes: listShapeRefs(doc, subj, SH_AND),
      orShapes: listShapeRefs(doc, subj, SH_OR),
      xoneShapes: listShapeRefs(doc, subj, SH_XONE),
      ...(nodeIn.length > 0 ? { nodeIn } : {}),
    });
  }
  return nodeShapes;
}

// ── Data graph indexing ──────────────────────────────────────

/**
 * Map each class to the set of classes that are ITS subclasses (transitively), so a
 * shape targeting a superclass can select instances of any descendant.
 *
 * Built from rdfs:subClassOf in the data graph. Cycle-safe: a class already expanded is
 * not expanded again, so `A subClassOf B . B subClassOf A` terminates instead of hanging.
 */
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf' as IRI;
/**
 * The closure, plus whether the bound was hit.
 *
 * ★ `truncated` EXISTS BECAUSE THE BOUND WAS A BYPASS. The cap below is a necessary DoS
 * guard, but abandoning the closure silently means "no entailment", and the closure is
 * seeded from CALLER-SUPPLIED data. So a publisher could switch entailment off for their
 * own publish by padding the graph with irrelevant `rdfs:subClassOf` triples — measured:
 * ~209 KB of junk, free against a 4 MiB body limit, flipped a 5-violation graph to
 * conforms. A guard a caller can disable is not a guard.
 *
 * Worse, the same trick silences the evidence: with no closure there are no
 * entailment-only findings, so "the observe logs are quiet" stops being proof of anything.
 */
interface SubclassClosure {
  readonly closure: Map<IRI, Set<IRI>>;
  /** True when the edge cap aborted the computation, so the closure is NOT authoritative. */
  readonly truncated: boolean;
}

function buildSubclassClosure(...docs: readonly ParsedDocument[]): SubclassClosure {
  const direct = new Map<IRI, Set<IRI>>();          // parent -> direct children
  for (const subj of docs.flatMap(d => d.subjects)) {
    if (typeof subj.subject !== 'string') continue;
    for (const t of subj.properties.get(RDFS_SUBCLASS_OF) ?? []) {
      if (t.kind !== 'iri') continue;
      const kids = direct.get(t.iri) ?? new Set<IRI>();
      kids.add(subj.subject);
      direct.set(t.iri, kids);
    }
  }
  const closure = new Map<IRI, Set<IRI>>();
  // ★ BOUNDED. The closure materialises a descendant set per parent, so a deep chain is
  // O(k^2) in both time and heap — and this runs on fully caller-supplied graph_content,
  // synchronously, on the publish path. Unbounded it is a caller-triggered CPU/heap
  // exhaustion vector that blocks the event loop for the whole replica. Past the cap the
  // closure is abandoned (entailment degrades to direct-type) rather than risking OOM.
  const MAX_CLOSURE_EDGES = 5000;
  let edges = 0;
  for (const parent of direct.keys()) {
    const out = new Set<IRI>();
    const stack = [...(direct.get(parent) ?? [])];
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (out.has(c)) continue;                     // cycle-safe
      out.add(c);
      // Abandon the closure rather than risk OOM — but SAY SO, so the caller can refuse
      // instead of silently validating with entailment switched off.
      if (++edges > MAX_CLOSURE_EDGES) return { closure: new Map(), truncated: true };
      for (const g of direct.get(c) ?? []) stack.push(g);
    }
    closure.set(parent, out);
  }
  return { closure, truncated: false };
}

function findFocusNodes(
  data: ParsedDocument,
  shape: NodeShape,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
  /** Needed only by sh:targetWhere, which selects by CONFORMANCE rather than by lookup. */
  byId?: ReadonlyMap<string, NodeShape>,
): readonly ParsedSubject[] {
  const matched: ParsedSubject[] = [];
  const seen = new Set<string>();
  for (const cls of shape.targetClasses) {
    // The class itself, plus every transitive subclass when rdfs entailment is on.
    const classes: IRI[] = [cls, ...(subclassClosure?.get(cls) ?? [])];
    for (const s of classes.flatMap(c => findSubjectsOfType(data, c))) {
      const key = subjectKey(s);
      if (!seen.has(key)) {
        seen.add(key);
        matched.push(s);
      }
    }
  }
  // ★ sh:targetNode NAMES A NODE. It does not ask whether the data mentions it.
  //
  // This searched `data.subjects` and selected nothing when the named node was absent or
  // appeared only as an object — so `sh:targetNode ex:s` + `sh:minCount 1` CONFORMED on a
  // graph where ex:s had nothing at all, which is the precise case the constraint exists to
  // refuse. Measured on all three shapes of the problem: subject (correctly failed), object
  // only (passed), absent entirely (passed).
  //
  // SHACL §2.1.3.2 is unconditional: "The node targets of a shape are the set of nodes
  // that are values of sh:targetNode." An unmentioned node is a focus node with no
  // properties, and every constraint judges it on that basis.
  for (const node of shape.targetNodes) {
    const existing = data.subjects.find(s => typeof s.subject === 'string' && s.subject === node);
    const focus: ParsedSubject = existing ?? { subject: node, properties: new Map() };
    const key = subjectKey(focus);
    if (!seen.has(key)) {
      seen.add(key);
      matched.push(focus);
    }
  }
  // ── SHACL 1.2 §3.1.3.7: sh:shape, the only target read from the DATA graph ──
  // `?n sh:shape <thisShape>` in the data nominates this shape for ?n. It inverts the usual
  // direction of control, so an engine that only scans the shapes graph never sees it.
  if (shape.isShapeTargetable) {
    for (const s of data.subjects) {
      for (const t of s.properties.get(SH_SHAPE) ?? []) {
        if (t.kind !== 'iri' || t.iri !== shape.id) continue;
        const key = subjectKey(s);
        if (!seen.has(key)) { seen.add(key); matched.push(s); }
      }
    }
  }

  // ── SHACL 1.2 §3.1.3.3: implicit class targets ──
  // A shape that is ALSO a class targets its own SHACL instances, with no sh:targetClass.
  if (shape.implicitClassTarget) {
    const accepted = subclassClosure?.get(shape.id as IRI);
    for (const s of data.subjects) {
      const isInstance = (s.properties.get(RDF_TYPE) ?? []).some(t =>
        t.kind === 'iri' && (t.iri === shape.id || (accepted?.has(t.iri) ?? false)));
      if (!isInstance) continue;
      const key = subjectKey(s);
      if (!seen.has(key)) { seen.add(key); matched.push(s); }
    }
  }

  // ── SHACL 1.2 §3.1.3.6: sh:targetWhere ──
  // Every node CONFORMING to the given shape is a focus node. Evaluated, not looked up —
  // which is why this one needs the shape index.
  if (shape.targetWhere !== undefined && byId) {
    const where = byId.get(shape.targetWhere);
    if (where) {
      for (const s of data.subjects) {
        const key = subjectKey(s);
        if (seen.has(key)) continue;
        if (conformsToShape(data, s, where, byId, 0, subclassClosure)) {
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
    // ★ EVERY object, not only those that are also subjects. This collected keys and then
    // matched them against data.subjects, so an object appearing nowhere as a subject — the
    // ordinary case for a leaf node, and the ONLY case for a literal — was never selected.
    // The subject-shaped ones keep their real property map; the rest become focus nodes with
    // none, which is exactly what they are.
    const objects: ParsedTerm[] = [];
    for (const pred of shape.targetObjectsOf) {
      for (const s of data.subjects) {
        for (const t of s.properties.get(pred) ?? []) objects.push(t);
      }
    }
    void wanted;
    for (const t of objects) {
      if (t.kind === 'triple') continue;   // a triple term is not a node of the graph
      const existing = t.kind === 'iri'
        ? data.subjects.find(s => typeof s.subject === 'string' && s.subject === t.iri)
        : t.kind === 'bnode'
          ? data.subjects.find(s => typeof s.subject === 'object' && s.subject.bnode === t.id)
          : undefined;
      const focus: FocusNode = existing ?? (t.kind === 'literal'
        ? { subject: 'urn:iep:shacl:literalFocus' as IRI, properties: new Map(), literalTerm: t }
        : { subject: t.kind === 'iri' ? t.iri : { bnode: t.id }, properties: new Map() });
      const key = subjectKey(focus);
      if (!seen.has(key)) { seen.add(key); matched.push(focus); }
    }
  }
  return matched;
}

/**
 * Every reifier in the document, indexed by the triple it reifies.
 *
 * ★ MEMOISED PER DOCUMENT, for the reason `subjectFor` already is: the naive spelling here
 * is a scan of every subject per value node per property shape per recursion level, and
 * this engine has been bitten by exactly that shape twice — `subjectFor` and
 * `valueHasClass` were both accidentally quadratic and blew two suites past a timeout the
 * moment sh:node started running. One pass, WeakMap-cached, keyed off the document.
 *
 * A reifier is found solely via `rdf:reifies` pointing at a triple term. SHACL 1.2 Core
 * never mentions rdf:reifies — it delegates "reifier" wholesale to RDF 1.2 Concepts — so
 * this is the RDF-layer definition, not a SHACL one. Legacy rdf:Statement reification
 * (rdf:subject/rdf:predicate/rdf:object) is deliberately NOT treated as a reifier: it is a
 * different, older mechanism, and conflating them would make shapes fire on data that
 * SHACL 1.2 does not consider reified at all.
 */
const REIFIER_INDEX = new WeakMap<ParsedDocument, Map<string, ParsedSubject[]>>();

function reifierKey(subject: string, predicate: IRI, object: ParsedTerm): string {
  // JSON, not a delimiter string: a literal value can contain any character, so any
  // separator we picked could also appear inside a part and make two different
  // triples share a key. (This line briefly held NUL separators, which worked and
  // turned the whole source file binary to grep.)
  return JSON.stringify([subject, predicate, termValue(object), object.kind]);
}

function reifiersOf(
  data: ParsedDocument,
  focus: ParsedSubject,
  predicate: IRI,
  value: ParsedTerm,
): readonly ParsedSubject[] {
  let index = REIFIER_INDEX.get(data);
  if (index === undefined) {
    index = new Map<string, ParsedSubject[]>();
    for (const subj of data.subjects) {
      for (const t of subj.properties.get(RDF_REIFIES) ?? []) {
        if (t.kind !== 'triple') continue;
        const s = t.subject.kind === 'iri' ? t.subject.iri : `_:${t.subject.id}`;
        const k = reifierKey(s, t.predicate, t.object);
        const bucket = index.get(k);
        if (bucket) bucket.push(subj); else index.set(k, [subj]);
      }
    }
    REIFIER_INDEX.set(data, index);
  }
  return index.get(reifierKey(subjectKey(focus), predicate, value)) ?? [];
}

/**
 * A stable identity string for an RDF 1.2 triple term.
 *
 * Deliberately NOT shared with graph-digest's renderer or with termToTurtle below: this one
 * is an equality key, the digest one is hashed, and the Turtle one is re-parsed. They agree
 * in shape and differ in literal escaping, and collapsing them into one function would
 * silently change whichever caller did not pick the escaping.
 */
function tripleTermKey(t: ParsedTripleTerm): string {
  return `<<( ${termValue(t.subject)} ${t.predicate} ${termValue(t.object)} )>>`;
}

/** A triple term as emittable Turtle, with caller data escaped as everywhere else here. */
function tripleTermTurtle(t: ParsedTripleTerm): string {
  return `<<( ${termToTurtle(t.subject)} <${t.predicate}> ${termToTurtle(t.object)} )>>`;
}

function termValue(t: ParsedTerm): string {
  if (t.kind === 'iri') return t.iri;
  if (t.kind === 'literal') return t.value;
  // A triple term is not a bnode and must not be labelled as one. The old bare return
  // would have rendered every triple term as `_:undefined` — one string for all of them,
  // which is the shape of bug that makes distinct values compare equal.
  if (t.kind === 'triple') return tripleTermKey(t);
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

/**
 * SHACL §7.1.3 — all SEVEN node kinds, exhaustively.
 *
 * ★ Three were missing and reached `default: return true`, which accepts everything: the
 * 1.0 kinds sh:IRIOrLiteral and sh:BlankNodeOrLiteral (measured — a shape demanding
 * IRIOrLiteral passed a blank node), and the 1.2 kind sh:TripleTerm. A node-kind constraint
 * that accepts every term is the facade this engine keeps finding: named for an invariant,
 * asserting nothing.
 *
 * ★ "Any triple term matches only sh:TripleTerm" (§7.1.3). That falls out of listing the
 * cases explicitly — every other kind now names the kinds it accepts, so a triple term is
 * excluded by construction rather than by a rule someone has to remember.
 *
 * The remaining `default` is reached only by a value that is not one of the seven, which is
 * an ill-formed SHAPE rather than invalid data. It stays permissive so a shape typo cannot
 * reject a publisher's whole graph — and it is no longer silent: the sweep reports the
 * unrecognised value, so `fullyChecked` records that this check did not run.
 */
function matchesNodeKind(t: ParsedTerm, kind: IRI): boolean {
  switch (kind) {
    case SH_IRI: return t.kind === 'iri';
    case SH_LITERAL: return t.kind === 'literal';
    case SH_BLANK_NODE: return t.kind === 'bnode';
    case SH_BLANK_NODE_OR_IRI: return t.kind === 'iri' || t.kind === 'bnode';
    case SH_BLANK_NODE_OR_LITERAL: return t.kind === 'bnode' || t.kind === 'literal';
    case SH_IRI_OR_LITERAL: return t.kind === 'iri' || t.kind === 'literal';
    case SH_TRIPLE_TERM: return t.kind === 'triple';
    default: return true;
  }
}

/** The seven, for the sweep to recognise an eighth as ill-formed. */
const NODE_KINDS: ReadonlySet<string> = new Set<string>([
  SH_IRI, SH_LITERAL, SH_BLANK_NODE, SH_BLANK_NODE_OR_IRI,
  SH_BLANK_NODE_OR_LITERAL, SH_IRI_OR_LITERAL, SH_TRIPLE_TERM,
]);

function matchesDatatype(t: ParsedTerm, datatype: IRI): boolean {
  if (t.kind !== 'literal') return false;
  if (t.datatype) return t.datatype === datatype;
  // Untyped literals are xsd:string by RDF semantics.
  return datatype === (`${XSD}string` as IRI);
}

/**
 * Does the value have `expectedClass` as its type?
 *
 * ★ SUBCLASS-AWARE, and it must be, symmetrically with sh:targetClass. Making only
 * targeting subclass-aware creates a FALSE-REJECT asymmetry: a shape would start firing
 * on subclass instances (correct) and then reject them for failing an sh:class check that
 * still demanded the exact parent type (wrong). The two have to move together.
 *
 * Also indexed rather than scanned — this was the same accidentally-quadratic
 * `subjects.find`-style loop already fixed in subjectFor, on a hotter path.
 */
function valueHasClass(
  data: ParsedDocument,
  valueTerm: ParsedTerm,
  expectedClass: IRI,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): boolean {
  const subj = subjectFor(data, valueTerm);
  if (!subj) return false;
  const accepted = subclassClosure?.get(expectedClass);
  for (const t of subj.properties.get(RDF_TYPE) ?? []) {
    if (t.kind !== 'iri') continue;
    if (t.iri === expectedClass) return true;
    if (accepted?.has(t.iri)) return true;
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
/**
 * The four logical constraints (SHACL 7.2), as violations against one focus node.
 *
 * ★ ALL FOUR WERE PARSED AND DROPPED. A graph violating an `sh:not` prohibition came back
 * `conforms: true` — the shape compiled, the constraint evaporated, and nothing said so
 * until the allowlist sweep started reporting them. Reporting is not enforcing.
 *
 * Shared by the top-level loop and by conformsToShape so nesting behaves identically:
 * `sh:not [ sh:or ( … ) ]` has to mean the same thing at depth 3 as at depth 0.
 */
function logicalResults(
  data: ParsedDocument,
  focus: ParsedSubject,
  shape: NodeShape,
  byId: ReadonlyMap<string, NodeShape>,
  depth: number,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): ShaclResult[] {
  const out: ShaclResult[] = [];
  const sev = shape.severity;
  const focusNode = subjectKey(focus);
  const holds = (ref: string): boolean => {
    const target = byId.get(ref);
    // An unresolvable reference cannot be satisfied OR refuted; treat it as vacuously true
    // so a dangling ref does not silently reject a graph. The sweep reports the shape.
    if (!target) return true;
    return conformsToShape(data, focus, target, byId, depth + 1, subclassClosure);
  };
  const fail = (component: string, message: string): void => {
    out.push({ focusNode, sourceShape: shape.id, constraintComponent: `${SHACL}${component}`,
      severity: sev, message });
  };

  for (const ref of shape.notShapes ?? []) {
    if (holds(ref)) fail('NotConstraintComponent', `Focus node conforms to sh:not ${ref}, and must not`);
  }
  const and = shape.andShapes ?? [];
  if (and.length > 0 && !and.every(holds)) {
    fail('AndConstraintComponent', 'Focus node does not conform to every shape in sh:and');
  }
  const or = shape.orShapes ?? [];
  if (or.length > 0 && !or.some(holds)) {
    fail('OrConstraintComponent', 'Focus node conforms to no shape in sh:or');
  }
  const xone = shape.xoneShapes ?? [];
  if (xone.length > 0) {
    const n = xone.filter(holds).length;
    if (n !== 1) {
      fail('XoneConstraintComponent',
        `Focus node conforms to ${n} shapes in sh:xone; exactly one is required`);
    }
  }
  return out;
}

/**
 * Does a TERM satisfy a node shape? Needed where a value node may be a literal.
 *
 * `conformsToShape` takes a ParsedSubject, so it cannot judge a literal at all — and the
 * pre-existing sh:node code fell back to `target.propertyShapes.length === 0`, i.e. "a
 * literal satisfies any shape that has no property shapes". That is right for property
 * constraints (a literal has no outgoing edges) and WRONG for node-level ones: a
 * `sh:memberShape [ sh:datatype xsd:integer ]` over a list of literals is exactly the
 * common case, and it would have accepted every member.
 */
/**
 * The node-level constraints — sh:class, sh:datatype, sh:nodeKind, sh:in stated directly on
 * a node shape rather than inside sh:property — as results against one focus node.
 *
 * ★ NONE OF THESE WERE EVALUATED AT THE TOP LEVEL. They existed only inside
 * `conformsToShape`, which runs for NESTED shapes (sh:node, sh:qualifiedValueShape). So
 * `ex:S a sh:NodeShape ; sh:targetSubjectsOf ex:p ; sh:class ex:Good .` enforced nothing at
 * all — measured inert for all four. A shape reachable only as a target got its property
 * shapes checked and its own node constraints skipped, which is the harder half of the
 * failure to notice: the shape visibly DID something, just not the thing it also said.
 *
 * `sh:in` compounded it — the value was compiled into `nodeIn` and then read by nothing,
 * at any level.
 */
function nodeConstraintResults(
  data: ParsedDocument,
  focus: ParsedSubject,
  shape: NodeShape,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): ShaclResult[] {
  const out: ShaclResult[] = [];
  const term = subjectAsTerm(focus);
  const base = { focusNode: subjectKey(focus), sourceShape: shape.id, severity: shape.severity };
  const msg = (fallback: string): string => shape.message ?? fallback;
  if (shape.nodeClass !== undefined && !valueHasClass(data, term, shape.nodeClass, subclassClosure)) {
    out.push({ ...base, value: termValue(term),
      constraintComponent: `${SHACL}ClassConstraintComponent`,
      message: msg(`Focus node is not an instance of sh:class ${shape.nodeClass}`) });
  }
  if (shape.nodeDatatype !== undefined && !matchesDatatype(term, shape.nodeDatatype)) {
    out.push({ ...base, value: termValue(term),
      constraintComponent: `${SHACL}DatatypeConstraintComponent`,
      message: msg(`Focus node does not match sh:datatype ${shape.nodeDatatype}`) });
  }
  if (shape.nodeKindConstraint !== undefined && !matchesNodeKind(term, shape.nodeKindConstraint)) {
    out.push({ ...base, value: termValue(term),
      constraintComponent: `${SHACL}NodeKindConstraintComponent`,
      message: msg(`Focus node does not match sh:nodeKind ${shape.nodeKindConstraint}`) });
  }
  if (shape.nodeIn && shape.nodeIn.length > 0
    && !shape.nodeIn.some(allowed => termsEqual(allowed, term))) {
    out.push({ ...base, value: termValue(term),
      constraintComponent: `${SHACL}InConstraintComponent`,
      message: msg('Focus node is not among the values of sh:in') });
  }
  return out;
}

function nodeSatisfiesShape(
  data: ParsedDocument,
  term: ParsedTerm,
  target: NodeShape,
  byId: ReadonlyMap<string, NodeShape>,
  depth: number,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): boolean {
  if (target.deactivated) return true;
  if (target.nodeKindConstraint && !matchesNodeKind(term, target.nodeKindConstraint)) return false;
  if (target.nodeDatatype && !matchesDatatype(term, target.nodeDatatype)) return false;
  if (target.nodeClass !== undefined && !valueHasClass(data, term, target.nodeClass, subclassClosure)) {
    return false;
  }
  // ★ sh:in at node level was compiled and read by nothing, which made the idiomatic
  // prohibition `sh:not [ sh:in ( … ) ]` vacuously TRUE for every term — it reported that
  // every value conformed to the inner shape, so sh:not refused everything.
  if (target.nodeIn && target.nodeIn.length > 0
    && !target.nodeIn.some(allowed => termsEqual(allowed, term))) {
    return false;
  }
  const sub = subjectFor(data, term);
  if (sub) return conformsToShape(data, sub, target, byId, depth + 1, subclassClosure);
  // No description: it can satisfy only a shape that demands no properties of it.
  return target.propertyShapes.length === 0;
}

function conformsToShape(
  data: ParsedDocument,
  subj: ParsedSubject,
  target: NodeShape,
  byId: ReadonlyMap<string, NodeShape>,
  depth: number,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): boolean {
  if (depth > 12) return true;
  if (target.deactivated) return true;
  // Node-level value constraints apply to the focus node itself.
  if (target.nodeClass !== undefined) {
    const accepted = subclassClosure?.get(target.nodeClass);
    const types = subj.properties.get(RDF_TYPE) ?? [];
    if (!types.some(t => t.kind === 'iri'
      && (t.iri === target.nodeClass || accepted?.has(t.iri)))) return false;
  }
  if (target.nodeKindConstraint !== undefined) {
    if (!matchesNodeKind(subjectAsTerm(subj), target.nodeKindConstraint)) return false;
  }
  if (target.nodeDatatype !== undefined
    && !matchesDatatype(subjectAsTerm(subj), target.nodeDatatype)) return false;
  if (target.nodeIn && target.nodeIn.length > 0
    && !target.nodeIn.some(allowed => termsEqual(allowed, subjectAsTerm(subj)))) return false;
  // ★ THE CLOSURE HAS TO GO DOWN WITH THE RECURSION. This dropped `subclassClosure` — the
  // 7th argument — while the SAME function used it two blocks up for `target.nodeClass`.
  // So a nested shape's node-level sh:class was subclass-aware and its property-level
  // sh:class was not, one level into any sh:node or sh:qualifiedValueShape.
  //
  // Measured: `sh:property [ sh:path ex:facet ; sh:class ex:Parent ]` reached through
  // `sh:node` REJECTED a value typed ex:Child with `ex:Child rdfs:subClassOf ex:Parent`,
  // while the identical constraint at top level accepted it. A false reject, and the same
  // asymmetry this engine already warns about for targeting: fire on the subclass, then
  // refuse it for failing an exact-parent sh:class. Both call sites already pass the
  // closure in correctly; it died here.
  if (logicalResults(data, subj, target, byId, depth, subclassClosure)
    .some(r => r.severity === 'Violation')) return false;
  for (const ps of target.propertyShapes) {
    if (evaluatePropertyShape(data, subj, target, ps, byId, depth + 1, subclassClosure)
      .some(r => r.severity === 'Violation')) return false;
  }
  if (target.closed) {
    // ★ Only a PREDICATE path contributes a permitted predicate. A sequence or inverse
    // path does not name one, and adding its rendering ("(a / b)") to the permitted set
    // would let no predicate through while looking like it had.
    const declared = new Set<string>(
      target.propertyShapes
        .filter(x => x.pathExpr.kind === 'predicate')
        .map(x => (x.pathExpr as { kind: 'predicate'; iri: IRI }).iri));
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
  /** Subclass closure, so sh:class matches subclasses exactly as sh:targetClass does. */
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): ShaclResult[] {
  const results: ShaclResult[] = [];
  // A property shape its author deactivated must produce nothing, exactly as for a
  // deactivated node shape.
  if (ps.deactivated) return results;
  // ★ evaluatePath, not a map lookup: a sequence/inverse/alternative/transitive path has no
  // single predicate to look up, and looking one up is how those shapes came to enforce
  // nothing.
  const values = ps.pathExpr.kind === 'predicate'
    ? [...(focus.properties.get(ps.pathExpr.iri) ?? [])]
    : evaluatePath(data, subjectAsTerm(focus), ps.pathExpr);
  const focusNode = subjectKey(focus);
  /**
   * Severity for THIS shape: the property shape's own, else the node shape's.
   *
   * ★ EVERY constraint component below must use this. Eight of them — minCount, maxCount,
   * nodeKind, datatype, class, pattern, in, hasValue, i.e. the oldest and by far the most
   * used half of the engine — hardcoded `severity: 'Violation'` while the twelve newer ones
   * routed through here. So `sh:severity sh:Info` on a property shape was honoured or
   * ignored depending on which constraint you happened to write under it, and an author who
   * downgraded a check watched it keep failing the gate. Measured: `sh:datatype` under
   * `sh:severity sh:Info` reported Violation and flipped `conforms` to false.
   *
   * That split is also why the unsupported-construct cap below could not be believed: it
   * promised to respect a severity the engine itself only half respected.
   */
  const sev: ShaclSeverity = ps.severity ?? shape.severity;
  const fail = (path: IRI, component: string, message: string, value?: ParsedTerm): void => {
    results.push({
      focusNode, path, sourceShape: ps.id,
      constraintComponent: `${SHACL}${component}`,
      severity: sev,
      // ★ sh:message WINS, everywhere. It was honoured by a handful of components that
      // remembered to write `ps.message ?? …` at their own call site and ignored by the
      // rest, so a shape author's message appeared or vanished depending on which
      // constraint happened to fail. SHACL §6.7.2.4 makes it the result's message when
      // present; centralising it here means a new component cannot forget.
      message: ps.message ?? message,
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
    // ★ SHACL 1.2 lets the four property-pair parameters take a PATH, not only a predicate
    // IRI. The 1.0 IRI form is the degenerate case of that, so nothing migrates.
    const other = (path: CompiledPath): readonly ParsedTerm[] =>
      path.kind === 'predicate'
        ? (focus.properties.get(path.iri) ?? [])
        : evaluatePath(data, subjectAsTerm(focus), path);
    if (ps.equals) {
      const o = other(ps.equals);
      const missing = values.filter(v => !o.some(x => termsEqual(v, x)))
        .concat(o.filter(x => !values.some(v => termsEqual(v, x))));
      for (const v of missing) {
        fail(ps.path, 'EqualsConstraintComponent', `Values must equal those of ${renderPath(ps.equals)}`, v);
      }
    }
    if (ps.disjoint) {
      for (const v of values) {
        if (other(ps.disjoint).some(x => termsEqual(v, x))) {
          fail(ps.path, 'DisjointConstraintComponent', `Value must not also appear under ${renderPath(ps.disjoint)}`, v);
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
          fail(ps.path, 'LessThanConstraintComponent', `Value must be less than every value of ${renderPath(ps.lessThan)}`, v);
        }
      }
    }
    if (ps.lessThanOrEquals) {
      for (const v of values) for (const x of other(ps.lessThanOrEquals)) {
        const c = cmp(v, x);
        if (c !== undefined && c > 0) {
          fail(ps.path, 'LessThanOrEqualsConstraintComponent', `Value must be <= every value of ${renderPath(ps.lessThanOrEquals)}`, v);
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
          // A value with no description cannot satisfy a shape that requires anything.
          const ok = nodeSatisfiesShape(data, v, target, byId, depth, subclassClosure);
          if (!ok) {
            fail(ps.path, 'NodeConstraintComponent', `Value does not conform to sh:node ${ps.node}`, v);
          }
        }
      }
    }
    // ── SHACL §7.2 logical constraints, per VALUE NODE ──────────────────────────
    if (byId) {
      const holdsFor = (v: ParsedTerm, ref: string): boolean => {
        const target = byId.get(ref);
        // Unresolvable ref: vacuously true, so a dangling reference cannot reject a graph.
        return target ? nodeSatisfiesShape(data, v, target, byId, depth, subclassClosure) : true;
      };
      for (const v of values) {
        for (const ref of ps.notShapes ?? []) {
          if (holdsFor(v, ref)) {
            fail(ps.path, 'NotConstraintComponent',
              ps.message ?? `Value conforms to sh:not ${ref}, and must not`, v);
          }
        }
        const and = ps.andShapes ?? [];
        if (and.length > 0 && !and.every(r => holdsFor(v, r))) {
          fail(ps.path, 'AndConstraintComponent',
            ps.message ?? 'Value does not conform to every shape in sh:and', v);
        }
        const or = ps.orShapes ?? [];
        if (or.length > 0 && !or.some(r => holdsFor(v, r))) {
          fail(ps.path, 'OrConstraintComponent',
            ps.message ?? 'Value conforms to no shape in sh:or', v);
        }
        const xone = ps.xoneShapes ?? [];
        if (xone.length > 0) {
          const n = xone.filter(r => holdsFor(v, r)).length;
          if (n !== 1) {
            fail(ps.path, 'XoneConstraintComponent',
              ps.message ?? `Value conforms to ${n} shapes in sh:xone; exactly one is required`, v);
          }
        }
      }
    }

    // ── SHACL 1.2 §7.5: list constraints ────────────────────────────────────────
    //
    // Each of these requires the VALUE NODE ITSELF to be a SHACL list. A value that is not
    // a list is a violation in its own right, not a silent skip: "Each value node v must be
    // a SHACL list - if v is not a SHACL list there is a validation result." sh:value is the
    // value node (the list, or the thing that failed to be one), never the offending member.
    if (ps.memberShape !== undefined || ps.minListLength !== undefined
      || ps.maxListLength !== undefined || ps.uniqueMembers === true) {
      for (const v of values) {
        const members = listMembers(data, v);
        if (members === undefined) {
          fail(ps.path, 'MemberShapeConstraintComponent',
            'Value node is not a SHACL list, so its list constraints cannot hold', v);
          continue;
        }
        if (ps.minListLength !== undefined && members.length < ps.minListLength) {
          fail(ps.path, 'MinListLengthConstraintComponent',
            `List has ${members.length} member(s), fewer than sh:minListLength ${ps.minListLength}`, v);
        }
        if (ps.maxListLength !== undefined && members.length > ps.maxListLength) {
          fail(ps.path, 'MaxListLengthConstraintComponent',
            `List has ${members.length} member(s), more than sh:maxListLength ${ps.maxListLength}`, v);
        }
        if (ps.uniqueMembers === true) {
          const seenMembers = new Set<string>();
          let dup = false;
          for (const m of members) {
            const k = JSON.stringify([m.kind, termValue(m)]);
            if (seenMembers.has(k)) { dup = true; break; }
            seenMembers.add(k);
          }
          if (dup) {
            fail(ps.path, 'UniqueMembersConstraintComponent',
              'List contains a duplicated member and sh:uniqueMembers is true', v);
          }
        }
        if (ps.memberShape !== undefined && byId) {
          const target = byId.get(ps.memberShape);
          if (target) {
            for (const m of members) {
              if (!nodeSatisfiesShape(data, m, target, byId, depth, subclassClosure)) {
                fail(ps.path, 'MemberShapeConstraintComponent',
                  `A member of the list does not conform to sh:memberShape ${ps.memberShape}`, v);
                break;   // one result per value node, per the spec's own guidance
              }
            }
          }
        }
      }
    }

    // ── SHACL 1.2 §7.8.3: sh:someValue ──────────────────────────────────────────
    // "if none of the value nodes conforms to $someValue, there is a validation result."
    // Note the asymmetry with sh:node: this passes as soon as ONE value conforms, and the
    // result carries NO sh:value (there is no single node to blame).
    if (ps.someValue !== undefined && byId) {
      const target = byId.get(ps.someValue);
      if (target) {
        const any = values.some(v =>
          nodeSatisfiesShape(data, v, target, byId, depth, subclassClosure));
        if (!any) {
          fail(ps.path, 'SomeValueConstraintComponent',
            `No value node conforms to sh:someValue ${ps.someValue}`);
        }
      }
    }

    // ── SHACL 1.2 §7.9: sh:subsetOf ─────────────────────────────────────────────
    // "Let $otherNodes be the set of nodes that can be reached from the focus node via
    // $path. For each value node that does not exist in $otherNodes, there is a validation
    // result with the value node as sh:value." The parameter is a PATH, not a predicate.
    if (ps.subsetOf) {
      const others = evaluatePath(data, subjectAsTerm(focus), ps.subsetOf);
      const otherKeys = new Set(others.map(t => JSON.stringify([t.kind, termValue(t)])));
      for (const v of values) {
        if (!otherKeys.has(JSON.stringify([v.kind, termValue(v)]))) {
          fail(ps.path, 'SubsetOfConstraintComponent',
            'Value node is not among the nodes reachable by sh:subsetOf', v);
        }
      }
    }

    // ── SHACL 1.2 §7.1: sh:rootClass ────────────────────────────────────────────
    // The value node must BE a class that has one of the given classes among its
    // rdfs:subClassOf ancestors (or be one of them). Distinct from sh:class, which asks
    // what the value is an INSTANCE of.
    if (ps.rootClasses) {
      for (const v of values) {
        const ok = v.kind === 'iri' && ps.rootClasses.some(root =>
          v.iri === root || (subclassClosure?.get(root)?.has(v.iri) ?? false));
        if (!ok) {
          fail(ps.path, 'RootClassConstraintComponent',
            `Value node is not a class rooted at sh:rootClass ${ps.rootClasses.join(' | ')}`, v);
        }
      }
    }

    // ── SHACL 1.2 §7.4.4: sh:singleLine (AT RISK in the WD) ─────────────────────
    if (ps.singleLine === true) {
      for (const v of values) {
        // fromCharCode, not a regex literal: a newline written into this source by a
        // generator becomes a real line break and the pattern stops being one.
        const lex = termValue(v);
        if (lex.includes(String.fromCharCode(10)) || lex.includes(String.fromCharCode(13))) {
          fail(ps.path, 'SingleLineConstraintComponent',
            'Value contains a line break and sh:singleLine is true', v);
        }
      }
    }

    // ── SHACL 1.2 §7.8.5: sh:reifierShape + sh:reificationRequired ──────────────
    //
    // "Let t be the triple term (focus node, $path, value node). For each reifier for the
    // triple term t, a failure MUST be produced if validating the reifier against the node
    // shape $reifierShape with the reifier as focus node produces a failure."
    //
    // The reifier is the FOCUS NODE of the nested shape — not the triple term, and not the
    // value. That is the whole point of the constraint: it constrains what may be SAID
    // ABOUT a statement, separately from the statement itself.
    if (ps.reifierShape !== undefined || ps.reificationRequired === true) {
      const target = ps.reifierShape === undefined ? undefined : byId.get(ps.reifierShape);
      for (const v of values) {
        const reifiers = reifiersOf(data, focus, ps.path, v);

        // sh:reificationRequired true — "there must be at least one reification value for
        // the focus node/path combination in the data graph".
        if (ps.reificationRequired === true && reifiers.length === 0) {
          fail(ps.path, 'ReifierShapeConstraintComponent',
            `sh:reificationRequired is true but the statement carries no reifier`, v);
        }

        if (target === undefined) continue;
        for (const r of reifiers) {
          if (!conformsToShape(data, r, target, byId, depth, subclassClosure)) {
            // ★ sh:value is THE VALUE NODE, and this is a deliberate choice between two
            // readings the spec cannot both satisfy. §7.8.5's prose says the result carries
            // the triple term t — but its own text rebinds t mid-definition ("Let t be the
            // triple term …  For each reifier t …"), and BOTH approved test cases in the
            // W3C suite (reifierShape-001/002, sht:approved) expect the value node. An
            // approved test is the thing an implementation is measured against, so it wins
            // over prose that contradicts itself.
            fail(ps.path, 'ReifierShapeConstraintComponent',
              `A reifier of this statement does not conform to sh:reifierShape ${ps.reifierShape}`, v);
          }
        }
      }
    }
    if (ps.qualifiedValueShape && (ps.qualifiedMinCount !== undefined || ps.qualifiedMaxCount !== undefined)) {
      const target = byId.get(ps.qualifiedValueShape);
      if (target) {
        let n = 0;
        for (const v of values) {
          if (nodeSatisfiesShape(data, v, target, byId, depth, subclassClosure)) n++;
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
      sourceShape: ps.id,
      constraintComponent: `${SHACL}MinCountConstraintComponent`,
      severity: sev,
      message: ps.message ?? `Value count ${values.length} is below sh:minCount ${ps.minCount} for ${ps.path}`,
    });
  }
  if (ps.maxCount !== undefined && values.length > ps.maxCount) {
    results.push({
      focusNode,
      path: ps.path,
      sourceShape: ps.id,
      constraintComponent: `${SHACL}MaxCountConstraintComponent`,
      severity: sev,
      message: ps.message ?? `Value count ${values.length} exceeds sh:maxCount ${ps.maxCount} for ${ps.path}`,
    });
  }

  for (const v of values) {
    if (ps.nodeKinds && !ps.nodeKinds.some(k => matchesNodeKind(v, k))) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: ps.id,
        constraintComponent: `${SHACL}NodeKindConstraintComponent`,
        severity: sev,
        message: ps.message ?? `Value does not match sh:nodeKind ${ps.nodeKinds?.join(' | ')}`,
      });
    }
    if (ps.datatypes && !ps.datatypes.some(d => matchesDatatype(v, d))) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: ps.id,
        constraintComponent: `${SHACL}DatatypeConstraintComponent`,
        severity: sev,
        message: ps.message ?? `Value does not match sh:datatype ${ps.datatypes?.join(' | ')}`,
      });
    }
    if (ps.classes && !ps.classes.some(cl => valueHasClass(data, v, cl, subclassClosure))) {
      results.push({
        focusNode,
        path: ps.path,
        value: termValue(v),
        sourceShape: ps.id,
        constraintComponent: `${SHACL}ClassConstraintComponent`,
        severity: sev,
        message: ps.message ?? `Value is not an instance of sh:class ${ps.classes?.join(' | ')}`,
      });
    }
    // ★ sh:pattern APPLIES TO IRIs TOO, not only literals.
    //
    // SHACL §4.6.3: the constraint tests the value node's lexical form, and for an IRI that
    // is the IRI string itself. Only a blank node is out of scope (it has no lexical form,
    // and the spec makes that a violation rather than a pass).
    //
    // Restricting this to literals silently ignored every pattern written against an IRI —
    // and the natural use is exactly the one that matters here: constraining a principal to
    // a dereferenceable scheme. A shape saying `sh:pattern "^https?://|^did:"` on a
    // membership was accepting `urn:` identifiers, which is the opposite of what it says.
    //
    // The sharper problem is disagreement rather than laxity: pySHACL enforces this, so our
    // published shape meant one thing to us and another to anyone who checked it. A shape
    // published at a dereferenceable URL is a claim a stranger must be able to re-verify,
    // and it stops being one the moment our engine and theirs disagree.
    if (ps.pattern && (v.kind === 'literal' || v.kind === 'iri')) {
      try {
        const re = new RegExp(ps.pattern);
        const lexical = v.kind === 'iri' ? v.iri : v.value;
        if (!re.test(lexical)) {
          results.push({
            focusNode,
            path: ps.path,
            value: termValue(v),
            sourceShape: ps.id,
            constraintComponent: `${SHACL}PatternConstraintComponent`,
            severity: sev,
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
          sourceShape: ps.id,
          constraintComponent: `${SHACL}InConstraintComponent`,
          severity: sev,
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
        sourceShape: ps.id,
        constraintComponent: `${SHACL}HasValueConstraintComponent`,
        severity: sev,
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
      // Nothing ran at all, so nothing was fully checked either.
      fullyChecked: false,
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
      fullyChecked: false,
    };
  }

  // ★ RDFS SUBCLASS ENTAILMENT. This used to be `void options.entailment;` — the option
  // was accepted and discarded, and the relay's publish gate has been passing
  // `{ entailment: 'rdfs' }` the whole time believing it did something.
  //
  // The consequence was a ONE-TRIPLE BYPASS of every class-targeted shape: adding
  // `ex:Sub rdfs:subClassOf ex:Target` and typing the node `ex:Sub` made it escape a
  // shape targeting `ex:Target` entirely, with a conforming result. For a closed privacy
  // shape that is a complete bypass; for vault-ld's authority-class check it is exactly
  // the smuggling attack that file documents in its own comment.
  //
  // The closure is computed from rdfs:subClassOf statements present in the DATA graph,
  // which is where SHACL says entailment applies. Cycle-safe and computed once.
  // ★ SEEDED FROM BOTH GRAPHS. Reading the data graph alone made this inert for every
  // contract in this repo: our published shape files carry zero rdfs:subClassOf, because
  // the hierarchy lives in the ontology alongside the shapes. A closure that only sees
  // the data is trivially evaded by omitting the triple — the attacker controls the data.
  //
  // (Still unresolved: an `owl:imports` in a shapes file pointing at a separate ontology
  // document. Following it needs a fetch, which belongs to the caller that already
  // fetches shape bodies, not to a pure validator. Called out rather than pretended.)
  // ★ AND THE CLOSURE IS NOT OPTIONAL. It used to be computed only when the caller asked
  // for entailment, on the stated grounds that direct-type matching is "exactly as SHACL
  // and every other processor default". That grounds was measurably false, and
  // tools/shacl-agreement/fixtures/subclass-value-is-subclass.data.ttl is the measurement:
  // pySHACL says conforms, we said violates, on a value typed with a subclass of the class
  // named by sh:class. Our published shape meant two different things to us and to a
  // conformant reader.
  //
  // The error was conflating two separate things. Applying an RDFS entailment regime to the
  // data graph IS optional (SHACL §1.5). But sh:class and sh:targetClass are not defined in
  // terms of a regime at all — they are defined over "SHACL instance", which the spec spells
  // out as rdf:type followed by rdfs:subClassOf*. That closure is part of what those two
  // constraints MEAN. Making it opt-in did not make us conservative, it made us wrong, and it
  // left the one-triple bypass described above armed for every caller that took the default.
  // The relay's publish gate passed 'rdfs' explicitly and was safe; nothing else was.
  const closureResult = buildSubclassClosure(dataDoc, shapeDoc);
  const subclassClosure = closureResult?.closure;

  const shapes = compileShapes(shapeDoc);

  // ★ A SHAPE THAT CANNOT BE ENFORCED MUST SAY SO.
  //
  // Silently ignoring a construct is how a published shape becomes a facade: it is
  // dereferenceable, named for a real invariant, cited by dct:conformsTo — and asserts
  // nothing. `vldp:EntailmentAuthorityShape`, the anti-authority-smuggling defence, is
  // sh:sparql-only and therefore entirely inert today, with no signal anywhere.
  //
  // These are reported as Info, not Violation: a shape using an unimplemented construct
  // is not INVALID data, and failing every publish that cites one would be a worse
  // outcome than the silence. But it is now in the report, so a caller can surface it
  // and nobody can mistake "conforms" for "was actually checked".
  const unsupported: ShaclResult[] = [];

  // ★ IF YOU ASKED FOR ENTAILMENT AND I COULD NOT COMPUTE IT, I MUST NOT SAY "CONFORMS".
  //
  // The closure's edge cap is a real DoS guard, but it is seeded from caller-supplied
  // data, so abandoning it quietly hands the caller an off switch for the very inference
  // the gate depends on. Measured: padding a graph with ~209 KB of irrelevant
  // `rdfs:subClassOf` triples — free against a 4 MiB limit — turned 5 violations into
  // conforms. Same precedent as an unfetchable shape: degrade LOUDLY and fail closed
  // rather than validate against something weaker than was asked for.
  //
  // Under 'rdfs-observe' this cannot be a Violation without defeating the point of the
  // mode, so it is a Warning: visible in the report and the logs, `conforms` untouched.
  if (closureResult?.truncated) {
    unsupported.push({
      focusNode: 'urn:iep:shacl:subclassClosure',
      sourceShape: 'urn:iep:shacl:subclassClosure',
      constraintComponent: 'urn:iep:shacl:EntailmentIncomplete',
      severity: options.entailment === 'rdfs-observe' ? 'Warning' : 'Violation',
      message:
        'The subclass closure exceeded its edge bound, so it was abandoned and NO subclass '
        + 'reasoning was applied. sh:class and sh:targetClass are defined over SHACL '
        + 'instances (rdfs:subClassOf*), so without it this result is not conformant SHACL '
        + 'and every class-targeted shape here carries a one-triple bypass. If this graph is '
        + 'not adversarial, reduce its rdfs:subClassOf count or raise the bound deliberately.',
    });
  }

  // Shape references (sh:node, sh:qualifiedValueShape) resolve through this index.
  // Built from ALL compiled shapes, so a referenced shape need not have its own target.
  const byId = new Map<string, NodeShape>();
  for (const sh of shapes) byId.set(sh.id, sh);

  const results: ShaclResult[] = [];
  // Shapes that actually selected a focus node. Recorded HERE rather than recomputed after
  // the loop so the liveness test and the validation share ONE answer — a second
  // findFocusNodes pass is free to drift from this one and silently stop escalating, and
  // nothing would fail when it did. A sh:deactivated shape never reaches this line, which
  // is correct: its constraints were not skipped, they were switched off by their author.
  const liveShapeIds = new Set<string>();
  for (const shape of shapes) {
    // sh:deactivated — a shape switched off by its author MUST produce no results.
    if (shape.deactivated) continue;
    const focusNodes = findFocusNodes(dataDoc, shape, subclassClosure, byId);
    if (focusNodes.length > 0) liveShapeIds.add(shape.id);
    // Which of these would NOT have been selected without entailment? Only those can
    // produce a "new" violation, so only those are downgraded in observe mode.
    const directOnly = new Set(findFocusNodes(dataDoc, shape, undefined, byId).map(f => subjectKey(f)));
    for (const focus of focusNodes) {
      const entailedOnly = options.entailment === 'rdfs-observe'
        && !directOnly.has(subjectKey(focus));
      const emit = (r: ShaclResult): void => {
        results.push(entailedOnly && r.severity === 'Violation'
          ? {
              ...r,
              severity: 'Info',
              message: `[entailment-observe] would REJECT under entailment:'rdfs' — ${r.message ?? ''}`,
            }
          : r);
      };
      for (const r of nodeConstraintResults(dataDoc, focus, shape, subclassClosure)) emit(r);
      for (const r of logicalResults(dataDoc, focus, shape, byId, 0, subclassClosure)) emit(r);
      for (const ps of shape.propertyShapes) {
        for (const r of evaluatePropertyShape(dataDoc, focus, shape, ps, byId, 0, subclassClosure)) emit(r);
      }
      // ★ sh:closed — the only constraint that can refuse a predicate nobody anticipated.
      // Every other check above asks "is what IS here acceptable?"; this asks "is anything
      // here that should not be?", which is what makes it the one usable enforcement for
      // "this graph may carry ONLY these fields".
      if (shape.closed) {
        // sh:ByTypes: the permitted set comes from the shapes that target this node's OWN
        // types, not from this shape. A node with no type is then closed against nothing
        // declared, so every predicate it carries is reported — which is the honest reading
        // of "closed against its types" for a node that has none.
        const sources = shape.closed === 'byTypes'
          ? (() => {
            const myTypes = new Set((focus.properties.get(RDF_TYPE) ?? [])
              .filter(t => t.kind === 'iri').map(t => (t as { kind: 'iri'; iri: IRI }).iri));
            return shapes.filter(sh =>
              sh.targetClasses.some(tc => myTypes.has(tc)) || myTypes.has(sh.id as IRI));
          })()
          : [shape];
        const declared = new Set<string>(
          sources.flatMap(sh => sh.propertyShapes)
            .filter(ps => ps.pathExpr.kind === 'predicate')
            .map(ps => (ps.pathExpr as { kind: 'predicate'; iri: IRI }).iri));
        for (const ign of shape.ignoredProperties) declared.add(ign);
        for (const predicate of focus.properties.keys()) {
          if (declared.has(predicate)) continue;
          emit({
            focusNode: subjectKey(focus),
            path: predicate,
            // ★ shape.id, NOT a property shape: sh:closed is a NODE-shape constraint and
            // the result is about the node shape. The nine sourceShape sites inside
            // evaluatePropertyShape moved to the property shape (SHACL §6.7.2, and both
            // approved W3C reifierShape tests expect `ex:TestShape-propertyA`); this one
            // is the exception, and it is the compiler that caught the over-reach — `ps`
            // is not even in scope here.
            sourceShape: shape.id,
            constraintComponent: `${SHACL}ClosedConstraintComponent`,
            severity: 'Violation',
            // Name rdf:type explicitly: SHACL does not exempt it implicitly, and a shape
            // author who closed a shape without listing it hits this first and is
            // otherwise left guessing.
            message: shape.message ?? (predicate === RDF_TYPE
              ? `Closed shape ${shape.id} does not permit rdf:type — add it to sh:ignoredProperties`
              : `Closed shape ${shape.id} does not permit predicate ${predicate}`),
          });
        }
      }
    }
  }

  // ★ A CONSTRAINT I COULD NOT EVALUATE MUST NOT BE REPORTED AS "CONFORMS".
  //
  // Measured, not theorised: `spec/conformance/fixtures/revocation/self-reference-
  // violation.ttl` — a fixture whose own header says it "MUST be rejected by any
  // conforming implementation" — validated against `docs/ns/iep-shapes.ttl` returned
  // conforms:true with five Info notes and NOTHING ELSE. Info never moves `conforms`, so
  // this was the last fail-OPEN degradation in this function, next to four siblings
  // (unparseable shape graph, unparseable data graph, unfetchable shape at the relay,
  // abandoned subclass closure) that all already refuse the write.
  //
  // ★ WHY THE SEVERITY COULD NOT SIMPLY BE FLIPPED WHERE IT STOOD. The scan ran over
  // `shapeDoc.subjects` and consulted the data graph nowhere: validating the EMPTY STRING
  // against iep-shapes.ttl produces the identical five notes. Promoted in place it would
  // have refused every publish citing that file — including graphs holding nothing the
  // constraint could ever select, and including the `validateAgainstShape('', body)`
  // probes at deploy/mcp-relay/server.ts that decide whether a fetched body even parses
  // as a shapes graph. A skipped constraint is a false statement only when it WOULD HAVE
  // RUN, which is why this now runs after the validation loop, over the shapes that
  // selected a focus node.
  const promoteUnsupported = options.unsupportedConstructs === 'violation';
  // Set whenever a LIVE shape carried a construct we could not evaluate — independent of
  // `promoteUnsupported`, because this is the honest answer to "was everything checked?"
  // and it must be available to callers that do not want `conforms` moved.
  let fullyChecked = true;
  const declaredSeverity = new Map<string, ShaclSeverity>(shapes.map(s => [s.id, s.severity]));
  const subjectsByKey = new Map<string, ParsedSubject>();
  for (const s of shapeDoc.subjects) subjectsByKey.set(subjectKey(s), s);
  // A property shape is a blank node hanging off sh:property / sh:node /
  // sh:qualifiedValueShape; it declares no target of its own, so its liveness is entirely
  // its owner's. These are the same three predicates compileShapes traverses, so every
  // subject reachable here is a subject that was compiled.
  const ownerSeverity = new Map<string, ShaclSeverity>();
  /** Strictness order, so "the stricter of" and "capped at" are one comparison. */
  const SEVERITY_RANK: Readonly<Record<ShaclSeverity, number>> =
    { Trace: 0, Debug: 1, Info: 2, Warning: 3, Violation: 4 };
  const stricter = (a: ShaclSeverity, b: ShaclSeverity): ShaclSeverity =>
    SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
  const laxer = (a: ShaclSeverity, b: ShaclSeverity): ShaclSeverity =>
    SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
  /** `sh:severity` declared on ANY subject, not just the ones that compiled to node shapes. */
  const declaredOn = (key: string): ShaclSeverity | undefined => {
    const subj = subjectsByKey.get(key);
    if (!subj) return undefined;
    const iri = asIri(subj.properties.get(SH_SEVERITY)?.[0]);
    return iri === `${SHACL}Warning` ? 'Warning'
      : iri === `${SHACL}Info` ? 'Info'
      : iri === `${SHACL}Debug` ? 'Debug'
      : iri === `${SHACL}Trace` ? 'Trace'
      : iri === `${SHACL}Violation` ? 'Violation' : undefined;
  };
  for (const rootId of liveShapeIds) {
    const rootSeverity = declaredSeverity.get(rootId) ?? 'Violation';
    // ★ THE CAP HAD TO BE CARRIED DOWN, NOT STAMPED. This walk used to write
    // `ownerSeverity.set(key, rootSeverity)` for every reachable subject, so the severity
    // applied was always the ROOT node shape's and never the shape actually carrying the
    // construct. A nested property shape its author explicitly downgraded with
    // `sh:severity sh:Info` was promoted to Violation whenever the enclosing node shape
    // declared none (default Violation) — the exact over-enforcement the doc comment on
    // `unsupportedConstructs` says cannot happen. The existing test passed only because it
    // put `sh:severity` on the ROOT, the one position where root and carrier coincide.
    const stack: Array<readonly [string, ShaclSeverity]> = [[rootId, rootSeverity]];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const [key, inherited] = stack.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      // A shape cannot be made STRICTER by its parent: `sh:severity sh:Info` on this
      // subject caps it at Info however the enclosing shape is marked. Absent its own
      // declaration it inherits.
      const own = declaredOn(key);
      const effective = own === undefined ? inherited : laxer(inherited, own);
      // Reachable from two live shapes ⇒ unenforceable for both ⇒ the stricter one decides.
      const prior = ownerSeverity.get(key);
      ownerSeverity.set(key, prior === undefined ? effective : stricter(prior, effective));
      const subj = subjectsByKey.get(key);
      if (!subj) continue;
      for (const pred of [SH_PROPERTY, SH_NODE, SH_QUALIFIED_VALUE_SHAPE, SH_REIFIER_SHAPE]) {
        for (const t of subj.properties.get(pred) ?? []) {
          const k = refKey(t);
          if (k !== undefined) stack.push([k, effective]);
        }
      }
    }
  }
  const noteUnsupported = (shapeId: string, construct: string, why: string): void => {
    const owner = ownerSeverity.get(shapeId);
    // `owner === undefined` ⇒ no shape that fired reaches this subject ⇒ the construct
    // would never have been evaluated ⇒ nothing was actually skipped. Still reported, so
    // an operator inventorying facade shapes can see it, but it does not touch
    // `fullyChecked`: that flag has to mean "a check that WOULD have run did not", or a
    // caller gating on it refuses every graph that merely cites a big shapes file.
    const live = owner !== undefined;
    if (live) fullyChecked = false;
    // A shape its author marked sh:Warning / sh:Info CANNOT become a Violation just
    // because we cannot run it — that would enforce MORE than the shape asks for.
    // `iep:TemporalFacetNonFutureValidFromShape` and `iep:AgentProvenanceConsistencyShape`
    // are exactly this case, and both are sh:sparql-only.
    const severity: ShaclSeverity = promoteUnsupported && live ? owner : 'Info';
    unsupported.push({
      focusNode: shapeId,
      sourceShape: shapeId,
      constraintComponent: 'urn:iep:shacl:UnsupportedConstraint',
      severity,
      message: `${construct} is not implemented by this validator, so ${why}. `
        + 'The shape parsed, but this constraint was NOT enforced.'
        + (live
          ? ' It selected at least one focus node in this data graph, so a check that '
            + 'would have run did not — report.fullyChecked is false.'
          : ' It selected no focus node in this data graph, so nothing was actually skipped.'),
    });
  };
  for (const subj of shapeDoc.subjects) {
    const id = subjectKey(subj);
    // ★ THE ALLOWLIST SWEEP. Every sh:-namespaced predicate on this shape that the engine
    // does not honour is reported — including the ones nobody has thought of yet. This is
    // what makes `sh:not` / `sh:or` / `sh:and` / `sh:xone` visible; they were previously
    // parsed, dropped, and reported by nothing, so a graph violating a sh:not prohibition
    // came back conforms:true, fullyChecked:true.
    for (const p of subj.properties.keys()) {
      if (!p.startsWith(SHACL)) continue;
      if (IMPLEMENTED_SHACL_PREDICATES.has(p)) continue;
      if (NON_VALIDATING_SHACL_PREDICATES.has(p)) continue;
      noteUnsupported(
        id,
        `sh:${p.slice(SHACL.length)}`,
        p === SH_SPARQL
          ? 'the SPARQL constraint was skipped entirely'
          : 'the constraint was not evaluated',
      );
    }
    // ★ REIFICATION IS IMPLEMENTED NOW, BUT ONLY IN ITS WELL-FORMED SHAPE — and the forms
    // outside that shape must still say so rather than pass quietly.
    //
    // SHACL 1.2 §7.8.5 defines sh:reifierShape over a PROPERTY shape: the validator reads
    // `the triple term (focus node, $path, value node)`, and `$path` exists only on a
    // property shape. Appendix A adds one syntax rule — "If a value for sh:reifierShape is
    // given, sh:path values are constrained to IRIs" — so a complex path is ill-formed too.
    //
    // Neither case is a well-formedness ERROR the spec asks a validator to raise, which is
    // exactly why it needs reporting here: a reifier constraint hung on a node shape, or on
    // a sequence path, would otherwise be compiled into nothing and validate silently. That
    // is the facade this sweep exists to prevent, and the published iep-shapes-1.2.ttl was
    // written in precisely that form.
    const carriesReification = subj.properties.has(SH_REIFIER_SHAPE)
      || (() => {
        const t = subj.properties.get(SH_REIFICATION_REQUIRED)?.[0];
        return t?.kind === 'literal' && t.value === 'true';
      })();
    if (carriesReification) {
      const pathTerms = subj.properties.get(SH_PATH) ?? [];
      const pathTerm = pathTerms[0];
      if (pathTerm === undefined) {
        noteUnsupported(id, 'sh:reifierShape on a shape with no sh:path',
          'SHACL 1.2 §7.8.5 evaluates it over (focus node, $path, value node), so a shape '
          + 'without a path has nothing to reify and the constraint was not evaluated');
      } else if (pathTerm.kind !== 'iri') {
        noteUnsupported(id, 'sh:reifierShape on a non-IRI sh:path',
          'SHACL 1.2 Appendix A constrains sh:path to IRIs when sh:reifierShape is given, '
          + 'so the constraint was not evaluated');
      }
    }
    // An sh:nodeKind whose value is not one of the seven is an ill-formed shape, and
    // matchesNodeKind is deliberately permissive there so a typo cannot reject a
    // publisher's entire graph. Permissive AND silent is the facade, though — the check did
    // not run, so say so.
    const nodeKindTerm = subj.properties.get(SH_NODE_KIND)?.[0];
    if (nodeKindTerm?.kind === 'iri' && !NODE_KINDS.has(nodeKindTerm.iri)) {
      noteUnsupported(id, `sh:nodeKind ${nodeKindTerm.iri}`,
        'that is not one of the seven node kinds in SHACL §7.1.3, so the constraint matched '
        + 'every term instead of the intended one');
    }
    // ★ Complex paths COMPILE now (sequence / inverse / alternative / zeroOrMore /
    // oneOrMore / zeroOrOne), so a blank-node sh:path is no longer reportable on sight.
    // What remains reportable is a path shape this engine cannot express at all — an empty
    // alternative, an unterminated list, a nesting past the depth bound. compilePath returns
    // undefined for those and the property shape is still dropped, which must stay visible.
    const pathTerm = subj.properties.get(SH_PATH)?.[0];
    if (pathTerm && pathTerm.kind === 'bnode' && compilePath(shapeDoc, pathTerm) === undefined) {
      noteUnsupported(id, 'an sh:path expression this validator cannot compile',
        'the entire property shape was dropped');
    }
  }

  // ★ `conforms` MUST be computed over the SAME list that is returned.
  //
  // It used to read `results` alone while the report returned `[...results, ...unsupported]`.
  // That was harmless while everything in `unsupported` was Info — and it silently made the
  // first Violation ever added there (the truncated-closure fail-closed above) into dead
  // code: the report would carry the violation and still say conforms: true. Deriving both
  // from one list removes the class of bug rather than this instance of it.
  const all = [...results, ...unsupported];
  return {
    // Info notes still never change this; they are Info. A Violation anywhere does.
    conforms: all.filter(r => r.severity === 'Violation').length === 0,
    results: all,
    fullyChecked,
  };
}

// ═══════════════════════════════════════════════════════════════
//  SHACL-AF rules (sh:rule) — inference, not validation
//
//  Written for the kernel's reduce verb: a `shacl-transform` reducer
//  declares its fold as a shape, and before this existed the kernel
//  had nothing to call, so it concatenated instead. Measured: a shape
//  projecting only ex:status left `ex:secret ex:ssn "111-22-3333"` in
//  the folded head, and an unparseable shape produced the same head —
//  and the same headStateCid — as a valid one.
//
//  Every rule form this engine cannot execute THROWS rather than
//  returning fewer triples: a rule engine that silently skips a rule
//  reports "0 constructed" for "I refused to look", and the kernel's
//  reduce verb cannot tell those apart.
//
//  ★ AND THE REFUSALS ARE EVALUATED ON THE SHAPE AS WRITTEN, not on
//  the shape as switched on. `sh:deactivated` used to `continue` above
//  the well-formedness checks (though below the type checks), so the
//  ill-formed rule this engine refuses became acceptable the moment its
//  author added `sh:deactivated true` — and, because the old
//  `ruleCount` could not distinguish "declared no rules" from "declared
//  rules, all off", the kernel then folded the entire link body. One
//  keyword turned a redaction reducer into a full disclosure. Structure
//  is checked first; the off switch is consulted last and only decides
//  whether the rule EMITS.
// ═══════════════════════════════════════════════════════════════

const SH_RULE = `${SHACL}rule` as IRI;
const SH_TRIPLE_RULE = `${SHACL}TripleRule` as IRI;
const SH_SPARQL_RULE = `${SHACL}SPARQLRule` as IRI;
const SH_SUBJECT = `${SHACL}subject` as IRI;
const SH_PREDICATE = `${SHACL}predicate` as IRI;
const SH_OBJECT = `${SHACL}object` as IRI;
const SH_THIS = `${SHACL}this` as IRI;
const SH_CONSTRUCT = `${SHACL}construct` as IRI;

/**
 * Properties a sh:TripleRule node may carry and this engine honours.
 * Anything else in the sh: namespace on a rule node is a directive we would be dropping —
 * sh:condition being the dangerous one, since ignoring it BROADENS what the rule
 * constructs. Allowlist, not denylist: a SHACL term added after this was written must
 * fail loudly rather than be silently discarded.
 */
const TRIPLE_RULE_KNOWN: ReadonlySet<string> = new Set<string>([
  RDF_TYPE, SH_SUBJECT, SH_PREDICATE, SH_OBJECT, SH_DEACTIVATED,
]);

export interface ShaclRuleRun {
  /**
   * Number of sh:rule nodes actually EXECUTED. Strictly `<= declaredRules`; the difference
   * is the rules switched off with `sh:deactivated`.
   *
   * ★ DO NOT USE THIS TO DETECT "the shape declares no rule" — that is `declaredRules`, and
   * conflating the two was a disclosure. `applyReducerStep` keyed its merge fallback on
   * `ruleCount === 0`, so adding ONE triple — `sh:deactivated true` — to a projecting
   * redaction reducer made it indistinguishable from a shape with no rules at all, and the
   * fold emitted the entire link body: measured, `ex:ssn "111-22-3333"` back in the head,
   * under the identical headStateCid as the plain-merge shape. Switching a redaction rule
   * OFF must not turn a projection into a full disclosure.
   */
  readonly ruleCount: number;
  /**
   * Number of well-formed sh:rule nodes the shape DECLARES, counted before
   * `sh:deactivated` is consulted. 0 — and only 0 — means the shape declares no rule at
   * all, so a caller may treat it as a merge declaration.
   *
   * SHACL-AF says a deactivated rule infers NOTHING, so `declaredRules > 0` with
   * `ruleCount === 0` means "contribute the empty set", never "contribute everything".
   */
  readonly declaredRules: number;
  readonly tripleCount: number;
  /** Constructed triples, deduped and sorted, as full-IRI Turtle. */
  readonly turtle: string;
}

/** Distinguishable from a parse/type error so callers can report which. */
export class ShaclRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShaclRuleError';
  }
}

function termToTurtle(t: ParsedTerm): string {
  if (t.kind === 'iri') return `<${t.iri}>`;
  if (t.kind === 'bnode') return `_:${t.id}`;
  if (t.kind === 'triple') return tripleTermTurtle(t);
  // escapeTurtleLiteral, not a local replace(): a constructed object is CALLER data, and
  // an unescaped `"` or newline in it would close the literal and inject triples into the
  // next fold step's parse.
  const lex = `"${escapeTurtleLiteral(t.value)}"`;
  if (t.language) return `${lex}@${t.language}`;
  if (t.datatype) return `${lex}^^<${t.datatype}>`;
  return lex;
}

function ruleSubjectTerm(subj: ParsedSubject): ParsedTerm {
  return typeof subj.subject === 'string'
    ? { kind: 'iri', iri: subj.subject as IRI }
    : { kind: 'bnode', id: subj.subject.bnode };
}

/**
 * Run every sh:TripleRule in `shapeSrc` over `dataSrc` and return the constructed triples.
 *
 * Output is deduped and lexically sorted so the same (data, shape) pair yields
 * byte-identical Turtle regardless of Map iteration order. The reduce verb hashes this
 * into a ReplayProof checkpoint, so an unstable order would make an honest replay look
 * like tampering.
 *
 * Emits full `<iri>` form rather than prefixed names: the result is concatenated with the
 * next chain link's own @prefix block, and a prefix that resolved differently in the two
 * documents would silently retarget the triples.
 */
export function runShaclRules(dataSrc: string, shapeSrc: string): ShaclRuleRun {
  let shapeDoc: ParsedDocument;
  try {
    shapeDoc = parseTrig(shapeSrc);
  } catch (e) {
    // Throw, do NOT fall back. An unparseable shape is the case the repro caught: it used
    // to yield the identical head as a valid shape, so a typo'd redaction rule redacted
    // nothing and said so to no one.
    throw new ShaclRuleError(`shape graph is not parseable Turtle: ${(e as Error).message}`);
  }
  const ruleBearing = shapeDoc.subjects.filter(s => (s.properties.get(SH_RULE) ?? []).length > 0);
  // No sh:rule anywhere: there is no transform to run. Report 0 and let the caller decide
  // (reduce treats it as a merge declaration). Parsing the data graph would be wasted work
  // and could throw on a shape that never intended to transform anything.
  if (ruleBearing.length === 0) return { ruleCount: 0, declaredRules: 0, tripleCount: 0, turtle: '' };

  let dataDoc: ParsedDocument;
  try {
    dataDoc = parseTrig(dataSrc);
  } catch (e) {
    throw new ShaclRuleError(`data graph is not parseable Turtle: ${(e as Error).message}`);
  }

  const ruleShapes = compileShapes(shapeDoc);
  const ruleById = new Map(ruleShapes.map(s => [s.id, s]));
  const nodesByKey = new Map(shapeDoc.subjects.map(s => [subjectKey(s), s]));

  const lines: string[] = [];
  let ruleCount = 0;
  let declaredRules = 0;

  /**
   * Resolve a `sh:subject` / `sh:object` term into either a VALUE PATH (the values of a
   * predicate at the focus node) or a CONSTANT, refusing every form in between.
   *
   * ★ SHACL-AF: an IRI is ALWAYS a constant. Only a blank node bearing `sh:path` is a
   * value path. Applying the value-path lookup to IRIs too — which is what this did —
   * resolved the constant against every subject in the shape document, so one unrelated
   * `ex:Redacted sh:path ex:ssn .` triple anywhere in the same file silently converted
   * `sh:object ex:Redacted` from "emit the constant" into "emit the SSN". Measured: the
   * rule a reviewer reads emitted `<r1> ex:status "111-22-3333"`. The rule that runs must
   * be the rule that is written.
   *
   * ★ AND A BLANK NODE IS NEVER A CONSTANT HERE. `asIri` returned undefined for a complex
   * path (`sh:inversePath`, a sequence collection) and for a bnode carrying no `sh:path`
   * at all, and the code then fell through to emitting the term itself — fabricating
   * `_:_anon1`, a SHAPE-GRAPH blank-node label, into the constructed data graph and into
   * the hashed headStateCid. That is worse than constructing fewer triples: it is a triple
   * pointing at a node that exists in neither graph, presented as independently verifiable.
   * It is also the cross-document identifier collision this function is careful to avoid
   * for @prefix and was not avoiding for `_:`. Every such form now throws.
   */
  const resolveRuleTerm = (
    term: ParsedTerm,
    role: 'sh:subject' | 'sh:object',
    shapeId: string,
  ): { readonly path: IRI } | { readonly constant: ParsedTerm } => {
    if (term.kind !== 'bnode') return { constant: term };
    const k = refKey(term);
    const node = k === undefined ? undefined : nodesByKey.get(k);
    if (!node) {
      throw new ShaclRuleError(
        `${role} on <${shapeId}> is a blank node that declares nothing; `
        + 'a blank node is only meaningful here as [ sh:path <predicate> ]',
      );
    }
    const pathTerm = getOne(node, SH_PATH);
    if (!pathTerm) {
      throw new ShaclRuleError(
        `${role} on <${shapeId}> is a blank node without sh:path; `
        + 'a blank node is only meaningful here as [ sh:path <predicate> ]',
      );
    }
    const pathIri = asIri(pathTerm);
    if (!pathIri) {
      throw new ShaclRuleError(
        `${role} on <${shapeId}> declares a complex sh:path expression `
        + '(inverse, sequence or alternative); this engine evaluates single-predicate paths only',
      );
    }
    return { path: pathIri };
  };

  for (const shapeSubj of ruleBearing) {
    const compiled = ruleById.get(subjectKey(shapeSubj));
    if (!compiled) {
      // compileShapes skips subjects without `a sh:NodeShape`. Such a shape selects no
      // focus nodes, so its rule would construct nothing and look like a rule that
      // legitimately matched zero rows — the exact confusion this function refuses.
      throw new ShaclRuleError(
        `sh:rule declared on <${subjectKey(shapeSubj)}> which is not a compiled sh:NodeShape`,
      );
    }
    // ★ THE OFF SWITCH IS NOT A SKIP-THE-CHECKS SWITCH. `sh:deactivated` used to `continue`
    // here, ABOVE every structural check below, so `sh:deactivated true` on the node shape
    // also bypassed the refusal guard: the ill-formed rule the suite pins as REFUSED became
    // silently acceptable, and — via the ruleCount conflation — folded the whole link body.
    // Whether a rule is well-formed is a property of the shape as written; whether it runs
    // is a separate question, answered further down.
    const shapeOff = compiled.deactivated;
    // Focus nodes are only needed to EMIT. Computing them for a switched-off shape is
    // wasted work over a data graph the rules will never read.
    const focus = shapeOff ? [] : findFocusNodes(dataDoc, compiled);
    for (const ruleRef of shapeSubj.properties.get(SH_RULE) ?? []) {
      const key = refKey(ruleRef);
      const ruleNode = key === undefined ? undefined : nodesByKey.get(key);
      if (!ruleNode) throw new ShaclRuleError(`sh:rule on <${compiled.id}> does not resolve to a rule node`);
      const types = getAll(ruleNode, RDF_TYPE).map(t => asIri(t)).filter((x): x is IRI => x !== undefined);
      if (types.includes(SH_SPARQL_RULE) || ruleNode.properties.has(SH_CONSTRUCT)) {
        // This repo ships SPARQL query BUILDERS and no evaluator, so a CONSTRUCT cannot be
        // executed here. Refusing is the only honest answer: the alternative the kernel
        // used to take was to union everything, which for a CONSTRUCT that narrows the
        // graph is the opposite result.
        throw new ShaclRuleError(
          `sh:SPARQLRule / sh:construct on <${compiled.id}> requires a SPARQL engine this substrate does not ship`,
        );
      }
      if (!types.includes(SH_TRIPLE_RULE)) {
        throw new ShaclRuleError(`sh:rule on <${compiled.id}> is not a sh:TripleRule`);
      }
      for (const p of ruleNode.properties.keys()) {
        if (p.startsWith(SHACL) && !TRIPLE_RULE_KNOWN.has(p)) {
          throw new ShaclRuleError(`sh:TripleRule on <${compiled.id}> declares unsupported ${p}`);
        }
      }
      const sTerm = getOne(ruleNode, SH_SUBJECT);
      const pTerm = getOne(ruleNode, SH_PREDICATE);
      const oTerm = getOne(ruleNode, SH_OBJECT);
      if (!sTerm || !pTerm || !oTerm) {
        // SHACL requires exactly one of each. An ill-formed rule constructs nothing, and
        // "nothing" folded into the reduce verb is an EMPTY head state that reads as a
        // successful fold.
        throw new ShaclRuleError(
          `sh:TripleRule on <${compiled.id}> must declare sh:subject, sh:predicate and sh:object`,
        );
      }
      const pIri = asIri(pTerm);
      if (!pIri) throw new ShaclRuleError(`sh:predicate on <${compiled.id}> must be an IRI`);
      // sh:object may be a constant term OR `[ sh:path <p> ]`, which means "the values of
      // <p> at the focus node". resolveRuleTerm refuses every other form; see its comment.
      const sIsThis = sTerm.kind === 'iri' && sTerm.iri === SH_THIS;
      const oIsThis = oTerm.kind === 'iri' && oTerm.iri === SH_THIS;
      const sResolved = sIsThis ? undefined : resolveRuleTerm(sTerm, 'sh:subject', compiled.id);
      const oResolved = oIsThis ? undefined : resolveRuleTerm(oTerm, 'sh:object', compiled.id);

      // ★ COUNTED HERE — after every structural check, before the off switch. This is what
      // tells `applyReducerStep` "this shape is a transform, not a merge declaration", and
      // it must stay true of a transform whose rules are switched off.
      declaredRules++;
      const deact = getOne(ruleNode, SH_DEACTIVATED);
      const ruleOff = deact?.kind === 'literal' && deact.value === 'true';
      // SHACL-AF: a deactivated rule infers NOTHING. It contributes no triples — which,
      // with declaredRules already incremented, the caller reads as the empty set rather
      // than as a licence to union the raw body.
      if (shapeOff || ruleOff) continue;
      ruleCount++;
      for (const f of focus) {
        const subjects: ParsedTerm[] = sIsThis
          ? [ruleSubjectTerm(f)]
          : sResolved && 'path' in sResolved
            ? [...getAll(f, sResolved.path)]
            : [sTerm];
        const objects: ParsedTerm[] = oIsThis
          ? [ruleSubjectTerm(f)]
          : oResolved && 'path' in oResolved
            ? [...getAll(f, oResolved.path)]
            : [oTerm];
        for (const s of subjects) {
          if (s.kind === 'literal') continue; // a literal cannot be a subject
          for (const o of objects) {
            lines.push(`${termToTurtle(s)} <${pIri}> ${termToTurtle(o)} .`);
          }
        }
      }
    }
  }

  const unique = [...new Set(lines)].sort();
  return { ruleCount, declaredRules, tripleCount: unique.length, turtle: unique.join('\n') };
}
