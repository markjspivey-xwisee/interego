import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the actual Actions source, rather than a second selector implementation.
const workflow=readFileSync(new URL('../../../../.github/workflows/i2idlx-ui-oracle.yml',import.meta.url),'utf8');
const block=/ {10}script: \|\n((?: {12}.*\n)+)/.exec(workflow);
assert.ok(block,'the UI workflow must retain its github-script selection block');
const script=block[1]!.split('\n').map(line=>line.slice(12)).join('\n');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor as new (...args:string[]) => (...args:unknown[])=>Promise<void>;
const execute=new AsyncFunction('github','context','core','setTimeout','Date',script);
const repo='markjspivey-xwisee/interego',head='exact-source-head',pr=621,branch='exact-source-branch';
interface Run {
  id:number;name:string;path:string;status:string;conclusion:string|null;head_sha:string;event:string;head_branch:string;
  repository:{full_name:string};head_repository:{full_name:string};pull_requests?:{number:number}[];
}
interface Artifact {id:number;name:string;expired:boolean}
const native=(extra:Partial<Run>={}):Run=>({
  id:101,name:'I2IDL-X bounded native diagnostic',path:'.github/workflows/i2idlx-native-diagnostic.yml',
  status:'completed',conclusion:'success',head_sha:head,event:'pull_request',head_branch:branch,
  repository:{full_name:repo},head_repository:{full_name:repo},pull_requests:[{number:pr}],...extra,
});
const golden=(extra:Partial<Run>={}):Run=>native({
  id:202,name:'I2IDL-X complete golden parity',path:'.github/workflows/i2idlx-golden-parity.yml',
  conclusion:'failure',...extra,
});
const artifact=(run:Run,expired=false):Artifact=>({
  id:1000+run.id,expired,name:(run.name==='I2IDL-X bounded native diagnostic'?
    'i2idlx-native-diagnostic-':'i2idlx-golden-parity-')+run.id,
});
function fixture(options:{
  runs?:(poll:number)=>Run[];
  artifacts?:(id:number,poll:number)=>Artifact[];
  selected?:Run;
  payload?:Record<string,unknown>;
  eventName?:string;
}={}) {
  const outputs:Record<string,string>={},messages:string[]=[],sleeps:number[]=[];
  const calls={polls:0,gets:0,artifacts:[] as number[]};
  let now=0,listed:Run[]=[];
  const github={rest:{actions:{
    listWorkflowRunsForRepo:async(args:{head_sha:string;event:string;per_page:number})=>{
      assert.equal(args.head_sha,head);assert.equal(args.event,'pull_request');assert.equal(args.per_page,100);
      calls.polls++;listed=options.runs?.(calls.polls)??[native()];
      return {data:{workflow_runs:listed}};
    },
    // Without an explicit run, GitHub answers with the listed run of that id, as the API would.
    getWorkflowRun:async(args:{run_id:number})=>{
      calls.gets++;const run=options.selected??listed.find(item=>item.id===args.run_id)??native();
      assert.equal(args.run_id,run.id);
      return {data:run};
    },
    listWorkflowRunArtifacts:async(args:{run_id:number;per_page:number})=>{
      assert.equal(args.per_page,100);calls.artifacts.push(args.run_id);
      return {data:{artifacts:options.artifacts?.(args.run_id,calls.polls)??[artifact(options.selected??native())]}};
    },
  }}};
  const context={
    repo:{owner:'markjspivey-xwisee',repo:'interego'},sha:'default-branch-head',
    eventName:options.eventName??(options.payload?.inputs===undefined?'pull_request':'workflow_dispatch'),
    // A real pull_request payload names the head's branch and repository as well as its commit.
    payload:options.payload??{pull_request:{number:pr,head:{sha:head,ref:branch,repo:{full_name:repo}}}},
  };
  const core={setOutput:(key:string,value:string)=>{outputs[key]=value;},info:(message:string)=>{messages.push(message);}};
  const timer=(resolve:()=>void,delay:number)=>{sleeps.push(delay);now+=delay;resolve();return 0;};
  const completion=execute(github,context,core,timer,{now:()=>now});
  return {completion,outputs,messages,sleeps,calls};
}

test('automatic PR selection waits for completion and retained artifact, then emits exact source receipts',async()=>{
  const h=fixture({
    runs:poll=>[native(poll===1?{status:'in_progress',conclusion:null}:{})],
    artifacts:(_id,poll)=>poll<3?[]:[artifact(native())],
  });
  await h.completion;
  assert.deepEqual(h.sleeps,[30_000,30_000]);
  assert.equal(h.calls.polls,3);
  assert.equal(h.messages.filter(message=>message.startsWith('Waiting for completed outputs')).length,2);
  assert.deepEqual(h.outputs,{
    run_id:'101',artifact_name:'i2idlx-native-diagnostic-101',artifact_id:'1101',
    head_sha:head,kind:'native-diagnostic',conclusion:'success',
  });
});
test('expired artifacts and completed producers from another head never become eligible',async()=>{
  const other=native({id:303,head_sha:'other-source-head'});
  const h=fixture({
    runs:()=>[other,native()],
    artifacts:id=>[artifact(id===other.id?other:native(),id===101)],
  });
  await assert.rejects(h.completion,/No completed native or golden outputs.*bounded wait/);
  assert.ok(h.calls.artifacts.every(id=>id===101),'wrong-head artifacts are never inspected');
  assert.equal(h.calls.gets,0);
  assert.deepEqual(h.outputs,{});
  assert.equal(h.sleeps.reduce((sum,ms)=>sum+ms,0),8*60_000);
});
test('no eligible producer stops after eight virtual minutes with thirty-second heartbeats',async()=>{
  const h=fixture({runs:()=>[native({status:'in_progress',conclusion:null})]});
  await assert.rejects(h.completion,/No completed native or golden outputs.*bounded wait/);
  assert.equal(h.calls.polls,17);
  assert.equal(h.sleeps.length,16);
  assert.ok(h.sleeps.every(ms=>ms===30_000));
  assert.equal(h.calls.gets,0);assert.deepEqual(h.calls.artifacts,[]);
  assert.deepEqual(h.outputs,{});
});
test('completed golden outputs remain the fallback and successful native outputs retain priority',async()=>{
  for(const success of [false,true]){
    const n=native({conclusion:success?'success':'failure'}),g=golden(),selected=success?n:g;
    const h=fixture({
      runs:()=>[g,n],selected,
      artifacts:id=>[artifact(id===n.id?n:g)],
    });
    await h.completion;
    assert.equal(h.outputs.kind,success?'native-diagnostic':'golden');
    assert.equal(h.outputs.run_id,String(selected.id));
    assert.deepEqual(h.sleeps,[]);
  }
});
test('automatic selection preserves final repository, fork, workflow, head, branch and PR guards',async()=>{
  for(const [check,extra] of [
    ['repository',{repository:{full_name:'foreign/repo'}}],
    ['head_repository',{head_repository:{full_name:'foreign/fork'}}],
    ['path',{path:'.github/workflows/foreign.yml'}],
    ['head_sha',{head_sha:'other-source-head'}],
    ['event',{event:'push'}],
    ['head_branch',{head_branch:'other-branch'}],
    ['pull_requests',{pull_requests:[{number:999}]}],
  ] satisfies [string,Partial<Run>][]){
    const h=fixture({selected:native(extra)});
    await assert.rejects(h.completion,/does not belong to the expected repository, workflow and source head/);
    assert.deepEqual(h.outputs,{});assert.deepEqual(h.sleeps,[]);
    assert.equal(h.messages.filter(message=>message.startsWith('Selected run 101 excluded by '+check+': ')).length,1,h.messages.join('\n'));
  }
});
const nativePath='.github/workflows/i2idlx-native-diagnostic.yml';
const noOutputsFirst='No completed native or golden outputs are available for this exact head within the bounded wait.';
const noOutputs=noOutputsFirst+' Retry only this UI job after native outputs are uploaded.';
const noRetry=' Retrying only this UI job will not help: every run found fails an identity check.';
const rejection=async(completion:Promise<void>)=>completion.then(()=>assert.fail('expected the selection to fail'),(error:Error)=>error);
const excludedLine=(messages:string[],id:number,check:string)=>
  messages.filter(message=>new RegExp('^Candidate run '+id+' \\(.*\\) excluded by '+check+': ').test(message));
test('a later golden candidate meeting every check is selected when the first native candidate is not associated with this PR',async()=>{
  // The peer-review case: the native candidate has a retained artifact, but is not this PR's run.
  for(const [check,extra] of [
    ['pull_requests',{pull_requests:[{number:999}]}],
    ['head_branch',{pull_requests:[],head_branch:'other-branch'}],
  ] satisfies [string,Partial<Run>][]){
    const n=native(extra),g=golden();
    const h=fixture({runs:()=>[n,g],artifacts:id=>[artifact(id===n.id?n:g)]});
    await h.completion;
    assert.deepEqual(h.outputs,{
      run_id:'202',artifact_name:'i2idlx-golden-parity-202',artifact_id:'1202',
      head_sha:head,kind:'golden',conclusion:'failure',
    });
    assert.equal(h.calls.polls,1);assert.deepEqual(h.sleeps,[]);assert.equal(h.calls.gets,1);
    assert.deepEqual(h.calls.artifacts,[202,202],'the excluded run needs no artifact listing; the receipt check still lists the selected run');
    assert.equal(excludedLine(h.messages,101,check).length,1,h.messages.join('\n'));
  }
});
test('each candidate excluded by one check is never selected, and the log names the run and that check',async()=>{
  // Each run-level case keeps a retained artifact, so only the named check can exclude it.
  const retained=(run:Run)=>[artifact(run)];
  const cases:[string,Run,'run'|'artifact',(run:Run)=>Artifact[]][]=[
    ['path',native({id:111,path:'.github/workflows/foreign.yml'}),'run',retained],
    ['repository',native({id:112,repository:{full_name:'foreign/repo'}}),'run',retained],
    ['head_repository',native({id:113,head_repository:{full_name:'foreign/fork'}}),'run',retained],
    ['head_sha',native({id:114,head_sha:'other-source-head'}),'run',retained],
    ['pull_requests',native({id:116,pull_requests:[{number:999}]}),'run',retained],
    ['pull_requests',native({id:126,pull_requests:[{number:999},{number:998}]}),'run',retained],
    ['status',native({id:117,status:'in_progress',conclusion:null}),'run',retained],
    ['conclusion',native({id:118,conclusion:'failure'}),'run',retained],
    ['conclusion',native({id:119,conclusion:'cancelled'}),'run',retained],
    ['artifact',native({id:120}),'artifact',()=>[]],
    ['artifact',native({id:121}),'artifact',run=>[artifact(run,true)]],
    ['artifact',native({id:122}),'artifact',()=>[artifact(golden({id:122}))]],
    ['event',native({id:123,event:'push'}),'run',retained],
    ['head_branch',native({id:124,head_branch:'other-branch'}),'run',retained],
    ['head_branch',native({id:125,head_branch:'other-branch',pull_requests:[]}),'run',retained],
    ['path',golden({id:211,path:nativePath}),'run',retained],
    ['pull_requests',golden({id:212,pull_requests:[{number:999}]}),'run',retained],
    ['status',golden({id:213,status:'queued',conclusion:null}),'run',retained],
    ['artifact',golden({id:214}),'artifact',run=>[artifact(run,true)]],
    ['head_branch',golden({id:215,head_branch:'other-branch'}),'run',retained],
  ];
  for(const [check,bad,stage,badArtifacts] of cases){
    const g=golden();
    const h=fixture({
      runs:()=>[bad,g],
      artifacts:id=>id===g.id?[artifact(g)]:badArtifacts(bad),
    });
    await h.completion;
    assert.equal(h.outputs.run_id,'202',check+' must exclude run '+bad.id);
    assert.equal(h.outputs.kind,'golden');
    assert.equal(excludedLine(h.messages,bad.id,check).length,1,'log names run '+bad.id+' and '+check+':\n'+h.messages.join('\n'));
    assert.deepEqual(h.calls.artifacts,stage==='run'?[202,202]:[bad.id,202,202]);
  }
});
test('when nothing is eligible within the bounded wait, the error keeps its text and adds each candidate exclusion',async()=>{
  const h=fixture({runs:()=>[golden({status:'in_progress',conclusion:null}),native({pull_requests:[{number:999}]})]});
  const error=await rejection(h.completion);
  assert.equal(error.message,noOutputs+' Last check excluded run 101 by pull_requests, run 202 by status.');
  assert.equal(h.calls.polls,17);assert.equal(h.sleeps.length,16);assert.ok(h.sleeps.every(ms=>ms===30_000));
  assert.deepEqual(h.calls.artifacts,[]);assert.equal(h.calls.gets,0);assert.deepEqual(h.outputs,{});
  assert.equal(excludedLine(h.messages,101,'pull_requests').length,17,'every poll says why each candidate was passed over');
  // Real run ids have 11 digits; head_repository is the longest check name, and an all-identity
  // list carries the longer advice, so this is the longest message the cap allows.
  const many=fixture({runs:()=>Array.from({length:14},(_,i)=>native({id:42951589971+i,head_repository:{full_name:'foreign/fork'}}))});
  const capped=await rejection(many.completion);
  assert.ok(capped.message.startsWith(noOutputsFirst+noRetry+' Last check excluded run 42951589971 by head_repository, '),capped.message);
  assert.match(capped.message,/run 42951589980 by head_repository, and 4 more\.$/);
  assert.doesNotMatch(capped.message,/run 42951589981/);
  assert.ok(capped.message.length<600,'the error stays short: '+capped.message.length);
  const none=fixture({runs:()=>[{...native({id:303}),name:'Unrelated check'}]});
  const empty=await rejection(none.completion);
  assert.equal(empty.message,noOutputs+' Last check found no native or golden build runs for this head.');
  assert.deepEqual(none.messages.filter(message=>message.startsWith('Candidate run')),[],'other workflows are not candidates');
});
test('Actions run 42951589971 replayed: a PR merged while its builds ran keeps them, and the native run is chosen',async()=>{
  // PR #827 was merged two seconds after this step started; from then on GitHub listed no pull
  // request on its build runs. The native run finished 374 seconds in, the golden run after the
  // eight-minute deadline. The step failed at the first check after the native run finished.
  const nativeId=42951590127,goldenId=42951589975;
  const h=fixture({
    runs:poll=>{
      const elapsed=(poll-1)*30_000,pull_requests=poll===1?[{number:pr}]:[];
      return [
        native({id:nativeId,pull_requests,...(elapsed<374_000?{status:'in_progress',conclusion:null}:{})}),
        golden({id:goldenId,pull_requests,status:'in_progress',conclusion:null}),
      ];
    },
    artifacts:id=>id===nativeId?[artifact(native({id}))]:[],
  });
  await h.completion;
  assert.equal(h.calls.polls,14);assert.equal(h.sleeps.length,13);
  assert.deepEqual(h.outputs,{
    run_id:String(nativeId),artifact_name:'i2idlx-native-diagnostic-'+nativeId,artifact_id:String(1000+nativeId),
    head_sha:head,kind:'native-diagnostic',conclusion:'success',
  });
  assert.deepEqual(h.messages.filter(message=>/excluded by (?!status)/.test(message)),[],h.messages.join('\n'));
});
test('a merged or closed PR keeps its own build runs, which GitHub then lists with no pull request',async()=>{
  // GitHub lists only open pull requests on a run; a missing list is read as an empty one.
  const unlisted=native();delete unlisted.pull_requests;
  for(const run of [native({pull_requests:[]}),unlisted]){
    const h=fixture({runs:()=>[run,golden()],artifacts:id=>[artifact(id===101?native():golden())]});
    await h.completion;
    assert.equal(h.outputs.run_id,'101');assert.equal(h.outputs.kind,'native-diagnostic');
    assert.equal(h.calls.polls,1);assert.deepEqual(h.sleeps,[]);assert.equal(h.calls.gets,1);
    assert.deepEqual(h.messages.filter(message=>message.includes('excluded by')),[]);
  }
});
test('a payload that names no head branch binds no build run to the PR',async()=>{
  const unbranched:Partial<Run>=native();delete unbranched.head_branch;
  const h=fixture({payload:{pull_request:{number:pr,head:{sha:head,repo:{full_name:repo}}}},runs:()=>[unbranched as Run]});
  assert.equal((await rejection(h.completion)).message,noOutputsFirst+noRetry+' Last check excluded run 101 by head_branch.');
});
test('a PR whose head is in another repository fails at once, saying a retry will not help',async()=>{
  // A deleted fork leaves the payload's head repository null.
  for(const headRepo of [{full_name:'someone/interego'},null]){
    const h=fixture({
      payload:{pull_request:{number:pr,head:{sha:head,ref:branch,repo:headRepo}}},
      runs:()=>[native({head_repository:{full_name:'someone/interego'}})],
    });
    const error=await rejection(h.completion);
    assert.equal(error.message,"This pull request's head repository is "+(headRepo?.full_name??'missing')+', not '+repo+
      '. The UI oracle uses build outputs only from heads in '+repo+', so a retry will not help.');
    assert.deepEqual(h.calls,{polls:0,gets:0,artifacts:[]});assert.deepEqual(h.sleeps,[]);assert.deepEqual(h.outputs,{});
  }
});
test('when every run found fails an identity check, the bounded-wait error says a retry will not help',async()=>{
  const h=fixture({runs:()=>[native({id:131,head_branch:'other-branch'}),golden({id:232,path:nativePath})]});
  const error=await rejection(h.completion);
  assert.equal(error.message,noOutputsFirst+noRetry+' Last check excluded run 131 by head_branch, run 232 by path.');
  assert.equal(h.calls.polls,17);assert.deepEqual(h.calls.artifacts,[]);
  // A run that can still finish, or still get its artifact, keeps the retry advice.
  for(const [other,check] of [[golden({status:'in_progress',conclusion:null}),'status'],[golden(),'artifact']] as const){
    const mixed=fixture({runs:()=>[native({id:131,head_branch:'other-branch'}),other],artifacts:()=>[]});
    assert.equal((await rejection(mixed.completion)).message,noOutputs+' Last check excluded run 131 by head_branch, run 202 by '+check+'.');
  }
});
test('explicit manual IDs keep their strict immediate checks and existing messages',async()=>{
  const belong=/^Error: Selected build run does not belong to the expected repository, workflow and source head\.$/;
  const different=/^Error: The selected input names a different build workflow\.$/;
  const incomplete=/^Error: The selected build has no complete eligible outputs yet\. Retry only this UI job after its artifact upload; do not restart ontology generation\.$/;
  const unretained=/^Error: The selected run has no retained generated outputs\. Retry only this UI job after artifact upload\.$/;
  const cases:[Record<string,string>,Run,RegExp,Artifact[]?][]=[
    [{native_run_id:'101'},{...native(),name:'Unrelated check'},belong],
    [{native_run_id:'101'},native({path:'.github/workflows/foreign.yml'}),belong],
    [{golden_run_id:'202'},golden({path:nativePath}),belong],
    [{native_run_id:'101'},native({repository:{full_name:'foreign/repo'}}),belong],
    [{native_run_id:'101'},native({head_repository:{full_name:'foreign/fork'}}),belong],
    [{golden_run_id:'101'},native(),different],
    [{native_run_id:'202'},golden(),different],
    [{native_run_id:'101'},native({conclusion:'failure'}),incomplete],
    [{golden_run_id:'202'},golden({status:'in_progress',conclusion:null}),incomplete],
    [{native_run_id:'101'},native(),unretained,[]],
    [{native_run_id:'101'},native(),unretained,[artifact(native(),true)]],
    [{native_run_id:'101'},native(),unretained,[artifact(golden({id:101}))]],
  ];
  for(const [inputs,selected,message,artifacts] of cases){
    const h=fixture({selected,payload:{inputs},artifacts:artifacts&&(()=>artifacts)});
    await assert.rejects(h.completion,message);
    assert.equal(h.calls.polls,0);assert.deepEqual(h.sleeps,[]);assert.deepEqual(h.outputs,{});
  }
  const failed=fixture({selected:native({conclusion:'failure'}),payload:{inputs:{native_run_id:'101'}}});
  await assert.rejects(failed.completion,incomplete);
  assert.deepEqual(failed.messages,['Selected run 101 excluded by conclusion: failure, expected success.']);
  // A manual dispatch has no PR head; a named completed build of this repository is accepted as before.
  for(const [inputs,selected] of [[{golden_run_id:'202'},golden()],[{native_run_id:' 101 '},native({head_sha:'manual-head',pull_requests:[]})]] as const){
    const h=fixture({selected,payload:{inputs},artifacts:()=>[artifact(selected)]});
    await h.completion;
    assert.equal(h.outputs.run_id,String(selected.id));assert.equal(h.outputs.head_sha,selected.head_sha);
    assert.equal(h.calls.polls,0);assert.deepEqual(h.sleeps,[]);
  }
  for(const inputs of [{native_run_id:'101',golden_run_id:'202'},{native_run_id:'latest'}]){
    const h=fixture({payload:{inputs}});
    await assert.rejects(h.completion,/^Error: (Select one native or golden run, not both|A real build workflow run ID is required)\.$/);
    assert.equal(h.calls.gets,0);assert.equal(h.calls.polls,0);
  }
});
test('explicit manual IDs require eligible completed output immediately and never poll',async()=>{
  for(const selected of [native(),native({status:'in_progress',conclusion:null})]){
    const h=fixture({selected,payload:{inputs:{native_run_id:'101'}}});
    if(selected.status==='completed')await h.completion;
    else await assert.rejects(h.completion,/no complete eligible outputs yet/);
    assert.equal(h.calls.polls,0);assert.deepEqual(h.sleeps,[]);
  }
  const missing=fixture({payload:{inputs:{}}});
  await assert.rejects(missing.completion,/Select a completed native or golden workflow run ID/);
  assert.equal(missing.calls.polls,0);assert.deepEqual(missing.sleeps,[]);
});

test('workflow_run cannot attribute unrelated producer outputs to the default-branch commit',async()=>{
  assert.doesNotMatch(workflow,/^ {2}workflow_run:\s*$/m,'automatic producer events are not a UI trigger');
  const h=fixture({
    eventName:'workflow_run',
    payload:{workflow_run:native({head_sha:'unrelated-dependency-head',pull_requests:[]})},
  });
  await assert.rejects(h.completion,/Unsupported UI oracle event: workflow_run/);
  assert.deepEqual(h.calls,{polls:0,gets:0,artifacts:[]},'unsupported events must stop before GitHub API calls');
  assert.deepEqual(h.outputs,{});assert.deepEqual(h.messages,[]);assert.deepEqual(h.sleeps,[]);
});

const paths=(source:string)=>{
  const block=/^ {4}paths:\n((?: {6}- '[^']+'\n)+)/m.exec(source);
  assert.ok(block,'producer and browser workflows must declare PR path dependencies');
  return [...block[1]!.matchAll(/^ {6}- '([^']+)'$/gm)].map(match=>match[1]!);
};
test('the workflow that runs this test starts when only the UI selector changes',()=>{
  const runner=readFileSync(new URL('../../../../.github/workflows/i2idlx-typescript.yml',import.meta.url),'utf8');
  assert.match(runner,/^ +run: npx tsx --test applications\/foxxi-content-intelligence\/i2idlx\/typescript\/\*\.test\.ts$/m,
    'i2idlx-typescript.yml runs this test file');
  assert.ok(paths(runner).includes('.github/workflows/i2idlx-ui-oracle.yml'),
    'a pull request that edits only the selector script must run the test that executes it');
});
test('PR browser checks cover every native/golden dependency and concrete workbench inputs',()=>{
  const uiPaths=paths(workflow);
  for(const producer of ['i2idlx-native-diagnostic.yml','i2idlx-golden-parity.yml']){
    const source=readFileSync(new URL('../../../../.github/workflows/'+producer,import.meta.url),'utf8');
    for(const dependency of paths(source)){
      assert.ok(uiPaths.includes(dependency),producer+' dependency must also trigger PR browser checks: '+dependency);
    }
  }
  const nativePaths=paths(readFileSync(new URL('../../../../.github/workflows/i2idlx-native-diagnostic.yml',import.meta.url),'utf8'));
  for(const dependency of uiPaths){
    assert.ok(nativePaths.includes(dependency),'every UI dependency requires a fresh bounded native producer: '+dependency);
  }
  const included=(file:string)=>uiPaths.some(pattern=>pattern.endsWith('/**')?file.startsWith(pattern.slice(0,-2)):file===pattern);
  for(const file of [
    'applications/foxxi-content-intelligence/i2idlx/config.json',
    'applications/foxxi-content-intelligence/i2idlx/typescript/build.ts',
    'applications/foxxi-content-intelligence/i2idlx/typescript/build-app.ts',
    'applications/foxxi-content-intelligence/i2idlx/src/i2idlx.ttl.tmpl',
    'applications/foxxi-content-intelligence/i2idlx/app/src/interego-caps.js',
    'applications/foxxi-content-intelligence/src/i2idlx-workbench.ts',
    'applications/foxxi-content-intelligence/src/i2idlx-client-tasks.ts',
    'packages/core/src/rdf/escape.ts',
    '.github/workflows/i2idlx-ui-oracle.yml',
    '.github/workflows/i2idlx-golden-parity.yml',
    'tools/i2idlx-hosted-visitor-smoke.py',
  ])assert.ok(included(file),'real builder, configuration, browser and workbench changes require PR browser evidence: '+file);
});
