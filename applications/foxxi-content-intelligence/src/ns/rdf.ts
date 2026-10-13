/**
 * ns/rdf.ts — the one RDF graph model and the serializers every Foxxi `/ns` document goes through.
 *
 * ★ WHY ONE GRAPH, MANY SERIALIZATIONS. The Foxxi ontologies used to be printed by three separate
 * hand-rolled Turtle writers and three hand-rolled JSON-LD writers, kept "isomorphic" by tests that
 * compared them after the fact. Content negotiation then needed RDF/XML and N-Triples too — two
 * more writers per family — and the hand-rolled path had already produced unparseable documents
 * more than once (see round5/round7 remediation). So every document is now BUILT as a graph, once,
 * and every representation is a serialization of that same graph: Turtle, N-Triples, RDF/XML and
 * JSON-LD cannot disagree about a triple because none of them decides what the triples are.
 *
 * Literals carry their language tag or datatype. IRIs are checked at construction (an IRI that
 * could break out of `<…>` throws instead of being emitted), so a serializer never has to wonder.
 *
 * No runtime dependency beyond the substrate: the one parse this module does (a hand-written
 * Turtle data file merged into a generated document) goes through `@interego/core`'s `parseTrig`.
 * The tests cross-check every serialization with an independent parser, `n3`.
 */
import { escapeTurtleLiteral, turtleIriRef, parseTrig, type ParsedDocument, type ParsedTerm } from '@interego/core';

// ── Namespaces ───────────────────────────────────────────────────────────────────────────────
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SH = 'http://www.w3.org/ns/shacl#';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const DCT = 'http://purl.org/dc/terms/';
export const PROV = 'http://www.w3.org/ns/prov#';
export const VANN = 'http://purl.org/vocab/vann/';
export const BIBO = 'http://purl.org/ontology/bibo/';
export const FOAF = 'http://xmlns.com/foaf/0.1/';
export const SCHEMA = 'https://schema.org/';

/** The vocabularies every document may use, with their registered prefixes. */
export const STD_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  rdf: RDF, rdfs: RDFS, owl: OWL, xsd: XSD, sh: SH, skos: SKOS, dct: DCT, prov: PROV,
  vann: VANN, bibo: BIBO, foaf: FOAF, schema: SCHEMA,
});

// ── Terms ────────────────────────────────────────────────────────────────────────────────────
export interface NamedNode { readonly termType: 'NamedNode'; readonly value: string }
export interface BlankNode { readonly termType: 'BlankNode'; readonly value: string }
export interface Literal {
  readonly termType: 'Literal';
  readonly value: string;
  /** BCP 47 language tag (lower-cased); present ⇒ datatype rdf:langString. */
  readonly language?: string;
  /** Datatype IRI; absent and no language ⇒ xsd:string. */
  readonly datatype?: string;
}
export type Term = NamedNode | BlankNode | Literal;
export type Subject = NamedNode | BlankNode;
export interface Triple { readonly s: Subject; readonly p: NamedNode; readonly o: Term }

/** An absolute IRI. Throws on anything that could not be written inside `<…>` safely. */
export function iri(value: string): NamedNode {
  if (turtleIriRef(value) === null) throw new Error(`not an absolute, serializable IRI: ${JSON.stringify(value)}`);
  return { termType: 'NamedNode', value };
}
/** A plain string literal (xsd:string). */
export function str(value: string): Literal { return { termType: 'Literal', value: String(value) }; }
/** A language-tagged literal; English unless told otherwise. */
export function lang(value: string, tag = 'en'): Literal {
  return { termType: 'Literal', value: String(value), language: tag.toLowerCase() };
}
/** English text — the default for every label, definition and note. */
export const en = (value: string): Literal => lang(value, 'en');
/** A typed literal. `dt` is an absolute datatype IRI. */
export function typed(value: string | number | boolean, dt: string): Literal {
  if (dt === XSD + 'string') return str(String(value));
  return { termType: 'Literal', value: String(value), datatype: dt };
}
export const bool = (b: boolean): Literal => typed(b ? 'true' : 'false', XSD + 'boolean');
export const int = (n: number): Literal => typed(String(Math.trunc(n)), XSD + 'integer');
/** An xsd:decimal from a number, written without exponent. */
export function dec(n: number): Literal {
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(20).replace(/0+$/, '');
  if (!s.includes('.')) s = `${s}.0`;
  return typed(s, XSD + 'decimal');
}
export const date = (isoDate: string): Literal => typed(isoDate, XSD + 'date');

export const isNamed = (t: Term): t is NamedNode => t.termType === 'NamedNode';
export const isBlank = (t: Term): t is BlankNode => t.termType === 'BlankNode';
export const isLiteral = (t: Term): t is Literal => t.termType === 'Literal';

function termKey(t: Term): string {
  if (t.termType === 'NamedNode') return `<${t.value}>`;
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  return `"${t.value}"@${t.language ?? ''}^^${t.datatype ?? ''}`;
}

const RDF_TYPE = RDF + 'type', RDF_FIRST = RDF + 'first', RDF_REST = RDF + 'rest', RDF_NIL = RDF + 'nil';

// ── Graph ────────────────────────────────────────────────────────────────────────────────────
/** An ordered set of triples. Insertion order is preserved and drives the readable layouts. */
export class Graph {
  readonly triples: Triple[] = [];
  private readonly keys = new Set<string>();
  private bnodes = 0;

  /** Add a triple; an exact duplicate is ignored (a graph is a set). */
  add(s: Subject, p: NamedNode, o: Term): this {
    const k = `${termKey(s)} ${termKey(p)} ${termKey(o)}`;
    if (!this.keys.has(k)) { this.keys.add(k); this.triples.push({ s, p, o }); }
    return this;
  }
  /** Add several objects for one subject + predicate. */
  addAll(s: Subject, p: NamedNode, os: readonly Term[]): this { for (const o of os) this.add(s, p, o); return this; }
  /** A fresh blank node, unique within this graph. */
  bnode(): BlankNode { return { termType: 'BlankNode', value: `b${this.bnodes++}` }; }
  /** Build an rdf:List of `items`; returns its head (rdf:nil when empty). */
  list(items: readonly Term[]): Subject {
    if (items.length === 0) return iri(RDF_NIL);
    const nodes = items.map(() => this.bnode());
    nodes.forEach((n, i) => {
      this.add(n, iri(RDF_FIRST), items[i]!);
      this.add(n, iri(RDF_REST), i + 1 < nodes.length ? nodes[i + 1]! : iri(RDF_NIL));
    });
    return nodes[0]!;
  }
  /** Append every triple of another graph (blank nodes are re-labelled to stay distinct). */
  merge(other: Graph): this {
    const remap = new Map<string, BlankNode>();
    const m = <T extends Term>(t: T): T => {
      if (t.termType !== 'BlankNode') return t;
      let b = remap.get(t.value);
      if (!b) { b = this.bnode(); remap.set(t.value, b); }
      return b as T;
    };
    for (const t of other.triples) this.add(m(t.s), t.p, m(t.o));
    return this;
  }
  objects(s: Subject, p: string): Term[] {
    return this.triples.filter(t => t.s.value === s.value && t.s.termType === s.termType && t.p.value === p).map(t => t.o);
  }
  subjectsOfType(cls: string): Subject[] {
    const out: Subject[] = []; const seen = new Set<string>();
    for (const t of this.triples) {
      if (t.p.value === RDF_TYPE && t.o.termType === 'NamedNode' && t.o.value === cls && !seen.has(termKey(t.s))) {
        seen.add(termKey(t.s)); out.push(t.s);
      }
    }
    return out;
  }
  get size(): number { return this.triples.length; }
}

/**
 * A Turtle/TriG document as a Graph, read with the substrate's own parser (`parseTrig`), so a
 * hand-written data file — the proficiency roll-up rule — can be published INSIDE a generated
 * ontology triple for triple, rather than being re-described by code that could drift from it.
 * Blank-node labels are re-minted in this graph's space. RDF 1.2 triple terms have no place in
 * a published OWL document, so meeting one is an error rather than something to drop silently.
 */
export function graphFromParsed(doc: ParsedDocument): Graph {
  const g = new Graph();
  const bnodes = new Map<string, BlankNode>();
  const bnode = (id: string): BlankNode => {
    let b = bnodes.get(id);
    if (!b) { b = g.bnode(); bnodes.set(id, b); }
    return b;
  };
  const term = (t: ParsedTerm): Term => {
    switch (t.kind) {
      case 'iri': return iri(t.iri);
      case 'bnode': return bnode(t.id);
      case 'literal': return t.language ? lang(t.value, t.language) : t.datatype ? typed(t.value, t.datatype) : str(t.value);
      default: throw new Error('graphFromParsed: an RDF 1.2 triple term cannot be published in an OWL document');
    }
  };
  for (const s of doc.subjects) {
    const subj: Subject = typeof s.subject === 'string' ? iri(s.subject) : bnode(s.subject.bnode);
    for (const [p, os] of s.properties) for (const o of os) g.add(subj, iri(p), term(o));
  }
  return g;
}

/** Parse Turtle (or TriG, graphs flattened) into a Graph. */
export const parseTurtle = (text: string): Graph => graphFromParsed(parseTrig(text));

// ── Prefixes ─────────────────────────────────────────────────────────────────────────────────
export type Prefixes = Readonly<Record<string, string>>;

/** The conservative PN_LOCAL subset we emit as a prefixed name; anything else is written `<…>`. */
const SAFE_LOCAL = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const SAFE_LOCAL_DIGIT = /^[0-9][A-Za-z0-9_-]*$/; // PN_LOCAL may start with a digit

/** `prefix:local` for an IRI under one of `prefixes`, or null. Longest namespace wins. */
export function compactIri(value: string, prefixes: Prefixes): string | null {
  let best: [string, string] | null = null;
  for (const [p, ns] of Object.entries(prefixes)) {
    if (value.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns];
  }
  if (!best) return null;
  const local = value.slice(best[1].length);
  if (local === '') return `${best[0]}:`;
  return SAFE_LOCAL.test(local) || SAFE_LOCAL_DIGIT.test(local) ? `${best[0]}:${local}` : null;
}

function usedNamespaces(g: Graph, prefixes: Prefixes, extra: readonly string[] = []): Record<string, string> {
  const used = new Set<string>();
  const note = (v: string): void => {
    const c = compactIri(v, prefixes);
    if (c) used.add(c.slice(0, c.indexOf(':')));
  };
  for (const t of g.triples) {
    for (const x of [t.s, t.p, t.o]) {
      if (x.termType === 'NamedNode') note(x.value);
      else if (x.termType === 'Literal' && x.datatype) note(x.datatype);
    }
  }
  for (const e of extra) used.add(e);
  const out: Record<string, string> = {};
  for (const [p, ns] of Object.entries(prefixes)) if (used.has(p)) out[p] = ns;
  return out;
}

// ── N-Triples ────────────────────────────────────────────────────────────────────────────────
function ntTerm(t: Term): string {
  if (t.termType === 'NamedNode') return turtleIriRef(t.value)!;
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  const body = `"${escapeTurtleLiteral(t.value)}"`;
  if (t.language) return `${body}@${t.language}`;
  if (t.datatype) return `${body}^^${turtleIriRef(t.datatype)!}`;
  return body;
}

/** RDF 1.1/1.2 N-Triples, one triple per line, in graph order. */
export function toNTriples(g: Graph): string {
  return g.triples.map(t => `${ntTerm(t.s)} ${ntTerm(t.p)} ${ntTerm(t.o)} .`).join('\n') + (g.size ? '\n' : '');
}

// ── Turtle ───────────────────────────────────────────────────────────────────────────────────
type PredObjs = Map<string, { p: NamedNode; os: Term[] }>;
interface Layout {
  bySubject: Map<string, { s: Subject; po: PredObjs }>;
  order: string[];
  refCount: Map<string, number>;
  lists: Map<string, Term[]>;   // list-head bnode → items
  listNodes: Set<string>;       // every bnode that is part of an inlined list
}

function layout(g: Graph): Layout {
  const bySubject: Layout['bySubject'] = new Map();
  const order: string[] = [];
  const refCount = new Map<string, number>();
  const restTargets = new Set<string>();
  for (const t of g.triples) {
    const k = termKey(t.s);
    let e = bySubject.get(k);
    if (!e) { e = { s: t.s, po: new Map() }; bySubject.set(k, e); order.push(k); }
    let po = e.po.get(t.p.value);
    if (!po) { po = { p: t.p, os: [] }; e.po.set(t.p.value, po); }
    po.os.push(t.o);
    if (t.o.termType === 'BlankNode') {
      refCount.set(t.o.value, (refCount.get(t.o.value) ?? 0) + 1);
      if (t.p.value === RDF_REST) restTargets.add(t.o.value);
    }
  }
  // A well-formed list: a chain of blank nodes each carrying exactly rdf:first + rdf:rest, each
  // referenced once, ending in rdf:nil. Anything less regular is written as plain triples.
  const lists = new Map<string, Term[]>();
  const listNodes = new Set<string>();
  const listCell = (b: string): { first: Term; rest: Term } | null => {
    const e = bySubject.get(`_:${b}`);
    if (!e || e.po.size !== 2) return null;
    const f = e.po.get(RDF_FIRST), r = e.po.get(RDF_REST);
    if (!f || !r || f.os.length !== 1 || r.os.length !== 1) return null;
    return { first: f.os[0]!, rest: r.os[0]! };
  };
  for (const k of order) {
    const e = bySubject.get(k)!;
    if (e.s.termType !== 'BlankNode') continue;
    const head = e.s.value;
    // A head is referenced exactly once and is nobody's rdf:rest (that would make it interior).
    if (listNodes.has(head) || restTargets.has(head) || (refCount.get(head) ?? 0) !== 1) continue;
    const items: Term[] = []; const chain: string[] = [];
    let cur: Term = e.s; let ok = true;
    while (cur.termType === 'BlankNode') {
      const cell = listCell(cur.value);
      if (!cell || chain.includes(cur.value) || (refCount.get(cur.value) ?? 0) !== 1) { ok = false; break; }
      chain.push(cur.value); items.push(cell.first); cur = cell.rest;
    }
    if (ok && cur.termType === 'NamedNode' && cur.value === RDF_NIL && chain.length > 0) {
      lists.set(head, items);
      for (const c of chain) listNodes.add(c);
    }
  }
  return { bySubject, order, refCount, lists, listNodes };
}

/** Lexical forms Turtle can write without a datatype. */
function turtleShorthand(l: Literal): string | null {
  if (!l.datatype) return null;
  if (l.datatype === XSD + 'integer' && /^[+-]?\d+$/.test(l.value)) return l.value;
  if (l.datatype === XSD + 'decimal' && /^[+-]?\d*\.\d+$/.test(l.value)) return l.value;
  if (l.datatype === XSD + 'boolean' && (l.value === 'true' || l.value === 'false')) return l.value;
  return null;
}

/** Serialize as readable Turtle: subjects in first-appearance order, `a` first, nested
 *  blank nodes inline (indented when they carry more than two predicates), rdf:Lists as
 *  `( … )`. `header` is emitted as `#` comment lines. */
export function toTurtle(g: Graph, prefixes: Prefixes, opts: { header?: readonly string[] } = {}): string {
  const used = usedNamespaces(g, prefixes);
  const L = layout(g);
  const pad = (d: number): string => '    '.repeat(d);
  // `depth` is the indentation level of the predicate lines that contain this term.
  // `a` abbreviates rdf:type in the PREDICATE position only (Turtle §2.4): an rdf:type object —
  // a SHACL path `sh:path rdf:type` — printed as `a` is not Turtle.
  const ref = (t: Term, depth: number): string => {
    if (t.termType === 'NamedNode') return compactIri(t.value, used) ?? turtleIriRef(t.value)!;
    if (t.termType === 'BlankNode') {
      const items = L.lists.get(t.value);
      if (items) {
        const parts = items.map(i => ref(i, depth + 1));
        const flat = `( ${parts.join(' ')} )`;
        if (!items.length) return '()';
        return flat.length <= 100 && !flat.includes('\n') ? flat : `(\n${parts.map(x => pad(depth + 1) + x).join('\n')}\n${pad(depth)})`;
      }
      const refs = L.refCount.get(t.value) ?? 0;
      const e = L.bySubject.get(`_:${t.value}`);
      if (refs === 1 && e && !L.listNodes.has(t.value)) {
        if (e.po.size <= 2) {
          const flat = `[ ${predicateObjects(e.po, depth + 1, ' ; ')} ]`;
          if (flat.length <= 100 && !flat.includes('\n')) return flat;
        }
        return `[\n${pad(depth + 1)}${predicateObjects(e.po, depth + 1, ` ;\n${pad(depth + 1)}`)}\n${pad(depth)}]`;
      }
      if (refs === 1 && !e) return '[]';
      return `_:${t.value}`;
    }
    const sh = turtleShorthand(t);
    if (sh !== null) return sh;
    const body = `"${escapeTurtleLiteral(t.value)}"`;
    if (t.language) return `${body}@${t.language}`;
    if (t.datatype) return `${body}^^${compactIri(t.datatype, used) ?? turtleIriRef(t.datatype)!}`;
    return body;
  };
  const objects = (os: Term[], depth: number): string => {
    const parts = os.map(o => ref(o, depth));
    const flat = parts.join(' , ');
    return flat.length <= 100 && !flat.includes('\n') ? flat : parts.join(` ,\n${pad(depth + 1)}`);
  };
  const predicateObjects = (po: PredObjs, depth: number, sep: string): string => {
    const entries = [...po.values()];
    const typeFirst = [...entries.filter(e => e.p.value === RDF_TYPE), ...entries.filter(e => e.p.value !== RDF_TYPE)];
    return typeFirst.map(e => `${e.p.value === RDF_TYPE ? 'a' : ref(e.p, depth)} ${objects(e.os, depth)}`).join(sep);
  };
  const lines: string[] = [];
  for (const h of opts.header ?? []) lines.push(`# ${h}`.trimEnd());
  if (opts.header?.length) lines.push('');
  for (const [p, ns] of Object.entries(used)) lines.push(`@prefix ${p}: ${turtleIriRef(ns)!} .`);
  lines.push('');
  for (const k of L.order) {
    const e = L.bySubject.get(k)!;
    if (e.s.termType === 'BlankNode') {
      const v = e.s.value;
      const refs = L.refCount.get(v) ?? 0;
      if (L.listNodes.has(v) || refs === 1) continue; // printed inline where it is referenced
      if (refs === 0) { lines.push(`[\n${pad(1)}${predicateObjects(e.po, 1, ` ;\n${pad(1)}`)}\n] .`, ''); continue; }
    }
    lines.push(`${ref(e.s, 0)} ${predicateObjects(e.po, 1, ` ;\n${pad(1)}`)} .`, '');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

// ── RDF/XML ──────────────────────────────────────────────────────────────────────────────────
const xmlEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\r/g, '&#13;');
const NCNAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;

/** Serialize as RDF/XML (striped, one rdf:Description per subject). Throws if a predicate IRI
 *  cannot be written as an XML qualified name — no Foxxi predicate is like that. */
export function toRdfXml(g: Graph, prefixes: Prefixes): string {
  const nsByUri = new Map<string, string>(); // namespace → prefix
  for (const [p, ns] of Object.entries(prefixes)) if (NCNAME.test(p) && !nsByUri.has(ns)) nsByUri.set(ns, p);
  nsByUri.set(RDF, 'rdf');
  const declared = new Map<string, string>([[RDF, 'rdf']]);
  let gen = 0;
  const qname = (u: string): string => {
    let best: string | null = null;
    for (const ns of nsByUri.keys()) if (u.startsWith(ns) && NCNAME.test(u.slice(ns.length)) && (!best || ns.length > best.length)) best = ns;
    if (best) { declared.set(best, nsByUri.get(best)!); return `${nsByUri.get(best)}:${u.slice(best.length)}`; }
    const m = /^(.*[#/])([A-Za-z_][A-Za-z0-9._-]*)$/.exec(u);
    if (!m) throw new Error(`predicate cannot be written in RDF/XML: ${u}`);
    let p = `ns${gen++}`;
    while ([...nsByUri.values()].includes(p)) p = `ns${gen++}`;
    nsByUri.set(m[1]!, p); declared.set(m[1]!, p);
    return `${p}:${m[2]}`;
  };
  const body: string[] = [];
  const bySubject = new Map<string, { s: Subject; ts: Triple[] }>();
  for (const t of g.triples) {
    const k = termKey(t.s);
    if (!bySubject.has(k)) bySubject.set(k, { s: t.s, ts: [] });
    bySubject.get(k)!.ts.push(t);
  }
  for (const { s, ts } of bySubject.values()) {
    const about = s.termType === 'NamedNode' ? `rdf:about="${xmlEsc(s.value)}"` : `rdf:nodeID="${s.value}"`;
    body.push(`  <rdf:Description ${about}>`);
    for (const t of ts) {
      const q = qname(t.p.value);
      const o = t.o;
      if (o.termType === 'NamedNode') body.push(`    <${q} rdf:resource="${xmlEsc(o.value)}"/>`);
      else if (o.termType === 'BlankNode') body.push(`    <${q} rdf:nodeID="${o.value}"/>`);
      else {
        const attr = o.language ? ` xml:lang="${xmlEsc(o.language)}"` : o.datatype ? ` rdf:datatype="${xmlEsc(o.datatype)}"` : '';
        body.push(`    <${q}${attr}>${xmlEsc(o.value)}</${q}>`);
      }
    }
    body.push('  </rdf:Description>');
  }
  const ns = [...declared.entries()].map(([u, p]) => `    xmlns:${p}="${xmlEsc(u)}"`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<rdf:RDF\n${ns}>\n${body.join('\n')}\n</rdf:RDF>\n`;
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────────────────────
/** A JSON-LD term definition this writer understands: an alias for one predicate, optionally
 *  coercing IRI values (`@id`) or carrying a default language. */
export interface JsonLdTerm { readonly '@id': string; readonly '@type'?: '@id'; readonly '@language'?: string }

/** Predicates whose English values are written as plain strings. Keyed by their compact IRI,
 *  which JSON-LD 1.1 permits as a term when it expands to the same IRI (§4.2 IRI mapping). */
export const ENGLISH_ANNOTATIONS: readonly string[] = [
  RDFS + 'label', RDFS + 'comment', SKOS + 'prefLabel', SKOS + 'altLabel', SKOS + 'definition',
  SKOS + 'scopeNote', SKOS + 'note', SKOS + 'example', SKOS + 'editorialNote', SKOS + 'historyNote',
  DCT + 'title', DCT + 'description', DCT + 'rights', DCT + 'bibliographicCitation', SH + 'message',
  SH + 'name', SH + 'description',
];

export interface JsonLdOptions {
  /** Short-name aliases, e.g. `{ label: { '@id': RDFS+'label', '@language': 'en' } }`. */
  readonly terms?: Readonly<Record<string, JsonLdTerm | string>>;
  /** Extra top-level members (HAL `_links`, …); ignored by JSON-LD processing. */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Subjects to emit first, in this order (the ontology node, conventionally). */
  readonly first?: readonly string[];
}

/** Serialize as a flat JSON-LD 1.1 document: `@context` (prefixes + term definitions) and a
 *  `@graph` of one node per subject. Lists stay as rdf:first/rdf:rest nodes. */
export function toJsonLd(g: Graph, prefixes: Prefixes, opts: JsonLdOptions = {}): Record<string, unknown> {
  const used = usedNamespaces(g, prefixes);
  const ctx: Record<string, unknown> = { ...used };
  // Aliases: predicate IRI → [key, definition]
  const alias = new Map<string, { key: string; def: JsonLdTerm }>();
  for (const [key, d] of Object.entries(opts.terms ?? {})) {
    const def: JsonLdTerm = typeof d === 'string' ? { '@id': d } : d;
    const full = expandCompact(def['@id'], { ...STD_PREFIXES, ...prefixes });
    alias.set(full, { key, def: { ...def, '@id': full } });
  }
  // Default English for annotation predicates without an explicit alias, keyed by compact IRI.
  for (const p of ENGLISH_ANNOTATIONS) {
    if (alias.has(p)) continue;
    const c = compactIri(p, used);
    if (c && g.triples.some(t => t.p.value === p)) alias.set(p, { key: c, def: { '@id': p, '@language': 'en' } });
  }
  for (const { key, def } of alias.values()) {
    const idc = compactIri(def['@id'], used) ?? def['@id'];
    if (key === idc && !def['@type'] && !def['@language']) continue; // plain compact IRI needs no entry
    ctx[key] = { '@id': idc, ...(def['@type'] ? { '@type': def['@type'] } : {}), ...(def['@language'] ? { '@language': def['@language'] } : {}) };
  }
  const id = (t: Subject | NamedNode): string => t.termType === 'BlankNode' ? `_:${t.value}` : (compactIri(t.value, used) ?? t.value);
  const value = (o: Term, def?: JsonLdTerm): unknown => {
    if (o.termType !== 'Literal') {
      if (def?.['@type'] === '@id') return id(o);
      return { '@id': id(o) };
    }
    if (o.language) return def?.['@language'] === o.language ? o.value : { '@value': o.value, '@language': o.language };
    if (o.datatype) return { '@value': o.value, '@type': compactIri(o.datatype, used) ?? o.datatype };
    // xsd:string: a plain JSON string — unless the term would read it as language-tagged.
    return def?.['@language'] ? { '@value': o.value } : o.value;
  };
  const nodes = new Map<string, Record<string, unknown>>();
  for (const t of g.triples) {
    const k = termKey(t.s);
    let n = nodes.get(k);
    if (!n) { n = { '@id': id(t.s) }; nodes.set(k, n); }
    if (t.p.value === RDF_TYPE && t.o.termType === 'NamedNode') {
      const ty = id(t.o);
      const cur = n['@type'];
      n['@type'] = cur === undefined ? ty : Array.isArray(cur) ? [...cur, ty] : [cur, ty];
      continue;
    }
    const a = alias.get(t.p.value);
    const key = a?.key ?? (compactIri(t.p.value, used) ?? t.p.value);
    const v = value(t.o, a?.def);
    const cur = n[key];
    n[key] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  const firstKeys = (opts.first ?? []).map(f => `<${f}>`);
  const ordered = [...firstKeys.filter(k => nodes.has(k)).map(k => nodes.get(k)!),
    ...[...nodes.entries()].filter(([k]) => !firstKeys.includes(k)).map(([, n]) => n)];
  return { '@context': ctx, '@graph': ordered, ...(opts.extra ?? {}) };
}

/** Expand `prefix:local` with `prefixes`; an absolute IRI is returned unchanged. */
export function expandCompact(v: string, prefixes: Prefixes): string {
  const m = /^([A-Za-z][\w.-]*):(.*)$/.exec(v);
  const base = m ? prefixes[m[1]!] : undefined;
  if (m && base !== undefined && !/^\/\//.test(m[2]!)) return base + m[2]!;
  return v;
}

// ── Content negotiation ──────────────────────────────────────────────────────────────────────
interface MediaRange { type: string; subtype: string; q: number; specificity: number }

function parseAccept(accept: string | undefined): MediaRange[] {
  if (!accept || !accept.trim()) return [{ type: '*', subtype: '*', q: 1, specificity: 0 }];
  const out: MediaRange[] = [];
  for (const part of accept.split(',')) {
    const [range, ...params] = part.trim().split(';').map(x => x.trim());
    if (!range) continue;
    const [type, subtype] = range.toLowerCase().split('/');
    if (!type || !subtype) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(p);
      if (m) q = Math.max(0, Math.min(1, Number(m[1])));
    }
    const specificity = type === '*' ? 0 : subtype === '*' ? 1 : 2 + params.filter(p => !/^q\s*=/i.test(p)).length;
    out.push({ type, subtype, q: Number.isFinite(q) ? q : 0, specificity });
  }
  return out;
}

/**
 * RFC 9110 §12.5.1 proactive negotiation: the quality of each offer is the q of the MOST SPECIFIC
 * range that matches it; the highest-quality offer wins, ties going to the server's order. Returns
 * null when nothing acceptable is offered (the caller answers 406).
 */
export function negotiate(accept: string | undefined, offers: readonly string[]): string | null {
  const ranges = parseAccept(accept);
  let best: { offer: string; q: number } | null = null;
  for (const offer of offers) {
    const [ot, os] = offer.toLowerCase().split('/');
    let match: MediaRange | null = null;
    for (const r of ranges) {
      const ok = (r.type === '*' || r.type === ot) && (r.subtype === '*' || r.subtype === os);
      if (ok && (!match || r.specificity > match.specificity)) match = r;
    }
    if (!match || match.q <= 0) continue;
    if (!best || match.q > best.q) best = { offer, q: match.q };
  }
  return best ? best.offer : null;
}
