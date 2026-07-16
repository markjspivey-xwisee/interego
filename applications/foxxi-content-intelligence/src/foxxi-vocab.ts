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

/** The one Foxxi namespace base. Every foxxi term is `${FOXXI_NS}<name>`. */
export const FOXXI_NS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
/** The standards spec ontologies this vertical composes (dereferenceable at /ns/<module>).
 *  The foxxi vocabulary rdfs:seeAlso's them so the vertical declares the standards it
 *  emerges from — the emitted xAPI statements, SCORM manifests, and cmi5 sessions are
 *  instances of these composed ontologies. */
export const COMPOSED_SPEC_ONTOLOGIES = ['xapi', 'scorm-cam', 'scorm-sn', 'scorm-rte', 'cmi5']
  .map(m => FOXXI_NS.replace('foxxi#', m));
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
  // Generic fallback activity type — names the ENVELOPE act (a context-descriptor
  // assertion) when the descriptor declares no conformsTo/facet type. The object
  // type of a projected statement is normally the descriptor's OWN conformsTo IRI
  // (e.g. ttt:Move, code:PullRequest, med:Diagnosis) passed through verbatim;
  // Foxxi never enumerates an application's types.
  { name: 'AssertedContext', kind: 'ActivityType', label: 'Asserted Context', definition: 'A context-descriptor assertion whose payload type the publisher did not declare — the domain-agnostic fallback object type for a projected performance statement.' },
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
  { name: 'InterventionEvaluation', kind: 'Type', label: 'Intervention Evaluation', definition: 'The Knowable regime’s closing move: a four-level evaluation — response, capability, transfer, outcome — as a modal-status progression; a closed gap supersedes the prior observed-state (iep:supersedes).' },
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
  // Envelope-derived signals carried verbatim from the context-descriptor (never reinterpreted).
  { name: 'supersededDescriptor', kind: 'Extension', label: 'supersededDescriptor', definition: 'IRI of a prior descriptor this one revises/closes — the iep:supersedes link carried into xAPI as a structural revision signal (not a domain closure verb).' },
  { name: 'trustLevel', kind: 'Extension', label: 'trustLevel', definition: 'The descriptor\'s TrustFacet level (SelfAsserted / ThirdPartyAttested / CryptographicallyVerified), passed through verbatim.' },
  { name: 'epistemicConfidence', kind: 'Extension', label: 'epistemicConfidence', definition: 'The descriptor\'s SemioticFacet epistemic confidence [0.0–1.0] — confidence that the DESCRIPTOR itself is accurate (infrastructure-level), NOT a performance score. Carried as its own extension, never as result.score.scaled.' },
  { name: 'groundTruth', kind: 'Extension', label: 'groundTruth', definition: 'The descriptor\'s tri-state groundTruth (true for Asserted, false for Counterfactual, undefined for Hypothetical), passed through verbatim.' },
  { name: 'endorsed', kind: 'Extension', label: 'endorsed', definition: 'False when the descriptor is Quoted (recorded with no endorsement / source-attributed).' },
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
    'rdfs:seeAlso': COMPOSED_SPEC_ONTOLOGIES.map(o => ({ '@id': o })),
    _links: {
      self: { href: FOXXI_VOCAB_DOC },
      xapiProfile: { href: FOXXI_VOCAB_DOC.replace('/ns/foxxi', '/xapi/profile') },
      composesSpecOntologies: COMPOSED_SPEC_ONTOLOGIES.map(o => ({ href: o })),
    },
  };
}

/**
 * The vocabulary as TRIPLES, grouped by subject — the same graph renderVocabTurtle
 * prints, but as data the lattice can actually compose.
 *
 * Identifiers are ABSOLUTE URLS, never CURIEs: `rdfs:label` is a Turtle
 * serialization artifact, and atomizing it would atomize the serialization rather
 * than the thing it abbreviates.
 *
 * Grouped by subject (graph -> subject -> triple) so each ingest stays narrow —
 * PGSL's ingest is ~O(n^2) in sequence length, so composing one holon from every
 * triple at once is quadratic, not "more holonic".
 */
export function vocabTriplesBySubject(): Array<Array<readonly [string, string, string]>> {
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const DOC = FOXXI_VOCAB_DOC;
  const groups: Array<Array<readonly [string, string, string]>> = [];
  groups.push([
    [DOC, RDF + 'type', `${FOXXI_NS}Vocabulary`],
    [DOC, RDFS + 'label', 'Foxxi Content Intelligence — vocabulary'],
    [DOC, RDFS + 'comment', 'Consolidated dereferenceable vocabulary for the Foxxi vertical. Composes the standards spec ontologies it emerges from (see rdfs:seeAlso).'],
    ...COMPOSED_SPEC_ONTOLOGIES.map(o => [DOC, RDFS + 'seeAlso', o] as const),
    [DOC, RDFS + 'isDefinedBy', DOC],
  ]);
  for (const t of FOXXI_TERMS) {
    const s = `${FOXXI_NS}${t.name}`;
    groups.push([
      [s, RDF + 'type', `${FOXXI_NS}${t.kind}`],
      [s, RDFS + 'label', t.label],
      [s, RDFS + 'comment', t.definition],
      [s, RDFS + 'isDefinedBy', DOC],
    ]);
  }
  return groups;
}

/** The whole vocabulary as Turtle. */
export function renderVocabTurtle(): string {
  const head = `@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix foxxi: <${FOXXI_NS}> .

<${FOXXI_VOCAB_DOC}> a foxxi:Vocabulary ;
    rdfs:label "Foxxi Content Intelligence — vocabulary" ;
    rdfs:comment "Consolidated dereferenceable vocabulary for the Foxxi vertical. Composes the standards spec ontologies it emerges from (see rdfs:seeAlso)." ;
${COMPOSED_SPEC_ONTOLOGIES.map(o => `    rdfs:seeAlso <${o}> ;`).join('\n')}
    rdfs:isDefinedBy <${FOXXI_VOCAB_DOC}> .
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
