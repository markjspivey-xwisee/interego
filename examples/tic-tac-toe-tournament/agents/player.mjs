// Player agent — given the WINNING agent-authored engine + a board
// state + its disposition, picks one move via Claude SDK and publishes
// it signed.
//
// The board representation, legal moves, and terminal detection ALL
// come from the agent-authored engine (via game/runtime.mjs). The
// player code doesn't know what the game is — it just calls the
// engine and follows the chosen design's rules.

import { Wallet } from 'ethers';
import { z } from 'zod';
import { publishTournamentEvent } from '../substrate/client.mjs';

export const DISPOSITIONS = ['Aggressor', 'Sentinel', 'Mirror', 'Wildcard'];

const DISPOSITION_HOOK = {
  Aggressor: 'You are an OFFENSIVE player. Always prioritize building toward the win condition (whatever it is for this game) over blocking. Take central cells if available; otherwise corners.',
  Sentinel:  "You are a DEFENSIVE player. Always block opponent threats first, then build your own line second. Refuse moves that create opponent forks. Prefer drawing over speculative offence.",
  Mirror:    "You are an ADAPTIVE player. Model the opponent's recent moves and counter their apparent strategy. Mirror aggression with counter-forks; mirror defence with patient central control.",
  Wildcard:  "You are a CHAOTIC player. Choose legal but non-obvious moves at least one-third of the time. Otherwise play soundly.",
};

export function mintPlayer({ label, disposition }) {
  const wallet = Wallet.createRandom();
  return {
    label, disposition,
    wallet,
    did: `did:ethr:${wallet.address}`,
  };
}

/**
 * Pick and publish ONE move. `engine` is the loaded
 * agent-authored engine. `selectedDesign` is the design descriptor
 * (so its IRI can be referenced in the signed move payload).
 */
export async function pickAndPublishMove({
  player, mark, board, engine, selectedDesign,
  gameId, moveNumber, opponentLabel,
  tournamentId, tournamentPodUrl, tournamentOperator,
  log = console.log, smoke = false,
}) {
  const legal = engine.legalMoves(board, mark);
  if (!Array.isArray(legal) || legal.length === 0) {
    throw new Error('no legal moves — game should already be terminal');
  }

  let chosenMove, reason;
  if (smoke) {
    chosenMove = legal[0];
    reason = `[smoke] first-legal ${chosenMove}`;
  } else {
    const picked = await askClaudeForMove({ player, mark, board, engine, selectedDesign, opponentLabel, gameId, moveNumber, log });
    chosenMove = picked.move;
    reason = picked.reason;
    if (!legal.includes(chosenMove)) {
      log(`[player ${player.label}] Claude proposed illegal move ${chosenMove}; falling back to ${legal[0]}`);
      chosenMove = legal[0];
      reason = `${reason} (overridden — illegal)`;
    }
  }
  const boardAfter = engine.applyMove(board, chosenMove, mark);
  const terminal = engine.checkTerminal(boardAfter) || { terminal: false };

  // Per-move publish: ON in live mode (real wall-clock pacing); OFF in
  // smoke (deterministic, dozens of moves/sec exhaust the write
  // budget). Smoke users see end-state via the results channel. The
  // PUBLISH_MOVES env var overrides.
  const publishMovesEnabled = (process.env.PUBLISH_MOVES === '1')
    || (!smoke && process.env.PUBLISH_MOVES !== '0');

  let descriptorUrl = null;
  if (publishMovesEnabled) {
    const result = await publishTournamentEvent({
      wallet: player.wallet, did: player.did,
      tournamentId, channel: 'moves',
      payload: {
        gameId, moveNumber, mark,
        playerLabel: player.label, playerDid: player.did,
        opponentLabel,
        designId: selectedDesign.designId,
        move: chosenMove, cell: chosenMove,
        reason,
        boardBefore: board, board: boardAfter,
        terminal: !!terminal.terminal,
        winner: terminal.winner ?? null,
        winningCells: terminal.line ?? null,
        draw: !!terminal.draw,
        validFrom: new Date().toISOString(),
      },
    });
    descriptorUrl = result.descriptorUrl;
  }
  return {
    move: chosenMove, mark, reason,
    boardBefore: board, boardAfter,
    terminal,
    descriptorUrl,
  };
}

// ── Claude SDK driver ───────────────────────────────────────────

async function askClaudeForMove({ player, mark, board, engine, selectedDesign, opponentLabel, gameId, moveNumber, log }) {
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  let chosen = null;
  const legal = engine.legalMoves(board, mark);
  const boardSize = Math.round(Math.sqrt(board.length));
  const rendered = (() => {
    if (!Number.isFinite(boardSize) || boardSize * boardSize !== board.length) return board;
    const rows = [];
    for (let r = 0; r < boardSize; r++) rows.push(board.slice(r * boardSize, (r + 1) * boardSize).split('').join('|'));
    return rows.join('\n' + Array(boardSize * 2 - 1).fill('-').join('') + '\n');
  })();
  const tools = createSdkMcpServer({
    name: 'ttt-move',
    version: '0.1.0',
    tools: [
      tool('discover_board',
        'Return the current board, whose turn it is, the legal moves, and the agreed-on game design.',
        {},
        async () => ({ content: [{ type: 'text', text: JSON.stringify({
          board, rendered,
          boardSize,
          legal_moves: legal,
          you_are: mark, opponent: mark === 'X' ? 'O' : 'X',
          opponent_label: opponentLabel,
          move_number: moveNumber,
          game_name: selectedDesign.name,
          game_rules: selectedDesign.rulesText,
          design_id: selectedDesign.designId,
        }, null, 2) }] })),
      tool(
        'make_move',
        'Choose ONE legal move identified by an integer (the cell index). The reason should be one short sentence that bakes your disposition into the signed move provenance.',
        {
          move:   z.number().int().describe('Cell index — must appear in the legal_moves array returned by discover_board.'),
          reason: z.string().describe('One short sentence explaining the move.'),
        },
        async ({ move, reason }) => {
          chosen = { move, reason };
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, move, reason }) }] };
        },
      ),
    ],
  });
  const systemPrompt =
`You are ${player.label} (DID ${player.did}), playing the game "${selectedDesign.name}".

THE GAME (designed and developed by other agents)
  ${selectedDesign.rulesText}

YOUR DISPOSITION
  ${DISPOSITION_HOOK[player.disposition] ?? DISPOSITION_HOOK.Aggressor}

THIS GAME
  Game id: ${gameId}
  Move number: ${moveNumber}
  You play: ${mark}
  Opponent: ${opponentLabel}
  Design id: ${selectedDesign.designId}

YOUR TOOLS
  discover_board — read the current board + legal moves + game rules.
  make_move      — pick ONE legal move + a one-sentence reason.

WHAT TO DO
  Call discover_board ONCE. Decide your move per the rules + your disposition. Call make_move exactly ONCE. End your turn.
  Do NOT call make_move twice. Do NOT call any other tool.`;
  try {
    for await (const _msg of query({
      prompt: 'It is your turn. Make your move.',
      options: {
        model: process.env.PLAYER_MODEL ?? 'claude-sonnet-4-6',
        maxTurns: 6,
        systemPrompt,
        mcpServers: { 'ttt-move': tools },
        allowedTools: ['mcp__ttt-move__discover_board', 'mcp__ttt-move__make_move'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
      },
    })) { /* drain — make_move's side-effect captures the move */ }
  } catch (err) {
    log(`[player ${player.label}] Claude SDK threw: ${err.message}; falling back to first legal`);
  }
  if (chosen) return chosen;
  return { move: legal[0], reason: '[fallback] Claude did not call make_move; first legal move.' };
}
