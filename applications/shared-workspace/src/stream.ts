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
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not retry. A 412 is returned as a value, named, with the current head attached.
 * Retrying is usually right for a log, and {@link appendWithRetry} does it — but under a
 * name the caller had to type, because a retry loop that hides concurrency is how a
 * conflict becomes a mystery.
 */

import { escapeTurtleLiteral, turtleIriRef } from '@interego/core';

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
  /** Extra Turtle predicates for the entry subject, already serialized by the caller. */
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

export type AppendResult =
  | { readonly outcome: 'appended'; readonly entry: AppendedEntry; readonly visibleAfterMs: number }
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
}

/** The I/O this module needs, injected — so the CAS discipline is testable without a pod. */
export interface StreamDeps {
  /** `publish_context`. Returns the parsed tool result. */
  readonly publish: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** `discover_context`. Returns the parsed tool result. */
  readonly discover: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
}

// ── Rendering ────────────────────────────────────────────────────────────────

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
  for (const t of args.draft.extraTriples ?? []) lines.push(`  ${t} ;`);

  // Close the predicate list.
  const last = lines[lines.length - 1]!;
  lines[lines.length - 1] = last.replace(/ ;$/, ' .');
  return lines.join('\n') + '\n';
}

// ── Reading ──────────────────────────────────────────────────────────────────

const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

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
  return asArray(res.entries)
    .map(e => e as Record<string, unknown>)
    .filter(e => asArray(e.describes).includes(ref.graphIri))
    .map(e => ({
      descriptorUrl: String(e.descriptorUrl ?? ''),
      cid: asString(e.cid),
      validFrom: asString(e.validFrom),
      supersedes: asArray(e.supersedes).filter((s): s is string => typeof s === 'string'),
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
  /** True only when there is exactly one head, one root, and every row is on the path. */
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

  return {
    ordered,
    heads,
    merges,
    danglingLinks: dangling,
    // ★ A dangling link makes the chain NOT intact even when everything present walks
    // cleanly. Rows [v1 ← v2] where v1 declares an absent v0 orders perfectly and covers
    // every row it has — and the reader is still missing the beginning of the log.
    // Calling that intact would be a false assurance handed to exactly the caller who
    // asked whether it could trust the history.
    intact:
      heads.length === 1
      && merges.length === 0
      && dangling.length === 0
      && ordered.length === rows.length
      && rows.length > 0,
  };
}

// ── Appending ────────────────────────────────────────────────────────────────

/** The precondition token for the next append, derived from a verified chain. */
export function headOf(rows: readonly StreamRow[]): { url: string | null; seq: number } {
  const report = verifyChain(rows);
  if (report.ordered.length === 0) return { url: null, seq: 0 };
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
    ...(head.url ? { if_match: head.url } : {}),
    ...(ref.podName ? { pod_name: ref.podName } : {}),
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
      return { outcome: 'appended', entry: { seq, descriptorUrl, cid: asString(res.cid) }, visibleAfterMs: waited };
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
      };
    }
    await sleep(deps, VISIBILITY_POLL_MS);
  }
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
