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
 * ── POLY-VERTICAL BY CITATION ────────────────────────────────────────────────
 *
 * A `wsp:Reference` names a record in another vertical — a Foxxi credential, an `agp:`
 * plan, an A2A engagement — by its own IRI. Nothing is copied. The cited record keeps its
 * authorship, its shape and its access control, which is exactly why the two cannot drift
 * apart. {@link resolveCitations} reports whether each cited IRI is reachable and what it
 * says it is; it does not import it, and a citation that cannot be resolved is reported
 * as unresolved rather than dropped.
 */

import { readStream, verifyChain, type StreamDeps, type StreamRow, type ChainReport } from './stream.js';

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

/** Entries a member's stream pointed at but which are not served from that member's pod. */
export interface MisattributedEntries {
  readonly member: ComposableMember;
  readonly descriptorUrls: readonly string[];
  readonly reason: string;
}

/**
 * Is this descriptor served from within this pod?
 *
 * Origin AND path prefix, not origin alone: two members can legitimately share a host
 * (the same CSS serves every pod on this deployment), so origin-only containment would
 * let any member on that host claim any other's entries. Compared on the normalised
 * pod path, so a missing trailing slash is not a bypass.
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
   * Entries a member's stream pointed at that are NOT served from that member's pod.
   *
   * ★ Withheld rather than attributed. A stream IRI is chosen by the member in their own
   * acceptance, so treating "their stream pointed at it" as "they wrote it" lets anyone
   * claim anyone else's records — including, in the case that found this, laundering an
   * Observer's writes into a Contributor's entries.
   */
  readonly misattributed: readonly MisattributedEntries[];
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
  args: { readonly workspace: string; readonly members: readonly ComposableMember[] },
  deps: StreamDeps,
): Promise<ComposedView> {
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
      const rows = await readStream(
        { graphIri: member.stream, workspace: args.workspace, podUrl: member.podUrl },
        deps,
      );
      return { member, rows };
    }),
  );

  const streams: StreamOutcome[] = [];
  const unavailable: UnavailableStream[] = [];
  const misattributed: MisattributedEntries[] = [];
  const unverified: StreamOutcome[] = [];
  const entries: ComposedEntry[] = [];

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
    // pod this member's stream was read from is not this member's entry. It is not a
    // substitute for verifying the descriptor's own authorship proof — that is the real
    // fix and is not built — but it turns a silent cross-attribution into a visible one.
    const foreign = rows.filter(r => !isUnder(r.descriptorUrl, member.podUrl));
    const own = rows.filter(r => isUnder(r.descriptorUrl, member.podUrl));
    if (foreign.length > 0) {
      misattributed.push({
        member,
        descriptorUrls: foreign.map(r => r.descriptorUrl),
        reason:
          `${foreign.length} entr${foreign.length === 1 ? 'y is' : 'ies are'} served from outside `
          + `<${member.podUrl}>, the pod this member's stream was read from. They are withheld: `
          + 'attributing a record to a principal because their acceptance pointed at it would let '
          + 'anyone claim records written by anyone else.',
      });
    }

    const report = verifyChain(own);
    const record: StreamOutcome = { member, rows: own.length, report };
    streams.push(record);

    // An empty stream is a member who has not written yet — normal, and not an error.
    if (own.length === 0) continue;

    if (!report.intact) {
      // ★ Contributed to `unverified` but NOT to `entries`. Merging a forked stream would
      // put entries in a feed whose order within that member is unknown, and the reader
      // could not tell those apart from the verified ones sitting next to them.
      unverified.push(record);
      continue;
    }

    report.ordered.forEach((row, seqInStream) => {
      entries.push({
        principal: member.principal,
        stream: member.stream,
        descriptorUrl: row.descriptorUrl,
        cid: row.cid,
        validFrom: row.validFrom,
        seqInStream,
      });
    });
  }

  return {
    workspace: args.workspace,
    entries: mergeAdvisory(entries),
    streams,
    unavailable,
    unverified,
    misattributed,
    complete: unavailable.length === 0 && unverified.length === 0 && misattributed.length === 0,
    crossStreamOrderIsAdvisory: true,
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
 */
export function describeCoverage(view: ComposedView): string {
  const members = view.streams.length + view.unavailable.length;
  const parts = [`${view.entries.length} entries from ${view.streams.length} of ${members} streams`];
  if (view.unavailable.length > 0) {
    parts.push(`${view.unavailable.length} unreachable (${view.unavailable.map(u => u.member.principal).join(', ')})`);
  }
  if (view.unverified.length > 0) {
    parts.push(`${view.unverified.length} read but NOT verified, so withheld from the feed`);
  }
  if (view.misattributed.length > 0) {
    const n = view.misattributed.reduce((a, m) => a + m.descriptorUrls.length, 0);
    parts.push(`${n} entr${n === 1 ? 'y' : 'ies'} withheld as served from outside the member's own pod`);
  }
  parts.push('order within each stream is verified; order between streams is advisory');
  return parts.join('; ') + '.';
}
