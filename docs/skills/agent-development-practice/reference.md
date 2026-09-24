# Agent development practice: every affordance

Derived from `applications/agent-development-practice/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 8 affordances.

## `adp.define_capability`

**Declare a capability space**

Declare a capability SPACE (not target) with rubric criteria as guides (not gates) and a Cynefin domain. Publishes adp:Capability + adp:RubricCriterion entries.

- Action: `urn:iep:action:adp:define-capability`
- HTTP: `POST {base}/adp/define_capability`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Capability name. |
| `cynefin_domain` | one of `Clear`, `Complicated`, `Complex`, `Chaotic`, `Confused` | yes | Which Cynefin domain the capability lives in. |
| `rubric_criteria` | array of object | yes | Guides for what we care about. Each is { name: string, description?: string }. |
| `description` | string | no | Optional description. |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.record_probe`

**Record a safe-to-fail probe**

Record a safe-to-fail probe. Always Hypothetical. REQUIRES amplification + dampening triggers stated up-front (prevents retconning).

- Action: `urn:iep:action:adp:record-probe`
- HTTP: `POST {base}/adp/record_probe`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `capability_iri` | string | yes | IRI of the adp:Capability this probe explores. |
| `variant` | string | yes | Variant name (e.g., "explicit-acknowledgment"). |
| `hypothesis` | string | yes | Hypothesis being tested. Always Hypothetical — explicitly NOT a claim about cause-effect. |
| `amplification_trigger` | string | yes | Pattern that, if observed, increases this probe's deployment. |
| `dampening_trigger` | string | yes | Pattern that, if observed, decreases this probe's deployment. |
| `time_bound_until` | string | no | When to revisit the probe regardless of triggers (ISO timestamp). |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.record_narrative_fragment`

**Record a narrative fragment**

Record a narrative observation against a probe. Always Hypothetical (observation, not causation claim). Carries situation signifiers + agent response + emergent signifier.

- Action: `urn:iep:action:adp:record-narrative-fragment`
- HTTP: `POST {base}/adp/record_narrative_fragment`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `probe_iri` | string | yes | IRI of the adp:Probe this fragment observes. |
| `context_signifiers` | array of string | yes | SenseMaker-style descriptive tags for the situation. |
| `response` | string | yes | Narrative description of what the agent did and what followed. |
| `emergent_signifier` | string | yes | Tag for what emerged from the response. |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.emerge_synthesis`

**Emerge a synthesis from fragments**

Compose multiple narrative fragments into a synthesis. Always Hypothetical. REQUIRES ≥2 coherent narratives — silent-collapse prevention.

- Action: `urn:iep:action:adp:emerge-synthesis`
- HTTP: `POST {base}/adp/emerge_synthesis`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `probe_iri` | string | yes | IRI of the adp:Probe being synthesized. |
| `fragment_iris` | array of string | yes | IRIs of fragments to compose. |
| `emergent_pattern` | string | yes | Description of the pattern surfaced. |
| `coherent_narratives` | array of string | yes | Equally-coherent readings of the synthesis. ≥2 required. |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.record_evolution_step`

**Record an amplify/dampen evolution decision**

Operator amplify/dampen decision. Asserted (operator commits) BUT REQUIRES explicit_decision_not_made — counter-cultural; forces writing down what is NOT being claimed.

- Action: `urn:iep:action:adp:record-evolution-step`
- HTTP: `POST {base}/adp/record_evolution_step`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `synthesis_iri` | string | yes | IRI of the synthesis the decision is based on. |
| `amplify_probe_iris` | array of string | no | IRIs of probes being amplified. |
| `dampen_probe_iris` | array of string | no | IRIs of probes being dampened. |
| `explicit_decision_not_made` | string | yes | REQUIRED. Free-text statement of what you are NOT claiming with this decision. |
| `next_revisit_at` | string | no | When to re-examine the decision (ISO timestamp). |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.refine_constraint`

**Refine a constraint emerged from synthesis cycles**

Refine a constraint emerged from synthesis cycles. Boundary (what NOT to do) + exits (when relaxed). REQUIRES emergedFrom — constraints emerge from sensemaking, not from declaration.

- Action: `urn:iep:action:adp:refine-constraint`
- HTTP: `POST {base}/adp/refine_constraint`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `capability_iri` | string | yes | Capability the constraint applies to. |
| `emerged_from_synthesis_iris` | array of string | yes | Synthesis IRIs the constraint emerged from. ≥1 required. |
| `boundary` | string | yes | What the agent must NOT do (or must operate within). |
| `exits_constraint` | string | yes | Conditions under which the constraint is relaxed. |
| `supersedes` | string | no | IRI of an earlier constraint this supersedes. |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.recognize_capability_evolution`

**Recognize an emergent capability as a passport:LifeEvent**

Record a passport:LifeEvent biographical record for an emergent capability. REQUIRES explicit_decision_not_made — humility-forward clauses travel with the agent across deployments.

- Action: `urn:iep:action:adp:recognize-capability-evolution`
- HTTP: `POST {base}/adp/recognize_capability_evolution`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `capability_iri` | string | yes | Capability being recognized. |
| `evolution_type` | one of `EmergentRecognition`, `ConstraintRefinement`, `VariantAmplified`, `VariantDampened` | yes | Kind of evolution event. |
| `emerged_from_iris` | array of string | no | Synthesis/constraint IRIs the recognition emerged from. |
| `olke_stage` | one of `Tacit`, `Articulate`, `Collective`, `Institutional` | yes | Knowledge maturity stage (OLKE). |
| `explicit_decision_not_made` | string | yes | REQUIRED. Carries humility forward across deployments. |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

## `adp.list_cycle`

**Load the operator's probe cycle state**

Load the operator's probe cycle state from the pod: capabilities, probes, fragments, syntheses, evolution steps, constraints, capability evolution events.

- Action: `urn:iep:action:adp:list-cycle`
- HTTP: `POST {base}/adp/list_cycle`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `pod_url` | string | no | Pod URL. |
| `operator_did` | string | no | Operator DID. |

