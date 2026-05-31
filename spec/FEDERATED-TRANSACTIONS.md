# Federated Transactions

When an action requires writes to multiple pods to succeed
together-or-not-at-all, Interego provides a saga-pattern transaction
protocol. This is the federated equivalent of database transactions —
no central coordinator, atomicity through compensating actions.

## Status

**Layer 1 spec, runtime stub.** Reference implementation in
`src/transactions/` covers the local-multi-pod case (single
coordinator, multiple participants). Full Byzantine-fault-tolerant
multi-coordinator transactions are out of scope; not all pods are
expected to participate in every transaction class.

## Why not 2PC?

Two-phase commit requires participants to hold locks during the
voting phase. Cross-pod, that's: every pod blocks reads against its
descriptors until the coordinator commits or aborts. Slow under
network partitions and prone to coordinator failure. Sagas trade
isolation for availability — each step commits independently, with
explicit compensation if a later step fails.

## The protocol

A `cg:Transaction` is itself a `cg:ContextDescriptor` carrying:

```turtle
<urn:txn:42> a cg:Transaction ;
    cg:txnState cg:TxnPending ;
    cg:hasStep <urn:txn:42/step-1>, <urn:txn:42/step-2>, <urn:txn:42/step-3> ;
    cg:txnIsolation cg:ReadCommitted ;
    cg:txnCoordinator <urn:agent:alice> .

<urn:txn:42/step-1> a cg:TransactionStep ;
    cg:targetPod <https://pod-a.example/> ;
    cg:forwardAction <urn:action:publish-descriptor-A> ;
    cg:compensatingAction <urn:action:retract-descriptor-A> ;
    cg:stepOrder 1 ;
    cg:stepState cg:StepCommitted .
```

Each step has:
- **forward action:** the operation that achieves the desired effect on the target pod
- **compensating action:** the operation that undoes it, idempotent under retry

Transactions execute steps in `cg:stepOrder`. If any step fails:
1. Mark step as `cg:StepFailed`.
2. Walk completed steps in reverse, executing each `compensatingAction`.
3. Mark transaction as `cg:TxnAborted`.

If all steps succeed:
1. Mark transaction as `cg:TxnCommitted`.
2. Optionally publish a `cg:TransactionLog` summary descriptor.

## Resumable execution: publish-before-execute convention

A saga that exists only in coordinator memory is not recoverable — if
the coordinator crashes between step 2 and step 3, no other process
(including the same process after restart) can tell whether step 2's
side effects need compensating or step 3 just needs resuming. This
section specifies a convention that makes sagas first-class descriptors
on the coordinator's own pod, so crash recovery is just another tick of
the agent's normal discovery loop.

The convention reuses existing primitives only: `cg:modalStatus`,
`cg:supersedes`, the `Provenance` facet, the saga forward/compensation
pair already defined above, and the standard discovery filter. There
is no new ontology and no new protocol — only the requirement that
every runtime publish at the same points so the recovery story is
uniform across coordinators.

### The pattern

Before calling `executeTransaction(saga)`, the coordinator SHOULD
publish the saga itself as a `cg:Transaction` descriptor to its own
pod, with:

- `cg:modalStatus` set to `"Hypothetical"` — the saga is in flight
  and its outcomes are not yet asserted.
- A `Provenance` facet whose `wasGeneratedBy` cites the coordinator
  DID and whose `generatedAtTime` records the begin instant.
- The full step list — including each step's `cg:targetPod`,
  `cg:forwardAction`, `cg:compensatingAction`, and `cg:stepOrder` —
  embedded as the graph payload, so any reader can reconstruct the
  saga without out-of-band knowledge.

This descriptor is the saga's durable shadow. From this point on the
coordinator MAY crash without losing recovery information.

### On successful completion

When `executeTransaction` returns a `Committed` `TxnResult`, the
coordinator SHOULD publish a follow-up descriptor that:

- Sets `cg:supersedes` to the in-flight descriptor's IRI.
- Sets `cg:modalStatus` to `"Asserted"` — the saga's outcomes are
  now claimed truth.
- Records each step's terminal `cg:stepState` (`cg:StepCommitted` for
  all, by construction) and the `durationMs` returned by
  `executeTransaction`.

A reader scanning the coordinator's pod sees the in-flight descriptor
as superseded and the new one as the authoritative record.

### On crash and restart

On the next tick after restart, the coordinator's discovery loop runs
its standard scan (e.g. `discover_context` or `discover_all`) with a
filter for descriptors that are both `cg:modalStatus = "Hypothetical"`
and not `cg:supersedes`'d by any later descriptor. Any matches are
in-flight sagas owned by this coordinator that did not reach a
terminal state. For each such saga the coordinator MUST:

1. Read the saga descriptor's payload to reconstruct the step list,
   target pods, and the forward / compensation pair for every step.
2. For each step in `cg:stepOrder`, probe the target pod for the
   observable side effect that the forward action would produce (a
   published descriptor at a known IRI, a registry entry, an
   attestation). This determines `done` / `not-done` per step
   without trusting any in-memory state.
3. Decide one of:
   - **Resume forward** if every done step is a contiguous prefix
     and the remaining steps are still viable. Continue executing
     from the first `not-done` step.
   - **Compensate** if any done step's invariant can no longer hold
     (target pod unreachable, downstream policy changed, isolation
     level requires it), or if the operator's policy is "on restart,
     always abort in-flight." Walk done steps in reverse order
     executing each `compensatingAction`.
4. On final resolution, publish the superseding descriptor:
   - `cg:modalStatus = "Asserted"` if the resume completed.
   - `cg:modalStatus = "Counterfactual"` if compensation completed —
     the saga's intended effects were rolled back and the descriptor
     records what was attempted, not what holds.

Both forward actions and compensating actions are already required
to be idempotent (see "The protocol"), so re-running a step that
turns out to have committed is safe.

### Why this composition works without new primitives

- `cg:modalStatus` already distinguishes in-flight (`"Hypothetical"`)
  from committed (`"Asserted"`) and rolled-back (`"Counterfactual"`).
- `cg:supersedes` already gives "this descriptor replaces the prior"
  semantics, so the terminal descriptor cleanly retires the
  in-flight one.
- The `Provenance` facet already records actor and time, so the
  audit trail is the same shape as any other descriptor.
- The saga forward / compensation pair is already specified in "The
  protocol" and implemented in `src/transactions/index.ts`.
- The discovery filter for "Hypothetical and not superseded" is
  already supported by the standard `matchesFilter` on
  `cg:modalStatus` plus a `cg:supersedes` absence check.

Result: zero new protocol surface. This section is a written
convention so that every coordinator publishes at the same points
and every reader (recovering or external) sees the same shape.

### Concrete example

A coordinator runs a three-step saga: "publish a credential to
pod A, notify pod B, update a registry entry on pod C."

**Phase 0 — before execution.** Coordinator publishes
`<urn:txn:credential-issue-42>` to its own pod:

```turtle
<urn:txn:credential-issue-42> a cg:Transaction, cg:ContextDescriptor ;
    cg:modalStatus "Hypothetical" ;
    cg:txnState cg:TxnPending ;
    cg:txnCoordinator <did:web:alice.example> ;
    cg:txnIsolation cg:ReadCommitted ;
    cg:hasStep <urn:txn:credential-issue-42/step-1>,
               <urn:txn:credential-issue-42/step-2>,
               <urn:txn:credential-issue-42/step-3> ;
    prov:wasGeneratedBy <did:web:alice.example> ;
    prov:generatedAtTime "2026-05-30T14:02:11Z"^^xsd:dateTime .

<urn:txn:credential-issue-42/step-1> a cg:TransactionStep ;
    cg:targetPod <https://pod-a.example/> ;
    cg:forwardAction <urn:action:publish-credential> ;
    cg:compensatingAction <urn:action:retract-credential> ;
    cg:stepOrder 1 ; cg:stepState cg:StepPending .
# … step-2 (notify pod B), step-3 (registry update on pod C) analogous
```

**Phase 1 — execution.** `executeTransaction` runs step 1 (pod A
accepts the credential publish), then step 2 (pod B accepts the
notification). The coordinator process is killed before step 3.

**Phase 2 — readers see in-flight.** A federated reader scanning
Alice's pod sees `<urn:txn:credential-issue-42>` with
`cg:modalStatus "Hypothetical"` and no superseding descriptor —
they treat the saga's effects as not yet asserted.

**Phase 3 — restart.** Coordinator process restarts. Its discovery
loop's first tick finds the Hypothetical, non-superseded saga.
It probes pod A (credential is present), pod B (notification is
present), pod C (registry entry is absent). Contiguous-prefix
check passes: it resumes from step 3, which succeeds. It publishes:

```turtle
<urn:txn:credential-issue-42/result> a cg:Transaction, cg:ContextDescriptor ;
    cg:modalStatus "Asserted" ;
    cg:supersedes <urn:txn:credential-issue-42> ;
    cg:txnState cg:TxnCommitted ;
    cg:hasStep <urn:txn:credential-issue-42/step-1>,
               <urn:txn:credential-issue-42/step-2>,
               <urn:txn:credential-issue-42/step-3> ;
    prov:wasGeneratedBy <did:web:alice.example> ;
    prov:generatedAtTime "2026-05-30T14:08:47Z"^^xsd:dateTime .
# each step now carries cg:stepState cg:StepCommitted
```

**Phase 4 — readers see the result.** The same federated reader's
next scan sees the in-flight descriptor as superseded and the new
descriptor as `"Asserted"`. If instead the operator's policy had
been "abort on restart," Phase 3 would have compensated step 2
then step 1, and the superseding descriptor would carry
`cg:modalStatus "Counterfactual"` with `cg:txnState cg:TxnAborted`.

### Cross-references

- [`src/transactions/index.ts`](../src/transactions/index.ts) — the
  `executeTransaction` primitive, the `Transaction` and
  `TransactionStep` shapes, and the in-order / reverse-compensate
  semantics this convention shadows.
- [`docs/PERSISTENT-AGENT-LOOP.md`](../docs/PERSISTENT-AGENT-LOOP.md)
  — the coordinator heartbeat that runs discovery each tick and is
  the natural place to pick up `Hypothetical`, non-superseded saga
  descriptors as in-flight work to resume or compensate.

## Isolation levels

- **`cg:ReadUncommitted`** — readers may see in-progress writes. Cheapest. Acceptable when atomic visibility doesn't matter (e.g., logging).
- **`cg:ReadCommitted`** — readers see only committed data. Each pod marks pending writes invisible until the transaction's `cg:txnState` becomes `cg:TxnCommitted`. Default.
- **`cg:RepeatableRead`** — within a transaction, repeated reads of the same descriptor return the same value. Implementation: snapshot descriptor versions at transaction start.
- **`cg:Serializable`** — no concurrent transactions can see each other's effects. Highest cost; requires either single-coordinator scheduling or distributed conflict detection.

## Failure modes

- **Coordinator crashes mid-transaction:** the transaction descriptor on the coordinator's pod records committed steps. On recovery, replay or compensate.
- **Participant pod unreachable:** retry with backoff. After threshold, abort + compensate.
- **Compensating action also fails:** raise a `cg:TxnPartialAbort`. Manual reconciliation required. The transaction descriptor records exactly which steps committed and which compensations failed, so the situation is auditable.
- **Network partition splits coordinator from participants mid-commit:** the coordinator's view becomes the authority. Participants that committed after losing contact may need to reconcile when the partition heals.

## Composition with other primitives

- **ABAC:** transactions can carry their own `cg:AccessControlPolicy`; only authorized agents can begin or compensate.
- **cg:supersedes:** a committed transaction's effects on a descriptor are recorded as a supersession with the transaction IRI as the cause.
- **AMTA attestations:** an attestor can certify that a particular transaction completed correctly; useful for high-stakes workflows.
- **Capability passport:** a successful transaction is a `passport:LifeEvent` for the coordinator.

## What this enables

- **Cross-pod review workflows:** "merge PR" transaction writes the merge marker to repo-pod, the audit trail to logging-pod, and the reviewer-credit to reviewer-pod, all atomic.
- **Multi-party agreements:** "contract sign" writes A's signed copy to A's pod, B's signed copy to B's pod, and the bilateral agreement to a witness pod, all-or-nothing.
- **Capability acquisition:** "agent earns capability" writes the proof descriptor to the agent's pod, the attestation to the attestor's pod, and updates the registry — committed together.

## Reference runtime

`src/transactions/` provides:
- `createTransaction(steps, coordinator)` → `Transaction`
- `executeTransaction(txn)` → `TxnResult` (Committed | Aborted | PartialAbort)
- `compensate(txn)` → reverses committed steps in reverse order
- `transactionStatus(txn)` → snapshot of where each step is
