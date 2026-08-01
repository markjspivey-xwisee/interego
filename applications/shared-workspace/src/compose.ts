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
    const report = verifyChain(rows);
    const record: StreamOutcome = { member, rows: rows.length, report };
    streams.push(record);

    // An empty stream is a member who has not written yet — normal, and not an error.
    if (rows.length === 0) continue;

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
    complete: unavailable.length === 0 && unverified.length === 0,
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
  parts.push('order within each stream is verified; order between streams is advisory');
  return parts.join('; ') + '.';
}
