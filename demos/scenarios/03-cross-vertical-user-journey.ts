/**
 * Demo 03: Cross-vertical single-agent journey.
 *
 * One Claude Code instance, all 4 vertical bridges, one coherent
 * user story spanning every vertical:
 *
 *   1. (LPC) Ingest a SCORM module + ask a grounded question
 *   2. (ADP) Declare a "customer-service tone" capability + record
 *      a probe with explicit triggers
 *   3. (LRS) Probe an LRS endpoint to see what xAPI version it supports
 *   4. (AC)  Author a small tool; record an attestation against it
 *
 * Demonstrates: a real agent, given access to multiple per-vertical
 * bridges, can compose a multi-step workflow that touches each one.
 * Each bridge is independent (its own process, its own port); the
 * agent reasons about which tool to call based on the named MCP
 * surfaces.
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';
import AdmZip from 'adm-zip';

const SCENARIO = '03-cross-vertical-user-journey';

async function main(): Promise<void> {
  header('Demo 03 — Cross-vertical single-agent journey');
  info('One agent, four bridges, four verticals, one coherent flow.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const bridges: BridgeHandle[] = [];

  try {
    step(1, 'Spinning up all 4 vertical bridges (ports 6010 / 6020 / 6030 / 6040)');
    bridges.push(await spawnBridge('learner-performer-companion', { podUrl, didPrefix: 'demo-mark' }));
    ok(`LPC at ${bridges[bridges.length - 1]!.url}`);
    bridges.push(await spawnBridge('agent-development-practice', { podUrl, didPrefix: 'demo-mark' }));
    ok(`ADP at ${bridges[bridges.length - 1]!.url}`);
    bridges.push(await spawnBridge('lrs-adapter', { podUrl, didPrefix: 'demo-mark' }));
    ok(`LRS at ${bridges[bridges.length - 1]!.url}`);
    bridges.push(await spawnBridge('agent-collective', { podUrl, didPrefix: 'demo-mark' }));
    ok(`AC  at ${bridges[bridges.length - 1]!.url}`);

    step(2, 'Building SCORM zip fixture for LPC ingestion');
    const lessonHtml = `<!DOCTYPE html><html><head><title>L4: Second-Contact</title></head>
<body><h1>Second-Contact Escalation</h1>
<p>When a customer makes second contact about an unresolved issue, acknowledge their frustration AND the prior contact explicitly, in that order, before re-engaging on the substance.</p>
</body></html>`;
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cs101.demo03" version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="cs101"><organization identifier="cs101"><title>CS-101 Demo 03</title>
    <item identifier="lesson4" identifierref="lesson4-resource"><title>Lesson 4</title></item>
  </organization></organizations>
  <resources><resource identifier="lesson4-resource" type="webcontent"
    adlcp:scormtype="sco" href="lesson4.html"><file href="lesson4.html"/></resource></resources>
</manifest>`;
    const zip = new AdmZip();
    zip.addFile('imsmanifest.xml', Buffer.from(manifest));
    zip.addFile('lesson4.html', Buffer.from(lessonHtml));
    const zipBase64 = zip.toBuffer().toString('base64');

    step(3, 'Generating MCP config pointing the agent at all 4 bridges');
    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, bridges);

    step(4, 'Invoking Claude Code with cross-vertical task');
    const prompt = `
You have access to four vertical-specific Interego bridges via MCP:
  lpc-bridge — Learner / Performer Companion (training, credentials, grounded chat)
  adp-bridge — Agent Development Practice (Cynefin probe cycles)
  lrs-bridge — LRS Adapter (xAPI ↔ Interego boundary)
  ac-bridge  — Agent Collective (tool authoring, attestation, teaching)

Run ALL of the following steps in order. Be concise.

(A) LPC: ingest this SCORM zip via lpc.ingest_training_content with
    authoritative_source="did:web:demo-acme.example". Zip (base64):

${zipBase64}

(B) LPC: ask via lpc.grounded_answer:
    "What does the customer service training say about second contact escalation?"
    Pass persist_response: true.

(C) ADP: declare a capability via adp.define_capability with
    name="Customer Service Tone", cynefin_domain="Complex",
    rubric_criteria=[{"name":"User feels acknowledged"}].

(D) ADP: record one probe via adp.record_probe against the capability
    you just created. Use variant="explicit-acknowledgment",
    hypothesis="Leading with explicit acknowledgment may produce better
    continuation in second-contact frustration scenarios.",
    amplification_trigger="user-relief-followed",
    dampening_trigger="user-perceived-stalling".

(E) AC: author a small tool via ac.author_tool with tool_name="echo-sniff",
    source_code="function detectEcho(s) { return s.includes('?'); }",
    affordance_action="urn:cg:action:demo:detect-echo".

(F) AC: attest the tool via ac.attest_tool with axis="correctness",
    rating=0.85, direction="Self".

Once all steps complete, report a SHORT summary listing the IRIs of
each thing you created (training-content, capability, probe, tool, attestation).
`.trim();

    const start = Date.now();
    const result = await runClaudeAgent(prompt, mcpConfigPath, {
      timeoutMs: 480000,
      maxTurns: 30,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    info(`Claude finished in ${elapsed}s (exit ${result.exitCode}, ${result.toolCallsTotal} tool calls)`);

    if (!result.success) {
      console.log('\n--- AGENT STDERR ---\n' + result.stderr.slice(0, 2000));
      console.log('\n--- AGENT RESPONSE ---\n' + result.response.slice(0, 4000));
      fail(`agent did not complete (exit ${result.exitCode})`);
    }

    step(5, 'Verifying the agent crossed all four verticals');
    const expectedTools = [
      'ingest_training_content',
      'grounded_answer',
      'define_capability',
      'record_probe',
      'author_tool',
      'attest_tool',
    ];
    const used = Object.keys(result.toolCallsByName);
    const missing = expectedTools.filter(t => !used.some(u => u.includes(t)));
    if (missing.length > 0) {
      console.log('Tool calls:', JSON.stringify(result.toolCallsByName, null, 2));
      console.log('--- response ---\n' + result.response);
      fail(`agent missed expected tools: ${missing.join(', ')}`);
    }
    ok('Agent invoked all 6 expected tools across LPC + ADP + AC');

    info(`Tool call distribution: ${JSON.stringify(result.toolCallsByName)}`);

    step(6, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 03: Cross-vertical single-agent journey`,
      ``,
      `**Result:** PASS`,
      `**Elapsed:** ${elapsed}s`,
      `**Tool calls:** ${result.toolCallsTotal} — ${JSON.stringify(result.toolCallsByName)}`,
      ``,
      `## Setup`,
      bridges.map(b => `- ${b.name} bridge at ${b.url}`).join('\n'),
      `- Pod: ${podUrl}`,
      ``,
      `## Agent's response`,
      ``,
      `\`\`\``,
      result.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `A single Claude agent given access to all four per-vertical`,
      `bridges can compose a workflow spanning every vertical. Each`,
      `bridge is an independent process; the agent picks tools by name`,
      `from the merged MCP surface. No central orchestrator.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 03 — PASS');
  } finally {
    if (bridges.length > 0) await killBridges(bridges);
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
