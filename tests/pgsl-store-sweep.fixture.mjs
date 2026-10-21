import assert from 'node:assert/strict';
import {Client} from 'pg@8';
import {installSweep,sweepStore} from '../tools/pgsl-store-sweep.mjs';
import {nodeKey,cpKey,ovKey} from '../packages/pgsl-store/src/keyspace.ts';
const url=new URL(Bun.env.PGSL_SWEEP_FIXTURE_URL);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.username,'gc_sweep_fixture');
const admin=new Client({connectionString:url.href});await admin.connect();
const prefix='sweep_'+crypto.randomUUID().replaceAll('-','').slice(0,12),databases=[],clients=[],results=[];
const connect=async name=>{const u=new URL(url);u.pathname='/'+name;const c=new Client({connectionString:u.href});await c.connect();clients.push(c);return c;};
const fresh=async()=>{
 const name=prefix+'_'+databases.length;await admin.query('CREATE DATABASE "'+name+'"');databases.push(name);
 const client=await connect(name),watchdog=await connect(name),writer=await connect(name);
 await client.query('CREATE TABLE public.pgsl_kv(k bytea PRIMARY KEY,v bytea NOT NULL)');
 await client.query('CREATE TABLE public.relay_pgsl_published(k bytea PRIMARY KEY,v bytea NOT NULL)');
 return{client,watchdog,writer};
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
  const f=await fresh(),c=f.client;for(let i=1;i<=4;i++)await atom(c,i);
  await put(c,key(5,'fragment'),Buffer.from(JSON.stringify({uri:uri(5,true,'fragment'),kind:'fragment',level:1,items:[uri(4,true)]})));
  await put(c,cp('ldp fixture','current'),body(uri(1)));
  await put(c,cp('native_lrs_artifact','historical-operation'),body(uri(2,true)));
  await put(c,Buffer.from(ovKey('fixture','current')),Buffer.from(uri(5,false,'fragment')));
  await c.query('INSERT INTO public.relay_pgsl_published VALUES($1,$2)',[Buffer.alloc(0),Buffer.from([0xff,0,0xfe])]);
  const relay=(await c.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows;
  await installSweep(c);assert.equal((await sweepStore(opts(f))).status,'warming');assert.equal(await exists(c,key(3)),true);
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
  await assert.rejects(sweepStore({...opts(f),measureFreeBytes:async()=>0}),/sweep aborted/);assert.equal(await exists(c,key(11)),true);
  results.push('corrupt roots, unknown namespace and insufficient space abort without deleting user rows');
 }
 {
  const f=await fresh(),c=f.client;await atom(c,20);await atom(c,21,70_000);await atom(c,22,70_000);
  await put(c,cp('ldp fixture','writer'),body(uri(20)));await installSweep(c);await age(c);
  let writing,triggered=false;
  await assert.rejects(sweepStore({...opts(f),batchBytes:70_500,onPhase:async phase=>{
   if(phase!=='deleted'||triggered)return;triggered=true;
   writing=f.writer.query('INSERT INTO public.pgsl_kv VALUES($1,$2)',[cp('ldp fixture','arrived-during-sweep'),body(uri(21))]);
   await Bun.sleep(1000);
  }}),/sweep aborted/);
  assert.equal(triggered,true);await writing;assert.equal(await exists(c,key(21)),true);assert.equal(await exists(c,key(22)),true);
  assert.equal(await exists(c,cp('ldp fixture','arrived-during-sweep')),true);
  results.push('queued writer after one DELETE rolls back every batch before admitting its new root');
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
 console.log(JSON.stringify({kind:'sweep_fixture_pass',passed:results.length,results}));
}finally{
 for(const c of clients){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}
 for(const name of databases){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query('DROP DATABASE "'+name+'"');}
 await admin.end();
}
