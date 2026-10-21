import { collectLive,readerFromPg } from '../packages/pgsl-store/src/gc.js';
const PHASES=new Set(['bootstrap','configuration','connect-source','connect-target','connect-reader','session-start','guard','guard-query','retained-plan','plan-query','window-metadata','warm-query','completion','runtime','cleanup']);
const CODES=new Set(['E_PROOF','E_IDENTITY','E_FENCE','E_FENCE_CHANGED','E_CURSOR','E_READONLY','E_STOP','E_RUNTIME','08000','08001','08003','08006','08P01','28P01','28000','53300','53400','53100','53200','57014','55P03','57P01','57P02','57P03','25P02','25006','42501','42P01','42703','42883','22023','54000','54001','XX000']);
export function diagnosticOf(error,fallback='runtime'){return {phase:PHASES.has(error?.safePhase)?error.safePhase:PHASES.has(fallback)?fallback:'runtime',code:CODES.has(error?.code)?error.code:'E_RUNTIME'};}
function diagnosed(phase,error){const d=diagnosticOf(error,phase),e=new Error('read-only warmer refused');e.safePhase=d.phase;e.code=d.code;return e;}
async function attempt(phase,fn){try{return await fn();}catch(e){throw diagnosed(phase,e);}}
const ok=(v,m)=>{if(!v){const e=new Error('read-only warmer refused: '+m);e.code=m==='physical identity differs'?'E_IDENTITY':m==='exact source copy fence is absent'?'E_FENCE':m==='source copy fence changed'?'E_FENCE_CHANGED':m.includes('cursor')?'E_CURSOR':m==='read-only transaction is absent'?'E_READONLY':m.startsWith('stopped:')?'E_STOP':'E_PROOF';throw e;}};
const TABLES=['public.pgsl_kv','public.relay_pgsl_published'];
const IDENT="SELECT current_database() AS db,current_user AS role,(SELECT system_identifier::text FROM pg_control_system()) AS system_id";
const FENCE="SELECT a.pid,a.xact_start::text AS xact_start,(SELECT count(DISTINCT l.relation)::int FROM pg_locks l WHERE l.pid=a.pid AND l.granted AND l.mode='ShareLock' AND l.relation=ANY($1::oid[])) AS held FROM pg_stat_activity a WHERE a.datname=current_database() AND a.usename=current_user AND a.application_name='pgsl-copy-source-fence' AND a.backend_type='client backend'";
export function candidateReader(source){
 return readerFromPg({query:async(sql,params)=>{
  if(sql.includes('AS atom_header')&&sql.includes('UNION ALL'))sql=sql.replace(/substring\(source\.v FROM 1 FOR \d+\) AS atom_header/,'NULL::bytea AS atom_header').replace('false AS needs_js_parse, NULL::json AS topology',"false AS needs_js_parse, json_build_object('kind','atom','level',0) AS topology");
  const result=await source.query(sql,params);return {rows:result.rows.map(row=>{ok(Buffer.isBuffer(row.k),'invalid topology key');return {...row,k:row.k};})};
 }},'pgsl_kv',5000,4096);
}
export function upperBound(keys,cursor){let lo=0,hi=keys.length;while(lo<hi){const mid=(lo+hi)>>>1;if(cursor!==null&&keys[mid]<=cursor)lo=mid+1;else hi=mid;}return lo;}
export function partitionRows(rows,maxBytes=8388608,maxRows=128){
 const groups=[];let group=[],bytes=0,skipped=0;for(const row of rows){ok(Buffer.isBuffer(row.k)&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=134217728,'invalid retained value size');
  if(row.bytes>maxBytes){skipped++;continue;}if(group.length&&(group.length>=maxRows||bytes+row.bytes>maxBytes)){groups.push(group);group=[];bytes=0;}group.push(row);bytes+=row.bytes;
 }if(group.length)groups.push(group);return {groups,skipped};
}
export async function runWarmer({source,target,readers,sourceSystemId,targetSystemId,log=()=>{},signal,options={}}){
 ok(readers.length===4&&new Set([source,target,...readers]).size===6,'requires four separate readers and two controls');
 ok(sourceSystemId!==targetSystemId,'identities must differ');
 const windowBytes=options.windowBytes??536870912,batchBytes=options.batchBytes??8388608,maxWindowRows=options.maxWindowRows??65536,maxWindows=options.maxWindows??Number.MAX_SAFE_INTEGER,deadlineMs=options.deadlineMs??3600000,pollMs=options.pollMs??2000;
 for(const n of [windowBytes,batchBytes,maxWindowRows,maxWindows,deadlineMs,pollMs])ok(Number.isSafeInteger(n)&&n>0,'invalid bound');
 ok(windowBytes<=536870912&&batchBytes<=8388608&&maxWindowRows<=65536&&deadlineMs<=3600000,'bounds exceed review');
 const clients=[source,target,...readers];let stopped=null,guardianFailure=null,monitor,monitorBusy=false,binding=null,oids=null,lastCursor=null,keys=null;
 const totals={windows:0,waves:0,rows:0,bytes:0,skippedLarge:0,skippedPassed:0};
 const stop=reason=>{if(stopped)return;stopped=reason;for(const c of clients)void c.end().catch(()=>{});};
 const alive=()=>ok(!stopped,'stopped: '+stopped);
 const abort=()=>stop('operator stop');if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>stop('deadline'),deadlineMs);
 const read=async(c,sql,params,phase='guard-query')=>attempt(phase,async()=>{alive();ok(/^\s*(SELECT|WITH)\b/i.test(sql),'non-read query');return c.query(sql,params);});
 async function actualGuard(){
  alive();const a=(await read(source,IDENT)).rows[0],b=(await read(target,IDENT)).rows[0];
  ok(a?.system_id===sourceSystemId&&b?.system_id===targetSystemId&&a.db==='pgsl_prod'&&b.db==='pgsl_prod'&&a.role==='iegoadmin'&&b.role==='iegoadmin','physical identity differs');
  if(!oids){const r=await read(source,"SELECT 'public.pgsl_kv'::regclass::oid::text AS kv,'public.relay_pgsl_published'::regclass::oid::text AS relay");oids=[r.rows[0].kv,r.rows[0].relay];ok(oids.length===2&&oids[0]!==oids[1],'source relations differ');}
  await read(source,'SELECT pg_catalog.pg_stat_clear_snapshot()');const f=(await read(source,FENCE,[oids])).rows;ok(f.length===1&&f[0].xact_start&&f[0].held===2,'exact source copy fence is absent');
  const current=JSON.stringify({pid:f[0].pid,xact:f[0].xact_start,oids});if(binding)ok(binding===current,'source copy fence changed');else binding=current;
  const c=await read(target,'SELECT k FROM public.pgsl_kv ORDER BY k DESC LIMIT 1');ok(c.rows.length<=1&&(!c.rows.length||Buffer.isBuffer(c.rows[0].k)),'target cursor differs');
  const cursor=c.rows.length?c.rows[0].k.toString('hex'):null;ok(lastCursor===null||cursor!==null&&cursor>=lastCursor,'target cursor moved backwards');lastCursor=cursor;return cursor;
 }
 let guardQueue=Promise.resolve();const guard=()=>{const task=guardQueue.then(()=>attempt('guard',actualGuard));guardQueue=task.catch(()=>{});return task;};
 const pause=async()=>{await new Promise(resolve=>setTimeout(resolve,pollMs));alive();};
 try{
  await log({kind:'readonly-warmer-stage',phase:'session-start'});await attempt('session-start',async()=>{for(const c of clients){alive();await c.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');await c.query("SET LOCAL statement_timeout='30s'");await c.query('SET LOCAL temp_file_limit=0');await c.query("SET LOCAL lock_timeout='1s'");await c.query("SET LOCAL idle_in_transaction_session_timeout='0'");const r=await c.query("SELECT current_setting('transaction_read_only') AS ro");ok(r.rows[0]?.ro==='on','read-only transaction is absent');}});
  await guard();
  monitor=setInterval(()=>{if(monitorBusy||stopped)return;monitorBusy=true;void guard().catch(e=>{guardianFailure=diagnosed('guard',e);stop('identity or source fence lost');}).finally(()=>{monitorBusy=false;});},Math.min(pollMs,2000));
  const plannedReader={query:async(sql,params)=>{await guard();const r=await read(readers[0],sql,params,'plan-query');await guard();return r;}};
  await log({kind:'readonly-warmer-stage',phase:'retained-plan'});let live=await attempt('retained-plan',async()=>{const value=await collectLive(candidateReader(plannedReader),{traversalBatchSize:4096});ok(value.keys.size>0&&value.keys.size<=4000000&&value.stats.danglingRoots.length===0&&value.stats.unreadableNodes===0,'retained key plan differs');return value;});
  keys=[...live.keys].sort();live=null;await log({kind:'readonly-warmer-planned',retainedKeys:keys.length});
  let previousEnd=null;
  while(totals.windows<maxWindows){
   const cursor=await guard();if(previousEnd!==null&&(cursor===null||cursor<previousEnd)){await pause();continue;}
   const begin=upperBound(keys,cursor);if(begin>=keys.length)break;let scanned=0,windowSize=0,end=cursor,rows=[],done=false;
   while(begin+scanned<keys.length&&scanned<maxWindowRows&&!done){
    await guard();const slice=keys.slice(begin+scanned,Math.min(keys.length,begin+scanned+4096,begin+maxWindowRows));
    const meta=await read(readers[0],'SELECT k,octet_length(v) AS bytes FROM public.pgsl_kv WHERE k=ANY($1::bytea[]) ORDER BY k',[slice.map(k=>Buffer.from(k,'hex'))],'window-metadata');
    const expected=new Set(slice),map=new Map();for(const r of meta.rows){ok(Buffer.isBuffer(r.k)&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&r.bytes<=134217728,'invalid retained metadata');const h=r.k.toString('hex');ok(expected.has(h)&&!map.has(h),'unexpected retained metadata');map.set(h,r);}
    for(const k of slice){const row=map.get(k);if(row&&windowSize+row.bytes>windowBytes){done=true;break;}if(row){rows.push(row);windowSize+=row.bytes;}end=k;scanned++;}
   }
   ok(scanned>0&&end!==cursor,'window cannot advance');if(rows.length)end=rows.at(-1).k.toString('hex');const planned=partitionRows(rows,batchBytes,128);rows=null;totals.skippedLarge+=planned.skipped;if(!planned.groups.length&&begin+scanned>=keys.length)break;
   for(let offset=0;offset<planned.groups.length;offset+=4){
    const at=await guard(),wave=planned.groups.slice(offset,offset+4).map(group=>group.filter(r=>at===null||r.k.toString('hex')>at));const waveResults=await Promise.allSettled(wave.map(async(group,i)=>{
     if(!group.length)return {rows:0,bytes:0};const sum=group.reduce((n,r)=>n+r.bytes,0);ok(group.length<=128&&sum<=batchBytes,'payload query bound differs');
     const r=await read(readers[i],"SELECT k,pg_catalog.md5(v) AS warm_digest FROM public.pgsl_kv WHERE k=ANY($1::bytea[]) ORDER BY k",[group.map(x=>x.k)],'warm-query');ok(r.rows.length===group.length,'warming lost rows');
     for(let n=0;n<r.rows.length;n++){ok(Buffer.isBuffer(r.rows[n].k)&&r.rows[n].k.equals(group[n].k)&&typeof r.rows[n].warm_digest==='string'&&/^[0-9a-f]{32}$/.test(r.rows[n].warm_digest),'warming result differs');r.rows[n]={};}return {rows:group.length,bytes:sum};
    }));for(const r of waveResults){if(r.status==='rejected')throw r.reason;totals.rows+=r.value.rows;totals.bytes+=r.value.bytes;}totals.waves++;await guard();await log({kind:'readonly-warmer-wave',...totals});
   }
   previousEnd=end;totals.windows++;await log({kind:'readonly-warmer-window',windowBytes:windowSize,endPosition:upperBound(keys,end),...totals});
  }
  await guard();return {...totals,reason:'completed'};
 }catch(e){if(stopped==='operator stop'||stopped==='deadline')return {...totals,reason:stopped};throw guardianFailure??diagnosed('runtime',e);}
 finally{clearTimeout(timer);if(monitor)clearInterval(monitor);await guardQueue.catch(()=>{});signal?.removeEventListener('abort',abort);keys=null;for(const c of clients){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});}}
}
