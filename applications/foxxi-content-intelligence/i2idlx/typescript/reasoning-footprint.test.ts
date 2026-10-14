import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import { parseWithLiteralDatatypes, oracleLiteralDatatypes } from './literal-datatypes.js';
import { closure, validLexical, subjects, objects, has, RDF, OWL, XSD, termKey } from './reasoning.js';

const ERRNS='http://www.daml.org/2002/03/agents/agent-ont#';
const prefix='@prefix : <urn:footprint-test:> . @prefix owl: <'+OWL+'> . @prefix xsd: <'+XSD+'> . ';
const parse=(body:string)=>parseWithLiteralDatatypes(prefix+body).graph;
const reports=(graph:Store)=>subjects(graph,RDF+'type',DataFactory.namedNode(ERRNS+'ErrorMessage'));
const messages=(graph:Store)=>reports(graph).flatMap(node=>objects(graph,node,ERRNS+'error').map(term=>term.value)).sort();
const coreKeys=(graph:Store)=> {
  const reportSubjects=new Set(reports(graph).map(termKey));
  return [...graph].filter(q=>!reportSubjects.has(termKey(q.subject))).map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort();
};
const compatible=(graph:Store,extra:{maxTriples?:number}={})=>closure(graph,{datatypeOrigins:oracleLiteralDatatypes(graph),...extra});

describe('explicit source-compatible OWL-RL error-report footprint',()=>{
  it('keeps IEEE zero valid by default and retains the measured legacy report only in compatible output',()=>{
    const input=parse(':s :p "0.0E0"^^xsd:double .'),before=coreKeys(input);
    const zero=[...input][0]!.object;
    assert.equal(zero.termType,'Literal');assert.equal(validLexical(zero as Parameters<typeof validLexical>[0]),true);
    const ordinary=closure(input),legacy=compatible(input);
    assert.deepEqual(ordinary.errors,[]);assert.deepEqual(legacy.errors,[]);assert.equal(reports(ordinary.graph).length,0);
    assert.deepEqual(messages(legacy.graph),["Lexical value of the literal '0.0' does not match its datatype ("+XSD+"double)"]);
    assert.equal(legacy.graph.size,ordinary.graph.size+2);assert.deepEqual(coreKeys(legacy.graph),coreKeys(ordinary.graph));
    assert.deepEqual(coreKeys(input),before);assert.equal(input.size,1);
    const node=reports(legacy.graph)[0]!;
    assert.equal(legacy.graph.countQuads(node,null,null,null),2);
    assert.equal(has(legacy.graph,node,OWL+'sameAs',node),false);
  });
  it('deduplicates equal reports and preserves signed-zero and datatype-specific messages',()=>{
    const repeated=compatible(parse(':a :p "0"^^xsd:double . :b :p "0.0E0"^^xsd:double .'));
    assert.equal(reports(repeated.graph).length,1);
    const distinct=compatible(parse(':a :p "0.0"^^xsd:double . :b :p "-0.0"^^xsd:double . :c :p "0.0"^^xsd:float .'));
    assert.deepEqual(messages(distinct.graph),[
      "Lexical value of the literal '-0.0' does not match its datatype ("+XSD+"double)",
      "Lexical value of the literal '0.0' does not match its datatype ("+XSD+"double)",
      "Lexical value of the literal '0.0' does not match its datatype ("+XSD+"float)",
    ].sort());
    assert.deepEqual(distinct.errors,[]);
  });
  it('emits no zero defect report for simple strings, explicit strings, language literals or nonzero numerics',()=>{
    const input=parse(':a :p "0.0" . :b :p "zero"^^xsd:string . :c :p "zero"@en . :d :p "1.0"^^xsd:double .');
    const result=compatible(input);assert.equal(reports(result.graph).length,0);assert.deepEqual(result.errors,[]);
  });
  it('retains real error messages with exact post-saturation metadata and keeps additional layer Nothing strings separate',()=>{
    const disjoint=compatible(parse(':A owl:disjointWith :B . :x a :A,:B .'));
    assert.deepEqual(messages(disjoint.graph),disjoint.errors);
    const nothing=compatible(parse(':x a owl:Nothing .'));
    assert.ok(nothing.errors.includes("urn:footprint-test:x is defined of type 'Nothing'"));
    assert.ok(nothing.errors.includes('urn:footprint-test:x is owl:Nothing'));
    assert.ok(messages(nothing.graph).includes("urn:footprint-test:x is defined of type 'Nothing'"));
    assert.ok(!messages(nothing.graph).includes('urn:footprint-test:x is owl:Nothing'));
    for(const node of reports(disjoint.graph)) {
      assert.equal(disjoint.graph.countQuads(node,null,null,null),2);
      assert.equal(has(disjoint.graph,node,OWL+'sameAs',node),false);
    }
  });
  it('applies final report limits after actual generalized-predicate cleanup while retaining the saturation peak guard',()=>{
    const input=parse(':s :p "0.0"^^xsd:double .');
    input.addQuad(DataFactory.quad(DataFactory.namedNode('urn:footprint-test:generalized-subject'),
      DataFactory.blankNode('generalized-predicate') as unknown as Quad['predicate'],
      DataFactory.namedNode('urn:footprint-test:generalized-object')));
    const baseline=compatible(input),limit=baseline.graph.size;
    assert.equal([...baseline.graph].some(q=>q.predicate.termType!=='NamedNode'),false);
    assert.equal(messages(baseline.graph).length,1);
    const bounded=compatible(input,{maxTriples:limit});
    assert.equal(bounded.graph.size,limit);assert.deepEqual(coreKeys(bounded.graph),coreKeys(baseline.graph));
    assert.deepEqual(messages(bounded.graph),messages(baseline.graph));
    assert.throws(()=>compatible(input,{maxTriples:limit-1}),/OWL saturation triple limit exceeded/);
    assert.equal(input.size,2);
  });
  it('enforces the same exact maximum at final novel report insertion',()=>{
    const input=parse(':s :p "0.0"^^xsd:double .'),baseline=compatible(input);
    assert.equal(compatible(input,{maxTriples:baseline.graph.size}).graph.size,baseline.graph.size);
    assert.throws(()=>compatible(input,{maxTriples:baseline.graph.size-1}),/OWL saturation triple limit exceeded/);
    assert.equal(input.size,1);
  });
});
