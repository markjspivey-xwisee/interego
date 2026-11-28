import test from 'node:test';
import assert from 'node:assert/strict';
import { learningRecordsConfig, learningRecordsReader, LEARNING_RECORDS_SCOPE } from '../learning-records.ts';
import { createHmac, randomBytes } from 'node:crypto';

const cfg = learningRecordsConfig({
  INTEREGO_SELF_RECORDS_CALLBACK: 'https://workbench.example/',
  PUBLIC_BASE_URL: 'https://relay.example',
  INTEREGO_SELF_RECORDS_UPSTREAM: 'https://vertical.example/internal/learning-records/statements',
  INTEREGO_SELF_RECORDS_SECRET: randomBytes(32).toString('hex'),
})!;
const alice = { userId: 'u-pk-alice123', podUrl: 'https://gate.example/u-pk-alice123/' };
const grant = { scopes: [LEARNING_RECORDS_SCOPE], resource: cfg.resource, extra: alice };
function transport(verified: () => Promise<typeof grant>, opts: { origin?: string; body?: unknown; token?: string } = {}) {
  const calls: Array<{ time: number; user: string; pod: string; query: unknown }> = [];
  const reader = learningRecordsReader(cfg, verified, async (url, init) => {
    assert.equal(String(url), 'https://vertical.example/internal/learning-records/statements');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    const raw = JSON.parse(String(init?.body));
    const proof = headers.get('X-Interego-Learning-Read');
    const freshMac = createHmac('sha256', cfg.secret)
      .update('interego-account-self-records-v1\n').update(String(init?.body)).digest('hex');
    assert.equal(proof, freshMac);
    assert.ok(Date.now() - raw.time < 1000);
    calls.push(raw);
    return Response.json({statements:[],more:''});
  });
  let status=0;
  const res={setHeader(k:string,v:string){assert.equal(k,'Cache-Control');assert.equal(v,'no-store');},status(s:number){status=s;return this;},json(){}};
  const req={get:(k:string)=>k==='origin'?opts.origin??cfg.redirect.origin:opts.token??'Bearer '+'a'.repeat(64),is:()=>true,body:opts.body??{query:{limit:20}}};
  return {calls, run:async()=>{await reader(req as never,res as never,()=>{});return status;}};
}
test('relay goes only to Foxxi with an authenticated parent account and read query', async()=>{
  const r=transport(async()=>grant);
  assert.equal(await r.run(),200);
  assert.equal(r.calls.length,1);
  assert.deepEqual(({user:r.calls[0]!.user,pod:r.calls[0]!.pod,query:r.calls[0]!.query}),{user:alice.userId,pod:alice.podUrl,query:{limit:20}});
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
