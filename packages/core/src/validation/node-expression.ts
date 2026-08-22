/**
 * SHACL 1.2 node expressions — the small functional language `sh:nodeByExpression` and
 * `sh:values` evaluate.
 *
 * ── WHAT IT IS ───────────────────────────────────────────────────────────────
 *
 * An expression maps a focus node to an ordered SEQUENCE of RDF terms. Everything else is
 * built from that: `shnex:pathValues` walks a property path, `shnex:count` collapses a
 * sequence to one integer, `shnex:orderBy` reorders it, `shnex:if` chooses between two of
 * them. A constant is a sequence of one, and an rdf:List is a sequence of its members.
 *
 * ── WHY A SEQUENCE AND NOT A SET ─────────────────────────────────────────────
 *
 * ★ The rest of this engine speaks in SETS — §2.3's value nodes are a set, and evaluatePath
 * deduplicates. Node expressions do not, and treating them the same way would quietly break
 * half the language: `shnex:limit`, `shnex:offset`, `shnex:orderBy` and `shnex:findFirst`
 * are all statements about POSITION, and a set has none. `shnex:distinct` exists precisely
 * because duplicates are otherwise kept. So this module deduplicates nowhere, and the
 * conformance harness compares ordered lists rather than sets — a set comparison would pass
 * an implementation that ignored ordering and limiting entirely.
 *
 * ── TWO OPERATOR NAMESPACES ──────────────────────────────────────────────────
 *
 * `shnex:` holds the structural operators evaluated here — pathValues, orderBy, if, count.
 * `sparql:` holds the FUNCTION library, which lives in ./sparql-functions.ts and is
 * dispatched from this file. Both are node expressions and a node carries one or the other.
 *
 * ★ AN EARLIER VERSION OF THIS COMMENT PUT THE sparql: HALF "OUT OF SCOPE, NOT VENDORED".
 * It was, briefly. The distinction that actually matters is not SPARQL versus not-SPARQL but
 * FUNCTION versus QUERY: the 76 sparql: entries are pure functions over terms and need no
 * engine at all, while sh:select / sh:ask / sh:construct need a query evaluator and are a
 * genuinely separate problem. Scoping by the wrong axis is what made a tractable function
 * library look like a compiler project.
 */
import type { ParsedDocument, ParsedSubject, ParsedTerm } from '../rdf/turtle-parser.js';
import { SPARQL_FN, applySparqlFunction, implementsSparqlFunction } from './sparql-functions.js';
import type { IRI } from '../model/types.js';

const SHNEX = 'http://www.w3.org/ns/shacl-node-expr#';
const SH_SELECT = 'http://www.w3.org/ns/shacl#select' as IRI;
const SH_ASK = 'http://www.w3.org/ns/shacl#ask' as IRI;
const SH_SPARQL_EXPR = 'http://www.w3.org/ns/shacl#sparqlExpr' as IRI;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_FIRST = `${RDF}first` as IRI;
const RDF_REST = `${RDF}rest` as IRI;
const RDF_NIL = `${RDF}nil`;
const RDF_TYPE = `${RDF}type` as IRI;
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf' as IRI;

/** The evaluation context: the focus node, and any named bindings in scope. */
export interface NodeExpressionContext {
  readonly focusNode?: ParsedTerm;
  /** `shnex:var "name"` resolves here. "focusNode" is built in and needs no binding. */
  readonly bindings?: ReadonlyMap<string, readonly ParsedTerm[]>;
  /**
   * Conformance check for `shnex:filterShape` / `shnex:conformsToShape`. Injected rather
   * than imported so this module does not depend on the validator that depends on it —
   * see the note on evaluateNodeExpression.
   */
  readonly conforms?: (node: ParsedTerm, shape: ParsedTerm) => boolean;
  /**
   * Run a `sh:select` / `sh:ask` node expression. Injected for the same reason `conforms`
   * is: the query evaluator needs the shapes graph's prefix declarations, which only the
   * validator has assembled.
   */
  readonly runQuery?: (exprNode: ParsedTerm, focus: ParsedTerm | undefined) => readonly ParsedTerm[];
  /** Recursion guard; callers do not set this. */
  readonly depth?: number;
}

const MAX_DEPTH = 32;

function termKey(t: ParsedTerm): string {
  switch (t.kind) {
    case 'iri': return `I${t.iri}`;
    case 'bnode': return `B${t.id}`;
    case 'literal': return `L${JSON.stringify([t.value, t.datatype ?? '', t.language ?? ''])}`;
    case 'triple': return `T${JSON.stringify([termKey(t.subject), t.predicate, termKey(t.object)])}`;
  }
}

function subjectKeyOf(t: ParsedTerm): string | undefined {
  return t.kind === 'iri' ? t.iri : t.kind === 'bnode' ? `_:${t.id}` : undefined;
}

const INDEX = new WeakMap<ParsedDocument, Map<string, ParsedSubject>>();
function subjectFor(doc: ParsedDocument, t: ParsedTerm): ParsedSubject | undefined {
  const k = subjectKeyOf(t);
  if (k === undefined) return undefined;
  let idx = INDEX.get(doc);
  if (!idx) {
    idx = new Map();
    for (const s of doc.subjects) {
      idx.set(typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`, s);
    }
    INDEX.set(doc, idx);
  }
  return idx.get(k);
}

/** rdf:List members, or undefined when the term does not head a list. */
function listMembers(doc: ParsedDocument, t: ParsedTerm): ParsedTerm[] | undefined {
  if (t.kind === 'iri' && t.iri === RDF_NIL) return [];
  const head = subjectFor(doc, t);
  if (!head?.properties.has(RDF_FIRST)) return undefined;
  const out: ParsedTerm[] = [];
  let cursor: ParsedTerm = t;
  const seen = new Set<string>();
  for (let i = 0; i < 4096; i++) {
    if (cursor.kind === 'iri' && cursor.iri === RDF_NIL) return out;
    const k = subjectKeyOf(cursor);
    if (k === undefined || seen.has(k)) return out;
    seen.add(k);
    const cell = subjectFor(doc, cursor);
    const first = cell?.properties.get(RDF_FIRST)?.[0];
    const rest = cell?.properties.get(RDF_REST)?.[0];
    if (!first) return out;
    out.push(first);
    if (!rest) return out;
    cursor = rest;
  }
  return out;
}

const num = (t: ParsedTerm): number | undefined => {
  if (t.kind !== 'literal') return undefined;
  const n = Number(t.value);
  return Number.isFinite(n) ? n : undefined;
};

const intLiteral = (n: number): ParsedTerm =>
  ({ kind: 'literal', value: String(n), datatype: `${XSD}integer` as IRI });

const boolLiteral = (b: boolean): ParsedTerm =>
  ({ kind: 'literal', value: b ? 'true' : 'false', datatype: `${XSD}boolean` as IRI });

const isTrue = (t: ParsedTerm | undefined): boolean =>
  t?.kind === 'literal' && t.value === 'true';

/**
 * Compare two terms for ordering. Numerics numerically, everything else by its lexical
 * form — the same shape of rule the range constraints use, and for the same reason: an
 * order that silently falls back to string comparison puts 10 before 9.
 */
function compareTerms(a: ParsedTerm, b: ParsedTerm): number {
  const x = num(a);
  const y = num(b);
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0;
  const sa = a.kind === 'iri' ? a.iri : a.kind === 'literal' ? a.value : termKey(a);
  const sb = b.kind === 'iri' ? b.iri : b.kind === 'literal' ? b.value : termKey(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Values of a SHACL property path from one node.
 *
 * Deliberately re-implemented here in the small rather than reaching into the validator:
 * node expressions need a path walker over ONE node, and importing the engine's would make
 * this module depend on the module that will depend on it.
 */
function pathValues(doc: ParsedDocument, from: ParsedTerm, path: ParsedTerm, depth = 0): ParsedTerm[] {
  if (depth > MAX_DEPTH) return [];
  if (path.kind === 'iri') {
    return [...(subjectFor(doc, from)?.properties.get(path.iri) ?? [])];
  }
  const node = subjectFor(doc, path);
  if (!node) return [];
  const p = (local: string): ParsedTerm | undefined =>
    node.properties.get(`http://www.w3.org/ns/shacl#${local}` as IRI)?.[0];

  const inverse = p('inversePath');
  if (inverse) {
    const out: ParsedTerm[] = [];
    for (const s of doc.subjects) {
      const term: ParsedTerm = typeof s.subject === 'string'
        ? { kind: 'iri', iri: s.subject as IRI }
        : { kind: 'bnode', id: s.subject.bnode };
      for (const v of pathValues(doc, term, inverse, depth + 1)) {
        if (termKey(v) === termKey(from)) out.push(term);
      }
    }
    return out;
  }
  const alt = p('alternativePath');
  if (alt) {
    const out: ParsedTerm[] = [];
    for (const opt of listMembers(doc, alt) ?? []) out.push(...pathValues(doc, from, opt, depth + 1));
    return out;
  }
  for (const [local, min, max] of [
    ['zeroOrMorePath', 0, Infinity], ['oneOrMorePath', 1, Infinity], ['zeroOrOnePath', 0, 1],
  ] as const) {
    const step = p(local);
    if (!step) continue;
    const out: ParsedTerm[] = [];
    const seen = new Set<string>();
    let frontier = [from];
    for (let n = 0; n <= Math.min(max === Infinity ? MAX_DEPTH : max, MAX_DEPTH); n++) {
      if (n >= min) {
        for (const t of frontier) {
          if (!seen.has(termKey(t))) { seen.add(termKey(t)); out.push(t); }
        }
      }
      if (n >= (max === Infinity ? MAX_DEPTH : max)) break;
      const next: ParsedTerm[] = [];
      for (const t of frontier) next.push(...pathValues(doc, t, step, depth + 1));
      if (next.length === 0) break;
      frontier = next;
    }
    return out;
  }
  // A bare rdf:List in a path position is a SEQUENCE path.
  const seq = listMembers(doc, path);
  if (seq && seq.length > 0) {
    let current = [from];
    for (const step of seq) {
      const next: ParsedTerm[] = [];
      for (const t of current) next.push(...pathValues(doc, t, step, depth + 1));
      current = next;
    }
    return current;
  }
  return [];
}

/** Every node that is a SHACL instance of `cls` — rdf:type plus rdfs:subClassOf*. */
function instancesOf(doc: ParsedDocument, cls: ParsedTerm): ParsedTerm[] {
  if (cls.kind !== 'iri') return [];
  const accepted = new Set<string>([cls.iri]);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of doc.subjects) {
      if (typeof s.subject !== 'string') continue;
      for (const sup of s.properties.get(RDFS_SUBCLASS_OF) ?? []) {
        if (sup.kind === 'iri' && accepted.has(sup.iri) && !accepted.has(s.subject)) {
          accepted.add(s.subject);
          changed = true;
        }
      }
    }
  }
  const out: ParsedTerm[] = [];
  for (const s of doc.subjects) {
    for (const t of s.properties.get(RDF_TYPE) ?? []) {
      if (t.kind === 'iri' && accepted.has(t.iri)) {
        out.push(typeof s.subject === 'string'
          ? { kind: 'iri', iri: s.subject as IRI }
          : { kind: 'bnode', id: s.subject.bnode });
        break;
      }
    }
  }
  return out;
}

/**
 * Evaluate a node expression to an ordered sequence of terms.
 *
 * ★ `conforms` IS INJECTED, NOT IMPORTED. `shnex:filterShape` and `shnex:conformsToShape`
 * ask whether a node satisfies a shape, and the shape validator is exactly the thing that
 * will call this module for `sh:nodeByExpression`. Importing it here would be a cycle; the
 * caller passes it down. When it is absent those two operators evaluate to the empty
 * sequence, which is honest — no filter was applied because none could be.
 */
export function evaluateNodeExpression(
  doc: ParsedDocument,
  expr: ParsedTerm | undefined,
  ctx: NodeExpressionContext = {},
): ParsedTerm[] {
  if (expr === undefined) return [];
  const depth = ctx.depth ?? 0;
  if (depth > MAX_DEPTH) return [];

  const node = subjectFor(doc, expr);
  const op = (local: string): ParsedTerm | undefined =>
    node?.properties.get(`${SHNEX}${local}` as IRI)?.[0];
  const has = (local: string): boolean => node?.properties.has(`${SHNEX}${local}` as IRI) ?? false;

  const sub = (e: ParsedTerm | undefined, over?: NodeExpressionContext): ParsedTerm[] =>
    evaluateNodeExpression(doc, e, { ...ctx, ...over, depth: depth + 1 });

  // ── a node carrying no shnex: operator, which is three different things ──
  //
  // ★ THE THREE ARE EASY TO COLLAPSE AND THE SUITE SEPARATES THEM DELIBERATELY:
  //
  //   []          a blank node with NO triples   -> the EMPTY sequence
  //   ()          rdf:nil                        -> a sequence of ONE, the term rdf:nil
  //   ( 1 2 3 )   a list                         -> the sequence of its MEMBERS
  //
  // The middle one is the trap. rdf:nil is a perfectly good IRI and `shnex:count ()` counts
  // one thing, not zero — while `shnex:count []` counts zero. Treating "the empty list" and
  // "the empty expression" as the same thing gets one of them wrong whichever way you
  // choose, and the suite has an entry for each.
  // ★ TWO OPERATOR NAMESPACES, NOT ONE. shnex: holds the structural operators (pathValues,
  // orderBy, if); sparql: holds the FUNCTION library (strlen, coalesce, plus). A node
  // carrying `sparql:strlen ( "hello" )` is an operator just as surely as one carrying
  // `shnex:count`, and testing only for shnex: made all 76 of the suite's SPARQL-function
  // entries fall through to the constant branch — where a blank node with properties
  // evaluates to ITSELF, so every one of them returned the expression node.
  // ★ THREE operator namespaces. shnex: is the structural set, sparql: the function set —
  // and a node carrying sh:select / sh:ask is a QUERY expression, which has neither. Left
  // out of this test it fell through to the constant branch, where a blank node with
  // properties evaluates to ITSELF: `sh:values [ sh:select … ]` produced the expression node
  // as the value, so every constraint written about the derived value compared against a
  // blank node and failed.
  const isOperator = node !== undefined
    && [...node.properties.keys()].some(k =>
      k.startsWith(SHNEX) || k.startsWith(SPARQL_FN)
      || k === SH_SELECT || k === SH_ASK || k === SH_SPARQL_EXPR);
  if (!isOperator) {
    if (expr.kind === 'bnode' && (node === undefined || node.properties.size === 0)) return [];
    const members = expr.kind === 'bnode' ? listMembers(doc, expr) : undefined;
    return members ?? [expr];
  }

  // ── the focus node this expression sees ──
  // shnex:focusNode overrides it for this expression AND everything under it.
  const focusOverride = op('focusNode');
  const focusNode = focusOverride !== undefined
    ? sub(focusOverride)[0] ?? ctx.focusNode
    : ctx.focusNode;
  const here: NodeExpressionContext = { ...ctx, focusNode, depth: depth + 1 };
  const subHere = (e: ParsedTerm | undefined): ParsedTerm[] =>
    evaluateNodeExpression(doc, e, here);

  // ── a SPARQL query as a node expression ──
  //
  // ★ `sh:values [ sh:select "…" ]` COMPUTES THE VALUE NODES of a property shape, and until
  // it did, the path simply yielded nothing — so a shape whose values are derived rather
  // than stored failed every constraint written about them. That is a FALSE REFUSAL of a
  // valid graph, which is the direction that costs a publisher rather than a reader.
  // ★ sh:sparqlExpr IS THE THIRD FORM, and it is a BARE EXPRESSION rather than a query:
  // `sh:values [ sh:sparqlExpr "STRLEN(STR($this))" ]` derives a value from the focus node
  // with no WHERE clause to hang it on. Missing from this test it fell through to the
  // constant branch and the property's value node became the expression's own blank node —
  // so `sh:datatype xsd:integer` and `sh:hasValue 27` were both judged against `_:b0`, and
  // BOTH focus nodes were reported, including the one the entry says conforms.
  if (node?.properties.has(SH_SELECT) || node?.properties.has(SH_ASK)
    || node?.properties.has(SH_SPARQL_EXPR)) {
    return ctx.runQuery ? [...ctx.runQuery(expr, focusNode)] : [];
  }

  // ── the sparql: function library ──
  //
  // The predicate names the function and its object is an rdf:List of ARGUMENTS, each of
  // which is itself a node expression. Evaluated before the shnex: operators because a node
  // carries one or the other, never both.
  for (const [pred, terms] of node?.properties ?? []) {
    if (!pred.startsWith(SPARQL_FN)) continue;
    const local = pred.slice(SPARQL_FN.length);
    if (!implementsSparqlFunction(local)) {
      // ★ REPORTED, NOT SILENTLY EMPTY. An unimplemented function returning nothing is
      // indistinguishable from one that legitimately produced nothing, and a SHACL
      // constraint built on it would then pass for the wrong reason.
      throw new Error(
        `SPARQL function sparql:${local} is not implemented by this engine, so the node `
        + 'expression cannot be evaluated');
    }
    const argTerm = terms[0];
    // `sparql:bnode ()` — rdf:nil — is a call with NO arguments, not a call with one
    // argument that happens to be the empty list.
    const argExprs = argTerm === undefined ? []
      : (argTerm.kind === 'iri' && argTerm.iri === RDF_NIL) ? []
        : listMembers(doc, argTerm) ?? [argTerm];

    // ★ `if` EVALUATES LAZILY. SPARQL's IF does not evaluate the branch it does not take —
    // `IF(false, 1/0, 2)` is 2, not an error — and eagerly evaluating both would turn a
    // guarded expression into the error it was written to guard against.
    if (local === 'if') {
      const cond = sub(argExprs[0]);
      const taken = cond[0]?.kind === 'literal' && cond[0].value === 'true'
        ? argExprs[1] : argExprs[2];
      return sub(taken);
    }
    return [...applySparqlFunction(local, argExprs.map(e => sub(e)))];
  }

  // ── leaf producers ──
  if (has('var')) {
    const nameTerm = op('var');
    const name = nameTerm?.kind === 'literal' ? nameTerm.value : undefined;
    if (name === undefined) return [];
    if (name === 'focusNode') return focusNode ? [focusNode] : [];
    return [...(ctx.bindings?.get(name) ?? [])];
  }
  if (has('arg')) {
    // ★ POSITIONAL, and the index is the VALUE not the predicate. `shnex:arg 0` inside a
    // `sh:bodyExpression` is "the first argument this function was called with" — the
    // parameter it corresponds to is declared separately as `sh:path shnex:arg0`. Reading
    // the predicate instead of the value would make every argument reference index zero.
    const idx = op('arg');
    const n = idx?.kind === 'literal' ? Number(idx.value) : NaN;
    if (!Number.isInteger(n)) return [];
    return [...(ctx.bindings?.get(`arg${n}`) ?? [])];
  }
  if (has('constant')) {
    const c = op('constant');
    return c === undefined ? [] : [c];
  }
  if (has('empty')) return [];
  if (has('instancesOf')) {
    const out: ParsedTerm[] = [];
    for (const cls of subHere(op('instancesOf'))) out.push(...instancesOf(doc, cls));
    return out;
  }
  if (has('if')) {
    const cond = subHere(op('if'));
    return isTrue(cond[0]) ? subHere(op('then')) : subHere(op('else'));
  }

  // ── the input sequence every pipeline operator works on ──
  //
  // ★ `shnex:nodes` names it explicitly; without it the input is the FOCUS NODE. Defaulting
  // to the empty sequence instead would make `[ shnex:pathValues rdfs:label ]` — the most
  // common expression there is — evaluate to nothing.
  const input: ParsedTerm[] = has('nodes')
    ? subHere(op('nodes'))
    : focusNode ? [focusNode] : [];

  if (has('pathValues')) {
    const path = op('pathValues');
    if (path === undefined) return [];
    const out: ParsedTerm[] = [];
    for (const n of input) out.push(...pathValues(doc, n, path));
    return out;
  }
  if (has('flatMap')) {
    const body = op('flatMap');
    const out: ParsedTerm[] = [];
    for (const n of input) {
      out.push(...evaluateNodeExpression(doc, body, { ...ctx, focusNode: n, depth: depth + 1 }));
    }
    return out;
  }
  // ── the shape-valued operators ──
  //
  // ★ THEIR ARGUMENT IS A SHAPE, NOT AN EXPRESSION, and the difference is invisible in the
  // Turtle: `[ sh:minInclusive 3 ]` is a blank node either way. Evaluated as an expression it
  // carries no shnex: operator, so it comes back as itself — and `shnex:findFirst` returned
  // the shape node rather than the first conforming input. Every one of these takes the
  // argument unevaluated and hands it to the conformance check.
  if (has('filterShape')) {
    const shape = op('filterShape');
    if (!ctx.conforms || shape === undefined) return [];
    return input.filter(n => ctx.conforms!(n, shape));
  }
  if (has('findFirst')) {
    const shape = op('findFirst');
    if (!ctx.conforms || shape === undefined) return [];
    const hit = input.find(n => ctx.conforms!(n, shape));
    return hit === undefined ? [] : [hit];
  }
  if (has('nodesMatching')) {
    // ★ NOT a filter of the input — a QUERY over the whole data graph. "The nodes matching
    // this shape" is a different question from "which of these nodes match", and the suite's
    // entry has no input at all: filtering would have returned the focus node or nothing.
    const shape = op('nodesMatching');
    if (!ctx.conforms || shape === undefined) return [];
    const out: ParsedTerm[] = [];
    for (const sj of doc.subjects) {
      const term: ParsedTerm = typeof sj.subject === 'string'
        ? { kind: 'iri', iri: sj.subject as IRI }
        : { kind: 'bnode', id: sj.subject.bnode };
      if (ctx.conforms(term, shape)) out.push(term);
    }
    return out;
  }
  if (has('conformsToShape')) {
    // The argument is a two-member list: ( node shape ), and BOTH members are expressions.
    //
    // ★ AN EMPTY NODE ARGUMENT YIELDS NOTHING, NOT `false`. `( [ shnex:var "unbound" ] ex:S )`
    // asks whether an unbound variable conforms, and there is no node to answer about — so
    // the expression has no value. Returning false would be a claim: "this node does not
    // conform", about a node that does not exist.
    const arg = op('conformsToShape');
    const pair = arg === undefined ? undefined : listMembers(doc, arg);
    if (!ctx.conforms || !pair || pair.length < 2) return [];
    const nodes = subHere(pair[0]!);
    const shapes = subHere(pair[1]!);
    if (nodes.length === 0 || shapes.length === 0) return [];
    return [boolLiteral(ctx.conforms(nodes[0]!, shapes[0]!))];
  }
  if (has('matchAll')) {
    const shape = op('matchAll');
    if (shape === undefined || !ctx.conforms) return [];
    // Vacuously true over an empty input, which is what the suite's `shnex:nodes []` entry
    // asserts — "all of nothing conforms" is the only answer consistent with `every`.
    return [boolLiteral(input.every(n => ctx.conforms!(n, shape)))];
  }
  if (has('exists')) {
    return [boolLiteral(subHere(op('exists')).length > 0)];
  }
  if (has('count')) {
    return [intLiteral(subHere(op('count')).length)];
  }
  if (has('sum')) {
    const values = subHere(op('sum')).map(num).filter((n): n is number => n !== undefined);
    return [intLiteral(values.reduce((a, b) => a + b, 0))];
  }
  if (has('min')) {
    const values = subHere(op('min'));
    if (values.length === 0) return [];
    return [values.reduce((a, b) => (compareTerms(b, a) < 0 ? b : a))];
  }
  if (has('max')) {
    const values = subHere(op('max'));
    if (values.length === 0) return [];
    return [values.reduce((a, b) => (compareTerms(b, a) > 0 ? b : a))];
  }
  if (has('concat')) {
    // The argument is a list of expressions; each contributes its whole sequence, in order.
    const parts = listMembers(doc, op('concat')!) ?? [op('concat')!];
    const out: ParsedTerm[] = [];
    for (const part of parts) out.push(...subHere(part));
    return out;
  }
  if (has('distinct')) {
    const seen = new Set<string>();
    const out: ParsedTerm[] = [];
    for (const t of subHere(op('distinct'))) {
      const k = termKey(t);
      if (!seen.has(k)) { seen.add(k); out.push(t); }
    }
    return out;
  }
  if (has('intersection')) {
    // Duplicates are removed — the suite's own comment says so ("Note that this also tests
    // that duplicates are removed"), and it is the only reading under which an intersection
    // of ( 4 3 2 2 1 ), ( 3 2 2 ) and ( 2 2 1 ) is one node rather than two.
    const parts = (listMembers(doc, op('intersection')!) ?? []).map(e => subHere(e));
    if (parts.length === 0) return [];
    const keysets = parts.slice(1).map(part => new Set(part.map(termKey)));
    const seen = new Set<string>();
    const out: ParsedTerm[] = [];
    for (const t of parts[0]!) {
      const k = termKey(t);
      if (seen.has(k) || !keysets.every(set => set.has(k))) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }
  if (has('remove')) {
    // Everything in the input that is NOT in the removal sequence.
    const drop = new Set(subHere(op('remove')).map(termKey));
    return input.filter(t => !drop.has(termKey(t)));
  }
  if (has('list')) {
    return subHere(op('list'));
  }
  if (has('orderBy')) {
    const by = op('orderBy');
    const desc = isTrue(op('desc'));
    const keyed = input.map(t => ({
      t,
      k: evaluateNodeExpression(doc, by, { ...ctx, focusNode: t, depth: depth + 1 })[0],
    }));
    // ★ A NODE WITH NO SORT KEY SORTS FIRST, and returning 0 for it — "these two are
    // equivalent" — is not the same thing: it leaves the node wherever the input happened to
    // put it, so the same data in a different document order sorts differently. The suite
    // pins the position explicitly ("Person3 has no value, meaning it will go to the
    // beginning of the results").
    keyed.sort((a, b) => {
      if (a.k === undefined && b.k === undefined) return 0;
      if (a.k === undefined) return -1;
      if (b.k === undefined) return 1;
      return compareTerms(a.k, b.k);
    });
    if (desc) keyed.reverse();
    return keyed.map(x => x.t);
  }
  if (has('limit')) {
    const n = num(subHere(op('limit'))[0] ?? op('limit')!);
    return n === undefined ? input : input.slice(0, Math.max(0, n));
  }
  if (has('offset')) {
    const n = num(subHere(op('offset'))[0] ?? op('offset')!);
    return n === undefined ? input : input.slice(Math.max(0, n));
  }
  if (has('nodes')) return input;

  // An operator we do not implement evaluates to nothing, and says so to the caller by
  // being absent from the sequence rather than by inventing a value.
  return [];
}
