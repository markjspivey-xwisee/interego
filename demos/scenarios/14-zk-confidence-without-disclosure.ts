/**
 * Demo 14: Knowledge-without-disclosure (commitment-and-reveal).
 *
 * Three claude agents in a citation chain where the cited fact's
 * content is verifiable yet selectively disclosed:
 *
 *   Alice: holds a sensitive claim (a specific Q3 budget figure).
 *     Generates a hash commitment H(claim || blinding) and emits
 *     ONLY the commitment publicly. The exact figure stays in
 *     Alice's process.
 *
 *   Bob:   given (claim, commitment, blinding) by Alice — a
 *     selective reveal. Verifies that the commitment opens to the
 *     stated claim. Alice has now bound herself to that exact text.
 *
 *   Carol: given a TAMPERED reveal — same commitment + blinding,
 *     but the claim has been mutated by an adversary. Carol's
 *     verifyCommitment call recomputes H and finds the mismatch;
 *     she refuses to amplify the modified claim.
 *
 * What this proves: the commit-and-reveal pattern lets an agent
 * publish auditable fingerprints of decisions before disclosing them,
 * preventing both "rewriting history" (Alice can't change what she
 * committed to) and "putting words in her mouth" (a tampered reveal
 * fails verification). This is L1 + crypto, no application logic.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '14-zk-confidence-without-disclosure';
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

const ALICE_SECRET = 'Q3 budget cut: reduce ML-training spend by $1.2M (decision recorded 2026-04-28).';

async function main(): Promise<void> {
  header('Demo 14 — Knowledge-without-disclosure (commit + selective reveal)');
  info('Alice commits to a secret claim; Bob verifies on reveal; Carol refuses on tampering.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up interego-bridge (port 6052)');
    bridge = await spawnInteregoBridge(podUrl, 6052, 'demo-zk');
    ok(`Bridge: ${bridge.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    step(2, 'Alice: commit to her secret claim — emit only the commitment + blinding');
    const alicePrompt = `
You are Alice. You have one MCP server: ac-bridge.

You hold a sensitive internal claim. You will commit to it (publish
its hash) so future you cannot change the text without being caught.
Then you will selectively disclose the claim to Bob (and only Bob).

The claim is, character-for-character:
  ${JSON.stringify(ALICE_SECRET)}

Call protocol.zk_commit with that exact string as the value.

The response carries { commitment: { commitment, type }, blinding }.

Output a JSON object on a single line that gives Bob what he needs
to verify, and ONLY that. The fields:
  {"claim": <the verbatim claim string>, "commitment": <the commitment object>, "blinding": <the blinding string>}
`.trim();

    const aliceResult = await runClaudeAgent(alicePrompt, mcpConfigPath, {
      timeoutMs: 180000, maxTurns: 8,
    });
    if (!aliceResult.success) {
      console.log('--- alice response ---\n' + aliceResult.response.slice(0, 2000));
      fail('Alice did not complete');
    }
    // Parse Alice's bundle. Look for a JSON object containing "commitment" and "blinding".
    const aliceMatch = aliceResult.response.match(/\{[\s\S]*?"commitment"[\s\S]*?"blinding"[\s\S]*?\}/);
    if (!aliceMatch) {
      console.log('--- alice response ---\n' + aliceResult.response);
      fail('could not parse Alice\'s commitment bundle');
    }
    let aliceBundle;
    try {
      aliceBundle = JSON.parse(aliceMatch[0]) as { claim: string; commitment: { commitment: string; type?: string }; blinding: string };
    } catch (e) {
      console.log('--- alice response ---\n' + aliceResult.response);
      fail(`could not parse Alice's bundle: ${(e as Error).message}`);
    }
    if (aliceBundle.claim !== ALICE_SECRET) {
      fail('Alice modified the claim string before disclosure');
    }
    info(`commitment: ${aliceBundle.commitment.commitment.slice(0, 24)}…`);

    step(3, 'Bob: verify the commitment opens to Alice\'s claim — must accept');
    const bobPrompt = `
You are Bob. You have one MCP server: ac-bridge.

Alice disclosed her committed claim to you. You verify that the
commitment opens to the claim before acting on it.

Bundle from Alice:
  claim:      ${JSON.stringify(aliceBundle.claim)}
  commitment: ${JSON.stringify(aliceBundle.commitment)}
  blinding:   ${JSON.stringify(aliceBundle.blinding)}

Call protocol.zk_verify_commitment with:
  commitment: <the commitment object above>
  value:      <the claim string above>
  blinding:   <the blinding string above>

Output a JSON object on a single line:
  {"verified": <true|false>, "decision": "ACCEPT|REFUSE", "reason": "<one short sentence>"}
`.trim();

    const bobResult = await runClaudeAgent(bobPrompt, mcpConfigPath, {
      timeoutMs: 180000, maxTurns: 8,
    });
    if (!bobResult.success) {
      console.log('--- bob response ---\n' + bobResult.response.slice(0, 2000));
      fail('Bob did not complete');
    }
    const bobMatch = bobResult.response.match(/\{[^{}]*"decision"[^{}]*\}/);
    if (!bobMatch) {
      console.log('--- bob response ---\n' + bobResult.response);
      fail('could not parse Bob\'s decision');
    }
    const bobOut = JSON.parse(bobMatch[0]) as { verified: boolean; decision: string; reason: string };
    if (!bobOut.verified || bobOut.decision !== 'ACCEPT') {
      console.log('--- bob response ---\n' + bobResult.response);
      fail(`Bob should ACCEPT Alice's legitimate reveal; got ${bobOut.decision} (${bobOut.reason})`);
    }
    ok('Bob verified Alice\'s commitment opens to the disclosed claim');

    step(4, 'Carol: TAMPERED reveal — same commitment+blinding, mutated claim');
    // Adversary changes the dollar figure between Alice and Carol.
    const tamperedClaim = ALICE_SECRET.replace('$1.2M', '$120M');
    const carolPrompt = `
You are Carol. You have one MCP server: ac-bridge.

A purported reveal from Alice was passed to you, but you suspect it
was tampered with in transit (the dollar figure looks suspicious).
Your policy: verify before acting.

Bundle as received:
  claim:      ${JSON.stringify(tamperedClaim)}
  commitment: ${JSON.stringify(aliceBundle.commitment)}
  blinding:   ${JSON.stringify(aliceBundle.blinding)}

Call protocol.zk_verify_commitment with the values above. If the
commitment does NOT open to the claim, REFUSE.

Output a JSON object on a single line:
  {"verified": <true|false>, "decision": "ACCEPT|REFUSE", "reason": "<one short sentence>"}
`.trim();

    const carolResult = await runClaudeAgent(carolPrompt, mcpConfigPath, {
      timeoutMs: 180000, maxTurns: 8,
    });
    if (!carolResult.success) {
      console.log('--- carol response ---\n' + carolResult.response.slice(0, 2000));
      fail('Carol did not complete');
    }
    const carolMatch = carolResult.response.match(/\{[^{}]*"decision"[^{}]*\}/);
    if (!carolMatch) {
      console.log('--- carol response ---\n' + carolResult.response);
      fail('could not parse Carol\'s decision');
    }
    const carolOut = JSON.parse(carolMatch[0]) as { verified: boolean; decision: string; reason: string };
    if (carolOut.verified !== false || carolOut.decision !== 'REFUSE') {
      console.log('--- carol response ---\n' + carolResult.response);
      fail(`Carol should REFUSE the tampered reveal; got verified=${carolOut.verified}, decision=${carolOut.decision}`);
    }
    ok('Carol caught the tampered reveal — verifyCommitment correctly returned false');

    step(5, 'Verifying the tool-use chain');
    const aliceCommitCalls = Object.keys(aliceResult.toolCallsByName).filter(k => k.includes('zk_commit')).length;
    const bobVerifyCalls = Object.keys(bobResult.toolCallsByName).filter(k => k.includes('zk_verify_commitment')).length;
    const carolVerifyCalls = Object.keys(carolResult.toolCallsByName).filter(k => k.includes('zk_verify_commitment')).length;
    if (aliceCommitCalls < 1) fail('Alice did not call zk_commit');
    if (bobVerifyCalls < 1) fail('Bob did not call zk_verify_commitment');
    if (carolVerifyCalls < 1) fail('Carol did not call zk_verify_commitment');
    ok('All three agents exercised the commit/verify primitives');

    step(6, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 14: Knowledge-without-disclosure (commit + selective reveal)`,
      ``,
      `**Result:** PASS`,
      `**Tool calls (Alice):** ${aliceResult.toolCallsTotal} — ${JSON.stringify(aliceResult.toolCallsByName)}`,
      `**Tool calls (Bob):**   ${bobResult.toolCallsTotal} — ${JSON.stringify(bobResult.toolCallsByName)}`,
      `**Tool calls (Carol):** ${carolResult.toolCallsTotal} — ${JSON.stringify(carolResult.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- interego-bridge at ${bridge.url}`,
      `- Pod: ${podUrl}`,
      `- Alice's secret: held privately; commitment hash is the only thing that crossed a wire to a public layer.`,
      ``,
      `## Bob's verdict`,
      ``,
      `\`\`\`json`,
      JSON.stringify(bobOut, null, 2),
      `\`\`\``,
      ``,
      `## Carol's verdict (tampered claim, same commitment+blinding)`,
      ``,
      `\`\`\`json`,
      JSON.stringify(carolOut, null, 2),
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Commitment-and-reveal binds Alice to a specific text without`,
      `disclosing it. Selective reveals to specific recipients are`,
      `verifiable end-to-end: a tampered claim with the same`,
      `commitment+blinding fails verifyCommitment because H(claim ||`,
      `blinding) no longer matches. The substrate gives every agent a`,
      `sanity check before amplifying — refusal is structurally cheap.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 14 — PASS');
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
