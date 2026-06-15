#!/usr/bin/env node
// Single-agent entry: rev-195 self-improving demo, one agent.
//
//   node examples/rev195-self-improving/one.mjs --task task.json
//
// Mints an ephemeral ECDSA wallet for the agent, runs the controller
// loop until the deterministic verifier (node --test) goes green or
// the max-tick budget is exhausted. Every tool call the Claude session
// makes lands as a signed trajectory step on the agent's pod via the
// rev-195 record_trajectory_step MCP tool (Tier-1.A); the calibration
// profile is consulted on every tick and may replan the next prompt
// (Tier-3). Optional --smoke runs the loop WITHOUT calling Claude —
// useful for wire-level verification.
//
// AUTH: this script uses your local Claude Code OAuth session via
// @anthropic-ai/claude-agent-sdk. NO API key required.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { runLoop } from './controller.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── args ────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const taskPath = resolvePath(__dirname, args.task ?? 'task.json');
const SMOKE = args.smoke === true;
const task = JSON.parse(readFileSync(taskPath, 'utf8'));

console.log(`[one] task=${task.title}`);
console.log(`[one] mode=${SMOKE ? 'smoke (no LLM)' : 'live (Claude Code SDK)'}`);
console.log(`[one] workspace=${resolvePath(__dirname, task.workspace)}`);

// ── agent identity ──────────────────────────────────────────────────
const wallet = Wallet.createRandom();
const agent = {
  did: `did:ethr:${wallet.address}`,
  label: 'alpha',
  wallet,
};
console.log(`[one] agent.did=${agent.did}`);

// ── act() — Claude Code SDK driver ──────────────────────────────────
async function liveActImpl({ agent, plan, situation, task, workspaceRoot, tick }) {
  // Lazy-load the SDK so smoke mode doesn't require it installed.
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');

  const workspace = resolvePath(workspaceRoot, task.workspace);
  const implRel = task.implementation_file.replace(/^workspace[\\/]/, '');
  const implPath = resolvePath(workspace, implRel);

  // SDK-side MCP server gives the agent two purpose-shaped tools.
  // Everything else (Read, Edit, Bash, Grep) comes from the SDK's
  // builtin permission model.
  const tools = createSdkMcpServer({
    name: 'rev195-demo',
    version: '0.1.0',
    tools: [
      tool(
        'read_task',
        'Return the canonical task spec (description, success criteria, tests summary, hints).',
        {},
        async () => ({ content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }),
      ),
      tool(
        'write_implementation',
        'Write the implementation file at the workspace path the task declares. ESM (export named function). Overwrites any prior contents. Returns the absolute path written.',
        { code: z.string().describe('Full file contents — ESM, exports the function named in task.expected_export') },
        async ({ code }) => {
          mkdirSync(dirname(implPath), { recursive: true });
          writeFileSync(implPath, code, 'utf8');
          return { content: [{ type: 'text', text: JSON.stringify({ written: implPath, bytes: code.length }) }] };
        },
      ),
    ],
  });

  // System prompt encodes the substrate-honest framing — the agent
  // doesn't free-form-reason, it acts on the substrate's decision.
  const systemPrompt =
`You are agent ${agent.label} (DID ${agent.did}) inside the rev-195 self-improving demo.

THE SUBSTRATE HAS ALREADY DECIDED YOUR STRATEGY THIS TICK
  pgsl_decide returned: strategy=${plan.strategy}, intervention=${plan.selectedIntervention}
  Concrete next action: ${plan.nextAction.kind}
  Prompt the substrate generated: ${plan.nextAction.prompt}

YOUR JOB
  Carry out the action above. Do NOT free-form re-decide. The tick's
  outer loop will detect the verifier green and exit on the next pass.

GROUND RULES
  - The task is described by the \`read_task\` tool. Call it first.
  - When you have code ready, call \`write_implementation\`. The
    workspace dir is ${workspace.replace(/\\/g, '/')}.
  - The implementation file is ${implRel}.
  - Test command: ${task.test_command}. You don't run it; the outer
    loop does after you finish your turn.
  - Reuse > rewrite when possible (the task's reuse_signal documents
    why this matters). Use Grep/Read to find existing patterns BEFORE
    writing fresh code, ESPECIALLY when the strategy is "explore".

PRIOR STEPS THIS SESSION
  ${(situation.lastVerbs ?? []).slice(0, 6).map(v => `- ${v.modalStatus} (${v.cid?.slice(0, 12) ?? 'no-cid'}…)`).join('\n  ') || '(none — first tick)'}

EXIT
  Call write_implementation exactly once with your candidate code, or
  call read_task / Grep / Read first if you need orientation, then
  write_implementation. End your turn after writing.`;

  let summary = '';
  let acted = false;
  try {
    for await (const msg of query({
      prompt: plan.nextAction.prompt,
      options: {
        model: process.env.AGENT_MODEL ?? 'claude-sonnet-4-6',
        maxTurns: 12,
        systemPrompt,
        mcpServers: { 'rev195-demo': tools },
        permissionMode: 'bypassPermissions',
        settingSources: [],
      },
    })) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const c of msg.message.content) {
          if (c.type === 'tool_use' && c.name === 'mcp__rev195-demo__write_implementation') {
            acted = true;
          }
          if (c.type === 'text') summary += c.text.slice(0, 100);
        }
      }
    }
  } catch (err) {
    return { ok: false, acted: true, error: err.message, summary: err.message };
  }
  return {
    ok: true,
    acted: acted || existsSync(implPath),
    verb: 'authored',
    objectName: implRel,
    summary: summary.slice(0, 200) || `tick ${tick} — wrote implementation`,
  };
}

// ── act() — smoke (no-LLM) ──────────────────────────────────────────
async function smokeActImpl({ agent, plan, task, workspaceRoot, tick }) {
  // Scripted implementation that ALWAYS passes the tests on tick 1.
  // The point of smoke mode is to verify the WIRES, not the AI.
  const workspace = resolvePath(workspaceRoot, task.workspace);
  const implRel = task.implementation_file.replace(/^workspace[\\/]/, '');
  const implPath = resolvePath(workspace, implRel);
  mkdirSync(dirname(implPath), { recursive: true });
  const code =
`// Smoke-mode implementation — written by the controller's smokeActImpl,
// NOT by an LLM. Pinning the contract end-to-end for the demo's
// wire-level test.

export function modalDistribution(input) {
  const counts = { Asserted: 0, Hypothetical: 0, Counterfactual: 0, other: 0, total: 0 };
  if (typeof input !== 'string' || input.length === 0) return counts;
  for (const line of input.split('\\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const m = obj?.modalStatus;
    if (m === 'Asserted') counts.Asserted++;
    else if (m === 'Hypothetical') counts.Hypothetical++;
    else if (m === 'Counterfactual') counts.Counterfactual++;
    else counts.other++;
    counts.total++;
  }
  return counts;
}
`;
  writeFileSync(implPath, code, 'utf8');
  return { ok: true, acted: true, verb: 'scripted-author', objectName: implRel, summary: `tick ${tick} smoke wrote ${implPath}` };
}

// ── run ─────────────────────────────────────────────────────────────
const result = await runLoop({
  agent, task,
  workspaceRoot: __dirname,
  maxTicks: task.max_ticks ?? 12,
  peers: [],
  actImpl: SMOKE ? smokeActImpl : liveActImpl,
  log: (s) => console.log(s),
  sseEnabled: false, // single-agent has no peer pods to subscribe to
});

console.log('\n[one] ═══════════════════════════════════════════════');
console.log(`[one] verdict:       ${result.verdict}`);
console.log(`[one] ticks:         ${result.ticks}`);
console.log(`[one] replanned:     ${result.replanned ? 'YES (Tier-3 fired)' : 'no'}`);
console.log(`[one] descriptors:   ${result.descriptors.length} signed trajectory steps on agent's pod`);
console.log(`[one] sessionId:     ${result.sessionId}`);
if (result.descriptors.length > 0) {
  console.log(`[one] first descriptor: ${result.descriptors[0]}`);
  console.log(`[one] last descriptor:  ${result.descriptors[result.descriptors.length - 1]}`);
}
console.log('[one] ═══════════════════════════════════════════════');

process.exit(result.verdict === 'pass' ? 0 : 1);

// ── helpers ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') out.smoke = true;
    else if (a === '--task' && argv[i + 1]) { out.task = argv[++i]; }
    else if (a.startsWith('--task=')) out.task = a.slice('--task='.length);
  }
  return out;
}
