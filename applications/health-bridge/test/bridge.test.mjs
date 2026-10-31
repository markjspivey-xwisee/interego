import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { createHealthBridge,ACTION } from '../bridge.mjs';
import { createEncryptedStore } from '../security.mjs';

const now=()=>Date.parse('2026-10-31T17:00:00Z');
const actors={alice:{userId:'alice',principal:'did:web:example.test:users:alice',agentId:'did:web:example.test:agents:alice',podUrl:'https://store.example/alice/'},bob:{userId:'bob',principal:'did:web:example.test:users:bob',agentId:'did:web:example.test:agents:bob',podUrl:'https://store.example/bob/'}};
async function fixture(t,overrides={}){
  const directory=await mkdtemp(join(tmpdir(),'health-bridge-'));
  const store=createEncryptedStore({directory,keyHex:'a1'.repeat(32)});
  const security={async authenticateBearer(){throw Object.assign(new Error('blocked'),{status:401});},async authenticateSigned(envelope,action,target){const p=JSON.parse(envelope._signed_payload);assert.equal(p.action,action);assert.equal(p.target,target);return {...actors[p.actor],payload:p};}};
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const bridge=createHealthBridge({publicUrl:origin,relayUrl:'https://relay.example',now,duke:{},oura:{},...overrides,store,security:{...security,...overrides.security}});server.on('request',bridge.handler);
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
  const f=await fixture(t);const setup=await(await fetch(f.origin+'/setup')).json();assert.equal(setup.duke.configured,false);assert.equal(setup.oura.configured,false);assert.equal(setup.oura.importEnabled,false);assert.equal(setup.apple.supported,true);assert.equal(setup.publication.automatic,false);
  for(const path of ['/','/ui/app.js','/ui/style.css','/profile']){const r=await fetch(f.origin+path);assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);}
  assert.equal((await fetch(f.origin+'/api/status')).status,401);assert.equal((await fetch(f.origin+'/api/records')).status,401);
  const probe=path=>new Promise((resolve,reject)=>{const req=httpRequest(f.origin+path,{headers:{Host:'healthcheck.railway.app'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(await probe('/health'),200);
  assert.equal(await probe('/setup'),421);
});
test('sandbox JWKS publishes only its separate public key and never falls back to production',async t=>{
  const key=()=>generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const production=key(),sandbox=key();
  const f=await fixture(t,{duke:{privateKeyPem:production.privateKey,keyId:'production-key',sandboxPrivateKeyPem:sandbox.privateKey,sandboxKeyId:'sandbox-key'}});
  const setup=await(await fetch(f.origin+'/setup')).json();assert.equal(setup.duke.sandboxJwksUri,f.origin+'/.well-known/sandbox-jwks.json');assert.notEqual(setup.duke.sandboxJwksUri,setup.duke.jwksUri);
  const productionJwks=await(await fetch(setup.duke.jwksUri)).json(),sandboxJwks=await(await fetch(setup.duke.sandboxJwksUri)).json();
  assert.deepEqual(productionJwks,{keys:[{...createPublicKey(production.publicKey).export({format:'jwk'}),kid:'production-key',alg:'RS256',use:'sig'}]});
  assert.deepEqual(sandboxJwks,{keys:[{...createPublicKey(sandbox.publicKey).export({format:'jwk'}),kid:'sandbox-key',alg:'RS256',use:'sig'}]});
  assert.notEqual(sandboxJwks.keys[0].n,productionJwks.keys[0].n);
  for(const jwks of [productionJwks,sandboxJwks]){assert.deepEqual(Object.keys(jwks.keys[0]).sort(),['alg','e','kid','kty','n','use']);assert.equal(JSON.stringify(jwks).includes('PRIVATE KEY'),false);}
  const unconfigured=await fixture(t,{duke:{privateKeyPem:production.privateKey,keyId:'production-key'}});
  assert.deepEqual(await(await fetch(unconfigured.origin+'/.well-known/sandbox-jwks.json')).json(),{keys:[]});
});
test('JSON and Turtle discovery profiles expose the same eight action declarations',async t=>{
  const f=await fixture(t),response=await fetch(f.origin+'/profile'),profile=await response.json();
  assert.equal(profile.turtle,f.origin+'/profile.ttl');assert.match(response.headers.get('link'),/rel="alternate"; type="text\/turtle"/);
  const ttl=await fetch(profile.turtle);assert.equal(ttl.status,200);assert.match(ttl.headers.get('content-type'),/^text\/turtle/);assert.match(ttl.headers.get('cache-control'),/no-store/);
  const source=await ttl.text();
  for(const action of profile.affordances){assert.ok(source.includes('<'+action.action+'>'));assert.ok(source.includes('<'+action.target+'>'));}
  assert.equal((source.match(/a iep:Affordance, hydra:Operation/g)||[]).length,8);
  assert.match(source,/sh:name "_signed_payload"/);assert.match(source,/sh:name "_signature"/);
  assert.ok(source.includes('Send the returned {_signed_payload,_signature} envelope unchanged'));
});
test('Oura imports, OAuth and source reads remain blocked even with credentials and old records',async t=>{
  const external=[];
  const f=await fixture(t,{oura:{clientId:'synthetic-client',clientSecret:'synthetic-secret'},ouraImportEnabled:true,security:{async authenticateBearer(){return actors.alice;}},fetch:async(url,options)=>{
    external.push(url);
    if(url==='https://relay.example/.well-known/oauth-authorization-server')return Response.json({authorization_endpoint:'https://relay.example/authorize',token_endpoint:'https://relay.example/token'});
    if(url==='https://relay.example/token')return Response.json({access_token:'synthetic-token',expires_in:3600});
    throw new Error('No Oura network call is permitted');
  }});
  const ownerKey='owner:'+createHash('sha256').update(actors.alice.principal).digest('hex');
  await f.store.put(ownerKey,{principal:actors.alice.principal,userId:'alice',consent:{enabled:true},sources:{oura:{connected:true,status:'connected',token:{access_token:'synthetic-old-token',expiresAt:now()+3600000}}},records:[{id:'oura:sleep:synthetic',source:'oura',clinicalDate:'2026-10-30'},{id:'duke:Observation:synthetic',source:'duke',clinicalDate:'2026-10-30'}],batches:[]});
  const setup=await(await fetch(f.origin+'/setup')).json();assert.equal(setup.oura.configured,false);assert.equal(setup.oura.importEnabled,false);assert.equal(setup.oura.status,'authorization_required');assert.equal(setup.oura.authorizationRequired,true);
  const state=(await f.call('status')).body;assert.equal(state.sources.oura.connected,false);assert.equal(state.sources.oura.status,'authorization_required');assert.equal(state.recordCount,1);
  assert.deepEqual((await f.call('records')).body.records.map(r=>r.source),['duke']);
  assert.equal((await f.call('records',{source:'oura'})).body.error,'authorization_required');
  assert.equal((await f.call('record',{id:'oura:sleep:synthetic'})).body.error,'authorization_required');
  assert.equal((await f.call('oura/sync')).body.error,'authorization_required');assert.equal(external.length,0);
  const start=await fetch(f.origin+'/oauth/interego/start',{redirect:'manual'}),flowCookie=start.headers.get('set-cookie').split(';')[0],stateValue=new URL(start.headers.get('location')).searchParams.get('state');
  const callback=await fetch(f.origin+'/oauth/interego/callback?code=synthetic&state='+stateValue,{headers:{Cookie:flowCookie},redirect:'manual'}),sessionCookie=callback.headers.get('set-cookie').split(';')[0];assert.equal(callback.status,303);
  const signedStatus=await(await fetch(f.origin+'/api/status',{headers:{Cookie:sessionCookie}})).json();
  const blocked=await fetch(f.origin+'/api/oura/start',{method:'POST',headers:{Cookie:sessionCookie,Origin:f.origin,'X-CSRF-Token':signedStatus.csrfToken,'Content-Type':'application/json'},body:'{}'});assert.equal(blocked.status,403);assert.equal((await blocked.json()).error,'authorization_required');
  const sourceCallback=await fetch(f.origin+'/oauth/oura/callback?code=synthetic&state=synthetic',{redirect:'manual'});assert.equal(sourceCallback.status,303);assert.match(sourceCallback.headers.get('location'),/error=authorization_required/);
  assert.ok(external.every(url=>url.startsWith('https://relay.example/')));
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
