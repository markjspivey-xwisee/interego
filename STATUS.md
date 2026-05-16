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

## Honest remaining work

| Item | Why it's not in scope right now |
|---|---|
| v4 multi-aggregator threshold reveal | Right now the aggregator is a single trusted role. v4 would distribute the reveal across k aggregators with a t-of-k threshold (DKG + Shamir secret sharing on the blindings). Real distributed-crypto work, separate scope. v3 covers the single-aggregator case the substrate's other identity primitives already trust. |
| Per-contribution range proofs paired with v3 | v3 ships with self-bounding (contributors check their own value is in declared `[min, max]` before committing). A malicious contributor that commits outside the bounds can inflate the sum. Mitigation: pair v3 with the existing `proveConfidenceAboveThreshold` range proof (for [0,1] values) on each contribution. Wiring this into the bridges' aggregate paths is the v3.1 enhancement. |
| Distribution-shaped metrics under v3 | The current v3 wiring supports count-shaped metrics only (decision-count / completion-count / credential-coverage / competency-threshold-met). Bucket distributions need a per-bucket commitment vector (v3.1). Falls through to v2 `merkle-attested-opt-in` mode today; v3 throws a clear error. |
| Cumulative ε-budget tracking across queries | Each query consumes a fresh ε; cross-query composition is the caller's responsibility (per [`spec/AGGREGATE-PRIVACY.md`](spec/AGGREGATE-PRIVACY.md) §"DP-budget"). |
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
| Auditing the v2 aggregate-privacy contract | [`applications/_shared/aggregate-privacy/index.ts`](applications/_shared/aggregate-privacy/index.ts) + the 12 contract tests |
| Looking at compliance evidence patterns | [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) + [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md) |
| Wondering "is this stable enough to depend on?" | [`spec/STABILITY.md`](spec/STABILITY.md) — read the 12-month commitment + the path to CR |
