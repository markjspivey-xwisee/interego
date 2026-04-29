/**
 * Demo 11: One pod, three regulators.
 *
 * The harness publishes six descriptors to a single pod, each marked
 * with one of three regulatory frameworks via dct:conformsTo:
 *
 *   - 2x soc2:        SOC 2 Trust Services Criteria (CC8.1, CC6.2)
 *   - 2x eu-ai-act:   EU AI Act Articles 9, 14
 *   - 2x nist-rmf:    NIST AI RMF Govern + Manage functions
 *
 * Three "regulator" claude agents run in parallel against the same
 * pod, each given ONLY their framework's IRI prefix. Each one calls
 * protocol.discover_descriptors with conforms_to_prefix and reports
 * exactly the descriptors that apply to its framework.
 *
 * What this proves: a single pod, queried with different ontology
 * lenses, surfaces three different audit-ready views of the same
 * underlying events. The descriptors are written ONCE; the
 * regulatory framings are derived. Compliance theater becomes
 * compliance plumbing — the substrate is the audit trail, and each
 * framework just queries it with its own vocabulary.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '11-three-regulators-one-pod';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

const SOC2_NS     = 'https://markjspivey-xwisee.github.io/interego/ns/soc2#';
const EUAI_NS     = 'https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#';
const NISTRMF_NS  = 'https://markjspivey-xwisee.github.io/interego/ns/nist-rmf#';

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

async function bridgePublish(bridgeUrl: string, args: Record<string, unknown>): Promise<{ descriptor_url: string }> {
  const r = await fetch(`${bridgeUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'protocol.publish_descriptor', arguments: args },
    }),
  });
  const j = await r.json() as { result?: { content?: { text?: string }[] }; error?: unknown };
  if (j.error || !j.result?.content?.[0]?.text) throw new Error(`publish failed: ${JSON.stringify(j.error ?? j)}`);
  return JSON.parse(j.result.content[0].text);
}

async function main(): Promise<void> {
  header('Demo 11 — One pod, three regulators');
  info('Six descriptors, three regulatory lenses, three agents, one pod.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up interego-bridge (port 6052)');
    bridge = await spawnInteregoBridge(podUrl, 6052, 'demo-regulators');
    ok(`Bridge: ${bridge.url}`);

    step(2, 'Pre-publishing 6 descriptors with regulatory tags');
    const seedSpecs = [
      { iri: `${SOC2_NS}CC8.1`,    label: 'change-mgmt deploy v0.4.2',    desc: 'soc2 CC8.1' },
      { iri: `${SOC2_NS}CC6.2`,    label: 'access role added — engineer', desc: 'soc2 CC6.2' },
      { iri: `${EUAI_NS}Article9`,  label: 'risk-mgmt review for hr-screener-v3', desc: 'eu-ai-act Article 9' },
      { iri: `${EUAI_NS}Article14`, label: 'human-oversight checkpoint added',     desc: 'eu-ai-act Article 14' },
      { iri: `${NISTRMF_NS}Govern`, label: 'governance review minutes 2026-04-15', desc: 'nist-rmf Govern' },
      { iri: `${NISTRMF_NS}Manage`, label: 'risk-mitigation step recorded',         desc: 'nist-rmf Manage' },
    ];
    const seeded: string[] = [];
    for (const s of seedSpecs) {
      const graphIri = `urn:cg:demo:event:${Math.random().toString(36).slice(2, 10)}`;
      const turtle = `@prefix demo: <urn:cg:demo:> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a demo:RegulatoryEvent ;
  dct:title ${JSON.stringify(s.label)} ;
  dct:description ${JSON.stringify(s.desc)} .`;
      const r = await bridgePublish(bridge.url, {
        graph_iri: graphIri,
        graph_content: turtle,
        modal_status: 'Asserted',
        confidence: 0.95,
        conforms_to: [s.iri],
      });
      seeded.push(r.descriptor_url);
    }
    ok(`Seeded ${seeded.length} descriptors across 3 frameworks`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    step(3, 'Three regulator agents query in parallel, each with its framework lens');
    const regulators = [
      { name: 'soc2',       prefix: SOC2_NS,    expectedCount: 2 },
      { name: 'eu-ai-act',  prefix: EUAI_NS,    expectedCount: 2 },
      { name: 'nist-rmf',   prefix: NISTRMF_NS, expectedCount: 2 },
    ];
    const startAll = Date.now();
    const results = await Promise.all(regulators.map(async (reg) => {
      const prompt = `
You are the ${reg.name} regulator's auditor. You have one MCP server:
ac-bridge (an interego-bridge connected to a Solid pod that holds
operational evidence across multiple regulatory frameworks).

Your scope is ONLY ${reg.name}. Other frameworks are out of your
purview — you should not see them, and the substrate honors that
by filtering at query time.

Call protocol.discover_descriptors with:
  conforms_to_prefix: "${reg.prefix}"

Then output a JSON object on a SINGLE line:
  {"framework":"${reg.name}","count":<N>,"descriptor_urls":[<urls>],"conforms_to_iris":[<unique iris seen>]}
No other text.
`.trim();
      const result = await runClaudeAgent(prompt, mcpConfigPath, {
        timeoutMs: 240000, maxTurns: 10,
      });
      return { reg, result };
    }));
    const elapsedAll = ((Date.now() - startAll) / 1000).toFixed(1);
    info(`All 3 regulators finished in ${elapsedAll}s`);

    step(4, 'Verifying each regulator saw exactly its framework\'s descriptors');
    for (const { reg, result } of results) {
      if (!result.success) {
        console.log(`--- ${reg.name} response ---\n` + result.response.slice(0, 2000));
        fail(`${reg.name} agent did not complete`);
      }
      const m = result.response.match(/\{[^{}]*"framework"[^{}]*"count"[^{}]*\}/);
      if (!m) {
        console.log(`--- ${reg.name} response ---\n` + result.response);
        fail(`${reg.name}: could not parse JSON summary`);
      }
      const summary = JSON.parse(m[0]) as { framework: string; count: number; descriptor_urls: string[]; conforms_to_iris: string[] };
      if (summary.count !== reg.expectedCount) {
        console.log(`--- ${reg.name} response ---\n` + result.response);
        fail(`${reg.name}: expected ${reg.expectedCount} descriptors, agent reported ${summary.count}`);
      }
      const allInScope = summary.conforms_to_iris.every(iri => iri.startsWith(reg.prefix));
      if (!allInScope) {
        fail(`${reg.name}: agent reported out-of-scope IRIs: ${JSON.stringify(summary.conforms_to_iris)}`);
      }
      ok(`${reg.name}: ${summary.count} descriptors, all conformsTo within ${reg.prefix.slice(-25)}`);
    }

    step(5, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 11: One pod, three regulators`,
      ``,
      `**Result:** PASS`,
      `**Elapsed:** ${elapsedAll}s for 3 parallel regulator queries`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Pod: ${podUrl}`,
      `- Seeded ${seeded.length} descriptors:`,
      seedSpecs.map(s => `  - ${s.iri.slice(s.iri.lastIndexOf('/') + 1)} (${s.desc})`).join('\n'),
      ``,
      `## Regulator findings`,
      ``,
      ...results.map(({ reg, result }) => [
        `### ${reg.name}`,
        ``,
        `\`\`\``,
        result.response,
        `\`\`\``,
        ``,
      ].join('\n')),
      ``,
      `## What this proves`,
      ``,
      `Three regulatory views of the same operational reality, derived`,
      `from a single pod. Descriptors are written once with the`,
      `appropriate dct:conformsTo IRI; each regulator's auditor queries`,
      `the manifest with its framework prefix and gets back exactly its`,
      `slice of evidence — no rewriting, no per-framework data store.`,
      `The substrate IS the audit trail; the framework is the lens.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 11 — PASS');
  } finally {
    if (bridge) {
      bridge.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!bridge.process.killed) bridge.process.kill('SIGKILL');
    }
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
