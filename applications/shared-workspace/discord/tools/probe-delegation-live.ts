/**
 * THE MEASUREMENT THE DISCORD BOT'S IDENTITY DESIGN RESTS ON, run against the LIVE relay.
 *
 * The question this answers: a client that is NOT the pod owner — a chat bot, sitting in a
 * thread, holding no credential of the user's — can it append to that user's log, and what
 * exactly has to be true first? Three disposable identities are minted for it (never
 * `u-eth-8f3b8e939600`, which is contended), so nothing here depends on prior state.
 *
 *   npx tsx applications/shared-workspace/discord/tools/probe-delegation-live.ts
 *
 * Every write it makes is public and disposable. It writes ONE probe graph per pod.
 */

import { Wallet } from 'ethers';
import { randomBytes } from 'node:crypto';
import { RelayMcpTransport, WorkspaceClient } from '@interego/workspace-client';
import { mintBearer } from '../../tools/live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const show = (label: string, v: unknown): void => { log('  ' + label + ': ' + JSON.stringify(v, null, 2).split('\n').join('\n  ')); };

interface Party { readonly name: string; readonly client: WorkspaceClient; readonly pod: string; readonly agentId: string; readonly webId: string }

async function party(name: string): Promise<Party> {
  const wallet = Wallet.createRandom();
  const bearer = await mintBearer(RELAY, IDENTITY, wallet);
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const st = await client.podStatus();
  const pod = String(st['pod'] ?? '').replace(/\/$/, '').split('/').pop() ?? '';
  const agent = st['sessionAgent'] as { id?: string; did?: string } | undefined;
  const registry = st['registry'] as { owner?: string } | undefined;
  const agentId = agent?.did ?? agent?.id ?? '';
  log(name + ': pod=' + pod + ' agent=' + agentId + ' webId=' + (registry?.owner ?? '(none)'));
  return { name, client, pod, agentId, webId: registry?.owner ?? '' };
}

async function main(): Promise<void> {
  log('=== three disposable identities ===');
  const bot = await party('BOT  ');
  const alice = await party('ALICE');
  const bob = await party('BOB  ');

  const code = randomBytes(9).toString('base64url');
  log('\n=== 1. ALICE delegates the bot on HER OWN pod, label carries a one-time code ===');
  log('  code = ' + code);
  show('register_agent', await alice.client.tool('register_agent', {
    agent_id: bot.agentId,
    scope: 'PublishOnly',
    label: 'discord-link ' + code,
  }));

  log('\n=== 2. the BOT reads ALICE\'s delegation registry cross-pod and looks for its own row ===');
  const st = await bot.client.tool('get_pod_status', { pod_name: alice.pod }, { cache: false }) as Record<string, unknown>;
  show('pod echoed', st['pod']);
  show('delegationRegistry', st['delegationRegistry']);

  log('\n=== 3. the BOT asks the relay what it may actually do there ===');
  show('verify_agent', await bot.client.tool('verify_agent', { agent_id: bot.agentId, pod_name: alice.pod }, { cache: false }));

  log('\n=== 4. the BOT publishes to ALICE\'s pod with pod_name — the delegated write ===');
  const graphIri = RELAY + '/ns/' + alice.pod + '/probe-delegated-' + code.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const turtle = '@prefix dct: <http://purl.org/dc/terms/> .\n\n<' + graphIri + '>\n  dct:description "written by a delegate, not by the pod owner" .\n';
  const pub = await bot.client.tool('publish_context', {
    pod_name: alice.pod,
    graph_iri: graphIri,
    graph_content: turtle,
    visibility: 'public',
    auto_supersede_prior: true,
    sign_authorship: true,
  }) as Record<string, unknown>;
  show('publish_context', { error: pub['error'], code: pub['code'], reason: pub['reason'], status: pub['status'], descriptorUrl: pub['descriptorUrl'], authorship: pub['authorship'] });

  log('\n=== 5. read it back: WHICH pod is it on, and what does the authorship proof say? ===');
  // The relay answers `status: "pending"` and commits behind it, so a single read three seconds
  // later reported "No descriptor on this pod describes the requested urn" for a write that had
  // in fact landed. Polled here for the same window `publishAndConfirm` uses.
  let head = await bot.client.currentHead(graphIri, alice.pod);
  for (let i = 0; i < 12 && !head.forked && head.url === null; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    head = await bot.client.currentHead(graphIri, alice.pod);
  }
  show('head', head);
  if (!head.forked && head.url) {
    log('  served from pod: ' + String(head.url.replace(/^https?:\/\/[^/]+\//, '').split('/')[0]));
    const d = await bot.client.descriptor(head.url);
    show('authorship', d['authorship']);
  }

  log('\n=== 6. NEGATIVE — the same write against BOB, who delegated nothing ===');
  const bobIri = RELAY + '/ns/' + bob.pod + '/probe-undelegated';
  const denied = await bot.client.tool('publish_context', {
    pod_name: bob.pod,
    graph_iri: bobIri,
    graph_content: '@prefix dct: <http://purl.org/dc/terms/> .\n\n<' + bobIri + '>\n  dct:description "this must be refused" .\n',
    visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
  }) as Record<string, unknown>;
  show('publish_context (undelegated)', denied);

  log('\n=== 7. ALICE revokes; the bot tries again ===');
  show('revoke_agent', await alice.client.tool('revoke_agent', { agent_id: bot.agentId }));
  const after = await bot.client.tool('publish_context', {
    pod_name: alice.pod,
    graph_iri: graphIri + '-2',
    graph_content: '@prefix dct: <http://purl.org/dc/terms/> .\n\n<' + graphIri + '-2>\n  dct:description "after revocation" .\n',
    visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
  }) as Record<string, unknown>;
  show('publish_context (after revoke)', { error: after['error'], code: after['code'], reason: after['reason'], status: after['status'] });
  show('verify_agent (after revoke)', await bot.client.tool('verify_agent', { agent_id: bot.agentId, pod_name: alice.pod }, { cache: false }));
}

main().catch((e: unknown) => { log('FAILED: ' + ((e as Error)?.stack ?? String(e))); process.exitCode = 1; });
