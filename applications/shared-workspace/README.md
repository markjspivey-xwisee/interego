# Shared Workspace (`wsp:`)

A workspace where several people and several agents work together, without any of them
giving up custody of what they wrote.

## The one design decision

A comparable system — [Buzz, by Block](https://buzz.xyz) — states its model plainly: *the
relay is the single source of truth; all reads and writes flow through it.* A community
there **is one relay URL**, and membership is a row in that server's database.

Here a workspace **is one dereferenceable graph URL** whose content is the roster and the
governance, and the work is the union of **one append-only log per participant, each on
that participant's own pod**. Nobody moves their storage to join.

Two consequences follow, and they are the point:

- A workspace can **span organisations**, because joining needs no shared server — only a
  WebID, a pod, and a grant.
- A participant's record **outlives the workspace**, because it was never in it. Leaving
  does not delete your history; it stops your stream being folded in.

## What this costs, stated plainly

Every one of these is a thing Buzz does better, and a team feels the absence within an hour:

| | here | one-relay design |
|---|---|---|
| catching up on a workspace | one manifest read **per member** | one indexed query |
| full-text search across members | none | server-side index |
| presence, typing indicators | none | trivial |
| an append becoming readable | **~3–4s** (publish is deferred) | immediate |
| invite by code / link | none — a grant names a principal | yes |
| collaborative document editing | none | yes |

The deferral is the one that shapes the code most. `publish_context` returns
`status: "pending"` and the entry appears seconds later, so `appendEntry` waits for its own
entry to become readable before returning. It has a third outcome, `pending`, for when it
cannot confirm — see below.

## The three properties that do the work

**1. Membership is two-sided — as a *design*, not yet as an *enforced* property.** A grant
is meant to live on the convener's pod and an acceptance on the member's own, and a roster
entry exists only where both agree.

> ★ **An independent review refuted the enforcement.** `Grant` and `Acceptance` carry no
> provenance, and `foldRoster` checks only that the acceptance names the grant and the same
> principal. A convener can write *both halves on their own pod* and the fold produces a
> member who agreed to nothing. Worse: the live verifier that reported 13/13 **built both
> halves itself**, so the property was demonstrated by construction rather than
> established. The fix is to require and verify each record's `iep:authorshipProof` — the
> substrate can write it; this layer does not yet read it.

**2. A role is a ceiling, never a grant.** Effective capability is
`role.permits ∩ delegatedScope`. A Convener whose agent holds a read-only delegation still
cannot write. In a membership table, being an admin *is* the authority; here it is only a
bound on authority the principal already had. An unresolvable delegation yields **no**
capability, not full — otherwise an identity outage becomes a privilege grant.

> ★ The same review found this one broken in the aggregation rather than the intersection:
> a principal appearing **twice** in `scopes` silently last-won, so `[ReadOnly, ReadWrite]`
> granted append and revoke while the reverse order granted neither, with no divergence
> reported. Two rows for one principal is ordinary — a federated composer reads one agent
> registry per pod. Fixed: duplicate scope rows are **intersected** and reported.

**3. Divergence is reported, never resolved by guessing.** Two concurrent grant heads?
Name both, apply the **intersection**. Two stream heads? Refuse to append until it is
repaired. Last-write-wins on an authorization record silently escalates privilege, and an
entry written on top of a fork buries it. Under-privileging is an annoyance somebody
notices; over-privileging is a failure nobody notices.

## Layout

| file | what it is |
|---|---|
| [`src/roster.ts`](src/roster.ts) | the two-sided fold: `foldRoster`, `may`, `explain`. Pure. |
| [`src/stream.ts`](src/stream.ts) | one participant's log: `appendEntry`, `readStream`, `verifyChain`. |
| [`src/compose.ts`](src/compose.ts) | many pods read as one workspace: `composeWorkspace`, `resolveCitations`. |
| [`src/can.ts`](src/can.ts) | authority: `canAct`, `authorizeView`, `scopesFromRegistry`. |
| [`tools/verify-stream-live.ts`](tools/verify-stream-live.ts) | the stream, against the **live** relay. |
| [`tools/verify-compose-live.ts`](tools/verify-compose-live.ts) | two real identities, two real pods, one view. |
| [`tools/verify-can-live.ts`](tools/verify-can-live.ts) | a live refusal, at both layers that can refuse. |
| [`../../docs/applications/shared-workspace/wsp.ttl`](../../docs/applications/shared-workspace/wsp.ttl) | the vocabulary |
| [`../../docs/applications/shared-workspace/wsp-shapes.ttl`](../../docs/applications/shared-workspace/wsp-shapes.ttl) | SHACL, enforced at publish |
| [`../../docs/applications/shared-workspace/wsp-roles-default.ttl`](../../docs/applications/shared-workspace/wsp-roles-default.ttl) | five roles, as **data** |

Roles are data: a workspace wanting different governance publishes a different profile, not
a new release.

## The stream, and why it is shaped this way

Every entry is published under the **same stable stream IRI**, with
`auto_supersede_prior: false` and a single `iep:supersedes` declared in the content.

- **Catch-up is one read.** `discover_context{graph_iri}` returns the whole lineage from
  one manifest GET. Entries addressed individually would need one read each — and the
  reader would have to already know their URLs, which is the problem.
- **The chain is linear.** `auto_supersede_prior` links every entry to every earlier one:
  O(n²) supersedes triples in a structure that only grows. One declared prior keeps it
  linear.
- **Order is derived, not trusted.** `verifyChain` walks the links. A reader that sorted by
  timestamp would accept a chain whose links disagree with its clocks, and a log whose
  order can be changed by a clock is not an audit trail.

`seq` is not allocated — it is **derived** from the verified head, and the `if_match`
precondition is what makes deriving it safe. Two of an owner's own agents computing the
same `seq` cannot both land: the loser gets a 412.

> ★ That precondition was measurably broken until [PR #234](https://github.com/markjspivey-xwisee/interego/pull/234).
> `if_match` compared against the whole supersedes chain, so a stale ancestor satisfied it
> forever and both concurrent writers landed — while the response reported
> `precondition.passed: true`. A log built on it would have accepted duplicate sequence
> numbers and looked healthy. This is why `verifyChain` re-derives the order from the
> entries rather than assuming the appends were well-behaved.

### Append outcomes

| outcome | meaning |
|---|---|
| `appended` | landed **and confirmed readable**, with `visibleAfterMs` |
| `pending` | accepted, not confirmed within the budget. Probably fine. **Do not append again without re-reading** — deriving the next `seq` from a stale view is how one writer forks its own log. |
| `conflict` | someone else got there first (412), or the chain does not verify. The current head is attached. |
| `refused` | the shape gate or the substrate said no, with the code. |

`appendWithRetry` retries `conflict` only. It never retries `pending`: there is no delete
in an append-only log, so a duplicate entry is unfixable by the writer. A lost retry is
recoverable; a phantom is not.

## The composed view, and the two grades of order

`composeWorkspace` reads every member's stream — different pods, different owners,
different credentials — and merges them. It carries **two grades of ordering and never
conflates them**:

- **within a stream — verified.** Every entry declares its predecessor; the chain is
  walked and checked. Reordering it would require forging a descriptor.
- **across streams — advisory.** Merged on `validFrom`, tie-broken by content-CID so the
  result is at least deterministic. Two members' clocks can disagree and no merge fixes
  that. Anything that depends on *"A happened before B"* across members must say so in the
  **data** — an entry citing another entry is a fact; adjacency in this list is not.

A single-relay design can total-order everything because one server assigns the order.
This one cannot, and `crossStreamOrderIsAdvisory` is a non-omittable field so that anything
consuming the feed has had to see the claim.

### Partial availability is the point, so it has to be visible

When the single relay is down, a one-relay workspace is **entirely** gone. Here, one
member's pod being unreachable costs exactly that member's entries. That is a real
advantage and a real hazard — a view that silently omits an unreachable member looks
complete. So `unavailable` is first-class, `complete` is a boolean, and a failed stream is
**never** merged as an empty one.

> ★ That distinction was broken until the live run. `discover_context` reports an
> unreachable pod as **data**, not as a rejection — the tool result for a dead host is the
> plain string `"Error: fetch failed"`. Both that and a genuinely empty pod reduced to zero
> rows, so an unreachable member was rendered as an idle one. The per-stream isolation was
> fully covered by a double that *threw*, so it passed every test and never fired once
> against the real relay. Testing the double is not testing the composition.

A stream that reads but **does not verify** is reported and withheld from the feed —
merging it would place entries whose order within their own member is unknown beside
entries whose order is verified, with nothing to tell them apart.

## ★ Attribution is not verified, and that bounds everything below

`ComposedEntry.principal` is a **label the composer attaches from the members list**, not a
fact read from the record. Nothing in the read path derives authorship.

An independent review turned that into a live escalation: a member's stream IRI comes from
their **own acceptance**, and nothing required it to be under their own authority. Point it
at somebody else's pod and their entries were folded in *attributed to you* — an Observer's
writes laundered into a Contributor's, and with the recommended `readableMembers` pre-filter
the Observer's pod was never read, so nothing was even reported.

What is now checked: **each returned record must be served from the member's own pod**, and
entries served from elsewhere are withheld and reported.

> The first attempt at this defence range-checked the *stream IRI* against the pod, and
> rejected every real member on the first live run. A graph IRI lives under the relay's
> naming authority; its entries are stored on a pod. Conflating them is a category error,
> not a check — caught only because the live verifiers were re-run after the change. What that check **cannot** do is
help when `podUrl` was itself derived from the member's claim — asking the attacker where
the attacker lives. The honest fix is verifying each descriptor's own `iep:authorshipProof`,
which the substrate can write and this layer does not yet read.

**Until it does, every authority claim below is only as good as the `podUrl` the caller
supplied.**

## Where authority can actually be enforced

This is the honest part, and a one-relay design never has to think about it. There, every
write passes through one server, so an unauthorised one is **prevented**.

Here there is no chokepoint, and pretending otherwise would be security theatre.
**Nothing can stop a person writing to their own pod.** It is their pod, and the
substrate's gate answers a different question — *is this caller the owner?* — to which the
answer is yes.

So workspace authority is enforced at the **fold**. An entry from a member whose effective
capability lacks `append` is not blocked; it is **not counted**. It exists, signed by its
author, at its own URL — and `authorizeView` excludes it and says why.

| | one relay | here |
|---|---|---|
| unauthorised write | **prevented** | **possible, but inert** |
| what must be trusted | the relay, absolutely | nothing beyond the signatures on the records |
| who can audit it | nobody — it is a promise about a server | anyone who can read the records, member or not |

Two layers refuse, and they refuse different things. Both are demonstrated live by
[`tools/verify-can-live.ts`](tools/verify-can-live.ts) (13/13):

```
the substrate  bee writes to alice's pod       -> 403 scope_violation, nothing lands
the substrate  bee writes to HER OWN pod       -> succeeds. It is her pod.
the workspace  the fold reads both pods        -> 2 entries are readable
the workspace  authorizeView applies the roster -> 1 is workspace content;
                                                   the Observer's is reported, not deleted
```

The ceiling is not invented here: `scopesFromRegistry` reads the `ReadWrite` /
`PublishOnly` / `ReadOnly` scope the substrate's own agent registry records — the same one
the publish gate consults. Two authorization systems that each hold an opinion eventually
disagree, and the disagreement is discovered by whoever it lets through.

An unrecognised scope grants **nothing**. Defaulting the other way would turn every scope
name the substrate adds in future into a silent grant.

`complete` deliberately stays about **reachability**, not authority: folding the two
together would make a correctly-governed workspace permanently report itself incomplete,
and a flag that is always false is a flag nobody reads.

## Poly-vertical by citation, not integration

A `wsp:Reference` entry points at another vertical's record — a Foxxi credential, an
`agp:` intervention plan, an A2A engagement — **by its own IRI, without copying it**. The
cited record keeps its authorship, its shape and its access control. The verticals are not
integrated into the workspace; they are cited from it, which is why neither can drift out
of step with the other.

## Verifying it

```bash
npx vitest run tests/workspace-roster-fold.test.ts \
              tests/workspace-stream.test.ts \
              tests/workspace-compose.test.ts

# and against the live substrate — the doubles cannot verify the substrate
IEP_BEARER=<token-a> npx tsx applications/shared-workspace/tools/verify-stream-live.ts

# the composed view needs TWO real participants, because the relay's publish scope gate
# refuses a caller writing to someone else's pod — which is the design working
IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
  npx tsx applications/shared-workspace/tools/verify-compose-live.ts
```

The live verifier exists because a harness that stands in for a dependency cannot verify
that dependency. It checks that entries land in order, that catch-up is one read, that a
stale precondition is refused **and nothing lands**, that an entry missing `wsp:seq` is
refused **and nothing lands**, and that every entry id actually dereferences to its own
triples.

## Status

All six increments are built. What is verified, and what is not:

| | state |
|---|---|
| 1 roster, two-sided membership | built, 16 assertions |
| 2 per-participant stream | built, **20/20 live** |
| 3 composed cross-pod view | built, **14/14 live** across two identities on two pods |
| 4 authority at the fold | built, **13/13 live**, refused at both layers |
| 5 engagement `gone` + injectable engine | built, 11 assertions, deployed |
| 6 independent SHACL agreement | built, **in CI** — `@interego/core` vs pySHACL |

### Known defects, found by an independent adversarial review and not yet fixed

Reported here rather than left in a transcript. Each is real and reproducible.

| | severity |
|---|---|
| two-sided membership is **not enforced** — no provenance on grant/acceptance | high |
| authorship is **not verified** — attribution rests on the caller-supplied `podUrl` | high |
| a successful read whose rows all fail the `describes` filter looks *idle*, `complete: true` | medium |
| `explain()` names the role, not the divergence, when a grant chain has two heads | medium |
| `readableMembers` removes the *reported* half of read-time enforcement | medium |
| `headOf` reports a forked chain as an empty stream (`appendEntry` guards separately) | low-med |
| duplicate input rows manufacture phantom divergences | low-med |
| `wsp:seq` is written on every entry and never read back, so tail truncation verifies clean | low-med |
| a revoked agent still contributes its scope — `capabilitiesForScope` ignores `revoked` | low |

### What survived the same review

`verifyChain` was attacked with **1,052,736** generated chain shapes against an independent
oracle: **zero** false positives. `appendEntry`'s refusal to write onto an unverifying chain
held. `entryTurtle`'s IRI and literal escaping held for every position except `extraTriples`,
which is now constrained.

★ Two things are deliberately **not** claimed:

- **Engagements are still not durable.** #239 made the gap visible (an evicted id answers
  410 with the time, to its owner) and removed the substrate change that was blocking a
  fix. The default engine still does not survive a restart.
- **Cross-*organisation* is not verified.** What is verified is cross-**pod** and
  cross-**identity**: two wallets, two pods, two credentials, composed into one view. A
  second organisation means a second relay and a second identity provider, which nothing
  here has exercised.

There is deliberately **no CRDT**. The substrate already stores immutable
content-addressed records, so per-resource compare-and-swap with a **visible** conflict is
the honest fix. [`spec/CRDT-OFFLINE-MERGE.md`](../../spec/CRDT-OFFLINE-MERGE.md) remains an
unimplemented design note.
