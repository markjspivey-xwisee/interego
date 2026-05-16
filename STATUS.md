# Interego — current status

Live snapshot of what's shipped, what's deferred, and where the bright
lines are. Updated 2026-05-16. Read alongside [`CHANGELOG.md`](CHANGELOG.md)
for the dated narrative.

## Activation funnel (PM-eval recommendations #1 + #2)

| Surface | Status |
|---|---|
| Front door (landing, README) — one user, one wedge | **live** (`2b3a857`) |
| Hosted MCP relay | **live** at https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io |
| `POST /try` — 60-second anonymous evaluation | **live** (`bbe960d`, `d123ee6`) |
| Dashboard "Claim this identity" path for `u-try-*` users | **live** (`d123ee6`) |
| `/connect?claim=<bearer>` autofill for the upgrade flow | **live** (`d123ee6`) |
| Stateless HMAC-signed tokens (survive deploys) | **live** (`4978326`) |
| `tools/smoke-try-flow.mjs` — 12-check end-to-end contract | **passing** (`6e6be2c`) |

Try it: `node tools/smoke-try-flow.mjs` from the repo root. Exit 0 = the
whole `/try → /me → /auth/webauthn/register-options` contract holds
against the live deployment.

## Protocol stability (PM-eval recommendation #3)

| Surface | Status |
|---|---|
| L1 protocol status | **Last Call Working Draft (2026-05-16)** |
| 12-month backcompat commitment through 2027-05-16 | **published** ([`spec/STABILITY.md`](spec/STABILITY.md)) |
| L1 wire format + `cg:` / `cgh:` / `pgsl:` / `ie:` / `align:` vocab | **frozen for v1.x** (additive-only) |
| Composition operator semantics + lattice laws | **normative** |
| Modal-truth invariants | **normative** |
| Conformance level partition (L1/L2/L3/L4) | **fixed** |
| Path to **Candidate Recommendation** | gated on (a) two independent interoperable implementations, (b) 30-day review window. **Neither has occurred yet.** |
| Path to **Recommendation** (full v1.0) | gated on 60+ days as CR with no breaking issues. |

Open invitation for second implementations in any language (Python,
Rust, Go) is in [`spec/STABILITY.md`](spec/STABILITY.md) §"How a second
implementation validates" — the conformance runner at
[`spec/conformance/runner.mjs`](spec/conformance/runner.mjs) is
deliberately dependency-free so a second implementation can validate
without a SHACL engine.

## Dual-audience verticals (PM-eval recommendation #4)

| Vertical | Audience | Status |
|---|---|---|
| **Learning** (LPC + LRS-adapter) | learner / performer | **live** — 6 affordances in [`applications/learner-performer-companion/affordances.ts`](applications/learner-performer-companion/affordances.ts) + the new `lpc.opt_into_cohort` (bilateral consent primitive) |
| **Learning** (LPC + LRS-adapter) | enterprise edtech professional | **live** — 4 affordances in [`applications/learner-performer-companion/src/institutional-publisher.ts`](applications/learner-performer-companion/src/institutional-publisher.ts) wired into the bridge |
| **Organizational working memory** | knowledge worker / individual contributor | **live** — 9 affordances in [`applications/organizational-working-memory/`](applications/organizational-working-memory/) |
| **Organizational working memory** | org-level operator | **live** — 4 affordances in [`applications/organizational-working-memory/src/operator-publisher.ts`](applications/organizational-working-memory/src/operator-publisher.ts) wired into the bridge |

End-to-end demos prove both pilots: [`demos/scenarios/24-dual-audience-owm.ts`](demos/scenarios/24-dual-audience-owm.ts)
and [`demos/scenarios/25-dual-audience-learning.ts`](demos/scenarios/25-dual-audience-learning.ts).

Design discipline: [`docs/DUAL-AUDIENCE.md`](docs/DUAL-AUDIENCE.md).

## Aggregate-privacy ladder

| Version | What it gives | Where it ships | Status |
|---|---|---|---|
| **v1 — `'abac'`** | Count derived from descriptors the operator's ABAC scope permits reading. No opt-in, no tamper evidence. | Default `privacy_mode` on `aggregate_decisions_query` / `aggregate_cohort_query` | **live** since `69959f7` |
| **v2 — `'merkle-attested-opt-in'`** | Learner / contributor explicitly opts in (signed `agg:CohortParticipation` on their own pod). Operator gets `AttestedAggregateResult` with Merkle root + per-leaf inclusion proofs. Auditor re-verifies; cheat-protection catches count inflation, leaf substitution, root tampering. Composes existing `src/crypto/zk/` Merkle primitives — no new vocab. | `applications/_shared/aggregate-privacy/` + both `aggregate_*_query` affordances | **live** since `51dafb1`; 12 contract tests in [`applications/_shared/tests/aggregate-privacy.test.ts`](applications/_shared/tests/aggregate-privacy.test.ts) |
| **v3 — `'zk-aggregate'`** | Homomorphic Pedersen sum + DP-Laplace noise. Each contributor commits to their value with a fresh blinding (ristretto255-Pedersen, RFC 9496); the aggregator sums commitments WITHOUT seeing individual values; the published sum is the true sum + Laplace noise calibrated to a public ε budget. Re-verifiable: an auditor confirms the sum-commitment equals the homomorphic sum of contributor commitments, and (with audit fields) that the trueSum opens it correctly. Catches: aggregator inflating the noisySum, substituting a different sumCommitment, changing the contributor set. | `src/crypto/pedersen.ts` + extended `applications/_shared/aggregate-privacy/` + both `aggregate_*_query` affordances | **live** since the v3 commit; 17 Pedersen tests in [`tests/pedersen.test.ts`](tests/pedersen.test.ts) + 9 v3 contract tests appended to [`applications/_shared/tests/aggregate-privacy.test.ts`](applications/_shared/tests/aggregate-privacy.test.ts) |
| **v3.1 — bounds enforcement + signed-bounds attestations** | Aggregator-side re-check that each contributor's value lies inside their declared bounds (a malicious contributor that bypasses their own client-side check is caught at sum-time). Optional `SignedBoundsAttestation` field — ECDSA signature over the canonical `signedBoundsMessage(commitment, bounds, contributorDid)` — binds the contributor to specific bounds; with `requireSignedBounds: true` the aggregator refuses contributions that lack a valid attestation. Closes the "lying contributor" cheat that v3 alone could not catch. | Same module + new `SignedBoundsAttestation` / `signedBoundsMessage` / `verifySignedBounds` exports | **live** since the v3.1 commit; 8 v3.1 contract tests pin the bounds re-check + every signed-bounds verify/reject path |
| **v3.2 — cumulative ε-budget tracking** | New `EpsilonBudget` class declares a per-cohort max ε; `consume({queryDescription, epsilon})` per query; throws when a query would push cumulative consumption past the cap. Optional `epsilonBudget` arg on `buildAttestedHomomorphicSum` plumbs the tracker into the aggregate path automatically. `toJSON` / `fromJSON` for persistence so the consumption log can be published as a pod descriptor for replay-audit. Honest accounting (not tamper-evident) — a malicious caller that bypasses the tracker still leaks DP info, but the audit log shows the gap. | Same module + new `EpsilonBudget` export | **live** since the v3.2 commit; 9 v3.2 contract tests pin construction validation, consume / canAfford / log / serialize-rehydrate, and the abort path in the aggregate function |
| **v3.3 — signed audit-log descriptor** | Wraps `EpsilonBudget.toJSON()` in a SignedBudgetAuditLog whose signature recovers the operator's DID. `canonicalizeBudgetForSigning` produces a deterministic string with sorted keys + fixed numeric formatting; `signBudgetAuditLog(budget, wallet, did)` signs it via the existing `src/crypto/wallet.ts`. `verifyBudgetAuditLog` recovers + checks signer + verifies log entries sum to spent + verifies spent ≤ maxEpsilon. Catches: log tampering, dropped entries, impersonated signer, internal-consistency violations. The audit log is now a verifiable artifact, not just honest accounting. | Same module + new `canonicalizeBudgetForSigning` / `signBudgetAuditLog` / `verifyBudgetAuditLog` exports | **live** since the v3.3 commit; 6 v3.3 contract tests pin honest round-trip + every tamper path |
| **Publishable bundles** | The in-memory bundles (AttestedHomomorphicSumResult + SignedBudgetAuditLog) are now publishable as normal `cg:ContextDescriptor` artifacts on the operator's pod. `publishAttestedHomomorphicSum({bundle, podUrl})` + `publishSignedBudgetAuditLog({signed, podUrl})` write the bundle JSON (with bigint round-trip via `bigintReviver`) inside an `agg:bundleJson` literal. Auditors call `fetchPublishedHomomorphicSum({graphUrl})` to retrieve + re-verify without trusting the aggregator's word that the bundle exists. Closes the "computed in memory" → "verifiable artifact" loop. | Same module + new `publishAttestedHomomorphicSum` / `publishSignedBudgetAuditLog` / `fetchPublishedHomomorphicSum` / `bigintReviver` exports | **live**; 3 contract tests pin the Turtle ↔ JSON escape round-trip + bigint preservation |

## Honest remaining work

| Item | Why it's not in scope right now |
|---|---|
| v4 multi-aggregator threshold reveal | Right now the aggregator is a single trusted role. v4 would distribute the reveal across k aggregators with a t-of-k threshold (DKG + Shamir secret sharing on the blindings). Real distributed-crypto work, separate scope. v3 covers the single-aggregator case the substrate's other identity primitives already trust. |
| ZK range proofs (currently bounds checked by aggregator re-check) | v3.1 closes the "lying contributor" cheat via aggregator-side bounds re-check + optional signed-bounds attestations. A future v3.2 could swap in a non-interactive ZK range proof so the bounds claim is verifiable without revealing the value — useful when the aggregator is itself partially trusted. The existing `src/crypto/zk/proveConfidenceAboveThreshold` is the building block for the [0,1] case. |
| Distribution-shaped metrics under v3 | The current v3 wiring supports count-shaped metrics only (decision-count / completion-count / credential-coverage / competency-threshold-met). Bucket distributions need a per-bucket commitment vector (v3.1). Falls through to v2 `merkle-attested-opt-in` mode today; v3 throws a clear error. |
| v4 — multi-party threshold reveal | Right now the aggregator is a single trusted role. v4 would distribute the reveal across k aggregators with a t-of-k Shamir secret sharing on the blindings + Distributed Key Generation. Real distributed-crypto work, separate scope. v3.3 covers the single-aggregator case the substrate's other identity primitives already trust. |
| Second-language Interego implementation | Required to advance L1 from Last Call → Candidate Recommendation. Multi-month, multi-person effort. The conformance runner + L1 backcompat commitment are the precondition; that work is done. Adopters in Python / Rust / Go are warmly welcomed via the GitHub issue tracker. |
| Per-vertical operator-side bridges as standalone deployments | The OWM + LPC bridges run both audiences on the same process today (auto-registered affordance set). For larger deployments where the institution wants a separate operator-only bridge with stricter network policy, the per-audience affordance arrays (`<vertical>Affordances` + `<vertical>{Operator,Enterprise}Affordances`) are already separable — split-deployment is a configuration change, not a code change. |
| MCP server tools beyond the current 60 | The MCP server's tool surface is intentionally narrow + HATEOAS-discovering. New tools should be substrate primitives or vertical-bridge endpoints, not first-party MCP additions. |
| Polish / UI on the dashboard + landing | Both are intentionally Spartan — they serve as proof that the substrate works, not as the marketing surface of a SaaS product. Stylistic polish is real work and would be welcomed as PRs. |

## Test + validation hygiene

- **`npx tsc -p tsconfig.json --noEmit`** — currently clean across the repo + each sub-project (mcp-server, deploy/identity, etc.).
- **`npx vitest run`** — **1283/1283 passing**, 29 skipped (network / external dependencies).
- **`node tools/ontology-lint.mjs`** — every owned-namespace reference in TS is defined in the corresponding `docs/ns/<prefix>.ttl` or allowlisted. CI-gated.
- **`node tools/smoke-try-flow.mjs`** — 12-check end-to-end contract test of the `/try → claim` activation funnel against any live deployment.
- **`node tools/derivation-lint.mjs`** — derivation-chain consistency check.
- **`node tools/security-txt-expiry-check.mjs`** — RFC 9116 expiry guardrail.

## Where to start reading

| If you are… | Start here |
|---|---|
| Considering Interego for an MCP agent | [README.md](README.md) — copy the JSON snippet at the top into your client config |
| Evaluating without signup | https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io → "Try it now" |
| Designing a new vertical | [`docs/DUAL-AUDIENCE.md`](docs/DUAL-AUDIENCE.md) + [`applications/README.md`](applications/README.md) |
| Implementing Interego in another language | [`spec/STABILITY.md`](spec/STABILITY.md) §"How a second implementation validates" |
| Choosing between aggregate-privacy modes (v1-v3.3) | [`docs/AGGREGATE-PRIVACY-MODES.md`](docs/AGGREGATE-PRIVACY-MODES.md) — adopter's field guide with the "which mode for which threat model" table |
| Auditing the v2 aggregate-privacy contract | [`applications/_shared/aggregate-privacy/index.ts`](applications/_shared/aggregate-privacy/index.ts) + the 44 contract tests |
| Looking at compliance evidence patterns | [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) + [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md) |
| Wondering "is this stable enough to depend on?" | [`spec/STABILITY.md`](spec/STABILITY.md) — read the 12-month commitment + the path to CR |
