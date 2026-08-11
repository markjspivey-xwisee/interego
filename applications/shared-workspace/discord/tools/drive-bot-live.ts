/**
 * THE BOT, DRIVEN END TO END AGAINST THE LIVE RELAY, WITH NO DISCORD.
 *
 * ★ WHAT IS REAL HERE AND WHAT IS NOT — stated first, because a driver that blurs this is worse
 * than no driver.
 *
 *   REAL: every line of `src/workspace.ts`, `src/links.ts` and `src/identity.ts`; three
 *   freshly minted disposable identities with their own wallets and their own relay sessions;
 *   every `register_agent` performed BY THE PARTICIPANT from their own client, which is exactly
 *   what a human does in the desktop app; every workspace document, grant, acceptance and entry
 *   written to `https://relay.interego.xwisee.com` and read back from it.
 *
 *   NOT REAL: Discord. There is no gateway connection, no bot token and no thread. What stands
 *   in for Discord is three constants — a thread id and two user ids — handed to the same
 *   functions the gateway calls. `src/discord.ts` and `src/main.ts` are NOT exercised here;
 *   they are covered by `tests/discord-gateway.test.ts`, which drives the protocol frame by
 *   frame, and by nothing else. Running the actual bot needs a token the maintainer supplies.
 *
 *   npx tsx applications/shared-workspace/discord/tools/drive-bot-live.ts
 *
 * Every write is public and disposable. Nothing touches `u-eth-8f3b8e939600`.
 */

import { Wallet } from 'ethers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayMcpTransport, WorkspaceClient, checkDelegation } from '@interego/workspace-client';
import { mintBearer } from '../../tools/live-identity.js';
import { LinkStore } from '../src/links.js';
import { beginLink, confirmLink, recordMessage, showWorkspace, startWorkspace, unlink, type Deps } from '../src/workspace.js';
import { renderConfirm, renderRecord, renderShow, renderStart } from '../src/render.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

const log = (s = ''): void => { process.stdout.write(s + '\n'); };
const head = (s: string): void => { log('\n──── ' + s + ' ' + '─'.repeat(Math.max(0, 66 - s.length))); };

let failures = 0;
function check(ok: boolean, what: string, detail?: string): void {
  if (!ok) failures++;
  log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '\n         ' + detail : ''));
}

interface Party { readonly pod: string; readonly agentId: string; readonly client: WorkspaceClient }

async function party(): Promise<Party> {
  const wallet = Wallet.createRandom();
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, await mintBearer(RELAY, IDENTITY, wallet)));
  await client.connect();
  const st = await client.podStatus();
  const pod = String(st['pod'] ?? '').replace(/\/$/, '').split('/').pop() ?? '';
  const agent = st['sessionAgent'] as { id?: string; did?: string } | undefined;
  return { pod, agentId: agent?.did ?? agent?.id ?? '', client };
}

/** Discord ids. Snowflake-shaped because the bot refuses anything that is not. */
const THREAD = '1394001122334455667';
const ALICE_DISCORD = '1100000000000000001';
const BOB_DISCORD = '1100000000000000002';
const CHARLIE_DISCORD = '1100000000000000003';

async function main(): Promise<void> {
  head('three identities: the bot, and two people who will speak in the thread');
  const bot = await party();
  const alice = await party();
  const bob = await party();
  log('  bot   pod=' + bot.pod + '\n        agent=' + bot.agentId);
  log('  alice pod=' + alice.pod);
  log('  bob   pod=' + bob.pod);

  const store = new LinkStore(join(mkdtempSync(join(tmpdir(), 'interego-discord-')), 'state.json'));
  const deps: Deps = { relay: RELAY, client: bot.client, agentId: bot.agentId, store };

  head('/workspace start before linking');
  const early = await startWorkspace(deps, { threadId: THREAD, threadName: 'design review', discordUserId: ALICE_DISCORD });
  check(early.kind === 'not-linked', 'refuses to create a workspace for somebody with no pod', early.kind);

  head('/workspace link — alice');
  const ch = beginLink(deps, ALICE_DISCORD);
  check(ch.agentId === bot.agentId, 'the instruction names the bot\'s real agent id');
  check(ch.label === 'discord-link ' + ALICE_DISCORD, 'and the label names the account it is FOR, not a secret', ch.label);
  log('  label the participant must publish: ' + ch.label);

  head('a pod that has delegated nothing is refused; junk never reaches a tool call');
  const wrongPod = await confirmLink(deps, { discordUserId: ALICE_DISCORD, podName: bob.pod });
  check(wrongPod.kind === 'refused', 'bob\'s pod carries no delegation for alice', wrongPod.kind);
  const junk = await confirmLink(deps, { discordUserId: ALICE_DISCORD, podName: 'not-a-pod' });
  check(junk.kind === 'bad-pod', 'a non-pod string never reaches a tool call', junk.kind);

  head('alice publishes the delegation FROM HER OWN CLIENT (this is the human step)');
  const reg = await alice.client.tool('register_agent', { agent_id: bot.agentId, scope: 'PublishOnly', label: ch.label }) as Record<string, unknown>;
  check(reg['registered'] === true || reg['repaired'] === true, 'register_agent accepted on her own pod', JSON.stringify(reg).slice(0, 200));

  head('/workspace link-confirm — alice');
  const linked = await confirmLink(deps, { discordUserId: ALICE_DISCORD, podName: alice.pod });
  log(renderConfirm(linked).content);
  check(linked.kind === 'linked', 'alice is bound to her own pod', linked.kind === 'refused' ? linked.why : linked.kind);

  head('★ the published label is readable by anybody, and useless to them');
  // ★ THE DEFECT THIS REPLACED, DRIVEN. Alice's delegation row is world-readable and its label
  // is now public. Bob reads it out of the BOT's session — a third party's — opens his own link
  // window, and tries to bind HER pod to HIS Discord account. Under the first design, where the
  // label was a minted nonce and possession was the proof, this succeeded and Bob's messages
  // would have landed on Alice's pod under her WebID.
  const aliceStatus = await bot.client.tool('get_pod_status', { pod_name: alice.pod }, { cache: false }) as Record<string, unknown>;
  const rows = ((aliceStatus['delegationRegistry'] as { rows?: readonly { agentId?: string; label?: string }[] } | undefined)?.rows) ?? [];
  const publicLabel = rows.find((r) => r.agentId === bot.agentId)?.label ?? '';
  check(publicLabel === ch.label, 'the label IS readable from another party\'s session', publicLabel);
  beginLink(deps, BOB_DISCORD);
  const steal = await confirmLink(deps, { discordUserId: BOB_DISCORD, podName: alice.pod });
  check(steal.kind === 'contested' || steal.kind === 'refused', 'and bob still cannot bind his account to her pod', steal.kind);

  head('/workspace start — alice convenes');
  const started = await startWorkspace(deps, { threadId: THREAD, threadName: 'design review', discordUserId: ALICE_DISCORD });
  log(renderStart(started).content);
  check(started.kind === 'created', 'the workspace was created on alice\'s own pod', started.kind === 'create-failed' ? started.detail : started.kind);
  if (started.kind !== 'created') { log('\nnothing further can be driven.'); process.exitCode = 1; return; }
  const workspace = started.binding.workspace;
  check(workspace.indexOf(RELAY + '/ns/' + alice.pod + '/') === 0, 'the workspace IRI is under alice\'s pod, not the bot\'s', workspace);

  head('an unlinked participant is ignored — visibly');
  const ignored = await recordMessage(deps, { threadId: THREAD, discordUserId: CHARLIE_DISCORD, text: 'am I in the record?' });
  check(ignored.kind === 'unlinked', 'charlie is not recorded and is told so', ignored.kind);
  log(renderRecord(ignored)?.content ?? '(nothing)');

  head('alice speaks');
  const a1 = await recordMessage(deps, { threadId: THREAD, discordUserId: ALICE_DISCORD, text: 'Opening the review. The question is whether the fold is deterministic.' });
  log(renderRecord(a1)?.content ?? '(nothing)');
  check(a1.kind === 'recorded' && a1.outcome.kind === 'accepted', 'alice\'s first entry was accepted', a1.kind === 'recorded' ? a1.outcome.kind : a1.kind);
  if (a1.kind === 'recorded') {
    check(a1.pod === alice.pod, 'it landed on alice\'s pod', a1.pod);
    check(a1.streamIri.indexOf(RELAY + '/ns/' + alice.pod + '/') === 0, 'her stream is under her own pod', a1.streamIri);
    check(a1.authorship?.signerAgent === bot.agentId, 'the signature names the BOT as the agent that asked — not alice', String(a1.authorship?.signerAgent));
    check(a1.authorship?.contentBinding === 'bound-at-signing', 'and it is bound to the entry\'s content', String(a1.authorship?.contentBinding));
  }

  head('bob links and speaks — a second author, a second pod');
  const bch = beginLink(deps, BOB_DISCORD);
  await bob.client.tool('register_agent', { agent_id: bot.agentId, scope: 'PublishOnly', label: bch.label });
  const bLinked = await confirmLink(deps, { discordUserId: BOB_DISCORD, podName: bob.pod });
  check(bLinked.kind === 'linked', 'bob is bound to his own pod', bLinked.kind === 'refused' ? bLinked.why : bLinked.kind);
  const b1 = await recordMessage(deps, { threadId: THREAD, discordUserId: BOB_DISCORD, text: 'It is not, if two clients disagree about which pod holds the grants.' });
  log(renderRecord(b1)?.content ?? '(nothing)');
  check(b1.kind === 'recorded' && b1.outcome.kind === 'accepted', 'bob\'s entry was accepted', b1.kind === 'recorded' ? b1.outcome.kind : b1.kind);
  if (b1.kind === 'recorded') {
    check(b1.pod === bob.pod, 'it landed on BOB\'s pod, not alice\'s and not the bot\'s', b1.pod);
    check(b1.seated === 'just-now', 'he was seated on first speaking: a grant on alice\'s pod, an acceptance on his', b1.seated);
  }

  head('alice speaks again — the chain has to advance, not fork');
  const a2 = await recordMessage(deps, { threadId: THREAD, discordUserId: ALICE_DISCORD, text: 'Then that is the defect. One implementation, three clients.' });
  log(renderRecord(a2)?.content ?? '(nothing)');
  check(a2.kind === 'recorded' && a2.outcome.kind === 'accepted' && a2.outcome.seq === 1, 'her second entry is #1 and asserts the first as its prior',
    a2.kind === 'recorded' && a2.outcome.kind === 'accepted' ? 'seq=' + a2.outcome.seq + ' ifMatch=' + String(a2.outcome.ifMatch) : a2.kind);

  head('/workspace show — the composed view');
  const view = await showWorkspace(deps, THREAD);
  // Every part: this render can exceed Discord's per-message limit and now returns each one.
  log(renderShow(view).map((p) => p.content).join('\n'));
  check(view.kind === 'view', 'the workspace composed', view.kind);
  if (view.kind === 'view') {
    const seated = view.fold.seats.filter((s) => s.seated);
    check(seated.length === 2, 'two seats folded from two pods', 'seats=' + view.fold.seats.length + ' seated=' + seated.length
      + ' · ' + view.fold.seats.map((s) => (s.podServed ?? s.pod) + ':' + (s.seated ? 'seated' : String(s.why))).join(' | '));
    check(view.totalEntries === 3, 'three entries across the two logs', 'total=' + view.totalEntries);
    const bodies = view.entries.map((e) => e.body ?? '');
    check(bodies.some((b) => b.startsWith('Opening the review')) && bodies.some((b) => b.startsWith('It is not,')),
      'both authors\' words are in the composed view', bodies.join(' ⏐ ').slice(0, 220));
    const pods = new Set(view.entries.map((e) => e.pod));
    check(pods.size === 2, 'and they were read from two different pods', [...pods].join(', '));
  }

  head('alice revokes from her own client — the bot must stop, and not wait for the relay to');
  await alice.client.tool('revoke_agent', { agent_id: bot.agentId });
  const gate = await checkDelegation(bot.client, { agentId: bot.agentId, podName: alice.pod });
  check(!gate.ok, 'the bot can see the delegation is gone', gate.why ?? 'still ok');
  const after = await recordMessage(deps, { threadId: THREAD, discordUserId: ALICE_DISCORD, text: 'this must not be written' });
  check(after.kind === 'not-delegated', 'and refuses to write, though the relay\'s own 60s scope cache would still have let it', after.kind);
  log(renderRecord(after)?.content ?? '(nothing)');

  head('bob is unaffected by alice\'s revocation');
  const b2 = await recordMessage(deps, { threadId: THREAD, discordUserId: BOB_DISCORD, text: 'Still here. My pod, my delegation.' });
  check(b2.kind === 'recorded' && b2.outcome.kind === 'accepted', 'bob can still write', b2.kind);

  head('/workspace unlink says what it did and did not do');
  const un = unlink(deps, BOB_DISCORD);
  check(un.kind === 'unlinked' && un.agentId === bot.agentId, 'it names the agent the user must revoke themselves', un.kind);
  const post = await recordMessage(deps, { threadId: THREAD, discordUserId: BOB_DISCORD, text: 'after unlink' });
  check(post.kind === 'unlinked', 'and the bot stops recording him', post.kind);

  head('what alice already wrote is untouched by all of it');
  const final = await showWorkspace(deps, THREAD);
  check(final.kind === 'view' && final.totalEntries >= 4, 'the record still stands and still reads', final.kind === 'view' ? 'total=' + final.totalEntries : final.kind);
  log('\n  the workspace anyone can follow: ' + workspace);

  log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks passed'));
  if (failures) process.exitCode = 1;
}

main().catch((e: unknown) => { log('DRIVER FAILED: ' + ((e as Error)?.stack ?? String(e))); process.exitCode = 1; });
