#!/usr/bin/env node
// Live observer site for the tic-tac-toe tournament.
//
//   node examples/tic-tac-toe-tournament/server.mjs
//
// Reads the tournament pod (set by env TOURNAMENT_POD / TOURNAMENT_ID
// or auto-detected from the last orchestrator's run-meta file), serves
// a small dashboard at http://127.0.0.1:PORT/, and pushes one SSE ping
// per substrate event so the browser refetches /api/state and updates.
//
// The page is plain HTML+JS; everything that's true about the
// tournament is computed from descriptors on the tournament pod, not
// from any local state. The server's only job is to be a CORS-free
// proxy + an SSE relay.

import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLeaderboard, recentMoves, activeGames, readAgreement, readProposals,
  allGamesWithLiveBoards, recentActivity, currentPhase,
  readGoal, readDesigns, readAttestations, readSelection,
} from './substrate/aggregate.mjs';
import { subscribeTournament } from './substrate/client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 7099);
const RUN_META_PATH = join(__dirname, 'last-run.json');

// Resolve tournament metadata in this priority order:
//   1. TOURNAMENT_POD + TOURNAMENT_ID env vars (explicit override).
//   2. ./last-run.json (written by the orchestrator on startup so the
//      dashboard knows which pod to watch).
//   3. Bail with an instructive error.
function resolveTournament() {
  const fromEnv = {
    pod: process.env.TOURNAMENT_POD,
    id:  process.env.TOURNAMENT_ID,
  };
  if (fromEnv.pod && fromEnv.id) {
    return { pod: fromEnv.pod, id: fromEnv.id, players: parsePlayers(process.env.TOURNAMENT_PLAYERS), source: 'env' };
  }
  if (existsSync(RUN_META_PATH)) {
    const meta = JSON.parse(readFileSync(RUN_META_PATH, 'utf8'));
    return { ...meta, source: 'last-run.json' };
  }
  return null;
}

function parsePlayers(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

let cachedTournament = resolveTournament();
let stateCache = { at: 0, json: null };

const subscribers = new Set(); // active SSE response objects

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // -- API: full state ------------------------------------------------
  if (url.pathname === '/api/state') {
    // Fast path: orchestrator-snapshot. The orchestrator writes
    // examples/tic-tac-toe-tournament/state.json after every event,
    // so the dashboard sees moves the instant they happen, without
    // waiting for the CSS/Pinata write queue. The signed-descriptor
    // path still runs in the background — the pod remains the
    // canonical federated record.
    const snapshotPath = join(__dirname, 'state.json');
    if (existsSync(snapshotPath)) {
      try {
        const body = readFileSync(snapshotPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      } catch { /* fall through to substrate read */ }
    }
    cachedTournament = resolveTournament(); // re-check on each call so a new tournament is picked up without restart
    if (!cachedTournament) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no tournament configured', hint: 'set TOURNAMENT_POD + TOURNAMENT_ID env vars, or run the orchestrator (tournament.mjs) which writes last-run.json' }));
      return;
    }
    // Tiny TTL cache — /api/state is cheap to recompute but heavy under
    // SSE-driven re-fetches; without this, every notification triggers
    // ~500 concurrent reads against CSS and we hit the gate's rate limit.
    if (Date.now() - stateCache.at < 1500) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(stateCache.json);
      return;
    }
    try {
      // Serial, not parallel — keeps the fan-out per channel bounded.
      const phase        = await currentPhase          ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const goal         = await readGoal              ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const designs      = await readDesigns           ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const attestations = await readAttestations      ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const selection    = await readSelection         ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const allGames     = await allGamesWithLiveBoards({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const leaderboard  = await buildLeaderboard      ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id, players: cachedTournament.players ?? [] });
      const moves        = await recentMoves           ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id, limit: 12 });
      const active       = await activeGames           ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id });
      const activity     = await recentActivity        ({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id, limit: 25 });
      // Legacy fields kept null so the dashboard's older-tournament path doesn't crash.
      const proposals = []; const agreement = null;
      // Recent results = all entries in `results` channel; we also use
      // them for the leaderboard, but the dashboard wants the boards.
      const results = await import('./substrate/aggregate.mjs').then(m => m.recentMoves({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id, limit: 0 }).catch(() => []));
      // The recentMoves helper hits the `moves` channel — for results
      // we need a separate call.
      const { readChannel, dereference } = await import('./substrate/client.mjs');
      const resultEntries = await readChannel({ tournamentPodUrl: cachedTournament.pod, tournamentId: cachedTournament.id, channel: 'results', limit: 20 });
      const resultsFull = await Promise.all(resultEntries.map(e => e.descriptorUrl ? dereference(e.descriptorUrl) : null));
      const recent_results = resultsFull.map(d => (d?.payload ?? d?.body?.payload ?? d?.body)).filter(Boolean);
      const payload = JSON.stringify({
        tournament_id: cachedTournament.id,
        tournament_pod: cachedTournament.pod,
        players: cachedTournament.players ?? [],
        phase, goal, designs, attestations, selection,
        leaderboard, active, all_games: allGames,
        recent_moves: moves, recent_results,
        activity,
        // Legacy-shape fields (older tournaments still served)
        agreement, proposals,
        source: cachedTournament.source,
      });
      stateCache = { at: Date.now(), json: payload };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  // -- SSE: ping on every substrate event ----------------------------
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('event: hello\ndata: connected\n\n');
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    return;
  }
  // -- Static: index.html + anything in public/ ----------------------
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(__dirname, 'public', 'index.html')));
    return;
  }
  // -- Status: useful for orchestrator health-checks ------------------
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tournament: cachedTournament?.id ?? null, subscribers: subscribers.size }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[server] http://127.0.0.1:${PORT}`);
  console.log(`[server] tournament: ${cachedTournament ? cachedTournament.id : '(none — waiting for last-run.json or env)'}`);
});

// SSE wake loop: subscribe to the tournament pod and broadcast a ping
// to all connected dashboard clients whenever the substrate publishes
// anything. The dashboard re-fetches /api/state on each ping. We
// re-resolve the tournament on every iteration so the watcher follows
// the most recent orchestrator run without restart.
const subAbort = new AbortController();
process.on('SIGINT',  () => { subAbort.abort(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { subAbort.abort(); server.close(() => process.exit(0)); });

(async () => {
  while (!subAbort.signal.aborted) {
    cachedTournament = resolveTournament();
    if (!cachedTournament) { await new Promise(r => setTimeout(r, 3_000)); continue; }
    try {
      for await (const _ of subscribeTournament({ tournamentPodUrl: cachedTournament.pod, signal: subAbort.signal })) {
        stateCache = { at: 0, json: null }; // invalidate so next /api/state recomputes
        for (const r of subscribers) r.write(`data: tick\n\n`);
      }
    } catch { /* ignore — outer loop will retry */ }
    await new Promise(r => setTimeout(r, 2_000));
  }
})();

// Snapshot watcher — broadcasts an SSE tick whenever state.json mtime
// changes. This is what gives the dashboard its live feel: every
// orchestrator event triggers a re-fetch within ~500ms.
const snapshotWatcherPath = join(__dirname, 'state.json');
let lastSnapshotMtime = 0;
setInterval(() => {
  if (subAbort.signal.aborted) return;
  if (!existsSync(snapshotWatcherPath)) return;
  try {
    const m = statSync(snapshotWatcherPath).mtimeMs;
    if (m > lastSnapshotMtime) {
      lastSnapshotMtime = m;
      for (const r of subscribers) r.write(`data: snapshot\n\n`);
    }
  } catch { /* ignore */ }
}, 500);
