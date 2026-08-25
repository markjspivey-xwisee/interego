/**
 * THE SEAT FOLD: grants on the convener's pod, acceptances on each member's own.
 *
 * A seat is TWO documents on TWO pods with TWO different owners, and the substrate refuses
 * either party the other's pod — so neither half can be manufactured by the party that
 * benefits from it. Find only the grant and the row reads "invited"; find only the acceptance
 * and it reads as a seat nobody granted.
 *
 * ★ EVERY NON-SEAT CARRIES A REASON, AND THE REASONS ARE NOT INTERCHANGEABLE. "granted, but
 * no acceptance published yet" and "their acceptance could not be read" are different facts
 * about different worlds, and a fold that collapsed them told an invited member they had been
 * refused.
 */

import { graphRegion, hasTrue, isRetracted, readIri, readLiteral, readModalStatus } from './turtle.js';
import { podOfDescriptorUrl, podBaseOfDescriptorUrl, podOfNsIri, podOfWebid } from './naming.js';
import { shortRef } from './format.js';
import { fail, refusal } from './transport.js';
import { assertPod, type WorkspaceClient } from './substrate.js';

/** One row of the roster: a grant, folded as far as it could be. */
export interface Seat {
  readonly graph: string;
  grantUrl: string | null;
  grantCid: string | null;
  role: string | null;
  grantedTo: string | null;
  pod: string | null;
  seated: boolean;
  /** Why this row is not a seat. Null only when `seated` is true. */
  why: string | null;
  /**
   * Whether this row is a CONCLUSION or the absence of one.
   *
   * ── ★★ A CONCLUSION IS NOT THE ABSENCE OF ONE, AND EVERY READER GUESSED SEPARATELY ────
   *
   * `seated: false` is produced by an authoritative answer AND by every read this fold could not
   * complete, and until this field existed nothing on the row said which. Each consumer therefore
   * re-derived the judgement from whichever optional fields it happened to know about, and they
   * did not agree: `renderer.ts`'s `unestablishedSeat` reads five of them in another package,
   * while `recipientsFromRoster` drew no distinction at all and dropped a member whose acceptance
   * merely 502'd out of `shareWith` on every private entry — permanently, and with no error on
   * either side.
   *
   * `foldRoster` sets this AT THE EXIT IT ACTUALLY TOOK, which is the only place the difference is
   * known for certain. It is never inferred by a reader.
   *
   *   · `'answered'` — somebody entitled to answer did: `wsp:revoked`; `iep:modalStatus`
   *     "Retracted" on either half; an acceptance that WAS read and does not seat (a stale pin, no
   *     stream, a stream under another pod, a duplicate log); or an absence the relay STATED — for
   *     the grant, at its own IRI; for the acceptance, at every candidate name.
   *   · `'unestablished'` — a read did not complete: an unreadable head, a head whose body could
   *     not be fetched (`headError`), a forked chain on either half, a descriptor that threw, or a
   *     signed region that would not locate.
   *
   * ★★ THE RULE, WHICH EVERY CONSUMER QUOTES: nothing may DROP a row, DELETE a stream, UNSUBSCRIBE
   * a watch, EXCLUDE somebody from an ENVELOPE, or WRITE a membership document on
   * `'unestablished'`. Each of those acts is irreversible from the other side — an envelope's
   * recipients are fixed at write time, and a superseding membership write retires the revision
   * the missing member could read — so performing one on a read that established nothing spends
   * somebody else's access to buy nothing.
   *
   * ★ OPTIONAL ONLY FOR HAND-BUILT ROSTERS, AND ABSENCE IS THE SAFE SIDE. Every row `foldRoster`
   * produces carries it — the fold's own `place()` will not push a row without one. Test doubles
   * and shell fixtures build `Seat` literals directly, and `seatStanding` reads a missing value as
   * `'unestablished'`, which is the reading that forbids the irreversible acts above rather than
   * licensing them.
   */
  readonly basis?: 'answered' | 'unestablished';
  /**
   * For an `'unestablished'` row: whether a REPEAT of the read that did not complete could
   * answer differently. Same three words, same question and same type as {@link ReadFailure} on
   * the grant half — see {@link UnreadGrant.kind}.
   *
   * ── ★★ THE ACCEPTANCE HALF HAD NO PERMANENCE AXIS AND A REFUSAL NEEDS ONE ────
   *
   * `basis` says a read did not complete; it does not say whether waiting helps. A consumer that
   * refuses a write while a seat is unestablished has to print an exit, and the only exits
   * available are "read the members list again" — true for a pod that timed out, false for an
   * acceptance whose chain is forked — and "that member has to republish their acceptance", which
   * is the other way round. One sentence for both states is how this round produced two refusals
   * that advertised a remedy that was a no-op in the state that produced them.
   *
   * ★ OPTIONAL FOR THE SAME REASON `basis` IS: hand-built rosters. Inside `foldRoster` it is not
   * optional — `place()` will not take `'unestablished'` without one — and a missing value reads
   * as `'unknown'`, which claims nothing either way. Meaningless when `basis` is `'answered'`,
   * and never set there.
   */
  readonly unreadKind?: ReadFailure;
  /** Granted and awaiting an acceptance — an ordinary state, not a failure. */
  pending?: boolean;
  revoked?: boolean;
  /**
   * What each half of the seat states about its OWN status, read from its signed region.
   *
   * ★ SEPARATE FROM `revoked`, BECAUSE THEY ARE SEPARATE FACTS. `wsp:revoked` is the convener
   * withdrawing a seat; `iep:modalStatus "Retracted"` is the author of those bytes withdrawing
   * the record itself — and either half can be withdrawn by its own owner without touching the
   * other. Null is "the record stated no status", which is not a withdrawal.
   */
  grantStatus?: string | null;
  acceptStatus?: string | null;
  acceptIri?: string;
  acceptNaming?: string;
  acceptUrl?: string;
  acceptTest?: string;
  accepts?: string | null;
  acceptsCid?: string | null;
  stream?: string | null;
  /**
   * This member's X25519 public key, read from THEIR OWN acceptance's signed region.
   *
   * ★★ THE ONLY SOURCE A SEALING PUBLISHER MAY USE. The alternative — each pod's agent registry —
   * is rewritable by the relay, and `encryptionKeyToRecord` already substitutes the relay's own key
   * there as a placeholder for an agent that registered none. Sealing to a key read from the
   * registry can therefore seal to the relay while the publisher believes the opposite. Read from
   * the same signed region as `wsp:stream` and `wsp:accepts`, so a substituted key means a new
   * head that visibly supersedes an honest one.
   */
  encryptionKey?: string | null;
  streamPod?: string | null;
  podServed?: string | null;
  podBase?: string | null;
  memberAgent?: string | null;
  memberAgentVerified?: boolean;
  grantAuthorship?: unknown;
  acceptAuthorship?: unknown;
}

/**
 * The fold's own two views of a row, which exist to make the classification non-omittable.
 *
 * A `SeatDraft` is a row being built and has NO `basis` yet; a `PlacedSeat` has one. `foldRoster`
 * collects `PlacedSeat`, so the only way a draft reaches the result is through `place`, which
 * takes the basis as an argument. Neither type is exported: outside this file a `Seat` is a `Seat`.
 */
type SeatDraft = Omit<{ -readonly [K in keyof Seat]: Seat[K] }, 'basis' | 'unreadKind'>
  & { basis?: Seat['basis']; unreadKind?: Seat['unreadKind'] };
/**
 * ★ AND THE PERMANENCE IS PART OF THE CLASSIFICATION RATHER THAN A SECOND FIELD SOMEBODY
 * REMEMBERS. `place` takes its arguments as `['answered'] | ['unestablished', ReadFailure]`, so an
 * exit that says a read did not complete cannot omit whether repeating it could help — the same
 * enforcement `basis` itself gets, applied to the question a refusal has to answer next.
 */
type PlacedSeat = Seat & (
  | { readonly basis: 'answered' }
  | { readonly basis: 'unestablished'; readonly unreadKind: ReadFailure }
);

/**
 * What one roster row STANDS AS, for a consumer deciding whether it may act.
 *
 * Three states, because there are three: they are in, they are out, or this fold does not know.
 * The two-valued question every consumer used to ask — `seated` — has no room for the third, and
 * the third is the one that costs somebody their workspace.
 */
export type SeatStanding = 'seated' | 'out' | 'unestablished';

/**
 * The one reader of {@link Seat.basis}. Consumers call this rather than testing the fields.
 *
 * ★ IT EXISTS SO THE JUDGEMENT IS MADE ONCE, WHERE IT IS KNOWN — see the field. `renderer.ts`'s
 * `unestablishedSeat` answers the same question in a different package from five optional fields,
 * and `recipientsFromRoster` did not ask it at all until this function existed.
 *
 * ★★ AND THE RULE TRAVELS WITH IT: nothing may DROP a row, DELETE a stream, UNSUBSCRIBE a watch,
 * EXCLUDE somebody from an ENVELOPE, or WRITE a membership document on `'unestablished'`. A row
 * with no `basis` set — a hand-built one — reads as `'unestablished'` for that reason: the safe
 * side of this rule is the side that refuses to spend somebody else's access.
 */
export function seatStanding(s: Seat): SeatStanding {
  if (s.seated) return 'seated';
  return s.basis === 'answered' ? 'out' : 'unestablished';
}

/**
 * For a row standing `'unestablished'`, whether repeating the read could answer differently.
 *
 * ★ THE COMPANION READER TO {@link seatStanding}, and consumers call it rather than reading
 * {@link Seat.unreadKind} — a hand-built row carries no kind, and reading the field directly
 * would give `undefined`, which every `!==` test treats as a decision. `'unknown'` is what a
 * missing value MEANS: nothing was established about the read, so nothing is claimed about
 * repeating it. Meaningless for a row that is `'seated'` or `'out'`.
 */
export function seatUnreadKind(s: Seat): ReadFailure {
  return s.unreadKind ?? 'unknown';
}

/**
 * How likely a REPEAT of the same read is to answer differently. Not a severity, and not a
 * statement about the member — a statement about the read.
 *
 * ── ★★ THREE OF THE FOUR WAYS A GRANT GOES UNREAD ARE PERMANENT ─────────────
 *
 * The one consumer that acted on a short read treated every one of them as "wait and retry", and
 * that is why a single unreadable grant took a whole workspace read-only for good. A forked chain
 * is collapsed only by a republish; an absence the relay STATED is fixed only by a publish; a
 * signed region that will not locate is fixed only by rewriting the descriptor. None of the three
 * clears on its own, and a client that tells somebody to wait for one is describing an outage.
 *
 *   · `'transient'`  — nothing about the DOCUMENT failed. The relay or the pod did not deliver an
 *                      answer about it (a cold pod, a redeploy, a session that needs renewing) or
 *                      this fold's own read cap stopped before it. The same read, unchanged, can
 *                      succeed.
 *   · `'permanent'`  — the read completed and what is published cannot be read as a grant. Only a
 *                      WRITE changes it.
 *   · `'unknown'`    — the relay answered ABOUT this document and reported a failure, or answered
 *                      in a shape this client cannot interpret. Whether repeating helps is not
 *                      established, so it is not claimed either way.
 */
export type ReadFailure = 'transient' | 'permanent' | 'unknown';

/**
 * One grant this fold did not read, and everything that can be said about it WITHOUT reading it.
 *
 * ★ THE POD IS RECOVERED FROM THE IRI, NOT FROM THE BYTES — see {@link podOfGrantGraph}. That is
 * what makes this row useful rather than merely honest: a reseal can put the pod back into its
 * audience even though nothing inside the grant could be read, which closes the eviction without
 * refusing the write that would have caused it.
 */
export interface UnreadGrant {
  /** The grant graph IRI. Empty only for a hand-built fold — see {@link unreadGrants}. */
  readonly graph: string;
  /** The grantee's pod, from the IRI. Null when the IRI carries none. */
  readonly pod: string | null;
  readonly kind: ReadFailure;
  /**
   * WHICH ACT would change this row's answer.
   *
   * ── ★★ `kind` IS NOT FINE ENOUGH TO PRINT AN EXIT FROM, AND A REFUSAL PRINTED ONE ────
   *
   * `kind` answers "could the SAME read answer differently". Two rows share a kind and do not
   * share an act: a grant the read cap stopped before and a grant whose head fetch failed are
   * both `'transient'`, and "read the members list again and retry" clears the second while
   * being an exact no-op for the first — re-folding with the same cap truncates at the same
   * place, for ever. `recipients.ts` printed that sentence for both, and no shell exposes the
   * read cap, so a workspace past its shell's cap could not be invited to under a refusal
   * saying it would clear.
   *
   *   · `'read-again'`  — a read was made and did not complete. Repeating the same call is a real
   *                       act and can answer differently. Both `'transient'` and `'unknown'` land
   *                       here, which keeps `throwKind`'s own promise that the two words differ
   *                       only in what a surface may SAY: a pod's 502 reaches this client as
   *                       `tool_error` and so classifies `'unknown'`, and telling somebody to read
   *                       again is right for it.
   *   · `'fold-more'`   — this fold never asked. Only a fold with a larger `readCap` reaches it,
   *                       and repeating the same call truncates in exactly the same place.
   *   · `'republish'`   — the read completed and what is published cannot be read as a grant.
   *   · `'unknown'`     — nothing is established about the row, including whether it was asked
   *                       for. Only {@link unreadGrants}'s reconciliation padding produces it.
   *
   * ★ CARRIED, NOT DERIVED. Every exit states it beside its `kind`, so the two cannot drift into
   * a mapping table somebody has to keep in step with the exits.
   */
  readonly clears: 'read-again' | 'fold-more' | 'republish' | 'unknown';
  /** The same sentence the row's `why` carries, or — for a grant no row exists for — its own. */
  readonly why: string;
}

/**
 * The grantee's POD, out of a grant graph IRI, reading nothing.
 *
 * ★★ THE INVERSE OF THE COMPOSITION THIS FILE ALREADY PERFORMS. `foldRoster` builds
 * `<workspace>-grant-<pod>` to find a pod's grant, and `sendInvite` writes it under exactly that
 * name (`membership.ts`'s `grantIri`). So when the grant's BYTES cannot be read, its NAME still
 * says whose it is — and that is the whole of what a reseal needs in order not to evict them.
 *
 * ★ IT IS NOT A CLAIM THAT THE POD EXISTS, or that the grant seats anybody. It is a claim about
 * the IRI and nothing else; a caller that turns it into a recipient resolves it first.
 */
export const podOfGrantGraph = (graph: string, workspace: string): string | null => {
  const prefix = workspace + '-grant-';
  return graph.indexOf(prefix) === 0 ? (graph.slice(prefix.length) || null) : null;
};

/** What the fold found, and the one cap it still has — how many of the grants it found it READ. */
export interface RosterFold {
  readonly seats: readonly Seat[];
  readonly grantPod: string;
  /** Non-null when the grant pod came from `wsp:convener` rather than the workspace IRI. */
  readonly grantPodDerivedFrom: string | null;
  readonly grantsFound: number;
  /**
   * How many of those grants were actually READ — signed region located and parsed — not how
   * many this fold reached for. See the counter in {@link foldRoster} for what that distinction
   * cost.
   */
  readonly grantsRead: number;
  /**
   * WHICH grants the pair above is short by, one row each, classified by permanence.
   *
   * ── ★★ A COUNT IS NOT A FINDING, AND ONE INTEGER PAIR REFUSED A WHOLE PRODUCT ─────
   *
   * `grantsFound > grantsRead` was the entire input to a refusal that gated every entry, every
   * canvas save, every canvas merge and every invitation in the workspace. Two numbers cannot say
   * whether the shortfall will clear on its own, and they cannot say WHOSE grant is missing — so
   * the one act that repairs a permanently unreadable grant, `sendInvite` republishing it, was
   * refused by the same guard, and the workspace stayed read-only for everybody, for good.
   *
   * This array is that pair with its evidence attached, and it is what makes a per-verb policy
   * possible: `recipientsFor` can now ask "is this shortfall going to clear" and "would including
   * these pods be enough" instead of comparing two integers.
   *
   * ★ THE INVARIANT, WHICH `foldRoster` MAINTAINS AT EVERY EXIT AND WHICH
   * `tests/workspace-recipients.test.ts` PINS AT EACH ONE SEPARATELY:
   * `grantsRead === grantsFound - unread.length`. That is what lets every existing reader of the
   * two counters keep working unchanged — `renderer.ts`, `discord/src/render.ts` and the artifact
   * all still render the pair — while the new consumers read the rows.
   *
   * ★ OPTIONAL ONLY FOR HAND-BUILT FOLDS, and absence is the safe side, exactly as it is for
   * {@link Seat.basis}. Shell fixtures and test doubles build a `RosterFold` literal; every fold
   * `foldRoster` produces carries this. {@link unreadGrants} reads a missing one as "the shortfall
   * exists and nothing is established about it", which is the reading that refuses the one write
   * that can evict somebody rather than licensing it.
   */
  readonly unread?: readonly UnreadGrant[];
  readonly grantReadCap: number;
}

/**
 * The one reader of {@link RosterFold.unread}. Consumers call this rather than reading the field.
 *
 * ★ IT RECONCILES THE ROWS WITH THE COUNTERS, because a hand-built fold can carry the counters and
 * no rows at all, and a consumer that read the field directly would see `[]` and conclude the
 * roster is complete — which is the exact shape of the defect this whole round is about: the
 * absence of a finding read as a finding.
 *
 * So the shortfall the COUNTERS state is authoritative for how many rows there are, and the rows
 * supply what is known about them. Any remainder is `'unknown'` with no pod: nothing is
 * established about it, including whose it is.
 */
export function unreadGrants(fold: {
  readonly grantsFound: number;
  readonly grantsRead: number;
  readonly unread?: readonly UnreadGrant[];
}): readonly UnreadGrant[] {
  const known = fold.unread ?? [];
  const short = Math.max(0, fold.grantsFound - fold.grantsRead);
  if (known.length >= short) return known;
  const out: UnreadGrant[] = [...known];
  while (out.length < short) {
    out.push({
      graph: '', pod: null, kind: 'unknown',
      // Nothing is established about this row — not whether it was asked for, not what would
      // change it. `'unknown'` is the only honest value and it is what the sentence prints.
      clears: 'unknown',
      why: 'this roster reports ' + fold.grantsFound + ' grants found and ' + fold.grantsRead
        + ' read, and named no row for the difference — so nothing at all is established about this '
        + 'grant, not even which pod it is on.',
    });
  }
  return out;
}

/**
 * How many of the grants the scan FINDS are then read.
 *
 * ★ THE ONLY CAP LEFT, AND IT IS A WORK BOUND RATHER THAN A VISIBILITY ONE. Each read is two
 * round trips (head + descriptor) against a possibly cold pod plus an acceptance lookup on the
 * member's own, so an unbounded fold on a large workspace is a client that appears to hang. The
 * ENUMERATION is now complete (see {@link foldRoster}); this bounds only how much of it one
 * caller will dereference, and the caller is told both numbers.
 *
 * ★ AND IT IS A DEFAULT, NOT A CONSTANT ANY MORE. One number cannot serve a background responder
 * and a per-keystroke Discord autocomplete: `main.ts` states that picker's budget as three
 * seconds with NO deferral — Discord has no "thinking" state for an autocomplete, so a handler
 * that overruns produces an empty box with no explanation. Callers with room pass a bigger
 * `readCap`; the picker keeps this.
 */
export const GRANT_READ_CAP = 25;

/**
 * WHICH POD HOLDS THE GRANTS, decided once and exported so a caller can NAME it.
 *
 * The record NAMES a convener; that name, resolved to a pod, is where grants are read from.
 * The pod segment inside the workspace IRI is only the fallback for a record that names none.
 * This is exported because a shell that reports "grants live on pod X and that read failed"
 * has to mean the same X the fold would have used — re-deriving the `??` in a message string
 * is how a diagnostic comes to name a pod nothing was ever asked for.
 */
export const grantPodFor = (convenerPod: string | null, iriOwner: string): string => convenerPod ?? iriOwner;

/**
 * What a THROW out of a grant read says about repeating it.
 *
 * ★ THE QUESTION IS "DID THE RELAY ANSWER ABOUT THIS DOCUMENT", AND `code` IS WHERE THAT IS
 * WRITTEN DOWN. `entry.ts` already draws exactly this line for a different decision — "`tool_error`
 * means the relay ANSWERED and reported a failure; only the transport codes mean it did not
 * answer" — so it is applied here rather than re-invented, and nothing regex-matches an error
 * message to find a status number.
 *
 * ★ AND `tool_error` IS `'unknown'` RATHER THAN `'transient'`, WHICH IS THE UNFLATTERING HALF.
 * `RelayClient.descriptor` turns a pod's own 502 into `fail('tool_error', …)` — the numeric code
 * is in the relay's refusal body, which that helper does not carry out — so the canonical cold-pod
 * case lands here as `'unknown'`. That is honest: this reader cannot tell that failure from a
 * permanent one at the pod. It also costs nothing, because every policy in `recipients.ts` treats
 * `'transient'` and `'unknown'` identically; the two words differ only in what a surface may say.
 */
function throwKind(e: unknown): ReadFailure {
  const err = e as { code?: string; retryable?: boolean } | null;
  if (err?.retryable === true) return 'transient';
  if (typeof err?.code !== 'string' || err.code === 'tool_error') return 'unknown';
  // Every other `ToolCallError` code the transport raises — `server_unavailable`,
  // `upstream_error`, `server_not_connected`, `manifest_incomplete`, `needs_reauth` — means the
  // relay did not deliver an answer about this graph at all, so the document is untouched and the
  // same read can succeed once whatever it was clears.
  return 'transient';
}

/**
 * What a member-document probe that found nothing says about repeating it.
 *
 * ★ READ OFF THE PER-CANDIDATE OUTCOMES `resolveMemberDoc` ALREADY RECORDS, not off the collapsed
 * `error` string. Those outcomes are the only place the difference survives: a head that IS
 * published and whose body would not fetch is a pod that answered and came up short, and the same
 * read can succeed once it warms — while an answer this reader could not interpret establishes
 * nothing at all, including whether repeating helps.
 *
 * Only reached when no candidate answered `found` and not every candidate STATED an absence — a
 * roster row that is `'unestablished'` on its acceptance half.
 */
function acceptanceReadKind(candidates: readonly { readonly outcome: string }[]): ReadFailure {
  if (candidates.some((c) => c.outcome === 'head-unreadable')) return 'transient';
  // A fork is collapsed by a republish and by nothing else. It is normally taken by the branch
  // above this function's callers, and is classified here too so the two cannot disagree.
  if (candidates.some((c) => c.outcome === 'forked')) return 'permanent';
  // `'unreadable'` and `'error'` alike: the relay answered in a shape this client cannot read, or
  // the call threw with no code carried out of `resolveMemberDoc`. Nothing is claimed either way.
  return 'unknown';
}

/**
 * Fold the roster for one workspace.
 *
 * ★ BOUNDED. The number of tool calls is `1 + 2·min(grantsFound, GRANT_READ_CAP) +
 * 2·(acceptance lookups)`, and the acceptance lookup is at most two heads per member. Nothing
 * here loops on a condition the relay controls.
 */
export async function foldRoster(
  client: WorkspaceClient,
  args: {
    readonly workspace: string;
    /** The pod segment inside the workspace IRI. Used only when the record names no convener. */
    readonly iriOwner: string;
    readonly slug: string;
    readonly convener: string | null;
    readonly convenerPod: string | null;
    /**
     * How many of the grants found may be dereferenced. Defaults to {@link GRANT_READ_CAP}.
     *
     * Per-caller because the budgets genuinely differ — see the constant. A caller that raises
     * this is claiming it has the time, and nothing here can check that claim for it.
     */
    readonly readCap?: number;
    /**
     * Pods whose grant should be read FIRST if the cap bites. The convener's own is always
     * included; a shell adds the viewer's.
     *
     * ★ WHICH GRANTS SURVIVE A TRUNCATED READ IS THE REAL DEFECT ONCE ENUMERATION IS COMPLETE.
     * The scan is newest-first, and grants are written ONCE at invite time while entries are
     * published to the same pod continuously — so the oldest members, very often including the
     * convener's own founding grant, are exactly the rows a cap drops. Ordering the rows that
     * matter to the front costs nothing and removes that symptom without raising the cap.
     */
    readonly prefer?: readonly string[];
  },
): Promise<RosterFold> {
  // ★ WHICH POD HOLDS THE GRANTS — see `grantPodFor`. Using the pod segment inside the
  // workspace IRI and throwing the convener away meant a record naming a convener elsewhere
  // was read from the wrong pod and reported an empty roster.
  const grantPod = grantPodFor(args.convenerPod, args.iriOwner);

  /**
   * ★ NO `limit`, AND THAT IS THE FIX RATHER THAN AN OVERSIGHT.
   *
   * This asked for `limit: 400` and then reported `grantScanSaturated` when 400 came back, which
   * every surface rendered as "older grants may lie past the end of this — a member missing from
   * the roster would also be missing from the channel". Honest, and avoidable: the cap bought
   * NOTHING. Read from the relay's own handler rather than assumed — `discover_context`'s `limit`
   * is optional, documented "Default: unbounded", has no maximum, and is applied LAST, as
   * `sorted.slice(0, limit)` over a set the relay has already built in full. It caches the whole
   * pod manifest server-side either way. So the 400 sliced the JSON response and cost this fold
   * the ability to see a founding member.
   *
   * ★ AND REMOVING IT CANNOT UNSEAT ANYBODY, because the relay sorts THEN slices: the capped
   * answer was exactly the newest-400 PREFIX of the uncapped one, so this can only append rows
   * older than the old cutoff. Monotone, checked against the handler and not inferred.
   *
   * ★ WHICH IS WHAT EARNS THE SILENCE. Dropping a "may be incomplete" warning is only honest if
   * the read is now complete, and this one is: `discover()` follows the manifest's archive chain
   * and THROWS rather than hand back a partial pod, so a short answer here is a real answer and
   * not a truncated one. Absence is evidence only when the read could not have missed anything.
   */
  const p = await client.tool('discover_context', { pod_name: grantPod, sort: 'newest-first' }) as Record<string, unknown> | null;
  const bad = refusal(p);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  // ★ THE POD ECHO, ON THE ONE CROSS-POD READ THIS FOLD MAKES. `assertPod` states the rule: a read
  // that quietly fell back to the CALLER'S own pod is invisible when the caller is also the
  // convener and catastrophic when they are not — the roster would be folded from a stranger's
  // documents. `RelayClient.manifest` and `findSeat` both apply it to this same tool with this
  // same argument shape; this raw call skipped it, so the one fold that reads somebody else's pod
  // was the one that did not check whose pod answered.
  assertPod(grantPod, p?.['pod'], 'discover_context');
  /**
   * ★★ A FAILED READ MUST NOT LOOK LIKE AN EMPTY ONE — and this is the line where that stopped
   * being true. It was `(p?.['entries'] as …) ?? []`, so a response carrying no entries array at
   * all folded as a workspace with ZERO grants: `grantsFound` 0, `grantsRead` 0, no seats. The
   * completeness guard downstream compares those two numbers, so it cannot fire on a pair that is
   * equal, and every surface then STATED the absence — "no grants for this workspace were found on
   * that pod", an empty member list, zero targets for the invite picker, every live watch dropped.
   *
   * The same rule is already written out one layer down in `RelayClient.manifest`, which throws
   * for exactly this; this call bypasses that method to scan a whole pod rather than one graph, so
   * it has to restate the rule rather than inherit it. The file's own note above — "absence is
   * evidence only when the read could not have missed anything" — is what this makes true.
   */
  const rows = p?.['entries'];
  if (!Array.isArray(rows)) {
    throw fail('tool_error', 'discover_context on ' + grantPod + ' returned no entries array, so the grants on that '
      + 'pod could not be enumerated at all — which is not the same as the workspace having no members.');
  }

  const prefix = args.workspace + '-grant-';
  const seen = new Set<string>();
  const grantRows: { graph: string }[] = [];
  for (const e of rows as readonly Record<string, unknown>[]) {
    const describes = e['describes'];
    if (!Array.isArray(describes)) continue;
    const g = (describes as string[]).find((x) => typeof x === 'string' && x.indexOf(prefix) === 0);
    if (!g || seen.has(g)) continue;
    seen.add(g);
    grantRows.push({ graph: g });
  }
  const grantsFound = grantRows.length;
  const grantReadCap = args.readCap ?? GRANT_READ_CAP;
  // ★ A STABLE PARTITION, NOT A SORT. The relay's order is the only ordering evidence there is
  // for the rest; this moves the grants a truncated read must not lose to the front and leaves
  // every other row exactly where the relay put it.
  const first = new Set<string>([prefix + grantPod, ...(args.prefer ?? []).map((pod) => prefix + pod)]);
  const ordered = [...grantRows.filter((g) => first.has(g.graph)), ...grantRows.filter((g) => !first.has(g.graph))];
  const toRead = ordered.slice(0, grantReadCap);

  /**
   * ★ EVERY ROW LEAVES THIS FOLD THROUGH `place`, AND `place` WILL NOT TAKE ONE WITHOUT A BASIS.
   *
   * `Seat.basis` is optional on the published type so shell fixtures and test doubles can build a
   * row by hand — see the field. Inside the fold it is not optional: the array below holds
   * `PlacedSeat`, a draft is missing `basis` until `place` supplies it, and a bare `seats.push(m)`
   * is therefore a compile error. That is deliberate: three rounds of fixes in this area each
   * closed the exits their brief named and left the sibling exits nobody named exactly as they
   * were, and a convention that every exit must classify itself is precisely the kind of rule that
   * survives until the next person adds an exit. A type survives longer.
   */
  const seats: PlacedSeat[] = [];
  const place = (row: SeatDraft, ...basis: ['answered'] | ['unestablished', ReadFailure]): void => {
    seats.push((basis[0] === 'answered'
      ? Object.assign(row, { basis: 'answered' as const })
      : Object.assign(row, { basis: 'unestablished' as const, unreadKind: basis[1] })) as PlacedSeat);
  };
  /**
   * Grants this fold did not read, with the permanence of each — see {@link RosterFold.unread}.
   *
   * ★ ITS LENGTH IS THE OTHER HALF OF THE COUNTER BELOW, AND THE TWO MUST NOT DRIFT.
   * `grantsRead === grantsFound - unread.length` holds because exactly the exits that skip
   * `grantsRead++` push here, plus the grants the cap never reached. `unreadHere` exists so the
   * two acts a skipped read requires — classify the row, place the seat — are one call rather
   * than two lines that a later exit can half-copy.
   */
  const unread: UnreadGrant[] = [];
  const unreadHere = (
    row: SeatDraft,
    basis: 'answered' | 'unestablished',
    kind: ReadFailure,
    clears: UnreadGrant['clears'],
  ): void => {
    unread.push({
      graph: row.graph, pod: podOfGrantGraph(row.graph, args.workspace), kind, clears,
      // The row's own sentence, so a caller reporting the hole and a caller rendering the roster
      // quote the same words about the same grant.
      why: row.why ?? 'this grant was not read, and this fold recorded no reason',
    });
    // ★ THE SEAT CARRIES THE SAME PERMANENCE THE UNREAD ROW DOES. One skipped read, one
    // classification: a consumer holding the seat and a consumer holding the `unread` row must
    // not be able to reach different conclusions about whether waiting helps.
    if (basis === 'unestablished') place(row, 'unestablished', kind);
    else place(row, 'answered');
  };
  /**
   * Grants whose signed region was located and parsed. NOT the number this fold reached for.
   *
   * ── ★★ IT USED TO BE `toRead.length`, AND THAT DISARMED THE ONLY COMPLETENESS GUARD ────────
   *
   * `recipientsFromRoster` refused to seal anything when `grantsFound > grantsRead`, on the
   * reasoning that a roster missing members is exactly the wrong thing to encrypt to. Reporting
   * ATTEMPTS made the two numbers equal no matter how many of the reads failed, so that refusal
   * could not fire for the failure it was written for.
   *
   * ★ THAT CHANNEL-WIDE REFUSAL IS GONE — see `recipients.ts`, which judges the shortfall per
   * WRITE VERB and, for the one verb that can evict, closes it by INCLUDING the missing pods
   * rather than by refusing. This counter is still exact for the same reason it was made exact:
   * the pair `grantsFound`/`grantsRead` is what `unread.length` is reconciled against, and every
   * per-verb policy is built on the rows that reconciliation produces.
   *
   * Every exit below that leaves this counter short — a forked chain, an unreadable head, a head
   * whose body could not be fetched, a signed region that would not locate, a throw — leaves a row
   * with `grantedTo === null`, `seated === false` and `pending` unset, and a row like that is in
   * NONE of the three lists a reseal audience is unioned from, so the next invitation republishes
   * the record without that member. Measured:
   * three grants on the convener's pod, `get_descriptor` 502 for exactly one of them, and the
   * fold reported `grantsFound 3 / grantsRead 3`, the plan came back `ok: true`, and the 502'd
   * member was silently absent from `share_with` on the bytes that were published. Losing the
   * record is a one-way door — `verifyGrantIri` reads it, so they cannot re-accept — and nobody
   * revoked them. A transient 502 during somebody ELSE's invite was the whole cause.
   */
  let grantsRead = 0;
  for (const g of toRead) {
    const m: SeatDraft = { graph: g.graph, grantUrl: null, grantCid: null, role: null, grantedTo: null, pod: null, seated: false, why: null };
    /**
     * Whether `grantsRead` has already been incremented for THIS row.
     *
     * ★ IT EXISTS FOR THE CATCH BELOW, WHICH SPANS BOTH SIDES OF THE COUNTER. The five classified
     * exits all sit before the increment; the `try` does not, so a throw from anything after it
     * reaches the same `catch`. The invariant `grantsRead === grantsFound - unread.length` is what
     * every consumer of the pair now rests on, so "did this row already count" is READ here rather
     * than argued from which of the statements between the increment and the end of the block are
     * believed unable to throw.
     */
    let counted = false;
    try {
      // No cache on a head: a revocation republishes the grant, and a stale head would keep a
      // withdrawn member seated for the life of the entry.
      const h = await client.currentHead(g.graph, grantPod);
      // ★ PERMANENT, AND THE ACT THAT CLEARS IT USED TO BE BEHIND THE REFUSAL THIS FEEDS. A fork
      // is collapsed by one thing only: republishing the graph with `auto_supersede_prior`, which
      // writes a supersedes link to every prior descriptor naming it. In this package that is
      // `sendInvite` or `revokeGrant`, and while a short read refused every write in the workspace
      // both of those were refused too. Nothing waits this one out.
      if (h.forked) { m.why = "this grant's own chain has " + h.heads.length + ' unresolved heads, so which grant is current is not decided'; unreadHere(m, 'unestablished', 'permanent', 'republish'); continue; }
      if (!h.url) {
        // ★ TWO WORLDS BEHIND ONE MISSING URL, AND ONLY ONE OF THEM IS AN ANSWER. `absent` is the
        // relay stating that nothing is published at this name — the pod's own manifest enumerated
        // the grant graph and its head index has nothing at it. `unreadable` is an answer this
        // client could not interpret, which establishes nothing about the pod at all.
        //
        // ★ AND THEY CLASSIFY DIFFERENTLY FOR THE SAME REASON THEY READ DIFFERENTLY. A stated
        // absence is permanent — only a publish puts something at that name. An answer this client
        // cannot interpret says nothing about the pod, so nothing is claimed about repeating it.
        if ('unreadable' in h) { m.why = 'the current grant could not be resolved: ' + h.message; unreadHere(m, 'unestablished', 'unknown', 'read-again'); continue; }
        m.why = 'this grant has no current head: ' + h.message;
        unreadHere(m, 'answered', 'permanent', 'republish'); continue;
      }
      /**
       * ★★ A HEAD WITH A URL AND AN ERROR IS NOT A READABLE HEAD, AND THIS TOOK IT AS ONE.
       *
       * `HeadResult`'s readable variant carries `headError` for exactly this shape: the relay found
       * the head and could not fetch its body, so it reports a descriptor URL, NO cid, and a reason.
       * `readCanvas` checks this field and returns a distinct `head-unreadable` — the precedent is
       * one file away in this same package and was not applied here.
       *
       * ★ WHAT SKIPPING IT COST, and it is why the row is `unestablished` rather than a non-seat:
       * with `cid` null the acceptance tests below fell through to "their acceptance names this
       * grant's IRI and pins no revision this reader could compare", and `grantsRead` had ALREADY
       * been incremented — so an unreadable grant BODY silently unseated every member whose
       * acceptance uses the newer IRI+cid form, dropped them out of `shareWith`, left
       * `grantsFound === grantsRead` so the completeness guard could not fire, and blamed THEIR
       * acceptance for it in the sentence the roster shows.
       */
      if (h.headError) {
        m.why = "this grant's head is published and its body could not be fetched, so nothing about it was read "
          + 'from bytes anybody signed: ' + h.headError;
        // ★ TRANSIENT, AND IT IS THE ONE EXIT WHERE THE HEAD ITSELF IS EVIDENCE FOR THAT. The
        // relay found the head — so the chain is decided and something IS published at this name —
        // and only the fetch of its body came up short. That is the shape a cold pod and a storage
        // redeploy both take, and the same read repeated can succeed with nothing rewritten.
        unreadHere(m, 'unestablished', 'transient', 'read-again'); continue;
      }
      m.grantUrl = h.url;
      m.grantCid = h.cid;
      const d = await client.descriptor(h.url);
      const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', g.graph);
      // `region === null` is "not located"; `region === ''` is a block that WAS located and is
      // empty. Collapsing them reported a located region as missing.
      /**
       * ★★ PERMANENT, AND THIS IS THE LIVE-FLEET POPULATION RATHER THAN A FAULT CASE. The
       * descriptor was fetched in full and carries no signed block for this graph IRI, so no
       * repetition of any read changes the answer — only a republish does. `graphRegion` also
       * returns null for EMPTY content, and content is empty whenever the payload is sealed and
       * this reader cannot open it: `visibility.ts` records that grants and acceptances used to
       * map to `'shared'`, which in a private workspace sealed the convener's own founding grant
       * to the convener alone. Every workspace created that way folds, for every member except the
       * convener, with a grant that will never read — with no transport involved and nothing to
       * wait for.
       */
      if (region === null) { m.why = 'the signed region of this grant could not be located, so nothing about it was read from bytes anybody signed'; unreadHere(m, 'unestablished', 'permanent', 'republish'); continue; }
      /**
       * ★ THE GRANT IS READ — AND THAT IS WHAT THIS BOUNDARY CLAIMS, WHICH IS ALL IT MAY CLAIM.
       * Its bytes are in hand and its region is located, so every exit between here and the end of
       * the GRANT block is regex reading over a string already in memory.
       *
       * ★★ IT IS NOT A BOUNDARY ON THE WHOLE ROW, AND THE SENTENCE HERE USED TO SAY IT WAS — "no
       * exit after this point is a read that failed". Two network reads follow: the acceptance
       * lookup (`resolveMemberDoc`) and its descriptor. Their failures are real failed reads, they
       * do NOT decrement `grantsRead` — correctly, since the grant was read — and they are told
       * apart from conclusions by `basis`, which is what that job needed all along. A maintainer
       * deciding where the counter belongs reads this sentence first, so it had to stop being a
       * claim about a boundary it does not describe.
       *
       * ★★ A REVOKED GRANT AND A RETRACTED ONE BOTH COUNT. They were read perfectly; their
       * absence from the recipient set is a withdrawal stated by somebody entitled to state it,
       * not a hole in what this fold could see. Counting either as unread would make every
       * workspace that has ever revoked a member fail `grantsFound > grantsRead` forever, so the
       * refusal downstream would block every post in it — turning a guard against silent
       * eviction into a permanent outage. Same for a grantee whose WebID resolves to no pod: the
       * grant said who it names, and only this reader's mapping came up short.
       */
      grantsRead++;
      counted = true;
      /**
       * ★ `null` HERE IS "THIS READER MATCHED NO wsp:grantedTo", NOT "THE GRANT NAMES NOBODY", AND
       * THE DIFFERENCE DECIDED A WHOLE WORKSPACE. `readIri` matches two spellings of the predicate
       * — the literal `wsp:grantedTo` and the full `<…wsp#grantedTo>` — and only an IRIREF object.
       * A grant that binds the same namespace to a DIFFERENT PREFIX LABEL, or writes the grantee as
       * a PrefixedName, states the same triple and still lands here as null, because expanding
       * either would mean resolving a `@prefix` line that sits outside the region anybody signed.
       * Declining to resolve unsigned bytes is right; a caller treating the null as a finding ABOUT
       * the grant is not — `recipientsFromRoster` refused every write in the channel over one of
       * these rows for a round, and correct RDF was enough to trigger it. That refusal is gone.
       */
      m.grantedTo = readIri(region, 'wsp:grantedTo');
      m.role = readIri(region, 'wsp:role');
      m.grantAuthorship = d['authorship'] ?? null;
      m.revoked = hasTrue(region, 'wsp:revoked');
      m.grantStatus = readModalStatus(region);
      // ★ A GRANT ITS OWN AUTHOR HAS WITHDRAWN IS NOT A SEAT EITHER, AND IT IS NOT A REVOCATION.
      // The convener owns both spellings here — the grant is on their pod — but they are not the
      // same statement, so they do not collapse into one sentence. Tested before the grantee is
      // resolved, because a withdrawn record's other fields are not current claims.
      if (isRetracted(region)) {
        m.why = 'this grant states iep:modalStatus "' + String(m.grantStatus) + '", so the pod that published it has '
          + 'withdrawn it as an assertion. That is not the same as wsp:revoked — nobody unseated this member, the '
          + 'record naming them was retired — and either way it seats nobody now.';
        place(m, 'answered'); continue;
      }
    } catch (e) {
      // ★ THE ONE EXIT OF THE FIVE THAT CAN BE TRANSIENT — a cold pod is the case this whole
      // classification was written for, and `throwKind` is where that judgement is made rather
      // than left to a caller staring at an error string. It is a read that did not complete
      // either way, which is what `basis` says.
      m.why = 'the grant record could not be read: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code));
      // ★ AND ONLY WHEN THIS ROW HAS NOT ALREADY COUNTED. A throw after the increment — the grant
      // was read and something later in the row threw — must not appear in `unread`, or the
      // invariant the whole per-verb policy rests on stops holding for that fold.
      if (counted) place(m, 'unestablished', throwKind(e));
      else unreadHere(m, 'unestablished', throwKind(e), 'read-again');
      continue;
    }

    const pod = podOfWebid(m.grantedTo);
    m.pod = pod;
    // ★ TWO FACTS, AND THIS ROW USED TO STATE THE SECOND FOR BOTH. "A grantee was read and this
    // reader cannot map it to a pod" and "no grantee was read at all" are different reports about
    // different documents, and `why` is the field that says which — it is what both shells print
    // under a seat that did not fold. Saying "the grantee is named by an identifier" about a
    // region no identifier was read out of names something that was never read, and this row is
    // now the whole of what a caller is told, since the plan no longer refuses over it.
    if (!pod) {
      m.why = m.grantedTo
        ? 'the grantee is named by an identifier this reader cannot resolve to a pod: ' + m.grantedTo
        : 'no wsp:grantedTo was read out of this grant\'s signed region, in either of the two spellings this '
          + 'reader matches, so who it seats is not established here. The grant may still name somebody: a '
          + 'binding of the same namespace to another prefix label reads exactly like this.';
      // ★ ANSWERED EITHER WAY, AND FOR THE REASON THE COUNTER GIVES ONE PARAGRAPH UP: the grant's
      // own bytes were read. Whichever of the two sentences applies, nothing about this row is
      // waiting on a network — only on a mapping this reader does not have, or on a grant that has
      // to be rewritten before any reader could use it.
      place(m, 'answered'); continue;
    }

    // ★ A REVOKED GRANT IS NOT A SEAT. This used to add a grey chip and carry on: the member
    // stayed seated, kept a live watch on their stream, kept rendering messages, and still
    // counted. Revocation stops the fold here. What they already wrote is untouched — it is on
    // their pod and revocation cannot reach it — and the row says exactly that.
    if (m.revoked) {
      m.why = 'this grant was revoked. Their stream is not folded into the channel and they are not counted. '
        + 'What they already wrote is unaffected: it lives on their own pod, and revoking a grant cannot reach it.';
      // Answered by the convener, on the convener's own pod, in bytes this fold read.
      place(m, 'answered'); continue;
    }

    /**
     * ★ OUTSIDE THE TRY, AND THAT IS THE SAFE SIDE RATHER THAN AN OVERSIGHT. A throw here aborts
     * the WHOLE fold instead of marking one row, and aborting is the answer this class wants: the
     * desktop's `loadRoster` leaves the previous `S.fold` standing on a throw, so a caller keeps
     * the roster it last established rather than acting on a shorter one. Marking a single row and
     * carrying on would hand every consumer a roster that is quietly missing somebody.
     *
     * It does not throw today — `resolveMemberDoc` wraps every candidate probe in its own try and
     * records the failure as an outcome — so this is a statement about which behaviour is wanted
     * if that ever changes, not a claim that the abort happens.
     */
    const found = await client.resolveMemberDoc(pod, args.iriOwner, args.slug, 'acceptance');
    m.acceptIri = found.iri;
    m.acceptNaming = found.naming;
    try {
      // ★ PERMANENT, for the same reason a forked GRANT is: a fork is collapsed by a republish
      // with `auto_supersede_prior` and by nothing else. Waiting is not one of the acts available.
      if (found.forked) { m.why = "this member's acceptance has " + found.forked.heads.length + ' unresolved heads'; place(m, 'unestablished', 'permanent'); continue; }
      if (!found.found || !found.head) {
        /**
         * ★★ "NOBODY HAS ACCEPTED" IS A CLAIM ABOUT SOMEBODY ELSE'S POD, so it is made only when
         * every name this reader looks under answered that nothing is there. `resolveMemberDoc`
         * probes two — the qualified name and the legacy one — and reports each separately, so
         * this can require ALL of them to have STATED an absence rather than inferring it from an
         * error string being empty. It used to read `!found.error`, and an `Error('')` from either
         * probe is falsy: that put `pending: true` on a member whose pod never answered, which is
         * the reseal audience deciding somebody is merely slow on the strength of a failed read.
         */
        const statedAbsent = found.candidates.every((c) => c.outcome === 'absent');
        m.why = statedAbsent
          ? 'granted, but no acceptance published on their pod yet'
          : 'their acceptance could not be resolved: ' + (found.error ?? found.primary.message ?? 'the read did not complete');
        m.pending = statedAbsent;
        // ★ SPLIT RATHER THAN A TERNARY, because the two arms no longer carry the same amount of
        // information: an unestablished row has to say whether repeating the probe could help, and
        // `acceptanceReadKind` reads that off the outcomes `resolveMemberDoc` recorded per name
        // instead of leaving a caller to guess it from an error string.
        if (statedAbsent) place(m, 'answered');
        else place(m, 'unestablished', acceptanceReadKind(found.candidates));
        continue;
      }
      const ad = await client.descriptor(found.head.url);
      const region = graphRegion((ad['graph'] as { content?: string } | undefined)?.content ?? '', found.iri);
      // ★ PERMANENT: the descriptor was fetched in full and carries no signed block under this
      // IRI, so no repetition of any read changes the answer — only a republish of the acceptance
      // does. Same judgement, same words, as the grant half's region exit.
      if (region === null) { m.why = 'the signed region of their acceptance could not be located, so no seat will be read out of it'; place(m, 'unestablished', 'permanent'); continue; }
      m.acceptStatus = readModalStatus(region);
      // ★ AND THE MEMBER'S OWN HALF, WHICH ONLY THEY CAN WITHDRAW. Their acceptance is on their
      // pod under their signature; retiring it is how somebody leaves a room without asking the
      // convener's permission, and a fold that ignored it kept folding their log in after they
      // had said they were done. Said as its own reason, never as "their acceptance is malformed".
      if (isRetracted(region)) {
        m.why = 'their acceptance states iep:modalStatus "' + String(m.acceptStatus) + '", so they have withdrawn it '
          + 'on their own pod. The grant naming them still stands; what they retired is their own half of the seat.';
        // Their own withdrawal, on their own pod, in bytes this fold read.
        place(m, 'answered'); continue;
      }
      m.acceptUrl = found.head.url;
      // The pod the acceptance was actually SERVED from, and its base URL. Everything
      // downstream that needs to address this member's storage uses these rather than a name
      // composed from the viewer's own host.
      m.podServed = podOfDescriptorUrl(found.head.url);
      m.podBase = podBaseOfDescriptorUrl(found.head.url);
      m.stream = readIri(region, 'wsp:stream');
      // Same region, same read as everything else the acceptance asserts about itself.
      m.encryptionKey = readLiteral(region, 'wsp:encryptionKey');
      m.accepts = readIri(region, 'wsp:accepts');
      m.acceptsCid = readLiteral(region, 'wsp:acceptsCid');
      const auth = ad['authorship'] as { signedBy?: string; authorshipVerified?: boolean } | undefined;
      m.memberAgent = auth?.signedBy ?? null;
      m.memberAgentVerified = !!auth?.authorshipVerified;
      m.acceptAuthorship = ad['authorship'] ?? null;

      // ★ WHICH GRANT THIS ACCEPTANCE IS AN ACCEPTANCE OF. Two forms, both accepted, and which
      // test ran is recorded.
      //  · The older one names the grant's DESCRIPTOR URL. Equality with the current head's
      //    descriptor is the whole check: republish the grant and a stale acceptance stops
      //    matching.
      //  · The newer one names the grant's own /ns/ IRI — a URL anybody can open — and pins the
      //    revision separately in wsp:acceptsCid. An IRI match with NO cid is NOT accepted as a
      //    seat: the IRI alone never changes, so it could not detect a re-grant.
      if (m.accepts && m.accepts === m.grantUrl) {
        m.acceptTest = "the acceptance names the grant's descriptor URL, and it is the one currently at the head";
      } else if (m.accepts && m.accepts === m.graph && m.acceptsCid && m.grantCid && m.acceptsCid === m.grantCid) {
        // ★ THE TWO REVISIONS ARE NAMED, not just compared. A reader deciding whether to
        // believe a seat needs the pair in front of them; "the revision that is the head" is
        // this fold asserting its own conclusion and showing none of the evidence for it.
        m.acceptTest = "the acceptance names the grant's IRI and pins revision " + shortRef(m.acceptsCid) + ', which is the head';
      } else if (m.accepts && m.accepts === m.graph && m.acceptsCid && m.grantCid) {
        m.why = 'their acceptance names this grant but pins revision ' + shortRef(m.acceptsCid)
          + ', and the current head of the grant is ' + shortRef(m.grantCid)
          + '. The grant was republished after they accepted it, so what they agreed to is not what is there now.';
        place(m, 'answered'); continue;
      } else if (m.accepts && m.accepts === m.graph) {
        m.why = "their acceptance names this grant's IRI and pins no revision this reader could compare"
          + (m.grantCid ? '' : ', and the head read reported no CID for the grant either')
          + ', so it cannot be told apart from an acceptance of a grant that has since been rewritten';
        place(m, 'answered'); continue;
      } else {
        m.why = m.accepts
          ? 'their acceptance names a different grant than the one current here'
          : 'their acceptance names no wsp:accepts, so there is nothing to hold against the grant';
        place(m, 'answered'); continue;
      }
      if (!m.stream) { m.why = 'their acceptance names no stream'; place(m, 'answered'); continue; }

      // ★ A LOG BELONGS TO THE POD THAT OWNS IT. `wsp:stream` is a value in a document the
      // MEMBER wrote, so it is checked rather than believed.
      m.streamPod = podOfNsIri(m.stream);
      if (m.streamPod && m.streamPod !== pod) {
        m.why = 'their acceptance names a stream under pod ' + m.streamPod + ', which is not the pod their own grant '
          + 'names (' + pod + "). A member's log is on their own pod, so no log they point at somebody else's storage for is folded in.";
        place(m, 'answered'); continue;
      }
      m.seated = true;
      // ★ THE FOUR EXITS ABOVE ARE ANSWERS AND THIS ONE IS TOO. Every one of them read the
      // acceptance's own signed bytes and found something in them that does not seat — a stale
      // pin, no `wsp:accepts`, no stream, a stream under another pod. A caller may act on any of
      // them; the catch below is the one arm of this block it may not act on.
      place(m, 'answered'); continue;
    } catch (e) {
      m.why = 'the acceptance could not be read: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code));
      // The same `code`-based reading the grant half's catch takes — see `throwKind`. A cold pod
      // is the case this classification exists for, and it is the one that clears on its own.
      place(m, 'unestablished', throwKind(e)); continue;
    }
  }

  // Two seats resolving to the same log are ONE log. Folding it twice would double every
  // message in it and count the same author twice.
  //
  // ★ AND UN-SEATING HERE LEAVES `basis` AT `'answered'`, WHICH IS CORRECT AND NOT AN OVERSIGHT.
  // Both rows were read in full — that is how this pass knows they name the same `wsp:stream` —
  // so this is a conclusion drawn from bytes, exactly like a stale pin, and a consumer may act on
  // it. Nothing here re-classifies a row, because nothing here reads.
  const seenLog = new Map<string, Seat>();
  for (const m of seats) {
    if (!m.seated) continue;
    const k = m.pod + ' ' + String(m.stream);
    if (!seenLog.has(k)) { seenLog.set(k, m); continue; }
    m.seated = false;
    m.why = 'another current grant on this roster already seats pod ' + m.pod + ' with the same wsp:stream, so this '
      + 'grant would fold the same log into the channel a second time. The log itself is shown once, under the first '
      + 'of the two; this row is not a claim that they wrote nothing.';
  }

  /**
   * ★★ THE GRANTS THE CAP NEVER REACHED ARE UNREAD TOO, AND THEY ARE THE HALF WITH NO ROW.
   *
   * `grantsFound > grantsRead` has always been true for a truncated fold as well as for a failed
   * one, so a consumer reading `unread` instead of the pair would have seen an empty array for a
   * roster that is missing whole members — the absence of a finding read as a finding, one more
   * time. These rows carry the graph and therefore the pod, so a reseal can include them exactly
   * as it includes a grant whose bytes would not read.
   *
   * ★ `'transient'` BECAUSE NOTHING ABOUT THE DOCUMENT FAILED. This fold never asked. A fold with
   * a larger `readCap` reaches it and the same read succeeds, which is the definition the type
   * gives — and it is what keeps a reseal refusing here, correctly: a fold that did not look at a
   * member's grant must not republish a recipient set without them.
   *
   * ★★ AND `clears` IS `'fold-more'`, WHICH IS THE HALF `kind` CANNOT CARRY. A consumer holding
   * only the kind printed "read the members list again and retry" over these rows, and re-folding
   * with the same cap truncates at exactly the same place — a refusal advertising an exit that is
   * a measured no-op, on a workspace that then cannot be invited to at all. The act that clears
   * this one is naming a bigger `readCap`, and it is the row that says so.
   */
  for (const g of ordered.slice(grantReadCap)) {
    unread.push({
      graph: g.graph, pod: podOfGrantGraph(g.graph, args.workspace), kind: 'transient', clears: 'fold-more',
      why: 'this fold read ' + grantReadCap + ' of the ' + grantsFound + ' grants on ' + grantPod
        + ' and stopped before this one, so it was never asked for. Nothing is known about it '
        + 'beyond the pod its name carries.',
    });
  }

  return {
    seats,
    grantPod,
    grantPodDerivedFrom: args.convenerPod ? 'wsp:convener in the record' : null,
    grantsFound,
    grantsRead,
    // ★ `grantsRead === grantsFound - unread.length` — see the field. Every exit above that skips
    // the counter pushes exactly one row here, and the loop just above covers the grants the cap
    // never reached; `tests/workspace-recipients.test.ts` pins the identity at each exit
    // separately, because the previous round proved that pinning one exit leaves the others free.
    unread,
    grantReadCap,
  };
}
