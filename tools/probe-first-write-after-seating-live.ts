/**
 * THE FIRST THING A NEWLY AUTHORISED DELEGATE DOES, WITH NOBODY CATCHING IT.
 *
 * ★ NO RETRY ANYWHERE IN THIS DRIVER, ON PURPOSE. The measured complaint is that
 * `register_agent` returns, the delegate writes, and the relay answers
 * `Failed to update manifest ... after 8 attempts` — and that a second attempt seconds later
 * lands. A driver that retries cannot see that, and the person being onboarded does not retry:
 * they see a broken first action. So this one asks once and prints whatever comes back.
 *
 * Sequence, against the live fleet with two real identities:
 *
 *   A (a person, the maintainer wallet) → seed one entry so a chain head exists
 *   A → register_agent, seating a fresh delegate key on A's own pod
 *   D (the delegate, its OWN relay session) → ONE publish_context into A's pod, immediately
 *
 * The seed matters: `publish_context` only takes the SYNCHRONOUS branch when a precondition is
 * asserted, and `postEntry` only asserts one when the chain already has a head. Without the
 * seed the delegate's write is deferred and the manifest failure never reaches the caller —
 * it lands in `/publish/status` instead, which is a different (also real) problem.
 *
 *   npx tsx tools/probe-first-write-after-seating-live.ts
 */

import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { DELEGATE_SURFACE, delegateAgentId } from '@interego/core/delegate';
import { RelayMcpTransport } from '@interego/core/relay';
import { mintBearer, type Signer } from '../applications/shared-workspace/tools/live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 66 - s.length))); };

async function session(w: Signer, clientName?: string): Promise<RelayMcpTransport> {
  const bearer = await mintBearer(RELAY, IDENTITY, w, clientName);
  return new RelayMcpTransport(RELAY, bearer);
}

const call = async (t: RelayMcpTransport, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  try { return await t.callTool(name, args, { cache: false }) as Record<string, unknown>; }
  catch (e) { return { _threw: true, message: (e as Error).message, code: (e as { code?: string }).code ?? null }; }
};

async function run(): Promise<number> {
  head('two identities');
  const seedA = (JSON.parse(readFileSync(process.env['INTEREGO_WALLET_A'] ?? '.interego/maintainer.json', 'utf8')) as { privateKey: string }).privateKey;
  const aTx = await session(new Wallet(seedA));
  const aStatus = await call(aTx, 'get_pod_status', {});
  log('A status', JSON.stringify(aStatus).slice(0, 400));
  const aPodUrl = String(aStatus['podUrl'] ?? aStatus['pod'] ?? '');
  const aPod = String(aStatus['podName'] ?? aPodUrl.replace(/\/$/, '').split('/').pop() ?? '');
  const aWebId = String(aStatus['owner'] ?? aStatus['ownerWebId'] ?? '');
  log('A pod', aPod, '· webId', aWebId);

  const dKey = Wallet.createRandom();
  const dTx = await session(dKey, DELEGATE_SURFACE);
  const dStatus = await call(dTx, 'get_pod_status', {});
  const dAgentId = delegateAgentId(new URL(IDENTITY).host, String(dStatus['displayName'] ?? dStatus['podName'] ?? ''));
  log('D agent', dAgentId);

  const stamp = Date.now().toString(36);
  const graphIri = `urn:graph:probe:firstwrite:${stamp}`;

  head('A seeds a chain head so the delegate\'s write asserts a precondition');
  const seed = await call(aTx, 'publish_context', {
    pod_name: aPod, graph_iri: graphIri, visibility: 'public', sync: true,
    graph_content: `<${graphIri}> <http://purl.org/dc/terms/description> "seed ${stamp}" .`,
  });
  log('  seed →', JSON.stringify(seed).slice(0, 260));
  const seedCid = (seed['contentCid'] ?? seed['cid'] ?? seed['descriptorUrl']) as string | undefined;
  const head1 = await call(aTx, 'get_current_head', { urn: graphIri, pod_name: aPod });
  log('  head →', JSON.stringify(head1).slice(0, 300));
  const ifMatch = (head1['cid'] ?? (head1['head'] as Record<string, unknown> | undefined)?.['cid'] ?? seedCid) as string | undefined;

  head('A seats the delegate — register_agent, then NOTHING else');
  const t0 = Date.now();
  const reg = await call(aTx, 'register_agent', {
    agent_id: dAgentId, label: 'delegate First write probe', owner_webid: aWebId, pod_name: aPod, scope: 'ReadWrite',
  });
  log('  register_agent took', Date.now() - t0, 'ms →', JSON.stringify(reg).slice(0, 300));

  head('D writes into A\'s pod IMMEDIATELY — one attempt, no retry');
  const t1 = Date.now();
  const write = await call(dTx, 'publish_context', {
    pod_name: aPod, graph_iri: graphIri, visibility: 'public', sign_authorship: true,
    ...(ifMatch ? { if_match: ifMatch } : { sync: true }),
    graph_content: `<${graphIri}#e1> <http://purl.org/dc/terms/description> "delegate first write ${stamp}" .`,
  });
  const ms = Date.now() - t1;
  log('  first write took', ms, 'ms');
  log('  →', JSON.stringify(write).slice(0, 800));
  const failed = write['_threw'] === true || typeof write['error'] === 'string';
  log('\nVERDICT: the delegate\'s first write ' + (failed ? 'was REPORTED FAILED' : 'was reported accepted'));

  // ★ AND THEN ASK THE POD, because "the relay said no" and "nothing landed" are different
  // claims and only one of them is what the caller was told. A report of failure over a write
  // that committed is a worse defect than the contention it is blaming.
  head('what the pod actually holds for that graph');
  const head2 = await call(aTx, 'get_current_head', { urn: graphIri, pod_name: aPod });
  log('  head →', JSON.stringify(head2).slice(0, 400));
  const disc = await call(aTx, 'discover_context', { pod_name: aPod, graph_iri: graphIri });
  const rows = (disc['results'] ?? disc['descriptors'] ?? disc['matches']) as unknown[] | undefined;
  log('  descriptors describing that graph:', Array.isArray(rows) ? rows.length : JSON.stringify(disc).slice(0, 300));
  if (Array.isArray(rows)) for (const r of rows) log('    ', JSON.stringify(r).slice(0, 220));
  return failed ? 1 : 0;
}

run().then((c) => process.exit(c)).catch((e) => { log('driver threw:', (e as Error).stack ?? String(e)); process.exit(2); });
