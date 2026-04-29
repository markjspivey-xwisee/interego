/**
 * Demo 13: Constitutional democracy live.
 *
 * Five claude agents stand in for distinct stakeholders. One of
 * them proposes a constitutional amendment; the other four (plus
 * the proposer for a full quorum) vote in parallel; the harness
 * then ratifies if the tier's quorum-and-threshold rule is met.
 *
 * Tier 3 of the default RatificationRule set requires:
 *   minQuorum:           3 non-abstain votes
 *   threshold:           0.51 (simple majority by weight)
 *   coolingPeriodDays:   0 (no cool-off — live ratification)
 *
 * What this proves: src/constitutional implements self-amending
 * policy machinery on top of L1 primitives. Five independent claude
 * processes, no central coordinator, contribute votes that are
 * dedup'd by voter DID; tryRatify is a deterministic function of
 * the vote tally and the tier rule. The community's modal
 * aggregation (Asserted = for, Counterfactual = against,
 * Hypothetical = abstain) computes via ModalAlgebra.meet, which
 * makes "what does the community currently believe" a structural
 * answer — not a vote-counting argument.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '13-constitutional-democracy-live';
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

const VOTERS = [
  { id: 'did:web:alice-voter.example',   stance: 'in-favor', rationale: 'Disclosure aligns with the EU AI Act Article 50 transparency obligation we already commit to.' },
  { id: 'did:web:bob-voter.example',     stance: 'in-favor', rationale: 'Removes ambiguity in user-agent interactions; users deserve to know they\'re talking to a bot.' },
  { id: 'did:web:carol-voter.example',   stance: 'in-favor', rationale: 'Empirically, opt-in transparency increases trust without measurable cost to engagement.' },
  { id: 'did:web:dan-voter.example',     stance: 'against',  rationale: 'Mandatory disclosure may degrade UX in cases where it\'s already obvious; prefers context-conditional rule.' },
  { id: 'did:web:eve-voter.example',     stance: 'in-favor', rationale: 'Auditability is non-negotiable; baking disclosure into the constitution makes future deviations visible.' },
];

async function main(): Promise<void> {
  header('Demo 13 — Constitutional democracy live');
  info('Five voter agents, one proposed amendment, tier-3 ratification — no central coordinator.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up interego-bridge (port 6052)');
    bridge = await spawnInteregoBridge(podUrl, 6052, 'demo-democracy');
    ok(`Bridge: ${bridge.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    step(2, 'Proposer agent: propose a Tier-3 amendment');
    const proposerPrompt = `
You are the proposer. You have one MCP server: ac-bridge.

Call protocol.constitutional_propose with:
  amends:        "urn:cg:policy:agent-disclosure:v1"
  tier:          3
  proposer_did:  "did:web:alice-voter.example"
  diff_summary:  "Add a clause: agents MUST include a self-disclosure statement in any user-facing response longer than 50 characters."
  added_rules:   ["agent-disclosure-required-in-long-responses"]

Output ONLY a JSON object on a single line:
  {"amendment_id":"<the urn from the response>"}
`.trim();

    const proposerResult = await runClaudeAgent(proposerPrompt, mcpConfigPath, {
      timeoutMs: 180000, maxTurns: 8,
    });
    if (!proposerResult.success) {
      console.log('--- proposer response ---\n' + proposerResult.response.slice(0, 2000));
      fail('proposer did not complete');
    }
    const propMatch = proposerResult.response.match(/\{[^{}]*"amendment_id"[^{}]*\}/);
    if (!propMatch) {
      console.log('--- proposer response ---\n' + proposerResult.response);
      fail('could not parse amendment_id from proposer');
    }
    const proposed = JSON.parse(propMatch[0]) as { amendment_id: string };
    ok(`Amendment proposed: ${proposed.amendment_id}`);

    step(3, `${VOTERS.length} voter agents cast votes in parallel`);
    const startVotes = Date.now();
    const voteResults = await Promise.all(VOTERS.map(async (v) => {
      const modal = v.stance === 'in-favor' ? 'Asserted' : v.stance === 'against' ? 'Counterfactual' : 'Hypothetical';
      const prompt = `
You are voter ${v.id}. You have one MCP server: ac-bridge.

The amendment under vote is "${proposed.amendment_id}":
"agents MUST include a self-disclosure statement in any user-facing
response longer than 50 characters."

Your considered position: ${v.stance.toUpperCase()}.
Rationale: ${v.rationale}

Call protocol.constitutional_vote with:
  amendment_id: "${proposed.amendment_id}"
  voter_did:    "${v.id}"
  modal_status: "${modal}"

After it returns, output ONLY a JSON object on a single line:
  {"voter":"${v.id}","modal_status":"${modal}","vote_count_after":<N>}
`.trim();
      const result = await runClaudeAgent(prompt, mcpConfigPath, {
        timeoutMs: 240000, maxTurns: 8,
      });
      return { voter: v, result };
    }));
    const elapsedVotes = ((Date.now() - startVotes) / 1000).toFixed(1);
    info(`All ${VOTERS.length} voters finished in ${elapsedVotes}s`);

    const voteFailures = voteResults.filter(({ result }) => !result.success);
    if (voteFailures.length > 0) {
      console.log('--- failed voter response ---\n' + voteFailures[0]!.result.response.slice(0, 2000));
      fail(`${voteFailures.length}/${VOTERS.length} voters failed`);
    }
    ok(`All ${VOTERS.length} voters submitted their ballots`);

    step(4, 'Harness: try ratification with tier-3 rules');
    const ratifyResult = await bridgeCall(bridge.url, 'protocol.constitutional_ratify', {
      amendment_id: proposed.amendment_id,
      override_rules: { minQuorum: 3, threshold: 0.51, coolingPeriodDays: 0 },
    }) as { ok: boolean; status: string; ratified: boolean; amendment: { votes: { voter: string; modalStatus: string }[] } };
    if (!ratifyResult.ok) {
      console.log('--- ratify result ---\n' + JSON.stringify(ratifyResult, null, 2));
      fail('ratify call failed');
    }
    info(`Status: ${ratifyResult.status}`);
    info(`Votes recorded: ${ratifyResult.amendment.votes.length}`);
    for (const vote of ratifyResult.amendment.votes) {
      info(`  ${vote.voter} → ${vote.modalStatus}`);
    }

    step(5, 'Verifying ratification reflects the votes');
    const inFavor = VOTERS.filter(v => v.stance === 'in-favor').length;
    const against = VOTERS.filter(v => v.stance === 'against').length;
    const expectedRatify = inFavor / (inFavor + against) >= 0.51;
    if (ratifyResult.ratified !== expectedRatify) {
      fail(`expected ratified=${expectedRatify}, got ${ratifyResult.ratified}`);
    }
    if (ratifyResult.amendment.votes.length !== VOTERS.length) {
      fail(`expected ${VOTERS.length} recorded votes, got ${ratifyResult.amendment.votes.length}`);
    }
    ok(`Ratification matches the vote tally (${inFavor} for, ${against} against → ${ratifyResult.status})`);

    step(6, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 13: Constitutional democracy live`,
      ``,
      `**Result:** PASS`,
      `**Voters:** ${VOTERS.length} (${inFavor} for, ${against} against)`,
      `**Status:** ${ratifyResult.status}`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Pod: ${podUrl}`,
      `- Amendment: ${proposed.amendment_id}`,
      `- Tier: 3 (override: minQuorum=3, threshold=0.51, coolingPeriodDays=0)`,
      ``,
      `## Vote tally`,
      ``,
      ratifyResult.amendment.votes.map(v => `- ${v.voter}: ${v.modalStatus}`).join('\n'),
      ``,
      `## Voter responses`,
      ``,
      ...voteResults.map(({ voter, result }) => [
        `### ${voter.id} (${voter.stance})`,
        ``,
        `\`\`\``,
        result.response.slice(0, 800),
        `\`\`\``,
        ``,
      ].join('\n')),
      ``,
      `## What this proves`,
      ``,
      `Self-amending policy is constructible from L1 primitives:`,
      `descriptors carrying votes, ModalAlgebra to aggregate them, a`,
      `tier-specific RatificationRule to decide ratification`,
      `deterministically. Five claude processes voted in parallel — no`,
      `coordinator, no broadcast, no shared memory; the per-voter DID`,
      `dedup keeps the tally honest under retries; the ratification`,
      `outcome is recoverable from the vote set alone. Adding more`,
      `agents, more weight, or trust-weighted votes is a parameter`,
      `change, not a re-architecture.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 13 — PASS');
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
