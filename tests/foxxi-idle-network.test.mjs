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

/**
 * Every place in `text` (bridge/server.ts, or a fixture) where the tenant directory is loaded
 * eagerly: at module evaluation, in the route-setup or listen callback, or from a timer. A load is
 * a call of a loading function (or of its .call/.apply), and also a loading function handed BY
 * REFERENCE (bare, or through .bind) to a timer or a listen callback, which runs it later with no
 * request behind it. The demand loader given to createDirectoryDemand is the one sanctioned place.
 */
function eagerDirectoryLoads(ts,text){
 const file=ts.createSourceFile('server.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const nodes=[];(function walk(n){nodes.push(n);ts.forEachChild(n,walk);})(file);
 const isFn=n=>ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n);
 const enclosingFn=n=>{for(let p=n.parent;p;p=p.parent) if(isFn(p)) return p;};
 const unwrap=e=>{while(ts.isParenthesizedExpression(e)||ts.isAsExpression(e)||ts.isNonNullExpression(e)) e=e.expression;return e;};
 const exprName=e=>{e=unwrap(e);
  if(ts.isIdentifier(e)) return e.text;
  if(ts.isPropertyAccessExpression(e)) return (ts.isIdentifier(unwrap(e.expression))?unwrap(e.expression).text+'.':'')+e.name.text;};
 const calleeName=call=>exprName(call.expression);
 const fnName=f=>{
  if(f.name&&ts.isIdentifier(f.name)) return f.name.text;
  if(ts.isVariableDeclaration(f.parent)&&ts.isIdentifier(f.parent.name)) return f.parent.name.text;};
 const demand=nodes.filter(n=>ts.isCallExpression(n)&&calleeName(n)==='createDirectoryDemand');
 const demandLoader=demand[0]?.arguments[0];
 // Every call that reads the directory, directly or through a named helper that does.
 const loads=new Set(['autoFetchAdmin','fetchAdminPayload','readAdminPayload','loadConfiguredDirectory',
  'refreshDirectoryCache','directoryUsersCache.verifySession','directoryUsersCache.observe']);
 // `f.call(…)` / `f.apply(…)` invoke f now; `f.bind(…)` only names it.
 const receiverOf=(call,methods)=>{const e=unwrap(call.expression);
  return ts.isPropertyAccessExpression(e)&&methods.includes(e.name.text)?e.expression:undefined;};
 const invokes=n=>{if(!ts.isCallExpression(n)) return false;
  if(loads.has(calleeName(n))) return true;
  const recv=receiverOf(n,['call','apply']);
  if(recv&&loads.has(exprName(recv))) return true;
  return /^(fetchSection|fetchSectionStamped)$/.test(calleeName(n)??'')&&n.arguments[0]?.getText(file)==='TENANT_TYPES.TenantDirectory';};
 const scheduler=/^(setInterval|setTimeout|setImmediate|queueMicrotask)$|\.(listen|on|once)$/;
 // A loading function passed by reference (or bound) to something that will call it later.
 const references=n=>{if(!ts.isCallExpression(n)||!scheduler.test(calleeName(n)??'')) return [];
  return n.arguments.filter(a=>{a=unwrap(a);
   if(loads.has(exprName(a))) return true;
   if(ts.isCallExpression(a)){const recv=receiverOf(a,['bind']);return Boolean(recv&&loads.has(exprName(recv)));}
   return false;});};
 for(let grew=true;grew;){grew=false;
  for(const n of nodes) if(invokes(n)){
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
 for(const n of nodes){
  eager.push(...references(n)); // Run later by a timer or listener, whatever encloses it.
  if(!invokes(n)) continue;
  let f=enclosingFn(n);
  for(;f;f=enclosingFn(f)){
   if(f===demandLoader) break;
   const call=callbackOf(f);
   const name=call&&calleeName(call);
   if(name&&scheduler.test(name)){eager.push(n);break;}
   if(ts.isPropertyAssignment(f.parent)&&f.parent.name.getText(file)==='middleware'){eager.push(n);break;}
   if(ts.isParenthesizedExpression(f.parent)&&ts.isCallExpression(f.parent.parent)) continue;
   if(name&&/\.(then|catch|finally)$/.test(name)) continue;
   break; // Inside a handler or helper: it runs when that is called.
  }
  if(!f) eager.push(n);
 }
 return { file, demand, eager: eager.map(n=>`line ${file.getLineAndCharacterOfPosition(n.getStart(file)).line+1}: ${n.getText(file).slice(0,80)}`) };
}

test('the bridge loads its tenant directory only on demand: no boot load and no timer',async()=>{
 const { default: ts }=await import('typescript');
 const path='../applications/foxxi-content-intelligence/bridge/server.ts';
 const text=await readFile(new URL(path,import.meta.url),'utf8');
 const { demand, eager }=eagerDirectoryLoads(ts,text);
 // The directory is constructed once, through the demand module, and never reassigned.
 assert.equal(demand.length,1);
 assert.ok(ts.isVariableDeclaration(demand[0].parent)&&demand[0].parent.name.text==='directoryUsersCache');
 assert.ok(ts.getCombinedModifierFlags(demand[0].parent)&ts.ModifierFlags.Const||demand[0].parent.parent.flags&ts.NodeFlags.Const);
 assert.deepEqual(eager,[]);
 assert.ok(!text.includes('refreshDirectoryCache'));
});

test('the on-demand guard sees a load passed by reference, bound, or invoked through call/apply',async()=>{
 const { default: ts }=await import('typescript');
 const prelude=`const directoryUsersCache = createDirectoryDemand(async (signal) => fetchSection(TENANT_TYPES.TenantDirectory, {}));
async function autoFetchAdmin(args) { return fetchAdminPayload(args); }
async function warmDirectory() { await autoFetchAdmin({}); }
const app = createVerticalBridge({ middleware: (a) => { a.get('/x', async (_req, res) => { res.json(await autoFetchAdmin({})); }); } });
`;
 // Each of these brings back a boot load or a background poll.
 for(const eagerForm of [
  `setInterval(autoFetchAdmin, 5 * 60_000, {});`,
  `setTimeout(autoFetchAdmin.bind(null, {}), 1);`,
  `app.listen(1, '127.0.0.1', warmDirectory);`,
  `server.once('listening', warmDirectory);`,
  `setInterval((warmDirectory), 1000);`,
  `setInterval(directoryUsersCache.verifySession, 1000, 'token');`,
  `queueMicrotask(warmDirectory.bind(undefined));`,
  `void autoFetchAdmin.call(null, {});`,
  `void warmDirectory.apply(null, []);`,
  `function boot() { setTimeout(readAdminPayload, 1, {}); }`,
  `const t = setInterval(loadConfiguredDirectory.bind(null, {}, new AbortController().signal), 1);`,
 ]){
  const { eager }=eagerDirectoryLoads(ts,prelude+eagerForm);
  assert.equal(eager.length,1,`not caught: ${eagerForm} -> ${JSON.stringify(eager)}`);
 }
 // A request handler's load, a timer that loads nothing, and naming a load without scheduling it are fine.
 for(const lazyForm of [
  `app.get('/y', async () => { await warmDirectory(); });`,
  `setTimeout(() => console.log('tick'), 1);`,
  `const handler = autoFetchAdmin.bind(null, {}); app.get('/z', handler);`,
  `setInterval(unrelatedTask, 1000);`,
 ]){
  assert.deepEqual(eagerDirectoryLoads(ts,prelude+lazyForm).eager,[],lazyForm);
 }
});
