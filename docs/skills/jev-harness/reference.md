# jev-harness development judgments: every affordance

Derived from `applications/jev-harness/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 9 affordances.

## `jev_harness.navigate`

**Navigate: where does this task belong**

Given a task sentence, rank the repository files most likely to change, the test that most directly covers the behaviour, and the document to read first, with a probability each and an advice level (open-top-file, open-top-three, widen-search) derived from the model's confidence. Publishes a Hypothetical jvh:Navigation whose payload carries the next controls: select-tests for the candidates, a narrowed refine pass when confidence is low, and record-outcome.

- Action: `urn:iep:action:jev-harness:navigate`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/navigate`
- Input shape: `https://jev-harness.interego.xwisee.com/ns/jev-harness#NavigateInputShape`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#Navigation`
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `task` | string | yes | The task sentence: what is to be changed or found. |
| `scope` | string | no | Repository-relative directory to search within. |
| `top_k` | integer | no | Candidates per role, 1 to 10. |

## `jev_harness.select_tests`

**Select the tests a change warrants**

For a set of changed files (or a git base_ref to diff against), return the tests to run: every test that imports a changed file (deterministic), plus the tests the model judges to cover a changed file without importing it (semantic, with probabilities). Sensitive paths, infrastructure files and oversized changes return mode=full with the reason. Publishes a Hypothetical jvh:TestSelection whose controls are run-selected-tests (declarative), triage and record-outcome.

- Action: `urn:iep:action:jev-harness:select-tests`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/select-tests`
- Input shape: `https://jev-harness.interego.xwisee.com/ns/jev-harness#SelectTestsInputShape`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#TestSelection`
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `changed_files` | array of string | no | Repository-relative paths that changed. |
| `base_ref` | string | no | Git ref to diff against when changed_files is not given. |
| `head_ref` | string | no | Git ref of the change; defaults to the working tree. |
| `task` | string | no | Optional task sentence for context. |

## `jev_harness.triage`

**Triage a failing test run**

Parse a test-runner log into distinct failures and classify each one's cause (code-defect, test-defect, environment, flaky, missing-dependency-or-fixture, unclear) with a probability distribution; the class-to-action table is published on the judgment. Publishes a Hypothetical jvh:FailureTriage whose controls are one declarative action per cause class plus record-outcome.

- Action: `urn:iep:action:jev-harness:triage`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/triage`
- Input shape: `https://jev-harness.interego.xwisee.com/ns/jev-harness#TriageInputShape`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#FailureTriage`
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `log` | string | yes | The test runner's output. |
| `changed_files` | array of string | no | Files changed in the run under test. |

## `jev_harness.review_gate`

**Gate a diff for human review**

Decide whether a diff may proceed without a person: deterministic checks (secret in diff, sensitive path, deleted test, oversized change), then model hazards (authorization change, weakened validation, removed assertions, undeclared external effect, behaviour beyond the description), a description-match score and a risk rating. The verdict — auto-ok, needs-human-review or block — is derived by the policy text published on the judgment. auto-ok means only that the gate does not demand a person. Publishes a Hypothetical jvh:ReviewVerdict.

- Action: `urn:iep:action:jev-harness:review-gate`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/review-gate`
- Input shape: `https://jev-harness.interego.xwisee.com/ns/jev-harness#ReviewGateInputShape`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#ReviewVerdict`
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `diff` | string | no | A unified diff. Either this or base_ref. |
| `base_ref` | string | no | Git ref to diff against. |
| `head_ref` | string | no | Git ref of the change; defaults to the working tree. |
| `title` | string | no | Change title (PR title or commit subject). |
| `description` | string | no | Change description (PR body). |

## `jev_harness.record_outcome`

**Record what actually happened**

Score a prior judgment against what happened: files_changed for a navigation, tests_failed for a test selection, human_decision for a review verdict, confirmed_classes for a triage. Publishes an Asserted jvh:Outcome that iep:supersedes the Hypothetical judgment (hit@1, hit@3, Brier, agreement). This is the evidence atom of the calibration view.

- Action: `urn:iep:action:jev-harness:record-outcome`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/outcome`
- Input shape: `https://jev-harness.interego.xwisee.com/ns/jev-harness#RecordOutcomeInputShape`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#Outcome`
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `judgment_iri` | string | yes | urn:graph:jev-harness:* IRI of the judgment being scored. |
| `files_changed` | array of string | no | Files that actually changed. |
| `tests_run` | array of string | no | Tests that ran. |
| `tests_failed` | array of string | no | Tests that failed. |
| `human_decision` | one of `approved`, `changes-requested`, `blocked` | no | approved, changes-requested or blocked. |
| `confirmed_classes` | string | no | JSON object: failure id to confirmed cause class. |

## `jev_harness.calibration`

**Read the calibration view**

Per judgment kind, over every recorded outcome: sample count, hit@1 and hit@3 rates, mean Brier score, agreement counts. A cell is Hypothetical until it has five samples and Asserted after. A view over the judgment-to-outcome supersession chains, not a store.

- Action: `urn:iep:action:jev-harness:calibration`
- HTTP: `GET https://jev-harness-bridge-production.up.railway.app/jev-harness/calibration`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#Calibration`
- Media type: `application/json`
- Inputs: none

## `jev_harness.publish_calibration`

**Publish the calibration view to the pod, and the attestation it grounds**

Publishes the current calibration view as an Asserted jvh:Calibration descriptor under one graph IRI per repository, each publish superseding the last so the chain is the calibration history, and — once a cell has reached its sample floor — an amta:Attestation the harness issues about itself (direction Self: competence from navigation hit@3, accuracy from review-verdict agreement, relevance from test-selection coverage, honesty from navigation Brier), grounded in the calibration descriptor. Answers with where both landed; skipped without a relay. The bridge also publishes on its own after a pod read-back that added outcomes, and CI after scoring a merged pull request.

- Action: `urn:iep:action:jev-harness:publish-calibration`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/calibration/publish`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#Calibration`
- Media type: `application/json`
- Inputs: none

## `jev_harness.reputation`

**Read what the pod attests about this agent**

Every amta:Attestation about the harness agent on its pod — the bridge's own self-attestation, grounded in the calibration descriptor it names, and any a peer publishes — aggregated by @interego/registry under the harness policy (a grounded self-attestation counts at a quarter of a peer's word, half of a high-assurance one's; thirty-day recency half-life). Answers with the attestations read, the snapshot (per-axis ratings and the contributing descriptors) or null when nothing attests, and the policy. The gated auto-merge reads the accuracy axis when a person is required.

- Action: `urn:iep:action:jev-harness:reputation`
- HTTP: `GET https://jev-harness-bridge-production.up.railway.app/jev-harness/reputation`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#Calibration`
- Media type: `application/json`
- Inputs: none

## `jev_harness.draft_attestation`

**Draft a peer attestation about this agent**

An amta:Attestation for YOU (a person, or the session agent acting for one) to publish about the harness agent from your own key: direction Peer, your ratings where you give them and the calibration ratings where you do not, grounded in the outcome you decided on or in the calibration. The bridge returns the graph and the exact publish_context arguments; it never publishes it itself, because a second voice has to be another key. Once published, GET /jev-harness/reputation weighs it as PeerAttested.

- Action: `urn:iep:action:jev-harness:draft-attestation`
- HTTP: `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/attestation/draft`
- Input shape: `https://jev-harness.interego.xwisee.com/ns/jev-harness#DraftAttestationInputShape`
- Returns: `https://jev-harness.interego.xwisee.com/ns/jev-harness#AttestationDraft`
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `attestor` | string | yes | The DID or WebID that will publish the attestation: you, or the session agent acting for you. |
| `about` | string | no | The descriptor URL the attestation is grounded in: an outcome you decided on. The calibration descriptor when absent. |
| `note` | string | no | Why, in a sentence; becomes the prose of the attestation. |
| `accuracy` | number | no | Your rating 0..1 of how the review verdict agrees with people; the calibration rating when absent. |
| `competence` | number | no | Your rating 0..1 of navigation; the calibration rating (hit@3) when absent. |
| `relevance` | number | no | Your rating 0..1 of test selection; the calibration rating when absent. |
| `honesty` | number | no | Your rating 0..1 of how faithfully probabilities report what happens; the calibration rating when absent. |

