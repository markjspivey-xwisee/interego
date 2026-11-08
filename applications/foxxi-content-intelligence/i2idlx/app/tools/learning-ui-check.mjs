// Local developer fixture: actual React hooks; synthetic providers and model only.
// Default prepares HTML. --serve starts a localhost preview for CUA inspection.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..'),repo=resolve(app,'../../../..');
const assets=resolve(process.env.I2IDLX_UI_ASSETS||join(app,'../.cache/ui-oracle-assets'));
const output=resolve(repo,'.local/learning-ui-fixture');
const modules={
  'data.js':'export const C=[],SOURCES=[],ACTIONS={},COLLECTIONS={field:[],type:[],curated:[]},META={scheme:{title:"Fixture glossary"},release:"fixture",counts:{canonicalConcepts:0,authoredConcepts:0}};export const byId=new Map(),kindById=new Map(),typeById=new Map(),fieldById=new Map(),roleById=new Map(),enactByConcept=new Map(),mapsByConcept=new Map(),inhByConcept=new Map(),conceptsByAction=new Map();export const iriOf=x=>x,shortestPaths=()=>[],relationBetween=()=>null,systemLabel=x=>x;',
  'caps.js':'export const useCaps=()=>window.__fixtureCaps;',
  'search.js':'export const search=()=>[];',
  'util.js':'export const useStored=(key,initial)=>React.useState(initial);',
  'ui.jsx':'export const useUI=()=>({});export const Seg=()=>null;',
  'icons.jsx':'export const Icon=()=>null;',
  'text.jsx':'export const MiniMarkdown=()=>null;',
  'connection.jsx':'export const AIClientTaskLinks=()=>null;',
  'interego-caps.js':[
    'const listeners=new Set();export const subscribeAgentSession=fn=>{listeners.add(fn);fn(window.__fixtureAgent);return()=>listeners.delete(fn);};',
    'export const workbenchConnectionStatus=()=>({agent:window.__fixtureAgent});export const userCourseRequest=(args,signal)=>window.__fixtureOwner(args,signal);',
    'export const learningContextRequest=(args,signal)=>window.__fixtureContext(args,signal);export const userCourseSample=()=>window.__fixtureAgent.state==="connected"?window.__fixtureCaps.sample:null;',
    'window.__fixtureSetAgent=value=>{window.__fixtureAgent=value;for(const fn of listeners)fn(value);};'
  ].join('\n')
};
const entry=[
  'import {useAskEngine} from '+JSON.stringify(join(app,'src/views/ask.jsx'))+';',
  'import {useCourseContext} from '+JSON.stringify(join(app,'src/course-context.jsx'))+';',
  'function Fixture(){const engine=useAskEngine(),course=useCourseContext(engine),[draft,setDraft]=React.useState("What is the safety code?");',
  'window.__fixtureState=()=>({blocked:course.blocked,selected:course.selected?.title||null,turns:engine.turns.map(x=>({role:x.role,content:x.content})),modelCalls:window.__fixture.calls.length,launches:window.__fixture.launches,navigations:window.__fixture.navigations});',
  'return <main><h1>Learning account developer fixture</h1><p>Synthetic accounts, registrations, courses and model. No live services.</p>',
  '<section aria-label="Fixture scenario controls" className="scenarios"><b>Controlled provider scenarios</b>',
  '<button onClick={()=>window.__scenario("alice")}>Fixture: use Alice account</button><button onClick={()=>window.__scenario("bob")}>Fixture: use Bob account</button><button onClick={()=>window.__scenario("anonymous")}>Fixture: expire human sign-in</button>',
  '<button onClick={()=>window.__scenario("revoke-model")}>Fixture: revoke before model reply</button><button onClick={()=>window.__scenario("deny-source")}>Fixture: deny next private retrieval</button>',
  '<button onClick={()=>window.__scenario("delay")}>Fixture: delay next source</button><button onClick={()=>window.__scenario("release")}>Fixture: release delayed source</button>',
  '<button onClick={()=>window.__fixtureSetAgent({state:"connected",connectionId:"fixture-agent-two",monitoring:"ready"})}>Fixture: replace AI recipient</button>',
  '<button onClick={()=>window.__fixtureSetAgent({state:"disconnected"})}>Fixture: remove AI connection</button>',
  '<button onClick={()=>window.__scenario("block-popup")}>Fixture: block next course popup</button><button onClick={()=>window.__scenario("delay-launch")}>Fixture: delay next course launch</button><button onClick={()=>window.__scenario("release-launch")}>Fixture: release delayed launch</button>',
  '<button onClick={()=>window.__scenario("expire-location")}>Fixture: expire next lesson reference</button><button onClick={()=>window.__scenario("managed")}>Fixture: add managed connection</button>',
  '<button onClick={()=>window.__scenario("release-review")}>Fixture: release completed own review</button><button onClick={()=>window.__scenario("unreadable")}>Fixture: mark content unreadable</button>',
  '<button onClick={()=>window.__scenario("permit-notifications")}>Fixture: permit progress signals</button><button onClick={()=>window.__scenario("signal")}>Fixture: receive progress signal</button>',
  '<button onClick={()=>engine.sendGlossary("A glossary question",[])}>Fixture: glossary shortcut</button></section>',
  '<p role="status" data-testid="fixture-scope">{course.blocked?"Private context blocked":"Ask available"} · Selected: {course.selected?.title||"none"} · Model calls: {window.__fixture.calls.length}</p>',
  '{course.panel}<label>Fixture question<input aria-label="Fixture question" value={draft} onChange={e=>setDraft(e.target.value)}/></label>',
  '<div><button disabled={course.blocked||course.loading||engine.busy} onClick={()=>course.send(draft)}>Send fixture question</button><button onClick={course.stop}>Stop fixture question</button></div>',
  '<section aria-label="Fixture conversation">{engine.turns.map((turn,index)=><p key={index} data-testid="fixture-turn">{turn.role}: {turn.content}</p>)}</section></main>;}',
  'ReactDOM.createRoot(document.getElementById("root")).render(<Fixture/>);'
].join('\n');
const result=await build({stdin:{contents:entry,resolveDir:app,sourcefile:'learning-fixture.jsx',loader:'jsx'},bundle:true,write:false,format:'iife',
  jsxFactory:'React.createElement',jsxFragment:'React.Fragment',target:'es2020',
  plugins:[{name:'synthetic-data-and-provider-adapters',setup(api){
    api.onResolve({filter:/(?:^|\/)(data\.js|caps\.js|search\.js|util\.js|ui\.jsx|icons\.jsx|text\.jsx|connection\.jsx|interego-caps\.js)$/},args=>{
      const name=args.path.split('/').pop();return Object.hasOwn(modules,name)?{path:name,namespace:'fixture'}:undefined;
    });
    api.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js'}));
  }}]
});
const bootstrap=`(()=>{
  const expires="2099-01-01T00:00:00.000Z",state=window.__fixture={human:null,calls:[],owner:false,grant:null,delay:false,waiting:[],modelRevoked:false,denySource:false,connectors:[],launches:0,navigations:0,blockPopup:false,delayLaunch:false,launchWaiting:[],expireLocation:false,targeted:false,reviewPolicy:false,reviewReleased:false,unreadable:false,notificationPolicy:false,notificationEnabled:false,signalAt:null,maps:{},mapRevision:0};
  const browserOpen=window.open.bind(window);
  window.open=(url,target,...features)=>{
    if(state.blockPopup&&url==="about:blank"){state.blockPopup=false;return null;}
    const opened=browserOpen(url,target,...features);if(!opened||url!=="about:blank")return opened;
    return {get closed(){return opened.closed;},set opener(value){opened.opener=value;},get document(){return opened.document;},close(){opened.close();},location:{replace(destination){
      const target=new URL(destination,location.origin);
      if(target.origin==="https://cloud.scorm.com"&&target.pathname.startsWith("/api/cloud/registration/launch/")){state.navigations++;document.getElementById("launch-status").textContent="Synthetic course launches requested: "+state.launches+"; opened: "+state.navigations;opened.location.replace("/fixture-course");}
      else opened.location.replace(destination);
    }}};
  };
  const channel=new BroadcastChannel("i2idlx-learning-developer-fixture");
  channel.onmessage=event=>{if(event.data?.kind==="fixture-sign-in"&&["alice","bob"].includes(event.data.human))state.human=event.data.human;};
  window.__fixtureAgent={state:"connected",connectionId:"fixture-agent-one",monitoring:"ready"};
  const account=()=>({id:"did:web:fixture.invalid:users:"+state.human,userId:state.human,webId:"https://fixture.invalid/users/"+state.human});
  const link=()=>({id:(state.human==="alice"?"a":"b").repeat(32),connector_id:"c".repeat(32),provider_label:"Fixture learning provider",status:"active"});
  const course=()=>({id:state.human==="alice"?"alice-course":"bob-course",title:state.human==="alice"?"Alice enrolled safety":"Bob enrolled safety",version:3});
  const mapKey=args=>JSON.stringify([args.connector_id,args.course_id,args.version]);
  const fixtureMap=()=>({schema_version:1,course_id:course().id,version:3,release_quiz_review:true,
    instructional_locations:[{id:"safety",label:"Safety code",source_file:"lesson-a.html"}],
    review_items:[{activity_id:"quiz",interaction_id:"safety-code",question_label:"Which safety code did you record?",response_labels:[{response:"B",label:"AMBER14"}],location_ids:["safety"]}],
    objectives:[{id:"record-code",label:"Record the published safety code",competency_iris:[],location_ids:["safety"]}],prerequisites:[]});
  const reviewStatus=()=>!state.reviewPolicy?{status:"not-authorized",count:0,reason:"The connection owner has not permitted AI review."}:!state.reviewReleased?{status:"not-released",count:0,reason:"No owner-released question map is available."}:{status:"available",count:1};
  const ownReview=()=>({...reviewStatus(),observed_at:new Date().toISOString(),records:reviewStatus().status==="available"?[{citation_id:"QR1",activity_id:"quiz",interaction_id:"safety-code",question_label:"Which safety code did you record?",learner_response:"B",learner_response_label:"AMBER14",result:"incorrect",submission:"completed",observed_at:new Date().toISOString(),locations:[{id:"safety",label:"Safety code",source_file:"lesson-a.html"}]}]:[]});
  const notificationStatus=()=>({available:state.notificationPolicy,enabled:state.notificationPolicy&&state.notificationEnabled,notice:"Synthetic signal status only. Refresh reads current provider facts; no AI request is made.",...(state.signalAt?{last_received_at:state.signalAt}:{})});
  const snapshot=(args,map)=>({map,provenance:{kind:"connector-owner-authored",owner:account().id,connector_id:args.connector_id,saved_at:new Date().toISOString(),revision:(++state.mapRevision).toString(16).padStart(32,"0"),sha256:"6".repeat(64)}});
  const mapProjection=()=>state.reviewReleased?{status:"owner-supplied",revision:"1".repeat(32),sha256:"6".repeat(64),saved_at:new Date().toISOString(),provider_prerequisites:"unavailable",objectives:fixtureMap().objectives,prerequisites:[]}:{status:"unavailable",provider_prerequisites:"unavailable",objectives:[],prerequisites:[]};
  const fail=(code,status=403)=>Object.assign(new Error(code),{code,status});
  const packet=(args,owner=false)=>{
    const title=owner?"Owner inspection course":course().title,body=owner?"OWNER37":state.human==="alice"?"BLUE27":"GREEN18";
    return {source:{provider:"scorm-cloud",course_id:args.course_id,title,version:args.version,source_version:"course-version:"+args.version,projection_sha256:"d".repeat(64),fingerprint_scope:"selected-instructional-projection"},
      access:{link_id:args.link_id,sharing:{content:args.share_content,progress:args.share_progress,review:args.share_review===true}},
      interventionContext:{kind:"instructional-source-reference",source_context:{source:"package",id:args.course_id,version:"course-version:"+args.version,sections:args.share_content?[{citation_id:"SC1",title:"Safety code",body}]:[]},...(args.share_review?{quiz_review:ownReview()}:{}),...(args.share_progress?{progress:{completion:"COMPLETED",success:"PASSED",score:73,observed_at:new Date().toISOString()}}:{})},
      ...(args.share_review?{quiz_review:ownReview()}:{}),learning_map:mapProjection(),
      citations:args.share_content?[{id:"SC1",title:"Safety code",body}]:[],missing_context:[],authorization_ticket:"e".repeat(64),
      navigation:{course:{kind:"course"},locations:args.share_content?[{citation_id:"SC1",source_file:"lesson-a.html",precision:"published-file",target_kind:state.targeted?"activity":"course",...(state.targeted?{location_ref:"4".repeat(64),title:"Beacon fault lesson"}:{})}]:[]}};
  };
  const reply=value=>Promise.resolve(new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}}));
  window.fetch=async(input,init={})=>{
    const path=new URL(typeof input==="string"?input:input.url,location.origin).pathname;
    if(path==="/i2idlx/learning/session")return reply({enabled:true,authenticated:!!state.human,account:state.human?account():null,csrf:state.human?"c".repeat(64):null,expires_at:state.human?expires:null,sign_in_url:"/i2idlx/learning/oauth/start"});
    if(path==="/i2idlx/learning/sign-out"){state.human=null;return reply({signed_out:true});}
    if(path==="/i2idlx/api/learning/launch"){
      const args=JSON.parse(init.body||"{}");if(!state.human)return new Response(JSON.stringify({code:"learning_sign_in_required"}),{status:401});
      if(args.link_id!==link().id||args.course_id!==course().id||args.version!==course().version)return new Response(JSON.stringify({code:"learning_enrollment_required"}),{status:403});
      if(args.location_ref&&state.expireLocation){state.expireLocation=false;return new Response(JSON.stringify({code:"learning_launch_location_expired"}),{status:403});}
      if(args.location_ref&&!state.targeted)return new Response(JSON.stringify({code:"learning_targeted_launch_not_allowed"}),{status:403});
      state.launches++;document.getElementById("launch-status").textContent="Synthetic course launches requested: "+state.launches+"; opened: "+state.navigations;
      if(state.delayLaunch){state.delayLaunch=false;await new Promise(resolve=>state.launchWaiting.push(resolve));}
      return reply({launch_url:"https://cloud.scorm.com/api/cloud/registration/launch/12345678-abcd-1234-abcd-123456789abc",expires_at:new Date(Date.now()+120000).toISOString(),
        destination:{kind:args.location_ref?"activity":"course",title:args.location_ref?"Beacon fault lesson":course().title,...(args.location_ref?{source_file:"lesson-a.html"}:{})},tracking:true,notice:"Synthetic launch only. Normal SCORM Cloud launches track your registration; Cloud controls resume position and version changes."});
    }
    if(path!=="/i2idlx/api/learning")throw Error("Fixture refuses an unmocked network request.");
    const args=JSON.parse(init.body||"{}");if(!state.human)return new Response(JSON.stringify({code:"learning_sign_in_required"}),{status:401});
    if(args.operation==="my-links")return reply({links:[link()]});
    if(args.operation==="courses")return reply({link_id:args.link_id,courses:[course()],prerequisites:{status:"unavailable"},curriculum:{status:"unavailable"}});
    if(args.operation==="progress")return reply({link_id:args.link_id,as_of:new Date().toISOString(),records:[{course_id:course().id,title:course().title,version:3,completion:"COMPLETED",success:"PASSED",score:73,total_seconds:90,source:"SCORM Cloud",observed_at:new Date().toISOString(),quiz_review:reviewStatus()}]});
    if(args.operation==="course-readiness")return reply({link_id:args.link_id,course_id:args.course_id,version:args.version,readiness:{course_id:args.course_id,version:args.version,checked_at:new Date().toISOString(),enrollment:{status:"verified",observed_at:new Date().toISOString()},content:{status:state.unreadable?"unavailable":"readable",...(state.unreadable?{reason:"This synthetic course has no readable published instructional files."}:{})},quiz_review:reviewStatus(),launch:{kind:state.targeted?"lesson":"course",reason:state.targeted?"Exact published activity mapping is permitted.":"The owner has not enabled targeted lesson launches."},learning_map:mapProjection(),retention:{mode:"virtual",cached_bytes:0,course_text_retained:false}}});
    if(args.operation==="quiz-review")return reply({link_id:args.link_id,course_id:args.course_id,version:args.version,quiz_review:ownReview()});
    if(["progress-notification-status","enable-progress-notifications","disable-progress-notifications"].includes(args.operation)){
      if(args.operation==="enable-progress-notifications")state.notificationEnabled=true;
      if(args.operation==="disable-progress-notifications")state.notificationEnabled=false;
      return reply({link_id:args.link_id,course_id:args.course_id,version:args.version,notifications:notificationStatus()});
    }
    if(args.operation==="owned-connectors")return reply({connectors:state.connectors});
    if(args.operation==="owned-courses")return reply({courses:[course(),{id:"preparation",title:"Preparation",version:1}]});
    if(args.operation==="get-course-map")return reply({course_map:state.maps[mapKey(args)]||null});
    if(args.operation==="preview-course-map")return reply({valid:true,sha256:"6".repeat(64),map:args.map});
    if(args.operation==="save-course-map"){
      const saved=snapshot(args,args.map);state.maps[mapKey(args)]=saved;state.reviewReleased=args.map.release_quiz_review;
      return reply({course_map:saved});
    }
    if(args.operation==="delete-course-map"){delete state.maps[mapKey(args)];state.reviewReleased=false;return reply({course_map:null,deleted:true});}
    if(args.operation==="set-review-policy"||args.operation==="set-notification-policy"){
      const name=args.operation==="set-review-policy"?"allowAiReview":"allowProgressNotifications";
      if(name==="allowAiReview")state.reviewPolicy=args[name];else{state.notificationPolicy=args[name];if(!state.notificationPolicy)state.notificationEnabled=false;}
      state.connectors=state.connectors.map(connector=>connector.id===args.connector_id?{...connector,policy:{...connector.policy,[name]:args[name]}}:connector);
      return reply({connector:state.connectors.find(connector=>connector.id===args.connector_id)});
    }
    if(args.operation==="set-targeted-launch-policy"){
      state.targeted=args.allowTargetedLaunch;state.connectors=state.connectors.map(connector=>connector.id===args.connector_id?{...connector,policy:{...connector.policy,allowTargetedLaunch:state.targeted}}:connector);
      return reply({connector:state.connectors.find(connector=>connector.id===args.connector_id)});
    }
    if(args.operation==="create-connector"){
      const connector={id:"f".repeat(32),label:args.label,status:"active",created_at:expires,join_code:"9".repeat(48),policy:args.policy,lti:{state:"installing",settings:null}};
      state.connectors=[connector];return reply({connector});
    }
    if(args.operation==="pending-links")return reply({links:[{id:"8".repeat(32),account:{id:"did:web:fixture.invalid:users:bob",webId:"https://fixture.invalid/users/bob"},status:"approved",requested_at:expires}]});
    throw Error("Fixture operation is not implemented: "+args.operation);
  };
  window.__fixtureContext=async args=>{
    if(!state.human)throw fail("learning_sign_in_required",401);
    if(state.denySource){state.denySource=false;state.human=null;throw fail("learning_sign_in_required",401);}
    if(args.link_id!==link().id||args.course_id!==course().id)throw fail("learning_link_not_found",404);
    if(args.share_content&&state.unreadable)throw fail("learning_content_unavailable",422);
    if(args.share_review&&reviewStatus().status!=="available")throw fail("learning_review_not_allowed");
    const result=packet(args);if(state.delay){state.delay=false;await new Promise(resolve=>state.waiting.push(resolve));}return result;
  };
  window.__fixtureOwner=async args=>{
    if(args.operation==="status")return {connected:state.owner,provider:"scorm-cloud",connection_id:"owner-connection",expires_at:expires};
    if(args.operation==="connect"){state.owner=true;return {connected:true,provider:"scorm-cloud",connection_id:"owner-connection",expires_at:expires};}
    if(args.operation==="courses")return {connection_id:"owner-connection",courses:[{id:"owner-course",title:"Owner inspection course",version:2,standard:"SCORM 2004",access_modes:["virtual"]}]};
    if(args.operation==="access-status")return {connection_id:"owner-connection",course_id:args.course_id,version:args.version,grant:null,cache:{present:false}};
    if(args.operation==="grant"){state.grant={id:"owner-grant",mode:args.mode,authority:args.permission.authority,verification:"user-attested",expires_at:expires};return {grant:state.grant,cache:{present:false}};}
    if(args.operation==="source"){const result=packet({...args,share_content:true,share_progress:false},true);delete result.authorization_ticket;result.connection_id="owner-connection";result.access={mode:"virtual",permission:state.grant,cache:{present:false},graph:{representation:"none"}};return result;}
    if(args.operation==="disconnect"){state.owner=false;return {connected:false,lti_cleanup:{removed:true}};}
    throw Error("Fixture owner operation is not implemented.");
  };
  const sample=async(messages,options={})=>{
    state.calls.push({messages,hasTicket:!!options.learningAuthorization,ticketInMessages:JSON.stringify(messages).includes("e".repeat(64))});
    if(options.learningAuthorization&&state.modelRevoked){state.modelRevoked=false;throw fail("learning_access_revoked");}
    const text=JSON.stringify(messages).includes("AMBER14")?"Your released record says AMBER14 was marked incorrect [QR1]. Review the Safety code section; no answer key was supplied.":JSON.stringify(messages).includes("BLUE27")?"Answer grounded in BLUE27 [SC1].":JSON.stringify(messages).includes("GREEN18")?"Answer grounded in GREEN18 [SC1].":JSON.stringify(messages).includes("OWNER37")?"Owner answer OWNER37 [SC1].":"Glossary fixture answer.";
    options.onText?.({text});return {text};
  };
  sample.limits=async()=>({tools:false});sample.contextKey="fixture-recipient";window.__fixtureCaps={sample,tools:false,allNotes:[]};
  window.__scenario=kind=>{
    if(kind==="alice"||kind==="bob")state.human=kind;if(kind==="anonymous")state.human=null;
    if(kind==="revoke-model")state.modelRevoked=true;if(kind==="deny-source")state.denySource=true;
    if(kind==="delay")state.delay=true;if(kind==="release")state.waiting.splice(0).forEach(resolve=>resolve());
    if(kind==="block-popup")state.blockPopup=true;if(kind==="delay-launch")state.delayLaunch=true;if(kind==="release-launch")state.launchWaiting.splice(0).forEach(resolve=>resolve());
    if(kind==="expire-location")state.expireLocation=true;
    if(kind==="managed")state.connectors=[{id:"f".repeat(32),label:"Synthetic managed connection",status:"active",created_at:expires,join_code:"9".repeat(48),policy:{allowAiContent:true,allowAiProgress:true,allowAiReview:state.reviewPolicy,allowProgressNotifications:state.notificationPolicy,allowTargetedLaunch:state.targeted}}];
    if(kind==="release-review"){state.reviewPolicy=true;state.reviewReleased=true;}
    if(kind==="unreadable")state.unreadable=true;
    if(kind==="permit-notifications")state.notificationPolicy=true;
    if(kind==="signal")state.signalAt=new Date().toISOString();
    document.getElementById("scenario-status").textContent="Fixture provider state: "+(state.human||"signed out")+"; "+kind;
  };
})();`;
new Script(bootstrap, { filename: 'learning-fixture-bootstrap.js' });
const scripts=await Promise.all([
  readFile(join(assets,'cdnjs.cloudflare.com_ajax_libs_react_18.3.1_umd_react.production.min.js'),'utf8'),
  readFile(join(assets,'cdnjs.cloudflare.com_ajax_libs_react-dom_18.3.1_umd_react-dom.production.min.js'),'utf8')
]);
const html='<!doctype html><meta charset="utf-8"><title>Learning hook fixture</title><style>body{font:15px system-ui;color:#142434;margin:24px auto;max-width:980px}button,input,select{font:inherit;margin:4px;padding:7px}label{display:block}.stack{display:flex;flex-direction:column;gap:8px}.row{display:flex;gap:8px}.note,details{border:1px solid #b5c6d2;border-radius:7px;padding:12px;margin:10px 0}.small{font-size:14px}.warn{color:#8a210b}.scenarios{border:2px dashed #75879b;padding:12px}.scenarios button{font-size:12px}pre{white-space:pre-wrap}</style><p id="scenario-status">Fixture provider state: signed out</p><p id="launch-status">Synthetic course launches requested: 0; opened: 0</p><div id="root"></div>'+
  scripts.map(script=>'<script>'+script.replaceAll('</script','<\\/script')+'</script>').join('')+
  '<script>'+bootstrap.replaceAll('</script','<\\/script')+'</script><script>'+result.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script>';
await mkdir(output,{recursive:true});await writeFile(join(output,'index.html'),html);
process.stdout.write('Prepared actual-hook developer fixture: '+join(output,'index.html')+'\n');
// Mount the actual production React bundle with an ordinary signed-out session.
// This catches lifecycle/render errors that a small hook implementation can miss.
const mountErrors=[],virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>mountErrors.push(error.message));
const mounted=new JSDOM(html,{runScripts:'dangerously',url:'http://127.0.0.1:43811/',virtualConsole,beforeParse(window){
  window.BroadcastChannel=class {postMessage(){}close(){}};
  window.Response=Response;window.AbortController=AbortController;window.TextEncoder=TextEncoder;
}});
try {
  for(let count=0;count<30&&!Array.from(mounted.window.document.querySelectorAll('button')).some(button=>button.textContent==='Connect your Interego learning account');count++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(mountErrors,[],'Actual React fixture must mount without uncaught errors.');
  assert.ok(Array.from(mounted.window.document.querySelectorAll('button')).some(button=>button.textContent==='Connect your Interego learning account'),'Signed-out actual React fixture must offer ordinary learning sign-in.');
  assert.equal(mounted.window.__fixture.calls.length,0,'Mounting must not call the model.');
  process.stdout.write('PASS actual React signed-out mount with null account; no model request\n');
} finally {mounted.window.close();}
if(process.argv.includes('--serve')){
  const server=createServer((req,res)=>{
    if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(req.url==='/fixture-course'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end('<!doctype html><title>Synthetic course launch</title><h1>Synthetic course opened</h1><p>No SCORM Cloud request was made. The fixture replaced the test capability with this local page.</p>');return;}
    if(req.url==='/i2idlx/learning/oauth/start'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      res.end('<!doctype html><title>Synthetic Interego sign-in</title><h1>Fixture sign-in</h1><p>These are synthetic test accounts. No credentials are requested.</p><button onclick="complete(\'alice\')">Complete fixture sign-in as Alice</button><button onclick="complete(\'bob\')">Complete fixture sign-in as Bob</button><script>const channel=new BroadcastChannel("i2idlx-learning-developer-fixture");function complete(human){channel.postMessage({kind:"fixture-sign-in",human});setTimeout(()=>window.close(),100);}</script>');return;
    }
    if(req.url!=='/'){res.writeHead(404);res.end('Only the fixture page is served.');return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"});res.end(html);
  });
  server.listen(Number(process.env.I2IDLX_FIXTURE_PORT||43811),'127.0.0.1',()=>process.stdout.write('Local fixture ready: http://127.0.0.1:'+server.address().port+'/\n'));
}
