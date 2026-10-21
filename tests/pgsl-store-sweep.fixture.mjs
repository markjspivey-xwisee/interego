import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {Client} from 'pg@8';
import {installSweep,sweepStore} from '../tools/pgsl-store-sweep.mjs';
import {openPgStore} from '../packages/pgsl-store/src/pg-store.ts';
import {readerFromPg,collectLive} from '../packages/pgsl-store/src/gc.ts';
import {nodeKey,cpKey,ovKey} from '../packages/pgsl-store/src/keyspace.ts';
const url=new URL(process.env.PGSL_SWEEP_FIXTURE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.username,'gc_sweep_fixture');
const admin=new Client({connectionString:url.href});await admin.connect();
const prefix='sweep_'+randomUUID().replaceAll('-','').slice(0,12),databases=[],clients=[],results=[];
const connect=async name=>{const u=new URL(url);u.pathname='/'+name;const c=new Client({connectionString:u.href});await c.connect();clients.push(c);return c;};
const fresh=async()=>{
 const name=prefix+'_'+databases.length;await admin.query('CREATE DATABASE "'+name+'"');databases.push(name);
 const client=await connect(name),watchdog=await connect(name),writer=await connect(name);
 await client.query('CREATE TABLE public.pgsl_kv(k bytea PRIMARY KEY,v bytea NOT NULL)');
 await client.query('CREATE TABLE public.relay_pgsl_published(k bytea PRIMARY KEY,v bytea NOT NULL)');
 const connectionString=new URL(url);connectionString.pathname='/'+name;
 return{client,watchdog,writer,connectionString:connectionString.href};
};
const hash=i=>i.toString(16).padStart(40,'0'),uri=(i,url=false,kind='atom')=>url?'https://fixture.example/ns/pgsl/'+kind+'/'+hash(i):'urn:pgsl:'+kind+':'+hash(i);
const key=(i,kind='atom')=>Buffer.from(nodeKey({kind,hash:Buffer.from(hash(i),'hex')}));
const put=(c,k,v)=>c.query('INSERT INTO public.pgsl_kv(k,v) VALUES($1,$2)',[k,v]);
const atom=(c,i,size=128)=>put(c,key(i),Buffer.from(JSON.stringify({uri:uri(i),kind:'atom',level:0,value:'opaque-'+i+'x'.repeat(size)})));
const cp=(scope,id)=>Buffer.from(cpKey(scope,id)),body=u=>Buffer.from(JSON.stringify({topUri:u}));
const exists=async(c,k)=>(await c.query('SELECT EXISTS(SELECT 1 FROM public.pgsl_kv WHERE k=$1) AS present',[k])).rows[0].present;
const age=c=>c.query("UPDATE public.pgsl_kv_gc_state SET installed_at=clock_timestamp()-interval '2 hours'");
const opts=f=>({...f,measureFreeBytes:async()=>64*1024**3,minFreeBytes:1024**3,maxDeleteBytes:64*1024**2,batchBytes:64*1024,maxSeconds:30});
try{
 {
  const root=new URL('../',import.meta.url);
  const bundle=await readFile(new URL('tools/pgsl-store-sweep.railway.mjs',root),'utf8');
  const modules=JSON.parse(bundle.match(/const modules=(\{.*\});\n/)[1]);
  const sources={
   'addressing.ts':['packages/pgsl-store/src/addressing.ts',[]],
   'keyspace.ts':['packages/pgsl-store/src/keyspace.ts',[["'./addressing.js'","'./addressing.ts'"]]],
   'gc-atom-header.ts':['packages/pgsl-store/src/gc-atom-header.ts',[["'./addressing.js'","'./addressing.ts'"],["'./keyspace.js'","'./keyspace.ts'"]]],
   'gc.ts':['packages/pgsl-store/src/gc.ts',[["'./addressing.js'","'./addressing.ts'"],["'./keyspace.js'","'./keyspace.ts'"],["'./gc-atom-header.js'","'./gc-atom-header.ts'"]]],
   'volume.mjs':['tools/pgsl-store-gc-volume.mjs',[]],
   'sweep.mjs':['tools/pgsl-store-sweep.mjs',[["'../packages/pgsl-store/src/gc.js'","'./gc.ts'"],["'../packages/pgsl-store/src/keyspace.js'","'./keyspace.ts'"],["'../packages/pgsl-store/src/addressing.js'","'./addressing.ts'"],["'./pgsl-store-gc-volume.mjs'","'./volume.mjs'"],["from 'pg'","from 'pg@8.22.0'"]]],
  };
  assert.deepEqual(Object.keys(modules).sort(),Object.keys(sources).sort());
  for(const[name,[path,rewrites]]of Object.entries(sources)){
   let source=await readFile(new URL(path,root),'utf8');
   for(const[from,to]of rewrites)source=source.replaceAll(from,to);
   assert.equal(modules[name],source,'bundled source equality: '+name);
  }
  const disabled=spawnSync(process.execPath,[new URL('tools/pgsl-store-sweep.railway.mjs',root).pathname],{
   env:{...process.env,PGSL_SWEEP_ACTION:'off',PGSL_PG_CONNSTR:'invalid-do-not-connect',RAILWAY_PROJECT_TOKEN:'fixture-secret-not-logged'},
   encoding:'utf8',timeout:10000});
  assert.equal(disabled.status,0);assert.equal(disabled.stderr,'');assert.equal(disabled.stdout.trim(),'Private PGSL sweep is disabled.');
  results.push('self-contained function matches source exactly and default off never opens invalid DB credentials');
 }
 {
  const f=await fresh(),c=f.client;for(let i=1;i<=4;i++)await atom(c,i);
  await put(c,key(5,'fragment'),Buffer.from(JSON.stringify({uri:uri(5,true,'fragment'),kind:'fragment',level:1,items:[uri(4,true)]})));
  await put(c,cp('ldp fixture','current'),body(uri(1)));
  await put(c,cp('native_lrs_artifact','historical-operation'),body(uri(2,true)));
  await put(c,Buffer.from(ovKey('fixture','current')),Buffer.from(uri(5,false,'fragment')));
  await c.query('INSERT INTO public.relay_pgsl_published VALUES($1,$2)',[Buffer.alloc(0),Buffer.from([0xff,0,0xfe])]);
  const relay=(await c.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows;
  await installSweep(c);assert.equal((await sweepStore(opts(f))).status,'warming');assert.equal(await exists(c,key(3)),true);
  const measured=await sweepStore({...opts(f),dryRun:true});assert.equal(measured.status,'measured');assert.equal(measured.deletedKeys,0);assert.ok(measured.markMilliseconds>=0);assert.equal(await exists(c,key(3)),true);
  await age(c);await c.query('UPDATE public.pgsl_kv SET v=$2 WHERE k=$1',[cp('ldp fixture','current'),body(uri(5,true,'fragment'))]);
  const r=await sweepStore(opts(f));assert.equal(r.status,'swept');assert.ok(r.deletedKeys>=1);
  for(const [i,kind]of [[1,'atom'],[2,'atom'],[4,'atom'],[5,'fragment']])assert.equal(await exists(c,key(i,kind)),true,'retained node '+i);
  assert.equal(await exists(c,key(3)),false);assert.deepEqual((await c.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows,relay);
  await c.query("UPDATE public.pgsl_kv_gc_roots SET retired_at=clock_timestamp()-interval '2 hours'");
  await sweepStore(opts(f));assert.equal(await exists(c,key(1)),false);assert.equal(await exists(c,key(2)),true);
  results.push('one-hour retired root, URL/URN graph and permanent native history survive; unrelated relay bytes unchanged');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,10);await atom(c,11);
  const k=cp('ldp fixture','corrupt'),valid=body(uri(10));await put(c,k,valid);await installSweep(c);await age(c);
  await c.query('UPDATE public.pgsl_kv SET v=$2 WHERE k=$1',[k,Buffer.from('{invalid JSON')]);
  await assert.rejects(sweepStore(opts(f)),/refusing sweep/);assert.equal(await exists(c,key(11)),true);
  await c.query('UPDATE public.pgsl_kv SET v=$2 WHERE k=$1',[k,valid]);
  // The malformed historical root is also protected by fail-closed validation.
  await c.query("UPDATE public.pgsl_kv_gc_roots SET retired_at=clock_timestamp()-interval '2 hours'");
  const unknown=Buffer.from('unrelated-keyspace');await put(c,unknown,Buffer.from('private unrelated bytes'));
  await assert.rejects(sweepStore(opts(f)),/refusing sweep/);assert.equal(await exists(c,unknown),true);await c.query('DELETE FROM public.pgsl_kv WHERE k=$1',[unknown]);
  const malformed=Buffer.from('pgsl\0N');
  await put(c,malformed,Buffer.from('unknown node layout'));
  await assert.rejects(sweepStore(opts(f)),/malformed node key/);
  assert.equal(await exists(c,malformed),true);assert.equal(await exists(c,key(11)),true);
  await c.query('DELETE FROM public.pgsl_kv WHERE k=$1',[malformed]);
  await assert.rejects(sweepStore({...opts(f),measureFreeBytes:async()=>0}),/sweep aborted/);assert.equal(await exists(c,key(11)),true);
  results.push('corrupt roots, unknown namespace and insufficient space abort without deleting user rows');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,20);await atom(c,21,70_000);await atom(c,22,70_000);
  await put(c,cp('ldp fixture','writer'),body(uri(20)));await installSweep(c);await age(c);
  const adapter=await openPgStore({connectionString:f.connectionString,ensureSchema:false});
  let writing,triggered=false;
  try {
   await assert.rejects(sweepStore({...opts(f),batchBytes:70_500,onPhase:async phase=>{
    if(phase!=='deleted'||triggered)return;triggered=true;
    writing=adapter.transact(async tx=>{
     // Actual READ COMMITTED adapter: its first SELECT must wait behind the
     // maintenance fence, then observe the rolled-back orphan before dedup.
     assert.ok(await tx.get(new Uint8Array(key(21))),'dedup-selected node survives rollback');
     tx.set(new Uint8Array(cp('ldp fixture','arrived-during-sweep')),new Uint8Array(body(uri(21))));
    });
    await delay(1000);
   }}),/sweep aborted/);
   assert.equal(triggered,true);await writing;assert.equal(await exists(c,key(21)),true);assert.equal(await exists(c,key(22)),true);
   assert.equal(await exists(c,cp('ldp fixture','arrived-during-sweep')),true);
  }finally{await adapter.close();}
  results.push('queued real-adapter dedup read after one DELETE rolls back every batch before admitting its new root');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,30);await put(c,cp('ldp fixture','reuse'),body(uri(30)));
  await c.query('ALTER TABLE public.pgsl_kv ALTER COLUMN v SET STORAGE EXTERNAL');
  for(let i=31;i<55;i++)await atom(c,i,256*1024);
  await installSweep(c);await age(c);
  const size=async()=>Number((await c.query("SELECT pg_total_relation_size('public.pgsl_kv')::text AS bytes")).rows[0].bytes);
  const before=await size(),r=await sweepStore({...opts(f),batchBytes:512*1024});assert.ok(r.deletedKeys>=24);assert.equal(await exists(c,key(30)),true);
  const afterSweep=await size();for(let i=55;i<79;i++)await atom(c,i,256*1024);
  assert.ok(await size()<=Math.max(before,afterSweep)+2*1024*1024,'ordinary VACUUM must make old TOAST pages reusable');
  results.push('ordinary VACUUM permits bounded TOAST-page reuse without rewriting table');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,100);
  const sizes=new Map(),children=[];
  for(let i=101;i<141;i++){
   const v=Buffer.from(JSON.stringify({uri:uri(i,false,'fragment'),kind:'fragment',level:1,items:Array(4000).fill(uri(100))}));
   const k=key(i,'fragment');await put(c,k,v);sizes.set(k.toString('hex'),v.length);children.push(uri(i,false,'fragment'));
  }
  const root=Buffer.from(JSON.stringify({uri:uri(141,false,'fragment'),kind:'fragment',level:2,items:children}));
  const rootKey=key(141,'fragment');await put(c,rootKey,root);sizes.set(rootKey.toString('hex'),root.length);
  await put(c,cp('ldp fixture','wide-closure'),body(uri(141,false,'fragment')));
  let largestBatch=0,fragmentQueries=0;
  const observed={query:async(sql,params)=>{
   if(sql.includes('AS atom_header')){
    const fragments=params[0].filter(k=>k[6]===2);
    if(fragments.length){
     fragmentQueries++;largestBatch=Math.max(largestBatch,fragments.length);
     assert.ok(fragments.reduce((total,k)=>total+sizes.get(k.toString('hex')),0)<=8*1024**2,'fragment topology input byte bound');
    }
   }
   return c.query(sql,params);
  }};
  const live=await collectLive(readerFromPg(observed,'pgsl_kv',5000,4096),{traversalBatchSize:4096});
  assert.equal(live.stats.liveNodes,42);assert.equal(live.stats.unreadableNodes,0);
  assert.ok(largestBatch>32,'wide fragment queries must use the opt-in batch');
  assert.ok(fragmentQueries>=3,'stored fragment bytes must split the wide frontier');
  results.push('large fragment frontier uses metadata-sized batches over32 keys while each topology query stays within8MiB');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,200);await atom(c,201,70_000);
  await put(c,cp('ldp fixture','vacuum-failure'),body(uri(200)));await installSweep(c);await age(c);
  await assert.rejects(sweepStore(opts(f)),/orphan value exceeds deletion batch bound/);assert.equal(await exists(c,key(201)),true);
  const wrapped={query:(sql,params)=>sql.startsWith('VACUUM ')?Promise.reject(Error('fixture vacuum unavailable')):c.query(sql,params)};
  const r=await sweepStore({...opts(f),client:wrapped,batchBytes:128*1024});
  assert.equal(r.status,'swept');assert.equal(r.vacuumed,false);assert.equal(await exists(c,key(201)),false);
  results.push('post-commit VACUUM failure reports committed deletes accurately and permits retry');
 }
 {
  const requested=Array.from({length:9},(_,i)=>key(300+i,'fragment'));
  let queries=0;
  const bounded=readerFromPg({query:async(sql)=>{
   queries++;assert.ok(sql.startsWith('SELECT k,octet_length(v)'), 'aggregate refusal must happen before any fragment JSON query');
   return{rows:requested.map(k=>({k,value_bytes:8*1024**2}))};
  }},'pgsl_kv',5000,4096);
  await assert.rejects(bounded.getManyTopology(requested),/refusing collection/);
  assert.equal(queries,1);
  results.push('aggregate fragment frontier over64MiB refuses before exporting topology');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,400);await atom(c,401);
  await put(c,cp('ldp fixture','existing-reader'),body(uri(400)));await installSweep(c);await age(c);
  const adapter=await openPgStore({connectionString:f.connectionString,ensureSchema:false});
  let resume,read;
  const paused=new Promise(resolve=>{resume=resolve;}),selected=new Promise(resolve=>{read=resolve;});
  const writing=adapter.transact(async tx=>{
   assert.ok(await tx.get(new Uint8Array(key(401))));read();await paused;
   tx.set(new Uint8Array(cp('ldp fixture','already-selected')),new Uint8Array(body(uri(401))));
  });
  try {
   await selected;
   await assert.rejects(sweepStore(opts(f)),error=>error.code==='55P03');
   assert.equal(await exists(c,key(401)),true);resume();await writing;
   assert.equal(await exists(c,cp('ldp fixture','already-selected')),true);
  }finally{resume();await writing.catch(()=>{});await adapter.close();}
  results.push('existing real-adapter dedup reader makes ACCESS EXCLUSIVE NOWAIT defer before deletion');
 }
 console.log(JSON.stringify({kind:'sweep_fixture_pass',passed:results.length,results}));
}finally{
 for(const c of clients){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
 for(const name of databases){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query('DROP DATABASE "'+name+'"');}
 await admin.end();
}
