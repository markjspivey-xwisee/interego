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
const child = spawn(binary, process.argv.slice(3), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
let output = '';
let marker = false;
let settled = false;
let grace;

async function killTree() {
  if (!child.pid) return;
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

async function finish(success, why) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  clearTimeout(grace);
  await killTree();
  // This directory was created for this invocation, never a user's existing pod.
  if (dirname(resolve(fixture)) !== resolve(tmpdir()) || !basename(fixture).startsWith('interego-pod-packaged-smoke-')) throw new Error('Unexpected smoke fixture path.');
  try { await rm(fixture, { recursive: true, force: true }); }
  catch { process.stderr.write('The stopped smoke fixture could not be removed automatically.\n'); }
  process.stdout.write(`Packaged local-pod smoke ${success ? 'PASS' : 'FAIL'}: ${why}\n`);
  process.exitCode = success ? 0 : 1;
  setTimeout(() => process.exit(success ? 0 : 1), 1500).unref();
}

const timer = setTimeout(() => void finish(false, 'no completed local persistence marker within 180 seconds'), 180_000);
function data(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  output = (output + text).slice(-512_000);
  if (/INTEREGO_POD_SMOKE_(?:FAIL|FAILED)/u.test(output)) void finish(false, 'the packaged application reported a failure');
  else if (output.includes('INTEREGO_POD_SMOKE_OK') && !marker) {
    marker = true;
    clearTimeout(timer);
    // Give the real app time to shut its pod down; a helper retaining a pipe is not a hang.
    grace = setTimeout(() => void finish(true, 'the packaged app completed its offline local lifecycle'), 10_000);
  }
}
child.stdout.on('data', data);
child.stderr.on('data', data);
child.once('error', error => void finish(false, `could not start the packaged app: ${error.message}`));
child.once('close', code => void finish(marker && code === 0, marker ? `the packaged app completed and exited ${code}` : `the packaged app exited ${code} before its success marker`));
