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
import { evaluateNodeExpression, type NodeExpressionContext } from './node-expression.js';
import {
  runSparql, evaluateSparqlExpression, SparqlRefusedError,
  type UserFunction, type Binding, type SparqlPathNode,
} from './sparql-query.js';

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
const SH_UNIQUE_VALUES_FOR = `${SHACL}uniqueValuesFor` as IRI;
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
const SH_SELECT = `${SHACL}select` as IRI;
const SH_ASK = `${SHACL}ask` as IRI;
const SH_PREFIXES = `${SHACL}prefixes` as IRI;
const SH_DECLARE = `${SHACL}declare` as IRI;
const SH_NAMESPACE = `${SHACL}namespace` as IRI;
const SH_PREFIX = `${SHACL}prefix` as IRI;
const SH_SHAPES_GRAPH_CLASS = `${SHACL}ShapesGraph` as IRI;
const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports' as IRI;
// SHACL 1.2 §7.8.5. Both are parameters of ONE component, sh:ReifierShapeConstraintComponent
// — sh:reificationRequired is not a component of its own, despite Appendix C of the WD
// appearing to name one (that heading is a ReSpec artifact, absent from the ED source and
// from both approved test cases).
const SH_REIFIER_SHAPE = `${SHACL}reifierShape` as IRI;
const SH_REIFICATION_REQUIRED = `${SHACL}reificationRequired` as IRI;
const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies' as IRI;
const SH_NODE = `${SHACL}node` as IRI;
const SH_NODE_BY_EXPRESSION = `${SHACL}nodeByExpression` as IRI;
const SH_EXPRESSION = `${SHACL}expression` as IRI;
const SH_VALUES = `${SHACL}values` as IRI;
const SH_CONSTRAINT_COMPONENT = `${SHACL}ConstraintComponent` as IRI;
const SH_PARAMETER = `${SHACL}parameter` as IRI;
const SH_OPTIONAL = `${SHACL}optional` as IRI;
const SH_VALIDATOR = `${SHACL}validator` as IRI;
const SH_NODE_VALIDATOR = `${SHACL}nodeValidator` as IRI;
const SH_PROPERTY_VALIDATOR = `${SHACL}propertyValidator` as IRI;
const SH_BODY_EXPRESSION = `${SHACL}bodyExpression` as IRI;
const SH_SPARQL_EXPR = `${SHACL}sparqlExpr` as IRI;

/**
 * The result component for a SPARQL constraint this engine REFUSED to run.
 *
 * Distinct from sh:SPARQLConstraintComponent on purpose: "the rule ran and the data failed"
 * and "the rule could not run" are the same VERDICT and different FACTS, and only one of
 * them means the shape was checked.
 */
export const SPARQL_REFUSED = 'urn:iep:shacl:SparqlRefused';
const SH_QUALIFIED_VALUE_SHAPE = `${SHACL}qualifiedValueShape` as IRI;
const SH_QUALIFIED_VALUE_SHAPES_DISJOINT = `${SHACL}qualifiedValueShapesDisjoint` as IRI;
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
  // ★ sh:sparql IS IMPLEMENTED NOW, so it must leave this sweep. Reporting an implemented
  // constraint as unsupported would pin `fullyChecked: false` on every graph the shape
  // selects, which is the same false claim as the reverse — the flag would say a check was
  // skipped when it ran. sh:select / sh:ask / sh:prefixes / sh:declare and the prefix
  // vocabulary are the constraint's INTERIOR and were already exempt.
  SH_SPARQL, SH_SELECT, SH_ASK, SH_PREFIXES, SH_DECLARE, SH_NAMESPACE, SH_PREFIX,
  SH_VALUES,
  // SPARQL-based constraint components: the shapes graph declares a new constraint kind
  // and the engine runs it, so reporting the vocabulary as unsupported would pin
  // fullyChecked:false on every graph a component touches.
  SH_PARAMETER, SH_OPTIONAL, SH_VALIDATOR, SH_NODE_VALIDATOR, SH_PROPERTY_VALIDATOR,
  // sh:function bodies. sh:sparqlExpr is evaluated as a bare expression inside one.
  SH_BODY_EXPRESSION, SH_SPARQL_EXPR,
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
  | { readonly kind: 'zeroOrOne'; readonly of: CompiledPath }
  /**
   * ★ NOT A SHACL PATH — an internal one, and the reason the whole node-level constraint
   * family now works.
   *
   * SHACL applies every value constraint at TWO levels: to the values a path yields, and to
   * the focus node itself. The second is the same twenty components evaluated over a
   * one-element value set. This engine had it as three separate hand-written
   * implementations — one for reporting, one for term conformance, one for subject
   * conformance — and each covered FOUR components: class, datatype, nodeKind, in.
   *
   * So `sh:minLength`, `sh:pattern`, `sh:minInclusive`, `sh:hasValue`, `sh:languageIn`,
   * `sh:equals`, `sh:node` and the rest simply did not exist at node level. They compiled,
   * they were dropped, and the shape reported conforms. Measured against the W3C SHACL 1.2
   * Core suite: twenty-two `tests/core/node/` entries failed, every one of them a component
   * the property-level evaluator has implemented and passed for months.
   *
   * A path yielding exactly the focus node turns "node level" into "property level over a
   * set of one", so there is one implementation instead of three and a component added to
   * the evaluator arrives at both levels at once. Results from it carry NO sh:resultPath,
   * which is what distinguishes them in the report — §6.7.2.2 gives resultPath only when
   * the constraint came from a property shape.
   */
  | { readonly kind: 'identity' };

/** The single shared instance; it carries no state. */
const IDENTITY_PATH: CompiledPath = { kind: 'identity' };

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
    // Never emitted as sh:resultPath — node-level results omit the field entirely — so this
    // appears only in a message, where naming the focus node is the honest rendering.
    case 'identity': return 'the focus node';
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
/**
 * A focus node that is not a subject of the graph.
 *
 * ★ `standInTerm` covers the two term kinds that can never have a subject to look up: a
 * LITERAL (`sh:targetNode "Hello"`, the suite's usual way to test a node-level constraint)
 * and, since RDF 1.2, a TRIPLE TERM — which SHACL 1.2 gives its own node kind, sh:TripleTerm,
 * so it can legitimately be a value node with constraints applied to it. Typed as a literal
 * alone, a triple term reaching here would be reported as the sentinel IRI, and
 * `sh:nodeKind sh:TripleTerm` would have judged the sentinel rather than the term.
 */
interface FocusNode extends ParsedSubject {
  readonly standInTerm?: ParsedLiteral | ParsedTripleTerm;
}

/**
 * The focus node for an arbitrary term — its description if the graph has one, otherwise a
 * property-less stand-in that still carries the term.
 *
 * ★ THE LITERAL CASE IS THE POINT. A literal has no subject in the graph and never will, so
 * `subjectFor` returns undefined for it and any check keyed on that answer silently skips
 * every literal focus node. `sh:targetNode "Hello"` is the suite's most common way to test a
 * node-level constraint, and `literalTerm` is how a focus node keeps its identity when
 * there is nothing in the graph to look up.
 */
/**
 * Placeholder subject for a focus node the graph cannot describe — a literal or a triple
 * term. Never surfaces in a report: subjectKey() keys off `standInTerm` when one is present,
 * so the reported focusNode is the term itself.
 */
const STAND_IN_FOCUS = 'urn:iep:shacl:standInFocus' as IRI;

function focusFor(data: ParsedDocument, term: ParsedTerm): FocusNode {
  const found = subjectFor(data, term);
  if (found) return found;
  if (term.kind === 'iri') return { subject: term.iri, properties: new Map() };
  if (term.kind === 'bnode') return { subject: { bnode: term.id }, properties: new Map() };
  return { subject: STAND_IN_FOCUS, properties: new Map(), standInTerm: term };
}

function subjectAsTerm(s: ParsedSubject): ParsedTerm {
  const stand = (s as FocusNode).standInTerm;
  if (stand) return stand;
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
      case 'identity': return [from];
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

  // ★ A CELL MAY BE NAMED. This walked blank nodes only, so `ex:list1 rdf:first 1 ;
  // rdf:rest ( 2 3 ) .` — a perfectly ordinary list with an IRI for a head — fell through
  // to "head is itself a value" and came back as a one-element list containing the head.
  // Turtle's `( … )` always produces blank nodes, which is why it is easy to write a list
  // walker that only knows about them; rdf:first and rdf:rest are just predicates.
  //
  // The discriminator is rdf:first, not the term kind, and it also keeps the case this
  // fallback exists for: `sh:in ex:Foo` names a VALUE, ex:Foo has no rdf:first, and it is
  // still returned as a single-member list.
  const cellFor = (t: ParsedTerm): ParsedSubject | undefined => {
    if (t.kind !== 'iri' && t.kind !== 'bnode') return undefined;
    const c = subjectFor(doc, t);
    return c?.properties.has(RDF_FIRST) ? c : undefined;
  };

  if (cellFor(head)) {
    const out: ParsedTerm[] = [];
    let cursor: ParsedTerm = head;
    const seen = new Set<string>();
    for (let i = 0; i < 1024; i++) {
      if (cursor.kind === 'iri' && cursor.iri === RDF_NIL) return out;
      const key = cursor.kind === 'iri' ? cursor.iri
        : cursor.kind === 'bnode' ? `_:${cursor.id}` : undefined;
      if (key === undefined || seen.has(key)) return out;
      seen.add(key);
      const cell = subjectFor(doc, cursor);
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
/**
 * A result's severity.
 *
 * ★ SHACL PUTS NO CEILING ON THIS: sh:severity takes ANY IRI, and the five below are simply
 * the ones the specification names. A vocabulary is free to define its own — the W3C Core
 * suite does exactly that, `sh:severity ex:MySeverity`, and expects it to survive into the
 * report. This engine folded every unrecognised IRI to 'Violation', which is not a missing
 * feature but a WRONG ANSWER: an author's advisory level came back as a hard refusal.
 *
 * A custom severity is carried as its full IRI. It is not in the default
 * sh:conformanceDisallows set — the spec names three severities there, and silently adding
 * an unknown one to them would put the fold back where it was, one level down.
 *
 * The union-with-`(string & {})` shape keeps editor completion for the five while accepting
 * any IRI, and every existing `=== 'Violation'` comparison keeps working unchanged.
 */
export type ShaclSeverity =
  | 'Violation' | 'Warning' | 'Info' | 'Debug' | 'Trace'
  | (string & Record<never, never>);

/** The five the specification names, in strictness order. */
const NAMED_SEVERITIES = ['Trace', 'Debug', 'Info', 'Warning', 'Violation'] as const;

/**
 * Decode a `sh:severity` value. One of the five names for a SHACL IRI, the full IRI for
 * anything else, `undefined` when there is no value.
 */
function decodeSeverity(iri: string | undefined): ShaclSeverity | undefined {
  if (iri === undefined) return undefined;
  if (iri.startsWith(SHACL)) {
    const local = iri.slice(SHACL.length);
    if ((NAMED_SEVERITIES as readonly string[]).includes(local)) return local as ShaclSeverity;
  }
  return iri;
}

export interface ShaclResult {
  readonly focusNode: string;
  readonly path?: string;
  readonly value?: string;
  readonly sourceShape?: string;
  readonly constraintComponent: string;
  readonly severity: ShaclSeverity;
  readonly message: string;
  /**
   * ★ NOT a SHACL validation result of this run — engine instrumentation, or a note about
   * what a DIFFERENT configuration would have found. Excluded from `conforms`.
   *
   * Two things live here, and neither is a statement about the data under the validation
   * the caller actually asked for:
   *   - entailment-observe notes, which report what `entailment: 'rdfs'` WOULD have
   *     rejected while the caller asked for no entailment;
   *   - unsupported-construct and entailment-incomplete notes, which report on the ENGINE.
   *
   * It is an explicit flag rather than "the constraint component is not a sh: one" because
   * the observe notes keep their real component — a consumer wants to know it was sh:closed
   * that would have fired — and sniffing the IRI would have silently reclassified them.
   *
   * An advisory MAY still be a Violation, and then it does refuse: the truncated-closure
   * note is fail-closed by design.
   */
  readonly advisory?: boolean;
}

export interface ShaclReport {
  readonly conforms: boolean;
  /**
   * The severities that defeated conformance for this run — the effective
   * sh:conformanceDisallows. Reported because `conforms` alone is ambiguous once it is
   * configurable: the same false can mean "a violation" or "a warning, and you asked".
   */
  readonly conformanceDisallows: readonly ShaclSeverity[];
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
  /**
   * How many shapes the SHAPES GRAPH declared — before any of them were matched against the
   * data. Zero means the document handed in as a shapes graph is not one.
   *
   * ★★ THE REPORT COULD NOT SAY WHAT IT VALIDATED AGAINST, AND THAT IS A CONFIRMATION OF
   * SOMETHING ADJACENT TO WHAT WAS ASKED. Measured on this engine before this field existed,
   * against a data graph that a real shapes file rejects:
   *
   *     validateAgainstShape(badTurn, harness-shapes.ttl)  conforms=false results=1
   *     validateAgainstShape(badTurn, harness.ttl)         conforms=true  results=0
   *     validateAgainstShape(badTurn, a DESCRIPTOR doc)    conforms=true  results=0
   *     validateAgainstShape(badTurn, "# nothing\n")       conforms=true  results=0
   *
   * The last three are byte-identical to a genuine clean pass — `conforms:true`,
   * `fullyChecked:true`, no results — so a caller who named the wrong document got a
   * success that ENDED THE ENQUIRY WITHOUT ANSWERING IT. A failure would have sent them
   * back to look; this did not. Validating against an empty shapes graph is arguably
   * correct SHACL (§1.5 — nothing is violated when nothing constrains), so the defect was
   * never the verdict. It was the silence around it.
   *
   * ★ WHY A COUNT HERE AND A REFUSAL AT THE GATE, NOT A REFUSAL HERE. This function is also
   * used as a PARSE PROBE — `deploy/mcp-relay/server.ts` calls `validateAgainstShape('',
   * body)` purely to ask whether a fetched body is Turtle at all, and `shacl-rules.ts`
   * validates `sh:condition` against fragments. Making zero shapes non-conforming would
   * break both, and would also be a false statement about the DATA: the graph broke no
   * rule. Whether zero shapes is acceptable is a property of the CALLER'S REQUEST, exactly
   * as `conformanceDisallows` is, so the engine reports and the caller decides.
   *
   * Counts COMPILED shapes, which includes standalone property shapes and inline shapes
   * reachable through sh:node / sh:qualifiedValueShape / sh:and / sh:or / sh:xone — the same
   * set `compileShapes` hands the validation loop. A `sh:deactivated` shape still counts: its
   * author wrote a shape and switched it off, which is a different fact from never having
   * written one, and collapsing the two would put a smaller silence back in.
   */
  readonly shapesDeclared: number;
  /**
   * How many of those shapes actually SELECTED A FOCUS NODE in this data graph.
   *
   * ★ ZERO HERE IS NOT AN ERROR, and that is why it is reported separately from
   * {@link shapesDeclared} rather than folded into it. A shapes file targeting twenty
   * classes run against a graph carrying none of them applies zero shapes and conforms —
   * ordinary, correct, and by far the common case for a container-declared contract. Only
   * `shapesDeclared === 0` says the document was never a shapes graph.
   *
   * Taken from the SAME liveness set the unsupported-construct escalation reads, so the two
   * cannot drift into disagreeing about which shapes ran.
   */
  readonly shapesApplied: number;
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
  /**
   * SHACL 1.2 sh:conformanceDisallows — which severities defeat conformance for THIS run.
   *
   * ★ Defaults to Info, Warning and Violation, which is the spec default and the reading
   * the W3C suite checks. sh:Trace and sh:Debug are never in the set.
   *
   * This is also the honest home for the behaviour this engine used to have by mistake.
   * `conforms` counted Violations only, everywhere, with no way to ask for anything else —
   * so a caller who genuinely wanted "warnings are advisory here" and a caller who wanted
   * the spec got the same wrong answer. Passing `['Violation']` now says so out loud, at
   * the call site, and is visible in the report.
   */
  readonly conformanceDisallows?: readonly ShaclSeverity[];
}

interface PropertyShape {
  readonly id: string;
  /** Rendering for sh:resultPath and messages; the predicate IRI for a simple path. */
  readonly path: IRI;
  /** The compiled path actually evaluated. A predicate path is the common case. */
  readonly pathExpr: CompiledPath;
  readonly minCount?: number;
  readonly maxCount?: number;
  /**
   * One entry per parameter TRIPLE; within an entry, the alternatives from a 1.2 list value.
   * Repeating the parameter conjoins; listing its values disjoins. See eachIriOrList.
   */
  readonly datatypes?: readonly (readonly IRI[])[];
  readonly nodeKinds?: readonly (readonly IRI[])[];
  readonly classes?: readonly (readonly IRI[])[];
  readonly pattern?: string;
  readonly hasValue?: ParsedTerm;
  /** sh:in. `undefined` is absent; `[]` is `sh:in ()`, which permits nothing. */
  readonly inValues?: readonly ParsedTerm[];
  /**
   * SHACL 1.2 sh:nodeByExpression — the value must conform to every shape the NODE
   * EXPRESSION yields, rather than to a shape named directly.
   *
   * ★ The difference from sh:node is that the shape is COMPUTED. `sh:node ex:S` fixes the
   * shape at authoring time; this one can select it from the data — which is how a profile
   * says "conform to whichever shape your own rdf:type nominates" without enumerating the
   * types in advance.
   */
  readonly nodeByExpression?: ParsedTerm;
  /**
   * SHACL 1.2 sh:expression — the node expression must evaluate to `true` for the value.
   *
   * ★ The general escape hatch of the 1.2 constraint set: anything the fixed components
   * cannot say, an expression can compute. `sh:expression false` is the degenerate case the
   * suite uses, and it must refuse every focus node.
   */
  readonly expression?: ParsedTerm;
  /**
   * SHACL 1.2 sh:values — the value nodes are COMPUTED by a node expression rather than
   * read from the path.
   *
   * ★ Without it the path yields nothing and every constraint written about the derived
   * values fails, which REFUSES A VALID GRAPH. `sh:path ex:fullName ; sh:values [ sh:select
   * … CONCAT(?first, " ", ?last) … ] ; sh:hasValue "John Muir"` is the suite's example and
   * the natural shape of a derived field.
   */
  readonly valuesExpr?: ParsedTerm;
  /** The property shape's own subject — a constraint component activates on ITS predicates. */
  readonly subject?: ParsedSubject;
  /**
   * sh:property ON A PROPERTY SHAPE — each VALUE NODE is a focus node for these.
   *
   * ★ Only node shapes carried sh:property here, so the idiomatic way to reach two levels
   * down without naming an intermediate shape —
   *   `sh:property [ sh:path ex:address ; sh:property [ sh:path ex:city ; sh:class ex:City ] ]`
   * — compiled the outer shape, ignored the inner one, and validated the address without
   * ever looking at the city. Nesting is what makes a shape describe a structure rather
   * than a single hop, so this was not a corner: it is how depth is written.
   */
  readonly propertyShapes?: readonly PropertyShape[];
  readonly message?: string;
  /**
   * ── value range ──
   *
   * ★ THE BOUND IS A TERM, NOT A NUMBER, and storing it as a number is why every non-numeric
   * range constraint silently vanished. `num()` returns undefined for a literal whose lexical
   * form is not finite, so `sh:minInclusive "2002-10-10T12:00:00"^^xsd:dateTime` compiled to
   * `undefined` and the constraint was simply absent — no note, no unsupported-construct
   * report, nothing. A shape ordering timestamps is the ordinary case for anything carrying
   * a validity window, and this repo publishes several.
   *
   * §4.3 defines these by the SPARQL relational operators, which are typed: they order
   * numerics with numerics, dates with dates, strings with strings, and raise a type error
   * otherwise. SHACL treats that error as a VIOLATION, not as a skip — see compareForRange.
   */
  readonly minInclusive?: ParsedTerm;
  readonly maxInclusive?: ParsedTerm;
  readonly minExclusive?: ParsedTerm;
  readonly maxExclusive?: ParsedTerm;
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
   * `sh:sparql` declared ON THIS PROPERTY SHAPE.
   *
   * ★ NOT THE SAME CONSTRAINTS AS THE NODE SHAPE'S, and running them from there would get
   * both `$PATH` and `sh:resultPath` wrong. `sh:property [ sh:path ex:p ; sh:sparql … ]` is
   * ordinary SHACL, and it was silently inert: constraints were compiled only for shapes
   * reached as node shapes, and a nested property shape is never one.
   */
  readonly sparqlConstraints?: readonly SparqlConstraint[];
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
  /** SHACL 1.2 §3.1.4 — per-constraint severity/message/deactivated from a reifier. */
  readonly overrides?: ReadonlyMap<string, ConstraintOverride>;
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
  /**
   * sh:qualifiedValueShapesDisjoint — a value that ALSO conforms to a sibling property
   * shape's sh:qualifiedValueShape does not count toward this one.
   *
   * ★ It is the whole point of the constraint, and it was parsed by nothing. "A hand has one
   * thumb and four fingers" is unenforceable without it: a node that is both a Thumb and a
   * Finger satisfies both counts at once, so four digits pass as five. Disjointness is what
   * makes the counts partition rather than overlap.
   */
  readonly qualifiedValueShapesDisjoint?: boolean;
  readonly qualifiedMinCount?: number;
  readonly qualifiedMaxCount?: number;
}

interface NodeShape {
  readonly id: string;
  readonly targetClasses: readonly IRI[];
  /**
   * sh:targetNode — §2.1.3.2: "the set of nodes that are values of sh:targetNode".
   *
   * ★ TERMS, NOT IRIs. This was `readonly IRI[]`, built by mapping the values through
   * asIri() and dropping whatever came back undefined — so a LITERAL or BLANK NODE target
   * was discarded at compile time, without a note, and the shape selected nothing.
   *
   * A literal target is not an exotic case: it is how you state a constraint about a value
   * rather than about a resource, and it is how the W3C Core suite writes almost every
   * node-level test (`sh:datatype xsd:integer ; sh:targetNode "Hello"`). Twenty-two of
   * those failed here, all of them looking like missing constraint components, when the
   * constraints were implemented and simply never reached a focus node.
   */
  readonly targetNodes: readonly ParsedTerm[];
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
  /**
   * SHACL 1.2 §3.1.4 — per-CONSTRAINT severity/message/deactivated, carried on a reifier of
   * the constraint triple. Keyed by constraint component name. See constraintOverrides().
   */
  readonly overrides?: ReadonlyMap<string, ConstraintOverride>;
  /** sh:sparql — SHACL-SPARQL constraints attached to this shape. */
  readonly sparqlConstraints?: readonly SparqlConstraint[];
  /**
   * The shape's own subject in the shapes graph.
   *
   * ★ Kept because a SPARQL-based constraint component is activated by a predicate the
   * engine has never heard of — `ex:requiredParam "One"` on the shape — and its VALUE is the
   * pre-binding. There is nowhere else to read that from: the compiler cannot know in
   * advance which predicates matter, because the shapes graph decides.
   */
  readonly subject?: ParsedSubject;
  /**
   * ★ This shape's own constraints, compiled over the identity path — every value
   * constraint SHACL applies to the FOCUS NODE. Undefined when the shape declares none.
   * See the `identity` case of CompiledPath for what this replaced and why.
   */
  readonly nodeLevelShape?: PropertyShape;
  /**
   * SHACL 1.2 sh:uniqueValuesFor — the ONE component in Core that is not a statement about
   * a single focus node.
   *
   * Every other constraint here can be decided from one focus node and the data reachable
   * from it. This one says the values are unique ACROSS the shape's whole target set, so it
   * cannot be evaluated inside the per-focus-node loop at all and lives beside it instead.
   * A composite key is a list of paths, and a focus node missing a value for any of them
   * does not participate.
   */
  readonly uniqueValuesFor?: readonly CompiledPath[];
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
  const stand = (subj as FocusNode).standInTerm;
  if (stand) {
    return stand.kind === 'literal'
      ? JSON.stringify(['literal', stand.value, stand.datatype ?? '', stand.language ?? ''])
      : JSON.stringify(['triple', termValue(stand)]);
  }
  return typeof subj.subject === 'string' ? subj.subject : `_:${subj.subject.bnode}`;
}

/**
 * How a focus node is NAMED in a validation result — as distinct from how it is KEYED.
 *
 * ★ THE TWO ARE NOT THE SAME STRING, and using the key for both is why every node-level
 * result named its focus node `["literal","Hello","",""]`. subjectKey() has to distinguish
 * "1"^^xsd:integer from "1"^^xsd:string so a dedup set does not merge them, so it encodes
 * the datatype and language. sh:focusNode is the NODE, and for a literal that is its
 * lexical form — which is what the W3C suite compares against and what a reader expects.
 */
function focusLabel(focus: ParsedSubject): string {
  const stand = (focus as FocusNode).standInTerm;
  if (stand) return termValue(stand);
  return typeof focus.subject === 'string' ? focus.subject : `_:${focus.subject.bnode}`;
}

/**
 * Predicates whose presence makes their SUBJECT a shape, per §2.1.1.
 *
 * ★ rdf:type IS NOT THE ONLY WAY TO DECLARE A SHAPE, and requiring it silently discarded
 * whole shapes. §2.1.1 lists four sufficient conditions and we implemented one: a node is
 * also a shape if it is the subject of a triple whose predicate is a TARGET or a CONSTRAINT
 * PARAMETER. `ex:TestShape1 sh:nodeKind sh:BlankNode ; sh:targetNode ex:X .` is a complete,
 * well-formed shape with no rdf:type anywhere, and we compiled nothing from it.
 *
 * The set is derived from PARAM_COMPONENT rather than written out again, so a parameter
 * added there is recognised here too — the alternative is a second list that drifts, and
 * the symptom of drift is a shape that quietly stops being one.
 */
let shapeDeclaringPredicates: ReadonlySet<string> | undefined;
function shapeDeclaring(): ReadonlySet<string> {
  // Built on first use: PARAM_COMPONENT is declared further down the file, and referencing
  // it from a module-level initialiser here is a temporal-dead-zone crash at import time.
  shapeDeclaringPredicates ??= new Set<string>([
    SH_TARGET_CLASS, SH_TARGET_NODE, SH_TARGET_SUBJECTS_OF, SH_TARGET_OBJECTS_OF,
    SH_TARGET_WHERE, SH_PATH,
    ...PARAM_COMPONENT.keys(),
  ]);
  return shapeDeclaringPredicates;
}

function isShape(subj: ParsedSubject): boolean {
  const types = subj.properties.get(RDF_TYPE) ?? [];
  // ★ sh:ShapeClass IS A NODE SHAPE, and that is the whole meaning of the term: a class that
  // is ALSO a shape, so its instances are its targets without a `sh:targetClass` triple. The
  // implicit-class-target check downstream already knew that; this one did not, so a shape
  // written `ex:Person a sh:ShapeClass ; sh:rule …` — no other marker, which is how the
  // spec's own rules examples are written — compiled to nothing at all, and the rule hanging
  // off it had no focus nodes.
  //
  // NOT `sh:rule` itself, though it is tempting from the same fixture: a rule needs a shape
  // to say WHICH nodes it applies to, and a node carrying only sh:rule names none.
  if (types.some(t => t.kind === 'iri'
    && (t.iri === SH_NODE_SHAPE || t.iri === SH_PROPERTY_SHAPE || t.iri === SH_SHAPE_CLASS))) {
    return true;
  }
  for (const pred of subj.properties.keys()) {
    if (shapeDeclaring().has(pred)) return true;
  }
  return false;
}

/**
 * SHACL 1.2 §3.1.4: sh:severity, sh:message and sh:deactivated may be attached to a REIFIER
 * of the constraint triple, giving them PER-CONSTRAINT scope instead of per-shape.
 *
 * The reified triple is (shape, parameter, value) — `sh:minCount 1 {| sh:severity sh:Info |}`
 * in Turtle 1.2. Not the sh:property link, not the sh:path triple, not the shape node.
 *
 * ★ This is the last SHACL 1.2 generalisation, and it only became implementable when the
 * parser learned annotation syntax: the reifier arrives here as an ordinary subject carrying
 * `rdf:reifies` at a triple term, so nothing here needs to know `{| |}` exists.
 *
 * Keyed by CONSTRAINT COMPONENT rather than by parameter, so the evaluator can look up an
 * override with the same string it already passes to fail().
 */
const PARAM_COMPONENT: ReadonlyMap<string, string> = new Map<string, string>([
  // ★ sh:property IS a constraint parameter (§4.8.1), not merely structure — which is why
  // it can be deactivated one value at a time. Omitting it made
  // `sh:property X {| sh:deactivated true |}` parse cleanly and change nothing.
  [SH_PROPERTY, 'PropertyConstraintComponent'],
  [SH_MIN_COUNT, 'MinCountConstraintComponent'],
  [SH_MAX_COUNT, 'MaxCountConstraintComponent'],
  [SH_DATATYPE, 'DatatypeConstraintComponent'],
  [SH_CLASS, 'ClassConstraintComponent'],
  [SH_NODE_KIND, 'NodeKindConstraintComponent'],
  [SH_PATTERN, 'PatternConstraintComponent'],
  [SH_IN, 'InConstraintComponent'],
  [SH_HAS_VALUE, 'HasValueConstraintComponent'],
  [SH_MIN_INCLUSIVE, 'MinInclusiveConstraintComponent'],
  [SH_MAX_INCLUSIVE, 'MaxInclusiveConstraintComponent'],
  [SH_MIN_EXCLUSIVE, 'MinExclusiveConstraintComponent'],
  [SH_MAX_EXCLUSIVE, 'MaxExclusiveConstraintComponent'],
  [SH_MIN_LENGTH, 'MinLengthConstraintComponent'],
  [SH_MAX_LENGTH, 'MaxLengthConstraintComponent'],
  [SH_NODE, 'NodeConstraintComponent'],
  [SH_NODE_BY_EXPRESSION, 'NodeByExpressionConstraintComponent'],
  [SH_EXPRESSION, 'ExpressionConstraintComponent'],
  [SH_REIFIER_SHAPE, 'ReifierShapeConstraintComponent'],
]);

export interface ConstraintOverride {
  readonly severity?: ShaclSeverity;
  readonly message?: string;
  readonly deactivated?: boolean;
}

/** Key for an override that applies to ONE value of a repeatable parameter. */
function valueScopedKey(component: string, value: ParsedTerm): string {
  return JSON.stringify([component, value.kind, termValue(value)]);
}

function constraintOverrides(
  doc: ParsedDocument,
  subj: ParsedSubject,
): ReadonlyMap<string, ConstraintOverride> | undefined {
  const shapeKey = subjectKey(subj);
  let out: Map<string, ConstraintOverride> | undefined;
  for (const r of doc.subjects) {
    for (const t of r.properties.get(RDF_REIFIES) ?? []) {
      if (t.kind !== 'triple') continue;
      const s = t.subject.kind === 'iri' ? t.subject.iri : `_:${t.subject.id}`;
      if (s !== shapeKey) continue;
      const component = PARAM_COMPONENT.get(t.predicate);
      if (component === undefined) continue;
      const sevIri = asIri(r.properties.get(SH_SEVERITY)?.[0]);
      const msgTerm = r.properties.get(SH_MESSAGE)?.[0];
      const deacTerm = r.properties.get(SH_DEACTIVATED)?.[0];
      const entry: ConstraintOverride = {
        severity: decodeSeverity(sevIri),
        message: msgTerm?.kind === 'literal' ? msgTerm.value : undefined,
        deactivated: deacTerm?.kind === 'literal' && deacTerm.value === 'true' ? true : undefined,
      };
      if (entry.severity === undefined && entry.message === undefined
        && entry.deactivated === undefined) continue;
      out ??= new Map<string, ConstraintOverride>();
      out.set(component, entry);
      // ★ ALSO KEYED BY THE VALUE, because a parameter can be REPEATED and the reifier
      // annotates ONE triple. `sh:property A {| sh:deactivated true |} ; sh:property B .`
      // switches off A and leaves B running; keyed by component alone, the second write
      // would clobber the first and both would take whichever override was parsed last.
      // Constraints that can only appear once are unaffected — they just get two keys.
      out.set(valueScopedKey(component, t.object), entry);
    }
  }
  return out;
}

/**
 * Compile the constraint parameters on one subject.
 *
 * `nodeLevel` compiles the SAME parameters as a node shape's own constraints, over the
 * identity path — see the CompiledPath comment for why that is one function rather than
 * three. Two families are deliberately excluded in that mode:
 *
 *   - sh:minCount / sh:maxCount are property-parameter-only (§4.2). "The focus node occurs
 *     at least twice" is not a statement SHACL can make, and compiling them here would
 *     invent a constraint from a shape that never declared one.
 *   - sh:not / sh:and / sh:or / sh:xone are already evaluated for node shapes by
 *     logicalResults(). Compiling them again here would report every logical violation
 *     twice, which a verdict-only check would never notice.
 */
/**
 * Does this compiled shape actually constrain anything?
 *
 * ★ Written as "every key that is NOT bookkeeping" rather than a list of constraint keys,
 * because the failure mode of the other direction is silent: a component added to
 * PropertyShape and forgotten here would compile, evaluate at property level, and be
 * dropped at node level — the exact bug the identity path exists to remove, reintroduced
 * one constraint at a time.
 */
const NON_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
  'id', 'path', 'pathExpr', 'message', 'severity', 'deactivated', 'overrides',
]);
function carriesConstraint(ps: PropertyShape): boolean {
  for (const [k, v] of Object.entries(ps)) {
    if (NON_CONSTRAINT_KEYS.has(k) || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return true;
  }
  return false;
}

function compilePropertyShape(
  doc: ParsedDocument, subj: ParsedSubject, nodeLevel = false,
): PropertyShape | null {
  // ★ A non-IRI sh:path used to return null here, dropping the entire property shape and
  // every constraint on it. Complex paths now compile; only a path this engine genuinely
  // cannot express still returns null, and the sweep reports that case.
  const pathTerm = getOne(subj, SH_PATH);
  const pathExpr = nodeLevel ? IDENTITY_PATH : compilePath(doc, pathTerm);
  if (!pathExpr) return null;
  const path = renderPath(pathExpr) as IRI;
  const minCountLit = nodeLevel ? undefined : asLiteral(getOne(subj, SH_MIN_COUNT));
  const maxCountLit = nodeLevel ? undefined : asLiteral(getOne(subj, SH_MAX_COUNT));
  // sh:in resolution: every object under sh:in is either
  //   - the head of an rdf:List (Turtle Collection form), or
  //   - a direct value (comma form / single value).
  // walkRdfList handles all three; flatten so the engine's downstream
  // termsEqual sweep sees a flat allowed-value set regardless of how
  // the shape author wrote it.
  // ★ `sh:in ()` IS A CONSTRAINT, AND AN UNSATISFIABLE ONE. An empty enumeration permits
  // nothing, so every value violates it. Collapsing "no sh:in at all" and "sh:in ()" into
  // one empty array made the second disappear — the fail-OPEN direction, where a shape
  // written to admit nothing admits everything. `undefined` now means absent.
  const rawIn = getAll(subj, SH_IN);
  const inValues: ParsedTerm[] | undefined = rawIn.length === 0 ? undefined : [];
  for (const head of rawIn) {
    for (const v of walkRdfList(doc, head)) inValues!.push(v);
  }
  // A node-level shape is the node shape wearing a property shape's clothes; its sh:sparql
  // belongs to the node shape and is run from there, so reading it here would double it.
  const sparqlConstraints = nodeLevel ? [] : compileSparqlConstraints(doc, subj);
  return {
    id: subjectKey(subj),
    path,
    pathExpr,
    ...(sparqlConstraints.length > 0 ? { sparqlConstraints } : {}),
    minCount: minCountLit !== undefined ? parseInt(minCountLit, 10) : undefined,
    maxCount: maxCountLit !== undefined ? parseInt(maxCountLit, 10) : undefined,
    datatypes: eachIriOrList(doc, getAll(subj, SH_DATATYPE)),
    nodeKinds: eachIriOrList(doc, getAll(subj, SH_NODE_KIND)),
    classes: eachIriOrList(doc, getAll(subj, SH_CLASS)),
    pattern: asLiteral(getOne(subj, SH_PATTERN)),
    hasValue: getOne(subj, SH_HAS_VALUE),
    inValues,
    message: asLiteral(getOne(subj, SH_MESSAGE)),
    minInclusive: getOne(subj, SH_MIN_INCLUSIVE),
    maxInclusive: getOne(subj, SH_MAX_INCLUSIVE),
    minExclusive: getOne(subj, SH_MIN_EXCLUSIVE),
    maxExclusive: getOne(subj, SH_MAX_EXCLUSIVE),
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
    subject: subj,
    valuesExpr: nodeLevel ? undefined : getOne(subj, SH_VALUES),
    nodeByExpression: getOne(subj, SH_NODE_BY_EXPRESSION),
    expression: getOne(subj, SH_EXPRESSION),
    // Nested property shapes apply to the VALUE nodes, so they are compiled here rather
    // than by compileShapes — which only ever looked at node shapes.
    // Suppressed in nodeLevel mode for the same reason as the logicals: a NODE shape's
    // sh:property is already compiled by compileShapes, and compiling it again here would
    // report every nested violation twice.
    propertyShapes: (nodeLevel ? [] : getAll(subj, SH_PROPERTY))
      .map(ref => {
        const k = refKey(ref);
        const target = k === undefined ? undefined : subjectFor(doc, ref);
        return target ? compilePropertyShape(doc, target) : null;
      })
      .filter((x): x is PropertyShape => x !== null && x !== undefined),
    // Excluded in nodeLevel mode: logicalResults() already owns these for a node shape.
    notShapes: nodeLevel
      ? undefined : getAll(subj, SH_NOT).map(refKey).filter((k): k is string => k !== undefined),
    andShapes: nodeLevel ? undefined : listShapeRefs(doc, subj, SH_AND),
    orShapes: nodeLevel ? undefined : listShapeRefs(doc, subj, SH_OR),
    xoneShapes: nodeLevel ? undefined : listShapeRefs(doc, subj, SH_XONE),
    overrides: constraintOverrides(doc, subj),
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
    qualifiedValueShapesDisjoint: (() => {
      const t = getOne(subj, SH_QUALIFIED_VALUE_SHAPES_DISJOINT);
      return t?.kind === 'literal' && t.value === 'true' ? true : undefined;
    })(),
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
    severity: decodeSeverity(asIri(getOne(subj, SH_SEVERITY))),
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

/**
 * Every value of a parameter, each compiled to its own set of alternatives.
 *
 * ★ REPEATING A PARAMETER AND LISTING ITS VALUES MEAN OPPOSITE THINGS, and we read only the
 * first value, so one of them was silently discarded.
 *
 *   sh:class ( ex:Person ex:Animal )        — ONE constraint: Person OR Animal (1.2 §4.1.1)
 *   sh:class ex:Person ; sh:class ex:Animal — TWO constraints: Person AND Animal
 *
 * The second is just RDF: two triples are two constraints, and SHACL never says otherwise.
 * Reading `getOne` meant `sh:class ex:Person ; sh:class ex:Animal` enforced Person alone,
 * so a node that was a Person and not an Animal passed a shape that demanded both — and a
 * node that was neither produced one result where the suite expects two, one per constraint.
 */
function eachIriOrList(
  doc: ParsedDocument, terms: readonly ParsedTerm[],
): readonly (readonly IRI[])[] | undefined {
  const out: (readonly IRI[])[] = [];
  for (const t of terms) {
    const one = iriOrList(doc, t);
    if (one) out.push(one);
  }
  return out.length > 0 ? out : undefined;
}

/** The members of a SHACL list value node, or undefined when it is not a well-formed list. */
function listMembers(doc: ParsedDocument, v: ParsedTerm): readonly ParsedTerm[] | undefined {
  if (v.kind === 'iri' && v.iri === RDF_NIL) return [];
  // ★ A LIST HEAD MAY BE AN IRI. Turtle's `( … )` produces blank nodes, so it is easy to
  // believe a list is always blank-node-headed — but rdf:first / rdf:rest are ordinary
  // predicates and `ex:list0 rdf:first 1 ; rdf:rest ( 2 ) .` is a perfectly good list with
  // a name. Rejecting IRIs made every NAMED list "not a SHACL list", which turned
  // sh:maxListLength and its siblings into the opposite of themselves: the conforming lists
  // were reported and the over-long one was not looked at.
  if (v.kind !== 'iri' && v.kind !== 'bnode') return undefined;
  const subj = subjectFor(doc, v);
  // No rdf:first is not a list; §7.5 makes that a violation, not a pass.
  if (!subj?.properties.has(RDF_FIRST)) return undefined;

  // ★ WALKED STRICTLY HERE, unlike walkRdfList. A cell with rdf:first and NO rdf:rest is a
  // TRUNCATED list, and walkRdfList returns what it found so far — which is the right
  // behaviour for `sh:in ( … )`, where a malformed shape should not take the whole shape
  // down, and the wrong answer for the list constraints, whose question is precisely
  // "is this a well-formed SHACL list?". `ex:list4 rdf:first ex:Alice .` came back as a
  // valid one-element list and satisfied sh:memberShape.
  const out: ParsedTerm[] = [];
  let cursor: ParsedTerm = v;
  const seen = new Set<string>();
  for (let i = 0; i < 4096; i++) {
    if (cursor.kind === 'iri' && cursor.iri === RDF_NIL) return out;
    const k = cursor.kind === 'iri' ? cursor.iri
      : cursor.kind === 'bnode' ? `_:${cursor.id}` : undefined;
    if (k === undefined || seen.has(k)) return undefined;   // literal cell, or a cycle
    seen.add(k);
    const cell = subjectFor(doc, cursor);
    const first = cell?.properties.get(RDF_FIRST)?.[0];
    const rest = cell?.properties.get(RDF_REST)?.[0];
    if (first === undefined || rest === undefined) return undefined;   // truncated
    out.push(first);
    cursor = rest;
  }
  return undefined;   // longer than any real list; treat as malformed rather than truncate
}

/**
 * The shape refs in an rdf:List value of `pred` (sh:and / sh:or / sh:xone).
 *
 * ★ `undefined` IS NOT `[]` HERE. This returned `[]` for both "the predicate is absent" and
 * "the predicate's value is the empty list", and the evaluator then guarded on
 * `length > 0` — so `sh:xone ()` and `sh:or ()`, which are UNSATISFIABLE (exactly one of
 * zero shapes; at least one of zero shapes), were treated as no constraint at all. A shape
 * written to admit nothing admitted everything.
 *
 * sh:and () is the one that really is vacuous — "conforms to every shape in an empty list"
 * is true — so it keeps passing, for a reason rather than by accident.
 */
function listShapeRefs(
  doc: ParsedDocument, subj: ParsedSubject, pred: IRI,
): readonly string[] | undefined {
  const head = subj.properties.get(pred)?.[0];
  if (!head) return undefined;
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

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'integer', 'decimal', 'float', 'double', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
].map(t => `${XSD}${t}`));
const TEMPORAL_TYPES: ReadonlySet<string> = new Set(
  ['dateTime', 'dateTimeStamp', 'date'].map(t => `${XSD}${t}`));

/**
 * Order two terms the way SPARQL's relational operators do, or undefined if it cannot.
 *
 * ★ UNDEFINED MEANS "TYPE ERROR", WHICH SHACL MAKES A VIOLATION — not "no opinion". The
 * three families order only within themselves, and a cross-family comparison is an error
 * rather than a fallback to string order.
 *
 * ★ AND A dateTime WITH A TIMEZONE DOES NOT ORDER AGAINST ONE WITHOUT. XSD calls that
 * indeterminate, and the suite pins both directions: with the bound timezoned,
 * `"2002-10-10T12:00:00"^^xsd:dateTime` violates; with the bound NOT timezoned, all three
 * timezoned values violate — including one that is plainly later on the clock. Reading the
 * untimed form as UTC is the tempting shortcut and would make the first case pass.
 */
function compareForRange(a: ParsedTerm, b: ParsedTerm): number | undefined {
  if (a.kind !== 'literal' || b.kind !== 'literal') return undefined;
  const at = a.datatype ?? '';
  const bt = b.datatype ?? '';
  if (NUMERIC_TYPES.has(at) && NUMERIC_TYPES.has(bt)) {
    const x = Number(a.value);
    const y = Number(b.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (TEMPORAL_TYPES.has(at) && TEMPORAL_TYPES.has(bt)) {
    const tzRe = /(Z|[+-]\d\d:\d\d)$/;
    const tzA = tzRe.test(a.value);
    const tzB = tzRe.test(b.value);
    if (tzA !== tzB) return undefined;               // indeterminate, per XSD
    const x = Date.parse(tzA ? a.value : `${a.value}Z`);
    const y = Date.parse(tzB ? b.value : `${b.value}Z`);
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // Plain literals and xsd:string order by codepoint. A language-tagged literal does not
  // order against anything: SPARQL raises on it, and so do we.
  const strish = (t: ParsedLiteral): boolean =>
    t.language === undefined && (t.datatype === undefined || t.datatype === `${XSD}string`);
  if (strish(a) && strish(b)) return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  return undefined;
}

/** Numeric value of a literal, or undefined. Non-numeric lexical forms are not an
 *  error here — they simply do not participate in a numeric range check. */
function num(t: ParsedTerm | undefined): number | undefined {
  if (t?.kind !== 'literal') return undefined;
  const n = Number(t.value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Render a SHACL path NODE the way this engine renders the path in `ShaclResult.path`.
 *
 * ★ EXPORTED FOR ONE CALLER, AND FOR A REASON THAT IS NOT CONVENIENCE. sh:resultPath is an
 * RDF path expression, so for anything but a predicate path the W3C suite names it with a
 * BLANK NODE — the head of the rdf:List, or the node carrying sh:inversePath. There is no
 * string to compare against: bnode labels do not survive between graphs, and comparing them
 * would be comparing nothing.
 *
 * Putting both sides through this renderer compares the path STRUCTURE, which is the thing
 * the assertion is actually about — did the engine attribute this result to the sequence
 * path, or to the inverse one. It does mean a bug in the renderer itself would be invisible
 * to that comparison; the verdict tier is what covers that, because a path evaluated wrongly
 * yields different value nodes and a different verdict.
 *
 * Returns undefined for a path this engine cannot express, which is itself the answer.
 */
export function renderPathTerm(doc: ParsedDocument, term: ParsedTerm | undefined): string | undefined {
  const compiled = compilePath(doc, term);
  return compiled ? renderPath(compiled) : undefined;
}

/**
 * A SPARQL-based constraint component declared by the shapes graph.
 *
 * ★ THE SHAPES GRAPH DEFINES A NEW CONSTRAINT KIND, and that is what makes this different
 * from every other constraint in this file. Everything else is a fixed vocabulary the engine
 * knows; a component is a rule the DOCUMENT invents, activated on any shape that carries its
 * parameters as predicates, with the parameter values pre-bound into a query by their local
 * names. `sh:parameter [ sh:path ex:test1 ]` on the component plus `ex:test1 "Hello "` on a
 * shape means `$test1` inside the validator is "Hello ".
 */
interface ConstraintComponentDef {
  readonly iri: string;
  readonly params: readonly { path: IRI; name: string; optional: boolean }[];
  /** Applies to both shape kinds. */
  readonly validator?: SparqlConstraint;
  /** Node shapes only. */
  readonly nodeValidator?: SparqlConstraint;
  /** Property shapes only. */
  readonly propertyValidator?: SparqlConstraint;
  /** The COMPONENT's own sh:message — used when its validator declares none (§5.2.2). */
  readonly message?: string;
}

/** One compiled `sh:sparql` constraint: the query, its prefixes and its message. */
interface SparqlConstraint {
  readonly query: string;
  readonly prefixes: ReadonlyMap<string, string>;
  readonly message?: string;
  readonly deactivated: boolean;
  /**
   * ★ THE CONSTRAINT'S OWN SEVERITY, WHICH IS NEW IN 1.2 AND OVERRIDES THE SHAPE'S.
   * §5.2.1: "If $sparql has a value for sh:severity then the validation result MUST have
   * that value as its (only) sh:resultSeverity." Taking the shape's severity instead reads
   * every advisory SPARQL check as a Violation — three suite entries declare `sh:Warning`
   * on the constraint and expect a report that still CONFORMS.
   */
  readonly severity?: ShaclSeverity;
  /**
   * ASK or SELECT, read from WHICH PREDICATE carried the query.
   *
   * ★ It decides whether `?value` is PRE-BOUND, and guessing it from the validator's
   * position gets that backwards half the time. An ASK validator is asked once per value
   * node with `?value` bound to it; a SELECT validator FINDS the values itself and `?value`
   * is a result variable — pre-binding it there would constrain the query to a value it was
   * supposed to discover. It is also what makes `BIND (true AS ?value)` detectable as the
   * illegal re-binding it is, which is a whole suite entry.
   */
  readonly form: 'ASK' | 'SELECT';
}

/**
 * The prefix declarations in scope for a SPARQL constraint.
 *
 * ★ THREE SOURCES, AND MISSING ANY OF THEM MAKES A CORRECT QUERY FAIL TO PARSE.
 *
 *   1. `sh:prefixes <ontology>` names a resource whose `sh:declare` set applies.
 *   2. That resource's `owl:imports` are followed — node/prefixes-001 declares `test` locally
 *      and imports the ontology that declares `ex`, and needs both.
 *   3. With NO sh:prefixes at all, the declarations of every resource typed `sh:ShapesGraph`
 *      apply. node/prefixes-002 relies on that AND plants a conflicting declaration on a
 *      plain rdfs:Resource that must be ignored — so "collect every sh:declare anywhere" is
 *      the wrong shortcut, and it is the obvious one.
 *
 * The query's own inline PREFIX lines override all of this; that is handled in runSparql,
 * because SPARQL is last-declaration-wins and the prologue is written last.
 */
function prefixesFor(doc: ParsedDocument, constraintNode: ParsedSubject): Map<string, string> {
  const out = new Map<string, string>();
  const declaredOn = (subj: ParsedSubject | undefined): void => {
    for (const d of subj?.properties.get(SH_DECLARE) ?? []) {
      const decl = subjectFor(doc, d);
      const ns = decl?.properties.get(SH_NAMESPACE)?.[0];
      const px = decl?.properties.get(SH_PREFIX)?.[0];
      if (px?.kind !== 'literal') continue;
      // sh:namespace is xsd:anyURI-typed in some fixtures and a plain string in others.
      const nsText = ns?.kind === 'literal' ? ns.value : ns?.kind === 'iri' ? ns.iri : undefined;
      if (nsText !== undefined) out.set(px.value, nsText);
    }
  };

  const named = constraintNode.properties.get(SH_PREFIXES) ?? [];
  if (named.length > 0) {
    const seen = new Set<string>();
    const walk = (term: ParsedTerm): void => {
      const k = refKey(term);
      if (k === undefined || seen.has(k)) return;
      seen.add(k);
      const subj = subjectFor(doc, term);
      declaredOn(subj);
      for (const imp of subj?.properties.get(OWL_IMPORTS) ?? []) walk(imp);
    };
    for (const t of named) walk(t);
    return out;
  }

  // No sh:prefixes: every sh:ShapesGraph contributes, and nothing else does.
  for (const subj of doc.subjects) {
    const isShapesGraph = (subj.properties.get(RDF_TYPE) ?? [])
      .some(t => t.kind === 'iri' && t.iri === SH_SHAPES_GRAPH_CLASS);
    if (isShapesGraph) declaredOn(subj);
  }
  return out;
}

/** Compile every `sh:sparql` on a shape. */
function compileSparqlConstraints(
  doc: ParsedDocument, subj: ParsedSubject,
): readonly SparqlConstraint[] {
  const out: SparqlConstraint[] = [];
  for (const t of subj.properties.get(SH_SPARQL) ?? []) {
    // ★ THE CONSTRAINT NODE MAY BE THE SHAPE ITSELF. `ex:S a sh:NodeShape, sh:SPARQLConstraint
    // ; sh:sparql ex:S` is legal and appears in the suite — resolving the value blindly and
    // finding the shape again is correct, not a cycle to guard against.
    const node = subjectFor(doc, t) ?? subj;
    const sel = node.properties.get(SH_SELECT)?.[0];
    const ask = node.properties.get(SH_ASK)?.[0];
    const q = sel?.kind === 'literal' ? sel.value : ask?.kind === 'literal' ? ask.value : undefined;
    if (q === undefined) continue;
    const msg = node.properties.get(SH_MESSAGE)?.[0];
    const deac = node.properties.get(SH_DEACTIVATED)?.[0];
    const sev = decodeSeverity(asIri(node.properties.get(SH_SEVERITY)?.[0]));
    out.push({
      query: q,
      form: sel?.kind === 'literal' ? 'SELECT' : 'ASK',
      prefixes: prefixesFor(doc, node),
      ...(msg?.kind === 'literal' ? { message: msg.value } : {}),
      ...(sev !== undefined ? { severity: sev } : {}),
      deactivated: deac?.kind === 'literal' && deac.value === 'true',
    });
  }
  return out;
}

/**
 * Every SPARQL-based constraint component the shapes graph declares.
 *
 * ★ THE TYPE CHECK IS SUBCLASS-AWARE, and the suite makes sure of it: validator-001 declares
 * `ex:ConstraintComponent rdfs:subClassOf sh:ConstraintComponent` and types its component
 * with that, plus `ex:SPARQLAskValidator rdfs:subClassOf sh:SPARQLAskValidator`. An exact
 * rdf:type comparison finds neither, and the component silently does not exist — which looks
 * exactly like a graph that conforms.
 */
function compileConstraintComponents(doc: ParsedDocument): readonly ConstraintComponentDef[] {
  const closure = buildSubclassClosure(doc).closure;
  const isComponent = (subj: ParsedSubject): boolean =>
    (subj.properties.get(RDF_TYPE) ?? []).some(t => t.kind === 'iri'
      && (t.iri === SH_CONSTRAINT_COMPONENT || closure.get(SH_CONSTRAINT_COMPONENT)?.has(t.iri)));

  const validatorAt = (subj: ParsedSubject, pred: IRI): SparqlConstraint | undefined => {
    const ref = subj.properties.get(pred)?.[0];
    const node = ref === undefined ? undefined : subjectFor(doc, ref);
    if (!node) return undefined;
    const selT = node.properties.get(SH_SELECT)?.[0];
    const sel = selT ?? node.properties.get(SH_ASK)?.[0];
    if (sel?.kind !== 'literal') return undefined;
    const msg = node.properties.get(SH_MESSAGE)?.[0];
    return {
      query: sel.value,
      form: selT?.kind === 'literal' ? 'SELECT' : 'ASK',
      prefixes: prefixesFor(doc, node),
      ...(msg?.kind === 'literal' ? { message: msg.value } : {}),
      deactivated: false,
    };
  };

  const out: ConstraintComponentDef[] = [];
  for (const subj of doc.subjects) {
    if (typeof subj.subject !== 'string' || !isComponent(subj)) continue;
    const params: { path: IRI; name: string; optional: boolean }[] = [];
    for (const pref of subj.properties.get(SH_PARAMETER) ?? []) {
      const pnode = subjectFor(doc, pref);
      const path = asIri(pnode?.properties.get(SH_PATH)?.[0]);
      if (path === undefined) continue;
      const opt = pnode?.properties.get(SH_OPTIONAL)?.[0];
      params.push({
        path,
        // The variable name is the path's LOCAL name: `ex:test1` binds `$test1`.
        name: path.slice(Math.max(path.lastIndexOf('#'), path.lastIndexOf('/')) + 1),
        optional: opt?.kind === 'literal' && opt.value === 'true',
      });
    }
    if (params.length === 0) continue;
    const compMsg = subj.properties.get(SH_MESSAGE)?.[0];
    const def: ConstraintComponentDef = {
      iri: subj.subject,
      params,
      ...(compMsg?.kind === 'literal' ? { message: compMsg.value } : {}),
      ...(validatorAt(subj, SH_VALIDATOR) ? { validator: validatorAt(subj, SH_VALIDATOR)! } : {}),
      ...(validatorAt(subj, SH_NODE_VALIDATOR)
        ? { nodeValidator: validatorAt(subj, SH_NODE_VALIDATOR)! } : {}),
      ...(validatorAt(subj, SH_PROPERTY_VALIDATOR)
        ? { propertyValidator: validatorAt(subj, SH_PROPERTY_VALIDATOR)! } : {}),
    };
    if (def.validator ?? def.nodeValidator ?? def.propertyValidator) out.push(def);
  }
  return out;
}

/**
 * Functions the SHAPES GRAPH declares, ready to call from a SPARQL expression.
 *
 * ★ THREE BODY FORMS, and they are not variations on one thing — each needs a different
 * evaluator, and the suite has one entry per form:
 *
 *   sh:bodyExpression [ shnex:count [ … [ shnex:arg 0 ] ] ]   a NODE EXPRESSION
 *   sh:bodyExpression [ sh:sparqlExpr "CONCAT($arg0, ' ')" ]  a BARE SPARQL expression
 *   sh:bodyExpression [ sh:select "SELECT (…) WHERE { … }" ]  a whole QUERY
 *
 * ★ AND A MISSING ARGUMENT MUST STAY MISSING. `ex:langLabelCount(ex:Cougar)` calls a
 * two-parameter function with one argument, and the body reads
 * `COALESCE($arg1, 'en')` — which reaches its default only if `$arg1` is genuinely unbound.
 * Defaulting it to anything, including the empty string, silently changes the function.
 */
const USER_FUNCTIONS = new WeakMap<ParsedDocument, Map<string, UserFunction>>();

/**
 * The shapes graph's functions, compiled once per document.
 *
 * Memoised because a function BODY can call another function, so the map has to exist before
 * any of its entries run — and because recompiling it per constraint, per focus node, would
 * be quadratic in a document that declares several.
 */
function userFunctionsFor(doc: ParsedDocument): Map<string, UserFunction> {
  let fns = USER_FUNCTIONS.get(doc);
  if (fns === undefined) {
    fns = compileUserFunctions(doc);
    USER_FUNCTIONS.set(doc, fns);
  }
  return fns;
}

function compileUserFunctions(doc: ParsedDocument): Map<string, UserFunction> {
  const out = new Map<string, UserFunction>();
  for (const subj of doc.subjects) {
    if (typeof subj.subject !== 'string') continue;
    const bodyRef = subj.properties.get(SH_BODY_EXPRESSION)?.[0];
    if (bodyRef === undefined) continue;
    const body = subjectFor(doc, bodyRef);
    if (!body) continue;

    // Parameters are ordered by the numeric suffix of their sh:path — shnex:arg0, arg1, …
    const arity = (subj.properties.get(SH_PARAMETER) ?? []).length;
    const prefixes = prefixesFor(doc, body);
    const selT = body.properties.get(SH_SELECT)?.[0];
    const exprT = body.properties.get(SH_SPARQL_EXPR)?.[0];

    out.set(subj.subject, (args) => {
      const bindings = new Map<string, ParsedTerm>();
      for (let i = 0; i < Math.max(arity, args.length); i++) {
        const v = args[i];
        if (v !== undefined) bindings.set(`arg${i}`, v);   // absent stays ABSENT
      }
      try {
        if (exprT?.kind === 'literal') {
          return evaluateSparqlExpression(doc, exprT.value, prefixes, bindings, out);
        }
        if (selT?.kind === 'literal') {
          const r = runSparql(doc, selT.value, prefixes, bindings, out);
          if (r.form === 'ASK') {
            return { kind: 'literal', value: String(r.boolean), datatype: `${XSD}boolean` as IRI };
          }
          // A function returns ONE term: the single projected variable of the first solution.
          const first = r.bindings[0];
          if (first === undefined) return undefined;
          for (const [name, v] of first) { if (!name.startsWith('arg')) return v; }
          return undefined;
        }
        // A node-expression body. Arguments reach `shnex:arg N` through the bindings map.
        const seqs = new Map<string, readonly ParsedTerm[]>();
        for (const [k, v] of bindings) seqs.set(k, [v]);
        const values = evaluateNodeExpression(doc, bodyRef, {
          bindings: seqs,
          conforms: (n, sh) => nodeConformsToShape(doc, n, sh),
          runQuery: (exprNode, f) => sparqlExpressionValues(doc, exprNode, f),
        });
        return values[0];
      } catch (err) {
        if (err instanceof SparqlRefusedError) throw err;
        return undefined;
      }
    });
  }
  return out;
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
      for (const k of listShapeRefs(doc, subj, pred) ?? []) inlineShapeKeys.add(k);
    }
  }

  for (const subj of doc.subjects) {
    if (!isShape(subj) && !inlineShapeKeys.has(subjectKey(subj))) continue;
    // ★ A STANDALONE PROPERTY SHAPE IS STILL A SHAPE, AND IT WAS `continue`d.
    //
    // The line here read "a property-shape declared standalone is not a node shape itself"
    // and skipped it. True and irrelevant: §2.1 gives targets to SHAPES, not to node shapes,
    // and a property shape carrying sh:targetNode selects focus nodes and is validated
    // against them exactly as a node shape is. Its own constraints simply apply to the
    // values of its sh:path rather than to the focus node.
    //
    // Skipping it made every such shape enforce nothing. The W3C Core suite writes almost
    // all of its PATH tests this way — one `sh:PropertyShape` with `sh:path`, `sh:minCount`
    // and four `sh:targetNode`s — so sequence, alternative, zeroOrMore, oneOrMore, zeroOrOne
    // and complex paths were all reported as failures of the path implementation, which was
    // fine, when nothing had ever been evaluated against them at all.
    //
    // Compiled as a node shape whose single property shape is ITSELF. Everything below that
    // would otherwise ALSO read its constraints — the node-level shape, and the four logical
    // constraints — is suppressed for it, because on a property shape those are statements
    // about the value nodes and the property shape already carries them.
    const hasPath = subj.properties.has(SH_PATH);

    const targetClasses = getAll(subj, SH_TARGET_CLASS)
      .map(t => asIri(t))
      .filter((x): x is IRI => x !== undefined);
    const targetNodes = getAll(subj, SH_TARGET_NODE)
      .filter(t => t.kind !== 'triple');   // a triple term is not a node of the graph
    const propertyShapeRefs = getAll(subj, SH_PROPERTY);

    const propertyShapes: PropertyShape[] = [];
    if (hasPath) {
      const self = compilePropertyShape(doc, subj);
      if (self) propertyShapes.push(self);
    }
    const shapeOverrides = constraintOverrides(doc, subj);
    // ★ ONCE, FROM ONE PLACE. A path-bearing shape is compiled as a node shape whose single
    // property shape is itself, and that property shape now compiles the same sh:sparql —
    // so keeping it here too would run every such constraint TWICE, once with $PATH
    // substituted and once without.
    const sparqlConstraints = hasPath ? [] : compileSparqlConstraints(doc, subj);
    for (const ref of propertyShapeRefs) {
      const refK = refKey(ref);
      if (refK === undefined) continue;
      // §3.1.4 — `sh:property X {| sh:deactivated true |}` switches off THAT property
      // constraint. Scoped to the value, so a sibling sh:property keeps running.
      if (shapeOverrides?.get(valueScopedKey('PropertyConstraintComponent', ref))
        ?.deactivated === true) continue;
      const target = propertyShapesByKey.get(refK);
      if (!target) continue;
      const ps = compilePropertyShape(doc, target);
      if (ps) propertyShapes.push(ps);
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
    // ★ Compiled ONLY when the shape actually declares a node-level constraint. Attaching an
    // empty one to every node shape would be harmless to read and expensive to reason about:
    // `propertyShapes.length === 0` is load-bearing in nodeSatisfiesShape (a term with no
    // description can satisfy only a shape that demands nothing of it), and a shape that
    // silently gained a constraint-free extra shape would answer that question differently.
    const nodeLevelShape = ((): PropertyShape | undefined => {
      if (hasPath) return undefined;   // its constraints belong to the path, not the node
      const compiled = compilePropertyShape(doc, subj, true);
      return compiled && carriesConstraint(compiled) ? compiled : undefined;
    })();
    // ★ A LIST HERE MEANS SEVERAL PATHS, NOT A SEQUENCE PATH — the two are spelled
    // identically in Turtle, `( a b )`, and they mean opposite things. `sh:uniqueValuesFor
    // ( skos:notation skos:inScheme )` is a COMPOSITE KEY: the pair must be unique, while
    // either alone may repeat. Compiled as a sequence path it would instead walk notation
    // then inScheme, yield nothing, and report every instance as having no key.
    const uniqueValuesFor: CompiledPath[] = [];
    for (const t of getAll(subj, SH_UNIQUE_VALUES_FOR)) {
      const asList = listMembers(doc, t);
      for (const step of asList ?? [t]) {
        const cp = compilePath(doc, step);
        if (cp) uniqueValuesFor.push(cp);
      }
    }
    const rawNodeIn = hasPath ? [] : getAll(subj, SH_IN);
    const nodeIn: ParsedTerm[] | undefined = rawNodeIn.length === 0 ? undefined : [];
    for (const head of rawNodeIn) for (const v of walkRdfList(doc, head)) nodeIn!.push(v);
    const sevIri = asIri(getOne(subj, SH_SEVERITY));
    const severity: ShaclSeverity = decodeSeverity(sevIri) ?? 'Violation';

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
      nodeClass: hasPath ? undefined : asIri(getOne(subj, SH_CLASS)),
      nodeDatatype: hasPath ? undefined : asIri(getOne(subj, SH_DATATYPE)),
      nodeKindConstraint: hasPath ? undefined : asIri(getOne(subj, SH_NODE_KIND)),
      // sh:not takes shapes directly (repeatable); the other three take ONE rdf:List each.
      notShapes: hasPath
        ? undefined : getAll(subj, SH_NOT).map(refKey).filter((k): k is string => k !== undefined),
      andShapes: hasPath ? undefined : listShapeRefs(doc, subj, SH_AND),
      orShapes: hasPath ? undefined : listShapeRefs(doc, subj, SH_OR),
      xoneShapes: hasPath ? undefined : listShapeRefs(doc, subj, SH_XONE),
      overrides: shapeOverrides,
      subject: subj,
      ...(sparqlConstraints.length > 0 ? { sparqlConstraints } : {}),
      ...(uniqueValuesFor.length > 0 ? { uniqueValuesFor } : {}),
      ...(nodeLevelShape ? { nodeLevelShape } : {}),
      ...(nodeIn !== undefined ? { nodeIn } : {}),
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
    // ★ A TARGET CAN BE COMPUTED. `sh:targetNode [ sh:select "…" ]` names the focus nodes
    // with a query instead of listing them, and that is the one place SPARQL PRODUCES focus
    // nodes rather than being evaluated for one. Read as an ordinary term it selects the
    // blank node carrying the query — a node the data graph says nothing about — so the
    // shape targets exactly one thing, and that thing conforms to everything. A shape that
    // targets nothing and a shape that targets a node with no properties are
    // indistinguishable in the report.
    // ★ THE SELECTOR IS READ FROM THE SHAPES GRAPH, THE QUERY RUNS OVER THE DATA. Looking
    // the blank node up in the DATA graph found it only when both came from one document;
    // with a separate shapes file it was not found, control fell through, and the SELECTOR
    // BLANK NODE ITSELF became the focus node — so the shape's constraints were evaluated
    // against the query, and a sh:minCount reported a violation on `_:b0`. A wrong answer
    // about a node that is not in the data at all.
    const selector = (ACTIVE_SHAPE_DOC !== undefined ? subjectFor(ACTIVE_SHAPE_DOC, node) : undefined)
      ?? subjectFor(data, node);
    if (selector?.properties.has(SH_SELECT) === true) {
      for (const t of sparqlExpressionValues(data, node, undefined, selector)) {
        const focus = focusFor(data, t);
        const key = subjectKey(focus);
        if (!seen.has(key)) { seen.add(key); matched.push(focus); }
      }
      continue;
    }
    const focus = focusFor(data, node);
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
      // ★ Was a fourth hand-rolled copy of "term -> focus node", and the only one that
      // resolved the term with a LINEAR SCAN of data.subjects — once per object, per
      // sh:targetObjectsOf predicate. focusFor goes through the memoised subject index that
      // this file already built precisely because this shape of scan had shipped twice.
      const focus = focusFor(data, t);
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

const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' as IRI;

/**
 * Is a lexical form VALID for its datatype?
 *
 * ★ sh:datatype IS NOT AN IRI COMPARISON. §4.1.2 requires the value node to be a literal
 * whose datatype is the given one AND whose lexical form is well-formed for it. We compared
 * the IRI alone, so `"aldi"^^xsd:integer` satisfied `sh:datatype xsd:integer` — a literal
 * that is not an integer, accepted by a constraint whose entire job is to say it must be.
 *
 * That is the fail-OPEN direction and it is worse than it first looks: an ill-formed literal
 * is the shape of a data-entry bug, a bad cast, or a hand-edited file, which is precisely
 * what a datatype constraint is written to catch.
 *
 * A datatype not listed here is not checked — an unknown or user-defined datatype has no
 * lexical space this engine can know, and inventing one would refuse valid data. Silence
 * about what we cannot judge, rather than a guess.
 */
const LEXICAL_FORMS: ReadonlyMap<string, RegExp> = new Map<string, RegExp>([
  ['integer', /^[+-]?\d+$/],
  ['long', /^[+-]?\d+$/], ['int', /^[+-]?\d+$/],
  ['short', /^[+-]?\d+$/], ['byte', /^[+-]?\d+$/],
  ['nonNegativeInteger', /^\+?\d+$/], ['positiveInteger', /^\+?\d+$/],
  ['nonPositiveInteger', /^(-\d+|\+?0+)$/], ['negativeInteger', /^-\d+$/],
  ['unsignedLong', /^\+?\d+$/], ['unsignedInt', /^\+?\d+$/],
  ['unsignedShort', /^\+?\d+$/], ['unsignedByte', /^\+?\d+$/],
  ['decimal', /^[+-]?(\d+(\.\d*)?|\.\d+)$/],
  ['double', /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/],
  ['float', /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/],
  ['boolean', /^(true|false|0|1)$/],
  ['dateTime', /^-?\d{4,}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?$/],
  ['dateTimeStamp', /^-?\d{4,}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/],
  ['date', /^-?\d{4,}-\d\d-\d\d(Z|[+-]\d\d:\d\d)?$/],
  ['time', /^\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?$/],
  ['gYear', /^-?\d{4,}(Z|[+-]\d\d:\d\d)?$/],
  ['gYearMonth', /^-?\d{4,}-\d\d(Z|[+-]\d\d:\d\d)?$/],
  ['gMonthDay', /^--\d\d-\d\d(Z|[+-]\d\d:\d\d)?$/],
  ['gDay', /^---\d\d(Z|[+-]\d\d:\d\d)?$/],
  ['gMonth', /^--\d\d(Z|[+-]\d\d:\d\d)?$/],
  ['duration', /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/],
  ['hexBinary', /^([0-9a-fA-F]{2})*$/],
  ['base64Binary', /^[A-Za-z0-9+/\s]*={0,2}$/],
  ['anyURI', /^\S*$/],
  ['language', /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/],
]);

function lexicallyValid(value: string, datatype: IRI): boolean {
  if (!datatype.startsWith(XSD)) return true;
  const re = LEXICAL_FORMS.get(datatype.slice(XSD.length));
  return re === undefined || re.test(value);
}

function matchesDatatype(t: ParsedTerm, datatype: IRI): boolean {
  if (t.kind !== 'literal') return false;
  // ★ A LANGUAGE-TAGGED LITERAL IS rdf:langString, NOT xsd:string. RDF 1.1 §3.3 gives every
  // language-tagged literal that datatype and no other, so `"A"@en` does not satisfy
  // `sh:datatype xsd:string`. Falling through to the untyped branch accepted it — which
  // makes `sh:datatype xsd:string` mean "any string-ish literal", and a shape that meant to
  // exclude localised values from a field kept letting them in.
  if (t.language !== undefined && t.language !== '') return datatype === RDF_LANG_STRING;
  if (t.datatype) return t.datatype === datatype && lexicallyValid(t.value, datatype);
  // A plain literal with no language tag is xsd:string.
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
  const focusNode = focusLabel(focus);
  const holds = (ref: string): boolean => {
    const target = byId.get(ref);
    // An unresolvable reference cannot be satisfied OR refuted; treat it as vacuously true
    // so a dangling ref does not silently reject a graph. The sweep reports the shape.
    if (!target) return true;
    return conformsToShape(data, focus, target, byId, depth + 1, subclassClosure);
  };
  const fail = (component: string, message: string): void => {
    // shape.message wins, as it does for property constraints and sh:closed. This was the
    // third site to drop it: an author who explains WHY a disjunction must hold had that
    // explanation replaced by "Focus node does not conform to every shape in sh:and".
    out.push({ focusNode, sourceShape: shape.id, constraintComponent: `${SHACL}${component}`,
      severity: sev, message: shape.message ?? message });
  };

  for (const ref of shape.notShapes ?? []) {
    if (holds(ref)) fail('NotConstraintComponent', `Focus node conforms to sh:not ${ref}, and must not`);
  }
  const and = shape.andShapes ?? [];
  if (and.length > 0 && !and.every(holds)) {
    fail('AndConstraintComponent', 'Focus node does not conform to every shape in sh:and');
  }
  const or = shape.orShapes;
  if (or !== undefined && !or.some(holds)) {
    fail('OrConstraintComponent', or.length === 0
      ? 'sh:or is the empty list, so there is no shape for the focus node to conform to'
      : 'Focus node conforms to no shape in sh:or');
  }
  const xone = shape.xoneShapes;
  if (xone !== undefined) {
    const n = xone.filter(holds).length;
    if (n !== 1) {
      fail('XoneConstraintComponent', xone.length === 0
        ? 'sh:xone is the empty list, so exactly one of zero shapes can never hold'
        : `Focus node conforms to ${n} shapes in sh:xone; exactly one is required`);
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
 * Run every SPARQL-based constraint component this shape ACTIVATES, against one focus node.
 *
 * ★ ACTIVATION IS BY PREDICATE, NOT BY DECLARATION. A shape does not say which components
 * apply to it; it carries a component's parameter predicates and that IS the activation.
 * `ex:requiredParam "One"` on a node shape activates any component declaring
 * `sh:parameter [ sh:path ex:requiredParam ]`.
 *
 * ★ AN OPTIONAL PARAMETER MUST BE LEFT GENUINELY UNBOUND. `sh:optional true` means absent,
 * not empty-string and not defaulted — component/optional-001's validator reads
 * `COALESCE(?optionalParam, "Three")`, and COALESCE only reaches its fallback if the variable
 * has no value. Binding it to anything at all silently changes the rule.
 */
function componentResults(
  data: ParsedDocument,
  focus: ParsedSubject,
  shape: NodeShape,
  components: readonly ConstraintComponentDef[],
): ShaclResult[] {
  if (components.length === 0) return [];
  const out: ShaclResult[] = [];
  const term = subjectAsTerm(focus);

  // ★ A COMPONENT ACTIVATES ON A PROPERTY SHAPE TOO, and that is not a variation — it is
  // where sh:propertyValidator lives. The carrier is then the PROPERTY shape's subject, and
  // `$PATH` binds to its path: `$this $PATH ?value` is how a select-based property validator
  // finds the values it is judging. Checking only node shapes leaves every property-scoped
  // component silently inactive, which reads exactly like a graph that conforms.
  const carriers: {
    subject: ParsedSubject; id: string; isProperty: boolean;
    pathExpr?: CompiledPath; pathLabel?: string; severity?: ShaclSeverity;
  }[] = [];
  // ★ NOT BOTH. A top-level `sh:PropertyShape` is compiled as a node shape whose single
  // property shape is ITSELF, so the same subject arrives here twice — and every component
  // active on it then fired twice, once judged as a node and once as a property. The
  // property reading is the right one; it is the one that has a path.
  const selfIsProperty = shape.propertyShapes.some(ps => ps.subject === shape.subject);
  if (shape.subject !== undefined && !selfIsProperty) {
    carriers.push({ subject: shape.subject, id: shape.id, isProperty: false });
  }
  for (const ps of shape.propertyShapes) {
    if (ps.subject === undefined) continue;
    // ★ THE PROPERTY SHAPE IS THE SOURCE SHAPE, and naming the node shape instead loses the
    // only thing that distinguishes two results from the same component: which of the node
    // shape's properties it fired on. The suite's expected report names the sh:property
    // blank node, not the shape that contains it.
    carriers.push({
      subject: ps.subject,
      id: ps.id,
      // ★ A COMPLEX PATH IS STILL A PATH. Deciding "is this a property shape?" by whether a
      // single predicate IRI was available made every sequence- or inverse-pathed shape
      // read as a NODE shape here, so sh:propertyValidator never ran on one.
      isProperty: true,
      pathExpr: ps.pathExpr,
      pathLabel: ps.path,
      ...(ps.severity !== undefined ? { severity: ps.severity } : {}),
    });
  }

  for (const {
    subject: shapeSubject, id: carrierId, isProperty, pathExpr, pathLabel,
    severity: carrierSev,
  } of carriers) {
  const carrierSeverity = carrierSev ?? shape.severity;
  for (const comp of components) {
    // Every REQUIRED parameter must be present on the shape, or the component is not active.
    const bindings = new Map<string, ParsedTerm>();
    let active = true;
    for (const param of comp.params) {
      const v = shapeSubject.properties.get(param.path)?.[0];
      if (v === undefined) {
        if (!param.optional) { active = false; break; }
        continue;                       // optional and absent: leave it UNBOUND
      }
      bindings.set(param.name, v);
    }
    if (!active) continue;

    // sh:propertyValidator applies ONLY to a property shape; sh:nodeValidator only to a node
    // shape; sh:validator to either. Picking the wrong one is how a validator runs in a
    // scope its author excluded it from.
    const validator = (isProperty ? comp.propertyValidator : comp.nodeValidator)
      ?? comp.validator;
    if (validator === undefined) continue;

    const preBound = new Map(bindings);
    preBound.set('this', term);
    const paths = new Map<string, SparqlPathNode>();
    const asSparqlPath = pathExpr === undefined ? undefined : sparqlPathFor(pathExpr);
    if (asSparqlPath !== undefined) paths.set('PATH', asSparqlPath);

    // An ASK validator is asked once per VALUE NODE with ?value bound; the value nodes are
    // the path's values on a property shape, and the focus node itself on a node shape.
    const valueNodes: ParsedTerm[] = validator.form !== 'ASK' ? [term]
      : pathExpr === undefined ? [term]
        : pathExpr.kind === 'predicate' ? [...(focus.properties.get(pathExpr.iri) ?? [])]
          : evaluatePath(data, term, pathExpr);

    // Each failing run, with the term it should report as sh:value: for an ASK that is the
    // value node it was asked about, and for a SELECT it is whatever the solution bound —
    // falling back to the value node only where there is exactly one, at a node shape.
    const failures: { value?: ParsedTerm; row?: Binding }[] = [];
    try {
      for (const v of valueNodes) {
        const withValue = new Map(preBound);
        if (validator.form === 'ASK') withValue.set('value', v);
        const r = runSparql(data, validator.query, validator.prefixes, withValue,
          userFunctionsFor(data), paths);
        if (r.form === 'ASK') {
          if (r.boolean === false) failures.push({ value: v });
        } else {
          // ★ ?failure IS AN ABORT HERE TOO. `sparqlResults` honours it for sh:sparql and
          // this branch did not, so a component validator that says "I could not judge this"
          // was reported as the component FAILING — "the data is wrong" in place of "the
          // check broke", under the component's own IRI.
          if (r.bindings.some(row => {
            const f = row.get('failure');
            return f?.kind === 'literal' && f.value === 'true';
          })) {
            throw new SparqlRefusedError(
              `the validator of ${comp.iri} reported ?failure`);
          }
          for (const row of r.bindings) {
            failures.push({ row, ...(pathExpr === undefined ? { value: term } : {}) });
          }
        }
      }
    } catch (err) {
      if (!(err instanceof SparqlRefusedError)) throw err;
      // ★ THE SAME DISTINCTION AS sh:sparql, AND IT HAS TO BE MADE HERE TOO. Reporting a
      // refusal under the COMPONENT's own IRI says "this component judged the data and it
      // failed", which is not what happened — the component could not run. Naming it
      // SPARQL_REFUSED is what lets a caller, and the conformance harness, tell an abort
      // from a verdict.
      out.push({
        focusNode: focusLabel(focus),
        sourceShape: carrierId,
        constraintComponent: SPARQL_REFUSED,
        severity: 'Violation',
        message: `The constraint component ${comp.iri} could not be evaluated, so this graph `
          + `is refused rather than passed: ${err.message}`,
      });
      continue;
    }
    for (const { value, row } of failures) {
      out.push(mapSolution(row, {
        focus,
        sourceShape: carrierId,
        // The report names the COMPONENT, not sh:SPARQLConstraintComponent — the shapes
        // graph defined this constraint kind and a reader needs to know which one fired.
        component: comp.iri,
        severity: carrierSeverity,
        // §5.2.2 for components: the VALIDATOR's message, then the COMPONENT's, then the
        // shape's. A component that words its own failure should not be overruled by the
        // generic sentence on the shape that happens to use it.
        message: validator.message ?? comp.message ?? shape.message
          ?? `The focus node does not satisfy ${comp.iri}`,
        ...(pathLabel !== undefined ? { path: pathLabel } : {}),
        ...(value !== undefined ? { defaultValue: value } : {}),
        // ★ THE PARAMETERS ARE IN SCOPE FOR `{$name}`, not just the solution's variables —
        // `"…with language \"{?lang}\""` on a shared component reads the shape's own
        // ex:lang, which is the only thing that distinguishes its two results.
        templateValues: bindings,
      }));
    }
  }
  }
  return out;
}

/**
 * Run a set of `sh:sparql` constraints against one focus node.
 *
 * ★ THE CONSTRAINTS COME IN AS AN ARGUMENT because they belong to whichever shape DECLARED
 * them — a node shape or one of its property shapes — and the three things that differ
 * between those two cases are exactly the three the report gets wrong if you assume the
 * node shape: `$PATH`, `sh:resultPath`, and `sh:sourceShape`.
 *
 * ★ A SELECT SOLUTION IS A VIOLATION; AN ASK FALSE IS A VIOLATION. §5.2.1. Getting the ASK
 * polarity backwards is the easy mistake — the query asserts the condition that must HOLD,
 * so `false` is the failure — and getting SELECT wrong is easier still, because "the query
 * returned rows" reads like success.
 *
 * ★ AND A REFUSED QUERY ABORTS THE VALIDATION RATHER THAN PASSING. SHACL says a validator
 * that cannot honour a constraint's pre-binding must FAIL, and the suite has five entries
 * whose expected result is exactly that. Returning "no violations" for a query we declined
 * to run would be the fail-open this whole file exists to prevent — the constraint would
 * report clean because it never happened.
 */
function sparqlResults(
  data: ParsedDocument, focus: ParsedSubject, src: SparqlSource,
): ShaclResult[] {
  if (src.constraints.length === 0) return [];
  const out: ShaclResult[] = [];
  const term = subjectAsTerm(focus);
  // ★ SUBSTITUTED, NOT PRE-BOUND — see SparqlPathNode. A shape whose path cannot be
  // expressed as a SPARQL path (only sh:path with a node expression, today) leaves $PATH
  // free, and the parser refuses the query rather than matching every predicate.
  const paths = new Map<string, SparqlPathNode>();
  const asSparqlPath = src.path === undefined ? undefined : sparqlPathFor(src.path);
  if (asSparqlPath !== undefined) paths.set('PATH', asSparqlPath);
  for (const c of src.constraints) {
    if (c.deactivated) continue;
    const preBound = new Map<string, ParsedTerm>([['this', term]]);
    // ★ A REFUSAL BECOMES A FAIL-CLOSED VIOLATION, NOT AN ESCAPING EXCEPTION.
    //
    // SHACL calls this outcome "the validation process fails", and a thrown error is one
    // faithful spelling of that. It is the wrong one HERE: validateAgainstShape is called by
    // the relay's publish gate, the Solid write path and the workspace sealer, and an
    // uncaught throw turns a shape the engine cannot evaluate into a 500 rather than a
    // refusal the caller can report.
    //
    // A Violation carries the same verdict — conforms is false, the publish is refused — and
    // it arrives as data, with the reason in the message. Fail-CLOSED either way; the
    // difference is whether the caller can say why.
    let result;
    try {
      result = runSparql(data, c.query, c.prefixes, preBound, userFunctionsFor(data), paths);
    } catch (err) {
      if (!(err instanceof SparqlRefusedError)) throw err;
      // ★ ITS OWN COMPONENT, NOT sh:SPARQLConstraintComponent. Reusing the normal component
      // would make "the constraint ran and the data failed it" indistinguishable from "the
      // constraint could not run, so we refused" — and a conformance harness comparing
      // verdicts would then score the second as a PASS whenever the expected verdict was
      // false. Measured: three entries flipped to passing for exactly that wrong reason the
      // moment the throw became a report.
      out.push({
        focusNode: focusLabel(focus),
        sourceShape: src.sourceShape,
        constraintComponent: SPARQL_REFUSED,
        severity: 'Violation',
        message: `The sh:sparql constraint could not be evaluated, so this graph is refused `
          + `rather than passed: ${err.message}`,
      });
      continue;
    }
    const rows: (Binding | undefined)[] = result.form === 'ASK'
      ? (result.boolean === false ? [undefined] : [])
      : [...result.bindings];

    // ★ ?failure IS AN ABORT REPORTED THROUGH THE RESULT SET, and it is the only way a
    // constraint author can say "I could not judge this" from inside SPARQL. §5.2.1: there
    // is a result for each solution that does NOT bind failure to true, and a failure is
    // produced if and only if one solution does. Treating that solution as an ordinary
    // violation would turn "the check broke" into "the data is wrong".
    if (rows.some(r => r?.get('failure')?.kind === 'literal'
      && (r.get('failure') as { value: string }).value === 'true')) {
      out.push({
        focusNode: focusLabel(focus),
        sourceShape: src.sourceShape,
        constraintComponent: SPARQL_REFUSED,
        severity: 'Violation',
        message: 'The sh:sparql constraint reported ?failure, so this graph is refused '
          + 'rather than passed',
      });
      continue;
    }

    for (const row of rows) {
      out.push(mapSolution(row, {
        focus,
        sourceShape: src.sourceShape,
        component: `${SHACL}SPARQLConstraintComponent`,
        // §5.2.1 — the constraint's own sh:severity wins over the shape's.
        severity: c.severity ?? src.severity,
        // Messages fall back constraint → shape → engine, and only the first two are the
        // author's; the third exists so a report is never wordless.
        message: c.message ?? src.shapeMessage
          ?? 'The focus node does not satisfy the shape\'s sh:sparql constraint',
        ...(src.pathLabel !== undefined ? { path: src.pathLabel } : {}),
        // ★ THE VALUE NODE IS THE FALLBACK, AND ONLY A NODE SHAPE HAS ONE. §5.2.2 maps
        // sh:value to "the binding for value, else the value node" — and a SPARQL
        // constraint on a PROPERTY shape runs once per focus node rather than once per
        // value node, so there is no single value node to name. Defaulting to the focus
        // node there would report the wrong term with total confidence.
        ...(src.path === undefined ? { defaultValue: term } : {}),
      }));
    }
  }
  return out;
}

/** Where a set of `sh:sparql` constraints came from, and what the report should say. */
interface SparqlSource {
  readonly constraints: readonly SparqlConstraint[];
  /** The shape the report names — the PROPERTY shape when the constraint is on one. */
  readonly sourceShape: string;
  readonly severity: ShaclSeverity;
  readonly shapeMessage?: string;
  /** The property shape's path: what `$PATH` substitutes to, absent at node level. */
  readonly path?: CompiledPath;
  /** How that path is written in `sh:resultPath`. */
  readonly pathLabel?: string;
}

/**
 * Turn one solution — or one failing ASK, which has none — into a validation result.
 *
 * ★ §5.2.2 IS A PRIORITY LIST, NOT A SET OF DEFAULTS: "the rules are meant to be executed
 * from top to bottom, so that the first bound value will be used". Every property here can
 * be answered by the SOLUTION before anything the shape declared, which is what lets one
 * query report a different path and a different message per row.
 */
function mapSolution(
  row: Binding | undefined,
  ctx: {
    focus: ParsedSubject;
    sourceShape: string;
    component: string;
    severity: ShaclSeverity;
    message: string;
    path?: string;
    defaultValue?: ParsedTerm;
    /** Extra bindings a `{?name}` in the message may refer to — component parameters. */
    templateValues?: ReadonlyMap<string, ParsedTerm>;
  },
): ShaclResult {
  const value = row?.get('value') ?? ctx.defaultValue;
  const pathTerm = row?.get('path');
  const messageTerm = row?.get('message');
  const template = messageTerm?.kind === 'literal' ? messageTerm.value : ctx.message;
  const values = new Map(ctx.templateValues);
  for (const [k, v] of row ?? []) values.set(k, v);
  return {
    focusNode: focusLabel(ctx.focus),
    sourceShape: ctx.sourceShape,
    constraintComponent: ctx.component,
    severity: ctx.severity,
    message: fillMessageTemplate(template, values),
    // The binding wins, and only if it is an IRI — §5.2.2 says so explicitly, because
    // sh:resultPath must be a path and a literal is not one.
    ...(pathTerm?.kind === 'iri' ? { path: pathTerm.iri }
      : ctx.path !== undefined ? { path: ctx.path } : {}),
    ...(value !== undefined ? { value: termValue(value) } : {}),
  };
}

/**
 * `{?var}` and `{$var}` in a SHACL message, replaced with the values they name.
 *
 * ★ THIS IS WHAT MAKES ONE COMPONENT'S MESSAGE READ AS N DIFFERENT MESSAGES. A constraint
 * component says `"Values are literals with language \"{?lang}\""` once; the two property
 * shapes using it expect "…language \"en\"" and "…language \"de\"", which is the parameter
 * value, not the template. Left unsubstituted, every result from a reusable component
 * reports the same sentence and the reader cannot tell which shape produced it.
 *
 * An unbound name is left EXACTLY as written rather than blanked: `{?x}` surviving into the
 * output says the template referred to something the solution did not bind, and silently
 * emptying it would hide that.
 */
function fillMessageTemplate(text: string, values: ReadonlyMap<string, ParsedTerm>): string {
  if (!text.includes('{')) return text;
  return text.replace(/\{[?$]([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const v = values.get(name);
    return v === undefined ? whole : termValue(v);
  });
}

/**
 * A SHACL property path as a SPARQL one, so `$PATH` can be substituted rather than bound.
 *
 * `undefined` for a path SPARQL cannot express — the identity path of a node-level shape,
 * which has no `$PATH` to substitute in the first place.
 */
function sparqlPathFor(p: CompiledPath): SparqlPathNode | undefined {
  const all = (steps: readonly CompiledPath[]): SparqlPathNode[] | undefined => {
    const out: SparqlPathNode[] = [];
    for (const s of steps) {
      const one = sparqlPathFor(s);
      if (one === undefined) return undefined;
      out.push(one);
    }
    return out;
  };
  switch (p.kind) {
    case 'predicate': return { term: { kind: 'iri', iri: p.iri } };
    case 'sequence': { const s = all(p.steps); return s && { seq: s }; }
    case 'alternative': { const s = all(p.options); return s && { alt: s }; }
    case 'inverse': { const s = sparqlPathFor(p.of); return s && { inv: s }; }
    case 'zeroOrMore': {
      const s = sparqlPathFor(p.of); return s && { repeat: s, min: 0, max: Infinity };
    }
    case 'oneOrMore': {
      const s = sparqlPathFor(p.of); return s && { repeat: s, min: 1, max: Infinity };
    }
    case 'zeroOrOne': { const s = sparqlPathFor(p.of); return s && { repeat: s, min: 0, max: 1 }; }
    case 'identity': return undefined;
  }
}

/**
 * Evaluate a `sh:select` node expression and return the terms it produced.
 *
 * ★ WHICH VARIABLE? The one the query PROJECTS. A SHACL value-producing query names exactly
 * what it is producing — `SELECT ?fullName` — so taking the projected variable is reading
 * the query's own answer rather than guessing at a convention. `?value` wins when both are
 * present, because that is the name SHACL reserves for a produced value.
 */
function sparqlExpressionValues(
  data: ParsedDocument,
  exprNode: ParsedTerm,
  focus: ParsedTerm | undefined,
  /** The subject carrying the query, when the caller has already resolved it — a target
   *  selector lives in the shapes graph, and `data` cannot find it there. */
  resolved?: ParsedSubject,
): readonly ParsedTerm[] {
  const node = resolved ?? subjectFor(data, exprNode);
  if (!node) return [];
  // ★ THE PREFIXES COME FROM WHEREVER THE QUERY DOES. A target selector was resolved in the
  // SHAPES graph, so its `sh:prefixes` and the `sh:declare` set behind them are there too —
  // reading them from the data graph found none and the query died on "undeclared prefix",
  // which is at least loud, unlike the silence it replaced.
  const declDoc = resolved !== undefined ? (ACTIVE_SHAPE_DOC ?? data) : data;
  const preBound = new Map<string, ParsedTerm>();
  if (focus !== undefined) preBound.set('this', focus);
  // A bare expression — `sh:sparqlExpr "STRLEN(STR($this))"` — yields ONE term or none.
  const bare = node.properties.get(SH_SPARQL_EXPR)?.[0];
  if (bare?.kind === 'literal') {
    const v = evaluateSparqlExpression(data, bare.value, prefixesFor(declDoc, node), preBound,
      userFunctionsFor(data));
    return v === undefined ? [] : [v];
  }
  const sel = node.properties.get(SH_SELECT)?.[0] ?? node.properties.get(SH_ASK)?.[0];
  if (sel?.kind !== 'literal') return [];
  const result = runSparql(data, sel.value, prefixesFor(declDoc, node), preBound,
    userFunctionsFor(data));
  if (result.form === 'ASK') {
    return [{ kind: 'literal', value: String(result.boolean), datatype: `${XSD}boolean` as IRI }];
  }
  // ★ WHICH VARIABLE, ANSWERED BY THE QUERY'S OWN PROJECTION. Iterating the binding Map
  // reads the order the EVALUATOR bound things, which is the pattern's order; `SELECT
  // ?person` and `SELECT ?age ?person` can hand back the same Map with different first
  // entries. And skipping the name `this` unconditionally was wrong for a TARGET query,
  // where nothing is pre-bound and `SELECT ?this` is an ordinary projection — the W3C
  // fixture projects `?person`, so the bug only showed on a query that named it `?this`,
  // where the target silently selected nobody.
  //
  // ★ ONE PATH, NOT A PRIMARY AND A FALLBACK. Written as `projection ?? bindingOrder` the two
  // agreed on every query anyone had, so a mutation to the projection half SURVIVED — the
  // fallback quietly covered for it. Redundancy that nothing can distinguish is not
  // belt-and-braces; it is a second implementation that no test reaches. `SELECT *` projects
  // nothing explicitly, so THAT is where the binding order is the right answer, and it is
  // chosen once, here.
  const names = result.projected !== undefined && result.projected.length > 0
    ? result.projected
    : [...(result.bindings[0]?.keys() ?? [])];
  const out: ParsedTerm[] = [];
  for (const b of result.bindings) {
    const preferred = b.get('value');
    if (preferred !== undefined) { out.push(preferred); continue; }
    const pick = names.find(n => !preBound.has(n) && b.get(n) !== undefined);
    const v = pick === undefined ? undefined : b.get(pick);
    if (v !== undefined) out.push(v);
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
  // ★ ONE implementation of node-level constraints, shared with the reporting path and with
  // conformsToShape. Each of the three used to hand-roll the same four components; see the
  // `identity` case of CompiledPath. Sharing it also settles a question the three copies
  // could answer differently: a constraint switched off by a §3.1.4 reifier is off here too,
  // so a shape cannot say "conforms" at top level and "does not" when referenced through
  // sh:node — which, under an sh:not, would have inverted a softened rule into a hard one.
  if (target.nodeLevelShape
    && evaluatePropertyShape(data, focusFor(data, term), target, target.nodeLevelShape,
      byId, depth, subclassClosure).length > 0) {
    return false;
  }
  // ★ "NOT DESCRIBED" IS NOT "DOES NOT CONFORM". This used to return
  // `target.propertyShapes.length === 0` for any term the graph says nothing about — so a
  // value with no outgoing triples failed EVERY sh:node shape that carried a property
  // shape, whatever that shape actually required.
  //
  // The reasoning behind it was sound and the conclusion was inverted: a node with no
  // description has no values for any path, and a property shape with no sh:minCount is
  // satisfied by no values. Vacuous satisfaction is the correct answer, not vacuous failure.
  //
  // Measured on the suite's hardest entry, complex/shacl-shacl — SHACL-SHACL validating
  // itself. `shsh:PropertyShapeShape` requires each sh:path value to conform to
  // shsh:PathShape; a plain predicate path like `ex:p` is an IRI that appears nowhere as a
  // subject, so it failed, so every property shape in the meta-model failed the
  // "shapes are either node shapes or property shapes" xone. 55 violations from one line.
  return conformsToShape(data, focusFor(data, term), target, byId, depth + 1, subclassClosure);
}

function conformsToShape(
  data: ParsedDocument,
  subj: ParsedSubject,
  target: NodeShape,
  byId: ReadonlyMap<string, NodeShape>,
  depth: number,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): boolean {
  // ★ A CYCLE GUARD, NOT A DEPTH CAP — and the difference decided a real verdict.
  //
  // This read `if (depth > 12) return true`, which is two mistakes at once. It bounds
  // LEGITIMATE nesting, not just cycles: a shape twelve levels deep is unusual but valid,
  // and past the cap the engine stops evaluating and answers "conforms". And "conforms" is
  // not a safe thing to invent, because sh:not and sh:xone INVERT it — under sh:not,
  // give-up-and-conform becomes give-up-and-REFUSE.
  //
  // Measured on complex/shacl-shacl, the suite's self-validation: PathShape recursing
  // through the SHACL path grammar crossed depth 12, the cap answered "conforms" for a
  // branch it had not looked at, and the enclosing
  // `sh:xone ( NodeShapeShape PropertyShapeShape )` got the wrong count. Raising 12 to 40
  // made the test pass, which is exactly why it is the wrong fix: it moves the cliff.
  //
  // What actually terminates recursion is revisiting the SAME (shape, node) pair. Assuming
  // conformance for a pair already on the stack is the standard least-fixpoint reading of
  // recursive shapes — SHACL leaves recursion implementation-defined — and it triggers only
  // on a genuine cycle, so honest depth is evaluated however deep it goes.
  if (target.deactivated) return true;
  const cycleKey = JSON.stringify([target.id, subjectKey(subj)]);
  if (RECURSION_STACK.has(cycleKey)) return true;
  if (RECURSION_STACK.size > 20000) return true;   // pathological input backstop
  RECURSION_STACK.add(cycleKey);
  try {
    return conformsToShapeInner(data, subj, target, byId, depth, subclassClosure);
  } finally {
    RECURSION_STACK.delete(cycleKey);
  }
}

/**
 * The (shape, focus node) pairs currently being evaluated.
 *
 * Module-level rather than threaded through every signature: validation is synchronous and
 * single-threaded, the entry point clears it, and `finally` unwinds it on every path
 * including a throw. A parameter would have to be added to eight mutually recursive
 * functions, and the one that forgot to pass it would reintroduce the bug silently.
 */
const RECURSION_STACK = new Set<string>();

/**
 * The SPARQL-based constraint components declared by the SHAPES GRAPH of the run in progress.
 *
 * ★ RUN-SCOPED FOR THE SAME REASON `RECURSION_STACK` IS. A component activates on any shape
 * carrying its parameters, including a shape reached through sh:node, sh:not, sh:or, sh:xone
 * or sh:qualifiedValueShape — and conformance for those is decided by `conformsToShapeInner`,
 * which is eight mutually recursive calls away from the driver that compiled them. Threading
 * a parameter through all eight is the change where the one call site that forgets
 * reintroduces the bug silently.
 *
 * They come from the SHAPES document, never the data: a component is a declaration.
 */
let ACTIVE_COMPONENTS: readonly ConstraintComponentDef[] = [];

/**
 * The SHAPES document of the run in progress, for the two places that need to read a shape
 * while holding only the data graph: a `sh:targetNode [ sh:select … ]` selector, and the
 * prefixes it is written against. Run-scoped for the same reason as the two above.
 */
let ACTIVE_SHAPE_DOC: ParsedDocument | undefined;

function conformsToShapeInner(
  data: ParsedDocument,
  subj: ParsedSubject,
  target: NodeShape,
  byId: ReadonlyMap<string, NodeShape>,
  depth: number,
  subclassClosure?: ReadonlyMap<IRI, ReadonlySet<IRI>>,
): boolean {
  // Node-level value constraints apply to the focus node itself — the third of the three
  // copies this now shares. See nodeSatisfiesShape above.
  if (target.nodeLevelShape
    && evaluatePropertyShape(data, subj, target, target.nodeLevelShape,
      byId, depth, subclassClosure).length > 0) {
    return false;
  }
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
  if (logicalResults(data, subj, target, byId, depth, subclassClosure).length > 0) return false;
  // ★ A SPARQL CONSTRAINT IS A CONSTRAINT WHEREVER THE SHAPE IS REACHED. `sparqlConstraints`
  // was read at exactly one site — the top-level driver — so `sh:node ex:Inner` where
  // ex:Inner's only constraint is an sh:sparql enforced NOTHING, and so did the same shape
  // under sh:not, sh:or, sh:xone or sh:qualifiedValueShape. The shape looked constrained and
  // conformed to everything, which is the failure mode with no symptom.
  //
  // Under sh:not this is worse than a missed violation: a nested shape that can never fail
  // makes its negation always fail.
  if (target.sparqlConstraints !== undefined
    && sparqlResults(data, subj, {
      constraints: target.sparqlConstraints,
      sourceShape: target.id,
      severity: target.severity,
      ...(target.message !== undefined ? { shapeMessage: target.message } : {}),
    }).length > 0) {
    return false;
  }
  // ★ AND A CONSTRAINT COMPONENT IS A CONSTRAINT WHEREVER THE SHAPE IS REACHED, for exactly
  // the reason above. `componentResults` was called only by the driver, over top-level
  // shapes, so a component's parameters on a shape reached through sh:node — or on that
  // shape's property shapes — activated nothing at all.
  if (ACTIVE_COMPONENTS.length > 0
    && componentResults(data, subj, target, ACTIVE_COMPONENTS).length > 0) {
    return false;
  }
  for (const ps of target.propertyShapes) {
    if (evaluatePropertyShape(data, subj, target, ps, byId, depth + 1, subclassClosure)
      .length > 0) return false;
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
  // A SPARQL constraint on THIS property shape: `$PATH` is its path, sh:resultPath is its
  // path, and the report names it — not the node shape that carries it.
  if (ps.sparqlConstraints !== undefined && ps.pathExpr.kind !== 'identity') {
    const shapeMessage = ps.message ?? shape.message;
    results.push(...sparqlResults(data, focus, {
      constraints: ps.sparqlConstraints,
      sourceShape: ps.id,
      severity: ps.severity ?? shape.severity,
      ...(shapeMessage !== undefined ? { shapeMessage } : {}),
      path: ps.pathExpr,
      pathLabel: ps.path,
    }));
  }
  // ★ evaluatePath, not a map lookup: a sequence/inverse/alternative/transitive path has no
  // single predicate to look up, and looking one up is how those shapes came to enforce
  // nothing.
  const values = ps.valuesExpr !== undefined
    // ★ sh:values REPLACES the path lookup rather than adding to it. The path still names
    // the property the constraint is ABOUT — it is what sh:resultPath reports — but the
    // values are the expression's, which is the whole point of a derived field.
    ? [...evaluateNodeExpression(data, ps.valuesExpr, {
      focusNode: subjectAsTerm(focus),
      conforms: (n, sh) => nodeConformsToShape(data, n, sh),
      runQuery: (exprNode, f) => sparqlExpressionValues(data, exprNode, f),
    })]
    : ps.pathExpr.kind === 'predicate'
      ? [...(focus.properties.get(ps.pathExpr.iri) ?? [])]
      : evaluatePath(data, subjectAsTerm(focus), ps.pathExpr);
  const focusNode = focusLabel(focus);
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
    // ★ SHACL 1.2 §3.1.4 — a reifier on the CONSTRAINT triple overrides the shape's own
    // severity/message, and can switch one constraint off while leaving the rest of the
    // shape running. `sh:minCount 1 {| sh:severity sh:Info |}` is per-constraint scope, which
    // sh:severity on the shape cannot express: before this, softening one cardinality rule
    // meant softening every rule on that property.
    const override = ps.overrides?.get(component);
    if (override?.deactivated === true) return;
    results.push({
      focusNode,
      // §6.7.2.2 — sh:resultPath is present only for a result from a PROPERTY shape. The
      // identity path is this engine's internal spelling of "the focus node itself", and
      // emitting its rendering as a path would put a string where consumers expect an IRI.
      ...(ps.pathExpr.kind === 'identity' ? {} : { path }),
      sourceShape: ps.id,
      constraintComponent: `${SHACL}${component}`,
      severity: override?.severity ?? sev,
      // ★ sh:message WINS, everywhere. It was honoured by a handful of components that
      // remembered to write `ps.message ?? …` at their own call site and ignored by the
      // rest, so a shape author's message appeared or vanished depending on which
      // constraint happened to fail. SHACL §6.7.2.4 makes it the result's message when
      // present; centralising it here means a new component cannot forget.
      //
      // ★ AND "CENTRALISED" WAS NOT TRUE WHEN IT WAS FIRST WRITTEN. Eight components —
      // minCount, maxCount, nodeKind, datatype, class, pattern, in, hasValue, i.e. most of
      // the ones anyone actually writes — built their result object inline and never
      // reached this function. They each happened to repeat `ps.message ??`, so the message
      // rule looked centralised while being eight copies of it, and the FIRST rule added
      // here that they did not already duplicate (the §3.1.4 override below) silently
      // applied to none of them. Adding a rule to a helper proves nothing about the
      // constraints that do not call the helper.
      message: override?.message ?? ps.message ?? message,
      ...(value !== undefined ? { value: termValue(value) } : {}),
    });
  };

  // ── value range ────────────────────────────────────────────────────
  //
  // ★ AN INCOMPARABLE VALUE VIOLATES; it is not skipped. `sh:minExclusive 40` against
  // `"A string"` and against `rdfs:Resource` both produce a result (W3C Core
  // property/minExclusive-002, approved), because SPARQL raises a type error on those
  // operands and §4.3 makes the error a violation. Skipping them — which is what "if it is
  // not a finite number, continue" did — is the fail-OPEN reading: a bound stops applying to
  // exactly the values that are the wrong shape for it.
  const rangeCheck = (
    bound: ParsedTerm | undefined, component: string, ok: (cmp: number) => boolean, word: string,
  ): void => {
    if (bound === undefined) return;
    for (const v of values) {
      const cmp = compareForRange(v, bound);
      if (cmp === undefined) {
        fail(ps.path, component, `Value is not comparable with ${termValue(bound)}`, v);
      } else if (!ok(cmp)) {
        fail(ps.path, component, `Value ${termValue(v)} is ${word} ${termValue(bound)}`, v);
      }
    }
  };
  rangeCheck(ps.minInclusive, 'MinInclusiveConstraintComponent', c => c >= 0, 'below sh:minInclusive');
  rangeCheck(ps.maxInclusive, 'MaxInclusiveConstraintComponent', c => c <= 0, 'above sh:maxInclusive');
  rangeCheck(ps.minExclusive, 'MinExclusiveConstraintComponent', c => c > 0, 'not above sh:minExclusive');
  rangeCheck(ps.maxExclusive, 'MaxExclusiveConstraintComponent', c => c < 0, 'not below sh:maxExclusive');

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
    if (ps.languageIn) {
      // ★ A NON-LITERAL VIOLATES; it is not skipped. §4.4.4 requires every value node to be
      // a literal whose language tag matches, so an IRI or a blank node fails the
      // constraint outright. `v.kind === 'literal' &&` in the guard made the constraint stop
      // applying to exactly the values that cannot possibly satisfy it — the same fail-open
      // shape as the range bounds and the empty lists.
      const tag = v.kind === 'literal' ? (v.language ?? '').toLowerCase() : undefined;
      // BCP-47 basic filtering: "en" permits "en-GB".
      const ok = tag !== undefined && ps.languageIn.some(w => {
        const want = w.toLowerCase();
        return tag === want || tag.startsWith(want + '-');
      });
      if (!ok) {
        fail(ps.path, 'LanguageInConstraintComponent',
          v.kind === 'literal'
            ? `Language tag "${v.language ?? ''}" is not in sh:languageIn`
            : 'Value is not a language-tagged literal, so it cannot be in sh:languageIn', v);
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
    // ★ THE SAME TYPED RULE AS sh:minInclusive AND FRIENDS, for the same reason: §4.7
    // defines sh:lessThan by the SPARQL relational operators, so comparing an integer with a
    // string is a type error, and SHACL makes the error a VIOLATION.
    //
    // The local comparator this replaced pointed the other way twice over. It coerced with
    // Number() and then fell back to LEXICOGRAPHIC order for anything non-numeric, so a
    // cross-type comparison got an answer instead of an error -- and the two call sites
    // below then wrote `c !== undefined && ...`, reading "cannot compare" as "comparison
    // satisfied". Both halves fail open.
    const cmp = compareForRange;
    if (ps.lessThan) {
      for (const v of values) for (const x of other(ps.lessThan)) {
        const c = cmp(v, x);
        if (c === undefined || c >= 0) {   // undefined is a type error, i.e. a violation
          fail(ps.path, 'LessThanConstraintComponent', `Value must be less than every value of ${renderPath(ps.lessThan)}`, v);
        }
      }
    }
    if (ps.lessThanOrEquals) {
      for (const v of values) for (const x of other(ps.lessThanOrEquals)) {
        const c = cmp(v, x);
        if (c === undefined || c > 0) {    // undefined is a type error, i.e. a violation
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
          // ★ ATTRIBUTED TO EACH CONSTRAINT THAT ASKED, not all to sh:memberShape. §7.5
          // makes "not a list" a violation of every list constraint on the shape, and a
          // shape declaring only sh:maxListLength was being told it had a memberShape
          // problem — a component it never used. The report named a rule the author had
          // not written.
          if (ps.minListLength !== undefined) {
            fail(ps.path, 'MinListLengthConstraintComponent',
              'Value node is not a SHACL list, so it has no list length', v);
          }
          if (ps.maxListLength !== undefined) {
            fail(ps.path, 'MaxListLengthConstraintComponent',
              'Value node is not a SHACL list, so it has no list length', v);
          }
          if (ps.uniqueMembers === true) {
            fail(ps.path, 'UniqueMembersConstraintComponent',
              'Value node is not a SHACL list, so it has no members to be unique', v);
          }
          if (ps.memberShape !== undefined) {
            fail(ps.path, 'MemberShapeConstraintComponent',
              'Value node is not a SHACL list, so it has no members to check', v);
          }
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
        // ★ FOUR CONTROL CHARACTERS BREAK A LINE, not two. Line feed and carriage return
        // are the ones anyone thinks of; the suite also pins FORM FEED (u+000C) and LINE
        // TABULATION (u+000B), and XML's definition of a line boundary includes them.
        // Checking two of the four let a label with an embedded form feed through a constraint whose
        // entire job is to refuse embedded line breaks.
        const lex = termValue(v);
        const BREAKS = [10, 13, 12, 11].map(c => String.fromCharCode(c));
        if (BREAKS.some(b => lex.includes(b))) {
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
        // §4.7.4 — with sh:qualifiedValueShapesDisjoint, the SIBLING qualified value shapes
        // are those of the parent shape's OTHER property shapes. A value conforming to any
        // of them is excluded from this count, so the counts partition the values instead
        // of double-counting a value that satisfies two of them.
        const siblings = ps.qualifiedValueShapesDisjoint === true
          ? shape.propertyShapes
            .filter(x => x.id !== ps.id && x.qualifiedValueShape !== undefined)
            .map(x => byId.get(x.qualifiedValueShape!))
            .filter((x): x is NodeShape => x !== undefined)
          : [];
        let n = 0;
        for (const v of values) {
          if (!nodeSatisfiesShape(data, v, target, byId, depth, subclassClosure)) continue;
          if (siblings.some(sib => nodeSatisfiesShape(data, v, sib, byId, depth, subclassClosure))) {
            continue;
          }
          n++;
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
    fail(ps.path, 'MinCountConstraintComponent',
      `Value count ${values.length} is below sh:minCount ${ps.minCount} for ${ps.path}`);
  }
  if (ps.maxCount !== undefined && values.length > ps.maxCount) {
    fail(ps.path, 'MaxCountConstraintComponent',
      `Value count ${values.length} exceeds sh:maxCount ${ps.maxCount} for ${ps.path}`);
  }

  for (const v of values) {
    for (const alternatives of ps.nodeKinds ?? []) {
      if (!alternatives.some(k => matchesNodeKind(v, k))) {
        fail(ps.path, 'NodeKindConstraintComponent',
          `Value does not match sh:nodeKind ${alternatives.join(' | ')}`, v);
      }
    }
    for (const alternatives of ps.datatypes ?? []) {
      if (!alternatives.some(d => matchesDatatype(v, d))) {
        fail(ps.path, 'DatatypeConstraintComponent',
          `Value does not match sh:datatype ${alternatives.join(' | ')}`, v);
      }
    }
    for (const alternatives of ps.classes ?? []) {
      if (!alternatives.some(cl => valueHasClass(data, v, cl, subclassClosure))) {
        fail(ps.path, 'ClassConstraintComponent',
          `Value is not an instance of sh:class ${alternatives.join(' | ')}`, v);
      }
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
          fail(ps.path, 'PatternConstraintComponent',
            `Value does not match sh:pattern /${ps.pattern}/`, v);
        }
      } catch {
        // Malformed regex in shape — skip rather than crash the gate.
      }
    }
    if (ps.inValues !== undefined && !ps.inValues.some(allowed => termsEqual(allowed, v))) {
      fail(ps.path, 'InConstraintComponent',
        ps.inValues.length === 0
          ? 'sh:in is the empty list, which permits no value at all'
          : 'Value is not in the sh:in enumeration', v);
    }
  }

  // ── sh:property nested on a property shape: the VALUE NODES are the focus nodes ──
  if (ps.propertyShapes && ps.propertyShapes.length > 0 && depth < 64) {
    for (const v of values) {
      const inner = focusFor(data, v);
      for (const nested of ps.propertyShapes) {
        for (const r of evaluatePropertyShape(
          data, inner, shape, nested, byId, depth + 1, subclassClosure)) {
          results.push(r);
        }
      }
    }
  }

  // ── sh:expression: the expression must come back TRUE ──
  if (ps.expression !== undefined) {
    for (const v of values) {
      const result = evaluateNodeExpression(data, ps.expression, {
        focusNode: v,
        conforms: (n, sh) => nodeConformsToShape(data, n, sh),
      });
      // Anything other than exactly `true` fails — including an empty sequence, which is
      // "the expression had no answer" rather than "the answer was yes".
      const ok = result.length === 1 && result[0]!.kind === 'literal'
        && result[0]!.value === 'true';
      if (!ok) {
        fail(ps.path, 'ExpressionConstraintComponent',
          'The value does not satisfy sh:expression — the expression did not evaluate to true',
          v);
      }
    }
  }

  // ── sh:nodeByExpression: the shapes are computed, then applied ──
  if (ps.nodeByExpression !== undefined) {
    for (const v of values) {
      const shapes = evaluateNodeExpression(data, ps.nodeByExpression, {
        focusNode: v,
        conforms: (n, sh) => nodeConformsToShape(data, n, sh),
      });
      for (const shapeTerm of shapes) {
        if (!nodeConformsToShape(data, v, shapeTerm)) {
          fail(ps.path, 'NodeByExpressionConstraintComponent',
            `Value does not conform to the shape computed by sh:nodeByExpression `
            + `(${termValue(shapeTerm)})`, v);
        }
      }
    }
  }

  if (ps.hasValue) {
    const present = values.some(v => termsEqual(v, ps.hasValue!));
    if (!present) {
      fail(ps.path, 'HasValueConstraintComponent',
        `Required sh:hasValue ${termValue(ps.hasValue)} is missing`);
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
/**
 * Does a node conform to a shape written inline in the SAME document?
 *
 * ★ EXISTS TO BREAK A CYCLE, and the cycle is real rather than a build artefact. SHACL 1.2
 * node expressions include `shnex:filterShape`, `shnex:findFirst`, `shnex:nodesMatching`,
 * `shnex:matchAll` and `shnex:conformsToShape` — every one of which asks "does this node
 * satisfy that shape". The validator is what can answer, and the validator is also what will
 * CALL the expression evaluator for `sh:nodeByExpression`. So node-expression.ts takes the
 * check as an injected function and this is the implementation of it.
 *
 * The shape is a TERM in the same document rather than a separate shapes graph: in a node
 * expression it is almost always an inline blank node, `[ sh:minInclusive 3 ]`, which has no
 * identity outside the document it is written in.
 */
// ═══════════════════════════════════════════════════════════════
//  The seam the RULES engine composes
// ═══════════════════════════════════════════════════════════════
//
// ★ FOUR FUNCTIONS, NOT THE INTERNALS. `shacl-rules.ts` needs four things this file already
// knows how to do — which nodes a shape targets, which prefixes a SPARQL string is written
// against, which functions the shapes graph declares, and what a node expression evaluates
// to. Everything else it does itself.
//
// Exported as a named seam rather than by widening `NodeShape` and `findFocusNodes` into the
// public API: those are internal shapes that change whenever a constraint component is added,
// and a second module pinned to them turns every such change into a breaking one.

const COMPILED_SHAPES = new WeakMap<ParsedDocument, ReadonlyMap<string, NodeShape>>();

function compiledShapesOf(doc: ParsedDocument): ReadonlyMap<string, NodeShape> {
  let m = COMPILED_SHAPES.get(doc);
  if (m === undefined) {
    m = new Map(compileShapes(doc).map(s => [s.id, s]));
    COMPILED_SHAPES.set(doc, m);
  }
  return m;
}

/**
 * The nodes one shape TARGETS in a data graph — every target form, including implicit class
 * targets and `sh:target` with a SELECT.
 *
 * The shapes and the data are separate documents here because a rules engine re-asks this
 * question after every iteration: a rule that types a node `ex:Person` brings that node into
 * the targets of every shape targeting `ex:Person`, including its own.
 */
export function targetNodesOf(
  shapesDoc: ParsedDocument, dataDoc: ParsedDocument, shapeId: string,
): readonly ParsedTerm[] {
  const byId = compiledShapesOf(shapesDoc);
  const shape = byId.get(shapeId);
  if (!shape) return [];
  // ★ THE SCOPE HAS TO BE ESTABLISHED HERE TOO, and leaving it out made the target fix reach
  // only one of its two callers. `findFocusNodes` resolves a `sh:targetNode [ sh:select … ]`
  // selector against ACTIVE_SHAPE_DOC; the rules engine calls this function with the shapes
  // graph in hand and no validation running, so the selector fell back to the DATA graph, was
  // not found there, and the SELECTOR BLANK NODE became the focus node. Measured: the rule
  // tagged `_:shapes._anon1` instead of ex:p1.
  const savedShapeDoc = ACTIVE_SHAPE_DOC;
  if (savedShapeDoc === undefined) ACTIVE_SHAPE_DOC = shapesDoc;
  try {
    return findFocusNodes(dataDoc, shape, buildSubclassClosure(dataDoc).closure, byId)
      .map(subjectAsTerm);
  } finally {
    ACTIVE_SHAPE_DOC = savedShapeDoc;
  }
}

/** The prefix declarations in scope for a SPARQL string attached to this node. */
export function sparqlPrefixesFor(
  shapesDoc: ParsedDocument, node: ParsedSubject,
): ReadonlyMap<string, string> {
  return prefixesFor(shapesDoc, node);
}

/** The functions a shapes graph declares with `sh:function`, ready to call from a query. */
export function shapeFunctions(shapesDoc: ParsedDocument): ReadonlyMap<string, UserFunction> {
  return userFunctionsFor(shapesDoc);
}

/**
 * Evaluate a node expression with the engine's full context wired in.
 *
 * ★ THE CONTEXT IS THE POINT. `evaluateNodeExpression` is already exported, but it takes a
 * context the caller must supply — `conforms` for `shnex:filterShape`, `runQuery` for
 * `sh:select`. A caller that omits them gets an evaluator that silently drops those operators,
 * which is how `sh:values [ sh:select … ]` came to evaluate to its own blank node.
 */
export function nodeExpressionValues(
  doc: ParsedDocument, expr: ParsedTerm, focus: ParsedTerm | undefined,
): readonly ParsedTerm[] {
  return evaluateNodeExpression(doc, expr, {
    ...(focus !== undefined ? { focusNode: focus } : {}),
    conforms: (n, sh) => nodeConformsToShape(doc, n, sh),
    runQuery: (exprNode, f) => sparqlExpressionValues(doc, exprNode, f),
  });
}

export function nodeConformsToShape(
  doc: ParsedDocument, node: ParsedTerm, shape: ParsedTerm,
): boolean {
  // ★ ALSO AN ENTRY POINT. Called from inside a validation it must leave the run's state
  // alone; called on its own — by the rules engine for an `sh:condition`, or by a node
  // expression's `shnex:filterShape` — there is no run, and the constraint components have to
  // come from the document it was handed or a component-based condition silently passes.
  const outermost = ACTIVE_SHAPE_DOC === undefined;
  const savedComponents = ACTIVE_COMPONENTS;
  if (outermost) {
    ACTIVE_SHAPE_DOC = doc;
    ACTIVE_COMPONENTS = componentsOf(doc);
  }
  try {
    return nodeConformsToShapeInner(doc, node, shape);
  } finally {
    if (outermost) {
      ACTIVE_SHAPE_DOC = undefined;
      ACTIVE_COMPONENTS = savedComponents;
    }
  }
}

/** Constraint components compiled once per document. */
const COMPILED_COMPONENTS = new WeakMap<ParsedDocument, readonly ConstraintComponentDef[]>();
function componentsOf(doc: ParsedDocument): readonly ConstraintComponentDef[] {
  let defs = COMPILED_COMPONENTS.get(doc);
  if (defs === undefined) {
    defs = compileConstraintComponents(doc);
    COMPILED_COMPONENTS.set(doc, defs);
  }
  return defs;
}

function nodeConformsToShapeInner(
  doc: ParsedDocument, node: ParsedTerm, shape: ParsedTerm,
): boolean {
  const shapes = compileShapes(doc);
  const byId = new Map<string, NodeShape>();
  for (const sh of shapes) byId.set(sh.id, sh);
  const k = refKey(shape);
  const target = k === undefined ? undefined : byId.get(k);
  // A shape the document does not describe constrains nothing, so everything satisfies it —
  // which is also what `shnex:filterShape [ ]` (no constraints) is expected to do: keep
  // every input node rather than drop them all.
  if (!target) return true;
  return nodeSatisfiesShape(doc, node, target, byId, 0, buildSubclassClosure(doc).closure);
}

/**
 * Evaluate a SHACL 1.2 node expression, with shape conformance wired in.
 *
 * The thin wrapper is the whole point: a caller that reached for evaluateNodeExpression
 * directly would get an evaluator whose five shape-valued operators silently return nothing.
 */
export function evaluateExpression(
  doc: ParsedDocument,
  expr: ParsedTerm | undefined,
  ctx: Omit<NodeExpressionContext, 'conforms'> = {},
): ParsedTerm[] {
  return evaluateNodeExpression(doc, expr, {
    ...ctx,
    conforms: (node, shape) => nodeConformsToShape(doc, node, shape),
  });
}

export function validateAgainstShape(
  dataTurtle: string,
  shapeTurtle: string,
  options: ValidateAgainstShapeOptions = {},
): ShaclReport {
  // ★ RESTORED ON EVERY PATH, INCLUDING A THROW — and clearing at the START was not enough.
  // `ACTIVE_COMPONENTS` and `ACTIVE_SHAPE_DOC` were set here and cleared only by the NEXT
  // call, so they outlived the run: a later `nodeConformsToShape` — which is how a node
  // expression asks about a shape, and how the rules engine checks an `sh:condition` — used
  // whichever components the previous, unrelated validation had compiled. Worse than wrong:
  // ORDER-DEPENDENT, so the same inference answered differently depending on what ran before
  // it. Exactly the hazard the recursion guard's own comment describes, in the state I added
  // beside it.
  const savedComponents = ACTIVE_COMPONENTS;
  const savedShapeDoc = ACTIVE_SHAPE_DOC;
  try {
    return validateAgainstShapeInner(dataTurtle, shapeTurtle, options);
  } finally {
    ACTIVE_COMPONENTS = savedComponents;
    ACTIVE_SHAPE_DOC = savedShapeDoc;
  }
}

function validateAgainstShapeInner(
  dataTurtle: string,
  shapeTurtle: string,
  options: ValidateAgainstShapeOptions,
): ShaclReport {
  // The recursion guard unwinds itself in `finally` on every path, so this should always be
  // a no-op. It is here because "should always be" is the assumption that makes shared
  // mutable state expensive to be wrong about: one leaked entry would make a later,
  // unrelated validation silently answer "conforms" for that (shape, node) pair.
  RECURSION_STACK.clear();
  ACTIVE_COMPONENTS = [];
  ACTIVE_SHAPE_DOC = undefined;
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
      conformanceDisallows: options.conformanceDisallows ?? ['Info', 'Warning', 'Violation'],
      results: [{
        focusNode: '',
        constraintComponent: `${SHACL}ShapeGraphParseFailure`,
        severity: 'Violation',
        message: `Shape graph is not parseable as Turtle/TriG: ${(err as Error).message}`,
      }],
      // Nothing ran at all, so nothing was fully checked either.
      fullyChecked: false,
      // Nothing COMPILED either. Zero here is not the "you named a document that is not a
      // shapes graph" signal the gate keys on — `conforms` is already false and carries a
      // parse failure that says precisely why, which is the stronger and earlier answer.
      shapesDeclared: 0,
      shapesApplied: 0,
    };
  }
  let dataDoc: ParsedDocument;
  try {
    dataDoc = parseTrig(dataTurtle);
  } catch {
    return {
      conforms: false,
      conformanceDisallows: options.conformanceDisallows ?? ['Info', 'Warning', 'Violation'],
      results: [{
        focusNode: '',
        constraintComponent: `${SHACL}DataGraphParseFailure`,
        severity: 'Violation',
        message: 'Data graph is not parseable as Turtle/TriG',
      }],
      fullyChecked: false,
      // The SHAPES graph parsed, but nothing was compiled from it before this return, so the
      // honest count is zero rather than a number this path never computed.
      shapesDeclared: 0,
      shapesApplied: 0,
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
      advisory: true,
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
  // Compiled from the SHAPES graph, once: a component is a declaration, not per-focus-node
  // state, and recompiling it inside the loop would be quadratic in a file that declares
  // several.
  const components = compileConstraintComponents(shapeDoc);
  ACTIVE_COMPONENTS = components;
  ACTIVE_SHAPE_DOC = shapeDoc;
  const liveShapeIds = new Set<string>();
  for (const shape of shapes) {
    // sh:deactivated — a shape switched off by its author MUST produce no results.
    if (shape.deactivated) continue;
    const focusNodes = findFocusNodes(dataDoc, shape, subclassClosure, byId);
    if (focusNodes.length > 0) liveShapeIds.add(shape.id);

    // ── sh:uniqueValuesFor — the one Core component that spans focus nodes ──
    //
    // Evaluated here rather than inside the loop below because it is not decidable from one
    // focus node: "unique" is a statement about the whole target set, and the node that
    // breaks it is indistinguishable from the node that is fine until you have seen both.
    //
    // A node missing a value for ANY path of the key does not participate — approved test
    // uniqueValuesFor-004 pins that, and the alternative reading (absent counts as its own
    // key) would make every incomplete record collide with every other one.
    if (shape.uniqueValuesFor && focusNodes.length > 1) {
      const byKey = new Map<string, ParsedSubject[]>();
      for (const focus of focusNodes) {
        const term = subjectAsTerm(focus);
        const parts: string[] = [];
        let complete = true;
        for (const path of shape.uniqueValuesFor) {
          const vals = evaluatePath(dataDoc, term, path);
          if (vals.length === 0) { complete = false; break; }
          // Order-independent within one path, so two nodes carrying the same multi-valued
          // key in a different document order are still the same key.
          parts.push(JSON.stringify([...vals.map(v => [v.kind, termValue(v)])].sort()));
        }
        if (!complete) continue;
        const k = JSON.stringify(parts);
        (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(focus);
      }
      for (const [, group] of byKey) {
        if (group.length < 2) continue;
        for (const focus of group) {
          results.push({
            focusNode: focusLabel(focus),
            sourceShape: shape.id,
            constraintComponent: `${SHACL}UniqueValuesForConstraintComponent`,
            severity: shape.overrides?.get('UniqueValuesForConstraintComponent')?.severity
              ?? shape.severity,
            message: shape.overrides?.get('UniqueValuesForConstraintComponent')?.message
              ?? shape.message
              ?? `${group.length} focus nodes of ${shape.id} share the same value for `
                + `sh:uniqueValuesFor; each must be unique`,
          });
        }
      }
    }
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
              advisory: true,
              message: `[entailment-observe] would REJECT under entailment:'rdfs' — ${r.message ?? ''}`,
            }
          : r);
      };
      if (shape.nodeLevelShape) {
        for (const r of evaluatePropertyShape(
          dataDoc, focus, shape, shape.nodeLevelShape, byId, 0, subclassClosure)) emit(r);
      }
      for (const r of sparqlResults(dataDoc, focus, {
        constraints: shape.sparqlConstraints ?? [],
        sourceShape: shape.id,
        severity: shape.severity,
        ...(shape.message !== undefined ? { shapeMessage: shape.message } : {}),
      })) emit(r);
      for (const r of componentResults(dataDoc, focus, shape, components)) emit(r);
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
            focusNode: focusLabel(focus),
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
  // A custom severity IRI has no place in this order — the spec defines no ordering over
  // user-defined severities — so it ranks alongside Violation, which is the conservative
  // end. "Cap this at Warning" must not be a way to quietly downgrade something an author
  // named themselves.
  const rankOf = (x: ShaclSeverity): number => {
    const i = (NAMED_SEVERITIES as readonly string[]).indexOf(x);
    return i === -1 ? NAMED_SEVERITIES.length - 1 : i;
  };
  const stricter = (a: ShaclSeverity, b: ShaclSeverity): ShaclSeverity =>
    rankOf(a) >= rankOf(b) ? a : b;
  const laxer = (a: ShaclSeverity, b: ShaclSeverity): ShaclSeverity =>
    rankOf(a) <= rankOf(b) ? a : b;
  /** `sh:severity` declared on ANY subject, not just the ones that compiled to node shapes. */
  const declaredOn = (key: string): ShaclSeverity | undefined => {
    const subj = subjectsByKey.get(key);
    if (!subj) return undefined;
    return decodeSeverity(asIri(subj.properties.get(SH_SEVERITY)?.[0]));
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
      advisory: true,
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

  // ★ `conforms` NOW MEANS WHAT SHACL SAYS IT MEANS, and it did not before.
  //
  // §3.6: sh:conforms is "true if the validation did not produce any validation results,
  // and false otherwise" — not "any Violations", which is what we counted, so a shape
  // declaring `sh:severity sh:Warning` reported conforms:true on data that broke it.
  //
  // Measured against pySHACL on the same graph and the same shapes file:
  //   ours  conforms=true   results=1 [Warning]
  //   pySHACL conforms=False
  //
  // That is the sh:pattern divergence again, in the field that consumers actually branch
  // on. A shape published at a dereferenceable IRI is a claim a stranger must be able to
  // re-verify, and two engines answering opposite ways about the same document is worse
  // than either answer: the author sees green here and red everywhere else, and the
  // published shape means something different depending on who reads it.
  //
  // ★ WHAT IS DELIBERATELY EXCLUDED, AND WHY IT IS NOT A LOOPHOLE. Results marked
  // `advisory` are not validation results in SHACL's sense — see ShaclResult.advisory.
  // Folding them in would make every graph non-conforming against any shapes file
  // containing one construct we cannot evaluate, and would make `entailment: 'rdfs-observe'`
  // — whose whole contract is "report what enforcing WOULD reject, without rejecting" —
  // reject. They keep their own rule, unchanged and still fail-closed: an advisory RAISED
  // TO Violation refuses exactly as it did before.
  // ★ AND TRACE/DEBUG DO NOT COUNT — which is narrower than "any result", and is a 1.2
  // refinement I got wrong on the first pass and the suite corrected. sh:Trace and sh:Debug
  // are diagnostic levels new in 1.2, below sh:Info; they report without bearing on whether
  // the data conforms. Approved, and unambiguous side by side:
  //   misc/severity-003 — one sh:Warning result, sh:conforms FALSE
  //   misc/severity-004 — one sh:Debug   result, sh:conforms TRUE
  //   misc/severity-005 — one sh:Trace   result, sh:conforms TRUE
  const disallows: readonly ShaclSeverity[] = options.conformanceDisallows
    ?? ['Info', 'Warning', 'Violation'];
  const countsAgainst = new Set<ShaclSeverity>(disallows);
  return {
    // An ADVISORY result is engine instrumentation, not a finding about the data, so the
    // caller's severity choice does not apply to it: a Violation-severity advisory is
    // fail-closed by construction and refuses regardless.
    conforms: !all.some(r => r.advisory === true
      ? r.severity === 'Violation'
      : countsAgainst.has(r.severity)),
    conformanceDisallows: disallows,
    results: all,
    fullyChecked,
    // ★ FROM `shapes`, NOT FROM `shapeDoc.subjects`. A shapes file's subjects include its
    // owl:Ontology header, its rdfs:label carriers and every blank node hanging off a
    // constraint — counting those would report a healthy-looking number for a document that
    // compiled to nothing, which is the exact silence this field exists to end.
    shapesDeclared: shapes.length,
    shapesApplied: liveShapeIds.size,
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
