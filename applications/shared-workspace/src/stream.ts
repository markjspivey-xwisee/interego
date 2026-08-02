/**
 * A participant's own append-only log within one workspace.
 *
 * ── WHERE THE WORK ACTUALLY LIVES ────────────────────────────────────────────
 *
 * A comparable system puts every message in one relay's database, so catching up is one
 * indexed query and joining means moving your storage to that server. Here each
 * participant writes to a stream on their OWN pod, and the workspace is the union of
 * those streams. That is what makes a workspace able to span organisations, and what
 * makes a participant's record outlive the workspace — it was never in it.
 *
 * The cost is real and stated rather than hidden: catching up on a workspace is one
 * manifest read PER MEMBER instead of one query, there is no full-text search across
 * members, and there is no presence. A team notices those within an hour.
 *
 * ── WHY ONE GRAPH IRI, NOT ONE PER ENTRY ─────────────────────────────────────
 *
 * Every entry is published under the SAME stable stream IRI. That single decision buys
 * both properties the log needs, from mechanisms the substrate already has:
 *
 *   catch-up   `discover_context{graph_iri}` returns the whole lineage from ONE manifest
 *              read. Entries addressed individually would need one read each, and the
 *              reader would have to already know their URLs — which is the problem.
 *
 *   ordering   Each entry declares `iep:supersedes` on the prior head, so the chain is a
 *              linked list the reader can verify rather than a set it has to trust the
 *              server to have sorted.
 *
 * `auto_supersede_prior` is deliberately OFF. Left on, the substrate links every entry to
 * every earlier one and a stream of n entries carries O(n²) supersedes triples — for a
 * log, which only ever grows, that is the wrong asymptotics. Declaring the single prior
 * head in the content keeps it linear, and `normalizePublishInputs` lifts it into
 * `descriptor.supersedes` where the CAS gate can see it.
 *
 * ── WHY EVERY APPEND CARRIES A PRECONDITION ──────────────────────────────────
 *
 * One stream has one owner but not necessarily one writer: a person and the two agents
 * acting for them all append to the same log. Two of them computing `seq` from the same
 * head would both write that seq, and the reader could not tell the duplicate from a
 * fork.
 *
 * So `seq` is not allocated — it is DERIVED from the head, and the `if_match` precondition
 * is what makes deriving it safe. The loser gets a 412 and re-reads. Sequence integrity is
 * therefore a consequence of the compare-and-swap rather than a second mechanism that
 * could disagree with it.
 *
 * ★ That precondition was measurably broken until the frontier fix: `if_match` compared
 * against the whole supersedes chain, so a stale ancestor satisfied it forever and both
 * concurrent writers landed. A log built on it would have silently accepted duplicate
 * sequence numbers while reporting `precondition.passed`. This module's guarantees are
 * only as good as that gate, which is why {@link verifyChain} re-derives the ordering from
 * the entries themselves instead of trusting that the appends were well-behaved.
 *
 * ── WHY EVERY APPEND IS SIGNED AND ONLY SOME READS VERIFY ────────────────────
 *
 * Every append goes out with `sign_authorship: true`, unconditionally. An entry written
 * without a proof can never acquire one: the bytes are immutable and the signing key has
 * moved on, so the choice at write time is between one ECDSA operation now and a record
 * whose author is forever unknowable. There is nothing to trade off.
 *
 * Verification is the opposite shape — one `get_descriptor` per entry, every read, forever —
 * so it is opt-in, and {@link readAttestation} is what a caller opts in to.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not retry. A 412 is returned as a value, named, with the current head attached.
 * Retrying is usually right for a log, and {@link appendWithRetry} does it — but under a
 * name the caller had to type, because a retry loop that hides concurrency is how a
 * conflict becomes a mystery.
 */

import { escapeTurtleLiteral, turtleIriRef, proofBindsToDescriptorUrl } from '@interego/core';
import type { Attestation, ContentBinding } from './roster.js';

export const WSP = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';
export const WSP_SHAPES = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-shapes.ttl';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/** What the caller wants to record. Payload is open: a vertical adds its own triples. */
export interface EntryDraft {
  /** Human-readable body. Optional — a pure reference entry has none. */
  readonly body?: string;
  /**
   * Records in OTHER verticals this entry cites, by their own IRIs. Never copied: the
   * cited record keeps its authorship, its shape and its access control, and this is the
   * whole of how a workspace becomes poly-vertical. A Foxxi credential referenced here is
   * still a Foxxi credential, not a workspace-flavoured copy of one that can drift.
   */
  readonly references?: readonly string[];
  /**
   * Extra Turtle predicate-object pairs for the entry subject, serialized by the caller.
   *
   * ★ Raw Turtle, so it CANNOT be escaped — that is what makes it useful to a vertical
   * adding its own terms, and what made it an injection point. Constrained instead: one
   * predicate-object pair, no `.` terminator, no `@prefix`/`@base`. Anything richer
   * belongs in its own published graph, cited via {@link EntryDraft.references}.
   */
  readonly extraTriples?: readonly string[];
}

export interface AppendedEntry {
  readonly seq: number;
  /** The entry's own dereferenceable identity — citable from outside the workspace. */
  readonly descriptorUrl: string;
  /**
   * Content-CID of this descriptor, when the substrate returned one. Often absent, which
   * is fine: the CAS accepts the descriptor URL form too, and `descriptorUrl` is always
   * present. Reported rather than synthesised — a CID we computed ourselves would be an
   * assertion about bytes we never read back.
   */
  readonly cid: string | null;
}

/**
 * Whether the relay actually embedded the authorship proof the append asked for.
 *
 * ★ THREE VALUES, BECAUSE "IT DID NOT SIGN" AND "IT DID NOT SAY" ARE NOT THE SAME CLAIM, and
 * neither of them is success. `appendEntry` sends `sign_authorship: true` and used to read
 * only `code`, `error` and `descriptorUrl` off the response — but the relay catches a signing
 * failure, logs a warning, LEAVES THE PUBLISH TO PROCEED, and reports it in the response body
 * as `authorship: {signed: false, reason}`. So a transient outage of the signing key produced
 * a run of entries this module called `appended`, with nothing anywhere mentioning signing.
 *
 * That is permanent by this module's own rule: an entry written unsigned can never acquire a
 * proof, because the bytes are immutable and the key has moved on. The operator finds out at
 * read time, when `verifyAuthorship: true` withholds a stretch of their own log, months later.
 *
 *   signed        the response says the proof was embedded.
 *   NOT-SIGNED    the response says it was not. The entry landed and is unattributable
 *                 forever. Spelled loudly because it is not recoverable.
 *   unreported    the response said nothing either way — an older relay, or a shape change.
 *                 Not treated as failure: guessing "unsigned" would make every append look
 *                 broken against a relay that simply does not report it.
 */
export type AppendSigning = 'signed' | 'NOT-SIGNED' | 'unreported';

export type AppendResult =
  | {
      readonly outcome: 'appended';
      readonly entry: AppendedEntry;
      readonly visibleAfterMs: number;
      /** See {@link AppendSigning}. Non-omittable: the whole defect was nobody being told. */
      readonly signing: AppendSigning;
      /** Always populated, so the fact survives a caller who never branches on the enum. */
      readonly signingNote: string;
    }
  /**
   * The substrate accepted the write but it had not become readable within the budget.
   *
   * ★ Distinct from success ON PURPOSE. `publish_context` returns `status: "pending"` and
   * the entry appears in the manifest a few seconds later — measured at 3–4s live. A
   * caller that treated acceptance as visibility and immediately appended again would
   * derive the same `seq` from a stale read and fork its own log, which is exactly what
   * happened the first time this ran against production.
   *
   * The honest answer is neither "done" nor "failed": the entry is probably fine, and the
   * caller must NOT blindly append again. Re-read first.
   */
  | {
      readonly outcome: 'pending';
      readonly descriptorUrl: string;
      readonly waitedMs: number;
      readonly message: string;
      /** Same fact as on `appended`: the write happened, so the signing question is settled. */
      readonly signing: AppendSigning;
      readonly signingNote: string;
    }
  /**
   * Someone else appended between the read and the write. Not an error: it is the CAS
   * doing its job, and the caller has enough here to re-derive and try again.
   */
  | {
      readonly outcome: 'conflict';
      readonly currentHead: string | null;
      readonly message: string;
    }
  | { readonly outcome: 'refused'; readonly code: number; readonly message: string };

/** One row as the reader sees it, before any interpretation. */
export interface StreamRow {
  readonly descriptorUrl: string;
  readonly cid: string | null;
  readonly validFrom: string | null;
  readonly supersedes: readonly string[];
  /**
   * The `wsp:seq` the entry declares, or null/absent when the reader could not obtain it.
   *
   * ★ From a manifest read it is ALWAYS absent, and the reason is structural rather than an
   * oversight: a manifest row mirrors `descriptorUrl`, `cid`, `describes`, `facetTypes`,
   * `validFrom`, `validUntil`, `modalStatus`, `trustLevel`, `conformsTo`, `supersedes` and
   * `issuer` — `seq` is not among them, because it lives in the entry's own payload graph.
   * Getting it would cost one `get_descriptor` PER ENTRY, which destroys the one-read
   * catch-up the single stream IRI exists to buy.
   *
   * So the number this module writes on every entry is read back when it can be and
   * reported as unavailable when it cannot, rather than quietly assumed — see
   * {@link ChainReport.declaredSeqChecked}. Until then `seq` is only ever populated by a
   * caller that already holds the payload.
   */
  readonly seq?: number | null;
}

/** The I/O this module needs, injected — so the CAS discipline is testable without a pod. */
export interface StreamDeps {
  /** `publish_context`. Returns the parsed tool result. */
  readonly publish: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** `discover_context`. Returns the parsed tool result. */
  readonly discover: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /**
   * `get_descriptor`. Needed ONLY to verify authorship, which costs one call PER ENTRY on
   * top of the one manifest read per member — the number this whole design is costed on.
   *
   * Optional here and refused loudly at the point of use rather than made mandatory, so a
   * caller who does not want to pay that cost is not obliged to supply a dependency, and a
   * caller who asks for verification without it gets a refusal instead of a silently
   * unverified result.
   */
  readonly getDescriptor?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Injected so tests do not sleep and so a caller can back off differently. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected so `visibleAfterMs` is measurable without a real clock. */
  readonly now?: () => number;
}

/** How long an append waits for its own entry to become readable before saying so. */
export const VISIBILITY_BUDGET_MS = 20_000;
const VISIBILITY_POLL_MS = 500;

export interface StreamRef {
  /** The stream's stable graph IRI — the same value on every append, forever. */
  readonly graphIri: string;
  /** The workspace this stream belongs to. */
  readonly workspace: string;
  /** Pod to read from. Writes go to the caller's own pod via their session. */
  readonly podUrl: string;
  /** Pod to write to, when the session's default is not the right one. */
  readonly podName?: string;
  /**
   * The writing agent's DID, forwarded to `publish_context` as `agent_did`.
   *
   * ★ A HINT, NOT THE IDENTITY. It is worth being precise about this, because a field named
   * `agent_did` sitting next to `sign_authorship` reads exactly like the thing that decides
   * who the proof names — and if it did, the proof would be worthless, because the caller
   * supplies it. The proof's `iep:issuer` is the relay's own `_session_agent_did`, a
   * reserved wire field the transport strips before any handler sees it; `agent_did` only
   * rides along in the signed payload so a verifier has a resolution hint. Omitting it
   * changes nothing about what the proof establishes.
   */
  readonly agentDid?: string;
}

// ── Rendering ────────────────────────────────────────────────────────────────


/**
 * Why this raw fragment cannot be spliced into the entry, or null if it can.
 *
 * ★ `extraTriples` is raw Turtle and CANNOT be escaped — being a raw predicate-object
 * fragment is exactly what lets a vertical add its own terms. It was interpolated
 * straight in, two lines below a docstring promising that "every interpolated value goes
 * through the shared escaper or the shared IRI guard". An independent review used it to
 * emit a well-formed document carrying a top-level
 * `<victim> acl:agent <did:web:attacker> .` — an authorization triple about a third
 * party, written by string concatenation, which the publish shape gate then accepted
 * because the result parses.
 *
 * So it is CONSTRAINED rather than escaped. Anything that could end the current statement
 * or open a new one is refused; a caller needing more should publish its own graph and
 * cite it, which is what `wsp:Reference` exists for.
 */
export function rejectExtraTriple(fragment: string): string | null {
  if (/[\r\n]/.test(fragment)) return 'it spans more than one line';
  if (/@\s*(prefix|base)\b/i.test(fragment)) return 'it contains a directive';
  if (/(^|[\s>"])\.(\s|$)/.test(fragment)) return 'it contains a statement terminator';
  if (/[.;]$/.test(fragment)) return 'it ends with a terminator or separator';
  return null;
}

/**
 * Render one entry as Turtle.
 *
 * ★ Every interpolated value goes through the shared escaper or the shared IRI guard.
 * Hand-built Turtle in this repo has been the source of an injection three times, in three
 * different positions, and the lesson was that a literal is not the only one: an IRI
 * reference ends at the first `>`, so an unchecked IRI can close the reference and write a
 * triple its author was never authorised to assert. `turtleIriRef` returns null rather
 * than escaping, because Turtle's IRIREF production has no escape for `>` — there is
 * nothing to escape it to, so the only correct handling is refusal.
 */
export function entryTurtle(args: {
  readonly entryIri: string;
  readonly workspace: string;
  readonly seq: number;
  readonly draft: EntryDraft;
  readonly supersedes?: string | null;
}): string {
  const subject = turtleIriRef(args.entryIri);
  const workspace = turtleIriRef(args.workspace);
  if (!subject) throw new Error(`entryTurtle: entry IRI is not serializable as Turtle: ${args.entryIri}`);
  if (!workspace) throw new Error(`entryTurtle: workspace IRI is not serializable as Turtle: ${args.workspace}`);
  if (!Number.isInteger(args.seq) || args.seq < 0) {
    throw new Error(`entryTurtle: seq must be a non-negative integer, got ${args.seq}`);
  }

  const refs = (args.draft.references ?? []).map(r => {
    const ref = turtleIriRef(r);
    // Refusing loudly rather than dropping: a reference that silently vanishes turns a
    // poly-vertical citation into an entry that says nothing, and nobody finds out.
    if (!ref) throw new Error(`entryTurtle: reference is not a serializable IRI: ${r}`);
    return ref;
  });

  const lines: string[] = [
    `@prefix wsp: <${WSP}> .`,
    `@prefix iep: <${IEP}> .`,
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `${subject}`,
    // A referencing entry is BOTH: wsp:Reference is a subclass of wsp:Entry, and declaring
    // both types means the entry shape and the reference shape each find their target
    // without depending on the validator having computed the subclass closure first.
    refs.length > 0 ? '  a wsp:Entry, wsp:Reference ;' : '  a wsp:Entry ;',
    `  wsp:workspace ${workspace} ;`,
    `  wsp:seq "${args.seq}"^^xsd:nonNegativeInteger ;`,
  ];

  for (const ref of refs) lines.push(`  wsp:references ${ref} ;`);

  if (args.supersedes) {
    const prior = turtleIriRef(args.supersedes);
    if (!prior) throw new Error(`entryTurtle: prior head is not a serializable IRI: ${args.supersedes}`);
    // Declared in the CONTENT, not via auto_supersede_prior: exactly one link per entry,
    // so the chain stays linear instead of growing a link to every ancestor.
    lines.push(`  iep:supersedes ${prior} ;`);
  }

  if (args.draft.body !== undefined) {
    lines.push(`  dct:description "${escapeTurtleLiteral(args.draft.body)}" ;`);
  }
  // ★ extraTriples IS raw Turtle, and it used to be interpolated straight in — two lines
  // below a docstring promising that "every interpolated value goes through the shared
  // escaper or the shared IRI guard". An independent review produced a well-formed
  // document carrying a top-level `<victim> acl:agent <did:web:attacker> .` through it,
  // which the shape gate then accepted because the result parses.
  //
  // It cannot be escaped — it is deliberately a raw predicate-object fragment, which is
  // what makes a vertical able to add its own terms. So it is CONSTRAINED instead: one
  // predicate-object pair, no statement terminator, no directive. A caller that needs
  // more should publish its own graph and cite it, which is what wsp:Reference is for.
  for (const raw of args.draft.extraTriples ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const rejection = rejectExtraTriple(trimmed);
    if (rejection !== null) {
      throw new Error(
        'entryTurtle: extraTriples must be ONE predicate-object pair for the entry itself '
        + `subject — ${rejection}: ${trimmed.slice(0, 80)}`,
      );
    }
    lines.push(`  ${trimmed} ;`);
  }

  // Close the predicate list.
  const last = lines[lines.length - 1]!;
  lines[lines.length - 1] = last.replace(/ ;$/, ' .');
  return lines.join('\n') + '\n';
}

// ── Reading ──────────────────────────────────────────────────────────────────

const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * A declared `wsp:seq` as a number, or null when the row does not carry one.
 *
 * The lexical form is accepted alongside the number because the value is published as
 * `"3"^^xsd:nonNegativeInteger`: anything mirroring that literal without interpreting its
 * datatype hands back the string, and rejecting it would report a row that DID declare its
 * position as one that declared nothing — turning a checkable chain into an unchecked one.
 */
const asSeq = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
};

/**
 * Read a stream: ONE `discover_context`, no per-entry fetches.
 *
 * Rows come back in whatever order the manifest yields them; ordering is imposed by
 * {@link verifyChain} from the supersedes links, not taken on trust from the server. A
 * reader that sorted by `validFrom` and stopped there would accept a chain whose links
 * disagree with its timestamps, and a log whose order can be changed by a clock is not an
 * audit trail.
 */
export async function readStream(ref: StreamRef, deps: StreamDeps): Promise<readonly StreamRow[]> {
  const res = await deps.discover({
    pod_url: ref.podUrl,
    graph_iri: ref.graphIri,
    sort: 'oldest-first',
  });

  // ★ A FAILED READ MUST NOT LOOK LIKE AN EMPTY ONE.
  //
  // The substrate reports an unreachable pod as DATA, not as a rejection: the tool result
  // for a dead host is the plain string "Error: fetch failed", and for a pod that exists
  // but holds nothing it is `{entries: [], registry: null}`. Both reduce to zero rows
  // under a permissive read, and the two claims could not be further apart — "this member
  // has written nothing" versus "we could not reach this member at all".
  //
  // This was found live and only live. The composed view's per-stream error isolation was
  // fully tested against a double that THREW, so it passed; against the real relay it
  // never fired once, and an unreachable member was silently rendered as an idle one.
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    throw new Error(
      `discover_context on <${ref.podUrl}> did not return a result object: ${JSON.stringify(res)?.slice(0, 200)}`,
    );
  }
  if (res.error !== undefined) {
    throw new Error(`discover_context on <${ref.podUrl}> failed: ${String(res.message ?? res.error)}`);
  }
  if (!Array.isArray(res.entries)) {
    throw new Error(
      `discover_context on <${ref.podUrl}> returned no entries array — the read did not succeed, `
      + 'and treating that as an empty stream would report an unreachable member as an idle one.',
    );
  }

  return asArray(res.entries)
    .map(e => e as Record<string, unknown>)
    .filter(e => asArray(e.describes).includes(ref.graphIri))
    .map(e => ({
      descriptorUrl: String(e.descriptorUrl ?? ''),
      cid: asString(e.cid),
      validFrom: asString(e.validFrom),
      supersedes: asArray(e.supersedes).filter((s): s is string => typeof s === 'string'),
      // Null against today's relay: the manifest row has no seq column. Read anyway rather
      // than dropped, so the check switches itself on the moment the number is available —
      // and so nothing has to remember to wire it up then. `declaredSeqChecked` tells the
      // reader which of the two situations they are actually in.
      seq: asSeq(e.seq),
    }))
    .filter(r => r.descriptorUrl.length > 0);
}

export interface ChainReport {
  /** Rows in verified order, oldest first. Empty when the chain cannot be ordered. */
  readonly ordered: readonly StreamRow[];
  /** Rows nothing supersedes. More than one means concurrent appends both landed. */
  readonly heads: readonly string[];
  /** Rows superseded by more than one other row — a merge, which this chain never writes. */
  readonly merges: readonly string[];
  /** Rows whose declared prior is absent from the stream. A missing link, not a gap in seq. */
  readonly danglingLinks: readonly { readonly from: string; readonly missing: string }[];
  /**
   * Rows whose declared `wsp:seq` disagrees with the position the links put them in.
   *
   * ★ The links alone cannot catch a row that was removed and linked around: rows
   * `[seq 0] ← [seq 2]`, where the survivor was re-pointed at its grandparent, has one head,
   * one root, no dangling link and covers every row present — it verifies clean. The
   * number each entry declares is the only evidence left that a position is missing, and
   * this module writes that number on every entry and then had no field to read it into.
   */
  readonly seqMismatches: readonly {
    readonly url: string;
    readonly declared: number;
    readonly position: number;
  }[];
  /**
   * Whether every ordered row carried a declared seq, so the numbering could be compared
   * with the walked order at all.
   *
   * ★ FALSE for every stream read from a manifest, which is every stream this module reads
   * today — see {@link StreamRow.seq}. Reported rather than left implicit because the two
   * cases are worlds apart and `seqMismatches: []` looks identical in both: "the log's own
   * numbering agrees with its links" versus "nobody looked". It is deliberately NOT part of
   * {@link ChainReport.intact} — a stream is not divergent because the manifest omits a
   * column, and folding it in would make `appendEntry` refuse every real append forever.
   */
  readonly declaredSeqChecked: boolean;
  /**
   * True only when there is exactly one head, one root, every row is on the path, and no
   * declared position contradicts it.
   *
   * ★ It does NOT mean "this is the whole log", and no amount of walking can make it mean
   * that. Dropping the OLDEST rows leaves a dangling link and is caught; dropping the
   * NEWEST leaves a clean prefix, and a prefix of a valid chain is a valid chain. `wsp:seq`
   * does not rescue it either — the row carrying the highest number is precisely the row
   * that was removed. Detecting tail truncation needs an anchor from outside the served
   * rows (a head the reader saw earlier, or a signed length claim), which this layer does
   * not have and does not pretend to.
   */
  readonly intact: boolean;
}

/**
 * Re-derive the chain from the entries themselves.
 *
 * ★ This exists because the append path's guarantee is only as strong as a substrate
 * precondition that was, until recently, not actually a compare-and-swap. A reader that
 * assumed appends were well-behaved would have reported a forked log as a healthy one.
 * Verifying here costs nothing — the links are already in the rows the single
 * `discover_context` returned — and it converts an invisible failure into a visible one.
 */
export function verifyChain(rows: readonly StreamRow[]): ChainReport {
  const byUrl = new Map(rows.map(r => [r.descriptorUrl, r]));
  const supersededBy = new Map<string, string[]>();
  const dangling: { from: string; missing: string }[] = [];

  for (const r of rows) {
    for (const prior of r.supersedes) {
      if (!byUrl.has(prior)) {
        // The prior is not in THIS stream. Either the chain was truncated, or the entry
        // cites something from another graph — both mean the reader cannot walk past here.
        dangling.push({ from: r.descriptorUrl, missing: prior });
        continue;
      }
      const list = supersededBy.get(prior);
      if (list) list.push(r.descriptorUrl); else supersededBy.set(prior, [r.descriptorUrl]);
    }
  }

  const heads = rows.filter(r => !supersededBy.has(r.descriptorUrl)).map(r => r.descriptorUrl);
  const merges = [...supersededBy].filter(([, xs]) => xs.length > 1).map(([url]) => url);

  // Walk back from the single head. Any other shape is reported, not repaired: choosing a
  // winner between two heads is guessing which append survived, and a log may not guess.
  const ordered: StreamRow[] = [];
  if (heads.length === 1 && merges.length === 0) {
    const seen = new Set<string>();
    let cursor: string | undefined = heads[0];
    while (cursor !== undefined && byUrl.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const row: StreamRow = byUrl.get(cursor)!;
      ordered.unshift(row);
      cursor = row.supersedes.find(s => byUrl.has(s));
    }
  }

  // Compare each entry's own declared position against the one the links walked it into.
  // A row that declares 2 while sitting at 1 says a position between them is not here, and
  // that is the one removal the links cannot report: whoever dropped it re-pointed the
  // survivor, so the chain still walks cleanly end to end.
  const seqMismatches: { url: string; declared: number; position: number }[] = [];
  let declared = 0;
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]!;
    if (row.seq === undefined || row.seq === null) continue;
    declared++;
    if (row.seq !== i) seqMismatches.push({ url: row.descriptorUrl, declared: row.seq, position: i });
  }

  return {
    ordered,
    heads,
    merges,
    danglingLinks: dangling,
    seqMismatches,
    // Every ordered row, not merely one of them: a partial answer would let a caller read
    // "checked" off a stream where only the row that happened to carry a number was.
    declaredSeqChecked: ordered.length > 0 && declared === ordered.length,
    // ★ A dangling link makes the chain NOT intact even when everything present walks
    // cleanly. Rows [v1 ← v2] where v1 declares an absent v0 orders perfectly and covers
    // every row it has — and the reader is still missing the beginning of the log.
    // Calling that intact would be a false assurance handed to exactly the caller who
    // asked whether it could trust the history.
    intact:
      heads.length === 1
      && merges.length === 0
      && dangling.length === 0
      && seqMismatches.length === 0
      && ordered.length === rows.length
      && rows.length > 0,
  };
}

// ── Authorship ───────────────────────────────────────────────────────────────

/**
 * The `iep:descriptorId` the embedded authorship proof claims to be about, or null.
 *
 * Parsed with the same shape the substrate's own `parseAuthorshipProofFromDescriptorTurtle`
 * uses, deliberately: a second, cleverer parser here would eventually disagree with the one
 * that decided whether the signature verified, and the disagreement would be discovered by
 * whichever record it let through.
 */
export function proofDescriptorId(descriptorTurtle: string): string | null {
  const block = descriptorTurtle.match(/iep:authorshipProof\s+\[([^\]]*)\]/);
  if (!block) return null;
  return block[1]!.match(/iep:descriptorId\s+<([^>]+)>/)?.[1] ?? null;
}

/*
 * ── WHERE `proofBindsToDescriptor` WENT ──────────────────────────────────────
 *
 * This file used to export a one-line wrapper —
 *
 *     export function proofBindsToDescriptor(claimedId, descriptorUrl): boolean {
 *       return proofBindsToDescriptorUrl(claimedId, descriptorUrl).bound;
 *     }
 *
 * — justified as "every caller here decides admit-or-withhold and has nothing to do with a
 * third value". That justification was wrong in the way a convenience wrapper is usually
 * wrong: it made the LOSSY reading the short one to write. `proofBindsToDescriptorUrl`
 * returns `{bound, basis}` where `basis` distinguishes `'exact-url'` — host, pod, container
 * and name all compared — from `'slug-only'`, which compared one path segment and nothing
 * else. A `bound: true` on a `slug-only` basis is what let a record hosted at
 * `https://attacker.example/anything/<epoch>.ttl` bind to a proof minted for a real record
 * on someone else's pod, and the wrapper is why no caller ever saw that it had.
 *
 * It is deleted rather than fixed. A function whose whole body is the collapse cannot be
 * called correctly, and leaving it exported means the next caller writes the collapse by
 * reaching for the shorter name. Call `proofBindsToDescriptorUrl` from @interego/core and
 * read the field you actually mean — {@link attestationOfResponse} does, and now carries
 * `basis` onto the {@link Attestation} instead of dropping it at the boundary.
 *
 * The substrate function carries the full argument for what a URN-form id can and cannot
 * buy, and for why reading the pod out of the URN breaks honest relay-minted shapes
 * (`urn:iep:pod-bootstrap:<user>:v1`, `urn:iep:trajectory-step:<agent>:<ms>`).
 *
 * ★ THIS LAYER STILL COMPUTES THE COMPARISON LOCALLY RATHER THAN READING THE RELAY'S ANSWER.
 * The relay reports its own `descriptorBinding` now, and deferring to it would be a
 * downgrade: the workspace would stop holding an independent opinion about the one question
 * the substrate historically did not ask. Same function, two independent evaluations,
 * neither trusting the other's verdict.
 */

/**
 * What the substrate's verifier says about who published one descriptor. ONE `get_descriptor`.
 *
 * ★ Every failure mode returns "not attested" with a reason rather than throwing, and that
 * is not the usual laxness. The three situations — the descriptor carries no proof, the
 * proof did not verify, the descriptor could not be read at all — are worlds apart to a
 * person and identical to the caller's decision, which is to withhold the record and name
 * it. Collapsing them into a rejection would lose the reason; collapsing them into an
 * absence would admit the record. The reason string keeps them distinguishable in the one
 * place a human looks.
 */
export async function readAttestation(
  descriptorUrl: string,
  deps: StreamDeps,
): Promise<Attestation> {
  if (deps.getDescriptor === undefined) {
    // A programming error, not a data condition: the caller asked for verified attribution
    // and did not supply the tool it is verified with. Answering "unverified" here would
    // hand back a result that looks like a forged workspace.
    throw new Error(
      'readAttestation: verifying authorship needs a `getDescriptor` dependency (the '
      + '`get_descriptor` tool). It costs one call per entry, which is why it is not '
      + 'required by default — but asking to verify without it cannot be answered.',
    );
  }
  let res: Record<string, unknown>;
  try {
    res = await deps.getDescriptor({ url: descriptorUrl });
  } catch (err) {
    return {
      authorshipVerified: false, signedBy: null, boundToDescriptor: false,
      reason: `get_descriptor threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return attestationOfResponse(res, descriptorUrl);
}

/**
 * The same verdict, off a `get_descriptor` response the caller already holds.
 *
 * ★ EXTRACTED SO A READER PAYS FOR ONE CALL, NOT TWO. `membership.ts` needs the descriptor's
 * PAYLOAD and its attestation together, and the two must describe the same read: the relay
 * computes `contentBinding` by digesting the very `graph.content` it returns in that
 * response (`observedGraphDigest({graphContent: graph?.content, descriptorTurtle: turtle})`
 * in the `get_descriptor` handler), so `'bound'` means "the bytes in THIS response are the
 * triples the signer signed". Fetching the payload in one call and the attestation in
 * another would let the two answers come from different reads of a pod that changed in
 * between — and the whole value of field binding is that the fields and the binding verdict
 * cover the same bytes.
 *
 * ★ SAME READ IS ONLY HALF OF IT — see `payloadOf` in membership.ts. The relay digests one
 * REGION of the document it serves, not the document, and a reader that parsed the whole of
 * it read fields out of bytes this verdict does not cover.
 */
export function attestationOfResponse(
  res: Record<string, unknown>,
  descriptorUrl: string,
): Attestation {
  const unattested = (reason: string): Attestation =>
    ({ authorshipVerified: false, signedBy: null, boundToDescriptor: false, reason });

  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    return unattested(`get_descriptor did not return a result object for <${descriptorUrl}>`);
  }
  if (res.error !== undefined) {
    return unattested(`get_descriptor failed: ${String(res.message ?? res.error)}`);
  }

  const authorship = res.authorship as Record<string, unknown> | undefined;
  if (authorship === undefined || authorship === null) {
    return unattested(
      'the descriptor carries no iep:authorshipProof — it was published without '
      + 'sign_authorship, so there is nothing to verify and nobody to attribute it to',
    );
  }
  const signedBy = asString(authorship.signedBy);
  // `=== true`, not truthiness: this is JSON read off a pod, and a value that is not the
  // boolean the schema promises must not come out the admitting end of the branch.
  if (authorship.authorshipVerified !== true) {
    return {
      authorshipVerified: false,
      signedBy,
      boundToDescriptor: false,
      // Carried even on the refusing branch, because `'mismatched'` only ever arrives here:
      // a recomputed digest that did not match also fails the signature-level verdict.
      // Dropping the field would leave the caller unable to tell "the content was swapped"
      // from "the proof could not be verified", and the first is the sharper of the two.
      contentBinding: readContentBinding(authorship.contentBinding),
      reason: String(authorship.reason ?? 'the verifier reported the proof did not verify'),
    };
  }
  // ★ WHY THE BINDING FAILED, NOT JUST THAT IT DID. `boundToDescriptor: false` has four
  // distinct causes and `refuseAttestation` was rendering all four as "the proof was copied
  // in from another record" — stated as fact. Three of them are not forgeries: a response
  // with no turtle, a proof block carrying no `iep:descriptorId`, and a record whose name
  // does not follow the convention this check compares on (the PGSL-primary path writes
  // `holon-<hash>.ttl`). Calling a record's real author a forger, in the one channel
  // operators are told to watch, is how a true report gets ignored.
  const turtle = res.turtle === undefined || res.turtle === null ? null : String(res.turtle);
  const claimedId = turtle === null ? null : proofDescriptorId(turtle);
  // The shared substrate comparison, which returns the BASIS alongside the verdict. No
  // normaliser is passed: `normalizeCssUrl` lives at the relay's HTTP boundary and this
  // package cannot reach it, so a URL-form id is compared literally here — which is exactly
  // what this layer did before, so nothing regresses by omitting it.
  const binding = proofBindsToDescriptorUrl(claimedId, descriptorUrl);
  const unboundReason =
    turtle === null
      ? 'get_descriptor returned no descriptor turtle, so the proof could not be matched to '
        + 'this descriptor at all — this says nothing about the proof itself'
      // Every other cause now carries the shared function's own caveat, which names the id,
      // the URL and which of them could not be compared. Kept behind this one local case
      // because "no turtle came back" is a fact about the RESPONSE, and the comparison
      // function is never shown the response.
      : binding.caveat ?? `the proof names <${claimedId}> and the record is served at <${descriptorUrl}>`;

  return {
    authorshipVerified: true,
    signedBy,
    boundToDescriptor: binding.bound,
    // ★ THE BASIS TRAVELS WITH THE BOOLEAN, out of the same object, one line apart, so the
    // pair cannot be written half-updated. This used to stop here: `binding.basis` was
    // computed and thrown away, and every consumer downstream saw a bare `true` covering
    // both "host, pod, container and name all matched" and "one path segment matched and
    // the host was never looked at". See `Attestation.descriptorBindingBasis` for what the
    // weak one costs and for why no policy refuses on it.
    descriptorBindingBasis: binding.basis,
    contentBinding: readContentBinding(authorship.contentBinding),
    // ★ A CAVEAT ON A PASSING RESULT IS NOT THE "NOISE ON A CLEAN RESULT" THIS FILE REFUSES
    // ELSEWHERE — but it is also not a refusal, and rendering it in `reason` would make
    // `boundToDescriptor: true` look like a failure to every caller that reads the field.
    // So the reason stays exactly what it was: present iff the binding failed. What a
    // `slug-only` pass did not compare is now on `descriptorBindingBasis` above, and the
    // RELAY reports the same verdict with its own caveat string (`descriptorBinding.note`).
    ...(binding.bound ? {} : { reason: unboundReason }),
  };
}

/**
 * Read `get_descriptor.authorship.contentBinding` off a JSON response.
 *
 * ★ ANY UNRECOGNISED VALUE BECOMES `'unbound'`. This is JSON from a pod-facing tool, so the
 * field may be missing entirely (a relay predating content binding), a non-string, or a
 * value from some later vocabulary this build does not know. Every one of those means the
 * same thing to a caller — nobody here established that the proof covers the content — and
 * `'unbound'` is the value that claims least, so an unknown string can never be the thing
 * that satisfies `requireContentBinding`. Defaulting the other way would make an older
 * relay, or a typo, into a passing content check.
 *
 * ★ WHICH IS WHY `'mismatched'` HAD TO BE ADDED HERE THE DAY IT WAS ADDED UPSTREAM. It is
 * the one value where "claims least" is the wrong instinct: coercing it to `'unbound'`
 * would relabel a detected content swap as ordinary pre-binding data. A relay that reports
 * tampering must not have the report flattened on the way in.
 */
function readContentBinding(raw: unknown): ContentBinding {
  return raw === 'bound' || raw === 'mismatched' || raw === 'declared' ? raw : 'unbound';
}

// ── Appending ────────────────────────────────────────────────────────────────

/**
 * The precondition token for the next append, derived from a verified chain.
 *
 * ★ AN UNVERIFIABLE CHAIN MUST NOT LOOK LIKE AN EMPTY ONE — the same rule as
 * {@link readStream}, in the position where getting it wrong writes rather than reads.
 *
 * It used to answer `{url: null, seq: 0}` for both, because it read `ordered` and ignored
 * `intact`, and a forked chain orders to nothing. That value does not say "I could not
 * tell"; it says "brand new stream, start at 0, no precondition needed". A caller who
 * believed it would land a THIRD head on a log that already had two, at a sequence number
 * two other entries already claim, gated on nothing — the exact failure `if_match` exists
 * to prevent, produced by the helper whose docstring promised a verified chain.
 *
 * {@link appendEntry} guards before it gets here, so the shipped path never throws. This
 * function is exported, and the next caller will not have that guard, so the refusal lives
 * where the wrong answer was rather than in each caller's discipline.
 */
export function headOf(rows: readonly StreamRow[]): { url: string | null; seq: number } {
  // An empty stream is the one case where "no head, start at 0" is the truth rather than a
  // failure to determine it, and it is why the two were confusable in the first place.
  if (rows.length === 0) return { url: null, seq: 0 };

  const report = verifyChain(rows);
  if (!report.intact) {
    throw new Error(
      `headOf: refusing to derive a head from a stream that does not verify — ${report.heads.length} `
      + `head(s), ${report.merges.length} merge(s), ${report.danglingLinks.length} dangling link(s), `
      + `${report.seqMismatches.length} sequence mismatch(es). There is no head to gate on, and the `
      + 'answer for an empty stream — seq 0 with no precondition — would append onto the divergence '
      + 'instead of surfacing it. Call verifyChain, repair, then derive.',
    );
  }
  const head = report.ordered[report.ordered.length - 1]!;
  return { url: head.descriptorUrl, seq: report.ordered.length };
}

/**
 * Append one entry, gated on the head the caller just read.
 *
 * Returns a conflict rather than throwing, and never retries on its own — see the module
 * note. The entry IRI is derived from the stream and the sequence, so it is predictable,
 * dereferenceable, and cannot collide with another writer's entry without one of them
 * having lost the CAS first.
 */
export async function appendEntry(
  ref: StreamRef,
  draft: EntryDraft,
  deps: StreamDeps,
): Promise<AppendResult> {
  const rows = await readStream(ref, deps);
  const report = verifyChain(rows);
  // Also what keeps the headOf below from throwing: a divergence is an ordinary racing
  // outcome for a caller of appendEntry, so it is returned as a named value here rather
  // than left to surface as an exception from a helper two lines further down.
  if (rows.length > 0 && !report.intact) {
    return {
      outcome: 'conflict',
      currentHead: report.heads[0] ?? null,
      message:
        `Refusing to append to a stream that does not verify: ${report.heads.length} head(s), `
        + `${report.merges.length} merge(s), ${report.danglingLinks.length} dangling link(s). `
        + 'Appending onto an unverified chain would bury the divergence under a new entry '
        + 'instead of surfacing it. Repair the chain first.',
    };
  }

  const head = headOf(rows);
  const seq = head.seq;
  const entryIri = `${ref.graphIri}/e/${seq}`;

  const res = await deps.publish({
    graph_iri: ref.graphIri,
    graph_content: entryTurtle({
      entryIri,
      workspace: ref.workspace,
      seq,
      draft,
      supersedes: head.url,
    }),
    visibility: 'public',
    // OFF deliberately: the content declares exactly one prior, so the chain stays linear.
    auto_supersede_prior: false,
    // The shape gate runs BEFORE any pod write, so a malformed entry never lands even
    // briefly. An entry with no wsp:seq is refused here rather than silently unorderable.
    conforms_to_shapes: [WSP_SHAPES],
    // ★ WITHOUT THIS THE ENTRY CANNOT BE ATTRIBUTED TO ANYONE, EVER.
    //
    // The read path used to attach `principal` from the caller's members list and nothing in
    // the record contradicted it, because there was nothing in the record. `sign_authorship`
    // embeds an `iep:authorshipProof` naming the session's own agent, which `get_descriptor`
    // re-verifies from the descriptor turtle alone — so a reader who trusts neither the pod's
    // storage nor whoever assembled the members list can still tell who published this.
    //
    // Unconditional rather than opt-in, and the asymmetry is the reason: signing costs one
    // ECDSA operation at write time, once, whereas an entry written unsigned can never be
    // verified afterwards — the key is gone and the bytes are immutable. Verification is
    // where the recurring cost is, so that is what is opt-in (see `composeWorkspace`).
    sign_authorship: true,
    ...(head.url ? { if_match: head.url } : {}),
    ...(ref.podName ? { pod_name: ref.podName } : {}),
    ...(ref.agentDid ? { agent_did: ref.agentDid } : {}),
  });

  const code = typeof res.code === 'number' ? res.code : null;
  if (code === 412) {
    const current = res.currentHead as Record<string, unknown> | undefined;
    return {
      outcome: 'conflict',
      currentHead: asString(current?.descriptorUrl),
      message: String(res.message ?? 'precondition failed'),
    };
  }
  if (res.error !== undefined) {
    return { outcome: 'refused', code: code ?? 0, message: String(res.message ?? res.error) };
  }

  const descriptorUrl = String(res.descriptorUrl ?? '');

  // ★ DID THE RELAY ACTUALLY SIGN IT? Asking `sign_authorship: true` is a request, and the
  // relay answers. It catches a signing failure, warns, and publishes anyway — so reading
  // only `code`/`error`/`descriptorUrl`, as this did, reported an unsigned entry as a signed
  // append. See `AppendSigning`: the entry is already on the pod and cannot be re-signed.
  const [signing, signingNote] = readSigning(res);

  // ★ WAIT FOR THE ENTRY TO BECOME READABLE BEFORE CALLING THE APPEND DONE.
  //
  // `publish_context` returns `status: "pending"`: the descriptor and manifest writes are
  // deferred, and the entry shows up in `discover_context` a few seconds later (3–4s,
  // measured live). Returning at acceptance would be a lie about durability in the one
  // situation that matters — the next thing anyone does with a log is read it, and the
  // next thing THIS caller does is derive the following `seq` from that read.
  //
  // Without this wait the first live run appended five entries and produced two heads:
  // appends 1 and 2 both read an empty stream, both derived seq 0, and both landed.
  const started = now(deps);
  let waited = 0;
  for (;;) {
    const seen = await readStream(ref, deps);
    if (seen.some(r => r.descriptorUrl === descriptorUrl)) {
      return {
        outcome: 'appended',
        entry: { seq, descriptorUrl, cid: asString(res.cid) },
        visibleAfterMs: waited,
        signing,
        signingNote,
      };
    }
    waited = now(deps) - started;
    if (waited >= VISIBILITY_BUDGET_MS) {
      return {
        outcome: 'pending',
        descriptorUrl,
        waitedMs: waited,
        message:
          `The substrate accepted the entry but it was not readable within ${VISIBILITY_BUDGET_MS}ms. `
          + 'It has probably landed. Do NOT append again without re-reading: deriving the next '
          + 'sequence from a stale view is how one writer forks its own log.',
        signing,
        signingNote,
      };
    }
    await sleep(deps, VISIBILITY_POLL_MS);
  }
}

/**
 * What the publish response says about whether the authorship proof was embedded.
 *
 * Split out so the three readings sit in one place rather than inline in the append path,
 * and so the "not reported" case cannot quietly collapse into either of the other two.
 */
function readSigning(res: Record<string, unknown>): [AppendSigning, string] {
  const authorship = res.authorship as Record<string, unknown> | undefined | null;
  if (authorship === undefined || authorship === null) {
    return ['unreported',
      'The publish response carried no `authorship` block, so whether the proof was embedded '
      + 'is UNKNOWN — not confirmed and not denied. Read the descriptor back with '
      + '`readAttestation` if it matters that this entry can be attributed later.'];
  }
  // `=== true`, not truthiness: this is a parsed tool result, and a value that is not the
  // boolean the schema promises must not come out the reassuring end of the branch.
  if (authorship.signed === true) {
    return ['signed', 'The relay reports the iep:authorshipProof was embedded in the descriptor.'];
  }
  if (authorship.signed === false) {
    return ['NOT-SIGNED',
      'The relay REFUSED OR FAILED to sign and published the entry anyway '
      + `(${String(authorship.reason ?? 'no reason given')}). The entry has landed and cannot `
      + 'be signed after the fact — the bytes are immutable and the key has moved on — so it '
      + 'is unattributable FOREVER and `verifyAuthorship: true` will withhold it on every '
      + 'read from now on. If the signing key is merely down, stop appending until it is back.'];
  }
  return ['unreported',
    `The publish response's authorship block did not say whether it signed (${JSON.stringify(authorship).slice(0, 120)}).`];
}

const now = (deps: StreamDeps): number => (deps.now ?? Date.now)();
const sleep = (deps: StreamDeps, ms: number): Promise<void> =>
  deps.sleep ? deps.sleep(ms) : new Promise(r => setTimeout(r, ms));

/**
 * Append, re-deriving and retrying on conflict.
 *
 * Separate from {@link appendEntry} on purpose. For a log, retrying after losing a race is
 * almost always what you want — but only almost. An agent whose entry says "acknowledging
 * seq 4" must see that seq 4 is no longer the head, so the retry has to be the caller's
 * decision and has to be visible in the code that made it.
 */
export async function appendWithRetry(
  ref: StreamRef,
  draft: EntryDraft,
  deps: StreamDeps,
  attempts = 3,
): Promise<AppendResult> {
  let last: AppendResult = { outcome: 'refused', code: 0, message: 'no attempt made' };
  for (let i = 0; i < attempts; i++) {
    last = await appendEntry(ref, draft, deps);
    // 'pending' is deliberately NOT retried. The entry probably landed; appending again
    // would duplicate it, and duplicating an entry in an append-only log is unfixable by
    // the writer — there is no delete. Losing a retry is recoverable; a phantom is not.
    if (last.outcome !== 'conflict') return last;
  }
  return last;
}
