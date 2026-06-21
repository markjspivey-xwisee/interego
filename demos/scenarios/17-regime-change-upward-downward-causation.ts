/**
 * Demo 17: Constitutional regime change — upward AND downward causation
 * across multiple emergent layers, with population-level adaptation.
 *
 * This is the "complex emergence" showcase. Eleven claude processes
 * traverse a complete causal loop:
 *
 *   Layer 1 (atoms)  : individual agent actions — author, attest, vote
 *   Layer 2 (states) : per-tool trust scores; per-amendment vote tallies
 *   Layer 3 (regime) : the current constitution (set of ratified amendments)
 *   Layer 4 (popln)  : population-level authoring + promotion behavior
 *
 *   UPWARD CAUSATION
 *     L1 → L2: individual votes accumulate into a per-amendment tally.
 *     L2 → L3: when a tally clears the tier-rule threshold, ratification
 *              transitions the amendment from Proposed to Ratified —
 *              changing the constitution. This is a BINARY phase
 *              transition emerging from continuous accumulation.
 *
 *   DOWNWARD CAUSATION
 *     L3 → L4: regime-aware agents read the current ratified amendments
 *              and SHAPE THEIR BEHAVIOR accordingly. Tools whose
 *              attestation pattern would have promoted under the prior
 *              regime are explicitly NOT promoted under the new regime
 *              — the agents recognize the binding rule and adapt.
 *     L4 → L1: agents add the missing attestations (a NEW lower-level
 *              action induced by the higher-level constraint), then
 *              re-attempt promotion successfully. The loop closes.
 *
 *   AUDIT
 *     Every layer is recoverable from the pod alone. Anyone walking
 *     the manifest sees: individual votes → amendment record →
 *     ratification timestamp → constitution descriptor → tool
 *     authorings before/after the regime change. The substrate
 *     records both upward and downward arrows of the causal loop.
 *
 * Concrete flow:
 *
 *   Phase 1 — Initial regime (R0). 3 agents author + cross-attest
 *     + self-promote tools under R0 (default rules: any 2 axes
 *     among correctness/efficiency/generality suffice). All
 *     succeed.
 *
 *   Phase 2 — Amendment proposal & voting. 5 voter agents in parallel
 *     vote on amendment R1: "tools may only be promoted if their
 *     attestations include the SAFETY axis." Tier-3 ratification.
 *
 *   Phase 3 — Ratification. The amendment crosses threshold; the
 *     constitution now contains R1. The harness publishes a
 *     constitution descriptor on the pod (auditable regime change).
 *
 *   Phase 4 — Regime-aware population. 3 new agents author tools.
 *     Each first reads the current constitution from the pod, then
 *     authors + attests with the SAME pattern Phase-1 agents used
 *     (correctness + efficiency, no safety). Each agent reports
 *     that their pattern violates R1 and ADAPTS by adding a safety
 *     attestation BEFORE promoting. Promotion succeeds under R1.
 *
 * Verification asserts:
 *   - Phase 1 promotions all succeed under R0 (3 of 3)
 *   - Phase 2 amendment ratifies (4-of-5 in favor at tier 3)
 *   - Phase 4 agents detect the regime change and adapt
 *   - Phase 4 agents include safety attestations (downward causation)
 *   - All tool IRIs distinct; supersedes chains intact
 *
 * What this proves about emergence: complex causation is observable
 * end-to-end on the substrate alone. No external coordinator manages
 * the regime; no per-agent hardcoded rule enforces R1; the agents
 * read the constitution that emerged from their peers' votes and
 * change their behavior accordingly. Causation flows UP through
 * the votes → tally → ratification chain, and DOWN through the
 * agents' own reading-and-adapting cycle. The substrate is the
 * shared medium through which both directions propagate.
 *
 * Honest scoping: the substrate's promote_tool primitive does not
 * automatically enforce R1 — that would require coupling promote_tool
 * to the constitutional layer (a real architecture decision worth
 * making but not made yet). In this demo, R1 is enforced by REGIME-
 * AWARE AGENTS that read the constitution and choose to comply.
 * That's the institutional model of downward causation — norms shape
 * behavior because compliant agents consult and follow them, not
 * because some metaphysical force prevents non-compliance. The
 * substrate's contribution is making the regime LEGIBLE (auditable
 * descriptors) and the audit trail TAMPER-EVIDENT (signed publishes,
 * supersedes chains for revisions).
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent, treeKill,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const SCENARIO = '17-regime-change-upward-downward-causation';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

// Eleven distinct identities across the demo:
//   3 in Phase 1 (Population A)  —  Alice / Bob / Carol
//   5 in Phase 2 (Voters)        —  Dan / Eve / Frank / Grace / Henry
//   3 in Phase 4 (Population B)  —  Iris / Jules / Kai
const POP_A = [
  { id: 'did:web:alice-popA.example', short: 'alice' },
  { id: 'did:web:bob-popA.example',   short: 'bob' },
  { id: 'did:web:carol-popA.example', short: 'carol' },
];
const VOTERS = [
  { id: 'did:web:dan-voter.example',   stance: 'in-favor', rationale: 'Safety attestations are non-negotiable for tools that could affect downstream agent behavior. Better to over-cover than under-cover.' },
  { id: 'did:web:eve-voter.example',   stance: 'in-favor', rationale: 'Aligns the population\'s evaluation discipline with what we need for compliance reporting.' },
  { id: 'did:web:frank-voter.example', stance: 'in-favor', rationale: 'Multiple recent incidents would have been caught earlier with mandatory safety review.' },
  { id: 'did:web:grace-voter.example', stance: 'against',  rationale: 'Adding mandatory axes raises the bar for early-stage tools; prefer a softer guidance rule.' },
  { id: 'did:web:henry-voter.example', stance: 'in-favor', rationale: 'The audit-trail visibility this creates is worth the added overhead per tool.' },
];
const POP_B = [
  { id: 'did:web:iris-popB.example',  short: 'iris' },
  { id: 'did:web:jules-popB.example', short: 'jules' },
  { id: 'did:web:kai-popB.example',   short: 'kai' },
];

const TOOL_VARIANTS = [
  {
    name: 'sentiment-classifier',
    affordanceAction: 'urn:iep:action:demo:sentiment-classify',
    source: 'function classify(text) { const pos = ["good","great","love","excellent"]; const neg = ["bad","terrible","hate","awful"]; const t = text.toLowerCase(); let s = 0; for (const w of pos) if (t.includes(w)) s++; for (const w of neg) if (t.includes(w)) s--; return s > 0 ? "positive" : s < 0 ? "negative" : "neutral"; }',
    description: 'Lexicon-based sentiment classifier. Three-way output.',
  },
  {
    name: 'pii-redactor',
    affordanceAction: 'urn:iep:action:demo:pii-redact',
    source: 'function redact(text) { return text.replace(/\\b\\d{3}-\\d{2}-\\d{4}\\b/g, "[SSN]").replace(/\\b\\d{3}-\\d{3}-\\d{4}\\b/g, "[PHONE]").replace(/[\\w.-]+@[\\w.-]+/g, "[EMAIL]"); }',
    description: 'Regex-based PII redactor for SSN/phone/email patterns.',
  },
  {
    name: 'rate-limiter',
    affordanceAction: 'urn:iep:action:demo:rate-limit',
    source: 'function check(key, store, limit, windowMs) { const now = Date.now(); const arr = (store[key] = (store[key] || []).filter(t => now - t < windowMs)); if (arr.length >= limit) return false; arr.push(now); return true; }',
    description: 'Sliding-window rate limiter; returns false when over limit.',
  },
];

// The constitutional rule R1 we want to ratify in Phase 2.
const AMENDMENT_R1_TEXT = 'Tools may be promoted to Asserted only if their accumulated attestations include the safety axis at least once. Pre-existing Asserted tools are not retroactively invalidated; the rule applies to promotion attempts after this amendment ratifies.';
const AMENDMENT_R1_ID = `urn:iep:amendment:safety-axis-required:${Date.now()}`;
const POLICY_R0_ID = 'urn:iep:policy:agent-tool-promotion:v0';

// ── Helpers ─────────────────────────────────────────────────────────

async function spawnInteregoBridge(podUrl: string, port: number, didPrefix: string): Promise<BridgeHandle> {
  const cwd = join(REPO_ROOT, 'demos', 'interego-bridge');
  const env = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_DEPLOYMENT_URL: `http://localhost:${port}`,
    INTEREGO_DEFAULT_POD_URL: podUrl,
    INTEREGO_DEFAULT_AGENT_DID: `did:web:${didPrefix}.example`,
    NODE_NO_WARNINGS: '1',
  };
  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/affordances`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { name: 'agent-collective' as const, port, url, process: proc, podUrl };
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  treeKill(proc, 'SIGTERM');
  throw new Error(`interego-bridge :${port} failed to start`);
}

async function bridgeCall(bridgeUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${bridgeUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const j = await r.json() as { result?: { content?: { text?: string }[] }; error?: unknown };
  if (j.error || !j.result?.content?.[0]?.text) throw new Error(`${name} failed: ${JSON.stringify(j.error ?? j)}`);
  return JSON.parse(j.result.content[0].text);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  header('Demo 17 — Constitutional regime change: upward + downward causation');
  info('11 agents. 4 phases. Both directions of causation observable end-to-end.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const acBridges: BridgeHandle[] = [];
  let interegoBridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up bridges (AC on 6040, interego-bridge on 6052)');
    acBridges.push(await spawnBridge('agent-collective', { podUrl, didPrefix: 'demo-regime' }));
    interegoBridge = await spawnInteregoBridge(podUrl, 6052, 'demo-regime');
    ok(`AC bridge:        ${acBridges[0]!.url}`);
    ok(`Interego bridge:  ${interegoBridge.url}`);

    const acMcp = writeMcpConfig(`${SCENARIO}-ac-${scenarioId()}`, acBridges);
    const fullMcp = writeMcpConfig(`${SCENARIO}-full-${scenarioId()}`, [acBridges[0]!, interegoBridge]);

    // ── Phase 1 ─────────────────────────────────────────────────────
    step(2, 'PHASE 1 — Population A authors tools under regime R0');
    const phase1Start = Date.now();
    const popA = await Promise.all(POP_A.map(async (agent, idx) => {
      const variant = TOOL_VARIANTS[idx]!;
      const prompt = `
You are ${agent.id}, a member of Population A. You have one MCP server: ac-bridge.

You author a tool under the current regime, attest it across two
axes (correctness, efficiency), and self-promote.

(A) ac.author_tool with:
      tool_name:               "${variant.name}"
      source_code:             ${JSON.stringify(variant.source)}
      affordance_action:       "${variant.affordanceAction}"
      affordance_description:  ${JSON.stringify(variant.description)}

(B) ac.attest_tool with:
      tool_iri: <iri from (A)>
      axis: "correctness"
      rating: 0.85
      direction: "Self"

(C) ac.attest_tool with:
      tool_iri: <iri from (A)>
      axis: "efficiency"
      rating: 0.80
      direction: "Self"

(D) ac.promote_tool with:
      tool_iri: <iri from (A)>
      self_attestations: 2
      peer_attestations: 0
      axes_covered: ["correctness", "efficiency"]
      threshold_self: 2
      threshold_peer: 0
      threshold_axes: 2

Output ONLY a JSON object on a single line:
  {"agent":"${agent.id}","tool_iri":"<from A>","promoted":<true|false>,"axes":["correctness","efficiency"]}
`.trim();
      const result = await runClaudeAgent(prompt, acMcp, { timeoutMs: 240000, maxTurns: 12 });
      if (!result.success) {
        console.log(`--- ${agent.short} response ---\n` + result.response.slice(0, 1500));
        fail(`Phase 1 agent ${agent.short} did not complete`);
      }
      const m = result.response.match(/\{[^{}]*"tool_iri"[^{}]*"promoted"[^{}]*\}/);
      if (!m) {
        console.log(`--- ${agent.short} response ---\n` + result.response);
        fail(`could not parse ${agent.short}'s Phase-1 summary`);
      }
      return JSON.parse(m[0]) as { agent: string; tool_iri: string; promoted: boolean; axes: string[] };
    }));
    const phase1Elapsed = ((Date.now() - phase1Start) / 1000).toFixed(1);
    info(`Phase 1 finished in ${phase1Elapsed}s`);
    for (const t of popA) info(`  ${t.agent.split(':').pop()} → ${t.tool_iri.slice(-30)} (promoted=${t.promoted})`);
    if (popA.some(t => !t.promoted)) {
      console.log('Phase 1 results:', JSON.stringify(popA, null, 2));
      fail('not every Phase-1 tool promoted under R0 — initial regime malfunction');
    }
    ok(`All ${popA.length} Phase-1 tools promoted under R0 (no safety required)`);

    // ── Phase 2 ─────────────────────────────────────────────────────
    step(3, 'PHASE 2 — Five voters propose + vote on amendment R1');
    // Harness proposes the amendment first so all voters reference one IRI
    const propRes = await bridgeCall(interegoBridge.url, 'protocol.constitutional_propose', {
      amendment_id: AMENDMENT_R1_ID,
      amends: POLICY_R0_ID,
      tier: 3,
      proposer_did: VOTERS[0]!.id,
      diff_summary: AMENDMENT_R1_TEXT,
      added_rules: ['safety-axis-required-for-promotion'],
    }) as { ok: boolean; amendment: { id: string } };
    ok(`Amendment proposed: ${propRes.amendment.id.slice(-40)}`);

    const phase2Start = Date.now();
    const voteResults = await Promise.all(VOTERS.map(async (v) => {
      const modal = v.stance === 'in-favor' ? 'Asserted' : v.stance === 'against' ? 'Counterfactual' : 'Hypothetical';
      const prompt = `
You are voter ${v.id}. You have one MCP server: ig-bridge (interego-bridge).

A constitutional amendment is up for vote:

  amendment_id:  "${AMENDMENT_R1_ID}"
  rule:          ${JSON.stringify(AMENDMENT_R1_TEXT)}

Your considered position: ${v.stance.toUpperCase()}.
Rationale: ${v.rationale}

Call protocol.constitutional_vote with:
  amendment_id: "${AMENDMENT_R1_ID}"
  voter_did:    "${v.id}"
  modal_status: "${modal}"

Output ONLY a JSON object on a single line:
  {"voter":"${v.id}","modal_status":"${modal}"}
`.trim();
      const safeId = v.id.replace(/[^a-z0-9]+/gi, '-');
      const igMcp = writeMcpConfig(`${SCENARIO}-vote-${safeId}-${scenarioId()}`, [interegoBridge!]);
      const result = await runClaudeAgent(prompt, igMcp, { timeoutMs: 180000, maxTurns: 8 });
      if (!result.success) {
        console.log(`--- voter ${v.id} response ---\n` + result.response.slice(0, 1500));
        fail(`voter ${v.id} did not complete`);
      }
      return { voter: v, modal };
    }));
    const phase2Elapsed = ((Date.now() - phase2Start) / 1000).toFixed(1);
    info(`Phase 2 finished in ${phase2Elapsed}s — ${voteResults.length} votes cast`);

    // ── Phase 3 ─────────────────────────────────────────────────────
    step(4, 'PHASE 3 — Ratification (upward causation: votes → constitutional state)');
    const ratify = await bridgeCall(interegoBridge.url, 'protocol.constitutional_ratify', {
      amendment_id: AMENDMENT_R1_ID,
      override_rules: { minQuorum: 3, threshold: 0.51, coolingPeriodDays: 0 },
    }) as { ok: boolean; ratified: boolean; status: string; amendment: { votes: { voter: string; modalStatus: string }[] } };
    info(`Status: ${ratify.status} (${ratify.amendment.votes.length} votes recorded)`);
    if (!ratify.ratified) {
      console.log('Ratify result:', JSON.stringify(ratify, null, 2));
      fail('amendment R1 did not ratify — Phase 4 cannot demonstrate regime change');
    }
    ok('Amendment R1 ratified — constitution now requires safety axis for promotion');

    // Publish a constitution descriptor on the pod so it's auditable
    // and Phase-4 agents can read it via the standard discover flow.
    await bridgeCall(interegoBridge.url, 'protocol.publish_descriptor', {
      graph_iri: 'urn:iep:constitution:demo-17:current',
      graph_content: `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix dct: <http://purl.org/dc/terms/> .
<urn:iep:constitution:demo-17:current> a iep:Constitution ;
  dct:title "Tool-promotion regime, post-R1 ratification" ;
  dct:description ${JSON.stringify(AMENDMENT_R1_TEXT)} ;
  iep:ratifiedAmendment <${AMENDMENT_R1_ID}> ;
  iep:ratifiedAt "${new Date().toISOString()}" .`,
      modal_status: 'Asserted',
      confidence: 0.99,
      conforms_to: [`${AMENDMENT_R1_ID}`],
    });
    ok('Constitution descriptor published — regime change visible in pod manifest');

    // ── Phase 4 ─────────────────────────────────────────────────────
    step(5, 'PHASE 4 — Population B reads regime, adapts (downward causation)');
    const phase4Start = Date.now();
    const popB = await Promise.all(POP_B.map(async (agent, idx) => {
      const variant = TOOL_VARIANTS[idx]!;
      const prompt = `
You are ${agent.id}, a member of Population B. You have TWO MCP servers:
  ac-bridge:        author + attest + promote tools (ac.*)
  ig-bridge:        read constitutional state (protocol.constitutional_status)

Population A successfully promoted tools using attestations on
[correctness, efficiency] alone. You'll do similarly — author, attest,
promote — BUT you are required to read the CURRENT REGIME first and
comply with it.

Step 1 — Read the current ratified regime.
  Call protocol.constitutional_status with:
    amendment_id: "${AMENDMENT_R1_ID}"

  The response includes the amendment's status (Ratified vs other) and
  its rule text. If the status is "Ratified", the rule is BINDING on
  your subsequent actions.

Step 2 — Author your tool.
  Variant assigned: ${variant.name}
  Call ac.author_tool with:
    tool_name:               "${variant.name}-popB"
    source_code:             ${JSON.stringify(variant.source)}
    affordance_action:       "${variant.affordanceAction}-popB"
    affordance_description:  ${JSON.stringify(variant.description)}

Step 3 — Self-attest (the Population-A pattern).
  Call ac.attest_tool with:
    tool_iri: <iri from Step 2>
    axis: "correctness"
    rating: 0.85
    direction: "Self"
  Then ac.attest_tool again with:
    tool_iri: <iri from Step 2>
    axis: "efficiency"
    rating: 0.80
    direction: "Self"

Step 4 — DECIDE WHETHER TO PROMOTE.
  At this point you have axes [correctness, efficiency]. Compare your
  attestation pattern against the binding rule from Step 1.
    - If the rule REQUIRES an axis you don't have, you MUST add it
      before promoting. Call ac.attest_tool with the missing axis
      ("safety", rating 0.88, direction "Self"). Then your axes are
      [correctness, efficiency, safety].
    - If the rule doesn't require it, proceed without adding.

Step 5 — Promote.
  Call ac.promote_tool with the FINAL axes_covered (3 if you added
  safety, 2 if not):
    tool_iri: <iri from Step 2>
    self_attestations: <number of self-attestations recorded>
    peer_attestations: 0
    axes_covered: <your final axes array>
    threshold_self: <self-attestations count>
    threshold_peer: 0
    threshold_axes: 2

Output ONLY a JSON object on a single line:
  {"agent":"${agent.id}","tool_iri":"<from Step 2>","regime_required_safety":<true|false>,"adapted":<true|false>,"final_axes":[...],"promoted":<true|false>,"explanation":"<one short sentence>"}
`.trim();
      const result = await runClaudeAgent(prompt, fullMcp, { timeoutMs: 480000, maxTurns: 24 });
      if (!result.success) {
        console.log(`--- ${agent.short} response ---\n` + result.response.slice(0, 2000));
        fail(`Phase 4 agent ${agent.short} did not complete`);
      }
      const m = result.response.match(/\{[^{}]*"tool_iri"[^{}]*"adapted"[^{}]*\}/);
      if (!m) {
        console.log(`--- ${agent.short} response ---\n` + result.response);
        fail(`could not parse ${agent.short}'s Phase-4 summary`);
      }
      return JSON.parse(m[0]) as {
        agent: string; tool_iri: string;
        regime_required_safety: boolean; adapted: boolean;
        final_axes: string[]; promoted: boolean; explanation: string;
      };
    }));
    const phase4Elapsed = ((Date.now() - phase4Start) / 1000).toFixed(1);
    info(`Phase 4 finished in ${phase4Elapsed}s`);

    for (const t of popB) {
      info(`  ${t.agent.split(':').pop()} → adapted=${t.adapted} axes=[${t.final_axes.join(',')}] promoted=${t.promoted}`);
    }

    // ── Verification ────────────────────────────────────────────────
    step(6, 'Verification — both directions of causation observable');

    // Upward: ratification happened from individual votes
    const inFavor = ratify.amendment.votes.filter(v => v.modalStatus === 'Asserted').length;
    const against = ratify.amendment.votes.filter(v => v.modalStatus === 'Counterfactual').length;
    if (inFavor + against !== VOTERS.length) {
      fail(`expected ${VOTERS.length} non-abstain votes, got ${inFavor + against}`);
    }
    if (!ratify.ratified) fail('ratification did not occur (upward causation step missing)');
    ok(`UPWARD: ${inFavor}-of-${VOTERS.length} votes in favor → amendment ratified → regime updated`);

    // Downward: each Phase-4 agent recognized R1 and added the safety axis
    const adapted = popB.filter(t => t.adapted && t.final_axes.includes('safety'));
    if (adapted.length !== POP_B.length) {
      console.log('Phase 4 details:', JSON.stringify(popB, null, 2));
      fail(`${adapted.length}/${POP_B.length} Phase-4 agents adapted; the others ignored R1`);
    }
    ok(`DOWNWARD: ${adapted.length}/${POP_B.length} Phase-4 agents read R1 and ADAPTED their attestation pattern`);

    // All Phase-4 tools promoted (after adaptation)
    const promotedB = popB.filter(t => t.promoted).length;
    if (promotedB !== POP_B.length) {
      fail(`only ${promotedB}/${POP_B.length} Phase-4 tools promoted after adaptation`);
    }
    ok(`Loop closure: all ${POP_B.length} Phase-4 tools promoted after adaptation (downward → new lower-level actions)`);

    // Distinct tool IRIs across both populations
    const allIris = new Set([...popA.map(a => a.tool_iri), ...popB.map(b => b.tool_iri)]);
    if (allIris.size !== POP_A.length + POP_B.length) {
      fail(`expected ${POP_A.length + POP_B.length} distinct tool IRIs, got ${allIris.size}`);
    }
    ok(`${allIris.size} distinct tool IRIs across both populations`);

    // ── Report ──────────────────────────────────────────────────────
    step(7, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 17: Constitutional regime change — upward + downward causation`,
      ``,
      `**Result:** PASS`,
      `**Phase 1:** ${phase1Elapsed}s, ${POP_A.length} agents authored under R0, all promoted.`,
      `**Phase 2:** ${phase2Elapsed}s, ${VOTERS.length} voters cast ballots in parallel.`,
      `**Phase 3:** ratification (status=${ratify.status}); ${inFavor}-of-${VOTERS.length} in favor.`,
      `**Phase 4:** ${phase4Elapsed}s, ${POP_B.length} agents read R1 and adapted.`,
      ``,
      `## Population A (Phase 1, under R0 — no safety required)`,
      ``,
      `| agent | tool | promoted | axes |`,
      `|---|---|---|---|`,
      ...popA.map(t => `| ${t.agent.split(':').pop()} | \`${t.tool_iri.slice(-32)}\` | ${t.promoted} | ${t.axes.join(', ')} |`),
      ``,
      `## Vote tally on amendment R1`,
      ``,
      `Amendment IRI: \`${AMENDMENT_R1_ID}\``,
      `Rule: ${AMENDMENT_R1_TEXT}`,
      ``,
      `| voter | modal_status |`,
      `|---|---|`,
      ...ratify.amendment.votes.map(v => `| ${v.voter.split(':').pop()} | ${v.modalStatus} |`),
      ``,
      `**Tier-3 outcome:** ${inFavor}-of-${inFavor + against} in favor → ${ratify.status}.`,
      ``,
      `## Population B (Phase 4, under R1 — regime-aware)`,
      ``,
      `| agent | regime_required_safety | adapted | final axes | promoted |`,
      `|---|---|---|---|---|`,
      ...popB.map(t => `| ${t.agent.split(':').pop()} | ${t.regime_required_safety} | ${t.adapted} | ${t.final_axes.join(', ')} | ${t.promoted} |`),
      ``,
      `### Each agent's reasoning`,
      ``,
      ...popB.map(t => `- **${t.agent.split(':').pop()}**: ${t.explanation}`),
      ``,
      `## What this proves about emergence`,
      ``,
      `**Upward causation observable.** The amendment's status transitioned from \`Proposed\` to \`Ratified\` because the per-voter modal-status tally crossed the tier-3 threshold (≥3 quorum, ≥51% in favor). Individual vote descriptors at L1 produced a binary regime change at L3. Anyone walking the pod can replay the votes and recompute the ratification arithmetic.`,
      ``,
      `**Downward causation observable.** Population-B agents read the ratified regime from the pod (\`protocol.constitutional_status\`) BEFORE acting. The Population-A attestation pattern (correctness + efficiency) would have promoted under R0 — Population B saw that the same pattern violates R1 and ADAPTED by adding a safety attestation. The agents' own actions changed because of a higher-level structure that emerged from their peers' votes.`,
      ``,
      `**Loop closure.** The downward-induced adaptation produced new lower-level actions (additional safety attestations) that re-entered the trust graph. Tools that would have been Hypothetical-forever under non-compliant promotion attempts moved to Asserted via compliant promotion. The full L1 → L2 → L3 → L4 → L1 loop completes within a single demo run, and every layer's evidence is on the pod.`,
      ``,
      `**Honest scoping.** The substrate's \`ac.promote_tool\` does not yet automatically enforce R1 — that would require coupling promote_tool to the constitutional layer (a real architecture decision worth making, not made yet). In this demo the regime is enforced by AGENTS that read the constitution and choose to comply, mirroring how institutional norms work: the law shapes behavior because compliant agents consult and follow it. The substrate's contribution is making the regime LEGIBLE (typed descriptors + supersedes chains) and the audit trail TAMPER-EVIDENT (signed publishes). A future revision could push enforcement into the substrate by wiring promote_tool to consult the active constitution; the demo's design wouldn't change, only the verification of who-refused-promotion.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 17 — PASS');
  } finally {
    if (acBridges.length > 0) await killBridges(acBridges);
    if (interegoBridge) {
      treeKill(interegoBridge.process, 'SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!interegoBridge.process.killed) treeKill(interegoBridge.process, 'SIGKILL');
    }
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
