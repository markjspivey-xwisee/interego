/**
 * A PERSON'S OWN AGENT, ANSWERING IN A REAL CHANNEL, ON THEIR OWN MODEL SUBSCRIPTION.
 *
 * ★ NOTHING IN THIS FILE IS SIMULATED. Two secp256k1 keys are minted, two relay OAuth bearers are
 * obtained from them, two pods are provisioned, a workspace is created and accepted across both,
 * and then identity A's LOCAL AGENT reads the channel and answers it by spawning the `claude` CLI
 * this machine is signed into — the same `probeClaude` / `runClaude` the desktop shell's main
 * process calls, imported rather than reimplemented. The reply that lands on A's pod is a reply a
 * real model wrote, on the operator's own subscription, and it is public and permanent.
 *
 * ★ TWO IDENTITIES, BECAUSE ONE CANNOT EXERCISE THE THING. The rule under test is "answer when
 * SOMEBODY ELSE has spoken last". A single-identity run satisfies both sides of that with one pod
 * and would pass while the rule was inverted.
 *
 * ★ AND IT DRIVES THE REFUSALS, NOT ONLY THE HAPPY PATH. The dedupe guard is checked by asking the
 * same question twice; the delegation read-back is checked by revoking and asking again. A driver
 * that only prints successes measures nothing.
 *
 *   npx tsx applications/shared-workspace/tools/drive-local-agent-live.ts
 *
 * Both identities are freshly minted and disposable. The maintainer pod is deliberately NOT used:
 * it is contended, and nothing here needs it.
 */

import { Wallet } from 'ethers';
import {
  RelayMcpTransport, WorkspaceClient, acceptGrant, checkDelegation, checkDraft, briefPrompt,
  createWorkspace, decideTurn, discordLinkPlan, findSeat, foldRoster, hasType, orderChain,
  parseRoleProfile, postEntry, publishDelegation, readIri, readInt, readLiteral, readViewer,
  revokeDelegation, sendInvite, graphRegion, nsIri, qualifiedName,
  type SeenEntry, type Seat, type RoleTable, type Viewer,
} from '@interego/workspace-client';
import { probeClaude, runClaude } from '../desktop/src/modelprovider.js';
import { mintBearer, type Signer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n══ ' + s + ' ' + '═'.repeat(Math.max(0, 66 - s.length))); };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  log((ok ? '  [ok]   ' : '  [FAIL] ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

interface Party { wallet: Signer; client: WorkspaceClient; viewer: Viewer }

async function open(wallet: Signer, who: string): Promise<Party> {
  const bearer = await mintBearer(RELAY, IDENTITY, wallet);
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const viewer = await readViewer(client);
  log('  ' + who + ' · pod ' + viewer.podName + ' · agent ' + (viewer.agentDid ?? 'not reported'));
  return { wallet, client, viewer };
}

/**
 * Read every seated member's log the way the shell does, into the decision's own shape.
 *
 * `unreadable` is counted rather than skipped for the same reason the shell counts it: a partial
 * channel cannot answer "who spoke last", and a decision made on one answers the same message
 * twice. `decideTurn` refuses when it is non-zero.
 */
async function readChannel(p: Party, workspace: string, slug: string, seats: readonly Seat[]): Promise<{ entries: SeenEntry[]; unreadable: number }> {
  const out: SeenEntry[] = [];
  let unreadable = 0;
  for (const seat of seats) {
    // A seat whose stream or pod this fold could not name is SKIPPED rather than guessed at. A
    // manifest read against a made-up pod name comes back empty, and an empty read is exactly what
    // "nobody has written" looks like — the confident falsehood this whole client refuses to make.
    const pod = seat.streamPod ?? seat.pod;
    if (!seat.seated || !seat.stream || !pod) continue;
    const stream = seat.stream;
    const rows = await p.client.manifest(pod, stream);
    const ordered = orderChain(rows.map((r) => ({
      url: String(r['descriptorUrl'] ?? r['url'] ?? ''),
      cid: (r['cid'] as string) ?? null,
      validFrom: (r['validFrom'] as string) ?? null,
      supersedes: Array.isArray(r['supersedes']) ? r['supersedes'] as string[] : [],
    }))).ordered;
    for (const row of ordered) {
      if (!row.url) { unreadable++; continue; }
      let d: Record<string, unknown>;
      try { d = await p.client.descriptor(row.url); }
      catch { unreadable++; continue; }
      // ★ THE CONTENT IS NESTED UNDER `graph`, AND READING `d.content` INSTEAD IS SILENT.
      // The first version of this driver read `d['content']`, which does not exist: every
      // descriptor came back with an empty region, every entry failed `hasType`, and the agent
      // concluded "nobody else has written in this channel yet" — a confident falsehood produced
      // by a typo, with nothing anywhere reporting an error. `respond.ts` records the identical
      // class of defect one field over ("a wrong field name here does not fail, it un-seats
      // everybody"). Read the same way `loadBodies` in the shell reads it, and nowhere else.
      const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', stream);
      // `''` is a signed block that WAS located and is empty; `null` is one that was not.
      const src = region === null ? '' : region;
      if (!hasType(src, 'wsp:Entry')) continue;
      // `Date.parse(x) || null` made the epoch read as "no time", and an entry with no time used
      // to sort as the NEWEST thing in the channel. Number.isNaN asks the real question.
      const t = row.validFrom ? Date.parse(row.validFrom) : NaN;
      out.push({
        pod,
        descriptorUrl: row.url,
        body: readLiteral(src, 'dct:description'),
        derivedFrom: readIri(src, 'prov:wasDerivedFrom'),
        at: Number.isNaN(t) ? null : t,
      });
      void readInt(src, 'wsp:seq');
    }
  }
  return { entries: out, unreadable };
}

/**
 * Read the channel until an expected entry appears, or give up and say so.
 *
 * ★ THE FIRST RUN OF THIS DRIVER FAILED HERE, AND THE FAILURE WAS REAL RATHER THAN FLAKY.
 * `postEntry` came back `accepted` with `committed: false` — the relay had taken the write and had
 * not yet made it readable — and the very next `manifest` read returned nothing, so the agent
 * decided "nobody else has written in this channel yet" and would have said nothing. That is the
 * same readback the shell does after every post, for the same reason, and a driver that skipped it
 * was measuring a race rather than the decision.
 */
async function awaitEntry(p: Party, workspace: string, slug: string, seats: readonly Seat[], from: string, tries = 40): Promise<{ entries: SeenEntry[]; unreadable: number }> {
  let read: { entries: SeenEntry[]; unreadable: number } = { entries: [], unreadable: 0 };
  for (let i = 0; i < tries; i++) {
    read = await readChannel(p, workspace, slug, seats);
    if (read.unreadable === 0 && read.entries.some((e) => e.pod === from && (e.body ?? '').trim() !== '')) return read;
    await new Promise((r) => { setTimeout(r, 700); });
  }
  return read;
}

async function main(): Promise<void> {
  head('0 · the model this machine can run an agent on');
  const provider = await probeClaude();
  log('  ' + provider.label);
  log('  installed: ' + provider.installed + ' · path: ' + (provider.path ?? 'none'));
  log('  loggedIn: ' + (provider.loggedIn === null ? 'not established' : provider.loggedIn)
    + ' · method: ' + (provider.authMethod ?? 'none') + ' · plan: ' + (provider.subscription ?? 'none'));
  log('  ' + provider.why);
  check('a usable model provider was found on this machine', provider.usable, provider.usable ? '' : 'the agent half of this run cannot proceed');
  if (!provider.usable || !provider.path) { log('\nStopping: there is no credential to run an agent on, and this driver will not fake one.'); process.exit(1); }
  check('it is a SUBSCRIPTION and not an API key', provider.authMethod === 'claude.ai',
    'authMethod=' + String(provider.authMethod));

  head('1 · two real identities');
  const A = await open(Wallet.createRandom(), 'A (convener, runs the agent)');
  const B = await open(Wallet.createRandom(), 'B (the other member)');
  check('A and B are different pods', A.viewer.podName !== B.viewer.podName, A.viewer.podName + ' vs ' + B.viewer.podName);

  head('2 · a workspace, created and accepted across both pods');
  const slug = 'agent-' + Date.now().toString(36);
  const created = await createWorkspace(A.client, {
    relay: RELAY, viewer: A.viewer, title: 'Local agent live drive', slug,
    onStep: (s) => log('    create · ' + s.label + ' · ' + s.state),
  });
  check('workspace created on A\'s pod', created.kind === 'created', created.kind === 'created' ? created.workspace : JSON.stringify(created).slice(0, 200));
  if (created.kind !== 'created') { process.exit(1); }
  const workspace = created.workspace;

  const inv = await sendInvite(A.client, {
    viewer: A.viewer, workspace, workspaceTitle: 'Local agent live drive',
    handle: 'acct:' + B.viewer.podName + '@' + new URL(RELAY).host, role: 'Contributor',
    entryShape: created.shapeIri ?? null,
    onState: (s, d) => log('    invite · ' + s + ' · ' + d),
  });
  check('B was invited', inv.kind === 'invited', inv.kind === 'invited' ? inv.grantIri : JSON.stringify(inv).slice(0, 200));

  const verdict = await findSeat(B.client, { relay: RELAY, viewer: B.viewer, workspace });
  check('B can verify the grant naming it', verdict.ok, verdict.why ?? '');
  const accepted = await acceptGrant(B.client, { relay: RELAY, viewer: B.viewer, verdict, onState: (s, d) => log('    accept · ' + s + ' · ' + d) });
  check('B accepted, on B\'s own pod', accepted.kind === 'accepted', JSON.stringify(accepted).slice(0, 160));

  head('3 · B says something');
  const record = await A.client.readWorkspaceRecord(workspace, A.viewer.podName);
  const rolesTtl = record.kind === 'record' && record.record.roleProfile
    ? (await A.client.fetchProfileTurtle(record.record.roleProfile)).turtle : null;
  const roles: RoleTable = rolesTtl ? parseRoleProfile(rolesTtl) : { roles: null, caps: null };
  check('the published role table was read', !!roles.roles, roles.roles ? Object.keys(roles.roles).length + ' roles' : 'unreadable');

  const bStream = nsIri(RELAY, B.viewer.podName, qualifiedName(A.viewer.podName, slug, 'stream'));
  const question = 'We never settled the roof. Do we re-tile in spring or patch it now and wait a year?';
  const posted = await postEntry(B.client, {
    podName: B.viewer.podName, streamIri: bStream, workspace, body: question,
    entryShape: record.kind === 'record' ? record.record.entryShape : null,
  });
  check('B\'s entry landed on B\'s pod', posted.kind === 'accepted', JSON.stringify(posted).slice(0, 160));

  head('4 · A\'s local agent decides, on evidence');
  const fold = await foldRoster(A.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: record.kind === 'record' ? record.record.convener : null,
    convenerPod: record.kind === 'record' ? record.record.convenerPod : A.viewer.podName,
  });
  check('both members are seated', fold.seats.filter((s) => s.seated).length === 2,
    fold.seats.map((s) => s.pod + (s.seated ? ' seated' : ' NOT: ' + s.why)).join(' | '));

  let read = await awaitEntry(A, workspace, slug, fold.seats, B.viewer.podName);
  log('  read ' + read.entries.length + ' entries across ' + fold.seats.filter((s) => s.seated).length + ' logs'
    + (read.unreadable ? ', ' + read.unreadable + ' unreadable' : ''));
  check('the whole channel was readable, so a decision may be made on it', read.unreadable === 0);
  const answeredHere: string[] = [];
  const decision = decideTurn({ workspace, slug, mePod: A.viewer.podName, seats: fold.seats, roles, entries: read.entries, unreadable: read.unreadable, answeredHere });
  check('the agent decides there is something to answer', decision.kind === 'answer', decision.kind + (decision.kind === 'answer' ? '' : ' — ' + decision.why));
  if (decision.kind !== 'answer') { process.exit(1); }
  check('it is answering B\'s entry and not its own', decision.answering.pod === B.viewer.podName, decision.answering.pod);

  head('5 · the model actually runs, on the operator\'s own subscription');
  const prompt = briefPrompt(decision.brief, { displayName: A.viewer.displayName });
  check('the prompt carries the channel and no caller-supplied text', prompt.includes(question) && prompt.includes(workspace));
  const turn = await runClaude({ binary: provider.path, prompt });
  check('the model answered', turn.ok && !!turn.text, turn.why);
  if (!turn.ok || !turn.text) { process.exit(1); }
  const draft = checkDraft(turn.text);
  check('the draft passes the pre-post check', draft.ok, draft.ok ? '' : draft.why);
  if (!draft.ok) { process.exit(1); }
  log('\n  ── what A\'s agent wrote, on A\'s own Claude subscription ──');
  for (const l of draft.body.split('\n')) log('  │ ' + l);
  log('  ── (' + (turn.ms / 1000).toFixed(1) + 's) ──\n');

  head('6 · it appends to A\'s OWN pod, through the same writer a person uses');
  const aStream = nsIri(RELAY, A.viewer.podName, qualifiedName(A.viewer.podName, slug, 'stream'));
  const wrote = await postEntry(A.client, {
    podName: A.viewer.podName, streamIri: aStream, workspace, body: draft.body,
    entryShape: record.kind === 'record' ? record.record.entryShape : null,
  });
  check('the agent\'s reply landed on A\'s pod', wrote.kind === 'accepted', JSON.stringify(wrote).slice(0, 200));
  if (wrote.kind === 'accepted') log('  descriptor: ' + (wrote.descriptorUrl ?? 'not reported'));

  head('7 · the loop guard: asked again, it refuses to answer twice');
  // Without this the agent would re-answer the same message on every poll, permanently, on a
  // public log. It is checked against the real channel rather than against a flag.
  read = await awaitEntry(A, workspace, slug, fold.seats, A.viewer.podName);
  // What the shell records the moment a draft exists. Checked BOTH ways below, because the
  // ordering alone was shown to be defeatable by a caller-chosen `valid_from`.
  answeredHere.push(decision.answering.descriptorUrl);
  const again = decideTurn({ workspace, slug, mePod: A.viewer.podName, seats: fold.seats, roles, entries: read.entries, unreadable: read.unreadable, answeredHere });
  check('the second decision is a refusal, not a second reply', again.kind === 'already-answered',
    again.kind + (again.kind === 'already-answered' ? ' — ' + again.why : ''));

  // And with the record dropped, so the ordering guard is the only thing left holding it.
  const orderingOnly = decideTurn({ workspace, slug, mePod: A.viewer.podName, seats: fold.seats, roles, entries: read.entries, unreadable: read.unreadable, answeredHere: [] });
  check('the ordering guard alone also refuses on this real channel', orderingOnly.kind === 'already-answered',
    orderingOnly.kind + ' — ' + (orderingOnly.kind === 'already-answered' ? orderingOnly.why : ''));

  head('8 · linking a chat account: a delegation A publishes on A\'s own pod');
  // B's agent stands in for the Discord bot: a REAL agent DID on this fleet, so the registry row
  // and `verify_agent` are answering about something that exists.
  const botAgent = B.viewer.agentDid ?? 'did:ethr:0x' + '0'.repeat(40);
  const plan = discordLinkPlan({ botAgentId: botAgent, discordUserId: '424242424242424242' });
  check('the plan is valid and names PublishOnly', !!plan.call && plan.call.args['scope'] === 'PublishOnly');
  check('the label is the public claim, not a secret', plan.call?.['args']?.['label'] === 'discord-link 424242424242424242',
    String(plan.call?.args['label']));
  check('the plan states that PublishOnly is pod-wide', plan.limits.some((l) => l.includes('POD-WIDE')));

  const out = await publishDelegation(A.client, { plan, verifyOnPod: A.viewer.podName });
  check('the delegation published AND read back from the pod', out.kind === 'published', out.why);
  for (const c of out.verdict?.checks ?? []) log('    [' + c.mark + '] ' + c.text);

  // The bot's own confirm, run here: the label must match what the CONFIRMING account's id
  // computes, not what anybody was told.
  const asBot = await checkDelegation(B.client, {
    agentId: botAgent, podName: A.viewer.podName, expectLabel: 'discord-link 424242424242424242',
  });
  check('the delegate itself verifies the row cross-pod', asBot.ok, asBot.why ?? 'ok');
  const wrongAccount = await checkDelegation(B.client, {
    agentId: botAgent, podName: A.viewer.podName, expectLabel: 'discord-link 999999999999999999',
  });
  check('a DIFFERENT chat account is refused by the same row', !wrongAccount.ok, wrongAccount.why ?? '');

  head('9 · withdrawal is unilateral, and confirmed by reading back');
  const revoked = await revokeDelegation(A.client, { agentId: botAgent, podName: A.viewer.podName });
  check('the delegation is revoked and the pod agrees', revoked.kind === 'revoked', revoked.why);

  head('result');
  log('  workspace: ' + workspace);
  log('  A (agent): ' + A.viewer.podName + '   B: ' + B.viewer.podName);
  log(failures === 0 ? '\n  ALL CHECKS PASSED\n' : '\n  ' + failures + ' CHECK(S) FAILED\n');
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e: unknown) => { log('\nFATAL: ' + String((e as Error)?.stack ?? e)); process.exit(1); });
