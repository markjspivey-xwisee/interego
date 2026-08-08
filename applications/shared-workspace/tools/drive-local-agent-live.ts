/**
 * A PERSON'S DELEGATES, ANSWERING IN A REAL CHANNEL, EACH AS ITSELF.
 *
 * ★ NOTHING IN THIS FILE IS SIMULATED. Four secp256k1 keys are minted — two people and two
 * delegates of one of them — four relay OAuth bearers are obtained from them, four pods are
 * provisioned, a workspace is created and accepted across both people, and then identity A's
 * DELEGATES read the channel and answer it by spawning the `claude` CLI this machine is signed
 * into: the same `probeClaude` / `runClaude` the desktop shell's main process calls, imported
 * rather than reimplemented. Every write below is REAL and PUBLIC on the live fleet.
 *
 * ★ WHAT THIS DRIVE EXISTS TO ESTABLISH, which the previous version could not:
 *
 *   1. A DELEGATE IS NOT ITS DELEGATOR. Its entry names IT as the author and A as who it acted
 *      for, and a reader dereferencing A's own pod can tell that from an entry A typed.
 *   2. DELEGATES ARE PLURAL. A authorises TWO, each with its own key, its own DID, its own row
 *      and its own revocation, and both write into A's one log distinguishably.
 *   3. IDENTITY IS NOT THE HOST OR THE CHANNEL. The same key signed in twice yields the same
 *      DID; signed in under a different OAuth client name it yields a different one — which is
 *      why every host must use `DELEGATE_SURFACE`, and this proves the constant does its job.
 *   4. THE CEILING IS THE DELEGATE'S OWN. A third delegation with a non-publishing scope is
 *      refused by the decision before any write is attempted.
 *   5. REVOCATION IS UNILATERAL AND THE AGENT REFUSES AFTERWARDS.
 *
 * ★ AND IT DRIVES THE REFUSALS, NOT ONLY THE HAPPY PATH. A driver that only prints successes
 * measures nothing.
 *
 *   npx tsx applications/shared-workspace/tools/drive-local-agent-live.ts
 *
 * Every identity is freshly minted and disposable. The maintainer pod is deliberately NOT used:
 * it is contended, and nothing here needs it.
 */

import { Wallet } from 'ethers';
import {
  DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient, acceptGrant, authorshipLine, briefPrompt,
  checkDelegation, checkDraft, createWorkspace, decideTurn, delegateLabel, delegatePlan, findSeat,
  foldRoster, graphRegion, hasType, nsIri, orderChain, parseRoleProfile, postEntry,
  publishDelegation, qualifiedName, readDelegates, readEntryAuthorship, readIri, readInt,
  readLiteral, readViewer, revokeDelegation, sendInvite,
  type DelegateRoster, type RoleTable, type Seat, type SeenEntry, type SpeakingDelegate,
  type Viewer,
  delegatePort,
} from '@interego/workspace-client';
import { probeClaude, runClaude } from '../desktop/src/modelprovider.js';
// ★ A SECOND CONSUMER OF THE SAME AUTHORSHIP VALUE, DRIVEN IN THE SAME RUN. The desktop shell is
// not the only surface a reader meets these records on, and a distinction that survives in one
// renderer and quietly dies in another is not a distinction the system has. This is the Discord
// conduit's own author clause, with its own longer copy, over the identical substrate value.
import { authorOf as discordAuthorOf } from '../discord/src/render.js';
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

/**
 * Open a session.
 *
 * ★ `clientName` IS THE WHOLE OF POINT 3. A PERSON signs in under whatever surface they are
 * using; a DELEGATE signs in under `DELEGATE_SURFACE`, the one constant every host shares —
 * because the relay puts the OAuth client name inside the agent DID, so a delegate signed in
 * under an application's own name would be a different delegate in every application.
 */
async function open(wallet: Signer, who: string, clientName?: string): Promise<Party> {
  const bearer = await mintBearer(RELAY, IDENTITY, wallet, clientName);
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
async function readChannel(
  p: Party, seats: readonly Seat[], delegates: ReadonlyMap<string, DelegateRoster>,
): Promise<{ entries: SeenEntry[]; unreadable: number }> {
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
      // by a typo, with nothing anywhere reporting an error. Read the same way `loadBodies` in
      // the shell reads it, and nowhere else.
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
        // ★ HELD AGAINST THE GRANT'S grantee WebID, which lives on the CONVENER's pod — so the
        // owner of the log cannot decide what their own entries are checked against.
        author: readEntryAuthorship(region, {
          logOwnerWebId: seat.grantedTo ?? null,
          delegates: delegates.get(pod) ?? null,
        }),
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
async function awaitEntry(
  p: Party, seats: readonly Seat[], delegates: ReadonlyMap<string, DelegateRoster>,
  want: (e: SeenEntry) => boolean, tries = 40,
): Promise<{ entries: SeenEntry[]; unreadable: number }> {
  let read: { entries: SeenEntry[]; unreadable: number } = { entries: [], unreadable: 0 };
  for (let i = 0; i < tries; i++) {
    read = await readChannel(p, seats, delegates);
    if (read.unreadable === 0 && read.entries.some(want)) return read;
    await new Promise((r) => { setTimeout(r, 700); });
  }
  return read;
}

async function main(): Promise<void> {
  head('0 · the model this machine can run a delegate on');
  const provider = await probeClaude();
  log('  ' + provider.label);
  log('  installed: ' + provider.installed + ' · path: ' + (provider.path ?? 'none'));
  log('  loggedIn: ' + (provider.loggedIn === null ? 'not established' : provider.loggedIn)
    + ' · method: ' + (provider.authMethod ?? 'none') + ' · plan: ' + (provider.subscription ?? 'none'));
  log('  ' + provider.why);
  check('a usable model provider was found on this machine', provider.usable, provider.usable ? '' : 'the agent half of this run cannot proceed');
  if (!provider.usable || !provider.path) { log('\nStopping: there is no credential to run a delegate on, and this driver will not fake one.'); process.exit(1); }
  check('it is a SUBSCRIPTION and not an API key', provider.authMethod === 'claude.ai',
    'authMethod=' + String(provider.authMethod));
  log('  ★ the provider is how a delegate THINKS, not who it is. Both delegates below run on this'
    + ' one and they are still two delegates.');

  head('1 · two people, and two delegates of the first');
  const A = await open(Wallet.createRandom(), 'A (a person)');
  const B = await open(Wallet.createRandom(), 'B (another person)');
  check('A and B are different pods', A.viewer.podName !== B.viewer.podName, A.viewer.podName + ' vs ' + B.viewer.podName);

  // ★ THE DELEGATES SIGN IN UNDER `DELEGATE_SURFACE`, NOT UNDER THIS DRIVER'S NAME.
  const k1 = Wallet.createRandom();
  const k2 = Wallet.createRandom();
  const D1 = await open(k1, 'A\'s delegate #1', DELEGATE_SURFACE);
  const D2 = await open(k2, 'A\'s delegate #2', DELEGATE_SURFACE);
  const d1Id = D1.viewer.agentDid ?? '';
  const d2Id = D2.viewer.agentDid ?? '';
  check('each delegate has its own agent id', !!d1Id && !!d2Id && d1Id !== d2Id, d1Id + ' vs ' + d2Id);
  check('a delegate id is NOT its delegator\'s', d1Id !== A.viewer.agentDid, 'A is ' + (A.viewer.agentDid ?? 'none'));
  check('the surface constant is in the id, and no application name is',
    d1Id.includes(':' + DELEGATE_SURFACE + '-') && !/desktop|discord|artifact|driver/.test(d1Id), d1Id);

  head('2 · identity is the key, not the host and not the channel');
  // Same key, same surface, a SECOND session: the same delegate.
  const again = await open(k1, 'delegate #1, signed in a second time', DELEGATE_SURFACE);
  check('the same key under the same surface is the SAME delegate', again.viewer.agentDid === d1Id,
    (again.viewer.agentDid ?? 'none') + ' vs ' + d1Id);
  // Same key, a DIFFERENT surface: a different agent id — which is exactly why the constant exists.
  const elsewhere = await open(k1, 'delegate #1, signed in as some other client', 'interego-some-other-app');
  check('the same key under a DIFFERENT client name is a different id, which is why DELEGATE_SURFACE exists',
    elsewhere.viewer.agentDid !== d1Id, (elsewhere.viewer.agentDid ?? 'none'));

  head('3 · A authorises both delegates, on A\'s own pod');
  for (const [name, id] of [['Claude side', d1Id], ['Codex side', d2Id]] as const) {
    const plan = delegatePlan({ agentId: id, name });
    check('the plan for "' + name + '" names PublishOnly and the labelled row', !!plan.call
      && plan.call.args['scope'] === 'PublishOnly' && plan.call.args['label'] === delegateLabel(name),
      JSON.stringify(plan.call?.args));
    const out = await publishDelegation(delegatePort(A.client), { plan, verifyOnPod: A.viewer.podName });
    check('"' + name + '" is authorised, and read back from A\'s pod', out.kind === 'published', out.why);
  }
  const roster = await readDelegates(delegatePort(A.client), A.viewer.podName);
  check('A\'s pod lists BOTH delegates as delegates', roster.read && roster.delegates.length === 2,
    roster.delegates.map((d) => d.name + '=' + d.agentId).join(' | '));
  check('and A\'s own session agent is listed as an agent that is NOT a delegate',
    roster.others.some((o) => o.agentId === A.viewer.agentDid),
    roster.others.map((o) => o.label ?? '?').join(' | '));

  // The delegate itself asks, cross-pod, exactly as the bot does before every write.
  const gate1 = await checkDelegation(D1.client, { agentId: d1Id, podName: A.viewer.podName });
  check('delegate #1 verifies its own authority against A\'s pod', gate1.ok, gate1.why ?? 'ok');
  const gateB = await checkDelegation(D1.client, { agentId: d1Id, podName: B.viewer.podName });
  check('and is refused on B\'s pod, which delegated it nothing', !gateB.ok, gateB.why ?? '');

  head('4 · a workspace, created and accepted across both people');
  const slug = 'delegate-' + Date.now().toString(36);
  const created = await createWorkspace(A.client, {
    relay: RELAY, viewer: A.viewer, title: 'Delegates live drive', slug,
    onStep: (s) => log('    create · ' + s.label + ' · ' + s.state),
  });
  check('workspace created on A\'s pod', created.kind === 'created', created.kind === 'created' ? created.workspace : JSON.stringify(created).slice(0, 200));
  if (created.kind !== 'created') { process.exit(1); }
  const workspace = created.workspace;

  const inv = await sendInvite(A.client, {
    viewer: A.viewer, workspace, workspaceTitle: 'Delegates live drive',
    handle: 'acct:' + B.viewer.podName + '@' + new URL(RELAY).host, role: 'Contributor',
    entryShape: created.shapeIri ?? null,
    onState: (s, d) => log('    invite · ' + s + ' · ' + d),
  });
  check('B was invited', inv.kind === 'invited', inv.kind === 'invited' ? inv.grantIri : JSON.stringify(inv).slice(0, 200));
  const verdict = await findSeat(B.client, { relay: RELAY, viewer: B.viewer, workspace });
  check('B can verify the grant naming it', verdict.ok, verdict.why ?? '');
  const accepted = await acceptGrant(B.client, { relay: RELAY, viewer: B.viewer, verdict, onState: (s, d) => log('    accept · ' + s + ' · ' + d) });
  check('B accepted, on B\'s own pod', accepted.kind === 'accepted', JSON.stringify(accepted).slice(0, 160));

  head('5 · A types something, in A\'s own words');
  const record = await A.client.readWorkspaceRecord(workspace, A.viewer.podName);
  const rolesTtl = record.kind === 'record' && record.record.roleProfile
    ? (await A.client.fetchProfileTurtle(record.record.roleProfile)).turtle : null;
  const roles: RoleTable = rolesTtl ? parseRoleProfile(rolesTtl) : { roles: null, caps: null };
  check('the published role table was read', !!roles.roles, roles.roles ? [...(roles.roles.keys())].length + ' roles' : 'unreadable');
  const entryShape = record.kind === 'record' ? record.record.entryShape : null;

  // ★ A SPEAKS FIRST, AND THE ORDER IS NOT COSMETIC. The FIRST run of this drive put A's own
  // entry AFTER B's question, and the delegate correctly refused: the dedupe is per POD, so an
  // entry the PERSON wrote after the question already counts as "somebody on this pod has
  // spoken since". That refusal is the guard working — two delegates of one person must not
  // both answer one message — and the fix is the driver's sequence, not the decision.
  const aStream = nsIri(RELAY, A.viewer.podName, qualifiedName(A.viewer.podName, slug, 'stream'));
  const aSaid = await postEntry(A.client, {
    podName: A.viewer.podName, streamIri: aStream, workspace, entryShape,
    body: 'Speaking for myself: I would rather not spend the money this year.',
    author: { kind: 'principal', webId: A.viewer.webId },
  });
  check('A\'s own entry landed on A\'s pod', aSaid.kind === 'accepted', JSON.stringify(aSaid).slice(0, 160));

  head('6 · B asks something, in B\'s own words');
  const bStream = nsIri(RELAY, B.viewer.podName, qualifiedName(A.viewer.podName, slug, 'stream'));
  const question = 'We never settled the roof. Do we re-tile in spring or patch it now and wait a year?';
  const posted = await postEntry(B.client, {
    podName: B.viewer.podName, streamIri: bStream, workspace, body: question, entryShape,
    // B typed this. B is the author, and nothing acted on B's behalf.
    author: { kind: 'principal', webId: B.viewer.webId },
  });
  check('B\'s entry landed on B\'s pod', posted.kind === 'accepted', JSON.stringify(posted).slice(0, 160));

  head('7 · the fold, and each member\'s delegates read from their OWN pod');
  const fold = await foldRoster(A.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: record.kind === 'record' ? record.record.convener : null,
    convenerPod: record.kind === 'record' ? record.record.convenerPod : A.viewer.podName,
  });
  check('both people are seated', fold.seats.filter((s) => s.seated).length === 2,
    fold.seats.map((s) => s.pod + (s.seated ? ' seated' : ' NOT: ' + s.why)).join(' | '));
  const byPod = new Map<string, DelegateRoster>();
  for (const s of fold.seats) if (s.seated && s.pod) byPod.set(s.pod, await readDelegates(delegatePort(A.client), s.pod));
  check('A\'s pod contributes two delegates, B\'s contributes none',
    (byPod.get(A.viewer.podName)?.delegates.length ?? -1) === 2 && (byPod.get(B.viewer.podName)?.delegates.length ?? -1) === 0,
    [...byPod].map(([p, r]) => p + '=' + r.delegates.length).join(' '));

  head('8 · the ceiling is the DELEGATE\'S own, not its delegator\'s');
  let read = await awaitEntry(A, fold.seats, byPod, (e) => e.pod === B.viewer.podName && (e.body ?? '').trim() !== '');
  check('the whole channel was readable, so a decision may be made on it', read.unreadable === 0);
  const speaking1: SpeakingDelegate = { agentId: d1Id, name: 'Claude side', scope: 'PublishOnly' };
  const turnArgs = { workspace, slug, mePod: A.viewer.podName, seats: fold.seats, roles };
  // A delegation that cannot publish is refused BEFORE anything is attempted.
  const withheld = decideTurn({ ...turnArgs, delegate: { agentId: d1Id, name: 'Claude side', scope: 'ReadOnly' }, entries: read.entries, unreadable: read.unreadable, answeredHere: [] });
  check('a ReadOnly delegation is refused by the decision, on the same seat', withheld.kind === 'ceiling',
    withheld.kind + (withheld.kind === 'ceiling' ? ' — ' + withheld.why : ''));
  // And no delegate at all is a refusal rather than a quiet write as the person.
  const nobody = decideTurn({ ...turnArgs, delegate: null, entries: read.entries, unreadable: read.unreadable, answeredHere: [] });
  check('no delegate selected is a refusal, not a fall back to writing as A', nobody.kind === 'no-delegate',
    nobody.kind + (nobody.kind === 'no-delegate' ? ' — ' + nobody.why : ''));

  head('9 · delegate #1 answers, as itself');
  const answeredHere: string[] = [];
  const decision = decideTurn({ ...turnArgs, delegate: speaking1, entries: read.entries, unreadable: read.unreadable, answeredHere });
  check('the delegate decides there is something to answer', decision.kind === 'answer',
    decision.kind + (decision.kind === 'answer' ? '' : ' — ' + decision.why));
  if (decision.kind !== 'answer') { process.exit(1); }
  check('it is answering B and not its own delegator', decision.answering.pod === B.viewer.podName, decision.answering.pod);
  check('the transcript names A\'s own entry as the person, not as the delegate',
    decision.brief.transcript.some((t) => t.startsWith('the person you act for:')),
    decision.brief.transcript.join(' | ').slice(0, 240));

  const prompt = briefPrompt(decision.brief, { displayName: A.viewer.displayName, delegateName: 'Claude side' });
  check('the prompt tells the model it is the delegate and NOT the person',
    prompt.includes('You are Claude side, a delegate of') && prompt.includes('You are NOT'));
  check('and it carries the channel and no caller-supplied text', prompt.includes(question) && prompt.includes(workspace));
  // ★ THE FOOTING IS ASKED FOR, NOT ASSUMED — this is the whole correction, in the prompt.
  check('and it asks the model which footing it is speaking on',
    prompt.includes('FOOTING: ON THEIR BEHALF') && prompt.includes('FOOTING: MY OWN ACCOUNT'));
  const turn = await runClaude({ binary: provider.path, prompt });
  check('the model answered', turn.ok && !!turn.text, turn.why);
  if (!turn.ok || !turn.text) { process.exit(1); }
  const draft = checkDraft(turn.text, { principal: A.viewer.webId });
  check('the draft passes the pre-post check', draft.ok, draft.ok ? '' : draft.why);
  if (!draft.ok) { process.exit(1); }
  check('and it came back with a footing the delegate chose for itself',
    draft.footing.kind === 'on-behalf-of' || draft.footing.kind === 'own-account', draft.footing.kind);
  log('\n  ── what A\'s delegate "Claude side" wrote, on the operator\'s own subscription ──');
  log('  │ [footing it declared: ' + draft.footing.kind + ']');
  for (const l of draft.body.split('\n')) log('  │ ' + l);
  log('  ── (' + (turn.ms / 1000).toFixed(1) + 's) ──\n');

  // ★ THE DELEGATE'S OWN SESSION WRITES IT. Not A's. The entry's triples name the delegate, and
  // the relay authenticates the delegate too — so `revoke_agent` below actually stops it.
  const wrote = await postEntry(D1.client, {
    podName: A.viewer.podName, streamIri: aStream, workspace, body: draft.body, entryShape,
    author: { kind: 'delegate', agentId: d1Id, footing: draft.footing },
  });
  check('the delegate\'s reply landed on A\'s pod, written by the DELEGATE\'s session',
    wrote.kind === 'accepted', JSON.stringify(wrote).slice(0, 200));
  if (wrote.kind === 'accepted') {
    log('  descriptor: ' + (wrote.descriptorUrl ?? 'not reported'));
    const auth = wrote.response['authorship'] as { signer?: string; verificationMethod?: string } | undefined;
    check('the relay attests the DELEGATE as the caller it authenticated', auth?.signer === d1Id, String(auth?.signer));
    // ★ AND WHAT THAT PROOF DOES NOT SAY. Measured: one key for every pod and every agent here.
    log('  the proof verifies against ' + (auth?.verificationMethod ?? 'not reported')
      + ' — the RELAY\'s own key, identical for every pod and every agent on this deployment. '
      + 'It is not the delegate\'s wallet.');
  }
  answeredHere.push(decision.answering.descriptorUrl);

  head('10 · a reader tells all three apart, by dereferencing');
  read = await awaitEntry(A, fold.seats, byPod, (e) => e.author.kind === 'delegate');
  const mine = read.entries.filter((e) => e.pod === A.viewer.podName);
  const asPerson = mine.filter((e) => e.author.kind === 'principal');
  const asDelegate = mine.filter((e) => e.author.kind === 'delegate');
  check('A\'s log holds entries by A AND by A\'s delegate, told apart', asPerson.length >= 1 && asDelegate.length >= 1,
    asPerson.length + ' by the person, ' + asDelegate.length + ' by a delegate');
  for (const e of read.entries) {
    log('    ' + e.pod + ' · ' + authorshipLine(e.author) + ' · ' + (e.body ?? '(no body)').slice(0, 70));
  }
  const one = asDelegate[0];
  check('the delegate entry names the delegate as its author',
    !!one && one.author.kind === 'delegate' && one.author.agentId === d1Id,
    one && one.author.kind === 'delegate' ? one.author.agentId : 'none');
  check('and the footing it declared survives the round trip through the relay',
    !!one && one.author.kind === 'delegate' && one.author.footing.kind === draft.footing.kind,
    one && one.author.kind === 'delegate' ? 'read back as ' + one.author.footing.kind + ', wrote ' + draft.footing.kind : 'none');
  check('and A\'s own pod\'s registry is what says the delegation is real',
    !!one && one.author.kind === 'delegate' && one.author.authorised === true && one.author.name === 'Claude side',
    one && one.author.kind === 'delegate' ? 'authorised=' + one.author.authorised + ' name=' + one.author.name : 'none');

  // ── ★ THE SAME DELEGATE, THE OTHER FOOTING, WRITTEN AND READ BACK ─────────────────────────
  //
  // This is the pair the whole change exists for. Nothing about the delegation changes between
  // these two entries: same agent, same key, same row on A's pod, same standing. What differs is
  // one statement inside one record, and a reader has to come back with two different answers.
  head('10b · the same delegate, speaking for ITSELF, told apart from the one above');
  const ownBody = 'Speaking for myself here rather than for ' + (A.viewer.displayName ?? 'the person I act for')
    + ': I think the second option is the weaker one, and that is my read, not theirs.';
  const wroteOwn = await postEntry(D1.client, {
    podName: A.viewer.podName, streamIri: aStream, workspace, body: ownBody, entryShape,
    author: { kind: 'delegate', agentId: d1Id, footing: { kind: 'own-account' } },
  });
  check('an own-account entry from the same delegate landed', wroteOwn.kind === 'accepted',
    JSON.stringify(wroteOwn).slice(0, 200));
  read = await awaitEntry(A, fold.seats, byPod, (e) => (e.body ?? '') === ownBody);
  const own = read.entries.find((e) => (e.body ?? '') === ownBody) ?? null;
  check('it reads back as own-account',
    !!own && own.author.kind === 'delegate' && own.author.footing.kind === 'own-account',
    own && own.author.kind === 'delegate' ? own.author.footing.kind : 'not read');
  check('by the SAME agent id as the entry above it',
    !!own && own.author.kind === 'delegate' && own.author.agentId === d1Id);
  check('with its standing delegation UNCHANGED — still authorised, still named',
    !!own && own.author.kind === 'delegate' && own.author.authorised === true && own.author.name === 'Claude side');
  check('★ and the two entries do NOT render the same',
    !!one && !!own && authorshipLine(one.author, { displayName: 'Mark' }) !== authorshipLine(own.author, { displayName: 'Mark' }),
    !!one && !!own ? authorshipLine(one.author, { displayName: 'Mark' }) + '  ≠  ' + authorshipLine(own.author, { displayName: 'Mark' }) : 'one of them was not read');
  // ★ A SECOND CONSUMER, NOT THE DESKTOP APP. The Discord conduit renders authorship with its own
  // longer copy, from the same substrate value. If a surface could quietly drop the distinction,
  // this is where it would show.
  if (one && own) {
    const shownFor = discordAuthorOf(one.author);
    const shownOwn = discordAuthorOf(own.author);
    log('    discord · ' + shownFor);
    log('    discord · ' + shownOwn);
    check('the Discord conduit distinguishes them too', shownFor !== shownOwn);
    check('and says "for itself" in the one that is', shownOwn.includes('for itself'), shownOwn.slice(0, 120));
  }

  head('11 · the SECOND delegate: a sibling, and the loop guard between them');
  // ★ ONE DUPLICATE REPLY IS THE FAILURE THIS PREVENTS. Two delegates of one person both
  // answering the same question would put two permanent records in one log saying the same thing.
  const speaking2: SpeakingDelegate = { agentId: d2Id, name: 'Codex side', scope: 'PublishOnly' };
  const sibling = decideTurn({ ...turnArgs, delegate: speaking2, entries: read.entries, unreadable: read.unreadable, answeredHere: [] });
  check('delegate #2 refuses because its SIBLING has already spoken', sibling.kind === 'already-answered',
    sibling.kind + ' — ' + (sibling.kind === 'already-answered' ? sibling.why : ''));

  // Now B says something new, and delegate #2 — a different identity — answers that one.
  const second = 'One more: who is calling the roofer, and by when?';
  const posted2 = await postEntry(B.client, {
    podName: B.viewer.podName, streamIri: bStream, workspace, body: second, entryShape,
    author: { kind: 'principal', webId: B.viewer.webId },
  });
  check('B asked a second question', posted2.kind === 'accepted', JSON.stringify(posted2).slice(0, 160));
  read = await awaitEntry(A, fold.seats, byPod, (e) => (e.body ?? '') === second);
  const turn2 = decideTurn({ ...turnArgs, delegate: speaking2, entries: read.entries, unreadable: read.unreadable, answeredHere: [] });
  check('delegate #2 now has something to answer', turn2.kind === 'answer', turn2.kind + (turn2.kind === 'answer' ? '' : ' — ' + turn2.why));
  if (turn2.kind === 'answer') {
    check('and it can see its sibling\'s entry as a sibling\'s, not as its own or as A\'s',
      turn2.brief.transcript.some((t) => t.includes('another delegate of the person you act for')),
      turn2.brief.transcript.join(' | ').slice(0, 300));
    const t2 = await runClaude({ binary: provider.path, prompt: briefPrompt(turn2.brief, { displayName: A.viewer.displayName, delegateName: 'Codex side' }) });
    const d2 = t2.ok && t2.text ? checkDraft(t2.text, { principal: A.viewer.webId }) : { ok: false as const, why: t2.why };
    check('delegate #2\'s model answered and its draft passes', d2.ok, d2.ok ? '' : d2.why);
    if (d2.ok) {
      const wrote2 = await postEntry(D2.client, {
        podName: A.viewer.podName, streamIri: aStream, workspace, body: d2.body, entryShape,
        author: { kind: 'delegate', agentId: d2Id, footing: d2.footing },
      });
      check('delegate #2\'s reply landed, under ITS own session', wrote2.kind === 'accepted', JSON.stringify(wrote2).slice(0, 200));
    }
  }
  read = await awaitEntry(A, fold.seats, byPod, (e) => e.author.kind === 'delegate' && e.author.agentId === d2Id);
  const names = new Set(read.entries.filter((e) => e.pod === A.viewer.podName).map((e) => authorshipLine(e.author)));
  check('★ one log, three distinguishable authors', names.size >= 3, [...names].join(' | '));

  head('12 · revocation is unilateral, and the delegate refuses afterwards');
  const revoked = await revokeDelegation(delegatePort(A.client), { agentId: d1Id, podName: A.viewer.podName });
  check('delegate #1 is revoked and A\'s pod agrees', revoked.kind === 'revoked', revoked.why);
  const afterRoster = await readDelegates(delegatePort(A.client), A.viewer.podName);
  check('A\'s pod now lists ONE delegate, and it is the other one',
    afterRoster.read && afterRoster.delegates.length === 1 && afterRoster.delegates[0]?.agentId === d2Id,
    afterRoster.delegates.map((d) => d.name).join(' | '));
  const gateAfter = await checkDelegation(D1.client, { agentId: d1Id, podName: A.viewer.podName });
  check('the delegate itself now reads its own authority as withdrawn', !gateAfter.ok, gateAfter.why ?? '');
  // ★ AND WHAT IS ALREADY WRITTEN STAYS, STILL ATTRIBUTED TO IT.
  const stillThere = await readChannel(A, fold.seats, new Map([[A.viewer.podName, afterRoster]]));
  const orphan = stillThere.entries.find((e) => e.author.kind === 'delegate' && e.author.agentId === d1Id);
  check('what the revoked delegate wrote is still there and still names it',
    !!orphan && orphan.author.kind === 'delegate' && orphan.author.agentId === d1Id,
    orphan ? 'found' : 'missing');
  check('and its authorisation now reads as NOT recorded — a fact, not a deletion',
    !!orphan && orphan.author.kind === 'delegate' && orphan.author.authorised === false,
    orphan && orphan.author.kind === 'delegate' ? String(orphan.author.authorised) : 'n/a');

  head('result');
  log('  workspace: ' + workspace);
  log('  A: ' + A.viewer.podName + '   B: ' + B.viewer.podName);
  log('  A\'s delegates: ' + d1Id + ' (revoked), ' + d2Id);
  log(failures === 0 ? '\n  ALL CHECKS PASSED\n' : '\n  ' + failures + ' CHECK(S) FAILED\n');
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e: unknown) => { log('\nFATAL: ' + String((e as Error)?.stack ?? e)); process.exit(1); });
