import {pathToFileURL} from "node:url";
function requireConfirmed(checkpoint,owner){
 const state=checkpoint?.state;
 if(!Number.isSafeInteger(checkpoint?.version)||checkpoint.version<1||!state||
 state.owner!==owner||state.schema!=="urn:bridge:owned-state-checkpoint:v1"||
 !/^sha256:[0-9a-f]{64}$/.test(state.digest??"")||!state.value||
 !state.value.worlds||typeof state.value.worlds!=="object"||Array.isArray(state.value.worlds)||
 !state.value.season||typeof state.value.season!=="object")
 throw Error("Confirmed native checkpoint required");
 return {version:checkpoint.version,checkpointDigest:state.digest};
}
if(process.env.PGSL_RESTART_GATE_FIXTURE==="1"){
 const valid={version:7,state:{owner:"did:test:retained",schema:"urn:bridge:owned-state-checkpoint:v1",digest:"sha256:"+"a".repeat(64),value:{worlds:{march:{cn:3}},season:{n:1}}}};
 const assert=(await import("node:assert/strict")).default;
 assert.deepEqual(requireConfirmed(valid,"did:test:retained"),{version:7,checkpointDigest:valid.state.digest});
 for(const invalid of [null,{version:0,state:null},{...valid,state:{...valid.state,owner:"did:test:other"}},{...valid,state:{...valid.state,value:{worlds:{}}}}])
  assert.throws(()=>requireConfirmed(invalid,"did:test:retained"));
 console.log("Native restart gate: existing checkpoint accepted; missing, empty, foreign and incomplete states refused.");
}else{
 try{
  const root=process.cwd(),load=p=>import(pathToFileURL(root+p).href);
  const {prepareGamingEnvironment}=await load("/server/gaming/bootstrap.js");
  const {configuredGamingStore}=await load("/server/gaming/provider.js");
  const env=await prepareGamingEnvironment({...process.env,HM_GAMING_MONITOR_ENABLED:"0"});
  const store=await configuredGamingStore(env);
  if(!store)throw Error("Native service owner required");
  await store.ready();
  const checkpoint=await store.load("hallowmarch-world-season-v1");
  const proof=requireConfirmed(checkpoint,store.owner);
  console.log(JSON.stringify({kind:"native-world-restart-gate",confirmed:true,owner:store.owner,...proof,at:new Date().toISOString()}));
  await load("/server/server.js");
 }catch{
  console.error("Confirmed native world unavailable; startup refused without local JSON-seed migration.");
  process.exitCode=1;
 }
}
