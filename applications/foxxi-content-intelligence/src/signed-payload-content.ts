/**
 * What each signed affordance's payload holds, as schema.
 *
 * ★ WHY THIS FILE. A signed affordance takes two strings, `_signed_payload` and `_signature`.
 * What goes inside the payload was written as prose in the input's description, so a client that
 * followed the descriptor to the right address still had to be told, or parse a sentence, to know
 * what to send. Four affordances said it in schema on 2026-11-26 (`content` on the input, emitted
 * as JSON Schema's `contentMediaType` and `contentSchema`). This file says it for the rest, so a
 * client that knows nothing about Foxxi can drive every signed affordance from the descriptor.
 *
 * Each entry was written from the route that reads the payload, not from the prose: where the
 * route reads a field the sentence did not name (`source` on the record review, `evidence_shape`
 * on a performance record), the field is here. tests/a-signed-affordance-says-what-its-payload-
 * holds.test.ts holds each entry to the fields its description names, and to the fields the route
 * reads.
 *
 * A property here is flat: a nested value is `object` or `array`, with its shape in the
 * description. That is the limit of `AffordanceInputContent` today, not a choice about these
 * payloads.
 */
import type { Affordance, AffordanceInputContent } from '../../_shared/affordance-mcp/index.js';

type Props = AffordanceInputContent['properties'];

const SIGNER: Props = {
  agent_id: { type: 'string', description: 'The signer: a wallet DID, or the agent carrying a person\'s request. sign_request fills it.' },
  timestamp: { type: 'string', description: 'When it was signed, ISO 8601. sign_request fills it.' },
};
const OWN_POD: Props = {
  subject_pod_url: { type: 'string', description: 'The signer\'s own pod. The relay stamps it; it is accepted only when it is the signer\'s, and cannot name another pod.' },
};
const LEARNER_KIND: Props = {
  learner_kind: { type: 'string', enum: ['human', 'agent'], description: '"agent" when the signer is the learner as an agent: a delegate beside its person, or a wallet that is an agent with no person. Omit for a person.' },
};
const CLIENT_ID: Props = {
  client_id: { type: 'string', description: 'The OAuth client the relay\'s session token was issued to. The relay may add it; it is accepted and not read.' },
};
const ADMISSION: Props = {
  admission: { type: 'object', description: '{ kinds: [fragment kinds], because }: fragment kinds the learner admits beyond the default for this resolution, and why.' },
};

const signed = (properties: Props, required: readonly string[] = []): AffordanceInputContent =>
  ({ properties: { ...SIGNER, ...properties }, required: ['agent_id', 'timestamp', ...required] });

/** Keyed by toolName. */
export const SIGNED_PAYLOAD_CONTENT: Readonly<Record<string, AffordanceInputContent>> = {
  // ── xAPI Profile Server ──────────────────────────────────────────────────────────────────
  'foxxi.xapi_profile_add': signed({
    profile: { type: 'object', description: 'The profile document itself, xAPI Profiles 1.0 JSON-LD. Send this or uri, exactly one.' },
    uri: { type: 'string', description: 'The https address the profile is published at, on a host this deployment fetches from. Send this or profile, exactly one.' },
  }),
  'foxxi.xapi_profile_remove': signed({
    iri: { type: 'string', description: 'The IRI of the profile, or of one version of it, to take down.' },
  }, ['iri']),
  'foxxi.xapi_profile_draft': signed({
    profile: { type: 'string', description: 'The profile IRI of the draft. Left out, the answer lists the drafts the signer has open.' },
    version: { type: 'string', description: 'The IRI of the version being written.' },
    document: { type: 'object', description: 'Replaces the whole profile document, xAPI Profiles 1.0 JSON-LD.' },
    set: { type: 'object', description: 'Profile-level fields to set: prefLabel, definition, seeAlso, author, conformsTo.' },
    put: { type: 'object', description: '{ concepts, templates, patterns }: each entry is added, or replaces the one with its id.' },
    remove: { type: 'array', description: 'Ids of concepts, templates, patterns or examples to remove.' },
    examples: { type: 'object', description: '{ statements: [{ id?, follows: [template IRIs], statement }], sequences: [{ id?, pattern, statements }], replace? }. Kept beside the profile; public once published.' },
    external: { type: 'array', description: 'Terms another publisher defines that the templates name: [{ id, type }].' },
    discard: { type: 'boolean', description: 'True to discard the draft.' },
  }),
  'foxxi.xapi_profile_lint': signed({
    profile: { type: 'string', description: 'The profile IRI of the signer\'s draft to lint. Send this, or document.' },
    document: { type: 'object', description: 'A profile document to lint without a draft. Send this, or profile.' },
    examples: { type: 'object', description: 'With document: { statements: [...], sequences: [...] } to check the document against.' },
    external: { type: 'array', description: 'With document: terms another publisher defines, [{ id, type }].' },
  }),
  'foxxi.xapi_profile_publish': signed({
    profile: { type: 'string', description: 'The profile IRI of the signer\'s draft to publish.' },
  }, ['profile']),

  // ── Private performance evidence (own encrypted pod) ─────────────────────────────────────
  'foxxi.record_private_performance_outcome': signed({
    outcome: { type: 'object', description: '{ episode_id, plan_id, plan_sha256, intervention: { type, delivered, artifact: { uri, version, sha256 }, delivered_at }, post, fresh?, assistance, observed_at }. The full schema is in this input\'s description.' },
    ...OWN_POD, ...CLIENT_ID,
  }, ['outcome']),
  'foxxi.read_private_performance_outcomes': signed({
    episode_id: { type: 'string', description: 'One learner/intervention episode to read. Left out, every episode of the signer\'s is read.' },
    ...OWN_POD, ...CLIENT_ID,
  }),
  'foxxi.read_private_performance_calibration': signed({ ...OWN_POD, ...CLIENT_ID }),

  // ── Credentials a learner earns and claims ───────────────────────────────────────────────
  'foxxi.earned_credentials_signed': signed({
    course_ids: { type: 'array', description: 'Course ids to read standings for. Left out, every course the learner has a record in.' },
    ...LEARNER_KIND,
  }),
  'foxxi.claim_credential_signed': signed({
    course_id: { type: 'string', description: 'The course whose credential is claimed, on the learner\'s own evidence.' },
    ...LEARNER_KIND,
  }, ['course_id']),

  // ── cmi5 personal launch links ───────────────────────────────────────────────────────────
  'foxxi.cmi5_personal_launch': signed({
    course_id: { type: 'string', description: 'A cmi5 course published on this bridge.' },
    au_id: { type: 'string', description: 'One assignable unit of the course to open. Left out, the course decides.' },
    return_url: { type: 'string', description: 'Where the unit sends the learner when it ends (cmi5 returnURL).' },
    expires_in_days: { type: 'integer', description: 'A whole number of days, 1 to 3650, or null for no expiry. Left out: 90 days.' },
    launch_parameters: { type: 'string', description: 'Replaces the course structure\'s launchParameters on every open (cmi5 10.2.3). Null clears it.' },
  }, ['course_id']),
  'foxxi.cmi5_personal_launch_revoke': signed({
    token: { type: 'string', description: 'The link\'s token, or its full URL.' },
  }, ['token']),
  'foxxi.cmi5_personal_launch_list': signed({}),

  // ── Hosting a package, LTI ───────────────────────────────────────────────────────────────
  'foxxi.host_package_signed': signed({
    zip_base64: { type: 'string', description: 'The SCORM or cmi5 package, a zip, base64-encoded.' },
    hinted_title: { type: 'string', description: 'A display name for the package, used when it declares none.' },
  }, ['zip_base64']),
  'foxxi.lti_launch_signed': signed({
    course_id: { type: 'string', description: 'A course this bridge\'s SCORM engine grades.' },
    ...LEARNER_KIND,
  }, ['course_id']),
  'foxxi.lti_gradebook_signed': signed({ ...LEARNER_KIND }),
  'foxxi.lti_reconciliation_preview_signed': signed({
    subject_did: { type: 'string', description: 'The verified controlling user DID whose record is reconciled.' },
    purpose: { type: 'string', enum: ['personal-performance'], description: 'Always personal-performance.' },
    originalStatementIds: { type: 'array', description: 'Exactly two original statement UUIDs to reconcile.' },
  }, ['subject_did', 'purpose', 'originalStatementIds']),
  'foxxi.lti_reconciliation_apply_signed': signed({
    subject_did: { type: 'string', description: 'The verified controlling user DID whose record is reconciled.' },
    purpose: { type: 'string', enum: ['personal-performance'], description: 'Always personal-performance.' },
    planToken: { type: 'string', description: 'The exact private token the preview answered with.' },
    intent: { type: 'string', enum: ['create-reconciled-lms-entry'], description: 'Always create-reconciled-lms-entry.' },
  }, ['subject_did', 'purpose', 'planToken', 'intent']),
  'foxxi.lti_reconciliation_read_signed': signed({
    subject_did: { type: 'string', description: 'The verified controlling user DID whose record is read.' },
    purpose: { type: 'string', enum: ['personal-performance'], description: 'Always personal-performance.' },
    entryId: { type: 'string', description: 'The entry\'s identifier: 64 lowercase hex characters (a SHA-256).' },
  }, ['subject_did', 'purpose', 'entryId']),

  'foxxi.consume_lesson': signed({
    action: { type: 'string', enum: ['foxxi.consume_lesson'], description: 'Always foxxi.consume_lesson.' },
    bridge_audience: { type: 'string', description: 'The exact origin of this bridge, without a trailing slash, taken from this manifest\'s own authority.' },
    course_iri: { type: 'string', description: 'The published CoursePackageBundle\'s federation_iri_base followed by #package.' },
    tenant_pod_url: { type: 'string', description: 'Optional corroboration of the signer\'s own pod; it cannot select another pod.' },
    learner_did: { type: 'string', description: 'Optional; must equal the verified signer.' },
    mode: { type: 'string', enum: ['load', 'record-progress'], description: 'load (the default) reads the lesson; record-progress records slides advanced.' },
    advanced_slide_ids: { type: 'array', description: 'For record-progress: the ids of the slides advanced, 1 to 10000, each once.' },
    owner_encryption_key: { type: 'string', description: 'For record-progress: the owner\'s base64 X25519 public key, bound by this signature.' },
  }, ['action', 'bridge_audience', 'course_iri']),

  // ── A learner's record, credentials and proofs ───────────────────────────────────────────
  'foxxi.review_record': signed({
    subject_did: { type: 'string', description: 'Whose record to review. Left out, the signer\'s own.' },
    read_pod_url: { type: 'string', description: 'The pod to read the subject\'s record from, when it is not the one their DID resolves to.' },
    subject_name: { type: 'string', description: 'A display name for the subject in the answer.' },
    actor_kind: { type: 'string', enum: ['human', 'agent'], description: 'Used only when the signer reads their own record and it does not already show an agent: "agent" then reads it as an agent\'s. Another subject\'s kind comes from their own signed statements.' },
    source: { type: 'string', enum: ['pgsl'], description: '"pgsl" reads the statements from the subject\'s lattice. Left out, they are read from the record store.' },
    include_clr: { type: 'boolean', description: 'False leaves the Comprehensive Learner Record out. Left out, it is included.' },
    projection: { type: 'string', enum: ['links', 'inline'], description: 'links (the default) answers the judgement with evidence as references; inline embeds every record and grows with the history.' },
    ...OWN_POD,
  }),
  'foxxi.issue_credential': signed({
    recipient_did: { type: 'string', description: 'The DID the credential is issued to.' },
    competency_name: { type: 'string', description: 'The name of the competency the credential attests.' },
    recipient_pod_url: { type: 'string', description: 'The recipient\'s pod, when it is not the one their DID resolves to.' },
    recipient_name: { type: 'string', description: 'A display name for the recipient.' },
    competency_id: { type: 'string', description: 'The competency\'s IRI in its framework.' },
    competency_framework: { type: 'string', description: 'The IRI of the framework the competency belongs to.' },
    achievement_description: { type: 'string', description: 'What the achievement is, in a sentence or two.' },
    criterion: { type: 'string', description: 'What had to be shown to earn it, as narrative.' },
    evidence: { type: 'array', description: 'Evidence entries the credential cites, each with an id and a narrative.' },
    justified_by: { type: 'string', description: 'The IRI of the record or decision that justifies issuing it.' },
  }, ['recipient_did', 'competency_name']),
  'foxxi.verify_extension': signed({
    subject_did: { type: 'string', description: 'Whose record the extension is checked against.' },
    name: { type: 'string', description: 'The extension\'s name. Giving it runs the shape-conformance check.' },
    kind: { type: 'string', description: 'The kind of extension. Left out: XapiContextExtension.' },
    definition: { type: 'string', description: 'What the extension means, in a sentence.' },
    actor_kind: { type: 'string', enum: ['human', 'agent'], description: 'Used only when the signer reads their own record and it does not already show an agent: "agent" then reads it as an agent\'s. Another subject\'s kind comes from their own signed statements.' },
    read_pod_url: { type: 'string', description: 'The pod to read the subject\'s record from, when it is not the one their DID resolves to.' },
    ...OWN_POD,
  }, ['subject_did']),
  'foxxi.prove_competency_signed': signed({
    tenant_pod_url: { type: 'string', description: 'The pod holding the holder\'s record.' },
    competency_name: { type: 'string', description: 'The competency to prove. The holder\'s record must assert it.' },
    learner_did: { type: 'string', description: 'The holder. Left out, the signer.' },
    learner_name: { type: 'string', description: 'A display name for the holder.' },
    course_id: { type: 'string', description: 'The course the competency was demonstrated in, to narrow the record.' },
    reveal_paths: { type: 'array', description: 'Claim paths to disclose. Left out: issuer, achievement.name, achievement.proficiencyLevel.' },
    presentation_context: { type: 'string', description: 'Binds the proof to one occasion; a verifier must echo it back or the proof does not verify.' },
  }, ['tenant_pod_url', 'competency_name']),
  'foxxi.self_assert_competency': signed({
    competency_name: { type: 'string', description: 'The competency the signer asserts of itself.' },
    reveal: { type: 'array', description: 'Claim paths to disclose. Left out: issuer, achievement.name, achievement.proficiencyLevel.' },
    issuer_did: { type: 'string', description: 'Not needed. If given it must be the signer; any other issuer is refused with 403.' },
  }, ['competency_name']),
  'foxxi.verify_presentation': signed({
    presentation: { type: 'object', description: '{ proof, disclosedIndexes, disclosedMessages, issuerPublicKey, issuerDid }: the presentation foxxi.prove_competency answered with.' },
  }, ['presentation']),
  'foxxi.void_credential': signed({
    descriptor_url: { type: 'string', description: 'A CLR entry\'s sourceDescriptor under the signer\'s own pod.' },
    ...OWN_POD,
  }, ['descriptor_url']),
  'foxxi.publish_encryption_key': signed({
    public_key: { type: 'string', description: 'The signer\'s base64 X25519 public key (X25519-XSalsa20-Poly1305).' },
    ...OWN_POD,
  }, ['public_key']),

  // ── Performance and completion records ───────────────────────────────────────────────────
  'foxxi.record_performance_signed': signed({
    task_name: { type: 'string', description: 'The name of the task that was performed.' },
    success: { type: 'boolean', description: 'Whether the task succeeded.' },
    activity_type: { type: 'string', description: 'The xAPI activity type IRI of the task.' },
    task_id: { type: 'string', description: 'The task\'s IRI. Left out, one is made from task_name.' },
    quality: { type: 'number', description: 'How well it was done, from -1 to 1.' },
    duration_iso: { type: 'string', description: 'How long it took, as an ISO 8601 duration.' },
    actor_kind: { type: 'string', enum: ['agent', 'human'], description: 'Who performed it. Left out: agent.' },
    cost_usd: { type: 'number', description: 'What the performance cost, in US dollars.' },
    recipients: { type: 'array', description: 'Pod URLs or DIDs the encrypted record is also wrapped to.' },
    trajectory: { type: 'object', description: '{ steps: [{ modalStatus, granularity, verb, objectId, objectName, id?, parentId?, supersedesId?, result?, recordedAt? }] }, at most 100 steps.' },
    evidence_shape: { type: 'string', description: 'The IRI of the shape the record\'s evidence conforms to.' },
    ...OWN_POD,
  }, ['task_name', 'success']),
  'foxxi.ingest_course': signed({
    parsed: { type: 'object', description: 'A ParsedFoxxiPackage: { courseId, title, modules: [{ id, title, lessons: [{ id, title, competency, fragments: [{ modality, body, level }] }] }] }.' },
    tenant_pod_url: { type: 'string', description: 'An older name for subject_pod_url, read when that is absent.' },
    ...OWN_POD,
  }, ['parsed']),
  'foxxi.record_course_completion': signed({
    course_id: { type: 'string', description: 'The course that was completed.' },
    course_title: { type: 'string', description: 'The course\'s title, for the record.' },
    score_scaled: { type: 'number', description: 'The scaled score, 0 to 1. It must be at least mastery_score. Left out: 1.' },
    mastery_score: { type: 'number', description: 'The score that counts as passed. Left out: 0.7.' },
    duration_iso: { type: 'string', description: 'How long it took, as an ISO 8601 duration.' },
    registration: { type: 'string', description: 'The registration UUID the statements are said under. Left out, a new one.' },
    ...OWN_POD,
  }, ['course_id']),

  // ── Forwarding and xAPI statements ───────────────────────────────────────────────────────
  'foxxi.forwarding_targets': signed({
    targets: { type: 'array', description: 'Targets to add or update: [{ endpoint, credentials, label?, version?, enabled? }]. credentials is the downstream LRS "user:pass".' },
    delete: { type: 'array', description: 'Ids of targets to remove.' },
  }),
  'foxxi.credentials': signed({
    credentials: { type: 'array', description: 'Inbound credentials to add: [{ principal, secret, label? }], the "user:pass" an upstream presents on /xapi/statements.' },
    revoke: { type: 'array', description: 'Ids of inbound credentials to revoke.' },
  }),
  'foxxi.write_xapi_statements_signed': signed({
    statements: { type: 'array', description: 'xAPI statements to write: [{ id, actor, verb, object, timestamp, result?, context? }]. Each timestamp is when its activity happened.' },
    ...OWN_POD,
  }, ['statements']),
  'foxxi.read_xapi_statements_signed': signed({
    query: { type: 'object', description: '{ statementId?, verb?, activity?, registration?, since?, until?, ascending?, limit?, cursor? }. Left out, the most recent statements.' },
    ...OWN_POD,
  }),
  'foxxi.write_own_subject_xapi_statements_signed': signed({
    subject_did: { type: 'string', description: 'The verified controlling user DID the statements are about.' },
    purpose: { type: 'string', enum: ['personal-performance'], description: 'Always personal-performance.' },
    statements: { type: 'array', description: 'xAPI statements to write: [{ id, actor, verb, object, timestamp, result?, context? }]. Each timestamp is when its event was observed.' },
    ...OWN_POD, ...CLIENT_ID,
  }, ['subject_did', 'purpose', 'statements']),
  'foxxi.read_own_subject_xapi_statements_signed': signed({
    subject_did: { type: 'string', description: 'The verified controlling user DID the statements are about.' },
    purpose: { type: 'string', enum: ['personal-performance'], description: 'Always personal-performance.' },
    query: { type: 'object', description: '{ statementId }, or filters: verb, activity, registration, since, until, ascending, limit, cursor.' },
    ...OWN_POD, ...CLIENT_ID,
  }, ['subject_did', 'purpose', 'query']),
  'foxxi.publish_memory': signed({
    title: { type: 'string', description: 'The title of the job aid or quick reference.' },
    body: { type: 'string', description: 'Its content, as Markdown.' },
    kind: { type: 'string', enum: ['job-aid', 'quick-reference'], description: 'Which it is. Left out: job-aid.' },
  }, ['title', 'body']),

  // ── Composable content ───────────────────────────────────────────────────────────────────
  'foxxi.content_fragment': signed({
    fragment: { type: 'object', description: '{ kind, level?, competencies: [competency IRI, term IRI or slug], title?, body, questions?, audience?: human|agent, suits?: [tag], language? }. body is Markdown, up to 20000 characters.' },
    ...OWN_POD,
  }, ['fragment']),
  'foxxi.content_compose': signed({
    composition: { type: 'object', description: '{ title, competency, positions: [{ competency, demonstratedAt?: 1-5, paradigm: [fragment or composition IRIs, 1-12] }], supersedes? }. At most 100 positions.' },
    ...OWN_POD,
  }, ['composition']),
  'foxxi.content_fold_course': signed({
    course_id: { type: 'string', description: 'A course on this bridge to fold. Send one of course_id, course or package_sha256.' },
    course: { type: 'object', description: 'An emergent course to fold. Send one of course_id, course or package_sha256.' },
    package_sha256: { type: 'string', description: 'A hosted package to fold, by the sha-256 it is listed under. Send one of course_id, course or package_sha256.' },
    competency: { type: 'string', description: 'What the course or package develops: a competency IRI, another authority\'s term IRI, or a slug.' },
    section_competencies: { type: 'object', description: 'With course_id: { <section id>: competency } where a section\'s own differs.' },
    topic_competencies: { type: 'object', description: 'With package_sha256: { <topic id>: competency }; a topic\'s id is its folder.' },
    level: { type: 'string', enum: ['foundational', 'working', 'applied', 'advanced'], description: 'The level of what is folded. Left out: working.' },
    language: { type: 'string', description: 'The language of the content, as a BCP 47 tag.' },
    ...OWN_POD,
  }),
  'foxxi.content_resolve': signed({
    composition: { type: 'string', description: 'The IRI of the composition to resolve for the learner.' },
    ...ADMISSION, ...LEARNER_KIND,
  }, ['composition']),
  'foxxi.content_launch': signed({
    composition: { type: 'string', description: 'The IRI of the composition to resolve and start playing.' },
    ...ADMISSION, ...LEARNER_KIND,
  }, ['composition']),
  'foxxi.content_admit': signed({
    competency: { type: 'string', description: 'A competency IRI, another authority\'s term IRI, or a slug.' },
    admission: { type: 'object', description: '{ kinds: [fragment kinds], because } to keep as standing for this competency, or null to withdraw it.' },
    source: { type: 'string', description: 'The IRI of the plan or situation the admission came from.' },
    regime: { type: 'string', enum: ['Evident', 'Knowable', 'Emergent', 'Turbulent'], description: 'The regime of the situation it came from.' },
  }, ['competency', 'admission']),
  'foxxi.content_admissions': signed({}),
  'foxxi.content_mine': signed({
    limit: { type: 'integer', description: 'At most how many of each to list, 1 to 200. Left out: 50.' },
  }),
  'foxxi.content_next': signed({
    session_id: { type: 'string', description: 'The session foxxi.content_launch answered with.' },
    expected_step: { type: 'integer', description: 'The one-based step.step received. Keep it unchanged on retries so a lost acknowledgement is replayed, not re-applied.' },
    answers: { type: 'array', description: 'One string per question of the step, in the formats foxxi.scorm_submit takes.' },
  }, ['session_id']),
  'foxxi.xapi_author': signed({
    course: { type: 'object', description: '{ title, competency, modules: [{ title, competency?, lessons: [{ title, competency?, fragments: [...] }] }], supersedes? }. Fragments take the form foxxi.content_fragment takes.' },
    ...OWN_POD,
  }, ['course']),

  // ── The SCORM engine ─────────────────────────────────────────────────────────────────────
  'foxxi.scorm_author': signed({
    course: { type: 'object', description: '{ courseId, title, masteryScore?, scos: [{ id, title, body, assessment?: [question] }] }. body is Markdown; at most 100 sections and 40 questions a section.' },
    ...OWN_POD,
  }, ['course']),
  'foxxi.scorm_launch': signed({
    course_id: { type: 'string', description: 'The course to start an attempt at.' },
    author_did: { type: 'string', description: 'The DID of the course\'s author, when it is not the signer\'s own course.' },
    course_pod: { type: 'string', description: 'The pod the course is kept on, when the author\'s DID does not resolve to it.' },
    ...LEARNER_KIND, ...OWN_POD,
  }, ['course_id']),
  'foxxi.scorm_submit': signed({
    session_id: { type: 'string', description: 'The session foxxi.scorm_launch answered with.' },
    answers: { type: 'array', description: 'For an assessment SCO: one string per question, in order. Left out for a SCO with no questions.' },
  }, ['session_id']),
  'foxxi.scorm_dispatch': signed({
    course_id: { type: 'string', description: 'The signer\'s course to dispatch.' },
    title: { type: 'string', description: 'A title for the dispatch. Left out, the course\'s.' },
    expires_at: { type: 'string', description: 'When the dispatch stops launching: an ISO 8601 instant in the future.' },
    launch_limit: { type: 'integer', description: 'How many launches it allows: a whole number, at least 1.' },
  }, ['course_id']),
  'foxxi.scorm_dispatch_revoke': signed({
    dispatch_id: { type: 'string', description: 'The id of the dispatch to revoke.' },
  }, ['dispatch_id']),
  'foxxi.scorm_dispatches': signed({
    course_id: { type: 'string', description: 'List only the dispatches of this course. Left out, all of the signer\'s.' },
  }),
};

/**
 * An affordance with its signed payload described, when this file describes it and the
 * affordance's own declaration does not.
 */
export function withSignedPayloadContent(a: Affordance): Affordance {
  const content = SIGNED_PAYLOAD_CONTENT[a.toolName];
  if (!content || !a.inputs.some(i => i.name === '_signed_payload' && !i.content)) return a;
  return { ...a, inputs: a.inputs.map(i => (i.name === '_signed_payload' && !i.content ? { ...i, content } : i)) };
}
