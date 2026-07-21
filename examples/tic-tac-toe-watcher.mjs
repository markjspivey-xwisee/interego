/**
 * Interego — Tic-Tac-Toe Collective Watcher (persistent agent).
 *
 *   npx tsx examples/tic-tac-toe-watcher.mjs
 *
 * A persistent agent that holds the tic-tac-toe collective open for
 * challenges from any Interego agent. It demonstrates the canonical
 * loop documented in docs/PERSISTENT-AGENT-LOOP.md: discover what is
 * new on the pod, act on it, then call recordHeartbeatTickIfChanged
 * from src/passport/heartbeat.ts so the collective's passport gets a
 * LifeEvent exactly when the tick produced something biographically
 * significant — and not otherwise.
 *
 * What is real here:
 *
 *   · Four wallet-rooted player identities — Aggressor, Sentinel,
 *     Mirror, Wildcard — each with the same disposition the
 *     round-robin tournament demo gives them. Wallet keys are loaded
 *     from env vars if present (AGGRESSOR_KEY / SENTINEL_KEY /
 *     MIRROR_KEY / WILDCARD_KEY) so the DIDs survive a restart;
 *     otherwise fresh keys are minted and the script warns that
 *     identity will not persist.
 *   · A "collective roster" descriptor published once on startup so
 *     challengers know the four current DIDs + dispositions to target.
 *   · A poll loop on POLL_INTERVAL_MS (30 s by default — half the
 *     persistent-agent doc's 60 s, tightened for demo responsiveness):
 *
 *       1. discover() the tournament pod and find tictactoe:NewGameChallenge
 *          descriptors that have not yet been accepted (no later
 *          descriptor iep:supersedes them).
 *       2. For each pending challenge, verify the challenger's
 *          signature, pick the requested collective player (by name or
 *          DID; least-recently-played wins ties), publish a signed
 *          tictactoe:ChallengeAccepted descriptor that supersedes the
 *          challenge, and spawn a Claude Agent SDK player session to
 *          play out the game one move at a time — same
 *          discover_board / make_move tool pair the tournament demo
 *          uses.
 *       3. For each game already in progress, check whether the
 *          opponent has made a move the collective has not responded
 *          to yet, and run the appropriate player agent for one
 *          response.
 *       4. Build a HeartbeatOutcomes object for the tick (which
 *          descriptors were published, which games reached terminal)
 *          and call recordHeartbeatTickIfChanged on the shared
 *          collective passport. Uneventful ticks do not bump the
 *          passport version.
 *
 *   · Anyone running examples/tic-tac-toe-challenge.mjs — or any
 *     Interego agent that mints a properly-typed challenge descriptor
 *     and publishes it to the tournament pod — gets a real game
 *     against a real Claude-driven player, signed and chained move by
 *     move into the pod's descriptor graph.
 *
 * Concurrency: pending challenges are all accepted immediately within
 * a tick (the acceptance descriptors publish in parallel), but only
 * one in-progress game advances per tick. This keeps the console log
 * legible while still making forward progress on every game on every
 * pass.
 *
 * SIGINT / SIGTERM finish any in-flight move before exiting.
 *
 * Requires an active Claude Code OAuth login (or ANTHROPIC_API_KEY in
 * env) and @anthropic-ai/claude-agent-sdk + zod available. From this
 * repo root: `npm i --no-save @anthropic-ai/claude-agent-sdk zod`.
 */

import { verifyMessage } from 'ethers';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
  withTransientRetry,
  loadAgentKeypair,
} from '../dist/index.js';
import {
  recordHeartbeatTickIfChanged,
} from '@interego/passport';

// ── config ──────────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://gate.interego.xwisee.com';
const TOURNAMENT_DATE = process.env.TICTAC_DATE ?? '2026-05-31';
const TOURNAMENT_POD = `${CSS}/demos/tic-tac-toe-${TOURNAMENT_DATE}/`;
const MODEL = process.env.TICTAC_MODEL ?? 'claude-sonnet-4-6';
const POLL_INTERVAL_MS = Number(process.env.TICTAC_POLL_MS ?? 30_000);

// Relay notification surface (rev 190+). When set, the watcher also
// opens an SSE connection to /notifications/<podSlug> on the relay
// and triggers an out-of-band tick the moment a new descriptor lands
// on the tournament pod. The polling interval above is kept as a
// safety net for any case where the SSE link drops (network blips,
// relay restarts, etc.) — the two paths are belt-and-suspenders.
const RELAY_URL = (process.env.CG_RELAY_URL ?? process.env.MCP_RELAY_URL
  ?? 'https://relay.interego.xwisee.com').replace(/\/$/, '');
const SSE_ENABLED = process.env.TICTAC_SSE_DISABLED !== '1';

const TOURNAMENT_NS = `urn:demo:tic-tac-toe:${TOURNAMENT_DATE}`;
const RULES_IRI = `${TOURNAMENT_NS}:rules`;

// Vertical namespace for tic-tac-toe-specific predicates + types,
// identical to the tournament script. Not an owned prefix; no
// docs/ns/ entry required.
const TICTAC_NS = 'https://interego-tournament.example/ns/tictactoe#';
const NEW_GAME_CHALLENGE_IRI = `${TICTAC_NS}NewGameChallenge`;
const CHALLENGE_ACCEPTED_IRI = `${TICTAC_NS}ChallengeAccepted`;
const COLLECTIVE_ROSTER_IRI = `${TICTAC_NS}CollectiveRoster`;
const MOVE_TYPE_IRI = `${TICTAC_NS}Move`;
const GAME_STATE_IRI = `${TICTAC_NS}GameState`;

// ── signing (canonical Interego scheme; identical to the tournament) ─
async function signPayload(wallet, payload) {
  const signedPayload = JSON.stringify(payload);
  const hash = createHash('sha256').update(signedPayload, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { signedPayload, signature, hash };
}

function recoverDidFromSigned(payload, signature) {
  const hash = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  const addr = verifyMessage(`sha256:${hash}`, signature).toLowerCase();
  return `did:key:${addr}#agent`;
}

// ── board helpers (identical to the tournament) ─────────────────────
const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

const emptyBoard = () => Array(9).fill('.');
const boardToGrid = (b) => [b.slice(0,3), b.slice(3,6), b.slice(6,9)];
const renderBoard = (b) => boardToGrid(b)
  .map(row => ' ' + row.join(' | '))
  .join('\n   ---------\n');

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

// ── timestamped logging ─────────────────────────────────────────────
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...args) => console.log(`[${ts()}]`, ...args);

// Demo-level adapter around the substrate's withTransientRetry: the
// watcher tick wants null-on-failure-with-log semantics so a single
// flaky call doesn't crash the whole tick. The substrate helper does
// the actual retry schedule (1s / 2s / 4s / 8s exponential backoff +
// transient-error detection); this only converts the throw into a
// null + log so the rest of the tick can keep making progress.
async function withRetry(label, fn) {
  try {
    return await withTransientRetry(fn);
  } catch (err) {
    log(`${label} failed: ${err?.message ?? String(err)}`);
    return null;
  }
}

// ── collective wallets ──────────────────────────────────────────────
const COLLECTIVE_SPECS = [
  { name: 'Aggressor', disposition: 'offensive', envKey: 'AGGRESSOR_KEY' },
  { name: 'Sentinel',  disposition: 'defensive', envKey: 'SENTINEL_KEY'  },
  { name: 'Mirror',    disposition: 'adaptive',  envKey: 'MIRROR_KEY'    },
  { name: 'Wildcard',  disposition: 'chaotic',   envKey: 'WILDCARD_KEY'  },
];

function buildCollective() {
  const players = new Map();
  const byDid = new Map();
  let sawEphemeral = false;
  for (const spec of COLLECTIVE_SPECS) {
    const { wallet, did, source } = loadAgentKeypair({ envVar: spec.envKey, label: 'agent' });
    if (source === 'ephemeral') sawEphemeral = true;
    const entry = {
      ...spec,
      wallet,
      did,
      // Last-time-we-played timestamp — used to break ties when a
      // challenge does not single one player out by name or DID.
      lastPlayedAt: 0,
    };
    players.set(spec.name, entry);
    byDid.set(did.toLowerCase(), entry);
  }
  if (sawEphemeral) {
    log(`WARN: at least one of ${COLLECTIVE_SPECS.map(s => s.envKey).join(' / ')} is unset — minting ephemeral keys; collective DIDs will NOT survive a restart.`);
  }
  return { players, byDid };
}

// ── publish helpers ─────────────────────────────────────────────────
async function publishCollectiveRoster(collective) {
  const iri = `${TOURNAMENT_NS}:collective-roster`;
  const rosterPayload = {
    pod: TOURNAMENT_POD,
    publishedAt: new Date().toISOString(),
    players: [...collective.players.values()].map(p => ({
      name: p.name,
      did: p.did,
      disposition: p.disposition,
    })),
  };
  const rosterJson = JSON.stringify(rosterPayload).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const playerBlocks = [...collective.players.values()].map(p => `[
    tictactoe:player <${p.did}> ;
    tictactoe:playerName "${p.name}" ;
    tictactoe:disposition "${p.disposition}"
  ]`).join(', ');

  // The roster's prov:wasGeneratedBy is the Aggressor by convention
  // (the alphabetically-first collective member); any single signer
  // among the four works because the descriptor's content is the
  // roster of all four DIDs anyway.
  const signer = collective.players.get('Aggressor');

  const graph = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a iep:ContextDescriptor, tictactoe:CollectiveRoster ;
  dcterms:conformsTo <${RULES_IRI}> ;
  dcterms:title "Tic-tac-toe collective roster (${TOURNAMENT_DATE})" ;
  dcterms:description "The four player DIDs the collective watcher will accept challenges against. Mint a tictactoe:NewGameChallenge naming one of these DIDs (or one of these names via tictactoe:opponentName) and publish it to this pod; the watcher will accept it within one poll interval and play the game out move by move." ;
  dcterms:hasPart ${playerBlocks} ;
  tictactoe:rosterJson "${rosterJson}" ;
  prov:wasGeneratedBy <${signer.did}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    .conformsTo(RULES_IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({
      wasGeneratedBy: { agent: signer.did, endedAt: new Date().toISOString() },
      wasAttributedTo: signer.did,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(signer.did, 'Author')
    .asserted(0.99)
    .verified(signer.did)
    .build();

  return withRetry(
    'publishCollectiveRoster publish',
    () => publish(desc, graph.trim(), TOURNAMENT_POD, {
      descriptorSlug: 'collective-roster',
      graphSlug: 'collective-roster-graph',
    }),
  );
}

async function publishAcceptance(player, challenge) {
  const iri = `${TOURNAMENT_NS}:${challenge.gameSlug}:acceptance`;

  const acceptancePayload = {
    gameId: challenge.gameId,
    challengerDid: challenge.challengerDid,
    accepter: player.did,
    accepterName: player.name,
    acceptedAt: new Date().toISOString(),
    challengeDescriptorUrl: challenge.descriptorUrl,
  };
  const { signedPayload, signature } = await signPayload(player.wallet, acceptancePayload);
  const acceptanceJson = signedPayload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const graph = `
@prefix iep: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a iep:ContextDescriptor, tictactoe:ChallengeAccepted ;
  dcterms:conformsTo <${RULES_IRI}> ;
  tictactoe:gameId <${challenge.gameId}> ;
  tictactoe:accepter <${player.did}> ;
  tictactoe:accepterName "${player.name}" ;
  tictactoe:challenger <${challenge.challengerDid}> ;
  tictactoe:acceptanceJson "${acceptanceJson}" ;
  tictactoe:signature "sha256:${createHash('sha256').update(signedPayload, 'utf8').digest('hex')}:${signature}" ;
  prov:wasGeneratedBy <${player.did}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    .conformsTo(RULES_IRI, CHALLENGE_ACCEPTED_IRI)
    .supersedes(challenge.descriptorUrl)
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

  return withRetry(
    `publishAcceptance ${challenge.gameSlug}`,
    () => publish(desc, graph.trim(), TOURNAMENT_POD, {
      descriptorSlug: `${challenge.gameSlug}-acceptance`,
      graphSlug: `${challenge.gameSlug}-acceptance-graph`,
    }),
  );
}

async function publishMove({ game, player, mark, cell, signedPayload, signature, reason }) {
  const n = game.moveNumber + 1;
  const iri = `${TOURNAMENT_NS}:${game.gameSlug}:move-${String(n).padStart(2, '0')}`;
  const boardBefore = game.board.slice();
  const boardAfter = applyMove(boardBefore, cell, mark);
  const verdict = evalBoard(boardAfter);
  const isTerminal = verdict !== null;

  let terminalTriples = '';
  if (isTerminal) {
    if (verdict.winner === 'draw') {
      terminalTriples = `\n  tictactoe:draw true ;`;
    } else {
      const winnerDid = verdict.winner === 'X' ? game.xDid : game.oDid;
      terminalTriples = `\n  tictactoe:winner <${winnerDid}> ;`;
    }
  }

  const movePayload = {
    gameId: game.gameId,
    moveNumber: n,
    player: player.did,
    mark,
    cell,
    boardBefore,
    boardAfter,
    terminal: isTerminal,
    verdict: verdict ?? null,
    reason,
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
  tictactoe:gameId <${game.gameId}> ;
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
    .supersedes(game.lastDescriptorUrl)
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

  const result = await withRetry(
    `publishMove ${game.gameSlug} move-${String(n).padStart(2, '0')}`,
    () => publish(desc, graph.trim(), TOURNAMENT_POD, {
      descriptorSlug: `${game.gameSlug}-move-${String(n).padStart(2, '0')}`,
      graphSlug: `${game.gameSlug}-move-${String(n).padStart(2, '0')}-graph`,
    }),
  );
  if (!result) {
    log(`publishMove ${game.gameSlug} move-${String(n).padStart(2, '0')}: giving up — leaving game state un-advanced so a later tick can retry the move`);
    return { descriptorUrl: null, boardAfter, terminal: false, verdict: null, failed: true };
  }

  game.moveNumber = n;
  game.board = boardAfter;
  game.lastDescriptorUrl = result.descriptorUrl;
  game.history.push({ descriptorUrl: result.descriptorUrl, mark, cell, player: player.did });
  game.turnDid = (player.did === game.xDid) ? game.oDid : game.xDid;
  if (isTerminal) {
    game.over = true;
    if (verdict.winner === 'draw') game.draw = true;
    else game.winnerDid = (verdict.winner === 'X') ? game.xDid : game.oDid;
  }
  return { descriptorUrl: result.descriptorUrl, boardAfter, terminal: isTerminal, verdict };
}

// ── pod scan: pending challenges + in-progress games ────────────────
//
// Every entry returned by discover() has `.descriptorUrl`, optional
// `.conformsTo` (string[]), and optional `.supersedes` (string[]).
// We classify the pod's descriptors into three buckets:
//
//   · challenges = entries whose conformsTo includes
//     <NEW_GAME_CHALLENGE_IRI>;
//   · acceptances = entries whose conformsTo includes
//     <CHALLENGE_ACCEPTED_IRI>;
//   · moves = entries with non-empty supersedes that are not
//     acceptances.
//
// A challenge is "pending" if no acceptance descriptor has
// iep:supersedes pointing at it. A game is "in progress" if it has an
// acceptance but no terminal move yet.

async function readChallengeDetails(descriptorUrl, conformsTo) {
  // The graph lives at the descriptor's -graph.trig sibling — a convention
  // both this watcher and the companion challenger script use when
  // publishing (descriptorSlug + graphSlug = `${descriptorSlug}-graph`).
  // fetchGraphContent wants the GRAPH url, not the descriptor's.
  const graphUrl = descriptorUrl.replace(/\.ttl(\?.*)?$/, '-graph.trig$1');
  const fetched = await withRetry(
    `readChallengeDetails fetchGraphContent ${graphUrl}`,
    () => fetchGraphContent(graphUrl, {}),
  );
  if (!fetched) return null;
  const turtle = fetched.content ?? '';

  const gameIdMatch = turtle.match(/tictactoe:gameId\s+<([^>]+)>/);
  const xPlayerMatch = turtle.match(/tictactoe:xPlayer\s+<([^>]+)>/);
  const oPlayerMatch = turtle.match(/tictactoe:oPlayer\s+<([^>]+)>/);
  const challengerMatch = turtle.match(/tictactoe:challenger\s+<([^>]+)>/);
  const opponentNameMatch = turtle.match(/tictactoe:opponentName\s+"([^"]+)"/);
  const opponentDidMatch = turtle.match(/tictactoe:opponentDid\s+<([^>]+)>/);
  const challengerMarkMatch = turtle.match(/tictactoe:challengerMark\s+"([^"]+)"/);
  const signatureMatch = turtle.match(/tictactoe:signature\s+"([^"]+)"/);
  const challengePayloadMatch = turtle.match(/tictactoe:challengeJson\s+"((?:[^"\\]|\\.)*)"/);

  if (!gameIdMatch) return null;
  const gameId = gameIdMatch[1];
  // Slugify the game IRI's tail so we can compose stable filenames.
  const gameSlug = gameId.replace(/^.*:/, '').replace(/[^a-zA-Z0-9-]/g, '-');

  // Challenger DID can be carried directly (tictactoe:challenger) or
  // inferred from xPlayer/oPlayer depending on the challenge's
  // challengerMark — both forms supported.
  const challengerMark = challengerMarkMatch ? challengerMarkMatch[1] : 'X';
  let challengerDid = challengerMatch ? challengerMatch[1] : null;
  let xPlayerDid = xPlayerMatch ? xPlayerMatch[1] : null;
  let oPlayerDid = oPlayerMatch ? oPlayerMatch[1] : null;
  if (!challengerDid) {
    challengerDid = challengerMark === 'O' ? oPlayerDid : xPlayerDid;
  }

  return {
    descriptorUrl,
    conformsTo,
    gameId,
    gameSlug,
    challengerDid,
    challengerMark,
    xPlayerDid,
    oPlayerDid,
    opponentName: opponentNameMatch ? opponentNameMatch[1] : null,
    opponentDid: opponentDidMatch ? opponentDidMatch[1] : null,
    signature: signatureMatch ? signatureMatch[1] : null,
    payloadJson: challengePayloadMatch ? challengePayloadMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null,
  };
}

async function readMoveDetails(descriptorUrl) {
  const graphUrl = descriptorUrl.replace(/\.ttl(\?.*)?$/, '-graph.trig$1');
  const fetched = await withRetry(
    `readMoveDetails fetchGraphContent ${graphUrl}`,
    () => fetchGraphContent(graphUrl, {}),
  );
  if (!fetched) return null;
  const turtle = fetched.content ?? '';
  const gameIdMatch = turtle.match(/tictactoe:gameId\s+<([^>]+)>/);
  const moveNumberMatch = turtle.match(/tictactoe:moveNumber\s+(\d+)/);
  const playerMatch = turtle.match(/tictactoe:player\s+<([^>]+)>/);
  const cellMatch = turtle.match(/tictactoe:cell\s+(\d+)/);
  const markMatch = turtle.match(/tictactoe:mark\s+"([^"]+)"/);
  const moveJsonMatch = turtle.match(/tictactoe:moveJson\s+"((?:[^"\\]|\\.)*)"/);
  const isTerminal = /tictactoe:winner\s+<|tictactoe:draw\s+true/.test(turtle);
  if (!gameIdMatch || !moveNumberMatch) return null;
  let payload = null;
  if (moveJsonMatch) {
    try {
      payload = JSON.parse(moveJsonMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    } catch { /* ignore — payload is best-effort here */ }
  }
  return {
    descriptorUrl,
    gameId: gameIdMatch[1],
    moveNumber: Number(moveNumberMatch[1]),
    playerDid: playerMatch ? playerMatch[1] : null,
    cell: cellMatch ? Number(cellMatch[1]) : null,
    mark: markMatch ? markMatch[1] : null,
    payload,
    isTerminal,
  };
}

function classify(entries) {
  const challenges = [];
  const acceptances = [];
  const moves = [];
  for (const e of entries) {
    const conformsTo = e.conformsTo ?? [];
    const supersedes = e.supersedes ?? [];
    if (conformsTo.includes(NEW_GAME_CHALLENGE_IRI)) challenges.push(e);
    else if (conformsTo.includes(CHALLENGE_ACCEPTED_IRI)) acceptances.push(e);
    else if (supersedes.length > 0 && conformsTo.includes(RULES_IRI)) moves.push(e);
  }
  return { challenges, acceptances, moves };
}

// ── player MCP tools (mirrors the tournament demo) ──────────────────
function makePlayerTools(player, game) {
  return [
    tool(
      'discover_board',
      'Return the current 3x3 board for the game and whose turn it is. The orchestrator already fetched the latest descriptor chain from the live pod before invoking you, so this reflects the substrate.',
      {},
      async () => {
        const youAre = (player.did === game.xDid) ? 'X' : 'O';
        const whoseTurn = game.turnDid === game.xDid ? 'X' : 'O';
        return { content: [{ type: 'text', text: JSON.stringify({
          gameId: game.gameId,
          moveNumber: game.moveNumber,
          board: game.board,
          board_grid: boardToGrid(game.board),
          board_rendered: renderBoard(game.board),
          legal_cells: legalCells(game.board),
          whose_turn: whoseTurn,
          you_are: youAre,
          you_are_to_move: game.turnDid === player.did,
          last_descriptor_url: game.lastDescriptorUrl,
        }, null, 2) }] };
      },
    ),
    tool(
      'make_move',
      'Publish a signed move descriptor to the live pod superseding the prior descriptor. Real HTTP write — every call moves the substrate. Returns the new descriptor URL + the resulting board + whether the game is over.',
      {
        cell: z.number().int().min(0).max(8).describe('Cell index 0..8 (left-to-right, top-to-bottom). MUST be currently empty.'),
        reason: z.string().describe('One short sentence on why this cell — bakes your disposition into the provenance trail.'),
      },
      async ({ cell, reason }) => {
        if (game.over) return { content: [{ type: 'text', text: JSON.stringify({ error: 'game already over', board: game.board }) }] };
        if (game.turnDid !== player.did) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not your turn', whose_turn: game.turnDid }) }] };
        if (game.board[cell] !== '.') return { content: [{ type: 'text', text: JSON.stringify({ error: 'cell occupied', cell, board: game.board }) }] };

        const mark = (player.did === game.xDid) ? 'X' : 'O';
        const movePayload = {
          gameId: game.gameId,
          moveNumber: game.moveNumber + 1,
          player: player.did,
          mark,
          cell,
          boardBefore: game.board.slice(),
          boardAfter: applyMove(game.board, cell, mark),
          reason,
        };
        const { signedPayload, signature } = await signPayload(player.wallet, movePayload);
        const recovered = recoverDidFromSigned(movePayload, signature);
        if (recovered.toLowerCase() !== player.did.toLowerCase()) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'signature self-check failed', expected: player.did, recovered }) }] };
        }
        const out = await publishMove({ game, player, mark, cell, signedPayload, signature, reason });
        if (out.failed) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'publish failed after retries', cell, mark }) }] };
        }
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

const DISPOSITION_HOOK = {
  Aggressor: 'You are an OFFENSIVE tic-tac-toe player. Always prioritize creating two-in-a-row threats and forks over blocking. Take the center if open; otherwise corners. Only block when the opponent has an immediate winning line.',
  Sentinel:  'You are a DEFENSIVE tic-tac-toe player. Always block opponent threats first, then build your own line second. Prefer edges and forced-draw configurations over speculative forks. Refuse to move into a position that creates an opponent fork.',
  Mirror:    'You are an ADAPTIVE tic-tac-toe player. Model the opponent\'s recent moves and counter their apparent strategy (mirror aggressive play with aggressive counter-forks; mirror defensive play with patient center control).',
  Wildcard:  'You are a CHAOTIC tic-tac-toe player. Choose a legal but non-obvious move at least one-third of the time to keep games from converging on the standard cat\'s-game equilibrium; otherwise play soundly.',
};

function playerSystemPrompt(player, game) {
  const isYourTurn = game.turnDid === player.did;
  return `You are ${player.name} (DID ${player.did}), one of four collective players in the persistent Interego tic-tac-toe watcher.

YOUR DISPOSITION
  ${DISPOSITION_HOOK[player.name]}

HOW THE SUBSTRATE WORKS
  Every game state lives on the live Interego CSS pod as a chain of
  iep:ContextDescriptor move-descriptors linked via iep:supersedes. The
  watcher loop fetched the latest descriptor for you before invoking
  this session. You call discover_board to see the current 3x3 grid,
  then call make_move once with a legal cell; make_move signs the move
  with your wallet and publishes a new descriptor that supersedes the
  prior one. That is how the rest of the collective sees your move.

YOUR TOOLS
  discover_board   — render the current board + whose turn it is.
  make_move        — choose a cell, sign, publish.

THIS TURN
  Game:        ${game.gameId}
  You are:     ${player.did === game.xDid ? 'X (moves first)' : 'O (moves second)'}
  Move number: ${game.moveNumber + 1}
  Your turn?:  ${isYourTurn ? 'YES' : 'NO — wait, do not make a move'}

WHAT TO DO
  1. Call discover_board.
  2. Pick a single legal cell consistent with your disposition.
  3. Call make_move once. Brief, terse reason.

Be terse. Do not narrate. One move per session.`;
}

// Drive one Claude SDK session to make exactly one move.
async function playOneMove(player, game) {
  const tools = makePlayerTools(player, game);
  const server = createSdkMcpServer({ name: 'collective', tools });
  const movesBefore = game.moveNumber;

  const userPrompt = `It is your turn. The board (you can also call discover_board):
${renderBoard(game.board)}
Legal cells: ${legalCells(game.board).join(', ')}
Your mark: ${player.did === game.xDid ? 'X' : 'O'}
Make exactly one move.`;

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        model: MODEL,
        systemPrompt: playerSystemPrompt(player, game),
        mcpServers: { collective: server },
        tools: [],
        allowedTools: ['mcp__collective__discover_board', 'mcp__collective__make_move'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
        maxTurns: 20,
      },
    })) {
      // Drain — the move (if any) lands via make_move's side effect.
      void msg;
    }
  } catch (err) {
    log(`game ${game.gameSlug}: ${player.name} session failed: ${err.message}`);
  }

  if (game.moveNumber === movesBefore) {
    // No move published. Auto-resign so the game doesn't stall the
    // watcher forever.
    log(`game ${game.gameSlug}: ${player.name} failed to publish a move — auto-forfeit`);
    game.over = true;
    game.winnerDid = (player.did === game.xDid) ? game.oDid : game.xDid;
    return { forfeit: true };
  }

  player.lastPlayedAt = Date.now();
  return { forfeit: false };
}

// ── tick state ──────────────────────────────────────────────────────
// gameSlug → in-memory state record. Persistence across restarts is
// out of scope for this demo; the watcher rebuilds in-progress games
// from the pod on each tick when needed.
const gameStates = new Map();

function gameState(gameSlug) {
  return gameStates.get(gameSlug);
}

function createGameState({ gameSlug, gameId, xDid, oDid, lastDescriptorUrl, moveNumber, board }) {
  const state = {
    gameSlug,
    gameId,
    xDid,
    oDid,
    board: board ?? emptyBoard(),
    moveNumber: moveNumber ?? 0,
    turnDid: moveNumber && moveNumber % 2 === 1 ? oDid : xDid,
    lastDescriptorUrl,
    history: [],
    over: false,
    winnerDid: null,
    draw: false,
  };
  gameStates.set(gameSlug, state);
  return state;
}

// Pick the collective player a challenge is asking for. Order of
// preference: explicit opponentDid match > opponentName match >
// least-recently-played member.
function chooseCollectivePlayer(collective, challenge) {
  if (challenge.opponentDid) {
    const byDid = collective.byDid.get(challenge.opponentDid.toLowerCase());
    if (byDid) return byDid;
  }
  if (challenge.opponentName) {
    const byName = collective.players.get(challenge.opponentName);
    if (byName) return byName;
  }
  // If either xPlayer or oPlayer in the challenge matches one of our
  // DIDs, the challenger has named us by DID.
  for (const candidate of [challenge.xPlayerDid, challenge.oPlayerDid]) {
    if (!candidate) continue;
    const c = collective.byDid.get(candidate.toLowerCase());
    if (c) return c;
  }
  // Fallback: least-recently-played.
  return [...collective.players.values()].sort((a, b) => a.lastPlayedAt - b.lastPlayedAt)[0];
}

// Validate the challenger's signature over the challenge payload, if
// the challenge carries one. A missing signature is allowed for
// hand-crafted challenges in early demos, but the log records it.
function verifyChallengerSignature(challenge) {
  // Require BOTH the signed payload and the signature. An unsigned
  // challenge is inert per Option D — the reader-side filter is what
  // gates trust, and we're the reader here. Pre-existing tournament
  // match-pairing descriptors (which share the type tictactoe:
  // NewGameChallenge but lack a tictactoe:signature because the
  // tournament's intra-collective pairings didn't need one) fall into
  // this branch and get skipped — exactly the right behavior since
  // they've already been played to terminal.
  if (!challenge.payloadJson || !challenge.signature) {
    return { ok: false, note: 'unsigned challenge — skipping (no tictactoe:signature or tictactoe:challengeJson present)' };
  }
  try {
    // signature blob format: "sha256:<hex>:<sig>"
    const parts = challenge.signature.split(':');
    if (parts.length < 3) return { ok: false, note: 'signature format unrecognized' };
    const sig = parts.slice(2).join(':');
    const hash = createHash('sha256').update(challenge.payloadJson, 'utf8').digest('hex');
    const addr = verifyMessage(`sha256:${hash}`, sig).toLowerCase();
    const recovered = `did:key:${addr}#agent`;
    if (challenge.challengerDid && recovered.toLowerCase() !== challenge.challengerDid.toLowerCase()) {
      return { ok: false, note: `signature recovered to ${recovered}, expected ${challenge.challengerDid}` };
    }
    return { ok: true, note: `signature recovered to ${recovered}` };
  } catch (err) {
    return { ok: false, note: `verify error: ${err.message}` };
  }
}

// ── the tick ────────────────────────────────────────────────────────
let tickInFlight = false;
let stopRequested = false;
let collectivePassport = null;

async function tick(collective) {
  if (tickInFlight) return; // re-entrant ticks are skipped
  tickInFlight = true;
  const publishedDescriptors = [];
  const transactionsExecuted = [];
  try {
    const entries = await withRetry(
      `tick discover(${TOURNAMENT_POD})`,
      () => discover(TOURNAMENT_POD),
    );
    if (!entries) {
      log('tick: discover failed after retries — skipping this tick, will retry on next interval');
      return;
    }
    const { challenges, acceptances, moves } = classify(entries);

    // Index acceptances + moves by what they supersede so we can ask
    // "has this challenge been accepted?" + "has this move been
    // responded to?" without re-fetching graphs.
    const supersededByAcceptance = new Set();
    for (const a of acceptances) for (const s of a.supersedes ?? []) supersededByAcceptance.add(s);
    const supersededByMove = new Set();
    for (const m of moves) for (const s of m.supersedes ?? []) supersededByMove.add(s);

    // 1. Accept pending challenges.
    const pendingChallenges = challenges.filter(c => !supersededByAcceptance.has(c.descriptorUrl));
    if (pendingChallenges.length === 0 && acceptances.length === 0) {
      log('watching… (no challenges, no in-progress games)');
    } else if (pendingChallenges.length === 0) {
      log(`watching… (${acceptances.length} game(s) on the pod, no new challenges)`);
    }

    for (const entry of pendingChallenges) {
      const challenge = await readChallengeDetails(entry.descriptorUrl, entry.conformsTo ?? []);
      if (!challenge) {
        log(`skipping malformed challenge at ${entry.descriptorUrl}`);
        continue;
      }
      const sigCheck = verifyChallengerSignature(challenge);
      if (!sigCheck.ok) {
        log(`skipping challenge ${challenge.gameSlug}: ${sigCheck.note}`);
        continue;
      }
      const chosen = chooseCollectivePlayer(collective, challenge);
      const acceptance = await publishAcceptance(chosen, challenge);
      if (!acceptance) {
        log(`challenge ${challenge.gameSlug}: acceptance publish failed after retries — leaving challenge pending for next tick`);
        continue;
      }
      publishedDescriptors.push(acceptance.descriptorUrl);

      // Seed orchestrator-side game state. Challenger plays
      // challengerMark; collective plays the other mark.
      const challengerIsX = challenge.challengerMark !== 'O';
      const xDid = challengerIsX ? challenge.challengerDid : chosen.did;
      const oDid = challengerIsX ? chosen.did : challenge.challengerDid;
      createGameState({
        gameSlug: challenge.gameSlug,
        gameId: challenge.gameId,
        xDid,
        oDid,
        lastDescriptorUrl: acceptance.descriptorUrl,
        moveNumber: 0,
        board: emptyBoard(),
      });
      log(`challenge from ${challenge.challengerDid.slice(0, 20)}… accepted by ${chosen.name} (game ${challenge.gameSlug}) — ${sigCheck.note}`);
    }

    // 2. Advance one in-progress game (single-game-at-a-time concurrency).
    // We look for games whose latest move was made by the challenger
    // and the collective hasn't responded to yet.
    const movesByGame = new Map();
    for (const m of moves) {
      const detail = await readMoveDetails(m.descriptorUrl);
      if (!detail) continue;
      const slug = detail.gameId.replace(/^.*:/, '').replace(/[^a-zA-Z0-9-]/g, '-');
      const cur = movesByGame.get(slug);
      if (!cur || detail.moveNumber > cur.moveNumber) movesByGame.set(slug, { ...detail, gameSlug: slug });
    }

    let advancedThisTick = false;
    for (const [slug, latest] of movesByGame.entries()) {
      if (advancedThisTick || stopRequested) break;
      if (latest.isTerminal) continue;
      // Reconstruct game state from the latest move if we don't have
      // it (e.g. after a watcher restart).
      let game = gameState(slug);
      if (!game && latest.payload) {
        game = createGameState({
          gameSlug: slug,
          gameId: latest.gameId,
          xDid: latest.payload.player === latest.payload.gameId ? null : null,
          oDid: null,
          lastDescriptorUrl: latest.descriptorUrl,
          moveNumber: latest.moveNumber,
          board: latest.payload.boardAfter,
        });
        // Without a reliable xDid/oDid mapping post-restart we can't
        // safely keep playing this game; the canonical fix is to
        // re-read the acceptance descriptor. For the demo's
        // single-process lifetime we expect game to already be in
        // memory.
        log(`game ${slug}: cannot resume after restart without acceptance lookup — skipping`);
        continue;
      }
      if (!game) continue;

      // Mirror the latest pod state into our in-memory game so the
      // player session sees what the substrate sees, even if a peer
      // wrote a move between ticks.
      if (latest.moveNumber > game.moveNumber && latest.playerDid && latest.cell !== null && latest.mark) {
        game.board = latest.payload?.boardAfter ?? applyMove(game.board, latest.cell, latest.mark);
        game.moveNumber = latest.moveNumber;
        game.lastDescriptorUrl = latest.descriptorUrl;
        game.turnDid = (latest.playerDid === game.xDid) ? game.oDid : game.xDid;
      }
      if (game.over) continue;

      // The collective only moves when it's the collective's turn.
      const onTurn = collective.byDid.get(game.turnDid?.toLowerCase());
      if (!onTurn) continue; // opponent's turn — wait

      log(`responding to move ${game.moveNumber} in game ${slug} as ${onTurn.name}`);
      const { forfeit } = await playOneMove(onTurn, game);
      if (!forfeit && game.history.length > 0) {
        publishedDescriptors.push(game.history[game.history.length - 1].descriptorUrl);
      }
      if (game.over) {
        transactionsExecuted.push(game.gameId);
        const winnerLabel = game.draw ? 'draw' : (collective.byDid.get(game.winnerDid?.toLowerCase())?.name ?? game.winnerDid);
        log(`game ${slug} terminal: ${winnerLabel}`);
      }
      advancedThisTick = true;
    }

    // Acceptances that just landed this tick also drive a first
    // collective move when the collective plays X — handle that
    // separately because there's no opponent move yet for the loop
    // above to detect.
    for (const game of gameStates.values()) {
      if (advancedThisTick || stopRequested) break;
      if (game.over) continue;
      if (game.moveNumber !== 0) continue;
      const onTurn = collective.byDid.get(game.xDid?.toLowerCase());
      if (!onTurn) continue; // challenger plays X — wait for them
      log(`opening move for game ${game.gameSlug} as ${onTurn.name}`);
      const { forfeit } = await playOneMove(onTurn, game);
      if (!forfeit && game.history.length > 0) {
        publishedDescriptors.push(game.history[game.history.length - 1].descriptorUrl);
      }
      if (game.over) {
        transactionsExecuted.push(game.gameId);
      }
      advancedThisTick = true;
    }
  } catch (err) {
    log(`tick error: ${err.message}`);
  } finally {
    // One record-if-changed call per tick — the helper drops the
    // no-op cases on the floor and only bumps the passport when
    // something biographical actually happened.
    collectivePassport = recordHeartbeatTickIfChanged(collectivePassport, {
      publishedDescriptors,
      transactionsExecuted,
    });
    tickInFlight = false;
  }
}

// ── bootstrap ───────────────────────────────────────────────────────
async function main() {
  console.log('=== Interego — Tic-Tac-Toe Collective Watcher ===');
  console.log(`   model:           ${MODEL}`);
  console.log(`   tournament pod:  ${TOURNAMENT_POD}`);
  console.log(`   rules IRI:       ${RULES_IRI}`);
  console.log(`   poll interval:   ${POLL_INTERVAL_MS} ms`);

  const collective = buildCollective();
  for (const p of collective.players.values()) {
    console.log(`   player:          ${p.name.padEnd(10)} ${p.did}  (${p.disposition})`);
  }

  // Lazy-import the passport constructor to keep the import surface
  // stable with how the heartbeat module is shipped (the passport
  // facade is the public seam; createPassport lives there).
  const { createPassport } = await import('../src/passport/index.js');
  collectivePassport = createPassport({
    agentIdentity: `${TOURNAMENT_NS}:collective`,
    currentPod: TOURNAMENT_POD,
  });

  log('publishing collective roster…');
  try {
    const roster = await publishCollectiveRoster(collective);
    if (!roster) {
      log('failed to publish roster after retries — continuing without it; challengers can still target known DIDs directly');
    } else {
      log(`roster descriptor: ${roster.descriptorUrl}`);
      collectivePassport = recordHeartbeatTickIfChanged(collectivePassport, {
        publishedDescriptors: [roster.descriptorUrl],
      });
    }
  } catch (err) {
    log(`failed to publish roster: ${err.message}`);
  }

  // Tick once immediately, then on the interval.
  await tick(collective);

  const handle = setInterval(() => { void tick(collective); }, POLL_INTERVAL_MS);

  // SSE-driven wake (Tier-2.B): subscribe to the relay's
  // /notifications/<podSlug> SSE channel and trigger a tick the
  // moment a new descriptor lands on the tournament pod. The polling
  // interval above stays as a safety net for SSE-drop scenarios.
  // Re-entrancy is handled by tickInFlight so an SSE-arrival doesn't
  // step on an in-flight polled tick. The connection auto-reconnects
  // on close with exponential backoff up to ~60s.
  let sseController = null;
  let sseStopRequested = false;
  async function runSseLoop() {
    if (!SSE_ENABLED) return;
    const { createHash } = await import('node:crypto');
    const podSlug = createHash('sha256').update(TOURNAMENT_POD).digest('hex').slice(0, 16);
    const sseUrl = `${RELAY_URL}/notifications/${podSlug}`;
    let backoffMs = 1_000;
    log(`SSE wake listener: ${sseUrl} (pod slug ${podSlug.slice(0, 8)}…)`);
    while (!sseStopRequested) {
      try {
        sseController = new AbortController();
        const resp = await fetch(sseUrl, {
          method: 'GET',
          headers: { 'Accept': 'text/event-stream' },
          signal: sseController.signal,
        });
        if (!resp.ok) {
          log(`SSE connect HTTP ${resp.status} ${resp.statusText} — retrying in ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 60_000);
          continue;
        }
        backoffMs = 1_000;
        // Stream parse: SSE events are blank-line separated; we care
        // only about the `data:` lines. Each NotificationEvent is a
        // line of JSON; on any event, kick a tick.
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        log('SSE channel open — wake-on-descriptor active');
        while (!sseStopRequested) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            // Any event on this channel means a new descriptor
            // touched our pod — tick.
            if (/^data:/m.test(event)) {
              log(`SSE wake: descriptor landed on tournament pod — kicking tick`);
              void tick(collective);
            }
          }
        }
      } catch (err) {
        if (sseStopRequested) break;
        log(`SSE connection error: ${err.message} — retrying in ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }
  void runSseLoop();

  const shutdown = async (signal) => {
    if (stopRequested) return;
    stopRequested = true;
    log(`${signal} received — finishing in-flight work before exit`);
    clearInterval(handle);
    // Close the SSE wake channel.
    sseStopRequested = true;
    try { sseController?.abort(); } catch { /* ignore */ }
    // Wait for any in-flight tick to land.
    const start = Date.now();
    while (tickInFlight && Date.now() - start < 60_000) {
      await new Promise(r => setTimeout(r, 250));
    }
    log(`passport version on exit: ${collectivePassport?.version ?? 'n/a'} (${collectivePassport?.lifeEvents.length ?? 0} life event(s))`);
    process.exit(0);
  };
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main();
