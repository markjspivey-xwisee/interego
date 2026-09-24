---
name: interego-learner-performer-companion
description: "Learner-performer companion as Interego affordances: 11 tools (ingest-training-content, import-credential, record-performance-review, record-learning-experience, grounded-answer, list-wallet, and more). Use when accompanying a learner-performer: ingesting training content, tracking learning experiences, importing credentials into a learner wallet, and publishing authoritative enterprise content and cohort credential templates."
license: MIT
metadata:
  vertical: learner-performer-companion
  source: applications/learner-performer-companion/affordances.ts
  affordances: 11
  manifest: {base}/affordances
  generator: tools/build-skills.ts
---

# Learner-performer companion

Use when accompanying a learner-performer: ingesting training content, tracking learning experiences, importing credentials into a learner wallet, and publishing authoritative enterprise content and cohort credential templates.

Everything here is derived from `applications/learner-performer-companion/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `{base}/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `{base}/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

`{base}` is the origin of a deployment of this vertical's bridge; none is public at the time of generation.

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `{base}/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST {base}/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `lpc.ingest_training_content` | Unwrap a SCORM 1.2 / SCORM 2004 / cmi5 zip package, extract launchable lesson content, mint content-addressed PGSL atoms, and publish lpc:TrainingContent + lpc… | `POST {base}/lpc/ingest_training_content` |
| `lpc.import_credential` | Verify a W3C Verifiable Credential (vc-jwt or DataIntegrityProof JSON-LD) and publish as lpc:Credential to the user's pod. | `POST {base}/lpc/import_credential` |
| `lpc.record_performance_review` | Publish a performance review with iep:ProvenanceFacet attributing it to the manager (NOT the user). | `POST {base}/lpc/record_performance_review` |
| `lpc.record_learning_experience` | Ingest an xAPI Statement (any version 1.0.x or 2.0.x) as an lpc:LearningExperience descriptor in the user's pod, cross-linked to training content and credentia… | `POST {base}/lpc/record_learning_experience` |
| `lpc.grounded_answer` | Answer a natural-language question by retrieving from the user's pod with verbatim citation. | `POST {base}/lpc/grounded_answer` |
| `lpc.list_wallet` | Return a summary of training content, credentials, performance records, and learning experiences in the user's pod-backed wallet. | `POST {base}/lpc/list_wallet` |
| `lpc.opt_into_cohort` | Learner-side: publish a SIGNED agg:CohortParticipation descriptor on the learner's pod, declaring willingness to be counted in an institutional aggregate-cohor… | `POST {base}/lpc/opt_into_cohort` |
| `lpc.publish_authoritative_content` | Institution-side: publish lpc:TrainingContent + lpc:LearningObjective descriptors to the INSTITUTION's own pod (NOT the learner's) from a caller-supplied catal… | `POST {base}/lpc/publish_authoritative_content` |
| `lpc.issue_cohort_credential_template` | Institution-side: publish a SIGNED credential TEMPLATE (the rubric for what is earned) to the institution's pod. | `POST {base}/lpc/issue_cohort_credential_template` |
| `lpc.aggregate_cohort_query` | Institution-side: query aggregate metrics over consenting learners' pods — completion counts, score distributions, competency-coverage thresholds — without see… | `POST {base}/lpc/aggregate_cohort_query` |
| `lpc.project_to_lrs` | Institution-side: with the learner's per-graph consent, translate lpc:LearningExperience descriptors from the learner's pod into xAPI 2.0 Statements and POST t… | `POST {base}/lpc/project_to_lrs` |

