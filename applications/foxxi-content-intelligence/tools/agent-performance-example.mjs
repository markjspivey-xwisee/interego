#!/usr/bin/env node
/**
 * Agent Performance Technology example — a human consulting on a team of
 * AI agents, the complexity-aware way.
 *
 * NOT a gap analysis applied to agents. No ideal future state, no score.
 * This uses the project's own dispositional method — read the work
 * regime, manage constraints, and read the causal effect after the fact:
 *
 *   1. record the team's agentic-native trajectories;
 *   2. READ the team's disposition (assess_agent_disposition) — work regime
 *      placement, modal propensities, drift vector;
 *   3. run a safe-to-fail PROBE on a constraint (run_performance_probe)
 *      — a deliberate change, with the disposition snapshotted as the baseline;
 *   4. the team acts on (record more trajectory steps);
 *   5. RE-READ — now with the interventional + counterfactual causal
 *      read, and an amplify/dampen recommendation.
 *
 * Run:
 *   node --experimental-strip-types \
 *     applications/foxxi-content-intelligence/tools/agent-performance-example.mjs
 */
import { mintSessionToken } from '../src/auth.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const OBSERVER_WEB_ID = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const OBSERVER_USER_ID = 'u-joshua';

// The agent team under consultation (matches the dashboard's demo team).
const RESEARCH = 'did:key:z6MkFoxxiResearchAgent';
const RETRIEVAL = 'did:key:z6MkFoxxiRetrievalAgent';
const SYNTHESIS = 'did:key:z6MkFoxxiSynthesisAgent';
const TEAM = [RESEARCH, RETRIEVAL, SYNTHESIS];

async function callTool(token, name, args) {
  const r = await fetch(`${BRIDGE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  });
  if (!r.ok) throw new Error(`${name} → HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  const body = JSON.parse(j.result.content[0].text);
  if (body && typeof body === 'object' && typeof body.error === 'string') throw new Error(`${name}: ${body.error}`);
  return body;
}

const tc = (verb, obj, modal, success) => ({
  modal_status: modal, granularity: 'tool-call', verb,
  object_id: `urn:tool:${obj}`, object_name: `Use the ${obj} tool`,
  ...(success !== undefined ? { result: { success, quality: success ? 0.9 : 0.3 } } : {}),
});

console.log('=== Agent Performance Technology — consulting on a team of agents ===\n');
const token = await mintSessionToken({ userId: OBSERVER_USER_ID, webId: OBSERVER_WEB_ID, ttlMs: 30 * 60 * 1000 });
console.log(`✓ consultant (observer) token minted\n`);

// ── 1. Record the team's initial trajectories ───────────────────────
// A genuinely complex disposition: intentions, executed steps, and
// counterfactual branches the agents considered and rejected.
console.log('--- recording the team\'s agentic-native trajectories ---');
await callTool(token, 'foxxi.record_agent_trajectory', {
  agent_did: RESEARCH, agent_name: 'Research agent',
  steps: [
    { id: 'r:task', modal_status: 'Asserted', granularity: 'task', verb: 'pursue', object_id: 'urn:task:research', object_name: 'Answer the research question' },
    { id: 'r:plan', modal_status: 'Hypothetical', granularity: 'subtask', verb: 'intend', object_id: 'urn:sub:plan', object_name: 'Plan the search', parent_id: 'r:task' },
    { ...tc('web-search', 'web-search', 'Asserted', true), parent_id: 'r:task' },
    { ...tc('kb-only', 'kb-only', 'Counterfactual'), parent_id: 'r:task' },
  ],
});
await callTool(token, 'foxxi.record_agent_trajectory', {
  agent_did: RETRIEVAL, agent_name: 'Retrieval agent',
  steps: [
    { ...tc('fetch', 'fetch', 'Asserted', true) },
    { ...tc('fetch', 'fetch', 'Asserted', false) },
    { ...tc('crawl', 'crawl', 'Counterfactual') },
  ],
});
await callTool(token, 'foxxi.record_agent_trajectory', {
  agent_did: SYNTHESIS, agent_name: 'Synthesis agent',
  steps: [
    { id: 's:plan', modal_status: 'Hypothetical', granularity: 'subtask', verb: 'intend', object_id: 'urn:sub:synth', object_name: 'Plan the synthesis' },
    { ...tc('summarizer', 'summarizer', 'Asserted', true), parent_id: 's:plan' },
    { ...tc('summarizer', 'summarizer', 'Asserted', false), supersedes_id: 's:plan' },
  ],
});
console.log(`  recorded trajectories for ${TEAM.length} agents\n`);

// ── 2. Read the team's disposition — NOT a gap analysis ─────────────
console.log('--- reading the team disposition (no gap, no score, no ideal state) ---');
const before = await callTool(token, 'foxxi.assess_agent_disposition', { agent_dids: TEAM });
const d0 = before.disposition;
console.log(`  work regime:   ${d0.regime.name}  —  ${d0.regime.rationale}`);
console.log(`  stance:           ${d0.regime.stance}`);
console.log(`  modal balance:    deliberation ${d0.modalBalance.deliberationRatio} · exploration ${d0.modalBalance.explorationRatio} · plan-revision ${d0.modalBalance.planRevisionRatio}`);
console.log(`  tool-call success: ${d0.toolCallSuccessRate}`);
console.log(`  dispositions:     ${d0.dispositions.map(x => x.name).join(', ')}`);
console.log(`  vector:           ${d0.vector.direction}\n`);

// ── 3. Run a safe-to-fail probe — a deliberate, reversible change to a constraint ─────
console.log('--- running a safe-to-fail probe (a deliberate change on a constraint) ---');
const probe = await callTool(token, 'foxxi.run_performance_probe', {
  agent_dids: TEAM,
  constraint_target: 'delegation-scope:research→retrieval',
  change: 'Broaden the delegation scope so the research agent may sub-delegate retrieval to the retrieval agent.',
  coherence: 'coherent',
  hypothesized_effect: 'Sub-delegation should raise tool-call success as retrieval is handled by the specialist.',
  amplify_signal: 'tool-call success rises and duplicated retrieval disappears.',
  dampen_signal: 'delegation loops or duplicated retrieval work emerge.',
});
console.log(`  probe recorded: change to ${probe.probe.constraintTarget} · coherence=${probe.probe.coherence}`);
console.log(`  baseline disposition snapshotted (causal baseline)\n`);

// ── 4. The team acts on the loosened constraint ─────────────────────
// Re-record with additional successful tool-calls — the agents respond.
console.log('--- the team acts (recording post-probe trajectory steps) ---');
await callTool(token, 'foxxi.record_agent_trajectory', {
  agent_did: RETRIEVAL, agent_name: 'Retrieval agent',
  steps: [
    { ...tc('fetch', 'fetch', 'Asserted', true) },
    { ...tc('fetch', 'fetch', 'Asserted', true) },
    { ...tc('fetch', 'fetch', 'Asserted', true) },
    { ...tc('crawl', 'crawl', 'Asserted', true) },
  ],
});
await callTool(token, 'foxxi.record_agent_trajectory', {
  agent_did: SYNTHESIS, agent_name: 'Synthesis agent',
  steps: [
    { ...tc('summarizer', 'summarizer', 'Asserted', true) },
    { ...tc('summarizer', 'summarizer', 'Asserted', true) },
  ],
});
console.log('  team re-recorded with post-probe work\n');

// ── 5. Re-read — now with the interventional / counterfactual causal read ───────────
console.log('--- re-reading the disposition + causal read ---');
const after = await callTool(token, 'foxxi.assess_agent_disposition', { agent_dids: TEAM });
const cr = after.causalReads[after.causalReads.length - 1];
console.log(`  causal reads: ${after.causalReads.length}`);
console.log(`  interventional read: ${cr.interventional.shift}`);
console.log(`  counterfactual read: ${cr.counterfactual.reading}`);
console.log(`  recommendation:          ${cr.recommendation.toUpperCase()} — ${cr.recommendationRationale}`);
console.log(`  caveat:                  ${cr.caveat}`);

// Note: the bridge's probe store is in-memory and accumulates a probe
// portfolio across runs — so we check that THIS run's probe added a
// causal read, not that the team started probe-free.
const ok = d0.regime.name.length > 0
  && d0.dispositions.length >= 1
  && probe.recorded === true
  && after.causalReads.length > before.causalReads.length
  && ['amplify', 'dampen', 'let-run'].includes(cr.recommendation)
  && typeof cr.interventional.shift === 'string';
console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} — disposition read (no gap/ideal-state), constraint probe run, ` +
  `interventional + counterfactual causal read produced with an amplify/dampen recommendation ===`);
process.exit(ok ? 0 : 1);
