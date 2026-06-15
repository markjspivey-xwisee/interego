// Spawn `claude` CLI processes wearing per-agent Interego identity.
//
// Each spawn:
//   1. Picks the per-agent MCP config (written by identity.mjs)
//   2. Spawns `claude -p "<prompt>" --mcp-config <config>` with
//      isolation env so the subprocess doesn't inherit the parent's
//      claude.ai connector (otherwise it'd be johnny again)
//   3. Captures stdout + stderr line-by-line and streams them to
//      registered subscribers (the dashboard SSE feed)
//   4. Records a run record under .holodeck/runs/<runId>.json so
//      the dashboard can replay history
//
// CLAUDECODE / ANTHROPIC_* env vars are deliberately reset so the
// child claude process is a fresh CLI session under the agent's
// MCP config — it doesn't share johnny's bearer.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mcpConfigPath, loadIdentityMeta, HOLODECK_DIR } from './identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(HOLODECK_DIR, 'runs');
if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });

const _activeRuns = new Map(); // runId -> { proc, label, prompt, status, startedAt, lines: [] }
const _runSubscribers = new Set(); // sse subscribers — each is a callback(event)

export function subscribeRunEvents(cb) {
  _runSubscribers.add(cb);
  return () => _runSubscribers.delete(cb);
}

function broadcast(event) {
  for (const cb of _runSubscribers) {
    try { cb(event); } catch { /* ignore subscriber errors */ }
  }
}

export function listRuns() {
  // Return active + recent finished runs.
  const active = [..._activeRuns.values()].map(r => ({
    runId: r.runId, label: r.label, prompt: r.prompt, status: r.status,
    startedAt: r.startedAt, lineCount: r.lines.length,
  }));
  const finished = readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, 50);
  return { active, finished };
}

export function getRunDetail(runId) {
  if (_activeRuns.has(runId)) {
    const r = _activeRuns.get(runId);
    return { runId, label: r.label, prompt: r.prompt, status: r.status, startedAt: r.startedAt, lines: r.lines.slice(-500) };
  }
  const p = join(RUNS_DIR, `${runId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Spawn a claude CLI process for the given agent label with the
 * given prompt. The prompt can include literal newlines.
 *
 * Returns { runId, label, startedAt }.
 *
 * `awaitFinish` (default false) — if true, returns a promise that
 * resolves when the process exits. Used by the loop scheduler.
 */
export async function spawnAgent({ label, prompt, awaitFinish = false, source = 'manual', meta = {} }) {
  const idMeta = loadIdentityMeta(label);
  if (!idMeta) throw new Error(`identity "${label}" not found — mint it first`);
  const cfgPath = mcpConfigPath(label);
  if (!existsSync(cfgPath)) throw new Error(`mcp config missing at ${cfgPath} — rewrite by remintInging the identity`);

  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();
  const childEnv = {
    ...process.env,
    // Reset CLAUDECODE so the child claude doesn't refuse to start
    // (parent VS Code session sets CLAUDECODE=1).
    CLAUDECODE: '',
    // Force the child not to inherit any prior claude.ai bearer — it
    // should use ONLY the --mcp-config we point at.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  };
  // Prompt goes via STDIN, not argv — on Windows the spawner uses
  // shell:true (claude is an npm .cmd shim) and cmd.exe mangles
  // multi-line argv values. `claude -p` with no prompt argument reads
  // the prompt from stdin.
  const args = [
    '-p',
    '--mcp-config', cfgPath,
    '--strict-mcp-config',                  // don't merge with user's mcpServers
    '--allowedTools', 'mcp__interego__publish_context,mcp__interego__discover_context,mcp__interego__get_descriptor,mcp__interego__record_trajectory_step,mcp__interego__pgsl_decide,mcp__interego__whoami,Bash,Read,Grep,Glob,Edit,Write',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'text',
  ];

  const r = {
    runId, label, prompt, status: 'spawned',
    source, meta,
    startedAt, finishedAt: null, exitCode: null,
    podUrl: idMeta.podUrl, did: idMeta.did,
    lines: [],
  };
  _activeRuns.set(runId, r);
  broadcast({ kind: 'run-spawned', run: { runId, label, prompt, startedAt, source } });

  const proc = spawn('claude', args, {
    cwd: resolve(__dirname, '..', '..', '..'),  // repo root
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  // Feed the prompt via stdin (see args comment above).
  proc.stdin.write(prompt);
  proc.stdin.end();
  r.proc = proc;
  r.status = 'running';
  broadcast({ kind: 'run-status', runId, status: 'running' });

  const onLine = (stream) => (buf) => {
    const chunk = buf.toString();
    for (const raw of chunk.split(/\r?\n/)) {
      if (!raw) continue;
      const entry = { stream, at: Date.now(), text: raw };
      r.lines.push(entry);
      if (r.lines.length > 5000) r.lines.shift();
      broadcast({ kind: 'run-line', runId, line: entry });
    }
  };
  proc.stdout.on('data', onLine('stdout'));
  proc.stderr.on('data', onLine('stderr'));

  const finishPromise = new Promise((resolveFinish) => {
    proc.on('exit', (code) => {
      r.status = code === 0 ? 'completed' : 'failed';
      r.exitCode = code;
      r.finishedAt = new Date().toISOString();
      _activeRuns.delete(runId);
      const persist = {
        runId, label: r.label, prompt: r.prompt, status: r.status,
        source: r.source, meta: r.meta,
        startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode,
        podUrl: r.podUrl, did: r.did,
        lines: r.lines,
      };
      writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify(persist, null, 2));
      broadcast({ kind: 'run-status', runId, status: r.status, exitCode: code });
      resolveFinish(persist);
    });
  });

  if (awaitFinish) return finishPromise;
  return { runId, label, startedAt, prompt, source };
}

export function killRun(runId) {
  const r = _activeRuns.get(runId);
  if (!r) return false;
  try { r.proc.kill('SIGTERM'); }
  catch { /* ignore */ }
  return true;
}

export function deleteFinishedRun(runId) {
  const p = join(RUNS_DIR, `${runId}.json`);
  if (existsSync(p)) { rmSync(p); return true; }
  return false;
}
