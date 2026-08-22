/**
 * SHACL rules — the INFERENCE half of the language, run to a fixpoint.
 *
 * ★ SHACL IS TWO THINGS AND THIS REPO SHIPPED ONE. Every shape here has been read as a
 * question ("does this graph conform?") when the same vocabulary also answers a statement
 * ("here is what else is true"). `sh:rule` derives triples from the ones already asserted: an
 * area from a width and a height, a transitive closure, an RDFS entailment. The W3C suite
 * ships 18 approved entries for it and this engine ran none of them, recorded honestly as NOT
 * RUN — which is the right way to carry a gap and no substitute for closing it.
 *
 * ── WHY NOT `runShaclRules` ──────────────────────────────────────────────────
 *
 * There is already a `runShaclRules` in shacl-engine.ts and it stays exactly as it is. It
 * serves the substrate's REDUCE verb, where a rule's output is folded into a content-addressed
 * head state, and it deliberately REFUSES `sh:SPARQLRule` — because the honest answer to "I
 * cannot execute this CONSTRUCT" in that setting is to refuse the fold, not to union the input
 * and call it a transform. That refusal is load-bearing and predates this evaluator.
 *
 * This module is the general engine: it answers "what does this rule set infer?" and returns
 * the triples rather than a document. The reducer can adopt it later, deliberately, with its
 * own tests — silently changing what a content-addressed pipeline computes is not a refactor.
 *
 * ── THE ALGORITHM IS THE SPEC'S, IN ITS ORDER ────────────────────────────────
 *
 *   for each layer, ascending:
 *     compute the expected derived triples for the layer's rules
 *     run every run-once rule once
 *     repeat { run every iterating rule } until an iteration infers nothing new
 *   delete the derived triples no rule also inferred, and their reifiers
 *   delete the temporary triples and their reifiers
 *
 * ★ THE FIXPOINT IS THE WHOLE POINT OF A LAYER. `$this ex:child/ex:offspring? ?offspring`
 * computes a transitive closure by seeing its OWN output — a grandmother reaches her grandson
 * only on the second pass. Running each rule once produces a plausible, incomplete answer, and
 * nothing in the output says which.
 */
import { parseTrig } from '../rdf/turtle-parser.js';
import type { ParsedDocument, ParsedSubject, ParsedTerm } from '../rdf/turtle-parser.js';
import type { IRI } from '../model/types.js';
import { runSparql, SparqlRefusedError } from './sparql-query.js';
import {
  nodeConformsToShape, nodeExpressionValues, shapeFunctions, sparqlPrefixesFor, targetNodesOf,
} from './shacl-engine.js';

const SHACL = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const RDF_TYPE = `${RDF}type` as IRI;
const RDF_REIFIES = `${RDF}reifies` as IRI;
const SH_RULE = `${SHACL}rule` as IRI;
const SH_CONSTRUCT = `${SHACL}construct` as IRI;
const SH_CONDITION = `${SHACL}condition` as IRI;
const SH_DEACTIVATED = `${SHACL}deactivated` as IRI;
const SH_LAYER = `${SHACL}layer` as IRI;
const SH_ORDER = `${SHACL}order` as IRI;
const SH_RUN_ONCE = `${SHACL}runOnce` as IRI;
const SH_SUBJECT = `${SHACL}subject` as IRI;
const SH_PREDICATE = `${SHACL}predicate` as IRI;
const SH_OBJECT = `${SHACL}object` as IRI;
const SH_TEMP_TRIPLE = `${SHACL}tempTriple` as IRI;
const SH_EXPECTED_PREDICATE = `${SHACL}expectedPredicate` as IRI;
const SH_SPARQL_RULE = `${SHACL}SPARQLRule` as IRI;
const SH_TRIPLE_RULE = `${SHACL}TripleRule` as IRI;
const SH_RULE_CLASS = `${SHACL}Rule` as IRI;
const SH_RULE_SET = `${SHACL}RuleSet` as IRI;
const SH_HAS_RULE = `${SHACL}hasRule` as IRI;
const SH_INCLUDES_RULE_SET = `${SHACL}includesRuleSet` as IRI;
const SH_PATH = `${SHACL}path` as IRI;
const SH_PROPERTY = `${SHACL}property` as IRI;
const SH_VALUES = `${SHACL}values` as IRI;
const SH_DEFAULT_VALUE = `${SHACL}defaultValue` as IRI;
const SH_SHAPE_CLASS = `${SHACL}ShapeClass` as IRI;
const SH_NODE_SHAPE = `${SHACL}NodeShape` as IRI;
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const RDFS_CLASS = `${RDFS}Class` as IRI;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf` as IRI;

/** One inferred triple. */
export interface InferredTriple {
  readonly subject: ParsedTerm;
  readonly predicate: IRI;
  readonly object: ParsedTerm;
}

/** Thrown when a rule set cannot be executed — which the spec calls a FAILURE. */
export class ShaclRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShaclRulesError';
  }
}

export interface InferenceOptions {
  /**
   * ★ A GUARD, NOT A TUNING KNOB. The spec permits a rules engine to fail after a maximum
   * iteration count precisely because a rule set can diverge. Exceeding it THROWS rather than
   * returning what it had, because a partial fixpoint is indistinguishable from a complete one
   * once it has been returned.
   */
  readonly maxIterations?: number;
  /** Same reasoning, for a rule set that grows without ever repeating itself. */
  readonly maxTriples?: number;
  /** Run only the rules of this `sh:RuleSet`. The default is every rule in the graph. */
  readonly ruleSet?: IRI;
}

export interface InferenceResult {
  /** The triples the rules added, in the order they were inferred. */
  readonly triples: readonly InferredTriple[];
  /** Fixpoint iterations, summed over layers. */
  readonly iterations: number;
}

// ═══════════════════════════════════════════════════════════════
//  A graph you can add to
// ═══════════════════════════════════════════════════════════════

function termKey(t: ParsedTerm): string {
  switch (t.kind) {
    case 'iri': return `<${t.iri}>`;
    case 'bnode': return `_:${t.id}`;
    case 'triple': return `<<${termKey(t.subject)} <${t.predicate}> ${termKey(t.object)}>>`;
    default:
      // The base direction rides in the language tag (`en--ltr`), so three fields identify a
      // literal — and all three matter: "1" and "1"^^xsd:integer are different terms.
      return JSON.stringify([t.value, t.datatype ?? '', t.language ?? '']);
  }
}

function tripleKey(t: InferredTriple): string {
  return `${termKey(t.subject)} <${t.predicate}> ${termKey(t.object)}`;
}

function subjectTerm(s: ParsedSubject): ParsedTerm {
  return typeof s.subject === 'string'
    ? { kind: 'iri', iri: s.subject }
    : { kind: 'bnode', id: s.subject.bnode };
}

/**
 * The data graph as rules see it: readable as a ParsedDocument, writable a triple at a time.
 *
 * ★ THE DOCUMENT VIEW IS REBUILT, NOT PATCHED. Everything downstream — the SPARQL evaluator,
 * the node-expression evaluator, `targetNodesOf` — takes a ParsedDocument whose subjects and
 * property maps are declared readonly, and several of them index or memoise it. Mutating one
 * in place would leave those indexes describing a graph that no longer exists, which is the
 * class of bug where a rule's second iteration reads its first iteration's data through a
 * stale map.
 */
class RuleGraph {
  private readonly bySubject = new Map<string, {
    subject: IRI | { readonly bnode: string };
    properties: Map<IRI, ParsedTerm[]>;
  }>();

  private readonly present = new Set<string>();
  private readonly prefixes: ReadonlyMap<string, string>;
  private view: ParsedDocument | undefined;

  constructor(doc: ParsedDocument) {
    this.prefixes = doc.prefixes;
    for (const s of doc.subjects) {
      for (const [p, objs] of s.properties) {
        for (const o of objs) this.add({ subject: subjectTerm(s), predicate: p, object: o });
      }
    }
  }

  add(t: InferredTriple): boolean {
    if (t.subject.kind !== 'iri' && t.subject.kind !== 'bnode') return false;
    const k = tripleKey(t);
    if (this.present.has(k)) return false;
    this.present.add(k);
    const sk = termKey(t.subject);
    let entry = this.bySubject.get(sk);
    if (entry === undefined) {
      entry = {
        subject: t.subject.kind === 'iri' ? t.subject.iri : { bnode: t.subject.id },
        properties: new Map(),
      };
      this.bySubject.set(sk, entry);
    }
    const objs = entry.properties.get(t.predicate);
    if (objs === undefined) entry.properties.set(t.predicate, [t.object]);
    else objs.push(t.object);
    this.view = undefined;
    return true;
  }

  remove(t: InferredTriple): void {
    const k = tripleKey(t);
    if (!this.present.delete(k)) return;
    const sk = termKey(t.subject);
    const entry = this.bySubject.get(sk);
    const objs = entry?.properties.get(t.predicate);
    if (entry === undefined || objs === undefined) return;
    const i = objs.findIndex(o => termKey(o) === termKey(t.object));
    if (i >= 0) objs.splice(i, 1);
    if (objs.length === 0) entry.properties.delete(t.predicate);
    if (entry.properties.size === 0) this.bySubject.delete(sk);
    this.view = undefined;
  }

  has(t: InferredTriple): boolean { return this.present.has(tripleKey(t)); }

  get size(): number { return this.present.size; }

  /** Every triple whose subject is this term. */
  outgoing(subject: ParsedTerm): InferredTriple[] {
    const entry = this.bySubject.get(termKey(subject));
    const out: InferredTriple[] = [];
    for (const [p, objs] of entry?.properties ?? []) {
      for (const o of objs) out.push({ subject, predicate: p, object: o });
    }
    return out;
  }

  /** Every subject that points at this object through this predicate. */
  subjectsWith(predicate: IRI, object: ParsedTerm): ParsedTerm[] {
    const target = termKey(object);
    const out: ParsedTerm[] = [];
    for (const [, entry] of this.bySubject) {
      for (const o of entry.properties.get(predicate) ?? []) {
        if (termKey(o) === target) {
          out.push(typeof entry.subject === 'string'
            ? { kind: 'iri', iri: entry.subject }
            : { kind: 'bnode', id: entry.subject.bnode });
        }
      }
    }
    return out;
  }

  doc(): ParsedDocument {
    this.view ??= {
      prefixes: this.prefixes,
      subjects: [...this.bySubject.values()].map(e => ({
        subject: e.subject,
        properties: e.properties as ReadonlyMap<IRI, readonly ParsedTerm[]>,
      })),
    };
    return this.view;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Reading the rule set out of the shapes graph
// ═══════════════════════════════════════════════════════════════

interface Rule {
  readonly node: ParsedSubject;
  readonly key: string;
  /** The shape that owns it. Absent for a GLOBAL rule, which has no focus node. */
  readonly shapeKey?: string;
  readonly kind: 'sparql' | 'triple';
  readonly layer: number;
  readonly order: number;
  readonly runOnce: boolean;
  readonly deactivated: boolean;
}

function keyOf(s: ParsedSubject): string {
  return typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`;
}

function refKey(t: ParsedTerm): string | undefined {
  return t.kind === 'iri' ? t.iri : t.kind === 'bnode' ? `_:${t.id}` : undefined;
}

function numberOf(subj: ParsedSubject, pred: IRI, fallback: number): number {
  const t = subj.properties.get(pred)?.[0];
  if (t?.kind !== 'literal') return fallback;
  const n = Number(t.value);
  return Number.isFinite(n) ? n : fallback;
}

function flagOf(subj: ParsedSubject, pred: IRI): boolean {
  const t = subj.properties.get(pred)?.[0];
  return t?.kind === 'literal' && t.value === 'true';
}

/**
 * Every rule the shapes graph declares, shape-bound and global alike.
 *
 * ★ A GLOBAL RULE IS DEFINED BY WHAT DOES NOT POINT AT IT. §"Shape Rules and Global Rules": a
 * rule is global when it is not the object of a `sh:rule` triple — so finding them means
 * enumerating rules and subtracting the linked ones, not looking for a marker. There is no
 * marker. A collector that only walks `sh:rule` finds none of them, and the RDFS rule set —
 * six global rules and not one shape — infers nothing while looking perfectly healthy.
 */
function collectRules(shapes: ParsedDocument, ruleSet?: IRI): Rule[] {
  const byKey = new Map<string, ParsedSubject>();
  for (const s of shapes.subjects) byKey.set(keyOf(s), s);

  // ★ ONE RULE CAN BE LINKED FROM SEVERAL SHAPES, and a Map from rule to ONE owner silently
  // dropped all but the last: `ex:AShape sh:rule ex:Tag . ex:BShape sh:rule ex:Tag .` ran the
  // rule over B's targets only, and swapping the two blocks in the file changed which
  // inference went missing. Reusing one rule across shapes is the point of giving it an IRI.
  const linked = new Map<string, string[]>();        // rule key -> owning shape keys
  for (const s of shapes.subjects) {
    for (const t of s.properties.get(SH_RULE) ?? []) {
      const k = refKey(t);
      if (k === undefined) continue;
      const owners = linked.get(k) ?? [];
      const sk = keyOf(s);
      // One shape naming the same rule twice is one link, not two.
      if (!owners.includes(sk)) owners.push(sk);
      linked.set(k, owners);
    }
  }

  /** The rules a named rule set contains, following `sh:includesRuleSet` transitively. */
  const membersOf = (setKey: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(setKey)) return out;
    seen.add(setKey);
    const node = byKey.get(setKey);
    for (const t of node?.properties.get(SH_HAS_RULE) ?? []) {
      const k = refKey(t);
      if (k !== undefined) out.add(k);
    }
    for (const t of node?.properties.get(SH_INCLUDES_RULE_SET) ?? []) {
      const k = refKey(t);
      if (k !== undefined) for (const m of membersOf(k, seen)) out.add(m);
    }
    return out;
  };
  const selected = ruleSet === undefined ? undefined : membersOf(ruleSet);

  const out: Rule[] = [];
  for (const s of shapes.subjects) {
    const key = keyOf(s);
    const types = (s.properties.get(RDF_TYPE) ?? [])
      .filter((t): t is { kind: 'iri'; iri: IRI } => t.kind === 'iri').map(t => t.iri);
    if (types.includes(SH_RULE_SET)) continue;
    const isRule = types.includes(SH_SPARQL_RULE) || types.includes(SH_TRIPLE_RULE)
      || types.includes(SH_RULE_CLASS) || linked.has(key);
    if (!isRule) continue;
    if (selected !== undefined && !selected.has(key)) continue;

    // ★ DEACTIVATION IS CHECKED FIRST, BEFORE THE TYPE. "Deactivated rules are ignored by
    // the rules engine" — so there is nothing the engine "is not able to execute", and
    // refusing the whole rule set over a rule the author explicitly switched OFF is a
    // fail-closed that closes on the wrong thing. A shapes graph carrying a disabled
    // sh:JSRule beside its SPARQL rules is ordinary, and it used to abort the run.
    const deactivated = flagOf(s, SH_DEACTIVATED);

    // ★ AN UNKNOWN RULE TYPE IS A FAILURE, NOT A SKIP. §"General Execution Instructions": "If
    // a rules engine is not able to execute a given rule because it does not support any of
    // the rule types of the rule, then it reports a failure." Skipping it returns an
    // under-inferred graph that looks exactly like a correctly inferred one.
    const kind = types.includes(SH_SPARQL_RULE) || s.properties.has(SH_CONSTRUCT) ? 'sparql'
      : types.includes(SH_TRIPLE_RULE) ? 'triple'
        : undefined;
    if (kind === undefined) {
      if (deactivated) continue;
      throw new ShaclRulesError(
        `the rule <${key}> has no rule type this engine supports (${types.join(', ') || 'untyped'}); `
        + 'SHACL requires a rules engine to report a FAILURE rather than skip it');
    }
    const base = {
      node: s,
      key,
      kind,
      layer: numberOf(s, SH_LAYER, 0),
      order: numberOf(s, SH_ORDER, 0),
      runOnce: flagOf(s, SH_RUN_ONCE),
      deactivated,
    } as const;
    // One Rule per owning shape. That is also what makes sh:runOnce right: the spec says a
    // run-once rule executes "at most once (PER SHAPE, if it is a shape rule)".
    const owners = linked.get(key);
    if (owners === undefined || owners.length === 0) out.push(base);       // a global rule
    else for (const shapeKey of owners) out.push({ ...base, shapeKey });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
//  Execution
// ═══════════════════════════════════════════════════════════════

/**
 * The document a CONDITION is checked against and a NODE EXPRESSION is evaluated over.
 *
 * ★ SHAPES AND DATA ARE TWO GRAPHS AND THE EVALUATORS TAKE ONE. `nodeConformsToShape` looks
 * the shape up in the same document it reads the node from, and a node expression's operator
 * blank node lives in the shapes graph while its `shnex:pathValues` reads the data graph. Where
 * both come from one source — twelve of the suite's eighteen rule entries, and every published
 * shape in this repo — that is simply true and nothing is needed.
 *
 * Where they do not, the shapes are laid over the data, and their blank nodes are RENAMED
 * first: two independent parses both start numbering at `_anon0`, so a data-graph list node
 * and a shapes-graph property shape can arrive with the same label. Merging those as one node
 * produces a shape carrying constraints nobody wrote.
 */
function renameBlankNodes(doc: ParsedDocument, prefix: string): ParsedDocument {
  const rename = (t: ParsedTerm): ParsedTerm => {
    if (t.kind === 'bnode') return { kind: 'bnode', id: prefix + t.id };
    if (t.kind === 'triple') {
      return {
        kind: 'triple',
        subject: rename(t.subject) as typeof t.subject,
        predicate: t.predicate,
        object: rename(t.object),
      };
    }
    return t;
  };
  return {
    prefixes: doc.prefixes,
    subjects: doc.subjects.map(s => ({
      subject: typeof s.subject === 'string' ? s.subject : { bnode: prefix + s.subject.bnode },
      properties: new Map([...s.properties].map(([p, objs]) => [p, objs.map(rename)])),
    })),
  };
}

function overlay(data: ParsedDocument, shapes: ParsedDocument): ParsedDocument {
  return { prefixes: shapes.prefixes, subjects: [...data.subjects, ...shapes.subjects] };
}

/**
 * Derive the triples a rule says it EXPECTS to be there — `sh:defaultValue` and `sh:values`,
 * materialised for one predicate.
 *
 * ★ THESE ARE NOT INFERENCES AND THEY DO NOT SURVIVE. SHACL Core already computes derived
 * values during validation, per property shape, on demand; a rule that reads `ex:area` cannot
 * see them because they were never in the graph. So they are materialised before the layer
 * that needs them, and removed once EVERY layer has run — the spec puts both deletions after
 * the layer loop, not inside it, so a later layer still sees what an earlier one derived.
 * They are removed unless a rule inferred the same triple independently, which is what stops
 * "the validator would have computed this" from becoming "the data says this".
 */
function derivedTriples(
  shapes: ParsedDocument, exprDoc: ParsedDocument, dataDoc: ParsedDocument, predicate: IRI,
): InferredTriple[] {
  const out: InferredTriple[] = [];
  // Same one-to-many correction as `linked` in collectRules: a property shape reached by
  // sh:property from two node shapes has TWO sets of target nodes, and keeping only the last
  // owner derived the values for one of them.
  const owners = new Map<string, string[]>();     // property shape key -> owning shape keys
  for (const s of shapes.subjects) {
    for (const t of s.properties.get(SH_PROPERTY) ?? []) {
      const k = refKey(t);
      if (k === undefined) continue;
      const list = owners.get(k) ?? [];
      const sk = keyOf(s);
      if (!list.includes(sk)) list.push(sk);
      owners.set(k, list);
    }
  }
  for (const ps of shapes.subjects) {
    const path = ps.properties.get(SH_PATH)?.[0];
    if (path?.kind !== 'iri' || path.iri !== predicate) continue;
    if (flagOf(ps, SH_DEACTIVATED)) continue;
    const valuesExpr = ps.properties.get(SH_VALUES)?.[0];
    const defaultValue = ps.properties.get(SH_DEFAULT_VALUE)?.[0];
    if (valuesExpr === undefined && defaultValue === undefined) continue;
    // ★ THE OWNERS' TARGETS AND ITS OWN, NOT ONE OR THE OTHER. `owners.get(k) ?? [k]`
    // consulted the property shape's own key only when NOBODY pointed at it — so a shape
    // carrying `sh:targetNode` AND reached by `sh:property` silently lost its own targets.
    // §2.1 gives targets to SHAPES; being referenced does not take them away.
    const own = keyOf(ps);
    const targetKeys = [...(owners.get(own) ?? []), own];
    const focusNodes: ParsedTerm[] = [];
    const seenFocus = new Set<string>();
    for (const targetKey of targetKeys) {
      for (const f of targetNodesOf(shapes, dataDoc, targetKey)) {
        const k = termKey(f);
        if (seenFocus.has(k)) continue;
        seenFocus.add(k);
        focusNodes.push(f);
      }
    }
    for (const focus of focusNodes) {
      const values = valuesExpr === undefined ? [] : nodeExpressionValues(exprDoc, valuesExpr, focus);
      // sh:defaultValue applies only where the property has no value at all.
      const asserted = dataDoc.subjects
        .find(s => keyOf(s) === refKey(focus))?.properties.get(predicate) ?? [];
      const chosen = values.length > 0 ? values
        : asserted.length > 0 ? []
          : defaultValue !== undefined ? [defaultValue] : [];
      for (const v of chosen) out.push({ subject: focus, predicate, object: v });
    }
  }
  return out;
}

/**
 * A condition, plus the class-shapes it inherits from.
 *
 * ★ A CLASS-SHAPE CONDITION CARRIES ITS SUPERCLASSES' CONSTRAINTS. §"Conditions on Shape
 * Rules": "If the value C of sh:condition is a SHACL instance of both sh:NodeShape and
 * rdfs:Class, then the focus nodes must also conform to the constraints of the
 * non-deactivated SHACL superclasses of C that are also SHACL instances of both sh:NodeShape
 * and rdfs:Class." It is the same reading implicit class targets get, and for the same
 * reason: naming a class as a shape means the whole class hierarchy, not one level of it.
 *
 * Checking only the named shape lets a rule fire on a node that satisfies the subclass's own
 * (possibly empty) constraints while violating everything the superclass requires — the
 * fail-OPEN direction, since a rule that should not have run has already asserted its
 * triples.
 */
function withClassAncestors(shapes: ParsedDocument, condition: ParsedTerm): ParsedTerm[] {
  const byKey = new Map(shapes.subjects.map(s => [keyOf(s), s] as const));
  const isClassShape = (subj: ParsedSubject | undefined): boolean => {
    const types = (subj?.properties.get(RDF_TYPE) ?? [])
      .filter((t): t is { kind: 'iri'; iri: IRI } => t.kind === 'iri').map(t => t.iri);
    // sh:ShapeClass IS "both a node shape and a class" in one type; the pair spells the same.
    return types.includes(SH_SHAPE_CLASS)
      || (types.includes(SH_NODE_SHAPE) && types.includes(RDFS_CLASS));
  };
  // No sentinel key: a literal '\u0000' written through a generator has already become a
  // raw NUL byte in this file once, which makes the whole source BINARY to git.
  const startKey = refKey(condition);
  const start = startKey === undefined ? undefined : byKey.get(startKey);
  if (!isClassShape(start)) return [condition];

  const out = [condition];
  const seen = new Set([refKey(condition)]);
  const queue = [start!];
  while (queue.length > 0) {
    const here = queue.shift()!;
    for (const sup of here.properties.get(RDFS_SUBCLASS_OF) ?? []) {
      const k = refKey(sup);
      if (k === undefined || seen.has(k)) continue;
      seen.add(k);
      const node = byKey.get(k);
      if (node === undefined) continue;
      // ★ WALK THROUGH IT, EVEN WHEN IT IS NOT ONE. "SHACL superclass" is the TRANSITIVE
      // closure of rdfs:subClassOf; whether a given link is itself a class-shape decides
      // only whether its constraints APPLY, not whether the walk continues past it. Skipping
      // the enqueue too meant one plain rdfs:Class in the middle of a hierarchy hid every
      // shape above it — a condition that should have refused a node quietly admitted it,
      // and the rule fired.
      queue.push(node);
      if (!isClassShape(node)) continue;
      if (flagOf(node, SH_DEACTIVATED)) continue;    // "non-deactivated" superclasses only
      out.push(sup);
    }
  }
  return out;
}

/**
 * Run one rule over all of its focus nodes, adding what it infers. Returns how many are new.
 */
function runRule(
  rule: Rule,
  shapes: ParsedDocument,
  graph: RuleGraph,
  exprDoc: () => ParsedDocument,
  inferred: InferredTriple[],
  /** Triples present only because sh:expectedPredicate materialised them for this layer. */
  derivedKeys: ReadonlySet<string>,
): number {
  let added = 0;
  const record = (t: InferredTriple): void => {
    const k = tripleKey(t);
    if (graph.add(t)) { inferred.push(t); added++; return; }
    // ★ "EXCEPT THOSE THAT WERE ALSO INFERRED BY RULES" — the spec's exception for derived
    // triples, which could never fire while a rule's output was recorded only when it was
    // NEW to the graph. An expected-derived triple is already present by the time the rule
    // runs, so `graph.add` returns false, nothing is recorded, and the cleanup then deletes
    // a triple a rule genuinely inferred. It does not count towards `added` — it changed
    // nothing, so it must not restart the fixpoint — but it IS an inference.
    if (derivedKeys.has(k) && !inferred.some(x => tripleKey(x) === k)) inferred.push(t);
  };

  // ★ RE-ASKED EVERY TIME, because a rule can create its own future focus nodes: the run-once
  // rule that types four people `ex:Person` is what gives the iterating rule beside it anything
  // to work on. Computing the targets once, before the layer, finds none of them.
  const conditions = (rule.node.properties.get(SH_CONDITION) ?? [])
    .flatMap(c => withClassAncestors(shapes, c));
  const focusNodes: readonly (ParsedTerm | undefined)[] = rule.shapeKey === undefined
    ? [undefined]                                  // a global rule runs once, unbound
    : targetNodesOf(shapes, graph.doc(), rule.shapeKey)
      .filter(node => conditions.every(c => nodeConformsToShape(exprDoc(), node, c)));

  for (const focus of focusNodes) {
    if (rule.kind === 'sparql') {
      const q = rule.node.properties.get(SH_CONSTRUCT)?.[0];
      if (q?.kind !== 'literal') {
        throw new ShaclRulesError(`sh:SPARQLRule <${rule.key}> has no sh:construct string`);
      }
      const preBound = new Map<string, ParsedTerm>();
      if (focus !== undefined) preBound.set('this', focus);
      let result;
      try {
        // ★ THE FUNCTIONS ARE COMPILED AGAINST THE SAME DOCUMENT THE QUERY READS. A
        // `sh:function` body is itself a query, and it has to see the DATA — compiling the
        // library from the shapes graph alone gives every function body a graph containing
        // only shapes to query, so one that counts labels answers 0 for every subject and
        // says nothing about why.
        result = runSparql(graph.doc(), q.value, sparqlPrefixesFor(shapes, rule.node),
          preBound, shapeFunctions(exprDoc()));
      } catch (err) {
        // ★ A REFUSED QUERY IS A FAILURE OF THE RULE SET, NOT AN EMPTY RESULT. The point of
        // the refusal is that the engine does not know what the query means; treating it as
        // "inferred nothing" hands back a graph missing triples nobody can name.
        if (!(err instanceof SparqlRefusedError)) throw err;
        throw new ShaclRulesError(
          `sh:SPARQLRule <${rule.key}> could not be executed: ${err.message}`);
      }
      for (const t of result.triples ?? []) record(t);
      continue;
    }

    // A TRIPLE RULE: three node expressions, with the focus node wherever one is absent.
    const expr = (pred: IRI): readonly ParsedTerm[] => {
      const e = rule.node.properties.get(pred)?.[0];
      if (e === undefined) return focus === undefined ? [] : [focus];
      return nodeExpressionValues(exprDoc(), e, focus);
    };
    for (const s of expr(SH_SUBJECT)) {
      for (const p of expr(SH_PREDICATE)) {
        // Ill-formed triples are skipped rather than fabricated: a literal or a blank node in
        // the predicate position is not a triple, and no serialisation can round-trip one.
        if (p.kind !== 'iri') continue;
        for (const o of expr(SH_OBJECT)) record({ subject: s, predicate: p.iri, object: o });
      }
    }
  }
  return added;
}

/**
 * Run a shapes graph's rules over a data graph and return what they infer.
 *
 * The data graph is not modified — the inferences come back as data, and the caller decides
 * whether to assert them.
 */
export function inferShaclTriples(
  dataSrc: string | ParsedDocument,
  shapesSrc: string | ParsedDocument,
  options: InferenceOptions = {},
): InferenceResult {
  const maxIterations = options.maxIterations ?? 100;
  const maxTriples = options.maxTriples ?? 100_000;
  const sameSource = dataSrc === shapesSrc;
  const parsedShapes = typeof shapesSrc === 'string' ? parseTrig(shapesSrc) : shapesSrc;
  const shapes = sameSource ? parsedShapes : renameBlankNodes(parsedShapes, 'shapes.');
  const graph = new RuleGraph(typeof dataSrc === 'string' ? parseTrig(dataSrc) : dataSrc);

  // ★ MEMOISED ON THE GRAPH'S CURRENT VIEW, and that is not a micro-optimisation. Downstream
  // caches key on the DOCUMENT OBJECT — `userFunctionsFor` and the compiled-shape cache are
  // both WeakMaps — so handing out a fresh overlay on every call would recompile the shapes
  // graph's functions once per rule per focus node per iteration. Rebuilding it exactly when
  // the graph changes keeps the identity stable for as long as the data is.
  let overlaidFrom: ParsedDocument | undefined;
  let overlaid: ParsedDocument | undefined;
  const exprDoc = (): ParsedDocument => {
    const base = graph.doc();
    if (sameSource) return base;
    if (base !== overlaidFrom) { overlaidFrom = base; overlaid = overlay(base, shapes); }
    return overlaid!;
  };

  const rules = collectRules(shapes, options.ruleSet).filter(r => !r.deactivated);
  const layers = [...new Set(rules.map(r => r.layer))].sort((a, b) => a - b);
  const byOrder = (a: Rule, b: Rule): number => a.order - b.order;

  const inferred: InferredTriple[] = [];
  const derived: InferredTriple[] = [];
  const derivedKeys = new Set<string>();
  let iterations = 0;

  for (const layer of layers) {
    const here = rules.filter(r => r.layer === layer);
    // The expected derived triples come first: a rule that reads ex:area must be able to see
    // an ex:area that only a property shape knows how to compute.
    for (const rule of here) {
      for (const p of rule.node.properties.get(SH_EXPECTED_PREDICATE) ?? []) {
        if (p.kind !== 'iri') continue;
        for (const t of derivedTriples(shapes, exprDoc(), graph.doc(), p.iri)) {
          if (graph.add(t)) { derived.push(t); derivedKeys.add(tripleKey(t)); }
        }
      }
    }
    for (const rule of here.filter(r => r.runOnce).sort(byOrder)) {
      runRule(rule, shapes, graph, exprDoc, inferred, derivedKeys);
    }
    const iterating = here.filter(r => !r.runOnce).sort(byOrder);
    let grew = iterating.length > 0;
    while (grew) {
      if (++iterations > maxIterations) {
        throw new ShaclRulesError(
          `the rule set did not reach a fixpoint within ${maxIterations} iterations; `
          + 'returning a partial inference would be indistinguishable from a complete one');
      }
      grew = false;
      for (const rule of iterating) {
        grew = runRule(rule, shapes, graph, exprDoc, inferred, derivedKeys) > 0 || grew;
      }
      if (graph.size > maxTriples) {
        throw new ShaclRulesError(`the rule set produced more than ${maxTriples} triples`);
      }
    }
  }

  // ── the two clean-ups, in the spec's order ──
  const alsoInferred = new Set(inferred.map(tripleKey));
  for (const d of derived) if (!alsoInferred.has(tripleKey(d))) removeWithReifiers(graph, d);

  // ★ A TEMPORARY TRIPLE IS NAMED BY ITS REIFIER, NOT BY ITSELF. `?r sh:tempTriple true` plus
  // `?r rdf:reifies <<( s p o )>>` marks (s p o) as scaffolding — the offspring closure that
  // existed only so a later layer could pick the youngest one out of it. Deleting the marker
  // and leaving the triple behind publishes the scaffolding as a result.
  for (const marker of [...graph.doc().subjects]) {
    if (!flagOf(marker, SH_TEMP_TRIPLE)) continue;
    for (const t of marker.properties.get(RDF_REIFIES) ?? []) {
      if (t.kind !== 'triple') continue;
      graph.remove({ subject: t.subject, predicate: t.predicate, object: t.object });
    }
    for (const t of graph.outgoing(subjectTerm(marker))) graph.remove(t);
  }

  return { triples: inferred.filter(t => graph.has(t)), iterations };
}

/** Remove a triple and any reifier that points at it. */
function removeWithReifiers(graph: RuleGraph, t: InferredTriple): void {
  graph.remove(t);
  if (t.subject.kind !== 'iri' && t.subject.kind !== 'bnode') return;
  const asTerm: ParsedTerm = {
    kind: 'triple', subject: t.subject, predicate: t.predicate, object: t.object,
  };
  for (const reifier of graph.subjectsWith(RDF_REIFIES, asTerm)) {
    for (const owned of graph.outgoing(reifier)) graph.remove(owned);
  }
}
