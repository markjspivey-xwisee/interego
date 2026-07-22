import { FOXXI_NS } from './foxxi-vocab.js';
// Re-exported: xapi-instrumentation.ts has always imported FOXXI_NS from here, and
// that stays true — but the string is DEFINED once, in foxxi-vocab.ts. This module
// used to declare its own copy of it, which is how the namespace drifted onto a dead
// host in 18 places without anyone noticing.
export { FOXXI_NS } from './foxxi-vocab.js';
/**
 * Foxxi xAPI Profile — proper xAPI Profile Specification (ADL 2017) shape.
 *
 * A profile is a JSON-LD document with three principal sections:
 *
 *   concepts   — Verbs, ActivityTypes, Extensions, AttachmentUsageTypes,
 *                Document Resource types this profile defines.
 *   templates  — Statement templates: shapes of valid statements,
 *                each with mandatory + recommended + optional properties
 *                drawn from the concept set above. Used to validate
 *                statements coming through Foxxi-as-LRS and to instrument
 *                the bridge handlers.
 *   patterns   — Sequences of templates: the legal orderings in which
 *                statements may appear. The course-completion pattern
 *                is `(launched, initialized, slide-viewed+, scene-completed*,
 *                completed, passed, terminated)`.
 *
 * Profile spec: https://github.com/adlnet/xapi-profiles
 * JSON-LD context: https://w3id.org/xapi/profiles/context
 *
 * Learning-engineer notes (why these specific shapes):
 *  - Single course = one Activity; each slide is a child Activity with
 *    parent=course in contextActivities. Concept-graph traces (asked /
 *    retrieved) bind the LearnerQuestionEvent + RetrievalActivity
 *    descriptors that the substrate already produces.
 *  - Mastery threshold is recorded on the `passed` template's context
 *    extension so an LRS-side adaptive policy can fire on a moveOn
 *    decision (cmi5 §11). Default 0.7; configurable per-course later.
 *  - Bridge-handler emissions use the `affordance-invoked` template so
 *    every call to the bridge lands as one xAPI statement, replayable
 *    against the same LRS.
 */

// The xAPI Profile's identity IRI IS the URL it is served at — the
// bridge serves the profile document at `<bridge>/xapi/profile`, so the
// profile's `id` dereferences to itself. Its `templates/*`, `patterns/*`
// and `v/*` children resolve under it (the bridge serves those too).
export const FOXXI_PROFILE_ID = 'https://foxxi-bridge.interego.xwisee.com/xapi/profile';

const ADL = 'http://adlnet.gov/expapi';
const CMI5 = 'https://w3id.org/xapi/cmi5';
// The cmi5-defined verbs satisfied/abandoned/waived are canonically at
// https://w3id.org/xapi/adl/verbs/* — the SAME IRIs the cmi5 emitters use. Declaring
// them here (not at adlnet.gov) keeps the profile's concept set == what the LRS stores.
const ADLW3 = 'https://w3id.org/xapi/adl/verbs';

// ── Concepts ────────────────────────────────────────────────────────

const verbs = [
  { id: `${ADL}/verbs/launched`,    prefLabel: { en: 'launched' },    definition: { en: 'cmi5 launch verb — the LMS launched an AU / course' } },
  { id: `${ADL}/verbs/initialized`, prefLabel: { en: 'initialized' }, definition: { en: 'cmi5 initialized verb — AU declared initialization' } },
  { id: `${ADL}/verbs/experienced`, prefLabel: { en: 'experienced' }, definition: { en: 'xAPI core verb — learner experienced (viewed / interacted with) an Activity. Used for slide views.' } },
  { id: `${ADL}/verbs/completed`,   prefLabel: { en: 'completed' },   definition: { en: 'cmi5 completed verb — learner reached the end of the AU' } },
  { id: `${ADL}/verbs/passed`,      prefLabel: { en: 'passed' },      definition: { en: 'cmi5 passed verb — score met or exceeded mastery threshold' } },
  { id: `${ADL}/verbs/failed`,      prefLabel: { en: 'failed' },      definition: { en: 'cmi5 failed verb — score fell below mastery threshold' } },
  { id: `${ADLW3}/satisfied`,       prefLabel: { en: 'satisfied' },   definition: { en: 'cmi5 satisfied verb — moveOn condition met (see cmi5 §11)' } },
  { id: `${ADL}/verbs/terminated`,  prefLabel: { en: 'terminated' },  definition: { en: 'cmi5 terminated verb — session ended cleanly' } },
  { id: `${ADLW3}/abandoned`,       prefLabel: { en: 'abandoned' },   definition: { en: 'cmi5 abandoned verb — session ended unexpectedly (session_timeout, browser close)' } },
  { id: `${ADLW3}/waived`,          prefLabel: { en: 'waived' },      definition: { en: 'cmi5 waived verb — administrator excused the requirement' } },
  { id: `${ADL}/verbs/voided`,      prefLabel: { en: 'voided' },      definition: { en: 'xAPI voiding verb — annuls a prior Statement' } },
  // Foxxi extensions
  { id: `${FOXXI_NS}verbs/scene-completed`,    prefLabel: { en: 'scene-completed' },    definition: { en: 'Foxxi extension — every slide in a course scene has been viewed' } },
  { id: `${FOXXI_NS}verbs/asked`,              prefLabel: { en: 'asked' },              definition: { en: 'Foxxi extension — learner asked a content question to the concept-graph agentic retriever' } },
  { id: `${FOXXI_NS}verbs/retrieved`,          prefLabel: { en: 'retrieved' },          definition: { en: 'Foxxi extension — concept-graph retrieval traced a set of slides / concepts as evidence for an answer' } },
  { id: `${FOXXI_NS}verbs/enrolled`,           prefLabel: { en: 'enrolled' },           definition: { en: 'Foxxi extension — learner matched a tenant policy and was assigned a course' } },
  { id: `${FOXXI_NS}verbs/authored`,           prefLabel: { en: 'authored' },           definition: { en: 'Foxxi extension — an agent authored a learning artifact (a course, an xAPI Profile fragment, a standards extension). The teacher/author\'s own work, recorded as first-class activity.' } },
  { id: `${FOXXI_NS}verbs/credentialed`,       prefLabel: { en: 'credentialed' },       definition: { en: 'Foxxi extension — an Open Badges 3.0 / W3C VC credential was issued for the learner' } },
  { id: `${FOXXI_NS}verbs/wallet-exported`,    prefLabel: { en: 'wallet-exported' },    definition: { en: 'Foxxi extension — learner exported a CLR 2.0 envelope from their pod' } },
  { id: `${FOXXI_NS}verbs/framework-aligned`,  prefLabel: { en: 'framework-aligned' },  definition: { en: 'Foxxi extension — admin declared a CASE 1.0 cross-tenant alignment association' } },
  { id: `${FOXXI_NS}verbs/policy-decided`,     prefLabel: { en: 'policy-decided' },     definition: { en: 'Foxxi extension — ABAC policy returned an access decision (allow / deny) for a substrate call' } },
  { id: `${FOXXI_NS}verbs/affordance-invoked`, prefLabel: { en: 'affordance-invoked' }, definition: { en: 'Foxxi extension — a bridge affordance was called (instrumented every handler)' } },
  // Performance verb (IEEE P2997) — every agent substrate act projects as this.
  { id: `${FOXXI_NS}performed`, prefLabel: { en: 'performed' }, definition: { en: 'A unit of on-the-job production work was performed by a human or an AI agent. The single principled performance verb every substrate activity projects to — what was done is carried by the object type (the descriptor\'s own conformsTo), never by a domain verb.' } },
  // Structural (modal) verbs — name the MODAL MODE of any agent's context-descriptor
  // act (iep:ModalStatusEnum), domain-agnostic. These label the agentic-native
  // trajectory step; the xAPI statement verb itself is always `performed` (or the
  // ADL `voided` verb for a Retracted descriptor).
  { id: `${FOXXI_NS}verbs/asserted`,   prefLabel: { en: 'asserted' },   definition: { en: 'An agent asserted a settled context descriptor (modal status Asserted).' } },
  { id: `${FOXXI_NS}verbs/intended`,   prefLabel: { en: 'intended' },   definition: { en: 'An agent recorded a Hypothetical context descriptor — an intention/plan.' } },
  { id: `${FOXXI_NS}verbs/considered`, prefLabel: { en: 'considered' }, definition: { en: 'An agent recorded a Counterfactual/Retracted context descriptor — a road not taken / withdrawn claim.' } },
] as const;

const activityTypes = [
  { id: `${ADL}/activities/course`,     prefLabel: { en: 'course' },     definition: { en: 'A course as a top-level instructional unit' } },
  { id: `${ADL}/activities/lesson`,     prefLabel: { en: 'lesson' },     definition: { en: 'A lesson — child of a course; equates to a Foxxi slide' } },
  { id: `${ADL}/activities/assessment`, prefLabel: { en: 'assessment' }, definition: { en: 'An assessment activity (quiz / question)' } },
  { id: `${FOXXI_NS}activities/scene`,            prefLabel: { en: 'scene' },            definition: { en: 'Foxxi extension — a course scene grouping multiple slides under a sub-theme' } },
  { id: `${FOXXI_NS}activities/concept-graph-node`, prefLabel: { en: 'concept-graph-node' }, definition: { en: 'Foxxi extension — a single concept in the course\'s knowledge graph; carries prereq edges + slide-membership' } },
  { id: `${FOXXI_NS}activities/credential`,       prefLabel: { en: 'credential' },       definition: { en: 'Foxxi extension — a Verifiable Credential / Open Badge 3.0' } },
  { id: `${FOXXI_NS}activities/framework`,        prefLabel: { en: 'framework' },        definition: { en: 'Foxxi extension — a CASE 1.0 / CaSS competency framework' } },
  { id: `${FOXXI_NS}activities/affordance`,       prefLabel: { en: 'affordance' },       definition: { en: 'Foxxi extension — a bridge affordance / MCP tool, identified by toolName' } },
  // Generic fallback object type — the object of a projected performance
  // statement is normally the descriptor's OWN conformsTo IRI (e.g. ttt:Move,
  // code:PullRequest, med:Diagnosis) passed through verbatim; this names the
  // ENVELOPE act when the publisher declared no type. Foxxi never enumerates an
  // application's activity types.
  { id: `${FOXXI_NS}AssertedContext`, prefLabel: { en: 'Asserted Context' }, definition: { en: 'A context-descriptor assertion whose payload type the publisher did not declare — the domain-agnostic fallback object type.' } },
  { id: `${FOXXI_NS}ProductionTask`, prefLabel: { en: 'Production Task' }, definition: { en: 'A unit of on-the-job production work recorded as an xAPI performance (the IEEE P2997 employment-history leg). The generic object type when the publisher declared no domain type; the ELR competency then keys off the task name.' } },
] as const;

const extensions = [
  { id: `${FOXXI_NS}slideId`,           prefLabel: { en: 'slideId' },           definition: { en: 'Identifier of the slide the statement is about' } },
  { id: `${FOXXI_NS}sceneTitle`,        prefLabel: { en: 'sceneTitle' },        definition: { en: 'Title of the scene grouping' } },
  { id: `${FOXXI_NS}conceptIds`,        prefLabel: { en: 'conceptIds' },        definition: { en: 'List of concept-graph node IDs referenced by the activity' } },
  { id: `${FOXXI_NS}masteryThreshold`,  prefLabel: { en: 'masteryThreshold' },  definition: { en: 'cmi5 mastery threshold applied to score.scaled for pass/fail decision (0.0 — 1.0)' } },
  { id: `${FOXXI_NS}session`,           prefLabel: { en: 'session' },           definition: { en: 'Foxxi session UUID — joins all statements from a single learner-launch' } },
  { id: `${FOXXI_NS}affordanceTool`,    prefLabel: { en: 'affordanceTool' },    definition: { en: 'MCP tool name of the invoked affordance (e.g. foxxi.ask_course_question_agentic)' } },
  { id: `${FOXXI_NS}policyId`,          prefLabel: { en: 'policyId' },          definition: { en: 'ABAC policy descriptor IRI that produced the decision' } },
  { id: `${FOXXI_NS}decision`,          prefLabel: { en: 'decision' },          definition: { en: 'ABAC decision — allow / deny' } },
  { id: `${FOXXI_NS}callerRole`,        prefLabel: { en: 'callerRole' },        definition: { en: 'Resolved caller role at the time of the affordance call (learner / admin / learning-engineer / manager)' } },
  { id: `${FOXXI_NS}substrateDescriptorIri`, prefLabel: { en: 'substrateDescriptorIri' }, definition: { en: 'IRI of the context descriptor on the substrate pod produced by this affordance call (cross-link xAPI ↔ substrate)' } },
  { id: `${FOXXI_NS}supersededDescriptor`, prefLabel: { en: 'supersededDescriptor' }, definition: { en: 'IRI of a prior descriptor this one revises/closes — the iep:supersedes structural revision link carried into xAPI (not a domain closure verb).' } },
  { id: `${FOXXI_NS}actorKind`,   prefLabel: { en: 'actorKind' },   definition: { en: 'Whether the actor is a human or an agent.' } },
  { id: `${FOXXI_NS}contextKind`, prefLabel: { en: 'contextKind' }, definition: { en: 'Whether a statement records production work, training, or performance-support.' } },
  { id: `${FOXXI_NS}trustLevel`, prefLabel: { en: 'trustLevel' }, definition: { en: 'The descriptor TrustFacet level (SelfAsserted / ThirdPartyAttested / CryptographicallyVerified), passed through verbatim.' } },
  { id: `${FOXXI_NS}epistemicConfidence`, prefLabel: { en: 'epistemicConfidence' }, definition: { en: 'Confidence [0.0-1.0] that the DESCRIPTOR itself is accurate (infrastructure-level), NOT a performance score — carried as its own extension, never as result.score.scaled.' } },
  { id: `${FOXXI_NS}groundTruth`, prefLabel: { en: 'groundTruth' }, definition: { en: 'Tri-state groundTruth (true Asserted / false Counterfactual / undefined Hypothetical), passed through verbatim.' } },
  { id: `${FOXXI_NS}endorsed`, prefLabel: { en: 'endorsed' }, definition: { en: 'False when the descriptor is Quoted (recorded with no endorsement).' } },
];

// ── Statement templates ─────────────────────────────────────────────

const templates = [
  {
    id: `${FOXXI_PROFILE_ID}/templates/launched`,
    prefLabel: { en: 'launched' },
    definition: { en: 'cmi5 launch — start of a course session. Required at the head of a course-session pattern.' },
    verb: `${ADL}/verbs/launched`,
    objectActivityType: `${ADL}/activities/course`,
    contextCategoryActivityType: [`${CMI5}/context/categories/cmi5`],
    rules: [
      { location: 'context.contextActivities.category[*].id', any: [`${CMI5}/context/categories/cmi5`] },
      { location: 'context.registration', presence: 'included' },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/initialized`,
    prefLabel: { en: 'initialized' },
    verb: `${ADL}/verbs/initialized`,
    objectActivityType: `${ADL}/activities/course`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/slide-viewed`,
    prefLabel: { en: 'slide-viewed' },
    definition: { en: 'A single slide / lesson was viewed by the learner. Carries the slide id and scene title.' },
    verb: `${ADL}/verbs/experienced`,
    objectActivityType: `${ADL}/activities/lesson`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'slideId"]', presence: 'included' },
      { location: 'context.contextActivities.parent[*].definition.type', any: [`${ADL}/activities/course`] },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/scene-completed`,
    prefLabel: { en: 'scene-completed' },
    verb: `${FOXXI_NS}verbs/scene-completed`,
    objectActivityType: `${FOXXI_NS}activities/scene`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/completed`,
    prefLabel: { en: 'completed' },
    verb: `${ADL}/verbs/completed`,
    objectActivityType: `${ADL}/activities/course`,
    rules: [
      { location: 'result.completion', presence: 'included' },
      { location: 'result.score.scaled', presence: 'recommended' },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/passed`,
    prefLabel: { en: 'passed' },
    verb: `${ADL}/verbs/passed`,
    objectActivityType: `${ADL}/activities/course`,
    rules: [
      { location: 'result.success', presence: 'included' },
      { location: 'result.score.scaled', presence: 'included' },
      { location: 'context.extensions["' + FOXXI_NS + 'masteryThreshold"]', presence: 'recommended' },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/terminated`,
    prefLabel: { en: 'terminated' },
    verb: `${ADL}/verbs/terminated`,
    objectActivityType: `${ADL}/activities/course`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/asked`,
    prefLabel: { en: 'asked-question' },
    definition: { en: 'Learner asked a content question to the Foxxi concept-graph agentic retriever.' },
    verb: `${FOXXI_NS}verbs/asked`,
    objectActivityType: `${FOXXI_NS}activities/concept-graph-node`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/retrieved`,
    prefLabel: { en: 'retrieval-trace' },
    verb: `${FOXXI_NS}verbs/retrieved`,
    objectActivityType: `${FOXXI_NS}activities/concept-graph-node`,
    // conceptIds is RECOMMENDED (not required): the generic affordance-instrumentation
    // envelope cannot always supply the retrieved node ids, so a retrieval trace
    // without them is still conformant.
    rules: [{ location: 'context.extensions["' + FOXXI_NS + 'conceptIds"]', presence: 'recommended' }],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/enrolled`,
    prefLabel: { en: 'enrolled' },
    verb: `${FOXXI_NS}verbs/enrolled`,
    objectActivityType: `${ADL}/activities/course`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/credentialed`,
    prefLabel: { en: 'credentialed' },
    verb: `${FOXXI_NS}verbs/credentialed`,
    objectActivityType: `${FOXXI_NS}activities/credential`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/affordance-invoked`,
    prefLabel: { en: 'affordance-invoked' },
    definition: { en: 'Generic envelope for any bridge affordance call. Carries the tool name, caller role, decision, and substrate descriptor link.' },
    verb: `${FOXXI_NS}verbs/affordance-invoked`,
    objectActivityType: `${FOXXI_NS}activities/affordance`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'affordanceTool"]', presence: 'included' },
      { location: 'context.extensions["' + FOXXI_NS + 'callerRole"]', presence: 'recommended' },
    ],
  },

  // ── Agent performance statement templates (domain-agnostic) ─────────
  // Every agent substrate act projects as ONE of these, regardless of which
  // application authored the descriptor. The verb is always `performed` (or the
  // ADL `voided` verb for a Retracted descriptor); WHAT was done is carried by
  // the object's activity type = the descriptor's OWN conformsTo IRI, never a
  // Foxxi-enumerated domain type. The transplant test holds: a tic-tac-toe move,
  // a code review, and a medical note all match these same templates.
  {
    id: `${FOXXI_PROFILE_ID}/templates/performed-descriptor`,
    prefLabel: { en: 'performed-descriptor' },
    definition: { en: 'An agent performed a unit of work by asserting a context descriptor. objectActivityType is unconstrained — it is the descriptor\'s own conformsTo IRI, passed through. Carries the substrate cross-link + actorKind=agent. No outcome is fabricated.' },
    verb: `${FOXXI_NS}performed`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'substrateDescriptorIri"]', presence: 'included' },
      { location: 'context.extensions["' + FOXXI_NS + 'actorKind"]', any: ['agent'] },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/intended-descriptor`,
    prefLabel: { en: 'intended-descriptor' },
    definition: { en: 'A Hypothetical context descriptor projects as an `intended` act — the agent recorded an intention/plan, not a settled performance. The verb is the structural MODAL verb derived from iep:modalStatus (GAP 5); WHAT is intended stays in the object\'s conformsTo, never a domain verb.' },
    verb: `${FOXXI_NS}verbs/intended`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'substrateDescriptorIri"]', presence: 'included' },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/considered-descriptor`,
    prefLabel: { en: 'considered-descriptor' },
    definition: { en: 'A Counterfactual context descriptor projects as a `considered` act — a road not taken / withdrawn alternative. The verb is the structural MODAL verb derived from iep:modalStatus (GAP 5).' },
    verb: `${FOXXI_NS}verbs/considered`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'substrateDescriptorIri"]', presence: 'included' },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/superseding-descriptor`,
    prefLabel: { en: 'superseding-descriptor' },
    definition: { en: 'A performed-descriptor that revises/closes a prior one — carries the iep:supersedes link as supersededDescriptor + contextActivities.other. Domain-agnostic: a code-review revision, a contract amendment, a resolution closing a finding, a game state superseding the prior — all the same structural arc.' },
    verb: `${FOXXI_NS}performed`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'supersededDescriptor"]', presence: 'included' },
      { location: 'context.extensions["' + FOXXI_NS + 'substrateDescriptorIri"]', presence: 'included' },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/voided-descriptor`,
    prefLabel: { en: 'voided-descriptor' },
    definition: { en: 'A Retracted context descriptor projects as an xAPI voiding statement targeting the statement for the descriptor it retracts (the protocol-native Retracted mapping).' },
    verb: `${ADL}/verbs/voided`,
    rules: [
      { location: 'object.objectType', any: ['StatementRef'] },
      { location: 'context.extensions["' + FOXXI_NS + 'substrateDescriptorIri"]', presence: 'included' },
    ],
  },

  // ── Production-performance outcome templates (ADL / MOM Level 1) ─────
  // A record_performance call projects the on-the-job outcome as a canonical MOM
  // verb — `completed` (success) or `failed` — never a coined verb. Domain-
  // agnostic: object.definition.type is the work's own conformsTo (or the
  // ProductionTask fallback). Marked by contextKind=production so the ELR reads
  // it as the IEEE P2997 employment leg, distinct from a course `completed`.
  {
    id: `${FOXXI_PROFILE_ID}/templates/production-performance-completed`,
    prefLabel: { en: 'production-performance (completed)' },
    definition: { en: 'A successful unit of on-the-job production work. MOM Level 1 `completed`. Does NOT pin an object activity type (the work carries its own domain conformsTo); instead it discriminates by REQUIRING context.extensions contextKind=production. This keeps it from over-matching a plain course completion — a course `completed` (no contextKind) fails this template\'s presence rule and must satisfy the course `completed` template (result.completion) instead. actorKind is recommended.' },
    verb: `${ADL}/verbs/completed`,
    rules: [
      // REQUIRED discriminator: without presence:'included' this rule is only value-checked
      // when present, which made the template a universal acceptor that OR-swallowed the
      // stricter course `completed` template (result.completion). It MUST be present AND
      // equal to 'production'.
      { location: 'context.extensions["' + FOXXI_NS + 'contextKind"]', presence: 'included', any: ['production'] },
      { location: 'context.extensions["' + FOXXI_NS + 'actorKind"]', presence: 'recommended' },
      // result.success is recommended (the emitter always sets it), but when present it
      // MUST be true for a `completed` — the `any` check fires on present values, so a
      // completed carrying success:false is rejected without hard-requiring the field.
      { location: 'result.success', presence: 'recommended', any: [true] },
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/templates/production-performance-failed`,
    prefLabel: { en: 'production-performance (failed)' },
    definition: { en: 'An unsuccessful unit of on-the-job production work. MOM Level 1 `failed`. Like its `completed` sibling it REQUIRES contextKind=production (so the whole `failed` verb is not vacuously conformant) and result.success=false — a bare `failed` with neither is correctly non-conformant.' },
    verb: `${ADL}/verbs/failed`,
    rules: [
      { location: 'context.extensions["' + FOXXI_NS + 'contextKind"]', presence: 'included', any: ['production'] },
      { location: 'context.extensions["' + FOXXI_NS + 'actorKind"]', presence: 'recommended' },
      { location: 'result.success', presence: 'recommended', any: [false] },
    ],
  },

  // ── Templates for the remaining declared+emitted verbs ──────────────
  // Profile spec §5.2: a Statement carrying a declared Verb MUST conform to at least
  // one Statement Template. Every verb the write path emits therefore needs a template
  // so "declared vocabulary == enforceable vocabulary" holds.
  { id: `${FOXXI_PROFILE_ID}/templates/satisfied`, prefLabel: { en: 'satisfied' }, definition: { en: 'cmi5 moveOn condition met.' }, verb: `${ADLW3}/satisfied`, objectActivityType: `${ADL}/activities/course` },
  { id: `${FOXXI_PROFILE_ID}/templates/abandoned`, prefLabel: { en: 'abandoned' }, definition: { en: 'cmi5 session ended unexpectedly.' }, verb: `${ADLW3}/abandoned`, objectActivityType: `${ADL}/activities/course` },
  { id: `${FOXXI_PROFILE_ID}/templates/waived`, prefLabel: { en: 'waived' }, definition: { en: 'cmi5 requirement waived by an administrator.' }, verb: `${ADLW3}/waived`, objectActivityType: `${ADL}/activities/course` },
  { id: `${FOXXI_PROFILE_ID}/templates/authored`, prefLabel: { en: 'authored' }, definition: { en: 'An agent authored a learning artifact (course / profile fragment / standards extension).' }, verb: `${FOXXI_NS}verbs/authored` },
  { id: `${FOXXI_PROFILE_ID}/templates/wallet-exported`, prefLabel: { en: 'wallet-exported' }, definition: { en: 'A learner exported a CLR 2.0 envelope from their pod.' }, verb: `${FOXXI_NS}verbs/wallet-exported`, objectActivityType: `${FOXXI_NS}activities/credential` },
  { id: `${FOXXI_PROFILE_ID}/templates/framework-aligned`, prefLabel: { en: 'framework-aligned' }, definition: { en: 'An admin declared a CASE 1.0 cross-tenant alignment.' }, verb: `${FOXXI_NS}verbs/framework-aligned`, objectActivityType: `${FOXXI_NS}activities/framework` },
  { id: `${FOXXI_PROFILE_ID}/templates/policy-decided`, prefLabel: { en: 'policy-decided' }, definition: { en: 'An ABAC policy returned an access decision.' }, verb: `${FOXXI_NS}verbs/policy-decided`, rules: [{ location: 'context.extensions["' + FOXXI_NS + 'policyId"]', presence: 'recommended' }] },
  { id: `${FOXXI_PROFILE_ID}/templates/asserted`, prefLabel: { en: 'asserted' }, definition: { en: 'An agent asserted a settled context descriptor (modal status Asserted).' }, verb: `${FOXXI_NS}verbs/asserted` },
];

// ── Patterns ────────────────────────────────────────────────────────
// Pattern operators (xAPI Profile §6.3):
//   sequence   — ordered list, each member fires in order
//   alternates — any one of the listed members
//   optional   — member may or may not appear
//   oneOrMore  — at least one
//   zeroOrMore — any number, including zero

const patterns = [
  {
    id: `${FOXXI_PROFILE_ID}/patterns/course-session`,
    prefLabel: { en: 'course-session' },
    definition: { en: 'A single learner-launch through a Foxxi course: launch → init → slide-view+ → scene-completed* → (passed | failed) → terminated.' },
    primary: true,
    sequence: [
      `${FOXXI_PROFILE_ID}/templates/launched`,
      `${FOXXI_PROFILE_ID}/templates/initialized`,
      `${FOXXI_PROFILE_ID}/patterns/learn-stream`,
      `${FOXXI_PROFILE_ID}/patterns/completion-outcome`,
      `${FOXXI_PROFILE_ID}/templates/terminated`,
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/learn-stream`,
    prefLabel: { en: 'learn-stream' },
    definition: { en: 'The body of slide-views interleaved with scene-completed milestones and optional asked-question interactions.' },
    primary: false,
    oneOrMore: `${FOXXI_PROFILE_ID}/patterns/learn-step`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/learn-step`,
    prefLabel: { en: 'learn-step' },
    primary: false,
    alternates: [
      `${FOXXI_PROFILE_ID}/templates/slide-viewed`,
      `${FOXXI_PROFILE_ID}/templates/scene-completed`,
      `${FOXXI_PROFILE_ID}/patterns/qa-turn`,
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/qa-turn`,
    prefLabel: { en: 'qa-turn' },
    primary: false,
    sequence: [
      `${FOXXI_PROFILE_ID}/templates/asked`,
      `${FOXXI_PROFILE_ID}/templates/retrieved`,
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/completion-outcome`,
    prefLabel: { en: 'completion-outcome' },
    primary: false,
    alternates: [
      `${FOXXI_PROFILE_ID}/templates/completed`,
      `${FOXXI_PROFILE_ID}/templates/passed`,
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/credentialing`,
    prefLabel: { en: 'credentialing' },
    definition: { en: 'Admin issues a credential after a passed course-session.' },
    primary: true,
    sequence: [
      `${FOXXI_PROFILE_ID}/templates/passed`,
      `${FOXXI_PROFILE_ID}/templates/credentialed`,
    ],
  },

  // ── Agent performance patterns (STRUCTURAL, domain-agnostic) ────────
  // These describe the SHAPE of substrate activity, not any application's
  // domain. They hold for a game, a code review, a trading session — anything.
  {
    id: `${FOXXI_PROFILE_ID}/patterns/agent-performance-stream`,
    prefLabel: { en: 'agent-performance-stream' },
    definition: { en: 'The domain-agnostic baseline: an agent\'s stream of performed (and occasionally voided) context-descriptor acts — whatever vertical authored them.' },
    primary: true,
    oneOrMore: `${FOXXI_PROFILE_ID}/patterns/agent-act`,
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/agent-act`,
    prefLabel: { en: 'agent-act' },
    primary: false,
    alternates: [
      `${FOXXI_PROFILE_ID}/templates/performed-descriptor`,
      `${FOXXI_PROFILE_ID}/templates/intended-descriptor`,
      `${FOXXI_PROFILE_ID}/templates/considered-descriptor`,
      `${FOXXI_PROFILE_ID}/templates/voided-descriptor`,
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/revision-arc`,
    prefLabel: { en: 'revision-arc' },
    definition: { en: 'An assert-then-supersede arc: an initial performed-descriptor followed by one or more superseding-descriptors revising/closing it (iep:supersedes). The structural shape behind a resolution closing a finding, a contract amendment, an iterated code review, or a game state advancing — Foxxi reads it identically without knowing the domain.' },
    primary: true,
    sequence: [
      `${FOXXI_PROFILE_ID}/templates/performed-descriptor`,
      `${FOXXI_PROFILE_ID}/patterns/revisions`,
    ],
  },
  {
    id: `${FOXXI_PROFILE_ID}/patterns/revisions`,
    prefLabel: { en: 'revisions' },
    primary: false,
    oneOrMore: `${FOXXI_PROFILE_ID}/templates/superseding-descriptor`,
  },
];

// ── Profile document ────────────────────────────────────────────────

/** A composable xAPI Profile (ADL 2017) authoring spec. Parameterizing the
 *  builder lets a COMPOSING vertical (e.g. agentic-performance-practice) author
 *  + register its OWN Profile — its own id/namespace, concepts, templates, and
 *  patterns — instead of being limited to Foxxi's fixed profile. Foxxi's own
 *  profile is just one instance of this builder (buildFoxxiProfileDoc below). */
export interface ProfileSpec {
  /** The Profile's identity IRI (it dereferences to itself when served). */
  id: string;
  prefLabel: Record<string, string>;
  definition: Record<string, string>;
  author: { type: string; name: string; url?: string };
  generatedAt: string;
  /** Already type-tagged concept objects (Verb / ActivityType / ContextExtension / …). */
  concepts: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  patterns: Array<Record<string, unknown>>;
  seeAlso?: string;
  conformsTo?: string;
}

/** Build an xAPI Profile JSON-LD document from a spec. Pure. */
export function buildProfileDoc(spec: ProfileSpec): Record<string, unknown> {
  return {
    '@context': 'https://w3id.org/xapi/profiles/context',
    id: spec.id,
    type: 'Profile',
    conformsTo: spec.conformsTo ?? 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: spec.prefLabel,
    definition: spec.definition,
    ...(spec.seeAlso ? { seeAlso: spec.seeAlso } : {}),
    versions: [{ id: `${spec.id}/v/1`, generatedAtTime: spec.generatedAt }],
    author: spec.author,
    concepts: spec.concepts,
    templates: spec.templates,
    patterns: spec.patterns,
  };
}

/** The Foxxi profile's building blocks, exported so a composing vertical can
 *  REUSE the domain-agnostic performance concepts/templates/patterns (the
 *  single `performed` verb + performed/superseding/voided-descriptor templates
 *  + agent-performance patterns) rather than re-mint them. */
export const FOXXI_PROFILE_PARTS = { verbs, activityTypes, extensions, templates, patterns } as const;

// ── Statement-template conformance (xAPI Profile spec §5) ───────────
// Given a statement whose verb is a profile concept, match it against that
// verb's declared StatementTemplate(s) and check the template's rules
// (presence:included/excluded, any, all). This makes "profile-conformant" a
// VERIFIED property, not just a declared one — the custom verbs the write path
// emits are held to the rules the published profile declares for them.

interface TemplateRule { location: string; presence?: string; any?: unknown[]; all?: unknown[]; none?: unknown[]; }

/** Resolve an xAPI Profile rule `location` (a JSONPath subset: dot segments,
 *  ["quoted keys"], and [*] over arrays) to the array of values it selects. */
function resolveLocation(root: unknown, location: string): unknown[] {
  const tokens: string[] = [];
  const re = /\[\s*(?:"([^"]*)"|'([^']*)'|(\*))\s*\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(location)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(m[2]);
    else if (m[3] !== undefined) tokens.push('*');
    else if (m[4] !== undefined) tokens.push(m[4].trim());
  }
  let cur: unknown[] = [root];
  for (const tok of tokens) {
    const next: unknown[] = [];
    for (const c of cur) {
      if (c === null || c === undefined || typeof c !== 'object') continue;
      if (tok === '*') { if (Array.isArray(c)) next.push(...c); continue; }
      if (Array.isArray(c)) { for (const item of c) { const v = (item as Record<string, unknown>)?.[tok]; if (v !== undefined) next.push(v); } }
      else { const v = (c as Record<string, unknown>)[tok]; if (v !== undefined) next.push(v); }
    }
    cur = next;
  }
  return cur;
}

export interface ProfileTemplateResult {
  verb: string;
  /** Is the statement's verb a declared concept of this profile? */
  verbDeclared: boolean;
  /** Did any statement template apply (verb-matched)? If false, `conforms` is not meaningful. */
  applicable: boolean;
  matchedTemplates: string[];
  violations: Array<{ template: string; location: string; message: string }>;
}

/** Validate a statement against the Foxxi Profile's statement templates for its verb.
 *  Per xAPI Profile spec §5.2, a template is selected by its VERB; objectActivityType
 *  (and contextCategory etc.) are DETERMINING PROPERTIES the statement must then match —
 *  a mismatch is a nonconformance, not a reason to skip the template. */
export function validateAgainstProfileTemplates(stmt: Record<string, unknown>): ProfileTemplateResult {
  const verb = (stmt.verb as { id?: string } | undefined)?.id ?? '';
  const objType = (stmt.object as { definition?: { type?: string } } | undefined)?.definition?.type;
  const verbDeclared = verbs.some(v => v.id === verb);
  // A template is SELECTED by its determining properties (verb + objectActivityType).
  const matched = templates.filter(t =>
    (t as { verb?: string }).verb === verb &&
    (!(t as { objectActivityType?: string }).objectActivityType || (t as { objectActivityType?: string }).objectActivityType === objType));
  // Compute each matched template's rule violations independently.
  const violationsFor = (t: typeof matched[number]): ProfileTemplateResult['violations'] => {
    const out: ProfileTemplateResult['violations'] = [];
    for (const rule of (((t as { rules?: TemplateRule[] }).rules) ?? [])) {
      const vals = resolveLocation(stmt, rule.location);
      const present = vals.length > 0 && vals.some(v => v !== undefined && v !== null);
      if (rule.presence === 'included' && !present) out.push({ template: t.id, location: rule.location, message: 'required location is absent' });
      if (rule.presence === 'excluded' && present) out.push({ template: t.id, location: rule.location, message: 'location must be absent' });
      if (rule.any && present && !vals.some(v => rule.any!.includes(v))) out.push({ template: t.id, location: rule.location, message: `no value in {${rule.any.map(String).join(', ')}}` });
      if (rule.all && present && !vals.every(v => rule.all!.includes(v))) out.push({ template: t.id, location: rule.location, message: `a value is not in {${rule.all.map(String).join(', ')}}` });
    }
    return out;
  };
  const perTemplate = matched.map(t => ({ id: t.id, violations: violationsFor(t) }));
  // A Statement FOLLOWS the profile if it fully satisfies AT LEAST ONE matched template
  // (xAPI Profile spec §5 — overlapping templates for the same verb are OR-ed, not AND-ed).
  const anySatisfied = perTemplate.some(pt => pt.violations.length === 0);
  let violations: ProfileTemplateResult['violations'] = [];
  if (matched.length > 0 && !anySatisfied) {
    // Report the closest template (fewest rule violations).
    violations = perTemplate.reduce((a, b) => b.violations.length < a.violations.length ? b : a).violations;
  }
  // §5.2: a Statement carrying a declared Verb that matches NO template at all is a
  // nonconformance (not a vacuous pass).
  if (verbDeclared && matched.length === 0) {
    violations.push({
      template: `${FOXXI_PROFILE_ID}#statement-template-conformance`,
      location: 'verb.id + object.definition.type',
      message: `verb is a declared Profile concept but the statement matches no Statement Template (spec §5.2); object activity type = ${objType ?? '(absent)'}`,
    });
  }
  return { verb, verbDeclared, applicable: matched.length > 0, matchedTemplates: matched.map(t => t.id), violations };
}

export function buildFoxxiProfileDoc(versionInfo: { generatedAt: string }): Record<string, unknown> {
  return buildProfileDoc({
    id: FOXXI_PROFILE_ID,
    prefLabel: { en: 'Foxxi Content Intelligence — xAPI Profile' },
    definition: {
      en: `xAPI Profile (ADL Profile Spec 2017) for the Foxxi Content Intelligence vertical on the Interego substrate. Defines the verbs, activity types, statement templates, and patterns Foxxi emits when projecting substrate context-descriptor activity to xAPI Statements. Conformance: cmi5 + xAPI 2.0 core verbs, plus Foxxi-specific extensions for concept-graph retrieval, ABAC policy decisions, and affordance instrumentation.`,
    },
    seeAlso: 'https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/CONFORMANCE.md',
    author: { type: 'Organization', name: 'Interego — Foxxi Content Intelligence', url: new URL(FOXXI_PROFILE_ID).origin },
    generatedAt: versionInfo.generatedAt,
    concepts: [
      ...verbs.map(v => ({ ...v, type: 'Verb' })),
      ...activityTypes.map(a => ({ ...a, type: 'ActivityType' })),
      ...extensions.map(e => ({ ...e, type: 'ContextExtension' })),
    ],
    templates,
    patterns,
  });
}
