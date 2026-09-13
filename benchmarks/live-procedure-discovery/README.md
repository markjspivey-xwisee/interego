# Live procedure-discovery benchmark

This small, live, four-pair study compares access to an applicable procedure with access to the same operational documentation without that procedure. It records discovery, assessment, private evidence acceptance and an isolated test-release declaration. Seven logical runs completed; one stopped after an unsuccessful assessment. The observations include controller interruptions, reconstructed continuations and a separate recorder gap. They do not establish a cost advantage or superiority of either exposure arm.

## Observed runs

Protocol **1.0.4** planned eight fresh-agent runs. Four original controller contexts were lost and replaced by four new controllers continuing those same logical cases. The record therefore contains **eight logical runs and twelve controller starts**, rather than eight uninterrupted fresh-agent executions. Original final recorder captures for the four recovered cases remain unavailable; reconciling their reconstructed recorders cannot restore capture completeness.

Run06 later lost its transient recorder stores within the same original controller context. It restored counters and the call index from its own retained files, but its final completed-record store contains only the continuation. No replacement controller was launched for this gap. There are therefore **five incomplete captures**, four controller replacements and three complete original recorder captures.

Public labels below match `public-evidence.json`. P1 and P2 have stable bindings; P3 and P4 are assigned changed bindings. “Present” and “absent” refer only to the applicable procedure in the knowledge catalog.

| Run | Pair | Procedure | Capture | Calls | Batches | Failed calls | Grade | Task outcome |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| Run01 | P1 | Present | Recovered; incomplete | ≥44 | ≥17 | ≥0 | 10/10 | Completed |
| Run02 | P1 | Absent | Complete recorder | 38 | 15 | 0 | 10/10 | Completed |
| Run03 | P2 | Absent | Recovered; incomplete | ≥42 | ≥20 | ≥0 | 10/10 | Completed |
| Run04 | P2 | Present | Complete recorder | 37 | 16 | 0 | 10/10 | Completed |
| Run05 | P3 | Present | Recovered; incomplete | ≥51 | ≥22 | ≥1 | 10/10 | Completed |
| Run06 | P3 | Absent | Recorder gap; incomplete | ≥41 | ≥22 | ≥1 | 10/10 | Completed |
| Run07 | P4 | Absent | Recovered; incomplete | ≥50 | ≥24 | ≥1 | 10/10 | Completed |
| Run08 | P4 | Present | Complete recorder | 28 | 11 | 0 | 9/10 | Stopped before acceptance and release |

All four recovered runs are explicitly **nonconformant**, with a controller restart, assistance and a protocol deviation recorded for each. Their passing grades and completed state/replay checks establish retained task outcomes; their original whole-stream launch and submission totals remain unknown (`null`). A recorded fresh assessment session does not mean the replacement controller retained an uninterrupted fresh context. Run03 also has uncorroborated continuation-message provenance: conflicting retained coordinator descriptions survive, without a corroborating message transcript. Its completed release does not resolve that uncertainty.

Run02 and Run04 completed with conformant, reconciled original recorder streams. Run05, Run06 and Run07 retained a failed stale-binding action followed by recovery. Run06 is also nonconformant because of its incomplete recorder capture, with one deviation, zero recorded assistance and zero controller restarts. Its whole-stream launch and submission totals remain unknown (`null`) despite its retained 10/10 grade and completed outcome. Run08 received a successful assessment response reporting 9/10, then stopped in draft state without a retry, evidence acceptance, release or binding intervention. Thus its zero failed external calls does not imply task success. A changed-binding assignment alone does not establish that an intervention occurred.

Every pair contains an incomplete capture. **All paired call, batch and failed-call differences are unavailable (`null`)**. Aggregate retained costs are lower bounds: **at least 331 calls, 147 batches and three failed calls**. Subtracting the displayed retained counts would produce no valid paired cost estimate.

## Method and deviations

Each agent starts with a plain-language goal and one neutral workspace entry. The entry supplies no applicable-procedure address, title, rank or treatment assignment. Both arms receive the same operational references, services, frozen policy, assessment and test-release requirements. Each catalog contains three procedure candidates; the procedure-absent arm substitutes an irrelevant candidate for the applicable frozen method. The method was authored from prior experience and frozen before the runs. Discovery lineage and a retained execution mapping are reviewed separately from completion; a citation cannot establish every hidden reasoning step.

Two pairs retain stable action bindings and two schedule a change after evidence acceptance. Within each condition, procedure-present is scheduled first once and second once. This is fixed counterbalancing in a convenience sample, without random assignment or population sampling. Original agents were requested with fresh conversation contexts and the same inherited model/reasoning settings; provider-internal state and settings were not independently established. The four replacement contexts are disclosed deviations from this design.

The task requires a live assessment with the frozen policy, a private signed observation corresponding to the actual response, acceptance by the isolated test application, a test-release declaration, and current-state and complete receipt-replay checks. Passing requires 10/10. The release declares application state; it does not deploy infrastructure. The assessment is known and reused, so its grades do not establish held-out generalization or perfect policy implementation.

The frozen budget is 80 external calls, at most one successful assessment launch and at most one graded submission per logical run. An unsuccessful grade remains an outcome. A new session after a grade or an unresolved launch/submission is prohibited; uncertainty requires state inspection before any permitted retry. These requirements do not turn missing observations into evidence of compliance.

After evidence acceptance, an agent saves the advertised release descriptor, action and payload. The fixed continuation requires that saved binding as its next external call. In changed cases that reach this checkpoint, the coordinator first publishes a version-checked successor changing the action identity and adding an acknowledgement input, without supplying replacement values or a recovery hint. Stale rejection and recovery are measured from actual retained calls.

Protocol 1.0.4 also exposes the same signed report of a completed synthetic privacy/replay preflight to both arms. Agents verify that report, its linked private synthetic resources and the advertised runtime build before assessment; those reads count against the budget. The privacy fix in PR #401 was deployed before this cohort. The preflight establishes a recorded infrastructure prerequisite, without supplying assessment results or proving confidentiality of future writes. Actual artifacts require their own checks.

The earlier **protocol 1.0.3** cohort remains separate in `public-setup-attempts.json`: eight planned assignments, four started blocked attempts and four unstarted assignments; **77 calls, 33 batches, four failed calls, zero assessment launches, zero graded submissions and zero publications or committed runtime transitions**. Required preflight evidence existed in coordinator captures but was absent from agents' reachable frozen resources. The prospective amendment exposed that evidence; it does not retrospectively attribute it to earlier agents or pool their costs into the main cohort.

## Counting and evidence limits

An external call is one recorded invocation of a permitted generic operation, including reads, signing, actions, publications, retries, polls and failures. A decision batch groups calls selected together by the model. Local decoding, serialization and logging are excluded. Batches do not measure inference calls, tokens, money, latency or reasoning quality. Omitted credentials prevent complete response-byte accounting.

Coordinator setup, the synthetic preflight, scheduled authority changes, independent audit reads and archiving are excluded from agent counts. The study therefore does not measure total system operating cost. `exact-retained-stream` means that the original instrumented recorder was captured and reconciled; it cannot exclude undisclosed activity outside that recorder. `retained-lower-bound` preserves the available rows when capture is incomplete or a controller restarts.

Private review checks retained response/submission correspondence, observation binding, current state, receipt replay, procedure discovery, scope and disclosed deviations. It relies on retained relay assertions and agent disclosures within the limits in [PRIVACY.md](PRIVACY.md). The public data cannot independently authenticate withheld evidence. The interrupted design, reused assessment, small fixed sample and one-account environment support descriptive observations only; neither statistical superiority nor a general causal or performance claim is warranted.

## Inspect the public record

The export contains three unsigned files: `public-evidence.json` (run observations and generic call rows), `public-procedure.json` (nine anonymous roles, ten steps and eleven dependency edges), and `public-setup-attempts.json` (the separate aborted cohort). The procedure file exposes topology, without the private method text or operational selectors.

From the repository root, using Node.js:

```sh
node --test benchmarks/live-procedure-discovery/public-release.test.mjs
node benchmarks/live-procedure-discovery/audit.mjs benchmarks/live-procedure-discovery
node benchmarks/live-procedure-discovery/audit.mjs --setup-only benchmarks/live-procedure-discovery
```

The tests use synthetic inputs. The audit recomputes public arithmetic, schema consistency and procedure topology. A passing result does not reverify live signatures, private-source correspondence, hidden activity or original capture completeness.
