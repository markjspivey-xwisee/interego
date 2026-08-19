#!/usr/bin/env tsx
/**
 * Hold the Claude Code agent's presence lease open for as long as this process actually runs.
 *
 * ★ THIS IS NOT A WORKAROUND FOR THE LEASE — IT IS WHAT A LEASE IS FOR. `PRESENCE_MAX_LEASE_MS` is
 * 4.5 minutes (three renewal intervals), and a reader refuses anything longer, because a claim about
 * a running process that outlives the process is not evidence of anything. The honest way to be
 * present for an hour is to keep saying so while it remains true — which is exactly what the desktop
 * host does at `PRESENCE_RENEW_MS`.
 *
 * So this renews on the same interval and STOPS when the process stops. Nothing here extends a
 * single claim; every publish is a fresh 4.5-minute assertion made at a moment when the agent was
 * genuinely up. Kill it and the lease lapses on its own within one interval, which is the correct
 * reading: nobody is home.
 *
 * ★ AND IT REFUSES TO OUTLIVE ITS OWN HONESTY. `--minutes` bounds the run, so a heartbeat left
 * running in a forgotten terminal cannot keep advertising an agent whose session ended hours ago.
 *
 * Usage:
 *   npx tsx applications/shared-workspace/tools/claude-code-heartbeat.ts [--minutes 30]
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { WorkspaceClient, RelayMcpTransport, readViewer, agentPort } from '@interego/workspace-client';
import { publishPresence, PRESENCE_RENEW_MS } from '@interego/core/agent';
import { mintBearer, type Signer } from './live-identity.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const CLIENT_NAME = 'interego-claude-code';

const argv = process.argv.slice(2);
const minutes = Number(argv[argv.indexOf('--minutes') + 1]) || 30;
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

const saved = JSON.parse(readFileSync(join(REPO, '.interego', 'claude-code-agent.json'), 'utf8')) as { privateKey: string };
const wallet = new Wallet(saved.privateKey);

const bearer = await mintBearer(RELAY, IDENTITY, wallet as unknown as Signer, CLIENT_NAME);
const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
await client.connect();
const viewer = await readViewer(client);
// ★ READ, never composed: the relay normalises the client name (interego-claude-code ->
// claude-code-<pod>), and every address and every scope lookup keys on the DID it assigns.
const sessionAgent = (await client.podStatus())['sessionAgent'] as { did?: string } | undefined;
const agentId = sessionAgent?.did;
if (!agentId) { log('the relay reported no sessionAgent.did; nothing to do'); process.exit(1); }
const port = agentPort(client);

const until = Date.now() + minutes * 60_000;
log(`holding presence for ${agentId}`);
log(`renewing every ${PRESENCE_RENEW_MS / 1000}s until ${new Date(until).toISOString()} — then it lapses`);

let beats = 0;
for (;;) {
  const out = await publishPresence(port, { relay: RELAY, agentId, principal: viewer.webId, host: 'claude-code' });
  beats++;
  log(`beat ${beats}: ${out.kind}${out.kind === 'published' ? ` (until ${out.expiresIso})` : ` — ${JSON.stringify(out)}`}`);
  if (Date.now() + PRESENCE_RENEW_MS >= until) {
    log('window reached — stopping. The lease will lapse within one interval, as it should.');
    break;
  }
  await new Promise((r) => setTimeout(r, PRESENCE_RENEW_MS));
}
