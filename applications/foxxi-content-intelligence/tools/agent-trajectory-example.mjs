#!/usr/bin/env node
/**
 * Agent trajectory example — the agentic-native record vs. the xAPI
 * projection.
 *
 * Demonstrates the thesis: an agent's run is natively a MODAL,
 * POLY-GRANULAR, COMPOSABLE descriptor trajectory (emergent from
 * Interego L1); xAPI is a deliberately lossy projection off it.
 *
 *   Part A (local) — build a trajectory, inspect its modal + granular
 *     shape, restrict it, compose two agents' trajectories, and project
 *     to xAPI to see exactly what the projection drops.
 *   Part B (live)  — record the trajectory to the deployed bridge, read
 *     it back, and assemble the agent's ELR to confirm the projected
 *     tool-calls flowed through to performance-verified competencies.
 *
 * Run (tsx — this example imports the substrate, which uses .js
 * specifiers that resolve to .ts):
 *   npx tsx applications/foxxi-content-intelligence/tools/agent-trajectory-example.mjs
 */
import { mintSessionToken } from '../src/auth.ts';
import {
  buildTrajectory, composeTrajectories, restrictTrajectory,
  trajectoryShape, projectTrajectoryToXapi,
} from '../src/agent-trajectory.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://foxxi-bridge.interego.xwisee.com';
const OBSERVER_WEB_ID = 'https://acme-id.interego.xwisee.com/users/jliu/profile/card#me';
const OBSERVER_USER_ID = 'u-joshua';
const AGENT_DID = 'did:key:z6MkFoxxiTrajectoryAgentExampleV1';
const AGENT_NAME = 'Foxxi Research Agent v1';
const SUBAGENT_DID = 'did:key:z6MkFoxxiSubAgentExampleV1';

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

console.log('=== Agent trajectory example — agentic-native record vs. xAPI projection ===\n');

// ── Part A — the native trajectory, locally ─────────────────────────
// An agent answers a research question. Note the modal statuses:
// Hypothetical = an intention the agent formed; Asserted = what it
// executed (superseding the intention); Counterfactual = a branch it
// considered and rejected. And the granularity: task ▸ subtask ▸ tool-call.
const steps = [
  { id: 'tj:task:research',   modalStatus: 'Asserted',      granularity: 'task',      verb: 'pursue',  objectId: 'urn:task:research-q', objectName: 'Answer a research question' },
  { id: 'tj:sub:gather',      modalStatus: 'Asserted',      granularity: 'subtask',   verb: 'pursue',  objectId: 'urn:sub:gather',     objectName: 'Gather sources', parentId: 'tj:task:research' },
  { id: 'tj:tc:search-plan',  modalStatus: 'Hypothetical',  granularity: 'tool-call', verb: 'intend',  objectId: 'urn:tool:web-search', objectName: 'Use the web-search tool', parentId: 'tj:sub:gather' },
  { id: 'tj:tc:search-exec',  modalStatus: 'Asserted',      granularity: 'tool-call', verb: 'invoke',  objectId: 'urn:tool:web-search', objectName: 'Use the web-search tool', parentId: 'tj:sub:gather', supersedesId: 'tj:tc:search-plan', result: { success: true, quality: 0.93 } },
  { id: 'tj:tc:kb-rejected',  modalStatus: 'Counterfactual', granularity: 'tool-call', verb: 'reject', objectId: 'urn:tool:kb-only',    objectName: 'Use internal-KB only', parentId: 'tj:sub:gather', result: { note: 'rejected — stale corpus' } },
  { id: 'tj:sub:synth',       modalStatus: 'Asserted',      granularity: 'subtask',   verb: 'pursue',  objectId: 'urn:sub:synth',      objectName: 'Synthesise the answer', parentId: 'tj:task:research' },
  { id: 'tj:tc:summarize',    modalStatus: 'Asserted',      granularity: 'tool-call', verb: 'invoke',  objectId: 'urn:tool:summarizer', objectName: 'Use the summariser tool', parentId: 'tj:sub:synth', result: { success: true, quality: 0.9 } },
];
const trajectory = buildTrajectory(AGENT_DID, AGENT_NAME, steps);
const shape = trajectoryShape(trajectory);
console.log('--- native trajectory (modal · poly-granular) ---');
console.log(`  steps: ${trajectory.steps.length}`);
console.log(`  by modal status:  ${JSON.stringify(shape.byModalStatus)}`);
console.log(`  by granularity:   ${JSON.stringify(shape.byGranularity)}`);

// Restriction — focus the "Gather sources" sub-run.
const gather = restrictTrajectory(trajectory, s => s.parentId === 'tj:sub:gather' || s.id === 'tj:sub:gather');
console.log(`\n--- restriction: focused "Gather sources" sub-run → ${gather.steps.length} steps ---`);

// Composition — a delegated sub-agent's trajectory, merged via the L1
// union algebra (the shared `handoff` step has its descriptors unioned).
const subTrajectory = buildTrajectory(SUBAGENT_DID, 'Sub-agent', [
  { id: 'tj:handoff', modalStatus: 'Asserted', granularity: 'subtask', verb: 'accept', objectId: 'urn:sub:gather', objectName: 'Accept delegated subtask' },
  { id: 'tj:tc:sub-fetch', modalStatus: 'Asserted', granularity: 'tool-call', verb: 'invoke', objectId: 'urn:tool:fetch', objectName: 'Use the fetch tool', parentId: 'tj:handoff', result: { success: true, quality: 0.88 } },
]);
const joint = composeTrajectories(trajectory, subTrajectory);
console.log(`--- composition: union(agent, sub-agent) → joint trajectory of ${joint.steps.length} steps ---`);

// Projection to xAPI — deliberately lossy.
const projection = projectTrajectoryToXapi(trajectory, { authoritativeSource: 'did:web:acme-training.example' });
console.log('\n--- projection to xAPI (deliberately lossy) ---');
console.log(`  xAPI statements emitted:        ${projection.statements.length}  (Asserted tool-calls only)`);
console.log(`  retained ONLY in the native form: ${projection.retainedNativeOnly.total}`);
console.log(`    · ${projection.retainedNativeOnly.modalStepsDropped} modal steps  — intentions + counterfactuals xAPI cannot represent`);
console.log(`    · ${projection.retainedNativeOnly.structuralStepsFlattened} structural steps — the task hierarchy xAPI flattens away`);

// ── Part B — live: record to the bridge, read back, assemble the ELR ──
console.log('\n--- live: recording the trajectory to the deployed bridge ---');
const token = await mintSessionToken({ userId: OBSERVER_USER_ID, webId: OBSERVER_WEB_ID, ttlMs: 30 * 60 * 1000 });
const recorded = await callTool(token, 'foxxi.record_agent_trajectory', {
  agent_did: AGENT_DID,
  agent_name: AGENT_NAME,
  steps: steps.map(s => ({
    id: s.id, modal_status: s.modalStatus, granularity: s.granularity, verb: s.verb,
    object_id: s.objectId, object_name: s.objectName,
    parent_id: s.parentId, supersedes_id: s.supersedesId, result: s.result,
  })),
});
console.log(`  recorded: ${recorded.stepCount} native steps · projected ${recorded.projectedToXapi} to xAPI · ${recorded.retainedNativeOnly.total} retained native-only`);

const fetched = await callTool(token, 'foxxi.get_agent_trajectory', { agent_did: AGENT_DID });
console.log(`  read back: ${fetched.stepCount} steps · modal ${JSON.stringify(fetched.byModalStatus)}`);

const elr = await callTool(token, 'foxxi.assemble_learner_record', {
  learner_did: AGENT_DID, learner_name: AGENT_NAME, actor_kind: 'agent',
});
console.log(`  agent ELR: ${elr.summary.performanceCount} performance records · ` +
  `${elr.summary.performanceVerifiedCompetencies} performance-verified competencies ` +
  `(the projected tool-calls flowed through to the IEEE P2997 record)`);

const ok = shape.byModalStatus.Hypothetical >= 1
  && shape.byModalStatus.Counterfactual >= 1
  && projection.statements.length < trajectory.steps.length
  && projection.retainedNativeOnly.total >= 1
  && joint.steps.length >= trajectory.steps.length
  && recorded.recorded === true
  && fetched.stepCount === steps.length
  && elr.summary.performanceVerifiedCompetencies >= 1;
console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} — native trajectory holds what xAPI drops; ` +
  `xAPI is a faithful but lossy projection off the agentic-native record ===`);
process.exit(ok ? 0 : 1);
