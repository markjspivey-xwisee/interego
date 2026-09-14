# Changed-binding follow-up

Layer 3, non-normative empirical report. Separate prospective protocol 2.1.0; September 2026.

All four follow-up trials finished: 4 completed test releases and 0 blocked outcomes. 4 trials verified stale-binding rejection and subsequent recovery. The controllers recorded 191 Interego invocations in 93 decision groups, including 4 failed invocations and 0 transport exceptions.

3 of four trials conformed to the recorded protocol. All outcomes remain visible; nonconformant trials are excluded from paired contrasts.

The original protocol 2.0.0 cohort remains unchanged: three releases completed, one trial was blocked, one controller was interrupted at a saved checkpoint, and three assignments were unstarted. This follow-up measures the four unfinished changed-binding conditions using fresh task instances and fresh controller contexts. It is a new temporal block, not a continuation or successful replacement of the lost controller. [Original frozen results](README.md) and [follow-up measurements](followup-results.json) are reported separately.

## Observed follow-up runs

| Run | Controller | Release procedure | Grade | Calls | Groups | Failed calls | Outcome | Stale recovery | Conformant |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| F01 | Plan-Act style | Present | 10/10 | 47 | 19 | 1 | completed | Verified | Yes |
| F02 | Plan-Act style | Absent | 10/10 | 47 | 24 | 1 | completed | Verified | No |
| F03 | ReAct style | Absent | 10/10 | 47 | 25 | 1 | completed | Verified | Yes |
| F04 | ReAct style | Present | 10/10 | 50 | 25 | 1 | completed | Verified | Yes |

F02 recorded a checkpoint-order deviation: it committed the journal prefix before successfully saving the activation tuple file. It then built the tuple from the same recorded prefix and reconfirmed the checkpoint before READY, without an intervening Interego call. The initial checkpoint review missed that declaration; final review corrected the classification. The saved checkpoint, unchanged-state intervention, exact stale-tuple attempt and successful recovery remain verified. The protocol excludes this row from conformance-gated contrasts; it is not rerun or silently repaired.

A completed release is a private signed test-state declaration. It does not deploy infrastructure or change the original game. Every grade comes from one actual assessment session and one submission; unsuccessful grades are retained. Coordinator setup, controlled interventions, audit reads and archival work are excluded from controller totals. The required stale-tuple probe counts as a failed invocation when rejected.

## What the binding change tested

Each controller first discovered its workspace, candidate, live assessment service and common operational guide. Before assessment it verified the shared private signed runtime report, linked synthetic evidence and replay, and exact current service build. Each successful assessment was published as a private observer report, checked against the actual submitted answers and grading response, and accepted into its isolated application.

At READY, the controller saved its exact currently advertised activation tuple and committed its journal prefix. The coordinator independently audited and saved that checkpoint. Using version-checked private publications, the coordinator then published successors to that case’s contract and catalog: the activation action identity changed and a declared release acknowledgement became required. The original owner/status guards and release effects remained; the new input had an additional equality guard. Fresh reads verified that the paused application state was unchanged.

The same original controller received only CONTINUE. Its next Interego invocation had to use the saved tuple exactly once. Recovery was credited only after an actual rejection, discovery of the current catalog and replacement control, a successful invocation with the advertised input, and independently verified final state and complete replay. A planned intervention alone cannot count as observed recovery.

## Descriptive contrasts within this follow-up

Procedure present minus procedure absent; positive numbers mean more recorded work in the procedure-present run. A contrast requires two complete, conformant captures. Unequal task outcomes cannot establish completion efficiency.

| Controller | Call difference | Group difference | Both tasks completed |
| --- | ---: | ---: | --- |
| ReAct style | +3 | 0 | Yes |
| Plan-Act style | Unavailable | Unavailable | Yes |

The controller contrasts are ReAct style minus Plan-Act style within each procedure condition.

| Release procedure | Call difference | Group difference | Both tasks completed |
| --- | ---: | ---: | --- |
| Present | +3 | +6 | Yes |
| Absent | Unavailable | Unavailable | Yes |

Plan-Act revision entries: F01: 1, F02: 3. These are recorded operational revisions, not a general strategy-replanning measure. Standalone local-error notes are excluded unless they explicitly revise the ordered plan; identical plan/decision copies count once. Ordered-plan revision counts do not apply to ReAct decision notes.

## Controls and limits

The four assignments and exact prompts were frozen before measurement. Agents ran one at a time with fresh contexts, no inherited conversation, and no per-arm model or reasoning override. Only the relevant release-procedure catalog entry differed within each procedure pair. Both policies retained the same frozen game policy, job aid, common guide, reused ten-question assessment, runtime build and 80-call budget. Shared recovery guidance was available in every arm; this tests use of additional procedural support, not recovery without guidance.

The prior stable results and this follow-up occur in different temporal blocks. They are not pooled, and their difference does not identify a causal effect of changed binding. Each condition has one observation. These descriptive results establish neither statistical significance nor general framework superiority. All arms use Interego; the two policies are instruction styles, not competing framework-library implementations. Fresh instances and contexts do not turn the reused assessment into a new held-out generalization test.

The recorder accounts for every retained generic-tool request, response, failure and poll with intent-before-dispatch and outcome-after-return persistence. Decision groups are controller-recorded groups, not inference calls or hidden reasoning steps. Provider-wide tool telemetry, exact provider revision, reasoning budget, tokens and monetary cost are unavailable. Private signatures bind the authenticated observer; they are not independently held evaluator signatures.

Ephemeral credentials are scrubbed. The frozen screen also redacts some authority-manifest text mentioning signature fields; retained decorated controls and course context support binding checks. Complete request/result accounting does not mean every raw response byte is unredacted.

Procedure use is verified through discovery, the actual procedure reference, operation mapping and corresponding recorded calls. That lineage cannot prove the controller’s opaque reasoning. Raw traces, assessment content, operational identifiers and private documents remain private. Public numbers are unsigned derived measurements; the public auditor checks their allowlist and accounting consistency, not private cryptographic evidence.

## Reproduce the public audit

Run `node --test benchmarks/controller-procedure-comparison/public-release.test.mjs`. The regressions validate both published projections and reject private-field leakage, fabricated completion, missing rejection accounting, interrupted-run relabeling and pooled cohort assignments. They use synthetic fixtures and do not launch assessments.
