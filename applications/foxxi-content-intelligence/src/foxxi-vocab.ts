/**
 * Foxxi vocabulary — the single, consolidated, dereferenceable namespace.
 *
 * This is not just an RDF namespace declaration. It is RESTful HATEOAS
 * linked data: the bridge SERVES this vocabulary, every foxxi term IRI
 * resolves to a real definition, and production code paths (the xAPI
 * conformance checker) actually GET it at runtime — dereferencing, not
 * assuming.
 *
 * One base — `<bridge>/ns/foxxi#` — replaces the two earlier, never-
 * published placeholder namespaces (`…/interego/ns/foxxi#` and the now-RETIRED,
 * non-dereferenceable `vocab.foxximediums.com/*`, fully removed from the repo). It sits on the
 * bridge's own host: vertical-scoped, outside the protocol IRI space
 * (where `iep:` etc. live), and — because the bridge serves it — actually
 * dereferenceable.
 *
 * Layer: L3 vertical. No protocol-ontology change; a vertical vocabulary.
 */

// Every representation is a serialization of ONE graph (ns/rdf.ts), with the shared document
// header (ns/catalog.ts). This module stays light on purpose: thirty modules import it for
// FOXXI_NS alone, so it must not pull in the lattice or the spec-ontology engine.
import {
  Graph, iri, en, str, bool, RDF, RDFS, OWL, SKOS, DCT, toTurtle, toJsonLd, toNTriples, toRdfXml,
  type NamedNode, type BlankNode, type Term, type JsonLdTerm,
} from './ns/rdf.js';
import { ALL_PREFIXES, CREATOR, PUBLISHER, addHeader, declareExternalTerms, foxxiPrefix, versionIri, alternates, type DocMeta } from './ns/catalog.js';
import { renderOntologyHtml } from './ns/html.js';
import { mappingSetIri } from './ns/sssom.js';
import { naturalLabel } from './ns/labels.js';

/**
 * The one Foxxi namespace base. Every foxxi term is `${FOXXI_NS}<name>`.
 *
 * This is the LIVE host, and that is the whole point: a term's identifier is a
 * promise that it resolves to a description of itself. It pointed at the paused
 * Azure host, so every id we minted — every xAPI activity type, every extension
 * key, every vocabulary term — named something unfetchable. An identifier that
 * cannot be dereferenced is a word, not a term.
 *
 * A COMPILE-TIME CONSTANT, never env-derived. If this came from the environment,
 * dev and prod would mint DIFFERENT ids for the same term and split the corpus —
 * a failure the old dead constant could not even have.
 *
 * The comment above claimed "the one" while 17 other modules re-declared this same
 * string under 8 different names (FOXXI_VOCAB / FXA / FXS / FOXXI / ns / ...). They
 * now import it. That duplication is why the host rot went unnoticed for so long.
 */
export const FOXXI_NS = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#';
/** The retired Azure namespace. Retained for reference / legacy-IRI canonicalization
 *  (ids minted under it live in signed content + xAPI object ids we must never rewrite).
 *  It is NOT asserted as a published owl:sameAs: that Azure host is permanently paused,
 *  so a machine-readable sameAs to it would be a dead link (violating everything-is-a-URL).
 *  A reader holding a legacy IRI canonicalizes it in code, not via a dangling triple. */
export const FOXXI_NS_LEGACY = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
/** The standards spec ontologies this vertical composes (dereferenceable at /ns/<module>).
 *  The foxxi vocabulary rdfs:seeAlso's them so the vertical declares the standards it
 *  emerges from — the emitted xAPI statements, SCORM manifests, and cmi5 sessions are
 *  instances of these composed ontologies. */
export const COMPOSED_SPEC_ONTOLOGIES = ['xapi', 'scorm-cam', 'scorm-sn', 'scorm-rte', 'cmi5']
  .map(m => FOXXI_NS.replace('foxxi#', m));
/** The vocabulary document IRI (strip the `#` — what a foxxi hash-IRI dereferences to). */
export const FOXXI_VOCAB_DOC = FOXXI_NS.replace(/#$/, '');

// The ontology-level rdfs:comment, shared verbatim by the Turtle, the triples
// and the JSON-LD projections so all three carry an IDENTICAL comment (the
// JSON-LD projection previously served a different string → content-negotiation
// unfaithfulness).
export const FOXXI_VOCAB_COMMENT = 'The vocabulary the Foxxi vertical emits: the xAPI verbs, activity types and context extensions its statements carry — typed with ADL\'s xAPI ontology classes, as the Foxxi xAPI Profile declares them — and the classes of the records it publishes to learner and tenant pods. It composes the standards ontologies it emerges from (rdfs:seeAlso).';

export type FoxxiTermKind = 'Verb' | 'ActivityType' | 'Type' | 'Extension';

export interface FoxxiTerm {
  /** Fragment after the `#` — may contain `/` (e.g. `verbs/asked`). */
  name: string;
  kind: FoxxiTermKind;
  /** The token as emitted (a verb's display, an extension key). Published as skos:notation for
   *  concepts; the rdfs:label is its words. */
  label: string;
  definition: string;
  /** skos:closeMatch alignments to other vocabularies' terms (absolute IRIs). */
  closeMatch?: readonly string[];
  /** Deprecated in favour of this term (its name): published with owl:deprecated and
   *  dct:isReplacedBy, and still dereferenceable. */
  replacedBy?: string;
  /** For a Type: its superclasses — a Foxxi term name, or an absolute IRI. */
  subClassOf?: readonly string[];
}

/** The consolidated Foxxi vocabulary — every term the vertical emits. */
export const FOXXI_TERMS: readonly FoxxiTerm[] = [
  // ── Verbs ──────────────────────────────────────────────────────────
  { name: 'verbs/scene-completed', kind: 'Verb', label: 'scene-completed', definition: 'Every slide in a course scene has been viewed.' },
  { name: 'verbs/asked', kind: 'Verb', label: 'asked', definition: 'A learner asked a content question to the concept-graph agentic retriever.' },
  { name: 'verbs/retrieved', kind: 'Verb', label: 'retrieved', definition: 'Concept-graph retrieval traced a set of slides/concepts as evidence for an answer.' },
  { name: 'verbs/enrolled', kind: 'Verb', label: 'enrolled', definition: 'A learner matched a tenant policy and was assigned a course.' },
  { name: 'verbs/credentialed', kind: 'Verb', label: 'credentialed', definition: 'An Open Badges 3.0 / W3C VC credential was issued for the learner.' },
  { name: 'verbs/wallet-exported', kind: 'Verb', label: 'wallet-exported', definition: 'A learner exported a CLR 2.0 envelope from their pod.' },
  { name: 'verbs/framework-aligned', kind: 'Verb', label: 'framework-aligned', definition: 'An admin declared a CASE 1.0 cross-tenant alignment association.' },
  { name: 'verbs/policy-decided', kind: 'Verb', label: 'policy-decided', definition: 'An ABAC policy returned an access decision (allow/deny) for a substrate call.' },
  { name: 'verbs/affordance-invoked', kind: 'Verb', label: 'affordance-invoked', definition: 'A bridge affordance was called — the bridge instruments every handler with this verb.' },
  { name: 'performed', kind: 'Verb', label: 'performed', definition: 'A unit of on-the-job production work was performed by a human or an AI agent (IEEE P2997 employment-history leg).' },

  // ── Structural (modal) verbs ───────────────────────────────────────
  // Domain-AGNOSTIC verbs naming the MODAL MODE of any agent's context-descriptor
  // act (iep:ModalStatusEnum), valid for ANY vertical — never a domain term. The
  // xAPI performance verb stays `performed` (above); these label the trajectory
  // step's mode so disposition reads the modal balance. (A Retracted descriptor
  // projects as the ADL core `voided` verb, not a foxxi term.)
  { name: 'verbs/asserted', kind: 'Verb', label: 'asserted', definition: 'An agent asserted a settled context descriptor (modal status Asserted; groundTruth true). The work was committed.' },
  { name: 'verbs/intended', kind: 'Verb', label: 'intended', definition: 'An agent recorded a Hypothetical context descriptor — an intention / plan (groundTruth undefined). No completion is claimed.' },
  { name: 'verbs/considered', kind: 'Verb', label: 'considered', definition: 'An agent recorded a Counterfactual (or Retracted) context descriptor — a road not taken / a withdrawn claim.' },

  // ── Activity / descriptor types ────────────────────────────────────
  { name: 'activities/scene', kind: 'ActivityType', label: 'scene', definition: 'A course scene grouping multiple slides under a sub-theme.' },
  { name: 'activities/concept-graph-node', kind: 'ActivityType', label: 'concept-graph-node', definition: 'A single concept in a course knowledge graph; carries prereq edges + slide membership.' },
  { name: 'activities/credential', kind: 'ActivityType', label: 'credential', definition: 'A Verifiable Credential / Open Badge 3.0.' },
  { name: 'activities/framework', kind: 'ActivityType', label: 'framework', definition: 'A CASE 1.0 / CaSS competency framework.' },
  { name: 'activities/affordance', kind: 'ActivityType', label: 'affordance', definition: 'A bridge affordance / MCP tool, identified by toolName.' },
  { name: 'activities/fragment', kind: 'ActivityType', label: 'fragment', definition: 'A piece of teaching or support whose IRI is the hash of its content: a concept, worked example, practice task, assessment item, job aid, reference, context, probe or reflection.' },
  { name: 'activities/composition', kind: 'ActivityType', label: 'composition', definition: 'A path of positions holding fragments or compositions by reference, resolved per learner from their own record.' },
  // Generic fallback activity type — names the ENVELOPE act (a context-descriptor
  // assertion) when the descriptor declares no conformsTo/facet type. The object
  // type of a projected statement is normally the descriptor's OWN conformsTo IRI
  // (e.g. ttt:Move, code:PullRequest, med:Diagnosis) passed through verbatim;
  // Foxxi never enumerates an application's types.
  { name: 'AssertedContext', kind: 'ActivityType', label: 'Asserted Context', definition: 'A context-descriptor assertion whose payload type the publisher did not declare — the domain-agnostic fallback object type for a projected performance statement.' },
  // A second IRI for the same activity type as `activities/concept-graph-node` — the one every
  // emitter uses. Nothing emits this one; it stays resolvable for statements already recorded.
  { name: 'conceptGraphNode', kind: 'ActivityType', label: 'concept graph node', definition: 'Activity type for a concept-graph node referenced from an xAPI statement. Superseded by activities/concept-graph-node, which names the same thing and is the one Foxxi emits.', replacedBy: 'activities/concept-graph-node' },
  { name: 'ProductionTask', kind: 'ActivityType', label: 'Production Task', definition: 'A unit of on-the-job production work — the object of a `performed` statement.' },
  { name: 'TrajectoryStep', kind: 'Type', label: 'Trajectory Step', definition: 'One step of an agentic-native trajectory — a modal, poly-granular Context Descriptor.' },
  { name: 'CourseCompletionCredential', kind: 'Type', label: 'Course Completion Credential', definition: 'A descriptor wrapping a W3C VC / Open Badges 3.0 course-completion credential in a learner pod wallet.', closeMatch: ['https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential'] },
  { name: 'CompetencyAssertion', kind: 'Type', label: 'Competency Assertion', definition: 'A descriptor asserting a learner holds a competency.', closeMatch: ['https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#CompetencyAssertion'] },
  { name: 'WalletEnvelope', kind: 'Type', label: 'Wallet Envelope', definition: 'A CLR 2.0 wallet envelope aggregating verified credentials.', closeMatch: ['https://purl.imsglobal.org/spec/vc/clr/vocab.html#ClrCredential'] },
  { name: 'CASEAlignment', kind: 'Type', label: 'CASE Alignment', definition: 'A 1EdTech CASE 1.0 cross-framework alignment association descriptor.' },
  { name: 'TenantMetadata', kind: 'Type', label: 'Tenant Metadata', definition: 'A descriptor carrying a Foxxi tenant\'s metadata.' },
  { name: 'AdaptiveSequencingPolicy', kind: 'Type', label: 'Adaptive Sequencing Policy', definition: 'A descriptor declaring an adaptive content-sequencing policy.' },
  { name: 'PackageUpload', kind: 'Type', label: 'Package Upload', definition: 'A descriptor recording that a SCORM / cmi5 package was uploaded. Hypothetical by construction: it records that bytes arrived, not what they contain.' },
  { name: 'ParsedPackage', kind: 'Type', label: 'Parsed Package', definition: 'A descriptor carrying what a SCORM / cmi5 package actually IS — manifest identifier, course title, standard, authoring-tool fingerprint, SCO list and activity structure — read out of the uploaded zip in-process. Asserted, and it supersedes (iep:supersedes) the PackageUpload receipt for the same graph.' },
  // Declared because foxxi.register_tutor_agent EMITS this type. Emitting an absolute
  // URL is only half a fix: without this entry GET /ns/foxxi/term/TutorAgentProfile
  // 404s (every projection — Turtle, JSON-LD, HTML table, term resource — is rendered
  // from FOXXI_TERMS), so the descriptor a caller publishes to their pod would name an
  // IRI that answers nothing.
  { name: 'TutorAgentProfile', kind: 'Type', label: 'Tutor Agent Profile', definition: 'A self-registered AI tutor agent\'s marketplace profile — DID, specialties (framework IRI + competency IRI + self-rated level) and contact endpoint. Self-asserted: foxxi.register_tutor_agent binds it to no signer, so what binds a profile to a tutor is publishing it to that tutor\'s own pod.' },

  // ── Performance architecture ───────────────────────────────────────
  { name: 'PerformanceSituation', kind: 'Type', label: 'Performance Situation', definition: 'A typed, modal-statused descriptor of a performer (human or agent), the work, and observed performance. The unit the system reasons from — it carries no idealised future state; content is never assumed.' },
  { name: 'Diagnosis', kind: 'Type', label: 'Diagnosis', definition: 'A contextualization of a performance situation: it reads the work regime and applies that regime’s method — apply an established practice (Evident), a cause-factor gap analysis (Knowable), a dispositional read (Emergent), or stabilise first (Turbulent).' },
  { name: 'InterventionPlan', kind: 'Type', label: 'Intervention Plan', definition: 'The full paradigm of interventions for a contextualized situation — instruction, performance-support, reference, practice, assessment, coaching, probe, environmental-fix, no-intervention — each marked selected or ruled-out with its reasoning.' },
  { name: 'InterventionEvaluation', kind: 'Type', label: 'Intervention Evaluation', definition: 'The Knowable regime’s closing move: a four-level evaluation — response, capability, transfer, outcome — as a modal-status progression; a closed gap supersedes the prior observed-state (iep:supersedes).' },
  { name: 'OutcomeRecord', kind: 'Type', label: 'Outcome Record', definition: 'One distilled intervention outcome — in a regime, having named a cause and chosen an intervention, the verdict reached; and, if it missed, the cause re-contextualization found instead. The evidence atom of calibration.' },
  { name: 'CalibrationProfile', kind: 'Type', label: 'Calibration Profile', definition: 'The system’s recorded track record of its own Knowable-regime recommendations: per (regime × cause × intervention) cell, how often that recommendation actually closed the gap. A cell is Hypothetical until it has the samples to Assert a rate; profiles compose across organizations by union.' },
  { name: 'CapabilityTransfer', kind: 'Type', label: 'Capability Transfer', definition: 'The performance reading of one agent teaching another. The unit taught is an ac:TeachingPackage (agent-collective); Foxxi frames a learner agent’s acquisition of it as an A2A instruction intervention, verifies the transfer by reading the learner’s own trajectories before and after, and emits an amta:Attestation that feeds ac:’s modal discipline and the reflexive calibration loop. Foxxi composes the teaching foundation; it does not redefine it.' },
  { name: 'GroundingFragment', kind: 'Type', label: 'Grounding Fragment', definition: 'A content-addressed atomic content unit (a PGSL atom) — the leaf of an emergent course; carries modality, cognitive level, provenance and disposition-suitability.' },
  { name: 'Lesson', kind: 'Type', label: 'Lesson', definition: 'A syntagm of grounding fragments toward one competency-point; each position holds a paradigm of interchangeable alternatives.', subClassOf: ['Composition'] },
  { name: 'Module', kind: 'Type', label: 'Module', definition: 'A syntagm of lessons.', subClassOf: ['Composition'] },
  { name: 'Course', kind: 'Type', label: 'Course', definition: 'A syntagm of modules. Not a stored artifact — a composition recipe that personalises (restriction + override) into a different resolved course per performer.', subClassOf: ['Composition'] },
  { name: 'Composition', kind: 'Type', label: 'Composition', definition: 'One type for lesson, module, course and curriculum: a path of positions, each naming a competency and the fragments or compositions that can fill it, by reference. Its IRI is the hash of its content, and each learner gets it resolved from their own record.' },
  { name: 'ContentAdmission', kind: 'Type', label: 'Content Admission', definition: 'What a learner keeps on their own pod about which forms of content suit them at a competency: the fragment kinds admitted and why, the plan or situation it came from and the regime that plan read, and when. The latest record for a competency stands, a withdrawal included; resolution reads it whenever a request names no admission of its own. The learner keeps it; the bridge only reads it.' },
  { name: 'AppliedVoid', kind: 'Type', label: 'Applied Void', definition: 'That a statement in the record of a learner was voided, kept with that record by the bridge once the voiding took effect: the id of the voided statement and of the voiding one. The store of a lens is a view that eviction and restarts empty, while the copies of the voided statement in the lattice and on the pod of the learner outlive it; this record keeps them voided. Only a void that took effect is kept, never one a voiding statement merely names.' },
  { name: 'ContentBundle', kind: 'Type', label: 'Content Bundle', definition: 'What an author made in one act, kept together on their pod: a root composition and every fragment and composition it holds, each still named by the hash of its own content and checked against it when read back. A folded course is kept as one bundle, so the pod takes one write rather than one per item.' },
  { name: 'Curriculum', kind: 'Type', label: 'Curriculum', definition: 'A syntagm of courses toward a set of target competencies.', subClassOf: ['Composition'] },
  { name: 'InFlowPerformanceSupport', kind: 'Type', label: 'In-Flow Performance Support', definition: 'A job-aid fragment delivered by an affordance attached to the work context — surfaced when a performer enters the triggering task, not on a training schedule.' },
  { name: 'DeliveredContent', kind: 'Type', label: 'Delivered Content', definition: 'A descriptor wrapping a unit of generated content delivered through a channel and published to the pod — so the delivery is itself a discoverable, federatable Context Descriptor, not a fire-and-forget send.' },

  // ── Knowledge architecture ─────────────────────────────────────────
  { name: 'WorkRegime', kind: 'Type', label: 'Work Regime', definition: 'How knowable the relationship between act and outcome is for a piece of work — Evident, Knowable, Emergent, or Turbulent. The regime decides which consulting and knowledge method is valid.' },
  { name: 'ContentRevision', kind: 'Type', label: 'Content Revision', definition: 'A revision of a judged content claim: the claim as it stood and the grade it had, the words now and the evidence cited from outside the passage, who revised it and whether as a person or an agent, and — once the revised claim is judged — the new judgment and the grade before and after. The original judgment stands; the revision names it.' },
  { name: 'AutonomyPolicy', kind: 'Type', label: 'Autonomy Policy', definition: 'The constitutional policy that says when a judge may assert on a kind of question without a person: per kind, the registry rating on its axis the judge must reach, over how many outcomes the latest attestation must rest, and how many of those a person must have confirmed. Amended through propose, vote and ratify; each policy supersedes the last; a judgment cites the decision it was published under.' },
  { name: 'ContentJudgmentAttestation', kind: 'Type', label: 'Content Judgment Attestation', definition: 'An attestation about the content-judging agent, in the AMTA axes (accuracy, competence, honesty, recency): the agent about itself, grounded in the calibration its confirmed outcomes give, or a learning engineer as a peer. The registry aggregates every one on the pod into the reputation foxxi.content_judgment_reputation serves.', subClassOf: ['https://markjspivey-xwisee.github.io/interego/ns/amta#Attestation'] },
  { name: 'ContentJudgmentOutcome', kind: 'Type', label: 'Content Judgment Outcome', definition: 'What a person held to be true about a content claim after a ContentJudgment: the confirmed answer, whether the model had it, and the Brier score of its probabilities. Asserted; it supersedes the judgment it scores, and the content judgment calibration is computed over these.' },
  { name: 'ContentJudgment', kind: 'Type', label: 'Content Judgment', definition: 'A System One model judgment about a unit of course content — how well a claim is supported by its context and evidence (evidence-level), or which work regime the work it describes falls in (work-regime) — carried as typed probabilities with the model confidence. Hypothetical until a person confirms or refutes it; the descriptor controls say how.' },
  { name: 'CompetenceDecomposition', kind: 'Type', label: 'Competence Decomposition', definition: 'A competency broken into knowledge components (recorded / trained / judged / lived / innate) by codifiability — how much of it can honestly become content.' },
  { name: 'KnowledgeAsset', kind: 'Type', label: 'Knowledge Asset', definition: 'A unit of knowledge — a codified artefact, a narrative, or a connection to a holder; carries a codification level and, for codified assets, an explicit uncodified residue.' },
  { name: 'KnowledgeMap', kind: 'Type', label: 'Knowledge Map', definition: 'A regime-routed knowledge strategy for a competency: what to codify into content and what to enable as a flow — connection, narrative, apprenticeship.' },

  // ── Extensions / properties ────────────────────────────────────────
  { name: 'slideId', kind: 'Extension', label: 'slideId', definition: 'Identifier of the slide a statement is about.' },
  { name: 'sceneTitle', kind: 'Extension', label: 'sceneTitle', definition: 'Title of the scene grouping.' },
  { name: 'conceptIds', kind: 'Extension', label: 'conceptIds', definition: 'List of concept-graph node IDs referenced by the activity.' },
  { name: 'masteryThreshold', kind: 'Extension', label: 'masteryThreshold', definition: 'cmi5 mastery threshold applied to score.scaled for the pass/fail decision (0.0–1.0).' },
  { name: 'session', kind: 'Extension', label: 'session', definition: 'Foxxi session UUID — joins all statements from a single learner launch.' },
  { name: 'affordanceTool', kind: 'Extension', label: 'affordanceTool', definition: 'MCP tool name of the invoked affordance.' },
  { name: 'policyId', kind: 'Extension', label: 'policyId', definition: 'ABAC policy descriptor IRI that produced a decision.' },
  { name: 'decision', kind: 'Extension', label: 'decision', definition: 'ABAC decision — allow / deny.' },
  { name: 'callerRole', kind: 'Extension', label: 'callerRole', definition: 'Resolved caller role at the time of an affordance call.' },
  { name: 'substrateDescriptorIri', kind: 'Extension', label: 'substrateDescriptorIri', definition: 'IRI of the substrate context descriptor produced by an affordance call (xAPI ↔ substrate cross-link).' },
  // Envelope-derived signals carried verbatim from the context-descriptor (never reinterpreted).
  { name: 'supersededDescriptor', kind: 'Extension', label: 'supersededDescriptor', definition: 'IRI of a prior descriptor this one revises/closes — the iep:supersedes link carried into xAPI as a structural revision signal (not a domain closure verb).' },
  { name: 'trustLevel', kind: 'Extension', label: 'trustLevel', definition: 'The descriptor\'s TrustFacet level (SelfAsserted / ThirdPartyAttested / CryptographicallyVerified), passed through verbatim.' },
  { name: 'judgmentKind', kind: 'Extension', label: 'judgmentKind', definition: 'On a ContentJudgment: which question the model was asked — evidence-level (a Score over the evidence scale) or work-regime (a Choice among the four regimes).' },
  { name: 'epistemicConfidence', kind: 'Extension', label: 'epistemicConfidence', definition: 'The descriptor\'s SemioticFacet epistemic confidence [0.0–1.0] — confidence that the DESCRIPTOR itself is accurate (infrastructure-level), NOT a performance score. Carried as its own extension, never as result.score.scaled.' },
  { name: 'groundTruth', kind: 'Extension', label: 'groundTruth', definition: 'The descriptor\'s tri-state groundTruth (true for Asserted, false for Counterfactual, undefined for Hypothetical), passed through verbatim.' },
  { name: 'endorsed', kind: 'Extension', label: 'endorsed', definition: 'False when the descriptor is Quoted (recorded with no endorsement / source-attributed).' },
  { name: 'observedBy', kind: 'Extension', label: 'observedBy', definition: 'DID of the observer/evaluator who attested a performance record (provenance).' },
  { name: 'costUsd', kind: 'Extension', label: 'costUsd', definition: 'Cost of a performance execution in USD — agent performance economics.' },
  { name: 'contextKind', kind: 'Extension', label: 'contextKind', definition: 'Whether a statement records `production` work, `training`, or `performance-support`.' },
  { name: 'workTrajectory', kind: 'Extension', label: 'workTrajectory', definition: 'How a unit of recorded production work went, as its performer recorded it with the work: its steps, each with a modal status (done, intended, or considered and dropped), a granularity (task, subtask or tool call), what it acted on and its result. Carried in the performance statement itself, so it lives with the record on the performer\'s pod, and a work regime can be read from it later.' },
  { name: 'gradedTag', kind: 'Extension', label: 'gradedTag', definition: 'HMAC the bridge puts on a result it graded itself, keyed by a secret only it holds; a credential earned from evidence counts only mastery statements that carry it, so a learner\'s own report is in the record but is not evidence.' },
  { name: 'deliveryChannel', kind: 'Extension', label: 'deliveryChannel', definition: 'The channel a generated text artifact was delivered through — document, email, chat, or sms.' },
  { name: 'recipient', kind: 'Extension', label: 'recipient', definition: 'The recipient address/handle a generated artifact was delivered to.' },
  { name: 'deliveredBody', kind: 'Extension', label: 'deliveredBody', definition: 'Base64-encoded body text of a delivered-content artifact published to the pod.' },
  { name: 'deliveredVia', kind: 'Extension', label: 'deliveredVia', definition: 'How a delivery left the bridge — a pod-descriptor publish, a channel webhook, or none (recorded only).' },
  { name: 'contentForm', kind: 'Extension', label: 'contentForm', definition: 'The text form a unit of content was rendered in — plain, markdown, html, or interactive (dynamic hypermedia).' },
  { name: 'actorKind', kind: 'Extension', label: 'actorKind', definition: 'Whether the actor is a `human` or an `agent`.' },
  { name: 'competency', kind: 'Extension', label: 'competency', definition: 'The competency IRI the composition position a fragment filled develops.' },
  { name: 'compositionPosition', kind: 'Extension', label: 'compositionPosition', definition: 'The index of the position, in the composition holding it, that a fragment filled.' },
  { name: 'alternativesOffered', kind: 'Extension', label: 'alternativesOffered', definition: 'The fragment and composition IRIs a position offered, of which the fragment experienced was chosen.' },
  { name: 'chosenBecause', kind: 'Extension', label: 'chosenBecause', definition: 'Why resolution chose the fragment for this learner, in words.' },
  { name: 'projectedFromTrajectoryStep', kind: 'Extension', label: 'projectedFromTrajectoryStep', definition: 'IRI of the agentic-native trajectory step an xAPI statement was projected from.' },
  { name: 'bundleJson', kind: 'Extension', label: 'bundleJson', definition: 'Base64-encoded JSON payload (e.g. a signed VC) embedded in a descriptor graph.' },
  { name: 'evaluationId', kind: 'Extension', label: 'evaluationId', definition: 'IRI of the agent/harness evaluation cohort a `performed` run is bound to — ties an external-agent run to a head-to-head portfolio comparison.' },
  { name: 'candidateId', kind: 'Extension', label: 'candidateId', definition: 'IRI of the evaluation candidate (one team\'s agent/harness) a run is attributed to within an evaluation cohort.' },
  { name: 'harness', kind: 'Extension', label: 'harness', definition: 'The harness / runtime label an external agent is built on (name, version, runtime) — lets a portfolio read attribute behaviour to the harness.' },
];

const TERM_INDEX = new Map(FOXXI_TERMS.map(t => [t.name, t]));

export function lookupTerm(name: string): FoxxiTerm | undefined {
  return TERM_INDEX.get(name);
}

/** All foxxi Verb IRIs declared by the vocabulary — what conformance checks against. */
export function declaredVerbIris(): string[] {
  return FOXXI_TERMS.filter(t => t.kind === 'Verb').map(t => `${FOXXI_NS}${t.name}`);
}

// ── The vocabulary as an OWL 2 DL graph ──────────────────────────────

/**
 * What each kind of term IS, in RDF.
 *
 * ★ VERBS, ACTIVITY TYPES AND EXTENSIONS ARE xAPI CONCEPTS, TYPED WITH ADL'S OWN CLASSES. Their IRIs
 * appear as `verb.id`, `object.definition.type` and `context.extensions` keys in statements, and the
 * Foxxi xAPI Profile (/xapi/profile) declares the same IRIs as profile Concepts — which the xAPI
 * Profiles JSON-LD context types as `https://w3id.org/xapi/ontology#Verb` etc. Typing them the same
 * way here makes the vocabulary and the profile agree about the same subjects, and lets any tool that
 * reads ADL's xAPI ontology recognise them. (They used to be typed `foxxi:Verb` & co., classes this
 * document never declared — OOPS! P34, and invisible to xAPI tooling.) Every Foxxi extension is
 * carried in `context.extensions`, hence ContextExtension.
 *
 * ★ A "Type" IS A CLASS. Those IRIs are the `rdf:type` of the entities the bridge publishes to pods
 * (outcome-descriptor-publisher writes `<entity> a <type>`) and the `dct:conformsTo` of their
 * descriptors, so they are declared `owl:Class`, not individuals of an undeclared `foxxi:Type`.
 */
const XAPI_ONT = 'https://w3id.org/xapi/ontology#';
const KIND: Record<FoxxiTermKind, { xapiClass?: string; scheme?: { name: string; label: string; comment: string } }> = {
  Verb: { xapiClass: `${XAPI_ONT}Verb`, scheme: { name: 'VerbScheme', label: 'Foxxi xAPI verbs', comment: 'The xAPI verbs Foxxi statements use that no other authority defines. Each is also a Concept of the Foxxi xAPI Profile.' } },
  ActivityType: { xapiClass: `${XAPI_ONT}ActivityType`, scheme: { name: 'ActivityTypeScheme', label: 'Foxxi xAPI activity types', comment: 'The xAPI activity types Foxxi statements carry as object.definition.type.' } },
  Extension: { xapiClass: `${XAPI_ONT}ContextExtension`, scheme: { name: 'ExtensionScheme', label: 'Foxxi xAPI context extensions', comment: 'The keys Foxxi statements carry in context.extensions.' } },
  Type: {},
};

/** The label a term is published with: words, never a token (the token is its skos:notation),
 *  qualified by its kind where a bare word would collide with a class (`activities/composition`
 *  beside the `Composition` class). */
function termLabel(t: FoxxiTerm): string {
  const base = t.kind === 'Verb' ? t.label.replace(/-/g, ' ')
    : t.kind === 'ActivityType' ? `${t.label.replace(/-/g, ' ')} activity type`
      : t.kind === 'Extension' ? `${naturalLabel(t.label, 'property')} extension`
        : t.label;
  // A deprecated term's label begins "obsolete " (the OBO Foundry convention; it also keeps the
  // label unique beside the term that replaces it, which often has its name).
  return t.replacedBy ? `obsolete ${base}` : base;
}

/** The token a concept is matched by in statements: the last segment of its IRI. */
const notationOf = (t: FoxxiTerm): string => t.name.split('/').pop()!;

/** Self-description of the vocabulary document. */
export function foxxiDocMeta(): DocMeta {
  return {
    iri: FOXXI_VOCAB_DOC, ns: FOXXI_NS, prefix: foxxiPrefix('foxxi'),
    title: 'Foxxi Content Intelligence vocabulary',
    description: FOXXI_VOCAB_COMMENT,
    version: '2026.10.0', created: '2026-05-20', modified: '2026-10-12', issued: '2026-10-12',
    standards: [],
    bodies: ['ADL'],
    notice: `An original vocabulary of the Foxxi vertical, by ${CREATOR} (${PUBLISHER}). It formalizes no standard; its xAPI concepts are typed with classes of ADL's xAPI ontology (https://w3id.org/xapi/ontology), which is not affiliated with or endorsing this vocabulary.`,
    seeAlso: [...COMPOSED_SPEC_ONTOLOGIES, `${FOXXI_VOCAB_DOC.replace('/ns/foxxi', '/xapi/profile')}`, mappingSetIri(FOXXI_VOCAB_DOC)],
    sourceCode: ['applications/foxxi-content-intelligence/src/foxxi-vocab.ts'],
    notes: [
      'Path-structured term names (verbs/…, activities/…) are part of the IRI: <https://foxxi-bridge.interego.xwisee.com/ns/foxxi#verbs/asked> is one term. The Turtle writes such IRIs in full, which every reader takes; as a prefixed name the slash would have to be escaped (foxxi:verbs\\/asked).',
    ],
  };
}

let _graph: Graph | undefined;

/** The whole vocabulary as one OWL 2 DL graph. Built once per process; treat it as read-only. */
export function vocabGraph(): Graph {
  if (_graph) return _graph;
  const g = new Graph();
  const meta = foxxiDocMeta();
  const O = addHeader(g, meta);
  const A = iri(RDF + 'type');
  const schemes = new Map<FoxxiTermKind, NamedNode>();
  for (const [kind, k] of Object.entries(KIND) as Array<[FoxxiTermKind, (typeof KIND)[FoxxiTermKind]]>) {
    if (!k.scheme) continue;
    const S = iri(FOXXI_NS + k.scheme.name);
    schemes.set(kind, S);
    g.add(S, A, iri(SKOS + 'ConceptScheme'))
      .add(S, iri(RDFS + 'label'), en(k.scheme.label)).add(S, iri(SKOS + 'prefLabel'), en(k.scheme.label))
      .add(S, iri(RDFS + 'comment'), en(k.scheme.comment))
      .add(S, iri(RDFS + 'isDefinedBy'), O);
  }
  for (const t of FOXXI_TERMS) {
    const T = iri(FOXXI_NS + t.name);
    const label = termLabel(t);
    const k = KIND[t.kind];
    if (k.xapiClass) {
      const S = schemes.get(t.kind)!;
      g.add(T, A, iri(SKOS + 'Concept')).add(T, A, iri(k.xapiClass))
        .add(T, iri(SKOS + 'prefLabel'), en(label)).add(T, iri(RDFS + 'label'), en(label))
        .add(T, iri(SKOS + 'notation'), str(notationOf(t)))
        .add(T, iri(SKOS + 'definition'), en(t.definition))
        .add(T, iri(SKOS + 'inScheme'), S).add(T, iri(SKOS + 'topConceptOf'), S).add(S, iri(SKOS + 'hasTopConcept'), T);
    } else {
      g.add(T, A, iri(OWL + 'Class'))
        .add(T, iri(RDFS + 'label'), en(label))
        .add(T, iri(RDFS + 'comment'), en(t.definition));
      for (const sup of t.subClassOf ?? []) g.add(T, iri(RDFS + 'subClassOf'), iri(/^https?:\/\//.test(sup) ? sup : FOXXI_NS + sup));
    }
    for (const m of t.closeMatch ?? []) g.add(T, iri(SKOS + 'closeMatch'), iri(m));
    if (t.replacedBy) {
      // Kept dereferenceable — statements already recorded may carry it — but marked so no new
      // statement does, with the term to use instead.
      g.add(T, iri(OWL + 'deprecated'), bool(true)).add(T, iri(DCT + 'isReplacedBy'), iri(FOXXI_NS + t.replacedBy));
    }
    g.add(T, iri(RDFS + 'isDefinedBy'), O);
  }
  declareExternalTerms(g, [FOXXI_NS]);
  _graph = g;
  return g;
}

/** The whole vocabulary as a JSON-LD document — the same graph as the Turtle. */
export function renderVocabJsonLd(): Record<string, unknown> {
  // No HAL `_links` beside the @graph: JSON-LD drops them, so a processor in safe mode refused the
  // document. The header triples carry the same links (owl:versionIRI; rdfs:seeAlso the xAPI
  // profile and the standards ontologies it composes), and the response's Link header the version.
  return toJsonLd(vocabGraph(), ALL_PREFIXES, { terms: JSONLD_TERMS, first: [FOXXI_VOCAB_DOC] });
}

/** Short keys the JSON-LD has always used (kept for JS consumers); each is an exact alias. */
const JSONLD_TERMS: Record<string, JsonLdTerm> = {
  label: { '@id': RDFS + 'label', '@language': 'en' },
  comment: { '@id': RDFS + 'comment', '@language': 'en' },
  isDefinedBy: { '@id': RDFS + 'isDefinedBy', '@type': '@id' },
};

/**
 * The vocabulary as TRIPLES, grouped by subject — the same graph renderVocabTurtle
 * prints, but as data the lattice can actually compose.
 *
 * Identifiers are ABSOLUTE URLS, never CURIEs: `rdfs:label` is a Turtle
 * serialization artifact, and atomizing it would atomize the serialization rather
 * than the thing it abbreviates. A literal contributes its lexical form. Blank nodes
 * (none today) would be skolemized under the vocabulary IRI so two documents' `_:b0`
 * never become one atom.
 *
 * Grouped by subject (graph -> subject -> triple) so each ingest stays narrow —
 * PGSL's ingest is ~O(n^2) in sequence length, so composing one holon from every
 * triple at once is quadratic, not "more holonic".
 */
export function vocabTriplesBySubject(): Array<Array<readonly [string, string, string]>> {
  const genid = `${FOXXI_VOCAB_DOC}/.well-known/genid/`;
  const term = (t: Term): string => t.termType === 'BlankNode' ? genid + t.value : t.value;
  const groups = new Map<string, Array<readonly [string, string, string]>>();
  for (const t of vocabGraph().triples) {
    const s = term(t.s);
    const row = groups.get(s) ?? [];
    row.push([s, t.p.value, term(t.o)] as const);
    groups.set(s, row);
  }
  return [...groups.values()];
}

/** The whole vocabulary as Turtle. */
export function renderVocabTurtle(): string {
  const m = foxxiDocMeta();
  return toTurtle(vocabGraph(), ALL_PREFIXES, {
    header: [`${m.title} — version ${m.version}`, `${m.iri}  (this version: ${versionIri(m)})`,
      'Served with content negotiation as Turtle, RDF/XML, N-Triples, JSON-LD and HTML; each is a serialization of one graph.'],
  });
}
export function renderVocabNTriples(): string { return toNTriples(vocabGraph()); }
export function renderVocabRdfXml(): string { return toRdfXml(vocabGraph(), ALL_PREFIXES); }

/** Human-readable documentation (content negotiation: Accept: text/html). */
export function renderVocabHtml(): string {
  const meta = foxxiDocMeta();
  return renderOntologyHtml({
    graph: vocabGraph(), meta, prefixes: ALL_PREFIXES,
    links: [...alternates(meta.iri), { label: 'Foxxi xAPI Profile', href: FOXXI_VOCAB_DOC.replace('/ns/foxxi', '/xapi/profile') }, { label: `this version (${meta.version})`, href: versionIri(meta) }],
  });
}

/** One term's triples (and any blank nodes they reach), or null when the graph has no such subject. */
export function vocabTermGraph(name: string): Graph | null {
  const full = FOXXI_NS + name;
  const g = vocabGraph();
  if (!g.triples.some(t => t.s.termType === 'NamedNode' && t.s.value === full)) return null;
  const out = new Graph();
  const visit = (s: NamedNode | BlankNode, seen: Set<string>): void => {
    for (const t of g.triples) {
      if (t.s.termType !== s.termType || t.s.value !== s.value) continue;
      out.add(t.s, t.p, t.o);
      if (t.o.termType === 'BlankNode' && !seen.has(t.o.value)) { seen.add(t.o.value); visit(t.o, seen); }
    }
  };
  visit(iri(full), new Set());
  return out;
}

/** A single term as a JSON-LD resource, with HATEOAS `_links`. Returns null for an UNKNOWN
 *  fragment so the route 404s — fabricating a foxxi:Term stub for any string returned HTTP 200
 *  for IRIs that resolve to nothing and injected false triples (an unknown term is not a real
 *  vocabulary member; owning the namespace is not a licence to invent members on demand). */
export function renderTermJsonLd(name: string): Record<string, unknown> | null {
  const tg = vocabTermGraph(name);
  if (!tg) return null;
  const id = `${FOXXI_NS}${name}`;
  const j = toJsonLd(tg, ALL_PREFIXES, { terms: JSONLD_TERMS, first: [id] });
  const [node, ...rest] = j['@graph'] as Array<Record<string, unknown>>;
  // The route links the term to its document in the Link header (a body `_links` is dropped by
  // JSON-LD processing, and refused in safe mode).
  return { '@context': j['@context'], ...node!, '@id': id, ...(rest.length ? { '@included': rest } : {}) };
}
