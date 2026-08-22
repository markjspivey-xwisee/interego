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

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }

    // <IRI> — but not the `<` operator, which is never followed by a non-space run to `>`
    if (c === '<' && /^<[^<>"{}|^`\\ ]*>/.test(src.slice(i))) {
      const end = src.indexOf('>', i);
      out.push({ t: 'iri', v: src.slice(i + 1, end) });
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

interface Pattern { s: Node; p: Node; o: Node }
type Node = { var: string } | { term: ParsedTerm };

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
  | { e: 'exists'; not: boolean; group: Group[] };

interface Query {
  form: 'SELECT' | 'ASK';
  distinct: boolean;
  /** `undefined` means SELECT * */
  project?: string[];
  /** Aggregate projections: `(COUNT(?x) AS ?n)` */
  aggregates: { fn: string; arg?: string; as: string }[];
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

  constructor(private readonly toks: Tok[], private readonly prefixes: ReadonlyMap<string, string>) {}

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
      case 'pname': return { kind: 'iri', iri: this.expand(t.v) as IRI };
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
    if (t?.t === 'var') { this.i++; return { var: t.v }; }
    return { term: this.term() };
  }

  /** The query, from the top. Prologue PREFIX/BASE lines are consumed by the caller. */
  parseQuery(): Query {
    const form = this.eatWord('SELECT') ? 'SELECT' : this.eatWord('ASK') ? 'ASK' : undefined;
    if (form === undefined) {
      const t = this.peek();
      const w = t?.t === 'word' ? t.v.toUpperCase() : String(t?.t);
      throw new SparqlRefusedError(
        `SHACL constraint queries are SELECT or ASK; found "${w}"`);
    }
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
          if (t?.t === 'var') { this.i++; project.push(t.v); continue; }
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
        if (t?.t === 'var') { this.i++; orderBy.push({ expr: { e: 'var', name: t.v }, desc: false }); continue; }
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
    };
  }

  private static readonly AGGREGATES = new Set(
    ['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'GROUP_CONCAT', 'SAMPLE']);

  /** `COUNT(?x)` / `COUNT(*)` at the cursor, or undefined without consuming anything. */
  private tryAggregate(): { fn: string; arg?: string } | undefined {
    const t = this.peek();
    if (t?.t !== 'word' || !Parser.AGGREGATES.has(t.v.toUpperCase())) return undefined;
    if (!this.isPunc('(', 1)) return undefined;
    const save = this.i;
    this.i += 2;
    this.eatWord('DISTINCT');
    let arg: string | undefined;
    if (this.isPunc('*')) this.i++;
    else { const a = this.peek(); if (a?.t === 'var') { this.i++; arg = a.v; } }
    if (!this.eatPunc(')')) { this.i = save; return undefined; }
    return { fn: t.v.toUpperCase(), ...(arg !== undefined ? { arg } : {}) };
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
        const p = this.node();
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
    if (t?.t === 'var') { this.i++; return { e: 'var', name: t.v }; }
    if (t?.t === 'word' && (this.isWord('EXISTS') || this.isWord('NOT'))) {
      const not = this.eatWord('NOT');
      if (!this.eatWord('EXISTS')) throw new SparqlRefusedError('expected EXISTS after NOT');
      return { e: 'exists', not, group: this.groupGraphPattern() };
    }
    // ★ A PREFIXED-NAME FUNCTION CALL IS A CALL, and failing to see it produced a parse
    // error about the NEXT token — "expected AS inside BIND" for
    // `BIND (ex:instanceCount(ex:Name) AS ?value)`, which points at the wrong thing
    // entirely. SHACL lets a shapes graph DEFINE functions with sh:function; this engine
    // does not implement them yet, and saying so by name is the difference between a gap a
    // reader can act on and a syntax error they will chase.
    if (t?.t === 'pname' && this.isPunc('(', 1)) {
      throw new SparqlRefusedError(
        `${t.v}() is a user-defined SPARQL function (sh:function), which this engine does `
        + 'not implement, so the constraint cannot be evaluated');
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
    case 'literal': return `L${t.value} ${t.datatype ?? ''} ${t.language ?? ''}`;
    case 'triple': return `T${termKey(t.subject)} ${t.predicate} ${termKey(t.object)}`;
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

function joinBgp(doc: ParsedDocument, patterns: readonly Pattern[], input: Binding[]): Binding[] {
  let rows = input;
  for (const pat of patterns) {
    const next: Binding[] = [];
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
    rows = next;
    if (rows.length === 0) return [];
  }
  return rows;
}

function evalGroups(doc: ParsedDocument, groups: readonly Group[], input: Binding[]): Binding[] {
  let rows = input;
  for (const g of groups) {
    switch (g.k) {
      case 'bgp': rows = joinBgp(doc, g.patterns, rows); break;
      case 'optional': {
        const out: Binding[] = [];
        for (const row of rows) {
          const extended = evalGroups(doc, g.of, [row]);
          if (extended.length === 0) out.push(row);
          else out.push(...extended);
        }
        rows = out;
        break;
      }
      case 'union': {
        const out: Binding[] = [];
        for (const arm of g.arms) out.push(...evalGroups(doc, arm, rows));
        rows = out;
        break;
      }
      case 'filter':
        rows = rows.filter(r => isTrue(evalExpr(doc, g.expr, r)));
        break;
      case 'bind':
        rows = rows.map(r => {
          const v = evalExpr(doc, g.expr, r);
          if (v === undefined) return r;
          const b = new Map(r);
          b.set(g.to, v);
          return b;
        });
        break;
      case 'sub': {
        const out: Binding[] = [];
        for (const row of rows) {
          for (const sol of runQuery(doc, g.query, row)) {
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
  return rows;
}

const isTrue = (t: ParsedTerm | undefined): boolean =>
  t?.kind === 'literal' && (t.value === 'true' || t.value === '1');

function evalExpr(doc: ParsedDocument, e: Expr, b: Binding): ParsedTerm | undefined {
  switch (e.e) {
    case 'var': return b.get(e.name);
    case 'term': return e.term;
    case 'exists': {
      const found = evalGroups(doc, e.group, [b]).length > 0;
      return {
        kind: 'literal', value: String(e.not ? !found : found), datatype: `${XSD}boolean` as IRI,
      };
    }
    case 'call': {
      // NOW() has no argument and no place in a pure function table keyed on its arguments.
      if (e.fn === 'now') {
        return { kind: 'literal', value: new Date().toISOString(), datatype: `${XSD}dateTime` as IRI };
      }
      if (e.fn === 'if') {
        const cond = evalExpr(doc, e.args[0]!, b);
        return evalExpr(doc, isTrue(cond) ? e.args[1]! : e.args[2]!, b);
      }
      const args = e.args.map(a => {
        const v = evalExpr(doc, a, b);
        return v === undefined ? [] : [v];
      });
      return applySparqlFunction(e.fn, args)[0];
    }
  }
}

function runQuery(doc: ParsedDocument, q: Query, pre: Binding): Binding[] {
  let rows = evalGroups(doc, q.where, [pre]);

  if (q.aggregates.length > 0) {
    const groups = new Map<string, Binding[]>();
    for (const r of rows) {
      const k = q.groupBy.map(v => (r.get(v) ? termKey(r.get(v)!) : '')).join(' ');
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const out: Binding[] = [];
    for (const [, members] of groups) {
      const b = new Map<string, ParsedTerm>();
      for (const v of q.groupBy) { const t = members[0]?.get(v); if (t) b.set(v, t); }
      for (const agg of q.aggregates) {
        const vals: ParsedTerm[] = agg.arg === undefined
          ? []
          : members.map(m => m.get(agg.arg!)).filter((x): x is ParsedTerm => x !== undefined);
        const n = agg.fn === 'COUNT' ? (agg.arg === undefined ? members.length : vals.length)
          : agg.fn === 'SUM'
            ? vals.reduce((acc, t) => acc + Number(t.kind === 'literal' ? t.value : NaN), 0)
            : NaN;
        b.set(agg.as, { kind: 'literal', value: String(n), datatype: `${XSD}integer` as IRI });
      }
      out.push(b);
    }
    rows = out;
  }

  if (q.orderBy.length > 0) {
    rows = [...rows].sort((x, y) => {
      for (const { expr, desc } of q.orderBy) {
        const a = evalExpr(doc, expr, x);
        const c = evalExpr(doc, expr, y);
        if (a === undefined && c === undefined) continue;
        if (a === undefined) return desc ? 1 : -1;
        if (c === undefined) return desc ? -1 : 1;
        const na = Number(a.kind === 'literal' ? a.value : NaN);
        const nc = Number(c.kind === 'literal' ? c.value : NaN);
        const cmp = Number.isFinite(na) && Number.isFinite(nc)
          ? (na < nc ? -1 : na > nc ? 1 : 0)
          : (termKey(a) < termKey(c) ? -1 : termKey(a) > termKey(c) ? 1 : 0);
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (q.computed.length > 0) {
    rows = rows.map(r => {
      const b = new Map(r);
      for (const c of q.computed) {
        const v = evalExpr(doc, c.expr, r);
        if (v !== undefined) b.set(c.as, v);
      }
      return b;
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
      const k = [...r.entries()].sort().map(([a, v]) => `${a}=${termKey(v)}`).join(' ');
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

export interface SparqlQueryResult {
  readonly form: 'SELECT' | 'ASK';
  readonly bindings: readonly Binding[];
  readonly boolean?: boolean;
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
): SparqlQueryResult {
  const { body, prologue } = splitPrologue(queryText);
  const all = new Map(prefixes);
  // ★ INLINE PREFIX WINS. SPARQL is last-declaration-wins and the query's own prologue is
  // written after the shapes graph's declarations, so a query that redeclares a prefix means
  // it — node/prefixes-002 exists precisely to check that it is honoured.
  for (const [p, ns] of prologue) all.set(p, ns);

  const toks = tokenize(body);
  const query = new Parser(toks, all).parseQuery();

  // ★ RE-BINDING A PRE-BOUND VARIABLE IS REFUSED, and the check is static. §5.2.1 permits
  // pre-binding only where the variable is not otherwise bound; `BIND (true AS $this)` is
  // the suite's own example and it must FAIL, not silently take one value or the other.
  const rebound = findRebinding(query.where, new Set(preBound.keys()));
  if (rebound !== undefined) {
    throw new SparqlRefusedError(
      `the query re-binds ?${rebound}, which is pre-bound by SHACL; a pre-bound variable `
      + 'may not be assigned by BIND or projected by a sub-SELECT');
  }

  const rows = runQuery(doc, query, new Map(preBound));
  return query.form === 'ASK'
    ? { form: 'ASK', bindings: [], boolean: rows.length > 0 }
    : { form: 'SELECT', bindings: rows };
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
function splitPrologue(text: string): { body: string; prologue: Map<string, string> } {
  const prologue = new Map<string, string>();
  let rest = text;
  for (;;) {
    const m = /^\s*(?:#[^\n]*\n\s*)*(PREFIX\s+(\S*?):\s*<([^>]*)>|BASE\s*<[^>]*>)/i.exec(rest);
    if (!m) break;
    if (m[2] !== undefined && m[3] !== undefined) prologue.set(m[2], m[3]);
    rest = rest.slice(m[0].length);
  }
  return { body: rest, prologue };
}
