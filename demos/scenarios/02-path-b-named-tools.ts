/**
 * Demo 02: Path B — opinionated named-MCP-tool surface.
 *
 * Same answer as Demo 01, but the agent uses the per-vertical bridge's
 * named MCP tools (lpc.ingest_training_content, lpc.grounded_answer)
 * directly. Demonstrates the ergonomic accelerant for clients that
 * prefer named tools over affordance walking.
 *
 * Both paths invoke the same publishers underneath. Single source of
 * truth (the affordance declarations); two surfaces (HTTP per
 * hydra:target / named MCP tools).
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';
import AdmZip from 'adm-zip';

const SCENARIO = '02-path-b-named-tools';

async function main(): Promise<void> {
  header('Demo 02 — Path B: opinionated named MCP tools');
  info('Same outcome as Demo 01 via named lpc.* MCP tools.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const bridges: BridgeHandle[] = [];

  try {
    step(1, 'Spinning up LPC bridge (port 6010)');
    const lpc = await spawnBridge('learner-performer-companion', {
      podUrl, didPrefix: 'demo-mark',
    });
    bridges.push(lpc);
    ok(`Bridge running at ${lpc.url}`);

    step(2, 'Building SCORM zip fixture for the agent to ingest');
    const lessonHtml = `<!DOCTYPE html>
<html>
<head><title>Lesson 4: Second-Contact Escalation</title></head>
<body>
<h1>Second-Contact Escalation</h1>
<p>When a customer makes second contact about an unresolved issue,
acknowledge their frustration AND the prior contact explicitly,
in that order, before re-engaging on the substance.</p>
</body></html>`;
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.demo02" version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="cs101"><organization identifier="cs101">
    <title>CS-101 Demo 02</title>
    <item identifier="lesson4" identifierref="lesson4-resource">
      <title>Lesson 4</title>
    </item>
  </organization></organizations>
  <resources>
    <resource identifier="lesson4-resource" type="webcontent"
      adlcp:scormtype="sco" href="lesson4.html">
      <file href="lesson4.html"/>
    </resource>
  </resources>
</manifest>`;
    const zip = new AdmZip();
    zip.addFile('imsmanifest.xml', Buffer.from(manifest));
    zip.addFile('lesson4.html', Buffer.from(lessonHtml));
    const zipBase64 = zip.toBuffer().toString('base64');
    info(`Fixture: ${zipBase64.length} bytes of base64`);

    step(3, 'Generating MCP config pointing at the LPC bridge');
    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [lpc]);

    step(4, 'Invoking Claude Code CLI WITH lpc-bridge MCP tools available');
    const prompt = `
You are an agent operating against an Interego deployment via MCP.
The lpc-bridge MCP server provides tools for the learner-performer-
companion vertical.

Your task — chain TWO MCP tool calls:

1. Ingest this SCORM zip into the user's pod via lpc.ingest_training_content.
   The zip (base64-encoded) is:

${zipBase64}

   Pass this as the zip_base64 argument. Use authoritative_source =
   "did:web:demo-acme.example".

2. Then ask the user's grounded knowledge a question via
   lpc.grounded_answer:

   "What does the customer service training say about second contact escalation?"

   Use persist_response: true (default).

Report the cited answer back. Use the named MCP tools — do NOT make
HTTP requests directly. Be concise.
`.trim();

    const start = Date.now();
    const result = await runClaudeAgent(prompt, mcpConfigPath, {
      timeoutMs: 240000,
      maxTurns: 15,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    info(`Claude finished in ${elapsed}s (exit ${result.exitCode}, ${result.toolCallsTotal} tool calls)`);

    if (!result.success) {
      console.log('\n--- AGENT STDERR ---\n' + result.stderr);
      console.log('\n--- AGENT RESPONSE ---\n' + result.response);
      fail(`agent did not complete successfully (exit ${result.exitCode})`);
    }

    step(5, 'Verifying the agent used named MCP tools (Path B)');
    const usedIngest = Object.keys(result.toolCallsByName).some(t => t.includes('ingest_training_content'));
    const usedGrounded = Object.keys(result.toolCallsByName).some(t => t.includes('grounded_answer'));

    if (!usedIngest) {
      console.log('Tool calls:', result.toolCallsByName);
      console.log('\n--- AGENT RESPONSE ---\n' + result.response.slice(0, 4000));
      console.log('\n--- AGENT STDERR ---\n' + result.stderr.slice(0, 2000));
      fail('agent did not call ingest_training_content via MCP');
    }
    ok('Agent called the ingest_training_content MCP tool');

    if (!usedGrounded) {
      console.log('Tool calls:', result.toolCallsByName);
      fail('agent did not call grounded_answer via MCP');
    }
    ok('Agent called the grounded_answer MCP tool');

    info(`Tool calls: ${JSON.stringify(result.toolCallsByName)}`);

    step(6, 'Verifying citation correctness');
    const phrases = ['second contact', 'acknowledge', 'frustration'];
    const allFound = phrases.every(p => result.response.toLowerCase().includes(p));
    if (!allFound) {
      console.log('--- response ---\n' + result.response);
      fail(`response missing verbatim phrases (looking for ${phrases.join(', ')})`);
    }
    ok('Response contains verbatim phrases from the seeded content');

    step(7, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 02: Path B — opinionated named MCP tools`,
      ``,
      `**Result:** PASS`,
      `**Elapsed:** ${elapsed}s`,
      `**Tool calls:** ${result.toolCallsTotal} — ${JSON.stringify(result.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- LPC bridge at ${lpc.url}`,
      `- Pod: ${podUrl}`,
      ``,
      `## Agent's response`,
      ``,
      `\`\`\``,
      result.response,
      `\`\`\``,
      ``,
      `## Verification`,
      `- ✓ Agent used lpc.ingest_training_content MCP tool`,
      `- ✓ Agent used lpc.grounded_answer MCP tool`,
      `- ✓ Response contains verbatim phrases from source`,
      ``,
      `## Compared to Demo 01 (Path A)`,
      ``,
      `Same end result, faster + simpler agent code. Path B trades`,
      `architectural purity for ergonomics. The bridge derives MCP tool`,
      `schemas from the same affordance declarations Path A walks — single`,
      `source of truth.`,
    ].join('\n'));

    ok(`Report: ${reportPath}`);

    header('Demo 02 — PASS');
  } finally {
    if (bridges.length > 0) await killBridges(bridges);
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
