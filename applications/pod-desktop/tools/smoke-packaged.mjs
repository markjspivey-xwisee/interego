import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { releaseRoot } from './paths.mjs';

const binary = resolve(process.argv[2] ?? join(releaseRoot, 'win-unpacked', 'Interego.exe'));
await access(binary);
const fixture = await mkdtemp(join(tmpdir(), 'interego-pod-packaged-smoke-'));
const env = { ...process.env, INTEREGO_POD_SMOKE: '1', INTEREGO_POD_SMOKE_DATA: fixture, INTEREGO_POD_DATA_DIR: fixture };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
let child;
let launchIndex = 0;
let timer;
let output = '';
let marker = false;
let settled = false;
let grace;

async function killTree() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(done => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', done);
      killer.once('close', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* It already exited. */ }
  }
}

async function finish(success, why, run) {
  if (run !== launchIndex || settled) return;
  settled = true;
  clearTimeout(timer);
  clearTimeout(grace);
  await killTree();
  if (success && launchIndex === 1) { launch(); return; }
  // This directory was created for this invocation, never a user's existing pod.
  if (dirname(resolve(fixture)) !== resolve(tmpdir()) || !basename(fixture).startsWith('interego-pod-packaged-smoke-')) throw new Error('Unexpected smoke fixture path.');
  try { await rm(fixture, { recursive: true, force: true }); }
  catch { process.stderr.write('The stopped smoke fixture could not be removed automatically.\n'); }
  process.stdout.write(`Packaged local-pod smoke ${success ? 'PASS' : 'FAIL'}: ${why}; two app process launches\n`);
  process.exitCode = success ? 0 : 1;
  setTimeout(() => process.exit(success ? 0 : 1), 1500).unref();
}

function data(chunk, run) {
  if (run !== launchIndex) return;
  const text = chunk.toString();
  process.stdout.write(text);
  output = (output + text).slice(-512_000);
  if (/INTEREGO_POD_SMOKE_(?:FAIL|FAILED)/u.test(output)) void finish(false, 'the packaged application reported a failure', run);
  else if (output.includes('INTEREGO_POD_SMOKE_OK') && !marker) {
    marker = true;
    clearTimeout(timer);
    // Give the real app time to shut its pod down; a helper retaining a pipe is not a hang.
    grace = setTimeout(() => void finish(child.exitCode === 0,
      child.exitCode === 0 ? 'the packaged app completed its offline local lifecycle' : 'the app did not exit cleanly after its success marker', run), 10_000);
  }
}
function launch() {
  const run = ++launchIndex;
  marker = false; settled = false; output = '';
  process.stdout.write(`Verifying packaged app launch ${run}/2.\n`);
  child = spawn(binary, process.argv.slice(3), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  timer = setTimeout(() => void finish(false, 'no completed local persistence and agent-pairing marker within 300 seconds', run), 300_000);
  child.stdout.on('data', chunk => data(chunk, run));
  child.stderr.on('data', chunk => data(chunk, run));
  child.once('error', error => void finish(false, `could not start the packaged app: ${error.message}`, run));
  child.once('close', code => void finish(marker && code === 0, marker ? `the packaged app completed and exited ${code}` : `the packaged app exited ${code} before its success marker`, run));
}

// A new app process must unlock the same keys and retained revocations. Merely
// restarting the runtime inside the first process would reuse its key cache.
launch();
