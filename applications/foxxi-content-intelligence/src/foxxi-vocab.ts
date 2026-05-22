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
 * published placeholder namespaces (`…/interego/ns/foxxi#` and
 * `vocab.foxximediums.com/{activity,scorm,wallet}#`). It sits on the
 * bridge's own host: vertical-scoped, outside the protocol IRI space
 * (where `cg:` etc. live), and — because the bridge serves it — actually
 * dereferenceable.
 *
 * Layer: L3 vertical. No protocol-ontology change; a vertical vocabulary.
 */

/** The one Foxxi namespace base. Every foxxi term is `${FOXXI_NS}<name>`. */
export const FOXXI_NS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
/** The vocabulary document IRI (strip the `#` — what a foxxi hash-IRI dereferences to). */
export const FOXXI_VOCAB_DOC = FOXXI_NS.replace(/#$/, '');

export type FoxxiTermKind = 'Verb' | 'ActivityType' | 'Type' | 'Extension';

export interface FoxxiTerm {
  /** Fragment after the `#` — may contain `/` (e.g. `verbs/asked`). */
  name: string;
  kind: FoxxiTermKind;
  label: string;
  definition: string;
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

  // ── Activity / descriptor types ────────────────────────────────────
  { name: 'activities/scene', kind: 'ActivityType', label: 'scene', definition: 'A course scene grouping multiple slides under a sub-theme.' },
  { name: 'activities/concept-graph-node', kind: 'ActivityType', label: 'concept-graph-node', definition: 'A single concept in a course knowledge graph; carries prereq edges + slide membership.' },
  { name: 'activities/credential', kind: 'ActivityType', label: 'credential', definition: 'A Verifiable Credential / Open Badge 3.0.' },
  { name: 'activities/framework', kind: 'ActivityType', label: 'framework', definition: 'A CASE 1.0 / CaSS competency framework.' },
  { name: 'activities/affordance', kind: 'ActivityType', label: 'affordance', definition: 'A bridge affordance / MCP tool, identified by toolName.' },
  { name: 'conceptGraphNode', kind: 'ActivityType', label: 'concept graph node', definition: 'Activity type for a concept-graph node referenced from an xAPI statement.' },
  { name: 'ProductionTask', kind: 'ActivityType', label: 'Production Task', definition: 'A unit of on-the-job production work — the object of a `performed` statement.' },
  { name: 'TrajectoryStep', kind: 'Type', label: 'Trajectory Step', definition: 'One step of an agentic-native trajectory — a modal, poly-granular Context Descriptor.' },
  { name: 'CourseCompletionCredential', kind: 'Type', label: 'Course Completion Credential', definition: 'A descriptor wrapping a W3C VC / Open Badges 3.0 course-completion credential in a learner pod wallet.' },
  { name: 'CompetencyAssertion', kind: 'Type', label: 'Competency Assertion', definition: 'A descriptor asserting a learner holds a competency.' },
  { name: 'WalletEnvelope', kind: 'Type', label: 'Wallet Envelope', definition: 'A CLR 2.0 wallet envelope aggregating verified credentials.' },
  { name: 'CASEAlignment', kind: 'Type', label: 'CASE Alignment', definition: 'A 1EdTech CASE 1.0 cross-framework alignment association descriptor.' },
  { name: 'TenantMetadata', kind: 'Type', label: 'Tenant Metadata', definition: 'A descriptor carrying a Foxxi tenant\'s metadata.' },
  { name: 'AdaptiveSequencingPolicy', kind: 'Type', label: 'Adaptive Sequencing Policy', definition: 'A descriptor declaring an adaptive content-sequencing policy.' },
  { name: 'PackageUpload', kind: 'Type', label: 'Package Upload', definition: 'A descriptor recording a SCORM / cmi5 package upload.' },

  // ── Performance architecture ───────────────────────────────────────
  { name: 'PerformanceSituation', kind: 'Type', label: 'Performance Situation', definition: 'A typed, modal-statused descriptor of a performer (human or agent), the work, and observed performance. The unit the system reasons from — it carries no idealised future state; content is never assumed.' },
  { name: 'Diagnosis', kind: 'Type', label: 'Diagnosis', definition: 'A contextualization of a performance situation: it reads the work regime and applies that regime’s method — apply an established practice (Evident), a cause-factor gap analysis (Knowable), a dispositional read (Emergent), or stabilise first (Turbulent).' },
  { name: 'InterventionPlan', kind: 'Type', label: 'Intervention Plan', definition: 'The full paradigm of interventions for a contextualized situation — instruction, performance-support, reference, practice, assessment, coaching, probe, environmental-fix, no-intervention — each marked selected or ruled-out with its reasoning.' },
  { name: 'InterventionEvaluation', kind: 'Type', label: 'Intervention Evaluation', definition: 'The Knowable regime’s closing move: a four-level evaluation — response, capability, transfer, outcome — as a modal-status progression; a closed gap supersedes the prior observed-state (cg:supersedes).' },
  { name: 'OutcomeRecord', kind: 'Type', label: 'Outcome Record', definition: 'One distilled intervention outcome — in a regime, having named a cause and chosen an intervention, the verdict reached; and, if it missed, the cause re-contextualization found instead. The evidence atom of calibration.' },
  { name: 'CalibrationProfile', kind: 'Type', label: 'Calibration Profile', definition: 'The system’s recorded track record of its own Knowable-regime recommendations: per (regime × cause × intervention) cell, how often that recommendation actually closed the gap. A cell is Hypothetical until it has the samples to Assert a rate; profiles compose across organizations by union.' },
  { name: 'CapabilityTransfer', kind: 'Type', label: 'Capability Transfer', definition: 'The performance reading of one agent teaching another. The unit taught is an ac:TeachingPackage (agent-collective); Foxxi frames a learner agent’s acquisition of it as an A2A instruction intervention, verifies the transfer by reading the learner’s own trajectories before and after, and emits an amta:Attestation that feeds ac:’s modal discipline and the reflexive calibration loop. Foxxi composes the teaching foundation; it does not redefine it.' },
  { name: 'GroundingFragment', kind: 'Type', label: 'Grounding Fragment', definition: 'A content-addressed atomic content unit (a PGSL atom) — the leaf of an emergent course; carries modality, cognitive level, provenance and disposition-suitability.' },
  { name: 'Lesson', kind: 'Type', label: 'Lesson', definition: 'A syntagm of grounding fragments toward one competency-point; each position holds a paradigm of interchangeable alternatives.' },
  { name: 'Module', kind: 'Type', label: 'Module', definition: 'A syntagm of lessons.' },
  { name: 'Course', kind: 'Type', label: 'Course', definition: 'A syntagm of modules. Not a stored artifact — a composition recipe that personalises (restriction + override) into a different resolved course per performer.' },
  { name: 'Curriculum', kind: 'Type', label: 'Curriculum', definition: 'A syntagm of courses toward a set of target competencies.' },
  { name: 'InFlowPerformanceSupport', kind: 'Type', label: 'In-Flow Performance Support', definition: 'A job-aid fragment delivered by an affordance attached to the work context — surfaced when a performer enters the triggering task, not on a training schedule.' },
  { name: 'DeliveredContent', kind: 'Type', label: 'Delivered Content', definition: 'A descriptor wrapping a unit of generated content delivered through a channel and published to the pod — so the delivery is itself a discoverable, federatable Context Descriptor, not a fire-and-forget send.' },

  // ── Knowledge architecture ─────────────────────────────────────────
  { name: 'WorkRegime', kind: 'Type', label: 'Work Regime', definition: 'How knowable the relationship between act and outcome is for a piece of work — Evident, Knowable, Emergent, or Turbulent. The regime decides which consulting and knowledge method is valid.' },
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
  { name: 'observedBy', kind: 'Extension', label: 'observedBy', definition: 'DID of the observer/evaluator who attested a performance record (provenance).' },
  { name: 'costUsd', kind: 'Extension', label: 'costUsd', definition: 'Cost of a performance execution in USD — agent performance economics.' },
  { name: 'contextKind', kind: 'Extension', label: 'contextKind', definition: 'Whether a statement records `production` work, `training`, or `performance-support`.' },
  { name: 'deliveryChannel', kind: 'Extension', label: 'deliveryChannel', definition: 'The channel a generated text artifact was delivered through — document, email, chat, or sms.' },
  { name: 'recipient', kind: 'Extension', label: 'recipient', definition: 'The recipient address/handle a generated artifact was delivered to.' },
  { name: 'deliveredBody', kind: 'Extension', label: 'deliveredBody', definition: 'Base64-encoded body text of a delivered-content artifact published to the pod.' },
  { name: 'deliveredVia', kind: 'Extension', label: 'deliveredVia', definition: 'How a delivery left the bridge — a pod-descriptor publish, a channel webhook, or none (recorded only).' },
  { name: 'contentForm', kind: 'Extension', label: 'contentForm', definition: 'The text form a unit of content was rendered in — plain, markdown, html, or interactive (dynamic hypermedia).' },
  { name: 'actorKind', kind: 'Extension', label: 'actorKind', definition: 'Whether the actor is a `human` or an `agent`.' },
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

// ── Rendering — JSON-LD + Turtle ────────────────────────────────────

const JSONLD_CONTEXT = {
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  foxxi: FOXXI_NS,
  label: 'rdfs:label',
  comment: 'rdfs:comment',
  isDefinedBy: { '@id': 'rdfs:isDefinedBy', '@type': '@id' },
};

/** The whole vocabulary as a JSON-LD document. */
export function renderVocabJsonLd(): Record<string, unknown> {
  return {
    '@context': JSONLD_CONTEXT,
    '@id': FOXXI_VOCAB_DOC,
    '@type': 'foxxi:Vocabulary',
    label: 'Foxxi Content Intelligence — vocabulary',
    comment: 'The consolidated, dereferenceable vocabulary for the Foxxi Content Intelligence vertical: xAPI verbs + activity types, descriptor types, and context extensions. Every term IRI resolves here.',
    termCount: FOXXI_TERMS.length,
    terms: FOXXI_TERMS.map(t => ({
      '@id': `${FOXXI_NS}${t.name}`,
      '@type': `foxxi:${t.kind}`,
      label: t.label,
      comment: t.definition,
      isDefinedBy: FOXXI_VOCAB_DOC,
      _links: { self: { href: `${FOXXI_VOCAB_DOC}/term/${t.name}` } },
    })),
    _links: {
      self: { href: FOXXI_VOCAB_DOC },
      xapiProfile: { href: FOXXI_VOCAB_DOC.replace('/ns/foxxi', '/xapi/profile') },
    },
  };
}

/** The whole vocabulary as Turtle. */
export function renderVocabTurtle(): string {
  const head = `@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix foxxi: <${FOXXI_NS}> .

<${FOXXI_VOCAB_DOC}> a foxxi:Vocabulary ;
    rdfs:label "Foxxi Content Intelligence — vocabulary" ;
    rdfs:comment "Consolidated dereferenceable vocabulary for the Foxxi vertical." .
`;
  const body = FOXXI_TERMS.map(t =>
    `foxxi:${t.name} a foxxi:${t.kind} ;
    rdfs:label "${esc(t.label)}" ;
    rdfs:comment "${esc(t.definition)}" ;
    rdfs:isDefinedBy <${FOXXI_VOCAB_DOC}> .`,
  ).join('\n\n');
  return `${head}\n${body}\n`;
}

/** A single term as a JSON-LD resource, with HATEOAS `_links`. */
export function renderTermJsonLd(name: string): Record<string, unknown> {
  const t = lookupTerm(name);
  const id = `${FOXXI_NS}${name}`;
  if (!t) {
    // Unknown fragment — still acknowledged: the bridge owns this
    // namespace, so a foxxi-namespaced IRI never 404s; it resolves to a
    // minimal record pointing back at the vocabulary.
    return {
      '@context': JSONLD_CONTEXT,
      '@id': id,
      '@type': 'foxxi:Term',
      label: name,
      comment: 'A term in the Foxxi vocabulary. No expanded definition is on record — see the vocabulary index.',
      isDefinedBy: FOXXI_VOCAB_DOC,
      _links: { self: { href: `${FOXXI_VOCAB_DOC}/term/${name}` }, vocabulary: { href: FOXXI_VOCAB_DOC } },
    };
  }
  return {
    '@context': JSONLD_CONTEXT,
    '@id': id,
    '@type': `foxxi:${t.kind}`,
    label: t.label,
    comment: t.definition,
    isDefinedBy: FOXXI_VOCAB_DOC,
    _links: { self: { href: `${FOXXI_VOCAB_DOC}/term/${name}` }, vocabulary: { href: FOXXI_VOCAB_DOC } },
  };
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
