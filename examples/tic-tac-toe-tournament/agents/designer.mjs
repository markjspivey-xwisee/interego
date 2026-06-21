// Designer agent — receives the goal "design and develop a 2-player
// turn-based game in the spirit of tic-tac-toe" and authors a COMPLETE
// game design (name + natural-language rules + an executable JS engine
// module), which it publishes as a signed descriptor on the tournament
// pod's `designs` channel.
//
// Other agents discover it via discover_context; the evaluator scores
// it; the substrate promotes one design as binding; the players load
// that engine and play.

import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { publishTournamentEvent, readChannel, readEventPayload } from '../substrate/client.mjs';
import { loadEngine, runTestBattery } from '../game/runtime.mjs';

export const DESIGNER_BIASES = ['minimalist', 'novelty'];

/**
 * Run one designer agent. Returns the published design object.
 *
 *   minimalist  — "make it tight, classic, easy to verify"
 *   novelty     — "introduce ONE substrate-honest twist"
 */
export async function runDesigner({
  label, bias,
  tournamentId, tournamentPodUrl, tournamentOperator,
  log = console.log, smoke = false,
}) {
  const wallet = Wallet.createRandom();
  const did = `did:ethr:${wallet.address}`;
  log(`[designer ${label}] did=${did} bias=${bias}`);

  const design = smoke
    ? smokeDesignFor(label, bias)
    : await claudeDesign({ label, bias, log });

  if (!design.engineSource || !design.name) {
    throw new Error(`[designer ${label}] produced an incomplete design`);
  }

  // Run the local test battery before publishing — agents can attest
  // their own design as "self-tested PASS X/Y" so the evaluator has
  // a signal even before peer review.
  const loaded = loadEngine(design.engineSource);
  let selfBattery = { score: 0, passed: 0, total: 0, failures: ['engine failed to load'] };
  if (loaded.ok) {
    selfBattery = runTestBattery(loaded.exports);
  }
  log(`[designer ${label}] self-test ${selfBattery.passed}/${selfBattery.total}${selfBattery.failures.length ? ' — failures: ' + selfBattery.failures.slice(0, 2).join('; ') : ''}`);

  const designId = `urn:iep:gamedesign:${createHash('sha256').update(design.engineSource).digest('hex').slice(0, 16)}`;
  const payload = {
    designId,
    designerLabel: label,
    designerDid: did,
    bias,
    name: design.name,
    rulesText: design.rulesText,
    engineSource: design.engineSource,
    selfBattery,
    proposedAt: new Date().toISOString(),
  };
  await publishTournamentEvent({
    wallet: tournamentOperator.wallet, did: tournamentOperator.did,
    tournamentId, channel: 'designs', payload,
  });
  return payload;
}

// ── Smoke-mode design ────────────────────────────────────────────

function smokeDesignFor(label, bias) {
  // Two distinct authored variants so smoke exercises the multi-design
  // selection step. Both are real, working engines.
  if (bias === 'minimalist') {
    return {
      name: 'Classical 3×3 Tic-Tac-Toe',
      rulesText:
        'Standard 3×3 grid. Players X and O alternate placing marks on empty cells. First to align 3 of their marks in a row, column, or diagonal wins. If the board fills without a winner, the game is a draw.',
      engineSource: STANDARD_TTT_SOURCE,
    };
  }
  return {
    name: 'Misère Wild 3×3',
    rulesText:
      'Standard 3×3 grid with one twist: making 3-in-a-row LOSES the game (misère). The board is the same, the move legality is the same — only the win condition is inverted. Forces defensive play around forks.',
    engineSource: MISERE_TTT_SOURCE,
  };
}

const STANDARD_TTT_SOURCE = `
const meta = { name: 'Classical 3×3', players: ['X','O'] };
function emptyBoard() { return '.........'; }
function legalMoves(board, _player) {
  const out = [];
  for (let i = 0; i < 9; i++) if (board[i] === '.') out.push(i);
  return out;
}
function applyMove(board, cell, player) {
  if (board[cell] !== '.') throw new Error('cell occupied');
  return board.slice(0, cell) + player + board.slice(cell + 1);
}
const LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];
function checkTerminal(board) {
  for (const line of LINES) {
    const [a,b,c] = line;
    if (board[a] !== '.' && board[a] === board[b] && board[a] === board[c]) {
      return { terminal: true, winner: board[a], draw: false, line };
    }
  }
  if (!board.includes('.')) return { terminal: true, winner: null, draw: true, line: null };
  return { terminal: false, winner: null, draw: false, line: null };
}
`.trim();

const MISERE_TTT_SOURCE = `
const meta = { name: 'Misère Wild 3×3', players: ['X','O'] };
function emptyBoard() { return '.........'; }
function legalMoves(board, _player) {
  const out = [];
  for (let i = 0; i < 9; i++) if (board[i] === '.') out.push(i);
  return out;
}
function applyMove(board, cell, player) {
  if (board[cell] !== '.') throw new Error('cell occupied');
  return board.slice(0, cell) + player + board.slice(cell + 1);
}
const LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];
function checkTerminal(board) {
  for (const line of LINES) {
    const [a,b,c] = line;
    if (board[a] !== '.' && board[a] === board[b] && board[a] === board[c]) {
      // MISÈRE: making 3-in-a-row LOSES — winner is the OTHER mark.
      const loser = board[a];
      const winner = loser === 'X' ? 'O' : 'X';
      return { terminal: true, winner, draw: false, line };
    }
  }
  if (!board.includes('.')) return { terminal: true, winner: null, draw: true, line: null };
  return { terminal: false, winner: null, draw: false, line: null };
}
`.trim();

// ── Claude SDK driver (live mode) ────────────────────────────────

async function claudeDesign({ label, bias, log }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const biasPrompt = bias === 'minimalist'
    ? 'Lean classical — keep it tight, easy to verify, no surprises. Standard 3×3 tic-tac-toe is ideal.'
    : 'Add ONE substrate-honest twist that makes the game interesting without becoming a different game. Misère (making the line LOSES) is one example; "wild" (either mark can win) is another; a larger 4×4 with connect-3 is another.';
  const prompt =
`You are a game designer named "${label}". Your task is to design AND DEVELOP a two-player turn-based grid game in the spirit of tic-tac-toe. Other agents will play your game in a tournament if the substrate promotes your design.

DESIGN BIAS
  ${biasPrompt}

OUTPUT FORMAT — one JSON object, no preamble, no markdown fences, no explanation outside the JSON. The JSON has THREE fields:
  {
    "name": "<short name for the game, max 40 chars>",
    "rulesText": "<1–2 paragraph natural-language description of the rules>",
    "engineSource": "<a JavaScript source string that defines: emptyBoard(), legalMoves(board, player), applyMove(board, move, player), checkTerminal(board), and a meta = { name, players: ['X','O'] } constant. NO imports, no fetch, no require. Use single-quote strings to avoid escaping. The board is a STRING; cells are '.' empty, 'X', 'O'. Functions are top-level (not inside an IIFE). checkTerminal returns { terminal, winner: 'X'|'O'|null, draw, line: number[]|null }.>"
  }

CONSTRAINTS
  - The engine MUST be deterministic.
  - The board MUST be a string (so it serializes cleanly into signed descriptors).
  - applyMove MUST throw if the move is illegal.
  - checkTerminal MUST be terminal when the board has no legal moves left.
  - Use ASCII only — no fancy quotes, no emoji, no non-ASCII.
  - The engineSource value MUST be a single JSON string (use \\n for newlines).

Be concise but COMPLETE. Total output should be one JSON object the orchestrator can parse with JSON.parse().`;
  let combined = '';
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: process.env.DESIGNER_MODEL ?? 'claude-sonnet-4-6',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        settingSources: [],
      },
    })) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const c of msg.message.content) if (c.type === 'text') combined += c.text;
      }
    }
  } catch (err) {
    log(`[designer ${label}] Claude SDK threw (${err.message}); using smoke fallback`);
    return smokeDesignFor(label, bias);
  }
  try {
    const m = combined.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON object found');
    const parsed = JSON.parse(m[0]);
    if (!parsed.name || !parsed.engineSource) throw new Error('missing required field');
    return parsed;
  } catch (err) {
    log(`[designer ${label}] Claude output unparseable (${err.message}); using smoke fallback. Raw: ${combined.slice(0, 200)}`);
    return smokeDesignFor(label, bias);
  }
}
