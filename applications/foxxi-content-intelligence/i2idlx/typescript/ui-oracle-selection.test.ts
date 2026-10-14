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
const repo='markjspivey-xwisee/interego',head='exact-source-head',pr=621;
interface Run {
  id:number;name:string;path:string;status:string;conclusion:string|null;head_sha:string;
  repository:{full_name:string};head_repository:{full_name:string};pull_requests:{number:number}[];
}
interface Artifact {id:number;name:string;expired:boolean}
const native=(extra:Partial<Run>={}):Run=>({
  id:101,name:'I2IDL-X bounded native diagnostic',path:'.github/workflows/i2idlx-native-diagnostic.yml',
  status:'completed',conclusion:'success',head_sha:head,repository:{full_name:repo},
  head_repository:{full_name:repo},pull_requests:[{number:pr}],...extra,
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
  let now=0;
  const github={rest:{actions:{
    listWorkflowRunsForRepo:async(args:{head_sha:string;event:string})=>{
      assert.equal(args.head_sha,head);assert.equal(args.event,'pull_request');
      calls.polls++;return {data:{workflow_runs:options.runs?.(calls.polls)??[native()]}};
    },
    getWorkflowRun:async(args:{run_id:number})=>{
      calls.gets++;const run=options.selected??native();assert.equal(args.run_id,run.id);
      return {data:run};
    },
    listWorkflowRunArtifacts:async(args:{run_id:number})=>{
      calls.artifacts.push(args.run_id);
      return {data:{artifacts:options.artifacts?.(args.run_id,calls.polls)??[artifact(options.selected??native())]}};
    },
  }}};
  const context={
    repo:{owner:'markjspivey-xwisee',repo:'interego'},sha:'default-branch-head',
    eventName:options.eventName??(options.payload?.inputs===undefined?'pull_request':'workflow_dispatch'),
    payload:options.payload??{pull_request:{number:pr,head:{sha:head}}},
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
test('automatic selection preserves final repository, fork, workflow, head and PR guards',async()=>{
  for(const extra of [
    {repository:{full_name:'foreign/repo'}},
    {head_repository:{full_name:'foreign/fork'}},
    {path:'.github/workflows/foreign.yml'},
    {head_sha:'other-source-head'},
    {pull_requests:[{number:999}]},
  ] satisfies Partial<Run>[]){
    const h=fixture({selected:native(extra)});
    await assert.rejects(h.completion,/does not belong to the expected repository, workflow and source head/);
    assert.deepEqual(h.outputs,{});assert.deepEqual(h.sleeps,[]);
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

test('PR browser checks cover every native/golden dependency and concrete workbench inputs',()=>{
  const paths=(source:string)=>{
    const block=/^ {4}paths:\n((?: {6}- '[^']+'\n)+)/m.exec(source);
    assert.ok(block,'producer and browser workflows must declare PR path dependencies');
    return [...block[1]!.matchAll(/^ {6}- '([^']+)'$/gm)].map(match=>match[1]!);
  };
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
