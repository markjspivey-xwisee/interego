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
 * process.nextTick, a renamed import from node:timers/promises), and a promise chained on one or a
 * loop it paces is a timer too. The demand loader given to createDirectoryDemand is the one sanctioned place.
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
 // timers.setTimeout), timers/promises' scheduler.wait, or a local bound to one by a renamed import
 // or destructuring, an alias, a .bind or a promisify.
 const timerNames=new Set(['setInterval','setTimeout','setImmediate','queueMicrotask','nextTick']);
 const timerAliases=new Set(),waitObjects=new Set(['scheduler']),tickers=new Set();
 const timerFn=e=>{e=unwrap(e);
  if(ts.isIdentifier(e)) return timerNames.has(e.text)||timerAliases.has(e.text);
  const name=propName(e);
  if(name){const recv=unwrap(e.expression);
   return timerNames.has(name)||/^(wait|yield)$/.test(name)&&(ts.isIdentifier(recv)?waitObjects.has(recv.text):propName(recv)==='scheduler');}
  if(!ts.isCallExpression(e)) return false;
  if(method(e)==='bind') return timerFn(unwrap(e.expression).expression);
  return /(^|\.)promisify$/.test(calleeName(e)??'')&&e.arguments.length>0&&timerFn(e.arguments[0]);};
 // A call that runs its callbacks later: a timer (directly, through .call/.apply, or a promise chained
 // on one, as timers/promises returns) or, unless only timers count, a listener on any receiver.
 const schedules=(call,listeners=true)=>{const c=unwrap(call.expression),name=propName(c)??'';
  if(timerFn(c)) return true;
  if(listeners&&/^(listen|on|once|addListener|prependListener|prependOnceListener|addEventListener)$/.test(name)) return true;
  if(name==='call'||name==='apply') return timerFn(c.expression);
  if(/^(then|catch|finally)$/.test(name)){const r=unwrap(c.expression);return ts.isCallExpression(r)&&schedules(r,listeners);}
  return false;};
 for(let grew=true;grew;){grew=false;
  const bind=(set,id)=>{if(ts.isIdentifier(id)&&!set.has(id.text)){set.add(id.text);grew=true;}};
  for(const n of nodes){
   // import { setTimeout as sleep, scheduler } from 'node:timers/promises'; const { nextTick: tick } = process;
   if(ts.isImportSpecifier(n)||ts.isBindingElement(n)&&ts.isObjectBindingPattern(n.parent)){
    const key=n.propertyName??n.name,named=ts.isIdentifier(key)||ts.isStringLiteralLike(key)?key.text:'';
    if(timerNames.has(named)) bind(timerAliases,n.name); else if(named==='scheduler') bind(waitObjects,n.name);
   }
   // const later = globalThis.setTimeout; const sleep = promisify(setTimeout); const ticks = setInterval(60_000);
   if(ts.isVariableDeclaration(n)&&n.initializer){const init=unwrap(n.initializer);
    if(timerFn(init)) bind(timerAliases,n.name);
    else if(ts.isCallExpression(init)&&schedules(init,false)) bind(tickers,n.name);
   }
  }
 }
 // A loop a timer paces is a poll: `for await (… of setInterval(ms))` from timers/promises, or a
 // `while (true)` / `for (;;)` whose body waits on a timer, directly or through a local helper that
 // sets one (`const wait = ms => new Promise(r => setTimeout(r, ms))`). A bounded retry loop is not one.
 const forever=p=>(ts.isWhileStatement(p)||ts.isDoStatement(p))&&p.expression.kind===ts.SyntaxKind.TrueKeyword||ts.isForStatement(p)&&!p.condition;
 const pacers=new Set();
 const timed=body=>{let found=false;(function walk(x){if(found) return;
  if(ts.isCallExpression(x)&&(schedules(x,false)||pacers.has(calleeName(x)))) found=true;else ts.forEachChild(x,walk);})(body);return found;};
 for(let grew=true;grew;){grew=false;
  for(const f of nodes){const name=isFn(f)&&f.body&&fnName(f);if(name&&!pacers.has(name)&&timed(f.body)){pacers.add(name);grew=true;}}
 }
 const ticks=p=>{if(!ts.isForOfStatement(p)) return false;const e=unwrap(p.expression);
  return ts.isCallExpression(e)?schedules(e,false):ts.isIdentifier(e)&&tickers.has(e.text);};
 const polled=n=>{for(let c=n,p=n.parent;p&&p!==demandLoader;c=p,p=p.parent)
  if(c===p.statement&&(ticks(p)||forever(p)&&timed(p.statement))) return true;
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
 // A loading function passed by reference (or bound) to something that will call it later;
 // `t.apply(this, [load, ms])` passes what its array holds.
 const handed=call=>{const list=call.arguments[1]&&unwrap(call.arguments[1]);
  return method(call)==='apply'&&list&&ts.isArrayLiteralExpression(list)?[call.arguments[0],...list.elements]:call.arguments;};
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
  // A listener on any receiver.
  `createServer(app).listen(1, '127.0.0.1', warmDirectory);`,
  `app.server.on('listening', () => warmDirectory());`,
  `server.addListener('listening', warmDirectory);`,
  // A promise reaction, array callback or promise executor runs at module evaluation here.
  `void Promise.resolve().then(warmDirectory);`,
  `void fetch('https://gate.example/').then(() => autoFetchAdmin({}));`,
  `['acme'].forEach(t => void autoFetchAdmin({ t }));`,
  `void new Promise(resolve => resolve(warmDirectory()));`,
  `const boot = () => Promise.resolve().then(warmDirectory); void boot();`,
 ]){
  const { eager }=eagerDirectoryLoads(ts,prelude+eagerForm);
  assert.equal(eager.length,1,`not caught: ${eagerForm} -> ${JSON.stringify(eager)}`);
 }
 // Inside a request these run on demand, a timer that loads nothing is fine, and so is a bounded
 // retry, a loop over a request body, and a loop that waits on something other than a timer.
 for(const lazyForm of [
  `app.get('/y', async () => { await Promise.resolve().then(warmDirectory); });`,
  `app.get('/y', () => fetch('/x').then(() => autoFetchAdmin({})));`,
  `app.get('/y', () => ['acme'].map(t => autoFetchAdmin({ t })));`,
  `globalThis.setTimeout(unrelatedTask, 1); process.nextTick(() => console.log('tick'));`,
  `const later = globalThis.setTimeout; app.get('/y', async () => { await warmDirectory(); }); later(() => console.log('tick'), 1);`,
  `import { setTimeout as sleep } from 'node:timers/promises'; app.get('/y', async () => { await sleep(10); await warmDirectory(); });`,
  `app.get('/y', async () => { for (let i = 0; i < 3; i++) { try { return await autoFetchAdmin({}); } catch { await new Promise(r => setTimeout(r, 100 * 2 ** i)); } } });`,
  `const wait = (ms) => new Promise(r => setTimeout(r, ms)); app.get('/y', async () => { for (let i = 0; i < 3; i++) { await wait(10); await warmDirectory(); } });`,
  `app.get('/y', async (req) => { for await (const chunk of req) await directoryUsersCache.observe(chunk); });`,
  `async function drain() { while (true) { await queue.wait(); await warmDirectory(); } } app.get('/y', () => drain());`,
  `server.on('error', e => console.error(e));`,
 ]){
  assert.deepEqual(eagerDirectoryLoads(ts,prelude+lazyForm).eager,[],lazyForm);
 }
});
