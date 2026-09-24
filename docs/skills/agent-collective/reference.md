# Agent collective: every affordance

Derived from `applications/agent-collective/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 5 affordances.

## `ac.author_tool`

**Author a new agent tool**

Author a new agent tool. Published Hypothetical (iep:modalStatus = Hypothetical) — fresh tools are not trusted yet. Source code stored as content-addressed pgsl:Atom.

- Action: `urn:iep:action:ac:author-tool`
- HTTP: `POST {base}/ac/author_tool`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tool_name` | string | yes | Tool name. |
| `source_code` | string | yes | Source code string. Stored as content-addressed atom. |
| `affordance_action` | string | yes | IRI of the iep:Action this tool exposes. |
| `affordance_description` | string | no | Free-text description of the affordance. |
| `pod_url` | string | no | Pod URL. |
| `authoring_agent_did` | string | no | Authoring agent DID. |

## `ac.attest_tool`

**Record an attestation against a tool**

Record an amta:Attestation against a tool. Direction is Self (the tool author attests to their own tool) or Peer (another agent attests after using). Multiple axes possible.

- Action: `urn:iep:action:ac:attest-tool`
- HTTP: `POST {base}/ac/attest_tool`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tool_iri` | string | yes | IRI of the ac:AgentTool being attested. |
| `axis` | one of `correctness`, `efficiency`, `safety`, `generality` | yes | amta: axis being attested. |
| `rating` | number | yes | Rating in [0, 1]. |
| `direction` | one of `Self`, `Peer` | yes | Self vs Peer. |
| `execution_evidence` | string | no | IRI of evidence event. |
| `pod_url` | string | no | Pod URL. |
| `authoring_agent_did` | string | no | Attesting agent DID. |

## `ac.promote_tool`

**Promote a Hypothetical tool to Asserted**

Promote Hypothetical tool to Asserted. REFUSES unless attestation threshold is met (default: ≥5 self + ≥2 peer + ≥2 axes covered). Publishes successor with iep:supersedes.

- Action: `urn:iep:action:ac:promote-tool`
- HTTP: `POST {base}/ac/promote_tool`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tool_iri` | string | yes | IRI of the Hypothetical ac:AgentTool to promote. |
| `self_attestations` | integer | yes | Verified self-attestation count. |
| `peer_attestations` | integer | yes | Verified peer-attestation count. |
| `axes_covered` | array of string | yes | amta axes covered by accumulated attestations. |
| `threshold_self` | integer | no | Override default self-attestation threshold. |
| `threshold_peer` | integer | no | Override default peer-attestation threshold. |
| `threshold_axes` | integer | no | Override default axes-covered threshold. |
| `enforce_constitutional_constraints` | boolean | no | When true, the publisher consults active ieh:PromotionConstraint descriptors on the pod and enforces them in addition to the threshold policy. Substrate-enforced downward causation rather than agent-mediated. |
| `pod_url` | string | no | Pod URL. |
| `authoring_agent_did` | string | no | Promoting agent DID. |

## `ac.bundle_teaching_package`

**Bundle a teaching package (artifact + practice)**

Bundle a tool with the practice context (narratives + synthesis + constraint + capability-evolution) into an ac:TeachingPackage another agent can fetch. REFUSES if no narrative fragments — partial teaching transfers artifact without practice context.

- Action: `urn:iep:action:ac:bundle-teaching-package`
- HTTP: `POST {base}/ac/bundle_teaching_package`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tool_iri` | string | yes | IRI of the ac:AgentTool being taught. |
| `narrative_fragment_iris` | array of string | yes | IRIs of narrative fragments. ≥1 required. |
| `synthesis_iri` | string | yes | IRI of the synthesis included. |
| `constraint_iri` | string | no | IRI of an associated constraint. |
| `capability_evolution_iri` | string | no | IRI of a capability-evolution event. |
| `olke_stage` | one of `Tacit`, `Articulate`, `Collective`, `Institutional` | yes | OLKE knowledge maturity stage. |
| `pod_url` | string | no | Pod URL. |
| `authoring_agent_did` | string | no | Authoring agent DID. |

## `ac.record_cross_agent_audit`

**Record a cross-agent audit entry in the human owner's pod**

Record an ac:CrossAgentAuditEntry for a chime-in / response / check-in exchange. The audit lives in the HUMAN OWNER's pod (not the agent's) so the human can audit what their agent said + received.

- Action: `urn:iep:action:ac:record-cross-agent-audit`
- HTTP: `POST {base}/ac/record_cross_agent_audit`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `exchange_iri` | string | yes | IRI of the AgentRequest / AgentResponse / ChimeIn / CheckIn. |
| `audited_agent_did` | string | yes | DID of the agent whose action is being audited. |
| `direction` | one of `Inbound`, `Outbound` | yes | Inbound (received) or Outbound (sent). |
| `human_owner_did` | string | yes | DID of the human owner (audit target). |
| `pod_url` | string | no | Pod URL. |
| `authoring_agent_did` | string | no | Authoring agent DID. |

