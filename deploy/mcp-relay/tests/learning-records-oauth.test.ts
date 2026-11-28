import express from 'express';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { corsMiddleware } from '../cors-allowlist.js';
import { listenLoopback } from './listen-loopback.js';
import { interegoOAuthRouter } from '../oauth-router.js';
import { InteregoOAuthProvider } from '../oauth-provider.js';
import { learningRecordsConfig, LEARNING_RECORDS_PATH, LEARNING_RECORDS_SCOPE } from '../learning-records.js';

const issuer = new URL('https://relay.example/');
const config = learningRecordsConfig({
  PUBLIC_BASE_URL: issuer.href,
  INTEREGO_SELF_RECORDS_CALLBACK: 'https://workbench.example/',
  INTEREGO_SELF_RECORDS_UPSTREAM: 'https://vertical.example/internal/learning-records/statements',
  INTEREGO_SELF_RECORDS_SECRET: randomBytes(32).toString('hex'),
})!;
const provider = new InteregoOAuthProvider({identityUrl:'https://identity.example',resourceIdentifier:issuer.href});
process.env.PUBLIC_BASE_URL = issuer.href;
process.env.INTEREGO_SELF_RECORDS_CALLBACK = config.redirect.href;
const app = express();
app.use(corsMiddleware({ownOrigin:issuer.origin}));
app.use(express.json());
const a = 'u-pk-test-account-a', b = 'u-pk-test-account-b';
const statementBy = new Map([[a, 'statement A'],[b,'statement B']]);
app.use(interegoOAuthRouter({provider,issuerUrl:issuer,learningRecords:config,learningRecordsTransport:async (_url,init)=>{
  const envelope = JSON.parse(String(init?.body)) as {user:string;pod:string;query:{statementId?:string}};
  assert.equal(envelope.pod,'https://gate.example/'+envelope.user+'/');
  const id = statementBy.get(envelope.user);
  return envelope.query.statementId && id !== envelope.query.statementId
    ? Response.json({error:'not found'},{status:404})
    : Response.json({statements:[{id}],more:''});
}}));
const server = await listenLoopback(app);
try {
  for (const path of ['/register','/token',LEARNING_RECORDS_PATH]) {
    const res = await fetch(server.base+path,{method:'OPTIONS',headers:{Origin:config.redirect.origin,
      'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'}});
    assert.equal(res.status,204);
    assert.equal(res.headers.get('access-control-allow-origin'),config.redirect.origin);
  }
  const other = await fetch(server.base+'/mcp',{headers:{Origin:config.redirect.origin}});
  assert.notEqual(other.headers.get('access-control-allow-origin'),config.redirect.origin);
  const response = await fetch(server.base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'Learning Records fictional console test',redirect_uris:[config.redirect.href],grant_types:['authorization_code'],token_endpoint_auth_method:'none',
  })});
  assert.equal(response.status,201);
  const {client_id} = await response.json() as {client_id:string};
  const verifier=randomBytes(32).toString('hex');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const getAuthorize=(scope:string,resource=config.resource.href)=>fetch(server.base+'/authorize?'+new URLSearchParams({
    client_id,redirect_uri:config.redirect.href,response_type:'code',scope,resource,code_challenge:challenge,code_challenge_method:'S256',
  }),{redirect:'manual'});
  const combined=await getAuthorize(LEARNING_RECORDS_SCOPE+' mcp');
  assert.equal(combined.status,302);
  assert.equal(new URL(combined.headers.get('location')!).searchParams.get('error'),'invalid_scope');
  const wrongResource=await getAuthorize(LEARNING_RECORDS_SCOPE,issuer.href);
  assert.equal(wrongResource.status,302);
  async function issue(userId:string) {
    const authorize = await getAuthorize(LEARNING_RECORDS_SCOPE);
    assert.equal(authorize.status,200);
    const html = await authorize.text();
    assert.match(html,/Read your own learning records/);
    const pending=/const PENDING_ID = "([0-9a-f]+)"/.exec(html)?.[1];
    assert.ok(pending);
    const auth = provider.completePendingAuthorization(pending,{
      userId,agentId:'urn:test:do-not-use-agent-as-learner',ownerWebId:'https://identity.example/users/'+userId+'/profile#me',
      podUrl:'https://gate.example/'+userId+'/',identityToken:randomBytes(32).toString('hex'),
    });
    assert.ok(auth);
    const token=await fetch(server.base+'/token',{
      method:'POST',body:new URLSearchParams({grant_type:'authorization_code',code:auth.code,client_id,
        redirect_uri:config.redirect.href,code_verifier:verifier,resource:config.resource.href}),
    });
    assert.equal(token.status,200);
    const grant=await token.json() as {access_token:string;scope:string;refresh_token?:string;expires_in:number};
    assert.equal(grant.scope,LEARNING_RECORDS_SCOPE);
    assert.equal(grant.refresh_token,undefined);
    assert.equal(grant.expires_in,600);
    assert.equal(provider.introspectAccessToken(grant.access_token),null);
    await assert.rejects(provider.verifyAccessToken(grant.access_token));
    return grant.access_token;
  }
  const alice=await issue(a), bob=await issue(b);
  const read=(token:string,query:Record<string,unknown>={})=>fetch(server.base+LEARNING_RECORDS_PATH,{method:'POST',
    headers:{Origin:config.redirect.origin,'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({query}),
  });
  assert.deepEqual(await (await read(alice)).json(),{statements:[{id:'statement A'}],more:''});
  assert.deepEqual(await (await read(bob)).json(),{statements:[{id:'statement B'}],more:''});
  assert.equal((await read(alice,{statementId:'statement B'})).status,404);
  console.log('PASS: real authorization-code and PKCE exchange, distinct owner reads, no MCP or pod scope, no refresh');
} finally { await server.close(); }
