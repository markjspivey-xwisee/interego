# LRS adapter: every affordance

Derived from `applications/lrs-adapter/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 4 affordances.

## `lrs.ingest_statement`

**Ingest one xAPI Statement from an LRS**

Fetch a single xAPI Statement from an LRS by ID, project as iep:ContextDescriptor in the user's pod with lrs:StatementIngestion audit. Auto-negotiates xAPI version (2.0.0 preferred; falls back to 1.0.3 for legacy LRSes like SCORM Cloud).

- Action: `urn:iep:action:lrs:ingest-statement`
- HTTP: `POST {base}/lrs/ingest_statement`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `statement_id` | string | yes | xAPI Statement UUID. |
| `lrs_endpoint` | string | yes | LRS xAPI endpoint URL. |
| `lrs_username` | string | yes | LRS Basic auth username (Activity Provider key). |
| `lrs_password` | string | yes | LRS Basic auth password (Activity Provider secret). |
| `lrs_preferred_version` | one of `2.0.0`, `1.0.3` | no | Preferred xAPI version. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lrs.ingest_statement_batch`

**Ingest a batch of xAPI Statements from an LRS**

Fetch a batch of xAPI Statements from an LRS by filter (verb / activity / agent / since / until / limit) and publish each as iep:ContextDescriptor in the user's pod.

- Action: `urn:iep:action:lrs:ingest-statement-batch`
- HTTP: `POST {base}/lrs/ingest_statement_batch`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `lrs_endpoint` | string | yes | LRS xAPI endpoint URL. |
| `lrs_username` | string | yes | LRS Basic auth username. |
| `lrs_password` | string | yes | LRS Basic auth password. |
| `lrs_preferred_version` | one of `2.0.0`, `1.0.3` | no | Preferred xAPI version. |
| `verb` | string | no | Filter by verb IRI. |
| `activity` | string | no | Filter by activity IRI. |
| `agent` | object | no | Filter by xAPI Agent. |
| `since` | string | no | ISO timestamp lower bound. |
| `until` | string | no | ISO timestamp upper bound. |
| `limit` | integer | no | Max statements to fetch. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lrs.project_descriptor`

**Project a descriptor to an LRS as an xAPI Statement**

Read an Asserted descriptor from the pod and project to xAPI Statement, POST to the LRS. Counterfactual ALWAYS skipped; Hypothetical skipped without opt-in; multi-narrative descriptors lossy with audit-loud lossNote rows.

- Action: `urn:iep:action:lrs:project-descriptor`
- HTTP: `POST {base}/lrs/project_descriptor`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `descriptor_iri` | string | yes | IRI of the descriptor to project. |
| `actor` | object | yes | xAPI Agent shape for the Statement actor. |
| `verb_id` | string | yes | xAPI verb IRI. |
| `object_id` | string | yes | xAPI Activity IRI. |
| `verb_display` | string | no | Verb display name. |
| `object_name` | string | no | Activity display name. |
| `modal_status` | one of `Asserted`, `Hypothetical`, `Counterfactual` | no | Source descriptor's modal status. |
| `allow_hypothetical` | boolean | no | When true and modal_status=Hypothetical, project anyway with audit-loud lossy markers. |
| `coherent_narratives` | array of string | no | Multiple coherent narratives — preserved in result.extensions; lossy=true flag set. |
| `lrs_endpoint` | string | yes | LRS xAPI endpoint URL. |
| `lrs_username` | string | yes | LRS Basic auth username. |
| `lrs_password` | string | yes | LRS Basic auth password. |
| `lrs_preferred_version` | one of `2.0.0`, `1.0.3` | no | Preferred xAPI version. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lrs.lrs_about`

**Probe an LRS's supported xAPI versions**

Probe the LRS's /xapi/about endpoint to discover supported xAPI versions. Useful diagnostic for understanding which Statement projection target is appropriate.

- Action: `urn:iep:action:lrs:lrs-about`
- HTTP: `POST {base}/lrs/lrs_about`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `lrs_endpoint` | string | yes | LRS xAPI endpoint URL. |
| `lrs_username` | string | yes | LRS Basic auth username. |
| `lrs_password` | string | yes | LRS Basic auth password. |
| `lrs_preferred_version` | one of `2.0.0`, `1.0.3` | no | Preferred xAPI version. |

