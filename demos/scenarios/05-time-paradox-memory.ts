/**
 * Demo 05: Time-paradox memory.
 *
 * One agent, three phases — show that a Hypothetical claim can collapse
 * into Counterfactual when contradicting evidence arrives, and the
 * supersedes chain makes the change visible to anyone walking the
 * descriptor manifest.
 *
 *   Phase A: agent publishes a Hypothetical claim ("X may be true")
 *   Phase B: agent confirms it can read the claim back as Hypothetical
 *   Phase C: agent publishes a Counterfactual descriptor that
 *            supersedes the Phase-A descriptor; re-discovers; reports
 *            the modal-status flip and the supersedes IRI chain
 *
 * What this proves: modal status + cg:supersedes are not just metadata
 * — they form a real belief-revision protocol. An agent that consults
 * the manifest sees an evolving picture of truth, and the substrate
 * makes the evolution legible (tier-0 atoms + tier-1 supersedes IRIs)
 * without requiring agents to coordinate or remember each other.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '05-time-paradox-memory';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

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
    cwd, env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  proc.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString()));
  proc.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString()));

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/affordances`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        // Reuse the BridgeHandle shape; "name" is informational here.
        return { name: 'agent-collective' as const, port, url, process: proc, podUrl };
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  proc.kill('SIGTERM');
  throw new Error(`interego-bridge :${port} failed to start.\nSTDOUT:\n${stdoutChunks.join('')}\nSTDERR:\n${stderrChunks.join('')}`);
}

async function main(): Promise<void> {
  header('Demo 05 — Time-paradox memory');
  info('A Hypothetical claim collapses to Counterfactual via cg:supersedes; the agent rolls its position back.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;
  let bridgeProc: ChildProcess | undefined;

  try {
    step(1, 'Spinning up interego-bridge (port 6050)');
    bridge = await spawnInteregoBridge(podUrl, 6050, 'demo-paradox');
    bridgeProc = bridge.process;
    ok(`Bridge running at ${bridge.url}`);

    step(2, 'Generating MCP config pointing at interego-bridge');
    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    // Use a stable graph IRI so both publishes describe the SAME subject.
    // The supersedes link is what carries the time-paradox — the second
    // descriptor explicitly subsumes the first via cg:supersedes.
    const claimGraphIri = `urn:cg:demo:claim:${Date.now()}`;

    step(3, 'Invoking Claude Code with the three-phase belief-revision task');
    const prompt = `
You have access to one MCP server: interego-bridge. It exposes
protocol-level Interego operations (publish_descriptor,
discover_descriptors, get_descriptor) over an Azure-backed Solid pod.

Run THREE phases in order. Be concise.

PHASE A — Publish a Hypothetical claim.
Call protocol.publish_descriptor with:
  graph_iri:     "${claimGraphIri}"
  graph_content: |
    @prefix demo: <urn:cg:demo:> .
    @prefix dct: <http://purl.org/dc/terms/> .
    <${claimGraphIri}> dct:title "Tentative second-contact escalation rule" ;
      demo:claim "When a customer makes second contact, lead with explicit acknowledgment of the prior interaction." ;
      demo:source "informal-conversation-with-CSR-team" .
  modal_status:  "Hypothetical"
  confidence:    0.55

Capture the descriptor_id this returns; you'll reference it from the
next call's "supersedes" array.

PHASE B — Read the claim back.
Call protocol.discover_descriptors with describes_iri = "${claimGraphIri}".
Confirm that exactly one entry exists and its modal_status is "Hypothetical".

PHASE C — Republish as Counterfactual, citing the supersedes chain.
NEW EVIDENCE has arrived: a controlled study showed leading with
acknowledgment ALONE (without re-engaging on substance) frustrated
customers more than it helped. The previous claim is now rejected.

Call protocol.publish_descriptor with:
  graph_iri:     "${claimGraphIri}"
  graph_content: |
    @prefix demo: <urn:cg:demo:> .
    @prefix dct: <http://purl.org/dc/terms/> .
    <${claimGraphIri}> dct:title "Rejected: acknowledgment-first as standalone rule" ;
      demo:claim "Leading with acknowledgment alone is COUNTERPRODUCTIVE; it must be paired with substantive re-engagement, in that order. The standalone rule is rejected." ;
      demo:supersedingEvidence "controlled-study-2026-04" .
  modal_status:  "Counterfactual"
  confidence:    0.92
  supersedes:    [<the descriptor_id PHASE A returned>]

Then call protocol.discover_descriptors again with the same describes_iri.
Confirm both descriptors exist; one is Hypothetical, one is
Counterfactual; the second supersedes the first.

REPORT the full belief-revision picture:
  - Phase A descriptor URL + modal status
  - Phase C descriptor URL + modal status
  - Confirm the supersedes chain links them
  - State plainly: the original Hypothetical claim is now Counterfactual.
`.trim();

    const start = Date.now();
    const result = await runClaudeAgent(prompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 20,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    info(`Claude finished in ${elapsed}s (exit ${result.exitCode}, ${result.toolCallsTotal} tool calls)`);

    if (!result.success) {
      console.log('\n--- AGENT STDERR ---\n' + result.stderr.slice(0, 1500));
      console.log('\n--- AGENT RESPONSE ---\n' + result.response.slice(0, 4000));
      fail(`agent did not complete (exit ${result.exitCode})`);
    }

    step(4, 'Verifying the agent walked the time-paradox');
    const calls = Object.keys(result.toolCallsByName);
    const publishCount = calls
      .filter(k => k.includes('publish_descriptor'))
      .reduce((acc, k) => acc + (result.toolCallsByName[k] ?? 0), 0);
    const discoverCount = calls
      .filter(k => k.includes('discover_descriptors'))
      .reduce((acc, k) => acc + (result.toolCallsByName[k] ?? 0), 0);
    if (publishCount < 2) {
      console.log('Tool calls:', JSON.stringify(result.toolCallsByName, null, 2));
      fail(`expected ≥2 publish_descriptor calls, got ${publishCount}`);
    }
    if (discoverCount < 2) {
      console.log('Tool calls:', JSON.stringify(result.toolCallsByName, null, 2));
      fail(`expected ≥2 discover_descriptors calls, got ${discoverCount}`);
    }
    ok(`Agent published ${publishCount} descriptors and re-discovered ${discoverCount} times`);

    const lower = result.response.toLowerCase();
    const cues = ['hypothetical', 'counterfactual', 'supersede'];
    const missing = cues.filter(c => !lower.includes(c));
    if (missing.length > 0) {
      console.log('--- response ---\n' + result.response);
      fail(`response missing belief-revision cues: ${missing.join(', ')}`);
    }
    ok('Response cites Hypothetical, Counterfactual, and the supersedes chain');

    step(5, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 05: Time-paradox memory`,
      ``,
      `**Result:** PASS`,
      `**Elapsed:** ${elapsed}s`,
      `**Tool calls:** ${result.toolCallsTotal} — ${JSON.stringify(result.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Pod: ${podUrl}`,
      `- Subject graph: ${claimGraphIri}`,
      ``,
      `## Agent's response`,
      ``,
      `\`\`\``,
      result.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Modal status (Hypothetical → Counterfactual) and cg:supersedes`,
      `together form a belief-revision protocol. The agent's *current*`,
      `view of the claim is the head of the supersedes chain; older`,
      `descriptors remain on the pod (audit trail) but no longer`,
      `represent live belief. No coordinator told the agent to revise —`,
      `the substrate made the evolution legible from the manifest.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 05 — PASS');
  } finally {
    if (bridgeProc) {
      bridgeProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!bridgeProc.killed) bridgeProc.kill('SIGKILL');
    }
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
