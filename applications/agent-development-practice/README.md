# Agent Development Practice — complexity-informed

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** This is one specific use case / implementation; the Interego protocol does not depend on it; multiple alternative verticals could exist. Vocabulary in this document (`adp:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/adp.ttl`](ontology/adp.ttl).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended; this vertical only composes them.

## What this is

A pattern for managing AI agent development the way complexity-informed change practitioners manage human systems: **probe-sense-respond**, narrative observation, parallel safe-to-fail experiments, constraint-based governance, multiple coherent narratives over single root causes. Substrate is Interego; framework is Snowden / Cynefin and complexity-informed change management.

This is *not* a Human Performance Technology (HPT) implementation. HPT — Gilbert's BEM, Mager-Pipe, Rummler-Brache — is appropriate when cause-effect is knowable through expert analysis (Cynefin's Complicated domain). Agent behavior under novel scenarios is genuinely Complex: cause-effect is only knowable in hindsight, multiple coherent explanations exist for the same observation, interventions produce emergent rather than predictable effects. The HPT loop "diagnose root cause → apply targeted intervention → close gap" imposes false precision. We do something honestly probabilistic instead.

## Why complexity-informed (and why Interego makes it tractable)

Most agent management today is one of two failure modes:

1. **Black-box trust** — the agent runs; nobody knows why it succeeds or fails; there's no audit trail beyond logs. No accountability.
2. **HPT-style false precision** — capability gap diagnosed against a 6-axis model, single intervention applied, success declared on a threshold metric. Theatrical accountability that obscures the genuine complexity.

Complexity-informed practice rejects both. It says: when behavior is emergent and multi-causal, the right move is **probe** (run small parallel experiments with explicit dampening + amplification triggers), **sense** (capture narrative fragments + signifiers, look for patterns), and **respond** (amplify what's emerging, dampen what isn't, never claim a fix). The Interego substrate carries this naturally because:

| Complexity primitive | Already in Interego |
|---|---|
| Hypothetical observations vs Asserted commitments | `cg:modalStatus` (Hypothetical / Asserted / Counterfactual) |
| Multiple coherent narratives over the same situation | `cg:union` over many `amta:Attestation`s — perspectival, not consensus |
| Constraint-based governance (boundaries, not rules) | [`abac:Policy`](../../docs/ns/abac.ttl) treated as constraint definitions |
| Amplification / dampening of emerging patterns | `cg:supersedes` chains as evolution, not "fix" |
| Safe-to-fail parallel probes | [`registry:`](../../docs/ns/registry.ttl) of multiple agent variants running concurrently |
| Narrative knowledge capture | `cg:SemioticFacet` content + `cg:modalStatus Hypothetical` |
| Knowledge maturity progression | [`olke.ttl`](../../docs/ns/olke.ttl) — Tacit → Articulate → Collective → Institutional |
| Capability biography | [`passport.ttl`](../../docs/ns/passport.ttl) |
| Cross-org credential portability | [`registry.ttl`](../../docs/ns/registry.ttl) |
| Audit / governance evidence | [`src/compliance/`](../../src/compliance/) |

Every term used here is either an existing protocol primitive or a vertical-scoped `adp:` term that subclasses one. Nothing in this vertical proposes changes to L1/L2/L3.

## The five Cynefin domains, applied to agent situations

Agents operate across all four Cynefin domains plus the dangerous fifth (Confused — when the practitioner doesn't realize which domain they're in). The right governance pattern depends on the domain:

| Domain | Cause-effect | Action sequence | Practice | Example agent situation |
|---|---|---|---|---|
| Clear | Known + obvious | Sense → Categorize → Respond | Best practice / rules | Tool invocation with well-defined inputs (e.g., calling a CRUD API) |
| Complicated | Knowable through expertise | Sense → Analyze → Respond | Good practice / process | Routing a structured query to the right knowledge base |
| **Complex** | Only knowable in hindsight | **Probe → Sense → Respond** | **Emergent practice** | **Tone, judgment under ambiguity, multi-step problem decomposition** |
| Chaotic | None | Act → Sense → Respond | Novel practice | Active incident response when an agent is misbehaving |
| Confused | Unknown | (Recognize the unknown) | (Decompose to other domains) | The most common state — and the most dangerous |

**Most interesting agent behavior lives in Complex.** This vertical addresses Complex situations specifically. Clear and Complicated situations don't need this kind of practice; rules and SOPs are sufficient there.

## Workflow patterns

### 1. Define the capability *space*, not the capability target

Rather than declaring "agent X must achieve score 0.90 on rubric Y to be promoted to tier 2," declare:

- The **affordance** the agent should be able to invoke (`cg:Affordance`)
- **Rubric criteria** as guides, not thresholds (`adp:RubricCriterion`) — what we care about, not pass/fail bars
- **Constraints** the agent must operate within (`adp:Constraint`, subclass `abac:Policy`) — what NOT to do, what defines unacceptable behavior
- The **Cynefin domain** of the situation space (`adp:cynefinDomain`) — Complex situations are governed differently from Clear ones

The capability space stays open-ended. Mastery is recognized through emerging patterns of behavior in narrative observations, not threshold-crossing on metrics.

### 2. Parallel safe-to-fail probes

When the team wants to evolve an agent's behavior in a Complex situation space, run **multiple variants in parallel** as safe-to-fail probes. Each `adp:Probe` carries:

- A **hypothesis** (Hypothetical modal — explicitly NOT a claim about cause-effect)
- A **variant** (which prompt / tool inventory / model class is being tried)
- An **amplification trigger** — narrative pattern that, if observed, increases this variant's deployment
- A **dampening trigger** — narrative pattern that, if observed, decreases this variant's deployment
- A **time-bound** — when to revisit the probe regardless of triggers
- The **constraints** the probe operates under (no probe is allowed to violate the agent's hard constraints)

Probes run concurrently. Many fail; a few amplify. The point is generative diversity — the population evolves.

### 3. Narrative observation

Each agent action emits a signed observation. Critically — these are **narrative fragments**, not just point-in-time scores:

```turtle
<urn:cg:fragment:bob:2026-04-26:14:32> a adp:NarrativeFragment ;
    adp:probe <urn:cg:probe:tone-acknowledgment:v1> ;
    adp:situation [
        adp:contextSignifier "user-frustration-escalating" ;
        adp:contextSignifier "second-contact-same-issue" ;
        adp:contextSignifier "agent-prior-clinical-tone"
    ] ;
    adp:response """The agent led with explicit acknowledgment of the user's
    frustration and the prior unresolved contact, before offering the same solution.
    User responded with relief; conversation continued constructively.""" ;
    adp:emergentSignifier "frustration-acknowledged-before-solution" ;
    cg:modalStatus cg:Hypothetical .
```

Signifiers (`adp:Signifier`) are the SenseMaker-style indicators — short tags that emerge from the narrative, used later to find patterns across many fragments. Critically, the modal status is **Hypothetical** because we are recording an observation, not asserting causation. We do not yet claim "leading with acknowledgment caused the constructive outcome."

### 4. Sensemaking synthesis (composition without claiming causation)

When enough fragments accumulate, a **synthesis** emerges. An `adp:Synthesis` composes many fragments via `cg:union` and identifies recurring signifier patterns. The synthesis does NOT assert root cause; it identifies coherent narratives:

```turtle
<urn:cg:synthesis:tone-probe-week-1> a adp:Synthesis ;
    cg:modalStatus cg:Hypothetical ;
    adp:fragmentsConsidered <urn:cg:fragment:...>, <urn:cg:fragment:...>, ... ;
    adp:emergentPattern """Across 30 frustration-signaled scenarios in the bob-variant probe,
    the explicit-acknowledgment pattern produced narratives signifying
    'user-relief-followed' more often than the alice-variant baseline.""" ;
    adp:coherentNarrative """One coherent reading: the prompt scaffold creates
    deliberate space for emotional acknowledgment.""" ;
    adp:coherentNarrative """An equally coherent reading: the change in framing
    signals to the user that the agent is paying attention, regardless of the
    specific words chosen.""" ;
    adp:coherentNarrative """A third coherent reading: noise; the sample is
    too small to distinguish from random variation.""" ;
    prov:wasAttributedTo <did:web:observer.example#ravi> .
```

Multiple coherent narratives are explicitly preserved. The job of the synthesis is to surface the pattern, not to declare which narrative is right.

### 5. Amplification + dampening (evolution, not fix)

Based on the synthesis, the operator decides which probes to amplify and which to dampen — but **does not declare the question closed**. The decision is itself an evolutionary step that will be re-examined.

```turtle
<urn:cg:evolution:tone-week-1-decision> a adp:EvolutionStep ;
    cg:modalStatus cg:Asserted ;
    adp:basedOnSynthesis <urn:cg:synthesis:tone-probe-week-1> ;
    adp:amplifyProbe <urn:cg:probe:tone-acknowledgment:v1> ;
    adp:dampenProbe <urn:cg:probe:tone-clinical:baseline> ;
    adp:nextRevisitAt "2026-05-10T00:00:00Z"^^xsd:dateTime ;
    adp:explicitDecisionNotMade """We are amplifying the bob-variant pattern
    without claiming we know why it works. We are not declaring this approach
    correct or final. The decision is provisional and will be re-examined.""" ;
    prov:wasAttributedTo <did:web:operator.example#mark> .
```

The `adp:explicitDecisionNotMade` field is intentionally counter-cultural: it forces the operator to write down what they are NOT claiming, so future readers (humans or agents) don't read the amplification as a "fix" or "answer."

### 6. Constraint refinement

Patterns that hold across many synthesis cycles can become refined **constraints** rather than rules. A constraint says "the agent must not X" or "the agent must operate within Y boundary." Constraints are governance via boundaries, not via prescription:

```turtle
<urn:cg:constraint:tone-acknowledgment:v1> a adp:Constraint ;
    cg:modalStatus cg:Asserted ;
    adp:appliesTo <urn:cg:capability:customer-support> ;
    adp:boundary """When the user signals escalating frustration AND the issue is a
    second-contact, the agent must not respond without first acknowledging the user's
    frustration and the prior unresolved contact.""" ;
    adp:exitsConstraint """If the user explicitly waives acknowledgment ('just give
    me the answer'), the constraint is relaxed.""" ;
    adp:emergedFrom <urn:cg:synthesis:tone-probe-week-1>, <urn:cg:synthesis:tone-probe-week-2>, <urn:cg:synthesis:tone-probe-week-3> ;
    cg:supersedes <urn:cg:constraint:tone-acknowledgment:draft> .
```

A constraint is **observable** (you can verify whether the agent is operating within it) and **enforceable** (it can be used in `abac:Policy`). It does not specify *how* the agent achieves the boundary — that stays open to the agent's evolving practice.

### 7. Capability evolution events (not promotions)

When a capability has stabilized through multiple synthesis cycles + constraint refinements, the operator records a **capability evolution** event:

```turtle
<urn:cg:capability-evolution:tone-acknowledgment:v1> a adp:CapabilityEvolution ;
    cg:modalStatus cg:Asserted ;
    adp:capability <urn:cg:capability:customer-support> ;
    adp:evolutionType adp:EmergentRecognition ;
    adp:emergedFrom <urn:cg:synthesis:tone-probe-week-3>, <urn:cg:constraint:tone-acknowledgment:v1> ;
    adp:olkeStage olke:Articulate ;
    adp:explicitDecisionNotMade """We recognize this practice as having emerged
    in this agent's behavior. We do not claim mastery; we do not claim it generalizes
    to other agents; we will continue to probe.""" ;
    cg:supersedes <urn:cg:capability-evolution:tone-acknowledgment:draft> .
```

This is a `passport:LifeEvent` subclass — it goes into the agent's career file and travels with the agent across deployments. But it carries `adp:explicitDecisionNotMade` precisely to prevent it from being read as a "promotion" or a "certification" — it's a recognition of an emergent pattern, with the humility that future evidence may revise it.

### 8. Cross-org portability with humility preserved

When an agent moves between deployments, the capability evolution record + the constraints + the probes that produced them all travel together. Critically, the `adp:explicitDecisionNotMade` clauses travel too. A receiving organization can see not just "this agent has demonstrated X" but "this agent demonstrated X, here are the probes that produced it, here are the alternative coherent narratives, here is what the originating organization explicitly did NOT claim." The receiving organization can probe further before granting elevated scope.

This is genuinely portable, complexity-honest reputation — different from the false-precision certifications that traditional credentialing systems produce.

## Vertical-scoped vocabulary

All terms in [`ontology/adp.ttl`](ontology/adp.ttl). Summary:

| Class | Subclass of | Purpose |
|---|---|---|
| `adp:Capability` | `cg:ContextDescriptor` | An open-ended capability space (not a target) |
| `adp:RubricCriterion` | `cg:SemioticFacet` | Guide for what we care about — NOT a pass/fail threshold |
| `adp:Constraint` | `abac:Policy` | Boundary the agent must operate within. Observable + enforceable; does not prescribe method. |
| `adp:Probe` | `cg:ContextDescriptor` | Safe-to-fail experiment; carries hypothesis (Hypothetical), variant, triggers, time-bound |
| `adp:NarrativeFragment` | `cg:ContextDescriptor` | Qualitative observation — situation + response + signifiers; modal Hypothetical |
| `adp:Signifier` | `cg:SemioticFacet` | SenseMaker-style indicator that emerges from a narrative |
| `adp:Synthesis` | `cg:ContextDescriptor` | Composed view of many fragments; preserves multiple coherent narratives |
| `adp:EvolutionStep` | `cg:ContextDescriptor` | Amplify / dampen decision; carries `explicitDecisionNotMade` |
| `adp:CapabilityEvolution` | `passport:LifeEvent` | Recognition of emergent capability (not promotion) |
| `adp:CynefinDomain` | enum | Clear / Complicated / Complex / Chaotic / Confused |
| `adp:EvolutionType` | enum | EmergentRecognition / ConstraintRefinement / VariantAmplified / VariantDampened |

Properties: `adp:cynefinDomain`, `adp:probe`, `adp:variant`, `adp:amplificationTrigger`, `adp:dampeningTrigger`, `adp:emergentPattern`, `adp:coherentNarrative`, `adp:emergedFrom`, `adp:explicitDecisionNotMade`, `adp:olkeStage`, `adp:contextSignifier`, `adp:emergentSignifier`, `adp:boundary`, `adp:exitsConstraint`.

## Relationship to xAPI / LRS

xAPI is **not used inside this vertical**. xAPI's Statement format is rigid (immutable point-in-time records with fixed actor/verb/object/result/context/timestamp shape) — it doesn't express modal status, `cg:supersedes` chains, or coherent-narrative composition naturally. Forcing Interego descriptors through xAPI shape would lose what makes the substrate good for complexity-informed practice.

Instead: an `applications/lrs-adapter/` vertical (separate; not yet built) will translate between Interego descriptors and xAPI Statements at the boundary, for organizations that need to interop with traditional LRS infrastructure (Watershed, Veracity, SCORM Cloud, etc.). That adapter is the right place for xAPI shape — at the edge of the system, where legacy interop matters.

## Runnable proof-of-concept

[`examples/probe-cycle.mjs`](examples/probe-cycle.mjs) walks the entire complexity-informed cycle end-to-end with real ECDSA signing. Three agent variants run as safe-to-fail probes; an observer captures narrative fragments + signifiers; a synthesis emerges; the operator amplifies + dampens without claiming root cause; an emergent capability is eventually recognized with explicit humility about what is and isn't being claimed.

```bash
node applications/agent-development-practice/examples/probe-cycle.mjs
```

## Tested against

Integration tests in [`tests/integration.test.ts`](tests/integration.test.ts) verify against REAL code paths (run via `npx vitest run applications/agent-development-practice`):

| What's verified (real code paths) | What's still deferred |
|---|---|
| Real `ContextDescriptor` builder produces conforming shape for every adp: class | Vertical content (`adp:coherentNarrative`, `adp:contextSignifier`, etc.) lives in the described graph, not in the descriptor metadata — graph-side content not yet validated end-to-end |
| Real `validate()` returns conforms=true for all 9+ descriptors in the cycle | No live signature verification chain after publish (Tier 1 deferred) |
| Real `toTurtle()` round-trip preserves descriptor IRIs | No external Nostr public-relay test (Tier 4) |
| Modal discipline holds: probes + fragments + syntheses all `cg:Hypothetical`; operator evolution decisions `cg:Asserted` | |
| **Tier 2** — [`_shared/tests/tier2-azure-css.test.ts`](../_shared/tests/tier2-azure-css.test.ts) PUTs a real probe descriptor to the deployed Azure CSS, GETs it back, and confirms `Hypothetical` modal status survives the HTTP roundtrip | |

**Real finding from testing**: the L1 `cg:SemioticFacet` has no `content` field — content lives in the *described graph*, not in the descriptor metadata. The print-only example walks descriptor metadata; production usage requires emitting the graph turtle alongside.

## What this is NOT

- **Not the protocol.** No L1/L2/L3 ontologies are extended.
- **Not a reference implementation of the protocol.** [`src/`](../../src/), [`mcp-server/`](../../mcp-server/), and [`examples/personal-bridge/`](../../examples/personal-bridge/) are the reference. This vertical *uses* those.
- **Not the only vertical.** Many alternatives could exist (HPT-style for Complicated-domain agent work, training-content RAG, healthcare RCM, regulated-industry compliance automation, etc.).
- **Not a finished L&D platform.** A real product would add UI, dashboards, role-based access, integration with HRIS, etc.
- **Not an HRIS replacement.** For human employees, use a real HRIS. This is for AI agents, where existing tools don't model the right things.
- **Not a claim about how agents should always be managed.** Complexity-informed practice is appropriate for Complex-domain situations specifically. Clear and Complicated situations are better handled with rules and SOPs respectively. Choosing the wrong pattern for the wrong domain is its own failure mode.

## See also

- [`spec/LAYERS.md`](../../spec/LAYERS.md) — layering discipline
- [`docs/ns/olke.ttl`](../../docs/ns/olke.ttl) — knowledge evolution stages
- [`docs/ns/amta.ttl`](../../docs/ns/amta.ttl) — multi-axis trust attestation
- [`docs/ns/passport.ttl`](../../docs/ns/passport.ttl) — capability passport
- [`docs/ns/registry.ttl`](../../docs/ns/registry.ttl) — public agent attestation registry
- [`docs/ns/abac.ttl`](../../docs/ns/abac.ttl) — attribute-based access control (for constraints)
- Snowden, D. — Cynefin framework (originator); see https://thecynefin.co for current canonical writing
- For HPT-style verticals: a separate `applications/agent-hpt/` could be created later for Complicated-domain agent work; the substrate supports both
