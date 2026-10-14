import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from 'n3';
import { parseWithLiteralDatatypes, oracleLiteralDatatypes } from './literal-datatypes.js';
import { sourceLiteralRecords, applyOracleLiteralNormalizations, type OracleLiteralNormalization } from './reasoning-probe-input.js';

const XSD='http://www.w3.org/2001/XMLSchema#';
const prefix='@prefix : <urn:normalization-test:> . @prefix xsd: <'+XSD+'> . ';
const keys=(graph:Store)=>[...graph].map(q=>[q.subject,q.predicate,q.object,q.graph].map(t=>t.termType+':'+t.value+(t.termType==='Literal'?'@'+t.language+'^^'+t.datatype.value:'')).join('|')).sort();
const reply=(graph:Store):OracleLiteralNormalization[]=>sourceLiteralRecords(graph).map(record=>({...record,normalized:record.value,normalizedLanguage:record.language,normalizedDatatype:record.datatype}));

describe('private oracle-normalized reasoning input',()=>{
  it('changes only the private lexical forms and retains blank labels, language and explicit source types',()=>{
    const graph=parseWithLiteralDatatypes(prefix+'_:fixed :p "-1.0E0"^^xsd:double, "2024-02-04T11:18:50Z"^^xsd:dateTime, "plain", "English"@en, "typed"^^xsd:string .').graph;
    const before=keys(graph),origins=[...oracleLiteralDatatypes(graph)];
    const response=reply(graph).map(record=>({...record,normalized:record.datatype===XSD+'double'?'-1.0':record.datatype===XSD+'dateTime'?'2024-02-04T11:18:50+00:00':record.value}));
    const copy=applyOracleLiteralNormalizations(graph,response);
    assert.notEqual(copy.graph,graph);assert.deepEqual(keys(graph),before);assert.deepEqual([...oracleLiteralDatatypes(graph)],origins);
    assert.equal(copy.changedLiteralForms,2);assert.equal(copy.originalTriples,5);assert.equal(copy.normalizedTriples,5);
    assert.deepEqual([...copy.graph].map(q=>q.subject.value),[...graph].map(q=>q.subject.value));
    assert.ok([...copy.graph].every(q=>q.subject.termType==='BlankNode'));
    for(const [key,datatype]of copy.datatypeOrigins) {
      if(key.includes('"plain"')||key.includes('"English"'))assert.equal(datatype,null);
      if(key.includes('"typed"'))assert.equal(datatype,XSD+'string');
    }
    assert.ok([...copy.graph].some(q=>q.object.value==='-1.0'));
    assert.ok([...copy.graph].some(q=>q.object.value==='2024-02-04T11:18:50+00:00'));
  });
  it('reports actual normalization collisions while preserving the original graph',()=>{
    const graph=parseWithLiteralDatatypes(prefix+':s :p "1.0E0"^^xsd:double, "1.0"^^xsd:double .').graph;
    const copy=applyOracleLiteralNormalizations(graph,reply(graph).map(record=>({...record,normalized:'1.0'})));
    assert.equal(graph.size,2);assert.equal(copy.originalTriples,2);assert.equal(copy.normalizedTriples,1);
    assert.equal(copy.changedLiteralForms,1);assert.equal(copy.datatypeOrigins.size,1);
  });
  it('refuses normalized collisions between simple and explicit legacy datatype syntax',()=>{
    const graph=parseWithLiteralDatatypes(prefix+':s :p "plain", "typed"^^xsd:string .').graph;
    assert.throws(()=>applyOracleLiteralNormalizations(graph,reply(graph).map(record=>({...record,normalized:'same'}))),/distinct source datatype syntax/);
    assert.equal(graph.size,2);
  });
  it('requires complete, unique source responses and unchanged source identity and RDF datatype/language',()=>{
    const graph=parseWithLiteralDatatypes(prefix+':s :p "42"^^xsd:integer .').graph,response=reply(graph);
    assert.throws(()=>applyOracleLiteralNormalizations(graph,[]),/cover every source literal/);
    assert.throws(()=>applyOracleLiteralNormalizations(graph,[...response,...response]),/unknown or duplicate/);
    assert.throws(()=>applyOracleLiteralNormalizations(graph,response.map(record=>({...record,key:'unknown'}))),/unknown or duplicate/);
    assert.throws(()=>applyOracleLiteralNormalizations(graph,response.map(record=>({...record,value:'changed'}))),/source identity/);
    assert.throws(()=>applyOracleLiteralNormalizations(graph,response.map(record=>({...record,normalizedDatatype:XSD+'string'}))),/changed datatype or language/);
    assert.throws(()=>applyOracleLiteralNormalizations(graph,response.map(record=>({...record,normalizedLanguage:'en'}))),/changed datatype or language/);
  });
});
