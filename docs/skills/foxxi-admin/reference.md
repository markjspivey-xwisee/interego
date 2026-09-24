# Foxxi content intelligence, administration: every affordance

Derived from `applications/foxxi-content-intelligence/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 73 affordances.

## `foxxi.read_intervention_methods`

**Read performance consulting and intervention methods**

Discover the versioned consulting and management cycle and the implementation method for each intervention. Profiles carry steps, revision links, required work products and evidence criteria. Contextualize and diagnose before choosing a method; gap analysis is Knowable-only.

- Action: `urn:iep:action:foxxi:read-intervention-methods`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/performance/methods` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/ld+json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | string | no | Optional profile token or canonical IRI; omit for the catalogue. consulting is the full performance consulting and management cycle. |
| `format` | one of `jsonld`, `markdown`, `turtle` | no | Representation to read. |

## `foxxi.review_method_evidence`

**Check intervention method evidence coverage**

Check supplied artifact pointers and notes against the selected method criteria. Returns missing-evidence or documented-unverified, coverage percent and missing work products. Does not inspect linked contents, approve quality, verify authorship, select an intervention or claim performance effects. No records are written.

- Action: `urn:iep:action:foxxi:review-method-evidence`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/performance/methods/review` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | string | yes | Method token or canonical IRI from the catalogue. |
| `evidence` | array of object | no | Up to 200 objects, each {criterion: exact criterion IRI from the profile, artifact: absolute http/https/urn IRI, note: non-empty explanation (max 2000 characters)}. Omit or send [] to see all missing evidence. Caller approval or verification flags are rejected. |

## `foxxi.ingest_content_package`

**[admin] Ingest a SCORM/cmi5/xAPI content package**

Unwrap a SCORM 1.2 / SCORM 2004 / cmi5 zip package, run the Foxxi storyline parser (deterministic structural rendering + Whisper-transcribed audio + concept extraction with morphology + prerequisite-edge inference), and emit three-stratum descriptors (fxs structural, fxk knowledge, fxa activity-schema) to the tenant pod. SHACL-validates against the Foxxi vocab; non-clean packages are flagged in the catalog with parse_status="violations".

- Action: `urn:iep:action:foxxi:ingest-content-package`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ingest_content_package`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `zip_base64` | string | yes | Content package as base64-encoded zip. |
| `tenant_pod_url` | string | yes | Tenant pod URL where the parsed descriptors land. |
| `authoritative_source` | string | yes | DID of the content publisher (e.g., did:web:acme-training.example). |
| `course_id` | string | no | Stable catalog course_id (default: derived from manifest identifier). |
| `lms_source` | string | no | Originating LMS connector ID (default: "Direct upload"). |

## `foxxi.publish_authoring_policy`

**[admin] Publish an authoring-tool / standard policy**

Declare which authoring tools (Articulate Storyline, Adobe Captivate, Camtasia, etc.) and which package standards (SCORM 1.2, SCORM 2004, cmi5, xAPI) are accepted into the catalog. Reuses the abac policy descriptor pattern; ingestion rejects packages outside the accepted set.

- Action: `urn:iep:action:foxxi:publish-authoring-policy`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_authoring_policy`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | yes | Tenant pod URL. |
| `accepted_tools` | array | yes | Array of accepted authoring tool labels. |
| `accepted_standards` | array | yes | Array of accepted package standard labels. |
| `effective_from` | string | no | ISO 8601 timestamp the policy becomes effective; default: now. |

## `foxxi.connect_lms`

**[admin] Register an external LMS connector**

Register an external LMS (Cornerstone OnDemand, Workday Learning, SAP SuccessFactors, etc.) as a content source. Composes with src/connectors/ — uses the existing OAuth 2.0 / Basic-auth / SCORM-Cloud-API flows where supported. The connector's sync schedule is recorded as a foxxi:LmsConnection descriptor on the tenant pod with the connector's auth_warning surfaced if the credentials need rotation.

- Action: `urn:iep:action:foxxi:connect-lms`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/connect_lms`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | yes | Tenant pod URL. |
| `connector_id` | string | yes | Stable connector ID (e.g., "cornerstone-prod"). |
| `product` | string | yes | LMS product name (e.g., "Cornerstone OnDemand"). |
| `instance` | string | yes | LMS instance URL or domain (e.g., "acme-training.csod.com"). |
| `auth_method` | string | yes | Auth method (e.g., "OAuth 2.0 (corporate)", "Basic+API key"). |
| `sync_frequency` | string | no | Human-readable sync frequency (default: "every 6 hours"). |

## `foxxi.assign_audience`

**[admin] Assign a course to an audience group via a policy**

Bind a course to an audience group (by audience_tag) via a Foxxi assignment policy descriptor. Trigger options: on-hire, on-role-change, on-cycle (annually), manual. Due-by relative days control when the assignment expires.

- Action: `urn:iep:action:foxxi:assign-audience`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/assign_audience`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | yes | Tenant pod URL. |
| `course_iri` | string | yes | IRI of the course (must already be ingested). |
| `audience_tag` | string | yes | Audience tag this course is assigned to (e.g., "support"). |
| `requirement_type` | string | yes | One of: required \| recommended. |
| `trigger` | string | yes | One of: on-hire \| on-role-change \| on-cycle \| manual. |
| `due_relative_days` | number | yes | Days from trigger event after which the assignment is overdue. |

## `foxxi.coverage_query`

**[admin] Query concept coverage across the catalog**

Privacy-respecting coverage query: across the catalog, which concepts are taught vs only mentioned, by which courses, in which categories. Defaults to v2 merkle-attested-opt-in (count of courses per concept); v3 zk-distribution mode returns a histogram of coverage shape (concepts taught in 1 course / 2-5 / 6-10 / 10+) with per-bucket DP noise. Composes with the existing applications/_shared/aggregate-privacy/ ladder.

- Action: `urn:iep:action:foxxi:coverage-query`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/coverage_query`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | yes | Tenant pod URL. |
| `category_filter` | string | no | Optional category filter (e.g., "Power Systems / Technical"). |
| `concept_filter` | string | no | Optional concept label substring filter. |
| `privacy_mode` | string | no | One of: abac \| merkle-attested-opt-in (v2, default) \| zk-distribution (v3 histogram). |
| `epsilon` | number | no | DP ε budget for zk-distribution mode. |
| `distribution_edges` | array | no | Bucket-edge boundaries (decimal-string bigints) for zk-distribution. |
| `distribution_max_value` | string | no | Upper bound for the last bucket in zk-distribution. |

## `foxxi.publish_concept_map`

**[admin] Publish a course's extracted concept map as a federated artifact**

Publish the fxk: knowledge-stratum graph for a course as a federated pod artifact (using the federation_iri_base pattern from federation_payload.json). Lets peer tenants discover + cite concept nodes by IRI without re-ingesting the course content.

- Action: `urn:iep:action:foxxi:publish-concept-map`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_concept_map`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | yes | Tenant pod URL. |
| `course_iri` | string | yes | Course IRI. |
| `federation_share_with` | array | no | Optional list of peer-tenant DIDs the concept map is explicitly shared with (default: pod ACL). |

## `foxxi.publish_compliance_evidence`

**[admin] Publish L&D compliance evidence (SOC 2 / EU AI Act / NIST RMF)**

Emit an ops event (assignment/completion/exception/audit) wrapped via compliance-overlay so the L&D activity becomes a framework-cited descriptor. Composes integrations/compliance-overlay/ + src/ops/ — same path the substrate uses for its own SOC 2 evidence.

- Action: `urn:iep:action:foxxi:publish-compliance-evidence`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_compliance_evidence`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | yes | Tenant pod URL. |
| `event_type` | string | yes | One of: assignment-created \| completion \| exception \| audit-action. |
| `event_payload` | object | yes | Event payload (shape varies by event_type — assignment payload includes user_id + course_iri + due_at; completion payload includes user_id + course_iri + completed_at; etc.). |
| `framework` | string | no | Compliance framework to cite (default: "soc2"; alternatives: "eu-ai-act", "nist-rmf"). |
| `controls` | array | no | Optional explicit control IRIs (default: framework's default L&D controls). |

## `foxxi.issue_completion_credential`

**[admin] Issue a W3C VC / Open Badges 3.0 completion credential**

Mint a W3C Verifiable Credential (Open Badges 3.0-shaped) for a learner who completed a course, sign it with the tenant's deterministic Ed25519 issuer key (eddsa-jcs-2022 DataIntegrityProof), and publish it to the learner's pod in the foxxi-wallet/ container as a fxa:CourseCompletionCredential descriptor. The signed VC verifies independently with any W3C VC verifier; the descriptor is discoverable via iep:discover() filtered on dct:conformsTo.

- Action: `urn:iep:action:foxxi:issue-completion-credential`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/issue_completion_credential`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner's WebID / DID — becomes credentialSubject.id on the VC. |
| `learner_pod_url` | string | yes | Learner's pod where the credential is published (typically same as tenant_pod_url for tenant-hosted wallets). |
| `course_id` | string | yes | Course identifier (e.g. golf-explained). |
| `course_title` | string | yes | Human-readable course title (becomes Achievement.name). |
| `course_description` | string | no | Optional achievement description. |
| `criterion_narrative` | string | no | Optional natural-language statement of the completion criterion (becomes Achievement.criteria.narrative). |
| `aligned_skills` | array | no | Optional array of competency alignments (each: { targetCode, targetName, targetFramework?, targetFrameworkUrl?, proficiencyLevel? }). Becomes Achievement.alignment[]. |
| `evidence` | array | no | Optional supporting evidence array (each: { type, id, narrative? }) — e.g. cited slides from a Q&A turn. |
| `derived_from_experiences` | array | no | Optional IRIs of the raw xAPI experience records this completion was derived from. Recorded as prov:wasDerivedFrom on the credential descriptor + fxa:LearningExperience evidence on the VC, so an auditor can walk credential → raw events. |

## `foxxi.export_clr`

**Export a learner's Comprehensive Learner Record (1EdTech CLR 2.0)**

Walk the learner's pod via iep:discover(), aggregate every fxa:CourseCompletionCredential + fxa:CompetencyAssertion the pod holds, verify each embedded W3C VC's DataIntegrityProof, and return a 1EdTech CLR 2.0-shaped envelope wrapping all verified entries. Each entry preserves its own proof so downstream verifiers can re-check any single credential without trusting the envelope.

- Action: `urn:iep:action:foxxi:export-clr`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/export_clr`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner's WebID/DID — also cross-checked against each credential's credentialSubject.id. |
| `learner_pod_url` | string | yes | Pod root to walk. |

## `foxxi.assemble_learner_record`

**Assemble an Enterprise Learner Record (IEEE P2997 — human or AI agent)**

Compose an IEEE P2997 Enterprise Learner Record — the unified, provenance-pointed aggregate of a subject's path. Pulls learning EXPERIENCES + on-the-job PERFORMANCE records from Foxxi-as-LRS xAPI statements, CREDENTIALS from the subject's pod wallet (reusing the verified CLR composer), and COMPETENCIES ranked across three bases: performance-verified (Asserted — proven by successful production work, supersedes weaker evidence), credentialed (Asserted), and inferred (Hypothetical — predicted from a passed/completed experience alone; iep:modalStatus keeps the prediction honest). Actor-agnostic: the subject may be a human learner/performer OR an AI agent learning + exercising tools — set actor_kind accordingly. Every entry carries a raw-data-location pointer per the P2997 data-ownership requirement. Pure read; non-admins may assemble their own human record, and any caller may assemble an agent capability record (agent capabilities are discoverable, like the agent registry).

- Action: `urn:iep:action:foxxi:assemble-learner-record`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/assemble_learner_record`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Subject's WebID/DID — the ELR subject; cross-checked against credential subjects. |
| `learner_pod_url` | string | no | Subject's pod root to walk for wallet credentials (defaults to the tenant pod). |
| `learner_name` | string | no | Optional subject display name for the ELR header. |
| `actor_kind` | string | no | human (default) or agent. Agent capability records are assemblable by any caller; human records are self/admin-only. |

## `foxxi.record_performance`

**Record a performance event (on-the-job work — human or AI agent)**

Record one unit of on-the-job production work as an xAPI `performed` statement — the IEEE P2997 employment-history leg, kept distinct from training experiences. The performer (actor_did) may be a human exercising a workplace task OR an AI agent exercising a tool; the authenticated caller is the attesting observer, recorded in provenance. Performance records feed the ELR competency engine: successful production work yields a performance-verified (Asserted) competency that SUPERSEDES a training-only inference for the same competency — closing the data-informed loop.

- Action: `urn:iep:action:foxxi:record-performance`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_performance`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `actor_did` | string | yes | Performer's DID — a human learner/performer or an AI agent. Defaults to the caller. |
| `task_name` | string | yes | Human-readable task or tool name (e.g. "Resolve a tier-2 support ticket", "Use the web-search tool"). Becomes the xAPI Activity name + (absent activity_type) the competency label. |
| `task_id` | string | no | Stable task/tool identifier; derived from task_name if omitted. |
| `activity_type` | string | no | Optional DOMAIN activity-type IRI you define for your vertical (e.g. urn:ttt:Move). Becomes object.definition.type; the ELR competency engine AGGREGATES same-type executions across instances under one competency. This is how a vertical-creator declares the publishing-layer vocabulary that makes competencies meaningful. Omit to use the generic ProductionTask wrapper (competency then keys off task_name). |
| `success` | boolean | yes | Did the performer complete the task successfully? |
| `quality` | number | no | Outcome quality, 0..1 (becomes xAPI result.score.scaled). |
| `duration_iso` | string | no | ISO 8601 duration the task took (e.g. PT4M30S). |
| `cost_usd` | number | no | Optional cost of the execution in USD (useful for AI-agent performance economics). |
| `actor_kind` | string | no | human (default) or agent. |

## `foxxi.record_agent_trajectory`

**Record an agentic-native trajectory (modal · poly-granular · composable)**

Record an agent run in the AGENTIC-NATIVE form — not as flat xAPI statements but as a trajectory of Context Descriptors emergent from Interego L1: each step is MODAL (Hypothetical = an intention/plan, Asserted = executed, Counterfactual = a rejected branch — with iep:supersedes chains), POLY-GRANULAR (task ▸ subtask ▸ tool-call, the PGSL principle), and COMPOSABLE (trajectories merge via the L1 union/restriction algebra). The native trajectory is the source of truth; the bridge projects only the Asserted tool-call steps down to xAPI `performed` statements (which the IEEE P2997 ELR then reads). Intentions, counterfactuals, and the task hierarchy are retained ONLY in the native trajectory — xAPI structurally cannot hold them, and the projection reports exactly what it dropped.

- Action: `urn:iep:action:foxxi:record-agent-trajectory`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_agent_trajectory`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_did` | string | yes | The agent whose run this trajectory records. |
| `agent_name` | string | no | Optional agent display name. |
| `steps` | array of object | yes | Ordered trajectory steps. Each: { modal_status (Hypothetical\|Asserted\|Counterfactual), granularity (task\|subtask\|tool-call), verb, object_id, object_name, id?, parent_id?, supersedes_id?, was_derived_from?[], result?{success,quality,note} }. |

## `foxxi.get_agent_trajectory`

**Get an agent's native trajectory (what the xAPI projection drops)**

Return an agent's full agentic-native trajectory — every step at every modal status (including the Hypothetical intentions + Counterfactual branches xAPI cannot represent) and every granularity. Includes a projection summary: how many steps reach xAPI vs. how many are retained only in the native form. Agent trajectories are discoverable, like the agent capability registry.

- Action: `urn:iep:action:foxxi:get-agent-trajectory`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/get_agent_trajectory`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_did` | string | yes | The agent whose trajectory to retrieve. |

## `foxxi.assess_agent_disposition`

**Assess a team of agents' disposition (Agent Performance Technology)**

Read a team of agents' DISPOSITION from their trajectories — deliberately NOT a gap analysis. There is no ideal future state and no score-vs-exemplary; the gap model only fits knowable work, and a team of agents is a complex, adaptive system. Returns the modal balance (deliberation / exploration / plan-revision propensities), named dispositions, a WORK-REGIME placement of the team's behaviour with the decision stance it calls for, and a VECTOR of drift from the present — not a destination. If a safe-to-fail probe has been run on this team, also returns the causal read (the interventional + counterfactual effect).

- Action: `urn:iep:action:foxxi:assess-agent-disposition`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/assess_agent_disposition`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_dids` | array of string | yes | The DIDs of the agents forming the team to assess. |

## `foxxi.run_performance_probe`

**Run a safe-to-fail performance probe on an agent team**

Record a safe-to-fail probe on an agent team — the disposition-based intervention. A probe nudges a CONSTRAINT (an affordance scope, a delegation bound, a connecting constraint), never an outcome: manage constraints, not targets. It is a deliberate, reversible change: the handler snapshots the team's disposition before the change as the causal baseline. The probe declares its safe-to-fail portfolio role (coherent / oblique / contradictory) and its weak signals — what would tell the consultant to amplify vs. dampen it. Re-assess the team afterward (assess_agent_disposition) to get the interventional + counterfactual causal read.

- Action: `urn:iep:action:foxxi:run-performance-probe`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/run_performance_probe`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_dids` | array of string | yes | The agent team the probe is run on. |
| `constraint_target` | string | yes | The constraint being nudged — e.g. "delegation-scope", "web-search-affordance", "connecting-constraint:researcher-summariser". Never an outcome. |
| `change` | string | yes | Human description of the constraint nudge (e.g. "broaden the delegation scope so the researcher may sub-delegate retrieval"). |
| `coherence` | string | yes | Safe-to-fail portfolio role: coherent \| oblique \| contradictory. |
| `hypothesized_effect` | string | yes | What the consultant expects the nudge to do to the disposition (a hypothesis, not a target). |
| `amplify_signal` | string | yes | The weak signal that would say: amplify this probe. |
| `dampen_signal` | string | yes | The weak signal that would say: dampen / withdraw this probe. |

## `foxxi.open_agent_evaluation`

**Open an agent / harness evaluation cohort**

Open a named, shared evaluation — the place where several teams' competing agents or harnesses are compared head-to-head. Carries the decision the cohort exists to inform (e.g. "should we standardise on one agentic harness, or fund several?") and an optional shared task set so the comparison is apples-to-apples. The motivating case: an enterprise where multiple teams independently build agents/harnesses and cannot agree how to evaluate one against another. Candidates enrol via foxxi.request_evaluation_enrollment; runs are recorded via foxxi.record_external_agent_run; the portfolio read is foxxi.compare_agent_evaluation.

- Action: `urn:iep:action:foxxi:open-agent-evaluation`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/open_agent_evaluation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Human-readable name for the evaluation cohort. |
| `decision_question` | string | yes | The decision this cohort exists to inform — e.g. "Which coding-agent harness should the platform team adopt — or should we keep more than one?". |
| `task_set` | array of object | no | Optional shared task set for apples-to-apples comparison. Each: { name, id?, description? } (a plain string is accepted as a task name). |

## `foxxi.request_evaluation_enrollment`

**Request enrollment of an agent into an evaluation cohort (cross-pod delegation)**

A team requests that its agent / harness join an evaluation cohort as a candidate. The candidate agent is identified by its own DID — which may live on a different team's pod — so enrolling it is a cross-pod delegation: the request starts as `requested` and does not enter the comparison until the evaluation owner accepts it (foxxi.decide_evaluation_candidate). This request → accept handshake is the delegation grant. Records the team, and the harness/runtime the agent is built on, so the portfolio read can attribute behaviour to the harness.

- Action: `urn:iep:action:foxxi:request-evaluation-enrollment`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/request_evaluation_enrollment`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `evaluation_id` | string | yes | The evaluation cohort to enrol into. |
| `agent_did` | string | yes | The candidate agent's DID — may resolve to another team's pod. |
| `agent_name` | string | no | Display name for the candidate agent. |
| `team` | string | yes | The team that owns / submitted this candidate. |
| `harness` | object | no | The harness / runtime the agent is built on: { name?, version?, runtime? }. |
| `pod_url` | string | no | Pod where the candidate agent's records live, when cross-pod. |

## `foxxi.decide_evaluation_candidate`

**Accept or decline a candidate agent (the cross-pod delegation grant)**

The evaluation owner accepts or declines a requested candidate. Accepting it IS the cross-pod delegation grant — the candidate agent (whose DID may belong to another team / pod) becomes a managed member of the cohort and may record runs into it. This closes the gap where Interego could register an agent on your own pod but had no turnkey flow to authorise an external agent into a shared, managed evaluation.

- Action: `urn:iep:action:foxxi:decide-evaluation-candidate`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/decide_evaluation_candidate`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `evaluation_id` | string | yes | The evaluation cohort. |
| `candidate_id` | string | yes | The candidate to decide on (from request_evaluation_enrollment). |
| `decision` | string | yes | accept \| decline. |

## `foxxi.record_external_agent_run`

**Record one completed run of an external agent (Codex, OpenClaw, Hermes, enterprise)**

The one-call adapter for an EXTERNAL agent — one that does its work outside Foxxi (a Codex doing real coding, an OpenClaw or Hermes agent, a custom enterprise agent) and is therefore invisible to the trajectory layer and the ELR. Emit a single completed RUN and the bridge normalises it into a genuine agentic-native trajectory AND xAPI `performed` statements, so the run becomes visible to disposition assessment, the IEEE P2997 ELR, and — if bound to an evaluation — the portfolio read. Two input shapes: `tool_calls` (a flat list — an un-instrumented agent wires this in ~10 lines) or `steps` (the full modal / poly-granular trajectory, for an agent that already tracks intentions + counterfactual branches). Bind the run to a cohort with evaluation_id (+ optionally candidate_id).

- Action: `urn:iep:action:foxxi:record-external-agent-run`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_external_agent_run`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_did` | string | yes | The external agent's DID. |
| `agent_name` | string | no | Display name for the agent. |
| `task_name` | string | yes | What the run accomplished (becomes the xAPI Activity name). |
| `task_id` | string | no | Stable task identifier; derived from task_name if omitted. |
| `task_description` | string | no | Optional longer task description. |
| `success` | boolean | yes | Did the run succeed overall? |
| `quality` | number | no | Outcome quality 0..1. |
| `duration_iso` | string | no | ISO 8601 duration the run took (e.g. PT12M). |
| `cost_usd` | number | no | Cost of the run in USD — agent-economics signal for the portfolio read. |
| `tool_calls` | array of object | no | Simple form — a flat list of tool invocations. Each: { tool, object_name?, object_id?, success?, quality?, note? }. |
| `steps` | array of object | no | Rich form — the full modal / poly-granular trajectory. Each: { modal_status, granularity, verb, object_id, object_name, id?, parent_id?, supersedes_id?, was_derived_from?[], result? }. Provide tool_calls OR steps. |
| `evaluation_id` | string | no | Bind this run to an evaluation cohort. |
| `candidate_id` | string | no | The candidate this run belongs to; resolved from agent_did within the evaluation if omitted. |
| `harness` | object | no | The harness / runtime: { name?, version?, runtime? }. |

## `foxxi.get_agent_evaluation`

**Get an evaluation cohort — its candidates and their enrollment status**

Return an evaluation cohort: the decision question, the shared task set, and every candidate with its team, harness, enrollment status (requested / accepted / declined) and run count. The read view for tracking who is in the bake-off and how much evidence each candidate has accumulated.

- Action: `urn:iep:action:foxxi:get-agent-evaluation`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/get_agent_evaluation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `evaluation_id` | string | yes | The evaluation cohort to read. |

## `foxxi.compare_agent_evaluation`

**Compare the cohort — the complexity-aware portfolio read (NOT a leaderboard)**

Produce the comparative read for an evaluation cohort — deliberately NOT a benchmark leaderboard and it emits no overall score. A leaderboard assumes the choice is knowable (a single best, found by measurement); whether to standardise on one agentic harness is usually an Emergent-regime decision where premature convergence is the ideal-future-state trap. So this returns a PORTFOLIO READ: the work regime of the WORK itself (pooled across all candidates' runs), each candidate's disposition + how well it COHERES with that work, a diagnosis of what KIND of decision the executives face, and a direct answer to "should we develop only one harness?" — converge (Evident/Knowable work: analysis can name a direction), parallel (Emergent work: the competing teams ARE the correct safe-to-fail probe portfolio — keep them), recombine (complementary dispositions: compose the harnesses via the substrate's union operator rather than pick), or gather-evidence (thin run history). Retrospective coherence, not prediction.

- Action: `urn:iep:action:foxxi:compare-agent-evaluation`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/compare_agent_evaluation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `evaluation_id` | string | yes | The evaluation cohort to compare. |

## `foxxi.export_case_framework`

**[admin] Export the tenant's competency framework as 1EdTech CASE 1.0 JSON-LD**

Project the tenant's fxk:SkillFramework + fxk:Skill (+ rcd:CompetencyDefinition for skills that have RDCEO proficiency levels) into a 1EdTech CASE 1.0 CFDocument JSON-LD payload. The CASE document is consumable by any CASE-compliant tool (CASE Network, CaSS, downstream LMSes) without re-implementing the Foxxi vocab.

- Action: `urn:iep:action:foxxi:export-case-framework`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/export_case_framework`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `framework_id` | string | yes | Framework IRI to export (must already be published as a fxk:SkillFramework descriptor on the tenant pod). |

## `foxxi.emit_cmi5_session`

**Emit a cmi5-conformant xAPI session trace (launched → terminated)**

Build the full cmi5 statement trace (launched + initialized + completed + passed/failed + terminated, plus optional satisfied if moveOn rule fires) for a learner's AU session. Each statement carries the cmi5 context category, session ID, and registration UUID per IEEE 9274.2.1. Caller can either fan-out to a connected LRS via the lrs-adapter or persist directly to the pod as fxa:LearningExperience descriptors.

- Action: `urn:iep:action:foxxi:emit-cmi5-session`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/emit_cmi5_session`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner WebID — becomes the xAPI actor (mbox or account). |
| `course_id` | string | yes | Course ID (becomes parent contextActivities). |
| `au_activity_id` | string | yes | Assignable Unit IRI (becomes statement object). |
| `registration` | string | yes | cmi5 session-id / xAPI registration UUID for this launch. |
| `score_scaled` | number | no | Normalized score (0..1) for passed/failed determination. |
| `mastery_score` | number | no | Threshold for passed; default 0.7. |
| `duration_iso` | string | no | Session duration as ISO 8601 (e.g. PT5M30S). |
| `move_on_rule` | string | no | One of Passed / Completed / CompletedAndPassed / CompletedOrPassed / NotApplicable. |

## `foxxi.resolve_did`

**Resolve a W3C DID (did:key / did:web / did:ethr) to its DID document**

Composes the substrate's DID resolver. For did:key, decodes the embedded Ed25519 public key. For did:web, fetches .well-known/did.json over HTTPS and returns the parsed document. For did:ethr, derives the verification method from the Ethereum address.

- Action: `urn:iep:action:foxxi:resolve-did`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/resolve_did`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `did` | string | yes | DID to resolve (did:key:* \| did:web:* \| did:ethr:*). |

## `foxxi.query_experience_index`

**Federate an xAPI Statement query across multiple LRSs (ADL TLA Experience Index)**

Implements the read side of the ADL Total Learning Architecture Experience Index. Given a filter (actor / verb / activity / since / until / registration), queries every configured LRS endpoint in parallel, deduplicates statements by id, and returns a unified result with per-LRS attribution.

- Action: `urn:iep:action:foxxi:query-experience-index`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/query_experience_index`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `endpoints` | array | yes | Array of { label, endpoint, username, password } LRS configs. |
| `filter` | object | no | Filter object: { agent?, verb?, activity?, since?, until?, registration?, limit? }. |

## `foxxi.push_to_cass`

**[admin] Push the tenant's competency framework to an ADL CaSS server**

POST the tenant's CASE 1.0 CFDocument (from foxxi.export_case_framework) to a CaSS server's /api/framework endpoint. Downstream CaSS-integrated tooling can then query learner competencies without re-implementing Foxxi semantics.

- Action: `urn:iep:action:foxxi:push-to-cass`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/push_to_cass`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cass_endpoint` | string | yes | CaSS server base URL. |
| `cass_bearer` | string | no | Optional bearer token for authenticated push. |
| `framework_id` | string | yes | Framework IRI to export + push. |

## `foxxi.export_clr_v1`

**Export a learner's record as 1EdTech CLR 1.0 (legacy pre-VC) JSON**

Project the learner's pod credentials into the legacy 1EdTech CLR 1.0 shape for institutional consumers still on the pre-VC format. The 1.0 payload is plaintext JSON — institutional signing is the operator's responsibility.

- Action: `urn:iep:action:foxxi:export-clr-v1`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/export_clr_v1`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner WebID. |
| `learner_pod_url` | string | yes | Pod to walk. |

## `foxxi.issue_bbs_credential`

**[admin] Issue a BBS+-signed OB3 completion credential (supports selective disclosure)**

Build an OB3-shaped W3C VC, sign it with the tenant's BBS+ key over a flattened message list. The full credential goes to the holder; the holder later derives a zero-knowledge proof revealing only the claims they choose. Verifier learns nothing about un-revealed claims.

- Action: `urn:iep:action:foxxi:issue-bbs-credential`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/issue_bbs_credential`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner subject. |
| `course_id` | string | yes | Course identifier. |
| `course_title` | string | yes | Achievement name. |
| `score_scaled` | number | yes | Normalized score (0..1). |
| `proficiency_level` | string | yes | Novice \| Beginner \| Intermediate \| Advanced \| Expert. |
| `aligned_skills` | array | no | Optional list of { targetCode, targetName, proficiencyLevel? }. |

## `foxxi.derive_bbs_presentation`

**Derive a selective-disclosure presentation from a BBS+ credential**

Holder-side. Given a BBS+-issued credential + a list of which claim paths to reveal, produce a zero-knowledge BBS+ proof + the revealed claims for the verifier. The full credential never leaves the holder.

- Action: `urn:iep:action:foxxi:derive-bbs-presentation`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/derive_bbs_presentation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `issued` | object | yes | The BBS+ credential returned by foxxi.issue_bbs_credential. |
| `reveal_paths` | array | yes | Array of claim paths to reveal (e.g. ["achievement.name", "achievement.proficiencyLevel"]). |
| `presentation_header` | string | no | Optional UTF-8 string binding the proof to a verifier / occasion (challenge / nonce). |

## `foxxi.verify_bbs_presentation`

**Verify a selective-disclosure BBS+ presentation**

Verifier-side. Takes a presentation produced by foxxi.derive_bbs_presentation; returns whether the issuer signed a credential containing the disclosed claims at the disclosed positions. Verifier learns ONLY the revealed claims.

- Action: `urn:iep:action:foxxi:verify-bbs-presentation`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/verify_bbs_presentation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `presentation` | object | yes | The presentation returned by foxxi.derive_bbs_presentation. |

## `foxxi.prove_competency`

**Prove a competency privately (BBS+ selective disclosure, end-to-end)**

Holder-facing competency proof. Composes the three BBS+ steps — issue (the bridge as tenant issuer signs a multi-claim credential), derive (disclose only a minimal privacy-preserving subset), verify — into ONE operation a learner can trigger for their own record. Proves "I hold this competency at this proficiency, issued by this tenant" to a verifier while keeping score, name, dates, and credential id behind a zero-knowledge proof. This is the IEEE P2997 LER privacy story a flat wallet cannot give. Non-admins may only prove their own competencies.

- Action: `urn:iep:action:foxxi:prove-competency`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/prove_competency`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner whose competency is being proved. Non-admin callers must pass their own DID. |
| `competency_name` | string | yes | The competency / course title to prove (becomes Achievement.name on the BBS+ credential). |
| `course_id` | string | no | Optional course identifier; derived from competency_name if omitted. |
| `learner_name` | string | no | Optional learner display name (a hidden claim — never disclosed by default). |
| `reveal_paths` | array | no | Optional claim paths to disclose; defaults to the minimal privacy-preserving set (issuer + achievement.name + achievement.proficiencyLevel). |
| `presentation_context` | string | no | Optional verifier/occasion binding (BBS+ presentation header). |

## `foxxi.launch_au_with_prereq_check`

**Launch a cmi5 AU gated on a verified-credential prerequisite**

Compose: walk the learner's pod for a credential satisfying the declared prereq (verify Data Integrity Proof, check achievement IRI + proficiency level + expiry + accepted issuers); if satisfied, emit the cmi5 launched + initialized statements; else return a structured prereq-failure report.

- Action: `urn:iep:action:foxxi:launch-au-with-prereq`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/launch_au_with_prereq_check`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner identity. |
| `learner_pod_url` | string | yes | Pod to walk for credentials. |
| `course_id` | string | yes | Course identifier. |
| `au_activity_id` | string | yes | Assignable Unit IRI. |
| `registration` | string | yes | cmi5 sessionId for this launch. |
| `prereq_achievement_iri` | string | yes | Achievement IRI the prereq credential must match. |
| `prereq_min_proficiency_rdf_value` | number | no | Minimum rcd:rdfValue (1=Novice through 5=Expert). |
| `prereq_accepted_issuer_dids` | array | no | Whitelist of acceptable issuer DIDs. |

## `foxxi.ai_assess_competency`

**AI mentor signs a (Hypothetical) CompetencyAssertion VC**

AI agent reviews evidence (cited slide IDs, Q&A traces, performance results) and signs a CompetencyAssertion VC with its own did:key. Modal status: Hypothetical until a human countersigns via foxxi.countersign_assessment.

- Action: `urn:iep:action:foxxi:ai-assess-competency`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ai_assess_competency`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner subject. |
| `mentor_seed` | string | yes | Mentor's seed for deterministic did:key. |
| `competency` | object | yes | The competency claimed: { id, label, proficiencyLevel }. |
| `evidence` | array | yes | Array of { type, id, narrative? } evidence references. |
| `narrative` | string | yes | Mentor's assessment narrative. |

## `foxxi.countersign_assessment`

**[admin] Countersign an AI mentor's CompetencyAssertion → full OB3**

Human admin reviews + countersigns the AI mentor's Hypothetical CompetencyAssertion. Result: a dual-issuer credential whose modal status is Asserted (= OB3-eligible). Both signatures are preserved on the descriptor for auditability.

- Action: `urn:iep:action:foxxi:countersign-assessment`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/countersign_assessment`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `assessment` | object | yes | The CompetencyAssessment returned by foxxi.ai_assess_competency. |
| `human_seed` | string | yes | Human admin's seed for deterministic countersign key. |

## `foxxi.audit_compliance_trail`

**[admin] Compose a single-query audit chain for a learner window**

Walk the learner's pod, pull every descriptor with a Provenance facet or dct:conformsTo tag in the time window, return them ordered as a chain. Each step carries its framework citations so the auditor sees which controls every hop references.

- Action: `urn:iep:action:foxxi:audit-compliance-trail`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/audit_compliance_trail`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner identity. |
| `learner_pod_url` | string | yes | Pod to walk. |
| `window_from` | string | no | ISO 8601 lower bound. |
| `window_to` | string | no | ISO 8601 upper bound. |

## `foxxi.declare_framework_alignment`

**[admin] Declare an alignment between this tenant's competency and another tenant's**

Publishes a fxa:CASEAlignment descriptor binding one of this tenant's fxk:Skill / rcd:CompetencyDefinition items to an item in a foreign tenant's framework. The alignment becomes a substrate-discoverable artifact + lifts into the next CASE 1.0 export as a CFAssociation.

- Action: `urn:iep:action:foxxi:declare-framework-alignment`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/declare_framework_alignment`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `own_item_iri` | string | yes | This tenant's competency IRI. |
| `own_item_label` | string | yes | Display label. |
| `other_item_iri` | string | yes | Foreign competency IRI. |
| `other_framework_iri` | string | yes | Foreign framework IRI. |
| `other_tenant_did` | string | no | Foreign tenant DID (optional but useful for trust scoping). |
| `relation` | string | yes | isAlignedTo \| isEquivalentTo \| precedes \| isPrerequisiteOf \| broadens \| narrows. |
| `rationale` | string | no | Free-text rationale. |

## `foxxi.resolve_aligned_competency`

**Resolve whether a held competency satisfies a required competency via alignments**

Given the held credential's competency IRI + a required competency IRI + the alignment graph, BFS over isAlignedTo / isEquivalentTo edges. Returns the alignment chain (could be 0 hops for direct match, N hops for transitive) so the verifier sees how the held credential satisfied the requirement.

- Action: `urn:iep:action:foxxi:resolve-aligned-competency`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/resolve_aligned_competency`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `held_competency_iri` | string | yes | Competency the credential attests. |
| `required_competency_iri` | string | yes | Competency the verifier requires. |
| `alignments` | array | yes | Array of serialized alignments (from foxxi.declare_framework_alignment). |

## `foxxi.cohort_concept_intelligence`

**[admin] Cross-pod cohort concept-overlap analytics**

Walk a list of learner pods, pull every fxa:LearnerQuestionEvent in the time window, compute concept overlap across the cohort: which concepts >= 50% of learners asked about (reinforcement signal). Real PGSL composition with lighter set-intersection for this affordance; full PGSL meet at substrate level for atom-grain analysis.

- Action: `urn:iep:action:foxxi:cohort-concept-intelligence`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/cohort_concept_intelligence`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_pod_urls` | array | yes | Array of learner pod root URLs. |
| `window_from` | string | no | ISO 8601 lower bound. |
| `window_to` | string | no | ISO 8601 upper bound. |

## `foxxi.register_self_sovereign_learner`

**Register a learner identity (human or AI agent) with their own DID + pod**

Self-enroll into a self-sovereign tenant. Send a rev-196 proof-of-possession envelope ({_signature,_signed_payload}) signed by your wallet; the bridge recovers your address and appends it to a PUBLIC tenant-membership allowlist on your own pod. Any bridge then reads that public section via the substrate (no shared admin key) and authorizes you on foxxi.discover_assigned_courses / retrieve_course_context / etc. You can only enroll yourself (the address written is the recovered signer), and admin-managed (encrypted-directory) tenants are refused.

- Action: `urn:iep:action:foxxi:register-self-sovereign-learner`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/register_self_sovereign_learner`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signature` | string | yes | rev-196 signature over _signed_payload (EIP-191). Proof-of-possession — you can only enroll the address this recovers to. |
| `_signed_payload` | string | yes | JSON string carrying at least { agent_id, timestamp, tenant_pod_url }. May also carry learner_id / learner_pod_url / tenant_did. |
| `tenant_pod_url` | string | yes | The pod that hosts your self-sovereign tenant membership (usually your own pod). Sign it inside _signed_payload; sent in the clear it is advisory only. |
| `learner_pod_url` | string | no | Your pod / WebID base (defaults tenant_pod_url). Used to derive your web_id. |
| `learner_id` | string | no | Preferred user_id for your membership entry (defaults to u-eth-<addr-prefix>). |

## `foxxi.publish_ontology`

**Publish + host an ontology on Interego (a vocabulary is just RDF)**

Host an OWL/SHACL ontology the substrate way — not a raw file PUT, and not a developer-baked route. Send a rev-196 proof-of-possession envelope + the ontology Turtle; the bridge composes the substrate publish() primitive to write a PUBLIC, signed ContextDescriptor + named graph (dct:conformsTo owl:Ontology) on your OWN self-sovereign pod, and serves it as dereferenceable linked data at its own resolvable IRI (content-negotiated Turtle / JSON-LD / HTML). #terms resolve within the document (hash namespace). This is a HIGHER-ORDER COMPOSITION over the substrate: the ontology dereferences at the Interego relay's generic /ns RDF-projection surface (an ontology is just a holon used as RDF — the same surface dereferences any published graph, and the system's own vocabs once migrated onto it), so the IRI anchors on the substrate, not this vertical. This affordance adds only the PoP-convenient publish path + Foxxi-tenancy owner-gate: you can only publish to a self-sovereign pod you own (self-enroll first via foxxi.register_self_sovereign_learner); the configured (closed) tenant and admin-managed pods are refused.

- Action: `urn:iep:action:foxxi:publish-ontology`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_ontology`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signature` | string | yes | rev-196 signature over _signed_payload (EIP-191). Proof-of-possession — you can only publish to a pod you own. |
| `_signed_payload` | string | yes | JSON string carrying at least { agent_id, timestamp, owner_pod_url, slug, ontology_turtle }. |
| `owner_pod_url` | string | yes | Your self-sovereign pod (host + serve the ontology here). Sign it inside _signed_payload; sent in the clear it is advisory only. |
| `slug` | string | yes | Short name for the ontology (e.g. "hmd"); becomes part of its resolvable IRI <base>/ns/pod/<your-userId>/<slug>. |
| `ontology_turtle` | string | yes | The OWL/SHACL Turtle to publish. Bind your namespace prefix to a hash namespace under the returned ontologyIri so #terms resolve at the serving host. |

## `foxxi.bootstrap_tenant`

**Bootstrap a fresh Foxxi tenant on a Solid pod**

Publish tenant-metadata + emit env-var configuration so the bridge can switch over to a new tenant. Wizard backend.

- Action: `urn:iep:action:foxxi:bootstrap-tenant`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/bootstrap_tenant`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_slug` | string | yes | URL-safe slug (e.g. partnerco-training). |
| `tenant_did` | string | yes | DID for the new tenant (typically did:web:<domain>). |
| `tenant_display_name` | string | yes | Human-readable tenant name. |
| `admin_web_id` | string | yes | First admin's WebID. |
| `admin_name` | string | yes | First admin's display name. |
| `pod_url` | string | yes | Pod URL the tenant's artifacts will land on. |

## `foxxi.scorm_cloud_pull`

**[admin] Pull a SCORM Cloud catalog into the tenant**

Use SCORM Cloud Application API v2 to list courses + project them as fxs:CourseCatalog stub entries on the tenant pod. Requires FOXXI_SCORM_CLOUD_APP_ID + FOXXI_SCORM_CLOUD_SECRET_KEY env on the bridge.

- Action: `urn:iep:action:foxxi:scorm-cloud-pull`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/scorm_cloud_pull`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `publish_to_pod` | boolean | no | If true, also publish the projected catalog entries as a fxs:CourseCatalog descriptor on the tenant pod (default false: return-only). |

## `foxxi.scorm_cloud_register`

**[admin] Create a SCORM Cloud registration for a learner**

POST to /registrations on SCORM Cloud; the returned registration ID becomes the cmi5 sessionId.

- Action: `urn:iep:action:foxxi:scorm-cloud-register`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/scorm_cloud_register`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `registration_id` | string | yes | Caller-chosen UUID for this learner+course attempt. |
| `course_id` | string | yes | SCORM Cloud course ID. |
| `learner_id` | string | yes | Stable learner identifier (typically the WebID). |
| `learner_first_name` | string | no | Given name of the learner, forwarded to the SCORM Cloud registration record. |
| `learner_last_name` | string | no | Family name of the learner, forwarded to the SCORM Cloud registration record. |
| `learner_email` | string | no | Email address of the learner; SCORM Cloud keys the registration on it. |

## `foxxi.upload_scorm_package`

**Upload a SCORM zip package for ingestion**

Upload a SCORM / cmi5 .zip. Parsed IN-PROCESS on arrival — no queue, no external runner: the manifest, course title, standard, SCO list, activity structure and authoring-tool fingerprint are read out of the zip synchronously and returned. Publishes a Hypothetical fxs:PackageUpload receipt, then — only if the parse succeeds — an Asserted fxs:ParsedPackage over the same graph that supersedes it (iep:supersedes). A zip that cannot be read returns status:failed and leaves the receipt Hypothetical: nothing is asserted about a package that could not be parsed.

- Action: `urn:iep:action:foxxi:upload-scorm-package`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/upload_scorm_package`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `zip_base64` | string | yes | base64-encoded SCORM zip. |
| `hinted_title` | string | no | Display name for the upload while parsing is pending. |

## `foxxi.derive_adaptive_policy`

**[admin] Derive an adaptive-sequencing policy from cohort intelligence**

Takes the output of foxxi.cohort_concept_intelligence and derives a fxa:AdaptiveSequencingPolicy document naming the concepts a cohort is struggling with and the reinforcement each suggests. NOT ENFORCED: nothing currently consumes it — foxxi.launch_au_with_prereq_check returns the same decision with and without a policy supplied, verified by direct comparison. Treat the output as analysis to act on, not as a gate that acts on your behalf.

- Action: `urn:iep:action:foxxi:derive-adaptive-policy`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/derive_adaptive_policy`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cohort_intel` | object | yes | CohortIntelligence object from foxxi.cohort_concept_intelligence. |
| `threshold_pct` | number | no | Concepts above this cohort-coverage % become reinforcement gates (default 50). |

## `foxxi.schedule_spaced_repetition`

**Schedule spaced-repetition reminders for a learner**

Ebbinghaus 1/7/30-day intervals, with early-week reminders for concepts other concepts depend on (foundation signal).

- Action: `urn:iep:action:foxxi:schedule-spaced-repetition`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/schedule_spaced_repetition`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner DID (web_id pattern from the tenant identity service). |
| `completed_concepts` | array | yes | Array of { conceptId, completedAt }. |
| `prereq_edges` | array | yes | Array of { from, to } prereq edges from the course graph. |

## `foxxi.discover_framework_registry`

**Federated discovery of competency frameworks across tenant pods**

Walk N pod URLs, return every fxs:CourseCatalog / fxs:SkillFramework / fxa:CASEAlignment descriptor — the public-registry pattern without a central registry.

- Action: `urn:iep:action:foxxi:discover-framework-registry`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/discover_framework_registry`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `pod_urls` | array | yes | Array of pod root URLs to walk. |

## `foxxi.register_tutor_agent`

**Register an AI tutor agent in the marketplace**

Builds a fxa:TutorAgentProfile descriptor from your specialties + contact endpoint. WRITES NOTHING: this route is unauthenticated pure-compute and echoes your arguments back shaped as a descriptor — verified live, your pod is untouched. agent_did is NOT bound to any signer, so the descriptor asserts whatever DID you pass; what binds it to you is PUBLISHING it to your own pod with publish_context, which is signed. Once published it is discoverable, and foxxi.find_tutor_for_competency will rank it — that ranking weighs countersigned assertions, not the self-rated level, because the self-rating is yours to choose.

- Action: `urn:iep:action:foxxi:register-tutor-agent`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/register_tutor_agent`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `agent_did` | string | yes | The tutor's DID. |
| `display_name` | string | yes | Human-readable name for the tutor agent, shown wherever it is offered as a tutor. |
| `specialties` | array | yes | Array of { frameworkIri, competencyIri, selfRatedLevel }. |
| `description` | string | no | What this tutor agent teaches and how, shown alongside its display name. |
| `powered_by` | string | no | e.g. claude-opus-4-7 |
| `contact_endpoint` | string | no | MCP server URL where the tutor agent runs. |

## `foxxi.find_tutor_for_competency`

**Search the tutor marketplace for a specific competency**

Rank-search tutor candidates by competency match + number of independent human-countersigned competency assertions they've signed (a proxy for teaching quality).

- Action: `urn:iep:action:foxxi:find-tutor-for-competency`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/find_tutor_for_competency`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `required_competency_iri` | string | yes | Dereferenceable IRI of the competency a tutor must hold to be returned. |
| `required_level` | string | no | Novice \| Beginner \| Intermediate \| Advanced \| Expert |
| `candidate_profiles` | array | yes | Array of TutorAgentProfile to rank. |
| `countersign_counts` | object | no | Map { agentDid: number } of independent countersigns per tutor. |

## `foxxi.generate_dpia`

**[admin] Generate a Data Protection Impact Assessment for a learner window**

Wraps foxxi.audit_compliance_trail. Returns a structured DPIA with summary stats, framework controls cited, data-category breakdown, risk-rated findings + suggested mitigations (GDPR Art. 35 + EU AI Act § 13 shape).

- Action: `urn:iep:action:foxxi:generate-dpia`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/generate_dpia`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner DID (web_id pattern from the tenant identity service). |
| `learner_pod_url` | string | yes | Pod URL holding the learner records, scoped to the reporting window below. |
| `window_from` | string | no | Start of the reporting window, ISO 8601 date-time, inclusive. |
| `window_to` | string | no | End of the reporting window, ISO 8601 date-time, inclusive. |

## `foxxi.manager_team_view`

**[manager] Build a competency map for the manager's direct reports**

Walk each report's pod, aggregate credentials, return per-report breakdown + team skill coverage roll-up.

- Action: `urn:iep:action:foxxi:manager-team-view`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/manager_team_view`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `manager_web_id` | string | yes | WebID/DID of the manager whose direct reports are being viewed. |
| `report_pods` | array | yes | Array of { webId, name?, podUrl }. |

## `foxxi.build_did_web_document`

**[admin] Build a publishable did:web document for a tenant**

Returns the DID document JSON the operator uploads to https://<tenant-domain>/.well-known/did.json so verifiers can resolve tenant credentials.

- Action: `urn:iep:action:foxxi:build-did-web-document`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/build_did_web_document`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_did` | string | yes | e.g. did:web:tenant.example |
| `issuer_public_key_multibase` | string | yes | Tenant's Ed25519 issuer public key in multibase form. |
| `bridge_endpoint` | string | yes | URL of the tenant's foxxi bridge. |

## `foxxi.backup_tenant_pod`

**[admin] One-shot backup of every descriptor on the tenant pod**

Pulls the manifest + every descriptor + every reachable graph into one JSON object. Encrypted graphs come back as ciphertext.

- Action: `urn:iep:action:foxxi:backup-tenant-pod`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/backup_tenant_pod`
- Inputs: none

## `foxxi.le_design_ab_experiment`

**[learning-engineer] Pre-register an A/B experiment between two course variants**

Power-analysis + analysis plan for an instructional A/B. Returns required sample size per arm, recommended statistical test for the primary metric, and (if perWeekEnrolment is supplied) an estimated duration. Pre-registration prevents p-hacking.

- Action: `urn:iep:action:foxxi:le-design-ab-experiment`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_design_ab_experiment`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `variant_a` | object | yes | { courseId, courseTitle? } |
| `variant_b` | object | yes | { courseId, courseTitle? } |
| `primary_metric` | string | yes | completion-rate \| mastery-score \| time-to-mastery \| retention-30-day \| downstream-prereq-pass-rate |
| `minimum_detectable_effect` | number | yes | e.g. 0.05 for a 5pp lift |
| `alpha` | number | no | default 0.05 |
| `power` | number | no | default 0.8 |
| `randomization` | string | no | simple \| stratified-by-audience-tag (default) |
| `per_week_enrolment` | number | no | Enrolment rate for duration estimate. |

## `foxxi.judge_content_claim`

**[learning-engineer] Judge a content claim with a System One model: a typed answer with probabilities, Hypothetical until confirmed**

One narrow question to TypeSafe System One about a unit of course content, answered as typed probabilities rather than prose. judgment_kind evidence-level scores how well claim_text is supported by context and evidence on a five-level scale (unsupported, asserted-only, supported-by-context, supported-by-cited-evidence, corroborated); work-regime chooses among the Foxxi work regimes (Evident, Knowable, Emergent, Turbulent) for the work the content describes. Policy is code: which question is asked, what the answer means, and which controls a person is offered (cite-evidence, choose-method-for-regime, confirm-or-refute). Published to the tenant pod as a Hypothetical foxxi:ContentJudgment when the bridge has one. Needs TYPESAFE_API_KEY on the bridge (503 otherwise). Built on the shared judgment kit jev-harness proved.

- Action: `urn:iep:action:foxxi:judge-content-claim`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/judge_content_claim`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#ContentClaimInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `judgment_kind` | string | yes | evidence-level or work-regime. |
| `claim_text` | string | yes | The claim to judge, as it appears in or about the content (at least 8 characters). |
| `context` | string | no | The passage the claim sits in (slide text, transcript, section); the first 6000 characters are used. |
| `evidence` | array | no | Array of { type, id, narrative? } evidence references, as foxxi.ai_assess_competency takes them; at most 20 are used. |
| `course_iri` | string | no | The course the content belongs to. |
| `slide_id` | string | no | The slide the claim is on. |
| `concept_ids` | array | no | Concept ids the claim concerns. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.confirm_content_judgment`

**[learning-engineer] Say what is true about a judged claim: the outcome supersedes the judgment**

A person confirms or refutes a ContentJudgment: confirmed_answer must be one of the answers the judgment weighed (an evidence level, or a work regime). Publishes an Asserted foxxi:ContentJudgmentOutcome to the tenant pod that supersedes the judgment descriptor and records whether the model had it and the Brier score of its probabilities; foxxi.content_judgment_calibration is computed over these. Learning-engineer or admin only.

- Action: `urn:iep:action:foxxi:confirm-content-judgment`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/confirm_content_judgment`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#ConfirmContentJudgmentInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `judgment_iri` | string | yes | The judgment entity on the pod, as foxxi.judge_content_claim returned it in published.graphIri (urn:foxxi:judgment:<id>). |
| `confirmed_answer` | string | yes | The answer held to be true, one of the judgment's alternatives. |
| `note` | string | no | Why, in a sentence. |
| `confirmed_by_kind` | string | no | human (the default) or agent: who is confirming. An agent's reading is a second model's opinion and is recorded as such; the calibration and the attestation count the two apart. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.content_judgment_calibration`

**[learning-engineer] How the content judgments have done, per question kind**

Reads every foxxi:ContentJudgmentOutcome on the tenant pod and reports, per question kind (evidence-level, work-regime), how often the model had the confirmed answer and the mean Brier score of its probabilities; a cell is Hypothetical until it holds five outcomes and Asserted after, as the jev-harness calibration is. The same measurement the harness makes of its own judgments, for content.

- Action: `urn:iep:action:foxxi:content-judgment-calibration`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/foxxi/content_judgment_calibration`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.attest_content_judgments`

**[learning-engineer] Turn the content-judgment calibration into an attestation**

Reads every foxxi:ContentJudgmentOutcome on the tenant pod, computes the calibration, and publishes a Self amta-shaped attestation by the judging agent about itself, grounded in the judgments container: accuracy from the evidence-level hit rate, competence from the work-regime hit rate, honesty from the Brier, Asserted cells only. The new attestation supersedes the earlier ones. Refused with 409 when no question kind has reached its sample floor: only earned ratings are weighed.

- Action: `urn:iep:action:foxxi:attest-content-judgments`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/attest_content_judgments`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#AttestContentJudgmentsInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.content_judgment_reputation`

**[learning-engineer] What the pod attests about the content-judging agent**

Every foxxi:ContentJudgmentAttestation on the tenant pod about the judging agent (its own, grounded in the calibration, and any a learning engineer publishes as a Peer), aggregated by the registry under the content policy: a self-attestation at a quarter, a peer at a half, half-life thirty days. The snapshot is how much the judgments have earned, not how confident the model sounds.

- Action: `urn:iep:action:foxxi:content-judgment-reputation`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/foxxi/content_judgment_reputation`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.confirm_next`

**[learning-engineer] Which content judgment to confirm next**

The pending Hypothetical foxxi:ContentJudgment entities on the tenant pod, ranked by what a person's confirmation would teach: the model's own uncertainty (1 − confidence), how far the question kind's calibration cell is from earning anything, and how little evidence the claim carried. No new model call: the factors are the judgments' own and the calibration's, the weights are stated in the answer, and each entry carries the confirm call to make with the model's answer filled in, to keep or change. Ties break oldest first.

- Action: `urn:iep:action:foxxi:confirm-next`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/foxxi/confirm_next`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.record_content_judgment`

**[learning-engineer] Record a content judgment you made yourself, as a judge in your own right**

The same foxxi:ContentJudgment entity foxxi.judge_content_claim publishes for the bridge's model, with the answer, the distribution and the model you declare, and you as its judge. The answer must be one of the kind's alternatives; the distribution is normalised and, when absent, concentrated on the answer at your confidence (0.8 by default). Confirm it, cross-confirm it against other judges' judgments of the same claim, and it earns you a reputation on that kind of question beside theirs.

- Action: `urn:iep:action:foxxi:record-content-judgment`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_content_judgment`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#RecordContentJudgmentInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `judgment_kind` | string | yes | evidence-level or work-regime. |
| `claim_text` | string | yes | The claim judged, as it appears in or about the content (at least 8 characters). |
| `answer` | string | yes | Your answer: an evidence level or a work regime. |
| `model` | string | yes | The model you used, as you name it: a System One model, a reasoning model, or your own name. |
| `probabilities` | object | no | Your distribution over the alternatives; normalised. |
| `confidence` | number | no | Your confidence in the answer (0..1); 0.8 when absent. |
| `context` | string | no | The passage the claim sits in. |
| `evidence` | array | no | Array of { type, id, narrative? } evidence references. |
| `course_iri` | string | no | The course the content belongs to. |
| `slide_id` | string | no | The slide the claim is on. |
| `concept_ids` | array | no | Concept ids the claim concerns. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.cross_confirm`

**[learning-engineer] Judges confirm each other: every two judges' newest judgments of one claim score each other, once**

For every claim two or more judges have judged, each judge's newest judgment gets an outcome from each other judge's answer — an agent confirmation naming the peer judgment it came from — so every judge's calibration counts agreement with its peers, apart from a person's word. Idempotent: a pair already scored is skipped. A person's confirmation is still what retires a judgment from foxxi.confirm_next.

- Action: `urn:iep:action:foxxi:cross-confirm`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/cross_confirm`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#CrossConfirmInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.best_judge`

**[learning-engineer] Who has earned the most on this kind of question**

Every judge the pod holds attestations about, ranked by the registry's rating on the axis that kind of question is scored on — accuracy for evidence-level, competence for work-regime — with how many attestations contributed. Unrated judges last. The judge to believe, measured rather than configured.

- Action: `urn:iep:action:foxxi:best-judge`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/foxxi/best_judge`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `judgment_kind` | string | no | evidence-level (the default) or work-regime. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.set_autonomy_policy`

**[learning-engineer] Amend the autonomy policy: when a judge may assert on a kind of question without a person**

Per kind of question, the registry rating on its axis a judge must reach (accuracy for evidence-level, competence for work-regime), over how many outcomes the latest attestation about it must rest, and how many of those a person must have confirmed. Amended through the constitutional machinery: proposed, voted by the caller, ratified under the tier's rules — tier 4 (a self-sovereign pod, its owner's) ratifies at once; the configured tenant amends at tier 3 and waits for a quorum. Each policy supersedes the last. The judge and record affordances read it to publish Asserted or Hypothetical.

- Action: `urn:iep:action:foxxi:set-autonomy-policy`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/set_autonomy_policy`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#SetAutonomyPolicyInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `rules` | array | yes | Array of { kind, axis, floor, minSamples, minHumanConfirmers }, one per kind of question the policy speaks to. |
| `tier` | number | no | The constitutional tier (1..4); 4 for a self-sovereign pod, 3 for the configured tenant by default. |
| `description` | string | no | Why, in a sentence. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.autonomy_status`

**[learning-engineer] Who may assert what without a person, and why**

The autonomy policy in force and, for every judge the pod attests about and every kind of question, whether that judge may assert without a person: its registry rating on the kind's axis, the outcomes the latest attestation rests on, how many a person confirmed, and which part of the rule it clears or misses.

- Action: `urn:iep:action:foxxi:autonomy-status`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/foxxi/autonomy_status`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.weakest_claims`

**[learning-engineer] The weakest claims on the pod: where the content needs revising first**

Every evidence-level claim judged on the pod, graded and ranked weakest first: a person's confirmation if one exists, else an agent's, else the judges' answers — the newest per judge, the lowest of them when they disagree. Each carries the judgments and confirmations behind its grade and a revise control that calls foxxi.revise_claim. A course that grades itself.

- Action: `urn:iep:action:foxxi:weakest-claims`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/foxxi/weakest_claims`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | no | How many claims, weakest first; twelve when absent. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.revise_claim`

**[learning-engineer] Revise a claim: new words, evidence from outside the passage, judged again at once**

Records a foxxi:ContentRevision — the claim as it stood and the grade it had, the words now and the evidence cited, who revised it (a person, or an agent recorded as such) — and has the bridge's judge grade the revised claim immediately under the autonomy policy, so the record says the grade before and after. A revision must change the words or add evidence. The original judgment stands; the revision names it.

- Action: `urn:iep:action:foxxi:revise-claim`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/revise_claim`
- Input shape: `https://foxxi-bridge.interego.xwisee.com/ns/foxxi#ReviseClaimInputShape`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `claim_text` | string | yes | The claim as it stood, exactly as it was judged. |
| `revised_text` | string | yes | The claim as it should read now. |
| `evidence` | array | no | Array of { type, id, narrative? } evidence references from outside the passage: a rule, a source, a record, another slide. |
| `context` | string | no | The passage as revised, if it changed. |
| `slide_id` | string | no | The slide the claim is on. |
| `course_iri` | string | no | The course the content belongs to. |
| `revised_by_kind` | string | no | human (the default) or agent: who wrote the revision. |
| `note` | string | no | Why, in a sentence. |
| `tenant_pod_url` | string | no | A self-sovereign pod to run the loop on instead of the configured tenant: yours, enrolled with foxxi.register_self_sovereign_learner, whose owner you are. Omitted, the configured tenant is meant and a learning-engineer or admin role is required. |

## `foxxi.le_estimate_concept_difficulty`

**[learning-engineer] Rank a course's concepts by estimated difficulty**

Composes prereq-graph topology + cohort question-frequency to produce a per-concept difficulty score (0..1). Foundational concepts (≥3 dependents) flagged. The right-shape proxy for IRT until per-learner response data is available.

- Action: `urn:iep:action:foxxi:le-estimate-concept-difficulty`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_estimate_concept_difficulty`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course_id` | string | yes | Course whose concept graph to analyze (e.g. golf-explained). |
| `cohort_intel` | object | no | Output of foxxi.cohort_concept_intelligence (optional but improves accuracy). |

## `foxxi.le_analyze_learning_curve`

**[learning-engineer] Detect plateaus in a per-concept learning curve**

Plots mastery-rate-per-attempt + detects plateaus (3 consecutive attempts with <1pp improvement). Returns diagnosis (rising / plateau-low / plateau-high / insufficient-data) + an actionable recommendation.

- Action: `urn:iep:action:foxxi:le-analyze-learning-curve`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_analyze_learning_curve`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `concept_id` | string | yes | Stable identifier of the concept whose learning curve is analysed. |
| `concept_label` | string | no | Human-readable label for that concept, echoed in the returned analysis. |
| `attempts` | array | yes | Per-learner outcomes: array of { learnerId, attemptNumber, mastered }. |

## `foxxi.le_calibrate_mastery_threshold`

**[learning-engineer] Calibrate the cmi5 mastery threshold against downstream success**

Find the score threshold that maximizes Youden's J (sensitivity + specificity − 1) against downstream prereq-dependent performance. Returns ROC curve + recommended threshold.

- Action: `urn:iep:action:foxxi:le-calibrate-mastery-threshold`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_calibrate_mastery_threshold`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `records` | array | yes | Per-learner outcomes: array of { scoreScaled, downstreamSuccess }. |
| `threshold_grid` | array | no | Optional thresholds to evaluate (default 0..1 step 0.05). |

## `foxxi.le_framework_gap_analysis`

**[learning-engineer] Cross-reference framework competencies against taught concepts**

Finds (a) competencies in the framework with no taught concept (assessments can't be grounded) and (b) taught concepts not aligned to any competency (credentials can't reference the framework). Returns coverage % + per-direction gap lists.

- Action: `urn:iep:action:foxxi:le-framework-gap-analysis`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_framework_gap_analysis`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `framework_skills` | array | yes | Array of { id, label? } competency definitions. |
| `course_concepts` | array | yes | Array of CourseConcept from a published course. |
| `alignments` | array | yes | Array of { skillId, conceptId } edges. |

