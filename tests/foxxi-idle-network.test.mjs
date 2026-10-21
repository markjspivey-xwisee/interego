import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
async function sourceModule(path) {
 const source=await readFile(new URL(path,import.meta.url),'utf8');
 return import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64'));
}
const { gatewayTransport }=await sourceModule('../applications/foxxi-content-intelligence/src/gateway-transport.ts');
const { PollingDemand,pollingMode,onDemandRefresh }=await sourceModule('../applications/foxxi-content-intelligence/src/on-demand-work.ts');

test('idle demand makes no polling eligible; verified use expires again',()=>{
 let now=1000;const demand=new PollingDemand('demand',300000,()=>now);
 assert.equal(demand.shouldPoll(),false);
 demand.authenticatedActivity(); assert.equal(demand.shouldPoll(),true);
 now+=300000;assert.equal(demand.shouldPoll(),false);
 demand.authenticatedActivity(); assert.equal(demand.shouldPoll(),true);
 const off=new PollingDemand('off',300000,()=>now);off.authenticatedActivity();assert.equal(off.shouldPoll(),false);
 assert.equal(new PollingDemand('continuous').shouldPoll(),true);
 assert.equal(pollingMode(undefined),'demand');
 assert.throws(()=>pollingMode('typo'));
});

test('federation refresh is lazy, single-flight and rate bounded after failure',async()=>{
 let now=0,calls=0,finish;
 const refresh=onDemandRefresh(async()=>{calls++;await new Promise(r=>finish=r);},60000,()=>now);
 assert.equal(calls,0);
 const first=refresh(),second=refresh();
 assert.equal(first,second);
 await Promise.resolve();assert.equal(calls,1);finish();await first;
 await refresh();assert.equal(calls,1);
 now+=60000;const third=refresh();await Promise.resolve();assert.equal(calls,2);finish();await third;
 let failCalls=0;
 const failed=onDemandRefresh(async()=>{failCalls++;throw Error('offline');},60000,()=>now);
 await assert.rejects(failed()); await failed();assert.equal(failCalls,1);
});

test('exact local gate origin routes privately while keeping public response identity',async()=>{
 let seen;
 const local=gatewayTransport(async request=>{
  seen=request;
  return new Response('receipt',{headers:{ETag:'"v1"',Location:'https://gate.example/alice/result'}});
 },{publicPodUrl:'https://gate.example/tenant/',internalGatewayUrl:'http://css-gate.railway.internal:8080/'});
 const response=await local('https://gate.example/alice/state?q=1',{
  method:'PUT',headers:{Authorization:'Bearer scoped-secret','Content-Type':'text/plain'},body:'private payload',
  cache:'no-store',credentials:'omit',
 });
 assert.equal(seen.url,'http://css-gate.railway.internal:8080/alice/state?q=1');
 assert.equal(seen.headers.get('Host'),'gate.example');
 assert.equal(seen.headers.get('Authorization'),'Bearer scoped-secret');
 assert.equal(seen.method,'PUT');assert.equal(await seen.text(),'private payload');
 assert.equal(seen.redirect,'manual');assert.equal(seen.cache,'no-store');assert.equal(seen.credentials,'omit');
 assert.equal(response.url,'https://gate.example/alice/state?q=1');
 assert.equal(response.clone().url,response.url);
 assert.equal(response.headers.get('etag'),'"v1"');
 assert.equal(response.headers.get('location'),'https://gate.example/alice/result');
});

test('foreign and lookalike origins cannot reach private transport',async()=>{
 const seen=[];const base=async(input,init)=>{seen.push({input,init});return new Response('ok');};
 const local=gatewayTransport(base,{publicPodUrl:'https://gate.example/a/',internalGatewayUrl:'http://css-gate.railway.internal:8080/'});
 for(const url of ['https://gate.example.evil.test/alice/','https://peer.example/alice/','http://gate.example/alice/','http://css.railway.internal:3456/alice/']) {
  await local(url);assert.equal(seen.at(-1).input,url);
 }
 assert.throws(()=>gatewayTransport(base,{publicPodUrl:'https://gate.example/a/',internalGatewayUrl:'http://css-gate.railway.internal:8080/not-root/'}));
 assert.throws(()=>gatewayTransport(base,{publicPodUrl:'https://gate.example/a/',internalGatewayUrl:'http://user:secret@css-gate.railway.internal:8080/'}));
 assert.equal(gatewayTransport(base,{publicPodUrl:'https://gate.example/a/'}),base);
});
