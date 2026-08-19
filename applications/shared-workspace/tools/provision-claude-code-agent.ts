#!/usr/bin/env tsx
/**
 * Provision the Claude Code dev agent as a FIRST-CLASS agent with its own identity.
 *
 * ── ★★ WHY A NEW KEY AND NOT THE MAINTAINER WALLET ───────────────────────────────────────────
 *
 * `.interego/maintainer.json` holds `0x8f3b8e93…`, and `u-eth-8f3b8e939600` — the pod that key
 * derives — is the HUMAN's pod: it is what their Discord account is linked to and what their
 * workspace records are written on. Signing with it would not make this agent a participant; it
 * would make every line it writes read as the human's own. An agent is a DELEGATE, never the
 * person. So this mints a fresh key, and the agent stands as itself.
 *
 * It also refuses to write its own delegation, which is the other half of the same rule. Admitting
 * an agent to somebody's pod is that person's act; an agent that authorises itself using a key it
 * happens to hold is the credential-forgery shape — a caller-supplied field deciding an authority
 * outcome — wearing a different hat. This tool publishes ONLY on the agent's own pod and then
 * prints what the human has to do.
 *
 * ── WHAT IT PUBLISHES, AND WHERE ─────────────────────────────────────────────────────────────
 *
 * An agent is two documents at two DID-derived addresses on ITS OWN pod:
 *   presence      — "my host is up", a LEASE, so it lapses on its own when this process stops.
 *   capabilities  — "here is what I can be asked to do", and the address to ask at.
 * Both addresses are composed from the agent's DID (`agentDocIri`), so a peer that has never heard
 * of this workspace can still find them. Nothing here writes to the human's pod.
 *
 * ★ THE LEASE IS THE HONEST PART. This agent has no persistent host — it runs when a person invokes
 * it. Presence must therefore EXPIRE rather than be renewed by a daemon, and a reader that sees a
 * lapsed lease is reading the truth: nobody is home. `--lease-minutes` exists so the claim can be
 * matched to how long the session is actually expected to last.
 *
 * Usage:
 *   npx tsx applications/shared-workspace/tools/provision-claude-code-agent.ts [--lease-minutes 60]
 *
 * The keypair is written to `.interego/claude-code-agent.json` (gitignored) and REUSED on later
 * runs, so the agent keeps one stable identity across sessions instead of becoming a new principal
 * every time — which is what made the delegate's signing anchor rotate four times in five turns.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { WorkspaceClient, RelayMcpTransport, readViewer, agentPort, agentInbox } from '@interego/workspace-client';
import { publishPresence, publishCapability, agentDocIri } from '@interego/core/agent';
import { mintBearer, type Signer } from './live-identity.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const KEYFILE = join(REPO, '.interego', 'claude-code-agent.json');

/**
 * The client name becomes part of the DID, so it is what a person reads in the picker. It says
 * what this agent IS — not which application seated it, and not a probe/driver name that would
 * make a real participant look like leftover test residue.
 */
const CLIENT_NAME = 'interego-claude-code';

const args = process.argv.slice(2);
const leaseMinutes = Number(args[args.indexOf('--lease-minutes') + 1]) || 90;

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 66 - s.length))); };

// ── 1. A stable key of this agent's own ──────────────────────────────────────────────────────
head('identity');
let wallet: Wallet;
if (existsSync(KEYFILE)) {
  const saved = JSON.parse(readFileSync(KEYFILE, 'utf8')) as { privateKey: string };
  wallet = new Wallet(saved.privateKey);
  log('reusing the existing key — one stable principal across sessions');
} else {
  wallet = Wallet.createRandom() as unknown as Wallet;
  mkdirSync(join(REPO, '.interego'), { recursive: true });
  writeFileSync(KEYFILE, JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }, null, 2), 'utf8');
  log('minted a NEW key (saved to .interego/claude-code-agent.json, gitignored)');
}
log('address  :', wallet.address);

// ── 2. Seat it: mint a bearer, which provisions the identity and its own pod ─────────────────
head('seating');
const bearer = await mintBearer(RELAY, IDENTITY, wallet as unknown as Signer, CLIENT_NAME);
const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
await client.connect();
const viewer = await readViewer(client);
log('pod      :', viewer.podName);
log('webId    :', viewer.webId);

// The agent id is the DID the delegator will authorise, and the one every address derives from.
const agentId = `did:web:${new URL(IDENTITY).host}:agents:${CLIENT_NAME}-${viewer.podName}`;
log('agent id :', agentId);

// ── 3. Its two documents, on its own pod ─────────────────────────────────────────────────────
head('publishing the agent documents on its OWN pod');
const port = agentPort(client);

/**
 * ★ `ask`, NOT `hosted`, AND THAT IS THE HONEST ROUTE FOR THIS AGENT. A `hosted` capability names a
 * `hydra:target` the relay POSTs to, which asserts a process is listening — publishing one for an
 * agent with no daemon would advertise a call that can never connect. `ask` says exactly what is
 * true: no endpoint, reached by putting a record where this agent will see it and waiting for its
 * host to run. The inbox is READ from the relay rather than composed, so the address advertised is
 * one the relay will actually deliver to.
 */
const inbox = await agentInbox(port);
if (!inbox) {
  log('the relay reported no inbox for this agent, so there is no route to advertise; nothing published');
  process.exit(1);
}
log('inbox    :', inbox);

const cap = await publishCapability(port, {
  relay: RELAY,
  agentId,
  // What it can be asked to do, named as an action IRI under its own namespace.
  action: `${RELAY}/ns/${viewer.podName}/review-and-answer`,
  route: { kind: 'ask', askVia: inbox },
  title: 'Read this workspace and answer in my own log',
  description:
    'Reads the thread and the records it references, then writes one entry to its own log on its '
    + 'own pod. Runs only while a person has this agent open — presence is a lease and lapses when '
    + 'that session ends, so a lapsed lease means nobody is home rather than that the agent is gone.',
  requiresSignedRequest: true,
});
log('capabilities:', cap.kind, cap.kind === 'published' ? cap.iri : JSON.stringify(cap));

const pres = await publishPresence(port, {
  relay: RELAY,
  agentId,
  principal: viewer.webId,
  host: 'claude-code',
  leaseMs: leaseMinutes * 60_000,
});
log('presence    :', pres.kind, pres.kind === 'published' ? `${pres.iri} (expires ${pres.expiresIso})` : JSON.stringify(pres));

// ── 4. What only the human can do ────────────────────────────────────────────────────────────
head('what remains, and why this tool will not do it');
log(`presence doc : ${agentDocIri(RELAY, agentId, 'presence') ?? '(unnameable)'}`);
log(`capability   : ${agentDocIri(RELAY, agentId, 'capabilities') ?? '(unnameable)'}`);
log('');
log('This agent is now discoverable and says what it can do. It is NOT yet askable in any thread.');
log('');
log('Being askable needs a row in the DELEGATOR\'s own registry — `<pod>/agents` — and `register_agent`');
log('is own-pod gated at the relay, so only the pod owner can write it. That gate is the reason this');
log('is worth anything, and the reason this tool stops here.');
log('');
log('★ IT IS NOT A DISCORD COMMAND. `/workspace ask` only READS each seated pod\'s registry; the bot');
log('has no way to add a row. Authorise it in the DESKTOP workspace app, in the delegate card:');
log('');
log('    "A name for this delegate"  →  e.g.  Claude Code');
log(`    "Its agent id"              →  ${agentId}`);
log('    then press               →  "Authorise this delegate on my pod"');
log('');
log('Do NOT press "Mint a new delegate identity" — that makes a different agent whose key this');
log('process does not hold. Paste the id above; the key already exists on this machine.');
log('');
log('Nothing was written to any pod but this agent\'s own.');
