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
 * request behind it. A timer is named under any receiver or local name (globalThis.setInterval,
 * process.nextTick, a renamed import from node:timers/promises). A promise chained on a timer is a
 * timer too, and so is a loop that sleeps on one and that nothing in its body leaves; any other loop
 * is judged by where it runs. The demand loader given to createDirectoryDemand is the one sanctioned place.
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
 // The member a call reads, whatever its receiver: x.on, f().listen, globalThis['setTimeout'].
 const propName=e=>ts.isPropertyAccessExpression(e)?e.name.text
  :ts.isElementAccessExpression(e)&&ts.isStringLiteralLike(e.argumentExpression)?e.argumentExpression.text:undefined;
 const method=call=>propName(unwrap(call.expression));
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
 // A timer function: a timer global read off any receiver (globalThis.setInterval, process.nextTick,
 // timers.setTimeout), the wait or yield of node:timers/promises' scheduler (taken from that module
 // under any name, or read off it in the call), or a local bound to one by a renamed import or
 // destructuring, an alias, a .bind or a promisify. promiseTimers and promiseModules hold the ones whose call returns
 // a promise for the timer firing: timers/promises and a promisify.
 const timerNames=new Set(['setInterval','setTimeout','setImmediate','queueMicrotask','nextTick']);
 const timerAliases=new Set(),waitObjects=new Set(),tickers=new Set();
 const promiseTimers=new Set(),promiseModules=new Set();
 // The module a binding comes from: `import … from 'm'`, `require('m')`, `await import('m')`.
 const moduleOf=e=>{e=e&&unwrap(e);if(e&&ts.isAwaitExpression(e)) e=unwrap(e.expression);
  if(e&&ts.isImportDeclaration(e)) return e.moduleSpecifier.text.replace(/^node:/,'');
  return e&&ts.isCallExpression(e)&&(calleeName(e)==='require'||e.expression.kind===ts.SyntaxKind.ImportKeyword)
   &&e.arguments[0]&&ts.isStringLiteralLike(e.arguments[0])?e.arguments[0].text.replace(/^node:/,''):undefined;};
 const promisesModule=e=>Boolean(e)&&(moduleOf(e)==='timers/promises'||ts.isIdentifier(unwrap(e))&&promiseModules.has(unwrap(e).text));
 const promisified=e=>ts.isCallExpression(e)&&/(^|\.)promisify$/.test(calleeName(e)??'')&&e.arguments.length>0&&timerFn(e.arguments[0]);
 const timerFn=e=>{e=unwrap(e);
  if(ts.isIdentifier(e)) return timerNames.has(e.text)||timerAliases.has(e.text);
  const name=propName(e);
  if(name){const recv=unwrap(e.expression);
   return timerNames.has(name)||/^(wait|yield)$/.test(name)&&(ts.isIdentifier(recv)?waitObjects.has(recv.text)
    :propName(recv)==='scheduler'&&promisesModule(recv.expression));}
  if(!ts.isCallExpression(e)) return false;
  if(method(e)==='bind') return timerFn(unwrap(e.expression).expression);
  return promisified(e);};
 // sleep(ms) after a timers/promises import, timers.setTimeout(ms) on that module, scheduler.wait(ms).
 const promiseTimer=e=>{e=unwrap(e);
  if(ts.isIdentifier(e)) return promiseTimers.has(e.text);
  const name=propName(e);
  if(name) return /^(wait|yield)$/.test(name)?timerFn(e):timerNames.has(name)&&promisesModule(e.expression);
  return ts.isCallExpression(e)&&(method(e)==='bind'&&promiseTimer(unwrap(e.expression).expression)||promisified(e));};
 // A call that runs its callbacks later: a timer (directly, through .call/.apply, or a promise chained
 // on one, as timers/promises returns) or, unless only timers count, a listener on any receiver.
 const schedules=(call,listeners=true)=>{const c=unwrap(call.expression),name=propName(c)??'';
  if(timerFn(c)) return true;
  if(listeners&&/^(listen|on|once|addListener|prependListener|prependOnceListener|addEventListener)$/.test(name)) return true;
  if(name==='call'||name==='apply') return timerFn(c.expression);
  if(/^(then|catch|finally)$/.test(name)){const r=unwrap(c.expression);return ts.isCallExpression(r)&&schedules(r,false);}
  return false;};
 for(let grew=true;grew;){grew=false;
  const bind=(set,id)=>{if(id&&ts.isIdentifier(id)&&!set.has(id.text)){set.add(id.text);grew=true;}};
  for(const n of nodes){
   // import { setTimeout as sleep, scheduler } from 'node:timers/promises'; const { nextTick: tick } = process;
   if(ts.isImportSpecifier(n)||ts.isBindingElement(n)&&ts.isObjectBindingPattern(n.parent)){
    const key=n.propertyName??n.name,named=ts.isIdentifier(key)||ts.isStringLiteralLike(key)?key.text:'';
    const source=ts.isImportSpecifier(n)?n.parent.parent.parent:ts.isVariableDeclaration(n.parent.parent)?n.parent.parent.initializer:undefined;
    if(timerNames.has(named)){bind(timerAliases,n.name);if(promisesModule(source)) bind(promiseTimers,n.name);}
    else if(named==='scheduler'&&promisesModule(source)) bind(waitObjects,n.name);
    else if(named==='promises'&&moduleOf(source)==='timers') bind(promiseModules,n.name);
   }
   // import * as timers from 'node:timers/promises'; import timers from 'node:timers/promises';
   if(ts.isNamespaceImport(n)&&moduleOf(n.parent.parent)==='timers/promises') bind(promiseModules,n.name);
   if(ts.isImportClause(n)&&n.name&&moduleOf(n.parent)==='timers/promises') bind(promiseModules,n.name);
   // const later = globalThis.setTimeout; const sleep = promisify(setTimeout); const ticks = setInterval(60_000);
   if(ts.isVariableDeclaration(n)&&n.initializer){const init=unwrap(n.initializer);
    if(timerFn(init)) bind(timerAliases,n.name);
    else if(ts.isCallExpression(init)&&schedules(init,false)) bind(tickers,n.name);
    if(promiseTimer(init)) bind(promiseTimers,n.name);
    if(promisesModule(init)) bind(promiseModules,n.name);
   }
  }
 }
 // What a call hands its callee: its arguments, or for `t.apply(this, [cb, ms])` what the array holds.
 const handed=call=>{const list=call.arguments[1]&&unwrap(call.arguments[1]);
  return method(call)==='apply'&&list&&ts.isArrayLiteralExpression(list)?[call.arguments[0],...list.elements]:call.arguments;};
 // A sleep is one of the forms sleeps() reads, and nothing else:
 // - a `new Promise` whose executor, an arrow or a `function`, hands a timer its first parameter (the
 //   resolver), bare or inside a callback: `new Promise(r => setTimeout(r, ms))`;
 // - a call of a timers/promises timer (promiseTimer): one taken from that module (or from
 //   node:timers' promises export) under any name, one read off it (`tp.setTimeout(ms)`), its
 //   scheduler's wait or yield, a promisify of a timer (`promisify(setTimeout)`, `util.promisify`),
 //   or a .bind of any of these (`sleep.bind(null, ms)`); called directly or through .call/.apply;
 // - a call of a named local function (a pacer) or an IIFE that returns or awaits a sleep in its own
 //   body, the named one also through .call/.apply;
 // - a .then/.catch/.finally on a sleep, or Promise.race/all/any/allSettled over a list holding one;
 // - an `await` of any of these.
 // So an executor that hands a timer only its reject is not a sleep, nor is a callback timer that
 // only arms a deadline (`setTimeout(() => ac.abort(), ms)`), and a function holding one is not a pacer.
 const pacers=new Set();
 const mentions=(x,name)=>ts.isIdentifier(x)?x.text===name:Boolean(ts.forEachChild(x,c=>mentions(c,name)||undefined));
 const findOwn=(body,test)=>{let found=false;(function walk(x){if(found||ts.isFunctionLike(x)) return; // not in nested functions, accessors included
  if(test(x)) found=true;else ts.forEachChild(x,walk);})(body);return found;};
 const resolvesOnTimer=exec=>{exec=exec&&unwrap(exec);
  const r=exec&&(ts.isArrowFunction(exec)||ts.isFunctionExpression(exec))?exec.parameters[0]?.name:undefined;
  if(!r||!ts.isIdentifier(r)) return false;
  let found=false;(function walk(x){if(found) return;
   if(ts.isCallExpression(x)&&schedules(x,false)&&handed(x).some(a=>mentions(a,r.text))) found=true;else ts.forEachChild(x,walk);})(exec.body);
  return found;};
 const sleeps=e=>{e=unwrap(e);
  if(ts.isAwaitExpression(e)) return sleeps(e.expression);
  if(ts.isNewExpression(e)) return exprName(e.expression)==='Promise'&&resolvesOnTimer(e.arguments?.[0]);
  if(!ts.isCallExpression(e)) return false;
  const c=unwrap(e.expression),name=propName(c)??'';
  if(promiseTimer(c)||pacers.has(calleeName(e))||isFn(c)&&paces(c)) return true;
  if(/^(then|catch|finally)$/.test(name)) return sleeps(c.expression);
  if(/^Promise\.(race|all|any|allSettled)$/.test(calleeName(e)??'')){const list=e.arguments[0]&&unwrap(e.arguments[0]);
   return Boolean(list&&ts.isArrayLiteralExpression(list)&&list.elements.some(sleeps));}
  return (name==='call'||name==='apply')&&(promiseTimer(c.expression)||pacers.has(exprName(c.expression)));};
 const waitsOn=x=>ts.isAwaitExpression(x)&&sleeps(x.expression);
 // Whether f returns or awaits a sleep in its own body.
 const paces=f=>Boolean(f.body)&&(!ts.isBlock(f.body)&&sleeps(f.body)
  ||findOwn(f.body,x=>waitsOn(x)||ts.isReturnStatement(x)&&Boolean(x.expression)&&sleeps(x.expression)));
 for(let grew=true;grew;){grew=false;
  for(const f of nodes){const name=isFn(f)&&fnName(f);if(name&&!pacers.has(name)&&paces(f)){pacers.add(name);grew=true;}}
 }
 // A loop a timer paces is a poll: `for await (… of setInterval(ms))` from timers/promises, or a
 // `while (true)`, `do … while (true)` or `for (…; ; …)` whose body awaits a sleep and that nothing in
 // its body leaves. Any other loop (a condition other than `true`, or a return, throw, break or
 // labelled continue that lands outside it) is judged by where it runs, like other code: a retry with
 // backoff, a paged read.
 const endless=p=>{
  if(!((ts.isWhileStatement(p)||ts.isDoStatement(p))&&unwrap(p.expression).kind===ts.SyntaxKind.TrueKeyword||ts.isForStatement(p)&&!p.condition)) return false;
  const own=new Set();for(let l=p.parent;ts.isLabeledStatement(l);l=l.parent) own.add(l.label.text);
  let exits=false;
  // nested: in a loop or switch inside the body (an unlabelled break stops there); labels: declared
  // inside the body; caught: in the try block of a try that catches, so a throw stays in the loop.
  (function walk(x,nested,labels,caught){
   if(exits||ts.isFunctionLike(x)||ts.isClassLike(x)) return;
   if(ts.isReturnStatement(x)||ts.isThrowStatement(x)&&!caught){exits=true;return;}
   if(ts.isBreakStatement(x)||ts.isContinueStatement(x)){
    exits=x.label?!labels.has(x.label.text)&&!(ts.isContinueStatement(x)&&own.has(x.label.text)):ts.isBreakStatement(x)&&!nested;
    return;}
   if(ts.isLabeledStatement(x)) return walk(x.statement,nested,new Set([...labels,x.label.text]),caught);
   if(ts.isTryStatement(x)){walk(x.tryBlock,nested,labels,caught||Boolean(x.catchClause));
    if(x.catchClause) walk(x.catchClause,nested,labels,caught);
    if(x.finallyBlock) walk(x.finallyBlock,nested,labels,caught);
    return;}
   const inner=nested||ts.isIterationStatement(x,false)||ts.isSwitchStatement(x);
   ts.forEachChild(x,c=>walk(c,inner,labels,caught));
  })(p.statement,false,new Set(),false);
  return !exits;};
 const ticks=p=>{if(!ts.isForOfStatement(p)) return false;const e=unwrap(p.expression);
  return ts.isCallExpression(e)?schedules(e,false):ts.isIdentifier(e)&&tickers.has(e.text);};
 const polled=n=>{for(let c=n,p=n.parent;p&&p!==demandLoader;c=p,p=p.parent)
  if(c===p.statement&&(ticks(p)||endless(p)&&findOwn(p.statement,waitsOn))) return true;
  return false;};
 const loadRef=a=>{a=unwrap(a);
  if(loads.has(exprName(a))) return true;
  const recv=ts.isCallExpression(a)?receiverOf(a,['bind']):undefined;
  return Boolean(recv&&loads.has(exprName(recv)));};
 // Promise reactions, array callbacks and a promise executor run in their caller's context.
 const inherits=/^(then|catch|finally|forEach|map|flatMap|filter|reduce|reduceRight|some|every|find|findIndex|findLast|findLastIndex)$/;
 const invokes=n=>{if(!ts.isCallExpression(n)) return false;
  if(loads.has(calleeName(n))) return true;
  const recv=receiverOf(n,['call','apply']);
  if(recv&&loads.has(exprName(recv))) return true;
  // `p.then(load)` / `xs.forEach(load)` run the load in this call's context; on a timer it is a reference below.
  if(inherits.test(method(n)??'')&&!schedules(n)&&n.arguments.some(loadRef)) return true;
  return /^(fetchSection|fetchSectionStamped)$/.test(calleeName(n)??'')&&n.arguments[0]?.getText(file)==='TENANT_TYPES.TenantDirectory';};
 // A loading function passed by reference (or bound) to something that will call it later.
 const references=n=>ts.isCallExpression(n)&&schedules(n)?handed(n).filter(loadRef):[];
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
 // in the listen callback, or on a timer; promise and array callbacks, promise executors and
 // IIFEs inherit their context.
 const callbackOf=f=>ts.isCallExpression(f.parent)&&f.parent.arguments.includes(f)?f.parent:undefined;
 const executor=f=>ts.isNewExpression(f.parent)&&exprName(f.parent.expression)==='Promise'&&f.parent.arguments?.[0]===f;
 const eager=new Set();
 for(const n of nodes){
  for(const r of references(n)) eager.add(r); // Run later by a timer or listener, whatever encloses it.
  if(!invokes(n)) continue;
  if(polled(n)){eager.add(n);continue;} // So is a load in a loop a timer paces.
  let f=enclosingFn(n);
  for(;f;f=enclosingFn(f)){
   if(f===demandLoader) break;
   const call=callbackOf(f);
   if(call&&schedules(call)){eager.add(n);break;}
   if(ts.isPropertyAssignment(f.parent)&&f.parent.name.getText(file)==='middleware'){eager.add(n);break;}
   if(ts.isParenthesizedExpression(f.parent)&&ts.isCallExpression(f.parent.parent)) continue;
   if(call&&inherits.test(method(call)??'')||executor(f)) continue;
   break; // Inside a handler or helper: it runs when that is called.
  }
  if(!f) eager.add(n);
 }
 return { file, demand, eager: [...eager].map(n=>`line ${file.getLineAndCharacterOfPosition(n.getStart(file)).line+1}: ${n.getText(file).slice(0,80)}`) };
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

// The fixtures below run after this stand-in for the bridge: a demand loader, a loading helper, and a route.
const prelude=`const directoryUsersCache = createDirectoryDemand(async (signal) => fetchSection(TENANT_TYPES.TenantDirectory, {}));
async function autoFetchAdmin(args) { return fetchAdminPayload(args); }
async function warmDirectory() { await autoFetchAdmin({}); }
const app = createVerticalBridge({ middleware: (a) => { a.get('/x', async (_req, res) => { res.json(await autoFetchAdmin({})); }); } });
`;

test('the on-demand guard sees a load passed by reference, bound, or invoked through call/apply',async()=>{
 const { default: ts }=await import('typescript');
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

test('the on-demand guard sees a timer under any receiver or name, from timers/promises, or pacing a loop',async()=>{
 const { default: ts }=await import('typescript');
 // Each of these brings back a boot load or a background poll.
 for(const eagerForm of [
  // A timer read off a receiver, or called through one.
  `globalThis.setInterval(autoFetchAdmin, 60_000, {});`,
  `global.setTimeout(() => autoFetchAdmin({}), 1);`,
  `process.nextTick(warmDirectory);`,
  `process.nextTick(() => { void warmDirectory(); });`,
  `globalThis.queueMicrotask(warmDirectory.bind(null));`,
  `globalThis.setImmediate(() => autoFetchAdmin({}));`,
  `setImmediate(warmDirectory);`,
  `(globalThis as any)['setTimeout'](warmDirectory, 1);`,
  `globalThis.setTimeout?.(warmDirectory, 1);`,
  `setTimeout.call(globalThis, warmDirectory, 1);`,
  `setTimeout.apply(globalThis, [warmDirectory, 1]);`,
  // A timer under another name.
  `import * as timers from 'node:timers'; timers.setInterval(warmDirectory, 1000);`,
  `import { setInterval as every } from 'node:timers'; every(() => warmDirectory(), 1000);`,
  `import { nextTick } from 'node:process'; nextTick(warmDirectory);`,
  `const { setTimeout: later } = globalThis; later(warmDirectory, 1);`,
  `const tick = process.nextTick.bind(process); tick(warmDirectory);`,
  `const later = globalThis.setTimeout; const soon = later; soon(warmDirectory, 1);`,
  // timers/promises: a promise chained on a timer, an interval iterated, a loop that sleeps.
  `import { setTimeout as sleep } from 'node:timers/promises'; void sleep(1000).then(warmDirectory);`,
  `import { setTimeout as sleep } from 'node:timers/promises'; app.get('/later', () => { void sleep(1000).then(() => warmDirectory()); });`,
  `import timers from 'node:timers/promises'; await timers.setTimeout(1).then(autoFetchAdmin.bind(null, {}));`,
  `import { setInterval as every } from 'node:timers/promises'; async function poll() { for await (const _ of every(60_000)) await warmDirectory(); }`,
  `import { setInterval } from 'node:timers/promises'; const ticks = setInterval(60_000); app.get('/poll', async () => { for await (const _ of ticks) await autoFetchAdmin({}); });`,
  `const { scheduler } = require('node:timers/promises'); async function poll() { while (true) { await scheduler.wait(60_000); await warmDirectory(); } }`,
  `const sleep = promisify(setTimeout); async function poll() { for (;;) { await sleep(60_000); await autoFetchAdmin({}); } }`,
  `async function poll() { do { await new Promise(r => setTimeout(r, 60_000)); await warmDirectory(); } while (true); }`,
  `const wait = (ms) => new Promise(r => setTimeout(r, ms)); async function poll() { while (true) { await wait(60_000); await warmDirectory(); } }`,
  // A sleep inside Promise.race or Promise.all, or behind a local function that awaits one.
  `async function poll() { while (true) { await Promise.race([stopRequested, new Promise(r => setTimeout(r, 60_000))]); await warmDirectory(); } }`,
  `async function poll() { for (;;) await Promise.all([warmDirectory(), new Promise(r => setTimeout(r, 60_000))]); }`,
  `async function nap(ms) { await new Promise(r => setTimeout(r, ms)); } async function poll() { while (true) { await nap(60_000); await warmDirectory(); } }`,
  // Nothing in these leaves the loop: the throw is caught inside it, the breaks stop an inner loop and a switch.
  `async function poll() { for (;;) { try { if (!(await warmDirectory())) throw Error('empty'); } catch {} await new Promise(resolve => { setTimeout(resolve, 60_000).unref(); }); } }`,
  `const wait = (ms) => new Promise(r => setTimeout(r, ms)); async function poll() { while (true) { for (const t of ['acme']) { if (!t) break; await autoFetchAdmin({ t }); } switch (0) { default: break; } await wait(60_000); } }`,
  `import { setTimeout as sleep } from 'node:timers/promises'; const nap = () => sleep(60_000).then(() => {}); async function poll() { while (true) { await nap(); await warmDirectory(); } }`,
  // Nor do these: a continue to the loop's own label starts its next pass, and a break or continue
  // to a label declared inside the body lands inside it.
  `async function poll() { tick: while (true) { await new Promise(r => setTimeout(r, 60_000)); for (const t of ['acme']) { if (!(await autoFetchAdmin({ t }))) continue tick; } } }`,
  `async function poll() { while (true) { await new Promise(r => setTimeout(r, 60_000)); tenants: for (const t of ['acme']) { for (const s of ['users']) { if (!s) continue tenants; if (!t) break tenants; await autoFetchAdmin({ t, s }); } } } }`,
  // A loop that can stop is judged by where it runs, and this one starts at module evaluation.
  `async function poll() { while (true) { await new Promise(r => setTimeout(r, 60_000)); await warmDirectory(); if (stopped) break; } } void poll();`,
  // A listener on any receiver.
  `createServer(app).listen(1, '127.0.0.1', warmDirectory);`,
  `app.server.on('listening', () => warmDirectory());`,
  `server.addListener('listening', warmDirectory);`,
  `bus.prependListener('ready', warmDirectory);`,
  `bus.prependOnceListener('ready', () => autoFetchAdmin({}));`,
  `controller.signal.addEventListener('abort', () => warmDirectory());`,
  // A promise reaction, array callback or promise executor runs at module evaluation here.
  `void Promise.resolve().then(warmDirectory);`,
  `void Promise.reject(Error('cold')).catch(warmDirectory);`,
  `void Promise.resolve().finally(warmDirectory);`,
  `void fetch('https://gate.example/').then(() => autoFetchAdmin({}));`,
  `['acme'].forEach(t => void autoFetchAdmin({ t }));`,
  `void new Promise(resolve => resolve(warmDirectory()));`,
  `const boot = () => Promise.resolve().then(warmDirectory); void boot();`,
 ]){
  const { eager }=eagerDirectoryLoads(ts,prelude+eagerForm);
  assert.equal(eager.length,1,`not caught: ${eagerForm} -> ${JSON.stringify(eager)}`);
 }
 // Inside a request these run on demand, a timer that loads nothing is fine, and so is a bounded
 // retry, a loop that leaves itself, a loop over a request body, and a loop that waits on something
 // other than a timer.
 for(const lazyForm of [
  `app.get('/y', async () => { await Promise.resolve().then(warmDirectory); });`,
  `app.get('/y', () => fetch('/x').then(() => autoFetchAdmin({})));`,
  `app.get('/y', () => ['acme'].map(t => autoFetchAdmin({ t })));`,
  `globalThis.setTimeout(unrelatedTask, 1); process.nextTick(() => console.log('tick'));`,
  `const later = globalThis.setTimeout; app.get('/y', async () => { await warmDirectory(); }); later(() => console.log('tick'), 1);`,
  `import { setTimeout as sleep } from 'node:timers/promises'; app.get('/y', async () => { await sleep(10); await warmDirectory(); });`,
  `app.get('/y', async () => { for (let i = 0; i < 3; i++) { try { return await autoFetchAdmin({}); } catch { await new Promise(r => setTimeout(r, 100 * 2 ** i)); } } });`,
  `const wait = (ms) => new Promise(r => setTimeout(r, ms)); app.get('/y', async () => { for (let i = 0; i < 3; i++) { await wait(10); await warmDirectory(); } });`,
  // A loop with no condition that returns, throws or breaks out of itself, inside a request.
  `app.get('/y', async () => { for (let n = 0; ; n++) { try { return await autoFetchAdmin({}); } catch (e) { if (n >= 3) throw e; await new Promise(r => setTimeout(r, 100 * 2 ** n)); } } });`,
  `app.get('/y', async () => { let n = 0; while (true) { try { return await autoFetchAdmin({}); } catch (e) { if (++n > 3) throw e; await new Promise(r => setTimeout(r, 100 * 2 ** n)); } } });`,
  // Each of these leaves its loop one way only: by a return, then by a throw that no catch stops
  // (a try with only a finally does not catch it).
  `app.get('/y', async () => { while (true) { const users = await autoFetchAdmin({}); if (users.length) return users; await new Promise(r => setTimeout(r, 100)); } });`,
  `app.get('/y', async (req) => { for (;;) { try { if (req.signal.aborted) throw req.signal.reason; await warmDirectory(); } finally { release(); } await new Promise(r => setTimeout(r, 1000)); } });`,
  // A paginated read that breaks out, and a continue and a break from an inner loop to an outer one's label.
  `async function fetchPage(c) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000); try { return await autoFetchAdmin({ cursor: c, signal: ac.signal }); } finally { clearTimeout(t); } }
app.get('/users', async () => { let cursor; while (true) { const p = await fetchPage(cursor); if (!p.next) break; cursor = p.next; } });`,
  `app.get('/y', async () => { outer: for (const t of ['acme']) { while (true) { await new Promise(r => setTimeout(r, 10)); if (await autoFetchAdmin({ t })) continue outer; } } });`,
  `app.get('/y', async () => { scan: for (const t of ['acme']) { while (true) { await new Promise(r => setTimeout(r, 10)); if (await autoFetchAdmin({ t })) break scan; } } });`,
  // A helper that only arms a deadline does not sleep, so this loop waits on the queue, not a timer.
  `async function fetchPage(c) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000); try { return await autoFetchAdmin({ cursor: c, signal: ac.signal }); } finally { clearTimeout(t); } }
async function drain() { while (true) { await fetchPage(await queue.wait()); } } app.get('/y', () => drain());`,
  // Nor is a promise whose executor arms a timer that never resolves it: this one only rejects on a deadline.
  `async function drain() { while (true) { const job = await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('queue timeout')), 5000); queue.once('job', (j) => { clearTimeout(t); resolve(j); }); }); await autoFetchAdmin(job); } } app.get('/y', () => drain());`,
  // A loop over a request body, a loop that waits on a queue, and a listener that loads nothing.
  `app.get('/y', async (req) => { for await (const chunk of req) await directoryUsersCache.observe(chunk); });`,
  `async function drain() { while (true) { await queue.wait(); await warmDirectory(); } } app.get('/y', () => drain());`,
  `server.on('error', e => console.error(e));`,
 ]){
  assert.deepEqual(eagerDirectoryLoads(ts,prelude+lazyForm).eager,[],lazyForm);
 }
});

test('the on-demand guard: further naming, sleep, loop and callback forms',async()=>{
 const { default: ts }=await import('typescript');
 // Each of these brings back a boot load or a background poll.
 for(const eagerForm of [
  // A timer under another name (a promisify, bare or util., an alias declared below the function
  // that calls it, a quoted destructured name), a bound load cast with `as`, and a .finally or
  // .catch reaction chained on a timers/promises sleep.
  `const sleep = promisify(setTimeout); app.get('/y', () => { void sleep(1000).then(warmDirectory); });`,
  `import util from 'node:util'; const sleep = util.promisify(setTimeout); async function poll() { while (true) { await sleep(60_000); await warmDirectory(); } }`,
  `function boot() { const soon = later; soon(warmDirectory, 1); } const later = globalThis.setTimeout; boot();`,
  `const { 'setTimeout': later } = globalThis; later(warmDirectory, 1);`,
  `setTimeout(warmDirectory.bind(null) as () => void, 1);`,
  `import { setTimeout as sleep } from 'node:timers/promises'; app.get('/y', () => { void sleep(1000).finally(warmDirectory); });`,
  `import { setTimeout as sleep } from 'node:timers/promises'; app.get('/y', (req) => { void sleep(1000, undefined, { signal: req.signal }).catch(() => warmDirectory()); });`,
  // node:timers/promises reached through a namespace, a default import, require, import(),
  // node:timers' promises, or its scheduler (renamed, read off the namespace, or yielding); and a
  // bound timers/promises sleep.
  `import * as tp from 'node:timers/promises'; async function poll() { while (true) { await tp.setTimeout(60_000); await warmDirectory(); } }`,
  `import tp from 'node:timers/promises'; async function poll() { while (true) { await tp.setTimeout(60_000); await warmDirectory(); } }`,
  `const tp = require('node:timers/promises'); async function poll() { while (true) { await tp.setTimeout(60_000); await warmDirectory(); } }`,
  `const { setTimeout: nap } = require('node:timers/promises'); async function poll() { while (true) { await nap(60_000); await warmDirectory(); } }`,
  `const { setTimeout: nap } = await import('node:timers/promises'); async function poll() { while (true) { await nap(60_000); await warmDirectory(); } }`,
  `import { promises as timersPromises } from 'node:timers'; async function poll() { while (true) { await timersPromises.setTimeout(60_000); await warmDirectory(); } }`,
  `import { scheduler as sched } from 'node:timers/promises'; async function poll() { while (true) { await sched.wait(60_000); await warmDirectory(); } }`,
  `import * as tp from 'node:timers/promises'; async function poll() { while (true) { await tp.scheduler.wait(60_000); await warmDirectory(); } }`,
  `import { scheduler } from 'node:timers/promises'; async function poll() { while (true) { await scheduler.yield(); await warmDirectory(); } }`,
  `import { setTimeout as sleep } from 'node:timers/promises'; const nap = sleep.bind(null, 60_000); async function poll() { while (true) { await nap(); await warmDirectory(); } }`,
  // Sleeps: a block-bodied helper that returns one, a helper of a helper, a resolver inside a closure,
  // a function executor, a timer called through .apply, an awaiting arrow, an IIFE, .catch and
  // .finally, Promise.any and Promise.allSettled, and .call or .apply of a sleep.
  `function sleep(ms) { return new Promise(r => setTimeout(r, ms)); } async function poll() { while (true) { await sleep(60_000); await warmDirectory(); } }`,
  `async function pause() { await nap(60_000); } async function nap(ms) { await new Promise(r => setTimeout(r, ms)); } async function poll() { while (true) { await pause(); await warmDirectory(); } }`,
  `async function poll() { while (true) { await new Promise(r => setTimeout(() => r(), 60_000)); await warmDirectory(); } }`,
  `async function poll() { while (true) { await new Promise(function (resolve) { setTimeout(resolve, 60_000); }); await warmDirectory(); } }`,
  `async function poll() { while (true) { await new Promise(r => setTimeout.apply(globalThis, [r, 60_000])); await warmDirectory(); } }`,
  `const nap = async (ms) => await new Promise(r => setTimeout(r, ms)); async function poll() { while (true) { await nap(60_000); await warmDirectory(); } }`,
  `async function poll() { while (true) { await (async () => { await new Promise(r => setTimeout(r, 60_000)); })(); await warmDirectory(); } }`,
  `import { setTimeout as sleep } from 'node:timers/promises'; async function poll() { while (true) { await sleep(60_000).catch(() => {}); await warmDirectory(); } }`,
  `async function nap(ms) { await new Promise(r => setTimeout(r, ms)); } async function poll() { let n = 0; while (true) { await nap(60_000).finally(() => n++); await warmDirectory(); } }`,
  `async function poll() { while (true) { await Promise.any([stopRequested, new Promise(r => setTimeout(r, 60_000))]); await warmDirectory(); } }`,
  `async function poll() { for (;;) await Promise.allSettled([warmDirectory(), new Promise(r => setTimeout(r, 60_000))]); }`,
  `async function nap(ms) { await new Promise(r => setTimeout(r, ms)); } async function poll() { while (true) { await nap.call(null, 60_000); await warmDirectory(); } }`,
  `import { setTimeout as sleep } from 'node:timers/promises'; async function poll() { while (true) { await sleep.apply(null, [60_000]); await warmDirectory(); } }`,
  // Loops nothing leaves: an unlabelled continue starts the next pass, and a return in a callback,
  // in a class's getter or in an object literal's getter leaves that function, not the loop.
  `async function poll() { while (true) { await new Promise(r => setTimeout(r, 60_000)); if (paused) continue; await warmDirectory(); } }`,
  `async function poll() { while (true) { await new Promise(r => setTimeout(r, 60_000)); const tenants = ['acme'].filter((t) => { return t !== 'test'; }); await autoFetchAdmin({ tenants }); } }`,
  `async function poll() { while (true) { await new Promise(r => setTimeout(r, 60_000)); const job = new (class { get t() { return 'acme'; } })(); await autoFetchAdmin({ t: job.t }); } }`,
  `async function poll() { while (true) { await new Promise(r => setTimeout(r, 60_000)); const job = { get t() { return 'acme'; } }; await autoFetchAdmin({ t: job.t }); } }`,
  // The other array methods the check treats as running their callback in place (forEach is in the
  // test above), and rules the check had before: a load in the route-setup callback, in an IIFE, in
  // a helper that calls a loader declared after it, and a direct read of the directory section.
  ...['map','flatMap','filter','reduce','reduceRight','some','every','find','findIndex','findLast','findLastIndex'].map(m=>`['acme'].${m}((t) => autoFetchAdmin({ t }));`),
  `createVerticalBridge({ middleware: (a) => { void warmDirectory(); } });`,
  `(async () => { await warmDirectory(); })();`,
  `function boot() { return refresh(); } async function refresh() { await warmDirectory(); } void boot();`,
  `void fetchSection(TENANT_TYPES.TenantDirectory, {});`,
  `void fetchSectionStamped(TENANT_TYPES.TenantDirectory, {});`,
 ]){
  const { eager }=eagerDirectoryLoads(ts,prelude+eagerForm);
  assert.equal(eager.length,1,`not caught: ${eagerForm} -> ${JSON.stringify(eager)}`);
 }
 for(const lazyForm of [
  // A promisify of something other than a timer, and a callback timer's handle, are not sleeps.
  `const readFileAsync = promisify(readFile); async function drain() { while (true) { const job = await queue.wait(); await autoFetchAdmin(JSON.parse(await readFileAsync(job.path, 'utf8'))); } } app.get('/y', () => drain());`,
  `async function arm(job) { return globalThis.setTimeout(() => job.cancel(), 5000); } async function drain() { while (true) { const job = await queue.wait(); const t = await arm(job); await autoFetchAdmin(job); clearTimeout(t); } } app.get('/y', () => drain());`,
  // A helper is a pacer only if it sleeps itself, not if a function or getter inside it does; and a
  // loop counts only a sleep it awaits itself, not one awaited inside a function it creates.
  `async function nextJob() { const job = await queue.wait(); job.backoff = async () => { await new Promise(r => setTimeout(r, 1000)); }; return job; } async function drain() { while (true) { await autoFetchAdmin(await nextJob()); } } app.get('/y', () => drain());`,
  `function withBackoff(job) { return { ...job, get backoff() { return new Promise(r => setTimeout(r, 1000)); } }; } async function drain() { while (true) { const job = await withBackoff(await queue.wait()); await autoFetchAdmin(job); } } app.get('/y', () => drain());`,
  `import { setTimeout as sleep } from 'node:timers/promises'; async function drain() { while (true) { const job = await queue.wait(); void sleep(30_000).then(() => metrics.flush()); await autoFetchAdmin(job); } } app.get('/y', () => drain());`,
  `async function drain() { while (true) { const job = await queue.wait(); job.retry = async () => { await new Promise(r => setTimeout(r, 1000)); }; await autoFetchAdmin(job); } } app.get('/y', () => drain());`,
  // timers/promises' scheduler counts only when it comes from that module: not a local named
  // scheduler, one imported from another module, or one read off another object; nor does a
  // `promises` export of a module other than node:timers.
  `const scheduler = makeJobScheduler(); app.get('/y', async () => { while (true) { await scheduler.wait(); await warmDirectory(); } });`,
  `import { scheduler } from './jobs.js'; app.get('/y', async () => { while (true) { await scheduler.wait(); await warmDirectory(); } });`,
  `app.get('/y', async () => { while (true) { await jobs.scheduler.wait(); await warmDirectory(); } });`,
  `import { promises as clock } from './virtual-clock.js'; app.get('/y', async () => { while (true) { await clock.setTimeout(10); await warmDirectory(); } });`,
  // Inside a request: a while and a do-while with a real condition, a break to the loop's own
  // label, and a throw from a catch or a finally all end the loop.
  `app.get('/y', async () => { let users = []; while (!users.length) { await new Promise(r => setTimeout(r, 100)); users = await autoFetchAdmin({}); } return users; });`,
  `app.get('/y', async () => { let users; do { users = await autoFetchAdmin({}); if (!users.length) await new Promise(r => setTimeout(r, 100)); } while (!users.length); return users; });`,
  `app.get('/y', async () => { scan: while (true) { await new Promise(r => setTimeout(r, 100)); for (const t of ['acme']) { if (await autoFetchAdmin({ t })) break scan; } } });`,
  `app.get('/y', async (req) => { for (;;) { try { await warmDirectory(); } catch (e) { if (req.signal.aborted) throw e; } await new Promise(r => setTimeout(r, 1000)); } });`,
  `app.get('/y', async (req) => { for (;;) { try { await warmDirectory(); } catch {} finally { if (req.signal.aborted) throw req.signal.reason; } await new Promise(r => setTimeout(r, 1000)); } });`,
  // An event iterator is not a timer, nor is a .then chained on a listener call, and a callback
  // handed to a constructor other than Promise runs when that object calls it.
  `import events from 'node:events'; app.get('/y', async (req) => { for await (const [chunk] of events.on(req, 'data')) await directoryUsersCache.observe(chunk); });`,
  `import events from 'node:events'; app.get('/y', async (req) => { await events.once(req, 'end').then(() => autoFetchAdmin({})); });`,
  `const refresh = new Command(() => autoFetchAdmin({})); app.post('/refresh', () => refresh.run());`,
 ]){
  assert.deepEqual(eagerDirectoryLoads(ts,prelude+lazyForm).eager,[],lazyForm);
 }
});
