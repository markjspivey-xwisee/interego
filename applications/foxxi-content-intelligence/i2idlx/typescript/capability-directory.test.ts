import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Run the actual browser module; avoid a second copy of its validation or secret handling.
const source=readFileSync(new URL('../app/src/capability-directory.js',import.meta.url),'utf8');
type Payload=Record<string,unknown>;
interface Api {
  actionInputs(action:unknown):unknown[];
  actionId(action:unknown):string;
  initialPayload(action:unknown):unknown;
  parsePayload(text:string):{value?:Payload;error?:string};
  validatePayload(action:unknown,payload:Payload):string|null;
  fieldValue(payload:Payload,field:unknown):string;
  editField(payload:Payload,field:unknown,text:string):{value?:Payload;error?:string};
  describeCapability(action:unknown):{canRun:boolean;label:string};
  capabilityCall(action:unknown,payload:Payload,manifest:string):string;
  resultLabel(result:unknown,action?:unknown):string;
  isCredentialField(name:string):boolean;
  credentialPaths(payload:unknown,path?:string,allowPlaceholders?:boolean):string[];
  redactCredentials(payload:unknown):unknown;
  directoryRequestBody(action:unknown,payload:Payload,mode:string):string;
  localSigningPayload(signing:unknown,text:string):{value?:Payload;error?:string;warning?:string};
}
const api=new Function(source.replace(/^export /gm,'')+'\nreturn {actionInputs,actionId,initialPayload,parsePayload,validatePayload,fieldValue,editField,describeCapability,capabilityCall,resultLabel,isCredentialField,credentialPaths,redactCredentials,directoryRequestBody,localSigningPayload};')() as Api;
const typed={input_schema:{type:'object',required:['count','enabled'],properties:{
  count:{type:'integer'},enabled:{type:'boolean'},meta:{type:'object'},tags:{type:'array'},
  choice:{type:'string',enum:['yes','no']},
}}};

test('request input editing preserves primitive, structured and optional JSON types',()=>{
  const [count,enabled,meta,tags]=api.actionInputs(typed);
  assert.deepEqual(api.editField({},count,'0').value,{count:0});
  assert.deepEqual(api.editField({},enabled,'false').value,{enabled:false});
  assert.deepEqual(api.editField({},meta,'{"nested":1}').value,{meta:{nested:1}});
  assert.deepEqual(api.editField({},tags,'["real input"]').value,{tags:['real input']});
  assert.deepEqual(api.editField({count:8},count,'').value,{});
  assert.match(api.editField({},meta,'{').error!,/valid object/);
  assert.match(api.editField({},count,'1.5').error!,/integer/);
});

test('JSON parsing and required-field checks distinguish zero and false from missing values',()=>{
  assert.deepEqual(api.parsePayload('{"count":0,"enabled":false}').value,{count:0,enabled:false});
  for(const invalid of ['[]','null','"text"','invalid'])assert.ok(api.parsePayload(invalid).error);
  assert.equal(api.validatePayload(typed,{count:0,enabled:false}),null);
  assert.match(api.validatePayload(typed,{count:0})!,/enabled is required/);
  assert.match(api.validatePayload(typed,{count:0,enabled:'false'})!,/boolean/);
  assert.match(api.validatePayload(typed,{count:0,enabled:false,choice:'maybe'})!,/advertised value/);
});

test('an advertised or read-only action is not executable without an explicit runner profile',()=>{
  assert.equal(api.describeCapability({ro:true}).canRun,false);
  assert.equal(api.describeCapability({execution:{mode:'prepare-only'}}).canRun,false);
  assert.equal(api.describeCapability({execution:{mode:'unavailable'}}).label,'Unavailable');
  assert.equal(api.describeCapability({execution:{mode:'client-only'}}).label,'Connected client only');
  assert.equal(api.describeCapability({execution:{mode:'public-example'}}).canRun,true);
  assert.equal(api.describeCapability({execution:{mode:'client-required'}}).label,'Client required');
});

test('validation, actual execution and client-task preparation have distinct result labels',()=>{
  assert.match(api.resultLabel({status:'contract-valid',executed:false}),/not executed/);
  assert.match(api.resultLabel({status:'invalid',executed:false}),/Invalid inputs/);
  assert.match(api.resultLabel({status:'refused',executed:false}),/Refused/);
  assert.equal(api.resultLabel({status:'executed',executed:true}),'Executed');
  assert.equal(api.resultLabel({status:'executed',executed:true},{execution:{mode:'client-required'}}),'Client task prepared');
  assert.notEqual(api.resultLabel({status:'executed',executed:false}),'Executed');
});

test('prepared calls use the real action IRI and current payload for each transport',()=>{
  assert.equal(api.capabilityCall({sys:'relay',n:'relay.find_capabilities'},{q:'record'},'manifest'),'find_capabilities {\n  "q": "record"\n}');
  assert.equal(api.actionId({sys:'foxxi',n:'foxxi.discover_lrs',iri:'https://relay.interego.xwisee.com/ns/iep/action/foxxi/discover-lrs'}),'act-foxxi.discover-lrs');
  assert.equal(api.actionId({sys:'telemetry',n:'llm_telemetry.capture_read',iri:'https://relay.interego.xwisee.com/ns/iep/action/llm-telemetry/capture-read'}),'act-llm-telemetry.capture-read');
  assert.deepEqual(JSON.parse(api.capabilityCall({sys:'telemetry',iri:'urn:actual:action'},{limit:2},'https://service/manifest')),
    {descriptor_url:'https://service/manifest',action_iri:'urn:actual:action',payload:{limit:2}});
});

test('raw credentials are blocked before generic runner serialization or network submission',()=>{
  const secret='MUST-NOT-LEAVE-THIS-BROWSER';
  for(const field of ['mentor_seed','private_key','llm_api_key','password','bearer','authorization','access_token','apiKey','FOXXI_BRIDGE_PRIVATE_KEY','_signature','_signed_payload','human_seed','lrs_auth_header','key']){
    assert.equal(api.isCredentialField(field),true,field);
    const payload={nested:[{[field]:secret}]};
    let networkCalls=0;
    const send=()=>{const body=api.directoryRequestBody({iri:'urn:action'},payload,'validate');networkCalls++;return body;};
    assert.throws(send,/Raw credentials cannot be sent/,field);
    assert.equal(networkCalls,0,field+' must stop before the request body reaches fetch');
    assert.equal(api.capabilityCall({sys:'foxxi',iri:'urn:action'},payload,'manifest').includes(secret),false,field);
  }
  assert.equal(api.isCredentialField('owner_encryption_key'),false,'public encryption key is not a private credential');
  assert.equal(api.isCredentialField('monkey'),false);
  assert.deepEqual(JSON.parse(api.directoryRequestBody({iri:'urn:action'},{query:'safe'},'example')),
    {action_iri:'urn:action',payload:{query:'safe'},mode:'example'});
});

test('examples, prepared required credentials and response evidence never expose credential values',()=>{
  const secret='MUST-NOT-BE-COPIED';
  assert.equal(JSON.stringify(api.initialPayload({example:{payload:{llm_api_key:secret}}})).includes(secret),false);
  assert.equal(JSON.stringify(api.redactCredentials({result:[{password:secret}]})).includes(secret),false);
  const prepared=api.capabilityCall({sys:'relay',n:'configure',in:[{n:'private_key',req:true}]},{},'manifest');
  assert.match(prepared,/provided by your connected client/);
});

test('only fixed client placeholders can reach schema-only validation; execution and raw bearer text stay blocked',()=>{
  const placeholder='<provided by your connected client>';
  assert.deepEqual(JSON.parse(api.directoryRequestBody({iri:'urn:action'},{private_key:placeholder},'validate')),
    {action_iri:'urn:action',payload:{private_key:placeholder},mode:'validate'});
  assert.throws(()=>api.directoryRequestBody({iri:'urn:action'},{private_key:placeholder},'example'),/Raw credentials/);
  assert.throws(()=>api.directoryRequestBody({iri:'urn:action'},{description:placeholder},'example'),/Raw credentials/);
  assert.throws(()=>api.directoryRequestBody({iri:'urn:action'},{description:'Bearer PRIVATE12345'},'validate'),/Raw credentials/);
  assert.equal(api.capabilityCall({sys:'foxxi',iri:'urn:action'},{description:'Bearer PRIVATE12345'},'manifest').includes('PRIVATE12345'),false);
});

test('local signing preparation preserves advertised action and audience and never includes raw credentials',()=>{
  const signing={schema:{type:'object',required:['action','bridge_audience','course_iri'],properties:{
    action:{type:'string'},bridge_audience:{type:'string'},course_iri:{type:'string'},
  }},payload:{action:'foxxi.consume_lesson',bridge_audience:'https://actual.example',course_iri:''}};
  const body={...signing.payload,course_iri:'https://actual.example/course#package'};
  assert.equal(api.localSigningPayload(signing,JSON.stringify(body)).value?.course_iri,body.course_iri);
  assert.match(api.localSigningPayload(signing,JSON.stringify({...body,action:'other'})).error!,/action binding/);
  assert.match(api.localSigningPayload(signing,JSON.stringify({...body,bridge_audience:'https://foreign.example'})).error!,/bridge_audience/);
  const prepared=api.localSigningPayload(signing,JSON.stringify({...body,private_key:'NEVER-COPY'}));
  assert.equal(JSON.stringify(prepared.value).includes('NEVER-COPY'),false);
  assert.match(prepared.warning!,/omitted/);
  assert.match(api.localSigningPayload(signing,'not JSON').error!,/valid JSON/);
  const outer={_signed_payload:'<provided by your connected client>',_signature:'<provided by your connected client>'};
  assert.equal(api.directoryRequestBody({iri:'urn:outer'},outer,'validate').includes('course_iri'),false,
    'local body is independent from generic runner envelopes');
});

test('actual telemetry usage counts remain visible while token credentials stay protected',()=>{
  const usage={input_tokens:124,output_tokens:35,cached_input_tokens:80,total_tokens:159};
  for(const field of Object.keys(usage))assert.equal(api.isCredentialField(field),false,field+' is a measurement, not a secret');
  assert.deepEqual(api.redactCredentials({usage}),{usage});
  assert.deepEqual(JSON.parse(api.directoryRequestBody({iri:'urn:usage'},{usage},'validate')).payload,{usage});
  for(const field of ['token','access_token','refresh_token','session_token','caller_token','custom_token']){
    assert.equal(api.isCredentialField(field),true,field);
    assert.throws(()=>api.directoryRequestBody({iri:'urn:action'},{[field]:'RAW-TOKEN'},'validate'),/Raw credentials/);
  }
});
