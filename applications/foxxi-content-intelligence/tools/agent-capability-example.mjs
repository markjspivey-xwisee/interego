#!/usr/bin/env node
/**
 * Agent capability example — an AI agent learning + demonstrating a tool,
 * recorded in its IEEE P2997 Enterprise Learner Record.
 *
 * The point: the ELR machinery is ACTOR-AGNOSTIC. The same affordances
 * that record a human's training + on-the-job performance record an AI
 * agent's tool use — the agent is just another iep:Agent with a DID.
 *
 * This script:
 *   1. records a sequence of `performed` events for an agent exercising
 *      two tools (foxxi.record_performance, actor_kind=agent);
 *   2. assembles the agent's capability record (foxxi.assemble_learner_record,
 *      actor_kind=agent — agent capability records are discoverable);
 *   3. prints it — performance records + performance-verified competencies.
 *
 * An agent "learns a tool" here the way a performer demonstrates a skill:
 * by exercising it in production and accumulating successful executions,
 * which yields a performance-verified (Asserted) capability competency.
 *
 * Run:
 *   node --experimental-strip-types \
 *     applications/foxxi-content-intelligence/tools/agent-capability-example.mjs
 */
import { mintSessionToken } from '../src/auth.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';

// The observer/operator — a directory user whose token attests the
// agent's work (record_performance records the observer in provenance).
const OBSERVER_WEB_ID = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const OBSERVER_USER_ID = 'u-joshua';

// The AI agent whose capability record we are building.
const AGENT_DID = 'did:key:z6MkFoxxiTutorAgentExampleV1';
const AGENT_NAME = 'Foxxi Tutor Agent v1';

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
  if (body && typeof body === 'object' && typeof body.error === 'string') {
    throw new Error(`${name}: ${body.error}`);
  }
  return body;
}

console.log('=== Agent capability example — an AI agent learning a tool ===\n');

const token = await mintSessionToken({ userId: OBSERVER_USER_ID, webId: OBSERVER_WEB_ID, ttlMs: 30 * 60 * 1000 });
console.log(`✓ observer token minted (${OBSERVER_USER_ID})\n`);

// 1. The agent exercises tools in production — record each as a
//    performance event. Verb `performed`, context production.
const runs = [
  { task: 'Use the web-search tool', success: true,  quality: 0.94 },
  { task: 'Use the web-search tool', success: true,  quality: 0.88 },
  { task: 'Use the web-search tool', success: true,  quality: 0.91 },
  { task: 'Use the web-search tool', success: false, quality: 0.20 },
  { task: 'Use the web-search tool', success: true,  quality: 0.96 },
  { task: 'Summarise a document',    success: true,  quality: 0.90 },
  { task: 'Summarise a document',    success: true,  quality: 0.85 },
  { task: 'Summarise a document',    success: true,  quality: 0.92 },
];
console.log(`--- recording ${runs.length} performance events for ${AGENT_NAME} ---`);
for (const run of runs) {
  const res = await callTool(token, 'foxxi.record_performance', {
    actor_did: AGENT_DID,
    actor_kind: 'agent',
    task_name: run.task,
    success: run.success,
    quality: run.quality,
    duration_iso: 'PT2S',
    cost_usd: 0.004,
  });
  console.log(`  ${res.success ? '✓' : '✗'} ${run.task}  (statement ${String(res.statementId).slice(0, 8)}…)`);
}

// 2. Assemble the agent's capability record — the same IEEE P2997 ELR
//    affordance a human uses, with actor_kind=agent.
console.log(`\n--- assembling ${AGENT_NAME}'s capability record (IEEE P2997, actor_kind=agent) ---`);
const elr = await callTool(token, 'foxxi.assemble_learner_record', {
  learner_did: AGENT_DID,
  learner_name: AGENT_NAME,
  actor_kind: 'agent',
});

// 3. Print the capability record.
console.log(`\nsubjectKind:          ${elr.subjectKind}`);
console.log(`conformsTo:           ${elr.conformsTo}`);
console.log(`performance records:  ${elr.summary.performanceCount}  (success rate ${Math.round((elr.summary.performanceSuccessRate ?? 0) * 100)}%)`);
console.log(`competencies:         ${elr.summary.competencyCount}  (${elr.summary.performanceVerifiedCompetencies} performance-verified)`);
console.log('\ntool capabilities the agent has demonstrated:');
for (const c of elr.competencies) {
  const es = c.evidenceSummary;
  console.log(`  · ${c.label}`);
  console.log(`      basis=${c.basis}  modalStatus=${c.modalStatus}  —  ${es.performanceExecutions} executions, ` +
    `${Math.round((es.performanceSuccessRate ?? 0) * 100)}% success, avg quality ${es.performanceAvgQuality ?? '—'}`);
  if (c.supersedes) console.log(`      iep:supersedes — ${c.supersedes}`);
}
console.log('\nP2997 raw-data-location provenance:');
for (const p of elr.provenance.rawDataLocations.slice(0, 3)) {
  console.log(`  · [${p.kind}] ${p.location}`);
}

const ok = elr.subjectKind === 'agent'
  && elr.summary.performanceCount >= runs.length
  && elr.summary.performanceVerifiedCompetencies >= 2;
console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} — agent capability record assembled; ` +
  `${elr.summary.performanceVerifiedCompetencies} performance-verified tool competencies ===`);
process.exit(ok ? 0 : 1);
