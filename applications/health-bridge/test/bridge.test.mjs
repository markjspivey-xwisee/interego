import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHealthBridge,ACTION } from '../bridge.mjs';
import { createEncryptedStore } from '../security.mjs';

const now=()=>Date.parse('2026-10-31T17:00:00Z');
const actors={alice:{userId:'alice',principal:'did:web:example.test:users:alice',agentId:'did:web:example.test:agents:alice',podUrl:'https://store.example/alice/'},bob:{userId:'bob',principal:'did:web:example.test:users:bob',agentId:'did:web:example.test:agents:bob',podUrl:'https://store.example/bob/'}};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'health-bridge-'));
  const store=createEncryptedStore({directory,keyHex:'a1'.repeat(32)});
  const security={async authenticateBearer(){throw Object.assign(new Error('blocked'),{status:401});},async authenticateSigned(envelope,action,target){const p=JSON.parse(envelope._signed_payload);assert.equal(p.action,action);assert.equal(p.target,target);return {...actors[p.actor],payload:p};}};
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const bridge=createHealthBridge({publicUrl:origin,relayUrl:'https://relay.example',store,security,now,duke:{},oura:{}});server.on('request',bridge.handler);
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  const call=async(op,params={},actor='alice',extra={})=>{
    const payload={action:ACTION+op,target:origin,actor,params,nonce:'testnonce1234567890'};
    const r=await fetch(origin+'/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({_signed_payload:JSON.stringify(payload),_signature:'tested-by-security-unit-suite',...extra})});return {status:r.status,body:await r.json()};
  };
  const ingest=async(token,batch)=>{const r=await fetch(origin+'/ingest/apple',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(batch)});return {status:r.status,body:await r.json()};};
  return {origin,bridge,store,directory,call,ingest};
}
const batch=(id='batch-1',metric='heartRate')=>({version:1,deviceId:'phone-1',batchId:id,samples:[{metric,value:72,unit:'bpm',startDate:'2026-10-31T12:00:00Z',endDate:'2026-10-31T12:01:00Z',source:'Watch'}]});

test('public setup and assets expose connection requirements but no private account',async t=>{
  const f=await fixture(t);const setup=await(await fetch(f.origin+'/setup')).json();assert.equal(setup.duke.configured,false);assert.equal(setup.oura.configured,false);assert.equal(setup.apple.supported,true);assert.equal(setup.publication.automatic,false);
  for(const path of ['/','/ui/app.js','/ui/style.css','/profile']){const r=await fetch(f.origin+path);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);}
  assert.equal((await fetch(f.origin+'/api/status')).status,401);assert.equal((await fetch(f.origin+'/api/records')).status,401);
});
test('imports require private consent, and owner actions use only the signed params',async t=>{
  const f=await fixture(t);assert.equal((await f.call('apple/pair',{metrics:['heartRate']})).status,403);
  await f.call('consent',{enabled:true},'alice',{params:{enabled:false},owner:'bob'});
  assert.equal((await f.call('status')).body.consent.enabled,true);assert.equal((await f.call('status',{},'bob')).body.consent.enabled,false);
  const paired=await f.call('apple/pair',{metrics:['heartRate']});assert.equal(paired.status,200);assert.match(paired.body.token,/^iah_/);assert.equal(paired.body.scope,'apple:upload-only');
});
test('Apple receipts are idempotent, scoped and private across owners',async t=>{
  const f=await fixture(t);await f.call('consent',{enabled:true});const {token}= (await f.call('apple/pair',{metrics:['heartRate']})).body;
  const first=await f.ingest(token,batch());assert.equal(first.status,200);assert.equal(first.body.added,1);assert.equal(first.body.publicAtlasUpdated,false);
  const retry=await f.ingest(token,batch());assert.equal(retry.body.duplicateBatch,true);
  const again=await f.ingest(token,batch('batch-2'));assert.equal(again.body.unchanged,1);
  const list=(await f.call('records')).body;assert.equal(list.total,1);assert.equal((await f.call('records',{},'bob')).body.total,0);
  const id=list.records[0].id;assert.equal((await f.call('record',{id},'bob')).status,404);assert.equal((await f.call('record',{id})).body.record.raw.value,72);
  const tokenAsRead=await fetch(f.origin+'/api/records',{headers:{Authorization:'Bearer '+token}});assert.equal(tokenAsRead.status,401);
  const wrong=batch('batch-3');wrong.deviceId='phone-2';assert.equal((await f.ingest(token,wrong)).status,403);
});
test('a Shortcut pairing cannot grant itself native deletion rights or new metrics',async t=>{
  const f=await fixture(t);await f.call('consent',{enabled:true});const {token}= (await f.call('apple/pair',{metrics:['heartRate']})).body;
  const oxygen=batch('b-spo2','oxygenSaturation');oxygen.samples[0].value=97;oxygen.samples[0].unit='%';assert.equal((await f.ingest(token,oxygen)).status,403);
  const falseScope={version:1,deviceId:'phone-1',batchId:'false-scope',samples:[],coverage:{metrics:['sleep'],complete:false}};assert.equal((await f.ingest(token,falseScope)).status,403);
  const native=batch('native');native.client='healthkit-native';native.samples[0].id='550e8400-e29b-41d4-a716-446655440000';native.deletions=[{id:'660e8400-e29b-41d4-a716-446655440000'}];assert.equal((await f.ingest(token,native)).status,403);
});
test('concurrent first uploads bind a pairing to one device, and batch ids cannot change evidence',async t=>{
  const f=await fixture(t);await f.call('consent',{enabled:true});const {token}= (await f.call('apple/pair',{metrics:['heartRate']})).body;
  const a=batch('initial-a'),b=batch('initial-b');b.deviceId='phone-2';const results=await Promise.all([f.ingest(token,a),f.ingest(token,b)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,403]);
  const winning=results[0].status===200?a:b;const changed=structuredClone(winning);changed.samples[0].value=73;assert.equal((await f.ingest(token,changed)).status,409);assert.equal((await f.call('records')).body.total,1);
});
test('revocation and disabled consent stop future phone uploads without exposing or erasing history',async t=>{
  const f=await fixture(t);await f.call('consent',{enabled:true});const {token}= (await f.call('apple/pair',{metrics:['heartRate']})).body;await f.ingest(token,batch());
  await f.call('consent',{enabled:false});assert.equal((await f.ingest(token,batch('after-consent'))).status,403);
  await f.call('consent',{enabled:true});const revoked=await f.call('revoke',{source:'apple'});assert.equal(revoked.body.retainedRecords,1);assert.equal((await f.ingest(token,batch('after-revoke'))).status,401);assert.equal((await f.call('records')).body.total,1);
});
test('source records, pairing records and owner index remain encrypted at rest',async t=>{
  const f=await fixture(t);await f.call('consent',{enabled:true});const {token}= (await f.call('apple/pair',{metrics:['heartRate']})).body;await f.ingest(token,batch());
  for(const name of await readdir(f.directory)){const raw=await readFile(join(f.directory,name),'utf8');assert.doesNotMatch(raw,/heartRate|did:web:example|phone-1/);assert.equal(raw.includes(token),false);assert.equal(JSON.parse(raw).alg,'A256GCM');}
});
test('browser write routes refuse unsigned cookie requests and callback state is not fabricated',async t=>{
  const f=await fixture(t);const r=await fetch(f.origin+'/api/consent',{method:'POST',headers:{'Content-Type':'application/json',Origin:f.origin},body:JSON.stringify({enabled:true})});assert.equal(r.status,401);
  const callback=await fetch(f.origin+'/oauth/duke/callback?code=secret-code&state=made-up',{redirect:'manual'});assert.equal(callback.status,303);assert.match(callback.headers.get('location'),/error=oauth_state/);assert.equal(callback.headers.get('location').includes('secret-code'),false);
});
