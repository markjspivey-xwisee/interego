/**
 * RDF/JS helpers used by the native I2IDL-X build.
 * N3 is loaded through createRequire because the workspace intentionally has
 * no @types/n3 dependency. These structural types describe the actual RDF/JS
 * terms and dataset operations we consume.
 */
import { createRequire } from 'node:module';
import { turtleIriRef } from '@interego/core';
import { Graph, iri, lang, typed, str, toTurtle, toJsonLd, toNTriples, type Term as KitTerm, type Subject as KitSubject } from '../../src/ns/rdf.js';
const require = createRequire(import.meta.url);
export interface Term {
  termType: string; value: string; language?: string; datatype?: Term;
  equals(other: Term | null | undefined): boolean;
}
export interface Quad {
  subject: Term; predicate: Term; object: Term; graph: Term;
  equals(other: Quad): boolean;
}
export interface Store {
  size: number;
  addQuad(quad: Quad): this;
  addQuad(subject: Term, predicate: Term, object: Term, graph?: Term): this;
  addQuads(quads: readonly Quad[]): this;
  getQuads(subject: Term | string | null, predicate: Term | string | null, object: Term | string | null, graph: Term | string | null): Quad[];
  has(quad: Quad): boolean;
  match(subject?: Term | null, predicate?: Term | null, object?: Term | null, graph?: Term | null): Iterable<Quad>;
  [Symbol.iterator](): Iterator<Quad>;
}
export const { Store, Parser, Writer, DataFactory } = require('n3') as {
  Store: new (quads?: readonly Quad[]) => Store;
  Parser: new (options?: Record<string, unknown>) => { parse(text: string): Quad[] };
  Writer: new (options?: Record<string, unknown>) => { addQuads(quads: readonly Quad[]): void; end(callback: (error: Error | null, text: string) => void): void };
  DataFactory: {
    namedNode(value: string): Term;
    blankNode(value?: string): Term;
    literal(value: string, languageOrDatatype?: string | Term): Term;
    defaultGraph(): Term;
    quad(subject: Term, predicate: Term, object: Term, graph?: Term): Quad;
  };
};
export const nn = DataFactory.namedNode;
export const literal = DataFactory.literal;
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const DCT = 'http://purl.org/dc/terms/';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const PROV = 'http://www.w3.org/ns/prov#';
export const SH = 'http://www.w3.org/ns/shacl#';
export const GS = 'https://glossarystudio.app/ns/';
export function parseTurtle(text: string, base?: string): Store {
  return new Store(new Parser({ format: 'text/turtle', ...(base ? {baseIRI: base} : {}) }).parse(text));
}
export function union(...stores: Store[]): Store {
  const out = new Store();
  for (const graph of stores) out.addQuads(graph.getQuads(null, null, null, null));
  return out;
}
export function valueTerm(graph: Store, subject: Term | string, predicate: Term | string): Term | undefined {
  return values(graph, subject, predicate)[0];
}
export function subjectTerms(graph: Store, predicate: Term | string, object?: Term | string): Term[] {
  const terms = new Map<string, Term>();
  for (const q of graph.getQuads(null, predicate, object ?? null, null)) terms.set(q.subject.termType + ':' + q.subject.value, q.subject);
  return [...terms.values()];
}
export function values(graph: Store, subject: Term | string, predicate: Term | string): Term[] {
  return graph.getQuads(subject, predicate, null, null).map(q => q.object);
}
export function value(graph: Store, subject: Term | string, predicate: Term | string): string | undefined {
  return values(graph, subject, predicate)[0]?.value;
}
export function subjects(graph: Store, predicate: Term | string, object?: Term | string): string[] {
  return [...new Set(graph.getQuads(null, predicate, object ?? null, null).map(q => q.subject.value))];
}
export function lit(text: string): string {
  return '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n') + '"';
}
export function longLit(text: string): string {
  if (text.includes('"""')) throw new Error('Turtle long literal contains a triple quote');
  if (text.split('\n').some(line => line.startsWith('    '))) throw new Error('Long literal indent would be altered during publication');
  return '"""' + text.replaceAll('\\', '\\\\') + '"""';
}
export async function parseJsonLd(doc: unknown, base = 'https://id.i2idl.org/'): Promise<Store> {
  const jsonld = require('jsonld');
  const nquads: string = await jsonld.toRDF(doc, {format: 'application/n-quads', base});
  return new Store(new Parser({format: 'N-Quads'}).parse(nquads));
}
/** Adapt the RDF/JS query dataset to the one Foxxi graph and serializer model. */
export function toKitGraph(store: Store): Graph {
  const graph = new Graph();
  const blanks = new Map<string, KitSubject>();
  const term = (t: Term): KitTerm => {
    if (t.termType === 'NamedNode') return iri(t.value);
    if (t.termType === 'BlankNode') {
      let b = blanks.get(t.value);
      if (!b) { b = graph.bnode(); blanks.set(t.value, b); }
      return b;
    }
    if (t.termType === 'Literal') return t.language ? lang(t.value, t.language) :
      t.datatype && t.datatype.value !== XSD + 'string' ? typed(t.value, t.datatype.value) : str(t.value);
    throw new Error('I2IDL-X graph contains a term the Foxxi OWL serializer cannot publish: ' + t.termType);
  };
  for (const q of store.getQuads(null, null, null, null)) graph.add(term(q.subject) as KitSubject, iri(q.predicate.value), term(q.object));
  return graph;
}
export function fromKitGraph(graph: Graph): Store {
  const term = (t: KitTerm): Term => t.termType === 'NamedNode' ? nn(t.value) :
    t.termType === 'BlankNode' ? DataFactory.blankNode(t.value) :
    literal(t.value, t.language || (t.datatype ? nn(t.datatype) : undefined));
  return new Store(graph.triples.map(t => DataFactory.quad(term(t.s), nn(t.p.value), term(t.o))));
}
export async function serializeTurtle(graph: Store, prefixes: Record<string, string> = {}): Promise<string> {
  return toTurtle(toKitGraph(graph), prefixes);
}
export function serializeJsonLd(graph: Store, prefixes: Record<string, string> = {}): Record<string, unknown> {
  return toJsonLd(toKitGraph(graph), prefixes);
}
export function serializeNTriples(graph: Store): string { return toNTriples(toKitGraph(graph)); }
export async function construct(query: string, graph: Store): Promise<Store> {
  const { QueryEngine } = require('@comunica/query-sparql');
  const engine = new QueryEngine();
  const stream = await engine.queryQuads(query, {sources: [graph]});
  const quads: Quad[] = await stream.toArray();
  return new Store(quads);
}

/** Fail closed when an IRI cannot safely be serialized as Turtle. */
export function safeIri(value: string): string {
  const result = turtleIriRef(value);
  if (result === null) throw new Error('Invalid Turtle IRI: ' + JSON.stringify(value));
  return result;
}
