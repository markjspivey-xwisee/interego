/**
 * Foxxi Knowledge Architecture — knowledge management, regime-routed.
 *
 * The Performance Architecture (performance-architecture.ts) decides
 * WHICH intervention a gap needs. This module addresses the question
 * underneath an instruction or reference intervention: of the knowledge
 * a competent performer actually draws on, how much can honestly become
 * content at all — and what must instead be enabled as a flow?
 *
 * It rests on three first principles this project synthesises about how
 * knowledge behaves. They are informed by established knowledge-
 * management practice, but are stated and applied here as our own (see
 * SOURCES-AND-ATTRIBUTION.md):
 *
 *   1. Knowledge is VOLUNTEERED. It is given by a willing contributor in
 *      a context of trust; it cannot be extracted on demand. Every
 *      knowledge asset records who volunteered it.
 *   2. Knowledge is TRIGGERED. It surfaces when a real decision needs
 *      it, not in the abstract. Just-in-time beats just-in-case; in-the-
 *      flow support is privileged over pre-loaded courses.
 *   3. Knowledge is LOSSY under codification. What can be written down
 *      is less than what can be said, which is less than what is known.
 *      Every codified artefact is marked with its uncodified residue.
 *
 * And one structural move: the knowledge strategy is chosen by the WORK
 * REGIME (see agent-disposition.ts). Codification — knowledge as a
 * captured stock — is honest only where the work is Evident or Knowable.
 * Where the work is Emergent, knowledge cannot be codified toward an
 * ideal state; it is enabled as a flow — connection, narrative, and
 * just-in-time emergence.
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology
 * change. Domain terms are `foxxi:`-namespaced.
 */

import type { WorkRegime } from './agent-disposition.js';
import type { Performer, InterventionPlan } from './performance-architecture.js';

// ── The three knowledge principles ──────────────────────────────────

export interface KnowledgePrinciple {
  id: string;
  /** The principle, in this project's own words. */
  principle: string;
  /** What it forces the system to do. */
  implication: string;
}

export const KNOWLEDGE_PRINCIPLES: readonly KnowledgePrinciple[] = [
  {
    id: 'volunteered',
    principle: 'Knowledge is volunteered, not extracted — it is given by a willing contributor in a context of trust, never taken on demand.',
    implication: 'Every knowledge asset records who volunteered it (a Provenance facet). The system cannot manufacture knowledge it cannot attribute to a willing source.',
  },
  {
    id: 'triggered',
    principle: 'Knowledge is triggered — it surfaces when a real decision needs it, not on demand in the abstract.',
    implication: 'Just-in-time beats just-in-case. In-the-flow performance support, surfaced by a work-context trigger, is privileged over pre-loaded courses.',
  },
  {
    id: 'lossy',
    principle: 'Knowledge is lossy under codification — what can be written down is less than what can be said, which is less than what is known.',
    implication: 'Every codified artefact is marked with a codification level and an explicit uncodified residue. The system never treats a document as the whole of the knowledge.',
  },
];

// ── Competence decomposition ────────────────────────────────────────

/**
 * The knowledge components of a competency, by where the knowledge lives.
 * The component decides whether the knowledge can become content at all:
 * recorded and trained knowledge can; lived and innate knowledge cannot,
 * and pretending otherwise produces a course that teaches what cannot be
 * taught.
 */
export type KnowledgeComponent = 'recorded' | 'trained' | 'judged' | 'lived' | 'innate';

/** How fully a component can become transferable content. */
export type Codifiability = 'fully' | 'partial' | 'no';
/** The honest route by which a component is transferred. */
export type TransferRoute = 'reference' | 'instruction' | 'narrative' | 'apprenticeship' | 'connection' | 'selection';

interface ComponentProfile {
  codifiable: Codifiability;
  transferRoute: TransferRoute;
  primaryMode: 'stock' | 'flow';
  note: string;
}

/**
 * The inherent codifiability of each knowledge component. This is the
 * heart of the honesty: recorded and trained knowledge become content;
 * lived and innate knowledge do not.
 */
const COMPONENT_PROFILE: Record<KnowledgeComponent, ComponentProfile> = {
  recorded: {
    codifiable: 'fully', transferRoute: 'reference', primaryMode: 'stock',
    note: 'Knowledge already living in a document, tool or system — fully codifiable; transfer it directly as a grounding fragment or a reference.',
  },
  trained: {
    codifiable: 'partial', transferRoute: 'instruction', primaryMode: 'stock',
    note: 'Knowledge held as trainable skill — partially codifiable; instruction plus deliberate practice develops it.',
  },
  judged: {
    codifiable: 'partial', transferRoute: 'narrative', primaryMode: 'flow',
    note: 'Knowledge held as rules of thumb and pattern-cued judgment — best transferred through narrative and worked examples, not abstract statement; a job aid can carry the cue.',
  },
  lived: {
    codifiable: 'no', transferRoute: 'apprenticeship', primaryMode: 'flow',
    note: 'Knowledge held as accumulated experience — not codifiable; transferred only by exposure over time (apprenticeship, connection).',
  },
  innate: {
    codifiable: 'no', transferRoute: 'selection', primaryMode: 'flow',
    note: 'Innate aptitude — not developable and not transferable; this is a selection / job-design matter, not knowledge management.',
  },
};

export interface ComponentInput {
  component: KnowledgeComponent;
  description: string;
}

export interface ComponentReading extends ComponentInput {
  codifiable: Codifiability;
  transferRoute: TransferRoute;
  primaryMode: 'stock' | 'flow';
  note: string;
}

export interface CompetenceDecomposition {
  competency: string;
  performer?: Performer;
  components: ComponentReading[];
  /** 0..1 — the share of the competency that can honestly become content. */
  codifiableShare: number;
  /** The honest residue — knowledge content cannot carry. */
  uncodifiedResidue: string[];
  recommendation: string;
}

const CODIFIABILITY_WEIGHT: Record<Codifiability, number> = { fully: 1, partial: 0.5, no: 0 };

/**
 * Decompose a competency into its knowledge components and compute how
 * much of it can honestly be codified into content.
 */
export function decomposeCompetence(input: {
  competency: string;
  components: readonly ComponentInput[];
  performer?: Performer;
}): CompetenceDecomposition {
  const components: ComponentReading[] = input.components.map(c => {
    const p = COMPONENT_PROFILE[c.component];
    return { ...c, codifiable: p.codifiable, transferRoute: p.transferRoute, primaryMode: p.primaryMode, note: p.note };
  });
  const codifiableShare = components.length === 0 ? 0
    : Math.round((components.reduce((s, c) => s + CODIFIABILITY_WEIGHT[c.codifiable], 0) / components.length) * 100) / 100;
  const uncodifiedResidue = components
    .filter(c => c.codifiable !== 'fully')
    .map(c => `${c.component}: ${c.description} — ${c.note}`);
  const pct = Math.round(codifiableShare * 100);
  const recommendation = pct >= 80
    ? `${pct}% of this competency is codifiable — instruction / reference content can carry most of it.`
    : pct >= 40
      ? `Only ${pct}% of this competency is codifiable. Author content for the recorded/trained components; route the judged/lived residue to narrative, apprenticeship and connection — do not pretend a course covers it.`
      : `${pct}% codifiable — this competency is mostly judgement and lived experience. A course would teach the wrong thing; favour apprenticeship, connection and in-the-flow support.`;
  return {
    competency: input.competency,
    ...(input.performer ? { performer: input.performer } : {}),
    components,
    codifiableShare,
    uncodifiedResidue,
    recommendation,
  };
}

// ── Regime-routed knowledge strategy ────────────────────────────────

export type KnowledgeStrategy = 'codify' | 'codify-and-connect' | 'connect-and-flow' | 'stabilise';

export interface KnowledgeStrategyRead {
  regime: WorkRegime;
  strategy: KnowledgeStrategy;
  /** Whether the dominant form is knowledge-as-stock or knowledge-as-flow. */
  primaryMode: 'stock' | 'flow';
  rationale: string;
}

/**
 * Choose a knowledge strategy from the work regime. Codification —
 * knowledge as a captured stock — is honest only in the Evident and
 * Knowable regimes. In the Emergent regime knowledge is a flow:
 * connection, narrative, just-in-time emergence.
 */
export function knowledgeStrategy(regime: WorkRegime): KnowledgeStrategyRead {
  switch (regime) {
    case 'Evident':
      return { regime, strategy: 'codify', primaryMode: 'stock',
        rationale: 'Evident work has a single right answer — codify it as established practice (SOP, reference, job aid). Knowledge is a stock.' };
    case 'Knowable':
      return { regime, strategy: 'codify-and-connect', primaryMode: 'stock',
        rationale: 'Knowable work has good practice an expert holds — codify what the decomposition finds codifiable, and connect learners to the experts for the rest.' };
    case 'Emergent':
      return { regime, strategy: 'connect-and-flow', primaryMode: 'flow',
        rationale: 'Emergent work has no knowable ideal — knowledge cannot be codified toward it. Enable a flow: connect people and agents, capture narrative, surface knowledge just-in-time. A captured "best practice" here is actively misleading.' };
    case 'Turbulent':
      return { regime, strategy: 'stabilise', primaryMode: 'flow',
        rationale: 'Turbulent work has no pattern to know yet. There is no knowledge to manage until a decisive act stabilises the situation.' };
  }
}

// ── Knowledge assets — stock and flow ───────────────────────────────

export type KnowledgeAssetKind = 'codified-artefact' | 'narrative' | 'connection';
/** The codification gradient — what is known > what is said > what is written. */
export type CodificationLevel = 'uncodified' | 'narrated' | 'documented' | 'codified';

export interface KnowledgeAsset {
  id: string;
  kind: KnowledgeAssetKind;
  competency: string;
  codificationLevel: CodificationLevel;
  /** Codified → the content; narrative → the story / trajectory ref;
   *  connection → the holder (a performer who carries the knowledge). */
  payload: string;
  /** Principle 1 — knowledge is volunteered; the willing source. */
  volunteeredBy: string;
  /** Principle 3 — the honest residue codification could not carry. */
  uncodifiedResidue?: string;
  provenance: string;
}

let _kaCounter = 0;
function kaId(kind: string): string { return `urn:foxxi:knowledge:${kind}:${Date.now()}-${_kaCounter++}`; }

/**
 * Codify knowledge as a stored artefact. Principle 3 is enforced: an
 * `uncodifiedResidue` is required — the honest statement of what the
 * written form leaves out.
 */
export function codifyKnowledge(input: {
  competency: string; body: string; volunteeredBy: string; uncodifiedResidue: string;
}): KnowledgeAsset {
  return {
    id: kaId('artefact'),
    kind: 'codified-artefact',
    competency: input.competency,
    codificationLevel: 'codified',
    payload: input.body,
    volunteeredBy: input.volunteeredBy,
    uncodifiedResidue: input.uncodifiedResidue,
    provenance: `codified from knowledge volunteered by ${input.volunteeredBy}`,
  };
}

/** Capture knowledge as a connection — a pointer to the performer (human
 *  or agent) who holds it. Knowledge as flow, not stock. */
export function connectKnowledge(input: {
  competency: string; holder: Performer; volunteeredBy?: string;
}): KnowledgeAsset {
  return {
    id: kaId('connection'),
    kind: 'connection',
    competency: input.competency,
    codificationLevel: 'uncodified',
    payload: `held by ${input.holder.kind} ${input.holder.id}${input.holder.role ? ` (${input.holder.role})` : ''}`,
    volunteeredBy: input.volunteeredBy ?? input.holder.id,
    provenance: 'a connection to a knowledge holder — navigable via the affordance / federation graph; the knowledge stays with the holder.',
  };
}

/** Capture knowledge as narrative — a story or anecdote (an agent
 *  trajectory and an LRS statement are both micro-narratives). */
export function narrateKnowledge(input: {
  competency: string; story: string; volunteeredBy: string;
}): KnowledgeAsset {
  return {
    id: kaId('narrative'),
    kind: 'narrative',
    competency: input.competency,
    codificationLevel: 'narrated',
    payload: input.story,
    volunteeredBy: input.volunteeredBy,
    provenance: `narrative volunteered by ${input.volunteeredBy} — knowledge in the form it is actually held and shared`,
  };
}

// ── The knowledge map — the headline composition ────────────────────

export interface KnowledgeMap {
  competency: string;
  regime: WorkRegime;
  strategy: KnowledgeStrategyRead;
  decomposition: CompetenceDecomposition;
  /** Components to codify into content — composes with emergent-content. */
  toCodify: string[];
  /** Components to enable as flow — connection, narrative, apprenticeship. */
  toConnect: string[];
  /** The knowledge principles, with how each was honoured for this competency. */
  principlesApplied: Array<{ principle: string; appliedAs: string }>;
  note: string;
}

/**
 * Map the knowledge of a competency: choose a regime-routed strategy,
 * decompose the competency into knowledge components, and split it into
 * what to codify (content) and what to enable as a flow (connection /
 * narrative / apprenticeship). In the Emergent regime nothing is
 * codified toward an ideal — the whole competency routes to flow.
 */
export function mapKnowledge(input: {
  competency: string;
  regime: WorkRegime;
  components: readonly ComponentInput[];
  performer?: Performer;
}): KnowledgeMap {
  const strategy = knowledgeStrategy(input.regime);
  const decomposition = decomposeCompetence({
    competency: input.competency,
    components: input.components,
    ...(input.performer ? { performer: input.performer } : {}),
  });

  const codifyComponents = strategy.strategy === 'connect-and-flow' || strategy.strategy === 'stabilise'
    ? [] // Emergent / Turbulent — do not codify toward an ideal state.
    : decomposition.components.filter(c => c.codifiable !== 'no');
  const connectComponents = decomposition.components.filter(c => !codifyComponents.includes(c));

  const toCodify = codifyComponents.map(c => `${c.component}: ${c.description} → ${c.transferRoute}`);
  const toConnect = connectComponents.map(c => `${c.component}: ${c.description} → ${c.transferRoute}`);

  const principlesApplied = [
    { principle: KNOWLEDGE_PRINCIPLES[0]!.principle, appliedAs: 'every asset below carries who volunteered it; nothing is asserted without a willing source.' },
    { principle: KNOWLEDGE_PRINCIPLES[1]!.principle, appliedAs: strategy.primaryMode === 'flow'
      ? 'flow-primary: knowledge is surfaced just-in-time at the work-context trigger, not pre-loaded.'
      : 'codified content is still paired with in-the-flow job aids so the knowledge meets the trigger.' },
    { principle: KNOWLEDGE_PRINCIPLES[2]!.principle, appliedAs: `codification is honest: ${decomposition.uncodifiedResidue.length} component(s) are flagged as residue content cannot carry.` },
  ];

  const note = strategy.strategy === 'connect-and-flow'
    ? `Emergent regime: knowledge is a flow. None of this competency is codified toward an ideal — all ${decomposition.components.length} component(s) route to connection / narrative / apprenticeship.`
    : `${toCodify.length} component(s) become content; ${toConnect.length} route to flow (connection / narrative / apprenticeship). ${decomposition.recommendation}`;

  return { competency: input.competency, regime: input.regime, strategy, decomposition, toCodify, toConnect, principlesApplied, note };
}

// ── Composition with the Performance Architecture ───────────────────

export interface KnowledgeAwareScaffold {
  competency: string;
  instructionWarranted: boolean;
  /** What an honest course should actually author — only the codifiable part. */
  authorAsContent: string[];
  /** What a course must NOT pretend to teach — the uncodified residue. */
  routeToConnectionOrCoaching: string[];
  /** True when the diagnosis warranted instruction but the decomposition
   *  shows the competency is mostly uncodifiable — a warning the course
   *  will under-deliver. */
  codificationWarning: boolean;
  note: string;
}

/**
 * Refine an InterventionPlan with a KnowledgeMap. The diagnosis may have
 * warranted instruction; the decomposition then says how much of the
 * competency a course can honestly carry. The residue is routed to
 * connection / coaching — which the InterventionPlan already offers as
 * cells.
 */
export function knowledgeAwareScaffold(plan: InterventionPlan, km: KnowledgeMap): KnowledgeAwareScaffold {
  const instructionWarranted = plan.selected.some(o => o.type === 'instruction' || o.type === 'reference');
  const codificationWarning = instructionWarranted && km.decomposition.codifiableShare < 0.5;
  return {
    competency: km.competency,
    instructionWarranted,
    authorAsContent: km.toCodify,
    routeToConnectionOrCoaching: km.toConnect,
    codificationWarning,
    note: codificationWarning
      ? `WARNING: instruction was warranted, but the decomposition finds only ${Math.round(km.decomposition.codifiableShare * 100)}% of "${km.competency}" is codifiable. A course will under-deliver — pair it with apprenticeship / coaching for the lived and judgement components, or the gap will not close.`
      : instructionWarranted
        ? `The course should author only the ${km.toCodify.length} codifiable component(s); the ${km.toConnect.length} residual component(s) are routed to connection / coaching — honest content, honest about its limits.`
        : 'Instruction was not warranted; the knowledge map routes this competency entirely to flow (connection / narrative / in-the-flow support).',
  };
}
