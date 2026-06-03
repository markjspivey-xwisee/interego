/**
 * Affordance declarations for the foxxi-content-intelligence vertical.
 *
 * Two audience arrays — dual-audience discipline per
 * docs/DUAL-AUDIENCE.md. Both arrays are concatenated by the bridge
 * at startup; the FOXXI_AUDIENCE env var (see bridge/server.ts)
 * selects which subset the runtime exposes for split deployments
 * (see docs/DEPLOYMENT-SPLIT.md).
 *
 * Action IRIs use the urn:cg:action:foxxi:<verb> convention. Targets
 * use {base} as a placeholder for the bridge's deployment URL,
 * substituted at affordance-publication time.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '../../src/index.js';

// ─────────────────────────────────────────────────────────────────────
//  Learner-side affordances
// ─────────────────────────────────────────────────────────────────────

export const foxxiAffordances: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:foxxi:discover-assigned-courses' as IRI,
    toolName: 'foxxi.discover_assigned_courses',
    title: 'Discover assigned courses',
    description: 'Walk the L&D admin\'s policy descriptors + the learner\'s audience-tag membership, returning the courses currently assigned to this learner (required + suggested) with due-by dates derived from policy triggers.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/discover_assigned_courses',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner DID (web_id pattern from the tenant identity service).' },
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Pod URL of the L&D tenant where policy descriptors live.' },
      { name: 'audience_tags', type: 'array', required: false, description: 'Optional caller-supplied audience tags to override the learner\'s default audience membership (e.g., temporary access).' },
    ],
    // Learner-facing: meaningful on a learner profile resource.
    appliesTo: { collections: ['profiles'] },
    outputs: {
      description: 'Discovered assignment list for the learner — required + suggested courses with due-by dates derived from policy triggers — plus an ABAC accessDecision trace. Returns { error, accessDecision } when the caller is not authorised to query this learner.',
      properties: {
        learnerWebId: { type: 'string', description: 'Echo of the queried learner DID/WebID.' },
        assignments: { type: 'array', description: 'Per-course assignment entries (courseIri, courseTitle, requirementType (required|recommended), trigger, dueAt, sourcePolicyIri).', items: { type: 'object', additionalProperties: true } },
        audienceTagsUsed: { type: 'array', description: 'Audience tags actually used to compute the membership (caller override OR resolved from the learner record).', items: { type: 'string' } },
        accessDecision: { type: 'object', description: 'ABAC trace: caller role + applied policies + allow/deny.', additionalProperties: true },
        error: { type: 'string', description: 'Set when the caller cannot query this learner (forbidden); accessDecision carries the deny trace.' },
      },
    },
  },

  {
    action: 'urn:cg:action:foxxi:consume-lesson' as IRI,
    toolName: 'foxxi.consume_lesson',
    title: 'Consume a lesson + emit consumption descriptor',
    description: 'Stream-load a Foxxi-parsed lesson\'s structural stratum (slides, audio, transcripts) for consumption, and emit an fxa:ConsumptionEvent descriptor + an xAPI Statement (via the lrs-adapter) for each slide the learner advances past. Composes with the cg:TemporalFacet so consumption is timeboxed; composes with cg:TrustFacet so partial completion is recorded as Hypothetical, full as Asserted.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/consume_lesson',
    inputs: [
      { name: 'course_iri', type: 'string', required: true, description: 'IRI of the course (federation_iri_base/course_id).' },
      { name: 'learner_did', type: 'string', required: true, description: 'Consuming learner DID.' },
      { name: 'lrs_endpoint', type: 'string', required: false, description: 'Optional xAPI LRS endpoint to forward Statements to (composes with the lrs-adapter projector). If omitted, Statements are emitted as descriptors only.' },
      { name: 'lrs_auth_header', type: 'string', required: false, description: 'Authorization header for the LRS when provided.' },
    ],
    // Acts on a specific course; also surfaced on the learner profile.
    appliesTo: { collections: ['courses', 'profiles'] },
    outputs: {
      description: 'Lesson-consumption outcome — { consumed, descriptors emitted for each slide advanced, xAPI statementIds (when lrs_endpoint was supplied), modalStatus = Hypothetical when partial / Asserted on full completion }. Current bridge build returns a stub note flag until the streaming consumption handler is wired.',
    },
  },

  {
    action: 'urn:cg:action:foxxi:ask-course-question' as IRI,
    toolName: 'foxxi.ask_course_question',
    title: 'Ask a question about a course',
    description: 'Grounded Q&A over a course\'s narration transcripts + extracted concepts. The learner asks "what is handicap?" and the substrate returns verbatim-cited transcript segments + concept snippets that overlap the question. Composes the existing learner-performer-companion grounded-answer machinery (same honesty discipline: tamper-detected atoms, IRI citations, honest null when no atom overlaps the question). Lexical retrieval only — use foxxi.ask_course_question_agentic for graph-aware retrieval + LLM synthesis.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/ask_course_question',
    inputs: [
      { name: 'course_iri', type: 'string', required: true, description: 'IRI of the course (matches federation_iri_base#package emitted by ingest_content_package).' },
      { name: 'learner_did', type: 'string', required: true, description: 'Asking learner DID. Recorded on the response descriptor for audit.' },
      { name: 'question', type: 'string', required: true, description: 'Natural-language question (e.g., "what is handicap?").' },
      { name: 'course_content', type: 'object', required: true, description: 'The course\'s narration transcripts + extracted concepts. In a real deployment the bridge fetches this from the tenant pod via the published fxs/fxk descriptors; for the in-process invocation supply the shape from the parser\'s dashboard_data + transcripts payloads.' },
    ],
    appliesTo: { collections: ['courses'] },
    outputs: {
      description: 'Grounded course-Q&A result — verbatim transcript citations + concept-card snippets that overlap the question. Honest null when nothing in the course grounds the question. Also persists an lpc:CitedResponse-shape audit descriptor.',
      properties: {
        question: { type: 'string', description: 'Echo of the asked question.' },
        citations: { type: 'array', description: 'Per-citation entries: { slideId, slideTitle?, verbatimQuote, transcriptOffsetMs?, conceptIds }.', items: { type: 'object', additionalProperties: true } },
        conceptCards: { type: 'array', description: 'Concept-card snippets that overlap the question (id, label, definition).', items: { type: 'object', additionalProperties: true } },
        displayText: { type: 'string', description: 'Composed display text wrapping the citations — never paraphrases the cited atoms.' },
        nullReason: { type: 'string', description: 'When no atom in the course overlaps the question, set to a human-readable reason ("no-data").' },
      },
    },
  },

  {
    action: 'urn:cg:action:foxxi:ask-course-question-agentic' as IRI,
    toolName: 'foxxi.ask_course_question_agentic',
    title: 'Agentic RAG Q&A over a course federation (with LLM synthesis)',
    description: 'Multi-step agentic retrieval + LLM synthesis: (1) federated concept-graph search across the primary course + any loaded federation peers, (2) prereq + modifier-of edge expansion within each concept\'s home course, (3) round-robin slide allocation so peer-course slides survive the citation cap, (4) LLM synthesis with the substrate-assembled structured context as the system prompt. Each step of the agent loop emits an Interego descriptor (fxa:LearnerQuestionEvent Asserted → fxa:RetrievalActivity Hypothetical → fxa:LlmCompletion Hypothetical → fxa:CitedAnswer Asserted with cg:supersedes back through the trace). LLM key precedence: per-request llm_api_key (BYOK from the caller) > server-side FOXXI_LLM_API_KEY / ANTHROPIC_API_KEY env. The trace records which key source was used (bridge-env vs per-request-byok). Without any key, returns retrieval scaffold + descriptor trace alone (use foxxi.retrieve_course_context for the explicit no-LLM path).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/ask_course_question_agentic',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Asking learner DID. Recorded on the fxa:LearnerQuestionEvent descriptor.' },
      { name: 'question', type: 'string', required: true, description: 'Natural-language question.' },
      { name: 'primary', type: 'object', required: true, description: 'Primary course payload — matches the FoxxiAgenticPayload shape (packageMeta + concepts + slides + modifier_pairs + prereq_edges). In a real deployment the bridge fetches this via discover_context against the tenant pod\'s published fxk:ConceptMap + fxs:Slide descriptors.' },
      { name: 'federation', type: 'array', required: false, description: 'Optional array of federation peer course payloads — same shape as primary. Cross-course concept matching + slide citation works across the full federation.' },
      { name: 'history', type: 'array', required: false, description: 'Prior conversation turns (role/content) for multi-turn Q&A.' },
      { name: 'llm_model', type: 'string', required: false, description: 'Anthropic model id (default claude-sonnet-4-5).' },
      { name: 'llm_api_key', type: 'string', required: false, description: 'BYOK: per-request Anthropic API key. Used transiently for the one LLM call; bridge does not store/log. Takes precedence over the server-side FOXXI_LLM_API_KEY / ANTHROPIC_API_KEY env. Caller is responsible for transport security (TLS to the bridge).' },
    ],
    appliesTo: { collections: ['courses'] },
    outputs: {
      description: 'Agentic-RAG result: federated retrieval scaffold + LLM-synthesised answer + full descriptor trace (fxa:LearnerQuestionEvent Asserted → fxa:RetrievalActivity Hypothetical → fxa:LlmCompletion Hypothetical → fxa:CitedAnswer Asserted, with cg:supersedes chains). When no LLM key is configured, returns the retrieval scaffold + trace only (use foxxi.retrieve_course_context for the explicit no-LLM path). Surfaces a rate-limit error when bridge-env key is used and per-IP rate cap is hit.',
      properties: {
        answer: { type: 'string', description: 'LLM-synthesised answer composed over the structured retrieval context. Omitted when no LLM key was available.' },
        citations: { type: 'array', description: 'Cited slide entries with verbatim transcript snippets, allocated round-robin across primary + federation peers.', items: { type: 'object', additionalProperties: true } },
        seedConcepts: { type: 'array', description: 'Concept-graph seeds chosen by the agentic retrieval step (primary + cross-course matches).', items: { type: 'object', additionalProperties: true } },
        expandedConcepts: { type: 'array', description: 'Concepts reached via prereq + modifier-of edge expansion from the seeds.', items: { type: 'object', additionalProperties: true } },
        trace: { type: 'array', description: 'Ordered Interego descriptor trace; one entry per agent step (event type + descriptor IRI + modal status + cg:supersedes).', items: { type: 'object', additionalProperties: true } },
        llmKeySource: { type: 'string', enum: ['per-request-byok', 'bridge-env'], description: 'Which LLM-key source was used (BYOK takes precedence over the bridge env key).' },
        llmModel: { type: 'string', description: 'Anthropic model id actually invoked.' },
        error: { type: 'string', description: 'Set on rate-limit or auth failure.' },
        retryAfterSeconds: { type: 'integer', description: 'Set when error is a rate-limit refusal.' },
      },
    },
  },

  {
    action: 'urn:cg:action:foxxi:retrieve-course-context' as IRI,
    toolName: 'foxxi.retrieve_course_context',
    title: 'Retrieval-only path (MCP-client-as-LLM — your agent does synthesis)',
    description: 'Pure retrieval, no LLM call. Designed for MCP clients where the AGENT itself (Claude.ai connector / Claude Desktop / Claude Code / Cursor / Codex) is the LLM and uses the user\'s existing subscription. Returns the same federated concept-graph retrieval scaffold (seed concepts + expanded neighborhood + cited slides with verbatim transcripts) as foxxi.ask_course_question_agentic, plus a 2-step Interego trace (fxa:LearnerQuestionEvent Asserted + fxa:RetrievalActivity Hypothetical). The calling agent synthesises the answer in its own context using the cited transcripts as grounding, and optionally closes the trace by publishing its own fxa:CitedAnswer descriptor back to the tenant pod. NO API key required anywhere — user\'s subscription pays via the MCP client.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/retrieve_course_context',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Asking learner DID.' },
      { name: 'question', type: 'string', required: true, description: 'Natural-language question.' },
      { name: 'primary', type: 'object', required: true, description: 'Primary course payload (FoxxiAgenticPayload).' },
      { name: 'federation', type: 'array', required: false, description: 'Optional federation peer payloads.' },
    ],
    appliesTo: { collections: ['courses'] },
    outputs: {
      description: 'Retrieval-only Q&A scaffold for MCP-client-as-LLM: seed concepts + expanded neighborhood + cited slides with verbatim transcripts + a 2-step Interego trace (fxa:LearnerQuestionEvent Asserted + fxa:RetrievalActivity Hypothetical). The calling agent synthesises the answer in its OWN context using the scaffold as grounding. No API key required — the user\'s MCP-client subscription pays for synthesis.',
      properties: {
        seedConcepts: { type: 'array', description: 'Concept-graph seeds matched against the question.', items: { type: 'object', additionalProperties: true } },
        expandedConcepts: { type: 'array', description: 'Concepts reached via prereq + modifier-of expansion.', items: { type: 'object', additionalProperties: true } },
        citations: { type: 'array', description: 'Cited slide entries with verbatim transcripts the calling agent can ground on.', items: { type: 'object', additionalProperties: true } },
        trace: { type: 'array', description: 'Two-step Interego descriptor trace (question event + retrieval activity).', items: { type: 'object', additionalProperties: true } },
      },
    },
  },

  {
    action: 'urn:cg:action:foxxi:explore-concept-map' as IRI,
    toolName: 'foxxi.explore_concept_map',
    title: 'Explore the published concept map for a course',
    description: 'Fetch the fxk: knowledge-stratum descriptors (concepts, prerequisite edges, modifier-of relations, Peircean Sign/Object/Interpretant tags) for a course. Returns a navigation graph: pick any concept, follow prerequisite edges up/down, see the slides that taught it.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/explore_concept_map',
    inputs: [
      { name: 'course_iri', type: 'string', required: true, description: 'Course IRI.' },
      { name: 'focus_concept_id', type: 'string', required: false, description: 'Optional concept to center the navigation graph on; default returns the full graph.' },
      { name: 'max_depth', type: 'number', required: false, description: 'Optional depth limit for prerequisite-edge traversal from focus_concept_id (default 3).' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────
//  L&D-administrator (institutional) affordances
// ─────────────────────────────────────────────────────────────────────

export const foxxiAdminAffordances: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:foxxi:ingest-content-package' as IRI,
    toolName: 'foxxi.ingest_content_package',
    title: '[admin] Ingest a SCORM/cmi5/xAPI content package',
    description: 'Unwrap a SCORM 1.2 / SCORM 2004 / cmi5 zip package, run the Foxxi storyline parser (deterministic structural rendering + Whisper-transcribed audio + concept extraction with morphology + prerequisite-edge inference), and emit three-stratum descriptors (fxs structural, fxk knowledge, fxa activity-schema) to the tenant pod. SHACL-validates against the Foxxi vocab; non-clean packages are flagged in the catalog with parse_status="violations".',
    method: 'POST',
    targetTemplate: '{base}/foxxi/ingest_content_package',
    inputs: [
      { name: 'zip_base64', type: 'string', required: true, description: 'Content package as base64-encoded zip.' },
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL where the parsed descriptors land.' },
      { name: 'authoritative_source', type: 'string', required: true, description: 'DID of the content publisher (e.g., did:web:acme-training.example).' },
      { name: 'course_id', type: 'string', required: false, description: 'Stable catalog course_id (default: derived from manifest identifier).' },
      { name: 'lms_source', type: 'string', required: false, description: 'Originating LMS connector ID (default: "Direct upload").' },
    ],
    outputs: {
      description: 'Result of parsing + publishing a SCORM/cmi5/xAPI content package. Emits three-stratum descriptors (fxs structural, fxk knowledge, fxa activity-schema) on the tenant pod and reports SHACL violations under parseStatus.',
      properties: {
        courseIri: { type: 'string', description: 'IRI of the new fxa:CoursePackageBundle.' },
        catalogIri: { type: 'string', description: 'IRI of the catalog entry updated for this course.' },
        parseStatus: { type: 'string', enum: ['clean', 'violations'], description: 'clean = SHACL-valid; violations = catalog flagged with shape violations.' },
        descriptorUrls: { type: 'object', description: 'Per-stratum descriptor URLs: { structural[], knowledge[], activity[] }.', additionalProperties: true },
        concepts: { type: 'integer', description: 'Number of concepts extracted.' },
        slides: { type: 'integer', description: 'Number of slides parsed.' },
        prereqEdges: { type: 'integer', description: 'Number of prerequisite edges inferred.' },
        violations: { type: 'array', description: 'SHACL violation entries (only when parseStatus=violations).', items: { type: 'object', additionalProperties: true } },
        note: { type: 'string', description: 'Stub note when the Python parser has not yet been run and parsed payload is absent.' },
      },
    },
  },

  {
    action: 'urn:cg:action:foxxi:publish-authoring-policy' as IRI,
    toolName: 'foxxi.publish_authoring_policy',
    title: '[admin] Publish an authoring-tool / standard policy',
    description: 'Declare which authoring tools (Articulate Storyline, Adobe Captivate, Camtasia, etc.) and which package standards (SCORM 1.2, SCORM 2004, cmi5, xAPI) are accepted into the catalog. Reuses the abac policy descriptor pattern; ingestion rejects packages outside the accepted set.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/publish_authoring_policy',
    inputs: [
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL.' },
      { name: 'accepted_tools', type: 'array', required: true, description: 'Array of accepted authoring tool labels.' },
      { name: 'accepted_standards', type: 'array', required: true, description: 'Array of accepted package standard labels.' },
      { name: 'effective_from', type: 'string', required: false, description: 'ISO 8601 timestamp the policy becomes effective; default: now.' },
    ],
    // Admin governance over the policy + catalog surfaces.
    appliesTo: { collections: ['policies', 'courses'] },
  },

  {
    action: 'urn:cg:action:foxxi:connect-lms' as IRI,
    toolName: 'foxxi.connect_lms',
    title: '[admin] Register an external LMS connector',
    description: 'Register an external LMS (Cornerstone OnDemand, Workday Learning, SAP SuccessFactors, etc.) as a content source. Composes with src/connectors/ — uses the existing OAuth 2.0 / Basic-auth / SCORM-Cloud-API flows where supported. The connector\'s sync schedule is recorded as a foxxi:LmsConnection descriptor on the tenant pod with the connector\'s auth_warning surfaced if the credentials need rotation.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/connect_lms',
    inputs: [
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL.' },
      { name: 'connector_id', type: 'string', required: true, description: 'Stable connector ID (e.g., "cornerstone-prod").' },
      { name: 'product', type: 'string', required: true, description: 'LMS product name (e.g., "Cornerstone OnDemand").' },
      { name: 'instance', type: 'string', required: true, description: 'LMS instance URL or domain (e.g., "acme-training.csod.com").' },
      { name: 'auth_method', type: 'string', required: true, description: 'Auth method (e.g., "OAuth 2.0 (corporate)", "Basic+API key").' },
      { name: 'sync_frequency', type: 'string', required: false, description: 'Human-readable sync frequency (default: "every 6 hours").' },
    ],
    appliesTo: { collections: ['integrations'] },
  },

  {
    action: 'urn:cg:action:foxxi:assign-audience' as IRI,
    toolName: 'foxxi.assign_audience',
    title: '[admin] Assign a course to an audience group via a policy',
    description: 'Bind a course to an audience group (by audience_tag) via a Foxxi assignment policy descriptor. Trigger options: on-hire, on-role-change, on-cycle (annually), manual. Due-by relative days control when the assignment expires.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/assign_audience',
    inputs: [
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL.' },
      { name: 'course_iri', type: 'string', required: true, description: 'IRI of the course (must already be ingested).' },
      { name: 'audience_tag', type: 'string', required: true, description: 'Audience tag this course is assigned to (e.g., "support").' },
      { name: 'requirement_type', type: 'string', required: true, description: 'One of: required | recommended.' },
      { name: 'trigger', type: 'string', required: true, description: 'One of: on-hire | on-role-change | on-cycle | manual.' },
      { name: 'due_relative_days', type: 'number', required: true, description: 'Days from trigger event after which the assignment is overdue.' },
    ],
    appliesTo: { collections: ['groups', 'policies'] },
  },

  {
    action: 'urn:cg:action:foxxi:coverage-query' as IRI,
    toolName: 'foxxi.coverage_query',
    title: '[admin] Query concept coverage across the catalog',
    description: 'Privacy-respecting coverage query: across the catalog, which concepts are taught vs only mentioned, by which courses, in which categories. Defaults to v2 merkle-attested-opt-in (count of courses per concept); v3 zk-distribution mode returns a histogram of coverage shape (concepts taught in 1 course / 2-5 / 6-10 / 10+) with per-bucket DP noise. Composes with the existing applications/_shared/aggregate-privacy/ ladder.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/coverage_query',
    inputs: [
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL.' },
      { name: 'category_filter', type: 'string', required: false, description: 'Optional category filter (e.g., "Power Systems / Technical").' },
      { name: 'concept_filter', type: 'string', required: false, description: 'Optional concept label substring filter.' },
      { name: 'privacy_mode', type: 'string', required: false, description: 'One of: abac | merkle-attested-opt-in (v2, default) | zk-distribution (v3 histogram).' },
      { name: 'epsilon', type: 'number', required: false, description: 'DP ε budget for zk-distribution mode.' },
      { name: 'distribution_edges', type: 'array', required: false, description: 'Bucket-edge boundaries (decimal-string bigints) for zk-distribution.' },
      { name: 'distribution_max_value', type: 'string', required: false, description: 'Upper bound for the last bucket in zk-distribution.' },
    ],
    // Catalog-wide concept analysis — meaningful on the courses collection.
    appliesTo: { collections: ['courses'] },
  },

  {
    action: 'urn:cg:action:foxxi:publish-concept-map' as IRI,
    toolName: 'foxxi.publish_concept_map',
    title: '[admin] Publish a course\'s extracted concept map as a federated artifact',
    description: 'Publish the fxk: knowledge-stratum graph for a course as a federated pod artifact (using the federation_iri_base pattern from federation_payload.json). Lets peer tenants discover + cite concept nodes by IRI without re-ingesting the course content.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/publish_concept_map',
    inputs: [
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL.' },
      { name: 'course_iri', type: 'string', required: true, description: 'Course IRI.' },
      { name: 'federation_share_with', type: 'array', required: false, description: 'Optional list of peer-tenant DIDs the concept map is explicitly shared with (default: pod ACL).' },
    ],
    appliesTo: { collections: ['courses'] },
  },

  {
    action: 'urn:cg:action:foxxi:publish-compliance-evidence' as IRI,
    toolName: 'foxxi.publish_compliance_evidence',
    title: '[admin] Publish L&D compliance evidence (SOC 2 / EU AI Act / NIST RMF)',
    description: 'Emit an ops event (assignment/completion/exception/audit) wrapped via compliance-overlay so the L&D activity becomes a framework-cited descriptor. Composes integrations/compliance-overlay/ + src/ops/ — same path the substrate uses for its own SOC 2 evidence.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/publish_compliance_evidence',
    inputs: [
      { name: 'tenant_pod_url', type: 'string', required: true, description: 'Tenant pod URL.' },
      { name: 'event_type', type: 'string', required: true, description: 'One of: assignment-created | completion | exception | audit-action.' },
      { name: 'event_payload', type: 'object', required: true, description: 'Event payload (shape varies by event_type — assignment payload includes user_id + course_iri + due_at; completion payload includes user_id + course_iri + completed_at; etc.).' },
      { name: 'framework', type: 'string', required: false, description: 'Compliance framework to cite (default: "soc2"; alternatives: "eu-ai-act", "nist-rmf").' },
      { name: 'controls', type: 'array', required: false, description: 'Optional explicit control IRIs (default: framework\'s default L&D controls).' },
    ],
  },

  // ─── Credential issuance + competency framework exchange (ADL TLA / IEEE LERS / 1EdTech) ──

  {
    action: 'urn:cg:action:foxxi:issue-completion-credential' as IRI,
    toolName: 'foxxi.issue_completion_credential',
    title: '[admin] Issue a W3C VC / Open Badges 3.0 completion credential',
    description: 'Mint a W3C Verifiable Credential (Open Badges 3.0-shaped) for a learner who completed a course, sign it with the tenant\'s deterministic Ed25519 issuer key (eddsa-jcs-2022 DataIntegrityProof), and publish it to the learner\'s pod in the foxxi-wallet/ container as a fxa:CourseCompletionCredential descriptor. The signed VC verifies independently with any W3C VC verifier; the descriptor is discoverable via cg:discover() filtered on dct:conformsTo.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/issue_completion_credential',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner\'s WebID / DID — becomes credentialSubject.id on the VC.' },
      { name: 'learner_pod_url', type: 'string', required: true, description: 'Learner\'s pod where the credential is published (typically same as tenant_pod_url for tenant-hosted wallets).' },
      { name: 'course_id', type: 'string', required: true, description: 'Course identifier (e.g. golf-explained).' },
      { name: 'course_title', type: 'string', required: true, description: 'Human-readable course title (becomes Achievement.name).' },
      { name: 'course_description', type: 'string', required: false, description: 'Optional achievement description.' },
      { name: 'criterion_narrative', type: 'string', required: false, description: 'Optional natural-language statement of the completion criterion (becomes Achievement.criteria.narrative).' },
      { name: 'aligned_skills', type: 'array', required: false, description: 'Optional array of competency alignments (each: { targetCode, targetName, targetFramework?, targetFrameworkUrl?, proficiencyLevel? }). Becomes Achievement.alignment[].' },
      { name: 'evidence', type: 'array', required: false, description: 'Optional supporting evidence array (each: { type, id, narrative? }) — e.g. cited slides from a Q&A turn.' },
      { name: 'derived_from_experiences', type: 'array', required: false, description: 'Optional IRIs of the raw xAPI experience records this completion was derived from. Recorded as prov:wasDerivedFrom on the credential descriptor + fxa:LearningExperience evidence on the VC, so an auditor can walk credential → raw events.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:export-clr' as IRI,
    toolName: 'foxxi.export_clr',
    title: 'Export a learner\'s Comprehensive Learner Record (1EdTech CLR 2.0)',
    description: 'Walk the learner\'s pod via cg:discover(), aggregate every fxa:CourseCompletionCredential + fxa:CompetencyAssertion the pod holds, verify each embedded W3C VC\'s DataIntegrityProof, and return a 1EdTech CLR 2.0-shaped envelope wrapping all verified entries. Each entry preserves its own proof so downstream verifiers can re-check any single credential without trusting the envelope.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/export_clr',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner\'s WebID/DID — also cross-checked against each credential\'s credentialSubject.id.' },
      { name: 'learner_pod_url', type: 'string', required: true, description: 'Pod root to walk.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:assemble-learner-record' as IRI,
    toolName: 'foxxi.assemble_learner_record',
    title: 'Assemble an Enterprise Learner Record (IEEE P2997 — human or AI agent)',
    description: 'Compose an IEEE P2997 Enterprise Learner Record — the unified, provenance-pointed aggregate of a subject\'s path. Pulls learning EXPERIENCES + on-the-job PERFORMANCE records from Foxxi-as-LRS xAPI statements, CREDENTIALS from the subject\'s pod wallet (reusing the verified CLR composer), and COMPETENCIES ranked across three bases: performance-verified (Asserted — proven by successful production work, supersedes weaker evidence), credentialed (Asserted), and inferred (Hypothetical — predicted from a passed/completed experience alone; cg:modalStatus keeps the prediction honest). Actor-agnostic: the subject may be a human learner/performer OR an AI agent learning + exercising tools — set actor_kind accordingly. Every entry carries a raw-data-location pointer per the P2997 data-ownership requirement. Pure read; non-admins may assemble their own human record, and any caller may assemble an agent capability record (agent capabilities are discoverable, like the agent registry).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/assemble_learner_record',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Subject\'s WebID/DID — the ELR subject; cross-checked against credential subjects.' },
      { name: 'learner_pod_url', type: 'string', required: false, description: 'Subject\'s pod root to walk for wallet credentials (defaults to the tenant pod).' },
      { name: 'learner_name', type: 'string', required: false, description: 'Optional subject display name for the ELR header.' },
      { name: 'actor_kind', type: 'string', required: false, description: 'human (default) or agent. Agent capability records are assemblable by any caller; human records are self/admin-only.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:record-performance' as IRI,
    toolName: 'foxxi.record_performance',
    title: 'Record a performance event (on-the-job work — human or AI agent)',
    description: 'Record one unit of on-the-job production work as an xAPI `performed` statement — the IEEE P2997 employment-history leg, kept distinct from training experiences. The performer (actor_did) may be a human exercising a workplace task OR an AI agent exercising a tool; the authenticated caller is the attesting observer, recorded in provenance. Performance records feed the ELR competency engine: successful production work yields a performance-verified (Asserted) competency that SUPERSEDES a training-only inference for the same competency — closing the data-informed loop.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/record_performance',
    inputs: [
      { name: 'actor_did', type: 'string', required: true, description: 'Performer\'s DID — a human learner/performer or an AI agent. Defaults to the caller.' },
      { name: 'task_name', type: 'string', required: true, description: 'Human-readable task or tool name (e.g. "Resolve a tier-2 support ticket", "Use the web-search tool"). Becomes the xAPI Activity name + the competency label.' },
      { name: 'task_id', type: 'string', required: false, description: 'Stable task/tool identifier; derived from task_name if omitted.' },
      { name: 'success', type: 'boolean', required: true, description: 'Did the performer complete the task successfully?' },
      { name: 'quality', type: 'number', required: false, minimum: 0, maximum: 1, description: 'Outcome quality, 0..1 (becomes xAPI result.score.scaled).' },
      { name: 'duration_iso', type: 'string', required: false, description: 'ISO 8601 duration the task took (e.g. PT4M30S).' },
      { name: 'cost_usd', type: 'number', required: false, description: 'Optional cost of the execution in USD (useful for AI-agent performance economics).' },
      { name: 'actor_kind', type: 'string', required: false, description: 'human (default) or agent.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:record-agent-trajectory' as IRI,
    toolName: 'foxxi.record_agent_trajectory',
    title: 'Record an agentic-native trajectory (modal · poly-granular · composable)',
    description: 'Record an agent run in the AGENTIC-NATIVE form — not as flat xAPI statements but as a trajectory of Context Descriptors emergent from Interego L1: each step is MODAL (Hypothetical = an intention/plan, Asserted = executed, Counterfactual = a rejected branch — with cg:supersedes chains), POLY-GRANULAR (task ▸ subtask ▸ tool-call, the PGSL principle), and COMPOSABLE (trajectories merge via the L1 union/restriction algebra). The native trajectory is the source of truth; the bridge projects only the Asserted tool-call steps down to xAPI `performed` statements (which the IEEE P2997 ELR then reads). Intentions, counterfactuals, and the task hierarchy are retained ONLY in the native trajectory — xAPI structurally cannot hold them, and the projection reports exactly what it dropped.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/record_agent_trajectory',
    inputs: [
      { name: 'agent_did', type: 'string', required: true, description: 'The agent whose run this trajectory records.' },
      { name: 'agent_name', type: 'string', required: false, description: 'Optional agent display name.' },
      { name: 'steps', type: 'array', itemType: 'object', required: true, description: 'Ordered trajectory steps. Each: { modal_status (Hypothetical|Asserted|Counterfactual), granularity (task|subtask|tool-call), verb, object_id, object_name, id?, parent_id?, supersedes_id?, was_derived_from?[], result?{success,quality,note} }.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:get-agent-trajectory' as IRI,
    toolName: 'foxxi.get_agent_trajectory',
    title: 'Get an agent\'s native trajectory (what the xAPI projection drops)',
    description: 'Return an agent\'s full agentic-native trajectory — every step at every modal status (including the Hypothetical intentions + Counterfactual branches xAPI cannot represent) and every granularity. Includes a projection summary: how many steps reach xAPI vs. how many are retained only in the native form. Agent trajectories are discoverable, like the agent capability registry.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/get_agent_trajectory',
    inputs: [
      { name: 'agent_did', type: 'string', required: true, description: 'The agent whose trajectory to retrieve.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:assess-agent-disposition' as IRI,
    toolName: 'foxxi.assess_agent_disposition',
    title: 'Assess a team of agents\' disposition (Agent Performance Technology)',
    description: 'Read a team of agents\' DISPOSITION from their trajectories — deliberately NOT a gap analysis. There is no ideal future state and no score-vs-exemplary; the gap model only fits knowable work, and a team of agents is a complex, adaptive system. Returns the modal balance (deliberation / exploration / plan-revision propensities), named dispositions, a WORK-REGIME placement of the team\'s behaviour with the decision stance it calls for, and a VECTOR of drift from the present — not a destination. If a safe-to-fail probe has been run on this team, also returns the causal read (the interventional + counterfactual effect).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/assess_agent_disposition',
    inputs: [
      { name: 'agent_dids', type: 'array', itemType: 'string', required: true, description: 'The DIDs of the agents forming the team to assess.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:run-performance-probe' as IRI,
    toolName: 'foxxi.run_performance_probe',
    title: 'Run a safe-to-fail performance probe on an agent team',
    description: 'Record a safe-to-fail probe on an agent team — the disposition-based intervention. A probe nudges a CONSTRAINT (an affordance scope, a delegation bound, a connecting constraint), never an outcome: manage constraints, not targets. It is a deliberate, reversible change: the handler snapshots the team\'s disposition before the change as the causal baseline. The probe declares its safe-to-fail portfolio role (coherent / oblique / contradictory) and its weak signals — what would tell the consultant to amplify vs. dampen it. Re-assess the team afterward (assess_agent_disposition) to get the interventional + counterfactual causal read.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/run_performance_probe',
    inputs: [
      { name: 'agent_dids', type: 'array', itemType: 'string', required: true, description: 'The agent team the probe is run on.' },
      { name: 'constraint_target', type: 'string', required: true, description: 'The constraint being nudged — e.g. "delegation-scope", "web-search-affordance", "connecting-constraint:researcher-summariser". Never an outcome.' },
      { name: 'change', type: 'string', required: true, description: 'Human description of the constraint nudge (e.g. "broaden the delegation scope so the researcher may sub-delegate retrieval").' },
      { name: 'coherence', type: 'string', required: true, description: 'Safe-to-fail portfolio role: coherent | oblique | contradictory.' },
      { name: 'hypothesized_effect', type: 'string', required: true, description: 'What the consultant expects the nudge to do to the disposition (a hypothesis, not a target).' },
      { name: 'amplify_signal', type: 'string', required: true, description: 'The weak signal that would say: amplify this probe.' },
      { name: 'dampen_signal', type: 'string', required: true, description: 'The weak signal that would say: dampen / withdraw this probe.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:open-agent-evaluation' as IRI,
    toolName: 'foxxi.open_agent_evaluation',
    title: 'Open an agent / harness evaluation cohort',
    description: 'Open a named, shared evaluation — the place where several teams\' competing agents or harnesses are compared head-to-head. Carries the decision the cohort exists to inform (e.g. "should we standardise on one agentic harness, or fund several?") and an optional shared task set so the comparison is apples-to-apples. The motivating case: an enterprise where multiple teams independently build agents/harnesses and cannot agree how to evaluate one against another. Candidates enrol via foxxi.request_evaluation_enrollment; runs are recorded via foxxi.record_external_agent_run; the portfolio read is foxxi.compare_agent_evaluation.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/open_agent_evaluation',
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Human-readable name for the evaluation cohort.' },
      { name: 'decision_question', type: 'string', required: true, description: 'The decision this cohort exists to inform — e.g. "Which coding-agent harness should the platform team adopt — or should we keep more than one?".' },
      { name: 'task_set', type: 'array', itemType: 'object', required: false, description: 'Optional shared task set for apples-to-apples comparison. Each: { name, id?, description? } (a plain string is accepted as a task name).' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:request-evaluation-enrollment' as IRI,
    toolName: 'foxxi.request_evaluation_enrollment',
    title: 'Request enrollment of an agent into an evaluation cohort (cross-pod delegation)',
    description: 'A team requests that its agent / harness join an evaluation cohort as a candidate. The candidate agent is identified by its own DID — which may live on a different team\'s pod — so enrolling it is a cross-pod delegation: the request starts as `requested` and does not enter the comparison until the evaluation owner accepts it (foxxi.decide_evaluation_candidate). This request → accept handshake is the delegation grant. Records the team, and the harness/runtime the agent is built on, so the portfolio read can attribute behaviour to the harness.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/request_evaluation_enrollment',
    inputs: [
      { name: 'evaluation_id', type: 'string', required: true, description: 'The evaluation cohort to enrol into.' },
      { name: 'agent_did', type: 'string', required: true, description: 'The candidate agent\'s DID — may resolve to another team\'s pod.' },
      { name: 'agent_name', type: 'string', required: false, description: 'Display name for the candidate agent.' },
      { name: 'team', type: 'string', required: true, description: 'The team that owns / submitted this candidate.' },
      { name: 'harness', type: 'object', required: false, description: 'The harness / runtime the agent is built on: { name?, version?, runtime? }.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod where the candidate agent\'s records live, when cross-pod.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:decide-evaluation-candidate' as IRI,
    toolName: 'foxxi.decide_evaluation_candidate',
    title: 'Accept or decline a candidate agent (the cross-pod delegation grant)',
    description: 'The evaluation owner accepts or declines a requested candidate. Accepting it IS the cross-pod delegation grant — the candidate agent (whose DID may belong to another team / pod) becomes a managed member of the cohort and may record runs into it. This closes the gap where Interego could register an agent on your own pod but had no turnkey flow to authorise an external agent into a shared, managed evaluation.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/decide_evaluation_candidate',
    inputs: [
      { name: 'evaluation_id', type: 'string', required: true, description: 'The evaluation cohort.' },
      { name: 'candidate_id', type: 'string', required: true, description: 'The candidate to decide on (from request_evaluation_enrollment).' },
      { name: 'decision', type: 'string', required: true, description: 'accept | decline.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:record-external-agent-run' as IRI,
    toolName: 'foxxi.record_external_agent_run',
    title: 'Record one completed run of an external agent (Codex, OpenClaw, Hermes, enterprise)',
    description: 'The one-call adapter for an EXTERNAL agent — one that does its work outside Foxxi (a Codex doing real coding, an OpenClaw or Hermes agent, a custom enterprise agent) and is therefore invisible to the trajectory layer and the ELR. Emit a single completed RUN and the bridge normalises it into a genuine agentic-native trajectory AND xAPI `performed` statements, so the run becomes visible to disposition assessment, the IEEE P2997 ELR, and — if bound to an evaluation — the portfolio read. Two input shapes: `tool_calls` (a flat list — an un-instrumented agent wires this in ~10 lines) or `steps` (the full modal / poly-granular trajectory, for an agent that already tracks intentions + counterfactual branches). Bind the run to a cohort with evaluation_id (+ optionally candidate_id).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/record_external_agent_run',
    inputs: [
      { name: 'agent_did', type: 'string', required: true, description: 'The external agent\'s DID.' },
      { name: 'agent_name', type: 'string', required: false, description: 'Display name for the agent.' },
      { name: 'task_name', type: 'string', required: true, description: 'What the run accomplished (becomes the xAPI Activity name).' },
      { name: 'task_id', type: 'string', required: false, description: 'Stable task identifier; derived from task_name if omitted.' },
      { name: 'task_description', type: 'string', required: false, description: 'Optional longer task description.' },
      { name: 'success', type: 'boolean', required: true, description: 'Did the run succeed overall?' },
      { name: 'quality', type: 'number', required: false, minimum: 0, maximum: 1, description: 'Outcome quality 0..1.' },
      { name: 'duration_iso', type: 'string', required: false, description: 'ISO 8601 duration the run took (e.g. PT12M).' },
      { name: 'cost_usd', type: 'number', required: false, description: 'Cost of the run in USD — agent-economics signal for the portfolio read.' },
      { name: 'tool_calls', type: 'array', itemType: 'object', required: false, description: 'Simple form — a flat list of tool invocations. Each: { tool, object_name?, object_id?, success?, quality?, note? }.' },
      { name: 'steps', type: 'array', itemType: 'object', required: false, description: 'Rich form — the full modal / poly-granular trajectory. Each: { modal_status, granularity, verb, object_id, object_name, id?, parent_id?, supersedes_id?, was_derived_from?[], result? }. Provide tool_calls OR steps.' },
      { name: 'evaluation_id', type: 'string', required: false, description: 'Bind this run to an evaluation cohort.' },
      { name: 'candidate_id', type: 'string', required: false, description: 'The candidate this run belongs to; resolved from agent_did within the evaluation if omitted.' },
      { name: 'harness', type: 'object', required: false, description: 'The harness / runtime: { name?, version?, runtime? }.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:get-agent-evaluation' as IRI,
    toolName: 'foxxi.get_agent_evaluation',
    title: 'Get an evaluation cohort — its candidates and their enrollment status',
    description: 'Return an evaluation cohort: the decision question, the shared task set, and every candidate with its team, harness, enrollment status (requested / accepted / declined) and run count. The read view for tracking who is in the bake-off and how much evidence each candidate has accumulated.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/get_agent_evaluation',
    inputs: [
      { name: 'evaluation_id', type: 'string', required: true, description: 'The evaluation cohort to read.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:compare-agent-evaluation' as IRI,
    toolName: 'foxxi.compare_agent_evaluation',
    title: 'Compare the cohort — the complexity-aware portfolio read (NOT a leaderboard)',
    description: 'Produce the comparative read for an evaluation cohort — deliberately NOT a benchmark leaderboard and it emits no overall score. A leaderboard assumes the choice is knowable (a single best, found by measurement); whether to standardise on one agentic harness is usually an Emergent-regime decision where premature convergence is the ideal-future-state trap. So this returns a PORTFOLIO READ: the work regime of the WORK itself (pooled across all candidates\' runs), each candidate\'s disposition + how well it COHERES with that work, a diagnosis of what KIND of decision the executives face, and a direct answer to "should we develop only one harness?" — converge (Evident/Knowable work: analysis can name a direction), parallel (Emergent work: the competing teams ARE the correct safe-to-fail probe portfolio — keep them), recombine (complementary dispositions: compose the harnesses via the substrate\'s union operator rather than pick), or gather-evidence (thin run history). Retrospective coherence, not prediction.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/compare_agent_evaluation',
    inputs: [
      { name: 'evaluation_id', type: 'string', required: true, description: 'The evaluation cohort to compare.' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:export-case-framework' as IRI,
    toolName: 'foxxi.export_case_framework',
    title: '[admin] Export the tenant\'s competency framework as 1EdTech CASE 1.0 JSON-LD',
    description: 'Project the tenant\'s fxk:SkillFramework + fxk:Skill (+ rcd:CompetencyDefinition for skills that have RDCEO proficiency levels) into a 1EdTech CASE 1.0 CFDocument JSON-LD payload. The CASE document is consumable by any CASE-compliant tool (CASE Network, CaSS, downstream LMSes) without re-implementing the Foxxi vocab.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/export_case_framework',
    inputs: [
      { name: 'framework_id', type: 'string', required: true, description: 'Framework IRI to export (must already be published as a fxk:SkillFramework descriptor on the tenant pod).' },
    ],
  },

  // ─── Standards-coverage completion affordances (cmi5 / DID / TLA EI / CaSS / CLR1.0) ──

  {
    action: 'urn:cg:action:foxxi:emit-cmi5-session' as IRI,
    toolName: 'foxxi.emit_cmi5_session',
    title: 'Emit a cmi5-conformant xAPI session trace (launched → terminated)',
    description: 'Build the full cmi5 statement trace (launched + initialized + completed + passed/failed + terminated, plus optional satisfied if moveOn rule fires) for a learner\'s AU session. Each statement carries the cmi5 context category, session ID, and registration UUID per IEEE 9274.2.1. Caller can either fan-out to a connected LRS via the lrs-adapter or persist directly to the pod as fxa:LearningExperience descriptors.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/emit_cmi5_session',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner WebID — becomes the xAPI actor (mbox or account).' },
      { name: 'course_id', type: 'string', required: true, description: 'Course ID (becomes parent contextActivities).' },
      { name: 'au_activity_id', type: 'string', required: true, description: 'Assignable Unit IRI (becomes statement object).' },
      { name: 'registration', type: 'string', required: true, description: 'cmi5 session-id / xAPI registration UUID for this launch.' },
      { name: 'score_scaled', type: 'number', required: false, description: 'Normalized score (0..1) for passed/failed determination.' },
      { name: 'mastery_score', type: 'number', required: false, description: 'Threshold for passed; default 0.7.' },
      { name: 'duration_iso', type: 'string', required: false, description: 'Session duration as ISO 8601 (e.g. PT5M30S).' },
      { name: 'move_on_rule', type: 'string', required: false, description: 'One of Passed / Completed / CompletedAndPassed / CompletedOrPassed / NotApplicable.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:resolve-did' as IRI,
    toolName: 'foxxi.resolve_did',
    title: 'Resolve a W3C DID (did:key / did:web / did:ethr) to its DID document',
    description: 'Composes the substrate\'s DID resolver. For did:key, decodes the embedded Ed25519 public key. For did:web, fetches .well-known/did.json over HTTPS and returns the parsed document. For did:ethr, derives the verification method from the Ethereum address.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/resolve_did',
    inputs: [
      { name: 'did', type: 'string', required: true, description: 'DID to resolve (did:key:* | did:web:* | did:ethr:*).' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:query-experience-index' as IRI,
    toolName: 'foxxi.query_experience_index',
    title: 'Federate an xAPI Statement query across multiple LRSs (ADL TLA Experience Index)',
    description: 'Implements the read side of the ADL Total Learning Architecture Experience Index. Given a filter (actor / verb / activity / since / until / registration), queries every configured LRS endpoint in parallel, deduplicates statements by id, and returns a unified result with per-LRS attribution.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/query_experience_index',
    inputs: [
      { name: 'endpoints', type: 'array', required: true, description: 'Array of { label, endpoint, username, password } LRS configs.' },
      { name: 'filter', type: 'object', required: false, description: 'Filter object: { agent?, verb?, activity?, since?, until?, registration?, limit? }.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:push-to-cass' as IRI,
    toolName: 'foxxi.push_to_cass',
    title: '[admin] Push the tenant\'s competency framework to an ADL CaSS server',
    description: 'POST the tenant\'s CASE 1.0 CFDocument (from foxxi.export_case_framework) to a CaSS server\'s /api/framework endpoint. Downstream CaSS-integrated tooling can then query learner competencies without re-implementing Foxxi semantics.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/push_to_cass',
    inputs: [
      { name: 'cass_endpoint', type: 'string', required: true, description: 'CaSS server base URL.' },
      { name: 'cass_bearer', type: 'string', required: false, description: 'Optional bearer token for authenticated push.' },
      { name: 'framework_id', type: 'string', required: true, description: 'Framework IRI to export + push.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:export-clr-v1' as IRI,
    toolName: 'foxxi.export_clr_v1',
    title: 'Export a learner\'s record as 1EdTech CLR 1.0 (legacy pre-VC) JSON',
    description: 'Project the learner\'s pod credentials into the legacy 1EdTech CLR 1.0 shape for institutional consumers still on the pre-VC format. The 1.0 payload is plaintext JSON — institutional signing is the operator\'s responsibility.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/export_clr_v1',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner WebID.' },
      { name: 'learner_pod_url', type: 'string', required: true, description: 'Pod to walk.' },
    ],
  },

  // ─── "Crazy" demo affordances — compositions of the standards stack ──

  {
    action: 'urn:cg:action:foxxi:issue-bbs-credential' as IRI,
    toolName: 'foxxi.issue_bbs_credential',
    title: '[admin] Issue a BBS+-signed OB3 completion credential (supports selective disclosure)',
    description: 'Build an OB3-shaped W3C VC, sign it with the tenant\'s BBS+ key over a flattened message list. The full credential goes to the holder; the holder later derives a zero-knowledge proof revealing only the claims they choose. Verifier learns nothing about un-revealed claims.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/issue_bbs_credential',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner subject.' },
      { name: 'course_id', type: 'string', required: true, description: 'Course identifier.' },
      { name: 'course_title', type: 'string', required: true, description: 'Achievement name.' },
      { name: 'score_scaled', type: 'number', required: true, description: 'Normalized score (0..1).' },
      { name: 'proficiency_level', type: 'string', required: true, description: 'Novice | Beginner | Intermediate | Advanced | Expert.' },
      { name: 'aligned_skills', type: 'array', required: false, description: 'Optional list of { targetCode, targetName, proficiencyLevel? }.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:derive-bbs-presentation' as IRI,
    toolName: 'foxxi.derive_bbs_presentation',
    title: 'Derive a selective-disclosure presentation from a BBS+ credential',
    description: 'Holder-side. Given a BBS+-issued credential + a list of which claim paths to reveal, produce a zero-knowledge BBS+ proof + the revealed claims for the verifier. The full credential never leaves the holder.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/derive_bbs_presentation',
    inputs: [
      { name: 'issued', type: 'object', required: true, description: 'The BBS+ credential returned by foxxi.issue_bbs_credential.' },
      { name: 'reveal_paths', type: 'array', required: true, description: 'Array of claim paths to reveal (e.g. ["achievement.name", "achievement.proficiencyLevel"]).' },
      { name: 'presentation_header', type: 'string', required: false, description: 'Optional UTF-8 string binding the proof to a verifier / occasion (challenge / nonce).' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:verify-bbs-presentation' as IRI,
    toolName: 'foxxi.verify_bbs_presentation',
    title: 'Verify a selective-disclosure BBS+ presentation',
    description: 'Verifier-side. Takes a presentation produced by foxxi.derive_bbs_presentation; returns whether the issuer signed a credential containing the disclosed claims at the disclosed positions. Verifier learns ONLY the revealed claims.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/verify_bbs_presentation',
    inputs: [
      { name: 'presentation', type: 'object', required: true, description: 'The presentation returned by foxxi.derive_bbs_presentation.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:prove-competency' as IRI,
    toolName: 'foxxi.prove_competency',
    title: 'Prove a competency privately (BBS+ selective disclosure, end-to-end)',
    description: 'Holder-facing competency proof. Composes the three BBS+ steps — issue (the bridge as tenant issuer signs a multi-claim credential), derive (disclose only a minimal privacy-preserving subset), verify — into ONE operation a learner can trigger for their own record. Proves "I hold this competency at this proficiency, issued by this tenant" to a verifier while keeping score, name, dates, and credential id behind a zero-knowledge proof. This is the IEEE P2997 LER privacy story a flat wallet cannot give. Non-admins may only prove their own competencies.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/prove_competency',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner whose competency is being proved. Non-admin callers must pass their own DID.' },
      { name: 'competency_name', type: 'string', required: true, description: 'The competency / course title to prove (becomes Achievement.name on the BBS+ credential).' },
      { name: 'course_id', type: 'string', required: false, description: 'Optional course identifier; derived from competency_name if omitted.' },
      { name: 'learner_name', type: 'string', required: false, description: 'Optional learner display name (a hidden claim — never disclosed by default).' },
      { name: 'score_scaled', type: 'number', required: false, description: 'Optional normalized score 0..1 (a hidden claim — kept private by default). Default 1.0.' },
      { name: 'proficiency_level', type: 'string', required: false, description: 'Novice | Beginner | Intermediate | Advanced | Expert. Default Intermediate.' },
      { name: 'reveal_paths', type: 'array', required: false, description: 'Optional claim paths to disclose; defaults to the minimal privacy-preserving set (issuer + achievement.name + achievement.proficiencyLevel).' },
      { name: 'presentation_context', type: 'string', required: false, description: 'Optional verifier/occasion binding (BBS+ presentation header).' },
    ],
    appliesTo: { collections: ['profiles'] },
  },

  {
    action: 'urn:cg:action:foxxi:launch-au-with-prereq' as IRI,
    toolName: 'foxxi.launch_au_with_prereq_check',
    title: 'Launch a cmi5 AU gated on a verified-credential prerequisite',
    description: 'Compose: walk the learner\'s pod for a credential satisfying the declared prereq (verify Data Integrity Proof, check achievement IRI + proficiency level + expiry + accepted issuers); if satisfied, emit the cmi5 launched + initialized statements; else return a structured prereq-failure report.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/launch_au_with_prereq_check',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner identity.' },
      { name: 'learner_pod_url', type: 'string', required: true, description: 'Pod to walk for credentials.' },
      { name: 'course_id', type: 'string', required: true, description: 'Course identifier.' },
      { name: 'au_activity_id', type: 'string', required: true, description: 'Assignable Unit IRI.' },
      { name: 'registration', type: 'string', required: true, description: 'cmi5 sessionId for this launch.' },
      { name: 'prereq_achievement_iri', type: 'string', required: true, description: 'Achievement IRI the prereq credential must match.' },
      { name: 'prereq_min_proficiency_rdf_value', type: 'number', required: false, description: 'Minimum rcd:rdfValue (1=Novice through 5=Expert).' },
      { name: 'prereq_accepted_issuer_dids', type: 'array', required: false, description: 'Whitelist of acceptable issuer DIDs.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:ai-assess-competency' as IRI,
    toolName: 'foxxi.ai_assess_competency',
    title: 'AI mentor signs a (Hypothetical) CompetencyAssertion VC',
    description: 'AI agent reviews evidence (cited slide IDs, Q&A traces, performance results) and signs a CompetencyAssertion VC with its own did:key. Modal status: Hypothetical until a human countersigns via foxxi.countersign_assessment.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/ai_assess_competency',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner subject.' },
      { name: 'mentor_seed', type: 'string', required: true, description: 'Mentor\'s seed for deterministic did:key.' },
      { name: 'competency', type: 'object', required: true, description: 'The competency claimed: { id, label, proficiencyLevel }.' },
      { name: 'evidence', type: 'array', required: true, description: 'Array of { type, id, narrative? } evidence references.' },
      { name: 'narrative', type: 'string', required: true, description: 'Mentor\'s assessment narrative.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:countersign-assessment' as IRI,
    toolName: 'foxxi.countersign_assessment',
    title: '[admin] Countersign an AI mentor\'s CompetencyAssertion → full OB3',
    description: 'Human admin reviews + countersigns the AI mentor\'s Hypothetical CompetencyAssertion. Result: a dual-issuer credential whose modal status is Asserted (= OB3-eligible). Both signatures are preserved on the descriptor for auditability.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/countersign_assessment',
    inputs: [
      { name: 'assessment', type: 'object', required: true, description: 'The CompetencyAssessment returned by foxxi.ai_assess_competency.' },
      { name: 'human_seed', type: 'string', required: true, description: 'Human admin\'s seed for deterministic countersign key.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:audit-compliance-trail' as IRI,
    toolName: 'foxxi.audit_compliance_trail',
    title: '[admin] Compose a single-query audit chain for a learner window',
    description: 'Walk the learner\'s pod, pull every descriptor with a Provenance facet or dct:conformsTo tag in the time window, return them ordered as a chain. Each step carries its framework citations so the auditor sees which controls every hop references.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/audit_compliance_trail',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'Learner identity.' },
      { name: 'learner_pod_url', type: 'string', required: true, description: 'Pod to walk.' },
      { name: 'window_from', type: 'string', required: false, description: 'ISO 8601 lower bound.' },
      { name: 'window_to', type: 'string', required: false, description: 'ISO 8601 upper bound.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:declare-framework-alignment' as IRI,
    toolName: 'foxxi.declare_framework_alignment',
    title: '[admin] Declare an alignment between this tenant\'s competency and another tenant\'s',
    description: 'Publishes a fxa:CASEAlignment descriptor binding one of this tenant\'s fxk:Skill / rcd:CompetencyDefinition items to an item in a foreign tenant\'s framework. The alignment becomes a substrate-discoverable artifact + lifts into the next CASE 1.0 export as a CFAssociation.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/declare_framework_alignment',
    inputs: [
      { name: 'own_item_iri', type: 'string', required: true, description: 'This tenant\'s competency IRI.' },
      { name: 'own_item_label', type: 'string', required: true, description: 'Display label.' },
      { name: 'other_item_iri', type: 'string', required: true, description: 'Foreign competency IRI.' },
      { name: 'other_framework_iri', type: 'string', required: true, description: 'Foreign framework IRI.' },
      { name: 'other_tenant_did', type: 'string', required: false, description: 'Foreign tenant DID (optional but useful for trust scoping).' },
      { name: 'relation', type: 'string', required: true, description: 'isAlignedTo | isEquivalentTo | precedes | isPrerequisiteOf | broadens | narrows.' },
      { name: 'rationale', type: 'string', required: false, description: 'Free-text rationale.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:resolve-aligned-competency' as IRI,
    toolName: 'foxxi.resolve_aligned_competency',
    title: 'Resolve whether a held competency satisfies a required competency via alignments',
    description: 'Given the held credential\'s competency IRI + a required competency IRI + the alignment graph, BFS over isAlignedTo / isEquivalentTo edges. Returns the alignment chain (could be 0 hops for direct match, N hops for transitive) so the verifier sees how the held credential satisfied the requirement.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/resolve_aligned_competency',
    inputs: [
      { name: 'held_competency_iri', type: 'string', required: true, description: 'Competency the credential attests.' },
      { name: 'required_competency_iri', type: 'string', required: true, description: 'Competency the verifier requires.' },
      { name: 'alignments', type: 'array', required: true, description: 'Array of serialized alignments (from foxxi.declare_framework_alignment).' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:cohort-concept-intelligence' as IRI,
    toolName: 'foxxi.cohort_concept_intelligence',
    title: '[admin] Cross-pod cohort concept-overlap analytics',
    description: 'Walk a list of learner pods, pull every fxa:LearnerQuestionEvent in the time window, compute concept overlap across the cohort: which concepts >= 50% of learners asked about (reinforcement signal). Real PGSL composition with lighter set-intersection for this affordance; full PGSL meet at substrate level for atom-grain analysis.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/cohort_concept_intelligence',
    inputs: [
      { name: 'learner_pod_urls', type: 'array', required: true, description: 'Array of learner pod root URLs.' },
      { name: 'window_from', type: 'string', required: false, description: 'ISO 8601 lower bound.' },
      { name: 'window_to', type: 'string', required: false, description: 'ISO 8601 upper bound.' },
    ],
  },

  {
    action: 'urn:cg:action:foxxi:register-self-sovereign-learner' as IRI,
    toolName: 'foxxi.register_self_sovereign_learner',
    title: 'Register a learner identity (human or AI agent) with their own DID + pod',
    description: 'Take a caller\'s did:key + their pod URL + a display name; publish a fxa:SelfSovereignLearner descriptor on their pod marking them as a Foxxi learner (no employer mediation). After registration, the same caller can use foxxi.discover_assigned_courses / foxxi.retrieve_course_context / etc. against any tenant.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/register_self_sovereign_learner',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: 'The caller\'s own DID (did:key / did:web / did:ethr).' },
      { name: 'learner_pod_url', type: 'string', required: true, description: 'Pod URL where credentials will land.' },
      { name: 'display_name', type: 'string', required: true, description: 'Display name.' },
      { name: 'is_agent', type: 'boolean', required: false, description: 'true if the learner is an AI agent rather than a human (records on the descriptor).' },
    ],
  },

  // ─── Wave-of-13 extensions ──────────────────────────────────────────

  {
    action: 'urn:cg:action:foxxi:bootstrap-tenant' as IRI,
    toolName: 'foxxi.bootstrap_tenant',
    title: 'Bootstrap a fresh Foxxi tenant on a Solid pod',
    description: 'Publish tenant-metadata + emit env-var configuration so the bridge can switch over to a new tenant. Wizard backend.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/bootstrap_tenant',
    inputs: [
      { name: 'tenant_slug', type: 'string', required: true, description: 'URL-safe slug (e.g. partnerco-training).' },
      { name: 'tenant_did', type: 'string', required: true, description: 'DID for the new tenant (typically did:web:<domain>).' },
      { name: 'tenant_display_name', type: 'string', required: true, description: 'Human-readable tenant name.' },
      { name: 'admin_web_id', type: 'string', required: true, description: 'First admin\'s WebID.' },
      { name: 'admin_name', type: 'string', required: true, description: 'First admin\'s display name.' },
      { name: 'pod_url', type: 'string', required: true, description: 'Pod URL the tenant\'s artifacts will land on.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:scorm-cloud-pull' as IRI,
    toolName: 'foxxi.scorm_cloud_pull',
    title: '[admin] Pull a SCORM Cloud catalog into the tenant',
    description: 'Use SCORM Cloud Application API v2 to list courses + project them as fxs:CourseCatalog stub entries on the tenant pod. Requires FOXXI_SCORM_CLOUD_APP_ID + FOXXI_SCORM_CLOUD_SECRET_KEY env on the bridge.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/scorm_cloud_pull',
    inputs: [
      { name: 'publish_to_pod', type: 'boolean', required: false, description: 'If true, also publish the projected catalog entries as a fxs:CourseCatalog descriptor on the tenant pod (default false: return-only).' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:scorm-cloud-register' as IRI,
    toolName: 'foxxi.scorm_cloud_register',
    title: '[admin] Create a SCORM Cloud registration for a learner',
    description: 'POST to /registrations on SCORM Cloud; the returned registration ID becomes the cmi5 sessionId.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/scorm_cloud_register',
    inputs: [
      { name: 'registration_id', type: 'string', required: true, description: 'Caller-chosen UUID for this learner+course attempt.' },
      { name: 'course_id', type: 'string', required: true, description: 'SCORM Cloud course ID.' },
      { name: 'learner_id', type: 'string', required: true, description: 'Stable learner identifier (typically the WebID).' },
      { name: 'learner_first_name', type: 'string', required: false, description: '' },
      { name: 'learner_last_name', type: 'string', required: false, description: '' },
      { name: 'learner_email', type: 'string', required: false, description: '' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:upload-scorm-package' as IRI,
    toolName: 'foxxi.upload_scorm_package',
    title: 'Upload a SCORM zip package for ingestion',
    description: 'Queue a SCORM .zip for the Python parser. Publishes a fxs:PackageUpload descriptor with modalStatus:Hypothetical; the separate parser-runner picks it up, parses, then publishes the resulting fxs:Package via cg:supersedes.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/upload_scorm_package',
    inputs: [
      { name: 'zip_base64', type: 'string', required: true, description: 'base64-encoded SCORM zip.' },
      { name: 'hinted_title', type: 'string', required: false, description: 'Display name for the upload while parsing is pending.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:derive-adaptive-policy' as IRI,
    toolName: 'foxxi.derive_adaptive_policy',
    title: '[admin] Derive an adaptive-sequencing policy from cohort intelligence',
    description: 'Takes the output of foxxi.cohort_concept_intelligence + emits a fxa:AdaptiveSequencingPolicy that downstream learners can be gated on.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/derive_adaptive_policy',
    inputs: [
      { name: 'cohort_intel', type: 'object', required: true, description: 'CohortIntelligence object from foxxi.cohort_concept_intelligence.' },
      { name: 'threshold_pct', type: 'number', required: false, description: 'Concepts above this cohort-coverage % become reinforcement gates (default 50).' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:schedule-spaced-repetition' as IRI,
    toolName: 'foxxi.schedule_spaced_repetition',
    title: 'Schedule spaced-repetition reminders for a learner',
    description: 'Ebbinghaus 1/7/30-day intervals, with early-week reminders for concepts other concepts depend on (foundation signal).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/schedule_spaced_repetition',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: '' },
      { name: 'completed_concepts', type: 'array', required: true, description: 'Array of { conceptId, completedAt }.' },
      { name: 'prereq_edges', type: 'array', required: true, description: 'Array of { from, to } prereq edges from the course graph.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:discover-framework-registry' as IRI,
    toolName: 'foxxi.discover_framework_registry',
    title: 'Federated discovery of competency frameworks across tenant pods',
    description: 'Walk N pod URLs, return every fxs:CourseCatalog / fxs:SkillFramework / fxa:CASEAlignment descriptor — the public-registry pattern without a central registry.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/discover_framework_registry',
    inputs: [
      { name: 'pod_urls', type: 'array', required: true, description: 'Array of pod root URLs to walk.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:register-tutor-agent' as IRI,
    toolName: 'foxxi.register_tutor_agent',
    title: 'Register an AI tutor agent in the marketplace',
    description: 'Publishes a fxa:TutorAgentProfile descriptor on the agent\'s own pod describing specialties + contact endpoint. Discoverable via foxxi.find_tutor_for_competency.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/register_tutor_agent',
    inputs: [
      { name: 'agent_did', type: 'string', required: true, description: 'The tutor\'s DID.' },
      { name: 'display_name', type: 'string', required: true, description: '' },
      { name: 'specialties', type: 'array', required: true, description: 'Array of { frameworkIri, competencyIri, selfRatedLevel }.' },
      { name: 'description', type: 'string', required: false, description: '' },
      { name: 'powered_by', type: 'string', required: false, description: 'e.g. claude-opus-4-7' },
      { name: 'contact_endpoint', type: 'string', required: false, description: 'MCP server URL where the tutor agent runs.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:find-tutor-for-competency' as IRI,
    toolName: 'foxxi.find_tutor_for_competency',
    title: 'Search the tutor marketplace for a specific competency',
    description: 'Rank-search tutor candidates by competency match + number of independent human-countersigned competency assertions they\'ve signed (a proxy for teaching quality).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/find_tutor_for_competency',
    inputs: [
      { name: 'required_competency_iri', type: 'string', required: true, description: '' },
      { name: 'required_level', type: 'string', required: false, description: 'Novice | Beginner | Intermediate | Advanced | Expert' },
      { name: 'candidate_profiles', type: 'array', required: true, description: 'Array of TutorAgentProfile to rank.' },
      { name: 'countersign_counts', type: 'object', required: false, description: 'Map { agentDid: number } of independent countersigns per tutor.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:generate-dpia' as IRI,
    toolName: 'foxxi.generate_dpia',
    title: '[admin] Generate a Data Protection Impact Assessment for a learner window',
    description: 'Wraps foxxi.audit_compliance_trail. Returns a structured DPIA with summary stats, framework controls cited, data-category breakdown, risk-rated findings + suggested mitigations (GDPR Art. 35 + EU AI Act § 13 shape).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/generate_dpia',
    inputs: [
      { name: 'learner_did', type: 'string', required: true, description: '' },
      { name: 'learner_pod_url', type: 'string', required: true, description: '' },
      { name: 'window_from', type: 'string', required: false, description: '' },
      { name: 'window_to', type: 'string', required: false, description: '' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:manager-team-view' as IRI,
    toolName: 'foxxi.manager_team_view',
    title: '[manager] Build a competency map for the manager\'s direct reports',
    description: 'Walk each report\'s pod, aggregate credentials, return per-report breakdown + team skill coverage roll-up.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/manager_team_view',
    inputs: [
      { name: 'manager_web_id', type: 'string', required: true, description: '' },
      { name: 'report_pods', type: 'array', required: true, description: 'Array of { webId, name?, podUrl }.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:build-did-web-document' as IRI,
    toolName: 'foxxi.build_did_web_document',
    title: '[admin] Build a publishable did:web document for a tenant',
    description: 'Returns the DID document JSON the operator uploads to https://<tenant-domain>/.well-known/did.json so verifiers can resolve tenant credentials.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/build_did_web_document',
    inputs: [
      { name: 'tenant_did', type: 'string', required: true, description: 'e.g. did:web:tenant.example' },
      { name: 'issuer_public_key_multibase', type: 'string', required: true, description: 'Tenant\'s Ed25519 issuer public key in multibase form.' },
      { name: 'bridge_endpoint', type: 'string', required: true, description: 'URL of the tenant\'s foxxi bridge.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:backup-tenant-pod' as IRI,
    toolName: 'foxxi.backup_tenant_pod',
    title: '[admin] One-shot backup of every descriptor on the tenant pod',
    description: 'Pulls the manifest + every descriptor + every reachable graph into one JSON object. Encrypted graphs come back as ciphertext.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/backup_tenant_pod',
    inputs: [],
  },

  // ─── Learning Engineer affordances ──────────────────────────────────

  {
    action: 'urn:cg:action:foxxi:le-design-ab-experiment' as IRI,
    toolName: 'foxxi.le_design_ab_experiment',
    title: '[learning-engineer] Pre-register an A/B experiment between two course variants',
    description: 'Power-analysis + analysis plan for an instructional A/B. Returns required sample size per arm, recommended statistical test for the primary metric, and (if perWeekEnrolment is supplied) an estimated duration. Pre-registration prevents p-hacking.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/le_design_ab_experiment',
    inputs: [
      { name: 'variant_a', type: 'object', required: true, description: '{ courseId, courseTitle? }' },
      { name: 'variant_b', type: 'object', required: true, description: '{ courseId, courseTitle? }' },
      { name: 'primary_metric', type: 'string', required: true, description: 'completion-rate | mastery-score | time-to-mastery | retention-30-day | downstream-prereq-pass-rate' },
      { name: 'minimum_detectable_effect', type: 'number', required: true, description: 'e.g. 0.05 for a 5pp lift' },
      { name: 'alpha', type: 'number', required: false, description: 'default 0.05' },
      { name: 'power', type: 'number', required: false, description: 'default 0.8' },
      { name: 'randomization', type: 'string', required: false, description: 'simple | stratified-by-audience-tag (default)' },
      { name: 'per_week_enrolment', type: 'number', required: false, description: 'Enrolment rate for duration estimate.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:le-estimate-concept-difficulty' as IRI,
    toolName: 'foxxi.le_estimate_concept_difficulty',
    title: '[learning-engineer] Rank a course\'s concepts by estimated difficulty',
    description: 'Composes prereq-graph topology + cohort question-frequency to produce a per-concept difficulty score (0..1). Foundational concepts (≥3 dependents) flagged. The right-shape proxy for IRT until per-learner response data is available.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/le_estimate_concept_difficulty',
    inputs: [
      { name: 'course_id', type: 'string', required: true, description: 'Course whose concept graph to analyze (e.g. golf-explained).' },
      { name: 'cohort_intel', type: 'object', required: false, description: 'Output of foxxi.cohort_concept_intelligence (optional but improves accuracy).' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:le-analyze-learning-curve' as IRI,
    toolName: 'foxxi.le_analyze_learning_curve',
    title: '[learning-engineer] Detect plateaus in a per-concept learning curve',
    description: 'Plots mastery-rate-per-attempt + detects plateaus (3 consecutive attempts with <1pp improvement). Returns diagnosis (rising / plateau-low / plateau-high / insufficient-data) + an actionable recommendation.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/le_analyze_learning_curve',
    inputs: [
      { name: 'concept_id', type: 'string', required: true, description: '' },
      { name: 'concept_label', type: 'string', required: false, description: '' },
      { name: 'attempts', type: 'array', required: true, description: 'Per-learner outcomes: array of { learnerId, attemptNumber, mastered }.' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:le-calibrate-mastery-threshold' as IRI,
    toolName: 'foxxi.le_calibrate_mastery_threshold',
    title: '[learning-engineer] Calibrate the cmi5 mastery threshold against downstream success',
    description: 'Find the score threshold that maximizes Youden\'s J (sensitivity + specificity − 1) against downstream prereq-dependent performance. Returns ROC curve + recommended threshold.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/le_calibrate_mastery_threshold',
    inputs: [
      { name: 'records', type: 'array', required: true, description: 'Per-learner outcomes: array of { scoreScaled, downstreamSuccess }.' },
      { name: 'threshold_grid', type: 'array', required: false, description: 'Optional thresholds to evaluate (default 0..1 step 0.05).' },
    ],
  },
  {
    action: 'urn:cg:action:foxxi:le-framework-gap-analysis' as IRI,
    toolName: 'foxxi.le_framework_gap_analysis',
    title: '[learning-engineer] Cross-reference framework competencies against taught concepts',
    description: 'Finds (a) competencies in the framework with no taught concept (assessments can\'t be grounded) and (b) taught concepts not aligned to any competency (credentials can\'t reference the framework). Returns coverage % + per-direction gap lists.',
    method: 'POST',
    targetTemplate: '{base}/foxxi/le_framework_gap_analysis',
    inputs: [
      { name: 'framework_skills', type: 'array', required: true, description: 'Array of { id, label? } competency definitions.' },
      { name: 'course_concepts', type: 'array', required: true, description: 'Array of CourseConcept from a published course.' },
      { name: 'alignments', type: 'array', required: true, description: 'Array of { skillId, conceptId } edges.' },
    ],
  },
];
