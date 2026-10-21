/**
 * Private, bounded in-place PGSL reclamation. Run inside the database's Railway
 * project; no database TCP proxy or public row transfer is used.
 * Install once AFTER migration validation, then schedule this process hourly.
 * Keeps every current root and every root retired in the preceding hour.
 * DELETE + ordinary VACUUM makes pages reusable; it does not shrink the volume.
 */
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { acquireCollectorLock, collectLive, readerFromPg } from '../packages/pgsl-store/src/gc.js';
import { nodeAddrFromUrn } from '../packages/pgsl-store/src/addressing.js';
import { SUBSPACE_PAYLOAD_OFFSET } from '../packages/pgsl-store/src/keyspace.js';
import { collectorVolumeHeadroom } from './pgsl-store-gc-volume.mjs';

const HOUR = 3_600_000, GiB = 1_073_741_824;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const rootTags = new Set(['C', 'O', 'A', 'X', 'P']);
function names(table) {
  if (!/^[a-z_][a-z0-9_]{0,39}$/.test(table)) throw Error('refusing sweep: invalid table name');
  return { table, relation: 'public.' + table, roots: 'public.' + table + '_gc_roots',
    state: 'public.' + table + '_gc_state', fn: 'public.' + table + '_gc_remember_roots',
    trigger: table + '_gc_root_history' };
}
function triggerBody(n) {
  return `
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> '${n.table}' THEN
    RAISE EXCEPTION 'invalid root journal trigger target';
  END IF;
  -- Exclude immutable node/index keys before inspecting NEW.v: a node can be a
  -- 38MiB TOAST value, and journaling it must not detoast or compare its body.
  IF octet_length(OLD.k) >= 6 AND substring(OLD.k FROM 1 FOR 5) = decode('7067736c00','hex')
     AND (get_byte(OLD.k,5) IN (67,79,65,88) OR
       (get_byte(OLD.k,5) = 80 AND
        (octet_length(OLD.k) <> 31 OR substring(OLD.k FROM 28 FOR 4) <> decode('00000002','hex')))) THEN
    IF TG_OP = 'DELETE' OR NEW.k IS DISTINCT FROM OLD.k OR NEW.v IS DISTINCT FROM OLD.v THEN
      INSERT INTO ${n.roots}(k,v,retired_at) VALUES(OLD.k,OLD.v,clock_timestamp());
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END
`;
}
async function verifyJournal(client, n) {
  const r = await client.query(`SELECT t.tgenabled,p.prosrc,p.prosecdef,p.proconfig,t.tgtype,
      t.tgrelid = to_regclass($1) AS correct_relation
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgname=$2 AND t.tgrelid=to_regclass($1) AND NOT t.tgisinternal`,
    [n.relation,n.trigger]);
  const row = r.rows[0];
  if (r.rows.length !== 1 || row.tgenabled !== 'A' || !row.correct_relation || !row.prosecdef || row.tgtype !== 25
    || JSON.stringify(row.proconfig) !== JSON.stringify(['search_path=pg_catalog']) || row.prosrc !== triggerBody(n)) {
    throw Error('refusing sweep: the continuously enabled root journal is not verified');
  }
}
export async function installSweep(client, { table = 'pgsl_kv' } = {}) {
  const n = names(table), release = await acquireCollectorLock(client, table);
  try {
    await client.query('BEGIN');
    await client.query(`LOCK TABLE ${n.relation} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const prior = await client.query('SELECT to_regclass($1) AS existing', [n.state]);
    if (prior.rows[0].existing) await verifyJournal(client,n);
    await client.query(`CREATE TABLE IF NOT EXISTS ${n.state}
      (singleton boolean PRIMARY KEY CHECK(singleton), installed_at timestamptz NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${n.roots}
      (k bytea NOT NULL,v bytea NOT NULL,retired_at timestamptz NOT NULL)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_gc_roots_time ON ${n.roots}(retired_at)`);
    await client.query(`REVOKE ALL ON ${n.roots},${n.state} FROM PUBLIC`);
    await client.query(`CREATE OR REPLACE FUNCTION ${n.fn}() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $root_history$${triggerBody(n)}$root_history$`);
    await client.query(`DROP TRIGGER IF EXISTS ${n.trigger} ON ${n.relation}`);
    await client.query(`CREATE TRIGGER ${n.trigger} AFTER UPDATE OR DELETE ON ${n.relation}
      FOR EACH ROW EXECUTE FUNCTION ${n.fn}()`);
    await client.query(`ALTER TABLE ${n.relation} ENABLE ALWAYS TRIGGER ${n.trigger}`);
    await client.query(`INSERT INTO ${n.state}(singleton,installed_at) VALUES(true,clock_timestamp())
      ON CONFLICT(singleton) DO NOTHING`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally { await release(); }
}
function validateIdentifier(text) {
  try { nodeAddrFromUrn(text); } catch { throw Error('refusing sweep: malformed retained node identifier'); }
}
function validateJsonRoots(value) {
  if (typeof value === 'string') {
    if (value.startsWith('urn:pgsl:') || value.includes('/ns/pgsl/')) validateIdentifier(value);
  } else if (Array.isArray(value)) for (const child of value) validateJsonRoots(child);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) validateJsonRoots(child);
}
function validateRoot(key,value) {
  const tag = String.fromCharCode(key[SUBSPACE_PAYLOAD_OFFSET-1]);
  try {
    if (tag === 'C') {
      if (value.length > 1_048_576 || key.subarray(SUBSPACE_PAYLOAD_OFFSET).indexOf(0) < 0) throw Error();
      validateJsonRoots(JSON.parse(utf8.decode(value)));
    } else if (tag === 'O') {
      if (value.length > 8192 || key.subarray(SUBSPACE_PAYLOAD_OFFSET).indexOf(0) < 0) throw Error();
      validateIdentifier(utf8.decode(value));
    } else {
      const address = tag === 'P' ? key.subarray(SUBSPACE_PAYLOAD_OFFSET,SUBSPACE_PAYLOAD_OFFSET+21) : key.subarray(key.length-21);
      if (address.length !== 21 || (address[0] !== 1 && address[0] !== 2)) throw Error();
      if (tag === 'P' && key.length !== SUBSPACE_PAYLOAD_OFFSET+25) throw Error();
      if (tag === 'A' && (key.length < 28 || key[key.length-22] !== 0)) throw Error();
      if (tag === 'X' && (key.length < 32 || key[key.length-26] !== 0)) throw Error();
    }
  } catch { throw Error('refusing sweep: corrupt or unsupported mutable root'); }
}
/** Add all versions retired within the rollback window to the same root scan. */
function retainedReader(client,n,cutoff,check) {
  const base = readerFromPg(client,n.table,5000,4096);
  return {
    ...base,
    async scan(begin,end,onRow) {
      const tag=String.fromCharCode(begin[SUBSPACE_PAYLOAD_OFFSET-1]);
      const consume=(k,v)=>{ check(); if(rootTags.has(tag))validateRoot(k,v); onRow(k,v); };
      await base.scan(begin,end,consume);
      if (!rootTags.has(tag)) return;
      // A cursor uses (retired_at,ctid) only within the fenced transaction;
      // no writer can change the journal until this transaction releases its fence.
      let cursor=null;
      for (;;) {
        check();
        const rows=await client.query(`SELECT k,v,retired_at::text AS cursor_time,ctid::text AS row_id FROM ${n.roots}
          WHERE retired_at >= $1 AND k >= $2 AND k < $3
          AND ($4::timestamptz IS NULL OR (retired_at,ctid) > ($4::timestamptz,$5::tid))
          ORDER BY retired_at,ctid LIMIT 1000`,[cutoff,Buffer.from(begin),Buffer.from(end),cursor?.cursor_time??null,cursor?.row_id??null]);
        for(const row of rows.rows)consume(row.k,row.v);
        if(rows.rows.length<1000)break;
        cursor=rows.rows.at(-1);
      }
    },
    async getManyTopology(keys) {
      check();
      const records=await base.getManyTopology(keys);
      for(const row of records.values()) {
        if(!row.topology)throw Error('refusing sweep: unreadable retained node');
        if(row.topology.kind==='fragment') {
          for(const uri of [...(row.topology.items??[]),row.topology.left,row.topology.right]) {
            if(uri!==undefined)validateIdentifier(uri);
          }
        }
      }
      return records;
    },
  };
}
export async function sweepStore({client,watchdog,table='pgsl_kv',measureFreeBytes,
  maxDeleteBytes=8*GiB,batchBytes=64*1024*1024,maxSeconds=300,minFreeBytes=2*GiB,
  onPhase=async()=>{}}) {
  const n=names(table);
  if(typeof measureFreeBytes!=='function'||!watchdog)throw Error('refusing sweep: independent watchdog and headroom provider required');
  for(const value of [maxDeleteBytes,batchBytes,maxSeconds,minFreeBytes])if(!Number.isSafeInteger(value)||value<=0)throw Error('refusing sweep: invalid bounded capacity');
  if(batchBytes>128*1024*1024||maxDeleteBytes>16*GiB||maxSeconds>600||minFreeBytes<GiB)throw Error('refusing sweep: capacity exceeds maintenance bounds');
  await verifyJournal(client,n);
  const state=await client.query(`SELECT installed_at,clock_timestamp()-installed_at>=interval '1 hour' AS ready FROM ${n.state} WHERE singleton`);
  if(state.rows.length!==1)throw Error('refusing sweep: root journal installation state unavailable');
  if(!state.rows[0].ready)return{status:'warming',deletedKeys:0,deletedBytes:0};
  const release=await acquireCollectorLock(client,table);
  let aborted,transaction=false,stopped=false,timer,monitorTask=Promise.resolve();
  let deletedKeys=0,deletedBytes=0,pid,oid,walStart,freeAtStart;
  const deadline=Date.now()+maxSeconds*1000;
  const check=()=>{if(aborted)throw aborted;if(Date.now()>deadline)throw Error('sweep aborted: maintenance deadline');};
  const cancel=async(reason)=>{
    if(aborted||stopped)return;
    aborted=Error('sweep aborted: '+reason);
    if(pid)await watchdog.query('SELECT pg_cancel_backend($1)',[pid]).catch(()=>{});
    // Also releases the fence when the collector is awaiting a network sample
    // or its JS loop, rather than an active PostgreSQL statement.
    await client.query('ROLLBACK').catch(()=>{});
  };
  const monitor=async()=>{
    if(stopped||aborted)return;
    try {
      const q=await watchdog.query(`SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE relation=$1 AND NOT granted AND pid<>$2) AS waiting,
        pg_wal_lsn_diff(pg_current_wal_lsn(),$3::pg_lsn)::text AS wal_bytes`,[oid,pid,walStart]);
      if(q.rows[0].waiting)return cancel('another table writer or maintenance operation queued');
      const wal=Number(q.rows[0].wal_bytes);
      if(!Number.isSafeInteger(wal)||wal<0||freeAtStart-wal<minFreeBytes+2*batchBytes)return cancel('headroom reserve exhausted');
      check();
    }catch{await cancel('watchdog, deadline or WAL measurement failed');}
  };
  try {
    // Cover writes occurring while the external volume sample is acquired too.
    walStart=(await watchdog.query('SELECT pg_current_wal_lsn()::text AS wal')).rows[0].wal;
    freeAtStart=await measureFreeBytes();
    if(!Number.isSafeInteger(freeAtStart)||freeAtStart<minFreeBytes+2*batchBytes)throw Error('sweep aborted: insufficient fresh headroom');
    await client.query('BEGIN');
    transaction=true;
    await client.query(`SET LOCAL statement_timeout='30s'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout='10s'`);
    await client.query(`LOCK TABLE ${n.relation} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    const identity=await client.query(`SELECT pg_backend_pid() AS pid,to_regclass($1)::oid AS oid,
      pg_current_wal_lsn()::text AS wal,clock_timestamp()-interval '1 hour' AS cutoff`,[n.relation]);
    ({pid,oid}=identity.rows[0]);
    timer=setInterval(()=>{monitorTask=monitorTask.then(monitor);},100);
    timer.unref();
    await verifyJournal(client,n);
    const unknown=await client.query(`SELECT 1 FROM ${n.relation}
      WHERE CASE WHEN octet_length(k)<6 THEN true
        WHEN substring(k FROM 1 FOR 5)<>decode('7067736c00','hex') THEN true
        ELSE get_byte(k,5) NOT IN(78,73,66,76,82,86,79,87,80,65,88,67) END LIMIT 1`);
    if(unknown.rows.length)throw Error('refusing sweep: unknown key namespace');
    const malformedNodes=await client.query(`SELECT 1 FROM ${n.relation}
      WHERE substring(k FROM 1 FOR 6)=decode('7067736c004e','hex')
        AND (octet_length(k)<>27 OR CASE WHEN octet_length(k)>6 THEN get_byte(k,6) ELSE -1 END NOT IN(1,2))
      LIMIT 1`);
    if(malformedNodes.rows.length)throw Error('refusing sweep: malformed node key');
    const live=await collectLive(retainedReader(client,n,identity.rows[0].cutoff,check),{traversalBatchSize:4096});
    check();
    if(!live.keys.size||live.stats.danglingRoots.length||live.stats.unreadableNodes)throw Error('refusing sweep: incomplete retained root closure');
    await client.query('CREATE TEMP TABLE pgsl_sweep_live(k bytea PRIMARY KEY) ON COMMIT DROP');
    const keys=[...live.keys];
    for(let i=0;i<keys.length;i+=4000){check();await client.query('INSERT INTO pgsl_sweep_live SELECT unnest($1::bytea[]) ON CONFLICT DO NOTHING',[keys.slice(i,i+4000).map(k=>Buffer.from(k,'hex'))]);}
    await onPhase('marked');check();
    // Only key+length metadata is materialized, never a second payload table.
    await client.query(`CREATE TEMP TABLE pgsl_sweep_candidates ON COMMIT DROP AS
      SELECT source.k,octet_length(source.v)::bigint AS bytes
      FROM ${n.relation} source WHERE
        (get_byte(source.k,5) IN(78,73,66,76,82,86,87) OR
          (get_byte(source.k,5)=80 AND substring(source.k FROM octet_length(source.k)-3 FOR 4)=decode('00000002','hex')))
        AND NOT EXISTS(SELECT 1 FROM pgsl_sweep_live live WHERE live.k=source.k)`);
    await client.query('CREATE UNIQUE INDEX ON pgsl_sweep_candidates(k)');
    for(;;){
      check();await monitor();check();
      const fresh=await measureFreeBytes();
      if(!Number.isSafeInteger(fresh)||fresh<minFreeBytes+2*batchBytes)throw Error('sweep aborted: fresh headroom reserve exhausted');
      const rows=await client.query('SELECT k,bytes FROM pgsl_sweep_candidates ORDER BY k LIMIT 256');
      if(!rows.rows.length||deletedBytes>=maxDeleteBytes)break;
      const batch=[];let bytes=0;
      for(const row of rows.rows){
        const size=Number(row.bytes);
        if(!Number.isSafeInteger(size)||size<0||size>128*1024*1024)throw Error('refusing sweep: orphan value exceeds deletion bound');
        if(batch.length&&(bytes+size>batchBytes||deletedBytes+bytes+size>maxDeleteBytes))break;
        if(!batch.length&&deletedBytes+size>maxDeleteBytes)break;
        batch.push(row.k);bytes+=size;if(bytes>=batchBytes)break;
      }
      if(!batch.length)break;
      const result=await client.query(`DELETE FROM ${n.relation} source WHERE source.k=ANY($1::bytea[])
        AND NOT EXISTS(SELECT 1 FROM pgsl_sweep_live live WHERE live.k=source.k)`,[batch]);
      deletedKeys+=result.rowCount??0;deletedBytes+=bytes;
      await client.query('DELETE FROM pgsl_sweep_candidates WHERE k=ANY($1::bytea[])',[batch]);
      await onPhase('deleted');check();
    }
    await client.query(`DELETE FROM ${n.roots} WHERE retired_at<$1`,[identity.rows[0].cutoff]);
    await monitor();check();
    stopped=true;clearInterval(timer);await monitorTask;check();
    await client.query('COMMIT');
    transaction=false;
  }catch(error){
    stopped=true;if(timer)clearInterval(timer);
    await monitorTask.catch(()=>{});
    if(transaction)await client.query('ROLLBACK').catch(()=>{});
    if(aborted)throw aborted;
    throw error;
  }finally{
    stopped=true;if(timer)clearInterval(timer);
    await release();
  }
  // PostgreSQL ordinary VACUUM returns dead heap/TOAST pages to the internal free
  // space map. TRUNCATE false avoids a tail AccessExclusive lock on live traffic.
  let vacuumed=false;
  try {
    await client.query(`SET statement_timeout='60s'`);
    await client.query(`VACUUM (ANALYZE,TRUNCATE FALSE) ${n.relation}`);
    vacuumed=true;
  } catch {
    // DELETE is already committed. Report this honestly so the next private run
    // can retry ordinary VACUUM without implying that committed work rolled back.
  }
  return{status:'swept',deletedKeys,deletedBytes,vacuumed};
}

async function main(){
  const connectionString=process.env.PGSL_PG_CONNSTR,token=process.env.RAILWAY_PROJECT_TOKEN;
  const table=process.env.PGSL_SWEEP_TABLE??'pgsl_kv';
  if(!connectionString)throw Error('PGSL_PG_CONNSTR is required');
  const endpoint=new URL(connectionString);
  if(!endpoint.hostname.endsWith('.railway.internal'))throw Error('private Railway database hostname is required');
  const client=new Client({connectionString,application_name:'pgsl-private-sweep'});
  const watchdog=new Client({connectionString,application_name:'pgsl-private-sweep-watchdog',statement_timeout:3000});
  await client.connect();await watchdog.connect();
  try{
    if(process.argv.includes('--install')){await installSweep(client,{table});console.log('Root journal installed; deletion disabled for its first hour.');return;}
    if(!token)throw Error('project-scoped Railway token is required for fresh volume headroom');
    const serviceId=process.env.PGSL_SWEEP_POSTGRES_SERVICE_ID;
    if(!serviceId)throw Error('exact postgres service ID is required');
    const gql=async(query,variables={})=>{
      const r=await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{
        'Content-Type':'application/json','Project-Access-Token':token},
        body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(5000)});
      const body=await r.json();if(!r.ok||body.errors?.length)throw Error('private collector headroom query failed');return body.data;
    };
    const identity=await gql('{projectToken{projectId environmentId}}');
    let sample;
    const measureFreeBytes=async()=>{
      if(!sample||Date.now()-sample.sampledAt>15000){
        const data=await gql('query($p:String!,$e:String!){project(id:$p){volumes{edges{node{id volumeInstances{edges{node{serviceId mountPath sizeMB currentSizeMB}}}}}}} environment(id:$e){config(decryptVariables:false)}}',
          {p:identity.projectToken.projectId,e:identity.projectToken.environmentId});
        sample=collectorVolumeHeadroom(data,serviceId);
      }
      return sample.capacityBytes-sample.usedBytes;
    };
    console.log(JSON.stringify(await sweepStore({client,watchdog,table,measureFreeBytes})));
  }finally{await watchdog.end();await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{console.error('Private PGSL sweep failed; no database payload or credentials are logged.');process.exitCode=1;});
}
