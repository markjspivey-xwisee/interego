/**
 * Demo 06: PGSL pullback of two diaries.
 *
 * Two independent Claude agents — Alice and Bob — each log their
 * memory of the same meeting as PGSL atoms. Atoms are content-
 * addressed: identical input strings produce identical atom IRIs.
 * That property turns the "what did we both remember" operator into
 * pure set intersection at the atom layer — no negotiation, no
 * fuzzy matching, no LLM mediation.
 *
 * Concrete flow:
 *   Alice agent:
 *     - given a list of meeting events she remembers, mints each
 *       as a PGSL atom via protocol.pgsl_mint_atom
 *     - reports the ordered list of atom IRIs back to the harness
 *
 *   Bob agent (independent process, same bridge):
 *     - given a list of events HE remembers (overlapping but not
 *       identical to Alice's), mints each via the same bridge so
 *       atoms with identical content collide on IRI
 *     - given Alice's atom IRIs in the prompt, calls pgsl_meet
 *       and reports the structurally-shared subsequence
 *
 * What this proves: PGSL meet is a categorical pullback, not a
 * heuristic. If both agents witnessed the same event verbatim, both
 * minted the same atom IRI; the meet operator sees them as the same
 * point in the lattice. The "agreement" is structural.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '06-pgsl-pullback-two-diaries';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

// Both agents share ONE interego-bridge so the atom registry is shared.
// Without this, each process has its own lattice and no atoms collide
// — the demo would be vacuous. The whole point is that two agents
// against the same substrate produce identical atom IRIs for identical
// content.
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

// Diary events. Five overlap (the truthful core of the meeting), three
// differ per agent (memory drift / different attention). Whatever both
// recorded VERBATIM produces the same atom IRI; whatever differs by even
// a character produces a different atom.
const ALICE_DIARY = [
  'meeting started 2:00pm with John, Priya, Marcus',
  'John raised the Q3 budget shortfall as primary risk',
  'Priya proposed deferring the retraining project to Q4',
  'Marcus pushed back: retraining cancellation breaks the EU compliance commitment',
  'group agreed to revisit budget with finance before deferring',
  'Marcus seemed unusually quiet during the second half',
  'meeting ended at 3:15pm',
];

const BOB_DIARY = [
  'meeting started 2:00pm with John, Priya, Marcus',
  'John raised the Q3 budget shortfall as primary risk',
  'Priya floated three alternatives for cost reduction',
  'Marcus pushed back: retraining cancellation breaks the EU compliance commitment',
  'group agreed to revisit budget with finance before deferring',
  'I noticed Priya took a phone call at 2:40 and stepped out',
  'meeting ended at 3:15pm',
];

// Expected meet (verbatim matches across both diaries):
const EXPECTED_SHARED = [
  'meeting started 2:00pm with John, Priya, Marcus',
  'John raised the Q3 budget shortfall as primary risk',
  'Marcus pushed back: retraining cancellation breaks the EU compliance commitment',
  'group agreed to revisit budget with finance before deferring',
  'meeting ended at 3:15pm',
];

async function main(): Promise<void> {
  header('Demo 06 — PGSL pullback of two diaries');
  info('Two agents independently mint event atoms; meet computes the structurally-shared subsequence.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let bridge: BridgeHandle | undefined;
  let bridgeProc: ChildProcess | undefined;

  try {
    step(1, 'Spinning up shared interego-bridge (port 6050)');
    bridge = await spawnInteregoBridge(podUrl, 6050, 'demo-pgsl');
    bridgeProc = bridge.process;
    ok(`Bridge running at ${bridge.url}`);

    const mcpConfigPath = writeMcpConfig(`${SCENARIO}-${scenarioId()}`, [bridge]);

    step(2, 'Agent Alice: mint her diary events as PGSL atoms');
    const alicePrompt = `
You are Alice's agent. You have one MCP server: interego-bridge.

Mint each of these meeting events as a PGSL atom by calling
protocol.pgsl_mint_atom (with argument value = the event string,
verbatim — do NOT paraphrase or normalize):

${ALICE_DIARY.map((e, i) => `  ${i + 1}. "${e}"`).join('\n')}

After all 7 mints, output a JSON array of the atom_iri values in
the SAME order as the events above. Format:
  ["urn:pgsl:atom:...", "urn:pgsl:atom:...", ...]

That JSON array is the only thing the next phase needs from you.
`.trim();

    const aliceResult = await runClaudeAgent(alicePrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 20,
    });
    if (!aliceResult.success) {
      console.log('--- Alice STDERR ---\n' + aliceResult.stderr.slice(0, 1500));
      console.log('--- Alice RESPONSE ---\n' + aliceResult.response.slice(0, 3000));
      fail(`Alice did not complete (exit ${aliceResult.exitCode})`);
    }
    info(`Alice tool calls: ${JSON.stringify(aliceResult.toolCallsByName)}`);

    // Extract Alice's atom IRIs from her response. Look for a JSON array
    // of urn:pgsl:atom:... strings.
    const aliceArrayMatch = aliceResult.response.match(/\[[\s\S]*?"urn:pgsl:atom:[\s\S]*?\]/);
    if (!aliceArrayMatch) {
      console.log('--- Alice RESPONSE ---\n' + aliceResult.response);
      fail('could not find JSON array of atom IRIs in Alice\'s response');
    }
    const aliceIris: string[] = JSON.parse(aliceArrayMatch[0]);
    if (aliceIris.length !== ALICE_DIARY.length) {
      fail(`Alice produced ${aliceIris.length} atom IRIs, expected ${ALICE_DIARY.length}`);
    }
    ok(`Alice minted ${aliceIris.length} atoms`);

    step(3, 'Agent Bob: mint his diary events + call pgsl_meet against Alice');
    const bobPrompt = `
You are Bob's agent. You have one MCP server: interego-bridge.

PHASE 1 — Mint each of YOUR meeting events as a PGSL atom by calling
protocol.pgsl_mint_atom (verbatim, no paraphrasing):

${BOB_DIARY.map((e, i) => `  ${i + 1}. "${e}"`).join('\n')}

Collect Bob's atom_iri values in order.

PHASE 2 — Compute the shared subsequence with Alice's diary.
Alice already minted her atoms; her atom IRIs are:
${JSON.stringify(aliceIris, null, 2)}

Call protocol.pgsl_meet with:
  atom_iris_a = Alice's IRIs (the array above)
  atom_iris_b = Bob's IRIs (from your phase-1 mints)

REPORT the response. Specifically:
  - shared_atom_count
  - the verbatim values of the shared atoms (from the response's
    shared_atoms[].value field)
  - a_only_count and b_only_count

Then state in plain English: how many memories did Alice and Bob
agree on, what did they agree on, and what does this say about
"agreement" being structural rather than negotiated.
`.trim();

    const bobResult = await runClaudeAgent(bobPrompt, mcpConfigPath, {
      timeoutMs: 240000, maxTurns: 20,
    });
    if (!bobResult.success) {
      console.log('--- Bob STDERR ---\n' + bobResult.stderr.slice(0, 1500));
      console.log('--- Bob RESPONSE ---\n' + bobResult.response.slice(0, 3000));
      fail(`Bob did not complete (exit ${bobResult.exitCode})`);
    }
    info(`Bob tool calls: ${JSON.stringify(bobResult.toolCallsByName)}`);

    step(4, 'Verifying the meet found exactly the verbatim-overlapping events');
    const respLower = bobResult.response.toLowerCase();
    const expectedFound = EXPECTED_SHARED.filter(e => respLower.includes(e.toLowerCase().slice(0, 30)));
    if (expectedFound.length !== EXPECTED_SHARED.length) {
      console.log('--- Bob RESPONSE ---\n' + bobResult.response);
      fail(`Bob's report should cite all ${EXPECTED_SHARED.length} shared events, found ${expectedFound.length}`);
    }
    ok(`All ${EXPECTED_SHARED.length} expected shared events present in Bob's report`);

    const calls = Object.keys(bobResult.toolCallsByName);
    const usedMeet = calls.some(k => k.includes('pgsl_meet'));
    const mintCount = calls
      .filter(k => k.includes('pgsl_mint_atom'))
      .reduce((acc, k) => acc + (bobResult.toolCallsByName[k] ?? 0), 0);
    if (!usedMeet) fail('Bob did not call pgsl_meet');
    if (mintCount < BOB_DIARY.length) fail(`Bob minted ${mintCount} atoms, expected ${BOB_DIARY.length}`);
    ok(`Bob minted ${mintCount} atoms and called pgsl_meet`);

    step(5, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 06: PGSL pullback of two diaries`,
      ``,
      `**Result:** PASS`,
      `**Tool calls (Alice):** ${aliceResult.toolCallsTotal} — ${JSON.stringify(aliceResult.toolCallsByName)}`,
      `**Tool calls (Bob):**   ${bobResult.toolCallsTotal} — ${JSON.stringify(bobResult.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- Shared interego-bridge: ${bridge.url}`,
      `- Alice diary: ${ALICE_DIARY.length} events`,
      `- Bob diary:   ${BOB_DIARY.length} events`,
      `- Expected verbatim overlap: ${EXPECTED_SHARED.length} events`,
      ``,
      `## Bob's report`,
      ``,
      `\`\`\``,
      bobResult.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Atoms are content-addressed: identical content → identical IRI,`,
      `independent of who minted it or when. Two agents who witnessed`,
      `the same event verbatim produce the SAME atom IRI; pgsl_meet at`,
      `the atom layer is therefore set intersection — not fuzzy match,`,
      `not LLM mediation. "Agreement" between Alice and Bob is`,
      `structural, recoverable from the lattice itself.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 06 — PASS');
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
