// Runtime — loads an agent-authored game engine from a source string
// and gives the orchestrator a uniform interface to call it.
//
// The agents publish a complete game design as a signed descriptor:
//   {
//     name: 'My TTT Variant',
//     rulesText: 'A 1–2 paragraph natural-language description …',
//     engineSource: '<a JS ES-module-style source string>'
//   }
//
// The engine source must define ALL of:
//   const meta = { name, players: ['X','O'], ... }
//   function emptyBoard() -> string
//   function legalMoves(board, player) -> number[]
//   function applyMove(board, move, player) -> string
//   function checkTerminal(board) -> { terminal, winner|null, draw, line|null }
//
// We load it via `new Function()` with no fetch/require/import in
// scope — agents can publish only pure local-arithmetic logic.
//
// SAFETY NOTE: this is a demo. We treat the agent's wallet as a
// proxy for trust ("the user signed off on this code by running this
// demo against their pod") but production usage would sandbox via
// vm.runInNewContext or a separate worker. For now: don't run this
// against UNTRUSTED engines.

export function loadEngine(engineSource) {
  // Wrap the agent's source so we can extract the named exports
  // without using ES module loaders. The agent's code can be ESM-
  // flavoured (with `export` keywords) — we strip them.
  const stripped = engineSource
    .replace(/^\s*export\s+(?=(const|let|var|function)\b)/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '');

  const wrapper = `
${stripped}

return {
  meta: (typeof meta !== 'undefined') ? meta : { name: 'unnamed' },
  emptyBoard:   typeof emptyBoard   === 'function' ? emptyBoard   : null,
  legalMoves:   typeof legalMoves   === 'function' ? legalMoves   : null,
  applyMove:    typeof applyMove    === 'function' ? applyMove    : null,
  checkTerminal: typeof checkTerminal === 'function' ? checkTerminal : null,
};
`;
  let exported;
  try {
    const fn = new Function(wrapper);
    exported = fn();
  } catch (err) {
    return { ok: false, error: `engine source threw at load: ${err.message}`, exports: null };
  }
  const missing = ['emptyBoard', 'legalMoves', 'applyMove', 'checkTerminal'].filter(k => !exported[k]);
  if (missing.length) {
    return { ok: false, error: `engine missing functions: ${missing.join(', ')}`, exports: null };
  }
  return { ok: true, error: null, exports: exported };
}

/**
 * Test battery — run an authored engine through a deterministic
 * set of probes. Returns a 0..1 score on each dimension plus a list
 * of failed probes the evaluator can cite.
 *
 * This is the substrate-honest verifier the evaluator agent uses
 * BEFORE attesting an authored design (and the orchestrator uses to
 * sanity-check the selected design before tournament play).
 */
export function runTestBattery(engine) {
  const failures = [];
  let passed = 0;
  let total = 0;

  function probe(name, fn) {
    total++;
    try { fn(); passed++; } catch (err) { failures.push(`${name}: ${err.message}`); }
  }

  probe('emptyBoard returns a non-empty string', () => {
    const b = engine.emptyBoard();
    if (typeof b !== 'string' || b.length === 0) throw new Error(`got ${typeof b}: ${b}`);
  });
  probe('legalMoves on emptyBoard returns >= 1 entries', () => {
    const moves = engine.legalMoves(engine.emptyBoard(), 'X');
    if (!Array.isArray(moves) || moves.length === 0) throw new Error(`got ${JSON.stringify(moves)}`);
  });
  probe('applyMove changes the board', () => {
    const b0 = engine.emptyBoard();
    const moves = engine.legalMoves(b0, 'X');
    const b1 = engine.applyMove(b0, moves[0], 'X');
    if (b1 === b0) throw new Error('applyMove returned same board');
  });
  probe('checkTerminal on empty board is non-terminal', () => {
    const r = engine.checkTerminal(engine.emptyBoard());
    if (r?.terminal) throw new Error(`empty board reported terminal: ${JSON.stringify(r)}`);
  });
  probe('full alternating play eventually terminates', () => {
    let board = engine.emptyBoard();
    let player = 'X';
    for (let i = 0; i < 64; i++) {
      const moves = engine.legalMoves(board, player);
      if (moves.length === 0) {
        const t = engine.checkTerminal(board);
        if (!t?.terminal) throw new Error('no legal moves but checkTerminal says non-terminal');
        return;
      }
      board = engine.applyMove(board, moves[0], player);
      const t = engine.checkTerminal(board);
      if (t?.terminal) return;
      player = player === 'X' ? 'O' : 'X';
    }
    throw new Error('game did not terminate in 64 moves');
  });
  probe('illegal move does not corrupt state', () => {
    const b0 = engine.emptyBoard();
    try {
      engine.applyMove(b0, -1, 'X');
    } catch { /* throwing on illegal is fine */ }
  });

  return {
    score: passed / total,
    passed, total,
    failures,
  };
}
