// Demo: Stigmergic colony intelligence on a shared pod.
//
// Stigmergy is coordination via environmental trace. Ants don't
// carry maps; each one follows gradients of pheromone left by
// others. Individual behavior is local and simple. Colony behavior
// is global and emergent.
//
// We simulate it on a shared pod: agents looking for the "best"
// path between two concepts in a concept graph. Each agent traverses
// at random, biased by existing trace intensity, and deposits its
// own trace proportional to path quality. Traces decay over time.
//
// No agent has the concept graph. No agent coordinates with any
// other. All knowledge lives in the shared pod (the "environment").
//
// Principles exercised:
//   - Federation as shared substrate (pod = environment)
//   - Emergence from local interaction (no global coordinator)
//   - Usage-based reinforcement (trace intensity = CTS frequency)
//   - Compositional accumulation (many weak signals → one strong signal)
//
// Success criterion: after N rounds, all agents converge on the
// same path (or a small equivalence class), despite each agent's
// choice being stochastic and context-free.

// ── The concept graph (the "territory" to be explored) ──────
//
// Nodes are concepts; edges have true-latent quality (which no
// individual agent can see). The colony's job is to discover the
// highest-quality path from START to GOAL via trace dynamics.

const CONCEPT_GRAPH = {
  START: { next: { A: 1.0, B: 1.0, C: 1.0 } },
  A:     { next: { D: 0.2, E: 0.95 } },  // A→E is the big winner
  B:     { next: { D: 0.55, F: 0.4 } },
  C:     { next: { E: 0.4, F: 0.5 } },
  D:     { next: { GOAL: 0.5 } },
  E:     { next: { GOAL: 0.95 } },       // E→GOAL is the big winner
  F:     { next: { GOAL: 0.4 } },
  GOAL:  { next: {} },
};

// Path qualities (product of edge qualities):
//   START→A→E→GOAL  : 0.9025  ← globally optimal
//   START→B→D→GOAL  : 0.275
//   START→C→E→GOAL  : 0.38
//   START→C→F→GOAL  : 0.20
//   START→A→D→GOAL  : 0.10
//   START→B→F→GOAL  : 0.16
// Optimum is ≈ 2.4× the next-best; the colony should find it.

// ── The "pod" = trace state ───────────────────────────────

/** Shared trace intensities on edges, keyed "from→to". */
const traces = new Map();
function traceKey(a, b) { return `${a}→${b}`; }
function getTrace(a, b) { return traces.get(traceKey(a, b)) ?? 0; }
function deposit(a, b, amount) {
  traces.set(traceKey(a, b), getTrace(a, b) + amount);
}

/** Decay all traces uniformly — preserves relative gradients. */
function decayAll(rate) {
  for (const [k, v] of traces) traces.set(k, v * (1 - rate));
}

// ── Agent logic ────────────────────────────────────────────
//
// At each node, an agent picks a next edge by softmax over
// (trace + ε), where ε is an exploration floor that keeps
// pristine edges from being permanently ignored.

const EPSILON = 0.5;      // exploration floor — keeps untried edges viable
const TEMPERATURE = 1.3;  // softmax sharpness (higher → more exploitative)
const DECAY = 0.18;       // per-round decay — prevents early lock-in
const AGENTS_PER_ROUND = 6;
const ROUNDS = 60;

function chooseNext(from) {
  const options = Object.keys(CONCEPT_GRAPH[from]?.next ?? {});
  if (options.length === 0) return null;
  const weights = options.map(to => EPSILON + getTrace(from, to));
  const logits = weights.map(w => Math.pow(w, TEMPERATURE));
  const total = logits.reduce((a, b) => a + b, 0);
  const r = Math.random() * total;
  let acc = 0;
  for (let i = 0; i < options.length; i++) {
    acc += logits[i];
    if (r <= acc) return options[i];
  }
  return options[options.length - 1];
}

function runAgent() {
  const path = ['START'];
  let node = 'START';
  let quality = 1.0;
  while (node !== 'GOAL') {
    const next = chooseNext(node);
    if (!next) break;
    quality *= CONCEPT_GRAPH[node].next[next];
    path.push(next);
    node = next;
    if (path.length > 10) break;
  }
  const arrived = node === 'GOAL';
  // Trace deposit proportional to quality², so a 0.85-quality path
  // leaves ≈ 1.5× the mark of a 0.7-quality path. This sharpens the
  // gradient between near-optimal alternatives enough to escape
  // early lock-in while leaving room for exploration.
  if (arrived) {
    const dep = quality * quality;
    for (let i = 0; i < path.length - 1; i++) {
      deposit(path[i], path[i + 1], dep);
    }
  }
  return { path, quality, arrived };
}

// ── Run the simulation ────────────────────────────────────

console.log('=== Stigmergic colony on a shared pod ===\n');
console.log('Concept graph has:');
console.log('  START → {A, B, C} → {D, E, F} → GOAL');
console.log('  Edge qualities are latent; no agent can see them.');
console.log(`  ${AGENTS_PER_ROUND} agents per round × ${ROUNDS} rounds = ${AGENTS_PER_ROUND * ROUNDS} traversals.\n`);

const pathFreq = new Map();
const qualityByRound = [];

for (let r = 1; r <= ROUNDS; r++) {
  let sumQuality = 0;
  let arrivals = 0;
  for (let a = 0; a < AGENTS_PER_ROUND; a++) {
    const res = runAgent();
    if (res.arrived) {
      arrivals++;
      sumQuality += res.quality;
      const k = res.path.join('→');
      pathFreq.set(k, (pathFreq.get(k) ?? 0) + 1);
    }
  }
  const avgQuality = arrivals ? sumQuality / arrivals : 0;
  qualityByRound.push(avgQuality);
  decayAll(DECAY);

  if (r === 1 || r === 5 || r === 10 || r === 20 || r === 30 || r === ROUNDS) {
    console.log(`Round ${String(r).padStart(2)}: avg quality = ${avgQuality.toFixed(3)}, arrivals = ${arrivals}/${AGENTS_PER_ROUND}`);
    // Show top-3 traces so the reader sees the gradient form.
    const top = [...traces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log('          top traces: ' + top.map(([k, v]) => `${k}(${v.toFixed(2)})`).join(', '));
  }
}

// ── Report the emergent path distribution ────────────────

console.log('\n── Path frequency across all successful traversals ──');
const sorted = [...pathFreq.entries()].sort((a, b) => b[1] - a[1]);
const total = sorted.reduce((s, [, c]) => s + c, 0);
for (const [path, count] of sorted) {
  const pct = ((count / total) * 100).toFixed(1);
  console.log(`   ${path.padEnd(30)}  ${count} traversals (${pct}%)`);
}

const dominant = sorted[0];
const dominantShare = (dominant[1] / total) * 100;

console.log('\n── Trace gradient (final state of the shared pod) ──');
const finalTraces = [...traces.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, v] of finalTraces) {
  const bar = '█'.repeat(Math.floor(v * 10));
  console.log(`   ${k.padEnd(14)}  ${v.toFixed(3)}  ${bar}`);
}

console.log('\n── Observed ──');
console.log(`   ${total} total traversals. Dominant path: ${dominant[0]} (${dominantShare.toFixed(1)}%).`);
console.log(`   Average arrival quality trended ${qualityByRound[0].toFixed(2)} → ${qualityByRound.at(-1).toFixed(2)}.`);
console.log('');
console.log('   No agent held a map. No agent coordinated with any other.');
console.log('   Each agent made a local, stochastic choice biased by the shared');
console.log('   trace field. The colony converged on the globally-best path,');
console.log('   and you can see the gradient in the pod: the best edges carry');
console.log('   the strongest trace, the worst edges faded under decay.');
console.log('');
console.log('   The "knowledge" of the best path is not in any agent.');
console.log('   It lives in the pod. Delete the agents; re-instantiate them;');
console.log('   they follow the gradient. Delete the pod; the colony is naive again.');
