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
export const FOXXI_PROFILE_ID = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/xapi/profile';
export const FOXXI_NS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';

const ADL = 'http://adlnet.gov/expapi';
const CMI5 = 'https://w3id.org/xapi/cmi5';

// ── Concepts ────────────────────────────────────────────────────────

const verbs = [
  { id: `${ADL}/verbs/launched`,    prefLabel: { en: 'launched' },    definition: { en: 'cmi5 launch verb — the LMS launched an AU / course' } },
  { id: `${ADL}/verbs/initialized`, prefLabel: { en: 'initialized' }, definition: { en: 'cmi5 initialized verb — AU declared initialization' } },
  { id: `${ADL}/verbs/experienced`, prefLabel: { en: 'experienced' }, definition: { en: 'xAPI core verb — learner experienced (viewed / interacted with) an Activity. Used for slide views.' } },
  { id: `${ADL}/verbs/completed`,   prefLabel: { en: 'completed' },   definition: { en: 'cmi5 completed verb — learner reached the end of the AU' } },
  { id: `${ADL}/verbs/passed`,      prefLabel: { en: 'passed' },      definition: { en: 'cmi5 passed verb — score met or exceeded mastery threshold' } },
  { id: `${ADL}/verbs/failed`,      prefLabel: { en: 'failed' },      definition: { en: 'cmi5 failed verb — score fell below mastery threshold' } },
  { id: `${ADL}/verbs/satisfied`,   prefLabel: { en: 'satisfied' },   definition: { en: 'cmi5 satisfied verb — moveOn condition met (see cmi5 §11)' } },
  { id: `${ADL}/verbs/terminated`,  prefLabel: { en: 'terminated' },  definition: { en: 'cmi5 terminated verb — session ended cleanly' } },
  { id: `${ADL}/verbs/abandoned`,   prefLabel: { en: 'abandoned' },   definition: { en: 'cmi5 abandoned verb — session ended unexpectedly (session_timeout, browser close)' } },
  { id: `${ADL}/verbs/waived`,      prefLabel: { en: 'waived' },      definition: { en: 'cmi5 waived verb — administrator excused the requirement' } },
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
    rules: [{ location: 'context.extensions["' + FOXXI_NS + 'conceptIds"]', presence: 'included' }],
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
  author: { type: string; name: string };
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

export function buildFoxxiProfileDoc(versionInfo: { generatedAt: string }): Record<string, unknown> {
  return buildProfileDoc({
    id: FOXXI_PROFILE_ID,
    prefLabel: { en: 'Foxxi Content Intelligence — xAPI Profile' },
    definition: {
      en: `xAPI Profile (ADL Profile Spec 2017) for the Foxxi Content Intelligence vertical on the Interego substrate. Defines the verbs, activity types, statement templates, and patterns Foxxi emits when projecting substrate context-descriptor activity to xAPI Statements. Conformance: cmi5 + xAPI 2.0 core verbs, plus Foxxi-specific extensions for concept-graph retrieval, ABAC policy decisions, and affordance instrumentation.`,
    },
    seeAlso: 'https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/CONFORMANCE.md',
    author: { type: 'Organization', name: 'Acme Training Co (demo tenant)' },
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
