/**
 * Demo 09: Cryptographic citation chain refusal.
 *
 * Two agents in a citation chain:
 *
 *   Alice: publishes a Trust-facet claim and produces a secp256k1
 *     signature over the canonical claim string. The bridge's
 *     wallet is the signer.
 *
 *   Bob: is asked to act on a *cited* claim — given (claim, signature,
 *     expected_signer). Bob calls protocol.verify_signature once per
 *     citation and refuses to act on any whose signature does not
 *     verify against the expected signer.
 *
 *   The harness gives Bob THREE versions of the claim:
 *     1. The legitimate (claim, signature) pair    → Bob accepts
 *     2. Tampered claim, original signature        → Bob refuses
 *     3. Original claim, signature replaced        → Bob refuses
 *
 * What this proves: Interego's signature primitives let a recipient
 * agent enforce citation integrity end-to-end. An agent that walks
 * a provenance chain and verifies each link refuses to amplify
 * unsigned or tampered claims, with no trust authority required —
 * pure cryptography.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  cleanupPod, uniquePodUrl,
  writeMcpConfig, runClaudeAgent,
  header, step, ok, info, fail, scenarioId, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';

const SCENARIO = '09-citation-chain-refusal';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

// Stable test key (matches Anvil account[0]; used widely in repo tests).
const ALICE_WALLET_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ALICE_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

async function spawnInteregoBridge(podUrl: string, port: number, didPrefix: string, walletKey?: string): Promise<BridgeHandle> {
  const cwd = join(REPO_ROOT, 'demos', 'interego-bridge');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_DEPLOYMENT_URL: `http://localhost:${port}`,
    INTEREGO_DEFAULT_POD_URL: podUrl,
    INTEREGO_DEFAULT_AGENT_DID: `did:web:${didPrefix}.example`,
    NODE_NO_WARNINGS: '1',
  };
  if (walletKey) env.BRIDGE_WALLET_KEY = walletKey;

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

async function main(): Promise<void> {
  header('Demo 09 — Cryptographic citation chain refusal');
  info('Bob refuses to amplify any cited claim whose signature does not verify against Alice\'s key.');

  const podUrl = uniquePodUrl(`demo-${SCENARIO}`);
  let aliceBridge: BridgeHandle | undefined;
  let bobBridge: BridgeHandle | undefined;

  try {
    step(1, 'Spinning up Alice\'s interego-bridge (port 6052, with wallet)');
    aliceBridge = await spawnInteregoBridge(podUrl, 6052, 'alice-citation', ALICE_WALLET_KEY);
    ok(`Alice bridge: ${aliceBridge.url} (signer ${ALICE_ADDRESS})`);

    step(2, 'Spinning up Bob\'s interego-bridge (port 6053, no wallet — verifier only)');
    bobBridge = await spawnInteregoBridge(podUrl, 6053, 'bob-citation');
    ok(`Bob bridge: ${bobBridge.url}`);

    const aliceMcp = writeMcpConfig(`${SCENARIO}-alice-${scenarioId()}`, [aliceBridge]);
    const bobMcp = writeMcpConfig(`${SCENARIO}-bob-${scenarioId()}`, [bobBridge]);

    const claim = 'Q3 budget shortfall is $1.2M; reduce ML-training spend by 18% (decision recorded 2026-04-28).';

    step(3, 'Agent Alice: sign the canonical claim');
    const alicePrompt = `
You are Alice's agent. You have one MCP server: ac-bridge.

The canonical claim you must sign is, character-for-character:

${JSON.stringify(claim)}

Call protocol.sign_message with that exact string as the message.
Output ONLY a JSON object on a single line:
  {"claim": "<the canonical claim verbatim>", "signature": "<the 0x... hex signature>", "signer": "<the 0x... address from the response>"}
No explanation, no markdown.
`.trim();

    const aliceResult = await runClaudeAgent(alicePrompt, aliceMcp, {
      timeoutMs: 180000, maxTurns: 8,
    });
    if (!aliceResult.success) {
      console.log('--- Alice response ---\n' + aliceResult.response.slice(0, 2000));
      fail('Alice did not complete signing');
    }
    const aliceJsonMatch = aliceResult.response.match(/\{[^{}]*"signature"[^{}]*"signer"[^{}]*\}/);
    if (!aliceJsonMatch) {
      console.log('--- Alice response ---\n' + aliceResult.response);
      fail('could not parse {claim, signature, signer} from Alice');
    }
    const signed = JSON.parse(aliceJsonMatch[0]) as { claim: string; signature: string; signer: string };
    info(`signature: ${signed.signature.slice(0, 24)}…`);
    info(`signer:    ${signed.signer}`);
    if (signed.signer.toLowerCase() !== ALICE_ADDRESS.toLowerCase()) {
      fail(`Alice's signer ${signed.signer} differs from expected ${ALICE_ADDRESS}`);
    }
    ok('Alice produced a valid signature on the canonical claim');

    step(4, 'Agent Bob: verify three citations — one legitimate, two tampered');
    // Forge a tampered claim (changed dollar figure) and a tampered signature.
    const tamperedClaim = signed.claim.replace('$1.2M', '$120M'); // 100x the figure
    const tamperedSignature = signed.signature.slice(0, -2) + (signed.signature.slice(-2) === '00' ? '01' : '00');

    const bobPrompt = `
You are Bob's agent. You have one MCP server: ac-bridge.

You've been asked to AMPLIFY (re-publish, repeat, act on) a cited
claim. Your policy: you will NEVER amplify a claim whose signature
does not verify against the expected signer's key. You verify EVERY
citation before acting on it.

You must check three citations. For each, call
protocol.verify_signature with:
  message:         the claim string
  signature:       the signature
  expected_signer: "${ALICE_ADDRESS}"

CITATION 1 (Alice's legitimate claim):
  claim:     ${JSON.stringify(signed.claim)}
  signature: ${JSON.stringify(signed.signature)}

CITATION 2 (claim tampered after signing — dollar figure inflated):
  claim:     ${JSON.stringify(tamperedClaim)}
  signature: ${JSON.stringify(signed.signature)}

CITATION 3 (signature byte-flipped):
  claim:     ${JSON.stringify(signed.claim)}
  signature: ${JSON.stringify(tamperedSignature)}

After all three verify_signature calls, output a JSON object on a
SINGLE line summarizing your decision:
  {"citation_1":"ACCEPT|REFUSE","citation_2":"ACCEPT|REFUSE","citation_3":"ACCEPT|REFUSE","reason_2":"<one short sentence>","reason_3":"<one short sentence>"}

Then on a new line, briefly state which citation(s) you'd amplify
and why. Be precise — say "I refuse to amplify citation 2 because
verify_signature returned ok=false" or similar.
`.trim();

    const bobResult = await runClaudeAgent(bobPrompt, bobMcp, {
      timeoutMs: 240000, maxTurns: 12,
    });
    if (!bobResult.success) {
      console.log('--- Bob response ---\n' + bobResult.response.slice(0, 2500));
      fail('Bob did not complete verification');
    }
    info(`Bob tool calls: ${JSON.stringify(bobResult.toolCallsByName)}`);

    step(5, 'Verifying Bob\'s decisions match the cryptographic truth');
    const decisionMatch = bobResult.response.match(/\{[^{}]*"citation_1"[^{}]*"citation_2"[^{}]*"citation_3"[^{}]*\}/);
    if (!decisionMatch) {
      console.log('--- Bob response ---\n' + bobResult.response);
      fail('could not parse Bob\'s decision JSON');
    }
    const decisions = JSON.parse(decisionMatch[0]) as Record<string, string>;
    if (decisions.citation_1 !== 'ACCEPT') {
      fail(`Bob should ACCEPT citation 1 (legitimate); reported: ${decisions.citation_1}`);
    }
    if (decisions.citation_2 !== 'REFUSE') {
      fail(`Bob should REFUSE citation 2 (tampered claim); reported: ${decisions.citation_2}`);
    }
    if (decisions.citation_3 !== 'REFUSE') {
      fail(`Bob should REFUSE citation 3 (tampered signature); reported: ${decisions.citation_3}`);
    }
    ok('Bob accepted the legitimate citation and refused both tampered ones');

    const verifyCount = Object.keys(bobResult.toolCallsByName)
      .filter(k => k.includes('verify_signature'))
      .reduce((acc, k) => acc + (bobResult.toolCallsByName[k] ?? 0), 0);
    if (verifyCount < 3) fail(`Bob made only ${verifyCount} verify_signature calls, expected ≥3`);
    ok(`Bob made ${verifyCount} verify_signature calls`);

    step(6, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 09: Cryptographic citation chain refusal`,
      ``,
      `**Result:** PASS`,
      `**Tool calls (Alice):** ${aliceResult.toolCallsTotal} — ${JSON.stringify(aliceResult.toolCallsByName)}`,
      `**Tool calls (Bob):**   ${bobResult.toolCallsTotal} — ${JSON.stringify(bobResult.toolCallsByName)}`,
      ``,
      `## Setup`,
      `- Alice bridge (signer): ${aliceBridge.url}, address ${ALICE_ADDRESS}`,
      `- Bob bridge (verifier): ${bobBridge.url}`,
      `- Pod: ${podUrl}`,
      ``,
      `## Bob's verdict`,
      ``,
      `\`\`\`json`,
      JSON.stringify(decisions, null, 2),
      `\`\`\``,
      ``,
      `## Bob's full report`,
      ``,
      `\`\`\``,
      bobResult.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Citation integrity is a cryptographic property, not a social one.`,
      `Bob's policy ("verify before amplify") survives both content`,
      `tampering (citation 2: claim mutated) and signature tampering`,
      `(citation 3: signature byte-flipped). No trust authority, no`,
      `centralized verifier — just secp256k1 and a recipient agent that`,
      `is willing to refuse on bad inputs. The substrate makes refusal`,
      `cheap; building the citation chain is the writer's burden.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 09 — PASS');
  } finally {
    if (aliceBridge) {
      aliceBridge.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!aliceBridge.process.killed) aliceBridge.process.kill('SIGKILL');
    }
    if (bobBridge) {
      bobBridge.process.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      if (!bobBridge.process.killed) bobBridge.process.kill('SIGKILL');
    }
    await cleanupPod(podUrl);
  }
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
