# Controller × resource interface pilot

This experiment compares ReAct and a model-generated Plan–Act DAG through either
a conventional JSON adapter or the shipped Interego resource composition.
It is a local component pilot, not a Railway latency benchmark or a measurement
of an unseen third-party implementation.

## Frozen protocol

Four scenarios × four configurations × two initial-state seeds = 32 episodes.
The scenarios are a stable workflow, coherent action/contract rebinding after
the first observation, a competing authorised write after that observation, and
a fresh controller handoff after the first task write. Initial boards are empty
or contain an existing X in the last cell. Every controller must make exactly
three task moves, selecting the lowest legal position each time, preserve prior
and concurrent moves, and read back the final verified state.

Each episode uses a fresh collaboration agent with no inherited conversation.
Handoff creates another fresh agent. All agents inherit the same host model and
settings; an exact provider snapshot, temperature and billing usage are not
exposed. Every episode has at most 12 submitted model decisions, 24 tool calls,
and 24,000 serialized bytes per decision. Provider token budgets and internal
inference-call counts cannot be enforced or measured here. Reports use **model
decision requests**, never an invented API-call or token count. Two configured
CLI inference probes produced no completion; see `provider-probe.json`.

ReAct submits at most one tool operation per decision. DAG submits at most 12
nodes with explicit dependencies and references to prior results. The runner
executes deterministic references, supports parallel independent reads, stops a
plan on errors, and requests a new model decision. It contains no model-shaped
answer table or scripted controller. Both can use the same deterministic
references and durable memory. Prompts are fixed before measured episodes;
failures are retained and are not used to tune prompts.

## What is controlled

Both arms have the same authoritative board reducer, durable task receipts,
discovery information, legal controls, Ed25519 verification, content addressing,
CAS semantics, initial states, task goals, and budgets. No reset is exposed.
Their normalized model-visible schemas match. Opaque tokens preserve the exact
native action tuple internally; the Interego arm calls the shipped
`ResourceCompositions` and finite-board interpreter. The baseline path does not
load Interego modules. Action names and bindings can evolve in both arms.

Signatures are verified with real Node Ed25519 operations on a benchmark-local
descriptor envelope. Keys are public reproducible fixtures. This is not a claim
of full production protocol or identity verification. Registry evidence counts
are synthetic fixture data, not measured prior success or learning.

The adapter normalizes verbose native representations and discards returned
post-write controls in both arms. This deliberately controls information and
exposure, but means the pilot **does not measure** raw MCP ergonomics, integration
effort, general capability discovery, network transport, or reuse of learned
procedures. Backend reads are counted to show work hidden behind a tool call.

## Run and inspect

With repository dependencies installed and package builds available:

```sh
node --import tsx --test benchmarks/controller-surface/*.test.ts
node --import tsx benchmarks/controller-surface/run.ts /absolute/new/result-directory 0,1
```

The runner starts four independent episodes at a time and writes a pending
decision mailbox for each. Give a fresh same-model agent only the case directory
and this transport instruction: use `agent-client.mjs CASE_DIR GENERATION` to read
the current prompt, then pipe the JSON decision to
`agent-client.mjs CASE_DIR GENERATION REQUEST_NUMBER`. Continue until `DONE` or
`HANDOFF`; on handoff replace the agent rather than retaining its context. Do not
read environment source or other episodes while acting as a controller. Record
each agent identity and generation in the provider sidecar.

Existing case directories are rejected to prevent replayed responses from being
miscounted as fresh model decisions. `result.json` records every submission,
action, outcome, timing, verified descriptor audit, and the independent oracle.
Malformed decisions and failed episodes remain in the result set. Completion
requires the authoritative policy, three writes, zero invalid/stale accepted
writes, verified durable descriptors, and the final fresh read.

Elapsed decision time includes orchestration and scheduling. Local tool time and
backend reads are reported separately. Dollar cost and token usage remain null.
The small deterministic board tasks support limited conclusions about execution
and recovery; they cannot establish general reasoning superiority or learning.
