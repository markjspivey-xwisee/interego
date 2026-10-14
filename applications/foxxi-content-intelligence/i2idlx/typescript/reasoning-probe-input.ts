/**
 * Diagnostic-only private input copy using literal lexical forms returned by
 * the pinned independent RDFLib oracle. Never changes source/public graphs.
 */
import { Store, DataFactory } from 'n3';
import type { Term } from '@rdfjs/types';
import { literalKey, oracleLiteralDatatypes } from './literal-datatypes.js';

const XSD_STRING='http://www.w3.org/2001/XMLSchema#string';
export interface SourceLiteralRecord {
  key:string;value:string;language:string;datatype:string|null;
}
export interface OracleLiteralNormalization extends SourceLiteralRecord {
  normalized:string;normalizedLanguage:string;normalizedDatatype:string|null;
}
export interface NormalizedOracleInput {
  graph:Store;datatypeOrigins:ReadonlyMap<string,string|null>;
  changedLiteralForms:number;originalTriples:number;normalizedTriples:number;
}
export function sourceLiteralRecords(input:Store):SourceLiteralRecord[] {
  const origins=oracleLiteralDatatypes(input),records=new Map<string,SourceLiteralRecord>();
  for(const q of input)for(const term of [q.subject,q.object] as Term[])if(term.termType==='Literal') {
    const key=literalKey(term);
    if(!origins.has(key))throw new Error('Source literal has no datatype provenance: '+key);
    records.set(key,{key,value:term.value,language:term.language,datatype:origins.get(key)!});
  }
  return [...records.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
}
/**
 * All literal values must come from RDFLib itself. Validate exact coverage and
 * source type/language before replacing only lexical forms in a private copy.
 * A normalized collision with incompatible source datatype syntax is refused.
 */
export function applyOracleLiteralNormalizations(input:Store,normalized:OracleLiteralNormalization[]):NormalizedOracleInput {
  const source=sourceLiteralRecords(input),expected=new Map(source.map(record=>[record.key,record]));
  const replacements=new Map<string,OracleLiteralNormalization>();
  for(const record of normalized) {
    const original=expected.get(record.key);
    if(!original||replacements.has(record.key))throw new Error('Oracle literal response has an unknown or duplicate source key: '+record.key);
    if(record.value!==original.value||record.language!==original.language||record.datatype!==original.datatype)
      throw new Error('Oracle literal response changed its source identity: '+record.key);
    if(typeof record.normalized!=='string'||record.normalizedLanguage!==original.language||record.normalizedDatatype!==original.datatype)
      throw new Error('Oracle literal normalization changed datatype or language: '+record.key);
    replacements.set(record.key,record);
  }
  if(replacements.size!==expected.size)throw new Error('Oracle literal response does not cover every source literal');
  const datatypeOrigins=new Map<string,string|null>(),graph=new Store();
  const replace=(term:Term):Term=>{
    if(term.termType!=='Literal')return term;
    const record=replacements.get(literalKey(term))!;
    const literal=DataFactory.literal(record.normalized,record.language||DataFactory.namedNode(record.datatype??XSD_STRING));
    const key=literalKey(literal);
    if(datatypeOrigins.has(key)&&datatypeOrigins.get(key)!==record.datatype)
      throw new Error('Normalized RDF/JS literals cannot preserve distinct source datatype syntax: '+key);
    datatypeOrigins.set(key,record.datatype);
    return literal;
  };
  for(const q of input) {
    // This probe's input is ordinary RDF. Its closure may later use generalized
    // literal subjects, but no source quad is silently dropped or reclassified.
    if((q.subject as Term).termType==='Literal')throw new Error('Shared oracle input requires ordinary RDF subjects');
    const object=replace(q.object) as typeof q.object;
    graph.addQuad(DataFactory.quad(q.subject,q.predicate,object,q.graph));
  }
  return {graph,datatypeOrigins,changedLiteralForms:source.filter(record=>replacements.get(record.key)!.normalized!==record.value).length,
    originalTriples:input.size,normalizedTriples:graph.size};
}
