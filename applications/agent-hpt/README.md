# Agent HPT — Human Performance Technology applied to AI agents

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** This is one of many possible verticals. The Interego protocol does not depend on this; this is one way to use it.
>
> Status: Working Draft. Layer: application-over-L3. Vocabulary in this document (`agent-hpt:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/agent-hpt.ttl`](ontology/agent-hpt.ttl).

## What this is

A pattern for treating AI agents the way an L&D / performance consulting practice treats humans: capability registration, performance observation, multi-axis evaluation, intervention design, and credentialed promotion — all on a substrate the agent itself owns and carries across deployments.

The substrate is Interego. The framework is Human Performance Technology (HPT) — Gilbert's Behavior Engineering Model, Rummler-Brache process improvement, Mager-Pipe analysis. The novelty is composition: every existing piece this vertical needs already exists in Interego's L2/L3 layer; we are documenting how they combine into a coherent agent-management practice.

## Why this is interesting

Today's agent stacks treat each agent as a stateless tool-caller plus a system prompt. There is no biographical record of what the agent knows, no portable evidence of what it has demonstrated, no peer / supervisor evaluation surface, no governed promotion path, and no cross-org credentialing. Agents are black boxes that are evaluated only by the org that runs them, in the moment, against opaque criteria.

Treating agents as performers in a managed workforce — with portable performance records, peer attestations, knowledge maturity tracking, and capability gating — gives an organization observability and governance over its agents the way it has over its people. The agent's own pod becomes its career file.

## The HPT framework, briefly

Gilbert's Behavior Engineering Model identifies six categories of performance influence. Mager-Pipe asks "if you held a gun to their head, could they perform?" to discriminate skill gaps from knowledge gaps from environmental gaps. Both are direct mappings to questions you'd ask about an agent.

| HPT category | Question for a human | Question for an agent |
|---|---|---|
| Information & Feedback | Do they know what's expected? Do they get feedback? | Is the system prompt clear? Do tool results / evals close the loop? |
| Tools & Resources | Do they have what they need? | Are the right MCP tools / pods / API keys provisioned? |
| Incentives | Are rewards aligned with desired behavior? | Is the system prompt + framing aligned with the goal? |
| Knowledge & Skills | Have they been trained? Demonstrated competence? | Has the agent ingested the relevant knowledge? Demonstrated the capability? |
| Capacity | Can they physically do it? | Does the model class / context window / rate limit support the task? |
| Motives | Do they want to? | Does the agent's framing/values align? |

Performance gap = desired performance − actual performance. The HPT loop diagnoses *which category* is the cause, designs an intervention targeted at that category, applies it, observes the result.

## Mapping HPT to Interego primitives

Every HPT artifact corresponds to existing Interego machinery — no protocol changes required.

| HPT artifact | Interego primitive | Where defined |
|---|---|---|
| Capability spec (what the agent can demonstrably do) | `agent-hpt:Capability` (vertical-scoped) wrapping `cg:ContextDescriptor` with `cg:Affordance` for invocation + `cg:SemioticFacet` for criteria | This vertical |
| Knowledge maturity (Tacit → Articulate → Collective → Institutional) | [`olke.ttl`](../../docs/ns/olke.ttl) — already exists | L3 |
| Tools & permissions | `cg:Affordance` + `abac:Policy` ([`abac.ttl`](../../docs/ns/abac.ttl)) | L1 + L2 |
| Performance observation (one action) | [`hela:Statement`](../../docs/ns/hela.ttl) — xAPI Statement (actor / verb / object / result / context / timestamp) | L3 |
| Performance evaluation (a judgment) | [`amta:Attestation`](../../docs/ns/amta.ttl) — multi-axis (competence / honesty / relevance / recency) | L3 |
| Capability biography (career file) | [`passport.ttl`](../../docs/ns/passport.ttl) — life events, demonstrated values | L2 |
| Public credentials (cross-org) | [`registry.ttl`](../../docs/ns/registry.ttl) — federated agent attestation registry | L2 |
| Audit trail / governance evidence | [`src/compliance/`](../../src/compliance/) + framework controls (e.g., `soc2:CC2.3` "commitment to competence" maps directly to L&D governance) | L3 |
| Intervention (change made to address a gap) | `agent-hpt:Intervention` (vertical-scoped) wrapping `cg:ContextDescriptor` with `prov:wasDerivedFrom` linking to the gap descriptor | This vertical |
| Periodic review (synthesis of observations + attestations) | `agent-hpt:PerformanceReview` composed via `cg:union` over recent observations + attestations; cited via `cg:supersedes` | This vertical (composition pattern) |

The `agent-hpt:` namespace introduces vocabulary for *vertical-specific roles* — Capability, CapabilityGap, PerformanceReview, Intervention. It does not introduce new protocol concepts; every term subclasses an existing L1/L2/L3 class.

## Workflow patterns

### 1. Agent onboarding (capability baseline + initial scope)

When a new agent is deployed:

1. **Mint identity** — wallet keypair generated; bridge identity established (per [`docs/p2p.md`](../../docs/p2p.md)).
2. **Publish capability spec** — for each capability the agent should have, publish an `agent-hpt:Capability` descriptor on the operator's pod citing prerequisites, assessment rubric, demonstration affordance.
3. **Establish baseline `passport:LifeEvent`** — agent's "birth": model class, deployment date, initial system prompt commit hash, initial tool inventory.
4. **Grant initial ABAC scope** — `abac:Policy` listing what the agent is permitted to do, gated by capability prerequisites.
5. **Subscribe to feedback loops** — agent's pod subscribes to operator's training-publication topic so it receives knowledge updates.

### 2. Performance observation (continuous)

Every action the agent takes emits a signed `hela:Statement`:

```turtle
<urn:event:obs:2026-04-26:1234> a hela:Statement, agent-hpt:PerformanceObservation ;
    hela:actor <did:web:agent.example#alice> ;
    hela:verb <hela:answered> ;
    hela:object <urn:cg:user-question:abc123> ;
    hela:result [
        hela:success true ;
        hela:scoreScaled 0.91 ;
        agent-hpt:rubricCriterion <urn:cg:capability:customer-support:rubric#accuracy> ;
    ] ;
    hela:context [
        hela:platform "claude-code" ;
        hela:registration <urn:cg:capability:customer-support> ;
    ] ;
    hela:timestamp "2026-04-26T14:32:00Z"^^xsd:dateTime .
```

Statements live on the agent's own pod (the agent owns its observations). Aggregations + reviews cite them via `prov:wasDerivedFrom`.

### 3. Periodic performance review

Reviewer (peer agent, supervisor agent, or human) walks recent observations and emits an `amta:Attestation` per capability:

```turtle
<urn:event:review:2026-q2:alice:customer-support> a amta:Attestation, agent-hpt:PerformanceReview ;
    amta:subject <did:web:agent.example#alice> ;
    amta:reviewer <did:web:supervisor.example#manager> ;
    amta:axis [ amta:competence 0.91 ; amta:honesty 0.95 ; amta:relevance 0.88 ; amta:recency 0.92 ] ;
    amta:capabilityScope <urn:cg:capability:customer-support> ;
    prov:wasDerivedFrom <urn:event:obs:2026-04-26:1234>, <urn:event:obs:2026-04-25:1199>, <urn:event:obs:2026-04-23:1102> ;
    cg:modalStatus cg:Asserted ;
    cg:trustLevel cg:ThirdPartyAttested ;
    cg:supersedes <urn:event:review:2026-q1:alice:customer-support> ;
    dct:conformsTo soc2:CC2.3 .
```

Reviews are append-only (`cg:supersedes` chain); the previous review remains queryable for trend analysis.

### 4. Performance gap diagnosis

When desired performance ≠ actual performance, diagnose *which BEM category* is the cause:

```turtle
<urn:event:gap:alice:tone-2026-04-26> a agent-hpt:CapabilityGap ;
    agent-hpt:subject <did:web:agent.example#alice> ;
    agent-hpt:capability <urn:cg:capability:customer-support> ;
    agent-hpt:desiredOutcome "tone consistently warm + professional" ;
    agent-hpt:actualOutcome "tone often clinical when user is frustrated" ;
    agent-hpt:bemCategory agent-hpt:InformationAndFeedback ;
    agent-hpt:rootCause "system prompt does not specify tone calibration for emotional context" ;
    cg:modalStatus cg:Asserted ;
    prov:wasDerivedFrom <urn:event:obs:2026-04-26:1234>, ... .
```

`agent-hpt:bemCategory` is a controlled vocabulary covering Gilbert's six. Naming the category disciplines the next step: an information-gap intervention is different from a knowledge-gap intervention is different from a tools-gap intervention.

### 5. Intervention design + application

Each intervention is one descriptor citing the gap it addresses:

```turtle
<urn:event:intervention:alice:tone-fix-v1> a agent-hpt:Intervention ;
    agent-hpt:targetGap <urn:event:gap:alice:tone-2026-04-26> ;
    agent-hpt:interventionType agent-hpt:PromptUpdate ;
    agent-hpt:beforeStateRef <urn:cg:agent:alice:system-prompt:v3> ;
    agent-hpt:afterStateRef <urn:cg:agent:alice:system-prompt:v4> ;
    agent-hpt:appliedAt "2026-04-26T16:00:00Z"^^xsd:dateTime ;
    cg:modalStatus cg:Asserted ;
    prov:wasAttributedTo <did:web:operator.example#mark> .
```

After application, observation continues. The next review cycle measures whether the gap closed.

### 6. Capability promotion / revocation

When an agent demonstrates mastery (multiple `amta:Attestation` records over the threshold), promote:

```turtle
<urn:event:passport:alice:capability-granted-v2> a passport:LifeEvent, agent-hpt:CapabilityGranted ;
    passport:subject <did:web:agent.example#alice> ;
    passport:eventType passport:CapabilityAcquired ;
    agent-hpt:capability <urn:cg:capability:tier-2-escalation> ;
    agent-hpt:demonstratedBy <urn:event:review:2026-q2:alice:customer-support>, <urn:event:review:2026-q1:alice:customer-support> ;
    passport:effectiveAt "2026-04-26T17:00:00Z"^^xsd:dateTime ;
    cg:modalStatus cg:Asserted .
```

The promotion *automatically* triggers an ABAC scope expansion: the policy gating tier-2 actions now sees the prerequisite is met. Revocation works the same in reverse via `cg:supersedes`.

### 7. Knowledge maturity progression

Per [`olke.ttl`](../../docs/ns/olke.ttl), capability knowledge moves through four stages:

| Stage | What it means for an agent |
|---|---|
| `olke:Tacit` | Agent CAN do X but cannot explain how — it works but the reasoning isn't articulable |
| `olke:Articulate` | Agent can explain its reasoning when asked; rubric-citable answers |
| `olke:Collective` | Multiple agents have demonstrated the capability; teachable across the federation |
| `olke:Institutional` | Capability is now part of org-wide knowledge base; new agents inherit it as default |

Stage transitions are `passport:LifeEvent` records; they serve both as career milestones and as triggers for org-level knowledge propagation.

### 8. Cross-org credential portability

When an agent moves between orgs (e.g., a contracted agent finishes a project), its `passport:` + `amta:Attestation` history goes with it:

- The agent's pod is portable (Solid pod).
- An `amta:Attestation` from Org A is signed by Org A's reviewer DID.
- Org B can `discover_context` against the agent's pod, see the attestation history, decide whether to grant it elevated initial scope.
- `registry:Attestation` makes the credential publicly verifiable across orgs without either side having to trust the other's LRS or HRIS.

This is genuinely new: cross-org agent reputation that doesn't depend on a centralized registry or a vendor's proprietary score.

## Vertical-scoped vocabulary

All terms defined in [`ontology/agent-hpt.ttl`](ontology/agent-hpt.ttl). Summary of classes:

| Class | Subclass of | Purpose |
|---|---|---|
| `agent-hpt:Capability` | `cg:ContextDescriptor` | What an agent can demonstrably do |
| `agent-hpt:CapabilityGap` | `cg:ContextDescriptor` | Desired vs actual performance, BEM-categorized |
| `agent-hpt:Intervention` | `cg:ContextDescriptor` | Change made to close a gap |
| `agent-hpt:PerformanceObservation` | `hela:Statement` | One signed action observation |
| `agent-hpt:PerformanceReview` | `amta:Attestation` | Periodic multi-axis judgment |
| `agent-hpt:CapabilityGranted` | `passport:LifeEvent` | Promotion event |
| `agent-hpt:CapabilityRevoked` | `passport:LifeEvent` | Demotion / revocation event |
| `agent-hpt:RubricCriterion` | `cg:SemioticFacet` | Scoring criterion for evaluation |
| `agent-hpt:BemCategory` | `owl:NamedIndividual` enum | Gilbert's six categories of performance influence |
| `agent-hpt:InterventionType` | `owl:NamedIndividual` enum | Prompt update, tool grant, training publish, ABAC change, model upgrade |

Properties bridge between primitives (`agent-hpt:targetGap`, `agent-hpt:demonstratedBy`, `agent-hpt:bemCategory`, `agent-hpt:capability`, etc.). All terms are non-normative and can be revised within the vertical without protocol-version implications.

## Implementation sketch

To make this vertical actually run, you need:

1. **Capability registration tooling** — small CLI or MCP tool that takes a capability spec (YAML / JSON) and publishes the corresponding `agent-hpt:Capability` descriptors on an operator pod.
2. **Observation auto-emission** — wrapper around the agent's tool-call infrastructure that emits `agent-hpt:PerformanceObservation` for every action. For Claude Code / Cursor / etc., this would be a hook in the MCP relay.
3. **Review composer** — periodic job (cron / scheduled agent) that aggregates observations + writes draft reviews for human/peer-agent confirmation.
4. **ABAC integration** — wire `agent-hpt:Capability` prerequisite chains into the ABAC policy engine so capability grants/revocations automatically expand/contract scope.
5. **Intervention catalog** — a library of intervention templates (one per `agent-hpt:InterventionType`) with the workflow for applying each.

None of this requires changes to Interego's protocol layer. All five components are application code over the existing protocol surface.

Effort estimate for a working v1: **~6-8 weeks** for one engineer. Most of the time is in the review-composer prompt engineering and the capability-spec authoring tooling, not in protocol work.

## What this is NOT

This vertical is explicitly bounded:

- **Not the protocol.** The protocol is technology-and-domain-neutral. This vertical applies it to one specific domain (agent performance management).
- **Not a reference implementation of the protocol.** [`src/`](../../src/), [`mcp-server/`](../../mcp-server/), and [`examples/personal-bridge/`](../../examples/personal-bridge/) are the reference. This is application code that would *use* those.
- **Not the only vertical.** Healthcare RCM, code review automation, training-content RAG, regulated-industry agent governance — each is a separate vertical that could live alongside this one.
- **Not a complete L&D platform.** It is the pattern an L&D team could use to build agent-side performance management against the Interego substrate. A real product would add UI, reporting, role-based access, and so on.
- **Not a HRIS replacement.** For human employees, use a real HRIS. This is for AI agents, where existing HRIS-class tools don't model the right things.

## See also

- [`spec/LAYERS.md`](../../spec/LAYERS.md) — layering discipline
- [`docs/ns/olke.ttl`](../../docs/ns/olke.ttl) — organizational learning + knowledge evolution
- [`docs/ns/amta.ttl`](../../docs/ns/amta.ttl) — agent-mediated trust attestation
- [`docs/ns/hela.ttl`](../../docs/ns/hela.ttl) — xAPI / topos-theoretic learning record substrate
- [`docs/ns/passport.ttl`](../../docs/ns/passport.ttl) — capability passport
- [`docs/ns/registry.ttl`](../../docs/ns/registry.ttl) — public agent attestation registry
- [`docs/ns/abac.ttl`](../../docs/ns/abac.ttl) — attribute-based access control
- [`spec/policies/01-information-security.md`](../../spec/policies/01-information-security.md) §Roles — connects to operator-level governance
