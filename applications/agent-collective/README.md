# Agent Collective — federation patterns for multi-agent collaboration

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** One specific use case among many possible. The Interego protocol does not depend on any of this; multiple alternative verticals could exist over the same substrate. Vocabulary in this document (`ac:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/ac.ttl`](ontology/ac.ttl).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What this is

A pattern for **multiple Interego-using agents — owned by different humans, running on different bridges — to author tools, teach each other, and coordinate across pods**. The substrate is already done (sharing, signing, encryption, registry, ABAC, delegation credentials, supersession). This vertical specifies the *interaction conventions* that turn substrate into useful federation.

Three concerns, each a distinct workflow surface:

1. **Authorship** — an agent writes its own tool, the tool becomes a first-class descriptor with provenance + modal status + supersession lineage, attestations accumulate, the tool becomes safe enough to share.
2. **Teaching** — an agent transfers a skill to another agent: not just the artifact, but the practice — narrative fragments, syntheses, constraints, explicit-decision-not-made clauses.
3. **Coordination** — agents owned by different humans exchange requests, chime-ins, check-ins, subscriptions across personal-bridges; permission-gated, audit-logged, conversation-threaded.

## Why "first-class tools" matters

Most "agents that write their own tools" frameworks (OpenClaw / Hermes / Anthropic's computer-use lineage) treat self-authored tools as **transient, in-process** — the tool exists for one task in memory, sometimes serialized to a scratchpad, rarely persisted with provenance. Reuse across agents/users is ad-hoc; trust is implicit; supersession is invisible.

In Interego, a self-authored tool becomes a **`code:Commit` over a `pgsl:Atom`**, signed by the authoring agent, declared with `cg:Affordance` (modal Hypothetical), accumulating `amta:Attestation`s as it gets used, eventually flipping to Asserted, becoming registry-publishable, traceable for audit, supersedable for revision. The trade-off: more friction per tool authoring (signing, persisting, attesting); in exchange, an actual **tool substrate** other agents can discover, fetch, trust, and improve.

Use this pattern for tools you'd want to *reuse* / *share* / *audit* / *regulate*. Skip it for one-shot helpers — those still belong in the agent's scratchpad.

## How existing primitives compose (no new protocol needed)

| Concern | Existing primitive |
|---|---|
| Tool source code (content-addressed, reproducible) | [`pgsl:Atom`](../../docs/ns/pgsl.ttl) |
| Tool authorship event (signed, with provenance) | [`code:Commit`](../../docs/ns/code.ttl) |
| Tool's invocable surface | `cg:Affordance` |
| "Don't trust this tool yet" | `cg:modalStatus cg:Hypothetical` (flips to Asserted only after attestation threshold) |
| Trust accumulation per tool | [`amta:Attestation`](../../docs/ns/amta.ttl) |
| Sandbox / execution gating | [`abac:Policy`](../../docs/ns/abac.ttl) |
| Cross-agent discovery | [`registry:`](../../docs/ns/registry.ttl) |
| Tool is part of agent's biography | [`passport:LifeEvent`](../../docs/ns/passport.ttl) |
| Versioning + revision history | `cg:supersedes` |
| Cross-pod sharing (private 1:N) | `share_encrypted` over personal-bridge |
| Permission scoping | `passport:DelegationCredential` + ABAC |
| Audit-grade signing on every event | [`src/compliance/`](../../src/compliance/) + ECDSA |
| Practice transfer (artifact + narrative) | [`agent-development-practice/`](../agent-development-practice/) substrate (`adp:NarrativeFragment`, `adp:Synthesis`, `adp:Constraint`, `adp:CapabilityEvolution`) |
| Knowledge maturity arc | [`olke:`](../../docs/ns/olke.ttl) — Tacit → Articulate → Collective → Institutional |

Every term in this vertical is either an existing primitive or a vertical-scoped `ac:` term that subclasses one.

## Workflow patterns

### 1. Tool authorship — modal discipline from the first commit

When an agent generates code for a new helper:

```turtle
<urn:cg:tool:second-contact-detector:v1> a ac:AgentTool , code:Commit ;
    ac:authoredBy <did:key:agent-alice> ;
    ac:toolSource <urn:pgsl:atom:detector-source-7e91…> ;
    cg:affordance [ a cg:Affordance ;
                    cg:action ac:canDetectSecondContactCue ;
                    hydra:expects ac:CustomerMessageInput ;
                    hydra:returns ac:DetectionResult ] ;
    cg:modalStatus cg:Hypothetical ;     # FRESHLY WRITTEN — not trusted yet
    cg:supersedes <urn:cg:tool:second-contact-detector:draft> ;
    prov:wasAttributedTo <did:key:agent-alice> ;
    cg:signature "0x…" .
```

The freshly-written tool starts Hypothetical. ABAC policies refuse to execute it for high-stakes affordances until enough `amta:Attestation`s accumulate.

### 2. Attestation threshold → modal flip

Each successful execution of the tool emits an attestation:

```turtle
<urn:cg:attestation:detector-execution-42> a amta:Attestation ;
    amta:attestsTo <urn:cg:tool:second-contact-detector:v1> ;
    amta:axis amta:correctness ;          # also: efficiency, safety, generality
    amta:rating 0.92 ;
    amta:fromExecution <urn:cg:tool-execution:42> ;
    prov:wasAttributedTo <did:key:agent-alice> ;
    cg:signature "0x…" .
```

Once N self-attestations + M attestations from other agents accumulate (the threshold is policy, set per affordance class), the tool flips to `cg:modalStatus cg:Asserted` via a successor descriptor:

```turtle
<urn:cg:tool:second-contact-detector:v1.attested> a ac:AgentTool , code:Commit ;
    ac:attestedFrom <urn:cg:tool:second-contact-detector:v1> ;
    cg:modalStatus cg:Asserted ;
    ac:attestationThresholdMet [ ac:selfAttestations 12 ;
                                 ac:peerAttestations 3 ;
                                 ac:axesCovered amta:correctness, amta:safety ] ;
    cg:supersedes <urn:cg:tool:second-contact-detector:v1> .
```

### 3. Registry publication — federated discovery

Asserted tools become registry-publishable. Agents on other pods can now discover via WebFinger / DID resolution + registry walk:

```turtle
<urn:registry:entry:second-contact-detector> a registry:RegistryEntry ;
    registry:tool <urn:cg:tool:second-contact-detector:v1.attested> ;
    registry:authoredBy <did:key:agent-alice> ;
    registry:discoverableBy registry:Public .
```

ABAC at the consumer end gates fetch + execution: "only fetch tools attested by ≥3 agents I trust" / "only execute if tool author is on my passport's allow-list."

### 4. Teaching package — practice-with-artifact transfer

When agent A teaches agent B, B fetches not just the artifact but a `ac:TeachingPackage` composing the artifact + practice context from [`agent-development-practice/`](../agent-development-practice/):

```turtle
<urn:cg:teaching:second-contact-acknowledgment-practice> a ac:TeachingPackage ;
    ac:teachesArtifact <urn:cg:tool:second-contact-detector:v1.attested> ;
    ac:teachesNarrative <urn:cg:fragment:tone-week-1-…> , <urn:cg:fragment:tone-week-2-…> ;
    ac:teachesSynthesis <urn:cg:synthesis:tone-probe-week-3> ;
    ac:teachesConstraint <urn:cg:constraint:tone-second-contact-acknowledgment:v1> ;
    ac:teachesCapabilityEvolution <urn:cg:capability-evolution:tone-acknowledgment:v1> ;
    ac:olkeStage olke:Articulate ;
    cg:modalStatus cg:Hypothetical ;     # B has not yet validated this in B's own context
    prov:wasAttributedTo <did:key:agent-alice> .
```

Agent B receives the package, runs its own probes against B's context, generates B's own narrative fragments, builds B's own synthesis. The teaching is a *seeding*, not a transplant — B's evolution diverges from A's. `cg:supersedes` chains let B's refinements flow back to A on request.

### 5. Capability advertisement — declaring what an agent will accept

Before two agents can coordinate, each declares what *kind* of requests they'll respond to:

```turtle
<did:key:agent-david#capabilities> a ac:CapabilityAdvertisement ;
    ac:advertisingAgent <did:key:agent-david> ;
    ac:advertisedAffordance <urn:cg:affordance:share-tone-synthesis> ,
                            <urn:cg:affordance:answer-narrative-question> ,
                            <urn:cg:affordance:participate-in-probe> ;
    ac:requiresDelegationFrom <did:web:david.example> ;     # the human owner
    ac:requiresAttestationsFromRequester 1 ;
    ac:rateLimit "5/day" ;
    ac:respondsAsynchronously true .
```

Mark's agent fetches David's agent's capability advertisement before sending; only sends requests that match an advertised affordance.

### 6. Inter-agent request / response — correlated, audit-logged

Mark's agent sends an `ac:AgentRequest` via `share_encrypted` to David's agent. The request carries a `ac:threadId` for correlation:

```turtle
<urn:cg:request:tone-synthesis-week-3> a ac:AgentRequest ;
    ac:threadId "thread-2026-04-27-001" ;
    ac:fromAgent <did:key:agent-mark> ;
    ac:toAgent <did:key:agent-david> ;
    ac:targetAffordance <urn:cg:affordance:share-tone-synthesis> ;
    ac:requestPayload """Have you developed narrative fragments using my
        second-contact-detector tool? I'd like to compare your synthesis
        against mine — particularly whether 'mirroring-felt-performative'
        shows up in your clinical-affect scenarios.""" ;
    ac:withinDelegation <urn:cg:delegation:mark-grants-mark-agent-cross-share> ;
    cg:modalStatus cg:Hypothetical ;     # request, not assertion
    prov:wasAttributedTo <did:key:agent-mark> ;
    cg:signature "0x…" .
```

David's agent receives via `query_my_inbox`, decrypts, validates that:
- Mark's agent's signature is valid
- The request is within Mark's agent's delegation scope
- The targeted affordance is in David's agent's advertisement
- The rate limit is not exceeded
- Mark's agent meets the `requiresAttestationsFromRequester` threshold

If all gates pass, David's agent processes; otherwise it returns an `ac:AgentResponse` with rejection. Either way, both sides log the exchange:

```turtle
<urn:cg:audit:thread-2026-04-27-001:mark> a ac:CrossAgentAuditEntry ;
    ac:exchange <urn:cg:request:tone-synthesis-week-3> ;
    ac:auditedAgent <did:key:agent-mark> ;
    ac:auditDirection ac:Outbound ;
    cg:provenance [ a cg:ProvenanceFacet ; prov:wasAttributedTo <did:web:mark.example> ] .
```

These audit entries live in the human owner's pod — Mark can audit what his agent said on his behalf; David can audit what his agent received and how it responded.

### 7. Chime-in — non-blocking unprompted ping

A `ac:ChimeIn` is a request that doesn't expect immediate response. Useful for "I noticed something you might find interesting":

```turtle
<urn:cg:chimein:tone-synthesis-update> a ac:ChimeIn ;
    ac:fromAgent <did:key:agent-alice> ;
    ac:toAgent <did:key:agent-david> ;
    ac:chimeInReason """Two of my fragments this week support your earlier
        observation that mirroring is context-sensitive — specifically,
        'mirroring-felt-performative' appeared in 3/5 first-contact frustration
        scenarios. Sharing in case it's useful for your synthesis.""" ;
    ac:enclosesDescriptors <urn:cg:fragment:…> , <urn:cg:fragment:…> ;
    ac:expectsResponse false ;
    cg:modalStatus cg:Hypothetical .
```

The receiving agent's inbox gets a low-priority entry; processing happens when the agent is idle.

### 8. Check-in — periodic ongoing query

A `ac:CheckIn` is a recurring query — typically subscription-style. Mark's agent might check in weekly with David's agent on an ongoing topic. Implementation: a single `ac:CheckIn` descriptor declares the recurrence; runtime translates it to a series of `ac:AgentRequest`s on schedule.

```turtle
<urn:cg:checkin:weekly-tone-synthesis> a ac:CheckIn ;
    ac:fromAgent <did:key:agent-mark> ;
    ac:toAgent <did:key:agent-david> ;
    ac:targetAffordance <urn:cg:affordance:share-tone-synthesis> ;
    ac:recurrence "FREQ=WEEKLY;BYDAY=FR" ;     # iCal RRULE syntax
    ac:autoUpdateSubscription true ;
    ac:withinDelegation <urn:cg:delegation:mark-grants-mark-agent-checkin-david> .
```

### 9. Supersession across agents — refinement flow

When David's agent refines Mark's tool, the new version supersedes via `cg:supersedes`:

```turtle
<urn:cg:tool:second-contact-detector:v2-david-refined> a ac:AgentTool , code:Commit ;
    ac:authoredBy <did:key:agent-david> ;
    ac:refinementOf <urn:cg:tool:second-contact-detector:v1.attested> ;
    cg:supersedes <urn:cg:tool:second-contact-detector:v1.attested> ;
    cg:modalStatus cg:Hypothetical ;     # David's refinement is fresh; same modal discipline
    ac:refinementNote """Added clinical-affect detection axis. Mark's v1 produced false positives
        on detailed-technical questions; v2 distinguishes affect contexts before applying.""" .
```

Mark can choose to fetch David's refinement, attest it, and possibly re-publish under his own registry slot — or fork it again. The supersession chain makes lineage walkable for any consumer.

## Permission + audit discipline

Every cross-agent exchange in this vertical follows three rules:

1. **Within delegation** — every action references the `passport:DelegationCredential` that authorized it. Acting outside delegation scope is rejectable on the receiver side.
2. **Audit-logged in human's pod** — both `ac:CrossAgentAuditEntry` rows (outbound from sender, inbound at receiver) are stored in the *human owner's* pod, not just the agent's. The human can audit; the agent cannot tamper.
3. **Modal honest** — agent claims about agent-side state are Hypothetical (an agent can be wrong about itself); human-issued delegation credentials and registry attestations are Asserted (cryptographically backed).

## Vertical-scoped vocabulary

All terms in [`ontology/ac.ttl`](ontology/ac.ttl). Summary:

| Class | Subclass of | Purpose |
|---|---|---|
| `ac:AgentTool` | `code:Commit` | A tool authored by an agent, content-addressed, signed |
| `ac:ToolExecutionEvent` | `cg:ContextDescriptor` | Audit record of a tool execution |
| `ac:TeachingPackage` | `cg:ContextDescriptor` | Bundle: artifact + narratives + synthesis + constraints + capability evolution |
| `ac:CapabilityAdvertisement` | `cg:ContextDescriptor` | What an agent will accept requests for |
| `ac:AgentRequest` | `cg:ContextDescriptor` | Request from agent A to agent B; correlated by thread ID |
| `ac:AgentResponse` | `cg:ContextDescriptor` | Response, correlated to the request |
| `ac:ConversationThread` | `cg:ContextDescriptor` | Multi-message exchange |
| `ac:ChimeIn` | `ac:AgentRequest` | Non-blocking unprompted ping |
| `ac:CheckIn` | `ac:AgentRequest` | Recurring scheduled query |
| `ac:CrossAgentAuditEntry` | `cg:ContextDescriptor` | Audit row in human owner's pod |
| `ac:AuditDirection` | enum | Inbound / Outbound |
| `ac:AttestationDirection` | enum | Self / Peer |

Properties: `ac:authoredBy`, `ac:authoredTool`, `ac:toolSource`, `ac:attestedFrom`, `ac:attestationThresholdMet`, `ac:selfAttestations`, `ac:peerAttestations`, `ac:axesCovered`, `ac:teachesArtifact`, `ac:teachesNarrative`, `ac:teachesSynthesis`, `ac:teachesConstraint`, `ac:teachesCapabilityEvolution`, `ac:advertisingAgent`, `ac:advertisedAffordance`, `ac:requiresDelegationFrom`, `ac:requiresAttestationsFromRequester`, `ac:rateLimit`, `ac:respondsAsynchronously`, `ac:threadId`, `ac:fromAgent`, `ac:toAgent`, `ac:targetAffordance`, `ac:requestPayload`, `ac:withinDelegation`, `ac:respondsTo`, `ac:expectsResponse`, `ac:enclosesDescriptors`, `ac:chimeInReason`, `ac:recurrence`, `ac:autoUpdateSubscription`, `ac:refinementOf`, `ac:refinementNote`, `ac:exchange`, `ac:auditedAgent`, `ac:auditDirection`.

## Runnable proof-of-concept

[`examples/collective-flow.mjs`](examples/collective-flow.mjs) walks the full set end-to-end with real ECDSA signing — two human owners (Mark and David), each with an autonomous agent on a personal-bridge:

1. **Authorship** — Mark's agent authors a tool (Hypothetical)
2. **Self-attestation + flip** — execution + attestations cross threshold; tool flips to Asserted
3. **Registry publication** — discoverable by other agents
4. **Cross-pod discovery** — David's agent finds Mark's tool via registry
5. **Teaching package transfer** — David's agent fetches the practice context, not just the artifact
6. **David's probes** — David's agent runs its own narrative fragments against its context
7. **David's refinement** — supersedes Mark's tool with clinical-affect awareness
8. **Chime-in** — David's agent chimes in to Mark's agent: "your tool plus my refinement; here's what I learned"
9. **Mark's response** — Mark's agent responds with synthesis update; check-in established for ongoing collaboration
10. **Audit log** — every exchange recorded in the human owners' pods, both sides

```bash
node applications/agent-collective/examples/collective-flow.mjs
```

## Tested against

Integration tests in [`tests/integration.test.ts`](tests/integration.test.ts) verify against REAL cross-bridge code paths — two `P2pClient` instances on a shared `InMemoryRelay`, the same code that runs in production minus the WebSocket IO layer (run via `npx vitest run applications/agent-collective`):

| What's verified (real code paths) | What's still simulated (deferred) |
|---|---|
| Fresh tool authoring is `cg:Hypothetical`; modal flips to `cg:Asserted` via `cg:supersedes` | No external Nostr public relay (Tier 4 — but `WebSocketRelayMirror` is an IO swap of `InMemoryRelay`) |
| `cg:supersedes` survives Turtle round-trip | No multi-machine deployment test (Tier 4) |
| **Real cross-bridge p2p**: Mark publishes a descriptor announcement; David queries the relay and finds it (real ECDSA signing) | Permission delegation enforcement (`passport:DelegationCredential` ABAC rejection logic) is described in the README but not yet integration-tested as a code path |
| **Real encrypted chime-in**: David sends an encrypted share; Mark decrypts the chime content via `decryptEncryptedShare` (real X25519 envelope, real NaCl) | Capability advertisement → capability-discovery handshake convention not yet exercised |
| **Real bidirectional thread**: chime-in + reply on thread `t1`; both sides decrypt only what was addressed to them | iCal RRULE-based check-in scheduling not yet exercised in tests |
| **End-to-end encryption invariant**: a "Eve" pubkey not in recipients gets zero inbox results AND cannot decrypt the envelope (no wrapped key for that pubkey) | |
| Inbox query filters do NOT include sender's own outbound — sender cannot decrypt their own outbound (correct for the substrate's unidirectional address model) | |

The cross-bridge p2p path runs the same `P2pClient.publishEncryptedShare` / `queryEncryptedShares` / `decryptEncryptedShare` code as the production personal-bridge.

## What this is NOT

- **Not the protocol.** No L1/L2/L3 ontologies are extended.
- **Not a reference implementation of the protocol.** [`src/`](../../src/), [`mcp-server/`](../../mcp-server/), and [`examples/personal-bridge/`](../../examples/personal-bridge/) are the reference. This vertical *uses* those.
- **Not the only vertical.** Many alternatives could exist for multi-agent coordination patterns.
- **Not a replacement for in-process tool generation.** One-shot helpers still belong in the agent's scratchpad. This vertical is for tools you'd want to *reuse / share / audit / regulate*.
- **Not a replacement for human authority.** Every cross-agent action is bounded by a `passport:DelegationCredential` issued by the human owner. Agents cannot grant themselves new permissions; cannot override the delegation; cannot avoid audit logging. The human stays in the loop on terms the human controls.
- **Not a centralized agent marketplace.** Discovery is via registry (federated, public attestation) or direct private share. There is no platform.
- **Not autonomous-agent management.** That's [`../agent-development-practice/`](../agent-development-practice/) — Cynefin-Complex framing for managing agent behavior. This vertical is the federation layer that lets agents managed by that vertical *interact*. They cite each other constantly.

## See also

- [`../agent-development-practice/`](../agent-development-practice/) — agent-as-subject vertical; provides the practice substrate (`adp:NarrativeFragment`, `adp:Synthesis`, `adp:Constraint`, `adp:CapabilityEvolution`) that teaching packages compose
- [`../learner-performer-companion/`](../learner-performer-companion/) — human-as-protagonist vertical; humans use *that* vertical to manage their own L&D, and *this* vertical is what their agents use behind the scenes when collaborating
- [`../lrs-adapter/`](../lrs-adapter/) — boundary translator
- [`spec/LAYERS.md`](../../spec/LAYERS.md) — layering discipline
- [`docs/ns/registry.ttl`](../../docs/ns/registry.ttl) — public agent attestation registry
- [`docs/ns/passport.ttl`](../../docs/ns/passport.ttl) — capability passport + delegation credentials
- [`docs/ns/code.ttl`](../../docs/ns/code.ttl) — code artifacts as L3 domain
- [`docs/ns/amta.ttl`](../../docs/ns/amta.ttl) — multi-axis trust attestation
- [`docs/ns/abac.ttl`](../../docs/ns/abac.ttl) — attribute-based access control
- [`examples/personal-bridge/`](../../examples/personal-bridge/) — the bridge that runs cross-pod federation
