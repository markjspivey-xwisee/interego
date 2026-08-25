/**
 * WHO A PRIVATE WORKSPACE IS ENCRYPTED TO.
 *
 * ── ★★ THE HANDLE THE PRODUCT TEACHES DOES NOT WORK HERE ────────────────────
 *
 * `composedHandle` is `acct:<pod>@<relay host>` — it is what the invite flow shows people and what
 * every placeholder in the UI says. It resolves against the RELAY's WebFinger, whose JRD carries
 * `self`, `profile-page` and `ldp#inbox` and NO storage link. `resolveWebFinger` therefore returns
 * no pod URL, `resolveHandleToPodUrl` returns null, and the handle contributes ZERO RECIPIENTS —
 * silently, with the publish succeeding.
 *
 * A private workspace built on that handle would be encrypted to nobody but its author, and the
 * only evidence would be `sharedWith[].agentCount === 0` in a response field nothing reads.
 *
 * So recipients are built from each seat's `grantedTo` WebID instead. That is the
 * `https://identity…/users/<pod>/profile` form, the identity server's WebFinger DOES publish a
 * storage link, and `resolveInvitee` already guarantees the shape: it reads the WebID from the
 * invitee's own pod registry and refuses the invite unless `podOfWebid(webId) === pod`. The roster
 * fold already holds it, so this costs no extra round trip.
 *
 * ── ★★ AND AN INCOMPLETE ROSTER IS ANSWERED PER VERB, NOT ONCE FOR THE CHANNEL ──
 *
 * `foldRoster` can come back short: grants past its read cap, and grants whose read failed. For a
 * round this file turned that shortfall into ONE refusal computed before every other branch, from
 * the bare `grantsFound`/`grantsRead` pair, and returned it to every caller alike. Two things were
 * wrong with it and both were measured.
 *
 *   · IT GATED THREE VERBS THAT CANNOT DO THE HARM IT NAMED. The harm is EVICTION FROM
 *     MEMBERSHIP: a superseding write that replaces the recipient set of a document somebody needs
 *     in order to stay in the workspace. Exactly one write in this package does that — the reseal
 *     of the workspace RECORD inside `sendInvite` (`auto_supersede_prior: true` on a `'shared'`
 *     document, and `verifyGrantIri` reads that record before anybody can accept). `entry.ts`
 *     publishes with `auto_supersede_prior: false` and replaces nobody's access at all;
 *     `canvas.ts` does supersede, so a member left out cannot read the canvas — but the next save
 *     recomputes the audience and lets them back in, and nothing about their membership went with
 *     it. All four verbs were refused alike.
 *   · THREE OF THE FOUR WAYS A GRANT GOES UNREAD ARE PERMANENT — see `ReadFailure`. So the
 *     sentence "the roster is incomplete, try again" described an outage, and the ONE act that
 *     repairs a permanently unreadable grant, `sendInvite` republishing it, was behind the same
 *     refusal. A workspace with one forked grant was read-only for everybody, for good.
 *
 * So the shortfall arrives here as `RosterFold.unread` — one row per missing grant, carrying the
 * grantee's POD recovered from the grant IRI and a permanence class — and {@link recipientsFor}
 * decides per verb. The reseal is the only verb that still refuses over it, and only while the
 * shortfall could still clear; when it cannot, the reseal INCLUDES those pods instead of refusing,
 * which closes the eviction without a locked door to advertise an exit from.
 *
 * ★ A ROW THAT IS ON THE ROSTER AND DID NOT SEAT IS A DIFFERENT CASE AGAIN. It has a WebID, and
 * leaving that WebID out of the envelope is the silent permanent lockout rather than a defence
 * against one — so those are INCLUDED. See `seatStanding` and the filter below.
 */

import { MODAL_RETRACTED } from './turtle.js';
import {
  seatStanding, seatUnreadKind, unreadGrants,
  type ReadFailure, type Seat, type UnreadGrant,
} from './seats.js';

/**
 * A member the envelope NAMES whose seat this fold could not establish.
 *
 * ★ THEY ARE IN `shareWith`, and this says what is not known about them — including whether their
 * key could be read, which is what decides between sealing end-to-end and publishing under the
 * relay's key. See {@link RecipientPlan.keysUnestablished}.
 */
export interface UnestablishedMember {
  readonly webId: string;
  /** Their pod, from the grant. Null only for a hand-built row that carries none. */
  readonly pod: string | null;
  /** Whether repeating the acceptance read could answer differently — `Seat.unreadKind`. */
  readonly kind: ReadFailure;
  /** The row's own sentence, so every surface quotes the same words about the same member. */
  readonly why: string;
}

/**
 * WHAT A WRITE MAY DO WITH ITS PAYLOAD, stated rather than inferred from an empty key list.
 *
 * ── ★★ THE RULE: SEALING MUST NEVER SILENTLY DEGRADE ────────────────────────
 *
 * A private workspace has two publish paths and they are not equivalent. SEALED: the client
 * builds the envelope, the relay receives ciphertext and is not a recipient. RELAY-SHARED
 * ("escrow"): the relay resolves each WebID to a registered key, encrypts, and puts its OWN key
 * in the envelope — so the relay can read everything written that way. Both come back from a
 * publish as a success, and both look identical on the roster afterwards.
 *
 * The whole claim this vertical makes about private workspaces is that the second path is not
 * being used. So a client may take it, and there are states where it is the only path available —
 * but it may not take it QUIETLY. `keys.length === 0` is not a signal: it is the same value for
 * "this workspace is public and seals nothing" and for "seal to nobody, let the relay read it",
 * and the desktop's `sealerFor([])` reads both as "do not seal". One member's transient 502
 * disabled end-to-end sealing for a whole workspace through exactly that value, and nothing on
 * either side said so.
 *
 * ★ SO THE MODE IS A VALUE THE CALLER MUST BRANCH ON, and every arm that is not `'seal'` carries
 * the sentence to show. A caller that renders nothing for `'escrow'` is publishing content the
 * relay can read into a workspace its own UI calls private.
 *
 *   · `'unsealed'` — nothing here is being encrypted by this client, and that is the design of
 *                    the document: a PUBLIC workspace, or the workspace RECORD, which is
 *                    published `'shared'` deliberately (it carries the title, convener, role
 *                    profile and entry shape, and the grants naming its members are public).
 *   · `'seal'`     — every member of the envelope published a key and `keys` names them all.
 *                    This is the end-to-end case and the only one that keeps the relay out.
 *   · `'escrow'`   — private, and this client cannot seal to everyone in the envelope. The write
 *                    still goes out, encrypted by the RELAY, which is therefore a recipient.
 *                    `why` is user-facing copy naming who and why.
 */
export type Sealing =
  | { readonly mode: 'unsealed'; readonly why: string }
  | { readonly mode: 'seal'; readonly keys: readonly string[] }
  | {
      readonly mode: 'escrow';
      readonly why: string;
      /** Seated members whose acceptance publishes no key — see {@link RecipientPlan.keysMissing}. */
      readonly keysMissing: readonly string[];
      /**
        * Members whose acceptance could not be read.
        *
        * ★ NOT NECESSARILY PERMANENT ONES. When `keysMissing` is empty these are all `'permanent'`
        * — a shortfall that could still clear is refused instead, not escrowed. When `keysMissing`
        * is NOT empty the write was going to be relay-readable whatever these rows say, so they
        * are carried here whatever their kind and refusing over them would buy no confidentiality.
        * Read each row's own `kind`.
        */
      readonly keysUnestablished: readonly UnestablishedMember[];
    };

/**
 * WHICH WRITE IS ASKING. The refusal is computed from harm × permanence, and the harm is a
 * property of the verb rather than of the workspace.
 *
 * ★ THE THREE ARE NOT INTERCHANGEABLE AND THE ROUND THAT TREATED THEM AS ONE BRICKED WORKSPACES.
 *
 *   · `'entry'`  — `entry.ts` publishes with `auto_supersede_prior: false`. It replaces no
 *                  recipient set and CANNOT evict anybody; the worst an incomplete roster costs is
 *                  one entry a missing member cannot read.
 *   · `'canvas'` — a canvas revision. `canvas.ts` DOES supersede, so a member left out cannot read
 *                  the canvas — but the next save recomputes the audience and lets them back in,
 *                  and no membership document is involved. It carries no completeness refusal of
 *                  its own for that reason: it shares the entry's policy, and the one refusal
 *                  either of them makes is about SEALING, which both do and the reseal does not.
 *   · `'reseal'` — the reseal of the workspace RECORD inside `sendInvite`: `auto_supersede_prior`
 *                  on a `'shared'` document, so the revision the omitted member could read is
 *                  retired. `verifyGrantIri` reads that record as a precondition of accepting, so
 *                  losing it is a one-way door out of the workspace. This is the only verb whose
 *                  omission costs somebody their MEMBERSHIP.
 */
export type WriteKind = 'entry' | 'canvas' | 'reseal';

/** What to publish with, or why nothing may be published. */
export type RecipientPlan =
  | {
      readonly ok: true;
      readonly shareWith: readonly string[];
      readonly seats: number;
      /**
       * Each seated member's X25519 public key, from their OWN acceptance — for a client that
       * seals before sending.
       *
       * ── ★★ WHY THIS IS SEPARATE FROM `shareWith` AND NOT A REPLACEMENT ────────
       *
       * `shareWith` is a list of WebIDs handed to the RELAY, which resolves each one to a pod and
       * reads that pod's agent registry for keys. That path cannot be end-to-end: the relay is
       * choosing the keys, and it adds its own besides. `keys` is the list a publisher seals to
       * ITSELF, so the relay never chooses and never appears.
       *
       * Both exist because the two publish paths coexist for the rest of these workspaces' lives —
       * an envelope's recipients are fixed at write time, so nothing already written can be moved
       * across, and a client talking to a relay that predates the sealed path still needs the old
       * one.
       *
       * ★ EMPTY WHEN ANY SEATED MEMBER PUBLISHED NO KEY. Not "the subset that has one": sealing to
       * a subset locks out the rest permanently and silently, which is the failure this file was
       * written for. `keysMissing` names them, and for the two verbs that seal
       * {@link recipientsFor} turns that into a stated {@link Sealing} of `'escrow'` — the caller
       * is told the relay will be a recipient rather than left to infer it from a list that came
       * back empty. (`'reseal'` seals nothing, so it reports `'unsealed'` and this list is inert
       * for it.)
       *
       * ★★ EMPTY IS NOT "DO NOT SEAL" AND MUST NOT BE READ AS ONE. It is the input to a decision
       * that {@link recipientsFor} makes and states; a caller sealing straight off this list reads
       * "seal to nobody" and "publish relay-readable" as the same value, which is the silent
       * downgrade the rule beside {@link Sealing} exists to forbid. Read `sealing`.
       */
      readonly keys: readonly string[];
      /**
       * Seated members whose acceptance WAS READ and carries no `wsp:encryptionKey`.
       *
       * ── ★★ AN ANSWER, AND THE ONE POPULATION THAT MAY NOT REFUSE ────────────
       *
       * Their own signed acceptance says they published no sealing key, so this publisher has
       * nothing to seal to for them and no read will ever produce one. It is a supported state,
       * not a fault: `createWorkspace`'s `encryptionKey` is optional and a client that holds no
       * private key — a published artifact installs no opener at all — accepts without one. So a
       * workspace whose CONVENER joined from such a client has this permanently, and refusing
       * every private write over it would be an outage with no act in the product to end it.
       * `postEntry` and `saveCanvas` say the same thing in their own words: the relay-encrypted
       * path "cannot be switched off while unsealed history and keyless members exist".
       *
       * Non-empty therefore means the write goes out RELAY-READABLE and the caller must say so —
       * see {@link Sealing}. It is deliberately kept apart from {@link keysUnestablished}, which
       * is ignorance rather than an answer and is judged differently.
       */
      readonly keysMissing: readonly string[];
      /**
       * Rows in the envelope whose ACCEPTANCE this fold could not read, so nothing is established
       * about their key.
       *
       * ── ★★ IGNORANCE IS NOT AN ANSWER, AND FOLDING IT INTO `keysMissing` DISABLED E2EE ────
       *
       * A previous round pushed these into `keysMissing`, which empties `keys`, which makes the
       * desktop's `sealerFor` return no sealer — so ONE member's transient 502 turned end-to-end
       * sealing OFF for every entry, canvas save and merge written afterwards, for everybody,
       * silently and for the life of those bytes. Reproduced: two members, both acceptances
       * carrying a key, one descriptor 502 → `keys` went from two entries to none.
       *
       * They are counted separately because the two populations have different answers. A read
       * that did not complete can complete: {@link recipientsFor} REFUSES the sealed verbs while
       * one of these could still clear, and only escrows when none of them can — the same
       * permanence rule the reseal already applies to unread grants.
       */
      readonly keysUnestablished: readonly UnestablishedMember[];
      /**
       * WebIDs of people who hold a grant but have not accepted it yet.
       *
       * ── ★★ THEY BELONG IN A RESEAL AND NOWHERE ELSE ─────────────────────────
       *
       * `shareWith` deliberately excludes them: an entry is for the people IN the conversation, and
       * somebody who has not accepted is not one yet.
       *
       * But re-sealing the workspace RECORD is the opposite case, and getting it wrong is what
       * makes an invitation impossible to accept. `verifyGrantIri` reads the record to check the
       * grant; a pending invitee who cannot read it cannot verify their own grant and cannot
       * accept. Since a reseal REPLACES the recipient set, inviting a second person while the first
       * is still pending would evict the first — silently, by the very operation meant to let
       * somebody in, and with the roster still showing them as "granted, not accepted".
       *
       * With N outstanding invitations only the most recent could ever be accepted, one at a time.
       */
      readonly pendingWebIds: readonly string[];
      /**
       * WebIDs of EVERYBODY the convener's standing grants name, whatever their acceptance says.
       *
       * ── ★★ THE SET A RESEAL MUST USE, AND WHY IT IS NOT `pendingWebIds` ─────
       *
       * `pending` means one exact thing: the acceptance was looked for and is genuinely not there.
       * It is deliberately NOT set when the read FAILED, because "waiting to accept" would then be
       * a claim about somebody's pod made from a read that established nothing. That rule is right
       * and stays.
       *
       * But it is a rule about the ACCEPTANCE, and a reseal is not asking about acceptances. A
       * reseal asks who must be able to READ THE RECORD, and the answer is written on the
       * convener's own pod: everybody a live grant names. Between those two questions sat a whole
       * population — a member whose acceptance pins a grant revision the convener has since
       * superseded, whose pod returned 502 while the roster was folded, whose acceptance is forked
       * or whose signed region would not locate. Each is `seated: false` and `pending: false`, so
       * each was dropped from the recipient set by the next reseal.
       *
       * ★ AND THAT IS A ONE-WAY DOOR. Losing the record means `verifyGrantIri` cannot read it,
       * which means they cannot accept, which means they can never become seated again — a
       * permanent lockout of a member nobody revoked, triggered by a transient 502 during somebody
       * ELSE's invitation. The roster goes on showing why their seat did not fold, and says
       * nothing about the envelope they just fell out of.
       *
       * ★ INCLUDING THEM COSTS NOTHING. The grant naming them is published PUBLIC, and the record
       * carries the title, convener, role profile and entry shape — which is exactly the reasoning
       * this file already gives for not re-sealing on revoke. Excluding them buys no
       * confidentiality and costs a member their workspace.
       *
       * Revoked grants and grants their own author has retracted are not here: those are
       * withdrawals, stated by the person entitled to state them.
       *
       * A grant this reader could read no grantee out of is not here either — it has no WebID to
       * carry. That absence is deliberate, and it is NOT the one-way door above; the note beside
       * this list's own computation says why, and why refusing over it was worse than the hole.
       */
      readonly grantedWebIds: readonly string[];
      /**
       * WebIDs in `shareWith` whose SEAT this fold could not establish — `seatStanding` of
       * `'unestablished'`, with a live grant naming them.
       *
       * ── ★★ THEY ARE IN THE ENVELOPE, AND THIS NAMES THEM SO A CALLER CAN SAY SO ─────
       *
       * They are a subset of `shareWith`, not an alternative to it. See the filter's own note for
       * why including them is the only answer available: an envelope's recipients are fixed at
       * write time, so leaving somebody out on a read that failed is permanent and silent, while
       * putting them in costs at most one extra reader of a document their own standing grant
       * already names them in.
       *
       * Empty is the ordinary case. Non-empty means the roster has a hole in it and the audience
       * covers it, and a surface should say which pods are unresolved. It does not by itself mean
       * a write went out: for `'entry'` and `'canvas'` the same hole is what {@link recipientsFor}
       * may refuse over, because sealing to everyone else would shut these people out of the
       * envelope permanently.
       *
       * ★ IT DOES NOT BY ITSELF MEAN THE WRITE WAS UNSEALED, and for one round the comment here
       * said it did. Whether this client could still seal end to end is decided from
       * {@link keysUnestablished} and {@link keysMissing} together, per verb, and STATED — see
       * `Sealing`. A member whose acceptance merely timed out no longer turns sealing off for
       * everybody.
       */
      readonly unestablishedWebIds: readonly string[];
      /**
       * The grants this fold did not read at all — {@link RosterFold.unread}, reconciled against
       * the counters by `unreadGrants`.
       *
       * ── ★★ IT IS CARRIED, NOT ACTED ON, AND THAT IS THE WHOLE CHANGE ────────
       *
       * This function used to REFUSE outright whenever the pair was short, for every caller and
       * every verb. It no longer decides anything: the rows come through so {@link recipientsFor}
       * can apply the policy the verb earns, and so a caller that proceeds can SAY who is missing
       * — the same treatment `keysMissing` gets one field up, which is the shape this file already
       * had right for the key path and had wrong for the roster path.
       *
       * Empty is the ordinary case. Non-empty means the audience below is built from part of the
       * roster, and each row says which pod and whether waiting could help.
       */
      readonly partial: readonly UnreadGrant[];
    }
  | { readonly ok: false; readonly why: string };

/**
 * ── ★★ A REFUSAL IS READ BY SOMEBODY DECIDING WHAT TO DO NEXT, SO IT NAMES EACH CAUSE ONCE ──
 *
 * Measured, from `recipientsFor('private', { seats: [seat('u-a')], grantsFound: 40, grantsRead: 25 })`:
 * the reseal refusal printed "a grant whose IRI names no pod" fifteen times in its first sentence
 * and fifteen more in its second — thirty copies of one phrase wrapped around the single clause
 * that said what had happened and the single clause that said what to do. Nothing in it was
 * false. It was unreadable, and a refusal nobody finishes reading has the same effect as one that
 * names no exit at all, which is the failure the rest of this file exists to avoid.
 *
 * Every population here is one row per member or per grant — the unread grants, the members whose
 * acceptance could not be read, the members publishing no key, the seated rows carrying no WebID
 * — so every list any of them prints is composed through these.
 *
 * ★ THE CAP IS A READING LIMIT, NOT A DATA ONE, AND NOTHING ABOUT THE SCALE IS HIDDEN BY IT: the
 * count stated in the sentence is exact, and what the cap drops is the tail of a list nobody
 * reads. Where the result has an ok arm, the rows themselves travel on it (`partial`,
 * `keysMissing`, `keysUnestablished`) for a surface that wants to render every one. A REFUSAL
 * carries no rows at all — only this sentence — which is the other reason it has to be readable.
 */
const NAMES_SHOWN = 4;
const listOf = (names: readonly string[], shown: number = NAMES_SHOWN): string => {
  const distinct = [...new Set(names)];
  return distinct.length <= shown
    ? distinct.join(', ')
    : distinct.slice(0, shown).join(', ') + ' and ' + (distinct.length - shown) + ' more';
};

/**
 * What to call one unread grant.
 *
 * ★ THE GRANT IRI, NOT A PHRASE DESCRIBING ITS ABSENCE. `podOfGrantGraph` answers null for any
 * grant not published under `<workspace>-grant-<pod>`, and the text for such a row used to read
 * "a grant whose IRI names no pod" — a sentence about this reader's difficulty rather than a
 * handle. The IRI is the only handle that row has left, and the one thing a person can look up,
 * republish, or quote in a question. Empty where the row carries neither — `unreadGrants`'s
 * reconciliation padding, and any hand-built row that names no graph.
 */
const nameOf = (u: UnreadGrant): string => u.pod ?? (u.graph === '' ? '' : '<' + u.graph + '>');

/** Every name a population has, each once — and nothing for the rows that have none. */
const namedOnly = (rows: readonly UnreadGrant[]): string =>
  listOf(rows.map(nameOf).filter((n) => n !== ''));

/**
 * The same, plus a TALLY of the rows carrying neither a pod nor an IRI.
 *
 * ★ A COUNT IS GENUINELY ALL THOSE ROWS ARE. They stand for a fold that reported more grants
 * found than read and named no row for the difference, so naming them individually is naming
 * nothing individually, once per row.
 *
 * Use this where nothing else in the sentence states how many there are; use {@link namedOnly}
 * where a count already sits beside it, so the sentence does not say fifteen twice.
 */
const nameList = (rows: readonly UnreadGrant[]): string => {
  const anonymous = rows.filter((u) => nameOf(u) === '').length;
  return [
    namedOnly(rows),
    anonymous > 0 ? anonymous + ' grant' + (anonymous === 1 ? '' : 's') + ' this roster named no row for' : '',
  ].filter((part) => part !== '').join(' and ');
};

/**
 * Build the `share_with` list for a private workspace from its roster.
 *
 * ★ IT NO LONGER REFUSES OVER COMPLETENESS, AND IT NO LONGER REFUSES OVER AN EMPTY AUDIENCE.
 * Both were channel-wide fail-closed switches on a function every write in the workspace passes
 * through, and both answered questions that belong to the VERB — see {@link recipientsFor}, which
 * is where each now lives. What is left here is the audience itself plus the one refusal that is a
 * genuine contradiction in the roster: a member this fold SEATED and cannot address.
 */
export function recipientsFromRoster(args: {
  readonly seats: readonly Seat[];
  readonly grantsFound: number;
  readonly grantsRead: number;
  /** Optional for a hand-built roster; `unreadGrants` reconciles it against the counters. */
  readonly unread?: readonly UnreadGrant[];
}): RecipientPlan {
  const partial = unreadGrants(args);

  /**
   * ── ★★ WHO IS IN THE ENVELOPE, ASKED THROUGH `seatStanding` AND NOT THROUGH `seated` ─────────
   *
   * This was `args.seats.filter((s) => s.seated && !s.revoked)`, and it was the highest-severity
   * defect in this vertical. `seated: false` is produced by an authoritative answer AND by every
   * read `foldRoster` could not complete — a forked chain on either half, a head this reader could
   * not resolve, a head whose body could not be fetched, a signed region that would not locate, a
   * descriptor that threw — and this line drew no distinction between them at all.
   *
   * ★ REPRODUCED, and it is the shape of the harm rather than the odds that decides it: two
   * members, one whose acceptance read returned 502. The plan came back `ok: true` with
   * `shareWith` naming only the other one, `pendingWebIds` empty, and no error on either side.
   * An envelope's recipients are fixed at write time — this file says so at the note below — so
   * every private entry written during that outage is unreadable to that member FOREVER, and
   * nothing anywhere told either of them.
   *
   * ★★ SO THE THREE STANDINGS ARE ANSWERED SEPARATELY, and the rule beside `Seat.basis` decides
   * the third: nothing may EXCLUDE somebody from an ENVELOPE on `'unestablished'`.
   *
   *   · `'seated'`        — in, with their key, as before.
   *   · `'out'`           — a withdrawal or a read acceptance that does not seat. Excluded, and
   *                         that exclusion is a conclusion somebody entitled to draw it drew.
   *   · `'unestablished'` — INCLUDED in `shareWith`, named in `unestablishedWebIds`, and counted
   *                         in `keysUnestablished` — NOT in `keysMissing`, which is the answered
   *                         population. Their acceptance is where their key would have been read
   *                         from and it was not read, so nothing about their key is established
   *                         and nothing here decides the sealing mode on their behalf.
   *
   * ★ INCLUDING THEM IS CHEAP AND EXCLUDING THEM IS NOT REVERSIBLE. The grant naming them is
   * published PUBLIC, so a reader who holds one is already entitled to know this workspace exists
   * and who is in it; the cost of the extra recipient is bounded by that. The cost of the omission
   * is a member locked out of a conversation nobody removed them from. This is the same
   * harm-proportionate reasoning `grantedWebIds` above is built on, applied to the entry audience
   * instead of only to the reseal one.
   */
  const seated = args.seats.filter((s) => seatStanding(s) === 'seated' && !s.revoked);
  const unestablished = args.seats.filter((s) => seatStanding(s) === 'unestablished'
    && !s.revoked && s.grantedTo
    // ★ AND NEVER A ROW THAT ALREADY CLAIMS TO BE PENDING, so the three populations below stay
    // disjoint. `pending` is set at ONE exit of the fold and only where the relay stated an
    // absence, so it is its own assertion that the absence was read — a row carrying it belongs to
    // `pendingWebIds`, which exists precisely to keep somebody who has not accepted OUT of an
    // entry's envelope. A row in both lists would have this function contradicting itself.
    && !s.pending
    // Case-folded for the same reason `grantedWebIds` below folds: `isRetracted` set the field
    // that way. A grant its own author retired names nobody now, whatever the acceptance says.
    && String(s.grantStatus ?? '').toLowerCase() !== MODAL_RETRACTED.toLowerCase());
  // Granted but not yet accepted. Excluded from `shareWith`, included in a reseal — see the field.
  //
  // ★ STILL KEYED ON `pending` AND NOT ON THE STANDING, because they are not the same question.
  // `seatStanding` answers "did this fold establish anything"; `pending` answers "was an absence
  // established at every name a member document could live under", which is narrower and is set at
  // exactly one exit. Every pending row `foldRoster` produces is an `'out'` row, and most `'out'`
  // rows are not pending.
  const pendingWebIds = args.seats
    .filter((s) => !s.seated && !s.revoked && s.pending && s.grantedTo)
    .map((s) => s.grantedTo as string);
  /**
   * Everybody a standing grant names — see the field. Read off the GRANT half only, which is the
   * half the convener owns and the half a reseal is about.
   */
  const grantedWebIds = args.seats
    // Case-folded, because `isRetracted` — which is what SET this field's source — compares
    // that way, and a status differing only in case would otherwise be a withdrawal here and
    // not one there.
    .filter((s) => !s.revoked && s.grantedTo
      && String(s.grantStatus ?? '').toLowerCase() !== MODAL_RETRACTED.toLowerCase())
    .map((s) => s.grantedTo as string);
  /**
   * ── ★★ A GRANT WITH NO READABLE GRANTEE IS ABSENT FROM ALL THREE LISTS, AND STAYS ABSENT ────
   *
   * Such a row — region located, region parsed, `grantedTo === null` — is `seated: false`, never
   * `pending`, and carries no WebID, so it is in `shareWith`, `pendingWebIds` and `grantedWebIds`
   * alike: nowhere. `sendInvite` unions those three (plus the invitee) into the reseal audience,
   * so the next invitation republishes the record without whoever that grant was for.
   *
   * This function REFUSED over such a row for one round. That is gone, and both reasons are
   * measured rather than argued:
   *
   *   · IT WAS A CHANNEL-WIDE FAIL-CLOSED WITH NO EXIT. `recipientsFor` is the single join every
   *     entry, canvas save and invite passes through, so ONE such row refused every write in the
   *     workspace for as long as it existed. Neither way out it named is implemented:
   *     `revokeGrant` returns `{kind:'incomplete'}` for exactly `!grantedTo` — it will not restate
   *     a grant it could not read — and nothing in this package writes `iep:modalStatus
   *     "Retracted"` onto a grant. A refusal whose remedy the same product refuses to perform is
   *     an outage with a sentence attached.
   *   · IT FIRED ON CORRECT RDF. `grantedTo === null` is not "the grant names nobody". It is
   *     "`readIri` matched neither spelling it knows" — the literal `wsp:grantedTo` and the full
   *     `<…wsp#grantedTo>` — "with an IRIREF object". A grant binding the same namespace to a
   *     different prefix label, or writing the grantee as a PrefixedName, states the same triple
   *     and reads as null here, because expanding either would mean resolving a `@prefix` line
   *     that sits OUTSIDE the region anybody signed. Not resolving it is right; calling the
   *     result an answer about the grant is not.
   *
   * ★ AND THE ABSENCE COSTS ITS HOLDER NOTHING THEY COULD OTHERWISE HAVE DONE, which is exactly
   * what separates this row from the population `grantedWebIds` exists for. Accepting runs through
   * `verifyGrantIri`, which reads the grantee with THIS SAME reader and refuses at "the grant names
   * no wsp:grantedTo" before it ever reaches the record. So whichever cause produced the null, the
   * holder could not have accepted that grant with the record in hand either. It becomes acceptable
   * only once the grant is rewritten so this reader can read a grantee out of it — and a grant
   * naming somebody other than the convener is written in exactly one place, `sendInvite`, which
   * re-seals the record to that person BEFORE it writes the grant. (`createWorkspace` writes the
   * convener's own; `revokeGrant` restates a grantee it already read and refuses when it cannot.)
   * The act that makes the grant usable is the same act that puts its holder back among the
   * record's recipients, so there is no one-way door here to hold a whole workspace shut over.
   *
   * ★ NOR IS THE ROW SILENT. `foldRoster` gives it a `why` saying no grantee was read out of the
   * signed region, and that field is what the roster surfaces show for a row that did not seat.
   * The read-FAILURE half of this hole is closed by the refusal at the top of this function, which
   * `grantsRead` can now reach — see the counter in `foldRoster`.
   */
  const handles: string[] = [];
  const missing: string[] = [];
  const keys: string[] = [];
  const keysMissing: string[] = [];
  for (const s of seated) {
    // Collected alongside the WebID, from the same seat, so the two lists cannot describe
    // different populations. See `RecipientPlan.keys` for why both exist.
    if (s.encryptionKey) { if (!keys.includes(s.encryptionKey)) keys.push(s.encryptionKey); }
    else keysMissing.push(s.pod ?? s.graph);
    /**
     * ★ THE WebID, NEVER THE COMPOSED HANDLE. See the header: the handle the invite flow teaches
     * resolves to zero recipients without erroring.
     */
    if (s.grantedTo) { if (!handles.includes(s.grantedTo)) handles.push(s.grantedTo); }
    else missing.push(s.pod ?? s.graph);
  }
  /**
   * ★★ AND THE ROWS WHOSE SEAT IS NOT ESTABLISHED GO IN TOO — see the filter above for the harm
   * this closes. They are appended AFTER the seated set so the order `shareWith` has always had
   * is unchanged for a complete roster.
   *
   * ★★ THEY ARE COUNTED IN `keysUnestablished` AND NOT IN `keysMissing`, AND THAT SEPARATION IS
   * THE FIX FOR A PRIVACY REGRESSION. Both lists end in "no key to seal to for this member", but
   * one is an answer and the other is ignorance, and collapsing them let ignorance decide. With
   * these rows in `keysMissing` the whole key list emptied, `sealerFor` returned no sealer, and
   * every private write in the workspace went out under the RELAY's key from the moment one pod
   * timed out until it recovered — reproduced, two keys to none, with nothing said on either
   * side. `recipientsFor` now refuses the sealed verbs while such a read could still clear and
   * escrows only when none of them can, which is the same permanence rule the reseal already
   * applies to grants it could not read.
   */
  const unestablishedWebIds: string[] = [];
  const keysUnestablished: UnestablishedMember[] = [];
  for (const s of unestablished) {
    const webId = s.grantedTo as string;
    if (!unestablishedWebIds.includes(webId)) unestablishedWebIds.push(webId);
    if (!handles.includes(webId)) handles.push(webId);
    keysUnestablished.push({
      webId, pod: s.pod,
      // ★ THROUGH THE READER, never off `s.unreadKind`: a hand-built row carries none, and
      // `undefined` compared against `'permanent'` reads as "could still clear" at one call site
      // and as "nothing known" at the next. `seatUnreadKind` answers `'unknown'`, which is the
      // reading that refuses rather than the one that escrows.
      kind: seatUnreadKind(s),
      why: s.why ?? 'this fold established nothing about their seat and recorded no reason',
    });
  }

  /**
   * ★ THE ONE REFUSAL LEFT HERE, AND IT IS A CONTRADICTION IN THE ROSTER RATHER THAN A GAP IN IT.
   * This row was SEATED — the fold read its grant, read its acceptance, matched the two — and
   * still carries no WebID to address. Every other shortfall is somebody who could not be read;
   * this one is somebody this fold says is in the room and cannot name.
   *
   * ★ IT DOES NOT ARISE FROM `foldRoster`, which sets `seated` only after `podOfWebid(grantedTo)`
   * returned a pod, and that requires a non-null `grantedTo`. So it stands for a roster assembled
   * somewhere else, and it is kept because a caller handed such a roster is better refused than
   * quietly sealed short. It refuses every verb, which is affordable precisely because no fold
   * produces it.
   */
  if (missing.length > 0) {
    return {
      ok: false,
      why: missing.length + ' seated member' + (missing.length === 1 ? '' : 's')
        + ' (' + listOf(missing) + ') carry no WebID this reader can resolve, so there is no address to '
        + 'encrypt to for them. A private workspace that silently skipped them would read as empty on '
        + 'their side forever. Nothing was written.',
    };
  }
  /**
   * ── ★★ AN EMPTY AUDIENCE IS NOT REFUSED HERE ANY MORE, AND THAT IS THE INVITE PATH UNBLOCKED ──
   *
   * It used to return "no seated member of this workspace resolves to an encryption address", from
   * the SEATED set, to every caller. But `sendInvite` never uses `shareWith` for its own document:
   * the grant it writes is `visibility: 'public'`, and what its RESEAL needs is the union of the
   * three lists below with the invitee and with the pods `recipientsFor` hands back as `repairBy`
   * — a set that refusal was not asking about, and that is routinely non-empty when `shareWith` is
   * empty. So a private workspace whose seated set is empty or
   * unreadable — a convener whose own acceptance 502'd, forked or was retracted; every other
   * member still pending — had a perfectly good reseal audience and could invite nobody, with the
   * retracted-convener case permanent.
   *
   * The question the refusal was right about — a private ENTRY encrypted to nobody — is still
   * asked, one layer up, by the verbs it applies to. See {@link recipientsFor}.
   */
  return {
    ok: true, shareWith: handles,
    // ★ THE COUNT OF ROWS THAT ARE SEATED, WHICH IS NOT THE LENGTH OF `shareWith`. A row whose
    // seat is unestablished is in the envelope and is not a seat, so a caller that renders
    // "N members" must read it here rather than from the recipient list.
    seats: seated.length,
    // ★ ALL OR NOTHING, OVER THE ANSWERED POPULATION ONLY. A partial key list is the silent
    // lockout this whole file exists to refuse, so a seated member whose own acceptance publishes
    // no key empties it. A member whose acceptance could not be READ does not: that is ignorance,
    // it is carried in `keysUnestablished`, and `recipientsFor` decides what it means — see the
    // field, and see `Sealing` for why the two may not be collapsed.
    keys: keysMissing.length > 0 ? [] : keys,
    keysMissing,
    keysUnestablished,
    pendingWebIds: [...new Set(pendingWebIds)],
    grantedWebIds: [...new Set(grantedWebIds)],
    unestablishedWebIds,
    partial,
  };
}

/**
 * ── ★ WHAT REVOCATION DOES AND DOES NOT TAKE BACK, AND WHY THAT IS THE ANSWER ─
 *
 * `recipientsFromRoster` skips revoked and unseated rows, so from the moment somebody is revoked
 * they are not a recipient of any NEW entry or canvas revision. That is the part that matters, and
 * it is automatic — every write recomputes the list.
 *
 * Two things it deliberately does NOT do:
 *
 *   · It cannot un-send what was already written. An envelope's recipients are fixed when it is
 *     sealed, and a revoked member keeps whatever they could already open. That is inherent to
 *     encrypting to recipients rather than to a server that can be told to stop answering — it is
 *     the property being bought, not a gap in the implementation.
 *   · The workspace RECORD is not re-sealed on revoke, so a revoked member can still read later
 *     revisions of it. Considered and left: the record carries the title, convener, role profile
 *     and entry shape, and the membership GRANT that names them is published PUBLIC — so nothing
 *     in it is withheld from them by any other means either. Re-sealing it would suggest a
 *     confidentiality the surrounding documents do not have.
 */

/**
 * What a write may be addressed to, or why nothing may be written.
 *
 * ★ `retryable` IS NARROW ON PURPOSE: it means THIS SAME CALL, repeated unchanged, can succeed
 * once something outside this client clears. It is false for a refusal whose exit is an ACT —
 * signing in with a key, republishing a grant, revoking a row — because "try again" printed over
 * one of those is the sentence that turned a permanent state into a workspace people kept waiting
 * on. A caller shows the `why` either way; `retryable` is what decides whether it may offer a
 * bare Retry.
 */
export type RecipientAudience =
  | {
      readonly ok: true;
      readonly visibility: 'public' | 'private';
      readonly shareWith: readonly string[] | undefined;
      /**
       * ★★ WHAT THIS WRITE DOES TO ITS PAYLOAD, AND THE FIELD A CALLER MUST BRANCH ON.
       * `keys` below is `sealing.keys` when the mode is `'seal'` and `[]` in both other modes,
       * which is why it cannot be read on its own: empty is "public, nothing to seal" AND
       * "private, and the relay will be able to read this". See {@link Sealing} for the rule.
       */
      readonly sealing: Sealing;
      /**
       * The keys to seal to — identical to `sealing.keys` on the `'seal'` arm, empty otherwise.
       *
       * ★ KEPT SO EVERY EXISTING WRITER KEEPS WORKING UNCHANGED, and passing it straight to a
       * sealer no longer degrades anything silently: on an `ok` plan an empty list means `sealing`
       * says either `'unsealed'` or `'escrow'`, and the case where it went empty on IGNORANCE — a
       * seat this fold could not read, in a workspace that would otherwise have sealed — is a
       * refusal here rather than a value. What it cannot do is make the caller SAY so: a caller
       * that renders nothing for `sealing.mode === 'escrow'` is still hiding a relay-readable
       * write from its user.
       */
      readonly keys: readonly string[];
      readonly keysMissing: readonly string[];
      /** Members in the envelope whose acceptance could not be read — see {@link RecipientPlan}. */
      readonly keysUnestablished: readonly UnestablishedMember[];
      readonly pendingWebIds: readonly string[];
      readonly grantedWebIds: readonly string[];
      /** Carried through unchanged from {@link RecipientPlan} — a caller reporting the hole reads it here. */
      readonly unestablishedWebIds: readonly string[];
      /**
       * Grants this fold did not read, carried so the caller can PROCEED AND SAY SO.
       *
       * ★ NON-EMPTY IS NEVER A REASON TO REFUSE HERE. Every refusal this function makes has
       * already been made by the time a caller sees this; a plan that came back `ok` with rows in
       * `partial` is a plan that was judged safe for THIS verb with the roster short. The rows are
       * for the surface, exactly as `unreached` and `keysMissing` are.
       */
      readonly partial: readonly UnreadGrant[];
      /**
       * `'reseal'` only: pods to put back into the audience, so the superseding write cannot evict
       * them.
       *
       * ── ★★ THIS IS THE UN-BRICKING, AND IT IS INCLUSION RATHER THAN REFUSAL ─
       *
       * A grant whose bytes cannot be read still says WHOSE it is, in its own IRI —
       * `podOfGrantGraph`. So a reseal facing a permanently unreadable grant does not have to
       * choose between evicting that member and refusing the only act that could repair the grant.
       * It includes their pod.
       *
       * Non-empty only when every row in `partial` is `'permanent'`; while any of them could still
       * clear, the reseal refuses instead and says so, because a fold that has not finished looking
       * must not republish a recipient set. `sendInvite` resolves each pod to a WebID with the
       * WebFinger lookup it already performs for the invitee and unions them into `share_with`.
       */
      readonly repairBy: readonly { readonly pod: string; readonly why: string }[];
    }
  | { readonly ok: false; readonly why: string; readonly retryable: boolean };

/** The roster shape this function reads. `unread` is optional for a hand-built one. */
type RosterInput = {
  readonly seats: readonly Seat[];
  readonly grantsFound: number;
  readonly grantsRead: number;
  readonly unread?: readonly UnreadGrant[];
};

type Visibility = 'public' | 'private' | 'unknown' | undefined;

/**
 * The `shareWith` to pass a writer, for a workspace of this visibility — and whether this
 * particular WRITE may go out at all.
 *
 * ★ THE ONE PLACE THE TWO QUESTIONS ARE JOINED. "Is this workspace private" and "who are its
 * members" are answered in different files from different reads, and every write site needs both.
 * Three call sites each doing the join themselves is three chances to check the first and forget
 * the second — which publishes an entry sealed to its author alone, silently and permanently.
 *
 * A public workspace gets `undefined`, which is not a recipient list and is not an empty one: the
 * writers only send `share_with` when they are actually encrypting.
 *
 * ── ★★ AND THE REFUSAL IS PER VERB, BECAUSE THE HARM IS ────────────────────
 *
 * | verb | an incomplete roster |
 * |---|---|
 * | any, `visibility: 'unknown'` | refuses — the alternative is publishing in the clear |
 * | `'entry'`, `'canvas'` | never refuse over it. Return `partial` so the caller reports it |
 * | `'reseal'` | refuses only while some unread grant could still be read. All permanent: returns `repairBy` instead |
 *
 * ── ★★ AND SEALING IS ITS OWN QUESTION, ASKED OF THE TWO VERBS THAT SEAL ────
 *
 * | state of the KEYS | `'entry'` / `'canvas'` |
 * |---|---|
 * | every member of the envelope published one | `sealing: 'seal'` |
 * | a seated member's own acceptance publishes none | `sealing: 'escrow'` — stated, never refused |
 * | a member's acceptance could not be READ, and could still be | **refuses**, retryable |
 * | …and none of those reads can ever complete | `sealing: 'escrow'` — stated |
 *
 * The two key rows are not the same fact. One is an answer about the workspace and permanent, and
 * refusing over it would take out every workspace whose convener joined from a client that holds
 * no key at all. The other is a read that did not finish, and letting it decide is how one pod's
 * 502 disabled end-to-end sealing for everybody, silently. See {@link Sealing}, which states the
 * rule and carries the sentence a caller has to show.
 *
 * Every one of those rows is a harm this vertical measured. See {@link WriteKind} for which write
 * can evict whom, and the file header for what the single channel-wide refusal cost.
 */
export function recipientsFor(write: WriteKind, visibility: Visibility, roster: RosterInput | null): RecipientAudience;
/**
 * The un-verbed form, for a caller that has not said which write it is performing.
 *
 * ★★ DEPRECATED, AND THE ONLY REASON IT STILL EXISTS IS THAT DELETING IT CANNOT BE MEASURED YET.
 * Every un-migrated caller — `renderer.ts` ×4, `discord/src/workspace.ts` ×2,
 * `applications/shared-workspace/tools/drive-private-workspace-live.ts` ×3 and
 * `tests/workspace-private-recipients.test.ts` ×4 — is inside `tsconfig.check.json`, which
 * `vitest.config.ts` runs in `globalSetup`. Removing the overload makes that program fail, and a
 * failing gate aborts every vitest invocation in the repo, including the ones that would prove
 * the removal correct. Two of those nine files belong to no unit in the shell phase, so the gate
 * would stay red with nobody able to close it. It goes the moment they are migrated.
 *
 * ★ IT APPLIES EVERY VERB'S REFUSAL, ASKED OF THAT VERB'S OWN AUDIENCE. It used to apply every
 * verb's refusal asked of the ENTRY's audience, and the difference is a measured outage: a
 * private workspace whose members all hold live grants and have not accepted has an empty ENTRY
 * audience and a perfectly good RESEAL audience, and this form answered the invite with "no
 * member of this private workspace resolves to an encryption address", `retryable: false`, no
 * exit named. That is the invite path — the one act that repairs a workspace — refused for a
 * state ordinary workspaces pass through. So the emptiness rule below is asked of the union the
 * reseal actually uses as well as of `shareWith`, and refuses only when NO verb has anybody.
 *
 * ★ AND THE VERB IT CANNOT GUESS IS STILL A HAZARD. A caller here gets the reseal's refusals
 * without being able to pass `repairBy` on to `sendInvite`, so a permanently unreadable grant is
 * repaired by nobody. Name the verb.
 */
export function recipientsFor(visibility: Visibility, roster: RosterInput | null): RecipientAudience;
export function recipientsFor(
  a: WriteKind | Visibility,
  b: Visibility | RosterInput | null,
  c?: RosterInput | null,
): RecipientAudience {
  // ★ THE TWO UNIONS ARE DISJOINT, which is what makes one runtime test enough to tell the forms
  // apart: no visibility is ever `'entry'`, `'canvas'` or `'reseal'`, and no verb is ever
  // `'public'`, `'private'`, `'unknown'` or absent.
  const verbed = a === 'entry' || a === 'canvas' || a === 'reseal';
  const write: WriteKind | null = verbed ? a : null;
  const visibility = (verbed ? b as Visibility : a as Visibility);
  const roster = (verbed ? c ?? null : b as RosterInput | null);
  /** Whether this verb is answered by a given rule. `null` — un-verbed — is answered by all of them. */
  const asks = (...verbs: readonly WriteKind[]): boolean => write === null || verbs.indexOf(write) >= 0;

  /**
   * ★★ REFUSED, BECAUSE THE ALTERNATIVE IS PUBLISHING IN THE CLEAR. `'unknown'` means the record
   * could not be READ — the reader has no key, or is not in that envelope. It used to arrive here
   * as `'public'`, indistinguishable from a workspace that genuinely is, and every guard
   * downstream keys on `=== 'private'`. So the member who could not read the channel was the one
   * member who would post plaintext into it.
   *
   * ★ AND IT IS THE ONE REFUSAL HERE THAT IS A PROPERTY OF THE READER RATHER THAN OF THE
   * WORKSPACE, which is why it applies to every verb and why its exit is real: the workspace is
   * fine, this client cannot see it, and a client that can is one sign-in away. `retryable` is
   * false because repeating the same call from the same session cannot change the answer.
   */
  if (visibility === 'unknown') {
    return {
      ok: false, retryable: false,
      why: 'this workspace\'s record could not be read here, so whether it is private is not established '
        + '— and writing under a guess would publish in the clear if the guess is wrong. Open the workspace '
        + 'in a client signed in with your own key. Nothing was written.',
    };
  }
  // ★ The resolved value is RETURNED rather than left for the caller to re-derive: a caller that
  // asked here and then read `record.visibility` again for the write could get two answers.
  // A public workspace seals nothing, so it has no recipients of either kind.
  if (visibility !== 'private') {
    return {
      ok: true, visibility: 'public', shareWith: undefined, keys: [], keysMissing: [],
      keysUnestablished: [],
      // ★ STATED, NOT LEFT AS AN EMPTY KEY LIST. This is the one arm where an unsealed write is
      // the whole design of the document, and saying so is what stops `keys: []` from having to
      // mean two things — see `Sealing`.
      sealing: { mode: 'unsealed', why: 'this workspace is public, so nothing here is encrypted to anybody.' },
      pendingWebIds: [], grantedWebIds: [], unestablishedWebIds: [], partial: [], repairBy: [],
    };
  }
  if (!roster) {
    /**
     * ★ THE SENTENCE NAMES THE STATE RATHER THAN A REMEDY THAT IS A NO-OP IN ONE HALF OF IT. It
     * used to read "Open the workspace and let the members list load first", which is an act only
     * while nothing has been tried yet. A null fold also arrives from a roster read that FAILED,
     * and there the members list is not going to load — it already did not — so the sentence told
     * somebody to wait for something that had already stopped. Nothing here can tell the two
     * apart, so both are named and the exit given is the one that serves either: read again.
     */
    return {
      ok: false, retryable: true,
      why: 'this workspace is private and no roster has been folded here — either it has not been read yet '
        + 'or the read failed — so there is no way to tell who this should be encrypted to. Retry the members '
        + 'read. Nothing was written.',
    };
  }
  const plan = recipientsFromRoster(roster);
  // The roster contradicts itself — a member it seated and cannot address. Not a shortfall, and
  // not something repeating the call fixes. See the refusal's own note in `recipientsFromRoster`.
  if (!plan.ok) return { ok: false, why: plan.why, retryable: false };

  const partial = plan.partial;
  /**
   * Rows a repeat of the same read could still answer differently — see `ReadFailure`. Only
   * `'permanent'` is excluded, and three of the fold's five skipped-read exits land there.
   */
  const mayClear = partial.filter((u) => u.kind !== 'permanent');
  /**
   * A row's own `why` as a SENTENCE. `foldRoster` writes those as clauses with no terminal stop,
   * and quoting one mid-paragraph ran it straight into the next sentence with no break.
   */
  const sentence = (why: string): string => (/[.!?]$/.test(why.trim()) ? why.trim() : why.trim() + '.');
  const capitalise = (t: string): string => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

  /**
   * ★★ THE HARM A PRIVATE ENTRY ACTUALLY HAS, ASKED BY THE VERBS THAT HAVE IT. These documents go
   * out at `visibilityFor(…, 'private')` = `'shared'`, and `'shared'` is the value that unions the
   * AUTHOR with the recipient list — so an empty list is not an error at the relay, it is a
   * conversation with one participant. Writing into it looks exactly like writing into a channel
   * that works. So those verbs refuse, and this is where the refusal `recipientsFromRoster` used to
   * make for everybody now lives.
   *
   * `'reseal'` is deliberately not here. `sendInvite` does not use `shareWith` for its own
   * document — the grant it writes is public — and the record it re-seals goes to that list unioned
   * with `pendingWebIds`, `grantedWebIds`, the invitee and the `repairBy` pods, which is routinely
   * non-empty when the seated set is empty. `resealRecord` refuses on ITS union being empty, which
   * is the same guard asked about the right set.
   *
   * ★★ AND THE UN-VERBED FORM ASKS IT OF THE RESEAL'S OWN AUDIENCE TOO. `asks` answers true there
   * for every rule, so this refusal used to be handed to callers performing an INVITE on the
   * strength of the ENTRY's empty audience: measured, a private workspace whose members all hold
   * live grants and none has accepted was refused with "no member … resolves to an encryption
   * address", `retryable: false` and no exit named, while `recipientsFor('reseal', …)` on the
   * identical fold returned a perfectly good audience. Refusing the one act that repairs a
   * workspace, over the emptiness of a list that act does not use, is not the safe side of
   * anything. So an un-verbed caller is refused here only when NO verb has anybody to address.
   */
  const resealAudience = plan.shareWith.length + plan.pendingWebIds.length + plan.grantedWebIds.length;
  const nobodyToAddress = write === null
    ? plan.shareWith.length === 0 && resealAudience === 0
    : write !== 'reseal' && plan.shareWith.length === 0;
  if (nobodyToAddress) {
    // ★ THE COUNT IS ALREADY IN THIS SENTENCE, so the list adds only the names — and is dropped
    // altogether when no row has one, rather than restating the count as a phrase. See `nameList`
    // for the population that is a count and nothing else.
    const named = namedOnly(partial);
    return {
      ok: false,
      // Retryable exactly when something in the shortfall could still read differently: a seated
      // set that is empty because two grants 502'd is a different sentence from one that is empty
      // because nobody has accepted.
      retryable: mayClear.length > 0,
      why: 'no member of this private workspace resolves to an encryption address, so this write would be '
        + 'readable by nobody but you'
        + (partial.length > 0
          ? ' — and ' + partial.length + ' of its ' + roster.grantsFound + ' grants could not be read'
            + (named === '' ? '' : ' (' + named + ')')
            + ', so the roster this was built from is not the whole one'
          : '')
        + '. Nothing was written.',
    };
  }

  /**
   * ── ★★ THE CANVAS COMPLETENESS RULE IS GONE, AND ITS ABSENCE IS THE HONEST STATE ────
   *
   * It read: refuse a canvas save when an unread grant's pod is one the envelope already names.
   * That rule could not fire for any fold `foldRoster` produces, and the reason is structural
   * rather than a matter of odds. A pod has exactly ONE grant in a workspace — the scan matches
   * `<workspace>-grant-<pod>` — so a pod whose grant went unread has no row that seats it, no
   * `grantedTo`, and therefore no WebID in `shareWith`. "Unread" and "already addressed" are
   * mutually exclusive under that naming. Left in as a guard against a hand-built roster, it read
   * to every subsequent reader as the canvas verb having a completeness policy, and it had none.
   *
   * ★ THE HARM IT WAS AIMED AT IS REAL AND IS CAUGHT BELOW, in the population that genuinely IS
   * both addressed and unreadable: a member whose GRANT was read — so they are in the envelope —
   * and whose ACCEPTANCE was not, so no key of theirs could be. That is the sealing rule, it
   * applies to `'canvas'` and `'entry'` alike, and it is keyed on a state the fold does produce.
   *
   * So `'canvas'` and `'entry'` now share one policy, which is what the harm analysis in
   * {@link WriteKind} says outright: neither can evict anybody, and a canvas revision a member
   * missed is recomputed and re-addressed by the next save.
   */

  /**
   * ── ★★ WHETHER THIS WRITE CAN BE SEALED END TO END, AND WHAT IT COSTS IF NOT ────
   *
   * Only the two verbs that seal ask. `'reseal'` never does: `resealRecord` publishes the record
   * as plaintext under `visibilityFor('record', 'private')` = `'shared'`, deliberately, so its
   * mode is `'unsealed'` and there is no downgrade to report.
   *
   * The two populations are judged apart because they are different facts — see
   * {@link RecipientPlan.keysMissing} and {@link RecipientPlan.keysUnestablished}.
   */
  let sealing: Sealing = {
    mode: 'unsealed',
    why: 'the workspace record is published under the relay\'s shared class by design — it carries the '
      + 'title, convener, role profile and entry shape, and the grants naming its members are public — so '
      + 'this client seals nothing here.',
  };
  if (asks('entry', 'canvas')) {
    /**
     * ★★ A READ THAT COULD STILL COMPLETE MAY NOT DECIDE THIS. Sealing to the members whose keys
     * WERE read would leave this one out of an envelope on a read that established nothing, which
     * is the act the rule beside `Seat.basis` forbids; not sealing hands the relay every private
     * write in the workspace for as long as their pod is unwell. Neither is available on
     * ignorance, so nothing is written and the caller is told to look again.
     *
     * ★ AND ONLY WHILE IT COULD CLEAR — the same permanence rule the reseal applies to unread
     * grants, and for the same reason: several of the ways a read fails are permanent, and a
     * refusal that waits for one of those is an outage with a sentence attached. When every one of
     * these rows is `'permanent'` the write proceeds under the relay's key and SAYS SO.
     *
     * ★ AND ONLY WHEN IT WOULD OTHERWISE HAVE SEALED. If a seated member already publishes no key
     * this write was going to be relay-readable whatever this row does, and the unestablished
     * member is inside that envelope rather than outside it — so refusing buys no confidentiality
     * and costs the workspace its conversation.
     */
    const keyMayClear = plan.keysUnestablished.filter((u) => u.kind !== 'permanent');
    if (plan.keysMissing.length === 0 && keyMayClear.length > 0) {
      /**
       * ★ EACH DISTINCT REASON ONCE, AND MORE THAN ONE OF THEM. Rows fail together far more often
       * than they fail differently — one pod being unwell writes the same sentence onto every
       * member on it — so quoting every row prints one clause N times, while quoting only the
       * first states one cause as though it were all of them. Both readings were here at once:
       * the list above named all N and the reason below named row zero.
       */
      const reasons = [...new Set(keyMayClear.map((u) => sentence(u.why)))];
      return {
        ok: false, retryable: true,
        why: keyMayClear.length + ' member' + (keyMayClear.length === 1 ? '' : 's') + ' of this private workspace ('
          + listOf(keyMayClear.map((u) => u.pod ?? u.webId)) + ') could not be read — '
          // The rows' own words, and each is written as a CLAUSE with no terminal stop, so one is
          // supplied here rather than letting the next sentence run into it.
          // Only the FIRST opens mid-sentence, after the dash. A second one starts its own.
          + reasons.slice(0, 2).map((r, i) => (i === 0 ? r : capitalise(r))).join(' ')
          + (reasons.length > 2
            ? ' (' + (reasons.length - 2) + ' further reason' + (reasons.length === 3 ? ' is' : 's are')
              + ' recorded on the roster.)'
            : '')
          + ' Sealing without them would shut them out of this write for good, and publishing unsealed would '
          + 'hand the relay everything written here; neither is being done on a read that has not finished. '
          + 'Read the members list again. Nothing was written.',
      };
    }
    const degraded = plan.keysMissing.length > 0 || plan.keysUnestablished.length > 0;
    sealing = degraded
      ? {
          mode: 'escrow',
          keysMissing: plan.keysMissing,
          keysUnestablished: plan.keysUnestablished,
          why: 'this write is NOT end-to-end encrypted. '
            + (plan.keysMissing.length > 0
              ? plan.keysMissing.length + ' member' + (plan.keysMissing.length === 1 ? '' : 's') + ' of this '
                + 'workspace (' + listOf(plan.keysMissing) + ') published no encryption key in their own '
                + 'acceptance, so there is no key here to seal to for them. '
              : '')
            + (plan.keysUnestablished.length > 0
              ? plan.keysUnestablished.length + ' member' + (plan.keysUnestablished.length === 1 ? '' : 's')
                + ' (' + listOf(plan.keysUnestablished.map((u) => u.pod ?? u.webId)) + ') could not be read '
                // ★ THE CLAIM IS MADE ONLY WHERE IT WAS ESTABLISHED. Every one of these rows is
                // permanent exactly when nothing else was already forcing the relay path; where a
                // keyless member is, this write was relay-readable regardless and these rows may
                // still clear. Asserting permanence for both would be a sentence the code has not
                // earned, which is the failure two refusals in this file were already failed on.
                + (plan.keysUnestablished.every((u) => u.kind === 'permanent')
                  ? 'at all, and none of those reads clears by being repeated. '
                  : 'at all. ')
              : '')
            + 'It is being encrypted by the relay instead, which puts the relay\'s own key in the envelope — so '
            + 'the relay can read this, and that cannot be changed after the write.',
        }
      : { mode: 'seal', keys: plan.keys };
  }

  /**
   * ── ★★ THE RESEAL, THE ONE WRITE THAT CAN COST SOMEBODY THEIR MEMBERSHIP ────
   *
   * It refuses while any unread grant could still be read, and only then. A fold that has not
   * finished looking must not republish a recipient set with `auto_supersede_prior`, because
   * `verifyGrantIri` reads that record as a precondition of accepting — losing it is a one-way door
   * out of the workspace for somebody nobody revoked.
   *
   * ★ AND WHEN NOTHING CAN CLEAR, IT DOES NOT REFUSE. That is the whole of the fix: three of the
   * four ways a grant goes unread are permanent, the act that repairs a permanently unreadable
   * grant is `sendInvite` republishing it, and refusing the reseal refuses that act — so the guard
   * written to prevent one eviction produced a workspace nobody could ever be invited to or
   * repaired. `repairBy` closes the eviction by INCLUDING the missing pods, which needs no bytes
   * from the grant that would not read.
   */
  let repairBy: readonly { readonly pod: string; readonly why: string }[] = [];
  if (asks('reseal')) {
    if (mayClear.length > 0) {
      /**
       * ★★ THE EXIT IS COMPOSED FROM THE ROWS RATHER THAN ASSERTED OVER ALL OF THEM, and the
       * sentence it replaces was measured false. It read "This one does clear: read the members
       * list again and retry" for every row here — including the grants this fold's own READ CAP
       * stopped before, where re-folding with the same cap truncates in exactly the same place,
       * for ever. A workspace past its shell's cap therefore could not be invited to, under a
       * refusal saying the state would clear. `UnreadGrant.clears` is carried per row for exactly
       * this, and `retryable` now means what its own note says: the SAME call, repeated, can
       * succeed.
       */
      const again = mayClear.filter((u) => u.clears === 'read-again');
      const capped = mayClear.filter((u) => u.clears === 'fold-more');
      const opaque = mayClear.filter((u) => u.clears !== 'read-again' && u.clears !== 'fold-more');
      const exits: string[] = [];
      if (again.length > 0) {
        exits.push('the read of ' + nameList(again) + ' did not complete and repeating it can succeed: read '
          + 'the members list again');
      }
      if (capped.length > 0) {
        exits.push('this fold stopped at its read cap after ' + roster.grantsRead + ' grant'
          + (roster.grantsRead === 1 ? '' : 's') + ' and never asked about ' + nameList(capped)
          + ', so re-reading under the same cap truncates in the same place — fold the roster again with a '
          + 'read cap of at least ' + roster.grantsFound);
      }
      if (opaque.length > 0) {
        exits.push('nothing at all is established about ' + nameList(opaque) + ', so no act can be named '
          + 'that clears ' + (opaque.length === 1 ? 'it' : 'them'));
      }
      return {
        ok: false,
        // ★ TRUE ONLY WHEN THIS SAME CALL, UNCHANGED, COULD ANSWER DIFFERENTLY. A cap-truncated
        // fold is not that, and neither is a row nothing is known about.
        retryable: again.length > 0,
        /**
         * ★★ AND THE ROWS ARE NAMED ONCE, BY THE CLAUSE THAT SAYS WHAT TO DO ABOUT THEM. This
         * sentence used to carry the whole population in parentheses as well. `again`, `capped`
         * and `opaque` partition `mayClear` exactly — `opaque` is defined as the complement of the
         * other two — so every row was already named below, and the list here was those same
         * names a second time. On a fold whose shortfall is unnamed padding it was one phrase
         * printed fifteen times and then fifteen more.
         */
        why: mayClear.length + ' of this workspace\'s ' + roster.grantsFound + ' grants could not be read yet, '
          + 'and re-sealing the record replaces who can read it — so somebody the fold has not finished '
          + 'looking at would be dropped from the document they need in order to accept. '
          // Capitalised because it opens a sentence — the clauses are composed per row, so which
          // one comes first is not known where they are written.
          + capitalise(exits.join('; ')) + '. Nothing was written.',
      };
    }
    /**
     * ★ A PERMANENTLY UNREADABLE GRANT WHOSE IRI CARRIES NO POD IS THE ONE ROW INCLUSION CANNOT
     * REACH, so it is the one that still refuses — and the exit named is the act that fixes it
     * rather than a wait. It does not arise from `foldRoster`, whose scan matches grants on the
     * `<workspace>-grant-` prefix and so always leaves a pod behind it, unless a descriptor
     * describes the bare prefix with nothing after it.
     */
    const nameless = partial.filter((u) => u.pod === null);
    if (nameless.length > 0) {
      // ★ AND IT NAMES THEM BY IRI. The act this refusal asks for is republishing these grants,
      // and nobody can perform it against a count: the IRI is the whole of what is left to
      // identify a row whose name carries no pod. It is empty only for a row naming no graph
      // either, which `unreadGrants`'s padding is — and that padding is `'unknown'` rather than
      // permanent, so it returns above and never reaches here.
      const named = namedOnly(nameless);
      return {
        ok: false, retryable: false,
        why: nameless.length + ' grant' + (nameless.length === 1 ? '' : 's') + ' in this workspace could not be read '
          + 'and their IRIs name no pod'
          + (named === '' ? '' : ' (' + named + ')')
          + ', so there is no address to keep them at and re-sealing the record would drop '
          + 'them from it for good. Republish those grants under a name carrying the grantee\'s pod first. '
          + 'Nothing was written.',
      };
    }
    // Every remaining row is permanent AND has a pod, so each is repairable by inclusion.
    repairBy = partial.map((u) => ({ pod: u.pod as string, why: u.why }));
  }

  return {
    ok: true, visibility: 'private', shareWith: plan.shareWith,
    // ★ THE ONE LIST, TWICE, SO NOTHING CAN DISAGREE WITH ITSELF. `keys` is whatever `sealing`
    // decided and never `plan.keys` directly: reading the plan's raw list here is what let an
    // escrowed write hand a caller a key list it had already declined to seal with.
    keys: sealing.mode === 'seal' ? sealing.keys : [],
    sealing,
    keysMissing: plan.keysMissing, keysUnestablished: plan.keysUnestablished,
    pendingWebIds: plan.pendingWebIds, grantedWebIds: plan.grantedWebIds,
    unestablishedWebIds: plan.unestablishedWebIds, partial, repairBy,
  };
}

/**
 * WHO A PUBLISH ACTUALLY REACHED, and — separately — whether it said.
 *
 * ── ★★ "NOBODY WAS UNREACHED" AND "NOTHING WAS REPORTED" WERE ONE VALUE ─────
 *
 * `resolveRecipient` returns an entry with an EMPTY key list rather than an error when a handle
 * does not resolve or a pod registers no encryption key, and `computePublishRecipients` then adds
 * none. The publish SUCCEEDS. The single signal is `sharedWith[].agentCount` — so a private
 * workspace can be encrypted to nobody and look exactly like one encrypted to everybody.
 *
 * `unreachedRecipients` answered that question with an empty array from a response carrying no
 * `sharedWith` at all, which is "everybody was reached" stated from no evidence, in the function
 * whose own docblock called itself THE ONLY EVIDENCE. Its output is what `sendInvite`'s gate reads
 * before writing a grant — the gate that stops somebody being handed a grant they cannot use — so
 * an unreported publish opened it silently.
 *
 * ★ AND THE ABSENCE IS SOMETIMES LEGITIMATE, which is why this reports rather than refuses. The
 * relay emits `sharedWith` only when it resolved handles itself: `sharedWith: shareResolved.length
 * > 0 ? shareResolved : undefined`, and `shareResolved` is populated only when
 * `willShare = !sealed && (visibility is absent or 'shared')`. A SEALED publish resolves nobody by
 * design — the publisher chose the recipients — so absence there is correct and means nothing is
 * owed. A caller that DID hand the relay a share list and DID not seal is in the other case, and
 * only that caller knows which it is. So the fact is carried and the caller judges it.
 *
 *   · `established` — the response carried a per-handle resolution array.
 *   · `unreached`   — handles the relay STATED it resolved no agent for.
 *   · `unstated`    — handles it echoed with NO count. `agentCount` is optional in the relay's
 *                     published output schema, and reading a missing one as zero would report
 *                     "the relay said it reached nobody for them" about a relay that said nothing.
 *   · `named`       — every handle the response echoed, in order.
 */
export interface RecipientReach {
  readonly established: boolean;
  readonly unreached: readonly string[];
  readonly unstated: readonly string[];
  readonly named: readonly string[];
  /** Why nothing is established. Null exactly when `established` is true. */
  readonly why: string | null;
}

export function recipientReach(publishResponse: unknown): RecipientReach {
  const r = (publishResponse ?? {}) as { sharedWith?: readonly { handle?: string; agentCount?: number }[] };
  if (!Array.isArray(r.sharedWith)) {
    return {
      established: false, unreached: [], unstated: [], named: [],
      why: 'the publish response carried no per-handle resolution, so who the relay actually resolved a key '
        + 'for is not established here. A sealed publish legitimately reports none — the recipients were '
        + 'chosen before the write — but an unsealed one that named a share list should have.',
    };
  }
  const named: string[] = [];
  const unreached: string[] = [];
  const unstated: string[] = [];
  for (const x of r.sharedWith) {
    const handle = String(x?.handle ?? 'an unnamed handle');
    named.push(handle);
    // ★ `typeof`, NOT `?? 0`. A missing count and a stated zero are different answers, and the
    // coalescing form turned the first into the second — an assertion that the relay reported a
    // failure to resolve, made about a relay that reported nothing.
    if (typeof x?.agentCount !== 'number') unstated.push(handle);
    else if (x.agentCount === 0) unreached.push(handle);
  }
  return { established: true, unreached, unstated, named, why: null };
}

/**
 * The handles the relay STATED it resolved no agent for.
 *
 * ★ AN EMPTY LIST IS NOT EVIDENCE THAT ANYBODY WAS REACHED, and callers that need that question
 * answered ask {@link recipientReach}, which separates "the relay said nothing" and "the relay
 * said it reached everyone". This projection exists because `postEntry` and `saveCanvas` REPORT
 * the list and do not gate on it — for them the honest under-report is the right shape and the
 * three-state answer would be noise.
 */
export function unreachedRecipients(publishResponse: unknown): readonly string[] {
  return recipientReach(publishResponse).unreached;
}
