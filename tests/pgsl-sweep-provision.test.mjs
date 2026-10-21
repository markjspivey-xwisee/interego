import assert from 'node:assert/strict';
import test from 'node:test';
import {SWEEP_TARGET,provisionSweepToken} from '../tools/pgsl-sweep-provision.mjs';
const token='fixture-private-token-never-log';
function backend({project=SWEEP_TARGET.projectId,environment=SWEEP_TARGET.environmentId,
 id=SWEEP_TARGET.serviceId,name=SWEEP_TARGET.serviceName,mutation=true,remoteError=false}={}){
 const calls=[];
 const gql=async(query,variables)=>{
  calls.push({query,variables});
  if(remoteError)throw Error(token);
  if(query.includes('projectToken'))return{projectToken:{projectId:project,environmentId:environment}};
  if(query.startsWith('query'))return{project:{services:{edges:[{node:{id,name}}]}}};
  return{variableUpsert:mutation};
 };
 return{calls,gql};
}
test('writes exactly the reviewed token variable with skipDeploys and returns no token',async()=>{
 const b=backend(),result=await provisionSweepToken({token,gql:b.gql});
 assert.equal(b.calls.length,3);
 assert.deepEqual(b.calls[2].variables,{input:{projectId:SWEEP_TARGET.projectId,environmentId:SWEEP_TARGET.environmentId,
  serviceId:SWEEP_TARGET.serviceId,name:'RAILWAY_PROJECT_TOKEN',value:token,skipDeploys:true}});
 assert.ok(b.calls.every(c=>!c.query.includes('variables(')&&!c.query.includes('variableCollectionUpsert')));
 assert.equal(JSON.stringify(result).includes(token),false);
});
for(const[description,options]of[
 ['wrong project',{project:'not-the-reviewed-project'}],
 ['wrong environment',{environment:'not-the-reviewed-environment'}],
 ['wrong service ID',{id:'not-the-reviewed-service'}],
 ['wrong service name',{name:'postgres'}],
]){
 test(description+' refuses before any variable write',async()=>{
  const b=backend(options);
  await assert.rejects(provisionSweepToken({token,gql:b.gql}),/handoff refused/);
  assert.ok(b.calls.every(c=>!c.query.startsWith('mutation')));
 });
}
test('missing token makes no API call',async()=>{
 const b=backend();await assert.rejects(provisionSweepToken({token:'',gql:b.gql}),/handoff refused/);assert.equal(b.calls.length,0);
});
test('failed mutation is not reported as successful',async()=>{
 const b=backend({mutation:false});await assert.rejects(provisionSweepToken({token,gql:b.gql}),/handoff refused/);
});
test('raw API errors containing a secret are redacted',async()=>{
 const b=backend({remoteError:true});let failure;
 try{await provisionSweepToken({token,gql:b.gql});}catch(error){failure=error;}
 assert.ok(failure);assert.equal(failure.message.includes(token),false);assert.equal(failure.cause,undefined);
});
