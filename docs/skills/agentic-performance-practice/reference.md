# Agentic performance practice: every affordance

Derived from `applications/agentic-performance-practice/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 12 affordances.

## `agp.read_intervention_methods`

**Read performance consulting and intervention methods**

Discover the versioned consulting and management cycle and the implementation method for each intervention. Profiles carry steps, revision links, required work products and evidence criteria. Contextualize and diagnose before choosing a method; gap analysis is Knowable-only.

- Action: `urn:iep:action:agp:read-intervention-methods`
- HTTP: `GET {base}/performance/methods` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/ld+json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | string | no | Optional profile token or canonical IRI; omit for the catalogue. consulting is the full performance consulting and management cycle. |
| `format` | one of `jsonld`, `markdown`, `turtle` | no | Representation to read. |

## `agp.review_method_evidence`

**Check intervention method evidence coverage**

Check supplied artifact pointers and notes against the selected method criteria. Returns missing-evidence or documented-unverified, coverage percent and missing work products. Does not inspect linked contents, approve quality, verify authorship, select an intervention or claim performance effects. No records are written.

- Action: `urn:iep:action:agp:review-method-evidence`
- HTTP: `POST {base}/performance/methods/review` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | string | yes | Method token or canonical IRI from the catalogue. |
| `evidence` | array of object | no | Up to 200 objects, each {criterion: exact criterion IRI from the profile, artifact: absolute http/https/urn IRI, note: non-empty explanation (max 2000 characters)}. Omit or send [] to see all missing evidence. Caller approval or verification flags are rejected. |

## `agp.contextualize_situation`

**Contextualize a performance situation (regime-first)**

Publish an agp:PerformanceSituation and place its work regime BEFORE choosing any method. Records regimeSource (derived|asserted|default-gap-intent|unclassified); only a derived regime may later gap-analyse or accrue calibration. Routes to the regime-appropriate method (apply-practice/gap-analysis/dispositional-read/stabilise-first/classify-first).

- Action: `urn:iep:action:agp:contextualize-situation`
- HTTP: `POST {base}/agp/contextualize_situation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `situation_statement` | string | yes | What the performer is to perform, in context. |
| `performer_iri` | string | no | IRI of the agp:Performer (human, agent, or team). |
| `direction` | one of `H2H`, `H2A`, `A2H`, `A2A` | no | Performance direction. |
| `regime` | one of `Evident`, `Knowable`, `Emergent`, `Turbulent` | no | Work regime, if asserted. Prefer leaving unset so it is derived from evidence. |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.define_capability`

**Compose a capability from skills + tools + knowledge**

Publish an agp:Capability composed of its constituent skills, tools, and knowledge (agp:composedOf). A capability with no constituents is rejected by SHACL — an empty capability is not productive. Knowledge components carry a codifiability kind (Recorded/Trained/Judged/Lived/Innate).

- Action: `urn:iep:action:agp:define-capability`
- HTTP: `POST {base}/agp/define_capability`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Capability name. |
| `skill_iris` | array of string | no | IRIs of constituent agp:Skill descriptors. |
| `tool_iris` | array of string | no | IRIs of constituent agp:Tool descriptors (may skos:closeMatch ac:AgentTool). |
| `knowledge` | array of object | no | Knowledge components, each { name: string, kind: Recorded\|Trained\|Judged\|Lived\|Innate }. |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.map_affordance`

**Declare a performance affordance a situation offers**

Publish an agp:PerformanceAffordance — an action-possibility a situation offers a performer — and the agp:Capability it requires to be actualized. This is the ECOLOGICAL affordance (what the situation affords given capability), DISTINCT from the L0 iep:Affordance REST transition.

- Action: `urn:iep:action:agp:map-affordance`
- HTTP: `POST {base}/agp/map_affordance`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `situation_iri` | string | yes | IRI of the agp:PerformanceSituation that affords this. |
| `affordance_statement` | string | yes | The action-possibility offered. |
| `requires_capability_iri` | string | yes | IRI of the agp:Capability this affordance requires (SHACL: required). |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.actualize`

**Record an actualization (capability x situation x affordance -> performance)**

Record an agp:Actualization — a capability engaging a situation's affordance to yield agp:Performance. An observed `success` / `score_scaled` is recorded on the actualization as `iep:success` / `agp:scoreScaled`; omit them and nothing is asserted. ★ This does NOT project to an LRS. The handler returns `xapiStatementId: null` unconditionally, because projecting into Foxxi's LRS from agp would invert the dependency arrow between the two verticals — its own comment says so. A custom xAPI Profile carrying capability / actualizedAffordance / regime as context extensions is the intended shape if that projection is ever wired, and it would be wired at the Foxxi end. SHACL requires the actualization to reference capability, situation, affordance, AND the yielded performance.

- Action: `urn:iep:action:agp:actualize`
- HTTP: `POST {base}/agp/actualize`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `situation_iri` | string | yes | IRI of the agp:PerformanceSituation. |
| `capability_iri` | string | yes | IRI of the agp:Capability engaged. |
| `affordance_iri` | string | yes | IRI of the agp:PerformanceAffordance actualized. |
| `performance_statement` | string | yes | What was performed. |
| `success` | boolean | no | Outcome, if observed. Recorded on the actualization as `iep:success` (xsd:boolean). Omit it and nothing is asserted — an unobserved outcome is not a false one. |
| `score_scaled` | number | no | Scaled score in [-1,1], if observed. Recorded as `agp:scoreScaled` (xsd:double), mirroring xAPI result.score.scaled. A value outside [-1,1] is REFUSED with 400 rather than clamped, because a clamped score is a measurement nobody took. |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.diagnose`

**Diagnose a performance situation (regime-routed)**

Read a situation's regime and route to the regime-appropriate method. For the Knowable regime ONLY, run the six-factor cause analysis — ★ the "and only when the regime is derived" that used to stand here is not what the engine does. The Knowable branch runs `buildFactors(...)` for ANY Knowable regardless of source, and the handler emits `factor` on a Knowable domain alone; driven with an asserted Knowable and no trajectories it gap-analyses. The derived-only gate that DOES exist is on CALIBRATION, in performance-calibration.ts, not on gap analysis. The six-factor analysis names the dominant factor, and gap-analysis is never surfaced for a non-Knowable situation.

- Action: `urn:iep:action:agp:diagnose`
- HTTP: `POST {base}/agp/diagnose`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `situation` | object | no | Inline agp:PerformanceSituation to diagnose (preferred): { id, performer{id,kind,role}, workContext, competency, observed, frequency, criticality, modalStatus, provenance, domain? }. |
| `situation_iri` | string | no | IRI of the agp:PerformanceSituation to diagnose (resolved against pod_url). Provide this OR an inline `situation`. |
| `exemplary` | string | no | What good looks like — only used (and only meaningful) for the Knowable regime. |
| `factor_evidence` | object | no | Per-factor adequacy evidence for the Knowable six-factor gap analysis. |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.plan_intervention`

**Emit a regime-appropriate intervention plan**

Emit an agp:InterventionPlan from a diagnosis. Instruction (a course) is warranted only when the dominant cause is a knowledge/skill deficiency in a Knowable situation; otherwise the plan targets environment factors (information, instrumentation, incentives) or routes to probes (Emergent) / stabilisation (Turbulent).

- Action: `urn:iep:action:agp:plan-intervention`
- HTTP: `POST {base}/agp/plan_intervention`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `diagnosis` | object | no | Inline agp:Diagnosis to plan from (preferred): { situationId, regimeSource, method, domain?, rootCauses, skillDeficiency, ... }. |
| `situation` | object | no | The agp:PerformanceSituation the diagnosis is about (required alongside an inline diagnosis). |
| `diagnosis_iri` | string | no | IRI of the agp:Diagnosis to plan from (resolved against pod_url). Provide this OR an inline `diagnosis` + `situation`. |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.evaluate_intervention`

**Evaluate an intervention (four levels) and calibrate**

Publish an agp:InterventionEvaluation (reaction / capability / transfer / outcome) attesting whether an intervention worked, closing the loop via iep:supersedes and feeding the reflexive calibration profile. Only derived-Knowable outcomes accrue calibration authority.

- Action: `urn:iep:action:agp:evaluate-intervention`
- HTTP: `POST {base}/agp/evaluate_intervention`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `intervention_iri` | string | yes | IRI of the agp:Intervention being evaluated. |
| `outcome_success` | boolean | no | Whether the targeted performance outcome improved, if observed. |
| `note` | string | no | Evaluation note; may include an explicit-claim-not-made statement. |
| `plan` | object | no | Inline agp:InterventionPlan the evaluation judges — { diagnosis, selected[] }. Required to run the four-level engine. |
| `situation` | object | no | The agp:PerformanceSituation the plan targeted (required alongside an inline plan). |
| `new_observed` | string | no | The re-measured observed performance after the intervention. Supply only if actually re-measured — without it the verdict is honestly "too-early". |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.list_practice`

**Load the operator's performance-practice state**

Read the operator's agp: state from the pod: situations + regimes, capabilities + constituents, performance affordances, actualizations + performances, diagnoses, intervention plans + evaluations, and the calibration profile.

- Action: `urn:iep:action:agp:list-practice`
- HTTP: `POST {base}/agp/list_practice`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

## `agp.prepare_readiness_evidence`

**Derive portable performance-readiness evidence**

Derive (never caller-assert) a readiness decision for one exact candidate digest from a held-out evaluation rule. Returns a typed canonical-JSON + RDF graph binding the AGP diagnosis/evaluations, Foxxi xAPI statements, and LER/CLR portable record. This action does not publish, sign, approve, deploy, or mutate anything; a separate authenticated agent publishes it through the ordinary Interego signed-descriptor path.

- Action: `urn:iep:action:agp:prepare-readiness-evidence`
- HTTP: `POST {base}/agp/prepare_readiness_evidence`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `candidate_digest` | string | yes | 64-hex SHA-256 digest of the exact candidate evaluated. |
| `regime` | one of `Evident`, `Knowable`, `Emergent`, `Turbulent` | yes | Work regime in which the evaluation was interpreted. |
| `evaluation_suite_digest` | string | yes | 64-hex SHA-256 digest of the held-out evaluation suite. |
| `total_cases` | number | yes | Number of held-out cases executed. |
| `passed_cases` | number | yes | Number of held-out cases passed. |
| `issued_at` | string | yes | ISO-8601 time asserted for this prepared attestation. Explicit input keeps identical requests byte-deterministic; publication time remains a separate descriptor fact. |
| `minimum_cases` | number | no | Evidence sufficiency floor (default 4). |
| `allowed_failures` | number | no | Failures permitted by the declared rule (default 0). |
| `diagnosis_descriptor_url` | string | yes | Signed AGP diagnosis descriptor. |
| `evaluation_descriptor_urls` | array of string | yes | Signed AGP evaluation descriptor(s). |
| `xapi_statement_ids` | array of string | yes | Foxxi xAPI statement IRIs used as experience evidence. |
| `portable_record_descriptor_url` | string | yes | Signed LER/CLR/Open Badges portable-record descriptor. |

## `agp.extend_standards`

**Extend a standard (xAPI / IEEE-LER / ADL-TLA) — emergent, learnable, teachable**

Author an extension to a standard IN THE FLOW OF WORK: a new xAPI context extension, an xAPI Profile fragment (concepts/templates/patterns), or an IEEE-LER / ADL-TLA term. COMPOSES Foxxi's standards (built with Foxxi's own buildProfileDoc + served LER/TLA namespaces) — never forks the spec. Returns a conformant, self-descriptive artifact + a publishable iep:StandardsExtension descriptor other agents discover and reuse (distributed) + in-flow performance support (what this builds, how to learn it, how to teach it). Authoring this is itself a learnable agp:Capability.

- Action: `urn:iep:action:agp:extend-standards`
- HTTP: `POST {base}/agp/extend_standards`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | one of `XapiContextExtension`, `XapiProfileFragment`, `LerTerm`, `TlaTerm` | yes | What to author. |
| `name` | string | yes | Local slug for the new term/extension (e.g. "collaborationDepth"). |
| `definition` | string | yes | Human-readable definition of the new term/extension. |
| `label` | string | no | Display label (defaults to name). |
| `extends_standard` | string | no | IRI of the standard being extended (defaults per kind: the agp xAPI Profile, or the IEEE-LER / ADL-TLA namespace). |
| `subclass_of` | string | no | For LerTerm/TlaTerm: the superclass IRI to compose onto. |
| `builds_capability` | string | no | IRI of the agp:Capability this extension builds/demonstrates. |
| `pod_url` | string | no | Pod URL to write to / read from. |
| `operator_did` | string | no | Operator / performer DID. |

