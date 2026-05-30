/**
 * Foxxi × Interego — the Emergent Collective, LIVE LOCAL DASHBOARD.
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-live.mjs
 *   → open http://127.0.0.1:8765/
 *
 * A small local HTTP server that serves a self-contained dashboard at
 * localhost:8765/. When you click "Run it live" in the browser, the
 * server spawns five real Claude subagents (Claude Agent SDK), streams
 * every event back over Server-Sent Events, and renders the same
 * progressive flip narrative the microsite shows for the scripted
 * edition — except the agents are really autonomous and the work is
 * really decided by Claude.
 *
 * Authentication: your active Claude Code login (the same OAuth session
 * the `claude` CLI is using). No ANTHROPIC_API_KEY needed; nothing is
 * sent to Anthropic from the browser. The SDK runs server-side, here,
 * in this Node process.
 *
 * Same architecture as tools/emergent-collective-agents.mjs — same five
 * MCP tools, same real HTTP to the live deployed bridge on Azure. The
 * only difference is that events are emitted to a browser instead of to
 * stdout.
 */

import { createServer } from 'http';
import { Wallet, verifyMessage } from 'ethers';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const PORT = Number(process.env.FOXXI_LIVE_PORT ?? 8765);
const HOST = '127.0.0.1';
const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const CSS = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const PEER_POD = `${CSS}/foxxi/federation-peer/`;
const MODEL = process.env.FOXXI_AGENT_MODEL ?? 'claude-sonnet-4-6';
const ASSERT_THRESHOLD = 12;
const AGENT_NAMES = ['Scout', 'Probe', 'Ranger', 'Atlas', 'Nova'];

// ── HTTP helpers (real round-trip to the live bridge) ───────────────
const post = async (path, body) => {
  const r = await fetch(`${BRIDGE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/ld+json, application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
/** Fetch a descriptor (or any pod resource) as text/turtle for display. */
const getTurtle = async (url) => {
  try {
    const r = await fetch(url, { headers: { 'Accept': 'text/turtle' } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
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

// ── per-agent cases (same as the CLI sibling) ───────────────────────
const CASES_PER_AGENT = [
  [{ wc: 'applying a rarely-used procedure in the field', obs: 'misses steps because the guidance is not at hand', reached: true,
     evidence: 'the procedure guide is not surfaced at the point of work' },
   { wc: 'recovering from an equipment alarm', obs: 'guesses the response from memory and waits for confirmation', reached: true,
     evidence: 'the recovery checklist is buried in a binder kept at base' },
   { wc: 'configuring a tool variant at a customer site', obs: 'skips a configuration step that depends on the variant', reached: false,
     evidence: 'the per-variant table is in a release note nobody knows to search for' }],
  [{ wc: 'logging a hazard observation in the field', obs: 'omits required fields because the schema is not visible', reached: true,
     evidence: 'the hazard-logging schema is documented only in onboarding' },
   { wc: 'inspecting a structural component', obs: 'uses an out-of-date acceptance criterion', reached: true,
     evidence: 'the latest acceptance criteria live on the intranet, not at the work area' },
   { wc: 'handing off a partial fix to the next shift', obs: 'leaves the handoff incomplete because the template is not used', reached: true,
     evidence: 'the handoff template is not embedded in the shift tablet' }],
  [{ wc: 'driving a known route under a weather change', obs: 'continues without consulting the updated routing guidance', reached: true,
     evidence: 'the routing guidance is in a different system from the dispatch UI' },
   { wc: 'using a rarely-stocked spare part', obs: 'mismatches the part to the wrong installation step', reached: false,
     evidence: 'the part-to-step mapping is in a vendor PDF nobody opens' },
   { wc: 'closing a customer ticket', obs: 'misses a wrap-up notice required by policy', reached: true,
     evidence: 'the wrap-up policy is a paragraph in a long onboarding deck' }],
  [{ wc: 'investigating a recurring intermittent fault', obs: 'repeats prior unsuccessful checks because the prior write-ups are unsearchable', reached: true,
     evidence: 'prior write-ups exist but are not indexed at the point of work' },
   { wc: 'switching between similar tool variants in a day', obs: 'applies the wrong variant\'s setup at startup', reached: true,
     evidence: 'the per-variant setup card is not pinned in the tool UI' },
   { wc: 'commissioning a new install', obs: 'forgets a release-specific acceptance check', reached: false,
     evidence: 'the release notes for the new firmware are not exposed in the commissioning checklist' }],
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

  Before the first case and after your last case, read the calibration profile (cell: information → reference). This is how stigmergy actually happens.

  Be terse. Do not narrate. Just work the cases.
`;

// ── the autonomous run, emitting structured events ──────────────────
let runInProgress = false;

async function runAutonomousCollective({ emit, cancelled }) {
  const log = (kind, payload = {}) => { if (!cancelled.value) emit({ kind, ...payload }); };

  log('act', { act: 1, name: 'this runs on live infrastructure, not a simulation' });
  const perfRes = await fetch(`${BRIDGE}/performance`).catch(() => null);
  const perfOk = perfRes && perfRes.status === 200;
  log('substrate', { bridgeOk: !!perfOk });
  const peerRes = await fetch(`${PEER_POD}.well-known/context-graphs`, { headers: { Accept: 'text/turtle' } }).catch(() => null);
  const peerText = peerRes ? await peerRes.text() : '';
  const peerOk = peerRes && peerRes.status === 200 && peerText.includes('ManifestEntry');
  log('substrate', { peerOk: !!peerOk });

  log('act', { act: 2, name: 'five autonomous agents, each a real wallet-rooted identity' });
  const AGENTS = AGENT_NAMES.map(name => {
    const wallet = Wallet.createRandom();
    return { name, wallet, did: `did:key:${wallet.address.toLowerCase()}#agent`, address: wallet.address };
  });
  const claims = [];
  for (const a of AGENTS) {
    const claim = `${a.did} joins the emergent collective (live local dashboard)`;
    const signature = await a.wallet.signMessage(claim);
    claims.push({ name: a.name, did: a.did, address: a.address, claim, signature });
    log('agent-signed', { name: a.name, did: a.did, address: a.address, signature: signature.slice(0, 22) + '…' });
  }
  let verified = 0;
  for (const c of claims) {
    if (verifyMessage(c.claim, c.signature).toLowerCase() === c.address.toLowerCase()) verified++;
  }
  log('check', { label: 'all five participation claims carry valid ECDSA signatures', ok: verified === 5 });
  log('check', { label: 'five distinct cryptographic identities', ok: new Set(claims.map(c => c.address)).size === 5 });

  log('act', { act: 3, name: 'baseline — knowledge does not exist yet' });
  const baseline = await refCell();
  const startSamples = baseline.cell?.samples ?? 0;
  log('cell', { samples: startSamples, closureRate: baseline.cell?.closureRate ?? 0, modalStatus: baseline.cell?.modalStatus ?? 'absent', initial: true });

  log('act', { act: 4, name: 'five real Claude subagents working asynchronously; coordinating only through the substrate' });
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const sumUsage = (u) => {
    if (!u) return;
    totalUsage.input_tokens += u.input_tokens ?? 0;
    totalUsage.output_tokens += u.output_tokens ?? 0;
    totalUsage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    totalUsage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  };
  let flipDetectedAfter = null;
  let nextArtifactId = 1;
  const artifactId = () => `art-${nextArtifactId++}`;
  const baselineModal = baseline.cell?.modalStatus ?? 'absent';

  // Refresh the shared cell from the substrate and broadcast it. Called
  // after every write so the dashboard sees the climb regardless of which
  // agent triggered it.
  async function refreshCell(triggeredBy) {
    const seen = await refCell();
    const cellState = {
      samples: seen.cell?.samples ?? 0,
      closureRate: seen.cell?.closureRate ?? 0,
      modalStatus: seen.cell?.modalStatus ?? 'absent',
    };
    log('cell', cellState);
    if (flipDetectedAfter === null && cellState.modalStatus === 'Asserted' && baselineModal !== 'Asserted') {
      flipDetectedAfter = triggeredBy;
      log('flip', { during: triggeredBy });
    }
    return cellState;
  }

  // Build the per-agent runner. Each call is an independent async function
  // that owns its own tool handlers (closed over its agent identity and an
  // artifact-emission helper). They all run via Promise.all so the agents
  // really race the substrate — exactly what autonomous agents do in the
  // wild. Stigmergy still works: whoever reads the profile sees whatever
  // has landed by then.
  async function runAgent(agent, claim, cases) {
    const perAgentLog = [];

    const emitArtifact = (type, title, payload) => {
      log('artifact', { id: artifactId(), type, producer: agent.name, title, payload });
    };

    // The bridge's new linked-data responses carry a `published[]` array
    // — one entry per real cg:ContextDescriptor (signed, content-addressed
    // via a pgsl:Atom, dereferenceable on the pod). For each one, we fetch
    // the descriptor's Turtle representation and emit it as its OWN
    // artifact (kind: 'descriptor'). The artifact's payload carries the
    // Turtle text, the descriptor IRI, the pod URLs, and the affordance
    // index from the response — so the user can browse the same linked
    // data shape the agent operated on.
    const emitPublishedDescriptors = async (response) => {
      const published = response?.published;
      const affordances = response?._affordances ?? null;
      if (!Array.isArray(published) || published.length === 0) return;
      for (const p of published) {
        const url = p?.['hydra:resourceUrl'];
        const turtle = url ? await getTurtle(url) : null;
        const graphTurtle = p?.['foxxi:graphUrl'] ? await getTurtle(p['foxxi:graphUrl']) : null;
        const typeTags = Array.isArray(p?.['@type']) ? p['@type'] : (p?.['@type'] ? [p['@type']] : []);
        const foxxiType = typeTags.find(t => /foxxi|ac:|amta:/.test(String(t))) ?? typeTags[1] ?? 'unknown';
        log('artifact', {
          id: artifactId(),
          type: 'descriptor',
          producer: agent.name,
          title: `${foxxiType.split(/[#/:]/).pop()} · ${p?.['@id'] ?? '(no iri)'}`,
          payload: {
            'descriptor-iri': p?.['@id'],
            'foxxi-type': foxxiType,
            'cg:types': typeTags,
            'pgsl:atom': p?.['pgsl:hasAtom'],
            'cg:describes': p?.['cg:describes'],
            'pod:descriptorUrl': url,
            'pod:graphUrl': p?.['foxxi:graphUrl'],
            'turtle': turtle ?? '(could not fetch descriptor; pod may have ACL)',
            'graph-turtle': graphTurtle,
            '_affordances': affordances,
          },
        });
      }
    };

    const tools = [
      tool(
        'read_calibration_profile',
        'Read the shared calibration profile from the live substrate. This is the only channel by which you can observe what other agents have contributed.',
        { causeFactor: z.string().optional(), intervention: z.string().optional() },
        async ({ causeFactor, intervention }) => {
          log('agent-tool', { name: agent.name, tool: 'read_calibration_profile' });
          perAgentLog.push({ kind: 'read' });
          const cal = await post('/performance/calibration', {});
          const cells = cal.json?.tenant?.profile?.cells ?? [];
          const filtered = cells.filter(c =>
            (!causeFactor || c.causeFactor === causeFactor) &&
            (!intervention || c.intervention === intervention),
          ).map(c => ({ causeFactor: c.causeFactor, intervention: c.intervention, samples: c.samples, closureRate: c.closureRate, modalStatus: c.modalStatus }));
          const targetCell = cells.find(c => c.causeFactor === 'information' && c.intervention === 'reference');
          emitArtifact('calibration-read',
            `read · information→reference · ${targetCell?.samples ?? 0} samples, ${targetCell?.modalStatus ?? 'absent'}`,
            { request: { causeFactor: causeFactor ?? null, intervention: intervention ?? null },
              response: { cells: filtered, totalSamples: cal.json?.tenant?.profile?.totalSamples ?? 0,
                targetCell: targetCell ?? null } });
          return { content: [{ type: 'text', text: JSON.stringify({ cells: filtered, totalSamples: cal.json?.tenant?.profile?.totalSamples ?? 0 }, null, 2) }] };
        },
      ),
      tool(
        'contextualize_situation',
        'File a real performance situation with the bridge. The bridge will return a diagnosis. Real POST to /performance/plan.',
        {
          workContext: z.string(),
          competency: z.string(),
          observed: z.string(),
          exemplary: z.string(),
          evidence: z.string(),
        },
        async ({ workContext, competency, observed, exemplary, evidence }) => {
          log('agent-tool', { name: agent.name, tool: 'contextualize_situation', detail: observed });
          perAgentLog.push({ kind: 'contextualize' });
          const situationId = `urn:foxxi:situation:agent-${agent.name.toLowerCase()}-${perAgentLog.length}`;
          const requestBody = {
            situation: {
              id: situationId,
              performer: { id: agent.did, kind: 'agent', role: 'field operator' },
              workContext, competency, observed,
              frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
            },
            exemplary,
            factorEvidence: { information: { adequate: false, evidence } },
            author: { id: agent.did, kind: 'agent' },
          };
          const planRes = await post('/performance/plan', requestBody);
          const d = planRes.json?.diagnosis;
          emitArtifact('situation',
            `${situationId.split(':').pop()} — ${observed.slice(0, 60)}${observed.length > 60 ? '…' : ''}`,
            { request: requestBody,
              response: {
                diagnosis: d ?? null,
                plan: planRes.json?.plan ?? null,
                status: planRes.status,
              } });
          // Emit the real cg:ContextDescriptor artifact(s) the bridge just
          // minted on the pod for this situation — fetched as Turtle.
          await emitPublishedDescriptors(planRes.json);
          return { content: [{ type: 'text', text: JSON.stringify({ rootCauses: d?.rootCauses ?? [], dominantRegime: d?.regime ?? 'Knowable', planRecommendation: planRes.json?.plan?.recommendation ?? null }, null, 2) }] };
        },
      ),
      tool(
        'record_outcome',
        "Record the real outcome. Real POST to /performance/outcome — contributes to the collective's calibration profile.",
        {
          causeFactor: z.enum(['information', 'instrumentation', 'incentives', 'knowledgeSkill', 'capacity', 'motives']),
          intervention: z.string(),
          verdict: z.enum(['closed', 'improved', 'no-change']),
          reDiagnosedCause: z.string().optional(),
          evidence: z.string(),
        },
        async ({ causeFactor, intervention, verdict, reDiagnosedCause, evidence }) => {
          log('agent-tool', { name: agent.name, tool: 'record_outcome', detail: verdict });
          perAgentLog.push({ kind: 'record' });
          const requestBody = {
            regime: 'Knowable', method: 'gap-analysis',
            causeFactor, intervention, verdict, source: 'acme', evidence,
            ...(verdict !== 'closed' && reDiagnosedCause ? { reDiagnosedCause } : {}),
          };
          const out = await post('/performance/outcome', requestBody);
          emitArtifact('outcome',
            `${causeFactor}→${intervention} · verdict ${verdict}`,
            { request: requestBody,
              response: { recorded: out.json?.recorded ?? (out.status === 200), totalSamples: out.json?.totalSamples ?? null, status: out.status } });
          // Emit the real cg:ContextDescriptor for this outcome — the
          // pod-resident, dereferenceable, content-addressed work product
          // the bridge just minted.
          await emitPublishedDescriptors(out.json);
          // The write moved the substrate — refresh the broadcast cell.
          await refreshCell(agent.name);
          return { content: [{ type: 'text', text: JSON.stringify({ recorded: out.json?.recorded ?? (out.status === 200), totalSamples: out.json?.totalSamples ?? null }, null, 2) }] };
        },
      ),
    ];

    const mcpServer = createSdkMcpServer({ name: 'foxxi', tools });
    const casePrompt = cases.map((c, i) => `
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

    log('agent-start', { name: agent.name, did: agent.did, model: MODEL });
    const sessionStart = Date.now();
    let lastText = '';
    try {
      for await (const msg of query({
        prompt: userPrompt,
        options: {
          model: MODEL,
          systemPrompt: SYSTEM_PROMPT(agent, claim),
          mcpServers: { foxxi: mcpServer },
          tools: [],
          allowedTools: [
            'mcp__foxxi__read_calibration_profile',
            'mcp__foxxi__contextualize_situation',
            'mcp__foxxi__record_outcome',
          ],
          permissionMode: 'bypassPermissions',
          settingSources: [],
          maxTurns: 24,
        },
      })) {
        if (cancelled.value) break;
        if (msg.type === 'result') sumUsage(msg.usage);
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'text') lastText = block.text;
          }
        }
      }
    } catch (err) {
      log('error', { where: `agent:${agent.name}`, message: err.message });
      return { agent, recs: 0 };
    }

    const ms = Date.now() - sessionStart;
    const reads = perAgentLog.filter(l => l.kind === 'read').length;
    const ctx = perAgentLog.filter(l => l.kind === 'contextualize').length;
    const recs = perAgentLog.filter(l => l.kind === 'record').length;
    if (lastText) {
      emitArtifact('signoff', `${agent.name} signoff (${lastText.length} chars)`, { text: lastText });
    }
    log('agent-end', { name: agent.name, ms, reads, ctx, recs,
      signoff: lastText ? lastText.replace(/\s+/g, ' ').trim().slice(0, 280) : '' });
    return { agent, recs };
  }

  // Emit participation-claim artifacts so the browser can inspect each one.
  // Also POST each to the bridge's /agent/attest endpoint so the
  // participation claim becomes a real foxxi:ParticipationClaim descriptor
  // on the pod — agent identity now survives across runs (instead of
  // being ephemeral to one dashboard session).
  for (const c of claims) {
    log('artifact', { id: artifactId(), type: 'participation-claim', producer: c.name,
      title: `${c.name} · ${c.address.slice(0, 10)}…`,
      payload: { did: c.did, address: c.address, claim: c.claim, signature: c.signature } });
    try {
      const attestRes = await post('/agent/attest', {
        name: c.name, did: c.did, address: c.address, claim: c.claim, signature: c.signature,
        agentRoleHint: 'field-guidance-agent',
      });
      // Surface the real published ParticipationClaim descriptor as its
      // own artifact so the browser can inspect the L1 shape.
      for (const p of (attestRes.json?.published ?? [])) {
        const url = p?.['hydra:resourceUrl'];
        const turtle = url ? await getTurtle(url) : null;
        const graphTurtle = p?.['foxxi:graphUrl'] ? await getTurtle(p['foxxi:graphUrl']) : null;
        const typeTags = Array.isArray(p?.['@type']) ? p['@type'] : (p?.['@type'] ? [p['@type']] : []);
        const foxxiType = typeTags.find(t => /foxxi|ac:|amta:/.test(String(t))) ?? typeTags[1] ?? 'unknown';
        log('artifact', {
          id: artifactId(), type: 'descriptor', producer: c.name,
          title: `${foxxiType.split(/[#/:]/).pop()} · ${p?.['@id'] ?? '(no iri)'}`,
          payload: {
            'descriptor-iri': p?.['@id'],
            'foxxi-type': foxxiType,
            'cg:types': typeTags,
            'pgsl:atom': p?.['pgsl:hasAtom'],
            'cg:describes': p?.['cg:describes'],
            'pod:descriptorUrl': url,
            'pod:graphUrl': p?.['foxxi:graphUrl'],
            'turtle': turtle ?? '(could not fetch descriptor; pod may have ACL)',
            'graph-turtle': graphTurtle,
            '_affordances': attestRes.json?._affordances ?? null,
          },
        });
      }
    } catch (err) {
      log('error', { where: `attest:${c.name}`, message: err.message });
    }
  }

  // PARALLEL: all five agents race. Whichever reaches the substrate first
  // gets there first; everyone else sees whatever has landed by then.
  const results = await Promise.all(AGENTS.map((a, ai) => runAgent(a, claims[ai], CASES_PER_AGENT[ai])));
  const totalContributed = results.reduce((s, r) => s + r.recs, 0);

  log('check', { label: 'every agent recorded three real outcomes', ok: totalContributed === 15 });

  log('act', { act: 5, name: 'emergence — the collective crosses the threshold' });
  const after = await refCell();
  const endSamples = after.cell?.samples ?? 0;
  log('cell', { samples: endSamples, closureRate: after.cell?.closureRate ?? 0, modalStatus: after.cell?.modalStatus ?? 'absent' });
  log('check', { label: `cell grew by exactly the agents' real contributions (${startSamples} → ${endSamples})`, ok: endSamples === startSamples + 15 });
  log('check', { label: 'finding is now Asserted — claimable knowledge belonging to NO single agent', ok: after.cell?.modalStatus === 'Asserted' });

  log('act', { act: 6, name: 'downward causation — the emergent whole shapes a fresh recommendation' });
  const freshRequest = {
    situation: {
      id: 'urn:foxxi:situation:newcomer-field-case-live',
      performer: { id: AGENTS[0].did, kind: 'agent', role: 'field operator' },
      workContext: 'applying a rarely-used procedure in the field',
      competency: 'completing the field procedure correctly',
      observed: 'misses steps because the guidance is not at hand',
      frequency: 'occasional', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
    },
    exemplary: 'completes the procedure correctly, guidance at hand',
    factorEvidence: { information: { adequate: false, evidence: 'the guide is not at the point of work' } },
  };
  const freshPlan = await post('/performance/plan', freshRequest);
  log('downward', { verdict: freshPlan.json?.calibration?.verdict ?? null });
  log('artifact', { id: artifactId(), type: 'fresh-plan', producer: 'system',
    title: `fresh plan — calibration verdict: ${freshPlan.json?.calibration?.verdict ?? '?'}`,
    payload: { request: freshRequest, response: freshPlan.json } });

  log('act', { act: 7, name: 'Atlas (a real Claude subagent) teaches Nova' });
  const atlas = AGENTS[3], nova = AGENTS[4];
  const teachLog = [];
  let teachVerdict = null;
  let teachRequest = null;
  const atlasTools = [
    tool(
      'read_calibration_profile',
      'Read the shared calibration profile.',
      {},
      async () => {
        log('agent-tool', { name: atlas.name, tool: 'read_calibration_profile' });
        teachLog.push({ kind: 'read' });
        const cal = await refCell();
        return { content: [{ type: 'text', text: JSON.stringify({ cell: cal.cell }, null, 2) }] };
      },
    ),
    tool(
      'teach',
      'Encode the emergent finding as a teaching package and teach the learner. Real POST to /agent/teach.',
      {
        competency: z.string(),
        signalMarkers: z.array(z.string()).min(2),
        antiSignalMarkers: z.array(z.string()).min(1),
        behaviourDescription: z.string(),
      },
      async ({ competency, signalMarkers, antiSignalMarkers, behaviourDescription }) => {
        log('agent-tool', { name: atlas.name, tool: 'teach', detail: competency });
        teachLog.push({ kind: 'teach' });
        const traj = (steps) => [{
          agentDid: nova.did, agentName: nova.name, createdAt: new Date().toISOString(),
          steps: steps.map((x, i) => ({ modalStatus: 'Asserted', granularity: 'tool-call', verb: x.v, objectId: `o${i}`, objectName: x.o, recordedAt: new Date().toISOString() })),
        }];
        teachRequest = {
          teachingPackage: { iri: 'urn:cg:teaching:reference-for-field-guidance-live', artifactIri: 'urn:cg:tool:field-reference', competency, olkeStage: 'Articulate', modalStatus: 'Hypothetical' },
          teacher: { id: atlas.did, kind: 'agent' },
          learner: { id: nova.did, kind: 'agent' },
          targetBehaviour: { description: behaviourDescription, signalMarkers, antiSignalMarkers },
          before: traj([{ v: 'guess', o: 'the next step' }, { v: 'skip', o: 'a checklist item' }, { v: 'act', o: 'on assumptions' }, { v: 'escalate', o: 'a mistake' }]),
          after: traj([{ v: 'look up', o: 'the reference for the procedure' }, { v: 'consult', o: 'the guidance' }, { v: 'apply', o: 'the referenced step' }, { v: 'look up', o: 'the reference again' }, { v: 'complete', o: 'the procedure' }, { v: 'verify', o: 'against the guidance' }]),
        };
        const res = await post('/agent/teach', teachRequest);
        teachVerdict = { status: res.status, verdict: res.json?.verdict };
        log('artifact', { id: artifactId(), type: 'teaching-package', producer: atlas.name,
          title: `${competency} — Atlas → Nova`,
          payload: { request: teachRequest, response: res.json } });
        // Emit the real linked-data descriptors the bridge just minted:
        // the ac:TeachingPackage and the amta:Attestation (both signed +
        // published to the pod).
        for (const p of (res.json?.published ?? [])) {
          const url = p?.['hydra:resourceUrl'];
          const turtle = url ? await getTurtle(url) : null;
          const graphTurtle = p?.['foxxi:graphUrl'] ? await getTurtle(p['foxxi:graphUrl']) : null;
          const typeTags = Array.isArray(p?.['@type']) ? p['@type'] : (p?.['@type'] ? [p['@type']] : []);
          const foxxiType = typeTags.find(t => /foxxi|ac:|amta:/.test(String(t))) ?? typeTags[1] ?? 'unknown';
          log('artifact', { id: artifactId(), type: 'descriptor', producer: atlas.name,
            title: `${foxxiType.split(/[#/:]/).pop()} · ${p?.['@id'] ?? '(no iri)'}`,
            payload: {
              'descriptor-iri': p?.['@id'],
              'foxxi-type': foxxiType,
              'cg:types': typeTags,
              'pgsl:atom': p?.['pgsl:hasAtom'],
              'cg:describes': p?.['cg:describes'],
              'pod:descriptorUrl': url,
              'pod:graphUrl': p?.['foxxi:graphUrl'],
              'turtle': turtle ?? '(could not fetch descriptor; pod may have ACL)',
              'graph-turtle': graphTurtle,
              '_affordances': res.json?._affordances ?? null,
            },
          });
        }
        return { content: [{ type: 'text', text: JSON.stringify(teachVerdict, null, 2) }] };
      },
    ),
  ];
  const atlasServer = createSdkMcpServer({ name: 'foxxi', tools: atlasTools });
  log('agent-start', { name: atlas.name, did: atlas.did, model: MODEL, role: 'teacher' });
  const teachStart = Date.now();
  let teachText = '';
  try {
    for await (const msg of query({
      prompt: `Read the calibration profile. If the information → reference cell is Asserted, encode the finding as a teaching package and teach ${nova.name}. The behaviour you are teaching: consults the searchable reference at the point of work before acting. Choose realistic signal/anti-signal markers. When done, summarise the verdict in one sentence.`,
      options: {
        model: MODEL,
        systemPrompt: `You are ${atlas.name} (DID ${atlas.did}). Your job: read the substrate, and if the collective has Asserted the information → reference finding, transmit it as a teaching package to ${nova.name} (DID ${nova.did}). All tools call the live bridge for real.`,
        mcpServers: { foxxi: atlasServer },
        tools: [],
        allowedTools: ['mcp__foxxi__read_calibration_profile', 'mcp__foxxi__teach'],
        permissionMode: 'bypassPermissions',
        settingSources: [],
        maxTurns: 8,
      },
    })) {
      if (cancelled.value) break;
      if (msg.type === 'result') sumUsage(msg.usage);
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text') teachText = block.text;
        }
      }
    }
  } catch (err) {
    log('error', { where: 'teaching', message: err.message });
  }
  // Close out Atlas's teacher session so the agent card returns to "done."
  log('agent-end', {
    name: atlas.name, role: 'teacher',
    ms: Date.now() - teachStart,
    reads: teachLog.filter(l => l.kind === 'read').length,
    ctx: 0,
    recs: teachLog.filter(l => l.kind === 'teach').length,
    cellSamples: null, modalStatus: null,
    signoff: teachText ? teachText.replace(/\s+/g, ' ').trim().slice(0, 280) : '',
  });
  log('teach', { from: atlas.name, to: nova.name, issued: teachLog.some(l => l.kind === 'teach'), verdict: teachVerdict });

  log('act', { act: 8, name: 'federation — the finding lives in a profile two organizations share' });
  const fed = await post('/performance/calibration', {});
  const fp = fed.json?.federated?.profile;
  log('federation', {
    totalSamples: fp?.totalSamples ?? 0,
    sources: fp?.sources ?? 0,
    seededOutcomes: fed.json?.provenance?.seededOutcomes ?? 0,
    liveOutcomes: fed.json?.provenance?.liveOutcomes ?? 0,
    cellModalStatus: (fp?.cells ?? []).find(c => c.causeFactor === 'information' && c.intervention === 'reference')?.modalStatus ?? null,
  });
  log('artifact', { id: artifactId(), type: 'federated-profile', producer: 'system',
    title: `federated profile — ${fp?.totalSamples ?? 0} outcomes across ${fp?.sources ?? 0} sources`,
    payload: { tenant: fed.json?.tenant, federated: fed.json?.federated, provenance: fed.json?.provenance } });

  log('done', { usage: totalUsage, model: MODEL });
}

// Approximate cost ($USD) at sonnet-4-6 published rates; rendered next to
// the token counts so the dashboard isn't misleading about the "40 in"
// figure (that excludes cached reads, which dominate).
const SONNET_PRICE = { input: 3 / 1e6, cache_write: 3.75 / 1e6, cache_read: 0.30 / 1e6, output: 15 / 1e6 };

// ── HTML dashboard (inlined) ────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The Emergent Collective — autonomous, live</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --text: #1a1a1a; --panel: #fdfdfb; --panel-2: #f5f3ee; --border: #d9d6cf;
    --accent: #c1432a; --text-dim: #6b6661; --warn: #d4a017; --bad: #c33;
    --good: #1a7f37; --shadow: 0 1px 0 rgba(0,0,0,0.04), 0 1px 8px rgba(0,0,0,0.05);
    --serif: 'EB Garamond', serif; --mono: 'JetBrains Mono', monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 28px; background: var(--panel-2);
    font-family: var(--serif); color: var(--text);
  }
  .wrap { max-width: 1200px; margin: 0 auto; }
  header { margin-bottom: 26px; }
  .eyebrow { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim); }
  h1 { font-family: var(--serif); font-weight: 500; font-size: 40px; line-height: 1.1; margin: 6px 0 12px; }
  p { font-size: 15px; line-height: 1.6; max-width: 800px; }
  .banner {
    max-width: 800px; padding: 9px 12px; border-radius: 4px;
    border-left: 3px solid var(--accent); background: rgba(0,0,0,0.025);
    font-size: 13px; line-height: 1.55; margin: 14px 0 18px;
  }
  .controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
  button.primary {
    padding: 10px 20px; background: var(--text); color: var(--panel); border: none;
    border-radius: 4px; font-family: var(--mono); font-size: 12px; font-weight: 600;
    letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer;
  }
  button.primary:disabled { opacity: 0.5; cursor: default; }
  button.outline {
    padding: 10px 20px; background: transparent; color: var(--text); border: 1px solid var(--text);
    border-radius: 4px; font-family: var(--mono); font-size: 12px; font-weight: 600;
    letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer;
  }
  .substrate-row { display: flex; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
  .dot {
    display: flex; align-items: center; gap: 8px; font-size: 12px; font-family: var(--mono); color: var(--text-dim);
    padding: 6px 12px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel);
  }
  .dot .blob { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); transition: background 200ms; }
  .dot.ok .blob { background: var(--good); }
  .dot.bad .blob { background: var(--bad); }
  .dot b { color: var(--text); }

  .agents-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 22px; }
  .agent {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px;
    box-shadow: var(--shadow); transition: border-color 180ms, box-shadow 180ms;
  }
  .agent.active { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(193,67,42,0.10); }
  .agent.done { border-color: var(--good); }
  .agent .name { font-family: var(--mono); font-size: 13px; font-weight: 600; letter-spacing: 0.05em; }
  .agent .did { font-family: var(--mono); font-size: 10px; color: var(--text-dim); margin-top: 2px; word-break: break-all; }
  .agent .sig { font-family: var(--mono); font-size: 10px; color: var(--text-dim); margin-top: 4px; }
  .agent .bar { height: 4px; background: var(--border); border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .agent .bar > div { height: 100%; background: var(--accent); transition: width 250ms; }
  .agent .status { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim); margin-top: 4px; }
  .agent.active .status { color: var(--accent); }
  .agent.done .status { color: var(--good); }

  .cell-row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; margin-bottom: 22px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px; box-shadow: var(--shadow); }
  .cell .big { font-family: var(--mono); font-size: 56px; font-weight: 600; line-height: 1.0; }
  .cell .lbl { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim); }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
  .pill.h { background: rgba(212,160,23,0.18); color: #8a6d12; }
  .pill.a { background: rgba(26,127,55,0.18); color: var(--good); }
  .pill.x { background: rgba(0,0,0,0.06); color: var(--text-dim); }
  .progress { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 10px; }
  .progress > div { height: 100%; background: var(--accent); transition: width 350ms; }
  .glow { animation: glow 1100ms ease-out; }
  @keyframes glow {
    0%   { box-shadow: 0 0 0 0 rgba(193,67,42,0.55); }
    50%  { box-shadow: 0 0 0 16px rgba(193,67,42,0.18); }
    100% { box-shadow: var(--shadow); }
  }
  .closure { font-family: var(--mono); font-size: 28px; font-weight: 600; }
  .events {
    background: var(--text); color: #d9d6cf; border-radius: 8px; padding: 12px;
    font-family: var(--mono); font-size: 11px; line-height: 1.55; height: 280px; overflow-y: auto;
  }
  .events .row {
    display: grid;
    grid-template-columns: 52px 70px 1fr;
    gap: 10px; align-items: baseline; padding: 1px 0;
  }
  .events .ts   { color: #888; text-align: right; }
  .events .kind { color: var(--accent); text-transform: uppercase; font-size: 9px; letter-spacing: 0.04em; }
  .events .kind.http  { color: #9ecbff; }
  .events .kind.flip  { color: var(--good); font-weight: 600; }
  .events .kind.error { color: #ff7b72; }
  .events .kind.check { color: var(--good); }
  .events .kind.fail  { color: #ff7b72; }
  .events .msg  { word-break: break-word; }

  /* per-agent event lanes (one column per agent, real concurrency view) */
  .lanes-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 22px; }
  .lane {
    background: var(--text); color: #d9d6cf; border-radius: 8px; padding: 10px;
    font-family: var(--mono); font-size: 10px; line-height: 1.55; height: 260px; overflow: hidden;
    display: flex; flex-direction: column;
  }
  .lane header {
    display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;
    border-bottom: 1px solid #333; padding-bottom: 4px;
  }
  .lane .lane-name { color: #ffa657; font-weight: 600; font-size: 11px; letter-spacing: 0.05em; }
  .lane .lane-stat { color: #888; font-size: 9px; text-transform: uppercase; letter-spacing: 0.07em; }
  .lane .lane-events { flex: 1; overflow-y: auto; }
  .lane .lane-row {
    display: grid; grid-template-columns: 38px 52px 1fr; gap: 6px;
    align-items: baseline; padding: 1px 0;
  }
  .lane .ts { color: #888; text-align: right; font-size: 9px; }
  .lane .kind { color: var(--accent); text-transform: uppercase; font-size: 8px; letter-spacing: 0.04em; }
  .lane .kind.http  { color: #9ecbff; }
  .lane .kind.tool  { color: #f4be72; }
  .lane .kind.sig   { color: #b9a8e8; }
  .lane .kind.signoff { color: #d9d6cf; font-style: italic; }
  .lane .kind.error { color: #ff7b72; }
  .lane .msg  { word-break: break-word; font-size: 10px; }

  /* artifacts browser */
  .artifacts-row { display: grid; grid-template-columns: 320px 1fr; gap: 16px; margin-bottom: 22px; min-height: 360px; }
  .art-list {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; max-height: 480px; overflow: hidden;
  }
  .art-list header {
    padding: 12px 14px; border-bottom: 1px solid var(--border);
    display: flex; align-items: baseline; justify-content: space-between; margin: 0;
  }
  .art-list header .lbl { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim); }
  .art-list .count { font-family: var(--mono); font-size: 11px; color: var(--text); }
  .art-filters {
    display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--border);
    background: var(--panel-2);
  }
  .art-filters button {
    background: transparent; border: 1px solid var(--border); border-radius: 999px;
    padding: 2px 8px; font-family: var(--mono); font-size: 9px; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--text-dim); cursor: pointer;
  }
  .art-filters button.on { background: var(--text); color: var(--panel); border-color: var(--text); }
  .art-items { flex: 1; overflow-y: auto; }
  .art-item {
    padding: 9px 14px; border-bottom: 1px solid var(--border); cursor: pointer;
    display: flex; flex-direction: column; gap: 2px;
  }
  .art-item:hover { background: var(--panel-2); }
  .art-item.selected { background: rgba(193,67,42,0.06); border-left: 3px solid var(--accent); padding-left: 11px; }
  .art-item .title { font-family: var(--mono); font-size: 11px; color: var(--text); word-break: break-word; }
  .art-item .meta { font-family: var(--mono); font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .art-item .meta .producer { color: #b8794a; }
  .art-item .meta .type-tag { display: inline-block; padding: 1px 6px; border-radius: 999px; margin-right: 6px; background: var(--panel-2); border: 1px solid var(--border); }
  .art-detail {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow);
    display: flex; flex-direction: column; max-height: 480px; overflow: hidden;
  }
  .art-detail header { padding: 12px 14px; border-bottom: 1px solid var(--border); margin: 0; }
  .art-detail .art-title { font-family: var(--mono); font-size: 12px; color: var(--text); word-break: break-word; }
  .art-detail .art-meta { font-family: var(--mono); font-size: 10px; color: var(--text-dim); margin-top: 3px; }
  .art-payload {
    margin: 0; padding: 14px; flex: 1; overflow: auto; background: var(--panel-2);
    font-family: var(--mono); font-size: 11px; line-height: 1.5; color: var(--text);
    border: 0; border-radius: 0;
  }

  .bottom-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 22px; }
  .orgs { display: flex; gap: 20px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .org-blob {
    flex: 1; min-width: 130px; padding: 12px; border-radius: 6px; background: var(--panel-2);
    border: 1px solid var(--border); text-align: center;
  }
  .org-blob .o-name { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.05em; }
  .org-blob .o-stat { font-family: var(--mono); font-size: 10px; color: var(--text-dim); margin-top: 4px; }
  .closing { margin-top: 26px; padding: 18px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }
  code { font-family: var(--mono); font-size: 12px; background: rgba(0,0,0,0.04); padding: 1px 6px; border-radius: 3px; }
  pre { font-family: var(--mono); font-size: 12px; padding: 9px 11px; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; }
  .wrap-wide { max-width: 1500px; }
  @media (max-width: 980px) {
    .agents-row, .lanes-row { grid-template-columns: repeat(2, 1fr); }
    .cell-row, .bottom-row, .artifacts-row { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="wrap wrap-wide">
<header>
  <div class="eyebrow">Foxxi × Interego · live local dashboard</div>
  <h1>The Emergent Collective — autonomous</h1>
  <p>Five real Claude subagents spawn server-side and work <b>asynchronously, in parallel</b>. The orchestrator never tells an agent what to do; coordination, if any, happens only because the live substrate carries each agent's contributions to whoever reads it next. Their work products land in the artifacts browser below as they're created.</p>
  <div class="banner">
    <b>Authentication: your local Claude Code login.</b> The agents run in this Node process; nothing is sent to Anthropic from your browser. No <code>ANTHROPIC_API_KEY</code> needed unless your CLI session isn't active.
  </div>
  <div class="controls">
    <button id="run" class="primary">▶ Run it live</button>
    <button id="reset" class="outline">↻ Reset</button>
    <span id="phase" style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);"></span>
  </div>
</header>

<div class="substrate-row">
  <div id="bridge-dot" class="dot"><span class="blob"></span> Foxxi bridge on Azure: <b>—</b></div>
  <div id="peer-dot" class="dot"><span class="blob"></span> peer organization pod: <b>—</b></div>
</div>

<div class="agents-row" id="agents"></div>

<div class="cell-row">
  <div class="card cell" id="cell-card">
    <div class="lbl">calibration cell · information → reference</div>
    <div style="display: flex; align-items: baseline; gap: 14px; margin-top: 4px;">
      <div class="big" id="cell-samples">—</div>
      <div id="cell-pill" class="pill x">—</div>
      <div style="margin-left: auto; text-align: right;">
        <div class="lbl">emergent closure rate</div>
        <div class="closure" id="closure">—</div>
      </div>
    </div>
    <div class="progress"><div id="cell-progress" style="width: 0%"></div></div>
    <div style="font-family: var(--mono); font-size: 10px; color: var(--text-dim); margin-top: 6px;">
      flip threshold: <b>${ASSERT_THRESHOLD}</b> samples · the cell may jump in bursts as concurrent outcomes land
    </div>
  </div>
  <div class="card">
    <div class="lbl">system log · background / non-agent events</div>
    <div class="events" id="events"></div>
  </div>
</div>

<div class="lanes-row" id="lanes"></div>

<div class="artifacts-row">
  <div class="art-list">
    <header>
      <span class="lbl">work products · click to inspect</span>
      <span class="count" id="art-count">0</span>
    </header>
    <div class="art-filters" id="art-filters"></div>
    <div class="art-items" id="art-items"></div>
  </div>
  <div class="art-detail">
    <header>
      <div class="art-title" id="art-title">— select an artifact —</div>
      <div class="art-meta" id="art-meta"></div>
    </header>
    <pre class="art-payload" id="art-payload">Each agent's tool calls produce real work artifacts here:

· participation-claim  — signed ECDSA proof of identity
· calibration-read     — a snapshot of the shared substrate at the moment an agent read it (stigmergy in action)
· situation            — a real performance situation filed with the bridge (POST /performance/plan)
· outcome              — a real outcome record (POST /performance/outcome)
· signoff              — the agent's final summary
· fresh-plan           — the downward-causation plan annotated with calibration evidence
· teaching-package     — Atlas's encoded transmissible capability
· federated-profile    — the two-organization composed view</pre>
  </div>
</div>

<div class="bottom-row">
  <div class="card" id="teach-card">
    <div class="lbl">teaching — agent-to-agent transfer</div>
    <div id="teach-body" style="margin-top: 8px; font-size: 14px; color: var(--text-dim);">Atlas will read the substrate, decide whether the finding is Asserted, encode it, and teach Nova.</div>
  </div>
  <div class="card">
    <div class="lbl">federation — two organizations share the finding</div>
    <div class="orgs" id="orgs-body">
      <div class="org-blob"><div class="o-name">Acme</div><div class="o-stat" id="acme-stat">—</div></div>
      <div style="font-family: var(--mono); font-size: 18px; color: var(--text-dim);">+</div>
      <div class="org-blob"><div class="o-name">Peer Academy</div><div class="o-stat" id="peer-stat">—</div></div>
    </div>
  </div>
</div>

<div class="closing">
  <div style="font-family: var(--serif); font-style: italic; font-size: 19px; margin-bottom: 6px;">What you're watching</div>
  <p>Five real wallet-rooted identities, plus five real Claude subagents acting independently against the live deployed bridge, produce a piece of knowledge no single one of them could establish alone. The bridge's modal status names the exact point at which the aggregate becomes claimable knowledge. The finding then becomes a transmissible <code>ac:TeachingPackage</code> and comes to live in a profile two organizations share.</p>
  <p style="margin-top: 10px;">Same architecture as the CLI sibling:</p>
  <pre>npx tsx applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs</pre>
</div>

</div>

<script>
const AGENT_NAMES = ${JSON.stringify(AGENT_NAMES)};
const ASSERT_THRESHOLD = ${ASSERT_THRESHOLD};
const $ = (id) => document.getElementById(id);

let t0 = 0;
let initialCellSamples = 0;
const ARTIFACT_TYPES = ['descriptor','participation-claim','calibration-read','situation','outcome','signoff','fresh-plan','teaching-package','federated-profile'];
let artifacts = [];
let selectedArtifactId = null;
let activeFilter = 'all';

function renderAgents(agents) {
  $('agents').innerHTML = agents.map(a => \`
    <div class="agent\${a.active ? ' active' : ''}\${a.done ? ' done' : ''}" id="ag-\${a.name}">
      <div class="name">\${a.name}</div>
      <div class="did">\${a.did || 'awaiting wallet…'}</div>
      <div class="sig">sig: \${a.sig || '—'}</div>
      <div class="bar"><div style="width: \${a.progress}%"></div></div>
      <div class="status">\${a.status}</div>
    </div>
  \`).join('');
}

function renderLanes() {
  $('lanes').innerHTML = AGENT_NAMES.map(n => \`
    <div class="lane" id="lane-\${n}">
      <header><span class="lane-name">\${n}</span><span class="lane-stat" id="lane-stat-\${n}">idle</span></header>
      <div class="lane-events" id="lane-events-\${n}"></div>
    </div>
  \`).join('');
}

const initialAgents = () => AGENT_NAMES.map(name => ({ name, did: '', sig: '', active: false, done: false, progress: 0, status: 'idle' }));
let agents = initialAgents();
renderAgents(agents);
renderLanes();

function sysLog(kind, html) {
  const el = $('events');
  const ts = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const klass = kind.toLowerCase().replace(/\\s+/g, '-');
  el.insertAdjacentHTML('beforeend',
    \`<div class="row"><span class="ts">\${ts}</span><span class="kind \${klass}">\${kind}</span><span class="msg">\${html}</span></div>\`);
  el.scrollTop = el.scrollHeight;
}

function agentLog(name, kind, html) {
  const el = $('lane-events-' + name);
  if (!el) return;
  const ts = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  const klass = kind.toLowerCase().replace(/\\s+/g, '-');
  el.insertAdjacentHTML('beforeend',
    \`<div class="lane-row"><span class="ts">\${ts}</span><span class="kind \${klass}">\${kind}</span><span class="msg">\${html}</span></div>\`);
  el.scrollTop = el.scrollHeight;
}

function setLaneStat(name, stat) {
  const el = $('lane-stat-' + name);
  if (el) el.textContent = stat;
}

function renderFilters() {
  const counts = { all: artifacts.length };
  for (const a of artifacts) counts[a.type] = (counts[a.type] || 0) + 1;
  const opts = [['all','all'], ...ARTIFACT_TYPES.map(t => [t, t.replace(/-/g, ' ')])];
  $('art-filters').innerHTML = opts
    .filter(([k]) => k === 'all' || counts[k])
    .map(([k, label]) => \`<button data-type="\${k}" class="\${activeFilter === k ? 'on' : ''}">\${label} \${counts[k] ? '· ' + counts[k] : ''}</button>\`)
    .join('');
  $('art-filters').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => { activeFilter = b.dataset.type; renderArtifacts(); });
  });
}

function renderArtifacts() {
  $('art-count').textContent = artifacts.length;
  renderFilters();
  const visible = activeFilter === 'all' ? artifacts : artifacts.filter(a => a.type === activeFilter);
  $('art-items').innerHTML = visible.map(a => \`
    <div class="art-item\${a.id === selectedArtifactId ? ' selected' : ''}" data-id="\${a.id}">
      <div class="meta"><span class="type-tag">\${a.type}</span><span class="producer">\${a.producer}</span> · <span>\${a.tsLabel}</span></div>
      <div class="title">\${escapeHtml(a.title)}</div>
    </div>
  \`).join('');
  $('art-items').querySelectorAll('.art-item').forEach(el => {
    el.addEventListener('click', () => selectArtifact(el.dataset.id));
  });
}

function selectArtifact(id) {
  selectedArtifactId = id;
  const a = artifacts.find(x => x.id === id);
  if (!a) return;
  $('art-title').textContent = a.title;
  $('art-meta').innerHTML = \`<span class="type-tag" style="background:var(--panel-2);border:1px solid var(--border);padding:1px 6px;border-radius:999px;">\${a.type}</span> · produced by <b>\${a.producer}</b> · t+\${a.tsLabel}\`;
  // For real linked-data descriptors, surface the Turtle + the pod URLs
  // up front (the user asked for "Interego HATEOAS linked-data stuff" —
  // give them the actual on-the-wire shape). For other artifacts, show
  // the JSON payload as before.
  if (a.type === 'descriptor' && a.payload?.turtle) {
    const p = a.payload;
    const podLinks = [
      p['pod:descriptorUrl'] ? \`descriptor → <a href="\${p['pod:descriptorUrl']}" target="_blank" rel="noreferrer">\${p['pod:descriptorUrl']}</a>\` : null,
      p['pod:graphUrl'] ? \`graph → <a href="\${p['pod:graphUrl']}" target="_blank" rel="noreferrer">\${p['pod:graphUrl']}</a>\` : null,
    ].filter(Boolean).join('  ·  ');
    const summaryLines = [
      \`# cg:ContextDescriptor\`,
      \`# Foxxi type: \${p['foxxi-type'] ?? 'unknown'}\`,
      \`# Descriptor IRI: \${p['descriptor-iri'] ?? '—'}\`,
      \`# Describes (named graph): \${p['cg:describes'] ?? '—'}\`,
      \`# Content-addressed payload (PGSL atom): \${p['pgsl:atom'] ?? '—'}\`,
      '',
      \`# ── Turtle (fetched from pod with Accept: text/turtle) ─\`,
      '',
      p.turtle,
    ];
    if (p['graph-turtle']) {
      summaryLines.push('', '# ── Graph (TriG) — the named graph the descriptor describes ─', '', p['graph-turtle']);
    }
    if (p._affordances) {
      summaryLines.push('', '# ── _affordances (hydra:Operation) ─', '', JSON.stringify(p._affordances, null, 2));
    }
    $('art-payload').innerHTML = (podLinks ? \`<div style="font-family:var(--mono);font-size:11px;margin-bottom:10px;padding:6px 8px;background:var(--panel);border:1px solid var(--border);border-radius:4px;">\${podLinks}</div>\` : '') +
      \`<pre style="margin:0;font-family:var(--mono);font-size:11px;line-height:1.5;white-space:pre-wrap;">\${escapeHtml(summaryLines.join('\\n'))}</pre>\`;
  } else {
    $('art-payload').textContent = JSON.stringify(a.payload, null, 2);
  }
  renderArtifacts();
}

function addArtifact(ev) {
  const tsLabel = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  artifacts.push({ id: ev.id, type: ev.type, producer: ev.producer, title: ev.title, payload: ev.payload, tsLabel });
  renderArtifacts();
  // Auto-select the first artifact so the detail pane gets populated.
  if (!selectedArtifactId) selectArtifact(ev.id);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>\"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[c]));
}

function setDot(id, ok) {
  const el = $(id);
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('bad', ok === false);
  el.querySelector('b').textContent = ok === null || ok === undefined ? '—' : ok ? 'live' : 'unreachable';
}

function updateCell({ samples, closureRate, modalStatus, initial }) {
  if (initial) initialCellSamples = samples;
  $('cell-samples').textContent = samples;
  const pill = $('cell-pill');
  pill.textContent = modalStatus;
  pill.className = 'pill ' + (modalStatus === 'Asserted' ? 'a' : modalStatus === 'Hypothetical' ? 'h' : 'x');
  $('closure').textContent = Math.round((closureRate || 0) * 100) + '%';
  const since = Math.max(0, samples - initialCellSamples);
  const pct = Math.min(100, (since / 15) * 100);
  $('cell-progress').style.width = pct + '%';
}

function flipGlow() {
  $('cell-card').classList.add('glow');
  setTimeout(() => $('cell-card').classList.remove('glow'), 1200);
}

let es = null;
function reset() {
  if (es) { es.close(); es = null; }
  agents = initialAgents(); renderAgents(agents);
  renderLanes();
  setDot('bridge-dot', null); setDot('peer-dot', null);
  $('cell-samples').textContent = '—'; $('cell-pill').textContent = '—'; $('cell-pill').className = 'pill x';
  $('closure').textContent = '—'; $('cell-progress').style.width = '0%';
  $('events').innerHTML = '';
  $('teach-body').textContent = 'Atlas will read the substrate, decide whether the finding is Asserted, encode it, and teach Nova.';
  $('acme-stat').textContent = '—'; $('peer-stat').textContent = '—';
  $('phase').textContent = '';
  $('run').disabled = false;
  artifacts = []; selectedArtifactId = null; activeFilter = 'all';
  renderArtifacts();
  $('art-title').textContent = '— select an artifact —'; $('art-meta').innerHTML = '';
  $('art-payload').textContent = 'Artifacts will appear here as the agents work. Click any to inspect the full request/response payload.';
}

$('reset').addEventListener('click', reset);
$('run').addEventListener('click', () => {
  reset();
  t0 = Date.now();
  $('run').disabled = true;
  $('phase').textContent = 'running…';
  es = new EventSource('/stream?t=' + Date.now());
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    handle(ev);
  };
  es.onerror = () => {
    sysLog('ERROR', 'stream interrupted');
    if (es) { es.close(); es = null; }
    $('phase').textContent = 'done';
    $('run').disabled = false;
  };
});

function handle(ev) {
  switch (ev.kind) {
    case 'act':
      sysLog('ACT ' + ev.act, ev.name);
      break;
    case 'substrate':
      if (ev.bridgeOk !== undefined) { setDot('bridge-dot', ev.bridgeOk); sysLog('HTTP', 'bridge: ' + (ev.bridgeOk ? 'live' : 'unreachable')); }
      if (ev.peerOk !== undefined) { setDot('peer-dot', ev.peerOk); sysLog('HTTP', 'peer pod: ' + (ev.peerOk ? 'live' : 'unreachable')); }
      break;
    case 'agent-signed': {
      const a = agents.find(x => x.name === ev.name);
      if (a) { a.did = ev.did; a.sig = ev.signature; a.status = 'signed'; renderAgents(agents); }
      setLaneStat(ev.name, 'signed');
      agentLog(ev.name, 'SIG', 'signed: ' + ev.signature);
      break;
    }
    case 'cell':
      updateCell(ev);
      if (!ev.initial) sysLog('HTTP', \`calibration cell now <b>\${ev.samples}</b> samples, \${ev.modalStatus}\`);
      break;
    case 'agent-start': {
      const a = agents.find(x => x.name === ev.name);
      if (a) { a.active = true; a.status = ev.role === 'teacher' ? 'teaching…' : 'working…'; a.progress = 5; renderAgents(agents); }
      setLaneStat(ev.name, ev.role === 'teacher' ? 'teaching…' : 'working…');
      agentLog(ev.name, 'START', \`spawned (\${ev.model})\${ev.role ? \` as \${ev.role}\` : ''}\`);
      break;
    }
    case 'agent-tool': {
      const a = agents.find(x => x.name === ev.name);
      if (a) { a.progress = Math.min(95, a.progress + 12); renderAgents(agents); }
      const detail = ev.detail ? ' · ' + (ev.detail.length > 50 ? ev.detail.slice(0,50)+'…' : ev.detail) : '';
      agentLog(ev.name, 'TOOL', \`<code>\${ev.tool}</code>\${detail}\`);
      break;
    }
    case 'agent-end': {
      const a = agents.find(x => x.name === ev.name);
      if (a) {
        a.active = false; a.done = true; a.progress = 100;
        a.status = ev.role === 'teacher'
          ? \`taught · \${ev.reads}r/\${ev.recs}t\`
          : \`done · \${ev.reads}r/\${ev.ctx}c/\${ev.recs}o\`;
        renderAgents(agents);
      }
      setLaneStat(ev.name, ev.role === 'teacher'
        ? \`taught · \${(ev.ms/1000).toFixed(1)}s\`
        : \`done · \${(ev.ms/1000).toFixed(1)}s\`);
      const detail = ev.role === 'teacher'
        ? \`teaching done — \${ev.reads}r/\${ev.recs}t in \${(ev.ms/1000).toFixed(1)}s\`
        : \`done — \${ev.reads}r/\${ev.ctx}c/\${ev.recs}o in \${(ev.ms/1000).toFixed(1)}s\`;
      agentLog(ev.name, 'END', detail);
      if (ev.signoff) agentLog(ev.name, 'SIGNOFF', '<i>"' + ev.signoff.slice(0, 140) + (ev.signoff.length > 140 ? '…' : '') + '"</i>');
      break;
    }
    case 'flip':
      sysLog('FLIP', \`Hypothetical → <b>Asserted</b> during \${ev.during} — emergence\`);
      flipGlow();
      break;
    case 'downward':
      sysLog('HTTP', \`fresh plan carries calibration verdict: <b>\${ev.verdict}</b>\`);
      break;
    case 'teach':
      $('teach-body').innerHTML = \`<b>\${ev.from} → \${ev.to}</b>: teach issued: \${ev.issued ? '<span style="color:var(--good)">yes</span>' : '<span style="color:var(--bad)">no</span>'}\${ev.verdict ? \` · verdict transferred: <b>\${ev.verdict.verdict?.transferred ?? '?'}</b> (\${ev.verdict.verdict?.modalStatus ?? '—'})\` : ''}\`;
      sysLog('TEACH', \`\${ev.from} → \${ev.to} · issued: \${ev.issued} · transferred: \${ev.verdict?.verdict?.transferred ?? '?'}\`);
      break;
    case 'federation':
      $('acme-stat').textContent = (ev.liveOutcomes ?? 0) + ' live outcomes';
      $('peer-stat').textContent = (ev.seededOutcomes ?? 0) + ' seeded outcomes';
      sysLog('HTTP', \`federated profile: \${ev.totalSamples} outcomes across \${ev.sources} source(s); finding modal: <b>\${ev.cellModalStatus}</b>\`);
      break;
    case 'artifact':
      addArtifact(ev);
      break;
    case 'check':
      sysLog(ev.ok ? 'CHECK' : 'FAIL', (ev.ok ? '✓ ' : '✗ ') + ev.label);
      break;
    case 'error':
      sysLog('ERROR', '<b>' + (ev.where ?? 'error') + '</b>: ' + ev.message);
      break;
    case 'done': {
      const u = ev.usage || {};
      const inFresh = u.input_tokens ?? 0;
      const inCacheRead = u.cache_read_input_tokens ?? 0;
      const inCacheCreate = u.cache_creation_input_tokens ?? 0;
      const out = u.output_tokens ?? 0;
      const totalIn = inFresh + inCacheRead + inCacheCreate;
      // sonnet-4-6 rates: $3/M in, $0.30/M cache-read, $3.75/M cache-write, $15/M out
      const cost = (inFresh * 3 + inCacheRead * 0.30 + inCacheCreate * 3.75 + out * 15) / 1e6;
      sysLog('DONE',
        \`tokens · in \${totalIn.toLocaleString()} (\${inFresh.toLocaleString()} fresh + \${inCacheRead.toLocaleString()} cache-read + \${inCacheCreate.toLocaleString()} cache-write) · out \${out.toLocaleString()} · ≈ $\${cost.toFixed(3)} (\${ev.model})\`);
      $('phase').textContent = \`done · ≈ $\${cost.toFixed(3)}\`;
      $('run').disabled = false;
      if (es) { es.close(); es = null; }
      break;
    }
  }
}

renderArtifacts();
</script>
</body>
</html>`;

// ── server ──────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/stream') {
    if (runInProgress) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('a run is already in progress; refresh in a moment');
      return;
    }
    runInProgress = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`: connected\n\n`);

    const cancelled = { value: false };
    const emit = (ev) => {
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* socket closed */ }
    };
    req.on('close', () => { cancelled.value = true; });

    try {
      await runAutonomousCollective({ emit, cancelled });
    } catch (e) {
      emit({ kind: 'error', where: 'top-level', message: e.message });
    } finally {
      runInProgress = false;
      try { res.end(); } catch {}
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`\n  ─────────────────────────────────────────────────────────────────`);
  console.log(`  ▶  The Emergent Collective — autonomous edition, live local dashboard`);
  console.log(`  ─────────────────────────────────────────────────────────────────`);
  console.log(`\n  Open:   ${url}`);
  console.log(`\n  Bridge: ${BRIDGE}`);
  console.log(`  Model:  ${MODEL}`);
  console.log(`  Auth:   your active Claude Code login (no API key needed)`);
  console.log(`\n  When you click "Run it live", five real Claude subagents will`);
  console.log(`  spawn in this process and work the cases through the live bridge.`);
  console.log(`  Ctrl+C to stop.\n`);
});
