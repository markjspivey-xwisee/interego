#!/usr/bin/env node
// Tournament orchestrator — the LOOP.
//
//   node examples/tic-tac-toe-tournament/tournament.mjs           # live
//   node examples/tic-tac-toe-tournament/tournament.mjs --smoke   # no-LLM
//
// The orchestrator's role is minimal and substrate-honest: it
// publishes a GOAL and then drives the phase transitions. The
// substantive work — designing the game, developing the engine,
// evaluating peers, picking moves — all happens in agent Claude
// sessions. The engine code itself is authored by the designers,
// published as a signed descriptor, and loaded dynamically by the
// player agents.
//
// Phases (each publishes a `phases` event so the dashboard renders
// progress live):
//   1. goal          — orchestrator publishes the design challenge.
//   2. designing     — 2 designers each author a complete game design.
//   3. evaluating    — 1 evaluator scores both designs.
//   4. selecting     — substrate picks the winner.
//   5. playing       — 4 disposition-typed players run a round-robin
//                      using the selected engine.
//   6. closed        — leaderboard finalised; standings descriptor.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { runDesigner, DESIGNER_BIASES } from './agents/designer.mjs';
import { runEvaluator, selectWinningDesign } from './agents/evaluator.mjs';
import { mintPlayer, pickAndPublishMove, DISPOSITIONS } from './agents/player.mjs';
import { loadEngine } from './game/runtime.mjs';
import {
  tournamentPodUrl, publishTournamentEvent, readChannel, readEventPayload,
} from './substrate/client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const SMOKE = args.smoke === true;

console.log(`[tournament] mode=${SMOKE ? 'smoke (no LLM)' : 'live (Claude Code SDK)'}`);

// ── tournament identity ─────────────────────────────────────────
const operatorWallet = Wallet.createRandom();
const tournamentOperator = { wallet: operatorWallet, did: `did:ethr:${operatorWallet.address}` };
const tournamentId = `ttt-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 12)}-${operatorWallet.address.slice(2, 8).toLowerCase()}`;
const podUrl = tournamentPodUrl(tournamentOperator.did);

console.log(`[tournament] id=${tournamentId}`);
console.log(`[tournament] pod=${podUrl}`);

const players = DISPOSITIONS.map(d => mintPlayer({ label: d, disposition: d }));
for (const p of players) console.log(`[tournament] player ${p.label}: ${p.did}`);

// ── write last-run.json so the dashboard picks up ───────────────
writeFileSync(join(__dirname, 'last-run.json'), JSON.stringify({
  pod: podUrl, id: tournamentId,
  players: players.map(p => ({ label: p.label, did: p.did })),
  operator: { did: tournamentOperator.did },
  startedAt: new Date().toISOString(),
}, null, 2));

// ── live state snapshot ──────────────────────────────────────────
//
// In addition to publishing every event as a signed Interego
// descriptor, the orchestrator maintains a local state snapshot the
// dashboard reads directly. This keeps the dashboard responsive
// regardless of substrate-write latency, while still leaving the
// signed descriptors on the pod as the canonical (federated) record.
const SNAPSHOT_PATH = join(__dirname, 'state.json');
const state = {
  tournament_id: tournamentId,
  tournament_pod: podUrl,
  players: players.map(p => ({ label: p.label, did: p.did })),
  phase: null,
  goal: null,
  designs: [],
  attestations: [],
  selection: null,
  all_games: [], // each entry: { gameNumber, gameId, xLabel, oLabel, currentBoard, moveNumber, terminal, winnerLabel, draw, winningCells, boardSize }
  leaderboard: players.map(p => ({ label: p.label, did: p.did, wins: 0, losses: 0, draws: 0, games_played: 0, score: 0 })),
  activity: [],
  source: 'orchestrator-snapshot',
};
function persist() { writeFileSync(SNAPSHOT_PATH, JSON.stringify(state)); }
function activity(channel, summary) {
  state.activity.unshift({ channel, summary, at: new Date().toISOString() });
  state.activity = state.activity.slice(0, 60);
  persist();
}
persist();

async function publishPhase(name, extra = {}) {
  state.phase = { phase: name, at: new Date().toISOString(), ...extra };
  activity('phases', `phase → ${name}`);
  return publishTournamentEvent({
    wallet: tournamentOperator.wallet, did: tournamentOperator.did,
    tournamentId, channel: 'phases',
    payload: { phase: name, at: new Date().toISOString(), ...extra },
  });
}

// ── PHASE 1: GOAL ───────────────────────────────────────────────
await publishPhase('goal');
console.log('\n[phase 1] publishing the goal');
const goalPayload = {
  statement:
    "Two designers will collaboratively author a two-player turn-based game in the spirit of tic-tac-toe. Each designer publishes a complete game design (name + rules text + executable engine source). An evaluator scores both. The substrate promotes the higher-scoring design. Four disposition-typed players then play a round-robin using the promoted engine.",
  issuedAt: new Date().toISOString(),
};
state.goal = goalPayload;
activity('goal', 'goal published');
persist();
await publishTournamentEvent({
  wallet: tournamentOperator.wallet, did: tournamentOperator.did,
  tournamentId, channel: 'goal', payload: goalPayload,
});

// ── PHASE 2: DESIGN (parallel) ──────────────────────────────────
await publishPhase('designing', { designerBiases: DESIGNER_BIASES });
console.log('\n[phase 2] design — 2 designers in parallel');
const designLabels = ['Minimalist', 'Inventor'];
const designs = await Promise.all([
  runDesigner({
    label: designLabels[0], bias: DESIGNER_BIASES[0],
    tournamentId, tournamentPodUrl: podUrl, tournamentOperator,
    log: s => console.log(`[${designLabels[0]}] ${s}`),
    smoke: SMOKE,
  }).then(d => { state.designs.push(d); activity('designs', `${d.designerLabel} authored "${d.name}" — self-test ${d.selfBattery.passed}/${d.selfBattery.total}`); persist(); return d; }),
  runDesigner({
    label: designLabels[1], bias: DESIGNER_BIASES[1],
    tournamentId, tournamentPodUrl: podUrl, tournamentOperator,
    log: s => console.log(`[${designLabels[1]}] ${s}`),
    smoke: SMOKE,
  }).then(d => { state.designs.push(d); activity('designs', `${d.designerLabel} authored "${d.name}" — self-test ${d.selfBattery.passed}/${d.selfBattery.total}`); persist(); return d; }),
]);
console.log(`[phase 2] both designs published — ${designs.map(d => `"${d.name}"`).join(' + ')}`);

// Wait briefly so the writes flush before the evaluator reads them back.
await new Promise(r => setTimeout(r, 6_000));

// ── PHASE 3: EVALUATE ───────────────────────────────────────────
await publishPhase('evaluating', { designCount: designs.length });
console.log('\n[phase 3] evaluate — running test battery + LLM judge on each design');
const attestations = await runEvaluator({
  designs,
  tournamentId, tournamentPodUrl: podUrl, tournamentOperator,
  log: (s) => {
    console.log(s);
    // surface evaluator score lines into state
    const m = String(s).match(/"([^"]+)": battery=(\d+)\/(\d+) clarity=([\d.]+) novelty=([\d.]+) composite=([\d.]+)/);
    if (m) activity('attestations', `evaluator scored "${m[1]}": battery ${m[2]}/${m[3]} clarity ${m[4]} novelty ${m[5]} → composite ${m[6]}`);
  },
  smoke: SMOKE,
});
state.attestations = attestations;
persist();

// ── PHASE 4: SELECT ─────────────────────────────────────────────
await publishPhase('selecting', { attestationCount: attestations.length });
console.log('\n[phase 4] selecting winning design');
const { winner: winningDesign, attestation: winningAttestation, fallback } = selectWinningDesign({ designs, attestations });
if (!winningDesign) {
  console.error('[tournament] no design passed selection — aborting');
  process.exit(1);
}
console.log(`[phase 4] winner: "${winningDesign.name}" by ${winningDesign.designerLabel} — composite ${winningAttestation?.composite?.toFixed(2) ?? 'fallback'}${fallback ? ' (fallback path)' : ''}`);
const selectionPayload = {
  designId: winningDesign.designId,
  designName: winningDesign.name,
  designerLabel: winningDesign.designerLabel,
  composite: winningAttestation?.composite ?? null,
  fallback: !!fallback,
  selectedAt: new Date().toISOString(),
};
state.selection = selectionPayload;
activity('selection', `selected "${winningDesign.name}" by ${winningDesign.designerLabel}${fallback ? ' (fallback)' : ` (composite ${winningAttestation?.composite?.toFixed(2) ?? '?'})`}`);
persist();
await publishTournamentEvent({
  wallet: tournamentOperator.wallet, did: tournamentOperator.did,
  tournamentId, channel: 'selection', payload: selectionPayload,
});

// Load the engine — fail loudly here, do NOT proceed to play if broken.
const loaded = loadEngine(winningDesign.engineSource);
if (!loaded.ok) {
  console.error(`[tournament] selected design's engine failed to load: ${loaded.error}`);
  process.exit(1);
}
const engine = loaded.exports;

// ── PHASE 5: PLAY (parallel) ────────────────────────────────────
await publishPhase('playing', { designId: winningDesign.designId, designName: winningDesign.name });
console.log('\n[phase 5] tournament — round-robin, all games concurrent');
const pairings = makeRoundRobinPairings(players);
console.log(`[phase 5] ${pairings.length} games concurrent`);

function stateGameRecord({ gameNumber, gameId, x, o, board, moveNumber, lastReason, terminal, winnerPlayer }) {
  const boardSize = Math.round(Math.sqrt(board.length)) || 3;
  return {
    gameId, gameNumber,
    xLabel: x.label, oLabel: o.label, xDid: x.did, oDid: o.did,
    currentBoard: board, boardSize, moveNumber,
    lastReason: lastReason ?? null,
    terminal: !!terminal?.terminal,
    winnerLabel: winnerPlayer?.label ?? null,
    winningCells: terminal?.line ?? null,
    draw: !!terminal?.draw,
  };
}
function upsertGame(rec) {
  const idx = state.all_games.findIndex(g => g.gameNumber === rec.gameNumber);
  if (idx >= 0) state.all_games[idx] = rec; else state.all_games.push(rec);
  state.all_games.sort((a, b) => (a.gameNumber ?? 0) - (b.gameNumber ?? 0));
  persist();
}
function bumpLeaderboard(xDid, oDid, winnerDid, draw) {
  const entry = (did) => state.leaderboard.find(e => e.did.toLowerCase() === (did ?? '').toLowerCase());
  const ex = entry(xDid), eo = entry(oDid);
  for (const e of [ex, eo]) if (e) e.games_played++;
  if (draw) { if (ex) { ex.draws++; ex.score++; } if (eo) { eo.draws++; eo.score++; } }
  else if (winnerDid) {
    const w = entry(winnerDid);
    const l = winnerDid.toLowerCase() === (xDid ?? '').toLowerCase() ? eo : ex;
    if (w) { w.wins++; w.score += 3; }
    if (l) { l.losses++; }
  }
  state.leaderboard.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.label.localeCompare(b.label);
  });
  persist();
}

async function playOneGame({ x, o, gameNumber }) {
  const gameId = `${tournamentId}-g${String(gameNumber).padStart(2, '0')}-${x.label.toLowerCase()}-vs-${o.label.toLowerCase()}`;
  let board = engine.emptyBoard();
  let moveNumber = 0;
  let terminal = { terminal: false };
  let lastReason = null;
  upsertGame(stateGameRecord({ gameNumber, gameId, x, o, board, moveNumber, lastReason, terminal: { terminal: false }, winnerPlayer: null }));
  activity('games', `game ${gameNumber} start: ${x.label} (X) vs ${o.label} (O)`);
  await publishTournamentEvent({
    wallet: tournamentOperator.wallet, did: tournamentOperator.did,
    tournamentId, channel: 'games',
    payload: {
      gameId, gameNumber, designId: winningDesign.designId,
      xLabel: x.label, oLabel: o.label, xDid: x.did, oDid: o.did,
      board, moveNumber: 0, startedAt: new Date().toISOString(),
    },
  });
  const maxMoves = board.length * 2;
  while (!terminal.terminal && moveNumber < maxMoves) {
    const onMove = moveNumber % 2 === 0 ? x : o;
    const mark = moveNumber % 2 === 0 ? 'X' : 'O';
    const opponent = onMove === x ? o : x;
    moveNumber++;
    try {
      const out = await pickAndPublishMove({
        player: onMove, mark, board, engine,
        selectedDesign: winningDesign,
        gameId, moveNumber, opponentLabel: opponent.label,
        tournamentId, tournamentPodUrl: podUrl, tournamentOperator,
        log: () => {}, smoke: SMOKE,
      });
      board = out.boardAfter;
      terminal = out.terminal;
      lastReason = out.reason;
      upsertGame(stateGameRecord({ gameNumber, gameId, x, o, board, moveNumber, lastReason, terminal, winnerPlayer: null }));
      activity('moves', `g${gameNumber} m${moveNumber}: ${onMove.label} (${mark}) → ${out.move}${terminal.terminal ? ' [TERMINAL]' : ''}`);
    } catch (err) {
      console.log(`[game ${gameNumber}] move ${moveNumber} threw: ${err.message}; auto-forfeit`);
      terminal = { terminal: true, winner: mark === 'X' ? 'O' : 'X', draw: false, line: null };
      break;
    }
  }
  const winnerPlayer = terminal.winner === 'X' ? x : terminal.winner === 'O' ? o : null;
  upsertGame(stateGameRecord({ gameNumber, gameId, x, o, board, moveNumber, lastReason, terminal, winnerPlayer }));
  bumpLeaderboard(x.did, o.did, winnerPlayer?.did, !!terminal.draw);
  activity('results', `g${gameNumber} ▶ ${terminal.draw ? 'DRAW' : `${winnerPlayer?.label} wins`} (${moveNumber} moves)`);
  await publishTournamentEvent({
    wallet: tournamentOperator.wallet, did: tournamentOperator.did,
    tournamentId, channel: 'results',
    payload: {
      gameId, gameNumber, designId: winningDesign.designId,
      xLabel: x.label, oLabel: o.label, xDid: x.did, oDid: o.did,
      finalBoard: board, moveCount: moveNumber,
      draw: !!terminal.draw, winner: terminal.winner ?? null,
      winnerLabel: winnerPlayer?.label ?? null, winnerDid: winnerPlayer?.did ?? null,
      winningCells: terminal.line ?? null, finishedAt: new Date().toISOString(),
    },
  });
  console.log(`[game ${gameNumber}] ▶ ${terminal.draw ? 'DRAW' : `${winnerPlayer?.label} wins`} in ${moveNumber} moves`);
}

const settled = await Promise.allSettled(pairings.map((p, i) => playOneGame({ x: p.x, o: p.o, gameNumber: i + 1 })));
const completed = settled.filter(s => s.status === 'fulfilled').length;
const failed = settled.length - completed;

// ── PHASE 6: CLOSED ─────────────────────────────────────────────
await publishPhase('closed', { totalGames: pairings.length, completed, failed });
console.log('\n[phase 6] closeout — leaderboard');
const { buildLeaderboard } = await import('./substrate/aggregate.mjs');
const leaderboard = await buildLeaderboard({
  tournamentPodUrl: podUrl, tournamentId,
  players: players.map(p => ({ label: p.label, did: p.did })),
});
for (const row of leaderboard) {
  console.log(`  ${row.label.padEnd(10)} W=${row.wins} L=${row.losses} D=${row.draws} score=${row.score}`);
}
console.log(`\n[tournament] done. Open http://127.0.0.1:${process.env.PORT ?? 7099}/`);

// ── helpers ─────────────────────────────────────────────────────

function makeRoundRobinPairings(players) {
  const pairings = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = 0; j < players.length; j++) {
      if (i === j) continue;
      pairings.push({ x: players[i], o: players[j] });
    }
  }
  return pairings;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) if (a === '--smoke') out.smoke = true;
  return out;
}
