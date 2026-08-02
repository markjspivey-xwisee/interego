/**
 * Which descriptors are the CURRENT heads of a supersession chain.
 *
 * ── WHY THIS EXISTS AS ITS OWN MODULE ────────────────────────────────────────
 *
 * The relay had this logic twice, and only one copy was right.
 *
 * `get_current_head` — the READ half of compare-and-swap — computes the frontier
 * correctly: an entry is a head iff no other entry describing the same graph declares
 * `iep:supersedes` at it.
 *
 * The WRITE half did not. `publish_context`'s `if_match` precondition compared the
 * caller's assertion against `descriptor.supersedes`, which under `auto_supersede_prior`
 * holds EVERY prior version of the graph, not just the head. Membership in that list is
 * not a compare-and-swap: an ancestor stays in it forever, so the assertion "the head I
 * read is still the head" passed even when it demonstrably was not.
 *
 * Concretely, with versions v0 → v1 already published:
 *
 *     publish v2, if_match = v0   →   precondition.passed: true      (observed live)
 *
 * That is the lost-update the precondition exists to prevent. Two writers who both read
 * v1 both succeed; the second silently overwrites a state it never saw. Worse than an
 * absent guard, because the response affirms `precondition.passed` — a caller that
 * checks the field it was told to check is told the swap was atomic when it was not.
 *
 * The two halves of one CAS have to agree on what "head" means, so they now share this
 * function rather than each carrying an opinion.
 *
 * ── WHY THE MANIFEST IS ENOUGH ───────────────────────────────────────────────
 *
 * The manifest mirrors each entry's `iep:supersedes`, so the frontier is computable
 * from the single manifest GET the publish path already performs. No descriptor bodies
 * are fetched to answer this question.
 *
 * ── ★ WHY THERE IS NO `exclude` ──────────────────────────────────────────────
 *
 * There was one, and the caller chose its value. `publish_context` takes an unvalidated
 * `descriptor_id`; the relay turned it into a descriptor URL (last `:`/`#` segment,
 * URI-encoded) and passed that as `exclude`. Dropping an entry removes it BOTH as a
 * candidate head AND as a source of `supersedes` edges, so naming the live head made its
 * ancestor a head again — and a writer holding only the stale token then passed:
 *
 *     manifest: v0, v1 (supersedes v0).  Real head: v1.
 *     publish_context{ if_match: v0, descriptor_id: "urn:x:<v1's slug>" }
 *       → exclude = v1 → describing = [v0] → heads = [v0] → v0 accepted as the head
 *
 * The same line refused a legitimate writer from the other direction: a client using a
 * STABLE `descriptor_id` for idempotency excluded its own only entry, so `heads` was `[]`
 * and every `if_match` it could possibly send was refused with "every descriptor for this
 * graph is superseded" — a state no value recovers from.
 *
 * The exclusion was only ever there to stop a descriptor superseding ITSELF. That belongs
 * on the supersedes list being built, not on the frontier being measured, so it lives in
 * `priorVersionsFor` below; `casSelfOverwriteRefusal` handles the case the two cannot both
 * be satisfied. The option is gone rather than fixed so no later caller can re-supply it.
 */

/**
 * Is this `if_match` value usable at all?
 *
 * ★ Separate from "is the assertion correct", and it has to be, because the two failures
 * deserve opposite answers. A WRONG head is 412 and retrying after a re-read fixes it. An
 * UNUSABLE value — JSON null, an empty string, a number — can never work, however many
 * times it is sent.
 *
 * Before this existed, an unusable value fell through: both `ifMatchSupersedes` and
 * `ifMatchCid` ended up undefined (null and '' are falsy, so neither was spread into the
 * publish options), the substrate gate threw its internal "at least one must be set"
 * contract error, and the relay reported that as `503 precondition_unavailable,
 * retryable: true`. A caller that believes `retryable` loops until it gives up, and what it
 * gives up on is its own compare-and-swap.
 *
 * Observed while building the workspace stream, from a caller passing the head it had —
 * which is legitimately null on an empty chain. Omitting `if_match` is how you say "this is
 * the first version"; sending an empty one is not.
 */
export function classifyIfMatch(value: unknown): 'absent' | 'usable' | 'unusable' {
  if (value === undefined) return 'absent';
  if (typeof value !== 'string' || value.trim().length === 0) return 'unusable';
  return 'usable';
}

/** What the publish request as a whole permits: an if_match plus the graph it is about. */
export type CasRequest =
  /** No precondition asserted. Publish normally. */
  | { readonly kind: 'absent' }
  /** A precondition was asserted with a value no retry can turn into a head. 400. */
  | { readonly kind: 'unusable' }
  /** A usable if_match, but no graph to resolve a head WITHIN. 400 — see below. */
  | { readonly kind: 'ungraphed' }
  /**
   * A graph_iri that is not the literal IRI it will be compared against — today, one with
   * surrounding whitespace. 400, with the reason. See `classifyCasRequest`.
   */
  | { readonly kind: 'unpadded-graph-required'; readonly graphIri: string }
  /** Enough to compute the frontier and hold the caller to it. */
  | { readonly kind: 'evaluable'; readonly ifMatch: string; readonly graphIri: string };

/**
 * Can this `if_match` actually be checked against a chain?
 *
 * ★ A HEAD IS ONLY DEFINED RELATIVE TO A GRAPH. `supersessionFrontier` needs a graph IRI to
 * pick the entries that form the chain; with no graph there is no chain, no frontier, and
 * nothing for the assertion to be compared against.
 *
 * The relay used to reach that state and keep going. `casHeads` was computed only when
 * `args.graph_iri` was truthy, and `checkSupersessionPrecondition` skips the head check
 * entirely when `currentHeads` is undefined — so a publish with an `if_match` and NO
 * `graph_iri` silently fell back to the pre-fix membership test, the exact test the frontier
 * exists to replace. `graph_iri` is marked `required` in the tool schema, but `tools/call`
 * performs no schema validation, so omitting it is one keystroke.
 *
 * No chain takeover was demonstrated from this — a descriptor with no `graph_iri` describes
 * no graph, and `supersessionFrontier` only lets DESCRIBING entries retire a head — so this
 * is a guard that turns itself off, not an exploit. It still has to go: the whole point of
 * the fix is that "we could not evaluate your precondition" never renders as
 * `precondition.passed: true`.
 *
 * 400, not the 503 a failed manifest read gets: a manifest read can succeed next time, and
 * a request that named no graph will name no graph however often it is resent.
 *
 * ★ AND A PADDED graph_iri IS REFUSED RATHER THAN QUIETLY TRIMMED. This validated
 * `graphIri.trim()` and then returned `graphIri` — so ` urn:graph:x ` was `evaluable`,
 * `describes.includes(' urn:graph:x ')` matched nothing, and the caller got the 412 that
 * reads "(none — every descriptor for this graph is superseded)": the unrecoverable-looking
 * answer this whole module exists to stop emitting, for one stray space.
 *
 * Refused rather than trimmed because trimming HERE would only move the disagreement. The
 * frontier would be computed over the trimmed IRI while the descriptor being written still
 * declares `iep:describes` from the caller's raw argument — so the precondition would be
 * evaluated against one chain and the write would join another. A graph IRI is compared
 * literally everywhere it is compared at all; the honest answer is to say the argument is
 * not the IRI it looks like, and let the caller send the IRI.
 */
export function classifyCasRequest(ifMatch: unknown, graphIri: unknown): CasRequest {
  const value = classifyIfMatch(ifMatch);
  if (value === 'absent') return { kind: 'absent' };
  if (value === 'unusable') return { kind: 'unusable' };
  // Whitespace-only is rejected for the same reason it is rejected in `if_match`: it is
  // not an IRI, and `describes.includes('  ')` would match nothing, silently emptying the
  // frontier instead of saying why.
  if (typeof graphIri !== 'string' || graphIri.trim().length === 0) return { kind: 'ungraphed' };
  if (graphIri !== graphIri.trim()) return { kind: 'unpadded-graph-required', graphIri };
  return { kind: 'evaluable', ifMatch: ifMatch as string, graphIri };
}

/** The error envelope `publish_context` returns verbatim. */
export interface CasRefusal {
  readonly error: string;
  readonly code: number;
  readonly retryable: boolean;
  readonly message: string;
}

/**
 * The response for a precondition that cannot be evaluated — or `null` to proceed.
 *
 * ★ Lives here, not inline in the handler, so the WIRE ANSWER is testable. `server.ts`
 * starts an HTTP listener on import, so a refusal written inline there is a branch no test
 * can reach; both holes closed in this file were "the branch that quietly did not run",
 * and a fix whose only witness is a predicate one call upstream repeats that shape.
 *
 * `retryable` is the field callers act on, so it carries the whole distinction:
 *   - 400 / false — no resend of this request can succeed. The value is not a head, or
 *     names no graph to be a head of.
 *   - 503 / true (raised by the handler, which knows the pod) — we could not read the
 *     manifest. That can work next time.
 * The one answer never available is silence, which is what both of these used to be.
 */
export function casRefusal(request: CasRequest, ifMatch: unknown): CasRefusal | null {
  if (request.kind === 'unusable') {
    const received = ifMatch === null
      ? 'null'
      : typeof ifMatch === 'string' ? 'an empty string' : typeof ifMatch;
    return {
      error: 'invalid_if_match',
      code: 400,
      retryable: false,
      message:
        'if_match must be a non-empty descriptor URL (https://….ttl) or content-CID (bafkrei…). '
        + `Received ${received}. `
        + 'Omit if_match entirely when there is no prior head to gate on — an absent precondition '
        + 'is how you say "this is the first version"; an empty one is not.',
    };
  }
  if (request.kind === 'unpadded-graph-required') {
    return {
      error: 'graph_iri_not_canonical',
      code: 400,
      retryable: false,
      message:
        `graph_iri was received as ${JSON.stringify(request.graphIri)} — with surrounding `
        + 'whitespace. A graph IRI is compared literally against each descriptor\'s '
        + `iep:describes, so that value names a different graph from ${JSON.stringify(request.graphIri.trim())} `
        + 'and its chain has no descriptors at all. Refused rather than trimmed: trimming it '
        + 'here would evaluate the precondition against one chain while the descriptor this '
        + 'publish writes joins another. Send the IRI without the padding.',
    };
  }
  if (request.kind === 'ungraphed') {
    return {
      error: 'precondition_not_evaluable',
      code: 400,
      retryable: false,
      message:
        'if_match was supplied without a graph_iri, so there is no chain to resolve a current '
        + 'head within and the precondition cannot be evaluated. Send the graph_iri the '
        + 'if_match descriptor is a version of, or omit if_match — an if_match that cannot be '
        + 'checked must never be reported as satisfied.',
    };
  }
  return null;
}

/** The manifest fields this computation needs. Structural, so both callers' types fit. */
export interface FrontierEntry {
  readonly descriptorUrl: string;
  readonly describes: readonly string[];
  readonly supersedes?: readonly string[];
}

export interface Frontier {
  /**
   * Entries nothing else supersedes. One is the normal case; more than one means the
   * chain forked — reported, never silently resolved, for the same reason the roster
   * fold reports divergence: picking a winner between two states is a guess, and a
   * guess about which write survived is not something a storage layer may make.
   */
  readonly heads: readonly string[];
  /** Ancestors — still dereferenceable, still cited, but no longer the head. */
  readonly superseded: readonly string[];
  /** Every entry describing this graph, heads and ancestors alike. */
  readonly all: readonly string[];
}

/**
 * Compute the supersession frontier for one graph IRI.
 *
 * @param entries    manifest entries for the pod
 * @param graphIri   the graph whose chain we want
 * @param options.normalize  URL canonicaliser. Manifest entries and `iep:supersedes`
 *   targets can carry either the internal-FQDN host or the legacy public one depending
 *   on when they were written. Comparing raw strings across that boundary would find no
 *   superseder and report every ancestor as a live head — which reads as a forked chain
 *   and, on the write path, would let a stale assertion through exactly as before. The
 *   caller supplies the same normaliser it uses elsewhere; identity is the default.
 */
export function supersessionFrontier(
  entries: readonly FrontierEntry[],
  graphIri: string,
  options: { readonly normalize?: (url: string) => string } = {},
): Frontier {
  const norm = options.normalize ?? ((u: string) => u);

  const describing = entries.filter(e => e.describes.includes(graphIri));

  // An entry is superseded iff some OTHER describing entry points at it. Restricting the
  // superseder set to describing entries is deliberate: a descriptor for an unrelated
  // graph that happens to cite this one has not taken over this chain, and letting it
  // retire a head would make an unrelated publish silently invalidate a live CAS token.
  const superseded = new Set<string>();
  for (const e of describing) {
    for (const s of e.supersedes ?? []) superseded.add(norm(s));
  }

  const heads: string[] = [];
  const dead: string[] = [];
  for (const e of describing) {
    (superseded.has(norm(e.descriptorUrl)) ? dead : heads).push(e.descriptorUrl);
  }

  return { heads, superseded: dead, all: describing.map(e => e.descriptorUrl) };
}

/**
 * The `iep:supersedes` list a publish of `selfDescriptorUrl` should declare.
 *
 * Every descriptor already describing this graph, minus the one being written. That is
 * what `auto_supersede_prior` means: the new version links ALL priors, not just the head,
 * so a reader arriving at any ancestor can walk forward.
 *
 * ★ MINUS ITS OWN URL, COMPARED AS A URL. The relay filtered on `descriptor_id` instead —
 * a `urn:iep:<pod>:<ts>`, while manifest entries carry `https://…/x.ttl` URLs. The two
 * shapes never compare equal, so the self-filter never fired once. It went unnoticed
 * because the relay-generated id is fresh per call, so there is normally no self entry to
 * filter. Supply a stable `descriptor_id` and the entry IS there: the descriptor lands in
 * its own supersedes list, `supersessionFrontier` sees a self-superseding entry, and the
 * chain reports NO head from then on — every later `if_match` refused, none recoverable.
 *
 * Also the recompute point for a deferred publish: the list is only correct as of the
 * manifest read it came from, and a deferred write happens later. See the Phase B
 * recompute in `handlePublishContext`.
 */
export function priorVersionsFor(
  entries: readonly FrontierEntry[],
  graphIri: string,
  selfDescriptorUrl: string,
  normalize?: (url: string) => string,
): string[] {
  const norm = normalize ?? ((u: string) => u);
  const self = norm(selfDescriptorUrl);
  return entries
    .filter(e => e.describes.includes(graphIri) && norm(e.descriptorUrl) !== self)
    .map(e => e.descriptorUrl);
}

/**
 * The `supersedes` a DEFERRED publish should actually write — or `null` for "unchanged".
 *
 * ★ A DEFAULT PUBLISH DECIDES ITS SUPERSEDES LIST IN ONE CRITICAL SECTION AND WRITES IT IN
 * ANOTHER. The relay reads the manifest under a per-pod mutex, builds the descriptor, hands
 * the caller a 202, and performs the write from a background task that re-acquires the
 * mutex. That acquisition is strict FIFO and is requested from INSIDE the first one, so it
 * queues behind every request that arrived in the meantime — and those get to write first:
 *
 *     t0  W1 reads: head v1, supersedes [v0, v1]
 *     t3  W2 (queued after W1, running before W1's write) publishes v2 superseding v1
 *     t4  W1 writes with [v0, v1] — a list that predates v2
 *
 * Nothing overwrites anything, which is why it is not a lost update; what it produces is a
 * FORK. v2 and W1's version each supersede v1 and neither supersedes the other, so the
 * chain has two heads, `get_current_head` reports a divergence nobody asked for, and the
 * next compare-and-swap has no single value to assert.
 *
 * Re-deciding against the manifest as it stands AT WRITE TIME makes W1 link v2 as well and
 * the chain stays linear with the last writer as its head — which is what publishing
 * without a precondition means.
 *
 * ★ "NOTHING MOVED" IS A QUESTION ABOUT MEMBERS, NOT ABOUT ORDER. The comparison was
 * element-wise and positional, so a manifest that merely came back in a different order
 * — and it can: `getCachedManifest` unions the append-only container with the monolithic
 * manifest through a Map, and append-only entries are written asynchronously — produced a
 * "changed" verdict and a rewrite for a supersedes list with identical contents. Comparing
 * membership means an uncontended write stays byte-for-byte the descriptor whose CID the
 * caller was handed in the 202, which is the property that matters; `iep:supersedes` is a
 * set of triples, so the order this preserves carries no meaning beyond those bytes.
 *
 * ★ WHAT THIS DOES NOT FIX, STATED PLAINLY: when the members really HAVE changed, the
 * descriptor that lands is not the descriptor the 202's CID was computed over. That is
 * unavoidable here — the caller was answered before the write was decided — so it is
 * handled at the call site instead: the deferred publish marks its CID provisional and
 * pins the bytes it actually wrote. See `handlePublishContext`.
 *
 * Only valid where the frozen list CAME from the manifest. Under `auto_supersede_prior:
 * false` the triples are the caller's own content and are not ours to revise, so the caller
 * must not call this.
 */
export function reDecidedSupersedes(
  frozen: readonly string[],
  contentSupersedes: readonly string[],
  freshEntries: readonly FrontierEntry[],
  graphIri: string,
  selfDescriptorUrl: string,
  normalize?: (url: string) => string,
): readonly string[] | null {
  const merged = [
    ...new Set([
      ...contentSupersedes,
      ...priorVersionsFor(freshEntries, graphIri, selfDescriptorUrl, normalize),
    ]),
  ];
  // `merged` is already de-duplicated (it is built from a Set), so comparing its length
  // against the DISTINCT frozen targets is a set equality test. A frozen list carrying a
  // duplicate still compares equal and is written unchanged — duplicate triples say nothing
  // extra, and preserving the caller's bytes is worth more than tidying them.
  const frozenTargets = new Set(frozen);
  if (merged.length === frozenTargets.size && merged.every(u => frozenTargets.has(u))) return null;
  return merged;
}

/**
 * Refuse a compare-and-swap whose own write would land ON a member of the chain.
 *
 * ★ `descriptor_id` DECIDES THE DESCRIPTOR URL, so a caller can aim this publish at a URL
 * the chain already occupies. Two things then cannot both be true:
 *
 *   - the write is a NEW version, which is what `iep:supersedes` and therefore the whole
 *     frontier assume — every version has its own URL and the chain is the edges between
 *     them; and
 *   - the write overwrites an existing version in place, destroying the very descriptor
 *     the `if_match` names as the state being swapped from.
 *
 * Left unrefused it is not merely confusing, it is corrupting. Aim a publish at an
 * ANCESTOR's URL while holding the real head token and the precondition passes on the
 * merits (the head genuinely is the head), then the write replaces the ancestor with a
 * descriptor that supersedes the head — the head supersedes the ancestor, the ancestor now
 * supersedes the head, and `supersessionFrontier` reports no head at all, permanently.
 * Aim it at the HEAD's URL and `priorVersionsFor` correctly refuses to let it supersede
 * itself, leaving an empty supersedes list and a 412 that reads as if the caller's token
 * were stale when it was perfectly current.
 *
 * So: say what actually happened, and say it before anything is written. 409 rather than
 * 412 because nothing about the caller's ASSERTION was wrong — the request is
 * self-contradictory. Non-retryable for the same reason: resending it re-collides.
 *
 * Scoped to publishes that asserted an `if_match`. Republishing to a descriptor URL that
 * already holds a version of THE SAME graph, with no precondition, is a legitimate
 * idempotent overwrite, and refusing it would break callers doing nothing wrong.
 *
 * ★ THE SCOPE OF THIS CHECK IS STILL ONE GRAPH — DELIBERATELY, AND NO LONGER ALONE.
 *
 * It inspects only entries whose `describes` contains `graphIri`, because everything it
 * reasons about is chain-shaped: which descriptor the `if_match` names, which version the
 * write would destroy, which supersedes edge would be missing afterwards. None of that is
 * defined for a descriptor belonging to a different graph.
 *
 * The case it does NOT see — `descriptor_id` slugging onto a descriptor of some OTHER graph
 * on the same pod, silently removing that graph's head — is real and was measured
 * (`scratchpad/adv-cas.test.ts` CAS-A). It is now refused by `foreignDescriptorOverwriteRefusal`
 * below, which is pod-wide and runs whether or not an `if_match` was sent. The two are only
 * ever reached through `descriptorWriteCollisionRefusal`, so a caller cannot be told the
 * chain is clear while the URL belongs to someone else.
 *
 * The message used to tell the caller to "send a descriptor_id that does not resolve to an
 * existing version", which claimed a completeness nothing then had. It now names the chain
 * it looked at and the sibling that covers the rest.
 */
export function casSelfOverwriteRefusal(
  entries: readonly FrontierEntry[],
  graphIri: string,
  selfDescriptorUrl: string,
  normalize?: (url: string) => string,
): CasRefusal | null {
  const norm = normalize ?? ((u: string) => u);
  const self = norm(selfDescriptorUrl);
  // Same raw-vs-absolutised mismatch as in `foreignDescriptorOverwriteRefusal`, and here it
  // fails the OTHER way: `describes` has been through `new URL(u, manifestUrl).href` in
  // `discover()` and `graphIri` has not, so `includes` MISSED a version of the caller's own
  // chain and let the swap overwrite it in place — the exact destruction this refusal
  // exists to prevent. A missed match here is a false ALLOW, not a false refusal.
  const claimed = normalizeGraphIri(graphIri);
  const collides = entries.some(
    e => e.describes.some(g => normalizeGraphIri(g) === claimed) && norm(e.descriptorUrl) === self,
  );
  if (!collides) return null;
  return {
    error: 'descriptor_id_collides_with_chain',
    code: 409,
    retryable: false,
    message:
      `This publish would be written to <${selfDescriptorUrl}>, which is already a version of `
      + `<${graphIri}> on this pod. A compare-and-swap over a supersession chain writes a NEW `
      + 'version that supersedes the head; overwriting an existing version in place would '
      + 'destroy the state the if_match names and leave the chain with no resolvable head. '
      + 'Omit descriptor_id so a fresh URL is minted (the normal case) — or, if you really do '
      + 'mean to overwrite that resource, drop if_match and accept that it is not a swap. '
      + `This check covers the chain for <${graphIri}>. A descriptor_id landing on a `
      + 'descriptor of some OTHER graph is refused separately as '
      + 'descriptor_id_collides_with_other_graph, with or without an if_match; the two are '
      + 'decided together so neither can be reached without the other.',
  };
}

/**
 * Refuse a publish whose descriptor URL is already occupied by ANOTHER graph's descriptor.
 *
 * ★ THIS IS THE HOLE `casSelfOverwriteRefusal` DOES NOT AND SHOULD NOT SEE. `descriptor_id`
 * is an unvalidated `publish_context` argument, and `slugFromIri`
 * (packages/solid/src/client.ts) turns it into a filename by taking the last `/`, `:` or `#`
 * segment. Every descriptor on a pod lands in one flat `context-graphs/<slug>.ttl`
 * namespace, so the caller picks the destination URL outright — including a URL that already
 * holds a descriptor for a graph they are not publishing. `publish()` PUTs there
 * unconditionally, the manifest row is rewritten to the new `iep:describes`, and the graph
 * that owned it loses that descriptor. If it was that graph's only head, the graph has no
 * head at all and no `get_current_head` caller can tell what happened. Measured, not
 * theorised: `scratchpad/adv-cas.test.ts` CAS-A, where G2's frontier went `[other-head]` → `[]`.
 *
 * ★ AND IT APPLIES WITH OR WITHOUT `if_match`. The chain-scoped refusal is gated on a
 * precondition because it is a statement about a swap. This one is not: it is "that resource
 * is not yours to replace", which does not become true because the caller declined to assert
 * anything. Without a precondition the damage is strictly worse — nothing else on the path
 * reads the destination first — so gating it the same way would leave the guard off in
 * exactly the case that needs it.
 *
 * Refusal, not merge. A descriptor is a single document with one `iep:describes` set; there
 * is no way to write this publish that also keeps the other graph's version at that URL. And
 * silently choosing a different URL would be worse than either: the caller supplied
 * `descriptor_id` precisely to control the URL, and the honest answer to "I cannot give you
 * that URL" is to say so.
 *
 * ★ WHAT THIS DOES NOT COVER, STATED PLAINLY. Its only evidence is the manifest, so:
 *   - a resource sitting at that URL which the manifest does not list — not a descriptor, or
 *     a descriptor whose manifest row was lost — is not seen, and is still overwritten;
 *   - an entry with an EMPTY `describes` belongs to no graph, so nothing here objects to
 *     replacing it. There is no chain to break.
 * It is a guard on graph ownership of a URL, not a general "this resource exists" check.
 *
 * `graphIri` is optional because `graph_iri` is a `publish_context` argument that
 * `tools/call` does not schema-validate. Omitting it means the descriptor being written
 * describes nothing, so EVERY graph described at that URL is foreign and the write is
 * refused — the strict reading, and the right one: a publish that names no graph has no
 * claim on a URL that holds one.
 */
/**
 * Put a graph IRI into the one form both sides of an ownership comparison can be in.
 *
 * ★ WHY THE COMPARISON NEEDED THIS AT ALL. `discover()` maps every manifest `describes`
 * through `new URL(u, manifestUrl).href` so downstream consumers get something `fetch()` can
 * take. The caller's `graph_iri` arrives verbatim from `tools/call`. Comparing an
 * already-normalised string against a raw one made WHATWG's own rewrites look like a
 * different graph: `https://graphs.example.org` (raw) against `https://graphs.example.org/`
 * (stored) refused an honest republish of the caller's OWN graph, on the one path this gate
 * was told not to break.
 *
 * Both sides go through the same function, so no two stored values can be merged that
 * `discover()` had not already merged — the direction that would turn a false refusal into a
 * false ALLOW. Unparseable input (a relative IRI, with no base available here) is returned
 * untouched, so it fails to match an absolute stored value and the write is refused: the
 * safe direction, and the same answer as before.
 */
function normalizeGraphIri(iri: string): string {
  try { return new URL(iri).href; } catch { return iri; }
}

export function foreignDescriptorOverwriteRefusal(
  entries: readonly FrontierEntry[],
  graphIri: string | undefined,
  selfDescriptorUrl: string,
  normalize?: (url: string) => string,
): CasRefusal | null {
  const norm = normalize ?? ((u: string) => u);
  const self = norm(selfDescriptorUrl);
  const claimed = graphIri === undefined ? undefined : normalizeGraphIri(graphIri);
  // A descriptor may describe several graphs, so "foreign" is per-graph, not per-entry: an
  // entry describing [G1, G2] overwritten by a G1-only publish still strands G2. Collecting
  // the graphs rather than short-circuiting also lets the message name them, which is the
  // difference between a caller re-picking a slug and a caller re-reading the manifest.
  const foreign = new Set<string>();
  for (const e of entries) {
    if (norm(e.descriptorUrl) !== self) continue;
    // The stored side has already been through `new URL(u, manifestUrl).href` in
    // `discover()`; the caller's side has not. Compared raw, an honest same-graph republish
    // to a stable descriptor id was refused as somebody else's URL — `graph_iri
    // "https://graphs.example.org"` against the stored `"https://graphs.example.org/"`.
    // `normalizeGraphIri` puts both through the same transform; the message still names the
    // graph as it is stored, because that is the string a caller has to match.
    for (const g of e.describes) if (normalizeGraphIri(g) !== claimed) foreign.add(g);
  }
  if (foreign.size === 0) return null;
  const named = [...foreign].map(g => `<${g}>`).join(', ');
  return {
    error: 'descriptor_id_collides_with_other_graph',
    code: 409,
    retryable: false,
    message:
      `This publish would be written to <${selfDescriptorUrl}>, which already holds a `
      + `descriptor for ${named} — ${graphIri === undefined
        ? 'and this publish names no graph_iri at all'
        : `not <${graphIri}>`}. Writing it would replace that descriptor in place and remove `
      + 'it from that graph\'s supersession chain; if it was the chain\'s only head, the graph '
      + 'would be left with no resolvable head and nothing would report why. descriptor_id '
      + 'becomes the filename via its last "/", ":" or "#" segment, and every descriptor on '
      + 'this pod shares one flat container — so two unrelated ids ending in the same segment '
      + 'name the same resource. Omit descriptor_id so a fresh URL is minted (the normal '
      + 'case), or choose one whose final segment is not already taken. Refused with or '
      + 'without an if_match: this is about who owns the URL, not about a swap.',
  };
}

/**
 * The single collision gate `publish_context` calls before it writes anything.
 *
 * ★ ONE ENTRY POINT SO THE TWO REFUSALS CANNOT DRIFT APART. They answer different questions
 * about the same predicted URL — "is this a version of the chain I am swapping over" and "is
 * this someone else's graph" — and they have different trigger conditions, the first only
 * under an `if_match` and the second always. Left as two call sites in `handlePublishContext`
 * that difference is one `if` away from being wrong in the direction that costs data, which
 * is how the cross-graph hole survived three rounds of review: the chain-scoped check looked
 * like the collision check and nothing named what it left out.
 *
 * Foreign ownership is reported FIRST when both apply — an entry describing [G1, G2]
 * overwritten by a G1 publish under an `if_match` collides on both counts, and the answer
 * that matters is the one about the graph that is not in the conversation.
 *
 * `casGraphIri` is present iff a precondition was asserted, and carries the graph it names
 * (`CasRequest.graphIri` — already validated as an unpadded, non-empty IRI). Passing the
 * graph rather than a boolean is what keeps the chain-scoped check from being reachable with
 * no graph to scope it to.
 */
export function descriptorWriteCollisionRefusal(
  entries: readonly FrontierEntry[],
  graphIri: string | undefined,
  selfDescriptorUrl: string,
  options: {
    readonly casGraphIri?: string;
    readonly normalize?: (url: string) => string;
  } = {},
): CasRefusal | null {
  const foreign = foreignDescriptorOverwriteRefusal(
    entries, graphIri, selfDescriptorUrl, options.normalize,
  );
  if (foreign) return foreign;
  if (options.casGraphIri === undefined) return null;
  return casSelfOverwriteRefusal(
    entries, options.casGraphIri, selfDescriptorUrl, options.normalize,
  );
}
