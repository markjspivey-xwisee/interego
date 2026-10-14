import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Parser, Store, DataFactory } from 'n3';
import { parseWithLiteralDatatypes, parseJsonLdWithLiteralDatatypes, literalKey, literalDatatypesOf,
  oracleLiteralDatatypes, retainLiteralDatatypes, addQuadsWithLiteralDatatypes, sourceLiteral } from './literal-datatypes.js';
import { closure, has, RDF, XSD } from './reasoning.js';

const prefixes='@prefix : <urn:source-test:> . @prefix xsd: <'+XSD+'> . ';
const keys=(g:Store)=>[...g].map(q=>[q.subject,q.predicate,q.object,q.graph].map(t=>t.termType+':'+t.value+(t.termType==='Literal'?'@'+t.language+'^^'+t.datatype.value:'')).join('|')).sort();
const object=(g:Store,s:string)=>g.getQuads(DataFactory.namedNode('urn:source-test:'+s),null,null,null)[0]!.object;

describe('literal source provenance without changing RDF/JS graphs',()=>{
  it('retains plain, language and explicit datatype syntax while returning identical RDF quads',()=>{
    const text=prefixes+':plain :p "plain" . :language :p "English"@en . :explicit :p "typed"^^xsd:string . :number :p "42"^^xsd:integer . ';
    const parsed=parseWithLiteralDatatypes(text);
    assert.deepEqual(keys(parsed.graph),keys(new Store(new Parser().parse(text))));
    const origins=oracleLiteralDatatypes(parsed.graph);
    assert.equal(origins.get(literalKey(object(parsed.graph,'plain'))),null);
    assert.equal(origins.get(literalKey(object(parsed.graph,'language'))),null);
    assert.equal(origins.get(literalKey(object(parsed.graph,'explicit'))),XSD+'string');
    assert.equal(origins.get(literalKey(object(parsed.graph,'number'))),XSD+'integer');
  });
  it('creates supported literals with N3 and refuses directional literals before any direction can be discarded',()=>{
    const plain=sourceLiteral('plain'),language=sourceLiteral('English','en');
    const type=DataFactory.namedNode(XSD+'string'),typed=sourceLiteral('typed',type);
    assert.equal(plain.term.equals(DataFactory.literal('plain')),true);assert.equal(plain.datatype,null);
    assert.equal(language.term.equals(DataFactory.literal('English','en')),true);assert.equal(language.datatype,null);
    assert.equal(typed.term.equals(DataFactory.literal('typed',type)),true);assert.equal(typed.datatype,XSD+'string');
    const directional={language:'en',direction:'rtl'} as const;
    assert.throws(()=>sourceLiteral('English',directional),/refusing to discard their direction/);
    assert.deepEqual(directional,{language:'en',direction:'rtl'});
  });
  it('records the selected explicit term rather than the parser\'s discarded default literal',()=>{
    const parsed=parseWithLiteralDatatypes(prefixes+':s :p "typed"^^xsd:string .');
    assert.equal(oracleLiteralDatatypes(parsed.graph).get(literalKey(object(parsed.graph,'s'))),XSD+'string');
  });
  it('preserves source provenance across recreated Store terms and successive union additions',()=>{
    const a=parseWithLiteralDatatypes(prefixes+':a :p "simple" .').graph;
    const b=parseWithLiteralDatatypes(prefixes+':b :p "typed"^^xsd:string .').graph;
    const copy=new Store([...a]);retainLiteralDatatypes(copy,a);
    const output=new Store();addQuadsWithLiteralDatatypes(output,copy);addQuadsWithLiteralDatatypes(output,b);
    assert.deepEqual(keys(output),keys(new Store([...a,...b])));
    assert.equal(oracleLiteralDatatypes(output).get(literalKey(object(output,'a'))),null);
    assert.equal(oracleLiteralDatatypes(output).get(literalKey(object(output,'b'))),XSD+'string');
  });
  it('keeps valid mixed-syntax RDF canonical and refuses only the unrepresentable compatibility analysis',()=>{
    const text=prefixes+':s :p "same", "same"^^xsd:string .';
    const parsed=parseWithLiteralDatatypes(text);
    assert.equal(parsed.graph.size,1);
    assert.deepEqual(keys(parsed.graph),keys(new Store(new Parser().parse(text))));
    assert.doesNotThrow(()=>closure(parsed.graph));
    assert.throws(()=>oracleLiteralDatatypes(parsed.graph),/unambiguous source datatype provenance/);
  });
  it('refuses unknown simple-string provenance only when compatibility is requested',()=>{
    const g=new Store(new Parser().parse(prefixes+':s :p "simple" .'));
    assert.ok(literalDatatypesOf(g).size>0);
    assert.doesNotThrow(()=>closure(g));
    assert.throws(()=>oracleLiteralDatatypes(g),/unambiguous source datatype provenance/);
  });
  it('recovers explicit string coercion from JSON-LD before N-Quads omits its datatype',async()=>{
    const doc={'@context':{p:{'@id':'urn:source-test:p'},typed:{'@id':'urn:source-test:typed','@type':XSD+'string'}},
      '@id':'urn:source-test:s',p:[{'@value':'simple'},{'@value':'English','@language':'en'}],typed:'coerced'};
    const parsed=await parseJsonLdWithLiteralDatatypes(doc);
    const literals=[...parsed.graph].map(q=>q.object);
    const origins=oracleLiteralDatatypes(parsed.graph);
    for(const l of literals)assert.equal(origins.get(literalKey(l)),l.value==='coerced'?XSD+'string':null);
    assert.equal(parsed.graph.size,3);
  });
  it('treats expanded JSON literals as leaves rather than interpreting their nested data as RDF strings',async()=>{
    const doc={'@context':{json:{'@id':'urn:source-test:json','@type':'@json'}},'@id':'urn:source-test:s',
      json:{'@value':'nested data'}};
    const parsed=await parseJsonLdWithLiteralDatatypes(doc);
    assert.equal(parsed.graph.size,1);
    const value=object(parsed.graph,'s');
    assert.equal(value.termType,'Literal');
    assert.equal(value.termType==='Literal'?value.datatype.value:null,RDF+'JSON');
    assert.equal(oracleLiteralDatatypes(parsed.graph).get(literalKey(value)),RDF+'JSON');
  });
  it('uses explicit compatibility only for implicit literal typing; normal closure behavior stays unchanged',()=>{
    const parsed=parseWithLiteralDatatypes(prefixes+':plain :p "simple" . :typed :p "explicit"^^xsd:string . :language :p "English"@en .');
    const ordinary=closure(parsed.graph).graph;
    const compatible=closure(parsed.graph,{datatypeOrigins:oracleLiteralDatatypes(parsed.graph)}).graph;
    for(const s of ['plain','language']) {
      const l=object(parsed.graph,s);
      assert.equal(has(ordinary,l,RDF+'type',l.termType==='Literal'?l.datatype:DataFactory.namedNode('urn:invalid')),true);
      assert.equal(has(compatible,l,RDF+'type',l.termType==='Literal'?l.datatype:DataFactory.namedNode('urn:invalid')),false);
      assert.equal(has(compatible,l,'http://www.w3.org/2002/07/owl#sameAs',l),true);
    }
    assert.equal(closure(parsed.graph).coverage.mode,'native-owlrl-rdfjs');
    assert.equal(closure(parsed.graph,{datatypeOrigins:oracleLiteralDatatypes(parsed.graph)}).coverage.mode,'native-owlrl-oracle-compatible');
    const typed=object(parsed.graph,'typed');
    assert.equal(has(compatible,typed,RDF+'type',DataFactory.namedNode(XSD+'string')),true);
  });
});
