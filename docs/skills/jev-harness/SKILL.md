---
name: interego-jev-harness
description: "jev-harness development judgments as Interego affordances: 9 tools (navigate, select-tests, triage, review-gate, record-outcome, calibration, and more). Use when developing in a repository the bridge is bound to: where a task's change belongs, which tests to run after it, why a run failed, whether a diff needs a person, and recording the outcomes so the judgments calibrate."
license: MIT
metadata:
  vertical: jev-harness
  source: applications/jev-harness/affordances.ts
  affordances: 9
  manifest: "https://jev-harness-bridge-production.up.railway.app/affordances"
  generator: tools/build-skills.ts
---

# jev-harness development judgments

Use when developing in a repository the bridge is bound to: where a task's change belongs, which tests to run after it, why a run failed, whether a diff needs a person, and recording the outcomes so the judgments calibrate.

Everything here is derived from `applications/jev-harness/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `https://jev-harness-bridge-production.up.railway.app/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections). Full descriptions and inputs for every affordance: [reference.md](reference.md).

A hand-written skill guides this vertical end to end, with the flow an agent should follow: [`applications/jev-harness/claude-skill/SKILL.md`](../../../applications/jev-harness/claude-skill/SKILL.md). Prefer it; this file is the complete list of what the bridge offers.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `https://jev-harness-bridge-production.up.railway.app/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `jev_harness.navigate` | Given a task sentence, rank the repository files most likely to change, the test that most directly covers the behaviour, and the document to read first, with… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/navigate` |
| `jev_harness.select_tests` | For a set of changed files (or a git base_ref to diff against), return the tests to run: every test that imports a changed file (deterministic), plus the tests… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/select-tests` |
| `jev_harness.triage` | Parse a test-runner log into distinct failures and classify each one's cause (code-defect, test-defect, environment, flaky, missing-dependency-or-fixture, uncl… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/triage` |
| `jev_harness.review_gate` | Decide whether a diff may proceed without a person: deterministic checks (secret in diff, sensitive path, deleted test, oversized change), then model hazards (… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/review-gate` |
| `jev_harness.record_outcome` | Score a prior judgment against what happened: files_changed for a navigation, tests_failed for a test selection, human_decision for a review verdict, confirmed… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/outcome` |
| `jev_harness.calibration` | Per judgment kind, over every recorded outcome: sample count, hit@1 and hit@3 rates, mean Brier score, agreement counts. | `GET https://jev-harness-bridge-production.up.railway.app/jev-harness/calibration` |
| `jev_harness.publish_calibration` | Publishes the current calibration view as an Asserted jvh:Calibration descriptor under one graph IRI per repository, each publish superseding the last so the c… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/calibration/publish` |
| `jev_harness.reputation` | Every amta:Attestation about the harness agent on its pod — the bridge's own self-attestation, grounded in the calibration descriptor it names, and any a peer… | `GET https://jev-harness-bridge-production.up.railway.app/jev-harness/reputation` |
| `jev_harness.draft_attestation` | An amta:Attestation for YOU (a person, or the session agent acting for one) to publish about the harness agent from your own key: direction Peer, your ratings… | `POST https://jev-harness-bridge-production.up.railway.app/jev-harness/attestation/draft` |

