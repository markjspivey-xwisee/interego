import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from 'pg@8';
import {collectLive} from '../packages/pgsl-store/src/gc.ts';
import {nodeKey,cpKey} from '../packages/pgsl-store/src/keyspace.ts';
import {candidateReader,partitionRows,runWarmer,diagnosticOf} from '../tools/pgsl-copy-warmer.mjs';
const urls={source:new URL(Bun.env.PGSL_COPY_FIXTURE_URL),target:new URL(Bun.env.PGSL_COPY_FIXTURE_TARGET_URL)};
for(const u of Object.values(urls)){assert.ok(['127.0.0.1','localhost','[::1]'].includes(u.hostname));assert.equal(u.username,'iegoadmin');assert.equal(u.pathname,'pgsl_prod'.replace(/^/,'/'));}
const clients=[],checks=[];
const SORT_SQL="SELECT i FROM generate_series(1,40000) AS s(i) ORDER BY md5(i::text)||md5((i+1)::text)||md5((i+2)::text)||md5((i+3)::text)";
async function connect(kind,app){const c=new Client({connectionString:urls[kind].href,application_name:app});c.on('error',()=>{});await c.connect();clients.push(c);return c;}
const source=await connect('source','fixture-admin'),target=await connect('target','fixture-admin');
for(const c of [source,target]){await c.query('CREATE TABLE pgsl_kv(k bytea PRIMARY KEY,v bytea NOT NULL)');await c.query('CREATE TABLE relay_pgsl_published(k bytea PRIMARY KEY,v bytea NOT NULL)');}
const uris=[];
for(let i=1;i<=65;i++){const hash=i.toString(16).padStart(40,'0'),uri='https://fixture.example/ns/pgsl/atom/'+hash;uris.push(uri);await source.query('INSERT INTO pgsl_kv VALUES($1,$2)',[Buffer.from(nodeKey({kind:'atom',hash:Buffer.from(hash,'hex')})),Buffer.from(JSON.stringify({uri,kind:'atom',level:0,value:'v'.repeat(i===1?3000:512)}))]);}
const fh='f'.repeat(40),fu='https://fixture.example/ns/pgsl/fragment/'+fh;
await source.query('INSERT INTO pgsl_kv VALUES($1,$2)',[Buffer.from(nodeKey({kind:'fragment',hash:Buffer.from(fh,'hex')})),Buffer.from(JSON.stringify({uri:fu,kind:'fragment',level:1,items:uris}))]);
await source.query('INSERT INTO pgsl_kv VALUES($1,$2)',[Buffer.from(cpKey('warmer fixture','current')),Buffer.from(JSON.stringify({topUri:fu}))]);
const before=(await source.query('SELECT k,v FROM pgsl_kv ORDER BY k')).rows;
const live=await collectLive(candidateReader(source),{traversalBatchSize:4096}),plan=[...live.keys].sort();
const identity=async c=>(await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
const sourceSystemId=await identity(source),targetSystemId=await identity(target);assert.notEqual(sourceSystemId,targetSystemId);
const sf=await connect('source','pgsl-copy-source-fence');
async function fence(){await sf.query('BEGIN READ ONLY');await sf.query('LOCK TABLE pgsl_kv,relay_pgsl_published IN SHARE MODE');}
await fence();
let generation=0;
async function instance(hooks={}){
 const number=++generation,sql=[],warm=[],trace=[];let sortDone=false;
 const make=async(kind,role)=>{const c=await connect(kind,'warmer-fixture-'+number+'-'+role),raw=c.query.bind(c);c.query=async(query,params)=>{
  assert.match(query,/^\s*(SELECT|WITH|BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY|SET LOCAL|ROLLBACK)\b/);assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|VACUUM|CHECKPOINT|FOR UPDATE)\b/i.test(query));sql.push(query);trace.push({role,query});
  if(hooks.largeSort&&query.includes('AS atom_header')&&!sortDone){sortDone=true;const sorted=await raw(SORT_SQL);assert.equal(sorted.rows.length,40000);}
  if(hooks.planError&&query.includes('AS atom_header')){const error=new Error('sentinel_private_payload_sql_password');error.code='53400';error.detail='sentinel_private_payload_sql_password';throw error;}
  if(query.includes('pg_catalog.md5(v)')){const sum=(await source.query('SELECT coalesce(sum(octet_length(v)),0)::int AS n FROM pgsl_kv WHERE k=ANY($1::bytea[])',params)).rows[0].n;assert.ok(params[0].length<=128&&sum<=1024);warm.push(params[0].map(k=>k.toString('hex')));}
  const r=await raw(query,params);if(hooks.identityWrong&&kind==='target'&&query.includes('pg_control_system()'))r.rows[0].system_id='wrong';return r;
 };return c;};
 const sc=await make('source','control'),tc=await make('target','target'),readers=[];for(let i=0;i<4;i++)readers.push(await make('source','reader'+i));
 return {source:sc,target:tc,readers,sourceSystemId,targetSystemId,sql,warm,trace,options:{windowBytes:8192,batchBytes:1024,maxWindowRows:4096,maxWindows:1,deadlineMs:10000,pollMs:50}};
}
try{
 const sentinel='sentinel_private_payload_sql_password';
 assert.deepEqual(diagnosticOf({message:sentinel,code:sentinel,safePhase:sentinel},sentinel),{phase:'runtime',code:'E_RUNTIME'});
 assert.deepEqual(diagnosticOf({code:'53400'},'retained-plan'),{phase:'retained-plan',code:'53400'});
 const failure=await instance({planError:true});let failed;try{await runWarmer(failure);}catch(e){failed=diagnosticOf(e);}
 assert.deepEqual(failed,{phase:'plan-query',code:'53400'});assert.ok(!JSON.stringify(failed).includes(sentinel));
 checks.push('planner failures retain only allowlisted stage/SQLSTATE and discard payload/SQL/password messages');
 const split=partitionRows(Array.from({length:300},(_,i)=>({k:Buffer.from('k'+i),bytes:i===0?2000:8})),1024,128);assert.equal(split.skipped,1);assert.ok(split.groups.every(g=>g.length<=128&&g.reduce((n,r)=>n+r.bytes,0)<=1024));
 checks.push('payload groups enforce row/byte bounds and skip oversized individual values');
 const low=await connect('source','fixture-low-sort');await low.query('BEGIN READ ONLY');await low.query("SET LOCAL work_mem='64kB'");await low.query('SET LOCAL temp_file_limit=0');await assert.rejects(low.query(SORT_SQL),e=>e.code==='53400');await low.query('ROLLBACK');await low.end();
 const originalWorkMem=(await source.query("SELECT current_setting('work_mem') AS v")).rows[0].v;
 const first=await instance({largeSort:true});let checkedSettings=false;first.log=async e=>{if(e.kind==='readonly-warmer-stage'&&e.phase==='retained-plan'){
  const all=[first.source,first.target,...first.readers];for(let i=0;i<all.length;i++){const v=(await all[i].query("SELECT current_setting('work_mem') AS wm,current_setting('temp_file_limit') AS tf,current_setting('transaction_read_only') AS ro")).rows[0];assert.equal(v.wm,i===2?'64MB':originalWorkMem);assert.equal(v.tf,'0');assert.equal(v.ro,'on');}checkedSettings=true;
 }};
 const result=await runWarmer(first);assert.ok(checkedSettings);assert.deepEqual(first.trace.filter(x=>x.query==="SET LOCAL work_mem='64MB'").map(x=>x.role),['reader0']);assert.equal((await source.query("SELECT current_setting('work_mem') AS v")).rows[0].v,originalWorkMem);
 checks.push('real sort spills with low work_mem/temp0 but planner-only64MB succeeds; every other session/default stays unchanged');
assert.equal(result.windows,1);assert.ok(first.sql.includes('SELECT pg_catalog.pg_stat_clear_snapshot()'));assert.ok(result.rows>0&&result.bytes>0&&first.warm.length>0);assert.ok(result.skippedLarge>0);assert.deepEqual((await source.query('SELECT k,v FROM pgsl_kv ORDER BY k')).rows,before);assert.equal((await target.query('SELECT count(*)::int n FROM pgsl_kv')).rows[0].n,0);
 checks.push('actual PostgreSQL md5(bytea) warming returns only bounded key/digest results and changes neither database');
 const wrong=await instance();wrong.targetSystemId='wrong-cluster';await assert.rejects(runWarmer(wrong));assert.equal(wrong.warm.length,0);
 await sf.query('ROLLBACK');const absent=await instance();await assert.rejects(runWarmer(absent),/warmer refused/,'absent source fence must refuse');assert.equal(absent.warm.length,0);await fence();
 checks.push('wrong physical identity or absent source SHARE fence stops before warming');
 const changed=await instance();let rebound=false;changed.log=async e=>{if(e.kind==='readonly-warmer-wave'&&!rebound){rebound=true;await sf.query('ROLLBACK');await fence();}};await assert.rejects(runWarmer(changed),/warmer refused/,'rebound source fence must refuse');assert.ok(rebound);
 checks.push('same source PID with a new transaction cannot replace the captured fence');
 const hooks={identityWrong:false},swap=await instance(hooks);swap.log=e=>{if(e.kind==='readonly-warmer-wave')hooks.identityWrong=true;};await assert.rejects(runWarmer(swap),/warmer refused/,'changed target identity must refuse');
 checks.push('target identity change during warming stops permanently');
 const quiet=await instance();quiet.options={...quiet.options,maxWindows:2,deadlineMs:1500};const quietResult=await runWarmer(quiet);assert.equal(quietResult.reason,'deadline');assert.equal(quietResult.windows,1);
 checks.push('no target progress does not repeat a warmed window; deadline ends owned sessions');
 const moving=await instance();moving.options.maxWindows=2;let pending=null,windowCount=0,pausedCount;
 moving.log=e=>{if(e.kind==='readonly-warmer-window'&&++windowCount===1){pausedCount=moving.warm.length;pending=(async()=>{await Bun.sleep(200);assert.equal(moving.warm.length,pausedCount,'warmer repeated before target advanced');const end=Buffer.from(plan[e.endPosition-1],'hex'),r=(await source.query('SELECT k,v FROM pgsl_kv WHERE k=$1',[end])).rows[0];assert.ok(r);await target.query('INSERT INTO pgsl_kv VALUES($1,$2)',[r.k,r.v]);})();}};
 const movingResult=await runWarmer(moving);await pending;assert.equal(movingResult.windows,2);assert.ok(moving.warm.length>pausedCount);
 const warmedKeys=moving.warm.flat();assert.equal(new Set(warmedKeys).size,warmedKeys.length,'overlapping windows warmed a key twice');
 checks.push('another bounded window starts only after real target cursor advancement; no duplicate key reads');
 const writer=await connect('source','fixture-writer');await writer.query("SET lock_timeout='100ms'");await assert.rejects(writer.query('INSERT INTO relay_pgsl_published VALUES($1,$2)',[Buffer.from('must-stay-blocked'),Buffer.alloc(0)]),e=>e.code==='55P03');
 assert.deepEqual((await source.query('SELECT k,v FROM pgsl_kv ORDER BY k')).rows,before);
 assert.equal((await source.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name LIKE 'warmer-fixture-%'")).rows[0].n,0);
 checks.push('copy writer fence survives every warmer exit; all owned source sessions close');
 const wrapper=await readFile(new URL('../tools/pgsl-copy-warmer.railway.mjs',import.meta.url),'utf8'),start=wrapper.indexOf('const modules=')+14,end=wrapper.indexOf(';\n',start),modules=JSON.parse(wrapper.slice(start,end)),core=await readFile(new URL('../tools/pgsl-copy-warmer.mjs',import.meta.url),'utf8');
 assert.equal(modules['warmer.mjs'],core.replace('../packages/pgsl-store/src/gc.js','./gc.ts'));
 assert.ok(wrapper.includes("PGSL_WARM_MAX_WINDOWS??'2'"));assert.ok(wrapper.includes("default_transaction_read_only=on"));
 for(const [name,path]of [['gc.ts','gc'],['gc-atom-header.ts','gc-atom-header'],['keyspace.ts','keyspace'],['addressing.ts','addressing']]){let actual=await readFile(new URL('../packages/pgsl-store/src/'+path+'.ts',import.meta.url),'utf8');actual=actual.replaceAll("'./addressing.js'","'./addressing.ts'").replaceAll("'./keyspace.js'","'./keyspace.ts'").replaceAll("'./gc-atom-header.js'","'./gc-atom-header.ts'");assert.equal(modules[name],actual);}
 const child=Bun.spawn([process.execPath,new URL('../tools/pgsl-copy-warmer.railway.mjs',import.meta.url).pathname],{env:{...process.env,PGSL_WARM_ENABLE:'reviewed-readonly-prefetch',PGSL_PG_CONNSTR:sentinel,PGSL_COPY_TARGET_HOST:'target.railway.internal'},stdout:'pipe',stderr:'pipe'});
 const childCode=await child.exited,stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
 assert.equal(childCode,1);assert.ok(!stdout.includes(sentinel)&&!stderr.includes(sentinel));
 assert.ok(stdout.includes('"phase":"configuration"')&&stdout.includes('"code":"E_RUNTIME"'));
 checks.push('actual wrapper suppresses invalid connection URL contents during startup failure');
 checks.push('self-contained artifact matches exact reviewed traversal modules and defaults to two windows');
 console.log(JSON.stringify({kind:'warmer_fixture_pass',passed:checks.length,checks}));
}finally{await sf.query('ROLLBACK').catch(()=>{});for(const c of clients)await c.end().catch(()=>{});}
