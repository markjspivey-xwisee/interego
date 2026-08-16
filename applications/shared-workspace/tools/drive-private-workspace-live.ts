/**
 * A PRIVATE WORKSPACE, TWO REAL IDENTITIES, TWO REAL PODS — DOES THE OTHER MEMBER GET IN?
 *
 * ── ★★ THE ONE QUESTION THE UNIT TESTS CANNOT ANSWER ────────────────────────
 *
 * Everything about private workspaces is verifiable in isolation: the visibility mapping, the
 * recipient list, the fail-closed writers, the opener. All of it can be right and the feature
 * still be useless, because the thing that decides it happens on the relay, between two pods:
 *
 *   Does B — a different person, on a different pod, holding a different key — actually OPEN an
 *   entry that A wrote?
 *
 * If the recipient resolution silently produces an empty key set (which it does, without erroring,
 * for a handle that does not resolve or a pod that registers no key), A's publish still returns
 * 200 and the channel still looks normal from A's side. The failure is only visible from B's, and
 * only in production. So this is measured there.
 *
 * ── ★ AND THE NEGATIVE MATTERS AS MUCH AS THE POSITIVE ──────────────────────
 *
 * An envelope every key opens would pass every "B can read it" assertion ever written. So a third
 * identity, seated in nothing, must be REFUSED — and refused as a permission, not reported as a
 * damaged record.
 *
 * ── WHAT IT WRITES ──────────────────────────────────────────────────────────
 *
 * Four throwaway wallets, each with a pod that did not exist a minute earlier: a convener, two
 * invitees, and a stranger who is invited to nothing. A creates a private workspace, invites B, B
 * accepts, A invites C — which must not evict B — and A posts. Nobody else's pod is named or
 * touched.
 *
 * From the repo root (bundled, not `tsx` — see `probe-e2e-live.ts` for why):
 *   npx esbuild applications/shared-workspace/tools/drive-private-workspace-live.ts \
 *     --bundle --format=cjs --platform=node --target=es2022 --outfile=/tmp/drive-private.cjs
 *   node /tmp/drive-private.cjs
 */

import { Wallet } from 'ethers';
import { deriveEncryptionKeyPair } from '@interego/core';
import {
  RelayMcpTransport, WorkspaceClient, acceptGrant, composedHandle, createWorkspace, foldRoster,
  nsIri, orderChain, parseRoleProfile, postEntry, qualifiedName, readInbox, readViewer,
  recipientsFor, toChainRow, unreachedRecipients, verifyInvitation, sendInvite,
  type Viewer,
} from '@interego/workspace-client';
import { openerFor } from '@interego/workspace-client/opener';
import { mintBearer, type Signer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

let bad = 0;
const log = (...a: unknown[]): void => { process.stdout.write(a.join(' ') + '\n'); };
const head = (t: string): void => { log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 74 - t.length))); };
const must = (what: string, ok: boolean, detail = ''): void => {
  if (!ok) bad++;
  log((ok ? '  PASS  ' : '  FAIL  ') + what + (!ok && detail ? '\n        ' + detail : ''));
};

interface Party { readonly client: WorkspaceClient; readonly viewer: Viewer; readonly handle: string }

/**
 * ★ EACH PARTY INSTALLS ITS OWN KEY, exactly as its host does — the desktop from the OS secret
 * store, the bot from its environment. A driver that shared one key between the parties would
 * prove nothing about whether B can read A's writing.
 */
async function party(label: string, wallet: Signer & { privateKey: string }): Promise<Party> {
  const bearer = await mintBearer(RELAY, IDENTITY, wallet);
  const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
  await client.connect();
  const viewer = await readViewer(client);

  const key = deriveEncryptionKeyPair(wallet.privateKey);
  // Registered against the agent the relay says this session IS — the same call the desktop and
  // the bot make at sign-in. Without it this party contributes no recipient key to its own pod,
  // and anything "shared" with it resolves to nobody.
  await client.tool('register_agent', {
    agent_id: viewer.agentDid, scope: 'ReadWrite', encryption_public_key: key.publicKey,
  });
  client.setGraphOpener(openerFor(wallet.privateKey));

  log('  ' + label + ' pod ' + viewer.podName + ' · key ' + key.publicKey.slice(0, 12) + '…');
  return { client, viewer, handle: composedHandle(RELAY, viewer.podName) };
}

async function run(): Promise<number> {
  head('throwaway identities, each holding its own key');
  const aw = Wallet.createRandom(); const bw = Wallet.createRandom(); const sw = Wallet.createRandom();
  const A = await party('A (convener)', aw);
  const B = await party('B (invited)  ', bw);
  // The stranger: never invited, never seated, named by nothing. It exists to be refused. (C,
  // minted later, IS invited — a second member is a different test, and conflating the two would
  // make the refusal below pass for the wrong reason.)
  const strangerOpener = openerFor(sw.privateKey);

  head('A creates a PRIVATE workspace');
  const slug = 'priv-' + Date.now().toString(36);
  const created = await createWorkspace(A.client, {
    relay: RELAY, viewer: A.viewer, title: 'Private drive ' + slug, slug,
    visibility: 'private',
    onStep: (s) => { if (s.state !== 'sending') log('    ' + s.label + ' · ' + s.state); },
  });
  must('all five documents published and A is seated', created.kind === 'created' && created.seated,
    JSON.stringify(created).slice(0, 300));
  if (created.kind !== 'created') return 1;
  const workspace = created.workspace;
  const entryShape = created.shapeIri;

  head('★ the record reads back as private — and the shape did NOT get encrypted');
  const rec = await A.client.readWorkspaceRecord(workspace, A.viewer.podName);
  must('the record reads', rec.kind === 'record', rec.kind);
  if (rec.kind !== 'record') return 1;
  must('★★ it declares itself private', rec.record.visibility === 'private', rec.record.visibility);
  must('★★ and A can read it, so it is not withheld from its own convener', !rec.record.withheld, 'withheld');
  /**
   * ★★ THE LOCKOUT THIS WOULD BE. The relay fetches the shape's body by plain GET on its /ns IRI
   * and `/ns` answers 409 for an encrypted graph; the conformance gate fails closed. So the first
   * encrypted shape makes every later write to this workspace a 422 with no way back — the fix
   * would itself be a write. `visibilityFor` keeps shape and roles public-always; this is that
   * decision, measured against the live relay rather than asserted in a comment.
   */
  const shapeResp = await fetch(entryShape, { headers: { 'Accept': 'text/turtle' } });
  must('★★ the SHACL shape is still fetchable — an encrypted one locks the workspace out of itself forever',
    shapeResp.ok, 'GET ' + entryShape + ' → ' + shapeResp.status);
  const profile = await A.client.fetchProfileTurtle(created.rolesIri);
  const table = parseRoleProfile(profile.turtle);
  must('★ and the role profile still resolves, for the same reason', table.roles.size === 3, String(table.roles.size));
  const contributor = [...table.roles.keys()].find((r) => r.endsWith('#Contributor'));
  if (!contributor) { must('a Contributor role exists', false, ''); return 1; }

  head('A invites B; B verifies the claim and accepts');
  const inv = await sendInvite(A.client, {
    viewer: A.viewer, workspace, workspaceTitle: 'Private drive ' + slug,
    handle: B.handle, role: contributor, entryShape,
    // ★ The record has to be re-sealed to include B before B can verify their own grant — see
    // `resealRecord`. A is the only member so far, so A is the whole existing roster.
    visibility: 'private', shareWith: [A.viewer.webId],
    onState: (st, d) => { if (st.startsWith('re-sealing')) log('    ' + st + ' · ' + d); },
  });
  must('the grant was written', inv.kind === 'invited', JSON.stringify(inv).slice(0, 260));
  if (inv.kind !== 'invited') return 1;

  const inbox = await readInbox(B.client);
  log('    offers in B\'s inbox: ' + inbox.invitations.length);
  let accepted = false;
  for (const item of inbox.invitations) {
    await verifyInvitation(B.client, RELAY, B.viewer, item);
    const v = item.verdict;
    log('    · ' + (v?.grantIri ?? 'no grant iri') + ' → ' + (v?.ok ? 'VERIFIED' : 'refused: ' + (v?.why ?? 'no verdict')));
    if (!v?.ok || v.grantIri !== inv.grantIri) continue;
    // ★ B reads the workspace record to verify the grant — which means B decrypted it. A private
    // workspace whose record B cannot open cannot be joined at all.
    must('★★ B could read the PRIVATE workspace record well enough to verify the grant', v.ok, v.why ?? '');
    must('★ and B sees it as private too', v.visibility === 'private', String(v.visibility));
    const out = await acceptGrant(B.client, { relay: RELAY, viewer: B.viewer, verdict: v });
    accepted = out.kind === 'accepted' && out.readable;
    must('B\'s acceptance is readable on B\'s own pod', accepted, JSON.stringify(out).slice(0, 240));
  }
  must('the invitation was found in B\'s inbox', accepted, 'nothing verified against ' + inv.grantIri);
  if (!accepted) return 1;

  /**
   * ── ★★ THE FOLD THAT WAS NEVER RUN, AND WHAT IT HID ─────────────────────────
   *
   * Every roster read in this driver used to be `A.client` — the convener's own. That is the ONE
   * client for which a private workspace always looks correct, because everything in it was sealed
   * by A and A can open all of it. Reading the roster as B is a different question and it had a
   * different answer: `createWorkspace` published the convener's own grant and acceptance through
   * a helper that defaulted them to ENCRYPTED, so B could not open them, `foldRoster` called them
   * malformed, and A came back NOT SEATED — vanishing from B's roster and from every recipient
   * list B computed, with no error anywhere.
   */
  head('★★ what the OTHER member sees when they fold the roster');
  const bFold = await foldRoster(B.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: rec.record.convener, convenerPod: rec.record.convenerPod,
  });
  for (const s of bFold.seats) log('    ' + (s.seated ? 'SEATED' : 'not   ') + ' ' + s.pod + (s.seated ? '' : ' · ' + String(s.why)));
  must('★★ B sees the CONVENER as seated — a sealed founding grant unseats them in every other client',
    bFold.seats.some((s) => s.seated && s.pod === A.viewer.podName),
    'A is not seated in B\'s fold, so B would never encrypt to A and would read A\'s channel as empty');
  must('★ and B sees themselves seated', bFold.seats.some((s) => s.seated && s.pod === B.viewer.podName), '');
  const bAudience = recipientsFor('private', bFold);
  must('★★ B\'s recipient list names the convener, so a reply is readable by them',
    bAudience.ok && (bAudience.shareWith ?? []).includes(A.viewer.webId),
    bAudience.ok ? 'B would encrypt to: ' + (bAudience.shareWith ?? []).join(', ') : bAudience.why);

  /**
   * ── ★★ THE HAZARD RE-SEALING INTRODUCES, AND THE ONE THING THAT GUARDS IT ──
   *
   * Re-sealing REPLACES the record's recipient set. Invite a second member with a list that has
   * gone stale — or short, because the roster read was truncated — and the members left out are
   * evicted from a workspace they are still seated in, silently, by an operation whose whole
   * purpose was to let somebody IN. Nothing errors: the record publishes, the roster still lists
   * them, and their client simply stops being able to open it.
   *
   * The guard is that callers build the list with `recipientsFor`, which refuses a truncated
   * roster rather than returning the part it read. This proves the guard holds where it matters:
   * after a SECOND invite, the FIRST invitee must still be able to read the record.
   */
  head('★★ a second invite must not evict the first member');
  const cw2 = Wallet.createRandom();
  const C = await party('C (second)  ', cw2);
  const foldBefore = await foldRoster(A.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: rec.record.convener, convenerPod: rec.record.convenerPod,
  });
  const beforeAudience = recipientsFor('private', foldBefore);
  must('the existing roster resolved', beforeAudience.ok, beforeAudience.ok ? '' : beforeAudience.why);
  if (!beforeAudience.ok) return 1;
  const inv2 = await sendInvite(A.client, {
    viewer: A.viewer, workspace, workspaceTitle: 'Private drive ' + slug,
    handle: C.handle, role: contributor, entryShape,
    visibility: 'private',
    ...(beforeAudience.shareWith ? { shareWith: beforeAudience.shareWith } : {}),
  });
  must('C was invited', inv2.kind === 'invited', JSON.stringify(inv2).slice(0, 240));

  const bStillSees = await B.client.readWorkspaceRecord(workspace, A.viewer.podName);
  must('★★ B can STILL read the record after it was re-sealed for C',
    bStillSees.kind === 'record' && !bStillSees.record.withheld,
    bStillSees.kind === 'record' ? 'withheld — the re-seal evicted a seated member' : bStillSees.kind);

  head('A posts, encrypted to the roster');
  const fold = await foldRoster(A.client, {
    workspace, iriOwner: A.viewer.podName, slug,
    convener: rec.record.convener, convenerPod: rec.record.convenerPod,
  });
  must('both are seated', fold.seats.filter((s) => s.seated).length === 2,
    fold.seats.map((s) => s.pod + '=' + s.seated).join(' '));
  const audience = recipientsFor('private', fold);
  must('a recipient list was produced', audience.ok, audience.ok ? '' : audience.why);
  if (!audience.ok) return 1;
  log('    encrypting to: ' + (audience.shareWith ?? []).join(', '));

  const secret = 'the-secret-' + Date.now().toString(36);
  const streamIri = fold.seats.find((s) => s.pod === A.viewer.podName)?.stream
    ?? nsIri(RELAY, A.viewer.podName, qualifiedName(A.viewer.podName, slug, 'stream'));
  const posted = await postEntry(A.client, {
    podName: A.viewer.podName, streamIri, workspace, entryShape,
    body: secret,
    author: { kind: 'principal', webId: A.viewer.webId },
    visibility: 'private',
    ...(audience.shareWith ? { shareWith: audience.shareWith } : {}),
  });
  must('the entry was accepted', posted.kind === 'accepted', JSON.stringify(posted).slice(0, 300));
  if (posted.kind !== 'accepted') return 1;

  /**
   * ★★ THE SILENT FAILURE THAT LOOKS LIKE SUCCESS. `resolveRecipient` returns an EMPTY key list
   * rather than an error when a handle does not resolve or a pod registers no encryption key, so
   * an entry encrypted to NOBODY is a 200 with a well-formed descriptor. `agentCount` is the only
   * evidence it ever happened.
   */
  const unreached = unreachedRecipients(posted.response ?? null);
  must('★★ every named recipient resolved to at least one key', unreached.length === 0,
    'reached nobody: ' + unreached.join(', '));

  head('★★ can B — a different person, on a different pod — actually read it?');
  /**
   * ★ THE PUBLISH IS DEFERRED. It answers `status: "pending"` and the pod write commits after the
   * tool call returns, so an immediate read from the other side finds an empty stream — which
   * looks exactly like "B cannot see A's entries" and is really just a race. Waited for, and said
   * so if it never arrives, rather than blamed on the encryption.
   */
  let bRows: ReturnType<typeof toChainRow>[] = [];
  for (const deadline = Date.now() + 60_000; ;) {
    bRows = (await B.client.manifest(A.viewer.podName, streamIri)).map(toChainRow);
    if (bRows.length > 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const bChain = orderChain(bRows);
  must('B can see the entry in A\'s stream', bChain.ordered.length > 0, 'the chain read empty');
  const last = bChain.ordered[bChain.ordered.length - 1];
  if (!last) return 1;
  // Through `client.descriptor`, which is where the sealed read and the opening happen — the same
  // path every reader in the app takes, not a special one for this driver.
  const bRead = await B.client.descriptor(last.url);
  const bGraph = bRead['graph'] as { content?: string | null } | undefined;
  // The entry's words are `dct:description` — `entryTurtle` is the only writer of this document,
  // and that is the term it emits. Falling back to the whole payload keeps the assertion honest if
  // the region cannot be located: the secret is either in what B got back, or it is not.
  const bBody = bGraph?.content ?? '';
  must('★★ B OPENED A\'S ENTRY — this is the whole claim', bBody.includes(secret),
    bRead['openedWithOwnKey'] ? 'decrypted, but the words are not there: ' + String(bGraph?.content).slice(0, 200)
      : 'not decrypted at all: ' + String(bGraph?.content).slice(0, 200));
  must('★ and it says so — the content was decrypted here, not served in the clear',
    bRead['openedWithOwnKey'] === true, 'the relay handed back plaintext, so this is at-rest and not end-to-end');

  /**
   * ── ★★ WHO IS ACTUALLY IN THE ENVELOPE ──────────────────────────────────────
   *
   * Every assertion above passes if the relay is ALSO a recipient. "B can open it" and "a stranger
   * cannot" are both true of an envelope that the relay can read too — so neither of them, nor
   * both together, establishes the word "end-to-end". The only thing that does is counting the
   * recipients and recognising every one of them.
   *
   * This is the check that was missing when this was first called verified.
   */
  head('★★ is the relay a recipient? — the check that decides whether "end-to-end" is the word');
  const sealed = await B.client.tool('get_encrypted_graph', { url: last.url });
  const envelope = JSON.parse((sealed as { envelope: string }).envelope) as {
    wrappedKeys?: { recipientPublicKey?: string }[];
  };
  const inEnvelope = (envelope.wrappedKeys ?? []).map((w) => String(w.recipientPublicKey));
  const aKey = deriveEncryptionKeyPair(aw.privateKey).publicKey;
  const bKey = deriveEncryptionKeyPair(bw.privateKey).publicKey;
  const known = new Map([[aKey, 'A'], [bKey, 'B']]);

  /**
   * ── ★★ IDENTIFYING THE THIRD KEY WITHOUT ASSUMING THE ANSWER ────────────────
   *
   * `/render` cannot tell us: it gates own-pod BEFORE the recipient check, so an anonymous fetch
   * gets `NotYourPod` and never reaches the `NotARecipient` body that names the relay's key.
   *
   * So it is derived instead, from TWO envelopes with different member sets. The workspace RECORD
   * is sealed to {A, C} (C was invited after B) and this ENTRY to {A, B}. A key present in both
   * and belonging to no member of either cannot be a member key — it is process-wide. That is
   * exactly the claim, established rather than assumed.
   */
  const recHead = await A.client.currentHead(workspace, A.viewer.podName);
  const recHeadUrl = recHead.forked ? null : recHead.url;
  const recSealed = recHeadUrl ? await B.client.tool('get_encrypted_graph', { url: recHeadUrl }) : null;
  const recEnvelope = recSealed && (recSealed as { envelope?: string }).envelope
    ? JSON.parse((recSealed as { envelope: string }).envelope) as { wrappedKeys?: { recipientPublicKey?: string }[] }
    : { wrappedKeys: [] };
  const inRecord = (recEnvelope.wrappedKeys ?? []).map((w) => String(w.recipientPublicKey));
  const cKey = deriveEncryptionKeyPair(cw2.privateKey).publicKey;
  const members = new Set([aKey, bKey, cKey]);
  const inBothAndNeitherMember = inEnvelope.filter((k) => inRecord.includes(k) && !members.has(k));
  const relayKey = inBothAndNeitherMember[0] ?? '';

  const strangers = inEnvelope.filter((k) => !known.has(k));
  const label = (k: string): string => known.get(k) ?? (k === relayKey ? 'THE RELAY' : 'UNKNOWN');
  log('    recipients: ' + inEnvelope.map((k) => label(k) + ' ' + k.slice(0, 12) + '…').join(', '));

  /**
   * ── ★★ WHAT THIS PINS, AND WHY IT IS AN ASSERTION RATHER THAN A COMPLAINT ───
   *
   * The relay is a recipient of every private-workspace envelope: `authorEncryptionKey` is
   * hardcoded to `relayAgentKey.publicKey` and `computePublishRecipients` pushes it into every
   * `'shared'` publish. So this content is encrypted AT REST by a relay that can read it — not
   * end-to-end between members. Measured, not inferred: two runs with four different wallets put
   * the same third key in both envelopes.
   *
   * It is pinned as the CURRENT truth so that removing it is a measured reversal rather than a
   * test quietly starting to pass. Every other assertion in this driver — B opens it, a stranger
   * cannot — is equally true of an escrowed envelope, which is exactly why none of them caught it.
   */
  must('★ a non-member key was identified from two envelopes, so this check can fail', relayKey !== '',
    'no key appears in both the record and the entry while belonging to no member of either — without '
      + 'one, "the relay is not a recipient" would pass for the wrong reason. Record recipients: '
      + inRecord.length + ', entry recipients: ' + inEnvelope.length);
  must('★★ TODAY: a process-wide key (the relay\'s) is a recipient. This is escrow, not end-to-end',
    relayKey !== '' && inEnvelope.includes(relayKey),
    'the relay is no longer in the envelope. If that is deliberate, this assertion is what you came '
      + 'to invert: flip it to `!inEnvelope.includes(relayKey)` and say so in the commit.');
  must('★ and nobody unaccounted-for is in there either',
    strangers.every((k) => k === relayKey),
    strangers.filter((k) => k !== relayKey).join(', ') + ' belongs to neither member nor the relay');

  head('★ and a stranger, seated in nothing, must be refused');
  // The same sealed bytes fetched above, offered to a key that is on no roster and never was.
  /**
   * ★ `not-for-you`, NOT MERELY "did not open". The opener has three answers now, and the
   * difference is the whole point: a stranger must be REFUSED as a permission, not reported as
   * damage. `=== null` used to say this and stopped being true when the third answer was added —
   * it failed loudly rather than passing, which is what a comparison against a changed type should
   * do.
   */
  const strangerSees = strangerOpener(sealed);
  must('★★ the stranger cannot open it', strangerSees.kind === 'not-for-you',
    'answered ' + strangerSees.kind + '; an unrelated key must be refused as a permission, and if it '
      + 'OPENED this then the envelope is not addressed to anybody in particular');

  return bad;
}

run().then((n) => {
  log(n ? '\n' + n + ' problem(s) — a private workspace is NOT usable end to end'
    /**
     * ★ THE CLOSING SENTENCE SAYS WHAT WAS ESTABLISHED AND NOT ONE WORD MORE. Every check above
     * passes just as well when the relay is ALSO a recipient — and it is, which this run asserts.
     * "Works end to end" was the wrong sentence, and it sat on this line for a whole day.
     */
    : '\nusable between its members, AND escrowed to the relay: A wrote it sealed, B opened it, a stranger'
      + '\ncould not — and a process-wide relay key is a recipient of every envelope, which is why this is'
      + '\nencryption AT REST rather than end-to-end.');
  process.exit(n ? 1 : 0);
}).catch((e: unknown) => {
  log('\nthe driver could not complete: ' + ((e as Error)?.stack ?? String(e)));
  process.exit(1);
});
