// Pure aggregators over tournament-pod descriptor streams.
//
// Reads the four channels — agreement, games, moves, results — and
// derives a current-state view (leaderboard, in-progress games, recent
// moves) without any LLM. The dashboard calls these on every SSE wake
// (cheap because discover_context with graph_iri filter is O(channel),
// not O(pod)).

import { readChannel, dereference, readEventPayload } from './client.mjs';

/**
 * Build the leaderboard: { agent_label, did, wins, losses, draws, games_played, score }.
 *
 * Score = wins*3 + draws*1 (the standard Swiss-tournament weighting). The
 * leaderboard is sorted by score descending, then by wins, then by name.
 */
export async function buildLeaderboard({ tournamentPodUrl, tournamentId, players }) {
  const results = await readChannel({ tournamentPodUrl, tournamentId, channel: 'results' });
  const byDid = new Map(players.map(p => [p.did.toLowerCase(), {
    label: p.label, did: p.did,
    wins: 0, losses: 0, draws: 0, games_played: 0, score: 0,
  }]));
  const payloads = await Promise.all(results.map(r => r.descriptorUrl ? readEventPayload(r.descriptorUrl) : null));
  for (const payload of payloads) {
    if (!payload) continue;
    const winnerDid = payload.winnerDid ? payload.winnerDid.toLowerCase() : null;
    const xDid = payload.xDid?.toLowerCase();
    const oDid = payload.oDid?.toLowerCase();
    if (!xDid || !oDid) continue;
    for (const did of [xDid, oDid]) {
      const e = byDid.get(did);
      if (!e) continue;
      e.games_played++;
      if (!winnerDid) { e.draws++; e.score += 1; }
      else if (winnerDid === did) { e.wins++; e.score += 3; }
      else { e.losses++; }
    }
  }
  const board = [...byDid.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.label.localeCompare(b.label);
  });
  return board;
}

/**
 * Recent moves across the whole tournament, newest first, dereferenced
 * so the dashboard can render the board state.
 */
export async function recentMoves({ tournamentPodUrl, tournamentId, limit = 20 }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'moves', limit });
  const out = await Promise.all(entries.map(async e => {
    const p = e?.descriptorUrl ? await readEventPayload(e.descriptorUrl) : null;
    return p ? { ...p, descriptorUrl: e.descriptorUrl, validFrom: e.validFrom ?? null } : null;
  }));
  return out.filter(Boolean);
}

/**
 * Active (non-terminal) games. A game-id appears in `games` when started
 * and in `results` when terminal; subtract to get the active set.
 */
export async function activeGames({ tournamentPodUrl, tournamentId }) {
  const [gamesEntries, resultEntries] = await Promise.all([
    readChannel({ tournamentPodUrl, tournamentId, channel: 'games' }),
    readChannel({ tournamentPodUrl, tournamentId, channel: 'results' }),
  ]);
  const gamesPayloads = await Promise.all(gamesEntries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null));
  const resultsPayloads = await Promise.all(resultEntries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null));
  const terminalIds = new Set(resultsPayloads.map(r => r?.gameId).filter(Boolean));
  return gamesPayloads.filter(g => g?.gameId && !terminalIds.has(g.gameId));
}

/**
 * All games with their CURRENT board state (computed from moves).
 *
 * This is the heart of the parallel-observability view — every game's
 * latest signed move is what defines the current board. The dashboard
 * shows all of them as a grid so the operator sees every match
 * progressing at once.
 */
export async function allGamesWithLiveBoards({ tournamentPodUrl, tournamentId }) {
  const [gamesEntries, movesEntries, resultEntries] = await Promise.all([
    readChannel({ tournamentPodUrl, tournamentId, channel: 'games',   limit: 100 }),
    readChannel({ tournamentPodUrl, tournamentId, channel: 'moves',   limit: 200 }),
    readChannel({ tournamentPodUrl, tournamentId, channel: 'results', limit: 100 }),
  ]);
  const [gamesP, movesP, resultsP] = await Promise.all([
    Promise.all(gamesEntries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null)),
    Promise.all(movesEntries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null)),
    Promise.all(resultEntries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null)),
  ]);
  const games = gamesP.filter(Boolean);
  const moves = movesP.filter(Boolean);
  const results = resultsP.filter(Boolean);
  const resultsById = new Map(results.map(r => [r.gameId, r]));
  // For each game, find the LATEST move (highest moveNumber) to
  // determine the current board.
  const movesByGame = new Map();
  for (const m of moves) {
    if (!m.gameId) continue;
    const cur = movesByGame.get(m.gameId);
    if (!cur || (m.moveNumber ?? 0) > (cur.moveNumber ?? 0)) movesByGame.set(m.gameId, m);
  }
  return games
    .map(g => {
      const r = resultsById.get(g.gameId);
      const lastMove = movesByGame.get(g.gameId);
      const currentBoard = r?.finalBoard ?? lastMove?.board ?? g.board;
      return {
        gameId: g.gameId,
        gameNumber: g.gameNumber ?? null,
        xLabel: g.xLabel, oLabel: g.oLabel,
        xDid: g.xDid, oDid: g.oDid,
        startedAt: g.startedAt,
        currentBoard,
        moveNumber: r ? (r.moveCount ?? 0) : (lastMove?.moveNumber ?? 0),
        boardSize: Math.round(Math.sqrt((currentBoard ?? '').length)) || 3,
        lastReason: lastMove?.reason ?? null,
        terminal: !!r,
        winnerLabel: r?.winnerLabel ?? null,
        winningCells: r?.winningCells ?? null,
        draw: !!r?.draw,
      };
    })
    .sort((a, b) => (a.gameNumber ?? 0) - (b.gameNumber ?? 0));
}

/**
 * Recent activity stream — every published descriptor across every
 * channel, chronologically, with a short human description.
 */
export async function recentActivity({ tournamentPodUrl, tournamentId, limit = 30 }) {
  const channels = ['phases', 'goal', 'designs', 'attestations', 'selection', 'games', 'moves', 'results'];
  const buckets = await Promise.all(channels.map(async ch => {
    const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: ch, limit: 30 });
    const payloads = await Promise.all(entries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null));
    return payloads.map((p, i) => ({
      channel: ch, payload: p,
      validFrom: entries[i]?.validFrom ?? null,
      descriptorUrl: entries[i]?.descriptorUrl ?? null,
    })).filter(x => x.payload);
  }));
  const flat = buckets.flat();
  flat.sort((a, b) => {
    const ta = Date.parse(a.payload?.startedAt || a.payload?.finishedAt || a.payload?.validFrom || a.payload?.at || a.payload?.proposedAt || a.payload?.attestedAt || a.payload?.selectedAt || a.payload?.issuedAt || a.validFrom || 0);
    const tb = Date.parse(b.payload?.startedAt || b.payload?.finishedAt || b.payload?.validFrom || b.payload?.at || b.payload?.proposedAt || b.payload?.attestedAt || b.payload?.selectedAt || b.payload?.issuedAt || b.validFrom || 0);
    return tb - ta;
  });
  return flat.slice(0, limit).map(e => {
    const p = e.payload;
    const summary = (() => {
      if (e.channel === 'phases')       return `phase → ${p.phase}`;
      if (e.channel === 'goal')         return `goal published`;
      if (e.channel === 'designs')      return `${p.designerLabel} (${p.bias}) authored "${p.name}" — self-test ${p.selfBattery?.passed}/${p.selfBattery?.total}`;
      if (e.channel === 'attestations') return `evaluator scored "${p.designName}": battery ${p.battery?.passed}/${p.battery?.total} clarity ${p.clarity?.toFixed(2)} novelty ${p.novelty?.toFixed(2)} → composite ${p.composite?.toFixed(2)}`;
      if (e.channel === 'selection')    return `selected "${p.designName}" by ${p.designerLabel}${p.fallback ? ' (fallback)' : ` (composite ${p.composite?.toFixed(2)})`}`;
      if (e.channel === 'games')        return `game ${p.gameNumber ?? '?'} start: ${p.xLabel} (X) vs ${p.oLabel} (O)`;
      if (e.channel === 'moves')        return `g${p.gameNumber ?? '?'} m${p.moveNumber}: ${p.playerLabel} (${p.mark}) → ${p.move ?? p.cell}${p.terminal ? ` [TERMINAL]` : ''}`;
      if (e.channel === 'results')      return `g${p.gameNumber ?? '?'} ▶ ${p.draw ? 'DRAW' : `${p.winnerLabel} wins`} (${p.moveCount} moves)`;
      return e.channel;
    })();
    return { channel: e.channel, summary, payload: p };
  });
}

/** The most recent phase the tournament published. */
export async function currentPhase({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'phases', limit: 1 });
  if (entries.length === 0) return null;
  return readEventPayload(entries[0].descriptorUrl);
}

/** Read the binding agreement (if any) for the tournament. */
export async function readAgreement({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'agreement', limit: 1 });
  if (entries.length === 0) return null;
  return readEventPayload(entries[0].descriptorUrl);
}

/**
 * Designer proposals (legacy — kept so older tournaments still render).
 */
export async function readProposals({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'proposals' });
  const payloads = await Promise.all(entries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null));
  return payloads.filter(Boolean);
}

/** The orchestrator's published goal — the design challenge. */
export async function readGoal({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'goal', limit: 1 });
  if (entries.length === 0) return null;
  return readEventPayload(entries[0].descriptorUrl);
}

/** All agent-authored designs (name + rules + engine source). */
export async function readDesigns({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'designs', limit: 20 });
  const payloads = await Promise.all(entries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null));
  return payloads.filter(Boolean);
}

/** Evaluator attestations (composite scores per design). */
export async function readAttestations({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'attestations', limit: 20 });
  const payloads = await Promise.all(entries.map(e => e.descriptorUrl ? readEventPayload(e.descriptorUrl) : null));
  return payloads.filter(Boolean);
}

/** Final selection — the binding design the tournament played under. */
export async function readSelection({ tournamentPodUrl, tournamentId }) {
  const entries = await readChannel({ tournamentPodUrl, tournamentId, channel: 'selection', limit: 1 });
  if (entries.length === 0) return null;
  return readEventPayload(entries[0].descriptorUrl);
}
