/**
 * WHAT THE BOT DOES TO THE SUBSTRATE. Nothing in this file knows what Discord is.
 *
 * Every outcome below is a verdict plus the checks that produced it, and a renderer turns it
 * into a message — the same split `@interego/workspace-client` keeps, and for the same reason:
 * a decision made inside a formatting function is a decision no test can reach.
 *
 * ★ AND EVERY SUBSTRATE OPERATION HERE IS THE MODULE'S. `createWorkspace`, `sendInvite`,
 * `verifyGrantIri`, `acceptGrant`, `findSeat`, `foldRoster`, `postEntry`, `orderChain`,
 * `graphRegion`, the naming scheme, the role table — all imported. This bot is a third client of
 * one implementation, not a third implementation. The last time this vertical had two, it
 * shipped a workspace that folded differently depending on which client opened it.
 */

import {
  type Check, type GrantVerdict, type RosterFold, type Seat, type Viewer, type WorkspaceRecord,
  POD_RX, acceptGrant, checkDelegation, checkRoleForWorkspace, createWorkspace, errorCopy,
  findSeat, foldRoster, graphRegion, nsIri, orderChain, parseRoleProfile, podOfNsIri, postEntry,
  qualifiedName, readAuthorship, readDelegates, readEntryAuthorship, readInt, readIri, readIriAll, readLiteral,
  recipientsFor,
  verifiedSigner,
  readMember, sendInvite, toChainRow,
  type AuthorshipReading, type DelegateRoster, type EntryAttachment, type EntryAuthorship, type PostOutcome,
  type WorkspaceClient,
  delegatePort,
} from '@interego/workspace-client';
import { challengeLabel, slugFor, SNOWFLAKE_RX, type Link, type LinkStore, type ThreadBinding } from './links.js';

export interface Deps {
  readonly relay: string;
  readonly client: WorkspaceClient;
  /** The agent DID participants delegate. Read from the relay at boot, never a literal. */
  readonly agentId: string;
  readonly store: LinkStore;
}

/** How many entries `/workspace show` reads bodies for. Each one is a descriptor round trip. */
export const SHOW_ENTRY_CAP = 12;

// ── linking ──────────────────────────────────────────────────────────────────

export interface LinkChallengeOut {
  readonly kind: 'challenge';
  readonly agentId: string;
  /** `discord-link <this account's id>`. Public by construction — see `links.ts`. */
  readonly label: string;
  /** The pod already bound to this Discord user, when re-linking. */
  readonly existing: Link | null;
}

/**
 * Say exactly what to publish, and open the window in which a confirm will be answered.
 *
 * The bot asks for nothing and is given nothing: the next move is entirely on the participant's
 * side, in a client of their own, against their own pod. If they never make it, nothing has
 * happened and nothing of theirs was touched.
 */
export function beginLink(deps: Deps, discordUserId: string): LinkChallengeOut {
  deps.store.issue(discordUserId);
  return {
    kind: 'challenge',
    agentId: deps.agentId,
    // Derived from the account asking, here and again at confirm time — never carried between
    // the two, because a value carried is a value that can be substituted.
    label: challengeLabel(discordUserId),
    existing: deps.store.linkOf(discordUserId),
  };
}

export type ConfirmOut =
  | { readonly kind: 'no-challenge'; readonly why: string }
  | { readonly kind: 'bad-pod'; readonly why: string }
  | { readonly kind: 'contested'; readonly pod: string; readonly others: readonly string[]; readonly why: string }
  | { readonly kind: 'refused'; readonly pod: string; readonly checks: readonly Check[]; readonly why: string; readonly attemptsLeft: number }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'linked'; readonly link: Link; readonly checks: readonly Check[] };

/**
 * Hold the claim against the substrate and bind only if it stands.
 *
 * ★ TWO THINGS ARE BEING ESTABLISHED AND ONLY THE FIRST IS THE RELAY'S BUSINESS.
 * `checkDelegation` answers "may this agent write to that pod" from the pod's own registry and
 * the relay's own enforcement verdict. It does NOT answer "is that pod THIS Discord user's" —
 * nothing in the substrate knows what a Discord user is. The row's LABEL is the bridge: only the
 * pod's owner can have written it, because `register_agent` is own-pod gated, and it names the
 * Discord account the delegation is for. So the label test and the authority test together are
 * the binding, and either alone is not.
 *
 * ★ AND THE LABEL IS DERIVED FROM `args.discordUserId`, WHICH THE GATEWAY SUPPLIED, NEVER FROM
 * ANYTHING CARRIED FROM `beginLink`. A value handed out and handed back is a value that can be
 * substituted; a value computed from who is asking cannot be. See `links.ts` for the
 * world-readable-label defect this shape replaced.
 */
export async function confirmLink(deps: Deps, args: { readonly discordUserId: string; readonly podName: string }): Promise<ConfirmOut> {
  const challenge = deps.store.challengeOf(args.discordUserId);
  if (!challenge) {
    return { kind: 'no-challenge', why: 'Run `/workspace link` first. One `/workspace link` licenses ten minutes and five confirms; a restart of this bot cancels it. That is a rate limit, not a password — nothing about it is secret.' };
  }
  // ★ VALIDATED BEFORE IT REACHES A TOOL CALL. This string came off a Discord message box and is
  // about to be interpolated into `pod_name` and, downstream, into IRIs whose signed regions are
  // then located by name. `POD_RX` is the module's own definition of a pod segment.
  if (!POD_RX.test(args.podName)) {
    return { kind: 'bad-pod', why: 'That is not a pod identifier. It looks like `u-eth-…`, `u-pk-…` or `u-did-…` — your own client shows it, and `get_pod_status` reports it as the last segment of your pod URL.' };
  }
  // ★ A POD MAY BE CLAIMED BY ONE DISCORD ACCOUNT. Without this, a second account presenting a
  // valid code for a pod already bound would silently take over whose messages land there.
  const others = deps.store.claimantsOf(args.podName).filter((u) => u !== args.discordUserId);
  if (others.length) {
    return {
      kind: 'contested', pod: args.podName, others,
      why: 'Pod ' + args.podName + ' is already bound to another Discord account here. One pod, one claimant — that account has to `/workspace unlink` first. Nothing was written.',
    };
  }
  if (!deps.store.spendAttempt(args.discordUserId)) {
    return { kind: 'no-challenge', why: 'That is five confirms for one `/workspace link`. Run `/workspace link` again.' };
  }
  let verdict;
  try {
    verdict = await checkDelegation(deps.client, {
      agentId: deps.agentId, podName: args.podName,
      // From the account asking. Not from the challenge, and not from anything the caller sent.
      expectLabel: challengeLabel(args.discordUserId),
    });
  } catch (e) { return { kind: 'error', error: e }; }
  if (!verdict.ok) {
    const left = Math.max(0, 5 - challenge.attempts);
    return { kind: 'refused', pod: args.podName, checks: verdict.checks, why: verdict.why ?? 'the delegation check did not pass', attemptsLeft: left };
  }
  let member: Viewer;
  try { member = await readMember(deps.client, args.podName); }
  catch (e) { return { kind: 'error', error: e }; }
  const link: Link = {
    discordUserId: args.discordUserId,
    pod: args.podName,
    webId: member.webId,
    boundAt: new Date().toISOString(),
    scopeAtBinding: verdict.scope,
    basisAtBinding: verdict.basis,
  };
  deps.store.bind(link);
  // Burnt on success only: a failed attempt is usually somebody who has not run `register_agent`
  // yet, and burning their code for that would make the honest path the hardest one.
  deps.store.burn(args.discordUserId);
  return { kind: 'linked', link, checks: verdict.checks };
}

export interface UnlinkOut { readonly kind: 'unlinked' | 'was-not-linked'; readonly had: Link | null; readonly agentId: string }

/**
 * Forget a pod.
 *
 * ★ THIS DOES NOT REVOKE ANYTHING AND MUST NOT SAY IT DOES. The delegation lives on the
 * participant's pod, and only they can withdraw it — `revoke_agent`. Forgetting the binding stops
 * this bot writing their messages; it does not stop this bot being ABLE to. Saying otherwise
 * would be the bot vouching for its own restraint, which is exactly the thing the delegation
 * model exists so nobody has to do.
 */
export function unlink(deps: Deps, discordUserId: string): UnlinkOut {
  const had = deps.store.unbind(discordUserId);
  return { kind: had ? 'unlinked' : 'was-not-linked', had, agentId: deps.agentId };
}

// ── starting a workspace ─────────────────────────────────────────────────────

export type StartOut =
  | { readonly kind: 'not-linked' }
  | { readonly kind: 'bad-thread'; readonly why: string }
  | { readonly kind: 'already'; readonly binding: ThreadBinding }
  | { readonly kind: 'not-delegated'; readonly pod: string; readonly checks: readonly Check[]; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'created'; readonly binding: ThreadBinding; readonly streamIri: string; readonly seated: boolean; readonly why: string | null }
  | { readonly kind: 'create-failed'; readonly detail: string; readonly done: readonly string[] };

/**
 * Five documents on the CALLER's own pod, written by the bot under their delegation.
 *
 * The workspace is theirs in every sense the substrate recognises: their pod holds the record,
 * their WebID is the convener, their pod is where grants are read from. The bot holds nothing.
 */
export async function startWorkspace(
  deps: Deps,
  args: {
    readonly threadId: string;
    readonly threadName: string;
    readonly discordUserId: string;
    /** The workspace's audience, chosen once. Omitted is public — see the option's description. */
    readonly visibility?: 'public' | 'private';
  },
): Promise<StartOut> {
  const link = deps.store.linkOf(args.discordUserId);
  if (!link) return { kind: 'not-linked' };
  const existing = deps.store.threadOf(args.threadId);
  if (existing) return { kind: 'already', binding: existing };
  const slug = slugFor(args.threadId);
  if (!slug) return { kind: 'bad-thread', why: 'This channel\'s id is not a Discord snowflake, so a workspace name cannot be derived from it. Nothing was written.' };

  let member: Viewer;
  try {
    const gate = await checkDelegation(deps.client, { agentId: deps.agentId, podName: link.pod });
    if (!gate.ok) return { kind: 'not-delegated', pod: link.pod, checks: gate.checks, why: gate.why ?? 'the delegation no longer stands' };
    member = await readMember(deps.client, link.pod);
  } catch (e) { return { kind: 'error', error: e }; }

  const title = args.threadName.trim() || 'Discord thread ' + args.threadId;
  const out = await createWorkspace(deps.client, { relay: deps.relay, viewer: member, title, slug, visibility: args.visibility ?? 'public' });
  if (out.kind === 'invalid') return { kind: 'create-failed', detail: out.why, done: [] };
  if (out.kind === 'error') return { kind: 'create-failed', detail: 'at "' + out.at + '": ' + errorCopy(out.error).t + ' — ' + errorCopy(out.error).d, done: out.done };
  if (out.kind === 'refused') return { kind: 'create-failed', detail: 'at "' + out.at + '" the relay refused: ' + JSON.stringify(out.refusal).slice(0, 300), done: out.done };
  if (out.kind === 'stalled') return { kind: 'create-failed', detail: 'at "' + out.at + '": ' + out.why, done: out.done };

  const binding: ThreadBinding = {
    threadId: args.threadId, convenerPod: link.pod, workspace: out.workspace, slug,
    title, startedAt: new Date().toISOString(), startedBy: args.discordUserId,
  };
  deps.store.bindThread(binding);
  return { kind: 'created', binding, streamIri: out.streamIri, seated: out.seated, why: out.why };
}

// ── recording a message ──────────────────────────────────────────────────────

export type RecordOut =
  /** Not a workspace thread. The bot says nothing at all — a channel is not its business. */
  | { readonly kind: 'not-a-workspace' }
  /** Nothing was recorded, and the author is told once. Ignoring in silence is the dishonest option. */
  | { readonly kind: 'unlinked'; readonly discordUserId: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'not-delegated'; readonly pod: string; readonly checks: readonly Check[]; readonly why: string }
  | { readonly kind: 'unseated'; readonly pod: string; readonly why: string; readonly seating: readonly Check[] }
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'recorded';
      readonly pod: string;
      readonly streamIri: string;
      readonly seated: 'already' | 'just-now';
      readonly outcome: PostOutcome;
      readonly authorship: AuthorshipReading | null;
    };

/** What the bot posts and reads for one workspace, resolved from the record every time. */
interface Frame {
  readonly binding: ThreadBinding;
  readonly record: WorkspaceRecord;
  readonly convenerPod: string;
  readonly rolesIri: string;
}

async function frameOf(deps: Deps, binding: ThreadBinding): Promise<Frame | { readonly problem: string }> {
  const iriOwner = podOfNsIri(binding.workspace);
  if (!iriOwner) return { problem: 'the stored workspace IRI is not one a pod can be read out of: ' + binding.workspace };
  const read = await deps.client.readWorkspaceRecord(binding.workspace, iriOwner);
  if (read.kind === 'forked') return { problem: 'the workspace record has ' + read.heads.length + ' unresolved heads, so which record governs here is not decided. Nothing was written.' };
  if (read.kind === 'missing') return { problem: 'the workspace record could not be read: ' + read.message };
  if (!read.record.regionFound) {
    /**
     * ★ Withheld, not malformed — see `WorkspaceRecord.withheld`. A bot that told a channel
     * somebody's private record was unsigned would be turning a permission into an accusation.
     *
     * ★★ AND A FAILED READ IS NEITHER OF THOSE. `sealedReadFailed` means the bytes could not be
     * fetched or opened — a CSS blip, a damaged envelope. Reporting that as "this bot is not a
     * member" makes a claim about membership out of a network error, and sends somebody off to fix
     * permissions that were never the problem.
     *
     * ★★ THE REFUSAL NAMES THE WAY OUT, because there is one and it is not obvious. This bot is a
     * conduit and is never seated, so nobody encrypts to it — its own key sits in its own registry,
     * which no publisher reads. But it HAS a pod, so it can be invited exactly like a person, and
     * then it is a member by the ordinary rules: on the roster, in the recipient list, revocable.
     * That is the difference between a dead end and a decision, and it needs no new machinery.
     */
    return { problem: read.record.withheld
      ? (read.record.sealedReadFailed
        ? 'this workspace is private and its record could not be READ: ' + read.record.sealedReadFailed
          + '. That is a failure to fetch or open the bytes, not a statement about who this bot is, so '
          + 'nothing follows from it about membership. Try again.'
        : 'this workspace is private and its record is encrypted to its members. This bot is not one of '
          + 'them — it is a conduit, and nobody encrypts to a conduit by default. If you want it to mirror '
          + 'a private workspace, invite it as a member like anybody else. Until then it can carry your '
          + 'messages INTO the workspace but cannot read them back out.')
      : 'the workspace record\'s signed region could not be located, so nothing was read from bytes anybody signed.' };
  }
  return {
    binding, record: read.record,
    // The pod grants live on is the one the RECORD names, not the one in the IRI — the module's
    // own rule, and re-deriving it differently here is how a bot comes to write a grant nobody
    // reading the workspace would ever look for.
    convenerPod: read.record.convenerPod ?? iriOwner,
    rolesIri: read.record.roleProfile ?? nsIri(deps.relay, iriOwner, binding.slug + '-roles'),
  };
}

/**
 * Every seated member's WebID, for a private workspace.
 *
 * ★ FOLDED ON DEMAND AND ONLY WHEN PRIVATE. The roster costs two round trips per grant, far too
 * much to spend on every message in a public channel — and a public workspace has no recipients to
 * compute. It THROWS rather than returning a short list: `recipientsFor` refuses a truncated
 * roster, and encrypting to the part of it that was read would lock out the members it missed,
 * permanently and with nothing to show for it.
 */
async function audienceFor(deps: Deps, frame: Frame): Promise<{ visibility: 'public' | 'private'; shareWith?: readonly string[]; pendingWebIds?: readonly string[] }> {
  /**
   * ★ PUBLIC COSTS NOTHING. The roster is two round trips per grant — far too much to spend on
   * every message in a public channel, and a public workspace has no recipients to compute.
   */
  if (frame.record.visibility !== 'private') {
    const plain = recipientsFor(frame.record.visibility, null);
    if (!plain.ok) throw new Error(plain.why);
    return { visibility: plain.visibility };
  }
  const iriOwner = podOfNsIri(frame.binding.workspace) ?? frame.convenerPod;
  const roster = await foldRoster(deps.client, {
    workspace: frame.binding.workspace, iriOwner, slug: frame.binding.slug,
    convener: frame.record.convener, convenerPod: frame.convenerPod,
  });
  const audience = recipientsFor('private', roster);
  /**
   * ★ THROWS RATHER THAN RETURNING A SHORT LIST. `recipientsFor` refuses a truncated roster and a
   * record this client could not read; encrypting to the part it managed to read would lock out
   * the members it missed, permanently, and writing under a guessed visibility would publish in
   * the clear. Both are worse than a message that did not send.
   */
  if (!audience.ok) throw new Error(audience.why);
  return {
    visibility: audience.visibility,
    ...(audience.shareWith ? { shareWith: audience.shareWith } : {}),
    // Only meaningful to `sendInvite`'s reseal; `postEntry` ignores it. Carried here so the seat
    // path cannot forget it — omitting it evicts anybody with an outstanding invitation.
    pendingWebIds: audience.pendingWebIds,
  };
}

/**
 * Seat a participant who is not seated: the convener's grant, then their own acceptance.
 *
 * ★ TWO PODS, TWO DELEGATIONS, AND NEITHER HALF IS MANUFACTURED. The grant is published on the
 * convener's pod under the convener's delegation; the acceptance on the member's pod under
 * theirs. The substrate refuses either party the other's pod, and it refuses this bot both
 * unless both of them delegated it. So the bot cannot seat somebody who has not linked, and it
 * cannot seat anybody at all in a workspace whose convener has revoked it.
 */
async function seat(deps: Deps, frame: Frame, member: Viewer): Promise<{ readonly ok: true; readonly checks: readonly Check[] } | { readonly ok: false; readonly why: string; readonly checks: readonly Check[] }> {
  const checks: Check[] = [];
  const convGate = await checkDelegation(deps.client, { agentId: deps.agentId, podName: frame.convenerPod });
  if (!convGate.ok) {
    return { ok: false, checks: convGate.checks, why: 'seating you needs a grant on the convener\'s pod (' + frame.convenerPod + ') and this bot is no longer delegated there: ' + (convGate.why ?? 'no reason reported') };
  }
  checks.push({ mark: 'y', text: 'The convener\'s pod still delegates this bot, so a grant can be published there' });

  // ★ THE ROLE IS ONE THE WORKSPACE'S OWN TABLE DEFINES, checked before it is granted. A role
  // IRI this client simply believed in would be a grant naming a role no reader of this
  // workspace can resolve — which renders as "role not in this table" for the rest of its life.
  let table: { roles: Map<string, { label: string; comment: string; permits: readonly string[] }> | null; caps: Map<string, { label: string; comment: string }> | null };
  try {
    const profile = await deps.client.fetchProfileTurtle(frame.record.roleProfile ?? frame.rolesIri);
    table = parseRoleProfile(profile.turtle);
  } catch (e) {
    return { ok: false, checks, why: 'this workspace\'s role profile did not resolve (' + errorCopy(e).t.toLowerCase() + '), so no role could be checked and none was granted' };
  }
  const role = (frame.record.roleProfile ?? frame.rolesIri) + '#Contributor';
  const roleOk = checkRoleForWorkspace(table, role);
  if (!roleOk.ok) return { ok: false, checks, why: roleOk.why };
  checks.push({ mark: 'y', text: 'Contributor is a role this workspace\'s own table defines' });

  let convener: Viewer;
  try { convener = await readMember(deps.client, frame.convenerPod); }
  catch (e) { return { ok: false, checks, why: 'the convener\'s pod could not be read: ' + errorCopy(e).t }; }

  const invited = await sendInvite(deps.client, {
    viewer: convener, workspace: frame.binding.workspace, workspaceTitle: frame.record.title || frame.binding.title,
    // The composed handle rather than a pod name: `sendInvite` resolves an invitee through
    // WebFinger, which is the one step that establishes the pod and the WebID agree.
    handle: 'acct:' + member.podName + '@' + new URL(deps.relay).host,
    role, entryShape: frame.record.entryShape,
    /**
     * ★★ SEATING SOMEBODY IN A PRIVATE WORKSPACE MEANS RE-SEALING ITS RECORD TO THEM. Written when
     * the convener was its only member, it is encrypted to the convener alone — so without this
     * the new member cannot read the record, cannot verify the grant just written for them, and
     * cannot accept. `sendInvite` adds the invitee; this is the roster it already had.
     */
    ...(await audienceFor(deps, frame)),
  });
  if (invited.kind !== 'invited') {
    const why = invited.kind === 'blocked' ? (invited.resolution.blocked ?? 'the invitee could not be resolved to a pod a grant would seat')
      : invited.kind === 'resolve-failed' ? 'resolving your handle failed: ' + errorCopy(invited.error).t
      : invited.kind === 'refused' ? 'the relay refused the grant: ' + JSON.stringify(invited.refusal).slice(0, 240)
      : 'publishing the grant failed: ' + errorCopy(invited.error).t;
    return { ok: false, checks, why };
  }
  checks.push({ mark: invited.readable ? 'y' : 'q', text: invited.readable
    ? 'A Contributor grant naming you was published on ' + frame.convenerPod + ' and read back'
    : 'A Contributor grant naming you was accepted on ' + frame.convenerPod + ' and is not yet reported readable: ' + (invited.why ?? 'no reason reported') });

  // The acceptance is written against the grant as VERIFIED, not against the invite's own report
  // of itself — `acceptGrant` needs the revision CID, and the only honest source for it is a read
  // of the grant that is there now.
  const found: GrantVerdict = await findSeat(deps.client, { relay: deps.relay, viewer: member, workspace: frame.binding.workspace });
  if (!found.ok) {
    return { ok: false, checks, why: 'the grant was published and does not yet seat you: ' + (found.why ?? 'no reason reported') };
  }
  const accepted = await acceptGrant(deps.client, { relay: deps.relay, viewer: member, verdict: found });
  if (accepted.kind !== 'accepted') {
    return { ok: false, checks, why: accepted.kind === 'refused'
      ? 'the relay refused your acceptance: ' + JSON.stringify(accepted.refusal).slice(0, 240)
      : 'publishing your acceptance failed: ' + errorCopy(accepted.error).t };
  }
  checks.push({ mark: accepted.readable ? 'y' : 'q', text: accepted.readable
    ? 'Your own acceptance was published on ' + member.podName + ' and read back'
    : 'Your acceptance was accepted and is not yet reported readable: ' + (accepted.why ?? 'no reason reported') });
  return { ok: true, checks };
}

/** Append one Discord message to its author's own log. */
export async function recordMessage(
  deps: Deps,
  args: {
    readonly threadId: string;
    readonly discordUserId: string;
    readonly text: string;
    /**
     * Agents this message is a request TO.
     *
     * ★ AN ASK GOES DOWN THIS PATH AND NOT A SECOND ONE. The delegation gate, the frame read, the
     * seating of an unseated member and the per-pod CAS append all happen here; an ask written by
     * its own writer would be an ask that skipped one of them the first time somebody changed one.
     * The only difference between "Mark said something" and "Mark asked an agent something" is one
     * predicate inside the signed region.
     */
    readonly addressedTo?: readonly string[];
    /**
     * Files posted with the message.
     *
     * ★ THEY MAKE AN OTHERWISE-EMPTY MESSAGE RECORDABLE. A picture with no caption arrives with
     * `text: ""`, and this used to answer `{ kind: 'empty' }` — correct about the words and wrong
     * about the event, because the person posted something and the pod said they had not.
     */
    readonly attachments?: readonly EntryAttachment[];
  },
): Promise<RecordOut> {
  const binding = deps.store.threadOf(args.threadId);
  if (!binding) return { kind: 'not-a-workspace' };
  const link = deps.store.linkOf(args.discordUserId);
  if (!link) return { kind: 'unlinked', discordUserId: args.discordUserId };
  const body = args.text.trim();
  // ★ EMPTY MEANS NOTHING WAS POSTED, NOT MERELY THAT NOTHING WAS TYPED. An attachment IS
  // something posted, and `EntryDraft.body` is optional in the substrate for exactly this reason.
  if (!body && !args.attachments?.length) return { kind: 'empty' };

  try {
    // ★ ASKED BEFORE EVERY WRITE, AND THE RELAY'S OWN GATE IS NOT THE BOUNDARY. Measured
    // 2026-08-07: after `revoke_agent`, the relay ACCEPTED this bot's next cross-pod publish —
    // its scope gate caches per (agent, pod) for 60 s. `verify_agent` is not cached and answered
    // correctly immediately. So a delegate that leaned on the relay to stop it would keep writing
    // to a pod whose owner had just withdrawn permission, for up to a minute, and the entries
    // would be indistinguishable from authorised ones afterwards.
    const gate = await checkDelegation(deps.client, { agentId: deps.agentId, podName: link.pod });
    if (!gate.ok) return { kind: 'not-delegated', pod: link.pod, checks: gate.checks, why: gate.why ?? 'the delegation no longer stands' };

    const frame = await frameOf(deps, binding);
    if ('problem' in frame) return { kind: 'unseated', pod: link.pod, why: frame.problem, seating: [] };
    const member = await readMember(deps.client, link.pod);

    let seated: 'already' | 'just-now' = 'already';
    const already = await findSeat(deps.client, { relay: deps.relay, viewer: member, workspace: binding.workspace });
    if (!already.ok) {
      const put = await seat(deps, frame, member);
      if (!put.ok) return { kind: 'unseated', pod: link.pod, why: put.why, seating: put.checks };
      seated = 'just-now';
    }

    /**
     * ★★ WHO THIS ENTRY IS ENCRYPTED TO, IN A PRIVATE WORKSPACE.
     *
     * Entries live on their AUTHOR's pod and seal to that pod's own agents unless the other
     * members are named. Without this a private channel becomes one conversation per member, each
     * invisible to all the others — and from Discord it would look like everyone was talking
     * normally while nobody could read anybody.
     *
     * ★ FOLDED ONLY WHEN IT IS NEEDED. The roster costs two round trips per grant, which is far
     * too much to spend on every message in a public channel — and a public workspace has no
     * recipients to compute.
     */
    let audience: { visibility: 'public' | 'private'; shareWith?: readonly string[] };
    try { audience = await audienceFor(deps, frame); }
    catch (e) { return { kind: 'unseated', pod: link.pod, why: (e as Error).message, seating: [] }; }

    // Composed, not read: the two names a member writes under are derived from the workspace's
    // own pod and slug, which is what every reader of this workspace looks for.
    const streamIri = nsIri(deps.relay, member.podName, qualifiedName(frame.convenerPod, binding.slug, 'stream'));
    const outcome = await postEntry(deps.client, {
      podName: member.podName, streamIri, workspace: binding.workspace,
      body, entryShape: frame.record.entryShape,
      /**
       * ★★ THE WORKSPACE'S OWN POLICY, FROM THE RECORD THIS FRAME WAS BUILT FROM.
       *
       * Omitting it publishes a plaintext entry into a private workspace: a 200, and a permanent
       * hole in a conversation every other record of which is sealed. Nothing would report it —
       * the entry reads perfectly well, which is the problem.
       *
       * ★ AND IT IS DECIDED BY THE WORKSPACE, NOT BY DISCORD. Whether these words are also visible
       * in a Discord channel is a different layer with a different audience; it does not change
       * who the record on the pod is written for.
       */
      ...audience,
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
      ...(args.addressedTo === undefined ? {} : { addressedTo: args.addressedTo }),
      /**
       * ★ THE PERSON, NOT THIS BOT, AND THAT IS NOT AN OVERSIGHT.
       *
       * This bot is a CONDUIT. The words in `body` are the ones a human typed into Discord; it
       * carried them and did not write them. So the entry is theirs and names them, exactly as it
       * did before delegates existed — a delegation row is what lets this process write to their
       * pod, and it is not a claim of authorship.
       *
       * A DELEGATE is the other case: it composes text the person did not write, and its entries
       * name it as the author. `delegates.ts` states the distinction; this line is the side of it
       * that must not move.
       */
      author: { kind: 'principal', webId: member.webId },
    });
    const authorship = outcome.kind === 'accepted' ? readAuthorship(outcome.response['authorship']) : null;
    return { kind: 'recorded', pod: member.podName, streamIri, seated, outcome, authorship };
  } catch (e) { return { kind: 'error', error: e }; }
}

// ── the composed view ────────────────────────────────────────────────────────

/** One entry, read from the pod whose owner holds the log. */
export interface ShownEntry {
  readonly pod: string;
  readonly seq: number | null;
  /** The author's own declared time. A CLOCK, and the renderer says so. */
  readonly created: string | null;
  readonly body: string | null;
  readonly descriptorUrl: string;
  /**
   * WHO COMPOSED IT, read out of the same signed region as the body.
   *
   * ★ NOT THE POD. The pod says whose LOG this is; the entry says who WROTE it, and a delegate
   * writing for that person makes those different. This bot renders channels other people's
   * clients wrote into, so it is exactly the reader that must not collapse them. Null only when
   * the region could not be located at all — `why` then says so.
   */
  readonly author: EntryAuthorship | null;
  /**
   * What this entry declares it was written in answer to — `prov:wasDerivedFrom`, out of the same
   * signed region.
   *
   * ★ CARRIED BECAUSE "HAS THIS ASK BEEN ANSWERED" IS A QUESTION ABOUT A RECORD AND NOT ABOUT A
   * POD. The watcher used to end an ask's wait when anything at all appeared from the target's
   * delegator's pod, which meant their human saying "back from lunch" silenced the notice about
   * their agent's unanswered request. This is the field that makes the real answer checkable, and
   * it is the same derivation `verifyRequest` reads to know an ask has been answered already.
   */
  readonly derivedFrom: string | null;
  /**
   * The agents this entry names as its addressees — `iep:addressedTo`, same signed region.
   *
   * ★ CARRIED SO THAT "WHO IS THIS FOR" TRAVELS WITH THE ENTRY RATHER THAN BEING RE-FETCHED. A
   * reader that had to go back to the descriptor to find out would be a reader that usually did
   * not bother. Empty when the region says nobody — and ALSO empty when the region could not be
   * located, which is why `why` is non-null in exactly that case and every consumer that acts on
   * addressing has to treat an unreadable entry as unreadable rather than as unaddressed.
   */
  readonly addressedTo: readonly string[];
  readonly why: string | null;
}

/** One member's log, as far as it could be read. */
export interface ShownStream {
  readonly pod: string;
  readonly stream: string;
  readonly total: number;
  readonly forked: boolean;
  readonly partial: boolean;
  readonly why: string | null;
}

export type ShowOut =
  | { readonly kind: 'not-a-workspace' }
  | { readonly kind: 'unreadable'; readonly binding: ThreadBinding; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'view';
      readonly binding: ThreadBinding;
      readonly record: WorkspaceRecord;
      readonly fold: RosterFold;
      readonly streams: readonly ShownStream[];
      readonly entries: readonly ShownEntry[];
      readonly truncated: boolean;
      readonly totalEntries: number;
    };

/**
 * Fold the workspace and read the newest entries out of every seated member's own log.
 *
 * ★ ORDER WITHIN A LOG IS THE CHAIN. ORDER ACROSS LOGS IS A CLOCK, AND THAT IS SAID RATHER THAN
 * SMOOTHED OVER. Each member's entries are ordered by the supersession links they declare, which
 * nothing outside that pod can rewrite. Between two members there is no such link — the
 * substrate establishes no happens-before across pods — so the interleaving below is by each
 * entry's own `dct:created`, which is whatever their client's clock said. A view that presented
 * that as the order of events would be inventing a fact the record does not carry.
 */
export async function showWorkspace(deps: Deps, threadId: string): Promise<ShowOut> {
  const binding = deps.store.threadOf(threadId);
  if (!binding) return { kind: 'not-a-workspace' };
  try {
    const frame = await frameOf(deps, binding);
    if ('problem' in frame) return { kind: 'unreadable', binding, why: frame.problem };
    const iriOwner = podOfNsIri(binding.workspace) ?? binding.convenerPod;
    const fold = await foldRoster(deps.client, {
      workspace: binding.workspace, iriOwner, slug: binding.slug,
      convener: frame.record.convener, convenerPod: frame.record.convenerPod,
      // ★ A COMMAND, NOT AN AUTOCOMPLETE. `/workspace show` is deferred and has fifteen minutes;
      // the Ask picker in `ask.ts` has three seconds and no deferral, so it keeps the default.
      readCap: 200,
    });

    const streams: ShownStream[] = [];
    const rows: { seat: Seat; url: string; cid: string | null }[] = [];
    /**
     * Each seated member's delegates, from THEIR OWN pod.
     *
     * ★ ONE READ PER POD, because authorisation is per pod. Reading one member's registry and
     * applying it to the others would invent an authorization record for somebody else — the trap
     * `delegatedScopes` in `respond.ts` records. A pod that does not answer contributes nothing
     * and its entries then report `authorised: null`, which is "not checked", not "not authorised".
     */
    const delegates = new Map<string, DelegateRoster>();
    for (const s of fold.seats) {
      if (!s.seated || !s.pod) continue;
      const p = s.podServed ?? s.pod;
      if (!delegates.has(p)) delegates.set(p, await readDelegates(delegatePort(deps.client), p));
    }
    for (const s of fold.seats) {
      if (!s.seated || !s.stream || !s.pod) continue;
      // The pod the acceptance was SERVED from when there is one, not the name the document
      // claims — `foldRoster` already separated the two and preferring the claim here would undo it.
      const pod = s.podServed ?? s.pod;
      try {
        const manifest = await deps.client.manifest(pod, s.stream);
        const walk = orderChain(manifest.map(toChainRow));
        streams.push({
          pod, stream: s.stream, total: walk.ordered.length, forked: walk.forked, partial: walk.partial,
          why: walk.forked ? 'this log has ' + walk.heads + ' unresolved heads, so its order is not decided and nothing is being read out of it in sequence' : null,
        });
        if (walk.forked) continue;
        for (const r of walk.ordered) rows.push({ seat: s, url: r.url, cid: r.cid });
      } catch (e) {
        streams.push({ pod, stream: s.stream, total: 0, forked: false, partial: false, why: 'this log could not be read: ' + errorCopy(e).t });
      }
    }

    // Newest-first by the manifest order the chain walk produced, then capped, then read. Reading
    // first and capping after would cost a descriptor round trip per entry on a long workspace.
    const totalEntries = rows.length;
    const take = rows.slice(-SHOW_ENTRY_CAP);
    const entries: ShownEntry[] = [];
    for (const r of take) {
      try {
        const d = await deps.client.descriptor(r.url);
        const content = (d['graph'] as { content?: string } | undefined)?.content ?? '';
        // ★ THE REGION IS NAMED BY THE STREAM, NOT BY THE ENTRY, AND GETTING THAT WRONG READS AS
        // TAMPERING. `postEntry` publishes with `graph_iri: <stream>` and a subject of
        // `<stream>/e/<seq>` inside it, so the TriG block is `<stream> { … }`. Locating it by the
        // ENTRY's IRI finds nothing — and `graphRegion` returning null means "no signed region",
        // which every reader in this vertical renders as a real finding about the document.
        // Measured against the live relay before the fix: three entries that had committed
        // correctly all rendered "the signed region of this entry could not be located".
        const region = graphRegion(content, r.seat.stream ?? '');
        const pod = r.seat.podServed ?? r.seat.pod ?? '?';
        entries.push({
          pod,
          // The sequence the entry DECLARES, read out of the signed region — not one parsed off
          // its own name, which is a string and not an assertion.
          seq: region === null ? null : readInt(region, 'wsp:seq'),
          created: region === null ? null : readLiteral(region, 'dct:created'),
          body: region === null ? null : readLiteral(region, 'dct:description'),
          descriptorUrl: r.url,
          // Held against the GRANT's grantee WebID, which lives on the convener's pod — so the log's
          // owner cannot decide what their own entries are checked against.
          //
          // ★ AND AGAINST THE KEY THE RELAY AUTHENTICATED, which is the one input here that does not
          // come out of the pod owner's own bytes. Without it an entry signed by one key could name
          // any agent as its author, with a full on-behalf-of footing, and this channel would print
          // it as that agent speaking for its human. See `judgeAuthorship`.
          author: region === null ? null : readEntryAuthorship(region, {
            logOwnerWebId: r.seat.grantedTo ?? null,
            delegates: delegates.get(pod) ?? null,
            // `verifiedSigner`, NOT `readAuthorship(...).signerAgent`: the second is whatever the
            // proof NAMES, reported whether or not any check passed. A comparison that decides who
            // spoke may only turn on a signature the relay verified over these bytes.
            signedBy: verifiedSigner(d['authorship']),
          }),
          derivedFrom: region === null ? null : readIri(region, 'prov:wasDerivedFrom'),
          addressedTo: region === null ? [] : readIriAll(region, 'iep:addressedTo'),
          why: region === null ? 'the signed region of this entry could not be located, so nothing was read from bytes anybody signed' : null,
        });
      } catch (e) {
        entries.push({ pod: r.seat.podServed ?? r.seat.pod ?? '?', seq: null, created: null, body: null, descriptorUrl: r.url, author: null, derivedFrom: null, addressedTo: [], why: 'this entry could not be read: ' + errorCopy(e).t });
      }
    }
    // See the header: a clock, and the renderer prints that beside it.
    entries.sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')));
    return { kind: 'view', binding, record: frame.record, fold, streams, entries, truncated: totalEntries > take.length, totalEntries };
  } catch (e) { return { kind: 'error', error: e }; }
}

/** True when this Discord id is one the bot will accept at all. Exported for the gateway. */
export const isSnowflake = (s: unknown): s is string => typeof s === 'string' && SNOWFLAKE_RX.test(s);
