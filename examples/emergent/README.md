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
[`.github/workflows/emergent-suite.yml`](../../.github/workflows/emergent-suite.yml).

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
| `closed-loop-learner`             | `closed-loop-learner.mjs`                 | `EMERGENT_DATE`         | advisory  | unstable |
| `three-runtime-pilgrimage`        | `three-runtime-pilgrimage.mjs`            | `PILGRIMAGE_DATE`       | advisory  | unstable |
| `wallet-rotation`                 | `wallet-rotation-mid-relationship.mjs`    | `WALLET_ROTATION_DATE`  | advisory  | unstable |
| `forge-and-flood`                 | `forge-and-flood.mjs`                     | `FORGE_AND_FLOOD_DATE`  | advisory  | unstable |
| `watcher-vigil-compressed`        | `watcher-vigil-compressed.mjs`            | `WATCHER_DATE`          | opt-in    | long-running (~45min) |

### Required (4)

These four must pass for the workflow to be green. They exercise the
core substrate invariants — composition algebra, modal-status drift
under disputed assertion, sybil resistance, and constitutional
amendment quorum. Branch protection should reference the workflow's
`Required suite` job (not the individual matrix shards — matrix job
names are unstable as required-check identifiers).

### Advisory (4)

Run in CI with `continue-on-error: true`. They surface real substrate
gaps but currently exhibit intermittent failures we haven't fully
chased down — typically timing / propagation around cross-pod
discovery and CAS retry. Log output is uploaded as a per-scenario
artifact (`log-<scenario>`) for post-mortem.

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

2. Add a row to [`emergent-suite.yml`](../../.github/workflows/emergent-suite.yml)'s
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
