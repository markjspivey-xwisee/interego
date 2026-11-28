import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
const url=new URL('./applications/foxxi-content-intelligence/src/xapi-lrs.ts','file://'+process.cwd()+'/').href;
const entry=new URL('./applications/foxxi-content-intelligence/bridge/server.ts','file://'+process.cwd()+'/').href;
const port=16083, base='http://127.0.0.1:'+port;
const secret='fictional-loopback-testing-only-never-production';
const a='u-pk-test-account-a',b='u-pk-test-account-b';
const aid='11111111-1111-4111-8111-111111111111',bid='22222222-2222-4222-8222-222222222222';
const seed=`
const lrs=await import(${JSON.stringify(url)});
for(const [account,id] of ${JSON.stringify([[a,aid],[b,bid]])}) {
 const stored=new Date().toISOString();
 await lrs.getStatementStore('lens:'+account).put({id,stored,voided:false,statement:{
  id, stored, timestamp:stored, actor:{account:{name:account,homePage:'https://example.invalid'}},
  verb:{id:'urn:test:learned'},object:{id:'urn:test:topic'},version:'1.0.3'
 }});
}
await import(${JSON.stringify(entry)});
`;
const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',seed],{
  stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,NODE_ENV:'test',NODE_NO_WARNINGS:'1',PORT:String(port),
  FOXXI_LRS_BACKEND:'memory',FOXXI_TENANT_POD_URL:'http://127.0.0.1:9/foxxi/',
  FOXXI_AUTHORITATIVE_SOURCE:'did:web:container-smoke.test',FOXXI_BRIDGE_PRIVATE_KEY:'0x'+'11'.repeat(32),
  FOXXI_ADMIN_KEY_SEED:'synthetic-local-foxxi-proof',BRIDGE_DEPLOYMENT_URL:base,FOXXI_AUDIENCE:'both',
  INTEREGO_BUILD_SHA:'workbench-fictional-proof',FOXXI_RELAY_TRUST_SECRET:secret}
});
let log='',exited=false;
const cap=c=>{log=(log+c).slice(-16000)};
child.stdout.on('data',cap);child.stderr.on('data',cap);
child.once('exit',()=>exited=true);
const end=once(child,'exit');
try {
 let health=null;
 for(let i=0;i<100&&!health&&!exited;i++){
  try { const r=await fetch(base+'/health',{signal:AbortSignal.timeout(400)});if(r.ok)health=await r.json(); }catch{}
  if(!health)await pause(200);
 }
 assert.equal(health?.build,'workbench-fictional-proof','Actual Foxxi failed to start: '+log);
 function read(user,query={},pod='http://127.0.0.1:9/'+user+'/',valid=true){
  const body=JSON.stringify({time:Date.now(),user,pod,query});
  const proof=createHmac('sha256',secret).update('foxxi-xapi-self-read-v1\n').update(body).digest('hex');
  return fetch(base+'/internal/learning-records/statements',{method:'POST',body,
   headers:{'Content-Type':'application/json',...(valid?{'X-Interego-Learning-Read':proof}:{})},signal:AbortSignal.timeout(5000)});
 }
 for(const [user,id,peer] of [[a,aid,bid],[b,bid,aid]]){
  const r=await read(user);const body=await r.json(); assert.equal(r.status,200,JSON.stringify(body));
  assert.deepEqual(body.statements.map(x=>x.id),[id]);
  const item=await read(user,{statementId:id});assert.equal(item.status,200,await item.clone().text());
  assert.equal((await item.json()).id,id);
  assert.equal((await read(user,{statementId:peer})).status,404);
 }
 assert.equal((await read(a,{},undefined,false)).status,403);
 assert.equal((await read(a,{},'http://127.0.0.1:9/'+b+'/')).status,403);
 console.log('PASS: Actual Foxxi HTTP and Stores, two seeded synthetic lenses, own list and UUID lookup, peer UUID hidden and unsigned refused');
} finally {
 child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),1000);force.unref();await end;clearTimeout(force);
}
