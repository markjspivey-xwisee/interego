---
name: interego-foxxi
description: "Foxxi content intelligence, learner surface as Interego affordances: 47 tools (record-private-performance-outcome-signed, read-private-performance-outcomes-signed, read-private-performance-calibration-signed, discover-lrs, discover-assigned-courses, discover-course-catalogs, and more). Use when a learner or an agent acting for one needs their assigned courses, a course's concept map or context, an answer grounded in course content, a credential, a learner record, a SCORM or cmi5 session, or private performance feedback on an Interego pod."
license: MIT
metadata:
  vertical: foxxi-content-intelligence
  source: applications/foxxi-content-intelligence/affordances.ts
  affordances: 47
  manifest: "https://foxxi-bridge.interego.xwisee.com/affordances"
  generator: tools/build-skills.ts
---

# Foxxi content intelligence, learner surface

Use when a learner or an agent acting for one needs their assigned courses, a course's concept map or context, an answer grounded in course content, a credential, a learner record, a SCORM or cmi5 session, or private performance feedback on an Interego pod.

Everything here is derived from `applications/foxxi-content-intelligence/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `https://foxxi-bridge.interego.xwisee.com/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `https://foxxi-bridge.interego.xwisee.com/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `https://foxxi-bridge.interego.xwisee.com/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST https://foxxi-bridge.interego.xwisee.com/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `foxxi.record_private_performance_outcome` | Signed payload {agent_id,timestamp,outcome:{episode_id,plan_id,plan_sha256,intervention:{type,delivered,artifact:{uri,version,sha256},delivered_at},post,fresh?… | `POST https://foxxi-bridge.interego.xwisee.com/agent/performance/outcome` *(HTTP only)* |
| `foxxi.read_private_performance_outcomes` | Signed payload {agent_id,timestamp,episode_id?}. | `POST https://foxxi-bridge.interego.xwisee.com/agent/performance/outcomes` *(HTTP only)* |
| `foxxi.read_private_performance_calibration` | Signed payload {agent_id,timestamp}. | `POST https://foxxi-bridge.interego.xwisee.com/agent/performance/calibration` *(HTTP only)* |
| `foxxi.discover_lrs` | Dereference the LRS's own discovery document (xAPI 2.0 §4.1.6 `about`). | `GET https://foxxi-bridge.interego.xwisee.com/xapi/about` *(HTTP only)* |
| `foxxi.discover_assigned_courses` | Walk the L&D admin's policy descriptors + the learner's audience-tag membership, returning the courses currently assigned to this learner (required + suggested… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/discover_assigned_courses` |
| `foxxi.discover_course_catalogs` | Every federated course catalog the given pods publish, found by its descriptor type (hyprcat:FederatedCatalog) in each pod's manifest and read back: the catalo… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/discover_course_catalogs` |
| `foxxi.earned_credentials` | For each course assigned to the learner: credentialed (a verified, unexpired completion credential in their pod wallet), claimable (their own xAPI record demon… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/earned_credentials` |
| `foxxi.claim_credential` | The tenant issues an Open Badges 3.0 completion credential for a catalog course only from the learner's own record: a passed, mastered, satisfied or waived xAP… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/claim_credential` |
| `foxxi.verify_credential` | What a relying party should check before believing an Open Badges 3.0 credential: the Data Integrity proof verifies against the issuer's key and the proof's ke… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/verify_credential` |
| `foxxi.earned_credentials_signed` | foxxi.earned_credentials for the courses this bridge's SCORM engine grades, signed the way the engine's own routes are: by your wallet, or by an agent holding… | `POST https://foxxi-bridge.interego.xwisee.com/agent/credentials/earned` *(HTTP only)* |
| `foxxi.claim_credential_signed` | foxxi.claim_credential for a course this bridge's SCORM engine grades, signed by your wallet or by an agent holding your delegation (a relay connection, such a… | `POST https://foxxi-bridge.interego.xwisee.com/agent/credentials/claim` *(HTTP only)* |
| `foxxi.cmi5_launch_signed` | Launch an Assignable Unit of a cmi5 course published on this bridge, for yourself, signed by your wallet or by an agent holding your delegation (a relay connec… | `POST https://foxxi-bridge.interego.xwisee.com/agent/cmi5/launch` *(HTTP only)* |
| `foxxi.lti_launch_signed` | Launch a course this bridge's SCORM engine grades from Foxxi's own LMS, the LTI 1.3 Platform this bridge runs beside its Tool, for yourself, signed by your wal… | `POST https://foxxi-bridge.interego.xwisee.com/agent/lti/launch` *(HTTP only)* |
| `foxxi.lti_gradebook_signed` | Your row of the gradebook in Foxxi's own LMS, signed by your wallet or by an agent holding your delegation: every course in the LMS course context, and the gra… | `POST https://foxxi-bridge.interego.xwisee.com/agent/lti/gradebook` *(HTTP only)* |
| `foxxi.consume_lesson` | Stream-load a Foxxi-parsed lesson's structural stratum (slides, audio, transcripts) for consumption, and emit an fxa:ConsumptionEvent descriptor + an xAPI Stat… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/consume_lesson` |
| `foxxi.ask_course_question` | Grounded Q&A over a course's narration transcripts + extracted concepts. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ask_course_question` |
| `foxxi.ask_course_question_agentic` | Multi-step agentic retrieval + LLM synthesis: (1) federated concept-graph search across the primary course + any loaded federation peers, (2) prereq + modifier… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ask_course_question_agentic` |
| `foxxi.retrieve_course_context` | Pure retrieval, no LLM call. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/retrieve_course_context` |
| `foxxi.explore_concept_map` | Fetch the concept graph a course PUBLISHED (concepts with tier + confidence, prerequisite edges, modifier-of relations) from its on-pod fxa:CoursePackageBundle… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/explore_concept_map` |
| `foxxi.extend_standards` | Emergent, self-descriptive capability: an agent extends a standard IN THE FLOW OF WORK — a new xAPI context extension, an xAPI Profile fragment, or an IEEE-LER… | `POST https://foxxi-bridge.interego.xwisee.com/agent/extend-standards` |
| `foxxi.review_record` | Review your IEEE P2997 Enterprise Learner Record + 1EdTech CLR 2.0 credential wallet, virtualized by Foxxi entirely over your OWN pod. | `POST https://foxxi-bridge.interego.xwisee.com/agent/review-record` *(HTTP only)* |
| `foxxi.issue_credential` | Issue an Open Badges 3.0 / W3C Verifiable Credential to an agent who demonstrated a competency you defined, as the AUTHORITY for your own vertical. | `POST https://foxxi-bridge.interego.xwisee.com/agent/issue-credential` *(HTTP only)* |
| `foxxi.verify_extension` | Independently verify, from the SUBJECT's own authoritative pod records, that they (a) completed an engine-graded course and (b) recorded a domain-typed Standar… | `POST https://foxxi-bridge.interego.xwisee.com/agent/verify-extension` *(HTTP only)* |
| `foxxi.prove_competency_signed` | Holder-facing BBS+ proof, GROUNDED IN THE HOLDER'S ACTUAL RECORD: the bridge assembles the holder's learner record, refuses any competency that record does not… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/prove_competency` *(HTTP only)* |
| `foxxi.self_assert_competency` | Mint a BBS+ credential about YOURSELF and derive a selective-disclosure presentation from it. | `POST https://foxxi-bridge.interego.xwisee.com/agent/prove-competency` *(HTTP only)* |
| `foxxi.verify_presentation` | Verifier-side. | `POST https://foxxi-bridge.interego.xwisee.com/agent/verify-presentation` *(HTTP only)* |
| `foxxi.void_credential` | Remove a credential you hold from your OWN pod wallet by its descriptor URL (the sourceDescriptor of a CLR entry returned by review-record). | `POST https://foxxi-bridge.interego.xwisee.com/agent/void-credential` *(HTTP only)* |
| `foxxi.publish_encryption_key` | Publish YOUR X25519 public key to your OWN pod so the bridge encrypts your canonical PGSL holons TO YOU (not just to itself) — making your recorded performance… | `POST https://foxxi-bridge.interego.xwisee.com/agent/publish-encryption-key` *(HTTP only)* |
| `foxxi.course_analyze` | Fingerprint WHICH authoring tool produced a SCORM package (from its imsmanifest.xml + file list/contents), build the concept/slide knowledge-graph, and compose… | `POST https://foxxi-bridge.interego.xwisee.com/agent/course/analyze` *(HTTP only)* |
| `foxxi.course_analyze_authored` | Analyze a course an agent authored via /agent/scorm/author. | `POST https://foxxi-bridge.interego.xwisee.com/agent/course/analyze-authored` *(HTTP only)* |
| `foxxi.course_ask` | Grounded Q&A over a FoxxiAgenticCourse (from /agent/course/analyze*). | `POST https://foxxi-bridge.interego.xwisee.com/agent/course/ask` *(HTTP only)* |
| `foxxi.course_skill` | Pure projection: turn a FoxxiAgenticCourse (from /agent/course/analyze*) into a SKILL.md document an agent can load — carrying the course provenance (tool, aut… | `POST https://foxxi-bridge.interego.xwisee.com/agent/course/skill` *(HTTP only)* |
| `foxxi.course_analyze_skill` | Ingest an agent skill (SKILL.md string) as a course: parse it, report the agent-skill provenance fingerprint (ground truth — a skills.md, not a SCORM tool), an… | `POST https://foxxi-bridge.interego.xwisee.com/agent/course/analyze-skill` *(HTTP only)* |
| `foxxi.skill_affordance` | The STRICT SKILL.md ⇄ iep:Affordance translator (core @interego/skills bridge): translate a SKILL.md into a real iep:Affordance ContextDescriptor graph (subjec… | `POST https://foxxi-bridge.interego.xwisee.com/agent/skill/affordance` *(HTTP only)* |
| `foxxi.course_propose_successor` | The Living Curriculum: a course reasons about ITSELF concept by concept. | `POST https://foxxi-bridge.interego.xwisee.com/agent/course/propose-successor` *(HTTP only)* |
| `foxxi.calibration_merge` | Federated calibration: pool SIGNED (regime × cause × intervention → verdict) aggregate tallies from multiple orgs WITHOUT sharing a single raw record. | `POST https://foxxi-bridge.interego.xwisee.com/agent/calibration/merge` *(HTTP only)* |
| `foxxi.record_performance_signed` | Record one unit of on-the-job production work as an xAPI performed statement, into your OWN Foxxi lens, authenticated by your delegation (the agent-drivable co… | `POST https://foxxi-bridge.interego.xwisee.com/agent/record-performance` *(HTTP only)* |
| `foxxi.ingest_course` | Author a Foxxi course (cmi5/SCORM-shaped: modules → lessons → fragments; assessment-item fragments are scored) and PUBLISH it to your OWN pod, authenticated by… | `POST https://foxxi-bridge.interego.xwisee.com/agent/ingest-course` *(HTTP only)* |
| `foxxi.record_course_completion` | Record completing + passing a course as cmi5 xAPI (launched/initialized/completed/passed/terminated) into your OWN lens, authenticated by your delegation (the… | `POST https://foxxi-bridge.interego.xwisee.com/agent/record-course-completion` *(HTTP only)* |
| `foxxi.forwarding_targets` | Set / list / remove the downstream LRS endpoints YOUR OWN xAPI statements are forwarded to (per-user Statement Forwarding). | `POST https://foxxi-bridge.interego.xwisee.com/agent/forwarding/targets` *(HTTP only)* |
| `foxxi.write_xapi_statements_signed` | Signed transport over the standard xAPI Statements Resource, scoped to your own lens. | `POST https://foxxi-bridge.interego.xwisee.com/agent/xapi-statements/write` *(HTTP only)* |
| `foxxi.read_xapi_statements_signed` | Signed transport to GET /xapi/statements in your own lens. | `POST https://foxxi-bridge.interego.xwisee.com/agent/xapi-statements/read` *(HTTP only)* |
| `foxxi.credentials` | Mint / list / revoke the Basic-auth credentials an upstream system uses to forward xAPI statements INTO your OWN lens. | `POST https://foxxi-bridge.interego.xwisee.com/agent/credentials` *(HTTP only)* |
| `foxxi.publish_memory` | Author a job aid or quick reference as yourself. | `POST https://foxxi-bridge.interego.xwisee.com/agent/publish-memory` *(HTTP only)* |
| `foxxi.scorm_author` | Author a SCORM 2004 course as yourself. | `POST https://foxxi-bridge.interego.xwisee.com/agent/scorm/author` *(HTTP only)* |
| `foxxi.scorm_launch` | Launch an authored SCORM course as yourself. | `POST https://foxxi-bridge.interego.xwisee.com/agent/scorm/launch` *(HTTP only)* |
| `foxxi.scorm_submit` | Submit the current SCO. | `POST https://foxxi-bridge.interego.xwisee.com/agent/scorm/submit` *(HTTP only)* |

