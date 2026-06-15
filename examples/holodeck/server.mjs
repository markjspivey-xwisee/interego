#!/usr/bin/env node
// HOLODECK — the control room.
//
//   node examples/holodeck/server.mjs
//   open http://127.0.0.1:7200
//
// REST + SSE surface over identity + spawn + substrate + loops.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listIdentities, mintIdentity, deleteIdentity, loadIdentityMeta,
  writeMcpConfig,
} from './lib/identity.mjs';
import {
  spawnAgent, killRun, listRuns, getRunDetail, deleteFinishedRun, subscribeRunEvents,
} from './lib/spawn.mjs';
import {
  federationActivity, listPodEntries,
} from './lib/substrate.mjs';
import {
  listLoops, getLoop, saveLoop, deleteLoop,
  startLoop, stopLoop, isLoopRunning, startAllEnabledLoops,
  onRunCompleted, subscribeLoopEvents,
} from './lib/loops.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7200);

// Wire run-completed events into the loop scheduler so chained loops fire.
subscribeRunEvents(evt => {
  if (evt.kind === 'run-status' && (evt.status === 'completed' || evt.status === 'failed')) {
    onRunCompleted({ runId: evt.runId, label: evt.label, status: evt.status, exitCode: evt.exitCode }).catch(() => {});
  }
});

// Single SSE bus for run + loop + substrate events.
const sseSubscribers = new Set();
function broadcastSse(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const r of sseSubscribers) {
    try { r.write(payload); } catch { /* ignore */ }
  }
}
subscribeRunEvents(evt => broadcastSse(evt));
subscribeLoopEvents(evt => broadcastSse(evt));

// Boot any previously-enabled loops.
startAllEnabledLoops();

// ── HTTP server ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body, ct = 'application/json') => {
    res.writeHead(status, { 'Content-Type': ct });
    if (typeof body === 'string' || Buffer.isBuffer(body)) res.end(body);
    else res.end(JSON.stringify(body));
  };
  const readBody = () => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c.toString(); if (buf.length > 1_000_000) reject(new Error('body too large')); });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });

  try {
    // -- SSE --------------------------------------------------------
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('event: hello\ndata: connected\n\n');
      sseSubscribers.add(res);
      req.on('close', () => sseSubscribers.delete(res));
      return;
    }

    // -- Identities -------------------------------------------------
    if (url.pathname === '/api/identities' && req.method === 'GET') {
      return send(200, { agents: listIdentities() });
    }
    if (url.pathname === '/api/identities' && req.method === 'POST') {
      const { label, notes, force } = JSON.parse(await readBody() || '{}');
      const meta = mintIdentity({ label, notes, force });
      broadcastSse({ kind: 'identity-minted', agent: meta });
      return send(200, meta);
    }
    if (url.pathname.startsWith('/api/identities/') && req.method === 'DELETE') {
      const label = decodeURIComponent(url.pathname.split('/').pop());
      const ok = deleteIdentity(label);
      broadcastSse({ kind: 'identity-deleted', label });
      return send(200, { ok });
    }
    if (url.pathname.match(/^\/api\/identities\/[^/]+\/mcp-config$/) && req.method === 'GET') {
      const label = decodeURIComponent(url.pathname.split('/')[3]);
      const path = writeMcpConfig(label);
      return send(200, { label, mcpConfigPath: path });
    }

    // -- Spawn ------------------------------------------------------
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const { label, prompt } = JSON.parse(await readBody() || '{}');
      if (!label || !prompt) return send(400, { error: 'label and prompt required' });
      const run = await spawnAgent({ label, prompt, source: 'manual' });
      return send(200, run);
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      return send(200, listRuns());
    }
    if (url.pathname.match(/^\/api\/runs\/[^/]+$/) && req.method === 'GET') {
      const runId = url.pathname.split('/').pop();
      const detail = getRunDetail(runId);
      if (!detail) return send(404, { error: 'not found' });
      return send(200, detail);
    }
    if (url.pathname.match(/^\/api\/runs\/[^/]+\/kill$/) && req.method === 'POST') {
      const runId = url.pathname.split('/')[3];
      return send(200, { killed: killRun(runId) });
    }
    if (url.pathname.match(/^\/api\/runs\/[^/]+$/) && req.method === 'DELETE') {
      const runId = url.pathname.split('/').pop();
      return send(200, { ok: deleteFinishedRun(runId) });
    }

    // -- Loops ------------------------------------------------------
    if (url.pathname === '/api/loops' && req.method === 'GET') {
      const loops = listLoops().map(l => ({ ...l, running: isLoopRunning(l.loopId) }));
      return send(200, { loops });
    }
    if (url.pathname === '/api/loops' && req.method === 'POST') {
      const body = JSON.parse(await readBody() || '{}');
      const saved = saveLoop(body);
      if (saved.enabled) startLoop(saved);
      return send(200, saved);
    }
    if (url.pathname.match(/^\/api\/loops\/[^/]+$/) && req.method === 'PUT') {
      const loopId = url.pathname.split('/').pop();
      const body = JSON.parse(await readBody() || '{}');
      const prior = getLoop(loopId);
      if (!prior) return send(404, { error: 'not found' });
      const saved = saveLoop({ ...prior, ...body, loopId });
      if (saved.enabled) startLoop(saved); else stopLoop(loopId);
      return send(200, saved);
    }
    if (url.pathname.match(/^\/api\/loops\/[^/]+$/) && req.method === 'DELETE') {
      const loopId = url.pathname.split('/').pop();
      return send(200, { ok: deleteLoop(loopId) });
    }
    if (url.pathname.match(/^\/api\/loops\/[^/]+\/start$/) && req.method === 'POST') {
      const loopId = url.pathname.split('/')[3];
      const loop = getLoop(loopId);
      if (!loop) return send(404, { error: 'not found' });
      const saved = saveLoop({ ...loop, enabled: true });
      startLoop(saved);
      return send(200, saved);
    }
    if (url.pathname.match(/^\/api\/loops\/[^/]+\/stop$/) && req.method === 'POST') {
      const loopId = url.pathname.split('/')[3];
      const loop = getLoop(loopId);
      if (!loop) return send(404, { error: 'not found' });
      stopLoop(loopId);
      const saved = saveLoop({ ...loop, enabled: false });
      return send(200, saved);
    }

    // -- Substrate (federation activity) ----------------------------
    if (url.pathname === '/api/federation/activity' && req.method === 'GET') {
      const ids = listIdentities();
      const activity = await federationActivity({ identities: ids });
      return send(200, { activity, agent_count: ids.length });
    }
    if (url.pathname.match(/^\/api\/federation\/pods\/[^/]+$/) && req.method === 'GET') {
      const label = decodeURIComponent(url.pathname.split('/').pop());
      const meta = loadIdentityMeta(label);
      if (!meta) return send(404, { error: 'not found' });
      const entries = await listPodEntries({ podUrl: meta.podUrl, limit: 30 });
      return send(200, { label, podUrl: meta.podUrl, entries });
    }

    // -- Static -----------------------------------------------------
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(200, readFileSync(join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/app.js') {
      return send(200, readFileSync(join(__dirname, 'public', 'app.js')), 'application/javascript');
    }
    if (url.pathname === '/style.css') {
      return send(200, readFileSync(join(__dirname, 'public', 'style.css')), 'text/css');
    }
    if (url.pathname === '/healthz') {
      return send(200, { ok: true, identities: listIdentities().length, runs: listRuns().active.length, loops: listLoops().length });
    }
    return send(404, { error: 'not found' });
  } catch (err) {
    console.error('[holodeck] error:', err);
    return send(500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[holodeck] http://127.0.0.1:${PORT}`);
  console.log(`[holodeck] ${listIdentities().length} identities, ${listLoops().length} loops`);
});

process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
