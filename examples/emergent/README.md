# Emergent test suite

Substrate-adversarial harness. Each scenario in this directory is a
single `.mjs` script that wallet-roots N agents in-process, publishes
typed Context Descriptors to a live deployed Solid pod, and asserts
substrate-level invariants — composition algebra, modal-status drift,
sybil resistance, constitutional amendment quorum, capability-passport
lifecycle, etc.

No LLM calls. Every agent is an async function with its own wallet. A
full run costs $0 in API spend; the only cost is wall clock and pod
storage at the deployed CSS.

The CI workflow that drives this suite lives at
[`.github/workflows/nightly-emergent.yml`](../../.github/workflows/nightly-emergent.yml).

## Running a scenario locally

Every scenario reads `CG_DEMO_POD_BASE` (same fallback as
[`examples/_lib.mjs`](../_lib.mjs)) and a per-scenario `*_DATE` env
var that gets baked into the pod subpath, so you can run repeatedly
without colliding with previous runs:

```bash
# Run against the default deployed CSS pod.
npx tsx examples/emergent/concurrent-cartographers.mjs

# Point at your own pod.
CG_DEMO_POD_BASE=https://my-pod.example \
  npx tsx examples/emergent/concurrent-cartographers.mjs

# Isolate this run's pod subpath with an explicit tag.
CC_DATE=local-$(date +%s) \
  npx tsx examples/emergent/concurrent-cartographers.mjs
```

Each scenario prints its pod base, date tag, and assertion results to
stdout. Exit 0 = all assertions passed; exit 1 = at least one failed
and the script prints `got vs. expected` for the failure.

## The scenarios

| Scenario                          | Script                                    | Date env var            | CI tier   | Status  |
| --------------------------------- | ----------------------------------------- | ----------------------- | --------- | ------- |
| `concurrent-cartographers`        | `concurrent-cartographers.mjs`            | `CC_DATE`               | required  | passing |
| `disputed-fact-arena`             | `disputed-fact-arena.mjs`                 | `DISPUTED_FACT_DATE`    | required  | passing |
| `sybil-swarm-attestation`         | `sybil-swarm-attestation.mjs`             | `SYBIL_SWARM_DATE`      | required  | passing |
| `constitutional-amendment-vote`   | `constitutional-amendment-vote.mjs`       | `CAV_DATE`              | required  | passing |
| `closed-loop-learner`             | `closed-loop-learner.mjs`                 | `EMERGENT_DATE`         | required  | passing |
| `three-runtime-pilgrimage`        | `three-runtime-pilgrimage.mjs`            | `PILGRIMAGE_DATE`       | advisory  | passing |
| `wallet-rotation`                 | `wallet-rotation-mid-relationship.mjs`    | `WALLET_ROTATION_DATE`  | advisory  | passing |
| `forge-and-flood`                 | `forge-and-flood.mjs`                     | `FORGE_AND_FLOOD_DATE`  | advisory  | passing |
| `byzantine-federation-loader`     | `byzantine-federation-loader.mjs`         | `BYZANTINE_FEDERATION_DATE` | advisory | passing |
| `time-travel-audit`               | `time-travel-audit.mjs`                   | `TTA_DATE`              | advisory  | passing |
| `belief-revision-cascade`         | `belief-revision-cascade.mjs`             | `BRC_DATE`              | advisory  | passing |
| `partitioned-saga-replay`         | `partitioned-saga-replay.mjs`             | `PSR_DATE`              | advisory  | passing |
| `value-drift-trial`               | `value-drift-trial.mjs`                   | `VALUE_DRIFT_DATE`      | advisory  | passing |
| `watcher-vigil-compressed`        | `watcher-vigil-compressed.mjs`            | `WATCHER_DATE`          | opt-in    | long-running (~45min) |

All 13 mechanical scenarios (everything except the opt-in Vigil) pass
against the live deployed CSS pod when each is given a fresh per-run
pod subpath — which CI always provides via `RUN_TAG`. The substrate
fixes that made them green are in `src/solid/client.ts` (manifest CAS
retry budget, post-PUT verify-GET, 5xx retry, Trust+Semiotic facet
projection) and in the relevant facet merge operators (`union` and
`intersection` collapsed onto a single lattice meet so absorption
holds).

### Required (5)

These five must pass for the workflow to be green. They exercise the
core substrate invariants — composition algebra, modal-status drift
under disputed assertion, sybil resistance, constitutional amendment
quorum, and runtime cross-vertical affordance discovery + invocation.
Branch protection should reference the workflow's `Required suite`
job (not the individual matrix shards — matrix job names are unstable
as required-check identifiers).

### Advisory (8)

Run in CI with `continue-on-error: true`. All currently pass on the
deployed CSS pod, but stay advisory until they've gone green across a
few nightly runs and earn promotion. Failures here flag a regression
worth investigating without red-X'ing the workflow.

- **First tier (3)** — `three-runtime-pilgrimage`, `wallet-rotation`,
  `forge-and-flood`. Exercise cross-pod identity continuity, wallet
  rotation lineage, and reader-side trust filtering against forged
  descriptors.
- **Second tier (5)** — `byzantine-federation-loader`, `time-travel-audit`,
  `belief-revision-cascade`, `partitioned-saga-replay`, `value-drift-trial`.
  Each exercises a distinct substrate primitive (per-peer trust
  ledger, bitemporal effective-at queries, counterfactual taint
  cascade, saga heal without double-compensation, signed value
  trajectory across an 18-month biography).

Log output is uploaded as a per-scenario artifact (`log-<scenario>`) for
post-mortem.

### Opt-in (1)

`watcher-vigil-compressed` simulates a 72-hour capability-passport
lifecycle compressed into ~30 minutes of wall-clock time. It is
expensive enough that we don't run it on every schedule / PR — it
only runs when you explicitly invoke `workflow_dispatch` with
`include_watcher: true`.

## CI triggers

The workflow runs in three cases:

1. **`schedule`** — nightly at 03:00 UTC. Catches regressions in the
   deployed CSS pod even when nobody pushed code.
2. **`workflow_dispatch`** — ad-hoc. Inputs: `tests` (comma-separated
   scenario names, or `all`), `include_watcher` (`true`/`false`).
3. **`pull_request` labeled `emergent-suite`** — opt-in. Add the
   `emergent-suite` label to a PR that touches substrate code
   (composition, ABAC, registry, passport, transactions, etc.) to
   exercise the suite before merge.

Each scenario gets a 20-minute timeout (45 for the Vigil scenario) and
runs in its own isolated pod subpath — the `*_DATE` env var is set to
`ci-<run_id>-<run_attempt>-<scenario>` so concurrent / repeat runs
never collide on `.well-known/context-graphs`.

## Adding a new emergent test

1. Write the scenario as `examples/emergent/<name>.mjs`. Follow the
   conventions used by the existing scripts:

   - Read `CG_DEMO_POD_BASE` from env, falling back to the deployed
     CSS host (`examples/_lib.mjs` does this for you).
   - Read a per-scenario `*_DATE` env var and bake it into the pod
     subpath: `${CSS}/demos/emergent-<name>-${SCENARIO_DATE}/`. CI
     uses this to isolate parallel runs.
   - Print pod base, date tag, and roster at the top of stdout.
   - Exit 0 on full success; exit 1 with `got vs. expected` on the
     first failed assertion.

2. Add a row to [`nightly-emergent.yml`](../../.github/workflows/nightly-emergent.yml)'s
   matrix:

   ```yaml
   - scenario: my-new-scenario
     tier: required            # or advisory
     date_env: MY_NEW_DATE     # the *_DATE env var your script reads
     # optional: omit if the script's filename matches scenario name
     script: my-new-scenario.mjs
   ```

3. Decide the tier. **Required** if the scenario passes reliably and
   exercises a load-bearing substrate invariant. **Advisory** if it's
   useful but still flaky — advisory shards run with
   `continue-on-error: true` so a flake never red-X's the workflow.

4. Add a row to the table above with the current pass/fail state.

## Pod cleanup

The deployed CSS pod is the source of truth across these runs. Each
CI run writes to `${CG_DEMO_POD_BASE}/markj/demos/emergent-<name>-ci-<run_id>-<attempt>-<scenario>/`,
which is human-grep-able if you need to inspect or remove old
artifacts. There is no automatic garbage collection; the substrate is
content-addressed and old descriptors are cheap to retain.

## Recovering a corrupted pod path

If a local re-run on the same date crashes mid-write and leaves CSS
serving an unwritable resource — the symptom is `HTTP 500` with
`ENOENT: ... open '<path>$.<ext>'` on every PUT, while `GET` returns
200 with a stale etag that survives container restart — the file
backend has lost the resource's body file but kept its metadata. This
is unrepairable through the HTTP API (see CSS upstream issue
[#2163](https://github.com/CommunitySolidServer/CommunitySolidServer/issues/2163)):
`DELETE` on the resource returns 205 but doesn't clear the cache,
`DELETE` on the `.meta` companion is rejected by design, parent
containers refuse to delete because they're "not empty", and
`If-None-Match: *` returns 412 because CSS still thinks the resource
exists.

The fix is to put a fresh body file directly into the storage volume.
On the deployed Azure Files-backed CSS:

```bash
RG=context-graphs-rg
ACCT=interegocssdata1730
SHARE=css-data
KEY=$(az storage account keys list --account-name "$ACCT" \
       --resource-group "$RG" --query "[0].value" -o tsv)

# Upload a non-empty body file at the expected $-suffixed path.
# Any valid Turtle (even an empty manifest header) is enough — the
# very next HTTP write will overwrite it with the real content.
az storage file upload \
  --account-name "$ACCT" --account-key "$KEY" --share-name "$SHARE" \
  --source ./recovery-body.ttl \
  --path "demos/<corrupted-path>/.well-known/context-graphs\$.ttl"
```

The next `HEAD` against CSS picks up the new file (new etag) and
`PUT` works normally. Re-running the test against the same date then
passes end-to-end.

Easier in practice: just use a fresh date suffix
(`EMERGENT_DATE=$(date +%Y-%m-%d-%s) npx tsx examples/emergent/closed-loop-learner.mjs`)
so each local run lands on a virgin pod path. CI already does this
via `RUN_TAG`.
