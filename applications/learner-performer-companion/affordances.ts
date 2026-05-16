/**
 * Affordance declarations for the learner-performer-companion vertical.
 *
 * Single source of truth: each capability is declared as a typed
 * Affordance object. The vertical's bridge derives MCP tool schemas
 * from this; it ALSO publishes these as cg:Affordance descriptors so
 * generic Interego agents can discover and invoke the capabilities
 * via the protocol's standard affordance-walk (no per-vertical client
 * code required at the consuming agent).
 *
 * Action IRIs use the urn:cg:action:lpc:<verb> convention. Targets
 * use {base} as a placeholder for the bridge's deployment URL,
 * substituted at affordance-publication time.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '../../src/index.js';

const LPC_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:lpc:ingest-training-content' as IRI,
    toolName: 'lpc.ingest_training_content',
    title: 'Ingest training content',
    description: 'Unwrap a SCORM 1.2 / SCORM 2004 / cmi5 zip package, extract launchable lesson content, mint content-addressed PGSL atoms, and publish lpc:TrainingContent + lpc:LearningObjective descriptors to the user\'s pod.',
    method: 'POST',
    targetTemplate: '{base}/lpc/ingest_training_content',
    inputs: [
      { name: 'zip_base64', type: 'string', required: true, description: 'SCORM zip package, base64-encoded.' },
      { name: 'authoritative_source', type: 'string', required: true, description: 'DID of the training content publisher (e.g., did:web:acme-training.example).' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL (default: authenticated user\'s pod).' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID (default: derived from authentication).' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:import-credential' as IRI,
    toolName: 'lpc.import_credential',
    title: 'Import a verifiable credential',
    description: 'Verify a W3C Verifiable Credential (vc-jwt or DataIntegrityProof JSON-LD) and publish as lpc:Credential to the user\'s pod. Verification failures throw — bad VCs never land in the pod under credential IRIs.',
    method: 'POST',
    targetTemplate: '{base}/lpc/import_credential',
    inputs: [
      { name: 'vc_jwt', type: 'string', required: false, description: 'Compact JWS encoding of the VC (use this OR vc_jsonld).' },
      { name: 'vc_jsonld', type: 'object', required: false, description: 'JSON-LD VC with embedded DataIntegrityProof (use this OR vc_jwt).' },
      { name: 'for_content', type: 'string', required: false, description: 'IRI of the lpc:TrainingContent this credential certifies.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:record-performance-review' as IRI,
    toolName: 'lpc.record_performance_review',
    title: 'Record a performance review',
    description: 'Publish a performance review with cg:ProvenanceFacet attributing it to the manager (NOT the user). Stays in the user\'s pod portably.',
    method: 'POST',
    targetTemplate: '{base}/lpc/record_performance_review',
    inputs: [
      { name: 'content', type: 'string', required: true, description: 'Review text.' },
      { name: 'manager_did', type: 'string', required: true, description: 'DID of the reviewing manager.' },
      { name: 'signature', type: 'string', required: true, description: 'Manager\'s ECDSA signature over the content.' },
      { name: 'recorded_at', type: 'string', required: true, description: 'ISO timestamp.' },
      { name: 'flags_capability', type: 'string', required: false, description: 'Optional capability IRI flagged by the review.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:record-learning-experience' as IRI,
    toolName: 'lpc.record_learning_experience',
    title: 'Record a learning experience from an xAPI Statement',
    description: 'Ingest an xAPI Statement (any version 1.0.x or 2.0.x) as an lpc:LearningExperience descriptor in the user\'s pod, cross-linked to training content and credential earned.',
    method: 'POST',
    targetTemplate: '{base}/lpc/record_learning_experience',
    inputs: [
      { name: 'statement', type: 'object', required: true, description: 'xAPI Statement object.' },
      { name: 'for_content', type: 'string', required: true, description: 'IRI of the related lpc:TrainingContent.' },
      { name: 'earned_credential', type: 'string', required: false, description: 'Optional IRI of the lpc:Credential earned.' },
      { name: 'lrs_endpoint', type: 'string', required: false, description: 'Optional source LRS endpoint URL.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:grounded-answer' as IRI,
    toolName: 'lpc.grounded_answer',
    title: 'Answer a grounded chat question',
    description: 'Answer a natural-language question by retrieving from the user\'s pod with verbatim citation. Returns null when nothing in the wallet grounds the question — honest no-data, no confabulation. Persists an lpc:CitedResponse audit record.',
    method: 'POST',
    targetTemplate: '{base}/lpc/grounded_answer',
    inputs: [
      { name: 'question', type: 'string', required: true, description: 'The user\'s question.' },
      { name: 'persist_response', type: 'boolean', required: false, description: 'Whether to persist the response as audit. Default true.' },
      { name: 'assistant_did', type: 'string', required: false, description: 'DID of the answering assistant.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:list-wallet' as IRI,
    toolName: 'lpc.list_wallet',
    title: 'Summarize the user\'s wallet',
    description: 'Return a summary of training content, credentials, performance records, and learning experiences in the user\'s pod-backed wallet.',
    method: 'POST',
    targetTemplate: '{base}/lpc/list_wallet',
    inputs: [
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'user_did', type: 'string', required: false, description: 'User DID.' },
    ],
  },
];

export const lpcAffordances = LPC_AFFORDANCES;

// ─────────────────────────────────────────────────────────────────────
//  Enterprise edtech professional — declared affordance surface
// ─────────────────────────────────────────────────────────────────────
//
// The dual-audience design discipline (docs/DUAL-AUDIENCE.md) names two
// first-class audiences for the learning vertical: the learner /
// performer (above) AND the enterprise edtech professional running the
// institutional surface — L&D leader, edtech vendor, certification
// body, IEEE LERS / ADL TLA implementer.
//
// The affordances below describe the institutional side of the surface
// in design. They are DECLARED but NOT YET wired into the bridge —
// `lpcAffordances` (above) is the auto-registered set; this constant is
// the next-implementer hand-off. When an institutional bridge ships,
// these IRIs and input schemas are the contract.
//
// All four respect the substrate's bilateral primitives:
//   - Institutional content lives on the institution's OWN pod
//     (different from the learner-side `lpc.ingest_training_content`
//     which writes to the learner's pod). Learners' agents discover
//     via federation and pull selectively per their own consent.
//   - Aggregate queries use src/crypto/'s ZK primitives + the
//     spec/AGGREGATE-PRIVACY.md mechanism — counts / thresholds /
//     proofs without exposing individuals.
//   - Cohort credentials are publish-then-claim: institution issues a
//     SIGNED template; the learner's agent accepts the issuance into
//     their wallet (cf. existing lpc.import_credential).
const LPC_ENTERPRISE_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:lpc:publish-authoritative-content' as IRI,
    toolName: 'lpc.publish_authoritative_content',
    title: '[institutional] Publish authoritative training content',
    description: 'Institution-side: unwrap a SCORM 1.2 / SCORM 2004 / cmi5 / TLA-LAP-catalog-entry package, mint atoms, and publish lpc:TrainingContent + lpc:LearningObjective descriptors to the INSTITUTION\'s own pod (NOT the learner\'s). Learners\' agents discover via federated discovery and pull selectively into their own wallets per their own consent. The institution is a peer, not a hub.',
    method: 'POST',
    targetTemplate: '{base}/lpc/publish_authoritative_content',
    inputs: [
      { name: 'zip_base64', type: 'string', required: true, description: 'Content package (SCORM / cmi5 / TLA LAP entry), base64-encoded.' },
      { name: 'institution_pod_url', type: 'string', required: true, description: 'Pod URL of the publishing institution.' },
      { name: 'issuer_did', type: 'string', required: true, description: 'DID of the institution\'s authoritative-content signing key.' },
      { name: 'tla_lap_metadata', type: 'object', required: false, description: 'Optional ADL TLA Learning Activity Provider metadata for catalog discoverability.' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:issue-cohort-credential-template' as IRI,
    toolName: 'lpc.issue_cohort_credential_template',
    title: '[institutional] Issue a cohort credential template',
    description: 'Institution-side: publish a SIGNED credential TEMPLATE (the rubric for what is earned) to the institution\'s pod. Eligible learners\' agents discover, verify the issuer\'s signature, and call lpc.import_credential to accept the issuance into their own wallet. Conforms to Open Badges 3.0 / IMS CLR 2.0 / IEEE LERS shapes per the `credential_format` parameter. The institution issues; the learner consents to acceptance.',
    method: 'POST',
    targetTemplate: '{base}/lpc/issue_cohort_credential_template',
    inputs: [
      { name: 'cohort_iri', type: 'string', required: true, description: 'IRI naming the cohort the template applies to (e.g., a course-completion cohort).' },
      { name: 'credential_format', type: 'string', required: true, description: 'One of: open-badges-3.0 | ims-clr-2.0 | ieee-lers.' },
      { name: 'credential_subject_template', type: 'object', required: true, description: 'The W3C VC credentialSubject template; learner DID substituted on acceptance.' },
      { name: 'issuer_did', type: 'string', required: true, description: 'DID of the credential-signing institution.' },
      { name: 'institution_pod_url', type: 'string', required: true, description: 'Pod URL where the template is published.' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:aggregate-cohort-query' as IRI,
    toolName: 'lpc.aggregate_cohort_query',
    title: '[institutional] Run an aggregate-privacy query over a cohort',
    description: 'Institution-side: query aggregate metrics over consenting learners\' pods — completion counts, score distributions, competency-coverage thresholds — without seeing individuals. Uses src/crypto/ ZK proofs + spec/AGGREGATE-PRIVACY.md. Returns counts / proofs / threshold-met booleans. Refuses any query that would expose an individual record. Learners control participation via per-graph share_with on a cohort-aggregation policy descriptor.',
    method: 'POST',
    targetTemplate: '{base}/lpc/aggregate_cohort_query',
    inputs: [
      { name: 'cohort_iri', type: 'string', required: true, description: 'IRI of the cohort being queried.' },
      { name: 'metric', type: 'string', required: true, description: 'One of: completion-count | score-distribution | competency-threshold-met | credential-coverage.' },
      { name: 'predicate', type: 'object', required: false, description: 'Optional SHACL-shaped filter (e.g., "score >= 0.8"). The query returns the count / proof of how many learners satisfy; not which.' },
      { name: 'institution_pod_url', type: 'string', required: true, description: 'Pod URL of the querying institution (used for authorization + result publication).' },
    ],
  },

  {
    action: 'urn:cg:action:lpc:project-to-lrs' as IRI,
    toolName: 'lpc.project_to_lrs',
    title: '[institutional] Project descriptors as xAPI Statements outbound to an LRS',
    description: 'Institution-side: with the learner\'s per-graph consent, translate lpc:LearningExperience descriptors from the learner\'s pod into xAPI 2.0 Statements and POST to a target LRS (Watershed / Veracity / SCORM Cloud / Yet Analytics / Learning Locker). Wraps the boundary translator in ../lrs-adapter/. The result is lossy by definition (xAPI cannot express modal status / supersedes chains); the adapter records this lossiness in result.extensions.',
    method: 'POST',
    targetTemplate: '{base}/lpc/project_to_lrs',
    inputs: [
      { name: 'descriptor_iri', type: 'string', required: true, description: 'IRI of the lpc:LearningExperience descriptor to project.' },
      { name: 'target_lrs_url', type: 'string', required: true, description: 'Statements endpoint of the target LRS.' },
      { name: 'lrs_auth_header', type: 'string', required: true, description: 'Authorization header for the LRS (typically Basic).' },
      { name: 'learner_consent_descriptor_iri', type: 'string', required: true, description: 'IRI of the per-graph share_with policy descriptor on the learner\'s pod authorizing this projection.' },
    ],
  },
];

/**
 * Declared (not yet implemented) affordance surface for the enterprise
 * edtech professional audience. The bridge does NOT auto-register these
 * — adding them to `lpcAffordances` (above) would create tools that
 * 404. Until an institutional bridge ships, these IRIs and input
 * schemas are the design contract for the next implementer.
 */
export const lpcEnterpriseAffordances = LPC_ENTERPRISE_AFFORDANCES;
