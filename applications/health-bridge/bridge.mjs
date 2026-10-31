import { createHash, randomBytes, timingSafeEqual, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discoverDuke, authorizationRequest, exchangeDukeCode, refreshDukeToken, syncDuke } from './fhir.mjs';
import { ouraAuthorizationRequest, exchangeOuraCode, refreshOuraToken, syncOura } from './oura.mjs';
import { normalizeAppleBatch } from './apple.mjs';

export const ACTION = 'urn:interego:health:';
// Oura app registration and user OAuth do not authorize retained AI-facing imports.
// A future provider-authorized design requires a separately reviewed code change.
const OURA_IMPORT_ENABLED = false;
const OURA_RESTRICTION = 'Oura retained imports need provider authorization; app registration and OAuth alone are insufficient.';
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (a,b) => typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const cookie = (req,name) => (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);
export class BridgeError extends Error { constructor(status,code,message) { super(message);this.status=status;this.code=code; } }
const fail = (status,code,message) => {throw new BridgeError(status,code,message);};
const plainObject = value => value && typeof value==='object' && !Array.isArray(value);
const safeError = error => ({error:error.code||'operation_unavailable',message:error instanceof BridgeError?error.message:'This operation could not finish. Check the connection status and retry.'});

async function readJson(req,limit=2*1024*1024) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) fail(415,'json_required','Send a JSON request.');
  const chunks=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>limit) fail(413,'request_too_large','This upload is too large. Use smaller date windows.');chunks.push(chunk);}
  try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!plainObject(value))throw new Error();return value;}
  catch {fail(400,'invalid_json','A JSON object is required.');}
}

export function createHealthBridge(config) {
  const base=new URL(config.publicUrl).origin, relay=new URL(config.relayUrl).origin;
  if (!base.startsWith('https:') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('HEALTH_PUBLIC_URL must be HTTPS.');
  const store=config.store,security=config.security,fetcher=config.fetch||fetch,now=config.now||Date.now;
  const sessions=new Map(),pending=new Map(),locks=new Map(),limits=new Map();
  const sessionCookie=base.startsWith('https:')?'__Host-interego-health':'interego-health';
  const oauthCookie=base.startsWith('https:')?'__Host-interego-health-flow':'interego-health-flow';
  let relayMetadata;
  const ownerKey=actor=>'owner:'+hash(actor.principal);
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const redirect=(res,url)=>{res.writeHead(303,{Location:url});res.end();};
  const setCookie=(res,name,value,age)=>res.setHeader('Set-Cookie',`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${base.startsWith('https:')?'; Secure':''}`);
  const consumeLimit=(req,name,max=60)=>{
    // No trust in caller-supplied forwarding headers. A configured edge shares this bounded quota.
    const key=name+':'+(req.socket.remoteAddress||'unknown'),t=now();let bucket=limits.get(key);
    if(!bucket||bucket.reset<t){bucket={count:0,reset:t+60000};limits.set(key,bucket);}
    if(++bucket.count>max)fail(429,'rate_limited','Please wait a minute before trying again.');
    if(limits.size>5000)for(const [k,v] of limits)if(v.reset<t)limits.delete(k);
  };
  const serialized=async(key,task)=>{
    const before=locks.get(key)||Promise.resolve();let finish;const next=new Promise(r=>{finish=r;});locks.set(key,next);
    await before;try{return await task();}finally{finish();if(locks.get(key)===next)locks.delete(key);}
  };
  const loadOwner=async(actor)=>{
    const saved=await store.get(ownerKey(actor));
    if(saved && saved.principal!==actor.principal)fail(403,'owner_mismatch','The stored record belongs to another account.');
    return saved||{version:1,principal:actor.principal,userId:actor.userId,createdAt:new Date(now()).toISOString(),consent:{enabled:false},sources:{},records:[],batches:[]};
  };
  const saveOwner=(actor,value)=>store.put(ownerKey(actor),value);
  const requireConsent=owner=>{if(!owner.consent.enabled)fail(403,'consent_required','Enable private health imports before connecting a source.');};
  const requireSourceAllowed=source=>{if(source==='oura'&&!OURA_IMPORT_ENABLED)fail(403,'authorization_required',OURA_RESTRICTION);};
  const session=req=>{
    const s=sessions.get(cookie(req,sessionCookie));if(!s||s.expiresAt<=now())fail(401,'sign_in_required','Sign in with Interego.');return s;
  };
  const browserOwner=(req,write=false)=>{
    const s=session(req);
    if(write && (!equal(req.headers['x-csrf-token'],s.csrfToken)||req.headers.origin!==base))fail(403,'request_origin','Open the health connections page to make this change.');
    return s;
  };
  const setup=()=>({version:1,publicUrl:base,privacyUrl:base+'/privacy',status:config.duke?.clientId?'ready':'setup-required',
    duke:{configured:!!config.duke?.clientId,registrationRequired:!config.duke?.clientId,redirectUri:base+'/oauth/duke/callback',jwksUri:base+'/.well-known/jwks.json',sandboxJwksUri:base+'/.well-known/sandbox-jwks.json',fhirBase:'https://health-apis.duke.edu/FHIR/api/FHIR/R4'},
    oura:{configured:false,importEnabled:false,registrationRequired:false,authorizationRequired:true,status:'authorization_required',message:OURA_RESTRICTION,redirectUri:base+'/oauth/oura/callback'},
    apple:{supported:true,requiresIphone:true,endpoint:base+'/ingest/apple',mode:'selected-sample uploads',backgroundSyncVerified:false},
    publication:{automatic:false,rawSources:'private encrypted storage'}});
  const status=async(actor)=>{
    const o=await loadOwner(actor),s=setup(),sources={};
    for(const name of ['duke','oura','apple']){
      const v=o.sources[name]||{};
      if(name==='oura'&&!OURA_IMPORT_ENABLED){sources.oura={configured:false,importEnabled:false,connected:false,status:'authorization_required',authorizationRequired:true,message:OURA_RESTRICTION,lastSync:null,recordCount:0,coverage:[]};continue;}
      sources[name]={configured:name==='apple'||s[name].configured,connected:!!v.connected,status:v.status||(name==='apple'?'waiting_for_iphone':s[name].configured?'not_connected':'registration_required'),lastSync:v.lastSync||null,recordCount:o.records.filter(x=>x.source===name).length,coverage:v.coverage||[],...(name==='apple'?{pairingCount:(v.tokenHashes||[]).length}:{}),...(v.patientId?{patientId:v.patientId}:{})};
    }
    return {owner:{userId:actor.userId,principal:actor.principal},consent:o.consent,sources,recordCount:o.records.filter(r=>r.source!=='oura'||OURA_IMPORT_ENABLED).length,automaticPolling:false,publicAtlasSync:false};
  };
  const resourceKey=(actor,id)=>'record:'+hash(actor.principal+':'+id);
  const importRecords=async(actor,o,source,records)=>{
    requireSourceAllowed(source);
    let added=0,updated=0,unchanged=0;
    const index=new Map(o.records.map(x=>[x.id,x]));
    for(const r of records){
      const id=source+':'+(r.resourceType||r.kind||'sample')+':'+r.id;
      if(typeof r.id!=='string'||r.id.length>2048)fail(400,'invalid_source_record','A source record has no stable identifier.');
      const value={...r,id,source,retrievedAt:r.retrievedAt||new Date(now()).toISOString()};
      const digest=hash(JSON.stringify(r.raw??r));const previous=index.get(id);
      if(previous?.digest===digest){unchanged++;continue;}
      if(index.size>=20000&&!previous)fail(413,'record_limit','This account reached the import index limit. Request a smaller date window.');
      await store.put(resourceKey(actor,id),value);
      index.set(id,{id,source,resourceType:r.resourceType||r.kind||'sample',clinicalDate:r.clinicalDate||null,retrievedAt:value.retrievedAt,digest});
      if(previous)updated++;else added++;
    }
    o.records=[...index.values()];return {added,updated,unchanged};
  };
  const records=async(actor,params={})=>{
    const o=await loadOwner(actor);const source=params.source;
    if(source&&!['duke','oura','apple'].includes(source))fail(400,'source_invalid','Choose a known source.');
    requireSourceAllowed(source);
    const offset=Math.max(0,Math.min(20000,Number(params.offset)||0)),limit=Math.max(1,Math.min(100,Number(params.limit)||30));
    const selected=o.records.filter(r=>(r.source!=='oura'||OURA_IMPORT_ENABLED)&&(!source||r.source===source)).sort((a,b)=>String(b.clinicalDate||b.retrievedAt).localeCompare(String(a.clinicalDate||a.retrievedAt)));
    return {records:selected.slice(offset,offset+limit).map(({digest,...r})=>r),total:selected.length,nextOffset:offset+limit<selected.length?offset+limit:null,sourceRecordsArePrivate:true};
  };
  const metadata=async()=>{
    if(!relayMetadata){
      const r=await fetcher(relay+'/.well-known/oauth-authorization-server',{redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!r.ok)fail(503,'relay_unavailable','Interego sign-in is temporarily unavailable.');const m=await r.json();
      if(new URL(m.authorization_endpoint).origin!==relay||new URL(m.token_endpoint).origin!==relay)fail(503,'relay_metadata','Interego sign-in metadata did not match the configured relay.');relayMetadata=m;
    }
    return relayMetadata;
  };
  const newFlow=(res,kind,s,extra={})=>{
    const state=random(),verifier=random(),binding=random();
    pending.set(state,{kind,verifier,binding,sessionId:s?.sessionId,actor:s?.actor,expiresAt:now()+600000,...extra});setCookie(res,oauthCookie,binding,600);
    if(pending.size>1000)for(const[k,v]of pending)if(v.expiresAt<now())pending.delete(k);
    return {state,verifier};
  };
  const takeFlow=(req,url,kind)=>{
    const state=url.searchParams.get('state'),flow=pending.get(state);if(state)pending.delete(state);
    if(!flow||flow.kind!==kind||flow.expiresAt<now()||!equal(cookie(req,oauthCookie),flow.binding))fail(400,'oauth_state','This sign-in attempt expired or belongs to another browser. Start again.');
    if(flow.sessionId && cookie(req,sessionCookie)!==flow.sessionId)fail(403,'oauth_session','Use the same signed-in browser to finish connecting.');
    if(url.searchParams.has('error'))fail(400,'authorization_declined','The source connection was not authorized.');
    const code=url.searchParams.get('code');if(!code||code.length>8192)fail(400,'oauth_code','The source did not return a valid authorization code.');
    return {...flow,code};
  };
  const tokenRecord=(token)=>({...token,expiresAt:now()+Math.min(31536000,Number(token.expires_in)||3600)*1000});

  const syncSource=async(actor,source,params={})=>serialized(ownerKey(actor),async()=>{
    requireSourceAllowed(source);
    const o=await loadOwner(actor);requireConsent(o);const connection=o.sources[source];
    if(!connection?.token?.access_token)fail(409,'source_not_connected','Connect this source before syncing.');
    let token=connection.token;
    if(token.expiresAt<=now()+60000){
      if(!token.refresh_token)fail(409,'reconnect_required','This source needs authorization again.');
      // Refresh rotation is committed before the next external operation. Per-owner serialization prevents double use.
      const fresh=source==='duke'?await refreshDukeToken({metadata:await discoverDuke({clientId:config.duke.clientId,fetch:fetcher}),...config.duke,patientId:connection.patientId,refreshToken:token.refresh_token,fetch:fetcher}):await refreshOuraToken({...config.oura,refreshToken:token.refresh_token,fetch:fetcher});
      token=tokenRecord({...token,...fresh});connection.token=token;await saveOwner(actor,o);
    }
    const result=source==='duke'?await syncDuke({metadata:await discoverDuke({clientId:config.duke.clientId,fetch:fetcher}),accessToken:token.access_token,patientId:connection.patientId,previousWatermark:connection.watermark,grantedScopes:token.scope,fetch:fetcher}):await syncOura({accessToken:token.access_token,startDate:params.startDate,endDate:params.endDate,previousWatermark:connection.watermark,grantedScopes:token.scope,fetch:fetcher});
    const imported=await importRecords(actor,o,source,result.resources||result.records||[]);
    connection.coverage=result.coverage||[];connection.lastAttempt=new Date(now()).toISOString();connection.status=result.complete?'connected':'partial_sync';connection.connected=true;
    if(result.complete){connection.watermark=result.watermark;connection.lastSync=connection.lastAttempt;}
    await saveOwner(actor,o);return {source,complete:result.complete,...imported,coverage:connection.coverage,errors:result.errors||[],lastSync:connection.lastSync||null,publicAtlasUpdated:false};
  });
  const pairApple=async(actor,params={})=>serialized(ownerKey(actor),async()=>{
    const o=await loadOwner(actor);requireConsent(o);
    const allowed=new Set(['steps','heartRate','restingHeartRate','activeEnergy','bodyMass','oxygenSaturation','sleep']);
    const metrics=params.metrics||[...allowed];if(!Array.isArray(metrics)||!metrics.length||metrics.length>allowed.size||metrics.some(m=>!allowed.has(m)))fail(400,'metrics_invalid','Choose the Apple Health metrics to upload.');
    const apple=o.sources.apple||{connected:false,status:'waiting_for_iphone',tokenHashes:[]};
    if(apple.tokenHashes.length>=5)fail(409,'pairing_limit','Revoke existing Apple pairings before creating more.');
    const token='iah_'+random(),tokenHash=hash(token),expiresAt=new Date(now()+30*86400000).toISOString();
    await store.put('pairing:'+tokenHash,{principal:actor.principal,userId:actor.userId,agentId:actor.agentId,podUrl:actor.podUrl,metrics:[...new Set(metrics)],expiresAt,revoked:false,deviceId:null});
    apple.tokenHashes.push(tokenHash);o.sources.apple=apple;await saveOwner(actor,o);
    return {token,endpoint:base+'/ingest/apple',expiresAt,metrics:[...new Set(metrics)],instructionsUrl:base+'/docs/apple-shortcut.md',scope:'apple:upload-only',privateStorage:true};
  });
  const revoke=async(actor,source)=>serialized(ownerKey(actor),async()=>{
    if(!['duke','oura','apple'].includes(source))fail(400,'source_invalid','Choose a known source.');
    const o=await loadOwner(actor),c=o.sources[source]||{};
    if(source==='apple')for(const tokenHash of c.tokenHashes||[]){const t=await store.get('pairing:'+tokenHash);if(t)await store.put('pairing:'+tokenHash,{...t,revoked:true});}
    o.sources[source]={connected:false,status:'disconnected',tokenHashes:[],disconnectedAt:new Date(now()).toISOString()};await saveOwner(actor,o);
    return {source,connected:false,retainedRecords:o.records.filter(r=>r.source===source).length,note:'Stored source credentials and pairing permissions were removed locally. Existing imported records remain private. Provider-side revocation may also be needed in the provider account.'};
  });

  const apiOperation=async(actor,operation,params={})=>{
    if(operation==='status')return status(actor);
    if(operation==='records')return records(actor,params);
    if(operation==='record'){
      const o=await loadOwner(actor);if(typeof params.id!=='string'||!o.records.some(r=>r.id===params.id))fail(404,'record_not_found','This record is not in your health import index.');
      requireSourceAllowed(o.records.find(r=>r.id===params.id).source);
      return {record:await store.get(resourceKey(actor,params.id)),private:true};
    }
    if(operation==='consent')return serialized(ownerKey(actor),async()=>{if(typeof params.enabled!=='boolean')fail(400,'consent_invalid','Choose whether private imports are enabled.');const o=await loadOwner(actor);o.consent={enabled:params.enabled,changedAt:new Date(now()).toISOString()};await saveOwner(actor,o);return {consent:o.consent};});
    if(operation==='apple/pair')return pairApple(actor,params);
    if(operation==='duke/sync'||operation==='oura/sync')return syncSource(actor,operation.split('/')[0],params);
    if(operation==='revoke')return revoke(actor,params.source);
    fail(404,'operation_not_found','This health operation is not supported.');
  };
  const profile=()=>({
    '@context':{hydra:'http://www.w3.org/ns/hydra/core#',schema:'https://schema.org/'},'@id':base+'/profile','@type':'hydra:EntryPoint',name:'Interego Private Health Connections',version:'0.1.0',setup:base+'/setup',human:base+'/',turtle:base+'/profile.ttl',rawRecords:'encrypted private source records',publicAtlasPublishing:false,
    authentication:{kind:'Interego relay-delegated signature',signWith:'sign_request',signedFields:['action','target','params','nonce'],target:base,nonce:'fresh random string, at least 16 characters',timestamp:'stamped by the relay; checked for freshness',identity:'derived from verified agent controller; never caller-selected owner'},
    affordances:['status','records','record','consent','apple/pair','duke/sync','oura/sync','revoke'].map(op=>({action:ACTION+op,target:base+'/actions',method:'POST',description:op==='oura/sync'?OURA_RESTRICTION:op==='records'?'List private source record metadata, 30 per page; no public publication.':op==='record'?'Read one record from the verified owner index.':op==='consent'?'Enable or disable private imports; does not change provider permissions.':op,parameters:op==='records'?{source:'optional duke|oura|apple',limit:'1–100',offset:'0–20000'}:op==='record'?{id:'owned record id'}:op==='consent'?{enabled:'boolean'}:op==='apple/pair'?{metrics:'selected allowed Apple Health metrics'}:op==='revoke'?{source:'duke|oura|apple'}:{}}))
  });
  // The generic Interego follower parses Turtle, not arbitrary JSON. Derive its declarations
  // from the same action list as /profile so discovery cannot drift from the active routes.
  const profileTurtle=()=>{
    const p=profile(),iri=value=>{if(/[\s<>"{}|\\^`]/.test(value))throw new Error('Unserializable profile IRI');return '<'+value+'>';},literal=value=>JSON.stringify(String(value));
    const subject=iri(p.turtle),shape=iri(p.turtle+'#SignedEnvelope');
    const control=a=>iri(p.turtle+'#action-'+encodeURIComponent(a.action.slice(ACTION.length)));
    const lines=[
      '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
      '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
      '@prefix dcat: <http://www.w3.org/ns/dcat#> .',
      '@prefix dct: <http://purl.org/dc/terms/> .',
      '@prefix schema: <https://schema.org/> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix sh: <http://www.w3.org/ns/shacl#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      `${subject} a hydra:EntryPoint ; schema:name ${literal(p.name)} ; dct:hasFormat ${iri(p['@id'])} ;`,
      `  schema:url ${iri(p.human)} ; rdfs:comment ${literal('Sign {action,target,params,nonce} with Interego sign_request. target inside the signed payload is '+base+'. Send the returned {_signed_payload,_signature} envelope unchanged to the selected hydra:target using descriptor_url '+p.turtle+' and action_iri. No account credential or private record is included in this profile.')} ;`,
      `  iep:affordance ${p.affordances.map(control).join(', ')} .`,
      `${shape} a sh:NodeShape ;`,
      '  sh:property [ sh:path <urn:interego:health:field:_signed_payload> ; sh:name "_signed_payload" ; sh:datatype xsd:string ; sh:minCount 1 ; sh:maxCount 1 ; sh:description "Exact signed payload string returned by sign_request; do not parse and reserialize it." ] ;',
      '  sh:property [ sh:path <urn:interego:health:field:_signature> ; sh:name "_signature" ; sh:datatype xsd:string ; sh:minCount 1 ; sh:maxCount 1 ; sh:description "Exact relay signature returned by sign_request." ] .',
    ];
    for(const a of p.affordances){
      const template={signWith:'sign_request',payload:{action:a.action,target:p.authentication.target,params:{},nonce:'<fresh-random-string-at-least-16-characters>'},parameterDescriptions:a.parameters,submit:'Pass the returned signed envelope unchanged to the declared hydra:target.'};
      lines.push(`${control(a)} a iep:Affordance, hydra:Operation ;`,
        `  iep:action ${iri(a.action)} ; hydra:target ${iri(a.target)} ; hydra:method ${literal(a.method)} ;`,
        `  dcat:mediaType "application/json" ; hydra:expects ${shape} ;`,
        `  rdfs:label ${literal(a.description)} ; iep:inputTemplate ${literal(JSON.stringify(template))} .`);
    }
    return lines.join('\n')+'\n';
  };

  const handler=async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    let url;
    try {
      url=new URL(req.url,base);if(url.origin!==base)fail(400,'request_url','Invalid request URL.');
      const path=url.pathname;
      if(req.method==='GET' && path==='/health')return json(res,200,{ok:true,service:'interego-health-bridge',version:'0.1.0',sourceConnectionsAreNotImplied:true});
      const host=req.headers.host?.split(':')[0];if(host && ![new URL(base).hostname,'127.0.0.1','localhost'].includes(host))fail(421,'request_host','Use the configured health connections address.');
      if(req.method==='GET' && path==='/profile'){res.setHeader('Link',`<${base}/profile.ttl>; rel="alternate"; type="text/turtle"`);return json(res,200,profile());}
      if(req.method==='GET' && path==='/profile.ttl'){res.setHeader('Link',`<${base}/profile>; rel="alternate"; type="application/json"`);res.writeHead(200,{'Content-Type':'text/turtle; charset=utf-8'});return res.end(profileTurtle());}
      if(req.method==='GET' && path==='/setup')return json(res,200,setup());
      if(req.method==='GET' && path==='/.well-known/jwks.json'){
        if(!config.duke?.privateKeyPem)return json(res,200,{keys:[]});
        const jwk=createPublicKey(config.duke.privateKeyPem).export({format:'jwk'});return json(res,200,{keys:[{...jwk,kid:config.duke.keyId,alg:'RS256',use:'sig'}]});
      }
      if(req.method==='GET' && path==='/.well-known/sandbox-jwks.json'){
        if(!config.duke?.sandboxPrivateKeyPem)return json(res,200,{keys:[]});
        const jwk=createPublicKey(config.duke.sandboxPrivateKeyPem).export({format:'jwk'});return json(res,200,{keys:[{...jwk,kid:config.duke.sandboxKeyId,alg:'RS256',use:'sig'}]});
      }
      if(req.method==='GET' && path==='/oauth/client.json')return json(res,200,{client_id:base+'/oauth/client.json',client_name:'Interego Health Connections',client_uri:base,redirect_uris:[base+'/oauth/interego/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'});
      if(req.method==='GET' && path==='/oauth/interego/start'){
        consumeLimit(req,'login',10);const m=await metadata();const f=newFlow(res,'interego');const u=new URL(m.authorization_endpoint);
        u.search=new URLSearchParams({response_type:'code',client_id:base+'/oauth/client.json',redirect_uri:base+'/oauth/interego/callback',scope:'mcp',resource:relay+'/mcp',state:f.state,code_challenge:hashChallenge(f.verifier),code_challenge_method:'S256'}).toString();return redirect(res,u.href);
      }
      if(req.method==='GET' && path==='/oauth/interego/callback'){
        consumeLimit(req,'login',10);const f=takeFlow(req,url,'interego'),m=await metadata();
        const r=await fetcher(m.token_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:f.code,code_verifier:f.verifier,client_id:base+'/oauth/client.json',redirect_uri:base+'/oauth/interego/callback',resource:relay+'/mcp'}),redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!r.ok)fail(401,'interego_exchange_failed','Interego sign-in could not finish. Start again.');const t=await r.json();
        if(typeof t.access_token!=='string')fail(401,'interego_exchange_failed','Interego did not return a session credential.');
        const actor=await security.authenticateBearer('Bearer '+t.access_token);const id=random();
        for(const [key,value] of sessions)if(value.expiresAt<=now())sessions.delete(key);
        if(sessions.size>=1000)fail(503,'session_capacity','Sign-in capacity was reached. Try again later.');
        sessions.set(id,{sessionId:id,actor,csrfToken:random(),expiresAt:now()+Math.min(3600,Number(t.expires_in)||3600)*1000});
        setCookie(res,sessionCookie,id,Math.min(3600,Number(t.expires_in)||3600));return redirect(res,base+'/?connected=interego');
      }
      if(req.method==='GET' && /^\/oauth\/(duke|oura)\/callback$/.test(path)){
        consumeLimit(req,'callback',15);const source=path.split('/')[2];requireSourceAllowed(source);const f=takeFlow(req,url,source);const s=session(req);if(s.actor.principal!==f.actor.principal)fail(403,'owner_mismatch','Use the account that started this connection.');
        await serialized(ownerKey(f.actor),async()=>{
          const o=await loadOwner(f.actor);requireConsent(o);
          const t=source==='duke'?await exchangeDukeCode({metadata:f.metadata,...config.duke,code:f.code,verifier:f.verifier,redirectUri:base+'/oauth/duke/callback',fetch:fetcher}):await exchangeOuraCode({...config.oura,code:f.code,verifier:f.verifier,redirectUri:base+'/oauth/oura/callback',fetch:fetcher});
          if(source==='duke'&&!t.patient)fail(400,'patient_missing','Duke did not bind this authorization to a patient.');
          o.sources[source]={connected:true,status:'authorized_not_synced',token:tokenRecord(t),...(source==='duke'?{patientId:t.patient}:{}),connectedAt:new Date(now()).toISOString(),coverage:[]};await saveOwner(f.actor,o);
        });return redirect(res,base+'/?connected='+source);
      }
      if(req.method==='GET' && path==='/api/status'){const s=browserOwner(req);return json(res,200,{...await status(s.actor),csrfToken:s.csrfToken});}
      if(req.method==='GET' && path==='/api/records'){const s=browserOwner(req);return json(res,200,await records(s.actor,Object.fromEntries(url.searchParams)));}
      if(req.method==='POST' && /^\/api\//.test(path)){
        consumeLimit(req,'manage',60);const s=browserOwner(req,true),body=await readJson(req);const op=path.slice(5);
        if(op==='duke/start'||op==='oura/start'){
          const source=op.split('/')[0];requireSourceAllowed(source);const o=await loadOwner(s.actor);requireConsent(o);const settings=config[source];
          if(!settings?.clientId||(source==='oura'&&!settings.clientSecret))fail(409,'registration_required',`${source==='duke'?'Epic / Duke':'Oura'} app registration must be configured before source sign-in.`);
          const m=source==='duke'?await discoverDuke({clientId:settings.clientId,fetch:fetcher}):undefined;
          const f=newFlow(res,source,s,{metadata:m});const auth=source==='duke'?authorizationRequest({metadata:m,clientId:settings.clientId,redirectUri:base+'/oauth/duke/callback',state:f.state,verifier:f.verifier}):ouraAuthorizationRequest({clientId:settings.clientId,redirectUri:base+'/oauth/oura/callback',state:f.state,verifier:f.verifier});
          return json(res,200,{url:auth.url});
        }
        return json(res,200,await apiOperation(s.actor,op,body));
      }
      if(req.method==='POST' && path==='/actions'){
        consumeLimit(req,'actions',60);const envelope=await readJson(req,128*1024);
        let claimed;try{claimed=JSON.parse(envelope._signed_payload).action;}catch{fail(400,'signed_request_required','Use an Interego signed action envelope.');}
        if(typeof claimed!=='string'||!profile().affordances.some(a=>a.action===claimed))fail(400,'action_invalid','Choose a supported health action.');
        const actor=await security.authenticateSigned(envelope,claimed,base);return json(res,200,await apiOperation(actor,claimed.slice(ACTION.length),actor.payload.params||{}));
      }
      if(req.method==='POST' && path==='/ingest/apple'){
        consumeLimit(req,'apple',120);const authorization=req.headers.authorization||'';if(!authorization.startsWith('Bearer iah_')||authorization.length>256)fail(401,'pairing_required','A valid Apple upload-only pairing token is required.');
        const tokenHash=hash(authorization.slice(7)),credential=await store.get('pairing:'+tokenHash);
        if(!credential||credential.revoked||Date.parse(credential.expiresAt)<=now())fail(401,'pairing_expired','This Apple pairing has expired or was revoked.');
        const batch=normalizeAppleBatch(await readJson(req),{now:now()});
        if(batch.coverage.client==='healthkit-native'||batch.deletions?.length)fail(403,'native_capability_not_enabled','This pairing permits selected Shortcut uploads only. Native deletion access has not been granted.');
        const actor={principal:credential.principal,userId:credential.userId,agentId:credential.agentId,podUrl:credential.podUrl};
        const receipt=await serialized(ownerKey(actor),async()=>{
          const o=await loadOwner(actor);requireConsent(o);if(!o.sources.apple?.tokenHashes?.includes(tokenHash))fail(401,'pairing_revoked','This Apple pairing is no longer active.');
          const live=await store.get('pairing:'+tokenHash);
          if(!live||live.revoked||Date.parse(live.expiresAt)<=now()||live.principal!==actor.principal)fail(401,'pairing_revoked','This Apple pairing is no longer active.');
          if(live.deviceId&&live.deviceId!==batch.deviceId)fail(403,'device_mismatch','Use a separate pairing token for each device.');
          if(batch.samples.some(s=>!live.metrics.includes(s.metric))||batch.coverage.metrics.some(m=>!live.metrics.includes(m)))fail(403,'metric_not_approved','This batch contains a metric outside the pairing permission.');
          const batchKey=hash(batch.deviceId+':'+batch.batchId),batchDigest=hash(JSON.stringify({samples:batch.samples,deletions:batch.deletions,coverage:batch.coverage,windowStart:batch.windowStart,windowEnd:batch.windowEnd}));
          const previous=o.batches.find(b=>b.key===batchKey);
          if(previous){if(previous.digest!==batchDigest)fail(409,'batch_conflict','This batch identifier was already used with different observations. Send a new batch identifier.');return {accepted:true,duplicateBatch:true,added:0,updated:0};}
          if(!live.deviceId)await store.put('pairing:'+tokenHash,{...live,deviceId:batch.deviceId});
          const converted=batch.samples.map(s=>({id:batch.deviceId+':'+s.id,source:'apple',resourceType:s.metric,clinicalDate:s.startDate||s.start,retrievedAt:new Date(now()).toISOString(),raw:s,kind:'device-observation'}));
          const imported=await importRecords(actor,o,'apple',converted);
          // Never treat an omitted sample as a deletion. Explicit native deletions remain source tombstones.
          for(const deletion of batch.deletions||[]){const matches=o.records.filter(r=>r.source==='apple'&&r.id.endsWith(':'+batch.deviceId+':'+deletion.id));for(const match of matches){const v=await store.get(resourceKey(actor,match.id));await store.put(resourceKey(actor,match.id),{...v,deleted:true,deletionReceivedAt:new Date(now()).toISOString()});}}
          o.sources.apple={...o.sources.apple,connected:true,status:'receiving_selected_samples',lastSync:new Date(now()).toISOString(),coverage:batch.coverage,warnings:batch.warnings};o.batches.push({key:batchKey,digest:batchDigest});o.batches=o.batches.slice(-1000);
          await saveOwner(actor,o);
          return {accepted:true,...imported,deleted:(batch.deletions||[]).length,receivedAt:o.sources.apple.lastSync,completeHealthHistory:false,publicAtlasUpdated:false,warnings:batch.warnings};
        });return json(res,200,receipt);
      }
      if(req.method==='GET' && ['/','/privacy','/terms','/app.js','/style.css','/ui/app.js','/ui/style.css','/docs/apple-shortcut.md','/docs/duke-setup.md','/docs/oura-setup.md'].includes(path)){
        const file=path==='/'?'ui/index.html':path==='/privacy'?'ui/privacy.html':path==='/terms'?'ui/terms.html':path.endsWith('/app.js')?'ui/app.js':path.endsWith('/style.css')?'ui/style.css':path.slice(1);const body=await readFile(new URL(file,import.meta.url));res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':path.endsWith('.md')?'text/markdown; charset=utf-8':'text/html; charset=utf-8'});return res.end(body);
      }
      fail(404,'not_found','This health connection route does not exist.');
    }catch(error){
      if(res.headersSent)return res.end();const statusCode=Number(error.status)||Number(error.statusCode)||500;
      if(url?.pathname?.includes('/callback'))return redirect(res,base+'/?error='+encodeURIComponent(error.code||'connection_failed'));
      json(res,statusCode>=400&&statusCode<=599?statusCode:500,safeError(error));
    }
  };
  return {handler,profile,setup,status,apiOperation};
}
function hashChallenge(verifier){return createHash('sha256').update(verifier).digest('base64url');}
