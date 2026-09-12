# ReAct, Plan–Act DAG, and Interego: measured pilot

The DAG controllers successfully batched dependent operations and used fewer
model decisions through both interfaces. All four configurations completed every
task. This pilot found no completion advantage attributable to Interego; its
local implementation performed more backend verification reads.

Run date: 12 September 2026. The original live game remained at version 14 with
the same descriptor and CID. No production resource was mutated or reset.

| Configuration | Completed | Mean model decisions | Mean tool calls | Mean backend reads |
|---|---:|---:|---:|---:|
| ReAct + conventional JSON | 8/8 | 10.875 | 9.625 | 60.75 |
| ReAct + Interego | 8/8 | 10.875 | 9.750 | 242.00 |
| Plan–Act DAG + conventional JSON | 8/8 | 3.750 | 9.250 | 60.75 |
| Plan–Act DAG + Interego | 8/8 | 3.375 | 9.250 | 242.00 |

Across interfaces, DAG averaged 3.5625 submitted model decisions per episode,
versus 10.875 for ReAct: 67.2% fewer. The plans were model-generated, with actual
data references executed by deterministic binders and replanning after failures.
Every observed execution was serial. No parallel speedup was measured.

The controller comparison intentionally gives ReAct one tool operation per
decision and DAG up to twelve. The result shows that batching worked successfully
under that definition. It does not establish a universal advantage over other
ReAct variants or measure the user's brother's actual implementation, which was
not available for this experiment.

## Tasks and recovery

The 32 episodes cover four scenarios, four configurations, and two initial board
states. These are initial-state variants, not stochastic model seeds or repeated
trials of each identical task. Each controller had to make exactly three moves,
choose the lowest legal position each time, preserve previous and concurrent
moves, and perform a fresh verified read after the last write.

| Scenario | Completed | Mean ReAct decisions | Mean DAG decisions |
|---|---:|---:|---:|
| Stable resources | 8/8 | 9.25 | 2.25 |
| Changed action identities and authority bindings | 8/8 | 11.75 | 4.00 |
| Concurrent authorised state change | 8/8 | 11.50 | 3.75 |
| Fresh controller after one committed move | 8/8 | 11.00 | 4.25 |

There were 96 task writes and eight competing writes. All task moves followed
the requested policy. All sixteen stale action attempts were rejected; no stale
or invalid write was accepted. Eight fresh replacement controllers continued
from durable task history, with their previous conversation and pending plans
discarded. The provider record identifies 40 distinct controller agents across
the 32 episodes and eight handoffs.

Seven ReAct decisions used invalid result-reference paths. Those errors and their
recovery steps remain in the transcripts and counts. No prompt was tuned after
seeing these errors, and no episode was dropped or rerun as a measured sample.

## What the interface comparison says

Both interfaces provided equivalent task information, legal controls, discovery,
durable receipts, signature verification, and stale-write protection. The
Interego path used the shipped resource composition and finite-board interpreter.
The conventional adapter did not load Interego modules. Both used the same
authoritative reducer and independent policy oracle.

The Interego composition source came from the recorded repository base. Its
workspace package imports used pre-existing local builds; resolved versions and
entry-point hashes are recorded in `runtime-provenance.json`. Those hashes are
not a complete dependency-tree attestation or a deployed-image comparison.

Interego averaged approximately 3.98 times as many backend reads. Median summed
local tool execution was 77–87 ms per Interego episode and 11–11.5 ms per JSON
episode. These figures describe local repeated verification work. They do not
measure Railway latency, network traffic, pricing, or production throughput.
Episode wall times include agent scheduling and orchestration and should not be
used as clean inference-latency comparisons.

The benchmark normalized native action representations into opaque handles and
required explicit reads in both interfaces. This controls the information given
to the model, but hides differences in raw MCP ergonomics and payload size.
Native error identifiers still differ. Integration effort and reusable-procedure
discovery were not measured. Neither interface required code changes during the
episodes; that observation does not measure their initial integration costs.

## Evidence and limits

The retained evidence contains 231 submitted model decisions, 303 protocol tool
attempts, their outcomes, authoritative state histories, and source hashes frozen
before the measured run. All 424 per-episode descriptor records passed the local
signature audit. Signatures use real Ed25519 verification on a benchmark-local
envelope, with reproducible public fixture keys. This is a local component test,
not full production protocol or identity verification. Registry success counters
are synthetic fixture priors, not observed learning or previous task performance.

A separate post-measurement reconstruction matched all 296 environment tool
outputs exactly, including action handles. It also matched the final inspections
after excluding timings and reverified 116 deduplicated reconstructed signed
descriptors with two exported public keys. The seven binder failures never
reached the environment. Reconstructed signatures are explicitly labelled;
original measured signature bytes were not retained. Reconstruction adds no
model episodes to the measured sample.

All agents inherited the same host model and settings without overrides, but
the exact provider snapshot, internal inference calls, token usage, and dollar
cost were unavailable. The enforced limits were 12 submitted decisions, 24 tool
attempts, and 24,000 serialized output bytes per episode decision. Provider-token
budgets were not enforceable. Two CLI probes timed out without a model completion;
the measured run used collaboration agents. Decision counts must not be relabelled
as billed API calls, token savings, or dollar savings.

This small, deterministic task set reached a success ceiling in every arm.
The modest DAG decision difference between the interfaces cannot establish an
Interego effect. There is no evidence here of general reasoning superiority,
model learning, or a benefit from sharing learned reusable procedures.

For the original architecture question, this is evidence that dependency plans
can execute and recover with fewer model decisions through either interface.
Interego's verified resource mechanisms compose with that controller pattern.
Their additional value needs a task that directly measures capability discovery
or reuse across applications, which this controlled execution pilot did not test.

## Recheck

- [Frozen protocol and execution instructions](README.md)
- [Aggregated results](results/pilot-20260912/summary.json)
- [Episode manifest](results/pilot-20260912/manifest.json) and individual `result.json` files in the corresponding case directories
- [Fresh-agent record](results/pilot-20260912/provider-agents.json)
- [Source freeze](protocol-freeze.json)
- [Independent transcript audit](results/pilot-20260912/audit-notes.json) and [runtime provenance](results/pilot-20260912/runtime-provenance.json)
- [Post-measurement reconstruction audit](results/pilot-20260912/replay-audit.json) and [reconstructed signed envelopes](results/pilot-20260912/replayed-descriptors.json)
- [Original game invariant](results/pilot-20260912/original-game-invariant.json)

`summarize.py` recomputes aggregates and checks scoring and agent-generation
coverage. `audit-replay.ts` verifies the frozen source hashes, deterministically
replays environment events, and checks their outputs and reconstructed signatures.
The focused test suite passed 23 tests; standalone strict TypeScript checks passed.
