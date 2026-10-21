import { createHash } from 'node:crypto';
export const RECOVERY_ROLE='pgsl_cutover_recovery';
const TABLES=['pgsl_kv','relay_pgsl_published'];
const ok=(v,m)=>{if(!v)throw new Error('cutover refused: '+m);};
const q=x=>'"'+String(x).replaceAll('"','""')+'"';
const j=JSON.stringify;
const clone=x=>JSON.parse(j(x));
const IDENT="SELECT current_database() AS db,current_user AS role,current_setting('server_version_num') AS version,(SELECT system_identifier::text FROM pg_control_system()) AS system_id";
const ROLES="SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig FROM pg_roles WHERE rolname IN ('iegoadmin','relay_pgsl') ORDER BY rolname";
const ACCESS="SELECT 'database' AS scope,pg_get_userbyid(d.datdba) AS owner,(SELECT json_agg(json_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,pg_get_userbyid(a.grantor),a.privilege_type) FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a) AS acl FROM pg_database d WHERE datname=current_database() UNION ALL SELECT 'public-schema',pg_get_userbyid(n.nspowner),(SELECT json_agg(json_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,pg_get_userbyid(a.grantor),a.privilege_type) FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a) FROM pg_namespace n WHERE nspname='public' ORDER BY scope";
export function validateReceipt(s,ids,now=Date.now(),fresh=true){
 const r=s?.receipt;
 ok(r?.source?.system_id===ids.sourceSystemId&&r?.target?.system_id===ids.targetSystemId&&ids.sourceSystemId!==ids.targetSystemId,'receipt cluster identities differ');
 ok(r.source.db==='pgsl_prod'&&r.target.db==='pgsl_prod'&&r.source.role==='iegoadmin'&&r.target.role==='iegoadmin','receipt database/role differs');
 ok(Math.floor(Number(r.source.version)/10000)===16&&Math.floor(Number(r.target.version)/10000)===16&&j(r.source.locale)===j(r.target.locale),'receipt initializer differs');
 if(fresh){const t=Date.parse(r.verifiedAt),until=Date.parse(s.validUntil);ok(s.state==='verified-source-fenced'&&s.phase==='verified-source-fenced'&&r.kind==='verified-source-fenced'&&Number.isFinite(t)&&t<=now+5000&&now-t<=1200000&&Number.isFinite(until)&&until>now+60000,'worker receipt is not fresh and fenced');}
 for(const name of ['kv','relay']){const v=r[name];ok(v&&Number.isSafeInteger(v.rows)&&v.rows>=0&&Number.isSafeInteger(v.bytes)&&v.bytes>=0&&/^[0-9a-f]{64}$/.test(v.digest),'receipt summary differs');}
 ok(r.kv.rows>0&&r.kv.bytes+r.relay.bytes<=40000000000&&Number.isSafeInteger(r.targetDatabaseBytes)&&r.targetDatabaseBytes<48000000000,'receipt exceeds fixed budget');
 return clone(r);
}
export const receiptKey=r=>createHash('sha256').update(j({source:r.source.system_id,target:r.target.system_id,verifiedAt:r.verifiedAt,kv:r.kv,relay:r.relay})).digest('hex');
export function frame(h,k,v){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(k.length));h.update(b);h.update(k);b.writeBigUInt64BE(BigInt(v.length));h.update(b);h.update(v);}
export async function hashTable(c,table){
 ok(TABLES.includes(table),'unreviewed table');const h=createHash('sha256');let rows=0,bytes=0,cursor=null;
 for(;;){const meta=await c.query('SELECT k,octet_length(v) AS bytes FROM public.'+q(table)+(cursor===null?'':' WHERE k>$1')+' ORDER BY k LIMIT 128',cursor===null?[]:[cursor]);if(!meta.rows.length)break;
  let group=[],size=0;const flush=async()=>{if(!group.length)return;const r=await c.query('SELECT k,v FROM public.'+q(table)+' WHERE k=ANY($1::bytea[]) ORDER BY k',[group]);ok(r.rows.length===group.length,'verification payload count differs');
   for(let i=0;i<r.rows.length;i++){const x=r.rows[i];ok(Buffer.isBuffer(x.k)&&x.k.equals(group[i])&&Buffer.isBuffer(x.v),'verification payload/key differs');frame(h,x.k,x.v);rows++;bytes+=x.v.length;ok(bytes<=40000000000,'verification byte budget exceeded');r.rows[i]={};}group=[];size=0;};
  for(const x of meta.rows){ok(Buffer.isBuffer(x.k)&&Number.isSafeInteger(x.bytes)&&x.bytes>=0&&x.bytes<=134217728,'verification value exceeds memory bound');if(group.length&&size+x.bytes>8388608)await flush();group.push(x.k);size+=x.bytes;}
  cursor=Buffer.from(meta.rows.at(-1).k);await flush();
 }return {rows,bytes,digest:h.digest('hex')};
}
export async function metadata(c,quarantined=false){
 const roles=(await c.query(ROLES)).rows;ok(roles.length===2&&roles[0].rolname==='iegoadmin'&&roles[1].rolname==='relay_pgsl','application roles differ');
 ok(roles.every(x=>x.rolcanlogin===!quarantined),'application login flags differ');if(quarantined)for(const r of roles)r.rolcanlogin=true;
 const relations=(await c.query("SELECT n.nspname AS schema,c.relname,pg_get_userbyid(c.relowner) AS owner,c.relkind,c.relpersistence,c.relrowsecurity,c.relreplident,c.reloptions,tc.reloptions AS toast_options,(SELECT json_agg(json_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type) FROM aclexplode(c.relacl) a) AS acl,(SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'storage',a.attstorage,'compression',a.attcompression,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(ad.adbin,ad.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,(SELECT json_agg(json_build_object('name',co.conname,'definition',pg_get_constraintdef(co.oid),'validated',co.convalidated) ORDER BY co.conname) FROM pg_constraint co WHERE co.conrelid=c.oid) AS constraints,(SELECT json_agg(json_build_object('name',ci.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY ci.relname) FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_class tc ON tc.oid=c.reltoastrelid WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','m','v','S','f') ORDER BY n.nspname,c.relname")).rows;
 ok(relations.length===2&&relations.every((r,i)=>r.schema==='public'&&r.relname===TABLES[i]&&r.owner==='iegoadmin'&&r.relkind==='r'&&r.relpersistence==='p'&&!r.relrowsecurity),'relation allowlist differs');
 const extras=(await c.query("SELECT (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%')::int AS schemas,(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%')::int AS routines,(SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')::int AS extensions,(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)::int AS triggers,(SELECT count(*) FROM pg_largeobject_metadata)::int AS large_objects,(SELECT count(*) FROM pg_default_acl)::int AS default_acls,(SELECT count(*) FROM pg_foreign_server)::int AS foreign_servers,(SELECT count(*) FROM pg_policy)::int AS policies")).rows[0];
 ok(Object.values(extras).every(x=>x===0),'unreviewed database objects exist');
 const access=(await c.query(ACCESS)).rows;
 const database=(await c.query("SELECT pg_get_userbyid(datdba) AS owner,encoding,datcollate,datctype,datlocprovider,daticulocale,datconnlimit FROM pg_database WHERE datname=current_database()")).rows;
 const settings=(await c.query("SELECT CASE WHEN d.datname=current_database() THEN '@current' ELSE coalesce(d.datname,'*') END AS database,coalesce(r.rolname,'*') AS role,s.setconfig FROM pg_db_role_setting s LEFT JOIN pg_database d ON d.oid=s.setdatabase LEFT JOIN pg_roles r ON r.oid=s.setrole WHERE s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database())) ORDER BY 1,2")).rows;
 const memberships=(await c.query("SELECT parent.rolname AS role,child.rolname AS member,grantor.rolname AS grantor,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member JOIN pg_roles grantor ON grantor.oid=m.grantor WHERE parent.rolname !~ '^pg_' OR child.rolname !~ '^pg_' ORDER BY 1,2,3")).rows;
 return {roles,relations,extras,access,database,settings,memberships};
}
export function createCutoverController({connect,worker,journal,sourceUrl,targetHost,sourceSystemId,targetSystemId,now=Date.now}){
 const ids={sourceSystemId,targetSystemId},source=new URL(sourceUrl),target=new URL(sourceUrl);target.hostname=targetHost;
 ok(source.hostname.endsWith('.railway.internal')&&target.hostname.endsWith('.railway.internal')&&source.hostname!==target.hostname&&source.pathname==='/pgsl_prod'&&decodeURIComponent(source.username)==='iegoadmin','requires reviewed distinct private endpoints');
 const open=async(base,db='postgres',rescue=false)=>{const u=new URL(base);u.pathname='/'+db;if(rescue)u.username=RECOVERY_ROLE;const c=await connect(u.href,'pgsl-cutover-controller');await c.query("SET statement_timeout='30s'");await c.query("SET lock_timeout='5s'");await c.query("SET idle_in_transaction_session_timeout='45s'");return c;};
 const close=async c=>{if(c)await c.end().catch(()=>{});};
 const identity=async(c,expected,db)=>{const r=(await c.query(IDENT)).rows[0];ok(r?.system_id===expected&&r.db===db&&Math.floor(Number(r.version)/10000)===16,'physical database identity differs');return r;};
 const load=async()=>{const v=await journal.get();ok(v?.version===1&&v.sourceSystemId===sourceSystemId&&v.targetSystemId===targetSystemId,'durable journal identity differs');ok(v.receiptKey===receiptKey(v.receipt),'durable receipt binding differs');return v;};
 const save=async v=>{await journal.put(clone(v));};
 const fencePid=async(c,tableOids)=>{const r=(await c.query("SELECT pid,usename,xact_start FROM pg_stat_activity WHERE datname='pgsl_prod' AND application_name='pgsl-copy-source-fence'")).rows;ok(r.length===1&&r[0].usename==='iegoadmin'&&r[0].xact_start,'exactly one copy fence backend required');const p=r[0].pid;
  const locks=(await c.query("SELECT count(DISTINCT relation)::int AS n FROM pg_locks WHERE pid=$1 AND database=(SELECT oid FROM pg_database WHERE datname='pgsl_prod') AND locktype='relation' AND mode='ShareLock' AND granted AND relation=ANY($2::oid[])",[p,tableOids])).rows[0];ok(locks.n===2,'copy backend lacks both table writer fences');return p;};
 const sourceBlocked=async(c,p,tableOids)=>{ok((await c.query("SELECT datallowconn FROM pg_database WHERE datname='pgsl_prod'")).rows[0]?.datallowconn===false,'persistent source connection fence missing');ok(await fencePid(c,tableOids)===p,'copy fence backend changed');ok((await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname='pgsl_prod' AND pid<>$1",[p])).rows[0].n===0,'other source database clients remain');};
 const targetRoles=async(c,quarantined)=>{const r=(await c.query("SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname")).rows;const names=r.map(x=>x.rolname);ok(j(names)===j(quarantined?['iegoadmin',RECOVERY_ROLE,'relay_pgsl']:['iegoadmin','relay_pgsl']),'target cluster roles differ');if(quarantined)ok(r.every(x=>x.rolcanlogin===(x.rolname===RECOVERY_ROLE)),'target quarantine incomplete');};
 const preflight=async()=>{const r=validateReceipt(await worker('GET','/status'),ids,now());let a,b;try{a=await open(source,'pgsl_prod');b=await open(target,'pgsl_prod');await identity(a,sourceSystemId,'pgsl_prod');await identity(b,targetSystemId,'pgsl_prod');const baseline=await metadata(a);ok(j(baseline)===j(await metadata(b)),'source/target schema access or role metadata differs');await targetRoles(b,false);const sourceTableOids=(await a.query("SELECT c.oid::int AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pgsl_kv','relay_pgsl_published') ORDER BY c.relname")).rows.map(x=>x.oid);ok(sourceTableOids.length===2,'source table identity missing');return {receipt:r,receiptKey:receiptKey(r),baseline,sourceTableOids};}finally{await close(a);await close(b);}};
 const fence=async()=>{let v=await journal.get(),a,b,d;try{
  if(!v){const p=await preflight();v={version:1,phase:'fencing',...ids,...p,createdAt:new Date(now()).toISOString()};await save(v);}else{v=await load();ok(['fencing','fenced'].includes(v.phase),'phase cannot fence');}
  a=await open(source);await identity(a,sourceSystemId,'postgres');const p=await fencePid(a,v.sourceTableOids);
  if(v.sourceFencePid)ok(v.sourceFencePid===p,'persisted source fence backend changed');v.sourceFencePid=p;await save(v);
  const verifier=(await a.query("SELECT rolpassword FROM pg_authid WHERE rolname='iegoadmin'")).rows[0]?.rolpassword;ok(typeof verifier==='string'&&/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(verifier),'source verifier unreviewed');
  try{b=await open(target,'postgres',true);}catch{b=await open(target);}await identity(b,targetSystemId,'postgres');
  const existing=(await b.query('SELECT rolpassword,rolsuper,rolcanlogin,rolconnlimit FROM pg_authid WHERE rolname=$1',[RECOVERY_ROLE])).rows;
  if(existing.length){ok(existing.length===1&&existing[0].rolpassword===verifier&&existing[0].rolsuper&&existing[0].rolcanlogin&&existing[0].rolconnlimit===3,'existing recovery role differs');await targetRoles(b,true);}
  else await targetRoles(b,false);
  d=await open(target,'pgsl_prod',existing.length>0);await identity(d,targetSystemId,'pgsl_prod');ok(j(await metadata(d,existing.length>0))===j(v.baseline),'target metadata changed');
  await close(d);d=undefined;
  await a.query('ALTER DATABASE pgsl_prod ALLOW_CONNECTIONS false');
  await a.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='pgsl_prod' AND pid<>$1",[p]);await sourceBlocked(a,p,v.sourceTableOids);
  ok(receiptKey(validateReceipt(await worker('GET','/status'),ids,now()))===v.receiptKey,'worker receipt changed');
  if(!existing.length){await b.query('BEGIN');try{
   for(const s of ["log_statement='none'","log_min_duration_statement='-1'","log_min_duration_sample='-1'","log_parameter_max_length='0'","log_parameter_max_length_on_error='0'","log_min_error_statement='panic'"])await b.query('SET LOCAL '+s);
   await b.query('CREATE ROLE '+q(RECOVERY_ROLE)+" LOGIN SUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD '"+verifier+"'");
   await b.query('ALTER ROLE iegoadmin NOLOGIN');await b.query('ALTER ROLE relay_pgsl NOLOGIN');await b.query('COMMIT');
  }catch{await b.query('ROLLBACK').catch(()=>{});throw new Error('cutover refused: target quarantine failed; source remains blocked');}}
  await targetRoles(b,true);
  await b.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND usename IN ('iegoadmin','relay_pgsl') AND NOT(datname='pgsl_prod' AND application_name='pgsl-copy-target')");
  const clients=(await b.query("SELECT application_name FROM pg_stat_activity WHERE datname='pgsl_prod'")).rows;ok(clients.length===1&&clients[0].application_name==='pgsl-copy-target','unexpected target client remains');
  v.phase='fenced';await save(v);return {phase:v.phase,receiptKey:v.receiptKey,sourceFencePid:p};
 }finally{await close(d);await close(b);await close(a);}};
 const prepare=async()=>{const v=await load();ok(['fenced','preparing','prepared'].includes(v.phase),'phase cannot prepare');let a,b;try{
  b=await open(target,'postgres',true);await identity(b,targetSystemId,'postgres');await targetRoles(b,true);
  if(v.phase==='prepared'){ok(v.targetDurability?.flushed===true,'prepared target lacks durable WAL proof');return {phase:'prepared',receiptKey:v.receiptKey,targetSystemId};}
  a=await open(source);await identity(a,sourceSystemId,'postgres');await sourceBlocked(a,v.sourceFencePid,v.sourceTableOids);
  const s=await worker('GET','/status');ok(['verified-source-fenced','prepared-for-volume-cutover'].includes(s.state),'worker state cannot prepare');
  ok(receiptKey(validateReceipt(s,ids,now(),s.state==='verified-source-fenced'))===v.receiptKey,'worker receipt changed');
  if(s.state!=='prepared-for-volume-cutover'){const marker=(await b.query('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0]?.lsn;ok(typeof marker==='string'&&/^[0-9A-F]+\/[0-9A-F]+$/i.test(marker),'target WAL marker missing');await b.query("SET statement_timeout='10min'");await b.query('CHECKPOINT');await b.query("SET statement_timeout='30s'");ok((await b.query('SELECT pg_current_wal_flush_lsn() >= $1::pg_lsn AS flushed',[marker])).rows[0]?.flushed===true,'target WAL durability barrier failed');v.targetDurability={insertLsn:marker,flushed:true,at:new Date(now()).toISOString()};v.phase='preparing';await save(v);const r=await worker('POST','/prepare-volume-cutover',{targetSystemId,action:'atomic-original-service-volume-swap'});ok(r.kind==='prepared-for-volume-cutover'&&receiptKey(r)===v.receiptKey,'prepared receipt differs');}
  ok(v.targetDurability?.flushed===true,'target durability proof missing');v.phase='prepared';v.preparedAt=new Date(now()).toISOString();await save(v);return {phase:'prepared',receiptKey:v.receiptKey,targetSystemId};
 }finally{await close(a);await close(b);}};
 const activate=async()=>{const v=await load();ok(['prepared','activation-ready','activated'].includes(v.phase),'verified preparation missing');if(v.phase==='activated'){let proof,db;try{proof=await open(source);await identity(proof,targetSystemId,'postgres');await targetRoles(proof,false);db=await open(source,'pgsl_prod');ok(j(await metadata(db))===j(v.baseline),'activated catalog differs');return {phase:'activated',receiptKey:v.receiptKey,...ids};}finally{await close(db);await close(proof);}}
  ok(v.targetDurability?.flushed===true,'target durability proof missing');let a,d,final;try{
   try{a=await open(source,'postgres',true);}catch{a=await open(source);}await identity(a,targetSystemId,'postgres');
   const flags=(await a.query(ROLES)).rows;ok(flags.length===2&&flags.every(x=>x.rolcanlogin===flags[0].rolcanlogin),'mixed activation flags require operator recovery');
   if(flags.every(x=>!x.rolcanlogin)){
    await targetRoles(a,true);d=await open(source,'pgsl_prod',true);await identity(d,targetSystemId,'pgsl_prod');
    await d.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await d.query('LOCK TABLE public.pgsl_kv,public.relay_pgsl_published IN SHARE MODE NOWAIT');
    ok(j(await metadata(d,true))===j(v.baseline),'attached database schema/access differs');
    const kv=await hashTable(d,'pgsl_kv'),relay=await hashTable(d,'relay_pgsl_published');ok(j(kv)===j(v.receipt.kv)&&j(relay)===j(v.receipt.relay),'attached full byte receipt differs');
    await d.query('ROLLBACK');await close(d);d=undefined;
    v.phase='activation-ready';v.verified={kv,relay};v.verifiedAt=new Date(now()).toISOString();await save(v);
    await a.query('BEGIN');try{await a.query('ALTER ROLE iegoadmin LOGIN');await a.query('ALTER ROLE relay_pgsl LOGIN');await a.query('COMMIT');}catch{await a.query('ROLLBACK').catch(()=>{});throw new Error('cutover refused: activation transaction failed');}
   }else ok(v.phase==='activation-ready'&&j(v.verified?.kv)===j(v.receipt.kv)&&j(v.verified?.relay)===j(v.receipt.relay),'LOGIN is active without durable byte proof');
   await close(a);a=undefined;
   final=await open(source);await identity(final,targetSystemId,'postgres');d=await open(source,'pgsl_prod');await identity(d,targetSystemId,'pgsl_prod');ok(j(await metadata(d))===j(v.baseline),'restored metadata/login flags differ');await close(d);d=undefined;
   ok((await final.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1',[RECOVERY_ROLE])).rows[0].n===0,'recovery sessions remain');
   await final.query('DROP ROLE IF EXISTS '+q(RECOVERY_ROLE));v.phase='activated';v.activatedAt=new Date(now()).toISOString();await save(v);
   return {phase:'activated',receiptKey:v.receiptKey,...ids,kv:v.verified.kv,relay:v.verified.relay,verifiedAt:v.verifiedAt,oldSourceRemainsConnectionBlocked:true};
  }finally{await close(d);await close(a);await close(final);}};
 let busy=false;
 return {async run(mode){ok(['preflight','fence','prepare','verify-activate','status'].includes(mode),'unrecognized mode');ok(!busy,'action already in progress');busy=true;try{
  if(mode==='status'){const v=await journal.get();return v?{phase:v.phase,receiptKey:v.receiptKey,...ids}:{phase:'not-started',...ids};}
  if(mode==='preflight'){const p=await preflight();return {phase:'preflight-ready',receiptKey:p.receiptKey,...ids};}
  return await ({fence,prepare,'verify-activate':activate})[mode]();
 }finally{busy=false;}}};
}
