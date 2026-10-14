import {describe,it} from 'node:test';
import assert from 'node:assert/strict';

function expect(actual:unknown) {
  return {
    toBe(expected:unknown){assert.equal(actual,expected);},
    toEqual(expected:unknown){assert.deepEqual(actual,expected);},
    toHaveLength(length:number){assert.equal((actual as {length:number}).length,length);},
    toContain(value:unknown){assert.ok((actual as unknown[]).includes(value));},
    toBeGreaterThan(value:number){assert.ok(typeof actual==='number'&&actual>value);},
    toThrow(pattern:RegExp){assert.throws(actual as ()=>unknown,pattern);},
    rejects:{async toThrow(pattern:RegExp){await assert.rejects(actual as Promise<unknown>,pattern);}},
  };
}
import {Store,Parser,DataFactory} from 'n3';
import {closure,dlReady,wideningRisks,RDF,RDFS,OWL,XSD,has,rdfList} from './reasoning.js';
import {shaclValidate,shaclRules} from './validation.js';

const {namedNode:nn}=DataFactory;
const prefixes='@prefix : <urn:test:> . @prefix rdf: <'+RDF+'> . @prefix rdfs: <'+RDFS+'> . @prefix owl: <'+OWL+'> . @prefix xsd: <'+XSD+'> . @prefix sh: <http://www.w3.org/ns/shacl#> . ';
const graph=(body:string)=>new Store(new Parser().parse(prefixes+body));
const typed=(g:Store,n:string,c:string)=>has(g,nn('urn:test:'+n),RDF+'type',nn('urn:test:'+c));

describe('native OWL RL saturation',()=>{
  it('classifies a referent through nested hasValue/someValuesFrom restrictions and class bridges',()=>{
    const input=graph(' :concept :category :person . :alice :classifiedBy :concept . '+
      ' [owl:onProperty :category; owl:hasValue :person] rdfs:subClassOf :ConceptForPerson . '+
      ' [owl:onProperty :classifiedBy; owl:someValuesFrom :ConceptForPerson] rdfs:subClassOf :PersonReferent . '+
      ' :PersonReferent rdfs:subClassOf :Person . :Person rdfs:subClassOf :Agent . ');
    const result=closure(input);
    expect(typed(result.graph,'alice','PersonReferent')).toBe(true);
    expect(typed(result.graph,'alice','Agent')).toBe(true);
    expect(result.errors).toEqual([]);
    expect(input.size).toBe(10);
  });
  it('derives classification from an exact crosswalk bridge, without inventing existential witnesses',()=>{
    const input=graph(' :peerClass owl:equivalentClass [owl:onProperty :classifiedBy;owl:hasValue :concept] . '+
      ' :item a :peerClass . :other a [owl:onProperty :missing;owl:someValuesFrom :Target] . ');
    const result=closure(input);
    expect(has(result.graph,nn('urn:test:item'),'urn:test:classifiedBy',nn('urn:test:concept'))).toBe(true);
    expect(result.graph.getQuads(nn('urn:test:other'),nn('urn:test:missing'),null,null)).toHaveLength(0);
  });
  it('applies property chains, inverse properties and transitive properties',()=>{
    const result=closure(graph(' :grandparent owl:propertyChainAxiom (:parent :parent) . :child owl:inverseOf :parent . '+
      ' :ancestor a owl:TransitiveProperty . :parent rdfs:subPropertyOf :ancestor . :a :parent :b . :b :parent :c . '));
    expect(has(result.graph,nn('urn:test:a'),'urn:test:grandparent',nn('urn:test:c'))).toBe(true);
    expect(has(result.graph,nn('urn:test:c'),'urn:test:child',nn('urn:test:b'))).toBe(true);
    expect(has(result.graph,nn('urn:test:a'),'urn:test:ancestor',nn('urn:test:c'))).toBe(true);
  });
  it('propagates sameAs through subjects, predicates and objects',()=>{
    const result=closure(graph(' :a owl:sameAs :b . :p owl:sameAs :q . :x owl:sameAs :y . :a :p :x . '));
    expect(has(result.graph,nn('urn:test:b'),'urn:test:q',nn('urn:test:y'))).toBe(true);
  });
  it('does not collapse a key match when the final key property differs',()=>{
    const result=closure(graph(' :Person owl:hasKey (:family :number) . :a a :Person;:family :f;:number 1 . '+
      ' :b a :Person;:family :f;:number 2 . :c a :Person;:family :f;:number 1 . '));
    expect(has(result.graph,nn('urn:test:a'),OWL+'sameAs',nn('urn:test:b'))).toBe(false);
    expect(has(result.graph,nn('urn:test:a'),OWL+'sameAs',nn('urn:test:c'))).toBe(true);
  });
  it('rejects a clash found only after subclass inference',()=>{
    const result=closure(graph(' :Assessment rdfs:subClassOf :Process . :Teacher rdfs:subClassOf :Person . '+
      ' :Process owl:disjointWith :Person . :thing a :Assessment,:Teacher . '));
    expect(result.errors.some(e=>e.includes('urn:test:Process')&&e.includes('urn:test:Person')&&e.includes('urn:test:thing'))).toBe(true);
  });
  it('checks the last member of AllDisjointClasses and AllDifferent lists',()=>{
    const result=closure(graph(' [] a owl:AllDisjointClasses;owl:members (:A :B :C) . :x a :A,:C . '+
      ' [] a owl:AllDifferent;owl:distinctMembers (:a :b :c) . :a owl:sameAs :c . '));
    expect(result.errors.some(e=>e.startsWith('Disjoint classes urn:test:A and urn:test:C'))).toBe(true);
    expect(result.errors.some(e=>e.includes('AllDifferent'))).toBe(true);
  });
  it('accepts IEEE floating point zero and rejects invalid boolean/integer lexical forms',()=>{
    expect(closure(graph(' :x :p "0.0"^^xsd:double,"-0"^^xsd:float . ')).errors).toEqual([]);
    const result=closure(graph(' :x :p "2"^^xsd:boolean,"128"^^xsd:byte . '));
    expect(result.errors.filter(e=>e.startsWith('Lexical value'))).toHaveLength(2);
  });
  it('rejects distinct same-datatype data values equated by a functional property',()=>{
    const result=closure(graph(' :flag a owl:FunctionalProperty . :x :flag true,false . '));
    expect(result.errors.some(e=>e.startsWith('Distinct data values equated:'))).toBe(true);
    const equal=closure(graph(' :flag a owl:FunctionalProperty . :x :flag "true"^^xsd:boolean,"1"^^xsd:boolean . '));
    expect(equal.errors).toEqual([]);
  });
  it('recognizes a proven sameAs spelling of rdf:nil as the list terminator',()=>{
    const g=graph(' rdf:nil owl:sameAs :nilAlias . :list rdf:first :A; rdf:rest :nilAlias . ');
    expect(rdfList(g,nn('urn:test:list')).map(n=>n.value)).toEqual(['urn:test:A']);
  });
  it('keeps non-equivalent multiple list values malformed',()=>{
    const malformed=graph(' :list rdf:first :A,:B;rdf:rest rdf:nil . ');
    expect(()=>rdfList(malformed,nn('urn:test:list'))).toThrow(/non-equivalent/);
  });
  it('fails closed on cyclic RDF lists and saturation resource limits',()=>{
    const bad=graph(' :l rdf:first :p; rdf:rest :l . :chain owl:propertyChainAxiom :l . ');
    expect(()=>rdfList(bad,nn('urn:test:l'))).toThrow(/Cyclic/);
    expect(()=>closure(bad)).toThrow(/Cyclic/);
    expect(()=>closure(graph(' :x a :Y . '),{maxTriples:1})).toThrow(/limit/);
  });
});

describe('DL consistency input and widening proof gate',()=>{
  it('drops imports and named data values while preserving blank-node restriction values',()=>{
    const input=graph(' :onto owl:imports <https://example.invalid/> . :named :score 2 . '+
      ' :Class rdfs:subClassOf [owl:onProperty :score;owl:hasValue 2] . ');
    const ready=dlReady(input);
    expect(ready.getQuads(null,nn(OWL+'imports'),null,null)).toHaveLength(0);
    expect(ready.getQuads(nn('urn:test:named'),nn('urn:test:score'),null,null)).toHaveLength(0);
    expect(ready.getQuads(null,nn(OWL+'hasValue'),null,null)).toHaveLength(1);
  });
  it('widens an unused pattern-only datatype and reports zero semantic risks',()=>{
    const input=graph(' :p rdfs:range [owl:onDatatype xsd:string;owl:withRestrictions ([xsd:pattern "[A-Z]+"])] . ');
    expect(wideningRisks(input)).toEqual({risks:[],properties:1});
    expect(has(dlReady(input),nn('urn:test:p'),RDFS+'range',nn(XSD+'string'))).toBe(true);
  });
  it('detects restriction use of a property whose data range is widened through a subproperty',()=>{
    const input=graph(' :p rdfs:range xsd:date . :sub rdfs:subPropertyOf :p . '+
      ' :Class rdfs:subClassOf [owl:onProperty :sub;owl:someValuesFrom xsd:string] . ');
    expect(wideningRisks(input).risks).toContain('a class expression uses urn:test:sub, whose data range is widened');
  });
  it('detects an off-map literal read by HermiT in hasValue',()=>{
    const input=graph(' :Class rdfs:subClassOf [owl:onProperty :p;owl:hasValue "2026-10-14"^^xsd:date] . ');
    expect(wideningRisks(input).risks.some(x=>x.includes('made plain'))).toBe(true);
  });
});

describe('native SHACL Core and TripleRule',()=>{
  it('checks inverse and sequence equals paths for a proper replacement',async()=>{
    const shapes=graph(' :S a sh:NodeShape;sh:targetClass :Proposal;sh:property '+
      ' [sh:path (:replaces :subject);sh:equals :subject], [sh:path [sh:inversePath :isReplacedBy];sh:equals :replaces] . ');
    const valid=graph(' :old a :Proposal;:subject :concept;:isReplacedBy :new . :new a :Proposal;:subject :concept;:replaces :old . ');
    // Only replacements have targets for this isolated fixture.
    const shape2=graph(' :S a sh:NodeShape;sh:targetSubjectsOf :replaces;sh:property '+
      ' [sh:path (:replaces :subject);sh:equals :subject], [sh:path [sh:inversePath :isReplacedBy];sh:equals :replaces] . ');
    expect((await shaclValidate(valid,shape2)).conforms).toBe(true);
    const invalid=graph(' :old a :Proposal;:subject :other;:isReplacedBy :new . :new a :Proposal;:subject :concept;:replaces :old . ');
    expect((await shaclValidate(invalid,shape2)).results.every(r=>r.focusNode.value==='urn:test:new')).toBe(true);
    expect((await shaclValidate(invalid,shape2)).conforms).toBe(false);
    expect(shapes.size).toBeGreaterThan(0);
  });
  it('rejects both and neither sides of the stored-query exclusive choice',async()=>{
    const shapes=graph(' :S a sh:NodeShape;sh:targetClass :Query;sh:xone ('+
      ' [sh:property [sh:path :runsAgainst;sh:minCount 1],[sh:path :runsOver;sh:maxCount 0]] '+
      ' [sh:property [sh:path :runsOver;sh:minCount 1],[sh:path :runsAgainst;sh:maxCount 0]]) . ');
    const report=await shaclValidate(graph(' :both a :Query;:runsAgainst :a;:runsOver :b . :neither a :Query . :valid a :Query;:runsOver :b . '),shapes);
    expect(new Set(report.results.map(r=>r.focusNode.value))).toEqual(new Set(['urn:test:both','urn:test:neither']));
  });
  it('enforces evidence-cited requirements, lexical ratification and decimal bounds',async()=>{
    const shapes=graph(' :S a sh:NodeShape;sh:targetClass :Proposal;'+
      ' sh:property [sh:path :confidence;sh:datatype xsd:decimal;sh:minInclusive 0;sh:maxInclusive 1];'+
      ' sh:or ([sh:not [sh:property [sh:path :method;sh:hasValue :cited]]] [sh:property [sh:path :citedIn;sh:minCount 1]]);'+
      ' sh:not [sh:and ([sh:property [sh:path :status;sh:hasValue :ratified]] [sh:property [sh:path :method;sh:hasValue :lexical]])] . ');
    const report=await shaclValidate(graph(' :missing a :Proposal;:method :cited . :lexical a :Proposal;:method :lexical;:status :ratified . '+
      ' :bounds a :Proposal;:confidence "1.000000000000000000000000000001"^^xsd:decimal . '),shapes);
    expect(new Set(report.results.map(r=>r.focusNode.value))).toEqual(new Set(['urn:test:missing','urn:test:lexical','urn:test:bounds']));
  });
  it('derives source-grounded versus synthesized provenance from qualified evidence',()=>{
    const shapes=graph(' :Direct sh:property [sh:path :relation;sh:hasValue "direct"] . '+
      ' :S a sh:NodeShape;sh:targetClass :Definition;sh:rule '+
      ' [a sh:TripleRule;sh:condition [sh:property [sh:path :evidence;sh:qualifiedValueShape :Direct;sh:qualifiedMinCount 1]];sh:subject sh:this;sh:predicate rdf:type;sh:object :Grounded],'+
      ' [a sh:TripleRule;sh:condition [sh:property [sh:path :evidence;sh:minCount 1;sh:qualifiedValueShape :Direct;sh:qualifiedMaxCount 0]];sh:subject sh:this;sh:predicate rdf:type;sh:object :Synthesized] . ');
    const expanded=shaclRules(graph(' :d1 a :Definition;:evidence [ :relation "direct" ] . :d2 a :Definition;:evidence [ :relation "supporting" ] . '),shapes);
    expect(typed(expanded,'d1','Grounded')).toBe(true);
    expect(typed(expanded,'d1','Synthesized')).toBe(false);
    expect(typed(expanded,'d2','Synthesized')).toBe(true);
  });
  it('iterates TripleRule output to a fixed point while leaving unratified mappings inert',()=>{
    const shapes=graph(' :A a sh:NodeShape;sh:targetClass :Initial;sh:rule [a sh:TripleRule;sh:subject sh:this;sh:predicate rdf:type;sh:object :Intermediate] . '+
      ' :B a sh:NodeShape;sh:targetClass :Intermediate;sh:rule [a sh:TripleRule;sh:subject sh:this;sh:predicate rdf:type;sh:object :Final] . '+
      ' :M a sh:NodeShape;sh:targetClass :Proposal;sh:rule [a sh:TripleRule;sh:condition [sh:property [sh:path :status;sh:hasValue :ratified]];'+
      ' sh:subject [sh:path :subject];sh:predicate [sh:path :predicate];sh:object [sh:path :object]] . ');
    const expanded=shaclRules(graph(' :x a :Initial . :m a :Proposal;:subject :a;:predicate :mapped;:object :b;:status :proposed . '),shapes);
    expect(typed(expanded,'x','Final')).toBe(true);
    expect(has(expanded,nn('urn:test:a'),'urn:test:mapped',nn('urn:test:b'))).toBe(false);
  });
  it('rejects unsupported SHACL features instead of returning a green partial report',async()=>{
    const shapes=graph(' :S a sh:NodeShape;sh:targetNode :x;sh:sparql [sh:select "SELECT ?this WHERE {}"] . ');
    await expect(shaclValidate(graph(' :x a :Thing . '),shapes)).rejects.toThrow(/Unsupported SHACL feature/);
  });
});
