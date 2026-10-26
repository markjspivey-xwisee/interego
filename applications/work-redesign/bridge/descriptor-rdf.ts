/**
 * A work-redesign descriptor read as RDF, whatever its spelling: the part of the pod layer that
 * decides what a descriptor says, so that nothing the bridge reads from one depends on how it is
 * written.
 *
 * ── WHY A NORMALISING PASS ──────────────────────────────────────────────────────────────────
 * The substrate's parseTrig reads the descriptors publish writes, but not every Turtle document
 * that states the same RDF: it passes a `\uXXXX` escape inside an IRI through undecoded, and it
 * refuses a prefix name outside ASCII (`@prefix café: <…> .`) even when nothing uses it. A pod
 * writer can respell a descriptor that way without changing a triple. So a descriptor is first
 * re-spelled here (normaliseTurtle): comments dropped; every IRI decoded, cg: legacy names mapped
 * to iep:, and written as a full IRI reference through turtleIriRef; every prefixed name resolved
 * against the document's own declarations, any Unicode name the grammar admits; every literal,
 * in any of the four quotings and with its escapes decoded, written in one quoting; numbers
 * written as typed literals; blank node labels renamed. What is left is spelled the one way
 * parseTrig reads, and parseTrig still decides the grammar. A document the pass cannot read (a
 * lexical error, an unknown prefix, a relative IRI other than `<>`, or a base directive) is
 * parsed as it is, and when that fails too it does not parse.
 *
 * ── WHAT A SIGNATURE NEEDS ─────────────────────────────────────────────────────────────────
 * signedValuesIn lists, from a descriptor's text with its \u and \U escapes decoded, every value
 * a platform proof signs that the text has to supply: 0x signatures of the length a secp256k1
 * signature has, ISO instants, content digests, and work-redesign record ids. Literals have no
 * other spelling for these characters, so the list holds a proof's values however the proof was
 * written or wherever it was moved, and the signature decides which of them belong together.
 *
 * No environment reads, no network.
 */
import {
  CG, parseTrig, turtleIriRef, escapeTurtleLiteral,
  type IRI, type ParsedDocument, type ParsedSubject, type ParsedTerm,
} from '@interego/core';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const HYDRA_NS = 'http://www.w3.org/ns/hydra/core#';
const DCAT_NS = 'http://www.w3.org/ns/dcat#';
/** The deprecated cg: namespace, read as iep: (as parseTrig does for prefixed names). */
const CG_LEGACY_NS = CG.replace(/iep#$/, 'cg#');
const iep = (local: string): IRI => `${CG}${local}` as IRI;

// ── Tokens ────────────────────────────────────────────────────────────────────────────────

type Tok =
  | { readonly t: 'iri'; readonly v: string }
  | { readonly t: 'pname'; readonly p: string; readonly l: string }
  | { readonly t: 'bnode'; readonly v: string }
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'num'; readonly v: string; readonly dt: 'integer' | 'decimal' | 'double' }
  | { readonly t: 'bool'; readonly v: 'true' | 'false' }
  | { readonly t: 'lang'; readonly v: string }
  | { readonly t: 'kw'; readonly v: '@prefix' | '@base' | '@version' | 'PREFIX' | 'BASE' | 'VERSION' | 'GRAPH' | 'a' }
  | { readonly t: 'punct'; readonly v: string };

// Turtle 1.1 / TriG [163s]–[170s]: the characters a prefixed name and a blank node label may hold.
const PN_CHARS_BASE = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D'
  + '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const IS_BASE = new RegExp(`^[${PN_CHARS_BASE}]$`, 'u');
const IS_CHARS_U = new RegExp(`^[${PN_CHARS_BASE}_]$`, 'u');
const IS_CHARS_OTHER = new RegExp(`^[${PN_CHARS_BASE}_\\-0-9\\u00B7\\u203F-\\u2040]$`, 'u');
/** PN_CHARS: PN_CHARS_U, '-', digits, U+00B7, the combining marks U+0300–U+036F (tested by code point: a class holding them reads as misleading), U+203F–U+2040. */
const IS_CHARS = { test: (ch: string): boolean => IS_CHARS_OTHER.test(ch) || (ch.length === 1 && ch >= '\u0300' && ch <= '\u036F') };
/** The characters a PN_LOCAL_ESC may escape. */
const LOCAL_ESCAPABLE = "_~.-!$&'()*+,;=/?#@%";
/** What an IRIREF may not hold unescaped. */
const IRI_FORBIDDEN = /[\u0000- <>"{}|^`\\]/;
const NUMBER = /[+-]?(?:[0-9]+\.[0-9]*[eE][+-]?[0-9]+|\.[0-9]+[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+|[0-9]*\.[0-9]+|[0-9]+)/y;
const LANG = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*(?:--(?:ltr|rtl))?$/;
const HEX = /^[0-9A-Fa-f]+$/;

/** A code point read from a \u or \U escape, or null when it is not one a string may hold. */
function fromHex(digits: string): string | null {
  if (!HEX.test(digits)) return null;
  const cp = parseInt(digits, 16);
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return String.fromCodePoint(cp);
}

/** The character at `i` (a whole code point) and how many UTF-16 units it takes. */
function cpAt(src: string, i: number): string {
  const cp = src.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * Split a Turtle / TriG document into tokens, with comments dropped and every escape decoded; null
 * on anything the grammar's terminals do not admit. Not a parser: parseTrig decides the grammar.
 */
function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    if (c === '#') {
      while (i < n && src.charAt(i) !== '\n' && src.charAt(i) !== '\r') i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (three === '<<(' || three === ')>>') { out.push({ t: 'punct', v: three }); i += 3; continue; }
    if (two === '<<' || two === '>>' || two === '{|' || two === '|}' || two === '^^') { out.push({ t: 'punct', v: two }); i += 2; continue; }
    if (c === '<') {
      let v = '';
      let j = i + 1;
      for (;;) {
        if (j >= n) return null;
        const d = src.charAt(j);
        if (d === '>') break;
        if (d === '\\') {
          const kind = src.charAt(j + 1);
          const len = kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
          const ch = len === 0 ? null : fromHex(src.slice(j + 2, j + 2 + len));
          if (ch === null || src.slice(j + 2, j + 2 + len).length !== len) return null;
          v += ch;
          j += 2 + len;
          continue;
        }
        if (IRI_FORBIDDEN.test(d)) return null;
        v += d;
        j += 1;
      }
      out.push({ t: 'iri', v });
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const long = src.startsWith(c.repeat(3), i);
      const quote = long ? c.repeat(3) : c;
      let v = '';
      let j = i + quote.length;
      for (;;) {
        if (j >= n) return null;
        if (src.startsWith(quote, j)) break;
        const d = src.charAt(j);
        if (!long && (d === '\n' || d === '\r')) return null;
        if (d === '\\') {
          const e = src.charAt(j + 1);
          const simple: Record<string, string> = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\' };
          const s = simple[e];
          if (s !== undefined) { v += s; j += 2; continue; }
          const len = e === 'u' ? 4 : e === 'U' ? 8 : 0;
          const digits = src.slice(j + 2, j + 2 + len);
          const ch = len === 0 || digits.length !== len ? null : fromHex(digits);
          if (ch === null) return null;
          v += ch;
          j += 2 + len;
          continue;
        }
        v += d;
        j += 1;
      }
      out.push({ t: 'str', v });
      i = j + quote.length;
      continue;
    }
    if (c === '@') {
      const m = /^@[A-Za-z0-9-]+/.exec(src.slice(i, i + 128));
      if (!m) return null;
      const word = m[0].slice(1);
      if (word === 'prefix' || word === 'base' || word === 'version') out.push({ t: 'kw', v: `@${word}` });
      else if (LANG.test(word)) out.push({ t: 'lang', v: word });
      else return null;
      i += m[0].length;
      continue;
    }
    if (c === '_' && src.charAt(i + 1) === ':') {
      let j = i + 2;
      const first = cpAt(src, j);
      if (!(IS_CHARS_U.test(first) || /^[0-9]$/.test(first))) return null;
      let label = first;
      j += first.length;
      for (let ch = cpAt(src, j); ch !== '' && (IS_CHARS.test(ch) || ch === '.'); ch = cpAt(src, j)) { label += ch; j += ch.length; }
      while (label.endsWith('.')) { label = label.slice(0, -1); j -= 1; }
      out.push({ t: 'bnode', v: label });
      i = j;
      continue;
    }
    if (c === '+' || c === '-' || /[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src.charAt(i + 1)))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m) {
        const v = m[0];
        out.push({ t: 'num', v, dt: /[eE]/.test(v) ? 'double' : v.includes('.') ? 'decimal' : 'integer' });
        i += v.length;
        continue;
      }
      if (c !== '.') return null;
    }
    if ('.;,[](){}~'.includes(c)) { out.push({ t: 'punct', v: c }); i += 1; continue; }
    if (IS_BASE.test(cpAt(src, i)) || c === ':') {
      // PN_PREFIX, then either ':' and a PN_LOCAL (a prefixed name), or nothing (a keyword).
      let word = '';
      let j = i;
      if (c !== ':') {
        for (let ch = cpAt(src, j); ch !== '' && (IS_CHARS.test(ch) || ch === '.'); ch = cpAt(src, j)) { word += ch; j += ch.length; }
      }
      if (src.charAt(j) !== ':') {
        while (word.endsWith('.')) { word = word.slice(0, -1); j -= 1; }
        const upper = word.toUpperCase();
        if (word === 'a') out.push({ t: 'kw', v: 'a' });
        else if (word === 'true' || word === 'false') out.push({ t: 'bool', v: word });
        else if (upper === 'PREFIX' || upper === 'BASE' || upper === 'VERSION' || upper === 'GRAPH') out.push({ t: 'kw', v: upper });
        else return null;
        i = j;
        continue;
      }
      if (word.endsWith('.')) return null;
      j += 1;
      // The local part: each piece remembers whether it was escaped, so only an unescaped trailing '.' is given back.
      const pieces: Array<{ readonly s: string; readonly escaped: boolean; readonly len: number }> = [];
      for (;;) {
        const ch = cpAt(src, j);
        if (ch === '') break;
        const firstPiece = pieces.length === 0;
        if (ch === '%') {
          const hex = src.slice(j + 1, j + 3);
          if (hex.length !== 2 || !HEX.test(hex)) return null;
          pieces.push({ s: `%${hex}`, escaped: true, len: 3 });
          j += 3;
          continue;
        }
        if (ch === '\\') {
          const e = src.charAt(j + 1);
          if (e === '' || !LOCAL_ESCAPABLE.includes(e)) return null;
          pieces.push({ s: e, escaped: true, len: 2 });
          j += 2;
          continue;
        }
        const ok = firstPiece ? (IS_CHARS_U.test(ch) || ch === ':' || /^[0-9]$/.test(ch)) : (IS_CHARS.test(ch) || ch === '.' || ch === ':');
        if (!ok) break;
        pieces.push({ s: ch, escaped: false, len: ch.length });
        j += ch.length;
      }
      for (let last = pieces.at(-1); last !== undefined && !last.escaped && last.s === '.'; last = pieces.at(-1)) {
        pieces.pop();
        j -= last.len;
      }
      out.push({ t: 'pname', p: word, l: pieces.map((x) => x.s).join('') });
      i = j;
      continue;
    }
    return null;
  }
  return out;
}

// ── Re-spelling ───────────────────────────────────────────────────────────────────────────

/** An absolute IRI as a Turtle IRI reference, the cg: legacy namespace read as iep:; null when it cannot be one. */
function iriRef(iri: string): string | null {
  return turtleIriRef(iri.startsWith(CG_LEGACY_NS) ? `${CG}${iri.slice(CG_LEGACY_NS.length)}` : iri);
}

/**
 * The same document spelled the one way parseTrig reads (see the header), or null when this pass
 * cannot read it. Directives are consumed, so every IRI it writes is a full one.
 */
export function normaliseTurtle(src: string): string | null {
  const toks = tokenize(src);
  if (toks === null) return null;
  const prefixes = new Map<string, string>();
  const bnodes = new Map<string, string>();
  const out: string[] = [];
  for (let k = 0; k < toks.length; k += 1) {
    const tok = toks[k];
    if (tok === undefined) break;
    if (tok.t === 'kw' && (tok.v === '@prefix' || tok.v === 'PREFIX')) {
      const name = toks[k + 1];
      const value = toks[k + 2];
      if (name?.t !== 'pname' || name.l !== '' || value?.t !== 'iri' || turtleIriRef(value.v) === null) return null;
      prefixes.set(name.p, value.v);
      k += 2;
      if (tok.v === '@prefix') {
        const dot = toks[k + 1];
        if (dot?.t !== 'punct' || dot.v !== '.') return null;
        k += 1;
      }
      continue;
    }
    if (tok.t === 'kw' && (tok.v === '@version' || tok.v === 'VERSION')) {
      if (toks[k + 1]?.t !== 'str') return null;
      k += 1;
      const dot = toks[k + 1];
      if (tok.v === '@version' && dot?.t === 'punct' && dot.v === '.') k += 1;
      continue;
    }
    // A base directive, and any relative IRI but the document's own (`<>`), would need resolving: the document is read as it is instead.
    if (tok.t === 'kw' && (tok.v === '@base' || tok.v === 'BASE')) return null;
    let text: string | null;
    switch (tok.t) {
      case 'iri': text = tok.v === '' ? '<>' : iriRef(tok.v); break;
      case 'pname': {
        const ns = prefixes.get(tok.p);
        text = ns === undefined ? null : iriRef(`${ns}${tok.l}`);
        break;
      }
      case 'bnode': {
        let id = bnodes.get(tok.v);
        if (id === undefined) { id = `b${bnodes.size}`; bnodes.set(tok.v, id); }
        text = `_:${id}`;
        break;
      }
      case 'str': text = `"${escapeTurtleLiteral(tok.v)}"`; break;
      case 'num': {
        const dt = iriRef(`${XSD}${tok.dt}`);
        text = dt === null ? null : `"${tok.v}"^^${dt}`;
        break;
      }
      case 'bool': text = tok.v; break;
      case 'lang': text = `@${tok.v}`; break;
      case 'kw': text = tok.v; break;
      case 'punct': text = tok.v; break;
    }
    if (text === null) return null;
    // A language tag and a datatype marker attach to the literal before them.
    const before = toks[k - 1];
    if (tok.t === 'lang' || (tok.t === 'punct' && tok.v === '^^') || (before?.t === 'punct' && before.v === '^^')) {
      out[out.length - 1] = `${out[out.length - 1] ?? ''}${text}`;
    } else {
      out.push(text);
    }
  }
  return out.join(' ');
}

/** A descriptor read as RDF (normalised first, then as it is), or null when it does not parse. */
export function parseDescriptorRdf(src: string): ParsedDocument | null {
  const normal = normaliseTurtle(src);
  for (const text of normal === null ? [src] : [normal, src]) {
    try { return parseTrig(text); } catch { /* the next spelling, or none */ }
  }
  return null;
}

// ── Reading what a descriptor states ─────────────────────────────────────────────────────

const objectsOf = (doc: ParsedDocument, predicate: IRI): ParsedTerm[] => doc.subjects.flatMap((s) => s.properties.get(predicate) ?? []);

/** The node an object names (a blank node or an IRI the document describes), if the document describes it. */
export function nodeOf(doc: ParsedDocument, t: ParsedTerm): ParsedSubject | undefined {
  if (t.kind === 'bnode') return doc.subjects.find((s) => typeof s.subject === 'object' && s.subject.bnode === t.id);
  if (t.kind === 'iri') return doc.subjects.find((s) => s.subject === t.iri);
  return undefined;
}

/** Every distinct IRI the document states with iep:describes, in document order. */
export function describesOf(doc: ParsedDocument): string[] {
  return [...new Set(objectsOf(doc, iep('describes')).flatMap((t) => (t.kind === 'iri' ? [t.iri as string] : [])))];
}

/** The first literal the document states with `predicate`, or null. */
export function literalOf(doc: ParsedDocument, predicate: IRI): string | null {
  for (const t of objectsOf(doc, predicate)) if (t.kind === 'literal') return t.value;
  return null;
}
export const VALID_FROM = iep('validFrom');
export const VALID_UNTIL = iep('validUntil');
export const GENERATED_AT = `${PROV_NS}generatedAtTime` as IRI;
export const CONFIDENCE = iep('epistemicConfidence');

/** Why a version whose descriptor links no graph is not trusted. */
export const LINKS_NO_GRAPH = 'its descriptor links no graph';
/** Why a version whose descriptor links more than one graph is not trusted. */
export const LINKS_MORE_THAN_ONE = 'its descriptor was altered after signing: it links more than one graph';

/**
 * The graph a descriptor links, read as RDF: every node it states as an iep:affordance (or the
 * legacy iep:hasDistribution) that names a target (hydra:target, else dcat:accessURL) and a
 * dcat:mediaType, as parseDistributionFromDescriptorTurtle reads its first block. Exactly one
 * target is a link; none, or more than one, is why there is none.
 */
export function distributionOf(doc: ParsedDocument):
  { readonly ok: true; readonly accessURL: string; readonly encrypted: boolean } | { readonly ok: false; readonly why: string } {
  const links = new Map<string, boolean>();
  for (const t of [...objectsOf(doc, iep('affordance')), ...objectsOf(doc, iep('hasDistribution'))]) {
    const node = nodeOf(doc, t);
    if (!node) continue;
    const iriOf = (p: IRI): string | undefined => (node.properties.get(p) ?? []).flatMap((o) => (o.kind === 'iri' ? [o.iri as string] : []))[0];
    const target = iriOf(`${HYDRA_NS}target` as IRI) ?? iriOf(`${DCAT_NS}accessURL` as IRI);
    const mediaType = (node.properties.get(`${DCAT_NS}mediaType` as IRI) ?? []).some((o) => o.kind === 'literal');
    if (target === undefined || !mediaType) continue;
    const encrypted = (node.properties.get(iep('encrypted')) ?? []).some((o) => o.kind === 'literal' && o.value === 'true');
    links.set(target, (links.get(target) ?? false) || encrypted);
  }
  if (links.size === 0) return { ok: false, why: LINKS_NO_GRAPH };
  if (links.size > 1) return { ok: false, why: LINKS_MORE_THAN_ONE };
  const [only] = [...links];
  return only === undefined ? { ok: false, why: LINKS_NO_GRAPH } : { ok: true, accessURL: only[0], encrypted: only[1] };
}

// ── The values a signature needs ─────────────────────────────────────────────────────────

/** A text with every Turtle \u and \U escape decoded (one that names no character is left as it is). */
export function decodeEscapes(text: string): string {
  return text.replace(/\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})/g, (m, four: string | undefined, eight: string | undefined) => fromHex(four ?? eight ?? '') ?? m);
}

const distinct = (re: RegExp, text: string): string[] => [...new Set([...text.matchAll(re)].map((m) => m[0]))];

/**
 * The values of the kinds a platform proof signs that a descriptor's text holds anywhere, its
 * escapes decoded, each list distinct and in the order met: 0x signatures exactly as long as a
 * secp256k1 one, ISO instants, graph digests, and work-redesign record ids.
 */
export function signedValuesIn(text: string): {
  readonly signatures: string[]; readonly instants: string[]; readonly digests: string[]; readonly recordIds: string[];
} {
  const decoded = decodeEscapes(text);
  return {
    signatures: distinct(/(?<![0-9A-Za-z])0x[0-9a-fA-F]{130}(?![0-9A-Za-z])/g, decoded),
    instants: distinct(/(?<![0-9])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})(?![0-9])/g, decoded),
    digests: distinct(/(?<![A-Za-z0-9-])(?:graph-nquads-sha256|sha256):[0-9a-f]{64}(?![0-9A-Za-z])/g, decoded),
    recordIds: distinct(/(?<![A-Za-z0-9:])urn:wrd:record:[a-z-]+-[0-9a-f]{16}(?:-k[0-9a-f]{8})?(?![0-9A-Za-z-])/g, decoded),
  };
}
