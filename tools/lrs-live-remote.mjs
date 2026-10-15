// Run only inside the authenticated, existing Foxxi container. No keys leave this process.
import { readFile, readdir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BASELINE_SOURCE_SHA256 } from './lrs-live-export.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = '/app/applications/foxxi-content-intelligence/src/xapi-lrs.ts';
let pid, started = false, closed = false;
async function targets() {
  const r = await fetch('http://127.0.0.1:9229/json/list', {signal: AbortSignal.timeout(500), redirect:'error'});
  if (!r.ok) throw new Error('inspector-not-ready');
  const list = await r.json();
  if (list.length !== 1 || !list[0].webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:9229/')) throw new Error('inspector-target-refused');
  return list;
}
async function closeStartedInspector() {
  if (!started) return;
  const list = await targets();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cleanup-timeout')), 1500);
    ws.addEventListener('open', () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{
      // The Node 22 builtin accessor avoids dynamic import callbacks inside CDP evaluation.
      expression:"setTimeout(() => { try { process.getBuiltinModule('node:inspector').close(); } catch {} }, 25); true",
      returnByValue:true, silent:true
    }})), {once:true});
    ws.addEventListener('message', e => { const m=JSON.parse(e.data); if(m.id===1){clearTimeout(timer);ws.close();resolve();} });
    ws.addEventListener('error', () => {clearTimeout(timer);reject(new Error('cleanup-channel-failed'));}, {once:true});
  });
  for (let i=0;i<30;i++) {
    await delay(100);
    try { await targets(); } catch (error) {
      if(error.cause?.code!=='ECONNREFUSED') throw error;
      const health=await fetch('http://127.0.0.1:6080/health',{signal:AbortSignal.timeout(2000),redirect:'error'});
      if(!health.ok) throw new Error('application-health-failed');
      closed = true; return;
    }
  }
  throw new Error('inspector-close-not-confirmed');
}
try {
  if (process.env.INTEREGO_BUILD_SHA !== '74475d4a0220abc6f7d3e8134258d0908d1607a9') throw new Error('deployment-identity-refused');
  const digest=createHash('sha256').update(await readFile(source)).digest('hex');
  if(digest!==BASELINE_SOURCE_SHA256) throw new Error('source-identity-refused');
  if(!process.env.FOXXI_ADMIN_KEY_SEED) throw new Error('archive-key-unavailable');
  const port=Number(process.env.PORT??6080);
  if(port!==6080) throw new Error('application-port-refused');
  const sockets = new Set();
  for(const path of ['/proc/net/tcp','/proc/net/tcp6']) {
    for(const line of (await readFile(path,'utf8')).trim().split('\n').slice(1)) {
      const cols=line.trim().split(/\s+/);
      if(cols[1]?.endsWith(':17C0') && cols[3]==='0A') sockets.add(`socket:[${cols[9]}]`);
    }
  }
  const matches=[];
  for(const name of await readdir('/proc')) {
    if(!/^\d+$/.test(name)) continue;
    try {
      const links=await Promise.all((await readdir(`/proc/${name}/fd`)).map(fd=>readlink(`/proc/${name}/fd/${fd}`).catch(()=>'')));
      if(!links.some(link=>sockets.has(link))) continue;
      const argv=(await readFile(`/proc/${name}/cmdline`,'utf8')).split('\0');
      if(!argv.some(arg=>arg.endsWith('applications/foxxi-content-intelligence/bridge/server.ts')) || argv.some(arg=>arg.startsWith('--inspect'))) throw new Error('process-identity-refused');
      matches.push(Number(name));
    } catch(error) { if(error.message==='process-identity-refused') throw error; }
  }
  if(matches.length!==1) throw new Error('listener-process-ambiguous');
  pid=matches[0];
  try {await targets(); throw new Error('inspector-already-enabled');}
  catch(error) {if(error.message==='inspector-already-enabled'||error.message==='inspector-target-refused')throw error;}
  process.kill(pid,'SIGUSR1'); started=true;
  let ready=false;
  for(let i=0;i<30;i++){try{await targets();ready=true;break;}catch{await delay(100);}}
  if(!ready) throw new Error('inspector-start-failed');
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['./lrs-live-export.mjs'],{stdio:['ignore','inherit','inherit'],env:process.env});
    child.once('error',reject); child.once('exit',resolve);
  });
  if(code!==0) throw new Error('live-export-failed');
  const health=await fetch('http://127.0.0.1:6080/health',{signal:AbortSignal.timeout(2000),redirect:'error'});
  if(!health.ok) throw new Error('application-health-failed');
} catch(error) {
  const safe=new Set(['deployment-identity-refused','source-identity-refused','archive-key-unavailable',
    'application-port-refused','process-identity-refused','listener-process-ambiguous','inspector-already-enabled',
    'inspector-target-refused','inspector-start-failed','live-export-failed','application-health-failed']);
  console.log(`LRS_OPERATOR_EXPORT_FAILED=${safe.has(error.message)?error.message:'operator-operation-failed'}`); process.exitCode=1;
} finally {
  try {await closeStartedInspector();}
  catch {console.log('LRS_INSPECTOR_CLEANUP_FAILED');process.exitCode=1;}
  console.log(`LRS_OPERATOR_CLEANUP=${JSON.stringify({pid,inspectorStarted:started,inspectorCloseConfirmed:closed})}`);
}
