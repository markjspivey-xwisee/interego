/**
 * AGENTS IN THE CHANNEL, DRIVEN END TO END AGAINST THE LIVE RELAY.
 *
 * ★ WHAT IS REAL HERE AND WHAT IS NOT — stated first, because a driver that blurs this is worse
 * than no driver.
 *
 *   REAL: five freshly minted identities on `https://relay.interego.xwisee.com`, each with its own
 *   wallet and its own relay session — two people, two of their DELEGATES (each signed in under
 *   `DELEGATE_SURFACE`, exactly as the desktop app signs a delegate key in), and the conduit. Every
 *   `register_agent` is performed BY the pod's owner from their own client. Every presence lease,
 *   capability document, workspace document, grant, acceptance, entry and inbox notice is written
 *   to the live relay and read back from it. `askCandidates`, `resolveTarget`, `ask`,
 *   `readPresence`, `publishPresence`, `readRequests`, `verifyRequest`, `decideTurn`, `checkDraft`
 *   and `showWorkspace` are the shipped functions, unmocked.
 *
 *   NOT REAL: Discord, and the model. There is no gateway and no bot token — three snowflake
 *   constants stand in for a thread and two accounts, handed to the same functions the gateway
 *   calls. And the delegate's ANSWER is a fixed string rather than a spawned `claude`: this driver
 *   runs in CI and on a machine with no subscription, and spending somebody's tokens to prove that
 *   a string round-trips would be the wrong trade. What IS driven is everything on both sides of
 *   the model call — `decideTurn` deciding there is something to answer, and `checkDraft` refusing
 *   a draft with no footing and accepting one with it.
 *
 *   npx tsx applications/shared-workspace/discord/tools/drive-agents-live.ts
 *
 * Every write is public and disposable. Nothing touches `u-eth-8f3b8e939600`.
 */

import { Wallet } from 'ethers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient,
  admitSeatedIn, agentInbox, agentPort, capabilitiesIri, checkDraft, decideTurn, delegateLabel, delegatePort,
  isPresent, orderChain, parseRoleProfile, postEntry, presenceIri, presenceLine, publishCapability,
  publishPresence, readCapabilities, readDelegates, readPresence, readRequests, toChainRow,
  verifyRequest, PRESENCE_LEASE_MS,
  type Presence, type SeenEntry,
} from '@interego/workspace-client';
import { RESPOND_AS_MEMBER } from '../../affordances.js';
import { mintBearer } from '../../tools/live-identity.js';
import { LinkStore } from '../src/links.js';
import { ask, askCandidates, askChoices, resolveTarget } from '../src/ask.js';
import { beginLink, confirmLink, recordMessage, showWorkspace, startWorkspace, type Deps } from '../src/workspace.js';
import { renderAsk, renderNews, renderShow, renderWho } from '../src/render.js';
import type { WatchNews } from '../src/watch.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

const log = (s = ''): void => { process.stdout.write(s + '\n'); };
const head = (s: string): void => { log('\n──── ' + s + ' ' + '─'.repeat(Math.max(0, 68 - s.length))); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * WAIT PAST THE RELAY'S OWN CACHE BEFORE READING BACK WHAT WAS JUST WRITTEN.
 *
 * ★ MEASURED, AND THE FIRST RUN OF THIS DRIVER FAILED FOUR CHECKS ON IT. Two separate deferrals sit
 * between a `publish_context` and a read that can see it: `discover_context` is served from a
 * manifest cache with a roughly ten-second window, and a descriptor is fetchable a few seconds
 * after the publish that created it. Read immediately and a freshly published lease comes back
 * `never` — indistinguishable, from the assertion's point of view, from a lease that was never
 * written. That is a property of the substrate and NOT a defect in the reader: it is exactly why
 * {@link PRESENCE_RENEW_MS} is ninety seconds rather than five, so a real host's lease is always
 * many cache-windows old by the time anybody looks at it.
 *
 * A driver that asserts one second after writing is measuring the cache, not the design.
 */
const CACHE_WINDOW_MS = 12_000;
const settle = async (why: string): Promise<void> => {
  log('  … waiting ' + (CACHE_WINDOW_MS / 1000) + 's past the relay\'s manifest cache before ' + why);
  await sleep(CACHE_WINDOW_MS);
};

let failures = 0;
/** Every part of a render, joined — these renderers may return more than one message. */
const whole = (m: { readonly content: string }[] | readonly { readonly content: string }[] | null | undefined): string =>
  (m ?? []).map((x) => x.content).join('\n');

function check(ok: boolean, what: string, detail?: string): void {
  if (!ok) failures++;
  log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '\n         ' + detail : ''));
}

interface Party { readonly pod: string; readonly agentId: string; readonly client: WorkspaceClient }

/**
 * One live identity.
 *
 * ★ `clientName` MATTERS AND IS NOT COSMETIC. The relay bakes the OAuth client name into the agent
 * DID it issues, so a delegate signed in under anything but `DELEGATE_SURFACE` would be a different
 * identity from the one the desktop app produces from the same key — and the whole point of this
 * drive is that the DIDs match what a real host would publish.
 */
/**
 * ★ MINTED ONE AT A TIME, AND A 429 IS WAITED OUT RATHER THAN FATAL.
 *
 * Measured: `oauth-router.ts` limits client registration to TWENTY PER HOUR. Six registrations
 * fired as one `Promise.all` answered `HTTP 429 too_many_requests` and the driver died before its
 * first check — a failure that says nothing whatever about the design and everything about how
 * fast this asked. Worse, it is the shape of failure that gets read as "the feature is broken".
 *
 * Two changes, and neither is a workaround for a real limit: the mints are serialised with a gap,
 * because a real deployment mints one identity per host per install and bursting was never
 * realistic; and a 429 is retried on a long backoff, because the window is an hour and a driver
 * that gives up on a limit it will outlive is a driver nobody can run twice in a row.
 */
let lastMint = 0;
const MINT_GAP_MS = 3_000;
const MINT_RETRY_MS = 5 * 60_000;
const MINT_TRIES = 14;

async function party(clientName?: string): Promise<Party> {
  const wait = lastMint + MINT_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const wallet = Wallet.createRandom();
  let bearer: Awaited<ReturnType<typeof mintBearer>> | null = null;
  for (let attempt = 1; attempt <= MINT_TRIES && bearer === null; attempt++) {
    lastMint = Date.now();
    try { bearer = await mintBearer(RELAY, IDENTITY, wallet, clientName); }
    catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (msg.indexOf('429') < 0 || attempt === MINT_TRIES) throw e;
      log('  … the relay\'s client-registration limit (20/hour) is spent; waiting '
        + (MINT_RETRY_MS / 60_000) + 'm and trying again (' + attempt + '/' + MINT_TRIES + ')');
      await sleep(MINT_RETRY_MS);
    }
  }
  if (bearer === null) throw new Error('the mint loop ended with no bearer, which every path above returns or throws before');
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const st = await client.podStatus();
  const pod = String(st['pod'] ?? '').replace(/\/$/, '').split('/').pop() ?? '';
  const agent = st['sessionAgent'] as { id?: string; did?: string } | undefined;
  return { pod, agentId: agent?.did ?? agent?.id ?? '', client };
}

const THREAD = '1394001122334455999';
const ALICE_DISCORD = '1100000000000000011';
const BOB_DISCORD = '1100000000000000012';

async function main(): Promise<void> {
  head('six live identities');
  const bot = await party();
  const alice = await party();
  const bob = await party();
  const reader = await party();
  // The two delegates sign in under the DELEGATE surface, which is what puts
  // `interego-delegate-<their own pod>` in the DID — the string presence documents are named from.
  const scribe = await party(DELEGATE_SURFACE);
  const aideDeCamp = await party(DELEGATE_SURFACE);
  log('  bot     pod=' + bot.pod + '  agent=' + bot.agentId);
  log('  alice   pod=' + alice.pod);
  log('  bob     pod=' + bob.pod);
  log('  scribe  pod=' + scribe.pod + '  agent=' + scribe.agentId + '   (BOB\'s delegate)');
  log('  aide    pod=' + aideDeCamp.pod + '  agent=' + aideDeCamp.agentId + '   (ALICE\'s delegate)');
  check(scribe.agentId.indexOf(DELEGATE_SURFACE + '-' + scribe.pod) > 0,
    'a delegate\'s DID carries its OWN pod, which is what makes presence per-agent', scribe.agentId);

  const store = new LinkStore(join(mkdtempSync(join(tmpdir(), 'interego-agents-')), 'state.json'));
  const deps: Deps = { relay: RELAY, client: bot.client, agentId: bot.agentId, store };

  head('the two humans link their pods and the thread becomes a workspace');
  for (const [who, p] of [[ALICE_DISCORD, alice], [BOB_DISCORD, bob]] as const) {
    const ch = beginLink(deps, who);
    await p.client.tool('register_agent', { agent_id: bot.agentId, scope: 'PublishOnly', label: ch.label });
    const linked = await confirmLink(deps, { discordUserId: who, podName: p.pod });
    check(linked.kind === 'linked', 'pod ' + p.pod + ' is bound to its own Discord account', linked.kind);
  }
  const started = await startWorkspace(deps, { threadId: THREAD, threadName: 'roof decision', discordUserId: ALICE_DISCORD });
  check(started.kind === 'created', 'alice convened the workspace on her own pod', started.kind === 'create-failed' ? started.detail : started.kind);
  if (started.kind !== 'created') { log('\nnothing further can be driven.'); process.exitCode = 1; return; }
  const workspace = started.binding.workspace;
  // Bob speaks once, which is what seats him. Nothing seats a member who never says anything.
  const seatBob = await recordMessage(deps, { threadId: THREAD, discordUserId: BOB_DISCORD, text: 'Photos from the roof are in the shared folder.' });
  check(seatBob.kind === 'recorded', 'bob is seated on first speaking', seatBob.kind);

  head('each human authorises their OWN delegate, from their OWN client');
  await bob.client.tool('register_agent', { agent_id: scribe.agentId, scope: 'PublishOnly', label: delegateLabel('bob-scribe') });
  await alice.client.tool('register_agent', { agent_id: aideDeCamp.agentId, scope: 'PublishOnly', label: delegateLabel('alice-aide') });
  const bobRoster = await readDelegates(delegatePort(bot.client), bob.pod);
  check(bobRoster.delegates.some((d) => d.agentId === scribe.agentId && d.name === 'bob-scribe'),
    'the conduit reads bob-scribe out of BOB\'s own registry, cross-pod', bobRoster.delegates.map((d) => d.name).join(', '));

  head('★ before any host runs: the picker says so rather than pretending');
  const cold = await askCandidates(deps, { threadId: THREAD, discordUserId: ALICE_DISCORD });
  if (cold.kind !== 'candidates') { check(false, 'the roster folded', cold.kind); process.exitCode = 1; return; }
  const coldScribe = cold.targets.find((t) => t.agentId === scribe.agentId);
  check(coldScribe?.presence.state === 'never', 'bob-scribe has never said it was running', coldScribe?.presence.state);
  check(!isPresent(coldScribe?.presence as Presence), 'and "never" is not presence', presenceLine(coldScribe?.presence as Presence));
  log(whole(renderWho(cold)).split('\n').slice(0, 8).join('\n'));

  head('★ bob\'s host comes up and publishes a lease, ON THE DELEGATE\'S OWN POD, WITH ITS OWN KEY');
  const scribePort = agentPort(scribe.client);
  const readerPort = agentPort(bot.client);
  const beat = await publishPresence(scribePort, {
    relay: RELAY, agentId: scribe.agentId,
    principal: null, host: 'a live driver standing in for the desktop app',
  });
  check(beat.kind === 'published', 'the lease was accepted onto the DELEGATE\'s own pod',
    beat.kind === 'published' ? beat.iri : JSON.stringify(beat).slice(0, 200));
  check(beat.kind === 'published' && beat.iri === presenceIri(RELAY, scribe.agentId),
    'at the address every other reader composes from the DID alone — no pod argument anywhere');
  await settle('a third party reads that lease');
  const live = await readPresence(readerPort, { relay: RELAY, agentId: scribe.agentId });
  check(live.state === 'running', 'and a THIRD party reads it back as running', live.state === 'running' ? presenceLine(live) : JSON.stringify(live).slice(0, 240));

  head('★ nobody else can publish presence for that delegate');
  // Alice holds no key for bob-scribe and the lease lives on the delegate's OWN pod, which the
  // relay lets only that key write. A lease she could fabricate does not exist.
  let forgedByOther = 'accepted';
  try {
    const r = await alice.client.tool('publish_context', {
      pod_name: scribe.pod, graph_iri: presenceIri(RELAY, scribe.agentId) as string,
      graph_content: '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n<x> a iep:PresenceLease .\n',
      visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
    }) as Record<string, unknown>;
    forgedByOther = r['error'] ? 'refused: ' + String(r['message'] ?? r['error']) : 'accepted';
  } catch (e) { forgedByOther = 'refused: ' + ((e as Error).message ?? ''); }
  check(forgedByOther.startsWith('refused'), 'alice cannot write a lease onto the delegate\'s pod at all', forgedByOther.slice(0, 160));

  head('★ the forged-lease guard: a long lease is a document, not presence');
  // Published by the DELEGATE itself — properly signed, properly attributed, on its own pod — and
  // still refused, because a lease that never has to be renewed says nothing about now. This
  // bypasses `publishPresence`'s own clamp on purpose: the READER must not depend on the writer
  // having behaved, because the writer is somebody else's process.
  const year = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
  const scribeLease = presenceIri(RELAY, scribe.agentId) as string;
  await scribe.client.tool('publish_context', {
    pod_name: scribe.pod, graph_iri: scribeLease,
    graph_content: '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
      + '@prefix dct: <http://purl.org/dc/terms/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n'
      + '<' + scribeLease + '>\n  a iep:PresenceLease ;\n'
      + '  iep:presenceOf <' + scribe.agentId + '> ;\n'
      + '  dct:created "' + new Date().toISOString() + '"^^xsd:dateTime ;\n'
      + '  iep:leaseExpires "' + year + '"^^xsd:dateTime .\n',
    visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
    valid_from: new Date().toISOString(), valid_until: year,
  });
  await settle('the overlong lease becomes the visible head');
  const overlong = await readPresence(readerPort, { relay: RELAY, agentId: scribe.agentId });
  check(overlong.state === 'overlong', 'a 365-day lease is reported as overlong, NOT as running', overlong.state);
  check(!isPresent(overlong), 'and it is not presence');
  // Put an honest lease back so the rest of the drive is about the ordinary case.
  await publishPresence(scribePort, { relay: RELAY, agentId: scribe.agentId, principal: null, host: 'a live driver' });
  await settle('the honest lease becomes the visible head again');
  check((await readPresence(readerPort, { relay: RELAY, agentId: scribe.agentId })).state === 'running',
    'and republishing an honest one restores it');

  head('★ the picker, live: two humans, two delegates, one of them running');
  const warm = await askCandidates(deps, { threadId: THREAD, discordUserId: ALICE_DISCORD });
  if (warm.kind !== 'candidates') { check(false, 'the roster folded', warm.kind); process.exitCode = 1; return; }
  log(whole(renderWho(warm)));
  const choices = askChoices(warm, '');
  check(choices.some((c) => c.value === scribe.agentId), 'the picker offers bob-scribe by its full agent DID');
  check(choices.every((c) => c.value.startsWith('did:')), 'and every choice is a DID, never a nickname', choices.map((c) => c.value).join(' '));
  check((choices[0]?.name ?? '').indexOf('said so') > 0, 'the running one is offered first and says when it said so', choices[0]?.name);
  const byLabel = await resolveTarget(deps, { threadId: THREAD, discordUserId: ALICE_DISCORD, spec: 'bob-scribe' });
  check(byLabel.kind === 'resolved', 'a bare label resolves through the same two reads', byLabel.kind);

  head('★ ALICE ASKS BOB\'S AGENT — the ask is an entry in the channel');
  const asked = await ask(deps, {
    threadId: THREAD, discordUserId: ALICE_DISCORD, spec: scribe.agentId,
    task: 'Before we decide: do the photos show whether the underlay is dry? Patching only makes sense if it is.',
  });
  log(renderAsk(asked).content);
  check(asked.kind === 'asked', 'the ask was written', asked.kind === 'not-written' ? JSON.stringify(asked.record).slice(0, 200) : asked.kind);
  if (asked.kind !== 'asked') { process.exitCode = 1; return; }
  check(asked.record.pod === alice.pod, 'on ALICE\'s pod — she said it, so it is hers', asked.record.pod);
  check(asked.notice.attempted === false, 'and NO notice was sent, because the host said it was running');
  const askUrl = asked.descriptorUrl as string;

  await settle('the ask\'s own descriptor is fetchable');
  const askDoc = await bot.client.descriptor(askUrl);
  const askTtl = String((askDoc['graph'] as { content?: string }).content ?? '');
  check(askTtl.indexOf('iep:addressedTo <' + scribe.agentId + '>') > 0,
    'iep:addressedTo is INSIDE the signed region, so a relayer cannot change who it is for');
  check((askDoc['authorship'] as { contentBinding?: string })?.contentBinding === 'bound',
    'and the signature covers those bytes', String((askDoc['authorship'] as { contentBinding?: string })?.contentBinding));

  head('★ BOB\'S AGENT READS THE CHANNEL — no notification involved');
  const view = await showWorkspace(deps, THREAD);
  if (view.kind !== 'view') { check(false, 'the channel composed', view.kind); process.exitCode = 1; return; }
  const seen: SeenEntry[] = view.entries.map((e) => ({
    pod: e.pod, descriptorUrl: e.descriptorUrl, body: e.body, derivedFrom: e.derivedFrom,
    at: e.created ? Date.parse(e.created) : null,
    author: e.author ?? { kind: 'unstated', why: 'this reader did not resolve an author' },
    // ★ THE REAL PREDICATE OUT OF THE REAL SIGNED REGION, not `[]`. Passing an empty list would
    // make every entry look unaddressed, and this driver's whole claim past this point is that
    // `decideTurn` picks ALICE'S ASK because the ask names this delegate — a claim an empty list
    // would satisfy for the wrong reason.
    addressedTo: e.addressedTo,
  }));
  // ★ THE REAL ROLE TABLE, READ FROM THE WORKSPACE. An empty one is not a neutral stand-in: the
  // role ceiling refuses a role its table does not define, so passing `new Map()` made every
  // decision come back "this workspace's role profile has not resolved" — a refusal about the
  // FIXTURE that reads exactly like a refusal about the design.
  const roles = parseRoleProfile((await bot.client.fetchProfileTurtle(view.record.roleProfile as string)).turtle);
  check(roles.roles.size > 0, 'the workspace\'s own role table resolved', String(roles.roles.size) + ' role(s)');
  const decision = decideTurn({
    workspace, slug: started.binding.slug, mePod: bob.pod,
    delegate: { agentId: scribe.agentId, name: 'bob-scribe', scope: 'PublishOnly' },
    seats: view.fold.seats, roles,
    entries: seen, unreadable: 0, answeredHere: [],
  });
  check(decision.kind === 'answer', 'decideTurn says there is something to answer', decision.kind === 'answer' ? 'answering ' + decision.answering.descriptorUrl : decision.why);
  check(decision.kind === 'answer' && decision.answering.descriptorUrl === askUrl,
    'and it is ALICE\'S ASK it is answering', decision.kind === 'answer' ? decision.answering.descriptorUrl : '');

  head('★ the footing is required, not defaulted');
  const noFooting = checkDraft('The photos do not show the underlay.', { principal: 'https://x/me' });
  check(!noFooting.ok, 'a draft with no footing declaration is refused outright', noFooting.ok ? '' : noFooting.why.slice(0, 120));
  const draft = checkDraft(
    'FOOTING: MY OWN ACCOUNT\nThe photos in entry 2 are all top-side. Nothing there shows the underlay, so patching '
    + 'versus re-tiling is not decidable from what is in this channel. I would get that one answer before deciding.',
    { principal: 'https://x/me' });
  check(draft.ok && draft.footing.kind === 'own-account', 'and one that declares its own account is accepted');
  if (!draft.ok) { process.exitCode = 1; return; }

  head('★ the delegate answers IN ITS OWN NAME, on its human\'s pod');
  const seat = view.fold.seats.find((s) => (s.podServed ?? s.pod) === bob.pod && s.seated);
  const answer = await postEntry(scribe.client, {
    podName: bob.pod, streamIri: seat?.stream as string, workspace,
    body: draft.body, author: { kind: 'delegate', agentId: scribe.agentId, footing: draft.footing },
    entryShape: view.record.entryShape,
  });
  check(answer.kind === 'accepted', 'the delegate\'s own session wrote to its delegator\'s pod', answer.kind === 'accepted' ? 'seq=' + answer.seq : JSON.stringify(answer).slice(0, 200));

  head('★ AND IT APPEARS IN THE CHANNEL, ATTRIBUTED, WITH ITS FOOTING');
  const after = await showWorkspace(deps, THREAD);
  if (after.kind !== 'view') { check(false, 'the channel re-composed', after.kind); process.exitCode = 1; return; }
  const reply = after.entries.find((e) => e.descriptorUrl === (answer.kind === 'accepted' ? answer.descriptorUrl : ''));
  check(!!reply, 'the answer is in the composed view');
  check(reply?.author?.kind === 'delegate', 'read as a DELEGATE\'s entry, not the pod owner\'s', reply?.author?.kind);
  check(reply?.author?.kind === 'delegate' && reply.author.footing.kind === 'own-account',
    'speaking on its OWN account, which is what it declared', reply?.author?.kind === 'delegate' ? reply.author.footing.kind : '');
  check(reply?.author?.kind === 'delegate' && reply.author.authorised === true,
    'and BOB\'s own registry authorises it — a separate fact, read from a separate document');
  const news = renderNews({ kind: 'entries', binding: started.binding, entries: [reply as never] } as WatchNews);
  log('  what the channel would show:\n' + whole(news).split('\n').map((l) => '  ' + l).join('\n'));
  check(whole(news).indexOf('for itself') > 0, 'and the pushed line names the footing');

  head('★ AN AGENT ASKS ANOTHER AGENT — alice\'s delegate addresses bob\'s');
  const aliceSeat = after.fold.seats.find((s) => (s.podServed ?? s.pod) === alice.pod && s.seated);
  const a2a = await postEntry(aideDeCamp.client, {
    podName: alice.pod, streamIri: aliceSeat?.stream as string, workspace,
    body: 'FOLLOW-UP: can you list which photo numbers would settle it, so somebody can go and take them?',
    author: { kind: 'delegate', agentId: aideDeCamp.agentId, footing: { kind: 'own-account' } },
    entryShape: after.record.entryShape, addressedTo: [scribe.agentId],
  });
  check(a2a.kind === 'accepted', 'alice\'s delegate wrote an ask addressed to bob\'s delegate', a2a.kind);
  if (a2a.kind === 'accepted' && a2a.descriptorUrl) {
    await settle('the agent-to-agent ask is fetchable');
    const d = await bot.client.descriptor(a2a.descriptorUrl);
    const ttl = String((d['graph'] as { content?: string }).content ?? '');
    check(ttl.indexOf('iep:addressedTo <' + scribe.agentId + '>') > 0, 'addressed, in the signed region, agent to agent');
    check(ttl.indexOf('actedOnOwnAccount') > 0, 'and on its own account, which alice is not answerable for');
  }

  head('★ THE ABSENT CASE: a lease that lapses, and an ask that waits');
  // A two-second lease, published honestly and then simply not renewed. Nothing retracts it and
  // nothing times it out: the relay's own temporal filter stops answering for it.
  // ★ AN ORDINARY LEASE, LEFT TO LAPSE — NOT A SHORT ONE, AND THE FIRST RUN OF THIS DRIVER SHOWED
  // WHY. It published a 2s lease after a 180s one and then asserted `stale`; the read came back
  // `running`, from the EARLIER lease, which was still inside its own window. `readPresence` takes
  // the newest row the relay reports as live at this instant, and a shorter lease published later
  // does not shorten a longer one published earlier — nothing retracts, by design.
  //
  // In real operation this cannot arise: every lease `publishPresence` writes is the same length,
  // so the newest is always the last to expire and the newest is always the one that governs.
  // Mixing lengths is something only a driver does, and asserting on it measured an edge the
  // product does not produce. So this uses the real length and really waits.
  await publishPresence(scribePort, { relay: RELAY, agentId: scribe.agentId, principal: null, host: 'a live driver about to stop' });
  await settle('the final lease becomes visible');
  check((await readPresence(readerPort, { relay: RELAY, agentId: scribe.agentId })).state === 'running', 'the last lease this host will ever publish reads as running');
  log('  … letting it lapse over ' + (PRESENCE_LEASE_MS / 1000) + 's, with nothing retracted and no timer anywhere');
  // Polled rather than slept blind, so what is reported is WHEN it decayed rather than only that it
  // had by the time somebody looked.
  const stoppedAt = Date.now();
  let lapsed = await readPresence(readerPort, { relay: RELAY, agentId: scribe.agentId });
  while (lapsed.state === 'running' && Date.now() - stoppedAt < PRESENCE_LEASE_MS + 60_000) {
    await sleep(10_000);
    lapsed = await readPresence(readerPort, { relay: RELAY, agentId: scribe.agentId });
  }
  log('  … it stopped reading as running ' + Math.round((Date.now() - stoppedAt) / 1000) + 's after the last publish');
  check(lapsed.state === 'stale', 'once it lapses it is stale, with nothing having been retracted', lapsed.state + ' · ' + presenceLine(lapsed));

  const waiting = await ask(deps, {
    threadId: THREAD, discordUserId: ALICE_DISCORD, spec: scribe.agentId,
    task: 'While you are at it, what did the roofer quote for the full re-tile?',
  });
  log(renderAsk(waiting).content);
  check(waiting.kind === 'asked', 'the ask is still written, whatever the host is doing', waiting.kind);
  if (waiting.kind !== 'asked') { process.exitCode = 1; return; }
  check(waiting.notice.attempted, 'and NOW a notice was sent, because the host is not saying it is up');
  check(waiting.notice.delivered, 'delivered into an inbox', waiting.notice.why ?? 'ok');
  // ★★ INTO THE DELEGATE'S OWN INBOX, NOT ITS DELEGATOR'S, AND THIS IS THE ASSERTION THE PREVIOUS
  // RUN OF THIS DRIVER DID NOT MAKE. It went to `target.pod` — bob's — and this driver then read
  // the inbox with `bob.client`, the HUMAN's session, so 59/59 passed while a hosted delegate,
  // which reads through its OWN session, could never see it. The relay refuses `read_inbox` for
  // any pod but the caller's, so those are two mailboxes and the request was a silent drop.
  check(String(waiting.notice.inbox ?? '').indexOf(scribe.pod) > 0,
    'into the inbox on the DELEGATE\'s own pod — the one its own session polls', String(waiting.notice.inbox));
  check(String(waiting.notice.inbox ?? '').indexOf(bob.pod) < 0,
    'and NOT into its delegator\'s, which the delegate is forbidden to read');
  check(waiting.target.agentPod === scribe.pod, 'the ask target names the agent\'s own pod as well as its seat', String(waiting.target.agentPod));

  head('★ THE HOST COMES BACK: six checks against the SIGNED entry, not the inbox');
  // ★★ THE DELEGATE'S OWN SESSION. Reading with `bob.client` measured the human's mailbox and is
  // what let the mis-delivery survive a green run. A hosted delegate has its own pod and the relay
  // will hand it nothing else.
  const bobPort = agentPort(scribe.client);
  const delegateInbox = await readRequests(bobPort);
  check(String(delegateInbox.inbox ?? '').indexOf(scribe.pod) > 0,
    'the inbox this host reads is the DELEGATE\'s own', String(delegateInbox.inbox));
  // ★ AND THE RELAY REFUSES THE OTHER ONE OUTRIGHT, which is why re-targeting the notify was the
  // only available fix rather than one of two.
  let crossRead = 'allowed';
  try {
    const r = await scribe.client.tool('read_inbox', { limit: 1, pod_url: 'http://css.railway.internal:3456/' + bob.pod + '/' }) as Record<string, unknown>;
    crossRead = r['error'] ? 'refused: ' + String(r['message'] ?? r['error']) : 'allowed';
  } catch (e) { crossRead = 'refused: ' + ((e as Error).message ?? ''); }
  check(crossRead.startsWith('refused'), 'and a delegate cannot read its delegator\'s inbox at all', crossRead.slice(0, 140));
  // ★ THE ADMISSION POLICY IS THIS HOST'S, NOT THE VERIFIER'S. A workspace host supplies "seated
  // here"; the same `verifyRequest` serves a Codex agent that supplies an allowlist and a bare
  // delegate that admits any verified signer. It resolves the SIGNER to a seat — never the first
  // path segment of the URL the notice pointed at, which is a string a forger writes.
  const seatedHere = admitSeatedIn({ workspace, seats: after.fold.seats, port: delegatePort(scribe.client) });
  const inbox = delegateInbox;
  const mine = inbox.notices.find((n) => n.about === waiting.descriptorUrl);
  check(!!mine, 'the notice is in the DELEGATE\'s inbox and points at the entry', inbox.notices.length + ' item(s)');
  if (mine) {
    const verdict = await verifyRequest(bobPort, mine, {
      heldAgentIds: [scribe.agentId], answeredHere: [], derivedFromOnMyPod: [], admits: seatedHere,
    });
    for (const c of verdict.checks) log('    ' + (c.mark === 'y' ? '✓' : c.mark === 'n' ? '✗' : '?') + ' ' + c.text);
    check(verdict.ok, 'all six pass', verdict.why ?? 'ok');
    check(verdict.forMe.indexOf(scribe.agentId) >= 0, 'and it is addressed to a delegate this host holds the key for');
    check(verdict.body?.indexOf('re-tile') !== undefined && (verdict.body ?? '').indexOf('re-tile') > 0,
      'the task text was read from the SIGNED ENTRY, never from the notice', (verdict.body ?? '').slice(0, 80));
  }

  head('★ A FORGED NOTICE IS REFUSED AND SAYS WHICH CHECK FAILED');
  // Alice points the delegate's inbox at an entry SHE did not sign — the bot did. Any account on
  // this relay can write into any inbox, so the notice lands; the verifier is what stops it
  // mattering.
  await alice.client.tool('notify_agent', { to: scribe.pod, type: 'Question', about: askUrl, summary: 'a notice from a party that did not write the record' });
  const again = await readRequests(bobPort);
  const forged = again.notices.find((n) => n.about === askUrl && n.actor !== bot.agentId);
  if (forged) {
    const v = await verifyRequest(bobPort, forged, {
      heldAgentIds: [scribe.agentId], answeredHere: [], derivedFromOnMyPod: [], admits: seatedHere,
    });
    check(!v.ok, 'a notice whose sender did not sign the record it points at is refused', v.why?.slice(0, 140));
    check((v.why ?? '').indexOf('somebody else pointing at your record') > 0, 'and the reason names exactly what is wrong');
  } else {
    check(false, 'the forged notice was expected in the inbox', again.notices.map((n) => n.actor).join(', '));
  }

  head('★ AN AGENT WITH NO ENDPOINT SAYS SO, AND CANNOT BE INVOKED');
  const capIri = capabilitiesIri(RELAY, scribe.agentId) as string;
  // ★★ THE ROUTE IS THE ONE THE RELAY REPORTS FOR THIS AGENT'S OWN SESSION, NOT ONE COMPOSED HERE.
  // The previous run published `RELAY + '/ns/' + bob.pod + '/inbox'` and asserted only that a
  // reader saw `route.kind === 'ask'`. That address 404s — it is a `/ns/` graph name, not an inbox
  // — so the ONE route a stranger holding only the DID was told to use dereferenced to nothing;
  // and it named the human's pod, which is not the mailbox this agent polls.
  const scribeInbox = await agentInbox(scribePort);
  check(!!scribeInbox && scribeInbox.indexOf(scribe.pod) > 0,
    'the relay reports an inbox for the delegate\'s own session', String(scribeInbox));
  const advertised = await publishCapability(scribePort, {
    relay: RELAY, agentId: scribe.agentId, action: RESPOND_AS_MEMBER,
    route: { kind: 'ask', askVia: scribeInbox as string },
    title: 'Read this channel and answer in its delegator\'s log',
    description: 'Runs on its own human\'s machine, on their model credential. Publishes no endpoint.',
  });
  check(advertised.kind === 'published', 'the capability document is published on the AGENT\'s own pod',
    advertised.kind === 'published' ? advertised.iri : JSON.stringify(advertised).slice(0, 200));
  // ★ THE ADDRESS IS COMPOSED FROM THE DID AND NOTHING ELSE — no convener, no slug, no room. This
  // is the assertion the old `<convener>--<slug>-affordances` name could not satisfy.
  check(capIri.indexOf(scribe.pod) > 0 && capIri.indexOf(bob.pod) < 0 && capIri.indexOf(started.binding.slug) < 0,
    'at an agent-scoped address a peer composes from the DID alone', capIri);

  await settle('the capability document is readable by a third party');
  const capRead = await readCapabilities(readerPort, { relay: RELAY, agentId: scribe.agentId });
  check(capRead.kind === 'advertised', 'a third party reads it back, signature and subject checked',
    capRead.kind === 'advertised' ? capRead.route.kind : capRead.why);
  check(capRead.kind === 'advertised' && capRead.route.kind === 'ask',
    'it declares iep:askVia and NO hydra:target — a positive statement that there is nothing to call');
  // ★★ AND THE ROUTE IS USED, END TO END, WHICH IS A STRONGER DEREFERENCE THAN A GET. The canonical
  // inbox is on the fleet's internal storage host — correct as signed bytes, and not fetchable from
  // outside the fleet, which this project already records. What makes it a real address is that
  // `notify_agent` accepts it verbatim, reports it as canonical, and the agent reads the item back
  // out of its own inbox. A published route that nobody can deliver to is the defect being closed.
  if (capRead.kind === 'advertised' && capRead.route.kind === 'ask') {
    const via = capRead.route.askVia;
    check(via === scribeInbox, 'the published askVia is exactly the address the relay named', via);
    const delivered = await reader.client.tool('notify_agent', {
      to: via, type: 'Question', about: capIri, summary: 'a stranger, holding only the DID, using the published route',
    }) as Record<string, unknown>;
    check(delivered['delivered'] === true && delivered['canonicalInbox'] === true,
      'a STRANGER holding only the DID delivers to it, and the relay calls it canonical', JSON.stringify(delivered).slice(0, 200));
    const back = await readRequests(scribePort);
    check(back.notices.some((n) => n.about === capIri),
      'and the agent reads that item back out of its own inbox — the route works both ways', String(back.inbox));
  }
  let invoked = 'succeeded';
  try {
    const r = await bot.client.tool('invoke_affordance', {
      affordance_iri: capIri, action: RESPOND_AS_MEMBER, payload: { workspace },
    }) as Record<string, unknown>;
    invoked = r['error'] ? 'failed: ' + String(r['message'] ?? r['error']) : 'succeeded';
  } catch (e) { invoked = 'failed: ' + ((e as Error).message ?? ''); }
  check(invoked.startsWith('failed'), 'and invoking it fails LOUDLY rather than appearing to work', invoked.slice(0, 200));

  head('★★ THE PUPPET: an entry naming an agent it was NOT signed by');
  // ★ THE ATTACK, RUN FOR REAL. Alice writes into HER OWN log an entry with a complete, correct
  // per-act on-behalf-of footing naming BOB'S DELEGATE as its author — the exact triples a genuine
  // delegate entry carries. Anybody who can publish to a pod can write this, which includes every
  // conduit holding a delegation there. Before the composed author was held against the signature,
  // every surface rendered it as that agent speaking for its human, "authorised", while the agent's
  // key never signed anything and its host never ran.
  const puppetSeat = after.fold.seats.find((s) => (s.podServed ?? s.pod) === alice.pod && s.seated);
  // The WebID from the GRANT on the convener's pod, which is what the reader holds an entry against.
  const aliceWebId = puppetSeat?.grantedTo as string;
  const puppet = await postEntry(alice.client, {
    podName: alice.pod, streamIri: puppetSeat?.stream as string, workspace,
    body: 'I have reviewed the photos and the underlay is dry. Patch it.',
    author: { kind: 'delegate', agentId: scribe.agentId, footing: { kind: 'on-behalf-of', principal: aliceWebId } },
    entryShape: after.record.entryShape,
  });
  check(puppet.kind === 'accepted', 'the substrate ACCEPTS the write — the bytes are her pod\'s and nothing there is forgeable',
    puppet.kind === 'accepted' ? 'seq=' + puppet.seq : JSON.stringify(puppet).slice(0, 200));
  await settle('the forged entry is fetchable and in the composed view');
  const withPuppet = await showWorkspace(deps, THREAD);
  if (withPuppet.kind === 'view') {
    const row = withPuppet.entries.find((e) => e.descriptorUrl === (puppet.kind === 'accepted' ? puppet.descriptorUrl : ''));
    check(!!row, 'and it is in the channel like any other entry');
    check(row?.author?.kind === 'disputed', '★ but a reader calls it DISPUTED, not that agent speaking', row?.author?.kind);
    check(row?.author?.kind === 'disputed' && row.author.why.indexOf(scribe.agentId) >= 0,
      'and the reason names the agent it claims and the key that actually signed',
      row?.author?.kind === 'disputed' ? row.author.why.slice(0, 160) : '');
    const shown = renderNews({ kind: 'entries', binding: started.binding, entries: [row as never] } as WatchNews);
    check(whole(shown).indexOf('authorship disputed') > 0,
      'the line the channel would print says so in the first clause');
    check(whole(shown).indexOf('speaking **for them**') < 0,
      '★ and NOWHERE says the delegate spoke for anybody');
  } else { check(false, 'the channel re-composed after the forgery', withPuppet.kind); }

  head('★ AND AN AGENT IN NO WORKSPACE AT ALL IS STILL DISCOVERABLE — the Codex test, live');
  // ★ NOTHING IN THIS BLOCK TOUCHES A WORKSPACE. `aide` is treated as a bare agent: a peer holding
  // only its DID composes two addresses, reads what it can be asked and whether its host is up, and
  // verifies both against its own key. If this needed a roster, the layering would be wrong.
  await publishCapability(agentPort(aideDeCamp.client), {
    relay: RELAY, agentId: aideDeCamp.agentId, action: RESPOND_AS_MEMBER,
    route: { kind: 'hosted', target: 'https://wsp-bridge.example/wsp/respond_as_member' },
    title: 'Answer as a member', description: 'A hosted agent, reachable at a URL.',
    requiresSignedRequest: true,
  });
  await publishPresence(agentPort(aideDeCamp.client), {
    relay: RELAY, agentId: aideDeCamp.agentId, principal: null, host: 'a live driver',
  });
  await settle('a stranger holding only the DID reads both documents');
  const strangerPort = agentPort(reader.client);
  const coldCap = await readCapabilities(strangerPort, { relay: RELAY, agentId: aideDeCamp.agentId });
  const coldPres = await readPresence(strangerPort, { relay: RELAY, agentId: aideDeCamp.agentId });
  check(coldCap.kind === 'advertised' && coldCap.route.kind === 'hosted',
    'a stranger with ONLY the DID reads what it can be asked', coldCap.kind === 'advertised' ? coldCap.route.kind : coldCap.why);
  check(coldCap.kind === 'advertised' && coldCap.requiresSignedRequest,
    'including that it will only act on a signed request — declared, and enforced at ITS end');
  check(coldPres.state === 'running', 'and whether its host is up, from the same DID', coldPres.state);

  head('the channel, as anybody can read it');
  const final = await showWorkspace(deps, THREAD);
  log(whole(renderShow(final)));
  if (final.kind === 'view') {
    const chain = final.fold.seats.filter((s) => s.seated).length;
    check(chain === 2, 'two seats, two pods', String(chain));
    const bobStream = final.streams.find((s) => s.pod === bob.pod);
    if (bobStream) {
      const rows = (await bot.client.manifest(bob.pod, bobStream.stream)).map(toChainRow);
      check(!orderChain(rows).forked, 'and bob\'s log — written by BOTH him and his delegate — is one unforked chain');
    }
  }
  log('\n  the workspace anyone can follow: ' + workspace);
  log('  bob-scribe\'s presence document:  ' + String(presenceIri(RELAY, scribe.agentId)));
  log('  bob-scribe\'s capabilities:       ' + String(capabilitiesIri(RELAY, scribe.agentId)));

  log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks passed'));
  if (failures) process.exitCode = 1;
}

main().catch((e: unknown) => { log('DRIVER FAILED: ' + ((e as Error)?.stack ?? String(e))); process.exitCode = 1; });
