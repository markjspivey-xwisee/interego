import assert from 'node:assert/strict';
import { Client } from 'pg@8';
import { copyLiveDatabase } from '../tools/pgsl-live-copy.ts';
import { nodeKey, cpKey, ovKey } from '../packages/pgsl-store/src/keyspace.ts';
const url=new URL(Bun.env.PGSL_COPY_FIXTURE_URL!);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
assert.equal(url.pathname,'/postgres');assert.equal(url.username,'copy_fixture');
const admin=new Client({connectionString:url.href});await admin.connect();
const prefix='copy_'+crypto.randomUUID().replaceAll('-','').slice(0,12);
const databases:string[]=[],clients:Client[]=[];
const connect=async(name:string)=>{
  const conn=new URL(url);conn.pathname='/'+name;const client=new Client({connectionString:conn.href});
  await client.connect();clients.push(client);return client;
};
const fresh=async()=>{
  const name=prefix+'_'+databases.length;assert.match(name,/^copy_[a-f0-9]+_\d+$/);
  await admin.query('CREATE DATABASE "'+name+'"');databases.push(name);return connect(name);
};
const options={fixtureSameServer:true,maxInputBytes:1_000_000,maxTargetDatabaseBytes:100_000_000,maxValueBytes:4_000_000,payloadBatchBytes:1024};
const results:string[]=[];
try {
  const source=await fresh();
  await source.query('CREATE TABLE public.pgsl_kv(k bytea NOT NULL,v bytea NOT NULL,CONSTRAINT pgsl_kv_live_pkey PRIMARY KEY(k))');
  await source.query('CREATE TABLE public.relay_pgsl_published(k bytea NOT NULL,v bytea NOT NULL,CONSTRAINT relay_pgsl_published_pkey PRIMARY KEY(k))');
  const atomHash='a'.repeat(40),fragHash='b'.repeat(40),orphanHash='c'.repeat(40);
  const atomUri='https://fixture.example/ns/pgsl/atom/'+atomHash,fragUri='https://fixture.example/ns/pgsl/fragment/'+fragHash;
  const atomKey=Buffer.from(nodeKey({kind:'atom',hash:Buffer.from(atomHash,'hex')}));
  const fragKey=Buffer.from(nodeKey({kind:'fragment',hash:Buffer.from(fragHash,'hex')}));
  const atomBody=Buffer.from(JSON.stringify({uri:atomUri,kind:'atom',level:0,value:'__ENCRYPTED__',provenance:{ciphertext:'opaque'}}));
  const fragmentBody=Buffer.from(JSON.stringify({uri:fragUri,kind:'fragment',level:1,items:[atomUri]}));
  const insert=async(table:string,k:Buffer,v:Buffer)=>source.query('INSERT INTO public.'+table+'(k,v) VALUES($1,$2)',[k,v]);
  await insert('pgsl_kv',atomKey,atomBody);await insert('pgsl_kv',fragKey,fragmentBody);
  await insert('pgsl_kv',Buffer.from(cpKey('ldp fixture','current')),Buffer.from(JSON.stringify({topUri:fragUri})));
  await insert('pgsl_kv',Buffer.from(ovKey('fixture','current')),Buffer.from(fragUri));
  await insert('pgsl_kv',Buffer.from(nodeKey({kind:'atom',hash:Buffer.from(orphanHash,'hex')})),Buffer.from('unreferenced invalid private JSON'));
  await insert('relay_pgsl_published',Buffer.alloc(0),Buffer.from([0xff,0,0xfe]));
  await insert('relay_pgsl_published',Buffer.from('unrelated-user-row'),Buffer.from('retain every unrelated relay byte'));
  const target=await fresh(),session=await copyLiveDatabase(source,target,options);
  assert.equal(session.state,'verified-source-fenced');
  assert.equal((session.receipt.kv as any).rows,4);assert.equal((session.receipt.relay as any).rows,2);
  assert.equal(session.receipt.liveNodes,2);
  assert.ok(Object.values(session.receipt.missingDerived as Record<string,number>).reduce((a,b)=>a+b,0)>0);
  assert.deepEqual((await target.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows,(await source.query('SELECT k,v FROM public.relay_pgsl_published ORDER BY k')).rows);
  const writer=await connect(databases[0]!);await writer.query("SET lock_timeout='100ms'");
  await assert.rejects(writer.query('INSERT INTO public.relay_pgsl_published VALUES($1,$2)',[Buffer.from('blocked'),Buffer.from('blocked')]),(error:any)=>error.code==='55P03');
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
  const lostSource=await connect(databases[0]!),lostTarget=await fresh();let killed=false;
  const wrapper={query:async(sql:string,params?:unknown[])=>{
    if(!killed&&sql.startsWith('INSERT INTO public."pgsl_kv"')){killed=true;await admin.query('SELECT pg_terminate_backend($1)',[lostSource.processID]);await Bun.sleep(25);}
    return lostTarget.query(sql,params);
  },end:()=>lostTarget.end()};
  await assert.rejects(copyLiveDatabase(lostSource,wrapper,options),/live copy refused:/);assert.equal(killed,true);
  results.push('source disconnect cannot return ready');
  const handoffSource=await connect(databases[0]!),handoffTarget=await fresh();
  const prepared=await copyLiveDatabase(handoffSource,handoffTarget,options);
  await prepared.prepareVolumeCutover();assert.equal(prepared.state,'prepared-for-volume-cutover');
  await assert.rejects(prepared.abortBeforeCutover(),/prepared cutover requires operator recovery/);
  await admin.query('SELECT pg_terminate_backend($1)',[handoffSource.processID]);await Bun.sleep(25);
  assert.equal(prepared.state,'source-disconnected-after-preparation');
  results.push('source disconnect is expected only after explicit verified volume preparation');
  console.log(JSON.stringify({kind:'fixture_pass',passed:results.length,results}));
} finally {
  for(const client of clients)await client.end().catch(()=>{});
  for(const name of databases){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query('DROP DATABASE "'+name+'"');}
  await admin.end();
}
