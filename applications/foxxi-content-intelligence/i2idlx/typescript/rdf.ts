/**
 * RDF/JS helpers used by the native I2IDL-X build.
 * The public dataset/term types are the installed N3 and RDF/JS types used by
 * Comunica and the native reasoner. Output goes through Foxxi's shared Graph.
 */
import { turtleIriRef } from '@interego/core';
import { Store, Parser, Writer, DataFactory } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import type { Term, Quad, NamedNode, BlankNode, Literal } from '@rdfjs/types';
import { parseWithLiteralDatatypes, parseJsonLdWithLiteralDatatypes, retainLiteralDatatypes } from './literal-datatypes.js';
import { Graph, iri, lang, typed, str, toTurtle, toJsonLd, toNTriples,
  type Term as KitTerm, type Subject as KitSubject } from '../../src/ns/rdf.js';
export { Store, Parser, Writer, DataFactory };
export type { Term, Quad };
export const nn=DataFactory.namedNode;
export const literal=DataFactory.literal;
export const RDF='http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS='http://www.w3.org/2000/01/rdf-schema#';
export const OWL='http://www.w3.org/2002/07/owl#';
export const SKOS='http://www.w3.org/2004/02/skos/core#';
export const DCT='http://purl.org/dc/terms/';
export const XSD='http://www.w3.org/2001/XMLSchema#';
export const PROV='http://www.w3.org/ns/prov#';
export const SH='http://www.w3.org/ns/shacl#';
export const GS='https://glossarystudio.app/ns/';
export function parseTurtle(text:string,base?:string):Store {
  return parseWithLiteralDatatypes(text,'Turtle',base).graph;
}
export function union(...stores:Store[]):Store {
  const out=new Store();
  for(const graph of stores)out.addQuads(graph.getQuads(null,null,null,null));
  retainLiteralDatatypes(out,...stores);
  return out;
}
export function values(graph:Store,subject:Term|string,predicate:Term|string):Term[] {
  return graph.getQuads(subject,predicate,null,null).map(q=>q.object);
}
export function valueTerm(graph:Store,subject:Term|string,predicate:Term|string):Term|undefined {
  return values(graph,subject,predicate)[0];
}
export function subjectTerms(graph:Store,predicate:Term|string,object?:Term|string):Term[] {
  const terms=new Map<string,Term>();
  for(const q of graph.getQuads(null,predicate,object??null,null))terms.set(q.subject.termType+':'+q.subject.value,q.subject);
  return [...terms.values()];
}
export function value(graph:Store,subject:Term|string,predicate:Term|string):string|undefined {
  return values(graph,subject,predicate)[0]?.value;
}
export function subjects(graph:Store,predicate:Term|string,object?:Term|string):string[] {
  return [...new Set(graph.getQuads(null,predicate,object??null,null).map(q=>q.subject.value))];
}
export function lit(text:string):string {
  return '"' + text.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n') + '"';
}
export function longLit(text:string):string {
  if(text.includes('"""'))throw Error('Turtle long literal contains a triple quote');
  if(text.split('\n').some(line=>line.startsWith('    ')))throw Error('Long literal indent would be altered during publication');
  return '"""' + text.replaceAll('\\','\\\\') + '"""';
}
export async function parseJsonLd(doc:unknown,base='https://id.i2idl.org/'):Promise<Store> {
  return (await parseJsonLdWithLiteralDatatypes(doc,base)).graph;
}
/** Preserve blank-node identities while adapting a plain RDF graph to Foxxi. */
export function toKitGraph(store:Store):Graph {
  const graph=new Graph(),blanks=new Map<string,KitSubject>();
  const subject=(t:Term):KitSubject=>{
    if(t.termType==='NamedNode')return iri(t.value);
    if(t.termType==='BlankNode') {
      let b=blanks.get(t.value);if(!b){b=graph.bnode();blanks.set(t.value,b);}return b;
    }
    throw Error('Foxxi OWL output requires a named or blank RDF subject; got '+t.termType);
  };
  const term=(t:Term):KitTerm=>{
    if(t.termType==='NamedNode'||t.termType==='BlankNode')return subject(t);
    if(t.termType==='Literal')return t.language?lang(t.value,t.language):
      t.datatype.value!==XSD+'string'?typed(t.value,t.datatype.value):str(t.value);
    throw Error('Foxxi OWL output cannot publish an RDF term of type '+t.termType);
  };
  for(const q of store.getQuads(null,null,null,null)) {
    if(q.graph.termType!=='DefaultGraph')throw Error('A named RDF dataset cannot be flattened into a published Foxxi graph');
    graph.add(subject(q.subject),iri(q.predicate.value),term(q.object));
  }
  return graph;
}
export function fromKitGraph(graph:Graph):Store {
  const subject=(t:KitSubject):NamedNode|BlankNode=>t.termType==='NamedNode'?nn(t.value):DataFactory.blankNode(t.value);
  const term=(t:KitTerm):NamedNode|BlankNode|Literal=>{
    if(t.termType==='NamedNode'||t.termType==='BlankNode')return subject(t);
    return literal(t.value,t.language||(t.datatype?nn(t.datatype):undefined));
  };
  return new Store(graph.triples.map(t=>DataFactory.quad(subject(t.s),nn(t.p.value),term(t.o))));
}
export async function serializeTurtle(graph:Store,prefixes:Record<string,string>={}):Promise<string> {
  return toTurtle(toKitGraph(graph),prefixes);
}
export function serializeJsonLd(graph:Store,prefixes:Record<string,string>={}):Record<string,unknown> {
  return toJsonLd(toKitGraph(graph),prefixes);
}
export function serializeNTriples(graph:Store):string {return toNTriples(toKitGraph(graph));}
export async function construct(query:string,graph:Store):Promise<Store> {
  const engine=new QueryEngine(),stream=await engine.queryQuads(query,{sources:[graph]});
  const quads:Quad[]=await stream.toArray();
  return new Store(quads);
}
/** Fail closed when an IRI cannot safely be serialized as Turtle. */
export function safeIri(value:string):string {
  const result=turtleIriRef(value);
  if(result===null)throw Error('Invalid Turtle IRI: '+JSON.stringify(value));
  return result;
}
