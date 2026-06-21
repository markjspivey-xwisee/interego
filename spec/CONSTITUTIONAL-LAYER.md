# Constitutional Layer

A meta-protocol that lets a community of Interego participants
amend the protocol they themselves operate under, in-protocol.
The protocol becomes self-amending — like Ethereum's EIPs but
enforced by descriptors + ABAC, not by social process alone.

## The core move

Policies are already first-class descriptors (`iep:AccessControlPolicy`).
A **constitutional policy** is a policy that governs *which other
policies can be enacted, amended, or retracted*. It's a meta-policy.
The community publishes constitutional policies; subsequent policy
changes are validated against them.

Result: nobody can unilaterally change the rules, but everyone can
propose changes through the protocol-defined process.

## Levels

A community deploys constitutional layers in tiers. Higher tiers are
harder to change (require broader consensus). Mirrors how real
constitutions work — bill of rights vs ordinary statute.

```
Tier 0  — bedrock      : the Interego spec itself; only changes via spec process
Tier 1  — constitution : community charter, governance process, supermajority required
Tier 2  — bylaws       : standing rules; majority required
Tier 3  — policy       : day-to-day operational policies; quorum required
Tier 4  — preference   : individual settings; agent-level only
```

When a policy is proposed for enactment:
1. Identify which tier it belongs to.
2. Find the constitutional policies at the same tier or higher.
3. Run the proposed policy through each higher-tier policy as an
   ABAC predicate — does the proposal satisfy the constraints those
   policies impose?
4. If yes, the proposal is *valid*. Whether it *passes* depends on
   the voting mechanism the constitution defines (see §Voting).

## Vocabulary additions (iep:)

```turtle
iep:ConstitutionalPolicy a owl:Class ;
    rdfs:subClassOf iep:AccessControlPolicy ;
    rdfs:comment "A policy that governs other policies. Carries a tier (iep:tier) and an amendment process (iep:amendmentProcess)." .

iep:tier a owl:DatatypeProperty ;
    rdfs:domain iep:ConstitutionalPolicy ;
    rdfs:range xsd:integer ;
    rdfs:comment "Tier 0..4. Higher tier policies govern lower tier policies." .

iep:amendmentProcess a owl:ObjectProperty ;
    rdfs:domain iep:ConstitutionalPolicy ;
    rdfs:comment "Reference to the process descriptor describing how this policy itself can be amended (vote threshold, quorum, ratification window, etc.)." .

iep:Amendment a owl:Class ;
    rdfs:subClassOf iep:ContextDescriptor ;
    rdfs:comment "A proposed change to a constitutional policy. Carries the diff (added/removed/modified rules), the proponent, and the ratification status." .

iep:ratificationVote a owl:ObjectProperty ;
    rdfs:domain iep:Amendment ;
    rdfs:comment "A descriptor recording one ratification vote on this amendment. Composes via ModalAlgebra (Asserted=for, Counterfactual=against, Hypothetical=abstain)." .

iep:ratifiedAt a owl:DatatypeProperty ;
    rdfs:domain iep:Amendment ;
    rdfs:range xsd:dateTime ;
    rdfs:comment "Instant ratification became effective. Before this, the amendment is a proposal; after, it is law." .
```

## Voting

The constitution itself defines voting rules. Common patterns:

**Simple majority:**
```
ratifyIf:
  count(votes where modalStatus=Asserted) > count(votes where modalStatus=Counterfactual)
  and quorum >= constitution:minQuorum
```

**Supermajority (Tier 1 changes):**
```
ratifyIf:
  count(Asserted) / count(non-abstain) >= 0.67
  and quorum >= constitution:minSupermajorityQuorum
```

**Time-locked ratification (cooling period):**
```
ratifyIf:
  vote-passes
  and now > proposedAt + constitution:coolingPeriod
```

These compose: a Tier 1 amendment requires supermajority *AND* a
cooling period. A Tier 2 needs majority *AND* a quorum. Each is
expressed as an ABAC `iep:AccessControlPolicy` over the amendment's
descriptor + the votes attached to it.

## Forks

Crucially, dissenters can *fork* — refuse to ratify, publish their
own constitution, migrate. Forks are a feature: agents whose values
are no longer represented in the majority constitution can move to
a sibling pod governed by their preferred constitution. The federation
is partition-tolerant.

A fork is recorded as a `passport:LifeEvent` of type
`infrastructure-migration`, citing the new constitution. Other agents
can audit the fork's lineage and decide whether to recognize it.

## Implementation

`src/constitutional/` provides:
- `proposeAmendment(constitution, diff, proponent)` → `Amendment`
- `vote(amendment, voter, modalStatus)` → records a vote descriptor
- `tryRatify(amendment, constitution, allVotes)` → `'Ratified' | 'Rejected' | 'PendingQuorum'`
- `forkConstitution(parentConstitution, dissenters, newRules)` → `Constitution`

All built on existing `iep:AccessControlPolicy` + `ModalAlgebra` +
`passport:` primitives. No new L1 protocol machinery required.

## What this enables

- **Autonomous communities of agents** govern themselves without a
  human-operated "platform."
- **Splintering with grace** — when a community can no longer agree,
  the fork is a recognized protocol move with audit trail, not a
  rage-quit with data loss.
- **Genuine decentralization** — no single party can change the rules,
  including the original protocol designer.

## Honest limits

- Fully Byzantine-fault-tolerant ratification (where adversaries
  publish conflicting votes from the same identity) requires
  off-protocol mechanisms (witness servers, time-stamping, key
  rotation policies).
- Liquid democracy / delegate voting is a future extension.
- Adversarial sybil-resistance for constitutional voting must be
  layered on top via the existing `filterAttributeGraph` pattern from
  ABAC — the constitution can require that voters meet a trust threshold
  before their vote counts.
