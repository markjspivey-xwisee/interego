/**
 * Minimal TriG / Turtle parser focused on subject-property extraction.
 *
 * Scope (deliberately narrow):
 *   - @prefix declarations
 *   - Graph blocks   { ... }
 *   - Triples         s p o ;  s p o , o2 ;
 *   - Subjects:       <iri> | prefixed:name | blank node "[ ]" (skipped)
 *   - Predicates:     <iri> | prefixed:name | the keyword "a"
 *   - Objects:        <iri> | prefixed:name | "string" (with optional ^^datatype or @lang)
 *                     | "string"-style triple-quoted | integer | decimal | boolean | nested [ ... ]
 *
 * NOT supported (intentional):
 *   - Lists ( ... )
 *   - Annotation syntax {| ... |}
 *   - @base / relative IRI resolution
 *   - SPARQL UPDATE operations
 *
 * Adequate for the substrate's typed-descriptor extraction surface
 * (constraint discovery, ontology introspection). For full Turtle we'd
 * use an external parser; the project keeps zero runtime deps.
 *
 * Implementation: tokenizer that is comment-aware and string/IRI-safe,
 * followed by a recursive-descent walk that records subject → predicate
 * → list-of-objects.
 */
import type { IRI } from '../model/types.js';

export interface ParsedLiteral {
  readonly kind: 'literal';
  readonly value: string;
  readonly datatype?: IRI;
  readonly language?: string;
}

export interface ParsedIri {
  readonly kind: 'iri';
  readonly iri: IRI;
}

export interface ParsedBNode {
  readonly kind: 'bnode';
  readonly id: string;
}

export type ParsedTerm = ParsedLiteral | ParsedIri | ParsedBNode;

export interface ParsedSubject {
  readonly subject: IRI | { readonly bnode: string };
  readonly properties: ReadonlyMap<IRI, readonly ParsedTerm[]>;
}

export interface ParsedDocument {
  readonly prefixes: ReadonlyMap<string, string>;
  readonly subjects: readonly ParsedSubject[];
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' as IRI;

class ParseError extends Error {
  constructor(message: string, public readonly position: number) {
    super(`${message} at offset ${position}`);
    this.name = 'ParseError';
  }
}

/**
 * Tokenize. Returns an array of tokens; whitespace and comments are
 * skipped. Tokens preserve enough information to reconstruct semantic
 * meaning without rescanning.
 */
type Tok =
  | { type: 'iri'; value: string; pos: number }
  | { type: 'pname'; prefix: string; local: string; pos: number }
  | { type: 'bnode'; id: string; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'number'; value: string; pos: number }
  | { type: 'boolean'; value: boolean; pos: number }
  | { type: 'punct'; value: string; pos: number }   // . ; , [ ] { } ( ) ^^ @
  | { type: 'keyword'; value: string; pos: number } // a, true, false, prefix, base
  | { type: 'lang'; value: string; pos: number };   // @en, @en-US

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // Comments — only outside strings/IRIs (we are at top level here)
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    const startPos = i;

    // IRI <...>  (may not contain unescaped > or whitespace per Turtle; we forgive whitespace gently)
    if (c === '<') {
      i++;
      let value = '';
      while (i < n && src[i] !== '>') {
        // Permit Turtle UCHAR escapes \uXXXX / \UXXXXXXXX literally; we just pass through
        if (src[i] === '\\' && i + 1 < n) {
          value += src[i]! + src[i + 1]!;
          i += 2;
        } else {
          value += src[i]!;
          i++;
        }
      }
      if (i >= n) throw new ParseError('unterminated IRI', startPos);
      i++; // consume >
      out.push({ type: 'iri', value, pos: startPos });
      continue;
    }

    // String literal — supports "..." and """..."""
    if (c === '"') {
      let value = '';
      let triple = false;
      let closed = false;
      if (src.slice(i, i + 3) === '"""') { triple = true; i += 3; } else { i++; }
      while (i < n) {
        if (triple) {
          if (src.slice(i, i + 3) === '"""') { i += 3; closed = true; break; }
        } else {
          if (src[i] === '"') { i++; closed = true; break; }
          if (src[i] === '\n' || src[i] === '\r') {
            throw new ParseError('unterminated single-line string', startPos);
          }
        }
        if (src[i] === '\\' && i + 1 < n) {
          const esc = src[i + 1]!;
          switch (esc) {
            case 't': value += '\t'; break;
            case 'n': value += '\n'; break;
            case 'r': value += '\r'; break;
            case '"': value += '"'; break;
            case "'": value += "'"; break;
            case '\\': value += '\\'; break;
            default: value += esc;
          }
          i += 2;
        } else {
          value += src[i]!;
          i++;
        }
      }
      if (!closed) throw new ParseError('unterminated string at EOF', startPos);
      out.push({ type: 'string', value, pos: startPos });
      continue;
    }

    // Punctuation
    if (c === '.' || c === ';' || c === ',' || c === '[' || c === ']' || c === '{' || c === '}' || c === '(' || c === ')') {
      // Disambiguate '.' as triple terminator vs decimal — handled below for numbers
      // If it's a standalone token we emit it; numbers consume it inline.
      i++;
      out.push({ type: 'punct', value: c, pos: startPos });
      continue;
    }

    // ^^ datatype marker
    if (c === '^' && src[i + 1] === '^') {
      i += 2;
      out.push({ type: 'punct', value: '^^', pos: startPos });
      continue;
    }

    // @prefix / @base / language tag
    if (c === '@') {
      i++;
      let id = '';
      while (i < n && /[A-Za-z0-9-]/.test(src[i]!)) { id += src[i]!; i++; }
      if (id === 'prefix' || id === 'base') {
        out.push({ type: 'keyword', value: id, pos: startPos });
      } else {
        out.push({ type: 'lang', value: id, pos: startPos });
      }
      continue;
    }

    // Blank node label  _:label
    if (c === '_' && src[i + 1] === ':') {
      i += 2;
      let id = '';
      while (i < n && /[A-Za-z0-9_-]/.test(src[i]!)) { id += src[i]!; i++; }
      out.push({ type: 'bnode', id, pos: startPos });
      continue;
    }

    // Number — leading digit, optional sign was here already handled via punct? sign-prefixed numbers:
    if (c === '-' || c === '+' || (c >= '0' && c <= '9')) {
      let s = '';
      if (c === '-' || c === '+') { s += c; i++; }
      let sawDigit = false;
      while (i < n && src[i]! >= '0' && src[i]! <= '9') { s += src[i]!; i++; sawDigit = true; }
      if (src[i] === '.' && i + 1 < n && src[i + 1]! >= '0' && src[i + 1]! <= '9') {
        s += '.'; i++;
        while (i < n && src[i]! >= '0' && src[i]! <= '9') { s += src[i]!; i++; }
      }
      if (src[i] === 'e' || src[i] === 'E') {
        s += src[i]!; i++;
        if (src[i] === '+' || src[i] === '-') { s += src[i]!; i++; }
        while (i < n && src[i]! >= '0' && src[i]! <= '9') { s += src[i]!; i++; }
      }
      if (!sawDigit) {
        // Bare '-' or '+' wasn't a number. Treat as part of a name fall-through.
        // Roll back; emit as part of pname/keyword path.
        i = startPos;
      } else {
        out.push({ type: 'number', value: s, pos: startPos });
        continue;
      }
    }

    // Prefixed name: prefix:local | :local | true | false | a (keyword)
    // Identifier-ish characters per Turtle PN_LOCAL — we accept a permissive subset.
    const idStart = /[A-Za-z_]/;
    const idCont = /[A-Za-z0-9_.-]/;
    if (idStart.test(c) || c === ':') {
      let prefix = '';
      let local = '';
      if (c !== ':') {
        while (i < n && idCont.test(src[i]!)) { prefix += src[i]!; i++; }
      }
      if (src[i] === ':') {
        i++; // consume colon
        while (i < n && (idCont.test(src[i]!) || src[i] === '%' || src[i] === '/')) {
          local += src[i]!;
          i++;
        }
        // Strip trailing '.' which is more likely a triple terminator than part of local
        while (local.endsWith('.')) {
          local = local.slice(0, -1);
          i--;
        }
        out.push({ type: 'pname', prefix, local, pos: startPos });
        continue;
      }
      // No colon → it's a bareword (keyword)
      if (prefix === 'a') { out.push({ type: 'keyword', value: 'a', pos: startPos }); continue; }
      if (prefix === 'true') { out.push({ type: 'boolean', value: true, pos: startPos }); continue; }
      if (prefix === 'false') { out.push({ type: 'boolean', value: false, pos: startPos }); continue; }
      if (prefix === 'PREFIX' || prefix === 'BASE') {
        // SPARQL-style; treat as keyword variant
        out.push({ type: 'keyword', value: prefix.toLowerCase(), pos: startPos });
        continue;
      }
      throw new ParseError(`unknown bareword "${prefix}"`, startPos);
    }

    throw new ParseError(`unexpected character '${c}'`, startPos);
  }

  return out;
}

interface ParserState {
  readonly tokens: readonly Tok[];
  index: number;
  readonly prefixes: Map<string, string>;
  readonly subjects: Map<string, Map<IRI, ParsedTerm[]>>;
  readonly bnodeProperties: Map<string, Map<IRI, ParsedTerm[]>>;
  bnodeCounter: number;
}

function peek(s: ParserState, offset = 0): Tok | undefined { return s.tokens[s.index + offset]; }
function consume(s: ParserState): Tok | undefined { return s.tokens[s.index++]; }
function expectPunct(s: ParserState, value: string): void {
  const t = consume(s);
  if (!t || t.type !== 'punct' || t.value !== value) {
    throw new ParseError(`expected '${value}', got ${t ? `${t.type}/${(t as any).value ?? ''}` : 'EOF'}`, t?.pos ?? -1);
  }
}

function resolvePrefixed(s: ParserState, prefix: string, local: string): IRI {
  const base = s.prefixes.get(prefix);
  if (base === undefined) {
    throw new ParseError(`unknown prefix "${prefix}:"`, -1);
  }
  return (base + local) as IRI;
}

function parseTermAsTerm(s: ParserState): ParsedTerm {
  const t = peek(s);
  if (!t) throw new ParseError('expected term, got EOF', -1);

  if (t.type === 'iri') { consume(s); return { kind: 'iri', iri: t.value as IRI }; }
  if (t.type === 'pname') { consume(s); return { kind: 'iri', iri: resolvePrefixed(s, t.prefix, t.local) }; }
  if (t.type === 'bnode') { consume(s); return { kind: 'bnode', id: t.id }; }
  if (t.type === 'string') {
    consume(s);
    let datatype: IRI | undefined;
    let language: string | undefined;
    const next = peek(s);
    if (next?.type === 'punct' && next.value === '^^') {
      consume(s);
      const dt = consume(s);
      if (!dt) throw new ParseError('expected datatype IRI after ^^', t.pos);
      if (dt.type === 'iri') datatype = dt.value as IRI;
      else if (dt.type === 'pname') datatype = resolvePrefixed(s, dt.prefix, dt.local);
      else throw new ParseError('expected IRI for datatype', dt.pos);
    } else if (next?.type === 'lang') {
      consume(s);
      language = next.value;
    }
    return { kind: 'literal', value: t.value, datatype, language };
  }
  if (t.type === 'number') {
    consume(s);
    const dt = t.value.includes('.') || /[eE]/.test(t.value)
      ? 'http://www.w3.org/2001/XMLSchema#decimal'
      : 'http://www.w3.org/2001/XMLSchema#integer';
    return { kind: 'literal', value: t.value, datatype: dt as IRI };
  }
  if (t.type === 'boolean') {
    consume(s);
    return { kind: 'literal', value: t.value ? 'true' : 'false', datatype: 'http://www.w3.org/2001/XMLSchema#boolean' as IRI };
  }
  if (t.type === 'punct' && t.value === '[') {
    // Inline blank node: collect its property list, then return a bnode reference
    consume(s);
    const id = `_anon${s.bnodeCounter++}`;
    const props = new Map<IRI, ParsedTerm[]>();
    s.bnodeProperties.set(id, props);
    parsePropertyList(s, props);
    expectPunct(s, ']');
    return { kind: 'bnode', id };
  }
  throw new ParseError(`unexpected token type "${t.type}"`, t.pos);
}

function parsePredicate(s: ParserState): IRI {
  const t = consume(s);
  if (!t) throw new ParseError('expected predicate, got EOF', -1);
  if (t.type === 'iri') return t.value as IRI;
  if (t.type === 'pname') return resolvePrefixed(s, t.prefix, t.local);
  if (t.type === 'keyword' && t.value === 'a') return RDF_TYPE;
  throw new ParseError(`expected predicate, got ${t.type}`, t.pos);
}

function parseSubject(s: ParserState): { key: string; props: Map<IRI, ParsedTerm[]> } {
  const t = peek(s);
  if (!t) throw new ParseError('expected subject', -1);
  if (t.type === 'iri') {
    consume(s);
    const key = t.value;
    if (!s.subjects.has(key)) s.subjects.set(key, new Map());
    return { key, props: s.subjects.get(key)! };
  }
  if (t.type === 'pname') {
    consume(s);
    const key = resolvePrefixed(s, t.prefix, t.local);
    if (!s.subjects.has(key)) s.subjects.set(key, new Map());
    return { key, props: s.subjects.get(key)! };
  }
  if (t.type === 'bnode') {
    consume(s);
    const key = `_:${t.id}`;
    if (!s.subjects.has(key)) s.subjects.set(key, new Map());
    return { key, props: s.subjects.get(key)! };
  }
  if (t.type === 'punct' && t.value === '[') {
    consume(s);
    const id = `_anon${s.bnodeCounter++}`;
    const key = `_:${id}`;
    const props = new Map<IRI, ParsedTerm[]>();
    s.subjects.set(key, props);
    parsePropertyList(s, props);
    expectPunct(s, ']');
    return { key, props };
  }
  throw new ParseError(`expected subject, got ${t.type}`, t.pos);
}

function parsePropertyList(s: ParserState, props: Map<IRI, ParsedTerm[]>): void {
  // predicate object (',' object)* (';' predicate object (',' object)*)* ';'?
  while (true) {
    const next = peek(s);
    if (!next) return;
    if (next.type === 'punct' && (next.value === ']' || next.value === '.' || next.value === '}')) return;
    if (next.type === 'punct' && next.value === ';') { consume(s); continue; }

    const predicate = parsePredicate(s);
    while (true) {
      const term = parseTermAsTerm(s);
      const list = props.get(predicate);
      if (list) list.push(term); else props.set(predicate, [term]);
      const after = peek(s);
      if (after?.type === 'punct' && after.value === ',') { consume(s); continue; }
      break;
    }
  }
}

function parseTriplesBlock(s: ParserState): void {
  // subject propertyList .
  const { props } = parseSubject(s);
  parsePropertyList(s, props);
  const end = peek(s);
  if (end?.type === 'punct' && end.value === '.') consume(s);
}

/**
 * Public entry point. Parses TriG / Turtle input and returns:
 *   - the prefix table that was declared
 *   - one ParsedSubject per subject IRI (or blank node) encountered
 *
 * Multiple appearances of the same subject merge their property lists.
 * Blank node property lists are NOT inlined into their parent — they
 * appear as separate ParsedSubject entries keyed by `_:<id>`.
 */
export function parseTrig(src: string): ParsedDocument {
  const tokens = tokenize(src);
  const state: ParserState = {
    tokens,
    index: 0,
    prefixes: new Map(),
    subjects: new Map(),
    bnodeProperties: new Map(),
    bnodeCounter: 0,
  };

  while (state.index < tokens.length) {
    const t = peek(state)!;

    // Directive: @prefix prefix: <iri> .
    if (t.type === 'keyword' && t.value === 'prefix') {
      consume(state);
      const nameTok = consume(state);
      if (!nameTok || nameTok.type !== 'pname') {
        throw new ParseError('expected "prefix:" after @prefix', nameTok?.pos ?? -1);
      }
      const iriTok = consume(state);
      if (!iriTok || iriTok.type !== 'iri') {
        throw new ParseError('expected IRI for prefix value', iriTok?.pos ?? -1);
      }
      state.prefixes.set(nameTok.prefix, iriTok.value);
      const dot = consume(state);
      if (!dot || dot.type !== 'punct' || dot.value !== '.') {
        throw new ParseError('expected "." after @prefix declaration', dot?.pos ?? -1);
      }
      continue;
    }

    if (t.type === 'keyword' && t.value === 'base') {
      // Skip @base — we don't resolve relative IRIs in this parser
      consume(state);
      consume(state); // the IRI
      const dot = consume(state);
      if (dot?.type !== 'punct' || dot.value !== '.') {
        // best-effort: don't fail hard
      }
      continue;
    }

    // Graph block: <iri> { triples } | prefix:name { triples }
    if (t.type === 'iri' || t.type === 'pname') {
      // Look ahead: graph blocks have `{` after an optional GRAPH keyword OR after the IRI
      const next = peek(state, 1);
      if (next?.type === 'punct' && next.value === '{') {
        consume(state); // graph IRI — we don't track per-graph parentage
        consume(state); // {
        while (peek(state) && !(peek(state)!.type === 'punct' && (peek(state) as any).value === '}')) {
          parseTriplesBlock(state);
        }
        expectPunct(state, '}');
        continue;
      }
    }

    // Otherwise: a triples block at the document level
    parseTriplesBlock(state);
  }

  const subjects: ParsedSubject[] = [];
  for (const [key, properties] of state.subjects) {
    const subject = key.startsWith('_:') ? { bnode: key.slice(2) } : (key as IRI);
    subjects.push({ subject, properties });
  }

  return { prefixes: state.prefixes, subjects };
}

/**
 * Convenience: find every subject in `doc` that has rdf:type == `typeIri`.
 */
export function findSubjectsOfType(doc: ParsedDocument, typeIri: IRI): readonly ParsedSubject[] {
  return doc.subjects.filter(s => {
    const types = s.properties.get(RDF_TYPE);
    return types?.some(t => t.kind === 'iri' && t.iri === typeIri) ?? false;
  });
}

/**
 * Convenience: read a single string-literal value (returns first match).
 */
export function readStringValue(subject: ParsedSubject, predicate: IRI): string | undefined {
  const terms = subject.properties.get(predicate);
  for (const term of terms ?? []) {
    if (term.kind === 'literal') return term.value;
  }
  return undefined;
}

/**
 * Convenience: read all string-literal values for a predicate.
 */
export function readStringValues(subject: ParsedSubject, predicate: IRI): readonly string[] {
  const terms = subject.properties.get(predicate);
  return (terms ?? []).filter((t): t is ParsedLiteral => t.kind === 'literal').map(t => t.value);
}

/**
 * Convenience: read an integer literal (handles xsd:integer-typed and untyped).
 */
export function readIntegerValue(subject: ParsedSubject, predicate: IRI): number | undefined {
  const terms = subject.properties.get(predicate);
  for (const term of terms ?? []) {
    if (term.kind === 'literal') {
      const n = parseInt(term.value, 10);
      if (Number.isFinite(n) && String(n) === term.value.trim()) return n;
    }
  }
  return undefined;
}

/**
 * Convenience: read a single IRI value.
 */
export function readIriValue(subject: ParsedSubject, predicate: IRI): IRI | undefined {
  const terms = subject.properties.get(predicate);
  for (const term of terms ?? []) {
    if (term.kind === 'iri') return term.iri;
  }
  return undefined;
}
