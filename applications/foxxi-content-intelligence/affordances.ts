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
  },

  {
    action: 'urn:cg:action:foxxi:ask-course-question' as IRI,
    toolName: 'foxxi.ask_course_question',
    title: 'Ask a question about a course',
    description: 'Grounded Q&A over a course\'s narration transcripts + extracted concepts. The learner asks "what is reactive current?" and the substrate returns verbatim-cited transcript segments + concept snippets that overlap the question. Composes the existing learner-performer-companion grounded-answer machinery (same honesty discipline: tamper-detected atoms, IRI citations, honest null when no atom overlaps the question).',
    method: 'POST',
    targetTemplate: '{base}/foxxi/ask_course_question',
    inputs: [
      { name: 'course_iri', type: 'string', required: true, description: 'IRI of the course (matches federation_iri_base#package emitted by ingest_content_package).' },
      { name: 'learner_did', type: 'string', required: true, description: 'Asking learner DID. Recorded on the response descriptor for audit.' },
      { name: 'question', type: 'string', required: true, description: 'Natural-language question (e.g., "what is reactive current?").' },
      { name: 'course_content', type: 'object', required: true, description: 'The course\'s narration transcripts + extracted concepts. In a real deployment the bridge fetches this from the tenant pod via the published fxs/fxk descriptors; for the in-process invocation supply the shape from the parser\'s dashboard_data + transcripts payloads.' },
    ],
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
      { name: 'instance', type: 'string', required: true, description: 'LMS instance URL or domain (e.g., "acme-utility.csod.com").' },
      { name: 'auth_method', type: 'string', required: true, description: 'Auth method (e.g., "OAuth 2.0 (corporate)", "Basic+API key").' },
      { name: 'sync_frequency', type: 'string', required: false, description: 'Human-readable sync frequency (default: "every 6 hours").' },
    ],
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
      { name: 'audience_tag', type: 'string', required: true, description: 'Audience tag this course is assigned to (e.g., "transmission-operator").' },
      { name: 'requirement_type', type: 'string', required: true, description: 'One of: required | recommended.' },
      { name: 'trigger', type: 'string', required: true, description: 'One of: on-hire | on-role-change | on-cycle | manual.' },
      { name: 'due_relative_days', type: 'number', required: true, description: 'Days from trigger event after which the assignment is overdue.' },
    ],
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
];
