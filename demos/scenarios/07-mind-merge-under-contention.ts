/**
 * Demo 07: Mind-merge under contention.
 *
 * Five Claude agents write to the SAME pod's descriptor manifest
 * simultaneously, each contributing a distinct perspective on a
 * shared subject. Without optimistic concurrency control the
 * parallel writes would clobber each other's manifest entries (last
 * writer wins; the rest are silently lost). With HTTP If-Match CAS
 * (the publish() implementation in src/solid/client.ts retries on
 * 412 with jittered backoff), all five writes are durable.
 *
 * Concrete flow:
 *   1. Spin up the interego-bridge (one pod, one manifest)
 *   2. Launch 5 claude processes in parallel via Promise.all, each
 *      with its own MCP config + author DID + perspective
 *   3. Each agent calls protocol.publish_descriptor exactly once
 *   4. Harness queries protocol.discover_descriptors
 *   5. Assert: all 5 descriptors present in the manifest
 *
 * What this proves: Interego's manifest layer is CAS-safe under N-way
 * write contention. The "mind-merge" is the resulting union of
 * perspectives — no descriptor was silently dropped.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '07-mind-merge-under-contention';
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
  proc.kill('SIGTERM');
  throw new Error(`interego-bridge :${port} failed to start`);
}

const PERSPECTIVES = [
  { author: 'tone',     focus: 'tone — the emotional register of the acknowledgment matters more than its content' },
  { author: 'timing',   focus: 'timing — the acknowledgment must precede ANY substantive re-engagement, not be wedged in' },
  { author: 'data',     focus: 'data — controlled trials show explicit acknowledgment lifts CSAT 18-23% vs implicit' },
  { author: 'empathy',  focus: 'empathy — naming the customer\'s frustration by name validates more than generic acknowledgment' },
  { author: 'process',  focus: 'process — log the prior contact ID in the response so the customer feels tracked, not handled' },
];

async function main(): Promise<void> {
  header('Demo 07 — Mind-merge under contention');
  info('Five agents write the SAME pod manifest in parallel; CAS keeps every write durable.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;
  let bridgeProc: ChildProcess | undefined;
  const subjectGraph = `urn:cg:demo:second-contact-escalation:${Date.now()}`;

  try {
    step(1, 'Spinning up interego-bridge (port 6050)');
    bridge = await spawnInteregoBridge(podUrl, 6050, 'demo-merge');
    bridgeProc = bridge.process;
    ok(`Bridge running at ${bridge.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    step(2, `Launching ${PERSPECTIVES.length} claude agents in parallel`);
    const startAll = Date.now();
    const results = await Promise.all(PERSPECTIVES.map(async (p) => {
      const prompt = `
You are agent ${p.author}. You have one MCP server: interego-bridge.

You are writing ONE descriptor about second-contact escalation from a
specific perspective. Your perspective: ${p.focus}.

Call protocol.publish_descriptor EXACTLY ONCE with:
  graph_iri:     "${subjectGraph}"
  graph_content: |
    @prefix demo: <urn:cg:demo:> .
    @prefix dct: <http://purl.org/dc/terms/> .
    <${subjectGraph}> dct:title "Second-contact escalation: ${p.author} perspective" ;
      demo:perspective "${p.author}" ;
      demo:author "did:web:${p.author}.example" ;
      demo:claim ${JSON.stringify(p.focus)} .
  modal_status:  "Asserted"
  confidence:    0.85

After it returns, output ONLY the descriptor_url it returned. One line.
No explanation, no extra text.
`.trim();
      return await runClaudeAgent(prompt, mcpConfigPath, {
        timeoutMs: 240000, maxTurns: 8,
      });
    }));
    const elapsedAll = ((Date.now() - startAll) / 1000).toFixed(1);
    info(`All ${PERSPECTIVES.length} agents finished in ${elapsedAll}s`);

    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
      console.log('--- failed agent stderr ---\n' + failures[0]!.stderr.slice(0, 1500));
      console.log('--- failed agent response ---\n' + failures[0]!.response.slice(0, 2000));
      fail(`${failures.length}/${PERSPECTIVES.length} agents failed`);
    }
    ok(`All ${PERSPECTIVES.length} agents succeeded`);

    const totalToolCalls = results.reduce((sum, r) => sum + r.toolCallsTotal, 0);
    info(`Total tool calls across agents: ${totalToolCalls}`);

    step(3, 'Querying the pod manifest — every parallel write must be durable');
    // Hit the bridge's discover endpoint via a direct MCP call. The
    // bridge re-reads the pod's manifest fresh each time.
    const r = await fetch(`${bridge.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'protocol.discover_descriptors', arguments: { describes_iri: subjectGraph } },
      }),
    });
    const mcp = await r.json() as { result?: { content?: { text?: string }[] } };
    const text = mcp.result?.content?.[0]?.text ?? '[]';
    const entries = JSON.parse(text) as { descriptor_url: string; describes: string[] }[];
    info(`Manifest has ${entries.length} descriptor(s) for ${subjectGraph}`);
    if (entries.length !== PERSPECTIVES.length) {
      console.log('--- entries ---\n' + JSON.stringify(entries, null, 2));
      fail(`expected ${PERSPECTIVES.length} entries; got ${entries.length} — CAS lost a write`);
    }
    ok(`All ${PERSPECTIVES.length} parallel writes survived (zero lost updates)`);

    step(4, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 07: Mind-merge under contention`,
      ``,
      `**Result:** PASS`,
      `**Elapsed:** ${elapsedAll}s for ${PERSPECTIVES.length} parallel agents`,
      `**Tool calls (total across agents):** ${totalToolCalls}`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Subject graph: ${subjectGraph}`,
      `- Agents: ${PERSPECTIVES.map(p => p.author).join(', ')}`,
      ``,
      `## Manifest after contention`,
      ``,
      `\`\`\`json`,
      JSON.stringify(entries.map(e => ({ url: e.descriptor_url, describes: e.describes })), null, 2),
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Five claude processes hit the SAME pod's manifest concurrently;`,
      `every write is preserved. The HTTP If-Match guard in publish()`,
      `(retry-on-412 with jittered backoff, ~5 attempts) turns N-way`,
      `write contention into N successive durable writes. The "merge"`,
      `is the union of perspectives the manifest now holds — no`,
      `coordinator, no lock, no lost descriptor.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 07 — PASS');
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
