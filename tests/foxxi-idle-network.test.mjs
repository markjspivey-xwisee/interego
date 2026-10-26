import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
async function sourceModule(path) {
 const source=await readFile(new URL(path,import.meta.url),'utf8');
 return import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64'));
}
const { gatewayTransport }=await sourceModule('../applications/foxxi-content-intelligence/src/gateway-transport.ts');
const { pollingMode,onDemandRefresh,meshPollingAllowed,pollingInterval }=await sourceModule('../applications/foxxi-content-intelligence/src/on-demand-work.ts');

test('background mesh work requires operator opt-in; explicit demand stays scoped by caller',()=>{
 assert.equal(pollingMode(undefined),'demand');
 assert.throws(()=>pollingMode('typo'));
 assert.equal(meshPollingAllowed('demand'),false);
 assert.equal(meshPollingAllowed('demand',true),true);
 assert.equal(meshPollingAllowed('off'),false);
 assert.equal(meshPollingAllowed('off',true),false);
 assert.equal(meshPollingAllowed('continuous'),true);
 for(const invalid of ['0','-1','NaN','Infinity','1','2147483648']) assert.throws(()=>pollingInterval(invalid));
 assert.equal(pollingInterval(undefined),60000);
 assert.equal(pollingInterval('86400000'),86400000);
 assert.equal(pollingInterval('2147483647'),2147483647);
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

test('the bridge loads its tenant directory only on demand: no boot load and no timer',async()=>{
 const { default: ts }=await import('typescript');
 const path='../applications/foxxi-content-intelligence/bridge/server.ts';
 const text=await readFile(new URL(path,import.meta.url),'utf8');
 const file=ts.createSourceFile('server.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const nodes=[];(function walk(n){nodes.push(n);ts.forEachChild(n,walk);})(file);
 const isFn=n=>ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n);
 const enclosingFn=n=>{for(let p=n.parent;p;p=p.parent) if(isFn(p)) return p;};
 const calleeName=call=>{const e=call.expression;
  if(ts.isIdentifier(e)) return e.text;
  if(ts.isPropertyAccessExpression(e)) return (ts.isIdentifier(e.expression)?e.expression.text+'.':'')+e.name.text;};
 const fnName=f=>{
  if(f.name&&ts.isIdentifier(f.name)) return f.name.text;
  if(ts.isVariableDeclaration(f.parent)&&ts.isIdentifier(f.parent.name)) return f.parent.name.text;};
 // The directory is constructed once, through the demand module, and never reassigned.
 const demand=nodes.filter(n=>ts.isCallExpression(n)&&calleeName(n)==='createDirectoryDemand');
 assert.equal(demand.length,1);
 assert.ok(ts.isVariableDeclaration(demand[0].parent)&&demand[0].parent.name.text==='directoryUsersCache');
 assert.ok(ts.getCombinedModifierFlags(demand[0].parent)&ts.ModifierFlags.Const||demand[0].parent.parent.flags&ts.NodeFlags.Const);
 const demandLoader=demand[0].arguments[0];
 // Every call that reads the directory, directly or through a named helper that does.
 const loads=new Set(['autoFetchAdmin','fetchAdminPayload','refreshDirectoryCache',
  'directoryUsersCache.verifySession','directoryUsersCache.observe']);
 const loadsDirectly=n=>ts.isCallExpression(n)&&(loads.has(calleeName(n))||(calleeName(n)==='fetchSection'
  &&n.arguments[0]?.getText(file)==='TENANT_TYPES.TenantDirectory'));
 for(let grew=true;grew;){grew=false;
  for(const n of nodes) if(loadsDirectly(n)){
   for(let f=enclosingFn(n);f;f=enclosingFn(f)){
    if(f===demandLoader) break;
    const name=fnName(f);
    if(name&&!loads.has(name)){loads.add(name);grew=true;}
   }
  }
 }
 // A load is eager if it runs at module evaluation, in the bridge's route-setup callback,
 // in the listen callback, or on a timer; promise callbacks and IIFEs inherit their context.
 const callbackOf=f=>ts.isCallExpression(f.parent)&&f.parent.arguments.includes(f)?f.parent:undefined;
 const eager=[];
 for(const n of nodes) if(loadsDirectly(n)){
  let f=enclosingFn(n);
  for(;f;f=enclosingFn(f)){
   if(f===demandLoader) break;
   const call=callbackOf(f);
   const name=call&&calleeName(call);
   if(name&&/^(setInterval|setTimeout|setImmediate|queueMicrotask)$|\.listen$/.test(name)){eager.push(n);break;}
   if(ts.isPropertyAssignment(f.parent)&&f.parent.name.getText(file)==='middleware'){eager.push(n);break;}
   if(ts.isParenthesizedExpression(f.parent)&&ts.isCallExpression(f.parent.parent)) continue;
   if(name&&/\.(then|catch|finally)$/.test(name)) continue;
   break; // Inside a handler or helper: it runs when that is called.
  }
  if(!f) eager.push(n);
 }
 assert.deepEqual(eager.map(n=>`line ${file.getLineAndCharacterOfPosition(n.getStart(file)).line+1}: ${n.getText(file).slice(0,80)}`),[]);
 assert.ok(!text.includes('refreshDirectoryCache'));
});
