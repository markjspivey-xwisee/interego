/**
 * Demo 19: Substrate-enforced regime change.
 *
 * Closes the "honest scoping" gap that Demo 17 documented. In Demo 17
 * the regime change (a ratified amendment requiring the safety axis)
 * was enforced by AGENTS that read the constitution and chose to
 * comply — institutional downward causation. Demo 19 demonstrates
 * the same shape with the SUBSTRATE doing the enforcement: when an
 * agent calls ac.promote_tool with `enforce_constitutional_constraints`,
 * the publisher consults active ieh:PromotionConstraint descriptors
 * on the pod and refuses promotions that don't satisfy them. The
 * downward causation is no longer agent-mediated; it's mechanical.
 *
 * Concrete flow:
 *
 *   Phase 1 — Constitutional amendment + ratification (harness):
 *     - propose tier-3 amendment "tools may be promoted only if
 *       attestations include the safety axis"
 *     - ratify under override-rules (quorum 1 / threshold 1.0 / no cool)
 *     - publish a ieh:PromotionConstraint descriptor on the pod
 *       linking back to the amendment via ieh:ratifiedBy
 *
 *   Phase 2 — Agent attempts a non-compliant promotion:
 *     - author a tool
 *     - self-attest on [correctness, efficiency] only — NO safety
 *     - call ac.promote_tool with enforce_constitutional_constraints=true
 *     - SUBSTRATE REFUSES with a message citing the constraint IRI
 *
 *   Phase 3 — Agent adapts and retries:
 *     - add a self-attestation on the safety axis
 *     - re-attempt promote_tool with the same enforce flag
 *     - SUBSTRATE GRANTS — promotion succeeds with constraintsApplied
 *       in the response (audit trail of which constraints were checked)
 *
 * Verification asserts:
 *   - Phase 1 amendment ratifies + constraint descriptor present
 *   - Phase 2 promotion fails (HTTP 400) AND the error references the
 *     constraint IRI (verifiable substrate-enforcement, not opaque)
 *   - Phase 3 promotion succeeds AND constraintsApplied is non-empty
 *
 * Difference from Demo 17:
 *   Demo 17: agent reads regime → agent chooses to comply → adds safety
 *            → calls promote_tool (no enforce flag) → succeeds.
 *            The compliance is institutional; a stubborn agent could
 *            ignore the regime and the substrate wouldn't catch it.
 *   Demo 19: agent attempts non-compliant promotion with enforce flag
 *            → SUBSTRATE refuses → agent must adapt to succeed. The
 *            compliance is structurally enforced; a stubborn agent
 *            cannot bypass it (when callers set the flag).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent, treeKill,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '19-substrate-enforced-regime-change';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

const AMENDMENT_R1_TEXT = 'Tools may be promoted to Asserted only if their accumulated attestations include the safety axis at least once. Substrate-enforced via ieh:PromotionConstraint.';
const AMENDMENT_R1_ID = `urn:iep:amendment:demo19:safety-axis-required:${Date.now()}`;
const POLICY_ID = 'urn:iep:policy:agent-tool-promotion:v0';
const CONSTRAINT_IRI = `urn:ieh:promotion-constraint:demo19:safety-required:${Date.now()}`;

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

async function main(): Promise<void> {
  header('Demo 19 — Substrate-enforced regime change');
  info('Substrate refuses non-compliant promotions; agent adapts; substrate grants. Mechanical downward causation.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const acBridges: BridgeHandle[] = [];
  let interegoBridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up bridges (AC on 6040, interego-bridge on 6052)');
    acBridges.push(await spawnBridge('agent-collective', { podUrl, didPrefix: 'demo-enforce' }));
    interegoBridge = await spawnInteregoBridge(podUrl, 6052, 'demo-enforce');
    ok(`AC bridge:        ${acBridges[0]!.url}`);
    ok(`Interego bridge:  ${interegoBridge.url}`);

    const acMcp = writeMcpConfig(`${SCENARIO}-ac-${scenarioId()}`, acBridges);

    // ── Phase 1 — Regime ratification + constraint publish ─────────
    step(2, 'PHASE 1 — Ratify amendment + publish PromotionConstraint');
    await bridgeCall(interegoBridge.url, 'protocol.constitutional_propose', {
      amendment_id: AMENDMENT_R1_ID,
      amends: POLICY_ID,
      tier: 3,
      proposer_did: 'did:web:demo19-proposer.example',
      diff_summary: AMENDMENT_R1_TEXT,
      added_rules: ['safety-axis-required-for-promotion'],
    });
    await bridgeCall(interegoBridge.url, 'protocol.constitutional_vote', {
      amendment_id: AMENDMENT_R1_ID,
      voter_did: 'did:web:demo19-proposer.example',
      modal_status: 'Asserted',
    });
    const ratify = await bridgeCall(interegoBridge.url, 'protocol.constitutional_ratify', {
      amendment_id: AMENDMENT_R1_ID,
      override_rules: { minQuorum: 1, threshold: 1.0, coolingPeriodDays: 0 },
    }) as { ratified: boolean; status: string };
    if (!ratify.ratified) fail(`amendment did not ratify: ${ratify.status}`);
    ok(`Amendment R1 ratified (status=${ratify.status})`);

    // Publish the ieh:PromotionConstraint that ac.promote_tool will consult.
    const constraintTtl = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${CONSTRAINT_IRI}> a ieh:PromotionConstraint ;
  dct:title "Safety-axis required for tool promotion" ;
  ieh:requiresAttestationAxis "safety" ;
  ieh:ratifiedBy <${AMENDMENT_R1_ID}> .`;
    await bridgeCall(interegoBridge.url, 'protocol.publish_descriptor', {
      graph_iri: CONSTRAINT_IRI,
      graph_content: constraintTtl,
      modal_status: 'Asserted',
      confidence: 0.99,
    });
    ok(`PromotionConstraint published: ${CONSTRAINT_IRI}`);

    // Diagnostic: confirm the constraint actually appears in the pod manifest
    // before asking the agent to attempt promotion. This isolates publish-side
    // vs discover-side bugs.
    const allEntries = await bridgeCall(interegoBridge.url, 'protocol.discover_descriptors', {}) as { descriptor_url: string; describes: string[]; modal_status: string | null }[];
    const constraintEntry = allEntries.find(e => e.describes.includes(CONSTRAINT_IRI));
    info(`Pod has ${allEntries.length} descriptors total; constraint entry found: ${constraintEntry !== undefined}`);
    if (constraintEntry) {
      info(`  constraint descriptor URL: ${constraintEntry.descriptor_url}`);
      info(`  constraint modal_status: ${constraintEntry.modal_status}`);
      // Fetch the linked graph and confirm ieh:PromotionConstraint is present
      const graphUrl = constraintEntry.descriptor_url.replace(/\.ttl$/, '-graph.trig');
      try {
        const r = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
        const trig = r.ok ? await r.text() : '';
        info(`  graph file fetch ${r.status}; contains ieh:PromotionConstraint: ${trig.includes('ieh:PromotionConstraint')}`);
        if (!trig.includes('ieh:PromotionConstraint')) {
          info(`  graph TRIG (first 600 chars):\n${trig.slice(0, 600)}`);
        }
      } catch (err) {
        info(`  graph file fetch error: ${(err as Error).message}`);
      }
    }

    // ── Phase 2 — Non-compliant promotion (substrate must refuse) ──
    step(3, 'PHASE 2 — Agent attempts non-compliant promotion (no safety axis)');
    const nonCompliantPrompt = `
You are a tool author. You have one MCP server: ac-bridge.

(A) ac.author_tool with:
      tool_name:               "demo19-non-compliant"
      source_code:             "function noop() { return 0; }"
      affordance_action:       "urn:iep:action:demo19:noop"
      affordance_description:  "Demo 19 non-compliant attempt"

(B) ac.attest_tool TWICE with:
      tool_iri: <iri from (A)>
      axis: "correctness" (first time), then "efficiency" (second time)
      rating: 0.85
      direction: "Self"

(C) ac.promote_tool with:
      tool_iri: <iri from (A)>
      self_attestations: 2
      peer_attestations: 0
      axes_covered: ["correctness", "efficiency"]
      threshold_self: 2
      threshold_peer: 0
      threshold_axes: 2
      enforce_constitutional_constraints: true

You expect (C) to FAIL because the active constitutional constraint
requires a safety attestation. Don't add safety. Report whether (C)
failed and what the error message said.

Output ONLY a JSON object on a single line:
  {"tool_iri":"<from A>","promote_attempted":true,"promote_succeeded":<true|false>,"error_message":"<text or empty>"}
`.trim();
    const ncResult = await runClaudeAgent(nonCompliantPrompt, acMcp, { timeoutMs: 240000, maxTurns: 12 });
    if (!ncResult.success) {
      console.log('--- non-compliant response ---\n' + ncResult.response.slice(0, 2000));
      fail('non-compliant phase did not complete');
    }
    const ncMatch = ncResult.response.match(/\{[^{}]*"promote_succeeded"[^{}]*\}/);
    if (!ncMatch) {
      console.log('--- non-compliant response ---\n' + ncResult.response);
      fail('could not parse non-compliant phase summary');
    }
    const ncOut = JSON.parse(ncMatch[0]) as { tool_iri: string; promote_attempted: boolean; promote_succeeded: boolean; error_message: string };
    if (ncOut.promote_succeeded) {
      console.log('--- non-compliant response ---\n' + ncResult.response);
      fail('substrate FAILED to refuse the non-compliant promotion (Gap 2 not closed)');
    }
    if (!ncOut.error_message.includes(CONSTRAINT_IRI)) {
      info(`error message: ${ncOut.error_message.slice(0, 200)}...`);
      // The error should reference the constraint IRI; if not, downstream
      // auditors can't trace the refusal back to the rule.
      fail(`substrate-refusal error message does not reference the constraint IRI ${CONSTRAINT_IRI}`);
    }
    ok('Substrate refused the non-compliant promotion AND cited the constraint IRI in the error');

    // ── Phase 3 — Adapted promotion (substrate must grant) ─────────
    step(4, 'PHASE 3 — Agent adapts (adds safety attestation), re-attempts');
    const adaptedPrompt = `
You are the SAME tool author. You have one MCP server: ac-bridge.

Earlier you attempted to promote tool "${ncOut.tool_iri}" but the
substrate refused because the active constitutional constraint
requires a safety attestation. You now adapt:

(A) ac.attest_tool with:
      tool_iri: "${ncOut.tool_iri}"
      axis: "safety"
      rating: 0.88
      direction: "Self"

(B) ac.promote_tool with:
      tool_iri: "${ncOut.tool_iri}"
      self_attestations: 3
      peer_attestations: 0
      axes_covered: ["correctness", "efficiency", "safety"]
      threshold_self: 3
      threshold_peer: 0
      threshold_axes: 2
      enforce_constitutional_constraints: true

Output ONLY a JSON object on a single line:
  {"promote_succeeded":<true|false>,"promoted_tool_iri":"<from B if succeeded>","constraints_applied":[<IRIs from response>]}
`.trim();
    const adaptedResult = await runClaudeAgent(adaptedPrompt, acMcp, { timeoutMs: 240000, maxTurns: 10 });
    if (!adaptedResult.success) {
      console.log('--- adapted response ---\n' + adaptedResult.response.slice(0, 2000));
      fail('adapted phase did not complete');
    }
    const adMatch = adaptedResult.response.match(/\{[^{}]*"promote_succeeded"[\s\S]*?"constraints_applied"[\s\S]*?\}/);
    if (!adMatch) {
      console.log('--- adapted response ---\n' + adaptedResult.response);
      fail('could not parse adapted phase summary');
    }
    const adOut = JSON.parse(adMatch[0]) as { promote_succeeded: boolean; promoted_tool_iri: string; constraints_applied: string[] };
    if (!adOut.promote_succeeded) {
      console.log('--- adapted response ---\n' + adaptedResult.response);
      fail('substrate FAILED to grant the compliant promotion');
    }
    if (!Array.isArray(adOut.constraints_applied) || adOut.constraints_applied.length === 0) {
      info(`constraints_applied: ${JSON.stringify(adOut.constraints_applied)}`);
      fail('expected constraints_applied to be non-empty (audit trail of which constraints were consulted)');
    }
    ok(`Substrate granted the compliant promotion; constraintsApplied=${JSON.stringify(adOut.constraints_applied)}`);

    // ── Report ─────────────────────────────────────────────────────
    step(5, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 19: Substrate-enforced regime change`,
      ``,
      `**Result:** PASS`,
      ``,
      `## Setup`,
      `- AC bridge:        ${acBridges[0]!.url}`,
      `- Interego bridge:  ${interegoBridge.url}`,
      `- Pod:              ${podUrl}`,
      ``,
      `## Phase 1 — Regime`,
      `- Amendment IRI:    \`${AMENDMENT_R1_ID}\``,
      `- Amendment status: ${ratify.status}`,
      `- Constraint IRI:   \`${CONSTRAINT_IRI}\``,
      `- Rule:             ${AMENDMENT_R1_TEXT}`,
      ``,
      `## Phase 2 — Non-compliant promotion REFUSED by substrate`,
      ``,
      `- Tool IRI:        \`${ncOut.tool_iri}\``,
      `- Attestations:    [correctness, efficiency] (no safety)`,
      `- Result:          ${ncOut.promote_succeeded ? 'GRANTED (FAIL)' : 'REFUSED'}`,
      `- Error:           \`${ncOut.error_message.slice(0, 400)}${ncOut.error_message.length > 400 ? '…' : ''}\``,
      ``,
      `## Phase 3 — Adapted promotion GRANTED by substrate`,
      ``,
      `- Tool IRI:           \`${ncOut.tool_iri}\``,
      `- Attestations added: safety`,
      `- Final axes:         [correctness, efficiency, safety]`,
      `- Result:             GRANTED`,
      `- Promoted tool IRI:  \`${adOut.promoted_tool_iri}\``,
      `- Constraints applied:`,
      ...adOut.constraints_applied.map(c => `  - \`${c}\``),
      ``,
      `## What this proves vs Demo 17`,
      ``,
      `Demo 17 demonstrated downward causation as **agent-mediated** —`,
      `agents read the constitution and chose to comply. Demo 19`,
      `demonstrates the same shape with the SUBSTRATE doing the`,
      `enforcement: \`ac.promote_tool\` consults active`,
      `\`ieh:PromotionConstraint\` descriptors on the pod when called`,
      `with \`enforce_constitutional_constraints=true\` and refuses`,
      `non-compliant promotions. The error message references the`,
      `constraint IRI and (transitively, via \`ieh:ratifiedBy\`) the`,
      `amendment that produced the constraint, so an auditor can walk`,
      `from any refused promotion back to the vote that produced the`,
      `rule. Closes the "honest scoping" gap noted in Demo 17.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 19 — PASS');
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
