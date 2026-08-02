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
| …with attribution verified | **+ one `get_descriptor` per entry** | authorship is the server's word |
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

**1. Membership is two-sided, and `foldRoster` can now be made to check it — including what
each half SAYS.** A grant lives on the convener's pod and an acceptance on the member's own,
and a roster entry exists only where both agree — *and* where each half was signed by the
party it claims to come from, *and* where every field was read out of the record rather than
typed by whoever called the fold.

> ★ **What that last clause costs, stated before the claim is made.** It holds only under
> `attestation: { …, requireFieldBinding: true }`, only for rows produced by
> [`src/membership.ts`](src/membership.ts)'s readers, and it does **not** establish that the
> convener named in the policy is the workspace's convener — see residual gap 6. The
> end-to-end demonstration in `verify-can-live.ts` §8 is written and **has not been run
> against the live substrate**; no bearer pair has been available.

> ★ **An independent review refuted the original claim, and it was right.** `Grant` and
> `Acceptance` carried no provenance: the only cross-checks were that the acceptance names
> the grant and repeats the principal, both of which the convener types. A convener could
> write *both halves on their own pod* and the fold produced a member who agreed to nothing.
> Worse, the live verifier that reported 13/13 **built both halves itself**, so the property
> was demonstrated by construction.

Both records now carry an `Attestation` — the substrate's own answer to *who signed this* —
and `foldRoster` takes an optional `attestation: { convener, signerOf }` policy. Under it,
a grant not traceable to the convener and an acceptance not traceable to the member it names
are **refused and listed in `roster.unattested`**, never folded and never dropped.

Two things make that hard to skip:

- `Roster.membershipGrade` is **non-omittable** — `'attested'` or `'asserted'`. A caller
  cannot obtain `members` without also holding the answer to *who checked?*, the same reason
  `crossStreamOrderIsAdvisory` exists.
- Without a policy, `Roster.attributionNote` says in words that *"a convener who holds both
  records could have written both halves and this list would look identical."*

`AttestationPolicy.convener` is a required field, not an optional one: *"require attestation
but do not say against whom"* has no safe answer, and a field that can be left out is a
field that gets left out.

> ★★ **Turning that policy on granted MORE authority than leaving it off, and a second review
> found it.** The gate filtered refused rows out of the grant list *before* the revocation
> check, so a revocation nobody could attest was not refused — it was **erased**, and the
> member kept everything. A transient `get_descriptor` failure silently reinstated a revoked
> member, and nothing in `unattested`, `explain()` or `attributionNote` said a revocation had
> failed to take effect. Three more of the same shape were present: a refused grant head
> deleted the narrower half of an intersection and **widened** a role; a refused withdrawal
> retained a member who had left; a refused withdrawal also raised a *pending invitation* for
> somebody who had already answered and then retracted.
>
> Fixed as a rule the whole fold obeys, not as a patch on one branch: **a record that fails
> attestation loses its power to confer and keeps its power to restrict.** The fold reads two
> tracks — *conferring* (gated) and *restricting* (every row) — and
> `tests/workspace-adversarial.test.ts` enumerates **76,800 configurations across six axes**
> and asserts, literally, that no stronger configuration admits anything a weaker one
> withholds, reports a wider role than it reported, or raises fewer divergences. The sixth
> axis is the descriptor-binding **basis**, and it asserts an *invariance* rather than an
> ordering: `exact-url` and `slug-only` are two answers about the same record, and no policy
> may refuse on the difference — see residual gap 1 for the measurement behind that decision.
> The fifth axis is field binding, and it needed a **generator** axis as well as a policy rung: every
> row the 6,400-case version produced was hand-built, so `requireFieldBinding: true` would
> have refused all of them and passed 6,400 vacuous subset checks. The four provenance shapes
> give the rung something to admit as well as something to refuse, and a separate case asserts
> it really does both.
> Honouring an unattestable revocation does let anyone who can get a row into `grants` evict
> a member; that is a denial of service the `asserted` configuration already permits in full,
> and it is the strictly lesser evil.

**What this does and does not establish** is set out under
[Attribution](#-attribution-what-is-now-verified-and-what-is-not) below. The short version:
it defeats a convener writing an acceptance from their own session; with
`requireFieldBinding` it also defeats offering one of the member's *unrelated* signed records
as their acceptance, because the record is read and it does not say it is one; it does
**not** defeat a convener lifting a valid proof block out of one of the member's real
records; and — the one a reader is now most likely to over-read — **it does not establish
that the convener is the workspace's convener**, which is caller-supplied and unchecked.

> This paragraph has been wrong twice, in the same direction, and the corrections are left
> visible. It first said the fold binds *"a signer to a URL, never a record to its content"*;
> the substrate closed that half — a proof commits to a digest of the graph's triples and the
> read path recomputes it. It then said the fold binds *"a signer to a RECORD, never a record
> to the fields claimed for it"*; `src/membership.ts` closes that half, under a policy you
> have to ask for. What is left is gap 6, and the pattern worth noticing is that each
> closure moved the unverified step **outward** rather than removing it.

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
| [`src/roster.ts`](src/roster.ts) | the two-sided fold: `foldRoster`, `may`, `explain`, `refuseAttestation`, `refuseFieldBinding`. Pure. |
| [`src/membership.ts`](src/membership.ts) | the two halves as **records**: `grantTurtle`, `acceptanceTurtle`, `publishMembershipRecord`, `readGrantRecord`, `readAcceptanceRecord`. The producer residual gap 0 was waiting on. |
| [`src/stream.ts`](src/stream.ts) | one participant's log: `appendEntry`, `readStream`, `verifyChain`, `readAttestation`. |
| [`src/compose.ts`](src/compose.ts) | many pods read as one workspace: `composeWorkspace`, `resolveCitations`. |
| [`src/can.ts`](src/can.ts) | authority: `canAct`, `authorizeView`, `scopesFromRegistry`, `signerIndexFromRegistry`. |
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

`appended` and `pending` both carry a non-omittable `signing`: `'signed'`, `'NOT-SIGNED'` or
`'unreported'`, plus a `signingNote` that is always populated.

> ★ **`sign_authorship: true` is a request, and `appendEntry` was not reading the answer.**
> The relay catches a signing failure, logs a warning, **publishes anyway**, and reports it
> as `authorship: {signed: false, reason}`. `appendEntry` read only `code`, `error` and
> `descriptorUrl`, so a transient outage of the signing key produced a run of entries
> reported as a clean `appended` with nothing anywhere mentioning signing. By this module's
> own rule that is **permanent** — the bytes are immutable and the key has moved on — so the
> operator would have found out at read time, when `verifyAuthorship: true` withheld a
> stretch of their own log, months later. `'unreported'` is kept distinct from
> `'NOT-SIGNED'`: guessing "unsigned" would make every append look broken against a relay
> that simply does not report it.

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
consuming the feed has had to see the claim. `attributionGrade` is non-omittable for the
same reason and is modelled directly on it — see
[Attribution](#-attribution-what-is-now-verified-and-what-is-not).

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

## ★ Attribution: what is now verified, and what is not

`ComposedEntry.principal` **was** a label the composer attached from the members list — not
a fact read from the record. Nothing in the read path derived authorship.

An independent review turned that into a live escalation: a member's stream IRI comes from
their **own acceptance**, and nothing required it to be under their own authority. Point it
at somebody else's pod and their entries were folded in *attributed to you* — an Observer's
writes laundered into a Contributor's, and with the recommended `readableMembers` pre-filter
the Observer's pod was never read, so nothing was even reported.

Two checks now stand between a record and a name.

**Containment.** Each returned record must be served from under the `podUrl` **supplied for
that member**; entries served from elsewhere are withheld and reported in `misattributed`.

> The first attempt at this defence range-checked the *stream IRI* against the pod and
> rejected every real member on the first live run. A graph IRI lives under the relay's
> naming authority; its entries are stored on a pod. Conflating them is a category error,
> not a check — caught only because the live verifiers were re-run after the change.

> ★ **Four places in the code, and this table, used to call it "that member's own pod". That
> is the claim, not the check**, and a third review reproduced the original laundering
> escalation through it: point `podUrl` *and* `stream` at a victim — both come from the same
> acceptance — and containment passes, `misattributed` is empty and `complete` is `true`.
> Composing both members then admits the attacker's laundered copy and puts the victim's own
> legitimate copy in `disallowed`, an exact inversion. The wording is now "the pod URL
> supplied for that member" everywhere, because that is what is actually compared.

Containment structurally cannot help when `podUrl` was itself derived from the member's
claim: that asks the attacker where the attacker lives. Which is why there is a second check.

**Authorship.** Every append now goes out with `sign_authorship: true`, so each entry's
descriptor embeds an `iep:authorshipProof`. `composeWorkspace({ verifyAuthorship: true })`
reads each one back through `get_descriptor` — which runs the relay's verifier, not ours —
and admits an entry only when the signer resolves, through the member's **own agent
registry**, to the member the entry would be attributed to. Anything else is **withheld and
reported** in `unattested`, never admitted and never silently dropped.

Signing is unconditional; verifying is opt-in. The asymmetry is not a compromise: an entry
written unsigned can never acquire a proof, because the bytes are immutable and the key has
moved on, whereas verification is a recurring cost paid on every read forever.

### The two grades of attribution

| grade | what the name beside an entry means | cost |
|---|---|---|
| `asserted` *(default)* | it came from the caller's members list, and the record is served from under the `podUrl` the caller supplied for that member — **not** a check that the pod is theirs | nothing |
| `attested` | the substrate verified the record's own signature and it traces to an agent that member's registry vouches for, and which is not revoked | **one `get_descriptor` per entry** |

`ComposedView.attributionGrade` is non-omittable and `ComposedView.descriptorReads` reports
what verification actually spent, so the bill is countable rather than described.

### What is genuinely established

- A convener cannot fabricate an acceptance **from their own session**. The proof would name
  their agent, the member's registry does not vouch for it, and the fold refuses it by name.
  Read that narrowly: on its own it says *this URL was not signed by the convener*, and not
  that the member accepted anything — a member's unrelated signed record satisfies it just as
  well. Adding `requireFieldBinding` is what turns it into *the member signed a record saying
  they accept this grant*; without it, that step is not taken. A **lifted** proof is narrowed
  separately and incompletely — see residual gap 1.
- An entry cannot be laundered from one member to another **once `verifyAuthorship: true` is
  on**: the record must be signed by a live agent the named member vouches for. Containment
  alone does not establish this, because the pod URL is the caller's claim.
- A **revoked** signing key no longer attests, and the entry is withheld and named in
  `unattested` rather than admitted.

> ★ **That last bullet used to say the opposite, and the opposite was wrong.** It read: *"a
> revoked agent still attributes, deliberately — revocation removes the capability, so those
> entries land in `disallowed`."* That holds only when the revoked agent was the principal's
> **only** agent. `scopesFromRegistry` unions over the live ones, so a review signed an entry
> with a key its owner had already thrown out and it was counted as that member's workspace
> content at the **highest grade the system offers**, with `ComposedEntry` carrying no signer
> field for anything downstream to recover it from. That is the compromised-key case the
> revocation work exists for, admitted.
>
> **What the fix costs, stated rather than buried:** rotating a key now withholds everything
> it signed until the retired row is restored to the registry live. A registry cannot tell a
> routine rotation from a compromise, and only one of the two readings is safe when it
> cannot. Revoked rows are still *indexed* — the key-to-person mapping is what makes a
> revocation legible at all — they just come back marked.

Two more things `signerIndexFromRegistry` now does, both found by review:

- It reads the pod registry's own **`agentId`** field, not just `did`/`id`. That field is on
  `AuthorizedAgentData`, the **only** shape that carries `revoked` — so reading `did ?? id`
  indexed nothing on the one path where revocation arrives, refusing every genuine grant
  while the revoked branch downstream sat unreachable.
- A signing key **two registries claim** resolves to neither, naming both claimants. Anyone
  may write their own pod's registry, so anyone could list a rival's DID in it and take over
  the attribution of everything that rival ever signed, with the answer flipping on the order
  the rows arrived in.

### ★ What is NOT established — the residual gaps, precisely

**0. Binding a record to the FIELDS CLAIMED FOR IT — now closed, under a policy you must ask
for.** Kept at number zero, with its history, because it was the largest gap here for four
rounds and the shape of what replaced it matters more than the fact that something did.

**What it was.** The gate bound a *signer to a record* and never a *record to the fields
claimed for it*. `Grant.role`, `Grant.grantedTo`, `Grant.revoked`, `Acceptance.member`,
`Acceptance.accepts` and `Acceptance.stream` were **typed by the caller of `foldRoster`**;
the `Attestation` sat beside them and covered none of them. A review handed the fold one of
bee's *ordinary published log entries* as her acceptance — genuinely signed, genuinely bound
to its own descriptor, genuinely naming bee — and bee became an **attested member** of a
workspace she had never heard of, at whatever role the caller typed. It needed no proof
lifting; it needed only that the victim had ever published one signed public record, which
every `appendEntry` guarantees.

**Why it could not be patched in the fold.** `roster.ts` is pure, and the missing evidence
was a *document*. Nothing in the repo had ever written a `wsp:MembershipGrant` or a
`wsp:MembershipAcceptance` — the published shapes described records no code produced — so
there was no content to compare the typed fields against and no value other than `'unbound'`
that `Roster.recordFieldBinding` could honestly report.

**What closes it.** [`src/membership.ts`](src/membership.ts) is that producer.
`grantTurtle` / `acceptanceTurtle` serialize each half through the same `turtleIriRef` /
`escapeTurtleLiteral` / `rejectExtraTriple` discipline `entryTurtle` uses;
`publishMembershipRecord` publishes with `conforms_to_shapes: [WSP_SHAPES]` and
`sign_authorship: true` and **waits for the record to become readable**; `readGrantRecord` /
`readAcceptanceRecord` fetch it back in **one** `get_descriptor` and parse every field out of
the payload. Each parsed row carries a `FieldProvenance` naming the descriptor it came from,
`AttestationPolicy.requireFieldBinding` refuses any row without one, and
`Roster.recordFieldBinding` reports `'bound'`.

Bee's log entry no longer reaches the fold at all: it declares no `wsp:MembershipAcceptance`,
and the reader refuses it — *before* any signature is consulted, because the signature was
never the discriminator.

Three details are load-bearing rather than decorative:

- **One read, not two — *and one region, not the document*.** `get_descriptor` computes
  `contentBinding` by digesting the very `graph.content` it returns. Fetching payload and
  verdict separately would let a pod change in between, and `'bound'` would stop being a
  statement about the bytes that were parsed. ★ The first version of this bullet stopped
  there, and the omission was the round's critical defect: the digest covers the
  `<graphIri> { … }` block, and the reader was parsing the whole served document, so
  everything in the default graph was read and never digested. Both sides now go through one
  `digestedGraphRegion`. See "What `bound` means, exactly" below.
- **`requireFieldBinding` forces `requireContentBinding` on, in code.** Fields parsed from
  bytes nobody re-digested are fields somebody may have edited after signing, and the parse
  would report the edit faithfully. The combination that checks half is not reachable.
- **A reader refuses more than the shape does, and never drops a restriction.** Two
  `wsp:grantedTo` triples are refused rather than resolved first-match; an unreadable
  `wsp:revoked` reads as **set**; a record damaged in a non-identifying field still reaches
  the fold, because it may carry a revocation and deleting it would reinstate a removed
  member.

**What it still does not mean.** *"bee is a field-bound member"* means **two records, each
signed by the party it claims to come from, each stating this membership in the region of its
own bytes the substrate re-digested and matched**. The qualifier is not pedantry: without it
the sentence was false, because the reader parsed a strictly wider region than the digest
covered and a convener could manufacture a participant in the difference. It does not mean the
convener was entitled to convene (**gap 6**, now the binding one here), it does not bind
`Member.role` — a derived label, foldable downward by a refused row — and the guarantee rests
on this reader rather than on the published contract for one field (**gap 7**). All three are
stated below rather than absorbed into the sentence above.

**What changed: the substrate half is closed.** An authorship proof now commits to a digest
of the graph's **triples**, and `get_descriptor` **recomputes that digest over the payload it
actually serves** and reports the result as `authorship.contentBinding` — four values, never
a boolean:

| value | meaning |
| --- | --- |
| `bound` | the signed digest was recomputed over the served payload and matched |
| `mismatched` | the digest **was** recomputed and did **not** match. The signature is authentic and covers different content: the record was altered after signing. Evidence *against* the content |
| `declared` | the proof commits to a digest and **nothing checked it** — the payload was unreadable here, the digest is an older form no reader can recompute, or the signature failed before the content was reached |
| `unbound` | the proof carries no digest at all: every proof written before this existed, **plus any payload the digester could not parse**, which includes ones written seconds ago. Silent about content |

> ★ `mismatched` used to be reported as `declared`, on the reasoning that a mismatch already
> sets `valid: false` so the binding field need not carry it. It did need to: readers render
> the binding on its own, and `declared` is narrated as *"nothing was checked … neither an
> attestation of the content nor evidence against it"*. The substrate's sharpest signal was
> being delivered with a note telling the reader to disregard it.

`AttestationPolicy.requireContentBinding` makes the roster gate demand `'bound'`, and
`Roster.recordContentBinding` then reports `'bound'` — reporting what the fold **enforced**,
never what its inputs happened to carry.

**What `bound` means, exactly: triple-identity, not byte-identity.** The digest is over the
graph's *triples*, so two documents sharing **no bytes** — a different alias for the same
namespace, statements reordered, reflowed, reindented — produce the identical digest and
both verify. That is deliberate, not a weakness: `publish()` rewrites the payload through
`wrapAsTriG` before it lands, hoisting the caller's `@prefix` lines to document scope and
indenting the body, so the bytes signed are **never** the bytes served. A byte comparison
would have reported every honest content-bound proof as tampering.
`deploy/mcp-relay/tests/authorship-content-binding.test.ts` measures both halves on one
payload and **prints** the hashes, so the figures can be checked rather than quoted. (They
used to be quoted here as fixed constants "measured on a four-line payload"; the payload was
not in the repo, so nobody could reproduce or refute them.) What `bound` rules out is a
change in what the record **says**.

Digests carrying **different algorithm labels are never compared at all**, so the `sha256:`
proofs already on pods degrade to `'declared'` rather than being branded forgeries the first
time a reader checks them.

> ★ **And the rewrite itself had to be fixed before any of this was safe.** `wrapAsTriG`
> **dropped** a caller `@prefix` whose alias the descriptor already bound — 23 of them —
> so a third-party payload declaring, say, `@prefix as: <https://example.org/assessment#>`
> had its `as:` terms silently re-pointed at ActivityStreams on the way to the pod. That was
> a data-corruption defect on its own; once proofs committed to a content digest it became a
> live **false accusation**, because the served graph no longer denoted what the signer
> signed. Caller directives are now emitted at document scope *between* the descriptor's
> triples and the payload's, so each side resolves against its own bindings and nothing is
> discarded. The one rewrite that ordering cannot reproduce — a payload binding one alias to
> two namespaces with triples written against each — is **refused at publish** rather than
> stored as something the caller did not write.

**Why content binding alone was never enough, and why the two are still separate fields.**
Bee's ordinary log entry is *genuinely hers and genuinely unmodified*, so it reports
`contentBinding: 'bound'` — the strongest verdict the substrate can produce — and under
`requireContentBinding` alone she **still** becomes an attested member of a workspace she
never joined. Binding a record's content cannot help when the lie is in *which record was
submitted*. `tests/workspace-adversarial.test.ts` pins that exact case, and
`tests/workspace-membership.test.ts` runs it forward: the same inputs are admitted under
`requireContentBinding` and refused under `requireFieldBinding`, so the gap is shown to have
been real rather than described as having been.

`recordContentBinding` and `recordFieldBinding` remain **two** non-omittable fields for that
reason: `'bound'` on the first must never be readable as covering the second.

**★ And `bound` covers ONE REGION of a served document, not the document.** This is the
sentence the first version of this close did not have, and its absence defeated the whole
thing. `publish()` writes a TriG wrap: the descriptor's own triples in the **default graph**,
the payload inside `<graphIri> { … }`. The digest covers the block. `payloadOf` handed the
**entire** document to `parseTrig`, so every field was read from a strict superset of the
bytes the verdict was about. A convener could copy one of a member's real signed records
verbatim — digest matches, `'bound'` is honest — and write a `wsp:MembershipAcceptance` into
the default graph beside it, and the roster reported that member as a participant at the
convener's chosen role with `unattested: []` and both fields `'bound'`, **with no cooperation
from the member at all**. It ran the other way too: one decoy subject outside the block made
an honest acceptance read as *"declares 2 … subjects"* and disappear.

The digested region is now decided in exactly one place — `digestedGraphRegion` in
`@interego/solid` — and the reader calls the same function as the digester, with the same two
strings out of the same response. `observedGraphDigest` no longer accepts a caller-chosen
graph IRI, so the two scopes cannot be *written* apart. There is no fallback to the whole
document, and none to a top-level `content` either: a response with no digested region is
**refused**, not read.

**What `recordFieldBinding: 'bound'` covers, and one thing it does not.** It is a statement
about each conferring **record**: its `workspace`, `grantedTo`, `role`, `member`, `accepts`
and `stream` came out of that record's own digested bytes. It is **not** a statement about the
values the fold *derives across* records. `Member.role` and `Member.effective` are folded over
the **restricting** track — every in-workspace grant, including refused ones — because a
refusal must never widen a label or an intersection. So a caller-typed row listed in
`unattested` can still **narrow** a field-bound member's printed role and capabilities. It can
only subtract, and the 76,800-configuration enumeration is what fixes the direction; but
"bound" was being read as covering the label, and it does not.

**And `'unbound'` is still the default and still reachable.** Every caller that hand-builds
its rows — which is every caller that predates `membership.ts` — gets
`recordFieldBinding: 'unbound'` and an `attributionNote` that spells out, in words, that the
role, the grantee and the stream are as the caller typed them. Defaulting the policy on would
empty every existing roster at once; leaving the report to be inferred is how the gap stayed
invisible for four rounds.

**1. A lifted proof binds on ONE PATH SEGMENT, and the relay reports the mismatch rather than
refusing.** `get_descriptor` re-derives the canonical payload from the proof block's **own
fields** and checks the signature over it, so a proof block copied verbatim out of any of a
member's real, public records **verifies clean, naming that member**, wherever it is pasted.

> ★ This paragraph used to say the verifier *"never compares the proof's `iep:descriptorId`
> against the descriptor it just read"*. **That is false**, and it was false in the same diff
> that wrote it: `deploy/mcp-relay/server.ts` calls
> `proofBindsToDescriptorUrl(parsedProof.descriptorId, url, normalizeCssUrl)` before the
> `try`, and reports `authorship.descriptorBinding` — `{bound, basis, note}` — on all three
> exits. It sat directly above the struck-through row it had become the twin of, which is
> exactly the ledger staleness the "How to read this file" note at the bottom promises against.

What is still open is two things, stated separately because they are different:

- **The relay reports, and does not refuse.** `authorshipVerified` and
  `effectiveTrustLevel` are untouched by `descriptorBinding.bound === false`
  (`server.ts:4441–4448`). A consumer that reads only `authorshipVerified` learns nothing
  about it. The workspace layer refuses on it (`refuseAttestation`); other consumers do not.
- **A URN-form id compares one segment.** The relay mints `descriptor_id` as
  `urn:iep:<pod>:<epoch-ms>` and derives the URL from its terminal segment via
  `slugFromIri`, so **every** record the substrate mints binds `slug-only`: the host, the pod
  and the container were not compared and cannot be, because the URN→URL mapping discards
  them. A URL-form id is compared in full — host, pod, container and name — but nothing in
  this tree mints one.

Content binding narrows this one, and only partly. A lifted proof carries the digest of the
record it was lifted *from*, so pasting it beside different content now yields either
`contentBinding: 'mismatched'` with `valid: false` (the digests are comparable and differ)
or `'declared'` (they are not comparable) — never `'bound'`. What it does **not** stop is a
proof lifted together with the content it covers, which is the manufactured-participant case
in gap 0.

Both the relay and this layer compute the comparison with the **same** substrate function,
`proofBindsToDescriptorUrl` in `@interego/core`, which returns `{bound, basis, caveat}` rather
than a boolean. `basis` is the part that matters:

| basis | what was compared | who gets it |
|---|---|---|
| `exact-url` | host, pod, container and name, after host normalisation | a URL-form `descriptor_id`. Nothing in this tree mints one. |
| `slug-only` | the terminal path segment, and nothing else | **every** record the relay mints |
| `none` | they disagree, or there was nothing comparable | refused |

> ★ An earlier version of this section said the narrowing was *"close to zero"* and left it.
> A later one collapsed the verdict to a bare boolean in `stream.ts` and lost the basis
> entirely, so `exact-url` and `slug-only` read identically to every caller downstream. The
> boolean wrapper is **deleted**; `Attestation.descriptorBindingBasis` carries the basis out
> of the same object the boolean comes from, one line apart.

**Is `slug-only` sufficient for field binding? Decided: yes, and measured rather than
assumed.** Requiring `exact-url` is the obvious tightening and it is not adopted, for two
reasons that were both checked:

1. It would refuse **100% of honest records**. Every `descriptor_id` the substrate mints is a
   `urn:`, so no membership record in existence would qualify — failing closed on all honest
   data, the direction this area has already shipped once.
2. With the parse-scope fix in place it would buy nothing that is conferred. Relocating a
   **verbatim copy** of a genuinely signed acceptance onto a host the attacker chose produces
   an **identical** roster row: `workspace`, `member`, `accepts` and `stream` all come out of
   the signed block, and two copies present at once raise the acceptance-fork divergence
   rather than escalating anything. Asserted, not argued —
   `tests/workspace-membership.test.ts`, *"what a `slug-only` binding still buys"*.

**What it does leave open, and this is the residual:** `head` — the URL an operator
dereferences to audit a record, and the URL printed in `unattested` and in every
`divergence` — is chosen by whoever hosts the copy. A `slug-only` row can send a reader to a
document the attacker controls. Nothing conferred moves with it; where the reader is *sent*
does.

A publish that names its descriptor some other way — the PGSL-primary path writes a
content-addressed `holon-<hash>.ttl` — fails this check too, *wrongly*, withholding the
entry. That is the safe direction and it is now the *reported* direction as well: the
refusal used to say **"the proof was copied in from another record"**, stated as fact, for
all four situations that set `boundToDescriptor: false` — three of which are not forgeries.
Calling a record's real author a forger, in the one channel operators are told to watch, is
how a true report stops being believed. The message now carries the diagnostic and says only
one of the two readings is a forgery and that this layer cannot tell which.

~~**The durable fix belongs in the substrate**, which already holds both the proof and the URL
it read it from: `get_descriptor` should compare them.~~ **Done.** Both halves of that sentence
are now done — the observed content reaches the verifier, and the descriptor id is compared —
and the comparison lives in `@interego/core` so the relay and this layer answer the question
with one function rather than two. What remains is the **refusal**: the relay reports
`descriptorBinding` and does not act on it. See the two bullets above.

**2. The signature is the relay's, not the member's.** `sign_authorship` signs with the
relay's compliance wallet, over a payload whose `iep:issuer` is the session's
`_session_agent_did` — a reserved wire field the transport strips, so a caller cannot forge
it. What a verified proof establishes is therefore *"this relay, holding an authenticated
session for this agent, published this record"* — delegated verification, not a
self-sovereign signature. It is unforgeable by a workspace participant and it is **not**
independent of the relay operator.

**3. `signerOf` is only as good as the registry behind it.** `signerIndexFromRegistry` reads
the agent registry on each principal's own pod, which is exactly why it is evidence — a
convener cannot add their agent to somebody else's registry. Pass the wrong registry and the
mapping is wrong. An unknown signer resolves to `null`, never to itself, and a **contested**
one (two registries claiming the same key) resolves to neither, so a registry that failed to
load, or one that is being fought over, withholds rather than admits.

**4. Turning verification on withholds every pre-existing entry.** Entries written before
`sign_authorship` carry no proof, so they are correctly refused. That is the right answer and
an operationally violent one. **Key rotation now has the same shape**: a revoked signing key
no longer attests, so a member's history is withheld until the retired registry row is
restored live.

**5. `wsp:seq` verification has no producer.** `verifyChain`'s sequence check, the
`seqMismatches` clause in `intact`, and the `headOf` refusal that cites it are **inert
against every stream this module can actually read**: `ManifestEntry` has no `seq` column, so
`declaredSeqChecked` is `false` and `seqMismatches` is `[]` on every real read. That is
reported rather than assumed — `declaredSeqChecked` exists precisely so "nobody looked" is
not confusable with "the numbering agrees" — but the removed-and-linked-around attack is
currently caught only by a hand-built row.

**6. Nothing establishes that the convener is the workspace's convener.** New this round, and
it is the gap that binds now that gap 0 is closed. `AttestationPolicy.convener` is a
principal **the caller of `foldRoster` names**. Neither the fold nor `membership.ts` fetches
the workspace descriptor at `<workspace>` and checks its `wsp:convener` against it — so a
policy naming the wrong party produces a roster that is field-bound, content-bound,
signer-checked, reported as `recordFieldBinding: 'bound'`, and **about the wrong
memberships**. `verify-can-live.ts` §8 asserts this rather than describing it: it folds the
same two genuine records under `convener: bee` and shows the membership vanish while
`recordFieldBinding` still reports `'bound'`. (It used to say **both** binding fields. The
statement is true of the behaviour — `requireFieldBinding` ORs content binding on — but the
assertion only ever checked `recordFieldBinding`, and §§6–8 of that script have not been run
against live infrastructure this round. Claiming the wider assertion off the narrower one is
the substitution this file exists to refuse.)

Closing it needs the workspace descriptor read and its convener parsed — the same
serialize / publish / read-back / parse treatment `membership.ts` gives the two halves,
applied to `wsp:Workspace`. It is deliberately **not** attempted here: the shape for it
already exists (`wspsh:WorkspaceShape`, one convener, one role profile, one title), and doing
it half way — reading the descriptor without deciding what makes *that* record authoritative
for the URL it sits at — would produce another check that looks like evidence.

**7. `wsp:member` is enforced by this reader, not by the published shape.**
`wspsh:MembershipAcceptanceShape` constrains `wsp:accepts`, `wsp:stream`, `wsp:workspace` and
`wsp:withdrawn`. It says nothing about **who is accepting**, because until `membership.ts`
there was no reader that needed to know it from the document. So the publish gate accepts an
acceptance with no `wsp:member` and `readAcceptanceRecord` refuses one.

Refusing more than the published contract is the safe direction and is deliberate, but it
means this half of the guarantee rests on **our reader** rather than on the contract other
organisations validate against. Closing it is one `sh:minCount 1` on a **deployed** artifact,
which is a change to what the live gate accepts and is not made as a side effect of this
round. The term is declared in `wsp.ttl`, with the limitation written into its
`rdfs:comment`, so a reader of the vocabulary is told.

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
| what must be trusted | the relay, absolutely | the relay's *signing key*, and nothing else — see residual gap 2 |
| who can audit it | nobody — it is a promise about a server | anyone who can read the records, member or not |

Two layers refuse, and they refuse different things. Both are demonstrated live by
[`tools/verify-can-live.ts`](tools/verify-can-live.ts) (sections 1–5, **13/13 live** — that
number is the file **as it stood at that run**; section 3 has since gained two assertions
that the relay did not publish either entry unsigned, and those two have not been run):

```
the substrate  bee writes to alice's pod       -> 403 scope_violation, nothing lands
the substrate  bee writes to HER OWN pod       -> succeeds. It is her pod.
the workspace  the fold reads both pods        -> 2 entries are readable
the workspace  authorizeView applies the roster -> 1 is workspace content;
                                                   the Observer's is reported, not deleted
```

Those five sections **build the roster by hand**, which is exactly why they could never have
established two-sidedness — there was no forgery for the fold to refuse, because the harness
was the only author of anything. Sections 6 and 7 exist to close that: they publish an
acceptance from bee's own session *and* a forged one for bee from alice's, read each
record's `iep:authorshipProof` back through the relay's verifier, and require the fold to
admit the first and refuse the second. **Those two sections have not yet been run against
the live substrate** — no bearer pair was available — so they are code, not a result, and
nothing here claims otherwise.

> ★★ **And as written, section 6's two headline assertions could not have failed.**
> `publish_context` is deferred unless `compliance`, `sync` or `if_match` is set —
> `sign_authorship` does **not** force the synchronous path — so all three records were
> published `status: "pending"` with a *predicted* URL and read back with **zero wait**. A
> not-yet-written descriptor answers `{error: 'descriptor could not be retrieved'}`, so the
> fold refused *both* acceptances, and `manufactured.members.length === 0` plus
> `manufactured.unattested.some(u => u.kind === 'acceptance')` both passed for entirely the
> wrong reason. The refusal string was only `console.log`ged, so nothing distinguished
> *"refused because alice signed bee's acceptance"* from *"refused because nothing was
> readable"*. That is the same demonstrated-by-construction shape section 6 exists to
> eliminate, applied to the property under review. §7's two accounting assertions had the
> same hole: `0 + 2 === 2` holds when every entry is withheld.
>
> Fixed: each publish now waits for its record to become readable (and returns `null`, which
> fails loudly, if it does not); the refusal **reason** is asserted rather than logged; and
> both sections carry an explicit **CONTROL** assertion — the genuine half must be *admitted*
> — so a run in which everything is refused reports itself as having established nothing.
> **Whether the assertions still hold now that they can fail is unknown**, because the
> sections remain unrun. That is the honest state and it is not dressed up as more.

> ★★★ **And section 6 still did not bind a record to the fields claimed for it.** Its three
> published records carry a single `dct:description`; the `Grant` and `Acceptance` it folds
> are object literals typed twelve lines above. So it establishes *who signed each URL* and
> nothing whatever about what those records **say** — which is why bee's own log entry, with
> `member: bee` typed beside it, walked straight through the policy section 6 exists to
> demonstrate.
>
> **Section 8** is the half that was missing. The convener publishes a real
> `wsp:MembershipGrant` on her pod; the member publishes a real `wsp:MembershipAcceptance` on
> **hers**, naming that grant by its own descriptor URL; the convener publishes a forged
> acceptance for the member on her own pod. All three are shape-validated at publish, signed,
> waited for, read back and **parsed** — no field in the fold is typed by the file. The
> control is asserted first (the genuine acceptance must be **admitted**), then the forgery is
> refused *and its reason checked*, then bee's own section-3 log entry is offered as her
> acceptance and refused by the **reader**, and finally the same entry is shown to be
> **admitted** under `requireContentBinding` alone — so the gap is demonstrated to have been
> real rather than asserted to have been. Section 8 closes by demonstrating **residual gap
> 6**: fold the two genuine records under `convener: bee` and the membership vanishes while
> both binding fields still report `'bound'`.
>
> Section 8 is **unrun**, for the same reason as 6 and 7.

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
# ★ workspace-membership.test.ts is in this list, and its absence was a real defect: it
# carries the headline gap-0 claim and every parse-scope regression, and a reader following
# this file did not run it.
npx vitest run tests/workspace-roster-fold.test.ts \
              tests/workspace-stream.test.ts \
              tests/workspace-compose.test.ts \
              tests/workspace-can.test.ts \
              tests/workspace-membership.test.ts \
              tests/workspace-adversarial.test.ts

# ★ vitest does NOT typecheck. It transpiles with esbuild and runs the JavaScript underneath,
# and `tests/**` plus `applications/shared-workspace/**` were in no tsconfig at all — so a
# required bail-out deleted from `readAcceptanceRecord` left the whole suite green while tsc
# caught it in one pass. This is the compiler; it also runs in vitest's globalSetup, so the
# line above cannot report green over source that does not compile.
node tools/typecheck-gate.mjs

# and against the live substrate — the doubles cannot verify the substrate
IEP_BEARER=<token-a> npx tsx applications/shared-workspace/tools/verify-stream-live.ts

# the composed view needs TWO real participants, because the relay's publish scope gate
# refuses a caller writing to someone else's pod — which is the design working
IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
  npx tsx applications/shared-workspace/tools/verify-compose-live.ts

# two-sidedness as a fact: each half published by whoever it claims to come from, with a
# forged acceptance alongside it for the fold to refuse (§6) — and §8, where both halves are
# real wsp:MembershipGrant / wsp:MembershipAcceptance documents whose FIELDS are parsed back
# out of the bytes, with the manufactured-participant attack run against both the new policy
# and the old one. §§6–8 have never been run; running them is the next thing this needs.
IEP_BEARER=<token-a> IEP_BEARER_B=<token-b> \
  npx tsx applications/shared-workspace/tools/verify-can-live.ts
```

The live verifier exists because a harness that stands in for a dependency cannot verify
that dependency. It checks that entries land in order, that catch-up is one read, that a
stale precondition is refused **and nothing lands**, that an entry missing `wsp:seq` is
refused **and nothing lands**, and that every entry id actually dereferences to its own
triples.

★ It is also where a harness that stands in for the thing under test gets caught. The
membership verifier built both halves of every roster itself, so it proved only that a fold
of its own inputs behaved as it had been written to. `verify-can-live.ts` sections 6–7
publish each half from a different session and read authorship back through the relay's
verifier — and, being unrun, are currently code rather than evidence.

★ And a harness can be caught a second way: by writing an assertion that **cannot fail**.
Sections 6–7 did, by reading three deferred publishes back with no wait, and the two
assertions that carried the property passed vacuously. They now wait, assert the refusal
*reason*, and carry a CONTROL that fails when nothing was admitted. An assertion that cannot
fail is worse than no assertion, because it is counted.

## Status

All six increments are built. What is verified, and what is not:

| | state |
|---|---|
| 1 roster, two-sided membership | built; **signer-checked, content-bound, and now field-bound** — under `requireFieldBinding`, every field is parsed from **the region of the record the digest covers**. Verified **by doubles only** (six workspace suites, 76,800-configuration monotonicity enumeration); the live path is written and **unrun** |
| 2 per-participant stream | built, **20/20 live** (the live run predates `sign_authorship`) |
| 3 composed cross-pod view | built, **14/14 live** across two identities on two pods |
| 4 authority at the fold | **13/13 live** for sections 1–5 *of the file as it then stood* (assertions added since, unrun); 6–8 not yet run — §§6–7's assertions were vacuous until the round before this one, and §8 is new |
| 5 engagement `gone` + injectable engine | built, 11 assertions, deployed |
| 6 independent SHACL agreement | built, **in CI** — `@interego/core` vs pySHACL |
| 7 membership records: serialize → publish → read → parse | built (`src/membership.ts`), verified against doubles only, **no live run**; the shape gate, the deferred-publish wait and the parse are all exercised against doubles, and [a harness that stands in for a dependency cannot verify it](#verifying-it) |

★ **The one thing to carry away from this table**: nothing on the field-binding row has met
the live substrate. Every claim in the gap-0 section above is a claim about code and its
tests. Two things a double cannot get wrong and the relay can: whether the live
`wsp-shapes.ttl` accepts a record carrying `wsp:member` (it should — the shapes are
deliberately not `sh:closed`), and whether `get_descriptor` returns `graph.content` for these
records at all. Both are assumed here on the strength of reading the relay handler, not on
the strength of having run it.

### Substrate changes needed to finish the job

Not defects in this layer, and not fixable from it:

| | |
|---|---|
| ~~the authorship verifier never checks the proof's `iep:descriptorId` against the descriptor it read, so a proof block can be **lifted** between records~~ — **done.** `server.ts` calls `proofBindsToDescriptorUrl(parsedProof.descriptorId, url, normalizeCssUrl)` before the `try` and reports `authorship.descriptorBinding` `{bound, basis, note}` on all three exits | ~~high~~ |
| **but the relay REPORTS the mismatch and does not refuse on it.** `authorshipVerified` and `effectiveTrustLevel` are untouched by `bound: false`. This layer refuses; other consumers of `get_descriptor` do not | medium |
| ~~it calls `verifySignedAuthorship` **without** the observed content, so `contentHash` coverage is never checked~~ — **done.** `get_descriptor` recomputes the digest over the payload it serves and reports `authorship.contentBinding` as `bound` / `mismatched` / `declared` / `unbound` | ~~high~~ |

> ★ The first row was listed **open** while being false, in the same diff that made it false,
> directly above the struck-through row it had become the twin of. That is precisely the
> staleness the note below promises against, reproduced on the remaining half of the very
> sentence whose other half it congratulates itself for having caught. Both halves are now
> struck, and the part that genuinely remains open — the refusal, not the comparison — is its
> own row rather than a clause inside a stale one.

The second row was not the one-line comparison it was filed as. The digest it was meant to
check was over the caller's inbound bytes, and `publish()` rewrites those before they land,
so no reader is ever served them — the check as specified would have failed every honest
proof. Closing it meant moving the commitment onto the graph's **triples**, which survive
that rewrite. Filed as trivial, and it was not; the estimate was wrong because nobody had
run the round-trip.

### Known defects, and their current state

Reported here rather than left in a transcript. **A previous version of this table was stale
in two of its three top rows** — both had been fixed and it still listed them as open — which
makes a ledger useless in both directions at once. It is re-checked against the code each
time this file changes.

> ★ That promise was broken the very next round, and by the same mechanism, so the way to keep
> it is worth writing down rather than restating the intention. The "substrate changes needed"
> row about `iep:descriptorId` was listed **open** while being false **in the diff that
> falsified it**, sitting directly above the struck-through row it had become the twin of. The
> intention was there; what was missing was the grep. Before this section ships, run the
> identifier in each row against the tree — `parsedProof.descriptorId`, `descriptorBinding`,
> `digestedGraphRegion` — rather than re-reading the sentence. A row nobody has grepped is a
> row nobody has checked.

**Open. Real, reproducible, and not fixed:**

| | severity |
|---|---|
| **nothing checks that the policy's `convener` is the workspace's convener** — residual gap 6, and the binding one now that gap 0 is closed. A field-bound, content-bound, signer-checked roster can be about entirely the wrong memberships, and both binding fields still report `'bound'`. Demonstrated in `verify-can-live.ts` §8 | **high** |
| **the field-binding path has never met the live substrate.** Gap 0 is closed against doubles: `tests/workspace-membership.test.ts` plus the 76,800-configuration enumeration. `verify-can-live.ts` §8 is written and **unrun** for want of a bearer pair, so whether the live shape gate accepts `wsp:member` and whether `get_descriptor` returns `graph.content` for these records is **read off the relay's source, not observed** | **high** *(unverified, not known-broken)* |
| `wsp:member` is required by `readAcceptanceRecord` and **not** by the published `wspsh:MembershipAcceptanceShape` — residual gap 7. The reader refuses more than the contract does, which is the safe direction, but the guarantee rests on our reader rather than on what other organisations validate against | medium |
| `Member.stream` can legitimately differ between two configurations of the same fold: naming the stream is a conferring act, so refusing an acceptance re-picks the head. No authority moves with it, and it is never silent — both configurations raise the `acceptance` divergence — but a caller that reads `stream` without reading `divergences` will go to a different pod under a stricter policy | low-med |
| `proofBindsToDescriptorUrl` compares **a URN-form id** on its terminal segment only, and every `descriptor_id` the relay mints is a URN — so a party who controls a pod and chooses a colliding epoch reaches `bound: true, basis: 'slug-only'` on any host. A URL-form id **is** compared in full, host included, and nothing in this tree mints one. What this leaves reachable, measured: not any conferred value, but `head` — the URL an operator dereferences to audit the record and the URL printed in `unattested` and every `divergence` — residual gap 1 | medium |
| `wsp:seq` has no producer: `ManifestEntry` carries no `seq`, so the sequence check is inert on every real read — residual gap 5 | low-med |
| `verify-can-live.ts` §§6–8 remain **unrun**; their assertions can now fail, and whether they hold is unknown | low-med *(honesty, not behaviour)* |
| a `Grant` or `Acceptance` refused for naming **two** grantees takes any revocation on it out of the fold entirely. Refusing is the only honest reading — the record does not say who it grants to — but the cost is real and is paid in the restricting direction, which is the direction this module otherwise protects | low-med |
| `headOf` on a forked chain throws rather than returning a value; `appendEntry` converts it to a named `conflict` first, so the shipped path is safe and a direct caller must catch | low |

**Closed in this round, with the test that pins each:**

| | where |
|---|---|
| ★★★ **residual gap 0** — `Grant`/`Acceptance` fields were caller-typed, so a member's own ordinary signed log entry passed as their acceptance at whatever role the caller chose. Closed by `src/membership.ts`: both halves are now serialized, shape-validated, signed, published, read back and **parsed**, and `requireFieldBinding` refuses any row whose fields were not | `workspace-membership`, `workspace-adversarial` axis E |
| ★★★ **the first close did not hold: PARSE SCOPE was strictly wider than DIGEST SCOPE.** `contentBinding: 'bound'` covers one region of a served document — the `<graphIri> { … }` block — and `payloadOf` handed the WHOLE document to `parseTrig`. A convener could take a **verbatim copy** of one of a member's real signed records (so the relay re-digests it and honestly reports `'bound'`) and write a `wsp:MembershipAcceptance` into the DEFAULT graph beside it: digest byte-identical, `members: [bee]`, `unattested: []`, `recordContentBinding: 'bound'`, `recordFieldBinding: 'bound'` — **with no cooperation from the member at all**. The same hole ran the other way: one decoy subject outside the block made an honest acceptance read as "declares 2 … subjects" and vanish. Closed by routing both the digester and the reader through one `digestedGraphRegion` in `@interego/solid`; `observedGraphDigest` no longer accepts a caller-chosen graph IRI, so the two scopes cannot be written apart | `workspace-membership` "parse scope must equal digest scope"; relay `authorship-content-binding` |
| ★★ **the suite could not see it, because every double served the wrong document.** `graph.content` was set to the raw payload Turtle, which has no default graph to hide anything in — so the tests exercised a shape no pod serves. The doubles now build the served document with `wrapAsTriG`, the emitter `publish()` itself calls, rather than a replica of it: a replica of the emitter is a second double | `workspace-membership` `descriptorDeps` |
| ★ **the descriptor-binding BASIS was discarded at the boundary.** `stream.ts` wrapped `proofBindsToDescriptorUrl` in a one-line `.bound`, so `exact-url` and `slug-only` read identically to everything downstream. The wrapper is deleted and `Attestation.descriptorBindingBasis` carries the basis out of the same object as the boolean | `workspace-stream`, `workspace-membership` |
| ★ a record that did not state its **conferring** field (a grant with no `wsp:role`, an acceptance with no `wsp:stream`) was still handed a `FieldProvenance`, so under the strictest policy it conferred membership on the strength of a field it does not have while the roster reported `recordFieldBinding: 'bound'`. The reader now applies the fold's own two-track rule: no conferring field, no provenance — and the row still reaches the fold, so its revocation still removes | `workspace-membership`, both directions mutated |
| ★★ turning attestation ON granted MORE than leaving it off (revocation erased; role widened; withdrawal ignored; a withdrawn member shown as *pending*) | `workspace-adversarial` — monotonicity enumeration, now **76,800** configurations |
| ★ the same class again, three more instances the enumeration structurally could not see because it generated exactly **one** acceptance: a stricter policy **widened the reported role** (`Observer` → `Convener`, capabilities unchanged), **deleted** the acceptance-ambiguity divergence, and **dropped every divergence** about a principal whose grants were all refused | `workspace-adversarial` — acceptance-count axis, plus divergence and role comparisons in `assertNoWiderThan` |
| a **revoked** signing key attested at the `attested` grade whenever the principal had a second live agent | `workspace-can`, `workspace-adversarial` axis B |
| `signerIndexFromRegistry` could not index `AuthorizedAgentData.agentId`, the only shape carrying `revoked` | `workspace-can` |
| a signing key claimed by two registries resolved last-write-wins, silently | `workspace-can` |
| a role declared twice in a profile last-write-won in the *granting* direction | `workspace-adversarial` |
| `appendEntry` reported a **failed** signing as a successful signed append | `workspace-stream` |
| `refuseAttestation` stated a forgery as fact for all four unbound causes, three of which are not forgeries | `workspace-roster-fold`, `workspace-stream` |
| `explain()` blamed a grant fork whose heads name the same role | `workspace-roster-fold` |
| divergence notes asserted resolutions that did not happen ("the intersection applies" / "the member is included" over an empty roster) | `workspace-roster-fold` |
| `complete: true` with an entire **authorized** member never read, invisible in every field | `workspace-can` |
| `describeCoverage` silently dropped `disallowed` and `notRead` from every `AuthorizedView` | `workspace-can` |
| the `asserted` grade claimed a pod-ownership check that is never made (four places plus this file) | wording, throughout |
| a foreign row mid-chain was reported twice, the second time as a fork of the member's own log | `workspace-compose` |

**Previously listed here and since fixed** (the stale rows): a read whose rows all fail the
`describes` filter is now `unmatched` with `complete: false`; `explain()` names the
divergence; `readableMembers` no longer deletes the reported half; duplicate input rows no
longer manufacture phantom divergences; `capabilitiesOfAgent` honours `revoked`.

Each round's guards were mutation-checked — broken one at a time against the suites, then
reverted. **25 of 25** for the attestation round; the content-binding and monotonicity
guards added since were checked the same way and are counted separately in that round's
report. There is no single number covering all of them, and stating one would be the kind of
assurance that goes stale the moment a guard is added — which is exactly what happened to the
"25 of 25" line, which predated `requireContentBinding`, `readContentBinding`,
`descriptorWriteCollisionRefusal` and the manifest fail-closed and was still being read as
covering them. The mutants that reinstate the monotonicity defects are each caught by the
enumeration itself, which names the exact failing configuration rather than a symptom.

**The field-binding round: 14 guards mutated, 13 killed, and the fourteenth is the finding.**
Deleting the bail-out in `readAcceptanceRecord` that refuses an acceptance naming no member
left the whole workspace suite green. `tsc` catches it — the reader's `{iri} | {why}` union
makes the branch structurally required — but nothing in the repo was running `tsc` over that
file, so the run said nothing, and the *behaviour* (an acceptance with no `wsp:member` must
produce no record, on the one field the published shape does not require) was untested. Three
cases were added, including a control asserting that dropping a **non-identifying** field
keeps the record, so a future tightening cannot silently start deleting revocations.
Re-mutated afterwards: it now dies. Recorded here rather than quietly fixed, because a guard
whose mutation kills nothing is the finding, not the footnote.

> ★ The count in this paragraph used to be "all **237** tests green". The six workspace files
> hold **254**. The figure was stale in the same way, and for the same reason, as the "25 of
> 25" line dissected two paragraphs above — a number written once and never recomputed. It is
> removed rather than corrected: the count moves every round and the sentence does not need it.

**And the cause of that survivor is now itself closed.** `tests/**` and
`applications/shared-workspace/**` were in **no tsconfig in the repo**. Every other
application's `src/` is pulled into its vertical's `bridge/tsconfig.json` by that config's
`"../src/**/*.ts"` include; shared-workspace is the one vertical with no `bridge/` directory.
vitest transpiles with esbuild and does not typecheck — its `typecheck: { enabled: true }`
setting collects only `*.test-d.ts` type tests, of which this repo has none — so
`npx vitest run tests/` compiled nothing.

`tools/typecheck-gate.mjs` is the compiler. It runs in vitest's `globalSetup`, so the command
people actually type cannot report green over source that does not compile, and as a named
step in `bridge-typecheck.yml` so it is not reachable only through a setup hook. Pointing it
at a program nobody had ever compiled surfaced **60 pre-existing errors in 20 files**, none in
this round's surface and several of them genuine latent defects. Fixing those is a different
change, so the gate **ratchets**: any error outside a pinned legacy list fails, an existing
file's count may not grow, and a count that *improves* also fails, naming the new number — a
ratchet that tightens only when someone remembers is a ratchet that never tightens.

Two of the fourteen are worth naming for their direction. Removing `|| requireFields` — so
`requireFieldBinding` no longer forces content binding on — is caught by the **enumeration
itself**, as a genuine monotonicity break rather than as a failed assertion about a string.
And the two-track reader rule was mutated **both ways**: always setting a provenance kills 2
cases, never setting one kills 6. A guard that only ever refuses is not a guard, it is an
outage, and only mutating in both directions distinguishes them.

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
