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
each half SAYS, and including who was entitled to offer.** A grant lives on the convener's pod
and an acceptance on the member's own, and a roster entry exists only where both agree — *and*
where each half was signed by the party it claims to come from, *and* where every field was
read out of the record rather than typed by whoever called the fold, *and* where the convener
the fold attested those grants against is the one the **workspace's own record** names.

> ★ **What that last clause costs, stated before the claim is made.** It holds only under
> `attestation: { …, requireFieldBinding: true }` and only for rows produced by
> [`src/membership.ts`](src/membership.ts)'s readers. Whether the convener named in the policy
> is the workspace's convener is a **separate** question with a **separate** answer —
> `workspaceEvidence` and `Roster.convenerBinding`, residual gap 6, closed this round — and a
> roster can be `recordFieldBinding: 'bound'` with `convenerBinding: 'unchecked'`, which is
> every caller that has not asked.
>
> ★ **What has been run.** `verify-can-live.ts` §§1–12 were run against production with two real
> bearers and passed **88/88** (§§1–8: 45 sites, §9: 18, §10: 7, §11: 7, §12: 11). §9 is the
> gap-6 **close**, §10 the gap-8 close, §11 the gap-9 close, §12 the gap-10 close. Nothing in the
> file's own numbered section roster is unrun at this count — and the count is quoted here, as it
> is there, precisely so this sentence stops matching when a section is added. The bare adjective
> without a count has already gone stale four times ("§§6–8 remain unrun" after they had run,
> "§9 is unrun" after §9 had, "nothing in this file is unrun" one round before §10 was added, and
> "nothing is unrun at this count" the moment §12 landed).
>
> ★★ **And §12 failed the first time it was run — because the world underneath it changed, not
> because the section was wrong.** It was written by a round with no bearers, standing on a
> 41-mutant sweep and one bearer-free measurement: `<…/wsp-roles-default>` answered **404** and
> only `<…/wsp-roles-default.ttl>` answered 200. The section encoded that 404 as its **expected
> state**. Then `docs/applications/shared-workspace/wsp-roles-default.html` shipped so the
> vocabulary's extensionless IRIs would resolve, and the assertions went on asserting a defect
> that had been fixed. The same change broke the reader: `dereferenceRoleProfile` had only ever
> seen a 404 at that IRI, got `text/html`, and reported the only published role profile in
> existence as `unreadable … unknown bareword "Default"`. **A mutation sweep cannot find either
> of these.** Both are facts about the world, and only running the section against the world
> found them.
>
> ★ **§10 did not merely go unrun — it FAILED the first time it was run**, and for a reason its
> own doubles get right. Its rogue role profile declared `#Contributor` while §8's published
> grant to bee names `#Observer`, so the rogue table had no row for bee's role, conferred
> nothing, and the escalation comparison came out `0 > 1`. A section written to demonstrate a
> widening, failing because its rogue document never mentioned the role it was widening.
> `tests/workspace-adversarial.test.ts` uses `#Observer` **and** rewrites the grant to match;
> the live section copied the shape and named the other role. Fixed and now green.
>
> ★ **And §9's first run found the thing it was written not to check.** Its comment claimed the
> graph IRI made `<WS>` dereference through the relay's `/ns/:owner/:slug` route, and excused
> itself from asserting it. It did not: the file built `WS` under `/ns/maintainer/…`, that
> owner segment selects the pod literally named `maintainer`, and **both** principals are
> refused write to it (403 `scope_violation`, measured both ways) — so `<WS>` answered **404**
> for every run this file has ever done. The URL is now built from the convener's own pod, the
> dereference is asserted rather than described, and the discovery cost nothing but running the
> assertion the section declined to write. That discovery is **residual gap 9**, and §11 now
> closes it.

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
> `tests/workspace-adversarial.test.ts` enumerates **76,800 configurations across nine axes**
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
> The seventh is the **declared convener** (gap 6), and it learned that lesson directly rather
> than by repeating it. Both directions are counted during the loop and asserted non-zero after
> it: a rung that admitted nothing would satisfy every subset check on an empty set, and one
> that refused nothing would satisfy them on an untouched one. Agreeing evidence must also
> change the report and **nothing else**, which the subset direction cannot see, so the two
> rosters' decisions are compared whole.
> The eighth is the **declared role profile** (gap 8), off the *same* record, so there is no
> separate policy flag to turn it on — what makes it an axis is the generator. The ninth is
> **where that record came from** (gap 9), and it is the one axis of the nine that does have
> its own flag, because it is not a question about the record: `requireEvidenceProvenance`
> demands that the evidence be what `<WS>` dereferences to, and a record's own contents cannot
> answer that however well signed they are. The three
> generated workspace records move the declared convener and the declared profile **one field
> at a time**, crossed at every one of the 76,800 points, so 230,400 evidence comparisons sit
> on top of the lattice and each field's verdict is observed while the other agrees. A fold
> that answered either question with the other's verdict fails one of the two shapes.
>
> The disagreeing record names `alice`, deliberately: `signed-by-alice` is one of the generated
> attestations, so the tempting implementation — read the convener out of the workspace and
> *use* it — turns evidence into a **source** of authority and is caught by `assertNoWiderThan`
> at every point where a grant carries alice's signature. A disagreeing record naming a
> principal no attestation is signed by would have made the axis look complete and tested
> nothing. **Eight** further workspace-record shapes (about another workspace, signed by a
> stranger, unattested, content-unbound, no provenance, provenance elsewhere, unreadable, and
> declares-no-profile) are crossed separately against grant × acceptance × revoked ×
> withdrawn × rung, because three of them are evidence at one rung and refused at a higher one.
> The list said "seven" and omitted `declares-no-profile`, which the gap-8 round added; the
> table has eleven entries, three of which ride the lattice, so eight is the arithmetic.
>
> ★ A **ninth** axis (I) rides the lattice on top of those: where the evidence itself came
> from. `sourceShapes` generates four states — no provenance at all, an honest dereference, a
> dereference of a *different* IRI, and a dereference that resolved to a *different* document —
> so 307,200 further comparisons sit above the convener ones, and each of the three forged
> shapes has its own non-vacuity counter. One total would be satisfied by one shape doing all
> the refusing while the other two rode the lattice untested.
> Honouring an unattestable revocation does let anyone who can get a row into `grants` evict
> a member; that is a denial of service the `asserted` configuration already permits in full,
> and it is the strictly lesser evil.

**What this does and does not establish** is set out under
[Attribution](#-attribution-what-is-now-verified-and-what-is-not) below. The short version:
it defeats a convener writing an acceptance from their own session; with
`requireFieldBinding` it also defeats offering one of the member's *unrelated* signed records
as their acceptance, because the record is read and it does not say it is one; with
`workspaceEvidence` it also defeats a policy that names the wrong convener, because the
workspace's own record is read and it names a different one; and it does **not** defeat a
convener lifting a valid proof block out of one of the member's real records.

> This paragraph has been wrong three times, in the same direction, and the corrections are
> left visible. It first said the fold binds *"a signer to a URL, never a record to its
> content"*; the substrate closed that half — a proof commits to a digest of the graph's
> triples and the read path recomputes it. It then said the fold binds *"a signer to a RECORD,
> never a record to the fields claimed for it"*; `src/membership.ts` closed that half. It then
> said the policy's convener *"is caller-supplied and unchecked"*; `readWorkspaceRecord` and
> `AttestationPolicy.workspaceEvidence` close that half.
>
> ★ **The pattern is worth more than any of the three closures.** Each one moved the unverified
> step **outward** rather than removing it, and each was blocked by the same thing: a published
> shape describing a record no code in the repo wrote. `wspsh:WorkspaceShape` has required
> exactly one `wsp:convener` since the day it was published, and for three rounds the answer
> was sitting in a document nobody was writing. What is outward of here now is the **URL**: the
> descriptor these readers are handed is chosen by whoever assembled the fold, so a caller who
> dereferenced `<workspace>` has an answer about `<workspace>` and a caller handed a URL has an
> answer about that URL. Same residue as `head` under a `slug-only` binding — gap 1.

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
| [`src/roster.ts`](src/roster.ts) | the two-sided fold: `foldRoster`, `may`, `explain`, `refuseAttestation`, `refuseFieldBinding`, `refuseConvenerAuthority`, `refuseRoleProfileAuthority`. Pure. |
| [`src/membership.ts`](src/membership.ts) | the three records: `workspaceTurtle` / `readWorkspaceRecord` (who may grant), `grantTurtle` / `readGrantRecord` (who was offered what), `acceptanceTurtle` / `readAcceptanceRecord` (who agreed), plus `publishMembershipRecord` and `convenerEvidenceOf`. The producer residual gaps 0 and 6 were both waiting on. |
| [`src/stream.ts`](src/stream.ts) | one participant's log: `appendEntry`, `readStream`, `verifyChain`, `readAttestation`. |
| [`src/compose.ts`](src/compose.ts) | many pods read as one workspace: `composeWorkspace`, `resolveCitations`. |
| [`src/can.ts`](src/can.ts) | authority: `canAct`, `authorizeView`, `scopesFromRegistry`, `signerIndexFromRegistry`. |
| [`tools/verify-stream-live.ts`](tools/verify-stream-live.ts) | the stream, against the **live** relay. |
| [`tools/verify-compose-live.ts`](tools/verify-compose-live.ts) | two real identities, two real pods, one view. |
| [`tools/verify-can-live.ts`](tools/verify-can-live.ts) | a live refusal, at both layers that can refuse. |
| [`../../docs/applications/shared-workspace/wsp.ttl`](../../docs/applications/shared-workspace/wsp.ttl) | the vocabulary |
| [`../../docs/applications/shared-workspace/wsp-shapes.ttl`](../../docs/applications/shared-workspace/wsp-shapes.ttl) | SHACL, enforced at publish |
| [`../../docs/applications/shared-workspace/wsp-roles-default.ttl`](../../docs/applications/shared-workspace/wsp-roles-default.ttl) | five roles, as **data** |
| `../../docs/applications/shared-workspace/{wsp,wsp-shapes,wsp-roles-default}.html` | what the three IRIs above **dereference to**. GitHub Pages serves no extensionless path and falls back to `<name>.html`, so these pages are why `<…/wsp-roles-default>` answers 200 instead of 404 — and each carries `<link rel="alternate" type="text/turtle">` pointing at the `.ttl` beside it, which is how a machine gets from the name to the document. Same convention as `docs/ns/*.html`. `dereferenceRoleProfile` follows that link; see `followAlternateTurtle` in `@interego/core` |

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
- **A reader refuses more than the shape does, and never drops a restriction — and on scheme
  it refuses EXACTLY what the shape does.** Two `wsp:grantedTo` triples are refused rather than
  resolved first-match; an unreadable `wsp:revoked` reads as **set**; a record damaged in a
  non-identifying field still reaches the fold, because it may carry a revocation and deleting
  it would reinstate a removed member. The scheme clause used to carry an exception on
  `wsp:member`, and the exception was seven fields wide — see the closed row. `oneIri` now
  consults `PUBLISHED_IRI_PATTERN`, a verbatim copy of the deployed `sh:pattern` for each of the
  eight terms it reads, and a test parses `wsp-shapes.ttl` and compares the two. **Equality is
  the requirement in both directions here**: `wsp:stream` carries no pattern in the shape, so
  the reader applies none, and refusing there would be the same defect pointing the other way.

**What it still does not mean.** *"bee is a field-bound member"* means **two records, each
signed by the party it claims to come from, each stating this membership in the region of its
own bytes the substrate re-digested and matched**. The qualifier is not pedantry: without it
the sentence was false, because the reader parsed a strictly wider region than the digest
covered and a convener could manufacture a participant in the difference. It says nothing at
all about whether the convener was entitled to convene: that is a **separate field answering a
separate question**, `Roster.convenerBinding`, and `recordFieldBinding: 'bound'` beside
`convenerBinding: 'unchecked'` is a roster of perfectly parsed records that may be about the
wrong memberships (**gap 6**, closed under a policy you must ask for). It also does not bind
`Member.role` — a derived label, foldable downward by a refused row. All of that is stated
below rather than absorbed into the sentence above. (The third item that used to sit here —
`wsp:member` resting on our reader rather than the published contract, **gap 7** — is closed;
see "Closed in this round".)

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
`convenerBinding` is a **third**, for the same reason one question further out — it answers
*was the party these records came from entitled to grant here*, which neither of the other two
touches, and it has **three** values rather than two because "the caller did not ask" and "the
caller asked and the answer was no" are different facts and only one of them is a refusal.
`roleProfileBinding` is a **fourth**, off the *same record* as the third and still its own
field, because it answers *did the governance that decided these capabilities come from the
workspace* — which the convener's verdict does not touch. A record can name the right profile
and the wrong convener, or the reverse, and the eleven-shape table asserts exactly those two
pairings. Collapsing them would also collapse the repair: one republishes a workspace record,
the other re-folds against the declared governance.

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

**6. That the convener is the workspace's convener — now closed, under a policy you must ask
for.** Kept with its history, like gap 0, because what replaced it matters more than the fact
that something did.

**What it was.** `AttestationPolicy.convener` — the principal every grant is attested against
— was named by **the caller of `foldRoster`**. Neither the fold nor `membership.ts` read
`<workspace>` and checked its `wsp:convener` against it, so a policy naming the wrong party
produced a roster that was field-bound, content-bound, signer-checked, reported as
`recordFieldBinding: 'bound'`, and **about the wrong memberships**. `verify-can-live.ts` §8
asserted it rather than describing it — fold the same two genuine records under
`convener: bee`, watch the membership vanish, watch `recordFieldBinding` still say `'bound'` —
and **that assertion passed live** in the 46/46 run. The gap was a measurement, not a worry.

**Why it stayed open, and it is the same reason gap 0 did.** A published shape described a
record no code in the repo wrote. `wspsh:WorkspaceShape` has required exactly one
`wsp:convener` since it was published; nothing had ever emitted a `wsp:Workspace`, so the
convener a policy claimed had nothing to be compared against.

**What closes it.** `workspaceTurtle` serializes it through the same guards as the two
membership halves; `publishMembershipRecord` publishes it shape-validated and signed and waits
for it to be readable; `readWorkspaceRecord` reads it back in **one** `get_descriptor` and
parses `wsp:convener` out of the same `digestedGraphRegion` the digest covers.
`AttestationPolicy.workspaceEvidence` carries it into the fold and
`refuseConvenerAuthority` compares four things: that the record's **subject** is this
workspace, that its convener is the policy's, that its own authorship holds up, and that its
own fields were parsed. `Roster.convenerBinding` reports `'bound'` / `'refused'` /
`'unchecked'` and is non-omittable.

Three things about the *direction* are load-bearing, and each one is a defect that was
available:

- **Evidence can refuse a convener; it can never supply one.** The obvious implementation is
  `convener = workspaceRecord.convener ?? policy.convener` — read it from the workspace and
  use it. That is an **escalation**: a policy naming a stranger, handed a workspace naming the
  real convener, would start admitting every grant it was refusing, so *passing evidence would
  grant more than withholding it*. Enumerated at all 76,800 lattice points and pinned by its
  own case.
- **A disagreement refuses on the conferring track only.** It removes the power to make
  members; it does not remove the records that unmake them. A revocation still revokes, a
  withdrawal still withdraws, `restrictionStillApplied` still says so, and the fork report is
  still raised — the exact inversion round 3 shipped, at a gate that fires on *every* grant at
  once.
- **Asking and getting silence is not the same as not asking.** `ConvenerEvidence` has a
  second member, `{kind: 'unreadable'}`, and `convenerEvidenceOf` maps a failed read onto it.
  A bare optional record would let a transient `get_descriptor` failure silently reopen this
  gap with `'unchecked'` as the only trace.

**What it still does not mean.** These readers are handed a descriptor URL; none of them
dereferences a logical name to find one. So `'bound'` means *a record whose subject is
`<workspace>` names this convener, signed by an agent that principal's own registry vouches
for, over bytes the substrate re-digested* — **not** *that record is what `<workspace>`
resolves to*. A caller that obtained the URL by dereferencing `<workspace>` holds both; a
caller handed a URL holds the first. Structurally the same residue as `head` under a
`slug-only` binding — **gap 1** — and it is why the live verifier publishes the workspace
record at graph IRI `<WS>` rather than at a name minted beside it.

**And one new gap fell out of building it — gap 8, below, now closed in the round after it.**
`foldRoster` took its `RoleProfile` from its caller, exactly as it used to take the convener,
off a record that declares one. The deferral was deliberate and it was the right call: the
comparison turned out to need two guards that had nothing to do with the convener's — an
emptiness rule above the equality test, and a generator axis without which the new rung would
have ridden the whole lattice refusing nothing.

**7. `wsp:member` is enforced by this reader, not by the published shape — CLOSED.**
`wspsh:MembershipAcceptanceShape` constrained `wsp:accepts`, `wsp:stream`, `wsp:workspace` and
`wsp:withdrawn` and said nothing about **who is accepting**, so the publish gate accepted an
acceptance attributed to nobody while `readAcceptanceRecord` refused one — a conformant reader
elsewhere, validating the same record against the same shape, would have admitted it.

`docs/applications/shared-workspace/wsp-shapes.ttl` now carries
`sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ; sh:pattern "^https?://|^did:"` on
`wsp:member`, and `wsp.ttl`'s `rdfs:comment` was updated to match. **This is a live behaviour
change to a deployed artifact**: `membership.ts` passes `conforms_to_shapes: [WSP_SHAPES]` and
the relay's shape cache TTL is 60s, so on merge and Pages rebuild the live gate starts
refusing memberless acceptances within a minute. Pinned by `acceptance-no-member`,
`acceptance-two-members` and `acceptance-urn-member` in `tools/shacl-agreement/fixtures/`,
where our engine and pySHACL must agree on the verdict, and by the byte-for-byte drift diff
between the published file and its fixture copy.

One consequence was recorded here, because it inverted a sentence stated elsewhere in this
document: `oneIri` applied no scheme pattern, so a `urn:` member was refused by the **shape**
and admitted by the **reader** — "the only field where the shape is the stricter of the two".

★ **That sentence was wrong about its own scope, and the correction is the finding.** It was
never one field. `wsp-shapes.ttl` patterns `wsp:convener`, `wsp:roleProfile`, `wsp:workspace`,
`wsp:grantedTo`, `wsp:role`, `wsp:member` and `wsp:accepts` — seven of the eight terms `oneIri`
reads — and the reader applied none of them: a grant naming `<urn:example:ws>`,
`<urn:example:who>` and `<urn:example:role>` parsed with an **empty** `problems` array, and so
did a workspace record declaring `<urn:example:conv>` and `<urn:example:roles>`. Measuring it
rather than re-reading the row is what surfaced that, which is the discipline this document's
own ledger prescribes two sections down and had not applied here.

Closed by `PUBLISHED_IRI_PATTERN` in `membership.ts`: one table, keyed by predicate, consulted
by `oneIri` for every term so no call site can forget, holding the deployed patterns verbatim
and matched with SHACL's own partial-match semantics rather than a re-anchored regex. Two
mechanisms keep it from drifting: the **type** makes a term with no entry a compile error, and
a test parses the deployed `wsp-shapes.ttl` and asserts the table equals it. The remaining
asymmetry is deliberate and is the other direction — `wsp:stream` has no `sh:pattern`, so the
reader constrains nothing there, and a `urn:` stream is admitted by both.

**8. The role profile was caller-supplied and unchecked — gap 6 one field over. CLOSED.**
Found while closing gap 6, deferred one round on purpose, and closed here.
`wspsh:WorkspaceShape` requires exactly one `wsp:roleProfile`, `readWorkspaceRecord` parses it,
and `WorkspaceRecord.roleProfile` carried it — while `foldRoster` took its `RoleProfile` from
`args.profile`, which is whatever the caller passed. `permitsOf` is built from that document,
so it decides **every capability in the roster**.

**What was actually reachable, measured before anything was written.** Role IRIs are strings,
so a rival profile can redeclare the *declared* profile's own `#Observer` with `grant` and
`revoke` on it. Folded that way, the roster reported `convenerBinding: 'bound'`,
`recordFieldBinding: 'bound'`, `unattested: []` — and an Observer holding
`read, append, grant, revoke`. Every guard this layer had passed at full strength; the
capabilities came out of a document the workspace never published.

**What closes it.** The same signed record already carries the answer.
`refuseRoleProfileAuthority` compares `WorkspaceRecord.roleProfile` against
`RoleProfile.profile` and `Roster.roleProfileBinding` reports `'bound'` / `'refused'` /
`'unchecked'`, non-omittable, beside `convenerBinding`. It is a **second** function rather than
two more branches in the convener's, and a **fourth** field rather than a value folded into the
third, because the two are repaired differently: one republishes a workspace record, the other
re-folds against the declared governance.

Gap 6's three load-bearing directions are copied deliberately rather than re-derived, and each
was available here too:

- **Evidence can refuse a profile; it can never supply one.** There is no
  `profile = ws.roleProfile ?? args.profile`, for the same reason there is no such line for the
  convener — and here the substitution could not even be written honestly, since the fold holds
  an **IRI** and not the document.
- **A disagreement refuses on the conferring track only.** `profileRefusal` sits in the grant
  filter's `??` chain and nowhere else, so a revocation still revokes, a withdrawal still
  withdraws, `restrictionStillApplied` still says so, and the fork report is still raised. It is
  **not** in the acceptance chain either: a member's own statement about their own pod is no
  less theirs because the convener's side named the wrong governance.
- **Three values, not two.** `'unchecked'` is what every caller written before this field gets,
  and it is a different fact from `'refused'`.

Two things the round added that gap 6's did not, both because a rung can pass while doing
nothing:

- **The enumeration has a matching GENERATOR axis.** Every workspace record the two convener
  shapes generate declares `P`, and the fold is always handed `PROFILE` whose `.profile` is `P`
  — so a profile rung crossed against only those shapes agrees at all 76,800 points and refuses
  nothing. `'declares-another-profile'` is the third shape, `profileRefused` counts the refusing
  direction during the loop, and it is asserted non-zero after it. That failure has happened
  twice in this file (AXIS E at 6,400 cases; AXIS G before its own generator), which is why it
  is now written down as the rule rather than the anecdote.
- **Each shape moves exactly ONE field, so the table asserts independence.**
  `'names-another'` must report the convener `'refused'` and the profile `'bound'`;
  `'declares-another-profile'` must do the opposite. A fold that answered either question with
  the other's verdict cannot satisfy both rows.

**What it still does not mean — and this claim is shorter than the other two bindings'.**
`RoleProfile.profile` is the caller's own statement of where its `roles` came from, so
`roleProfileBinding: 'bound'` says the caller's table *claims* to be the declared profile; it does
not say it **is**. A caller that writes the declared IRI over an invented set of permits passes
this check. That was **residual gap 10**, and it is closed one section down by a second, separate
verdict — `roleTableBinding`, off a different document — rather than by strengthening this one.
The two stay apart on purpose: which document governs and what is inside it are different faults
with different repairs, and a fold can legitimately report `('bound','unchecked')` (the right
profile named, nobody having read it) or `('unchecked','bound')` (a table faithfully read from a
document nobody has shown governs this workspace).

`verify-can-live.ts` **§10** demonstrates it live — the rogue profile is folded against the two
real §8 records, shown to widen bee beyond what alice's governance permits, then refused by the
workspace's own declaration *for the right reason* (`convenerBinding` stays `'bound'`, so it is
the profile's own refusal and not gap 6's check firing twice) — with the agreement CONTROL
asserted after it.

**9. The fold checks the evidence and never asks where it came from.** Found by running §9 for
the first time, which is the point: gap 6's close had been reviewed against doubles for a round
and this is not visible in a double, because a double hands the fold whatever record the test
constructs and the question is *which record a reader would find*.

`refuseConvenerAuthority` asks a `ConvenerEvidence` three questions — is its subject this
workspace, does it name this policy's convener, does it hold up as a signed, content-bound
record. Bee writes a `wsp:MembershipGrant`-shaped attack in gap 6's terms and it is refused.
Bee writes a **`wsp:Workspace`** for alice's workspace, on her own pod, naming herself
convener, and it answers all three: the subject is a triple she chose, and the signature is
hers over her own claim. Measured live — `verify-can-live.ts` §9's closing pair — the fold that
refused her self-convened membership two assertions earlier reports `convenerBinding: 'bound'`
and admits her.

Nothing here is wrong about what the fold *says*: `ConvenerEvidence` is documented as evidence
the caller supplies, and a caller that supplies bee's record gets an answer about bee's record.
What was wrong is the scope the closure was read at. It holds for a reader who obtained the
evidence by **dereferencing `<WS>`**, and until this round `<WS>` did not dereference at all —
the tool built it under `/ns/maintainer/…`, a pod neither principal can write to, so the URL
answered 404 on every run and the comment saying otherwise had never been checked.

It is closable by **sourcing** rather than by trusting the record — relate the descriptor URL
the evidence was read from to the workspace IRI it claims, the way `proofBindsToDescriptorUrl`
already relates a proof to its descriptor. That is a change to `src/roster.ts` and it is not
made in the round that found it, for the reason gap 8 gives one paragraph up.

**10. The role TABLE behind the profile IRI was still the caller's.** The residue of closing
gap 8, and the last of the family. **Closed in this round**; the two things that remain are
stated at the end of this section rather than folded into the sentence that says it is closed.

`refuseRoleProfileAuthority` compares `WorkspaceRecord.roleProfile` with `RoleProfile.profile`:
an **IRI** against an **IRI**. So did gap 6 (a convener) and gap 9 (a descriptor URL). All three
compare **names**, and the thing every capability in the roster is computed from is the role
**table** those names point at — `permitsOf` is built from `RoleProfile.roles`. Measured before
the check existed: `convenerBinding: 'bound'`, `roleProfileBinding: 'bound'`,
`recordFieldBinding: 'bound'`, `unattested: []`, and an `#Observer` holding `grant` and `revoke`,
because `{profile: <the declared IRI>, roles: [anything]}` agrees with every name anybody
compares.

`dereferenceRoleProfile` is the producer — it asks the IRI — and `refuseRoleTableAuthority`
compares what came back with what the fold used, role for role and capability for capability,
under `normaliseRoleTable`, which is **literally the function that builds `permitsOf`** rather
than a second copy of its rule. Any difference refuses, including one that narrows: an omitted
role moves `knownRole`, which is the label printed beside a member's capabilities, in a direction
no subset check can see.

**Two paths, because a role profile is not always a pod record.** A profile at
`<relay>/ns/<owner>/<slug>` is resolved through the pod its owner segment names — the same route
gap 9 closed on — and comes back as a signed record read through the digested region. Anything
else is an ordinary HTTPS document. The distinction is carried in `RoleTableAuthority` rather
than smoothed over, and four guards ride the second path: `https:` only (deliberately stricter
than the shape's `^https?://`, because for a document nobody signs the transport is the entire
evidence), a cross-origin **redirect** refuses (the origin **is** the authority), a cross-origin
**`rel=alternate`** refuses (a separate guard, because a redirect is the *server* choosing where
the answer comes from and an alternate link is the *document* choosing — a claim written by
whoever can write the page), and any non-200 is `'unreadable'`, which refuses to confer.

### What this grade is actually worth — and it is smaller than the other three

A workspace IRI names a **pod**, and the substrate refuses everyone but its holder a write there;
that is what made gap 9 closable by *sourcing* rather than by trusting a record. A role profile
IRI names a **host**. The profile every workspace in this repo declares is a static file on
GitHub Pages, and it **cannot carry an authorship proof at all** — nothing published it, there is
no descriptor for a proof to bind to, and no digested region for a signature to cover. Saying it
plainly rather than leaving it to be inferred:

> For that document, `roleTableBinding: 'bound'` means *this origin served these bytes at this
> URL at the moment of the read*. Nobody signed them. Nothing about them is checkable afterwards,
> offline, or by anyone who was not present at the fetch, and a host that changes the file changes
> the governance with no signature to notice it by.

So no policy flag demands a signed role table. A rule that did would refuse the only role table in
existence — the same failure direction `descriptorBindingBasis` records the decision not to take.
What is done instead is that the grade **travels**: `Roster.attributionNote` says in words which
of the two it was, because a three-valued enum cannot carry the difference and a caller reading
`'bound'` beside a Pages file would otherwise reasonably hear "signed".

### The declared IRI dereferences now, and the reader follows the page's own link

This section used to be headed *"And the declared IRI does not dereference"*, and it was an
accurate measurement: `<…/wsp-roles-default>` answered **404**, only `<…/wsp-roles-default.ttl>`
answered 200, and the full workspace → profile → table chain therefore could not close against
the deployed artifact. `docs/applications/shared-workspace/wsp-roles-default.html` fixed that,
and the fix immediately produced a second defect one layer up.

GitHub Pages serves no extensionless path. It falls back to `<name>.html`, so the declared IRI
now answers **200 `text/html`** — the human-readable projection, carrying
`<link rel="alternate" type="text/turtle">` beside it, exactly as `docs/ns/*.html` do.
`dereferenceRoleProfile` had only ever seen a 404 at that IRI, so it handed the HTML to the
Turtle parser and reported the only published role profile in existence as *unreadable — unknown
bareword `"Default"`*. The document was there, at the IRI the workspace declares, and the only
reader of it could not see it.

**The follower already existed, in the relay.** Our ontology IRIs have never content-negotiated,
and `deploy/mcp-relay/alternate-turtle.ts` was written because that bit the publish path three
separate times. The fix is composition, not a second implementation: `looksLikeHtml` and
`alternateTurtleHref` moved to **`@interego/core`** — the one package both the relay and
`applications/` already depend on — together with two functions that had lived inline in
`server.ts`, `alternateTurtleUrl` (resolve the href against the page's own URL; refuse a
cross-origin one) and `followAlternateTurtle` (one hop, bounded). The relay **re-exports** them,
so its import surface is unchanged; that is the same move `graphIriFromDescriptorTurtle` and
`digestedGraphRegion` made into `@interego/solid` when a reader outside the relay needed them.

**It still does not guess.** Appending `.ttl` remains refused, for the reason that stood here
when the IRI 404'd: choosing a URL on the workspace's behalf is what `nsOwnerSegmentOf` refuses
to do one document over. What is followed is what the **page says about itself**, and a page
advertising no Turtle is `'unreadable'` with the `.ttl` twin never asked for. A live run cannot
tell following from guessing — our page advertises the same name a guesser would derive — so the
separation is pinned by doubles: `tests/workspace-membership.test.ts` serves a page whose
alternate names a *differently-named* Turtle and requires that one to be fetched.

**And the hop buys no grade.** `authority` is `'transport-only'` on both sides of the link,
because a static Pages file carries no authorship proof and no digested region either way; the
same-origin refusal is what stops the hop making the evidence *weaker*. `verify-can-live.ts` §12
asserts the grade explicitly beside the closed chain, so a later round cannot let four bound
gates add up to a signature.

`verify-can-live.ts` **§12** carries the demonstration, the control, and — new this round — the
whole chain with every gate on at once: convener, profile IRI, evidence provenance, role table
and record fields all `'bound'` against the deployed artifact, with the `attributionNote` still
saying *ordinary HTTPS fetch*. Run live, **11/11**. The **41-mutant sweep** across
`refuseRoleTableAuthority`, `compareRoleTables`, `normaliseRoleTable`, the fold's wiring and
`dereferenceRoleProfile` still stands and every mutant is still killed — and it is worth being
precise about what it was worth here, since it stood in for the run: it could not have found
either of this round's two defects, because both were facts about the world rather than about the
guard.

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
[`tools/verify-can-live.ts`](tools/verify-can-live.ts) (**88/88 live** across §§1–12, which
supersedes the earlier 13/13 over §§1–5, the 46/46 over §§1–8, the 63/63 over §§1–9 and the 77/77
over §§1–11 — each of those numbers was the file as it stood at *that* run).

**And 88 is likewise the file as it stood at *that* run.** The same caveat applied to 13/13,
46/46, 63/63 and 77/77 one sentence ago applies here, and applying it only backwards is how these
numbers go stale. Of the 88, §§1–8 hold **45** sites — 46 minus the `wrongConvener` assertion
that moved into §9 — §9 holds **18**, §10 **7**, §11 **7** and §12 **11**. The caveat has now
cashed out three times: 63 went stale when §10 was added, 63-plus-"§10 unrun" went stale when §10
was run, and 77-plus-"§12 unrun" went stale when §12 was run. Two of those first runs FAILED,
which is the other thing a bare count cannot tell you — §10 because the section was wrong, §12
because the world it measured had been repaired underneath it:

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
admit the first and refuse the second.

★ **Those sections have now been run, and so have §§9–12.** `verify-can-live.ts` §§1–12
were run against production with two real bearers and passed **88/88** — including the
forgery refused *for the right reason*, the manufactured-participant refused by the reader,
gap 6 shown open and then closed against a real `wsp:Workspace`, and the record read back by
the *other* party. Whether the live shape gate accepts a `wsp:Workspace` at a `/ns/…` graph IRI
is no longer read off the published shape: it accepts it, observed.

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
> ★ **And they hold.** The 46/46, then the 63/63, then the 77/77, then the 88/88 production runs put every one of those
> assertions in a state where it could fail, including all three CONTROLs, and none did. The
> sentence here used to say that whether they hold "is unknown"; it was true when written and
> it is not now.

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
> real rather than asserted to have been. Section 8 used to close by demonstrating **residual
> gap 6**: fold the two genuine records under `convener: bee`, and the membership vanishes
> while `recordFieldBinding` still reports `'bound'`.
>
> ★ **Section 8 ran, and that demonstration is what made gap 6 a measurement.** It is now
> **section 9** that carries the subject, and it CLOSES rather than demonstrates: alice
> publishes a real `wsp:Workspace` at `<WS>`, **bee** reads it back and parses it, and the fold
> is given it as `workspaceEvidence`. The control is asserted first — naming the convener the
> workspace names must ADMIT — then naming bee must produce no members with
> `convenerBinding: 'refused'` and the disagreement as the reason, then the same policy
> *without* the evidence is folded to prove the evidence never widened anything.
>
> **Section 9 has been run.** It passed **18/18** as part of a whole-file 88/88, two real
> bearers, distinct pods. Its first run is also what found residual gap 9: `<WS>` had never
> dereferenced, and the section said in a comment that it did.
>
> ★ **Section 10 closes gap 8, and it has now been run — after being fixed.** It is written in
> §9's shape and reuses §9's published records: fold the two real §8 records against a rogue
> role profile that redeclares the *declared* profile's own `#Observer` with `grant` and
> `revoke`, show it widens bee
> beyond what alice's governance permits, then hand the fold the workspace record and require
> the membership to vanish — with `convenerBinding` still `'bound'`, so it is the profile's own
> refusal and not gap 6's check firing twice. The agreement CONTROL is asserted after it, and a
> second control requires agreeing evidence to change the report and *nothing else*. One
> assertion is written as a **comparison** rather than as `effective.includes(revoke)` on
> purpose: effective capability is `role.permits ∩ delegatedScope` and the delegation comes
> from the live registry, so a run where bee's agent happens to be `PublishOnly` would fail
> that assertion for a reason with nothing to do with gap 8 — and a reader would be told the
> gap was closed by the thing that hid it.
>
> ★ **Section 11 closes gap 9, and it is the one section that had to ask the substrate a new
> question.** §§8–10 all check what a workspace record SAYS; §11 checks that it is the
> workspace's record. `dereferenceWorkspaceRecord` resolves `<WS>` through the pod its own
> `/ns` owner segment names (`get_current_head{urn, pod_name}`) and stamps the result with an
> `EvidenceProvenance`; `requireEvidenceProvenance` refuses anything without one. The section
> asserts, live and against the same forged record §9 admitted: the dereference returns
> **alice's** record; it is a **different document** from bee's, which is still published and
> still parses; bee's confers nothing under the flag; and — the half that makes it a
> measurement — `convenerBinding` and `roleProfileBinding` are both still `'bound'` on that
> fold, because bee's record agrees with bee's policy on both, which is exactly what made gap 9
> a gap. Two controls follow: the honestly dereferenced evidence must ADMIT and must change the
> report and *nothing else*, and a fold that did not ask must read `'unchecked'` rather than
> `'refused'`.

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
# forged acceptance alongside it for the fold to refuse (§6); §8, where both halves are real
# wsp:MembershipGrant / wsp:MembershipAcceptance documents whose FIELDS are parsed back out of
# the bytes, with the manufactured-participant attack run against both the new policy and the
# old one; and §9, where the CONVENER comes out of a real wsp:Workspace instead of out of this
# file; §10, where the ROLE PROFILE comes out of that same wsp:Workspace; §11, where the
# EVIDENCE must be the record <WS> actually dereferences to; and §12, where the ROLE TABLE comes
# out of the document that profile IRI resolves to — reached by following the published page's
# own rel=alternate, because the IRI serves text/html. §§1–12 passed 88/88 against production
# (§§1–8: 45, §9: 18, §10: 7, §11: 7, §12: 11).
#
# ★ The two bearers must resolve to DIFFERENT pods or the tool exits 2 saying "same pod —
# proves nothing", and the token that goes in IEP_BEARER is the CONVENER's: §9 builds the
# workspace URL under that principal's own /ns owner segment, because that is the pod the
# relay's /ns route reads when a stranger dereferences <WS>. Tokens TTL at 1h.
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
verifier — and, having now been run, are evidence rather than code.

★ And a harness can be caught a second way: by writing an assertion that **cannot fail**.
Sections 6–7 did, by reading three deferred publishes back with no wait, and the two
assertions that carried the property passed vacuously. They now wait, assert the refusal
*reason*, and carry a CONTROL that fails when nothing was admitted. An assertion that cannot
fail is worse than no assertion, because it is counted.

★ A third way, and §9 is written against it: **reading your own record back proves nothing**.
A convener fetching the workspace record she just published learns only that she still holds
the same opinion. §9 publishes it from alice's session and reads it back through **bee's**, so
what is established is that the other party can see who the workspace says may grant.

## Status

All six increments are built. What is verified, and what is not:

| | state |
|---|---|
| 1 roster, two-sided membership | built; **signer-checked, content-bound, field-bound, convener-checked and now governance-checked all the way to the table** — under `requireFieldBinding` every field is parsed from **the region of the record the digest covers**, under `workspaceEvidence` both the convener and the role-profile IRI come from the workspace instead of the caller, and under `roleTableEvidence` the role table itself comes from the document that IRI names. Doubles: six workspace suites, 76,800-configuration monotonicity enumeration across **ten** axes, a 41-mutant sweep on the newest one, and `tests/alternate-turtle.test.ts` on the follower the reader composes. Live: **88/88**, §§1–12 (45 sites in §§1–8, 18 in §9, 7 in §10, 7 in §11, 11 in §12) — including the whole chain with every gate on at once |
| 2 per-participant stream | built, **20/20 live** (the live run predates `sign_authorship`) |
| 3 composed cross-pod view | built, **14/14 live** across two identities on two pods |
| 4 authority at the fold | **88/88 live**, §§1–12, with two real bearers — the forgery refused for the right reason, the manufactured participant refused by the reader, gaps 6, 8, 9 and 10 each shown open at full strength and then closed against real records, and the inversion (evidence must never widen) held at every one of them. §9's first run opened **residual gap 9**; §11 closes it. §12's first run found that its own first three assertions had gone stale — they encoded the declared profile IRI's **404** as the expected state, and `docs/` had since fixed it — and that the fix had broken the reader, which got `text/html` and called the published governance unparseable. Both repaired; the **full chain now closes** against the deployed artifact with convener, profile IRI, evidence provenance, role table and record fields all bound |
| 5 engagement `gone` + injectable engine | built, 11 assertions, deployed |
| 6 independent SHACL agreement | built, **in CI** — `@interego/core` vs pySHACL |
| 7 membership records: serialize → publish → read → parse | built (`src/membership.ts`), **live** as part of the 88/88: the shape gate accepted both halves, the deferred-publish wait was needed and worked, and `get_descriptor` returned `graph.content` for them |
| 8 the workspace record: who may grant | built (`workspaceTurtle` / `readWorkspaceRecord` / `convenerEvidenceOf`) and **live** on 2026-08-02 — the shape gate accepted a `wsp:Workspace` at a `/ns/…` graph IRI, the *other* party read it back content-bound, and `<WS>` dereferences for an anonymous reader. What the fold did **not** check was where the evidence came from — **residual gap 9**, closed this round by `dereferenceWorkspaceRecord` + `requireEvidenceProvenance` and demonstrated live in §11 |
| 9 the same record: what a role permits | built (`refuseRoleProfileAuthority` / `Roster.roleProfileBinding`), closing **gap 8**. Doubles: the enumeration's AXIS H — the third workspace-evidence shape across all 76,800 configurations, with the refusing direction counted during the loop and asserted non-zero after it — plus the eleven-shape table, which now asserts a **pair** of verdicts per cell so neither question can be answered with the other's. `verify-can-live.ts` §10 has now been **run** (7/7) — and failed its first run, because its rogue profile declared `#Contributor` while §8's grant to bee names `#Observer`, so the rogue table conferred nothing and the escalation comparison was `0 > 1`. The doubles had it right; the live section copied the shape and named the other role |

★ **The one thing to carry away from this table** — and it has been rewritten, because the
sentence that stood here ("nothing on the field-binding row has met the live substrate") is no
longer true and a stale "unverified" is as much a defect as a stale "fixed". The field-binding
path HAS met the substrate: the live gate accepted `wsp:member`, and `get_descriptor` returned
`graph.content` for these records. **Row 8 has now met it too** — the live gate accepted a
`wsp:Workspace` at a `/ns/…` graph IRI, which until 2026-08-02 was assumed on the strength of
reading `wspsh:WorkspaceShape` rather than running it.

★ **And the sentence that replaced it is a warning about itself.** Every rewrite of this
paragraph has moved one item from "assumed" to "observed" and left the *rest* of the sentence
unexamined. What running row 8 actually established is narrower than "the workspace record
works": it established that the record publishes, parses, content-binds, and dereferences. It
established nothing about the record being the one a reader would *find*, and that turned out
to be the open question — **residual gap 9**, closed in this round by asking the workspace
instead of the caller.

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
| ★ **the relay's shape gate follows a `rel=alternate` without the two guards the shared follower applies** — the residue of moving the follower into `@interego/core`. `fetchShapeBody` in `deploy/mcp-relay/server.ts` still does its hop inline: it resolves the href relative to the shape IRI (correct) and stops after one hop (correct, structurally — there is no loop), but it does **not** refuse a cross-origin alternate, so a shape host that advertises a foreign origin's Turtle has its `owl:imports` and `sh:` constraints taken from that origin. Not moved onto `followAlternateTurtle` in this round because that hop is entangled with the shape cache's last-known-good fallback and uses `guardedInvokeFetch` — the SSRF guard every caller-URL fetch in that file goes through — and rewiring a live publish gate is a change with its own blast radius and its own test surface. What was fixed here is the thing that matters most: there is now **one** parser of the markup, not two. Named in `deploy/mcp-relay/alternate-turtle.ts` as well as here, so the next round to touch that file finds it | medium |
| ★ **`roleTableBinding: 'bound'` over a Pages file means a TLS fetch, not a signature** — the residue of closing gap 10, and it is a ceiling rather than an oversight. A static GitHub Pages document cannot carry an `iep:authorshipProof`: nothing published it, there is no descriptor to bind a proof to, and no digested region. So for the profile this repo actually declares, `'bound'` means *this origin served these bytes at this URL at the moment of the read*, defended by TLS and by whoever holds the host, and re-checkable by nobody afterwards. `RoleTableAuthority` carries which of the two grades was reached and `Roster.attributionNote` states it in words, because a three-valued enum cannot. **No policy flag demands the stronger grade**, deliberately: a rule requiring a signed role table would refuse the only role table in existence, which is the `exact-url` mistake under another name. A profile published to `<relay>/ns/<owner>/<slug>` *is* a signed pod record and gets the stronger reading — the path exists, and nothing in this repo uses it yet | medium |
| ★ **the role-table evidence is still the CALLER'S claim** — the same residue `EvidenceProvenance` and `FieldProvenance` carried before they were branded, one document further out. `roster.ts` is pure, so `RoleTableEvidence` is the caller's statement that it performed the dereference; what the fold can check — and does — is that the IRI dereferenced is the profile its own table claims, that the tables agree role for role, and that the document is not self-contradictory about how it was obtained. A caller that hand-writes a `RoleProfileDocument` beside an invented table passes. Closable the same way the other two were: brand `RoleProfileDocument` on a non-exported private-membered class so only `membership.ts` can mint one. Not done in this round, because that mechanism landed in a **different, concurrent** round and adopting it half-informed in the diff that adds its fourth instance is the move this area has shipped a defect on repeatedly | medium |
| ★ **the evidence's provenance is still the CALLER'S claim** — the residue of closing gap 9, named here rather than absorbed into the row that says gap 9 is closed. `refuseEvidenceProvenance` checks two relations it can check without trusting anybody — the IRI dereferenced is the workspace being folded, and the document that dereference resolved to is the record's own `head` — and `roster.ts` is pure, so it cannot fetch and cannot verify that a dereference happened at all. A caller that hand-writes both fields beside a record it forged passes. Structurally identical to what `FieldProvenance` was before `membership.ts` existed to produce it, and closed the same way and to the same degree: there is now a producer (`dereferenceWorkspaceRecord`), and the substrate refuses everyone but a pod's holder a write there. What the flag cannot do is make a liar honest | medium |
| `tools/shacl-agreement/fixtures/` pins **two** of the **seven** patterned terms against pySHACL: three fixtures (`acceptance-urn-member` → `wsp:member`; `grant-urn-principal` and `grant-did-principal` → `wsp:grantedTo`) exercising two distinct terms. This row said "three of the eight … the other five" and was wrong at both ends — the shape patterns **seven** terms, not eight (`wsp:stream` carries none, as the closed row below states correctly), and three fixtures are not three terms. 2 + 5 = 7. The reader side of all seven is covered by the drift test; the two engines agreeing on the other **five** is assumed rather than measured | low |
| `Member.stream` can legitimately differ between two configurations of the same fold: naming the stream is a conferring act, so refusing an acceptance re-picks the head. No authority moves with it, and it is never silent — both configurations raise the `acceptance` divergence — but a caller that reads `stream` without reading `divergences` will go to a different pod under a stricter policy | low-med |
| `proofBindsToDescriptorUrl` compares **a URN-form id** on its terminal segment only, and every `descriptor_id` the relay mints is a URN — so a party who controls a pod and chooses a colliding epoch reaches `bound: true, basis: 'slug-only'` on any host. A URL-form id **is** compared in full, host included, and nothing in this tree mints one. What this leaves reachable, measured: not any conferred value, but `head` — the URL an operator dereferences to audit the record and the URL printed in `unattested` and every `divergence` — residual gap 1 | medium |
| `wsp:seq` has no producer: `ManifestEntry` carries no `seq`, so the sequence check is inert on every real read — residual gap 5 | low-med |
| ★ **an assertion that encodes a defect goes stale the moment somebody fixes the defect, and nothing in this repo notices** — §12's first three assertions were correct measurements of a broken artifact (`<…/wsp-roles-default>` answers 404) written as the section's *expected state*. `docs/` fixed the artifact in a different round and the assertions kept asserting the breakage; they were rewritten only because somebody ran the file. The mitigation the last row proposed (a numbered section roster carrying a run **count**) worked for the question it was aimed at — "which sections are unrun" — and is blind to this one. No mechanism here distinguishes *this fails because the code regressed* from *this fails because the world was repaired*, and the only signal is a human reading the failure text. Cheap partial fix, not taken this round: mark such assertions in the source with a convention a grep can find, so a round touching `docs/` can be pointed at the assertions that describe `docs/` | low-med *(honesty, not behaviour)* |
| a `Grant` or `Acceptance` refused for naming **two** grantees takes any revocation on it out of the fold entirely. Refusing is the only honest reading — the record does not say who it grants to — but the cost is real and is paid in the restricting direction, which is the direction this module otherwise protects | low-med |
| `headOf` on a forked chain throws rather than returning a value; `appendEntry` converts it to a named `conflict` first, so the shipped path is safe and a direct caller must catch | low |

**Closed in this round, with the test that pins each:**

| | where |
|---|---|
| ★★ **the published governance was unreadable to the only reader of it, and the cause was the round that made its IRI resolve** — `docs/applications/shared-workspace/wsp-roles-default.html` shipped so the vocabulary's extensionless IRIs would dereference instead of 404ing. GitHub Pages serves no extensionless path and falls back to `<name>.html`, so `<…/wsp-roles-default>` began answering **200 `text/html`** — and `dereferenceRoleProfile`, which had only ever seen a 404 there, handed the page to the Turtle parser and reported the deployed role profile as `unreadable … unknown bareword "Default"`. Closed by **composing the follower that already existed** rather than writing a second one: `looksLikeHtml` / `alternateTurtleHref` moved from `deploy/mcp-relay/alternate-turtle.ts` into `@interego/core`, joined by `alternateTurtleUrl` (resolve the href against the page's own URL; refuse a cross-origin one; refuse an opaque origin on either side) and `followAlternateTurtle` (one hop, bounded by a constant; the landed URL re-checked so a redirect cannot reach what a foreign href is refused for). The relay re-exports the two predicates, so its import surface is unchanged — the `graphIriFromDescriptorTurtle` precedent. **The grade does not move**: `authority` is `'transport-only'` either side of the link, asserted live | `tests/alternate-turtle.test.ts` (10 cases: relative resolution incl. `..`/root-relative/absolute, cross-origin by host **and** port **and** scheme, opaque origins, the real `docs/` page read off disk, Turtle passed through with zero fetches, the differently-named alternate, the one-hop bound asserted on the FETCH COUNT, redirect-off-origin with its same-origin control, and absent/404/throwing); `tests/workspace-membership.test.ts` "the DEPLOYED shape … is FOLLOWED", "it follows the href the PAGE names", "a page that advertises NO Turtle is refused, and the `.ttl` twin is still not guessed", "a CROSS-ORIGIN alternate is refused, and a chain of pages is not chased"; `verify-can-live.ts` §12, run live |
| ★★★ **residual gap 10** — the last of the gap-6 family, and the first check in it that opens a **document** rather than comparing a **name**. Gaps 6, 8 and 9 established, in order: the convener must match the workspace's own record, the role-profile IRI must match the one that record declares, and the evidence must be the record `<WS>` actually dereferences to. All three compare names. The thing every capability in a roster is computed from is the role **table** those names point at — `permitsOf` is built from `RoleProfile.roles` — and that array was the caller's. Measured before the check existed: `convenerBinding: 'bound'`, `roleProfileBinding: 'bound'`, `recordFieldBinding: 'bound'`, `unattested: []`, and an `#Observer` holding `grant` and `revoke`. Closed by `dereferenceRoleProfile` (the producer, in `membership.ts`) + `RoleProfileDocument` / `RoleTableEvidence` + `refuseRoleTableAuthority` + `AttestationPolicy.roleTableEvidence` + `Roster.roleTableBinding`, copying gap 6's three directions **deliberately**: the document is evidence and never a source (there is no `profile.roles = document.roles`, and the substitution is worse here than for the convener — a caller with a *narrower* table would be handed the published one and start conferring more), the refusal is in the grant filter's `??` chain **only**, and `'unchecked'` is a third value distinct from `'refused'`. `normaliseRoleTable` is **the same function** that builds `permitsOf`, extracted rather than copied, so `'bound'` cannot mean "these agree under a rule the fold does not use". Two residues named rather than absorbed, in the open table above | `workspace-adversarial` AXIS J (five role-table shapes across all 76,800 configurations, four of them refusing, with a **per-shape** non-vacuity counter), "AXIS J closes RESIDUAL GAP 10", "AXIS J is not vacuous", "any difference refuses", "the comparison uses the fold's OWN normalisation", "the document's table is EVIDENCE and never a SOURCE", "the authority label cannot be used to SKIP the signature check", "a table refusal never lands on the ACCEPTANCE side", the revocation/withdrawal pair, and the JSON-shape guards; `workspace-membership` "dereferenceRoleProfile" (13 cases) — and a **41-mutant sweep**, all killed |
| ★★ **six mutants survived the first sweep, and each one was a hole in the tests rather than in the code** — recorded because the sweep is the only reason they are not shipped. (1) The `'unreadable'` branch and (2) the wrong-IRI branch were covered by the 76,800-case lattice and by no fast case, so deleting either passed everything a reviewer would actually run. (3) `normaliseRoleTable`'s duplicate fixture was ordered **wide-then-narrow only**, and last-write-wins yields the same answer for that ordering — a test written to pin the intersection rule could not distinguish it from the rule it exists to forbid, which is this file's own "generator only produces agreement" failure reached from inside a test written to prevent it. (4) Substituting the document's table for the caller's — the escalation the design forbids — is *observationally invisible* while the comparison is total, and shows only where the two tables agree on what they permit but differ in **shape** (a duplicated role in the document produces a `role` divergence the caller's governance does not have). (5) Adding the table refusal to the **acceptance** filter is monotone, so every ⊆ assertion held; what it does is accuse the member of the convener's fault. (6) Parsing the whole served document instead of `payloadOf`'s digested region — the manufactured-participant hole one document out, and on a governance document it forges a **capability for every member at once** rather than one membership | `workspace-adversarial` + `workspace-membership`, one case per survivor; `scratchpad/mutate-gap10.mjs` |
| ★★★ **residual gap 9** — `refuseConvenerAuthority` asked a `ConvenerEvidence` three questions (is its subject *this* workspace, does it name *this* policy's convener, does it hold up as a signed content-bound record) and never asked where the evidence came from. Measured against production with two real bearers: **bee** published a `wsp:Workspace` for **alice's** workspace IRI, on **her own** pod, naming herself convener — it published, parsed with `problems: []`, content-bound, and the same fold that refuses her self-convened membership on alice's record reported `convenerBinding: 'bound'` and **admitted her**, `members: 1`. The subject is a triple its writer chooses, so no forger fails the first question. What closes it is that a workspace **is** a dereferenceable URL and exactly one party decides what it returns: `<relay>/ns/<owner>/<slug>` resolves against the pod its OWNER SEGMENT names (`resolveNsGraph`, `deploy/mcp-relay/server.ts:11657`) and against no other. Same run: an anonymous `GET <WS>` returned alice's record with bee's absent, `get_current_head{urn, pod_name: <owner>}` returned alice's descriptor unforked, and bee writing to alice's pod was refused `403 scope_violation`. Closed by `EvidenceProvenance` + `refuseEvidenceProvenance` + `AttestationPolicy.requireEvidenceProvenance` + `Roster.evidenceProvenanceBinding`, with `dereferenceWorkspaceRecord` as the producer — copying gap 6's three directions deliberately: evidence refuses and never supplies, the refusal is in the grant filter's `??` chain **only**, and `'unchecked'` is a third value distinct from `'refused'`. Residue named rather than absorbed, in the open table above | `workspace-adversarial` AXIS I (four evidence shapes across all 76,800 configurations, three of them forged, with a **per-shape** non-vacuity counter), "AXIS I is not vacuous", "AXIS I closes RESIDUAL GAP 9", the revocation/withdrawal pair, and the direct-call guard case; `verify-can-live.ts` §11, run live |
| ★ **`roleProfileBinding: 'bound'` was reachable from a workspace record nobody with authority over the workspace wrote** — a diagnostic-integrity defect, not an escalation. `refuseConvenerAuthority` reaches its authorship check only after proving `ws.convener === policy.convener`; `refuseRoleProfileAuthority` had no such precondition and validated the record against `ws.convener`, the value the record declares about **itself**. Reproduced through the real reader and live: a stranger's self-consistent record naming the true `wsp:roleProfile`, signed by her own registered agent, produced `convenerBinding: 'refused'` beside `roleProfileBinding: 'bound'`, whose contract reads "the governance these capabilities were computed under is the governance the workspace publishes". No capability moved — both refusals sit in the same `??` chain — so what was wrong was the **claim**, in a non-omittable security output. The pair `('refused','bound')` is now unreachable and the prose that called it "a coherent and expected pair" is gone | `workspace-adversarial` "roleProfileBinding is never `bound` off a record a stranger wrote" (which also re-asserts that the pair matrix still discriminates), the `conveneVerdicts` table, the eleven-shape table's `names-another` row at all three rungs, and the direct-call case |
| ★★★ **residual gap 8** — `foldRoster` took its `RoleProfile` from its caller while the workspace record declared one, and `permitsOf` is built from the caller's. Measured before anything was written: a rival profile that redeclares the declared profile's own `#Observer` with `grant` and `revoke` produced `convenerBinding: 'bound'`, `recordFieldBinding: 'bound'`, `unattested: []` and an Observer holding all four capabilities. Closed by `refuseRoleProfileAuthority` + `Roster.roleProfileBinding`, copying gap 6's three directions deliberately: evidence refuses and never supplies, the refusal is in the grant filter's `??` chain **only**, and `'unchecked'` is a third value. Residue named as **gap 10** rather than absorbed | `workspace-adversarial` AXIS H (lattice + `profileRefused` non-vacuity counter), "AXIS H is the ESCALATION it looks like", "two blanks do not agree", "both fields disagree", and the revocation/withdrawal pair; `workspace-membership` "an unreadable role profile"; `verify-can-live.ts` §10 |
| ★★ **the vacuity that was available while closing it** — a policy rung whose generator only ever produces agreement refuses nothing and passes every subset assertion on an untouched set. It has happened twice in this file (AXIS E at 6,400 cases; AXIS G before its own generator), so the third instance was written as a rule: the generator moves the declared profile as well as the declared convener, **one field at a time**, the refusing direction is counted *during* the 76,800-case loop, and the count is asserted non-zero after it. The one-field-at-a-time part is what makes the shape table an assertion about **independence** — `'names-another'` must report convener `refused` / profile `bound` and `'declares-another-profile'` the exact opposite, so a fold that answered either question with the other's verdict fails one of the two rows | `workspace-adversarial` AXIS H + the eleven-shape table |
| ★ **two blank profiles compared equal** — `readWorkspaceRecord` carries `''` when the record states no readable `wsp:roleProfile` (a `problem`, not a refusal, since a workspace record's conferring field is its convener), and a caller with no `profile` IRI arrives as `''` too. Left to `!==` those two blanks MATCH, and the fold would have reported the governance as bound because neither side named any. Both emptiness guards sit **above** the comparison, and a non-string `roleProfile` off the JSON boundary is refused explicitly rather than by happening-to | `workspace-adversarial` "two blanks do not agree", "a non-string roleProfile"; `workspace-membership` "an unreadable role profile" |
| ★ **the reader and the published contract refused different values, on seven fields and not one** — the row this replaces said `oneIri` applied no scheme pattern to `wsp:member` and called that "the one field where the shape is the stricter of the two". Reproduced against the readers rather than re-read: `wsp-shapes.ttl` patterns `wsp:convener`, `wsp:roleProfile`, `wsp:workspace`, `wsp:grantedTo`, `wsp:role`, `wsp:member` **and** `wsp:accepts`, and a grant naming `<urn:example:ws>`, `<urn:example:who>` and `<urn:example:role>` parsed with an **empty** `problems` array. A ledger row that understates its own scope sevenfold is the staleness this section keeps apologising for, in the section. Closed by `PUBLISHED_IRI_PATTERN`, consulted centrally by `oneIri`, with SHACL's own partial-match semantics; `wsp:stream` stays unconstrained because the shape leaves it so — tightening it would be the same defect pointing the other way | `workspace-membership` "oneIri applies the published shape's own sh:pattern" — the drift case parses the deployed `wsp-shapes.ttl` and compares it with the table, and the type makes an unlisted term a compile error |
| ★★★ **residual gap 6** — `AttestationPolicy.convener` was named by the caller, so a field-bound, content-bound, signer-checked roster could be about entirely the wrong memberships. Closed by the same treatment gap 0 got, applied to the record that was missing: `workspaceTurtle` / `readWorkspaceRecord` write and parse a `wsp:Workspace`, `workspaceEvidence` carries it in, `refuseConvenerAuthority` compares subject, convener, authorship and provenance, and `convenerBinding` reports which of the three answers came back. The direction is the whole of it — evidence can refuse a convener and can never supply one, and a disagreement refuses on the conferring track only | `workspace-membership` "the workspace record"; `workspace-adversarial` axis G, plus "THE INVERSION" and the revocation/withdrawal cases |
| ★★ **the inversion that was available while closing it**: `convener = workspaceRecord.convener ?? policy.convener` is the obvious implementation and it turns evidence into a **source** of authority — a policy naming a stranger, handed a workspace naming the real convener, starts admitting grants it was refusing. Caught by generating the disagreeing record as `alice`, whose key is one of the enumerated signers, so `assertNoWiderThan` reaches it at every lattice point | `workspace-adversarial` axis G + "THE INVERSION" |
| ★ **residual gap 7** — `wspsh:MembershipAcceptanceShape` did not constrain `wsp:member`, so the publish gate admitted an acceptance attributed to nobody and only `readAcceptanceRecord` refused it. A conformant reader elsewhere, validating the same record against the same published shape, would have admitted it. Closed by `sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ; sh:pattern "^https?://\|^did:"` on the **deployed** shape (`wsp.ttl`'s `rdfs:comment` updated to match), which changes what the live gate accepts within one 60s shape-cache TTL of merge | `tools/shacl-agreement` fixtures `acceptance-no-member`, `acceptance-two-members`, `acceptance-urn-member` — both engines must agree; plus the byte-for-byte drift diff against the published file |
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

**The alternate-link round: 10 mutants, 10 killed, and the interesting ones are the two that
are not about the new code.** Eight were applied to `packages/core/src/rdf/alternate-turtle.ts`,
each alone, with `@interego/core` rebuilt (tests resolve it to `dist/`) and
`node_modules/.vite` cleared between them; two to the composition point in
`dereferenceRoleProfile`.

| mutant | killed by |
|---|---|
| hop budget raised from 1 to **2** — still terminates, still refuses | `alternate-turtle` "HOPS EXACTLY ONCE": the assertion is on the FETCH COUNT, not the outcome, which is the only thing that can see a weakened bound |
| the hop bound removed entirely | same test, as a timeout — an unbounded follower spins on a self-pointing page forever |
| relative resolution dropped (`new URL(href)`) | `alternate-turtle` relative-resolution case, and the one that reads the real `docs/` page off disk. Every page we publish writes a relative href, so this mutant fetches nothing in production |
| relative resolution done by concatenating the origin | same, on the `../vocab/roles.ttl` case — a concatenation gets the right answer for the flat case and the wrong one for any other |
| cross-origin alternate admitted | `alternate-turtle` cross-origin case (host, port **and** scheme) and `workspace-membership` "a CROSS-ORIGIN alternate is refused" |
| opaque-origin guard removed | `alternate-turtle` opaque-origin case. `data:` and `file:` both report origin `'null'`, so a bare `!==` reads them as same-origin |
| landed-origin check on the hop removed | `alternate-turtle` "a REDIRECT off the origin on the hop is refused". A same-origin href that redirects away is the case an href check structurally cannot see |
| a non-200 alternate read anyway | `alternate-turtle` absent/404/throwing case |
| ★ **the follow skipped entirely** — the reader exactly as it stood before this round | four `workspace-membership` cases. This is the mutant that says the round did something: it reproduces the live defect |
| ★★ **the reflex fix — guess `<IRI>.ttl` instead of following the advertised link** | three `workspace-membership` cases, led by "it follows the href the PAGE names". The double serves a page advertising a *differently-named* Turtle and puts a WIDER table at the guessable URL, so the guesser does not fail — it silently confers `grant` and `revoke` off a document the workspace never named. No live run can make this distinction, because our own page advertises the name a guesser would derive |

**The gap-9 round: 10 mutants, 10 killed — and three of them survived the first sweep,
which is the finding.** `dereferenceWorkspaceRecord` had been written, wired into
`verify-can-live.ts` §11 and run **green against production** — and the whole double suite
still passed with the owner segment deleted from its `get_current_head` call, with its
forked-chain refusal removed, and with its `/ns/<owner>/<slug>` matcher replaced by a regex
accepting any string at all. A live run exercises the honest path and nothing else; the four
refusals and the one *argument* that makes the honest path honest had no double at all. Eight
cases in `workspace-membership` now cover them, including a substrate double whose two pods
answer **differently** — a double that returned "the" head for any pod would let the producer
drop the owner segment and still pass, which is precisely the mutant that survived.

| mutant | killed by |
|---|---|
| accept evidence carrying no provenance (residual gap 9 itself) | 5 |
| do not compare the dereferenced IRI against the workspace | 2 |
| do not compare the resolved descriptor against the record's `head` | 2 |
| `requireEvidenceProvenance` with no evidence at all passes | 2 |
| ★ put the evidence refusal on the **restricting** track too (the round-3 inversion, again) | 1 |
| report `'bound'` where nobody asked — collapse "did not ask" into "asked and yes" | 3 |
| ★ remove the convener precondition from `refuseRoleProfileAuthority` | 4 |
| ★ producer drops `pod_name`, asking no pod in particular | 1 — **survivor** until the cases above existed |
| ★ producer accepts a **forked** workspace chain | 1 — **survivor** until then |
| ★ producer derives an owner segment from any IRI at all | 3 — **survivor** until then |

Two of the ten had to be re-written before they measured anything. Deleting a branch condition
(`if (false as boolean)`) left `provenance` possibly-undefined downstream, so the mutant died
at the **typecheck gate** before a single test ran — a kill, but by the wrong instrument, and
one that says nothing about whether the suite would have noticed. Re-expressed as
`return null` they keep the program well-typed and ask the question the sweep is for; both
then died on tests (5 and 2 failures). The first sweep also reported four `ANCHOR NOT UNIQUE`
misses, because every source file here is CRLF and the anchors were written with `
`.

**The gap-8 round: 9 mutants, 9 killed, and two of the kills are the ones worth reading.**
Each was applied alone, with `node_modules/.vite` cleared between mutants — a stale transform
cache produced a false SURVIVOR in an earlier round, so the clear is part of the procedure and
not hygiene.

| mutant | killed by |
|---|---|
| drop `profileRefusal` from the grant filter's `??` chain | 5 — the lattice plus four cases |
| remove the record-side emptiness guard (`ws.roleProfile === ''`) | 3 — behaviour survives on the *caller-side* guard, so the kill is on the message; recorded rather than counted as a behavioural kill |
| remove **both** emptiness guards | 4, across 2 files — the both-blank case now admits, which is the escalation the pair exists for |
| ★ make the refusal **erase** the restricting track instead of refusing conferral (the round-3 inversion) | 2 — the lattice fails in 66 ms |
| add `profileRefusal` to the **acceptance** chain | 1 — and *not* the lattice, correctly: it refuses strictly more, so it is a wrongness rather than an escalation, and only the "the acceptance was not blamed" assertion sees it |
| report `'bound'` where nothing was checked | 4 |
| ★★ delete the `'declares-another-profile'` **generator** shape | 1 — `profileRefused === 0`, *after* all 76,800 × 10 subset comparisons passed |
| `oneIri` applies no `sh:pattern` | 1 |
| the table gives `wsp:stream` a pattern the shape does not publish | 2 — the drift case **and** the does-not-refuse-more case |
| remove `wsp:accepts` from the table | the **compiler**, naming the exact missing IRI |

The second starred row is the whole reason the generator axis exists, and it is the only
mutant here whose kill message is about the *test* rather than the code: with the third shape
deleted, every subset assertion in the enumeration still held, the suite still ran 76,800
configurations, and the only thing that failed was the counter saying the rung had never once
refused. That is precisely the shape AXIS E had at 6,400 cases and AXIS G had before its own
generator — three instances now, which is why it is written up as a rule above rather than as
an anecdote here.

The third row is recorded because it is *not* a clean kill. Removing one of the two emptiness
guards leaves the behaviour correct, because the other one catches the same case; only
removing both admits two blanks. A pair of guards that each mask the other's absence is worth
knowing about, and quietly reporting "9 of 9" without it would be the assurance-that-goes-stale
this section warns about two paragraphs up.

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

> ★ The count in this paragraph used to be "all **237** tests green"; by the next round the six
> workspace files held **254**, and they hold **290** now. The figure was stale in the same way,
> and for the same reason, as the "25 of 25" line dissected two paragraphs above — a number
> written once and never recomputed. It is removed rather than corrected: the count moves every
> round and the sentence does not need it. The three figures are kept here only as the evidence
> for that, and this note is the one place in the document where a stale number is the point.

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
