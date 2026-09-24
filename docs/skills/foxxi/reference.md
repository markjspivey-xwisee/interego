# Foxxi content intelligence, learner surface: every affordance

Derived from `applications/foxxi-content-intelligence/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 42 affordances.

## `foxxi.record_private_performance_outcome`

**Record a private measured intervention episode**

Signed payload {agent_id,timestamp,outcome:{episode_id,plan_id,plan_sha256,intervention:{type,delivered,artifact:{uri,version,sha256},delivered_at},post,fresh?,assistance,observed_at}}. The server plan is created using private_evidence on contextualize-and-plan. Measurements include exact canonical report content and evidence references. No caller success labels; no causal attribution. Full input contract: /agent/performance/schema.

- Action: `urn:iep:action:foxxi:record-private-performance-outcome-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/performance/outcome` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | Signed payload {agent_id,timestamp,outcome:{episode_id,plan_id,plan_sha256,intervention:{type,delivered,artifact:{uri,version,sha256},delivered_at},post,fresh?,assistance,observed_at}}. The server plan is created using private_evidence on contextualize-and-plan. Measurements include exact canonical report content and evidence references. No caller success labels; no causal attribution. Full schema: {"version":"1","planner":{"path":"/agent/contextualize-and-plan","optIn":"private_evidence","reviewOnly":"private_review: true reads own empirical profile without a new plan or counted episode"},"transport":"Use existing sign_request then act. agent_id/timestamp are required by signed transport. Automatically stamped subject_pod_url is accepted only when equivalent to the authenticated own pod, then excluded from logical plan identity.","ref":{"uri":"HTTP(S) or URN immutable evidence identifier","version":"nonempty version string","sha256":"lowercase SHA-256 hex of evidence bytes; report uses canonical JSON below"},"private_evidence":{"episode_id":"stable id for one learner/intervention episode","study_id":"study id","learner_id":"learner label (not an independently verified identity)","policy":"ref","baseline":"measurement with phase=baseline","assistance":"baseline assistance description","independence":"same-account-procedural \| self-assessed","target":{"minimum_score":"number >0 and <=1","maximum_unsafe":"nonnegative integer"}},"measurement":{"phase":"baseline \| post \| fresh","correct":"integer >=0","total":"integer >0, >=correct","unsafe":"integer >=0, <=total","assessed_at":"observed ISO UTC timestamp","assessment":"ref","responses":"ref","scorer":"ref, same hash/version in every phase","report":"ref whose sha256 hashes report_content","report_content":{"phase":"exact matching phase","correct":"exact matching correct","total":"exact matching total","unsafe":"exact matching unsafe","assessed_at":"exact matching timestamp","policy_sha256":"policy.sha256","assessment_sha256":"assessment.sha256","responses_sha256":"responses.sha256","scorer_sha256":"scorer.sha256"}},"canonicalHash":"SHA-256 UTF-8 JSON with object keys recursively lexicographically sorted, compact separators, array order retained, finite JSON values only. report_content accepts exactly the nine declared fields.","outcome":{"episode_id":"same as private_evidence.episode_id","plan_id":"returned privatePlan.plan_id","plan_sha256":"returned privatePlan.sha256","intervention":{"type":"a selected intervention in the bound server plan","delivered":"boolean","artifact":"ref","delivered_at":"UTC time >= baseline and server plan creation, <= post"},"post":"measurement phase=post","fresh":"optional additional measurement phase=fresh; omit if no additional follow-up occurred","assistance":"post/fresh assistance description","observed_at":"UTC time >= last assessment"},"actionPayloads":{"record":"{agent_id,timestamp,subject_pod_url?,outcome}","read":"{agent_id,timestamp,subject_pod_url?,episode_id?}","calibration":"{agent_id,timestamp,subject_pod_url?}"},"limits":"1000 plans and 1000 episodes, 4 MB encrypted snapshot per account. Private content is encrypted to owner+bridge; trusted bridge can decrypt. No public projection or shared-seed update.","verification":"Arithmetic, submitted report content hashes and fixed evidence bindings are checked. Evidence URIs are not fetched. Server plans/outcomes carry a bridge-secret authentication tag. Assessor truth, independent sampling and causal learning are not verified.","calibration":"Only derived Knowable gap-analysis with named cause, baseline gap, newly delivered selected intervention and non-self-assessed reports is eligible. Eligible rates are tentative: this caller-supplied evidence trust class always remains Hypothetical and cannot trigger automatic rate-driven intervention swapping. Manager may use observations for review/stop. Seeds excluded."} |
| `_signature` | string | yes | Use sign_request; signature binds agent_id and complete payload. |

## `foxxi.read_private_performance_outcomes`

**Read your private server plans and measured outcomes**

Signed payload {agent_id,timestamp,episode_id?}. Reads only the verified caller own encrypted pod. Full input contract: /agent/performance/schema.

- Action: `urn:iep:action:foxxi:read-private-performance-outcomes-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/performance/outcomes` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | Signed payload {agent_id,timestamp,episode_id?}. Reads only the verified caller own encrypted pod. Full schema: {"version":"1","planner":{"path":"/agent/contextualize-and-plan","optIn":"private_evidence","reviewOnly":"private_review: true reads own empirical profile without a new plan or counted episode"},"transport":"Use existing sign_request then act. agent_id/timestamp are required by signed transport. Automatically stamped subject_pod_url is accepted only when equivalent to the authenticated own pod, then excluded from logical plan identity.","ref":{"uri":"HTTP(S) or URN immutable evidence identifier","version":"nonempty version string","sha256":"lowercase SHA-256 hex of evidence bytes; report uses canonical JSON below"},"private_evidence":{"episode_id":"stable id for one learner/intervention episode","study_id":"study id","learner_id":"learner label (not an independently verified identity)","policy":"ref","baseline":"measurement with phase=baseline","assistance":"baseline assistance description","independence":"same-account-procedural \| self-assessed","target":{"minimum_score":"number >0 and <=1","maximum_unsafe":"nonnegative integer"}},"measurement":{"phase":"baseline \| post \| fresh","correct":"integer >=0","total":"integer >0, >=correct","unsafe":"integer >=0, <=total","assessed_at":"observed ISO UTC timestamp","assessment":"ref","responses":"ref","scorer":"ref, same hash/version in every phase","report":"ref whose sha256 hashes report_content","report_content":{"phase":"exact matching phase","correct":"exact matching correct","total":"exact matching total","unsafe":"exact matching unsafe","assessed_at":"exact matching timestamp","policy_sha256":"policy.sha256","assessment_sha256":"assessment.sha256","responses_sha256":"responses.sha256","scorer_sha256":"scorer.sha256"}},"canonicalHash":"SHA-256 UTF-8 JSON with object keys recursively lexicographically sorted, compact separators, array order retained, finite JSON values only. report_content accepts exactly the nine declared fields.","outcome":{"episode_id":"same as private_evidence.episode_id","plan_id":"returned privatePlan.plan_id","plan_sha256":"returned privatePlan.sha256","intervention":{"type":"a selected intervention in the bound server plan","delivered":"boolean","artifact":"ref","delivered_at":"UTC time >= baseline and server plan creation, <= post"},"post":"measurement phase=post","fresh":"optional additional measurement phase=fresh; omit if no additional follow-up occurred","assistance":"post/fresh assistance description","observed_at":"UTC time >= last assessment"},"actionPayloads":{"record":"{agent_id,timestamp,subject_pod_url?,outcome}","read":"{agent_id,timestamp,subject_pod_url?,episode_id?}","calibration":"{agent_id,timestamp,subject_pod_url?}"},"limits":"1000 plans and 1000 episodes, 4 MB encrypted snapshot per account. Private content is encrypted to owner+bridge; trusted bridge can decrypt. No public projection or shared-seed update.","verification":"Arithmetic, submitted report content hashes and fixed evidence bindings are checked. Evidence URIs are not fetched. Server plans/outcomes carry a bridge-secret authentication tag. Assessor truth, independent sampling and causal learning are not verified.","calibration":"Only derived Knowable gap-analysis with named cause, baseline gap, newly delivered selected intervention and non-self-assessed reports is eligible. Eligible rates are tentative: this caller-supplied evidence trust class always remains Hypothetical and cannot trigger automatic rate-driven intervention swapping. Manager may use observations for review/stop. Seeds excluded."} |
| `_signature` | string | yes | Use sign_request; signature binds agent_id and complete payload. |

## `foxxi.read_private_performance_calibration`

**Read your own empirical calibration, excluding seeds**

Signed payload {agent_id,timestamp}. Counts one learner/intervention episode, with eligibility, source and sample counts. No public aggregate publication. Full input contract: /agent/performance/schema.

- Action: `urn:iep:action:foxxi:read-private-performance-calibration-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/performance/calibration` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | Signed payload {agent_id,timestamp}. Counts one learner/intervention episode, with eligibility, source and sample counts. No public aggregate publication. Full schema: {"version":"1","planner":{"path":"/agent/contextualize-and-plan","optIn":"private_evidence","reviewOnly":"private_review: true reads own empirical profile without a new plan or counted episode"},"transport":"Use existing sign_request then act. agent_id/timestamp are required by signed transport. Automatically stamped subject_pod_url is accepted only when equivalent to the authenticated own pod, then excluded from logical plan identity.","ref":{"uri":"HTTP(S) or URN immutable evidence identifier","version":"nonempty version string","sha256":"lowercase SHA-256 hex of evidence bytes; report uses canonical JSON below"},"private_evidence":{"episode_id":"stable id for one learner/intervention episode","study_id":"study id","learner_id":"learner label (not an independently verified identity)","policy":"ref","baseline":"measurement with phase=baseline","assistance":"baseline assistance description","independence":"same-account-procedural \| self-assessed","target":{"minimum_score":"number >0 and <=1","maximum_unsafe":"nonnegative integer"}},"measurement":{"phase":"baseline \| post \| fresh","correct":"integer >=0","total":"integer >0, >=correct","unsafe":"integer >=0, <=total","assessed_at":"observed ISO UTC timestamp","assessment":"ref","responses":"ref","scorer":"ref, same hash/version in every phase","report":"ref whose sha256 hashes report_content","report_content":{"phase":"exact matching phase","correct":"exact matching correct","total":"exact matching total","unsafe":"exact matching unsafe","assessed_at":"exact matching timestamp","policy_sha256":"policy.sha256","assessment_sha256":"assessment.sha256","responses_sha256":"responses.sha256","scorer_sha256":"scorer.sha256"}},"canonicalHash":"SHA-256 UTF-8 JSON with object keys recursively lexicographically sorted, compact separators, array order retained, finite JSON values only. report_content accepts exactly the nine declared fields.","outcome":{"episode_id":"same as private_evidence.episode_id","plan_id":"returned privatePlan.plan_id","plan_sha256":"returned privatePlan.sha256","intervention":{"type":"a selected intervention in the bound server plan","delivered":"boolean","artifact":"ref","delivered_at":"UTC time >= baseline and server plan creation, <= post"},"post":"measurement phase=post","fresh":"optional additional measurement phase=fresh; omit if no additional follow-up occurred","assistance":"post/fresh assistance description","observed_at":"UTC time >= last assessment"},"actionPayloads":{"record":"{agent_id,timestamp,subject_pod_url?,outcome}","read":"{agent_id,timestamp,subject_pod_url?,episode_id?}","calibration":"{agent_id,timestamp,subject_pod_url?}"},"limits":"1000 plans and 1000 episodes, 4 MB encrypted snapshot per account. Private content is encrypted to owner+bridge; trusted bridge can decrypt. No public projection or shared-seed update.","verification":"Arithmetic, submitted report content hashes and fixed evidence bindings are checked. Evidence URIs are not fetched. Server plans/outcomes carry a bridge-secret authentication tag. Assessor truth, independent sampling and causal learning are not verified.","calibration":"Only derived Knowable gap-analysis with named cause, baseline gap, newly delivered selected intervention and non-self-assessed reports is eligible. Eligible rates are tentative: this caller-supplied evidence trust class always remains Hypothetical and cannot trigger automatic rate-driven intervention swapping. Manager may use observations for review/stop. Seeds excluded."} |
| `_signature` | string | yes | Use sign_request; signature binds agent_id and complete payload. |

## `foxxi.discover_lrs`

**Find the xAPI Learning Record Store this bridge serves**

Dereference the LRS's own discovery document (xAPI 2.0 §4.1.6 `about`). Returns the xAPI versions supported plus extensions naming the backend, the tenancy model, the published xAPI Profile, and the IEEE-LER / ADL-TLA spec ontologies. FROM HERE the whole standard LRS surface follows without being restated in this manifest: /xapi/statements (write, query, PUT-by-id, void), /xapi/activities, /xapi/agents, and the Activity State / Activity Profile / Agent Profile document resources — all fixed by the specification rather than by this vertical. Unauthenticated and requires no version header, by design: it is how a client discovers which versions it may then ask for. TO ACTUALLY READ OR WRITE you need Basic credentials scoped to your own lens — mint them yourself with foxxi.credentials (POST /agent/credentials), which is also what an upstream system would use to forward statements in; no admin or operator role is involved. Statements you record through foxxi.record_performance land in that same lens, so course completion and production work are queryable together.

- Action: `urn:iep:action:foxxi:discover-lrs`
- HTTP: `GET https://foxxi-bridge.interego.xwisee.com/xapi/about` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`
- Inputs: none

## `foxxi.discover_assigned_courses`

**Discover assigned courses**

Walk the L&D admin's policy descriptors + the learner's audience-tag membership, returning the courses currently assigned to this learner (required + suggested) with due-by dates derived from policy triggers.

- Action: `urn:iep:action:foxxi:discover-assigned-courses`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/discover_assigned_courses`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Learner DID (web_id pattern from the tenant identity service). |
| `tenant_pod_url` | string | yes | Pod URL of the L&D tenant where policy descriptors live. |
| `audience_tags` | array | no | Optional caller-supplied audience tags to override the learner's default audience membership (e.g., temporary access). |

## `foxxi.discover_course_catalogs`

**Discover course catalogs across pods**

Every federated course catalog the given pods publish, found by its descriptor type (hyprcat:FederatedCatalog) in each pod's manifest and read back: the catalog's issuer and world, and each course as a data product with its title, category, keywords, standard, landing page and the port that fetches it. The issuer is checked against the identity the manifest attributes the descriptor to. No registry: the pods are the ones the caller names, or the tenant pod and the pods this deployment federates with. A pod that cannot be reached is reported, not fatal.

- Action: `urn:iep:action:foxxi:discover-course-catalogs`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/discover_course_catalogs`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `pod_urls` | array of string | no | The pods to walk; omitted, the tenant pod and this deployment's federation peers. |
| `tenant_pod_url` | string | no | The tenant the caller belongs to; omitted, the configured tenant. |

## `foxxi.earned_credentials`

**Where every assigned course stands**

For each course assigned to the learner: credentialed (a verified, unexpired completion credential in their pod wallet), claimable (their own xAPI record demonstrates mastery — a passed, completed, mastered, satisfied or waived statement about the course with success not false and any score at or above the course's threshold, graded by this bridge itself — and no credential is in force), in progress (statements about the course, none demonstrating mastery), or not started. The claimable ones carry the foxxi.claim_credential call; a lapsed credential is named. Reads the learner's own record (shared lattice, lens and durable records) and wallet. A learner asks about themselves; an admin about anyone.

- Action: `urn:iep:action:foxxi:earned-credentials`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/earned_credentials`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | no | The learner's WebID; omitted, the caller. An admin may name any learner. |
| `learner_pod_url` | string | no | The learner's pod when it is not derived from their identity; bounded to the pod space this deployment reads. |
| `tenant_pod_url` | string | no | The tenant whose catalog and assignments apply; omitted, the configured tenant. |
| `audience_tags` | array of string | no | Audience tags to resolve the assignments with, for a learner the tenant directory does not list. |

## `foxxi.claim_credential`

**Claim a credential the record has earned**

The tenant issues an Open Badges 3.0 completion credential for a catalog course only from the learner's own record: a passed, completed, mastered, satisfied or waived xAPI statement about the course, with success not false and any score at or above the course's threshold, and graded by this bridge itself: the SCORM engine's completions carry the bridge's grading tag, so a statement the learner recorded is in the record but does not earn a credential. The credential names that evidence, is signed by the tenant's issuer key, is valid for a year, and is written to the learner's pod wallet; a credentialed statement joins their record. Already held and in force: the held credential comes back and nothing is issued. Not earned: a 409 refusal saying what statement would earn it. A learner claims for themselves; an admin may claim for a learner.

- Action: `urn:iep:action:foxxi:claim-credential`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/claim_credential`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course_id` | string | yes | The tenant catalog course id the credential is for. |
| `learner_did` | string | no | The learner's WebID; omitted, the caller. An admin may name any learner. |
| `learner_pod_url` | string | no | The learner's pod when it is not derived from their identity; bounded to the pod space this deployment reads. |
| `tenant_pod_url` | string | no | The tenant whose catalog applies and whose issuer signs; omitted, the configured tenant. |

## `foxxi.verify_credential`

**Verify a credential**

What a relying party should check before believing an Open Badges 3.0 credential: the Data Integrity proof verifies against the issuer's key and the proof's key is the stated issuer; validUntil has not passed and validFrom has; the issuer is one this tenant stands behind (its own issuer key); the credential names its subject. Answers every check and, in words, what each failed one found. No caller identity is needed: anyone may verify.

- Action: `urn:iep:action:foxxi:verify-credential`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/verify_credential`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `credential` | object | yes | The credential JSON, with its Data Integrity proof. |

## `foxxi.consume_lesson`

**Consume a lesson + emit consumption descriptor**

Stream-load a Foxxi-parsed lesson's structural stratum (slides, audio, transcripts) for consumption, and emit an fxa:ConsumptionEvent descriptor + an xAPI Statement (via the lrs-adapter) for each slide the learner advances past. Composes with the iep:TemporalFacet so consumption is timeboxed; composes with iep:TrustFacet so partial completion is recorded as Hypothetical, full as Asserted.

- Action: `urn:iep:action:foxxi:consume-lesson`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/consume_lesson`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course_iri` | string | yes | IRI of the course (federation_iri_base/course_id). |
| `learner_did` | string | yes | Consuming learner DID. |
| `lrs_endpoint` | string | no | Optional xAPI LRS endpoint to forward Statements to (composes with the lrs-adapter projector). If omitted, Statements are emitted as descriptors only. |
| `lrs_auth_header` | string | no | Authorization header for the LRS when provided. |

## `foxxi.ask_course_question`

**Ask a question about a course**

Grounded Q&A over a course's narration transcripts + extracted concepts. The learner asks "what is handicap?" and the substrate returns verbatim-cited transcript segments + concept snippets that overlap the question. Composes the existing learner-performer-companion grounded-answer machinery (same honesty discipline: tamper-detected atoms, IRI citations, honest null when no atom overlaps the question). Lexical retrieval only — use foxxi.ask_course_question_agentic for graph-aware retrieval + LLM synthesis.

- Action: `urn:iep:action:foxxi:ask-course-question`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ask_course_question`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course_iri` | string | yes | IRI of the course (matches federation_iri_base#package emitted by ingest_content_package). |
| `learner_did` | string | yes | Asking learner DID. Recorded on the response descriptor for audit. |
| `question` | string | yes | Natural-language question (e.g., "what is handicap?"). |
| `course_content` | object | yes | The course's narration transcripts + extracted concepts. In a real deployment the bridge fetches this from the tenant pod via the published fxs/fxk descriptors; for the in-process invocation supply the shape from the parser's dashboard_data + transcripts payloads. |

## `foxxi.ask_course_question_agentic`

**Agentic RAG Q&A over a course federation (with LLM synthesis)**

Multi-step agentic retrieval + LLM synthesis: (1) federated concept-graph search across the primary course + any loaded federation peers, (2) prereq + modifier-of edge expansion within each concept's home course, (3) round-robin slide allocation so peer-course slides survive the citation cap, (4) LLM synthesis with the substrate-assembled structured context as the system prompt. Each step of the agent loop emits an Interego descriptor (fxa:LearnerQuestionEvent Asserted → fxa:RetrievalActivity Hypothetical → fxa:LlmCompletion Hypothetical → fxa:CitedAnswer Asserted with iep:supersedes back through the trace). LLM key precedence: per-request llm_api_key (BYOK from the caller) > server-side FOXXI_LLM_API_KEY / ANTHROPIC_API_KEY env. The trace records which key source was used (bridge-env vs per-request-byok). Without any key, returns retrieval scaffold + descriptor trace alone (use foxxi.retrieve_course_context for the explicit no-LLM path).

- Action: `urn:iep:action:foxxi:ask-course-question-agentic`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ask_course_question_agentic`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Asking learner DID. Recorded on the fxa:LearnerQuestionEvent descriptor. |
| `question` | string | yes | Natural-language question. |
| `primary` | object | yes | Primary course payload — matches the FoxxiAgenticPayload shape (packageMeta + concepts + slides + modifier_pairs + prereq_edges). In a real deployment the bridge fetches this via discover_context against the tenant pod's published fxk:ConceptMap + fxs:Slide descriptors. |
| `federation` | array | no | Optional array of federation peer course payloads — same shape as primary. Cross-course concept matching + slide citation works across the full federation. |
| `history` | array | no | Prior conversation turns (role/content) for multi-turn Q&A. |
| `llm_model` | string | no | Anthropic model id (default claude-sonnet-4-5). |
| `llm_api_key` | string | no | BYOK: per-request Anthropic API key. Used transiently for the one LLM call; bridge does not store/log. Takes precedence over the server-side FOXXI_LLM_API_KEY / ANTHROPIC_API_KEY env. Caller is responsible for transport security (TLS to the bridge). |

## `foxxi.retrieve_course_context`

**Retrieval-only path (MCP-client-as-LLM — your agent does synthesis)**

Pure retrieval, no LLM call. Designed for MCP clients where the AGENT itself (Claude.ai connector / Claude Desktop / Claude Code / Cursor / Codex) is the LLM and uses the user's existing subscription. Returns the same federated concept-graph retrieval scaffold (seed concepts + expanded neighborhood + cited slides with verbatim transcripts) as foxxi.ask_course_question_agentic, plus a 2-step Interego trace (fxa:LearnerQuestionEvent Asserted + fxa:RetrievalActivity Hypothetical). The calling agent synthesises the answer in its own context using the cited transcripts as grounding, and optionally closes the trace by publishing its own fxa:CitedAnswer descriptor back to the tenant pod. NO API key required anywhere — user's subscription pays via the MCP client.

- Action: `urn:iep:action:foxxi:retrieve-course-context`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/retrieve_course_context`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `learner_did` | string | yes | Asking learner DID. |
| `question` | string | yes | Natural-language question. |
| `primary` | object | yes | Primary course payload (FoxxiAgenticPayload). |
| `federation` | array | no | Optional federation peer payloads. |

## `foxxi.explore_concept_map`

**Explore the published concept map for a course**

Fetch the concept graph a course PUBLISHED (concepts with tier + confidence, prerequisite edges, modifier-of relations) from its on-pod fxa:CoursePackageBundle, and return it as a navigation graph: pick any concept with focus_concept_id, follow prerequisite edges up AND down to max_depth, and read the slide ids that taught each one. Returns { error } — never an empty graph — when the course is not on the pod or focus_concept_id names no concept in it.

- Action: `urn:iep:action:foxxi:explore-concept-map`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/explore_concept_map`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course_iri` | string | yes | Course IRI. |
| `focus_concept_id` | string | no | Optional concept to center the navigation graph on; default returns the full graph. |
| `max_depth` | number | no | Optional depth limit for prerequisite-edge traversal from focus_concept_id (default 3). |

## `foxxi.extend_standards`

**Extend a standard (xAPI / IEEE-LER / ADL-TLA) — afforded by the agentic-performance layer**

Emergent, self-descriptive capability: an agent extends a standard IN THE FLOW OF WORK — a new xAPI context extension, an xAPI Profile fragment, or an IEEE-LER / ADL-TLA term — COMPOSING Foxxi's standards (built with Foxxi's own buildProfileDoc + served LER/TLA namespaces), never forking the spec. The agentic-performance (agp:) layer affords this; Foxxi surfaces it (the agp<->Foxxi re-integration). Returns a conformant artifact + a publishable, discoverable iep:StandardsExtension descriptor (distributed) + in-flow performance support (what it builds, how to learn it, how to teach it). Discover the learnable-capability catalog at GET /guidance.

- Action: `urn:iep:action:foxxi:extend-standards`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/extend-standards`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | one of `XapiContextExtension`, `XapiProfileFragment`, `LerTerm`, `TlaTerm` | yes | What to author. |
| `name` | string | yes | Local slug for the new term/extension (e.g. "collaborationDepth"). |
| `definition` | string | yes | Human-readable definition of the new term/extension. |
| `label` | string | no | Display label (defaults to name). |
| `extends_standard` | string | no | IRI of the standard being extended (defaults per kind). |
| `subclass_of` | string | no | For LerTerm/TlaTerm: the superclass IRI to compose onto. |
| `builds_capability` | string | no | IRI of the agp:Capability this extension builds/demonstrates. |

## `foxxi.review_record`

**Review your own performance record (ELR + CLR) as yourself**

Review your IEEE P2997 Enterprise Learner Record + 1EdTech CLR 2.0 credential wallet, virtualized by Foxxi entirely over your OWN pod. Authenticate with a rev-196 signed-request envelope — Foxxi verifies your own signature and binds identity to the recovered did:ethr (no relay, no separate login). Defaults to your own record. HOW A COMPETENCY IS EARNED, so an empty judgement is readable before you spend a signature: a performance record counts toward a competency only if it carries a DOMAIN activity type, or asserts an outcome (success true/false). A record whose only type is a protocol envelope — AssertedContext, ProductionTask, SignedAuthorship, any *Facet — declares no skill, and auto-projected trajectory steps carry exactly that and no outcome, so any number of them yields zero competencies by design rather than by fault. The other two routes are a mastery-verb learning experience, and an alignment on a verified credential. Competence is a judgement about work; volume of work is not one. WHO IS READABLE, which is a separate question from what counts: a subject is classified from its OWN signed statements, and a subject with none classifies HUMAN, whose record is private to its holder. That is why a brand-new agent cannot be read by anybody, and it is the correct answer rather than a fault — you are what you have done. ONE authenticated performance recorded as actor_kind agent is what flips it, and from that moment the record is a PUBLIC capability record any signed caller can read by naming your DID. Nothing you declare about yourself changes this: a self-declaration would let an agent assert its way into a public class without evidence, which is the opposite of every other rule here. CROSS-POD READS: pass subject_did to read another subject's discoverable agent-capability record — on every route, including through the relay. Two fields that used to be one: subject_pod_url answers WHOSE POD AM I (stamped from your session by sign_request, and never a read target), while the record you are asking for is resolved from subject_did and, when that subject has enrolled, from the pod the enrolment register says it actually writes to. If the subject holds a pod here that its identity does not resolve to, name it with read_pod_url — that carries no authority, only selects among pods this deployment already reads, and is refused with the reason if it names anything else. Every answer reports subject.podChosenBy so you can tell which pod was read and why. A HUMAN learner record stays private to its holder; agent capability records are public.

- Action: `urn:iep:action:foxxi:review-record`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/review-record` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id: 'did:ethr:<addr>', timestamp: <ISO 8601, within ±60s>, subject_did?, read_pod_url?, subject_pod_url?, subject_name?, actor_kind?, include_clr?, projection?: 'inline'\|'links' }). DEFAULT 'links' returns the JUDGEMENT (competencies, credentials, counts — bounded by vocabulary, not by history) with evidence as hydra:Collection references carrying hydra:totalItems and a self-scoped address you can dereference with this same envelope. Pass 'inline' to embed every experience and performance record instead — that grows without bound with the subject's history and has been measured over 1.2 MB. |
| `read_pod_url` | string | no | WHOSE RECORD AM I ASKING FOR, when the subject holds a pod that its identity does not resolve to (one wallet has both an eth-<hex> pod and a relay-mediated u-eth-<hex> one). Untrusted: it carries no authority, selects only among pods this deployment already reads, and a pod outside that space is REFUSED with the reason rather than silently swapped for a derived one. Usually unnecessary — an enrolled subject is found from subject_did alone, via the enrolment register. Distinct from subject_pod_url, which answers WHOSE POD AM I, is stamped from your session by sign_request, and is never a read target. |
| `_signature` | string | yes | secp256k1 signature over the canonical message sha256:<hex(sha256(_signed_payload))>, signed with the wallet matching agent_id. |

## `foxxi.issue_credential`

**Issue a competency credential as the authority for your vertical**

Issue an Open Badges 3.0 / W3C Verifiable Credential to an agent who demonstrated a competency you defined, as the AUTHORITY for your own vertical. The credential is signed by your stable, platform-custodied issuer identity (derived from your DID), aligned to your competency, and delivered to the recipient agent's OWN pod wallet (their CLR surfaces it). Gated by your verifiable delegation (no tenant admin). Externally routed: sign_request the issuance args, then POST the envelope.

- Action: `urn:iep:action:foxxi:issue-credential`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/issue-credential` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, recipient_did, recipient_pod_url?, recipient_name?, competency_name, competency_id?, competency_framework?, achievement_description?, criterion?, evidence?, justified_by? }). |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (relay sign_request). |

## `foxxi.verify_extension`

**Independently verify a subject extended a standard (issuer due diligence)**

Independently verify, from the SUBJECT's own authoritative pod records, that they (a) completed an engine-graded course and (b) recorded a domain-typed StandardsExtension performance, and that the named extension (c) conforms to the agp:StandardsExtension shape. Returns a verdict separating independently-verified evidence from any self-attested outcome — the issuer's due diligence before issue-credential. On success it composes a dereferenceable iep:Verification holon (chain of custody). Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:verify-extension`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/verify-extension` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, subject_did, name?, kind?, definition?, subject_pod_url? }). kind defaults to XapiContextExtension; name triggers the shape-conformance check. |
| `_signature` | string | yes | sign_request signature (secp256k1 over sha256 of _signed_payload). |

## `foxxi.prove_competency_signed`

**Prove a competency privately end-to-end (BBS+ selective disclosure)**

Holder-facing BBS+ proof, GROUNDED IN THE HOLDER'S ACTUAL RECORD: the bridge assembles the holder's learner record, refuses any competency that record does not assert ("you can only prove a demonstrated competency, not a claimed one"), and derives the proficiency from the published Dreyfus rollup rather than from the request. It then signs a multi-claim credential, discloses only a minimal privacy-preserving subset (issuer + achievement name + proficiency by default), and cryptographically HIDES the rest (score, dates, name, id); a verifier learns ONLY the disclosed claims. Real W3C bbs-2023 crypto. Returns a serialized `presentation` an INDEPENDENT verifier can check via foxxi.verify_presentation. Externally routed: sign_request the args as the HOLDER, then POST the envelope.

- Action: `urn:iep:action:foxxi:prove-competency-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/foxxi/prove_competency` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, tenant_pod_url, competency_name, learner_did?, learner_name?, course_id?, reveal_paths?, presentation_context? }). reveal_paths is an array of claim paths to disclose (default ["issuer","achievement.name","achievement.proficiencyLevel"]); any path the credential does not carry is dropped and reported back in unknownRevealPaths. presentation_context binds the proof to one occasion — a verifier MUST echo it back or the proof will not verify. NOTE: score and proficiency are NOT inputs; both are derived from the holder's record. |
| `_signature` | string | yes | sign_request signature by the holder (subject of the credential). |

## `foxxi.self_assert_competency`

**Self-assert a competency with selective disclosure (SelfAsserted — not an authority attestation)**

Mint a BBS+ credential about YOURSELF and derive a selective-disclosure presentation from it. The issuer is always the authenticated signer: this route will not issue under another party's identity, and it does not read score or proficiency from the request, so the claim carries the floor of the scale (Novice). What a verifying proof establishes here is INTEGRITY — the holder said this and cannot have altered it since — and not merit. Results carry selfIssued, trustLevel=SelfAsserted and claimsGroundedInRecord=false so a relying party can weigh them without knowing this route. For a proof grounded in a real learning record, and a proficiency derived from the published rollup, use foxxi.prove_competency instead. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:self-assert-competency`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/prove-competency` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, competency_name, reveal? }). reveal is an array of claim paths to disclose (default ["issuer","achievement.name","achievement.proficiencyLevel"]). issuer_did, score and proficiency are NOT accepted — naming an issuer other than the signer returns 403. |
| `_signature` | string | yes | sign_request signature. The recovered signer is both the holder AND the issuer. |

## `foxxi.verify_presentation`

**Verify a selective-disclosure BBS+ presentation**

Verifier-side. Takes a presentation produced by foxxi.prove_competency; returns whether the issuer signed a credential containing exactly the disclosed claims at the disclosed positions. The verifier learns ONLY the revealed claims. Externally routed: sign_request the args (as any independent verifier), then POST the envelope.

- Action: `urn:iep:action:foxxi:verify-presentation`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/verify-presentation` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, presentation: { proof, disclosedIndexes, disclosedMessages, issuerPublicKey, issuerDid } }) — the presentation from foxxi.prove_competency. |
| `_signature` | string | yes | sign_request signature by the verifier. |

## `foxxi.void_credential`

**Void (remove) a credential from your own wallet**

Remove a credential you hold from your OWN pod wallet by its descriptor URL (the sourceDescriptor of a CLR entry returned by review-record). Deletes the credential resource + its graph AND rebuilds your pod manifest from actual contents, so no stale entry/ghost remains. You can only void credentials under your own pod. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:void-credential`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/void-credential` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, descriptor_url, subject_pod_url? }) — descriptor_url = a CLR entry sourceDescriptor under your own pod. |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id. |

## `foxxi.publish_encryption_key`

**Publish your X25519 encryption public key (self-sovereign)**

Publish YOUR X25519 public key to your OWN pod so the bridge encrypts your canonical PGSL holons TO YOU (not just to itself) — making your recorded performances/credentials owner-readable. You generate + hold the private key; only the public key is published (to <yourpod>/keys/encryption.json). Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:publish-encryption-key`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/publish-encryption-key` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, public_key, subject_pod_url? }) — public_key is your base64 X25519 (Curve25519) public key (algorithm X25519-XSalsa20-Poly1305). |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id. |

## `foxxi.course_analyze`

**Analyze a SCORM package: fingerprint the authoring tool + build a course KG**

Fingerprint WHICH authoring tool produced a SCORM package (from its imsmanifest.xml + file list/contents), build the concept/slide knowledge-graph, and compose it into a per-course PGSL lattice holon (dereferenceable + interrogable). Open + rate-limited per IP (it composes a holon on success). Externally routed (rate-limited open access, no signature).

- Action: `urn:iep:action:foxxi:course-analyze`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/course/analyze` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `manifestXml` | string | yes | imsmanifest.xml text (must contain <manifest...; max 2MB). |
| `fileList` | array | no | Optional list of file paths in the package (capped at 5000) — strengthens fingerprinting. |
| `fileText` | object | no | Optional map of filename → extracted text (capped) for concept extraction. |
| `fileContents` | object | no | Optional map of filename → raw content (capped) for fingerprint signals. |

## `foxxi.course_analyze_authored`

**Analyze an agent-authored course (cryptographic provenance fingerprint)**

Analyze a course an agent authored via /agent/scorm/author. Because the structured course + signed authoredBy provenance is known, the "fingerprint" reports that ground truth (a Foxxi agent authored it) rather than sniffing a third-party tool. Resolves the course from the in-memory cache → the author's PGSL lattice → legacy pod RDF. Same response shape as foxxi.course_analyze. Externally routed (rate-limited open access).

- Action: `urn:iep:action:foxxi:course-analyze-authored`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/course/analyze-authored` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `courseId` | string | yes | The agent-authored course id (from /agent/scorm/author). |
| `author_did` | string | no | Author DID — used to resolve the course from the author's pod/lattice when not cached. |
| `course_pod` | string | no | Explicit author pod URL (defaults to the author_did's resolved pod). |

## `foxxi.course_ask`

**Ask a role-framed, grounded question about an analyzed course**

Grounded Q&A over a FoxxiAgenticCourse (from /agent/course/analyze*). A role (author / performance-manager / assessor / meta / learner) sets the lens; the answer stays grounded in the course knowledge-graph. Without llm_api_key it returns the retrieval scaffold (rate-limited; the caller's own LLM synthesises); with a BYOK key it runs agentic RAG synthesis. honest `grounded` flag (true only on a real graph hit). Externally routed (rate-limited; BYOK exempt).

- Action: `urn:iep:action:foxxi:course-ask`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/course/ask` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course` | object | yes | The FoxxiAgenticCourse (must have concepts[] + slides[]) from /agent/course/analyze*. |
| `question` | string | yes | Natural-language question. |
| `role` | string | no | Lens for the answer: author \| performance-manager \| assessor \| meta \| learner. |
| `learnerActivity` | string | no | Optional fenced learner-activity text the role can reference (treated as untrusted data). |
| `llm_api_key` | string | no | BYOK Anthropic key — when present, runs LLM synthesis (rate-limit exempt); when absent, returns the retrieval scaffold for the caller's own LLM. |
| `history` | array | no | Prior conversation turns for multi-turn Q&A. |
| `learnerDid` | string | no | Asking learner DID (recorded; defaults to urn:foxxi:demo:asker). |

## `foxxi.course_skill`

**Project a course to a SKILL.md an agent can load**

Pure projection: turn a FoxxiAgenticCourse (from /agent/course/analyze*) into a SKILL.md document an agent can load — carrying the course provenance (tool, authoredBy, holonUri, courseId). No pod write, no signing. The inverse of /agent/course/analyze-skill. Externally routed.

- Action: `urn:iep:action:foxxi:course-skill`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/course/skill` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course` | object | yes | The FoxxiAgenticCourse (must have concepts[] + slides[]). |
| `tool` | string | no | Provenance: authoring tool name to record in the skill. |
| `authoredBy` | string | no | Provenance: author DID. |
| `holonUri` | string | no | Provenance: the course holon URI. |

## `foxxi.course_analyze_skill`

**Ingest a SKILL.md as a course knowledge-graph**

Ingest an agent skill (SKILL.md string) as a course: parse it, report the agent-skill provenance fingerprint (ground truth — a skills.md, not a SCORM tool), and compose it into a PGSL course-KG holon so it can be interrogated, chatted with, assessed, and credentialed like any course. The inverse of /agent/course/skill. Externally routed (rate-limited open access).

- Action: `urn:iep:action:foxxi:course-analyze-skill`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/course/analyze-skill` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `skillMd` | string | yes | A SKILL.md string (frontmatter + body or ## sections; max 2MB). |

## `foxxi.skill_affordance`

**Translate a SKILL.md to a typed iep:Affordance descriptor graph (round-trip)**

The STRICT SKILL.md ⇄ iep:Affordance translator (core @interego/skills bridge): translate a SKILL.md into a real iep:Affordance ContextDescriptor graph (subject typed iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution) and round-trip it back to a SKILL.md to demonstrate the lossless markdown-carrier ⇄ typed-affordance translation. Pure translation: no pod write, no signing — the authoring DID rides in PROV provenance only. Externally routed.

- Action: `urn:iep:action:foxxi:skill-affordance`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/skill/affordance` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `skillMd` | string | yes | A SKILL.md string to translate (max 2MB). |
| `agentDid` | string | no | Authoring DID recorded in PROV provenance (must start with did:; defaults to the zero address). |

## `foxxi.course_propose_successor`

**A course proposes its own successor (regime-engine-routed, iep:supersedes)**

The Living Curriculum: a course reasons about ITSELF concept by concept. Each concept routes a performance signal through the work-regime engine, which REFUSES the universal content-gap frame (only the Knowable regime runs a gap analysis; a performer who could perform under ideal conditions yields an environment/incentive cause, not a content gap). It composes a real iep:supersedes SUCCESSOR holon into the PGSL lattice — a versioned, dereferenceable revision. Externally routed (rate-limited open access).

- Action: `urn:iep:action:foxxi:course-propose-successor`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/course/propose-successor` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `course` | object | yes | { courseId, title, concepts:[{id,label}] } (from /agent/course/analyze*). |
| `concept_signals` | array | no | Per-concept signals: array of { id?, label?, completion?, fieldSuccess?, frequency?, criticality? }. No signal for a concept → the engine refuses to claim a regime (instrument-first). |
| `holonUri` | string | no | The original course holon URI — shared as a term so the successor links to it (iep:supersedes). |
| `label` | string | no | Optional label for the successor holon (sanitized; defaults to successor-<courseId>). |

## `foxxi.calibration_merge`

**Merge signed calibration contributions into a federated memory (k-anon)**

Federated calibration: pool SIGNED (regime × cause × intervention → verdict) aggregate tallies from multiple orgs WITHOUT sharing a single raw record. The bridge recovers each contributor from its signature (authenticated, not asserted; same-key resubmissions collapse to one source), applies the k-anonymity suppression floor, then pools them — a cell Hypothetical for each org alone becomes Asserted once pooled across ≥2 distinct keys. The merged memory is composed into the PGSL lattice as a dereferenceable holon no single key could assert alone. Externally routed (rate-limited; each contribution carries its own signature).

- Action: `urn:iep:action:foxxi:calibration-merge`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/calibration/merge` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `contributions` | array | yes | Array (1..64) of signed envelopes { _signature, _signed_payload: JSON.stringify({ agent_id, timestamp, specs:[{ regime, causeFactor, intervention, closed, improved, noChange, worsened }] }) }. |
| `k` | number | no | Federation k-anonymity threshold floor (server enforces a minimum of 8; callers may raise but not lower it). |
| `assertThreshold` | number | no | Sample count above which a pooled cell becomes Asserted (server minimum 12; raise-only). |

## `foxxi.record_performance_signed`

**Record a production-work performance event as yourself**

Record one unit of on-the-job production work as an xAPI performed statement, into your OWN Foxxi lens, authenticated by your delegation (the agent-drivable counterpart of the session-token foxxi.record_performance). Declare an activity_type (a domain type you define, e.g. urn:ttt:Move) to aggregate same-type executions into one competency; else it keys off task_name. success=true on demonstrated work promotes the competency to performance-verified. Composed into your shared PGSL lattice (optionally wrapped to named recipients for cross-seat owner-decrypt). Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:record-performance-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/record-performance` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, task_name, success, activity_type?, task_id?, quality?, duration_iso?, actor_kind?, cost_usd?, recipients? }). recipients?: pod URLs/DIDs to ALSO wrap the encrypted holon to (cross-seat owner-decrypt). |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (relay sign_request). |

## `foxxi.ingest_course`

**Author + publish a course to your own pod (as yourself)**

Author a Foxxi course (cmi5/SCORM-shaped: modules → lessons → fragments; assessment-item fragments are scored) and PUBLISH it to your OWN pod, authenticated by your delegation (the agent-drivable counterpart of foxxi.ingest_content_package). Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:ingest-course-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/ingest-course` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, parsed: <ParsedFoxxiPackage = { courseId, title, modules:[{id,title,lessons:[{id,title,competency,fragments:[{modality,body,level}]}]}] }>, subject_pod_url? }). |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (sign_request). |

## `foxxi.record_course_completion`

**Record a cmi5 course completion as yourself**

Record completing + passing a course as cmi5 xAPI (launched/initialized/completed/passed/terminated) into your OWN lens, authenticated by your delegation (the agent-drivable counterpart of foxxi.emit_cmi5_session). A passed completion (score_scaled ≥ mastery_score) lands mastery-verb experiences → an inferred competency in your ELR, which a later record-performance can supersede to performance-verified. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:record-course-completion-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/record-course-completion` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, course_id, course_title?, score_scaled, mastery_score?, duration_iso?, registration?, subject_pod_url? }). score_scaled must be ≥ mastery_score (default 0.7). |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (sign_request). |

## `foxxi.forwarding_targets`

**Manage your own downstream xAPI forwarding targets**

Set / list / remove the downstream LRS endpoints YOUR OWN xAPI statements are forwarded to (per-user Statement Forwarding). Owner = your verified delegation; targets are scoped to your own lens, so only your statements forward to them, never another user's. Omit both targets + delete to just list (downstream secrets are never echoed). Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:set-forwarding-targets-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/forwarding/targets` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, targets?: [{ endpoint, credentials, label?, version?, enabled? }], delete?: string[] }). targets are added/updated (credentials = downstream LRS "user:pass"); delete removes by id. |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (relay sign_request). |

## `foxxi.write_xapi_statements_signed`

**Record your own xAPI activity and preserve its native evidence**

Signed transport over the standard xAPI Statements Resource, scoped to your own lens. Accepts 1–20 JSON Activity statements (128 KiB maximum), each with a UUID id, observed timestamp and actor.account.name equal to your authenticated DID. Uses the existing LRS validation, immutability and forwarding; reads back its exact enriched envelopes and awaits encrypted PGSL persistence. No attachment, SubStatement or voiding transport on this adapter. Retry identical ids/content after uncertainty; never manufacture replacement events. Does not infer competency from mere reads: choose the accurate xAPI verb/result.

- Action: `urn:iep:action:foxxi:write-xapi-statements-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/xapi-statements/write` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | sign_request({ statements:[{id, actor, verb, object, timestamp, result?, context?}] }). The relay supplies agent_id and the fresh authentication timestamp. Statement timestamps describe when the observed activities happened. |
| `_signature` | string | yes | The complete signature returned by sign_request. |

## `foxxi.read_xapi_statements_signed`

**Read your actual xAPI LRS statements**

Signed transport to GET /xapi/statements in your own lens. Returns the actual LRS response, without merging a pod snapshot or learner-record summary. query accepts standard statementId, verb, activity, registration, since, until, ascending, limit (1–200; default 100), and the LRS cursor. Follow the returned more cursor through this same signed affordance. No operator role or caller-managed Basic secret required. LRS memory/restart limits remain as reported by discover-lrs; the write affordance separately preserves an encrypted native copy.

- Action: `urn:iep:action:foxxi:read-xapi-statements-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/xapi-statements/read` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | sign_request({query?:{statementId?,verb?,activity?,registration?,since?,until?,ascending?,limit?,cursor?}}); identity/pod are bound by the signature. |
| `_signature` | string | yes | The complete signature returned by sign_request. |

## `foxxi.credentials`

**Manage your own inbound forwarding credentials**

Mint / list / revoke the Basic-auth credentials an upstream system uses to forward xAPI statements INTO your OWN lens. Owner = your verified delegation; credentials are scoped to your lens, so forwarded-in statements land in your record. Secrets are never echoed back. Omit both credentials + revoke to just list. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:set-inbound-credentials-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/credentials` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, credentials?: [{ principal, secret, label? }], revoke?: string[] }). credentials are added (the "user:pass" an upstream presents on /xapi/statements); revoke removes by id. |
| `_signature` | string | yes | secp256k1 over sha256:<hex(sha256(_signed_payload))> by the wallet matching agent_id (relay sign_request). |

## `foxxi.publish_memory`

**Publish a job aid / quick reference as a dereferenceable memory**

Author a job aid or quick reference as yourself. It composes into a PUBLIC shared PGSL lattice at triple granularity, so the memory and its points become dereferenceable URL atoms that RESOLVE (via the relay id authority) to their description — a term, not a word. This is the shared-memory intervention: a job aid lives in the same fabric the resolver serves, unlike an ephemeral vault ingest. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:publish-memory-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/publish-memory` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, title, body, kind?:"job-aid"\|"quick-reference" }). body is Markdown. |
| `_signature` | string | yes | sign_request signature (secp256k1 over sha256 of _signed_payload). |

## `foxxi.scorm_author`

**Author a real conformant SCORM 2004 course as yourself**

Author a SCORM 2004 course as yourself. Foxxi generates a CONFORMANT imsmanifest.xml and validates it parses on the real SCORM SN runtime, then composes the full course losslessly into your shared PGSL lattice (launchable cross-restart + cross-agent). Assessment answers are hashed at author time (plaintext never touches the pod). Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:scorm-author-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/scorm/author` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, course: { courseId, title, masteryScore?, scos:[{ id, title, body, assessment?:[{question,answer}] }] }, subject_pod_url? }). |
| `_signature` | string | yes | sign_request signature (secp256k1 over sha256 of _signed_payload). |

## `foxxi.scorm_launch`

**Launch a SCORM course (start an attempt on the SN engine)**

Launch an authored SCORM course as yourself. The SCORM 2004 SN runtime parses the manifest, starts an attempt, and delivers the first SCO (its content +, for an assessment SCO, the questions). The course is resolved from the in-memory catalog, else loaded from the author pod (author_did/course_pod; defaults to your own pod for a self-authored course), so it survives restarts and is launchable cross-agent. Then POST /agent/scorm/submit per SCO. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:scorm-launch-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/scorm/launch` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, course_id, author_did?, course_pod?, subject_pod_url? }). |
| `_signature` | string | yes | sign_request signature (secp256k1 over sha256 of _signed_payload). |

## `foxxi.scorm_submit`

**Submit the current SCO + advance (graded, committed to the SN engine)**

Submit the current SCO. For an assessment SCO pass { answers:[...] } — the player GRADES them against the package answer hashes (not self-reported), commitTracking()s cmi.completion/success/score into the SN engine, and advances (Continue). When the engine sequences to the end, its ROLLUP decides pass/complete and the outcome is recorded to your ELR. Externally routed: sign_request the args, then POST the envelope.

- Action: `urn:iep:action:foxxi:scorm-submit-signed`
- HTTP: `POST https://foxxi-bridge.interego.xwisee.com/agent/scorm/submit` (served by a bespoke route; not through the bridge's MCP endpoint)
- Media type: `application/json`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `_signed_payload` | string | yes | JSON.stringify({ agent_id, timestamp, session_id, answers? }). answers is the ordered array for an assessment SCO. |
| `_signature` | string | yes | sign_request signature (secp256k1 over sha256 of _signed_payload). |

