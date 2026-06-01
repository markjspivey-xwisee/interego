/**
 * Interego — Tic-Tac-Toe Challenger.
 *
 *   npx tsx examples/tic-tac-toe-challenge.mjs                    # interactive vs Mirror
 *   npx tsx examples/tic-tac-toe-challenge.mjs --opponent Sentinel --as-x
 *   npx tsx examples/tic-tac-toe-challenge.mjs --auto --opponent Aggressor
 *
 * What this script does
 *
 *   You walk up to the live tic-tac-toe tournament pod with nothing but
 *   an Interego wallet and play one real game against whichever collective
 *   player you picked. No membership, no allowlist — anyone who can sign
 *   a move payload with a fresh wallet can challenge the collective.
 *
 *   Step-by-step:
 *     1. GET the rules.ttl + the collective roster on the tournament pod
 *        to confirm which opponents are currently live.
 *     2. Mint a tictactoe:NewGameChallenge descriptor signed with your
 *        wallet, publish it to the tournament pod, print its URL.
 *     3. Poll (5s) until the collective's watcher publishes a
 *        tictactoe:ChallengeAccepted descriptor for this gameId.
 *     4. Play move-by-move. Each of your moves is a signed
 *        cg:ContextDescriptor that cg:supersedes the prior descriptor.
 *        Read the collective's responses by walking the supersedes-chain
 *        with discover() + fetchGraphContent().
 *     5. On terminal (winner found OR 9 moves with no winner = draw):
 *        print the final board, the outcome, and every descriptor URL.
 *
 *   Interactive: prompts "your move (0-8):" each turn, 'q' to forfeit.
 *   Auto: spawns a Claude session that plays for you using the same MCP
 *   tool pattern as the tournament's player agents.
 *
 *   Wallet:
 *     - Default: fresh Wallet.createRandom() per run (one-shot identity).
 *     - Persistent: set CHALLENGER_KEY=0x… in env to reuse a wallet
 *       across sessions (so the collective can see you again next time).
 *
 * Prereqs
 *   - The dist/ build of @interego/core (npm run build).
 *   - For --auto: @anthropic-ai/claude-agent-sdk + zod
 *     (npm i --no-save @anthropic-ai/claude-agent-sdk zod) and an active
 *     Claude Code OAuth login OR ANTHROPIC_API_KEY in env.
 *
 * Exits 0 on game completion (win/draw/loss/forfeit all count as
 * completed). Exits non-zero only on substrate / publishing failure.
 */

import { Wallet, verifyMessage } from 'ethers';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import {
  ContextDescriptor,
  publish,
  discover,
  fetchGraphContent,
} from '../dist/index.js';

// ── config ──────────────────────────────────────────────────────────
const CSS = process.env.CG_DEMO_POD_BASE
  ?? 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TOURNAMENT_DATE = process.env.TICTAC_DATE ?? '2026-05-31';
const TOURNAMENT_POD = `${CSS}/demos/tic-tac-toe-${TOURNAMENT_DATE}/`;
const MODEL = process.env.TICTAC_MODEL ?? 'claude-sonnet-4-6';

const TOURNAMENT_NS = `urn:demo:tic-tac-toe:${TOURNAMENT_DATE}`;
const RULES_IRI = `${TOURNAMENT_NS}:rules`;

// Vertical namespace — same one the tournament uses. No new ontology
// terms; the descriptor RDF only uses cg:/cgh:/dcterms:/prov: + this
// vertical-scoped prefix. Vertical/domain namespaces don't need owned
// ontology declarations.
const TICTAC_NS = 'https://interego-tournament.example/ns/tictactoe#';
const NEW_GAME_CHALLENGE_IRI = `${TICTAC_NS}NewGameChallenge`;
const CHALLENGE_ACCEPTED_IRI = `${TICTAC_NS}ChallengeAccepted`;

// ── CLI parsing ─────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return argv[i + 1] ?? fallback;
}

const OPPONENT_NAME = arg('opponent', 'Mirror');
const VALID_OPPONENTS = ['Aggressor', 'Sentinel', 'Mirror', 'Wildcard'];
if (!VALID_OPPONENTS.includes(OPPONENT_NAME)) {
  console.error(`unknown --opponent ${OPPONENT_NAME}. expected one of: ${VALID_OPPONENTS.join(', ')}`);
  process.exit(2);
}
const I_AM_X = flag('as-x');
const AUTO = flag('auto');

// ── signing (canonical Interego scheme, mirrors the watcher/tournament) ─
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
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6],
];

function emptyBoard() { return Array(9).fill('.'); }
function boardToGrid(b) { return [b.slice(0,3), b.slice(3,6), b.slice(6,9)]; }

function renderBoard(b) {
  // Show cell indices for any empty cell so the user knows what to type.
  const cells = b.map((v, i) => v === '.' ? String(i) : v);
  const rows = [cells.slice(0,3), cells.slice(3,6), cells.slice(6,9)];
  return rows.map(r => ' ' + r.join(' | ')).join('\n   ---------\n');
}

function applyMove(b, cell, mark) { const n = b.slice(); n[cell] = mark; return n; }
function legalCells(b) { const o = []; for (let i = 0; i < 9; i++) if (b[i] === '.') o.push(i); return o; }

function evalBoard(b) {
  for (const [a,c,d] of WIN_LINES) {
    if (b[a] !== '.' && b[a] === b[c] && b[c] === b[d]) return { winner: b[a], line: [a,c,d] };
  }
  if (legalCells(b).length === 0) return { winner: 'draw', line: null };
  return null;
}

// ── wallet bootstrap ────────────────────────────────────────────────
function loadOrMintWallet() {
  const key = process.env.CHALLENGER_KEY;
  if (key) {
    const w = new Wallet(key.startsWith('0x') ? key : `0x${key}`);
    return { wallet: w, fresh: false };
  }
  return { wallet: Wallet.createRandom(), fresh: true };
}

const { wallet: ME, fresh: WALLET_IS_FRESH } = loadOrMintWallet();
const MY_DID = `did:key:${ME.address.toLowerCase()}#agent`;

// ── header ──────────────────────────────────────────────────────────
console.log('=== Interego Tic-Tac-Toe — Challenger ===');
console.log(`   tournament pod:  ${TOURNAMENT_POD}`);
console.log(`   you (DID):       ${MY_DID}`);
console.log(`   wallet source:   ${WALLET_IS_FRESH ? 'fresh (one-shot)' : 'CHALLENGER_KEY env'}`);
console.log(`   opponent:        ${OPPONENT_NAME}`);
console.log(`   you play:        ${I_AM_X ? 'X (you move first)' : 'O (collective moves first)'}`);
console.log(`   mode:            ${AUTO ? 'auto (Claude plays for you)' : 'interactive'}`);

// ── ACT 1 — substrate + roster check ────────────────────────────────
console.log(`\n— checking the tournament pod is reachable —`);
let podLive = false;
try {
  const r = await fetch(TOURNAMENT_POD, { method: 'HEAD' });
  podLive = r.status === 200 || r.status === 204 || r.status === 401 || r.status === 403;
} catch { /* fall through */ }
if (!podLive) {
  console.error(`pod ${TOURNAMENT_POD} is not reachable. aborting.`);
  process.exit(1);
}
console.log(`   pod is live`);

console.log(`\n— discovering the collective roster + rules —`);
let entries = await discover(TOURNAMENT_POD);
const rulesEntry = entries.find(e => (e.conformsTo ?? []).includes(RULES_IRI) && /rules/i.test(e.descriptorUrl));
if (rulesEntry) {
  console.log(`   rules descriptor: ${rulesEntry.descriptorUrl}`);
} else {
  console.log(`   warning: no rules descriptor found yet on the pod — the collective may not have set up today's tournament. continuing anyway.`);
}

// Find the opponent DID by walking descriptors that mention the opponent name.
// The collective publishes participation claims that look like
// "<did> joins the tic-tac-toe tournament as player (<disposition>)".
async function findOpponentDid(name) {
  // Cheap path: try the move descriptors — any move from the opponent
  // exposes its DID in tictactoe:player + prov:wasGeneratedBy.
  for (const e of entries) {
    const fetched = await fetchGraphContent(e.descriptorUrl.replace(/\.ttl(\?.*)?$/, '-graph.trig$1'), {}).catch(() => null);
    if (!fetched?.content) continue;
    if (fetched.content.includes(`"${name}"`) || fetched.content.includes(`tictactoe:playerName "${name}"`)) {
      const m = fetched.content.match(/tictactoe:player\s+<([^>]+)>/);
      if (m) return m[1];
    }
  }
  return null;
}

const opponentDid = await findOpponentDid(OPPONENT_NAME);
if (opponentDid) {
  console.log(`   opponent DID:     ${opponentDid}`);
} else {
  console.log(`   warning: could not resolve ${OPPONENT_NAME}'s DID from past descriptors. the collective's watcher will fill it in when it accepts; we'll proceed.`);
}

// ── ACT 2 — mint + publish the NewGameChallenge ─────────────────────
const gameId = `${TOURNAMENT_NS}:challenge-${Date.now()}-${ME.address.slice(2, 10).toLowerCase()}`;
const challengeIri = `${gameId}:challenge`;
const challengeSlug = `challenge-${Date.now()}-${ME.address.slice(2, 10).toLowerCase()}`;

const xPlayerDid = I_AM_X ? MY_DID : (opponentDid ?? `urn:placeholder:${OPPONENT_NAME}`);
const oPlayerDid = I_AM_X ? (opponentDid ?? `urn:placeholder:${OPPONENT_NAME}`) : MY_DID;

const challengePayload = {
  gameId,
  challenger: MY_DID,
  opponentName: OPPONENT_NAME,
  opponentDid: opponentDid ?? null,
  xPlayer: xPlayerDid,
  oPlayer: oPlayerDid,
  moveNumber: 0,
  boardAfter: JSON.stringify(boardToGrid(emptyBoard())),
  issuedAt: new Date().toISOString(),
};
const { signedPayload: challengeSigned, signature: challengeSig } = await signPayload(ME, challengePayload);

const challengeGraph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${challengeIri}> a cg:ContextDescriptor, tictactoe:NewGameChallenge ;
  dcterms:conformsTo <${NEW_GAME_CHALLENGE_IRI}> ;
  tictactoe:gameId <${gameId}> ;
  tictactoe:xPlayer <${xPlayerDid}> ;
  tictactoe:oPlayer <${oPlayerDid}> ;
  tictactoe:challenger <${MY_DID}> ;
  tictactoe:challengerMark "${I_AM_X ? 'X' : 'O'}" ;
  tictactoe:moveNumber 0 ;
  tictactoe:opponentName "${OPPONENT_NAME}" ;
  tictactoe:boardAfter "${JSON.stringify(boardToGrid(emptyBoard())).replace(/"/g, '\\"')}" ;
  tictactoe:signature "sha256:${createHash('sha256').update(challengeSigned, 'utf8').digest('hex')}:${challengeSig}" ;
  prov:wasGeneratedBy <${MY_DID}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

const challengeDesc = ContextDescriptor.create(challengeIri)
  .describes(`${challengeIri}-graph`)
  .conformsTo(RULES_IRI, NEW_GAME_CHALLENGE_IRI)
  .temporal({ validFrom: new Date().toISOString() })
  .provenance({
    wasGeneratedBy: { agent: MY_DID, endedAt: new Date().toISOString() },
    wasAttributedTo: MY_DID,
    generatedAtTime: new Date().toISOString(),
  })
  .agent(MY_DID, 'Author')
  .asserted(0.99)
  .verified(MY_DID)
  .build();

console.log(`\n— publishing your challenge —`);
const challengePub = await publish(challengeDesc, challengeGraph.trim(), TOURNAMENT_POD, {
  descriptorSlug: challengeSlug,
  graphSlug: `${challengeSlug}-graph`,
});
console.log(`   challenge descriptor: ${challengePub.descriptorUrl}`);
console.log(`   challenge graph:      ${challengePub.graphUrl}`);

const allDescriptorUrls = [challengePub.descriptorUrl];

// ── ACT 3 — wait for the collective's watcher to accept ─────────────
console.log(`\n— waiting for ${OPPONENT_NAME} to accept (poll every 5s, ctrl-c to abort) —`);

async function findAcceptance() {
  const latest = await discover(TOURNAMENT_POD);
  for (const e of latest) {
    if (!(e.conformsTo ?? []).includes(CHALLENGE_ACCEPTED_IRI)
        && !(e.conformsTo ?? []).some(c => c.endsWith('ChallengeAccepted'))) continue;
    const fetched = await fetchGraphContent(e.descriptorUrl.replace(/\.ttl(\?.*)?$/, '-graph.trig$1'), {}).catch(() => null);
    if (!fetched?.content) continue;
    if (fetched.content.includes(`<${gameId}>`)) {
      // Pull the opponent DID out if we didn't have it yet.
      const m = fetched.content.match(/tictactoe:opponentDid\s+<([^>]+)>/)
            ?? fetched.content.match(/tictactoe:player\s+<([^>]+)>/);
      return { entry: e, descriptorUrl: e.descriptorUrl, opponentDid: m?.[1] ?? opponentDid };
    }
  }
  return null;
}

let acceptance = null;
const ACCEPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min ceiling
const ACCEPT_POLL_MS = 5000;
const acceptStart = Date.now();
while (!acceptance && (Date.now() - acceptStart) < ACCEPT_TIMEOUT_MS) {
  acceptance = await findAcceptance();
  if (acceptance) break;
  process.stdout.write('.');
  await new Promise(r => setTimeout(r, ACCEPT_POLL_MS));
  entries = await discover(TOURNAMENT_POD); // refresh
}
process.stdout.write('\n');

if (!acceptance) {
  console.log(`   no acceptance within ${ACCEPT_TIMEOUT_MS / 1000}s. either the collective's watcher is offline or ${OPPONENT_NAME} declined.`);
  console.log(`   your challenge descriptor is still on the pod: ${challengePub.descriptorUrl}`);
  process.exit(0);
}
console.log(`   accepted: ${acceptance.descriptorUrl}`);
const resolvedOpponentDid = acceptance.opponentDid ?? opponentDid ?? `urn:placeholder:${OPPONENT_NAME}`;
console.log(`   opponent DID (resolved): ${resolvedOpponentDid}`);
allDescriptorUrls.push(acceptance.descriptorUrl);

// Update X/O DIDs now that we know who's who.
const xDid = I_AM_X ? MY_DID : resolvedOpponentDid;
const oDid = I_AM_X ? resolvedOpponentDid : MY_DID;

// ── game state (orchestrator side mirror; substrate is the truth) ──
const state = {
  gameId,
  xDid,
  oDid,
  board: emptyBoard(),
  moveNumber: 0,
  turnDid: xDid, // X always moves first
  lastDescriptorUrl: acceptance.descriptorUrl,
  history: [],
  over: false,
  winnerDid: null,
  draw: false,
};

// ── move-descriptor helpers (mirror the tournament's publishMove) ───
function moveSlug(n) { return `${challengeSlug}-move-${String(n).padStart(2, '0')}`; }
function moveIri(n) { return `${gameId}:move-${String(n).padStart(2, '0')}`; }

async function publishChallengerMove({ cell, reason }) {
  const n = state.moveNumber + 1;
  const iri = moveIri(n);
  const mark = I_AM_X ? 'X' : 'O';
  const boardBefore = state.board.slice();
  const boardAfter = applyMove(boardBefore, cell, mark);
  const verdict = evalBoard(boardAfter);
  const isTerminal = verdict !== null;

  let terminalTriples = '';
  if (isTerminal) {
    if (verdict.winner === 'draw') {
      terminalTriples = `\n  tictactoe:draw true ;`;
    } else {
      const winnerDid = verdict.winner === 'X' ? state.xDid : state.oDid;
      terminalTriples = `\n  tictactoe:winner <${winnerDid}> ;`;
    }
  }

  const payload = {
    gameId: state.gameId,
    moveNumber: n,
    player: MY_DID,
    mark,
    cell,
    boardBefore,
    boardAfter,
    terminal: isTerminal,
    verdict: verdict ?? null,
    reason,
  };
  const { signedPayload, signature } = await signPayload(ME, payload);
  const recovered = recoverDidFromSignedMove(payload, signature);
  if (recovered.toLowerCase() !== MY_DID.toLowerCase()) {
    throw new Error(`signature self-check failed: expected ${MY_DID}, got ${recovered}`);
  }

  const moveJson = JSON.stringify(payload).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const graph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a cg:ContextDescriptor, tictactoe:Move ;
  dcterms:conformsTo <${RULES_IRI}> ;
  tictactoe:gameId <${state.gameId}> ;
  tictactoe:moveNumber ${n} ;
  tictactoe:player <${MY_DID}> ;
  tictactoe:mark "${mark}" ;
  tictactoe:cell ${cell} ;
  tictactoe:boardBefore "${JSON.stringify(boardToGrid(boardBefore)).replace(/"/g, '\\"')}" ;
  tictactoe:boardAfter "${JSON.stringify(boardToGrid(boardAfter)).replace(/"/g, '\\"')}" ;${terminalTriples}
  tictactoe:moveJson "${moveJson}" ;
  tictactoe:signature "sha256:${createHash('sha256').update(signedPayload, 'utf8').digest('hex')}:${signature}" ;
  prov:wasGeneratedBy <${MY_DID}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    .conformsTo(RULES_IRI)
    .supersedes(state.lastDescriptorUrl)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({
      wasGeneratedBy: { agent: MY_DID, endedAt: new Date().toISOString() },
      wasAttributedTo: MY_DID,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(MY_DID, 'Author')
    .asserted(0.99)
    .verified(MY_DID)
    .build();

  const result = await publish(desc, graph.trim(), TOURNAMENT_POD, {
    descriptorSlug: moveSlug(n),
    graphSlug: `${moveSlug(n)}-graph`,
  });

  state.moveNumber = n;
  state.board = boardAfter;
  state.lastDescriptorUrl = result.descriptorUrl;
  state.history.push({ descriptorUrl: result.descriptorUrl, mark, cell, player: MY_DID });
  state.turnDid = (MY_DID === state.xDid) ? state.oDid : state.xDid;
  if (isTerminal) {
    state.over = true;
    if (verdict.winner === 'draw') state.draw = true;
    else state.winnerDid = (verdict.winner === 'X') ? state.xDid : state.oDid;
  }
  allDescriptorUrls.push(result.descriptorUrl);
  return { descriptorUrl: result.descriptorUrl, boardAfter, terminal: isTerminal, verdict };
}

async function publishForfeit() {
  // A forfeit is just a terminal move with no cell played — we encode it
  // as a descriptor that names the opponent as winner. We pick a sentinel
  // cell value of -1; the collective interprets the explicit winner triple,
  // not the cell field.
  const n = state.moveNumber + 1;
  const iri = moveIri(n);
  const opponentDid = (MY_DID === state.xDid) ? state.oDid : state.xDid;

  const payload = {
    gameId: state.gameId,
    moveNumber: n,
    player: MY_DID,
    mark: I_AM_X ? 'X' : 'O',
    cell: -1,
    boardBefore: state.board.slice(),
    boardAfter: state.board.slice(),
    terminal: true,
    verdict: { winner: opponentDid, line: null, reason: 'forfeit' },
    reason: 'challenger forfeited',
  };
  const { signedPayload, signature } = await signPayload(ME, payload);
  const moveJson = JSON.stringify(payload).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const graph = `
@prefix cg: <https://w3id.org/cg/> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix tictactoe: <${TICTAC_NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<${iri}> a cg:ContextDescriptor, tictactoe:Move ;
  dcterms:conformsTo <${RULES_IRI}> ;
  tictactoe:gameId <${state.gameId}> ;
  tictactoe:moveNumber ${n} ;
  tictactoe:player <${MY_DID}> ;
  tictactoe:winner <${opponentDid}> ;
  tictactoe:forfeited true ;
  tictactoe:moveJson "${moveJson}" ;
  tictactoe:signature "sha256:${createHash('sha256').update(signedPayload, 'utf8').digest('hex')}:${signature}" ;
  prov:wasGeneratedBy <${MY_DID}> ;
  prov:generatedAtTime "${new Date().toISOString()}"^^xsd:dateTime .
`;

  const desc = ContextDescriptor.create(iri)
    .describes(`${iri}-graph`)
    .conformsTo(RULES_IRI)
    .supersedes(state.lastDescriptorUrl)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({
      wasGeneratedBy: { agent: MY_DID, endedAt: new Date().toISOString() },
      wasAttributedTo: MY_DID,
      generatedAtTime: new Date().toISOString(),
    })
    .agent(MY_DID, 'Author')
    .asserted(0.99)
    .verified(MY_DID)
    .build();

  const result = await publish(desc, graph.trim(), TOURNAMENT_POD, {
    descriptorSlug: moveSlug(n),
    graphSlug: `${moveSlug(n)}-graph`,
  });
  state.moveNumber = n;
  state.over = true;
  state.winnerDid = opponentDid;
  state.lastDescriptorUrl = result.descriptorUrl;
  state.history.push({ descriptorUrl: result.descriptorUrl, mark: I_AM_X ? 'X' : 'O', cell: -1, player: MY_DID });
  allDescriptorUrls.push(result.descriptorUrl);
  return result.descriptorUrl;
}

// ── reading the collective's moves off the pod ──────────────────────
// The collective's move-descriptors cg:supersedes the last descriptor in
// the chain. We walk discover() looking for any descriptor that
// supersedes our state.lastDescriptorUrl, fetch its graph, decode the
// cell + boardAfter, and apply.
async function waitForOpponentMove() {
  const POLL_MS = 5000;
  const TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  while ((Date.now() - start) < TIMEOUT_MS) {
    const latest = await discover(TOURNAMENT_POD);
    for (const e of latest) {
      if (!(e.supersedes ?? []).includes(state.lastDescriptorUrl)) continue;
      // Must be from the opponent, not from us.
      const fetched = await fetchGraphContent(e.descriptorUrl.replace(/\.ttl(\?.*)?$/, '-graph.trig$1'), {}).catch(() => null);
      if (!fetched?.content) continue;
      const playerMatch = fetched.content.match(/tictactoe:player\s+<([^>]+)>/);
      const playerDid = playerMatch?.[1];
      if (!playerDid || playerDid.toLowerCase() === MY_DID.toLowerCase()) continue;

      // Decode the move
      const cellMatch = fetched.content.match(/tictactoe:cell\s+(-?\d+)/);
      const markMatch = fetched.content.match(/tictactoe:mark\s+"([XO])"/);
      const winnerMatch = fetched.content.match(/tictactoe:winner\s+<([^>]+)>/);
      const drawMatch = /tictactoe:draw\s+true/.test(fetched.content);
      if (!cellMatch || !markMatch) {
        // Might be an acceptance or other non-move descriptor — skip.
        continue;
      }
      const cell = parseInt(cellMatch[1], 10);
      const mark = markMatch[1];
      const boardAfter = applyMove(state.board, cell, mark);
      state.moveNumber += 1;
      state.board = boardAfter;
      state.lastDescriptorUrl = e.descriptorUrl;
      state.history.push({ descriptorUrl: e.descriptorUrl, mark, cell, player: playerDid });
      state.turnDid = (playerDid === state.xDid) ? state.oDid : state.xDid;
      if (winnerMatch) { state.over = true; state.winnerDid = winnerMatch[1]; }
      else if (drawMatch) { state.over = true; state.draw = true; }
      allDescriptorUrls.push(e.descriptorUrl);
      return { descriptorUrl: e.descriptorUrl, cell, mark, boardAfter };
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw new Error(`opponent did not move within ${TIMEOUT_MS / 1000}s`);
}

// ── interactive prompt ──────────────────────────────────────────────
function promptUser(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getInteractiveMove() {
  while (true) {
    const legal = legalCells(state.board);
    const answer = await promptUser(`your move (${legal.join(',')}, or 'q' to forfeit): `);
    if (answer === 'q' || answer === 'Q') return { forfeit: true };
    const n = parseInt(answer, 10);
    if (!Number.isInteger(n) || n < 0 || n > 8) {
      console.log(`   '${answer}' is not a valid cell. try again.`);
      continue;
    }
    if (!legal.includes(n)) {
      console.log(`   cell ${n} is occupied. try again.`);
      continue;
    }
    return { cell: n, reason: 'interactive player input' };
  }
}

// ── auto mode: spawn a Claude session that plays for you ────────────
async function getAutoMove() {
  // Lazy import — only required when --auto is set.
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');

  const turnSnapshot = {
    gameId: state.gameId,
    moveNumber: state.moveNumber + 1,
    you_are: I_AM_X ? 'X' : 'O',
    board: state.board,
    board_grid: boardToGrid(state.board),
    board_rendered: renderBoard(state.board),
    legal_cells: legalCells(state.board),
    last_descriptor_url: state.lastDescriptorUrl,
  };

  let chosenCell = null;
  let chosenReason = null;

  const tools = [
    tool(
      'read_board',
      'Return the current 3x3 board, whose mark you are, and the list of legal cells. Call this once before make_move.',
      {},
      async () => ({ content: [{ type: 'text', text: JSON.stringify(turnSnapshot, null, 2) }] }),
    ),
    tool(
      'make_move',
      'Commit to a cell. cell is 0..8 (left-to-right, top-to-bottom). Must be in legal_cells.',
      {
        cell: z.number().int().min(0).max(8).describe('Cell index 0..8, must be empty.'),
        reason: z.string().describe('One short sentence on why.'),
      },
      async ({ cell, reason }) => {
        if (!turnSnapshot.legal_cells.includes(cell)) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'illegal cell', cell, legal_cells: turnSnapshot.legal_cells }) }] };
        }
        chosenCell = cell;
        chosenReason = reason;
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, cell, reason }) }] };
      },
    ),
  ];
  const server = createSdkMcpServer({ name: 'challenger', tools });

  const systemPrompt = `You are playing a single move of tic-tac-toe to win or draw. Your opponent is the ${OPPONENT_NAME} collective member (disposition: ${
    OPPONENT_NAME === 'Aggressor' ? 'offensive' :
    OPPONENT_NAME === 'Sentinel' ? 'defensive' :
    OPPONENT_NAME === 'Mirror' ? 'adaptive' :
    'chaotic'
  }).

Step 1: call read_board.
Step 2: pick the single best legal cell. Block immediate opponent wins first; complete your own line second; else take center, then corners, then edges.
Step 3: call make_move once. Be terse.`;

  const userPrompt = `Your turn. Make exactly one move.`;

  for await (const _msg of query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      systemPrompt,
      mcpServers: { challenger: server },
      tools: [],
      allowedTools: ['mcp__challenger__read_board', 'mcp__challenger__make_move'],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      maxTurns: 8,
    },
  })) {
    // Drain the iterator; we only care about the side effect of make_move.
  }

  if (chosenCell === null) {
    throw new Error('Claude session ended without committing a move');
  }
  return { cell: chosenCell, reason: chosenReason ?? 'auto-mode chose this cell' };
}

// ── ACT 4 — play the game ───────────────────────────────────────────
console.log(`\n— game on —`);
console.log(renderBoard(state.board));

// If the collective plays X, wait for their opening move first.
if (!I_AM_X) {
  console.log(`\n   waiting for ${OPPONENT_NAME} to open (X) ...`);
  const op = await waitForOpponentMove();
  process.stdout.write('\n');
  console.log(`   ${OPPONENT_NAME} played ${op.mark} at cell ${op.cell}`);
  console.log(`   their move:  ${op.descriptorUrl}`);
  console.log(renderBoard(state.board));
}

while (!state.over) {
  // Your turn.
  let myMove;
  if (AUTO) {
    console.log(`\n   (auto) Claude is choosing a move ...`);
    myMove = await getAutoMove();
    console.log(`   (auto) chose cell ${myMove.cell} — ${myMove.reason}`);
  } else {
    myMove = await getInteractiveMove();
  }

  if (myMove.forfeit) {
    console.log(`\n   you forfeited. publishing a forfeit descriptor ...`);
    const url = await publishForfeit();
    console.log(`   forfeit descriptor: ${url}`);
    break;
  }

  const published = await publishChallengerMove({ cell: myMove.cell, reason: myMove.reason });
  console.log(`\n   you played ${I_AM_X ? 'X' : 'O'} at cell ${myMove.cell}`);
  console.log(`   your move:   ${published.descriptorUrl}`);
  console.log(renderBoard(state.board));
  if (state.over) break;

  // Opponent's turn.
  console.log(`\n   waiting for ${OPPONENT_NAME} to respond ...`);
  const op = await waitForOpponentMove();
  process.stdout.write('\n');
  console.log(`   ${OPPONENT_NAME} played ${op.mark} at cell ${op.cell}`);
  console.log(`   their move:  ${op.descriptorUrl}`);
  console.log(renderBoard(state.board));
}

// ── ACT 5 — final summary ───────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`final board:`);
console.log(renderBoard(state.board));
let outcomeLine;
if (state.draw) outcomeLine = 'DRAW (cat\'s game)';
else if (state.winnerDid && state.winnerDid.toLowerCase() === MY_DID.toLowerCase()) outcomeLine = `YOU WIN against ${OPPONENT_NAME}`;
else if (state.winnerDid) outcomeLine = `${OPPONENT_NAME} WINS`;
else outcomeLine = `game ended without a verdict — see descriptors`;
console.log(`\nresult: ${outcomeLine}`);
console.log(`moves played: ${state.moveNumber}`);

console.log(`\nall descriptor URLs (in order):`);
for (const u of allDescriptorUrls) console.log(`   ${u}`);

if (WALLET_IS_FRESH) {
  console.log(`\nyour wallet was minted fresh for this game; set CHALLENGER_KEY=${ME.privateKey} to reuse it next time.`);
}
console.log(`${'='.repeat(60)}`);
process.exit(0);
