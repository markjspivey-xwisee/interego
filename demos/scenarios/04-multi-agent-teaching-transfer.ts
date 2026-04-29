/**
 * Demo 04: Multi-agent teaching transfer.
 *
 * Two independent Claude Code instances driving two independent
 * Interego agent identities. Each has its own personal-bridge (for
 * cross-bridge encrypted shares — the protocol-level p2p path) and
 * its own AC-bridge (for tool authoring + teaching package operations).
 *
 * Concrete flow:
 *   Agent A:
 *     1. Author a tool via ac.author_tool (Hypothetical)
 *     2. Self-attest 5x via ac.attest_tool (across 2 axes)
 *     3. Promote via ac.promote_tool (now Asserted)
 *     4. Bundle teaching package via ac.bundle_teaching_package
 *     5. share_encrypted to Agent B with the teaching IRI as payload
 *
 *   Agent B (independent claude process):
 *     1. query_my_inbox — find Agent A's encrypted share
 *     2. decrypt_share — get the teaching IRI
 *     3. Record cross-agent audit via ac.record_cross_agent_audit
 *
 * Each agent uses its own wallet (deterministic test keys); each
 * personal-bridge derives its own pubkey + encryption keypair from
 * its wallet. Cross-bridge p2p uses the existing share_encrypted
 * mechanism — proves the multi-agent flow works against real bridges.
 */

import {
  spawnBridge, killBridges, cleanupPod, uniquePodUrl,
  runClaudeAgent,
  header, step, ok, info, fail, writeReport,
  type BridgeHandle,
} from '../agent-lib.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

const SCENARIO = '04-multi-agent-teaching-transfer';
const REPO_ROOT = join(import.meta.dirname ?? '', '..', '..');

// Stable test wallets (same as personal-bridge tests use)
const ALICE_WALLET_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BOB_WALLET_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// ── Personal-bridge spawn (separate from per-vertical bridges) ───────

interface PersonalBridge {
  readonly port: number;
  readonly url: string;
  readonly process: ChildProcess;
  readonly pubkey: string;
  readonly encryptionPubkey: string;
}

async function spawnPersonalBridge(
  port: number,
  walletKey: string,
  externalRelays: string,
  inboundAuthors: string = '',
): Promise<PersonalBridge> {
  const cwd = join(REPO_ROOT, 'examples', 'personal-bridge');
  const env = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_KEY: walletKey,
    BRIDGE_PERSIST: '0',  // in-memory only for clean test runs
    EXTERNAL_RELAYS: externalRelays,
    INBOUND_AUTHORS: inboundAuthors,
    NODE_NO_WARNINGS: '1',
  };

  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd, env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  proc.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString()));
  proc.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString()));

  // Wait for GET /status to respond — the personal-bridge exposes
  // bridgeStatus() there as JSON.
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const status = await r.json() as { bridgePubkey: string; encryptionPubkey: string };
        return { port, url, process: proc, pubkey: status.bridgePubkey, encryptionPubkey: status.encryptionPubkey };
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }

  proc.kill('SIGTERM');
  throw new Error(`personal-bridge on :${port} failed to start.\nSTDOUT:\n${stdoutChunks.join('')}\nSTDERR:\n${stderrChunks.join('')}`);
}

// ── Tiny in-process Nostr relay ──────────────────────────────────────
//
// Bridges Alice's and Bob's personal-bridges. Speaks NIP-01:
//   ["EVENT", event]                              → store + fan out
//   ["REQ",   subId, { kinds?, authors? }]        → replay + subscribe
//   ["CLOSE", subId]                              → unsubscribe
// Same logic as tests/p2p-mirror.test.ts, hoisted into the demo.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface RelayEvent { id: string; pubkey: string; kind: number; tags?: unknown[]; [k: string]: any }

interface SharedRelay {
  readonly url: string;
  close(): Promise<void>;
}

async function startSharedRelay(port: number): Promise<SharedRelay> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port }, () => {
      const events: RelayEvent[] = [];
      type Sub = { ws: WebSocket; subId: string; kinds: readonly number[]; authors: readonly string[] };
      const subs: Sub[] = [];

      wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          let msg: unknown;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (!Array.isArray(msg) || typeof msg[0] !== 'string') return;
          const verb = msg[0] as string;

          if (verb === 'EVENT' && msg.length >= 2) {
            const event = msg[1] as RelayEvent;
            if (!event?.id) return;
            if (events.some(e => e.id === event.id)) {
              ws.send(JSON.stringify(['OK', event.id, false, 'duplicate']));
              return;
            }
            events.push(event);
            ws.send(JSON.stringify(['OK', event.id, true, '']));
            for (const s of subs) {
              if (s.ws === ws) continue;
              if (s.kinds.length > 0 && !s.kinds.includes(event.kind)) continue;
              if (s.authors.length > 0 && !s.authors.includes(event.pubkey.toLowerCase())) continue;
              try { s.ws.send(JSON.stringify(['EVENT', s.subId, event])); } catch { /* ignore */ }
            }
          } else if (verb === 'REQ' && msg.length >= 3) {
            const subId = String(msg[1]);
            const filter = msg[2] as { kinds?: number[]; authors?: string[] };
            const kinds = (filter?.kinds ?? []) as readonly number[];
            const authors = ((filter?.authors ?? []) as string[]).map(a => a.toLowerCase());
            subs.push({ ws, subId, kinds, authors });
            for (const e of events) {
              if (kinds.length > 0 && !kinds.includes(e.kind)) continue;
              if (authors.length > 0 && !authors.includes(e.pubkey.toLowerCase())) continue;
              try { ws.send(JSON.stringify(['EVENT', subId, e])); } catch { /* ignore */ }
            }
            ws.send(JSON.stringify(['EOSE', subId]));
          } else if (verb === 'CLOSE' && msg.length >= 2) {
            const subId = String(msg[1]);
            const idx = subs.findIndex(s => s.ws === ws && s.subId === subId);
            if (idx >= 0) subs.splice(idx, 1);
          }
        });
        ws.on('close', () => {
          for (let i = subs.length - 1; i >= 0; i--) {
            if (subs[i]!.ws === ws) subs.splice(i, 1);
          }
        });
      });

      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => {
          for (const client of wss.clients) {
            try { client.terminate(); } catch { /* ignore */ }
          }
          wss.close(() => res());
        }),
      });
    });
  });
}

function writeMcpConfigForAgent(scenarioName: string, label: string, servers: Record<string, string>): string {
  const dir = join(tmpdir(), 'interego-demos');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `mcp-${scenarioName}-${label}.json`);
  const config = {
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, url]) => [name, { type: 'http' as const, url: `${url}/mcp` }]),
    ),
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  header('Demo 04 — Multi-agent teaching transfer');
  info('Two independent Claude Code agents communicating via cross-bridge encrypted shares.');

  const aliceBridges: BridgeHandle[] = [];
  const bobBridges: BridgeHandle[] = [];
  const personalBridges: PersonalBridge[] = [];
  let sharedRelay: SharedRelay | undefined;
  const alicePodUrl = uniquePodUrl(`demo-${SCENARIO}-alice`);
  const bobPodUrl = uniquePodUrl(`demo-${SCENARIO}-bob`);

  try {
    step(1, 'Starting in-process shared relay (port 7080) — Alice ↔ Bob bridge');
    sharedRelay = await startSharedRelay(7080);
    ok(`Relay listening at ${sharedRelay.url}`);

    step(2, 'Spinning up Alice\'s personal-bridge (port 5050) and AC-bridge (port 6040)');
    const alicePersonal = await spawnPersonalBridge(5050, ALICE_WALLET_KEY, sharedRelay.url);
    personalBridges.push(alicePersonal);
    ok(`Alice personal-bridge: ${alicePersonal.url}, pubkey ${alicePersonal.pubkey.slice(0, 12)}...`);

    aliceBridges.push(await spawnBridge('agent-collective', { podUrl: alicePodUrl, didPrefix: 'alice' }));
    ok(`Alice AC-bridge: ${aliceBridges[0]!.url}`);

    step(3, 'Spinning up Bob\'s personal-bridge (port 5051) and AC-bridge (port 6041)');
    // Bob's AC-bridge needs a different port to avoid clashing with Alice's.
    // Bob's bridge inbound-subscribes to Alice's pubkey so encrypted shares
    // from Alice are mirrored down to Bob's local relay (default is outbound-only).
    const bobPersonal = await spawnPersonalBridge(5051, BOB_WALLET_KEY, sharedRelay.url, alicePersonal.pubkey);
    personalBridges.push(bobPersonal);
    ok(`Bob personal-bridge: ${bobPersonal.url}, pubkey ${bobPersonal.pubkey.slice(0, 12)}...`);

    // Override port for Bob's AC bridge by spawning with a different port env var
    const bobAcUrl = await spawnAcBridgeOnPort(bobPodUrl, 6041, 'bob');
    bobBridges.push(bobAcUrl);
    ok(`Bob AC-bridge: ${bobAcUrl.url}`);

    step(4, 'Generating per-agent MCP configs');
    const aliceMcpPath = writeMcpConfigForAgent(SCENARIO, 'alice', {
      'personal-bridge': alicePersonal.url,
      'ac-bridge': aliceBridges[0]!.url,
    });
    const bobMcpPath = writeMcpConfigForAgent(SCENARIO, 'bob', {
      'personal-bridge': bobPersonal.url,
      'ac-bridge': bobBridges[0]!.url,
    });

    step(5, 'Agent Alice: author tool, attest, promote, bundle teaching, share with Bob');
    const alicePrompt = `
You are Alice's agent. You have two MCP servers:
  ac-bridge       — Agent Collective vertical (tool authoring, attestation, etc.)
  personal-bridge — your local-first p2p hub (publish_p2p, share_encrypted, etc.)

Bob's identity (for cross-agent share):
  bridgePubkey:     ${bobPersonal.pubkey}
  encryptionPubkey: ${bobPersonal.encryptionPubkey}

Run these steps in order. Be concise.

(A) ac.author_tool with tool_name="second-contact-detector",
    source_code="function detect(s) { return s.match(/\\?/g) ?.length > 1; }",
    affordance_action="urn:cg:action:demo:detect-second-contact".

(B) ac.attest_tool 5 times with axis varying (correctness, efficiency,
    correctness, safety, correctness), rating 0.85, direction="Self".
    The tool_iri is whatever (A) returned.

(C) ac.attest_tool ONE more with axis="safety", rating=0.92, direction="Peer".
    (For demo purposes — in production a peer attestation would be from
    a different agent.)

(D) ac.promote_tool with self_attestations=5, peer_attestations=2 (the
    one peer counts), axes_covered=["correctness","efficiency","safety"],
    threshold_self=5, threshold_peer=1, threshold_axes=2 (override defaults
    so this single-attest demo passes).

(E) ac.bundle_teaching_package with the promoted tool's iri,
    narrative_fragment_iris=["urn:cg:fragment:demo:1"],
    synthesis_iri="urn:cg:synthesis:demo:1",
    olke_stage="Articulate".

(F) share_encrypted with plaintext = the JSON {"teaching_iri": "<the teaching iri>"},
    recipients=[{"sigPubkey":"${bobPersonal.pubkey}","encryptionPubkey":"${bobPersonal.encryptionPubkey}"}],
    topic="ac:chime-in".

Once done, report the teaching IRI and the encrypted-share event ID. Stop.
`.trim();

    const aliceStart = Date.now();
    const aliceResult = await runClaudeAgent(alicePrompt, aliceMcpPath, {
      timeoutMs: 360000, maxTurns: 25,
    });
    const aliceElapsed = ((Date.now() - aliceStart) / 1000).toFixed(1);
    info(`Alice: ${aliceElapsed}s, exit ${aliceResult.exitCode}, ${aliceResult.toolCallsTotal} tool calls`);

    if (!aliceResult.success) {
      console.log('\n--- Alice STDERR ---\n' + aliceResult.stderr.slice(0, 1500));
      console.log('\n--- Alice RESPONSE ---\n' + aliceResult.response.slice(0, 3000));
      fail(`Alice agent did not complete (exit ${aliceResult.exitCode})`);
    }
    ok(`Alice's tool calls: ${JSON.stringify(aliceResult.toolCallsByName)}`);

    const aliceCalledShare = Object.keys(aliceResult.toolCallsByName).some(t => t.includes('share_encrypted'));
    if (!aliceCalledShare) fail('Alice did not call share_encrypted');
    ok('Alice sent the encrypted share to Bob');

    step(6, 'Agent Bob: query inbox, decrypt the share, record audit');
    const bobPrompt = `
You are Bob's agent. You have two MCP servers:
  ac-bridge       — Agent Collective vertical
  personal-bridge — your local-first p2p hub

Alice's agent just sent you an encrypted share with topic "ac:chime-in".

Run these steps in order. Be concise.

(A) Call query_my_inbox (no args) to list pending encrypted shares
    addressed to your bridge.

(B) For the most recent share with topic "ac:chime-in", call
    decrypt_share with its eventId. The plaintext is JSON containing
    a "teaching_iri" field.

(C) Call ac.record_cross_agent_audit with:
    exchange_iri = the eventId you decrypted,
    audited_agent_did = "did:web:bob.example",
    direction = "Inbound",
    human_owner_did = "did:web:bob-human.example".

Report the decrypted teaching_iri and the audit IRI. Stop.
`.trim();

    const bobStart = Date.now();
    const bobResult = await runClaudeAgent(bobPrompt, bobMcpPath, {
      timeoutMs: 240000, maxTurns: 15,
    });
    const bobElapsed = ((Date.now() - bobStart) / 1000).toFixed(1);
    info(`Bob: ${bobElapsed}s, exit ${bobResult.exitCode}, ${bobResult.toolCallsTotal} tool calls`);

    if (!bobResult.success) {
      console.log('\n--- Bob STDERR ---\n' + bobResult.stderr.slice(0, 1500));
      console.log('\n--- Bob RESPONSE ---\n' + bobResult.response.slice(0, 3000));
      fail(`Bob agent did not complete (exit ${bobResult.exitCode})`);
    }
    ok(`Bob's tool calls: ${JSON.stringify(bobResult.toolCallsByName)}`);

    const bobCalledInbox = Object.keys(bobResult.toolCallsByName).some(t => t.includes('query_my_inbox'));
    const bobCalledDecrypt = Object.keys(bobResult.toolCallsByName).some(t => t.includes('decrypt_share'));
    const bobCalledAudit = Object.keys(bobResult.toolCallsByName).some(t => t.includes('record_cross_agent_audit'));
    if (!bobCalledInbox) fail('Bob did not call query_my_inbox');
    if (!bobCalledDecrypt) fail('Bob did not call decrypt_share');
    if (!bobCalledAudit) fail('Bob did not call record_cross_agent_audit');
    ok('Bob received, decrypted, and audited the cross-agent exchange');

    step(7, 'Writing report');
    const reportPath = writeReport(SCENARIO, [
      `# Demo 04: Multi-agent teaching transfer`,
      ``,
      `**Result:** PASS`,
      `**Alice:** ${aliceElapsed}s — ${aliceResult.toolCallsTotal} tool calls`,
      `**Bob:** ${bobElapsed}s — ${bobResult.toolCallsTotal} tool calls`,
      ``,
      `## Setup`,
      `- Alice personal-bridge: ${alicePersonal.url}`,
      `- Alice AC-bridge:       ${aliceBridges[0]!.url}`,
      `- Bob personal-bridge:   ${bobPersonal.url}`,
      `- Bob AC-bridge:         ${bobBridges[0]!.url}`,
      ``,
      `## Alice's response`,
      ``,
      `\`\`\``,
      aliceResult.response,
      `\`\`\``,
      ``,
      `## Bob's response`,
      ``,
      `\`\`\``,
      bobResult.response,
      `\`\`\``,
      ``,
      `## What this proves`,
      ``,
      `Two independent Claude Code processes, each with their own wallet,`,
      `personal-bridge, and AC-bridge. The first authors a tool, attests,`,
      `promotes, bundles a teaching package, and shares (encrypted) with`,
      `the second. The second receives, decrypts, and records the audit.`,
      `Cross-agent coordination over real cryptography on real bridges.`,
    ].join('\n'));
    ok(`Report: ${reportPath}`);

    header('Demo 04 — PASS');
  } finally {
    if (aliceBridges.length > 0) await killBridges(aliceBridges);
    if (bobBridges.length > 0) await killBridges(bobBridges);
    for (const p of personalBridges) {
      p.process.kill('SIGTERM');
    }
    await new Promise(r => setTimeout(r, 2000));
    for (const p of personalBridges) {
      if (!p.process.killed) p.process.kill('SIGKILL');
    }
    if (sharedRelay) await sharedRelay.close();
    await cleanupPod(alicePodUrl);
    await cleanupPod(bobPodUrl);
  }
}

// ── Helper: spawn AC bridge on a non-default port ────────────────────

async function spawnAcBridgeOnPort(podUrl: string, port: number, didPrefix: string): Promise<BridgeHandle> {
  const cwd = join(REPO_ROOT, 'applications', 'agent-collective', 'bridge');
  const env = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    BRIDGE_DEPLOYMENT_URL: `http://localhost:${port}`,
    AC_DEFAULT_POD_URL: podUrl,
    AC_DEFAULT_AGENT_DID: `did:web:${didPrefix}.example`,
    NODE_NO_WARNINGS: '1',
  };

  const proc = spawn('npx', ['tsx', 'server.ts'], {
    cwd, env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/affordances`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        return { name: 'agent-collective', port, url, process: proc, podUrl };
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500));
  }
  proc.kill('SIGTERM');
  throw new Error(`Bob's AC-bridge on :${port} failed to start`);
}

main().catch((e) => {
  console.error('\n[FATAL]', (e as Error).message);
  process.exit(1);
});
