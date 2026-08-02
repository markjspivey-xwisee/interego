/**
 * The composed view: many members' streams, on many pods, read as one workspace.
 *
 * ── WHAT COMPOSITION CAN AND CANNOT PROMISE ──────────────────────────────────
 *
 * A single-relay design can total-order every message, because one server assigns the
 * order. This design cannot, and the honest thing is to say so in the type rather than
 * produce a confident sequence out of clocks nobody controls.
 *
 * So the composed view carries TWO grades of ordering, and never conflates them:
 *
 *   within a stream    VERIFIED. Every entry declares its predecessor; the chain is walked
 *                      and checked. Reordering it would require forging a descriptor.
 *
 *   across streams     ADVISORY. Merged on `validFrom`, tie-broken by content-CID so the
 *                      result is at least deterministic. Two members' clocks can disagree,
 *                      and no amount of merging fixes that. Anything that depends on
 *                      "A happened before B" across members must say so in the DATA — an
 *                      entry citing another entry is a fact; adjacency in this list is not.
 *
 * Presenting an advisory order as a verified one is the failure mode worth designing
 * against: it is invisible, it is convincing, and it turns a merged feed into evidence it
 * cannot support.
 *
 * ── AND TWO GRADES OF ATTRIBUTION, FOR THE SAME REASON ───────────────────────
 *
 * `ComposedEntry.principal` was a LABEL attached from the members list. Nothing in the read
 * path derived it, so the confident-looking name beside every entry rested on whoever
 * assembled the inputs. The grades are:
 *
 *   asserted   the label, plus the pod-containment check below. Cheap, and it establishes
 *              only that the record is served from under `member.podUrl` — the URL THE
 *              CALLER SUPPLIED for this member, which in this design comes from the same
 *              acceptance that supplied `member.stream`. It is NOT a check that the pod
 *              belongs to the member: point `podUrl` and `stream` both at a victim and the
 *              containment passes, so a member with `append` can still fold a member without
 *              it into their own entries. Four places in this file said "that member's own
 *              pod", which is the claim, not the check.
 *   attested   every admitted entry's `iep:authorshipProof` was re-verified by the substrate
 *              and traced to an agent the named principal vouches for. One `get_descriptor`
 *              PER ENTRY, which is a real cost against a design whose headline is "catch-up
 *              is one read per member" — so it is asked for explicitly, and
 *              {@link ComposedView.descriptorReads} reports what it actually spent.
 *
 * {@link ComposedView.attributionGrade} is non-omittable for the same reason
 * `crossStreamOrderIsAdvisory` is: `entries` cannot be reached without the claim about what
 * the names on it are worth.
 *
 * ── PARTIAL AVAILABILITY IS THE POINT, SO IT MUST BE VISIBLE ─────────────────
 *
 * When the single relay is down, a one-relay workspace is entirely gone. Here, one
 * member's pod being unreachable costs exactly that member's entries. That is a real
 * advantage and a real hazard: a view that silently omits an unreachable member looks
 * complete, and someone reads a workspace missing a third of its content without knowing.
 *
 * So `unavailable` is a first-class part of the result, `complete` is a boolean anyone can
 * branch on, and a failed stream is never merged as an empty one.
 *
 * Nor is a stream whose read came back carrying somebody else's records. Zero entries out of
 * zero records is an idle member; zero out of N is a read that landed somewhere unexpected,
 * and `unmatched` keeps the two apart — see {@link ComposedView.unmatched}.
 *
 * ── POLY-VERTICAL BY CITATION ────────────────────────────────────────────────
 *
 * A `wsp:Reference` names a record in another vertical — a Foxxi credential, an `agp:`
 * plan, an A2A engagement — by its own IRI. Nothing is copied. The cited record keeps its
 * authorship, its shape and its access control, which is exactly why the two cannot drift
 * apart. {@link resolveCitations} reports whether each cited IRI is reachable and what it
 * says it is; it does not import it, and a citation that cannot be resolved is reported
 * as unresolved rather than dropped.
 */

import {
  readStream, verifyChain, readAttestation,
  type StreamDeps, type StreamRow, type ChainReport,
} from './stream.js';
import { refuseAttestation, signerIsSelf, type AttributionGrade, type SignerResolver } from './roster.js';

/** A member as the composed view needs them: a principal and the stream they registered. */
export interface ComposableMember {
  readonly principal: string;
  readonly stream: string;
  /** Pod to read the stream from. Different members are on different pods — the point. */
  readonly podUrl: string;
}

/** One entry in the merged feed, still attributed to the stream it came from. */
export interface ComposedEntry {
  readonly principal: string;
  readonly stream: string;
  readonly descriptorUrl: string;
  readonly cid: string | null;
  readonly validFrom: string | null;
  /** Position within its OWN stream, where order is verified. */
  readonly seqInStream: number;
}

export interface StreamOutcome {
  readonly member: ComposableMember;
  readonly rows: number;
  readonly report: ChainReport;
}

export interface UnavailableStream {
  readonly member: ComposableMember;
  readonly reason: string;
}

/** Entries a member's stream pointed at but which are not served from under `member.podUrl`. */
export interface MisattributedEntries {
  readonly member: ComposableMember;
  readonly descriptorUrls: readonly string[];
  readonly reason: string;
  /**
   * Whether removing these rows is itself the reason this member's stream failed to verify.
   *
   * ★ A foreign row in the MIDDLE of an intact chain leaves the rows either side of it
   * pointing at something no longer present, so the member was reported twice for one fact —
   * once in `misattributed` and once in `unverified`, the second reading as "this member's
   * log is forked" when it is not. Set here so the second report can be read as the
   * consequence it is.
   */
  readonly brokeTheChain: boolean;
}

/** A member's pod answered, served records, and none of them were records of this stream. */
export interface UnmatchedStream {
  readonly member: ComposableMember;
  /** How many records the pod served before the stream filter discarded every one of them. */
  readonly served: number;
  readonly reason: string;
}

/** Entries withheld because their authorship could not be traced to the member named. */
export interface UnattestedEntries {
  readonly member: ComposableMember;
  readonly entries: readonly {
    readonly descriptorUrl: string;
    /** Position in the member's own verified chain — kept, so the gap is visible. */
    readonly seqInStream: number;
    readonly because: string;
  }[];
}

/**
 * Is this descriptor served from within this pod?
 *
 * Origin AND path prefix, not origin alone: two members can legitimately share a host
 * (the same CSS serves every pod on this deployment), so origin-only containment would
 * let any member on that host claim any other's entries. Compared on the normalised
 * pod path, so a missing trailing slash is not a bypass.
 *
 * ★ It answers about a URL, not about ownership. Nothing here establishes that `podUrl`
 * belongs to the member it was passed for — that is the caller's claim, and in this design
 * it arrives from the same acceptance as the stream. See the module note.
 */
export function isUnder(descriptorUrl: string, podUrl: string): boolean {
  try {
    const d = new URL(descriptorUrl);
    const p = new URL(podUrl.endsWith('/') ? podUrl : `${podUrl}/`);
    if (d.origin !== p.origin) return false;
    return d.pathname.startsWith(p.pathname);
  } catch {
    // An unparseable URL is not under anything. Refusing is the safe direction: the
    // alternative admits a record whose location we could not determine.
    return false;
  }
}

export interface ComposedView {
  readonly workspace: string;
  /**
   * Every entry from every reachable stream, in ADVISORY order. See the module note: the
   * order within each stream is verified, the order between them is a merge on timestamps
   * from clocks this system does not control.
   */
  readonly entries: readonly ComposedEntry[];
  /** Per-stream results, so a caller can see which member contributed what. */
  readonly streams: readonly StreamOutcome[];
  /** Members whose stream could not be read. Never silently merged as empty. */
  readonly unavailable: readonly UnavailableStream[];
  /** Streams that were read but do not verify — a fork, a merge, a missing link. */
  readonly unverified: readonly StreamOutcome[];
  /**
   * Entries a member's stream pointed at that are NOT served from under `member.podUrl`.
   *
   * ★ Withheld rather than attributed. A stream IRI is chosen by the member in their own
   * acceptance, so treating "their stream pointed at it" as "they wrote it" lets anyone
   * claim anyone else's records — including, in the case that found this, laundering an
   * Observer's writes into a Contributor's entries.
   *
   * ★ And it catches only records outside the SUPPLIED pod URL. When `podUrl` and `stream`
   * both came from the attacker's own acceptance they name the same place, the containment
   * passes, and this list is empty while the laundering succeeds. Only
   * `verifyAuthorship: true` closes that one.
   */
  readonly misattributed: readonly MisattributedEntries[];
  /**
   * Members whose pod answered and served records, not one of which was this member's.
   *
   * ★ This is the unreachable-member-rendered-as-idle failure again, one filter downstream
   * of the guards that closed it. `readStream` throws on the three shapes a FAILED read
   * takes and then discards every row whose `describes` does not name the stream — so a
   * manifest served without `describes`, or under a stream IRI differing by a trailing
   * slash, arrives as zero rows and used to be reported as "this member has written
   * nothing", `complete: true`.
   *
   * Zero rows out of zero records is that claim and it is fine. Zero rows out of N records
   * is not: the read reached a pod that had something to say and none of it was this
   * stream's, which is a misconfiguration or a wrong stream IRI, not an idle member.
   */
  readonly unmatched: readonly UnmatchedStream[];
  /**
   * Entries withheld because the substrate could not trace their authorship to the member
   * they would have been attributed to.
   *
   * ★ Withheld AND reported, never one or the other. Admitting them is the defect this
   * exists to close; dropping them silently would make a workspace someone has been
   * writing forged entries into render exactly like a quiet one. Always empty when
   * `attributionGrade` is `'asserted'` — nothing was checked, so nothing could fail.
   */
  readonly unattested: readonly UnattestedEntries[];
  /**
   * True only when every member's stream was read AND verified. A caller that renders a
   * workspace without checking this shows a partial view as a whole one.
   */
  readonly complete: boolean;
  /**
   * Always true, and deliberately not omittable. It is here so that anything consuming
   * `entries` has to have seen the claim that their relative order across members is a
   * merge, not a fact.
   */
  readonly crossStreamOrderIsAdvisory: true;
  /**
   * Which grade of attribution the names on `entries` carry — see the module note.
   *
   * Non-omittable for the same reason as the field above it. `'asserted'` is the default
   * and is not a failure; it is an honest label on a cheap read, and it says the principal
   * beside each entry came from the caller's own members list rather than from the record.
   */
  readonly attributionGrade: AttributionGrade;
  /**
   * How many `get_descriptor` calls this composition actually made — zero unless authorship
   * was verified, then one per entry that reached the check.
   *
   * ★ Reported rather than left to be inferred from the flag. The README publishes "one
   * manifest read per member" as this design's price, and verification multiplies it by the
   * number of entries; a cost that large has to be countable by whoever turned it on, not
   * described.
   */
  readonly descriptorReads: number;
}

/**
 * Read every member's stream and merge them.
 *
 * ★ `Promise.allSettled`, not `Promise.all`. With `all`, one member's pod being slow or
 * gone rejects the whole composition and the workspace disappears — which would hand back
 * exactly the single-point-of-failure this design exists to avoid, just relocated to
 * whichever member happens to be down.
 */
export async function composeWorkspace(
  args: {
    readonly workspace: string;
    readonly members: readonly ComposableMember[];
    /**
     * Verify every entry's `iep:authorshipProof` before admitting it. Costs one
     * `get_descriptor` per entry and needs `deps.getDescriptor`; without it the read
     * refuses rather than quietly returning an unverified view.
     */
    readonly verifyAuthorship?: boolean;
    /**
     * Who a signature's agent DID acts for. Defaults to identity, which is right only when
     * principals sign as themselves — a person's principal is a WebID and their signer is an
     * agent DID, so a real deployment passes `signerIndexFromRegistry(...)` from `can.ts`.
     */
    readonly signerOf?: SignerResolver;
  },
  deps: StreamDeps,
): Promise<ComposedView> {
  const verifyAuthorship = args.verifyAuthorship === true;
  const signerOf = args.signerOf ?? signerIsSelf;
  // ★ A STREAM IRI IS A LOGICAL NAME, NOT A STORAGE PATH — so it cannot be range-checked.
  //
  // The first attempt at defending attribution required `member.stream` to be under
  // `member.podUrl`. It rejected every real member on the first live run: a stream's graph
  // IRI lives under the relay's naming authority (`…/ns/<owner>/<workspace>/stream/alice`)
  // while its entries are stored on a pod (`…/u-eth-…/context-graphs/…`). Those are
  // deliberately different — the substrate's whole `graph_iri` vs `descriptorUrl`
  // distinction — and conflating them is a category error, not a check.
  //
  // What CAN be checked is where each returned record is actually served from, which is
  // done per row below. A member's acceptance can name any graph IRI it likes; it cannot
  // make somebody else's pod serve a record, and it cannot make a record served from
  // somebody else's pod count as theirs.
  const settled = await Promise.allSettled(
    args.members.map(async member => {
      // ★ HOW MANY RECORDS THE POD SERVED, NOT JUST HOW MANY SURVIVED THE FILTER.
      //
      // `readStream` guards the three shapes a failed read takes and then keeps only rows
      // whose `describes` names this stream — and returns the survivors alone. So "the pod
      // holds nothing" and "the pod holds records, none of them this stream's" reach this
      // loop as the same empty array, and the second was rendered as an idle member with
      // `complete: true`. That is the unreachable-as-idle failure the read guards exist to
      // close, one filter further down.
      //
      // The count is taken by observing the read `readStream` already makes. Reading twice
      // would double the per-member manifest read this whole design is costed on, and
      // re-filtering here would put a second copy of the check beside the one that carries
      // the guards, where the two can drift apart without anyone noticing which won.
      const responses: Record<string, unknown>[] = [];
      const rows = await readStream(
        { graphIri: member.stream, workspace: args.workspace, podUrl: member.podUrl },
        {
          ...deps,
          discover: async a => {
            const res = await deps.discover(a);
            responses.push(res);
            return res;
          },
        },
      );
      // The LAST response is the one the rows came from. `null` when the shape carried no
      // entries array at all — in which case `readStream` has already thrown and this
      // member is unavailable, so there is nothing to draw a conclusion from.
      const served = responses[responses.length - 1]?.entries;
      return { member, rows, served: Array.isArray(served) ? served.length : null };
    }),
  );

  const streams: StreamOutcome[] = [];
  const unavailable: UnavailableStream[] = [];
  const misattributed: MisattributedEntries[] = [];
  const unmatched: UnmatchedStream[] = [];
  const unverified: StreamOutcome[] = [];
  const unattested: UnattestedEntries[] = [];
  const entries: ComposedEntry[] = [];
  let descriptorReads = 0;

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]!;
    const member = args.members[i]!;

    if (outcome.status === 'rejected') {
      unavailable.push({
        member,
        reason: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      continue;
    }

    const rows: readonly StreamRow[] = outcome.value.rows;
    const served: number | null = outcome.value.served;

    // ★ AN ENTRY MUST LIVE WHERE ITS AUTHOR'S STREAM LIVES.
    //
    // `principal` below is a LABEL this function attaches from the members list — it is
    // not read from the record, and nothing in the read path derives authorship. An
    // independent review turned that into a live escalation: a member's acceptance names
    // the stream IRI, and nothing required that IRI to be under their own authority. Point
    // it at somebody else's pod and their entries get folded in ATTRIBUTED TO YOU, so an
    // Observer's writes are admitted as a Contributor's — and with the recommended
    // pre-filter they are not even reported as disallowed, because the Observer's own pod
    // is never read.
    //
    // The check that can be made here is containment: a descriptor served from outside the
    // pod URL this member's stream was read from is not admitted as this member's entry. It
    // is NOT a check that the pod is theirs — `podUrl` is the caller's claim and in this
    // design comes from the same acceptance as `stream`, so pointing both at a victim
    // passes. It is not a substitute for verifying the descriptor's own authorship proof
    // either; it turns one silent cross-attribution into a visible one, and that is all.
    const foreign = rows.filter(r => !isUnder(r.descriptorUrl, member.podUrl));
    const own = rows.filter(r => isUnder(r.descriptorUrl, member.podUrl));

    const report = verifyChain(own);
    const record: StreamOutcome = { member, rows: own.length, report };
    streams.push(record);

    if (foreign.length > 0) {
      // ★ ONE FAULT, REPORTED ONCE, WITH THE SECOND REPORT LABELLED AS ITS CONSEQUENCE.
      // Stripping a foreign row from the middle of a chain leaves its neighbours pointing at
      // a row that is no longer there, so the member landed in `unverified` as well and the
      // coverage line said their log was read but not verified. Their log is fine; this
      // filter broke it. Reported rather than papered over — the entries really are withheld.
      const stripped = new Set(foreign.map(r => r.descriptorUrl));
      const brokeTheChain = !report.intact
        && report.danglingLinks.length > 0
        && report.danglingLinks.every(d => stripped.has(d.missing));
      misattributed.push({
        member,
        descriptorUrls: foreign.map(r => r.descriptorUrl),
        brokeTheChain,
        reason:
          `${foreign.length} entr${foreign.length === 1 ? 'y is' : 'ies are'} served from outside `
          + `<${member.podUrl}>, the pod URL this member's stream was read from. They are withheld: `
          + 'attributing a record to a principal because their acceptance pointed at it would let '
          + 'anyone claim records written by anyone else.'
          + (brokeTheChain
            ? ' Removing them also broke this member\'s chain, which is why the stream is '
              + 'reported as unverified as well — every missing link points at a row this '
              + 'filter withheld, so the member\'s own log is not forked.'
            : ''),
      });
    }

    // ★ ZERO ROWS OUT OF ZERO RECORDS IS AN IDLE MEMBER; ZERO OUT OF N IS NOT.
    //
    // Tested on `rows`, before the pod-containment split, because entries dropped for
    // being served from elsewhere are already named in `misattributed` — reporting the
    // same member twice for one fact makes the count of what is wrong unreadable.
    //
    // Only the suspicious direction is reported. Flagging a genuinely empty pod too would
    // make `complete` false for every workspace holding a member who has not written yet,
    // and a flag that is always false is a flag nobody reads.
    if (rows.length === 0 && served !== null && served > 0) {
      unmatched.push({
        member,
        served,
        reason:
          `<${member.podUrl}> served ${served} record${served === 1 ? '' : 's'} and not one of them `
          + `is a record of <${member.stream}>. This is NOT "the member has written nothing": the `
          + 'read reached a pod that had something to say and none of it was this stream — a wrong '
          + 'or renamed stream IRI, a trailing-slash mismatch, or a manifest carrying no `describes` '
          + 'at all. Rendering it as an idle member is the unreachable-as-idle failure again, one '
          + 'filter downstream of the guards that close it.',
      });
    }

    // An empty stream is a member who has not written yet — normal, and not an error.
    if (own.length === 0) continue;

    if (!report.intact) {
      // ★ Contributed to `unverified` but NOT to `entries`. Merging a forked stream would
      // put entries in a feed whose order within that member is unknown, and the reader
      // could not tell those apart from the verified ones sitting next to them.
      unverified.push(record);
      continue;
    }

    // ★ THE ATTRIBUTION GATE, PER ENTRY, AFTER THE CHAIN VERIFIES.
    //
    // Ordered last on purpose. A stream that does not verify is withheld whole, so paying a
    // `get_descriptor` for each of its entries would spend the expensive check on records
    // that were never going to be admitted — and would report them under two different
    // headings for one fault.
    //
    // `seqInStream` is the position in the member's own VERIFIED chain, and a withheld entry
    // keeps its number rather than the survivors being renumbered. Renumbering would close
    // the gap over a record the reader is entitled to know is missing.
    //
    // Unthrottled `Promise.all`, and members are already fanned out in parallel above, so a
    // verified catch-up issues members × entries requests at once. That is stated rather
    // than smoothed over: a limiter here would hide the cost behind latency instead of
    // reducing it, and `descriptorReads` is what makes the real number arguable.
    const attestations = verifyAuthorship
      ? await Promise.all(report.ordered.map(async row => {
          descriptorReads++;
          return readAttestation(row.descriptorUrl, deps);
        }))
      : null;
    const withheld: { descriptorUrl: string; seqInStream: number; because: string }[] = [];

    report.ordered.forEach((row, seqInStream) => {
      if (attestations !== null) {
        const because = refuseAttestation(attestations[seqInStream], member.principal, signerOf);
        if (because !== null) {
          withheld.push({ descriptorUrl: row.descriptorUrl, seqInStream, because });
          return;
        }
      }
      entries.push({
        principal: member.principal,
        stream: member.stream,
        descriptorUrl: row.descriptorUrl,
        cid: row.cid,
        validFrom: row.validFrom,
        seqInStream,
      });
    });

    if (withheld.length > 0) unattested.push({ member, entries: withheld });
  }

  return {
    workspace: args.workspace,
    entries: mergeAdvisory(entries),
    streams,
    unavailable,
    unverified,
    misattributed,
    unmatched,
    unattested,
    complete:
      unavailable.length === 0
      && unverified.length === 0
      && misattributed.length === 0
      && unmatched.length === 0
      // An entry whose author cannot be established is the same class of gap as one served
      // from the wrong pod: the view is missing something it was asked to render and cannot
      // honestly say what. Left out of `complete`, a workspace being written into by
      // somebody unidentifiable would still report itself whole.
      && unattested.length === 0,
    crossStreamOrderIsAdvisory: true,
    attributionGrade: verifyAuthorship ? 'attested' : 'asserted',
    descriptorReads,
  };
}

/**
 * Merge entries from different streams into one advisory order.
 *
 * Timestamp first, then content-CID, then descriptor URL. The tie-breaks are not
 * cosmetic: without a total order the same inputs would render differently on each read,
 * and a feed that reshuffles between refreshes is one people stop trusting for reasons
 * they cannot articulate. Deterministic-but-approximate beats arbitrary.
 *
 * An entry with no `validFrom` sorts last rather than first. Missing is not early: placing
 * an undated entry at the top of a feed asserts a recency nothing supports.
 */
function mergeAdvisory(entries: readonly ComposedEntry[]): ComposedEntry[] {
  return [...entries].sort((a, b) => {
    if (a.validFrom !== b.validFrom) {
      if (a.validFrom === null) return 1;
      if (b.validFrom === null) return -1;
      return a.validFrom < b.validFrom ? -1 : 1;
    }
    const ac = a.cid ?? '';
    const bc = b.cid ?? '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    return a.descriptorUrl < b.descriptorUrl ? -1 : a.descriptorUrl > b.descriptorUrl ? 1 : 0;
  });
}

// ── Citations into other verticals ───────────────────────────────────────────

export interface Citation {
  /** The workspace entry that cites. */
  readonly from: string;
  /** The foreign record cited, by its own IRI. */
  readonly iri: string;
  readonly resolved: boolean;
  /** What the cited record says it is, when it could be read. Never inferred from the IRI. */
  readonly types?: readonly string[];
  readonly reason?: string;
}

/**
 * Check that citations into other verticals actually resolve — without importing them.
 *
 * ★ The temptation is to copy the cited record into the workspace so the view is
 * self-contained. That is what makes a system stop being poly-vertical: the copy has no
 * authorship of its own, is not covered by the source's shape, does not honour the
 * source's access control, and starts drifting the moment the source is superseded. A
 * citation that resolves is worth more than a copy that cannot be checked.
 *
 * ★ Unresolvable citations are REPORTED, never dropped. A dropped citation makes an entry
 * that cited something indistinguishable from one that cited nothing, and "the workspace
 * references a Foxxi credential nobody can currently read" is exactly the fact a reader
 * needs. Per-citation isolation for the same reason as the streams: one dead link must not
 * cost the others.
 */
export async function resolveCitations(
  citations: readonly { readonly from: string; readonly iri: string }[],
  fetchIri: (iri: string) => Promise<{ readonly types?: readonly string[] } | null>,
): Promise<readonly Citation[]> {
  const settled = await Promise.allSettled(citations.map(c => fetchIri(c.iri)));
  return citations.map((c, i) => {
    const s = settled[i]!;
    if (s.status === 'rejected') {
      return {
        ...c,
        resolved: false,
        reason: s.reason instanceof Error ? s.reason.message : String(s.reason),
      };
    }
    if (s.value === null) {
      return { ...c, resolved: false, reason: 'the cited record could not be read' };
    }
    return { ...c, resolved: true, types: s.value.types ?? [] };
  });
}

/**
 * A one-line account of what the reader is actually looking at.
 *
 * Exists because `complete` is a boolean somebody will forget to check. A view that can
 * describe its own gaps is harder to present as whole than one that only carries a flag.
 *
 * ★ IT HAS TO DESCRIBE THE AUTHORIZED VIEW'S GAPS TOO. Typed on `ComposedView`, it silently
 * dropped `disallowed` and `notRead` from every `AuthorizedView` — which is assignable, and
 * which both live verifiers pipe straight into here. So the one sentence whose stated job is
 * that a view can describe its own gaps was rendering a workspace with a member writing
 * entries that do not count as "1 entries from 2 of 2 streams", with no hint. The two fields
 * are accepted structurally rather than by importing `AuthorizedView`, which would make
 * `can.ts` and this file import each other.
 */
export function describeCoverage(view: ComposedView & {
  readonly disallowed?: readonly { readonly entry: ComposedEntry; readonly because: string }[];
  readonly notRead?: readonly { readonly principal: string; readonly authorizedHere?: boolean }[];
}): string {
  const members = view.streams.length + view.unavailable.length;
  const parts = [`${view.entries.length} entries from ${view.streams.length} of ${members} streams`];
  if (view.unavailable.length > 0) {
    parts.push(`${view.unavailable.length} unreachable (${view.unavailable.map(u => u.member.principal).join(', ')})`);
  }
  if (view.unmatched.length > 0) {
    const who = view.unmatched.map(u => `${u.member.principal} (${u.served})`).join(', ');
    // Says "not idle" out loud: the sentence this line replaces was "0 entries from 1 of 1
    // streams", which reads as a member who simply has not written yet.
    parts.push(`${view.unmatched.length} answered with records but NONE of that member's — not idle: ${who}`);
  }
  if (view.unverified.length > 0) {
    parts.push(`${view.unverified.length} read but NOT verified, so withheld from the feed`);
  }
  if (view.misattributed.length > 0) {
    const n = view.misattributed.reduce((a, m) => a + m.descriptorUrls.length, 0);
    // "the member's own pod" was the claim, not the check: `podUrl` is supplied by the
    // caller and in this design comes from the same acceptance as the stream.
    parts.push(`${n} entr${n === 1 ? 'y' : 'ies'} withheld as served from outside the pod URL `
      + 'supplied for that member');
  }
  if (view.unattested.length > 0) {
    const n = view.unattested.reduce((a, u) => a + u.entries.length, 0);
    parts.push(`${n} entr${n === 1 ? 'y' : 'ies'} withheld as NOT attributable to the member named`);
  }
  if (view.disallowed !== undefined && view.disallowed.length > 0) {
    const who = [...new Set(view.disallowed.map(d => d.entry.principal))].join(', ');
    // "This member has been writing entries that do not count" is the fact somebody has to
    // act on, and it was on the object and absent from the sentence.
    parts.push(
      `${view.disallowed.length} entr${view.disallowed.length === 1 ? 'y' : 'ies'} written by a `
      + `member who may not do this here, so NOT counted as workspace content (${who})`,
    );
  }
  if (view.notRead !== undefined && view.notRead.length > 0) {
    // Split, because the two halves mean opposite things: an unread Observer is the
    // pre-filter working, an unread Contributor is a hole in the view.
    const missing = view.notRead.filter(m => m.authorizedHere === true).map(m => m.principal);
    const skipped = view.notRead.filter(m => m.authorizedHere !== true).map(m => m.principal);
    if (missing.length > 0) {
      parts.push(`${missing.length} AUTHORIZED member(s) never read, so their entries are MISSING `
        + `from this view rather than excluded from it (${missing.join(', ')})`);
    }
    if (skipped.length > 0) {
      parts.push(`${skipped.length} member(s) not read because their entries would not have `
        + `counted (${skipped.join(', ')})`);
    }
  }
  parts.push('order within each stream is verified; order between streams is advisory');
  // Stated on every line of coverage, not only when it fails, because the difference between
  // the grades is invisible in the output: a feed of asserted entries and a feed of attested
  // ones render identically, and only one of them is evidence.
  parts.push(
    view.attributionGrade === 'attested'
      ? `attribution is ATTESTED (${view.descriptorReads} descriptor reads)`
      : 'attribution is ASSERTED — no authorship proof was read, so the principal on each '
        + 'entry is a label from the members list',
  );
  return parts.join('; ') + '.';
}
