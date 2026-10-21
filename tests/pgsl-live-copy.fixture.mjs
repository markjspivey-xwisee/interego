import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Client } from 'pg@8';
import { copyLiveDatabase, holdsPreparedFence } from '../tools/pgsl-live-copy.ts';
import { nodeKey, cpKey, ovKey } from '../packages/pgsl-store/src/keyspace.ts';
const urls={source:new URL(Bun.env.PGSL_COPY_FIXTURE_URL),target:new URL(Bun.env.PGSL_COPY_FIXTURE_TARGET_URL)};
for(const url of Object.values(urls)){assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.username,'copy_fixture');}
const admins={source:new Client({connectionString:urls.source.href}),target:new Client({connectionString:urls.target.href})};
await admins.source.connect();await admins.target.connect();
const systemId=async(client)=>(await client.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
assert.notEqual(await systemId(admins.source),await systemId(admins.target),'fixture requires two independently initialized PG16 servers');
const prefix='copy_'+crypto.randomUUID().replaceAll('-','').slice(0,12);
const databases=[],clients=[];
const connect=async(kind,name)=>{
  const conn=new URL(urls[kind]);conn.pathname='/'+name;const client=new Client({connectionString:conn.href});
  await client.connect();clients.push(client);return client;
};
const fresh=async(kind='target')=>{
  const name=prefix+'_'+databases.length;assert.match(name,/^copy_[a-f0-9]+_\d+$/);
  await admins[kind].query('CREATE DATABASE "'+name+'"');databases.push({kind,name});return connect(kind,name);
};
const options={maxInputBytes:1_000_000,maxTargetDatabaseBytes:100_000_000,maxValueBytes:4_000_000,payloadBatchBytes:1024};
const results=[];
try {
  const source=await fresh('source');
  await admins.source.query("SET password_encryption='scram-sha-256'");
  await admins.source.query("CREATE ROLE relay_pgsl LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD 'fixture_private_password'");
  await source.query('CREATE TABLE public.pgsl_kv(k bytea NOT NULL,v bytea NOT NULL,CONSTRAINT pgsl_kv_live_pkey PRIMARY KEY(k))');
  await source.query('CREATE TABLE public.relay_pgsl_published(k bytea NOT NULL,v bytea NOT NULL,CONSTRAINT relay_pgsl_published_pkey PRIMARY KEY(k))');
  await source.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.relay_pgsl_published TO relay_pgsl');
  await source.query('ALTER TABLE public.pgsl_kv SET (autovacuum_vacuum_scale_factor=0.02,autovacuum_vacuum_threshold=5000,autovacuum_analyze_scale_factor=0.02,autovacuum_analyze_threshold=5000)');
  const atomHash='a'.repeat(40),fragHash='b'.repeat(40),orphanHash='c'.repeat(40);
  const atomUri='https://fixture.example/ns/pgsl/atom/'+atomHash,fragUri='https://fixture.example/ns/pgsl/fragment/'+fragHash;
  const atomKey=Buffer.from(nodeKey({kind:'atom',hash:Buffer.from(atomHash,'hex')}));
  const fragKey=Buffer.from(nodeKey({kind:'fragment',hash:Buffer.from(fragHash,'hex')}));
  const atomBody=Buffer.from(JSON.stringify({uri:atomUri,kind:'atom',level:0,value:'__ENCRYPTED__',provenance:{ciphertext:'opaque'}}));
  const fragmentBody=Buffer.from(JSON.stringify({uri:fragUri,kind:'fragment',level:1,items:[atomUri]}));
  const insert=async(table,k,v)=>source.query('INSERT INTO public.'+table+'(k,v) VALUES($1,$2)',[k,v]);
  await insert('pgsl_kv',atomKey,atomBody);await insert('pgsl_kv',fragKey,fragmentBody);
  await insert('pgsl_kv',Buffer.from(cpKey('ldp fixture','current')),Buffer.from(JSON.stringify({topUri:fragUri})));
  await insert('pgsl_kv',Buffer.from(ovKey('fixture','current')),Buffer.from(fragUri));
  await insert('pgsl_kv',Buffer.from(nodeKey({kind:'atom',hash:Buffer.from(orphanHash,'hex')})),Buffer.from('unreferenced invalid private JSON'));
  await insert('relay_pgsl_published',Buffer.alloc(0),Buffer.from([0xff,0,0xfe]));
  await insert('relay_pgsl_published',Buffer.from('unrelated-user-row'),Buffer.from('retain every unrelated relay byte'));
  const target=await fresh(),session=await copyLiveDatabase(source,target,options);
  assert.equal(session.state,'verified-source-fenced');
  assert.equal((session.receipt.kv).rows,4);assert.equal((session.receipt.relay).rows,2);
  assert.equal(session.receipt.liveNodes,2);
  assert.ok(Object.values(session.receipt.missingDerived).reduce((a,b)=>a+b,0)>0);
  assert.deepEqual((await target.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows,(await source.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows);
  assert.ok(!JSON.stringify(session.receipt).includes('SCRAM-SHA-256'));
  assert.deepEqual((await target.query("SELECT reloptions FROM pg_class WHERE oid='public.pgsl_kv'::regclass")).rows,
    (await source.query("SELECT reloptions FROM pg_class WHERE oid='public.pgsl_kv'::regclass")).rows);
  const relayUrl=new URL(urls.target);relayUrl.pathname='/'+databases[1].name;relayUrl.username='relay_pgsl';relayUrl.password='fixture_private_password';
  const relay=new Client({connectionString:relayUrl.href});await relay.connect();clients.push(relay);
  assert.equal((await relay.query('SELECT count(*)::int n FROM public.relay_pgsl_published')).rows[0].n,2);
  assert.equal((await relay.query("SELECT has_table_privilege(current_user,'public.pgsl_kv','SELECT') AS allowed")).rows[0].allowed,false);
  results.push('SCRAM role authentication and exact limited relay ACL survive on a different PG16 server');
  const writer=await connect('source',databases[0].name);await writer.query("SET lock_timeout='100ms'");
  await assert.rejects(writer.query('INSERT INTO public.relay_pgsl_published VALUES($1,$2)',[Buffer.from('blocked'),Buffer.from('blocked')]),(error)=>error.code==='55P03');
  await session.abortBeforeCutover();await writer.query('SELECT 1');
  results.push('URL roots, encrypted address, missing derived indexes, raw relay bytes, held writer fence');
  await assert.rejects(copyLiveDatabase(source,source,options),/destination is the source server/);
  results.push('same source identity refuses before writes');
  const occupied=await fresh();await occupied.query('CREATE TABLE sentinel(value bytea)');
  await assert.rejects(copyLiveDatabase(source,occupied,options),/destination contains user relations/);
  assert.equal((await occupied.query('SELECT count(*)::int n FROM sentinel')).rows[0].n,0);
  results.push('nonempty target refuses without touching unrelated table');
  const badTarget=await fresh();
  const invalidUtf8=Buffer.concat([Buffer.from('{"uri":"'+atomUri+'","kind":"atom","level":0,"value":"'),Buffer.from([0xff]),Buffer.from('"}')]);
  await source.query('UPDATE public.pgsl_kv SET v=$2 WHERE k=$1',[atomKey,invalidUtf8]);
  await assert.rejects(copyLiveDatabase(source,badTarget,options),/live copy refused:/);
  assert.deepEqual((await source.query('SELECT v FROM public.pgsl_kv WHERE k=$1',[atomKey])).rows[0].v,invalidUtf8);
  await source.query('UPDATE public.pgsl_kv SET v=$2 WHERE k=$1',[atomKey,atomBody]);
  results.push('fatal UTF8 aborts and preserves source bytes');
  const unknownTarget=await fresh(),unknownKey=Buffer.from('unrelated-keyspace');
  await insert('pgsl_kv',unknownKey,Buffer.from('private unrelated data'));
  await assert.rejects(copyLiveDatabase(source,unknownTarget,options),/unknown KV namespace/);
  assert.equal((await source.query('SELECT v FROM public.pgsl_kv WHERE k=$1',[unknownKey])).rows[0].v.toString(),'private unrelated data');
  await source.query('DELETE FROM public.pgsl_kv WHERE k=$1',[unknownKey]);
  results.push('unknown keyspace refuses instead of dropping user data');
  const lostSource=await connect('source',databases[0].name),lostTarget=await fresh();let killed=false;
  const wrapper={query:async(sql,params)=>{
    if(!killed&&sql.startsWith('INSERT INTO public."pgsl_kv"')){killed=true;await admins.source.query('SELECT pg_terminate_backend($1)',[lostSource.processID]);await Bun.sleep(25);}
    return lostTarget.query(sql,params);
  },end:()=>lostTarget.end()};
  await assert.rejects(copyLiveDatabase(lostSource,wrapper,options),/live copy refused:/);assert.equal(killed,true);
  results.push('source disconnect cannot return ready');
  const handoffSource=await connect('source',databases[0].name),handoffTarget=await fresh();
  let allowTargetEnd,enteredTargetEnd;
  const paused=new Promise(resolve=>{allowTargetEnd=resolve;}),entered=new Promise(resolve=>{enteredTargetEnd=resolve;});
  const handoffWrapper={query:(sql,params)=>handoffTarget.query(sql,params),end:async()=>{enteredTargetEnd();await paused;await handoffTarget.end();}};
  const prepared=await copyLiveDatabase(handoffSource,handoffWrapper,options);
  const preparation=prepared.prepareVolumeCutover();
  assert.equal(prepared.state,'preparing-volume-cutover');
  await entered;
  await assert.rejects(prepared.abortBeforeCutover(),/prepared cutover requires operator recovery/);
  await assert.rejects(prepared.prepareVolumeCutover(),/copy is not ready/);
  await assert.rejects(writer.query('INSERT INTO public.relay_pgsl_published VALUES($1,$2)',[Buffer.from('still-blocked'),Buffer.from('still-blocked')]),error=>error.code==='55P03');
  allowTargetEnd();await preparation;assert.equal(prepared.state,'prepared-for-volume-cutover');
  results.push('concurrent abort and duplicate prepare cannot release the writer fence');
  await assert.rejects(prepared.abortBeforeCutover(),/prepared cutover requires operator recovery/);
  await admins.source.query('SELECT pg_terminate_backend($1)',[handoffSource.processID]);await Bun.sleep(25);
  assert.equal(prepared.state,'source-disconnected-after-preparation');
  results.push('source disconnect is expected only after explicit verified volume preparation');
  const wrapperSource=await readFile(new URL('../tools/pgsl-live-copy.railway.mjs',import.meta.url),'utf8');
  const start=wrapperSource.indexOf('const modules=')+'const modules='.length;
  const end=wrapperSource.indexOf(';\nconst required=',start);
  const bundled=JSON.parse(wrapperSource.slice(start,end));
  const coreSource=await readFile(new URL('../tools/pgsl-live-copy.ts',import.meta.url),'utf8');
  assert.equal(bundled['live-copy.ts'],coreSource.replaceAll('../packages/pgsl-store/src/gc.js','./gc.ts')
    .replaceAll('../packages/pgsl-store/src/addressing.js','./addressing.ts').replaceAll('../packages/pgsl-store/src/keyspace.js','./keyspace.ts'));
  const watchdogSource=wrapperSource.slice(wrapperSource.indexOf('let overdueReported=false;'),wrapperSource.indexOf('const awaitPreparedStop='));
  for(const state of ['preparing-volume-cutover','prepared-for-volume-cutover','preparation-failed-source-fenced','verified-source-fenced']){
    const calls={source:0,target:0,stop:0,exit:0},events=[];
    const watchdog=vm.runInNewContext(watchdogSource+'\nwatchdog',{
      session:{state},holdsPreparedFence,Date:{now:()=>100},validUntil:1,phase:state,
      log:event=>events.push(event),server:{stop:()=>{calls.stop++;}},
      source:{end:async()=>{calls.source++;}},target:{end:async()=>{calls.target++;}},
      process:{exit:()=>{calls.exit++;}},setInterval:fn=>fn,setTimeout:fn=>fn()
    });
    watchdog();await Promise.resolve();
    if(holdsPreparedFence(state)){
      assert.deepEqual(calls,{source:0,target:0,stop:0,exit:0});
      assert.equal(events[0].kind,'prepared-handoff-overdue-fence-held');
    }else assert.deepEqual(calls,{source:1,target:1,stop:1,exit:1});
  }
  results.push('actual Railway watchdog retains preparing/prepared fences after expiry; embedded core matches tested source');
  console.log(JSON.stringify({kind:'fixture_pass',passed:results.length,results}));
} finally {
  for(const client of clients)await client.end().catch(()=>{});
  for(const {kind,name}of databases){await admins[kind].query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admins[kind].query('DROP DATABASE "'+name+'"');}
  for(const admin of Object.values(admins)){await admin.query('DROP ROLE IF EXISTS relay_pgsl');await admin.end();}
}
