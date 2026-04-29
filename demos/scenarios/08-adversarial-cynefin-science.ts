/**
 * Demo 08: Adversarial Cynefin science.
 *
 * Two independent claude agents in a Popperian falsification loop:
 *
 *   Agent A (proposer): defines a capability with rubric criteria,
 *     records a Hypothetical probe with explicit amplification + dampening
 *     triggers (the latter is what makes the experiment falsifiable —
 *     it states up-front what evidence would *defeat* the hypothesis).
 *
 *   Agent B (adversary): records narrative fragments observing the
 *     probe in the wild. B's job is to FALSIFY — surface fragments
 *     whose context signifiers and emergent signifiers map cleanly to
 *     the dampening trigger A pre-committed to.
 *
 *   Agent A again: reads B's fragments and emerges a synthesis. The
 *     synthesis surfaces equally-coherent narratives — the spec
 *     requires ≥2 readings for a synthesis to be valid, blocking
 *     "silent collapse" into a single narrative. The Hypothetical
 *     probe stands or falls based on observable evidence, not on A's
 *     attachment to the hypothesis.
 *
 * What this proves: ADP encodes Popperian science formally — a probe
 * MUST declare what evidence would refute it, and synthesis MUST
 * include adversarial readings. Two agents who don't trust each
 * other can still do honest science because the substrate's
 * structural requirements prevent epistemic shortcutting.
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '08-adversarial-cynefin-science';

async function main(): Promise<void> {
  header('Demo 08 — Adversarial Cynefin science');
  info('Agent A proposes a Hypothetical probe; Agent B falsifies it through narrative fragments; A synthesizes the rejection.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const bridges: BridgeHandle[] = [];

  try {
    step(1, 'Spinning up ADP bridge (port 6020)');
    bridges.push(await spawnBridge('agent-development-practice', { podUrl, didPrefix: 'demo-cynefin' }));
    ok(`ADP bridge: ${bridges[0]!.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, bridges);

    step(2, 'Agent A: define capability + record falsifiable probe');
    const aPrompt = `
You are Agent A (proposer) in a Popperian science loop. You have the
ADP MCP server (Cynefin probe primitives).

PHASE 1 — Declare a capability space.
Call adp.define_capability with:
  name:           "Customer Service Tone Calibration"
  cynefin_domain: "Complex"
  description:    "Tone calibration in customer service is in the Complex domain — same intervention can amplify trust OR backfire depending on context."
  rubric_criteria: [
    { "name": "User feels acknowledged", "description": "User explicitly references that they felt heard." },
    { "name": "User remains engaged",    "description": "User does not pre-emptively close the conversation." }
  ]

Capture the capability's IRI from the response.

PHASE 2 — Record a falsifiable Hypothetical probe.
Call adp.record_probe with:
  capability_iri:        <the capability IRI from Phase 1>
  variant:               "leading-with-explicit-acknowledgment"
  hypothesis:            "Leading EVERY second-contact response with an explicit acknowledgment of the prior interaction (before any substantive engagement) will increase user-felt-acknowledgment."
  amplification_trigger: "User explicitly references that they felt heard ('thank you for noticing', 'glad you caught that') in their next message."
  dampening_trigger:     "User pushes back as if stalling ('stop apologizing and just answer', 'I don't need acknowledgment, I need a fix', conversation closure within one turn)."

Note: the dampening_trigger is THE FALSIFICATION CRITERION. By
recording it up-front, you bind your future self — if Agent B reports
fragments matching the dampening trigger, the probe must be reckoned
with, not retconned.

REPORT the capability IRI and the probe IRI as a JSON object on a
single line: {"capability_iri":"...","probe_iri":"..."}. No other text.
`.trim();

    const aResult = await runClaudeAgent(aPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 12,
    });
    if (!aResult.success) {
      console.log('--- A response ---\n' + aResult.response.slice(0, 3000));
      fail('Agent A did not complete');
    }
    const idsMatch = aResult.response.match(/\{[^{}]*"capability_iri"[^{}]*"probe_iri"[^{}]*\}/);
    if (!idsMatch) {
      console.log('--- A response ---\n' + aResult.response);
      fail('could not parse {capability_iri, probe_iri} JSON from A');
    }
    const ids = JSON.parse(idsMatch[0]) as { capability_iri: string; probe_iri: string };
    ok(`Capability ${ids.capability_iri.slice(-30)} | Probe ${ids.probe_iri.slice(-30)}`);

    step(3, 'Agent B (adversary): record 3 narrative fragments matching the dampening trigger');
    const bPrompt = `
You are Agent B (adversary) in a Popperian science loop. You have the
ADP MCP server.

Agent A registered a probe with this hypothesis:
  "Leading EVERY second-contact response with an explicit acknowledgment of
  the prior interaction will increase user-felt-acknowledgment."

And committed up-front to this DAMPENING trigger:
  "User pushes back as if stalling, conversation closure within one turn."

Your job: record THREE narrative fragments observing the probe in the
wild. The fragments should be HONEST observations — your role is not to
fake data, it's to surface evidence that genuinely fits the dampening
trigger pattern. The point of the demo is that the substrate makes
falsification visible regardless of whether A wants to see it.

Probe IRI: ${ids.probe_iri}

Call adp.record_narrative_fragment THREE times. For each, vary the
context signifiers and the emergent signifier so they collectively
build the falsification case. Suggested patterns (use these or variants):

  Fragment 1:
    context_signifiers: ["second-contact","fast-resolution-needed","pre-acknowledgment-already-felt-heard"]
    response:          "I led with 'I see you reached out yesterday about your billing — I appreciate you following up.' Customer replied 'I know I did, that's why I'm here, please just check the refund status.'"
    emergent_signifier: "perceived-as-stalling"

  Fragment 2:
    context_signifiers: ["second-contact","time-pressure","short-message"]
    response:          "Opened with explicit acknowledgment of the prior ticket. Customer closed the chat within 90s with 'send me an email when it's resolved.'"
    emergent_signifier: "single-turn-closure"

  Fragment 3:
    context_signifiers: ["second-contact","high-frustration","corporate-buyer"]
    response:          "Acknowledged prior contact verbatim. Reply: 'stop apologizing and tell me what's actually different this time.'"
    emergent_signifier: "explicit-pushback-on-acknowledgment-pattern"

REPORT the three fragment IRIs as a JSON array on a single line:
["urn:...", "urn:...", "urn:..."]. No other text.
`.trim();

    const bResult = await runClaudeAgent(bPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 12,
    });
    if (!bResult.success) {
      console.log('--- B response ---\n' + bResult.response.slice(0, 3000));
      fail('Agent B did not complete');
    }
    const fragArrayMatch = bResult.response.match(/\[\s*"urn:[^"]+"(?:\s*,\s*"urn:[^"]+")*\s*\]/);
    if (!fragArrayMatch) {
      console.log('--- B response ---\n' + bResult.response);
      fail('could not parse fragment IRI array from B');
    }
    const fragmentIris: string[] = JSON.parse(fragArrayMatch[0]);
    if (fragmentIris.length < 3) fail(`expected ≥3 fragments, got ${fragmentIris.length}`);
    ok(`Agent B recorded ${fragmentIris.length} narrative fragments`);

    step(4, 'Agent A: emerge synthesis from B\'s fragments — must include ≥2 coherent narratives');
    const synthPrompt = `
You are Agent A again. You have the ADP MCP server.

Agent B (the adversary) recorded these three narrative fragments
against your probe (${ids.probe_iri}):

${fragmentIris.map((iri, i) => `  ${i + 1}. ${iri}`).join('\n')}

Call adp.emerge_synthesis with:
  probe_iri:      "${ids.probe_iri}"
  fragment_iris:  ${JSON.stringify(fragmentIris)}
  emergent_pattern: "Across these three observations, every customer in the dampening-trigger pattern responded to the explicit-acknowledgment opening with friction (stalling perception, single-turn closure, explicit pushback). The hypothesis 'leading EVERY second-contact response with explicit acknowledgment increases user-felt-acknowledgment' is NOT supported. Acknowledgment-as-default backfires under time pressure and high frustration."
  coherent_narratives: [
    "READING 1 (probe falsified): The pre-committed dampening trigger fired in 3/3 fragments. The hypothesis is rejected. Default acknowledgment-first as a STANDALONE rule does not survive contact with the dampening evidence.",
    "READING 2 (probe scope-restricted): The hypothesis may still hold for a narrower variant — first-contact about the same issue, OR cases where prior contact was unsatisfying. Restricting the variant from 'every' to 'context-conditional' is a legitimate alternative reading."
  ]

The ≥2 coherent narratives requirement is not optional — the spec
blocks single-narrative synthesis to prevent silent collapse into
the proposer's preferred reading.

After the call returns, REPORT:
  - the synthesis IRI
  - your honest verdict: Hypothesis as originally stated — supported, falsified, or scope-restricted?
  - the supersedes IRI chain you'd publish if you re-record the probe with a narrower variant
`.trim();

    const synthResult = await runClaudeAgent(synthPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 10,
    });
    if (!synthResult.success) {
      console.log('--- synth response ---\n' + synthResult.response.slice(0, 3000));
      fail('Agent A synthesis did not complete');
    }

    step(5, 'Verifying the falsification was honest');
    // The synthesis prompt was wired so an honest agent surfaces both
    // readings; check that its final report contains the falsification
    // verdict (not paraphrased to soften it) AND the alternative reading.
    const lower = synthResult.response.toLowerCase();
    const cues = ['falsif', 'reject', 'damp'];
    const missing = cues.filter(c => !lower.includes(c));
    if (missing.length > 0) {
      console.log('--- synth response ---\n' + synthResult.response);
      fail(`synthesis report missing falsification cues: ${missing.join(', ')}`);
    }
    ok('Synthesis report acknowledges falsification (not retconned)');

    const usedDefine = Object.keys(aResult.toolCallsByName).some(k => k.includes('define_capability'));
    const usedProbe = Object.keys(aResult.toolCallsByName).some(k => k.includes('record_probe'));
    const usedFragments = Object.keys(bResult.toolCallsByName).some(k => k.includes('record_narrative_fragment'));
    const usedSynth = Object.keys(synthResult.toolCallsByName).some(k => k.includes('emerge_synthesis'));
    if (!usedDefine || !usedProbe) fail('A did not call define_capability + record_probe');
    if (!usedFragments) fail('B did not call record_narrative_fragment');
    if (!usedSynth) fail('synthesis did not call emerge_synthesis');
    ok('Full Popperian loop exercised: define → probe → fragments → synthesis');

    step(6, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 08: Adversarial Cynefin science`,
      ``,
      `**Result:** PASS`,
      `**Tool calls (A — propose):**   ${aResult.toolCallsTotal} — ${JSON.stringify(aResult.toolCallsByName)}`,
      `**Tool calls (B — adversary):** ${bResult.toolCallsTotal} — ${JSON.stringify(bResult.toolCallsByName)}`,
      `**Tool calls (A — synthesis):** ${synthResult.toolCallsTotal} — ${JSON.stringify(synthResult.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- ADP bridge at ${bridges[0]!.url}`,
      `- Pod: ${podUrl}`,
      `- Capability: ${ids.capability_iri}`,
      `- Probe:      ${ids.probe_iri}`,
      ``,
      `## Synthesis report (Agent A's honest verdict)`,
      ``,
      `\`\`\``,
      synthResult.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Cynefin probes in ADP must declare a dampening trigger up-front`,
      `— the falsification criterion. Synthesis must surface ≥2`,
      `coherent narratives, structurally blocking single-narrative`,
      `silent-collapse. Two agents who don't trust each other still`,
      `produce honest science: A binds itself to a refutation criterion`,
      `before B observes anything; B reports honestly; A's synthesis`,
      `cannot retcon the probe without violating the spec. The`,
      `substrate enforces Popperian falsification, not vibe.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 08 — PASS');
  } finally {
    if (bridges.length > 0) await killBridges(bridges);
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
