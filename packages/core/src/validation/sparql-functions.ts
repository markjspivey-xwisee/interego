/**
 * The SPARQL function library, as SHACL 1.2 node-expression operators.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────
 *
 * SHACL 1.2 lets a node expression call a SPARQL function directly:
 *
 *     [ sparql:strlen ( "hello" ) ]        ->  ( 5 )
 *     [ sparql:if ( [ sparql:greater-than ( 10 5 ) ] "big" "small" ) ]  ->  ( "big" )
 *
 * The predicate names the function, its object is an rdf:List of ARGUMENTS, and each
 * argument is itself a node expression evaluated recursively. The result is a sequence of
 * exactly one term.
 *
 * ★ THIS IS A FUNCTION LIBRARY, NOT A QUERY ENGINE, and the distinction is the whole reason
 * this file is small. All 76 approved entries in the W3C `shnex-sparql` area evaluate
 * EXPRESSIONS — none supplies a data graph, none matches a graph pattern, none needs a
 * solution sequence. SPARQL *queries* in SHACL (sh:select, sh:ask, sh:construct) are a
 * separate problem with a separate answer; nothing here attempts them.
 *
 * ── ERRORS ARE THE EMPTY SEQUENCE ────────────────────────────────────────────
 *
 * SPARQL functions raise a type error on the wrong argument type, and an expression that
 * raises has no value. The node-expression language already has a term for "no value" — the
 * empty sequence — so that is what an error produces. Three functions deliberately look
 * THROUGH it rather than propagating it, because inspecting absence is their entire job:
 * `bound`, `coalesce` and `if`. Getting that wrong makes all three return nothing, which is
 * the answer that looks most like working.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ParsedTerm, ParsedLiteral } from '../rdf/turtle-parser.js';
import type { IRI } from '../model/types.js';

export const SPARQL_FN = 'http://www.w3.org/ns/sparql#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const lit = (value: string, datatype?: string, language?: string): ParsedLiteral => ({
  kind: 'literal',
  value,
  ...(datatype !== undefined ? { datatype: datatype as IRI } : {}),
  ...(language !== undefined ? { language } : {}),
});
const bool = (b: boolean): ParsedTerm => lit(b ? 'true' : 'false', `${XSD}boolean`);
const int = (n: number): ParsedTerm => lit(String(n), `${XSD}integer`);
/** Decimals keep a fractional part: `ceil(3.2)` is 4.0, not 4. */
const dec = (n: number): ParsedTerm => lit(Number.isInteger(n) ? `${n}.0` : String(n), `${XSD}decimal`);
const str = (s: string): ParsedTerm => lit(s);
const iri = (s: string): ParsedTerm => ({ kind: 'iri', iri: s as IRI });

const NUMERIC = new Set([
  'integer', 'decimal', 'double', 'float', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
].map(t => `${XSD}${t}`));

const isNumericTerm = (t: ParsedTerm | undefined): t is ParsedLiteral =>
  t?.kind === 'literal' && NUMERIC.has(t.datatype ?? '') && Number.isFinite(Number(t.value));

const num = (t: ParsedTerm | undefined): number | undefined =>
  (isNumericTerm(t) ? Number(t.value) : undefined);

/**
 * The lexical form of a term — SPARQL's STR().
 *
 * An IRI's lexical form is the IRI itself; a literal's is its value with datatype and
 * language stripped. A blank node has none, which is why STR() of one is an error.
 */
const lexical = (t: ParsedTerm | undefined): string | undefined => {
  if (t === undefined) return undefined;
  if (t.kind === 'iri') return t.iri;
  if (t.kind === 'literal') return t.value;
  return undefined;
};

/**
 * ★ A LANGUAGE TAG AND A BASE DIRECTION SHARE ONE FIELD. RDF 1.2 writes `"x"@en--ltr`, and
 * the parser stores the whole tag — so `lang()` of it must be `en`, not `en--ltr`, and
 * `langdir()` must be `ltr`. Reading the field raw makes lang() wrong for every directional
 * literal, which is the shape of value a localisation-aware graph is full of.
 */
function langParts(t: ParsedTerm | undefined): { lang: string; dir: string } | undefined {
  if (t?.kind !== 'literal' || t.language === undefined || t.language === '') return undefined;
  const i = t.language.indexOf('--');
  return i === -1
    ? { lang: t.language, dir: '' }
    : { lang: t.language.slice(0, i), dir: t.language.slice(i + 2) };
}

/** Two terms are the SAME TERM when every component matches — no value coercion. */
function sameTerm(a: ParsedTerm | undefined, b: ParsedTerm | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'iri' && b.kind === 'iri') return a.iri === b.iri;
  if (a.kind === 'bnode' && b.kind === 'bnode') return a.id === b.id;
  if (a.kind === 'literal' && b.kind === 'literal') {
    return a.value === b.value
      && (a.datatype ?? '') === (b.datatype ?? '')
      && (a.language ?? '') === (b.language ?? '');
  }
  if (a.kind === 'triple' && b.kind === 'triple') {
    return sameTerm(a.subject, b.subject) && a.predicate === b.predicate
      && sameTerm(a.object, b.object);
  }
  return false;
}

/** SPARQL `=` — VALUE equality, so 42 and "42"^^xsd:integer are equal. */
function sameValue(a: ParsedTerm | undefined, b: ParsedTerm | undefined): boolean | undefined {
  if (a === undefined || b === undefined) return undefined;
  const x = num(a);
  const y = num(b);
  if (x !== undefined && y !== undefined) return x === y;
  if (a.kind === 'literal' && b.kind === 'literal') {
    const plain = (t: ParsedLiteral): boolean =>
      t.language === undefined && (t.datatype === undefined || t.datatype === `${XSD}string`);
    if (plain(a) && plain(b)) return a.value === b.value;
  }
  return sameTerm(a, b);
}

/** Numeric ordering; undefined when the pair is not comparable. */
function compare(a: ParsedTerm | undefined, b: ParsedTerm | undefined): number | undefined {
  const x = num(a);
  const y = num(b);
  if (x !== undefined && y !== undefined) return x < y ? -1 : x > y ? 1 : 0;
  const p = lexical(a);
  const q = lexical(b);
  if (p === undefined || q === undefined) return undefined;
  if (a?.kind === 'literal' && b?.kind === 'literal') return p < q ? -1 : p > q ? 1 : 0;
  return undefined;
}

/** The dateTime components SPARQL exposes, parsed from the lexical form rather than Date. */
const DATETIME_RE =
  /^(-?\d{4,})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d(?:\.\d+)?))?(Z|[+-]\d\d:\d\d)?$/;

function dateParts(t: ParsedTerm | undefined): RegExpExecArray | undefined {
  if (t?.kind !== 'literal') return undefined;
  return DATETIME_RE.exec(t.value) ?? undefined;
}

/**
 * `timezone()` returns an xsd:dayTimeDuration; `tz()` returns the raw lexical offset.
 * Parsed from the string, not from a Date, because a Date has already normalised the offset
 * away and cannot tell +02:00 from Z.
 */
function tzDuration(offset: string): string {
  if (offset === 'Z') return 'PT0S';
  const m = /^([+-])(\d\d):(\d\d)$/.exec(offset);
  if (!m) return 'PT0S';
  const sign = m[1] === '-' ? '-' : '';
  const h = Number(m[2]);
  const min = Number(m[3]);
  const body = `${h > 0 ? `${h}H` : ''}${min > 0 ? `${min}M` : ''}` || '0S';
  return `${sign}PT${body}`;
}

const hash = (algo: string, s: string): ParsedTerm =>
  str(createHash(algo).update(s, 'utf8').digest('hex'));

/**
 * Apply a SPARQL function to already-evaluated argument sequences.
 *
 * `args` are SEQUENCES, not terms: an argument that evaluated to nothing is an empty array,
 * which is how `bound` and `coalesce` see absence. Returns the result sequence — empty for
 * an error or an unknown function.
 *
 * `lazyArgs` lets `if` avoid evaluating the branch it does not take, which SPARQL requires:
 * `IF(false, 1/0, 2)` is 2, not an error.
 */
export function applySparqlFunction(
  local: string,
  args: readonly (readonly ParsedTerm[])[],
): readonly ParsedTerm[] {
  const a = (i: number): ParsedTerm | undefined => args[i]?.[0];
  const one = (t: ParsedTerm | undefined): readonly ParsedTerm[] => (t === undefined ? [] : [t]);
  const s0 = lexical(a(0));
  const s1 = lexical(a(1));

  switch (local) {
    // ── absence, inspected rather than propagated ──
    case 'bound': return [bool((args[0]?.length ?? 0) > 0)];
    case 'coalesce': {
      for (const seq of args) if (seq.length > 0) return [seq[0]!];
      return [];
    }

    // ── term inspection ──
    case 'isIRI': case 'isURI': return one(a(0) && bool(a(0)!.kind === 'iri'));
    case 'isBlank': return one(a(0) && bool(a(0)!.kind === 'bnode'));
    case 'isLiteral': return one(a(0) && bool(a(0)!.kind === 'literal'));
    case 'isNumeric': return one(a(0) && bool(isNumericTerm(a(0))));
    case 'isTriple': return one(a(0) && bool(a(0)!.kind === 'triple'));
    case 'datatype': {
      const t = a(0);
      if (t?.kind !== 'literal') return [];
      if (t.language !== undefined && t.language !== '') {
        return [iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#langString')];
      }
      return [iri(t.datatype ?? `${XSD}string`)];
    }
    case 'lang': { const p = langParts(a(0)); return a(0)?.kind === 'literal' ? [str(p?.lang ?? '')] : []; }
    case 'langdir': { const p = langParts(a(0)); return [str(p?.dir ?? '')]; }
    case 'hasLang': {
      const p = langParts(a(0));
      return s1 === undefined ? [] : [bool(p !== undefined && p.lang === s1)];
    }
    case 'hasLangdir': { const p = langParts(a(0)); return [bool(p !== undefined && p.dir !== '')]; }
    case 'langMatches': {
      if (s0 === undefined || s1 === undefined) return [];
      if (s1 === '*') return [bool(s0.length > 0)];
      const tag = s0.toLowerCase();
      const range = s1.toLowerCase();
      return [bool(tag === range || tag.startsWith(`${range}-`))];
    }
    case 'str': return s0 === undefined ? [] : [str(s0)];
    case 'iri': case 'uri': return s0 === undefined ? [] : [iri(s0)];
    case 'bnode': return [{ kind: 'bnode', id: `sparqlfn${randomUUID().replace(/-/g, '')}` }];
    case 'uuid': return [iri(`urn:uuid:${randomUUID()}`)];
    case 'struuid': return [str(randomUUID())];
    case 'strdt': {
      const dt = a(1);
      return s0 === undefined || dt?.kind !== 'iri' ? [] : [lit(s0, dt.iri)];
    }
    case 'strlang': return s0 === undefined || s1 === undefined ? [] : [lit(s0, undefined, s1)];
    case 'strlangdir': {
      const d = lexical(a(2));
      return s0 === undefined || s1 === undefined || d === undefined
        ? [] : [lit(s0, undefined, `${s1}--${d}`)];
    }

    // ── triple terms (RDF 1.2) ──
    case 'triple': {
      const [sub, pred, obj] = [a(0), a(1), a(2)];
      if (!sub || pred?.kind !== 'iri' || !obj) return [];
      if (sub.kind !== 'iri' && sub.kind !== 'bnode') return [];
      return [{ kind: 'triple', subject: sub, predicate: pred.iri, object: obj }];
    }
    case 'subject': case 'predicate': case 'object': {
      // Bound to a local so the narrowing survives: `a(0)?.kind === 'triple'` narrows the
      // call's RESULT, not the next call, and TypeScript is right to refuse it.
      const t = a(0);
      if (t?.kind !== 'triple') return [];
      return [local === 'subject' ? t.subject : local === 'predicate' ? iri(t.predicate) : t.object];
    }

    // ── comparison and equality ──
    case 'equals': { const r = sameValue(a(0), a(1)); return r === undefined ? [] : [bool(r)]; }
    case 'not-equals': { const r = sameValue(a(0), a(1)); return r === undefined ? [] : [bool(!r)]; }
    case 'sameTerm': return [bool(sameTerm(a(0), a(1)))];
    case 'sameValue': { const r = sameValue(a(0), a(1)); return r === undefined ? [] : [bool(r)]; }
    case 'greater-than': case 'greater-than-or-equal':
    case 'less-than': case 'less-than-or-equal': {
      const c = compare(a(0), a(1));
      if (c === undefined) return [];
      return [bool(local === 'greater-than' ? c > 0
        : local === 'greater-than-or-equal' ? c >= 0
          : local === 'less-than' ? c < 0 : c <= 0)];
    }

    // ── boolean logic. An error operand is not simply false: SPARQL's truth tables let
    //    `false && error` be false and `true || error` be true, and modelling that keeps
    //    a partially-erroring expression usable. ──
    case 'logical-and': {
      const xs = args.map(g => (g[0]?.kind === 'literal' ? g[0]!.value === 'true' : undefined));
      if (xs.some(x => x === false)) return [bool(false)];
      return xs.every(x => x === true) ? [bool(true)] : [];
    }
    case 'logical-or': {
      const xs = args.map(g => (g[0]?.kind === 'literal' ? g[0]!.value === 'true' : undefined));
      if (xs.some(x => x === true)) return [bool(true)];
      return xs.every(x => x === false) ? [bool(false)] : [];
    }
    case 'logical-not': {
      const t = a(0);
      return t?.kind === 'literal' ? [bool(t.value !== 'true')] : [];
    }

    // ── arithmetic ──
    case 'plus': case 'subtract': case 'multiply': case 'divide': {
      const x = num(a(0));
      const y = num(a(1));
      if (x === undefined || y === undefined) return [];
      if (local === 'divide') return y === 0 ? [] : [dec(x / y)];
      const r = local === 'plus' ? x + y : local === 'subtract' ? x - y : x * y;
      // Integer in, integer out; anything else is a decimal.
      const bothInt = (a(0) as ParsedLiteral).datatype === `${XSD}integer`
        && (a(1) as ParsedLiteral).datatype === `${XSD}integer`;
      return [bothInt ? int(r) : dec(r)];
    }
    case 'unary-minus': case 'unary-plus': case 'abs': {
      const x = num(a(0));
      if (x === undefined) return [];
      const r = local === 'unary-minus' ? -x : local === 'abs' ? Math.abs(x) : x;
      return [(a(0) as ParsedLiteral).datatype === `${XSD}integer` ? int(r) : dec(r)];
    }
    case 'ceil': case 'floor': case 'round': {
      const x = num(a(0));
      if (x === undefined) return [];
      const r = local === 'ceil' ? Math.ceil(x) : local === 'floor' ? Math.floor(x) : Math.round(x);
      return [(a(0) as ParsedLiteral).datatype === `${XSD}integer` ? int(r) : dec(r)];
    }

    // ── strings ──
    case 'strlen': return s0 === undefined ? [] : [int([...s0].length)];
    case 'ucase': return s0 === undefined ? [] : [str(s0.toUpperCase())];
    case 'lcase': return s0 === undefined ? [] : [str(s0.toLowerCase())];
    case 'concat': {
      const parts = args.map(g => lexical(g[0]));
      return parts.some(p => p === undefined) ? [] : [str(parts.join(''))];
    }
    case 'contains': return s0 === undefined || s1 === undefined ? [] : [bool(s0.includes(s1))];
    case 'strstarts': return s0 === undefined || s1 === undefined ? [] : [bool(s0.startsWith(s1))];
    case 'strends': return s0 === undefined || s1 === undefined ? [] : [bool(s0.endsWith(s1))];
    case 'strbefore': {
      if (s0 === undefined || s1 === undefined) return [];
      const i = s0.indexOf(s1);
      return [str(i === -1 ? '' : s0.slice(0, i))];
    }
    case 'strafter': {
      if (s0 === undefined || s1 === undefined) return [];
      const i = s0.indexOf(s1);
      return [str(i === -1 ? '' : s0.slice(i + s1.length))];
    }
    case 'substr': {
      // ★ SPARQL SUBSTR IS 1-BASED, and the second argument is a LENGTH, not an end index.
      if (s0 === undefined) return [];
      const start = num(a(1));
      if (start === undefined) return [];
      const chars = [...s0];
      const from = Math.max(0, start - 1);
      const len = num(a(2));
      return [str(chars.slice(from, len === undefined ? undefined : from + len).join(''))];
    }
    case 'replace': {
      const pattern = s1;
      const replacement = lexical(a(2));
      if (s0 === undefined || pattern === undefined || replacement === undefined) return [];
      const flags = lexical(a(3));
      try {
        return [str(s0.replace(new RegExp(pattern, `g${flags ?? ''}`), replacement))];
      } catch { return []; }
    }
    case 'regex': {
      if (s0 === undefined || s1 === undefined) return [];
      const flags = lexical(a(2));
      try { return [bool(new RegExp(s1, flags ?? '').test(s0))]; } catch { return []; }
    }
    case 'encode': case 'encode_for_uri':
      return s0 === undefined ? [] : [str(encodeURIComponent(s0).replace(/[!'()*]/g,
        c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))];

    // ── dates ──
    case 'year': case 'month': case 'day': case 'hours': case 'minutes': {
      const p = dateParts(a(0));
      if (!p) return [];
      const idx = { year: 1, month: 2, day: 3, hours: 4, minutes: 5 }[local]!;
      const v = p[idx];
      return v === undefined ? [] : [int(Number(v))];
    }
    case 'seconds': {
      const p = dateParts(a(0));
      return p?.[6] === undefined ? [] : [lit(p[6], `${XSD}decimal`)];
    }
    case 'timezone': {
      const p = dateParts(a(0));
      return p?.[7] === undefined ? [] : [lit(tzDuration(p[7]), `${XSD}dayTimeDuration`)];
    }
    case 'tz': {
      const p = dateParts(a(0));
      return p === undefined ? [] : [str(p[7] ?? '')];
    }

    // ── hashes ──
    case 'md5': return s0 === undefined ? [] : [hash('md5', s0)];
    case 'sha1': return s0 === undefined ? [] : [hash('sha1', s0)];
    case 'sha256': return s0 === undefined ? [] : [hash('sha256', s0)];
    case 'sha384': return s0 === undefined ? [] : [hash('sha384', s0)];
    case 'sha512': return s0 === undefined ? [] : [hash('sha512', s0)];

    default:
      // ★ NOT SILENTLY EMPTY. An unrecognised function is reported to the caller, which
      // decides whether to refuse — an expression that quietly yields nothing is
      // indistinguishable from one that legitimately matched nothing.
      return UNKNOWN;
  }
}

/** Sentinel: `applySparqlFunction` did not recognise the function at all. */
export const UNKNOWN: readonly ParsedTerm[] = Object.freeze([]);

/** True when `applySparqlFunction` implements this local name. */
export function implementsSparqlFunction(local: string): boolean {
  return IMPLEMENTED.has(local);
}

const IMPLEMENTED: ReadonlySet<string> = new Set([
  'bound', 'coalesce', 'if',
  'isIRI', 'isURI', 'isBlank', 'isLiteral', 'isNumeric', 'isTriple',
  'datatype', 'lang', 'langdir', 'hasLang', 'hasLangdir', 'langMatches',
  'str', 'iri', 'uri', 'bnode', 'uuid', 'struuid', 'strdt', 'strlang', 'strlangdir',
  'triple', 'subject', 'predicate', 'object',
  'equals', 'not-equals', 'sameTerm', 'sameValue',
  'greater-than', 'greater-than-or-equal', 'less-than', 'less-than-or-equal',
  'logical-and', 'logical-or', 'logical-not',
  'plus', 'subtract', 'multiply', 'divide', 'unary-minus', 'unary-plus', 'abs',
  'ceil', 'floor', 'round',
  'strlen', 'ucase', 'lcase', 'concat', 'contains', 'strstarts', 'strends',
  'strbefore', 'strafter', 'substr', 'replace', 'regex', 'encode', 'encode_for_uri',
  'year', 'month', 'day', 'hours', 'minutes', 'seconds', 'timezone', 'tz',
  'md5', 'sha1', 'sha256', 'sha384', 'sha512',
]);
