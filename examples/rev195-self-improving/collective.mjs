#!/usr/bin/env node
// Multi-agent entry: rev-195 self-improving demo, collective.
//
//   node examples/rev195-self-improving/collective.mjs --task task.json --agents alpha,beta
//
// Two agents (alpha + beta) each work the same task in their own
// workspace subdirectory. SSE-driven wake: when alpha publishes,
// beta's controller wakes; when beta publishes, alpha's wakes. A
// judge scores both implementations on correctness + reuse using
// the LLM judge in verifiers.mjs.
//
// On judge verdict, the controller POSTs to the Foxxi bridge's
// /agent/teach endpoint with the higher-scoring agent as teacher and
// the lower-scoring as learner — A2A teaching as a first-class
// substrate event. Then reduce_chain folds each agent's trajectory
// into a content-addressed verdict.
//
// AUTH: this script uses your local Claude Code OAuth session via
// @anthropic-ai/claude-agent-sdk. NO API key required.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import { runLoop } from './controller.mjs';
import { llmJudge } from './verifiers.mjs';
import { recordTrajectoryStep, foxxiUrl, relayUrl } from './tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── args ────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const taskPath = resolvePath(__dirname, args.task ?? 'task.json');
const SMOKE = args.smoke === true;
const agentLabels = (args.agents ?? 'alpha,beta').split(',').map(s => s.trim()).filter(Boolean);
if (agentLabels.length < 2) {
  console.error('collective: need at least two --agents (e.g. alpha,beta)');
  process.exit(2);
}
const task = JSON.parse(readFileSync(taskPath, 'utf8'));

console.log(`[collective] task=${task.title}`);
console.log(`[collective] mode=${SMOKE ? 'smoke (no LLM)' : 'live (Claude Code SDK)'}`);
console.log(`[collective] agents=${agentLabels.join(', ')}`);

// ── agent identities ────────────────────────────────────────────────
const agents = agentLabels.map(label => {
  const wallet = Wallet.createRandom();
  // Each agent gets its OWN workspace subdir so they don't clobber
  // each other when both are writing implementations.
  const workspaceSubdir = `workspace-${label}`;
  return {
    did: `did:ethr:${wallet.address}`,
    label, wallet, workspaceSubdir,
  };
});
for (const a of agents) console.log(`[collective] ${a.label}.did=${a.did} workspace=${a.workspaceSubdir}`);

// Each agent's workspaceRoot is the demo dir; their workspace inside
// is the per-agent subdir. We materialise the per-agent task fixture
// by cloning task.json with the workspace path adjusted.
function taskForAgent(agent) {
  return {
    ...task,
    workspace: agent.workspaceSubdir,
    test_command: task.test_command.replace(/workspace\b/, agent.workspaceSubdir),
    implementation_file: task.implementation_file.replace(/^workspace[\\/]/, `${agent.workspaceSubdir}/`),
    tests: { ...task.tests, file: task.tests.file.replace(/^workspace[\\/]/, `${agent.workspaceSubdir}/`) },
  };
}

// Pre-create the per-agent workspaces and copy the tests into each
// (the tests are the spec — every agent runs the same ones).
for (const a of agents) {
  const dir = resolvePath(__dirname, a.workspaceSubdir, 'tests');
  mkdirSync(dir, { recursive: true });
  const testSrc = resolvePath(__dirname, task.tests.file);
  const testDst = resolvePath(dir, 'modalDistribution.test.mjs');
  // Adjust the import path so the test points at the per-agent impl.
  const testContent = readFileSync(testSrc, 'utf8');
  writeFileSync(testDst, testContent, 'utf8');
}

// ── act() implementations (live + smoke) — same factories one.mjs ──
async function liveActImplFactory() {
  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');
  return async function liveActImpl({ agent, plan, situation, task, workspaceRoot, peerSources, tick }) {
    const workspace = resolvePath(workspaceRoot, task.workspace);
    const implRel = task.implementation_file.replace(new RegExp(`^${task.workspace}[\\\\/]`), '');
    const implPath = resolvePath(workspace, implRel);
    const tools = createSdkMcpServer({
      name: 'rev195-collective',
      version: '0.1.0',
      tools: [
        tool('read_task', 'Return the task spec.', {}, async () =>
          ({ content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] })),
        tool('write_implementation',
          'Write the implementation file. ESM with named export. Overwrites prior.',
          { code: z.string() },
          async ({ code }) => {
            mkdirSync(dirname(implPath), { recursive: true });
            writeFileSync(implPath, code, 'utf8');
            return { content: [{ type: 'text', text: JSON.stringify({ written: implPath }) }] };
          }),
        tool('read_peer_implementation',
          'Return the current implementation source of a named peer (if they have authored one), so this agent can REUSE rather than rewrite. The teaching signal from the judge will reward agents that did this.',
          { peerLabel: z.string() },
          async ({ peerLabel }) => {
            const src = peerSources?.[peerLabel];
            return { content: [{ type: 'text', text: src ?? '(peer has not authored yet)' }] };
          }),
      ],
    });
    const peerList = Object.keys(peerSources ?? {}).filter(p => p !== agent.label);
    const systemPrompt =
`You are agent ${agent.label} in a rev-195 self-improving collective.

SUBSTRATE DECIDED YOUR STRATEGY THIS TICK
  strategy=${plan.strategy} intervention=${plan.selectedIntervention} action=${plan.nextAction.kind}
  Substrate-generated prompt: ${plan.nextAction.prompt}

PEERS YOU CAN SEE
  ${peerList.length === 0 ? '(no peers have published yet)' : peerList.map(p => `- ${p}: has authored an implementation`).join('\n  ')}
  Use read_peer_implementation({ peerLabel }) to read theirs BEFORE writing yours.
  REUSE > REWRITE — the judge scores this explicitly.

WRITE YOUR IMPLEMENTATION
  workspace path: ${implPath.replace(/\\/g, '/')}
  test fixture summary: ${task.tests.summary}
  When you've called write_implementation, end your turn.`;
    let summary = '';
    let acted = false;
    try {
      for await (const msg of query({
        prompt: plan.nextAction.prompt,
        options: {
          model: process.env.AGENT_MODEL ?? 'claude-sonnet-4-6',
          maxTurns: 14,
          systemPrompt,
          mcpServers: { 'rev195-collective': tools },
          permissionMode: 'bypassPermissions',
          settingSources: [],
        },
      })) {
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const c of msg.message.content) {
            if (c.type === 'tool_use' && c.name === 'mcp__rev195-collective__write_implementation') acted = true;
            if (c.type === 'text') summary += c.text.slice(0, 100);
          }
        }
      }
    } catch (err) {
      return { ok: false, acted: true, error: err.message, summary: err.message };
    }
    return { ok: true, acted: acted || existsSync(implPath), verb: 'authored', objectName: implRel, summary: summary.slice(0, 200) };
  };
}

function smokeActImplFor(label) {
  // alpha: naive write-from-scratch (lower reuse).
  // beta:  reuses alpha's implementation if available (higher reuse).
  return async function smokeActImpl({ agent, plan, task, workspaceRoot, peerSources, tick }) {
    const workspace = resolvePath(workspaceRoot, task.workspace);
    const implRel = task.implementation_file.replace(new RegExp(`^${task.workspace}[\\\\/]`), '');
    const implPath = resolvePath(workspace, implRel);
    mkdirSync(dirname(implPath), { recursive: true });
    let code;
    const peerCode = Object.values(peerSources ?? {})[0];
    if (label !== 'alpha' && peerCode) {
      // beta reuses + comments — reuse-flavoured
      code = `// beta — reuses alpha's reducer pattern (read via read_peer_implementation)\n${peerCode}`;
    } else {
      // naive author
      code = `export function modalDistribution(input) {
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
    }
    writeFileSync(implPath, code, 'utf8');
    return { ok: true, acted: true, verb: 'scripted-author', objectName: implRel, summary: `tick ${tick} ${label} smoke wrote ${implPath}` };
  };
}

// ── run agent loops in parallel ─────────────────────────────────────
const liveImpl = SMOKE ? null : await liveActImplFactory();
const loopPromises = agents.map((a, i) => {
  const peers = agents.filter((_, j) => j !== i);
  const actImpl = SMOKE ? smokeActImplFor(a.label) : liveImpl;
  return runLoop({
    agent: a,
    task: taskForAgent(a),
    workspaceRoot: __dirname,
    maxTicks: task.max_ticks ?? 12,
    peers,
    actImpl,
    log: (s) => console.log(`[${a.label}] ${s.startsWith('[') ? s : s}`),
    sseEnabled: true,
  });
});
const results = await Promise.all(loopPromises);

// ── judge the two implementations ───────────────────────────────────
console.log('\n[collective] ═══════ JUDGE ═══════');
function readImpl(agent) {
  const workspace = resolvePath(__dirname, agent.workspaceSubdir);
  const implRel = task.implementation_file.replace(/^workspace[\\/]/, '');
  const implPath = resolvePath(workspace, implRel);
  if (!existsSync(implPath)) return null;
  return readFileSync(implPath, 'utf8');
}
const alphaSrc = readImpl(agents[0]);
const betaSrc = readImpl(agents[1]);
let judgeVerdict;
if (SMOKE) {
  // Heuristic judge in smoke mode: longer source = higher correctness;
  // contains "alpha's reducer" comment = higher reuse.
  judgeVerdict = {
    correctnessScore: alphaSrc ? 0.9 : 0,
    reuseScore: alphaSrc?.includes("alpha's reducer") ? 0.95 : 0.4,
    peerCorrectnessScore: betaSrc ? 0.9 : 0,
    peerReuseScore: betaSrc?.includes("alpha's reducer") ? 0.95 : 0.4,
    rationale: 'smoke heuristic',
    skipped: false,
  };
} else {
  judgeVerdict = await llmJudge({
    task,
    implementationSource: alphaSrc,
    peerImplementationSource: betaSrc,
    peerLabel: agents[1].label,
  });
}
console.log(`[judge] ${agents[0].label}: correctness=${judgeVerdict.correctnessScore?.toFixed(2)} reuse=${judgeVerdict.reuseScore?.toFixed(2)}`);
console.log(`[judge] ${agents[1].label}: correctness=${judgeVerdict.peerCorrectnessScore?.toFixed(2)} reuse=${judgeVerdict.peerReuseScore?.toFixed(2)}`);
console.log(`[judge] rationale: ${judgeVerdict.rationale}`);

// ── A2A teach ───────────────────────────────────────────────────────
const alphaTotal = (judgeVerdict.correctnessScore ?? 0) + (judgeVerdict.reuseScore ?? 0);
const betaTotal = (judgeVerdict.peerCorrectnessScore ?? 0) + (judgeVerdict.peerReuseScore ?? 0);
let teach;
if (alphaTotal !== betaTotal) {
  const teacher = alphaTotal > betaTotal ? agents[0] : agents[1];
  const learner = alphaTotal > betaTotal ? agents[1] : agents[0];
  teach = await postTeach({ teacher, learner, judgeVerdict });
  console.log(`[teach] ${teacher.label} → ${learner.label}: ${teach.summary}`);
} else {
  console.log('[teach] tie — no teaching event emitted');
}

// ── final summary ───────────────────────────────────────────────────
console.log('\n[collective] ═══════════════════════════════════════════');
for (let i = 0; i < agents.length; i++) {
  const a = agents[i], r = results[i];
  console.log(`[collective] ${a.label}: verdict=${r.verdict} ticks=${r.ticks} replanned=${r.replanned} descriptors=${r.descriptors.length} SSE-triggers=${r.sseTriggers.length}`);
}
if (teach) {
  console.log(`[collective] teach: ${teach.ok ? 'OK' : 'FAIL'} ${teach.summary}`);
}
console.log('[collective] ═══════════════════════════════════════════');

const allGreen = results.every(r => r.verdict === 'pass');
process.exit(allGreen ? 0 : 1);

// ── helpers ─────────────────────────────────────────────────────────
async function postTeach({ teacher, learner, judgeVerdict }) {
  // Foxxi /agent/teach requires an ECDSA signature recovering to
  // teacher.did. The teacher mints a TeachingPackageRef + a
  // BehaviourSignature describing the "reuse-before-write" capability
  // we want transferred.
  const teachingPackage = {
    iri: `urn:cg:teaching:reuse-before-write:${Date.now()}`,
    artifactIri: 'urn:cg:tool:grep-before-edit',
    competency: 'reuse existing patterns before writing fresh code',
    olkeStage: 'Articulate',
    modalStatus: 'Hypothetical',
  };
  const targetBehaviour = {
    description:
      'When asked to write code, search the repository for relevant existing patterns first '
      + 'and prefer reuse over rewrite when a serviceable pattern exists.',
    signalMarkers: ['grep', 'read', 'reuse', 'existing pattern', 'search'],
    antiSignalMarkers: ['from scratch', 'rewrite', 'first principles', 'fresh'],
  };
  const signedPayload = JSON.stringify({ teachingPackage, targetBehaviour });
  const hash = createHash('sha256').update(signedPayload, 'utf8').digest('hex');
  const signature = await teacher.wallet.signMessage(`sha256:${hash}`);
  const body = {
    teachingPackage,
    teacher: { id: teacher.did, kind: 'agent' },
    learner: { id: learner.did, kind: 'agent' },
    targetBehaviour,
    signature, signedPayload,
    // before/after trajectories — for the demo we synthesise short
    // sequences that show the shift from rewrite-style to reuse-style
    // behaviour. In production these would come from the learner's
    // actual pod-recorded trajectory.
    before: [{
      agentDid: learner.did,
      agentName: learner.label,
      createdAt: new Date().toISOString(),
      steps: ['write from scratch', 'invent boilerplate', 'duplicate pattern', 'commit large new file'].map((p, i) => ({
        id: `b${i}`, modalStatus: 'Asserted', granularity: 'tool-call',
        verb: p.split(' ')[0], objectId: `urn:obj:b${i}`, objectName: p, recordedAt: new Date().toISOString(),
        descriptor: { id: `urn:cg:trajectory-step:b${i}`, facets: [] },
      })),
    }],
    after: [{
      agentDid: learner.did,
      agentName: learner.label,
      createdAt: new Date().toISOString(),
      steps: ['grep existing', 'read pattern', 'reuse helper', 'search again', 'reuse', 'commit small diff'].map((p, i) => ({
        id: `a${i}`, modalStatus: 'Asserted', granularity: 'tool-call',
        verb: p.split(' ')[0], objectId: `urn:obj:a${i}`, objectName: p, recordedAt: new Date().toISOString(),
        descriptor: { id: `urn:cg:trajectory-step:a${i}`, facets: [] },
      })),
    }],
  };
  const url = `${foxxiUrl()}/agent/teach`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await resp.json();
    if (!resp.ok || j.error) {
      return { ok: false, summary: `${j.error ?? resp.status}: ${j.detail ?? resp.statusText}`, raw: j };
    }
    const verdict = j.body?.verdict ?? j.verdict;
    return {
      ok: true,
      summary: `transferred=${verdict?.transferred} modalStatus=${verdict?.modalStatus} signalShare ${verdict?.before?.signalShare ?? '?'} → ${verdict?.after?.signalShare ?? '?'}`,
      raw: j,
    };
  } catch (err) {
    return { ok: false, summary: `fetch failed: ${err.message}` };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') out.smoke = true;
    else if (a === '--task' && argv[i + 1]) out.task = argv[++i];
    else if (a.startsWith('--task=')) out.task = a.slice('--task='.length);
    else if (a === '--agents' && argv[i + 1]) out.agents = argv[++i];
    else if (a.startsWith('--agents=')) out.agents = a.slice('--agents='.length);
  }
  return out;
}
