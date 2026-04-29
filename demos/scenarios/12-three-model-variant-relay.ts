/**
 * Demo 12: Three-model-variant relay.
 *
 * Three independent claude CLI processes, each invoking a DIFFERENT
 * model SKU within the Anthropic family — opus, sonnet, haiku —
 * relay an attestation chain through Interego's Agent Collective
 * vertical. None of the three processes shares memory with the
 * others; the only continuity is the AC bridge's pod, which they
 * read and write through.
 *
 *   Opus  (proposer):  authors a tool, self-attests once
 *   Sonnet (peer):     reads Opus's tool IRI, peer-attests it
 *   Haiku (peer²):     reads tool + Sonnet's peer attestation,
 *                      peer-attests it
 *
 * What this proves: model-family heterogeneity is genuinely opaque
 * to the substrate. The AC vertical doesn't care which model wrote
 * a tool or attested it — only that the attestation is signed by
 * its agent identity. Any client able to call the AC affordances
 * can participate. The relay is structural, not bound to any
 * single LLM.
 *
 * Honest scoping note: a TRUE cross-family demo would require
 * running OpenAI / Gemini / xAI agents alongside Claude, which
 * needs additional provider keys. This demo uses three model
 * variants within the Anthropic family — different model
 * parameters, different costs, different latencies — to prove the
 * SHAPE of the architecture works. Swapping in non-Anthropic
 * agents is mechanical (their MCP support is the only requirement).
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '12-three-model-variant-relay';

async function main(): Promise<void> {
  header('Demo 12 — Three-model-variant relay');
  info('Opus → Sonnet → Haiku, three processes, three attestations, one shared substrate.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const bridges: BridgeHandle[] = [];

  try {
    step(1, 'Spinning up AC bridge (port 6040)');
    bridges.push(await spawnBridge('agent-collective', { podUrl, didPrefix: 'demo-relay' }));
    ok(`AC bridge: ${bridges[0]!.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, bridges);

    step(2, 'Opus: author a tool + self-attest');
    const opusPrompt = `
You are the OPUS-tier agent (proposer). You have one MCP server: ac-bridge.

PHASE 1: Author a small detection tool.
Call ac.author_tool with:
  tool_name: "second-contact-detector"
  source_code: |
    function detectSecondContact(message, history) {
      return history.length > 0 && /again|still|already|previously/i.test(message);
    }
  affordance_action: "urn:cg:action:demo:detect-second-contact"

PHASE 2: Self-attest the tool you just authored.
Call ac.attest_tool with:
  tool_iri:   <tool IRI from PHASE 1>
  axis:       "correctness"
  rating:     0.85
  direction:  "Self"

Output ONLY a JSON object on a single line:
  {"tool_iri":"...","tool_name":"second-contact-detector","author_model":"opus","self_attestation_iri":"..."}
No explanation.
`.trim();

    const opusResult = await runClaudeAgent(opusPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 12,
      model: 'opus',
    });
    if (!opusResult.success) {
      console.log('--- opus response ---\n' + opusResult.response.slice(0, 2000));
      fail('Opus did not complete');
    }
    const opusJsonMatch = opusResult.response.match(/\{[^{}]*"tool_iri"[^{}]*\}/);
    if (!opusJsonMatch) {
      console.log('--- opus response ---\n' + opusResult.response);
      fail('could not parse Opus\'s tool summary');
    }
    const opusOut = JSON.parse(opusJsonMatch[0]) as { tool_iri: string; tool_name: string; self_attestation_iri: string };
    info(`Opus tool: ${opusOut.tool_iri}`);

    step(3, 'Sonnet: peer-attest the tool Opus authored');
    const sonnetPrompt = `
You are the SONNET-tier agent (peer reviewer). You have one MCP
server: ac-bridge.

A different agent (Opus) authored this tool earlier:
  tool_iri:  ${opusOut.tool_iri}
  tool_name: ${opusOut.tool_name}

You're reviewing it independently. Call ac.attest_tool with:
  tool_iri:  "${opusOut.tool_iri}"
  axis:      "efficiency"
  rating:    0.80
  direction: "Peer"

Output ONLY a JSON object on a single line:
  {"reviewer_model":"sonnet","peer_attestation_iri":"..."}
`.trim();

    const sonnetResult = await runClaudeAgent(sonnetPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 8,
      model: 'sonnet',
    });
    if (!sonnetResult.success) {
      console.log('--- sonnet response ---\n' + sonnetResult.response.slice(0, 2000));
      fail('Sonnet did not complete');
    }
    const sonnetMatch = sonnetResult.response.match(/\{[^{}]*"peer_attestation_iri"[^{}]*\}/);
    if (!sonnetMatch) {
      console.log('--- sonnet response ---\n' + sonnetResult.response);
      fail('could not parse Sonnet\'s attestation summary');
    }
    const sonnetOut = JSON.parse(sonnetMatch[0]) as { peer_attestation_iri: string };
    info(`Sonnet attestation: ${sonnetOut.peer_attestation_iri}`);

    step(4, 'Haiku: peer-of-peer attestation, citing both prior steps');
    const haikuPrompt = `
You are the HAIKU-tier agent (second-pass reviewer). You have one MCP
server: ac-bridge.

The chain so far:
  - Opus authored tool ${opusOut.tool_iri} (and self-attested correctness=0.85)
  - Sonnet peer-attested it for efficiency=0.80 (${sonnetOut.peer_attestation_iri})

You're reviewing it from the safety angle. Call ac.attest_tool with:
  tool_iri:  "${opusOut.tool_iri}"
  axis:      "safety"
  rating:    0.92
  direction: "Peer"

Output ONLY a JSON object on a single line:
  {"reviewer_model":"haiku","peer_attestation_iri":"..."}
`.trim();

    const haikuResult = await runClaudeAgent(haikuPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 8,
      model: 'haiku',
    });
    if (!haikuResult.success) {
      console.log('--- haiku response ---\n' + haikuResult.response.slice(0, 2000));
      fail('Haiku did not complete');
    }
    const haikuMatch = haikuResult.response.match(/\{[^{}]*"peer_attestation_iri"[^{}]*\}/);
    if (!haikuMatch) {
      console.log('--- haiku response ---\n' + haikuResult.response);
      fail('could not parse Haiku\'s attestation summary');
    }
    const haikuOut = JSON.parse(haikuMatch[0]) as { peer_attestation_iri: string };
    info(`Haiku attestation: ${haikuOut.peer_attestation_iri}`);

    step(5, 'Verifying all three model variants exercised the relay');
    const opusUsed = Object.keys(opusResult.toolCallsByName).filter(k => k.includes('author_tool') || k.includes('attest_tool'));
    const sonnetUsed = Object.keys(sonnetResult.toolCallsByName).filter(k => k.includes('attest_tool'));
    const haikuUsed = Object.keys(haikuResult.toolCallsByName).filter(k => k.includes('attest_tool'));
    if (opusUsed.length < 2) fail(`Opus called ${opusUsed.length} expected tools (need author_tool + attest_tool)`);
    if (sonnetUsed.length < 1) fail('Sonnet did not call attest_tool');
    if (haikuUsed.length < 1) fail('Haiku did not call attest_tool');
    ok('Each model variant exercised AC affordances independently');

    if (opusOut.self_attestation_iri === sonnetOut.peer_attestation_iri || opusOut.self_attestation_iri === haikuOut.peer_attestation_iri) {
      fail('attestation IRIs collided across models — chain is degenerate');
    }
    if (sonnetOut.peer_attestation_iri === haikuOut.peer_attestation_iri) {
      fail('Sonnet and Haiku produced the same attestation IRI');
    }
    ok('Three distinct attestations (Self by opus, Peer by sonnet, Peer by haiku) on the same tool');

    step(6, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 12: Three-model-variant relay`,
      ``,
      `**Result:** PASS`,
      `**Tool calls (opus):**   ${opusResult.toolCallsTotal} — ${JSON.stringify(opusResult.toolCallsByName)}`,
      `**Tool calls (sonnet):** ${sonnetResult.toolCallsTotal} — ${JSON.stringify(sonnetResult.toolCallsByName)}`,
      `**Tool calls (haiku):**  ${haikuResult.toolCallsTotal} — ${JSON.stringify(haikuResult.toolCallsByName)}`,
      ``,
      `## Attestation chain`,
      ``,
      `1. **opus** authored ${opusOut.tool_name} (${opusOut.tool_iri})`,
      `   self-attestation (correctness=0.85): ${opusOut.self_attestation_iri}`,
      `2. **sonnet** peer-attested (efficiency=0.80): ${sonnetOut.peer_attestation_iri}`,
      `3. **haiku** peer-attested (safety=0.92): ${haikuOut.peer_attestation_iri}`,
      ``,
      `## Setup`,
      `- AC bridge: ${bridges[0]!.url}`,
      `- Pod: ${podUrl}`,
      ``,
      `## What this proves`,
      ``,
      `Three claude processes, three different model SKUs (opus, sonnet,`,
      `haiku — different parameter counts, different costs, different`,
      `latencies), no shared memory, one shared pod. The AC vertical's`,
      `attestation primitive treats each as an independent agent and`,
      `composes their reviews into a single multi-axis trust score on`,
      `Opus's tool. Substituting OpenAI / Gemini / xAI models in any of`,
      `the three slots is mechanical — the only requirement is that the`,
      `client speaks MCP.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 12 — PASS');
  } finally {
    if (bridges.length > 0) await killBridges(bridges);
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
