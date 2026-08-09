/**
 * THE MEASUREMENT THE WHOLE OWN-POD RULE RESTS ON, RE-ASKED OF THE LIVE RELAY.
 *
 * ★ WHY THIS STILL EXISTS NOW THAT THE ANSWER IS KNOWN. `@interego/core/agent` derives an agent's
 * presence address from its DID, so its OWN pod is the only pod it can publish a lease to — the
 * wrong design is unrepresentable in the client. That is exactly why the finding it was built on
 * needs a probe that does NOT go through the client: if the relay's descriptor binding ever
 * changed, nothing in the suite would notice, and the comment justifying the design would quietly
 * become false while every test kept passing.
 *
 * So this publishes the same document twice with raw `publish_context` calls — once cross-pod under
 * a delegation, once on the delegate's own pod — and prints what `authorship` comes back each time.
 * It concludes nothing and asserts nothing; it prints, and a person reads it.
 *
 * Measured 2026-08-08:
 *   onto the DELEGATOR's pod   authorshipVerified: false — "the proof is signed for owner <the
 *                              delegate's own WebID>", i.e. the binding holds the proof's owner
 *                              against the pod the bytes landed on
 *   onto its OWN pod           authorshipVerified: true, contentBinding: bound
 *
 *   npx tsx applications/shared-workspace/discord/tools/probe-presence-live.ts
 */

import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient,
  agentPort, delegateLabel, presenceIri, presenceTurtle, publishPresence, readPresence,
} from '@interego/workspace-client';
import { mintBearer } from '../../tools/live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (s = ''): void => { process.stdout.write(s + '\n'); };
const head = (s: string): void => { log('\n──── ' + s + ' ' + '─'.repeat(Math.max(0, 66 - s.length))); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function party(clientName?: string): Promise<{ pod: string; agentId: string; client: WorkspaceClient }> {
  const wallet = Wallet.createRandom();
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, await mintBearer(RELAY, IDENTITY, wallet, clientName)));
  await client.connect();
  const st = await client.podStatus();
  const pod = String(st['pod'] ?? '').replace(/\/$/, '').split('/').pop() ?? '';
  const agent = st['sessionAgent'] as { id?: string; did?: string } | undefined;
  return { pod, agentId: agent?.did ?? agent?.id ?? '', client };
}

async function main(): Promise<void> {
  head('two identities: a person and one of their delegates, plus an unrelated reader');
  const [owner, delegate] = await Promise.all([party(), party(DELEGATE_SURFACE)]);
  const reader = await party();
  log('  owner    ' + owner.pod);
  log('  delegate ' + delegate.pod + '  ' + delegate.agentId);
  log('  reader   ' + reader.pod + '  (a third party, no relationship to either)');
  await owner.client.tool('register_agent', { agent_id: delegate.agentId, scope: 'PublishOnly', label: delegateLabel('probe') });

  /** Publish the SAME lease bytes to a named pod, with no client-side address derivation at all. */
  const putAt = async (pod: string, label: string): Promise<string> => {
    const iri = RELAY + '/ns/' + pod + '/probe-lease';
    const now = Date.now();
    const res = await delegate.client.tool('publish_context', {
      pod_name: pod,
      graph_iri: iri,
      graph_content: presenceTurtle({
        iri, agentId: delegate.agentId, principal: null, host: 'a probe',
        createdIso: new Date(now).toISOString(), expiresIso: new Date(now + 180_000).toISOString(),
      }),
      visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
      valid_from: new Date(now).toISOString(), valid_until: new Date(now + 180_000).toISOString(),
    }) as Record<string, unknown>;
    log('  ' + label + ' publish: ' + JSON.stringify(res).slice(0, 200));
    return String(res['descriptorUrl'] ?? '');
  };

  head('★ the identical document, cross-pod and own-pod, read by a third party');
  const crossUrl = await putAt(owner.pod, 'onto the DELEGATOR\'s pod');
  const ownUrl = await putAt(delegate.pod, 'onto its OWN pod       ');
  // Past the relay's own ~10s manifest cache, so a miss is a fact and not a race.
  await sleep(12_000);
  for (const [label, url] of [['cross-pod', crossUrl], ['own-pod  ', ownUrl]] as const) {
    if (!url) { log('  ' + label + ': the publish named no descriptor URL'); continue; }
    try {
      const d = await reader.client.descriptor(url);
      log('  ' + label + ' authorship: ' + JSON.stringify(d['authorship']).slice(0, 420));
    } catch (e) { log('  ' + label + ' get_descriptor FAILED: ' + ((e as Error).message ?? String(e))); }
  }

  head('and the shipped client end to end, which can only ever write to the agent\'s own pod');
  const port = agentPort(delegate.client);
  log('  address it composes: ' + String(presenceIri(RELAY, delegate.agentId)));
  log('  ' + JSON.stringify(await publishPresence(port, {
    relay: RELAY, agentId: delegate.agentId, principal: null, host: 'a probe',
  })).slice(0, 240));
  await sleep(12_000);
  const seen = await readPresence(agentPort(reader.client), { relay: RELAY, agentId: delegate.agentId });
  log('  a third party reads: ' + seen.state + (seen.state === 'running' ? '' : ' — ' + seen.why));
}

main().catch((e: unknown) => { log('PROBE FAILED: ' + ((e as Error)?.stack ?? String(e))); process.exitCode = 1; });
