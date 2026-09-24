---
name: interego-organizational-working-memory
description: "Organizational working memory as Interego affordances: 14 tools (upsert-person, upsert-project, record-decision, queue-followup, record-note, list-overdue-followups, and more). Use when keeping an organisation's working memory on pods: people, decisions, commitments and their context, and the operator's aggregate queries over them."
license: MIT
metadata:
  vertical: organizational-working-memory
  source: applications/organizational-working-memory/affordances.ts
  affordances: 14
  manifest: {base}/affordances
  generator: tools/build-skills.ts
---

# Organizational working memory

Use when keeping an organisation's working memory on pods: people, decisions, commitments and their context, and the operator's aggregate queries over them.

Everything here is derived from `applications/organizational-working-memory/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `{base}/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `{base}/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

`{base}` is the origin of a deployment of this vertical's bridge; none is public at the time of generation.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `{base}/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST {base}/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `owm.upsert_person` | Upsert an owm:Person descriptor on the org pod. | `POST {base}/owm/upsert_person` |
| `owm.upsert_project` | Upsert an owm:Project descriptor. | `POST {base}/owm/upsert_project` |
| `owm.record_decision` | Record an owm:Decision descriptor. | `POST {base}/owm/record_decision` |
| `owm.queue_followup` | Queue an owm:FollowUp with a due-date (ISO 8601). | `POST {base}/owm/queue_followup` |
| `owm.record_note` | Capture a free-form insight as a content-addressed pgsl:Atom + descriptor. | `POST {base}/owm/record_note` |
| `owm.list_overdue_followups` | Return follow-ups whose due_at is on or before now (or `now` arg). | `POST {base}/owm/list_overdue_followups` |
| `owm.discover_subgraph` | Affordance-walk the org pod for descriptors related to a subject IRI. | `POST {base}/owm/discover_subgraph` |
| `owm.navigate_source` | Read an external information source (web, drive, slack, github, ...) using uniform verbs (ls / cat / grep / recent). | `POST {base}/owm/navigate_source` |
| `owm.update_source` | Write back to an external source (post Slack message, append note to drive doc, comment on PR). | `POST {base}/owm/update_source` |
| `owm.list_sources` | Return the source keys + supported verbs the bridge currently has loaded. | `POST {base}/owm/list_sources` |
| `owm.aggregate_decisions_query` | Org-operator-side: return counts / thresholds / lineage summaries over owm:Decision descriptors. | `POST {base}/owm/aggregate_decisions_query` |
| `owm.project_health_summary` | Org-operator-side: aggregate-shaped rollup over a project — follow-up open/closed counts, decision recency, contributor breadth, supersession churn. | `POST {base}/owm/project_health_summary` |
| `owm.publish_org_policy` | Org-operator-side: publish a SIGNED org-policy descriptor to the org pod — retention windows, decision-promotion thresholds, framework-compliance attestations,… | `POST {base}/owm/publish_org_policy` |
| `owm.publish_compliance_evidence` | Org-operator-side: wrap an org-level operational event (deploy, access change, key rotation, incident, quarterly review) as a compliance: true descriptor citin… | `POST {base}/owm/publish_compliance_evidence` |

