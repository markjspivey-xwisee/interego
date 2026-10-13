/**
 * Test support: read a Foxxi /ns document's serializations back with INDEPENDENT processors —
 * n3 for Turtle and N-Triples, the jsonld library for JSON-LD — and compare them as RDF graphs
 * (RDFC-1.0 canonical form), never as text or as one serializer's JSON layout.
 *
 * A check that reads `node['skos:inScheme']['@id']` out of the JSON tests how one writer happens
 * to lay out its output; a check over the expanded triples tests what the document SAYS, which is
 * the only thing a consumer can rely on.
 */
import { createRequire } from 'node:module';
import { Parser, Writer, type Quad } from 'n3';
import jsonld from 'jsonld';
import { RdfXmlParser } from 'rdfxml-streaming-parser';

const require = createRequire(import.meta.url);
const { canonize } = require('rdf-canonize') as {
  canonize(input: string, opts: { algorithm: 'RDFC-1.0'; inputFormat: 'application/n-quads'; maxWorkFactor?: number }): Promise<string>;
};

export const turtleQuads = (ttl: string): Quad[] => new Parser({ format: 'text/turtle' }).parse(ttl);
export const ntriplesQuads = (nt: string): Quad[] => new Parser({ format: 'application/n-triples' }).parse(nt);

/** The triples an RDF/XML processor (rdfxml-streaming-parser) reads out of a document. */
export function rdfXmlQuads(xml: string, baseIRI: string): Promise<Quad[]> {
  return new Promise((resolve, reject) => {
    const out: Quad[] = [];
    const parser = new RdfXmlParser({ baseIRI });
    parser.on('data', (q: Quad) => out.push(q));
    parser.on('error', reject);
    parser.on('end', () => resolve(out));
    parser.write(xml);
    parser.end();
  });
}

/** The triples a JSON-LD 1.1 processor reads out of a document. */
export async function jsonLdQuads(doc: unknown): Promise<Quad[]> {
  const nq = await jsonld.toRDF(doc as jsonld.JsonLdDocument, { format: 'application/n-quads' }) as unknown as string;
  return new Parser({ format: 'application/n-quads' }).parse(nq);
}

const toNQuads = (quads: readonly Quad[]): string => new Writer({ format: 'application/n-quads' }).quadsToString([...quads]);

/** RDFC-1.0 canonical N-Quads: equal strings ⇔ isomorphic graphs. A work factor of 2: an OWL
 *  document has many blank nodes alike but for where they hang (the same union of datatypes on
 *  several properties), which the default limit — set against hostile input — refuses to tell apart. */
export const canonical = (quads: readonly Quad[]): Promise<string> => canonize(toNQuads(quads), { algorithm: 'RDFC-1.0', inputFormat: 'application/n-quads', maxWorkFactor: 2 });

/** The objects of (subject, predicate) as their term values. */
export function objectsOf(quads: readonly Quad[], subject: string, predicate: string): string[] {
  return quads.filter(q => q.subject.value === subject && q.predicate.value === predicate).map(q => q.object.value);
}

/** The objects of (subject, predicate) that are IRIs (NamedNodes), not literals. */
export function iriObjectsOf(quads: readonly Quad[], subject: string, predicate: string): string[] {
  return quads.filter(q => q.subject.value === subject && q.predicate.value === predicate && q.object.termType === 'NamedNode').map(q => q.object.value);
}

/** Subjects typed `cls`. */
export function subjectsOfType(quads: readonly Quad[], cls: string): string[] {
  return [...new Set(quads.filter(q => q.predicate.value === RDF_TYPE && q.object.value === cls).map(q => q.subject.value))];
}

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const DCT = 'http://purl.org/dc/terms/';
