# CRDT Offline Merge

When two agents edit the same descriptor on disconnected pods and
later reconnect, the result MUST converge — both pods end up with
the same merged descriptor, regardless of message order, without a
coordinator. CRDTs (Conflict-free Replicated Data Types) give us
this property at the data structure level.

## Status

**Design doc — Layer 2 pattern (forthcoming as `crdt:` ontology).**
The bridge to existing Interego primitives is sketched here. A
reference runtime (`src/crdt/`) is a planned follow-up.

## The problem

Today: two agents on disconnected pods both edit
`urn:cg:memory:meeting-notes`. Each pod records their version. On
reconnect, naive last-write-wins clobbers one. Users lose data.

What we want: reconnect → both versions merge automatically; no
data loss; same result regardless of which side reconnects first;
no human conflict resolution.

## Approach: descriptor-fragment-level CRDTs

Rather than CRDT-ing the entire descriptor (heavy, schema-coupled),
we apply CRDT semantics at the **fragment level**:

- A descriptor's mutable surface is its facets + payload triples.
- Each *facet* is its own CRDT according to its type:
  - **TemporalFacet** — Last-Writer-Wins (LWW) per field, with
    timestamp from the writer's pod.
  - **ProvenanceFacet** — Grow-only Set of `prov:wasDerivedFrom`
    citations + `prov:wasGeneratedBy` activities. (Adds only;
    citations don't get unmade.)
  - **AgentFacet** — LWW for the asserting agent (writer can change
    their AgentFacet, but not someone else's).
  - **AccessControlFacet** — Multi-Value Register: concurrent
    edits coexist as alternatives until manual resolution. Safer
    than LWW for security-relevant data.
  - **SemioticFacet** — modalStatus uses a special **modal-CRDT**
    derived from the existing ModalAlgebra (see below).
  - **TrustFacet** — Grow-only Set of attestations.
  - **FederationFacet** — LWW for the home pod URL; Grow-only Set
    for `cg:knownPods`.

## The modal-CRDT

The most interesting case. Two agents concurrently change a
descriptor's modal status:
- Agent A: Asserted → Counterfactual (claim retracted)
- Agent B: Asserted → Hypothetical (uncertainty introduced)

What's the merge?

**Use ModalAlgebra.meet**: the most-conservative interpretation.
`meet(Counterfactual, Hypothetical) = Counterfactual` (the lowest
on the lattice). Both agents see the safer outcome — neither's
reduction in confidence is overridden.

This is convergent because `meet` is **commutative + associative +
idempotent**, the three CRDT criteria. The modal lattice we already
ship is, by construction, a CRDT.

## Vector clocks for ordering

Fragment-level CRDTs need to identify "concurrent" vs "sequential"
edits. Each pod maintains a vector clock per descriptor. When pod A
publishes a new version of descriptor X, A's clock for X increments;
B's component is whatever A last knew about B.

On reconnect, comparing vector clocks tells us:
- **A → B happened-before:** apply A's edits then B's
- **B → A happened-before:** apply B's then A's
- **Concurrent:** apply CRDT merge per facet

Vector clocks are stored as a `crdt:VectorClock` blank node in the
descriptor's `cg:FederationFacet`.

## Vocabulary additions (`crdt:` namespace, planned)

```turtle
crdt:VectorClock a owl:Class ;
    rdfs:subClassOf cg:FederationFacet ;
    rdfs:comment "Per-pod vector clock for one descriptor's edit history. Used to detect concurrent vs sequential edits during merge." .

crdt:GrowOnlySet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    rdfs:comment "A facet whose elements are only added, never removed. Trivially convergent." .

crdt:LWWRegister a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    rdfs:comment "Last-Writer-Wins register, with timestamps from a logical or wall clock." .

crdt:MultiValueRegister a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    rdfs:comment "Concurrent edits coexist as alternatives; consumer chooses or resolves." .

crdt:ModalCRDT a owl:Class ;
    rdfs:subClassOf cg:SemioticFacet ;
    rdfs:comment "Modal status under CRDT semantics: concurrent edits are merged via ModalAlgebra.meet (most-conservative wins). Commutative + associative + idempotent by construction." .
```

## Reconcile algorithm

```
function reconcile(podA_descriptor, podB_descriptor):
    if vectorClocks_concurrent(A, B):
        merged = empty descriptor
        for each facet type T:
            merged.facets[T] = mergeFacet(A.facets[T], B.facets[T], T)
        merged.vectorClock = max(A.vectorClock, B.vectorClock)
        return merged
    elif A_happens_before(B):
        return B
    else:
        return A

function mergeFacet(facetA, facetB, type):
    return {
        Temporal: lwwMerge(facetA, facetB),
        Provenance: growOnlyMerge(facetA, facetB),
        Agent: lwwMerge(facetA, facetB),
        AccessControl: mvrMerge(facetA, facetB),
        Semiotic: modalMerge(facetA, facetB),  // ModalAlgebra.meet
        Trust: growOnlyMerge(facetA, facetB),
        Federation: federationMerge(facetA, facetB),
    }[type]
```

## Composition with existing primitives

- **cg:supersedes**: a CRDT-merged version supersedes both source
  versions. The merge is recorded as a new descriptor that cites
  both predecessors via `prov:wasDerivedFrom`.
- **passport:**: a successful CRDT merge is a `passport:LifeEvent`
  (kind: `merge-resolved`) for the agent who triggered the
  reconnect.
- **Conformance**: a CRDT-compliant implementation passes L2 plus
  a new optional L2 check (`L2.6 CRDT convergence`): given two
  divergent descriptor histories, any reconnect order yields the
  same merged descriptor.

## Honest limits

- **No deletes**: pure CRDTs are grow-only. To delete, mark with
  `cg:supersedes` to a tombstone; the tombstone itself doesn't get
  un-deleted. (Equivalent: state-based CRDT with a "deleted" flag
  that monotonically becomes true.)
- **Reference impl is non-trivial**: vector clocks across federated
  pods need either physical-time + bounded-skew assumptions, or
  per-pod logical clock plus mutual gossip. This spec defers the
  choice to the implementation.
- **Schema migration interacts**: if a CRDT-merged facet has fields
  the receiver's namespace version doesn't recognize, fall back to
  the schema-evolution `align:` bridge to translate.

## Why this matters

Real collaborative AI is multi-agent + sometimes-disconnected.
Without CRDTs:
- One agent's offline work overwrites another's after reconnect
- Users lose context
- Trust in the "shared memory" claim erodes

With CRDTs:
- Disconnected agents can keep working
- Reconnect is automatic + deterministic
- "Federated memory" actually behaves like one when it should and
  like a respectful merge when it shouldn't

## Implementation roadmap

1. **Phase 1 (v1):** vector clocks + grow-only sets for
   ProvenanceFacet + TrustFacet (90% of real cases). Single-pod
   semantics today; multi-pod converges deterministically.
2. **Phase 2 (v2):** modal-CRDT for SemioticFacet using
   ModalAlgebra.meet. LWW for Temporal/Agent.
3. **Phase 3 (v3):** Multi-value register for AccessControlFacet
   with explicit conflict-resolution UI hooks.
4. **Phase 4 (v4):** Tombstones for genuine deletion; schema-version-
   aware merge via the `align:` bridge.

Each phase ships independently. v1 alone solves the most common
offline-edit collision class.
