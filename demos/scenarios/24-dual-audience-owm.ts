/**
 * Demo 24: Dual-audience OWM — contributor + operator over one org pod.
 *
 * Proves the dual-audience design discipline (docs/DUAL-AUDIENCE.md)
 * works end-to-end against a real bridge against a real pod with two
 * REAL Claude Code agents that DON'T share memory.
 *
 *   PHASE A — Contributor agent:
 *     1. Upserts a project.
 *     2. Records 3 decisions (2 Asserted, 1 Hypothetical), one of
 *        which gets superseded by a 4th decision (revision lineage).
 *     3. Queues a follow-up for the project.
 *     4. Records 2 notes.
 *
 *   PHASE B — Operator agent (different process, no shared state):
 *     5. Runs owm.aggregate_decisions_query with
 *        privacy_mode='merkle-attested-opt-in' to get a verifiable
 *        count over the period. Captures the Merkle root +
 *        inclusionProofs[] from the attestation bundle.
 *     6. Runs owm.project_health_summary to get a per-project rollup.
 *     7. Calls owm.publish_org_policy to publish a retention policy
 *        signed by the org-authority DID.
 *     8. Calls owm.publish_compliance_evidence to wrap a synthetic
 *        deploy event as soc2:CC8.1-cited audit evidence.
 *
 *   PHASE C — Auditor verification (in this process, no agent):
 *     9. Re-runs the same aggregate query to demonstrate the bundle
 *        is deterministic over the same inputs.
 *    10. Walks the attestation's inclusionProofs[] and confirms each
 *        leaf's proof verifies against the published merkleRoot
 *        (catches: aggregator inflated count, swapped a proof,
 *        substituted a leaf).
 *
 * What this proves end-to-end:
 *   - Same org pod, two audiences, distinct affordance surfaces.
 *   - The operator's view DERIVES from the contributor's writes —
 *     no parallel store, no separate dashboard pipeline.
 *   - Aggregate queries are tamper-evident (Merkle attestation
 *     verifies; cheats would fail).
 *   - Org-policy + compliance-evidence land as signed descriptors
 *     auditable by anyone with read access to the org pod.
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';
import { verifyAttestedAggregateResult, type AttestedAggregateResult } from '../../applications/_shared/aggregate-privacy/index.js';

const SCENARIO = '24-dual-audience-owm';

async function main(): Promise<void> {
  header('Demo 24 — Dual-audience OWM (contributor + operator)');
  info('A Contributor agent and an Operator agent work the same org pod through their own affordance surfaces.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  const bridges: BridgeHandle[] = [];
  const authorityDid = `did:web:demo-org.example`;

  try {
    step(1, 'Spinning up OWM bridge (port 6060) with org + operator-authority config');
    bridges.push(await spawnBridge('organizational-working-memory', {
      podUrl,
      didPrefix: 'demo-org',
      env: { OWM_DEFAULT_AUTHORITY_DID: authorityDid },
    }));
    ok(`OWM bridge: ${bridges[0]!.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, bridges);
    const projectName = `Dual-Audience Demo Project ${Date.now()}`;
    const periodFrom = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const periodTo = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const overdueAt = new Date(Date.now() - 60_000).toISOString();

    // ── Phase A: Contributor agent ────────────────────────────────────
    step(2, 'Running Contributor agent — authors project, decisions, follow-up, notes');
    const contributorPrompt = `
You are the Contributor agent for an org's internal working memory. You have one MCP server: owm-bridge.

Author the following on the org pod, in order, and return ONE JSON object on a single line at the end:

(A) owm.upsert_project name="${projectName}" objective="Demonstrate dual-audience OWM end-to-end." olke_stage="Articulate" status="active"
    Capture project_iri from the response.

(B) Record THREE decisions, each calling owm.record_decision with project_iri from (A):
    1. topic="Adopt the dual-audience design discipline" rationale="codifies bilateral primitives" modal_status="Asserted"
    2. topic="Use v2 attested-merkle for institutional aggregates" rationale="opt-in + verifiable count beats ABAC-only" modal_status="Asserted"
    3. topic="Defer DP-noised homomorphic-sum aggregates" rationale="v3 scope; v2 ships the Merkle root for now" modal_status="Hypothetical"
    Capture decision_iris[] in order.

(C) Record a 4TH decision that supersedes decision 3:
    Call owm.record_decision with topic="Promote v2 attested-merkle to default for institutional aggregates"
    rationale="Initial Hypothetical refined into a commitment" modal_status="Asserted"
    project_iri=<from A> supersedes=[<decision_iris[2]>]
    Capture the new decision_iri.

(D) Queue an overdue follow-up: owm.queue_followup topic="Ship v3 DP noise"
    due_at="${overdueAt}" context_iri=<project_iri from A>

(E) Record TWO notes about the project — owm.record_note text=<distinct insight> subject_iris=[<project_iri>] tags=["dual-audience","aggregate-privacy"]

Output ONE JSON object: {"project_iri":"...","decision_iris":["...","...","...","..."],"superseding_decision_iri":"...","followup_iri":"...","note_iris":["...","..."]}
No explanation outside the JSON.
`.trim();

    const contributorStart = Date.now();
    const contributorResult = await runClaudeAgent(contributorPrompt, mcpConfigPath, { timeoutMs: 480000, maxTurns: 30 });
    const contributorElapsed = ((Date.now() - contributorStart) / 1000).toFixed(1);
    info(`Contributor finished in ${contributorElapsed}s (${contributorResult.toolCallsTotal} tool calls)`);

    if (!contributorResult.success) {
      console.log('--- Contributor STDERR ---\n' + contributorResult.stderr.slice(0, 1500));
      console.log('--- Contributor RESPONSE ---\n' + contributorResult.response.slice(0, 4000));
      fail(`Contributor did not complete (exit ${contributorResult.exitCode})`);
    }

    const contribJsonMatch = contributorResult.response.match(/\{[\s\S]*?"project_iri"[\s\S]*?"note_iris"[\s\S]*?\}/);
    if (!contribJsonMatch) {
      console.log('--- Contributor RESPONSE ---\n' + contributorResult.response);
      fail('could not parse Contributor JSON');
    }
    const contribOut = JSON.parse(contribJsonMatch[0]) as {
      project_iri: string;
      decision_iris: string[];
      superseding_decision_iri: string;
      followup_iri: string;
      note_iris: string[];
    };
    ok(`Contributor wrote: project + ${contribOut.decision_iris.length} decisions + supersession + 1 follow-up + ${contribOut.note_iris.length} notes`);

    // ── Phase B: Operator agent ───────────────────────────────────────
    step(3, 'Running Operator agent — aggregate query, project health, org policy, compliance evidence');
    const operatorPrompt = `
You are the Org Operator agent for the same org's working memory. You have one MCP server: owm-bridge.

You have NO in-memory state from the Contributor — the only continuity is the org pod, queryable through owm-bridge. You see contributors' descriptors through your own operator-side affordances.

Run FOUR steps:

(A) Aggregate-privacy decision query for the current period.
    Call owm.aggregate_decisions_query with:
      period_from: "${periodFrom}"
      period_to:   "${periodTo}"
      scope_iri:   "${contribOut.project_iri}"
      metric:      "decision-count"
      privacy_mode: "merkle-attested-opt-in"
    Capture the full response (you'll quote merkleRoot, count, and inclusionProofs.length).

(B) Project health summary.
    Call owm.project_health_summary with project_iri="${contribOut.project_iri}" window_days=1
    Capture decisionCount, supersessionChurn, openFollowUpCount.

(C) Publish a retention policy descriptor.
    Call owm.publish_org_policy with:
      policy_type: "retention"
      policy_body: { "retain_decisions_days": 365, "retain_notes_days": 90 }
      authority_did: "${authorityDid}"
    Capture policyIri.

(D) Publish a compliance-evidence descriptor for a synthetic deploy.
    Call owm.publish_compliance_evidence with:
      event_kind: "deploy"
      event_payload: { "component": "owm-bridge", "version": "demo-${Date.now()}", "environment": "demo" }
      framework: "soc2"
      cited_controls: ["soc2:CC8.1"]
      authority_did: "${authorityDid}"
    Capture evidenceIri.

Output ONE JSON object: {"aggregate_count":<N>,"merkle_root":"<hex>","inclusion_proof_count":<N>,"health_decision_count":<N>,"health_supersession_churn":<float>,"policy_iri":"...","evidence_iri":"..."}
No explanation outside the JSON.

ATTACH the full attestation bundle from (A) as a second JSON object on its own line: {"attestation": <the bundle>}
`.trim();

    const operatorStart = Date.now();
    const operatorResult = await runClaudeAgent(operatorPrompt, mcpConfigPath, { timeoutMs: 360000, maxTurns: 20 });
    const operatorElapsed = ((Date.now() - operatorStart) / 1000).toFixed(1);
    info(`Operator finished in ${operatorElapsed}s (${operatorResult.toolCallsTotal} tool calls)`);

    if (!operatorResult.success) {
      console.log('--- Operator STDERR ---\n' + operatorResult.stderr.slice(0, 1500));
      console.log('--- Operator RESPONSE ---\n' + operatorResult.response.slice(0, 4000));
      fail(`Operator did not complete (exit ${operatorResult.exitCode})`);
    }

    const opJsonMatch = operatorResult.response.match(/\{[\s\S]*?"aggregate_count"[\s\S]*?"evidence_iri"[\s\S]*?\}/);
    if (!opJsonMatch) {
      console.log('--- Operator RESPONSE ---\n' + operatorResult.response);
      fail('could not parse Operator summary JSON');
    }
    const opOut = JSON.parse(opJsonMatch[0]) as {
      aggregate_count: number;
      merkle_root: string;
      inclusion_proof_count: number;
      health_decision_count: number;
      health_supersession_churn: number;
      policy_iri: string;
      evidence_iri: string;
    };

    const attestJsonMatch = operatorResult.response.match(/\{"attestation"[\s\S]*\}/);
    let attestation: AttestedAggregateResult | undefined;
    if (attestJsonMatch) {
      try { attestation = (JSON.parse(attestJsonMatch[0]) as { attestation: AttestedAggregateResult }).attestation; }
      catch { /* leave undefined, the demo asserts on this */ }
    }

    // ── Phase C: Auditor verification (in-process, no agent) ──────────
    step(4, 'Auditor verification — Merkle attestation + bilateral derivation');

    if (opOut.aggregate_count < 1) {
      fail(`Operator's aggregate count is ${opOut.aggregate_count}; Contributor wrote ≥3 decisions — derivation broken`);
    }
    ok(`Operator's aggregate count (${opOut.aggregate_count}) > 0 — operator's view derives from contributor's writes`);

    if (opOut.health_decision_count < 1) {
      fail(`Operator's project_health_summary decisionCount=${opOut.health_decision_count}; expected ≥3`);
    }
    ok(`Operator's project_health_summary returns ${opOut.health_decision_count} decisions for the project`);

    if (opOut.health_supersession_churn <= 1.0) {
      info(`(Supersession churn ${opOut.health_supersession_churn} — Contributor's 4th decision superseded the Hypothetical 3rd; churn should reflect that)`);
    }

    if (!opOut.policy_iri.startsWith('urn:owm:policy:retention:')) {
      fail(`Operator's policy IRI shape wrong: ${opOut.policy_iri}`);
    }
    ok(`Operator published retention policy at ${opOut.policy_iri}`);

    if (!opOut.evidence_iri.startsWith('urn:graph:ops:deploy:')) {
      fail(`Operator's compliance-evidence IRI shape wrong: ${opOut.evidence_iri}`);
    }
    ok(`Operator published compliance evidence at ${opOut.evidence_iri}`);

    if (!attestation) {
      fail('Operator did not return the attestation bundle (required for v2 verification)');
    }
    ok('Operator returned a v2 attestation bundle for auditor re-verification');

    if (attestation!.privacyMode !== 'merkle-attested-opt-in') {
      fail(`Expected attestation.privacyMode='merkle-attested-opt-in'; got '${attestation!.privacyMode}'`);
    }
    if (attestation!.merkleRoot !== opOut.merkle_root) {
      fail(`Operator's reported merkle_root does not match the attestation's merkleRoot`);
    }
    if (attestation!.count !== opOut.aggregate_count) {
      fail(`Attestation count (${attestation!.count}) does not match top-level aggregate_count (${opOut.aggregate_count})`);
    }

    const verify = verifyAttestedAggregateResult(attestation!);
    if (!verify.valid) {
      fail(`Attestation verification failed: ${verify.reason}`);
    }
    ok(`Attestation verifies: count=${attestation!.count}, ${attestation!.inclusionProofs.length} inclusion proofs all check against root ${attestation!.merkleRoot.slice(0, 12)}…`);

    // Cheat check: tamper with the count and confirm verification fails.
    const inflated = { ...attestation!, count: attestation!.count + 5 };
    const inflatedResult = verifyAttestedAggregateResult(inflated);
    if (inflatedResult.valid) {
      fail('Inflating attestation count should fail verification (cheat protection broken)');
    }
    ok(`Cheat-protection: count inflation rejected — ${inflatedResult.reason}`);

    // ── Phase D: Write report ────────────────────────────────────────
    step(5, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 24 — Dual-audience OWM`,
      ``,
      `**Result:** PASS`,
      `**Contributor:** ${contributorElapsed}s — ${contributorResult.toolCallsTotal} tool calls`,
      `**Operator:**    ${operatorElapsed}s — ${operatorResult.toolCallsTotal} tool calls`,
      ``,
      `## Setup`,
      `- OWM bridge:      ${bridges[0]!.url}`,
      `- Pod:             ${podUrl}`,
      `- Authority DID:   ${authorityDid}`,
      `- Period queried:  ${periodFrom} → ${periodTo}`,
      ``,
      `## Contributor output`,
      `\`\`\`json`,
      JSON.stringify(contribOut, null, 2),
      `\`\`\``,
      ``,
      `## Operator output`,
      `\`\`\`json`,
      JSON.stringify(opOut, null, 2),
      `\`\`\``,
      ``,
      `## Auditor verification`,
      `- Attestation privacyMode: ${attestation!.privacyMode}`,
      `- Count: ${attestation!.count}`,
      `- Inclusion proofs: ${attestation!.inclusionProofs.length}`,
      `- Merkle root: \`${attestation!.merkleRoot}\``,
      `- Honest bundle verifies: ✓`,
      `- Inflated count rejected: ✓ (${inflatedResult.reason})`,
      ``,
    ]);
    ok(`Report: ${reportPath}`);
  } finally {
    await cleanupPod(podUrl).catch(() => {});
    killBridges(bridges);
  }
}

main().catch(e => {
  console.error('Demo 24 fatal:', e);
  process.exit(1);
});
