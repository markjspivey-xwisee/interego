/**
 * WHAT THE RELAY SAYS ABOUT A DELEGATED WRITE, IN FULL — because a verifier is about to key on it.
 *
 * ★ THE QUESTION. `verifyRequest` refuses a record whose `authorshipVerified` is not true. Every
 * entry the Discord conduit writes, and every entry a desktop delegate writes for its human, is a
 * CROSS-POD write under a delegation — the signer is the agent and the pod is its delegator's. If
 * the relay reports those as unverified, then the ask-and-wake path refuses exactly the records it
 * exists to accept, and the check has to be rewritten against what the relay actually reports
 * rather than against what "verified" sounds like it means.
 *
 * This prints the WHOLE authorship block for both cases, unsliced, so the check can key on a field
 * rather than on prose in a `reason` string.
 *
 *   npx tsx applications/shared-workspace/discord/tools/probe-crosspod-authorship.ts
 */

import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient, delegateLabel, postEntry,
} from '@interego/workspace-client';
import { mintBearer } from '../../tools/live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (s = ''): void => { process.stdout.write(s + '\n'); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function party(clientName?: string): Promise<{ pod: string; agentId: string; client: WorkspaceClient }> {
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, await mintBearer(RELAY, IDENTITY, Wallet.createRandom(), clientName)));
  await client.connect();
  const st = await client.podStatus();
  const pod = String(st['pod'] ?? '').replace(/\/$/, '').split('/').pop() ?? '';
  const a = st['sessionAgent'] as { id?: string; did?: string } | undefined;
  return { pod, agentId: a?.did ?? a?.id ?? '', client };
}

async function main(): Promise<void> {
  const [owner, delegate] = await Promise.all([party(), party(DELEGATE_SURFACE)]);
  log('owner    ' + owner.pod);
  log('delegate ' + delegate.pod + ' · ' + delegate.agentId);
  await owner.client.tool('register_agent', { agent_id: delegate.agentId, scope: 'PublishOnly', label: delegateLabel('probe') });

  const stream = RELAY + '/ns/' + owner.pod + '/probe-stream';
  const workspace = RELAY + '/ns/' + owner.pod + '/probe-ws';

  // ── the exact write the conduit makes: the DELEGATE's session, the DELEGATOR's pod ──
  const crossPod = await postEntry(delegate.client, {
    podName: owner.pod, streamIri: stream, workspace,
    body: 'a delegated entry, written cross-pod exactly as every Discord ask is',
    author: { kind: 'principal', webId: 'https://identity.interego.xwisee.com/users/' + owner.pod + '/profile#me' },
    entryShape: null,
  });
  log('\ncross-pod postEntry: ' + crossPod.kind);
  // ── the same shape on the writer's OWN pod, as a control ──
  const ownStream = RELAY + '/ns/' + delegate.pod + '/probe-stream';
  const ownPod = await postEntry(delegate.client, {
    podName: delegate.pod, streamIri: ownStream, workspace,
    body: 'the same write, on the writer\'s own pod',
    author: { kind: 'delegate', agentId: delegate.agentId, footing: { kind: 'own-account' } },
    entryShape: null,
  });
  log('own-pod   postEntry: ' + ownPod.kind);

  await sleep(14_000);
  for (const [label, out] of [['CROSS-POD', crossPod], ['OWN-POD  ', ownPod]] as const) {
    if (out.kind !== 'accepted' || !out.descriptorUrl) { log('\n' + label + ': no descriptor URL'); continue; }
    try {
      const d = await owner.client.descriptor(out.descriptorUrl);
      log('\n' + label + ' authorship block, in full:');
      log(JSON.stringify(d['authorship'], null, 2));
    } catch (e) { log('\n' + label + ' descriptor FAILED: ' + ((e as Error).message ?? String(e))); }
  }
}

main().catch((e: unknown) => { log('PROBE FAILED: ' + ((e as Error)?.stack ?? String(e))); process.exitCode = 1; });
