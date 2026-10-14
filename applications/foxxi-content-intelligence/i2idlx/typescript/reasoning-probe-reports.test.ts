import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchFreshReportNodes } from './reasoning-probe-reports.js';

const nn=(value:string)=>'NamedNode:'+JSON.stringify(value),bn=(value:string)=>'BlankNode:'+JSON.stringify(value);
const message=(value:string)=>'Literal:'+JSON.stringify(value)+'@^^http://www.w3.org/2001/XMLSchema#string';
const key=(s:string,p:string,o:string)=>JSON.stringify([s,p,o]);
const type=nn('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),errorType=nn('http://www.daml.org/2002/03/agents/agent-ont#ErrorMessage');
const error=nn('http://www.daml.org/2002/03/agents/agent-ont#error');
const report=(node:string,text='exact message')=>[key(bn(node),type,errorType),key(bn(node),error,message(text))];

describe('strict fresh ERRNS diagnostic node bijection',()=>{
  it('matches only the exact two-quad fresh report while conserving raw inputs and counts',()=>{
    const native=report('native-fresh'),python=report('python-fresh'),before=[...native];
    const result=matchFreshReportNodes(native,python,new Set(['input']));
    assert.deepEqual(result.native,result.python);assert.equal(result.pairs.length,1);
    assert.deepEqual(native,before);assert.equal(result.native.length,2);assert.equal(result.python.length,2);
    assert.deepEqual(result.pairs[0],{native:'native-fresh',python:'python-fresh',message:message('exact message')});
  });
  it('preserves input blank labels, unrelated fresh nodes and fresh nodes with additional facts',()=>{
    for(const inputLabels of [new Set(['native-fresh']),new Set(['python-fresh'])]) {
      const result=matchFreshReportNodes(report('native-fresh'),report('python-fresh'),inputLabels);
      assert.equal(result.pairs.length,0);assert.notDeepEqual(result.native,result.python);
    }
    const additional=key(bn('native-fresh'),nn('urn:other'),nn('urn:value'));
    const result=matchFreshReportNodes([...report('native-fresh'),additional],report('python-fresh'),new Set());
    assert.equal(result.pairs.length,0);assert.notDeepEqual(result.native,result.python);
    const unrelated=matchFreshReportNodes([key(bn('n'),nn('urn:other'),nn('urn:value'))],[key(bn('p'),nn('urn:other'),nn('urn:value'))],new Set());
    assert.equal(unrelated.pairs.length,0);assert.notDeepEqual(unrelated.native,unrelated.python);
  });
  it('preserves changed messages, missing report triples and incoming references',()=>{
    assert.equal(matchFreshReportNodes(report('n','one'),report('p','two'),new Set()).pairs.length,0);
    assert.equal(matchFreshReportNodes(report('n').slice(0,1),report('p'),new Set()).pairs.length,0);
    const incoming=key(nn('urn:input'),nn('urn:links'),bn('n'));
    assert.equal(matchFreshReportNodes([...report('n'),incoming],report('p'),new Set()).pairs.length,0);
  });
  it('refuses non-bijective duplicate reports and avoids existing canonical label collisions',()=>{
    assert.throws(()=>matchFreshReportNodes([...report('n1'),...report('n2')],report('p'),new Set()),/bijective node mapping/);
    const result=matchFreshReportNodes(report('n'),report('p'),new Set(['i2idlx-diagnostic-0']));
    assert.deepEqual(result.native,result.python);assert.ok(result.native.every(key=>!key.includes('i2idlx-diagnostic-0')));
  });
});
