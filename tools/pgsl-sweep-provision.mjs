/**
 * Trusted-master runner only: copy the existing GitHub secret to one reviewed
 * private Railway service without exposing its value or deploying that service.
 */
import {pathToFileURL} from 'node:url';
export const SWEEP_TARGET=Object.freeze({
 projectId:'b88ceabb-7461-4949-81d7-3d29132e7806',
 environmentId:'449996a2-3533-462f-98c6-4ab4c05dd777',
 serviceId:'549ce5f1-297c-42b0-9c1a-7e1ff977ff2b',
 serviceName:'pgsl-private-sweep',
});
export async function provisionSweepToken({token,gql}){
 try{
  if(typeof token!=='string'||!token||typeof gql!=='function'||!/^[0-9a-f-]{36}$/.test(SWEEP_TARGET.serviceId))throw Error();
  const identity=await gql('{projectToken{projectId environmentId}}');
  if(identity?.projectToken?.projectId!==SWEEP_TARGET.projectId||identity?.projectToken?.environmentId!==SWEEP_TARGET.environmentId)throw Error();
  const project=await gql('query($p:String!){project(id:$p){services{edges{node{id name}}}}}',{p:SWEEP_TARGET.projectId});
  const matches=(project?.project?.services?.edges??[]).map(e=>e.node).filter(n=>n.id===SWEEP_TARGET.serviceId);
  if(matches.length!==1||matches[0].name!==SWEEP_TARGET.serviceName)throw Error();
  const result=await gql('mutation($input:VariableUpsertInput!){variableUpsert(input:$input)}',{input:{
   projectId:SWEEP_TARGET.projectId,environmentId:SWEEP_TARGET.environmentId,serviceId:SWEEP_TARGET.serviceId,
   name:'RAILWAY_PROJECT_TOKEN',value:token,skipDeploys:true,
  }});
  if(result?.variableUpsert!==true)throw Error();
  return{serviceId:SWEEP_TARGET.serviceId,variableNames:['RAILWAY_PROJECT_TOKEN'],skippedDeploys:true};
 }catch{
  throw Error('Private sweep token handoff refused; no secret or API response is logged.');
 }
}
async function main(){
 const token=process.env.RAILWAY_PROJECT_TOKEN;
 const gql=async(query,variables={})=>{
  const response=await fetch('https://backboard.railway.com/graphql/v2',{method:'POST',
   headers:{'Content-Type':'application/json','Project-Access-Token':token},
   body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(10000)});
  const body=await response.json();
  if(!response.ok||body.errors?.length)throw Error('Railway request refused');
  return body.data;
 };
 await provisionSweepToken({token,gql});
 console.log('Private sweep token handed off without deployment.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main().catch(()=>{console.error('Private sweep token handoff failed; no secret or API response is logged.');process.exitCode=1;});
}
