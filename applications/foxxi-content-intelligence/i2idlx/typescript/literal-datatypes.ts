/**
 * Source datatype provenance for a compatibility analysis against RDFLib.
 * RDF/JS terms, equality, quads and public serializers are unchanged.
 */
import { createRequire } from 'node:module';
import { Store, Parser, DataFactory } from 'n3';
import type { Term, DataFactory as RdfDataFactory } from '@rdfjs/types';

const XSD_STRING='http://www.w3.org/2001/XMLSchema#string';
export const MIXED_LITERAL_DATATYPE=Symbol('mixed source literal datatype');
export const UNKNOWN_LITERAL_DATATYPE=Symbol('unknown source literal datatype');
export type LiteralDatatype=string|null|typeof MIXED_LITERAL_DATATYPE|typeof UNKNOWN_LITERAL_DATATYPE;
export type LiteralDatatypes=ReadonlyMap<string,LiteralDatatype>;
export interface ParsedRdf { graph:Store; literalDatatypes:LiteralDatatypes }
const datasetOrigins=new WeakMap<Store,LiteralDatatypes>();
export function literalKey(t:Term):string {
  if(t.termType!=='Literal')throw new Error('Literal provenance requires a literal term');
  return 'Literal:'+JSON.stringify(t.value)+'@'+t.language+'^^'+t.datatype.value;
}
function record(map:Map<string,LiteralDatatype>,key:string,datatype:LiteralDatatype):void {
  const prior=map.get(key);
  if(!map.has(key)||prior===datatype)map.set(key,datatype);
  else map.set(key,prior===UNKNOWN_LITERAL_DATATYPE||datatype===UNKNOWN_LITERAL_DATATYPE?UNKNOWN_LITERAL_DATATYPE:MIXED_LITERAL_DATATYPE);
}
export function mergeLiteralDatatypes(...sources:LiteralDatatypes[]):LiteralDatatypes {
  const out=new Map<string,LiteralDatatype>();
  for(const source of sources)for(const [key,datatype]of source)record(out,key,datatype);
  return out;
}
export function literalDatatypesOf(graph:Store):LiteralDatatypes {
  const retained=datasetOrigins.get(graph);
  if(retained)return retained;
  const inferred=new Map<string,LiteralDatatype>();
  for(const q of graph)for(const t of [q.subject,q.object] as Term[])if(t.termType==='Literal') {
    // A language-tagged literal has no explicit datatype in RDFLib. For
    // non-string typed literals the RDF term itself retains the source type.
    record(inferred,literalKey(t),t.language?null:t.datatype.value!==XSD_STRING?t.datatype.value:UNKNOWN_LITERAL_DATATYPE);
  }
  return inferred;
}
export function retainLiteralDatatypes(target:Store,...sources:Store[]):void {
  datasetOrigins.set(target,mergeLiteralDatatypes(...sources.map(literalDatatypesOf)));
}
export function addQuadsWithLiteralDatatypes(target:Store,source:Store):void {
  const merged=mergeLiteralDatatypes(literalDatatypesOf(target),literalDatatypesOf(source));
  target.addQuads([...source]);datasetOrigins.set(target,merged);
}
/** Call only when an exact source-compatible analysis is requested. */
export function oracleLiteralDatatypes(graph:Store):ReadonlyMap<string,string|null> {
  const origins=literalDatatypesOf(graph),out=new Map<string,string|null>();
  for(const [key,datatype]of origins) {
    if(datatype===MIXED_LITERAL_DATATYPE||datatype===UNKNOWN_LITERAL_DATATYPE)
      throw new Error('RDFLib compatibility requires unambiguous source datatype provenance for '+key);
    out.set(key,datatype);
  }
  return out;
}
export function parseWithLiteralDatatypes(text:string,format:'Turtle'|'N-Quads'='Turtle',baseIRI?:string):ParsedRdf {
  const choices=new WeakMap<object,string|null>(),datatypes=new Map<string,LiteralDatatype>();
  const chosen=(term:Term):void=>{
    if(term.termType!=='Literal')return;
    if(!choices.has(term))throw new Error('Parser emitted a literal without source datatype provenance');
    record(datatypes,literalKey(term),choices.get(term)!);
  };
  const factory:RdfDataFactory={
    ...DataFactory,
    literal(value,languageOrDatatype) {
      const term=DataFactory.literal(value,languageOrDatatype);
      // _completeLiteral creates a discarded default term before an explicit
      // datatype/language replacement. Record only final quad terms.
      choices.set(term,languageOrDatatype&&typeof languageOrDatatype==='object'?languageOrDatatype.value:null);
      return term;
    },
    quad(subject,predicate,object,graph) {
      chosen(subject);chosen(object);
      return DataFactory.quad(subject,predicate,object,graph);
    },
  };
  const graph=new Store(new Parser({format,factory,...(baseIRI?{baseIRI}:{})}).parse(text));
  datasetOrigins.set(graph,datatypes);
  return {graph,literalDatatypes:datatypes};
}
const require=createRequire(import.meta.url);
const jsonld=require('jsonld') as {
  toRDF(input:unknown,options:Record<string,unknown>):Promise<string>;
  expand(input:unknown,options:Record<string,unknown>):Promise<unknown>;
};
/**
 * JSON-LD N-Quads omits even explicit xsd:string. Expanded value objects retain
 * source datatype/language coercion. Non-string literals keep their N-Quads type.
 */
export async function parseJsonLdWithLiteralDatatypes(document:unknown,base='https://id.i2idl.org/'):Promise<ParsedRdf> {
  const expanded=await jsonld.expand(document,{base});
  const sourceStrings=new Map<string,LiteralDatatype>();
  const walk=(value:unknown):void=>{
    if(Array.isArray(value)){for(const child of value)walk(child);return;}
    if(value===null||typeof value!=='object')return;
    const obj=value as Record<string,unknown>;
    if(Object.hasOwn(obj,'@value')) {
      // An expanded value object is a leaf. @json values are serialized by
      // toRDF; their nested JSON is data, never further JSON-LD value objects.
      if(typeof obj['@value']==='string'&&obj['@type']!=='@json') {
        const language=typeof obj['@language']==='string'?obj['@language'].toLowerCase():'';
        const datatype=typeof obj['@type']==='string'?obj['@type']:null;
        const term=DataFactory.literal(obj['@value'],language||DataFactory.namedNode(datatype??XSD_STRING));
        record(sourceStrings,literalKey(term),language?null:datatype);
      }
      return;
    }
    for(const child of Object.values(obj))walk(child);
  };
  walk(expanded);
  const parsed=parseWithLiteralDatatypes(await jsonld.toRDF(expanded,{format:'application/n-quads',base}),'N-Quads');
  const datatypes=new Map(parsed.literalDatatypes);
  for(const [key,datatype]of sourceStrings) {
    if(!datatypes.has(key))throw new Error('Expanded JSON-LD string is absent from its RDF dataset: '+key);
    datatypes.set(key,datatype);
  }
  datasetOrigins.set(parsed.graph,datatypes);
  return {graph:parsed.graph,literalDatatypes:datatypes};
}
