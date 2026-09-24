# Organizational working memory: every affordance

Derived from `applications/organizational-working-memory/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 14 affordances.

## `owm.upsert_person`

**Create or update a person record**

Upsert an owm:Person descriptor on the org pod. Person IRIs are stable across sessions; subsequent calls supersede prior versions via iep:supersedes. Handles humans (no DID) and agent-people (with DID + capability passport).

- Action: `urn:iep:action:owm:upsert-person`
- HTTP: `POST {base}/owm/upsert_person`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Display name. |
| `role` | string | no | Free-text role / title. |
| `organization` | string | no | Organizational affiliation. |
| `did` | string | no | Optional DID for agent-people; humans omit. |
| `aliases` | array of string | no | Alternate names / handles for matching. |
| `notes` | string | no | Free-form notes. |
| `pod_url` | string | no | Org pod URL (defaults from env). |

## `owm.upsert_project`

**Create or update a project record**

Upsert an owm:Project descriptor. Projects are owm:WorkingScope subclasses — composable with olke: knowledge-state vocabulary (Tacit / Articulate / Collective / Institutional). Subsequent upserts supersede.

- Action: `urn:iep:action:owm:upsert-project`
- HTTP: `POST {base}/owm/upsert_project`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Project name. |
| `objective` | string | no | One-sentence objective. |
| `olke_stage` | one of `Tacit`, `Articulate`, `Collective`, `Institutional` | no | OLKE knowledge stage. |
| `participants` | array of string | no | IRIs of owm:Person records who are working on this project. |
| `status` | string | no | Free-text status note. |
| `pod_url` | string | no | Org pod URL. |

## `owm.record_decision`

**Record a decision with modal status**

Record an owm:Decision descriptor. Modal status defaults to Hypothetical (decision pending). Use Asserted for committed decisions. To reverse a decision, call again with modal_status=Counterfactual and supersedes=[<prior decision IRI>].

- Action: `urn:iep:action:owm:record-decision`
- HTTP: `POST {base}/owm/record_decision`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `topic` | string | yes | Short topic / what is being decided. |
| `rationale` | string | yes | The argument or evidence behind the decision. |
| `modal_status` | one of `Hypothetical`, `Asserted`, `Counterfactual` | no | Default Hypothetical (pending). |
| `project_iri` | string | no | Project this decision belongs to. |
| `decided_by` | array of string | no | IRIs of owm:Person records who made the decision. |
| `supersedes` | array of string | no | Prior decision IRIs this one supersedes. |
| `pod_url` | string | no | Org pod URL. |

## `owm.queue_followup`

**Queue a follow-up to surface later**

Queue an owm:FollowUp with a due-date (ISO 8601). The bridge's list_overdue_followups affordance surfaces items whose due_at has passed, so a cron or interactive query closes the observe-and-revise loop.

- Action: `urn:iep:action:owm:queue-followup`
- HTTP: `POST {base}/owm/queue_followup`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `topic` | string | yes | What needs follow-up. |
| `due_at` | string | yes | ISO 8601 datetime when this should surface. |
| `context_iri` | string | no | IRI of the project / decision this follow-up relates to. |
| `watcher_did` | string | no | DID of the agent or person responsible for the follow-up. |
| `pod_url` | string | no | Org pod URL. |

## `owm.record_note`

**Record a content-addressed note**

Capture a free-form insight as a content-addressed pgsl:Atom + descriptor. Two observers minting the same verbatim text mint the same atom IRI — duplicate notes collapse structurally.

- Action: `urn:iep:action:owm:record-note`
- HTTP: `POST {base}/owm/record_note`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | yes | The note content. Stored as a content-addressed atom. |
| `subject_iris` | array of string | no | IRIs the note is about (people, projects, decisions). |
| `tags` | array of string | no | Free-text tags. |
| `pod_url` | string | no | Org pod URL. |

## `owm.list_overdue_followups`

**List overdue follow-ups**

Return follow-ups whose due_at is on or before now (or `now` arg). Used by cron schedulers and by interactive agents that want to surface pending work at session start.

- Action: `urn:iep:action:owm:list-overdue-followups`
- HTTP: `POST {base}/owm/list_overdue_followups`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `now` | string | no | Optional ISO 8601 datetime to evaluate against (default: server clock). |
| `limit` | integer | no | Maximum items to return (default 50). |
| `pod_url` | string | no | Org pod URL. |

## `owm.discover_subgraph`

**Walk the org graph for a subject**

Affordance-walk the org pod for descriptors related to a subject IRI. Returns the manifest entries (descriptor URLs + facet summary + supersedes chain head). Caller can then get_descriptor on URLs of interest.

- Action: `urn:iep:action:owm:discover-subgraph`
- HTTP: `POST {base}/owm/discover_subgraph`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `subject_iri` | string | yes | IRI of the entity to walk from (person/project/decision). |
| `depth` | integer | no | How many hops to traverse (default 1). |
| `pod_url` | string | no | Org pod URL. |

## `owm.navigate_source`

**Read from an external source via uniform verbs**

Read an external information source (web, drive, slack, github, ...) using uniform verbs (ls / cat / grep / recent). Each source runs as an isolated sub-handler inside the bridge so the main agent's context is never polluted by source-specific tool noise. The source's native quirks (auth, pagination, content-type) are handled inside the sub-handler.

- Action: `urn:iep:action:owm:navigate-source`
- HTTP: `POST {base}/owm/navigate_source`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | string | yes | Source key (e.g., "web", "drive", "slack"). Use list_sources to enumerate currently-loaded adapters. |
| `verb` | one of `ls`, `cat`, `grep`, `recent` | yes | Navigation verb. |
| `args` | object | yes | Verb-specific arguments. cat: { uri }. grep: { pattern, scope? }. ls: { path? }. recent: { window_minutes? }. |

## `owm.update_source`

**Write to an external source via uniform action**

Write back to an external source (post Slack message, append note to drive doc, comment on PR). Uniform write surface; per-source sub-handler owns the protocol.

- Action: `urn:iep:action:owm:update-source`
- HTTP: `POST {base}/owm/update_source`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | string | yes | Source key. |
| `action` | string | yes | Source-specific action (post, append, comment, ...). |
| `args` | object | yes | Action-specific arguments. |

## `owm.list_sources`

**List currently-wired source adapters**

Return the source keys + supported verbs the bridge currently has loaded. Useful before asking the main agent to navigate.

- Action: `urn:iep:action:owm:list-sources`
- HTTP: `POST {base}/owm/list_sources`
- Inputs: none

## `owm.aggregate_decisions_query`

**[operator] Aggregate-privacy query over decision lineage**

Org-operator-side: return counts / thresholds / lineage summaries over owm:Decision descriptors. Five privacy modes layered on the same surface: v1 abac (default) | v2 merkle-attested-opt-in (verifiable count + Merkle inclusion proofs over contributing descriptor URLs) | v3 zk-aggregate (homomorphic Pedersen sum + DP-Laplace noise) | v3.1 + require_signed_bounds (regulator-grade attribution) | v3.2 + epsilon_budget_max (cumulative ε discipline). Distribution-shaped metrics (mean-revision / supersession-distribution / contributor-breadth) work under v1/v2; v3 supports decision-count only. Returns the underlying count + the chosen mode's attestation bundle.

- Action: `urn:iep:action:owm:aggregate-decisions-query`
- HTTP: `POST {base}/owm/aggregate_decisions_query`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `period_from` | string | yes | ISO 8601 lower bound on iep:TemporalFacet.validFrom. |
| `period_to` | string | yes | ISO 8601 upper bound. |
| `scope_iri` | string | no | Optional scope (project, team, decision class) to narrow the aggregate. |
| `metric` | string | yes | One of: decision-count \| mean-revision-count \| supersession-distribution \| contributor-breadth. |
| `privacy_mode` | string | no | One of: abac (default v1) \| merkle-attested-opt-in (v2) \| zk-aggregate (v3 single-sum). zk-distribution (v3 histogram) is NOT implemented on this surface and is refused with 501 rather than silently answered on the v1 ABAC path — it is wired in the foxxi vertical. The bundle returned in the response advertises which path was taken. |
| `epsilon` | number | no | DP ε budget for zk-aggregate / zk-distribution modes. Required when privacy_mode is one of those. For zk-distribution this is the per-bucket ε; histogram-level cumulative ε under sequential composition is k * ε. |
| `distribution_edges` | array | no | v3 zk-distribution: ascending bucket-edge boundaries as decimal-string bigints. Required when privacy_mode=zk-distribution. Right-open buckets except the last (right-closed at distribution_max_value). |
| `distribution_max_value` | string | no | v3 zk-distribution: upper bound (decimal-string bigint) for the last bucket. Required when privacy_mode=zk-distribution. |
| `epsilon_budget_max` | number | no | v3.2: declare a cumulative ε cap for this query session. The operator constructs a per-call EpsilonBudget and refuses to run if cumulative consumption would exceed cap. |
| `threshold_reveal_n` | number | no | v4-partial+VSS: total pseudo-aggregators in the threshold-reveal committee for trueBlinding. When set with privacy_mode=zk-aggregate, the aggregator emits Shamir shares + Feldman VSS `coefficientCommitments` (tampered shares caught BEFORE Lagrange reconstruction) + omits trueBlinding from audit fields. |
| `threshold_reveal_t` | number | no | v4-partial+VSS: threshold for reconstruction. Required when threshold_reveal_n is supplied. After a successful t-of-n reconstruction, the committee signs a CommitteeReconstructionAttestation (chain-of-custody) via signCommitteeReconstruction + publishCommitteeReconstructionAttestation. |

## `owm.project_health_summary`

**[operator] Per-project rollup of follow-up flow + decision recency**

Org-operator-side: aggregate-shaped rollup over a project — follow-up open/closed counts, decision recency, contributor breadth, supersession churn. Individual descriptors only surface where the contributor has explicitly issued share_with on them. Composes the existing owm:Project + owm:Decision + owm:FollowUp shapes.

- Action: `urn:iep:action:owm:project-health-summary`
- HTTP: `POST {base}/owm/project_health_summary`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `project_iri` | string | yes | IRI of the owm:Project being summarized. |
| `window_days` | number | no | Recency window in days for "stale" thresholds. Default 30. |

## `owm.publish_org_policy`

**[operator] Sign and publish an org-level policy descriptor**

Org-operator-side: publish a SIGNED org-policy descriptor to the org pod — retention windows, decision-promotion thresholds, framework-compliance attestations, source-adapter governance rules. Authored by an org-authority signing key (NOT a contributor key). Contributors discover via federated read; per-graph share_with is the boundary that determines who sees what.

- Action: `urn:iep:action:owm:publish-org-policy`
- HTTP: `POST {base}/owm/publish_org_policy`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `policy_type` | string | yes | One of: retention \| decision-promotion \| compliance-attestation \| source-governance. |
| `policy_body` | object | yes | Policy content as typed descriptor data (shape depends on policy_type). |
| `authority_did` | string | yes | DID of the org-authority signing key. |
| `org_pod_url` | string | yes | Pod URL of the publishing org. |

## `owm.publish_compliance_evidence`

**[operator] Wrap an operational event as compliance-grade evidence**

Org-operator-side: wrap an org-level operational event (deploy, access change, key rotation, incident, quarterly review) as a compliance: true descriptor citing the relevant control IRIs (soc2:CC6.1, eu-ai-act:Article15, nist-rmf:MG-4.1, etc.). Composes src/ops/ for the event shape and integrations/compliance-overlay/ for the framework citation. The same code path that records the ops event becomes board-facing audit evidence; no parallel pipeline.

- Action: `urn:iep:action:owm:publish-compliance-evidence`
- HTTP: `POST {base}/owm/publish_compliance_evidence`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `event_kind` | string | yes | One of: deploy \| access-change \| key-rotation \| incident \| quarterly-review. |
| `event_payload` | object | yes | Payload matching the src/ops/ buildXEvent signature for the chosen kind. |
| `framework` | string | yes | One of: soc2 \| eu-ai-act \| nist-rmf. |
| `cited_controls` | array | yes | Array of control IRIs being evidenced (e.g., ["soc2:CC6.1"]). |
| `org_pod_url` | string | yes | Pod URL of the publishing org. |

