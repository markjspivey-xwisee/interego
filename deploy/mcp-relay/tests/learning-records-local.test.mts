import test from 'node:test';
import assert from 'node:assert/strict';
import { learningRecordsConfig, learningRecordsReader, LEARNING_RECORDS_SCOPE } from '../learning-records.ts';
import { scopedCursor, verifyScopedCursor, verifySessionRead } from '../../../applications/foxxi-content-intelligence/src/interego-session-read.ts';

const cfg = learningRecordsConfig({
  INTEREGO_LEARNING_RECORDS_REDIRECT: 'https://workbench.example/',
  PUBLIC_BASE_URL: 'https://relay.example',
  FOXXI_BRIDGE_URL: 'https://foxxi.example',
  FOXXI_RELAY_TRUST_SECRET: 'only-a-fictional-transport-key-for-local-tests',
})!;
const alice = { userId: 'u-pk-alice123', podUrl: 'https://gate.example/u-pk-alice123/' };
const grant = { scopes: [LEARNING_RECORDS_SCOPE], resource: cfg.resource, extra: alice };
function transport(verified: () => Promise<typeof grant>, opts: { origin?: string; body?: unknown; token?: string } = {}) {
  const calls: Array<ReturnType<typeof verifySessionRead>> = [];
  const reader = learningRecordsReader(cfg, verified, async (url, init) => {
    assert.equal(String(url), 'https://foxxi.example/internal/learning-records/statements');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    const raw = JSON.parse(String(init?.body));
    const proof = headers.get('X-Interego-Learning-Read');
    const opts = { secret: cfg.secret, ownStore: (p: string) => new URL(p).origin === 'https://gate.example', tenantPod: 'https://gate.example/foxxi/' };
    const d = verifySessionRead(raw, proof, opts);
    assert.equal(verifySessionRead({...raw, pod: 'https://gate.example/u-pk-bob/'}, proof, opts), null);
    assert.equal(verifySessionRead(raw, proof, {...opts, now: raw.time+31_000}), null);
    calls.push(d);
    return Response.json({statements:[],more:''},{status:d?200:403});
  });
  let status=0;
  const res={setHeader(k:string,v:string){assert.equal(k,'Cache-Control');assert.equal(v,'no-store');},status(s:number){status=s;return this;},json(){}};
  const req={get:(k:string)=>k==='origin'?opts.origin??cfg.redirect.origin:opts.token??'Bearer '+'a'.repeat(64),is:()=>true,body:opts.body??{query:{limit:20}}};
  return {calls, run:async()=>{await reader(req as never,res as never,()=>{});return status;}};
}
test('relay goes only to Foxxi with an authenticated parent account and read query', async()=>{
  const r=transport(async()=>grant);
  assert.equal(await r.run(),200);
  assert.deepEqual(r.calls,[{user:alice.userId,pod:alice.podUrl,query:{limit:20}}]);
});
test('rejected scope, audience, origin, anonymous, bearer or body do not reach Foxxi',async()=>{
  for(const [g, opts, status] of [
    [{...grant, scopes:['mcp:read']},{},403],
    [{...grant, scopes:[LEARNING_RECORDS_SCOPE,'mcp']},{},403],
    [{...grant, resource:new URL('https://relay.example/mcp')},{},403],
    [grant,{origin:'https://other.example'},403],
    [grant,{token:'invalid'},401],
    [grant,{body:{query:{},pod:alice.podUrl}},400],
  ] as const) {
    const r=transport(async()=>g as typeof grant,opts);
    assert.equal(await r.run(),status);
    assert.equal(r.calls.length,0);
  }
});
test('an asserted foreign/missing pod fails closed at the Foxxi boundary', async()=>{
  for(const podUrl of ['https://wrong.example/u-pk-alice123/','https://gate.example/u-pk-bob/','https://gate.example/foxxi/']){
    const r=transport(async()=>({...grant,extra:{...alice,podUrl}}));
    assert.equal(await r.run(),403);
    assert.deepEqual(r.calls,[null]);
  }
});
test('cursor is bound to the authenticated account and rejects edits',()=>{
  const token=scopedCursor(cfg.secret,alice.userId,'opaque.cursor');
  assert.equal(verifyScopedCursor(cfg.secret,alice.userId,token),'opaque.cursor');
  assert.equal(verifyScopedCursor(cfg.secret,'u-pk-bob',token),null);
  assert.equal(verifyScopedCursor(cfg.secret,alice.userId,'edit'+token),null);
});
