/**
 * Multi-team agent / harness bake-off — runnable demo.
 *
 * The scenario: an enterprise platform org where three teams have each
 * built a competing coding-agent harness. They argue over whose is best;
 * the executives must decide whether to standardise on one — or keep
 * funding more than one. This is exactly the debate Interego + Foxxi can
 * now ground in evidence instead of opinion.
 *
 * It exercises, in process (no bridge, no network), the three new
 * modules end to end:
 *   · agent-run-ingest.ts  — external runs ingested with one call each
 *   · agent-evaluation.ts  — a cross-pod cohort with a request/accept
 *                            delegation handshake
 *   · agent-portfolio.ts   — the complexity-aware comparative read
 *
 * Run:  npx tsx applications/foxxi-content-intelligence/tools/agent-evaluation-example.mjs
 *
 * The point of the demo: a naive leaderboard would crown the harness
 * with the highest success rate. The portfolio read refuses to — it
 * reads the *complexity of the work* and answers the real question
 * ("converge on one, or not?") accordingly.
 */

import { ingestExternalRun } from '../src/agent-run-ingest.js';
import { EvaluationRegistry } from '../src/agent-evaluation.js';
import { comparePortfolio } from '../src/agent-portfolio.js';

const registry = new EvaluationRegistry();

// ── 1. An executive opens the evaluation cohort ──────────────────────
const evaluation = registry.open({
  name: 'Coding-agent harness bake-off',
  decisionQuestion: 'Should the platform org standardise on one coding-agent harness — or keep funding more than one?',
  openedBy: 'did:web:platform-exec',
});
console.log(`\n  EVALUATION  ${evaluation.name}`);
console.log(`  question    ${evaluation.decisionQuestion}\n`);

// ── 2. Three teams request enrollment of their agents (cross-pod) ────
//     Each candidate's DID lives on that team's own pod.
const teams = [
  { team: 'Team Atlas', agentDid: 'did:web:atlas.acme.example:agents:atlas-coder', agentName: 'Atlas Coder', harness: { name: 'Atlas Harness', version: '3.1', runtime: 'codex' } },
  { team: 'Team Beacon', agentDid: 'did:web:beacon.acme.example:agents:beacon-coder', agentName: 'Beacon Coder', harness: { name: 'Beacon Harness', version: '0.9', runtime: 'claude-code' } },
  { team: 'Team Cobalt', agentDid: 'did:web:cobalt.acme.example:agents:cobalt-coder', agentName: 'Cobalt Coder', harness: { name: 'Cobalt Harness', version: '2.0', runtime: 'custom' } },
];
const candidates = {};
for (const t of teams) {
  const c = registry.requestEnrollment(evaluation.id, { ...t, requestedBy: `did:web:${t.team.toLowerCase().replace(/\s+/g, '-')}-lead` });
  // The cross-pod delegation grant: the owner accepts the request.
  registry.decide(evaluation.id, c.candidateId, 'accept', 'did:web:platform-exec');
  candidates[t.team] = c.candidateId;
  console.log(`  enrolled    ${t.agentName.padEnd(14)} (${t.team})  →  accepted`);
}

// ── 3. Each team records real runs (one ingest call per run) ─────────
// Atlas — execution-biased: commits to a line, executes it, rarely
// revises. High raw success, cheap. Simple tool-call form.
function atlasRun(i) {
  const ok = true; // 5 / 5 succeed — a flawless leaderboard record
  return {
    agentDid: teams[0].agentDid, agentName: 'Atlas Coder', harness: teams[0].harness,
    task: { name: `Implement feature ticket PLAT-${100 + i}` },
    toolCalls: [
      { tool: 'read_file', success: true },
      { tool: 'edit_file', success: true },
      { tool: 'run_tests', success: ok },
    ],
    outcome: { success: ok, quality: ok ? 0.86 : 0.4, costUsd: 0.041 },
  };
}
// Beacon — exploratory: forms intentions, explores branches, abandons
// some (Counterfactual), revises plans in flight (supersedes). Lower raw
// success, pricier — but adaptive. Rich modal/poly-granular form.
function beaconRun(i) {
  const ok = i % 3 !== 2; // ~3 / 5 succeed cleanly
  const base = `b${i}`;
  return {
    agentDid: teams[1].agentDid, agentName: 'Beacon Coder', harness: teams[1].harness,
    task: { name: `Implement feature ticket PLAT-${100 + i}` },
    steps: [
      { id: `${base}-task`, modalStatus: 'Asserted', granularity: 'task', verb: 'performed', objectId: `${base}-t`, objectName: `ticket PLAT-${100 + i}`, result: { success: ok } },
      { id: `${base}-plan`, modalStatus: 'Hypothetical', granularity: 'subtask', verb: 'plan', objectId: `${base}-p`, objectName: 'plan: refactor then patch', parentId: `${base}-task` },
      { id: `${base}-cf1`, modalStatus: 'Counterfactual', granularity: 'subtask', verb: 'consider', objectId: `${base}-c1`, objectName: 'rejected: rewrite the module wholesale', parentId: `${base}-task` },
      { id: `${base}-cf2`, modalStatus: 'Counterfactual', granularity: 'tool-call', verb: 'consider', objectId: `${base}-c2`, objectName: 'rejected: monkey-patch at call site', parentId: `${base}-task` },
      { id: `${base}-act1`, modalStatus: 'Asserted', granularity: 'tool-call', verb: 'edit_file', objectId: `${base}-a1`, objectName: 'apply revised patch', parentId: `${base}-task`, supersedesId: `${base}-plan`, result: { success: true } },
      { id: `${base}-act2`, modalStatus: 'Asserted', granularity: 'tool-call', verb: 'run_tests', objectId: `${base}-a2`, objectName: 'verify', parentId: `${base}-task`, result: { success: ok } },
    ],
    outcome: { success: ok, quality: ok ? 0.82 : 0.55, costUsd: 0.114 },
  };
}
// Cobalt — middling: simple, committed, but unreliable execution.
function cobaltRun(i) {
  const ok = i % 2 === 0; // ~3 / 5 succeed
  return {
    agentDid: teams[2].agentDid, agentName: 'Cobalt Coder', harness: teams[2].harness,
    task: { name: `Implement feature ticket PLAT-${100 + i}` },
    toolCalls: [
      { tool: 'read_file', success: true },
      { tool: 'edit_file', success: ok },
      { tool: 'run_tests', success: ok },
    ],
    outcome: { success: ok, quality: ok ? 0.7 : 0.38, costUsd: 0.068 },
  };
}

const RUNS = 5;
for (let i = 0; i < RUNS; i++) {
  for (const [team, make] of [['Team Atlas', atlasRun], ['Team Beacon', beaconRun], ['Team Cobalt', cobaltRun]]) {
    const input = make(i);
    const ingested = ingestExternalRun(input);
    registry.addRun(evaluation.id, candidates[team], {
      trajectory: ingested.trajectory,
      success: input.outcome.success,
      quality: input.outcome.quality,
      costUsd: input.outcome.costUsd,
      recordedAt: new Date().toISOString(),
    });
  }
}
console.log(`\n  recorded    ${RUNS} runs per candidate (${RUNS * 3} external-agent runs ingested)\n`);

// ── 4. The complexity-aware portfolio read ───────────────────────────
const state = registry.get(evaluation.id);
const evidence = state.candidates
  .filter(c => c.status === 'accepted')
  .map(c => ({ candidateId: c.candidateId, agentName: c.agentName, team: c.team, harness: c.harness, runs: c.runs }));
const read = comparePortfolio(state.evaluation, evidence);

console.log('  ┌─ PORTFOLIO READ ' + '─'.repeat(56));
console.log(`  │  work domain (Cynefin):  ${read.workDomain.domain}`);
console.log(`  │  ${read.workDomain.rationale}`);
console.log('  │');
for (const c of read.candidates) {
  const rp = c.runProfile;
  console.log(`  │  ${c.agentName}  —  ${c.team}  [${c.harness?.name ?? '?'}]`);
  console.log(`  │    runs ${c.runCount} · success ${rp.successRate} · avg quality ${rp.avgQuality ?? '—'} · avg cost $${rp.avgCostUsd ?? '—'}`);
  console.log(`  │    disposition: ${c.disposition.named.map(n => n.name).join(', ')}`);
  console.log(`  │    coherence with the work: ${c.coherence.rating.toUpperCase()} — ${c.coherence.reading}`);
  console.log('  │');
}
console.log(`  │  DECISION TYPE: ${read.decision.type}`);
console.log(`  │  ${read.decision.reading}`);
console.log('  │');
console.log(`  │  PORTFOLIO STANCE: ${read.portfolioStance.toUpperCase()}`);
console.log(`  │  ${wrap(read.stanceRationale, 70, '  │  ')}`);
if (read.convergeOn) {
  console.log('  │');
  console.log(`  │  converge on: ${read.convergeOn.agentName} (${read.convergeOn.team})`);
  console.log(`  │  ${wrap(read.convergeOn.rationale, 70, '  │  ')}`);
}
if (read.recombination) {
  console.log('  │');
  console.log(`  │  recombine: ${read.recombination.candidates.join(' + ')}`);
  console.log(`  │  ${wrap(read.recombination.reading, 70, '  │  ')}`);
}
console.log('  │');
console.log('  │  ANSWER TO "SHOULD WE DEVELOP ONLY ONE?":');
console.log(`  │  ${wrap(read.decision.convergenceGuidance, 70, '  │  ')}`);
console.log('  │');
console.log(`  │  ${wrap(read.caveat, 70, '  │  ')}`);
console.log('  └' + '─'.repeat(73));

// Demonstrate the point in one line: the naive pick vs the read.
const naive = [...read.candidates].sort((a, b) => b.runProfile.successRate - a.runProfile.successRate)[0];
console.log(`\n  A naive leaderboard would crown: ${naive.agentName} (highest success ${naive.runProfile.successRate}).`);
console.log(`  The portfolio read's answer: ${read.portfolioStance.toUpperCase()} — it read the work as ${read.workDomain.domain},`);
console.log(`  not a measurement contest. That difference is the whole point.\n`);

function wrap(s, width, prefix) {
  const words = String(s).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + prefix);
}
