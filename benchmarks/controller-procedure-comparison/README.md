# Controller policy and discoverable procedure comparison

Layer 3, non-normative empirical report. Protocol 2.0.0; September 2026.

The four changed-binding conditions were subsequently measured in a [separate prospective follow-up](followup.md), protocol 2.1.0. The frozen cohort below and its `results.json` remain unchanged; the follow-up has its own measurements and within-cohort contrasts.

3 of 5 started isolated test releases completed. Of eight planned assignments, 1 was blocked, 1 was interrupted and 3 were not started. The retained record contains 201 Interego invocations across 88 decision groups, 1 failed invocation and 0 recorded transport exceptions. 4 controller captures are closed and complete; those 4 cases conform to the recorded protocol. This cohort stopped early.

The experiment crosses two controller instruction policies, presence or absence of a discoverable release procedure, and stable or changed activation bindings. Every arm uses Interego. ReAct style and Plan-Act style describe the operational instructions below; no external framework library is being benchmarked.

## Observed runs

| Run | Controller | Release procedure | Assigned binding | Grade | Retained calls | Groups | Failed calls | Outcome |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 01 | ReAct style | Present | Stable | 10/10 | 45 | 20 | 0 | completed |
| 02 | ReAct style | Absent | Stable | 10/10 | 40 | 20 | 0 | completed |
| 03 | Plan-Act style | Absent | Stable | 10/10 | 44 | 18 | 0 | completed |
| 04 | Plan-Act style | Present | Stable | 9/10 | 37 | 15 | 1 | blocked |
| 05 | Plan-Act style | Present | Changed | 10/10 | 35 | 15 | 0 | interrupted |
| 06 | Plan-Act style | Absent | Changed | No grade | 0 | 0 | 0 | not-started |
| 07 | ReAct style | Absent | Changed | No grade | 0 | 0 | 0 | not-started |
| 08 | ReAct style | Present | Changed | No grade | 0 | 0 | 0 | not-started |

Run 05 reached its saved READY checkpoint after a 10/10 assessment and verified evidence acceptance. The preceding chat reached its length limit, and the original controller was absent from the next chat. Its 35-call, 15-group journal is complete through that checkpoint, with no unresolved recorded operation. There is no final controller seal, delivered CONTINUE, activation, replacement controller or repeated assessment. The signed application remains at evidence-accepted with a verified two-link replay.

The frozen context-loss rule stopped the cohort for reconciliation. Runs 06-08 remain unstarted. No changed-binding intervention occurred, so this cohort supplies no observation of stale-binding rejection or recovery. A planned changed condition in the table is not an executed intervention. The user reported chat length exhaustion; the evidence does not establish a network failure. Live reconciliation also confirmed the original game, engine, action contract, registry and release catalog were unchanged.

The 9/10 result in run 04 was retained as a blocked result. That controller did not accept failed evidence or activate a release. Its one failed invocation used the wrong argument name on a read and was corrected with a recorded retry. The four recorded plan-revision entries are operational corrections, not four strategy replans.

All rows, including incomplete or unsuccessful cases if present, are retained in `results.json`. A passing grade requires all ten answers correct. A release is a signed test application state declaration, with no infrastructure deployment or original-game effects. Coordinator setup, interventions, independent audit reads and archiving are excluded from agent counts.

Recorded Plan-Act revision entries: run 03: 0, run 04: 4, run 05: 0, run 06: unavailable. ReAct-style ordered-plan revision counts are not applicable. Entries can describe corrections to a planned step's arguments or response interpretation; they do not necessarily change the overall sequence or strategy. Standalone local-error reports without a plan-revision entry are excluded.

## Descriptive differences

The following differences are procedure present minus procedure absent within the same controller and binding condition. A positive value means the procedure-present run used more recorded calls or groups. Differences are available only when both captures are complete and both cases conform. If one task stopped before completion, the difference compares work performed through unequal outcomes and cannot be interpreted as a completion-efficiency advantage.

| Controller | Binding | Call difference | Group difference | Both tasks completed |
| --- | --- | ---: | ---: | --- |
| ReAct style | Stable | +5 | 0 | Yes |
| Plan-Act style | Stable | -7 | -3 | No |
| ReAct style | Changed | Unavailable | Unavailable | No |
| Plan-Act style | Changed | Unavailable | Unavailable | No |

The matched controller differences below are ReAct style minus Plan-Act style. They compare instruction policies on this task; they do not estimate a general framework advantage.

| Release procedure | Binding | Call difference | Group difference | Both tasks completed |
| --- | --- | ---: | ---: | --- |
| Present | Stable | +8 | +5 | No |
| Present | Changed | Unavailable | Unavailable | No |
| Absent | Stable | -4 | +2 | Yes |
| Absent | Changed | Unavailable | Unavailable | No |

## Prospective method

ReAct-style controllers select the next action or independent read group from the latest observed result and save a short decision summary before dispatch. They do not precommit an ordered execution plan. Plan-Act-style controllers save an ordered plan with checkpoints before their first external call, then revise a remaining step only when observed information or a failed precondition invalidates it. Both policies save operational summaries, not private reasoning transcripts.

The protocol, exact prompts, workspace assignments and source commitments were frozen before measurement. One fresh controller was started at a time, without inherited conversation or per-arm model/reasoning overrides. Each started at a neutral workspace and discovered its resources. The same requested model configuration, task semantics, frozen game policy, native job aid, common guide and ten-question assessment apply across arms. Only the applicable release procedure entry differs within each matched procedure pair. The assessment is reused; fresh task instances and contexts do not make it a new held-out test.

The fixed order appears in the table. Procedure presence is scheduled first in one stable and one changed pair, and second in the other two pairs. This is counterbalancing in a small convenience sample, without random sampling, repeated observations within a cell or a statistical significance test.

Before launching an assessment, each controller checks the private signed runtime preflight, its linked synthetic evidence and replay, and the required current service build. The preflight supplies infrastructure evidence without assessment answers. It cannot guarantee later network or host availability. Every new publication and state change requires its own recorded verification.

The task budget is 80 generic Interego invocations, one successful assessment launch and one graded submission per case. Reads, signing, publication-status polls, authority failures and retries count. Unknown mutation outcomes prohibit replay. If a measured context disappears or an outcome is missing, the protocol stops the cohort for reconciliation and prohibits replacement controllers or invented continuations.

The planned checkpoint protocol requires the controller to save its current activation tuple and journal commitment after evidence acceptance, then return READY. The coordinator verifies and saves the checkpoint before sending only CONTINUE to the same controller; the next invocation must attempt the saved tuple exactly once. This completed in the three successful stable cases. The planned changed-case intervention would first create a version-checked contract/catalog successor changing the action identity and requiring an acknowledgement, while preserving paused state and release effects. No such intervention was executed in this cohort.

0 runs have a verified stale-binding rejection and subsequent recovery. An assigned changed condition alone is not evidence that an intervention or recovery occurred; the separate fields in `results.json` record what was verified.

## Accounting and evidence limits

The mandatory recorder commits an intent before dispatch and an exact request-bound, credential-scrubbed result or exception after return. Checkpoint commitments are nonterminal; final seals close the journal. Complete capture means the mandatory journal and retained controller records reconcile. The frozen credential screen can redact authority-manifest text that mentions signing-field names; decorated controls remain recorded. Complete accounting therefore does not mean every response byte is unredacted. It does not establish independent provider-wide telemetry, an ACL boundary between same-owner agents or absence of undisclosed activity.

A decision group is a set of operations selected together. It is not a model inference count, token count, monetary cost, reasoning-quality score or latency measure. Tool counts exclude local decoding, hashing, serialization and coordinator work, so this study does not measure total operating cost. Actual provider revisions, token usage and monetary costs are not exposed.

Independent coordinator review checks the actual launch, submitted answers and grade correspondence; frozen candidate and suite commitments; private observation and final current-state references; complete receipt replay; procedure discovery and declared use mapping; ordered plans or observed decisions; checkpoint delivery; and every recorded failure or deviation. Signature and confidentiality checks rely on retained relay responses. Procedure use is supported by discovery and corresponding operations, without proof of opaque internal reasoning.

Public data are unsigned derived measurements constructed through a strict field allowlist. They contain counts, enumerated assignments and generic call rows. Raw requests, private payloads, operational identifiers, assessment content and signing credentials are withheld. Public arithmetic is inspectable, but the public files cannot independently authenticate the private evidence.

One observation per cell, fixed order, a reused assessment and a single-owner environment limit the conclusions. The results support the reported outcomes and descriptive contrasts; they do not establish general efficiency, causal superiority, perfect game play or comparative performance against another framework implementation.

The earlier [live procedure-discovery study](../live-procedure-discovery/README.md) remains a separate historical cohort, including its incomplete captures. Its outcomes and protocol were not rewritten or pooled into these results.

## Recheck the public measurements

Run `node benchmarks/controller-procedure-comparison/audit.mjs` to validate the public field allowlist, counts, grades, capture scopes and available differences. Run `node --test benchmarks/controller-procedure-comparison/public-release.test.mjs` for synthetic regressions. These checks validate the unsigned projection; they do not authenticate private evidence or rerun an assessment.
