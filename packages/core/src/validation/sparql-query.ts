/**
 * A synchronous SPARQL SELECT/ASK evaluator, for SHACL-SPARQL constraints.
 *
 * ── WHY THIS AND NOT COMUNICA ────────────────────────────────────────────────
 *
 * `@comunica/query-sparql` is already a declared, installed dependency of this package —
 * added in a README commit and imported by nothing — and it is a complete, correct SPARQL
 * 1.1 engine. I measured it against the four hardest pre-binding shapes in the suite,
 * including `$this` projected by a sub-SELECT, and it answered all four correctly.
 *
 * ★ IT IS STILL THE WRONG CHOICE HERE, FOR A REASON THAT HAS NOTHING TO DO WITH SPARQL.
 * Comunica is async-only. `validateAgainstShape` is synchronous and has ~77 call sites,
 * including the relay's publish gate, the Solid client's write path and the workspace
 * sealer. Adopting it means either making the validator async — a breaking change through
 * every one of those — or splitting the API in two, so that whether your shapes are checked
 * depends on which function you happened to call. Neither is worth it for a query surface
 * this small.
 *
 * And it is small, measured rather than assumed. Across all 59 query strings in the W3C
 * `sparql/` suite and this repo's own published shapes: FILTER 24, BIND 17, UNION 2,
 * EXISTS/NOT EXISTS 2, DISTINCT 1, COUNT 1, sub-SELECT 1, ORDER BY 1, LIMIT 1. The function
 * vocabulary is STR, LANG, LANGMATCHES, ISLITERAL, CONCAT, BOUND, COALESCE, STRLEN, NOW,
 * CONTAINS — every one of which sparql-functions.ts already implements for node expressions.
 *
 * ── AND MINUS / VALUES / SERVICE ARE NOT MISSING, THEY ARE FORBIDDEN ─────────
 *
 * SHACL restricts the queries a constraint may use, because pre-binding into them is not
 * well-defined. Four of the suite's five `sht:Failure` entries are exactly these — a
 * conforming implementation must REFUSE them, not execute them. So the evaluator does not
 * need them, and the parser rejecting them is a feature rather than a limitation.
 *
 * ── THE GRAMMAR IS TOTAL ─────────────────────────────────────────────────────
 *
 * ★ It parses the whole query or throws. It never skips a clause it does not understand.
 * That rule is the entire lesson of `packages/pgsl/src/sparql-engine.ts`, whose regex parser
 * swallowed `MINUS { … }` into the OBJECT of a triple pattern and returned a plausible
 * answer to a different question. A validator backed by a parser that silently drops
 * clauses does not enforce a shape; it enforces whatever survived the parse.
 */
import type { ParsedDocument, ParsedSubject, ParsedTerm } from '../rdf/turtle-parser.js';
import type { IRI } from '../model/types.js';
import { applySparqlFunction, implementsSparqlFunction } from './sparql-functions.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' as IRI;

/** Thrown for a query this engine refuses — malformed, or forbidden by SHACL. */
export class SparqlRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SparqlRefusedError';
  }
}

// ═══════════════════════════════════════════════════════════════
//  Tokeniser
// ═══════════════════════════════════════════════════════════════

type Tok =
  | { t: 'iri'; v: string }
  | { t: 'pname'; v: string }
  | { t: 'var'; v: string }
  | { t: 'str'; v: string; lang?: string; dt?: string }
  | { t: 'num'; v: string; dt: string }
  | { t: 'bool'; v: string }
  | { t: 'word'; v: string }
  | { t: 'punc'; v: string };

const PUNCT3 = ['<<(', ')>>'];
const PUNCT2 = ['&&', '||', '!=', '<=', '>=', '^^'];
const PUNCT1 = '{}()[].;,*/+-!<>=|^?';

function tokenize(src: string, base?: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }

    // <IRI> — but not the `<` operator, which is never followed by a non-space run to `>`
    if (c === '<' && /^<[^<>"{}|^`\\ ]*>/.test(src.slice(i))) {
      const end = src.indexOf('>', i);
      out.push({ t: 'iri', v: resolveAgainstBase(src.slice(i + 1, end), base) });
      i = end + 1;
      continue;
    }
    if (c === '?' || c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      if (j > i + 1) { out.push({ t: 'var', v: src.slice(i + 1, j) }); i = j; continue; }
    }
    if (c === '"' || c === "'") {
      const triple = src.slice(i, i + 3) === c.repeat(3);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      let value = '';
      while (j < src.length && src.slice(j, j + q.length) !== q) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else { value += src[j]!; j++; }
      }
      i = j + q.length;
      let lang: string | undefined;
      let dt: string | undefined;
      if (src[i] === '@') {
        let k = i + 1;
        while (k < src.length && /[A-Za-z0-9-]/.test(src[k]!)) k++;
        lang = src.slice(i + 1, k);
        i = k;
      } else if (src.slice(i, i + 2) === '^^') {
        i += 2;
        if (src[i] === '<') {
          const end = src.indexOf('>', i);
          dt = src.slice(i + 1, end);
          i = end + 1;
        } else {
          let k = i;
          while (k < src.length && /[A-Za-z0-9_:#/.-]/.test(src[k]!)) k++;
          dt = src.slice(i, k);
          i = k;
        }
      }
      out.push({ t: 'str', v: value, ...(lang ? { lang } : {}), ...(dt ? { dt } : {}) });
      continue;
    }
    if (/[0-9]/.test(c) || ((c === '-' || c === '+') && /[0-9.]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) {
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1] ?? '')) break;
        j++;
      }
      const v = src.slice(i, j);
      out.push({
        t: 'num', v,
        dt: /[eE]/.test(v) ? `${XSD}double` : v.includes('.') ? `${XSD}decimal` : `${XSD}integer`,
      });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (PUNCT3.includes(three)) { out.push({ t: 'punc', v: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) { out.push({ t: 'punc', v: two }); i += 2; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_\-.]/.test(src[j]!)) j++;
      // A prefixed name: `ex:local`, or a bare prefix `ex:`
      if (src[j] === ':') {
        let k = j + 1;
        while (k < src.length && /[A-Za-z0-9_\-.%]/.test(src[k]!)) k++;
        out.push({ t: 'pname', v: src.slice(i, k) });
        i = k;
        continue;
      }
      const w = src.slice(i, j);
      out.push(/^(true|false)$/i.test(w) ? { t: 'bool', v: w.toLowerCase() } : { t: 'word', v: w });
      i = j;
      continue;
    }
    if (c === ':') {
      let k = i + 1;
      while (k < src.length && /[A-Za-z0-9_\-.%]/.test(src[k]!)) k++;
      out.push({ t: 'pname', v: src.slice(i, k) });
      i = k;
      continue;
    }
    if (PUNCT1.includes(c)) { out.push({ t: 'punc', v: c }); i++; continue; }
    throw new SparqlRefusedError(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
//  Algebra
// ═══════════════════════════════════════════════════════════════

interface Pattern { s: Node; p: PathNode; o: Node }
type Node = { var: string } | { term: ParsedTerm };

/**
 * A predicate position: a variable, a single IRI, or a PROPERTY PATH.
 *
 * ★ THE PREDICATE IS NOT ALWAYS A TERM. `?d iep:revokedIf|iep:revokedBy $this` is this
 * repo's own published RevocationCondition shape, and a parser that reads the predicate with
 * the same function it uses for subjects and objects dies on the `|`. Alternation and
 * sequence are the two forms that actually appear; the transitive operators are parsed too,
 * so a query using them is EVALUATED rather than mistaken for a syntax error.
 */
/**
 * A SPARQL property path, and what `$PATH` on a property shape substitutes to.
 *
 * Exported so the SHACL engine can hand its own compiled path across without either side
 * rendering it back to surface syntax and re-parsing it.
 */
export type SparqlPathNode = PathNode;

type PathNode =
  | { var: string }
  | { term: ParsedTerm }
  | { alt: PathNode[] }
  | { seq: PathNode[] }
  | { repeat: PathNode; min: number; max: number }
  | { inv: PathNode };

type Group =
  | { k: 'bgp'; patterns: Pattern[] }
  | { k: 'optional'; of: Group[] }
  | { k: 'union'; arms: Group[][] }
  | { k: 'filter'; expr: Expr }
  | { k: 'bind'; expr: Expr; to: string }
  | { k: 'sub'; query: Query };

type Expr =
  | { e: 'var'; name: string }
  | { e: 'term'; term: ParsedTerm }
  | { e: 'call'; fn: string; args: Expr[] }
  /**
   * A call to a function the SHAPES GRAPH defined with `sh:function`.
   *
   * ★ Kept distinct from a built-in rather than merged into one table: a built-in is a pure
   * function of its arguments, a user function is a node expression or a whole query that
   * needs the data graph and the argument bindings. Collapsing them would mean the parser
   * could no longer tell an unimplemented built-in — which it must REFUSE by name — from a
   * function this document happens to define.
   */
  | { e: 'userCall'; iri: string; args: Expr[] }
  | { e: 'exists'; not: boolean; group: Group[] };

/**
 * One triple of a CONSTRUCT template, instantiated once per solution.
 *
 * The predicate is a Node rather than a PathNode: a template asserts triples, and a property
 * path describes a walk. `CONSTRUCT { ?a ex:p+ ?b }` is not a thing you can assert.
 */
interface TemplateTriple { s: Node; p: Node; o: Node }

interface Query {
  form: 'SELECT' | 'ASK' | 'CONSTRUCT';
  /** The CONSTRUCT template. Present exactly when the form is CONSTRUCT. */
  template?: TemplateTriple[];
  distinct: boolean;
  /** `undefined` means SELECT * */
  project?: string[];
  /** Aggregate projections: `(COUNT(?x) AS ?n)` */
  aggregates: { fn: string; arg?: string; as: string; distinct?: boolean }[];
  /**
   * Computed projections: `(<expr> AS ?v)` where the expression is NOT an aggregate.
   *
   * ★ THE PROJECTION PARSER ONLY UNDERSTOOD AGGREGATES, so `(STRLEN(STR($this)) AS ?len)` —
   * the ordinary way a SHACL function body or a select-based validator returns a computed
   * value — died on "expected AS". Five of the suite's entries are exactly that shape. An
   * aggregate is a special case of a projected expression, not the only kind.
   */
  computed: { expr: Expr; as: string }[];
  where: Group[];
  groupBy: string[];
  orderBy: { expr: Expr; desc: boolean }[];
  limit?: number;
  offset?: number;
}

// ═══════════════════════════════════════════════════════════════
//  Parser — recursive descent, total
// ═══════════════════════════════════════════════════════════════

/** SHACL forbids these outright: pre-binding into them is not well-defined. */
const FORBIDDEN = new Set(['MINUS', 'VALUES', 'SERVICE', 'GRAPH', 'FROM']);

class Parser {
  private i = 0;

  /** Non-zero while parsing a CONSTRUCT template, the one place `_:b` is legal. */
  private templateDepth = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly prefixes: ReadonlyMap<string, string>,
    /** IRIs of functions the shapes graph declares. Empty when none are in scope. */
    private readonly userFunctions: ReadonlySet<string> = new Set(),
    /**
     * Variables that stand for a PROPERTY PATH rather than a term — `$PATH` on a property
     * shape, and nothing else today.
     *
     * ★ A SUBSTITUTION, NOT A BINDING, and the difference is the whole reason this exists.
     * SHACL says to replace `$PATH` with "a valid SPARQL surface syntax string of the SHACL
     * property path". Binding it to a term can only ever express a PREDICATE path: bind it
     * for `sh:path ( ex:a ex:b )` and there is no single IRI to bind, so the variable stays
     * free and `$this $PATH ?value` matches EVERY triple of the focus node — which conforms
     * or violates by accident, never by the shape's path.
     */
    private readonly paths: ReadonlyMap<string, PathNode> = new Map(),
  ) {}

  /**
   * ★ ILL-FORMED, NOT MERELY UNSUPPORTED. §5.2.1: "The only legal use of the variable PATH
   * … is in the predicate position of a triple pattern. A query that uses the variable PATH
   * in any other position is ill-formed." Reading it as an ordinary variable anywhere else
   * would leave it unbound and quietly widen the query.
   */
  private refusePathVar(name: string): void {
    if (!this.paths.has(name)) return;
    throw new SparqlRefusedError(
      `$${name} stands for the shape's property path and may appear only in the predicate `
      + 'position of a triple pattern; a query using it elsewhere is ill-formed');
  }

  private peek(n = 0): Tok | undefined { return this.toks[this.i + n]; }
  private next(): Tok | undefined { return this.toks[this.i++]; }
  private isWord(w: string, n = 0): boolean {
    const t = this.peek(n);
    return t?.t === 'word' && t.v.toUpperCase() === w;
  }
  private isPunc(v: string, n = 0): boolean {
    const t = this.peek(n);
    return t?.t === 'punc' && t.v === v;
  }
  private eatWord(w: string): boolean { if (this.isWord(w)) { this.i++; return true; } return false; }
  private eatPunc(v: string): boolean { if (this.isPunc(v)) { this.i++; return true; } return false; }
  private expectPunc(v: string): void {
    if (!this.eatPunc(v)) {
      throw new SparqlRefusedError(`expected '${v}' but found ${JSON.stringify(this.peek())}`);
    }
  }

  private expand(pname: string): string {
    const colon = pname.indexOf(':');
    const prefix = pname.slice(0, colon);
    const local = pname.slice(colon + 1);
    const ns = this.prefixes.get(prefix);
    if (ns === undefined) throw new SparqlRefusedError(`undeclared prefix "${prefix}:"`);
    return ns + local;
  }

  private term(): ParsedTerm {
    const t = this.next();
    if (!t) throw new SparqlRefusedError('unexpected end of query');
    switch (t.t) {
      case 'iri': return { kind: 'iri', iri: t.v as IRI };
      case 'pname':
        // ★ `_:b` MEANS TWO DIFFERENT THINGS AND ONLY ONE OF THEM IS IMPLEMENTED. In a
        // CONSTRUCT template it is "a fresh blank node per solution", which the instantiator
        // does. In a WHERE clause SPARQL makes it a NON-DISTINGUISHED VARIABLE — it matches
        // anything, it is just not projected — and treating it there as the literal blank
        // node it looks like turns a pattern that should match into one that matches only a
        // data blank node carrying that exact parser-assigned label, i.e. nothing.
        //
        // A constraint whose pattern matches nothing reports no violations. So outside a
        // template it is REFUSED by name rather than answered wrongly, which is the same
        // rule this file applies to every construct it does not implement.
        if (t.v.startsWith('_:')) {
          if (this.templateDepth === 0) {
            throw new SparqlRefusedError(
              `${t.v} in a query pattern is a non-distinguished variable, which this engine `
              + 'does not implement; use a named variable');
          }
          return { kind: 'bnode', id: t.v.slice(2) };
        }
        return { kind: 'iri', iri: this.expand(t.v) as IRI };
      case 'str': return {
        kind: 'literal', value: t.v,
        ...(t.lang ? { language: t.lang } : {}),
        ...(t.dt ? { datatype: (t.dt.includes(':') && !t.dt.startsWith('http') ? this.expand(t.dt) : t.dt) as IRI } : {}),
      };
      case 'num': return { kind: 'literal', value: t.v, datatype: t.dt as IRI };
      case 'bool': return { kind: 'literal', value: t.v, datatype: `${XSD}boolean` as IRI };
      case 'word':
        if (t.v === 'a') return { kind: 'iri', iri: RDF_TYPE };
        throw new SparqlRefusedError(`unexpected keyword "${t.v}" where a term was expected`);
      default:
        throw new SparqlRefusedError(`unexpected ${t.t} where a term was expected`);
    }
  }

  private node(): Node {
    const t = this.peek();
    if (t?.t === 'var') { this.refusePathVar(t.v); this.i++; return { var: t.v }; }
    return { term: this.term() };
  }

  /** A predicate: variable, IRI, or property path. */
  private pathNode(): PathNode {
    const alts: PathNode[] = [this.pathSeq()];
    while (this.eatPunc('|')) alts.push(this.pathSeq());
    return alts.length === 1 ? alts[0]! : { alt: alts };
  }

  private pathSeq(): PathNode {
    const steps: PathNode[] = [this.pathUnary()];
    while (this.eatPunc('/')) steps.push(this.pathUnary());
    return steps.length === 1 ? steps[0]! : { seq: steps };
  }

  private pathUnary(): PathNode {
    if (this.eatPunc('^')) return { inv: this.pathUnary() };
    let base: PathNode;
    if (this.eatPunc('(')) { base = this.pathNode(); this.expectPunc(')'); }
    else {
      const t = this.peek();
      if (t?.t === 'var') { this.i++; base = this.paths.get(t.v) ?? { var: t.v }; }
      else base = { term: this.term() };
    }
    for (;;) {
      if (this.eatPunc('*')) { base = { repeat: base, min: 0, max: Infinity }; continue; }
      if (this.eatPunc('+')) { base = { repeat: base, min: 1, max: Infinity }; continue; }
      if (this.eatPunc('?')) { base = { repeat: base, min: 0, max: 1 }; continue; }
      break;
    }
    return base;
  }

  /** One expression and nothing else — the whole token stream must be consumed. */
  parseBareExpression(): Expr {
    const e = this.expression();
    if (this.peek() !== undefined) {
      // Refused rather than ignored: trailing tokens mean the expression was misread, and
      // silently evaluating the prefix of it answers a different question.
      throw new SparqlRefusedError(
        `unexpected trailing tokens after the expression: ${JSON.stringify(this.peek())}`);
    }
    return e;
  }

  /** The query, from the top. Prologue PREFIX/BASE lines are consumed by the caller. */
  parseQuery(): Query {
    const form = this.eatWord('SELECT') ? 'SELECT'
      : this.eatWord('ASK') ? 'ASK'
        : this.eatWord('CONSTRUCT') ? 'CONSTRUCT' : undefined;
    if (form === undefined) {
      const t = this.peek();
      const w = t?.t === 'word' ? t.v.toUpperCase() : String(t?.t);
      throw new SparqlRefusedError(
        `SHACL queries are SELECT, ASK or CONSTRUCT; found "${w}"`);
    }
    // A CONSTRUCT names its template before its WHERE, and the template is not a pattern to
    // match — it is the shape of what to assert once the WHERE has matched.
    const template = form === 'CONSTRUCT' ? this.constructTemplate() : undefined;
    const distinct = this.eatWord('DISTINCT');
    this.eatWord('REDUCED');

    let project: string[] | undefined;
    const aggregates: Query['aggregates'] = [];
    const computed: Query['computed'] = [];
    if (form === 'SELECT') {
      if (this.eatPunc('*')) {
        project = undefined;
      } else {
        project = [];
        for (;;) {
          const t = this.peek();
          if (t?.t === 'var') { this.refusePathVar(t.v); this.i++; project.push(t.v); continue; }
          if (this.isPunc('(')) {
            this.i++;
            // An AGGREGATE is a special case — it folds a group — so it is recognised by
            // name first. Anything else is an ordinary expression evaluated per row.
            const agg = this.tryAggregate();
            if (agg !== undefined) {
              if (!this.eatWord('AS')) throw new SparqlRefusedError('expected AS in a projection');
              const as = this.next();
              if (as?.t !== 'var') throw new SparqlRefusedError('expected a variable after AS');
              this.expectPunc(')');
              aggregates.push({ ...agg, as: as.v });
              continue;
            }
            const expr = this.expression();
            if (!this.eatWord('AS')) throw new SparqlRefusedError('expected AS in a projection');
            const as = this.next();
            if (as?.t !== 'var') throw new SparqlRefusedError('expected a variable after AS');
            this.expectPunc(')');
            computed.push({ expr, as: as.v });
            continue;
          }
          break;
        }
      }
    }
    if (this.eatWord('FROM')) throw new SparqlRefusedError('FROM is not permitted in a SHACL constraint query');
    this.eatWord('WHERE');
    const where = this.groupGraphPattern();

    const groupBy: string[] = [];
    if (this.eatWord('GROUP')) {
      if (!this.eatWord('BY')) throw new SparqlRefusedError('expected BY after GROUP');
      for (;;) { const t = this.peek(); if (t?.t !== 'var') break; this.i++; groupBy.push(t.v); }
    }
    if (this.isWord('HAVING')) throw new SparqlRefusedError('HAVING is not supported');
    const orderBy: Query['orderBy'] = [];
    if (this.eatWord('ORDER')) {
      if (!this.eatWord('BY')) throw new SparqlRefusedError('expected BY after ORDER');
      for (;;) {
        const desc = this.isWord('DESC');
        if (desc || this.isWord('ASC')) {
          this.i++;
          this.expectPunc('(');
          const e = this.expression();
          this.expectPunc(')');
          orderBy.push({ expr: e, desc });
          continue;
        }
        const t = this.peek();
        if (t?.t === 'var') {
          this.refusePathVar(t.v);
          this.i++; orderBy.push({ expr: { e: 'var', name: t.v }, desc: false }); continue;
        }
        break;
      }
    }
    let limit: number | undefined;
    let offset: number | undefined;
    for (;;) {
      if (this.eatWord('LIMIT')) { const n = this.next(); limit = Number(n?.t === 'num' ? n.v : NaN); continue; }
      if (this.eatWord('OFFSET')) { const n = this.next(); offset = Number(n?.t === 'num' ? n.v : NaN); continue; }
      break;
    }
    return {
      form, distinct, ...(project !== undefined ? { project } : {}), aggregates, computed, where, groupBy,
      orderBy, ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}),
      ...(template !== undefined ? { template } : {}),
    };
  }

  /**
   * The `{ … }` after CONSTRUCT: triples to assert, not patterns to match.
   *
   * ★ NO PATHS, NO FILTERS, NO NESTING — and refusing them is the point rather than a
   * shortcut. A template is a list of triples; anything else in those braces means the query
   * was misread, and a parser that skips what it does not recognise asserts a smaller graph
   * than the author wrote without saying which triples it dropped.
   */
  private constructTemplate(): TemplateTriple[] {
    this.expectPunc('{');
    this.templateDepth++;
    const out: TemplateTriple[] = [];
    while (!this.isPunc('}')) {
      if (this.peek() === undefined) {
        throw new SparqlRefusedError('unterminated CONSTRUCT template — missing }');
      }
      const s = this.node();
      for (;;) {
        const p = this.node();
        for (;;) {
          out.push({ s, p, o: this.node() });
          if (!this.eatPunc(',')) break;
        }
        if (!this.eatPunc(';')) break;
        if (this.isPunc('}') || this.isPunc('.')) break;
      }
      this.eatPunc('.');
    }
    this.expectPunc('}');
    this.templateDepth--;
    return out;
  }

  private static readonly AGGREGATES = new Set(
    ['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'GROUP_CONCAT', 'SAMPLE']);

  /** `COUNT(?x)` / `COUNT(*)` at the cursor, or undefined without consuming anything. */
  private tryAggregate(): { fn: string; arg?: string; distinct?: boolean } | undefined {
    const t = this.peek();
    if (t?.t !== 'word' || !Parser.AGGREGATES.has(t.v.toUpperCase())) return undefined;
    if (!this.isPunc('(', 1)) return undefined;
    const save = this.i;
    this.i += 2;
    // ★ DISTINCT WAS EATEN AND THROWN AWAY, so COUNT(DISTINCT ?x) counted duplicates —
    // accepted rather than refused, and answering a confident wrong number, which is the
    // exact failure this file's header condemns.
    const distinct = this.eatWord('DISTINCT');
    let arg: string | undefined;
    if (this.isPunc('*')) this.i++;
    else {
      const a = this.peek();
      if (a?.t === 'var') { this.refusePathVar(a.v); this.i++; arg = a.v; }
    }
    if (!this.eatPunc(')')) { this.i = save; return undefined; }
    return {
      fn: t.v.toUpperCase(),
      ...(arg !== undefined ? { arg } : {}),
      ...(distinct ? { distinct: true } : {}),
    };
  }

  private groupGraphPattern(): Group[] {
    this.expectPunc('{');
    const groups: Group[] = [];
    let bgp: Pattern[] = [];
    const flush = (): void => { if (bgp.length > 0) { groups.push({ k: 'bgp', patterns: bgp }); bgp = []; } };

    while (!this.isPunc('}')) {
      if (this.peek() === undefined) throw new SparqlRefusedError('unterminated group — missing }');

      const t = this.peek()!;
      if (t.t === 'word' && FORBIDDEN.has(t.v.toUpperCase())) {
        // ★ REFUSED, NOT UNIMPLEMENTED. SHACL restricts constraint queries because
        // pre-binding into these is not well-defined, and four of the suite's five
        // sht:Failure entries are exactly this. Executing them anyway returns a plausible
        // answer to a question the spec says must not be asked.
        throw new SparqlRefusedError(
          `${t.v.toUpperCase()} is not permitted in a SHACL constraint query — pre-binding `
          + 'into it is undefined, and a conforming implementation must refuse rather than '
          + 'execute it');
      }
      if (this.eatWord('OPTIONAL')) { flush(); groups.push({ k: 'optional', of: this.groupGraphPattern() }); continue; }
      if (this.eatWord('FILTER')) { flush(); groups.push({ k: 'filter', expr: this.filterExpression() }); continue; }
      if (this.eatWord('BIND')) {
        flush();
        this.expectPunc('(');
        const expr = this.expression();
        if (!this.eatWord('AS')) throw new SparqlRefusedError('expected AS inside BIND');
        const v = this.next();
        if (v?.t !== 'var') throw new SparqlRefusedError('expected a variable after AS in BIND');
        this.expectPunc(')');
        groups.push({ k: 'bind', expr, to: v.v });
        continue;
      }
      if (this.isPunc('{')) {
        flush();
        // Either a sub-SELECT or a plain group, possibly followed by UNION.
        if (this.peek(1)?.t === 'word' && /^(SELECT|ASK)$/i.test((this.peek(1) as { v: string }).v)) {
          this.expectPunc('{');
          groups.push({ k: 'sub', query: this.parseQuery() });
          this.expectPunc('}');
        } else {
          const arms: Group[][] = [this.groupGraphPattern()];
          while (this.eatWord('UNION')) arms.push(this.groupGraphPattern());
          groups.push(arms.length === 1 ? { k: 'union', arms } : { k: 'union', arms });
        }
        continue;
      }
      if (this.eatPunc('.') || this.eatPunc(';') || this.eatPunc(',')) continue;

      // A triple pattern, with `;` and `,` continuations.
      const s = this.node();
      for (;;) {
        const p = this.pathNode();
        for (;;) {
          const o = this.node();
          bgp.push({ s, p, o });
          if (!this.eatPunc(',')) break;
        }
        if (!this.eatPunc(';')) break;
        if (this.isPunc('}') || this.isPunc('.')) break;
      }
      this.eatPunc('.');
    }
    this.expectPunc('}');
    flush();
    return groups;
  }

  private filterExpression(): Expr {
    if (this.isWord('EXISTS') || (this.isWord('NOT') && this.isWord('EXISTS', 1))) {
      const not = this.eatWord('NOT');
      this.eatWord('EXISTS');
      return { e: 'exists', not, group: this.groupGraphPattern() };
    }
    if (this.eatPunc('(')) { const e = this.expression(); this.expectPunc(')'); return e; }
    return this.expression();
  }

  // ── expression precedence: || < && < comparison < additive < multiplicative < unary ──
  private expression(): Expr { return this.orExpr(); }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.eatPunc('||')) left = { e: 'call', fn: 'logical-or', args: [left, this.andExpr()] };
    return left;
  }

  private andExpr(): Expr {
    let left = this.cmpExpr();
    while (this.eatPunc('&&')) left = { e: 'call', fn: 'logical-and', args: [left, this.cmpExpr()] };
    return left;
  }

  private cmpExpr(): Expr {
    const left = this.addExpr();
    const ops: Record<string, string> = {
      '=': 'equals', '!=': 'not-equals', '<': 'less-than', '>': 'greater-than',
      '<=': 'less-than-or-equal', '>=': 'greater-than-or-equal',
    };
    // ★ `IN` IS AN OPERATOR, NOT A FUNCTION, and it is the legal way to write what VALUES
    // cannot be used for here. SHACL forbids VALUES in a constraint query, so an enumeration
    // has to be spelled `FILTER (?x IN (a, b, c))` — and a parser without it forces the
    // author toward the construct the spec bans.
    //
    // Desugared to `logical-or` of equality tests rather than given its own evaluator: the
    // semantics ARE that disjunction, including the empty-list case, which is false.
    const notIn = this.isWord('NOT') && this.isWord('IN', 1);
    if (notIn || this.isWord('IN')) {
      if (notIn) this.i++;
      this.i++;
      this.expectPunc('(');
      const items: Expr[] = [];
      if (!this.isPunc(')')) {
        for (;;) { items.push(this.expression()); if (!this.eatPunc(',')) break; }
      }
      this.expectPunc(')');
      const tests = items.map(item => ({ e: 'call', fn: 'equals', args: [left, item] } as Expr));
      const any: Expr = tests.length === 0
        ? { e: 'term', term: { kind: 'literal', value: 'false', datatype: `${XSD}boolean` as IRI } }
        : { e: 'call', fn: 'logical-or', args: tests };
      return notIn ? { e: 'call', fn: 'logical-not', args: [any] } : any;
    }
    const t = this.peek();
    if (t?.t === 'punc' && ops[t.v] !== undefined) {
      this.i++;
      return { e: 'call', fn: ops[t.v]!, args: [left, this.addExpr()] };
    }
    return left;
  }

  private addExpr(): Expr {
    let left = this.mulExpr();
    for (;;) {
      if (this.eatPunc('+')) { left = { e: 'call', fn: 'plus', args: [left, this.mulExpr()] }; continue; }
      if (this.eatPunc('-')) { left = { e: 'call', fn: 'subtract', args: [left, this.mulExpr()] }; continue; }
      break;
    }
    return left;
  }

  private mulExpr(): Expr {
    let left = this.unary();
    for (;;) {
      if (this.eatPunc('*')) { left = { e: 'call', fn: 'multiply', args: [left, this.unary()] }; continue; }
      if (this.eatPunc('/')) { left = { e: 'call', fn: 'divide', args: [left, this.unary()] }; continue; }
      break;
    }
    return left;
  }

  private unary(): Expr {
    if (this.eatPunc('!')) return { e: 'call', fn: 'logical-not', args: [this.unary()] };
    if (this.eatPunc('-')) return { e: 'call', fn: 'unary-minus', args: [this.unary()] };
    if (this.eatPunc('+')) return { e: 'call', fn: 'unary-plus', args: [this.unary()] };
    return this.primary();
  }

  private primary(): Expr {
    if (this.eatPunc('(')) { const e = this.expression(); this.expectPunc(')'); return e; }
    const t = this.peek();
    if (t?.t === 'var') { this.refusePathVar(t.v); this.i++; return { e: 'var', name: t.v }; }
    if (t?.t === 'word' && (this.isWord('EXISTS') || this.isWord('NOT'))) {
      const not = this.eatWord('NOT');
      if (!this.eatWord('EXISTS')) throw new SparqlRefusedError('expected EXISTS after NOT');
      return { e: 'exists', not, group: this.groupGraphPattern() };
    }
    // ★ A PREFIXED-NAME FUNCTION CALL IS A CALL. Failing to see it produced a parse error
    // about the NEXT token — "expected AS inside BIND" for
    // `BIND (ex:instanceCount(ex:Name) AS ?value)` — which points at the wrong thing.
    //
    // It is a call to a function the SHAPES GRAPH declared, so whether it is legal depends
    // on the document, not on this engine: the declared set is passed in. One this document
    // does not declare is refused BY NAME rather than by syntax error.
    if (t?.t === 'pname' && this.isPunc('(', 1)) {
      const iri = this.expand(t.v);
      this.i += 2;
      const args: Expr[] = [];
      if (!this.isPunc(')')) {
        for (;;) { args.push(this.expression()); if (!this.eatPunc(',')) break; }
      }
      this.expectPunc(')');
      if (!this.userFunctions.has(iri)) {
        throw new SparqlRefusedError(
          `${t.v}() is not a function this engine implements and the shapes graph does not `
          + 'declare it with sh:function, so the constraint cannot be evaluated');
      }
      return { e: 'userCall', iri, args };
    }
    if (t?.t === 'word' && this.isPunc('(', 1)) {
      this.i += 2;
      const fn = normaliseFn(t.v);
      const args: Expr[] = [];
      if (!this.isPunc(')')) {
        for (;;) { args.push(this.expression()); if (!this.eatPunc(',')) break; }
      }
      this.expectPunc(')');
      if (!implementsSparqlFunction(fn)) {
        throw new SparqlRefusedError(
          `SPARQL function ${t.v}() is not implemented by this engine, so the constraint `
          + 'cannot be evaluated');
      }
      return { e: 'call', fn, args };
    }
    return { e: 'term', term: this.term() };
  }
}

/** SPARQL spells some functions differently from the shnex: vocabulary. */
function normaliseFn(raw: string): string {
  const lower = raw.toLowerCase();
  const map: Record<string, string> = {
    isiri: 'isIRI', isuri: 'isURI', isblank: 'isBlank', isliteral: 'isLiteral',
    isnumeric: 'isNumeric', istriple: 'isTriple', samevalue: 'sameValue', sameterm: 'sameTerm',
    langmatches: 'langMatches', haslang: 'hasLang', haslangdir: 'hasLangdir',
    strdt: 'strdt', strlang: 'strlang', strlangdir: 'strlangdir',
    encode_for_uri: 'encode_for_uri', struuid: 'struuid',
  };
  return map[lower] ?? lower;
}

// ═══════════════════════════════════════════════════════════════
//  Evaluation
// ═══════════════════════════════════════════════════════════════

export type Binding = ReadonlyMap<string, ParsedTerm>;

const termKey = (t: ParsedTerm): string => {
  switch (t.kind) {
    case 'iri': return `I${t.iri}`;
    case 'bnode': return `B${t.id}`;
    // JSON, not a separator byte: a literal's value can contain ANY byte, including
      // whatever separator looked safe -- and a raw NUL additionally makes the whole
      // source file binary to git, with no reviewable diff at all.
      case 'literal': return `L${JSON.stringify([t.value, t.datatype ?? '', t.language ?? ''])}`;
    case 'triple':
      return `T${JSON.stringify([termKey(t.subject), t.predicate, termKey(t.object)])}`;
  }
};

const subjTerm = (s: ParsedSubject): ParsedTerm =>
  (typeof s.subject === 'string'
    ? { kind: 'iri', iri: s.subject as IRI }
    : { kind: 'bnode', id: s.subject.bnode });

function matches(node: Node, term: ParsedTerm, b: Map<string, ParsedTerm>): boolean {
  if ('term' in node) return termKey(node.term) === termKey(term);
  const existing = b.get(node.var);
  if (existing !== undefined) return termKey(existing) === termKey(term);
  b.set(node.var, term);
  return true;
}

/** Is this predicate a plain IRI or variable, matchable one triple at a time? */
function isSimplePredicate(p: PathNode): p is { var: string } | { term: ParsedTerm } {
  return 'var' in p || 'term' in p;
}

/**
 * (subject, object) pairs a PATH connects.
 *
 * Only reached for a compound path; a plain predicate is matched triple-by-triple in the
 * join, which keeps the common case cheap.
 */
function pathPairs(doc: ParsedDocument, path: PathNode, depth = 0): [ParsedTerm, ParsedTerm][] {
  if (depth > 16) return [];
  const out: [ParsedTerm, ParsedTerm][] = [];
  if ('term' in path) {
    const iri = path.term.kind === 'iri' ? path.term.iri : undefined;
    if (iri === undefined) return [];
    for (const subj of doc.subjects) {
      for (const o of subj.properties.get(iri) ?? []) out.push([subjTerm(subj), o]);
    }
    return out;
  }
  if ('var' in path) {
    for (const subj of doc.subjects) {
      for (const [, objs] of subj.properties) for (const o of objs) out.push([subjTerm(subj), o]);
    }
    return out;
  }
  if ('alt' in path) {
    for (const a of path.alt) out.push(...pathPairs(doc, a, depth + 1));
    return out;
  }
  if ('inv' in path) {
    for (const [a, b] of pathPairs(doc, path.inv, depth + 1)) out.push([b, a]);
    return out;
  }
  if ('seq' in path) {
    let acc = pathPairs(doc, path.seq[0]!, depth + 1);
    for (const step of path.seq.slice(1)) {
      const nextPairs = pathPairs(doc, step, depth + 1);
      const joined: [ParsedTerm, ParsedTerm][] = [];
      for (const [a, mid] of acc) {
        for (const [m2, b] of nextPairs) if (termKey(mid) === termKey(m2)) joined.push([a, b]);
      }
      acc = joined;
    }
    return acc;
  }
  // repeat
  const step = pathPairs(doc, path.repeat, depth + 1);
  const seen = new Set<string>();
  const push = (a: ParsedTerm, b: ParsedTerm): void => {
    const k = `${termKey(a)} ${termKey(b)}`;
    if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
  };
  if (path.min === 0) {
    // ★ A ZERO-LENGTH PATH IS THE IDENTITY ON EVERY NODE, not on the nodes that happen to
    // take a step. Seeding from `step` alone means a `*` path over a relation with NO
    // triples contributes NOTHING — and `?p a/rdfs:subClassOf* ex:Person` over a graph with
    // no subClassOf at all then matches nobody, when every direct instance should match.
    // That is the whole SPARQL-target fixture: three people, none of them selected.
    for (const subj of doc.subjects) {
      const t = subjTerm(subj);
      push(t, t);
      for (const [, objs] of subj.properties) for (const o of objs) push(o, o);
    }
  }
  // ★ AN UNBOUNDED PATH RUNS TO A FIXPOINT, NOT TO SIXTEEN. `*` and `+` mean the transitive
  // closure, and this loop used to stop at 16 hops with no error and no refusal — so
  // `ASK { :n0 :next+ :n25 }` over a 25-link chain answered FALSE. Not "I gave up": false.
  // A reachability question that says "not reachable" because the engine stopped counting is
  // the fail-open shape this whole file is written against.
  //
  // Termination is not a matter of trusting the data: the frontier is deduped against pairs
  // already emitted, and there are at most |nodes|² distinct pairs, so a cycle stops growing
  // rather than looping. A bounded `{n,m}` repeat still stops at its own bound.
  const emitted = new Set<string>();
  let frontier = step;
  for (let n = 1; frontier.length > 0 && n <= path.max; n++) {
    for (const [a, b] of frontier) if (n >= path.min) push(a, b);
    const grown: [ParsedTerm, ParsedTerm][] = [];
    for (const [a, mid] of frontier) {
      for (const [m2, b] of step) {
        if (termKey(mid) !== termKey(m2)) continue;
        // Dedup the FRONTIER as well as the output: without this a cycle regrows the same
        // pair every round and an unbounded path never terminates.
        //
        // ★ SOUND ONLY WHILE min <= 1, WHICH IS EVERY PATH THIS GRAMMAR CAN PRODUCE — `*` and
        // `?` are min 0, `+` is min 1, and SPARQL 1.1 dropped `{n,m}`. With min 2 or more the
        // dedup would drop a pair first reached BELOW the minimum length and therefore never
        // pushed, so it would be missing from the answer rather than merely repeated. The
        // guard is here so that adding `{n,m}` to the parser cannot silently inherit the bug.
        const k = pairKey(a, b);
        if (path.min <= 1 && emitted.has(k)) continue;
        emitted.add(k);
        grown.push([a, b]);
      }
    }
    frontier = grown;
  }
  return out;
}

/**
 * A dedup key for one (subject, object) pair.
 *
 * ★ A NAMED HELPER RATHER THAN THE TEMPLATE LITERAL SPELLED OUT AT EACH SITE, because the
 * separator is invisible and this file has already been bitten once: two of these keys were
 * written with a raw NUL between the halves instead of a space, which made the whole source
 * file BINARY to git. One place to get it right is one place to get it wrong.
 */
function pairKey(a: ParsedTerm, b: ParsedTerm): string {
  return `${termKey(a)} ${termKey(b)}`;
}

/** Can this path be walked in ZERO steps — `*`, `?`, or a composition of such? */
function matchesEmptyPath(p: PathNode): boolean {
  // `(ex:p*)+` takes zero steps by taking one iteration of a zero-length inner path, so
  // asking only about THIS repeat's minimum answers the wrong question.
  if ('repeat' in p) return p.min === 0 || matchesEmptyPath(p.repeat);
  if ('inv' in p) return matchesEmptyPath(p.inv);
  if ('seq' in p) return p.seq.every(matchesEmptyPath);
  if ('alt' in p) return p.alt.some(matchesEmptyPath);
  return false;
}

function joinBgp(doc: ParsedDocument, patterns: readonly Pattern[], input: Binding[]): Binding[] {
  let rows = input;
  for (const pat of patterns) {
    const next: Binding[] = [];
    if (isSimplePredicate(pat.p)) {
      for (const row of rows) {
        for (const subj of doc.subjects) {
          const sTerm = subjTerm(subj);
          for (const [pred, objs] of subj.properties) {
            for (const obj of objs) {
              const b = new Map(row);
              if (!matches(pat.s, sTerm, b)) continue;
              if (!matches(pat.p, { kind: 'iri', iri: pred }, b)) continue;
              if (!matches(pat.o, obj, b)) continue;
              next.push(b);
            }
          }
        }
      }
    } else {
      const pairs = pathPairs(doc, pat.p);
      // ★ A ZERO-LENGTH PATH REACHES A TERM THAT IS NOT IN THE GRAPH. §18.4: where one end
      // is a term and the other a variable, ZeroLengthPath binds the variable to that term —
      // there is no requirement that it appear anywhere in the data.
      //
      // `?predicate rdfs:subPropertyOf* rdfs:label` is the case, and it is not exotic: it is
      // how you say "rdfs:label or anything declared a sub-property of it". rdfs:label
      // occurs in this graph only as a PREDICATE, so it is not a node, so seeding the
      // identity from the graph's nodes alone yields NOTHING — and the query that walks
      // every label finds none. Measured: a spec-authored SHACL function returned 0 for a
      // resource with three labels.
      const canBeEmpty = matchesEmptyPath(pat.p);
      // ★ AND DEDUPED AGAINST THE PAIRS ALREADY THERE. `pathPairs` seeds the identity on every
      // node of the graph, so appending it again for an endpoint that IS a graph node yields
      // the zero-length solution TWICE — and a duplicate solution is not cosmetic: it doubles
      // a COUNT, doubles a SHACL violation report, and makes `?a ex:p* ?a` return two rows
      // where SPARQL's set semantics say one.
      const seeded = canBeEmpty ? new Set(pairs.map(([a, b]) => pairKey(a, b)))
        : undefined;
      for (const row of rows) {
        const candidates = canBeEmpty ? [...pairs] : pairs;
        if (canBeEmpty) {
          // ★ AND DEDUPED AGAINST EACH OTHER, NOT ONLY AGAINST `pairs`. The two ends can be
          // the SAME term — `rdfs:label rdfs:subPropertyOf* rdfs:label` is the canonical
          // case — and each end was appending its own identity pair, so a term absent from
          // the graph got it twice. The very duplication the dedup was added to stop:
          // measured, `?s ?p ?o . ?p rdfs:subPropertyOf* rdfs:label` counted three labels as
          // six. A first fix that half-fixes its own bug is worse than none, because the
          // remaining half now looks checked.
          let addedS: string | undefined;
          for (const end of [pat.s, pat.o]) {
            const t = 'term' in end ? end.term : row.get(end.var);
            if (t === undefined) continue;
            const k = pairKey(t, t);
            if (seeded!.has(k) || k === addedS) continue;
            addedS = k;
            candidates.push([t, t]);
          }
        }
        for (const [sTerm, oTerm] of candidates) {
          const b = new Map(row);
          if (!matches(pat.s, sTerm, b)) continue;
          if (!matches(pat.o, oTerm, b)) continue;
          next.push(b);
        }
      }
    }
    rows = next;
    if (rows.length === 0) return [];
  }
  return rows;
}

function evalGroups(
  doc: ParsedDocument, groups: readonly Group[], input: Binding[], ctx?: EvalCtx,
): Binding[] {
  let rows = input;
  // ★ A FILTER SCOPES TO ITS WHOLE GROUP, NOT TO WHERE IT IS WRITTEN. §18.2.2.8: filters are
  // lifted out of the group pattern and applied to the result of everything else in it. Run
  // in textual order, `{ FILTER (?v > 1) . ?s ex:p ?v }` is evaluated against rows where ?v
  // is not yet bound, `?v > 1` is an error, and EVERY row is dropped — a constraint query
  // written that way silently matches nothing, which reads as "the data is fine".
  //
  // The same lifting is why a filter is not a barrier for OPTIONAL: `{ ?s ex:p ?v . OPTIONAL
  // { ?s ex:q ?w } FILTER (bound(?w)) }` must see ?w.
  const filters = groups.filter(g => g.k === 'filter');
  const rest = filters.length === 0 ? groups : groups.filter(g => g.k !== 'filter');
  for (const g of rest) {
    switch (g.k) {
      case 'bgp': rows = joinBgp(doc, g.patterns, rows); break;
      case 'optional': {
        const out: Binding[] = [];
        for (const row of rows) {
          const extended = evalGroups(doc, g.of, [row], ctx);
          if (extended.length === 0) out.push(row);
          else out.push(...extended);
        }
        rows = out;
        break;
      }
      case 'union': {
        // ★ AN ARM IS ITS OWN SCOPE, AND A NESTED `{ … }` IS A ONE-ARM UNION. §18.2.2.6
        // translates a group to `Join(G, Filter(F, translate(inner)))` — the inner pattern is
        // evaluated on its own and only then joined. Seeding each arm with the ENCLOSING
        // rows made a filter written inside the braces see variables from outside them, which
        // with filters now lifted to the end of their group is the difference between "type
        // error, no rows" and "compares fine, one row".
        //
        // Measured: `{ ?s ex:age ?age . { ex:bob ex:age ?limit . FILTER (?age > ?limit) } }`
        // reported a violation on ex:alice where a conforming engine reports none.
        //
        // Seeded from the PRE-BINDINGS, not from nothing: SHACL substitutes $this into the
        // whole query, nested groups included, and pre-binding-002 is a UNION arm filtering
        // on $this. That is the one thing that crosses the boundary.
        const out: Binding[] = [];
        for (const arm of g.arms) {
          const solutions = evalGroups(doc, arm, [new Map(ctx?.preBound ?? [])], ctx);
          for (const row of rows) {
            for (const sol of solutions) {
              let compatible = true;
              for (const [k, val] of sol) {
                const existing = row.get(k);
                if (existing !== undefined && termKey(existing) !== termKey(val)) {
                  compatible = false;
                  break;
                }
              }
              if (!compatible) continue;
              const merged = new Map(row);
              for (const [k, val] of sol) merged.set(k, val);
              out.push(merged);
            }
          }
        }
        rows = out;
        break;
      }
      case 'filter':
        break;      // lifted above; applied once the rest of the group has been evaluated
      case 'bind':
        rows = rows.map(r => {
          const v = evalExpr(doc, g.expr, r, ctx);
          if (v === undefined) return r;
          const b = new Map(r);
          b.set(g.to, v);
          return b;
        });
        break;
      case 'sub': {
        // Evaluated ONCE, from the pre-bindings alone, then joined — see EvalCtx.preBound.
        const solutions = runQuery(doc, g.query, new Map(ctx?.preBound ?? []), ctx);
        const out: Binding[] = [];
        for (const row of rows) {
          for (const sol of solutions) {
            // A join, not an overwrite: solutions that disagree on a shared variable are
            // INCOMPATIBLE and contribute nothing. Merging regardless invented a row whose
            // shared variable silently took the sub-query's value.
            let compatible = true;
            for (const [k, v] of sol) {
              const existing = row.get(k);
              if (existing !== undefined && termKey(existing) !== termKey(v)) {
                compatible = false;
                break;
              }
            }
            if (!compatible) continue;
            const merged = new Map(row);
            for (const [k, v] of sol) merged.set(k, v);
            out.push(merged);
          }
        }
        rows = out;
        break;
      }
    }
  }
  for (const f of filters) {
    if (f.k !== 'filter') continue;                  // narrowing only; the list is filters
    rows = rows.filter(r => isTrue(evalExpr(doc, f.expr, r, ctx)));
  }
  return rows;
}

const isTrue = (t: ParsedTerm | undefined): boolean =>
  t?.kind === 'literal' && (t.value === 'true' || t.value === '1');

/**
 * A function the shapes graph declared. Arguments arrive positionally; an argument the
 * caller omitted, or one whose expression produced nothing, is `undefined` and must stay
 * that way — `COALESCE($arg1, 'en')` reaches its default only if `$arg1` is genuinely
 * unbound, and langLabelCount-example calls the same function with one argument and with
 * two precisely to check that.
 */
export type UserFunction = (args: readonly (ParsedTerm | undefined)[]) => ParsedTerm | undefined;

/** Resolution context threaded through evaluation. */
interface EvalCtx {
  readonly doc: ParsedDocument;
  readonly functions: ReadonlyMap<string, UserFunction>;
  /**
   * SHACL's pre-bindings for this query — `$this` and any constraint-component parameters.
   *
   * ★ THESE REACH A SUB-SELECT AND ORDINARY OUTER BINDINGS DO NOT, and the two were the same
   * thing here. Pre-binding is a SHACL mechanism defined to substitute into the whole query,
   * nested selects included (the suite has an entry for exactly that); a variable bound by
   * the enclosing group is plain SPARQL, and §18.2 evaluates a sub-select independently and
   * then JOINS. Passing the outer row in silently narrowed what the sub-query's aggregate
   * folded over, and turned its LIMIT into a per-row limit.
   */
  readonly preBound?: Binding;
}

function evalExpr(doc: ParsedDocument, e: Expr, b: Binding, ctx?: EvalCtx): ParsedTerm | undefined {
  switch (e.e) {
    case 'var': return b.get(e.name);
    case 'term': return e.term;
    case 'exists': {
      const found = evalGroups(doc, e.group, [b], ctx).length > 0;
      return {
        kind: 'literal', value: String(e.not ? !found : found), datatype: `${XSD}boolean` as IRI,
      };
    }
    case 'userCall': {
      const fn = ctx?.functions.get(e.iri);
      if (fn === undefined) return undefined;
      const args: ParsedTerm[] = [];
      for (const a of e.args) {
        const v = evalExpr(doc, a, b, ctx);
        // ★ AN UNBOUND ARGUMENT IS AN ERROR, NOT A MISSING ONE, and the two produce opposite
        // answers. `f(?none, 'en')` where ?none is unbound raises an error in SPARQL, so the
        // enclosing BIND assigns nothing — which is how `bound(?v4)` comes out FALSE. Passing
        // it through as "parameter absent" instead runs the body with $arg0 free, where
        // `$arg0 ?p ?label` matches every triple in the graph and the function cheerfully
        // returns a count. Measured: it returned true where the spec's own example says
        // false, and it is the LAST way you would notice, because a plausible number came
        // back.
        //
        // A trailing argument the caller never wrote is a different thing entirely and stays
        // unbound inside the body — that is what makes `COALESCE($arg1, 'en')` reach its
        // default.
        if (v === undefined) return undefined;
        args.push(v);
      }
      return fn(args);
    }
    case 'call': {
      // NOW() has no argument and no place in a pure function table keyed on its arguments.
      if (e.fn === 'now') {
        return { kind: 'literal', value: new Date().toISOString(), datatype: `${XSD}dateTime` as IRI };
      }
      if (e.fn === 'if') {
        const cond = evalExpr(doc, e.args[0]!, b, ctx);
        return evalExpr(doc, isTrue(cond) ? e.args[1]! : e.args[2]!, b, ctx);
      }
      const args = e.args.map(a => {
        const v = evalExpr(doc, a, b, ctx);
        return v === undefined ? [] : [v];
      });
      return applySparqlFunction(e.fn, args)[0];
    }
  }
}

/**
 * One aggregate over one group.
 *
 * ★ SEVEN WERE PARSED AND TWO WERE COMPUTED. MIN, MAX, AVG, SAMPLE and GROUP_CONCAT were
 * accepted by the projection parser and then evaluated to `NaN`, which was stored as an
 * xsd:integer literal reading "NaN" — a query using any of them got a confident, typed,
 * wrong answer rather than a refusal. Accepting a construct is a promise to implement it;
 * where that promise cannot be kept the query must be REFUSED by name, which is what the
 * parser does for every function it does not know.
 */
function aggregate(
  fn: string, arg: string | undefined, members: readonly Binding[], distinct: boolean,
): ParsedTerm | undefined {
  const raw: ParsedTerm[] = arg === undefined
    ? []
    : members.map(m => m.get(arg)).filter((x): x is ParsedTerm => x !== undefined);
  // DISTINCT applies to the multiset the aggregate folds, not to the solutions.
  const vals = distinct ? dedupeTerms(raw) : raw;
  // ★ A NON-NUMERIC MEMBER IS A TYPE ERROR, NOT A MEMBER TO SKIP. §18.5.1.2/.4: Sum and Avg
  // over an operand that is not numeric raise an error, and an aggregate that errors is
  // UNBOUND. Filtering the offender out instead answers a different question — the sum of
  // whichever members happened to be numeric — and does it with a datatype derived from the
  // discarded value too.
  const numsOrError = (): number[] | undefined => {
    const out: number[] = [];
    for (const t of vals) {
      const n = t.kind === 'literal' && isNumericLiteral(t) ? Number(t.value) : NaN;
      if (!Number.isFinite(n)) return undefined;
      out.push(n);
    }
    return out;
  };
  // Integer in, integer out — the same rule the arithmetic operators follow.
  const allInt = vals.every(t => t.kind === 'literal' && t.datatype === `${XSD}integer`);
  const numeric = (n: number, forceDecimal = false): ParsedTerm => {
    // ★ `String(n)` GIVES EXPONENTIAL NOTATION PAST 1e21, WHICH IS NOT A DECIMAL. A lexical
    // form no parser will read back is not a value; xsd:double is the type that owns that
    // notation, so a magnitude that cannot be written as a decimal is typed as one.
    const exponential = /[eE]/.test(String(n));
    if (exponential) return { kind: 'literal', value: String(n), datatype: `${XSD}double` as IRI };
    const asInteger = allInt && !forceDecimal && Number.isInteger(n);
    return {
      kind: 'literal',
      value: asInteger ? String(n) : (Number.isInteger(n) ? `${n}.0` : String(n)),
      datatype: (asInteger ? `${XSD}integer` : `${XSD}decimal`) as IRI,
    };
  };
  switch (fn) {
    case 'COUNT': return {
      kind: 'literal',
      value: String(arg === undefined
        ? (distinct ? dedupeSolutions(members).length : members.length)
        : vals.length),
      datatype: `${XSD}integer` as IRI,
    };
    case 'SUM': {
      const ns = numsOrError();
      return ns === undefined ? undefined : numeric(ns.reduce((a, b) => a + b, 0));
    }
    // §18.5.1.4 — AVG of an empty multiset is 0, not unbound.
    case 'AVG': {
      const ns = numsOrError();
      if (ns === undefined) return undefined;
      // ★ AVG IS A DIVISION, AND op:numeric-divide ON TWO INTEGERS YIELDS xsd:decimal.
      // AVG(1,3) is 2 — a whole number, but not an xsd:integer, and this engine's own `/`
      // operator already says so. Typing it as an integer makes the aggregate disagree with
      // the arithmetic beside it.
      return ns.length === 0 ? { kind: 'literal', value: '0', datatype: `${XSD}integer` as IRI }
        : numeric(ns.reduce((a, b) => a + b, 0) / ns.length, true);
    }
    case 'MIN': case 'MAX': {
      if (vals.length === 0) return undefined;      // no values, no answer — correctly unbound
      return vals.reduce((best, t) =>
        (fn === 'MIN' ? compareTerms(t, best) < 0 : compareTerms(t, best) > 0) ? t : best);
    }
    case 'SAMPLE': return vals[0];
    case 'GROUP_CONCAT': return {
      kind: 'literal',
      // The default separator is a single space; SEPARATOR is not parsed, so a query that
      // sets one would be misread — the parser refuses it as an unexpected token.
      value: vals.map(t => (t.kind === 'literal' ? t.value : t.kind === 'iri' ? t.iri : '')).join(' '),
    };
    default: throw new SparqlRefusedError(`aggregate ${fn} is not implemented`);
  }
}

const NUMERIC_DATATYPES: ReadonlySet<string> = new Set([
  `${XSD}integer`, `${XSD}decimal`, `${XSD}double`, `${XSD}float`,
  `${XSD}long`, `${XSD}int`, `${XSD}short`, `${XSD}byte`,
  `${XSD}nonNegativeInteger`, `${XSD}nonPositiveInteger`,
  `${XSD}negativeInteger`, `${XSD}positiveInteger`,
  `${XSD}unsignedLong`, `${XSD}unsignedInt`, `${XSD}unsignedShort`, `${XSD}unsignedByte`,
]);

/**
 * ★ NUMERIC IS A PROPERTY OF THE DATATYPE, NOT OF HOW THE LEXICAL FORM LOOKS. `"10"` is an
 * xsd:string whose characters happen to be digits; SPARQL orders it against `"9"` by
 * codepoint, so `"10"` is the smaller. Coercing every literal through `Number()` made
 * MIN("10","9") answer "9" — a real term from the real data, wrong, and invisible.
 */
function isNumericLiteral(t: ParsedTerm): boolean {
  return t.kind === 'literal' && t.datatype !== undefined && NUMERIC_DATATYPES.has(t.datatype);
}

/**
 * ★ A TIMESTAMP IS A VALUE, NOT A STRING, AND THE TIMEZONE IS WHERE THAT BITES. §15.1 orders
 * by the `<` operator, which §17.3 maps to op:dateTime-less-than — a comparison of INSTANTS.
 * `2025-12-31T23:00:00-02:00` is `2026-01-01T01:00:00Z`, so it sorts AFTER
 * `2026-01-01T00:00:00Z` while sorting BEFORE it by codepoint. MIN over a set of timestamps
 * written in different offsets then returns the wrong one, and it returns a real value from
 * the real data while doing it.
 */
const INSTANT_DATATYPES: ReadonlySet<string> = new Set([`${XSD}dateTime`, `${XSD}dateTimeStamp`]);

function instantOf(t: ParsedTerm): number | undefined {
  if (t.kind !== 'literal' || t.datatype === undefined) return undefined;
  if (!INSTANT_DATATYPES.has(t.datatype)) return undefined;
  const ms = Date.parse(t.value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * SPARQL ORDER BY ordering, shared by ORDER BY and by MIN/MAX.
 *
 * §15.1 orders by kind first — blank nodes, then IRIs, then literals — and only compares
 * VALUES within a kind. Two numeric literals compare numerically; everything else compares
 * by its lexical form.
 */
function compareTerms(a: ParsedTerm, b: ParsedTerm): number {
  const rank = (t: ParsedTerm): number =>
    (t.kind === 'bnode' ? 0 : t.kind === 'iri' ? 1 : t.kind === 'triple' ? 3 : 2);
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  if (isNumericLiteral(a) && isNumericLiteral(b)) {
    const na = Number(a.kind === 'literal' ? a.value : NaN);
    const nb = Number(b.kind === 'literal' ? b.value : NaN);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  }
  const ia = instantOf(a);
  const ib = instantOf(b);
  if (ia !== undefined && ib !== undefined) return ia < ib ? -1 : ia > ib ? 1 : 0;
  const ka = a.kind === 'literal' ? a.value : termKey(a);
  const kb = b.kind === 'literal' ? b.value : termKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The distinct terms of a multiset, in first-seen order. */
function dedupeTerms(terms: readonly ParsedTerm[]): ParsedTerm[] {
  const seen = new Set<string>();
  const out: ParsedTerm[] = [];
  for (const t of terms) {
    const k = termKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** The distinct SOLUTIONS of a group — what `COUNT(DISTINCT *)` counts. */
function dedupeSolutions(rows: readonly Binding[]): Binding[] {
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (const r of rows) {
    const k = JSON.stringify([...r].map(([n, v]) => [n, termKey(v)]).sort());
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function runQuery(doc: ParsedDocument, q: Query, pre: Binding, ctx?: EvalCtx): Binding[] {
  let rows = evalGroups(doc, q.where, [pre], ctx);

  if (q.aggregates.length > 0) {
    const groups = new Map<string, Binding[]>();
    for (const r of rows) {
      const k = JSON.stringify(q.groupBy.map(v => (r.get(v) ? termKey(r.get(v)!) : null)));
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    // ★ AN AGGREGATE OVER NOTHING STILL ANSWERS. §18.5: a query with aggregates and no
    // GROUP BY has exactly ONE group, whether or not the pattern matched — `SELECT
    // (COUNT(?x) AS ?n) WHERE { … }` over an empty result is 0, not "no answer".
    //
    // Returning no rows instead is the failure mode that hides: the caller sees an empty
    // result set and reads it as "the constraint found nothing to complain about". Measured:
    // a SHACL function whose body counts labels returned UNDEFINED for every subject that
    // had none, so the expression that called it silently produced nothing at all.
    if (groups.size === 0 && q.groupBy.length === 0) groups.set('[]', []);
    const out: Binding[] = [];
    for (const [, members] of groups) {
      const b = new Map<string, ParsedTerm>();
      for (const v of q.groupBy) { const t = members[0]?.get(v); if (t) b.set(v, t); }
      for (const agg of q.aggregates) {
        const v = aggregate(agg.fn, agg.arg, members, agg.distinct === true);
        if (v !== undefined) b.set(agg.as, v);
      }
      out.push(b);
    }
    rows = out;
  }

  // ★ EXTEND BEFORE ORDER BY, NOT AFTER. §18.2.4 fixes the order Group -> Aggregation ->
  // Having -> Extend -> OrderBy -> Project -> Distinct -> Slice, and Extend is where
  // `(<expr> AS ?v)` binds. Sorting first left every ORDER BY key that named a computed
  // variable unbound, so the comparator saw undefined on both sides, the sort was a no-op,
  // and a following LIMIT sliced whichever row happened to come first — a wrong answer
  // rather than an unsorted one.
  if (q.computed.length > 0) {
    rows = rows.map(r => {
      const b = new Map(r);
      for (const c of q.computed) {
        const v = evalExpr(doc, c.expr, r, ctx);
        if (v !== undefined) b.set(c.as, v);
      }
      return b;
    });
  }

  if (q.orderBy.length > 0) {
    rows = [...rows].sort((x, y) => {
      for (const { expr, desc } of q.orderBy) {
        const a = evalExpr(doc, expr, x, ctx);
        const c = evalExpr(doc, expr, y, ctx);
        if (a === undefined && c === undefined) continue;
        if (a === undefined) return desc ? 1 : -1;
        if (c === undefined) return desc ? -1 : 1;
        const cmp = compareTerms(a, c);
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (q.project !== undefined || q.aggregates.length > 0 || q.computed.length > 0) {
    const keep = new Set([
      ...(q.project ?? []), ...q.aggregates.map(a => a.as), ...q.computed.map(c => c.as),
    ]);
    rows = rows.map(r => {
      const b = new Map<string, ParsedTerm>();
      for (const [k, v] of r) if (keep.has(k)) b.set(k, v);
      return b;
    });
  }
  if (q.distinct) {
    const seen = new Set<string>();
    rows = rows.filter(r => {
      const k = JSON.stringify([...r.entries()].sort().map(([a, v]) => [a, termKey(v)]));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (q.offset !== undefined) rows = rows.slice(q.offset);
  if (q.limit !== undefined) rows = rows.slice(0, q.limit);
  return rows;
}

// ═══════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════

/** A triple a CONSTRUCT produced. */
export interface ConstructedTriple {
  readonly subject: ParsedTerm;
  readonly predicate: IRI;
  readonly object: ParsedTerm;
}

export interface SparqlQueryResult {
  readonly form: 'SELECT' | 'ASK' | 'CONSTRUCT';
  readonly bindings: readonly Binding[];
  readonly boolean?: boolean;
  /** The instantiated template. Present exactly when the form is CONSTRUCT. */
  readonly triples?: readonly ConstructedTriple[];
  /**
   * The variables the SELECT clause projects, IN ORDER.
   *
   * ★ A CALLER THAT WANTS "the value this query produces" MUST NOT GUESS IT FROM THE
   * BINDINGS. A Binding is a Map in insertion order — the order the evaluator happened to
   * bind things, which is the pattern's order, not the projection's. `SELECT ?person` and
   * `SELECT ?age ?person` can hand back the same Map with different first entries.
   */
  readonly projected?: readonly string[];
}

/**
 * Run a SHACL constraint query against a parsed graph.
 *
 * `preBound` supplies $this and any parameter variables. SHACL's pre-binding forbids a
 * pre-bound variable being re-bound, and that is checked STATICALLY here rather than
 * discovered at evaluation time — the spec requires those queries to be refused, not run.
 *
 * @throws SparqlRefusedError for a malformed query, one using a construct SHACL forbids, or
 *   one calling a function this engine does not implement. Never returns an empty result to
 *   mean "could not run".
 */
export function runSparql(
  doc: ParsedDocument,
  queryText: string,
  prefixes: ReadonlyMap<string, string>,
  preBound: ReadonlyMap<string, ParsedTerm> = new Map(),
  functions: ReadonlyMap<string, UserFunction> = new Map(),
  /** Variables standing for a property path — `PATH` on a property shape. */
  paths: ReadonlyMap<string, SparqlPathNode> = new Map(),
): SparqlQueryResult {
  const { body, prologue, base } = splitPrologue(queryText);
  const all = new Map(prefixes);
  // ★ INLINE PREFIX WINS. SPARQL is last-declaration-wins and the query's own prologue is
  // written after the shapes graph's declarations, so a query that redeclares a prefix means
  // it — node/prefixes-002 exists precisely to check that it is honoured.
  for (const [p, ns] of prologue) all.set(p, ns);

  const toks = tokenize(body, base);
  const query = new Parser(toks, all, new Set(functions.keys()), paths).parseQuery();

  // ★ RE-BINDING A PRE-BOUND VARIABLE IS REFUSED, and the check is static. §5.2.1 permits
  // pre-binding only where the variable is not otherwise bound; `BIND (true AS $this)` is
  // the suite's own example and it must FAIL, not silently take one value or the other.
  const rebound = findRebinding(query.where, new Set(preBound.keys()));
  if (rebound !== undefined) {
    throw new SparqlRefusedError(
      `the query re-binds ?${rebound}, which is pre-bound by SHACL; a pre-bound variable `
      + 'may not be assigned by BIND or projected by a sub-SELECT');
  }

  const rows = runQuery(doc, query, new Map(preBound), { doc, functions, preBound });
  const projected = [
    ...(query.project ?? []), ...query.aggregates.map(a => a.as), ...query.computed.map(c => c.as),
  ];
  if (query.form === 'ASK') return { form: 'ASK', bindings: [], boolean: rows.length > 0 };
  if (query.form === 'CONSTRUCT') {
    return { form: 'CONSTRUCT', bindings: rows, triples: instantiate(query.template ?? [], rows) };
  }
  return { form: 'SELECT', bindings: rows, projected };
}

/**
 * Turn a template plus solutions into triples.
 *
 * ★ AN UNBOUND SLOT DROPS ITS TRIPLE, IT DOES NOT DROP THE SOLUTION. SPARQL §16.2: template
 * triples with an unbound variable are simply not instantiated. A `CONSTRUCT { ?a :p ?b .
 * ?a :q ?c }` whose OPTIONAL never bound `?c` still asserts the first triple — refusing the
 * whole solution would silently narrow the inference.
 *
 * ★ AND A TEMPLATE BLANK NODE IS FRESH PER SOLUTION. `_:x` names one node WITHIN a solution
 * and a different one in the next, which is what makes `CONSTRUCT { _:r rdf:reifies ?t ;
 * ex:source ?s }` produce one reifier per row rather than one reifier for all of them,
 * collapsing every row onto the same node.
 */
function instantiate(
  template: readonly TemplateTriple[], rows: readonly Binding[],
): ConstructedTriple[] {
  const out: ConstructedTriple[] = [];
  let n = 0;
  for (const row of rows) {
    const fresh = new Map<string, ParsedTerm>();
    n++;
    const resolve = (node: Node): ParsedTerm | undefined => {
      if ('var' in node) return row.get(node.var);
      if (node.term.kind === 'bnode') {
        const k = node.term.id;
        let b = fresh.get(k);
        if (b === undefined) { b = { kind: 'bnode', id: `ct${n}_${k}` }; fresh.set(k, b); }
        return b;
      }
      return node.term;
    };
    for (const t of template) {
      const s = resolve(t.s);
      const p = resolve(t.p);
      const o = resolve(t.o);
      if (s === undefined || p === undefined || o === undefined) continue;
      // A literal or a blank node in the predicate position is not a triple; SHACL calls
      // these ill-formed and says to skip them.
      if (p.kind !== 'iri') continue;
      if (s.kind === 'literal') continue;
      out.push({ subject: s, predicate: p.iri, object: o });
    }
  }
  return out;
}

/**
 * Evaluate a BARE SPARQL expression — no query around it.
 *
 * ★ `sh:sparqlExpr "CONCAT($arg0, ' ', $arg1)"` is a whole function body in SHACL, and a
 * parser that only accepts complete queries cannot read one. It is the same expression
 * grammar with no WHERE clause to hang it on, so the entry point is three lines and the
 * alternative — wrapping the text in a synthetic `SELECT (… AS ?x) WHERE {}` — would make
 * every error message describe a query the author never wrote.
 */
export function evaluateSparqlExpression(
  doc: ParsedDocument,
  exprText: string,
  prefixes: ReadonlyMap<string, string>,
  bindings: ReadonlyMap<string, ParsedTerm> = new Map(),
  functions: ReadonlyMap<string, UserFunction> = new Map(),
): ParsedTerm | undefined {
  const { body, prologue, base } = splitPrologue(exprText);
  const all = new Map(prefixes);
  for (const [pfx, ns] of prologue) all.set(pfx, ns);
  const parser = new Parser(tokenize(body, base), all, new Set(functions.keys()));
  const expr = parser.parseBareExpression();
  return evalExpr(doc, expr, new Map(bindings), { doc, functions });
}

function findRebinding(groups: readonly Group[], preBound: ReadonlySet<string>): string | undefined {
  for (const g of groups) {
    if (g.k === 'bind' && preBound.has(g.to)) return g.to;
    if (g.k === 'optional') { const r = findRebinding(g.of, preBound); if (r) return r; }
    if (g.k === 'union') for (const arm of g.arms) { const r = findRebinding(arm, preBound); if (r) return r; }
    if (g.k === 'sub') {
      // ★ PROJECTING A PRE-BOUND VARIABLE THROUGH A SUB-SELECT IS LEGAL, and refusing it
      // was wrong. `{ SELECT $this ?x WHERE { … } }` carries the pre-binding inward, which
      // is the whole reason the spec defines pre-binding as substitution rather than as an
      // initial binding — pre-binding-007 is precisely this and expects a normal report.
      // What is forbidden is ASSIGNING to it, which the bind case above already catches.
      const r = findRebinding(g.query.where, preBound);
      if (r) return r;
      for (const c of g.query.computed) if (preBound.has(c.as)) return c.as;
      for (const a of g.query.aggregates) if (preBound.has(a.as)) return a.as;
    }
  }
  return undefined;
}

/** Split the PREFIX/BASE prologue off the front of a query. */
/**
 * Split the prologue off a query.
 *
 * ★ BASE WAS RECOGNISED AND THEN DISCARDED, which is worse than not parsing it. The regex
 * matched `BASE <…>` and stripped it, but only the PREFIX captures were kept — so a query
 * that declared a base and then wrote `<a>` ran against the IRI `a`, matched nothing, and
 * reported no violations. Recognising a construct and dropping its meaning is the shape of
 * bug this module exists to avoid; the base is returned now and resolved at the tokeniser's
 * single `<…>` site.
 */
function splitPrologue(
  text: string,
): { body: string; prologue: Map<string, string>; base?: string } {
  const prologue = new Map<string, string>();
  let base: string | undefined;
  let rest = text;
  for (;;) {
    const m = /^\s*(?:#[^\n]*\n\s*)*(PREFIX\s+(\S*?):\s*<([^>]*)>|BASE\s*<([^>]*)>)/i.exec(rest);
    if (!m) break;
    if (m[2] !== undefined && m[3] !== undefined) prologue.set(m[2], m[3]);
    if (m[4] !== undefined) base = m[4];
    rest = rest.slice(m[0].length);
  }
  return { body: rest, prologue, ...(base !== undefined ? { base } : {}) };
}

/**
 * Resolve a relative reference against a base, RFC 3986 §5.3.
 *
 * Deliberately NOT `new URL`: the Turtle parser resolves the same way for the same reason —
 * WHATWG normalises the IRI string, and a normalised IRI is a DIFFERENT IRI once anything
 * has signed or hashed the original.
 */
function resolveAgainstBase(ref: string, base: string | undefined): string {
  if (base === undefined || ref === '') return ref;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) return ref;          // already absolute
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/[^/?#]*)?/.exec(base);
  if (!scheme) return ref;
  const authority = `${scheme[1]}${scheme[2] ?? ''}`;
  if (ref.startsWith('//')) return `${scheme[1]}${ref}`;
  if (ref.startsWith('#')) return `${base.split('#')[0] ?? base}${ref}`;
  if (ref.startsWith('?')) return `${(base.split('?')[0] ?? base).split('#')[0] ?? base}${ref}`;
  if (ref.startsWith('/')) return authority + ref;
  const path = (base.slice(authority.length).split('#')[0] ?? '').split('?')[0] ?? '';
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const segments: string[] = [];
  for (const seg of (dir + ref).split('/')) {
    if (seg === '.') continue;
    if (seg === '..') { segments.pop(); continue; }
    segments.push(seg);
  }
  return authority + segments.join('/');
}
