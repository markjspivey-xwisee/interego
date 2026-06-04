/**
 * @module pgsl/sparql-engine
 * @description In-memory triple store and SPARQL executor for PGSL.
 *
 * Materializes the PGSL lattice directly into an indexed triple store
 * (no Turtle round-tripping), then executes SPARQL queries against it.
 *
 * The engine supports the subset of SPARQL 1.1 needed by the existing
 * 16 query generators (5 in rdf.ts, 11 in sparql/patterns.ts):
 *   SELECT, ASK, WHERE triple patterns, OPTIONAL, UNION,
 *   FILTER (comparison, STRSTARTS, BOUND, regex),
 *   GROUP BY, ORDER BY, LIMIT, COUNT/SUM/MAX/MIN aggregates, BIND.
 *
 * Zero runtime dependencies.
 */

import type { PGSLInstance, Atom, Fragment } from './types.js';
import { PGSLClass, PGSLProp } from './rdf.js';
import { pullbackSquare } from './category.js';

// ── RDF Constants ──────────────────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';
const PROV_NS = 'http://www.w3.org/ns/prov#';

// ── Triple Store Types ─────────────────────────────────────

export interface Triple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly datatype?: string;
}

export interface TripleStore {
  triples: Triple[];
  bySubject: Map<string, Triple[]>;
  byPredicate: Map<string, Triple[]>;
  byObject: Map<string, Triple[]>;
}

// ── Triple Store Operations ────────────────────────────────

export function createTripleStore(): TripleStore {
  return {
    triples: [],
    bySubject: new Map(),
    byPredicate: new Map(),
    byObject: new Map(),
  };
}

export function addTriple(store: TripleStore, triple: Triple): void {
  store.triples.push(triple);
  const s = store.bySubject.get(triple.subject);
  if (s) s.push(triple); else store.bySubject.set(triple.subject, [triple]);
  const p = store.byPredicate.get(triple.predicate);
  if (p) p.push(triple); else store.byPredicate.set(triple.predicate, [triple]);
  const o = store.byObject.get(triple.object);
  if (o) o.push(triple); else store.byObject.set(triple.object, [triple]);
}

export function addTriples(store: TripleStore, triples: Triple[]): void {
  for (const t of triples) addTriple(store, t);
}

/**
 * Pattern match triples. Undefined = wildcard.
 */
export function matchPattern(
  store: TripleStore,
  s?: string,
  p?: string,
  o?: string,
): Triple[] {
  // Pick the most selective index
  if (s !== undefined) {
    const candidates = store.bySubject.get(s) ?? [];
    return candidates.filter(t =>
      (p === undefined || t.predicate === p) &&
      (o === undefined || t.object === o)
    );
  }
  if (o !== undefined) {
    const candidates = store.byObject.get(o) ?? [];
    return candidates.filter(t =>
      (p === undefined || t.predicate === p)
    );
  }
  if (p !== undefined) {
    const candidates = store.byPredicate.get(p) ?? [];
    return candidates;
  }
  return store.triples;
}

// ── Materialization ────────────────────────────────────────

function lit(value: string | number | boolean): string {
  if (typeof value === 'string') return `"${value}"`;
  return `"${value}"`;
}

function typedLit(value: number, type: string): string {
  return `"${value}"^^${type}`;
}

/**
 * Materialize a PGSL instance into an in-memory triple store.
 * Produces the same triples as pgslToTurtle() but as structured data.
 */
export function materializeTriples(pgsl: PGSLInstance): TripleStore {
  const store = createTripleStore();

  for (const node of pgsl.nodes.values()) {
    const uri = node.uri;

    if (node.kind === 'Atom') {
      const atom = node as Atom;
      addTriple(store, { subject: uri, predicate: RDF_TYPE, object: PGSLClass.Atom });
      addTriple(store, { subject: uri, predicate: RDF_TYPE, object: `${PROV_NS}Entity` });
      addTriple(store, {
        subject: uri,
        predicate: PGSLProp.value,
        object: lit(atom.value),
        datatype: typeof atom.value === 'string' ? `${XSD_NS}string`
          : typeof atom.value === 'number' ? (Number.isInteger(atom.value) ? `${XSD_NS}integer` : `${XSD_NS}double`)
          : `${XSD_NS}boolean`,
      });
      addTriple(store, {
        subject: uri,
        predicate: PGSLProp.level,
        object: typedLit(0, `${XSD_NS}nonNegativeInteger`),
        datatype: `${XSD_NS}nonNegativeInteger`,
      });
      addTriple(store, { subject: uri, predicate: `${PROV_NS}wasAttributedTo`, object: atom.provenance.wasAttributedTo });
      addTriple(store, {
        subject: uri,
        predicate: `${PROV_NS}generatedAtTime`,
        object: `"${atom.provenance.generatedAtTime}"`,
        datatype: `${XSD_NS}dateTime`,
      });
    } else {
      const frag = node as Fragment;
      addTriple(store, { subject: uri, predicate: RDF_TYPE, object: PGSLClass.Fragment });
      addTriple(store, { subject: uri, predicate: RDF_TYPE, object: `${PROV_NS}Entity` });
      addTriple(store, {
        subject: uri,
        predicate: PGSLProp.level,
        object: typedLit(frag.level, `${XSD_NS}nonNegativeInteger`),
        datatype: `${XSD_NS}nonNegativeInteger`,
      });
      addTriple(store, {
        subject: uri,
        predicate: PGSLProp.height,
        object: typedLit(frag.height, `${XSD_NS}nonNegativeInteger`),
        datatype: `${XSD_NS}nonNegativeInteger`,
      });

      // Individual item links
      for (const item of frag.items) {
        addTriple(store, { subject: uri, predicate: PGSLProp.item, object: item });
      }

      // Constituents
      if (frag.left) addTriple(store, { subject: uri, predicate: PGSLProp.leftConstituent, object: frag.left });
      if (frag.right) addTriple(store, { subject: uri, predicate: PGSLProp.rightConstituent, object: frag.right });

      // Pullback overlap
      const pb = pullbackSquare(pgsl, frag.uri);
      if (pb) {
        addTriple(store, { subject: uri, predicate: PGSLProp.overlap, object: pb.overlap });
      }

      // Provenance
      addTriple(store, { subject: uri, predicate: `${PROV_NS}wasAttributedTo`, object: frag.provenance.wasAttributedTo });
      addTriple(store, {
        subject: uri,
        predicate: `${PROV_NS}generatedAtTime`,
        object: `"${frag.provenance.generatedAtTime}"`,
        datatype: `${XSD_NS}dateTime`,
      });
    }
  }

  return store;
}

// ── SPARQL Types ───────────────────────────────────────────

export interface SparqlPattern {
  subject: string;
  predicate: string;
  object: string;
}

export interface SparqlFilter {
  type: 'comparison' | 'regex' | 'strstarts' | 'bound' | 'not-bound';
  variable: string;
  operator?: string;
  value?: string;
  pattern?: string;
}

export interface SparqlAggregate {
  fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
  variable: string;
  alias: string;
  distinct?: boolean;
}

export interface SparqlQuery {
  type: 'SELECT' | 'ASK';
  variables: string[];
  where: SparqlPattern[];
  optional: SparqlPattern[][];
  union: SparqlPattern[][];
  filters: SparqlFilter[];
  bind: Array<{ variable: string; value: string }>;
  groupBy: string[];
  aggregates: SparqlAggregate[];
  orderBy: Array<{ variable: string; direction: 'ASC' | 'DESC' }>;
  limit?: number;
}

export type Binding = Map<string, string>;

export interface SparqlResult {
  bindings: Binding[];
  boolean?: boolean;
}

// ── SPARQL Parser ──────────────────────────────────────────

const PREFIX_RE = /PREFIX\s+(\w+):\s+<([^>]+)>/gi;
const SELECT_RE = /SELECT\s+((?:DISTINCT\s+)?(?:\?[\w]+\s*|(?:\((?:COUNT|SUM|AVG|MIN|MAX)\([^)]*\)\s+AS\s+\?\w+\)\s*))+|\*)/i;
const ASK_RE = /^[\s\S]*?\bASK\b/i;
const GROUP_BY_RE = /GROUP\s+BY\s+((?:\?\w+\s*)+)/i;
const ORDER_BY_RE = /ORDER\s+BY\s+((?:(?:ASC|DESC)?\s*\(?\?\w+\)?\s*)+)/i;
const LIMIT_RE = /LIMIT\s+(\d+)/i;

/**
 * Parse a SPARQL query string into a structured SparqlQuery.
 * Handles the subset of SPARQL used by the existing generators.
 */
export function parseSparql(queryString: string): SparqlQuery {
  // Well-known prefixes (always available even if not declared)
  const prefixes = new Map<string, string>([
    ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
    ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
    ['xsd', `${XSD_NS}`],
    ['owl', 'http://www.w3.org/2002/07/owl#'],
    ['prov', `${PROV_NS}`],
  ]);
  // Declared prefixes override defaults
  let match;
  while ((match = PREFIX_RE.exec(queryString)) !== null) {
    prefixes.set(match[1]!, match[2]!);
  }

  function expandPrefixed(term: string): string {
    const colonIdx = term.indexOf(':');
    if (colonIdx > 0 && !term.startsWith('http') && !term.startsWith('"')) {
      const prefix = term.substring(0, colonIdx);
      const local = term.substring(colonIdx + 1);
      const ns = prefixes.get(prefix);
      if (ns) return `${ns}${local}`;
    }
    return term;
  }

  // Detect query type
  const isAsk = ASK_RE.test(queryString) && !SELECT_RE.test(queryString);

  // Parse SELECT variables and aggregates
  const aggregates: SparqlAggregate[] = [];
  let variables: string[] = [];

  if (!isAsk) {
    const selectMatch = queryString.match(SELECT_RE);
    if (selectMatch) {
      const selectClause = selectMatch[1]!.trim();
      if (selectClause === '*') {
        variables = ['*'];
      } else {
        // Parse aggregates like (COUNT(DISTINCT ?atom) AS ?atoms)
        const aggRe = /\((\w+)\((DISTINCT\s+)?(\?\w+)\)\s+AS\s+(\?\w+)\)/gi;
        let aggMatch;
        while ((aggMatch = aggRe.exec(selectClause)) !== null) {
          aggregates.push({
            fn: aggMatch[1]!.toUpperCase() as SparqlAggregate['fn'],
            distinct: !!aggMatch[2],
            variable: aggMatch[3]!,
            alias: aggMatch[4]!,
          });
        }
        // Parse regular variables
        const varRe = /\?(\w+)/g;
        const selectWithoutAgg = selectClause.replace(/\([^)]+\)/g, '');
        let varMatch;
        while ((varMatch = varRe.exec(selectWithoutAgg)) !== null) {
          variables.push(`?${varMatch[1]}`);
        }
        // Also add aggregate aliases to variables
        for (const agg of aggregates) {
          if (!variables.includes(agg.alias)) variables.push(agg.alias);
        }
      }
    }
  }

  // Extract WHERE block — handle nested braces
  let whereBlock = '';
  const whereStart = queryString.search(/WHERE\s*\{/i);
  if (whereStart >= 0) {
    const braceStart = queryString.indexOf('{', whereStart);
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < queryString.length; i++) {
      if (queryString[i] === '{') depth++;
      else if (queryString[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    whereBlock = queryString.substring(braceStart + 1, end).trim();
  }

  // Parse the WHERE block into patterns, optionals, unions, filters, binds
  const where: SparqlPattern[] = [];
  const optional: SparqlPattern[][] = [];
  const union: SparqlPattern[][] = [];
  const filters: SparqlFilter[] = [];
  const bind: Array<{ variable: string; value: string }> = [];

  function parsePatterns(block: string): SparqlPattern[] {
    const patterns: SparqlPattern[] = [];
    // Normalize: remove comments, collapse whitespace
    const clean = block.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    // Split on ' . ' (triple terminator), handling semicolons
    const statements = clean.split(/\s*\.\s*/).filter(s => s.trim().length > 0);

    for (const stmt of statements) {
      // Skip FILTER, BIND, OPTIONAL, UNION
      if (/^\s*(FILTER|BIND|OPTIONAL|\{)/i.test(stmt)) continue;
      // Handle semicolons (shared subject)
      const parts = stmt.split(/\s*;\s*/);
      let subject = '';
      for (let i = 0; i < parts.length; i++) {
        const tokens = tokenize(parts[i]!.trim());
        if (tokens.length < 2) continue;
        if (i === 0) {
          if (tokens.length < 3) continue;
          subject = expandTerm(tokens[0]!, expandPrefixed);
          patterns.push({
            subject,
            predicate: expandTerm(tokens[1]!, expandPrefixed),
            object: expandTerm(tokens.slice(2).join(' '), expandPrefixed),
          });
        } else {
          patterns.push({
            subject,
            predicate: expandTerm(tokens[0]!, expandPrefixed),
            object: expandTerm(tokens.slice(1).join(' '), expandPrefixed),
          });
        }
      }
    }
    return patterns;
  }

  // Parse UNION blocks: { ... } UNION { ... }
  const unionRe = /\{([^{}]*?)\}\s*UNION\s*\{([^{}]*?)\}/gi;
  let unionMatch;
  let whereWithoutUnion = whereBlock;
  while ((unionMatch = unionRe.exec(whereBlock)) !== null) {
    union.push(parsePatterns(unionMatch[1]!));
    union.push(parsePatterns(unionMatch[2]!));
    whereWithoutUnion = whereWithoutUnion.replace(unionMatch[0], '');
  }

  // Parse OPTIONAL blocks
  const optRe = /OPTIONAL\s*\{([^{}]*?)\}/gi;
  let optMatch;
  while ((optMatch = optRe.exec(whereWithoutUnion)) !== null) {
    optional.push(parsePatterns(optMatch[1]!));
    whereWithoutUnion = whereWithoutUnion.replace(optMatch[0], '');
  }

  // Parse FILTER expressions
  const filterRe = /FILTER\s*\(([^)]+)\)/gi;
  let filterMatch;
  while ((filterMatch = filterRe.exec(whereWithoutUnion)) !== null) {
    const expr = filterMatch[1]!.trim();
    filters.push(parseFilter(expr, expandPrefixed));
    whereWithoutUnion = whereWithoutUnion.replace(filterMatch[0], '');
  }

  // Parse BIND expressions
  const bindRe = /BIND\s*\(\s*"([^"]*?)"\s+AS\s+(\?\w+)\s*\)/gi;
  let bindMatch;
  while ((bindMatch = bindRe.exec(whereWithoutUnion)) !== null) {
    bind.push({ variable: bindMatch[2]!, value: bindMatch[1]! });
    whereWithoutUnion = whereWithoutUnion.replace(bindMatch[0], '');
  }

  // Parse remaining triple patterns
  where.push(...parsePatterns(whereWithoutUnion));

  // Parse GROUP BY
  const groupBy: string[] = [];
  const groupMatch = queryString.match(GROUP_BY_RE);
  if (groupMatch) {
    const varRe = /\?(\w+)/g;
    let gm;
    while ((gm = varRe.exec(groupMatch[1]!)) !== null) {
      groupBy.push(`?${gm[1]}`);
    }
  }

  // Parse ORDER BY
  const orderBy: Array<{ variable: string; direction: 'ASC' | 'DESC' }> = [];
  const orderMatch = queryString.match(ORDER_BY_RE);
  if (orderMatch) {
    const orderRe = /(ASC|DESC)?\s*\(?(\?\w+)\)?/gi;
    let om;
    while ((om = orderRe.exec(orderMatch[1]!)) !== null) {
      orderBy.push({
        variable: om[2]!,
        direction: (om[1]?.toUpperCase() as 'ASC' | 'DESC') ?? 'ASC',
      });
    }
  }

  // Parse LIMIT
  const limitMatch = queryString.match(LIMIT_RE);
  const limit = limitMatch ? parseInt(limitMatch[1]!, 10) : undefined;

  return {
    type: isAsk ? 'ASK' : 'SELECT',
    variables,
    where,
    optional,
    union,
    filters,
    bind,
    groupBy,
    aggregates,
    orderBy,
    limit,
  };
}

function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inAngle = false;
  let inQuote = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '<' && !inQuote) { inAngle = true; current += ch; continue; }
    if (ch === '>' && inAngle) { inAngle = false; current += ch; tokens.push(current); current = ''; continue; }
    if (ch === '"' && !inAngle) { inQuote = !inQuote; current += ch; continue; }
    if (ch === ' ' && !inAngle && !inQuote) {
      if (current.length > 0) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function expandTerm(term: string, expandPrefixed: (s: string) => string): string {
  if (term.startsWith('<') && term.endsWith('>')) return term.slice(1, -1);
  if (term.startsWith('?')) return term;
  if (term.startsWith('"')) {
    // Expand typed literals: "value"^^prefix:local → "value"^^full-uri
    const typedMatch = term.match(/^(".*?")\^\^(.+)$/);
    if (typedMatch) {
      const expanded = expandPrefixed(typedMatch[2]!);
      return `${typedMatch[1]}^^${expanded}`;
    }
    return term;
  }
  if (term === 'a') return RDF_TYPE;
  return expandPrefixed(term);
}

function parseFilter(expr: string, expandPrefixed: (s: string) => string): SparqlFilter {
  // STRSTARTS(?var, "prefix")
  const startsMatch = expr.match(/STRSTARTS\s*\(\s*(\?\w+)\s*,\s*"([^"]*?)"\s*\)/i);
  if (startsMatch) {
    return { type: 'strstarts', variable: startsMatch[1]!, pattern: startsMatch[2]! };
  }

  // BOUND(?var)
  const boundMatch = expr.match(/BOUND\s*\(\s*(\?\w+)\s*\)/i);
  if (boundMatch) {
    return { type: 'bound', variable: boundMatch[1]! };
  }

  // !BOUND(?var)
  const notBoundMatch = expr.match(/!\s*BOUND\s*\(\s*(\?\w+)\s*\)/i);
  if (notBoundMatch) {
    return { type: 'not-bound', variable: notBoundMatch[1]! };
  }

  // REGEX(?var, "pattern")
  const regexMatch = expr.match(/REGEX\s*\(\s*(\?\w+)\s*,\s*"([^"]*?)"\s*(?:,\s*"([^"]*?)"\s*)?\)/i);
  if (regexMatch) {
    return { type: 'regex', variable: regexMatch[1]!, pattern: regexMatch[2]! };
  }

  // Comparison: ?var op value
  const cmpMatch = expr.match(/(\?\w+)\s*(=|!=|<=?|>=?)\s*(.+)/);
  if (cmpMatch) {
    return {
      type: 'comparison',
      variable: cmpMatch[1]!,
      operator: cmpMatch[2]!,
      value: expandTerm(cmpMatch[3]!.trim(), expandPrefixed),
    };
  }

  // Fallback
  return { type: 'comparison', variable: '?_', operator: '=', value: '' };
}

// ── SPARQL Executor ────────────────────────────────────────

/**
 * Execute a structured SPARQL query against a triple store.
 */
export function executeSparql(store: TripleStore, query: SparqlQuery): SparqlResult {
  // Start with a single empty binding
  let bindings: Binding[] = [new Map()];

  // Apply WHERE triple patterns (conjunctive join)
  for (const pattern of query.where) {
    bindings = joinPattern(store, bindings, pattern);
  }

  // Apply UNION blocks (each block is an alternative)
  if (query.union.length > 0) {
    const unionBindings: Binding[] = [];
    for (const block of query.union) {
      let blockBindings: Binding[] = [new Map()];
      for (const pattern of block) {
        blockBindings = joinPattern(store, blockBindings, pattern);
      }
      // Apply BINDs within union context
      for (const b of query.bind) {
        for (const binding of blockBindings) {
          if (!binding.has(b.variable)) {
            binding.set(b.variable, b.value);
          }
        }
      }
      unionBindings.push(...blockBindings);
    }

    // If there were also regular WHERE patterns, cross-join with union results
    if (query.where.length > 0) {
      const crossed: Binding[] = [];
      for (const wb of bindings) {
        for (const ub of unionBindings) {
          const merged = mergeBindings(wb, ub);
          if (merged) crossed.push(merged);
        }
      }
      bindings = crossed;
    } else {
      bindings = unionBindings;
    }
  }

  // Apply OPTIONAL blocks
  for (const optBlock of query.optional) {
    const extended: Binding[] = [];
    for (const binding of bindings) {
      let optBindings: Binding[] = [new Map(binding)];
      for (const pattern of optBlock) {
        optBindings = joinPattern(store, optBindings, pattern);
      }
      if (optBindings.length > 0) {
        extended.push(...optBindings);
      } else {
        extended.push(binding);
      }
    }
    bindings = extended;
  }

  // Apply BINDs
  for (const b of query.bind) {
    for (const binding of bindings) {
      if (!binding.has(b.variable)) {
        binding.set(b.variable, b.value);
      }
    }
  }

  // Apply FILTERs
  bindings = bindings.filter(binding => {
    return query.filters.every(f => evaluateFilter(f, binding));
  });

  // GROUP BY + aggregates
  if (query.groupBy.length > 0 || query.aggregates.length > 0) {
    bindings = applyGroupBy(bindings, query.groupBy, query.aggregates);
  }

  // ORDER BY
  if (query.orderBy.length > 0) {
    bindings.sort((a, b) => {
      for (const o of query.orderBy) {
        const va = a.get(o.variable) ?? '';
        const vb = b.get(o.variable) ?? '';
        const cmp = compareValues(va, vb);
        if (cmp !== 0) return o.direction === 'ASC' ? cmp : -cmp;
      }
      return 0;
    });
  }

  // LIMIT
  if (query.limit !== undefined) {
    bindings = bindings.slice(0, query.limit);
  }

  // ASK → boolean
  if (query.type === 'ASK') {
    return { bindings: [], boolean: bindings.length > 0 };
  }

  // Filter to requested variables
  if (query.variables.length > 0 && query.variables[0] !== '*') {
    bindings = bindings.map(b => {
      const filtered = new Map<string, string>();
      for (const v of query.variables) {
        const val = b.get(v);
        if (val !== undefined) filtered.set(v, val);
      }
      return filtered;
    });
  }

  return { bindings };
}

function joinPattern(
  store: TripleStore,
  bindings: Binding[],
  pattern: SparqlPattern,
): Binding[] {
  const result: Binding[] = [];

  for (const binding of bindings) {
    const s = pattern.subject.startsWith('?') ? binding.get(pattern.subject) : pattern.subject;
    const p = pattern.predicate.startsWith('?') ? binding.get(pattern.predicate) : pattern.predicate;
    const o = pattern.object.startsWith('?') ? binding.get(pattern.object) : pattern.object;

    const matches = matchPattern(store, s, p, o);

    for (const triple of matches) {
      const newBinding = new Map(binding);
      let compatible = true;

      if (pattern.subject.startsWith('?')) {
        const existing = binding.get(pattern.subject);
        if (existing !== undefined && existing !== triple.subject) { compatible = false; }
        else newBinding.set(pattern.subject, triple.subject);
      }
      if (pattern.predicate.startsWith('?')) {
        const existing = binding.get(pattern.predicate);
        if (existing !== undefined && existing !== triple.predicate) { compatible = false; }
        else newBinding.set(pattern.predicate, triple.predicate);
      }
      if (pattern.object.startsWith('?')) {
        const existing = binding.get(pattern.object);
        if (existing !== undefined && existing !== triple.object) { compatible = false; }
        else newBinding.set(pattern.object, triple.object);
      }

      if (compatible) result.push(newBinding);
    }
  }

  return result;
}

function mergeBindings(a: Binding, b: Binding): Binding | null {
  const merged = new Map(a);
  for (const [k, v] of b) {
    const existing = merged.get(k);
    if (existing !== undefined && existing !== v) return null;
    merged.set(k, v);
  }
  return merged;
}

function evaluateFilter(filter: SparqlFilter, binding: Binding): boolean {
  const val = binding.get(filter.variable);

  switch (filter.type) {
    case 'bound':
      return val !== undefined;
    case 'not-bound':
      return val === undefined;
    case 'strstarts':
      return val !== undefined && stripQuotes(val).startsWith(filter.pattern!);
    case 'regex':
      return val !== undefined && new RegExp(filter.pattern!).test(stripQuotes(val));
    case 'comparison': {
      if (val === undefined) return false;
      const numVal = extractNumber(val);
      const numFilter = extractNumber(filter.value!);
      const cmp = (!isNaN(numVal) && !isNaN(numFilter))
        ? numVal - numFilter
        : stripQuotes(val).localeCompare(stripQuotes(filter.value!));
      switch (filter.operator) {
        case '=': return cmp === 0;
        case '!=': return cmp !== 0;
        case '<': return cmp < 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '>=': return cmp >= 0;
        default: return false;
      }
    }
    default:
      return true;
  }
}

function stripQuotes(s: string): string {
  if (s.startsWith('"')) {
    const endQuote = s.indexOf('"', 1);
    if (endQuote > 0) return s.substring(1, endQuote);
  }
  return s;
}

function extractNumber(s: string): number {
  const stripped = stripQuotes(s);
  const n = parseFloat(stripped);
  return n;
}

function compareValues(a: string, b: string): number {
  const na = extractNumber(a);
  const nb = extractNumber(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return stripQuotes(a).localeCompare(stripQuotes(b));
}

function applyGroupBy(
  bindings: Binding[],
  groupBy: string[],
  aggregates: SparqlAggregate[],
): Binding[] {
  if (groupBy.length === 0 && aggregates.length > 0) {
    // Aggregate over all bindings (no grouping)
    const result = new Map<string, string>();
    for (const agg of aggregates) {
      result.set(agg.alias, computeAggregate(agg, bindings));
    }
    return [result];
  }

  // Group by key
  const groups = new Map<string, Binding[]>();
  for (const binding of bindings) {
    const key = groupBy.map(v => binding.get(v) ?? '').join('|||');
    const group = groups.get(key);
    if (group) group.push(binding);
    else groups.set(key, [binding]);
  }

  // Compute aggregates per group
  const result: Binding[] = [];
  for (const [, group] of groups) {
    const binding = new Map(group[0]!);
    for (const agg of aggregates) {
      binding.set(agg.alias, computeAggregate(agg, group));
    }
    result.push(binding);
  }
  return result;
}

function computeAggregate(agg: SparqlAggregate, bindings: Binding[]): string {
  let values = bindings.map(b => b.get(agg.variable)).filter((v): v is string => v !== undefined);
  if (agg.distinct) {
    values = [...new Set(values)];
  }

  switch (agg.fn) {
    case 'COUNT':
      return `"${values.length}"`;
    case 'SUM': {
      const sum = values.reduce((s, v) => s + extractNumber(v), 0);
      return `"${sum}"`;
    }
    case 'AVG': {
      if (values.length === 0) return `"0"`;
      const avg = values.reduce((s, v) => s + extractNumber(v), 0) / values.length;
      return `"${avg}"`;
    }
    case 'MAX': {
      if (values.length === 0) return `""`;
      return values.reduce((max, v) => compareValues(v, max) > 0 ? v : max);
    }
    case 'MIN': {
      if (values.length === 0) return `""`;
      return values.reduce((min, v) => compareValues(v, min) < 0 ? v : min);
    }
  }
}

// ── Convenience Functions ──────────────────────────────────

/**
 * Parse and execute a SPARQL query string against a triple store.
 */
export function executeSparqlString(store: TripleStore, queryString: string): SparqlResult {
  const query = parseSparql(queryString);
  return executeSparql(store, query);
}

// Cache triple stores per PGSL instance
const tripleStoreCache = new WeakMap<PGSLInstance, TripleStore>();

/**
 * Execute a SPARQL query against a PGSL instance.
 * Materializes the triple store on first call, caches for subsequent queries.
 */
export function sparqlQueryPGSL(pgsl: PGSLInstance, queryString: string): SparqlResult {
  let store = tripleStoreCache.get(pgsl);
  if (!store) {
    store = materializeTriples(pgsl);
    tripleStoreCache.set(pgsl, store);
  }
  return executeSparqlString(store, queryString);
}
