# Changelog

Notable changes to @interego/core. Dates are UTC.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with RFC 2119-style
capability descriptions. Commit hashes link back to the git history; the README
describes what the system IS, this file describes what changed and when.

---

## 2026-05-16 — Aggregate-privacy v3.1: aggregator-side bounds enforcement + signed-bounds attestations

Closes the "lying contributor" cheat that v3 alone could not catch.
v3 ships with the contributor's own client-side bounds check in
`buildCommittedContribution`. A malicious contributor that skipped or
hand-rolled around that check could publish a value outside their
declared `[min, max]` and inflate the noisy sum (the Pedersen
commitment still opens correctly; the verifier sees a clean bundle
that's nevertheless leaking information about that contributor).

Two layered fixes:

1. **Aggregator-side bounds re-check** in `buildAttestedHomomorphicSum`.
   Per contribution: `if (c.value < c.bounds.min || c.value > c.bounds.max) throw`.
   The aggregator NEVER trusts the contributor's self-bounds-check;
   the sensitivity invariant the DP claim rests on is now enforced
   at sum-time. Default v3 behaviour now includes this guard.

2. **Optional `SignedBoundsAttestation`** on each contribution.
   Canonical message:
     `interego/v1/aggregate/signed-bounds|<commitment-hex>|<min>|<max>|<contributorDid>`
   signed by the contributor's wallet. New `verifySignedBounds` helper
   uses ethers' message-signature recovery + a loose DID-address
   containment check. With `requireSignedBounds: true` on the build
   call, the aggregator refuses any contribution that lacks a valid
   attestation — regulator-grade mode where the aggregator is also
   under audit and cannot be trusted to attribute commitments
   correctly.

8 new contract tests in `applications/_shared/tests/aggregate-privacy.test.ts`
(29 total in that file now: 12 v2 + 9 v3 + 8 v3.1):
- aggregator REJECTS a contribution whose value is outside the
  declared bounds (the bypassed-client-side-check threat)
- aggregator ACCEPTS contributions with values exactly at min and
  exactly at max (boundary case)
- `signedBoundsMessage` matches the documented canonical format
- `verifySignedBounds` accepts honest signatures
- `verifySignedBounds` REJECTS a signature over a different
  commitment (cross-cohort replay)
- `verifySignedBounds` REJECTS a signature whose recovered address
  does not appear in the claimed contributorDid (impersonation)
- `requireSignedBounds: true` REJECTS contributions without an
  attestation
- `requireSignedBounds: true` ACCEPTS contributions with valid
  attestations

Validation: full vitest suite **1317/1317 passing** (1309 prior + 8
new); `tsc -p tsconfig.json --noEmit` clean.

STATUS.md updated: v3.1 row added to the aggregate-privacy ladder
with the bounds-enforcement + signed-bounds story. The earlier
"per-contribution range proofs" item in remaining-work moves to a
future v3.2 entry (non-interactive ZK range proofs for
"verify-without-revealing-value" — useful when the aggregator is
itself partially trusted).

Trust ladder is now:

  v1 'abac'                              → ABAC-bounded count
  v2 'merkle-attested-opt-in'            → verifiable count + opt-in
  v3 'zk-aggregate'                      → homomorphic sum + DP noise
  v3.1 + requireSignedBounds: true       → regulator-grade attribution

Each step composes the previous; no breaking changes to the affordance
signatures (the new field on CommittedContribution is optional).

---

## 2026-05-16 — Aggregate-privacy v3: real homomorphic Pedersen sum + DP-Laplace noise (zk-aggregate mode live)

Closes the last item from the prior PM-eval-driven session arc: v3 of
the aggregate-privacy ladder. The four `aggregate_*_query` affordances
now have `privacy_mode: 'zk-aggregate'` as a LIVE option, not a stub —
the aggregator commits each contributor's value with a Pedersen
commitment over ristretto255, sums commitments homomorphically WITHOUT
seeing individual values, adds DP-Laplace noise calibrated to a public
ε budget, and returns a re-verifiable bundle.

NEW: `src/crypto/pedersen.ts` (~250 lines)

- Pedersen commitments over the ristretto255 prime-order group (RFC
  9496 via `@noble/curves/ed25519.js`). C = v·G + b·H where G is
  ristretto255.Point.BASE and H is derived via RFC 9380 hash-to-curve
  from a public domain-separation label (`H_GENERATOR_LABEL` is
  exported so any implementor can re-derive and confirm).
- `commit(value, blinding)` / `verifyOpening(c, v, b)` /
  `addCommitments([c1, c2, …])` / `verifyHomomorphicSum(cs, sumV, sumB)`.
- Both scalars reduced mod L before point multiplication so sums
  ≥ L still verify; value=0 case handled cleanly via the explicit
  ristretto255.Point.ZERO additive identity (avoids `multiply(0n)`
  undefined-behaviour in `@noble/curves`).
- `sampleLaplaceFloat(sensitivity, ε)` / `sampleLaplaceInt(...)` —
  inverse-CDF Laplace sampling with cryptographically-secure
  53-bit uniform via `crypto.getRandomValues`; rejects samples at the
  boundary so the log argument is bounded.
- 17 vitest contract tests pin hiding, binding, homomorphic addition,
  cheat-rejection (inflated total, substituted blinding, swapped
  sum-commitment), Laplace ε-calibration (smaller ε ⇒ larger noise
  measured empirically), zero-mean noise, integer-valued sampling,
  H-generator reproducibility from the public label.

EXTENDED: `applications/_shared/aggregate-privacy/` (+200 lines)

- `buildCommittedContribution({podUrl, value, bounds, blindingSeed?})`
  — contributor builds a CommittedContribution: Pedersen commitment +
  bounds the contributor consents to + the plaintext value (held by
  the contributor, revealed once to the aggregator). Self-bounds
  check rejects values outside declared `[min, max]`.
- `buildAttestedHomomorphicSum({cohortIri, aggregatorDid, contributions,
  epsilon, includeAuditFields?})` — aggregator-side: reconstruct
  `trueSum + trueBlinding` from revealed openings; sum commitments
  homomorphically; add DP-Laplace noise (sensitivity = max - min, ε
  from caller); return AttestedHomomorphicSumResult. Bounds invariant
  enforced: every contributor's bounds must match for the sensitivity
  calculation to mean anything.
- `verifyAttestedHomomorphicSum(r)` — auditor-side: structural check
  (sumCommitment == homomorphic sum of contributor commitments) +
  audit-field check (sum opens to claimed trueSum/trueBlinding) +
  consistency check (noisySum == trueSum + noise). Catches: aggregator
  substituting a different sumCommitment, lying about reconstructed
  trueSum, inflating noisySum past consistency with claimed noise.

LIVE wiring in both aggregate queries

- `owm.aggregate_decisions_query` and `lpc.aggregate_cohort_query`
  gain `privacy_mode: 'zk-aggregate'` (the enum value previously
  declared as future-scope; now a real branch). v3 supports
  count-shaped metrics (decision-count, completion-count,
  credential-coverage, competency-threshold-met); throws a clear
  error for distribution-shaped metrics (which still work under v2's
  merkle-attested-opt-in mode). Requires `epsilon` arg; throws if
  unset or non-positive.
- Top-level `privacyMode` on the result advertises the actual path
  taken; the bundle's `homomorphic: AttestedHomomorphicSumResult`
  field is present when v3 was selected.
- The published `value` in v3 mode is the noisy sum, not the
  underlying count (DP-protected by construction).

9 v3 contract tests appended to
`applications/_shared/tests/aggregate-privacy.test.ts`:
- honest bundle accepted with + without audit fields
- aggregator substituting sumCommitment from a different cohort:
  REJECTED
- bundle whose trueSum doesn't open the commitment: REJECTED
- bundle whose noisySum is inconsistent with trueSum + noise:
  REJECTED
- contributor with value outside declared bounds: REJECTED at
  buildCommittedContribution
- contributors disagreeing on bounds (sensitivity invariant):
  REJECTED at buildAttestedHomomorphicSum
- invalid epsilon / sensitivity at verify time: REJECTED

Validation: project-wide `tsc -p tsconfig.json --noEmit` clean; full
vitest suite **1309/1309 passing** (1283 prior + 17 Pedersen + 9
v3 aggregate contract tests).

STATUS.md updated: v3 row moves from "future scope" to "live since
this commit"; remaining-work table replaced with the next-iteration
items (v4 multi-aggregator threshold reveal; v3.1 per-contribution
range proofs paired with the homomorphic sum; v3.1 distribution-
shaped metrics; cumulative ε-budget tracking; second-language
Interego impl for L1 CR advancement).

The aggregate-privacy ladder is now end-to-end:
  v1 'abac'                       → ABAC-bounded count (default)
  v2 'merkle-attested-opt-in'     → verifiable count + opt-in
  v3 'zk-aggregate'               → homomorphic sum + DP noise

All three modes ship in the same affordance signatures; callers pick
their privacy boundary at call time.

---

## 2026-05-16 — Dual-audience verticals fully implemented (operator + institutional + v2 attested-merkle aggregate-privacy + demo)

Closes PM rec #4 (pick verticals + ship to real users) through to
runnable code. The dual-audience design discipline shipped earlier
(`8216374`) named two pilot verticals (learning + OWM) and DECLARED 8
institutional/operator affordances as next-implementer hand-offs.
This pass implements all 8 + ships a v2 upgrade for the aggregate
queries + adds a runnable demo + codifies the v2 contract in vitest.

Implementations (commit `69959f7`):

- `applications/organizational-working-memory/src/operator-publisher.ts` (NEW,
  ~370 lines) — `aggregate_decisions_query`, `project_health_summary`,
  `publish_org_policy`, `publish_compliance_evidence`. Composes
  `discover()` + `publish()` + `src/ops/buildXEvent` + `src/compliance/`;
  no new ontology terms.
- `applications/learner-performer-companion/src/institutional-publisher.ts`
  (NEW, ~420 lines) — `publish_authoritative_content`,
  `issue_cohort_credential_template`, `aggregate_cohort_query`,
  `project_to_lrs`. Composes `publish()` + `discover()` +
  `lrs-adapter/projectDescriptorToLrs`. Honors consent at the LRS
  projection boundary (refuses unless a consent descriptor exists on
  the learner's pod).
- Both bridges' `server.ts` concatenate `<vertical>Affordances` +
  `<vertical>{Operator,Enterprise}Affordances` into one auto-
  registered set + dispatch the new handlers. Tools/list mirrors them.

v2 aggregate-privacy upgrade (this commit):

- New shared module `applications/_shared/aggregate-privacy/` —
  ~250 lines composing existing `src/crypto/zk/` Merkle primitives.
  Exports: `publishCohortParticipation` (learner opts-in by signing
  a CohortParticipation descriptor on their own pod);
  `gatherParticipations` (operator discovers opted-in participants);
  `buildAttestedAggregateResult` + `verifyAttestedAggregateResult`
  (operator returns a tamper-evident Merkle root + per-leaf
  inclusion proofs; auditor re-verifies in O(log n) per leaf).
- Aggregate IRIs are content-addressed on (cohort_iri,
  participant_did) so the operator can derive the expected IRI
  per (cohort, participant) without scanning every descriptor.
- Both `aggregate_*_query` affordances gain a `privacy_mode`
  argument; default `'abac'` (v1 behavior); when set to
  `'merkle-attested-opt-in'` the response includes an
  AttestedAggregateResult bundle. The privacyMode enum on the
  result advertises the v1 → v2 → v3 ladder; v3 (DP-noised
  homomorphic aggregates per `spec/AGGREGATE-PRIVACY.md`) is the
  remaining future scope.
- LPC gains a new learner-side affordance `lpc.opt_into_cohort` —
  the missing bilateral primitive. The institution cannot include a
  learner in a merkle-attested aggregate unless the learner has
  explicitly opted in via this affordance. Revocation = re-publish
  the same descriptor as Counterfactual (auto-supersedes the prior
  Asserted one); `gatherParticipations` filters out non-Asserted.

Test + demo + verification:

- `applications/_shared/tests/aggregate-privacy.test.ts` (NEW, 12
  tests) — pins the v2 contract: content-addressed IRIs are
  deterministic; Merkle root is sort-stable; verifier accepts honest
  bundles and REJECTS each cheat path (count inflation, count
  deflation, inclusion-proof root substitution, leaf tampering).
  12/12 passing.
- `demos/scenarios/24-dual-audience-owm.ts` (NEW, ~240 lines) — runs
  a Contributor agent + an Operator agent against ONE OWM bridge
  against ONE pod. Contributor authors a project, 3 decisions (one
  superseded by a 4th), a follow-up, and 2 notes. Operator runs the
  v2 attested aggregate, project_health_summary, publish_org_policy
  (retention), and publish_compliance_evidence (soc2:CC8.1-cited
  deploy). In-process auditor then verifies the attestation bundle
  AND confirms the cheat-protection works by mutating the count and
  re-verifying. End-to-end proof that the dual-audience surface,
  the v2 attested-merkle path, and the v1 institutional affordances
  all compose against real Claude Code agents.
- `demos/agent-lib.ts` `BridgeSpawnOptions` gains an optional `env`
  field so callers can wire operator-authority DIDs (and other
  conventional env vars) that the per-vertical defaults don't cover.

Validation: project-wide `tsc -p tsconfig.json --noEmit` clean; full
vitest suite 1283/1283 passing (1271 prior + 12 new aggregate-
privacy contract tests).

Where the PM-eval recommendations stand after this pass:

| # | Rec | Status |
|---|---|---|
| 1 | Front-door: one user, one wedge | live (`2b3a857`) |
| 2 | Zero-config `/try` | live + smoke-tested (`bbe960d` / `d123ee6` / `6e6be2c`) |
| 3 | L1 Last Call Working Draft + 12-mo backcompat | shipped (`0fe8ec7`) |
| 4 | Dual-audience verticals + 8 operator affordances + v2 attested-merkle + opt-in primitive + runnable demo | this commit |

The remaining honest future scope: v3 DP-noised homomorphic aggregates
(real crypto work, separate scope) + second-language Interego
implementation to advance L1 from Last Call → Candidate Recommendation
(multi-month, community ask).

---

## 2026-05-16 — L1 protocol → Last Call Working Draft; backcompat committed through 2027-05-16

Promoted the L1 protocol status in [`spec/architecture.md`](spec/architecture.md)
from *Working Draft* to **Last Call Working Draft**, and added
[`spec/STABILITY.md`](spec/STABILITY.md) as the adopter-facing summary
of what's now committed vs. what stays open.

Why now — the audit cadence of the past several weeks is the natural
maturity signal. Recent work has been correctness fixes layered on
existing primitives (the project-wide audit, escape consolidation,
intersection-meet correction, stateless tokens, the `/try`
provisioning endpoint), not new ontology terms or new protocol
capabilities. Layer 1 has reached coherence; the editors are now
hardening, not extending.

What's committed for the 12 months ending 2027-05-16:

- **Wire format frozen.** Turtle / TriG / JSON-LD serializations of
  any conforming descriptor written today will parse identically by
  any v1.x implementation.
- **Vocabulary frozen in `cg:` / `cgh:` / `pgsl:` / `ie:` /
  `align:`.** No removals, renames, or semantic narrowing.
  Additive changes (new optional terms, new optional facets) are
  permitted within v1.x.
- **Composition operator laws frozen.** `union` / `intersection` /
  `restriction` / `override` (and the lattice properties they
  satisfy) are normative.
- **Modal-truth invariants frozen.** The
  Asserted/Quoted/Hypothetical/Counterfactual/Retracted correspondence
  to `cg:groundTruth` is the L1 contract.
- **Conformance-level partition frozen.** L1 / L2 / L3 / L4 categories
  are fixed; tests may be added within a level.

Explicitly NOT in the L1 commitment (separate cadences, documented in
`STABILITY.md`): reference-implementation npm versions, L2 patterns
(`abac:` / `registry:` / `passport:` / `hyprcat:` / `hypragent:`), L3
ontologies (`hela:` / `sat:` / `cts:` / `olke:` / `amta:` / `code:` /
`eu-ai-act:` / `nist-rmf:` / `soc2:`), verticals, deployment topology,
and the regulator-owned control sets the compliance mappings track.

Forward path to **Candidate Recommendation** is documented and
gated: (a) two independent interoperable implementations passing the
L1 conformance fixtures, (b) a 30-day review window. Neither has
occurred yet; second implementations in any language are warmly
welcomed via the issue tracker. The conformance runner at
[`spec/conformance/runner.mjs`](spec/conformance/runner.mjs) is
intentionally dependency-free so any second implementation can validate
without a SHACL engine.

---

## 2026-05-14 — Production hardening, Hermes integration, HATEOAS surface, hosted onboarding, name service

A multi-part pass: harden the substrate, land the Hermes Agent
integration, give both memory plugins a bloat-free HATEOAS tool surface,
make the hosted deployment a retail-grade front door (with origin-aware
WebAuthn so `/connect` passkey enrollment works), and ship the Interego
name service — attestation-based, federated, no central registrar.

### Production hardening — real bugs + coverage on untested public API

Cross-referenced all 743 `src/index.ts` exports against the test suite;
the gaps surfaced real, shipped bugs:

- **`detectValueDrift` always returned `[]`** (`5490fa4`) — the heuristic
  loop computed vocabulary overlap but its `if` block was empty. Wired
  it, restricted the scan to conduct-bearing event kinds, + 4 tests.
- **`countUniquePGSL` was dead on arrival** (`bdba0d9`) — it loaded its
  deps with `require()` inside an ESM module, throwing "Cannot find
  module" on every call; also swallowed embed failures with `catch {}`.
  Converted to ESM imports, made the failure path non-silent, added the
  missing barrel export, + 2 tests.
- **Zero-coverage modules locked down** — `src/pgsl/computation.ts` (13
  functions, `b8ca403`), BIP-340 Schnorr (`f87081c`, also exported the
  unreachable `sha256Hex`), `src/model/delegation.ts` — the
  authorization gate (`f724410`), `src/solid/sharing.ts` — cross-pod
  recipient resolution incl. the Sec #12 rollover window (`47c7f1e`).
- **Validator-as-agent: bring-your-own SHACL engine** (`814180e`) —
  `deploy/validator/` hands descriptors to an operator-provided SHACL
  engine over a W3C-standard HTTP contract; dropped `n3` +
  `rdf-validate-shacl` (the container keeps only `express` + `ws`).
  Graceful no-op when unconfigured.
- **Multiplayer playtest** (`08075bb`) — 8 end-to-end journey scenarios
  (solo / device-migration / pairwise + group E2EE / revocation /
  key-rollover / adversarial / efficiency / cross-device parity), each
  judged against a production-quality property. The substrate held.

Full suite: 1238 passing.

### Hermes Agent memory provider (Path 5)

`integrations/hermes-memory/` (`b558f4b`) — a `MemoryProvider` plugin for
Nous Research's Hermes Agent (the most-used agent runtime, ~140k stars).
stdlib-only Python; maps Hermes' memory hooks (`sync_turn`, `prefetch`,
`on_memory_write`) onto the relay's `publish_context` / `discover_context`
REST surface. Same `cgh:AgentMemory` graph shape as the OpenClaw
provider — Hermes bots and OpenClaw agents on one pod read each other's
memories. New `docs/integrations/path-5-hermes-memory-provider.md`;
integration map grew from four paths to five.

### HATEOAS tool surface — reach the whole substrate without tool bloat

Both memory plugins now reach *all* of Interego from a fixed, tiny tool
surface instead of carrying a flat list of ~15–60 substrate tools:

- **Hermes** (`e98ebce`) — `get_tool_schemas()` exposes three schemas:
  `interego_recall` / `interego_discover` / `interego_act`.
- **OpenClaw** (`423acb2`) — five: the three memory-slot tools +
  `interego_discover` / `interego_act`. Also fixed two pre-existing
  bridge bugs (an unsupported `{ shareWith }` option `publish()`
  silently ignored; `entry.confidence` read off a type that lacks it)
  and corrected `forgetMemory` to publish `Counterfactual`, not
  `Hypothetical`, matching its own contract.

Every `recall` / `discover` result is decorated with `affordances` —
self-describing `{action, target, …}` records, gated by delegation
scope. The agent acts by passing one to `*_act`. Capability travels as
data: new substrate capability is a new affordance verb in a result,
never a new tool schema. New docs:
`docs/integrations/{hermes,openclaw}-full-substrate.md`.

### Retail-grade hosted onboarding

`deploy/identity/server.ts` (`bee7429`) — the hosted landing page is now
a two-track "try it" experience (person → passkey/wallet enroll; agent →
copy the relay URL into an MCP client). `/connect` does in-browser
passkey enrollment (Touch ID / Windows Hello / security key) **and**
Ethereum-wallet enrollment — no password, no email, no account
database; DID + pod minted from the credential. The relay landing page
cross-links the identity front door so neither hosted surface dead-ends.

### Origin-aware WebAuthn RP — fixes the `/connect` passkey rpID mismatch

`deploy/identity/server.ts` (`dc9a9d4`) — the new `/connect` page ran the
passkey ceremony on the identity server's own domain, but the server
returned a single static `WEBAUTHN_RP_ID` (pinned to the relay's domain,
which the relay's OAuth flow needs) — so the ceremony failed with an
rpID mismatch. The ceremony is now origin-aware: `resolveRp(req)` derives
the relying party from the browser-sent `Origin` against a
`WEBAUTHN_RP_ORIGINS` allowlist; the resolved `{rpId, origin}` is stashed
on the challenge so `/register` + `/authenticate` verify against the
origin the ceremony actually used. Falls back to the static RP for
unrecognized origins — single-origin deployments unaffected.
`deploy-azure.yml` also gained the missing "Wire identity env vars" step
(the workflow wired the dashboard's env but never the identity server's).

### Interego name service — attestation-based naming

`docs/NAME-SERVICE.md` (`17169fe`) + `src/naming/` (`a07a81c`) — a name
is a **verifiable attestation**, not a claimed registration:
`<did> foaf:nick "alice"` inside an ordinary Context Descriptor with
Trust + Provenance facets and `cg:supersedes` chains. Resolution is
federated discovery + a pluggable trust policy — conflicts resolve by
the resolver's policy, never first-come-first-served. No central
registrar, no root, no namespace governance; the honest cost is no
global-uniqueness guarantee (the correct trade for a federated,
verifiable substrate — ENS-style global uniqueness is available as an
opt-in resolution tier, not the root). Shipped:
`buildNameAttestation` / `attestName` / `resolveName` (forward,
trust-ranked) / `namesFor` (reverse) / `defaultNameTrustPolicy`
(pluggable), all with an injectable `fetch`; a runnable offline demo
(`examples/demo-name-service.mjs`); and two follow-on pieces —

- **`resolveIdentifier` TN tier** (`5fac93d`) — `resolveName` is now a
  tier of the unified identifier resolver. `resolveIdentifier(id,
  { naming })` populates `kind: 'name'` + `nameCandidates` (the full
  ranked set — a name is trust-relative) and mirrors the top
  candidate's `subject` into `webId` for single-answer callers.
  `naming/index.ts` imports from source modules (not the barrel) to
  keep the new `discovery → naming` edge cycle-free.
- **`@alice` host-free form** (`f2475aa`) — a leading `@` is a
  syntactic marker, like `did:` / `acct:`: `detectKind` recognizes
  `@alice` as `kind: 'name'`, so `resolveIdentifier` auto-runs the TN
  tier for it (a *bare* `alice` stays `unknown` and needs the opt-in
  `naming` flag). `resolveName` strips a leading `@`.

21 tests. **No new L1/L2 ontology terms** — `foaf:nick` is W3C FOAF;
L2 pattern, sibling of `registry:` / `passport:`.

## 2026-05-15 — Project-wide audit pass: 13 fixes across crypto / federation / substrate / MCP

A four-reviewer parallel audit covered crypto + identity, federation + RDF
I/O, substrate core (composition, validation, PGSL, compliance), and the
MCP + integrations + verticals surfaces. Of 17 raw findings, 3 turned out
to be reviewer false alarms (the corresponding code was already correct
or the rule had been misread), 1 was a clarifying-doc-only item, and 13
landed as code changes. Two patterns ran throughout: **make the safe
thing the default**, and **compose existing primitives instead of letting
helpers fork**.

### Correctness regressions caught + fixed

- **Turtle literal escape consolidated** (`82bb5bd`) — six places had
  their own escape helper (`escapeTurtle` / `escapeLit` /
  `escapeForTurtle` / `escapeLiteral` / two `escapeMulti`s + an inline
  `.replace`), each covering a different subset of `\\` / `"` / `\n` /
  `\r` / `\t`. The directory.ts pair shipped in [`bf171e6`](#)
  covered only `\\` and `"` while its inverse decoded all five — a
  nick with a control char produced malformed Turtle. New
  [`src/rdf/escape.ts`](src/rdf/escape.ts) is the single source of
  truth; all six call sites route through it. Adversarial round-trip
  test pins the regression in `tests/naming.test.ts`.
- **`intersection()` is the meet again** (`d443596`) — when
  `commonGraphs` was empty, the operator fell back to
  `allDescribedGraphs([d1, d2])` (the union), violating
  `d1 ∧ d2 ≤ d1`. Now returns the empty set, which is the correct
  meet. Regression test added with disjoint described-sets.

### Identity + auth hardening

- **Bootstrap-invite verify is constant-time** (`6f2cf96`) —
  `crypto.timingSafeEqual` on equal-length buffers, length-mismatch
  short-circuits. Closes a timing channel that could enumerate the
  single-use seeded-userId gate.
- **WebAuthn counter persistence respects clone-detection** (`6f2cf96`)
  — counter is captured, advanced in memory, persisted; on persist
  failure the in-memory value is rolled back AND the request returns
  503 so the client retries. The previous catch-and-warn path silently
  defeated WebAuthn §6.1.1 cloned-authenticator detection.
- **WebAuthn rpID allowlist fallback warns once per misconfig**
  (`6f2cf96`) — a browser Origin not on `WEBAUTHN_RP_ORIGINS` no
  longer silently uses the static `RP_ID`; the operator gets one
  warning per distinct Origin so the misconfig is visible before users
  hit the "rpID is not a registrable suffix" error.
- **DID-userId derivation is global by design — documented in code**
  (`6f2cf96`) — the auditor flagged "same DID, two pods, two userIds"
  as a federation bug, but the rule is actually the opposite: userId
  IS deterministic from the credential / wallet / DID; per-pod checks
  prevent enrolling the same credential twice on the same pod, not
  enrolling on a second pod. A pod-scoped userId would re-centralize
  the namespace. Source comment now states this explicitly.

### Compliance discipline

- **Framework-report status is bi-modal** (`94830c0`) — dropped the
  arbitrary "exactly one evidence → partial" rule from the default
  aggregation policy. One signed audit record fully satisfies a
  control; callers who genuinely need an N-evidence threshold derive
  status from `evidenceCount` themselves. The `'partial'` literal
  survives in the type for custom `AggregationPolicy` implementations.
- **Compliance overlay removes the `'allow'` screening bypass**
  (`19861f8`) — compliance evidence is the highest-stakes surface and
  cannot opt out of `screenForSensitiveContent`. Pre-screening
  pipelines should sanitize args before calling
  `buildAgentActionDescriptor`. Test pins the throw-on-HIGH behavior.
- **Wallet-rotation temporal verification** (no change needed) — the
  reviewer asked for it; [`listValidSignerAddressesAt`](src/compliance/index.ts)
  already provides exactly that bounded predicate. The unbounded
  variant survives for internal-audit walks.

### Crypto layered defense + SIWE pin

- **Optional `expectedSenderPublicKey` on decrypt** (`2a21cdf`) —
  `decryptFacetValue` and `resolveAtomValue` gain an optional
  expected-sender param. NaCl box.open authenticates an envelope but
  takes the sender pubkey from the envelope itself; passing the
  expected sender narrows the trusted-sender set from "anyone who knew
  the recipient's pubkey" to "exactly this sender." Layered defense —
  the primary integrity guarantee remains pod-write ACL +
  content-addressing.
- **SIWE format-stability regression test** (`2a21cdf`) —
  `formatSiweMessage` is now pinned byte-for-byte against a fixed
  input including Resources. A stylistic refactor that drifts the
  bytes would silently invalidate every prior signature; the test
  guards against that.

### Principled-call: modal status default

- **`publish-preprocess` defaults to `Hypothetical`** (`a1c9837`) — the
  MCP server's own published guidance to agents is explicit
  (*"don't drift to 'Asserted for safety'... USE Hypothetical DEFAULT
  for inferences"*), but `normalizePublishInputs` defaulted to
  `Asserted`. Substrate vs. guidance drifted. Flipped:
  `modalStatus ?? 'Hypothetical'`, paired confidence default
  `0.85 → 0.7` (high enough not to be ignored, low enough that the
  affordance engine's `Hypothetical with confidence ≥ 0.8` gate still
  blocks auto-apply on inferred claims). Compliance and
  human-verified callers set `Asserted` explicitly via their builders
  and are unaffected. Affordance-engine *consumption* of a descriptor
  missing the semiotic facet keeps the L1 default (`Asserted`); the
  rule is about authoring, not interpreting stored content.
- **`share_with` schema text emphasizes owner-only default**
  (`a1c9837`) — the implementation has always been owner-only when
  the field is omitted; the schema description now says so explicitly
  so an LLM reading the tool doesn't infer sharing is opt-out.

### False alarms (verified, no fix needed)

- Modal-status default `'Asserted'` in `src/affordance/compute.ts:293`
  was flagged as drift but is the L1 spec default for *consuming* a
  descriptor with no explicit modalStatus — the "Hypothetical default"
  rule is about *authoring*, not interpretation.
- Subscription slot leak on `subscribe_to_pod` failure: `setSubscription`
  is already called *after* the awaited `subscribe()` resolves, so a
  thrown subscribe never consumes a slot.
- Wallet-rotation history "append-only forever": addressed by
  `listValidSignerAddressesAt` already shipped.

Suite: **1271 passed / 29 skipped / 0 failed**; type-check clean;
ontology-lint clean.

## 2026-05-15 — Name service: pod-directory `name → did` index

Closes the last deferred item from the 2026-05-14 name-service entry —
a federation hint that lets a resolver narrow which pods it walks for a
given name.

- **`PodDirectoryEntry.ownerNicks` — schema decision recorded.** The
  question was "new directory predicate, or reuse a W3C term?" The
  resolution is to reuse `foaf:nick` (the same predicate the
  underlying attestation graph uses) and serialize it as plain top-level
  `<owner> foaf:nick "name"` triples in the directory document. The
  directory hint is then literally a projection of the attestations —
  re-derivable, never authoritative. No new ontology term in any
  `cg:` / `cgh:` / pattern namespace.
- **`directoryNameIndex(directories)` materializes a
  `lowercase-name → NameHint[]` map** across one or more pod
  directories. `NameHint` carries the directory ID for provenance.
- **`resolveName(name, config, { directories })` narrows the pod walk**
  to those advertising the queried name; `namesFor(subject, …)` narrows
  reverse-lookup the analogous way. Stale-hint safety: when no hint
  matches, the resolver falls through to the full `pods` list. The
  caller's own `config.podUrl` stays in the walk as a safety net so a
  local-only attestation is never missed.
- 28 naming tests (7 new) — round-trip, `directoryNameIndex` building,
  forward narrowing, stale-hint fallback, local-pod safety net, reverse
  narrowing. Federation tests (24) still pass; type-check + ontology-lint
  clean.
- Honest record: `docs/ns/naming.ttl` is **not** being added — the
  binding is plain `foaf:nick`, the directory hint reuses the same
  predicate, and nothing in the runtime references a `naming:` term.
  The absence is the design (the design note now records this; the
  prior deferred-list bullet for it has been removed).

### Deploy reliability — diagnosable + reproducible + rate-limit-resilient ACR builds

The Azure deploy workflow was intermittently failing the
`interego-identity` / `interego-pgsl-browser` image builds with a
generic `RunStatus.FAILED` and no detail.

- **`--no-logs` removed** (`44df8cc`) — the workflow ran `az acr build
  --no-logs`, which suppressed the actual build output. With it gone,
  the real error was immediately visible: `Step 1/N : FROM node:20-slim
  → toomanyrequests` — Docker Hub's anonymous pull rate limit on the
  egress IP that ACR build agents share. Never a code problem (a local
  repro of the exact Dockerfile build — fresh `npm ci` + `tsc` — passes
  clean).
- **Retry loop** (`303c277`) — `az acr build` is wrapped in a 3-attempt
  retry with 120 s backoff. Each invocation gets a fresh build agent
  (often a different egress IP), so a retry clears the intermittent
  limit. Kept as defense-in-depth.
- **`az acr import` dead end** (`cd043f0`, `32e94d8` — superseded) — the
  first durable-fix attempt added a `prime-base-images` job that
  `az acr import`ed `node:20-slim` into our own ACR so the build matrix
  could `FROM` it there. It does not work: **ACR's import pulls from
  Docker Hub anonymously too**, so it hit the identical `429
  TOOMANYREQUESTS` (proven in run `25879991403`'s logs). `cd043f0` also
  made it a SPOF — the matrix strictly `needs:` the prime job, so the
  failed import skipped the whole deploy; `32e94d8` reduced that to
  best-effort (fall back to a direct Docker Hub pull). Both are
  superseded by the ECR Public fix below.
- **Durable fix — base image from AWS ECR Public** (`161e576`) — the
  real fix is to stop pulling from Docker Hub at all. AWS ECR Public
  Gallery mirrors the Docker official images at
  `public.ecr.aws/docker/library/node:20-slim` — a different registry
  with far more generous anonymous limits (path + tag verified to
  resolve before committing). The `prime-base-images` job is removed
  entirely; `az acr build` passes
  `--build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim`.
  All six Dockerfiles keep `ARG NODE_BASE=node:20-slim` as the default,
  so a local `docker build` still uses Docker Hub — only CI is
  redirected. No Docker Hub credential / GitHub secret required.
- **Reproducible installs** (`44df8cc`, `303c277`) — `Dockerfile.identity`
  and `Dockerfile.validator` copied only `package.json` and ran
  `npm install`, re-resolving caret ranges on every build. Both now copy
  `package-lock.json` and run `npm ci`.

### Fixes

- **Relay hostname** (`a0ec397`) — the Hermes plugin + the identity
  server's `RELAY_URL` default were written against a non-existent
  `interego-mcp-relay` host (an invented `mcp-` segment); the real
  Azure Container App is `interego-relay`. Corrected — left as-is the
  Hermes provider would have failed out of the box.
- **CI: Actions off the deprecated Node 20 runtime** (`c93f003`,
  `ccee717`) — the deploy logs flagged `actions/checkout@v4` (+
  same-class `setup-node@v4`, `upload-artifact@v4`) running on Node 20,
  which GitHub force-migrates 2026-06-02 and removes 2026-09-16. Bumped
  across all four workflows to the current majors (`checkout@v6`,
  `setup-node@v6`, `upload-artifact@v7`); a follow-up pass caught
  `azure/login@v2` in the same deprecation class and bumped it to `@v3`.
  Verified via the releases API; zero breaking-change surface (the
  inputs in use are stable).

## 2026-05-13 — Production hardening, batches 1–4

A four-batch pass tightening the substrate for consumer-grade
deployment — error handling, resource bounds, race fixes, and the
identity/relay attack surface.

- **Escape correctness + privacy preflight** (`4cdf0ea`) — fixed Turtle
  literal escaping across the pod-publishers, added API-key / PII
  sensitivity detectors, resource caps, timeouts, and concurrency-race
  fixes.
- **Identity + relay hardening** (`edc1f25`) — per-IP rate limiting on
  every auth endpoint; browser-friendly landing pages so a non-technical
  visitor sees an actionable page, not `Cannot GET /`.
- **Batch 2** (`b00f171`) — Merkle BIP-98 leaf/internal domain tags,
  discovery diagnostics, a connector-failure surface (`getLastFailures`).
- **Batch 3** (`92af768`) — actionable error messages, atomic agent-key
  write (tmp + rename), Turtle-injection defense, relay-replay
  diagnostics.
- **Batch 4** (`d4d50c2`) — CAS exponential backoff, PGSL ingest cap,
  WebSocket reconnect, `discover_all` partial-failure summaries.
- `cg:supersedes` round-trips through `ManifestEntry` (`ba4712f`).

## 2026-05-02 — Complexity-science foundations, demo set 16–23, agent-runtime integration scaffolding

Three arcs landed over early May.

### Categorical foundations + complexity-aware extensions
- `docs/ARCHITECTURAL-FOUNDATIONS.md` (`d7f0d04`) — the formal account
  of the substrate (holonic hypergraphics, PGSL as Grothendieck
  fibration, HELA as topos, the four invariants, Peircean correspondence).
- §9 complexity-aware extensions, then §10 — the substrate
  self-bootstraps an emergent protocol-and-app (`d768e81`, `a6a5257`,
  `5514c82`). Three engineering-honesty gaps closed alongside:
  tree-kill, real range-proof verification, substrate-enforced
  constitutional constraints (`9f5e367`).

### Benchmark honesty
- Stripped cross-run study-notes from the LongMemEval prompts; reported
  an honest cold-start baseline (`48ac9f5`, `7c89e33`). The system's
  value is infrastructure, not test-set fitting.

### Demos 16–23 + agent-runtime integration paths 1–4
- Demos 16–23 (`e6408e4`, `0f8fc72`, `fcdf30f`, `85f0b3e`, …) — including
  Demo 22 (autonomous game design/build/play) and Demo 23 (federated
  zero-copy semantic layer).
- **Agent-runtime integration paths 1–4** (`f3fb1c1`) — the skills
  bridge (SKILL.md ↔ `cg:Affordance`), the OpenClaw memory plugin, the
  compliance overlay, and the integration map. The Hermes provider
  (Path 5) and the HATEOAS surface for both plugins followed on
  2026-05-14.
- Review follow-ups (`a1bf4b1`) — a real subject-extraction TriG parser
  replacing regex, range-proof hardening, hardened readiness probes.

## 2026-04-28 (later) — Layering correction: verticals out of generic deployments; affordance-first

Earlier commits today bundled vertical-application MCP tools (`lpc.*` /
`adp.*` / `lrs.*` / `ac.*`) into both `examples/personal-bridge/` AND
`deploy/mcp-relay/`. That conflated the foundation layer (generic
Interego protocol) with application-over-L3 emergent reifications.

Reverted the bundling and restructured around the protocol's first
principles:

### Phase 1 — strip the violations
  - examples/personal-bridge: back to 6 core p2p tools only
  - deploy/mcp-relay: back to 15 protocol tools only (Azure deployment
    redeploys via CI back to that baseline)
  - tests/personal-bridge.test.ts: assertions back to 6-tool baseline

### Phase 2 — affordance-first capability declarations
  - applications/_shared/affordance-mcp/index.ts — typed Affordance
    shape + affordanceToMcpToolSchema(a) + affordanceToTurtle(a, base) +
    affordancesManifestTurtle(...)
  - applications/<vertical>/affordances.ts — single source of truth
    for each vertical's capabilities (LPC: 6, ADP: 8, LRS: 4, AC: 5)
  - Action IRIs follow urn:cg:action:<vertical>:<verb> convention
  - Both protocol-level (cg:Affordance) and ergonomic (MCP tool schema)
    surfaces derive from the same affordance declarations

### Phase 3 — per-vertical bridges as separate optional deployments
  - applications/_shared/vertical-bridge/index.ts — createVerticalBridge()
    framework: HTTP endpoints per affordance hydra:target +
    /mcp with derived tool schemas + /affordances Turtle manifest
  - applications/<vertical>/bridge/ — small standalone Express + MCP
    servers (~100 lines each) on their own ports (6010 LPC / 6020 ADP /
    6030 LRS / 6040 AC). Naming: @interego/<vertical>-bridge-EXAMPLE
    — the suffix signals NOT first-party
  - Each bridge has its own package.json (depends on @interego/core),
    its own tsconfig.json, its own dist/

### First-principles position now encoded
  - Generic Interego deployments (mcp-server, personal-bridge,
    deploy/mcp-relay) expose ONLY protocol-level tools
  - Verticals are emergent applications, not protocol extensions
  - Verticals are ALWAYS reachable via the protocol-level cg:Affordance
    discovery path — no per-vertical client code required at the
    consuming agent
  - Per-vertical bridges are an optional convenience reification,
    deployed independently per vertical (Path B); the protocol path
    (Path A) always works regardless

Generic Interego CI / tests / conformance suite are unaffected by any
vertical's state. A vertical can fail to build without breaking the
project; vertical bridges deploy independently per the verticals doc
([applications/README.md](applications/README.md)).

---

## 2026-04-28 (earlier) — Four production-grade vertical applications + CAS-safe `publish()`

Closes the gap between protocol substrate and end-user-facing applications.
Each of the four verticals under [`applications/`](applications/) now ships
a production runtime (pod-publisher + pod-loader + MCP tools registered in
the personal-bridge) + a Tier 8 integration test against real
infrastructure (Azure CSS + Lrsql + SCORM Cloud + public Nostr relay).

### Verticals

- **`learner-performer-companion/`** ([`applications/learner-performer-companion/`](applications/learner-performer-companion/))
  Human-protagonist wallet: SCORM/cmi5 ingestion, W3C VC import (vc-jwt + DataIntegrityProof eddsa-jcs-2022), xAPI history via lrs-adapter, performance records with manager attribution. Grounded chat with verbatim citation, honest no-data on unanswerable questions, content-hash tamper detection. New `src/grounded-answer.ts` + `src/pod-wallet.ts` + `src/pod-publisher.ts`.

- **`agent-development-practice/`** ([`applications/agent-development-practice/`](applications/agent-development-practice/))
  Agent-as-subject Cynefin/Snowden complexity-informed practice. Probes/fragments/syntheses always Hypothetical; syntheses REQUIRE ≥2 coherent narratives (silent collapse prevention); evolution steps require `explicitDecisionNotMade`; capability evolution events as `passport:LifeEvent` carry humility forward across deployments. New `src/pod-publisher.ts` + `src/pod-loader.ts`.

- **`lrs-adapter/`** ([`applications/lrs-adapter/`](applications/lrs-adapter/))
  Bidirectional xAPI ↔ Interego boundary translator. Auto-negotiates xAPI version (2.0.0 preferred; falls back to 1.0.3 for legacy LRSes — real-world finding: SCORM Cloud is 1.0.3-only). Counterfactual descriptors ALWAYS skipped on projection; Hypothetical skipped without explicit opt-in; multi-narrative descriptors lossy with audit-loud `lossNote` rows. New `src/lrs-client.ts` + `src/pod-publisher.ts`.

- **`agent-collective/`** ([`applications/agent-collective/`](applications/agent-collective/))
  Multi-agent federation: tool authoring with attestation discipline (publisher REFUSES tool promotion below 5 self + 2 peer + 2 axes); teaching packages bundle artifact + practice (REFUSES without narrative fragments); cross-agent audit entries live in HUMAN OWNER's pod (not the agent's). New `src/pod-publisher.ts`.

### Personal-bridge: 23 MCP tools

The personal-bridge ([`examples/personal-bridge/`](examples/personal-bridge/)) now exposes 23 MCP tools any client can call (Claude Desktop / Code / Cursor / ChatGPT app / custom): 6 core p2p (existing) + 6 `lpc.*` + 8 `adp.*` + 4 `lrs.*` + 5 `ac.*`. Per-vertical env vars (`LPC_POD_URL`, `ADP_OPERATOR_DID`, `LRS_ENDPOINT`, `AC_AGENT_DID`, ...) configure the targets; per-call argument overrides supported.

### CAS-safe `publish()`

[`src/solid/client.ts`](src/solid/client.ts) — manifest update now uses HTTP If-Match (RFC 7232 optimistic concurrency) with retry on 412 Precondition Failed (jittered backoff, 5 attempts). Cold-start uses `If-None-Match: *`. Fixes the read-then-write race where parallel publishes against the same pod could clobber each other's manifest entries — bit production agents writing in parallel AND the cross-suite parallel test run.

### Test surface

Single full-suite run (`SCORM_CLOUD_KEY=... SCORM_CLOUD_SECRET=... SCORM_CLOUD_ENDPOINT=... npx vitest run`):
- **1068 tests pass / 3 skipped (env-gated) / 0 failures**
- 60 test files including 4 new Tier 8 production tests (one per vertical)
- Real systems exercised in a single suite run: Yet Analytics Lrsql (xAPI 2.0.0), SCORM Cloud (xAPI 1.0.3), Azure Community Solid Server, relay.damus.io public Nostr relay, real ECDSA + Ed25519 + X25519 cryptography, real W3C VC vc-jwt + Data Integrity Proofs, real SCORM 1.2/2004/cmi5 zip parsing, real cross-bridge p2p

vitest config now uses singleThread/singleFork pools to serialize pod-touching tests for deterministic CI gates.

### Honesty discipline encoded at the publisher layer

Across all four verticals, publishers REFUSE bad input rather than warn. Examples:
- ADP: probes refused without amplification + dampening triggers; syntheses refused with <2 coherent narratives; evolution steps refused without `explicitDecisionNotMade`; constraints refused without `emergedFrom` + `boundary` + `exits`
- LRS: Counterfactual descriptors ALWAYS skipped on projection; Hypothetical skipped without opt-in
- AC: tool promotion refused below threshold; teaching package refused without narrative fragments
- LPC: bad VCs never land in the pod under credential IRIs (verification before persist)

The behavior contract — verbatim citation, honest no-match, tamper detection, cross-link integrity, provenance honesty — is what the Tier 7+8 tests validate.

---

## 2026-04-26 — Tier 5 P2P transport (Schnorr + 1:N encrypted share)

Ships the local-first storage tier ladder + a working P2P option. Three commits land in sequence:

### Tier ladder ([`spec/STORAGE-TIERS.md`](spec/STORAGE-TIERS.md))

- 5-tier deployment progression: Tier 0 (library only) → Tier 1 (default — MCP auto-spawns CSS) → Tier 2 (LAN) → Tier 3 (self-hosted public) → Tier 4 (federated cross-pod) → Tier 5 (P2P relay-mediated).
- Each tier is a strict superset of the one below; protocol surface unchanged across the stack.
- Smoke tests for tiers 0/1/4 in [`tests/storage-tiers.test.ts`](tests/storage-tiers.test.ts) using an `InMemoryPod` class that backs a real fetch handler. 6 tests pass.

### Tier 5 base — Nostr-style relay transport ([`src/p2p/`](src/p2p/))

- `P2pClient` + `InMemoryRelay` + `P2pRelay` interface. Same client API works against in-memory (tests), WebSocket → public Nostr relay (production), or libp2p (future Tier 6).
- Three custom kinds in NIP-33 parameterized-replaceable range: `KIND_DESCRIPTOR` (30040), `KIND_DIRECTORY` (30041), `KIND_ATTESTATION` (30042).
- Mobile + desktop interop with no central server: cross-surface deployment topology in [`docs/p2p.md`](docs/p2p.md).

### Schnorr (BIP-340) signatures — public-Nostr interop

- New [`src/crypto/schnorr.ts`](src/crypto/schnorr.ts) wraps `@noble/curves` BIP-340 schnorr sign/verify + `getNostrPubkey(privateKey)` deriving the 32-byte x-only pubkey.
- `P2pClient` gains `signingScheme: 'ecdsa' | 'schnorr'` option. Same wallet, two pubkey representations (Ethereum address / x-only hex). `verifyEvent` auto-dispatches by pubkey format — both schemes coexist on the wire.
- New runtime dep: `@noble/curves ^2.2.0` (replaces `@noble/secp256k1` which dropped Schnorr in v2.3).
- Means: an Interego deployment can publish to public Nostr relays with Schnorr-signed events that interop with non-Interego Nostr clients. One wallet, two faces, full Nostr-ecosystem participation.

### 1:N encrypted share — closes Tier 4 / Tier 5 gap

- New `KIND_ENCRYPTED_SHARE = 30043`. Reuses Tier 4's existing 1:N NaCl envelope (`createEncryptedEnvelope` / `openEncryptedEnvelope`), wrapped in a relay-routable event.
- `publishEncryptedShare` / `queryEncryptedShares` / `subscribeEncryptedShares` / `decryptEncryptedShare` on `P2pClient`.
- Recipients tagged via `p` (signing pubkey for filtering); X25519 encryption pubkeys live inside the envelope, invisible to the relay. Same security model as Tier 4 cross-pod share, transport-agnostic.

### Side fixes

- `FRAMEWORK_CONTROLS.soc2` catalog gained CC6.2, CC6.7, CC7.3, CC7.4, CC7.5, CC9.2 — all controls the `src/ops/` event builders emit but the framework report wouldn't recognize. Caught by THE ADVERSARIAL AUDIT test ([`tests/adversarial-audit.test.ts`](tests/adversarial-audit.test.ts)).
- Added `signMessageRaw(wallet, message)` + `recoverMessageSigner(message, sig)` exports from `crypto/wallet.ts` for use by P2P (also useful for x402, ad-hoc challenges).

### Stats

- Tests: 859 → **903 passing** (+6 storage-tier, +7 adversarial-audit, +16 P2P, +5 wallet, +10 connectors, less 8 deltas / cleanups)
- New runtime dep: `@noble/curves ^2.2.0`
- New modules: [`src/p2p/`](src/p2p/), [`src/crypto/schnorr.ts`](src/crypto/schnorr.ts)
- New docs: [`spec/STORAGE-TIERS.md`](spec/STORAGE-TIERS.md), [`docs/p2p.md`](docs/p2p.md)
- All 3 lints clean throughout.

### THE ADVERSARIAL AUDIT — six-act demonstration

[`tests/adversarial-audit.test.ts`](tests/adversarial-audit.test.ts) ships a single 548-line vitest test that's also a six-act narrative demonstration. Each act is backed by hard cryptographic assertions. Demonstrates capabilities that, taken together, no other system in the world has all of: (1) operator with valid creds CANNOT rewrite history; (2) ONE signed action satisfies MULTIPLE regulatory regimes; (3) independent witnesses on DIFFERENT pods can verify; (4) audit substrate self-protects (attacks become evidence); (5) time-locked attribution survives key rotation; (6) O(log n) third-party Merkle verification with no central authority.

---

## 2026-04-26 — broad codebase pass (post-review fixes)

Acted on the broader code-review survey across the whole project — not just SOC 2/security. Tightened security at the relay, fixed two real ESM bugs in the compliance module, added subscription cap to the stdio MCP server, formalized deploy/access/key documentation, promoted the architecture spec status, and adopted Proposal B as the v1.1 path for descriptor self-revocation.

### Fixed — silent ESM bugs in `src/compliance/`

- `generatePrivateKey()` and `addressFromPrivateKey()` used CJS `require('ethers')` inside an ESM module. Worked at compile time, threw `ReferenceError: require is not defined` at runtime for any caller of `loadOrCreateComplianceWallet`. Replaced with `import { Wallet } from 'ethers'`. The bug shipped silently because no test exercised the wallet code path; a regression test now exists in `tests/compliance.test.ts`.
- `loadOrCreateComplianceWallet().fresh` was hardcoded `false` (the `!existsSync(path) ? false : false` ternary always evaluated to `false`). Operators relying on the `fresh` flag to back up newly-minted wallets received no signal. Now correctly returns `true` on first mint, `false` on subsequent loads.

### Added — `tools/publish-ops-event.mjs` integrations

- Relay's `/agents/:agentIri/revoke` endpoint now emits a `soc2:AccessChangeEvent` audit descriptor in the response (using `buildAccessChangeEvent`). Operators can pipe directly into `publish_context` with `compliance:true` for SOC 2 CC6.2/CC6.3 evidence. Failure here MUST NOT fail the revoke; surfaced as `auditWarning`.
- `examples/compliance-end-to-end.mjs` walks the full pipeline: build event → check compliance grade → generate framework report → load/rotate wallet. Self-contained, no live pod. Catches three real bugs (above + a stale ContextDescriptor reference).

### Added — `mcp-server` subscription cap + `unsubscribe_from_pod` tool

- Per-process cap of 32 active WebSocket subscriptions, configurable via `CG_MAX_SUBSCRIPTIONS`. Prior behavior allowed unbounded accumulation as the agent explored federation.
- New `unsubscribe_from_pod` tool releases a slot. PodRegistry gains `unsubscribe(url)` + `activeSubscriptionCount` getter.

### Hardened — relay startup

- `relay-agent-key.json` parse failures are now fatal at startup. Prior behavior silently regenerated a fresh key, orphaning every envelope encrypted to the prior public key. Operators see a clear error and a hint to restore from backup.
- Startup logs sha256 fingerprints (12-char hex) of: `RELAY_MCP_API_KEY`, `relayAgentKey.publicKey`, `ORG_CDP_API_KEY_PRIVATE`, `ORG_IPFS_API_KEY`. Operator can confirm key identity at boot without ever logging the secret itself.
- `/oauth/verify` now rate-limited (30 req/min/IP, RFC 6585 standard headers). Was previously the only auth-relevant endpoint outside `mcpAuthRouter`'s rate limiter.
- CORS open-origin design rationale documented inline (claude.ai connector + OpenAI plugin compatibility) with explicit "do not tighten" guidance.

### Resolved — `mcp-server` wallet TODO

- `check_balance` falls back to the persisted ECDSA compliance wallet address when no `address` arg is provided, instead of the meaningless `MY_DID` (a `did:web:` identifier, not a fundable address).

### Added — coverage gating + new shared helper module

- `vitest.config.ts` thresholds (50% baseline, 80–100% on protocol-critical modules: `compliance`, `security-txt`, `ops`, `privacy`). `npm run test:coverage` enforces; `npm test` is unaffected.
- `src/security-txt/` — RFC 9116 body builder, single source of truth across the 3 servers that depend on `@interego/core`. Identity + validator inlines kept (no-core-dep design) but verified byte-identical via `tests/security-txt.test.ts`.
- `tools/security-txt-expiry-check.mjs` — fails CI when `Expires` is within 30 days, per the annual-refresh policy commitment.

### Examples — now parameterizable

- `examples/_lib.mjs` reads `CG_DEMO_POD`, `CG_DEMO_POD_B`, `CG_DEMO_POD_BASE` env vars; defaults preserved. External users can run any demo against their own pod without editing source.

### Connectors — surface clarified

- `src/connectors/index.ts` docstring now reflects what's actually implemented (Notion, Slack, Web) vs. the four declared-but-unimplemented types. New `tests/connectors.test.ts` exercises the dispatch + each implemented type with mocked `fetch`.

### Spec status promotions

- `spec/architecture.md` — promoted from "Draft" to "Working Draft" with explicit stability commitments per section. Promotion to Candidate Recommendation now has documented criteria (two interoperable implementations + 30-day review window).
- `spec/revocation.md` — Proposal B (predicate form) adopted as the recommended path; Proposal A retained as an L2 extension for cross-org governance. Both interop per §8 (existing); migration plan documented.
- `spec/OPS-RUNBOOK.md` — TBDs filled (custom-domain mapping plan, gitleaks chosen for pre-commit secret scanning).

### Hygiene

- `tsconfig.json` `exactOptionalPropertyTypes: false` decision documented inline with the rationale.
- `benchmarks/README.md` — schema doc for `eval-history.json`, file inventory, methodology notes.
- 304MB of `benchmarks/*.log` files now gitignored (already done in prior pass).

### Stats

- Tests: 859 → 874 (+5 wallet regression tests + 10 connector tests, less the 3 redundant)
- Coverage: now measured + gated; 60.07% overall (well above the 50% baseline; per-module gates at 80–100% on protocol-critical modules)
- Real bugs caught + fixed: 3 (CJS-in-ESM × 2; `fresh` flag stuck on `false`)

---

## 2026-04-25 — SOC 2 readiness package (eats own dog food)

Builds on the same-day compliance-grade publish work. Provides the human + operational scaffolding to take Interego itself through a SOC 2 examination, and demonstrates that the protocol's compliance-evidence substrate is what the operator uses to record the operator's own behavior.

### Added — written policy set ([`spec/policies/`](spec/policies/))

15 policies, each with Purpose / Scope / Roles / Statements / Procedures / Exceptions / Review / Mapping to CC IDs:

- 01 Information Security · 02 Access Control · 03 Change Management · 04 Incident Response · 05 Business Continuity · 06 Vendor Management · 07 Data Classification · 08 Encryption · 09 Secure SDLC · 10 Logging & Monitoring · 11 Acceptable Use · 12 Data Retention · 13 Risk Management · 14 Vulnerability Management · 15 Privacy

### Added — strategic + operational docs

- [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) — scope, current-vs-target gap, mapping of Interego features to SOC 2 controls, vendor inventory, solo-operator compensating controls, candidate Type 1 → Type 2 timeline + cost estimate.
- [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md) — production topology, deploy procedure, access management, wallet rotation, backup, monitoring, incident response, quarterly + annual reviews. Calls out current state vs target for each section.
- [`SECURITY.md`](SECURITY.md) + [`SECURITY-ACKNOWLEDGMENTS.md`](SECURITY-ACKNOWLEDGMENTS.md) — coordinated disclosure contact, severity SLA, scope.

### Added — RFC 9116 `/.well-known/security.txt`

Served by every Interego-operated container app: relay, identity, validator, dashboard, pgsl-browser. Single contact + policy URL across the surface area.

### Added — operational event builders ([`src/ops/`](src/ops/index.ts))

Eat own dog food: every operational action becomes a compliance descriptor on the operator's pod.

- `buildDeployEvent` → `soc2:DeployEvent`, cites `soc2:CC8.1`
- `buildAccessChangeEvent` → `soc2:AccessChangeEvent`, cites `soc2:CC6.1`+`soc2:CC6.3`
- `buildWalletRotationEvent` → `soc2:KeyRotationEvent`, cites `soc2:CC6.7`
- `buildIncidentEvent` → `soc2:IncidentEvent`, cites `soc2:CC7.3`(open) / `soc2:CC7.3`+`CC7.4`+`CC7.5`(resolved)
- `buildQuarterlyReviewEvent` → `soc2:QuarterlyReviewEvent`, controls per kind (access / change / risk / vendor / monitoring)

CLI: `tools/publish-ops-event.mjs` — emits the JSON payload ready for `publish_context(..., compliance: true)`. Wired into `deploy/azure-deploy.sh` end-of-run hint.

### Added — five new operational event classes + 22 properties on `soc2:`

`docs/ns/soc2.ttl` extended with `DeployEvent`, `AccessChangeEvent`, `KeyRotationEvent`, `IncidentEvent`, `QuarterlyReviewEvent` (all subclasses of `soc2:ControlEvidence`) plus 22 datatype properties (component, commitSha, accessAction, principal, system, scope, justification, rotationReason, retiredKeyAddress, newKeyAddress, incidentSeverity, incidentStatus, summary, detectionSource, detectedAt, affectedComponent, reviewQuarter, reviewKind, findingCount, finding, environment, rollbackPlan). Plus three previously-implicit controls: `CC7.4`, `CC7.5`, `CC9.2`.

### Fixed — `tools/derivation-lint.mjs` regex

Same-file transitive grounding was failing for any prefix containing a digit (e.g., `soc2:`). Regex updated from `[a-zA-Z]+:` to `[a-zA-Z][a-zA-Z0-9-]*:` (matches valid TTL prefix names). All 91 L2/L3 classes now grounded (was 86/91).

### Stats

- Tests: 817 → 835 (+18 ops builder tests)
- Derivation-lint: 86/91 → 91/91 grounded (closed the bug + added 5 new classes that resolve transitively)
- SOC 2 controls covered: 10 → 13 (+CC7.4, CC7.5, CC9.2)
- Policies: 0 → 15 written

---

## 2026-04-25 — compliance grade publish (regulatory audit-trail substrate)

Closes the "Federated Compliance Graph for AI Agent Governance" gap.
Customers in regulated industries (EU AI Act, NIST AI RMF, SOC 2) can
now use Interego as the audit-trail substrate, with cryptographic
provenance, framework conformance reports, and a verification API that
doesn't trust the relay.

### Added — L3 regulatory mapping ontologies

- `docs/ns/eu-ai-act.ttl` — Articles 6, 9, 10, 12, 13, 14, 15, 50
- `docs/ns/nist-rmf.ttl` — Govern / Map / Measure / Manage
- `docs/ns/soc2.ttl` — Trust Services Criteria (CC, A, PI, C, P)
- 20 new classes total, all derivation-lint grounded.

### Added — `compliance: true` flag on `publish_context` (both surfaces)

When set:
- Trust upgraded to `cg:CryptographicallyVerified`
- Descriptor signed with persisted ECDSA wallet (secp256k1)
- Inline `cg:proof` reference embedded in TrustFacet (proofScheme,
  proofUrl, proofSigner) — included in the SIGNED Turtle so tampering
  invalidates
- Sibling `.sig.json` written to the pod
- Both Turtle + signature auto-pinned to IPFS when provider configured
- Compliance check report appended to response (modal/trust/sig
  validation against L4 conformance)

### Added — Wallet rotation + history

- `loadOrCreateComplianceWallet(path, label)` — loads or creates
- `rotateComplianceWallet(path)` — moves active to history, generates new
- `importComplianceWallet(path, privateKey)` — replace active with
  externally-managed key (HSM, custodial); previous → history
- `listValidSignerAddresses(path)` — all addresses considered valid
  for verification (active + history)
- Backward-compat: pre-rotation single-key wallet files auto-migrate
  on next load.

### Added — Audit endpoints on the relay (public read)

- `GET /audit/frameworks` — list frameworks + their controls
- `GET /audit/events?pod=...&since=...&until=...` — recent descriptors
- `GET /audit/lineage?descriptor=...` — walk derivedFrom + supersedes
- `GET /audit/compliance/<framework>?pod=...` — per-control evidence aggregation
- `GET /audit/verify-signature?descriptor=...` — fetch descriptor +
  sibling .sig.json, recover signer, verify content hash. Auditors
  validate without trusting the relay.

### Added — `examples/compliance-dashboard.html`

Single-page UI. Pod URL + framework selector → summary panel +
recent events + per-control status table with score bar. Reads
the relay's `/audit/*` endpoints. No build step.

### Added — L4 Compliance conformance tier (spec/CONFORMANCE.md)

7 normative requirements (L4.1–L4.7) — trust upgrade, modal commitment,
ECDSA signature, anchored CID, append-only via supersedes, framework
control citations, privacy preflight HIGH-pass.

### Added — Privacy hygiene preflight

`screenForSensitiveContent` runs in `publish_context` on both surfaces;
flags API keys (Anthropic, OpenAI, AWS, GitHub, Stripe, generic), JWTs,
PEM private keys, Luhn-valid credit cards, US SSNs, emails, phone
numbers, IPv4 addresses across three severity tiers. Warning surfaced
to the calling agent; never silently filtered.

### Added — Agent enablement docs

- `docs/AGENT-PLAYBOOK.md` — operational "when X do Y" rules for any
  LLM driving the MCP. Fetched via `docs://interego/playbook`.
- `docs/AGENT-INTEGRATION-GUIDE.md` — one-page integrator guide for
  AI agent harnesses. Fetched via `docs://interego/integration-guide`.
- SERVER_INSTRUCTIONS in BOTH stdio + relay strengthened from
  descriptive to prescriptive: proactive triggers, privacy hygiene
  rules, modal defaults, versioning, error patterns.
- New prompt `whats-on-my-pod` added to both surfaces.

### Tooling fixes

- `computeCid` now produces real CIDv1 (raw codec, sha2-256, base32
  multihash). Was concatenating `bafkrei` + raw hex — looked like a
  CID but never resolved on any IPFS gateway.
- `publish_context` auto-supersedes prior descriptors for the same
  `graph_iri` on the same pod (`auto_supersede_prior` defaults true).
  Republishing-to-add-recipients now cleanly marks older versions as
  superseded; federation queries surface only the canonical current.

### Stats

- Tests: 727 → 817 (+90 across registry, passport, abac, transactions,
  constitutional, ipfs-cid, privacy, compliance)
- Derivation-lint: 41/41 → 86/86 grounded
- Ontologies: 12 → 19
- New runtime modules: `src/abac/`, `src/registry/`, `src/passport/`,
  `src/transactions/`, `src/constitutional/`, `src/privacy/`,
  `src/compliance/`

---

## 2026-04-23 (latest) — MCP discoverability across both surfaces

Both MCP entry points now advertise system-level instructions, doc
resources, and workflow prompts so a brand-new agent learns *what*
this server is, not just *which* tools it exposes.

### `@interego/mcp` (stdio server) — 0.4.1 → 0.5.0

For Claude Code CLI, Codex CLI, and IDE-embedded agents.

- **Instructions block** returned in MCP `initialize`. Concise
  narrative: what Interego is, when to use each tool family, key
  invariants, pointers to doc:// resources for deeper context.
- **7 doc:// resources** (read on demand): `overview`, `architecture`,
  `layers`, `derivation`, `emergence`, `abac-pattern`, `code-domain`.
  Files resolved via candidate-path walk so dev (mcp-server/) and
  dist (mcp-server/dist/) layouts both work.
- **5 prompts** with `prompts: {}` capability: `publish-memory`,
  `discover-shared-context`, `verify-trust-chain`,
  `compose-contexts`, `explain-interego`.

### `@interego/mcp-relay` (HTTP/SSE) — 0.2.0 → 0.3.0

For claude.ai connectors and any other remote MCP client.

- Same instructions block as the stdio server (mirror, not proxy —
  the relay maintains its own MCP Server instance).
- Same 7 doc:// resources. `Dockerfile.relay` now bakes README +
  spec/*.md + docs/EMERGENCE.md + docs/ns/{abac,code}.ttl into
  `/app/relay-docs/` at build time so the container serves them
  with no network dependency.
- 4 prompts (omits `compose-contexts` — relay tool surface differs
  slightly from the stdio server's; will add when relay implements
  the corresponding tool).

### Why

Before: a new agent connecting saw 25 tool descriptions in
isolation and had to infer that publish + share + discover + compose
form one coherent system. Now: it reads a single instructions block
on initialize, fetches docs on demand, and offers users 4-5 concrete
workflows out of the box.

The TurboTax MCP and similar production servers established this
pattern; this commit brings parity.

No tests added (handlers are plumbing — verified by build + manual
JSON-RPC probe). Main project still 727/727. CI auto-deploys the
relay container on push to master; mcp-server publishes on tag.

---

## 2026-04-23 (later still) — attribute-based access control

ABAC built out as a first-class protocol mechanism: policies are typed
context descriptors, predicates are SHACL shapes, attributes are
resolved across the federation, and decisions are themselves linked
data. The structural primitives live at L1 (`cg:`); the evaluation
pattern is L2 (`abac:`); the reference runtime is L3 (`src/abac/`).

### Added (L1 — Protocol)

- **`cg:AccessControlPolicy`** — a policy IS a `cg:ContextDescriptor`.
  Every implementation now has the same policy shape.
- **`cg:DeonticMode`** + individuals `cg:Permit` / `cg:Deny` / `cg:Duty`
  — ODRL-aligned modal labels without the full ODRL dependency.
- **`cg:policyRef`** on `cg:AccessControlFacet` — links a facet to one
  or more policies. WAC-shaped authorizations coexist, so deployments
  migrate ACL → ABAC incrementally.
- **`cg:policyPredicate`** (→ `sh:NodeShape`), **`cg:governedAction`**,
  **`cg:deonticMode`**, **`cg:policyDuty`** properties.
- **`AccessControlFacetData.policyRefs`** TS field; new
  `AccessControlPolicyData` + `DeonticMode` types.

### Added (L2 — Architecture pattern: `abac:`)

- **`docs/ns/abac.ttl`** (new) — 5 classes:
  - `abac:Evaluator` — stateless (policy, context) → decision.
  - `abac:PolicyContext` — resolved subject attributes + resource + env.
  - `abac:AttributeResolver` — federates the subject's attribute graph.
  - `abac:DecisionCache` — cached decisions as verifiable attestations
    (issuer + validity window), so stale cache is verifiably stale.
  - `abac:EvaluationRecord rdfs:subClassOf cg:ContextDescriptor` — the
    audit trail is itself linked data.
- 5 properties + 3 verdict individuals (`abac:Allowed`,
  `abac:Denied`, `abac:Indeterminate` — the Indeterminate case matters
  under open-world federation).

### Added (L3 — Reference runtime `src/abac/`)

- `src/abac/evaluator.ts` — `evaluate(policies, predicates, context)` +
  `evaluateSingle(...)` + `validateAgainstShape(...)`. Deny overrides
  Permit. Duties accumulate. No matching policy → Indeterminate.
- `src/abac/attribute-resolver.ts` — `resolveAttributes(subject,
  descriptors)` aggregates facets from every descriptor that describes
  or attributes to the subject. `extractAttribute(graph, path)` reads
  SHACL-style paths including AMTA-axis attestations.
- `src/abac/cache.ts` — `createDecisionCache()` + `defaultValidUntil`.
- `src/abac/types.ts` — `AttributeGraph`, `PolicyContext`,
  `PolicyDecision`, `PolicyPredicateShape`, `PredicateConstraint`,
  `AbacVerdict`, `DecisionCacheEntry`.
- `src/abac/index.ts` — public entry point; re-exported from the
  top-level package as `evaluateAbac`, `resolveAttributes`,
  `extractAttribute`, `createDecisionCache`, etc.

### Tests

- `tests/abac.test.ts` — 18 new tests across five scenarios:
  single-policy Permit/Deny/Duty; Deny-overrides-Permit composition;
  action mismatch short-circuit; attribute resolver aggregation;
  extractAttribute for standard + AMTA paths; cache hit/miss/stale.

### Demo

- `examples/demo-abac-cross-pod.mjs` — reviewer merge-gate scenario:
  two peer pods issue AMTA attestations about alice on `amta:codeQuality`
  axis; policy requires ≥ 2 attestations ≥ 0.8 + present validity window;
  evaluator aggregates the attribute graph cross-pod and returns
  Allowed. Counterfactual (one attestation missing) flips to
  Indeterminate; adding a Deny-self-asserted policy flips to Denied
  (deny-overrides-permit); cache entries expire into verifiable-stale.

### Lint changes

- `tools/derivation-lint.mjs` adds `abac.ttl` to L2_L3_FILES.
  Passes: 5/5 classes grounded.
- `tools/ontology-lint.mjs` registers `abac` prefix. Passes.
- `cg.ttl` grew from 318 → 328 terms (L1 ABAC additions).
- `abac.ttl` adds 5 classes + 9 terms.

### Deferred

- PGSL deontic-engine bridge (`src/pgsl/agent-framework.ts`) —
  its `PolicyRule` format is tightly coupled to PGSL atom access,
  and `src/abac/` is the general-purpose integration point. A
  converter `policyToDeonticRule(policy)` is a follow-up, not a
  blocker.

### Why

`cg:AccessControlFacet` was WAC-shaped only (identity-based). The
federation model already provides attribute-rich facets (Trust,
Semiotic, Provenance, AMTA-axis attestations) but we had no
evaluator that consumed them as policy inputs. This lands one.

725/725 tests pass (707 + 18 new). Derivation-lint 56/56 grounded.
Ontology-lint clean.

---

## 2026-04-23 (later) — first L3 domain ontology (`code:`)

The project now ships with a working, lint-gated, runtime-demonstrated
domain-specific knowledge graph — a practical test that the protocol
is sufficient for non-trivial domains without new L1 primitives.

### Added (L3 — Domain)

- **`docs/ns/code.ttl`** — 10 classes + 18 properties for source-code
  artifacts: Repository, Commit, Branch, PullRequest, Review, Defect,
  TestRun, BuildResult, ReviewVerdict, Severity. Every class grounds
  in L1 (cg:/pgsl:) or a W3C vocabulary. Commits are `pgsl:Fragment`;
  branches are `cg:ParadigmSet`; reviews `cg:constructedFrom
  (cg:SemioticFacet cg:ProvenanceFacet)`; defects
  `cg:constructedFrom (cg:SemioticFacet)`.
- **`examples/demo-code-domain.mjs`** — runtime demo of creation +
  utilization. Builds a repo + PR + reviews as `code:` instances,
  composes two opposing reviews via `ModalAlgebra.meet` to derive
  effective PR state, propagates a defect's modal downgrade onto the
  implicated commit via `ModalAlgebra.not + meet`, exhibits branches
  as paradigm alternatives, and composes review × trust × build as
  three independent semiotic facets into a single merge verdict —
  all with zero adapter code.

### Tooling changes

- `tools/derivation-lint.mjs` — adds `code.ttl` to `L2_L3_FILES`.
  Passes: 10/10 classes grounded.
- `tools/ontology-lint.mjs` — registers `code` prefix in
  `OWNED_NAMESPACES`. Passes: 32 terms defined.
- `tools/ontology-lint.allowlist.txt` (new) — single-entry allowlist
  for `code:local`, a false positive from the regex tokenizer
  matching the literal `claude-code:local` URN default in
  `mcp-server/server.ts`. Mechanism now exists for future known-drift
  tracking.
- `CLAUDE.md` — adds `code` to the ontology-hygiene prefix list.

### Why

CLAUDE.md has long listed `code:`, `med:`, `learning:` as example
future domain namespaces to prove the protocol is domain-neutral.
This commit makes that claim concrete for `code:` and verifiable:

- Grounded by derivation-lint (machine-checkable).
- Used by a runnable demo (observable).
- Composed with L1 primitives (`ModalAlgebra`, paradigm set) with
  no new protocol machinery.

If the protocol needs a patch to support a new domain, the
compositional claim is false. It didn't, so the claim holds for at
least one non-trivial case.

707/707 tests pass. Derivation-lint 51/51 grounded. Ontology-lint
clean (1 allowlisted entry).

---

## 2026-04-23 — emergence demo set

Four self-contained simulations showing emergent properties of the
protocol, each isolating one first-principle and exhibiting the
phenomenon it enables. All run under a second, zero network
dependencies, reproducible on any machine.

### Added (L3 — Demos + documentation)

- **`examples/demo-vocabulary-emergence.mjs`** — two agents with
  incompatible vocabularies converge on aligned semantic classes
  through co-occurrence alone. Paradigm operations + `ModalAlgebra`
  modal promotion produce the pullback of the two vocabularies
  without a translator, alignment file, or central coordinator.
- **`examples/demo-emergent-mediator.mjs`** — two pods assert
  disagreeing facts about the same subject; a third "mediator" pod
  is derived at query time as the pullback of the two source
  presheaves. Modal states track the correctness of the mediator's
  inference as sources drift (Asserted → Hypothetical on
  out-of-range updates).
- **`examples/demo-localized-closed-world.mjs`** — same query
  returns different, both-correct authoritative answers inside a
  SHACL closed-shape boundary vs across the open federation.
  Three-way distinction visible: in-scope-present /
  in-scope-absent / out-of-scope.
- **`examples/demo-stigmergic-colony.mjs`** — agents with no map,
  no coordination, and no messaging converge on the globally
  optimal path through a concept graph via shared-pod trace
  dynamics. Reliably finds optimum (91–96% path concentration
  across runs) when the landscape gradient is sufficient to escape
  early lock-in.
- **`docs/EMERGENCE.md`** — documents all four demos, principles
  exercised, falsifiable success criteria, captured outputs, and
  honest limits. Organized so each demo's claim can be verified
  by running the script.

### Why

The existing demos (teach-teach, accumulation-emergence, emergent-dao,
sybil-detection, zk-reputation) exercise the HTTP/Solid surface. These
four isolate the protocol's compositional and categorical dynamics so
emergent properties are visible in a ≤60-line trace. They answer
*what does federation without central authority actually buy*.

No test changes; no ontology changes; 707/707 pass; derivation-lint
41/41 grounded; ontology-lint clean.

---

## 2026-04-22 (later) — derivation discipline

Higher layers now built from lower layers, operationally. Every
L2/L3 ontology class has explicit L1 grounding; every
construction named in the ontology has a runtime constructor.

### Added (L1 — Protocol)

- **`spec/DERIVATION.md`** — normative construction rules for
  L1 → L2 → L3. A class is grounded if it has
  `owl:equivalentClass` / `rdfs:subClassOf` / `cg:constructedFrom`
  or is explicitly marked primitive. Dependencies are
  machine-checkable via `tools/derivation-lint.mjs`.
- **`cg:constructedFrom`** predicate added to `docs/ns/cg.ttl`.
  Declares that a class is constructed at runtime from named L1
  primitives.

### Added (L2/L3 — Ontology grounding)

All seven L2/L3 ontology files now fully grounded (41/41 classes):

- **SAT** (8/8) — Situation, SemioticField, Interpretant, Sign
  all `rdfs:subClassOf cg:*`; Semiosis + EmergentMeaning
  `cg:constructedFrom`.
- **HELA** (6/6) — Trace, LearningObject subclass cg:ContextDescriptor;
  Omega `cg:constructedFrom (pgsl:Fragment cg:SemioticFacet)`.
- **CTS** (7/7) — Tuple subclass pgsl:Fragment; Position/Filler
  subclass pgsl:Atom; Pattern `owl:equivalentClass cg:SyntagmaticPattern`.
- **OLKE** (2/2) — KnowledgeStage subclass cg:SemioticFacet;
  Transition subclass cg:ProvenanceFacet.
- **AMTA** (6/6) — every rating subclass cg:TrustFacet or
  cg:SemioticFacet; Reputation `cg:constructedFrom (amta:Attestation)`.
- **HyprCat** (6/6) — World now subclass cg:FederationFacet;
  others transitively via same-file subclassing.
- **HyprAgent** (6/6) — already grounded.

### Added (L3 — Implementation, `src/model/derivation.ts`)

Runtime constructors for every `cg:constructedFrom`-tagged term:

- **`constructOmega(name, candidates, validityFn)`** — subobject
  classifier for a presheaf topos. Returns three-valued
  `OmegaVerdict` (true / false / indeterminate) consistent with
  the modal algebra.
- **`makeGeometricMorphism(podA, podB)`** — cross-pod citation
  relation (honestly labelled as weaker than a true adjunction
  in the doc comment; the substrate is bipartite-symmetric, not
  directional, which holds monotonicity + emptiness laws but
  not full f* ⊣ f_*).
- **`ModalAlgebra`** — three-valued Heyting algebra on
  {Asserted, Hypothetical, Counterfactual} with meet, join,
  intuitionistic negation, Heyting implication. Modal
  reasoning is now compositional with the bounded-lattice
  composition operators.
- **`FacetTransformation<F>`** — natural-transformation typing
  for merge operations; `composeFacetTransformations` forms a
  monoid.

### Added (Tests + Tooling)

- **`tests/derivation.test.ts`** — 17 tests covering Ω
  classification, geometric-morphism monotonicity, modal-algebra
  laws (idempotence + commutativity + absorption + intuitionistic
  double-negation + Heyting implication reductions), and
  FacetTransformation composition.
- **`tools/derivation-lint.mjs`** — checks every L2/L3 class is
  grounded. Currently passes 41/41; fails CI with a non-zero
  exit if any class becomes ungrounded.

### Closed honest limits from earlier

- ✓ Natural-transformation typing of merge strategies
  (FacetTransformation<F> with monoid laws in code).
- ✓ Ω as a runtime object (constructOmega).
- ✓ Geometric morphisms exist — with an honest caveat that our
  citation-relation model doesn't satisfy full adjunction;
  monotonicity + emptiness laws do hold.
- ✓ Modal Kripke-like semantics via Heyting algebra.

### Remaining (future)

- True directional geometric morphism over a pod inclusion
  (requires refactoring pod representation).
- Full subobject-classifier transport across pods (builds on
  the above).
- Spec-as-descriptor bootstrap (tabled).

Test totals: 694/694 passing. Ontology-lint clean.
Derivation-lint: 41/41 classes grounded.

---

## 2026-04-22 — protocol streamlining pass

Full-stack audit addressing real gaps surfaced by the "is it
streamlined / dogfooded / composite enough?" self-critique.
Changes layer across protocol → ontology → implementation →
tests → demos.

### Added (L1 — Protocol, `spec/architecture.md`)

- **§6.5a Multi-affordance descriptors and runtime resolution
  (normative).** A descriptor MAY carry multiple `cg:affordance`
  blocks with distinct `cg:action` values. Defines canonical
  action vocabulary (canDecrypt / canFetchPayload / canAudit /
  canPay / canVerify / canCompose), cross-pod affordance rules,
  and the runtime-resolution pattern that turns HATEOAS controls
  into callable tools without harness pre-registration.
- **§6.5b Shape discovery (normative).** Convention for hosting
  shapes at `<pod>/schemas/<shape-id>.ttl` + optional index at
  `<pod>/schemas/index.ttl`. Normative rules for consumers
  distinguishing nominal vs structural conformance when the
  schema URL is unreachable.
- **§6.5c `wasDerivedFrom` consistency (normative).** When a
  descriptor carries `prov:wasDerivedFrom` both inside
  `ProvenanceFacet` and at the top level, the two sets MUST be
  consistent. Divergence is malformed and SHOULD emit a
  diagnostic.

### Added (L1 — Ontology, `docs/ns/cg.ttl`)

- **Four canonical affordance actions:** `cg:canAudit`,
  `cg:canPay`, `cg:canVerify`, `cg:canCompose`. Each declared as
  `cg:Affordance` with rdfs:label + rdfs:comment per lint
  conventions.

### Added (L3 — Implementation, `src/solid/shapes.ts`)

- **Shape-discovery helpers.** `resolveShape(url)` returns a
  `ResolvedShape { body, status, resolved }` so callers
  distinguish network-failure from HTTP-error from success.
  `listPodShapes(podUrl)` reads the index if present.
  `shapeIndexTurtle(entries)` emits the canonical index format.
  Exported from `src/solid/index.ts`.
- **`getDefaultFetch` promoted** from module-private to exported
  so sibling solid/ modules share the same default fetch.

### Added (Tests, `tests/lattice-laws.test.ts`)

- **Seven lattice-law tests** pinning the composition operators'
  algebraic properties: idempotence (type-set level),
  commutativity, associativity, absorption. Tests recognize the
  intentional design decision that Interego union preserves
  multi-facet siblings (modal polyphony) — classical idempotence
  holds at the facet-TYPE-SET level rather than multiset, and
  the test comments document why.

### Added (Demos, `examples/_lib.mjs`)

- **Shared helpers module** eliminating ~150 lines of copy-paste
  across 22+ demo scripts: fetch/put/pool, manifest parse,
  descriptor parse, mini-SHACL shape parse + validate,
  `buildDescriptorTurtle` dogfooding `ContextDescriptor.create()`
  + `toTurtle()`, `publishDescriptorTurtle` as the canonical
  publish path.
- **`demo-accumulation-emergence-v2.mjs`** — demonstrates the
  new pattern. Same semantics as v1 in ~65 lines (v1 was ~125).
  All descriptor authoring via the library builder.

### Rationale (dogfooding path)

Protocol-first: spec gets normative sections for affordance
runtime resolution and shape discovery (neither was
normatively documented before). Ontology absorbs the canonical
action vocabulary. Implementation adds the shape-discovery
helpers the spec now requires. Tests pin the lattice algebra
normatively. Demos migrate to the canonical authoring path.
Each layer's changes enable the next; nothing is left hanging.

### Skipped this pass (legitimate architectural debates)

- **Modal-status promotion to descriptor top level** — the
  Peircean Semiotic facet is the right home; promoting it would
  flatten the interpretant-lens abstraction. Keeping it inside
  `SemioticFacet`.
- **issuer / attester / wasAttributedTo unification** — these
  have legitimately distinct semantics (trust vs provenance vs
  attestation). Kept separate; applicability notes remain a
  future docs task.
- **Spec-as-descriptor bootstrap** — genuinely cool but requires
  meta-shape infrastructure. Tabled until there's a second
  implementation to co-validate against.

---

## 2026-04-21 / 2026-04-22 session

Trust substrate + monetization primitives landed. 25 commits
`242f054` → `499b5be`.

### Added

- **Layered trust demos under `examples/`** — semantic-alignment auditor (v1 → v4,
  recursive meta-audit, adversarial-robust trust fixpoint with phantom-evidence /
  conflict-of-interest / shape-violation detection), cross-auditor consensus
  tool, per-issuer reputation aggregator, federation health check (21 assertions
  covering connectivity, schema resolvability, citation integrity, signature
  validity, cross-pod integrity, affordance execution, adversarial regression,
  audit-chain coherence). Each audit publishes as a descriptor conforming to
  `audit-result-v1`. See [`examples/SEMANTIC-ALIGNMENT-README.md`](examples/SEMANTIC-ALIGNMENT-README.md).
- **ERC-8004 progressive support (T0 → T2).** T0 federation-native attestations
  (`erc8004-attestation-v1.ttl`); T1 ECDSA-signed (secp256k1 via ethers.js,
  tamper-detection verified); T2 IPFS-pinned + signed EIP-1559 transaction
  against the draft Reputation Registry ABI (dry-run — broadcast deferred to
  a funded environment). Descriptor structure is additive across tiers.
  Commits `7ae39c7`, `2bad4bb`, `13f840b`.
- **x402 payment protocol demo.** HTTP-402 challenge → EIP-191 signed
  authorization → retry with `X-Payment` → 200 with tx hash. Real signatures,
  nonce enforcement, replay detection verified live. Settlement stubbed.
  Commit `13f840b`.
- **HATEOAS affordance → callable tool bridge.** Walks the manifest, enumerates
  `cg:affordance` blocks by `cg:action`, resolves each into a runtime-callable
  tool, invokes and publishes the invocation as a first-class descriptor with
  `prov:wasDerivedFrom` back to the source affordance. Commit `9e44b98`.
- **Descriptor-level `conformsTo`.** `ContextDescriptorData.conformsTo?: IRI[]`;
  builder `.conformsTo()`; serializer emits top-level `dct:conformsTo`; manifest
  writer surfaces it for cleartext federation filtering. Commit `0b29028`.
- **Generalized cleartext mirror.** Four cross-descriptor predicates
  (`cg:revokedIf`, `prov:wasDerivedFrom`, `cg:supersedes`, `dct:conformsTo`)
  extracted at publish and threaded onto the cleartext descriptor layer.
  Commit `0b29028`.
- **`effective_at` discover semantics** (spec `§5.2.3`, normative). Interval-
  contains filter distinct from endpoint `valid_from` / `valid_until`. Commits
  `242f054`, `0b29028`.
- **Cross-pod demos.** End-to-end verified: POD-B claims cite POD-A evidence
  by URL; an auditor reading POD-B walks citations into POD-A, fetches
  evidence, and publishes result descriptors citing both pods. No central
  index, no coordination. Commits `af1205a`, `7139346`.

### Changed

- **Turtle-aware extractor** for `normalizePublishInputs`. Two-pass tokenizer
  strips string literals and comments before the IRI-list extractor runs,
  then uses a bracket-counting parser on the raw body for revocation
  conditions. Object-list shorthand (`pred <a>, <b>, <c>`) now extracts
  all three IRIs, not just the first. Commits `280160b`, `8b1a3df`.
- **`xsd:double` serialization** for `cg:epistemicConfidence`. `confidence=1`
  produces `"1.0"^^xsd:double`, not `"1"^^xsd:integer`. Commit `242f054`.
- **Three-valued modal truth.** `Hypothetical` claims no longer auto-write
  `cg:groundTruth false`; the field is omitted (three-valued). `Asserted` →
  true, `Counterfactual` → false. Commits `63e080b`, `cc50be7`.
- **Aggregator + alt-auditor parallelized.** Sequential HTTP fan-out was
  timing out at 60s past ~90 descriptors. Now uses a bounded concurrency
  pool (16 workers) + batched manifest PUT. Full pipeline: 67s.
  Commit `e5553d9`.
- **Dashboard polling** reduced from 3s to 30s default, with a concurrency
  cap of 2. Was exhausting CSS's 6s lock expiry pool. Commit `31e3d26`.
- **Consolidated publish preprocess.** `normalizePublishInputs` helper in
  `@interego/core` replaces the duplicated logic previously inlined in
  `mcp-server` and `deploy/mcp-relay`. Commits `242f054`, `4ba718a`.

### Fixed

- **`cssUnavailable` one-way latch** in mcp-server. Used to poison the whole
  session on a single cold-start fetch failure; now treated as advisory.
  Commit `280160b` (also the Turtle-tokenizer commit).
- **Regex extractor cross-string-literal matching.** An IRI mentioned inside
  a `cg:revokedIf` SPARQL successorQuery was mis-lifted as a top-level
  `dct:conformsTo`. Fixed with the two-pass tokenizer. Commit `280160b`.
- **Revocation SHACL spec.** First-class extension with proposals A
  (`cg:RevocationFacet`) + B (`cg:revokedIf` predicate on `cg:SemioticFacet`).
  Commits `a3c305f`, `cc50be7`.

### Tests

- **`tests/publish-preprocess.test.ts`** — 15 cases pinning string-literal
  blanking, comment skipping, object-list shorthand, and combined
  interactions. Total suite: 670 passing.

---

## Earlier work

Pre-session capability baseline (inherited):

- End-to-end encrypted pod content (X25519 + XSalsa20-Poly1305 envelopes)
- Hypermedia-native data products (cg:Affordance + cgh:Affordance +
  hydra:Operation + dcat:Distribution type union)
- Per-surface agent minting (relay maps OAuth client_name to surface slug)
- Decentralized auth (SIWE / WebAuthn / did:key; no passwords; derived userId)
- Twelve formal ontologies + CI ontology-lint gate
- Six-facet ContextDescriptor model (Temporal / Provenance / Agent /
  AccessControl / Semiotic / Trust / Federation)
- Composition operators (union / intersection / restriction / override)
  forming a bounded lattice
- PGSL content-addressed sequence lattice
- Persistent Solid pod backed by Azure Files
- Validator module (programmatic SHACL-equivalent) + SHACL shapes export
