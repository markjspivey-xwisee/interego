# jev-harness — System One development judgments as Interego affordances

> **Vertical application of Interego — NOT part of the protocol.** Layer: application-over-L3. Nothing here extends `iep:`; the vertical composes Context Descriptors, modal status, `iep:supersedes` chains and `iep:Affordance` controls. Vocabulary (`jvh:`) is vertical-scoped and lives in [`ontology/jev-harness.ttl`](ontology/jev-harness.ttl). Drops into the monorepo as `applications/jev-harness/`.

## What it is

Four development-time judgments a TypeSafe System One model (Jev) makes about a repository, each served as an affordance and published as a descriptor whose payload carries the controls an agent may follow next:

| Affordance | Question it answers | Deterministic half (code) | Semantic half (Jev) |
| --- | --- | --- | --- |
| `navigate` | Where does this task's change belong, which test covers it, what to read first | inventory, heads, directory pass over 240 files | Choice per role over file ids, Noul "already covered" |
| `select-tests` | Which tests does this change warrant | import graph (2 hops), sensitive-path and size rules | Choice per changed file over tests that cover it without importing it |
| `triage` | What does this failing run mean | log parsing into distinct failures, class-to-action table | Choice per failure over six cause classes |
| `review-gate` | May this diff proceed without a human | secrets, sensitive paths, deleted tests, size, the verdict policy | five hazard Nouls, description-match Score, risk Choice |
| `record-outcome` | What actually happened | hit@1, hit@3, Brier, agreement | none — observed, not judged |
| `calibration` | How well calibrated is each kind | rates over the judgment→outcome chains | none |

Every judgment is published **Hypothetical** with `iep:epistemicConfidence` set to the model's reported confidence. An outcome is **Asserted** and `iep:supersedes` the judgment it scores. The calibration view is computed over those chains; a cell stays Hypothetical until it has five samples.

## The Interego shape

```
GET /affordances                 iep:Affordance manifest (same Turtle as every vertical bridge)
        │  follow hydra:target
POST /jev-harness/navigate       → jvh:Navigation  (Hypothetical, confidence = model's)
        │  dereference the judgment: JSON | text/turtle | application/trig | text/markdown
GET /jev-harness/judgments/<id>.trig
        │  the payload graph carries hmd:Control + iep:Affordance resources:
        │    select-tests   (executable: hydra:target on this bridge, arguments prefilled)
        │    refine         (executable, only when confidence was below the open-top-file band)
        │    open-files     (declarative: no target; the editor or agent performs it)
        │    record-outcome (executable)
        │  follow one
POST /jev-harness/select-tests   → jvh:TestSelection → controls: run-selected-tests (declarative), triage, record-outcome
        │  ...
POST /jev-harness/outcome        → jvh:Outcome (Asserted, iep:supersedes the judgment) → control: calibration
```

The controls **emerge from the judged state**: a confident navigation offers no `refine`; an `auto-ok` verdict offers only `proceed`; a triage with flaky failures offers `retry`. Executable controls are authority-closed — their targets live in the payload the bridge signs, and the follower re-resolves the target from that document, never from a rendering. Declarative controls communicate a step without promising execution, exactly as the HyperMarkdown lesson on the pod distinguishes them.

Inputs are validated against SHACL shapes in the ontology before any model call; a violation answers with the relay's `422 { error: "shape_violation", shape, violations }` envelope. The follower validates against the same shapes before it posts.

## Run it

```bash
npm install
export TYPESAFE_API_KEY=...            # https://console.typesafe.ai (Windows: a user-scope variable also works)
PORT=6090 JEV_HARNESS_REPO=/path/to/repo BRIDGE_DEPLOYMENT_URL=http://localhost:6090 npm run bridge
```

Then follow the graph:

```bash
# where does this task belong?
npm run follow -- http://localhost:6090/affordances navigate --arg task="cmi5 block rollup emits satisfied twice"

# the CI chain: select → run the selection locally → triage the log when the run failed → score the selection
npm run follow -- http://localhost:6090/affordances select-tests --arg base_ref=origin/master --arg head_ref=HEAD \
  --then run-selected-tests --run --then triage --outcome --repo /path/to/repo

# gate a diff; exits 1 for needs-human-review, 3 for block
npm run follow -- http://localhost:6090/affordances review-gate --arg base_ref=origin/master --arg head_ref=HEAD \
  --arg title="..." --file description=pr-body.md --gate
```

`follow <document> <verb>` dereferences the document (the manifest or any judgment), finds the affordance or control by its `iep:action`, merges the control's prefilled `arguments` with `--arg/--json/--file`, validates, and acts. `--then` chains along the controls each result affords; `--run` performs the declarative `run-selected-tests` locally; `--outcome` scores the first judgment of the chain with what the chain observed.

Artifacts land in `<repo>/.jev-harness/judgments/<id>.{json,payload.ttl,trig,md}`.

## Publishing to the pod

Set `INTEREGO_BEARER` (and optionally `INTEREGO_RELAY_URL`, default `https://relay.interego.xwisee.com/mcp`) and every judgment is published through the relay's `publish_context` with its payload graph, modal status and confidence, and the bridge records a `record_trajectory_step` for its own loop. The relay is the authority for facets, signing, encryption and supersession; the local `.trig` is for offline use. The MCP transport is exercised against a fake relay in [`tests/publish.test.ts`](tests/publish.test.ts); the live relay was exercised from a Claude session with the same `publish_context` arguments (see the dogfood log below).

A published judgment renders in the HyperMarkdown viewer with one `:::control` block per control, and `get_descriptor` shows the same controls in the payload graph, so an agent on the pod can follow `select-tests` from a navigation it did not make.

## CI

[`ci/jev-harness.yml`](ci/jev-harness.yml) is a GitHub Actions workflow for the monorepo: it starts the bridge bound to the checkout, runs the selection chain on pull requests, uploads the artifacts, and gates on the review verdict. Add `TYPESAFE_API_KEY` (and `INTEREGO_BEARER` to publish) as repository secrets.

## Deployed

The bridge runs on Railway as the service `jev-harness-bridge` (image `interego-jev-harness-bridge`, built by `build-ghcr.yml` and tagged with the commit) at https://jev-harness-bridge-production.up.railway.app. Its `/health` reports the commit it was built from as `build`; `/affordances` is the manifest a generic agent discovers. Service variables: `TYPESAFE_API_KEY`, `BRIDGE_DEPLOYMENT_URL` (the public origin, so published controls are followable from the relay) and `JEV_HARNESS_OWNER_WEBID`; `INTEREGO_BEARER` is unset, so the deployed bridge judges but does not publish. The image is bound to the tree it was built from and carries no git, so changed files and diffs come from the follower that has one, as they do in CI. A merge to master that changes what the image ships redeploys it through `auto-deploy.yml`; `deploy-railway.yml` does the same by hand.

## Claude Code

[`.claude/skills/jev-harness/SKILL.md`](.claude/skills/jev-harness/SKILL.md) tells an agent to follow `navigate` at the start of a task, run the selection chain after a change, and gate the diff before finishing.

## Design notes

- Policy is code and it is published: `jvh:policy` on every verdict, `jvh:reason` on every selection, the class-to-action table on every triage. Thresholds live in `NAVIGATION_THRESHOLDS`, `SELECTION_POLICY`, `REVIEW_POLICY`.
- Jev sees the smallest state that answers the question: paths and head lines, never whole files; diffs under 60k characters with sensitive hunks first.
- Choice questions are capped at 240 options; larger trees get a directory pass first (`jvh:Navigation` records both passes).
- `auto-ok` means the gate does not demand a person. Nothing here merges anything.
- Limits: Jev generates nothing and does no arithmetic; every count and score is computed in code. Path-only state can miss a neighbouring file (measured: a rollup task answered `cmi5-course.ts` at 0.39 when `cmi5-lms.ts` was right), which is what the `open-top-three` band and the `refine` control are for.

## Dogfood log (2026-09-19, Interego repo at d06936c, jev-1.13.0)

The bridge was bound to a clone of the Interego monorepo and driven through the follower; the judgments were published to the maintainer's pod through the relay's `publish_context`.

| Step | Result |
| --- | --- |
| `navigate` "reuse the ADL asked verb IRI" over 2,645 files | directory pass over 97 groups, then 240 files; `xapi-profile.ts` first at 0.68, advice open-top-file, `CONFORMANCE.md` as the document to read; 2 requests, 21.9k input tokens, 1.1 s |
| `select-tests` for the two changed files | 12 tests: 9 by import graph, 3 semantic (`self-xapi`, `spec-ontology`, `tier3b-xapi-conformance`); the follower ran them in the monorepo, 112 passed in 42 s |
| `triage` of that run log | 0 failures parsed, no model call |
| `review-gate` on the diff | needs-human-review: no hazard above 0.13, description match 1.99 of 2, risk low but at confidence 0.33, under the 0.5 policy floor |
| `record-outcome` for the navigation | hit@1 true, hit@3 true, Brier 0.0288; `xapi-instrumentation.ts` was changed but was not a candidate |
| On the pod | navigation `1789868065028.ttl` (Hypothetical 0.67) superseded by the outcome `1789868213432.ttl` (Asserted, `if_match` precondition passed, `get_current_head` confirms); review verdicts `1789868261716.ttl` and `1789868654298.ttl`; test selection `1789868368905.ttl`; two trajectory steps in session `jev-harness-dogfood-2026-09-19`; content-bound signatures verified on read |

Two things the run taught, both now in the code:

- **The relay's note gate reads prefixed names.** A payload written with absolute IRIs is semantically identical and renders nothing; `schema:text`, `dct:title` and `hmd:control` must appear as tokens. The payload serializer emits prefixed Turtle, and the viewer now shows one `:::control` block per control.
- **A `localhost` target is declarative to the relay.** The viewer marks `record-outcome` DECLARATIVE because the relay will not follow a target it cannot reach. Locally the follower acts on it; for `invoke_affordance` to act from the pod, deploy the bridge publicly (Railway, as the Foxxi bridge is) and set `BRIDGE_DEPLOYMENT_URL` to that origin.
- A follower chain that pauses for a long test run can hit a stale keep-alive socket on its next hop; the follower now sends `Connection: close` and retries a transport failure once.

## Backtest on the repository's own history

`tools/backtest.ts` replays recent commits as tasks: it judges each one at the parent commit and scores the judgment against what the commit did. Ground truth is a proxy — a commit subject is not a task sentence, a series of commits titled "Integrate hosted client telemetry setup" each touching a different file cannot be told apart, and in a solo repository every landed commit was reviewed by its author — so read the numbers as a floor. Forty commits of the Interego monorepo, ≤ 25 files each, about $0.05 per run.

| Metric | Run 1 (as first built) | Run 2 (after the changes below) |
| --- | --- | --- |
| navigate hit@1 / hit@3 | 0.08 / 0.18 | 0.10 / 0.23 |
| navigate mean confidence | 0.485 | 0.375 |
| hit@1 when advice was open-top-file | 0 of 13 | 0 of 11 |
| hit@3 when advice was open-top-three | 0.35 (n=17) | 0.50 (n=12) |
| right top-level directory in the first pass | 0.475 | see note |
| select covers the tests the commit touched | 0.43 (n=14) | 0.43 (n=14) |
| select full-suite rate | 0.29 | 0.26 |
| gate auto-ok / needs-human / block | 0.10 / 0.88 / 0.03 | 0.25 / 0.75 / 0 |

What the first run changed in the code:

- **Directory pass by independent Nouls, not one Choice.** The single-winner Choice picked the wrong top-level directory more than half the time, after which no file-pass answer could be right, and the reported confidence ignored it. The pass now asks one Noul per directory, keeps every plausible one up to the option cap, and the judgment's confidence is the file pass weighted by the top candidate's directory probability. Confident wrong answers fell; they did not vanish.
- **Gate rule from the risk distribution, not its collapsed confidence.** "Confidence below 0.5" sent 16 low-or-medium diffs to a human because the model was torn between low and medium. The rule is now "probability of high risk at or above 0.25", and the one block in run 1 was a fixture token inside a test file, which the secret check now ignores for the generic pattern.
- **Name-affinity test selection.** A test whose file name carries a changed file's stem is selected even when it never imports it. It did not move the touched-test coverage on these 40 commits; it stays because it is cheap and right.
- **Calibrated advice.** Static confidence bands offered open-top-file eleven times with no hits. The service now derives the advice from the measured hit rates of the judgment's confidence bucket once that bucket holds five outcomes, and says so on the judgment (`jvh:adviceBasis`, `jvh:adviceBucket`). Until then the static bands apply. Outcomes carry a source: a bucket is computed from live outcomes once it has five of them and from every outcome, replayed ones included, until then, so the replay is the floor the calibration starts from rather than the ceiling it stays at. The controls a navigation affords therefore follow the evidence, which is the point of publishing outcomes at all.

What did not change: the gate stays conservative on this repository because most of its commits touch the relay, signing or delegation code, and the model reads them as risky; the "P(high) ≥ 0.25" reason fired on 26 of 40. That is a property of the codebase more than of the gate.

## Tests

```bash
npm test              # 36 tests, fake model, fake relay, real HTTP bridge
JEV_LIVE=1 npm test   # declared live model test; fails loudly if the model is unreachable
npx tsx tools/backtest.ts --repo <repo> --commits 40   # replay history and fill the calibration view
```
