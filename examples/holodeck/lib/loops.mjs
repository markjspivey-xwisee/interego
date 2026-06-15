// Loop scheduler — Cherny's "I write loops, not prompts."
//
// You define loops in the dashboard. Each loop is one of:
//   - cron     — fire prompt P at agent A every N seconds
//   - event    — fire prompt P at agent A whenever pod X publishes
//                a new descriptor matching pattern Y
//   - chained  — fire prompt P at agent A whenever a SPECIFIC run
//                completes (so you can pipe agents into each other)
//
// Loops live in .holodeck/loops/<loopId>.json. Active loops are
// running schedules in process memory. Disabled loops are saved
// but not running.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { HOLODECK_DIR } from './identity.mjs';
import { listPodEntries } from './substrate.mjs';
import { spawnAgent } from './spawn.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOOPS_DIR = join(HOLODECK_DIR, 'loops');
if (!existsSync(LOOPS_DIR)) mkdirSync(LOOPS_DIR, { recursive: true });

const _timers = new Map();              // loopId -> setInterval handle
const _eventState = new Map();          // loopId -> { lastSeenDescriptorUrl, lastFiredAt }
const _runListeners = new Map();        // loopId -> function (for chained loops)

const _loopSubscribers = new Set();
export function subscribeLoopEvents(cb) {
  _loopSubscribers.add(cb);
  return () => _loopSubscribers.delete(cb);
}
function broadcast(evt) {
  for (const cb of _loopSubscribers) {
    try { cb(evt); } catch { /* ignore */ }
  }
}

// ── CRUD ────────────────────────────────────────────────────────

export function listLoops() {
  return readdirSync(LOOPS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(readFileSync(join(LOOPS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

export function getLoop(loopId) {
  const p = join(LOOPS_DIR, `${loopId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function saveLoop(loop) {
  if (!loop.loopId) loop.loopId = randomUUID().slice(0, 8);
  if (!loop.createdAt) loop.createdAt = new Date().toISOString();
  loop.updatedAt = new Date().toISOString();
  writeFileSync(join(LOOPS_DIR, `${loop.loopId}.json`), JSON.stringify(loop, null, 2));
  // If the loop was running, restart it so changes apply.
  if (_timers.has(loop.loopId) || _runListeners.has(loop.loopId)) {
    stopLoop(loop.loopId);
    if (loop.enabled) startLoop(loop);
  }
  broadcast({ kind: 'loop-saved', loop });
  return loop;
}

export function deleteLoop(loopId) {
  stopLoop(loopId);
  const p = join(LOOPS_DIR, `${loopId}.json`);
  if (existsSync(p)) { rmSync(p); broadcast({ kind: 'loop-deleted', loopId }); return true; }
  return false;
}

// ── Schedule ────────────────────────────────────────────────────

export function startAllEnabledLoops() {
  for (const loop of listLoops()) if (loop.enabled) startLoop(loop);
}

export function stopAllLoops() {
  for (const id of [..._timers.keys()]) stopLoop(id);
  for (const id of [..._runListeners.keys()]) stopLoop(id);
}

export function startLoop(loop) {
  if (!loop.enabled) return;
  stopLoop(loop.loopId);
  if (loop.kind === 'cron') {
    const handle = setInterval(() => fireCron(loop), Math.max(5, loop.intervalSeconds ?? 60) * 1000);
    _timers.set(loop.loopId, handle);
  } else if (loop.kind === 'event') {
    const handle = setInterval(() => fireEventCheck(loop), Math.max(10, loop.pollSeconds ?? 15) * 1000);
    _timers.set(loop.loopId, handle);
  } else if (loop.kind === 'chained') {
    // The dashboard server hooks chained loops up to run-status
    // events. Nothing to do here per se; we just remember the loop
    // is "running" via _runListeners so stopLoop can find it.
    _runListeners.set(loop.loopId, true);
  }
  broadcast({ kind: 'loop-started', loopId: loop.loopId });
}

export function stopLoop(loopId) {
  const t = _timers.get(loopId);
  if (t) { clearInterval(t); _timers.delete(loopId); }
  if (_runListeners.has(loopId)) _runListeners.delete(loopId);
  broadcast({ kind: 'loop-stopped', loopId });
}

export function isLoopRunning(loopId) {
  return _timers.has(loopId) || _runListeners.has(loopId);
}

// ── Firing ──────────────────────────────────────────────────────

async function fireCron(loop) {
  try {
    const run = await spawnAgent({
      label: loop.targetLabel,
      prompt: loop.prompt,
      source: `loop:${loop.loopId}`,
      meta: { loopName: loop.name },
    });
    broadcast({ kind: 'loop-fired', loopId: loop.loopId, runId: run.runId, at: new Date().toISOString() });
  } catch (err) {
    broadcast({ kind: 'loop-error', loopId: loop.loopId, error: err.message });
  }
}

async function fireEventCheck(loop) {
  const watchPodUrl = loop.watchPodUrl;
  if (!watchPodUrl) return;
  try {
    const entries = await listPodEntries({ podUrl: watchPodUrl, limit: 5 });
    if (entries.length === 0) return;
    const state = _eventState.get(loop.loopId) ?? {};
    const newest = entries[0]?.descriptorUrl;
    if (!newest || newest === state.lastSeenDescriptorUrl) {
      _eventState.set(loop.loopId, { ...state, lastSeenDescriptorUrl: newest });
      return;
    }
    // Optional pattern filter on graph IRI.
    if (loop.matchGraphIriContains) {
      const describes = Array.isArray(entries[0].describes) ? entries[0].describes[0] : entries[0].describes;
      if (!describes || !String(describes).includes(loop.matchGraphIriContains)) {
        _eventState.set(loop.loopId, { ...state, lastSeenDescriptorUrl: newest });
        return;
      }
    }
    const prompt = (loop.prompt ?? '').replace(/\{descriptor_url\}/g, newest);
    const run = await spawnAgent({
      label: loop.targetLabel,
      prompt,
      source: `loop:${loop.loopId}`,
      meta: { loopName: loop.name, triggerDescriptor: newest },
    });
    _eventState.set(loop.loopId, { lastSeenDescriptorUrl: newest, lastFiredAt: new Date().toISOString(), lastRunId: run.runId });
    broadcast({ kind: 'loop-fired', loopId: loop.loopId, runId: run.runId, at: new Date().toISOString(), trigger: newest });
  } catch (err) {
    broadcast({ kind: 'loop-error', loopId: loop.loopId, error: err.message });
  }
}

// The server.mjs wires this up to spawn.mjs's run-status events.
export async function onRunCompleted({ runId, label, status, exitCode }) {
  if (status !== 'completed') return;
  for (const loop of listLoops()) {
    if (!loop.enabled || loop.kind !== 'chained') continue;
    if (loop.afterRunFrom && loop.afterRunFrom !== label) continue;
    const prompt = (loop.prompt ?? '').replace(/\{prior_run_id\}/g, runId);
    try {
      const run = await spawnAgent({
        label: loop.targetLabel,
        prompt,
        source: `loop:${loop.loopId}`,
        meta: { loopName: loop.name, priorRunId: runId },
      });
      broadcast({ kind: 'loop-fired', loopId: loop.loopId, runId: run.runId, at: new Date().toISOString(), trigger: `run:${runId}` });
    } catch (err) {
      broadcast({ kind: 'loop-error', loopId: loop.loopId, error: err.message });
    }
  }
}
