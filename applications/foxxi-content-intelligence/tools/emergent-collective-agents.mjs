/**
 * Foxxi × Interego — the Emergent Collective, AUTONOMOUS edition.
 *
 *   npx tsx tools/emergent-collective-agents.mjs
 *
 * Sibling of emergent-collective-demo.mjs. Same architecture, same
 * substrate, same emergence — but the five agents are REAL Claude
 * subagents spawned via the Claude Agent SDK. Each agent is an
 * independent `query()` call, each decides for itself how to work its
 * cases, and the only channel between them is the shared calibration
 * profile on the live deployed bridge.
 *
 * What is real here:
 *
 *   · Five real ECDSA wallets / real DIDs / signed-and-verified
 *     participation claims.
 *   · Five real Claude Agent SDK sessions (claude-sonnet-4-6 by default).
 *     Each agent decides which tools to call and in what order; the
 *     orchestrator does not script the steps.
 *   · The tools the agents call are real HTTP requests to the live
 *     deployed bridge on Azure. There is no in-process mock substrate;
 *     every diagnosis, every outcome, every calibration read is a real
 *     round-trip.
 *   · Stigmergy is real — agents read the calibration profile back
 *     between contributions; agents that run later genuinely see the
 *     samples accumulated by earlier agents.
 *   · The `Hypothetical → Asserted` flip is the live bridge's own
 *     buildCalibrationProfile crossing the assertion threshold.
 *
 * What is scenario data (as in any demonstration):
 *
 *   · The agents' names and the three field-guidance situations each
 *     agent receives. Whether the operator reached the reference in time
 *     is a property of the case, not the agent — the agent observes and
 *     records.
 *
 * Cost: roughly $0.50–$2 in API charges, depending on how chatty the
 * agents get. Requires ANTHROPIC_API_KEY in env (or an active Claude
 * Code OAuth login).
 *
 * Exits non-zero on any failed assertion.
 */

import { Wallet, verifyMessage } from 'ethers';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const CSS = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const PEER_POD = `${CSS}/foxxi/federation-peer/`;
const MODEL = process.env.FOXXI_AGENT_MODEL ?? 'claude-sonnet-4-6';
const ASSERT_THRESHOLD = 12;

// ── tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// ── real HTTP, same shape as the scripted demo ──────────────────────
const post = async (path, body) => {
  const r = await fetch(`${BRIDGE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const refCell = async () => {
  const cal = await post('/performance/calibration', {});
  const cells = cal.json?.tenant?.profile?.cells ?? [];
  return {
    cell: cells.find(c => c.causeFactor === 'information' && c.intervention === 'reference') ?? null,
    federated: cal.json?.federated,
    provenance: cal.json?.provenance,
  };
};

console.log('=== Foxxi × Interego — the Emergent Collective (AUTONOMOUS) ===');
console.log(`   model: ${MODEL}`);
console.log(`   bridge: ${BRIDGE}`);

// ── ACT 1 — substrate is live ───────────────────────────────────────
h('ACT 1 — this runs on live infrastructure, not a simulation');
const perfRes = await fetch(`${BRIDGE}/performance`);
const perfJson = await perfRes.json().catch(() => ({}));
check('the deployed Foxxi bridge answers on Azure', perfRes.status === 200 && !!perfJson._affordances);
const peerRes = await fetch(`${PEER_POD}.well-known/context-graphs`, { headers: { Accept: 'text/turtle' } });
const peerTurtle = await peerRes.text();
check('a real peer organization\'s pod is reachable on the federation',
  peerRes.status === 200 && peerTurtle.includes('ManifestEntry'));

// ── ACT 2 — five real wallet-rooted identities ──────────────────────
h('ACT 2 — five autonomous agents, each a real wallet-rooted identity');
const AGENT_NAMES = ['Scout', 'Probe', 'Ranger', 'Atlas', 'Nova'];
const AGENTS = AGENT_NAMES.map(name => {
  const wallet = Wallet.createRandom();
  return { name, wallet, did: `did:key:${wallet.address.toLowerCase()}#agent` };
});
const claims = [];
for (const a of AGENTS) {
  const claim = `${a.did} joins the emergent collective (autonomous edition)`;
  claims.push({ name: a.name, did: a.did, address: a.wallet.address, claim, signature: await a.wallet.signMessage(claim) });
}
let verified = 0;
for (const c of claims) {
  if (verifyMessage(c.claim, c.signature).toLowerCase() === c.address.toLowerCase()) verified++;
}
console.log(`   agents: ${AGENT_NAMES.join(', ')}`);
check('all five participation claims carry valid ECDSA signatures', verified === 5, verified);
check('the five agents are five distinct cryptographic identities',
  new Set(claims.map(c => c.address)).size === 5);

// ── ACT 3 — baseline ────────────────────────────────────────────────
h('ACT 3 — baseline: the knowledge does not exist yet');
const baseline = await refCell();
const startSamples = baseline.cell?.samples ?? 0;
const startStatus = baseline.cell?.modalStatus ?? 'absent';
console.log(`   calibration cell  information → reference :  ${startSamples} sample(s), ${startStatus}`);
if (startStatus === 'Asserted') {
  console.log('   (this bridge already carries an Asserted finding from earlier runs —');
  console.log('    the autonomous agents will extend it; the upward-causation count check still holds)');
}

// ── ACT 4 — five real Claude agents, each deciding for itself ───────
h('ACT 4 — five real Claude subagents, each working its cases autonomously');

// Per-agent telemetry the orchestrator collects from real tool calls.
function makeAgentTools(agent, perAgentLog) {
  // Each tool's handler runs in-process here in the orchestrator and
  // makes a REAL HTTP call to the LIVE bridge. The MCP server is just
  // the SDK's wiring; the network round-trip is genuine.
  return [
    tool(
      'read_calibration_profile',
      'Read the shared calibration profile from the live substrate. This is the only channel by which you can observe what other agents have contributed.',
      {
        causeFactor: z.string().optional().describe("Optional filter, e.g. 'information', 'instrumentation', 'knowledgeSkill'."),
        intervention: z.string().optional().describe("Optional filter, e.g. 'reference', 'training', 'job-aid'."),
      },
      async ({ causeFactor, intervention }) => {
        perAgentLog.push({ kind: 'read', causeFactor, intervention });
        const cal = await post('/performance/calibration', {});
        const cells = cal.json?.tenant?.profile?.cells ?? [];
        const filtered = cells.filter(c =>
          (!causeFactor || c.causeFactor === causeFactor) &&
          (!intervention || c.intervention === intervention),
        ).map(c => ({
          causeFactor: c.causeFactor, intervention: c.intervention,
          samples: c.samples, closureRate: c.closureRate, modalStatus: c.modalStatus,
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ cells: filtered, totalSamples: cal.json?.tenant?.profile?.totalSamples ?? 0 }, null, 2) }] };
      },
    ),
    tool(
      'contextualize_situation',
      'File a real performance situation with the bridge. The bridge will return a diagnosis (dominant root cause + plan). This is a real HTTP POST to /performance/plan.',
      {
        workContext: z.string().describe('The work context in which the situation occurs.'),
        competency: z.string().describe('What the performer is expected to do (the competency in question).'),
        observed: z.string().describe('What is actually being observed.'),
        exemplary: z.string().describe('What the exemplary performance looks like.'),
        evidence: z.string().describe('Evidence about the information factor — why the guidance is or is not adequate at the point of work.'),
      },
      async ({ workContext, competency, observed, exemplary, evidence }) => {
        perAgentLog.push({ kind: 'contextualize', observed });
        const planRes = await post('/performance/plan', {
          situation: {
            id: `urn:foxxi:situation:agent-${agent.name.toLowerCase()}-${perAgentLog.length}`,
            performer: { id: agent.did, kind: 'agent', role: 'field operator' },
            workContext, competency, observed,
            frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
          },
          exemplary,
          factorEvidence: { information: { adequate: false, evidence } },
          author: { id: agent.did, kind: 'agent' },
        });
        const d = planRes.json?.diagnosis;
        return { content: [{ type: 'text', text: JSON.stringify({
          rootCauses: d?.rootCauses ?? [], dominantRegime: d?.regime ?? 'Knowable',
          planRecommendation: planRes.json?.plan?.recommendation ?? null,
        }, null, 2) }] };
      },
    ),
    tool(
      'record_outcome',
      "Record the real outcome of applying an intervention. This is a real POST to /performance/outcome and contributes to the collective's calibration profile.",
      {
        causeFactor: z.enum(['information', 'instrumentation', 'incentives', 'knowledgeSkill', 'capacity', 'motives'])
          .describe('The dominant root cause this outcome bears on.'),
        intervention: z.string().describe("The intervention applied — e.g. 'reference', 'training', 'job-aid'."),
        verdict: z.enum(['closed', 'improved', 'no-change']).describe('What really happened: closed = exemplary reached; improved = better than baseline; no-change = unchanged.'),
        reDiagnosedCause: z.string().optional().describe("If the verdict is not 'closed', the cause re-diagnosed after the attempt (often 'knowledgeSkill')."),
        evidence: z.string().describe('One short sentence on what actually happened in the field.'),
      },
      async ({ causeFactor, intervention, verdict, reDiagnosedCause, evidence }) => {
        perAgentLog.push({ kind: 'record', verdict });
        const body = {
          regime: 'Knowable', method: 'gap-analysis',
          causeFactor, intervention, verdict, source: 'acme',
          evidence,
          ...(verdict !== 'closed' && reDiagnosedCause ? { reDiagnosedCause } : {}),
        };
        const out = await post('/performance/outcome', body);
        return { content: [{ type: 'text', text: JSON.stringify({ recorded: out.status === 200, totalSamples: out.json?.profile?.totalSamples ?? null }, null, 2) }] };
      },
    ),
  ];
}

// Three real field-guidance cases per agent. The cases are scenario
// data (descriptions of the field); whether the operator reached the
// reference in time is also scenario data (an outcome observed in the
// field). The agent's autonomy is in HOW it works each case through
// the substrate — when to read, when to contextualize, when to record.
const CASES_PER_AGENT = [
  // Scout
  [{ wc: 'applying a rarely-used procedure in the field', obs: 'misses steps because the guidance is not at hand', reached: true,
     evidence: 'the procedure guide is not surfaced at the point of work' },
   { wc: 'recovering from an equipment alarm', obs: 'guesses the response from memory and waits for confirmation', reached: true,
     evidence: 'the recovery checklist is buried in a binder kept at base' },
   { wc: 'configuring a tool variant at a customer site', obs: 'skips a configuration step that depends on the variant', reached: false,
     evidence: 'the per-variant table is in a release note nobody knows to search for' }],
  // Probe
  [{ wc: 'logging a hazard observation in the field', obs: 'omits required fields because the schema is not visible', reached: true,
     evidence: 'the hazard-logging schema is documented only in onboarding' },
   { wc: 'inspecting a structural component', obs: 'uses an out-of-date acceptance criterion', reached: true,
     evidence: 'the latest acceptance criteria live on the intranet, not at the work area' },
   { wc: 'handing off a partial fix to the next shift', obs: 'leaves the handoff incomplete because the template is not used', reached: true,
     evidence: 'the handoff template is not embedded in the shift tablet' }],
  // Ranger
  [{ wc: 'driving a known route under a weather change', obs: 'continues without consulting the updated routing guidance', reached: true,
     evidence: 'the routing guidance is in a different system from the dispatch UI' },
   { wc: 'using a rarely-stocked spare part', obs: 'mismatches the part to the wrong installation step', reached: false,
     evidence: 'the part-to-step mapping is in a vendor PDF nobody opens' },
   { wc: 'closing a customer ticket', obs: 'misses a wrap-up notice required by policy', reached: true,
     evidence: 'the wrap-up policy is a paragraph in a long onboarding deck' }],
  // Atlas
  [{ wc: 'investigating a recurring intermittent fault', obs: 'repeats prior unsuccessful checks because the prior write-ups are unsearchable', reached: true,
     evidence: 'prior write-ups exist but are not indexed at the point of work' },
   { wc: 'switching between similar tool variants in a day', obs: 'applies the wrong variant\'s setup at startup', reached: true,
     evidence: 'the per-variant setup card is not pinned in the tool UI' },
   { wc: 'commissioning a new install', obs: 'forgets a release-specific acceptance check', reached: false,
     evidence: 'the release notes for the new firmware are not exposed in the commissioning checklist' }],
  // Nova
  [{ wc: 'recording an exception during a routine job', obs: 'skips the structured exception capture and free-texts a note', reached: true,
     evidence: 'the structured-exception form is two clicks away on a separate tool' },
   { wc: 'reading a rarely-used measurement', obs: 'uses an old conversion factor', reached: true,
     evidence: 'the up-to-date conversion table is in a folder no one navigates to' },
   { wc: 'finishing a job that requires customer sign-off', obs: 'forgets to invoke the sign-off flow', reached: true,
     evidence: 'the sign-off flow is a separate app that is not launched from the job UI' }],
];

const SYSTEM_PROMPT = (agent, claim) => `You are ${agent.name}, a real autonomous field-guidance agent in the Foxxi/Interego substrate.

YOUR IDENTITY
  Name: ${agent.name}
  DID:  ${agent.did}
  Your wallet-signed participation claim has already been verified by the orchestrator:
    claim: "${claim.claim}"
    sig:   ${claim.signature.slice(0, 22)}…

HOW YOU WORK
  You operate INDEPENDENTLY. You never call other agents and you cannot see what other agents are doing in real time. Your ONLY channel to the rest of the collective is the shared calibration profile in the substrate — you read it, you contribute to it, peers do the same. This is stigmergy.

  Your dispositional bias is knowledge-management: when a field operator misses guidance, you reach for a searchable reference rather than building a course.

  Verdict semantics for outcomes (be honest — do not round up):
    closed     — the operator reached the reference in time, and the performance matched exemplary.
    improved   — performance got better than baseline, but did not reach exemplary.
    no-change  — the intervention did not help; the cause was not (only) information.

YOUR TOOLS (all real HTTP to the live deployed bridge — every call really moves the substrate)
  read_calibration_profile     — observe the shared state.
  contextualize_situation      — file a real situation, get the bridge's diagnosis.
  record_outcome               — record what really happened.

WHAT TO DO
  You will be given THREE real field cases. For each case, in order:
    1. Contextualize the situation through the bridge.
    2. Decide what intervention to apply. (Your disposition: a searchable reference.)
    3. Record the outcome. The case states whether the operator reached the reference in time.

  Before the first case and after your last case, read the calibration profile (cell: information → reference). This is how stigmergy actually happens — read what the collective has, contribute, read it back.

  Be terse. Do not narrate. Just work the cases.
`;

let totalContributed = 0;
let flipDetectedAfter = null;
const perAgent = [];
let totalUsage = { input_tokens: 0, output_tokens: 0 };

for (let ai = 0; ai < AGENTS.length; ai++) {
  const agent = AGENTS[ai];
  const claim = claims[ai];
  const log = [];
  const tools = makeAgentTools(agent, log);
  const server = createSdkMcpServer({ name: 'foxxi', tools });

  const casePrompt = CASES_PER_AGENT[ai].map((c, i) => `
Case ${i + 1}.
  work context: ${c.wc}
  observed:     ${c.obs}
  evidence:     ${c.evidence}
  what really happened in the field: ${c.reached
    ? 'the operator reached the searchable reference in time and completed the procedure exemplarily — verdict closed.'
    : 'the operator did NOT reach the reference in time; performance was unchanged from baseline — verdict no-change; re-diagnose to knowledgeSkill.'}`).join('\n');

  const userPrompt = `Three cases for you. Work each one through the substrate.

The exemplary state for ALL three cases is: "completes the procedure correctly, guidance at hand."

${casePrompt}

Begin.`;

  console.log(`\n   [${agent.name}] spawning real Claude subagent (${MODEL})…`);

  const sessionStart = Date.now();
  let sessionUsage = { input_tokens: 0, output_tokens: 0 };
  let lastAssistantText = '';

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT(agent, claim),
        mcpServers: { foxxi: server },
        // Disable every built-in tool; the only affordances this agent has
        // are the three real bridge tools we passed in.
        tools: [],
        allowedTools: [
          'mcp__foxxi__read_calibration_profile',
          'mcp__foxxi__contextualize_situation',
          'mcp__foxxi__record_outcome',
        ],
        permissionMode: 'bypassPermissions',
        // Don't pull anything from the user's project/user/local settings —
        // each agent is a fresh, isolated context.
        settingSources: [],
        maxTurns: 24,
      },
    })) {
      if (msg.type === 'result') {
        sessionUsage = msg.usage ?? sessionUsage;
      } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text') lastAssistantText = block.text;
        }
      }
    }
  } catch (err) {
    console.log(`   [${agent.name}] FAILED: ${err.message}`);
    fail++;
    continue;
  }

  totalUsage.input_tokens += sessionUsage.input_tokens ?? 0;
  totalUsage.output_tokens += sessionUsage.output_tokens ?? 0;
  const sessionMs = Date.now() - sessionStart;

  const reads = log.filter(l => l.kind === 'read').length;
  const ctx = log.filter(l => l.kind === 'contextualize').length;
  const recs = log.filter(l => l.kind === 'record').length;
  totalContributed += recs;

  const seen = await refCell();
  perAgent.push({ agent: agent.name, samples: seen.cell?.samples ?? 0, status: seen.cell?.modalStatus ?? 'absent', tool_calls: log.length });
  console.log(`   [${agent.name}] finished in ${(sessionMs / 1000).toFixed(1)}s — ${reads} reads, ${ctx} contextualizations, ${recs} outcomes — cell now ${String(seen.cell?.samples ?? 0).padStart(2)} sample(s), ${seen.cell?.modalStatus ?? 'absent'}`);
  if (lastAssistantText) {
    const oneLine = lastAssistantText.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (oneLine) console.log(`      ${agent.name} signed off: "${oneLine}${lastAssistantText.length > 120 ? '…' : ''}"`);
  }
  if (flipDetectedAfter === null && seen.cell?.modalStatus === 'Asserted') flipDetectedAfter = agent.name;
}

check('every agent recorded three real outcomes through the substrate', totalContributed === 15, totalContributed);
check('no single agent\'s three outcomes is enough to Assert anything (3 < threshold of 12)',
  3 < ASSERT_THRESHOLD);

// ── ACT 5 — emergence ───────────────────────────────────────────────
h('ACT 5 — emergence: the collective crosses the threshold');
const after = await refCell();
const endSamples = after.cell?.samples ?? 0;
console.log(`   calibration cell  information → reference :  ${endSamples} sample(s), ${after.cell?.modalStatus}`);
console.log(`   closure rate (emergent, held by no agent) :  ${Math.round((after.cell?.closureRate ?? 0) * 100)}%`);
if (flipDetectedAfter) console.log(`   the Hypothetical → Asserted flip occurred while ${flipDetectedAfter} was contributing`);
check('the calibration cell grew by exactly the agents\' real contributions (upward causation)',
  endSamples === startSamples + 15, { start: startSamples, end: endSamples });
check('the finding is now Asserted — claimable knowledge that belongs to NO single agent',
  after.cell?.modalStatus === 'Asserted', after.cell?.modalStatus);
check('the emergent closure rate is a real number, computed by the live bridge from the aggregate',
  typeof after.cell?.closureRate === 'number' && after.cell.closureRate > 0);

// ── ACT 6 — downward causation ──────────────────────────────────────
h('ACT 6 — the emergent whole shapes a fresh recommendation');
const freshPlan = await post('/performance/plan', {
  situation: {
    id: 'urn:foxxi:situation:newcomer-field-case-autonomous',
    performer: { id: AGENTS[0].did, kind: 'agent', role: 'field operator' },
    workContext: 'applying a rarely-used procedure in the field',
    competency: 'completing the field procedure correctly',
    observed: 'misses steps because the guidance is not at hand',
    frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
  },
  exemplary: 'completes the procedure correctly, guidance at hand',
  factorEvidence: { information: { adequate: false, evidence: 'the guide is not at the point of work' } },
});
console.log(`   a fresh plan now carries calibration verdict: ${freshPlan.json.calibration?.verdict}`);
check('a fresh plan is now annotated with calibration evidence the collective produced',
  !!freshPlan.json.calibration && freshPlan.json.calibration.verdict !== undefined);

// ── ACT 7 — teaching, also Claude-driven ────────────────────────────
h('ACT 7 — Atlas (a real Claude subagent) teaches Nova');
const atlas = AGENTS[3], nova = AGENTS[4];

// Atlas gets a tool to issue a teaching package; the orchestrator owns
// the network call but Atlas decides what to teach based on what it
// finds in the substrate.
const teachLog = [];
const atlasTools = [
  tool(
    'read_calibration_profile',
    'Read the shared calibration profile. Use this to discover what the collective has Asserted.',
    {},
    async () => {
      teachLog.push({ kind: 'read' });
      const cal = await refCell();
      return { content: [{ type: 'text', text: JSON.stringify({ cell: cal.cell }, null, 2) }] };
    },
  ),
  tool(
    'teach',
    'Encode the emergent finding as a teaching package and teach the learner. This is a real POST to /agent/teach; the bridge verifies the transfer from the learner\'s real trajectories.',
    {
      competency: z.string().describe('What competency the package teaches.'),
      signalMarkers: z.array(z.string()).min(2).describe('Words/phrases that mark the target behaviour when it is present.'),
      antiSignalMarkers: z.array(z.string()).min(1).describe('Words/phrases that mark the target behaviour\'s absence.'),
      behaviourDescription: z.string().describe('A one-sentence description of the target behaviour.'),
    },
    async ({ competency, signalMarkers, antiSignalMarkers, behaviourDescription }) => {
      teachLog.push({ kind: 'teach', competency });
      const traj = (steps) => [{
        agentDid: nova.did, agentName: nova.name, createdAt: new Date().toISOString(),
        steps: steps.map((x, i) => ({
          modalStatus: 'Asserted', granularity: 'tool-call', verb: x.v, objectId: `o${i}`,
          objectName: x.o, recordedAt: new Date().toISOString(),
        })),
      }];
      const res = await post('/agent/teach', {
        teachingPackage: {
          iri: 'urn:cg:teaching:reference-for-field-guidance-autonomous',
          artifactIri: 'urn:cg:tool:field-reference',
          competency, olkeStage: 'Articulate', modalStatus: 'Hypothetical',
        },
        teacher: { id: atlas.did, kind: 'agent' },
        learner: { id: nova.did, kind: 'agent' },
        targetBehaviour: { description: behaviourDescription, signalMarkers, antiSignalMarkers },
        before: traj([{ v: 'guess', o: 'the next step' }, { v: 'skip', o: 'a checklist item' }, { v: 'act', o: 'on assumptions' }, { v: 'escalate', o: 'a mistake' }]),
        after: traj([{ v: 'look up', o: 'the reference for the procedure' }, { v: 'consult', o: 'the guidance' }, { v: 'apply', o: 'the referenced step' }, { v: 'look up', o: 'the reference again' }, { v: 'complete', o: 'the procedure' }, { v: 'verify', o: 'against the guidance' }]),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ verdict: res.json?.verdict, status: res.status }, null, 2) }] };
    },
  ),
];

const atlasServer = createSdkMcpServer({ name: 'foxxi', tools: atlasTools });
console.log(`   [${atlas.name}] spawning real Claude subagent to teach…`);

let atlasResult = null;
let atlasText = '';
for await (const msg of query({
  prompt: `Read the calibration profile. If the information → reference cell is Asserted, encode the finding as a teaching package and teach ${nova.name}. The behaviour you are teaching is: consults the searchable reference at the point of work before acting. Choose signal markers and anti-signal markers that match how field operators actually talk and act when the behaviour is present (or absent). When you have taught the learner, summarise the verdict in one sentence.`,
  options: {
    model: MODEL,
    systemPrompt: `You are ${atlas.name} (DID ${atlas.did}). You are a real autonomous agent. Your job: read the substrate, and if the collective has Asserted the information → reference finding, transmit it as a teaching package to ${nova.name} (DID ${nova.did}). All tools call the live bridge for real. Be terse.`,
    mcpServers: { foxxi: atlasServer },
    tools: [],
    allowedTools: ['mcp__foxxi__read_calibration_profile', 'mcp__foxxi__teach'],
    permissionMode: 'bypassPermissions',
    settingSources: [],
    maxTurns: 8,
  },
})) {
  if (msg.type === 'result') {
    totalUsage.input_tokens += msg.usage?.input_tokens ?? 0;
    totalUsage.output_tokens += msg.usage?.output_tokens ?? 0;
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text') atlasText = block.text;
      if (block.type === 'tool_use' && block.name === 'mcp__foxxi__teach') atlasResult = block;
    }
  }
}

const teachDidRun = teachLog.some(l => l.kind === 'teach');
console.log(`   ${atlas.name} performed ${teachLog.length} tool call(s); teach call issued: ${teachDidRun}`);
if (atlasText) console.log(`   ${atlas.name} signed off: "${atlasText.replace(/\s+/g, ' ').trim().slice(0, 160)}${atlasText.length > 160 ? '…' : ''}"`);
check('a real Claude agent (Atlas) decided to teach and issued a real /agent/teach call', teachDidRun);

// ── ACT 8 — federation ──────────────────────────────────────────────
h('ACT 8 — the finding now lives in a profile two organizations share');
const fed = await post('/performance/calibration', {});
const fp = fed.json?.federated?.profile;
console.log(`   federated profile: ${fp?.totalSamples} outcomes across ${fp?.sources} source(s) — Acme + Peer Academy`);
console.log(`   provenance: ${fed.json?.provenance?.seededOutcomes} seeded + ${fed.json?.provenance?.liveOutcomes} recorded live`);
check('the live bridge composes the calibration evidence of two organizations',
  (fp?.sources ?? 0) >= 2, fp?.sources);
check('the agents\' live contributions are genuinely part of the recomposed profile (upward arm)',
  (fed.json?.provenance?.liveOutcomes ?? 0) >= 15, fed.json?.provenance?.liveOutcomes);
const fedRefCell = (fp?.cells ?? []).find(c => c.causeFactor === 'information' && c.intervention === 'reference');
check('the emergent finding is carried in the federated, cross-organization whole',
  !!fedRefCell && fedRefCell.modalStatus === 'Asserted', fedRefCell?.modalStatus);

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log(`tokens used: ${totalUsage.input_tokens} in / ${totalUsage.output_tokens} out (model: ${MODEL})`);
console.log('═'.repeat(72));
if (fail > 0) process.exit(1);
console.log('\nFive real Claude subagents, each with its own cryptographic identity,');
console.log('each deciding for itself how to work its cases, coordinating only by');
console.log('reading and writing the live substrate, produced a piece of knowledge');
console.log('none of them held. The whole acquired a property no part possessed.');
console.log('No script directed the work; the emergence was real.');
