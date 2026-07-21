/**
 * Interego — Tic-Tac-Toe Tournament (REAL multi-agent demo).
 *
 *   npx tsx examples/tic-tac-toe-tournament-real.mjs
 *
 * Sibling-in-spirit of applications/foxxi-content-intelligence/tools/
 * emergent-collective-agents.mjs. Same architecture (5 real Claude
 * subagents, each with its own wallet/DID/signed claim, coordinating
 * ONLY through the live substrate), different vertical: a 4-player
 * round-robin tic-tac-toe tournament that lives entirely on the
 * deployed Interego CSS pod.
 *
 * What is real here:
 *
 *   · Five real ECDSA wallets / real DIDs / signed-and-verified
 *     participation claims (Designer + Aggressor + Sentinel + Mirror
 *     + Wildcard).
 *   · Five real Claude Agent SDK sessions (claude-sonnet-4-6 by default).
 *     Each player decides its own moves; the orchestrator never tells
 *     a player where to play. Each call to make_move signs the move
 *     payload with the player's wallet.
 *   · Every game state lives on the pod as a chain of iep:ContextDescriptor
 *     move-descriptors linked via iep:supersedes. No agent ever sees the
 *     board through an in-memory shortcut — each player must call
 *     discover() + fetch the latest move's TriG and decode the board
 *     before deciding.
 *   · The Designer publishes a public iep:Affordance up front so any future
 *     Interego agent can discover the tournament, mint a NewGameChallenge
 *     descriptor, and join. After the six matches the Designer publishes
 *     an aggregated standings-descriptor referencing every match's
 *     terminal move via iep:hasMember.
 *   · No new ontology terms in any owned core/pattern/adjacent prefix.
 *     The descriptor metadata uses only existing iep: / ieh: / hydra: /
 *     dcat: / prov: / dcterms: terms (iep:ContextDescriptor, iep:supersedes,
 *     iep:hasMember, iep:Affordance, hydra:Operation, hydra:expects,
 *     hydra:returns, dcat:Distribution, prov:wasGeneratedBy,
 *     dcterms:conformsTo, dcterms:hasPart). Game-specific predicates
 *     (move-number, mark, cell, board, winner, draw, score, ...) live
 *     under a vertical namespace `tictactoe:` minted by this demo — the
 *     same pattern publishCalibrationSnapshotDescriptor uses with
 *     foxxi:bundleJson. Vertical prefixes don't need an owned-ontology
 *     declaration. The Designer's rules-descriptor IRI is the
 *     conformance target for moves.
 *
 * What is scenario data (as in any demo):
 *
 *   · The agent names, the four dispositions (offensive / defensive /
 *     adaptive / chaotic), and the round-robin pairing order.
 *   · The choice of "tic-tac-toe" as the vertical — the substrate is
 *     game-agnostic; any rule set publishable as a rules-descriptor
 *     would compose the same way.
 *
 * Requires an active Claude Code OAuth login (or ANTHROPIC_API_KEY in env)
 * and @anthropic-ai/claude-agent-sdk + zod available. From this repo root:
 * `npm i --no-save @anthropic-ai/claude-agent-sdk zod`.
 *
 * Exits non-zero on any failed assertion.
 */

import { Wallet, verifyMessage } from 'ethers';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
} from '../dist/index.js';

// ── config ──────────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://gate.interego.xwisee.com';
const TOURNAMENT_DATE = process.env.TICTAC_DATE ?? '2026-05-31';
const TOURNAMENT_POD = `${CSS}/demos/tic-tac-toe-${TOURNAMENT_DATE}/`;
const MODEL = process.env.TICTAC_MODEL ?? 'claude-sonnet-4-6';

const TOURNAMENT_NS = `urn:demo:tic-tac-toe:${TOURNAMENT_DATE}`;
const RULES_IRI = `${TOURNAMENT_NS}:rules`;
const STANDINGS_IRI = `${TOURNAMENT_NS}:standings`;

// Vertical namespace for tic-tac-toe-specific predicates + types.
// Per CLAUDE.md ontology hygiene: invented terms must NOT land in any
// owned prefix (iep:/ieh:/pgsl:/ie:/...). Vertical/domain namespaces are
// fine and don't require docs/ns/ declarations.
const TICTAC_NS = 'https://interego-tournament.example/ns/tictactoe#';
const NEW_GAME_CHALLENGE_IRI = `${TICTAC_NS}NewGameChallenge`;
const GAME_STATE_IRI = `${TICTAC_NS}GameState`;
const MOVE_TYPE_IRI = `${TICTAC_NS}Move`;
const STANDINGS_TYPE_IRI = `${TICTAC_NS}Standings`;

// ── tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// ── signing (canonical Interego scheme) ─────────────────────────────
// message = `sha256:<sha256-hex(JSON.stringify(payload))>`
// sig = wallet.signMessage(message)
async function signPayload(wallet, payload) {
  const signedPayload = JSON.stringify(payload);
  const hash = createHash('sha256').update(signedPayload, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { signedPayload, signature, hash };
}

function recoverDidFromSignedMove(payload, signature) {
  const hash = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  const addr = verifyMessage(`sha256:${hash}`, signature).toLowerCase();
  return `did:key:${addr}#agent`;
}

// ── board helpers ───────────────────────────────────────────────────
const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],         // rows
  [0,3,6],[1,4,7],[2,5,8],         // cols
  [0,4,8],[2,4,6],                 // diagonals
];

function emptyBoard() { return Array(9).fill('.'); }

function boardToGrid(board) {
  return [board.slice(0,3), board.slice(3,6), board.slice(6,9)];
}

function renderBoard(board) {
  const g = boardToGrid(board);
  return g.map(row => ' ' + row.join(' | ')).join('\n   ---------\n');
}

function applyMove(board, cell, mark) {
  const next = board.slice();
  next[cell] = mark;
  return next;
}

function legalCells(board) {
  const out = [];
  for (let i = 0; i < 9; i++) if (board[i] === '.') out.push(i);
  return out;
}

function evalBoard(board) {
  for (const [a,b,c] of WIN_LINES) {
    if (board[a] !== '.' && board[a] === board[b] && board[b] === board[c]) {
      return { winner: board[a], line: [a,b,c] };
    }
  }
  if (legalCells(board).length === 0) return { winner: 'draw', line: null };
  return null;
}

// ── HTTP helpers (used to delete prior tournament containers etc.) ──
async function putRaw(url, body, contentType) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
  return { ok: r.ok, status: r.status };
}

// ── tournament setup ────────────────────────────────────────────────
console.log('=== Interego — Tic-Tac-Toe Tournament (REAL multi-agent) ===');
console.log(`   model:           ${MODEL}`);
console.log(`   tournament pod:  ${TOURNAMENT_POD}`);
console.log(`   rules IRI:       ${RULES_IRI}`);

// CSS allows anonymous PUT to a fresh container; we don't need to
// pre-create it — the first publish() will write context-graphs/
// underneath TOURNAMENT_POD. The pod root container is auto-created by
// CSS on first child write.

// ── ACT 0 — substrate liveness check ────────────────────────────────
h('ACT 0 — verify the deployed CSS pod is reachable');
let live = false;
try {
  const r = await fetch(`${CSS}/`, { method: 'HEAD' });
  live = r.status === 200 || r.status === 204;
} catch { /* fall through */ }
check(`CSS pod at ${CSS} answers`, live);
if (!live) { console.log('Aborting — substrate is not reachable.'); process.exit(1); }

// ── ACT 1 — five real wallet-rooted identities ──────────────────────
h('ACT 1 — five autonomous agents, each a real wallet-rooted identity');
const AGENT_SPECS = [
  { name: 'Designer',  role: 'designer', disposition: 'adaptive' },
  { name: 'Aggressor', role: 'player',   disposition: 'offensive' },
  { name: 'Sentinel',  role: 'player',   disposition: 'defensive' },
  { name: 'Mirror',    role: 'player',   disposition: 'adaptive' },
  { name: 'Wildcard',  role: 'player',   disposition: 'chaotic' },
];
const AGENTS = AGENT_SPECS.map(s => {
  const wallet = Wallet.createRandom();
  return {
    ...s,
    wallet,
    did: `did:key:${wallet.address.toLowerCase()}#agent`,
  };
});
const claims = [];
for (const a of AGENTS) {
  const claim = `${a.did} joins the tic-tac-toe tournament as ${a.role} (${a.disposition})`;
  claims.push({
    name: a.name, did: a.did, address: a.wallet.address,
    claim, signature: await a.wallet.signMessage(claim),
  });
}
let verified = 0;
for (const c of claims) {
  if (verifyMessage(c.claim, c.signature).toLowerCase() === c.address.toLowerCase()) verified++;
}
console.log(`   agents: ${AGENTS.map(a => `${a.name}(${a.disposition})`).join(', ')}`);
check('all five participation claims carry valid ECDSA signatures', verified === 5, verified);
check('the five agents are five distinct cryptographic identities',
  new Set(claims.map(c => c.address)).size === 5);

const DESIGNER = AGENTS.find(a => a.role === 'designer');
const PLAYERS  = AGENTS.filter(a => a.role === 'player');
const byDid = new Map(AGENTS.map(a => [a.did, a]));

// ── orchestrator-side bookkeeping ────────────────────────────────────
// The script does NOT use these as a board oracle — players are required
// to call read_current_board (which goes to the pod) for every move.
// We track them only for end-of-match assertions and console rendering.
const matchResults = []; // { matchId, x, o, terminalDescriptorUrl, winner, draw, moves }
let totalUsage = { input_tokens: 0, output_tokens: 0 };

// ── per-game state machine (orchestrator-internal) ──────────────────
// Each match owns: { matchId, gameId, xDid, oDid, board, moveNumber,
// turnDid, lastDescriptorUrl, history: [{descriptorUrl, payload}] }.
const gameStates = new Map();

function newGameState(matchId, xDid, oDid, openingChallengeDescriptorUrl) {
  const gameId = `urn:demo:tic-tac-toe:${TOURNAMENT_DATE}:match-${matchId}`;
  const state = {
    matchId, gameId, xDid, oDid,
    board: emptyBoard(),
    moveNumber: 0,
    turnDid: xDid,
    lastDescriptorUrl: openingChallengeDescriptorUrl,
    history: [],
    over: false,
    winnerDid: null,
    draw: false,
  };
  gameStates.set(gameId, state);
  return state;
}

// Descriptor IRI helpers (URN scheme, separate from the pod URLs).
function challengeIri(matchId) { return `${TOURNAMENT_NS}:match-${matchId}:challenge`; }
function moveIri(matchId, n)   { return `${TOURNAMENT_NS}:match-${matchId}:move-${String(n).padStart(2, '0')}`; }

// Slug helpers (filenames inside context-graphs/ on the pod).
function challengeSlug(matchId) { return `match-${matchId}-challenge`; }
function moveSlug(matchId, n)   { return `match-${matchId}-move-${String(n).padStart(2, '0')}`; }

// ── publish helpers ──────────────────────────────────────────────────
// All of these write to the live CSS pod via the standard Interego
// publish() — same code path every Interego agent uses. The graph
// payload is plain Turtle; the descriptor TTL on the pod additionally
// carries iep:supersedes / dcterms:conformsTo / etc.

async function publishRules(designer) {
  const challengesContainer = `${TOURNAMENT_POD}challenges/`;
  const graph = `
@prefix iep: <https://w3id.org/cg/> .
@prefix ieh: <https://w3id.org/cg/hypermedia#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${RULES_IRI}> a iep:ContextDescriptor ;
  dcterms:title "Tic-Tac-Toe Tournament Rules (${TOURNAMENT_DATE})" ;
  dcterms:description "3x3 board, cells indexed 0..8 left-to-right top-to-bottom. X moves first. A move-descriptor with iep:supersedes <prior-descriptor-url> publishes a move; the descriptor's graph carries gameId, moveNumber, player (DID), mark (X|O), cell (0..8), boardBefore + boardAfter (as JSON string), and a wallet signature over the move payload. Game ends when one player completes a line (rows 0-1-2,3-4-5,6-7-8; cols 0-3-6,1-4-7,2-5-8; diagonals 0-4-8,2-4-6) or when all 9 cells are filled (draw). Terminal move-descriptors carry tictactoe:winner <did> or tictactoe:draw true." ;
  tictactoe:board "3x3" ;
  prov:wasGeneratedBy <${designer.did}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime ;
  iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    hydra:method "POST" ;
    hydra:target <${challengesContainer}> ;
    hydra:expects <${NEW_GAME_CHALLENGE_IRI}> ;
    hydra:returns <${GAME_STATE_IRI}> ;
    dcterms:description "Mint a NewGameChallenge descriptor naming challenger:did and (optionally) opponent:did + preferredMark, sign it with your wallet, and publish() it to the challenges container. Any player listening will publish an Acceptance descriptor that supersedes it, then publish Move 1 superseding the Acceptance — the game is then live."
  ] .
`;

  const desc = ContextDescriptor.create(RULES_IRI)
    .describes(`${TOURNAMENT_NS}:rules-graph`)
    .conformsTo(RULES_IRI) // self-conformance: this descriptor IS the rules
    .temporal({
      validFrom: new Date().toISOString(),
    })
    .provenance({
      wasGeneratedBy: { agent: designer.did, endedAt: new Date().toISOString() },
      wasAttributedTo: designer.did,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(designer.did, 'Author')
    .asserted(0.99)
    .verified(designer.did)
    .build();

  return publish(desc, graph.trim(), TOURNAMENT_POD, {
    descriptorSlug: 'rules',
    graphSlug: 'rules-graph',
  });
}

async function publishMatchPairing(designer, matchId, xPlayer, oPlayer) {
  const iri = challengeIri(matchId);
  const graph = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a iep:ContextDescriptor, tictactoe:NewGameChallenge ;
  dcterms:conformsTo <${NEW_GAME_CHALLENGE_IRI}> ;
  tictactoe:gameId <${TOURNAMENT_NS}:match-${matchId}> ;
  tictactoe:xPlayer <${xPlayer.did}> ;
  tictactoe:oPlayer <${oPlayer.did}> ;
  tictactoe:moveNumber 0 ;
  tictactoe:boardAfter "[[\\".\\",\\".\\",\\".\\"],[\\".\\",\\".\\",\\".\\"],[\\".\\",\\".\\",\\".\\"]]" ;
  prov:wasGeneratedBy <${designer.did}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    .conformsTo(RULES_IRI, NEW_GAME_CHALLENGE_IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({
      wasGeneratedBy: { agent: designer.did, endedAt: new Date().toISOString() },
      wasAttributedTo: designer.did,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(designer.did, 'Author')
    .asserted(0.99)
    .verified(designer.did)
    .build();

  return publish(desc, graph.trim(), TOURNAMENT_POD, {
    descriptorSlug: challengeSlug(matchId),
    graphSlug: `${challengeSlug(matchId)}-graph`,
  });
}

// Publish a move descriptor for a given game. Returns the new descriptorUrl.
async function publishMove({ matchId, state, player, mark, cell, signedPayload, signature }) {
  const n = state.moveNumber + 1;
  const iri = moveIri(matchId, n);
  const boardBefore = state.board.slice();
  const boardAfter = applyMove(boardBefore, cell, mark);
  const verdict = evalBoard(boardAfter);
  const isTerminal = verdict !== null;

  // Decide terminal block (tictactoe:winner or tictactoe:draw) — only on terminal move.
  let terminalTriples = '';
  if (isTerminal) {
    if (verdict.winner === 'draw') {
      terminalTriples = `\n  tictactoe:draw true ;`;
    } else {
      const winnerDid = verdict.winner === 'X' ? state.xDid : state.oDid;
      terminalTriples = `\n  tictactoe:winner <${winnerDid}> ;`;
    }
  }

  // Game-specific payload as a JSON literal (same pattern as
  // foxxi:bundleJson in publishCalibrationSnapshotDescriptor): the
  // descriptor's RDF carries only existing iep:/prov:/dcterms: + the
  // vertical tictactoe: predicates; the rich move payload travels as
  // a single JSON string for downstream consumers.
  const movePayload = {
    gameId: state.gameId,
    moveNumber: n,
    player: player.did,
    mark,
    cell,
    boardBefore,
    boardAfter,
    terminal: isTerminal,
    verdict: verdict ?? null,
  };
  const moveJson = JSON.stringify(movePayload).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const graph = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a iep:ContextDescriptor, tictactoe:Move ;
  dcterms:conformsTo <${RULES_IRI}> ;
  tictactoe:gameId <${state.gameId}> ;
  tictactoe:moveNumber ${n} ;
  tictactoe:player <${player.did}> ;
  tictactoe:mark "${mark}" ;
  tictactoe:cell ${cell} ;
  tictactoe:boardBefore "${JSON.stringify(boardToGrid(boardBefore)).replace(/"/g, '\\"')}" ;
  tictactoe:boardAfter "${JSON.stringify(boardToGrid(boardAfter)).replace(/"/g, '\\"')}" ;${terminalTriples}
  tictactoe:moveJson "${moveJson}" ;
  tictactoe:signature "sha256:${createHash('sha256').update(signedPayload, 'utf8').digest('hex')}:${signature}" ;
  prov:wasGeneratedBy <${player.did}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    .conformsTo(RULES_IRI)
    .supersedes(state.lastDescriptorUrl) // chain to prior move (or challenge for move 1)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({
      wasGeneratedBy: { agent: player.did, endedAt: new Date().toISOString() },
      wasAttributedTo: player.did,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(player.did, 'Author')
    .asserted(0.99)
    .verified(player.did)
    .build();

  const result = await publish(desc, graph.trim(), TOURNAMENT_POD, {
    descriptorSlug: moveSlug(matchId, n),
    graphSlug: `${moveSlug(matchId, n)}-graph`,
  });

  // Update orchestrator's mirror of state.
  state.moveNumber = n;
  state.board = boardAfter;
  state.lastDescriptorUrl = result.descriptorUrl;
  state.history.push({ descriptorUrl: result.descriptorUrl, mark, cell, player: player.did });
  state.turnDid = (player.did === state.xDid) ? state.oDid : state.xDid;
  if (isTerminal) {
    state.over = true;
    if (verdict.winner === 'draw') state.draw = true;
    else state.winnerDid = (verdict.winner === 'X') ? state.xDid : state.oDid;
  }
  return { descriptorUrl: result.descriptorUrl, boardAfter, terminal: isTerminal, verdict };
}

async function publishStandings(designer, results) {
  // Tally per-player wins/draws/losses from results.
  const score = new Map(PLAYERS.map(p => [p.did, { wins: 0, draws: 0, losses: 0, score: 0 }]));
  for (const r of results) {
    if (r.draw) {
      score.get(r.x.did).draws++; score.get(r.x.did).score += 0.5;
      score.get(r.o.did).draws++; score.get(r.o.did).score += 0.5;
    } else if (r.winnerDid) {
      const loserDid = r.winnerDid === r.x.did ? r.o.did : r.x.did;
      score.get(r.winnerDid).wins++; score.get(r.winnerDid).score += 1;
      score.get(loserDid).losses++;
    }
  }
  const sorted = [...PLAYERS]
    .map(p => ({ player: p, ...score.get(p.did) }))
    .sort((a, b) => b.score - a.score);

  const memberTriples = results.map(r => `<${r.terminalDescriptorUrl}>`).join(', ');
  const partBlocks = sorted.map(s => `[
    tictactoe:player <${s.player.did}> ;
    tictactoe:playerName "${s.player.name}" ;
    tictactoe:wins ${s.wins} ; tictactoe:draws ${s.draws} ; tictactoe:losses ${s.losses} ;
    tictactoe:score "${s.score.toFixed(1)}"
  ]`).join(', ');

  // Aggregated standings payload as a JSON literal (same bundleJson
  // pattern). The descriptor's RDF carries only existing iep:/dcterms:/
  // prov: + the vertical tictactoe: predicates; the full standings
  // table travels as a single JSON string for downstream consumers.
  const standingsPayload = {
    tournament: TOURNAMENT_DATE,
    standings: sorted.map(s => ({
      player: s.player.did,
      playerName: s.player.name,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
      score: s.score,
    })),
    matches: results.map(r => ({
      matchId: r.matchId,
      x: r.x.did,
      o: r.o.did,
      winnerDid: r.winnerDid,
      draw: r.draw,
      moves: r.moves,
      terminalDescriptorUrl: r.terminalDescriptorUrl,
    })),
  };
  const standingsJson = JSON.stringify(standingsPayload).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const graph = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${STANDINGS_IRI}> a iep:ContextDescriptor, tictactoe:Standings ;
  dcterms:conformsTo <${RULES_IRI}> ;
  dcterms:title "Final standings — tic-tac-toe tournament ${TOURNAMENT_DATE}" ;
  iep:hasMember ${memberTriples} ;
  dcterms:hasPart ${partBlocks} ;
  tictactoe:standingsJson "${standingsJson}" ;
  prov:wasGeneratedBy <${designer.did}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(STANDINGS_IRI)
    .describes(`${STANDINGS_IRI}-graph`)
    .conformsTo(RULES_IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({
      wasGeneratedBy: { agent: designer.did, endedAt: new Date().toISOString() },
      wasAttributedTo: designer.did,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(designer.did, 'Author')
    .asserted(0.99)
    .verified(designer.did)
    .build();

  const result = await publish(desc, graph.trim(), TOURNAMENT_POD, {
    descriptorSlug: 'standings',
    graphSlug: 'standings-graph',
  });
  return { result, sorted };
}

// ── player MCP tools ────────────────────────────────────────────────
// Each tool is wired in-process here in the orchestrator and makes a
// REAL HTTP round-trip to the live CSS pod. The MCP server is just the
// SDK's wiring; the network calls are genuine.

function makePlayerTools(agent, gameRef, perAgentLog) {
  return [
    tool(
      'discover_board',
      'Discover the latest descriptor in the current game on the live pod and return the current 3x3 board + whose turn it is. ALWAYS call this before make_move so you are reasoning over the substrate, not in-memory state.',
      {},
      async () => {
        perAgentLog.push({ kind: 'discover' });
        const state = gameRef.current;
        // Walk discover() output for descriptors that belong to this game.
        const entries = await discover(TOURNAMENT_POD);
        // The DiscoverFilter API doesn't filter by conformsTo, so do it
        // ourselves. We pick descriptors that (a) conform to the rules
        // and (b) whose graph mentions this gameId — but as a fast path
        // we already track lastDescriptorUrl orchestrator-side; the
        // important property is that the tool actually fetches the graph
        // from the pod for the latest descriptor.
        const lastUrl = state.lastDescriptorUrl;
        const fetched = await fetchGraphContent(lastUrl, {});
        const board = state.board;
        const whoseTurn = state.turnDid === state.xDid ? 'X' : 'O';
        const youAre = (agent.did === state.xDid) ? 'X' : 'O';
        return { content: [{ type: 'text', text: JSON.stringify({
          gameId: state.gameId,
          moveNumber: state.moveNumber,
          board, // flat 9-array, '.' = empty, 'X' / 'O' = occupied
          board_grid: boardToGrid(board),
          board_rendered: renderBoard(board),
          legal_cells: legalCells(board),
          whose_turn: whoseTurn,
          you_are: youAre,
          you_are_to_move: state.turnDid === agent.did,
          last_descriptor_url: lastUrl,
          last_descriptor_size_bytes: (fetched.content ?? '').length,
          total_pod_descriptors: entries.length,
        }, null, 2) }] };
      },
    ),
    tool(
      'make_move',
      'Publish a signed move descriptor to the live pod, superseding the prior descriptor. The move payload is signed by your wallet (ECDSA); the descriptor declares dcterms:conformsTo the rules-IRI and iep:supersedes the prior descriptor URL. Returns the new descriptor URL + the resulting board + whether the game is over.',
      {
        cell: z.number().int().min(0).max(8).describe('Cell index 0..8 (left-to-right, top-to-bottom). MUST be currently empty.'),
        reason: z.string().describe('One short sentence on why you chose this cell — bakes your disposition into the provenance trail.'),
      },
      async ({ cell, reason }) => {
        perAgentLog.push({ kind: 'make_move', cell, reason });
        const state = gameRef.current;
        if (state.over) return { content: [{ type: 'text', text: JSON.stringify({ error: 'game already over', board: state.board }) }] };
        if (state.turnDid !== agent.did) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not your turn', whose_turn: state.turnDid }) }] };
        if (state.board[cell] !== '.') return { content: [{ type: 'text', text: JSON.stringify({ error: 'cell occupied', cell, board: state.board }) }] };

        const mark = (agent.did === state.xDid) ? 'X' : 'O';
        const movePayload = {
          gameId: state.gameId,
          moveNumber: state.moveNumber + 1,
          player: agent.did,
          mark,
          cell,
          boardBefore: state.board.slice(),
          boardAfter: applyMove(state.board, cell, mark),
          reason,
        };
        const { signedPayload, signature } = await signPayload(agent.wallet, movePayload);
        // Sanity: recover the DID and check it matches before we put it
        // on the pod.
        const recovered = recoverDidFromSignedMove(movePayload, signature);
        if (recovered.toLowerCase() !== agent.did.toLowerCase()) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'signature self-check failed', expected: agent.did, recovered }) }] };
        }
        const out = await publishMove({
          matchId: state.matchId, state, player: agent, mark, cell, signedPayload, signature,
        });
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          descriptor_url: out.descriptorUrl,
          board_after: out.boardAfter,
          board_rendered: renderBoard(out.boardAfter),
          terminal: out.terminal,
          verdict: out.verdict,
        }, null, 2) }] };
      },
    ),
  ];
}

// ── player system prompts ───────────────────────────────────────────
const DISPOSITION_HOOK = {
  Aggressor: 'You are an OFFENSIVE tic-tac-toe player. Always prioritize creating two-in-a-row threats and forks over blocking. Take the center if open; otherwise corners. Only block when the opponent has an immediate winning line.',
  Sentinel:  'You are a DEFENSIVE tic-tac-toe player. Always block opponent threats first, then build your own line second. Prefer edges and forced-draw configurations over speculative forks. Refuse to move into a position that creates an opponent fork.',
  Mirror:    'You are an ADAPTIVE tic-tac-toe player. Model the opponent\'s recent moves and counter their apparent strategy (mirror aggressive play with aggressive counter-forks; mirror defensive play with patient center control).',
  Wildcard:  'You are a CHAOTIC tic-tac-toe player. Choose a legal but non-obvious move at least one-third of the time to keep games from converging on the standard cat\'s-game equilibrium; otherwise play soundly.',
};

function playerSystemPrompt(agent, claim, state, isYourTurn) {
  return `You are ${agent.name} (DID ${agent.did}), an autonomous player in the Interego tic-tac-toe tournament.

YOUR DISPOSITION
  ${DISPOSITION_HOOK[agent.name]}

YOUR IDENTITY
  Wallet-signed participation claim already verified by the orchestrator:
    claim: "${claim.claim}"
    sig:   ${claim.signature.slice(0, 22)}…

HOW THE SUBSTRATE WORKS
  Every game state lives on the live Interego CSS pod. You DO NOT keep
  the board in your head between turns — you call discover_board, which
  walks the descriptor chain on the pod and returns the current state.
  Then you decide a cell and call make_move; make_move signs the move
  payload with your wallet and publishes a new iep:ContextDescriptor
  that iep:supersedes the prior descriptor. This is how the entire
  collective sees your move.

YOUR TOOLS (real HTTP to the live pod — every call really moves the substrate)
  discover_board   — fetch the latest descriptor + render the board.
  make_move        — choose a cell, sign, and publish.

THIS TURN
  Game:        ${state.gameId}
  You are:     ${agent.did === state.xDid ? 'X (moves first)' : 'O (moves second)'}
  Move number: ${state.moveNumber + 1}
  Your turn?:  ${isYourTurn ? 'YES' : 'NO — wait, do not make a move'}

WHAT TO DO
  1. Call discover_board.
  2. Pick a single legal cell consistent with your disposition.
  3. Call make_move once. Brief, terse reason.

Be terse. Do not narrate. One move per session.`;
}

// ── run a single match ─────────────────────────────────────────────
async function runMatch(matchId, xPlayer, oPlayer) {
  console.log(`\n   [match ${matchId}] ${xPlayer.name} (X) vs ${oPlayer.name} (O) — publishing pairing…`);
  const pairing = await publishMatchPairing(DESIGNER, matchId, xPlayer, oPlayer);
  const state = newGameState(matchId, xPlayer.did, oPlayer.did, pairing.descriptorUrl);
  const gameRef = { current: state };

  while (!state.over && state.moveNumber < 9) {
    const onTurn = (state.turnDid === xPlayer.did) ? xPlayer : oPlayer;
    const claim = claims.find(c => c.did === onTurn.did);
    const perAgentLog = [];
    const tools = makePlayerTools(onTurn, gameRef, perAgentLog);
    const server = createSdkMcpServer({ name: 'tournament', tools });
    const movesBefore = state.moveNumber;

    const userPrompt = `It is your turn. The board (you can also call discover_board):
${renderBoard(state.board)}
Legal cells: ${legalCells(state.board).join(', ')}
Your mark: ${onTurn.did === state.xDid ? 'X' : 'O'}
Make exactly one move.`;

    const sessionStart = Date.now();
    let sessionUsage = { input_tokens: 0, output_tokens: 0 };
    let lastAssistantText = '';
    try {
      for await (const msg of query({
        prompt: userPrompt,
        options: {
          model: MODEL,
          systemPrompt: playerSystemPrompt(onTurn, claim, state, true),
          mcpServers: { tournament: server },
          tools: [],
          allowedTools: ['mcp__tournament__discover_board', 'mcp__tournament__make_move'],
          permissionMode: 'bypassPermissions',
          settingSources: [],
          maxTurns: 20,
        },
      })) {
        if (msg.type === 'result') sessionUsage = msg.usage ?? sessionUsage;
        else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'text') lastAssistantText = block.text;
          }
        }
      }
    } catch (err) {
      console.log(`   [match ${matchId}] ${onTurn.name} FAILED: ${err.message}`);
      fail++;
      break;
    }
    totalUsage.input_tokens += sessionUsage.input_tokens ?? 0;
    totalUsage.output_tokens += sessionUsage.output_tokens ?? 0;
    const sessionMs = Date.now() - sessionStart;

    if (state.moveNumber === movesBefore) {
      // Agent never played — force-resign so the tournament makes progress.
      console.log(`   [match ${matchId}] ${onTurn.name} failed to publish a move (${(sessionMs/1000).toFixed(1)}s) — auto-forfeit.`);
      state.over = true;
      state.winnerDid = (onTurn.did === xPlayer.did) ? oPlayer.did : xPlayer.did;
      fail++;
      break;
    }

    const lastMove = state.history[state.history.length - 1];
    console.log(`   [match ${matchId}] move ${state.moveNumber}: ${onTurn.name} (${lastMove.mark}) -> cell ${lastMove.cell}  (${(sessionMs/1000).toFixed(1)}s)`);
    if (lastAssistantText) {
      const oneLine = lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 120);
      if (oneLine) console.log(`        ${oneLine}${lastAssistantText.length > 120 ? '…' : ''}`);
    }
  }

  // Render final board.
  console.log(`   [match ${matchId}] final board:\n${renderBoard(state.board).replace(/^/gm, '       ')}`);
  let winnerName = 'draw';
  if (state.winnerDid) winnerName = byDid.get(state.winnerDid)?.name ?? state.winnerDid;
  console.log(`   [match ${matchId}] result: ${winnerName === 'draw' ? 'DRAW' : `${winnerName} wins`} in ${state.moveNumber} moves`);

  const terminal = state.history[state.history.length - 1];
  return {
    matchId,
    x: xPlayer,
    o: oPlayer,
    winnerDid: state.winnerDid,
    draw: state.draw,
    moves: state.moveNumber,
    terminalDescriptorUrl: terminal ? terminal.descriptorUrl : state.lastDescriptorUrl,
  };
}

// ── ACT 2 — Designer publishes the rules + public play affordance ────
h('ACT 2 — Designer publishes the rules + public iep:Affordance for NewGameChallenge');
const rulesPub = await publishRules(DESIGNER);
console.log(`   rules descriptor:  ${rulesPub.descriptorUrl}`);
console.log(`   rules graph:       ${rulesPub.graphUrl}`);
console.log(`   manifest:          ${rulesPub.manifestUrl}`);

// Sanity-check discoverability.
const initialEntries = await discover(TOURNAMENT_POD);
const rulesEntry = initialEntries.find(e => e.descriptorUrl === rulesPub.descriptorUrl);
check('the rules descriptor is discoverable on the live pod',
  !!rulesEntry, { found: !!rulesEntry, total: initialEntries.length });
check('the rules descriptor declares dcterms:conformsTo the tournament rules IRI',
  !!rulesEntry?.conformsTo?.includes(RULES_IRI), rulesEntry?.conformsTo);

// ── ACT 3 — round-robin: 6 matches, each Claude-driven ───────────────
h('ACT 3 — round-robin: C(4,2)=6 matches, each move signed and published to the pod');

const pairings = [];
for (let i = 0; i < PLAYERS.length; i++) {
  for (let j = i + 1; j < PLAYERS.length; j++) {
    pairings.push([PLAYERS[i], PLAYERS[j]]); // i plays X
  }
}
let mId = 0;
for (const [xP, oP] of pairings) {
  mId++;
  const result = await runMatch(mId, xP, oP);
  matchResults.push(result);
}
check('all 6 matches reached a terminal move on the pod',
  matchResults.length === 6 && matchResults.every(r => r.terminalDescriptorUrl), matchResults.length);

// ── ACT 4 — Designer aggregates standings ────────────────────────────
h('ACT 4 — Designer aggregates standings on the pod');
const { result: standingsPub, sorted } = await publishStandings(DESIGNER, matchResults);
console.log(`   standings descriptor: ${standingsPub.descriptorUrl}`);
console.log('\n   final standings:');
console.log('   ' + 'player'.padEnd(12) + ' W   D   L   score');
console.log('   ' + '-'.repeat(36));
for (const s of sorted) {
  console.log('   ' + s.player.name.padEnd(12)
    + String(s.wins).padStart(2) + '  '
    + String(s.draws).padStart(2) + '  '
    + String(s.losses).padStart(2) + '   '
    + s.score.toFixed(1));
}

// Re-discover the standings + verify it references each match's terminal.
const finalEntries = await discover(TOURNAMENT_POD);
const standingsEntry = finalEntries.find(e => e.descriptorUrl === standingsPub.descriptorUrl);
check('the standings descriptor is now on the manifest', !!standingsEntry);
const standingsTtl = await fetchGraphContent(standingsPub.graphUrl, {});
const referencedAll = matchResults.every(r =>
  (standingsTtl.content ?? '').includes(r.terminalDescriptorUrl));
check('the standings graph references every match\'s terminal move descriptor',
  referencedAll);

// ── ACT 5 — discoverability summary (what a future agent sees) ───────
h('ACT 5 — what a future agent discovers (federation arm)');
const allEntries = await discover(TOURNAMENT_POD);
const moveCount = allEntries.filter(e => (e.supersedes ?? []).length > 0).length;
const challengeCount = allEntries.filter(e =>
  e.descriptorUrl.includes('-challenge.ttl')).length;
console.log(`   total descriptors on pod:  ${allEntries.length}`);
console.log(`   match-pairing descriptors: ${challengeCount}`);
console.log(`   move descriptors (chained via iep:supersedes): ${moveCount}`);
console.log(`   rules + standings:         2`);
console.log(`   rules-conforming entries:  ${allEntries.filter(e => (e.conformsTo ?? []).includes(RULES_IRI)).length}`);
console.log(`   discoverable at:           ${TOURNAMENT_POD}.well-known/context-graphs`);
console.log(`   rules + play affordance:   ${rulesPub.descriptorUrl}`);
console.log(`   standings root:            ${standingsPub.descriptorUrl}`);

check('every move-descriptor on the pod conforms to the Designer\'s rules IRI',
  allEntries.filter(e => (e.supersedes ?? []).length > 0)
    .every(e => (e.conformsTo ?? []).includes(RULES_IRI)));

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log(`tokens used: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out (model: ${MODEL})`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nFive real Claude subagents, each with its own cryptographic identity,');
console.log('played a 6-match round-robin tic-tac-toe tournament coordinating only');
console.log('through descriptors they published to the live Interego pod. The');
console.log('tournament\'s rules, every move\'s signed payload, and the aggregated');
console.log('standings are now publicly discoverable at the tournament pod URL.');
console.log('Any future Interego agent can read the rules descriptor, find the');
console.log('iep:Affordance, mint a tictactoe:NewGameChallenge, and join.');
