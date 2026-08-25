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
  findSeat, foldRoster, graphRegion, isRetracted, nsIri, orderChain, parseRoleProfile, podOfNsIri, postEntry,
  qualifiedName, readAuthorship, readDelegates, readEntryAuthorship, readInt, readIri, readIriAll, readLiteral,
  recipientsFor,
  verifiedSigner,
  type Sealing, type WriteKind,
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

/**
 * How many grants a fold in this shell may dereference.
 *
 * ── ★★ THE WRITE GATE FOLDED AT 25 WHILE THE COMMAND THAT REPORTS THE ROSTER FOLDED AT 200 ──
 *
 * `audienceFor` passed no `readCap`, so `GRANT_READ_CAP` (25) applied to it, while
 * `showWorkspace` asked for 200 and the desktop asks for 200. On any workspace holding 26 to 200
 * grants that meant `/workspace show` folded the whole roster and reported nothing wrong, the
 * desktop wrote normally, and every Discord message was refused over a shortfall only the message
 * path could see. Two folds of the same workspace, in the same command surface, disagreeing, with
 * the gate on the pessimistic one.
 *
 * One constant, read by both, so they cannot drift apart again.
 */
export const ROSTER_READ_CAP = 200;

/**
 * WHAT ACTUALLY PROTECTED A WRITE, FOR A CHANNEL THAT HAS NO OTHER WAY TO FIND OUT.
 *
 * ── ★★ THIS BOT CANNOT SEAL, AND `Sealing` IS ABOUT A CLIENT THAT CAN ──────
 *
 * `recipientsFor` answers `sealing.mode === 'seal'` when every member of the envelope published an
 * encryption key. That is a statement about the WORKSPACE, and a host that holds key material acts
 * on it by sealing before the payload leaves — the desktop does, in its main process. This bot
 * passes no `seal` callback to `postEntry` at all, and holds none to pass: it is a conduit, its own
 * key is in nobody's envelope, and `entry.ts` says what happens without one — "the relay encrypts
 * it, and puts its own key in the envelope".
 *
 * ★ SO A PRIVATE WRITE FROM HERE IS RELAY-READABLE WHATEVER `Sealing` SAYS, and rendering the
 * package's `'seal'` as "end-to-end encrypted" would be false in this shell specifically. The mode
 * is therefore recomputed for what this shell DID, and `relayReadable` is the fact a member of a
 * private channel is entitled to before they type the next thing.
 */
export interface SealingNote {
  /** ★ Whether the relay holds a key to what was written. True for every private write from here. */
  readonly relayReadable: boolean;
  /**
   * Finished copy for the channel, naming every member it is about.
   *
   * ★ ONE FIELD RATHER THAN A SENTENCE PLUS A LIST. A parallel `unreachable: string[]` was written
   * here and then removed: the escrow copy `recipientsFor` composes already names those members,
   * so the array would have been carried by this type and rendered by nothing — which is the
   * shape of `recordUnreached`, the defect this round exists to close, reintroduced one file over.
   */
  readonly why: string;
}

/**
 * The note for one write, or null when there is nothing to say.
 *
 * Null for a public workspace — nothing there is encrypted and nothing claims to be — and null for
 * the record re-seal, which `resealRecord` publishes under the relay's shared class deliberately.
 */
function sealingNote(write: WriteKind, sealing: Sealing): SealingNote | null {
  if (write === 'reseal' || sealing.mode === 'unsealed') return null;
  return {
    relayReadable: true,
    why: sealing.mode === 'escrow'
      // The module's sentence is finished user-facing copy naming who and why, so it is quoted
      // rather than paraphrased: every surface in this vertical then says the same words about the
      // same member. What it cannot know is that THIS host never seals, which is the clause added.
      ? sealing.why + ' And nothing typed into Discord is sealed by this bot in any case — it holds '
        + 'no key material, so every message here takes that same relay path.'
      : 'This is NOT end-to-end encrypted. Every member of this workspace has published an '
        + 'encryption key, so a client that holds one — the desktop channel — writes here without the '
        + 'relay reading anything. This bot holds none: it is a conduit, so it hands the relay your '
        + 'words and the relay encrypts them, with the relay\'s own key in the envelope. The relay '
        + 'can read this, and an envelope\'s recipients are fixed at write time, so that cannot be '
        + 'changed afterwards.',
  };
}

/**
 * A refusal from the module, with the act a DISCORD user can actually perform appended to it.
 *
 * ── ★★ EVERY EXIT THE PACKAGE NAMES IS AN ACT IN SOME OTHER CLIENT ────────
 *
 * "Open the workspace in a client signed in with your own key"; "read the members list again";
 * "fold the roster again with a read cap of at least N"; "republish those grants under a name
 * carrying the grantee's pod". This bot's whole command tree is `start`, `link`, `link-confirm`,
 * `unlink`, `mentionable`, `show`, `who` and `ask` — it ships no invite and no revoke — so a
 * refusal that stops at the module's sentence tells a channel to do something nobody in it can do.
 * That is not hypothetical: a refusal naming a revoke was, in this shell, a dead end.
 *
 * The module's sentence is carried unchanged, because it is the accurate half. What is added is
 * where the person actually is.
 */
function discordExit(why: string, retryable: boolean): string {
  return why + (retryable
    ? ' From Discord the act that repeats that read is posting again: the roster is folded afresh '
      + 'for every message, and `/workspace show` folds it too and prints what it found.'
    : ' No command this bot has changes that — `/workspace start`, `link`, `link-confirm`, `unlink`, '
      + '`mentionable`, `show`, `who` and `ask` are the whole tree, and there is no invite and no '
      + 'revoke among them. Whatever is named above has to be done by the person or the pod it is '
      + 'about, from a client of their own.');
}

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
  | {
      readonly kind: 'created'; readonly binding: ThreadBinding; readonly streamIri: string;
      readonly seated: boolean; readonly why: string | null;
      /**
       * What writes into this thread will and will not be protected by — see {@link SealingNote}.
       *
       * ★★ FOR A PRIVATE WORKSPACE IT IS DECIDED HERE AND NOWHERE ELSE. The founder is the one
       * member who cannot be invited later, so their founding acceptance is the only chance to
       * record their key — and this shell has none to record.
       */
      readonly sealing: SealingNote | null;
    }
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
  const visibility = args.visibility ?? 'public';
  /**
   * ★★ NO `encryptionKey`, AND FOR A PRIVATE WORKSPACE THAT IS PERMANENT.
   *
   * `createWorkspace` takes the convener's own X25519 public key and publishes it in their
   * founding acceptance. This bot has none to pass: it is a conduit and holds no key material for
   * anybody, by design. `createWorkspace` says what that costs in its own words — the convener is
   * then permanently `keysMissing`, a missing key withholds the WHOLE key list, and no client can
   * seal anything in the workspace while theirs is the missing one. The founder is the one member
   * who cannot be invited later, so nothing downstream can repair it either.
   *
   * ★ SO IT IS SAID RATHER THAN FIXED, because this shell cannot fix it. Refusing
   * `/workspace start visibility:private` outright would remove a capability people use — the
   * relay path is real encryption, just not end-to-end — and inventing a key here would be this
   * bot holding key material for a human, which is the one thing the delegation model exists so
   * nobody has to trust. The note below is the honest third option.
   */
  const out = await createWorkspace(deps.client, { relay: deps.relay, viewer: member, title, slug, visibility });
  if (out.kind === 'invalid') return { kind: 'create-failed', detail: out.why, done: [] };
  if (out.kind === 'error') return { kind: 'create-failed', detail: 'at "' + out.at + '": ' + errorCopy(out.error).t + ' — ' + errorCopy(out.error).d, done: out.done };
  if (out.kind === 'refused') return { kind: 'create-failed', detail: 'at "' + out.at + '" the relay refused: ' + JSON.stringify(out.refusal).slice(0, 300), done: out.done };
  if (out.kind === 'stalled') return { kind: 'create-failed', detail: 'at "' + out.at + '": ' + out.why, done: out.done };

  const binding: ThreadBinding = {
    threadId: args.threadId, convenerPod: link.pod, workspace: out.workspace, slug,
    title, startedAt: new Date().toISOString(), startedBy: args.discordUserId,
  };
  deps.store.bindThread(binding);
  return {
    kind: 'created', binding, streamIri: out.streamIri, seated: out.seated, why: out.why,
    sealing: visibility === 'private'
      ? {
          relayReadable: true,
          why: 'This private workspace can never be end-to-end encrypted, and that was decided by '
            + 'creating it here. Your founding acceptance publishes no encryption key — this bot '
            + 'holds none for you — and a member whose acceptance publishes no key withholds the '
            + 'whole key list, so no client can seal to this workspace while yours is the missing '
            + 'one. Every write into it, from every client, is encrypted by the relay with the '
            + 'relay\'s own key in the envelope: the relay can read this thread. Publishing your '
            + 'acceptance again from a client that holds your key supersedes this one and ends '
            + 'that; no command this bot has does it.',
        }
      : null,
  };
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
      /**
       * What seating them established, EMPTY unless `seated` is `'just-now'`.
       *
       * ── ★★ THE RE-SEAL'S EVICTION HALF WAS DETECTED AND THROWN AWAY ─────────
       *
       * `seat()` collects these and the failure arm returns them, so `renderRecord` printed them
       * whenever seating FAILED and never when it succeeded — and the one finding that only exists
       * on the success path is the worst of them: `sendInvite` republished the workspace record
       * with `auto_supersede_prior`, and any existing member the relay resolved no key for has
       * just lost the document `verifyGrantIri` makes them read before they can accept. An
       * envelope's recipients are fixed at write time, so nothing later gives it back.
       */
      readonly seating: readonly Check[];
      /**
       * ★★ WHAT PROTECTED THIS ENTRY, AND A DISCORD USER HAS NO OTHER WAY TO LEARN IT.
       *
       * Null for a public workspace. Non-null means the workspace is private and this write went
       * out RELAY-READABLE — always, from this shell, because it holds no key to seal with. See
       * {@link SealingNote}, which is why that is not inferred from `Sealing.mode`.
       */
      readonly sealing: SealingNote | null;
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
  /**
   * ── ★ AND EACH OF THESE NAMES AN ACT SOMEBODY CAN ACTUALLY PERFORM ─────────
   *
   * A refusal in a Discord channel reaches people whose only verbs are `start`, `link`,
   * `link-confirm`, `unlink`, `mentionable`, `show`, `who` and `ask`. Everything else is somebody
   * else's client against somebody else's pod, and a refusal that does not say so is a dead end
   * with a sentence attached. See `discordExit`, which does the same for the module's own copy.
   */
  if (read.kind === 'forked') return { problem: 'the workspace record has ' + read.heads.length + ' unresolved heads, so which record governs here is not decided. Nothing was written. Republishing the record collapses that, and only the convener can, from a client of their own.' };
  if (read.kind === 'missing') return { problem: 'the workspace record could not be read: ' + read.message + ' Post again in a moment — this read is made afresh for every message.' };
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
          + 'a private workspace, invite it as a member like anybody else — from the convener\'s own client, '
          + 'because this bot ships no invite command. Until then it can carry your messages INTO the '
          + 'workspace but cannot read them back out.')
      : 'the workspace record\'s signed region could not be located, so nothing was read from bytes anybody signed. '
        + 'Republishing the record is what fixes that, and only the convener can, from a client of their own.' };
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

/** What one write may go out with, or why it may not go out at all. */
type AudienceOut =
  | {
      readonly ok: true;
      /** Spread straight into `postEntry` or `sendInvite`. */
      readonly post: {
        readonly visibility: 'public' | 'private';
        readonly shareWith?: readonly string[];
        readonly pendingWebIds?: readonly string[];
        readonly grantedWebIds?: readonly string[];
      };
      /** `'reseal'` only — pods to keep in the record. Always empty for the other verbs. */
      readonly repairBy: readonly { readonly pod: string; readonly why: string }[];
      readonly sealing: SealingNote | null;
    }
  | { readonly ok: false; readonly why: string };

/**
 * Every seated member's WebID, for a private workspace, and what this write may do with them.
 *
 * ★ FOLDED ON DEMAND AND ONLY WHEN PRIVATE. The roster costs two round trips per grant, far too
 * much to spend on every message in a public channel — and a public workspace has no recipients to
 * compute.
 *
 * ── ★★ THE VERB IS THE ARGUMENT, AND ITS ABSENCE BRICKED THIS SHELL ─────────
 *
 * This asked `recipientsFor('private', roster)` — the un-verbed form, which applies every verb's
 * refusal. `postEntry` publishes with `auto_supersede_prior: false`: an entry replaces no recipient
 * set and CANNOT evict anybody, so the completeness refusal written to protect the re-seal was
 * being applied to ordinary chat. One unreadable grant therefore refused every message anybody
 * typed, for ever, and — because `renderRecord` prints that refusal NOT ephemerally — posted a
 * paragraph into the channel each time. Discord ships no invite and no revoke, so there was no act
 * in the product that ended it.
 *
 * ★ AND IT RETURNS ITS REFUSAL RATHER THAN THROWING IT. A throw from inside a spread argument in
 * `seat()` escaped to `recordMessage`'s outer handler as `{kind:'error'}`, discarding every seating
 * check collected before it and printing the same sentence under a different heading.
 */
async function audienceFor(
  deps: Deps, frame: Frame, write: WriteKind, prefer: readonly string[] = [],
): Promise<AudienceOut> {
  /**
   * ★ PUBLIC COSTS NOTHING. The roster is two round trips per grant — far too much to spend on
   * every message in a public channel, and a public workspace has no recipients to compute.
   */
  if (frame.record.visibility !== 'private') {
    const plain = recipientsFor(write, frame.record.visibility, null);
    // Only `'unknown'` reaches this, and `frameOf` refuses before it on the one state that
    // produces `'unknown'` — a record whose signed region would not locate. Handled rather than
    // asserted away, because the module's exit for it ("open the workspace in a client signed in
    // with your own key") is not an act anybody in a Discord channel can perform.
    if (!plain.ok) return { ok: false, why: discordExit(plain.why, plain.retryable) };
    return { ok: true, post: { visibility: plain.visibility }, repairBy: [], sealing: null };
  }
  const iriOwner = podOfNsIri(frame.binding.workspace) ?? frame.convenerPod;
  const fold = (readCap: number): Promise<RosterFold> => foldRoster(deps.client, {
    workspace: frame.binding.workspace, iriOwner, slug: frame.binding.slug,
    convener: frame.record.convener, convenerPod: frame.convenerPod,
    readCap,
    // `foldRoster` always prefers the convener's own grant; the pod this write is FOR is added so
    // a cap that bites cannot drop the one row the write is about.
    prefer,
  });
  let roster = await fold(ROSTER_READ_CAP);
  /**
   * ★★ THE ONE EXIT THE MODULE NAMES THAT DISCORD CANNOT OFFER, PERFORMED HERE INSTEAD.
   *
   * `recipientsFor` answers a cap-truncated fold with "fold the roster again with a read cap of at
   * least N" and `retryable: false`, precisely because repeating the same call truncates in the
   * same place. No Discord command exposes a read cap, so this shell performs that act itself
   * rather than printing an instruction nobody in a channel can follow.
   *
   * ★ ONLY WHEN THE CAP IS WHAT BIT. `grantsRead` also falls short for grants that would not read,
   * and a bigger cap changes nothing about those — re-folding for them would double the cost of
   * every message in an unwell workspace and answer identically.
   */
  if (roster.grantsFound > ROSTER_READ_CAP) roster = await fold(roster.grantsFound);
  const audience = recipientsFor(write, 'private', roster);
  if (!audience.ok) return { ok: false, why: discordExit(audience.why, audience.retryable) };
  return {
    ok: true,
    post: {
      visibility: audience.visibility,
      ...(audience.shareWith ? { shareWith: audience.shareWith } : {}),
      // Only meaningful to `sendInvite`'s reseal; `postEntry` ignores both. Carried here so the
      // seat path cannot forget them — omitting them evicts, from a record they need in order to
      // accept, anybody with an outstanding invitation and anybody whose acceptance merely could
      // not be read this time round.
      pendingWebIds: audience.pendingWebIds,
      grantedWebIds: audience.grantedWebIds,
    },
    repairBy: audience.repairBy,
    sealing: sealingNote(write, audience.sealing),
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
    return { ok: false, checks: convGate.checks, why: 'seating you needs a grant on the convener\'s pod ('
      + frame.convenerPod + ') and this bot is no longer delegated there: ' + (convGate.why ?? 'no reason reported')
      // ★ THE ACT IS THE CONVENER'S AND IT IS NAMED. Nothing in this bot can restore a delegation
      // on somebody else's pod — that is the whole point of the delegation model — so a refusal
      // that stopped at "no longer delegated" left a channel with nothing to do about it.
      + '. Only the convener can restore it, by running `register_agent` for this bot (' + deps.agentId
      + ') on their own pod from a client of their own. No command this bot has does it.' };
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
    return { ok: false, checks, why: 'this workspace\'s role profile did not resolve (' + errorCopy(e).t.toLowerCase()
      + '), so no role could be checked and none was granted. Post again in a moment if that read simply did '
      + 'not complete; if it keeps saying the same thing, the profile is on the convener\'s pod and only they '
      + 'can republish it.' };
  }
  const role = (frame.record.roleProfile ?? frame.rolesIri) + '#Contributor';
  const roleOk = checkRoleForWorkspace(table, role);
  if (!roleOk.ok) return { ok: false, checks, why: roleOk.why };
  checks.push({ mark: 'y', text: 'Contributor is a role this workspace\'s own table defines' });

  let convener: Viewer;
  try { convener = await readMember(deps.client, frame.convenerPod); }
  catch (e) { return { ok: false, checks, why: 'the convener\'s pod could not be read: ' + errorCopy(e).t
    + '. Post again in a moment — this read is made afresh for every message.' }; }

  /**
   * ★★ SEATING SOMEBODY IN A PRIVATE WORKSPACE MEANS RE-SEALING ITS RECORD TO THEM. Written when
   * the convener was its only member, it is encrypted to the convener alone — so without this the
   * new member cannot read the record, cannot verify the grant just written for them, and cannot
   * accept. `sendInvite` adds the invitee; this is the roster it already had.
   *
   * ★ `'reseal'` IS THE VERB, AND IT IS THE ONLY ONE OF THE THREE THAT CAN EVICT ANYBODY: the
   * record is republished with `auto_supersede_prior`, so the revision an omitted member could
   * read is retired, and `verifyGrantIri` makes them read it before they can accept. That is why
   * this verb still refuses over a shortfall the fold might yet resolve, and why the entry path
   * no longer does.
   *
   * ★ AND THE REFUSAL IS RETURNED, NOT THROWN. This call used to be `...(await audienceFor(…))`
   * inside the argument object, so a refusal became an exception that escaped `seat()` entirely,
   * was caught by `recordMessage`'s outer handler as `{kind:'error'}`, and threw away every check
   * collected above — the same sentence, under a different heading, with the evidence gone.
   */
  const aud = await audienceFor(deps, frame, 'reseal', [member.podName]);
  if (!aud.ok) return { ok: false, checks, why: aud.why };
  const invited = await sendInvite(deps.client, {
    viewer: convener, workspace: frame.binding.workspace, workspaceTitle: frame.record.title || frame.binding.title,
    // The composed handle rather than a pod name: `sendInvite` resolves an invitee through
    // WebFinger, which is the one step that establishes the pod and the WebID agree.
    handle: 'acct:' + member.podName + '@' + new URL(deps.relay).host,
    role, entryShape: frame.record.entryShape,
    ...aud.post,
    /**
     * ★★ PODS WHOSE GRANT WOULD NOT READ, PUT BACK INTO THE RECORD RATHER THAN DROPPED FROM IT.
     *
     * The three WebID lists above are all built from `wsp:grantedTo`, so a member whose grant is
     * forked, headless or unlocatable contributes to none of them — and the re-seal would drop
     * them from the very document they must read in order to accept. `recipientsFor('reseal', …)`
     * recovers their pod from the grant's own IRI, which needs none of its bytes.
     */
    ...(aud.repairBy.length ? { repairBy: aud.repairBy } : {}),
  });
  if (invited.kind !== 'invited') {
    const why = invited.kind === 'blocked' ? (invited.resolution.blocked ?? 'the invitee could not be resolved to a pod a grant would seat')
      : invited.kind === 'resolve-failed' ? 'resolving your handle failed: ' + errorCopy(invited.error).t
      : invited.kind === 'refused' ? 'the relay refused the grant: ' + JSON.stringify(invited.refusal).slice(0, 240)
      : 'publishing the grant failed: ' + errorCopy(invited.error).t;
    // ★ ONE ACT FOR ALL FOUR, because all four are about a write this bot makes on every message
    // and none of them is repaired by anything in the command tree.
    return { ok: false, checks, why: why + '. Post again in a moment: seating is attempted afresh '
      + 'for every message, and nothing of yours was written.' };
  }
  checks.push({ mark: invited.readable ? 'y' : 'q', text: invited.readable
    ? 'A Contributor grant naming you was published on ' + frame.convenerPod + ' and read back'
    : 'A Contributor grant naming you was accepted on ' + frame.convenerPod + ' and is not yet reported readable: ' + (invited.why ?? 'no reason reported') });
  /**
   * ★★ WHO THE RE-SEAL DROPPED, WHICH THIS SHELL DETECTED AND THREW AWAY.
   *
   * `sendInvite` republished the workspace record with `auto_supersede_prior`, so the revision a
   * member the relay resolved no key for could read is now retired — and `verifyGrantIri` reads
   * that record before anybody can accept. The invitee's own case is refused inside `sendInvite`
   * before the grant is written, so anybody named here is an EXISTING member who has just lost
   * their copy, permanently: an envelope's recipients are fixed at write time.
   *
   * ★ AND "NOTHING REPORTED" IS NOT "EVERYBODY WAS REACHED". `recordReach.established` is false
   * when the publish response carried no per-handle resolution at all, which is a different fact
   * from an empty `recordUnreached` and must not be rendered as silence.
   */
  if (invited.recordUnreached.length > 0) {
    checks.push({ mark: 'n', text: 'The workspace record was re-sealed and the relay resolved no key for '
      + invited.recordUnreached.join(', ') + ' — they can no longer read the record they need in order to '
      + 'accept, and writing again does not give it back to them' });
  } else if (!invited.recordReach.established) {
    checks.push({ mark: 'q', text: 'The re-seal of the workspace record reported no per-recipient resolution ('
      + (invited.recordReach.why ?? 'no reason given') + '), so who can still read it is not established here' });
  }

  // The acceptance is written against the grant as VERIFIED, not against the invite's own report
  // of itself — `acceptGrant` needs the revision CID, and the only honest source for it is a read
  // of the grant that is there now.
  const found: GrantVerdict = await findSeat(deps.client, { relay: deps.relay, viewer: member, workspace: frame.binding.workspace });
  if (!found.ok) {
    return { ok: false, checks, why: 'the grant was published and does not yet seat you: ' + (found.why ?? 'no reason reported')
      // The grant IS written; what has not happened is a read of it that agrees. Posting again is
      // the act, and it is the one thing somebody in a channel can do.
      + '. The grant is on the convener\'s pod either way — post again in a moment and this checks it afresh.' };
  }
  const accepted = await acceptGrant(deps.client, { relay: deps.relay, viewer: member, verdict: found });
  if (accepted.kind !== 'accepted') {
    return { ok: false, checks, why: (accepted.kind === 'refused'
      ? 'the relay refused your acceptance: ' + JSON.stringify(accepted.refusal).slice(0, 240)
      : 'publishing your acceptance failed: ' + errorCopy(accepted.error).t)
      + '. Your grant stands; only your own half is missing, and posting again writes it.' };
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

    /**
     * The name a NEW seat writes under, derived from the workspace's own pod and slug. It is the
     * default, not the answer: an already-seated member's log is whatever their own acceptance
     * names, which `ownHalf` reads back below — see its note. Composing it unconditionally is
     * what orphaned a legacy-named member's entire history.
     */
    const composedStream = nsIri(deps.relay, member.podName, qualifiedName(frame.convenerPod, binding.slug, 'stream'));

    let seated: 'already' | 'just-now' = 'already';
    // What seating them established, for the notice. Empty while nobody is seated here.
    let seatingChecks: readonly Check[] = [];
    const already = await findSeat(deps.client, { relay: deps.relay, viewer: member, workspace: binding.workspace });
    /**
     * ★★ "NOT SEATED" IS TWO DIFFERENT FACTS, AND ONLY ONE OF THEM MAY BE ANSWERED BY GRANTING.
     *
     * Never-granted and granted-then-REVOKED both come back `ok: false`. This branch read them
     * as one and called `seat()` for either — and `seat()` calls `sendInvite`, which publishes
     * `<workspace>-grant-<pod>` with `auto_supersede_prior: true` and no revoked flag, at the
     * very IRI the revocation lives at. So a member the convener had removed put themselves back
     * on the roster by typing one message in the thread.
     *
     * ★ AND EVERY GATE IT PASSED WAS GENUINELY OPEN, which is what makes it a bypass rather than
     * a refusal in the wrong words: the grant is written under the CONVENER's delegation of this
     * bot, and revoking a MEMBER does not touch that. The substrate had no reason to object. The
     * judgement that was missing is this vertical's own, and this is where it belongs — `seat()`
     * is told to seat somebody and cannot know why it was called.
     *
     * Reproduced against the scripted relay in tests/record.test.ts before this line existed.
     *
     * ★ RE-ADMISSION IS STILL POSSIBLE AND STILL THE CONVENER'S. Nothing here stops them
     * inviting the person again from their own client; what it stops is the removed party doing
     * it for themselves, silently, as a side effect of speaking.
     */
    if (!already.ok && already.revoked === true) {
      return {
        kind: 'unseated', pod: link.pod, seating: already.checks,
        why: 'your membership of this workspace was revoked by its convener, so nothing you say '
          + 'here is being recorded. Speaking again does not restore it — only the convener can, '
          + 'from their own client.',
      };
    }
    /**
     * ★★ AND A GRANT IS ONLY HALF A SEAT. `findSeat` reads the convener's half; `ownHalf` reads
     * the member's, which is the half every reader of this workspace also requires — see its
     * note for what a missing one looked like from inside the channel.
     *
     * The acceptance is asked about only when the grant already stands. When it does not, the
     * verdict about the GRANT is the whole answer — either `seat()` is about to write both halves,
     * or nothing may be written at all, which is what the rest of this note is about.
     *
     * ★★ AND ONLY HALF OF THAT GATE EXISTED. This arm read EVERY `ok: false` verdict — including
     * one produced by a failed read — as `{ repairable: true, why: 'no grant … seats them yet' }`,
     * a manufactured absence with a sentence asserting the grant is not there.
     *
     * `findSeat` answers `ok: false` for a relay refusal on the pod scan, a throw, an answer
     * carrying no entries array, a composed-name read that did not resolve, and a scan its read
     * cap stopped short. None of those is "no grant seats them yet", and the refusal below was
     * gated on `already.ok`, so it could never fire for any of them. The write they authorised is
     * `seat()`, which republishes the grant with a fresh `dct:created` — a new cid every existing
     * acceptance is instantly stale against — and, for a legacy-named member, rewrites their
     * acceptance at the qualified name pointing at a new stream, orphaning their whole log while
     * answering `recorded`. Exactly the harms `OwnHalf` was written for, reached through the
     * other half.
     *
     * `GrantVerdict` now carries `basis` and `repairable`, the same fields with the same meanings
     * as `OwnHalf`'s, set by the exit that knows which one it took. They are read here rather
     * than re-derived: both are non-optional on the verdict, so there is nothing to default.
     */
    const half: OwnHalf = already.ok
      ? await ownHalf(deps, frame, member, already)
      : {
          ok: false, basis: already.basis, repairable: already.repairable,
          why: already.why ?? 'no grant on the convener\'s pod seats them yet',
        };
    // Narrowed here rather than in the branch: the condition below is a disjunction, so `half`
    // is not narrowed inside it even when `already.ok` guarantees which arm produced it.
    const missing = half.ok ? null : half.why;
    /**
     * ★★ AND A STATE A WRITE CANNOT FIX IS ANSWERED BY NOT WRITING. See {@link OwnHalf}: seating
     * somebody republishes their grant, which is never a no-op, so answering "I could not read
     * your acceptance" by writing is how a network blink unseated a standing member — or, for a
     * legacy-named one, moved their entire log somewhere no reader folds while reporting success.
     *
     * Nothing is touched here. The message is refused and the person is told what was found.
     *
     * ★ AND THE EXIT DEPENDS ON WHICH KIND OF STATE IT IS, which is why `basis` is on both halves.
     * `'unestablished'` is a read that did not finish, and the next message re-runs every one of
     * these reads — so posting again IS the act, and a transport failure is the one kind of problem
     * that usually is not there a minute later. `'answered'` is not: a retracted grant or a record
     * naming a convener on another pod says the same thing however often it is read, so telling
     * somebody to try again there would be sending them to repeat a question already answered.
     */
    if (!half.ok && !half.repairable) {
      return { kind: 'unseated', pod: link.pod, seating: already.checks, why: half.why
        + (half.basis === 'unestablished'
          ? '. Nothing was written — this is a read that failed, not a seat that is missing, and '
            + 'publishing anything on the strength of it would edit your own record. Post again in '
            + 'a moment: every one of these reads is made afresh for every message.'
          // The other reason a write cannot answer: a state that WAS read, in full, and that
          // publishing a grant or an acceptance does not change — a retracted grant, a record
          // naming a convener on another pod, an IRI this reader will not dereference. Saying
          // "try again" there would send somebody to repeat a read that already answered.
          : '. Nothing was written — that is an answer rather than a read that did not finish, so '
            + 'repeating it says the same thing and publishing over it would edit somebody\'s '
            + 'record without changing what it found. No command this bot has resolves it; it has '
            + 'to be done by the convener, or by you, from a client with a key of its own.') };
    }
    if (!already.ok || missing) {
      const put = await seat(deps, frame, member);
      if (!put.ok) {
        return {
          kind: 'unseated', pod: link.pod, seating: put.checks,
          // Both reasons: what was missing, and why supplying it failed. Reporting only the
          // second reads as a fresh problem rather than as a repair that did not take.
          why: already.ok && missing ? missing + ', and seating them failed: ' + put.why : put.why,
        };
      }
      seated = 'just-now';
      seatingChecks = put.checks;
    }
    /**
     * ★ THE LOG THIS ENTRY GOES TO IS THE ONE EVERY READER FOLDS. When the member was already
     * seated, that is whatever their own acceptance names — legacy or qualified — because
     * `foldRoster` reads it from there. When they were just seated, `seat()` wrote an acceptance
     * naming the composed name, so the two agree.
     */
    const streamIri = half.ok ? half.stream : composedStream;

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
     *
     * ★★ AND `'entry'` IS THE VERB, WHICH CANNOT EVICT ANYBODY. `entry.ts` publishes with
     * `auto_supersede_prior: false`, so it replaces no recipient set: the worst an incomplete
     * roster costs here is one entry a missing member cannot read. The un-verbed call this
     * replaces applied the RE-SEAL's completeness refusal to ordinary chat, so one unreadable
     * grant refused every message anybody typed, for ever, in a shell with no repair command.
     * The re-seal in `seat()` is the verb that can evict, and it is the one that still refuses.
     */
    const audience = await audienceFor(deps, frame, 'entry', [member.podName]);
    if (!audience.ok) return { kind: 'unseated', pod: link.pod, why: audience.why, seating: [] };

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
      ...audience.post,
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
    return { kind: 'recorded', pod: member.podName, streamIri, seated, outcome, authorship,
      seating: seatingChecks, sealing: audience.sealing };
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
 * What `ownHalf` found, and — when it found a problem — WHETHER WRITING IS AN ANSWER TO IT.
 *
 * ── ★★ THE DISTINCTION USED TO EXIST ONLY IN THE PROSE ──────────────────────
 *
 * `ownHalf` already separated "their acceptance could not be READ" from "there is no acceptance",
 * and its own note said re-seating on a transport hiccup must not happen. But both arrived at the
 * caller as `{ ok: false, why }` with no discriminant, and the caller answered every one of them
 * the same way: by calling `seat()`.
 *
 * ★ WHAT THAT COST, reproduced against the scripted relay by a reviewer told to break it. `seat()`
 * republishes the GRANT first, and the grant is never a no-op — `grantTurtle` stamps `dct:created`
 * with the current time, so the bytes differ and `auto_supersede_prior` gives it a NEW cid. The
 * member's existing acceptance pins the OLD one. So:
 *
 *   · a 502 while reading an ALREADY-SEATED member's acceptance republished the grant, and if the
 *     acceptance write then failed too — the same outage — `foldRoster` unseated them for every
 *     reader, with "the grant was republished after they accepted it";
 *   · ★ worse, for a LEGACY-named member the same hiccup made `acceptGrant` write a fresh
 *     acceptance at the QUALIFIED name pointing at a NEW stream, orphaning their whole log — and
 *     `recordMessage` answered `recorded`. A success message for a write that moved their history
 *     out from under every reader.
 *   · and a permanently non-repairable state (a forked acceptance chain) made EVERY message
 *     republish the grant, growing that chain at chat volume.
 *
 * `repairable` is the fact the caller actually needs: is this a state a write can fix, or a state
 * a write can only make worse? Absence, a retired acceptance and a stale pin are the first.
 * Anything the reader could not READ is the second — absence of evidence, and writing on it edits
 * somebody's record because the network blinked.
 */
type OwnHalf =
  | { readonly ok: true; readonly stream: string }
  | {
      readonly ok: false;
      readonly repairable: boolean;
      /**
       * Whether this is a CONCLUSION or the absence of one — the same word and the same question
       * as `Seat.basis` and `GrantVerdict.basis`.
       *
       * ★ CARRIED BECAUSE THE CALLER NOW BUILDS AN `OwnHalf` OUT OF A `GrantVerdict`, where the
       * two axes come apart: a grant that was READ and states a withdrawal is `'answered'` AND
       * not repairable, and the sentence a refusal should print for it is not the one about a
       * read that failed. Inside `ownHalf` itself they still coincide — every exit that is not
       * repairable there is a read that did not complete — and `unread`/`notThere` below are what
       * keep that true rather than a comment claiming it.
       */
      readonly basis: 'answered' | 'unestablished';
      readonly why: string;
    };

/**
 * ★★ THE MEMBER'S OWN HALF OF THE SEAT, WHICH `findSeat` DOES NOT READ AND EVERY READER DOES.
 *
 * Membership in this vertical is two-sided by design: the convener's GRANT on their pod, and the
 * member's ACCEPTANCE on theirs. `foldRoster` — the fold behind `/workspace show`, the desktop
 * channel and the watcher — requires both, and folds a grant with no acceptance as `pending`,
 * whose log it does not read at all.
 *
 * `findSeat` answers only about the grant. That is the right question for the flow it was written
 * for and the wrong one here: read as "seated", it let `recordMessage` skip `seat()` — the one
 * call that publishes the acceptance — for somebody the convener had invited from another client
 * and who had never accepted. Their words landed on their own pod, correctly signed, and were
 * invisible to everyone in the room including themselves. Nothing failed; no reader was wrong.
 *
 * So this asks the question the READERS ask, and it is deliberately cheap — one head and, at
 * most, one descriptor, against the member's own pod.
 *
 * ★ IT ALSO CATCHES A STALE HALF. An acceptance pinned to a grant revision that has since been
 * superseded fails `foldRoster`'s revision test the same way an absent one fails its presence
 * test, and is repaired the same way: `seat()` republishes it against the grant that is there now.
 *
 * ★ WHAT IT DOES NOT DO IS DECIDE. It reports; the caller decides, because "no acceptance" and
 * "revoked" arrive here looking alike and must never be answered alike.
 *
 * ── ★ AND IT IS NOT CACHED, WHICH WAS TRIED AND WITHDRAWN ───────────────────
 *
 * Two round trips per message is a real cost on a path already spending eight or nine, so a cache
 * keyed by (pod, workspace, grantCid) was written — the grant revision being the one thing a
 * convener can change. It is the wrong key: the document being checked is the ACCEPTANCE, and
 * nothing in that triple moves when the acceptance does. The cache would have closed this hole by
 * opening a narrower one, which is not a trade worth two round trips on a chat bot.
 */
async function ownHalf(
  deps: Deps, frame: Frame, member: Viewer, verdict: GrantVerdict,
): Promise<OwnHalf> {
  const iriOwner = podOfNsIri(frame.binding.workspace) ?? frame.convenerPod;
  /**
   * The two exits, built rather than typed out fifteen times.
   *
   * ★ THEY PIN THE CORRELATION THIS FUNCTION RELIES ON: inside `ownHalf` every state a write
   * cannot answer is a read that did not complete, and every state a write CAN answer was read.
   * A future exit that wants to break that pair has to say so by not using either of these.
   */
  const unread = (why: string): OwnHalf => ({ ok: false, repairable: false, basis: 'unestablished', why });
  const notThere = (why: string): OwnHalf => ({ ok: false, repairable: true, basis: 'answered', why });
  let found;
  try {
    found = await deps.client.resolveMemberDoc(member.podName, iriOwner, frame.binding.slug, 'acceptance');
  } catch (e) {
    return unread('their acceptance could not be resolved: ' + errorCopy(e).t);
  }
  if (found.forked) return unread('their acceptance has ' + found.forked.heads.length + ' unresolved heads');
  // ★ AN UNREADABLE POD IS NOT AN ABSENT DOCUMENT, and re-seating on a transport hiccup would
  // rewrite a member's own record because the network blinked. `resolveMemberDoc` separates the
  // two — see its own note — and only genuine absence is answerable by writing.
  if (found.error) return unread('their acceptance could not be read: ' + found.error);
  if (!found.found || !found.head) return notThere('no acceptance for this workspace is published on their pod');

  let region: string | null;
  try {
    const d = await deps.client.descriptor(found.head.url);
    region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', found.iri);
  } catch (e) {
    return unread('their acceptance could not be read: ' + errorCopy(e).t);
  }
  if (region === null) return unread('the signed region of their acceptance could not be located');
  /**
   * ★ RETIRING YOUR OWN ACCEPTANCE IS HOW YOU LEAVE, AND SPEAKING AGAIN IS HOW YOU COME BACK.
   *
   * This is the mirror image of the revoked grant above and resolves the OTHER way, for one
   * reason: this record is theirs. They withdrew it on their own pod under their own signature,
   * and typing in the thread is that same person choosing to be in the room again. Nobody's
   * decision is being reversed but their own — which is exactly what is NOT true of a revocation,
   * where the convener decided and only the convener may undo it.
   */
  if (isRetracted(region)) return notThere('they had retired their own acceptance, and speaking again republishes it');
  // The two facts a reader gets out of this document, both of which have to be current or the
  // entry about to be written is not the one anybody will fold.
  const accepts = readIri(region, 'wsp:accepts');
  const acceptsCid = readLiteral(region, 'wsp:acceptsCid');
  /**
   * ★★ THE LOG IS READ FROM THEIR ACCEPTANCE, NOT COMPOSED — BECAUSE THAT IS WHAT THE READERS DO.
   *
   * This compared `wsp:stream` against a composed, always-QUALIFIED IRI and refused anything else.
   * `foldRoster` is looser and is the authority: it takes whatever the acceptance names and only
   * checks that it is under the member's OWN pod. `resolveMemberDoc` still supports the LEGACY
   * naming form, so a member seated before qualified names existed has an acceptance naming a
   * legacy stream — which this refused, sending `recordMessage` to `seat()`, which republished
   * their acceptance pointing at a NEW qualified stream and orphaned their entire history. Every
   * reader folds the log the acceptance names; nothing folds the old one again.
   *
   * ★ AND IT IS THE SAME MISTAKE THIS WHOLE HELPER EXISTS TO FIX, in the opposite direction: a
   * writer applying a DIFFERENT standard from its readers. Reproduced by an adversarial reviewer
   * against the version of `ownHalf` added earlier in this round.
   */
  const stream = readIri(region, 'wsp:stream');
  if (!stream) return notThere('their acceptance names no log to write to');
  const streamPod = podOfNsIri(stream);
  if (streamPod && streamPod !== member.podName) {
    return notThere('their acceptance names a log under pod ' + streamPod + ', which is not their own — no reader folds that');
  }
  if (!accepts) return notThere('their acceptance names no grant, so no reader can hold it against one');
  /**
   * ★ WHICH GRANT REVISION THEY AGREED TO — the same test `foldRoster` applies, in the same two
   * forms, because a seat this disagreed with would be a seat no reader honours.
   *
   * The newer form names the grant's own IRI and pins the revision separately, which is
   * comparable against the verdict already in hand. The OLDER form names the grant's descriptor
   * URL, which the verdict does not carry — so that branch, and only that branch, spends a head
   * read. Answering "stale" for a form this could not compare would republish a member's own
   * record on every message they typed.
   */
  if (accepts === verdict.grantIri) {
    if (!acceptsCid || !verdict.grantCid) {
      return notThere('their acceptance names the grant and pins no revision either side could compare');
    }
    return acceptsCid === verdict.grantCid ? { ok: true, stream }
      : notThere('their acceptance pins a revision of the grant that is no longer the head, so what they agreed to is not what is there now');
  }
  let head;
  try { head = await deps.client.currentHead(verdict.grantIri, iriOwner); }
  catch (e) { return unread('the grant their acceptance names could not be resolved: ' + errorCopy(e).t); }
  if (head.forked || !head.url) return unread('the grant their acceptance names has no single current head');
  return accepts === head.url ? { ok: true, stream }
    : notThere('their acceptance names a grant descriptor that is no longer the one at the head');
}


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
      //
      // ★★ AND IT IS THE SAME CONSTANT THE WRITE PATH USES. This said `200` and `audienceFor`
      // said nothing at all, so the two folds of one workspace disagreed and the write gate was
      // on the pessimistic one — see {@link ROSTER_READ_CAP}.
      readCap: ROSTER_READ_CAP,
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
        // Chain order, oldest first: `orderChain` walks back from the single head. This is
        // the ONE ordering in this vertical nothing outside the member's pod can rewrite.
        for (const r of walk.ordered) rows.push({ seat: s, url: r.url, cid: r.cid });
      } catch (e) {
        streams.push({ pod, stream: s.stream, total: 0, forked: false, partial: false, why: 'this log could not be read: ' + errorCopy(e).t });
      }
    }

    /**
     * ★★ A FAIR SHARE OF THE WINDOW PER LOG, TAKEN IN CHAIN ORDER.
     *
     * Two wrong answers preceded this one, and the second was worse than the first.
     *
     *   1. `rows.slice(-CAP)`. `rows` is built seat by seat — each member's whole ordered chain
     *      appended in turn — so its order was SEAT order, not time. Slicing the last twelve took
     *      the tail of whichever member happened to be folded last, and if that member had twelve
     *      entries of their own then NOBODY ELSE APPEARED AT ALL, convener included, while the
     *      footer said "newest 12 shown".
     *
     *   2. Sorting by the manifest's `validFrom` before the slice. That fixed the interleaving and
     *      introduced something worse: ★★ `valid_from` IS A CALLER-SUPPLIED ARGUMENT to
     *      `publish_context` — the relay writes `(args.valid_from) ?? now`. Keying the window on
     *      it hands every member a suppression primitive: date one entry far in the future and it
     *      takes the whole window, evicting everybody else from `/workspace show` and from the
     *      Discord mirror; date them in the past and hide your own. Found by a refute-review of
     *      the round that introduced it.
     *
     * So the window is not decided by any value an author writes. Each log contributes from its
     * own NEWEST end in chain order — the supersession links, which are the one ordering nothing
     * outside that pod can rewrite — round-robin, until the cap is full. A member with fifty
     * entries and a member with one each get a turn before anybody gets a second.
     *
     * ★ WHAT IT COSTS AND WHAT IT BUYS. It is no longer "the newest twelve in the room", because
     * there is no room-wide clock to be newest by — `dct:created` is each client's own and
     * `validFrom` is now known to be untrusted. It is "the most recent few from everybody", which
     * is both honest about what the substrate establishes and unsteerable. `renderShow` says so.
     *
     * ★ SEAT ORDER STILL BREAKS THE TIE when the cap does not divide evenly, and that is the fold
     * order — the convener's grant first, then the pod scan. Deterministic, and not something a
     * member can move themselves up in.
     */
    const totalEntries = rows.length;
    const perSeat: { seat: Seat; url: string; cid: string | null }[][] = [];
    for (const s of fold.seats) {
      const mine = rows.filter((r) => r.seat === s);
      if (mine.length) perSeat.push(mine);
    }
    const take: { seat: Seat; url: string; cid: string | null }[] = [];
    for (let depth = 0; take.length < SHOW_ENTRY_CAP; depth++) {
      let anyLeft = false;
      for (const log of perSeat) {
        const at = log.length - 1 - depth;
        if (at < 0) continue;
        anyLeft = true;
        take.push(log[at] as { seat: Seat; url: string; cid: string | null });
        if (take.length >= SHOW_ENTRY_CAP) break;
      }
      if (!anyLeft) break;
    }
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
    /**
     * The printed order, and it is a CLOCK — `dct:created`, out of each entry's own signed region,
     * which is whatever the writing client's clock said. The renderer prints that caveat beside it.
     *
     * ★ AND IT IS A DIFFERENT QUESTION FROM WHICH ENTRIES ARE HERE. Selection above is by chain
     * position and cannot be steered; this is presentation and can be — a client that lies about
     * `dct:created` moves its own line up or down the printed list. It cannot thereby remove
     * anybody else's, which is the property that was missing.
     *
     * ★ SO CHAIN ORDER IS NOT WHAT A READER SEES, and an earlier version of this comment claimed
     * it was — "a stable sort leaves equal keys as they were" is true and irrelevant, because
     * this sort runs over the whole selection with a key that is rarely equal. Within one log the
     * two orders normally agree; where they disagree, the printed one is the author's clock and
     * this says so rather than implying an authority it does not have.
     */
    entries.sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')));
    return { kind: 'view', binding, record: frame.record, fold, streams, entries, truncated: totalEntries > take.length, totalEntries };
  } catch (e) { return { kind: 'error', error: e }; }
}

/** True when this Discord id is one the bot will accept at all. Exported for the gateway. */
export const isSnowflake = (s: unknown): s is string => typeof s === 'string' && SNOWFLAKE_RX.test(s);
