import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = new URL('../', import.meta.url);
const out = new URL('./.gc-test-runtime/', root);
await mkdir(out, { recursive: true });
for (const file of ['addressing', 'keyspace', 'gc-atom-header', 'gc']) {
  const source = await readFile(new URL('packages/pgsl-store/src/' + file + '.ts', root), 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'transform' }).replace(/\.\/([a-z-]+)\.js/g, './$1.mjs');
  await writeFile(new URL(file + '.mjs', out), js);
}
const { atomTopologyFromPrefix, ATOM_HEADER_BYTES } = await import(new URL('gc-atom-header.mjs', out));
const { readerFromPg, collectLive, hex } = await import(new URL('gc.mjs', out));
const { nodeKey, cpKey, subspaceRange } = await import(new URL('keyspace.mjs', out));
const hash = '1234567890abcdef1234567890abcdef12345678';
const address = {kind:'atom', hash:new Uint8Array(Buffer.from(hash,'hex'))};
const key = Buffer.from(nodeKey(address));
const opaque = (uri='urn:pgsl:atom:' + hash) =>
  Buffer.from(JSON.stringify({uri,kind:'atom',level:0,value:'x'.repeat(4096),provenance:{opaque:true}}));
const pgResult = (header=opaque().subarray(0,ATOM_HEADER_BYTES)) =>
  ({k:key, value_bytes:38*1024*1024, atom_header:header,needs_js_parse:false,topology:null});

test('38 MiB canonical opaque leaf returns topology from a 512-byte read', () => {
  assert.deepEqual(atomTopologyFromPrefix(key, opaque().subarray(0,512),38*1024*1024),{kind:'atom',level:0});
});
test('small atoms support other encoder key ordering and JSON escapes without another query', () => {
  const value=Buffer.from(JSON.stringify({value:'\\u0000',level:0,kind:'atom',uri:'urn:pgsl:atom:'+hash}));
  assert.deepEqual(atomTopologyFromPrefix(key,value,value.length),{kind:'atom',level:0});
});
test('canonical dereferenceable atom identifiers bind to the same stored key', () => {
  const value=opaque('https://relay.example/ns/pgsl/atom/'+hash);
  assert.deepEqual(atomTopologyFromPrefix(key,value.subarray(0,512),value.length),{kind:'atom',level:0});
});
test('mismatched key hash fails closed rather than inferring an unrelated leaf', () => {
  const value=opaque('urn:pgsl:atom:'+'f'.repeat(40));
  assert.throws(()=>atomTopologyFromPrefix(key,value.subarray(0,512),value.length),/does not match node key/);
});
test('malformed atom keys, short prefix reads and invalid byte lengths fail closed', () => {
  assert.throws(()=>atomTopologyFromPrefix(key.subarray(1),opaque().subarray(0,512),4096),/invalid atom header/);
  const fragmentKey=Buffer.from(key);fragmentKey[6]=2;
  assert.throws(()=>atomTopologyFromPrefix(fragmentKey,opaque().subarray(0,512),4096),/invalid atom header/);
  assert.throws(()=>atomTopologyFromPrefix(key,opaque().subarray(0,511),4096),/invalid atom header/);
  assert.throws(()=>atomTopologyFromPrefix(key,opaque().subarray(0,512),NaN),/invalid atom header/);
});
test('unknown large historical encoding takes the existing full JSON fallback', async () => {
  const body=Buffer.from(JSON.stringify({kind:'atom',uri:'urn:pgsl:atom:'+hash,level:0,value:'x'.repeat(4096)}));
  assert.equal(atomTopologyFromPrefix(key,body.subarray(0,512),body.length),null);
  const calls=[];
  const reader=readerFromPg({query:async sql=>{calls.push(sql);return {rows:calls.length===1
    ? [{...pgResult(body.subarray(0,512)),value_bytes:body.length}]
    : [{k:key,v:body}]};}});
  const values=await reader.getManyTopology([key]);
  assert.deepEqual(values.get(hex(key)).topology,{kind:'atom',level:0});
  assert.equal(calls.length,2);
});
test('atom query excludes whole-value JSON parsing and escape scanning from its branch', async () => {
  const calls=[];
  const reader=readerFromPg({query:async sql=>{calls.push(sql);return {rows:[pgResult()]};}});
  const values=await reader.getManyTopology([key]);
  assert.deepEqual(values.get(hex(key)).topology,{kind:'atom',level:0});
  assert.equal(calls.length,1);
  const [atoms,fragments]=calls[0].split('UNION ALL');
  assert.match(atoms,/substring\(source.v FROM 1 FOR 512\)/);
  assert.match(atoms,/get_byte\(source.k, 6\) = 1/);
  assert.doesNotMatch(atoms,/position\(|convert_from|json_to_record/);
  assert.match(fragments,/get_byte\(source.k, 6\) <> 1/);
});
test('fragment topology and exceptional JSON fallback keep their outgoing edges', async () => {
  const fragKey=Buffer.from(key);fragKey[6]=2;
  const reader=readerFromPg({query:async()=>({rows:[{k:fragKey,value_bytes:256,atom_header:null,needs_js_parse:false,
    topology:{kind:'fragment',level:2,items:['urn:pgsl:atom:'+hash],left:'urn:pgsl:fragment:'+'a'.repeat(40),right:'urn:pgsl:fragment:'+'b'.repeat(40)}}]})});
  const result=(await reader.getManyTopology([fragKey])).get(hex(fragKey)).topology;
  assert.equal(result.kind,'fragment');assert.equal(result.items.length,1);assert.equal(result.left,'urn:pgsl:fragment:'+'a'.repeat(40));
});
test('bounded header never treats a malformed fragment body as an atom', async () => {
  const body=Buffer.from(JSON.stringify({uri:'urn:pgsl:atom:'+hash,kind:'fragment',level:2,items:[]}));
  assert.equal(atomTopologyFromPrefix(key,body,body.length),null);
  let calls=0;
  const reader=readerFromPg({query:async()=>({rows:++calls===1
    ? [{...pgResult(body),value_bytes:body.length}]
    : [{k:key,v:body}]})});
  const result=(await reader.getManyTopology([key])).get(hex(key)).topology;
  assert.equal(result.kind,'fragment'); // collectLive compares it with the atom address and refuses it.
});
test('wide breadth-first closure survives repeated queue compaction without dropping nodes', async () => {
  const size=20000,fragmentHash='f'.repeat(40),rootUri='urn:pgsl:fragment:'+fragmentHash;
  const atomUris=Array.from({length:size},(_,i)=>'urn:pgsl:atom:'+i.toString(16).padStart(40,'0'));
  const topologies=new Map();
  topologies.set(hex(nodeKey({kind:'fragment',hash:Buffer.from(fragmentHash,'hex')})),{topology:{kind:'fragment',level:1,items:atomUris},byteLength:128});
  for(let i=0;i<size;i++)topologies.set(hex(nodeKey({kind:'atom',hash:Buffer.from(i.toString(16).padStart(40,'0'),'hex')})),{topology:{kind:'atom',level:0},byteLength:128});
  let batches=0,maxBatch=0;
  const control=cpKey('ldp css','https://pod.example/current');
  const reader={scan:async(begin,end,onRow)=>{if(hex(begin)===hex(subspaceRange('C').begin))onRow(control,Buffer.from(JSON.stringify({topUri:rootUri})));},
    getMany:async()=>new Map(),
    getManyTopology:async keys=>{batches++;maxBatch=Math.max(maxBatch,keys.length);return new Map(keys.map(k=>[hex(k),topologies.get(hex(k))]));}};
  const live=await collectLive(reader);
  assert.equal(live.stats.liveNodes,size+1);
  assert.equal(live.stats.liveAtoms,size);assert.equal(live.stats.liveFragments,1);
  assert.equal(live.stats.danglingRoots.length,0);assert.equal(live.stats.unreadableNodes,0);
  assert.equal(live.keys.size,size*5+4);
  assert.equal(batches,1+Math.ceil(size/32));assert.equal(maxBatch,32);
});

test('PostgreSQL 16 reads a bounded TOAST slice for an 8 MiB opaque leaf', {skip:!process.env.GC_TEST_PG_URL}, async t => {
  const run=promisify(execFile);
  const psql=async sql => (await run('psql',['-XAt','-v','ON_ERROR_STOP=1',process.env.GC_TEST_PG_URL,'-c',sql],
    {maxBuffer:2*1024*1024,timeout:60000})).stdout.trim();
  const identity=JSON.parse(await psql("SELECT row_to_json(r) FROM (SELECT current_database() AS db,current_user AS usr,inet_server_addr()::text AS addr) r"));
  assert.equal(identity.db,'gc_topology_test');assert.equal(identity.usr,'gc_topology_fixture');
  assert.ok(['127.0.0.1','[::1]','localhost'].includes(new URL(process.env.GC_TEST_PG_URL).hostname),'requires the isolated loopback fixture');
  const table='gc_topology_fixture',keySql="decode('"+key.toString('hex')+"','hex')";
  let created=false;
  try {
    await psql('CREATE TABLE '+table+' (k bytea PRIMARY KEY,v bytea NOT NULL)');
    created=true;
    await psql('ALTER TABLE '+table+' ALTER COLUMN v SET STORAGE EXTERNAL');
    const header=JSON.stringify({uri:'urn:pgsl:atom:'+hash,kind:'atom',level:0}).slice(0,-1)+',"value":"';
    const tail='","provenance":{"opaque":true}}';
    await psql('INSERT INTO '+table+" VALUES ("+keySql+",convert_to('"+header+"' || repeat('x',8388608) || '"+tail+"','UTF8'))");
    const calls=[];
    const reader=readerFromPg({query:async(sql,params)=>{
      calls.push(sql);
      const literal="ARRAY["+params[0].map(k=>"decode('"+Buffer.from(k).toString('hex')+"','hex')").join(',')+"]::bytea[]";
      const expanded=sql.replaceAll('$1::bytea[]',literal);
      const rows=JSON.parse(await psql("SELECT coalesce(json_agg(row_to_json(r)),'[]'::json) FROM ("+expanded+") r"));
      return {rows:rows.map(r=>({...r,k:Buffer.from(r.k.slice(2),'hex'),atom_header:r.atom_header===null?null:Buffer.from(r.atom_header.slice(2),'hex')}))};
    }},table);
    const values=await reader.getManyTopology([key]);
    assert.deepEqual(values.get(hex(key)).topology,{kind:'atom',level:0});
    assert.equal(calls.length,1,'canonical atom must not fetch the complete value');
    const expanded=calls[0].replaceAll('$1::bytea[]',"ARRAY["+keySql+"]::bytea[]");
    const plan=JSON.parse(await psql('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+expanded))[0];
    const old=JSON.parse(await psql("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT position(decode('5c75','hex') IN v),convert_from(v,'UTF8')::json->>'kind' FROM "+table+" WHERE k="+keySql))[0];
    const blocks=p=>(p.Plan['Shared Hit Blocks']??0)+(p.Plan['Shared Read Blocks']??0);
    assert.ok(blocks(plan)<blocks(old),'bounded slice should touch fewer shared buffers than full value parsing');
    t.diagnostic('new shared buffers='+blocks(plan)+', previous full-value probe='+blocks(old));
  } finally {
    if(created)await psql('DROP TABLE '+table);
  }
});
